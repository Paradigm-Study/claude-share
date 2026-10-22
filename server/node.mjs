// Zero-dependency Node server for shared Claude Code sessions.
//
//   PORT=8787 PUBLIC_URL=https://share.example.com DATA_FILE=./rooms.json node server/node.mjs
//
// PUBLIC_URL is optional: without it, links use the request's Host (and
// X-Forwarded-* behind a proxy or tunnel). DATA_FILE is optional: without it,
// rooms (and accounts and teams) live in memory only; with it, rooms' TCP
// counters are kept beside it, in DATA_FILE.tcp. Sign-in for teams:
// GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET, GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET
// (AUTH_TEST=1 adds a provider that signs in whoever the link names, for tests). Previews of a host's localhost are served on a
// second port (PREVIEW_PORT, default PORT + 1), a host name of their own so an
// app's root-relative paths work; PREVIEW_URL says how people reach it.

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { Readable } from 'node:stream'

import { Directory, mapStore, providersFrom, BODY_CHARS } from './teams.mjs'
import { Room, ROOM_ID, SEAT_TIMEOUT_MS, createRoom, roomRequest, previewRequest, previewRoomOf, notFound, json, publicOrigin, token, missingPage, previewMissing, previewTooLarge, homePage, outdatedClient, versionInfo, limitOf, limitedResponse, closedResponse, Windows, SOCKET_ID, previewSocketTarget, publicPairValid, hostHalfClose, tcpHalfClose, announceSocket, hostSocketAllowed, relayRejectCode, rejectReason, streamedRoomBody, bodyLimit, bodyTooLarge, PROXY_BODY_MAX, sendableClose, TCP_LIMITS, PUBLIC_LIMITS, revokeMatches, tcpSocketTarget, announceTCP, tcpState, tcpCounted, tcpValid, tcpReserve, tcpRefund, tcpFailure, tcpFrame, tcpStep, chargeControl, mergeTCPStats } from './core.mjs'

const PORT = Number(process.env.PORT ?? 8787)
const PUBLIC_URL = process.env.PUBLIC_URL
const DATA_FILE = process.env.DATA_FILE
// TCP admission and byte-budget counters move with every connection and must
// be durable before what they allow happens: a small file of their own,
// written then, rather than every room's whole snapshot each time.
const STATS_FILE = DATA_FILE ? `${DATA_FILE}.tcp` : ''
const ROOM_TTL_MS = 24 * 60 * 60 * 1000 // ended or abandoned rooms are dropped after a day
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT ?? PORT + 1)
const PREVIEW_URL = process.env.PREVIEW_URL

// Where previews are reached: PREVIEW_URL, else this request's host on PREVIEW_PORT.
function previewOrigin(req) {
  if (PREVIEW_URL) return PREVIEW_URL.replace(/\/+$/, '')
  const url = new URL(publicOrigin(req, PUBLIC_URL))
  return `${url.protocol}//${url.hostname}:${PREVIEW_PORT}`
}

const rooms = new Map()
// The same rooms by their preview key, which the preview port knows them by.
const previewRooms = new Map()
const directoryData = new Map() // accounts and teams (server/teams.mjs)

// When a stream closes, check again once its grace period is over: the seat
// may not come back, and everyone else should see that. A revocation closes
// the pairs it covers (revokeMatches: a TCP pair by its grant, a public one by
// its browser session, seat or preview).
function watch(room) {
  previewRooms.set(room.previewKey, room)
  room.onTCPRevoke = filter => {
    for (const [id, pair] of pairs) {
      if (pair.scope === 'tcp' && pair.roomId === room.id && revokeMatches(filter, pair.target)) closePair(id, pair, 1008, 'TCP grant revoked')
    }
  }
  room.onPreviewRevoke = filter => {
    for (const [id, pair] of pairs) {
      if (pair.scope === 'public' && pair.roomId === room.id && revokeMatches(filter, pair)) closePair(id, pair, 1008, 'Preview ended')
    }
  }
  room.onDisconnect = () => {
    setTimeout(() => {
      if (room.sweep(Date.now())) save()
      room.notify()
    }, SEAT_TIMEOUT_MS + 1000).unref()
  }
  return room
}

if (DATA_FILE) {
  try {
    const saved = JSON.parse(readFileSync(DATA_FILE, 'utf8'))
    for (const data of saved.rooms ?? []) rooms.set(data.id, watch(Room.resume(data, Date.now())))
    for (const [key, value] of Object.entries(saved.directory ?? {})) directoryData.set(key, value)
    console.log(`loaded ${rooms.size} rooms from ${DATA_FILE}`)
  } catch {}
  // Written on its own, the counters' file may be newer than the snapshot.
  try {
    for (const [id, stats] of Object.entries(JSON.parse(readFileSync(STATS_FILE, 'utf8')).rooms ?? {})) {
      const room = rooms.get(id)
      if (room) room.tcpStats = mergeTCPStats(stats, room.tcpStats)
    }
  } catch {}
}

// A debounced write that fails (a full disk, a snapshot past what one string
// holds) is said, not thrown: thrown in a timer, it would end the process and
// every room in it. One a request waits for still fails that request.
const later = (what, write) => () => {
  try { write() } catch (error) { console.error(`Couldn't save ${what}: ${error?.message ?? error}`) }
}

let saveTimer = null
function save(immediate = false) {
  if (!DATA_FILE) return
  const write = () => {
    saveTimer = null
    const tmp = `${DATA_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify({ rooms: [...rooms.values()].map(r => r.toJSON()), directory: Object.fromEntries(directoryData) }))
    renameSync(tmp, DATA_FILE)
  }
  // Forwarding approvals, revocations and grants are durable before their
  // answers, not after the ordinary room snapshot's half-second debounce.
  if (immediate) {
    clearTimeout(saveTimer)
    write()
  } else if (!saveTimer) saveTimer = setTimeout(later(DATA_FILE, write), 500)
}

// Every room's TCP byte budget, in its own small file: a reservation is
// written before the bytes it allows, a refund (budget given back) soon
// after, since a lost one only undercounts what's left. The minute of opens
// is memory's (tcpCounted), so no TCP connection waits on a write.
let statsTimer = null
function saveStats(immediate = false) {
  if (!STATS_FILE) return
  const write = () => {
    statsTimer = null
    const tmp = `${STATS_FILE}.tmp`
    const counted = [...rooms.values()].filter(r => r.tcpStats.used)
    writeFileSync(tmp, JSON.stringify({ rooms: Object.fromEntries(counted.map(r => [r.id, r.tcpStats])) }))
    renameSync(tmp, STATS_FILE)
  }
  if (immediate) {
    clearTimeout(statsTimer)
    write()
  } else if (!statsTimer) statsTimer = setTimeout(later(STATS_FILE, write), 500)
}

// Seats are settled by requests (see roomRequest); this only drops rooms a day
// after their host was last seen.
setInterval(() => {
  const now = Date.now()
  let changed = false
  for (const room of rooms.values()) {
    const lastActive = !room.endedAt && room.connected('host') ? now : Math.max(room.host.lastSeen, room.endedAt ?? 0)
    if (now - lastActive > ROOM_TTL_MS) {
      room.revokeTCP()
      room.revokePublic()
      rooms.delete(room.id)
      previewRooms.delete(room.previewKey)
      changed = true
    }
  }
  if (changed) {
    save()
    saveStats()
  }
}, 60_000).unref()

const windows = new Windows()
const clientIp = req => req.headers.get('x-client-ip') ?? 'unknown'

// What a team's list shows of a room: what its own info says.
const roomInfoOf = async id => {
  const room = rooms.get(id)
  if (!room) return null
  return { title: room.title, people: room.people(Date.now()), ended: Boolean(room.endedAt) }
}
const directory = new Directory(mapStore(directoryData, () => save()), { providers: providersFrom(process.env), roomInfo: roomInfoOf })

async function route(req) {
  const url = new URL(req.url)
  const origin = publicOrigin(req, PUBLIC_URL)
  const now = Date.now()
  const parts = url.pathname.split('/').filter(Boolean)

  if (url.pathname === '/api/health') return json({ ok: true, rooms: rooms.size })
  if (url.pathname === '/api/version') return versionInfo()
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/privacy')) return homePage(origin)
  if (Directory.owns(url.pathname)) {
    if (Directory.limited(url.pathname, req.method) && !windows.hit('join', `a:${clientIp(req)}`, now)) return limitedResponse('join')
    return directory.handle(req, origin, now)
  }

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const outdated = outdatedClient(req)
    if (outdated) return outdated
    if (process.env.NEW_ROOMS === 'off') return closedResponse()
    if (!windows.hit('create', `c:${clientIp(req)}`, now)) return limitedResponse('create')
    const { room, response } = await createRoom(req, token(16), now, origin, { directory })
    if (!room) return response
    rooms.set(room.id, watch(room))
    save()
    return response
  }

  // /s/:id → landing page; /api/rooms/:id[/rest] → room API
  let id
  let rest
  if (parts[0] === 's' && parts.length === 2) {
    id = parts[1]
    rest = 'page'
  } else if (parts[0] === 'api' && parts[1] === 'rooms' && parts.length >= 3) {
    id = parts[2]
    rest = parts.slice(3).join('/')
  } else if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'rooms' && parts.length === 5 && parts[4] === 'end') {
    id = parts[3]
    rest = 'admin-end'
  } else {
    return notFound()
  }
  const limit = limitOf(req, id, rest, clientIp(req))
  if (limit && !windows.hit(limit.kind, limit.key, now)) return limitedResponse(limit.kind)

  const room = ROOM_ID.test(id) ? rooms.get(id) : undefined
  if (!room) {
    return rest === 'page'
      ? missingPage()
      : json({ error: 'This shared session does not exist.' }, 404)
  }

  const reject = /^ws\/([^/]+)\/reject$/.exec(rest)
  if (req.method === 'POST' && reject) return rejectRelay(room, req, reject[1])

  const admin = Boolean(process.env.ADMIN_TOKEN) && req.headers.get('authorization') === `Bearer ${process.env.ADMIN_TOKEN}`
  const counters = tcpCounted(room.tcpStats)
  const { response, changed } = await roomRequest(room, req, rest, now, origin, { previewOrigin: previewOrigin(req), admin, directory, isCurrent: () => rooms.get(id) === room })
  // Forwarding approvals and revocations are durable before a successful
  // response, just as a newly minted TCP grant is.
  if (changed) save(/^previews(?:$|\/[^/]+\/(?:end|tunnel)$)/.test(rest) || rest === 'end' || rest === 'admin-end')
  // The byte budget changed without the room (a revocation's refund): only the counters.
  if (tcpCounted(room.tcpStats) !== counters) saveStats(true)
  return response
}

// The room a preview request names by its preview key, never by its id.
const previewRoomFor = req => {
  const key = previewRoomOf(req)
  return key && ROOM_ID.test(key) ? previewRooms.get(key) : undefined
}

async function previewRoute(req) {
  const room = previewRoomFor(req)
  if (!room) return previewMissing()
  const { response, changed } = await previewRequest(room, req, Date.now(), { secure: new URL(previewOrigin(req)).protocol === 'https:' })
  if (changed) save()
  return response
}

function headersOf(nodeReq) {
  const headers = new Headers()
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v)
    else if (Array.isArray(v)) headers.set(k, v.join(', '))
  }
  return headers
}

// What Node takes of a body it buffers, per route, counted as the bytes
// arrive; past it, a 413 and nothing routed: a preview request's
// PROXY_BODY_MAX, the directory's characters at three bytes each, a file's or
// a JSON route's bound (bodyLimit). Streamed routes bound themselves.
const bodyMax = (handle, pathname) => (handle === previewRoute ? PROXY_BODY_MAX : Directory.owns(pathname) ? 3 * BODY_CHARS : bodyLimit(pathname))

// A request's body up to `max` bytes as it arrives; null past it (the rest is
// left unread, and its connection closes after the answer).
function bufferBody(nodeReq, max) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const off = () => nodeReq.off('data', data).off('end', end).off('error', fail)
    const data = chunk => {
      size += chunk.length
      if (size <= max) return void chunks.push(chunk)
      off()
      nodeReq.pause()
      resolve(null)
    }
    const end = () => { off(); resolve(Buffer.concat(chunks)) }
    const fail = error => { off(); reject(error) }
    nodeReq.on('data', data).on('end', end).on('error', fail)
  })
}

const serve = handle => async (nodeReq, nodeRes) => {
  try {
    const url = `http://${nodeReq.headers.host ?? 'localhost'}${nodeReq.url}`
    const { pathname } = new URL(url)
    const parts = pathname.split('/').filter(Boolean)
    // A request that says it carries no body has none to read or bound, and
    // keeps its connection however its route reads.
    const bodyless = nodeReq.method === 'GET' || nodeReq.method === 'HEAD' || (!nodeReq.headers['transfer-encoding'] && !(Number(nodeReq.headers['content-length']) > 0))
    const streamed = !bodyless && handle === route && parts[0] === 'api' && parts[1] === 'rooms' && streamedRoomBody(nodeReq.method, parts.slice(3).join('/'))
    let body
    // Preview shares/grants/links, needs, proxied answers and host relay
    // rejection authenticate first and bound bytes as they arrive (core's
    // readBody), before any outer buffer.
    if (streamed) body = Readable.toWeb(nodeReq, { strategy: { highWaterMark: 0 } })
    else if (!bodyless) {
      const max = bodyMax(handle, pathname)
      // A declared length past the bound is refused before any of it arrives.
      body = Number(nodeReq.headers['content-length']) > max ? null : await bufferBody(nodeReq, max)
      if (!body) {
        const refused = handle === previewRoute ? previewTooLarge() : bodyTooLarge(max)
        nodeRes.writeHead(413, { ...Object.fromEntries(refused.headers), connection: 'close' })
        return nodeRes.end(Buffer.from(await refused.arrayBuffer()))
      }
    }
    const headers = headersOf(nodeReq)
    // Who asked, for the limits: the socket's address (behind a proxy, set
    // TRUST_PROXY=1 to use its X-Forwarded-For).
    const forwarded = process.env.TRUST_PROXY === '1' ? String(nodeReq.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : ''
    headers.set('x-client-ip', forwarded || nodeReq.socket.remoteAddress || 'unknown')
    const req = new Request(url, {
      method: nodeReq.method,
      headers,
      body: bodyless ? undefined : body,
      ...(streamed ? { duplex: 'half' } : {}),
    })
    const res = await handle(req)
    const out = Object.fromEntries([...res.headers].filter(([k]) => k !== 'set-cookie'))
    if (streamed && !nodeReq.readableEnded) out.connection = 'close' // don't drain an unauthorized/oversized body
    const cookies = res.headers.getSetCookie?.() ?? []
    if (cookies.length) out['set-cookie'] = cookies
    nodeRes.writeHead(res.status, out)
    if (!res.body) return nodeRes.end()
    // Pass the body through as it comes: a stream stays open until either side
    // closes it.
    const reader = res.body.getReader()
    nodeRes.on('close', () => reader.cancel().catch(() => {}))
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      nodeRes.write(value)
    }
    nodeRes.end()
  } catch (error) {
    nodeRes.writeHead(500, { 'content-type': 'application/json' })
    nodeRes.end(JSON.stringify({ error: String(error?.message ?? error) }))
  }
}

const server = createServer(serve(route))
server.requestTimeout = 60_000
server.listen(PORT, () => console.log(`shared sessions on http://localhost:${PORT}`))

const previews = createServer(serve(previewRoute))
previews.requestTimeout = 60_000
previews.listen(PREVIEW_PORT, () => console.log(`previews on http://localhost:${PREVIEW_PORT}`))

// WebSockets through a preview (see core.mjs): a guest's browser socket on
// the preview port, the host's relay for it on the main one, paired by id.
// Each pair's two sockets are `guestWs` (the guest's browser, or its TCP
// helper's tunnel) and `hostWs` (the host's relay); a TCP pair's protocol
// states are `guest` and `host`.
const pairs = new Map() // id → room/pid/purpose-bound public or TCP pair
// What a room's browser sockets waiting for the host hold, together: one
// room's waiting can't fill the process (PUBLIC_LIMITS.pendingBytes).
const waiting = new Map() // room id → bytes

const unqueue = pair => {
  const left = (waiting.get(pair.roomId) ?? 0) - pair.pendingBytes
  if (left > 0) waiting.set(pair.roomId, left)
  else waiting.delete(pair.roomId)
  pair.pending.length = 0
  pair.pendingBytes = 0
}

const refuse = (socket, status, error = '') => {
  const body = error ? JSON.stringify({ error }) : ''
  socket.end(`HTTP/1.1 ${status} Refused\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

// An upgrade's handler, guarded. Node takes its own error listener off a
// socket it hands over, so one goes on first: a client resetting a refused
// socket would otherwise end the process, every room in it. A throw (a
// header Fetch won't take) refuses the socket rather than reach the process.
const upgrading = handle => (nodeReq, socket, head) => {
  socket.on('error', () => socket.destroy())
  try { handle(nodeReq, socket, head) } catch { if (!socket.destroyed && !socket.writableEnded) refuse(socket, 400) }
}

function closePair(id, pair, code = 1011, reason = '') {
  if (pairs.get(id) !== pair) return
  pairs.delete(id)
  clearTimeout(pair.timer)
  if (pair.pending) unqueue(pair)
  // What each half reserved and didn't carry goes back to the room's budget.
  const room = pair.scope === 'tcp' ? rooms.get(pair.roomId) : null
  if (room && tcpRefund(room, pair.guest) + tcpRefund(room, pair.host) > 0) saveStats()
  pair.guestWs?.close(code, reason)
  pair.hostWs?.close(code, reason)
}

// A room's live pairs of one purpose, pending or paired: what admission counts.
const pairsOf = (room, scope) => [...pairs.values()].filter(p => p.roomId === room.id && p.scope === scope)

// The host turning away a socket it was asked to relay, TCP (its worker busy,
// the port refusing) or public (more relays than it runs, the port refusing),
// while it waits for its host half: never one already paired.
async function rejectRelay(room, req, id) {
  const pair = SOCKET_ID.test(id) ? pairs.get(id) : null
  const check = () => {
    if (rooms.get(room.id) !== room) return notFound()
    if (!hostSocketAllowed(room, req)) return json({ error: 'Only the host rejects a relay.' }, 401)
    if (!pair || pairs.get(id) !== pair || pair.roomId !== room.id) return notFound()
    if (pair.hostWs || pair.host || pair.guest?.ready) return json({ error: 'That socket already has a host relay.' }, 409)
    return null
  }
  const before = check()
  if (before) return before
  const code = await relayRejectCode(req)
  // Pairing can win while the body arrives. No await between this check/close.
  const after = check()
  if (after) return after
  if (!code) return json({ error: 'Expected exactly a BUSY or CONNECT code.' }, 400)
  closePair(id, pair, code, rejectReason(pair.scope === 'tcp' ? 'TCP' : 'Preview', code))
  return json({ ok: true })
}

function armTCP(id, pair) {
  clearTimeout(pair.timer)
  const due = pair.guest.ready ? pair.target.exp : Math.min(pair.target.exp, pair.guest.deadline)
  pair.timer = setTimeout(() => {
    const room = rooms.get(pair.roomId)
    if (room?.sweepGrants(Date.now())) save()
    closePair(id, pair, 1008, pair.guest.ready ? 'TCP grant expired' : 'TCP relay timeout')
  }, Math.max(0, due - Date.now())).unref()
}

// A public pair ends with its browser session, and, like a TCP one, when the
// host hasn't taken it up within PUBLIC_LIMITS.pairMs: no browser holds a
// socket and its queue open for a relay that never comes.
function armPublic(id, pair) {
  clearTimeout(pair.timer)
  const due = pair.hostWs ? pair.exp : Math.min(pair.exp, pair.deadline)
  pair.timer = setTimeout(() => {
    const room = rooms.get(pair.roomId)
    if (room?.sweepGrants(Date.now())) save()
    closePair(id, pair, pair.hostWs ? 1008 : 1011, pair.hostWs ? 'Preview session expired' : 'Preview relay timeout')
  }, Math.max(0, due - Date.now())).unref()
}

function tcpMessage(id, pair, side, message) {
  if (pairs.get(id) !== pair) return
  try {
    const room = rooms.get(pair.roomId)
    if (!room) throw tcpFailure('TCP grant revoked.')
    const from = side === 'guest' ? pair.guest : pair.host
    const to = side === 'guest' ? pair.host : pair.guest
    const frame = tcpFrame(message)
    let step = tcpStep(room, from, to, frame, Date.now())
    if (step.reserve) {
      if (!tcpReserve(room, from)) throw tcpFailure('TCP room byte budget exhausted.')
      saveStats(true) // durable before the bytes it pays for go on
      step = tcpStep(room, from, to, frame, Date.now())
      if (step.reserve) throw tcpFailure('TCP room byte budget exhausted.')
    }
    const peer = side === 'guest' ? pair.hostWs : pair.guestWs
    for (const data of step.messages) if (!peer?.send(data)) throw tcpFailure('TCP socket send failed.', 1011)
    if (step.done) closePair(id, pair, 1000, 'TCP finished')
  } catch (error) {
    closePair(id, pair, error.code ?? 1011, error.message)
  }
}

// Whether a public pair may go on (core's publicPairValid); closed if not.
function publicValid(id, pair) {
  if (pairs.get(id) !== pair) return false
  if (publicPairValid(rooms.get(pair.roomId), pair, Date.now())) return true
  closePair(id, pair, 1008, 'Preview ended')
  return false
}

previews.on('upgrade', upgrading((nodeReq, socket, head) => {
  if (!validHandshake(nodeReq)) return refuse(socket, 400)
  // Only its path, query and cookie are read: a fixed host, never the
  // request's own (one the URL parser refuses would throw).
  const req = new Request(`http://preview.local${nodeReq.url}`, { headers: headersOf(nodeReq) })
  const room = previewRoomFor(req)
  const target = room ? previewSocketTarget(room, req, Date.now(), pairsOf(room, 'public')) : { ok: false, status: 404 }
  if (!target.ok) return refuse(socket, target.status, target.error)
  const wsId = token(12)
  if (!announceSocket(room, wsId, target)) return refuse(socket, 503)
  const pair = { roomId: room.id, pid: target.pid, scope: 'public', session: target.session, ownerSeat: target.ownerSeat, exp: target.exp,
    deadline: Date.now() + PUBLIC_LIMITS.pairMs, guestWs: null, hostWs: null, pending: [], pendingBytes: 0 }
  pairs.set(wsId, pair)
  pair.guestWs = acceptSocket(nodeReq, socket, head, target.protocols[0], {
    message: data => {
      if (!publicValid(wsId, pair)) return
      if (pair.hostWs) return pair.hostWs.send(data)
      const n = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
      const held = waiting.get(pair.roomId) ?? 0
      if (pair.pending.length >= PUBLIC_LIMITS.queueMessages || pair.pendingBytes + n > PUBLIC_LIMITS.queueBytes || held + n > PUBLIC_LIMITS.pendingBytes) return closePair(wsId, pair, 1009, 'Preview queue limit')
      pair.pending.push(data)
      pair.pendingBytes += n
      waiting.set(pair.roomId, held + n)
    },
    close: code => closePair(wsId, pair, code),
  })
  armPublic(wsId, pair)
}))

server.on('upgrade', upgrading((nodeReq, socket, head) => {
  if (!validHandshake(nodeReq)) return refuse(socket, 400)
  const path = String(nodeReq.url).split('?')[0]
  const tunnel = /^\/api\/rooms\/([^/]+)\/previews\/([^/]+)\/tunnel$/.exec(path)
  const req = new Request(`http://localhost${nodeReq.url}`, { headers: headersOf(nodeReq) })
  if (tunnel) {
    const room = ROOM_ID.test(tunnel[1]) ? rooms.get(tunnel[1]) : null
    if (!room) return refuse(socket, 404)
    const target = tcpSocketTarget(room, req, tunnel[2], Date.now(), pairsOf(room, 'tcp').map(p => p.target))
    if (!target.ok) return refuse(socket, target.status, target.error)
    const id = token(12)
    const pair = { roomId: room.id, pid: target.pid, scope: 'tcp', target, guest: tcpState(id, target, 'guest', Date.now()), host: null, guestWs: null, hostWs: null }
    pairs.set(id, pair)
    if (!announceTCP(room, id, target)) {
      pairs.delete(id)
      return refuse(socket, 503, 'The TCP host disconnected.')
    }
    pair.guestWs = acceptSocket(nodeReq, socket, head, '', { tcp: true,
      message: data => tcpMessage(id, pair, 'guest', data),
      close: code => closePair(id, pair, tcpHalfClose(code), 'TCP socket closed'),
    })
    armTCP(id, pair)
    return
  }
  const m = /^\/api\/rooms\/([^/]+)\/ws\/([^/]+)$/.exec(path)
  const room = m && ROOM_ID.test(m[1]) ? rooms.get(m[1]) : undefined
  const pair = m && SOCKET_ID.test(m[2]) ? pairs.get(m[2]) : undefined
  if (!room || !hostSocketAllowed(room, req)) return refuse(socket, 401)
  if (!pair || pair.roomId !== room.id) return refuse(socket, 404)
  if (pair.hostWs) return refuse(socket, 409, 'That socket already has a host relay.')
  if (pair.scope === 'tcp') {
    if (!tcpValid(room, pair.guest, Date.now()) || Date.now() >= pair.guest.deadline) {
      closePair(m[2], pair, 1008, 'TCP grant expired or relay timed out')
      return refuse(socket, 410)
    }
    pair.host = tcpState(m[2], pair.target, 'host', Date.now())
    pair.hostWs = acceptSocket(nodeReq, socket, head, '', { tcp: true,
      message: data => tcpMessage(m[2], pair, 'host', data),
      close: code => closePair(m[2], pair, tcpHalfClose(code), 'TCP socket closed'),
    })
    try {
      pair.guest.ready = pair.host.ready = true
      if (!pair.guestWs.send(chargeControl(pair.guest, { t: 'ready' })) || !pair.hostWs.send(chargeControl(pair.host, { t: 'ready' }))) throw tcpFailure('TCP ready send failed.', 1011)
      armTCP(m[2], pair)
    } catch (error) { closePair(m[2], pair, error.code ?? 1011, error.message) }
  } else {
    // The host's half may come a while after its browser was announced, but
    // not after the pairing deadline (its timer closes the pair then).
    if (Date.now() >= pair.deadline) {
      closePair(m[2], pair, 1011, 'Preview relay timeout')
      return refuse(socket, 410)
    }
    if (!publicValid(m[2], pair)) return refuse(socket, 410)
    pair.hostWs = acceptSocket(nodeReq, socket, head, '', {
      message: data => { if (publicValid(m[2], pair)) pair.guestWs?.send(data) },
      // A host half that vanished (no close frame) is a failure the page sees.
      close: code => closePair(m[2], pair, hostHalfClose(code)),
    })
    for (const data of pair.pending) pair.hostWs.send(data)
    unqueue(pair)
    armPublic(m[2], pair)
  }
}))

function validHandshake(req) {
  const key = req.headers['sec-websocket-key']
  return req.method === 'GET' && String(req.headers.upgrade ?? '').toLowerCase() === 'websocket' && String(req.headers.connection ?? '').toLowerCase().split(/\s*,\s*/).includes('upgrade') && req.headers['sec-websocket-version'] === '13' && typeof key === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(key) && Buffer.from(key, 'base64').length === 16 && Buffer.from(key, 'base64').toString('base64') === key
}

// Stdlib RFC 6455 server. Bound fragments/parser/output, reject invalid frames,
// and drain a bounded queue after write(false); never drop application bytes.
function acceptSocket(nodeReq, socket, head, protocol, on) {
  const accept = createHash('sha1').update(`${nodeReq.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write(['HTTP/1.1 101 Switching Protocols', 'upgrade: websocket', 'connection: Upgrade', `sec-websocket-accept: ${accept}`, ...(protocol ? [`sec-websocket-protocol: ${protocol}`] : []), '', ''].join('\r\n'))
  const frame = (op, payload) => {
    const n = payload.length
    const h = Buffer.alloc(n < 126 ? 2 : n < 65536 ? 4 : 10)
    h[0] = 0x80 | op
    h[1] = n < 126 ? n : n < 65536 ? 126 : 127
    if (h.length === 4) h.writeUInt16BE(n, 2)
    if (h.length === 10) h.writeBigUInt64BE(BigInt(n), 2)
    return Buffer.concat([h, payload])
  }
  let closed = false, blocked = false, queuedBytes = 0
  const queue = []
  const enqueue = bytes => {
    if (socket.destroyed || queuedBytes + socket.writableLength + bytes.length > TCP_LIMITS.bufferBytes) return false
    if (blocked) {
      queue.push(bytes)
      queuedBytes += bytes.length
    } else blocked = !socket.write(bytes)
    return true
  }
  const close = (code = 1000, reason = '') => {
    if (closed) return
    closed = true
    const why = Buffer.from(String(reason).replace(/[^\x20-\x7e]/g, '?').slice(0, 100))
    const p = Buffer.alloc(2 + why.length)
    p.writeUInt16BE(sendableClose(code))
    why.copy(p, 2)
    if (!enqueue(frame(8, p))) socket.destroy()
    else if (!queue.length) socket.end()
    setTimeout(() => socket.destroy(), TCP_LIMITS.closeMs).unref()
    on.close(code)
  }
  socket.on('drain', () => {
    blocked = false
    while (queue.length && !blocked && !socket.destroyed) {
      const bytes = queue.shift()
      queuedBytes -= bytes.length
      blocked = !socket.write(bytes)
    }
    if (closed && !queue.length) socket.end()
  })
  let buf = Buffer.alloc(0), parts = [], partOp = 0, partBytes = 0, partCount = 0
  let wire = { start: Date.now(), count: 0 }
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  const maxFor = op => on.tcp ? (op === 1 ? TCP_LIMITS.controlBytes : TCP_LIMITS.dataBytes) : TCP_LIMITS.bufferBytes
  const read = () => {
    try {
      while (!closed && buf.length >= 2) {
        const fin = Boolean(buf[0] & 0x80), op = buf[0] & 15
        if ((buf[0] & 0x70) || !(buf[1] & 0x80) || ![0, 1, 2, 8, 9, 10].includes(op)) return close(1002, 'Invalid WebSocket frame')
        let n = buf[1] & 127, at = 2
        if (op >= 8 && (!fin || n > 125)) return close(1002, 'Invalid WebSocket control')
        if (n === 126) {
          if (buf.length < 4) return
          n = buf.readUInt16BE(2); at = 4
          if (n < 126) return close(1002, 'Noncanonical WebSocket length')
        } else if (n === 127) {
          if (buf.length < 10) return
          const big = buf.readBigUInt64BE(2)
          if (big < 65536n || big >> 63n) return close(1002, 'Invalid WebSocket length')
          if (big > BigInt(TCP_LIMITS.bufferBytes)) return close(1009, 'WebSocket frame too large')
          n = Number(big); at = 10
        }
        if (op < 8) {
          if ((op === 0 && !partOp) || (op !== 0 && partOp)) return close(1002, 'Invalid WebSocket fragmentation')
          if (partBytes + n > maxFor(op || partOp)) return close(1009, 'WebSocket message too large')
        }
        if (buf.length < at + 4 + n) return
        const now = Date.now()
        if (now - wire.start >= TCP_LIMITS.rateWindowMs) wire = { start: now, count: 0 }
        if (++wire.count > TCP_LIMITS.wireFramesPerWindow) return close(1008, 'WebSocket frame rate exceeded')
        const mask = buf.subarray(at, at + 4)
        const payload = Buffer.allocUnsafeSlow(n)
        buf.copy(payload, 0, at + 4, at + 4 + n)
        for (let i = 0; i < n; i++) payload[i] ^= mask[i & 3]
        buf = buf.subarray(at + 4 + n)
        if (op === 8) {
          if (n === 1) return close(1002, 'Invalid WebSocket close')
          const code = n ? payload.readUInt16BE(0) : 1000
          if (n && !((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code < 5000))) return close(1002, 'Invalid WebSocket close code')
          if (n > 2) utf8.decode(payload.subarray(2))
          return close(code)
        }
        if (op === 9) {
          if (!enqueue(frame(10, payload))) return close(1009, 'WebSocket output limit')
          continue
        }
        if (op === 10) continue
        if (op) partOp = op
        if (++partCount > TCP_LIMITS.messageFragments) return close(1009, 'WebSocket fragment count limit')
        parts.push(payload); partBytes += n
        if (fin) {
          const data = Buffer.concat(parts, partBytes), kind = partOp
          parts = []; partBytes = 0; partOp = 0; partCount = 0
          on.message(kind === 1 ? utf8.decode(data) : data)
        }
      }
    } catch { close(1007, 'Invalid WebSocket UTF-8') }
  }
  const incoming = d => {
    if (closed) return
    if (buf.length + partBytes + d.length > TCP_LIMITS.bufferBytes) return close(1009, 'WebSocket parser limit')
    buf = Buffer.concat([buf, d])
    read()
  }
  socket.on('data', incoming)
  // Upgraded HTTP sockets allow half-close, but EOF without a WS close is fatal.
  socket.on('end', () => { if (!closed) socket.destroy() })
  socket.on('close', () => {
    if (!closed) { closed = true; on.close(1006) }
  })
  socket.on('error', () => socket.destroy())
  // Install both pair halves before any data piggybacked on the handshake runs.
  if (head?.length) queueMicrotask(() => incoming(head))
  return {
    send: data => {
      if (closed) return false
      const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset ?? 0, data.byteLength)
      if (bytes.length > maxFor(typeof data === 'string' ? 1 : 2) || !enqueue(frame(typeof data === 'string' ? 1 : 2, bytes))) { close(1009, 'WebSocket output limit'); return false }
      return true
    }, close,
  }
}
