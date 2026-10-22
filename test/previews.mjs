// No model or product accounts. Preview forwarding on the server: what the
// host shares, grants, needs and their bounded bodies, public sockets ending
// with their preview, and a real Node server across restarts.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, createConnection } from 'node:net'
import { request as httpRequest, createServer as createHTTPServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import relay from '../plugin/relay/ws-relay.cjs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Room, PLUGIN_LATEST, roomRequest, token, versionInfo, tcpSocketTarget, NEED_LIMIT, LIMITS, limitOf, streamedRoomBody, previewRequest, previewSocketTarget, publicPairValid, PUBLIC_LIMITS, TCP_LIMITS, SEAT_TIMEOUT_MS, EVENT_BYTES, HISTORY_BYTES, ROOM_FILES_COUNT, ROOM_PREVIEWS_MAX, ROOM_SEATS_MAX, hostHalfClose, homePage } from '../server/core.mjs'
import { metaOf, META_FILES } from '../server/worker.mjs'

function world() {
  const room = Room.create({ id: token(16), name: 'Host', now: Date.now(), version: PLUGIN_LATEST })
  const joined = room.join('Guest', Date.now(), PLUGIN_LATEST)
  room.tcpSupported = () => true
  return { room, host: room.host.token, guest: joined.token, current: true }
}
function request(w, path, bearer = w.host, method = 'GET', body) {
  return new Request(`https://room.test/api/rooms/${w.room.id}/${path}`, { method, headers: {
    authorization: `Bearer ${bearer}`, 'x-shared-session-version': PLUGIN_LATEST,
  }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
}
async function send(w, req) {
  const url = new URL(req.url), rest = url.pathname.split('/').slice(4).join('/')
  return (await roomRequest(w.room, req, rest, Date.now(), url.origin, { isCurrent: () => w.current, previewOrigin: 'https://preview.test' })).response
}
const call = (w, path, bearer, method, body) => send(w, request(w, path, bearer, method, body))
async function api(w, path, bearer, method, body) {
  const r = await call(w, path, bearer, method, body)
  assert.equal(r.status, 200, await r.clone().text())
  return r.json()
}
// A request whose body arrives only when the test says: what happens meanwhile
// is what the route must check again after reading it.
function held(w, path, bearer = w.host, method = 'POST') {
  let release, started, reads = 0
  const reading = new Promise(resolve => { started = resolve })
  const body = new ReadableStream({ pull(controller) {
    reads++; started()
    return new Promise(resolve => { release = text => { controller.enqueue(new TextEncoder().encode(typeof text === 'string' ? text : JSON.stringify(text))); controller.close(); resolve() } })
  } }, { highWaterMark: 0 })
  const req = new Request(request(w, path, bearer, method), { body, duplex: 'half' })
  return { req, reading, release: text => release(text), get reads() { return reads } }
}

{
  const info = await versionInfo().json()
  assert.deepEqual(Object.keys(info).sort(), ['latest', 'min', 'update'])
  for (const [method, rest, streamed] of [['POST', 'previews', true], ['POST', 'previews/p/tunnel', true], ['POST', 'previews/p/end', true], ['POST', 'need', true], ['POST', 'ws/x/reject', true],
    ['POST', 'previews/p/ticket', true], ['POST', 'proxy/x', true],
    ['GET', 'previews/p', false], ['GET', 'previews', false], ['POST', 'events', false], ['POST', 'files', false], ['PUT', 'previews', false]]) assert.equal(streamedRoomBody(method, rest), streamed, `${method} ${rest}`)
  const w = world()
  const page = (await api(w, 'previews', w.host, 'POST', { port: 43600, title: 'App' })).pid
  assert.equal(w.room.previews.get(page).tcp, undefined, 'shared as a page: no forwarding')
  assert.equal((await call(w, `previews/${page}/tunnel`, w.guest, 'POST')).status, 403)
  assert.deepEqual(await api(w, 'previews', w.host, 'POST', { port: 43600 }), { pid: page, tcp: false }, 'the same port again is the same preview')
  // Allow forwarding later: the same preview, now forwarded.
  assert.deepEqual(await api(w, 'previews', w.host, 'POST', { port: 43600, tcp: true }), { pid: page, tcp: true })
  assert.deepEqual(await api(w, 'previews', w.host, 'POST', { port: 43600 }), { pid: page, tcp: true }, 'a later plain share never takes forwarding back')
  const cap = await api(w, `previews/${page}/tunnel`, w.guest, 'POST')
  assert.deepEqual(Object.keys(cap).sort(), ['expiresAt', 'port', 'protocol', 'token'])
  assert.equal((await call(w, `previews/${page}/ticket`, cap.token, 'POST', {})).status, 401, 'a TCP grant is no room bearer')
  const forwarded = (await api(w, 'previews', w.host, 'POST', { port: 43601, tcp: true, title: 'API' })).pid
  // An open event when a preview opens, and again when forwarding upgrades it:
  // guests read existence and `tcp` from the room, not from the host's artifacts.
  assert.deepEqual(w.room.events.filter(e => e.type === 'preview').map(e => e.body),
    [{ state: 'open', pid: page, port: 43600, tcp: false, title: 'App' }, { state: 'open', pid: page, port: 43600, tcp: true, title: 'App' }, { state: 'open', pid: forwarded, port: 43601, tcp: true, title: 'API' }])
  // A grant reads the room's current previews, not history, which may have been pruned.
  w.room.events = []
  assert.equal((await api(w, `previews/${forwarded}/tunnel`, w.guest, 'POST')).port, 43601)
  for (const bearer of ['', 'invalid']) assert.equal((await call(w, `previews/${page}/tunnel`, bearer, 'POST')).status, 401)
  const copy = Room.resume(structuredClone(w.room.toJSON()), Date.now())
  assert.deepEqual([...copy.previews.values()].map(p => [p.port, p.tcp === true]), [[43600, true], [43601, true]])
  // Stop: its grants, tickets and metadata go, and a closed event says so.
  const ticket = (await api(w, `previews/${page}/ticket`, w.guest, 'POST', {})).url
  assert.match(ticket, /^https:\/\/preview\.test\/__share\/enter\?/)
  const before = w.room.seq
  for (const bearer of [w.guest, 'invalid']) {
    const body = held(w, `previews/${page}/end`, bearer)
    assert.equal((await send(w, body.req)).status, bearer === w.guest ? 403 : 401); assert.equal(body.reads, 0)
  }
  assert.deepEqual(await api(w, `previews/${page}/end`, w.host, 'POST'), { ok: true })
  assert.deepEqual(w.room.since(before).filter(e => e.type === 'preview').map(e => [e.body.pid, e.body.state]), [[page, 'closed']])
  assert.equal(w.room.previewSessions.has(cap.token), false); assert.equal(w.room.tickets.size, 0)
  assert.equal((await call(w, `previews/${page}/tunnel`, w.guest, 'POST')).status, 404)
  assert.equal(tcpSocketTarget(w.room, new Request('https://room.test', { headers: { authorization: `Bearer ${cap.token}` } }), page, Date.now()).status, 401)
  const again = (await api(w, 'previews', w.host, 'POST', { port: 43600, tcp: true })).pid
  assert.notEqual(again, page, 'a port shared again is a new preview')
  w.current = false
  assert.equal((await call(w, `previews/${forwarded}/tunnel`, w.guest, 'POST')).status, 404)
  w.current = true
  await api(w, 'end', w.host, 'POST')
  assert.equal((await call(w, `previews/${forwarded}/tunnel`, w.guest, 'POST')).status, 410)
  assert.equal(w.room.previewSessions.size, 0)
  console.log('OK previews: a page, then forwarding on the same preview; grants from current state; Stop takes its grants, tickets and metadata')
}

{
  const w = world()
  for (const bearer of ['invalid', w.guest]) {
    const body = held(w, 'previews', bearer)
    assert.equal((await send(w, body.req)).status, bearer === w.guest ? 403 : 401); assert.equal(body.reads, 0)
  }
  const declared = held(w, 'previews')
  declared.req.headers.set('content-length', String(1_000_000))
  assert.equal((await send(w, declared.req)).status, 413); assert.equal(declared.reads, 0)
  let reads = 0
  const big = new ReadableStream({ pull(controller) { reads++; assert.equal(reads, 1, 'refused before another chunk or EOF'); controller.enqueue(new TextEncoder().encode('界'.repeat(200_000))) } }, { highWaterMark: 0 })
  assert.equal((await send(w, new Request(request(w, 'previews', w.host, 'POST'), { body: big, duplex: 'half' }))).status, 413)
  for (const text of ['{', '[]', 'null', '"x"']) assert.equal((await call(w, 'previews', w.host, 'POST', text)).status, 400)
  assert.equal((await send(w, new Request(request(w, 'previews', w.host, 'POST'), { body: new Uint8Array([123, 255, 125]) }))).status, 400)
  for (const port of [0, 65536, 1.5, '43700x']) assert.equal((await call(w, 'previews', w.host, 'POST', { port })).status, 400)
  assert.equal(w.room.previews.size, 0, 'nothing refused was shared')
  // The room changing while a body arrives: nothing is shared or granted.
  for (const race of ['host token', 'room end', 'room identity']) {
    const r = world(), pending = held(r, 'previews'), sending = send(r, pending.req)
    await pending.reading
    if (race === 'host token') r.room.host.token = token(24)
    if (race === 'room end') r.room.end(Date.now())
    if (race === 'room identity') r.current = false
    pending.release({ port: 43701, tcp: true })
    assert.equal((await sending).status, { 'host token': 401, 'room end': 410, 'room identity': 404 }[race], race)
    assert.equal(r.room.previews.size, 0)
  }
  // A link's body (its page) is read, bounded: what changed meanwhile mints nothing.
  for (const race of ['port end', 'room end', 'leave', 'room identity']) {
    const r = world(), pid = (await api(r, 'previews', r.host, 'POST', { port: 43702, tcp: true })).pid
    const ready = await api(r, `previews/${pid}/tunnel`, r.guest, 'POST')
    const waiting = held(r, `previews/${pid}/ticket`, r.guest), pending = send(r, waiting.req)
    await waiting.reading
    if (race === 'port end') await api(r, `previews/${pid}/end`, r.host, 'POST')
    if (race === 'room end') await api(r, 'end', r.host, 'POST')
    if (race === 'leave') await api(r, 'leave', r.guest, 'POST')
    if (race === 'room identity') r.current = false
    waiting.release({ path: '/late' })
    assert.equal((await pending).status, { 'port end': 404, 'room end': 410, leave: 401, 'room identity': 404 }[race], race)
    assert.equal(r.room.tickets.size, 0, race)
    assert(!r.room.previewSessions.has(ready.token) || race === 'room identity')
  }
  // A grant reads no body, whatever it says it carries: one check, no await.
  const r = world(), pid = (await api(r, 'previews', r.host, 'POST', { port: 43703, tcp: true })).pid
  const large = held(r, `previews/${pid}/tunnel`, r.guest)
  large.req.headers.set('content-length', String(1_000_000))
  assert.equal((await send(r, large.req)).status, 200); assert.equal(large.reads, 0)
  const unread = held(r, `previews/${pid}/tunnel`, r.guest)
  assert.equal((await send(r, unread.req)).status, 200); assert.equal(unread.reads, 0)
  assert.equal([...r.room.previewSessions.values()].filter(s => s.scope === 'tcp').length, 2)
  const link = held(r, `previews/${pid}/ticket`, r.guest)
  link.req.headers.set('content-length', String(20_000))
  assert.equal((await send(r, link.req)).status, 413); assert.equal(link.reads, 0); assert.equal(r.room.tickets.size, 0)
  console.log('OK bounded bodies before buffering or EOF, host-only shares and post-body room, seat and preview checks; grants read none')
}

// A guest's need: to the host's stream alone, never stored, never an event.
{
  assert.equal(NEED_LIMIT.limit, 20); assert.equal(NEED_LIMIT.periodMs, 60_000); assert(NEED_LIMIT.bodyBytes <= 256)
  assert.equal(LIMITS.need, undefined, 'LIMITS kinds are also wrangler.toml rate-limit bindings')
  assert.equal(limitOf(new Request('https://room.test', { method: 'POST' }), 'room', 'need', 'ip'), null)
  assert.equal(streamedRoomBody('POST', 'need'), true); assert.equal(streamedRoomBody('GET', 'need'), false)
  const w = world(), seat = w.room.auth(w.guest).seat
  const answer = async (body, bearer = w.guest, at = Date.now()) => {
    const { response, changed } = await roomRequest(w.room, request(w, 'need', bearer, 'POST', body), 'need', at, 'https://room.test', { isCurrent: () => w.current })
    return { status: response.status, body: await response.json(), changed }
  }
  await api(w, 'events', w.guest, 'POST', { events: [{ type: 'chat', body: { text: 'before any need' } }] })
  const posts = structuredClone(w.room.posts.windows.get('all'))
  let saved = JSON.stringify(w.room.toJSON())
  assert.deepEqual(await answer({ port: 43800 }), { status: 200, body: { delivered: false }, changed: false }, 'no host stream: nowhere to go')
  assert.equal(JSON.stringify(w.room.toJSON()), saved, 'an undelivered need is not kept for later')
  // A host stream that didn't say need=1 (a 0.11.24 host, which drops the
  // line) is not one to tell: the guest hears it wasn't delivered (C2-need).
  const old = []
  w.room.subscribers.add({ seat: 'host', tcpSupport: true, send: m => old.push(m), push() {} })
  assert.deepEqual(await answer({ port: 43800 }), { status: 200, body: { delivered: false }, changed: false }, 'a host stream without need=1')
  const heard = { host: [], guest: [] }, woken = { host: 0, guest: 0 }
  const listen = (name, who) => w.room.subscribers.add({ seat: who, tcpSupport: who === 'host', needSupport: who === 'host', send: m => heard[name].push(m), push: () => { woken[name]++ } })
  listen('host', 'host'); listen('guest', seat)
  const seq = w.room.seq, events = w.room.events.length
  saved = JSON.stringify(w.room.toJSON())
  assert.deepEqual(await answer({ port: 43800 }), { status: 200, body: { delivered: true }, changed: false })
  assert.deepEqual(heard.host, [{ need: { port: 43800, seat, name: 'Guest' } }])
  assert.deepEqual(heard.guest, []); assert.deepEqual(woken, { host: 0, guest: 0 }, 'no page, no wake')
  assert.equal(w.room.seq, seq); assert.equal(w.room.events.length, events)
  assert.equal(JSON.stringify(w.room.toJSON()), saved, 'nothing stored')
  for (const bearer of [w.host, 'invalid']) {
    const body = held(w, 'need', bearer)
    assert.equal((await send(w, body.req)).status, bearer === w.host ? 403 : 401); assert.equal(body.reads, 0)
  }
  // Every refusal here counts against this seat's own minute, never another's.
  const prober = w.room.join('Prober', Date.now(), PLUGIN_LATEST)
  for (const bad of [{}, { port: 0 }, { port: 65536 }, { port: 43800.5 }, { port: '43800' }, { port: null }, { Port: 43800 },
    { port: 43800, seat: 'host' }, { port: 43800, name: 'Host' }, [], 'null', '"43800"', '{', undefined]) {
    const r = await answer(bad, prober.token)
    assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(r.changed, undefined)
  }
  assert.equal((await answer({ port: 1 }, prober.token)).status, 200)
  const invalid = await send(w, new Request(request(w, 'need', prober.token, 'POST'), { body: new Uint8Array([123, 255, 125]) }))
  assert.equal(invalid.status, 400)
  const declared = held(w, 'need', prober.token)
  declared.req.headers.set('content-length', String(NEED_LIMIT.bodyBytes + 1))
  assert.equal((await send(w, declared.req)).status, 413); assert.equal(declared.reads, 0)
  let reads = 0
  const flood = new ReadableStream({ pull(controller) { reads++; assert.equal(reads, 1, 'refused before another chunk or EOF'); controller.enqueue(new TextEncoder().encode(' '.repeat(NEED_LIMIT.bodyBytes + 1))) } }, { highWaterMark: 0 })
  assert.equal((await send(w, new Request(request(w, 'need', prober.token, 'POST'), { body: flood, duplex: 'half' }))).status, 413)
  assert.equal((await answer(JSON.stringify({ port: 65535 }).padStart(NEED_LIMIT.bodyBytes, ' '), prober.token)).body.delivered, true, 'exactly at the limit')
  assert.deepEqual(heard.host.slice(1).map(m => m.need.port), [1, 65535], 'refused bodies reach no one')
  // The 21st within a minute is refused before its body; another seat still asks.
  const busy = w.room.join('Busy', Date.now(), PLUGIN_LATEST), busySeat = busy.seat.id
  w.room.subscribers.add({ seat: busySeat, send() {}, push() {} }) // connected, so a later minute doesn't sweep it
  for (let i = 0; i < NEED_LIMIT.limit; i++) assert.deepEqual((await answer({ port: 43810 + i }, busy.token)).body, { delivered: true })
  const limited = held(w, 'need', busy.token), refused = await send(w, limited.req)
  assert.equal(refused.status, 429); assert.equal(limited.reads, 0); assert.match((await refused.json()).error, /Too many/)
  assert.deepEqual((await answer({ port: 43830 })).body, { delivered: true })
  assert.deepEqual(heard.host.filter(m => m.need.seat === busySeat).map(m => m.need.port), Array.from({ length: 20 }, (_, i) => 43810 + i))
  assert.deepEqual((await answer({ port: 43831 }, busy.token, Date.now() + NEED_LIMIT.periodMs)).body, { delivered: true }, 'a new minute')
  assert.deepEqual(w.room.posts.windows.get('all'), posts, "needs don't count against the room's events window")
  // Already forwarded by the host: nothing to ask, and the pid to use, even
  // for a preview the guest never saw shown. A page shared as a link alone
  // still goes to the host.
  const forwarded = (await api(w, 'previews', w.host, 'POST', { port: 43840, tcp: true })).pid
  const page = (await api(w, 'previews', w.host, 'POST', { port: 43841 })).pid
  const asked = heard.host.length
  assert.deepEqual(await answer({ port: 43840 }), { status: 200, body: { shared: true, pid: forwarded }, changed: false })
  assert.deepEqual((await answer({ port: 43841 })).body, { delivered: true })
  await api(w, 'previews', w.host, 'POST', { port: 43841, tcp: true })
  assert.deepEqual((await answer({ port: 43841 })).body, { shared: true, pid: page })
  await api(w, `previews/${forwarded}/end`, w.host, 'POST')
  assert.deepEqual((await answer({ port: 43840 })).body, { delivered: true })
  assert.deepEqual(heard.host.slice(asked).map(m => m.need.port), [43841, 43840])
  assert.deepEqual(heard.guest, [])
  assert.deepEqual(old.filter(m => m.need), [], 'never a need line to a stream that takes none')
  await api(w, 'end', w.host, 'POST')
  const late = held(w, 'need', w.guest)
  assert.equal((await send(w, late.req)).status, 410); assert.equal(late.reads, 0)
  // The room changing while the body arrives: nothing reaches the host.
  for (const race of ['room end', 'leave', 'room identity']) {
    const r = world(), lines = []
    r.room.subscribers.add({ seat: 'host', needSupport: true, send: m => lines.push(m), push() {} })
    const pending = held(r, 'need', r.guest), sending = send(r, pending.req)
    await pending.reading
    if (race === 'room end') r.room.end(Date.now())
    if (race === 'leave') r.room.leave(r.guest, 'left', Date.now())
    if (race === 'room identity') r.current = false
    pending.release({ port: 43850 })
    assert.equal((await sending).status, { 'room end': 410, leave: 401, 'room identity': 404 }[race], race)
    assert.deepEqual(lines, [])
  }
  console.log('OK need: host stream only, never stored or broadcast; 403/401/400/413/410/429 per seat; shared when forwarded')
}

// What's shared comes from the room (C-snap): join and GET previews list every
// open preview, its port, whether it's forwarded and its title, whatever
// history was pruned. Older plugins ignore the field.
{
  const w = world()
  const page = (await api(w, 'previews', w.host, 'POST', { port: 43400, title: 'App' })).pid
  const forwarded = await api(w, 'previews', w.host, 'POST', { port: 43401, tcp: true })
  assert.deepEqual(Object.keys(forwarded).sort(), ['pid', 'tcp']); assert.equal(forwarded.tcp, true)
  w.room.events = [] // pruned past the history limit
  const joined = await api(w, 'join', '', 'POST', { name: 'Late' })
  const shared = [{ pid: page, port: 43400, tcp: false, title: 'App' }, { pid: forwarded.pid, port: 43401, tcp: true, title: 'localhost:43401' }]
  assert.deepEqual(joined.previews, shared)
  for (const bearer of [joined.token, w.host]) assert.deepEqual(await api(w, 'previews', bearer), { previews: shared })
  assert.equal((await call(w, 'previews', 'invalid')).status, 401)
  await api(w, 'previews', w.host, 'POST', { port: 43400, tcp: true })
  assert.deepEqual(w.room.events.filter(e => e.type === 'preview').map(e => [e.body.state, e.body.pid, e.body.tcp]), [['open', page, true]], 'forwarding is said again')
  await api(w, `previews/${page}/end`, w.host, 'POST')
  assert.deepEqual((await api(w, 'previews', w.guest)).previews.map(p => p.pid), [forwarded.pid], 'open previews only')
  await api(w, 'end', w.host, 'POST')
  assert.equal((await call(w, 'previews', w.guest)).status, 410)
  console.log('OK what is shared: join and GET previews from current state, { pid, tcp } answers, an open event per opening and forwarding')
}

const enterLink = async (w, pid, bearer = w.guest, path = '/') => new URL((await api(w, `previews/${pid}/ticket`, bearer, 'POST', { path })).url)
const enter = (w, url, cookie, at = Date.now()) => previewRequest(w.room, new Request(url, { headers: cookie ? { cookie } : {} }), at)
const cookieOf = result => result.response.headers.get('set-cookie')?.split(';')[0]
// The clearing page's next link (D2-3).
const nextOf = (html, base) => new URL(/url=([^"]+)"/.exec(html)[1].replaceAll('&amp;', '&'), base)
const clears = response => response.status === 200 && response.headers.get('clear-site-data') === '"cache", "cookies", "storage"' && !response.headers.get('set-cookie')
// A browser entering as one does: not yet in this room's previews, it
// passes the clearing page, clears (its cookies go) and follows the next link.
async function admit(w, url, cookie) {
  const first = await enter(w, url, cookie)
  return clears(first.response) ? enter(w, nextOf(await first.response.text(), url)) : first
}

// Links (tickets) are kept with the room, so one minted before the room slept
// or the server restarted still opens, and go when they expire. Minting is
// counted per seat and per room before the body is read, the body is bounded,
// and a seat keeps its newest 16 links, the room its newest 128: past that the
// oldest goes, a used one first, rather than refusing anyone (D2-8).
{
  const w = world(), pid = (await api(w, 'previews', w.host, 'POST', { port: 43410 })).pid, seat = w.room.auth(w.guest).seat
  const url = await enterLink(w, pid, w.guest, '/page?x=1')
  assert.equal(url.searchParams.get('pid'), pid)
  const saved = structuredClone(w.room.toJSON())
  assert.deepEqual(saved.tickets[url.searchParams.get('ticket')], { pid, exp: saved.tickets[url.searchParams.get('ticket')].exp, path: '/page?x=1', seat })
  const copy = { room: Room.resume(saved, Date.now()) }
  assert.equal(copy.room.previewKey, w.room.previewKey, 'the preview key is kept with the room')
  const entered = await admit(copy, url)
  assert.equal(entered.response.status, 302); assert.equal(entered.response.headers.get('location'), '/page?x=1')
  assert.deepEqual(copy.room.previewSessions.get(cookieOf(entered).split('.')[1]), { pid, exp: copy.room.previewSessions.get(cookieOf(entered).split('.')[1]).exp, seat })
  // Expired: pruned by the next request, and gone from what's saved.
  const later = Date.now() + 10 * 60_000 + 1
  await roomRequest(w.room, request(w, '', w.guest), '', later, 'https://room.test', { isCurrent: () => true })
  assert.equal(w.room.tickets.size, 0); assert.equal(w.room.toJSON().tickets, undefined)
  // The seat's minute: PUBLIC_LIMITS.seatMints, then a 429 before the body.
  for (let i = 1; i < PUBLIC_LIMITS.seatMints; i++) await enterLink(w, pid)
  const limited = held(w, `previews/${pid}/ticket`, w.guest)
  const refused = await send(w, limited.req)
  assert.equal(refused.status, 429); assert.equal(limited.reads, 0); assert.match((await refused.json()).error, /Too many preview links/)
  assert.equal([...w.room.tickets.values()].filter(t => t.seat === seat).length, PUBLIC_LIMITS.seatTickets, "a seat's newest links are kept")
  assert.equal((await call(w, `previews/${pid}/ticket`, w.host, 'POST', { path: '/' })).status, 200, 'another seat still mints')
  // The room's minute: PUBLIC_LIMITS.roomMints across seats.
  const r = world(), rpid = (await api(r, 'previews', r.host, 'POST', { port: 43411 })).pid
  const seats = Array.from({ length: Math.ceil(PUBLIC_LIMITS.roomMints / PUBLIC_LIMITS.seatMints) + 1 }, (_, i) => r.room.join(`Minter ${i}`, Date.now(), PLUGIN_LATEST).token)
  let minted = 0
  for (const bearer of seats) for (let i = 0; i < PUBLIC_LIMITS.seatMints; i++) if ((await call(r, `previews/${rpid}/ticket`, bearer, 'POST', {})).status === 200) minted++
  assert.equal(minted, PUBLIC_LIMITS.roomMints)
  // The room keeps PUBLIC_LIMITS.roomTickets links at most: past that its
  // oldest goes, a used one first, and a seat with none of its own (the host,
  // a late guest) still mints (server-8).
  const full = world(), fpid = (await api(full, 'previews', full.host, 'POST', { port: 43412 })).pid, start = Date.now()
  for (let i = 0; i < PUBLIC_LIMITS.roomTickets; i++) full.room.tickets.set(`filler${i}`, { pid: fpid, exp: start + 60_000 + i, path: '/', seat: `seat${i}`, ...(i === 100 ? { used: true } : {}) })
  for (const bearer of [full.guest, full.host]) assert.equal((await call(full, `previews/${fpid}/ticket`, bearer, 'POST', {})).status, 200)
  assert.equal(full.room.tickets.size, PUBLIC_LIMITS.roomTickets)
  assert.deepEqual(['filler100', 'filler0', 'filler1'].map(t => full.room.tickets.has(t)), [false, false, true], 'the used link went first, then the oldest')
  // A body past its bound: 413, read no further. A malformed one opens the root.
  const large = held(w, `previews/${pid}/ticket`, w.host)
  large.req.headers.set('content-length', String(17_000))
  assert.equal((await send(w, large.req)).status, 413); assert.equal(large.reads, 0)
  const root = await send(w, request(w, `previews/${pid}/ticket`, w.host, 'POST', '{'))
  assert.equal(w.room.tickets.get(new URL((await root.json()).url).searchParams.get('ticket')).path, '/')
  console.log('OK links kept with the room (reload, restart), pruned on expiry; seat/room mint limits before the body; newest 16 per seat, 128 per room, the oldest going (used first)')
}

// /__share/enter: a used link brings back only the browser that used it, to
// that link's own preview; an unknown one, only to the preview its URL names
// and only a browser already in it. Browser sessions carry their seat: a seat
// keeps its newest 4 per preview, and Leave (or the seat dropped for good)
// ends them, and its links (D2-4). Sessions saved before seats were kept stay
// until they expire.
{
  const w = world(), seat = w.room.auth(w.guest).seat
  const a = (await api(w, 'previews', w.host, 'POST', { port: 43420 })).pid, b = (await api(w, 'previews', w.host, 'POST', { port: 43421 })).pid
  const first = await enterLink(w, a, w.guest, '/a'), opened = await admit(w, first), cookie = cookieOf(opened), sid = cookie.split('.')[1]
  assert.equal(w.room.previewSessions.get(sid).seat, seat)
  assert.equal((await enter(w, first, cookie)).response.headers.get('location'), '/a', 'a reload goes back')
  assert.equal((await enter(w, first)).response.status, 403, 'another browser does not')
  const other = await enterLink(w, b, w.guest, '/b')
  await enter(w, other)
  assert.equal((await enter(w, other, cookie)).response.status, 403, "never into a preview the link wasn't for")
  const gone = new URL(first)
  gone.searchParams.set('ticket', 'x'.repeat(24))
  assert.equal((await enter(w, gone, cookie)).response.headers.get('location'), '/', 'an expired link: its own preview, for a browser in it')
  gone.searchParams.set('pid', b)
  assert.equal((await enter(w, gone, cookie)).response.status, 403)
  gone.searchParams.delete('pid')
  assert.equal((await enter(w, gone, cookie)).response.status, 403, 'a link that names no preview takes nobody anywhere')
  const live = c => previewSocketTarget(w.room, new Request('https://preview.test/live', { headers: { cookie: c } }), Date.now()).ok
  const cookies = [cookie]
  for (let i = 0; i < PUBLIC_LIMITS.seatSessions; i++) cookies.push(cookieOf(await admit(w, await enterLink(w, a))))
  assert.deepEqual(cookies.map(live), [false, true, true, true, true], 'the oldest of five goes')
  assert(live(cookieOf(await admit(w, await enterLink(w, b)))), 'another preview counts apart')
  const hostCookie = cookieOf(await admit(w, await enterLink(w, a, w.host)))
  const peer = w.room.join('Peer', Date.now(), PLUGIN_LATEST), peerCookie = cookieOf(await admit(w, await enterLink(w, a, peer.token)))
  w.room.previewSessions.set('legacy', { pid: a, exp: Date.now() + 60_000 })
  const legacy = `cs_pv=${w.room.previewKey}.legacy`
  // Made before the Leave: its links go with it, unused or used (D2-4).
  const pending = await enterLink(w, a)
  const pair = previewSocketTarget(w.room, new Request('https://preview.test/live', { headers: { cookie: cookies[1] } }), Date.now())
  assert(publicPairValid(w.room, pair, Date.now()))
  await api(w, 'leave', w.guest, 'POST')
  assert.deepEqual(cookies.map(live), [false, false, false, false, false])
  assert.equal(publicPairValid(w.room, pair, Date.now()), false, "the seat's sockets end with its sessions")
  assert(live(hostCookie)); assert(live(peerCookie)); assert(live(legacy), 'a session without a seat stays until it expires')
  assert.equal([...w.room.tickets.values()].some(t => t.seat === seat), false, "the seat's links went with it")
  const sessions = w.room.previewSessions.size
  assert.equal((await enter(w, pending)).response.status, 403, 'a link made before its seat left opens nothing')
  assert.equal(w.room.previewSessions.size, sessions, 'and makes no session')
  w.room.sweepGrants(Date.now() + 60_001)
  assert.equal(live(legacy), false); assert(w.room.previewSessions.size > 0)
  // A seat dropped from the away list for good takes its browsers too.
  const r = world(), rpid = (await api(r, 'previews', r.host, 'POST', { port: 43422 })).pid, away = cookieOf(await admit(r, await enterLink(r, rpid)))
  for (let i = 0; i < 100; i++) r.room.join(`Away ${i}`, Date.now(), PLUGIN_LATEST)
  const rlive = c => previewSocketTarget(r.room, new Request('https://preview.test/live', { headers: { cookie: c } }), Date.now()).ok
  r.room.sweep(Date.now() + SEAT_TIMEOUT_MS + 1)
  assert.equal(r.room.away.size, 100); assert.equal(rlive(away), false)
  console.log('OK enter never switches preview; sessions carry seats, newest 4 per preview; Leave and the away drop end them, their sockets and links')
}

// A link dies with its seat (D2-4, server-11): one the seat made, kept from
// before it left (a room saved then, a link handed on), opens nothing, and a
// browser session whose seat is gone carries no socket, whatever made it.
{
  const w = world(), pid = (await api(w, 'previews', w.host, 'POST', { port: 43425 })).pid, seat = w.room.auth(w.guest).seat
  const url = await enterLink(w, pid)
  const ticket = w.room.tickets.get(url.searchParams.get('ticket'))
  w.room.seats.clear() // the seat is gone, its link not revoked
  const before = w.room.previewSessions.size
  assert.equal((await admit(w, url)).response.status, 403)
  assert.equal(w.room.previewSessions.size, before); assert.equal(ticket.used, undefined, 'not spent either')
  w.room.previewSessions.set('departed', { pid, exp: Date.now() + 60_000, seat })
  const departed = { pid, session: 'departed', ownerSeat: seat }
  assert.equal(publicPairValid(w.room, departed, Date.now()), false, "a session whose seat left carries no socket")
  assert.equal(previewSocketTarget(w.room, new Request('https://preview.test/live', { headers: { cookie: `cs_pv=${w.room.previewKey}.departed` } }), Date.now()).ok, false)
  assert.equal((await previewRequest(w.room, new Request('https://preview.test/', { headers: { cookie: `cs_pv=${w.room.previewKey}.departed` } }), Date.now())).response.status, 404, 'nor any request')
  // Away within its grace, a seat is still the room's: its link opens.
  const r = world(), rpid = (await api(r, 'previews', r.host, 'POST', { port: 43426 })).pid, rurl = await enterLink(r, rpid)
  r.room.sweep(Date.now() + SEAT_TIMEOUT_MS + 1)
  assert.equal(r.room.seats.size, 0); assert.equal(r.room.away.size, 1)
  assert.equal((await admit(r, rurl)).response.status, 302)
  console.log('OK a link dies with its seat: refused at enter, unspent, and a departed seat\'s session carries no socket or request')
}

// One browser holds one of its seat's places (server-5): a fresh link the
// same browser enters (a pane opening the host's next page) goes on in the
// session it has for that preview, so a seat's other browser isn't let go.
{
  const w = world(), pid = (await api(w, 'previews', w.host, 'POST', { port: 43427 })).pid, other = (await api(w, 'previews', w.host, 'POST', { port: 43428 })).pid
  const own = cookieOf(await admit(w, await enterLink(w, pid, w.guest, '/own'))), pane = cookieOf(await admit(w, await enterLink(w, pid, w.guest, '/1')))
  const live = c => previewSocketTarget(w.room, new Request('https://preview.test/live', { headers: { cookie: c } }), Date.now()).ok
  for (let i = 2; i <= 6; i++) {
    const entered = (await enter(w, await enterLink(w, pid, w.guest, `/${i}`), pane)).response
    assert.equal(entered.status, 302); assert.equal(entered.headers.get('location'), `/${i}`)
    assert.equal(entered.headers.get('set-cookie').split(';')[0], pane, 'the same session')
  }
  assert(live(own), "the seat's other browser is still in"); assert(live(pane))
  assert.equal([...w.room.previewSessions.values()].filter(s => s.pid === pid).length, 2)
  // A link for another preview, or another seat's, is a session of its own.
  const elsewhere = cookieOf(await enter(w, await enterLink(w, other), pane))
  assert.notEqual(elsewhere, pane); assert(live(elsewhere)); assert(live(pane))
  const host = cookieOf(await enter(w, await enterLink(w, pid, w.host), pane))
  assert.notEqual(host, pane)
  console.log('OK one browser, one place: a fresh link in a browser already in that preview keeps its session')
}

// …and renews it (S3-1): a pane in use all day enters the host's next page at
// 12 hours less a minute, and that page serves 12 hours from then, as a
// session of its own would; a socket opened before keeps the expiry it had
// (the browser opens it again under the renewed session). On a set clock,
// links' minting included.
{
  const real = Date.now
  let clock = real()
  Date.now = () => clock
  try {
    const H = 60 * 60_000, t0 = clock, w = world(), pid = (await api(w, 'previews', w.host, 'POST', { port: 43429 })).pid
    w.room.subscribers.add({ seat: 'host', send: m => { if (m.proxy) w.room.proxied.get(m.proxy.id)?.(new Response(`page ${m.proxy.path}`)) }, push() {} })
    const cookie = cookieOf(await admit(w, await enterLink(w, pid, w.guest, '/a')))
    const target = at => previewSocketTarget(w.room, new Request('https://preview.test/live', { headers: { cookie } }), at)
    const page = async at => (await previewRequest(w.room, new Request('https://preview.test/b', { headers: { cookie } }), at)).response
    const before = target(clock)
    clock = t0 + 12 * H - 60_000
    const renewing = (await enter(w, await enterLink(w, pid, w.guest, '/b'), cookie, clock)).response
    assert.equal(renewing.status, 302); assert.equal(cookieOf({ response: renewing }), cookie, 'the same session')
    for (const at of [t0 + 12 * H + 60_000, t0 + 24 * H - 2 * 60_000]) {
      clock = at
      const r = await page(at)
      assert.equal(r.status, 200, `${(at - t0) / H} h`); assert.equal(await r.text(), 'page /b')
    }
    assert.equal(publicPairValid(w.room, before, clock), false, 'a socket opened before keeps its own expiry')
    assert(publicPairValid(w.room, target(clock), clock), 'and opens again under the renewed session')
    clock = t0 + 24 * H
    assert.equal((await page(clock)).status, 404, '12 hours after the renewing link, it ends')
    // A link entered again after it was used renews nothing: only a new one does.
    const r = world(), rpid = (await api(r, 'previews', r.host, 'POST', { port: 43424 })).pid, start = clock
    const link = await enterLink(r, rpid), used = cookieOf(await admit(r, link))
    const sid = used.split('.')[1], exp = r.room.previewSessions.get(sid).exp
    clock = start + 5 * 60_000
    assert.equal((await enter(r, link, used, clock)).response.status, 302)
    assert.equal(r.room.previewSessions.get(sid).exp, exp)
  } finally { Date.now = real }
  console.log('OK a new link renews the session it goes on in, 12 hours from that link; a socket opened before keeps its own expiry; a used link renews nothing')
}

// The preview host name is every room's: no service worker registers there,
// and a browser not already in this room's previews (another room's cookie,
// other cookies, or none: a quit browser keeps an app's storage and drops
// cs_pv) has the host name's state cleared before this room's cookie is set,
// by a page that sets nothing, then a second single-use link (D2-3).
{
  const w = world(), pid = (await api(w, 'previews', w.host, 'POST', { port: 43430 })).pid
  const own = cookieOf(await admit(w, await enterLink(w, pid)))
  for (const value of ['script', ' Script ']) {
    const sw = await previewRequest(w.room, new Request('https://preview.test/sw.js', { headers: { 'service-worker': value, cookie: own } }), Date.now())
    assert.equal(sw.response.status, 403)
  }
  assert.equal(w.room.proxied.size, 0, 'the host is never asked')
  for (const cookie of [`cs_pv=${token(16)}.elsewhere; app=1`, 'app=1; theme=dark', `cs_pv=${token(16)}.${own.split('.')[1]}`, '_ga=GA1.2.3', undefined]) {
    const url = await enterLink(w, pid, w.guest, '/start')
    const clearing = (await enter(w, url, cookie)).response
    assert(clears(clearing), `cleared for ${cookie ?? 'no cookie at all'}`)
    const next = nextOf(await clearing.text(), url)
    assert.equal(next.pathname, '/__share/enter'); assert.notEqual(next.searchParams.get('ticket'), url.searchParams.get('ticket'))
    assert.equal((await enter(w, url, cookie)).response.status, 403, 'the first link is spent')
    // Its state may still be there (a browser that doesn't clear): no loop.
    const entered = (await enter(w, next, cookie)).response
    assert.equal(entered.status, 302); assert.equal(entered.headers.get('location'), '/start'); assert.match(entered.headers.get('set-cookie'), /^cs_pv=/)
    assert.equal((await enter(w, next)).response.status, 403, 'the second link is single-use too')
  }
  const same = (await enter(w, await enterLink(w, pid), `${own}; app=1`)).response
  assert.equal(same.status, 302); assert.equal(same.headers.get('clear-site-data'), null, "this room's own state stays")
  // A cookie set before rooms had keys names this room by its id (S3-3): it's
  // this room's state, not cleared, and the session goes on under one that
  // names the key; nothing new carries the id.
  const r = world(), rpid = (await api(r, 'previews', r.host, 'POST', { port: 43431 })).pid, mine = cookieOf(await admit(r, await enterLink(r, rpid)))
  const legacy = `cs_pv=${r.room.id}.${mine.split('.')[1]}`
  const kept = (await enter(r, await enterLink(r, rpid), `${legacy}; app=1`)).response
  assert.equal(kept.status, 302); assert.equal(kept.headers.get('clear-site-data'), null)
  assert.equal(kept.headers.get('set-cookie').split(';')[0], mine, 'its session, under the key')
  console.log('OK the shared preview host name: no service workers; anything but this room’s cookie cleared before a cookie, by a second single-use link; one naming the room id from before keys is this room’s')
}

// Proxied answers: format 2 (one JSON line, then the body) when the ask says
// `answer: 2`, the 0.11.24 headers otherwise. Malformed, or over what a
// preview carries: the host hears 400/413 and the browser gets a 502 page at
// once. A room has PUBLIC_LIMITS.proxied requests waiting at most.
{
  const w = world(), pid = (await api(w, 'previews', w.host, 'POST', { port: 43440 })).pid
  const lines = []
  w.room.subscribers.add({ seat: 'host', tcpSupport: true, send: m => lines.push(m), push() {} })
  const cookie = cookieOf(await admit(w, await enterLink(w, pid)))
  const ask = (path = '/', init = {}) => {
    const pending = previewRequest(w.room, new Request(`https://preview.test${path}`, { ...init, headers: { cookie, ...init.headers } }), Date.now())
    return { pending: pending.then(r => r.response) }
  }
  const asked = () => lines.filter(m => m.proxy).at(-1).proxy
  const answer = (id, body, headers = {}) => send(w, new Request(`https://room.test/api/rooms/${w.room.id}/proxy/${id}`, { method: 'POST', headers: { authorization: `Bearer ${w.host}`, 'x-shared-session-version': PLUGIN_LATEST, ...headers }, body }))
  const two = (head, body = '') => Buffer.concat([Buffer.from(typeof head === 'string' ? head : JSON.stringify(head)), Buffer.from('\n'), Buffer.from(body)])
  let q = ask('/x?a=1', { method: 'POST', body: 'ping' })
  await new Promise(resolve => setImmediate(resolve))
  const proxy = asked()
  assert.equal(proxy.answer, 2); assert.equal(proxy.path, '/x?a=1'); assert.equal(Buffer.from(proxy.body, 'base64').toString(), 'ping')
  assert.equal((await answer(proxy.id, two({ status: 201, headers: [['Content-Type', 'text/plain'], ['set-cookie', 'a=1'], ['set-cookie', 'b=2'], ['location', 'http://localhost:43440/next'], ['connection', 'close'], ['content-length', '99'], ['bad name', 'x']] }, 'hé\nllo'), { 'x-proxy-format': '2' })).status, 200)
  let res = await q.pending
  assert.equal(res.status, 201); assert.equal(await res.text(), 'hé\nllo')
  assert.deepEqual(res.headers.getSetCookie(), ['a=1', 'b=2']); assert.equal(res.headers.get('location'), '/next'); assert.equal(res.headers.get('connection'), null)
  q = ask('/old')
  const block = Buffer.from('HTTP/1.1 302 Found\r\nLocation: http://localhost:1/a\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-App: 1\r\n\r\n').toString('base64')
  assert.equal((await answer(asked().id, 'page', { 'x-proxy-status': '200', 'x-proxy-headers': block })).status, 200, 'a 0.11.24 host still answers')
  res = await q.pending
  assert.equal(res.status, 200); assert.equal(res.headers.get('x-app'), '1'); assert.equal(await res.text(), 'page')
  for (const [status, expected] of [[205, 205], [99, 502], [600, 502]]) {
    q = ask('/s')
    await answer(asked().id, two({ status, headers: [] }, 'body'), { 'x-proxy-format': '2' })
    res = await q.pending
    assert.equal(res.status, expected); if (status === 205) assert.equal(await res.text(), '')
  }
  const head = { status: 200, headers: [] }
  for (const bad of [Buffer.from('{"status":200,"headers":[]}'), two('not json'), two('[]'), two({ status: '200', headers: [] }), two({ status: 200, headers: [['a']] }), two({ status: 200, headers: [['a', 1]] }), two({ status: 200 }),
    Buffer.concat([Buffer.from(JSON.stringify({ status: 200, headers: [['x', 'y'.repeat(70_000)]] })), Buffer.from('\nbody')]), Buffer.from([0xff, 0x0a, 0x41])]) {
    q = ask('/bad')
    const posted = await answer(asked().id, bad, { 'x-proxy-format': '2' })
    assert.equal(posted.status, 400)
    res = await q.pending
    assert.equal(res.status, 502); assert.match(await res.text(), /could not be read/)
  }
  // Over what a preview carries, either format: 413 to the host, 502 at once.
  for (const [body, headers] of [[new Uint8Array(20 * 1024 * 1024 + 1), {}], [two(head, Buffer.alloc(20 * 1024 * 1024 + 1)), { 'x-proxy-format': '2' }]]) {
    q = ask('/big')
    const started = Date.now()
    assert.equal((await answer(asked().id, body, headers)).status, 413)
    res = await q.pending
    assert.equal(res.status, 502); assert.match(await res.text(), /over 20 MB/); assert(Date.now() - started < 5000)
  }
  q = ask('/declared')
  const declared = new Request(`https://room.test/api/rooms/${w.room.id}/proxy/${asked().id}`, { method: 'POST', headers: { authorization: `Bearer ${w.host}`, 'content-length': String(21 * 1024 * 1024) }, body: new ReadableStream({ pull() { throw new Error('read past a declared length') } }), duplex: 'half' })
  assert.equal((await send(w, declared)).status, 413); assert.equal((await q.pending).status, 502)
  assert.equal((await answer('nobody', two(head), { 'x-proxy-format': '2' })).status, 410)
  q = ask('/guest')
  assert.equal((await send(w, new Request(`https://room.test/api/rooms/${w.room.id}/proxy/${asked().id}`, { method: 'POST', headers: { authorization: `Bearer ${w.guest}` }, body: two(head) }))).status, 403)
  w.room.proxied.get(asked().id)(new Response('done'))
  await q.pending
  // PUBLIC_LIMITS.proxied in flight: then a 503 page, without asking the host.
  for (let i = 0; i < PUBLIC_LIMITS.proxied; i++) w.room.proxied.set(`waiting${i}`, () => {})
  const before = lines.length
  res = (await previewRequest(w.room, new Request('https://preview.test/one-more', { headers: { cookie } }), Date.now())).response
  assert.equal(res.status, 503); assert.match(await res.text(), /busy/); assert.equal(lines.length, before)
  console.log('OK proxied answers: format 2 and the 0.11.24 form; malformed or oversized give the browser a 502 at once; 512 waiting per room')
}

// Public sockets: PUBLIC_LIMITS.seatPairs per cookie session's seat and
// roomPairs per room, pending and paired alike; a session from before seats
// counts as one of its own.
{
  const w = world(), pid = (await api(w, 'previews', w.host, 'POST', { port: 43450 })).pid, seat = w.room.auth(w.guest).seat
  const cookie = cookieOf(await admit(w, await enterLink(w, pid)))
  const target = (active, c = cookie) => previewSocketTarget(w.room, new Request('https://preview.test/live', { headers: { cookie: c } }), Date.now(), active)
  const t = target([])
  assert.equal(t.ok, true); assert.equal(t.ownerSeat, seat); assert.equal(t.session, cookie.split('.')[1]); assert.equal(t.exp, w.room.previewSessions.get(t.session).exp)
  const mine = n => Array.from({ length: n }, () => ({ ownerSeat: seat })), others = n => Array.from({ length: n }, () => ({ ownerSeat: 'other' }))
  assert.equal(target(mine(PUBLIC_LIMITS.seatPairs - 1)).ok, true)
  assert.deepEqual(target(mine(PUBLIC_LIMITS.seatPairs)), { ok: false, status: 429, error: 'Too many preview connections.' })
  assert.equal(target(others(PUBLIC_LIMITS.roomPairs - 1)).ok, true)
  assert.equal(target(others(PUBLIC_LIMITS.roomPairs)).status, 429)
  w.room.previewSessions.set('legacy', { pid, exp: Date.now() + 60_000 })
  const legacy = target(mine(PUBLIC_LIMITS.seatPairs), `cs_pv=${w.room.previewKey}.legacy`)
  assert.equal(legacy.ok, true); assert.equal(legacy.ownerSeat, 'session:legacy')
  assert.equal(PUBLIC_LIMITS.seatPairs, 32); assert.equal(PUBLIC_LIMITS.roomPairs, 128); assert.equal(PUBLIC_LIMITS.pairMs, 10_000); assert.equal(PUBLIC_LIMITS.proxied, 512)
  console.log('OK public sockets: 32 per seat and 128 per room, pending and paired; a seatless session counts alone')
}

// A grant refused for the seat's minute changes nothing to save (the
// adapters persist the room's counters on their own when they moved). The
// JSON routes take MAX_BODY characters as before, their bytes bounded at
// three a character: past it, 413 rather than a crash.
{
  const w = world(), pid = (await api(w, 'previews', w.host, 'POST', { port: 43460, tcp: true })).pid
  for (let i = 0; i < TCP_LIMITS.seatOpensPerMinute; i++) await api(w, `previews/${pid}/tunnel`, w.guest, 'POST')
  const counters = JSON.stringify(w.room.tcpStats)
  const refused = await roomRequest(w.room, request(w, `previews/${pid}/tunnel`, w.guest, 'POST'), `previews/${pid}/tunnel`, Date.now(), 'https://room.test', { isCurrent: () => true })
  assert.equal(refused.response.status, 429); assert.equal(refused.changed, undefined); assert.equal(JSON.stringify(w.room.tcpStats), counters)
  const wide = JSON.stringify({ events: [{ type: 'chat', body: { text: '界'.repeat(30_000) } }] })
  assert((await call(w, 'events', w.host, 'POST', wide)).ok, 'wide characters that fit before still fit')
  assert.equal((await call(w, 'events', w.host, 'POST', ' '.repeat(512_001))).status, 413)
  let reads = 0
  const flood = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(1024 * 1024)) } }, { highWaterMark: 0 })
  assert.equal((await send(w, new Request(request(w, 'events', w.host, 'POST'), { body: flood, duplex: 'half' }))).status, 413)
  assert.equal(reads, 2, 'refused once past the bound, read no further')
  assert.equal((await send(w, new Request(request(w, 'files', w.host, 'POST'), { body: new Uint8Array(10 * 1024 * 1024 + 1) }))).status, 413)
  console.log('OK refused grants change nothing; JSON and file bodies bounded in bytes as they arrive')
}

// Events are bounded by their bytes, nested values too (D2-5, server-3): a
// guest's past the cap is refused whole with a 413, a host's is cut and kept
// (its outbox would post it again and again), and the room's history is
// bounded in bytes beside its count, oldest out first. Sized from real
// events: the e2e's long session's rows (31.5 KB) and a 32,000-character CJK
// reply fit unchanged.
{
  const w = world(), post = (bearer, events) => call(w, 'events', bearer, 'POST', { events }), fromHost = { seat: 'host', name: 'Host', role: 'host' }
  const rows = () => w.room.events.filter(e => e.type === 'row' || e.type === 'chat')
  const longRow = { kind: 'assistant', text: `Answer 1. ${'帮我看看这个问题，然后修一下。'.repeat(700)}` }
  const reply = { kind: 'assistant', text: '界'.repeat(32_000) }
  assert.equal((await post(w.host, [{ type: 'row', body: longRow }, { type: 'row', body: reply }])).status, 200)
  assert.deepEqual(rows().map(e => e.body), [longRow, reply], "the plugin's largest rows are kept as they are")
  // Nested strings are cut as top-level ones always were; the hole before 0.11.25 was
  // a nested one kept whole.
  assert.equal((await post(w.guest, [{ type: 'chat', body: { text: 'hi', blob: ['x'.repeat(300_000)] } }])).status, 200)
  assert.equal(rows().at(-1).body.blob[0].length, 32_000 + '\n…(cut)'.length)
  // Past the cap once clamped: a guest's post is refused whole, nothing kept.
  const wide = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, '界'.repeat(32_000)]))
  const before = w.room.events.length, seq = w.room.seq
  const refused = await post(w.guest, [{ type: 'chat', body: { text: 'first' } }, { type: 'chat', body: wide }])
  assert.equal(refused.status, 413); assert.match((await refused.json()).error, /limited to 128 KB/)
  assert.equal(w.room.events.length, before); assert.equal(w.room.seq, seq, 'nothing of that post is kept')
  // A host's is cut to fit and kept: its post succeeds.
  assert.equal((await post(w.host, [{ type: 'row', body: { kind: 'assistant', text: 'short', ...wide } }])).status, 200)
  const cut = rows().at(-1).body
  assert(Buffer.byteLength(JSON.stringify(cut)) <= EVENT_BYTES); assert.equal(cut.kind, 'assistant'); assert.equal(cut.text, 'short')
  assert.match(cut.f0, /…\(cut\)$/)
  const keys = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, i]))
  assert.equal((await post(w.host, [{ type: 'row', body: keys }])).status, 200)
  assert.deepEqual(rows().at(-1).body, { cut: true }, 'past it whatever its strings: a marker')
  // Nesting past what JSON.stringify can recurse (JSON.parse takes it): cut,
  // so the room is sent and saved as before. A room before 0.11.25 kept it, and the
  // next save threw (on Node, in a timer: the process ended).
  const deep = `{"events":[{"type":"chat","body":{"x":${'['.repeat(100_000)}${']'.repeat(100_000)}}}]}`
  assert.equal((await call(w, 'events', w.guest, 'POST', deep)).status, 200)
  assert.doesNotThrow(() => JSON.stringify(w.room.toJSON())); assert.doesNotThrow(() => JSON.stringify(w.room.page(0, Date.now())))
  let depth = 0
  for (let v = rows().at(-1).body.x; Array.isArray(v); v = v[0]) depth++
  assert(depth < 40, `nested ${depth} deep`)
  // The history in bytes beside its count, oldest out first; live ones too.
  const h = world(), big = { kind: 'assistant', text: 'x'.repeat(30_000) }
  for (let i = 0; i < 700; i++) h.room.append(fromHost, 'row', { ...big, i }, Date.now())
  const sum = h.room.events.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 1, 0)
  assert(sum <= HISTORY_BYTES, `${sum} bytes kept`); assert.equal(h.room.eventBytes, sum, 'kept count of bytes')
  assert(h.room.events.length < 700 && h.room.events.at(-1).body.i === 699, 'the newest kept, the oldest gone')
  for (let i = 0; i < 400; i++) h.room.append(fromHost, 'delta', { turnId: 't', text: 'y'.repeat(30_000) }, Date.now())
  assert(h.room.live.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 1, 0) <= 2 * 1024 * 1024)
  // A room saved with more (before the bound) is cut to it as it loads.
  const saved = h.room.toJSON()
  saved.events = Array.from({ length: 1000 }, (_, i) => ({ seq: i + 1, type: 'row', from: fromHost, ts: 0, body: { ...big, i } }))
  const loaded = Room.resume(saved, Date.now())
  assert(loaded.eventBytes <= HISTORY_BYTES && loaded.events.at(-1).body.i === 999)
  console.log('OK events bounded in bytes: nested strings and depth clamped; a guest past 128 KB refused whole, a host cut and kept; history 16 MB and live bounded')
}

// A link's page is made safe as the link is made (D2-8, server-10): bytes
// outside printable ASCII percent-encoded, at most 2048, so the redirect can
// always be built; and it's built before the link is spent or a session made.
{
  const w = world(), pid = (await api(w, 'previews', w.host, 'POST', { port: 43470 })).pid
  for (const [path, stored] of [['/日本', '/%E6%97%A5%E6%9C%AC'], ['/👍?q=é', '/%F0%9F%91%8D?q=%C3%A9'], ['/a b\u0001', '/a%20b%01'], ['/\\evil.com', '/%5Cevil.com'],
    ['/%E6%97%A5', '/%E6%97%A5'], ['//evil.com', '/'], ['/\ud800', '/%EF%BF%BD'], [`/${'a'.repeat(2047)}`, `/${'a'.repeat(2047)}`], [`/${'a'.repeat(2048)}`, '/'], [`/${'日'.repeat(700)}`, '/'], ['relative', '/'], [7, '/']]) {
    const url = await enterLink(w, pid, w.guest, path)
    assert.equal(w.room.tickets.get(url.searchParams.get('ticket')).path, stored, JSON.stringify(path))
    const entered = await admit(w, url)
    assert.equal(entered.response.status, 302); assert.equal(entered.response.headers.get('location'), stored)
  }
  // One saved before (any path at all): encoded as it's used, never a throw.
  w.room.tickets.set('legacy-link', { pid, exp: Date.now() + 60_000, path: '/日本', seat: w.room.auth(w.guest).seat })
  const legacy = await admit(w, new URL(`https://preview.test/__share/enter?room=${w.room.previewKey}&ticket=legacy-link&pid=${pid}`))
  assert.equal(legacy.response.headers.get('location'), '/%E6%97%A5%E6%9C%AC')
  // Should the answer fail to be made (a guest's browser entering the host's
  // link: a session of its own), the link stays unspent and no session is made.
  const cookie = cookieOf(await admit(w, await enterLink(w, pid)))
  const url = await enterLink(w, pid, w.host, '/boom'), ticket = w.room.tickets.get(url.searchParams.get('ticket')), sessions = w.room.previewSessions.size
  const NativeResponse = globalThis.Response
  globalThis.Response = class extends NativeResponse { constructor(body, init) { if (new Headers(init?.headers).get('location') === '/boom') throw new TypeError('not a header value'); super(body, init) } }
  try { await assert.rejects(previewRequest(w.room, new Request(url, { headers: { cookie } }), Date.now())) } finally { globalThis.Response = NativeResponse }
  assert.equal(ticket.used, undefined, 'not spent'); assert.equal(w.room.previewSessions.size, sessions, 'no session made')
  console.log('OK link pages percent-encoded outside printable ASCII and capped at 2048 bytes; the answer made before the link is spent')
}

// What's kept with a room in its one Durable Object value (`meta`, 2 MB at
// most) stays under 1 MiB with every cap at its maximum (D2-8, server-4,
// server-missed-2 and -3): links (128, pages of 2048 bytes, clearing links
// counted like any), browser sessions (256 a room) and TCP grants (128),
// previews (128), seats and the away list, names and titles at their
// longest, measured as the Worker writes it (metaOf). The Worker keeps each
// file's record beside its bytes (tcp-worker.mjs checks that it does), so a
// room takes them past round 2's 512, up to as many as 100 MB of 10 KB files
// (S3-2), and meta the newest 512 of them as well, for a rollback to 0.11.24:
// those at their longest too, a name's 120 characters of three bytes and a
// type's 100 of two (a type's control characters, six bytes each in JSON, go).
{
  const worst = n => '\ud800'.repeat(n) // a lone surrogate: six bytes in JSON
  const room = Room.create({ id: token(16), name: worst(80), title: worst(200), now: Date.now(), version: PLUGIN_LATEST, account: 'a'.repeat(64) })
  const w = { room, host: room.host.token, current: true }
  room.tcpSupported = () => true
  for (let round = 0; round < 7; round++) {
    for (let i = room.seats.size; i < ROOM_SEATS_MAX; i++) room.join(worst(80), Date.now(), PLUGIN_LATEST, 'b'.repeat(64))
    if (round < 6) room.sweep(Date.now() + SEAT_TIMEOUT_MS + 1) // all away, kept to the newest 100
  }
  assert.equal(room.seats.size, ROOM_SEATS_MAX); assert.equal(room.away.size, 100)
  const guest = [...room.seats.keys()][0]
  const pids = []
  for (let i = 0; i < ROOM_PREVIEWS_MAX; i++) pids.push((await api(w, 'previews', w.host, 'POST', { port: 40000 + i, title: worst(200), tcp: true })).pid)
  const over = await call(w, 'previews', w.host, 'POST', { port: 39999 })
  assert.equal(over.status, 429); assert.match((await over.json()).error, /Stop one first/)
  const upload = body => send(w, new Request(`https://room.test/api/rooms/${room.id}/files`, { method: 'POST', headers: { authorization: `Bearer ${w.host}`, 'x-file-name': encodeURIComponent('日'.repeat(200)), 'content-type': `${'\x01'.repeat(100)}${'é'.repeat(300)}` }, body }))
  // A long computer-use session's screenshots: never refused for their count
  // while the room's 100 MB hold them.
  for (let i = 0; i < 600; i++) assert.equal((await upload(`file ${i}`)).status, 200, `file ${i + 1}`)
  assert(ROOM_FILES_COUNT >= 100 * 1024 * 1024 / (10 * 1024), 'as many as 100 MB of 10 KB files')
  for (let i = room.files.size; i < ROOM_FILES_COUNT; i++) room.files.set(`f${i}`, { id: `f${i}`, name: 'tiny', type: 'image/png', size: 1, ts: 0 })
  const tooMany = await upload('one more')
  assert.equal(tooMany.status, 413); assert.equal(room.files.size, ROOM_FILES_COUNT)
  assert((await upload('file 0')).ok, 'the same bytes again are no new file')
  // Links at their longest (the links block checks the room keeps 128).
  for (let i = 0; i < PUBLIC_LIMITS.roomTickets; i++) room.tickets.set(token(18), { pid: pids[i], exp: Date.now() + 60_000, path: `/${'a'.repeat(PUBLIC_LIMITS.pathBytes - 1)}`, seat: room.seats.get(guest).id, used: true, clear: true })
  for (let i = 0; i < PUBLIC_LIMITS.roomSessions; i++) room.previewSessions.set(token(18), { pid: pids[i % pids.length], exp: Date.now() + 60_000, seat: room.seats.get(guest).id })
  for (let i = 0; i < TCP_LIMITS.roomCaps; i++) room.previewSessions.set(token(24), { pid: pids[i % pids.length], seat: room.seats.get(guest).id, scope: 'tcp', exp: Date.now() + 60_000 })
  room.tcpStats = { used: 2 ** 40, refunded: 2 ** 40, opens: { start: Date.now(), count: TCP_LIMITS.opensPerMinute } }
  const { meta } = metaOf(room), kept = Object.values(meta.files ?? {})
  const bytes = Buffer.byteLength(JSON.stringify(meta)), records = Buffer.byteLength(JSON.stringify(meta.files ?? {}))
  assert.equal(kept.length, META_FILES)
  assert(bytes < 1024 ** 2, `worst-case meta is ${bytes} bytes`)
  assert(kept.every(f => /^[0-9a-f]{64}$/.test(f.id) && f.name === '日'.repeat(120) && f.type === 'é'.repeat(100)), "the newest files' records, at their longest")
  console.log(`OK a worst-case room's meta is ${(bytes / 1024).toFixed(0)} KiB, under 1 MiB: 128 previews, links, sessions and grants at their caps, and the records of the newest ${META_FILES} of its ${ROOM_FILES_COUNT} files (${(records / 1024).toFixed(0)} KiB)`)
}

// A room keeps its newest 256 browser sessions: the oldest goes, its sockets
// with it, rather than the room's value growing with seats times previews
// (server-missed-3). Clearing links count like any toward a seat's and the
// room's links (server-missed-2).
{
  const w = world(), pid = (await api(w, 'previews', w.host, 'POST', { port: 43480 })).pid
  for (let i = 0; i < PUBLIC_LIMITS.roomSessions; i++) w.room.previewSessions.set(`old${i}`, { pid, exp: Date.now() + 60_000 + i, seat: `seat${i}` })
  const live = sid => previewSocketTarget(w.room, new Request('https://preview.test/live', { headers: { cookie: `cs_pv=${w.room.previewKey}.${sid}` } }), Date.now()).ok
  w.room.seats.set('extra', { id: 'seat0', name: 'Old', joinedAt: 0, lastSeen: Date.now() })
  assert(live('old0'))
  const fresh = cookieOf(await admit(w, await enterLink(w, pid)))
  assert.equal([...w.room.previewSessions.values()].filter(s => s.scope !== 'tcp').length, PUBLIC_LIMITS.roomSessions)
  assert.equal(w.room.previewSessions.has('old0'), false, 'the oldest went'); assert(w.room.previewSessions.has(fresh.split('.')[1]))
  const r = world(), rpid = (await api(r, 'previews', r.host, 'POST', { port: 43481 })).pid, seat = r.room.auth(r.guest).seat
  for (let i = 0; i < PUBLIC_LIMITS.roomTickets - 1; i++) r.room.tickets.set(`filler${i}`, { pid: rpid, exp: Date.now() + 60_000 + i, path: '/', seat: `seat${i}` })
  for (let i = 0; i < 20; i++) {
    const clearing = (await enter(r, await enterLink(r, rpid), `cs_pv=${token(16)}.elsewhere`)).response
    assert(clears(clearing))
    assert(r.room.tickets.size <= PUBLIC_LIMITS.roomTickets, 'the room keeps its newest, clearing links counted')
    assert([...r.room.tickets.values()].filter(t => t.seat === seat).length <= PUBLIC_LIMITS.seatTickets, "and a seat's")
  }
  assert([...r.room.tickets.values()].some(t => t.clear), 'clearing links are among them')
  console.log('OK a room keeps its newest 256 browser sessions; clearing links count toward the seat and room ceilings')
}

// Preview links and cookies name the room by its preview key, never its id,
// which joins it (D2-2, server-13); the key is kept with the room.
{
  const w = world(), pid = (await api(w, 'previews', w.host, 'POST', { port: 43490 })).pid
  const url = await enterLink(w, pid)
  assert.equal(url.searchParams.get('room'), w.room.previewKey); assert.notEqual(w.room.previewKey, w.room.id)
  assert(!url.href.includes(w.room.id), 'the room id is nowhere in the link')
  const cookie = cookieOf(await admit(w, url))
  assert.equal(cookie.split('=')[1].split('.')[0], w.room.previewKey); assert(!cookie.includes(w.room.id))
  assert.notEqual(world().room.previewKey, w.room.previewKey, 'a key of its own')
  assert.equal(Room.resume(structuredClone(w.room.toJSON()), Date.now()).previewKey, w.room.previewKey)
  const old = w.room.toJSON(); delete old.previewKey
  assert.match(Room.resume(old, Date.now()).previewKey, /^[A-Za-z0-9_-]{16,}$/, 'one made for a room saved without')
  // A browser half that vanished, a host half that vanished: what each other side sees (C2-wsrelay2).
  assert.deepEqual([1006, 1015, 1000, 1001, 1005, 1011, 4000].map(hostHalfClose), [1011, 1011, 1000, 1001, 1000, 1011, 4000])
  console.log('OK preview links and cookies carry a key of the room’s own, never its id; a vanished host half is 1011 to the page')
}

// What the home page says it keeps and bounds is what this server does: an
// expired link or session goes at the room's next activity (D2-9), a new link
// renews a session (S3-1), clearing needs HTTPS (D2-3), the Worker's relay is
// bounded in bytes (D2-6), a sign-in waits for Continue and keeps no token
// (D2-1), and the room's ceilings.
{
  const text = await homePage('https://share.example').text()
  for (const said of ['A grant, link or session that expired is removed at the room\'s next activity, or with the room', 'browsers clear them only over HTTPS (or on localhost)',
    'on Cloudflare, which can\'t see that, once one side sends more than 4 MB in a second', 'those waiting hold 8 MB per room at most', 'a key of its own, which can\'t join it',
    'A room keeps its newest 5000 events, 16 MB of them at most', '10,240 files at most), 128 open previews, and events of 128 KB each', 'a room its newest 128 links and 256 browser sessions',
    'the browser session it starts (which preview and seat) for 12 hours from the last link that browser opened', 'Signing in finishes only when you press Continue on this server\'s page',
    'Claude Code\'s token is made when it picks up the sign-in, and the server keeps only its hash']) assert(text.includes(said), said)
  assert.equal([HISTORY_BYTES, EVENT_BYTES, ROOM_FILES_COUNT, ROOM_PREVIEWS_MAX, PUBLIC_LIMITS.roomTickets, PUBLIC_LIMITS.roomSessions, PUBLIC_LIMITS.pendingBytes, PUBLIC_LIMITS.bytesPerWindow].join(), [16 * 1024 ** 2, 128 * 1024, 10_240, 128, 128, 256, 8 * 1024 ** 2, 4 * 1024 ** 2].join())
  console.log('OK the home page says when expired links and sessions go, that a new link renews a session, that clearing needs HTTPS, how a sign-in finishes, and the limits as the server keeps them')
}

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  assert(![3000, 3009, 3610].includes(port))
  return port
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
// A browser entering over HTTP: the clearing page first (D2-3), then, its
// cookies cleared, the next link.
async function admitted(url) {
  const first = await fetch(url, { redirect: 'manual' })
  return clears(first) ? fetch(nextOf(await first.text(), url), { redirect: 'manual' }) : first
}
// A raw WebSocket handshake, for what a browser wouldn't send and for a half
// that vanishes without a close frame.
function handshake(port, path, { host = `127.0.0.1:${port}`, cookie, bearer } = {}) {
  const socket = createConnection({ host: '127.0.0.1', port })
  socket.on('error', () => {})
  socket.write([`GET ${path} HTTP/1.1`, `Host: ${host}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
    ...(cookie ? [`Cookie: ${cookie}`] : []), ...(bearer ? [`Authorization: Bearer ${bearer}`] : []), '', ''].join('\r\n'))
  return socket
}
// The status of a raw handshake's answer; 0 if the socket closed without one.
const statusOf = socket => new Promise(resolve => {
  let text = ''
  const timer = setTimeout(() => resolve(0), 5000)
  const done = () => { clearTimeout(timer); resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0)) }
  socket.on('data', b => { text += b; if (text.includes('\r\n')) done() })
  socket.on('close', done)
})
// Upgrades the server turns away, never the process: a preview handshake with
// a Host the URL parser refuses (server-1; only its path and cookie are read,
// so it's a preview that isn't there), and a refused handshake whose client
// resets at once, on either port (Node takes its own error listener off a
// socket it hands over).
async function upgradeChecks(origin, port, preview) {
  for (const host of ['a b', 'x:abc', '[']) {
    const socket = handshake(preview, '/live', { host })
    assert.equal(await statusOf(socket), 404, `Host: ${host}`); socket.destroy()
  }
  for (let i = 0; i < 10; i++) {
    for (const [at, path] of [[preview, '/live'], [port, '/api/rooms/none/ws/none']]) {
      const socket = handshake(at, path)
      await wait(5)
      socket.resetAndDestroy()
    }
  }
  await wait(200)
  assert((await fetch(`${origin}/api/health`)).ok, 'the server is up')
  console.log('OK real Node: a preview handshake with a Host no URL takes is refused; a reset refused handshake ends only its socket')
}
async function nodeChecks() {
  const dir = await mkdtemp(join(tmpdir(), 'share-previews-'))
  const port = await freePort(); let preview = await freePort()
  while (preview === port) preview = await freePort()
  const origin = `http://127.0.0.1:${port}`, database = join(dir, 'test-rooms.json')
  let child, logs = '', stream
  const start = async () => {
    logs = ''
    child = spawn(process.execPath, [fileURLToPath(new URL('../server/node.mjs', import.meta.url))], { cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, PORT: String(port), PREVIEW_PORT: String(preview), DATA_FILE: database }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', b => { logs += b }); child.stderr.on('data', b => { logs += b })
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(logs)
      if (await fetch(`${origin}/api/health`).then(r => r.ok).catch(() => false)) return
      await wait(20)
    }
    throw new Error(`Node server did not start: ${logs}`)
  }
  const stop = async () => {
    if (!child || child.exitCode !== null) return
    child.kill()
    await once(child, 'exit')
  }
  const http = (path, bearer, method = 'GET', body) => fetch(`${origin}${path}`, { method, headers: {
    authorization: bearer ? `Bearer ${bearer}` : '', 'x-shared-session-version': PLUGIN_LATEST,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const ok = async (...args) => { const r = await http(...args); assert.equal(r.status, 200, await r.clone().text()); return r.json() }
  // A request whose body never ends: the server must answer from its headers
  // and first bytes alone.
  const uploading = (path, bearer, method = 'POST', length) => {
    let req, timer
    const response = new Promise((resolve, reject) => {
      req = httpRequest(`${origin}${path}`, { method, headers: { authorization: `Bearer ${bearer}`, 'x-shared-session-version': PLUGIN_LATEST, ...(length ? { 'content-length': length } : {}) } }, res => {
        res.resume(); resolve(res.statusCode)
      })
      req.on('error', reject); req.flushHeaders()
      timer = setTimeout(() => req.destroy(new Error('bounded ingress did not answer before EOF')), 5000)
    })
    response.finally(() => clearTimeout(timer)).catch(() => {})
    return { req, response }
  }
  try {
    await start()
    const room = await ok('/api/rooms', null, 'POST', { name: 'Host' }), base = `/api/rooms/${room.id}`
    const guest = await ok(`${base}/join`, null, 'POST', { name: 'Guest' })
    // One guest post nested past what JSON.stringify recurses: kept whole, it
    // ended the process at the next save (server-3). Clamped, the room saves,
    // and loads again at the restart below.
    const deep = `{"events":[{"type":"chat","body":{"x":${'['.repeat(100_000)}${']'.repeat(100_000)}}}]}`
    assert.equal((await fetch(`${origin}${base}/events`, { method: 'POST', headers: { authorization: `Bearer ${guest.token}`, 'x-shared-session-version': PLUGIN_LATEST }, body: deep })).status, 200)
    await wait(700) // past the snapshot's half-second debounce
    assert((await fetch(`${origin}/api/health`)).ok, 'the room saved, the server up')
    await upgradeChecks(origin, port, preview)
    const unauthorized = uploading(`${base}/previews`, guest.token, 'POST', 1_000_000)
    assert.equal(await unauthorized.response, 403); unauthorized.req.destroy()
    const oversized = uploading(`${base}/previews`, room.token, 'POST', 1_000_000)
    assert.equal(await oversized.response, 413); oversized.req.destroy()
    const utf8 = uploading(`${base}/previews`, room.token)
    utf8.req.write('界'.repeat(5500))
    assert.equal(await utf8.response, 413); utf8.req.destroy()
    const page = await ok(`${base}/previews`, room.token, 'POST', { port: 43700 })
    const forwarded = await ok(`${base}/previews`, room.token, 'POST', { port: 43701, tcp: true })
    const response = await http(`${base}/stream?tcp=1`, room.token)
    stream = response.body.getReader()
    const first = JSON.parse(new TextDecoder().decode((await stream.read()).value).split('\n')[0])
    assert.ok(Array.isArray(first.events))
    const cap = await ok(`${base}/previews/${forwarded.pid}/tunnel`, guest.token, 'POST', {})
    assert.equal((await http(`${base}/previews/${page.pid}/tunnel`, guest.token, 'POST', {})).status, 403)
    // A TCP admission writes the counters' small file before the socket opens,
    // never every room's snapshot (D6).
    const stats = () => readFile(`${database}.tcp`, 'utf8').then(text => JSON.parse(text).rooms[room.id]).catch(() => null)
    const snapshot = await readFile(database, 'utf8')
    const tunnel = relay.connect(`${origin.replace('http', 'ws')}${base}/previews/${forwarded.pid}/tunnel`, { authorization: `Bearer ${cap.token}` }, [], { message() {}, close() {} })
    for (let i = 0; i < 300 && !tunnel.isOpen(); i++) await wait(10)
    assert(tunnel.isOpen(), 'the TCP tunnel opened')
    const counted = await stats()
    assert.equal(counted.opens.count, 2, 'the grant and the open, in the small file')
    assert.equal(await readFile(database, 'utf8'), snapshot, 'the rooms snapshot was not rewritten')
    tunnel.close()
    // A link minted before a restart still opens after it (D2a).
    const kept = await ok(`${base}/previews/${page.pid}/ticket`, guest.token, 'POST', { path: '/kept' })
    // It names the room by its preview key, which joins nothing (D2-2), and the
    // main port serves no previews (D2-10): asked there, the link isn't spent.
    const keyed = new URL(kept.url), key = keyed.searchParams.get('room')
    assert.notEqual(key, room.id); assert(!kept.url.includes(room.id))
    assert.equal((await http(`/api/rooms/${key}/join`, null, 'POST', { name: 'Stranger' })).status, 404)
    assert.equal((await http(`/api/rooms/${key}`)).status, 404)
    const onMain = await fetch(`${origin}${base}/__preview${keyed.pathname}${keyed.search}`, { redirect: 'manual' })
    assert.notEqual(onMain.status, 302); assert.equal(onMain.headers.get('set-cookie'), null)
    // A link this server made before rooms had keys names the room by its id,
    // and still opens on the preview port (S3-3), through the clearing hop,
    // whose second link names the key; a name that's neither is no room.
    const byId = new URL((await ok(`${base}/previews/${page.pid}/ticket`, guest.token, 'POST', { path: '/before' })).url); byId.searchParams.set('room', room.id)
    const asId = await admitted(byId)
    assert.equal(asId.status, 302); assert.equal(asId.headers.get('location'), '/before'); assert(asId.headers.get('set-cookie').startsWith(`cs_pv=${key}.`))
    const byNone = new URL(byId); byNone.searchParams.set('room', token(16))
    assert.equal((await fetch(byNone, { redirect: 'manual' })).status, 404)
    // Node bounds every body it buffers as the bytes arrive, per route (D7a):
    // a JSON route, a file, the directory and the preview port answer 413
    // before the body ends; a declared length past the bound, at once.
    for (const [path, write, length] of [[`${base}/events`, 1_600_000], [`${base}/files`, 0, 11 * 1024 * 1024], ['/api/teams', 50_000], ['/api/rooms', 1_600_000]]) {
      const big = uploading(path, room.token, 'POST', length)
      if (write) big.req.write(Buffer.alloc(write, 32))
      assert.equal(await big.response, 413, path); big.req.destroy()
    }
    const preview413 = await new Promise((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${preview}/upload`, { method: 'POST' }, res => { let text = ''; res.on('data', b => { text += b }); res.on('end', () => resolve([res.statusCode, res.headers['content-type'], text])) })
      req.on('error', reject); req.write(Buffer.alloc(1024 * 1024 + 1, 32))
    })
    assert.equal(preview413[0], 413); assert.match(preview413[1], /text\/html/); assert.match(preview413[2], /limited to 1 MB/)
    // A bodyless POST to a streamed route keeps its connection; one whose body
    // the route never reads closes it.
    const connection = length => new Promise((resolve, reject) => {
      const req = httpRequest(`${origin}${base}/previews/${forwarded.pid}/end`, { method: 'POST', headers: { authorization: 'Bearer invalid', 'content-length': String(length) } }, res => { res.resume(); resolve([res.statusCode, res.headers.connection]) })
      req.on('error', reject); req.end(length ? 'x'.repeat(length) : undefined)
    })
    assert.deepEqual(await connection(0), [401, 'keep-alive']); assert.deepEqual(await connection(2), [401, 'close'])
    const largeGrant = uploading(`${base}/previews/${forwarded.pid}/tunnel`, guest.token)
    largeGrant.req.write('界'.repeat(5500))
    assert.equal(await largeGrant.response, 200, 'a grant reads no body'); largeGrant.req.destroy()
    await stream.cancel(); stream = null
    // A grant needs the host's TCP stream: it's open while one is asked for.
    const granted = async pid => {
      const live = (await http(`${base}/stream?tcp=1`, room.token)).body.getReader()
      await live.read()
      try { return (await http(`${base}/previews/${pid}/tunnel`, guest.token, 'POST', {})).status } finally { await live.cancel() }
    }
    const opens = (await stats()).opens.count
    await stop(); await start()
    // Shares and grants were saved before their answers.
    assert.equal(await granted(page.pid), 403)
    assert.equal(await granted(forwarded.pid), 200)
    assert.equal((await stats()).opens.count, opens + 1, 'the counters went on from their own file')
    const reopened = await admitted(kept.url)
    assert.equal(reopened.status, 302); assert.equal(reopened.headers.get('location'), '/kept')
    await ok(`${base}/previews`, room.token, 'POST', { port: 43700, tcp: true })
    await ok(`${base}/previews/${forwarded.pid}/end`, room.token, 'POST', {})
    // Only this test's private file is read. Credentials are compared by
    // presence, never printed or copied from a real server's database.
    const saved = JSON.parse(await readFile(database, 'utf8')).rooms.find(r => r.id === room.id)
    assert.equal(saved.previews[page.pid].tcp, true); assert.equal(saved.previews[forwarded.pid], undefined)
    assert(!Object.hasOwn(saved.previewSessions, cap.token))
    await stop(); await start()
    assert.equal(await granted(page.pid), 200)
    assert.equal(await granted(forwarded.pid), 404)
    console.log('OK real Node: streamed auth and UTF-8 bounds before EOF; per-route body caps; shares, forwarding, Stop, links and TCP counters saved, across two restarts')
    await publicSocketChecks(http, ok, origin, preview)
    await publicLimitChecks(http, ok, origin, preview)
    await publicPendingChecks(http, ok, origin, port, preview)
    await needChecks(http, ok, uploading, origin)
  } finally {
    await stream?.cancel().catch(() => {})
    await stop()
    await rm(dir, { recursive: true, force: true })
  }
}
// Real public browser sockets and the production Host public relay, on newly
// allocated test apps. The app fixture only needs small masked text/binary/close
// frames; the adapter/helper RFC parsers have their own exhaustive suite.
async function publicSocketChecks(http, ok, origin, previewPort) {
  const apps = [], sockets = new Set(), clients = [], helpers = [], streams = []
  const until = async (test, label) => {
    for (let i = 0; i < 500; i++) { if (test()) return; await wait(10) }
    throw new Error(`Timed out: ${label}`)
  }
  const frame = (op, data) => {
    const bytes = Buffer.from(data)
    assert(bytes.length < 126)
    return Buffer.concat([Buffer.from([0x80 | op, bytes.length]), bytes])
  }
  const connect = (url, headers) => {
    const p = { messages: [], closes: [] }
    p.client = relay.connect(url, headers, [], { message: data => p.messages.push(data), close: (code, status) => p.closes.push({ code, status }) })
    clients.push(p.client)
    return p
  }
  const traffic = async (p, label) => {
    p.client.send(label)
    await until(() => p.messages.includes(label), `public relay echo ${label}`)
    const bytes = Buffer.concat([Buffer.from([0, 255, 7, 13]), Buffer.from(label)])
    p.client.send(bytes, true)
    await until(() => p.messages.some(m => Buffer.isBuffer(m) && m.equals(bytes)), 'public binary echo')
    p.app.connections.get(p.path).write(frame(1, `reply ${label}`))
    await until(() => p.messages.includes(`reply ${label}`), 'unsolicited application reply')
  }
  try {
    for (let i = 0; i < 2; i++) {
      const app = { connections: new Map(), messages: [] }
      app.server = createHTTPServer((req, res) => res.end('Isolated public WS test app'))
      apps.push(app)
      app.server.on('connection', socket => {
        sockets.add(socket); socket.on('error', () => socket.destroy()); socket.on('close', () => sockets.delete(socket))
      })
      app.server.on('upgrade', (req, socket, head) => {
        app.connections.set(req.url, socket)
        socket.on('close', () => app.connections.delete(req.url))
        const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
        let buffer = Buffer.alloc(0)
        const read = data => {
          buffer = Buffer.concat([buffer, data])
          while (buffer.length >= 2) {
            const op = buffer[0] & 15, n = buffer[1] & 127
            if (n >= 126 || !(buffer[1] & 128)) return socket.destroy()
            if (buffer.length < n + 6) return
            const mask = buffer.subarray(2, 6), bytes = Buffer.from(buffer.subarray(6, n + 6))
            for (let j = 0; j < n; j++) bytes[j] ^= mask[j % 4]
            buffer = buffer.subarray(n + 6)
            if (op === 8) return socket.end(frame(8, bytes))
            if (op === 1 || op === 2) { app.messages.push({ path: req.url, bytes }); socket.write(frame(op, bytes)) }
          }
        }
        socket.on('data', read)
        if (head.length) read(head)
      })
      app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening')
      app.port = app.server.address().port
      assert(![3000, 3009, 3610].includes(app.port))
    }
    const room = await ok('/api/rooms', null, 'POST', { name: 'Public WS test host' }), base = `/api/rooms/${room.id}`
    const guest = await ok(`${base}/join`, null, 'POST', { name: 'Public WS test guest' })
    const response = await http(`${base}/stream?tcp=1`, room.token)
    assert.equal(response.status, 200)
    const reader = response.body.getReader(), notices = []
    streams.push(reader)
    const pump = (async () => {
      let buffer = ''
      const decoder = new TextDecoder()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return
        buffer += decoder.decode(chunk.value, { stream: true })
        let end
        while ((end = buffer.indexOf('\n')) >= 0) { notices.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1) }
      }
    })().catch(() => {})
    const pids = [(await ok(`${base}/previews`, room.token, 'POST', { port: apps[0].port })).pid, (await ok(`${base}/previews`, room.token, 'POST', { port: apps[1].port, tcp: true })).pid]
    const pair = p => {
      helpers.push(relay.start({ local: `ws://127.0.0.1:${p.app.port}${p.path}`, origin: `http://localhost:${p.app.port}`, protocols: [],
        room: `${origin.replace('http', 'ws')}${base}/ws/${p.id}`, token: room.token, version: PLUGIN_LATEST }))
    }
    const open = async (i, paired = true) => {
      const pid = pids[i], app = apps[i], path = `/live-${token(6)}`
      const ticket = await ok(`${base}/previews/${pid}/ticket`, guest.token, 'POST', {})
      const entered = await admitted(ticket.url)
      assert.equal(entered.status, 302)
      const cookie = entered.headers.get('set-cookie').split(';')[0]
      const p = { ...connect(`ws://127.0.0.1:${previewPort}${path}`, { cookie }), pid, app, path, cookie }
      await until(() => p.client.isOpen() && notices.some(n => n.ws?.path === path), 'public browser handshake')
      const notice = notices.find(n => n.ws?.path === path).ws
      assert.equal(notice.pid, pid); p.id = notice.id
      if (paired) { pair(p); await traffic(p, `before stop ${i}`) }
      return p
    }
    const active = [await open(0), await open(1)], pending = [await open(0, false), await open(1, false)]
    pending[0].client.send('queued 0'); pending[1].client.send('queued 1')
    // Stop one preview: its open and waiting sockets end, the other's don't.
    await ok(`${base}/previews/${pids[0]}/end`, room.token, 'POST', {})
    await until(() => active[0].closes.length && pending[0].closes.length && !apps[0].connections.has(active[0].path), 'Stop closes both public halves and a waiting browser')
    assert.equal(active[0].closes[0].code, 1008); assert.equal(pending[0].closes[0].code, 1008)
    assert.equal(apps[0].messages.some(m => m.path === pending[0].path), false, 'bytes queued before Stop never reach the app')
    const denied = connect(`ws://127.0.0.1:${previewPort}/live`, { cookie: active[0].cookie })
    await until(() => denied.closes.length, 'a stopped preview refuses a new public handshake')
    assert.equal(denied.closes[0].status, 404)
    const replacement = await ok(`${base}/previews`, room.token, 'POST', { port: apps[0].port })
    assert.notEqual(replacement.pid, pids[0])
    for (const p of [active[0], pending[0]]) {
      const late = connect(`${origin.replace('http', 'ws')}${base}/ws/${p.id}`, { authorization: `Bearer ${room.token}` })
      await until(() => late.closes.length, 'a late host relay is refused after the same port is shared again')
      assert.equal(late.closes[0].status, 404)
    }
    assert.equal(active[1].closes.length, 0); assert.equal(pending[1].closes.length, 0)
    await traffic(active[1], 'the other preview goes on')
    pair(pending[1])
    await until(() => pending[1].messages.includes('queued 1'), 'the other preview pairs and drains its waiting bytes')
    const waitingEnd = await open(1, false)
    await ok(`${base}/end`, room.token, 'POST', {})
    for (const p of [active[1], pending[1], waitingEnd]) {
      await until(() => p.closes.length && !p.app.connections.has(p.path), 'room end closes public pairs and waiting browsers')
      assert.equal(p.closes[0].code, 1008)
    }
    await reader.cancel(); await pump
    console.log('OK Node production public WS relay: Stop closes its open and waiting pairs and refuses late pairing; other previews go on; room end closes all')
  } finally {
    for (const client of clients) client.close()
    for (const helper of helpers) helper.close()
    for (const reader of streams) await reader.cancel().catch(() => {})
    for (const socket of sockets) socket.destroy()
    await Promise.all(apps.map(app => new Promise(resolve => app.server.close(resolve))))
  }
}
// Real Node, the public link's bounds and answers: a seat's 32 sockets (the
// next refused 429), the host turning away a waiting one (C-reject) but never
// a paired one, Leave ending a seat's sockets, a format 2 answer, the shared
// host name's protections, and the 32 the host never took up closed at their
// 10 s deadline with 1011.
async function publicLimitChecks(http, ok, origin, previewPort) {
  const clients = [], readers = []
  const until = async (test, label, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(10)) if (test()) return
    throw new Error(`Timed out: ${label}`)
  }
  try {
    const room = await ok('/api/rooms', null, 'POST', { name: 'Limits host' }), base = `/api/rooms/${room.id}`
    const guest = await ok(`${base}/join`, null, 'POST', { name: 'Limits guest' }), other = await ok(`${base}/join`, null, 'POST', { name: 'Limits other' })
    const { pid } = await ok(`${base}/previews`, room.token, 'POST', { port: 43460 })
    const reader = (await http(`${base}/stream`, room.token)).body.getReader(), notices = []
    readers.push(reader)
    const pump = (async () => {
      let buffer = ''
      const decoder = new TextDecoder()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return
        buffer += decoder.decode(chunk.value, { stream: true })
        for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) notices.push(JSON.parse(buffer.slice(0, end)))
      }
    })().catch(() => {})
    const enter = async bearer => {
      const ticket = await ok(`${base}/previews/${pid}/ticket`, bearer, 'POST', {})
      return (await admitted(ticket.url)).headers.get('set-cookie').split(';')[0]
    }
    const socket = (url, headers, path) => {
      const p = { messages: [], closes: [], path }
      p.client = relay.connect(url, headers, [], { message: data => p.messages.push(data), close: (code, status) => p.closes.push({ code, status }) })
      clients.push(p.client)
      return p
    }
    const browser = cookie => { const path = `/live-${token(6)}`; return socket(`ws://127.0.0.1:${previewPort}${path}`, { cookie }, path) }
    const idOf = async p => {
      await until(() => notices.some(n => n.ws?.path === p.path), 'the host is asked for a relay')
      return notices.find(n => n.ws?.path === p.path).ws.id
    }
    const started = Date.now(), cookie = await enter(guest.token), waiting = []
    for (let i = 0; i < PUBLIC_LIMITS.seatPairs; i++) waiting.push(browser(cookie))
    await until(() => waiting.every(p => p.client.isOpen()), "a seat's 32 sockets open")
    const refused = browser(cookie)
    await until(() => refused.closes.length, 'the 33rd is refused')
    assert.equal(refused.closes[0].status, 429)
    const otherCookie = await enter(other.token)
    const rejected = browser(otherCookie), rejectedId = await idOf(rejected)
    assert.equal((await http(`${base}/ws/${rejectedId}/reject`, other.token, 'POST', { code: 'CONNECT' })).status, 401)
    assert.equal((await http(`${base}/ws/${rejectedId}/reject`, room.token, 'POST', { code: 'CONNECT' })).status, 200)
    await until(() => rejected.closes.length, 'the host turned it away')
    assert.equal(rejected.closes[0].code, 1011)
    const paired = browser(otherCookie), pairedId = await idOf(paired)
    const host = socket(`${origin.replace('http', 'ws')}${base}/ws/${pairedId}`, { authorization: `Bearer ${room.token}` })
    await until(() => host.client.isOpen(), 'the host half pairs')
    assert.equal((await http(`${base}/ws/${pairedId}/reject`, room.token, 'POST', { code: 'BUSY' })).status, 409)
    paired.client.send('through')
    await until(() => host.messages.includes('through'), 'a paired message')
    // A format 2 answer, through the real servers.
    const asking = fetch(`http://127.0.0.1:${previewPort}/hello?x=1`, { headers: { cookie } })
    await until(() => notices.some(n => n.proxy?.path === '/hello?x=1'), 'the proxied ask')
    const ask = notices.find(n => n.proxy?.path === '/hello?x=1').proxy
    assert.equal(ask.answer, 2)
    const head = JSON.stringify({ status: 200, headers: [['content-type', 'text/plain'], ['set-cookie', 'app=1']] })
    const posted = await fetch(`${origin}${base}/proxy/${ask.id}`, { method: 'POST', headers: { authorization: `Bearer ${room.token}`, 'x-proxy-format': '2', 'x-shared-session-version': PLUGIN_LATEST }, body: Buffer.concat([Buffer.from(`${head}\n`), Buffer.from('from the host')]) })
    assert.equal(posted.status, 200)
    const got = await asking
    assert.equal(got.status, 200); assert.equal(await got.text(), 'from the host'); assert.equal(got.headers.get('set-cookie'), 'app=1')
    // The shared host name: no service worker; another room's state cleared first.
    assert.equal((await fetch(`http://127.0.0.1:${previewPort}/sw.js`, { headers: { cookie, 'service-worker': 'script' } })).status, 403)
    const fresh = await ok(`${base}/previews/${pid}/ticket`, guest.token, 'POST', {})
    const clearing = await fetch(fresh.url, { headers: { cookie: `cs_pv=${token(16)}.x; app=1` }, redirect: 'manual' })
    assert.equal(clearing.status, 200); assert.equal(clearing.headers.get('clear-site-data'), '"cache", "cookies", "storage"'); assert.equal(clearing.headers.get('set-cookie'), null)
    // Leave ends a seat's sockets; another seat's go on.
    await ok(`${base}/leave`, other.token, 'POST', {})
    await until(() => paired.closes.length && host.closes.length, "Leave ends the seat's sockets")
    assert.equal(paired.closes[0].code, 1008)
    assert(waiting.every(p => !p.closes.length), "another seat's sockets go on")
    await until(() => waiting.every(p => p.closes.length), 'sockets the host never took up close', 15_000)
    assert(waiting.every(p => p.closes[0].code === 1011)); assert(Date.now() - started >= PUBLIC_LIMITS.pairMs)
    await reader.cancel(); await pump
    console.log('OK Node public link: 32 sockets a seat, host reject of a waiting socket, Leave, format 2, shared host name, 10 s pairing deadline')
  } finally {
    for (const client of clients) client.close()
    for (const reader of readers) await reader.cancel().catch(() => {})
  }
}
// Real Node, a public pair's halves and what its browsers hold while they
// wait: a host half that vanishes (no close frame) closes the page's with
// 1011, a browser that vanishes the host's plainly (C2-wsrelay2); and a room's
// waiting browsers hold 8 MiB together (D2-6): of nine unpaired sockets of
// 1,000,000 bytes each, the ninth is closed, and pairing or closing one gives
// its bytes back.
async function publicPendingChecks(http, ok, origin, port, preview) {
  const clients = [], raws = [], readers = []
  const until = async (test, label, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(10)) if (test()) return
    throw new Error(`Timed out: ${label}`)
  }
  try {
    const room = await ok('/api/rooms', null, 'POST', { name: 'Pending host' }), base = `/api/rooms/${room.id}`
    const guest = await ok(`${base}/join`, null, 'POST', { name: 'Pending guest' })
    const { pid } = await ok(`${base}/previews`, room.token, 'POST', { port: 43470 })
    const reader = (await http(`${base}/stream`, room.token)).body.getReader(), notices = []
    readers.push(reader)
    const pump = (async () => {
      let buffer = ''
      const decoder = new TextDecoder()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return
        buffer += decoder.decode(chunk.value, { stream: true })
        for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) notices.push(JSON.parse(buffer.slice(0, end)))
      }
    })().catch(() => {})
    const ticket = await ok(`${base}/previews/${pid}/ticket`, guest.token, 'POST', {})
    const cookie = (await admitted(ticket.url)).headers.get('set-cookie').split(';')[0]
    const socket = (url, headers, path) => {
      const p = { messages: [], closes: [], path }
      p.client = relay.connect(url, headers, [], { message: data => p.messages.push(data), close: (code, status) => p.closes.push({ code, status }) })
      clients.push(p.client)
      return p
    }
    const browser = () => { const path = `/live-${token(6)}`; return socket(`ws://127.0.0.1:${preview}${path}`, { cookie }, path) }
    const hostHalf = id => socket(`${origin.replace('http', 'ws')}${base}/ws/${id}`, { authorization: `Bearer ${room.token}` })
    const idOf = async path => {
      await until(() => notices.some(n => n.ws?.path === path), 'the host is asked for a relay')
      return notices.find(n => n.ws?.path === path).ws.id
    }
    const page = browser(), vanishing = handshake(port, `${base}/ws/${await idOf(page.path)}`, { bearer: room.token })
    raws.push(vanishing)
    assert.equal(await statusOf(vanishing), 101)
    vanishing.destroy()
    await until(() => page.closes.length, 'the page hears its host half went')
    assert.equal(page.closes[0].code, 1011)
    const path = `/live-${token(6)}`, gone = handshake(preview, path, { cookie })
    raws.push(gone)
    assert.equal(await statusOf(gone), 101)
    const host = hostHalf(await idOf(path))
    await until(() => host.client.isOpen(), 'the host half pairs')
    gone.destroy()
    await until(() => host.closes.length, 'the host half hears its browser went')
    assert.equal(host.closes[0].code, 1000)
    const waiting = Array.from({ length: 9 }, browser), bytes = 'x'.repeat(1_000_000)
    await until(() => waiting.every(p => p.client.isOpen()), 'nine browsers wait for the host')
    const ids = await Promise.all(waiting.map(p => idOf(p.path)))
    for (const p of waiting.slice(0, 8)) p.client.send(bytes)
    await wait(300)
    assert(waiting.every(p => !p.closes.length), 'eight hold 8,000,000 bytes')
    waiting[8].client.send(bytes)
    await until(() => waiting[8].closes.length, 'the ninth passes 8 MiB')
    assert.equal(waiting[8].closes[0].code, 1009)
    assert(waiting.slice(0, 8).every(p => !p.closes.length), 'the eight wait on')
    const fits = async label => {
      const next = browser()
      await until(() => next.client.isOpen(), 'another browser waits')
      next.client.send(bytes)
      await wait(300)
      assert.equal(next.closes.length, 0, label)
    }
    const first = hostHalf(ids[0])
    await until(() => first.messages.some(m => m.length === bytes.length), "the first's bytes reach its host")
    await fits('paired, the first gave its bytes back')
    waiting[1].client.close()
    await until(() => waiting[1].closes.length, 'a waiting browser closes')
    await fits('closed, the second gave its bytes back')
    await reader.cancel(); await pump
    console.log('OK Node public pairs: a vanished host half is 1011 to the page, a vanished browser 1000 to the host; waiting browsers hold 8 MiB a room, given back as they pair or close')
  } finally {
    for (const client of clients) client.close()
    for (const raw of raws) raw.destroy()
    for (const reader of readers) await reader.cancel().catch(() => {})
  }
}
// The real Node server: a need's body is streamed and bounded before EOF, and
// the need reaches the host's stream alone, as a line of its own.
async function needChecks(http, ok, uploading, origin) {
  const readers = []
  const listen = async (path, bearer) => {
    const response = await http(path, bearer)
    assert.equal(response.status, 200)
    const reader = response.body.getReader(), decoder = new TextDecoder()
    readers.push(reader)
    let buffer = ''
    // Every line up to and including the first that passes the test.
    return async test => {
      const lines = [], deadline = Date.now() + 5000
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end >= 0) {
          const line = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); lines.push(line)
          if (test(line)) return lines
          continue
        }
        let timer
        const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('need stream line timeout')), Math.max(0, deadline - Date.now())) })
        const chunk = await Promise.race([reader.read(), late]).finally(() => clearTimeout(timer))
        assert(!chunk.done, 'stream ended early')
        buffer += decoder.decode(chunk.value, { stream: true })
      }
    }
  }
  try {
    const room = await ok('/api/rooms', null, 'POST', { name: 'Need test host' }), base = `/api/rooms/${room.id}`
    const join = name => ok(`${base}/join`, null, 'POST', { name })
    const guest = await join('Need guest'), prober = await join('Need prober'), busy = await join('Need busy')
    const answer = async (bearer, body) => { const r = await http(`${base}/need`, bearer, 'POST', body); return [r.status, await r.json()] }
    assert.deepEqual(await answer(guest.token, { port: 43900 }), [200, { delivered: false }])
    // A host stream that didn't say need=1 (0.11.24's) isn't told (C2-need).
    const older = await listen(`${base}/stream?tcp=1`, room.token)
    await older(x => Array.isArray(x.events))
    assert.deepEqual(await answer(guest.token, { port: 43900 }), [200, { delivered: false }])
    await ok(`${base}/events`, room.token, 'POST', { events: [{ type: 'chat', body: { text: 'older marker' } }] })
    assert.equal((await older(x => x.events?.some(e => e.body?.text === 'older marker'))).some(x => x.need), false, 'no need line to it')
    const viewer = await listen(`${base}/stream`, guest.token), host = await listen(`${base}/stream?tcp=1&need=1`, room.token)
    // A host event both streams see; a need, if one came, is before it.
    let markers = 0
    const mark = async () => {
      const text = `need marker ${++markers}`
      await ok(`${base}/events`, room.token, 'POST', { events: [{ type: 'chat', body: { text } }] })
      const marked = x => x.events?.some(e => e.body?.text === text)
      return { host: await host(marked), guest: await viewer(marked) }
    }
    await mark()
    const { seq } = await ok(`${base}/events?wait=0&after=0`, guest.token)
    assert.deepEqual(await answer(guest.token, { port: 43900 }), [200, { delivered: true }])
    const after = await ok(`${base}/events?wait=0&after=0`, guest.token)
    assert.equal(after.seq, seq); assert.equal(after.events.some(e => e.type === 'need'), false)
    let seen = await mark()
    assert.deepEqual(seen.host[0], { need: { port: 43900, seat: guest.seat, name: 'Need guest' } })
    assert.equal(seen.host.length, 2, 'the need line, then the marker')
    assert.equal(seen.guest.length, 1, 'the guest stream got the marker alone')
    for (const [bearer, status] of [[room.token, 403], ['invalid', 401], [prober.token, 413]]) {
      const declared = uploading(`${base}/need`, bearer, 'POST', 1_000_000)
      assert.equal(await declared.response, status); declared.req.destroy()
    }
    const streamed = uploading(`${base}/need`, prober.token)
    streamed.req.write(' '.repeat(300))
    assert.equal(await streamed.response, 413); streamed.req.destroy()
    for (const bad of [{}, { port: 0 }, { port: '43901' }, { port: 43901, name: 'Host' }]) assert.equal((await answer(prober.token, bad))[0], 400)
    assert.equal((await fetch(`${origin}${base}/need`, { method: 'POST', headers: { authorization: `Bearer ${prober.token}` }, body: '{' })).status, 400)
    for (let i = 0; i < 20; i++) assert.deepEqual(await answer(busy.token, { port: 43910 + i }), [200, { delivered: true }])
    const [status, refusal] = await answer(busy.token, { port: 43930 })
    assert.equal(status, 429); assert.match(refusal.error, /Too many/)
    assert.deepEqual(await answer(guest.token, { port: 43931 }), [200, { delivered: true }])
    seen = await mark()
    assert.deepEqual(seen.host.filter(x => x.need).map(x => x.need.port), [...Array.from({ length: 20 }, (_, i) => 43910 + i), 43931])
    assert.equal(seen.guest.length, 1)
    const forwarded = await ok(`${base}/previews`, room.token, 'POST', { port: 43940, tcp: true })
    await ok(`${base}/previews`, room.token, 'POST', { port: 43941 })
    assert.deepEqual(await answer(guest.token, { port: 43940 }), [200, { shared: true, pid: forwarded.pid }])
    assert.deepEqual(await answer(guest.token, { port: 43941 }), [200, { delivered: true }])
    seen = await mark()
    assert.deepEqual(seen.host.filter(x => x.need).map(x => x.need.port), [43941])
    assert.equal(seen.guest.some(x => x.need), false)
    await ok(`${base}/end`, room.token, 'POST', {})
    assert.equal((await answer(guest.token, { port: 43943 }))[0], 410)
    console.log('OK real Node need: streamed bounds before EOF, host stream line only, per-seat 429, shared when forwarded, 410 after end')
  } finally {
    for (const reader of readers) await reader.cancel().catch(() => {})
  }
}
// A snapshot that can't be written (here its folder isn't there) is said in
// the log: thrown from its timer, it ended the process and every room in it.
async function saveFailureChecks() {
  const dir = await mkdtemp(join(tmpdir(), 'share-previews-'))
  const port = await freePort(); let preview = await freePort()
  while (preview === port) preview = await freePort()
  const origin = `http://127.0.0.1:${port}`
  let logs = ''
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/node.mjs', import.meta.url))], { cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, PORT: String(port), PREVIEW_PORT: String(preview), DATA_FILE: join(dir, 'gone', 'rooms.json') }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', b => { logs += b }); child.stderr.on('data', b => { logs += b })
  try {
    for (let i = 0; i < 150 && !(await fetch(`${origin}/api/health`).then(r => r.ok).catch(() => false)); i++) {
      if (child.exitCode !== null) throw new Error(logs)
      await wait(20)
    }
    const created = await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { 'x-shared-session-version': PLUGIN_LATEST }, body: JSON.stringify({ name: 'Host' }) })
    assert.equal(created.status, 200)
    const room = await created.json()
    await wait(700) // past the snapshot's half-second debounce
    assert.equal(child.exitCode, null, logs)
    assert.match(logs, /Couldn't save .*gone.*rooms\.json/)
    assert.equal((await fetch(`${origin}/api/rooms/${room.id}`, { headers: { authorization: `Bearer ${room.token}` } })).status, 200, 'the room goes on')
    console.log('OK real Node: a snapshot that fails to save is logged, the server and its rooms go on')
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit') }
    await rm(dir, { recursive: true, force: true })
  }
}
await nodeChecks()
await saveFailureChecks()
console.log('PASS preview server and isolated Node tests')
