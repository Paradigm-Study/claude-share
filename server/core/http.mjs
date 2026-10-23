import { JSON_BODY_MAX, MAX_BODY, FILE_MAX, BOUNDED_BODY, LIMITS } from './limits.mjs'
import manifest from '../../plugin/.claude-plugin/plugin.json' with { type: 'json' }

// A string's size in UTF-8, what the limit counts.
export function utf8Length(text) {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c < 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

export function token(bytes = 16) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...raw))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

// ---------------------------------------------------------------------------
// HTTP

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

export const bearerOf = req => (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()

const bodyError = (message, status = 400) => Object.assign(new Error(message), { status })

// Every route's body comes through here: counted in bytes as they arrive (a
// declared length past `max` refused before any), never more than `max` kept.
// The Worker reads the directory's this way before passing it on.
export async function readBody(req, max) {
  const tooLarge = () => bodyError(`Request bodies are limited to ${max} bytes.`, 413)
  if (Number(req.headers.get('content-length')) > max) throw tooLarge()
  const reader = req.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if ((size += value.byteLength) > max) throw tooLarge()
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength }
  return bytes
}
export async function readJson(req) {
  const text = new TextDecoder().decode(await readBody(req, JSON_BODY_MAX))
  if (text.length > MAX_BODY) throw bodyError('body too large', 413)
  return text ? JSON.parse(text) : {}
}

// These routes authenticate before touching the body, and read it through
// readBody with their own bound (end reads none). Both outer
// adapters must pass a stream, not buffer it first; a Node request whose body
// wasn't read closes its socket.
export const streamedRoomBody = (method, rest) => (method === 'POST' &&
  (rest === 'previews' || rest === 'need' || rest === 'peer' || rest === 'cloud' || /^previews\/[^/]+\/(?:end|ticket)$/.test(rest) || /^ws\/[^/]+\/reject$/.test(rest) || /^proxy\/[^/]+$/.test(rest))) ||
  // The cloud host's packed session goes on to it as it comes (cloud-docker.mjs, HostContainer).
  (method === 'PUT' && rest === 'cloud/bundle')

// What an adapter takes of a room route's body (past it, 413): a file's
// FILE_MAX, a JSON route's JSON_BODY_MAX. Node buffers that much at most; the
// Worker refuses a declared length past it and streams the rest, which the
// room reads through readBody. Streamed routes bound themselves; the preview
// port takes PROXY_BODY_MAX, the directory its own.
export const bodyLimit = pathname => (/^\/api\/rooms\/[^/]+\/files$/.test(pathname) ? FILE_MAX : JSON_BODY_MAX)
export const bodyTooLarge = max => json({ error: `Request bodies here are limited to ${max} bytes.` }, 413)

export async function readBoundedJson(req, max = BOUNDED_BODY) {
  let bytes
  try { bytes = await readBody(req, max) } catch (error) { throw error.status ? error : bodyError('Expected valid UTF-8 JSON.') }
  let body
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    body = text ? JSON.parse(text) : {}
  } catch { throw bodyError('Expected valid UTF-8 JSON.') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bodyError('Expected a JSON object.')
  return body
}

export const bodyFailure = error => ({ response: json({ error: error.message }, error.status ?? 400) })

// Recheck after every awaited body read. An expiry, Leave or host token change
// during upload cannot commit a mutation or mint a capability into an old room.
export const leftResponse = () => json({ error: 'You left this session from the Team panel.', left: true }, 410)

export function roomAccessError(room, req, ctx, host = false) {
  if (ctx.isCurrent && !ctx.isCurrent()) return json({ error: 'This shared session does not exist.' }, 404)
  if (room.leftElsewhere.has(bearerOf(req))) return leftResponse()
  const auth = room.auth(bearerOf(req))
  if (!auth) return json({ error: 'Not a member of this session.' }, 401)
  if (host && auth.role !== 'host') return json({ error: 'Only the host can do that.' }, 403)
  if (room.endedAt) return json({ error: 'This session is no longer shared.' }, 410)
  return null
}

export function publicOrigin(req, configured) {
  if (configured) return configured.replace(/\/+$/, '')
  const url = new URL(req.url)
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')
  return `${proto}://${host}`
}

export function shareUrl(origin, id) {
  return `${origin}/s/${id}`
}

// Plugin versions. The newest is the plugin this server was deployed with;
// clients say theirs in a header. Older than PLUGIN_MIN can't share or join
// (rooms already open carry on, though an older host's public link no longer
// answers and its TCP connections close early): this server no longer asks a
// plugin what it takes, or answers as plugins before 0.11.30 needed, and from
// 0.11.31 a guest's TCP connections come with its seat's token (an older
// guest's helper sends a grant this server no longer gives), so everyone
// moves up to it, here.
export const PLUGIN_LATEST = manifest.version
export const PLUGIN_MIN = '0.11.31'
export const UPDATE_COMMAND = 'claude plugin marketplace update claude-share && claude plugin update shared-session@claude-share'

const versionParts = v => String(v).split('.').map(n => Number.parseInt(n, 10) || 0)
export function compareVersions(a, b) {
  const x = versionParts(a)
  const y = versionParts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1
  return 0
}

// A client too old to share or join: told why, and the one command that fixes it.
export function outdatedClient(req) {
  const version = req.headers.get('x-shared-session-version')
  if (version && compareVersions(version, PLUGIN_MIN) >= 0) return null
  return json(
    {
      error: `This Shared Sessions plugin is out of date${version ? ` (${version})` : ''}. Update it in a terminal: ${UPDATE_COMMAND} — then quit and reopen Claude Desktop (Cmd+Q), or start a new terminal session. In the Room, set Settings → Updates to "Install by themselves" and later versions load without a restart.`,
      latest: PLUGIN_LATEST,
      min: PLUGIN_MIN,
      update: UPDATE_COMMAND,
    },
    426,
  )
}

// The plugin version a request says it comes from, when it says one plainly.
// Records which plugin a request's sender runs now, and tells the room when
// it changed; true when it did. Every request says it, a stream's too: someone
// only listening is as current in the Room's list as someone posting.
export function noteVersion(room, req, auth) {
  const version = clientVersion(req)
  if (!version) return false
  const seat = auth.role === 'guest' ? room.seats.get(bearerOf(req)) : null
  const before = auth.role === 'host' ? room.host.version : seat?.version
  if (auth.role === 'host') room.host.version = version
  else if (seat) seat.version = version
  if (before && version !== before) room.wake()
  return version !== before
}

export function clientVersion(req) {
  const v = req.headers.get('x-shared-session-version') ?? ''
  return /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(v) ? v : null
}

export const versionInfo = () => json({ latest: PLUGIN_LATEST, min: PLUGIN_MIN, update: UPDATE_COMMAND })
export const limitedResponse = kind => json({ error: LIMITS[kind].message }, 429)
export const busyResponse = () =>
  json({ error: 'The public share server has made as many shared sessions as it will today. Joining links still works; to share now, run your own server (see the README).' }, 503)
export const closedResponse = () =>
  json({ error: 'This share server is not taking new shared sessions right now. Joining links still works; to share, run your own server (see the README).' }, 503)

// Which limit a request counts against, and under what key; null for none.
export function limitOf(req, id, rest, ip) {
  if (req.method !== 'POST') return null
  if (rest === 'create') return { kind: 'create', key: `c:${ip}` }
  if (rest === 'join') return { kind: 'join', key: `j:${ip}` }
  if (rest === 'events') return { kind: 'events', key: `e:${id}` }
  return null
}

// ---------------------------------------------------------------------------
// Files: POST files (the host's shown files and pictures, a guest's prompt
// attachments; the bytes, x-file-name) → { id, name, type, size };
// GET files/<id> (any member) → the bytes. The id is the bytes' SHA-256.

export async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function toBase64(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(out)
}

export function notFound() {
  return json({ error: 'Not found' }, 404)
}

export function badRequest(message) {
  return json({ error: message }, 400)
}
