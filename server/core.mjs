import { CLOVER_WEBP, LOGO_PATHS } from './brand.mjs'
import manifest from '../plugin/.claude-plugin/plugin.json' with { type: 'json' }

// Room logic shared by the Node server (node.mjs) and the Cloudflare Durable
// Object (worker.mjs). Everything speaks the Fetch API: a Request in, a
// Response out, so both hosts route into the same functions.
//
// A room is one shared Claude Code session. The host's session posts what its
// transcript keeps (rows), live text (deltas) and turn state; guests post
// prompts and stop requests. Everyone holds one `stream?after=<seq>` open and
// is sent a line whenever the room changes, so a quiet room costs nothing;
// `events?after=<seq>` answers the same question once, for pollers.

export const HISTORY_LIMIT = 5000 // replayable events kept per room
// …and their bytes, serialized: past either, the oldest go first. A room's
// history is in memory whole (a Durable Object's isolate holds 128 MB, shared)
// and goes out whole to a stream that starts from nothing; the e2e's long
// session (5 MB, rows of 31.5 KB) fits three times over.
export const HISTORY_BYTES = 16 * 1024 * 1024
const LIVE_LIMIT = 400 // ephemeral events (deltas) kept for pollers only
const LIVE_BYTES = 2 * 1024 * 1024
export const SEAT_TIMEOUT_MS = 45_000 // a seat neither connected nor heard from for this long left
export const KEEPALIVE_MS = 25_000 // a line on every open stream, so proxies keep it open
// Every stream ends itself after this long and the client reconnects at once.
// A client that is gone (asleep, unplugged) never comes back, so it leaves
// within this plus the seat's grace, whatever the connection seemed to say.
export const STREAM_MAX_MS = 5 * 60_000
const POLL_WAIT_MS = 20_000
const MAX_TEXT = 32_000 // chars; any string in an event, at any depth
// One event's body, serialized. The plugin's largest is a row of 32,000
// characters cut from a reply in CJK (96 KB); a tool row's replay input is
// 16,000 characters of JSON. Nesting stops at BODY_DEPTH: JSON.stringify
// recurses, so a body nested deeper than the stack (JSON.parse takes it) would
// throw wherever the room is sent or saved.
export const EVENT_BYTES = 128 * 1024
const BODY_DEPTH = 32
// Claude Code hands a plugin at most 4 MiB of a response body, in bytes (cut
// silently, measured: 1.4 million Chinese characters is all that comes
// through), and a long session's history is many times that. So a client
// that asks (`max`, bytes) gets events in pages of at most that size, oldest
// first, with `more` while there are others; one that can't page gets the
// newest events that fit, rather than a body cut mid-JSON.
const PAGE_BYTES_CAP = 3_500_000

// A string's size in UTF-8, what the limit counts.
function utf8Length(text) {
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
const sizeOf = event => utf8Length(JSON.stringify(event)) + 1

// Events oldest first while they fit in `max` bytes (one at least).
function pageOf(events, max) {
  let size = 2
  const out = []
  for (const event of events) {
    const n = sizeOf(event)
    if (out.length && size + n > max) return { events: out, more: true }
    size += n
    out.push(event)
  }
  return { events: out, more: false }
}

// The newest events that fit in `max` bytes, oldest first.
function newestOf(events, max) {
  let size = 2
  let from = events.length
  while (from > 0) {
    const n = sizeOf(events[from - 1])
    if (size + n > max && from < events.length) break
    size += n
    from--
  }
  return events.slice(from)
}

const maxOf = url => {
  const max = Number(url.searchParams.get('max'))
  return Number.isFinite(max) && max > 0 ? Math.min(Math.max(max, 64_000), PAGE_BYTES_CAP) : 0
}
const MAX_BODY = 512_000
// Files the host's Claude shows (a page, an image, a widget too big for an
// event): kept by the room, read with a member's token, gone with the room.
const FILE_MAX = 10 * 1024 * 1024
const ROOM_FILES_MAX = 100 * 1024 * 1024 // screenshots the host's Claude takes go up too
// …and how many: each one's name and type are kept with the room (the Worker
// keeps them beside its bytes, under a key of their own, and the newest 512 in
// the room's one value as well, for a rollback to 0.11.24: metaOf). As many as
// 100 MB of 10 KB files: far past what a day of screenshots and attachments
// makes, and a bound on what tiny files could cost.
export const ROOM_FILES_COUNT = 10_240
export const ROOM_SEATS_MAX = 20 // people in one room besides the host
// Previews open at once (the plugin's Shown keeps as many), kept with the room too.
export const ROOM_PREVIEWS_MAX = 128
// Previews: a guest's browser asks the room, the room asks the host's stream,
// the host's plugin asks its own localhost and posts the answer back.
const TICKET_MS = 10 * 60_000 // long enough to click from a transcript; one browser only
const CLEAR_TICKET_MS = 60_000 // the second link after clearing another room's state: followed at once
const PREVIEW_SESSION_MS = 12 * 60 * 60 * 1000
const PROXY_TIMEOUT_MS = 30_000
export const PROXY_BODY_MAX = 1024 * 1024
const PROXY_RESPONSE_MAX = 20 * 1024 * 1024
const PROXY_HEAD_MAX = 64 * 1024 // a format 2 answer's first line: its status and headers

// TCP previews use raw binary messages and a receiver-proven credit window.
// All resource ceilings live here; both transports enforce the same protocol.
export const TCP_LIMITS = Object.freeze({
  protocol: 1, capMs: PREVIEW_SESSION_MS, seatPairs: 32, roomPairs: 64,
  seatCaps: 2, roomCaps: 128, opensPerMinute: 1200, seatOpensPerMinute: 240, openWindowMs: 60_000,
  pairMs: 10_000, roomBytes: 1024 ** 3, reserveBytes: 1024 ** 2,
  dataBytes: 65_536, creditFrames: 4, creditBytes: 256 * 1024,
  controlBytes: 256, bufferBytes: 1024 ** 2, messageFragments: 4096,
  rateWindowMs: 1000, dataPerWindow: 1024, controlPerWindow: 2048, wireFramesPerWindow: 4096,
  closeMs: 1000,
})

// The public link's ceilings, the same on both transports. Browser sockets,
// pending and paired alike, count once each by their cookie session's seat;
// one waits PUBLIC_LIMITS.pairMs for the host's relay, queueing at most a
// queue's worth meanwhile, and a room's waiting ones `pendingBytes` together.
// Output a peer hasn't read and messages a second (Node counts wire frames,
// the Worker whole messages) are bounded as Node's parser bounds them; the
// Worker, which can't see what a peer hasn't read, bounds each socket's bytes
// a second instead. Requests in flight are per room. A seat keeps its newest
// few browser sessions per preview and links, the room its newest of each
// (they're kept with it), and a link's page is `pathBytes` at most. Links are
// minted at a rate of a seat's own and the room's (in memory, like needs: not
// one of LIMITS).
export const PUBLIC_LIMITS = Object.freeze({
  seatPairs: 32, roomPairs: 128, pairMs: 10_000, queueMessages: 500, queueBytes: 1024 ** 2, pendingBytes: 8 * 1024 ** 2,
  bufferBytes: 1024 ** 2, framesPerWindow: 4096, bytesPerWindow: 4 * 1024 ** 2, rateWindowMs: 1000, proxied: 512,
  seatSessions: 4, roomSessions: 256, seatTickets: 16, roomTickets: 128, pathBytes: 2048,
  seatMints: 30, roomMints: 120, mintWindowMs: 60_000,
})

// Whether a revocation covers a channel or a capability: every field the
// filter names must match, and a filter naming none covers everything. TCP
// halves and grants name their `cap` and `ownerSeat`; public pairs and
// browser sessions their cookie `session` and `ownerSeat`.
export function revokeMatches(filter, s) {
  return (!filter.cap || s.cap === filter.cap) && (!filter.pid || s.pid === filter.pid) &&
    (!filter.seat || s.ownerSeat === filter.seat) && (!filter.session || s.session === filter.session)
}

// What each seat may post. `chat` is the room's side channel: people talk,
// Claude never reads it. `policy` is the host's say over what guests may do;
// `declined` answers a guest prompt the host's policy turned away. `react` is
// someone's reaction to one of Claude's replies, and `seen` the replies that
// came on someone's screen, each filed under the reply's key.
const HOST_TYPES = new Set(['row', 'delta', 'turn', 'approval', 'title', 'policy', 'declined', 'chat', 'artifact', 'react', 'seen'])
const GUEST_TYPES = new Set(['prompt', 'stop', 'chat', 'react', 'seen'])
const REACTIONS = new Set(['👍', '🎉', '👀'])
const REPLY_KEY = /^[a-z0-9]{1,16}\.\d{1,5}$/

// A reaction or a seen list as the room keeps it, or null when it isn't one.
function tidyMark(type, body) {
  if (type === 'react') {
    if (!REPLY_KEY.test(String(body?.key)) || !REACTIONS.has(body?.emoji)) return null
    return { key: body.key, emoji: body.emoji, on: body.on !== false }
  }
  const keys = Array.isArray(body?.keys) ? body.keys.filter(k => REPLY_KEY.test(String(k))).slice(0, 100) : []
  return keys.length ? { keys } : null
}
const LIVE_TYPES = new Set(['delta'])

export const ROOM_ID = /^[A-Za-z0-9_-]{16,64}$/

export function token(bytes = 16) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...raw))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

const clampName = name => String(name ?? '').trim().slice(0, 40) || 'teammate'

// An event's body as the room keeps it: every string, at any depth, at most
// `chars` long, and nothing nested past BODY_DEPTH (null there).
function clampBody(body, chars = MAX_TEXT) {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? clampValue(body, 0, chars) : {}
}
function clampValue(value, depth, chars) {
  if (typeof value === 'string') return value.length > chars ? `${value.slice(0, chars)}\n…(cut)` : value
  if (value === null || typeof value !== 'object') return value
  if (depth >= BODY_DEPTH) return null
  if (Array.isArray(value)) return value.map(v => clampValue(v, depth + 1, chars))
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = clampValue(v, depth + 1, chars)
  return out
}
const bodyBytes = body => utf8Length(JSON.stringify(body))

// Clamped, and past EVENT_BYTES cut further: its strings shorter until it
// fits, else a marker. A host's event is cut, never refused, so its outbox
// (0.11.24's too) never sends one again and again; a guest's is refused first
// (the events route).
function fitBody(body) {
  const clamped = clampBody(body)
  if (bodyBytes(clamped) <= EVENT_BYTES) return clamped
  for (let chars = MAX_TEXT >> 1; chars >= 64; chars >>= 1) {
    const cut = clampBody(clamped, chars)
    if (bodyBytes(cut) <= EVENT_BYTES) return cut
  }
  return { cut: true }
}

export class Room {
  constructor(data) {
    this.id = data.id
    this.title = data.title
    this.host = data.host // { name, token, lastSeen }
    this.createdAt = data.createdAt
    this.endedAt = data.endedAt ?? null
    this.fromNow = data.fromNow === true // shared without what came before
    this.team = data.team ?? null // { id, name, account }: shared with a team, whose access setting says who joins
    this.seq = data.seq ?? 0
    this.events = data.events ?? []
    // Their bytes, kept as they come and go (a room saved before the bound
    // was kept is cut to it here, oldest first).
    this.eventBytes = this.events.reduce((n, e) => n + sizeOf(e), 0)
    this.trimEvents()
    this.liveBytes = 0
    this.seats = new Map(Object.entries(data.seats ?? {}))
    // Seats let go after their grace (a laptop asleep, a network gap), by
    // token: one that comes back is seated again as it was, so a plugin that
    // was only away isn't told the session ended. Leaving isn't kept here.
    this.away = new Map(Object.entries(data.away ?? {}))
    this.live = []
    this.posts = new Windows() // posts this minute, counted exactly here
    this.waiters = new Set()
    this.files = new Map(Object.entries(data.files ?? {})) // id → { id, name, type, size, ts }
    this.previews = new Map(Object.entries(data.previews ?? {})) // pid → { pid, port, title, ts, tcp? }
    // What preview links and cookies name the room by, never its id (which
    // joins it): a key kept with the room (made for one saved without), or a
    // Durable Object's own id, which worker.mjs puts here. Ones made before
    // rooms had keys name its id, and still open (namesRoom).
    this.previewKey = data.previewKey ?? token(16)
    // A browser's session on the public link, sid → { pid, exp, seat } (rooms
    // saved before seats were kept: no seat, kept until they expire), or a
    // TCP grant, cap → { pid, exp, seat, scope: 'tcp' }.
    this.previewSessions = new Map(Object.entries(data.previewSessions ?? {}))
    this.tcpStats = data.tcpStats ?? { used: 0, refunded: 0, opens: { start: 0, count: 0 } }
    // Each seat's share of the room's minute of opens (kept in memory only: a
    // room that slept starts its seats afresh, its room-wide count does not).
    this.tcpSeatOpens = new Map()
    // Each guest seat's minute of asking the host for a port (`need`), in
    // memory only and never saved: seat id → { start, count }.
    this.needs = new Map()
    this.onTCPRevoke = null
    // Public sockets end with what let them in, by revokeMatches' filter: a
    // preview's Stop (pid), a Leave (seat), one browser session (session), or
    // the room (none).
    this.onPreviewRevoke = null
    this.tcpSupported = () => [...this.subscribers].some(s => s.seat === 'host' && s.tcpSupport)
    // Links that open a preview in one browser, which may come back: kept with
    // the room, so one clicked after the room slept still opens, each until
    // TICKET_MS from its minting. ticket → { pid, exp, path, seat, used?, clear? }
    this.tickets = new Map(Object.entries(data.tickets ?? {}))
    // Each seat's minute of minting links, and the room's ('room'): in memory.
    this.mints = new Map()
    this.proxied = new Map() // in flight: request id → settle(Response)
    // Where file bytes live: memory here; a Durable Object keeps them in
    // storage, each with its metadata (`meta`, what `files` holds for it).
    const bytes = new Map()
    this.store = { put: async (id, data, meta) => void bytes.set(id, { data, type: meta.type }), get: async id => bytes.get(id) ?? null }
    this.subscribers = new Set() // open streams this process serves: { seat, push, send }
    // The host process may say who is connected (a Durable Object counts its
    // sockets) and hear about every change (to tell those sockets).
    this.connected = seat => [...this.subscribers].some(s => s.seat === seat)
    this.onChange = null
  }

  // A room loaded back from storage. Live events (deltas) were never stored,
  // so seq numbers handed out after the last save may be lost; start past any
  // of them so no cursor a client holds can be reused.
  static resume(data, now) {
    const room = new Room(data)
    room.seq = Math.max(room.seq, Math.floor(now / 10)) + 10_000
    return room
  }

  static create({ id, name, title, now, fromNow, version, team, account }) {
    return new Room({
      id,
      title: String(title ?? '').trim().slice(0, 120) || 'Claude Code session',
      host: { name: clampName(name), token: token(24), lastSeen: now, version: version ?? undefined, account: account ?? undefined },
      createdAt: now,
      fromNow: fromNow === true,
      team: team ?? null,
    })
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      host: this.host,
      createdAt: this.createdAt,
      endedAt: this.endedAt,
      fromNow: this.fromNow || undefined,
      team: this.team ?? undefined,
      seq: this.seq,
      events: this.events,
      seats: Object.fromEntries(this.seats),
      away: this.away.size ? Object.fromEntries(this.away) : undefined,
      files: Object.fromEntries(this.files),
      previews: Object.fromEntries(this.previews),
      previewKey: this.previewKey,
      previewSessions: Object.fromEntries(this.previewSessions),
      tickets: this.tickets.size ? Object.fromEntries(this.tickets) : undefined,
      tcpStats: this.tcpStats,
    }
  }

  // A message for the host's open stream only (proxied preview requests).
  // Returns whether anyone got it. A TCP channel or a guest's need goes only
  // to a stream that said it takes them (`tcp=1`, `need=1`): a 0.11.24 host
  // drops a need line, and its guest would be told it went.
  toHost(message) {
    let sent = false
    for (const sub of this.subscribers) {
      if (sub.seat !== 'host' || (message.tcp && !sub.tcpSupport) || (message.need && !sub.needSupport)) continue
      sub.send(message)
      sent = true
    }
    return sent
  }

  auth(bearer, now = Date.now()) {
    if (!bearer) return null
    if (bearer === this.host.token) return { role: 'host', seat: 'host', name: this.host.name }
    const seat = this.seats.get(bearer) ?? this.comeBack(bearer, now)
    return seat ? { role: 'guest', seat: seat.id, name: seat.name } : null
  }

  // A seat let go for being quiet, back: seated again, the same seat.
  comeBack(bearer, now) {
    const seat = this.away.get(bearer)
    if (!seat || this.endedAt || this.seats.size >= ROOM_SEATS_MAX) return null
    this.away.delete(bearer)
    const already = this.hasAccount(seat.account)
    seat.lastSeen = now
    this.seats.set(bearer, seat)
    if (!already) this.append({ seat: seat.id, name: seat.name, role: 'guest' }, 'join', {}, now)
    this.wake()
    return seat
  }

  touch(auth, now) {
    if (auth.role === 'host') this.host.lastSeen = now
    else for (const seat of this.seats.values()) if (seat.id === auth.seat) seat.lastSeen = now
  }

  // Everyone here, once each: a person signed in from several sessions (two
  // windows, two machines) is one entry, its `seats` naming them all, here if
  // any is; the host's own other sessions fold into the host.
  people(now) {
    const online = !this.endedAt && (this.connected('host') || now - this.host.lastSeen < SEAT_TIMEOUT_MS)
    // Each one's plugin version, as their requests say it: who needs to update.
    const v = version => (version ? { version } : {})
    const a = account => (account ? { account } : {})
    const host = { id: 'host', name: this.host.name, role: 'host', online, seats: ['host'], ...v(this.host.version), ...a(this.host.account) }
    const out = [host]
    const byAccount = new Map(this.host.account ? [[this.host.account, host]] : [])
    for (const s of this.seats.values()) {
      const same = s.account ? byAccount.get(s.account) : undefined
      if (same) {
        same.seats.push(s.id)
        continue
      }
      const entry = { id: s.id, name: s.name, role: 'guest', online: true, seats: [s.id], ...v(s.version), ...a(s.account) }
      if (s.account) byAccount.set(s.account, entry)
      out.push(entry)
    }
    return out
  }

  // Whether this account is here already, by another session (the host's or a seat).
  hasAccount(account, exceptBearer) {
    if (!account) return false
    if (this.host.account === account) return true
    for (const [bearer, seat] of this.seats) if (bearer !== exceptBearer && seat.account === account) return true
    return false
  }

  append(from, type, body, now) {
    const event = { seq: ++this.seq, type, from, ts: now, body: fitBody(body) }
    if (LIVE_TYPES.has(type)) {
      this.live.push(event)
      this.liveBytes += sizeOf(event)
      while (this.live.length > LIVE_LIMIT || this.liveBytes > LIVE_BYTES) this.liveBytes -= sizeOf(this.live.shift())
    } else {
      this.events.push(event)
      this.eventBytes += sizeOf(event)
      this.trimEvents()
    }
    return event
  }

  // HISTORY_LIMIT events and HISTORY_BYTES of them at most, oldest out first.
  trimEvents() {
    while (this.events.length > HISTORY_LIMIT || this.eventBytes > HISTORY_BYTES) this.eventBytes -= sizeOf(this.events.shift())
  }

  // Something changed: answer waiting polls, and tell every open stream.
  wake() {
    for (const waiter of [...this.waiters]) {
      if (this.seq > waiter.after) waiter.done()
    }
    this.notify()
  }

  notify() {
    for (const sub of [...this.subscribers]) sub.push()
    this.onChange?.()
  }

  // What a client is sent: everything after its cursor, and the room now.
  page(after, now) {
    return { seq: this.seq, events: this.since(after), people: this.people(now), ended: Boolean(this.endedAt), title: this.title, team: this.team?.name }
  }

  since(after) {
    const pick = list => list.filter(e => e.seq > after)
    return [...pick(this.events), ...pick(this.live)].sort((a, b) => a.seq - b.seq)
  }

  wait(after, ms) {
    if (this.seq > after || this.endedAt) return Promise.resolve()
    return new Promise(resolve => {
      const waiter = {
        after,
        done: () => {
          clearTimeout(waiter.timer)
          this.waiters.delete(waiter)
          resolve()
        },
      }
      waiter.timer = setTimeout(waiter.done, ms)
      this.waiters.add(waiter)
    })
  }

  // A person already here by another session (the same account) comes and
  // goes quietly: no second "joined", no "left" while one session stays.
  join(name, now, version = null, account = null) {
    const seatToken = token(24)
    const seat = { id: token(6), name: clampName(name), joinedAt: now, lastSeen: now, ...(version ? { version } : {}), ...(account ? { account } : {}) }
    const already = this.hasAccount(account)
    this.seats.set(seatToken, seat)
    if (!already) this.append({ seat: seat.id, name: seat.name, role: 'guest' }, 'join', {}, now)
    this.wake()
    return { token: seatToken, seat }
  }

  leave(bearer, reason, now) {
    const seat = this.seats.get(bearer) ?? this.away.get(bearer)
    if (!seat) return
    const stays = this.hasAccount(seat.account, bearer)
    this.seats.delete(bearer)
    if (reason === 'timeout') {
      this.away.set(bearer, seat)
      // The newest hundred: a room's people come back, strangers don't pile up.
      // A seat dropped for good takes its grants and browsers with it.
      for (const old of [...this.away.keys()].slice(0, Math.max(0, this.away.size - 100))) {
        const dropped = this.away.get(old)
        this.away.delete(old)
        if (dropped) this.revokeSeat(dropped.id)
      }
    } else {
      this.away.delete(bearer)
      this.revokeSeat(seat.id)
    }
    if (!stays) this.append({ seat: seat.id, name: seat.name, role: 'guest' }, 'leave', { reason }, now)
    this.wake()
  }

  // Drops seats that stopped polling; returns whether anything changed.
  sweep(now) {
    let changed = false
    for (const [bearer, seat] of [...this.seats]) {
      if (now - seat.lastSeen > SEAT_TIMEOUT_MS && !this.connected(seat.id)) {
        this.leave(bearer, 'timeout', now)
        changed = true
      }
    }
    return changed
  }

  // Expiry and deliberate Leave revoke grants; presence grace never does.
  revokeTCP(filter = {}) {
    let changed = false
    for (const [cap, grant] of this.previewSessions) {
      if (grant.scope !== 'tcp' || !revokeMatches(filter, { cap, pid: grant.pid, ownerSeat: grant.seat })) continue
      this.previewSessions.delete(cap)
      changed = true
    }
    this.onTCPRevoke?.(filter)
    return changed
  }

  // Browsers on the public link, by the same filters: a preview's Stop
  // (pid), a Leave or a seat dropped for good (seat), one browser session
  // (one too many for its seat or the room, or expired), or the whole room.
  // The adapters close the sockets they held. Links go with their preview,
  // their seat and the room: a link dies with the seat that made it.
  revokePublic(filter = {}) {
    let changed = false
    for (const [sid, s] of this.previewSessions) {
      if (s.scope === 'tcp' || !revokeMatches(filter, { pid: s.pid, ownerSeat: s.seat, session: sid })) continue
      this.previewSessions.delete(sid)
      changed = true
    }
    if (!filter.session) {
      for (const [ticket, entry] of this.tickets) {
        if (!revokeMatches(filter, { pid: entry.pid, ownerSeat: entry.seat })) continue
        this.tickets.delete(ticket)
        changed = true
      }
    }
    this.onPreviewRevoke?.(filter)
    return changed
  }

  // Everything a seat was given for previews: Leave, or a seat dropped for good.
  revokeSeat(seat) {
    this.revokeTCP({ seat })
    this.revokePublic({ seat })
  }

  // What expired goes (TCP grants, browser sessions, links), where requests
  // and the adapters' alarms already look, never on a timer of its own.
  sweepGrants(now) {
    let changed = false
    for (const [cap, grant] of this.previewSessions) {
      if (grant.exp > now) continue
      changed = (grant.scope === 'tcp' ? this.revokeTCP({ cap }) : this.revokePublic({ session: cap })) || changed
    }
    for (const [ticket, entry] of this.tickets) {
      if (entry.exp > now) continue
      this.tickets.delete(ticket)
      changed = true
    }
    return changed
  }

  end(now) {
    if (this.endedAt) return
    this.endedAt = now
    this.revokeTCP()
    this.revokePublic()
    this.append({ seat: 'host', name: this.host.name, role: 'host' }, 'ended', {}, now)
    this.wake()
  }
}

// ---------------------------------------------------------------------------
// HTTP

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const bearerOf = req => (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()

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

// The JSON routes (create, join, events, invite, team) take MAX_BODY
// characters, counted as before; their bytes are bounded on the way in at
// three a character (no UTF-16 unit is more than three UTF-8 bytes), so
// nothing that fit before is refused.
export const JSON_BODY_MAX = 3 * MAX_BODY
async function readJson(req) {
  const text = new TextDecoder().decode(await readBody(req, JSON_BODY_MAX))
  if (text.length > MAX_BODY) throw bodyError('body too large', 413)
  return text ? JSON.parse(text) : {}
}

// These routes authenticate before touching the body, and read it through
// readBody with their own bound (tunnel and end read none). Both outer
// adapters must pass a stream, not buffer it first; a Node request whose body
// wasn't read closes its socket.
export const streamedRoomBody = (method, rest) => method === 'POST' &&
  (rest === 'previews' || rest === 'need' || /^previews\/[^/]+\/(?:end|tunnel|ticket)$/.test(rest) || /^ws\/[^/]+\/reject$/.test(rest) || /^proxy\/[^/]+$/.test(rest))

// What an adapter takes of a room route's body (past it, 413): a file's
// FILE_MAX, a JSON route's JSON_BODY_MAX. Node buffers that much at most; the
// Worker refuses a declared length past it and streams the rest, which the
// room reads through readBody. Streamed routes bound themselves; the preview
// port takes PROXY_BODY_MAX, the directory its own.
export const bodyLimit = pathname => (/^\/api\/rooms\/[^/]+\/files$/.test(pathname) ? FILE_MAX : JSON_BODY_MAX)
export const bodyTooLarge = max => json({ error: `Request bodies here are limited to ${max} bytes.` }, 413)

const BOUNDED_BODY = 16 * 1024

async function readBoundedJson(req, max = BOUNDED_BODY) {
  let bytes
  try { bytes = await readBody(req, max) } catch (error) { throw error.status ? error : bodyError('Expected valid UTF-8 JSON.') }
  let body
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    body = text ? JSON.parse(text) : {}
  } catch { throw bodyError('Expected valid UTF-8 JSON.') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bodyError('Expected a JSON object.')
  return body
}

const bodyFailure = error => ({ response: json({ error: error.message }, error.status ?? 400) })

// Recheck after every awaited body read. An expiry, Leave or host token change
// during upload cannot commit a mutation or mint a capability into an old room.
function roomAccessError(room, req, ctx, host = false) {
  if (ctx.isCurrent && !ctx.isCurrent()) return json({ error: 'This shared session does not exist.' }, 404)
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
// (rooms already open carry on): before 0.10.1, a host's approval question
// could be declined for them unseen, its Next.js 16 dev servers showed blank,
// and nothing below 0.9.8 updates itself, so everyone moves up once, here.
export const PLUGIN_LATEST = manifest.version
export const PLUGIN_MIN = '0.10.1'
export const TEAMS_FROM = '0.11.0' // the first plugin that signs in, for a team's sessions
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

// What a public server limits, so a busy day stays affordable and one person
// can't flood it: rooms made and joins per network address, posts per room.
// Cloudflare counts with its rate-limit bindings (wrangler.toml); the Node
// server with an in-memory window of the same size.
export const LIMITS = {
  create: { limit: 6, periodMs: 60_000, message: 'Too many new shared sessions from your network. Try again in a minute.' },
  join: { limit: 30, periodMs: 60_000, message: 'Too many joins from your network. Try again in a minute.' },
  events: { limit: 900, periodMs: 60_000, message: 'This session is sending too fast; slowing down.' },
  tunnel: { limit: 60, periodMs: 60_000, message: 'Too many preview forwarding requests from your network. Try again in a minute.' },
}
export const limitedResponse = kind => json({ error: LIMITS[kind].message }, 429)
// New rooms one network address may make in a day, and the whole server: past
// the second, sharing waits for tomorrow (or another server), joining goes on.
export const ROOMS_PER_ADDRESS_DAY = 60
export const ROOMS_PER_DAY = 3000
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
  if (/^previews\/[A-Za-z0-9_-]+\/tunnel$/.test(rest)) return { kind: 'tunnel', key: `t:${ip}` }
  return null
}

// The Node server's counter: one window per key.
export class Windows {
  constructor() {
    this.windows = new Map()
  }
  hit(kind, key, now) {
    const { limit, periodMs } = LIMITS[kind]
    const w = this.windows.get(key)
    if (!w || now - w.start >= periodMs) {
      this.windows.set(key, { start: now, count: 1 })
      if (this.windows.size > 50_000) for (const [k, v] of this.windows) if (now - v.start >= periodMs) this.windows.delete(k)
      return true
    }
    w.count += 1
    return w.count <= limit
  }
}

// POST /api/rooms: the host's Share. Returns the room and the host's token.
// Shared with a team (`team`, the host signed in), the room goes on the
// team's list, and the team's access setting says who may join; refused, no
// room is made (`room` is absent).
export async function createRoom(req, id, now, origin, ctx = {}) {
  const body = await readJson(req)
  const team = body.team ? await teamFor(req, body.team, ctx) : null
  if (team?.error) return { response: team.error }
  // Signed in, the host is known by account: their other sessions are them.
  const account = team?.account ?? (await whoIs(req, ctx))
  const room = Room.create({ id, name: body.name, title: body.title, now, fromNow: body.fromNow, version: clientVersion(req), team, account })
  if (team) await listWithTeam(room, origin, ctx)
  return {
    room,
    response: json({
      id: room.id,
      url: shareUrl(origin, room.id),
      token: room.host.token,
      seq: room.seq,
      title: room.title,
      latest: PLUGIN_LATEST,
      team: team ? { id: team.id, name: team.name } : undefined,
    }),
  }
}

// The account a request comes from (the plugin's sign-in), never in a URL.
const accountOf = req => req.headers.get('x-shared-session-account') ?? ''

// Its account id, when it's signed in to this server; else null.
async function whoIs(req, ctx) {
  if (!accountOf(req) || !ctx.directory) return null
  return (await ctx.directory.whoIs(accountOf(req)).catch(() => null))?.id ?? null
}

async function teamFor(req, teamId, ctx) {
  if (!ctx.directory) return { error: json({ error: "This share server doesn't have teams." }, 400) }
  const check = await ctx.directory.shareCheck(String(teamId), accountOf(req))
  if (!check.ok) return { error: json({ error: check.error }, check.status) }
  return { ...check.team, account: check.account.id }
}

function listWithTeam(room, origin, ctx) {
  return ctx.directory.register(room.team.id, {
    id: room.id,
    url: shareUrl(origin, room.id),
    title: room.title,
    host: room.host.name,
    hostAccount: room.team.account,
    createdAt: room.createdAt,
  })
}

const teamOf = room => (room.team ? { id: room.team.id, name: room.team.name } : undefined)

// Everything under /api/rooms/:id/... and /s/:id. `changed` tells the caller
// whether to persist the room.
// Who is still here is settled when someone asks, not on a timer: a seat that
// stopped polling is dropped by the next request, so a quiet room costs nothing.
// `ctx.previewOrigin` is where previews are served (a host name of their own,
// so an app's root-relative paths work); absent, previews are off.
export async function roomRequest(room, req, rest, now, origin, ctx = {}) {
  const expired = room.sweepGrants(now)
  const swept = room.sweep(now) || expired
  const versions = versionsOf(room)
  const seated = room.seats.size
  const result = await handleRoom(room, req, rest, now, origin, ctx).catch(error => {
    // A JSON body past its bound is said as such, not as a crash.
    if (error?.status === 413) return { response: json({ error: error.message }, 413) }
    throw error
  })
  if (room.seats.size !== seated) return { ...result, changed: true } // a seat came back, or left
  // Someone on a new plugin version (an update, a restart) is kept, so a room
  // loaded back from storage says the versions that run now, and everyone's
  // Room hears it.
  return swept || versionsOf(room) !== versions ? { ...result, changed: true } : result
}

const versionsOf = room => [room.host.version, ...[...room.seats.values()].map(s => s.version)].join(' ')

async function handleRoom(room, req, rest, now, origin, ctx) {
  const method = req.method
  const url = new URL(req.url)

  if (rest === 'page' && method === 'GET') {
    // A team's session says up front when only its people can join.
    const access = room.team && ctx.directory ? await ctx.directory.teamAccess(room.team.id).catch(() => null) : null
    return { response: landingPage(room, shareUrl(origin, room.id), now, { access }) }
  }

  if (rest === '' && method === 'GET') {
    return {
      response: json({
        id: room.id,
        title: room.title,
        host: room.host.name,
        people: room.people(now),
        ended: Boolean(room.endedAt),
        hostVersion: room.host.version,
        team: teamOf(room),
      }),
    }
  }

  if (rest === 'join' && method === 'POST') {
    if (room.endedAt) return { response: json({ error: 'This session is no longer shared.' }, 410) }
    const outdated = outdatedClient(req)
    if (outdated) return { response: outdated }
    // Shared with a team: its access setting, as it is now, says who joins.
    if (room.team) {
      if (!ctx.directory) return { response: json({ error: `This session is for ${room.team.name}, and this server can't check who's in it.` }, 503) }
      const check = await ctx.directory.joinCheck(room.team.id, accountOf(req))
      // A plugin from before teams can't sign in: what it needs is the update.
      const version = clientVersion(req)
      if (!check.ok && (!version || compareVersions(version, TEAMS_FROM) < 0)) {
        return { response: json({ error: `This session is for ${room.team.name}, and joining it needs a sign-in, which Shared Sessions ${TEAMS_FROM} and newer have. Update in a terminal: ${UPDATE_COMMAND}, then open the link again in a new session.`, team: room.team.name, update: UPDATE_COMMAND }, 403) }
      }
      if (!check.ok) return { response: json({ error: check.error, team: room.team.name, signIn: check.status === 401 || undefined }, check.status === 401 ? 403 : check.status) }
    }
    if (room.seats.size >= ROOM_SEATS_MAX) return { response: json({ error: `This session is full: ${ROOM_SEATS_MAX} people have joined.` }, 403) }
    const body = await readJson(req)
    const { token: seatToken, seat } = room.join(body.name, now, clientVersion(req), await whoIs(req, ctx))
    // A long history in pages (see PAGE_BYTES_CAP): the first here, the rest
    // from events?after=historySeq.
    const max = maxOf(url)
    const page = max ? pageOf(room.events, max) : { events: newestOf(room.events, PAGE_BYTES_CAP), more: false }
    return {
      changed: true,
      response: json({
        token: seatToken,
        seat: seat.id,
        name: seat.name,
        title: room.title,
        host: room.host.name,
        seq: room.seq,
        history: page.events,
        more: page.more || undefined,
        historySeq: page.more ? page.events.at(-1)?.seq : undefined,
        people: room.people(now),
        fromNow: room.fromNow || undefined,
        latest: PLUGIN_LATEST,
        hostVersion: room.host.version,
        team: teamOf(room),
        // What's shared now, whatever history was pruned (older plugins ignore it).
        previews: previewList(room),
      }),
    }
  }

  // The operator ends a room (abuse): its admin token, checked by the host.
  if (rest === 'admin-end' && method === 'POST') {
    if (!ctx.admin) return { response: json({ error: 'Not found' }, 404) }
    room.end(now)
    await unlist(room, ctx)
    return { changed: true, response: json({ ok: true }) }
  }

  // An away seat can still deliberately leave even when all seats are full.
  if (rest === 'leave' && method === 'POST' && room.away.has(bearerOf(req))) {
    room.leave(bearerOf(req), 'left', now)
    return { changed: true, response: json({ ok: true }) }
  }
  const auth = room.auth(bearerOf(req), now)
  if (!auth) return { response: json({ error: 'Not a member of this session.' }, 401) }
  // Which plugin each one runs now (an update and a restart change it): a
  // guest's plugin says what an older host's can't show, and the Room who
  // needs to update.
  noteVersion(room, req, auth)

  const files = await fileRoutes(room, req, rest, auth, now)
  if (files) return files
  const previews = await previewRoutes(room, req, rest, auth, now, ctx)
  if (previews) return previews
  if (rest === 'need' && method === 'POST') return needRoute(room, req, auth, now, ctx)

  if (rest === 'stream' && method === 'GET') {
    if (room.endedAt) return { response: json({ error: 'This session is no longer shared.' }, 410) }
    const after = Number(url.searchParams.get('after') ?? 0) || 0
    room.touch(auth, now)
    const takes = name => auth.role === 'host' && url.searchParams.get(name) === '1'
    return { response: streamResponse(room, auth, after, { tcpSupport: takes('tcp'), needSupport: takes('need') }) }
  }

  if (rest === 'events' && method === 'GET') {
    const after = Number(url.searchParams.get('after') ?? 0) || 0
    const wait = Math.min(Number(url.searchParams.get('wait') ?? POLL_WAIT_MS) || 0, 25_000)
    room.touch(auth, now)
    await room.wait(after, wait)
    const at = Date.now()
    room.touch(auth, at)
    const max = maxOf(url)
    const page = max ? pageOf(room.since(after), max) : { events: room.since(after), more: false }
    return {
      response: json({
        // Cut short, the cursor stops at the last event sent.
        seq: page.more ? page.events.at(-1).seq : room.seq,
        more: page.more || undefined,
        events: page.events,
        people: room.people(at),
        ended: Boolean(room.endedAt),
        title: room.title,
        team: room.team?.name,
      }),
    }
  }

  if (rest === 'events' && method === 'POST') {
    if (room.endedAt) return { response: json({ error: 'This session is no longer shared.' }, 410) }
    if (!room.posts.hit('events', 'all', now)) return { response: limitedResponse('events') }
    const body = await readJson(req)
    const allowed = auth.role === 'host' ? HOST_TYPES : GUEST_TYPES
    const from = { seat: auth.seat, name: auth.name, role: auth.role }
    room.touch(auth, now)
    const items = (Array.isArray(body.events) ? body.events.slice(0, 200) : []).filter(item => item && allowed.has(item.type))
    // A guest's event past EVENT_BYTES, clamped, is refused, and the post with
    // it (nothing a guest's plugin sends is that big); a host's is cut.
    if (auth.role !== 'host' && items.some(item => bodyBytes(clampBody(item.body)) > EVENT_BYTES)) {
      return { response: json({ error: `An event is limited to ${EVENT_BYTES / 1024} KB.` }, 413) }
    }
    let changed = false
    for (const item of items) {
      if (item.type === 'title' && typeof item.body?.title === 'string') {
        room.title = item.body.title.slice(0, 120)
      }
      if (item.type === 'react' || item.type === 'seen') {
        const mark = tidyMark(item.type, item.body)
        if (mark) room.append(from, item.type, mark, now)
        if (mark) changed = true
        continue
      }
      room.append(from, item.type, item.body, now)
      if (!LIVE_TYPES.has(item.type)) changed = true
    }
    room.wake()
    return { changed, response: json({ seq: room.seq }) }
  }

  if (rest === 'leave' && method === 'POST') {
    if (auth.role === 'guest') room.leave(bearerOf(req), 'left', now)
    return { changed: true, response: json({ ok: true }) }
  }

  if (rest === 'end' && method === 'POST') {
    if (auth.role !== 'host') return { response: json({ error: 'Only the host can stop sharing.' }, 403) }
    room.end(now)
    await unlist(room, ctx)
    return { changed: true, response: json({ ok: true }) }
  }

  // The host invites teammates by account (the host signed in): each sees it
  // in their own Claude Code, no link to pass on.
  if (rest === 'invite' && method === 'POST') {
    if (auth.role !== 'host') return { response: json({ error: 'Only the host invites people.' }, 403) }
    if (room.endedAt) return { response: json({ error: 'This session is no longer shared.' }, 410) }
    if (!ctx.directory) return { response: json({ error: "This share server doesn't have accounts." }, 400) }
    if (!room.posts.hit('events', 'all', now)) return { response: limitedResponse('events') }
    const body = await readJson(req)
    const result = await ctx.directory.sessionInvite(accountOf(req), { id: room.id, url: shareUrl(origin, room.id), title: room.title, host: room.host.name }, body.to)
    if (!result.ok) return { response: json({ error: result.error }, result.status) }
    return { response: json({ invited: result.invited, refused: result.refused }) }
  }

  // The host shares an open room with a team, another one, or the link alone
  // (`team: null`). Everyone already in stays.
  if (rest === 'team' && method === 'POST') {
    if (auth.role !== 'host') return { response: json({ error: 'Only the host chooses who it is shared with.' }, 403) }
    if (room.endedAt) return { response: json({ error: 'This session is no longer shared.' }, 410) }
    const body = await readJson(req)
    const team = body.team ? await teamFor(req, body.team, ctx) : null
    if (team?.error) return { response: team.error }
    await unlist(room, ctx)
    room.team = team
    if (team) await listWithTeam(room, origin, ctx)
    room.wake()
    return { changed: true, response: json({ team: teamOf(room) ?? null }) }
  }

  return { response: json({ error: 'Not found' }, 404) }
}

async function unlist(room, ctx) {
  if (room.team && ctx.directory) await ctx.directory.unregister(room.team.id, room.id).catch(() => {})
}

// One open stream: a JSON line now (everything after `after`), another each
// time the room changes, and a keepalive line between. When it ends (the
// client went, the room ended, or STREAM_MAX_MS passed) the seat counts as
// last seen then, and `onDisconnect` lets the host process settle who is still
// here once the grace period is over. A host's stream says which asks it
// takes (toHost).
function streamResponse(room, auth, after, { tcpSupport = false, needSupport = false } = {}) {
  const enc = new TextEncoder()
  let sub = null
  let done = false
  const finish = () => {
    if (done) return false
    done = true
    room.subscribers.delete(sub)
    clearInterval(sub.keepalive)
    clearTimeout(sub.maxAge)
    room.touch(auth, Date.now())
    room.onDisconnect?.()
    return true
  }
  const body = new ReadableStream({
    start(controller) {
      let cursor = after
      const send = obj => {
        try {
          controller.enqueue(enc.encode(`${JSON.stringify(obj)}\n`))
        } catch {}
      }
      const close = () => {
        if (!finish()) return
        try {
          controller.close()
        } catch {}
      }
      sub = {
        seat: auth.seat,
        tcpSupport,
        needSupport,
        send,
        push: () => {
          const page = room.page(cursor, Date.now())
          cursor = page.seq
          send(page)
          if (page.ended) close()
        },
        keepalive: setInterval(() => send({ t: Date.now() }), KEEPALIVE_MS),
        maxAge: setTimeout(close, STREAM_MAX_MS),
      }
      room.subscribers.add(sub)
      sub.push()
      if (auth.role === 'host') room.notify() // the host is back: everyone sees it
    },
    cancel() {
      finish()
    },
  })
  return new Response(body, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
  })
}

// ---------------------------------------------------------------------------
// Files: POST files (the host's shown files and pictures, a guest's prompt
// attachments; the bytes, x-file-name) → { id, name, type, size };
// GET files/<id> (any member) → the bytes. The id is the bytes' SHA-256.

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('')
}

const fileName = raw => {
  let name = String(raw ?? '')
  try {
    name = decodeURIComponent(name)
  } catch {}
  return name.split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').slice(0, 120) || 'file'
}
// A file's type, as its name: no control characters (no type has one, and a
// record written as JSON takes six bytes for each), at most 100 characters.
const fileType = raw => String(raw ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, 100) || 'application/octet-stream'

async function fileRoutes(room, req, rest, auth, now) {
  if (rest === 'files' && req.method === 'POST') {
    if (room.endedAt) return { response: json({ error: 'This session is no longer shared.' }, 410) }
    let bytes
    try { bytes = await readBody(req, FILE_MAX) } catch (error) {
      return error.status === 413 ? { response: json({ error: `Files are limited to ${FILE_MAX / 1024 / 1024} MB.` }, 413) } : bodyFailure(error)
    }
    const id = await sha256(bytes)
    const used = [...room.files.values()].reduce((n, f) => n + (f.id === id ? 0 : f.size), 0)
    if (used + bytes.length > ROOM_FILES_MAX || (!room.files.has(id) && room.files.size >= ROOM_FILES_COUNT)) return { response: json({ error: 'This room is out of room for files.' }, 413) }
    const meta = { id, name: fileName(req.headers.get('x-file-name')), type: fileType(req.headers.get('content-type')), size: bytes.length, ts: now }
    await room.store.put(id, bytes, meta)
    room.files.set(id, meta)
    return { changed: true, response: json(meta) }
  }
  if (rest.startsWith('files/') && req.method === 'GET') {
    const meta = room.files.get(rest.slice(6))
    const stored = meta ? await room.store.get(meta.id) : null
    if (!stored) return { response: json({ error: 'No such file.' }, 404) }
    return {
      response: new Response(stored.data, {
        headers: { 'content-type': meta.type, 'content-length': String(meta.size), 'cache-control': 'private, max-age=3600' },
      }),
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Previews: the host shares a localhost port; members get tickets (one browser each)
// that open it on the preview host name.
//   GET previews (any member) → { previews: [{ pid, port, tcp, title }] }, what's open now
//   POST previews { port, title, tcp? } (host) → { pid, tcp }
//   POST previews/<pid>/end (host)
//   POST previews/<pid>/ticket { path } (any member) → { url }
//   POST proxy/<request id> (host): a proxied request's answer. Format 2
//     (x-proxy-format: 2, which asks say they take with `answer: 2`): one
//     UTF-8 JSON line { status, headers: [[name, value], ...] }, then the
//     body. Before it (0.11.24 hosts): the body alone, x-proxy-status its
//     status and x-proxy-headers its header block (base64).

// What the room says is shared now: every open preview, whether it's
// forwarded, its port and title. How a guest shows one (its path, host,
// scheme, what it's used by) stays the host's artifacts' to say.
const previewList = room => (room.endedAt ? [] : [...room.previews.values()].map(p => ({ pid: p.pid, port: p.port, tcp: p.tcp === true, title: p.title })))
// The event a preview's opening appends, and its forwarding again: guests
// that take what's shared from the room read existence and `tcp` here.
const previewOpened = p => ({ state: 'open', pid: p.pid, port: p.port, tcp: p.tcp === true, title: p.title })
const fromHost = room => ({ seat: 'host', name: room.host.name, role: 'host' })

// A seat's minute of minting links first, then the room's: past its own, one
// member doesn't spend everyone's. Counted before the body is read.
function mintAllowed(room, seat, now) {
  const hit = (key, limit) => {
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
// Applied as a link is made and again as it's used (one saved before), so a
// Location header can't be refused.
function linkPath(raw) {
  if (typeof raw !== 'string' || raw.length > PUBLIC_LIMITS.pathBytes || !raw.startsWith('/') || raw.startsWith('//')) return '/'
  let out = ''
  for (const b of new TextEncoder().encode(raw)) out += b > 0x20 && b < 0x7f && b !== 0x5c ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`
  return out.length <= PUBLIC_LIMITS.pathBytes ? out : '/'
}

// When a link was made (its expiry says it).
const mintedAt = entry => entry.exp - (entry.clear ? CLEAR_TICKET_MS : TICKET_MS)

// Past `keep`, the oldest of these go: used ones first (they only remember a
// browser), then unused.
function dropOldest(room, entries, keep) {
  entries.sort((a, b) => Number(!a[1].used) - Number(!b[1].used) || mintedAt(a[1]) - mintedAt(b[1]))
  for (const [old] of entries.slice(0, Math.max(0, entries.length - keep))) room.tickets.delete(old)
}

// A new link, kept with the room: expired ones go first, then, to make room,
// the seat's oldest past its newest few and the room's past its newest. The
// second link after clearing (`clear`) counts like any other.
function mintTicket(room, { pid, path, seat, clear = false }, now, ticket = token(18)) {
  for (const [old, entry] of room.tickets) if (entry.exp <= now) room.tickets.delete(old)
  dropOldest(room, [...room.tickets].filter(([, entry]) => entry.seat === seat), PUBLIC_LIMITS.seatTickets - 1)
  dropOldest(room, [...room.tickets], PUBLIC_LIMITS.roomTickets - 1)
  room.tickets.set(ticket, { pid, exp: now + (clear ? CLEAR_TICKET_MS : TICKET_MS), path, seat, ...(clear ? { clear: true } : {}) })
  return ticket
}
// The room by its preview key, never its id; its preview rides along (an id,
// not a credential), so a browser already in that preview goes back to it
// once the link itself has expired.
const enterUrl = (origin, room, ticket, pid) => `${origin}/__share/enter?room=${room.previewKey}&ticket=${ticket}&pid=${pid}`

async function previewRoutes(room, req, rest, auth, now, ctx) {
  const method = req.method
  if (rest === 'previews' && method === 'GET') {
    if (room.endedAt) return { response: json({ error: 'This session is no longer shared.' }, 410) }
    return { response: json({ previews: previewList(room) }) }
  }
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
    const preview = { pid: token(8), port, title: String(body.title ?? '').slice(0, 120) || `localhost:${port}`, ts: now, ...(tcp ? { tcp: true } : {}) }
    room.previews.set(preview.pid, preview)
    room.append(fromHost(room), 'preview', previewOpened(preview), now)
    room.wake()
    return { changed: true, response: json({ pid: preview.pid, tcp }) }
  }
  const match = /^previews\/([A-Za-z0-9_-]+)\/(end|ticket|tunnel)$/.exec(rest)
  if (match && method === 'POST') {
    const preview = room.previews.get(match[1])
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
    if (match[2] === 'tunnel') {
      // Nothing in a grant's body is used, so none is read: this one check
      // holds, with nothing awaited between it and the grant.
      const access = roomAccessError(room, req, ctx)
      if (access) return { response: access }
      if (!preview.tcp) return { response: json({ error: 'This preview opens through its link: the host shared it as a page, not for forwarding.' }, 403) }
      if (!room.tcpSupported()) return { response: json({ error: 'The host is not connected with TCP preview support. Update its plugin and reconnect.' }, 503) }
      const at = Date.now()
      // A refusal changes nothing to save but the minute's counters, which
      // the adapters persist on their own when they moved.
      if (!tcpAdmit(room, at, auth.seat)) return { response: json({ error: 'Too many TCP preview connections or grants. Try again in a minute.' }, 429) }
      const caps = [...room.previewSessions].filter(([, s]) => s.scope === 'tcp')
      const same = caps.filter(([, s]) => s.pid === preview.pid && s.seat === auth.seat).sort((a, b) => a[1].exp - b[1].exp)
      const replace = Math.max(0, same.length - TCP_LIMITS.seatCaps + 1)
      if (caps.length - replace >= TCP_LIMITS.roomCaps) return { response: json({ error: 'Too many TCP preview grants in this room. Try again after one expires.' }, 429) }
      // Open/rebind/resume needs a fresh grant. Roll only this seat/preview's
      // oldest one, closing its streams rather than locking the listener out.
      for (const [old] of same.slice(0, replace)) room.revokeTCP({ cap: old })
      const cap = token(24)
      const exp = at + TCP_LIMITS.capMs
      room.previewSessions.set(cap, { pid: preview.pid, seat: auth.seat, scope: 'tcp', exp })
      return { changed: true, response: json({ token: cap, expiresAt: exp, port: preview.port, protocol: TCP_LIMITS.protocol }) }
    }
    if (!ctx.previewOrigin) return { response: json({ error: 'This server does not serve previews.' }, 501) }
    const check = () => roomAccessError(room, req, ctx) ?? (room.previews.has(preview.pid) ? null : json({ error: 'No such preview.' }, 404))
    const before = check()
    if (before) return { response: before }
    if (!mintAllowed(room, auth.seat, now)) return { response: json({ error: 'Too many preview links. Try again in a minute.' }, 429) }
    // Where the link lands: a page of the app (one path on it), else its root.
    let asked = {}
    try { asked = await readBoundedJson(req) } catch (error) { if (error.status === 413) return bodyFailure(error) }
    // A Leave, a Stop or the room's end while the body arrived mints nothing.
    const after = check()
    if (after) return { response: after }
    const ticket = mintTicket(room, { pid: preview.pid, path: linkPath(asked.path), seat: auth.seat }, Date.now())
    return { changed: true, response: json({ url: enterUrl(ctx.previewOrigin, room, ticket, preview.pid) }) }
  }
  if (rest.startsWith('proxy/') && method === 'POST') return proxyAnswer(room, req, rest.slice(6), auth)
  return null
}

// The host's answer to a proxied request, as the guest's browser gets it.
// Read as it arrives, at most a response's worth (and format 2's first line):
// past that, or not what format 2 says, the browser gets a 502 page at once,
// rather than an empty body under the app's status or a 504 later.
async function proxyAnswer(room, req, id, auth) {
  if (auth.role !== 'host') return { response: json({ error: 'Only the host answers previews.' }, 403) }
  if (!room.proxied.has(id)) return { response: json({ error: 'That request is no longer waiting.' }, 410) }
  const format2 = req.headers.get('x-proxy-format') === '2'
  const failed = text => room.proxied.get(id)?.(previewPage(502, 'The preview did not answer', text))
  let bytes
  try { bytes = await readBody(req, format2 ? PROXY_HEAD_MAX + 1 + PROXY_RESPONSE_MAX : PROXY_RESPONSE_MAX) } catch (error) {
    failed(error.status === 413 ? `Its answer was over ${PROXY_RESPONSE_MAX / 1024 / 1024} MB, more than a preview carries.` : 'Its answer was cut short.')
    return bodyFailure(error)
  }
  const settle = room.proxied.get(id)
  if (!settle) return { response: json({ error: 'That request is no longer waiting.' }, 410) }
  if (!format2) {
    settle(proxiedAnswer(Number(req.headers.get('x-proxy-status')) || 502, headerBlockPairs(req.headers.get('x-proxy-headers')), bytes))
    return { response: json({ ok: true }) }
  }
  const answer = formatTwo(bytes)
  if (!answer) {
    failed('Its answer could not be read.')
    return { response: json({ error: 'Expected one JSON line { status, headers: [[name, value], ...] } of at most 64 KiB, a newline, then the body.' }, 400) }
  }
  if (answer.body.byteLength > PROXY_RESPONSE_MAX) {
    failed(`Its answer was over ${PROXY_RESPONSE_MAX / 1024 / 1024} MB, more than a preview carries.`)
    return { response: json({ error: `Preview answers are limited to ${PROXY_RESPONSE_MAX} bytes.` }, 413) }
  }
  settle(proxiedAnswer(answer.status, answer.headers, answer.body))
  return { response: json({ ok: true }) }
}

// A guest's page asks for a host port nobody forwarded: the room tells the
// host's stream who asks for which port, and only that. Nothing is kept or
// put in history, and no one else hears it; a host not connected now never
// does. Raw TCP stays the host's choice: this is only a proposal.
//   POST need { port } (a guest) → { shared: true, pid } when the port is already
//     forwarded (the preview to use, even one whose artifact the guest never
//     saw), else { delivered } (whether a host stream got the line)
// A seat asks NEED_LIMIT times a minute, counted in memory per room: apart
// from the room's events window, and not one of LIMITS, whose kinds are also
// the Worker's rate-limit bindings (wrangler.toml says the same).
export const NEED_LIMIT = Object.freeze({ limit: 20, periodMs: 60_000, bodyBytes: 256 })

function needAllowed(room, seat, now) {
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

async function needRoute(room, req, auth, now, ctx) {
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
function proxiedAnswer(status, pairs, body) {
  const code = Number.isInteger(status) && status >= 200 && status <= 599 ? status : 502
  const headers = new Headers({ 'cache-control': 'no-store' })
  for (const [rawName, rawValue] of pairs) {
    const name = rawName.trim().toLowerCase()
    let value = rawValue.trim()
    if (!name || HOP.has(name)) continue
    if (name === 'location') value = value.replace(/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?/i, '') || '/'
    try { headers.append(name, value) } catch {}
  }
  return new Response(NULL_BODY.has(code) ? null : body, { status: code, headers })
}

// 0.11.24 hosts' header block, what curl wrote (every response of a redirect
// chain, base64): the last one counts.
function headerBlockPairs(headerBlock) {
  let raw = ''
  try {
    raw = new TextDecoder().decode(fromBase64(headerBlock ?? ''))
  } catch {}
  const blocks = raw.split(/\r?\n\r?\n/).filter(b => /^HTTP\//.test(b.trim()))
  const pairs = []
  for (const line of (blocks.at(-1) ?? '').trim().split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':')
    if (i > 0) pairs.push([line.slice(0, i), line.slice(i + 1)])
  }
  return pairs
}

// Format 2: its first line, the status and headers as JSON (at most
// PROXY_HEAD_MAX), then the body as it is. Null when it isn't that.
function formatTwo(bytes) {
  const end = bytes.subarray(0, PROXY_HEAD_MAX + 1).indexOf(0x0a)
  if (end < 0) return null
  let head
  try { head = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end))) } catch { return null }
  if (!head || typeof head !== 'object' || Array.isArray(head) || !Number.isInteger(head.status) || !Array.isArray(head.headers)) return null
  if (!head.headers.every(h => Array.isArray(h) && h.length === 2 && typeof h[0] === 'string' && typeof h[1] === 'string')) return null
  return { status: head.status, headers: head.headers, body: bytes.subarray(end + 1) }
}

const COOKIE = 'cs_pv'
const previewPage = (status, title, text) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;font-family:-apple-system,Helvetica,sans-serif;background:#faf8f7;color:#011121"><div style="max-width:420px;padding:24px;text-align:center"><h1 style="font-weight:400;font-size:26px">${title}</h1><p style="color:#4b5563">${text}</p></div>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )

// The server's own front page: what this is, the one-line install, and what
// the server sees and keeps (the disclosure a public server owes its users).
export function homePage(origin) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shared Sessions for Claude Code</title>
<meta name="description" content="Share a Claude Code session with a link. Teammates join from their own Claude Code and work in it together.">
<meta property="og:title" content="Shared Sessions for Claude Code">
<meta property="og:description" content="Share a Claude Code session with a link. Teammates join from their own Claude Code and work in it together.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@500;600&family=Gowun+Batang:wght@400;700&display=swap" rel="stylesheet">
<style>
${PAGE_CSS}
.prose { max-width:64ch; color:var(--muted); font-size:15px; line-height:1.6; text-wrap:pretty; }
.prose h2 { font-family:var(--display); font-weight:400; font-size:26px; color:var(--ink); margin:0 0 12px; }
.prose ul { padding-left:18px; margin:10px 0; } .prose li { margin:6px 0; }
.prose b { color:var(--ink); font-weight:600; }
.prose a { color:var(--accent-ink); text-decoration:underline; text-underline-offset:2px; }
.install { max-width:640px; margin-top:28px; }
.install .composer code { white-space:normal; overflow-wrap:anywhere; }
section.more { padding:0 0 72px; }
</style></head>
<body>
<header class="wrap nav">
  <a class="brand" href="/"><svg viewBox="0 0 500 500" aria-hidden="true">${LOGO_PATHS}</svg><span class="word">Paradigm</span><span class="sub">Shared sessions</span></a>
  <a class="btn-ghost" href="https://github.com/Paradigm-Study/claude-share">GitHub</a>
</header>
<main class="wrap">
  <section class="hero" style="grid-template-columns:minmax(0,1fr);padding-bottom:56px">
    <div>
      <span class="eyebrow">A Claude Code plugin</span>
      <h1>Share a Claude Code session with a link</h1>
      <p class="sub-copy">Teammates join from their own Claude Code and talk to it. One session does the work, everyone sees every turn as it streams, and the host approves what runs on their machine.</p>
      <div class="install">
        ${commandBox('install', INSTALL_COMMAND, 'Copy install command')}
        <p class="status">Then start a new session and press <b>Share</b> above the prompt (or type /share-session). For your team, press <b>Team</b>: sign in with GitHub or Google, and everything your team shares is a press from joining. Requires Claude Code 2.1.286 or later.</p>
      </div>
    </div>
  </section>
  <section class="more prose" id="privacy">
    <h2>What this server sees and keeps</h2>
    <ul>
      <li><b>What passes through:</b> while a session is shared, its prompts and the files people attach to them, Claude's replies and, while someone else is in the room, its thinking as it happens (passed along, never kept), the tools it runs with the first lines of their results and the pictures in them (screenshots, images it opens), the side chat, people's reactions to Claude's replies and which replies each person has had on screen, and any files or local previews the host's Claude shows. Sharing a session that already has history asks first whether to include it.</li>
      <li><b>How long:</b> a room and everything in it is deleted 24 hours after the host stops sharing or was last seen. A room keeps its newest 5000 events, 16 MB of them at most. For TCP previews the room keeps grants (which preview and seat, and when they expire) and coarse connection and byte-budget counters until the room is deleted. For a preview opened through its link, the room keeps the link (which preview, which seat made it, the page it opens) for 10 minutes, and the browser session it starts (which preview and seat) for 12 hours from the last link that browser opened; both end when that seat leaves or the host stops the preview. A seat keeps its newest 4 browser sessions per preview, and a room its newest 128 links and 256 browser sessions. A grant, link or session that expired is removed at the room's next activity, or with the room; one that ended goes at once. Application bytes are relayed, never stored. There are no analytics, and no request logs kept.</li>
      <li><b>Previews share a host name:</b> every shared session's previews are served on one preview host name, and their links name the session by a key of its own, which can't join it. A browser not already in a session's previews has that host name's storage and cache, and its domain's cookies, cleared before it enters; browsers clear them only over HTTPS (or on localhost). No preview can register a service worker there.</li>
      <li><b>Accounts, only for teams:</b> sharing and joining need none. If you sign in (GitHub or Google) to use teams, the server keeps your name, username, verified email, which GitHub organizations you're in, the teams you're in and their settings, which open sessions are shared with each team, and invites to a session (who invited whom, until it's joined, dismissed, ends, or 12 hours pass). Signing in finishes only when you press Continue on this server's page. From Shared Sessions 0.11.25 on, the page and Claude Code show the same code, and you continue only if they match; with an older version, the page shows no code. Until you press Continue, the server keeps who GitHub or Google said you are; after ten minutes that sign-in stops working, and it's deleted the next time Claude Code asks for it or anyone signs in. Claude Code's token is made when it picks up the sign-in, and the server keeps only its hash, never the token itself. Sign-ins stay until you delete your account (<code>/team delete-account</code>), which removes them at once. Signed in, a session you share or join also knows your account for as long as it lasts, so your sessions count as one person.</li>
      <li><b>Who can see it:</b> anyone with the room's link, or for a session shared with a team that keeps it to its people, only the people in that team. Links are long and random; forward one only to people you'd hand the session to. Content is encrypted in transit, not end to end: the server can read what passes through it.</li>
      <li><b>What runs where:</b> a teammate's prompt runs on the host's machine. Reads inside the host's project run without asking; everything else asks the host first, by default.</li>
      <li><b>Limits:</b> new rooms and joins are rate-limited per network; rooms hold up to 20 people, 100 MB of files (10,240 files at most), 128 open previews, and events of 128 KB each. Previews opened through their link limit request bodies to 1 MB and response bodies to 20 MB, and allow 512 requests waiting per room, 32 WebSockets per seat and 128 per room (one the host's Claude Code doesn't take up within 10 seconds closes, and those waiting hold 8 MB per room at most), and 30 new links a minute per seat (120 per room). Such a WebSocket closes once 1 MB sent through it waits unread; on Cloudflare, which can't see that, once one side sends more than 4 MB in a second. TCP previews instead allow 32 connections per seat across all grants and previews, 64 per room, 2 grants per seat and preview, 128 per room, and 1200 new connections or grants per minute (240 for any one seat). Only a port the host chose to forward can be reached this way. A grant lasts 12 hours; unpaired connections close after 10 seconds. A room has a lifetime 1 GiB TCP byte budget, reserved in 1 MiB chunks per direction, unused parts given back when a connection closes. Data messages are at most 64 KiB, with at most 4 messages / 256 KiB outstanding per direction; each half also closes at 1 MiB of cumulative control output, not counting the credit notices it acknowledged. Rooms that are abused get ended.</li>
      <li><b>Your own server:</b> teams that want their sessions on their own infrastructure can run the same server on Cloudflare or Node in a few minutes (<a href="https://github.com/Paradigm-Study/claude-share#host-a-server">how</a>), and set it in the plugin.</li>
    </ul>
    <p>Questions or abuse reports: open an issue on <a href="https://github.com/Paradigm-Study/claude-share/issues">GitHub</a>.</p>
  </section>
</main>
<footer class="wrap"><q>Everyone in one session, Claude in the middle.</q></footer>
<script>${COPY_SCRIPT}</script>
</body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } })
}

// A page in the site's own look: the nav, an eyebrow, a serif heading, its
// words, then whatever follows (buttons, a command to copy). The account,
// invite and not-found pages are all this; callers escape what they pass.
export function brandPage({ title, eyebrow = '', heading, body = '', after = '', mark = '', status = 200, script = '' }) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title ?? heading)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@500;600&family=Gowun+Batang:wght@400;700&display=swap" rel="stylesheet">
<style>
${PAGE_CSS}
.page { max-width:640px; padding:64px 0 72px; }
.page .sub-copy + .sub-copy { margin-top:12px; }
.page .cta { margin-top:28px; }
.page .first { margin-top:22px; }
</style></head>
<body>
<header class="wrap nav">
  <a class="brand" href="/"><svg viewBox="0 0 500 500" aria-hidden="true">${LOGO_PATHS}</svg><span class="word">Paradigm</span><span class="sub">Shared sessions</span></a>
  ${mark}
</header>
<main class="wrap">
  <section class="page">
    ${eyebrow ? `<span class="eyebrow">${escapeHtml(eyebrow)}</span>` : ''}
    <h1>${escapeHtml(heading)}</h1>
    ${body}
    ${after}
  </section>
</main>
<footer class="wrap"><q>Everyone in one session, Claude in the middle.</q></footer>
${script ? `<script>${script}</script>` : ''}
</body></html>`
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

// The one-line install, as a command to copy (pages that hand people off to
// Claude Code show it under "First time?").
export const INSTALL_COMMAND = 'claude plugin marketplace add Paradigm-Study/claude-share && claude plugin install shared-session@claude-share'
export const COPY_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>'
export const commandBox = (id, text, label) => `<div class="composer"><span class="slash" aria-hidden="true">$</span><code id="${id}">${escapeHtml(text)}</code><button type="button" data-copy="${id}" aria-label="${escapeHtml(label)}">${COPY_ICON}</button></div>`
// Every [data-copy] button copies its code's text and says so for a moment:
// in the code's place when it shows, else on the button itself.
export const COPY_SCRIPT = `document.querySelectorAll('[data-copy]').forEach(function (b) { b.addEventListener('click', function () {
  var code = document.getElementById(b.getAttribute('data-copy')); var text = code.getAttribute('data-text') || code.textContent; code.setAttribute('data-text', text);
  var where = code.hidden ? b : code; var was = where.getAttribute('data-was') || where.innerHTML; where.setAttribute('data-was', was);
  navigator.clipboard.writeText(text).then(function () { where.textContent = 'Copied'; setTimeout(function () { where.innerHTML = was; }, 1500); }); }); });`

// A link to a room that isn't here (ended long ago and swept, or mistyped):
// the landing page's look, and what to do.
export function missingPage() {
  return brandPage({
    title: "This shared session isn't here",
    eyebrow: 'Link not found',
    heading: "This shared session isn't here",
    body: '<p class="sub-copy">It ended, or the link is incomplete. Ask whoever sent it for a new one.</p>',
    mark: '<span class="live ended"><i></i><span>ENDED</span></span>',
    status: 404,
  })
}

// A preview link whose room isn't here.
export const previewMissing = () => previewPage(404, 'This preview has ended', 'The shared session it belonged to is no longer here.')
// A request body past PROXY_BODY_MAX, on either adapter.
export const previewTooLarge = () => previewPage(413, 'Too large', 'Request bodies through a preview are limited to 1 MB.')

// The request's preview cookie, as [room's preview key, session id]; empty without one.
function previewCookie(req) {
  const cookie = (req.headers.get('cookie') ?? '').split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))
  return cookie ? cookie.slice(COOKIE.length + 1).split('.') : []
}

// The preview key a preview request is for (the room's `previewKey`): the
// enter link's, else the cookie's.
export function previewRoomOf(req) {
  const url = new URL(req.url)
  if (url.pathname === '/__share/enter') return url.searchParams.get('room')
  return previewCookie(req)[0] ?? null
}

// Whether a link's or a cookie's room part names this room: its preview key,
// or its id, which links made and cookies set before rooms had keys carry
// (through a deploy, by either Worker). Nothing new is made with the id.
const namesRoom = (room, key) => Boolean(key) && (key === room.previewKey || key === room.id)

// The preview session a request's cookie holds in this room, while it lasts
// and its seat is still the room's, with its id (`sid`).
function previewSession(room, req, now) {
  const [key, sid] = previewCookie(req)
  const session = namesRoom(room, key) && sid ? room.previewSessions.get(sid) : null
  return session && session.scope !== 'tcp' && session.exp > now && (!session.seat || seatKnown(room, session.seat)) ? { ...session, sid } : null
}

// Every room's previews share one host name, so a browser can carry what
// another room's app left there, whatever it has or lacks now (a quit browser
// drops cs_pv and keeps an app's storage): anything but this room's cookie
// is cleared for.
function otherRoomsState(room, req) {
  return !namesRoom(room, previewCookie(req)[0])
}

const redirect = location => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } })

// What another room left goes before this room's cookie is set: a page that
// sets nothing, asks the browser to clear the host name's storage (service
// workers with it) and cache, and cookies, which browsers clear for its whole
// registrable domain (so PREVIEW_URL wants a domain of its own), and goes on
// to a second single-use link.
const clearingPage = next =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeHtml(next)}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening the preview</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;font-family:-apple-system,Helvetica,sans-serif;background:#faf8f7;color:#011121"><p>Opening the preview… <a href="${escapeHtml(next)}">Continue</a></p>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'clear-site-data': '"cache", "cookies", "storage"' } },
  )

// A seat's newest few browsers per preview, and the room's newest (they're
// kept with it): one older is let go, its sockets with it (a reload of a
// newer one goes on as it was).
function keepNewestSessions(room, seat, pid) {
  const browsers = () => [...room.previewSessions].filter(([, s]) => s.scope !== 'tcp').sort((a, b) => a[1].exp - b[1].exp)
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
function enterPreview(room, req, url, now, secure) {
  const pruned = room.sweepGrants(now)
  const ticket = room.tickets.get(url.searchParams.get('ticket') ?? '')
  const own = previewSession(room, req, now)
  if (!ticket || ticket.used || ticket.exp <= now || !room.previews.has(ticket.pid) || room.endedAt || !seatKnown(room, ticket.seat)) {
    const pid = ticket?.pid ?? url.searchParams.get('pid')
    if (own && pid && own.pid === pid && room.previews.has(pid) && !room.endedAt) return { changed: pruned, response: redirect(linkPath(ticket?.path)) }
    return { changed: pruned, response: previewPage(403, 'This preview link has been used', 'Each link opens the preview in one browser, within ten minutes. For a new one, press <b>Open</b> in the Room panel in Claude Code.') }
  }
  const path = linkPath(ticket.path)
  // Spent, but kept until it expires, so the browser that used it is known.
  if (!ticket.clear && otherRoomsState(room, req)) {
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
  if (reuse) room.previewSessions.get(reuse).exp = now + PREVIEW_SESSION_MS
  else {
    room.previewSessions.set(sid, { pid: ticket.pid, exp: now + PREVIEW_SESSION_MS, seat: ticket.seat })
    keepNewestSessions(room, ticket.seat, ticket.pid)
  }
  return { changed: true, response }
}

// Everything on the preview host name. /__share/enter trades a ticket for a
// cookie; anything else, with the cookie, goes to the host's localhost.
export async function previewRequest(room, req, now, { secure = true } = {}) {
  const url = new URL(req.url)
  // No service worker registers here: one would outlive its room and answer
  // for every other room's previews in that browser, all on this host name.
  if ((req.headers.get('service-worker') ?? '').trim().toLowerCase() === 'script') {
    return { response: previewPage(403, 'Not here', 'Previews of a shared session do not run service workers.') }
  }
  if (url.pathname === '/__share/enter') return enterPreview(room, req, url, now, secure)
  const session = previewSession(room, req, now)
  const preview = session ? room.previews.get(session.pid) : null
  const ended = () => ({ response: previewPage(404, 'This preview has ended', `${room.host.name} is no longer sharing it.`) })
  const busy = () => ({ response: previewPage(503, 'The preview is busy', `${room.host.name}'s app has many requests waiting. Try again in a moment.`) })
  if (!preview || room.endedAt) return ended()
  if (room.proxied.size >= PUBLIC_LIMITS.proxied) return busy()
  let body = new Uint8Array()
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try { body = await readBody(req, PROXY_BODY_MAX) } catch (error) {
      return { response: error.status === 413 ? previewTooLarge() : previewPage(400, 'The request did not arrive', 'Its body was cut short.') }
    }
    // The browser's session, its preview and the room may have gone while the body arrived.
    const still = previewSession(room, req, Date.now())
    if (still?.sid !== session.sid || !room.previews.has(preview.pid) || room.endedAt) return ended()
    if (room.proxied.size >= PUBLIC_LIMITS.proxied) return busy()
  }
  const headers = []
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
  const answer = new Promise(resolve => {
    const timer = setTimeout(() => {
      room.proxied.delete(id)
      resolve(previewPage(504, 'The preview did not answer', `${room.host.name}'s app took too long to respond.`))
    }, PROXY_TIMEOUT_MS)
    room.proxied.set(id, response => {
      clearTimeout(timer)
      room.proxied.delete(id)
      resolve(response)
    })
  })
  // `answer: 2`: this server reads format 2 answers (see proxyAnswer).
  const sent = room.toHost({
    proxy: { id, pid: preview.pid, port: preview.port, method: req.method, path: `${url.pathname}${url.search}`, headers, body: body.length ? toBase64(body) : '', answer: 2 },
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
// them (worker.mjs, node.mjs); what's decided here is the same for both.
export const SOCKET_ID = /^[A-Za-z0-9_-]{8,40}$/

// Whom a browser's socket is for: its preview session, the port, the path.
// `active` is every public pair the adapter holds for this room, pending or
// paired (each { ownerSeat }): a seat and the room have PUBLIC_LIMITS' share.
// A session saved before seats were kept counts as a seat of its own.
export function previewSocketTarget(room, req, now, active = []) {
  const session = previewSession(room, req, now)
  const preview = session ? room.previews.get(session.pid) : null
  if (!preview || room.endedAt) return { ok: false, status: 404 }
  const ownerSeat = session.seat ?? `session:${session.sid}`
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
export function publicPairValid(room, pair, now) {
  const session = room?.previewSessions.get(pair?.session)
  return Boolean(room && !room.endedAt && pair && !pair.closed && pair.exp > now && room.previews.has(pair.pid) && session && session.scope !== 'tcp' && session.pid === pair.pid && session.exp > now &&
    (!session.seat || seatKnown(room, session.seat)))
}

// How a public pair's browser half closes when its host half closed with
// `code`: one that vanished (no close frame) is a failure the page should
// see, 1011, as it sees an app over localhost fail. A browser that vanishes
// closes the app's half plainly (sendableClose). Clients keyed on wasClean
// (Vite) see any close frame as clean, 1011 included.
export const hostHalfClose = code => (code === 1006 || code === 1015 ? 1011 : sendableClose(code))

// Asks the host for a relay; false when the host's Claude Code isn't connected.
export function announceSocket(room, id, target) {
  return room.toHost({ ws: { id, pid: target.pid, port: target.port, path: target.path, protocols: target.protocols } })
}

export function hostSocketAllowed(room, req) {
  const auth = room.auth(bearerOf(req))
  return Boolean(auth && auth.role === 'host' && !room.endedAt)
}

// The host turning away a socket it was asked to relay, TCP or public, while
// it waits for its host half: BUSY → 1013, CONNECT → 1011, else 0. Called only
// after host authentication; bounded as it arrives, it carries one code,
// never a relay's error text.
export async function relayRejectCode(req) {
  let body
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBody(req, TCP_LIMITS.controlBytes))) } catch { return 0 }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'code') return 0
  return body.code === 'BUSY' ? 1013 : body.code === 'CONNECT' ? 1011 : 0
}

// TCP admission: grants and new channels share the room's minute of opens
// (kept with its counters) and each seat's share of it (in memory). TCP
// capabilities are never browser sessions: only an Authorization bearer on
// the main server can open this single preview's data channel.
export function tcpAdmit(room, now, seat) {
  let w = room.tcpStats.opens
  if (!w || now - w.start >= TCP_LIMITS.openWindowMs) w = room.tcpStats.opens = { start: now, count: 0 }
  // One seat's share first: past it, a guest is turned away without spending
  // the room's minute, so one guest can't use up everyone's.
  if (seat) {
    let mine = room.tcpSeatOpens?.get(seat)
    if (!mine || now - mine.start >= TCP_LIMITS.openWindowMs) room.tcpSeatOpens?.set(seat, (mine = { start: now, count: 0 }))
    if (mine.count >= TCP_LIMITS.seatOpensPerMinute) return false
    mine.count += 1
  }
  w.count = Math.min(w.count + 1, TCP_LIMITS.opensPerMinute + 1)
  return w.count <= TCP_LIMITS.opensPerMinute
}

// Whether a seat is still this room's: here, or away within its grace list.
function seatKnown(room, seat) {
  if (seat === 'host') return true
  for (const s of room.seats.values()) if (s.id === seat) return true
  for (const s of room.away.values()) if (s.id === seat) return true
  return false
}

export function tcpSocketTarget(room, req, pid, now, active = []) {
  const cap = /^Bearer\s+([A-Za-z0-9_-]+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]
  const grant = cap ? room.previewSessions.get(cap) : null
  if (!grant || grant.scope !== 'tcp' || grant.pid !== pid || !grant.seat || grant.exp <= now || !seatKnown(room, grant.seat)) return { ok: false, status: 401, error: 'Invalid or expired TCP preview grant.' }
  const preview = room.previews.get(pid)
  if (!preview || room.endedAt) return { ok: false, status: 410, error: 'This TCP preview has ended.' }
  if (!preview.tcp) return { ok: false, status: 403, error: 'This preview opens through its link, not for forwarding.' }
  if (!room.tcpSupported()) return { ok: false, status: 503, error: 'The host is not connected with TCP preview support.' }
  // Both adapters supply one live guest half per pending or paired channel.
  // Grants and previews share the seat's ceiling, so rotation cannot bypass it.
  if (active.length >= TCP_LIMITS.roomPairs || active.filter(s => s.ownerSeat === grant.seat).length >= TCP_LIMITS.seatPairs) return { ok: false, status: 429, error: 'Too many active TCP preview connections.' }
  if (!tcpAdmit(room, now, grant.seat)) return { ok: false, status: 429, error: 'Too many TCP preview connections or grants. Try again in a minute.' }
  return { ok: true, room: room.id, pid, port: preview.port, cap, ownerSeat: grant.seat, exp: grant.exp }
}

export function announceTCP(room, id, target) {
  return room.toHost({ tcp: { id, pid: target.pid, port: target.port } })
}

export function tcpState(id, target, side, now) {
  return { id, room: target.room, pid: target.pid, port: target.port, cap: target.cap, ownerSeat: target.ownerSeat, exp: target.exp,
    side, deadline: now + TCP_LIMITS.pairMs, ready: false, fin: false, credits: [], remaining: 0, controlSent: 0,
    rate: { start: now, data: 0, control: 0 } }
}

// A pid's port never changes (a port shared again is a new preview), so the
// grant, its seat, its expiry and the preview still forwarded say it all.
export function tcpValid(room, s, now) {
  const grant = room.previewSessions.get(s.cap)
  return !room.endedAt && s.room === room.id && grant?.scope === 'tcp' && grant.pid === s.pid && grant.seat === s.ownerSeat && seatKnown(room, s.ownerSeat) && grant.exp === s.exp && s.exp > now && room.previews.get(s.pid)?.tcp === true
}

// Reserve once per direction per MiB, persist BEFORE forwarding. Both counters
// only grow (`used` reserved, `refunded` given back), so a new cap,
// reconnection or hibernation can't reset usage; what's spent is their difference.
export function tcpReserve(room, s) {
  if (room.tcpStats.used - (room.tcpStats.refunded ?? 0) + TCP_LIMITS.reserveBytes > TCP_LIMITS.roomBytes) return false
  room.tcpStats.used += TCP_LIMITS.reserveBytes
  s.remaining += TCP_LIMITS.reserveBytes
  return true
}

// A closing half gives back what it reserved and didn't carry, once: a room's
// budget pays for bytes, not for connections opened (a browser opens many).
export function tcpRefund(room, s) {
  const n = s?.remaining
  if (!(n > 0)) return 0
  s.remaining = 0
  room.tcpStats.refunded = (room.tcpStats.refunded ?? 0) + n
  return n
}

// Two copies of a room's TCP counters as one, whichever was saved later
// (overlapping writes, a separate file or key beside the room's snapshot):
// both totals only grow, and the later minute of opens wins (the same
// minute: the larger count).
export function mergeTCPStats(saved, current) {
  const older = saved?.opens, opens = current.opens
  const minute = older && older.start > opens.start ? older : older?.start === opens.start ? { start: opens.start, count: Math.max(older.count, opens.count) } : opens
  return { used: Math.max(saved?.used ?? 0, current.used), refunded: Math.max(saved?.refunded ?? 0, current.refunded ?? 0), opens: minute }
}

export function tcpFailure(message, code = 1008) {
  return Object.assign(new Error(message), { code })
}

export function tcpFrame(message) {
  if (typeof message !== 'string') {
    if (!(message instanceof ArrayBuffer) && !ArrayBuffer.isView(message)) throw tcpFailure('Expected binary TCP data.')
    const n = message.byteLength
    if (!n || n > TCP_LIMITS.dataBytes) throw tcpFailure('TCP data must contain 1–65536 bytes.', 1009)
    return { t: 'data', n, data: message }
  }
  if (utf8Length(message) > TCP_LIMITS.controlBytes) throw tcpFailure('TCP control is too large.', 1009)
  let frame
  try { frame = JSON.parse(message) } catch { throw tcpFailure('Invalid TCP control JSON.') }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw tcpFailure('Invalid TCP control.')
  const keys = Object.keys(frame).sort().join(',')
  if (frame.t === 'fin' && keys === 't') return frame
  if (frame.t === 'ack' && keys === 'n,nonce,t' && Number.isSafeInteger(frame.n) && frame.n > 0 && frame.n <= TCP_LIMITS.dataBytes && typeof frame.nonce === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(frame.nonce)) return frame
  throw tcpFailure('Invalid TCP control type or fields.')
}

export function tcpCheck(from, to, frame, now) {
  if (!from.ready || !to?.ready || from.id !== to.id || from.room !== to.room || from.pid !== to.pid || from.cap !== to.cap || from.ownerSeat !== to.ownerSeat || from.side === to.side) throw tcpFailure('TCP channel is not paired.')
  const rate = now - from.rate.start >= TCP_LIMITS.rateWindowMs ? { start: now, data: 0, control: 0 } : { ...from.rate }
  const kind = frame.t === 'data' ? 'data' : 'control'
  if (++rate[kind] > (kind === 'data' ? TCP_LIMITS.dataPerWindow : TCP_LIMITS.controlPerWindow)) throw tcpFailure('TCP message rate exceeded.')
  if (frame.t === 'data') {
    if (from.fin) throw tcpFailure('TCP data after FIN.')
    if (to.credits.length >= TCP_LIMITS.creditFrames || to.credits.reduce((n, c) => n + c.n, frame.n) > TCP_LIMITS.creditBytes) throw tcpFailure('TCP credit window exceeded.')
  } else if (frame.t === 'ack') {
    // The challenge belongs to this receiver, not the other direction. FIFO
    // also keeps the helpers' application writes and returned credit ordered.
    const credit = from.credits[0]
    if (!credit || credit.n !== frame.n || credit.nonce !== frame.nonce) throw tcpFailure('Invalid TCP credit acknowledgement.')
  } else if (from.fin) throw tcpFailure('Duplicate TCP FIN.')
  return rate
}

// What a half is sent besides data (ready, credit notices, forwarded acks,
// fin) counts against TCP_LIMITS.bufferBytes: output the Worker can't see
// read. An ack proves its sender read the credit notice it answers (only that
// notice carried its nonce), so that notice is given back (tcpRelay); ready,
// fin and the acks a sender is forwarded stay counted for the half's life.
export function chargeControl(s, control) {
  const text = JSON.stringify(control)
  const n = utf8Length(text)
  if (n > TCP_LIMITS.controlBytes || s.controlSent + n > TCP_LIMITS.bufferBytes) throw tcpFailure('TCP lifetime control output limit exceeded.')
  s.controlSent += n
  return text
}

// One TCP message, either direction, for both adapters: the messages to send
// on, in order, or `{ reserve: true }` when the sender's budget must grow
// first. Then the adapter reserves (tcpReserve), makes that durable, checks
// the half again where it can have changed meanwhile, and steps the same frame
// again: nothing was charged or counted the first time.
export function tcpStep(room, from, to, frame, now) {
  if (!tcpValid(room, from, now)) throw tcpFailure('TCP grant revoked or expired.')
  tcpCheck(from, to, frame, now)
  if (frame.t === 'data' && from.remaining < frame.n) return { reserve: true }
  return tcpRelay(from, to, frame, now)
}

const creditNotice = credit => ({ t: 'credit', n: credit.n, nonce: credit.nonce })

// Mutate only bounded metadata, never retain application payload. The caller
// saves both halves' attachments before sending these messages in order.
export function tcpRelay(from, to, frame, now) {
  from.rate = tcpCheck(from, to, frame, now)
  let messages
  if (frame.t === 'data') {
    if (from.remaining < frame.n) throw tcpFailure('TCP room byte budget exhausted.')
    const credit = { n: frame.n, nonce: token(16) }
    const notice = chargeControl(to, creditNotice(credit))
    from.remaining -= frame.n
    to.credits.push(credit)
    messages = [frame.data, notice]
  } else if (frame.t === 'ack') {
    const notice = chargeControl(to, frame)
    // The nonce proves `from` read the notice it answers: not unread now.
    from.controlSent = Math.max(0, from.controlSent - utf8Length(JSON.stringify(creditNotice(from.credits.shift()))))
    messages = [notice]
  } else {
    const notice = chargeControl(to, frame)
    from.fin = true
    messages = [notice]
  }
  return { messages, done: from.fin && to.fin && !from.credits.length && !to.credits.length }
}

// A close code a socket may send on (the reserved ones become a plain close).
export const sendableClose = code => (Number.isInteger(code) && code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1000)

function toBase64(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(out)
}

function fromBase64(text) {
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export function notFound() {
  return json({ error: 'Not found' }, 404)
}

export function badRequest(message) {
  return json({ error: message }, 400)
}

export { json }

// ---------------------------------------------------------------------------
// The page a share link opens in a browser: hands the link to Claude Desktop
// as a new Claude Code session's prompt, where the plugin joins on Enter.

const escapeHtml = s =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const PAGE_CSS = `/* Paradigm's landing design (paradigm-study-web, "A School of One"): paper and
   ink, a faint dot grid, the notebook window with three muted dots, mono
   eyebrows, a serif display face, warm shadows. Dark is ours: ink paper. */
:root {
  --ink:#011121; --ink-soft:#1b2430; --muted:#4b5563; --faint:#a19f9a; --line:#dde1e7; --step-line:#d9d9d9;
  --bg:#faf8f7; --surface:#fffdfc; --accent:#6e94cc; --accent-ink:#2c4a7b; --accent-wash:#e4ecf7;
  --rose:#dd7f77; --sand:#d2b99f; --sage:#799586; --good:#2e7d32; --grid:rgba(1,17,33,.05);
  --dot:#011121; --dot-ink:#fff;
  --shadow-md:0 4px 12px -6px rgba(82,66,50,.12), 0 1px 3px rgba(82,66,50,.05);
  --shadow-lg:0 14px 38px -18px rgba(82,66,50,.16), 0 3px 8px rgba(82,66,50,.05);
  --ease:cubic-bezier(.22,1,.36,1);
  --display:"Gowun Batang","Iowan Old Style",Georgia,serif;
  --body:"Geist",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root {
  --ink:#f3f1ee; --ink-soft:#d9dde3; --muted:#a3abb5; --faint:#7d8590; --line:#223247; --step-line:#2a3a50;
  --bg:#011121; --surface:#0b1726; --accent:#8fb0e0; --accent-ink:#b9cdeb; --accent-wash:#16263d;
  --good:#6fbf7a; --grid:rgba(255,255,255,.055); --dot:#ececec; --dot-ink:#011121;
  --shadow-md:0 4px 12px -6px rgba(0,0,0,.5); --shadow-lg:0 18px 44px -18px rgba(0,0,0,.7);
  color-scheme: dark;
} }
* { box-sizing:border-box; }
html, body { margin:0; }
body { min-height:100vh; font:15px/1.5 var(--body); color:var(--ink); background-color:var(--bg);
  background-image:radial-gradient(circle, var(--grid) 1px, transparent 1.4px); background-size:22px 22px;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
a { color:inherit; text-decoration:none; }
.wrap { max-width:1120px; margin:0 auto; padding:0 40px; }
.nav { display:flex; align-items:center; justify-content:space-between; padding-top:28px; }
.brand { display:inline-flex; align-items:center; gap:11px; }
.brand svg { width:26px; height:26px; } .brand svg path { fill:var(--ink); }
.brand .word { font-family:var(--display); font-weight:700; font-size:21px; letter-spacing:-.015em; }
.brand .sub { font-family:var(--mono); font-size:11.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint); margin-left:4px; }
.live { display:inline-flex; align-items:center; gap:8px; font-family:var(--mono); font-size:11.5px; font-weight:600; letter-spacing:.14em; color:var(--rose); }
.live i { width:7px; height:7px; border-radius:50%; background:var(--rose); animation:pulse 2s var(--ease) infinite; }
.live.ended { color:var(--faint); } .live.ended i { background:var(--faint); animation:none; }
@keyframes pulse { 0% { box-shadow:0 0 0 0 rgba(221,127,119,.55); } 80%,100% { box-shadow:0 0 0 8px rgba(221,127,119,0); } }
.hero { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.05fr); gap:56px; align-items:center; padding:64px 0 88px; }
.hero > * { min-width:0; }
.eyebrow { display:inline-block; font-family:var(--mono); font-size:12px; letter-spacing:.12em; text-transform:uppercase; font-weight:500;
  color:var(--accent-ink); background:var(--accent-wash); padding:6px 13px; border-radius:999px; margin-bottom:22px; }
h1 { font-family:var(--display); font-weight:400; font-size:46px; line-height:1.08; letter-spacing:.005em; margin:0 0 18px; overflow-wrap:anywhere; text-wrap:balance; }
.sub-copy { margin:0; font-size:16px; line-height:1.55; color:var(--muted); max-width:46ch; text-wrap:pretty; }
.note { display:flex; gap:9px; align-items:flex-start; margin:18px 0 0; max-width:46ch; font-size:14px; line-height:1.5; color:var(--ink-soft); text-wrap:pretty; }
.note svg { flex:none; width:15px; height:15px; margin-top:3px; color:var(--accent-ink); }
.people { display:flex; align-items:center; gap:14px; margin:26px 0 0; }
.dots { display:flex; gap:5px; }
.dot { position:relative; display:grid; place-items:center; width:30px; height:30px; border-radius:50%; background:var(--dot); color:var(--dot-ink);
  font-size:12px; font-weight:650; letter-spacing:.02em; transition:transform .2s var(--ease); }
.dot.two { font-size:10.5px; }
.dot.away { background:transparent; color:var(--dot); box-shadow:inset 0 0 0 1.5px var(--dot); }
@media (hover: hover) and (pointer: fine) { .dot:hover { transform:scale(1.06); } }
.dot[data-name]:hover::after { content:attr(data-name); position:absolute; bottom:calc(100% + 8px); left:50%; transform:translateX(-50%); white-space:nowrap;
  padding:3px 8px; border-radius:6px; background:var(--ink); color:var(--bg); font-size:11px; font-weight:500; pointer-events:none; }
.count { font-size:14px; color:var(--muted); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-variant-numeric:tabular-nums; } .count b { color:var(--ink); font-weight:600; }
.cta { display:flex; align-items:center; gap:22px; margin-top:30px; }
.btn-primary { display:inline-flex; align-items:center; gap:9px; min-height:46px; background:var(--ink); color:var(--bg); font:500 15px var(--body); padding:13px 24px; border:0;
  border-radius:.5rem; box-shadow:var(--shadow-md); cursor:pointer; transition:transform .14s var(--ease), opacity .14s ease; }
.btn-primary:active { transform:scale(.97); }
.btn-ghost { display:inline-flex; align-items:center; min-height:44px; font:500 15px var(--body); color:var(--accent-ink); background:none; border:0; padding:0 4px; margin:0 -4px; cursor:pointer; transition:opacity .14s ease; }
.btn-ghost:active { opacity:.5; }
@media (hover: hover) and (pointer: fine) {
  .btn-primary:hover { opacity:.9; }
  .btn-ghost:hover { opacity:.65; }
}
.btn-primary:disabled { opacity:.5; cursor:default; transform:none; }
:focus-visible { outline:2px solid var(--accent); outline-offset:3px; border-radius:6px; }
.status { min-height:20px; margin:14px 0 0; font-size:13px; color:var(--faint); }
/* the notebook window */
.window { position:relative; width:100%; max-width:520px; margin:0 0 0 auto; background:var(--surface); border:1px solid var(--line); border-radius:6px; box-shadow:var(--shadow-lg); }
.cat { position:absolute; top:-50px; right:26px; width:96px; height:66px; pointer-events:none; background:url("${CLOVER_WEBP}") center bottom / contain no-repeat; }
@media (prefers-color-scheme: dark) { .cat { filter:invert(1) opacity(.9); } }
.bar { display:flex; align-items:center; gap:8px; padding:13px 16px; border-bottom:1px solid var(--line); }
.bar .d { width:11px; height:11px; border-radius:50%; } .d.r { background:var(--rose); } .d.y { background:var(--sand); } .d.g { background:var(--sage); }
.bar .label { margin-left:8px; font-family:var(--mono); font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint); }
.bar .live { margin-left:auto; }
.main { padding:28px 30px 24px; display:flex; flex-direction:column; gap:12px; }
.step { display:flex; align-items:center; gap:13px; padding:15px 17px; border-radius:4px; background:var(--bg); border:1px solid var(--step-line); border-left-width:2px;
  font-size:14px; color:var(--ink-soft); animation:stepin .5s var(--ease) both; }
.step:nth-child(2) { animation-delay:.08s; } .step:nth-child(3) { animation-delay:.16s; } .step:nth-child(4) { animation-delay:.24s; }
@keyframes stepin { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
.step .ico { flex:none; width:16px; height:16px; color:var(--muted); }
.step.done { color:var(--ink); } .step.done .ico { color:var(--good); }
.step b { font-weight:600; color:var(--ink); }
.step.go { cursor:pointer; border-color:var(--accent); background:var(--accent-wash); color:var(--ink); transition:transform .14s var(--ease), box-shadow .18s ease; }
.step.go:active { transform:scale(.99); }
@media (hover: hover) and (pointer: fine) { .step.go:hover { box-shadow:var(--shadow-md); } }
.step.go .ico { color:var(--accent-ink); }
.composer { margin-top:4px; border:1px solid var(--line); border-radius:6px; background:var(--surface); padding:12px 14px; display:flex; align-items:center; gap:8px; }
.composer .slash { color:var(--faint); font-family:var(--mono); }
.composer code { flex:1; min-width:0; font:12.5px var(--mono); color:var(--ink-soft); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.composer button { flex:none; display:grid; place-items:center; width:36px; height:36px; margin:-9px -9px -9px 0; border:0; border-radius:6px; background:none; color:var(--muted); cursor:pointer; transition:color .15s ease, background-color .15s ease, transform .12s var(--ease); }
.composer button:active { transform:scale(.94); }
@media (hover: hover) and (pointer: fine) { .composer button:hover { color:var(--ink); background:var(--accent-wash); } }
.first { margin-top:6px; font-size:13px; color:var(--muted); }
.first summary { display:inline-block; padding:6px 0; cursor:pointer; list-style:none; color:var(--accent-ink); font-weight:500; }
.first summary::-webkit-details-marker { display:none; }
.first summary::before { content:"+ "; font-family:var(--mono); }
.first[open] summary::before { content:"– "; }
.first p { margin:8px 0; text-wrap:pretty; }
.first .composer { margin-top:0; }
.first code.inline { font:12.5px var(--mono); background:var(--accent-wash); color:var(--accent-ink); padding:1px 5px; border-radius:4px; }
.status a { color:var(--accent-ink); text-decoration:underline; text-underline-offset:2px; }
footer { padding:0 0 40px; color:var(--faint); font-size:13px; }
footer q { font-family:var(--display); font-size:17px; color:var(--muted); quotes:"\\201C" "\\201D"; }
[hidden] { display:none !important; }
@media (max-width: 880px) { .hero { grid-template-columns:minmax(0,1fr); gap:64px; padding:40px 0 64px; } .window { margin:0 auto; } h1 { font-size:36px; } }
@media (max-width: 480px) { .wrap { padding:0 18px; } h1 { font-size:30px; } .main { padding:22px 18px 18px; } .cta { gap:16px; flex-wrap:wrap; } .brand .sub { display:none; } }
@media (prefers-reduced-motion: reduce) { * { animation:none !important; transition:none !important; } }
`

export function landingPage(room, url, now, opts = {}) {
  const deepLink = `claude://code/new?q=${encodeURIComponent(url)}`
  const data = {
    id: room.id,
    url,
    deepLink,
    title: room.title,
    host: room.host.name,
    ended: Boolean(room.endedAt),
    people: room.people(now),
    team: room.team?.name ?? '',
  }
  const json = JSON.stringify(data)
  const membersOnly = room.team && opts.access === 'members'.replace(/</g, '\\u003c')
  const host = escapeHtml(room.host.name)
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${host} is sharing a Claude Code session</title>
<meta name="description" content="${escapeHtml(room.title)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Claude Code · Shared session">
<meta property="og:title" content="${host} is sharing a Claude Code session">
<meta property="og:description" content="${escapeHtml(room.title)} · Join from your own Claude Code and work in it together.">
<meta name="twitter:card" content="summary">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@500;600&family=Gowun+Batang:wght@400;700&display=swap" rel="stylesheet">
<style>
${PAGE_CSS}</style></head>
<body>
<header class="wrap nav">
  <a class="brand" href="#"><svg viewBox="0 0 500 500" aria-hidden="true">${LOGO_PATHS}</svg><span class="word">Paradigm</span><span class="sub">Shared session</span></a>
  <span class="live" id="pill"><i></i><span>LIVE</span></span>
</header>
<main class="wrap">
  <section class="hero">
    <div>
      <span class="eyebrow" id="eyebrow">${host} is sharing</span>
      <h1 id="title"></h1>
      <p class="sub-copy" id="subcopy">A live Claude Code session. Join from your own Claude Code: your prompts run in <span class="hn"></span>'s session, and everyone sees the replies as they stream.</p>
      ${membersOnly ? `<p class="note join"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><span>Only people in ${escapeHtml(room.team.name)} can join. In Claude Code, press <b>Team</b> above the prompt and sign in first.</span></p>` : ''}
      <div class="people"><div class="dots" id="dots"></div><div class="count" id="count"></div></div>
      <div class="cta" id="cta">
        <a class="btn-primary" id="open" href="#"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>Open in Claude Code</a>
        <button class="btn-ghost" id="copy">Copy link</button>
      </div>
      <p class="status" id="status"></p>
    </div>
    <div class="window">
      <div class="cat" aria-hidden="true"></div>
      <div class="bar"><span class="d r"></span><span class="d y"></span><span class="d g"></span><span class="label">claude code · shared</span><span class="live" id="pill2"><i></i><span>LIVE</span></span></div>
      <div class="main" id="steps">
        <div class="step done"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><span><b class="hn"></b> shared this session</span></div>
        <div class="step done" id="ended-step" hidden><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 12h7"/></svg><span>Sharing has ended. Ask <b class="hn"></b> for a new link</span></div>
        <a class="step go join" id="go" href="#"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg><span><b>Open in Claude Code.</b> A new session opens with this link in the prompt box</span></a>
        <div class="step join"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg><span><b>Press Enter</b> to join. The conversation so far plays back, then you're in it live</span></div>
        <div class="composer join"><span class="slash">/</span><code id="link"></code><button id="copy2" title="Copy link" aria-label="Copy link"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg></button></div>
        <details class="first join" id="first">
          <summary>First time? Install the plugin once</summary>
          <p>Paste this in a terminal, then start a new Claude Code session (or quit and reopen Claude Desktop). Needs Claude Code 2.1.286 or newer: <code class="inline">claude update</code>.</p>
          <div class="composer"><span class="slash">$</span><code id="install"></code><button id="copy3" title="Copy command" aria-label="Copy install command"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg></button></div>
          <p>In a terminal instead? Start <code class="inline">claude</code> and paste the link as your first message.</p>
        </details>
      </div>
    </div>
  </section>
</main>
<footer class="wrap"><q>Everyone in one session, Claude in the middle.</q></footer>
<script>
(function () {
  var data = ${json};
  var $ = function (id) { return document.getElementById(id); };
  // One initial, two for two words; two letters when single-word names share one.
  function labels(names) {
    var first = function (n) { return (n.trim()[0] || '?').toUpperCase(); }; var counts = {};
    names.forEach(function (n) { counts[first(n)] = (counts[first(n)] || 0) + 1; });
    var out = {}; names.forEach(function (n) { var w = n.trim().split(/[\\s._-]+/).filter(Boolean);
      out[n] = w.length >= 2 ? (w[0][0] + w[1][0]).toUpperCase() : counts[first(n)] > 1 ? first(n) + (w[0] || '').slice(1, 2).toLowerCase() : first(n); });
    return out;
  }
  var label = {};
  function dot(p) { var d = document.createElement('div'); var i = label[p.name] || p.name.slice(0, 1).toUpperCase(); d.className = 'dot' + (i.length > 1 ? ' two' : '') + (p.online ? '' : ' away'); d.textContent = i;
    d.setAttribute('data-name', p.name + (p.role === 'host' ? ' · host' : '') + (p.online ? '' : ' · away')); return d; }
  $('title').textContent = data.title;
  $('link').textContent = data.url;
  var INSTALL = 'claude plugin marketplace add Paradigm-Study/claude-share && claude plugin install shared-session@claude-share';
  $('install').textContent = INSTALL;
  $('copy3').addEventListener('click', function () { navigator.clipboard.writeText(INSTALL).then(function () { $('install').textContent = 'Copied. Paste it in a terminal.'; setTimeout(function () { $('install').textContent = INSTALL; }, 1800); }); });
  Array.prototype.forEach.call(document.querySelectorAll('.hn'), function (n) { n.textContent = data.host; });
  $('open').href = data.deepLink; $('go').href = data.deepLink;
  if (data.team) $('eyebrow').textContent = data.host + ' is sharing with ' + data.team;
  function render(d) {
    var seen = {}; var people = d.people.filter(function (p) { if (seen[p.name]) return false; seen[p.name] = 1; return true; });
    people.sort(function (a, b) { return (b.role === 'host') - (a.role === 'host') || b.online - a.online; });
    label = labels(people.map(function (p) { return p.name; }));
    var dots = $('dots'); dots.textContent = ''; people.slice(0, 8).forEach(function (p) { dots.appendChild(dot(p)); });
    var here = people.filter(function (p) { return p.online; });
    var count = $('count'); count.textContent = '';
    if (!here.length) { count.textContent = data.host + ' is away right now'; }
    else { var b = document.createElement('b'); b.textContent = here.length + ' here'; count.appendChild(b);
      count.appendChild(document.createTextNode(' · ' + here.map(function (p) { return p.name; }).join(', '))); }
    ['pill', 'pill2'].forEach(function (id) { $(id).classList.toggle('ended', d.ended); $(id).lastElementChild.textContent = d.ended ? 'ENDED' : 'LIVE'; });
    $('cta').hidden = d.ended; $('ended-step').hidden = !d.ended; document.querySelector('.people').hidden = d.ended;
    Array.prototype.forEach.call(document.querySelectorAll('.join'), function (n) { n.hidden = d.ended; });
    if (d.ended) { $('eyebrow').textContent = 'Sharing ended'; $('subcopy').textContent = 'This session is no longer shared. Ask ' + data.host + ' for a new link.'; }
  }
  render(data);
  // Refresh who's here only while someone is looking, and never after the end.
  var ended = data.ended;
  function refresh() {
    if (ended || document.visibilityState !== 'visible') return;
    fetch('/api/rooms/' + data.id, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) { ended = d.ended; render({ people: d.people, ended: d.ended }); } }).catch(function () {});
  }
  setInterval(refresh, 4000);
  document.addEventListener('visibilitychange', refresh);
  function copy() { navigator.clipboard.writeText(data.url).then(function () { $('copy').textContent = 'Copied'; setTimeout(function () { $('copy').textContent = 'Copy link'; }, 1600); }); }
  $('copy').addEventListener('click', copy); $('copy2').addEventListener('click', copy);
  // The app opening takes this window's focus. Still here after a moment: say what else works.
  var left = false;
  window.addEventListener('blur', function () { left = true; });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') left = true; });
  function opening() {
    left = false;
    $('status').textContent = 'Opening Claude… then press Enter in the new session.';
    setTimeout(function () {
      if (left) return;
      $('status').textContent = "Didn't open? You need the Claude desktop app, or start claude in a terminal and paste the link. First time? Install the plugin below.";
      $('first').open = true;
    }, 2500);
  }
  $('open').addEventListener('click', opening); $('go').addEventListener('click', opening);
  if (!data.ended && location.hash !== '#stay') {
    var key = 'opened:' + data.id; var already = false; try { already = sessionStorage.getItem(key) === '1'; sessionStorage.setItem(key, '1'); } catch (e) {}
    if (!already) setTimeout(function () { opening(); location.href = data.deepLink; }, 700);
  }
})();
</script>
</body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}
