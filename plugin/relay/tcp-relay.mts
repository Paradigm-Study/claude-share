// One raw TCP stream per room WebSocket, used on both computers. Node 22.18+
// (its types are stripped as it loads).

import net from 'node:net'
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { connect, BUFFER_MAX } from './ws.mts'
import type { Ws } from './ws.mts'

/** A helper's failure, named by a code the plugin knows (`safeCode`). */
export type Failure = Error & { code: string; reported?: boolean }
/** What a helper's `run` hands its `start`, and what `start` gives back to stop. */
export type RunOptions = { signal: AbortSignal }
export type Running = { close: () => unknown } | void
/** A room-talking helper's settings (`roomSettings`). */
export type RoomSettings = { room: string; token: string; controlToken: string; version: string; [key: string]: unknown }
type Emit = (row: Record<string, unknown>) => void

export const DATA_MAX = 65536, WINDOW_FRAMES = 4, WINDOW_BYTES = DATA_MAX * WINDOW_FRAMES
export const notify: Emit = row => process.stdout.write(JSON.stringify(row) + '\n')
export const failure = (code: string): Failure => Object.assign(new Error('Local preview relay failed'), { code })
// DENIED: a bind the system refuses this user (a port below 1024 on Linux, a
// sandbox), which the plugin treats as a taken port, never as STARTUP.
export const safeCode = (error: any): string => ['INVALID_CONFIG', 'EADDRINUSE', 'DENIED', 'AUTH', 'BUSY', 'CONNECT', 'TIMEOUT', 'PROTOCOL', 'BUFFER_LIMIT'].includes(error?.code) ? error.code : 'STARTUP'
export const portOK = (port: any): port is number => Number.isInteger(port) && port >= 1 && port <= 65535
export const tokenOK = (token: unknown): token is string => typeof token === 'string' && /^[A-Za-z0-9_.-]{16,512}$/.test(token)
export const loopback = (hostname: string) => hostname === 'localhost' || hostname === '[::1]' || (net.isIP(hostname) === 4 && hostname.startsWith('127.'))
export const UNSUPPORTED_V6 = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'])
const NOBODY = new Set(['ECONNREFUSED', 'EADDRNOTAVAIL', 'ENETUNREACH'])
const KNOCK_MS = 300

// True when nothing answers at host:port, before an exact bind there (the
// guest's listener, the window's proxy). macOS (SO_REUSEADDR) lets a specific
// bind sit beside another process's wildcard listener (`listen(P)`, 0.0.0.0,
// an IPv6-only [::]) and silently take its localhost traffic, so the port is
// knocked on first: no data, closed at once. Only a refusal, or no IPv6 at
// all, is free; a connection, or no answer within KNOCK_MS, is taken.
export function vacant(host: string, port: number, connect: (options: net.NetConnectOpts) => net.Socket = net.connect): Promise<boolean> {
  return new Promise(resolve => {
    let socket: net.Socket | undefined, timer: NodeJS.Timeout | undefined
    const finish = (free: boolean) => { clearTimeout(timer); socket?.destroy(); resolve(free) }
    const failed = (error: any) => finish(NOBODY.has(error?.code) || (host === '::1' && UNSUPPORTED_V6.has(error?.code)))
    try { socket = connect({ host, port }) } catch (error) { return failed(error) }
    socket.on('error', () => {})
    timer = setTimeout(() => finish(false), KNOCK_MS)
    socket.once('connect', () => finish(false))
    socket.once('error', failed)
  })
}

export function endpoint(value: unknown, tcp = false): string {
  const scheme = tcp ? 'wss?' : 'https?'
  const path = tcp ? '/ws/[A-Za-z0-9_-]{8,40}' : '/previews/[A-Za-z0-9_-]{8,64}/tunnel'
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\@?#]/.test(value) || !new RegExp(`^${scheme}://[^/]+/api/rooms/[A-Za-z0-9_-]{16,64}${path}$`).test(value)) throw failure('INVALID_CONFIG')
  let url
  try { url = new URL(value) } catch { throw failure('INVALID_CONFIG') }
  if (url.username || url.password || url.search || url.hash || (['http:', 'ws:'].includes(url.protocol) && !loopback(url.hostname))) throw failure('INVALID_CONFIG')
  if (!tcp) url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

// Socket reads stay paused until ready, and then read only against peer credit.
// WS reads never pause; an ACK in the reverse direction must always get through.
// The room may ask this half to prove it read what it was sent (a `check`,
// once it has sent much it can't see answered: the acks for this half's own
// data), which it answers `seen` with the nonce.
type Received = { n: number; credit: { n: number; nonce: string } | null; drained: boolean }
export type Bridge = { close: () => void; closed: Promise<number> }
export function bridge(socket: net.Socket, url: string, headers: Record<string, string>, { emit = notify, timeoutMs = 10_000, onReady = () => {} }: { emit?: Emit; timeoutMs?: number; onReady?: () => void } = {}): Bridge {
  socket.pause()
  let ws: Ws | undefined, done = false, ready = false, blocked = false, tcpBlocked = false
  let sentFin = false, receivedFin = false, tcpEnded = false, expectCredit: Received | null = null
  const sent: number[] = [], received: Received[] = [], nonces = new Set<string>()
  let sentBytes = 0, receivedBytes = 0, resolveClosed!: (code: number) => void
  const closed = new Promise<number>(resolve => (resolveClosed = resolve))
  const timer = setTimeout(() => fail('TIMEOUT'), timeoutMs)
  const normalClose = (code: number) => code === 1000 && sentFin && receivedFin && !sent.length && !received.length && !expectCredit

  function finish(code: number) {
    if (done) return
    done = true
    clearTimeout(timer)
    // Normal close is server-owned: both FINs and every ACK have crossed.
    // Keep TCP's queued FIN intact; abnormal disconnect destroys the old stream.
    if (!normalClose(code)) socket.destroy()
    resolveClosed(code === 1000 && !normalClose(code) ? 1006 : code)
  }
  function fail(code: string) {
    if (done) return
    emit({ state: 'error', code })
    finish(1011)
    ws?.close(code === 'PROTOCOL' ? 1002 : code === 'BUFFER_LIMIT' ? 1009 : 1011)
  }
  const control = (row: Record<string, unknown>) => {
    const accepted = ws!.send(JSON.stringify(row), false)
    if (!accepted) blocked = true
  }
  function endOutput() {
    // Calling end() while write(false) is waiting can suppress drain. Let the
    // last write drain and its ACK go out before ending this TCP half.
    if (!done && receivedFin && !received.length && !expectCredit && !socket.writableEnded) socket.end()
  }
  function acknowledge() {
    while (!done && received.length && received[0].credit && received[0].drained) {
      const record = received.shift()!
      receivedBytes -= record.n
      nonces.delete(record.credit!.nonce)
      control({ t: 'ack', n: record.n, nonce: record.credit!.nonce })
    }
    endOutput()
  }
  function pump() {
    if (done || !ready) return
    if (socket.readableLength > BUFFER_MAX) return fail('BUFFER_LIMIT')
    while (!done && !blocked && sent.length < WINDOW_FRAMES && sentBytes < WINDOW_BYTES && socket.readableLength) {
      const data = socket.read(Math.min(DATA_MAX, WINDOW_BYTES - sentBytes, socket.readableLength))
      if (!data) break
      sent.push(data.length)
      sentBytes += data.length
      if (!ws!.send(data, true)) blocked = true
    }
    // read(0) lets Node deliver an already received EOF after the last bytes.
    if (!socket.readableLength) socket.read(0)
    if (!done && !blocked && tcpEnded && !socket.readableLength && !sentFin) {
      sentFin = true
      control({ t: 'fin' })
    }
  }
  function message(data: string | Buffer, binary: boolean) {
    if (done) return
    if (binary) {
      if (!ready || receivedFin || expectCredit || !data.length || data.length > DATA_MAX) return fail('PROTOCOL')
      if (received.length >= WINDOW_FRAMES || receivedBytes + data.length > WINDOW_BYTES || socket.writableLength + data.length > BUFFER_MAX) return fail('BUFFER_LIMIT')
      const record: Received = { n: data.length, credit: null, drained: false }
      received.push(record)
      receivedBytes += record.n
      expectCredit = record
      const accepted = socket.write(data)
      if (!accepted) tcpBlocked = true
      record.drained = accepted && !tcpBlocked
      return
    }
    if (Buffer.byteLength(data) > 256) return fail('PROTOCOL')
    let row: any
    try { row = JSON.parse(data as string) } catch { return fail('PROTOCOL') }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return fail('PROTOCOL')
    const keys = Object.keys(row).sort().join(',')
    if (row.t === 'ready' && keys === 't') {
      if (ready || expectCredit) return fail('PROTOCOL')
      ready = true
      clearTimeout(timer)
      onReady()
      return pump()
    }
    if (!ready) return fail('PROTOCOL')
    if (row.t === 'credit' && keys === 'n,nonce,t') {
      if (!expectCredit || row.n !== expectCredit.n || typeof row.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(row.nonce) || nonces.has(row.nonce)) return fail('PROTOCOL')
      nonces.add(row.nonce)
      expectCredit.credit = row
      expectCredit = null
      acknowledge()
      return
    }
    // DATA and its challenge are adjacent. No FIN/ACK may sneak between them.
    if (expectCredit) return fail('PROTOCOL')
    if (row.t === 'ack' && keys === 'n,nonce,t') {
      if (!sent.length || !Number.isInteger(row.n) || row.n !== sent[0] || typeof row.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(row.nonce)) return fail('PROTOCOL')
      sent.shift()
      sentBytes -= row.n
      return pump()
    }
    if (row.t === 'fin' && keys === 't') {
      if (receivedFin) return fail('PROTOCOL')
      receivedFin = true
      endOutput()
      return
    }
    if (row.t === 'check' && keys === 'nonce,t') {
      if (typeof row.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(row.nonce)) return fail('PROTOCOL')
      return control({ t: 'seen', nonce: row.nonce })
    }
    fail('PROTOCOL')
  }
  socket.on('readable', pump)
  socket.on('end', () => { tcpEnded = true; pump() })
  socket.on('drain', () => { tcpBlocked = false; for (const record of received) record.drained = true; acknowledge() })
  socket.on('error', () => fail('CONNECT'))
  socket.on('close', () => { if (!done && !(sentFin && receivedFin)) fail('CONNECT') })
  try {
    ws = connect(url, headers, [], { message, drain: () => { blocked = false; pump() }, close: (code, status) => {
      if (!done && !normalClose(code)) emit({ state: 'error', code: status === 401 || status === 403 ? 'AUTH' : code === 1013 ? 'BUSY' : code === 1009 ? 'BUFFER_LIMIT' : [1002, 1007].includes(code) ? 'PROTOCOL' : 'CONNECT' })
      finish(code)
    } }, { maxMessage: DATA_MAX, timeoutMs })
  } catch { fail('CONNECT') }
  return { close: () => { finish(1001); ws?.close(1001) }, closed }
}

// The Host's half of one stream (tcp-worker.mts runs one per channel): its
// loopback port, dialled before the room pairs it.
export function startHost(cfg: any, { emit = notify, signal, timeoutMs = 10_000, onReady = () => {} }: { emit?: Emit; signal?: AbortSignal; timeoutMs?: number; onReady?: () => void } = {}): Bridge {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || Object.keys(cfg).some(k => !['port', 'room', 'token', 'version'].includes(k)) || !portOK(cfg.port) || !tokenOK(cfg.token) || typeof cfg.version !== 'string' || !/^[\w.-]{0,64}$/.test(cfg.version)) throw failure('INVALID_CONFIG')
  const url = endpoint(cfg.room, true), began = Date.now()
  let socket: net.Socket | undefined, relay: Bridge | undefined, done = false, resolveClosed!: (code: number) => void
  const closed = new Promise<number>(resolve => (resolveClosed = resolve))
  const finish = (code: number) => {
    if (done) return
    done = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (code !== 1000) { relay?.close(); socket?.destroy() }
    resolveClosed(code)
  }
  const error = (code: string) => { if (!done) emit({ state: 'error', code }); finish(1011) }
  const abort = () => finish(1001)
  const timer = setTimeout(() => error('TIMEOUT'), timeoutMs)
  signal?.addEventListener('abort', abort, { once: true })
  const attempt = (family: 4 | 6): void => {
    if (done) return
    const s = socket = net.createConnection({ host: family === 4 ? '127.0.0.1' : '::1', port: cfg.port, allowHalfOpen: true, highWaterMark: DATA_MAX } as net.NetConnectOpts)
    s.pause()
    const failed = () => {
      s.destroy()
      if (!done) family === 4 ? attempt(6) : error('CONNECT')
    }
    s.once('error', failed)
    s.once('connect', () => {
      s.removeListener('error', failed)
      if (done) return s.destroy()
      relay = bridge(s, url, { authorization: `Bearer ${cfg.token}`, 'x-shared-session-version': cfg.version }, { emit, timeoutMs: Math.max(1, timeoutMs - (Date.now() - began)), onReady: () => { clearTimeout(timer); onReady() } })
      relay.closed.then(finish)
    })
  }
  if (signal?.aborted) abort()
  else attempt(4)
  return { close: abort, closed }
}

// The helpers' loopback command port (the Host's TCP worker, the preview
// window's proxy): POST / with exactly this Host, no Origin, the bearer and
// one JSON body. 403 for a wrong token, Host or Origin; 413 over the body
// limit; 400 for anything else malformed; 503 while every socket is taken (as
// many again get that answer at once, the rest are dropped) or it's closing.
// Each socket has a hard lifetime, which also bounds slow-drip headers and
// bodies. onCommand gets the parsed JSON and throws for a bad command; it may
// answer { status, code }. The caller's own bounds come in; none are defaults.
const FULL = 'HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{"ok":false}'
export type CommandAnswer = { status?: number; code?: string } | void | undefined
export type ControlServer = { readonly port: number | undefined; listen: () => Promise<number>; close: () => Promise<void> }
export function controlServer({ token, bodyLimit, sockets: max, timeoutMs, headers, onCommand }: { token: string; bodyLimit: number; sockets: number; timeoutMs: number; headers: number; onCommand: (command: any) => CommandAnswer | Promise<CommandAnswer> }): ControlServer {
  const authorization = Buffer.from(`Bearer ${token}`), working = new Set<net.Socket>(), refused = new Set<net.Socket>()
  let port: number | undefined, binding: Promise<number> | undefined, stopped = false
  function reply(res: http.ServerResponse, status: number, code?: string) {
    if (res.writableEnded || res.destroyed) return
    const body = JSON.stringify({ ok: status === 200, ...(code ? { code } : {}) })
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' })
    res.end(body)
  }
  const single = (req: http.IncomingMessage, name: string) => req.rawHeaders.filter((value, i) => !(i % 2) && value.toLowerCase() === name).length === 1
  const server = http.createServer({ maxHeaderSize: headers }, (req, res) => {
    req.on('error', () => {})
    // Answered at connection already; its request gets nothing more.
    if (refused.has(req.socket)) return
    if (stopped) return reply(res, 503)
    const supplied = Buffer.from(req.headers.authorization ?? '')
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization) || req.headers.host !== `127.0.0.1:${port}` || 'origin' in req.headers) return reply(res, 403)
    const length = req.headers['content-length']
    if (req.method !== 'POST' || req.url !== '/' || req.headers['content-type'] !== 'application/json' || req.headers['content-encoding'] || !['host', 'authorization', 'content-type'].every(name => single(req, name)) || (length !== undefined && !/^[0-9]+$/.test(length))) return reply(res, 400)
    if (Number(length) > bodyLimit) return reply(res, 413)
    let chunks: Buffer[] = [], size = 0, failed = false
    req.on('data', (chunk: Buffer) => {
      if (failed) return
      size += chunk.length
      if (size > bodyLimit) { failed = true; chunks = []; reply(res, 413) }
      else chunks.push(chunk)
    })
    req.on('end', () => {
      if (failed) return
      if (stopped) return reply(res, 503)
      let result: any
      try {
        const bytes = Buffer.concat(chunks, size)
        chunks = []
        if (!isUtf8(bytes)) throw failure('INVALID_CONFIG')
        result = onCommand(JSON.parse(bytes.toString('utf8')))
      } catch { return reply(res, 400) }
      // A command may answer once its work is done (the host's mailboxes'); within the request's time.
      if (result && typeof result.then === 'function') return void result.then((value: any) => reply(res, value?.status ?? 200, value?.code), () => reply(res, 400))
      reply(res, result?.status ?? 200, result?.code)
    })
  })
  server.requestTimeout = server.headersTimeout = timeoutMs
  server.maxRequestsPerSocket = 1
  server.on('connection', (socket: net.Socket) => {
    socket.on('error', () => {})
    if (stopped || refused.size >= max) return socket.destroy()
    const full = working.size >= max, set = full ? refused : working
    set.add(socket)
    const timer = setTimeout(() => socket.destroy(), timeoutMs)
    socket.once('close', () => { clearTimeout(timer); set.delete(socket) })
    // A half-close after the answer, so a request already sent doesn't turn it into a reset.
    if (full) socket.end(FULL)
  })
  server.on('clientError', (_error: Error, socket: net.Socket | import('node:stream').Duplex) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    else socket.destroy()
  })
  server.on('error', () => {}) // Never print native errors or addresses.
  return {
    get port() { return port },
    listen() {
      binding = new Promise((resolve, reject) => {
        const failed = (error: Error) => { server.removeListener('listening', listening); reject(error) }
        const listening = () => { server.removeListener('error', failed); port = (server.address() as net.AddressInfo).port; resolve(port) }
        server.once('error', failed)
        server.once('listening', listening)
        server.listen({ host: '127.0.0.1', port: 0 })
      })
      return binding
    },
    // Synchronous up to its first await: nothing is answered 200 once it's called.
    async close() {
      stopped = true
      for (const socket of [...working, ...refused]) socket.destroy()
      await binding?.catch(() => {})
      await new Promise<void>(resolve => server.listening ? server.close(() => resolve()) : resolve())
    },
  }
}

// The one JSON value a helper's settings come in on stdin, 16 KiB at most:
// `then` gets it, `bad` runs for anything else (too long, unreadable, not JSON).
const INPUT_MAX = 16_384
export function readConfig(then: (cfg: any) => void, bad: () => void) {
  let input = '', tooLarge = false
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (data: string) => {
    if (tooLarge) return
    if (Buffer.byteLength(input) + Buffer.byteLength(data) > INPUT_MAX) { input = ''; tooLarge = true }
    else input += data
  })
  process.stdin.on('error', () => { tooLarge = true; input = '' })
  process.stdin.on('end', () => {
    let cfg: unknown
    try { if (tooLarge) throw failure('INVALID_CONFIG'); cfg = JSON.parse(input) } catch { return bad() }
    input = ''
    then(cfg)
  })
}

// The settings of a helper that talks to the room (the host's TCP worker,
// its mailboxes' helper): exactly `keys`, the room's bearer, a control secret
// of its own (another), the plugin's version, and the room's address, in the
// clear only to this computer. Checked; a copy comes back.
export function roomSettings(cfg: any, keys: string): RoomSettings {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || Object.keys(cfg).sort().join(',') !== keys || !tokenOK(cfg.token) || typeof cfg.controlToken !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(cfg.controlToken) || cfg.controlToken === cfg.token || typeof cfg.version !== 'string' || !/^[\w.-]{0,64}$/.test(cfg.version)) throw failure('INVALID_CONFIG')
  if (typeof cfg.room !== 'string' || cfg.room.length > 2048 || !/^https?:\/\/[^/\s@?#\\]+(?:\/[^\s@?#\\]*)?\/api\/rooms\/[A-Za-z0-9_-]{16,64}$/.test(cfg.room)) throw failure('INVALID_CONFIG')
  if (cfg.room.startsWith('http:') && !loopback(new URL(cfg.room).hostname)) throw failure('INVALID_CONFIG')
  return { ...cfg }
}

// One POST of JSON to the room (`settings.room`, with its bearer and the
// plugin's version): its status and what it answered, or null when nothing
// came (unreachable, `controller` aborted, or past `timeoutMs`).
export async function roomPost(settings: RoomSettings, path: string, body: unknown, controller: AbortController, timeoutMs: number): Promise<{ status: number; answer: any } | null> {
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${settings.room}/${path}`, { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json', 'x-shared-session-version': settings.version }, body: JSON.stringify(body) })
    return { status: res.status, answer: await res.json().catch(() => null) }
  } catch {
    return null
  } finally { clearTimeout(timer) }
}

// The executable helpers' lifecycle: their settings on stdin, then `start`;
// SIGTERM, SIGINT or a closed stdout stop it.
export function run(start: (cfg: any, options: RunOptions) => Running | Promise<Running>) {
  let stopped = false, running: Running, starting: Promise<unknown> | undefined
  const controller = new AbortController()
  readConfig(cfg => {
    if (stopped) return
    starting = Promise.resolve().then(() => start(cfg, { signal: controller.signal })).then(value => (running = value)).catch((error: any) => {
      if (!stopped) { if (!error.reported) notify({ state: 'error', code: safeCode(error) }); process.exitCode = 1 }
    })
  }, () => {
    if (stopped) return
    notify({ state: 'error', code: 'INVALID_CONFIG' })
    process.exitCode = 1
  })
  const stop = async () => {
    if (stopped) return
    stopped = true
    controller.abort()
    process.stdin.destroy()
    await starting
    await running?.close()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.stdout.on('error', stop)
}

