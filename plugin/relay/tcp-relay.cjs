// One raw TCP stream per room WebSocket, used on both computers. Node 20+.
'use strict'

const net = require('net')
const { connect, BUFFER_MAX } = require('./ws-relay.cjs')
const DATA_MAX = 65536, WINDOW_FRAMES = 4, WINDOW_BYTES = DATA_MAX * WINDOW_FRAMES
const notify = row => process.stdout.write(JSON.stringify(row) + '\n')
const failure = code => Object.assign(new Error('Local preview relay failed'), { code })
const safeCode = error => ['INVALID_CONFIG', 'EADDRINUSE', 'EXPIRED', 'AUTH', 'BUSY', 'CONNECT', 'TIMEOUT', 'PROTOCOL', 'BUFFER_LIMIT'].includes(error?.code) ? error.code : 'STARTUP'
const portOK = port => Number.isInteger(port) && port >= 1 && port <= 65535
const tokenOK = token => typeof token === 'string' && /^[A-Za-z0-9_.-]{16,512}$/.test(token)
const loopback = hostname => hostname === 'localhost' || hostname === '[::1]' || (net.isIP(hostname) === 4 && hostname.startsWith('127.'))

function endpoint(value, tcp = false) {
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
function bridge(socket, url, headers, { emit = notify, timeoutMs = 10_000, onReady = () => {} } = {}) {
  socket.pause()
  let ws, done = false, ready = false, blocked = false, tcpBlocked = false
  let sentFin = false, receivedFin = false, tcpEnded = false, expectCredit = null
  const sent = [], received = [], nonces = new Set()
  let sentBytes = 0, receivedBytes = 0, resolveClosed
  const closed = new Promise(resolve => (resolveClosed = resolve))
  const timer = setTimeout(() => fail('TIMEOUT'), timeoutMs)
  const normalClose = code => code === 1000 && sentFin && receivedFin && !sent.length && !received.length && !expectCredit

  function finish(code) {
    if (done) return
    done = true
    clearTimeout(timer)
    // Normal close is server-owned: both FINs and every ACK have crossed.
    // Keep TCP's queued FIN intact; abnormal disconnect destroys the old stream.
    if (!normalClose(code)) socket.destroy()
    resolveClosed(code === 1000 && !normalClose(code) ? 1006 : code)
  }
  function fail(code) {
    if (done) return
    emit({ state: 'error', code })
    finish(1011)
    ws?.close(code === 'PROTOCOL' ? 1002 : code === 'BUFFER_LIMIT' ? 1009 : 1011)
  }
  const control = row => {
    const accepted = ws.send(JSON.stringify(row), false)
    if (!accepted) blocked = true
  }
  function endOutput() {
    // Calling end() while write(false) is waiting can suppress drain. Let the
    // last write drain and its ACK go out before ending this TCP half.
    if (!done && receivedFin && !received.length && !expectCredit && !socket.writableEnded) socket.end()
  }
  function acknowledge() {
    while (!done && received.length && received[0].credit && received[0].drained) {
      const record = received.shift()
      receivedBytes -= record.n
      nonces.delete(record.credit.nonce)
      control({ t: 'ack', n: record.n, nonce: record.credit.nonce })
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
      if (!ws.send(data, true)) blocked = true
    }
    // read(0) lets Node deliver an already received EOF after the last bytes.
    if (!socket.readableLength) socket.read(0)
    if (!done && !blocked && tcpEnded && !socket.readableLength && !sentFin) {
      sentFin = true
      control({ t: 'fin' })
    }
  }
  function message(data, binary) {
    if (done) return
    if (binary) {
      if (!ready || receivedFin || expectCredit || !data.length || data.length > DATA_MAX) return fail('PROTOCOL')
      if (received.length >= WINDOW_FRAMES || receivedBytes + data.length > WINDOW_BYTES || socket.writableLength + data.length > BUFFER_MAX) return fail('BUFFER_LIMIT')
      const record = { n: data.length, credit: null, drained: false }
      received.push(record)
      receivedBytes += record.n
      expectCredit = record
      const accepted = socket.write(data)
      if (!accepted) tcpBlocked = true
      record.drained = accepted && !tcpBlocked
      return
    }
    if (Buffer.byteLength(data) > 256) return fail('PROTOCOL')
    let row
    try { row = JSON.parse(data) } catch { return fail('PROTOCOL') }
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

function startHost(cfg, { emit = notify, signal, timeoutMs = 10_000, onReady = () => {} } = {}) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || Object.keys(cfg).some(k => !['tcp', 'port', 'room', 'token', 'version'].includes(k)) || cfg.tcp !== true || !portOK(cfg.port) || !tokenOK(cfg.token) || typeof cfg.version !== 'string' || !/^[\w.-]{0,64}$/.test(cfg.version)) throw failure('INVALID_CONFIG')
  const url = endpoint(cfg.room, true), began = Date.now()
  let socket, relay, done = false, resolveClosed
  const closed = new Promise(resolve => (resolveClosed = resolve))
  const finish = code => {
    if (done) return
    done = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (code !== 1000) { relay?.close(); socket?.destroy() }
    resolveClosed(code)
  }
  const error = code => { if (!done) emit({ state: 'error', code }); finish(1011) }
  const abort = () => finish(1001)
  const timer = setTimeout(() => error('TIMEOUT'), timeoutMs)
  signal?.addEventListener('abort', abort, { once: true })
  const attempt = family => {
    if (done) return
    const s = socket = net.createConnection({ host: family === 4 ? '127.0.0.1' : '::1', port: cfg.port, allowHalfOpen: true, highWaterMark: DATA_MAX })
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

// Both executable helpers share the bounded stdin and signal lifecycle.
function run(start) {
  let input = '', tooLarge = false, stopped = false, running, starting
  const controller = new AbortController()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', data => {
    if (tooLarge) return
    if (Buffer.byteLength(input) + Buffer.byteLength(data) > 16_384) { input = ''; tooLarge = true }
    else input += data
  })
  process.stdin.on('error', () => { tooLarge = true; input = '' })
  process.stdin.on('end', () => {
    if (stopped) return
    let cfg
    try { if (tooLarge) throw failure('INVALID_CONFIG'); cfg = JSON.parse(input) } catch { notify({ state: 'error', code: 'INVALID_CONFIG' }); process.exitCode = 1; return }
    input = ''
    starting = Promise.resolve().then(() => start(cfg, { signal: controller.signal })).then(value => (running = value)).catch(error => {
      if (!stopped) { if (!error.reported) notify({ state: 'error', code: safeCode(error) }); process.exitCode = 1 }
    })
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

module.exports = { bridge, startHost, run, endpoint, portOK, tokenOK, notify, failure, safeCode, DATA_MAX, WINDOW_FRAMES, WINDOW_BYTES }
