import { TCP_LIMITS, SERVE_LIMITS } from './limits.ts'
import { utf8Length, token } from './http.ts'
import type { Room } from './room.ts'
import type { RevokeFilter, TCPStats } from './types.ts'

// What a revocation is matched against: a TCP half, a public pair, a browser session.
type Revocable = { pid?: string; ownerSeat?: string; session?: string }
// A TCP preview's target, as tcpSocketTarget admits it.
export type TCPTarget = { room: string; pid: string; port: number; ownerSeat: string }
type Credit = { n: number; nonce: string; at?: number }
// One half of a TCP channel, as both adapters keep it (tcpState).
export type TCPHalf = TCPTarget & {
  id: string
  side: string
  deadline: number
  ready: boolean
  fin: boolean
  credits: Credit[]
  remaining: number
  out: number
  read: number
  check: { nonce: string; at: number } | null
  rate: { start: number; data: number; control: number }
}
export type TCPFrame =
  | { t: 'data'; n: number; data: ArrayBuffer | ArrayBufferView }
  | { t: 'fin' }
  | { t: 'ack'; n: number; nonce: string }
  | { t: 'seen'; nonce: string }

// Whether a revocation covers a channel or a browser session: every field
// the filter names must match, and a filter naming none covers everything.
// TCP halves name their `pid` and `ownerSeat`; public pairs and browser
// sessions their cookie `session` and `ownerSeat` too.
export function revokeMatches(filter: RevokeFilter, s: Revocable) {
  return (!filter.pid || s.pid === filter.pid) &&
    (!filter.seat || s.ownerSeat === filter.seat) && (!filter.session || s.session === filter.session)
}

// How a public pair's browser half closes when its host half closed with
// `code`: one that vanished (no close frame) is a failure the page should
// see, 1011, as it sees an app over localhost fail. A browser that vanishes
// closes the app's half plainly (sendableClose). Clients keyed on wasClean
// (Vite) see any close frame as clean, 1011 included.
export const hostHalfClose = (code: number) => (code === 1006 || code === 1015 ? 1011 : sendableClose(code))

// How a TCP pair's other half closes when one closed with `code`: a TCP
// stream ends by its FINs (tcpRelay's `done`), so a half that closed plainly
// (1000) or vanished (1006) before them broke it, 1011.
export const tcpHalfClose = (code: number) => (code === 1000 || code === 1006 ? 1011 : sendableClose(code))

// TCP admission: new channels count against the room's minute of opens
// (kept with its counters) and each seat's share of it (in memory). Only a
// guest seat's own token, an Authorization bearer on the main server, opens
// a preview's data channel; a browser's cookie never does.
export function tcpAdmit(room: Room, now: number, seat?: string) {
  let w = room.tcpStats.opens
  if (!w || now - w.start >= TCP_LIMITS.openWindowMs) w = room.tcpStats.opens = { start: now, count: 0 }
  // One seat's share first: past it, a guest is turned away without spending
  // the room's minute, so one guest can't use up everyone's.
  if (seat) {
    let mine = room.tcpSeatOpens.get(seat)
    if (!mine || now - mine.start >= TCP_LIMITS.openWindowMs) room.tcpSeatOpens.set(seat, (mine = { start: now, count: 0 }))
    if (mine.count >= TCP_LIMITS.seatOpensPerMinute) return false
    mine.count += 1
  }
  w.count = Math.min(w.count + 1, TCP_LIMITS.opensPerMinute + 1)
  return w.count <= TCP_LIMITS.opensPerMinute
}

// Whether a seat is still this room's: here, or away within its grace list.
export function seatKnown(room: Room, seat: string) {
  if (seat === 'host') return true
  for (const s of room.seats.values()) if (s.id === seat) return true
  for (const s of room.away.values()) if (s.id === seat) return true
  return false
}

// A guest's TCP half comes with its seat's own token: a seat here, or away
// within its grace. It's looked up without seating anyone again, so
// admission writes nothing.
export function tcpSocketTarget(room: Room, req: Request, pid: string, now: number, active: { ownerSeat?: string }[] = []): ({ ok: true } & TCPTarget) | { ok: false; status: number; error: string } {
  const bearer = /^Bearer\s+([A-Za-z0-9_-]+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]
  const seat = bearer ? room.seats.get(bearer) ?? room.away.get(bearer) : null
  if (!seat) return { ok: false, status: 401, error: 'Not a guest of this session.' }
  const preview = room.previews.get(pid)
  if (!preview || room.endedAt) return { ok: false, status: 410, error: 'This TCP preview has ended.' }
  if (!preview.tcp) return { ok: false, status: 403, error: 'This preview opens through its link, not for forwarding.' }
  if (!room.connected('host')) return { ok: false, status: 503, error: 'The host is not connected.' }
  // Both adapters supply one live guest half per pending or paired channel.
  // A seat's ceiling covers all its previews.
  if (active.length >= TCP_LIMITS.roomPairs || active.filter(s => s.ownerSeat === seat.id).length >= TCP_LIMITS.seatPairs) return { ok: false, status: 429, error: 'Too many active TCP preview connections.' }
  if (!tcpAdmit(room, now, seat.id)) return { ok: false, status: 429, error: 'Too many TCP preview connections. Try again in a minute.' }
  return { ok: true, room: room.id, pid, port: preview.port, ownerSeat: seat.id }
}

export function announceTCP(room: Room, id: string, target: TCPTarget) {
  return room.toHost({ tcp: { id, pid: target.pid, port: target.port } })
}

// `out`: the control bytes sent to this half; `read`: how far it has proven
// it read them (chargeControl); `check`: the room's check it hasn't answered.
export function tcpState(id: string, target: TCPTarget, side: string, now: number): TCPHalf {
  return { id, room: target.room, pid: target.pid, port: target.port, ownerSeat: target.ownerSeat,
    side, deadline: now + TCP_LIMITS.pairMs, ready: false, fin: false, credits: [], remaining: 0, out: 0, read: 0, check: null,
    rate: { start: now, data: 0, control: 0 } }
}

// A pid's port never changes (a port shared again is a new preview), so the
// room, its seat still the room's and the preview still forwarded say it all.
export function tcpValid(room: Room, s: TCPHalf) {
  return !room.endedAt && s.room === room.id && seatKnown(room, s.ownerSeat) && room.previews.get(s.pid)?.tcp === true
}

// Reserve once per direction per MiB, persist BEFORE forwarding. Both counters
// only grow (`used` reserved, `refunded` given back), so a new connection,
// a reconnection or hibernation can't reset usage; what's spent is their difference.
export function tcpReserve(room: Room, s: TCPHalf) {
  if (room.tcpStats.used - (room.tcpStats.refunded ?? 0) + TCP_LIMITS.reserveBytes > TCP_LIMITS.roomBytes) return false
  room.tcpStats.used += TCP_LIMITS.reserveBytes
  s.remaining += TCP_LIMITS.reserveBytes
  return true
}

// A closing half gives back what it reserved and didn't carry, once: a room's
// budget pays for bytes, not for connections opened (a browser opens many).
export function tcpRefund(room: Room, s: TCPHalf | null | undefined) {
  const n = s?.remaining
  if (!s || !n || !(n > 0)) return 0
  s.remaining = 0
  room.tcpStats.refunded = (room.tcpStats.refunded ?? 0) + n
  return n
}

// What of a room's TCP counters is kept: the byte budget's two totals, and
// what its files and public link reserved today (`serveReserve`). Its minute
// of opens is memory's, as every other minute's is (a restart can let one
// minute count twice, no more), so no TCP connection waits on a write.
export const tcpCounted = (stats: Pick<TCPStats, 'used' | 'refunded' | 'served'>) => `${stats.used}/${stats.refunded ?? 0}/${stats.served ? `${stats.served.day}:${stats.served.reserved}` : ''}`

// Two copies of a room's TCP counters as one, whichever was saved later
// (overlapping writes, a separate file or key beside the room's snapshot):
// both totals only grow, and the later minute of opens wins (the same
// minute: the larger count), as does the later day served (the same day:
// the larger reservation).
export function mergeTCPStats(saved: TCPStats | null | undefined, current: TCPStats): TCPStats {
  const older = saved?.opens, opens = current.opens
  const minute = older && older.start > opens.start ? older : older?.start === opens.start ? { start: opens.start, count: Math.max(older.count, opens.count) } : opens
  const was = saved?.served, now = current.served
  const served = !was || (now && now.day > was.day) ? now : !now || was.day > now.day ? was : { day: now.day, reserved: Math.max(was.reserved, now.reserved) }
  return { used: Math.max(saved?.used ?? 0, current.used), refunded: Math.max(saved?.refunded ?? 0, current.refunded ?? 0), opens: minute, ...(served ? { served } : {}) }
}
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10)

// Whether `seat` may be sent `n` more bytes now; if so, they're counted.
export function serveReserve(room: Room, seat: string, n: number, now: number) {
  const day = utcDay(now)
  const reserved = room.tcpStats.served?.day === day ? room.tcpStats.served.reserved : 0
  // A new day, or this process's first look at it: all that was reserved counts as served.
  if (room.serving.day !== day) room.serving = { day, bytes: reserved }
  if (room.serving.bytes + n > SERVE_LIMITS.roomBytesPerDay) return false
  let minute = room.serveMinutes.get(seat)
  if (!minute || now - minute.start >= SERVE_LIMITS.periodMs) {
    // Seats come and go: only the ones served this past minute are kept.
    for (const [other, old] of room.serveMinutes) if (now - old.start >= SERVE_LIMITS.periodMs) room.serveMinutes.delete(other)
    room.serveMinutes.set(seat, (minute = { start: now, bytes: 0 }))
  }
  if (minute.bytes + n > SERVE_LIMITS.seatBytesPerMinute) return false
  minute.bytes += n
  room.serving.bytes += n
  if (room.serving.bytes > reserved) room.tcpStats.served = { day, reserved: Math.min(SERVE_LIMITS.roomBytesPerDay, Math.ceil(room.serving.bytes / SERVE_LIMITS.reserveBytes) * SERVE_LIMITS.reserveBytes) }
  return true
}

// Whether anything may still be sent to `seat` now (before asking the host).
export function serveLeft(room: Room, seat: string, now: number) {
  const day = utcDay(now), minute = room.serveMinutes.get(seat)
  const spent = room.serving.day === day ? room.serving.bytes : room.tcpStats.served?.day === day ? room.tcpStats.served.reserved : 0
  return spent < SERVE_LIMITS.roomBytesPerDay && !(minute && now - minute.start < SERVE_LIMITS.periodMs && minute.bytes >= SERVE_LIMITS.seatBytesPerMinute)
}

export const SERVED_ALL = 'This session has sent all it may for now. Try again in a minute, or tomorrow if it sent a lot today.'

export type TCPFailure = Error & { code: number }
export function tcpFailure(message: string, code = 1008): TCPFailure {
  return Object.assign(new Error(message), { code })
}

export function tcpFrame(message: unknown): TCPFrame {
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
  if (frame.t === 'seen' && keys === 'nonce,t' && typeof frame.nonce === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(frame.nonce)) return frame
  throw tcpFailure('Invalid TCP control type or fields.')
}

export function tcpCheck(from: TCPHalf, to: TCPHalf | null | undefined, frame: TCPFrame, now: number) {
  if (!from.ready || !to?.ready || from.id !== to.id || from.room !== to.room || from.pid !== to.pid || from.ownerSeat !== to.ownerSeat || from.side === to.side) throw tcpFailure('TCP channel is not paired.')
  const rate = now - from.rate.start >= TCP_LIMITS.rateWindowMs ? { start: now, data: 0, control: 0 } : { ...from.rate }
  const kind = frame.t === 'data' ? 'data' : 'control'
  // A limit reached, not a fault: 1013 (Try Again Later), which the helpers say as BUSY.
  if (++rate[kind] > (kind === 'data' ? TCP_LIMITS.dataPerWindow : TCP_LIMITS.controlPerWindow)) throw tcpFailure('TCP message rate exceeded.', 1013)
  if (frame.t === 'data') {
    if (from.fin) throw tcpFailure('TCP data after FIN.')
    if (to.credits.length >= TCP_LIMITS.creditFrames || to.credits.reduce((n, c) => n + c.n, frame.n) > TCP_LIMITS.creditBytes) throw tcpFailure('TCP credit window exceeded.')
  } else if (frame.t === 'ack') {
    // The challenge belongs to this receiver, not the other direction. FIFO
    // also keeps the helpers' application writes and returned credit ordered.
    const credit = from.credits[0]
    if (!credit || credit.n !== frame.n || credit.nonce !== frame.nonce) throw tcpFailure('Invalid TCP credit acknowledgement.')
  } else if (frame.t === 'seen') {
    // The answer to the one check out: its nonce, which only that check carried.
    if (!from.check || from.check.nonce !== frame.nonce) throw tcpFailure('Invalid TCP check answer.')
  } else if (from.fin) throw tcpFailure('Duplicate TCP FIN.')
  return rate
}

// What a half is sent besides data (ready, credit notices, forwarded acks,
// checks, fin) counts against TCP_LIMITS.bufferBytes until it has proven it
// read it: output the Worker can't see read. A half's messages arrive in
// order, so an ack (whose nonce only its credit notice carried) proves it
// read everything sent to it before that notice, and an answer to a check
// everything before the check (tcpRelay). A half that only sends data hears
// nothing but the acks it's forwarded, which nothing it sends answers, so it's
// asked for a check past TCP_LIMITS.checkBytes (checkOf), which its helper
// answers.
export function chargeControl(s: TCPHalf, control: unknown) {
  const text = JSON.stringify(control)
  const n = utf8Length(text)
  if (n > TCP_LIMITS.controlBytes || s.out - s.read + n > TCP_LIMITS.bufferBytes) throw tcpFailure('TCP unread control output limit exceeded.')
  s.out += n
  return text
}

// A check, once what a half hasn't proven it read passes
// TCP_LIMITS.checkBytes: one out at a time, its nonce the proof.
function checkOf(s: TCPHalf) {
  if (s.check || s.out - s.read < TCP_LIMITS.checkBytes) return []
  const nonce = token(16), text = chargeControl(s, { t: 'check', nonce })
  s.check = { nonce, at: s.out }
  return [text]
}

// One TCP message, either direction, for both adapters: the messages to send
// on, in order, or `{ reserve: true }` when the sender's budget must grow
// first. Then the adapter reserves (tcpReserve), makes that durable, checks
// the half again where it can have changed meanwhile, and steps the same frame
// again: nothing was charged or counted the first time.
export function tcpStep(room: Room, from: TCPHalf, to: TCPHalf | null | undefined, frame: TCPFrame, now: number): { reserve: true } | (TCPRelayed & { reserve?: undefined }) {
  if (!tcpValid(room, from)) throw tcpFailure('TCP access revoked.')
  tcpCheck(from, to, frame, now)
  // tcpCheck refuses a half without its peer.
  if (!to) throw tcpFailure('TCP channel is not paired.')
  if (frame.t === 'data' && from.remaining < frame.n) return { reserve: true }
  return tcpRelay(from, to, frame, now)
}

const creditNotice = (credit: Credit) => ({ t: 'credit', n: credit.n, nonce: credit.nonce })

// Mutate only bounded metadata, never retain application payload. The caller
// saves both halves' attachments before sending these messages in order.
// What one message comes to: what to send on, in order, and whether the channel is done.
export type TCPRelayed = { messages: (string | ArrayBuffer | ArrayBufferView)[]; done: boolean }
export function tcpRelay(from: TCPHalf, to: TCPHalf, frame: TCPFrame, now: number): TCPRelayed {
  from.rate = tcpCheck(from, to, frame, now)
  let messages: (string | ArrayBuffer | ArrayBufferView)[]
  if (frame.t === 'data') {
    if (from.remaining < frame.n) throw tcpFailure('TCP room byte budget exhausted.')
    const credit: Credit = { n: frame.n, nonce: token(16) }
    const notice = chargeControl(to, creditNotice(credit))
    // Its ack proves `to` read this far.
    credit.at = to.out
    from.remaining -= frame.n
    to.credits.push(credit)
    messages = [frame.data, notice]
  } else if (frame.t === 'ack') {
    // The nonce proves `from` read the notice it answers, and all before it.
    from.read = Math.max(from.read, from.credits.shift()?.at ?? 0)
    messages = [chargeControl(to, frame), ...checkOf(to)]
  } else if (frame.t === 'seen') {
    from.read = Math.max(from.read, from.check?.at ?? 0)
    from.check = null
    messages = []
  } else {
    const notice = chargeControl(to, frame)
    from.fin = true
    messages = [notice]
  }
  return { messages, done: from.fin && to.fin && !from.credits.length && !to.credits.length }
}

// A close code a socket may send on (the reserved ones become a plain close).
export const sendableClose = (code: unknown) => (typeof code === 'number' && Number.isInteger(code) && code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1000)
