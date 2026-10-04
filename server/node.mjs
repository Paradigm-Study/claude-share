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
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

import { Room, ROOM_ID, SEAT_TIMEOUT_MS, createRoom, roomRequest, previewRequest, previewRoomOf, notFound, json, publicOrigin, token, missingPage, previewMissing, homePage, outdatedClient, versionInfo, limitOf, limitedResponse, closedResponse, Windows } from './core.mjs'

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

const serve = route => async (nodeReq, nodeRes) => {
  try {
    const chunks = []
    for await (const chunk of nodeReq) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const headers = new Headers()
    for (const [k, v] of Object.entries(nodeReq.headers)) {
      if (typeof v === 'string') headers.set(k, v)
      else if (Array.isArray(v)) headers.set(k, v.join(', '))
    }
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
