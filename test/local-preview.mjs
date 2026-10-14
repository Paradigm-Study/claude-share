// Standalone Node 20+ checks: no models, deps, OAuth or saved room data.
//   node test/local-preview.mjs                 (real Room + Node + both helpers)
//   node test/local-preview.mjs --helpers-only (parser/listener checks only)
//   EXTERNAL_SERVER=1 SHARE_SERVER=http://127.0.0.1:8787 node test/local-preview.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { randomBytes, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import helper from '../plugin/relay/local-preview.cjs'
import wsHelper from '../plugin/relay/ws-relay.cjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const GUEST = fileURLToPath(new URL('../plugin/relay/local-preview.cjs', import.meta.url))
const HOST = fileURLToPath(new URL('../plugin/relay/ws-relay.cjs', import.meta.url))
const NODE = fileURLToPath(new URL('../server/node.mjs', import.meta.url))
const VERSION = JSON.parse(await readFile(new URL('../plugin/.claude-plugin/plugin.json', import.meta.url))).version
const scratch = await mkdtemp(`${tmpdir()}/shared-tcp-`)
const children = new Set(), servers = new Set(), sockets = new Set(), running = new Set(), websockets = new Set(), requests = new Set()
const ROOM = 'R'.repeat(24), PID = 'P'.repeat(12), CAP = 'C'.repeat(32)
const dummy = port => ({ port, strict: true, url: `http://127.0.0.1:1/api/rooms/${ROOM}/previews/${PID}/tunnel`, token: CAP, expiresAt: Date.now() + 60_000 })
let ipv6 = true

async function until(check, label, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await pause(10) }
  throw new Error(`Timed out: ${label}`)
}
const listen = (server, host = '127.0.0.1', port = 0) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen({ host, port, ipv6Only: host === '::1' }, () => { server.removeListener('error', reject); resolve(server.address().port) })
})
const close = server => new Promise(resolve => server.listening ? server.close(resolve) : resolve())
function track(server) {
  servers.add(server)
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)) })
  return server
}
async function freePort() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const v4 = track(net.createServer()), v6 = track(net.createServer())
    const port = await listen(v4)
    try { await listen(v6, '::1', port); await Promise.all([close(v4), close(v6)]); return port } catch (error) {
      await close(v4)
      if (['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)) { ipv6 = false; return port }
      if (error.code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error('Could not reserve a dual-stack test port')
}
function launch(file, cfg, env = {}) {
  const child = spawn(process.execPath, [file], { cwd: scratch, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const log = { child, stdout: '', stderr: '', rows: [], exit: null }
  children.add(child)
  child.stdin.on('error', () => {})
  let input = ''
  child.stdout.on('data', bytes => {
    log.stdout += bytes
    if (file === NODE) return
    input += bytes
    let at
    while ((at = input.indexOf('\n')) !== -1) {
      const line = input.slice(0, at); input = input.slice(at + 1)
      if (line.trim()) log.rows.push(JSON.parse(line))
    }
  })
  child.stderr.on('data', bytes => (log.stderr += bytes))
  child.once('exit', (code, signal) => { log.exit = { code, signal }; children.delete(child) })
  child.stdin.end(typeof cfg === 'string' ? cfg : JSON.stringify(cfg ?? {}))
  return log
}
async function ready(cfg) {
  const log = launch(GUEST, cfg)
  await until(() => log.rows.length || log.exit, 'guest listener ready')
  assert.equal(log.rows[0]?.state, 'ready', JSON.stringify(log.rows))
  assert.ok(Number.isInteger(log.rows[0].port))
  log.port = log.rows[0].port
  return log
}
async function stop(log) {
  if (!log.exit) log.child.kill('SIGTERM')
  await until(() => log.exit, 'helper stopped')
  assert.equal(log.stderr, '')
  assert.equal(log.exit.code, 0)
}
async function startupError(cfg, code) {
  const log = launch(GUEST, cfg)
  await until(() => log.exit, `startup ${code}`)
  assert.deepEqual(log.rows, [{ state: 'error', code }])
  assert.notEqual(log.exit.code, 0)
  assert.equal(log.stderr, '')
}
async function wire(port, host = '127.0.0.1', collect = true) {
  const client = net.createConnection({ host, port, allowHalfOpen: true })
  sockets.add(client)
  const result = { client, parts: [], closed: false, ended: false }
  Object.defineProperty(result, 'bytes', { get: () => Buffer.concat(result.parts) })
  if (collect) client.on('data', bytes => result.parts.push(bytes))
  client.on('error', () => {})
  client.on('end', () => { result.ended = true; client.end() })
  client.on('close', () => { result.closed = true; sockets.delete(client) })
  await once(client, 'connect')
  return result
}
function request(port, path = '/', { method = 'GET', body, headers = {}, host = '127.0.0.1', onData = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: host, port, method, path, agent: false, headers: { host: `localhost:${port}`, ...headers } }, res => {
      const parts = []
      res.on('data', bytes => { parts.push(bytes); onData(bytes) })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }))
      res.on('error', reject)
    })
    requests.add(req)
    const timer = setTimeout(() => req.destroy(new Error('Test HTTP timeout')), 15_000)
    req.once('close', () => { clearTimeout(timer); requests.delete(req) })
    req.on('error', reject)
    req.end(body)
  })
}
// Test-only wire frames, not another production parser.
function frame(op, payload, { fin = true, mask = false, rsv = 0 } = {}) {
  payload = Buffer.from(payload)
  const head = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10)
  head[0] = (fin ? 128 : 0) | rsv | op
  head[1] = (mask ? 128 : 0) | (payload.length < 126 ? payload.length : payload.length < 65536 ? 126 : 127)
  if (head.length === 4) head.writeUInt16BE(payload.length, 2)
  if (head.length === 10) head.writeBigUInt64BE(BigInt(payload.length), 2)
  const key = Buffer.from([1, 2, 3, 4]), body = Buffer.from(payload)
  if (mask) for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3]
  return Buffer.concat([head, ...(mask ? [key] : []), body])
}
function readFrames(socket, head, receive) {
  let bytes = head || Buffer.alloc(0)
  function read() {
    while (bytes.length >= 2) {
      let at = 2, length = bytes[1] & 127
      if (length === 126) { if (bytes.length < 4) return; length = bytes.readUInt16BE(2); at = 4 }
      if (length === 127) { if (bytes.length < 10) return; length = Number(bytes.readBigUInt64BE(2)); at = 10 }
      const masked = !!(bytes[1] & 128), payloadAt = at + (masked ? 4 : 0)
      if (bytes.length < payloadAt + length) return
      const op = bytes[0] & 15, data = Buffer.from(bytes.subarray(payloadAt, payloadAt + length))
      if (masked) for (let i = 0; i < data.length; i++) data[i] ^= bytes[at + (i & 3)]
      bytes = bytes.subarray(payloadAt + length)
      receive(op, data)
    }
  }
  socket.on('data', data => { bytes = Buffer.concat([bytes, data]); read() })
  read()
}
function handshake(req, socket, extra = '') {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n${extra}\r\n`)
}
function connect(url, headers = {}, on = {}, options) {
  const socket = wsHelper.connect(url, headers, [], on, options)
  websockets.add(socket)
  return socket
}

async function parserChecks() {
  let attack
  const fixture = track(http.createServer((_req, _res) => {}))
  fixture.on('upgrade', (req, socket) => attack(req, socket))
  const url = `ws://127.0.0.1:${await listen(fixture)}/`
  async function rejected(run, code, options) {
    attack = run
    let ended
    connect(url, {}, { close: c => (ended = c) }, options)
    await until(() => ended !== undefined, `WS rejected ${code}`)
    assert.equal(ended, code)
  }
  await rejected((_req, s) => s.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: wrong\r\n\r\n'), 1002)
  for (const bytes of [frame(2, 'masked', { mask: true }), frame(2, 'rsv', { rsv: 64 }), frame(3, ''), frame(0, ''), frame(9, '', { fin: false }), frame(9, Buffer.alloc(126)), Buffer.from([0x82, 126, 0, 1]), Buffer.from([0x88, 1, 0]), frame(1, Buffer.from([255])), Buffer.concat([frame(2, 'a', { fin: false }), frame(1, 'b')])]) {
    const utf8 = bytes.equals(frame(1, Buffer.from([255])))
    await rejected((req, s) => { handshake(req, s); s.write(bytes) }, utf8 ? 1007 : 1002)
  }
  for (const length of [65537n, 0x8000000000000000n]) {
    const bytes = Buffer.alloc(10); bytes[0] = 0x82; bytes[1] = 127; bytes.writeBigUInt64BE(length, 2)
    await rejected((req, s) => { handshake(req, s); s.write(bytes) }, 1009, { maxMessage: 65536 })
  }
  await rejected((req, s) => { handshake(req, s); s.write(frame(2, Buffer.alloc(600 * 1024), { fin: false })); s.write(frame(0, Buffer.alloc(600 * 1024))) }, 1009)
  await rejected((_req, s) => s.end(`HTTP/1.1 101 Switching Protocols\r\nX-Large: ${'x'.repeat(17 * 1024)}\r\n\r\n`), 1006)
  const messages = []
  attack = (req, s) => { handshake(req, s); s.write(Buffer.concat([frame(2, [0, 255], { fin: false }), frame(9, 'ping'), frame(0, [128, 1])])) }
  const fragmented = connect(url, {}, { message: (data, binary) => messages.push({ data, binary }) })
  await until(() => messages.length, 'fragmented WS with interleaved ping')
  assert.deepEqual(messages, [{ data: Buffer.from([0, 255, 128, 1]), binary: true }])
  fragmented.close()
  attack = () => {}
  let overflow
  const queued = connect(url, {}, { close: code => (overflow = code) })
  for (let i = 0; i < 17; i++) queued.send(Buffer.alloc(65536), true)
  assert.equal(overflow, 1009, 'pre-handshake queue is bounded')
  attack = (req, s) => { handshake(req, s); s.pause() }
  let sendingCode, opened = false
  const sending = connect(url, {}, { open: () => (opened = true), close: code => (sendingCode = code) })
  await until(() => opened, 'send buffer fixture')
  for (let i = 0; i < 1024 && sendingCode === undefined; i++) sending.send(Buffer.alloc(65536), true)
  assert.equal(sendingCode, 1009, 'WS sending cannot grow without limit')
  let handshakeTimeout
  attack = () => {}
  connect(url, {}, { close: code => (handshakeTimeout = code) }, { timeoutMs: 80 })
  await until(() => handshakeTimeout !== undefined, 'bounded WS handshake')
  assert.equal(handshakeTimeout, 1006)
  console.log('ok WS accept, UTF-8/64-bit/RSV/opcode/mask/control/fragments, handshake/receive/send/queue limits')
}

async function publicRelayChecks() {
  const messages = [], headers = new Map(), peers = new Map()
  const fixture = track(http.createServer())
  fixture.on('upgrade', (req, socket, head) => {
    headers.set(req.url, req.headers); peers.set(req.url, socket)
    handshake(req, socket, req.url === '/local' ? 'Sec-WebSocket-Protocol: dev\r\n' : '')
    readFrames(socket, head, (op, payload) => {
      if (op === 8) return socket.end(frame(8, payload))
      if (req.url === '/local') socket.write(frame(op, payload))
      else messages.push({ op, payload })
    })
  })
  const port = await listen(fixture)
  const relay = wsHelper.start({ local: `ws://localhost:${port}/local`, origin: `http://localhost:${port}`, protocols: ['dev'], room: `ws://localhost:${port}/room`, token: CAP, version: VERSION })
  running.add(relay)
  await until(() => peers.size === 2, 'ordinary/public WS relay still connects both halves')
  assert.equal(headers.get('/local').origin, `http://localhost:${port}`)
  assert.equal(headers.get('/local')['sec-websocket-protocol'], 'dev')
  assert.equal(headers.get('/room').authorization, `Bearer ${CAP}`)
  assert.equal(headers.get('/room')['x-shared-session-version'], VERSION)
  peers.get('/room').write(frame(1, 'public text'))
  await until(() => messages.length === 1, 'ordinary relay text')
  peers.get('/room').write(frame(2, [0, 255, 128]))
  await until(() => messages.length === 2, 'ordinary relay binary')
  assert.deepEqual(messages, [{ op: 1, payload: Buffer.from('public text') }, { op: 2, payload: Buffer.from([0, 255, 128]) }])
  relay.close(); running.delete(relay)
  await until(() => [...peers.values()].every(peer => peer.destroyed), 'ordinary relay graceful close')
  console.log('ok ordinary/public WS helper compatibility, protocols/Origin, text/binary and graceful cleanup')
}

async function bridgeChecks() {
  const control = row => frame(1, JSON.stringify(row)), ready = control({ t: 'ready' }), credit = n => control({ t: 'credit', n, nonce: 'N'.repeat(24) })
  let attack
  const fixture = track(http.createServer())
  fixture.on('upgrade', (req, socket, head) => { handshake(req, socket); attack(socket, head) })
  const url = `http://127.0.0.1:${await listen(fixture)}/api/rooms/${ROOM}/previews/${PID}/tunnel`
  for (const bytes of [frame(2, 'before ready'), Buffer.concat([ready, ready]), Buffer.concat([ready, credit(1)]), Buffer.concat([ready, frame(2, 'a'), frame(2, 'b')]), Buffer.concat([ready, frame(2, 'a'), credit(2)]), Buffer.concat([ready, control({ t: 'fin' }), control({ t: 'fin' })]), Buffer.concat([ready, control({ t: 'unknown' })]), Buffer.concat([ready, frame(1, 'x'.repeat(257))])]) {
    const states = []
    attack = socket => socket.write(bytes)
    const listener = await helper.start({ ...dummy(await freePort()), url }, { emit: row => states.push(row) })
    running.add(listener)
    const client = await wire(listener.port)
    await until(() => client.closed, 'invalid DATA/control closes TCP')
    assert.ok(states.some(row => row.state === 'error' && row.code === 'PROTOCOL'), JSON.stringify(states))
    await listener.close(); running.delete(listener)
  }
  let roomSocket, received = [], noCredit = true
  attack = (socket, head) => {
    roomSocket = socket
    readFrames(socket, head, (op, bytes) => received.push({ op, bytes }))
    socket.write(Buffer.concat([ready, frame(2, 'reply')]))
  }
  const states = [], listener = await helper.start({ ...dummy(await freePort()), url }, { emit: row => states.push(row) })
  running.add(listener)
  const client = await wire(listener.port)
  await until(() => client.bytes.length === 5, 'raw DATA delivered to TCP')
  await pause(30)
  assert.equal(received.length, 0, 'receiver cannot guess ACK without server challenge')
  roomSocket.write(credit(5)); noCredit = false
  await until(() => received.length === 1, 'challenge ACK')
  assert.deepEqual(JSON.parse(received[0].bytes), { t: 'ack', n: 5, nonce: 'N'.repeat(24) })
  roomSocket.write(control({ t: 'fin' }))
  await until(() => received.some(row => row.op === 1 && JSON.parse(row.bytes).t === 'fin'), 'reverse FIN')
  roomSocket.end(frame(8, Buffer.from([3, 232])))
  await until(() => client.closed, 'normal FIN TCP close')
  assert.ok(!noCredit && states.every(row => row.state === 'ready'))
  await listener.close(); running.delete(listener)

  // Even a 1000 close is abnormal if the TCP halves did not finish.
  const disconnectedStates = []
  attack = socket => socket.end(Buffer.concat([ready, frame(8, Buffer.from([3, 232]))]))
  const disconnected = await helper.start({ ...dummy(await freePort()), url }, { emit: row => disconnectedStates.push(row) })
  running.add(disconnected)
  const oldTCP = await wire(disconnected.port)
  await until(() => oldTCP.closed, 'WS disconnect destroys unfinished TCP')
  assert.ok(disconnectedStates.some(row => row.code === 'CONNECT'))
  await disconnected.close(); running.delete(disconnected)

  let targetSocket
  const target = track(net.createServer(socket => { targetSocket = socket; socket.on('end', () => socket.end()) }))
  const targetPort = await listen(target), timeoutStates = []
  attack = () => {} // WS upgrade succeeds, but the room never pairs it.
  const timedHost = wsHelper.start({ tcp: true, port: targetPort, room: url.replace(/^http/, 'ws').replace(`/previews/${PID}/tunnel`, '/ws/HHHHHHHHHHHH'), token: CAP, version: VERSION }, { emit: row => timeoutStates.push(row), timeoutMs: 80 })
  await timedHost.closed
  await until(() => targetSocket?.destroyed, 'host timeout closes loopback target')
  assert.deepEqual(timeoutStates, [{ state: 'error', code: 'TIMEOUT' }])

  const sent = [], payload = randomBytes(300 * 1024 + 37)
  let forwarding = false, incomingACK = false, closing = false
  attack = (socket, head) => {
    roomSocket = socket
    readFrames(socket, head, (op, bytes) => {
      if (op === 2) {
        sent.push(Buffer.from(bytes))
        if (forwarding) socket.write(control({ t: 'ack', n: bytes.length, nonce: randomBytes(18).toString('base64url') }))
      } else if (op === 1) {
        const row = JSON.parse(bytes)
        if (row.t === 'ack') incomingACK = true
        if (row.t === 'fin' && !closing) { closing = true; socket.end(Buffer.concat([control({ t: 'fin' }), frame(8, Buffer.from([3, 232]))])) }
      }
    })
    socket.write(ready)
  }
  const windowRun = await helper.start({ ...dummy(await freePort()), url }, { emit: () => {} })
  running.add(windowRun)
  const windowClient = await wire(windowRun.port); windowClient.client.end(payload)
  await until(() => sent.length === 4, 'four-frame outstanding window')
  await pause(50)
  assert.equal(sent.length, 4, 'no fifth frame before ACK')
  assert.ok(sent.every(bytes => bytes.length <= 65536))
  assert.ok(Buffer.concat(sent).length <= 256 * 1024)
  roomSocket.write(Buffer.concat([frame(2, 'reverse'), credit(7)]))
  await until(() => incomingACK, 'reverse ACK stays readable despite full send window')
  forwarding = true
  for (const bytes of sent) roomSocket.write(control({ t: 'ack', n: bytes.length, nonce: randomBytes(18).toString('base64url') }))
  await until(() => windowClient.closed, 'window resumes and both FINs drain')
  assert.deepEqual(Buffer.concat(sent), payload)
  assert.equal(windowClient.bytes.toString(), 'reverse')
  await windowRun.close(); running.delete(windowRun)
  console.log('ok ready/DATA-credit pairing/control validation, no guessed ACK, four-frame window, reverse ACK without deadlock and FIN ordering')
}

async function listenerChecks() {
  const preferred = await freePort(), cfg = dummy(preferred)
  for (const bad of ['{broken', 'x'.repeat(20_000), { ...cfg, port: 0 }, { ...cfg, port: '123' }, { ...cfg, port: 65536 }, { ...cfg, strict: undefined }, { ...cfg, ticket: 'old' }, { ...cfg, token: 'bad\r\nsecret' }, { ...cfg, expiresAt: 'tomorrow' }, { ...cfg, url: cfg.url + '?' }, { ...cfg, url: cfg.url + '#' }, { ...cfg, url: cfg.url.replace('http://', 'http://user:password@') }, { ...cfg, url: cfg.url.replace('127.0.0.1:1', 'unrelated.test') }, { ...cfg, url: cfg.url.replace('/tunnel', '/other') }, { ...cfg, url: cfg.url.replace('/api/', '/a/../api/') }]) await startupError(bad, 'INVALID_CONFIG')
  await startupError({ ...cfg, expiresAt: Date.now() - 1 }, 'EXPIRED')
  const busy = track(net.createServer(s => s.end('unrelated listener'))), busyPort = await listen(busy)
  await startupError(dummy(busyPort), 'EADDRINUSE')
  const automatic = await ready({ ...dummy(busyPort), strict: false })
  assert.notEqual(automatic.port, busyPort)
  const unrelated = await wire(busyPort)
  await until(() => unrelated.closed, 'unrelated listener still works')
  assert.equal(unrelated.bytes.toString(), 'unrelated listener')
  await stop(automatic)
  if (ipv6) {
    const busy6 = track(net.createServer(s => s.end('IPv6 listener'))), busy6Port = await listen(busy6, '::1')
    await startupError(dummy(busy6Port), 'EADDRINUSE')
    const rolledBack = track(net.createServer()); await listen(rolledBack, '127.0.0.1', busy6Port); await close(rolledBack)
    const fallback = await ready({ ...dummy(busy6Port), strict: false })
    assert.notEqual(fallback.port, busy6Port)
    const stillFree4 = track(net.createServer()); await listen(stillFree4, '127.0.0.1', busy6Port); await close(stillFree4)
    await stop(fallback)
    const original = await wire(busy6Port, '::1'); await until(() => original.closed, 'unrelated IPv6 listener')
    assert.equal(original.bytes.toString(), 'IPv6 listener')
  }
  const good = await ready(cfg)
  assert.equal(good.port, preferred)
  assert.equal(good.stdout, JSON.stringify({ state: 'ready', port: preferred }) + '\n')
  assert.ok(!good.stdout.includes(CAP) && !good.stderr.includes(CAP))
  await stop(good)
  const again = await ready(cfg); await stop(again)
  const states = [], controller = new AbortController()
  const cancelled = helper.start(dummy(await freePort()), { signal: controller.signal, emit: row => states.push(row), createServer: (...args) => {
    const server = net.createServer(...args), native = server.listen.bind(server)
    server.listen = (...args) => { setTimeout(() => native(...args), 30); return server }
    return server
  } })
  controller.abort()
  await assert.rejects(cancelled)
  assert.deepEqual(states, [], 'cancelled startup cannot emit late ready')
  // Only a genuinely unsupported IPv6 bind permits IPv4-only operation.
  let number = 0
  const v4only = await helper.start(dummy(await freePort()), { emit: () => {}, createServer: (...args) => {
    const server = net.createServer(...args)
    if (++number === 2) server.listen = () => { queueMicrotask(() => server.emit('error', Object.assign(new Error(), { code: 'EAFNOSUPPORT' }))); return server }
    return server
  } })
  await v4only.close()
  console.log(`ok bounded stdin/config, automatic vs strict port, rollback${ipv6 ? '/dual-stack' : ' (IPv6 unsupported)'}, cancel/rebind/sanitized stdout`)
}

async function realChain() {
  let origin
  if (process.env.EXTERNAL_SERVER === '1') {
    assert.ok(process.env.SHARE_SERVER, 'SHARE_SERVER is required with EXTERNAL_SERVER=1')
    origin = new URL(process.env.SHARE_SERVER).origin
  } else {
    const mainPort = await freePort(), previewPort = await freePort()
    origin = `http://127.0.0.1:${mainPort}`
    const node = launch(NODE, undefined, { PORT: String(mainPort), PREVIEW_PORT: String(previewPort), PUBLIC_URL: origin, DATA_FILE: '', AUTH_TEST: '' })
    await until(() => node.stdout.includes('shared sessions on') || node.exit, 'Node room server', 10_000)
    assert.equal(node.exit, null, node.stderr)
  }
  async function api(path, token, body, expected = 200) {
    const res = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shared-session-version': VERSION, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) })
    const result = await res.json()
    assert.equal(res.status, expected, JSON.stringify(result))
    return result
  }
  const room = await api('/api/rooms', null, { name: 'Host', title: 'TCP fixture' })
  const base = `/api/rooms/${room.id}`, guest = await api(`${base}/join`, null, { name: 'Guest' })
  const target = new URL(origin)
  const interruptible = target.protocol === 'http:' && (target.hostname === 'localhost' || target.hostname === '[::1]' || (net.isIP(target.hostname) === 4 && target.hostname.startsWith('127.')))
  async function faultGate() {
    const active = new Set()
    let online = true, refused = 0
    const server = track(net.createServer({ allowHalfOpen: true }, client => {
      if (!online) { refused++; client.destroy(); return }
      const upstream = net.createConnection({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 80), allowHalfOpen: true })
      const destroy = () => { client.destroy(); upstream.destroy() }
      for (const socket of [client, upstream]) {
        active.add(socket); sockets.add(socket)
        socket.on('error', destroy)
        socket.on('close', () => { active.delete(socket); sockets.delete(socket); destroy() })
      }
      client.pipe(upstream).pipe(client)
    }))
    const port = await listen(server)
    return { server, port, origin: `http://127.0.0.1:${port}`, active, get refused() { return refused },
      down() { online = false; for (const socket of active) socket.destroy() },
      up() { online = true },
    }
  }
  const guestGate = interruptible ? await faultGate() : null, hostGate = interruptible ? await faultGate() : null
  const guestOrigin = guestGate?.origin ?? origin, hostOrigin = hostGate?.origin ?? origin
  const seenTCP = [], hostLogs = []
  async function subscribe() {
    const state = { ready: false, closed: false }
    const req = (target.protocol === 'https:' ? https : http).get(`${origin}${base}/stream?after=0&tcp=1`, { headers: { authorization: `Bearer ${room.token}`, 'x-shared-session-version': VERSION } })
    requests.add(req)
    req.on('error', () => {})
    req.once('close', () => { state.closed = true; requests.delete(req) })
    req.on('response', res => {
      assert.equal(res.statusCode, 200)
      let input = ''
      res.on('data', bytes => {
        input += bytes
        let at
        while ((at = input.indexOf('\n')) !== -1) {
          const line = input.slice(0, at); input = input.slice(at + 1)
          if (!line) continue
          const row = JSON.parse(line)
          state.ready = true
          if (!row.tcp) continue
          seenTCP.push(row.tcp)
          assert.ok(Number.isInteger(row.tcp.port) && row.tcp.pid)
          hostLogs.push(launch(HOST, { tcp: true, port: row.tcp.port, room: `${hostOrigin.replace(/^http/, 'ws')}${base}/ws/${row.tcp.id}`, token: room.token, version: VERSION }))
        }
      })
      res.on('error', () => {})
    })
    await until(() => state.ready || state.closed, 'host TCP-capable control stream')
    assert.equal(state.ready, true)
    return { request: req, get closed() { return state.closed } }
  }
  let stream = await subscribe()
  async function share(port) { return (await api(`${base}/previews`, room.token, { port })).pid }
  async function grant(pid, member = guest.token) {
    const result = await api(`${base}/previews/${pid}/tunnel`, member)
    assert.equal(result.protocol, 1, 'server must support the fixed TCP protocol')
    assert.ok(Number.isSafeInteger(result.expiresAt) && result.expiresAt > Date.now())
    return { port: result.port, strict: false, url: `${guestOrigin}${base}/previews/${pid}/tunnel`, token: result.token, expiresAt: result.expiresAt }
  }
  const echo = track(net.createServer({ allowHalfOpen: true }, socket => {
    socket.on('data', bytes => { if (!socket.write(bytes)) socket.pause() })
    socket.on('drain', () => socket.resume())
    socket.on('end', () => socket.end(Buffer.from([0, 255, 70, 73, 78])))
  }))
  const echoPort = await listen(echo), echoPid = await share(echoPort), echoCfg = await grant(echoPid)
  const raw = await ready(echoCfg)
  assert.notEqual(raw.port, echoPort, 'guest default auto-selects when the host port is busy on this machine')
  const bytes = randomBytes(4 * 1024 * 1024 + 37), rawWire = await wire(raw.port)
  rawWire.client.end(bytes)
  await until(() => rawWire.closed, 'multi-frame binary + bidirectional FIN', 20_000)
  assert.deepEqual(rawWire.bytes, Buffer.concat([bytes, Buffer.from([0, 255, 70, 73, 78])]))
  const headers = Buffer.from('POST /callback?code=once HTTP/1.1\r\nHost: other-origin.test\r\nCookie: session=A; cs_pv=application-cookie\r\nCookie: extra=1\r\nAuthorization: Bearer application-auth\r\nOrigin: https://oauth-provider.test\r\nConnection: close, x-keep\r\nX-Keep: unchanged\r\nContent-Length: 4\r\n\r\n\x00\xffhi', 'latin1')
  const rawHeaders = await wire(raw.port); rawHeaders.client.end(headers)
  await until(() => rawHeaders.closed, 'raw HTTP headers')
  assert.deepEqual(rawHeaders.bytes.subarray(0, headers.length), headers)
  if (ipv6) {
    const v6guest = await wire(raw.port, '::1'); v6guest.client.end('ipv6 guest')
    await until(() => v6guest.closed, 'IPv6 guest')
    assert.ok(v6guest.bytes.subarray(0, 10).equals(Buffer.from('ipv6 guest')))
    const v6app = track(net.createServer({ allowHalfOpen: true }, socket => { socket.on('data', b => socket.write(b)); socket.on('end', () => socket.end()) }))
    const v6port = await listen(v6app, '::1'), v6cfg = await grant(await share(v6port))
    const v6run = await ready({ ...v6cfg, port: await freePort(), strict: true })
    const v6host = await wire(v6run.port); v6host.client.end('host IPv6 fallback')
    await until(() => v6host.closed, 'IPv6-only host fallback')
    assert.equal(v6host.bytes.toString(), 'host IPv6 fallback')
    await stop(v6run)
  }
  console.log('ok real Room/control stream + host/guest helpers, binary/multiframe, exact headers and duplex FIN')

  const appRequests = [], upgrades = [], LARGE = 24 * 1024 * 1024 + 11, chunk = Buffer.alloc(65536, 0x6a)
  let largeWritten = 0
  const app = track(http.createServer(async (req, res) => {
    const parts = []; for await (const bytes of req) parts.push(bytes)
    const body = Buffer.concat(parts), seen = { method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: body.toString('base64') }
    appRequests.push(seen)
    const url = new URL(req.url, 'http://fixture.test')
    if (url.pathname === '/drop') return req.socket.destroy()
    if (url.pathname === '/hold') return
    if (url.pathname === '/binary') { res.writeHead(200, { 'content-length': body.length, 'set-cookie': ['one=1', 'two=2', 'cs_pv=app-owned'], 'x-keep': 'unchanged' }); return res.end(body) }
    if (url.pathname === '/redirect') { res.writeHead(302, { location: url.searchParams.get('to'), 'set-cookie': 'state=A; Path=/; HttpOnly; SameSite=Lax' }); return res.end() }
    if (url.pathname.startsWith('/status/')) { res.writeHead(Number(url.pathname.split('/').at(-1))); return res.end('app response') }
    if (url.pathname === '/large') {
      res.writeHead(200, { 'content-length': LARGE })
      try { for (let at = 0; at < LARGE; at += chunk.length) { const b = chunk.subarray(0, Math.min(chunk.length, LARGE - at)); largeWritten += b.length; if (!res.write(b)) await once(res, 'drain') } res.end() } catch {}
      return
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (let i = 0; i < 8; i++) { res.write(`data: ${i}\n\n`); await pause(15) }
      return res.end()
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(seen))
  }))
  app.on('upgrade', (req, socket, head) => {
    upgrades.push({ headers: req.headers, rawHeaders: req.rawHeaders, head: Buffer.from(head) })
    handshake(req, socket, 'Set-Cookie: cs_pv=application-cookie\r\n')
    readFrames(socket, head, (op, payload) => {
      if (op === 8) return socket.end(frame(8, payload))
      socket.write(frame(op, payload))
    })
  })
  const appPort = await listen(app), appPid = await share(appPort), appCfg = await grant(appPid), live = await ready(appCfg), port = live.port
  const provider = 'https://oauth-provider.test', local = `http://localhost:${port}`
  const got = await request(port, '/nested/page?x=one%20two&x=three', { headers: { host: `unrelated.test:${port}`, origin: provider, referer: `${provider}/authorize`, cookie: 'session=A; cs_pv=browser-owned; flag=1', authorization: 'Bearer application-auth', 'x-keep': 'unchanged' } })
  const seen = JSON.parse(got.body)
  assert.equal(seen.url, '/nested/page?x=one%20two&x=three')
  assert.equal(seen.headers.host, `unrelated.test:${port}`)
  assert.equal(seen.headers.origin, provider)
  assert.equal(seen.headers.cookie, 'session=A; cs_pv=browser-owned; flag=1')
  assert.equal(seen.headers.authorization, 'Bearer application-auth')
  const binary = await request(port, '/binary', { method: 'POST', body: bytes, headers: { 'content-length': bytes.length } })
  assert.deepEqual(binary.body, bytes)
  assert.deepEqual(binary.headers['set-cookie'], ['one=1', 'two=2', 'cs_pv=app-owned'])
  assert.equal(binary.headers['x-keep'], 'unchanged')
  for (const location of [`${provider}/authorize?redirect_uri=${encodeURIComponent(local + '/callback')}`, `http://localhost:${appPort}/callback?code=1#done`, `${origin}/unchanged`]) assert.equal((await request(port, `/redirect?to=${encodeURIComponent(location)}`)).headers.location, location)
  for (const state of ['A', 'B']) {
    const cookie = `session=${state}; state=${state}`
    const get = JSON.parse((await request(port, `/callback?state=${state}&code=one`, { headers: { cookie, origin: provider } })).body)
    const post = JSON.parse((await request(port, '/callback', { method: 'POST', body: `state=${state}&code=two`, headers: { cookie, origin: provider, 'content-type': 'application/x-www-form-urlencoded' } })).body)
    assert.equal(get.headers.cookie, cookie); assert.equal(post.headers.cookie, cookie); assert.equal(post.headers.origin, provider)
  }
  for (const status of [401, 404]) { const before = appRequests.length; assert.equal((await request(port, `/status/${status}`, { method: 'POST', body: 'once' })).status, status); assert.equal(appRequests.length, before + 1) }
  const beforeDrop = appRequests.length
  await assert.rejects(request(port, '/drop', { method: 'POST', body: 'not replayed' }))
  await pause(100); assert.equal(appRequests.length, beforeDrop + 1)
  assert.equal((await request(port, '/new-connection')).status, 200, 'only a new TCP connection gets a new channel')
  assert.ok(appRequests.every(row => !JSON.stringify(row).includes(appCfg.token) && !JSON.stringify(row).includes(guest.token) && !JSON.stringify(row).includes(room.token)))
  console.log('ok HTTP/cookies/Host/Origin/auth unchanged, separate browser jars, external/absolute Location, callback GET/POST; no 401/404/reset replay')

  const browserHeaders = { origin: provider, cookie: 'session=A; cs_pv=application-cookie', authorization: 'Bearer app-WS' }
  async function openAppWS() {
    const state = { opened: false, closed: undefined, messages: [] }
    const socket = connect(`ws://localhost:${port}/ws`, browserHeaders, { open: () => (state.opened = true), message: (data, binary) => state.messages.push({ data, binary }), close: code => (state.closed = code) })
    await until(() => state.opened || state.closed !== undefined, 'application WS through TCP')
    assert.equal(state.opened, true)
    return { socket, state }
  }
  async function appEcho(ws, data, binary = false) {
    assert.equal(ws.state.closed, undefined, 'old application WS must still be connected')
    const count = ws.state.messages.length
    assert.equal(ws.socket.send(data, binary), true)
    await until(() => ws.state.messages.length > count, 'application WS echo')
    assert.deepEqual(ws.state.messages.slice(count), [{ data, binary }])
  }
  async function events() {
    let firstEvent, finished = false, received = ''
    const first = new Promise(resolve => (firstEvent = resolve))
    const pending = request(port, '/events', { host: 'localhost', onData: bytes => { received += bytes; if (received.includes('data: 0')) firstEvent() } }).then(result => { finished = true; return result })
    await Promise.race([first, pending])
    assert.equal(finished, false, 'SSE first event arrives before the response ends')
    const result = await pending
    assert.equal(result.headers['content-type'], 'text/event-stream')
    assert.equal(result.body.toString(), Array.from({ length: 8 }, (_, i) => `data: ${i}\n\n`).join(''))
  }
  const browser = await openAppWS()
  await appEcho(browser, 'HMR text')
  await appEcho(browser, Buffer.from([0, 255, 128]), true)
  assert.equal(upgrades.at(-1).headers.cookie, browserHeaders.cookie)
  assert.equal(upgrades.at(-1).headers.authorization, browserHeaders.authorization)
  assert.equal(upgrades.at(-1).headers.origin, provider)
  browser.socket.close(); await until(() => browser.state.closed !== undefined, 'application WS close')
  const slow = await wire(port, '127.0.0.1', false)
  slow.client.pause()
  slow.client.write(`GET /large HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`)
  await until(() => largeWritten > 0, 'large response begins')
  await pause(150)
  assert.ok(largeWritten < LARGE, 'slow consumer bounds upstream instead of buffering the whole response')
  slow.client.on('data', bytes => slow.parts.push(bytes)); slow.client.resume()
  await until(() => slow.closed, '24 MiB slow response drains', 30_000)
  const response = slow.bytes, end = response.indexOf('\r\n\r\n') + 4
  assert.equal(response.length - end, LARGE)
  assert.equal(createHash('sha256').update(response.subarray(end)).digest('hex'), createHash('sha256').update(Buffer.alloc(LARGE, 0x6a)).digest('hex'))
  await events()
  console.log('ok authenticated application WS/HMR, SSE and >old-HTTP-limit stream with slow-consumer backpressure')

  if (guestGate && hostGate) {
    const identity = live.child.pid, capability = appCfg.token
    const sameListener = () => {
      assert.equal(live.exit, null, 'the guest helper stays running throughout recovery')
      assert.equal(live.child.pid, identity)
      assert.equal(live.port, port)
      assert.equal(appCfg.token, capability)
      assert.deepEqual(live.rows.filter(row => row.state === 'ready'), [{ state: 'ready', port }])
    }
    for (const [side, gate] of [['guest', guestGate], ['host', hostGate]]) {
      const marker = randomBytes(8).toString('hex'), path = `/hold?outage=${side}-${marker}`, body = `state=${marker}&code=once`
      const matching = () => appRequests.filter(row => row.method === 'POST' && row.url === path)
      const oldWS = await openAppWS()
      await appEcho(oldWS, `${side}: before outage`)
      const held = await wire(port)
      held.client.write(`POST ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
      await until(() => matching().length === 1, `${side} POST fully received before outage`)
      assert.equal(matching()[0].body, Buffer.from(body).toString('base64'))
      assert.ok(gate.active.size >= 4, 'both POST and app WS use the selected network leg')
      gate.down()
      await until(() => gate.active.size === 0, `${side} gate destroys both socket legs`)
      await until(() => held.closed, `${side} outage fails the in-flight POST`)
      await until(() => oldWS.state.closed !== undefined, `${side} outage closes the old application WS`)
      assert.equal(held.bytes.length, 0, 'no fabricated response and no old TCP continuation')
      assert.equal(matching().length, 1)
      const refused = gate.refused, blockedPath = `/offline-${side}-${marker}`
      const blocked = await wire(port)
      blocked.client.write(`GET ${blockedPath} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`)
      // A host-side failure before pairing uses the existing 10 s setup budget.
      await until(() => blocked.closed && gate.refused > refused, `${side} rejects a new connection while offline`, 15_000)
      assert.equal(blocked.bytes.length, 0)
      assert.ok(!appRequests.some(row => row.url === blockedPath))
      assert.equal(matching().length, 1)
      sameListener()
      gate.up()
      const recovered = await request(port, `/recovered-${side}-${marker}`, { host: 'localhost' })
      assert.equal(recovered.status, 200)
      assert.equal(JSON.parse(recovered.body).url, `/recovered-${side}-${marker}`)
      const newWS = await openAppWS()
      await appEcho(newWS, `${side}: new HMR connection`)
      await appEcho(newWS, Buffer.from([0, 255, 128]), true)
      newWS.socket.close(); await until(() => newWS.state.closed !== undefined, `${side} recovered WS closes`)
      await events()
      sameListener()
      assert.equal(oldWS.state.messages.length, 1, 'the dead application WS was not resumed')
      assert.ok(!appRequests.some(row => row.url === blockedPath), 'the refused connection was not replayed after recovery')
      assert.equal(matching().length, 1, 'recovery must not replay the accepted POST')
      console.log(`ok ${side} relay outage/refusal -> same localhost listener/cap recovers HTTP, app WS/HMR and SSE; old POST exactly once`)
    }
    const surviving = await openAppWS()
    await appEcho(surviving, 'before control-stream outage')
    stream.request.destroy()
    await until(() => stream.closed, 'host control stream disconnected')
    await appEcho(surviving, 'data still works without the host control stream')
    const before = seenTCP.length, blockedPath = `/control-offline-${randomBytes(8).toString('hex')}`
    const blocked = await wire(port)
    blocked.client.write(`GET ${blockedPath} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`)
    await until(() => blocked.closed, 'new TCP channel fails while control stream is offline', 15_000)
    assert.equal(blocked.bytes.length, 0)
    assert.ok(!appRequests.some(row => row.url === blockedPath))
    assert.equal(seenTCP.length, before)
    await appEcho(surviving, 'old data channel still works after failed new connection')
    // This driver resubscribes explicitly; the plugin's automatic retry has its own UI-fixture regression.
    stream = await subscribe()
    assert.equal((await request(port, '/control-recovered')).status, 200)
    assert.ok(seenTCP.length > before)
    await appEcho(surviving, 'same data channel after control resubscription')
    surviving.socket.close(); await until(() => surviving.state.closed !== undefined, 'surviving WS closes')
    sameListener()
    console.log('ok host control-stream outage preserves paired data; explicit resubscription restores new channels without renewing the cap')
  } else console.log('SKIP relay outage injection: requires a loopback HTTP room; other transport checks still run')

  const expStates = [], expPort = await freePort()
  const expiring = await helper.start({ ...appCfg, port: expPort, strict: true, expiresAt: Date.now() + 500 }, { emit: row => expStates.push(row) })
  running.add(expiring)
  const expWire = await wire(expPort); expWire.client.write(`GET /hold HTTP/1.1\r\nHost: localhost:${expPort}\r\n\r\n`)
  await until(() => appRequests.at(-1)?.url === '/hold', 'active expiry channel')
  await until(() => expStates.some(row => row.state === 'expired'), 'cap expiry closes listener')
  await until(() => expWire.closed, 'expiry closes old TCP')
  assert.equal(expWire.bytes.length, 0, 'no fabricated HTTP reconnect page')
  await expiring.close(); running.delete(expiring)
  const rebound = await ready({ ...appCfg, port: expPort, strict: true }); await stop(rebound)
  async function denied(cfg) {
    const states = [], deniedRun = await helper.start({ ...cfg, port: await freePort(), strict: true }, { emit: row => states.push(row) })
    running.add(deniedRun)
    const deniedWire = await wire(deniedRun.port); deniedWire.client.end('must never reach an app')
    await until(() => deniedWire.closed, 'denied cap TCP destroyed')
    assert.equal(deniedWire.bytes.length, 0)
    assert.ok(states.some(row => row.state === 'error' && row.code === 'AUTH'), JSON.stringify(states))
    assert.ok(!JSON.stringify(states).includes(cfg.token))
    await deniedRun.close(); running.delete(deniedRun)
  }
  const appCount = appRequests.length
  await denied({ ...appCfg, token: guest.token })
  await denied({ ...appCfg, url: echoCfg.url })
  const otherRoom = await api('/api/rooms', null, { name: 'Other' })
  await denied({ ...appCfg, url: appCfg.url.replace(room.id, otherRoom.id) })
  assert.equal(appRequests.length, appCount, 'room member tokens and wrong-pid/room caps cannot open a tunnel')
  const stopWire = await wire(port); stopWire.client.write(`GET /hold HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`)
  await until(() => appRequests.length === appCount + 1, 'active stop channel')
  await api(`${base}/previews/${appPid}/end`, room.token)
  await until(() => stopWire.closed, 'server Stop revokes active channel')
  const leaveWire = await wire(raw.port); leaveWire.client.write('before leaving')
  await until(() => leaveWire.bytes.length, 'active leave channel')
  await api(`${base}/leave`, guest.token)
  await until(() => leaveWire.closed, 'server Leave revokes active cap/channel')
  await stop(raw); await stop(live)
  const finalGuest = await api(`${base}/join`, null, { name: 'Last guest' })
  const finalRun = await ready(await grant(echoPid, finalGuest.token))
  const finalWire = await wire(finalRun.port); finalWire.client.write('before room End')
  await until(() => finalWire.bytes.length, 'active room End channel')
  await api(`${base}/end`, room.token)
  await until(() => finalWire.closed, 'server End revokes active channel')
  await stop(finalRun)
  await api(`/api/rooms/${otherRoom.id}/end`, otherRoom.token)
  await until(() => hostLogs.every(log => log.exit), 'all per-socket host helpers stopped')
  for (const gate of [guestGate, hostGate].filter(Boolean)) {
    await until(() => gate.active.size === 0, 'fault gate released both socket legs')
    await close(gate.server)
    const rebound = track(net.createServer()); await listen(rebound, '127.0.0.1', gate.port); await close(rebound)
  }
  assert.ok(seenTCP.length > 10, 'tests exercised real per-socket host notifications')
  assert.ok(hostLogs.every(log => !log.stdout.includes(room.token) && !log.stderr.includes(room.token)))
  console.log('ok expiry/cancel/rebind, no fabricated HTTP, capability pid/room/purpose isolation, active Stop/Leave cleanup and no secret leaks')
}

try {
  await parserChecks()
  await publicRelayChecks()
  await bridgeChecks()
  await listenerChecks()
  if (!process.argv.includes('--helpers-only')) await realChain()
  console.log(process.argv.includes('--helpers-only') ? 'Helper-only tests passed (real server deliberately not exercised).' : 'All local preview TCP tests passed.')
} finally {
  for (const request of requests) request.destroy()
  for (const websocket of websockets) websocket.close(1001)
  await Promise.all([...running].map(helper => helper.close()))
  for (const socket of sockets) socket.destroy()
  for (const child of children) child.kill('SIGTERM')
  await Promise.all([...servers].map(close))
  await Promise.all([...children].map(child => child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve()))
  await rm(scratch, { recursive: true, force: true })
}
