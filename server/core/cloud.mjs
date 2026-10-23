import { json, readBody, clientVersion, token, shareUrl, PLUGIN_LATEST, bearerOf, sha256 } from './http.mjs'
import { CLOUD_CONFIG_MAX, CLOUD_MAX_MS, CLOUD_CHANGES_MAX } from './limits.mjs'

// ---------------------------------------------------------------------------
// The cloud host (docs/cloud-host.md). The host hands its session to a runner
// the server starts and stops (`ctx.cloud`: a container on Cloudflare, Docker
// under Node), and becomes the room's approver: a guest whose seats alone
// answer the runner's questions (`ask`, `answer`) and bring the session home.
//   POST cloud { session, cwd, model?, state?, auth } (host)
//        → { token, seat, ticket }: the mover's seat, and the ticket its
//          `PUT cloud/bundle` carries (Authorization), which the adapter checks
//   POST cloud/home (the approver) → { token, changes: file meta | null }
//   GET  cloud → { state, approver, since, until } or { state: 'none' }
// The runner's host token is minted for it, the mover's stops working at the
// move, and Bring home mints the mover a new one. The Claude sign-in in
// `auth` goes to the runner and is never kept here.
// Where the runner takes the plugin from (its main), at the server's version or newer.
export const PLUGIN_SOURCE = 'Paradigm-Study/claude-share'
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function cloudSummary(room) {
  const c = room.cloud
  return c ? { state: c.state, approver: c.approver.name, since: c.since, until: c.until } : undefined
}

// The approver: the seat the move made, or another seat of the same account.
export function isApprover(room, auth) {
  const c = room.cloud
  if (!c || auth?.role !== 'guest') return false
  if (auth.seat === c.approver.seat) return true
  if (!c.approver.account) return false
  for (const seat of room.seats.values()) if (seat.id === auth.seat) return seat.account === c.approver.account
  return false
}

// An answer as the room keeps it: the approver's, to a question asked, once.
export function cloudAnswer(room, auth, body) {
  if (!isApprover(room, auth)) return null
  const id = typeof body?.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(body.id) ? body.id : null
  const answer = typeof body?.answer === 'string' && body.answer.length <= 120 ? body.answer : null
  if (!id || !answer) return null
  const asked = room.events.some(e => e.type === 'ask' && e.body?.id === id)
  const answered = room.events.some(e => e.type === 'answer' && e.body?.id === id)
  return asked && !answered ? { id, answer } : null
}

// A change to the cloud host's settings as the room keeps it: the
// approver's, of what the host's Room sets (who may prompt, what Claude asks
// before, where what it shows goes), and Ask again for whom it always
// allows. Nothing it doesn't name: "ask before nothing" isn't the cloud
// host's, which holds its approver's Claude sign-in.
export function cloudSet(room, auth, body) {
  if (!isApprover(room, auth)) return null
  const set = {}
  if (body?.prompts === 'everyone' || body?.prompts === 'watch') set.prompts = body.prompts
  if (body?.approvals === 'all' || body?.approvals === 'edits') set.approvals = body.approvals
  if (body?.files === 'on' || body?.files === 'off') set.files = body.files
  if (body?.untrust === true) set.untrust = true
  return Object.keys(set).length ? set : null
}

// What the runner is told to sign in with: one shape, nothing else.
function cloudAuth(auth) {
  const text = v => (typeof v === 'string' && v.length > 0 && v.length <= 512 ? v : null)
  if (text(auth?.oauthToken)) return { oauthToken: auth.oauthToken }
  if (text(auth?.apiKey)) return { apiKey: auth.apiKey }
  if (text(auth?.baseUrl) && /^https?:\/\//.test(auth.baseUrl) && text(auth?.authToken)) return { baseUrl: auth.baseUrl, authToken: auth.authToken }
  return null
}

export async function cloudRoutes(room, req, rest, auth, now, ctx, origin) {
  if (rest !== 'cloud' && !rest.startsWith('cloud/')) return null
  const method = req.method
  if (rest === 'cloud' && method === 'GET') return { response: json(cloudSummary(room) ?? { state: 'none' }) }
  if (room.endedAt) return { response: json({ error: 'This session is no longer shared.' }, 410) }
  if (!ctx.cloud) return { response: json({ error: "This share server can't keep sessions running in the cloud." }, 501) }

  if (rest === 'cloud' && method === 'POST') {
    if (auth.role !== 'host') return { response: json({ error: 'Only the host moves the session to the cloud.' }, 403) }
    if (room.cloud) return { response: json({ error: 'This session is in the cloud already.' }, 409) }
    let body
    try {
      body = JSON.parse(new TextDecoder().decode(await readBody(req, CLOUD_CONFIG_MAX)))
    } catch (error) {
      return error?.status === 413 ? { response: json({ error: error.message }, 413) } : { response: json({ error: 'Expected JSON.' }, 400) }
    }
    const session = typeof body.session === 'string' && SESSION_ID.test(body.session) ? body.session : null
    const cwd = typeof body.cwd === 'string' && body.cwd.startsWith('/') && body.cwd.length <= 1024 && !body.cwd.split('/').includes('..') ? body.cwd : null
    const signIn = cloudAuth(body.auth)
    if (!session || !cwd) return { response: json({ error: 'The session and its folder are needed.' }, 400) }
    if (!signIn) return { response: json({ error: 'A Claude sign-in for the cloud host is needed.' }, 400) }
    const model = typeof body.model === 'string' && body.model.length <= 100 ? body.model : ''
    const state = body.state && typeof body.state === 'object' ? body.state : {}
    const was = room.host.token
    // The mover goes on as a guest (one of the host's own sessions, by account).
    const { token: seatToken, seat } = room.join(room.host.name, now, clientVersion(req), room.host.account ?? null)
    const runner = token(24)
    const ticket = token(32)
    room.host.token = runner
    room.cloud = { state: 'starting', approver: { seat: seat.id, account: room.host.account ?? null, name: room.host.name }, since: now, until: now + CLOUD_MAX_MS }
    try {
      await ctx.cloud.start(room.id, {
        ticket,
        config: { server: origin, room: room.id, token: runner, session, cwd, title: room.title, host: room.host.name, url: shareUrl(origin, room.id), seq: room.seq, model, state, auth: signIn, plugin: { version: PLUGIN_LATEST, source: ctx.pluginSource || PLUGIN_SOURCE } },
      })
    } catch (error) {
      // Nothing moved: the host keeps its room as it was.
      room.host.token = was
      room.seats.delete(seatToken)
      room.cloud = null
      return { changed: true, response: json({ error: `The cloud host didn't start: ${String(error?.message ?? error).slice(0, 200)}` }, 502) }
    }
    room.append(fromHost(room), 'cloud', { state: 'starting', by: room.host.name }, now)
    room.wake()
    return { changed: true, response: json({ token: seatToken, seat: seat.id, ticket, cloud: cloudSummary(room) }) }
  }

  if (rest === 'cloud/home' && method === 'POST') {
    if (!room.cloud) return { response: json({ error: "This session isn't in the cloud." }, 409) }
    if (!isApprover(room, auth)) return { response: json({ error: `Only ${room.cloud.approver.name} brings this session home.` }, 403) }
    const changes = room.cloud.state === 'stopped' ? room.cloud.changes ?? null : await stopCloud(room, ctx, now, 'home')
    // Their seat is the host again, with a token of its own.
    const host = token(24)
    room.host.token = host
    room.host.lastSeen = now
    room.seats.delete(bearerOf(req))
    room.cloud = null
    room.append(fromHost(room), 'cloud', { state: 'home', by: auth.name, changes: changes?.id ?? null }, now)
    room.wake()
    return { changed: true, response: json({ token: host, changes }) }
  }
  return { response: json({ error: 'Not found' }, 404) }
}

// The runner stops and answers with its changes, kept as a room file for Bring
// home; the room has no host meanwhile. Returns the changes' file, or null.
export async function stopCloud(room, ctx, now, why) {
  let changes = null
  try {
    const diff = await ctx.cloud.stop(room.id)
    if (diff?.byteLength && diff.byteLength <= CLOUD_CHANGES_MAX) {
      const bytes = diff instanceof Uint8Array ? diff : new Uint8Array(diff)
      const id = await sha256(bytes)
      changes = { id, name: 'cloud-changes.patch', type: 'text/x-diff', size: bytes.byteLength, ts: now }
      await room.store.put(id, bytes, changes)
      room.files.set(id, changes)
    }
  } catch {}
  if (room.cloud) {
    room.cloud.state = 'stopped'
    room.cloud.changes = changes
    // No one holds the host's token now.
    room.host.token = token(24)
    room.append(fromHost(room), 'cloud', { state: 'stopped', why, changes: changes?.id ?? null }, now)
    room.wake()
  }
  return changes
}

// The room ended: its runner goes, its changes with it.
export async function endCloud(room, ctx) {
  if (!room.cloud) return
  room.cloud = null
  await ctx.cloud?.stop(room.id).catch(() => {})
}
export const fromHost = room => ({ seat: 'host', name: room.host.name, role: 'host' })
