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
//
// Previews run on a second Worker from this same script (ROLE = "preview",
// wrangler.preview.toml), its own workers.dev host name, bound to the rooms
// here: every path there is the host's app.

import {
  Room,
  ROOM_ID,
  SEAT_TIMEOUT_MS,
  KEEPALIVE_MS,
  STREAM_MAX_MS,
  createRoom,
  roomRequest,
  previewRequest,
  previewRoomOf,
  notFound,
  json,
  publicOrigin,
  token,
  missingPage,
  previewMissing,
  homePage,
  outdatedClient,
  versionInfo,
  limitOf,
  limitedResponse,
  closedResponse,
  busyResponse,
  Windows,
  ROOMS_PER_ADDRESS_DAY,
  ROOMS_PER_DAY,
} from './core.mjs'

const ROOM_TTL_MS = 24 * 60 * 60 * 1000
const pad = seq => String(seq).padStart(12, '0')
const CHUNK = 512 * 1024 // file bytes per storage value

// Where previews are served: PREVIEW_URL, else this Worker's workers.dev name
// with "-preview" (claude-share.x.workers.dev → claude-share-preview.x.workers.dev).
function previewOriginOf(req, env) {
  if (env.PREVIEW_URL) return env.PREVIEW_URL.replace(/\/+$/, '')
  const m = /^([^.]+)\.(.+\.workers\.dev)$/.exec(new URL(req.url).hostname)
  return m ? `https://${m[1]}-preview.${m[2]}` : ''
}

async function previewFetch(req, env) {
  const id = previewRoomOf(req)
  if (!id || !ROOM_ID.test(id)) return previewMissing()
  const url = new URL(req.url)
  const stub = env.ROOMS.get(env.ROOMS.idFromName(id))
  return stub.fetch(
    new Request(`https://room.internal/${id}/__preview${url.pathname}${url.search}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      redirect: 'manual',
    }),
  )
}

export default {
  async fetch(req, env) {
    if (env.ROLE === 'preview') return previewFetch(req, env)
    const url = new URL(req.url)
    const origin = publicOrigin(req, env.PUBLIC_URL)
    const parts = url.pathname.split('/').filter(Boolean)

    if (url.pathname === '/api/health') return json({ ok: true })
    if (url.pathname === '/api/version') return versionInfo()
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/privacy')) return homePage(origin)

    let id
    let rest
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const outdated = outdatedClient(req)
      if (outdated) return outdated
      if (env.NEW_ROOMS === 'off') return closedResponse()
      // The rate-limit binding below is loose (cached counts let a burst
      // through); the gate counts new rooms exactly, per address and per day.
      const gate = env.GATE ? await env.GATE.get(env.GATE.idFromName('gate')).fetch('https://gate.internal/', { method: 'POST', body: JSON.stringify({ ip: req.headers.get('cf-connecting-ip') ?? 'unknown', max: Number(env.MAX_ROOMS_PER_DAY) || ROOMS_PER_DAY }) }).then(r => r.json()).catch(() => ({ ok: true })) : { ok: true }
      if (!gate.ok) return gate.reason === 'day' ? busyResponse() : limitedResponse('create')
      id = token(16)
      rest = 'create'
    } else if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'rooms' && parts.length === 5 && parts[4] === 'end') {
      id = parts[3]
      rest = 'admin-end'
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
    const limit = limitOf(req, id, rest, req.headers.get('cf-connecting-ip') ?? 'unknown')
    const limiter = limit && { create: env.CREATE_LIMIT, join: env.JOIN_LIMIT, events: env.EVENTS_LIMIT }[limit.kind]
    if (limiter && !(await limiter.limit({ key: limit.key })).success) return limitedResponse(limit.kind)

    const stub = env.ROOMS.get(env.ROOMS.idFromName(id))
    const headers = new Headers(req.headers)
    headers.set('x-share-origin', origin)
    headers.set('x-preview-origin', previewOriginOf(req, env))
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
  constructor(state, env) {
    this.state = state
    this.env = env
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
    room.toHost = message => {
      let sent = false
      for (const ws of this.state.getWebSockets('host')) {
        if (this.closed.has(ws)) continue
        try {
          ws.send(JSON.stringify(message))
          sent = true
        } catch {}
      }
      return sent
    }
    // File bytes in storage, in chunks; deleteAll() at expiry takes them too.
    const storage = this.state.storage
    room.store = {
      put: async (id, data, type) => {
        const entries = { [`bm:${id}`]: { type, size: data.length, chunks: Math.ceil(data.length / CHUNK) || 1 } }
        for (let i = 0, n = 0; i < Math.max(1, data.length); i += CHUNK, n++) entries[`b:${id}:${n}`] = data.slice(i, i + CHUNK)
        await storage.put(entries)
      },
      get: async id => {
        const meta = await storage.get(`bm:${id}`)
        if (!meta) return null
        const parts = await storage.get(Array.from({ length: meta.chunks }, (_, n) => `b:${id}:${n}`))
        const data = new Uint8Array(meta.size)
        let at = 0
        for (let n = 0; n < meta.chunks; n++) {
          const part = parts.get(`b:${id}:${n}`)
          if (!part) return null
          data.set(new Uint8Array(part), at)
          at += part.byteLength
        }
        return { data, type: meta.type }
      },
    }
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
        ? missingPage()
        : json({ error: 'This shared session does not exist.' }, 404)
    }

    if (rest === 'socket') return this.accept(req, url, now)

    if (rest === '__preview' || rest.startsWith('__preview/')) {
      const path = url.pathname.slice(`/${id}/__preview`.length) || '/'
      const inner = new Request(new URL(`${path}${url.search}`, 'https://preview.local'), req)
      const { response, changed } = await previewRequest(this.room, inner, now)
      if (changed) await this.persist()
      return response
    }

    const admin = Boolean(this.env?.ADMIN_TOKEN) && req.headers.get('authorization') === `Bearer ${this.env.ADMIN_TOKEN}`
    const ctx = { previewOrigin: req.headers.get('x-preview-origin') ?? '', admin }
    const { response, changed } = await roomRequest(this.room, req, rest, now, origin, ctx)
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

// Counts new rooms exactly: per address this minute and today, and for the
// whole server today (kept in storage, so a restart doesn't reset the day).
// Only a Share reaches it, so it costs one request per room made.
export class GateObject {
  constructor(state) {
    this.state = state
    this.minute = new Windows()
    this.addresses = new Map() // ip → rooms today
    this.day = { key: '', count: 0 }
  }

  async fetch(req) {
    const { ip, max } = await req.json()
    const now = Date.now()
    const key = new Date(now).toISOString().slice(0, 10)
    if (this.day.key !== key) {
      this.day = { key, count: (await this.state.storage.get(`day:${key}`)) ?? 0 }
      this.addresses.clear()
    }
    if (this.day.count >= max) return json({ ok: false, reason: 'day' })
    if ((this.addresses.get(ip) ?? 0) >= ROOMS_PER_ADDRESS_DAY || !this.minute.hit('create', ip, now)) return json({ ok: false, reason: 'address' })
    this.addresses.set(ip, (this.addresses.get(ip) ?? 0) + 1)
    this.day.count += 1
    await this.state.storage.put(`day:${key}`, this.day.count)
    return json({ ok: true })
  }
}
