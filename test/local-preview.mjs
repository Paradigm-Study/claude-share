// Standalone Node 20+ checks: no models, deps, OAuth or saved room data.
//   node test/local-preview.mjs                 (real Room + Node + both helpers)
//   node test/local-preview.mjs --helpers-only (parser/listener checks only)
//   EXTERNAL_SERVER=1 SHARE_SERVER=http://127.0.0.1:8787 node test/local-preview.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { randomBytes, createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import helper from '../plugin/relay/local-preview.cjs'
import wsHelper from '../plugin/relay/ws-relay.cjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const GUEST = fileURLToPath(new URL('../plugin/relay/local-preview.cjs', import.meta.url))
const HOST = fileURLToPath(new URL('../plugin/relay/tcp-worker.cjs', import.meta.url))
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
async function startupError(cfg, code, file = GUEST) {
  const log = launch(file, cfg)
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
async function worker(room, token = CAP) {
  const controlToken = randomBytes(32).toString('hex')
  const log = launch(HOST, { room, token, controlToken, version: VERSION })
  await until(() => log.rows.length || log.exit, 'host worker ready')
  assert.equal(log.rows[0]?.state, 'ready', JSON.stringify(log.rows))
  log.port = log.rows[0].port
  log.controlToken = controlToken
  return log
}
function ipc(log, command, options = {}) {
  return request(log.port, options.path ?? '/', { method: options.method ?? 'POST', body: options.body ?? JSON.stringify(command), headers: { host: `127.0.0.1:${log.port}`, authorization: `Bearer ${log.controlToken}`, 'content-type': 'application/json', ...options.headers } })
}
async function rss(log) {
  const { stdout } = await promisify(execFile)('ps', ['-o', 'rss=', '-p', String(log.child.pid)])
  return Number(stdout.trim()) * 1024
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
  async function rejected(run, code, options, status) {
    attack = run
    let ended, reportedStatus
    connect(url, {}, { close: (c, s) => { ended = c; reportedStatus = s } }, options)
    await until(() => ended !== undefined, `WS rejected ${code}`)
    assert.equal(ended, code)
    assert.equal(reportedStatus, status)
  }
  for (const [status, code] of [[401, 1008], [403, 1008], [429, 1013], [500, 1011]]) await rejected((_req, s) => s.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`), code, undefined, status)
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
    assert.ok(states.some(row => row.state === 'channel-error' && row.code === 'PROTOCOL'), JSON.stringify(states))
    await listener.close(); running.delete(listener)
  }
  // A policy close is not proof of bad credentials; only HTTP 401/403 is.
  for (const [code, expected] of [[1008, 'CONNECT'], [1013, 'BUSY']]) {
    const states = []
    attack = socket => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(code); socket.end(Buffer.concat([ready, frame(8, bytes)])) }
    const listener = await helper.start({ ...dummy(await freePort()), url }, { emit: row => states.push(row) })
    running.add(listener)
    const client = await wire(listener.port)
    await until(() => client.closed, `policy close ${code}`)
    assert.ok(states.some(row => row.state === 'channel-error' && row.code === expected), JSON.stringify(states))
    assert.ok(!states.some(row => row.state === 'error' || row.code === 'AUTH'))
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
  assert.ok(!noCredit && states.every(row => ['ready', 'channel-ready'].includes(row.state)))
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

async function workerChecks() {
  const notices = [], upgrades = [], peers = new Map(), localSockets = new Set()
  let holdRejects = false
  const fixture = track(http.createServer((req, res) => {
    const chunks = []
    req.on('data', data => chunks.push(data))
    req.on('end', () => {
      notices.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) })
      if (!holdRejects) res.end('{}')
    })
  }))
  fixture.on('upgrade', (req, socket, head) => {
    upgrades.push({ path: req.url, headers: req.headers })
    peers.set(req.url, socket)
    socket.once('close', () => { if (peers.get(req.url) === socket) peers.delete(req.url) })
    handshake(req, socket)
    readFrames(socket, head, (op, payload) => { if (op === 8) socket.end(frame(8, payload)) })
    // Half are paired, half wait: both kinds count against the worker's cap.
    if (Number(req.url.split('/').at(-1).slice(2)) < 32) socket.write(frame(1, '{"t":"ready"}'))
  })
  const room = `http://127.0.0.1:${await listen(fixture)}/api/rooms/${ROOM}`
  const controlToken = randomBytes(32).toString('hex'), cfg = { room, token: CAP, controlToken, version: VERSION }
  for (const bad of ['{bad', 'x'.repeat(20_000), { ...cfg, extra: 1 }, { ...cfg, token: 'bad' }, { ...cfg, controlToken: CAP }, { ...cfg, token: controlToken }, { ...cfg, controlToken: 'x'.repeat(42) }, { ...cfg, room: room + '/' }, { ...cfg, room: room + '?x=1' }, { ...cfg, room: room.replace('http:', 'ws:') }, { ...cfg, room: room.replace('127.0.0.1', 'other.test') }, { ...cfg, room: room.replace('/api/', '/a/../api/') }, { ...cfg, room: room.replace('http://', 'http://user:pass@') }]) await startupError(bad, 'INVALID_CONFIG', HOST)
  const host = await worker(room), row = { op: 'open', id: 'CH0000000000', pid: 'pv1', port: await freePort() }
  for (const [options, status] of [[{ headers: { authorization: '' } }, 401], [{ headers: { authorization: `Bearer ${CAP}` } }, 401], [{ headers: { host: `localhost:${host.port}` } }, 403], [{ headers: { origin: '' } }, 403], [{ headers: { origin: 'https://elsewhere.test' } }, 403], [{ method: 'PUT' }, 400], [{ path: '/open' }, 400], [{ headers: { 'content-type': 'text/plain' } }, 400], [{ body: 'x'.repeat(4097) }, 400], [{ body: 'x'.repeat(4097), headers: { 'transfer-encoding': 'chunked' } }, 400], [{ body: '{bad' }, 400], [{ body: Buffer.from([255]) }, 400]]) assert.equal((await ipc(host, row, options)).status, status)
  for (const bad of [null, [], {}, { ...row, id: '../not-an-id' }, { ...row, pid: '' }, { ...row, pid: 'a'.repeat(65) }, { ...row, port: '123' }, { ...row, port: 0 }, { ...row, port: 65536 }, { ...row, token: CAP }, { ...row, url: room }, { op: 'close-preview' }, { op: 'close-preview', pid: 'pv1', port: 1 }, { op: 'reject', id: row.id, code: 'AUTH' }, { op: 'reject', id: row.id, code: 'CONNECT', url: room }]) assert.equal((await ipc(host, bad)).status, 400)
  assert.equal(upgrades.length, 0, 'invalid commands never reach a target')
  const check = await ipc(host, { op: 'close-preview', pid: 'pv1' })
  assert.equal(check.status, 200)
  assert.equal(check.headers.connection, 'close')
  assert.deepEqual(JSON.parse(check.body), { ok: true })
  // Unfinished headers and bodies share the same eight-socket hard deadline.
  const stalled = []
  for (let i = 0; i < 8; i++) {
    const connection = await wire(host.port)
    connection.client.write(i < 4 ? 'POST / HTTP/1.1\r\n' : `POST / HTTP/1.1\r\nHost: 127.0.0.1:${host.port}\r\nAuthorization: Bearer ${host.controlToken}\r\nContent-Type: application/json\r\nContent-Length: 99\r\n\r\n{`)
    stalled.push(connection)
  }
  const excessControl = await wire(host.port)
  await until(() => excessControl.closed, 'ninth control socket refused')
  assert.ok(stalled.every(s => !s.closed))
  await until(() => stalled.every(s => s.closed), 'slow headers/bodies time out', 3500)
  assert.equal((await ipc(host, { op: 'close-preview', pid: 'pv1' })).status, 200)
  const oversizedHeader = await wire(host.port)
  oversizedHeader.client.write(`POST / HTTP/1.1\r\nX-Large: ${'a'.repeat(9000)}\r\n\r\n`)
  await until(() => oversizedHeader.closed, 'oversized control headers refused')
  assert.match(oversizedHeader.bytes.toString(), /^HTTP\/1\.1 400/)

  const missing = 'MISSING00000', began = Date.now()
  assert.equal((await ipc(host, { ...row, id: missing })).status, 200, 'open accepts before localhost connects')
  await until(() => host.rows.some(r => r.state === 'closed' && r.id === missing), 'failed local TCP releases reservation')
  await until(() => notices.some(r => r.path === `/api/rooms/${ROOM}/ws/${missing}/reject`), 'failed TCP rejects pending remote channel')
  assert.ok(Date.now() - began < 2000, 'local failure does not wait for the pairing deadline')
  assert.ok(!upgrades.some(r => r.path.endsWith(missing)), 'never fake-pair before localhost connects')
  assert.deepEqual(host.rows.find(r => r.id === missing), { state: 'closed', id: missing, code: 'CONNECT' })
  assert.deepEqual(notices.at(-1).body, { code: 'CONNECT' })
  assert.equal(notices.at(-1).headers.authorization, `Bearer ${CAP}`)
  assert.equal(notices.at(-1).headers['x-shared-session-version'], VERSION)

  holdRejects = true
  const beforeRejects = notices.length
  for (let i = 0; i < 80; i++) assert.equal((await ipc(host, { op: 'reject', id: `RJ${String(i).padStart(10, '0')}`, code: 'BUSY' })).status, 200)
  await until(() => notices.length >= beforeRejects + 64, 'reject notification bound exercised')
  assert.equal(notices.length, beforeRejects + 64, 'no unbounded reject queue')
  await pause(2100)
  holdRejects = false
  assert.equal((await ipc(host, { op: 'reject', id: 'REJECTAGAIN', code: 'CONNECT' })).status, 200)
  await until(() => notices.at(-1).path.endsWith('/REJECTAGAIN/reject'), 'reject slots recover after timeout')
  assert.equal(notices.length, beforeRejects + 65, 'rejects are never retried')

  const target = track(net.createServer({ allowHalfOpen: true }, socket => { localSockets.add(socket); socket.once('close', () => localSockets.delete(socket)); socket.on('end', () => socket.end()) }))
  const targetPort = await listen(target), commands = Array.from({ length: 64 }, (_, i) => ({ op: 'open', id: `CH${String(i).padStart(10, '0')}`, pid: i % 2 ? PID : 'pv1', port: targetPort }))
  for (const command of commands) assert.equal((await ipc(host, command)).status, 200)
  await until(() => peers.size === 64 && localSockets.size === 64, '64 active + connecting host relays')
  assert.equal((await ipc(host, { ...commands[0], pid: PID, port: 1 })).status, 200, 'duplicate id is idempotent even while full')
  await pause(30)
  assert.equal(localSockets.size, 64)
  assert.equal(upgrades.length, 64)
  const extra = await ipc(host, { ...commands[0], id: 'OVERFLOW0000' })
  assert.equal(extra.status, 429)
  assert.deepEqual(JSON.parse(extra.body), { ok: false, code: 'BUSY' })
  await until(() => notices.some(r => r.path.endsWith('/OVERFLOW0000/reject') && r.body.code === 'BUSY'), 'full worker rejects pending room channel')
  assert.equal(localSockets.size, 64, 'full worker creates no local peer')
  assert.equal((await ipc(host, { op: 'close-preview', pid: 'pv1' })).status, 200)
  const closed = id => host.rows.filter(r => r.state === 'closed' && r.id === id)
  await until(() => commands.filter(c => c.pid === 'pv1').every(c => closed(c.id).length === 1), 'only selected preview releases')
  assert.ok(commands.filter(c => c.pid === PID).every(c => closed(c.id).length === 0), 'other preview is untouched')
  assert.equal((await ipc(host, commands[0])).status, 200, 'a released id can be admitted afresh')
  await until(() => localSockets.size === 33, 'released worker capacity reused')
  await stop(host)
  assert.equal(closed(commands[0].id).length, 2)
  assert.ok(commands.slice(1).every(c => closed(c.id).length === 1), 'shutdown closes each admitted peer exactly once')
  await until(() => localSockets.size === 0 && peers.size === 0, 'worker shutdown owns all TCP/WS sockets')
  const rebound = track(net.createServer()); await listen(rebound, '127.0.0.1', host.port); await close(rebound)
  assert.deepEqual(host.rows.filter(r => r.state === 'ready'), [{ state: 'ready', port: host.port }])
  assert.ok(!host.stdout.includes(host.controlToken) && !host.stdout.includes(CAP))
  console.log('ok production worker bootstrap/IPC auth/Host/Origin/schema/body/header/socket deadlines, duplicate ids, 64-peer cap, bounded rejects, setup failure, preview isolation and owned shutdown')
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

async function listenerCapacity() {
  let accepted = 0, paired = false
  const channels = []
  const fixture = track(http.createServer())
  fixture.on('upgrade', (req, socket, head) => {
    accepted++
    channels.push(socket)
    handshake(req, socket)
    readFrames(socket, head, (op, payload) => { if (op === 8) socket.end(frame(8, payload)) })
    if (paired) socket.write(frame(1, '{"t":"ready"}'))
  })
  const url = `http://127.0.0.1:${await listen(fixture)}/api/rooms/${ROOM}/previews/${PID}/tunnel`
  for (paired of [false, true]) {
    const states = [], clients = [], before = accepted
    const listener = await helper.start({ ...dummy(await freePort()), url }, { emit: row => states.push(row) })
    running.add(listener)
    for (let i = 0; i < 32; i++) clients.push(await wire(listener.port, ipv6 && i % 2 ? '::1' : '127.0.0.1'))
    await until(() => accepted === before + 32, '32 accepted/pending channels across both families')
    const extra = await wire(listener.port)
    await until(() => extra.closed, '33rd guest socket fails alone')
    assert.equal(extra.bytes.length, 0, 'BUSY never fabricates an HTTP reply')
    assert.ok(states.some(row => row.state === 'channel-error' && row.code === 'BUSY'))
    assert.ok(!states.some(row => row.state === 'error' || row.state === 'expired'))
    assert.ok(clients.every(client => !client.closed), 'capacity never tears down old channels')
    assert.equal(accepted, before + 32, 'over-capacity guest never opens a room WS')
    channels[before].end(frame(8, Buffer.from([3, 240])))
    await until(() => clients[0].closed, 'guest slot closed')
    const again = await wire(listener.port)
    await until(() => accepted === before + 33, 'guest slot reusable without listener restart')
    assert.equal(states.filter(row => row.state === 'ready').length, 1)
    const beforeCancel = states.length
    await listener.close(); running.delete(listener)
    await until(() => [...clients, again].every(c => c.closed), 'guest cancellation closes owned sockets')
    assert.equal(states.length, beforeCancel, 'cancellation is quiet')
  }
  console.log('ok guest 32-socket accepted/pending dual-family cap, per-channel BUSY, capacity reuse and quiet cancellation')
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
  const seenTCP = [], hostLogs = [], sharedPorts = new Map(), commandFailures = []
  let hostWorker, startingWorker, hostControl = Promise.resolve()
  async function ensureWorker() {
    if (hostWorker && !hostWorker.exit) return hostWorker
    startingWorker ??= worker(`${hostOrigin}${base}`, room.token).then(log => { hostWorker = log; hostLogs.push(log); return log }).finally(() => { startingWorker = undefined })
    return startingWorker
  }
  function openHost(ask) {
    hostControl = hostControl.then(async () => {
      assert.match(ask.id, /^[A-Za-z0-9_-]{8,40}$/)
      assert.equal(sharedPorts.get(ask.port), ask.pid, 'driver rechecks authorized port/pid')
      const host = await ensureWorker()
      assert.equal((await ipc(host, { op: 'open', id: ask.id, pid: ask.pid, port: ask.port })).status, 200)
      host.ids ??= new Set()
      host.ids.add(ask.id)
    }).catch(error => { commandFailures.push(error) })
    return hostControl
  }
  const activeHost = () => (hostWorker.ids?.size ?? 0) - hostWorker.rows.filter(row => row.state === 'closed').length
  await ensureWorker()
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
          void openHost(row.tcp)
        }
      })
      res.on('error', () => {})
    })
    await until(() => state.ready || state.closed, 'host TCP-capable control stream')
    assert.equal(state.ready, true)
    return { request: req, get closed() { return state.closed } }
  }
  let stream = await subscribe()
  async function share(port) {
    const pid = (await api(`${base}/previews`, room.token, { port, tcp: true })).pid
    sharedPorts.set(port, pid)
    return pid
  }
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

  const appRequests = [], upgrades = [], largeResponses = [], LARGE = 24 * 1024 * 1024 + 11, chunk = Buffer.alloc(65536, 0x6a)
  let largeWritten = 0
  const app = track(http.createServer(async (req, res) => {
    const parts = []; for await (const bytes of req) parts.push(bytes)
    const body = Buffer.concat(parts), seen = { method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: body.toString('base64') }
    appRequests.push(seen)
    const url = new URL(req.url, 'http://fixture.test')
    if (url.pathname === '/drop') return req.socket.destroy()
    if (url.pathname === '/hold') { req.socket.once('end', () => req.socket.destroy()); return }
    if (url.pathname === '/binary') { res.writeHead(200, { 'content-length': body.length, 'set-cookie': ['one=1', 'two=2', 'cs_pv=app-owned'], 'x-keep': 'unchanged' }); return res.end(body) }
    if (url.pathname === '/redirect') { res.writeHead(302, { location: url.searchParams.get('to'), 'set-cookie': 'state=A; Path=/; HttpOnly; SameSite=Lax' }); return res.end() }
    if (url.pathname.startsWith('/status/')) { res.writeHead(Number(url.pathname.split('/').at(-1))); return res.end('app response') }
    if (url.pathname === '/large') {
      const response = { path: req.url, written: 0 }
      largeResponses.push(response)
      res.writeHead(200, { 'content-length': LARGE })
      try {
        for (let at = 0; at < LARGE && !res.destroyed; at += chunk.length) {
          const b = chunk.subarray(0, Math.min(chunk.length, LARGE - at))
          largeWritten += b.length; response.written += b.length
          if (!res.write(b)) await new Promise(resolve => {
            const done = () => { res.removeListener('drain', done); res.removeListener('close', done); resolve() }
            res.once('drain', done); res.once('close', done)
          })
        }
        res.end()
      } catch {}
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
  async function openAppWS(localPort = port) {
    const state = { opened: false, closed: undefined, messages: [] }
    const socket = connect(`ws://localhost:${localPort}/ws`, browserHeaders, { open: () => (state.opened = true), message: (data, binary) => state.messages.push({ data, binary }), close: code => (state.closed = code) })
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

  const unavailablePort = await freePort(), unavailablePid = await share(unavailablePort)
  const unavailable = await ready({ ...await grant(unavailablePid), port: await freePort(), strict: true })
  const refusedAt = Date.now(), unavailableWire = await wire(unavailable.port)
  unavailableWire.client.end('not paired')
  await until(() => unavailableWire.closed, 'host localhost failure rejects pending channel promptly', 3000)
  assert.ok(Date.now() - refusedAt < 3000)
  assert.equal(unavailableWire.bytes.length, 0)
  assert.ok(unavailable.rows.some(row => row.state === 'channel-error' && row.code === 'CONNECT'))
  assert.ok(!unavailable.rows.some(row => row.state === 'error' || row.state === 'expired'))
  const nowAvailable = track(net.createServer({ allowHalfOpen: true }, socket => { socket.on('data', bytes => socket.write(bytes)); socket.on('end', () => socket.end()) }))
  await listen(nowAvailable, '127.0.0.1', unavailablePort)
  const retried = await wire(unavailable.port); retried.client.end('a new independent request')
  await until(() => retried.closed, 'same listener works after localhost becomes available')
  assert.equal(retried.bytes.toString(), 'a new independent request')
  assert.equal(unavailable.rows.filter(row => row.state === 'ready').length, 1)
  assert.ok(unavailable.rows.some(row => row.state === 'channel-ready'))
  await stop(unavailable)
  await api(`${base}/previews/${unavailablePid}/end`, room.token)

  const oneWorker = hostWorker.child.pid, halfTargets = [], halfClients = []
  const halfApp = track(net.createServer({ allowHalfOpen: true }, socket => {
    const state = { socket, data: [], ended: false }
    halfTargets.push(state)
    socket.on('data', bytes => state.data.push(bytes))
    socket.on('end', () => { state.ended = true }) // Keep the response half open.
  }))
  const halfPid = await share(await listen(halfApp)), halfRun = await ready(await grant(halfPid))
  for (let i = 0; i < 6; i++) { const client = await wire(halfRun.port); client.client.end(`half-${i}`); halfClients.push(client) }
  await until(() => halfTargets.length === 6 && halfTargets.every(s => s.ended), 'six held half-closes reached app unchanged')
  assert.ok(halfClients.every(client => !client.closed && !client.ended))
  const longWS = await openAppWS(), heldParallel = []
  await appEcho(longWS, 'seven active streams including six half-closes')
  for (let i = 0; i < 8; i++) {
    const held = await wire(port)
    held.client.write(`GET /hold?parallel=${i} HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`)
    heldParallel.push(held)
    await until(() => appRequests.some(r => r.url === `/hold?parallel=${i}`), `held parallel ${i}`)
    if (i === 0) assert.equal((await request(port, '/ninth-stream')).status, 200, 'ninth stream works with eight already held')
  }
  assert.equal((await request(port, '/sixteenth-stream')).status, 200, 'sixteenth stream works with fifteen already held')
  assert.ok(activeHost() >= 15)
  assert.equal(hostWorker.child.pid, oneWorker)
  assert.equal(hostLogs.length, 1, 'one host process serves every socket')
  await appEcho(longWS, 'same WS survives the ninth and sixteenth channels')
  for (const target of halfTargets) target.socket.end(Buffer.concat(target.data))
  await until(() => halfClients.every(client => client.closed), 'held response halves finish normally')
  assert.deepEqual(halfClients.map(client => client.bytes.toString()), Array.from({ length: 6 }, (_, i) => `half-${i}`))
  for (const client of heldParallel) client.client.destroy()
  longWS.socket.close()
  await stop(halfRun)
  await api(`${base}/previews/${halfPid}/end`, room.token)
  await until(() => activeHost() === 0, 'parallel channels release all worker slots')
  console.log('ok one production worker: six held half-closes + long-lived app WS, ninth/sixteenth streams, normal FIN and capacity release')

  const guest2 = await api(`${base}/join`, null, { name: 'Guest two' }), guest3 = await api(`${base}/join`, null, { name: 'Guest three' })
  const second = await ready(await grant(appPid, guest2.token)), third = await ready(await grant(echoPid, guest3.token))
  const peerWS = await openAppWS(second.port), keptWS = await openAppWS()
  await appEcho(peerWS, 'another guest, same preview')
  const anotherPreview = await wire(third.port); anotherPreview.client.end('third guest, other preview')
  await until(() => anotherPreview.closed, 'another preview is isolated')
  assert.equal(anotherPreview.bytes.subarray(0, -5).toString(), 'third guest, other preview')
  const heldCapacity = []
  for (let i = 0; i < 31; i++) {
    const held = await wire(port)
    held.client.write(`GET /hold?capacity=${i} HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`)
    heldCapacity.push(held)
  }
  await until(() => appRequests.filter(r => r.url.startsWith('/hold?capacity=')).length === 31, '32 channels admitted for one guest')
  const localFull = await wire(port)
  await until(() => localFull.closed, 'local guest capacity fails only new connection')
  assert.equal(localFull.bytes.length, 0)
  assert.ok(live.rows.some(row => row.state === 'channel-error' && row.code === 'BUSY'))
  // A second listener bypasses the local 32 socket cap, not the seat's quota.
  const overflow = await ready(await grant(appPid))
  const seatFull = await wire(overflow.port)
  await until(() => seatFull.closed, 'room seat capacity returns BUSY')
  assert.equal(seatFull.bytes.length, 0)
  assert.ok(overflow.rows.some(row => row.state === 'channel-error' && row.code === 'BUSY'), JSON.stringify(overflow.rows))
  assert.ok(!overflow.rows.some(row => row.state === 'error' || row.state === 'expired' || row.code === 'AUTH'))
  await appEcho(keptWS, 'old WS still alive when this guest is full')
  await appEcho(peerWS, 'other guest is unaffected by capacity')
  assert.equal((await request(second.port, '/guest-two', { headers: { cookie: 'guest=two' } })).status, 200)
  const beforeRelease = activeHost()
  heldCapacity[0].client.destroy()
  await until(() => activeHost() < beforeRelease, 'one full-seat channel released')
  assert.equal((await request(overflow.port, '/after-capacity-release')).status, 200, 'same listener and grant recover when a slot frees')
  assert.equal(overflow.rows.filter(row => row.state === 'ready').length, 1)
  assert.ok(overflow.rows.some(row => row.state === 'channel-ready'))
  await appEcho(keptWS, 'same WS after capacity release')
  for (const held of heldCapacity) held.client.destroy()
  keptWS.socket.close(); peerWS.socket.close()
  await stop(overflow); await stop(second); await stop(third)
  await api(`${base}/leave`, guest2.token); await api(`${base}/leave`, guest3.token)
  await until(() => activeHost() === 0, 'multi-guest capacity test releases channels')
  console.log('ok three guests/two previews isolated; 32-seat/local capacity is BUSY not AUTH, old WS survives and listeners recover after release')

  const pressureWS = await openAppWS(), pressure = [], memory = [await rss(hostWorker)]
  for (let i = 0; i < 8; i++) {
    const client = await wire(port, '127.0.0.1', false)
    client.client.pause()
    client.client.write(`GET /large?pressure=${i} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`)
    pressure.push(client)
  }
  await until(() => largeResponses.filter(r => r.path.includes('pressure=')).length === 8, 'eight non-reading consumers start')
  for (let i = 0; i < 4; i++) { await pause(100); memory.push(await rss(hostWorker)) }
  const growing = largeResponses.filter(r => r.path.includes('pressure='))
  assert.ok(growing.every(r => r.written < LARGE), 'credit + TCP backpressure bounds every non-reading flow')
  // This is an observed RSS bound with headroom for Node, TLS and allocator
  // retention, not a claim that the protocol's 32 MiB credit sum is an RSS cap.
  assert.ok(Math.max(...memory) - memory[0] < 128 * 1024 * 1024, `bounded worker RSS growth: ${Math.max(...memory) - memory[0]}`)
  await appEcho(pressureWS, 'unrelated WS works while consumers do not read')
  for (const client of pressure) client.client.destroy()
  pressureWS.socket.close()
  await until(() => activeHost() === 0, 'non-reading flows release bounded queues', 10_000)
  assert.equal((await request(port, '/after-pressure')).status, 200)
  console.log('ok non-reading peers bound upstream queues and sampled worker RSS; unrelated WS and new connections remain usable')

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

  await until(() => activeHost() === 0, 'old data channels ended before worker crash test')
  const crashedWorker = hostWorker, oldWS = await openAppWS(), crashPath = `/hold?worker-crash=${randomBytes(8).toString('hex')}`
  await appEcho(oldWS, 'before host worker crash')
  const crashPost = await wire(port)
  crashPost.client.write(`POST ${crashPath} HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Length: 4\r\n\r\nonce`)
  await until(() => appRequests.some(row => row.url === crashPath), 'POST accepted before worker crash')
  await hostControl
  crashedWorker.child.kill('SIGKILL')
  await until(() => crashedWorker.exit, 'host worker crashes')
  await until(() => crashPost.closed && oldWS.state.closed !== undefined, 'crash fails only old TCP streams')
  assert.equal(crashPost.bytes.length, 0)
  await pause(100)
  assert.equal(hostLogs.length, 1, 'idle crash never restarts or replays old opens')
  assert.equal((await request(port, '/worker-restarted-by-new-request')).status, 200)
  assert.equal(hostLogs.length, 2, 'only a new independent request starts a replacement worker')
  assert.notEqual(hostWorker.child.pid, crashedWorker.child.pid)
  assert.notEqual(hostWorker.controlToken, crashedWorker.controlToken)
  const newWS = await openAppWS()
  await appEcho(newWS, 'fresh WS after worker restart')
  newWS.socket.close()
  await pause(50)
  assert.equal(appRequests.filter(row => row.url === crashPath).length, 1, 'worker restart never replays an accepted POST')
  assert.equal(oldWS.state.messages.length, 1, 'old application WS is not resumed')
  assert.equal(live.rows.filter(row => row.state === 'ready').length, 1, 'guest listener survives worker restart')
  console.log('ok host worker crash fails old POST/WS without replay; only a new request starts one replacement worker')

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
    assert.ok(states.some(row => row.state === 'channel-error' && row.code === 'AUTH'), JSON.stringify(states))
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
  await hostControl
  assert.deepEqual(commandFailures, [], 'driver IPC commands all completed without replay')
  await stop(hostWorker)
  assert.equal(hostLogs.length, 2, 'one original worker and one intentional crash replacement')
  for (const log of hostLogs) {
    const closed = log.rows.filter(row => row.state === 'closed')
    assert.equal(new Set(closed.map(row => row.id)).size, closed.length, 'worker releases an id once')
    assert.ok(closed.every(row => log.ids.has(row.id)))
    assert.deepEqual(log.rows.filter(row => row.state === 'ready'), [{ state: 'ready', port: log.port }])
    assert.equal(log.stderr, '')
  }
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
  await listenerCapacity()
  await workerChecks()
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
