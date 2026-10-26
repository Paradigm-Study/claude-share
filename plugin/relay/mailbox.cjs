#!/usr/bin/env node
// The host's mailboxes for messages between a teammate's own sessions and
// this session. Each is a real Unix socket, listening, in the directory of
// this session's own messaging socket, so Claude Code dials it as it would
// any session's, and stands for one of a teammate's sessions (the seat and
// handle the room brought its message with). What the room brings from that
// session goes into this session's own socket as a native peer message from
// the mailbox, with the hop chain and message id that session gave it; what
// this session's Claude writes back to the mailbox goes to that seat (POST
// peer). Receipts go both ways: this session's for what was delivered into
// it, to the seat; the seat's for what went from here, into this session.
//
// The plugin runs this as a launcher, which starts the helper itself
// detached (`--serve`: a session of its own), passes its ready line on and
// exits, so the helper is no descendant of Claude Code: a session in bypass
// mode takes a descendant's message as its own and skips the permission-mode
// check that holds another session's. It ends, every mailbox with it, on
// SIGHUP, SIGTERM or SIGINT, once this session's Claude Code is gone, or when
// told. Node 20+, macOS and Linux.
//
// Claude Code's messaging is undocumented: one JSON line a frame (`msgV` 1, a
// user message whose content is the `<cross-session-message>` envelope); a
// socket outside Windows takes one with no auth line, and none is sent. A
// receipt is a control line (receipt.cjs). The room's address and bearer
// arrive once on stdin; commands come in short POSTs to a loopback listener
// with its own bearer (`controlServer`). Stdout carries short status lines
// only, never a body, an address or a token.
'use strict'

const net = require('net')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { randomUUID } = require('crypto')
const { controlServer, notify, failure, readConfig, roomSettings, roomPost } = require('./tcp-relay.mts')
const { receiptLine, writeLine, STATUS, DROPS, UUID } = require('./receipt.cjs')

const LIMITS = Object.freeze({
  // Its commands: a deliver carries a message of 32,000 characters, escaped.
  boxes: 64, sockets: 8, body: 262_144, headers: 8192, timeoutMs: 2000,
  // What one connection to a mailbox may write, how many at once, and for how long.
  frame: 262_144, inbound: 16, inboundMs: 10_000,
  // Messages on their way to the room at once; the words and hop chain each carries.
  posts: 16, text: 32_000, chain: 32, name: 80,
  // A Unix socket's path, in bytes (macOS's sun_path is 104 with its NUL).
  path: 103,
  // A mailbox nobody listens on, left by a helper that was killed, is swept this old.
  staleMs: 60_000,
  // How often this session's Claude Code is looked for; how long a POST may
  // take; how long an open waits for a mailbox another helper still holds.
  parentMs: 2000, postMs: 15_000, takeoverMs: 1200,
  // How long the launcher waits for the helper, and the helper for the launcher to be gone.
  startMs: 5000, detachMs: 2000,
  // The messages whose `held` went into this session, so a `delivered` follows one.
  held: 256,
})
const ID = /^[0-9a-f]{32}$/
const SEAT = /^[A-Za-z0-9_-]{1,64}$/
const MODE = /^[a-z-]{1,32}$/
const HOP = /^[0-9a-f]{24}$/
const BOX_FILE = /^ss-([0-9a-f]{32})\.sock$/
// The envelope as the engine writes and reads it back: one open tag, the body
// on the lines between, the closing tag last.
const ENVELOPE = /^<cross-session-message ([^>\n]*)>\n([\s\S]*)\n<\/cross-session-message>$/
const CLOSING = '</cross-session-message>'
const CONFIG_KEYS = 'controlToken,dir,own,room,token,version'

function configOf(raw, served = false) {
  const cfg = roomSettings(raw, served ? CONFIG_KEYS.replace('own,', 'own,pid,') : CONFIG_KEYS)
  // This session's own socket, and the directory its mailboxes go in: the
  // same one, where Claude Code sends its receipts.
  if (typeof cfg.own !== 'string' || !path.isAbsolute(cfg.own) || Buffer.byteLength(cfg.own) > LIMITS.path || /[\0\n"<>]/.test(cfg.own)) throw failure('INVALID_CONFIG')
  if (typeof cfg.dir !== 'string' || cfg.dir !== path.dirname(cfg.own)) throw failure('INVALID_CONFIG')
  // This session's Claude Code (served: the launcher's parent).
  if (served && (!Number.isSafeInteger(cfg.pid) || cfg.pid <= 1)) throw failure('INVALID_CONFIG')
  return cfg
}

function commandOf(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw failure('INVALID_CONFIG')
  const keys = Object.keys(command).sort().join(',')
  const box = typeof command.box === 'string' && ID.test(command.box)
  if (command.op === 'open' && keys === 'box,handle,op,seat' && box && typeof command.handle === 'string' && ID.test(command.handle) && typeof command.seat === 'string' && SEAT.test(command.seat)) return command
  if (command.op === 'close' && keys === 'box,op' && box) return command
  if (command.op === 'exit' && keys === 'op') return command
  if (command.op === 'deliver' && box) {
    const allowed = new Set(['op', 'box', 'name', 'mode', 'chain', 'id', 'body'])
    const { name, mode, chain, id, body } = command
    if (Object.keys(command).every(k => allowed.has(k)) && typeof name === 'string' && name && name.length <= 200 && (mode === undefined || (typeof mode === 'string' && MODE.test(mode)))
      && Array.isArray(chain) && chain.length <= LIMITS.chain && chain.every(t => typeof t === 'string' && HOP.test(t)) && (id === undefined || (typeof id === 'string' && UUID.test(id)))
      && typeof body === 'string' && body && body.length <= LIMITS.text) return command
  }
  if (command.op === 'receipt' && box && (keys === 'box,op,ref,status' || keys === 'box,op,reason,ref,status') && STATUS.has(command.status) && typeof command.ref === 'string' && UUID.test(command.ref)
    && (command.reason === undefined || (command.status === 'dropped' && DROPS.has(command.reason)))) return command
  throw failure('INVALID_CONFIG')
}

// A name as the envelope can carry it: no quotes, angle brackets, ampersands
// or line breaks (the engine reads the envelope back exactly as it wrote it),
// one line of 80 characters at most.
function attribute(value) {
  const text = String(value).replace(/["<>&\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name)
  return text || 'another session'
}

// The words as the envelope can carry them: a closing tag inside them would
// end the envelope early, so it's written with a zero-width space after its
// `<`, which reads the same.
const bodyOf = text => text.replaceAll(CLOSING, '<​/cross-session-message>')

// The native frame a peer session writes, from a mailbox, in the engine's
// attribute order (from, from-session, hop-chain, from-name, from-mode), and
// with the message id its sender gave it (a receipt this session sends names
// that), else a new one.
function frameOf(address, message) {
  const attrs = [`from="${address}"`, ...(message.chain.length ? [`hop-chain="${message.chain.join(',')}"`] : []), `from-name="${attribute(message.name)}"`, ...(message.mode ? [`from-mode="${message.mode}"`] : [])]
  const content = `<cross-session-message ${attrs.join(' ')}>\n${bodyOf(message.body)}\n${CLOSING}`
  return JSON.stringify({ msgV: 1, msg_id: typeof message.id === 'string' && UUID.test(message.id) ? message.id : randomUUID(), type: 'user', message: { role: 'user', content }, priority: 'next', from: address })
}

// What this session wrote to a mailbox, read: a message (its words, and the
// msg_id a receipt for it names), a receipt (for a message delivered from
// that mailbox), or neither, with who says it sent it.
function frameRead(line) {
  let frame
  try { frame = JSON.parse(line) } catch { return { kind: 'bad' } }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return { kind: 'bad' }
  if (frame.type === 'auth') return { kind: 'auth' }
  if (frame.type === 'control') {
    if (frame.action !== 'peer_message_status' || typeof frame.from !== 'string' || typeof frame.orig_msg_id !== 'string' || !UUID.test(frame.orig_msg_id)) return { kind: 'bad' }
    const status = frame.status === 'expired' && frame.status_detail === 'refused' ? 'refused' : frame.status
    if (!STATUS.has(status)) return { kind: 'bad' }
    const reason = status === 'dropped' && DROPS.has(frame.drop_reason) ? frame.drop_reason : undefined
    return { kind: 'receipt', from: frame.from, receipt: { status, id: frame.orig_msg_id, ...(reason ? { reason } : {}) } }
  }
  if (frame.msgV !== 1 || frame.type !== 'user' || typeof frame.from !== 'string' || typeof frame.message?.content !== 'string') return { kind: 'bad' }
  const m = ENVELOPE.exec(frame.message.content)
  if (!m) return { kind: 'bad' }
  const attrs = {}
  for (const a of m[1].matchAll(/([a-z-]+)="([^"]*)"/g)) attrs[a[1]] = a[2]
  if (attrs.from !== frame.from) return { kind: 'bad' }
  const body = m[2].slice(0, LIMITS.text)
  if (!body.trim()) return { kind: 'bad' }
  return { kind: 'message', from: frame.from, message: { body, ref: typeof frame.msg_id === 'string' && UUID.test(frame.msg_id) ? frame.msg_id : randomUUID() } }
}

// Whether a Unix socket at `file` has a listener: true, false (refused, or
// gone), undefined when it can't tell in time.
function listening(file, ms = 300) {
  return new Promise(resolve => {
    const s = net.createConnection({ path: file })
    const done = value => { clearTimeout(timer); s.destroy(); resolve(value) }
    const timer = setTimeout(() => done(undefined), ms)
    s.once('connect', () => done(true))
    s.once('error', error => done(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? false : undefined))
  })
}

const isSocket = file => { try { const st = fs.lstatSync(file); return st.isSocket() ? st : null } catch { return null } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The helper. `launcher`: the pid of the process that started it, which must
// be gone before anything is written into this session (`detached`).
async function start(raw, { emit = notify, launcher } = {}) {
  const cfg = configOf(raw, true)
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw failure('UNSUPPORTED')
  const own = `uds:${cfg.own}`
  const boxes = new Map() // id → { seat, handle, server, file, ino, conns }
  const posts = new Set()
  const held = new Set()
  let stopped = false, closing, watch

  const fileOf = box => path.join(cfg.dir, `ss-${box}.sock`)
  // Only a mailbox file this helper made, still the same file, is removed.
  const unlinkOwn = box => {
    const st = isSocket(box.file)
    if (st && st.ino === box.ino) try { fs.unlinkSync(box.file) } catch {}
  }

  // No descendant of Claude Code's writes into it: the launcher is gone first.
  async function detached() {
    for (const end = Date.now() + LIMITS.detachMs; launcher && process.ppid === launcher;) {
      if (Date.now() >= end || stopped) return false
      await sleep(25)
    }
    return !stopped
  }

  // To the seat a mailbox stands for: a message this session's Claude wrote
  // to it, or a receipt for one delivered from it. What came of it, in a word.
  async function post(box, body) {
    if (stopped) return 'stopped'
    if (posts.size >= LIMITS.posts) return 'busy'
    const controller = new AbortController()
    posts.add(controller)
    try {
      const got = await roomPost(cfg, 'peer', { to: box.seat, handle: box.handle, ...body }, controller, LIMITS.postMs)
      if (!got) return 'unreachable'
      if (got.status === 200) return got.answer?.delivered === true ? 'delivered' : 'offline'
      return got.status === 429 ? 'busy' : got.status === 413 ? 'large' : [401, 403, 404, 410].includes(got.status) ? 'gone' : 'refused'
    } finally { posts.delete(controller) }
  }

  // One post at a time a mailbox, in the order its frames came: receipts
  // sent close together (held, then refused or delivered) reach the seat as
  // they were sent. Each a fetch of its own, they could cross on the way.
  // As many as may be in flight at once wait, at most (LIMITS.posts); past
  // that, as past it at once, it's busy.
  function inTurn(box, body) {
    if (box.waiting >= LIMITS.posts) return Promise.resolve('busy')
    box.waiting++
    const turn = box.lane.then(() => post(box, body)).catch(() => 'refused').finally(() => { box.waiting-- })
    box.lane = turn
    return turn
  }

  // A receipt into this session, from a mailbox: what became of a message it
  // wrote there. A `delivered` only after a `held` (as Claude Code sends them).
  async function receiptHere(box, status, ref, reason) {
    if (status === 'delivered' && !held.has(ref)) return true
    if (status === 'held') {
      held.add(ref)
      if (held.size > LIMITS.held) held.delete(held.values().next().value)
    } else held.delete(ref)
    if (!(await detached())) return false
    return writeLine(cfg.own, receiptLine({ status, from: `uds:${box.file}`, ref, ...(reason ? { reason } : {}) }))
  }

  function inbound(id, socket) {
    const box = boxes.get(id)
    if (!box || box.conns.size >= LIMITS.inbound) return socket.destroy()
    box.conns.add(socket)
    let buffer = '', size = 0
    const timer = setTimeout(() => socket.destroy(), LIMITS.inboundMs)
    const take = line => {
      if (!line.trim()) return
      const read = frameRead(line)
      // Only from this session: a mailbox is its way to the seat, no one else's.
      if (read.kind === 'auth' || read.kind === 'bad' || read.from !== own) return
      if (read.kind === 'receipt') return void inTurn(box, read.receipt)
      // What this session wrote here: the seat's receipts may name these alone.
      box.refs.add(read.message.ref)
      if (box.refs.size > LIMITS.held) box.refs.delete(box.refs.values().next().value)
      void inTurn(box, read.message).then(result => {
        // Where it didn't go, this session hears so as it would from that session.
        if (result === 'delivered' || result === 'stopped') return
        void receiptHere(box, result === 'gone' ? 'refused' : 'dropped', read.message.ref, result === 'busy' ? 'rate-limited' : undefined)
      })
    }
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      size += Buffer.byteLength(chunk)
      if (size > LIMITS.frame) return socket.destroy()
      buffer += chunk
      let i
      while ((i = buffer.indexOf('\n')) >= 0) { take(buffer.slice(0, i)); buffer = buffer.slice(i + 1) }
    })
    socket.on('end', () => { if (buffer) take(buffer); buffer = ''; socket.end() })
    socket.on('error', () => {})
    socket.on('close', () => { clearTimeout(timer); box.conns.delete(socket) })
  }

  async function open(id, seat, handle) {
    const had = boxes.get(id)
    if (had) { had.seat = seat; had.handle = handle; return undefined }
    if (boxes.size >= LIMITS.boxes) return { status: 429, code: 'BUSY' }
    const file = fileOf(id)
    if (Buffer.byteLength(file) > LIMITS.path) return { status: 409, code: 'PROTOCOL' }
    // A mailbox left behind: taken back once nobody listens on it; one
    // another helper still holds (the one a reload is ending) is waited for.
    for (const end = Date.now() + LIMITS.takeoverMs; ;) {
      let st
      try { st = fs.lstatSync(file) } catch { break }
      if (!st.isSocket()) return { status: 409, code: 'EADDRINUSE' }
      const live = await listening(file)
      if (stopped) return { status: 503 }
      if (live === false) { if (isSocket(file)?.ino === st.ino) try { fs.unlinkSync(file) } catch {} ; break }
      if (Date.now() >= end) return { status: 409, code: 'EADDRINUSE' }
      await sleep(200)
    }
    const box = { seat, handle, server: null, file, ino: 0, conns: new Set(), refs: new Set(), lane: Promise.resolve(), waiting: 0 }
    const server = net.createServer({ allowHalfOpen: true }, socket => inbound(id, socket))
    server.on('error', () => {})
    box.server = server
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen({ path: file }, () => { server.removeListener('error', reject); resolve() })
      })
      fs.chmodSync(file, 0o600)
      box.ino = fs.lstatSync(file).ino
    } catch (error) {
      server.close()
      return { status: 409, code: error?.code === 'EADDRINUSE' ? 'EADDRINUSE' : 'STARTUP' }
    }
    if (stopped) { server.close(); unlinkOwn(box); return { status: 503 } }
    boxes.set(id, box)
    return undefined
  }

  function closeBox(id) {
    const box = boxes.get(id)
    if (!box) return
    boxes.delete(id)
    for (const s of box.conns) s.destroy()
    box.server.close()
    unlinkOwn(box)
  }

  // A teammate's session's message into this session, from its mailbox.
  async function deliver(id, c) {
    const box = boxes.get(id)
    if (!box) return { status: 404 }
    if (!(await detached())) return { status: 409, code: 'STARTUP' }
    return (await writeLine(cfg.own, frameOf(`uds:${box.file}`, c))) ? undefined : { status: 409, code: 'CONNECT' }
  }

  async function command(c) {
    if (c.op === 'open') return open(c.box, c.seat, c.handle)
    if (c.op === 'close') return closeBox(c.box)
    if (c.op === 'deliver') return deliver(c.box, c)
    if (c.op === 'receipt') {
      const box = boxes.get(c.box)
      // Only for a message this session wrote to this mailbox: the seat never
      // speaks for this session's messages to anyone else (their ids show in
      // the room's rows, in SendMessage's results).
      if (!box || !box.refs.has(c.ref)) return { status: 404 }
      return (await receiptHere(box, c.status, c.ref, c.reason)) ? undefined : { status: 409, code: 'CONNECT' }
    }
    // exit: answered first, then gone.
    setTimeout(() => void close().then(() => process.exit(0)), 20)
    return undefined
  }

  // Mailboxes left in the directory by helpers that were killed: nobody
  // listens on them and they're a minute old. Nothing else is touched.
  async function sweep() {
    let names = []
    try { names = fs.readdirSync(cfg.dir) } catch { return }
    for (const name of names) {
      if (!BOX_FILE.test(name) || stopped) continue
      const file = path.join(cfg.dir, name)
      const st = isSocket(file)
      if (!st || Date.now() - st.mtimeMs < LIMITS.staleMs) continue
      if ((await listening(file)) === false && isSocket(file)?.ino === st.ino) try { fs.unlinkSync(file) } catch {}
    }
  }

  const control = controlServer({
    token: cfg.controlToken, bodyLimit: LIMITS.body, sockets: LIMITS.sockets, timeoutMs: LIMITS.timeoutMs, headers: LIMITS.headers,
    onCommand: value => (stopped ? { status: 503 } : command(commandOf(value))),
  })
  const close = () => {
    if (closing) return closing
    stopped = true
    clearInterval(watch)
    const ending = control.close() // First: no command is taken after this.
    for (const controller of posts) controller.abort()
    for (const id of [...boxes.keys()]) closeBox(id)
    closing = ending
    return closing
  }
  // Every mailbox goes however this process ends.
  process.once('exit', () => { for (const id of [...boxes.keys()]) closeBox(id) })
  try {
    // This session's Claude Code gone (quit, crashed or killed): its
    // mailboxes go, and so does this.
    watch = setInterval(() => {
      try { process.kill(cfg.pid, 0) } catch (error) { if (error?.code === 'ESRCH') void close().then(() => process.exit(0)) }
    }, LIMITS.parentMs)
    await sweep()
    const port = await control.listen()
    if (stopped) throw failure('STARTUP')
    emit({ state: 'ready', port })
    return { close, port }
  } catch (error) { await close(); throw error }
}

// A last status line, then gone: once it's written (a pipe on macOS takes it later).
const finish = (row, code) => { try { process.stdout.write(`${JSON.stringify(row)}\n`, () => process.exit(code)) } catch { process.exit(code) } ; setTimeout(() => process.exit(code), 1000).unref() }

// Settings that aren't a config, or too long: said, and gone.
const invalid = () => finish({ state: 'error', code: 'INVALID_CONFIG' }, 1)
const codeOf = error => (['INVALID_CONFIG', 'UNSUPPORTED'].includes(error?.code) ? error.code : 'STARTUP')

// The helper itself, detached: its parent the launcher, until that's gone.
function serve() {
  const launcher = process.ppid
  process.stdout.on('error', () => {}) // The launcher reads its ready line, then it's gone.
  let running = null
  const end = code => { void Promise.resolve(running?.close()).finally(() => process.exit(code)) }
  for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(signal, () => end(0))
  process.on('uncaughtException', () => end(1))
  process.on('unhandledRejection', () => end(1))
  readConfig(cfg => {
    start(cfg, { launcher, emit: row => { try { process.stdout.write(`${JSON.stringify(row)}\n`) } catch {} } }).then(
      value => { running = value },
      error => finish({ state: 'error', code: codeOf(error) }, 1),
    )
  }, invalid)
}

// The launcher: the helper started detached, its ready line passed on (with
// its pid, which a reload ends it by), and gone.
function launch() {
  readConfig(raw => {
    let cfg
    try { cfg = configOf(raw) } catch { return finish({ state: 'error', code: 'INVALID_CONFIG' }, 1) }
    if (process.platform !== 'darwin' && process.platform !== 'linux') return finish({ state: 'error', code: 'UNSUPPORTED' }, 1)
    const child = spawn(process.execPath, [__filename, '--serve'], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let done = false
    const fail = code => { if (done) return; done = true; try { child.kill() } catch {} ; finish({ state: 'error', code }, 1) }
    const timer = setTimeout(() => fail('STARTUP'), LIMITS.startMs)
    child.on('error', () => fail('STARTUP'))
    child.on('exit', () => fail('STARTUP'))
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk
      const i = buffer.indexOf('\n')
      if (i < 0) { if (buffer.length > 4096) fail('STARTUP'); return }
      let row
      try { row = JSON.parse(buffer.slice(0, i)) } catch { return fail('STARTUP') }
      if (done) return
      clearTimeout(timer)
      if (row?.state !== 'ready' || !Number.isInteger(row.port)) return fail(['INVALID_CONFIG', 'UNSUPPORTED'].includes(row?.code) ? row.code : 'STARTUP')
      done = true
      child.removeAllListeners('exit')
      child.stdout.destroy()
      child.unref()
      finish({ state: 'ready', port: row.port, pid: child.pid }, 0)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ ...cfg, pid: process.ppid }))
  }, invalid)
}

module.exports = { start, LIMITS, frameOf, frameRead, attribute, bodyOf, configOf, commandOf }
if (require.main === module) (process.argv[2] === '--serve' ? serve : launch)()
