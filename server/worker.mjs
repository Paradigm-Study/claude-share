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
//
// Accounts and teams (server/teams.mjs) live in one more Durable Object, the
// directory: sign-in, teams and their lists of sessions. Rooms ask it who may
// share with a team and join one; it asks rooms how they are when listing.

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
  SOCKET_ID,
  previewSocketTarget,
  announceSocket,
  hostSocketAllowed,
  noteVersion,
  sendableClose,
  TCP_LIMITS,
  tcpSocketTarget,
  announceTCP,
  tcpState,
  tcpValid,
  tcpReserve,
  tcpRefund,
  tcpFailure,
  tcpFrame,
  tcpCheck,
  tcpControl,
  tcpRelay,
} from './core.mjs'
import { Directory, providersFrom } from './teams.mjs'

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
    if (env.DIRECTORY && Directory.owns(url.pathname)) {
      if (Directory.limited(url.pathname, req.method) && !(await env.JOIN_LIMIT.limit({ key: `auth:${req.headers.get('cf-connecting-ip') ?? 'unknown'}` })).success) return limitedResponse('join')
      const headers = new Headers(req.headers)
      headers.set('x-share-origin', origin)
      return directoryStub(env).fetch(
        new Request(`https://directory.internal${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
          redirect: 'manual',
        }),
      )
    }

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
    const limiter = limit && { create: env.CREATE_LIMIT, join: env.JOIN_LIMIT, events: env.EVENTS_LIMIT, tunnel: env.TUNNEL_LIMIT }[limit.kind]
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
    // Legacy public previews only. TCP never queues pre-ready payload.
    this.pending = new Map()
    state.blockConcurrencyWhile(async () => {
      const meta = await state.storage.get('meta')
      if (!meta) return
      const stored = await state.storage.list({ prefix: 'e:' })
      const tcpStats = (await state.storage.get('tcp:stats')) ?? meta.tcpStats
      this.tcpSaved = tcpStats ? JSON.stringify(tcpStats) : ''
      this.attach(Room.resume({ ...meta, tcpStats, events: [...stored.values()] }, Date.now()))
      if (this.cleanupTCP(Date.now())) await this.persist()
      await this.schedule()
    })
  }

  // Who is connected is whoever has a socket open, and every change goes to
  // them.
  attach(room) {
    this.room = room
    this.savedSeq = room.seq
    room.connected = seat => this.state.getWebSockets(seat).some(ws => !this.closed.has(ws))
    room.onChange = () => this.broadcast()
    room.tcpSupported = () => this.state.getWebSockets('host').some(ws => !this.closed.has(ws) && ws.deserializeAttachment()?.tcpSupport === true)
    room.onTCPRevoke = filter => {
      for (const ws of this.tcpSockets()) {
        const s = ws.deserializeAttachment().tcp
        if ((!filter.cap || s.cap === filter.cap) && (!filter.pid || s.pid === filter.pid) && (!filter.seat || s.ownerSeat === filter.seat)) this.closeTCP(s.id, 1008, 'TCP grant revoked')
      }
    }
    room.toHost = message => {
      let sent = false
      for (const ws of this.state.getWebSockets('host')) {
        if (this.closed.has(ws) || (message.tcp && ws.deserializeAttachment()?.tcpSupport !== true)) continue
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
      const { room, response } = await createRoom(req, id, now, origin, { directory: directoryClient(this.env) })
      if (!room) return response
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

    if (this.cleanupTCP(now)) await this.persist()
    if (rest === 'socket') return this.accept(req, url, now)

    const upgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket'
    const tunnel = /^previews\/([A-Za-z0-9_-]+)\/tunnel$/.exec(rest)
    if (upgrade && tunnel) return this.tunnelSocket(req, tunnel[1], now)
    if (upgrade && (rest === '__preview' || rest.startsWith('__preview/'))) return this.previewSocket(req, url, id, now)
    if (upgrade && rest.startsWith('ws/')) return this.relaySocket(req, rest.slice(3), now)

    if (rest === '__preview' || rest.startsWith('__preview/')) {
      const path = url.pathname.slice(`/${id}/__preview`.length) || '/'
      const inner = new Request(new URL(`${path}${url.search}`, 'https://preview.local'), req)
      const { response, changed } = await previewRequest(this.room, inner, now)
      if (changed) await this.persist()
      return response
    }

    const admin = Boolean(this.env?.ADMIN_TOKEN) && req.headers.get('authorization') === `Bearer ${this.env.ADMIN_TOKEN}`
    const ctx = { previewOrigin: req.headers.get('x-preview-origin') ?? '', admin, directory: directoryClient(this.env) }
    const { response, changed } = await roomRequest(this.room, req, rest, now, origin, ctx)
    if (changed) await this.persist()
    // A grant made is something to sweep when it expires; a refused one isn't.
    if (changed) await this.schedule()
    return response
  }

  async accept(req, url, now) {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'Expected a WebSocket.' }, 426)
    const seated = this.room.seats.size
    const auth = this.room.auth((req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim(), now)
    if (!auth) return json({ error: 'Not a member of this session.' }, 401)
    // A seat let go for being quiet came back: kept (storage writes finish
    // before the answer goes out).
    // …and which plugin it runs now: a stream says it as any request does.
    if (noteVersion(this.room, req, auth) || this.room.seats.size !== seated) await this.persist()
    if (this.room.endedAt) return json({ error: 'This session is no longer shared.' }, 410)
    const [client, server] = Object.values(new WebSocketPair())
    this.state.acceptWebSocket(server, [auth.seat])
    server.serializeAttachment({ seat: auth.seat, role: auth.role, after: Number(url.searchParams.get('after') ?? 0) || 0, tcpSupport: auth.role === 'host' && url.searchParams.get('tcp') === '1' })
    this.room.touch(auth, now)
    this.send(server, now)
    if (auth.role === 'host') this.broadcast() // the host is back: everyone sees it
    await this.schedule()
    return new Response(null, { status: 101, webSocket: client })
  }

  // A guest's browser opens a socket on a preview: the host is asked for a
  // relay, and the two are paired by the socket's id (tags pb:/ph:), so the
  // pairing outlives the object sleeping between messages.
  previewSocket(req, url, id, now) {
    const path = url.pathname.slice(`/${id}/__preview`.length) || '/'
    const target = previewSocketTarget(this.room, new Request(new URL(`${path}${url.search}`, 'https://preview.local'), { headers: req.headers }), now)
    if (!target.ok) return new Response('This preview has ended', { status: target.status })
    const wsId = token(12)
    if (!announceSocket(this.room, wsId, target)) return new Response(`${this.room.host.name}'s Claude Code isn't connected right now.`, { status: 503 })
    const [client, server] = Object.values(new WebSocketPair())
    this.state.acceptWebSocket(server, [`pb:${wsId}`])
    server.serializeAttachment({ pb: wsId })
    return new Response(null, { status: 101, webSocket: client, headers: target.protocols[0] ? { 'sec-websocket-protocol': target.protocols[0] } : undefined })
  }

  tcpSockets() {
    return this.state.getWebSockets('tcp').filter(ws => !this.closed.has(ws) && !ws.deserializeAttachment()?.tcp?.closed)
  }

  tcpPeer(s) {
    return this.state.getWebSockets(`${s.side === 'guest' ? 'th' : 'tg'}:${s.id}`).find(ws => !this.closed.has(ws) && !ws.deserializeAttachment()?.tcp?.closed)
  }

  // Admission and MiB reservations are small durable counters, independent of
  // the transcript snapshot. Monotonic merge also protects overlapping writes.
  async persistTCPStats() {
    await this.state.storage.transaction(async storage => {
      const before = await storage.get('tcp:stats')
      const current = this.room.tcpStats
      const older = before?.opens
      const opens = older && older.start > current.opens.start ? older : older?.start === current.opens.start ? { start: older.start, count: Math.max(older.count, current.opens.count) } : current.opens
      const stats = { used: Math.max(before?.used ?? 0, current.used), refunded: Math.max(before?.refunded ?? 0, current.refunded ?? 0), opens }
      await storage.put('tcp:stats', stats)
      this.room.tcpStats = stats
      this.tcpSaved = JSON.stringify(stats)
    })
  }

  async tunnelSocket(req, pid, now) {
    if (req.method !== 'GET') return json({ error: 'Expected a WebSocket GET.' }, 405)
    // Block only admission/storage, not established channels. No process-local
    // pending queue, HTTP stream or timer survives this short upgrade request.
    return this.state.blockConcurrencyWhile(async () => {
      const active = this.tcpSockets().map(ws => ws.deserializeAttachment().tcp).filter(s => s.side === 'guest')
      const count = this.room.tcpStats.opens.count, start = this.room.tcpStats.opens.start
      const target = tcpSocketTarget(this.room, req, pid, now, active)
      if (count !== this.room.tcpStats.opens.count || start !== this.room.tcpStats.opens.start) await this.persistTCPStats()
      if (!target.ok) return json({ error: target.error }, target.status)
      const id = token(12)
      const [client, server] = Object.values(new WebSocketPair())
      this.state.acceptWebSocket(server, ['tcp', `tg:${id}`])
      server.serializeAttachment({ tcp: tcpState(id, target, 'guest', now) })
      if (!announceTCP(this.room, id, target)) {
        this.closeTCP(id, 1011, 'TCP host disconnected')
        return json({ error: 'The TCP host disconnected.' }, 503)
      }
      await this.schedule()
      return new Response(null, { status: 101, webSocket: client })
    })
  }

  sendTCP(ws, data) {
    const n = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength
    if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount + n > TCP_LIMITS.bufferBytes) throw tcpFailure('TCP socket output limit exceeded.', 1009)
    ws.send(data)
  }

  closeTCP(id, code = 1011, reason = '') {
    let refunded = false
    for (const ws of this.state.getWebSockets('tcp')) {
      const att = ws.deserializeAttachment()
      if (att?.tcp?.id !== id || att.tcp.closed) continue
      this.closed.add(ws)
      // What it reserved and didn't carry goes back to the room's budget, once.
      if (tcpRefund(this.room, att.tcp)) refunded = true
      // A close event can itself hibernate before its peer's close is handled.
      ws.serializeAttachment({ tcp: { ...att.tcp, closed: true } })
      try { ws.close(sendableClose(code), String(reason).replace(/[^\x20-\x7e]/g, '?').slice(0, 100)) } catch {}
    }
    if (refunded) void this.persistTCPStats().catch(() => {})
  }

  cleanupTCP(now) {
    const changed = this.room.sweepTCP(now)
    for (const ws of this.tcpSockets()) {
      const s = ws.deserializeAttachment().tcp
      if (!tcpValid(this.room, s, now)) this.closeTCP(s.id, 1008, 'TCP grant revoked or expired')
      else if (!s.ready && s.deadline <= now) this.closeTCP(s.id, 1008, 'TCP relay timeout')
    }
    return changed
  }

  forwardTCP(ws, peer, frame, now) {
    const from = ws.deserializeAttachment().tcp, to = peer.deserializeAttachment().tcp
    if (this.closed.has(ws) || this.closed.has(peer) || from.closed || to.closed || !tcpValid(this.room, from, now)) throw tcpFailure('TCP grant revoked.')
    const result = tcpRelay(from, to, frame, now)
    ws.serializeAttachment({ tcp: from })
    peer.serializeAttachment({ tcp: to })
    for (const data of result.messages) this.sendTCP(peer, data)
    if (result.done) this.closeTCP(from.id, 1000, 'TCP finished')
    return result.done
  }

  async tcpMessage(ws, message) {
    const s = ws.deserializeAttachment()?.tcp
    if (!s || s.closed || this.closed.has(ws)) return
    try {
      const frame = tcpFrame(message), peer = this.tcpPeer(s), now = Date.now()
      if (!tcpValid(this.room, s, now)) throw tcpFailure('TCP grant revoked or expired.')
      tcpCheck(s, peer?.deserializeAttachment()?.tcp, frame, now)
      if (frame.t === 'data' && s.remaining < frame.n) {
        // Only a refill awaits I/O. Input gating prevents another frame from
        // spending the same attachment remainder while its reservation commits.
        const failure = await this.state.blockConcurrencyWhile(async () => {
          // Throwing out of blockConcurrencyWhile resets the entire object.
          // Protocol/budget failures close just this pair, not everyone's room.
          try {
            const from = ws.deserializeAttachment().tcp
            if (from.closed || !tcpValid(this.room, from, Date.now())) throw tcpFailure('TCP grant revoked.')
            tcpCheck(from, peer.deserializeAttachment().tcp, frame, Date.now())
            if (!tcpReserve(this.room, from)) throw tcpFailure('TCP room byte budget exhausted.')
            await this.persistTCPStats()
            ws.serializeAttachment({ tcp: from })
            this.forwardTCP(ws, peer, frame, Date.now())
            return null
          } catch (error) { return error }
        })
        if (failure) throw failure
      } else if (this.forwardTCP(ws, peer, frame, now)) await this.schedule()
    } catch (error) {
      this.closeTCP(s.id, error.code ?? 1011, error.message)
      await this.schedule()
    }
  }

  // The same host-only endpoint pairs TCP and legacy public previews. Tags
  // distinguish their purposes, and a second host half is always refused.
  async relaySocket(req, wsId, now = Date.now()) {
    if (req.method !== 'GET' || !SOCKET_ID.test(wsId) || !hostSocketAllowed(this.room, req)) return json({ error: 'Only the host relays a preview.' }, 401)
    const guest = this.state.getWebSockets(`tg:${wsId}`).find(ws => !this.closed.has(ws) && !ws.deserializeAttachment()?.tcp?.closed)
    if (guest) {
      const s = guest.deserializeAttachment().tcp
      if (this.tcpPeer(s)) return json({ error: 'That socket already has a host relay.' }, 409)
      if (!tcpValid(this.room, s, now) || s.ready || s.deadline <= now) {
        this.closeTCP(wsId, 1008, 'TCP grant expired or relay timed out')
        return json({ error: 'That TCP channel has ended.' }, 410)
      }
      const [client, server] = Object.values(new WebSocketPair())
      this.state.acceptWebSocket(server, ['tcp', `th:${wsId}`])
      const host = tcpState(wsId, s, 'host', now)
      try {
        s.ready = host.ready = true
        const guestReady = tcpControl(s, { t: 'ready' }), hostReady = tcpControl(host, { t: 'ready' })
        guest.serializeAttachment({ tcp: s })
        server.serializeAttachment({ tcp: host })
        this.sendTCP(guest, guestReady)
        this.sendTCP(server, hostReady)
      } catch (error) { this.closeTCP(wsId, error.code ?? 1011, error.message) }
      await this.schedule()
      return new Response(null, { status: 101, webSocket: client })
    }
    if (!this.state.getWebSockets(`pb:${wsId}`).some(ws => !this.closed.has(ws))) return json({ error: 'That socket has closed.' }, 410)
    if (this.state.getWebSockets(`ph:${wsId}`).some(ws => !this.closed.has(ws))) return json({ error: 'That socket already has a host relay.' }, 409)
    const [client, server] = Object.values(new WebSocketPair())
    this.state.acceptWebSocket(server, [`ph:${wsId}`])
    server.serializeAttachment({ ph: wsId })
    for (const message of this.pending.get(wsId)?.messages ?? []) {
      try { server.send(message) } catch { this.unpair(server, { ph: wsId }, 1011, '') }
    }
    this.pending.delete(wsId)
    return new Response(null, { status: 101, webSocket: client })
  }

  // One socket's line: everything after its cursor, and the room now.
  send(ws, now = Date.now()) {
    const att = ws.deserializeAttachment()
    if (!att?.seat || !this.room) return
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

  // Streams send nothing; data channels never receive room JSON.
  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment()
    if (att?.tcp) return this.tcpMessage(ws, message)
    const id = att?.pb ?? att?.ph
    if (!id || this.closed.has(ws)) return
    const n = typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength
    if (n > TCP_LIMITS.bufferBytes) return this.unpair(ws, att, 1009, 'Preview message limit')
    const peers = this.state.getWebSockets(att.pb ? `ph:${id}` : `pb:${id}`).filter(p => !this.closed.has(p))
    if (!peers.length && att.pb) {
      const queue = this.pending.get(id) ?? { messages: [], bytes: 0 }
      if (queue.messages.length >= 500 || queue.bytes + n > TCP_LIMITS.bufferBytes) return this.unpair(ws, att, 1009, 'Preview queue limit')
      queue.messages.push(message)
      queue.bytes += n
      this.pending.set(id, queue)
      return
    }
    for (const peer of peers) {
      try { peer.send(message) } catch { this.unpair(ws, att, 1011, '') }
    }
  }

  async webSocketClose(ws, code, reason) {
    const att = ws.deserializeAttachment()
    if (att?.tcp) {
      this.closeTCP(att.tcp.id, code === 1000 || code === 1006 ? 1011 : sendableClose(code), 'TCP socket closed')
      await this.schedule()
      return
    }
    if (att?.pb || att?.ph) return this.unpair(ws, att, code, reason)
    await this.disconnected(ws)
  }

  async webSocketError(ws) {
    const att = ws.deserializeAttachment()
    if (att?.tcp) {
      this.closeTCP(att.tcp.id, 1011, 'TCP socket failed')
      await this.schedule()
      return
    }
    if (att?.pb || att?.ph) return this.unpair(ws, att, 1011, '')
    await this.disconnected(ws)
  }

  // Either half of a preview socket closing closes the other.
  unpair(ws, att, code, reason) {
    const id = att.pb ?? att.ph
    const close = sendableClose(code)
    this.closed.add(ws)
    for (const peer of this.state.getWebSockets(att.pb ? `ph:${id}` : `pb:${id}`)) {
      this.closed.add(peer)
      try {
        peer.close(close, String(reason ?? '').slice(0, 120))
      } catch {}
    }
    try {
      ws.close(close, 'closed')
    } catch {}
    this.pending.delete(id)
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
    // The counters' own key only when they changed: most rooms never use TCP.
    if (JSON.stringify(room.tcpStats) !== this.tcpSaved) await this.persistTCPStats()
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
    for (const grant of room.previewSessions.values()) if (grant.scope === 'tcp' && grant.exp > now) due.push(grant.exp)
    for (const ws of this.tcpSockets()) {
      const s = ws.deserializeAttachment().tcp
      due.push(s.exp)
      if (!s.ready) due.push(s.deadline)
    }
    await this.state.storage.setAlarm(Math.max(now + 1, Math.min(...due)))
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
      this.room.revokeTCP()
      for (const ws of this.state.getWebSockets()) ws.close(1000, 'expired')
      await this.state.storage.deleteAll()
      this.room = null
      return
    }
    const expired = this.cleanupTCP(now)
    if (this.room.sweep(now) || expired) await this.persist()
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

// The one directory of accounts and teams.
const directoryStub = env => env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'))

// What a room asks the directory, over its stub (paths the Worker never
// forwards from outside).
const DIRECTORY_CALLS = ['shareCheck', 'joinCheck', 'register', 'unregister', 'teamAccess', 'sessionInvite', 'whoIs']
function directoryClient(env) {
  if (!env?.DIRECTORY) return null
  const call = name => async (...args) => {
    const res = await directoryStub(env).fetch(`https://directory.internal/rpc/${name}`, { method: 'POST', body: JSON.stringify(args) })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? `directory: HTTP ${res.status}`)
    return data.result
  }
  return Object.fromEntries(DIRECTORY_CALLS.map(name => [name, call(name)]))
}

export class DirectoryObject {
  constructor(state, env) {
    const storage = state.storage
    const kv = {
      get: key => storage.get(key),
      put: (key, value) => storage.put(key, value),
      delete: key => storage.delete(key),
      list: async prefix => [...(await storage.list({ prefix })).entries()],
    }
    // How a room is, for a team's list: its own info, or nothing once it's gone.
    const roomInfo = async id => {
      if (!ROOM_ID.test(id)) return null
      const res = await env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(`https://room.internal/${id}/`)
      return res.ok ? res.json() : null
    }
    this.directory = new Directory(kv, { providers: providersFrom(env), roomInfo })
  }

  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/rpc/')) {
      const name = url.pathname.slice('/rpc/'.length)
      if (!DIRECTORY_CALLS.includes(name)) return json({ error: 'Not found' }, 404)
      try {
        return json({ result: (await this.directory[name](...(await req.json()))) ?? null })
      } catch (error) {
        return json({ error: String(error?.message ?? error) }, 500)
      }
    }
    return this.directory.handle(req, req.headers.get('x-share-origin') ?? url.origin)
  }
}
