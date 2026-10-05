// Zero-dependency Node server for shared Claude Code sessions.
//
//   PORT=8787 PUBLIC_URL=https://share.example.com DATA_FILE=./rooms.json node server/node.mjs
//
// PUBLIC_URL is optional: without it, links use the request's Host (and
// X-Forwarded-* behind a proxy or tunnel). DATA_FILE is optional: without it,
// rooms live in memory only. Previews of a host's localhost are served on a
// second port (PREVIEW_PORT, default PORT + 1), a host name of their own so an
// app's root-relative paths work; PREVIEW_URL says how people reach it.

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

import { Room, ROOM_ID, SEAT_TIMEOUT_MS, createRoom, roomRequest, previewRequest, previewRoomOf, notFound, json, publicOrigin, token, missingPage, previewMissing, homePage, outdatedClient, versionInfo, limitOf, limitedResponse, closedResponse, Windows, SOCKET_ID, previewSocketTarget, announceSocket, hostSocketAllowed, sendableClose } from './core.mjs'

const PORT = Number(process.env.PORT ?? 8787)
const PUBLIC_URL = process.env.PUBLIC_URL
const DATA_FILE = process.env.DATA_FILE
const ROOM_TTL_MS = 24 * 60 * 60 * 1000 // ended or abandoned rooms are dropped after a day
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT ?? PORT + 1)
const PREVIEW_URL = process.env.PREVIEW_URL

// Where previews are reached: PREVIEW_URL, else this request's host on PREVIEW_PORT.
function previewOrigin(req) {
  if (PREVIEW_URL) return PREVIEW_URL.replace(/\/+$/, '')
  const url = new URL(publicOrigin(req, PUBLIC_URL))
  return `${url.protocol}//${url.hostname}:${PREVIEW_PORT}`
}

const rooms = new Map()

// When a stream closes, check again once its grace period is over: the seat
// may not come back, and everyone else should see that.
function watch(room) {
  room.onDisconnect = () => {
    setTimeout(() => {
      if (room.sweep(Date.now())) save()
      room.notify()
    }, SEAT_TIMEOUT_MS + 1000).unref()
  }
  return room
}

if (DATA_FILE) {
  try {
    const saved = JSON.parse(readFileSync(DATA_FILE, 'utf8'))
    for (const data of saved.rooms ?? []) rooms.set(data.id, watch(Room.resume(data, Date.now())))
    console.log(`loaded ${rooms.size} rooms from ${DATA_FILE}`)
  } catch {}
}

let saveTimer = null
function save() {
  if (!DATA_FILE || saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const tmp = `${DATA_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify({ rooms: [...rooms.values()].map(r => r.toJSON()) }))
    renameSync(tmp, DATA_FILE)
  }, 500)
}

// Seats are settled by requests (see roomRequest); this only drops rooms a day
// after their host was last seen.
setInterval(() => {
  const now = Date.now()
  let changed = false
  for (const room of rooms.values()) {
    const lastActive = !room.endedAt && room.connected('host') ? now : Math.max(room.host.lastSeen, room.endedAt ?? 0)
    if (now - lastActive > ROOM_TTL_MS) {
      rooms.delete(room.id)
      changed = true
    }
  }
  if (changed) save()
}, 60_000).unref()

const windows = new Windows()
const clientIp = req => req.headers.get('x-client-ip') ?? 'unknown'

async function route(req) {
  const url = new URL(req.url)
  const origin = publicOrigin(req, PUBLIC_URL)
  const now = Date.now()
  const parts = url.pathname.split('/').filter(Boolean)

  if (url.pathname === '/api/health') return json({ ok: true, rooms: rooms.size })
  if (url.pathname === '/api/version') return versionInfo()
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/privacy')) return homePage(origin)

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const outdated = outdatedClient(req)
    if (outdated) return outdated
    if (process.env.NEW_ROOMS === 'off') return closedResponse()
    if (!windows.hit('create', `c:${clientIp(req)}`, now)) return limitedResponse('create')
    const { room, response } = await createRoom(req, token(16), now, origin)
    rooms.set(room.id, watch(room))
    save()
    return response
  }

  // /s/:id → landing page; /api/rooms/:id[/rest] → room API
  let id
  let rest
  if (parts[0] === 's' && parts.length === 2) {
    id = parts[1]
    rest = 'page'
  } else if (parts[0] === 'api' && parts[1] === 'rooms' && parts.length >= 3) {
    id = parts[2]
    rest = parts.slice(3).join('/')
  } else if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'rooms' && parts.length === 5 && parts[4] === 'end') {
    id = parts[3]
    rest = 'admin-end'
  } else {
    return notFound()
  }
  const limit = limitOf(req, id, rest, clientIp(req))
  if (limit && !windows.hit(limit.kind, limit.key, now)) return limitedResponse(limit.kind)

  const room = ROOM_ID.test(id) ? rooms.get(id) : undefined
  if (!room) {
    return rest === 'page'
      ? missingPage()
      : json({ error: 'This shared session does not exist.' }, 404)
  }

  const admin = Boolean(process.env.ADMIN_TOKEN) && req.headers.get('authorization') === `Bearer ${process.env.ADMIN_TOKEN}`
  const { response, changed } = await roomRequest(room, req, rest, now, origin, { previewOrigin: previewOrigin(req), admin })
  if (changed) save()
  return response
}

async function previewRoute(req) {
  const id = previewRoomOf(req)
  const room = id && ROOM_ID.test(id) ? rooms.get(id) : undefined
  if (!room) return previewMissing()
  const { response, changed } = await previewRequest(room, req, Date.now(), { secure: new URL(previewOrigin(req)).protocol === 'https:' })
  if (changed) save()
  return response
}

function headersOf(nodeReq) {
  const headers = new Headers()
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v)
    else if (Array.isArray(v)) headers.set(k, v.join(', '))
  }
  return headers
}

const serve = route => async (nodeReq, nodeRes) => {
  try {
    const chunks = []
    for await (const chunk of nodeReq) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const headers = headersOf(nodeReq)
    // Who asked, for the limits: the socket's address (behind a proxy, set
    // TRUST_PROXY=1 to use its X-Forwarded-For).
    const forwarded = process.env.TRUST_PROXY === '1' ? String(nodeReq.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : ''
    headers.set('x-client-ip', forwarded || nodeReq.socket.remoteAddress || 'unknown')
    const req = new Request(`http://${nodeReq.headers.host ?? 'localhost'}${nodeReq.url}`, {
      method: nodeReq.method,
      headers,
      body: nodeReq.method === 'GET' || nodeReq.method === 'HEAD' ? undefined : body,
    })
    const res = await route(req)
    const out = Object.fromEntries([...res.headers].filter(([k]) => k !== 'set-cookie'))
    const cookies = res.headers.getSetCookie?.() ?? []
    if (cookies.length) out['set-cookie'] = cookies
    nodeRes.writeHead(res.status, out)
    if (!res.body) return nodeRes.end()
    // Pass the body through as it comes: a stream stays open until either side
    // closes it.
    const reader = res.body.getReader()
    nodeRes.on('close', () => reader.cancel().catch(() => {}))
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      nodeRes.write(value)
    }
    nodeRes.end()
  } catch (error) {
    nodeRes.writeHead(500, { 'content-type': 'application/json' })
    nodeRes.end(JSON.stringify({ error: String(error?.message ?? error) }))
  }
}

const server = createServer(serve(route))
server.requestTimeout = 60_000
server.listen(PORT, () => console.log(`shared sessions on http://localhost:${PORT}`))

const previews = createServer(serve(previewRoute))
previews.requestTimeout = 60_000
previews.listen(PREVIEW_PORT, () => console.log(`previews on http://localhost:${PREVIEW_PORT}`))

// WebSockets through a preview (see core.mjs): a guest's browser socket on
// the preview port, the host's relay for it on the main one, paired by id.
const pairs = new Map() // socket id → { browser, relay, pending }

const refuse = (socket, status) => {
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 503 ? 'Service Unavailable' : 'Not Found'}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
}

previews.on('upgrade', (nodeReq, socket, head) => {
  const req = new Request(`http://${nodeReq.headers.host ?? 'localhost'}${nodeReq.url}`, { headers: headersOf(nodeReq) })
  const id = previewRoomOf(req)
  const room = id && ROOM_ID.test(id) ? rooms.get(id) : undefined
  const target = room ? previewSocketTarget(room, req, Date.now()) : { ok: false, status: 404 }
  if (!target.ok) return refuse(socket, target.status)
  const wsId = token(12)
  if (!announceSocket(room, wsId, target)) return refuse(socket, 503)
  const pair = { browser: null, relay: null, pending: [] }
  pairs.set(wsId, pair)
  pair.browser = acceptSocket(nodeReq, socket, head, target.protocols[0], {
    message: data => (pair.relay ? pair.relay.send(data) : pair.pending.length < 500 && pair.pending.push(data)),
    close: code => {
      pairs.delete(wsId)
      pair.relay?.close(code)
    },
  })
})

server.on('upgrade', (nodeReq, socket, head) => {
  const m = /^\/api\/rooms\/([^/]+)\/ws\/([^/?]+)$/.exec(String(nodeReq.url).split('?')[0])
  const room = m && ROOM_ID.test(m[1]) ? rooms.get(m[1]) : undefined
  const pair = m && SOCKET_ID.test(m[2]) ? pairs.get(m[2]) : undefined
  if (!room || !hostSocketAllowed(room, new Request('http://localhost/', { headers: headersOf(nodeReq) }))) return refuse(socket, 401)
  if (!pair) return refuse(socket, 404)
  pair.relay = acceptSocket(nodeReq, socket, head, '', {
    message: data => pair.browser?.send(data),
    close: code => {
      pairs.delete(m[2])
      pair.browser?.close(code)
    },
  })
  for (const data of pair.pending.splice(0)) pair.relay.send(data)
})

// The server side of a WebSocket, enough to pass messages on: the handshake,
// frames in (masked, maybe in pieces; pings answered) and out, and a close.
function acceptSocket(nodeReq, socket, head, protocol, on) {
  const key = nodeReq.headers['sec-websocket-key']
  if (!key) return void refuse(socket, 404)
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write(['HTTP/1.1 101 Switching Protocols', 'upgrade: websocket', 'connection: Upgrade', `sec-websocket-accept: ${accept}`, ...(protocol ? [`sec-websocket-protocol: ${protocol}`] : []), '', ''].join('\r\n'))
  const frame = (op, payload) => {
    const len = payload.length
    let headBytes
    if (len < 126) headBytes = Buffer.from([0x80 | op, len])
    else if (len < 65536) {
      headBytes = Buffer.alloc(4)
      headBytes[0] = 0x80 | op
      headBytes[1] = 126
      headBytes.writeUInt16BE(len, 2)
    } else {
      headBytes = Buffer.alloc(10)
      headBytes[0] = 0x80 | op
      headBytes[1] = 127
      headBytes.writeBigUInt64BE(BigInt(len), 2)
    }
    return Buffer.concat([headBytes, payload])
  }
  let closed = false
  const close = code => {
    if (closed) return
    closed = true
    const p = Buffer.alloc(2)
    p.writeUInt16BE(sendableClose(code))
    try {
      socket.write(frame(8, p))
    } catch {}
    socket.end()
    on.close(code)
  }
  let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0)
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
        const mask = buf.subarray(maskAt, maskAt + 4)
        payload = Buffer.from(payload)
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      }
      buf = buf.subarray(at + len)
      if (op === 8) return close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000)
      if (op === 9) {
        socket.write(frame(10, payload))
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
        on.message(partOp === 1 ? data.toString('utf8') : data)
      }
    }
  }
  socket.on('data', d => {
    buf = Buffer.concat([buf, d])
    read()
  })
  socket.on('close', () => {
    if (!closed) {
      closed = true
      on.close(1006)
    }
  })
  socket.on('error', () => socket.destroy())
  if (buf.length) read()
  return {
    send: data => {
      if (!closed) socket.write(frame(typeof data === 'string' ? 1 : 2, typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)))
    },
    close,
  }
}
