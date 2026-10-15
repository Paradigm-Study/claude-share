// Zero-dependency Node server for shared Claude Code sessions.
//
//   PORT=8787 PUBLIC_URL=https://share.example.com DATA_FILE=./rooms.json node server/node.mjs
//
// PUBLIC_URL is optional: without it, links use the request's Host (and
// X-Forwarded-* behind a proxy or tunnel). DATA_FILE is optional: without it,
// rooms (and accounts and teams) live in memory only. Sign-in for teams:
// GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET, GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET
// (AUTH_TEST=1 adds a provider that signs in whoever the link names, for tests). Previews of a host's localhost are served on a
// second port (PREVIEW_PORT, default PORT + 1), a host name of their own so an
// app's root-relative paths work; PREVIEW_URL says how people reach it.

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { Readable } from 'node:stream'

import { Directory, mapStore, providersFrom } from './teams.mjs'
import { Room, ROOM_ID, SEAT_TIMEOUT_MS, createRoom, roomRequest, previewRequest, previewRoomOf, notFound, json, publicOrigin, token, missingPage, previewMissing, homePage, outdatedClient, versionInfo, limitOf, limitedResponse, closedResponse, Windows, SOCKET_ID, previewSocketTarget, announceSocket, hostSocketAllowed, tcpRejectCode, sendableClose, TCP_LIMITS, tcpSocketTarget, announceTCP, tcpState, tcpValid, tcpReserve, tcpRefund, tcpFailure, tcpFrame, tcpCheck, tcpControl, tcpRelay } from './core.mjs'

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
const directoryData = new Map() // accounts and teams (server/teams.mjs)

// When a stream closes, check again once its grace period is over: the seat
// may not come back, and everyone else should see that.
function watch(room) {
  room.onTCPRevoke = filter => {
    for (const [id, pair] of pairs) {
      if (pair.scope === 'tcp' && pair.roomId === room.id && (!filter.cap || pair.target.cap === filter.cap) && (!filter.pid || pair.pid === filter.pid) && (!filter.seat || pair.target.ownerSeat === filter.seat)) closePair(id, pair, 1008, 'TCP grant revoked')
    }
  }
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
    for (const [key, value] of Object.entries(saved.directory ?? {})) directoryData.set(key, value)
    console.log(`loaded ${rooms.size} rooms from ${DATA_FILE}`)
  } catch {}
}

let saveTimer = null
function save(immediate = false) {
  if (!DATA_FILE) return
  const write = () => {
    saveTimer = null
    const tmp = `${DATA_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify({ rooms: [...rooms.values()].map(r => r.toJSON()), directory: Object.fromEntries(directoryData) }))
    renameSync(tmp, DATA_FILE)
  }
  // TCP reservations and admission counters must be durable before use, not
  // after the ordinary room snapshot's half-second debounce.
  if (immediate) {
    clearTimeout(saveTimer)
    write()
  } else if (!saveTimer) saveTimer = setTimeout(write, 500)
}

// Seats are settled by requests (see roomRequest); this only drops rooms a day
// after their host was last seen.
setInterval(() => {
  const now = Date.now()
  let changed = false
  for (const room of rooms.values()) {
    const lastActive = !room.endedAt && room.connected('host') ? now : Math.max(room.host.lastSeen, room.endedAt ?? 0)
    if (now - lastActive > ROOM_TTL_MS) {
      room.revokeTCP()
      rooms.delete(room.id)
      changed = true
    }
  }
  if (changed) save()
}, 60_000).unref()

const windows = new Windows()
const clientIp = req => req.headers.get('x-client-ip') ?? 'unknown'

// What a team's list shows of a room: what its own info says.
const roomInfoOf = async id => {
  const room = rooms.get(id)
  if (!room) return null
  return { title: room.title, people: room.people(Date.now()), ended: Boolean(room.endedAt) }
}
const directory = new Directory(mapStore(directoryData, () => save()), { providers: providersFrom(process.env), roomInfo: roomInfoOf })

async function route(req) {
  const url = new URL(req.url)
  const origin = publicOrigin(req, PUBLIC_URL)
  const now = Date.now()
  const parts = url.pathname.split('/').filter(Boolean)

  if (url.pathname === '/api/health') return json({ ok: true, rooms: rooms.size })
  if (url.pathname === '/api/version') return versionInfo()
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/privacy')) return homePage(origin)
  if (Directory.owns(url.pathname)) {
    if (Directory.limited(url.pathname, req.method) && !windows.hit('join', `a:${clientIp(req)}`, now)) return limitedResponse('join')
    return directory.handle(req, origin, now)
  }

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const outdated = outdatedClient(req)
    if (outdated) return outdated
    if (process.env.NEW_ROOMS === 'off') return closedResponse()
    if (!windows.hit('create', `c:${clientIp(req)}`, now)) return limitedResponse('create')
    const { room, response } = await createRoom(req, token(16), now, origin, { directory })
    if (!room) return response
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

  const reject = /^ws\/([^/]+)\/reject$/.exec(rest)
  if (req.method === 'POST' && reject) return rejectTCP(room, req, reject[1])

  const admin = Boolean(process.env.ADMIN_TOKEN) && req.headers.get('authorization') === `Bearer ${process.env.ADMIN_TOKEN}`
  const { response, changed } = await roomRequest(room, req, rest, now, origin, { previewOrigin: previewOrigin(req), admin, directory })
  if (changed) save(/^previews\/[^/]+\/tunnel$/.test(rest))
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

const serve = handle => async (nodeReq, nodeRes) => {
  try {
    const url = `http://${nodeReq.headers.host ?? 'localhost'}${nodeReq.url}`
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    const rejecting = handle === route && nodeReq.method === 'POST' && parts.length === 6 && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'ws' && parts[5] === 'reject'
    const chunks = []
    if (!rejecting) for await (const chunk of nodeReq) chunks.push(chunk)
    // This one host-only route authenticates before reading a bounded body.
    const body = rejecting ? Readable.toWeb(nodeReq, { strategy: { highWaterMark: 0 } }) : Buffer.concat(chunks)
    const headers = headersOf(nodeReq)
    // Who asked, for the limits: the socket's address (behind a proxy, set
    // TRUST_PROXY=1 to use its X-Forwarded-For).
    const forwarded = process.env.TRUST_PROXY === '1' ? String(nodeReq.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : ''
    headers.set('x-client-ip', forwarded || nodeReq.socket.remoteAddress || 'unknown')
    const req = new Request(url, {
      method: nodeReq.method,
      headers,
      body: nodeReq.method === 'GET' || nodeReq.method === 'HEAD' ? undefined : body,
      ...(rejecting ? { duplex: 'half' } : {}),
    })
    const res = await handle(req)
    const out = Object.fromEntries([...res.headers].filter(([k]) => k !== 'set-cookie'))
    if (rejecting) out.connection = 'close' // don't drain an unauthorized/oversized body
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
const pairs = new Map() // id → room/pid/purpose-bound public or TCP pair

const refuse = (socket, status, error = '') => {
  const body = error ? JSON.stringify({ error }) : ''
  socket.end(`HTTP/1.1 ${status} Refused\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

function closePair(id, pair, code = 1011, reason = '') {
  if (pairs.get(id) !== pair) return
  pairs.delete(id)
  clearTimeout(pair.timer)
  // What each half reserved and didn't carry goes back to the room's budget.
  const room = pair.scope === 'tcp' ? rooms.get(pair.roomId) : null
  if (room && tcpRefund(room, pair.guest) + tcpRefund(room, pair.host) > 0) save()
  pair.browser?.close(code, reason)
  pair.relay?.close(code, reason)
}

async function rejectTCP(room, req, id) {
  const pair = SOCKET_ID.test(id) ? pairs.get(id) : null
  const check = () => {
    if (rooms.get(room.id) !== room) return notFound()
    if (!hostSocketAllowed(room, req)) return json({ error: 'Only the host rejects a TCP relay.' }, 401)
    if (!pair || pairs.get(id) !== pair || pair.roomId !== room.id || pair.scope !== 'tcp') return notFound()
    if (pair.host || pair.relay || pair.guest.ready) return json({ error: 'That socket already has a host relay.' }, 409)
    return null
  }
  const before = check()
  if (before) return before
  const code = await tcpRejectCode(req)
  // Pairing can win while the body arrives. No await between this check/close.
  const after = check()
  if (after) return after
  if (!code) return json({ error: 'Expected exactly a BUSY or CONNECT code.' }, 400)
  closePair(id, pair, code, code === 1013 ? 'TCP host busy' : 'TCP local connect failed')
  return json({ ok: true })
}

function armTCP(id, pair) {
  clearTimeout(pair.timer)
  const due = pair.guest.ready ? pair.target.exp : Math.min(pair.target.exp, pair.guest.deadline)
  pair.timer = setTimeout(() => {
    const room = rooms.get(pair.roomId)
    if (room?.sweepTCP(Date.now())) save()
    closePair(id, pair, 1008, pair.guest.ready ? 'TCP grant expired' : 'TCP relay timeout')
  }, Math.max(0, due - Date.now())).unref()
}

function tcpMessage(id, pair, side, message) {
  if (pairs.get(id) !== pair) return
  try {
    const room = rooms.get(pair.roomId)
    const from = side === 'guest' ? pair.guest : pair.host
    const to = side === 'guest' ? pair.host : pair.guest
    if (!room || !tcpValid(room, from, Date.now())) throw tcpFailure('TCP grant revoked.')
    const frame = tcpFrame(message)
    const now = Date.now()
    tcpCheck(from, to, frame, now)
    if (frame.t === 'data' && from.remaining < frame.n) {
      if (!tcpReserve(room, from)) throw tcpFailure('TCP room byte budget exhausted.')
      save(true)
    }
    const result = tcpRelay(from, to, frame, now)
    const peer = side === 'guest' ? pair.relay : pair.browser
    for (const data of result.messages) if (!peer?.send(data)) throw tcpFailure('TCP socket send failed.', 1011)
    if (result.done) closePair(id, pair, 1000, 'TCP finished')
  } catch (error) {
    closePair(id, pair, error.code ?? 1011, error.message)
  }
}

previews.on('upgrade', (nodeReq, socket, head) => {
  if (!validHandshake(nodeReq)) return refuse(socket, 400)
  const req = new Request(`http://${nodeReq.headers.host ?? 'localhost'}${nodeReq.url}`, { headers: headersOf(nodeReq) })
  const id = previewRoomOf(req)
  const room = id && ROOM_ID.test(id) ? rooms.get(id) : undefined
  const target = room ? previewSocketTarget(room, req, Date.now()) : { ok: false, status: 404 }
  if (!target.ok) return refuse(socket, target.status)
  const wsId = token(12)
  if (!announceSocket(room, wsId, target)) return refuse(socket, 503)
  const pair = { roomId: room.id, pid: target.pid, scope: 'public', browser: null, relay: null, pending: [], pendingBytes: 0 }
  pairs.set(wsId, pair)
  pair.browser = acceptSocket(nodeReq, socket, head, target.protocols[0], {
    message: data => {
      if (pair.relay) return pair.relay.send(data)
      const n = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
      if (pair.pending.length >= 500 || pair.pendingBytes + n > TCP_LIMITS.bufferBytes) return closePair(wsId, pair, 1009, 'Preview queue limit')
      pair.pending.push(data)
      pair.pendingBytes += n
    },
    close: code => closePair(wsId, pair, code),
  })
})

server.on('upgrade', (nodeReq, socket, head) => {
  if (!validHandshake(nodeReq)) return refuse(socket, 400)
  const path = String(nodeReq.url).split('?')[0]
  const tunnel = /^\/api\/rooms\/([^/]+)\/previews\/([^/]+)\/tunnel$/.exec(path)
  const req = new Request(`http://localhost${nodeReq.url}`, { headers: headersOf(nodeReq) })
  if (tunnel) {
    const room = ROOM_ID.test(tunnel[1]) ? rooms.get(tunnel[1]) : null
    if (!room) return refuse(socket, 404)
    const active = [...pairs.values()].filter(p => p.roomId === room.id && p.scope === 'tcp').map(p => p.target)
    const before = { ...room.tcpStats.opens }
    const target = tcpSocketTarget(room, req, tunnel[2], Date.now(), active)
    try {
      if (before.count !== room.tcpStats.opens.count || before.start !== room.tcpStats.opens.start) save(true)
    } catch { return refuse(socket, 503, 'TCP admission could not be saved.') }
    if (!target.ok) return refuse(socket, target.status, target.error)
    const id = token(12)
    const pair = { roomId: room.id, pid: target.pid, scope: 'tcp', target, guest: tcpState(id, target, 'guest', Date.now()), host: null, browser: null, relay: null }
    pairs.set(id, pair)
    if (!announceTCP(room, id, target)) {
      pairs.delete(id)
      return refuse(socket, 503, 'The TCP host disconnected.')
    }
    pair.browser = acceptSocket(nodeReq, socket, head, '', { tcp: true,
      message: data => tcpMessage(id, pair, 'guest', data),
      close: code => closePair(id, pair, code === 1000 || code === 1006 ? 1011 : sendableClose(code), 'TCP socket closed'),
    })
    armTCP(id, pair)
    return
  }
  const m = /^\/api\/rooms\/([^/]+)\/ws\/([^/]+)$/.exec(path)
  const room = m && ROOM_ID.test(m[1]) ? rooms.get(m[1]) : undefined
  const pair = m && SOCKET_ID.test(m[2]) ? pairs.get(m[2]) : undefined
  if (!room || !hostSocketAllowed(room, req)) return refuse(socket, 401)
  if (!pair || pair.roomId !== room.id) return refuse(socket, 404)
  if (pair.relay) return refuse(socket, 409, 'That socket already has a host relay.')
  if (pair.scope === 'tcp') {
    if (!tcpValid(room, pair.guest, Date.now()) || Date.now() >= pair.guest.deadline) {
      closePair(m[2], pair, 1008, 'TCP grant expired or relay timed out')
      return refuse(socket, 410)
    }
    pair.host = tcpState(m[2], pair.target, 'host', Date.now())
    pair.relay = acceptSocket(nodeReq, socket, head, '', { tcp: true,
      message: data => tcpMessage(m[2], pair, 'host', data),
      close: code => closePair(m[2], pair, code === 1000 || code === 1006 ? 1011 : sendableClose(code), 'TCP socket closed'),
    })
    try {
      pair.guest.ready = pair.host.ready = true
      if (!pair.browser.send(tcpControl(pair.guest, { t: 'ready' })) || !pair.relay.send(tcpControl(pair.host, { t: 'ready' }))) throw tcpFailure('TCP ready send failed.', 1011)
      armTCP(m[2], pair)
    } catch (error) { closePair(m[2], pair, error.code ?? 1011, error.message) }
  } else {
    pair.relay = acceptSocket(nodeReq, socket, head, '', {
      message: data => pair.browser?.send(data),
      close: code => closePair(m[2], pair, code),
    })
    for (const data of pair.pending.splice(0)) pair.relay.send(data)
    pair.pendingBytes = 0
  }
})

function validHandshake(req) {
  const key = req.headers['sec-websocket-key']
  return req.method === 'GET' && String(req.headers.upgrade ?? '').toLowerCase() === 'websocket' && String(req.headers.connection ?? '').toLowerCase().split(/\s*,\s*/).includes('upgrade') && req.headers['sec-websocket-version'] === '13' && typeof key === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(key) && Buffer.from(key, 'base64').length === 16 && Buffer.from(key, 'base64').toString('base64') === key
}

// Stdlib RFC 6455 server. Bound fragments/parser/output, reject invalid frames,
// and drain a bounded queue after write(false); never drop application bytes.
function acceptSocket(nodeReq, socket, head, protocol, on) {
  const accept = createHash('sha1').update(`${nodeReq.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write(['HTTP/1.1 101 Switching Protocols', 'upgrade: websocket', 'connection: Upgrade', `sec-websocket-accept: ${accept}`, ...(protocol ? [`sec-websocket-protocol: ${protocol}`] : []), '', ''].join('\r\n'))
  const frame = (op, payload) => {
    const n = payload.length
    const h = Buffer.alloc(n < 126 ? 2 : n < 65536 ? 4 : 10)
    h[0] = 0x80 | op
    h[1] = n < 126 ? n : n < 65536 ? 126 : 127
    if (h.length === 4) h.writeUInt16BE(n, 2)
    if (h.length === 10) h.writeBigUInt64BE(BigInt(n), 2)
    return Buffer.concat([h, payload])
  }
  let closed = false, blocked = false, queuedBytes = 0
  const queue = []
  const enqueue = bytes => {
    if (socket.destroyed || queuedBytes + socket.writableLength + bytes.length > TCP_LIMITS.bufferBytes) return false
    if (blocked) {
      queue.push(bytes)
      queuedBytes += bytes.length
    } else blocked = !socket.write(bytes)
    return true
  }
  const close = (code = 1000, reason = '') => {
    if (closed) return
    closed = true
    const why = Buffer.from(String(reason).replace(/[^\x20-\x7e]/g, '?').slice(0, 100))
    const p = Buffer.alloc(2 + why.length)
    p.writeUInt16BE(sendableClose(code))
    why.copy(p, 2)
    if (!enqueue(frame(8, p))) socket.destroy()
    else if (!queue.length) socket.end()
    setTimeout(() => socket.destroy(), TCP_LIMITS.closeMs).unref()
    on.close(code)
  }
  socket.on('drain', () => {
    blocked = false
    while (queue.length && !blocked && !socket.destroyed) {
      const bytes = queue.shift()
      queuedBytes -= bytes.length
      blocked = !socket.write(bytes)
    }
    if (closed && !queue.length) socket.end()
  })
  let buf = Buffer.alloc(0), parts = [], partOp = 0, partBytes = 0, partCount = 0
  let wire = { start: Date.now(), count: 0 }
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  const maxFor = op => on.tcp ? (op === 1 ? TCP_LIMITS.controlBytes : TCP_LIMITS.dataBytes) : TCP_LIMITS.bufferBytes
  const read = () => {
    try {
      while (!closed && buf.length >= 2) {
        const fin = Boolean(buf[0] & 0x80), op = buf[0] & 15
        if ((buf[0] & 0x70) || !(buf[1] & 0x80) || ![0, 1, 2, 8, 9, 10].includes(op)) return close(1002, 'Invalid WebSocket frame')
        let n = buf[1] & 127, at = 2
        if (op >= 8 && (!fin || n > 125)) return close(1002, 'Invalid WebSocket control')
        if (n === 126) {
          if (buf.length < 4) return
          n = buf.readUInt16BE(2); at = 4
          if (n < 126) return close(1002, 'Noncanonical WebSocket length')
        } else if (n === 127) {
          if (buf.length < 10) return
          const big = buf.readBigUInt64BE(2)
          if (big < 65536n || big >> 63n) return close(1002, 'Invalid WebSocket length')
          if (big > BigInt(TCP_LIMITS.bufferBytes)) return close(1009, 'WebSocket frame too large')
          n = Number(big); at = 10
        }
        if (op < 8) {
          if ((op === 0 && !partOp) || (op !== 0 && partOp)) return close(1002, 'Invalid WebSocket fragmentation')
          if (partBytes + n > maxFor(op || partOp)) return close(1009, 'WebSocket message too large')
        }
        if (buf.length < at + 4 + n) return
        const now = Date.now()
        if (now - wire.start >= TCP_LIMITS.rateWindowMs) wire = { start: now, count: 0 }
        if (++wire.count > TCP_LIMITS.wireFramesPerWindow) return close(1008, 'WebSocket frame rate exceeded')
        const mask = buf.subarray(at, at + 4)
        const payload = Buffer.allocUnsafeSlow(n)
        buf.copy(payload, 0, at + 4, at + 4 + n)
        for (let i = 0; i < n; i++) payload[i] ^= mask[i & 3]
        buf = buf.subarray(at + 4 + n)
        if (op === 8) {
          if (n === 1) return close(1002, 'Invalid WebSocket close')
          const code = n ? payload.readUInt16BE(0) : 1000
          if (n && !((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code < 5000))) return close(1002, 'Invalid WebSocket close code')
          if (n > 2) utf8.decode(payload.subarray(2))
          return close(code)
        }
        if (op === 9) {
          if (!enqueue(frame(10, payload))) return close(1009, 'WebSocket output limit')
          continue
        }
        if (op === 10) continue
        if (op) partOp = op
        if (++partCount > TCP_LIMITS.messageFragments) return close(1009, 'WebSocket fragment count limit')
        parts.push(payload); partBytes += n
        if (fin) {
          const data = Buffer.concat(parts, partBytes), kind = partOp
          parts = []; partBytes = 0; partOp = 0; partCount = 0
          on.message(kind === 1 ? utf8.decode(data) : data)
        }
      }
    } catch { close(1007, 'Invalid WebSocket UTF-8') }
  }
  const incoming = d => {
    if (closed) return
    if (buf.length + partBytes + d.length > TCP_LIMITS.bufferBytes) return close(1009, 'WebSocket parser limit')
    buf = Buffer.concat([buf, d])
    read()
  }
  socket.on('data', incoming)
  // Upgraded HTTP sockets allow half-close, but EOF without a WS close is fatal.
  socket.on('end', () => { if (!closed) socket.destroy() })
  socket.on('close', () => {
    if (!closed) { closed = true; on.close(1006) }
  })
  socket.on('error', () => socket.destroy())
  // Install both pair halves before any data piggybacked on the handshake runs.
  if (head?.length) queueMicrotask(() => incoming(head))
  return {
    send: data => {
      if (closed) return false
      const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset ?? 0, data.byteLength)
      if (bytes.length > maxFor(typeof data === 'string' ? 1 : 2) || !enqueue(frame(typeof data === 'string' ? 1 : 2, bytes))) { close(1009, 'WebSocket output limit'); return false }
      return true
    }, close,
  }
}
