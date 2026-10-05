// Shared Sessions: one WebSocket through a preview.
//
// The host's plugin starts this with its settings on stdin (never in argv,
// where other local users could read the room token): it opens the socket the
// guest's browser asked for on this machine's localhost, and one back to the
// room for that browser socket, then passes every message between the two as
// it is (text as text, binary as binary). Either closing closes the other, and
// the process ends. Plain Node, no dependencies, so it runs wherever a dev
// server does.
'use strict'

const http = require('http')
const https = require('https')
const crypto = require('crypto')

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => (input += d))
process.stdin.on('end', () => {
  let cfg
  try {
    cfg = JSON.parse(input)
  } catch {
    process.exit(2)
  }
  start(cfg)
})

const sendable = code => (Number.isInteger(code) && code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1000)

function start(cfg) {
  let done = false
  const finish = code => {
    if (done) return
    done = true
    local.close(code)
    room.close(code)
    setTimeout(() => process.exit(0), 200)
  }
  const local = connect(cfg.local, { origin: cfg.origin }, cfg.protocols || [], {
    message: (data, binary) => room.send(data, binary),
    close: finish,
  })
  const room = connect(cfg.room, { authorization: `Bearer ${cfg.token}`, 'x-shared-session-version': cfg.version || '' }, [], {
    message: (data, binary) => local.send(data, binary),
    close: finish,
  })
  // Nothing on either side for this long: give up.
  setTimeout(() => {
    if (!local.isOpen() || !room.isOpen()) finish(1011)
  }, 30_000)
}

// A WebSocket client: the handshake over http(s), masked frames out, frames in
// (fragments joined, pings answered), and a close either way. Messages sent
// before it opens wait for it. `localhost` is tried as both families.
function connect(url, headers, protocols, on) {
  const u = new URL(url)
  const secure = u.protocol === 'wss:'
  const hosts = u.hostname === 'localhost' ? ['localhost', '127.0.0.1', '::1'] : [u.hostname.replace(/^\[|\]$/g, '')]
  const queue = []
  let socket = null
  let open = false
  let closed = false

  const frame = (op, payload) => {
    const mask = crypto.randomBytes(4)
    const len = payload.length
    let head
    if (len < 126) head = Buffer.from([0x80 | op, 0x80 | len])
    else if (len < 65536) {
      head = Buffer.alloc(4)
      head[0] = 0x80 | op
      head[1] = 0x80 | 126
      head.writeUInt16BE(len, 2)
    } else {
      head = Buffer.alloc(10)
      head[0] = 0x80 | op
      head[1] = 0x80 | 127
      head.writeBigUInt64BE(BigInt(len), 2)
    }
    const body = Buffer.from(payload)
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3]
    return Buffer.concat([head, mask, body])
  }
  const write = (op, payload) => {
    if (socket && !socket.destroyed) socket.write(frame(op, payload))
  }
  const end = code => {
    if (closed) return
    closed = true
    const p = Buffer.alloc(2)
    p.writeUInt16BE(sendable(code))
    try {
      write(8, p)
    } catch {}
    if (socket) socket.end()
    on.close(code)
  }

  const attach = (s, head) => {
    socket = s
    open = true
    let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0)
    let parts = []
    let partOp = 1
    const read = () => {
      while (buf.length >= 2) {
        const fin = buf[0] & 0x80
        const op = buf[0] & 0x0f
        const masked = buf[1] & 0x80
        let len = buf[1] & 0x7f
        let at = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          at = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          at = 10
        }
        const maskAt = at
        if (masked) at += 4
        if (buf.length < at + len) return
        let payload = buf.subarray(at, at + len)
        if (masked) {
          const m = buf.subarray(maskAt, maskAt + 4)
          payload = Buffer.from(payload)
          for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]
        }
        buf = buf.subarray(at + len)
        if (op === 8) return end(payload.length >= 2 ? payload.readUInt16BE(0) : 1000)
        if (op === 9) {
          write(10, payload)
          continue
        }
        if (op === 10) continue
        if (op === 1 || op === 2) {
          partOp = op
          parts = [payload]
        } else if (op === 0) parts.push(payload)
        if (fin) {
          const data = Buffer.concat(parts)
          parts = []
          on.message(partOp === 1 ? data.toString('utf8') : data, partOp === 2)
        }
      }
    }
    s.on('data', d => {
      buf = Buffer.concat([buf, d])
      read()
    })
    s.on('close', () => end(1006))
    s.on('error', () => end(1006))
    if (buf.length) read()
    for (const [data, binary] of queue.splice(0)) send(data, binary)
  }

  const send = (data, binary) => {
    if (closed) return
    if (!open) return void queue.push([data, binary])
    write(binary ? 2 : 1, typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
  }

  const attempt = i => {
    const key = crypto.randomBytes(16).toString('base64')
    const req = (secure ? https : http).request({
      host: hosts[i],
      port: u.port || (secure ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      servername: secure ? u.hostname : undefined,
      headers: {
        ...headers,
        host: u.host,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
        ...(protocols.length ? { 'sec-websocket-protocol': protocols.join(', ') } : {}),
      },
    })
    req.on('upgrade', (res, s, head) => attach(s, head))
    req.on('response', res => {
      res.resume()
      end(1011)
    })
    req.on('error', () => (i + 1 < hosts.length && !closed ? attempt(i + 1) : end(1006)))
    req.end()
  }
  attempt(0)

  return { send, close: end, isOpen: () => open && !closed }
}
