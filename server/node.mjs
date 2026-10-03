// Zero-dependency Node server for shared Claude Code sessions.
//
//   PORT=8787 PUBLIC_URL=https://share.example.com DATA_FILE=./rooms.json node server/node.mjs
//
// PUBLIC_URL is optional: without it, links use the request's Host (and
// X-Forwarded-* behind a proxy or tunnel). DATA_FILE is optional: without it,
// rooms live in memory only.

import { createServer } from 'node:http'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

import { Room, ROOM_ID, SEAT_TIMEOUT_MS, createRoom, roomRequest, notFound, json, publicOrigin, token } from './core.mjs'

const PORT = Number(process.env.PORT ?? 8787)
const PUBLIC_URL = process.env.PUBLIC_URL
const DATA_FILE = process.env.DATA_FILE
const ROOM_TTL_MS = 24 * 60 * 60 * 1000 // ended or abandoned rooms are dropped after a day

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

async function route(req) {
  const url = new URL(req.url)
  const origin = publicOrigin(req, PUBLIC_URL)
  const now = Date.now()
  const parts = url.pathname.split('/').filter(Boolean)

  if (url.pathname === '/api/health') return json({ ok: true, rooms: rooms.size })

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
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
  } else {
    return notFound()
  }

  const room = ROOM_ID.test(id) ? rooms.get(id) : undefined
  if (!room) {
    return rest === 'page'
      ? new Response('<!doctype html><meta charset="utf-8"><title>Not found</title><p>This shared session does not exist.', {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      : json({ error: 'This shared session does not exist.' }, 404)
  }

  const { response, changed } = await roomRequest(room, req, rest, now, origin)
  if (changed) save()
  return response
}

const server = createServer(async (nodeReq, nodeRes) => {
  try {
    const chunks = []
    for await (const chunk of nodeReq) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const headers = new Headers()
    for (const [k, v] of Object.entries(nodeReq.headers)) {
      if (typeof v === 'string') headers.set(k, v)
      else if (Array.isArray(v)) headers.set(k, v.join(', '))
    }
    const req = new Request(`http://${nodeReq.headers.host ?? 'localhost'}${nodeReq.url}`, {
      method: nodeReq.method,
      headers,
      body: nodeReq.method === 'GET' || nodeReq.method === 'HEAD' ? undefined : body,
    })
    const res = await route(req)
    nodeRes.writeHead(res.status, Object.fromEntries(res.headers))
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
})

server.requestTimeout = 60_000
server.listen(PORT, () => console.log(`shared sessions on http://localhost:${PORT}`))
