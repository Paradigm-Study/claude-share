// Cloudflare Worker + one Durable Object per shared session.
// Deploy with `npx wrangler deploy` (see wrangler.toml at the repo root).
//
// Open streams cost nothing while a room is quiet. A client's stream ends at
// the Worker, which is billed for CPU, not for time held open; the Worker
// talks to the room over a WebSocket the Durable Object accepts with the
// hibernation API, so the room leaves memory between changes and the next
// request or message wakes it. Its only timers: settle a seat that
// disconnected once its grace period is over, and drop the room a day after
// the host was last seen.

import { Room, ROOM_ID, SEAT_TIMEOUT_MS, KEEPALIVE_MS, STREAM_MAX_MS, createRoom, roomRequest, notFound, json, publicOrigin, token } from './core.mjs'

const ROOM_TTL_MS = 24 * 60 * 60 * 1000
const pad = seq => String(seq).padStart(12, '0')

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const origin = publicOrigin(req, env.PUBLIC_URL)
    const parts = url.pathname.split('/').filter(Boolean)

    if (url.pathname === '/api/health') return json({ ok: true })

    let id
    let rest
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      id = token(16)
      rest = 'create'
    } else if (parts[0] === 's' && parts.length === 2) {
      id = parts[1]
      rest = 'page'
    } else if (parts[0] === 'api' && parts[1] === 'rooms' && parts.length >= 3) {
      id = parts[2]
      rest = parts.slice(3).join('/')
    } else {
      return notFound()
    }
    if (!ROOM_ID.test(id)) return notFound()

    const stub = env.ROOMS.get(env.ROOMS.idFromName(id))
    const headers = new Headers(req.headers)
    headers.set('x-share-origin', origin)
    if (rest === 'stream' && req.method === 'GET') return bridge(stub, id, url, headers)
    return stub.fetch(
      new Request(`https://room.internal/${id}/${rest}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      }),
    )
  },
}

// A client's stream: open a WebSocket to the room and pass each message on as
// one line, with a keepalive line between. Either side closing closes both,
// and so does STREAM_MAX_MS passing: the client reconnects at once, and one
// that is gone leaves the room whatever its connection seemed to say.
async function bridge(stub, id, url, headers) {
  headers.set('upgrade', 'websocket')
  const upstream = await stub.fetch(`https://room.internal/${id}/socket${url.search}`, { headers })
  const ws = upstream.webSocket
  if (!ws) return upstream // the room's refusal (401, 404, 410), as JSON
  ws.accept()
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const enc = new TextEncoder()
  let open = true
  let keepalive = null
  let maxAge = null
  const close = () => {
    if (!open) return
    open = false
    clearInterval(keepalive)
    clearTimeout(maxAge)
    try {
      ws.close(1000, 'stream closed')
    } catch {}
    writer.close().catch(() => {})
  }
  const write = text => {
    if (open) writer.write(enc.encode(`${text}\n`)).catch(close)
  }
  ws.addEventListener('message', e => write(typeof e.data === 'string' ? e.data : ''))
  ws.addEventListener('close', close)
  ws.addEventListener('error', close)
  keepalive = setInterval(() => write(JSON.stringify({ t: Date.now() })), KEEPALIVE_MS)
  maxAge = setTimeout(close, STREAM_MAX_MS)
  return new Response(readable, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export class RoomObject {
  constructor(state) {
    this.state = state
    this.room = null
    this.savedSeq = 0
    // A socket stays in getWebSockets() while its close is being handled.
    this.closed = new WeakSet()
    state.blockConcurrencyWhile(async () => {
      const meta = await state.storage.get('meta')
      if (!meta) return
      const stored = await state.storage.list({ prefix: 'e:' })
      this.attach(Room.resume({ ...meta, events: [...stored.values()] }, Date.now()))
    })
  }

  // Who is connected is whoever has a socket open, and every change goes to
  // them.
  attach(room) {
    this.room = room
    this.savedSeq = room.seq
    room.connected = seat => this.state.getWebSockets(seat).some(ws => !this.closed.has(ws))
    room.onChange = () => this.broadcast()
  }

  async fetch(req) {
    const url = new URL(req.url)
    const origin = req.headers.get('x-share-origin') ?? url.origin
    const [id, ...restParts] = url.pathname.split('/').filter(Boolean)
    const rest = restParts.join('/')
    const now = Date.now()

    if (rest === 'create') {
      if (this.room) return json({ error: 'exists' }, 409)
      const { room, response } = await createRoom(req, id, now, origin)
      this.attach(room)
      this.savedSeq = 0
      await this.persist()
      await this.state.storage.setAlarm(now + ROOM_TTL_MS)
      return response
    }

    if (!this.room) {
      return rest === 'page'
        ? new Response('<!doctype html><meta charset="utf-8"><title>Not found</title><p>This shared session does not exist.', {
            status: 404,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        : json({ error: 'This shared session does not exist.' }, 404)
    }

    if (rest === 'socket') return this.accept(req, url, now)

    const { response, changed } = await roomRequest(this.room, req, rest, now, origin)
    if (changed) await this.persist()
    return response
  }

  accept(req, url, now) {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'Expected a WebSocket.' }, 426)
    const auth = this.room.auth((req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim())
    if (!auth) return json({ error: 'Not a member of this session.' }, 401)
    if (this.room.endedAt) return json({ error: 'This session is no longer shared.' }, 410)
    const [client, server] = Object.values(new WebSocketPair())
    this.state.acceptWebSocket(server, [auth.seat])
    server.serializeAttachment({ seat: auth.seat, role: auth.role, after: Number(url.searchParams.get('after') ?? 0) || 0 })
    this.room.touch(auth, now)
    this.send(server, now)
    if (auth.role === 'host') this.broadcast() // the host is back: everyone sees it
    return new Response(null, { status: 101, webSocket: client })
  }

  // One socket's line: everything after its cursor, and the room now.
  send(ws, now = Date.now()) {
    const att = ws.deserializeAttachment()
    if (!att || !this.room) return
    const page = this.room.page(att.after, now)
    try {
      ws.send(JSON.stringify(page))
      ws.serializeAttachment({ ...att, after: page.seq })
      if (page.ended) ws.close(1000, 'ended')
    } catch {}
  }

  broadcast() {
    const now = Date.now()
    for (const ws of this.state.getWebSockets()) if (!this.closed.has(ws)) this.send(ws, now)
  }

  webSocketMessage() {}

  async webSocketClose(ws) {
    await this.disconnected(ws)
  }

  async webSocketError(ws) {
    await this.disconnected(ws)
  }

  // A seat counts as last seen when its socket closed; look again once its
  // grace period is over.
  async disconnected(ws) {
    this.closed.add(ws)
    try {
      ws.close(1000, 'bye')
    } catch {}
    const att = ws.deserializeAttachment()
    if (!att || !this.room) return
    this.room.touch(att, Date.now())
    await this.persist()
    await this.schedule()
  }

  async persist() {
    const room = this.room
    const { events, ...meta } = room.toJSON()
    const entries = { meta }
    for (const event of events) if (event.seq > this.savedSeq) entries[`e:${pad(event.seq)}`] = event
    const keys = Object.keys(entries)
    for (let i = 0; i < keys.length; i += 100) {
      await this.state.storage.put(Object.fromEntries(keys.slice(i, i + 100).map(k => [k, entries[k]])))
    }
    this.savedSeq = room.seq
    const oldest = events[0]?.seq
    if (oldest) {
      const stale = await this.state.storage.list({ prefix: 'e:', end: `e:${pad(oldest)}`, limit: 500 })
      if (stale.size) await this.state.storage.delete([...stale.keys()])
    }
  }

  // The next thing due: a disconnected seat's grace running out, or the
  // room's expiry.
  async schedule() {
    const room = this.room
    if (!room) return
    const now = Date.now()
    const due = [this.lastActive(now) + ROOM_TTL_MS + 1000]
    for (const seat of [{ id: 'host', lastSeen: room.host.lastSeen }, ...room.seats.values()]) {
      if (!room.endedAt && !room.connected(seat.id) && now - seat.lastSeen < SEAT_TIMEOUT_MS) {
        due.push(seat.lastSeen + SEAT_TIMEOUT_MS + 1000)
      }
    }
    await this.state.storage.setAlarm(Math.min(...due))
  }

  // A host with a stream open is active now, however long ago it last spoke.
  lastActive(now) {
    const room = this.room
    if (!room.endedAt && room.connected('host')) return now
    return Math.max(room.host.lastSeen, room.endedAt ?? 0)
  }

  async alarm() {
    if (!this.room) return
    const now = Date.now()
    if (now - this.lastActive(now) > ROOM_TTL_MS) {
      for (const ws of this.state.getWebSockets()) ws.close(1000, 'expired')
      await this.state.storage.deleteAll()
      this.room = null
      return
    }
    if (this.room.sweep(now)) await this.persist()
    this.broadcast() // seats that left, and the host coming and going
    await this.schedule()
  }
}
