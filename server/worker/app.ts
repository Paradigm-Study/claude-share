// The Worker's own requests: the main Worker's routes (Hono) and the
// preview Worker's, each passed on to a room's Durable Object.

import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  ROOM_ID,
  KEEPALIVE_MS,
  STREAM_MAX_MS,
  previewRoomOf,
  previewKeyOf,
  previewHostLabel,
  roomOrigins,
  notFound,
  json,
  publicOrigin,
  token,
  previewMissing,
  homePage,
  outdatedClient,
  versionInfo,
  limitOf,
  limitedResponse,
  closedResponse,
  busyResponse,
  ROOMS_PER_DAY,
  streamedRoomBody,
  bodyLimit,
  bodyTooLarge,
  readBody,
  badRequest,
  CLOUD_BUNDLE_MAX,
  statusOf,
} from '../core/index.ts'
import { Directory, BODY_CHARS } from '../teams.ts'
import { NATIVE_POOL_BODY_MAX } from '../native-pool.ts'
import type { TracesEnv } from '../traces/index.ts'
import type { ServerEnv } from './env.ts'
import { tracesOn, traces, hasDirectory, directoryStub } from './env.ts'
import type { RoomObject } from './room-object.ts'
import { isDashPath, dashFetch } from './dash.ts'

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
  try {
    stub = OBJECT_ID.test(key) ? env.ROOMS.get(env.ROOMS.idFromString(key)) : null
  } catch {}
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
// says of itself, its home page, the dashboard, traces (when on), the directory's paths
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

// The dashboard (server/worker/dash.ts): /app and its JSON, /api/dash/*.
app.use(async (c, next) => (isDashPath(new URL(c.req.url).pathname) ? dashFetch(c.req.raw, c.env) : next()))

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
  const env = c.env,
    req = c.req.raw
  const url = new URL(req.url)
  if (!hasDirectory(env) || !Directory.owns(url.pathname)) return next()
  if (Directory.limited(url.pathname, req.method) && !(await env.JOIN_LIMIT.limit({ key: `auth:${addressOf(req)}` })).success) return limitedResponse('join')
  const headers = new Headers(req.headers)
  headers.set('x-share-origin', publicOrigin(req, env.PUBLIC_URL))
  // Read here, bounded (a declared length past it refused before any):
  // the directory takes what it's given whole.
  let body: Uint8Array | undefined
  if (bodied(req)) {
    const max = url.pathname === '/api/native-pool/enrollment' ? NATIVE_POOL_BODY_MAX : DIRECTORY_BODY_MAX
    try {
      body = await readBody(req, max)
    } catch (error) {
      return statusOf(error) === 413 ? bodyTooLarge(max) : badRequest('The request body did not arrive.')
    }
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
  const env = c.env,
    req = c.req.raw
  const outdated = outdatedClient(req)
  if (outdated) return outdated
  if (env.NEW_ROOMS === 'off') return closedResponse()
  // The rate-limit binding below is loose (cached counts let a burst
  // through); the gate counts new rooms exactly, per address and per day.
  const gate: { ok: boolean; reason?: string } = env.GATE
    ? await env.GATE.get(env.GATE.idFromName('gate'))
        .fetch('https://gate.internal/', { method: 'POST', body: JSON.stringify({ ip: addressOf(req), max: Number(env.MAX_ROOMS_PER_DAY) || ROOMS_PER_DAY }) })
        .then(r => r.json<{ ok: boolean; reason?: string }>())
        .catch(() => ({ ok: true }))
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
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'rooms' && parts.length === 5 && parts[4] === 'end')
    return toRoom(c, parts[3]!, 'admin-end')
  if (parts[0] === 's' && parts.length === 2) return toRoom(c, parts[1]!, 'page')
  if (parts[0] === 'api' && parts[1] === 'rooms' && parts.length >= 3) return toRoom(c, parts[2]!, parts.slice(3).join('/'))
  return notFound()
})

app.notFound(() => notFound())
// What throws goes to the runtime as it did before Hono: a 500 of its own.
app.onError(error => {
  throw error
})

export default {
  async fetch(req: Request, env: ServerEnv, ctx: ExecutionContext): Promise<Response> {
    return env.ROLE === 'preview' ? previewFetch(req, env) : app.fetch(req, env, ctx)
  },
}

const bodied = (req: Request) => req.method !== 'GET' && req.method !== 'HEAD'

// One request for a room, to its Durable Object: limited first, its body
// passed on as a stream.
async function toRoom(c: Context<App>, id: string, rest: string): Promise<Response> {
  const env = c.env,
    req = c.req.raw
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
