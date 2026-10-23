export const HISTORY_LIMIT = 5000 // replayable events kept per room
// …and their bytes, serialized: past either, the oldest go first. A room's
// history is in memory whole (a Durable Object's isolate holds 128 MB, shared)
// and goes out whole to a stream that starts from nothing; the e2e's long
// session (5 MB, rows of 31.5 KB) fits three times over.
export const HISTORY_BYTES = 16 * 1024 * 1024
export const LIVE_LIMIT = 400 // ephemeral events (deltas) kept for pollers only
export const LIVE_BYTES = 2 * 1024 * 1024
export const SEAT_TIMEOUT_MS = 45_000 // a seat neither connected nor heard from for this long left
export const KEEPALIVE_MS = 10_000 // a line on every open stream: proxies keep it open, and a client soon tells a connection that died without a word from a quiet room
// Every stream ends itself after this long and the client reconnects at once.
// A client that is gone (asleep, unplugged) never comes back, so it leaves
// within this plus the seat's grace, whatever the connection seemed to say.
export const STREAM_MAX_MS = 5 * 60_000
// What one seat (the host's too) holds open at once: streams (a reconnect's
// old one, not noticed gone yet, among them) and long polls. One more takes
// the oldest's place: the oldest stream ends, the oldest poll is answered.
export const SEAT_STREAMS = 4
export const SEAT_POLLS = 4
// A stream (Node's) sends its events in pages of this many bytes at most, the
// next as its reader takes the last, and holds at most STREAM_UNREAD it
// hasn't taken: past that the reader isn't keeping up, and the stream ends
// with what it holds. Its client reconnects from its cursor; nothing is lost.
export const STREAM_PAGE = 512 * 1024
export const STREAM_UNREAD = 1024 * 1024
export const POLL_WAIT_MS = 20_000
export const MAX_TEXT = 32_000 // chars; any string in an event, at any depth
// One event's body, serialized. The plugin's largest is a row of 32,000
// characters cut from a reply in CJK (96 KB); a tool row's replay input is
// 16,000 characters of JSON. Nesting stops at BODY_DEPTH: JSON.stringify
// recurses, so a body nested deeper than the stack (JSON.parse takes it) would
// throw wherever the room is sent or saved.
export const EVENT_BYTES = 128 * 1024
export const BODY_DEPTH = 32
// Claude Code hands a plugin at most 4 MiB of a response body, in bytes (cut
// silently, measured: 1.4 million Chinese characters is all that comes
// through), and a long session's history is many times that. So a client
// that asks (`max`, bytes) gets events in pages of at most that size, oldest
// first, with `more` while there are others; one that can't page gets the
// newest events that fit, rather than a body cut mid-JSON.
export const PAGE_BYTES_CAP = 3_500_000
export const MAX_BODY = 512_000
// Files the host's Claude shows (a page, an image, a widget too big for an
// event): kept by the room, read with a member's token, gone with the room.
export const FILE_MAX = 10 * 1024 * 1024
export const ROOM_FILES_MAX = 100 * 1024 * 1024 // screenshots the host's Claude takes go up too
// Uploads a room reads at once, each up to FILE_MAX in memory: past it, 429.
export const FILE_UPLOADS = 4
// …and how many: each one's name and type are kept with the room (the Worker
// keeps them beside its bytes, under a key of their own). As many as 100 MB of
// 10 KB files: far past what a day of screenshots and attachments makes, and a
// bound on what tiny files could cost.
export const ROOM_FILES_COUNT = 10_240
export const ROOM_SEATS_MAX = 20 // people in one room besides the host
// Previews open at once (the plugin's Shown keeps as many), kept with the room too.
export const ROOM_PREVIEWS_MAX = 128
// Previews: a guest's browser asks the room, the room asks the host's stream,
// the host's plugin asks its own localhost and posts the answer back.
export const TICKET_MS = 10 * 60_000 // long enough to click from a transcript; one browser only
export const CLEAR_TICKET_MS = 60_000 // the second link after clearing another room's state: followed at once
export const PREVIEW_SESSION_MS = 12 * 60 * 60 * 1000
export const PROXY_TIMEOUT_MS = 30_000
export const PROXY_BODY_MAX = 1024 * 1024
export const PROXY_RESPONSE_MAX = 20 * 1024 * 1024
export const PROXY_HEAD_MAX = 64 * 1024 // a proxied answer's first line: its status and headers

// TCP previews use raw binary messages and a receiver-proven credit window.
// All resource ceilings live here; both transports enforce the same protocol.
export const TCP_LIMITS = Object.freeze({
  seatPairs: 32, roomPairs: 64, opensPerMinute: 1200, seatOpensPerMinute: 240, openWindowMs: 60_000,
  pairMs: 10_000, roomBytes: 1024 ** 3, reserveBytes: 1024 ** 2,
  dataBytes: 65_536, creditFrames: 4, creditBytes: 256 * 1024,
  controlBytes: 256, bufferBytes: 1024 ** 2, checkBytes: 16 * 1024, messageFragments: 4096,
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

// The JSON routes (create, join, events, invite, team) take MAX_BODY
// characters, counted as before; their bytes are bounded on the way in at
// three a character (no UTF-16 unit is more than three UTF-8 bytes), so
// nothing that fit before is refused.
export const JSON_BODY_MAX = 3 * MAX_BODY

export const BOUNDED_BODY = 16 * 1024

// What a public server limits, so a busy day stays affordable and one person
// can't flood it: rooms made and joins per network address, posts per room.
// Cloudflare counts with its rate-limit bindings (wrangler.toml); the Node
// server with an in-memory window of the same size.
export const LIMITS = {
  create: { limit: 6, periodMs: 60_000, message: 'Too many new shared sessions from your network. Try again in a minute.' },
  join: { limit: 30, periodMs: 60_000, message: 'Too many joins from your network. Try again in a minute.' },
  events: { limit: 900, periodMs: 60_000, message: 'This session is sending too fast; slowing down.' },
}
// New rooms one network address may make in a day, and the whole server: past
// the second, sharing waits for tomorrow (or another server), joining goes on.
export const ROOMS_PER_ADDRESS_DAY = 60
export const ROOMS_PER_DAY = 3000

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

export const CLOUD_MAX_MS = 7 * 24 * 60 * 60 * 1000
// The packed session (the project's files and the conversation): a request
// body Cloudflare passes on a workers.dev name.
export const CLOUD_BUNDLE_MAX = 95 * 1024 * 1024
export const CLOUD_CONFIG_MAX = 256 * 1024
export const CLOUD_CHANGES_MAX = 50 * 1024 * 1024

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

// Messages between a teammate's own sessions and the host's session. A
// teammate's joined session passes on what one of their sessions wrote to it,
// and receipts for what the host's session wrote back; the host's mailboxes'
// helper (relay/mailbox.cjs) passes on what the host's session wrote to a
// mailbox, and receipts for what was delivered into it. The room puts each on
// the other side's streams alone. Nothing is kept or put in history, and no
// one else hears it.
// Which session a message reaches is each side's to know, by its handle: the
// room sees only the handle.
//   POST peer (a guest) { handle, name, mode?, chain?, id, pid, body } → the
//     host's streams, as { peer: { seat, who, handle, name, mode, chain, id,
//     pid, body } }: `id` the sender's own message id (a receipt names it),
//     `pid` the guest's id for the turn it shows the message in
//   POST peer (a guest) { handle, status, ref, reason? } → the host's streams,
//     as { peer: { seat, handle, status, ref, reason } }: what became of the
//     host's message `ref` at the session it went to
//   POST peer (the host) { to, handle, body, ref } → that guest seat's
//     streams, as { peer: { handle, body, ref } }
//   POST peer (the host) { to, handle, status, id, reason? } → that guest
//     seat's streams, as { peer: { handle, status, id, reason } }: what became
//     of the message `id` at the host's session
// Seats and names are stamped here, never taken from a guest's body.
//   → { delivered: true }, or { delivered: false, reason: 'offline' }
// The host sends PEER_LIMIT.host a minute and each guest seat PEER_LIMIT.seat,
// counted in memory per room as needs are, before the body is read.
export const PEER_LIMIT = Object.freeze({ host: 120, seat: 60, periodMs: 60_000, bodyBytes: 128 * 1024, bodyChars: MAX_TEXT, chain: 32, nameChars: 80 })

// What a room's files and its previews' public link may send out: a room
// serves at most `roomBytesPerDay` a day (UTC) of the files it keeps and of
// the answers its host sends to guests' browsers, and one seat at most
// `seatBytesPerMinute` a minute of it, so someone in a room can't have it
// read and send the same bytes without end. The day's total is reserved
// `reserveBytes` at a time, each reservation kept (tcpStats.served) as the
// request that made it is answered: a file's before its bytes go, a preview
// answer's just after it's handed to its browser, so a restart can't reset
// the day, and misses one reservation at most. A seat's minute is memory's,
// as every other minute is. TCP previews have a budget of their own
// (TCP_LIMITS).
export const SERVE_LIMITS = Object.freeze({ roomBytesPerDay: 8 * 1024 ** 3, seatBytesPerMinute: 256 * 1024 ** 2, reserveBytes: 64 * 1024 ** 2, periodMs: 60_000 })
