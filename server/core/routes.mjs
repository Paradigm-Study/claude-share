import {
  readJson,
  clientVersion,
  json,
  shareUrl,
  PLUGIN_LATEST,
  outdatedClient,
  bearerOf,
  leftResponse,
  noteVersion,
  limitedResponse,
  readBody,
  bodyFailure,
  sha256,
  roomAccessError,
  readBoundedJson,
} from './http.mjs'
import {
  Room,
  maxOf,
  pageOf,
  newestOf,
  HOST_TYPES,
  GUEST_TYPES,
  bodyBytes,
  clampBody,
  tidyMark,
  LIVE_TYPES,
} from './room.mjs'
import { stopCloud, cloudSummary, endCloud, cloudRoutes, isApprover, cloudAnswer, cloudSet } from './cloud.mjs'
import { landingPage } from './pages.mjs'
import {
  ROOM_SEATS_MAX,
  PAGE_BYTES_CAP,
  POLL_WAIT_MS,
  EVENT_BYTES,
  FILE_UPLOADS,
  FILE_MAX,
  ROOM_FILES_MAX,
  ROOM_FILES_COUNT,
  PEER_LIMIT,
} from './limits.mjs'
import { previewRoutes, needRoute } from './previews.mjs'
import { serveReserve, SERVED_ALL } from './tcp.mjs'

// POST /api/rooms: the host's Share. Returns the room and the host's token.
// Shared with a team (`team`, the host signed in), the room goes on the
// team's list, and the team's access setting says who may join; refused, no
// room is made (`room` is absent).
export async function createRoom(req, id, now, origin, ctx = {}) {
  // The body arrives as a stream: one past its bound, or not JSON, is said
  // as such, never thrown out of the room as a 500.
  let body
  try { body = await readJson(req) } catch (error) { return bodyFailure(error.status ? error : { message: 'Expected a JSON body.' }) }
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
/** @returns {Promise<{ response: Response, changed?: boolean }>} */
export async function roomRequest(room, req, rest, now, origin, ctx = {}) {
  const expired = room.sweepExpired(now)
  const swept = room.sweep(now) || expired
  const versions = versionsOf(room)
  const seated = room.seats.size
  const cloudWas = room.cloud?.state
  const result = await handleRoom(room, req, rest, now, origin, ctx).catch(error => {
    // A JSON body past its bound is said as such, not as a crash.
    if (error?.status === 413) return { response: json({ error: error.message }, 413) }
    throw error
  })
  // The cloud host's time is up: stopped, its changes kept for Bring home.
  if (room.cloud && room.cloud.state !== 'stopped' && now > room.cloud.until && ctx.cloud) await stopCloud(room, ctx, now, 'expired')
  if (room.cloud?.state !== cloudWas) return { ...result, changed: true }
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
        cloud: cloudSummary(room),
      }),
    }
  }

  if (rest === 'join' && method === 'POST') {
    if (room.endedAt) return { response: json({ error: 'This session is no longer shared.' }, 410) }
    const outdated = outdatedClient(req)
    if (outdated) return { response: outdated }
    if (room.team && !ctx.directory) return { response: json({ error: `This session is for ${room.team.name}, and this server can't check who's in it.` }, 503) }
    if (room.seats.size >= ROOM_SEATS_MAX) return { response: json({ error: `This session is full: ${ROOM_SEATS_MAX} people have joined.` }, 403) }
    const body = await readJson(req)
    const account = await whoIs(req, ctx)
    // Shared with a team: its access setting, as it is now, says who joins,
    // asked after the waits above (a body held open, the sign-in's look) and
    // again if the team let someone go meanwhile, so a removal while this
    // join waited never ends in a seat.
    for (let tries = 0; room.team; tries++) {
      const gen = room.teamGen
      const check = await ctx.directory.joinCheck(room.team.id, accountOf(req))
      if (!check.ok) return { response: json({ error: check.error, team: room.team.name, signIn: check.status === 401 || undefined }, check.status === 401 ? 403 : check.status) }
      if (room.teamGen === gen) break
      if (tries >= 2) return { response: json({ error: 'Who is in the team changed while you joined. Try again.' }, 409) }
    }
    if (room.endedAt) return { response: json({ error: 'This session is no longer shared.' }, 410) }
    if (room.seats.size >= ROOM_SEATS_MAX) return { response: json({ error: `This session is full: ${ROOM_SEATS_MAX} people have joined.` }, 403) }
    const { token: seatToken, seat } = room.join(body.name, now, clientVersion(req), account)
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
        team: teamOf(room),
        // What's shared now, whatever history was pruned.
        previews: room.previewList(),
        cloud: cloudSummary(room),
      }),
    }
  }

  // The operator ends a room (abuse): its admin token, checked by the host.
  if (rest === 'admin-end' && method === 'POST') {
    if (!ctx.admin) return { response: json({ error: 'Not found' }, 404) }
    room.end(now)
    await ended(room, ctx)
    await endCloud(room, ctx)
    return { changed: true, response: json({ ok: true }) }
  }

  // The host's sign-in ends it too, with no room token: the Team panel's Stop,
  // from any session or computer, even after the session that shared it
  // closed without saving its token.
  if (rest === 'end' && method === 'POST' && !bearerOf(req) && accountOf(req)) {
    const who = await whoIs(req, ctx)
    if (!who || (who !== room.host.account && who !== room.team?.account)) return { response: json({ error: 'Only the host can stop sharing.' }, 403) }
    room.end(now)
    // Off its team's list, and its invites gone, as every end takes them (`ended`).
    await ended(room, ctx)
    // A session in the cloud: its runner goes with the room.
    await endCloud(room, ctx)
    return { changed: true, response: json({ ok: true }) }
  }

  // A person leaves by their sign-in, with no seat token: the Team panel's
  // Leave, for every session of theirs in it, here or on another computer.
  if (rest === 'leave' && method === 'POST' && !bearerOf(req) && accountOf(req)) {
    const who = await whoIs(req, ctx)
    if (!who) return { response: json({ error: 'Sign in first: /team' }, 403) }
    const left = room.leaveAccount(who, now)
    return { changed: left > 0, response: json({ ok: true, left }) }
  }
  // A seat its person left from elsewhere: told so, never seated again.
  if (room.leftElsewhere.has(bearerOf(req))) return { response: leftResponse() }

  // An away seat can still deliberately leave even when all seats are full.
  if (rest === 'leave' && method === 'POST' && room.away.has(bearerOf(req))) {
    room.leave(bearerOf(req), 'left', now)
    return { changed: true, response: json({ ok: true }) }
  }
  const auth = room.auth(bearerOf(req), now)
  if (!auth) return { response: json({ error: 'Not a member of this session.' }, 401) }
  // Which plugin each one runs now (an update and a restart change it): the
  // Room says who needs to update.
  noteVersion(room, req, auth)

  const files = await fileRoutes(room, req, rest, auth, now)
  if (files) return files
  const previews = await previewRoutes(room, req, rest, auth, now, ctx)
  if (previews) return previews
  if (rest === 'need' && method === 'POST') return needRoute(room, req, auth, now, ctx)
  if (rest === 'peer' && method === 'POST') return peerRoute(room, req, auth, now, ctx)
  const cloud = await cloudRoutes(room, req, rest, auth, now, ctx, origin)
  if (cloud) return cloud


  if (rest === 'events' && method === 'GET') {
    const after = Number(url.searchParams.get('after') ?? 0) || 0
    const wait = Math.min(Number(url.searchParams.get('wait') ?? POLL_WAIT_MS) || 0, 25_000)
    room.touch(auth, now)
    await room.wait(after, wait, auth.seat)
    // Let go while it waited (removed from the room's team): nothing more.
    if (auth.role !== 'host' && !room.seated(auth.seat)) return { response: json({ error: 'Not a member of this session.' }, 401) }
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
        previews: room.previewList(),
        ended: Boolean(room.endedAt),
        title: room.title,
        team: room.team?.name,
        cloud: cloudSummary(room),
      }),
    }
  }

  if (rest === 'events' && method === 'POST') {
    if (room.endedAt) return { response: json({ error: 'This session is no longer shared.' }, 410) }
    if (!room.posts.hit('events', 'all', now)) return { response: limitedResponse('events') }
    const body = await readJson(req)
    const allowed = auth.role === 'host' ? HOST_TYPES : GUEST_TYPES
    const from = { seat: auth.seat, name: auth.name, role: auth.role }
    // The approver's prompt says so: their own session in the cloud, which
    // the cloud host's watch-only setting keeps to teammates.
    const approver = isApprover(room, auth)
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
      // Only the approver answers the cloud host's questions, one answer each.
      if (item.type === 'answer') {
        const answer = cloudAnswer(room, auth, item.body)
        if (answer) room.append(from, 'answer', answer, now)
        if (answer) changed = true
        continue
      }
      if (item.type === 'set') {
        const set = cloudSet(room, auth, item.body)
        if (set) room.append(from, 'set', set, now)
        if (set) changed = true
        continue
      }
      if (item.type === 'prompt' && approver) {
        room.append({ ...from, approver: true }, 'prompt', item.body, now)
        changed = true
        continue
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
    if (auth.role !== 'host' && !isApprover(room, auth)) return { response: json({ error: 'Only the host can stop sharing.' }, 403) }
    room.end(now)
    await ended(room, ctx)
    await endCloud(room, ctx)
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

// The room ended or expired: off its team's list, and its invites gone.
export async function ended(room, ctx) {
  if (ctx.directory) await ctx.directory.roomEnded(room.id, room.team?.id ?? null).catch(() => {})
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
    if (room.uploading >= FILE_UPLOADS) return { response: json({ error: 'Too many files are going up to this session at once. Try again in a moment.' }, 429) }
    room.uploading += 1
    try {
      let bytes
      try { bytes = await readBody(req, FILE_MAX) } catch (error) {
        return error.status === 413 ? { response: json({ error: `Files are limited to ${FILE_MAX / 1024 / 1024} MB.` }, 413) } : bodyFailure(error)
      }
      const id = await sha256(bytes)
      // What the room holds and what's going up now (the same bytes once):
      // checked and reserved together, before anything waits.
      const sizes = new Map([...room.filesPending, ...[...room.files.values()].map(f => [f.id, f.size])])
      const used = [...sizes].reduce((n, [other, size]) => n + (other === id ? 0 : size), 0)
      if (used + bytes.length > ROOM_FILES_MAX || (!sizes.has(id) && sizes.size >= ROOM_FILES_COUNT)) return { response: json({ error: 'This room is out of room for files.' }, 413) }
      const meta = { id, name: fileName(req.headers.get('x-file-name')), type: fileType(req.headers.get('content-type')), size: bytes.length, ts: now }
      const mine = !room.filesPending.has(id)
      if (mine) room.filesPending.set(id, bytes.length)
      try {
        await room.store.put(id, bytes, meta)
      } finally {
        if (mine) room.filesPending.delete(id)
      }
      room.files.set(id, meta)
      return { changed: true, response: json(meta) }
    } finally {
      room.uploading -= 1
    }
  }
  if (rest.startsWith('files/') && req.method === 'GET') {
    const meta = room.files.get(rest.slice(6))
    if (!meta) return { response: json({ error: 'No such file.' }, 404) }
    // Counted before it's read: what the room may send is its budget's.
    if (!serveReserve(room, auth.seat, meta.size, now)) return { response: json({ error: SERVED_ALL }, 429) }
    const stored = await room.store.get(meta.id)
    if (!stored) return { response: json({ error: 'No such file.' }, 404) }
    return {
      response: new Response(stored.data, {
        headers: { 'content-type': meta.type, 'content-length': String(meta.size), 'cache-control': 'private, max-age=3600' },
      }),
    }
  }
  return null
}
export const PEER_HANDLE = /^[0-9a-f]{32}$/
// What a session's receipt says of a message (Claude Code's own words), and
// why one was dropped.
export const PEER_STATUS = new Set(['held', 'denied', 'delivered', 'expired', 'refused', 'dropped'])
export const PEER_DROPS = new Set(['rate-limited', 'duplicate', 'hop-loop', 'hop-runaway', 'queue-full'])
const PEER_MODE = /^[a-z-]{1,32}$/
const PEER_TOKEN = /^[0-9a-f]{24}$/
const PEER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PEER_PID = /^[A-Za-z0-9_-]{1,64}$/
const PEER_KEYS = {
  guest: new Set(['handle', 'name', 'mode', 'chain', 'id', 'pid', 'body']),
  guestStatus: new Set(['handle', 'status', 'ref', 'reason']),
  host: new Set(['to', 'handle', 'body', 'ref']),
  hostStatus: new Set(['to', 'handle', 'status', 'id', 'reason']),
}

function peerAllowed(room, key, now) {
  let w = room.peers.get(key)
  if (!w || now - w.start >= PEER_LIMIT.periodMs) {
    // Seats come and go: only the ones that sent this past minute are kept.
    for (const [k, old] of room.peers) if (now - old.start >= PEER_LIMIT.periodMs) room.peers.delete(k)
    room.peers.set(key, (w = { start: now, count: 0 }))
  }
  if (w.count >= (key === 'host' ? PEER_LIMIT.host : PEER_LIMIT.seat)) return false
  w.count += 1
  return true
}

// A message or a receipt as either side sends it, checked: null when well
// formed, else what's wrong.
function peerProblem(body, kind) {
  const keys = Object.keys(body)
  const allowed = PEER_KEYS[kind]
  if (keys.some(k => !allowed.has(k))) return `Expected only { ${[...allowed].join(', ')} }.`
  const { handle, name, mode, chain, id, pid, body: text, status, ref, reason } = body
  if ((kind === 'host' || kind === 'hostStatus') && (typeof body.to !== 'string' || !body.to || body.to.length > 64)) return "A guest's seat."
  if (typeof handle !== 'string' || !PEER_HANDLE.test(handle)) return 'A handle of 32 hex characters.'
  if (kind === 'guestStatus' || kind === 'hostStatus') {
    if (typeof status !== 'string' || !PEER_STATUS.has(status)) return `A status: ${[...PEER_STATUS].join(', ')}.`
    const of = kind === 'guestStatus' ? ref : id
    if (typeof of !== 'string' || !PEER_ID.test(of)) return 'The message id a receipt names, a UUID.'
    if (reason !== undefined && (status !== 'dropped' || typeof reason !== 'string' || !PEER_DROPS.has(reason))) return `Why a message was dropped: ${[...PEER_DROPS].join(', ')}.`
    return null
  }
  if (kind === 'guest') {
    if (typeof name !== 'string' || !name || name.length > PEER_LIMIT.nameChars || /[\x00-\x1f\x7f]/.test(name)) return `A name of 1 to ${PEER_LIMIT.nameChars} characters, without control characters.`
    if (mode !== undefined && (typeof mode !== 'string' || !PEER_MODE.test(mode))) return 'A permission mode class as Claude Code spells it.'
    if (chain !== undefined && (!Array.isArray(chain) || chain.length > PEER_LIMIT.chain || chain.some(t => typeof t !== 'string' || !PEER_TOKEN.test(t)))) return `A hop chain of at most ${PEER_LIMIT.chain} tokens of 24 hex characters.`
    if (typeof id !== 'string' || !PEER_ID.test(id)) return "The message's id, a UUID."
    if (typeof pid !== 'string' || !PEER_PID.test(pid)) return 'An id of 1 to 64 letters, digits, - or _.'
  }
  if (kind === 'host' && (typeof ref !== 'string' || !PEER_ID.test(ref))) return "The message's id, a UUID."
  if (typeof text !== 'string' || !text || text.length > PEER_LIMIT.bodyChars) return `A message of 1 to ${PEER_LIMIT.bodyChars} characters.`
  return null
}

async function peerRoute(room, req, auth, now, ctx) {
  const host = auth.role === 'host'
  const before = roomAccessError(room, req, ctx, host)
  if (before) return { response: before }
  // Counted before the body is read: every message costs, a refused one included.
  if (!peerAllowed(room, host ? 'host' : auth.seat, now)) return { response: json({ error: 'Too many messages between sessions. Try again in a minute.' }, 429) }
  let body
  try { body = await readBoundedJson(req, PEER_LIMIT.bodyBytes) } catch (error) { return bodyFailure(error) }
  const after = roomAccessError(room, req, ctx, host)
  if (after) return { response: after }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { response: json({ error: 'Expected a JSON object.' }, 400) }
  const kind = `${host ? 'host' : 'guest'}${'status' in body ? 'Status' : ''}`
  const problem = peerProblem(body, kind)
  if (problem) return { response: json({ error: problem }, 400) }
  const { handle, name, mode, chain, id, pid, body: text, status, ref, reason } = body
  const receipt = status ? { handle, status, ...(kind === 'guestStatus' ? { ref } : { id }), ...(reason ? { reason } : {}) } : null
  let result
  if (host) {
    // Only a guest seat the room has now: one that left, or was let go, hears nothing.
    if (body.to === 'host' || ![...room.seats.values()].some(s => s.id === body.to)) return { response: json({ error: 'Not a seat in this session.' }, 403) }
    result = room.toSeat(body.to, { peer: receipt ?? { handle, body: text, ref } })
  } else {
    // Who sent it comes from the seat, never from the body.
    const message = receipt ?? { who: auth.name, handle, name, ...(mode ? { mode } : {}), chain: chain ?? [], id, pid, body: text }
    result = room.toSeat('host', { peer: { seat: auth.seat, ...message } })
  }
  return { changed: false, response: json(result === 'delivered' ? { delivered: true } : { delivered: false, reason: result }) }
}
