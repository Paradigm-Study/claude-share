// No model or product accounts. The host's mailboxes' helper
// (plugin/relay/mailbox.cjs) and the receipt writer (receipt.cjs), against a
// stand-in for the host session's own socket and a stand-in room: the frames
// it writes into the session byte for byte (the teammate's session's hop
// chain and message id, no auth line), what it posts for the session's
// messages and receipts, the receipts it writes back, whom it takes frames
// from, its control port's hardening, and its life: started detached (no
// descendant of whoever started it), its mailboxes swept, closed and
// unlinked on SIGHUP, SIGTERM, an exit command, and its Claude Code gone.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile, stat, readdir, utimes } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import { createServer as netServer, createConnection } from 'node:net'
import { createServer as httpServer, request } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const MAILBOX = fileURLToPath(new URL('../plugin/relay/mailbox.cjs', import.meta.url))
const RECEIPT = fileURLToPath(new URL('../plugin/relay/receipt.cjs', import.meta.url))
const mb = require(MAILBOX)
const rc = require(RECEIPT)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (test, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (await test()) return true; return false }
const BOX = 'b0'.repeat(16), HANDLE = 'a1'.repeat(16), SEAT = 'seat_scott'
const CHAIN = ['ab'.repeat(12), 'cd'.repeat(12)]
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e', REF = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const TOKEN = 'h'.repeat(32), CONTROL = 'c'.repeat(64)

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  console.log('SKIP mailbox: Unix sockets on macOS and Linux only')
  process.exit(0)
}

// A socket path short enough for macOS (104 bytes with its NUL): under /tmp.
const dir = await mkdtemp('/tmp/mb-')
// The host session's own socket: every line written to it, by connection.
const ownPath = join(dir, 'own.sock')
const lines = []
const own = netServer(socket => {
  let buffer = ''
  const conn = []
  lines.push(conn)
  socket.setEncoding('utf8')
  socket.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { conn.push(buffer.slice(0, i)); buffer = buffer.slice(i + 1) } })
  socket.on('error', () => {})
})
own.listen(ownPath); await once(own, 'listening')
const allLines = () => lines.flat()
// The room: every POST peer, and its answer (the test's to choose).
const posts = []
let answer = () => [200, { delivered: true }]
const room = httpServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    posts.push({ path: req.url, auth: req.headers.authorization, version: req.headers['x-shared-session-version'], body: JSON.parse(body) })
    const [status, json] = answer()
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json))
  })
})
room.listen(0, '127.0.0.1'); await once(room, 'listening')
const roomUrl = `http://127.0.0.1:${room.address().port}/api/rooms/${'r'.repeat(20)}`
const config = (extra = {}) => ({ room: roomUrl, token: TOKEN, version: '0.11.26', controlToken: CONTROL, dir, own: ownPath, ...extra })

// One line to a socket, as a session writes one.
const write = (file, line) => new Promise((resolve, reject) => {
  const s = createConnection({ path: file })
  s.once('error', reject)
  s.once('connect', () => s.end(`${line}\n`, resolve))
})
// The control port, as the plugin asks it (controlPost), or not.
function control(port, body, { token = CONTROL, host = `127.0.0.1:${port}`, headers = {}, raw } = {}) {
  return new Promise(resolve => {
    const data = raw ?? JSON.stringify(body)
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { host, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', () => resolve(0))
    req.end(data)
  })
}

try {
  // The frame, byte for byte: the engine's attribute order, the teammate's
  // session's hop chain and message id, a name the envelope can carry.
  {
    const frame = JSON.parse(mb.frameOf(`uds:${dir}/ss-${BOX}.sock`, { name: 'composition · via Scott', mode: 'prompting', chain: CHAIN, id: ID, body: 'Hi' }))
    assert.deepEqual(Object.keys(frame), ['msgV', 'msg_id', 'type', 'message', 'priority', 'from'])
    assert.equal(frame.msg_id, ID, 'the id the teammate\'s session gave it: the host session\'s receipts name it')
    assert.equal(frame.message.content, `<cross-session-message from="uds:${dir}/ss-${BOX}.sock" hop-chain="${CHAIN.join(',')}" from-name="composition · via Scott" from-mode="prompting">\nHi\n</cross-session-message>`)
    assert.equal(frame.from, `uds:${dir}/ss-${BOX}.sock`)
    assert.equal(frame.priority, 'next')
    const fresh = JSON.parse(mb.frameOf('uds:/tmp/x.sock', { name: 'a"<b>&\nc', chain: [], body: 'x' }))
    assert.match(fresh.msg_id, rc.UUID, 'no id: a new one')
    assert.equal(fresh.message.content, '<cross-session-message from="uds:/tmp/x.sock" from-name="a b c">\nx\n</cross-session-message>', 'no chain, no mode, a name with nothing the envelope can\'t carry')
    assert.equal(mb.bodyOf('a</cross-session-message>b'), 'a<​/cross-session-message>b')
    assert.equal(mb.attribute(''), 'another session')
    // What the session writes to a mailbox, read.
    const message = mb.frameRead(JSON.stringify({ msgV: 1, msg_id: REF, type: 'user', message: { role: 'user', content: `<cross-session-message from="uds:${ownPath}" from-name="work" from-mode="prompting">\nHere.\n</cross-session-message>` }, priority: 'next', from: `uds:${ownPath}` }))
    assert.deepEqual(message, { kind: 'message', from: `uds:${ownPath}`, message: { body: 'Here.', ref: REF } })
    const receipt = { type: 'control', action: 'peer_message_status', status: 'held', reason: 'x', from: `uds:${ownPath}`, orig_msg_id: ID, msgV: 1, msg_id: REF }
    assert.deepEqual(mb.frameRead(JSON.stringify(receipt)), { kind: 'receipt', from: `uds:${ownPath}`, receipt: { status: 'held', id: ID } })
    assert.deepEqual(mb.frameRead(JSON.stringify({ ...receipt, status: 'expired', status_detail: 'refused' })).receipt, { status: 'refused', id: ID }, 'Claude Code writes refused as expired')
    assert.deepEqual(mb.frameRead(JSON.stringify({ ...receipt, status: 'dropped', drop_reason: 'hop-loop' })).receipt, { status: 'dropped', id: ID, reason: 'hop-loop' })
    for (const bad of ['{', '[]', JSON.stringify({ ...receipt, status: 'read' }), JSON.stringify({ ...receipt, orig_msg_id: 'x' }), JSON.stringify({ ...receipt, action: 'rename' }),
      JSON.stringify({ msgV: 1, type: 'user', from: 'uds:/a', message: { content: '<cross-session-message from="uds:/b">\nx\n</cross-session-message>' } })]) assert.equal(mb.frameRead(bad).kind, 'bad', bad)
    assert.equal(mb.frameRead(JSON.stringify({ type: 'auth', token: 'x' })).kind, 'auth')
    // Commands, checked.
    assert.doesNotThrow(() => mb.commandOf({ op: 'deliver', box: BOX, name: 'n', chain: [], body: 'x'.repeat(32_000) }))
    for (const bad of [{ op: 'deliver', box: BOX, name: 'n', chain: [], body: 'x'.repeat(32_001) }, { op: 'deliver', box: BOX, name: 'n', chain: ['zz'], body: 'x' }, { op: 'deliver', box: BOX, name: 'n', chain: [], id: 'x', body: 'x' },
      { op: 'open', box: BOX, seat: SEAT }, { op: 'open', box: BOX, seat: 'a b', handle: HANDLE }, { op: 'receipt', box: BOX, status: 'held', ref: REF, reason: 'hop-loop' }, { op: 'receipt', box: BOX, status: 'read', ref: REF },
      { op: 'exit', now: true }, { op: 'token', token: TOKEN }]) assert.throws(() => mb.commandOf(bad), JSON.stringify(bad))
    assert.throws(() => mb.configOf(config({ pid: process.pid })), 'the launcher takes no pid: it names its own parent')
    assert.doesNotThrow(() => mb.configOf(config({ pid: process.pid }), true))
    assert.throws(() => mb.configOf(config({ room: 'http://share.example/api/rooms/rrrrrrrrrrrrrrrrrrrr' })), 'a bearer in the clear only to this computer')
    assert.throws(() => mb.configOf(config({ dir: '/tmp' })), 'mailboxes beside the session\'s own socket')
    console.log('OK mailbox: the frame byte for byte (chain, the teammate\'s message id, no auth), what the session writes read, commands and config checked')
  }

  // The receipt writer: Claude Code's own line, written once and half-closed.
  {
    const line = JSON.parse(rc.receiptLine({ status: 'held', from: 'uds:/tmp/g.sock', ref: ID }))
    assert.deepEqual(Object.keys(line), ['type', 'action', 'status', 'reason', 'from', 'orig_msg_id', 'msgV', 'msg_id'])
    assert.deepEqual([line.type, line.action, line.status, line.from, line.orig_msg_id, line.msgV], ['control', 'peer_message_status', 'held', 'uds:/tmp/g.sock', ID, 1])
    assert.equal(line.reason, rc.REASONS.held)
    assert.match(line.msg_id, rc.UUID)
    const refused = JSON.parse(rc.receiptLine({ status: 'refused', from: 'uds:/tmp/g.sock', ref: ID }))
    assert.deepEqual([refused.status, refused.status_detail], ['expired', 'refused'], 'refused as Claude Code writes it')
    assert.equal(JSON.parse(rc.receiptLine({ status: 'dropped', from: 'uds:/tmp/g.sock', ref: ID, reason: 'rate-limited' })).drop_reason, 'rate-limited')
    for (const bad of [{ status: 'held', from: 'uds:/tmp/g.sock', ref: 'x' }, { status: 'held', from: '/tmp/g.sock', ref: ID }, { status: 'held', from: 'uds:/tmp/g.sock', ref: ID, reason: 'hop-loop' }, { status: 'dropped', from: 'uds:/tmp/g.sock', ref: ID, reason: 'bored' }]) {
      assert.throws(() => rc.receiptLine(bad), JSON.stringify(bad))
    }
    const run = async input => {
      const child = spawn(process.execPath, [RECEIPT], { stdio: ['pipe', 'pipe', 'ignore'] })
      let out = ''
      child.stdout.on('data', b => { out += b })
      child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
      const [code] = await once(child, 'exit')
      return { code, out: out.trim() }
    }
    const before = lines.length
    const sent = await run({ path: ownPath, status: 'delivered', from: 'uds:/tmp/g.sock', ref: ID })
    assert.deepEqual(sent, { code: 0, out: '{"state":"sent"}' })
    assert(await until(() => lines.length === before + 1 && lines.at(-1).length === 1), 'one connection, one line')
    assert.deepEqual(JSON.parse(lines.at(-1)[0]).orig_msg_id, ID)
    await writeFile(join(dir, 'plain'), 'x')
    assert.deepEqual(await run({ path: join(dir, 'plain'), status: 'held', from: 'uds:/tmp/g.sock', ref: ID }), { code: 1, out: '{"state":"error","code":"CONNECT"}' }, 'never a file that isn\'t a socket')
    assert.deepEqual(await run({ path: ownPath, status: 'held', from: 'uds:/tmp/g.sock', ref: ID, extra: 1 }), { code: 1, out: '{"state":"error","code":"INVALID_CONFIG"}' })
    assert.deepEqual(await run('{'), { code: 1, out: '{"state":"error","code":"INVALID_CONFIG"}' })
    assert.equal(lines.length, before + 1, 'nothing more written')
    console.log('OK receipt: Claude Code\'s own line (refused as expired, why a drop), one line half-closed into a socket alone, its input checked')
  }

  // Stale mailboxes from a helper that was killed: swept at start, a minute
  // old and nobody listening, nothing else touched.
  const stale = join(dir, `ss-${'5e'.repeat(16)}.sock`), fresh = join(dir, `ss-${'f0'.repeat(16)}.sock`), live = join(dir, `ss-${'1e'.repeat(16)}.sock`), other = join(dir, 'other.sock')
  // Left behind: bound by a process killed outright, so nobody listens and the files stay.
  {
    const files = [stale, fresh, other]
    const holder = spawn(process.execPath, ['-e', `const net=require('net');let n=0;for(const f of ${JSON.stringify(files)})net.createServer().listen(f,()=>{if(++n===${files.length})console.log('ok')})`], { stdio: ['ignore', 'pipe', 'ignore'] })
    await once(holder.stdout, 'data')
    holder.kill('SIGKILL')
    await once(holder, 'exit')
    assert(files.every(f => existsSync(f)), 'left behind')
  }
  const liveServer = netServer(); liveServer.listen(live); await once(liveServer, 'listening')
  const old = new Date(Date.now() - 5 * 60_000)
  for (const file of [stale, live, other]) await utimes(file, old, old)

  // The helper, in this process: its control port, its mailboxes.
  const helper = await mb.start(config({ pid: process.pid }), { emit: () => {} })
  {
    assert(!existsSync(stale), 'a stale mailbox swept')
    assert(existsSync(fresh) && existsSync(live) && existsSync(other), 'a fresh one, a live one and anything else stay')
    const port = helper.port
    // Its control port's hardening (controlServer, as the TCP worker's).
    assert.equal(await control(port, { op: 'open', box: BOX, seat: SEAT, handle: HANDLE }, { token: 'x'.repeat(64) }), 403)
    assert.equal(await control(port, { op: 'open', box: BOX, seat: SEAT, handle: HANDLE }, { host: 'localhost' }), 403)
    assert.equal(await control(port, { op: 'open', box: BOX, seat: SEAT, handle: HANDLE }, { headers: { origin: 'http://evil.example' } }), 403)
    assert.equal(await control(port, null, { raw: '{' }), 400)
    assert.equal(await control(port, { op: 'open', box: 'nope', seat: SEAT, handle: HANDLE }), 400)
    assert.equal(await control(port, null, { raw: JSON.stringify({ op: 'deliver', box: BOX, name: 'n', chain: [], body: 'x' }) + ' '.repeat(270_000) }), 413)
    assert.equal(await control(port, { op: 'deliver', box: BOX, name: 'n', chain: [], body: 'x' }), 404, 'no such mailbox')
    assert.equal(await control(port, { op: 'open', box: BOX, seat: SEAT, handle: HANDLE }), 200)
    const file = join(dir, `ss-${BOX}.sock`)
    assert(lstatSync(file).isSocket() && ((await stat(file)).mode & 0o777) === 0o600, 'a private socket beside the session\'s own')
    const address = `uds:${file}`

    // A teammate's session's message into this session, from the mailbox: one
    // line on one connection, no auth line, its chain and id as sent.
    const before = lines.length
    assert.equal(await control(port, { op: 'deliver', box: BOX, name: 'composition · via Scott', mode: 'bypass', chain: CHAIN, id: ID, body: 'Count to three.' }), 200)
    assert(await until(() => lines.length === before + 1 && lines.at(-1).length === 1))
    const frame = JSON.parse(lines.at(-1)[0])
    assert.equal(frame.type, 'user', 'no auth line first')
    assert.deepEqual([frame.msg_id, frame.from], [ID, address])
    assert.equal(frame.message.content, `<cross-session-message from="${address}" hop-chain="${CHAIN.join(',')}" from-name="composition · via Scott" from-mode="bypass">\nCount to three.\n</cross-session-message>`)
    assert.equal(await control(port, { op: 'deliver', box: BOX, name: 'n', chain: [], body: 'x'.repeat(32_000) }), 200, 'a message of 32,000 characters fits the raised body limit')

    // This session's Claude writes back to the mailbox: posted to the seat,
    // with the msg_id its receipts will name. Anyone else's frame: nothing.
    const reply = { msgV: 1, msg_id: REF, type: 'user', message: { role: 'user', content: `<cross-session-message from="uds:${ownPath}" from-name="work" from-mode="prompting">\nThree.\n</cross-session-message>` }, priority: 'next', from: `uds:${ownPath}` }
    await write(file, JSON.stringify({ type: 'auth', token: 'whatever' }) + '\n' + JSON.stringify(reply))
    assert(await until(() => posts.length === 1))
    assert.deepEqual(posts[0], { path: `/api/rooms/${'r'.repeat(20)}/peer`, auth: `Bearer ${TOKEN}`, version: '0.11.26', body: { to: SEAT, handle: HANDLE, body: 'Three.', ref: REF } })
    const stranger = { ...reply, from: 'uds:/tmp/cc-socks/9.sock', message: { ...reply.message, content: reply.message.content.replace(`uds:${ownPath}`, 'uds:/tmp/cc-socks/9.sock') } }
    await write(file, JSON.stringify(stranger))
    await write(file, JSON.stringify({ type: 'control', action: 'peer_message_status', status: 'held', from: 'uds:/tmp/cc-socks/9.sock', orig_msg_id: ID, msgV: 1, msg_id: REF }))
    await wait(150)
    assert.equal(posts.length, 1, 'a frame or receipt from another session goes nowhere')

    // This session's receipts for what came from the mailbox: to the seat.
    await write(file, JSON.stringify({ type: 'control', action: 'peer_message_status', status: 'held', reason: 'x', from: `uds:${ownPath}`, orig_msg_id: ID, msgV: 1, msg_id: REF }))
    await write(file, JSON.stringify({ type: 'control', action: 'peer_message_status', status: 'expired', status_detail: 'refused', from: `uds:${ownPath}`, orig_msg_id: ID, msgV: 1, msg_id: REF }))
    assert(await until(() => posts.length === 3))
    assert.deepEqual(posts.slice(1).map(p => p.body), [{ to: SEAT, handle: HANDLE, status: 'held', id: ID }, { to: SEAT, handle: HANDLE, status: 'refused', id: ID }])

    // The seat's receipts for what this session wrote, into it from the
    // mailbox: `delivered` only after a `held`.
    const mark = allLines().length
    assert.equal(await control(port, { op: 'receipt', box: BOX, status: 'delivered', ref: REF }), 200)
    await wait(100)
    assert.equal(allLines().length, mark, 'no delivered before a held')
    assert.equal(await control(port, { op: 'receipt', box: BOX, status: 'held', ref: REF }), 200)
    assert.equal(await control(port, { op: 'receipt', box: BOX, status: 'delivered', ref: REF }), 200)
    // A receipt for anything this session didn't write to this mailbox (the
    // teammate's own message's id, or one of the host's sends elsewhere,
    // whose ids show in the room's rows): refused, nothing written.
    for (const ref of [ID, crypto.randomUUID()]) assert.equal(await control(port, { op: 'receipt', box: BOX, status: 'denied', ref }), 404)
    assert.equal(await control(port, { op: 'receipt', box: BOX, status: 'dropped', ref: REF, reason: 'hop-loop' }), 200)
    assert(await until(() => allLines().length === mark + 3))
    await wait(100)
    const receipts = allLines().slice(mark).map(l => JSON.parse(l))
    assert.deepEqual(receipts.map(r => [r.action, r.status, r.from, r.orig_msg_id, r.drop_reason]), [['peer_message_status', 'held', address, REF, undefined], ['peer_message_status', 'delivered', address, REF, undefined], ['peer_message_status', 'dropped', address, REF, 'hop-loop']])

    // What this session wrote that couldn't reach the seat: it hears so, as
    // Claude Code says it, from the mailbox.
    const failed = async (status, json, expect, reason) => {
      answer = () => [status, json]
      const at = allLines().length, id = crypto.randomUUID()
      await write(file, JSON.stringify({ ...reply, msg_id: id }))
      assert(await until(() => allLines().length === at + 1), `${status} ${JSON.stringify(json)}`)
      const r = JSON.parse(allLines().at(-1))
      assert.deepEqual([r.status === 'expired' && r.status_detail === 'refused' ? 'refused' : r.status, r.orig_msg_id, r.from, r.drop_reason], [expect, id, address, reason])
    }
    await failed(200, { delivered: false, reason: 'offline' }, 'dropped')
    await failed(429, { error: 'busy' }, 'dropped', 'rate-limited')
    await failed(413, { error: 'big' }, 'dropped')
    await failed(200, { delivered: false, reason: 'unsupported' }, 'refused')
    await failed(410, { error: 'ended' }, 'refused')
    await failed(403, { error: 'not a seat' }, 'refused')
    answer = () => [200, { delivered: true }]

    // A mailbox closed: gone from the directory.
    assert.equal(await control(port, { op: 'close', box: BOX }), 200)
    assert(!existsSync(file))
    await helper.close()
    assert.equal(await control(port, { op: 'open', box: BOX, seat: SEAT, handle: HANDLE }), 0, 'closed: no control port')
    console.log('OK mailbox helper: delivers with the chain and id, posts what the session writes and its receipts, writes the seat\'s receipts back, refuses strangers, swept, hardened')
  }
  liveServer.close()

  // Its life, as the plugin runs it: a launcher that starts it detached and
  // is gone, the helper no descendant of whoever started it.
  const launch = async (parent = process.pid, viaShell = false) => {
    // `viaShell`: through a stand-in for Claude Code that can be killed, so the helper's Claude Code is gone.
    const cfg = JSON.stringify(config())
    const child = viaShell
      ? spawn(process.execPath, ['-e', `const c=require('child_process').spawn(process.execPath,[${JSON.stringify(MAILBOX)}],{stdio:['pipe','inherit','ignore']});c.stdin.end(${JSON.stringify(cfg)});setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'ignore'] })
      : spawn(process.execPath, [MAILBOX], { stdio: ['pipe', 'pipe', 'ignore'] })
    if (!viaShell) child.stdin.end(cfg)
    let out = ''
    child.stdout.on('data', b => { out += b })
    assert(await until(() => out.includes('\n'), 6000), 'a ready line')
    const ready = JSON.parse(out.split('\n')[0])
    assert.equal(ready.state, 'ready')
    assert(Number.isInteger(ready.port) && Number.isInteger(ready.pid))
    return { ready, child, parent }
  }
  const ancestors = pid => {
    const chain = []
    for (let p = pid; p > 1 && chain.length < 64;) {
      const up = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(p)]).toString().trim())
      chain.push(up)
      p = up
    }
    return chain
  }
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  const opened = async port => {
    const box = crypto.randomUUID().replaceAll('-', '')
    assert.equal(await control(port, { op: 'open', box, seat: SEAT, handle: HANDLE }), 200)
    return join(dir, `ss-${box}.sock`)
  }
  {
    const { ready, child } = await launch()
    const [code] = child.exitCode === null ? await once(child, 'exit') : [child.exitCode]
    assert.equal(code, 0, 'the launcher is gone once the helper is ready')
    assert(await until(() => !ancestors(ready.pid).includes(process.pid)), 'the helper is no descendant of whoever started it')
    assert.equal(Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(ready.pid)]).toString().trim()), ready.pid, 'a session of its own: no terminal\'s hangup reaches it')
    const file = await opened(ready.port)
    // It writes into the session only once it's on its own.
    const at = lines.length
    assert.equal(await control(ready.port, { op: 'deliver', box: file.slice(-37, -5), name: 'n', chain: [], body: 'x' }), 200)
    assert(await until(() => lines.length === at + 1))
    process.kill(ready.pid, 'SIGHUP')
    assert(await until(() => !alive(ready.pid)), 'SIGHUP ends it')
    assert(!existsSync(file), 'and its mailboxes with it')
  }
  {
    const { ready } = await launch()
    const file = await opened(ready.port)
    process.kill(ready.pid, 'SIGTERM')
    assert(await until(() => !alive(ready.pid)), 'SIGTERM ends it')
    assert(!existsSync(file))
  }
  {
    const { ready } = await launch()
    const file = await opened(ready.port)
    assert.equal(await control(ready.port, { op: 'exit' }), 200)
    assert(await until(() => !alive(ready.pid)), 'told to, it ends')
    assert(!existsSync(file))
  }
  {
    // Its Claude Code gone (here a stand-in that started the launcher).
    const { ready, child } = await launch(undefined, true)
    const file = await opened(ready.port)
    child.kill('SIGKILL')
    assert(await until(() => !alive(ready.pid), 8000), 'its Claude Code gone, it ends')
    assert(!existsSync(file), 'and its mailboxes with it')
  }
  {
    // A launcher given a bad config says so and starts nothing.
    const child = spawn(process.execPath, [MAILBOX], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', b => { out += b })
    child.stdin.end(JSON.stringify({ ...config(), pid: 1 }))
    const [code] = await once(child, 'exit')
    assert.deepEqual([code, out.trim()], [1, '{"state":"error","code":"INVALID_CONFIG"}'])
  }
  assert.deepEqual((await readdir(dir)).filter(n => /^ss-/.test(n)), [`ss-${'f0'.repeat(16)}.sock`], 'only the fresh leftover the sweep spared remains')
  console.log('OK mailbox life: started detached and no descendant, SIGHUP, SIGTERM, exit and its Claude Code gone each end it and unlink its mailboxes')
} finally {
  own.close(); room.close()
  await rm(dir, { recursive: true, force: true })
}
