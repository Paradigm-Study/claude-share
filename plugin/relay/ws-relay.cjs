// Stdlib WebSocket client, shared by the public preview and TCP relays.
// Credentials arrive on stdin, never in argv or addresses. Node 20+, no deps.
'use strict'

const net = require('net')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { isUtf8 } = require('buffer')

const BUFFER_MAX = 1024 * 1024
const HEADER_MAX = 16 * 1024
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const validClose = code => Number.isInteger(code) && ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code < 5000))
const sendable = code => validClose(code) ? code : 1000

// send() accepts the message, returning false until drain when the transport
// is full. It never pauses WS reads: TCP relays need the reverse direction's ACK.
// `insecure` skips certificate checks, for a loopback dev server's own
// certificate alone (start's local leg); everything else verifies.
function connect(url, headers = {}, protocols = [], on = {}, { maxMessage = BUFFER_MAX, timeoutMs = 10_000, insecure = false } = {}) {
  const u = new URL(url)
  if (!['ws:', 'wss:'].includes(u.protocol) || u.username || u.password || u.hash || !Array.isArray(protocols) || protocols.length > 16 || protocols.some(p => typeof p !== 'string' || !/^[!#$%&'*+.^_`|~\w-]{1,128}$/.test(p)) || new Set(protocols).size !== protocols.length || !Number.isInteger(maxMessage) || maxMessage < 1 || maxMessage > BUFFER_MAX || typeof insecure !== 'boolean') throw new Error('Invalid WebSocket settings')
  const secure = u.protocol === 'wss:'
  const hostname = u.hostname.replace(/^\[|\]$/g, '')
  const hosts = hostname === 'localhost' ? ['127.0.0.1', '::1'] : [hostname]
  const queue = []
  let queuedBytes = 0, socket, request, open = false, closed = false, closeTimer
  const timer = setTimeout(() => end(1006), timeoutMs)

  const frame = (op, payload) => {
    const mask = crypto.randomBytes(4), len = payload.length
    const head = Buffer.alloc(len < 126 ? 2 : len < 65536 ? 4 : 10)
    head[0] = 0x80 | op
    head[1] = 0x80 | (len < 126 ? len : len < 65536 ? 126 : 127)
    if (len >= 126 && len < 65536) head.writeUInt16BE(len, 2)
    if (len >= 65536) head.writeBigUInt64BE(BigInt(len), 2)
    const body = Buffer.from(payload)
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3]
    return Buffer.concat([head, mask, body])
  }
  const write = (op, payload) => {
    if (!socket || socket.destroyed) return false
    if (socket.writableLength + payload.length + 14 > BUFFER_MAX) { end(1009); return false }
    return socket.write(frame(op, payload))
  }
  function end(code = 1000, reply = true, status) {
    if (closed) return
    closed = true
    open = false
    clearTimeout(timer)
    queuedBytes = 0
    queue.length = 0
    if (!socket) request?.destroy()
    if (socket && !socket.destroyed) {
      if (reply) {
        const payload = Buffer.alloc(2)
        payload.writeUInt16BE(sendable(code))
        if (socket.writableLength + 8 <= BUFFER_MAX) socket.write(frame(8, payload))
      }
      socket.end()
      closeTimer = setTimeout(() => socket.destroy(), 1000)
      closeTimer.unref()
    }
    on.close?.(code, status)
  }
  const send = (data, binary = false) => {
    if (closed) return false
    const payload = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
    if (payload.length > maxMessage) { end(1009); return false }
    if (!open) {
      const size = payload.length + 14
      if (queuedBytes + size > BUFFER_MAX || queue.length >= 4096) { end(1009); return false }
      queue.push([binary ? 2 : 1, payload])
      queuedBytes += size
      return false
    }
    return write(binary ? 2 : 1, payload)
  }

  const attach = (s, head) => {
    socket = s
    open = true
    clearTimeout(timer)
    let buf = Buffer.alloc(0), parts = [], partOp = 0, partBytes = 0, partCount = 0
    const read = () => {
      while (!closed && buf.length >= 2) {
        const fin = !!(buf[0] & 0x80), op = buf[0] & 15
        if (buf[0] & 0x70 || buf[1] & 0x80 || ![0, 1, 2, 8, 9, 10].includes(op)) return end(1002)
        let len = buf[1] & 127, at = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2); at = 4
          if (len < 126) return end(1002)
        } else if (len === 127) {
          if (buf.length < 10) return
          const wide = buf.readBigUInt64BE(2)
          if (wide >> 63n || wide > BigInt(maxMessage)) return end(1009)
          len = Number(wide); at = 10
          if (len < 65536) return end(1002)
        }
        if (op >= 8 && (!fin || len > 125)) return end(1002)
        if (len > maxMessage || partBytes + len > BUFFER_MAX) return end(1009)
        if (op < 8 && ((op === 0 && !partOp) || (op !== 0 && partOp))) return end(1002)
        if (buf.length < at + len) return
        const payload = buf.subarray(at, at + len)
        buf = buf.subarray(at + len)
        if (op === 8) {
          if (len === 1 || (len >= 2 && (!validClose(payload.readUInt16BE(0)) || !isUtf8(payload.subarray(2))))) return end(1002)
          return end(len >= 2 ? payload.readUInt16BE(0) : 1000)
        }
        if (op === 9) { write(10, payload); continue }
        if (op === 10) continue
        if (op) partOp = op
        partBytes += len
        if (partBytes > maxMessage || ++partCount > 4096) return end(1009)
        // A fragment must not retain the entire TCP read (including discarded
        // ping frames). Count and retain its own bytes, not a slab-sized slice.
        const piece = Buffer.allocUnsafeSlow(len)
        payload.copy(piece)
        parts.push(piece)
        if (fin) {
          const data = Buffer.concat(parts, partBytes), binary = partOp === 2
          parts = []; partOp = 0; partBytes = 0; partCount = 0
          if (!binary && !isUtf8(data)) return end(1007)
          try { on.message?.(binary ? data : data.toString('utf8'), binary) } catch { end(1002) }
        }
      }
    }
    const receive = d => {
      if (closed) return
      // Include fragments retained outside buf in the same hard memory ceiling.
      if (buf.length + partBytes + d.length > BUFFER_MAX) return end(1009)
      buf = buf.length ? Buffer.concat([buf, d]) : d
      read()
      if (!buf.length) buf = Buffer.alloc(0)
      else if (buf.byteOffset || buf.buffer.byteLength !== buf.length) {
        const rest = Buffer.allocUnsafeSlow(buf.length)
        buf.copy(rest)
        buf = rest
      }
    }
    s.on('data', receive)
    s.on('drain', () => { if (!closed) on.drain?.() })
    s.on('close', () => { clearTimeout(closeTimer); end(1006, false) })
    s.on('error', () => { s.destroy(); end(1006, false) })
    for (const [op, payload] of queue.splice(0)) { queuedBytes -= payload.length + 14; if (!closed) write(op, payload) }
    if (closed) return
    try { on.open?.() } catch { return end(1011) }
    if (head?.length) receive(head)
    if (!closed && !s.writableNeedDrain) on.drain?.()
  }

  const attempt = i => {
    if (closed) return
    const key = crypto.randomBytes(16).toString('base64')
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64')
    // SNI takes a name, never an address (RFC 6066; Node warns on stderr for one).
    const req = request = (secure ? https : http).request({
      host: hosts[i], port: u.port || (secure ? 443 : 80),
      path: `${u.pathname}${u.search}`, servername: secure && !net.isIP(hostname) ? hostname : undefined,
      ...(secure ? { rejectUnauthorized: !insecure } : {}),
      agent: false, maxHeaderSize: HEADER_MAX,
      headers: { ...headers, host: u.host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13', ...(protocols.length ? { 'sec-websocket-protocol': protocols.join(', ') } : {}) },
    })
    req.on('upgrade', (res, s, head) => {
      if (closed) return s.destroy()
      const selected = res.headers['sec-websocket-protocol']
      if (res.statusCode !== 101 || res.headers.upgrade?.toLowerCase() !== 'websocket' || !res.headers.connection?.toLowerCase().split(/\s*,\s*/).includes('upgrade') || res.headers['sec-websocket-accept'] !== accept || res.headers['sec-websocket-extensions'] || (selected !== undefined && !protocols.includes(selected))) { s.destroy(); return end(1002, false) }
      attach(s, head)
    })
    req.on('response', res => { const status = res.statusCode; res.destroy(); end(status === 401 || status === 403 ? 1008 : status === 429 ? 1013 : 1011, false, status) })
    req.on('error', () => { if (!closed && !open) i + 1 < hosts.length ? attempt(i + 1) : end(1006, false) })
    req.end()
  }
  attempt(0)
  return { send, close: end, isOpen: () => open && !closed }
}

// The public preview relay's settings, from the plugin on stdin. The
// browser's socket goes to `local`, on this computer's loopback alone: ws://,
// or wss:// for a TLS dev server, whose own certificate `insecureLocal`
// accepts on that leg alone. It carries the browser's path and query whole
// (SignalR's access_token runs past 4 KiB), bounded by stdin's 16 KiB alone.
// `origin` is the plugin's (the server's own local origin). Its pair in the
// room, `room`, always verifies.
const KEYS = new Set(['local', 'insecureLocal', 'origin', 'protocols', 'room', 'token', 'version'])
function configOf(cfg) {
  const { failure, tokenOK, loopback } = require('./tcp-relay.cjs')
  const url = (value, schemes, max = 4096) => {
    if (typeof value !== 'string' || value.length > max) return null
    try { const u = new URL(value); return schemes.includes(u.protocol) && !u.username && !u.password && !u.hash ? u : null } catch { return null }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || Object.keys(cfg).some(key => !KEYS.has(key)) || !tokenOK(cfg.token) || typeof cfg.version !== 'string' || !/^[\w.-]{0,64}$/.test(cfg.version) || (cfg.insecureLocal !== undefined && typeof cfg.insecureLocal !== 'boolean') || (cfg.protocols !== undefined && !Array.isArray(cfg.protocols))) throw failure('INVALID_CONFIG')
  const local = url(cfg.local, ['ws:', 'wss:'], Infinity), origin = url(cfg.origin, ['http:', 'https:']), room = url(cfg.room, ['ws:', 'wss:'])
  if (!local || !loopback(local.hostname) || !origin || !loopback(origin.hostname) || origin.href !== `${origin.origin}/` || !room || room.search || !/\/ws\/[A-Za-z0-9_-]{8,40}$/.test(room.pathname)) throw failure('INVALID_CONFIG')
  return { local: local.href, insecureLocal: cfg.insecureLocal === true, origin: origin.origin, protocols: cfg.protocols ?? [], room: room.href, token: cfg.token, version: cfg.version }
}

// The local leg goes first, and the room is dialled only once it's open (the
// TCP path dials localhost before pairing too): the room pairs the browser's
// socket only with one the dev server took. A dev server that refuses it, or
// never answers, is CONNECT before the room hears of it: `connected` rejects,
// the executable says so and exits 1, and the plugin's reject closes the
// browser's socket with 1011 at once. A local leg that ends without a close
// frame (a crash, a restart: 1006) closes the room's with 1011, never 1000,
// so the page sees a failure. Clients keyed on wasClean (Vite's) still see a
// clean close: only a dropped connection would match localhost, and the room
// can't drop a browser's on the Worker. A room leg that vanishes closes the
// dev server's with 1000, as a browser leaving would.
function start(cfg, options = {}) {
  const { failure } = require('./tcp-relay.cjs')
  const settings = configOf(cfg)
  let local, room, stopped = false, done = false, up
  const connected = new Promise((resolve, reject) => (up = { resolve, reject }))
  connected.catch(() => {}) // For whoever asks; never an unhandled rejection.
  const finish = code => { if (done) return; done = true; local?.close(code); room?.close(code) }
  try {
    local = connect(settings.local, { origin: settings.origin }, settings.protocols, {
      open: () => {
        room = connect(settings.room, { authorization: `Bearer ${settings.token}`, 'x-shared-session-version': settings.version }, [], { message: (data, binary) => local.send(data, binary), close: finish }, { timeoutMs: 30_000 })
        up.resolve()
      },
      message: (data, binary) => room?.send(data, binary),
      close: code => {
        if (!room) up.reject(failure(stopped ? 'STARTUP' : 'CONNECT'))
        finish(code === 1006 || code === 1015 ? 1011 : code)
      },
    }, { timeoutMs: 30_000, insecure: settings.insecureLocal })
  } catch { finish(1001); throw failure('INVALID_CONFIG') }
  const abort = () => { stopped = true; finish(1001) }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  return { close: abort, connected }
}

module.exports = { connect, start, BUFFER_MAX }
// The executable waits for its local leg: CONNECT is its error row, and exit 1.
if (require.main === module) require('./tcp-relay.cjs').run((cfg, options) => {
  const relay = start(cfg, options)
  return relay.connected.then(() => relay)
})
