// The public preview's WebSocket relay: a browser's socket on a shared
// preview, opened on this computer's localhost and paired with one back to
// the room. Credentials arrive on stdin, never in argv or addresses. Node 20+, no deps.
'use strict'

const { connect } = require('./ws.mts')
const { failure, tokenOK, loopback, run } = require('./tcp-relay.mts')

// The public preview relay's settings, from the plugin on stdin. The
// browser's socket goes to `local`, on this computer's loopback alone: ws://,
// or wss:// for a TLS dev server, whose own certificate `insecureLocal`
// accepts on that leg alone. It carries the browser's path and query whole
// (SignalR's access_token runs past 4 KiB), bounded by stdin's 16 KiB alone.
// `origin` is the plugin's (the server's own local origin). Its pair in the
// room, `room`, always verifies.
const KEYS = new Set(['local', 'insecureLocal', 'origin', 'protocols', 'room', 'token', 'version'])
function configOf(cfg) {
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

module.exports = { start }
// The executable waits for its local leg: CONNECT is its error row, and exit 1.
if (require.main === module) run((cfg, options) => {
  const relay = start(cfg, options)
  return relay.connected.then(() => relay)
})
