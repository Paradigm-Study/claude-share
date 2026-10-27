// Checks for the isolated preview browser's SOCKS5 proxy:
// no models, dependencies or outside connections. Names and interfaces are
// injected (one stdout check resolves a reserved .invalid name for real, and
// its DNS-over-HTTPS goes only to a local fixture upstream). The DoH checks
// make a test CA with openssl.
// Optional parts print SKIP with the reason.
//   npx vitest run test/browser-proxy.test.ts
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import { randomBytes, createHash } from 'node:crypto'
import https from 'node:https'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { afterAll, test } from 'vitest'
import * as proxy from '../plugin/relay/browser-proxy.mts'

const PROXY = fileURLToPath(new URL('../plugin/relay/browser-proxy.mts', import.meta.url))
const TOKEN = randomBytes(32).toString('base64url')
const FAST = { handshake: 300, firstConfig: 300, want: 300, wantEvery: 400, blockedEvery: 400, lanEvery: 400, lookup: 200, connect: 400, control: 2000, linger: 200 }
const BASE = { port: 0, controlToken: TOKEN, upstream: null }
// The hooks the checks hand proxy.start in place of Node's: a lookup as
// dns.lookup calls back, and the options connect is given (a lookup of its own
// when it pins the address). The DNS-over-HTTPS checks share a bag of
// fixtures and helpers (dohFixtures), read as each case needs it.
type LookupCallback = (error: NodeJS.ErrnoException | null, address?: any, family?: number) => void
type Lookup = (name: string, options: any, callback: LookupCallback) => void
type ConnectOptions = net.TcpNetConnectOpts & { lookup?: Lookup }
type DohCtx = Record<string, any>
// A proxy run in this process (proxy.start), with the rows it emitted after ready.
type Instance = Awaited<ReturnType<typeof proxy.start>> & { rows: any[] }
const children = new Set<ChildProcessWithoutNullStreams>(), servers = new Set<net.Server | https.Server>(), sockets = new Set<net.Socket>(), running = new Set<Instance>()

async function until(check: () => unknown, label?: string, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await pause(5) }
  throw new Error(`Timed out: ${label}`)
}
const listen = (server: net.Server | https.Server, host = '127.0.0.1', port = 0) => new Promise<number>((resolve, reject) => {
  server.once('error', reject)
  server.listen({ host, port, ipv6Only: host === '::1' }, () => { server.removeListener('error', reject); resolve((server.address() as AddressInfo).port) })
})
const close = (server: net.Server | https.Server) => new Promise<void>(resolve => server.listening ? server.close(() => resolve()) : resolve())
function track<S extends net.Server | https.Server>(server: S): S {
  servers.add(server)
  server.on('connection', (socket: net.Socket) => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)) })
  return server
}
const echoServer = () => track(net.createServer({ allowHalfOpen: true }, socket => { socket.on('data', bytes => socket.write(bytes)); socket.on('end', () => socket.end()) }))
async function deadPort() { const server = net.createServer(); const port = await listen(server); await close(server); return port }
async function rebinds(port: number) { const server = net.createServer(); await listen(server, '127.0.0.1', port); await close(server) }
// A client that never answers FIN by itself: half-close stays observable.
// A client socket and all it was sent (bytes), whether it ended or closed.
type Wire = { client: net.Socket, parts: Buffer[], size: number, ended: boolean, closed: boolean, readonly bytes: Buffer }
async function wire(port: number, host = '127.0.0.1'): Promise<Wire> {
  const client = net.createConnection({ host, port, allowHalfOpen: true })
  sockets.add(client)
  const result = { client, parts: [] as Buffer[], size: 0, ended: false, closed: false } as Wire
  Object.defineProperty(result, 'bytes', { get: () => Buffer.concat(result.parts) })
  client.on('data', bytes => { result.parts.push(bytes); result.size += bytes.length })
  client.on('error', () => {})
  client.on('end', () => { result.ended = true })
  client.on('close', () => { result.closed = true; sockets.delete(client) })
  await once(client, 'connect')
  return result
}

// The proxy as its own process: what it printed, its rows, how it ended, its ports once ready.
type Log = { child: ChildProcessWithoutNullStreams, stdout: string, stderr: string, rows: any[], exit: { code: number | null, signal: NodeJS.Signals | null } | null, port?: number, control?: number }
function launch(cfg: unknown): Log {
  const child = spawn(process.execPath, [PROXY], { stdio: ['pipe', 'pipe', 'pipe'] })
  const log: Log = { child, stdout: '', stderr: '', rows: [], exit: null }
  children.add(child)
  child.stdin.on('error', () => {})
  let input = ''
  child.stdout.on('data', bytes => {
    log.stdout += bytes
    input += bytes
    let at
    while ((at = input.indexOf('\n')) !== -1) {
      const line = input.slice(0, at); input = input.slice(at + 1)
      if (line.trim()) log.rows.push(JSON.parse(line))
    }
  })
  child.stderr.on('data', bytes => (log.stderr += bytes))
  child.once('exit', (code, signal) => { log.exit = { code, signal }; children.delete(child) })
  child.stdin.end(typeof cfg === 'string' ? cfg : JSON.stringify(cfg))
  return log
}
// Ready: the ports it said it listens on.
type Ready = Log & { port: number, control: number }
async function ready(cfg: unknown): Promise<Ready> {
  const log = launch(cfg)
  await until(() => log.rows.length || log.exit, 'proxy ready')
  assert.equal(log.rows[0]?.state, 'ready', JSON.stringify(log.rows) + log.stderr)
  log.port = log.rows[0].port
  log.control = log.rows[0].control
  return log as Ready
}
async function stop(log: Log) {
  if (!log.exit) log.child.kill('SIGTERM')
  await until(() => log.exit, 'proxy stopped')
  assert.equal(log.stderr, '')
  assert.equal(log.exit!.code, 0)
}
async function startupError(cfg: unknown, code: string) {
  const log = launch(cfg)
  await until(() => log.exit, `startup ${code}`)
  assert.deepEqual(log.rows, [{ state: 'error', code }], typeof cfg === 'string' ? cfg.slice(0, 80) : JSON.stringify(cfg))
  assert.notEqual(log.exit!.code, 0)
  assert.equal(log.stderr, '')
}
async function inProcess(hooks = {}, cfg = {}): Promise<Instance> {
  const rows: any[] = []
  // No DNS-over-HTTPS unless a check names its servers (dohChecks): never the real ones.
  const instance = await proxy.start({ ...BASE, ...cfg }, { timeouts: FAST, emit: row => rows.push(row), doh: [], ...hooks }) as Instance
  running.add(instance)
  assert.deepEqual(rows.shift(), { state: 'ready', port: instance.port, control: instance.control })
  instance.rows = rows
  return instance
}
async function shut(instance: Instance) { await instance.close(); running.delete(instance) }

// Raw control requests, so every header can be wrong on its own.
async function control(port: number, { method = 'POST', path = '/', host = `127.0.0.1:${port}` as string | null, auth = `Bearer ${TOKEN}` as string | null, type = 'application/json' as string | null, headers = '', body = '' as string | Buffer, chunked = false } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const lines = [`${method} ${path} HTTP/1.1`]
  if (host !== null) lines.push(`Host: ${host}`)
  if (auth !== null) lines.push(`Authorization: ${auth}`)
  if (type !== null) lines.push(`Content-Type: ${type}`)
  lines.push(chunked ? 'Transfer-Encoding: chunked' : `Content-Length: ${bytes.length}`)
  const head = Buffer.from(`${lines.join('\r\n')}\r\n${headers}\r\n`, 'latin1')
  const c = await wire(port)
  c.client.write(Buffer.concat([head, chunked ? Buffer.concat([Buffer.from(`${bytes.length.toString(16)}\r\n`), bytes, Buffer.from('\r\n0\r\n\r\n')]) : bytes]))
  await until(() => c.ended || c.closed, 'control response')
  c.client.destroy()
  const text = c.bytes.toString('latin1')
  return { status: Number(/^HTTP\/1\.1 ([0-9]{3})/.exec(text)?.[1]), text, body: text.slice(text.indexOf('\r\n\r\n') + 4) }
}
// routes: what each shared port forwards to, by port number.
const routesBody = (routes: unknown, startable: unknown[] = []) => JSON.stringify({ op: 'routes', routes, startable })
async function configure(instance: Instance, routes: unknown, startable: unknown[] = []) {
  const res = await control(instance.control, { body: routesBody(routes, startable) })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body, '{"ok":true}')
}

// Test-only SOCKS5 client bytes (hex IPv6 only), not another production parser.
const v6 = (text: string) => {
  const [head, tail] = text.split('::'), h = head ? head.split(':') : [], t = tail ? tail.split(':') : []
  const words = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  return words.flatMap(word => [parseInt(word, 16) >> 8, parseInt(word, 16) & 255])
}
// Where a SOCKS5 request asks to go: ATYP 1 (IPv4), 3 (a name) or 4 (IPv6);
// an Aim is one whose port a helper gives.
type Target = { atyp: number, host: string, port: number }
type Aim = { atyp: number, host: string, port?: number }
function socksRequest({ atyp, host, port }: Target) {
  const where = atyp === 1 ? host.split('.').map(Number) : atyp === 4 ? v6(host) : [host.length, ...Buffer.from(host, 'latin1')]
  return Buffer.from([5, 1, 0, atyp, ...where, port >> 8, port & 255])
}
async function socks(proxyPort: number, target: Target, { greeting = [5, 1, 0], bytewise = false, early = Buffer.alloc(0) } = {}) {
  const c = await wire(proxyPort)
  const bytes = Buffer.concat([Buffer.from(greeting), socksRequest(target), early])
  if (!bytewise) c.client.write(bytes)
  else {
    c.client.setNoDelay(true)
    for (const byte of bytes) { c.client.write(Buffer.from([byte])); await pause(3) }
  }
  return c
}
const reply = (rep: number) => [5, rep, 0, 1, 0, 0, 0, 0, 0, 0]
async function expectReply(c: Wire, rep: number, label = `SOCKS reply ${rep}`) {
  await until(() => c.bytes.length >= 12 || c.ended || c.closed, label)
  assert.deepEqual([...c.bytes.subarray(0, 12)], [5, 0, ...reply(rep)], label)
  if (!rep) return c
  await until(() => c.ended || c.closed, `${label}: a refusal ends the socket`)
  assert.equal(c.bytes.length, 12, `${label}: nothing follows a refusal`)
  c.client.end()
  return c
}
async function echoes(c: Wire, data = randomBytes(2048)) {
  const before = c.bytes.length
  c.client.write(data)
  await until(() => c.bytes.length >= before + data.length, 'echo through the proxy')
  assert.deepEqual(c.bytes.subarray(before, before + data.length), data)
}
const loopbackTo = (port: number): Target => ({ atyp: 3, host: 'localhost', port })
// An interface entry as os.networkInterfaces() gives it (address and cidr are what count).
// cidr as os.networkInterfaces() gives it, or not: the checks hand it what it must refuse too.
const iface = (address: string, cidr: any, internal = false) => ({ address, netmask: '', family: net.isIPv4(address) ? 'IPv4' : 'IPv6', mac: '00:00:00:00:00:00', internal, cidr })
// The address beside one (its last bit flipped), as a SOCKS target.
function neighborOf(address: string) {
  if (net.isIPv4(address)) { const b = address.split('.').map(Number); b[3]! ^= 1; return { atyp: 1, host: b.join('.') } }
  const b = v6(address); b[15]! ^= 1
  return { atyp: 4, host: Array.from({ length: 8 }, (_, i) => (b[2 * i]! << 8 | b[2 * i + 1]!).toString(16)).join(':') }
}

async function configChecks() {
  const up = { kind: 'http', host: '127.0.0.1', port: 8080, bypass: [] }
  const bad = ['{bad', 'x'.repeat(20_000), '[]', {}, { ...BASE, extra: 1 }, { port: 0, controlToken: TOKEN }, { controlToken: TOKEN, upstream: null },
    { ...BASE, port: -1 }, { ...BASE, port: 65536 }, { ...BASE, port: '0' }, { ...BASE, port: 1.5 }, { ...BASE, port: null },
    { ...BASE, controlToken: TOKEN.slice(1) }, { ...BASE, controlToken: 'A'.repeat(129) }, { ...BASE, controlToken: `${TOKEN.slice(1)}=` }, { ...BASE, controlToken: `${TOKEN.slice(1)}.` }, { ...BASE, controlToken: 7 },
    { ...BASE, lan: 'yes' }, { ...BASE, lan: 1 }, { ...BASE, lan: null }, { ...BASE, lan: true, extra: 1 }]
  for (const cfg of bad) await startupError(cfg, 'INVALID_CONFIG')
  // An upstream it can't use isn't fatal: it starts without one and says so
  // once, right after ready, never what the upstream was.
  const unusable = ['http://127.0.0.1:8080', [], 7, { ...up, kind: 'https' }, { ...up, kind: 'socks4' },
    { ...up, host: 'user:pass@proxy.test' }, { ...up, host: 'user@proxy.test' }, { ...up, host: 'proxy.test:8080' },
    { ...up, host: 'http://proxy.test' }, { ...up, host: '' }, { ...up, host: ['127.0.0.1'] }, { ...up, host: 'proxy test' },
    { ...up, port: 0 }, { ...up, port: '8080' }, { kind: 'http', host: '127.0.0.1', port: 8080 }, { ...up, user: 'me' }]
  for (const upstream of unusable) {
    const log = launch({ ...BASE, upstream })
    await until(() => log.rows.length >= 2 || log.exit, 'ready, then the upstream row')
    const rows = [{ state: 'ready', port: log.rows[0]?.port, control: log.rows[0]?.control }, { state: 'upstream', reason: 'INVALID_UPSTREAM' }]
    assert.deepEqual(log.rows, rows, JSON.stringify(upstream))
    assert.equal(log.stdout, rows.map(row => `${JSON.stringify(row)}\n`).join(''), 'exactly those two lines')
    await stop(log)
  }
  const busy = track(net.createServer()), busyPort = await listen(busy)
  await startupError({ ...BASE, port: busyPort }, 'EADDRINUSE')
  // A wildcard listener's port (listen(P) without a host, 0.0.0.0) is taken
  // too: macOS would let this bind sit beside it and take its 127.0.0.1
  // traffic, so the port is knocked on first (Linux refuses the bind itself).
  // Either way the owner keeps its connections.
  for (const host of [undefined, '0.0.0.0']) {
    const label = host ?? 'listen(P) without a host'
    const owner = track(net.createServer(s => s.end('wildcard owner')))
    const ownerPort = await new Promise<number>((resolve, reject) => {
      owner.once('error', reject)
      owner.listen(host ? { host, port: 0 } : { port: 0 }, () => { owner.removeListener('error', reject); resolve((owner.address() as AddressInfo).port) })
    })
    await startupError({ ...BASE, port: ownerPort }, 'EADDRINUSE')
    const reached = await wire(ownerPort)
    await until(() => reached.ended, `${label} keeps 127.0.0.1:P`)
    assert.equal(reached.bytes.toString(), 'wildcard owner', `${label} still receives 127.0.0.1:P`)
    reached.client.destroy()
    await close(owner)
  }
  // The knock (vacant, the guest listener's too) on 127.0.0.1 alone, the
  // proxy's one address: a connection, or no answer within its deadline, is
  // taken and binds nothing; a refusal is free. Port 0 is never knocked on.
  const knocked: any[] = []
  const knocking = (behavior: any) => ({ host, port }: { host: string, port: number }) => {
    knocked.push({ host, port })
    const socket = new net.Socket()
    if (behavior !== 'silent') setImmediate(() => behavior === 'answer' ? socket.emit('connect') : socket.destroy(Object.assign(new Error('knock'), { code: behavior })))
    return socket
  }
  for (const [behavior, free] of [['ECONNREFUSED', true], ['answer', false], ['silent', false]]) {
    const wanted = await deadPort(), rows: any[] = [], began = Date.now()
    knocked.length = 0
    const starting = proxy.start({ ...BASE, port: wanted }, { timeouts: FAST, emit: row => rows.push(row), knock: knocking(behavior) })
    if (free) {
      const started = await starting
      running.add(started as Instance)
      assert.equal(started.port, wanted, 'a refused knock binds the port exactly')
      await shut(started as Instance)
    } else {
      await assert.rejects(starting, { code: 'EADDRINUSE' })
      assert.deepEqual(rows, [{ state: 'error', code: 'EADDRINUSE' }], `knock ${behavior}`)
      await rebinds(wanted)
    }
    assert.deepEqual(knocked, [{ host: '127.0.0.1', port: wanted }], `knock ${behavior}: 127.0.0.1 alone, once`)
    if (behavior === 'silent') assert.ok(Date.now() - began >= 280, 'an unanswered knock waits out its deadline')
  }
  knocked.length = 0
  await shut(await inProcess({ knock: knocking('answer') }))
  assert.deepEqual(knocked, [], 'port 0 is never knocked on')
  const exactPort = await deadPort()
  const exact = await ready({ ...BASE, port: exactPort, upstream: { kind: 'socks5', host: '[::1]', port: 1080, bypass: ['localhost', '*.local', '169.254/16', '10.0.0.0/8', 'fe80::/10', '<local>', 'host:8080', ''] } })
  assert.equal(exact.port, exactPort, 'a nonzero port binds exactly')
  assert.notEqual(exact.control, exactPort)
  assert.deepEqual(exact.rows, [{ state: 'ready', port: exactPort, control: exact.control }])
  assert.equal(exact.stdout, `${JSON.stringify(exact.rows[0])}\n`)
  const loopbackOnly = await wire(exactPort)
  assert.equal(loopbackOnly.client.remoteAddress, '127.0.0.1')
  await stop(exact)
  await until(() => loopbackOnly.ended || loopbackOnly.closed, 'SIGTERM closes clients')
  await rebinds(exactPort); await rebinds(exact.control)
  for (const upstream of [{ kind: 'http', host: 'proxy.example', port: 3128, bypass: [] }, { kind: 'socks5', host: '::ffff:127.0.0.1', port: 7890, bypass: ['*'] }]) await stop(await ready({ ...BASE, upstream }))
  for (const lan of [true, false]) await stop(await ready({ ...BASE, lan }))
  // Bypass content never stops the proxy: oversized, overlong, odd or absent entries are ignored.
  const many = Array.from({ length: 200 }, (_, i) => `n${i}.test`)
  for (const bypass of [many, ['x'.repeat(254), 'y'.repeat(4000), 7, null, {}, [], '', '<local>', 'host:8080', '10.0.0.0/99', '*.'], 'localhost', null, {}]) {
    const started = await ready({ ...BASE, upstream: { ...up, bypass } })
    assert.deepEqual(started.rows, [{ state: 'ready', port: started.port, control: started.control }])
    await stop(started)
  }
  const states: any[] = [], controller = new AbortController()
  controller.abort()
  await assert.rejects(proxy.start(BASE, { signal: controller.signal, emit: row => states.push(row) }))
  assert.deepEqual(states, [], 'an aborted start is quiet')
  console.log(`ok strict stdin config (keys, optional boolean lan, port 0/exact, token; bypass content never fatal), ${unusable.length} unusable upstreams start without one and say INVALID_UPSTREAM once, EADDRINUSE (a wildcard owner's port too: knocked on first, timeout/refusal semantics, never for port 0), exact loopback bind, ready row, SIGTERM/abort cleanup`)
}

async function controlChecks() {
  const log = await ready(BASE), port = log.control, valid = routesBody({}, [])
  const accepted = await control(port, { body: valid })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body, '{"ok":true}')
  assert.match(accepted.text, /\r\nconnection: close\r\n/i)
  // The helpers' one control server (tcp-relay.mts): 403 for the token, Host or Origin; 400 malformed; 413 too long.
  const cases: [object, number][] = [
    [{ auth: null }, 403], [{ auth: `Bearer ${'A'.repeat(43)}` }, 403], [{ auth: `bearer ${TOKEN}` }, 403], [{ auth: `Bearer ${TOKEN}x` }, 403], [{ auth: TOKEN }, 403], [{ auth: `Bearer  ${TOKEN}` }, 403],
    [{ headers: 'Origin: null\r\n' }, 403], [{ headers: 'Origin: http://localhost:3000\r\n' }, 403], [{ headers: 'Origin: \r\n' }, 403],
    [{ host: `localhost:${port}` }, 403], [{ host: '127.0.0.1' }, 403], [{ host: `127.0.0.1:${port + 1}` }, 403], [{ host: 'attacker.test' }, 403], [{ host: `[::1]:${port}` }, 403],
    [{ method: 'GET' }, 400], [{ method: 'PUT' }, 400], [{ method: 'OPTIONS' }, 400],
    [{ path: '/routes' }, 400], [{ path: '/?op=routes' }, 400], [{ path: '//' }, 400], [{ path: `http://127.0.0.1:${port}/` }, 400],
    [{ type: 'text/plain' }, 400], [{ type: null }, 400], [{ type: 'application/json; charset=utf-8' }, 400], [{ headers: 'Content-Encoding: gzip\r\n' }, 400],
    [{ headers: `Authorization: Bearer ${TOKEN}\r\n` }, 400], [{ headers: 'Content-Type: application/json\r\n' }, 400], [{ headers: `Host: 127.0.0.1:${port}\r\n` }, 400],
    [{ body: 'x'.repeat(8193) }, 413], [{ body: ' '.repeat(8193), chunked: true }, 413],
    [{ body: '{bad' }, 400], [{ body: '' }, 400], [{ body: Buffer.from([0x7b, 0xff, 0x7d]) }, 400],
  ]
  for (const [options, status] of cases) assert.equal((await control(port, { body: valid, ...options })).status, status, JSON.stringify(options))
  assert.ok([400, 403].includes((await control(port, { body: valid, host: null })).status), 'a missing Host never configures')
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(1000 + i), 20000 + i]))
  const schema = [null, [], 'routes', {}, { op: 'routes' }, { op: 'routes', routes: {} }, { op: 'routes', startable: [] }, { op: 'route', routes: {}, startable: [] },
    { op: 'routes', routes: [], startable: [] }, { op: 'routes', routes: null, startable: [] }, { op: 'routes', routes: {}, startable: {} }, { op: 'routes', routes: {}, startable: [], extra: 1 },
    ...['0', '65536', '01', '1.5', '-1', 'abc', ' 80', '80 ', '1e3'].map(key => ({ op: 'routes', routes: { [key]: 4000 }, startable: [] })),
    ...[0, 65536, 1.5, '4000', null, -1, true].map(target => ({ op: 'routes', routes: { 80: target }, startable: [] })),
    ...[[0], [65536], ['80'], [1.5], [null]].map(startable => ({ op: 'routes', routes: {}, startable })),
    { op: 'routes', routes: many(129), startable: [] }, { op: 'routes', routes: {}, startable: Array.from({ length: 129 }, (_, i) => 1000 + i) }]
  for (const row of schema) assert.equal((await control(port, { body: JSON.stringify(row) })).status, 400, JSON.stringify(row).slice(0, 120))
  assert.equal((await control(port, { body: '{"op":"routes","routes":{"__proto__":4000},"startable":[]}' })).status, 400)
  const largest = routesBody(many(128), Array.from({ length: 128 }, (_, i) => 30000 + i))
  assert.ok(Buffer.byteLength(largest) < 8192)
  assert.equal((await control(port, { body: largest })).status, 200, 'the largest valid table fits')
  // Unfinished headers and bodies share an eight-socket, two-second hard deadline.
  const stalled: any[] = []
  for (let i = 0; i < 8; i++) {
    const c = await wire(port)
    c.client.write(i < 4 ? 'POST / HTTP/1.1\r\n' : `POST / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 99\r\n\r\n{`)
    stalled.push(c)
  }
  const ninth = await wire(port)
  await until(() => ninth.ended || ninth.closed, 'ninth control socket refused')
  assert.match(ninth.bytes.toString(), /^HTTP\/1\.1 503 Service Unavailable\r\n[\s\S]*\r\n\r\n\{"ok":false\}$/, 'the ninth is answered 503 at once')
  assert.ok(stalled.every(c => !c.ended && !c.closed), 'refusing the ninth leaves the eight alone')
  // A whole valid request on a refused socket is answered 503 and changes nothing.
  const echo = echoServer(), echoPort = await listen(echo)
  assert.equal((await control(port, { body: routesBody({ 3000: echoPort }) })).status, 503)
  await until(() => stalled.every(c => c.ended || c.closed), 'slow headers/bodies time out', 3500)
  assert.ok(stalled.every(c => !c.bytes.toString().includes('"ok":true')))
  await expectReply(await socks(log.port, loopbackTo(3000)), 2, 'the refused table never applied')
  assert.equal((await control(port, { body: valid })).status, 200, 'capacity returns after the deadline')
  const oversized = await wire(port)
  oversized.client.write(`POST / HTTP/1.1\r\nX-Large: ${'a'.repeat(9000)}\r\n\r\n`)
  await until(() => oversized.ended || oversized.closed, 'oversized control headers refused')
  assert.match(oversized.bytes.toString(), /^HTTP\/1\.1 4/)
  await stop(log)
  assert.ok(!log.stdout.includes(TOKEN))
  console.log('ok control port: bearer, Origin and exact Host 403; method/path/type/encoding/duplicate 400; body 413; schema/limits 400; 8 sockets (the ninth answered 503, its table never applied) and 2 s deadline')
}

async function handshakeChecks() {
  const echo = echoServer(), echoPort = await listen(echo)
  const p = await inProcess()
  await configure(p, { 3000: echoPort })
  const slow = await socks(p.port, loopbackTo(3000), { bytewise: true })
  await expectReply(slow, 0, 'byte-by-byte greeting and request')
  await echoes(slow)
  const early = Buffer.from('early application bytes')
  const pipelined = await socks(p.port, { atyp: 1, host: '127.0.0.1', port: 3000 }, { greeting: [5, 3, 2, 1, 0], early })
  await until(() => pipelined.bytes.length >= 12 + early.length, 'early data follows the reply')
  assert.deepEqual([...pipelined.bytes.subarray(0, 12)], [5, 0, ...reply(0)])
  assert.deepEqual(pipelined.bytes.subarray(12), early)
  for (const target of [{ atyp: 1, host: '127.0.0.1' }, { atyp: 3, host: 'localhost' }, { atyp: 4, host: '::1' }]) {
    const c = await socks(p.port, { ...target, port: 3000 })
    await expectReply(c, 0, `ATYP ${target.atyp}`)
    await echoes(c)
  }
  const ended = (c: Wire) => c.ended || c.closed
  const badGreeting = await wire(p.port)
  badGreeting.client.write(Buffer.from([4, 1, 0, 80, 127, 0, 0, 1, 0]))
  await until(() => ended(badGreeting), 'SOCKS4 greeting closed')
  assert.equal(badGreeting.bytes.length, 0)
  const badRequest = await wire(p.port)
  badRequest.client.write(Buffer.from([5, 1, 0, 4, 1, 0, 1, 127, 0, 0, 1, 0, 80]))
  await until(() => ended(badRequest), 'wrong request version closed')
  assert.deepEqual([...badRequest.bytes], [5, 0])
  for (const greeting of [[5, 1, 2], [5, 0], [5, 2, 1, 2]]) {
    const c = await wire(p.port)
    c.client.write(Buffer.from(greeting))
    await until(() => ended(c), 'no acceptable method')
    assert.deepEqual([...c.bytes], [5, 0xff])
  }
  for (const [cmd, atyp, rep] of [[2, 1, 7], [3, 1, 7], [0, 1, 7], [9, 1, 7], [1, 0, 8], [1, 2, 8], [1, 5, 8], [1, 255, 8]] as [number, number, number][]) {
    const c = await wire(p.port)
    c.client.write(Buffer.from([5, 1, 0, 5, cmd, 0, atyp, 127, 0, 0, 1, 0, 80]))
    await until(() => ended(c), `CMD ${cmd} ATYP ${atyp}`)
    assert.deepEqual([...c.bytes], [5, 0, ...reply(rep!)])
  }
  for (const [target, rep] of [[{ atyp: 3, host: 'bad name', port: 3000 }, 4], [{ atyp: 3, host: 'user@host', port: 3000 }, 4], [{ atyp: 3, host: '', port: 3000 }, 4], [{ atyp: 3, host: 'localhost', port: 0 }, 2]] as [Target, number][]) {
    await expectReply(await socks(p.port, target), rep, JSON.stringify(target))
  }
  const began = Date.now(), silent = await wire(p.port), partial = await wire(p.port), partialRequest = await wire(p.port)
  partial.client.write(Buffer.from([5, 1]))
  partialRequest.client.write(Buffer.from([5, 1, 0, 5, 1, 0, 3, 9, 108]))
  await until(() => [silent, partial, partialRequest].every(ended), 'handshake deadline', 3000)
  assert.ok(Date.now() - began >= FAST.handshake - 20, 'not before the deadline')
  assert.equal(silent.bytes.length, 0)
  assert.equal(partial.bytes.length, 0)
  assert.deepEqual([...partialRequest.bytes], [5, 0])
  assert.deepEqual(p.rows, [{ state: 'seen', port: 3000 }], 'handshake failures are silent; seen once per port')
  await shut(p)
  const patient = await inProcess({ timeouts: { ...FAST, handshake: 10_000 } }), quitter = await wire(patient.port), finAt = Date.now()
  quitter.client.end(Buffer.from([5, 1]))
  await until(() => quitter.closed, 'a FIN mid-handshake frees the slot at once', 2000)
  assert.ok(Date.now() - finAt < 1000)
  await shut(patient)
  console.log('ok SOCKS5 handshake: byte-by-byte and pipelined with early data, ATYP 1/3/4, wrong versions closed, no-auth only (FF), CMD 07, ATYP 08, bad names 04, port 0 02, handshake deadline and mid-handshake FIN')
}

async function classificationChecks() {
  const echo = echoServer(), echoPort = await listen(echo)
  const names: Record<string, any> = {
    'lvh.test': [{ address: '127.0.0.1', family: 4 }], 'mixed.test': [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }],
    'zero.test': [{ address: '0.0.0.0', family: 4 }], 'mapped.test': [{ address: '::ffff:127.0.0.1', family: 6 }],
    'own.test': [{ address: '203.0.113.7', family: 4 }], 'own6.test': [{ address: '93.184.216.34', family: 4 }, { address: '2001:db8::7', family: 6 }],
  }
  const lookups: any[] = []
  const lookup = (name: string, options: any, callback: LookupCallback) => {
    lookups.push(name)
    assert.equal(options.all, true)
    setImmediate(() => names[name] ? callback(null, names[name]) : callback(Object.assign(new Error('not found'), { code: 'ENOTFOUND' })))
  }
  const interfaces = () => ({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }], en0: [{ address: '203.0.113.7', family: 'IPv4', internal: false }, { address: '2001:db8::7', family: 'IPv6', internal: false }] })
  const dials: any[] = []
  const p = await inProcess({ lookup, interfaces, connect: (options: ConnectOptions) => { dials.push(`${options.host}:${options.port}`); return net.connect(options) } })
  await configure(p, { 3000: echoPort })
  const loopbackClass = [{ atyp: 3, host: 'localhost' }, { atyp: 3, host: 'LocalHost.' }, { atyp: 3, host: 'app.localhost' }, { atyp: 3, host: 'a.b.localhost' },
    { atyp: 1, host: '127.0.0.1' }, { atyp: 1, host: '127.8.9.10' }, { atyp: 1, host: '0.0.0.0' }, { atyp: 4, host: '::1' }, { atyp: 4, host: '::' },
    { atyp: 4, host: '::ffff:7f00:1' }, { atyp: 4, host: '::ffff:0:0' }, { atyp: 3, host: '::ffff:127.0.0.1' }, { atyp: 3, host: '[::1]' }, { atyp: 3, host: '127.0.0.1' },
    { atyp: 3, host: '0.0.0.0' }]
  for (const target of loopbackClass) {
    const c = await socks(p.port, { ...target, port: 3000 })
    await expectReply(c, 0, JSON.stringify(target))
    await echoes(c)
    c.client.destroy()
  }
  assert.ok(dials.length === loopbackClass.length && dials.every(dial => dial === `127.0.0.1:${echoPort}`), 'every loopback-class target reaches only its route')
  assert.deepEqual(lookups, [], 'localhost names and literals never consult DNS')
  // Any other name pointing at this computer may be a page's own, rebound to
  // loopback after it loaded (DNS rebinding): refused, silently, never dialled.
  for (const host of ['lvh.test', 'mixed.test', 'zero.test', 'mapped.test', 'LVH.test.']) await expectReply(await socks(p.port, { atyp: 3, host, port: 3000 }), 2, `rebound ${host}`)
  assert.deepEqual([...new Set(lookups)].sort(), ['lvh.test', 'mapped.test', 'mixed.test', 'zero.test'])
  assert.equal(dials.length, loopbackClass.length, 'a name rebound to loopback is never dialled')
  const quiet = p.rows.length
  for (const target of [{ atyp: 1, host: '203.0.113.7' }, { atyp: 4, host: '2001:db8::7' }, { atyp: 4, host: '::ffff:cb00:7107' }, { atyp: 3, host: '203.0.113.7' },
    { atyp: 3, host: '2001:DB8:0:0:0:0:0:7' }, { atyp: 3, host: '[2001:db8::7]' }, { atyp: 3, host: 'own.test' }, { atyp: 3, host: 'own6.test' }]) {
    await expectReply(await socks(p.port, { ...target, port: 5173 }), 2, `own address ${target.host}`)
  }
  assert.equal(p.rows.length, quiet, 'own-address refusals are silent')
  assert.equal(dials.length, loopbackClass.length, 'own addresses are never dialled')
  assert.deepEqual(p.rows, [{ state: 'seen', port: 3000 }])
  await shut(p)
  const blind = await inProcess({ interfaces: () => { throw new Error('unavailable') }, connect: () => { throw new Error('must not dial') } })
  await expectReply(await socks(blind.port, { atyp: 1, host: '93.184.216.34', port: 443 }), 1, 'unknown interfaces fail closed')
  await shut(blind)
  const real = Object.values(os.networkInterfaces()).flat().filter((entry): entry is os.NetworkInterfaceInfo => Boolean(entry && !entry.internal))
  const real4 = real.find(entry => net.isIPv4(entry.address)), real6 = real.find(entry => net.isIPv6(entry.address) && !entry.address.includes('%'))
  if (!real4 && !real6) console.log('SKIP real own-interface refusal (no non-internal interface, e.g. Docker --network none)')
  else {
    const own = await inProcess({ connect: () => { throw new Error('must not dial') } })
    if (real4) await expectReply(await socks(own.port, { atyp: 1, host: real4.address, port: 8080 }), 2, 'real own IPv4')
    if (real6) await expectReply(await socks(own.port, { atyp: 3, host: real6.address, port: 8080 }), 2, 'real own IPv6')
    assert.deepEqual(own.rows, [])
    await shut(own)
  }
  console.log(`ok classification: localhost/*.localhost without DNS, 127/8, 0.0.0.0, ::1, ::, ::ffff:127.x (ATYP 3/4), names resolving to loopback -> 02 silently (rebinding), never dialled; own interfaces${real4 || real6 ? ' (injected + real)' : ' (injected)'} and names resolving there -> 02 silently; unknown interfaces fail closed`)
}

async function routingChecks() {
  const echo = echoServer(), echoPort = await listen(echo)
  const first = await inProcess(), held = await socks(first.port, loopbackTo(3000))
  await pause(120)
  assert.deepEqual([...held.bytes], [5, 0], 'held until the first routes op')
  await configure(first, { 3000: echoPort })
  await expectReply(held, 0, 'the first routes op releases a held CONNECT')
  await echoes(held)
  assert.deepEqual(first.rows, [{ state: 'seen', port: 3000 }])
  await shut(first)

  const never = await inProcess(), began = Date.now()
  await expectReply(await socks(never.port, loopbackTo(3001)), 2, 'never configured')
  assert.ok(Date.now() - began >= FAST.firstConfig - 20)
  assert.deepEqual(never.rows, [{ state: 'seen', port: 3001 }], 'no blocked before any configuration')
  await shut(never)

  const wanting = await inProcess()
  await configure(wanting, {}, [3610])
  const one = await socks(wanting.port, loopbackTo(3610)), two = await socks(wanting.port, loopbackTo(3610))
  await until(() => wanting.rows.some(row => row.state === 'want'), 'want for a startable port')
  await pause(40)
  assert.deepEqual(wanting.rows, [{ state: 'seen', port: 3610 }, { state: 'want', port: 3610 }], 'one want per port per window')
  assert.ok(one.bytes.length === 2 && two.bytes.length === 2, 'both held for the route')
  await configure(wanting, { 3610: echoPort }, [3610])
  await expectReply(one, 0); await expectReply(two, 0)
  await echoes(one); await echoes(two)
  await configure(wanting, {}, [3610])
  const lapsed = Date.now()
  await expectReply(await socks(wanting.port, loopbackTo(3610)), 2, 'startable but never routed')
  assert.ok(Date.now() - lapsed >= FAST.want - 20)
  assert.equal(wanting.rows.filter(row => row.state === 'want').length, 1, 'still inside the want window')
  await pause(FAST.wantEvery)
  const again = await socks(wanting.port, loopbackTo(3610))
  await until(() => wanting.rows.filter(row => row.state === 'want').length === 2, 'want again after its window')
  await configure(wanting, {}, [])
  await expectReply(again, 2, 'a routes op that drops startable refuses the held CONNECT')
  assert.deepEqual(wanting.rows.at(-1), { state: 'blocked', port: 3610 })
  await shut(wanting)

  const denied = await inProcess()
  await configure(denied, { 3000: echoPort }, [3610])
  const quick = Date.now()
  await expectReply(await socks(denied.port, loopbackTo(5432)), 2, 'unauthorized port')
  assert.ok(Date.now() - quick < 250, 'unauthorized ports are refused at once')
  await expectReply(await socks(denied.port, { atyp: 1, host: '127.0.0.1', port: 5432 }), 2)
  assert.deepEqual(denied.rows, [{ state: 'seen', port: 5432 }, { state: 'blocked', port: 5432 }], 'blocked once per window; seen once per process')
  await pause(FAST.blockedEvery)
  await expectReply(await socks(denied.port, loopbackTo(5432)), 2)
  assert.deepEqual(denied.rows.slice(2), [{ state: 'blocked', port: 5432 }])
  await configure(denied, { 4001: await deadPort() })
  await expectReply(await socks(denied.port, loopbackTo(4001)), 5, 'a dead route is refused (05)')
  await shut(denied)

  const crowd = await inProcess({ timeouts: { ...FAST, want: 4000 } })
  await configure(crowd, {}, [4100])
  const waiting = []
  for (let i = 0; i < 64; i++) waiting.push(await socks(crowd.port, loopbackTo(4100)))
  await until(() => crowd.rows.some(row => row.state === 'want'), 'crowd want')
  await pause(50)
  assert.ok(waiting.every(c => c.bytes.length === 2), '64 held')
  const excess = Date.now()
  await expectReply(await socks(crowd.port, loopbackTo(4100)), 2, 'the 65th held CONNECT')
  assert.ok(Date.now() - excess < 1000, 'held capacity refuses at once')
  await configure(crowd, { 4100: echoPort }, [4100])
  for (const c of waiting) await expectReply(c, 0)
  await echoes(waiting[63]!)
  await expectReply(await socks(crowd.port, loopbackTo(4100)), 0, 'capacity released after routing')
  await shut(crowd)
  console.log('ok routing: first-config hold then route, never-configured 02 without blocked, want + route during hold, want window, startable timeout 02, revoked startable, unauthorized 02 + deduplicated blocked, dead route 05, 64 held CONNECTs')
}

async function pipingChecks() {
  const targets: any[] = []
  const target = track(net.createServer({ allowHalfOpen: true }, socket => {
    const state = { socket, data: [] as Buffer[], ended: false }
    targets.push(state)
    socket.on('data', bytes => state.data.push(bytes))
    socket.on('end', () => { state.ended = true })
  }))
  const targetPort = await listen(target)
  const p = await inProcess()
  await configure(p, { 3000: targetPort })
  const upload = await expectReply(await socks(p.port, loopbackTo(3000)), 0)
  await until(() => targets.length === 1, 'target accepted')
  upload.client.end('request, then FIN')
  await until(() => targets[0].ended, 'client FIN reaches the target as a half-close')
  assert.equal(Buffer.concat(targets[0].data).toString(), 'request, then FIN')
  targets[0].socket.write('response after the client FIN')
  await until(() => upload.bytes.length === 12 + 29, 'target still answers')
  assert.equal(upload.bytes.subarray(12).toString(), 'response after the client FIN')
  assert.equal(upload.ended, false, 'the reverse half stays open')
  targets[0].socket.end()
  await until(() => upload.ended && upload.closed, 'target FIN completes the close')

  const download = await expectReply(await socks(p.port, loopbackTo(3000)), 0)
  await until(() => targets.length === 2, 'second target')
  targets[1].socket.end('early response, then FIN')
  await until(() => download.ended, 'target FIN reaches the client')
  assert.equal(download.bytes.subarray(12).toString(), 'early response, then FIN')
  download.client.write('late upload after the target FIN')
  await until(() => Buffer.concat(targets[1].data).toString() === 'late upload after the target FIN', 'client half still delivers')
  download.client.end()
  await until(() => targets[1].ended && download.closed, 'both halves finished')

  const LARGE = 24 * 1024 * 1024 + 7, chunk = randomBytes(65536)
  let written = 0, sent
  const big = track(net.createServer({ allowHalfOpen: true }, async socket => {
    const hash = createHash('sha256')
    socket.on('error', () => {})
    for (let at = 0; at < LARGE && !socket.destroyed; at += chunk.length) {
      const piece = chunk.subarray(0, Math.min(chunk.length, LARGE - at))
      hash.update(piece)
      written += piece.length
      if (!socket.write(piece)) await new Promise(resolve => {
        const done = () => { socket.removeListener('drain', done); socket.removeListener('close', done); resolve(undefined) }
        socket.once('drain', done); socket.once('close', done)
      })
    }
    sent = hash.digest('hex')
    socket.end()
  }))
  await configure(p, { 3000: targetPort, 3100: await listen(big) })
  const slow = await socks(p.port, loopbackTo(3100))
  slow.client.pause()
  await until(() => written > 0, 'large download begins')
  await pause(300)
  const stalled = written
  assert.ok(stalled < LARGE, `a paused reader holds the sender back (${stalled} of ${LARGE})`)
  slow.client.resume()
  await until(() => slow.size === 12 + LARGE && slow.ended, '24 MiB drains to the slow reader', 60_000)
  assert.equal(createHash('sha256').update(slow.bytes.subarray(12)).digest('hex'), sent)

  let sink: net.Socket | undefined, received = 0, sinkEnded = false
  const sinkHash = createHash('sha256')
  const slowSink = track(net.createServer({ allowHalfOpen: true }, socket => {
    sink = socket
    socket.pause()
    socket.on('data', bytes => { received += bytes.length; sinkHash.update(bytes) })
    socket.on('end', () => { sinkEnded = true; socket.end() })
  }))
  await configure(p, { 3200: await listen(slowSink) })
  const uploader = await expectReply(await socks(p.port, loopbackTo(3200)), 0)
  const upHash = createHash('sha256')
  let uploaded = 0
  const writing = (async () => {
    for (let at = 0; at < LARGE; at += chunk.length) {
      const piece = chunk.subarray(0, Math.min(chunk.length, LARGE - at))
      upHash.update(piece)
      uploaded += piece.length
      if (!uploader.client.write(piece)) await once(uploader.client, 'drain')
    }
    uploader.client.end()
  })()
  await until(() => sink, 'upload target')
  await pause(300)
  assert.ok(uploaded < LARGE, `a paused target holds the uploader back (${uploaded} of ${LARGE})`)
  sink!.resume()
  await writing
  await until(() => sinkEnded && received === LARGE, '24 MiB upload drains', 60_000)
  assert.equal(sinkHash.digest('hex'), upHash.digest('hex'))
  await shut(p)
  console.log('ok piping: FIN half-close both directions, 24 MiB download and upload with paused peers (backpressure, intact sha256)')
}

async function outboundChecks() {
  const echo = echoServer(), echoPort = await listen(echo)
  const direct = track(net.createServer({ allowHalfOpen: true }, socket => { socket.write('DIRECT'); socket.on('data', bytes => socket.write(bytes)); socket.on('end', () => socket.end()) }))
  const directPort = await listen(direct)
  const connects: any[] = []
  const httpUpstream = track(net.createServer({ allowHalfOpen: true }, socket => {
    let head = Buffer.alloc(0)
    const read = (bytes: Buffer) => {
      head = Buffer.concat([head, bytes])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.removeListener('data', read)
      const text = head.subarray(0, end).toString('latin1'), rest = head.subarray(end + 4), authority = /^CONNECT (\S+) HTTP\/1\.1\r\n/.exec(`${text}\r\n`)?.[1] ?? ''
      // The proxy sends only addresses: the fixture's behavior is keyed by the name that address stands for.
      const target = byAddress[authority.replace(/:[0-9]+$/, '')] ?? authority
      connects.push(text)
      if (target.startsWith('deny.')) return socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
      if (target.startsWith('huge.')) return socket.write(`HTTP/1.1 200 OK\r\nX-Pad: ${'p'.repeat(9000)}\r\n`)
      if (target.startsWith('garbage.')) return socket.end('SSH-2.0-OpenSSH\r\n\r\n')
      if (target.startsWith('drop.')) return socket.destroy()
      socket.write('HTTP/1.1 200 Connection established\r\nProxy-Agent: fixture\r\n\r\nEXTRA')
      if (rest.length) socket.write(rest)
      socket.on('data', more => socket.write(more))
      socket.on('end', () => socket.end())
    }
    socket.on('data', read)
  }))
  const httpPort = await listen(httpUpstream)
  const names: Record<string, any> = { 'ok.test': '93.184.216.34', 'direct.test': '198.51.100.20', 'www.direct.test': '198.51.100.21', 'a.suffix.test': '198.51.100.22', 'suffix.test': '198.51.100.23', 'x.star.test': '198.51.100.24', 'other.test': '198.51.100.25', 'lvh.test': '127.0.0.1', 'own.test': '203.0.113.7', 'same.test': '198.51.100.26', 'deny.test': '198.51.100.27', 'huge.test': '198.51.100.28', 'garbage.test': '198.51.100.29', 'drop.test': '198.51.100.30', 'refused.test': '198.51.100.31', 'unreach.test': '198.51.100.32', 'perm.test': '198.51.100.33', 'agg.test': '198.51.100.34', 'hang.test': '198.51.100.35', 'pinned.test': '198.51.100.36', 'deep.www.direct.test': '198.51.100.37', 'notdirect.test': '198.51.100.38', 'direct.test.evil': '198.51.100.39', 'corp.lan.test': '10.20.30.40',
    'bnd6.test': '198.51.100.40', 'bnd3.test': '198.51.100.41', 'fail.test': '198.51.100.42', 'odd.test': '198.51.100.43', 'version.test': '198.51.100.44', 'k64.test': '198.51.100.45', 'k99.test': '198.51.100.46' }
  const byAddress = Object.fromEntries(Object.entries(names).map(([name, address]) => [address, name]))
  let lookupCalls: any[] = []
  const lookup = (name: string, _options: any, callback: LookupCallback) => {
    lookupCalls.push(name)
    if (name === 'slow.test') return // Never answers: the proxy's own deadline decides.
    const answer = () => names[name] ? callback(null, [{ address: names[name], family: 4 }]) : callback(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }))
    if (name === 'same.test') setTimeout(answer, 100)
    else setImmediate(answer)
  }
  const interfaces = () => ({ en0: [{ address: '203.0.113.7', family: 'IPv4', internal: false }] })
  const failing = (code: string) => { const socket = new net.Socket(); setImmediate(() => socket.destroy(Object.assign(new Error('fixture'), { code }))); return socket }
  const dials: any[] = []
  const connect = (options: ConnectOptions) => {
    if (options.host === '127.0.0.1') { dials.push(options.port === httpPort ? 'upstream' : 'route'); return net.connect(options) }
    let pinned
    options.lookup?.(options.host!, { all: true }, (_error: unknown, list: any) => { pinned = list })
    dials.push({ host: options.host, port: options.port, pinned, autoSelectFamily: options.autoSelectFamily, allowHalfOpen: options.allowHalfOpen })
    if (options.host === 'refused.test') return failing('ECONNREFUSED')
    if (options.host === 'unreach.test') return failing('EHOSTUNREACH')
    if (options.host === 'perm.test') return failing('EPERM')
    if (options.host === 'agg.test') { const socket = new net.Socket(); setImmediate(() => socket.destroy(Object.assign(new AggregateError([Object.assign(new Error('a'), { code: 'ENETUNREACH' }), Object.assign(new Error('b'), { code: 'ECONNREFUSED' })]), { code: 'ENETUNREACH' }))); return socket }
    if (options.host === 'hang.test') return new net.Socket()
    // The real dialer, given the proxy's pinned lookup: it must use exactly
    // the checked addresses (all: true), here mapped onto a local fixture.
    if (options.host === 'pinned.test') return net.connect({ ...options, port: directPort, lookup: (name: string, opts: any, callback: LookupCallback) => options.lookup!(name, opts, (error: NodeJS.ErrnoException | null, list: any) => { dials.push({ realLookup: name, opts: { ...opts }, list }); callback(error, opts.all ? list.map(() => ({ address: '127.0.0.1', family: 4 })) : '127.0.0.1', 4) }) })
    return net.connect({ host: '127.0.0.1', port: directPort, allowHalfOpen: true })
  }
  const bypass = ['direct.test', '.suffix.test', '*.star.test', '198.51.100.9', '[2001:db8::9]', '192.0.2.0/24', '100.1/16', '169.254/16', '10.0.0.0/8', '*.lan.test', 'host:8080', '<local>']
  const viaHttp = await inProcess({ lookup, interfaces, connect }, { upstream: { kind: 'http', host: '127.0.0.1', port: httpPort, bypass } })
  await configure(viaHttp, { 3000: echoPort })
  const through = async (target: Target, label: string) => {
    const c = await expectReply(await socks(viaHttp.port, target), 0, label)
    await until(() => c.bytes.length >= 12 + 5, `${label}: first bytes`)
    return c
  }
  const tunnel = await through({ atyp: 3, host: 'OK.Test.', port: 443 }, 'HTTP CONNECT for a name')
  assert.equal(tunnel.bytes.subarray(12, 17).toString(), 'EXTRA', 'bytes after the upstream headers are forwarded')
  await echoes(tunnel)
  assert.equal(connects.at(-1), 'CONNECT 93.184.216.34:443 HTTP/1.1\r\nHost: 93.184.216.34:443', 'a name goes at its checked address, never by name')
  await through({ atyp: 1, host: '93.184.216.34', port: 8443 }, 'HTTP CONNECT IPv4')
  assert.equal(connects.at(-1), 'CONNECT 93.184.216.34:8443 HTTP/1.1\r\nHost: 93.184.216.34:8443')
  await through({ atyp: 4, host: '2001:db8:0:0:0:0:0:5', port: 443 }, 'HTTP CONNECT IPv6')
  assert.equal(connects.at(-1), 'CONNECT [2001:db8::5]:443 HTTP/1.1\r\nHost: [2001:db8::5]:443')
  // With no address checked (no DNS-over-HTTPS here, no local answer) nothing goes: the name never reaches the upstream.
  const connectsAt = connects.length
  await expectReply(await socks(viaHttp.port, { atyp: 3, host: 'unknown.test', port: 443 }), 4, 'a name the Guest cannot resolve is refused')
  const slowAt = Date.now()
  await expectReply(await socks(viaHttp.port, { atyp: 3, host: 'slow.test', port: 443 }), 4, 'a lookup past its deadline is refused')
  assert.ok(Date.now() - slowAt >= FAST.lookup - 20)
  assert.equal(connects.length, connectsAt, 'neither reached the upstream')
  for (const name of ['deny.test', 'huge.test', 'garbage.test', 'drop.test']) await expectReply(await socks(viaHttp.port, { atyp: 3, host: name, port: 443 }), 1, `upstream ${name}`)
  assert.equal(dials.filter(dial => typeof dial === 'object').length, 0, 'nothing went direct so far')
  const routedBefore = dials.filter(dial => dial === 'route').length
  await echoes(await expectReply(await socks(viaHttp.port, { atyp: 3, host: 'localhost', port: 3000 }), 0, 'localhost never uses the upstream'))
  assert.equal(dials.filter(dial => dial === 'route').length, routedBefore + 1)
  const rebindAt = connects.length
  await expectReply(await socks(viaHttp.port, { atyp: 3, host: 'lvh.test', port: 3000 }), 2, 'a name rebound to loopback is refused, never routed or tunnelled')
  assert.equal(connects.length, rebindAt)
  assert.equal(dials.filter(dial => dial === 'route').length, routedBefore + 1)
  await expectReply(await socks(viaHttp.port, { atyp: 3, host: 'own.test', port: 443 }), 2, 'own address never uses the upstream')
  const upstreamDials = dials.filter(dial => dial === 'upstream').length
  for (const [target, label] of [[{ atyp: 3, host: 'direct.test' }, 'a bare name'], [{ atyp: 3, host: 'www.direct.test' }, 'a subdomain of a bare name'], [{ atyp: 3, host: 'deep.www.direct.test' }, 'a deeper subdomain'],
    [{ atyp: 3, host: 'a.suffix.test' }, '.suffix'], [{ atyp: 3, host: 'suffix.test' }, '.suffix itself'], [{ atyp: 3, host: 'x.star.test' }, '*.suffix'], [{ atyp: 1, host: '198.51.100.9' }, 'IPv4'],
    [{ atyp: 4, host: '2001:db8::9' }, 'IPv6'], [{ atyp: 1, host: '192.0.2.77' }, 'CIDR'], [{ atyp: 1, host: '100.1.3.4' }, 'short CIDR']] as [Aim, string][]) {
    const c = await expectReply(await socks(viaHttp.port, { ...target, port: 80 }), 0, `bypass ${label}`)
    await until(() => c.bytes.length >= 18, 'direct greeting')
    assert.equal(c.bytes.subarray(12, 18).toString(), 'DIRECT', `bypass ${label} goes direct`)
  }
  assert.equal(dials.filter(dial => dial === 'upstream').length, upstreamDials, 'bypassed hosts never touch the upstream')
  const named = dials.find(dial => dial.host === 'direct.test')
  assert.deepEqual(named.pinned, [{ address: '198.51.100.20', family: 4 }], 'direct dials only the checked address')
  assert.equal(named.autoSelectFamily, true)
  assert.equal(named.allowHalfOpen, true)
  for (const host of ['notdirect.test', 'direct.test.evil', 'other.test']) {
    const c = await expectReply(await socks(viaHttp.port, { atyp: 3, host, port: 80 }), 0, `${host} is not bypassed`)
    await until(() => c.bytes.length >= 17, 'upstream bytes')
    assert.equal(c.bytes.subarray(12, 17).toString(), 'EXTRA')
  }
  // A bypass entry never opens the local network: refused before any upstream or direct dial.
  const reached = dials.length
  for (const target of [{ atyp: 1, host: '169.254.3.4' }, { atyp: 1, host: '10.1.2.3' }, { atyp: 3, host: 'corp.lan.test' }]) await expectReply(await socks(viaHttp.port, { ...target, port: 80 }), 2, `bypassed ${target.host} stays refused`)
  assert.equal(dials.length, reached, 'nothing was dialled for them')
  await shut(viaHttp)
  // The first 64 usable entries count: junk is skipped, not counted (names that
  // end in a number too: no request can carry one), and an entry over 253
  // characters is ignored even if it would trim to a name.
  const capped = await inProcess({ lookup, interfaces, connect }, { upstream: { kind: 'http', host: '127.0.0.1', port: httpPort, bypass: [`${' '.repeat(250)}k99.test`, 7, null, 'host:8080', '10.1', '*.0x7f.1', '.2130706433', ...Array.from({ length: 65 }, (_, i) => `k${i}.test`)] } })
  await expectReply(await socks(capped.port, { atyp: 3, host: 'k63.test', port: 80 }), 4, 'the 64th usable entry applies (direct, and unresolvable)')
  for (const host of ['k64.test', 'k99.test']) {
    const c = await expectReply(await socks(capped.port, { atyp: 3, host, port: 80 }), 0, `${host}: past the limit or overlong, so upstream`)
    await until(() => c.bytes.length >= 17)
    assert.equal(c.bytes.subarray(12, 17).toString(), 'EXTRA')
  }
  await shut(capped)

  const socksSeen: any[] = []
  const socksUpstream = (greeting = [5, 0]) => track(net.createServer({ allowHalfOpen: true }, socket => {
    let buffer = Buffer.alloc(0), stage = 0
    const read = (bytes: Buffer) => {
      buffer = Buffer.concat([buffer, bytes])
      if (stage === 0) {
        if (buffer.length < 3) return
        socksSeen.push({ greeting: [...buffer.subarray(0, 3)] })
        buffer = buffer.subarray(3)
        stage = 1
        socket.write(Buffer.from(greeting))
        if (greeting[1] !== 0) return socket.end()
      }
      if (buffer.length < 5) return
      const atyp = buffer[3], size = atyp === 1 ? 10 : atyp === 4 ? 22 : 7 + buffer[4]!
      if (buffer.length < size) return
      socket.removeListener('data', read)
      const seen = atyp === 1 ? [...buffer.subarray(4, 8)].join('.') : atyp === 4 ? buffer.subarray(4, 20).toString('hex') : buffer.toString('latin1', 5, 5 + buffer[4]!)
      socksSeen.push({ atyp, host: seen, port: buffer.readUInt16BE(size - 2) })
      const host = byAddress[seen] ?? seen
      const rest = buffer.subarray(size)
      if (host === 'fail.test') return socket.end(Buffer.from(reply(5)))
      if (host === 'deny.test') return socket.end(Buffer.from(reply(2)))
      if (host === 'odd.test') return socket.end(Buffer.from(reply(0x23)))
      if (host === 'version.test') return socket.end(Buffer.from([4, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
      if (host === 'bnd6.test') socket.write(Buffer.from([5, 0, 0, 4, ...Array(16).fill(0), 0, 0]))
      else if (host === 'bnd3.test') socket.write(Buffer.from([5, 0, 0, 3, 4, ...Buffer.from('host'), 0, 0]))
      else socket.write(Buffer.from(reply(0)))
      socket.write('EXTRA')
      if (rest.length) socket.write(rest)
      socket.on('data', more => socket.write(more))
      socket.on('end', () => socket.end())
    }
    socket.on('data', read)
  }))
  const socksPort = await listen(socksUpstream())
  const viaSocks = await inProcess({ lookup, interfaces }, { upstream: { kind: 'socks5', host: 'localhost', port: socksPort, bypass: [] } })
  for (const [target, seenAs] of [[{ atyp: 3, host: 'ok.test', port: 443 }, { atyp: 1, host: '93.184.216.34', port: 443 }], [{ atyp: 1, host: '93.184.216.34', port: 80 }, { atyp: 1, host: '93.184.216.34', port: 80 }],
    [{ atyp: 4, host: '2001:db8::5', port: 443 }, { atyp: 4, host: '20010db8000000000000000000000005', port: 443 }], [{ atyp: 3, host: 'bnd6.test', port: 443 }, { atyp: 1, host: '198.51.100.40', port: 443 }], [{ atyp: 3, host: 'bnd3.test', port: 443 }, { atyp: 1, host: '198.51.100.41', port: 443 }]]) {
    const c = await expectReply(await socks(viaSocks.port, target!), 0, `SOCKS5 upstream ${target!.host}`)
    await until(() => c.bytes.length >= 17, 'upstream extra bytes')
    assert.equal(c.bytes.subarray(12, 17).toString(), 'EXTRA')
    await echoes(c)
    assert.deepEqual(socksSeen.at(-1), seenAs)
    assert.deepEqual(socksSeen.at(-2), { greeting: [5, 1, 0] }, 'no-auth greeting only')
  }
  for (const [host, rep] of [['fail.test', 5], ['deny.test', 2], ['odd.test', 1], ['version.test', 1]] as [string, number][]) await expectReply(await socks(viaSocks.port, { atyp: 3, host, port: 443 }), rep, `SOCKS5 upstream reply for ${host}`)
  assert.ok(socksSeen.every(seen => seen.atyp !== 3), 'a SOCKS5 upstream never gets a name (ATYP 3)')
  await shut(viaSocks)
  const authPort = await listen(socksUpstream([5, 0xff]))
  const authOnly = await inProcess({ lookup, interfaces }, { upstream: { kind: 'socks5', host: '127.0.0.1', port: authPort, bypass: [] } })
  await expectReply(await socks(authOnly.port, { atyp: 3, host: 'ok.test', port: 443 }), 1, 'an upstream that wants credentials')
  await shut(authOnly)
  const down = await inProcess({ lookup, interfaces }, { upstream: { kind: 'http', host: '127.0.0.1', port: await deadPort(), bypass: [] } })
  await expectReply(await socks(down.port, { atyp: 3, host: 'ok.test', port: 443 }), 5, 'upstream refused')
  await shut(down)
  const everything = await inProcess({ lookup, interfaces, connect }, { upstream: { kind: 'http', host: '127.0.0.1', port: httpPort, bypass: ['*'] } })
  const star = await expectReply(await socks(everything.port, { atyp: 3, host: 'ok.test', port: 80 }), 0)
  await until(() => star.bytes.length >= 18)
  assert.equal(star.bytes.subarray(12, 18).toString(), 'DIRECT', "'*' bypasses everything")
  await shut(everything)

  const plainOut = await inProcess({ lookup, interfaces, connect })
  const leaving = await expectReply(await socks(plainOut.port, { atyp: 3, host: 'other.test', port: 80 }), 0, 'no upstream: direct')
  await until(() => leaving.bytes.length >= 18)
  assert.equal(leaving.bytes.subarray(12, 18).toString(), 'DIRECT')
  await expectReply(await socks(plainOut.port, { atyp: 3, host: 'missing.test', port: 80 }), 4, 'DNS failure without upstream')
  const slowNo = Date.now()
  await expectReply(await socks(plainOut.port, { atyp: 3, host: 'slow.test', port: 80 }), 4, 'DNS deadline without upstream')
  assert.ok(Date.now() - slowNo >= FAST.lookup - 20 && Date.now() - slowNo < 2000)
  lookupCalls = []
  const pair = await Promise.all([socks(plainOut.port, { atyp: 3, host: 'same.test', port: 80 }), socks(plainOut.port, { atyp: 3, host: 'same.test', port: 81 })])
  for (const c of pair) await expectReply(c, 0, 'coalesced lookup')
  assert.deepEqual(lookupCalls, ['same.test'], 'concurrent lookups of one name share one query')
  for (const [host, rep] of [['refused.test', 5], ['unreach.test', 4], ['perm.test', 1], ['agg.test', 5]] as [string, number][]) await expectReply(await socks(plainOut.port, { atyp: 3, host, port: 80 }), rep, `direct ${host}`)
  const hangAt = Date.now()
  await expectReply(await socks(plainOut.port, { atyp: 3, host: 'hang.test', port: 80 }), 4, 'connect deadline')
  assert.ok(Date.now() - hangAt >= FAST.connect - 20)
  const viaReal = await expectReply(await socks(plainOut.port, { atyp: 3, host: 'pinned.test', port: 80 }), 0, 'real dialer with the pinned lookup')
  await until(() => viaReal.bytes.length >= 18)
  const realLookup = dials.find(dial => dial.realLookup)
  assert.equal(realLookup.realLookup, 'pinned.test')
  assert.equal(realLookup.opts.all, true, 'Node asks the pinned lookup for every address (Happy Eyeballs)')
  assert.deepEqual(realLookup.list, [{ address: '198.51.100.36', family: 4 }], 'and gets only the checked addresses, without a second DNS query')
  assert.equal(lookupCalls.filter(name => name === 'pinned.test').length, 1)
  await shut(plainOut)
  // An upstream it can't use (https://, here at the HTTP fixture's address) is left out: direct, as with none.
  const upstreamDialsBefore = dials.filter(dial => dial === 'upstream').length, connectsBefore = connects.length
  const leftOut = await inProcess({ lookup, interfaces, connect }, { upstream: { kind: 'https', host: '127.0.0.1', port: httpPort, bypass: [] } })
  assert.deepEqual(leftOut.rows, [{ state: 'upstream', reason: 'INVALID_UPSTREAM' }], 'said once, after ready')
  const around = await expectReply(await socks(leftOut.port, { atyp: 3, host: 'other.test', port: 80 }), 0, 'an unusable upstream: direct')
  await until(() => around.bytes.length >= 18)
  assert.equal(around.bytes.subarray(12, 18).toString(), 'DIRECT')
  assert.deepEqual([dials.filter(dial => dial === 'upstream').length, connects.length], [upstreamDialsBefore, connectsBefore], 'nothing went to it')
  assert.deepEqual(leftOut.rows, [{ state: 'upstream', reason: 'INVALID_UPSTREAM' }], 'and never again')
  await shut(leftOut)
  const stuck = await inProcess({ connect: (options: ConnectOptions) => options.host === '127.0.0.1' ? new net.Socket() : net.connect(options) })
  await configure(stuck, { 3000: echoPort })
  await expectReply(await socks(stuck.port, loopbackTo(3000)), 5, 'a route that never connects')
  await shut(stuck)
  console.log('ok outbound: HTTP CONNECT and SOCKS5 upstreams given checked addresses only (a name at its local answer here; IPv4/IPv6 literals as they are; unresolvable names refused 04, never by name), extra bytes, non-2xx/huge/garbage/drop/auth/REP failures, upstream down 05, an unusable one left out (direct); bypass names with subdomains/.suffix/*.suffix/IP/CIDR/* direct (first 64 usable entries, overlong ignored), never opening the local network; loopback and own never upstream; DNS 04/deadline/coalescing; pinned addresses; error mapping 05/04/01')
}

async function localNetworkChecks() {
  const echo = echoServer(), echoPort = await listen(echo)
  const direct = track(net.createServer({ allowHalfOpen: true }, socket => { socket.write('DIRECT'); socket.on('data', bytes => socket.write(bytes)); socket.on('end', () => socket.end()) }))
  const directPort = await listen(direct)
  let upstreamHits = 0
  const upstream = track(net.createServer(socket => { upstreamHits++; socket.once('data', () => socket.end('HTTP/1.1 200 Connection established\r\n\r\nUPSTREAM')) }))
  const upstreamPort = await listen(upstream)
  // RFC1918, CGNAT, link-local/metadata, IETF protocol assignments (always), multicast, reserved, cloud metadata.
  const blocked4 = ['10.1.2.3', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.1', '100.64.0.1', '100.127.255.254', '169.254.169.254', '169.254.1.1', '192.0.0.1', '192.0.0.8', '192.0.0.170', '192.0.0.255', '224.0.0.251', '239.255.255.250', '240.0.0.1', '255.255.255.255', '100.100.100.200', '168.63.129.16']
  // ULA, link-local, site-local, multicast, AWS metadata, local NAT64, and IPv4 behind NAT64/compat/SIIT.
  const blocked6 = ['fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', 'ff05::fb', 'fd00:ec2::254', '64:ff9b:1::1', '64:ff9b::a9fe:a9fe', '64:ff9b::a01:203', '64:ff9b::7f00:1', '64:ff9b::c000:aa', '::a01:203', '::ffff:0:a01:203']
  const open4 = ['172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.255.255', '223.255.255.255', '192.169.0.1', '191.255.255.255', '192.0.1.1', '198.18.0.5'], open6 = ['fbff::1', '2001:db8::5', '64:ff9b::5db8:d822']
  const hex = (ip: string) => { const b = ip.split('.').map(Number); return `${(b[0]! << 8 | b[1]!).toString(16)}:${(b[2]! << 8 | b[3]!).toString(16)}` }
  const names: Record<string, any> = { 'mixed.test': ['192.168.1.10', '93.184.216.34', 'fe80::1', '2001:db8::5', '169.254.169.254'], 'nas.test': ['192.168.1.10', 'fd00::10'], 'loop-lan.test': ['192.168.1.1', '127.0.0.1'], 'own-lan.test': ['192.168.1.5'], 'meta-lan.test': ['169.254.169.254', '192.168.1.20'],
    'public.test': ['93.184.216.34'], 'own-mixed.test': ['93.184.216.34', '192.168.1.5'], 'link-mixed.test': ['93.184.216.34', 'fe80::1'], 'proto-mixed.test': ['93.184.216.34', '192.0.0.8'], 'public-private.test': ['93.184.216.34', '10.0.0.7'] }
  blocked4.forEach((ip, i) => { names[`b4-${i}.test`] = [ip] }); blocked6.forEach((ip, i) => { names[`b6-${i}.test`] = [ip] })
  // A rebinding name: each lookup gets the next answer.
  const rebinding = [['93.184.216.34', '10.0.0.7'], ['93.184.216.34'], ['10.0.0.7', '93.184.216.34']]
  let rebindAt = 0
  const lookup = (name: string, _options: any, callback: LookupCallback) => {
    const list = name === 'rebind.test' ? rebinding[rebindAt++ % rebinding.length] : names[name]
    setImmediate(() => list ? callback(null, list.map((address: any) => ({ address, family: net.isIP(address) }))) : callback(Object.assign(new Error('not found'), { code: 'ENOTFOUND' })))
  }
  const interfaces = () => ({ en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false }] })
  const dials: any[] = []
  const connect = (options: ConnectOptions) => {
    if (options.host === '127.0.0.1') { dials.push(options.port === upstreamPort ? 'upstream' : 'route'); return net.connect(options) }
    let pinned
    options.lookup?.(options.host!, { all: true }, (_error: unknown, list: any) => { pinned = list })
    dials.push({ host: options.host, pinned })
    return net.connect({ host: '127.0.0.1', port: directPort, allowHalfOpen: true })
  }
  const opened = async (instance: Instance, target: Aim, label: string) => {
    const c = await expectReply(await socks(instance.port, { port: 80, ...target }), 0, label)
    await until(() => c.bytes.length >= 18, `${label}: first bytes`)
    return c.bytes.subarray(12, 18).toString()
  }
  // One instance with a long window: exactly one lan row however many refusals.
  const p = await inProcess({ lookup, interfaces, connect, timeouts: { ...FAST, lanEvery: 60_000 } })
  await configure(p, { 3000: echoPort })
  const refusedForms: any[] = []
  blocked4.forEach((ip, i) => refusedForms.push({ atyp: 1, host: ip }, { atyp: 3, host: ip }, { atyp: 4, host: `::ffff:${hex(ip)}` }, { atyp: 3, host: `::ffff:${ip}` }, { atyp: 3, host: `b4-${i}.test` }))
  blocked6.forEach((ip, i) => refusedForms.push({ atyp: 4, host: ip }, { atyp: 3, host: ip }, { atyp: 3, host: `b6-${i}.test` }))
  for (const target of refusedForms) await expectReply(await socks(p.port, { ...target, port: 80 }), 2, `local network ${target.host} (ATYP ${target.atyp})`)
  assert.deepEqual(dials, [], 'nothing on the local network was dialled')
  assert.deepEqual(p.rows, [{ state: 'lan' }], 'one bare lan row: no address, no name')
  for (const host of open4) assert.equal(await opened(p, { atyp: 1, host }, `public ${host}`), 'DIRECT')
  for (const host of open6) assert.equal(await opened(p, { atyp: 4, host }, `public ${host}`), 'DIRECT')
  assert.equal(await opened(p, { atyp: 3, host: 'mixed.test' }, 'mixed resolution'), 'DIRECT')
  assert.deepEqual((dials as any[]).find((dial: any) => dial.host === 'mixed.test')!.pinned, [{ address: '93.184.216.34', family: 4 }, { address: '2001:db8::5', family: 6 }], 'only the public addresses are dialled')
  await expectReply(await socks(p.port, { atyp: 3, host: 'nas.test', port: 80 }), 2, 'a name with only local addresses')
  const rowsBefore = p.rows.length
  await expectReply(await socks(p.port, { atyp: 3, host: 'loop-lan.test', port: 3000 }), 2, 'a name pointing at loopback is refused, whatever else it gives')
  assert.ok(!dials.some((dial: any) => dial === 'route' || dial.host === 'loop-lan.test'), 'and never dialled')
  for (const target of [{ atyp: 1, host: '192.168.1.5' }, { atyp: 4, host: '::ffff:c0a8:105' }, { atyp: 4, host: '64:ff9b::c0a8:105' }, { atyp: 3, host: 'own-lan.test' }]) await expectReply(await socks(p.port, { ...target, port: 80 }), 2, `own ${target.host}`)
  assert.equal(p.rows.length, rowsBefore, 'own addresses stay silent')
  await shut(p)

  // An upstream and bypass entries for the very ranges cannot reopen them.
  const tunnelled = await inProcess({ lookup, interfaces, connect, timeouts: { ...FAST, lanEvery: 60_000 } }, { upstream: { kind: 'http', host: '127.0.0.1', port: upstreamPort, bypass: ['10.0.0.0/8', '192.168.0.0/16', '169.254/16', 'fe80::/10', '*.test', 'nas.test'] } })
  for (const target of [{ atyp: 1, host: '192.168.1.1' }, { atyp: 1, host: '169.254.169.254' }, { atyp: 4, host: 'fe80::1' }, { atyp: 3, host: 'nas.test' }, { atyp: 3, host: 'b4-7.test' }, { atyp: 1, host: '192.0.0.8' }]) await expectReply(await socks(tunnelled.port, { ...target, port: 80 }), 2, `${target.host} with an upstream`)
  assert.equal(upstreamHits, 0, 'a refused target never reaches the upstream')
  // Bypassed (direct), a mixed name is still dialled only at its checked public addresses.
  assert.equal(await opened(tunnelled, { atyp: 3, host: 'mixed.test' }, 'a bypassed mixed name'), 'DIRECT')
  assert.deepEqual(dials.at(-1), { host: 'mixed.test', pinned: [{ address: '93.184.216.34', family: 4 }, { address: '2001:db8::5', family: 6 }] })
  await shut(tunnelled)

  // Through an upstream, any refused address in the local answer refuses the name:
  // the upstream looks it up again and could take exactly that address.
  const upstreamed = async (instance: Instance, host: string, label: string) => {
    const c = await expectReply(await socks(instance.port, { atyp: 3, host, port: 443 }), 0, label)
    await until(() => c.bytes.length >= 20, `${label}: upstream bytes`)
    c.client.destroy()
    return c.bytes.subarray(12, 20).toString()
  }
  const directBefore = dials.filter(dial => typeof dial === 'object').length
  const viaUpstream = await inProcess({ lookup, interfaces, connect, timeouts: { ...FAST, lanEvery: 60_000 } }, { upstream: { kind: 'http', host: '127.0.0.1', port: upstreamPort, bypass: [] } })
  for (const host of ['mixed.test', 'meta-lan.test', 'link-mixed.test', 'proto-mixed.test', 'public-private.test', 'nas.test']) await expectReply(await socks(viaUpstream.port, { atyp: 3, host, port: 443 }), 2, `${host} through an upstream`)
  assert.deepEqual(viaUpstream.rows, [{ state: 'lan' }], 'the same bare lan row')
  await expectReply(await socks(viaUpstream.port, { atyp: 3, host: 'own-mixed.test', port: 443 }), 2, 'an own address in the answer')
  assert.deepEqual(viaUpstream.rows, [{ state: 'lan' }], 'own stays silent')
  assert.equal(upstreamHits, 0, 'none of them reached the upstream')
  // A rebinding name is judged by each answer it gives, never by an earlier good one.
  rebindAt = 0
  await expectReply(await socks(viaUpstream.port, { atyp: 3, host: 'rebind.test', port: 443 }), 2, 'rebind: public and private')
  assert.equal(await upstreamed(viaUpstream, 'rebind.test', 'rebind: public only'), 'UPSTREAM')
  await expectReply(await socks(viaUpstream.port, { atyp: 3, host: 'rebind.test', port: 443 }), 2, 'rebind: private first')
  assert.equal(upstreamHits, 1)
  assert.equal(await upstreamed(viaUpstream, 'public.test', 'a public name'), 'UPSTREAM')
  await expectReply(await socks(viaUpstream.port, { atyp: 3, host: 'unknown.test', port: 443 }), 4, 'a name with no checked address is refused, never sent by name')
  assert.equal(upstreamHits, 2)
  await shut(viaUpstream)
  // lan: true opens private addresses for the upstream too, never the rest.
  const lanUp = await inProcess({ lookup, interfaces, connect, timeouts: { ...FAST, lanEvery: 60_000 } }, { lan: true, upstream: { kind: 'http', host: '127.0.0.1', port: upstreamPort, bypass: [] } })
  for (const host of ['nas.test', 'public-private.test']) assert.equal(await upstreamed(lanUp, host, `lan: true, ${host} through an upstream`), 'UPSTREAM')
  for (const host of ['mixed.test', 'meta-lan.test', 'link-mixed.test', 'proto-mixed.test']) await expectReply(await socks(lanUp.port, { atyp: 3, host, port: 443 }), 2, `lan: true still refuses ${host} through an upstream`)
  assert.deepEqual(lanUp.rows, [{ state: 'lan' }])
  assert.equal(upstreamHits, 4)
  assert.equal(dials.filter(dial => typeof dial === 'object').length, directBefore, 'nothing went direct')
  await shut(lanUp)

  // lan: true opens the private ranges only.
  const lan = await inProcess({ lookup, interfaces, connect, timeouts: { ...FAST, lanEvery: 60_000 } }, { lan: true })
  for (const target of [{ atyp: 1, host: '192.168.1.1' }, { atyp: 1, host: '10.1.2.3' }, { atyp: 1, host: '172.16.0.1' }, { atyp: 1, host: '100.64.0.1' }, { atyp: 4, host: 'fd12:3456::1' }, { atyp: 4, host: '::ffff:a01:203' }, { atyp: 3, host: 'nas.test' }]) {
    assert.equal(await opened(lan, target, `lan: true opens ${target.host}`), 'DIRECT')
  }
  assert.equal(await opened(lan, { atyp: 3, host: 'meta-lan.test' }, 'metadata filtered out of a name'), 'DIRECT')
  assert.deepEqual((dials as any[]).find((dial: any) => dial.host === 'meta-lan.test')!.pinned, [{ address: '192.168.1.20', family: 4 }])
  for (const target of [{ atyp: 1, host: '169.254.169.254' }, { atyp: 4, host: 'fe80::1' }, { atyp: 1, host: '224.0.0.1' }, { atyp: 1, host: '255.255.255.255' }, { atyp: 1, host: '100.100.100.200' }, { atyp: 4, host: 'fd00:ec2::254' }, { atyp: 1, host: '168.63.129.16' }, { atyp: 4, host: '64:ff9b::a9fe:a9fe' }, { atyp: 4, host: 'fec0::1' },
    { atyp: 1, host: '192.0.0.170' }, { atyp: 4, host: '64:ff9b::c000:aa' }]) {
    await expectReply(await socks(lan.port, { ...target, port: 80 }), 2, `lan: true keeps ${target.host} shut`)
  }
  assert.deepEqual(lan.rows, [{ state: 'lan' }])
  const lanRows = lan.rows.length
  for (const target of [{ atyp: 1, host: '192.168.1.5' }, { atyp: 4, host: '64:ff9b::c0a8:105' }]) await expectReply(await socks(lan.port, { ...target, port: 80 }), 2, `lan: true never opens the Guest's own ${target.host}`)
  assert.equal(lan.rows.length, lanRows)
  await shut(lan)

  // The row repeats only after its window.
  const windowed = await inProcess({ lookup, interfaces, connect })
  for (let i = 0; i < 3; i++) await expectReply(await socks(windowed.port, { atyp: 1, host: '192.168.1.1', port: 80 }), 2)
  assert.deepEqual(windowed.rows, [{ state: 'lan' }])
  await pause(FAST.lanEvery)
  await expectReply(await socks(windowed.port, { atyp: 1, host: '10.9.9.9', port: 80 }), 2)
  assert.deepEqual(windowed.rows, [{ state: 'lan' }, { state: 'lan' }])
  await shut(windowed)
  console.log(`ok local network: ${refusedForms.length} refusals (RFC1918, CGNAT, link-local/metadata, 192.0.0.0/24, multicast, reserved, ULA, fe80/fec0/ff00, NAT64/compat/SIIT; literal, text, mapped, resolved) never dialled; mixed names pinned to public addresses direct, refused through an upstream (rebinding answers judged one by one; unresolvable names refused); bypass cannot reopen; lan: true opens only private ranges; own addresses silent; one bare lan row per window`)
}

async function onLinkChecks() {
  const direct = track(net.createServer({ allowHalfOpen: true }, socket => { socket.write('DIRECT'); socket.on('data', bytes => socket.write(bytes)); socket.on('end', () => socket.end()) }))
  const directPort = await listen(direct)
  let upstreamHits = 0
  const upstream = track(net.createServer(socket => { upstreamHits++; socket.once('data', () => socket.end('HTTP/1.1 200 Connection established\r\n\r\nUPSTREAM')) }))
  const upstreamPort = await listen(upstream)
  const table = {
    lo0: [iface('127.0.0.1', '127.0.0.1/8', true), iface('::1', '::1/128', true), iface('fe80::1', 'fe80::1/64', true)],
    // A global IPv6 /64 (two addresses in it), a public IPv4 /16, and a VM bridge inside 198.18/15 (OrbStack's).
    en0: [iface('2001:db8:1:2::5', '2001:db8:1:2::5/64'), iface('2001:db8:1:2:a:b:c:d', '2001:db8:1:2:a:b:c:d/64'), iface('18.10.0.5', '18.10.0.5/16')],
    bridge100: [iface('198.19.249.3', '198.19.249.3/24')],
    // Tunnels: their subnets don't count; their addresses are still this computer's.
    utun4: [iface('17.57.0.10', '17.57.0.10/16'), iface('2001:db8:aaaa::10', '2001:db8:aaaa::10/48')],
    tun0: [iface('23.1.0.2', '23.1.0.2/16')], ppp0: [iface('24.1.0.2', '24.1.0.2/16')], ipsec0: [iface('25.1.0.2', '25.1.0.2/16')], gif0: [iface('26.1.0.2', '26.1.0.2/16')], stf0: [iface('2002:1a01:2::1', '2002:1a01:2::1/48')],
    // Too wide to count: IPv4 under /8 and IPv6 under /32 (a /8 and a /32 do count).
    en5: [iface('33.0.0.9', '33.0.0.9/4'), iface('45.0.0.9', '45.0.0.9/7'), iface('44.0.0.9', '44.0.0.9/8'), iface('2a00:1::7', '2a00:1::7/16'), iface('2a02:1::7', '2a02:1::7/31'), iface('2a01:4f8::7', '2a01:4f8::7/32')],
    // Odd entries are skipped, never fatal.
    junk: [iface('50.0.0.1', null), iface('51.0.0.1', 'garbage'), iface('52.0.0.1', '52.0.0.1/33'), iface('53.0.0.1', 42), { address: '54.0.0.1', family: 'IPv4' }, iface('55.0.0.1', '55.0.0.1/ 16'), iface('fe80::9', 'fe80::9%en0/64'), null, 7],
    weird: 'not a list',
  }
  let reads = 0
  const interfaces = () => { reads++; return table }
  const names: Record<string, any> = { 'neighbor6.test': ['2001:db8:1:2::1'], 'neighbor4.test': ['18.10.200.7'], 'vm.test': ['198.19.249.204'], 'mixed-onlink.test': ['93.184.216.34', '18.10.0.9'], 'public.test': ['93.184.216.34'] }
  const lookup = (name: string, _options: any, callback: LookupCallback) => setImmediate(() => names[name] ? callback(null, names[name].map((address: any) => ({ address, family: net.isIP(address) }))) : callback(Object.assign(new Error('not found'), { code: 'ENOTFOUND' })))
  const dials: any[] = []
  const connect = (options: ConnectOptions) => {
    if (options.host === '127.0.0.1') { dials.push(options.port === upstreamPort ? 'upstream' : 'route'); return net.connect(options) }
    let pinned
    options.lookup?.(options.host!, { all: true }, (_error: unknown, list: any) => { pinned = list })
    dials.push({ host: options.host, pinned })
    return net.connect({ host: '127.0.0.1', port: directPort, allowHalfOpen: true })
  }
  const opened = async (instance: Instance, target: Aim, label: string) => {
    const c = await expectReply(await socks(instance.port, { port: 80, ...target }), 0, label)
    await until(() => c.bytes.length >= 18, `${label}: first bytes`)
    c.client.destroy()
    return c.bytes.subarray(12, 18).toString()
  }
  const atypOf = (ip: string) => net.isIPv4(ip) ? 1 : 4
  const onLink = [{ atyp: 4, host: '2001:db8:1:2::1' }, { atyp: 3, host: '[2001:db8:1:2::1]' }, { atyp: 3, host: '2001:DB8:1:2:0:0:0:1' }, { atyp: 4, host: '2001:db8:1:2:ffff:ffff:ffff:ffff' }, { atyp: 3, host: 'neighbor6.test' },
    { atyp: 1, host: '18.10.200.7' }, { atyp: 1, host: '18.10.0.0' }, { atyp: 1, host: '18.10.255.255' }, { atyp: 3, host: '::ffff:18.10.200.7' }, { atyp: 4, host: '64:ff9b::120a:c807' }, { atyp: 3, host: 'neighbor4.test' },
    { atyp: 1, host: '198.19.249.204', port: 22 }, { atyp: 1, host: '198.19.249.1' }, { atyp: 1, host: '198.19.249.255' }, { atyp: 3, host: 'vm.test', port: 22 },
    { atyp: 1, host: '44.200.0.1' }, { atyp: 4, host: '2a01:4f8:ffff::1' }]
  const own = ['2001:db8:1:2::5', '2001:db8:1:2:a:b:c:d', '18.10.0.5', '198.19.249.3', '17.57.0.10', '2001:db8:aaaa::10', '23.1.0.2', '2002:1a01:2::1', '33.0.0.9', '44.0.0.9', '2a00:1::7', '50.0.0.1', '54.0.0.1', 'fe80::9']
  // Beside the subnets, in tunnels' subnets, or in ones too wide or too odd to count.
  const open = ['18.11.0.1', '18.9.255.255', '198.19.248.255', '198.19.250.1', '198.18.0.5', '17.57.1.1', '23.1.9.9', '24.1.9.9', '25.1.9.9', '26.1.9.9', '40.1.2.3', '45.1.1.1', '50.0.0.2', '51.0.0.2', '52.0.0.2', '53.0.0.2', '55.0.0.2',
    '2001:db8:1:3::1', '2001:db8:1:1:ffff:ffff:ffff:ffff', '2001:db8:aaaa::1', '2002:1a01:2::9', '2a00:1:ffff::1', '2a02:0:ffff::1']
  const p = await inProcess({ lookup, interfaces, connect, timeouts: { ...FAST, lanEvery: 60_000 } })
  for (const target of onLink) await expectReply(await socks(p.port, { port: 80, ...target }), 2, `on-link ${target.host}`)
  assert.deepEqual(dials, [], 'nothing on-link was dialled')
  assert.deepEqual(p.rows, [{ state: 'lan' }], 'on-link refusals use the bare lan row')
  for (const ip of own) await expectReply(await socks(p.port, { atyp: atypOf(ip), host: ip, port: 80 }), 2, `own ${ip}`)
  assert.deepEqual(p.rows, [{ state: 'lan' }], 'own addresses stay silent, tunnels and odd entries included')
  for (const ip of open) {
    assert.equal(await opened(p, { atyp: atypOf(ip), host: ip }, `not on-link: ${ip}`), 'DIRECT')
    assert.deepEqual((dials as any[]).at(-1)!.pinned, [{ address: ip, family: net.isIP(ip) }])
  }
  assert.equal(await opened(p, { atyp: 3, host: 'mixed-onlink.test' }, 'a name with an on-link address, direct'), 'DIRECT')
  assert.deepEqual((dials as any[]).at(-1)!.pinned, [{ address: '93.184.216.34', family: 4 }], 'dialled only at its other address')
  assert.equal(reads, 1, 'one interface read serves every request within its window')
  await shut(p)

  const lan = await inProcess({ lookup, interfaces, connect }, { lan: true })
  for (const target of [{ atyp: 4, host: '2001:db8:1:2::1' }, { atyp: 1, host: '18.10.200.7' }, { atyp: 1, host: '198.19.249.204', port: 22 }, { atyp: 3, host: 'vm.test', port: 22 }, { atyp: 4, host: '64:ff9b::120a:c807' }, { atyp: 3, host: 'mixed-onlink.test' }]) {
    assert.equal(await opened(lan, target, `lan: true opens on-link ${target.host}`), 'DIRECT')
  }
  assert.deepEqual((dials as any[]).at(-1)!.pinned, [{ address: '93.184.216.34', family: 4 }, { address: '18.10.0.9', family: 4 }])
  for (const ip of own) await expectReply(await socks(lan.port, { atyp: atypOf(ip), host: ip, port: 80 }), 2, `lan: true never opens own ${ip}`)
  assert.deepEqual(lan.rows, [])
  await shut(lan)

  const up = await inProcess({ lookup, interfaces, connect, timeouts: { ...FAST, lanEvery: 60_000 } }, { upstream: { kind: 'http', host: '127.0.0.1', port: upstreamPort, bypass: [] } })
  for (const target of [{ atyp: 3, host: 'mixed-onlink.test' }, { atyp: 3, host: 'neighbor6.test' }, { atyp: 3, host: 'vm.test' }, { atyp: 1, host: '18.10.200.7' }, { atyp: 4, host: '2001:db8:1:2::1' }]) {
    await expectReply(await socks(up.port, { port: 443, ...target }), 2, `${target.host} through an upstream`)
  }
  assert.equal(upstreamHits, 0, 'on-link targets never reach the upstream')
  assert.deepEqual(up.rows, [{ state: 'lan' }])
  const tunnel = await expectReply(await socks(up.port, { atyp: 3, host: 'public.test', port: 443 }), 0, 'a public name through the upstream')
  await until(() => tunnel.bytes.length >= 20, 'upstream bytes')
  assert.equal(tunnel.bytes.subarray(12, 20).toString(), 'UPSTREAM')
  assert.equal(upstreamHits, 1)
  await shut(up)

  // At most one read per timeouts.interfaces (30 s by default); a read that throws is never kept.
  assert.equal(proxy.TIMEOUTS.interfaces, 30_000)
  const WINDOW = 1000, readsAt: any[] = [], after = (at: number) => pause(Math.max(0, at + WINDOW + 20 - performance.now()))
  // What os.networkInterfaces() answers now: interfaces, or an Error it throws.
  let current: any = { en0: [iface('203.0.113.10', '203.0.113.10/24')] }
  const changing = await inProcess({ connect, timeouts: { ...FAST, interfaces: WINDOW, lanEvery: 0 }, interfaces: () => { readsAt.push(performance.now()); if (current instanceof Error) throw current; return current } })
  assert.equal(await opened(changing, { atyp: 1, host: '198.51.100.7' }, 'before a new interface'), 'DIRECT')
  await expectReply(await socks(changing.port, { atyp: 1, host: '203.0.113.99', port: 80 }), 2, 'the first reading')
  current = { en0: [iface('203.0.113.10', '203.0.113.10/24')], en1: [iface('198.51.100.5', '198.51.100.5/24')] }
  assert.equal(await opened(changing, { atyp: 1, host: '198.51.100.7' }, 'within the window the first reading holds'), 'DIRECT')
  assert.equal(await opened(changing, { atyp: 1, host: '198.51.100.5' }, 'for own addresses too'), 'DIRECT')
  assert.ok(performance.now() - readsAt[0] < WINDOW, 'still inside the window')
  assert.equal(readsAt.length, 1)
  await after(readsAt[0])
  await expectReply(await socks(changing.port, { atyp: 1, host: '198.51.100.7', port: 80 }), 2, 'after the window the new subnet counts')
  await expectReply(await socks(changing.port, { atyp: 1, host: '198.51.100.5', port: 80 }), 2, 'and the new own address')
  assert.equal(readsAt.length, 2)
  assert.deepEqual(changing.rows, [{ state: 'lan' }, { state: 'lan' }])
  current = new Error('unavailable')
  await after(readsAt[1])
  for (let i = 0; i < 2; i++) await expectReply(await socks(changing.port, { atyp: 1, host: '93.184.216.34', port: 80 }), 1, 'a read that throws fails closed, and is tried again')
  assert.equal(readsAt.length, 4)
  current = { en0: [iface('203.0.113.10', '203.0.113.10/24')] }
  assert.equal(await opened(changing, { atyp: 1, host: '198.51.100.7' }, 'a read that works again'), 'DIRECT')
  assert.equal(readsAt.length, 5)
  await shut(changing)

  // Real interfaces: a neighbor in each public on-link subnet (a global IPv6 /64 is common) is refused.
  const isPublic = (ip: string) => net.isIPv4(ip) ? !/^(?:10|127|0)\.|^169\.254\.|^192\.168\.|^192\.0\.0\.|^172\.(?:1[6-9]|2[0-9]|3[01])\.|^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|^(?:22[4-9]|2[3-5][0-9])\./.test(ip) : /^[23]/.test(ip)
  const publicSubnets = Object.entries(os.networkInterfaces()).filter(([name]) => !/^(?:utun|tun|ppp|ipsec|gif|stf)/.test(name)).flatMap(([, list]) => list ?? [])
    .filter(entry => entry && !entry.internal && typeof entry.cidr === 'string' && !entry.address.includes('%') && isPublic(entry.address))
    .filter(entry => { const bits = Number(entry.cidr!.split('/')[1]); return net.isIPv4(entry.address) ? bits >= 8 && bits <= 31 : bits >= 32 && bits <= 127 })
  if (!publicSubnets.length) console.log('SKIP real public on-link refusal (no public on-link subnet here: every subnet is private, link-local or a tunnel)')
  else {
    const real = await inProcess({ connect: () => { throw new Error('must not dial') } })
    for (const entry of publicSubnets) await expectReply(await socks(real.port, { ...neighborOf(entry.address), port: 80 }), 2, 'a real on-link neighbor')
    assert.ok(real.rows.every(row => row.state === 'lan'))
    await shut(real)
  }
  console.log(`ok on-link subnets from interface cidr: a global IPv6 /64, a public IPv4 /16 and a VM bridge in 198.19/16 refused with the bare lan row (literal, text, mapped, NAT64, resolved; never dialled or upstream), opened by lan: true; own addresses silent; tunnels (utun/tun/ppp/ipsec/gif/stf), IPv4 wider than /8, IPv6 wider than /32 and odd entries ignored; mixed names pinned direct; one read per window, a failed read never kept${publicSubnets.length ? `; ${publicSubnets.length} real public subnet(s)` : ''}`)
}

async function numericNameChecks() {
  const direct = track(net.createServer({ allowHalfOpen: true }, socket => { socket.write('DIRECT'); socket.on('data', bytes => socket.write(bytes)); socket.on('end', () => socket.end()) }))
  const directPort = await listen(direct)
  let upstreamHits = 0
  const upstream = track(net.createServer(socket => { upstreamHits++; socket.once('data', () => socket.end('HTTP/1.1 200 Connection established\r\n\r\nUPSTREAM')) }))
  const upstreamPort = await listen(upstream)
  const lookups: any[] = [], dials: any[] = []
  const lookup = (name: string, _options: any, callback: LookupCallback) => { lookups.push(name); setImmediate(() => callback(null, [{ address: '93.184.216.34', family: 4 }])) }
  const connect = (options: ConnectOptions) => {
    dials.push(options.host === '127.0.0.1' && options.port === upstreamPort ? 'upstream' : options.host)
    return net.connect(options.host === '127.0.0.1' ? options : { host: '127.0.0.1', port: directPort, allowHalfOpen: true })
  }
  // What inet_aton or a URL parser reads as IPv4, other than canonical dotted-decimal.
  const spellings = ['012.0.0.1', '0x0a.0.0.1', '0X0A.0.0.1', '10.1', '10.0.1', '127.1', '0x7f.1', '0x7f000001', '017700000001', '2130706433', '4294967295', '4294967296', '0', '00', '0x',
    '1.2.3.4.', '127.0.0.1.', '0.0.0.0.', '10.0.0.1.', '93.184.216.34.', '0x7f.0.0.1.', '01.02.03.04', '1.2.3.04', '1.2.3.0x4', '08.1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.256', 'foo.123', 'foo.0x1f', 'a.b.0x', 'example.com.123']
  const upstreamWith = (bypass: unknown) => ({ kind: 'http', host: '127.0.0.1', port: upstreamPort, bypass })
  for (const [label, upstream] of [['direct', null], ['upstream', upstreamWith([])], ["bypass '*'", upstreamWith(['*'])]]) {
    const p = await inProcess({ lookup, connect, interfaces: () => ({}) }, { upstream })
    for (const host of spellings) await expectReply(await socks(p.port, { atyp: 3, host, port: 80 }), 4, `${host} (${label})`)
    assert.deepEqual([lookups, dials, p.rows], [[], [], []], `${label}: refused before any lookup, dial or upstream, silently`)
    // Names only partly numeric still resolve, and canonical dotted-decimal is an address.
    for (const host of ['1x', '0x1g', 'a1.b2', '123.example', 'x.0xz', '93.184.216.34']) {
      const c = await expectReply(await socks(p.port, { atyp: 3, host, port: 80 }), 0, `${host} (${label})`)
      await until(() => c.bytes.length >= 18, `${host} (${label}): first bytes`)
      c.client.destroy()
    }
    assert.deepEqual(lookups, ['1x', '0x1g', 'a1.b2', '123.example', 'x.0xz'])
    lookups.length = dials.length = 0
    await shut(p)
  }
  assert.equal(upstreamHits, 6, 'the upstream saw only the six that are not numeric names')
  console.log(`ok numeric names: ${spellings.length} non-canonical spellings (octal, hex, short forms, one number, trailing dot, ending in a number) refused 04 before any lookup, dial or upstream (direct, upstream, bypass '*'); partly numeric names and canonical dotted-decimal still go`)
}

// DNS-over-HTTPS through the upstream: a real TLS server with a test CA, asked
// through real HTTP CONNECT and SOCKS5 upstream fixtures. Each upstream
// fixture does its own name lookup as the attacker would have it (every name
// a private service), so a name ever sent to it shows up as PRIVATE bytes.
function testCertificates() {
  const dir = mkdtempSync(join(os.tmpdir(), 'doh-ca-'))
  try {
    const openssl = (...args: string[]) => {
      const result = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' })
      if (result.error || result.status !== 0) throw Object.assign(new Error(`openssl ${args[0]}: ${(result.error as NodeJS.ErrnoException | undefined)?.code ?? result.stderr.trim().split('\n').at(-1)}`), { code: (result.error as NodeJS.ErrnoException | undefined)?.code })
    }
    // Named-curve parameters and SHA-256 spelled out: macOS's LibreSSL otherwise
    // writes explicit parameters and signs with SHA-1, which Node's OpenSSL refuses.
    const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-sha256']
    openssl('req', '-x509', ...ec, '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Shared Session test DoH CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign')
    openssl('req', '-new', ...ec, '-keyout', 'doh.key', '-out', 'doh.csr', '-subj', '/CN=doh.test')
    writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:doh.test\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n')
    openssl('x509', '-req', '-in', 'doh.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-set_serial', '1', '-sha256', '-out', 'doh.pem', '-days', '2', '-extfile', 'ext.cnf')
    return { ca: readFileSync(join(dir, 'ca.pem')), key: readFileSync(join(dir, 'doh.key')), cert: readFileSync(join(dir, 'doh.pem')) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

async function dohFixtures() {
  let pem
  try { pem = testCertificates() } catch (error) { return { skip: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'no openssl' : (error as Error).message } }
  const ctx: DohCtx = { ca: pem.ca, asked: [], connects: [], socksSeen: [], privateHits: 0, publicHits: 0, wrongHits: 0 }
  // What the DNS-over-HTTPS server answers: { A, AAAA, Status, TTL, body }.
  ctx.answers = {
    'evil.test': { A: ['93.184.216.34'] }, 'hidden.test': { A: ['10.0.0.7'] }, 'accounts.test': { A: ['93.184.216.34'] }, 'down.test': { A: ['93.184.216.34'] },
    'gone.test': { Status: 3 }, 'loopy.test': { A: ['93.184.216.34', '127.0.0.1'] }, 'meta.test': { A: ['169.254.169.254'] }, 'mapped.test': { A: ['93.184.216.34'], AAAA: ['::ffff:10.0.0.7'] },
    'nat64.test': { AAAA: ['64:ff9b::a9fe:a9fe'] }, 'own.test': { A: ['192.168.1.5'] }, 'six.test': { AAAA: ['2001:db8::5'] }, 'cached.test': { A: ['93.184.216.34'], TTL: 300 },
    'servfail.test': { Status: 2 }, 'big.test': { body: `{"Status":0,"Answer":[],"pad":"${'p'.repeat(70_000)}"}` }, 'bad.test': { A: ['not-an-address'] }, 'lan.test': { A: ['10.0.0.7'] },
    'slow.test': { A: ['93.184.216.34'], delay: 4000 },
    // Dual-stack names whose addresses the upstream fixtures refuse, hold or answer late (upstreamAs).
    'dual.test': { A: ['198.51.100.7'], AAAA: ['2001:db8::5'] }, 'held.test': { A: ['198.51.100.7'], AAAA: ['2001:db8::6', '2001:db8::5'] }, 'blackhole.test': { A: ['198.51.100.14'], AAAA: ['2001:db8::5'] },
    'dead.test': { A: ['198.51.100.7', '198.51.100.8', '198.51.100.9'], AAAA: ['2001:db8::7', '2001:db8::8', '2001:db8::9'] },
    'late.test': { A: ['198.51.100.12', '198.51.100.13'], AAAA: ['2001:db8::12', '2001:db8::13'] },
  }
  // The Guest's own resolver: absent, poisoned or right.
  ctx.local = { 'evil.test': ['93.184.216.34'], 'accounts.test': ['203.0.113.99'], 'down.test': ['93.184.216.34'], 'loopy.test': ['93.184.216.34'], 'meta.test': ['93.184.216.34'], 'mapped.test': ['93.184.216.34'],
    'nat64.test': ['93.184.216.34'], 'own.test': ['93.184.216.34'], 'six.test': ['93.184.216.34'], 'cached.test': ['93.184.216.34'], 'servfail.test': ['93.184.216.34'], 'big.test': ['93.184.216.34'], 'bad.test': ['93.184.216.34'], 'lan.test': ['93.184.216.34'], 'slow.test': ['93.184.216.34'],
    'n1.test': ['93.184.216.34'], 'n2.test': ['93.184.216.34'], 'n3.test': ['93.184.216.34'], 'n5.test': ['93.184.216.34'], 'n6.test': ['93.184.216.34'],
    // IPv6 first here: the upstream still gets the IPv4 address first.
    'dual-local.test': ['2001:db8::5', '198.51.100.7'] }
  ctx.lookup = (name: string, _options: any, callback: LookupCallback) => setImmediate(() => ctx.local[name] ? callback(null, ctx.local[name].map((address: any) => ({ address, family: net.isIP(address) }))) : callback(Object.assign(new Error('not found'), { code: 'ENOTFOUND' })))
  ctx.interfaces = () => ({ en0: [iface('192.168.1.5', '192.168.1.0/24')] })
  const greeter = (word: string, count: string) => track(net.createServer({ allowHalfOpen: true }, socket => { ctx[count]++; socket.write(word); socket.on('data', bytes => socket.write(bytes)); socket.on('end', () => socket.end()) }))
  const publicPort = await listen(greeter('PUBLIC!', 'publicHits')), privatePort = await listen(greeter('PRIVATE', 'privateHits')), wrongPort = await listen(greeter('WRONGIP', 'wrongHits'))
  const doh = track(https.createServer({ key: pem.key, cert: pem.cert }, (req, res) => {
    const url = new URL(req.url!, 'https://doh.test'), name = url.searchParams.get('name'), type = url.searchParams.get('type')
    ctx.asked.push({ path: url.pathname, name, type, accept: req.headers.accept, host: req.headers.host })
    const answer = ctx.answers[name!] ?? { Status: 3 }
    if (answer.body) return res.end(answer.body)
    const data = type === 'A' ? answer.A ?? [] : type === 'AAAA' ? answer.AAAA ?? [] : []
    res.setHeader('content-type', 'application/dns-json')
    const send = () => res.end(JSON.stringify({ Status: answer.Status ?? 0, Answer: [{ name: `${name}.`, type: 5, TTL: 60, data: 'cname.test.' }, ...data.map((address: any) => ({ name: `${name}.`, type: type === 'A' ? 1 : 28, TTL: answer.TTL ?? 0, data: address }))] }))
    // A slow name: its authoritative servers take their time; TLS and the request are long done.
    if (answer.delay) setTimeout(send, answer.delay)
    else send()
  }))
  ctx.dohPort = await listen(doh)
  // A gate in front of the DoH server: open, it passes through; shut, it holds
  // the tunnel and never answers, as a proxy whose network drops DoH does.
  ctx.gateOpen = false
  ctx.gateHits = 0
  ctx.gatePort = await listen(track(net.createServer(socket => {
    ctx.gateHits++
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    if (!ctx.gateOpen) return socket.on('data', () => {})
    const target = net.connect({ host: '127.0.0.1', port: ctx.dohPort })
    sockets.add(target)
    target.on('error', () => socket.destroy())
    target.on('close', () => { sockets.delete(target); socket.destroy() })
    socket.pipe(target); target.pipe(socket)
  })))
  // Where each upstream fixture sends what it's asked for: an address it knows,
  // the DoH server (127.0.0.1), or a name, which its own resolver puts at the private service.
  const addresses = { '93.184.216.34': publicPort, '2001:db8::5': publicPort, '203.0.113.99': wrongPort, '10.0.0.7': privatePort, '127.0.0.1': null }
  // What both upstream fixtures do with these addresses instead: refuse them
  // (HTTP 502, SOCKS5 REP 5; any other address they don't know is 502 or REP 4),
  // hold the tunnel unanswered (ctx.held, until the proxy closes it), or refuse
  // them 600 ms on.
  ctx.upstreamAs = { '198.51.100.14': 'hold', '198.51.100.7': 'refuse', '198.51.100.8': 'refuse', '198.51.100.9': 'refuse', '2001:db8::6': 'hold', '198.51.100.12': 'late', '198.51.100.13': 'late', '2001:db8::12': 'late', '2001:db8::13': 'late' }
  ctx.held = new Set()
  const special = (socket: net.Socket, host: string, refused: Buffer | string) => {
    const as = ctx.upstreamAs[host]
    if (!as) return false
    socket.on('error', () => {})
    if (as === 'refuse') socket.end(refused)
    else if (as === 'late') setTimeout(() => socket.end(refused), 600)
    else {
      ctx.held.add(socket); sockets.add(socket)
      socket.once('close', () => { ctx.held.delete(socket); sockets.delete(socket) })
      socket.on('end', () => socket.destroy())
      socket.resume()
    }
    return true
  }
  const destination = (host: string, port: number) => {
    if (host === '127.0.0.1') return port
    if (Object.hasOwn(addresses, host)) return (addresses as Record<string, number | null>)[host]
    return net.isIP(host) ? null : privatePort
  }
  const pipeTo = (socket: net.Socket, port: number | null | undefined, rest: Buffer, ok: Buffer | string, bad: Buffer | string) => {
    if (!port) return socket.end(bad)
    const target = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true })
    sockets.add(target)
    target.on('error', () => socket.destroy())
    target.on('close', () => sockets.delete(target))
    target.once('connect', () => { socket.write(ok); if (rest.length) target.write(rest); socket.pipe(target); target.pipe(socket) })
  }
  // Every connection either upstream fixture holds open now: a try the proxy gave up on must not stay.
  ctx.upstreamSockets = new Set()
  const accepted = (socket: net.Socket) => { ctx.upstreamSockets.add(socket); socket.once('close', () => ctx.upstreamSockets.delete(socket)) }
  ctx.httpPort = await listen(track(net.createServer({ allowHalfOpen: true }, socket => {
    accepted(socket)
    let head = Buffer.alloc(0)
    const read = (bytes: Buffer) => {
      head = Buffer.concat([head, bytes])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.removeListener('data', read)
      const authority = /^CONNECT (\S+) HTTP\/1\.1\r\n/.exec(head.toString('latin1', 0, end + 2))?.[1] ?? ''
      ctx.connects.push(authority)
      const [, host, port] = /^\[?(.*?)\]?:([0-9]+)$/.exec(authority) ?? []
      if (special(socket, host!, 'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')) return
      pipeTo(socket, destination(host!, Number(port)), head.subarray(end + 4), 'HTTP/1.1 200 Connection established\r\n\r\n', 'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
    }
    socket.on('data', read)
  })))
  ctx.socksPort = await listen(track(net.createServer({ allowHalfOpen: true }, socket => {
    accepted(socket)
    let buffer = Buffer.alloc(0), greeted = false
    const read = (bytes: Buffer) => {
      buffer = Buffer.concat([buffer, bytes])
      if (!greeted) {
        if (buffer.length < 3) return
        buffer = buffer.subarray(3); greeted = true
        socket.write(Buffer.from([5, 0]))
      }
      if (buffer.length < 5) return
      const atyp = buffer[3], size = atyp === 1 ? 10 : atyp === 4 ? 22 : 7 + buffer[4]!
      if (buffer.length < size) return
      socket.removeListener('data', read)
      const host = atyp === 1 ? [...buffer.subarray(4, 8)].join('.') : atyp === 4 ? new net.SocketAddress({ address: Array.from({ length: 8 }, (_, i) => buffer.readUInt16BE(4 + 2 * i).toString(16)).join(':'), family: 'ipv6' }).address : buffer.toString('latin1', 5, 5 + buffer[4]!)
      const port = buffer.readUInt16BE(size - 2)
      ctx.socksSeen.push({ atyp, host, port })
      if (special(socket, host, Buffer.from(reply(5)))) return
      pipeTo(socket, destination(host, port), buffer.subarray(size), Buffer.from(reply(0)), Buffer.from(reply(4)))
    }
    socket.on('data', read)
  })))
  ctx.servers = [{ address: '127.0.0.1', port: ctx.dohPort, servername: 'doh.test', path: '/dns-query', ca: pem.ca }]
  ctx.http = { kind: 'http', host: '127.0.0.1', port: ctx.httpPort, bypass: [] }
  ctx.socks5 = { kind: 'socks5', host: '127.0.0.1', port: ctx.socksPort, bypass: [] }
  ctx.start = (upstream: unknown, { servers = ctx.servers, cfg = {}, timeouts = {} }: { servers?: unknown, cfg?: object, timeouts?: object } = {}) => inProcess({ lookup: ctx.lookup, interfaces: ctx.interfaces, doh: servers, timeouts: { ...FAST, doh: 3000, dohEach: 1500, ...timeouts } }, { upstream, ...cfg })
  // Opens a name through the proxy and returns the destination's greeting.
  ctx.open = async (instance: Instance, host: string, label: string) => {
    const c = await expectReply(await socks(instance.port, { atyp: 3, host, port: 443 }), 0, label)
    await until(() => c.bytes.length >= 19, `${label}: first bytes`)
    await echoes(c)
    c.client.destroy()
    return c.bytes.subarray(12, 19).toString()
  }
  ctx.reset = () => { ctx.asked.length = ctx.connects.length = ctx.socksSeen.length = 0; ctx.privateHits = ctx.publicHits = ctx.wrongHits = 0 }
  // The addresses the upstream was asked for, beside the DoH server's (127.0.0.1), as CONNECT spells them.
  ctx.tried = () => [...ctx.connects, ...ctx.socksSeen.map((seen: any) => seen.atyp === 4 ? `[${seen.host}]:${seen.port}` : `${seen.host}:${seen.port}`)].filter(authority => !authority.startsWith('127.0.0.1:'))
  ctx.numeric = () => ctx.connects.every((authority: string) => /^(?:[0-9.]+|\[[0-9a-f:]+\]):[0-9]+$/.test(authority)) && ctx.socksSeen.every((seen: any) => seen.atyp !== 3)
  return ctx
}

// Each case is one regression the old helper (names sent to the upstream) fails.
const DOH_CASES: Record<string, (ctx: DohCtx) => Promise<void>> = {
  async 'a: a public local answer goes at its checked address, never by name'(ctx: DohCtx) {
    const p = await ctx.start(ctx.http)
    assert.equal(await ctx.open(p, 'evil.test', 'evil.test through the upstream'), 'PUBLIC!', 'the checked address, not what the upstream would resolve')
    assert.equal(ctx.privateHits, 0, 'no private bytes')
    assert.deepEqual(ctx.connects.filter((authority: any) => !authority.startsWith('127.0.0.1:')), ['93.184.216.34:443'], 'the upstream got an address')
    assert.ok(ctx.numeric())
    assert.deepEqual(ctx.asked.map((ask: any) => ask.type).sort(), ['A', 'AAAA'], 'A and AAAA asked of the DoH server through the upstream')
    assert.ok(ctx.asked.every((ask: any) => ask.name === 'evil.test' && ask.accept === 'application/dns-json' && ask.host === 'doh.test' && ask.path === '/dns-query'))
    assert.deepEqual(p.rows, [], 'nothing said')
    await shut(p)
  },
  async 'b: no local answer and a private DoH answer is refused'(ctx: DohCtx) {
    const p = await ctx.start(ctx.http)
    await expectReply(await socks(p.port, { atyp: 3, host: 'hidden.test', port: 443 }), 2, 'hidden.test')
    assert.deepEqual(p.rows, [{ state: 'lan' }], 'the bare lan row')
    assert.equal(ctx.privateHits, 0, 'zero private connections')
    assert.ok(ctx.connects.every((authority: any) => authority.startsWith('127.0.0.1:')), 'only the DoH server was asked for')
    await shut(p)
  },
  async 'c: a poisoned local answer gives way to the DoH answer'(ctx: DohCtx) {
    const p = await ctx.start(ctx.http)
    assert.equal(await ctx.open(p, 'accounts.test', 'accounts.test'), 'PUBLIC!', 'the DoH address, not the poisoned one')
    assert.equal(ctx.wrongHits, 0)
    assert.deepEqual(ctx.connects.filter((authority: any) => !authority.startsWith('127.0.0.1:')), ['93.184.216.34:443'])
    await shut(p)
  },
  async 'd: DoH down falls back to the local answer, by address'(ctx: DohCtx) {
    const dead = await deadPort()
    const p = await ctx.start(ctx.http, { servers: [{ ...ctx.servers[0], port: dead }] })
    assert.equal(await ctx.open(p, 'down.test', 'down.test with DoH down'), 'PUBLIC!')
    assert.equal(ctx.privateHits, 0)
    assert.deepEqual(ctx.connects.filter((authority: any) => authority !== `127.0.0.1:${dead}`), ['93.184.216.34:443'], 'the local answer, pinned')
    // A server that couldn't be reached is skipped a while: the next name doesn't wait on it.
    const before = ctx.connects.length
    assert.equal(await ctx.open(p, 'evil.test', 'evil.test with DoH down'), 'PUBLIC!')
    assert.deepEqual(ctx.connects.slice(before), ['93.184.216.34:443'])
    await shut(p)
    // Nor through a SOCKS5 upstream.
    const s = await ctx.start(ctx.socks5, { servers: [{ ...ctx.servers[0], port: dead }] })
    assert.equal(await ctx.open(s, 'down.test', 'down.test with DoH down, SOCKS5'), 'PUBLIC!')
    assert.deepEqual(ctx.socksSeen.at(-1), { atyp: 1, host: '93.184.216.34', port: 443 })
    await shut(s)
  },
  async 'e: no DoH answer and no local answer is refused, the name never sent'(ctx: DohCtx) {
    for (const [label, servers] of [['NXDOMAIN', ctx.servers], ['DoH down', [{ ...ctx.servers[0], port: await deadPort() }]]]) {
      for (const upstream of [ctx.http, ctx.socks5]) {
        const p = await ctx.start(upstream, { servers })
        await expectReply(await socks(p.port, { atyp: 3, host: 'gone.test', port: 443 }), 4, `gone.test, ${label}, ${upstream.kind}`)
        await shut(p)
      }
    }
    assert.ok(ctx.numeric(), 'the upstream never saw the name')
    assert.ok(![...ctx.connects, ...ctx.socksSeen.map((seen: any) => seen.host)].some(seen => seen.includes('gone')))
    assert.equal(ctx.privateHits, 0)
  },
  async 'f: a DoH answer holding loopback, metadata, private or own addresses is refused'(ctx: DohCtx) {
    const p = await ctx.start(ctx.http, { cfg: { lan: true } })
    for (const host of ['loopy.test', 'meta.test', 'nat64.test']) await expectReply(await socks(p.port, { atyp: 3, host, port: 443 }), 2, `${host}: refused even with lan: true`)
    await expectReply(await socks(p.port, { atyp: 3, host: 'own.test', port: 443 }), 2, 'own.test')
    assert.equal(await ctx.open(p, 'lan.test', 'lan: true opens a private DoH answer'), 'PRIVATE')
    await shut(p)
    ctx.privateHits = 0
    const q = await ctx.start(ctx.http)
    for (const host of ['mapped.test', 'lan.test', 'loopy.test']) await expectReply(await socks(q.port, { atyp: 3, host, port: 443 }), 2, `${host}`)
    assert.equal(ctx.privateHits, 0)
    assert.ok(ctx.connects.filter((authority: any) => !authority.startsWith('127.0.0.1:')).every((authority: any) => authority === '10.0.0.7:443'), 'only lan: true reached a private address, by address')
    await shut(q)
  },
  async 'g: a SOCKS5 upstream gets ATYP 1 or 4, never a name'(ctx: DohCtx) {
    const p = await ctx.start(ctx.socks5)
    assert.equal(await ctx.open(p, 'evil.test', 'evil.test through SOCKS5'), 'PUBLIC!')
    assert.equal(await ctx.open(p, 'six.test', 'six.test (AAAA only) through SOCKS5'), 'PUBLIC!')
    assert.equal(ctx.privateHits, 0)
    assert.deepEqual(ctx.socksSeen.filter((seen: any) => seen.host !== '127.0.0.1'), [{ atyp: 1, host: '93.184.216.34', port: 443 }, { atyp: 4, host: '2001:db8::5', port: 443 }])
    assert.ok(ctx.socksSeen.every((seen: any) => seen.atyp !== 3), 'ATYP 1 or 4 only, the DoH server too')
    await shut(p)
  },
}

// How the DoH client itself behaves: certificates, order, bounds, cache.
async function dohClientChecks(ctx: DohCtx) {
  const viaHttp = await ctx.start(ctx.http)
  // A bad answer (SERVFAIL, a body past 64 KiB, an A record that is no address) is the local answer's turn.
  for (const host of ['servfail.test', 'big.test', 'bad.test']) assert.equal(await ctx.open(viaHttp, host, `${host}: the local answer`), 'PUBLIC!')
  // Concurrent asks of one name share one look, and an answer is kept for its TTL (at most a minute).
  ctx.reset()
  await Promise.all([1, 2, 3].map(() => ctx.open(viaHttp, 'cached.test', 'cached.test')))
  assert.equal(await ctx.open(viaHttp, 'cached.test', 'cached.test again'), 'PUBLIC!')
  assert.equal(ctx.asked.length, 2, 'one A and one AAAA for four connections')
  // A TTL of 0 is asked again.
  ctx.reset()
  for (let i = 0; i < 2; i++) await ctx.open(viaHttp, 'evil.test', 'evil.test, TTL 0')
  assert.equal(ctx.asked.length, 4)
  await shut(viaHttp)
  // Certificates are checked: a server whose certificate isn't for its name,
  // or isn't signed by a trusted CA, is passed over for the next.
  ctx.reset()
  const strict = await ctx.start(ctx.http, { servers: [{ ...ctx.servers[0], servername: 'other.test' }, { ...ctx.servers[0], ca: undefined }, ctx.servers[0]] })
  assert.equal(await ctx.open(strict, 'accounts.test', 'the third server answers'), 'PUBLIC!')
  assert.equal(ctx.asked.length, 2, 'only the server that passed TLS was asked anything')
  ctx.reset()
  assert.equal(await ctx.open(strict, 'accounts.test', 'kept'), 'PUBLIC!')
  await shut(strict)
  // Every server failing: the local answer, the poisoned one here (nothing better is known).
  ctx.reset()
  const failing = await ctx.start(ctx.http, { servers: [{ ...ctx.servers[0], servername: 'other.test' }] })
  assert.equal(await ctx.open(failing, 'accounts.test', 'no server passed TLS'), 'WRONGIP')
  assert.deepEqual(ctx.connects.filter((authority: any) => !authority.startsWith('127.0.0.1:')), ['203.0.113.99:443'])
  await shut(failing)
  // A server that never answers costs at most dohEach, and close() ends its tunnel.
  const silent = track(net.createServer(socket => socket.on('data', () => {}))), silentPort = await listen(silent)
  const slow = await ctx.start(ctx.http, { servers: [{ ...ctx.servers[0], port: silentPort }], timeouts: { dohEach: 400 } })
  const at = Date.now()
  assert.equal(await ctx.open(slow, 'down.test', 'a silent server'), 'PUBLIC!')
  assert.ok(Date.now() - at >= 380 && Date.now() - at < 2500, `waited ${Date.now() - at} ms`)
  await shut(slow)
  await slowNameChecks(ctx)
  await backoffChecks(ctx)
  // A literal asks nothing of DoH.
  ctx.reset()
  const literal = await ctx.start(ctx.http)
  await expectReply(await socks(literal.port, { atyp: 1, host: '93.184.216.34', port: 443 }), 0, 'a literal')
  assert.deepEqual([ctx.asked.length, ctx.connects], [0, ['93.184.216.34:443']])
  await shut(literal)
}

// A name that is slow once TLS is up (a slow domain, or an attacker's made
// slow) is that name's failure alone: no server is skipped for it, so the next
// name still gets its DoH answer, not its (here poisoned) local one. Before,
// its timeout marked every server down for 30 s.
async function slowNameChecks(ctx: DohCtx) {
  ctx.reset()
  // Each server's time is well past a TLS handshake on a busy machine, and the answer later still.
  const p = await ctx.start(ctx.http, { servers: [ctx.servers[0], ctx.servers[0]], timeouts: { doh: 8000, dohEach: 1500 } })
  const at = Date.now()
  assert.equal(await ctx.open(p, 'slow.test', 'slow.test: the local answer once DoH is slow'), 'PUBLIC!')
  assert.ok(Date.now() - at < 6000, `slow.test waited ${Date.now() - at} ms`)
  assert.equal(ctx.asked.filter((ask: any) => ask.name === 'slow.test').length, 4, 'both servers asked (A and AAAA each)')
  assert.equal(await ctx.open(p, 'accounts.test', 'accounts.test right after a slow name'), 'PUBLIC!', 'the DoH answer, not the poisoned local one')
  assert.equal(ctx.wrongHits, 0)
  assert.ok(ctx.asked.some((ask: any) => ask.name === 'accounts.test'), 'DoH asked for the next name')
  // The slow name goes by its local answer a while, without waiting on DoH again.
  const asked = ctx.asked.length, again = Date.now()
  assert.equal(await ctx.open(p, 'slow.test', 'slow.test again'), 'PUBLIC!')
  assert.ok(ctx.asked.length === asked && Date.now() - again < 1000, 'not asked again within dohMiss')
  await shut(p)
}

// A proxy that silently holds DoH tunnels: once no server could be reached,
// DoH waits as a whole (servers not yet tried included), and the wait doubles
// while it stays so, until an answer resets it. Before, each server was
// skipped a fixed while and an untried one cost the next name its full wait.
async function backoffChecks(ctx: DohCtx) {
  const gate = { ...ctx.servers[0], port: ctx.gatePort }
  const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  ctx.reset(); ctx.gateOpen = false; ctx.gateHits = 0
  // Four servers, a look's time for two and a half: the fourth is never tried, and the next name waits on none.
  const four = await ctx.start(ctx.http, { servers: [gate, gate, gate, gate], timeouts: { doh: 1000, dohEach: 400, dohDown: 5000 } })
  assert.equal(await ctx.open(four, 'n1.test', 'n1.test, DoH held'), 'PUBLIC!')
  const hits = ctx.gateHits, at = Date.now()
  assert.equal(await ctx.open(four, 'n2.test', 'n2.test right after'), 'PUBLIC!')
  assert.ok(ctx.gateHits === hits && Date.now() - at < 2000, `n2.test asked nothing of DoH (${ctx.gateHits - hits} tunnels, ${Date.now() - at} ms)`)
  await shut(four)
  // One server: held twice, the second wait is twice the first.
  // A two-second wait, then four: each look comes well inside or past them, so a busy machine's late timers don't decide.
  const one = await ctx.start(ctx.http, { servers: [gate], timeouts: { doh: 1000, dohEach: 1000, dohDown: 2000, dohDownMax: 20_000 } })
  ctx.gateHits = 0
  await ctx.open(one, 'n1.test', 'n1.test, held')
  assert.equal(ctx.gateHits, 2, 'A and AAAA tunnels')
  await settle(2700)
  await ctx.open(one, 'n2.test', 'n2.test, held again after the first wait')
  assert.equal(ctx.gateHits, 4, 'asked again once the first wait ended')
  await settle(2700)
  await ctx.open(one, 'n3.test', 'n3.test, 2.7 s on')
  assert.equal(ctx.gateHits, 4, 'still waiting: the second wait is 4 s')
  // An answer resets it.
  await settle(2000)
  ctx.gateOpen = true
  ctx.wrongHits = 0
  assert.equal(await ctx.open(one, 'accounts.test', 'accounts.test with DoH back'), 'PUBLIC!', 'DoH answers again after the wait')
  assert.equal(ctx.wrongHits, 0)
  ctx.gateOpen = false
  ctx.gateHits = 0
  await ctx.open(one, 'n5.test', 'n5.test, held after an answer')
  assert.equal(ctx.gateHits, 2)
  await settle(3000)
  await ctx.open(one, 'n6.test', 'n6.test, 3 s on')
  assert.equal(ctx.gateHits, 4, 'back to the first wait, not a doubled one')
  await shut(one)
}

// Each case is one regression the helper that gave the upstream a name's
// first IPv4 address alone (and refused at its first failure) fails.
const RETRY_CASES: Record<string, (ctx: DohCtx) => Promise<void>> = {
  async 'h: an IPv4 address the upstream refuses gives way to the IPv6 one, both checked'(ctx: DohCtx) {
    for (const [label, host, servers] of [['the DoH answer', 'dual.test', ctx.servers], ['the local answer, DoH down', 'dual-local.test', [{ ...ctx.servers[0], port: await deadPort() }]]]) {
      ctx.reset()
      const p = await ctx.start(ctx.http, { servers, timeouts: { connect: 10_000 } })
      assert.equal(await ctx.open(p, host, `${host}, ${label}`), 'PUBLIC!', `${label}: the IPv6 address once the IPv4 one is refused`)
      assert.deepEqual(ctx.tried(), ['198.51.100.7:443', '[2001:db8::5]:443'], `${label}: IPv4 first, then IPv6, each in a tunnel of its own`)
      assert.ok(ctx.numeric() && !ctx.connects.some((authority: any) => authority.includes('test')), `${label}: never the name`)
      assert.equal(ctx.privateHits, 0)
      await shut(p)
    }
  },
  async 'i: a SOCKS5 upstream refusing the first address (REP 5) is given the next'(ctx: DohCtx) {
    const p = await ctx.start(ctx.socks5, { timeouts: { connect: 10_000 } })
    assert.equal(await ctx.open(p, 'dual.test', 'dual.test through SOCKS5'), 'PUBLIC!')
    assert.deepEqual(ctx.socksSeen.filter((seen: any) => seen.host !== '127.0.0.1'), [{ atyp: 1, host: '198.51.100.7', port: 443 }, { atyp: 4, host: '2001:db8::5', port: 443 }])
    assert.ok(ctx.numeric())
    await shut(p)
  },
  async 'j: every address refused: four tries at most, the last one\'s code, all within one deadline'(ctx: DohCtx) {
    const four = ['198.51.100.7:443', '[2001:db8::7]:443', '198.51.100.8:443', '[2001:db8::8]:443']
    // HTTP refuses all with 502 (01); SOCKS5 refuses the IPv4 ones REP 5 and the IPv6 ones REP 4, the fourth's.
    for (const [upstream, rep] of [[ctx.http, 1], [ctx.socks5, 4]]) {
      ctx.reset()
      const p = await ctx.start(upstream, { timeouts: { connect: 10_000 } })
      await expectReply(await socks(p.port, { atyp: 3, host: 'dead.test', port: 443 }), rep, `dead.test through ${upstream.kind}`)
      await pause(200)
      assert.deepEqual(ctx.tried(), four, `${upstream.kind}: the families in turn, IPv4 first, and no more than four`)
      await shut(p)
    }
    // Each refusal 600 ms late, one second for the whole: every try's turn
    // ends inside that one deadline, and so does the last (a try's own fresh
    // deadline would have let all four be refused, 01, after 2.4 s).
    ctx.reset()
    const p = await ctx.start(ctx.http, { timeouts: { connect: 1000 } })
    const began = Date.now()
    await expectReply(await socks(p.port, { atyp: 3, host: 'late.test', port: 443 }), 4, 'late.test: past the one deadline')
    assert.ok(Date.now() - began < 2000, `answered within the one deadline (${Date.now() - began} ms)`)
    await pause(200)
    const tried = ctx.tried()
    assert.deepEqual(tried, ['198.51.100.12:443', '[2001:db8::12]:443', '198.51.100.13:443', '[2001:db8::13]:443'].slice(0, tried.length), 'in turn, IPv4 first')
    await shut(p)
    // An upstream that can't be reached at all says nothing of the address: one try, 05.
    const dead = await deadPort(), tunnels = []
    const connect = (options: ConnectOptions) => { if (options.port === dead && options.allowHalfOpen) tunnels.push(options); return net.connect(options) }
    const q = await inProcess({ lookup: ctx.lookup, interfaces: ctx.interfaces, connect, doh: ctx.servers, timeouts: { ...FAST, connect: 10_000 } }, { upstream: { ...ctx.http, port: dead } })
    await expectReply(await socks(q.port, { atyp: 3, host: 'dual-local.test', port: 443 }), 5, 'dual-local.test, the upstream down')
    assert.equal(tunnels.length, 1, 'tried once')
    await shut(q)
  },
  async 'l: an IPv4 address the upstream holds unanswered (a blackholed route) gives way to the IPv6 one within the deadline'(ctx: DohCtx) {
    const p = await ctx.start(ctx.http, { timeouts: { connect: 6000 } })
    const began = Date.now()
    assert.equal(await ctx.open(p, 'blackhole.test', 'blackhole.test, its IPv4 held'), 'PUBLIC!', 'the IPv6 address once the IPv4 try has had its turn')
    assert.ok(Date.now() - began < 5500, `inside the one deadline (${Date.now() - began} ms)`)
    assert.deepEqual(ctx.tried(), ['198.51.100.14:443', '[2001:db8::5]:443'])
    await until(() => ctx.held.size === 0, 'the held try is closed')
    assert.ok(ctx.numeric())
    await shut(p)
  },
  async 'k: a client leaving, or the proxy closing, mid-retry ends the tries and leaves nothing open'(ctx: DohCtx) {
    const p = await ctx.start(ctx.http, { timeouts: { connect: 10_000 } })
    const two = ['198.51.100.7:443', '[2001:db8::6]:443']
    const c = await socks(p.port, { atyp: 3, host: 'held.test', port: 443 })
    await until(() => ctx.held.size === 1, 'the second try is held')
    assert.deepEqual(ctx.tried(), two)
    c.client.destroy()
    await until(() => ctx.held.size === 0, 'its tunnel closes with the client')
    await pause(300)
    assert.deepEqual(ctx.tried(), two, 'no third try')
    await until(() => ctx.upstreamSockets.size === 0, 'no connection to the upstream left open')
    ctx.reset()
    const d = await socks(p.port, { atyp: 3, host: 'held.test', port: 443 })
    await until(() => ctx.held.size === 1, 'held again')
    await shut(p)
    await until(() => ctx.held.size === 0 && (d.ended || d.closed), 'close() ends the try and the client')
    await pause(300)
    assert.deepEqual(ctx.tried(), two, 'no try after close()')
    await until(() => ctx.upstreamSockets.size === 0, 'nothing left open after close()')
  },
}

async function dohChecks(cases = Object.keys(DOH_CASES), retries = Object.keys(RETRY_CASES)) {
  const ctx = await dohFixtures()
  if (ctx.skip) return console.log(`SKIP DNS-over-HTTPS through the upstream (${ctx.skip})`)
  for (const name of cases) { ctx.reset(); await DOH_CASES[name]!(ctx) }
  for (const name of retries) { ctx.reset(); await RETRY_CASES[name]!(ctx) }
  console.log(`ok checked addresses in turn through the upstream: ${retries.length} regressions (${retries.map(name => name.slice(0, 1)).join(', ')}): an IPv4 address the upstream refuses (HTTP 502, SOCKS5 REP 5) gives way to the checked IPv6 one in a fresh tunnel (DoH and local answers), families in turn, IPv4 first, four tries at most within one deadline, the last try's code; a client leaving or close() mid-retry ends the tries, nothing left open`)
  await dohClientChecks(ctx)
  console.log(`ok DNS-over-HTTPS through the upstream (real TLS with a test CA, HTTP CONNECT and SOCKS5): ${cases.length} regressions (${cases.map(name => name.slice(0, 1)).join(', ')}): names never reach the upstream, only checked addresses (CONNECT a.b.c.d / ATYP 1 or 4); a DoH answer with any refused address refuses; DoH down or empty falls back to the local answer, pinned; neither refuses 04; certificate name and CA checked, servers in order, an unreachable one skipped, a slow name its own failure (the next name still asked), DoH held by the proxy backing off as a whole and doubling until an answer, bad answers (SERVFAIL, past 64 KiB, no address) fall back, concurrent asks shared, TTL kept, literals ask nothing`)
}

async function capacityAndHygieneChecks() {
  const echo = echoServer(), echoPort = await listen(echo)
  const capped = await ready(BASE), clients: any[] = []
  for (let i = 0; i < 512; i++) clients.push(await wire(capped.port))
  await pause(100)
  const extra = await wire(capped.port)
  await until(() => extra.ended || extra.closed, 'the 513th client is closed')
  assert.equal(extra.bytes.length, 0)
  assert.ok(clients.every(c => !c.ended && !c.closed), '512 clients stay')
  clients[0].client.destroy()
  await until(() => clients[0].closed, 'one client leaves')
  await pause(50)
  const reuse = await wire(capped.port)
  await pause(150)
  assert.ok(!reuse.ended && !reuse.closed, 'a freed slot is reusable')
  await stop(capped)
  await until(() => clients.slice(1).every(c => c.ended || c.closed) && (reuse.ended || reuse.closed), 'SIGTERM closes every client')

  const secretName = 'secret-outbound-name.invalid', upstreamSeen: any[] = []
  const upstream = track(net.createServer({ allowHalfOpen: true }, socket => {
    socket.once('data', bytes => {
      upstreamSeen.push(bytes.toString('latin1'))
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
      socket.on('data', more => socket.write(more))
      socket.on('end', () => socket.end())
    })
  }))
  const upPort = await listen(upstream)
  const log = await ready({ ...BASE, upstream: { kind: 'http', host: '127.0.0.1', port: upPort, bypass: ['bypassed-secret.invalid'] } })
  const res = await control(log.control, { body: routesBody({ 3000: echoPort }, [3610]) })
  assert.equal(res.status, 200)
  // The production helper's own DNS-over-HTTPS: asked through the upstream at
  // the servers' addresses (this fixture answers 200 and then echoes, so no
  // TLS comes of it), and the name has no local answer either: refused, and
  // the upstream never sees it.
  await expectReply(await socks(log.port, { atyp: 3, host: secretName, port: 443 }), 4, 'a name with no checked address')
  const authorities = upstreamSeen.map(head => /^CONNECT (\S+) HTTP\/1\.1\r\nHost: \1\r\n\r\n$/.exec(head)?.[1])
  assert.deepEqual([...new Set(authorities)].sort(), ['1.0.0.1:443', '1.1.1.1:443', '8.8.4.4:443', '8.8.8.8:443'], 'only the DNS-over-HTTPS servers, by address')
  assert.ok(upstreamSeen.every(head => !head.includes('secret')), 'the name never reached the upstream')
  await echoes(await expectReply(await socks(log.port, { atyp: 1, host: '93.184.216.34', port: 443 }), 0, 'an address through the upstream'))
  assert.equal(upstreamSeen.at(-1), 'CONNECT 93.184.216.34:443 HTTP/1.1\r\nHost: 93.184.216.34:443\r\n\r\n')
  await expectReply(await socks(log.port, { atyp: 3, host: 'bypassed-secret.invalid', port: 443 }), 4, 'bypassed and unresolvable')
  await echoes(await expectReply(await socks(log.port, loopbackTo(3000)), 0))
  const wanted = await socks(log.port, loopbackTo(3610))
  await expectReply(await socks(log.port, loopbackTo(5432)), 2)
  for (const host of ['169.254.169.254', '192.168.77.1']) await expectReply(await socks(log.port, { atyp: 1, host, port: 80 }), 2, `${host} refused in production`)
  await until(() => log.rows.some(row => row.state === 'want'), 'want row')
  await stop(log)
  await until(() => wanted.ended || wanted.closed, 'SIGTERM releases a held CONNECT')
  assert.deepEqual(log.rows, [{ state: 'ready', port: log.port, control: log.control }, { state: 'seen', port: 3000 }, { state: 'seen', port: 3610 }, { state: 'want', port: 3610 }, { state: 'seen', port: 5432 }, { state: 'blocked', port: 5432 }, { state: 'lan' }])
  for (const line of log.stdout.trim().split('\n')) {
    assert.ok(Buffer.byteLength(line) <= 8192)
    assert.ok(Object.keys(JSON.parse(line)).every(key => ['state', 'port', 'control'].includes(key)))
  }
  for (const secret of [TOKEN, 'secret', 'invalid', 'upstream', String(upPort), '127.0.0.1', '169.254', '192.168', 'CONNECT', '93.184', '1.1.1.1', '8.8.8.8', 'cloudflare', 'dns.google']) assert.ok(!log.stdout.includes(secret), `stdout never contains ${secret === TOKEN ? 'the token' : secret}`)
  console.log('ok 512-client cap (513th closed, slot reusable), SIGTERM closes all; stdout is only ready/seen/want/blocked/lan rows: no names, addresses, token or upstream details')
}

async function lifecycleChecks() {
  const echo = echoServer(), echoPort = await listen(echo)
  const p = await inProcess({ timeouts: { ...FAST, handshake: 5000, want: 5000 } })
  await configure(p, { 3000: echoPort }, [3610])
  const spliced = await expectReply(await socks(p.port, loopbackTo(3000)), 0)
  const holding = await socks(p.port, loopbackTo(3610)), greeting = await wire(p.port)
  greeting.client.write(Buffer.from([5, 1]))
  await until(() => p.rows.some(row => row.state === 'want'))
  const { port, control: controlPort } = p
  await shut(p)
  await until(() => [spliced, holding, greeting].every(c => c.ended || c.closed), 'close() ends spliced, held and handshaking clients')
  await rebinds(port); await rebinds(controlPort)
  console.log('ok close(): spliced, held and handshaking clients end; both ports released')
}

afterAll(async () => {
  await Promise.all([...running].map(instance => instance.close()))
  for (const socket of sockets) socket.destroy()
  for (const child of children) child.kill('SIGTERM')
  await Promise.all([...servers].map(close))
  await Promise.all([...children].map(child => child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve()))
})

test('config: what the proxy and its helper take', () => configChecks())
test('control port: bearer, Origin and exact Host, method, path, type, body and schema', () => controlChecks())
test('SOCKS5 handshake: byte by byte and pipelined, ATYP 1/3/4, wrong versions closed, no-auth only', () => handshakeChecks())
test("classification: loopback names alone route to the shares; the guest's own and reserved addresses refused", () => classificationChecks())
test('routing: the first config held, then routed; want and blocked windows', () => routingChecks())
test('piping: FIN half-close both ways, 24 MiB each way with paused peers, intact', () => pipingChecks())
test("outbound: HTTP CONNECT and SOCKS5 upstreams given checked addresses only", () => outboundChecks())
test("the guest's local network refused unless SHARED_SESSION_PREVIEW_LAN=1", () => localNetworkChecks())
test('on-link subnets refused', () => onLinkChecks())
test('a numeric name that is not canonical refused before any lookup', () => numericNameChecks())
// About 25 s on an idle machine (its cases run in turn over real TLS): minutes, as the suites that start wrangler dev have.
test('DNS-over-HTTPS through the upstream: names never reach it, checked addresses in turn, retries and backoff', () => dohChecks(), 120_000)
test('512 clients at most, SIGTERM closes all, stdout only its rows', () => capacityAndHygieneChecks())
test('close(): spliced, held and handshaking clients end, both ports released', () => lifecycleChecks())
