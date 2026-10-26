import {
  PUBLIC_LIMITS,
  CLEAR_TICKET_MS,
  TICKET_MS,
  ROOM_PREVIEWS_MAX,
  PROXY_HEAD_MAX,
  PROXY_RESPONSE_MAX,
  NEED_LIMIT,
  PREVIEW_SESSION_MS,
  PROXY_BODY_MAX,
  PROXY_TIMEOUT_MS,
  TCP_LIMITS,
} from './limits.ts'
import { token, json, roomAccessError, readBoundedJson, bodyFailure, readBody, toBase64, bearerOf, statusOf } from './http.ts'
import { fromHost } from './cloud.ts'
import { serveReserve, SERVED_ALL, seatKnown, serveLeft } from './tcp.ts'
import { escapeHtml } from './pages.ts'
import type { Room } from './room.ts'
import type { Auth, JsonObject, Preview, RoomContext, RouteResult, Ticket } from './types.ts'

// A browser socket on the public link, as previewSocketTarget admits it.
export type SocketTarget = { ok: true; pid: string; port: number; path: string; protocols: string[]; session: string; ownerSeat: string; exp: number }
// A public pair's half, as the adapters keep it: what let its browser in.
type PublicPair = { pid: string; session: string; exp: number; closed?: boolean }

// ---------------------------------------------------------------------------
// Previews: the host shares a localhost port; members get tickets (one browser each)
// that open it on the preview host name.
//   POST previews { port, title, tcp? } (host) → { pid, tcp }
//   POST previews/<pid>/end (host)
//   POST previews/<pid>/ticket { path } (any member) → { url }
//   POST proxy/<request id> (host): a proxied request's answer, one UTF-8
//     JSON line { status, headers: [[name, value], ...] }, then the body.

// The event a preview's opening appends, and its forwarding again: what's
// shared changing moves the room's seq, so every poll and stream hears it,
// their pages carrying the list (Room.previewList).
const previewOpened = (p: Preview) => ({ state: 'open', pid: p.pid, port: p.port, tcp: p.tcp === true, title: p.title })

// A seat's minute of minting links first, then the room's: past its own, one
// member doesn't spend everyone's. Counted before the body is read.
function mintAllowed(room: Room, seat: string, now: number) {
  const hit = (key: string, limit: number) => {
    let w = room.mints.get(key)
    if (!w || now - w.start >= PUBLIC_LIMITS.mintWindowMs) {
      // Seats come and go: only the ones that minted this past minute are kept.
      for (const [k, old] of room.mints) if (now - old.start >= PUBLIC_LIMITS.mintWindowMs) room.mints.delete(k)
      room.mints.set(key, (w = { start: now, count: 0 }))
    }
    if (w.count >= limit) return false
    w.count += 1
    return true
  }
  return hit(`seat:${seat}`, PUBLIC_LIMITS.seatMints) && hit('room', PUBLIC_LIMITS.roomMints)
}

// The page a link opens, as its redirect says it: a path on the app, its
// bytes outside printable ASCII (and backslashes, which browsers read as
// slashes) percent-encoded, at most PUBLIC_LIMITS.pathBytes; else the root.
// Applied as a link is made, so its Location header can't be refused.
function linkPath(raw: unknown) {
  if (typeof raw !== 'string' || raw.length > PUBLIC_LIMITS.pathBytes || !raw.startsWith('/') || raw.startsWith('//')) return '/'
  let out = ''
  for (const b of new TextEncoder().encode(raw)) out += b > 0x20 && b < 0x7f && b !== 0x5c ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`
  return out.length <= PUBLIC_LIMITS.pathBytes ? out : '/'
}

// When a link was made (its expiry says it).
const mintedAt = (entry: Ticket) => entry.exp - (entry.clear ? CLEAR_TICKET_MS : TICKET_MS)

// Past `keep`, the oldest of these go: used ones first (they only remember a
// browser), then unused.
function dropOldest(room: Room, entries: [string, Ticket][], keep: number) {
  entries.sort((a, b) => Number(!a[1].used) - Number(!b[1].used) || mintedAt(a[1]) - mintedAt(b[1]))
  for (const [old] of entries.slice(0, Math.max(0, entries.length - keep))) room.tickets.delete(old)
}

// A new link, kept with the room: expired ones go first, then, to make room,
// the seat's oldest past its newest few and the room's past its newest. The
// second link after clearing (`clear`) counts like any other.
function mintTicket(room: Room, { pid, path, seat, clear = false }: { pid: string; path: string; seat: string; clear?: boolean }, now: number, ticket = token(18)) {
  for (const [old, entry] of room.tickets) if (entry.exp <= now) room.tickets.delete(old)
  dropOldest(room, [...room.tickets].filter(([, entry]) => entry.seat === seat), PUBLIC_LIMITS.seatTickets - 1)
  dropOldest(room, [...room.tickets], PUBLIC_LIMITS.roomTickets - 1)
  room.tickets.set(ticket, { pid, exp: now + (clear ? CLEAR_TICKET_MS : TICKET_MS), path, seat, ...(clear ? { clear: true } : {}) })
  return ticket
}
// The room by its preview key, never its id; its preview rides along (an id,
// not a credential), so a browser already in that preview goes back to it
// once the link itself has expired. On a server whose previews each room has
// a host name of its own (PREVIEW_URL `https://*.previews.example`), that
// host name is the room's (`previewLabel`).
const enterUrl = (origin: string, room: Room, ticket: string, pid: string) => `${origin.replace('//*.', `//${previewLabel(room.previewKey)}.`)}/__share/enter?room=${room.previewKey}&ticket=${ticket}&pid=${pid}`

// Per-room preview origins. With PREVIEW_URL a wildcard
// (`https://*.previews.example`), each room's previews are served on a host
// name of their own, `<label>.previews.example`: their own origin, so a page
// of one room's previews can't read another's, nor send its requests with the
// cookie another room's link set (one origin for every room could). The
// label is the room's preview key as one DNS label: its bytes (a Durable
// Object's id, 64 hex; Node's key, base64url) in lowercase base32, 52
// characters at most, under the 63 a label may hold.
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
function base32(bytes: Uint8Array) {
  let out = '', bits = 0, value = 0
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return bits ? out + BASE32[(value << (5 - bits)) & 31] : out
}
function unbase32(text: string) {
  const out: number[] = []
  let bits = 0, value = 0
  for (const c of text) {
    const n = BASE32.indexOf(c)
    if (n < 0) return null
    value = ((value << 5) | n) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  const bytes = new Uint8Array(out)
  return base32(bytes) === text ? bytes : null
}
const HEX_KEY = /^[0-9a-f]{64}$/
export function previewLabel(key: string) {
  const bytes = HEX_KEY.test(key) ? Uint8Array.from(key.match(/../g) ?? [], h => parseInt(h, 16)) : Uint8Array.from(atob(key.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0))
  return base32(bytes)
}
// A label's preview key, as each adapter writes keys: a Durable Object's id
// in hex (`hex`), Node's in base64url (`base64url`). Null for no label.
export function previewKeyOf(label: string | null | undefined) {
  const bytes = label && /^[a-z2-7]{1,63}$/.test(label) ? unbase32(label) : null
  if (!bytes) return null
  return { hex: [...bytes].map(b => b.toString(16).padStart(2, '0')).join(''), base64url: btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }
}
// Whether PREVIEW_URL gives each room's previews a host name of their own.
export const roomOrigins = (previewUrl: string | null | undefined): previewUrl is string => /^https?:\/\/\*\./.test(previewUrl ?? '')
// The label a request's host name gives, on a server whose PREVIEW_URL is a
// wildcard (`https://*.previews.example`): the host name's first part, when
// the rest is the wildcard's. Null for any other host name.
export function previewHostLabel(previewUrl: string | null | undefined, host: string | null | undefined) {
  if (!roomOrigins(previewUrl)) return null
  const base = new URL(previewUrl.replace('//*.', '//x.')).host.slice(2).toLowerCase()
  const name = String(host ?? '').toLowerCase()
  return name.endsWith(`.${base}`) && !name.slice(0, -base.length - 1).includes('.') ? name.slice(0, -base.length - 1) : null
}

export async function previewRoutes(room: Room, req: Request, rest: string, auth: Auth, now: number, ctx: RoomContext): Promise<RouteResult | null> {
  const method = req.method
  if (rest === 'previews' && method === 'POST') {
    if (auth.role !== 'host') return { response: json({ error: 'Only the host shares previews.' }, 403) }
    const before = roomAccessError(room, req, ctx, true)
    if (before) return { response: before }
    let body
    try { body = await readBoundedJson(req) } catch (error) { return bodyFailure(error) }
    const after = roomAccessError(room, req, ctx, true)
    if (after) return { response: after }
    const port = Number(body.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { response: json({ error: 'A port from 1 to 65535.' }, 400) }
    // Raw TCP forwarding only for a port the host chose to share (`tcp`); one
    // shared because Claude mentioned it opens through its link alone.
    const tcp = body.tcp === true
    const existing = [...room.previews.values()].find(p => p.port === port)
    if (existing && tcp && !existing.tcp) {
      existing.tcp = true
      room.append(fromHost(room), 'preview', previewOpened(existing), now)
      room.wake()
      return { changed: true, response: json({ pid: existing.pid, tcp: true }) }
    }
    if (existing) return { response: json({ pid: existing.pid, tcp: existing.tcp === true }) }
    if (room.previews.size >= ROOM_PREVIEWS_MAX) return { response: json({ error: `This session shares ${ROOM_PREVIEWS_MAX} previews, as many as it keeps. Stop one first.` }, 429) }
    const preview: Preview = { pid: token(8), port, title: String(body.title ?? '').slice(0, 120) || `localhost:${port}`, ts: now, ...(tcp ? { tcp: true } : {}) }
    room.previews.set(preview.pid, preview)
    room.append(fromHost(room), 'preview', previewOpened(preview), now)
    room.wake()
    return { changed: true, response: json({ pid: preview.pid, tcp }) }
  }
  const match = /^previews\/([A-Za-z0-9_-]+)\/(end|ticket)$/.exec(rest)
  if (match && method === 'POST') {
    const preview = room.previews.get(match[1]!)
    if (!preview) return { response: json({ error: 'No such preview.' }, 404) }
    if (match[2] === 'end') {
      if (auth.role !== 'host') return { response: json({ error: 'Only the host stops previews.' }, 403) }
      // No body is read, so one check holds: nothing is awaited after it.
      const access = roomAccessError(room, req, ctx, true)
      if (access) return { response: access }
      room.previews.delete(preview.pid)
      room.revokeTCP({ pid: preview.pid })
      room.revokePublic({ pid: preview.pid })
      room.append(fromHost(room), 'preview', { pid: preview.pid, port: preview.port, state: 'closed' }, now)
      room.wake()
      return { changed: true, response: json({ ok: true }) }
    }
    const previewOrigin = ctx.previewOrigin
    if (!previewOrigin) return { response: json({ error: 'This server does not serve previews.' }, 501) }
    const check = () => roomAccessError(room, req, ctx) ?? (room.previews.has(preview.pid) ? null : json({ error: 'No such preview.' }, 404))
    const before = check()
    if (before) return { response: before }
    if (!mintAllowed(room, auth.seat, now)) return { response: json({ error: 'Too many preview links. Try again in a minute.' }, 429) }
    // Where the link lands: a page of the app (one path on it), else its root.
    let asked: JsonObject = {}
    try { asked = await readBoundedJson(req) } catch (error) { if (statusOf(error) === 413) return bodyFailure(error) }
    // A Leave, a Stop or the room's end while the body arrived mints nothing.
    const after = check()
    if (after) return { response: after }
    const ticket = mintTicket(room, { pid: preview.pid, path: linkPath(asked.path), seat: auth.seat }, Date.now())
    return { changed: true, response: json({ url: enterUrl(previewOrigin, room, ticket, preview.pid) }) }
  }
  if (rest.startsWith('proxy/') && method === 'POST') return proxyAnswer(room, req, rest.slice(6), auth)
  return null
}

// The host's answer to a proxied request, as the guest's browser gets it.
// Read as it arrives, at most a response's worth and its first line: past
// that, or not what it should be, the browser gets a 502 page at once,
// rather than an empty body under the app's status or a 504 later.
async function proxyAnswer(room: Room, req: Request, id: string, auth: Auth): Promise<RouteResult> {
  if (auth.role !== 'host') return { response: json({ error: 'Only the host answers previews.' }, 403) }
  if (!room.proxied.has(id)) return { response: json({ error: 'That request is no longer waiting.' }, 410) }
  const failed = (text: string) => room.proxied.get(id)?.(previewPage(502, 'The preview did not answer', text))
  let bytes
  try { bytes = await readBody(req, PROXY_HEAD_MAX + 1 + PROXY_RESPONSE_MAX) } catch (error) {
    failed(statusOf(error) === 413 ? `Its answer was over ${PROXY_RESPONSE_MAX / 1024 / 1024} MB, more than a preview carries.` : 'Its answer was cut short.')
    return bodyFailure(error)
  }
  const settle = room.proxied.get(id)
  if (!settle) return { response: json({ error: 'That request is no longer waiting.' }, 410) }
  const answer = answerOf(bytes)
  if (!answer) {
    failed('Its answer could not be read.')
    return { response: json({ error: 'Expected one JSON line { status, headers: [[name, value], ...] } of at most 64 KiB, a newline, then the body.' }, 400) }
  }
  if (answer.body.byteLength > PROXY_RESPONSE_MAX) {
    failed(`Its answer was over ${PROXY_RESPONSE_MAX / 1024 / 1024} MB, more than a preview carries.`)
    return { response: json({ error: `Preview answers are limited to ${PROXY_RESPONSE_MAX} bytes.` }, 413) }
  }
  // Its browser's seat pays for it, as a file's download does.
  if (!serveReserve(room, settle.seat ?? '', answer.body.byteLength, Date.now())) {
    settle(previewPage(429, 'The preview has sent all it may for now', SERVED_ALL))
    return { response: json({ error: SERVED_ALL }, 429) }
  }
  settle(proxiedAnswer(answer.status, answer.headers, answer.body))
  return { response: json({ ok: true }) }
}

function needAllowed(room: Room, seat: string, now: number) {
  let w = room.needs.get(seat)
  if (!w || now - w.start >= NEED_LIMIT.periodMs) {
    // Seats come and go: only the ones that asked this past minute are kept.
    for (const [s, old] of room.needs) if (now - old.start >= NEED_LIMIT.periodMs) room.needs.delete(s)
    room.needs.set(seat, (w = { start: now, count: 0 }))
  }
  if (w.count >= NEED_LIMIT.limit) return false
  w.count += 1
  return true
}

export async function needRoute(room: Room, req: Request, auth: Auth, now: number, ctx: RoomContext): Promise<RouteResult> {
  if (auth.role !== 'guest') return { response: json({ error: 'Only a guest asks the host to share a port.' }, 403) }
  const before = roomAccessError(room, req, ctx)
  if (before) return { response: before }
  // Counted before the body is read: every ask costs, a refused one included.
  if (!needAllowed(room, auth.seat, now)) return { response: json({ error: 'Too many preview port requests. Try again in a minute.' }, 429) }
  let body
  try { body = await readBoundedJson(req, NEED_LIMIT.bodyBytes) } catch (error) { return bodyFailure(error) }
  const after = roomAccessError(room, req, ctx)
  if (after) return { response: after }
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== 'port') return { response: json({ error: 'Expected exactly { port }.' }, 400) }
  const port = body.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { response: json({ error: 'A port from 1 to 65535.' }, 400) }
  // Forwarded already (the host's own Allow forwarding): the guest can
  // connect without asking anyone.
  const forwarded = [...room.previews].find(([, p]) => p.port === port && p.tcp === true)
  if (forwarded) return { changed: false, response: json({ shared: true, pid: forwarded[0] }) }
  // Who asks comes from the seat, never from the body.
  const delivered = room.toHost({ need: { port, seat: auth.seat, name: auth.name } })
  return { changed: false, response: json({ delivered }) }
}

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'proxy-connection', 'upgrade', 'te', 'trailer', 'alt-svc'])

const NULL_BODY = new Set([204, 205, 304])

// The host's answer as the guest's browser gets it: a status a browser can be
// given (else 502), the app's headers but hop-by-hop ones and any no Headers
// would carry, a redirect to the host's own localhost made relative.
function proxiedAnswer(status: number, pairs: [string, string][], body: Uint8Array) {
  const code = Number.isInteger(status) && status >= 200 && status <= 599 ? status : 502
  const headers = new Headers({ 'cache-control': 'no-store' })
  for (const [rawName, rawValue] of pairs) {
    const name = rawName.trim().toLowerCase()
    let value = rawValue.trim()
    if (!name || HOP.has(name)) continue
    if (name === 'location') value = value.replace(/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?/i, '') || '/'
    if (name === 'set-cookie') {
      // The app's cookies stay on the preview's own host name: none for a
      // whole domain (every room's previews under it), and never the room's.
      if (value.trimStart().startsWith(`${COOKIE}=`)) continue
      value = value.split(';').filter(part => !/^\s*domain\s*=/i.test(part)).join(';')
    }
    try { headers.append(name, value) } catch {}
  }
  return new Response(NULL_BODY.has(code) ? null : body, { status: code, headers })
}

// A proxied answer: its first line, the status and headers as JSON (at most
// PROXY_HEAD_MAX), then the body as it is. Null when it isn't that.
function answerOf(bytes: Uint8Array): { status: number; headers: [string, string][]; body: Uint8Array } | null {
  const end = bytes.subarray(0, PROXY_HEAD_MAX + 1).indexOf(0x0a)
  if (end < 0) return null
  let head
  try { head = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, end))) } catch { return null }
  if (!head || typeof head !== 'object' || Array.isArray(head) || !Number.isInteger(head.status) || !Array.isArray(head.headers)) return null
  if (!head.headers.every((h: unknown) => Array.isArray(h) && h.length === 2 && typeof h[0] === 'string' && typeof h[1] === 'string')) return null
  return { status: head.status, headers: head.headers, body: bytes.subarray(end + 1) }
}

const COOKIE = 'cs_pv'
const previewPage = (status: number, title: string, text: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;font-family:-apple-system,Helvetica,sans-serif;background:#faf8f7;color:#011121"><div style="max-width:420px;padding:24px;text-align:center"><h1 style="font-weight:400;font-size:26px">${title}</h1><p style="color:#4b5563">${text}</p></div>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )

// A preview link whose room isn't here.
export const previewMissing = () => previewPage(404, 'This preview has ended', 'The shared session it belonged to is no longer here.')
// A request body past PROXY_BODY_MAX, on either adapter.
export const previewTooLarge = () => previewPage(413, 'Too large', 'Request bodies through a preview are limited to 1 MB.')

// The request's preview cookie, as [room's preview key, session id]; empty without one.
function previewCookie(req: Request): string[] {
  const cookie = (req.headers.get('cookie') ?? '').split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))
  return cookie ? cookie.slice(COOKIE.length + 1).split('.') : []
}

// The preview key a preview request is for (the room's `previewKey`): the
// enter link's, else the cookie's.
export function previewRoomOf(req: Request) {
  const url = new URL(req.url)
  if (url.pathname === '/__share/enter') return url.searchParams.get('room')
  return previewCookie(req)[0] ?? null
}

// Whether a link's or a cookie's room part names this room: its preview key.
const namesRoom = (room: Room, key: string | undefined) => Boolean(key) && key === room.previewKey

// The preview session a request's cookie holds in this room, while it lasts
// and its seat is still the room's, with its id (`sid`).
function previewSession(room: Room, req: Request, now: number) {
  const [key, sid] = previewCookie(req)
  if (!namesRoom(room, key) || !sid) return null
  const session = room.previewSessions.get(sid)
  return session && session.exp > now && session.seat && seatKnown(room, session.seat) ? { ...session, sid } : null
}

// Every room's previews share one host name, so a browser can carry what
// another room's app left there, whatever it has or lacks now (a quit browser
// drops cs_pv and keeps an app's storage): anything but this room's cookie
// is cleared for.
function otherRoomsState(room: Room, req: Request) {
  return !namesRoom(room, previewCookie(req)[0])
}

const redirect = (location: string) => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } })

// What another room left goes before this room's cookie is set: a page that
// sets nothing, asks the browser to clear the host name's storage (service
// workers with it) and cache, and cookies, which browsers clear for its whole
// registrable domain (so PREVIEW_URL wants a domain of its own), and goes on
// to a second single-use link.
const clearingPage = (next: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeHtml(next)}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening the preview</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;font-family:-apple-system,Helvetica,sans-serif;background:#faf8f7;color:#011121"><p>Opening the preview… <a href="${escapeHtml(next)}">Continue</a></p>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'clear-site-data': '"cache", "cookies", "storage"' } },
  )

// A seat's newest few browsers per preview, and the room's newest (they're
// kept with it): one older is let go, its sockets with it (a reload of a
// newer one goes on as it was).
function keepNewestSessions(room: Room, seat: string, pid: string) {
  const browsers = () => [...room.previewSessions].sort((a, b) => a[1].exp - b[1].exp)
  const mine = browsers().filter(([, s]) => s.seat === seat && s.pid === pid)
  for (const [old] of mine.slice(0, Math.max(0, mine.length - PUBLIC_LIMITS.seatSessions))) room.revokePublic({ session: old })
  const all = browsers()
  for (const [old] of all.slice(0, Math.max(0, all.length - PUBLIC_LIMITS.roomSessions))) room.revokePublic({ session: old })
}

// /__share/enter trades a link for a cookie, once. Expired links and
// sessions go first, and so does a link whose seat left. A link already used
// brings back only the browser that used it, to that link's own preview,
// never to another this browser also has; a browser not in this room's
// previews yet has what any other room left cleared first (above). What it
// answers is made before anything changes, so nothing can spend a link and
// then fail.
function enterPreview(room: Room, req: Request, url: URL, now: number, secure: boolean, ownOrigin: boolean): RouteResult {
  const pruned = room.sweepExpired(now)
  const ticket = room.tickets.get(url.searchParams.get('ticket') ?? '')
  const own = previewSession(room, req, now)
  if (!ticket || ticket.used || ticket.exp <= now || !room.previews.has(ticket.pid) || room.endedAt || !seatKnown(room, ticket.seat)) {
    const pid = ticket?.pid ?? url.searchParams.get('pid')
    if (own && pid && own.pid === pid && room.previews.has(pid) && !room.endedAt) return { changed: pruned, response: redirect(ticket?.path ?? '/') }
    return { changed: pruned, response: previewPage(403, 'This preview link has been used', 'Each link opens the preview in one browser, within ten minutes. For a new one, press <b>Open</b> in the Room panel in Claude Code.') }
  }
  const path = ticket.path
  // Spent, but kept until it expires, so the browser that used it is known.
  // On the room's own host name no other room has left anything.
  if (!ownOrigin && !ticket.clear && otherRoomsState(room, req)) {
    const next = token(18)
    const response = clearingPage(enterUrl('', room, next, ticket.pid))
    ticket.used = true
    mintTicket(room, { pid: ticket.pid, path, seat: ticket.seat, clear: true }, now, next)
    return { changed: true, response }
  }
  // A browser already in this preview for this seat (a pane opening the
  // host's next page there) goes on in its own session: one browser holds one
  // of its seat's places. The new link renews it, as a session of its own
  // would have lasted; its open sockets keep their own expiry (they reconnect
  // under this one).
  const reuse = own && own.seat === ticket.seat && own.pid === ticket.pid ? own.sid : null
  const sid = reuse ?? token(18)
  const response = new Response(null, {
    status: 302,
    headers: { location: path, 'cache-control': 'no-store', 'set-cookie': `${COOKIE}=${room.previewKey}.${sid}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}` },
  })
  ticket.used = true
  const renewed = reuse ? room.previewSessions.get(reuse) : undefined
  if (renewed) renewed.exp = now + PREVIEW_SESSION_MS
  else {
    room.previewSessions.set(sid, { pid: ticket.pid, exp: now + PREVIEW_SESSION_MS, seat: ticket.seat })
    keepNewestSessions(room, ticket.seat, ticket.pid)
  }
  return { changed: true, response }
}

// Everything on the preview host name. /__share/enter trades a ticket for a
// cookie; anything else, with the cookie, goes to the host's localhost.
// `own`: it came on this room's own host name (PREVIEW_URL a wildcard).
export async function previewRequest(room: Room, req: Request, now: number, { secure = true, own = false }: { secure?: boolean; own?: boolean } = {}): Promise<RouteResult> {
  const url = new URL(req.url)
  // No service worker registers here: one would outlive its room and answer
  // for every other room's previews in that browser, all on this host name.
  if ((req.headers.get('service-worker') ?? '').trim().toLowerCase() === 'script') {
    return { response: previewPage(403, 'Not here', 'Previews of a shared session do not run service workers.') }
  }
  if (url.pathname === '/__share/enter') return enterPreview(room, req, url, now, secure, own)
  const session = previewSession(room, req, now)
  const preview = session ? room.previews.get(session.pid) : null
  const ended = () => ({ response: previewPage(404, 'This preview has ended', `${room.host.name} is no longer sharing it.`) })
  const busy = () => ({ response: previewPage(503, 'The preview is busy', `${room.host.name}'s app has many requests waiting. Try again in a moment.`) })
  if (!session || !preview || room.endedAt) return ended()
  if (room.proxied.size >= PUBLIC_LIMITS.proxied) return busy()
  if (!serveLeft(room, session.seat ?? '', now)) return { response: previewPage(429, 'The preview has sent all it may for now', SERVED_ALL) }
  let body: Uint8Array = new Uint8Array()
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try { body = await readBody(req, PROXY_BODY_MAX) } catch (error) {
      return { response: statusOf(error) === 413 ? previewTooLarge() : previewPage(400, 'The request did not arrive', 'Its body was cut short.') }
    }
    // The browser's session, its preview and the room may have gone while the body arrived.
    const still = previewSession(room, req, Date.now())
    if (still?.sid !== session.sid || !room.previews.has(preview.pid) || room.endedAt) return ended()
    if (room.proxied.size >= PUBLIC_LIMITS.proxied) return busy()
  }
  const headers: [string, string][] = []
  for (const [name, value] of req.headers) {
    const n = name.toLowerCase()
    if (HOP.has(n) || n === 'host' || n === 'accept-encoding' || n.startsWith('cf-') || n.startsWith('x-forwarded') || n === 'x-real-ip') continue
    if (n === 'cookie') {
      const rest = value.split(/;\s*/).filter(c => !c.startsWith(`${COOKIE}=`)).join('; ')
      if (rest) headers.push([name, rest])
      continue
    }
    headers.push([name, value])
  }
  const id = token(12)
  const answer = new Promise<Response>(resolve => {
    const timer = setTimeout(() => {
      room.proxied.delete(id)
      resolve(previewPage(504, 'The preview did not answer', `${room.host.name}'s app took too long to respond.`))
    }, PROXY_TIMEOUT_MS)
    // Whose browser it is: its answer counts against that seat (`serveReserve`).
    room.proxied.set(id, Object.assign((response: Response) => {
      clearTimeout(timer)
      room.proxied.delete(id)
      resolve(response)
    }, { seat: session.seat ?? '' }))
  })
  const sent = room.toHost({
    proxy: { id, pid: preview.pid, port: preview.port, method: req.method, path: `${url.pathname}${url.search}`, headers, body: body.length ? toBase64(body) : '' },
  })
  if (!sent) {
    room.proxied.get(id)?.(previewPage(503, 'The preview is not reachable', `${room.host.name}'s Claude Code isn't connected right now.`))
  }
  return { response: await answer }
}

// WebSockets through a preview: a dev server's live reload, and the debug
// data Next.js 16 sends its dev pages over one (they don't start without it).
// The guest's browser opens a socket on the preview host name; the room tells
// the host's stream; the host's plugin starts a relay that opens one to its
// localhost and one back to the room (ws/<id>, host only), and the room passes
// messages between the two as they are. The process holding the sockets pairs
// them (worker.ts); what's decided about them is here.
export const SOCKET_ID = /^[A-Za-z0-9_-]{8,40}$/

// Whom a browser's socket is for: its preview session, the port, the path.
// `active` is every public pair the adapter holds for this room, pending or
// paired (each { ownerSeat }): a seat and the room have PUBLIC_LIMITS' share.
export function previewSocketTarget(room: Room, req: Request, now: number, active: { ownerSeat?: string }[] = []): SocketTarget | { ok: false; status: number; error?: string } {
  const session = previewSession(room, req, now)
  const preview = session ? room.previews.get(session.pid) : null
  if (!session || !preview || room.endedAt) return { ok: false, status: 404 }
  const ownerSeat = session.seat
  if (active.length >= PUBLIC_LIMITS.roomPairs || active.filter(p => p.ownerSeat === ownerSeat).length >= PUBLIC_LIMITS.seatPairs) {
    return { ok: false, status: 429, error: 'Too many preview connections.' }
  }
  const url = new URL(req.url)
  const protocols = (req.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map(p => p.trim())
    .filter(p => /^[\w.-]{1,64}$/.test(p))
    .slice(0, 4)
  return { ok: true, pid: preview.pid, port: preview.port, path: `${url.pathname}${url.search}`, protocols, session: session.sid, ownerSeat, exp: session.exp }
}

// A public pair goes on while what let it in does: the room, its preview and
// the browser session it was opened with, while its seat is the room's (a
// Leave, a Stop, the session's expiry or its seat's newer browsers end it),
// and until the expiry that session had then (`exp`): a session a new link
// renewed doesn't stretch a socket opened before, which the browser opens
// again under it. Both halves carry the target's pid, session and expiry,
// whichever adapter holds them.
export function publicPairValid(room: Room | null | undefined, pair: PublicPair | null | undefined, now: number) {
  const session = pair ? room?.previewSessions.get(pair.session) : undefined
  return Boolean(room && !room.endedAt && pair && !pair.closed && pair.exp > now && room.previews.has(pair.pid) && session && session.pid === pair.pid && session.exp > now &&
    session.seat && seatKnown(room, session.seat))
}

// Asks the host for a relay; false when the host's Claude Code isn't connected.
export function announceSocket(room: Room, id: string, target: SocketTarget) {
  return room.toHost({ ws: { id, pid: target.pid, port: target.port, path: target.path, protocols: target.protocols } })
}

export function hostSocketAllowed(room: Room, req: Request) {
  const auth = room.auth(bearerOf(req))
  return Boolean(auth && auth.role === 'host' && !room.endedAt)
}

// The host turning away a socket it was asked to relay, TCP or public, while
// it waits for its host half: BUSY → 1013, CONNECT → 1011, else 0. Called only
// after host authentication; bounded as it arrives, it carries one code,
// never a relay's error text.
export async function relayRejectCode(req: Request) {
  let body
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await readBody(req, TCP_LIMITS.controlBytes))) } catch { return 0 }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'code') return 0
  return body.code === 'BUSY' ? 1013 : body.code === 'CONNECT' ? 1011 : 0
}

// …and what that socket is closed with, in words (`what`: TCP, or Preview).
export const rejectReason = (what: string, code: number) => `${what} ${code === 1013 ? 'host busy' : 'local connect failed'}`
