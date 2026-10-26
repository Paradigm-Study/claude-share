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
// Accounts and teams (server/teams.ts) live in one more Durable Object, the
// directory: sign-in, teams and their lists of sessions. Rooms ask it who may
// share with a team and join one; it asks rooms how they are when listing.
// They call each other's methods (Durable Object RPC), never a path: what
// only the objects say to each other has no URL the Worker could forward.

import { DurableObject } from 'cloudflare:workers'
import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  Room,
  ROOM_ID,
  SEAT_TIMEOUT_MS,
  KEEPALIVE_MS,
  STREAM_MAX_MS,
  SEAT_STREAMS,
  createRoom,
  ended,
  roomRequest,
  previewRequest,
  previewRoomOf,
  previewKeyOf,
  previewHostLabel,
  roomOrigins,
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
  publicPairValid,
  hostHalfClose,
  tcpHalfClose,
  announceSocket,
  hostSocketAllowed,
  relayRejectCode,
  rejectReason,
  streamedRoomBody,
  bodyLimit,
  bodyTooLarge,
  readBody,
  badRequest,
  CLOUD_BUNDLE_MAX,
  noteVersion,
  sendableClose,
  TCP_LIMITS,
  PUBLIC_LIMITS,
  revokeMatches,
  tcpSocketTarget,
  announceTCP,
  tcpState,
  tcpCounted,
  tcpValid,
  tcpReserve,
  tcpRefund,
  tcpFailure,
  tcpFrame,
  tcpCheck,
  tcpStep,
  chargeControl,
  mergeTCPStats,
  leftResponse,
  statusOf,
} from './core/index.ts'
import { Directory, providersFrom, BODY_CHARS } from './teams.ts'
import type { CloudHosts, FileMeta, RevokeFilter, RoomContext, RoomData, RoomEvent, TCPFrame, TCPHalf, TCPStats } from './core/index.ts'
import type { Kv, RoomInfo } from './teams.ts'
import type { TracesEnv } from './traces/index.ts'
import type { Turn } from './traces/turns.ts'

// What the Workers are given: wrangler.toml's bindings and variables,
// wrangler.preview.toml's ROLE, and the secrets a person sets. The optional
// ones are what a server may go without (a preview Worker, no teams, no
// containers, no traces).
export type ServerEnv = Omit<TracesEnv, 'DIRECTORY'> & {
  ROLE?: string
  PUBLIC_URL?: string
  PREVIEW_URL?: string
  NEW_ROOMS?: string
  MAX_ROOMS_PER_DAY?: string
  ADMIN_TOKEN?: string
  PLUGIN_SOURCE?: string
  CREATE_LIMIT: RateLimit
  JOIN_LIMIT: RateLimit
  EVENTS_LIMIT: RateLimit
  ROOMS: DurableObjectNamespace<RoomObject>
  // Reached by fetch alone (not RPC objects), so their stubs aren't typed by class.
  GATE?: DurableObjectNamespace
  DIRECTORY?: DurableObjectNamespace<DirectoryObject>
  HOSTS?: DurableObjectNamespace
}
// Session traces (server/traces): loaded only where a database is bound.
const tracesOn = (env: ServerEnv | undefined) => Boolean(env?.TRACES_DB && env?.OAUTH_KV)
const traces = () => import('./traces/index.ts')

const ROOM_TTL_MS = 24 * 60 * 60 * 1000
const pad = (seq: number) => String(seq).padStart(12, '0')
const CHUNK = 512 * 1024 // file bytes per storage value
// A room's one value (meta, 2 MB at most): the room without its events and its
// files' records, which have keys of their own (e:<seq>, and bm:<id> beside
// each file's bytes).
export function metaOf(room: Room) {
  const { events, files, ...meta } = room.toJSON()
  return { events: events ?? [], meta }
}
// The directory reads a body whole, so the Worker reads it first, bounded:
// its characters at three bytes each.
const DIRECTORY_BODY_MAX = 3 * BODY_CHARS
// A Durable Object's id as toString() writes it: a room's preview key here.
const OBJECT_ID = /^[0-9a-f]{64}$/

// Where previews are served: PREVIEW_URL, else this Worker's workers.dev name
// with "-preview" (claude-share.x.workers.dev → claude-share-preview.x.workers.dev).
function previewOriginOf(req: Request, env: ServerEnv) {
  if (env.PREVIEW_URL) return env.PREVIEW_URL.replace(/\/+$/, '')
  const m = /^([^.]+)\.(.+\.workers\.dev)$/.exec(new URL(req.url).hostname)
  return m ? `https://${m[1]}-preview.${m[2]}` : ''
}

// A preview names its room by the room's Durable Object id (its preview key),
// never by the room's id, which joins it: idFromName can't be undone, so the
// key leads here and nowhere else. A preview Worker before keys can't route
// them, so on an update this Worker is deployed first (wrangler.preview.toml,
// scripts/setup.ts).
//
// With PREVIEW_URL a wildcard (`https://*.previews.example`), each room's
// previews have a host name of their own, and its first part is the key
// (core's previewLabel): nothing else names a room here then. The room hears
// which (`x-preview-own`, set only here).
async function previewFetch(req: Request, env: ServerEnv): Promise<Response> {
  const url = new URL(req.url)
  const own = roomOrigins(env.PREVIEW_URL)
  const key = own ? (previewKeyOf(previewHostLabel(env.PREVIEW_URL, url.host))?.hex ?? '') : (previewRoomOf(req) ?? '')
  let stub: DurableObjectStub<RoomObject> | null = null
  try { stub = OBJECT_ID.test(key) ? env.ROOMS.get(env.ROOMS.idFromString(key)) : null } catch {}
  if (!stub) return previewMissing()
  const headers = new Headers(req.headers)
  headers.delete('x-preview-own')
  if (own) headers.set('x-preview-own', '1')
  // The body as it comes: the room bounds it (PROXY_BODY_MAX) as it arrives.
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : req.body
  return stub.fetch(
    new Request(`https://room.internal/${key}/__preview${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      ...(body ? { duplex: 'half' } : {}),
    }),
  )
}

// The main Worker's routes, in the order they're looked at: what the server
// says of itself, its home page, traces (when on), the directory's paths
// (when it has one), then a room's. A preview Worker serves its rooms'
// previews alone (previewFetch). Handlers never touch `c.res`, so Hono hands
// back the Response a room gave, a WebSocket's upgrade included.
type App = { Bindings: ServerEnv }
const app = new Hono<App>()
const addressOf = (req: Request) => req.headers.get('cf-connecting-ip') ?? 'unknown'

app.all('/api/health', () => json({ ok: true }))
app.all('/api/version', c => versionInfo({ traces: tracesOn(c.env) }))
const home = (c: Context<App>) => (c.req.raw.method === 'GET' ? homePage({ traces: tracesOn(c.env) }) : notFound())
app.all('/', home)
app.all('/privacy', home)

// Session traces over MCP, and its OAuth (server/traces/oauth.ts).
app.use(async (c, next) => {
  const env = c.env
  if (!tracesOn(env) || !hasDirectory(env)) return next()
  const { isTracesPath, tracesFetch } = await traces()
  if (!isTracesPath(new URL(c.req.url).pathname)) return next()
  const req = c.req.raw
  if (!(await env.EVENTS_LIMIT.limit({ key: `traces:${addressOf(req)}` })).success) return limitedResponse('events')
  // TracesEnv types its directory's stub loosely (its own calls say what they get).
  return tracesFetch(req, env as unknown as TracesEnv, c.executionCtx as ExecutionContext, publicOrigin(req, env.PUBLIC_URL))
})

// Accounts and teams: the directory's own paths, passed on to it.
app.use(async (c, next) => {
  const env = c.env, req = c.req.raw
  const url = new URL(req.url)
  if (!hasDirectory(env) || !Directory.owns(url.pathname)) return next()
  if (Directory.limited(url.pathname, req.method) && !(await env.JOIN_LIMIT.limit({ key: `auth:${addressOf(req)}` })).success) return limitedResponse('join')
  const headers = new Headers(req.headers)
  headers.set('x-share-origin', publicOrigin(req, env.PUBLIC_URL))
  // Read here, bounded (a declared length past it refused before any):
  // the directory takes what it's given whole.
  let body: Uint8Array | undefined
  if (bodied(req)) {
    try { body = await readBody(req, DIRECTORY_BODY_MAX) } catch (error) { return statusOf(error) === 413 ? bodyTooLarge(DIRECTORY_BODY_MAX) : badRequest('The request body did not arrive.') }
  }
  return directoryStub(env).fetch(
    new Request(`https://directory.internal${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
    }),
  )
})

// A Share: a new room.
app.post('/api/rooms', async c => {
  const env = c.env, req = c.req.raw
  const outdated = outdatedClient(req)
  if (outdated) return outdated
  if (env.NEW_ROOMS === 'off') return closedResponse()
  // The rate-limit binding below is loose (cached counts let a burst
  // through); the gate counts new rooms exactly, per address and per day.
  const gate: { ok: boolean; reason?: string } = env.GATE
    ? await env.GATE.get(env.GATE.idFromName('gate')).fetch('https://gate.internal/', { method: 'POST', body: JSON.stringify({ ip: addressOf(req), max: Number(env.MAX_ROOMS_PER_DAY) || ROOMS_PER_DAY }) }).then(r => r.json<{ ok: boolean; reason?: string }>()).catch(() => ({ ok: true }))
    : { ok: true }
  if (!gate.ok) return gate.reason === 'day' ? busyResponse() : limitedResponse('create')
  return toRoom(c, token(16), 'create')
})
// A room's other paths, by the path's parts as the Worker before Hono read
// them (empty ones dropped: a share link with a slash added still opens):
// the operator's end (abuse; the room checks its admin token), a share link
// opened in a browser, and everything under /api/rooms/<id>, the rest of
// the path being the room's `rest`. Room ids are never decoded.
app.all('*', c => {
  const parts = new URL(c.req.url).pathname.split('/').filter(Boolean)
  const method = c.req.raw.method
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'rooms' && parts.length === 5 && parts[4] === 'end') return toRoom(c, parts[3]!, 'admin-end')
  if (parts[0] === 's' && parts.length === 2) return toRoom(c, parts[1]!, 'page')
  if (parts[0] === 'api' && parts[1] === 'rooms' && parts.length >= 3) return toRoom(c, parts[2]!, parts.slice(3).join('/'))
  return notFound()
})

app.notFound(() => notFound())
// What throws goes to the runtime as it did before Hono: a 500 of its own.
app.onError(error => { throw error })

export default {
  async fetch(req: Request, env: ServerEnv, ctx: ExecutionContext): Promise<Response> {
    return env.ROLE === 'preview' ? previewFetch(req, env) : app.fetch(req, env, ctx)
  },
}

const bodied = (req: Request) => req.method !== 'GET' && req.method !== 'HEAD'
const hasDirectory = (env: ServerEnv): env is ServerEnv & { DIRECTORY: DurableObjectNamespace<DirectoryObject> } => Boolean(env.DIRECTORY)

// One request for a room, to its Durable Object: limited first, its body
// passed on as a stream.
async function toRoom(c: Context<App>, id: string, rest: string): Promise<Response> {
  const env = c.env, req = c.req.raw
  const url = new URL(req.url)
  if (!ROOM_ID.test(id)) return notFound()
  // Previews have a host name of their own: this origin serves none, page
  // or socket (only previewFetch makes these paths, by the room's key).
  if (rest.startsWith('__')) return notFound()
  const limit = limitOf(req, id, rest, addressOf(req))
  const limiter = limit && { create: env.CREATE_LIMIT, join: env.JOIN_LIMIT, events: env.EVENTS_LIMIT }[limit.kind]
  if (limit && limiter && !(await limiter.limit({ key: limit.key })).success) return limitedResponse(limit.kind)

  // The packed session for the room's cloud host goes straight to it, as it
  // comes: its ticket (the room minted it with the move) is checked there.
  if (rest === 'cloud/bundle' && req.method === 'PUT') {
    if (!env.HOSTS) return notFound()
    if (!(Number(req.headers.get('content-length')) <= CLOUD_BUNDLE_MAX)) return bodyTooLarge(CLOUD_BUNDLE_MAX)
    return env.HOSTS.get(env.HOSTS.idFromName(id)).fetch(
      new Request('https://host.internal/bundle', {
        method: 'PUT',
        headers: { authorization: req.headers.get('authorization') ?? '', 'content-length': req.headers.get('content-length') ?? '' },
        body: req.body,
        // @ts-expect-error Workers' types lack it, and Workers ignore it: harmless here
        duplex: 'half',
      }),
    )
  }

  const stub = env.ROOMS.get(env.ROOMS.idFromName(id))
  const headers = new Headers(req.headers)
  headers.set('x-share-origin', publicOrigin(req, env.PUBLIC_URL))
  headers.set('x-preview-origin', previewOriginOf(req, env))
  if (rest === 'stream' && req.method === 'GET') return bridge(stub, id, url, headers)
  // Every body goes on as a stream, never buffered here: the room reads it
  // through readBody, bounded. A declared length past what the route takes
  // (bodyLimit) is refused first; the streamed
  // routes authenticate before reading and bound themselves.
  const max = bodyLimit(url.pathname)
  if (bodied(req) && !streamedRoomBody(req.method, rest) && Number(req.headers.get('content-length')) > max) return bodyTooLarge(max)
  return stub.fetch(
    new Request(`https://room.internal/${id}/${rest}${url.search}`, {
      method: req.method,
      headers,
      body: bodied(req) ? req.body : undefined,
      ...(bodied(req) ? { duplex: 'half' } : {}),
    }),
  )
}

// A client's stream: open a WebSocket to the room and pass each message on as
// one line, with a keepalive line between. Either side closing closes both,
// and so does STREAM_MAX_MS passing: the client reconnects at once, and one
// that is gone leaves the room whatever its connection seemed to say.
async function bridge(stub: DurableObjectStub<RoomObject>, id: string, url: URL, headers: Headers) {
  headers.set('upgrade', 'websocket')
  const upstream = await stub.fetch(`https://room.internal/${id}/socket${url.search}`, { headers })
  const ws = upstream.webSocket
  if (!ws) return upstream // the room's refusal (401, 404, 410), as JSON
  ws.accept()
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const enc = new TextEncoder()
  let open = true
  let keepalive: ReturnType<typeof setInterval> | undefined
  let maxAge: ReturnType<typeof setTimeout> | undefined
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
  const write = (text: string) => {
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

// What a socket carries through the room's sleep (its attachment): a stream's
// seat and cursor; a public pair's half (pb: the browser's, ph: the host's
// relay) and what let it in; a TCP half (tcpState).
type StreamAttachment = { seat: string; role: 'host' | 'guest'; after: number; at: number }
type PublicAttachment = {
  pb?: string
  ph?: string
  pid: string
  session: string
  ownerSeat: string
  exp: number
  deadline?: number
  paired?: boolean
  closed?: boolean
  rate?: { start: number; count: number; bytes?: number }
}
type TCPAttachment = { tcp: TCPHalf & { closed?: boolean } }
type Attachment = Partial<StreamAttachment> & Partial<PublicAttachment> & Partial<TCPAttachment>
const attachmentOf = (ws: WebSocket): Attachment | null => ws.deserializeAttachment()
// A TCP half's attachment, for sockets tagged 'tcp' (they always carry one).
const tcpOf = (ws: WebSocket): TCPAttachment['tcp'] => ws.deserializeAttachment().tcp
// A file's record beside its bytes: how many chunks hold them.
type StoredFile = FileMeta & { chunks: number }

export class RoomObject extends DurableObject<ServerEnv> {
  state: DurableObjectState
  room: Room | null
  savedSeq: number
  persisting: Promise<void>
  closed: WeakSet<WebSocket>
  pending: Map<string, { messages: (string | ArrayBuffer)[]; bytes: number }>
  pendingBytes: number
  tcpSaved: string
  alarmAt: number | null
  keeping: Promise<void>
  keepPending: boolean

  constructor(state: DurableObjectState, env: ServerEnv) {
    super(state, env)
    this.state = state
    this.env = env
    this.room = null
    this.savedSeq = 0
    this.persisting = Promise.resolve()
    // A socket stays in getWebSockets() while its close is being handled.
    this.closed = new WeakSet()
    // Public-link pairs (previews not forwarded): what a browser sends before
    // the host's relay pairs, in memory, and never past PUBLIC_LIMITS.pairMs,
    // the room's all together PUBLIC_LIMITS.pendingBytes at most (an isolate's
    // 128 MB is shared). TCP never queues pre-ready payload.
    this.pending = new Map()
    this.pendingBytes = 0
    // The counters as last saved (tcpCounted): a room that never used TCP never writes them.
    this.tcpSaved = tcpCounted({ used: 0 })
    // When the alarm set is due (schedule), null when none is or it's unknown.
    this.alarmAt = null
    // The traces' writes, one at a time (keepSoon), and whether turns wait in
    // its outbox for the database to take them.
    this.keeping = Promise.resolve()
    this.keepPending = false
    void state.blockConcurrencyWhile(async () => {
      this.alarmAt = (await state.storage.getAlarm()) ?? null
      const meta = await state.storage.get<Omit<RoomData, 'events' | 'files'>>('meta')
      if (!meta) { this.cleanupPublic(Date.now()); return }
      const stored = await state.storage.list<RoomEvent>({ prefix: 'e:' })
      const tcpStats = (await state.storage.get<TCPStats>('tcp:stats')) ?? meta.tcpStats
      this.tcpSaved = tcpCounted(tcpStats ?? { used: 0 })
      const files = await this.loadFiles()
      this.attach(Room.resume({ ...meta, tcpStats, files, events: [...stored.values()] }, Date.now()))
      const now = Date.now()
      this.cleanupPublic(now)
      const expired = this.live().sweepExpired(now)
      this.closeStaleTCP(now)
      if (expired) await this.persist()
      await this.schedule()
    })
  }

  // Who is connected is whoever has a socket open, and every change goes to
  // them.
  // The room, where only a request to a room that exists can be.
  live(): Room {
    if (!this.room) throw new Error('This shared session does not exist.')
    return this.room
  }

  attach(room: Room) {
    this.room = room
    this.savedSeq = room.seq
    // Previews name the room by this object's own id (previewFetch).
    room.previewKey = this.state.id?.toString() ?? room.previewKey
    room.connected = (seat: string) => this.state.getWebSockets(seat).some(ws => !this.closed.has(ws))
    room.onChange = () => this.broadcast()
    // A revocation closes the channels it covers (revokeMatches): a TCP pair
    // by its preview or seat, a public one by its browser session, seat or
    // preview.
    room.onTCPRevoke = (filter: RevokeFilter) => {
      for (const ws of this.tcpSockets()) {
        const s = tcpOf(ws)
        if (revokeMatches(filter, s)) this.closeTCP(s.id, 1008, 'TCP access revoked')
      }
    }
    room.onPreviewRevoke = (filter: RevokeFilter) => {
      for (const ws of this.publicSockets()) {
        const att = attachmentOf(ws) ?? {}
        if (revokeMatches(filter, att)) this.unpair(ws, att, 1008, 'Preview ended')
      }
    }
    // A message for one seat's streams only (the host's asks, a message
    // between sessions; room.toHost and room.toSeat): found by the seat's tag,
    // which only streams carry.
    room.toSeat = (seat: string, message: unknown) => {
      let sent = false
      for (const ws of this.state.getWebSockets(seat)) {
        const att = attachmentOf(ws)
        if (this.closed.has(ws) || att?.seat !== seat || att.tcp || att.pb || att.ph) continue
        try {
          ws.send(JSON.stringify(message))
          sent = true
        } catch {}
      }
      return sent ? 'delivered' : 'offline'
    }
    // File bytes in storage, in chunks, with what `files` holds for each
    // beside them (bm:<id>); deleteAll() at expiry takes them too.
    const storage = this.state.storage
    room.store = {
      put: async (id: string, data: Uint8Array, file: FileMeta) => {
        const entries: Record<string, unknown> = { [`bm:${id}`]: { ...file, size: data.length, chunks: Math.ceil(data.length / CHUNK) || 1 } }
        for (let i = 0, n = 0; i < Math.max(1, data.length); i += CHUNK, n++) entries[`b:${id}:${n}`] = data.slice(i, i + CHUNK)
        await storage.put(entries)
      },
      get: async (id: string) => {
        const meta = await storage.get<StoredFile>(`bm:${id}`)
        if (!meta) return null
        const parts = await storage.get<ArrayBuffer | Uint8Array>(Array.from({ length: meta.chunks }, (_, n) => `b:${id}:${n}`))
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

  // A room's files as `files` holds them, from beside their bytes (bm:<id>),
  // where every record is kept: so how many a room keeps isn't bounded by
  // what one value holds.
  async loadFiles() {
    const kept = await this.state.storage.list<StoredFile>({ prefix: 'bm:' })
    const files: Record<string, FileMeta> = {}
    for (const { chunks, ...file } of kept.values()) if (file.id) files[file.id] = file
    return files
  }

  // The directory: a members-only team's people now (DirectoryObject's keepTeam).
  async keepTeam(team: unknown, allowed: unknown) {
    if (this.room?.keepTeam(String(team ?? ''), Array.isArray(allowed) ? allowed.map(String) : [], Date.now())) await this.persist()
  }

  // The directory: how this room is, for a team's list (what GET /api/rooms/:id
  // answers), or nothing once it's gone.
  async info(): Promise<RoomInfo | null> {
    if (!this.room) return null
    const res = await this.fetch(new Request(`https://room.internal/${this.room.id}/`))
    return res.ok ? res.json<RoomInfo>() : null
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const origin = req.headers.get('x-share-origin') ?? url.origin
    const [id = '', ...restParts] = url.pathname.split('/').filter(Boolean)
    const rest = restParts.join('/')
    const now = Date.now()

    if (rest === 'create') {
      if (this.room) return json({ error: 'exists' }, 409)
      const { room, response } = await createRoom(req, id, now, origin, { directory: directoryClient(this.env) })
      if (!room) return response
      this.attach(room)
      this.savedSeq = 0
      await this.persist()
      this.alarmAt = now + ROOM_TTL_MS
      await this.state.storage.setAlarm(this.alarmAt)
      return response
    }

    // A preview's request names the room by its preview key (the preview
    // Worker's only way here); everything else, by its id.
    const preview = rest === '__preview' || rest.startsWith('__preview/')
    if (!this.room) {
      return preview ? previewMissing() : rest === 'page'
        ? missingPage()
        : json({ error: 'This shared session does not exist.' }, 404)
    }

    const room = this.room
    if (preview ? id !== room.previewKey : id !== room.id) return preview ? previewMissing() : notFound()
    // What expired is swept by the alarm, and by roomRequest for ordinary
    // requests; upgrades check what they need where they admit.
    if (req.method === 'POST') {
      const reject = /^ws\/([^/]+)\/reject$/.exec(rest)
      if (reject) return this.rejectRelay(req, reject[1]!)
    }
    if (rest === 'socket') return this.accept(req, url, now)

    const upgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket'
    const tunnel = /^previews\/([A-Za-z0-9_-]+)\/tunnel$/.exec(rest)
    if (upgrade && tunnel) return this.tunnelSocket(req, tunnel[1]!, now)
    if (upgrade && preview) return this.previewSocket(req, url, id, now)
    if (upgrade && rest.startsWith('ws/')) return this.relaySocket(req, rest.slice(3), now)

    if (preview) {
      const path = url.pathname.slice(`/${id}/__preview`.length) || '/'
      const inner = new Request(new URL(`${path}${url.search}`, 'https://preview.local'), req)
      const { response, changed } = await previewRequest(this.room, inner, now, { own: req.headers.get('x-preview-own') === '1' })
      if (changed) await this.persist()
      return response
    }

    const admin = Boolean(this.env?.ADMIN_TOKEN) && req.headers.get('authorization') === `Bearer ${this.env.ADMIN_TOKEN}`
    const ctx: RoomContext = { previewOrigin: req.headers.get('x-preview-origin') ?? '', admin, directory: directoryClient(this.env), isCurrent: () => this.room === room, cloud: hostsClient(this.env), pluginSource: this.env.PLUGIN_SOURCE }
    const counters = tcpCounted(room.tcpStats)
    const { response, changed } = await roomRequest(room, req, rest, now, origin, ctx)
    if (changed) await this.persist()
    // Turns that ended go to traces after the answer, not before it.
    if (changed) void this.keepSoon()
    // The byte budget changed without the room (a revocation's refund): its key alone.
    else if (this.room === room && tcpCounted(room.tcpStats) !== counters) await this.persistTCPStats()
    // A link or a browser session made is something to sweep when it expires.
    if (changed) await this.schedule()
    return response
  }

  async accept(req: Request, url: URL, now: number) {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'Expected a WebSocket.' }, 426)
    const room = this.live()
    const seated = room.seats.size
    const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    // Left from elsewhere (the Team panel's Leave): told so, never seated again.
    if (room.leftElsewhere.has(bearer)) return leftResponse()
    const auth = room.auth(bearer, now)
    if (!auth) return json({ error: 'Not a member of this session.' }, 401)
    // A seat let go for being quiet came back: kept (storage writes finish
    // before the answer goes out).
    // …and which plugin it runs now: a stream says it as any request does.
    if (noteVersion(room, req, auth) || room.seats.size !== seated) await this.persist()
    if (room.endedAt) return json({ error: 'This session is no longer shared.' }, 410)
    // A seat's streams past SEAT_STREAMS: its oldest ends (a reconnect's old
    // one, likely, not noticed gone yet).
    const mine = this.state.getWebSockets(auth.seat).filter(ws => !this.closed.has(ws) && ws.deserializeAttachment()?.seat === auth.seat)
      .sort((a, b) => (a.deserializeAttachment().at ?? 0) - (b.deserializeAttachment().at ?? 0))
    for (const old of mine.slice(0, Math.max(0, mine.length - SEAT_STREAMS + 1))) {
      this.closed.add(old)
      try { old.close(1008, 'Too many streams') } catch {}
    }
    const { 0: client, 1: server } = new WebSocketPair()
    // Tagged as a stream, so a change goes to streams alone (broadcast), and
    // by seat, for who is connected.
    this.state.acceptWebSocket(server, ['stream', auth.seat])
    server.serializeAttachment({ seat: auth.seat, role: auth.role, after: Number(url.searchParams.get('after') ?? 0) || 0, at: now })
    room.touch(auth, now)
    this.send(server, now)
    if (auth.role === 'host') this.broadcast() // the host is back: everyone sees it
    await this.schedule()
    return new Response(null, { status: 101, webSocket: client })
  }

  // A guest's browser opens a socket on a preview: the host is asked for a
  // relay, and the two are paired by the socket's id (tags pb:/ph:), so the
  // pairing outlives the object sleeping between messages. Both halves carry
  // what let the browser in (its session, seat, preview, expiry), and the
  // browser's its pairing deadline.
  async previewSocket(req: Request, url: URL, id: string, now: number) {
    const room = this.live()
    // Halves past their deadline hold no place: checked right before admission.
    this.cleanupPublic(now)
    const path = url.pathname.slice(`/${id}/__preview`.length) || '/'
    const active = this.publicSockets().map(attachmentOf).filter(att => att?.pb).map(att => ({ ownerSeat: att?.ownerSeat }))
    const target = previewSocketTarget(room, new Request(new URL(`${path}${url.search}`, 'https://preview.local'), { headers: req.headers }), now, active)
    if (!target.ok) return new Response(target.error ?? 'This preview has ended', { status: target.status })
    const wsId = token(12)
    if (!announceSocket(room, wsId, target)) return new Response(`${room.host.name}'s Claude Code isn't connected right now.`, { status: 503 })
    const { 0: client, 1: server } = new WebSocketPair()
    this.state.acceptWebSocket(server, ['public', `pb:${wsId}`])
    server.serializeAttachment({ pb: wsId, pid: target.pid, session: target.session, ownerSeat: target.ownerSeat, exp: target.exp, deadline: now + PUBLIC_LIMITS.pairMs })
    await this.schedule()
    return new Response(null, { status: 101, webSocket: client, headers: target.protocols[0] ? { 'sec-websocket-protocol': target.protocols[0] } : undefined })
  }

  publicValid(att: Attachment | null) {
    return publicPairValid(this.room, att && att.pid !== undefined && att.session !== undefined && att.exp !== undefined ? { pid: att.pid, session: att.session, exp: att.exp, closed: att.closed } : null, Date.now())
  }

  publicSockets() {
    return this.state.getWebSockets('public').filter(ws => !this.closed.has(ws) && !ws.deserializeAttachment()?.closed)
  }

  // A public pair whose preview, browser session or room went closes (an
  // attachment that doesn't name them all proves nothing, so it closes too),
  // and so does a browser's half the host didn't take up by its deadline.
  // From the constructor, the alarm and right before admission.
  cleanupPublic(now: number) {
    for (const ws of this.publicSockets()) {
      const att = attachmentOf(ws) ?? {}
      if (!this.publicValid(att)) this.unpair(ws, att, 1008, 'Preview ended')
      else if (att.pb && !att.paired && !((att.deadline ?? 0) > now)) this.unpair(ws, att, 1011, 'Preview relay timeout')
    }
  }

  tcpSockets() {
    return this.state.getWebSockets('tcp').filter(ws => !this.closed.has(ws) && !ws.deserializeAttachment()?.tcp?.closed)
  }

  tcpPeer(s: TCPHalf) {
    return this.state.getWebSockets(`${s.side === 'guest' ? 'th' : 'tg'}:${s.id}`).find(ws => !this.closed.has(ws) && !ws.deserializeAttachment()?.tcp?.closed)
  }

  // Admission and MiB reservations are small durable counters, independent of
  // the transcript snapshot. Monotonic merge also protects overlapping writes.
  async persistTCPStats() {
    await this.state.storage.transaction(async storage => {
      const room = this.live()
      const stats = mergeTCPStats(await storage.get<TCPStats>('tcp:stats'), room.tcpStats)
      await storage.put('tcp:stats', stats)
      room.tcpStats = stats
      this.tcpSaved = tcpCounted(stats)
    })
  }

  async tunnelSocket(req: Request, pid: string, now: number) {
    if (req.method !== 'GET') return json({ error: 'Expected a WebSocket GET.' }, 405)
    // Admission is synchronous up to the socket's acceptance, so no barrier:
    // one (blockConcurrencyWhile) held every channel's messages in the room
    // for each connection a browser opened. The minute of opens it counts is
    // memory's, as every other minute's is; nothing is written for it.
    // A half past its pairing deadline holds no place: checked right before
    // admission, the one check outside the alarm.
    this.closeStaleTCP(now)
    const room = this.live()
    const active = this.tcpSockets().map(tcpOf).filter(s => s.side === 'guest')
    const target = tcpSocketTarget(room, req, pid, now, active)
    if (!target.ok) return json({ error: target.error }, target.status)
    const id = token(12)
    const { 0: client, 1: server } = new WebSocketPair()
    this.state.acceptWebSocket(server, ['tcp', `tg:${id}`])
    server.serializeAttachment({ tcp: tcpState(id, target, 'guest', now) })
    if (!announceTCP(room, id, target)) {
      this.closeTCP(id, 1011, 'TCP host disconnected')
      return json({ error: 'The TCP host disconnected.' }, 503)
    }
    await this.schedule()
    return new Response(null, { status: 101, webSocket: client })
  }

  sendTCP(ws: WebSocket, data: string | ArrayBuffer | ArrayBufferView) {
    const n = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength
    const buffered = (ws as WebSocket & { bufferedAmount?: number }).bufferedAmount
    if (typeof buffered === 'number' && buffered + n > TCP_LIMITS.bufferBytes) throw tcpFailure('TCP socket output limit exceeded.', 1009)
    ws.send(data)
  }

  closeTCP(id: string, code: unknown = 1011, reason: unknown = '') {
    let refunded = false
    for (const ws of this.state.getWebSockets('tcp')) {
      const att = ws.deserializeAttachment()
      if (att?.tcp?.id !== id || att.tcp.closed) continue
      this.closed.add(ws)
      // What it reserved and didn't carry goes back to the room's budget, once.
      if (this.room && tcpRefund(this.room, att.tcp)) refunded = true
      // A close event can itself hibernate before its peer's close is handled.
      ws.serializeAttachment({ tcp: { ...att.tcp, closed: true } })
      try { ws.close(sendableClose(code), String(reason).replace(/[^\x20-\x7e]/g, '?').slice(0, 100)) } catch {}
    }
    if (refunded) void this.persistTCPStats().catch(() => {})
  }

  // The host turning away a socket it was asked to relay, while that socket
  // waits for its host half: a TCP guest half (its worker busy, the port
  // refusing) or a public browser (more relays than it runs, the port
  // refusing). Never one already paired.
  async rejectRelay(req: Request, id: string) {
    const room = this.live()
    const live = (ws: WebSocket) => !this.closed.has(ws) && !ws.deserializeAttachment()?.closed && !ws.deserializeAttachment()?.tcp?.closed
    const guest = SOCKET_ID.test(id) ? this.tcpSockets().find(ws => {
      const s = tcpOf(ws)
      return s.id === id && s.room === room.id && s.side === 'guest'
    }) : null
    const browser = SOCKET_ID.test(id) && !guest ? this.publicSockets().find(ws => ws.deserializeAttachment().pb === id) : null
    const check = () => {
      if (this.room !== room) return notFound()
      if (!hostSocketAllowed(room, req)) return json({ error: 'Only the host rejects a relay.' }, 401)
      if (guest) {
        if (!this.tcpSockets().includes(guest)) return notFound()
        const s = tcpOf(guest)
        if (s.id !== id || s.room !== room.id || s.side !== 'guest') return notFound()
        if (s.ready || this.tcpPeer(s)) return json({ error: 'That socket already has a host relay.' }, 409)
        return null
      }
      if (!browser || !this.publicSockets().includes(browser)) return notFound()
      if (browser.deserializeAttachment().paired || this.state.getWebSockets(`ph:${id}`).some(live)) return json({ error: 'That socket already has a host relay.' }, 409)
      return null
    }
    const before = check()
    if (before) return before
    const code = await relayRejectCode(req)
    return this.state.blockConcurrencyWhile(async () => {
      const after = check()
      if (after) return after
      if (!code) return json({ error: 'Expected exactly a BUSY or CONNECT code.' }, 400)
      if (guest) this.closeTCP(id, code, rejectReason('TCP', code))
      else if (browser) this.unpair(browser, attachmentOf(browser) ?? {}, code, rejectReason('Preview', code))
      await this.schedule()
      return json({ ok: true })
    })
  }

  // TCP halves no longer valid (their seat or preview gone, the room ended),
  // and guest halves past their pairing deadline.
  closeStaleTCP(now: number) {
    const room = this.live()
    for (const ws of this.tcpSockets()) {
      const s = tcpOf(ws)
      if (!tcpValid(room, s)) this.closeTCP(s.id, 1008, 'TCP access revoked')
      else if (!s.ready && s.deadline <= now) this.closeTCP(s.id, 1008, 'TCP relay timeout')
    }
  }

  // One message through tcpStep, both halves' attachments saved before any of
  // it is sent on: 'reserve' when the sender's budget must grow first, 'done'
  // when it finished the channel, else 'sent'.
  forwardTCP(ws: WebSocket, peer: WebSocket | undefined, frame: TCPFrame, now: number) {
    const from = tcpOf(ws), to: TCPAttachment['tcp'] | undefined = peer?.deserializeAttachment()?.tcp
    if (this.closed.has(ws) || (peer && this.closed.has(peer)) || from.closed || to?.closed) throw tcpFailure('TCP channel closed.')
    const step = tcpStep(this.live(), from, to, frame, now)
    // A half without its peer was refused above (tcpCheck: not paired).
    if (!peer || !to) throw tcpFailure('TCP channel is not paired.')
    if (step.reserve) return 'reserve'
    ws.serializeAttachment({ tcp: from })
    peer.serializeAttachment({ tcp: to })
    for (const data of step.messages) this.sendTCP(peer, data)
    if (!step.done) return 'sent'
    this.closeTCP(from.id, 1000, 'TCP finished')
    return 'done'
  }

  async tcpMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const s: TCPAttachment['tcp'] | undefined = attachmentOf(ws)?.tcp
    if (!s || s.closed || this.closed.has(ws)) return
    try {
      const frame = tcpFrame(message), peer = this.tcpPeer(s)
      const step = this.forwardTCP(ws, peer, frame, Date.now())
      if (step === 'done') await this.schedule()
      if (step !== 'reserve') return
      // Only a refill awaits I/O. Input gating prevents another frame from
      // spending the same attachment remainder while its reservation commits.
      const failure = await this.state.blockConcurrencyWhile(async () => {
        // Throwing out of blockConcurrencyWhile resets the entire object.
        // Protocol/budget failures close just this pair, not everyone's room.
        try {
          const from = tcpOf(ws), room = this.live()
          if (from.closed || !tcpValid(room, from)) throw tcpFailure('TCP access revoked.')
          tcpCheck(from, peer?.deserializeAttachment()?.tcp, frame, Date.now())
          if (!tcpReserve(room, from)) throw tcpFailure('TCP room byte budget exhausted.')
          await this.persistTCPStats()
          ws.serializeAttachment({ tcp: from })
          // A reservation is larger than any frame: the step now relays.
          if (this.forwardTCP(ws, peer, frame, Date.now()) === 'reserve') throw tcpFailure('TCP room byte budget exhausted.')
          return null
        } catch (error) { return error }
      })
      if (failure) throw failure
    } catch (error) {
      this.closeTCP(s.id, (error as { code?: number }).code ?? 1011, (error as Error).message)
      await this.schedule()
    }
  }

  // The same host-only endpoint pairs TCP and public-link previews. Tags
  // distinguish their purposes, and a second host half is always refused.
  async relaySocket(req: Request, wsId: string, now = Date.now()) {
    const room = this.live()
    if (req.method !== 'GET' || !SOCKET_ID.test(wsId) || !hostSocketAllowed(room, req)) return json({ error: 'Only the host relays a preview.' }, 401)
    const guest = this.state.getWebSockets(`tg:${wsId}`).find(ws => !this.closed.has(ws) && !ws.deserializeAttachment()?.tcp?.closed)
    if (guest) {
      const s = tcpOf(guest)
      if (this.tcpPeer(s)) return json({ error: 'That socket already has a host relay.' }, 409)
      if (!tcpValid(room, s) || s.ready || s.deadline <= now) {
        this.closeTCP(wsId, 1008, 'TCP access revoked or relay timed out')
        return json({ error: 'That TCP channel has ended.' }, 410)
      }
      const { 0: client, 1: server } = new WebSocketPair()
      this.state.acceptWebSocket(server, ['tcp', `th:${wsId}`])
      const host = tcpState(wsId, s, 'host', now)
      try {
        s.ready = host.ready = true
        const guestReady = chargeControl(s, { t: 'ready' }), hostReady = chargeControl(host, { t: 'ready' })
        guest.serializeAttachment({ tcp: s })
        server.serializeAttachment({ tcp: host })
        this.sendTCP(guest, guestReady)
        this.sendTCP(server, hostReady)
      } catch (error) { this.closeTCP(wsId, (error as { code?: number }).code ?? 1011, (error as Error).message) }
      await this.schedule()
      return new Response(null, { status: 101, webSocket: client })
    }
    const browser = this.state.getWebSockets(`pb:${wsId}`).find(ws => !this.closed.has(ws) && !ws.deserializeAttachment()?.closed)
    if (!browser) return json({ error: 'That socket has closed.' }, 410)
    const att = attachmentOf(browser) ?? {}
    if (!this.publicValid(att)) {
      this.unpair(browser, att, 1008, 'Preview ended')
      return json({ error: 'That preview has ended.' }, 410)
    }
    if (this.state.getWebSockets(`ph:${wsId}`).some(ws => !this.closed.has(ws) && !ws.deserializeAttachment()?.closed)) return json({ error: 'That socket already has a host relay.' }, 409)
    // Taken up too late: the alarm closes it at its deadline, this before.
    if (!((att.deadline ?? 0) > now)) {
      this.unpair(browser, att, 1011, 'Preview relay timeout')
      return json({ error: 'That socket has closed.' }, 410)
    }
    // No await between the current pid check and installing/draining its half.
    const { 0: client, 1: server } = new WebSocketPair()
    this.state.acceptWebSocket(server, ['public', `ph:${wsId}`])
    const binding = { ph: wsId, pid: att.pid, session: att.session, ownerSeat: att.ownerSeat, exp: att.exp }
    server.serializeAttachment(binding)
    browser.serializeAttachment({ ...att, paired: true })
    for (const message of this.takePending(wsId)?.messages ?? []) {
      try { server.send(message) } catch { this.unpair(server, binding, 1011, ''); break }
    }
    await this.schedule()
    return new Response(null, { status: 101, webSocket: client })
  }

  // A browser socket's waiting messages, out of the room's total.
  takePending(id: string) {
    const queue = this.pending.get(id)
    if (queue) this.pendingBytes -= queue.bytes
    this.pending.delete(id)
    return queue
  }

  // One socket's line: everything after its cursor, and the room now.
  send(ws: WebSocket, now = Date.now()) {
    const att = attachmentOf(ws)
    if (!att?.seat || !this.room) return
    // Its seat let go for good (removed from the room's team): it hears no more.
    if (att.role !== 'host' && !this.room.seated(att.seat)) {
      try { ws.close(1008, 'left') } catch {}
      return
    }
    const page = this.room.page(att.after ?? 0, now)
    try {
      ws.send(JSON.stringify(page))
      ws.serializeAttachment({ ...att, after: page.seq })
      if (page.ended) ws.close(1000, 'ended')
    } catch {}
  }

  // A change goes to the streams alone: TCP and public channels never read
  // room JSON, so their attachments aren't even opened for it.
  broadcast() {
    const now = Date.now()
    for (const ws of this.state.getWebSockets('stream')) if (!this.closed.has(ws)) this.send(ws, now)
  }

  // Streams send nothing; data channels never receive room JSON.
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const att = attachmentOf(ws)
    if (att?.tcp) return this.tcpMessage(ws, message)
    if (!(att?.pb ?? att?.ph) || this.closed.has(ws) || att.closed) return
    this.publicMessage(ws, att, message)
  }

  // An app's own message on a public pair, passed on as it is, bounded as
  // Node's parser bounds its sockets: so many a second per socket (counted in
  // its attachment, which outlives the object sleeping), and no more output a
  // peer hasn't taken than a megabyte where the runtime says how much.
  // workerd doesn't report bufferedAmount, so there each socket sends at
  // most PUBLIC_LIMITS.bytesPerWindow a second (counted beside its rate): a
  // fast sender can't fill the isolate's memory behind a slow reader.
  publicMessage(ws: WebSocket, att: Attachment, message: string | ArrayBuffer) {
    const id = att.pb ?? att.ph ?? ''
    if (!this.publicValid(att)) return this.unpair(ws, att, 1008, 'Preview ended')
    const n = typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength
    if (n > PUBLIC_LIMITS.bufferBytes) return this.unpair(ws, att, 1009, 'Preview message limit')
    const now = Date.now()
    const rate = att.rate && now - att.rate.start < PUBLIC_LIMITS.rateWindowMs ? { ...att.rate } : { start: now, count: 0, bytes: 0 }
    if (++rate.count > PUBLIC_LIMITS.framesPerWindow) return this.unpair(ws, att, 1008, 'WebSocket frame rate exceeded')
    if ((rate.bytes = (rate.bytes ?? 0) + n) > PUBLIC_LIMITS.bytesPerWindow) return this.unpair(ws, att, 1009, 'WebSocket byte rate exceeded')
    ws.serializeAttachment({ ...att, rate })
    const peers = this.state.getWebSockets(att.pb ? `ph:${id}` : `pb:${id}`).filter(p => !this.closed.has(p) && !p.deserializeAttachment()?.closed)
    if (peers.some(p => p.deserializeAttachment()?.pid !== att.pid)) return this.unpair(ws, att, 1008, 'Preview identity changed')
    if (!peers.length && att.pb) {
      const queue = this.pending.get(id) ?? { messages: [], bytes: 0 }
      if (queue.messages.length >= PUBLIC_LIMITS.queueMessages || queue.bytes + n > PUBLIC_LIMITS.queueBytes || this.pendingBytes + n > PUBLIC_LIMITS.pendingBytes) return this.unpair(ws, att, 1009, 'Preview queue limit')
      queue.messages.push(message)
      queue.bytes += n
      this.pendingBytes += n
      this.pending.set(id, queue)
      return
    }
    for (const peer of peers) {
      const buffered = (peer as WebSocket & { bufferedAmount?: number }).bufferedAmount
      if (typeof buffered === 'number' && buffered + n > PUBLIC_LIMITS.bufferBytes) return this.unpair(ws, att, 1009, 'WebSocket output limit')
      try { peer.send(message) } catch { this.unpair(ws, att, 1011, '') }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string) {
    const att = attachmentOf(ws)
    if (att?.tcp) {
      this.closeTCP(att.tcp.id, tcpHalfClose(code), 'TCP socket closed')
      await this.schedule()
      return
    }
    // A host half that vanished (no close frame) is a failure the page sees.
    if (att?.pb || att?.ph) return this.unpair(ws, att, att.ph ? hostHalfClose(code) : code, reason)
    await this.disconnected(ws)
  }

  override async webSocketError(ws: WebSocket) {
    const att = attachmentOf(ws)
    if (att?.tcp) {
      this.closeTCP(att.tcp.id, 1011, 'TCP socket failed')
      await this.schedule()
      return
    }
    if (att?.pb || att?.ph) return this.unpair(ws, att, 1011, '')
    await this.disconnected(ws)
  }

  // Either half of a preview socket closing closes the other.
  unpair(ws: WebSocket, att: Attachment, code: unknown, reason: unknown) {
    const id = att.pb ?? att.ph ?? ''
    const close = sendableClose(code)
    for (const peer of [ws, ...this.state.getWebSockets(att.pb ? `ph:${id}` : `pb:${id}`)]) {
      this.closed.add(peer)
      const binding = attachmentOf(peer)
      if (binding?.closed) continue
      // Closing sockets can still be listed after hibernation. Keep the fence
      // in their attachments as well as the object-local WeakSet.
      peer.serializeAttachment({ ...binding, closed: true })
      try {
        peer.close(close, String(reason ?? '').slice(0, 120))
      } catch {}
    }
    this.takePending(id)
  }

  // A seat counts as last seen when its socket closed; look again once its
  // grace period is over.
  async disconnected(ws: WebSocket) {
    this.closed.add(ws)
    try {
      ws.close(1000, 'bye')
    } catch {}
    const att = attachmentOf(ws)
    if (!att || !this.room) return
    if (att.seat && att.role) this.room.touch({ role: att.role, seat: att.seat, name: '' }, Date.now())
    await this.persist()
    await this.schedule()
  }

  persist(): Promise<void> {
    // Body reads may overlap, but an older metadata save must never finish
    // after a newer one (a preview's Stop, a Leave). Capture each
    // snapshot only when the previous save has finished.
    const saving = this.persisting.catch(() => {}).then(() => this.saveRoom())
    this.persisting = saving
    return saving
  }

  async saveRoom() {
    const room = this.room
    if (!room) return
    // The counters' own key only when they changed: most rooms never use TCP.
    if (tcpCounted(room.tcpStats) !== this.tcpSaved) await this.persistTCPStats()
    // Files are kept beside their bytes (store.put), never in meta.
    const { events, meta } = metaOf(room)
    const entries: Record<string, unknown> = { meta }
    for (const event of events) if (event.seq > this.savedSeq) entries[`e:${pad(event.seq)}`] = event
    const keys = Object.keys(entries)
    for (let i = 0; i < keys.length; i += 100) {
      await this.state.storage.put(Object.fromEntries(keys.slice(i, i + 100).map(k => [k, entries[k]])))
    }
    this.savedSeq = meta.seq ?? 0
    const oldest = events[0]?.seq
    if (oldest) {
      const stale = await this.state.storage.list({ prefix: 'e:', end: `e:${pad(oldest)}`, limit: 500 })
      if (stale.size) await this.state.storage.delete([...stale.keys()])
    }
  }

  // Session traces (server/traces): the turns that ended since the last
  // look, from the room's events, written to its outbox and then to the
  // database. What's read and the turn still open are kept in storage
  // (traces:*), so a room that sleeps or restarts carries on; the outbox is
  // emptied only once the database took it, and the alarm tries again a
  // minute later.
  keepSoon() {
    if (!tracesOn(this.env) || !this.room) return Promise.resolve()
    this.keeping = this.keeping.catch(() => {}).then(() => this.keepNew(false))
    return this.keeping.catch(() => {})
  }

  async keepNew(final: boolean) {
    const room = this.room
    if (!room || !tracesOn(this.env)) return
    const { tracesScope, takeTurns, authorOf, keepTurns } = await traces()
    const scope = tracesScope(room)
    if (!scope) return
    const storage = this.state.storage
    const [seen, open, waiting] = await Promise.all([storage.get<number>('traces:seq'), storage.get<Turn>('traces:open'), storage.get<Turn[]>('traces:out')])
    const { closed, open: still } = takeTurns(room.events.filter(e => e.seq > (seen ?? 0)), open ?? null, name => authorOf(room, name))
    if (final && still) closed.push(still)
    // A database down for long holds the newest 500 turns.
    const out = [...(waiting ?? []), ...closed].slice(-500)
    if (room.seq !== seen || closed.length) {
      await storage.put({ 'traces:seq': room.seq, 'traces:out': out })
      if (still && !final) await storage.put('traces:open', still)
      else await storage.delete('traces:open')
    }
    if (!out.length) return
    try {
      await keepTurns(this.env as unknown as TracesEnv, { id: room.id, scope, team: room.team?.id ?? null, owner: { name: room.host.name, account: room.host.account ?? null }, title: room.title ?? null }, out)
      await storage.put('traces:out', [])
      this.keepPending = false
    } catch (error) {
      this.keepPending = true
      console.warn(`traces: ${out.length} turns wait: ${(error as Error | null)?.message ?? error}`)
      if (!final) await this.schedule()
    }
  }

  // The next thing due: a disconnected seat's grace running out, a browser
  // session expiring, a socket's pairing deadline, or the room's expiry. Set
  // only when that's sooner than the alarm already set (or none is): one set
  // for later fires early, and alarm() looks again and sets the next, so a
  // connection or a stream's turn writes no alarm of its own.
  async schedule() {
    const room = this.room
    if (!room) return
    const now = Date.now()
    const due = [this.lastActive(now) + ROOM_TTL_MS + 1000]
    if (this.keepPending) due.push(now + 60_000)
    for (const seat of [{ id: 'host', lastSeen: room.host.lastSeen }, ...room.seats.values()]) {
      if (!room.endedAt && !room.connected(seat.id) && now - seat.lastSeen < SEAT_TIMEOUT_MS) {
        due.push(seat.lastSeen + SEAT_TIMEOUT_MS + 1000)
      }
    }
    for (const ws of this.tcpSockets()) {
      const s = tcpOf(ws)
      if (!s.ready) due.push(s.deadline)
    }
    for (const ws of this.publicSockets()) {
      const att = attachmentOf(ws) ?? {}
      if (att.exp) due.push(att.exp)
      if (att.pb && !att.paired && att.deadline) due.push(att.deadline)
    }
    const at = Math.max(now + 1, Math.min(...due))
    if (this.alarmAt !== null && this.alarmAt > now && this.alarmAt <= at) return
    // Noted before the write: setAlarm calls land in the order made.
    this.alarmAt = at
    try { await this.state.storage.setAlarm(at) } catch (error) { this.alarmAt = null; throw error }
  }

  // A host with a stream open is active now, however long ago it last spoke.
  lastActive(now: number) {
    const room = this.live()
    if (!room.endedAt && room.connected('host')) return now
    return Math.max(room.host.lastSeen, room.endedAt ?? 0)
  }

  override async alarm() {
    this.alarmAt = null
    if (!this.room) return
    const now = Date.now()
    // Turns traces couldn't take yet, tried again.
    await this.keepSoon()
    if (now - this.lastActive(now) > ROOM_TTL_MS) {
      // The last turn, still open, goes before the room does.
      await (this.keeping = this.keeping.catch(() => {}).then(() => this.keepNew(true))).catch(() => {})
      this.room.revokeTCP()
      this.room.revokePublic()
      await ended(this.room, { directory: directoryClient(this.env) })
      for (const ws of this.state.getWebSockets()) ws.close(1000, 'expired')
      await this.state.storage.deleteAll()
      this.room = null
      return
    }
    const expired = this.room.sweepExpired(now)
    this.closeStaleTCP(now)
    this.cleanupPublic(now)
    if (this.room.sweep(now) || expired) await this.persist()
    this.broadcast() // seats that left, and the host coming and going
    await this.schedule()
  }
}

// What a room asks of its cloud host (docs/cloud-host.md): HostContainer, one
// a room, by the room's id.
function hostsClient(env: ServerEnv): CloudHosts | null {
  const hosts = env.HOSTS
  if (!hosts) return null
  const stub = (id: string) => hosts.get(hosts.idFromName(id))
  return {
    async start(id, payload) {
      const res = await stub(id).fetch('https://host.internal/start', { method: 'POST', body: JSON.stringify(payload) })
      if (!res.ok) throw new Error((await res.json<{ error?: string }>().catch(() => null))?.error ?? `status ${res.status}`)
    },
    async stop(id) {
      const res = await stub(id).fetch('https://host.internal/stop', { method: 'POST' })
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array()
    },
  }
}

// One room's cloud host: a container running cloud/runner.mjs. It starts the
// container with a control key of its own, hands the runner the room and the
// session over the container's port (never a public address), streams it the
// packed session against the ticket the room minted, and stops it, answering
// with its changes. An alarm each minute keeps it (and so the container)
// going while the runner runs, and notices when it stopped.
const HOST_PORT = 8080
const HOST_START_MS = 120_000
const HOST_ALARM_MS = 60_000

// What the object keeps while its runner runs: the container's control key,
// the bundle's ticket (until used), and its room.
type Runner = { key: string; ticket: string | null; room: string; at: number }

export class HostContainer {
  state: DurableObjectState
  env: ServerEnv

  constructor(state: DurableObjectState, env: ServerEnv) {
    this.state = state
    this.env = env
  }

  runner() {
    const container = this.state.container
    if (!container) throw new Error('This server has no containers.')
    return container.getTcpPort(HOST_PORT)
  }

  async control(path: string, key: string, init: RequestInit & { duplex?: 'half' } = {}) {
    return this.runner().fetch(`http://runner${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${key}` } })
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const container = this.state.container
    if (!container) return json({ error: 'This server has no containers.' }, 501)
    const saved = (await this.state.storage.get<Runner>('runner')) ?? null

    if (url.pathname === '/start' && req.method === 'POST') {
      const { ticket, config } = await req.json<{ ticket: string; config: { room: string } }>()
      if (container.running) await container.destroy().catch(() => {})
      const key = token(32)
      container.start({ enableInternet: true, env: { SS_CONTROL_KEY: key } })
      // Up once the runner answers on its port (the image may be pulled first).
      const until = Date.now() + HOST_START_MS
      let up = false
      while (!up && Date.now() < until) {
        up = await this.control('/health', key).then(r => r.ok, () => false)
        if (!up) await new Promise(r => setTimeout(r, 1_000))
      }
      if (!up) {
        await container.destroy().catch(() => {})
        return json({ error: "the container didn't come up" }, 504)
      }
      const started = await this.control('/start', key, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) })
      if (!started.ok) {
        await container.destroy().catch(() => {})
        return json({ error: (await started.json<{ error?: string }>().catch(() => null))?.error ?? 'the runner refused its configuration' }, 502)
      }
      await this.state.storage.put('runner', { key, ticket, room: config.room, at: Date.now() })
      await this.state.storage.setAlarm(Date.now() + HOST_ALARM_MS)
      return json({ ok: true })
    }

    if (url.pathname === '/bundle' && req.method === 'PUT') {
      const given = req.headers.get('authorization') ?? ''
      if (!saved?.ticket || !container.running || !safeEqual(given, `Bearer ${saved.ticket}`)) return json({ error: 'Not a member of this session.' }, 401)
      // Once: the ticket goes as the bundle starts.
      await this.state.storage.put('runner', { ...saved, ticket: null })
      const res = await this.control('/bundle', saved.key, { method: 'PUT', headers: { 'content-length': req.headers.get('content-length') ?? '' }, body: req.body, duplex: 'half' })
      return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } })
    }

    if (url.pathname === '/stop' && req.method === 'POST') {
      let diff = new Uint8Array()
      if (saved && container.running) {
        const res = await this.control('/stop', saved.key, { method: 'POST' }).catch(() => null)
        if (res?.ok) diff = new Uint8Array(await res.arrayBuffer())
      }
      await container.destroy().catch(() => {})
      await this.state.storage.deleteAll()
      return new Response(diff, { headers: { 'content-type': 'application/octet-stream' } })
    }

    return json({ error: 'Not found' }, 404)
  }

  // Kept going while the runner runs; a container that stopped by itself is
  // forgotten (the room sees its host away, and Bring home still works).
  async alarm() {
    const saved = await this.state.storage.get<Runner>('runner')
    if (!saved) return
    if (!this.state.container?.running) return void (await this.state.storage.deleteAll())
    await this.state.storage.setAlarm(Date.now() + HOST_ALARM_MS)
  }
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Counts new rooms exactly: per address this minute and today, and for the
// whole server today. Today's counts are kept in storage, so a restart
// doesn't reset the day: the server's under day:<date>, and each address's
// under a:<date>:<its keyed hash>, the key a random one made for that day
// (k:<date>), so what's kept can't be read back as addresses. An alarm at
// the day's end deletes them all, key included. Only a Share reaches it, so
// it costs one request per room made. Its minute is memory's, as every
// other minute is.
export class GateObject {
  state: DurableObjectState
  minute: Windows
  addresses: Map<string, number>
  day: { key: string; count: number; secret: string }
  queue: Promise<unknown>

  constructor(state: DurableObjectState) {
    this.state = state
    this.minute = new Windows()
    this.addresses = new Map() // a:<date>:<hash> → rooms today, as read or written here
    this.day = { key: '', count: 0, secret: '' }
    // One Share at a time: each reads and writes its address's count across awaits no gate holds.
    this.queue = Promise.resolve()
  }

  fetch(req: Request): Promise<Response> {
    const turn = this.queue.then(() => this.admit(req))
    this.queue = turn.catch(() => {})
    return turn
  }

  async admit(req: Request) {
    const { ip, max } = await req.json<{ ip: string; max: number }>()
    const now = Date.now()
    const key = new Date(now).toISOString().slice(0, 10)
    const storage = this.state.storage
    if (this.day.key !== key) {
      let secret = await storage.get<string>(`k:${key}`)
      if (!secret) {
        secret = token(32)
        await storage.put(`k:${key}`, secret)
        // The day's end, and a minute for the clocks.
        await storage.setAlarm(Date.parse(`${key}T00:00:00Z`) + 86_400_000 + 60_000)
      }
      this.day = { key, count: (await storage.get<number>(`day:${key}`)) ?? 0, secret }
      this.addresses.clear()
      await this.forget(key)
    }
    if (this.day.count >= max) return json({ ok: false, reason: 'day' })
    const who = `a:${key}:${await keyedHash(this.day.secret, ip)}`
    const made = this.addresses.get(who) ?? (await storage.get<number>(who)) ?? 0
    if (made >= ROOMS_PER_ADDRESS_DAY || !this.minute.hit('create', ip, now)) return json({ ok: false, reason: 'address' })
    this.addresses.set(who, made + 1)
    this.day.count += 1
    await storage.put({ [`day:${key}`]: this.day.count, [who]: made + 1 })
    return json({ ok: true })
  }

  async alarm() {
    const today = new Date(Date.now()).toISOString().slice(0, 10)
    await this.forget(today)
    if (this.day.key !== today) this.day = { key: '', count: 0, secret: '' }
  }

  // Every day's counts and key but today's.
  async forget(today: string) {
    const storage = this.state.storage
    for (const prefix of ['a:', 'k:', 'day:']) {
      const old = [...(await storage.list({ prefix })).keys()].filter(k => !k.startsWith(`${prefix}${today}`))
      for (let i = 0; i < old.length; i += 128) await storage.delete(old.slice(i, i + 128))
    }
  }
}

// A keyed hash of an address (HMAC-SHA-256, its first 16 bytes in hex).
async function keyedHash(secret: string, text: string) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)))
  return [...mac.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// The one directory of accounts and teams.
const directoryStub = (env: ServerEnv & { DIRECTORY: DurableObjectNamespace<DirectoryObject> }) => env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'))

// What a room asks the directory: its stub, whose methods are the
// DirectoryObject's below.
const directoryClient = (env: ServerEnv | undefined) => (env && hasDirectory(env) ? directoryStub(env) : null)

export class DirectoryObject extends DurableObject<ServerEnv> {
  state: DurableObjectState
  directory: Directory

  constructor(state: DurableObjectState, env: ServerEnv) {
    super(state, env)
    this.state = state
    const storage = state.storage
    const kv: Kv = {
      get: key => storage.get(key),
      put: (key, value) => storage.put(key, value),
      delete: key => storage.delete(key),
      list: async prefix => [...(await storage.list({ prefix })).entries()],
    }
    // How a room is, for a team's list: its own info, or nothing once it's gone.
    const roomInfo = async (id: string): Promise<RoomInfo | null> => ROOM_ID.test(id) ? env.ROOMS.get(env.ROOMS.idFromName(id)).info() : null
    // A members-only team's people now, for its room to let the others go.
    const keepTeam = async (id: string, team: string, allowed: string[]) => {
      if (!ROOM_ID.test(id)) return
      await env.ROOMS.get(env.ROOMS.idFromName(id)).keepTeam(team, allowed)
    }
    // What's timed goes when it's due: the alarm is set for the soonest.
    const onDue = (at: number) => void this.wakeAt(at).catch(() => {})
    this.directory = new Directory(kv, { providers: providersFrom(env), roomInfo, keepTeam, onDue })
  }

  async wakeAt(at: number) {
    const set = await this.state.storage.getAlarm()
    if (!set || at + 1000 < set) await this.state.storage.setAlarm(at + 1000)
  }

  override async alarm() {
    const next = await this.directory.sweep(Date.now())
    if (next) await this.wakeAt(next)
  }

  // What a room asks (Directory's own methods, the same names).
  shareCheck(teamId: string, tokenText: string) { return this.directory.shareCheck(teamId, tokenText) }
  joinCheck(teamId: string, tokenText: string) { return this.directory.joinCheck(teamId, tokenText) }
  whoIs(tokenText: string) { return this.directory.whoIs(tokenText) }
  teamAccess(teamId: string) { return this.directory.teamAccess(teamId) }
  sessionInvite(tokenText: string, room: Parameters<Directory['sessionInvite']>[1], to: unknown) { return this.directory.sessionInvite(tokenText, room, to) }
  roomEnded(roomId: string, teamId: string | null) { return this.directory.roomEnded(roomId, teamId) }
  register(teamId: string, room: Parameters<Directory['register']>[1]) { return this.directory.register(teamId, room) }
  unregister(teamId: string, roomId: string) { return this.directory.unregister(teamId, roomId) }

  override async fetch(req: Request) {
    return this.directory.handle(req, req.headers.get('x-share-origin') ?? new URL(req.url).origin)
  }
}
