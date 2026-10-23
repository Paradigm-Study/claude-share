import { utf8Length, token } from './http.mjs'
import {
  PAGE_BYTES_CAP,
  MAX_TEXT,
  BODY_DEPTH,
  EVENT_BYTES,
  Windows,
  ROOM_SEATS_MAX,
  SEAT_TIMEOUT_MS,
  LIVE_LIMIT,
  LIVE_BYTES,
  HISTORY_LIMIT,
  HISTORY_BYTES,
  SEAT_POLLS,
} from './limits.mjs'
import { cloudSummary } from './cloud.mjs'
import { revokeMatches } from './tcp.mjs'

const sizeOf = event => utf8Length(JSON.stringify(event)) + 1

// Events oldest first while they fit in `max` bytes (one at least).
export function pageOf(events, max) {
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
export function newestOf(events, max) {
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

export const maxOf = url => {
  const max = Number(url.searchParams.get('max'))
  return Number.isFinite(max) && max > 0 ? Math.min(Math.max(max, 64_000), PAGE_BYTES_CAP) : 0
}

// What each seat may post. `chat` is the room's side channel: people talk,
// Claude never reads it. `policy` is the host's say over what guests may do;
// `declined` answers a guest prompt the host's policy turned away. `react` is
// someone's reaction to one of Claude's replies, and `seen` the replies that
// came on someone's screen, each filed under the reply's key.
export const HOST_TYPES = new Set(['row', 'delta', 'turn', 'approval', 'title', 'policy', 'declined', 'chat', 'artifact', 'react', 'seen', 'ask'])
// `answer`: the cloud host's approver answering an `ask`; `set`: the approver
// changing the cloud host's settings, which the host's own Room changes at
// home. Both from the approver's seats alone.
export const GUEST_TYPES = new Set(['prompt', 'stop', 'chat', 'react', 'seen', 'answer', 'set'])
const REACTIONS = new Set(['👍', '🎉', '👀'])
const REPLY_KEY = /^[a-z0-9]{1,16}\.\d{1,5}$/

// A reaction or a seen list as the room keeps it, or null when it isn't one.
export function tidyMark(type, body) {
  if (type === 'react') {
    if (!REPLY_KEY.test(String(body?.key)) || !REACTIONS.has(body?.emoji)) return null
    return { key: body.key, emoji: body.emoji, on: body.on !== false }
  }
  const keys = Array.isArray(body?.keys) ? body.keys.filter(k => REPLY_KEY.test(String(k))).slice(0, 100) : []
  return keys.length ? { keys } : null
}
export const LIVE_TYPES = new Set(['delta'])

export const ROOM_ID = /^[A-Za-z0-9_-]{16,64}$/

// A person's name as the room keeps it: one line of 40 characters at most,
// never only dots. Teammates' plugins name a folder after it, where `..`
// would be its parent.
const clampName = name => {
  const text = String(name ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 40).trim()
  return text && !/^\.+$/.test(text) ? text : 'teammate'
}

// An event's body as the room keeps it: every string, at any depth, at most
// `chars` long, and nothing nested past BODY_DEPTH (null there).
export function clampBody(body, chars = MAX_TEXT) {
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
export const bodyBytes = body => utf8Length(JSON.stringify(body))

// Clamped, and past EVENT_BYTES cut further: its strings shorter until it
// fits, else a marker. A host's event is cut, never refused, so its outbox
// never sends one again and again; a guest's is refused first (the events
// route).
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
    // Hosted in the cloud (docs/cloud-host.md): { state, approver: { seat, account, name }, since, until }.
    this.cloud = data.cloud ?? null
    // Each word from its team's directory on whom it has now (`keepTeam`):
    // a join that waited meanwhile asks the team again (in memory alone).
    this.teamGen = 0
    this.seq = data.seq ?? 0
    this.events = data.events ?? []
    // Their bytes, kept as they come and go (a room loaded larger than its
    // bound is cut to it here, oldest first).
    this.eventBytes = this.events.reduce((n, e) => n + sizeOf(e), 0)
    this.trimEvents()
    this.liveBytes = 0
    this.seats = new Map(Object.entries(data.seats ?? {}))
    // Seats let go after their grace (a laptop asleep, a network gap), by
    // token: one that comes back is seated again as it was, so a plugin that
    // was only away isn't told the session ended. Leaving isn't kept here.
    this.away = new Map(Object.entries(data.away ?? {}))
    // Seats their person left from elsewhere (the Team panel's Leave), by
    // token → when: a session still using one hears it left (410), instead of
    // taking a new seat as it does when only let go. The newest hundred.
    this.leftElsewhere = new Map(Object.entries(data.leftElsewhere ?? {}))
    this.live = []
    this.posts = new Windows() // posts this minute, counted exactly here
    this.waiters = new Set()
    this.files = new Map(Object.entries(data.files ?? {})) // id → { id, name, type, size, ts }
    // Files going up now, by id → size: counted against the room's bound
    // before they land (`fileRoutes`), so uploads at once can't pass it
    // together. Memory only, as is how many are being read.
    this.filesPending = new Map()
    this.uploading = 0
    this.previews = new Map(Object.entries(data.previews ?? {})) // pid → { pid, port, title, ts, tcp? }
    // What preview links and cookies name the room by, never its id (which
    // joins it): a key made with the room and kept with it, or a Durable
    // Object's own id, which worker.mjs puts here.
    this.previewKey = data.previewKey ?? token(16)
    // A browser's session on the public link, sid → { pid, exp, seat }.
    this.previewSessions = new Map(Object.entries(data.previewSessions ?? {}))
    this.tcpStats = data.tcpStats ?? { used: 0, refunded: 0, opens: { start: 0, count: 0 } }
    // What files and the public link served today (`serveReserve`): counted
    // here, its reservation kept with the TCP budget (tcpStats.served), so a
    // room loaded again starts its day from all it reserved.
    this.serving = { day: '', bytes: 0 }
    // Each seat's minute of it, in memory only: seat id → { start, bytes }.
    this.serveMinutes = new Map()
    // Each seat's share of the room's minute of opens (kept in memory only: a
    // room that slept starts its seats afresh, its room-wide count does not).
    this.tcpSeatOpens = new Map()
    // Each guest seat's minute of asking the host for a port (`need`), in
    // memory only and never saved: seat id → { start, count }.
    this.needs = new Map()
    // The minute of messages each side sent the other's sessions (`peer`):
    // the host's and each guest seat's, in memory only and never saved:
    // 'host' or a seat id → { start, count }.
    this.peers = new Map()
    this.onTCPRevoke = null
    // Public sockets end with what let them in, by revokeMatches' filter: a
    // preview's Stop (pid), a Leave (seat), one browser session (session), or
    // the room (none).
    this.onPreviewRevoke = null
    // Links that open a preview in one browser, which may come back: kept with
    // the room, so one clicked after the room slept still opens, each until
    // TICKET_MS from its minting. ticket → { pid, exp, path, seat, used?, clear? }
    this.tickets = new Map(Object.entries(data.tickets ?? {}))
    // Each seat's minute of minting links, and the room's ('room'): in memory.
    this.mints = new Map()
    this.proxied = new Map() // in flight: request id → settle(Response), with the asking browser's .seat
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
      cloud: this.cloud ?? undefined,
      seq: this.seq,
      events: this.events,
      seats: Object.fromEntries(this.seats),
      away: this.away.size ? Object.fromEntries(this.away) : undefined,
      leftElsewhere: this.leftElsewhere.size ? Object.fromEntries(this.leftElsewhere) : undefined,
      files: Object.fromEntries(this.files),
      previews: Object.fromEntries(this.previews),
      previewKey: this.previewKey,
      previewSessions: Object.fromEntries(this.previewSessions),
      tickets: this.tickets.size ? Object.fromEntries(this.tickets) : undefined,
      tcpStats: this.tcpStats,
    }
  }

  // A message for the host's open streams only (a proxied preview request, a
  // socket or a TCP channel to relay, a guest's need). Returns whether anyone
  // got it.
  toHost(message) {
    return this.toSeat('host', message) === 'delivered'
  }

  // A message for one seat's open streams only, the host's ('host') or a
  // guest's (`peer`, a message between sessions). Never stored or broadcast.
  // `delivered`, or `offline`: no stream of that seat.
  toSeat(seat, message) {
    let sent = false
    for (const sub of this.subscribers) {
      if (sub.seat !== seat) continue
      sub.send(message)
      sent = true
    }
    return sent ? 'delivered' : 'offline'
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
    if (auth.role === 'host') {
      this.host.lastSeen = now
      // The cloud host's first word: it has the room.
      if (this.cloud?.state === 'starting') {
        this.cloud.state = 'running'
        this.append({ seat: 'host', name: this.host.name, role: 'host' }, 'cloud', { state: 'running' }, now)
      }
    }
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
    const host = { id: 'host', name: this.host.name, role: 'host', online, seats: ['host'], ...v(this.host.version), ...a(this.host.account), ...(this.cloud ? { cloud: true } : {}) }
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

  // What's shared now: every open preview, whether it's forwarded, its port
  // and title. The join answer and every page carry it, so a guest takes
  // what's shared from it alone. How one shows (its path, host, scheme,
  // what it's used by) stays the host's artifacts' to say.
  previewList() {
    return this.endedAt ? [] : [...this.previews.values()].map(p => ({ pid: p.pid, port: p.port, tcp: p.tcp === true, title: p.title }))
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

  // What a client is sent: everything after its cursor, and the room now:
  // who's here and what's shared.
  page(after, now) {
    return { seq: this.seq, events: this.since(after), people: this.people(now), previews: this.previewList(), ended: Boolean(this.endedAt), title: this.title, team: this.team?.name, cloud: cloudSummary(this) }
  }

  since(after) {
    const pick = list => list.filter(e => e.seq > after)
    return [...pick(this.events), ...pick(this.live)].sort((a, b) => a.seq - b.seq)
  }

  wait(after, ms, seat = '') {
    if (this.seq > after || this.endedAt) return Promise.resolve()
    // A seat's polls past SEAT_POLLS: the oldest is answered now.
    const mine = [...this.waiters].filter(w => w.seat === seat)
    for (const old of mine.slice(0, Math.max(0, mine.length - SEAT_POLLS + 1))) old.done()
    return new Promise(resolve => {
      const waiter = {
        after,
        seat,
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
      // A seat dropped for good takes its TCP connections and browsers with it.
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

  // Whether this guest seat is still the room's (here now; one away comes
  // back by its next request). A stream whose seat is gone hears no more.
  seated(id) {
    for (const seat of this.seats.values()) if (seat.id === id) return true
    return false
  }

  // A members-only team's people as the directory says they are now: a guest
  // whose account isn't one of them (they left the team or were removed, or
  // joined by link before it turned members-only) is let go, here or away,
  // with what it holds for previews. Returns whether anyone was.
  keepTeam(teamId, allowed, now) {
    if (this.team?.id !== teamId || this.endedAt) return false
    this.teamGen += 1
    const keep = new Set(allowed)
    let changed = false
    for (const [bearer, seat] of [...this.seats, ...this.away]) {
      if (seat.account && keep.has(seat.account)) continue
      this.leave(bearer, 'removed', now)
      changed = true
    }
    return changed
  }

  // Every seat of this account leaves, here and away, its tokens kept as
  // left; returns how many.
  leaveAccount(account, now) {
    const bearers = [...this.seats, ...this.away].filter(([, seat]) => seat.account === account).map(([bearer]) => bearer)
    for (const bearer of bearers) {
      this.leave(bearer, 'left', now)
      this.leftElsewhere.set(bearer, now)
    }
    for (const old of [...this.leftElsewhere.keys()].slice(0, Math.max(0, this.leftElsewhere.size - 100))) this.leftElsewhere.delete(old)
    return bearers.length
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

  // TCP connections close with what let them in (the adapters hold them): a
  // preview's Stop (pid), a Leave or a seat dropped for good (seat), or the
  // room's end. Presence grace never closes them. Nothing of them is kept.
  revokeTCP(filter = {}) {
    this.onTCPRevoke?.(filter)
  }

  // Browsers on the public link, by the same filters: a preview's Stop
  // (pid), a Leave or a seat dropped for good (seat), one browser session
  // (one too many for its seat or the room, or expired), or the whole room.
  // The adapters close the sockets they held. Links go with their preview,
  // their seat and the room: a link dies with the seat that made it.
  revokePublic(filter = {}) {
    let changed = false
    for (const [sid, s] of this.previewSessions) {
      if (!revokeMatches(filter, { pid: s.pid, ownerSeat: s.seat, session: sid })) continue
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

  // Everything a seat has open for previews: Leave, or a seat dropped for good.
  revokeSeat(seat) {
    this.revokeTCP({ seat })
    this.revokePublic({ seat })
  }

  // What expired goes (browser sessions, links), where requests and the
  // adapters' alarms already look, never on a timer of its own.
  sweepExpired(now) {
    let changed = false
    for (const [sid, s] of this.previewSessions) {
      if (s.exp > now) continue
      changed = this.revokePublic({ session: sid }) || changed
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
