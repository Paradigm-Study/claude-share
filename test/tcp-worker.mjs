// No model, dependencies or Cloudflare account. Exercise the real RoomObject
// with stdlib storage/hibernatable-socket stubs, including reconstruction.
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { startWorkerd } from './support/workerd.mjs'
import './support/cloudflare.mjs'
const { Room, PLUGIN_LATEST, TCP_LIMITS, PUBLIC_LIMITS, LIMITS, NEED_LIMIT, SEAT_TIMEOUT_MS, limitOf, token, tcpAdmit, tcpState, tcpReserve, tcpRefund, chargeControl, tcpRelay, previewSocketTarget, previewRequest, bodyLimit, EVENT_BYTES } = await import('../server/core.ts')
const { BODY_CHARS } = await import('../server/teams.ts')

// After the stand-in for `cloudflare:workers` is registered.
const { default: worker, RoomObject } = await import('../server/worker.ts')

const NativeResponse = globalThis.Response, nativeNow = Date.now
const NativePair = globalThis.WebSocketPair
let now = nativeNow()
Date.now = () => now
class Socket {
  sent = []
  closes = []
  tags = []
  attachment = null
  send(data) { if (this.closes.length) throw new Error('closed'); this.sent.push(structuredClone(data)) }
  close(code, reason) { this.closes.push({ code, reason }) }
  serializeAttachment(att) { this.attachment = structuredClone(att) }
  deserializeAttachment() { return structuredClone(this.attachment) }
}
globalThis.WebSocketPair = class {
  constructor() { this[0] = new Socket(); this[1] = new Socket() }
}
globalThis.Response = class extends NativeResponse {
  constructor(body, options = {}) {
    super(body, options.status === 101 ? { ...options, status: 200 } : options)
    if (options.status === 101) Object.defineProperty(this, 'status', { value: 101 })
    if (options.webSocket) this.webSocket = options.webSocket
  }
}
class Storage {
  data = new Map()
  writes = []
  alarm = null
  async get(key) {
    if (Array.isArray(key)) return new Map(key.filter(k => this.data.has(k)).map(k => [k, structuredClone(this.data.get(k))]))
    return structuredClone(this.data.get(key))
  }
  async put(key, value) {
    const entries = typeof key === 'string' ? [[key, value]] : Object.entries(key)
    for (const [k, v] of entries) { this.data.set(k, structuredClone(v)); this.writes.push(k) }
  }
  async list({ prefix = '', end = '￿', limit = Infinity } = {}) {
    return new Map([...this.data].filter(([k]) => k.startsWith(prefix) && k < end).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([k, v]) => [k, structuredClone(v)]))
  }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key) }
  async deleteAll() { this.data.clear() }
  async setAlarm(at) { this.alarm = at; this.alarms = (this.alarms ?? 0) + 1 }
  async getAlarm() { return this.alarm }
  async transaction(fn) { return fn(this) }
}
class State {
  // A Durable Object's id, as toString() writes it: the room's preview key.
  id = (hex => ({ toString: () => hex }))(randomBytes(32).toString('hex'))
  storage = new Storage()
  sockets = []
  barrier = Promise.resolve()
  blockConcurrencyWhile(fn) {
    const result = this.barrier.then(fn)
    this.barrier = result.catch(() => {})
    return result
  }
  acceptWebSocket(ws, tags) { ws.tags = tags; this.sockets.push(ws) }
  // Closing sockets deliberately remain listed, as on Cloudflare during close.
  getWebSockets(tag) { return this.sockets.filter(ws => !tag || ws.tags.includes(tag)) }
}
// The part of the ROOMS namespace the Worker uses. As on Cloudflare, a name
// and a hex id are different objects (idFromName(key) isn't the room whose
// id the key is), idFromString refuses anything but an object's hex id, and
// an id no room has is an empty object.
function namespace(...worlds) {
  const empty = new RoomObject(new State(), {})
  return {
    idFromName: name => `name:${name}`,
    idFromString: hex => { if (!/^[0-9a-f]{64}$/.test(hex)) throw new TypeError('Invalid Durable Object ID'); return `hex:${hex}` },
    get: id => worlds.find(w => id === `name:${w.id}` || id === `hex:${w.key}`)?.obj ?? empty,
  }
}
function req(w, path, bearer, method = 'GET', body, upgrade = false) {
  const headers = { 'x-shared-session-version': PLUGIN_LATEST }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  if (upgrade) headers.upgrade = 'websocket'
  // A preview's requests name the room by its preview key, as the preview Worker sends them.
  return new Request(`https://room.internal/${path.startsWith('__preview') ? w.key : w.id}/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
function heldReject(w, id, bearer = w.host) {
  let release, read = false, started
  const reading = new Promise(resolve => (started = resolve))
  const body = new ReadableStream({ pull(controller) {
    read = true; started()
    return new Promise(resolve => (release = text => { controller.enqueue(new TextEncoder().encode(text)); controller.close(); resolve() }))
  } }, { highWaterMark: 0 })
  return { request: new Request(`https://room.internal/${w.id}/ws/${id}/reject`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` }, body, duplex: 'half' }),
    reading, get read() { return read }, release: (text = '{"code":"BUSY"}') => release(text) }
}
async function api(w, ...args) {
  const response = await w.obj.fetch(req(w, ...args))
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}
// A request whose body arrives only when the test says.
function heldBody(w, path, bearer = w.host, method = 'POST') {
  let release, reads = 0, started
  const reading = new Promise(resolve => { started = resolve })
  const body = new ReadableStream({ pull(controller) {
    reads++; started()
    return new Promise(resolve => { release = data => { controller.enqueue(new TextEncoder().encode(typeof data === 'string' ? data : JSON.stringify(data))); controller.close(); resolve() } })
  } }, { highWaterMark: 0 })
  return { request: new Request(req(w, path, bearer, method), { body, duplex: 'half' }), reading,
    get reads() { return reads }, release: data => release(data) }
}
const jsonControl = ws => ws.sent.filter(x => typeof x === 'string').map(x => JSON.parse(x))
const tcp = ws => ws.deserializeAttachment().tcp
function live(w, side, id) { return w.state.getWebSockets(`${side === 'guest' ? 'tg' : 'th'}:${id}`).find(ws => !tcp(ws).closed) }
// `connected`: the host's stream is open, as a connection wants.
async function world(connected = true) {
  const state = new State(), obj = new RoomObject(state, {})
  await state.barrier
  const w = { state, obj, id: token(16), key: state.id.toString() }
  assert.equal((await obj.fetch(req(w, 'create', null, 'POST', { name: 'Host' }))).status, 200)
  w.host = obj.room.host.token
  const joined = await (await obj.fetch(req(w, 'join', null, 'POST', { name: 'Guest' }))).json()
  w.member = joined.token; w.seat = joined.seat
  w.pid = (await (await obj.fetch(req(w, 'previews', w.host, 'POST', { port: 34567, tcp: true }))).json()).pid
  if (connected) assert.equal((await obj.fetch(req(w, 'socket?after=0', w.host, 'GET', undefined, true))).status, 101)
  w.control = state.getWebSockets('host').at(-1)
  return w
}
// A guest's TCP half, with its seat's own token (`bearer`), paired with the
// host's or left waiting.
async function open(w, bearer = w.member, paired = true) {
  const seq = w.obj.room.seq
  assert.equal((await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, bearer, 'GET', undefined, true))).status, 101)
  const notice = jsonControl(w.control).at(-1).tcp
  assert.deepEqual(Object.keys(notice).sort(), ['id', 'pid', 'port'])
  const guest = live(w, 'guest', notice.id)
  assert.deepEqual(Object.keys(guest.deserializeAttachment()), ['tcp'])
  assert(!guest.tags.includes(w.seat)); assert(!guest.tags.includes('host'))
  assert.equal(guest.sent.length, 0)
  assert.equal(w.obj.pending.size, 0)
  if (!paired) return { id: notice.id, guest }
  assert.equal((await w.obj.fetch(req(w, `ws/${notice.id}`, w.member, 'GET', undefined, true))).status, 401)
  assert.equal((await w.obj.fetch(req(w, `ws/${notice.id}`, w.host, 'GET', undefined, true))).status, 101)
  const host = live(w, 'host', notice.id)
  assert.deepEqual(jsonControl(guest), [{ t: 'ready' }]); assert.deepEqual(jsonControl(host), [{ t: 'ready' }])
  assert.equal((await w.obj.fetch(req(w, `ws/${notice.id}`, w.host, 'GET', undefined, true))).status, 409)
  assert.equal(w.obj.room.seq, seq)
  return { id: notice.id, guest, host }
}
// An ack as a helper sends it: the credit's n and nonce (the room keeps more beside them).
const ackOf = c => ({ t: 'ack', n: c.n, nonce: c.nonce })
async function ack(w, receiver) {
  const c = tcp(receiver).credits[0]
  assert(c)
  await w.obj.webSocketMessage(receiver, JSON.stringify(ackOf(c)))
  return c
}
async function reconstruct(w) {
  w.obj = new RoomObject(w.state, {})
  await w.state.barrier
}
function closed(pair, code) {
  assert.equal(pair.guest.closes.at(-1)?.code, code)
  if (pair.host) assert.equal(pair.host.closes.at(-1)?.code, code)
}
function publicRequest(w, cookie) {
  const request = req(w, '__preview/live', null, 'GET', undefined, true)
  request.headers.set('cookie', cookie)
  return request
}
async function pairPublic(w, pair) {
  assert.equal((await w.obj.fetch(req(w, `ws/${pair.id}`, w.host, 'GET', undefined, true))).status, 101)
  pair.host = w.state.getWebSockets(`ph:${pair.id}`).at(-1)
  return pair
}
// A browser entering by a link: anything but this room's cookie is cleared
// first (D2-3), by a page that sets nothing and leads on to a second link,
// which the browser, its cookies cleared, opens with none.
async function entering(w, url, cookie) {
  const go = (link, cookie) => {
    const request = req(w, `__preview${link.pathname}${link.search}`)
    if (cookie) request.headers.set('cookie', cookie)
    return w.obj.fetch(request)
  }
  const first = await go(url, cookie)
  if (first.status !== 200 || first.headers.get('clear-site-data') !== '"cache", "cookies", "storage"') return first
  assert.equal(first.headers.get('set-cookie'), null)
  return go(new URL(/url=([^"]+)"/.exec(await first.text())[1].replaceAll('&amp;', '&'), url))
}
async function openPublic(w, pid, paired = true, bearer = w.member) {
  const request = req(w, `previews/${pid}/ticket`, bearer, 'POST', {})
  request.headers.set('x-preview-origin', 'https://preview.test')
  const ticket = await w.obj.fetch(request)
  assert.equal(ticket.status, 200)
  const entered = await entering(w, new URL((await ticket.json()).url))
  assert.equal(entered.status, 302)
  const cookie = entered.headers.get('set-cookie').split(';')[0]
  assert.equal((await w.obj.fetch(publicRequest(w, cookie))).status, 101)
  const notice = jsonControl(w.control).filter(x => x.ws).at(-1).ws
  assert.equal(notice.pid, pid)
  const pair = { id: notice.id, pid, cookie, guest: w.state.getWebSockets(`pb:${notice.id}`).at(-1) }
  return paired ? pairPublic(w, pair) : pair
}
async function publicTraffic(w, pair, label) {
  const sent = [pair.host.sent.length, pair.guest.sent.length]
  const reply = new Uint8Array([0, 255, 3, 13]).buffer
  await w.obj.webSocketMessage(pair.guest, label)
  assert.equal(pair.host.sent.at(-1), label)
  await w.obj.webSocketMessage(pair.host, reply)
  assert.deepEqual(pair.guest.sent.at(-1), reply)
  assert.deepEqual([pair.host.sent.length, pair.guest.sent.length], sent.map(n => n + 1))
}

try {
  // Authentication, purpose isolation and the cookie path: a guest's own seat
  // token connects, nothing is kept for it, and no other bearer does.
  {
    const w = await world(false), seq = w.obj.room.seq
    assert.equal((await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, w.member, 'GET', undefined, true))).status, 503, 'no host stream, no connection')
    // A guest's stream is no host's.
    await w.obj.fetch(req(w, 'socket', w.member, 'GET', undefined, true))
    assert.equal((await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, w.member, 'GET', undefined, true))).status, 503)
    await w.obj.fetch(req(w, 'socket', w.host, 'GET', undefined, true))
    w.control = w.state.getWebSockets('host').at(-1)
    assert.equal((await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, w.member, 'POST'))).status, 404, 'no grant to ask for')
    assert.equal(w.obj.room.seq, seq)
    for (const bearer of [w.host, 'missing']) {
      assert.equal((await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, bearer, 'GET', undefined, true))).status, 401)
    }
    assert.equal((await w.obj.fetch(req(w, 'previews/wrong-pid/tunnel', w.member, 'GET', undefined, true))).status, 410)
    const cookieReq = new Request('https://preview.local/test', { headers: { cookie: `cs_pv=${w.key}.${w.member}` } })
    assert.equal(previewSocketTarget(w.obj.room, cookieReq, now).ok, false, 'a seat token is no browser session')
    assert.equal((await previewRequest(w.obj.room, cookieReq, now)).response.status, 404)
    const ticket = await (await w.obj.fetch(req(w, `previews/${w.pid}/ticket`, w.member, 'POST', { path: '/app?a=1' }))).json()
    // RoomObject normally gets this header from the outer Worker.
    assert.equal(ticket.error, 'This server does not serve previews.')
    w.obj.room.previewSessions.set('old-http', { pid: w.pid, exp: now + 100_000, seat: w.seat })
    const publicReq = new Request(`https://preview.local/app?a=1`, { headers: { cookie: `cs_pv=${w.key}.old-http` } })
    assert.equal(previewSocketTarget(w.obj.room, publicReq, now).ok, true)
    assert.equal((await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, 'old-http', 'GET', undefined, true))).status, 401, 'a browser session is no seat')
    const pair = await open(w)
    assert.deepEqual([...w.obj.room.previewSessions.keys()], ['old-http'], 'nothing kept for the connection')
    assert.deepEqual(Object.keys(tcp(pair.guest)).filter(k => ['cap', 'exp'].includes(k)), [])
    const other = await world()
    assert.equal((await other.obj.fetch(req(other, `previews/${other.pid}/tunnel`, w.member, 'GET', undefined, true))).status, 401, "another room's seat")
    assert.equal((await other.obj.fetch(req(other, `ws/${pair.id}`, other.host, 'GET', undefined, true))).status, 410)
    await w.obj.webSocketError(pair.guest); closed(pair, 1011)
    console.log("OK a guest's own seat token alone connects: room/pid/purpose isolation, nothing kept, the host connected")
  }

  // Forwarding is the host's choice: a preview shared without it (Claude
  // mentioned the port) takes no connection, and the host's say upgrades it.
  {
    const w = await world()
    const linkOnly = (await (await w.obj.fetch(req(w, 'previews', w.host, 'POST', { port: 5432 }))).json()).pid
    const refused = await w.obj.fetch(req(w, `previews/${linkOnly}/tunnel`, w.member, 'GET', undefined, true))
    assert.equal(refused.status, 403)
    const upgraded = await (await w.obj.fetch(req(w, 'previews', w.host, 'POST', { port: 5432, tcp: true }))).json()
    assert.deepEqual(upgraded, { pid: linkOnly, tcp: true })
    assert.equal((await w.obj.fetch(req(w, `previews/${linkOnly}/tunnel`, w.member, 'GET', undefined, true))).status, 101)
    // A guest can't ask for forwarding: only the host makes previews.
    assert.equal((await w.obj.fetch(req(w, 'previews', w.member, 'POST', { port: 6379, tcp: true }))).status, 403)
    console.log('OK forwarding only for previews the host chose to forward')
  }

  // A seat its person left from elsewhere (the Team panel's Leave): its open
  // stream ends at the room's next change, and connecting again hears why.
  {
    const w = await world()
    await w.obj.fetch(req(w, 'socket?after=0', w.member, 'GET', undefined, true))
    const viewer = w.state.getWebSockets(w.seat).at(-1)
    for (const seat of w.obj.room.seats.values()) if (seat.id === w.seat) seat.account = 'acct-guest'
    // The leave itself is the room's change that ends it.
    assert.equal(w.obj.room.leaveAccount('acct-guest', now), 1)
    assert.deepEqual(viewer.closes, [{ code: 1008, reason: 'left' }])
    assert.equal(w.control.closes.length, 0, "the host's stream goes on")
    assert.equal((await w.obj.fetch(req(w, 'socket?after=0', w.member, 'GET', undefined, true))).status, 410)
    console.log('OK a stream whose seat left from elsewhere ends, and connecting again hears it left')
  }

  // A preview's Stop ends its own channels and no other's; what the room
  // says about previews comes from its state, not trimmed history.
  {
    const w = await world()
    await w.obj.fetch(req(w, 'socket?after=0', w.member, 'GET', undefined, true))
    const viewer = w.state.getWebSockets(w.seat).at(-1)
    const other = await api(w, 'previews', w.host, 'POST', { port: 43170, tcp: true })
    const pairs = [await open(w), await open({ ...w, pid: other.pid })]
    for (let i = 0; i < 5010; i++) w.obj.room.append({ seat: 'host', role: 'host', name: 'Host' }, 'row', { text: 'history '.repeat(30) }, now)
    await w.obj.persist(); await reconstruct(w)
    assert.equal(w.obj.room.events.length, 5000)
    assert.deepEqual([w.obj.room.previews.get(other.pid)?.port, w.obj.room.previews.get(other.pid)?.tcp], [43170, true])
    const before = w.obj.room.seq
    assert.deepEqual(await api(w, `previews/${other.pid}/end`, w.host, 'POST'), { ok: true })
    closed(pairs[1], 1008)
    assert.equal(pairs[0].guest.closes.length, 0, "another preview's channel goes on")
    assert.equal((await w.obj.fetch(req(w, `previews/${other.pid}/tunnel`, w.member, 'GET', undefined, true))).status, 410)
    assert.deepEqual(w.obj.room.since(before).filter(e => e.type === 'preview').map(e => [e.body.pid, e.body.state]), [[other.pid, 'closed']])
    assert.deepEqual(jsonControl(viewer).at(-1).events.filter(e => e.type === 'preview').map(e => e.body.state), ['closed'])
    const again = await api(w, 'previews', w.host, 'POST', { port: 43170, tcp: true })
    assert.notEqual(again.pid, other.pid)
    await reconstruct(w)
    assert.equal(w.obj.room.previews.has(other.pid), false); assert.equal(w.obj.room.previews.get(again.pid).tcp, true)
    assert(pairs.every(p => jsonControl(p.guest).every(x => x.events === undefined)), 'TCP payload channels never receive room pages')
    console.log('OK Worker preview Stop ends only its own channels; metadata after trimmed history and reconstruction')
  }

  // Public sockets end with their preview, open or still waiting for the
  // host's half, including after hibernation; other previews' go on.
  {
    const w = await world()
    const pids = [(await api(w, 'previews', w.host, 'POST', { port: 43211 })).pid, (await api(w, 'previews', w.host, 'POST', { port: 43210 })).pid, w.pid]
    const active = [], waiting = []
    for (const pid of pids) {
      active.push(await openPublic(w, pid))
      waiting.push(await openPublic(w, pid, false))
    }
    const tcpPair = await open(w)
    await w.obj.persist(); await reconstruct(w)
    for (let i = 0; i < active.length; i++) {
      await publicTraffic(w, active[i], `before stop ${i}`)
      await w.obj.webSocketMessage(waiting[i].guest, `queued ${i}`)
      assert.equal(w.obj.pending.get(waiting[i].id).messages[0], `queued ${i}`)
    }
    await api(w, `previews/${pids[0]}/end`, w.host, 'POST')
    closed(active[0], 1008); closed(waiting[0], 1008)
    assert.equal(w.obj.pending.has(waiting[0].id), false)
    assert.equal((await w.obj.fetch(req(w, `previews/${active[0].pid}`, w.member))).status, 404)
    assert.equal((await w.obj.fetch(publicRequest(w, active[0].cookie))).status, 404)
    assert.equal(tcpPair.guest.closes.length, 0, "another preview's TCP goes on")
    for (let i = 1; i < active.length; i++) {
      assert.equal(active[i].guest.closes.length, 0); assert.equal(active[i].host.closes.length, 0)
      assert.equal(waiting[i].guest.closes.length, 0)
      await pairPublic(w, waiting[i])
      assert.equal(waiting[i].host.sent[0], `queued ${i}`)
      await publicTraffic(w, active[i], `kept ${i}`)
      await publicTraffic(w, waiting[i], `late pair ${i}`)
    }
    for (const pair of [...active, ...waiting]) {
      assert.equal(pair.guest.deserializeAttachment().pid, pair.pid)
      if (pair.host) assert.equal(pair.host.deserializeAttachment().pid, pair.pid)
    }
    // Even if closing sockets remain listed across another reconstruction and
    // the same port is shared again, neither old half may forward or re-pair.
    const replacement = (await api(w, 'previews', w.host, 'POST', { port: 43211 })).pid
    assert.notEqual(replacement, active[0].pid)
    await reconstruct(w)
    const sent = [active[0].guest.sent.length, active[0].host.sent.length]
    await w.obj.webSocketMessage(active[0].guest, 'revoked request')
    await w.obj.webSocketMessage(active[0].host, 'revoked reply')
    assert.deepEqual([active[0].guest.sent.length, active[0].host.sent.length], sent)
    for (const pair of [active[0], waiting[0]]) {
      assert.equal((await w.obj.fetch(req(w, `ws/${pair.id}`, w.host, 'GET', undefined, true))).status, 410)
      assert.equal(pair.guest.deserializeAttachment().closed, true)
    }
    const fresh = await openPublic(w, pids[1])
    await publicTraffic(w, fresh, 'a new public handshake')
    await api(w, `previews/${pids[1]}/end`, w.host, 'POST')
    closed(active[1], 1008); closed(waiting[1], 1008); closed(fresh, 1008)
    await publicTraffic(w, active[2], 'the other preview survives Stop')
    const pendingEnd = await openPublic(w, w.pid, false)
    await api(w, 'end', w.host, 'POST')
    for (const pair of [active[2], waiting[2], pendingEnd, tcpPair]) closed(pair, 1008)
    await reconstruct(w)
    const before = active[2].host.sent.length
    await w.obj.webSocketMessage(active[2].guest, 'after room end')
    assert.equal(active[2].host.sent.length, before)
  }
  console.log('OK Worker public WS: Stop ends open and waiting pairs, other previews and late pairs go on, room end and reconstruction')

  // Expired browser sessions are swept by the alarm and by ordinary room
  // requests, not by every fetch (a page asset, an upgrade, a host's
  // rejection): those write nothing for them. Admission still counts only
  // live halves: the ones past their pairing deadline close right before it,
  // TCP and public alike.
  {
    const w = await world()
    const pid = (await api(w, 'previews', w.host, 'POST', { port: 43220 })).pid
    const pair = await openPublic(w, pid, false)
    w.obj.room.previewSessions.set('expired-for-alarm', { pid: w.pid, seat: w.seat, exp: now - 1 })
    const writes = w.state.storage.writes.length
    const asset = new Request(`https://room.internal/${w.key}/__preview/app.js`, { headers: { cookie: pair.cookie } })
    const answered = w.obj.fetch(asset)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(w.state.storage.writes.length, writes, 'a page asset writes nothing for an expired session')
    assert(w.obj.room.previewSessions.has('expired-for-alarm'))
    for (const p of w.obj.room.proxied.values()) p(new Response('ok'))
    assert.equal((await answered).status, 200)
    await w.obj.alarm()
    assert.equal(w.obj.room.previewSessions.has('expired-for-alarm'), false, 'the alarm sweeps it')
    const stale = []
    for (let i = 0; i < TCP_LIMITS.seatPairs; i++) stale.push(await open(w, w.member, false))
    assert.equal((await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, w.member, 'GET', undefined, true))).status, 429)
    now += TCP_LIMITS.pairMs + 1 // no alarm delivered yet
    const fresh = await open(w, w.member, false)
    for (const p of stale) closed(p, 1008)
    assert.equal(fresh.guest.closes.length, 0)
    console.log('OK Worker cleanup from the alarm and constructor; stale halves close right before admission')
  }
  // A deploy disconnects every socket, so no attachment comes from older code;
  // still, one that doesn't name its preview, session and seat proves nothing,
  // and its authority isn't guessed from history or a port: it closes on reload.
  {
    const w = await world(), pair = await openPublic(w, w.pid)
    pair.guest.serializeAttachment({ pb: pair.id }); pair.host.serializeAttachment({ ph: pair.id })
    await reconstruct(w)
    closed(pair, 1008)
    assert.equal((await w.obj.fetch(req(w, `ws/${pair.id}`, w.host, 'GET', undefined, true))).status, 410)
  }
  console.log('OK Worker asynchronous public handshake fences and fail-closed incomplete attachments')

  // Outer Worker ingress must preserve streaming authorization and byte limits.
  // A held upload shares nothing in a room that changed meanwhile.
  {
    const w = await world(), env = { ROOMS: { idFromName: id => id, get: () => w.obj }, PREVIEW_URL: 'https://preview.test' }
    const outer = held => worker.fetch(new Request(`https://share.test/api/rooms${new URL(held.request.url).pathname}`, held.request), env)
    for (const bearer of ['', 'invalid', w.member]) {
      const held = heldBody(w, 'previews', bearer)
      held.request.headers.set('content-length', String(1_000_000))
      assert.equal((await outer(held)).status, bearer === w.member ? 403 : 401)
      assert.equal(held.reads, 0)
    }
    const oversized = heldBody(w, 'previews')
    oversized.request.headers.set('content-length', String(1_000_000))
    assert.equal((await outer(oversized)).status, 413); assert.equal(oversized.reads, 0)
    let reads = 0
    const body = new ReadableStream({ pull(controller) { reads++; assert.equal(reads, 1); controller.enqueue(new TextEncoder().encode('界'.repeat(5500))) } }, { highWaterMark: 0 })
    const large = new Request('https://share.test/api/rooms/' + w.id + '/previews', { method: 'POST', headers: req(w, '', w.host).headers, body, duplex: 'half' })
    assert.equal((await worker.fetch(large, env)).status, 413); assert.equal(reads, 1)
    assert.equal(w.obj.room.previews.size, 1)
    // A link reads its page, streamed through the outer Worker: a Stop
    // meanwhile mints nothing.
    const linkHeld = heldBody(w, `previews/${w.pid}/ticket`, w.member), linking = outer(linkHeld)
    await linkHeld.reading
    await api(w, `previews/${w.pid}/end`, w.host, 'POST')
    linkHeld.release({ path: '/late' })
    assert.equal((await linking).status, 404); assert.equal(w.obj.room.tickets.size, 0)
    const sharing = heldBody(w, 'previews'), applying = outer(sharing)
    await sharing.reading
    w.obj.room.host.token = token(24); sharing.release({ port: 43180, tcp: true })
    assert.equal((await applying).status, 401)
    const wrong = heldBody({ ...w, id: token(16) }, 'previews')
    assert.equal((await outer(wrong)).status, 404); assert.equal(wrong.reads, 0)
    await reconstruct(w); assert.equal(w.obj.room.previews.size, 0)
    console.log('OK outer Worker auth-before-body, streaming UTF-8 limits and stale link, token and room checks')
  }

  // Save completion order cannot bring back a stopped preview or lose its
  // close event when another change commits during a storage await.
  {
    const w = await world()
    const original = w.state.storage.put.bind(w.state.storage)
    let release, entered, held = false, writes = 0
    const blocked = new Promise(resolve => { release = resolve }), writing = new Promise(resolve => { entered = resolve })
    w.state.storage.put = async (key, value) => {
      if (key === 'meta' || (typeof key === 'object' && key.meta)) {
        writes++
        if (!held) { held = true; entered(); await blocked }
      }
      return original(key, value)
    }
    const sharing = api(w, 'previews', w.host, 'POST', { port: 43190, tcp: true })
    await writing
    const pid = [...w.obj.room.previews.values()].find(p => p.port === 43190).pid
    const ending = api(w, `previews/${pid}/end`, w.host, 'POST')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(w.obj.room.previews.has(pid), false); assert.equal(writes, 1, 'saves are serialized, not merely their start order')
    release()
    await Promise.all([sharing, ending])
    assert.equal(writes, 2)
    assert.equal((await w.state.storage.get('meta')).previews[pid], undefined)
    await reconstruct(w)
    assert.equal(w.obj.room.previews.has(pid), false)
    assert(w.obj.room.events.some(e => e.type === 'preview' && e.body.pid === pid && e.body.state === 'closed'))
    console.log('OK ordered Worker persistence keeps the latest Stop and its close event across overlapping writes')
  }

  // New connections count against exact minute counters; one seat cannot
  // spend everyone else's minute. No per-network limit covers TCP: nothing is
  // asked for before a connection.
  {
    assert.equal(TCP_LIMITS.seatOpensPerMinute, 240); assert.equal(TCP_LIMITS.opensPerMinute, 1200)
    assert.equal(TCP_LIMITS.seatPairs, 32); assert.equal(TCP_LIMITS.roomPairs, 64)
    const w = await world()
    const connect = bearer => w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, bearer, 'GET', undefined, true))
    let n = 0, refused
    while ((refused = await connect(w.member)).status === 101) {
      n++
      await w.obj.webSocketError(live(w, 'guest', jsonControl(w.control).at(-1).tcp.id))
    }
    assert.equal(refused.status, 429); assert.equal(n, 240)
    assert.equal(w.obj.room.tcpStats.opens.count, 240) // the seat's refusal doesn't charge the room
    const other = (await (await w.obj.fetch(req(w, 'join', null, 'POST', { name: 'Other' }))).json()).token
    assert.equal((await connect(other)).status, 101)
    assert.equal(w.obj.room.tcpStats.opens.count, 241)
    now += 59_999
    assert.equal((await connect(w.member)).status, 429)
    now++
    assert.equal((await connect(w.member)).status, 101)
    assert.equal(w.obj.room.tcpStats.opens.count, 1)
    assert.deepEqual(Object.keys(LIMITS).sort(), ['create', 'events', 'join'])
    for (const [method, rest, bearer] of [['POST', `previews/${w.pid}/tunnel`, w.member], ['GET', `previews/${w.pid}/tunnel`, w.member], ['POST', 'ws/x/reject', w.host]]) {
      assert.equal(limitOf(req(w, '', bearer, method), w.id, rest, 'ip'), null, `${method} ${rest}`)
    }
    console.log('OK exact WS seat240/room1200 admission; no per-network limit on TCP')
  }

  // The budget pays for bytes carried: a browser's thousands of short
  // connections give back what they reserved and didn't use.
  {
    const room = new Room({ id: 'r', title: 't', host: { name: 'H', token: 'h', lastSeen: 0 }, createdAt: 0 })
    for (let i = 0; i < 5000; i++) {
      const half = { remaining: 0 }
      assert(tcpReserve(room, half))
      half.remaining -= 1000 // carried 1 KB
      tcpRefund(room, half)
      assert.equal(tcpRefund(room, half), 0) // once
    }
    assert.equal(room.tcpStats.used - room.tcpStats.refunded, 5000 * 1000)
    console.log('OK refunds: thousands of short connections, a lifetime budget barely touched')
  }

  // Both directions, half-close, challenge restoration, and no payload writes.
  {
    const w = await world(), pair = await open(w)
    const seq = w.obj.room.seq, written = w.state.storage.writes.length
    const a = new Uint8Array([0, 255, 1, 10]).buffer
    await w.obj.webSocketMessage(pair.guest, a)
    assert.deepEqual(pair.host.sent.at(-2), a)
    const credit = jsonControl(pair.host).at(-1)
    assert.equal(credit.t, 'credit'); assert.equal(credit.n, 4); assert.match(credit.nonce, /^[A-Za-z0-9_-]{16,}$/)
    assert.equal(w.obj.room.tcpStats.used, TCP_LIMITS.reserveBytes)
    assert.deepEqual(w.state.storage.writes.slice(written), ['tcp:stats'])
    await w.obj.webSocketMessage(pair.guest, '{"t":"fin"}')
    const b = new Uint8Array(32_768).fill(239).buffer
    await w.obj.webSocketMessage(pair.host, b) // reply after guest's FIN
    assert.deepEqual(pair.guest.sent.at(-2), b)
    const saved = tcp(pair.host), guestSaved = tcp(pair.guest)
    assert.equal(w.obj.room.seq, seq)
    await reconstruct(w)
    const resumedSeq = w.obj.room.seq
    assert.equal(w.obj.room.tcpStats.used, 2 * TCP_LIMITS.reserveBytes)
    assert.deepEqual(tcp(pair.host), saved); assert.deepEqual(tcp(pair.guest), guestSaved)
    assert.equal(w.obj.pending.size, 0)
    now += TCP_LIMITS.pairMs + 1
    await w.obj.alarm()
    assert.equal(pair.guest.closes.length, 0); assert.equal(pair.host.closes.length, 0) // ready/half-closed has no idle timeout
    // A paired channel has nothing due: the next alarm is the guest's grace.
    assert.equal(w.state.storage.alarm, w.obj.room.seats.get(w.member).lastSeen + SEAT_TIMEOUT_MS + 1000)
    const sentBefore = pair.guest.sent.length
    w.obj.broadcast()
    assert.equal(pair.guest.sent.length, sentBefore) // no room JSON on tcp
    const writesBefore = w.state.storage.writes.length
    await ack(w, pair.host)
    assert.equal(jsonControl(pair.guest).at(-1).nonce, credit.nonce)
    await w.obj.webSocketMessage(pair.host, '{"t":"fin"}')
    assert.equal(pair.guest.closes.length, 0) // reverse data still outstanding
    await ack(w, pair.guest)
    closed(pair, 1000)
    // Closed, each half gives back what it reserved and didn't carry: one
    // write, of the counters alone.
    await w.state.barrier
    assert.deepEqual(w.state.storage.writes.slice(writesBefore), ['tcp:stats'])
    assert.equal(w.obj.room.tcpStats.refunded, 2 * TCP_LIMITS.reserveBytes - 4 - 32_768)
    assert.equal(w.obj.room.seq, resumedSeq) // resume advances seq, data never appends
    assert.equal(w.obj.room.events.some(e => e.type === 'tcp'), false)
    const used = w.obj.room.tcpStats.used, refunded = w.obj.room.tcpStats.refunded
    await reconstruct(w)
    assert.equal(w.obj.room.tcpStats.used, used)
    assert.equal(w.obj.room.tcpStats.refunded, refunded)
    assert.equal(w.obj.tcpSockets().length, 0) // close markers survive reload
    console.log('OK binary/credit/FIN, hibernation reconstruction and bounded metadata-only writes')
  }

  // Strict controls, FIFO single-consumption nonce and enforced credit window.
  {
    const w = await world()
    const premature = await open(w, w.member, false)
    await w.obj.webSocketMessage(premature.guest, new Uint8Array([1]).buffer)
    closed(premature, 1008); assert.equal(w.obj.pending.size, 0)
    for (const bad of [new Uint8Array(65_537).buffer, ' '.repeat(257), '{"t":"ready"}', '{"t":"fin","extra":1}']) {
      const p = await open(w)
      await w.obj.webSocketMessage(p.guest, bad)
      closed(p, typeof bad !== 'string' || bad.length > 256 ? 1009 : 1008)
    }
    const p = await open(w)
    for (let i = 0; i < 4; i++) await w.obj.webSocketMessage(p.guest, new Uint8Array(TCP_LIMITS.dataBytes).buffer)
    assert.equal(tcp(p.host).credits.length, 4)
    await w.obj.webSocketMessage(p.guest, new Uint8Array([1]).buffer)
    closed(p, 1008)
    for (const mutation of ['wrong-n', 'wrong-direction', 'reordered', 'reused']) {
      const q = await open(w)
      await w.obj.webSocketMessage(q.guest, new Uint8Array([1, 2]).buffer)
      const c = tcp(q.host).credits[0]
      if (mutation === 'reordered') await w.obj.webSocketMessage(q.guest, new Uint8Array([3, 4]).buffer)
      if (mutation === 'reused') await ack(w, q.host)
      const notice = mutation === 'reordered' ? tcp(q.host).credits[1] : { ...c, ...(mutation === 'wrong-n' ? { n: 1 } : {}) }
      await w.obj.webSocketMessage(mutation === 'wrong-direction' ? q.guest : q.host, JSON.stringify(ackOf(notice)))
      closed(q, 1008)
    }
    const q = await open(w)
    const s = tcp(q.guest); s.rate.data = TCP_LIMITS.dataPerWindow
    q.guest.serializeAttachment({ tcp: s })
    await w.obj.webSocketMessage(q.guest, new Uint8Array([1]).buffer); closed(q, 1008)
    console.log('OK premature data, frame/control size, nonce/FIFO/one-use, credit and DATA rate limits')
  }

  // Control output a half hasn't proven it read is bounded exactly, and the
  // count survives hibernation. A half's messages arrive in order, so an ack
  // (its nonce only its credit notice carried) proves everything sent to it
  // before that notice read; the forwarded ack counts against the sender,
  // which proves it read those by answering a check. So no ack makes the
  // server queue unbounded control output to a half that doesn't read, and a
  // half that keeps reading is never cut off, however long it lives.
  {
    const w = await world(), p = await open(w)
    const unread = ws => tcp(ws).out - tcp(ws).read
    const n = JSON.stringify({ t: 'credit', n: 1, nonce: 'a'.repeat(22) }).length
    const s = tcp(p.host); s.out = s.read + TCP_LIMITS.bufferBytes - n
    p.host.serializeAttachment({ tcp: s })
    await w.obj.webSocketMessage(p.guest, new Uint8Array([1]).buffer)
    assert.equal(unread(p.host), TCP_LIMITS.bufferBytes)
    await reconstruct(w)
    assert.equal(unread(p.host), TCP_LIMITS.bufferBytes)
    const sender = unread(p.guest), credit = await ack(w, p.host)
    assert.equal(unread(p.host), 0, 'everything before the acknowledged notice is read')
    assert.equal(unread(p.guest), sender + JSON.stringify(ackOf(credit)).length, 'the forwarded ack is charged to its sender')
    assert.equal(jsonControl(p.guest).some(row => row.t === 'check'), false, 'no check below checkBytes')
    const t = tcp(p.host); t.out = t.read + TCP_LIMITS.bufferBytes - n + 1
    p.host.serializeAttachment({ tcp: t })
    await w.obj.webSocketMessage(p.guest, new Uint8Array([2]).buffer); closed(p, 1008) // nothing proven: the bound holds
    const exact = { out: TCP_LIMITS.bufferBytes - 11, read: 0 }
    assert.equal(chargeControl(exact, { t: 'fin' }).length, 11)
    assert.equal(exact.out - exact.read, TCP_LIMITS.bufferBytes)
    assert.throws(() => chargeControl(exact, { t: 'fin' }), /unread control output limit/)

    // Once what a half hasn't proven read passes checkBytes it's asked, one
    // check at a time, and its answer proves all before the check. A wrong
    // answer, or one with no check out, closes.
    const q = await open(w)
    const checks = () => jsonControl(q.guest).filter(row => row.t === 'check')
    for (let i = 0; i < 1000 && !checks().length; i++) { await w.obj.webSocketMessage(q.guest, new Uint8Array([i & 255]).buffer); await ack(w, q.host) }
    assert.equal(checks().length, 1)
    assert(unread(q.guest) >= TCP_LIMITS.checkBytes && unread(q.guest) < TCP_LIMITS.checkBytes + 128)
    for (let i = 0; i < 20; i++) { await w.obj.webSocketMessage(q.guest, new Uint8Array([1]).buffer); await ack(w, q.host) }
    assert.equal(checks().length, 1, 'one check out at a time')
    await reconstruct(w)
    await w.obj.webSocketMessage(q.guest, JSON.stringify({ t: 'seen', nonce: checks()[0].nonce }))
    assert(unread(q.guest) < 21 * 64, 'the answer proves all before its check')
    assert.equal(tcp(q.guest).check, null)
    await w.obj.webSocketMessage(q.guest, JSON.stringify({ t: 'seen', nonce: checks()[0].nonce })); closed(q, 1008) // no check out
    const r = await open(w)
    const rs = tcp(r.guest); rs.out = rs.read + TCP_LIMITS.checkBytes
    r.guest.serializeAttachment({ tcp: rs })
    await w.obj.webSocketMessage(r.guest, new Uint8Array([1]).buffer); await ack(w, r.host)
    assert.equal(jsonControl(r.guest).at(-1).t, 'check')
    await w.obj.webSocketMessage(r.guest, JSON.stringify({ t: 'seen', nonce: 'b'.repeat(22) })); closed(r, 1008) // not its nonce

    // Past the 20,000 frames after which a channel used to close: one-frame
    // request/response exchanges prove themselves by their acks, and a one-way
    // stream's sender by its checks; a one-way sender that answers none still
    // closes at the bound.
    const target = { room: 'r', pid: 'p', port: 1, ownerSeat: 's' }
    const halves = () => {
      const guest = tcpState('id', target, 'guest', 0), host = tcpState('id', target, 'host', 0)
      guest.ready = host.ready = true; guest.remaining = host.remaining = Number.MAX_SAFE_INTEGER
      return [guest, host]
    }
    let at = 0
    const relay = (from, to, frame) => tcpRelay(from, to, frame, at += 2)
    const byte = new Uint8Array([7]).buffer, most = { both: 0, sender: 0 }
    const [guest, host] = halves()
    for (let i = 0; i < 100_000; i++) {
      relay(guest, host, { t: 'data', n: 1, data: byte }); relay(host, guest, ackOf(host.credits[0]))
      relay(host, guest, { t: 'data', n: 1, data: byte }); relay(guest, host, ackOf(guest.credits[0]))
      most.both = Math.max(most.both, guest.out - guest.read, host.out - host.read)
    }
    assert(most.both < 256, `request/response: ${most.both} bytes unproven at most`)
    const [reader, writer] = halves()
    let asked = 0
    for (let i = 0; i < 100_000; i++) {
      relay(writer, reader, { t: 'data', n: 1, data: byte })
      for (const message of relay(reader, writer, ackOf(reader.credits[0])).messages) {
        const row = JSON.parse(message)
        if (row.t === 'check') { asked++; relay(writer, reader, { t: 'seen', nonce: row.nonce }) }
      }
      most.sender = Math.max(most.sender, writer.out - writer.read)
    }
    assert(asked > 300 && most.sender < TCP_LIMITS.checkBytes + 128, `one-way: ${asked} checks, ${most.sender} bytes unproven at most`)
    assert(reader.out - reader.read < 256)
    const [silent, silentReader] = halves()
    let frames = 0
    assert.throws(() => { for (;;) { relay(silent, silentReader, { t: 'data', n: 1, data: byte }); relay(silentReader, silent, ackOf(silentReader.credits[0])); frames++ } }, /unread control output limit/)
    assert(frames > 19_000 && frames < 21_000, `a one-way sender answering no check closes after ${frames} frames`)
    console.log('OK exact unread control bound and reconstruction; acks prove all before their notice, checks a sender; past 100k frames both ways')
  }

  // A seat's channels are its own: its Leave closes them alone, across
  // previews, and its token connects no more. Away within its grace, a
  // seat's channels go on and its token still connects (nothing seats it
  // again); dropped from the away list for good, they close.
  {
    const w = await world()
    const otherMember = (await (await w.obj.fetch(req(w, 'join', null, 'POST', { name: 'Other' }))).json()).token
    const otherPid = (await (await w.obj.fetch(req(w, 'previews', w.host, 'POST', { port: 34568, tcp: true }))).json()).pid
    const mine = [await open(w), await open({ ...w, pid: otherPid })]
    const theirs = [await open(w, otherMember), await open({ ...w, pid: otherPid }, otherMember)]
    assert.equal(w.obj.room.previewSessions.size, 0, 'nothing kept for any of them')
    assert.equal((await w.obj.fetch(req(w, 'leave', otherMember, 'POST'))).status, 200)
    for (const p of theirs) closed(p, 1008)
    for (const p of mine) assert.equal(p.guest.closes.length, 0, "another seat's channels go on")
    assert.equal((await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, otherMember, 'GET', undefined, true))).status, 401, 'a seat that left connects no more')
    now += SEAT_TIMEOUT_MS + 1
    await w.obj.alarm()
    assert(w.obj.room.away.has(w.member))
    for (const p of mine) assert.equal(p.guest.closes.length, 0, 'grace is no Leave')
    await reconstruct(w)
    await open(w, w.member, false)
    assert(w.obj.room.away.has(w.member) && !w.obj.room.seats.has(w.member), 'connected while away, not seated again')
    for (let i = 0; i < 100; i++) w.obj.room.join(`Away ${i}`, now, PLUGIN_LATEST)
    now += SEAT_TIMEOUT_MS + 1
    await w.obj.alarm()
    assert.equal(w.obj.room.away.has(w.member), false, 'dropped from the away list')
    for (const p of mine) closed(p, 1008)
    assert.equal((await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, w.member, 'GET', undefined, true))).status, 401)
    console.log("OK a seat's channels are its own: Leave and the away drop close them alone, across previews; grace closes nothing and seats no one")
  }

  // Host rejection is purpose-bound, bounded before parsing, and atomic with
  // pairing. Unauthorized requests (including through the outer Worker) never
  // read the body; duplicate/late rejections cannot damage a ready neighbor.
  {
    const w = await world(), ready = await open(w), pending = await open(w, w.member, false)
    const path = `ws/${pending.id}/reject`, seq = w.obj.room.seq, opens = { ...w.obj.room.tcpStats.opens }
    for (const bearer of [null, w.member, 'invalid']) {
      const held = heldReject(w, pending.id, bearer)
      assert.equal((await w.obj.fetch(held.request)).status, 401); assert.equal(held.read, false)
    }
    const cookie = heldReject(w, pending.id, '')
    cookie.request.headers.delete('authorization'); cookie.request.headers.set('cookie', `cs_pv=${w.key}.${w.member}`)
    assert.equal((await w.obj.fetch(cookie.request)).status, 401); assert.equal(cookie.read, false)
    const outer = heldReject(w, pending.id, w.member)
    const external = new Request(`https://share.test/api/rooms/${w.id}/${path}`, outer.request)
    assert.equal((await worker.fetch(external, { ROOMS: { idFromName: id => id, get: () => w.obj } })).status, 401)
    assert.equal(outer.read, false)
    for (const bad of [null, [], {}, { code: 'busy' }, { code: 'TIMEOUT' }, { code: 1013 }, { code: 'BUSY', extra: 1 }]) {
      assert.equal((await w.obj.fetch(req(w, path, w.host, 'POST', bad))).status, 400)
    }
    for (const body of ['{', ' '.repeat(257), `${' '.repeat(242)}{"code":"BUSY"}`, new Uint8Array([255])]) {
      assert.equal((await w.obj.fetch(new Request(`https://room.internal/${w.id}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${w.host}` }, body }))).status, 400)
    }
    for (const id of ['short', token(12)]) assert.equal((await w.obj.fetch(req(w, `ws/${id}/reject`, w.host, 'POST', { code: 'BUSY' }))).status, 404)
    const wrong = await world()
    assert.equal((await wrong.obj.fetch(req(wrong, path, wrong.host, 'POST', { code: 'BUSY' }))).status, 404)
    assert.equal((await w.obj.fetch(req({ ...w, id: wrong.id }, path, w.host, 'POST', { code: 'BUSY' }))).status, 404)
    // A waiting public browser is the host's to turn away too (C-reject): BUSY.
    w.obj.room.previewSessions.set('public-cookie', { pid: w.pid, exp: now + 60_000, seat: w.seat })
    assert.equal((await w.obj.fetch(new Request(`https://room.internal/${w.key}/__preview/live`, { headers: { upgrade: 'websocket', cookie: `cs_pv=${w.key}.public-cookie` } }))).status, 101)
    const publicId = jsonControl(w.control).at(-1).ws.id, publicSocket = w.state.getWebSockets(`pb:${publicId}`)[0]
    assert.equal((await w.obj.fetch(req(w, `ws/${publicId}/reject`, w.member, 'POST', { code: 'BUSY' }))).status, 401)
    assert.equal((await w.obj.fetch(req(w, `ws/${publicId}/reject`, w.host, 'POST', { code: 'BUSY' }))).status, 200)
    assert.equal(publicSocket.closes.at(-1).code, 1013)
    assert.equal(pending.guest.closes.length, 0)
    assert.equal(pending.guest.closes.length, 0)
    const half = tcp(pending.guest)
    assert(tcpReserve(w.obj.room, half)); pending.guest.serializeAttachment({ tcp: half })
    await w.obj.persistTCPStats()
    assert.deepEqual(await (await w.obj.fetch(req(w, path, w.host, 'POST', { code: 'BUSY' }))).json(), { ok: true })
    closed(pending, 1013)
    assert.equal(w.obj.room.tcpStats.refunded, TCP_LIMITS.reserveBytes)
    assert.equal((await w.obj.fetch(req(w, path, w.host, 'POST', { code: 'CONNECT' }))).status, 404)
    await w.obj.webSocketClose(pending.guest, 1013, '')
    await reconstruct(w)
    const resumedSeq = w.obj.room.seq
    assert.equal(w.obj.room.tcpStats.refunded, TCP_LIMITS.reserveBytes)
    assert.equal(pending.guest.closes.length, 1)
    const connect = await open(w, w.member, false)
    assert.equal((await w.obj.fetch(new Request(`https://room.internal/${w.id}/ws/${connect.id}/reject`, { method: 'POST', headers: { authorization: `Bearer ${w.host}` }, body: JSON.stringify({ code: 'CONNECT' }).padStart(256, ' ') }))).status, 200)
    closed(connect, 1011)
    assert.deepEqual(w.obj.room.tcpStats.opens, { ...opens, count: opens.count + 1 }) // only the new WS counts
    assert.equal((await w.obj.fetch(req(w, `ws/${ready.id}/reject`, w.host, 'POST', { code: 'BUSY' }))).status, 409)
    w.state.sockets = w.state.sockets.filter(ws => ws !== ready.host)
    assert.equal((await w.obj.fetch(req(w, `ws/${ready.id}/reject`, w.host, 'POST', { code: 'BUSY' }))).status, 409)
    assert.equal(ready.guest.closes.length, 0)
    assert.equal(w.obj.room.events.some(e => e.type === 'tcp'), false)
    assert.equal(w.obj.room.seq, resumedSeq); assert(resumedSeq > seq) // only reconstruction advances it
    const raced = await open(w, w.member, false), held = heldReject(w, raced.id)
    const rejecting = w.obj.fetch(held.request)
    await held.reading
    assert.equal((await w.obj.fetch(req(w, `ws/${raced.id}`, w.host, 'GET', undefined, true))).status, 101)
    held.release()
    assert.equal((await rejecting).status, 409); assert.equal(raced.guest.closes.length, 0)
    const duplicate = await open(w, w.member, false)
    const answers = await Promise.all(['BUSY', 'CONNECT'].map(code => w.obj.fetch(req(w, `ws/${duplicate.id}/reject`, w.host, 'POST', { code }))))
    assert.deepEqual(answers.map(r => r.status).sort(), [200, 404]); assert.equal(duplicate.guest.closes.length, 1)
    assert.equal((await w.obj.fetch(req(w, `ws/${duplicate.id}`, w.host, 'GET', undefined, true))).status, 410)
    const lost = await open(w, w.member, false), delayed = heldReject(w, lost.id), losing = w.obj.fetch(delayed.request)
    await delayed.reading; await w.obj.webSocketError(lost.guest); delayed.release()
    assert.equal((await losing).status, 404); assert.equal(lost.guest.closes.length, 1)
    const changed = await open(w, w.member, false), revoked = heldReject(w, changed.id), unauthorized = w.obj.fetch(revoked.request)
    await revoked.reading
    w.obj.room.host.token = token(24); revoked.release()
    assert.equal((await unauthorized).status, 401); assert.equal(changed.guest.closes.length, 0)
    console.log('OK host-only bounded rejection, purpose/room/identity checks, races and once-only refunds')
  }

  // Count pending + paired once per seat across previews, including after
  // hibernation. Two racing opens cannot exceed the seat or room ceiling, and
  // closed attachments don't occupy slots.
  {
    const w = await world()
    const pid = (await (await w.obj.fetch(req(w, 'previews', w.host, 'POST', { port: 34568, tcp: true }))).json()).pid
    const port = { ...w, pid }, lanes = [w, w, port]
    for (let i = 0; i < 32; i++) await open(lanes[i % lanes.length], w.member, i % 2 === 0)
    assert.equal(w.obj.tcpSockets().length, 48) // 32 channels, not 48 halves
    for (const where of [w, port]) assert.equal((await w.obj.fetch(req(where, `previews/${where.pid}/tunnel`, w.member, 'GET', undefined, true))).status, 429)
    await reconstruct(w); port.obj = w.obj
    assert.equal(w.obj.tcpSockets().length, 48)
    assert.equal((await w.obj.fetch(req(port, `previews/${pid}/tunnel`, w.member, 'GET', undefined, true))).status, 429)
    await reconstruct(w)
    const vacancy = w.obj.tcpSockets().find(ws => tcp(ws).ownerSeat === w.seat && !tcp(ws).ready)
    await w.obj.webSocketError(vacancy)
    const seatRace = await Promise.all([0, 1].map(() => w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, w.member, 'GET', undefined, true))))
    assert.deepEqual(seatRace.map(r => r.status).sort(), [101, 429])
    assert.equal(w.obj.tcpSockets().filter(ws => tcp(ws).side === 'guest').length, 32)
    const other = (await (await w.obj.fetch(req(w, 'join', null, 'POST', { name: 'Other' }))).json()).token
    for (let i = 0; i < 31; i++) await open(w, other, false)
    const raced = await Promise.all([0, 1].map(() => w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, other, 'GET', undefined, true))))
    assert.deepEqual(raced.map(r => r.status).sort(), [101, 429])
    assert.equal(w.obj.tcpSockets().filter(ws => tcp(ws).side === 'guest').length, 64)
    const third = (await (await w.obj.fetch(req(w, 'join', null, 'POST', { name: 'Third' }))).json()).token
    assert.equal((await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, third, 'GET', undefined, true))).status, 429)
    const waiting = w.obj.tcpSockets().find(ws => tcp(ws).ownerSeat === w.seat && !tcp(ws).ready)
    assert.equal((await w.obj.fetch(req(w, `ws/${tcp(waiting).id}/reject`, w.host, 'POST', { code: 'BUSY' }))).status, 200)
    assert.equal(waiting.closes.at(-1).code, 1013)
    const freed = await open(w, third, false)
    assert.equal(w.obj.tcpSockets().filter(ws => tcp(ws).side === 'guest').length, 64)
    await w.obj.webSocketError(freed.guest)
    await open(w, w.member, false)
    assert.equal((await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, w.member, 'GET', undefined, true))).status, 429)
    console.log('OK seat32 across previews, room64, concurrent admission, release and reconstruction')
  }

  // Admission and byte-budget ceilings do not reset on reconstruction.
  {
    const w = await world()
    w.obj.room.tcpStats.opens = { start: now, count: 0 }
    for (let i = 0; i < TCP_LIMITS.opensPerMinute; i++) assert.equal(tcpAdmit(w.obj.room, now), true)
    assert.equal(tcpAdmit(w.obj.room, now), false)
    await w.obj.persistTCPStats(); await reconstruct(w)
    assert.equal(tcpAdmit(w.obj.room, now), false)
    now += TCP_LIMITS.openWindowMs + 1
    assert.equal(tcpAdmit(w.obj.room, now), true)
    w.obj.room.tcpStats.used = TCP_LIMITS.roomBytes - TCP_LIMITS.reserveBytes
    await w.obj.persistTCPStats()
    const q = await open(w)
    await w.obj.webSocketMessage(q.guest, new Uint8Array([1]).buffer)
    assert.equal(w.obj.room.tcpStats.used, TCP_LIMITS.roomBytes)
    await reconstruct(w)
    await w.obj.webSocketMessage(q.host, new Uint8Array([2]).buffer); closed(q, 1008)
    assert.equal(w.obj.room.tcpStats.used, TCP_LIMITS.roomBytes)
    const restored = Room.resume(w.obj.room.toJSON(), now), fresh = tcpState(token(12), tcp(q.guest), 'guest', now)
    assert.equal(tcpReserve(restored, fresh), false)
    console.log('OK pair/admission and monotonic room-lifetime reservation limits')
  }

  // Idle timeout and revocation are alarm-driven, including through reload.
  {
    const w = await world(), p = await open(w), idle = await open(w, w.member, false)
    assert.equal(w.state.storage.alarm, now + TCP_LIMITS.pairMs)
    await reconstruct(w)
    now += TCP_LIMITS.pairMs + 1
    await w.obj.alarm(); closed(idle, 1008)
    // A duplicate host after the pairing deadline must not end a ready pair.
    assert.equal((await w.obj.fetch(req(w, `ws/${p.id}`, w.host, 'GET', undefined, true))).status, 409)
    assert.equal(p.guest.closes.length, 0); assert.equal(p.host.closes.length, 0)
    // Even before its deadline, a ready channel whose peer disappeared cannot
    // be re-paired: reconnecting never restores an old TCP byte stream.
    const orphan = await open(w)
    w.state.sockets = w.state.sockets.filter(ws => ws !== orphan.host)
    assert.equal((await w.obj.fetch(req(w, `ws/${orphan.id}`, w.host, 'GET', undefined, true))).status, 410)
    assert.equal(orphan.guest.closes.at(-1)?.code, 1008)
    assert.equal(w.state.getWebSockets(`th:${orphan.id}`).length, 0)
    now += 50_000
    await w.obj.alarm()
    assert(w.obj.room.away.has(w.member))
    assert.equal(p.guest.closes.length, 0) // grace/away is not Leave
    assert.equal((await w.obj.fetch(req(w, 'leave', w.member, 'POST'))).status, 200)
    closed(p, 1008)
    for (const action of ['preview', 'room', 'ttl']) {
      const r = await world(), active = await open(r), waiting = await open(r, r.member, false)
      if (action === 'preview') await r.obj.fetch(req(r, `previews/${r.pid}/end`, r.host, 'POST'))
      if (action === 'room') await r.obj.fetch(req(r, 'end', r.host, 'POST'))
      if (action === 'ttl') {
        await r.obj.webSocketClose(r.control, 1000, '')
        r.state.sockets = r.state.sockets.filter(ws => ws !== r.control)
        now += 24 * 60 * 60 * 1000 + 1001
        await r.obj.alarm()
        assert.equal(r.obj.room, null); assert.equal(r.state.storage.data.size, 0)
      }
      assert(active.guest.closes.length); assert(active.host.closes.length); assert(waiting.guest.closes.length)
    }
    console.log('OK alarms, away vs Leave, preview/room/TTL active and idle revocation')
  }

  // A guest's need reaches the host's control stream alone, as one line, on a
  // live and on a reconstructed object: nothing stored, no page for anyone, no
  // TCP or public channel's, and outside the room's events window.
  {
    const w = await world(), env = { ROOMS: { idFromName: id => id, get: () => w.obj } }
    assert.equal((await w.obj.fetch(req(w, 'socket?after=0', w.member, 'GET', undefined, true))).status, 101)
    const viewer = w.state.getWebSockets(w.seat).at(-1)
    const busy = await (await w.obj.fetch(req(w, 'join', null, 'POST', { name: 'Busy' }))).json()
    // Connected, so a later minute doesn't sweep it.
    assert.equal((await w.obj.fetch(req(w, 'socket?after=0', busy.token, 'GET', undefined, true))).status, 101)
    const channels = [await open(w), await openPublic(w, w.pid)]
    await api(w, 'events', w.host, 'POST', { events: [{ type: 'delta', body: { text: 'before any need' } }] })
    const ask = async (body, bearer = w.member) => { const r = await w.obj.fetch(req(w, 'need', bearer, 'POST', body)); return [r.status, await r.json()] }
    const needs = ws => jsonControl(ws).filter(x => x.need)
    const quiet = () => JSON.stringify({ writes: w.state.storage.writes.length, seq: w.obj.room.seq, events: w.obj.room.events.length, viewer: viewer.sent.length, posts: w.obj.room.posts.windows.get('all') ?? null })
    const nowhereElse = () => { for (const ws of channels.flatMap(c => [c.guest, c.host])) assert.deepEqual(needs(ws), []) }
    let before = quiet()
    assert.deepEqual(await ask({ port: 43230 }), [200, { delivered: true }])
    assert.deepEqual(JSON.parse(w.control.sent.at(-1)), { need: { port: 43230, seat: w.seat, name: 'Guest' } })
    assert.equal(quiet(), before, 'not stored, no event, no page, not the events window')
    nowhereElse()
    const fromHost = heldBody(w, 'need', w.host)
    assert.equal((await w.obj.fetch(fromHost.request)).status, 403); assert.equal(fromHost.reads, 0)
    // Through the outer Worker the body is a stream, read only after auth.
    const outer = held => worker.fetch(new Request(`https://share.test/api/rooms${new URL(held.request.url).pathname}`, held.request), env)
    const viaHost = heldBody(w, 'need', w.host)
    assert.equal((await outer(viaHost)).status, 403); assert.equal(viaHost.reads, 0)
    const declared = heldBody(w, 'need', w.member)
    declared.request.headers.set('content-length', String(NEED_LIMIT.bodyBytes + 1))
    assert.equal((await outer(declared)).status, 413); assert.equal(declared.reads, 0)
    const viaOuter = heldBody(w, 'need', w.member), sending = outer(viaOuter)
    await viaOuter.reading; viaOuter.release({ port: 43231 })
    assert.deepEqual(await (await sending).json(), { delivered: true })
    for (const bad of [{}, { port: 0 }, { port: '43231' }, { port: 43231, seat: 'host' }]) assert.equal((await ask(bad))[0], 400)
    // Forwarded already by the host: nothing to ask, and which preview it is.
    const sharedPid = async port => { const [status, body] = await ask({ port }); assert.equal(status, 200); assert.equal(body.shared, true); assert.equal(typeof body.pid, 'string'); return body.pid }
    assert.equal(await sharedPid(34567), w.pid)
    const forwarded = (await api(w, 'previews', w.host, 'POST', { port: 43232, tcp: true })).pid
    assert.equal(await sharedPid(43232), forwarded)
    await api(w, `previews/${forwarded}/end`, w.host, 'POST')
    assert.deepEqual(await ask({ port: 43232 }), [200, { delivered: true }])
    assert.deepEqual(needs(w.control).map(x => x.need.port), [43230, 43231, 43232])
    for (let i = 0; i < NEED_LIMIT.limit; i++) assert.deepEqual(await ask({ port: 43240 + i }, busy.token), [200, { delivered: true }])
    const limited = heldBody(w, 'need', busy.token), refused = await w.obj.fetch(limited.request)
    assert.equal(refused.status, 429); assert.equal(limited.reads, 0)
    assert.deepEqual(await ask({ port: 43233 }), [200, { delivered: true }], 'another seat still asks')
    assert.deepEqual(needs(w.control).filter(x => x.need.seat === busy.seat).map(x => x.need.port), Array.from({ length: 20 }, (_, i) => 43240 + i))
    now += NEED_LIMIT.periodMs
    assert.deepEqual(await ask({ port: 43260 }, busy.token), [200, { delivered: true }], 'a new minute')
    await reconstruct(w)
    before = quiet()
    assert.deepEqual(await ask({ port: 43261 }), [200, { delivered: true }])
    assert.deepEqual(JSON.parse(w.control.sent.at(-1)), { need: { port: 43261, seat: w.seat, name: 'Guest' } })
    assert.equal(quiet(), before)
    nowhereElse()
    await w.obj.webSocketClose(w.control, 1000, '')
    assert.deepEqual(await ask({ port: 43262 }), [200, { delivered: false }], 'a closing host socket is not a stream')
    await reconstruct(w)
    assert.deepEqual(await ask({ port: 43263 }), [200, { delivered: false }], 'closed, still listed after reconstruction')
    w.state.sockets = w.state.sockets.filter(ws => ws !== w.control)
    assert.deepEqual(await ask({ port: 43264 }), [200, { delivered: false }], 'no host stream at all')
    assert.equal(needs(viewer).length, 0)
    assert.equal((await w.obj.fetch(req(w, 'end', w.host, 'POST'))).status, 200)
    assert.equal((await ask({ port: 43265 }))[0], 410)
    console.log('OK Worker need: host control stream only, live and reconstructed; never stored; 403/413/400/429 per seat/410; shared when forwarded')
  }
  // The public link on the Worker. Links outlive the object sleeping (they are
  // kept with the room). A seat's 32 sockets, pending or paired, then 429;
  // one the host doesn't take up closes at its deadline (alarm, 1011), or when
  // a late host half comes. The host may turn away a waiting one, never a
  // paired one. A socket's messages a second and its peer's unread output are
  // bounded; its rate outlives the object sleeping. Leave, a seat's fifth
  // browser and a session's expiry end its sockets.
  {
    const w = await world(), pid = (await api(w, 'previews', w.host, 'POST', { port: 43470 })).pid
    const link = async bearer => {
      const request = req(w, `previews/${pid}/ticket`, bearer, 'POST', { path: '/start' })
      request.headers.set('x-preview-origin', 'https://preview.test')
      return new URL((await (await w.obj.fetch(request)).json()).url)
    }
    const enter = (url, cookie) => entering(w, url, cookie)
    const cookieFor = async bearer => (await enter(await link(bearer))).headers.get('set-cookie').split(';')[0]
    const kept = await link(w.member)
    await reconstruct(w)
    const entered = await enter(kept)
    assert.equal(entered.status, 302); assert.equal(entered.headers.get('location'), '/start')
    const cookie = entered.headers.get('set-cookie').split(';')[0]
    const opened = []
    for (let i = 0; i < PUBLIC_LIMITS.seatPairs; i++) {
      assert.equal((await w.obj.fetch(publicRequest(w, cookie))).status, 101)
      opened.push({ id: jsonControl(w.control).filter(x => x.ws).at(-1).ws.id })
    }
    for (const p of opened) p.guest = w.state.getWebSockets(`pb:${p.id}`)[0]
    assert(opened.every(p => p.guest.tags.includes('public')))
    assert.equal((await w.obj.fetch(publicRequest(w, cookie))).status, 429)
    const deadline = opened[0].guest.deserializeAttachment().deadline
    assert.equal(deadline, now + PUBLIC_LIMITS.pairMs); assert(w.state.storage.alarm <= deadline)
    // Four more seats fill the room's 128; a sixth seat is refused.
    const members = [w.member]
    for (let i = 0; i < 4; i++) members.push((await (await w.obj.fetch(req(w, 'join', null, 'POST', { name: `Seat ${i}` }))).json()).token)
    for (const member of members.slice(1, 4)) {
      const c = await cookieFor(member)
      for (let i = 0; i < PUBLIC_LIMITS.seatPairs; i++) assert.equal((await w.obj.fetch(publicRequest(w, c))).status, 101)
    }
    assert.equal((await w.obj.fetch(publicRequest(w, await cookieFor(members[4])))).status, 429, 'the room has 128')
    // Past the deadline: the alarm closes what the host never took up, and
    // they no longer hold places.
    now += PUBLIC_LIMITS.pairMs + 1
    await w.obj.alarm()
    for (const p of opened) assert.equal(p.guest.closes.at(-1).code, 1011)
    assert.equal((await w.obj.fetch(req(w, `ws/${opened[0].id}`, w.host, 'GET', undefined, true))).status, 410)
    const late = await openPublic(w, pid, false)
    now += PUBLIC_LIMITS.pairMs + 1 // no alarm yet: a late host half is refused all the same
    assert.equal((await w.obj.fetch(req(w, `ws/${late.id}`, w.host, 'GET', undefined, true))).status, 410)
    assert.equal(late.guest.closes.at(-1).code, 1011)
    // The host turns away a waiting socket (CONNECT), never a paired one.
    const turned = await openPublic(w, pid, false)
    assert.equal((await w.obj.fetch(req(w, `ws/${turned.id}/reject`, w.host, 'POST', { code: 'CONNECT' }))).status, 200)
    assert.equal(turned.guest.closes.at(-1).code, 1011)
    assert.equal((await w.obj.fetch(req(w, `ws/${turned.id}`, w.host, 'GET', undefined, true))).status, 410)
    const pair = await openPublic(w, pid)
    assert.equal((await w.obj.fetch(req(w, `ws/${pair.id}/reject`, w.host, 'POST', { code: 'BUSY' }))).status, 409)
    assert.equal(pair.guest.closes.length, 0)
    // Taken up in time, a pair outlives its deadline.
    now += PUBLIC_LIMITS.pairMs + 1
    await w.obj.alarm()
    assert.equal(pair.guest.closes.length, 0); assert.equal(pair.host.closes.length, 0)
    // So many messages a second, counted where the object's sleep can't reset it.
    for (let i = 0; i < 4000; i++) await w.obj.webSocketMessage(pair.guest, 'm')
    await reconstruct(w)
    for (let i = 4000; i < PUBLIC_LIMITS.framesPerWindow; i++) await w.obj.webSocketMessage(pair.guest, 'm')
    assert.equal(pair.host.sent.length, PUBLIC_LIMITS.framesPerWindow); assert.equal(pair.guest.closes.length, 0)
    await w.obj.webSocketMessage(pair.guest, 'one too many')
    closed(pair, 1008); assert.equal(pair.host.sent.length, PUBLIC_LIMITS.framesPerWindow)
    now += PUBLIC_LIMITS.rateWindowMs
    // A peer that doesn't read: past a megabyte it hasn't taken, where the
    // runtime says how much, the pair closes rather than queue more.
    const slow = await openPublic(w, pid)
    slow.guest.bufferedAmount = PUBLIC_LIMITS.bufferBytes
    await w.obj.webSocketMessage(slow.host, 'broadcast')
    closed(slow, 1009); assert.equal(slow.guest.sent.length, 0)
    // Leave ends the seat's sockets; another seat's go on.
    const mine = await openPublic(w, pid), theirs = await (async () => {
      const c = await cookieFor(members[4])
      assert.equal((await w.obj.fetch(publicRequest(w, c))).status, 101)
      return { guest: w.state.getWebSockets(`pb:${jsonControl(w.control).filter(x => x.ws).at(-1).ws.id}`)[0] }
    })()
    assert.equal((await w.obj.fetch(req(w, 'leave', w.member, 'POST'))).status, 200)
    closed(mine, 1008); assert.equal(theirs.guest.closes.length, 0)
    // A seat's fifth browser on a preview lets the first go, its sockets too.
    const browsers = []
    for (let i = 0; i < PUBLIC_LIMITS.seatSessions + 1; i++) {
      const c = await cookieFor(members[3])
      assert.equal((await w.obj.fetch(publicRequest(w, c))).status, 101)
      browsers.push(w.state.getWebSockets(`pb:${jsonControl(w.control).filter(x => x.ws).at(-1).ws.id}`)[0])
    }
    assert.equal(browsers[0].closes.at(-1).code, 1008); assert(browsers.slice(1).every(b => b.closes.length === 0))
    // A browser session's expiry ends its sockets, from the alarm.
    const lasting = await openPublic(w, pid, true, members[2])
    const exp = lasting.guest.deserializeAttachment().exp
    assert(w.state.storage.alarm <= exp)
    now = exp
    await w.obj.alarm()
    closed(lasting, 1008)
    console.log('OK Worker public link: links survive sleep; 32 a seat, 128 a room; deadline by alarm; host reject; rate and output bounds; Leave, fifth browser, expiry')
  }

  // What's shared, on the Worker (C-snap); proxied answers and the shared host
  // name's protections; a body through the preview Worker is
  // streamed to the room, which bounds it.
  {
    const w = await world()
    const page = (await api(w, 'previews', w.host, 'POST', { port: 43480, title: 'Page' })).pid
    const joined = await (await w.obj.fetch(req(w, 'join', null, 'POST', { name: 'Late' }))).json()
    assert.deepEqual(joined.previews, [{ pid: w.pid, port: 34567, tcp: true, title: 'localhost:34567' }, { pid: page, port: 43480, tcp: false, title: 'Page' }])
    await reconstruct(w)
    // Every page lists it, a reconstructed room's too; there's no list of its own to ask for.
    assert.deepEqual((await api(w, 'events?after=0&wait=0', joined.token)).previews, joined.previews)
    assert.equal((await w.obj.fetch(req(w, 'previews', joined.token))).status, 404)
    assert.deepEqual(w.obj.room.events.filter(e => e.type === 'preview').map(e => [e.body.state, e.body.pid, e.body.tcp]), [['open', w.pid, true], ['open', page, false]])
    const pair = await openPublic(w, page, false)
    const preview = (path, init = {}) => new Request(`https://room.internal/${w.key}/__preview${path}`, { ...init, headers: { cookie: pair.cookie, ...init.headers } })
    const asking = w.obj.fetch(preview('/hello?x=1'))
    await new Promise(resolve => setImmediate(resolve))
    const ask = jsonControl(w.control).filter(x => x.proxy).at(-1).proxy
    assert.equal('answer' in ask, false); assert.equal(ask.path, '/hello?x=1')
    const head = JSON.stringify({ status: 203, headers: [['content-type', 'text/plain'], ['set-cookie', 'one=1'], ['set-cookie', 'two=2']] })
    const answer = new Request(`https://room.internal/${w.id}/proxy/${ask.id}`, { method: 'POST', headers: { authorization: `Bearer ${w.host}` }, body: `${head}\nfrom the host` })
    assert.equal((await w.obj.fetch(answer)).status, 200)
    const got = await asking
    assert.equal(got.status, 203); assert.equal(await got.text(), 'from the host'); assert.deepEqual(got.headers.getSetCookie(), ['one=1', 'two=2'])
    const malformed = w.obj.fetch(preview('/bad'))
    await new Promise(resolve => setImmediate(resolve))
    const badAsk = jsonControl(w.control).filter(x => x.proxy).at(-1).proxy
    assert.equal((await w.obj.fetch(new Request(`https://room.internal/${w.id}/proxy/${badAsk.id}`, { method: 'POST', headers: { authorization: `Bearer ${w.host}` }, body: 'no line' }))).status, 400)
    assert.equal((await malformed).status, 502)
    assert.equal((await w.obj.fetch(preview('/sw.js', { headers: { 'service-worker': 'script' } }))).status, 403)
    // Through the preview Worker: the body streams to the room, bounded there.
    const env = { ROLE: 'preview', ROOMS: namespace(w) }
    const outer = (body, length) => worker.fetch(new Request('https://preview.test/upload', { method: 'POST', headers: { cookie: pair.cookie, ...(length ? { 'content-length': String(length) } : {}) }, body, duplex: 'half' }), env)
    let reads = 0
    const flood = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(700 * 1024)) } }, { highWaterMark: 0 })
    const tooLarge = await outer(flood)
    assert.equal(tooLarge.status, 413); assert.match(await tooLarge.text(), /limited to 1 MB/); assert.equal(reads, 2, 'read no further than past the bound')
    const posting = outer('a small form')
    await new Promise(resolve => setTimeout(resolve, 20))
    const upload = jsonControl(w.control).filter(x => x.proxy).at(-1).proxy
    assert.equal(upload.path, '/upload'); assert.equal(Buffer.from(upload.body, 'base64').toString(), 'a small form')
    w.obj.room.proxied.get(upload.id)(new Response('stored'))
    assert.equal(await (await posting).text(), 'stored')
    // Another room's state is cleared before this room's cookie, through the
    // preview Worker as on Node: a page that sets nothing, then a second link.
    const minted = req(w, `previews/${page}/ticket`, w.member, 'POST', { path: '/start' })
    minted.headers.set('x-preview-origin', 'https://preview.test')
    const link = new URL((await (await w.obj.fetch(minted)).json()).url)
    const elsewhere = `cs_pv=${token(16)}.elsewhere`
    const viaWorker = url => worker.fetch(new Request(url, { headers: { cookie: elsewhere } }), env)
    const clearing = await viaWorker(link)
    assert.equal(clearing.status, 200); assert.equal(clearing.headers.get('clear-site-data'), '"cache", "cookies", "storage"'); assert.equal(clearing.headers.get('set-cookie'), null)
    const next = new URL(/url=([^"]+)"/.exec(await clearing.text())[1].replaceAll('&amp;', '&'), link)
    const entered = await viaWorker(next)
    assert.equal(entered.status, 302); assert.equal(entered.headers.get('location'), '/start'); assert.match(entered.headers.get('set-cookie'), /^cs_pv=/)
    console.log('OK Worker C-snap, proxied answers, no service workers, another room cleared first, preview bodies streamed and bounded in the room')
  }

  // Previews name a room by its object's id (D2-2): the preview Worker finds
  // it by that key, which joins nothing and isn't the room's id; a link or
  // cookie naming the room's id reaches nothing. The main Worker serves no
  // previews, page or socket (D2-10).
  {
    const w = await world(), env = { ROLE: 'preview', ROOMS: namespace(w) }
    const pid = (await api(w, 'previews', w.host, 'POST', { port: 43490 })).pid
    const link = async () => {
      const request = req(w, `previews/${pid}/ticket`, w.member, 'POST', { path: '/start' })
      request.headers.set('x-preview-origin', 'https://preview.test')
      return new URL((await (await w.obj.fetch(request)).json()).url)
    }
    const url = await link(), spare = await link()
    assert.equal(url.searchParams.get('room'), w.key); assert(!url.href.includes(w.id))
    const clearing = await worker.fetch(new Request(url), env)
    assert.equal(clearing.status, 200)
    const entered = await worker.fetch(new Request(new URL(/url=([^"]+)"/.exec(await clearing.text())[1].replaceAll('&amp;', '&'), url)), env)
    assert.equal(entered.status, 302)
    const cookie = entered.headers.get('set-cookie').split(';')[0], sid = cookie.split('.')[1]
    assert.equal(cookie, `cs_pv=${w.key}.${sid}`)
    await reconstruct(w)
    assert.equal(w.obj.room.previewKey, w.key, 'the same key after the object sleeps')
    const asking = worker.fetch(new Request('https://preview.test/app.js', { headers: { cookie } }), env)
    await new Promise(resolve => setTimeout(resolve, 20))
    for (const p of w.obj.room.proxied.values()) p(new Response('app'))
    assert.equal(await (await asking).text(), 'app')
    // A key no room has, or one that isn't a room's name at all: no room there, the link unspent.
    for (const key of [randomBytes(32).toString('hex'), 'Z'.repeat(64), 'a b']) {
      const named = new URL(spare); named.searchParams.set('room', key)
      const response = await worker.fetch(new Request(named), env)
      assert.equal(response.status, 404); assert.match(await response.text(), /This preview has ended/)
      assert.equal((await worker.fetch(new Request('https://preview.test/app.js', { headers: { cookie: `cs_pv=${key}.${sid}` } }), env)).status, 404)
      assert.equal((await worker.fetch(new Request('https://preview.test/live', { headers: { upgrade: 'websocket', cookie: `cs_pv=${key}.${sid}` } }), env)).status, 404)
    }
    // The key joins nothing on the main Worker, and the main Worker hands no
    // __preview path to any object.
    let reached = 0
    const rooms = namespace(w), main = { PREVIEW_URL: 'https://preview.test', ROOMS: { ...rooms, get: id => { reached++; return rooms.get(id) } } }
    const outside = (path, init) => worker.fetch(new Request(`https://share.test${path}`, { ...init, headers: { 'x-shared-session-version': PLUGIN_LATEST, ...init?.headers } }), main)
    assert.equal((await outside(`/api/rooms/${w.key}/join`, { method: 'POST', body: JSON.stringify({ name: 'Stranger' }) })).status, 404)
    assert.equal((await outside(`/api/rooms/${w.key}`, { headers: { authorization: `Bearer ${w.member}` } })).status, 404)
    assert.equal(reached, 2)
    for (const id of [w.id, w.key]) {
      for (const [path, headers] of [[`__preview${spare.pathname}${spare.search}`, {}], ['__preview', {}], ['__preview/app.js', { cookie }], ['__preview/live', { cookie, upgrade: 'websocket' }]]) {
        assert.equal((await outside(`/api/rooms/${id}/${path}`, { headers })).status, 404, path)
      }
    }
    assert.equal(reached, 2, 'never forwarded')
    assert.equal((await w.obj.fetch(new Request(`https://room.internal/${w.key}/join`, { method: 'POST', headers: { 'x-shared-session-version': PLUGIN_LATEST }, body: '{"name":"Stranger"}' }))).status, 404)
    assert(!w.obj.room.tickets.get(spare.searchParams.get('ticket')).used, 'the spare link is still unused')
    // By the room's id: the preview Worker routes no name but a key, so a
    // link, a cookie or a socket naming the id reaches no room, and the room
    // itself answers its id on the preview path with nothing.
    const byId = new URL(spare); byId.searchParams.set('room', w.id)
    assert.equal((await worker.fetch(new Request(byId), env)).status, 404)
    assert.equal((await worker.fetch(new Request('https://preview.test/app.js', { headers: { cookie: `cs_pv=${w.id}.${sid}` } }), env)).status, 404)
    assert.equal((await worker.fetch(new Request('https://preview.test/live', { headers: { upgrade: 'websocket', cookie: `cs_pv=${w.id}.${sid}` } }), env)).status, 404)
    assert.equal((await w.obj.fetch(new Request(`https://room.internal/${w.id}/__preview/app.js`, { headers: { cookie } }))).status, 404)
    assert(!w.obj.room.tickets.get(spare.searchParams.get('ticket')).used, 'the spare link is still unused')
    console.log('OK Worker previews by the object id: the key joins nothing, the room id reaches nothing; the main Worker serves no preview, page or socket')
  }

  // A new link renews the browser session it goes on in (S3-1), on the Worker
  // too: a socket opened before closes at the expiry it had, by the alarm,
  // which isn't then due again at once (its expiry is behind it, so a socket
  // that went on would set it for the next millisecond, and the next), and
  // the browser opens it again under the renewed session, whose page serves.
  {
    const w = await world(), pid = (await api(w, 'previews', w.host, 'POST', { port: 43497 })).pid, H = 60 * 60_000, t0 = now
    const pair = await openPublic(w, pid)
    now = t0 + 12 * H - 60_000
    const minted = req(w, `previews/${pid}/ticket`, w.member, 'POST', { path: '/next' })
    minted.headers.set('x-preview-origin', 'https://preview.test')
    const link = new URL((await (await w.obj.fetch(minted)).json()).url)
    const renewing = await w.obj.fetch(new Request(`https://room.internal/${w.key}/__preview${link.pathname}${link.search}`, { headers: { cookie: pair.cookie } }))
    assert.equal(renewing.status, 302); assert.equal(renewing.headers.get('set-cookie').split(';')[0], pair.cookie, 'the same session')
    now = t0 + 12 * H + 1
    await w.obj.alarm()
    closed(pair, 1008)
    assert(w.state.storage.alarm > now + 1, 'the alarm is not due again at once')
    assert.equal((await w.obj.fetch(publicRequest(w, pair.cookie))).status, 101, 'the browser opens its socket again')
    const asking = w.obj.fetch(new Request(`https://room.internal/${w.key}/__preview/next`, { headers: { cookie: pair.cookie } }))
    await new Promise(resolve => setTimeout(resolve, 20))
    for (const p of w.obj.room.proxied.values()) p(new Response('still serving'))
    assert.equal(await (await asking).text(), 'still serving')
    console.log('OK Worker renewed browser session: a socket opened before closes at its own expiry by the alarm, which then waits; it reopens under the renewed one, whose page serves')
  }

  // A room's files on the Worker (S3-2): each one's record beside its bytes
  // (bm:<id>), never in its one value, so a room takes them past what that
  // value holds, and after the object sleeps they're served as they were. A
  // record in meta (none is written there) counts for nothing.
  {
    const w = await world()
    const upload = (r, body, name) => r.obj.fetch(new Request(`https://room.internal/${r.id}/files`, { method: 'POST', headers: { authorization: `Bearer ${r.host}`, 'x-file-name': name, 'content-type': 'image/png' }, body }))
    const files = []
    for (let i = 0; i < 600; i++) {
      now += 1 // each newer than the last
      const r = await upload(w, `picture ${i}`, `shot-${i}.png`)
      assert.equal(r.status, 200, `file ${i + 1}`); files.push(await r.json())
    }
    assert.equal(w.state.storage.data.get('meta').files, undefined, 'no records in meta')
    const kept = w.state.storage.data.get(`bm:${files[599].id}`)
    assert.deepEqual(kept, { id: files[599].id, name: 'shot-599.png', type: 'image/png', size: 11, ts: files[599].ts, chunks: 1 })
    await reconstruct(w)
    assert.equal(w.obj.room.files.size, 600)
    const got = await w.obj.fetch(req(w, `files/${files[123].id}`, w.member))
    assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png'); assert.equal(await got.text(), 'picture 123')
    assert.equal(w.obj.room.files.get(files[123].id).name, 'shot-123.png')
    await w.obj.persist()
    assert.equal(w.state.storage.data.get('meta').files, undefined, 'after it slept too')
    const stale = { ...files[599], name: 'stale.png', type: 'text/plain' }, ghost = { id: 'f'.repeat(64), name: 'ghost.png', type: 'image/png', size: 1, ts: now }
    w.state.storage.data.set('meta', { ...w.state.storage.data.get('meta'), files: { [stale.id]: stale, [ghost.id]: ghost } })
    await reconstruct(w)
    assert.deepEqual(w.obj.room.files.get(stale.id), files[599], "bm:'s record is the one")
    assert.equal(w.obj.room.files.has(ghost.id), false, "meta's alone is no file")
    assert.deepEqual(w.state.storage.data.get(`bm:${stale.id}`), kept, 'and stays as it was')
    console.log('OK Worker files beside their bytes, none in meta: 600 kept and served after sleep, a record in meta counting for nothing')
  }

  // The outer Worker refuses a declared length past the route's bound before
  // reading any of it, and streams every other body on to the room's object,
  // which reads it bounded (D2-7); the directory's it reads itself, bounded as
  // it arrives, and hands on whole.
  {
    const w = await world(), directed = [], rooms = namespace(w)
    let forwarded = 0, readFirst = null
    // The room's object counts what reaches it, and whether its body was read yet.
    const env = { PREVIEW_URL: 'https://preview.test', JOIN_LIMIT: { limit: async () => ({ success: true }) },
      ROOMS: { ...rooms, get: id => ({ fetch: r => { forwarded++; readFirst?.(); return rooms.get(id).fetch(r) } }) },
      DIRECTORY: { idFromName: name => name, get: () => ({ fetch: async r => { directed.push([r.headers.get('content-type'), await r.text()]); return new Response('{}') } }) } }
    const outer = (path, held) => worker.fetch(new Request(`https://share.test${path}`, held.request), env)
    for (const [path, length] of [[`/api/rooms/${w.id}/events`, bodyLimit('/api/rooms/x/events')], [`/api/rooms/${w.id}/join`, bodyLimit('/api/rooms/x/join')], [`/api/rooms/${w.id}/files`, bodyLimit('/api/rooms/x/files')], ['/api/rooms', bodyLimit('/api/rooms')], ['/api/teams', 3 * BODY_CHARS], ['/auth/confirm', 3 * BODY_CHARS]]) {
      const held = heldBody(w, 'events', w.member)
      held.request.headers.set('content-length', String(length + 1))
      const response = await outer(path, held)
      assert.equal(response.status, 413, path); assert.match((await response.json()).error, new RegExp(`limited to ${length} bytes`)); assert.equal(held.reads, 0, path)
    }
    assert.equal(forwarded, 0, 'refused before the room was asked'); assert.equal(directed.length, 0)
    assert.equal(bodyLimit('/api/rooms/x/files'), 10 * 1024 * 1024); assert.equal(bodyLimit('/api/rooms/x/events'), 1_536_000)
    // No length said: the directory's body is read here, to its bound and no further.
    let reads = 0
    const flood = new ReadableStream({ pull(controller) { if (++reads > 100) return controller.close(); controller.enqueue(new Uint8Array(16 * 1024).fill(32)) } }, { highWaterMark: 0 })
    assert.equal((await worker.fetch(new Request('https://share.test/api/teams', { method: 'POST', body: flood, duplex: 'half' }), env)).status, 413)
    assert.equal(reads, Math.ceil((3 * BODY_CHARS + 1) / (16 * 1024)), 'read no further than past the bound')
    assert.equal(directed.length, 0)
    const form = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('login=abc&nonce=')); controller.enqueue(new TextEncoder().encode('xyz')); controller.close() } })
    assert.equal((await worker.fetch(new Request('https://share.test/auth/confirm', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, duplex: 'half' }), env)).status, 200)
    assert.deepEqual(directed, [['application/x-www-form-urlencoded', 'login=abc&nonce=xyz']])
    // A room's body goes on as a stream: the object has the request before it's read.
    const held = heldBody(w, 'events', w.member)
    let unread = null
    readFirst = () => { unread = held.reads === 0 }
    const sending = outer(`/api/rooms/${w.id}/events`, held)
    await held.reading
    assert.equal(unread, true, 'forwarded before its body was read')
    readFirst = null
    held.release({ events: [{ type: 'chat', body: { text: 'streamed' } }] })
    assert.equal((await sending).status, 200); assert(w.obj.room.events.some(e => e.body?.text === 'streamed'))
    let streamed = 0
    const large = new ReadableStream({ pull(controller) { if (++streamed > 20) return controller.close(); controller.enqueue(new Uint8Array(512 * 1024).fill(32)) } }, { highWaterMark: 0 })
    const unsaid = new Request(`https://share.test/api/rooms/${w.id}/events`, { method: 'POST', headers: req(w, '', w.member).headers, body: large, duplex: 'half' })
    assert.equal((await worker.fetch(unsaid, env)).status, 413)
    assert(streamed <= 4, 'the room read it no further than past its bound')
    console.log('OK outer Worker: a declared length past the route bound refused unread, room bodies streamed to the object, the directory body read bounded and handed on')
  }

  // A public socket's bytes a second, and what a room's waiting browsers hold
  // together, are bounded on the Worker too (D2-6): past either, 1009.
  {
    const w = await world(), pid = (await api(w, 'previews', w.host, 'POST', { port: 43495 })).pid
    const mib = () => new Uint8Array(1024 ** 2).buffer
    const pair = await openPublic(w, pid)
    for (let i = 0; i < 2; i++) await w.obj.webSocketMessage(pair.guest, mib())
    await reconstruct(w) // counted in its attachment, past the object's sleep
    for (let i = 0; i < 2; i++) await w.obj.webSocketMessage(pair.guest, mib())
    assert.equal(pair.host.sent.length, 4); assert.equal(pair.guest.closes.length, 0)
    await w.obj.webSocketMessage(pair.guest, 'x')
    closed(pair, 1009); assert.equal(pair.host.sent.length, 4)
    const next = await openPublic(w, pid)
    for (let i = 0; i < 4; i++) await w.obj.webSocketMessage(next.guest, mib())
    now += PUBLIC_LIMITS.rateWindowMs
    await w.obj.webSocketMessage(next.guest, mib())
    assert.equal(next.guest.closes.length, 0, 'a new second, a new budget'); assert.equal(next.host.sent.length, 5)
    // Nine browsers waiting for the host, 1,000,000 bytes each: the ninth passes 8 MiB.
    const socketOn = async cookie => {
      assert.equal((await w.obj.fetch(publicRequest(w, cookie))).status, 101)
      const id = jsonControl(w.control).filter(x => x.ws).at(-1).ws.id
      return { id, pid, guest: w.state.getWebSockets(`pb:${id}`).at(-1) }
    }
    const waiting = [], bytes = () => new Uint8Array(1_000_000).buffer
    for (let i = 0; i < 9; i++) waiting.push(await socketOn(next.cookie))
    for (const p of waiting.slice(0, 8)) await w.obj.webSocketMessage(p.guest, bytes())
    assert.equal(w.obj.pendingBytes, 8_000_000)
    await w.obj.webSocketMessage(waiting[8].guest, bytes())
    assert.equal(waiting[8].guest.closes.at(-1).code, 1009)
    assert.equal(w.obj.pendingBytes, 8_000_000); assert(waiting.slice(0, 8).every(p => !p.guest.closes.length))
    // Paired or closed, a browser's bytes leave the count.
    await pairPublic(w, waiting[0])
    assert.equal(waiting[0].host.sent[0].byteLength, 1_000_000); assert.equal(w.obj.pendingBytes, 7_000_000)
    await w.obj.webSocketClose(waiting[1].guest, 1000, '')
    assert.equal(w.obj.pendingBytes, 6_000_000)
    const later = await socketOn(next.cookie)
    await w.obj.webSocketMessage(later.guest, bytes())
    assert.equal(later.guest.closes.length, 0); assert.equal(w.obj.pendingBytes, 7_000_000)
    await api(w, 'end', w.host, 'POST')
    assert.equal(w.obj.pendingBytes, 0)
    console.log('OK Worker public relay bounded in bytes: 4 MB a second a socket, kept across sleep; 8 MiB waiting a room, given back as browsers pair or close')
  }

  // A host half that vanished (1006 or 1015, no close frame) is a failure the
  // page sees, 1011; a host half's close frame passes as it came, and a
  // browser that vanished closes the host's plainly (C2-wsrelay2).
  {
    const w = await world(), pid = (await api(w, 'previews', w.host, 'POST', { port: 43496 })).pid
    const first = await openPublic(w, pid)
    const pairOn = async () => {
      assert.equal((await w.obj.fetch(publicRequest(w, first.cookie))).status, 101)
      const id = jsonControl(w.control).filter(x => x.ws).at(-1).ws.id
      return pairPublic(w, { id, pid, guest: w.state.getWebSockets(`pb:${id}`).at(-1) })
    }
    for (const [side, code, other] of [['host', 1006, 1011], ['host', 1015, 1011], ['host', 1000, 1000], ['host', 1001, 1001], ['host', 4000, 4000], ['guest', 1006, 1000], ['guest', 1001, 1001]]) {
      const pair = await pairOn()
      await w.obj.webSocketClose(pair[side], code, '')
      assert.equal(pair[side === 'host' ? 'guest' : 'host'].closes.at(-1).code, other, `${side} ${code}`)
    }
    assert.equal(first.guest.closes.length, 0)
    console.log('OK Worker public pair: a vanished host half is 1011 to the page; close frames pass; a vanished browser is 1000 to the host')
  }

  // A guest's need goes to the host's streams alone, whatever they say, and
  // across the object sleeping; with none open it isn't delivered, and the
  // guest is told so.
  {
    const w = await world(false)
    const ask = async port => { const r = await w.obj.fetch(req(w, 'need', w.member, 'POST', { port })); return [r.status, await r.json()] }
    assert.deepEqual(await ask(43300), [200, { delivered: false }])
    assert.equal((await w.obj.fetch(req(w, 'socket?after=0', w.member, 'GET', undefined, true))).status, 101)
    const viewer = w.state.getWebSockets(w.seat).at(-1)
    assert.deepEqual(await ask(43301), [200, { delivered: false }], "a guest's stream is no host's")
    assert.equal((await w.obj.fetch(req(w, 'socket?after=0', w.host, 'GET', undefined, true))).status, 101)
    const host = w.state.getWebSockets('host').at(-1)
    assert.deepEqual(await ask(43302), [200, { delivered: true }])
    await reconstruct(w)
    assert.deepEqual(await ask(43303), [200, { delivered: true }], 'after the object sleeps')
    assert.deepEqual(jsonControl(host).filter(x => x.need).map(x => x.need.port), [43302, 43303])
    assert.equal(jsonControl(viewer).some(x => x.need), false)
    console.log('OK Worker need to the host stream alone, kept across sleep; with none, delivered: false')
  }

  // Events are bounded in bytes on the Worker as in core (D2-5): a guest's past
  // 128 KB refused whole, a host's cut and stored as kept.
  {
    const w = await world(), seq = w.obj.room.seq
    const big = { events: [{ type: 'chat', body: { text: 'é'.repeat(20_000), more: ['界'.repeat(30_000), '界'.repeat(30_000)] } }] }
    assert.equal((await w.obj.fetch(req(w, 'events', w.member, 'POST', big))).status, 413)
    assert.equal(w.obj.room.seq, seq)
    assert.equal((await w.obj.fetch(req(w, 'events', w.host, 'POST', big))).status, 200)
    const stored = [...(await w.state.storage.list({ prefix: 'e:' })).values()].at(-1)
    assert(Buffer.byteLength(JSON.stringify(stored.body)) <= EVENT_BYTES); assert.match(stored.body.more[0], /…\(cut\)$/)
    assert.deepEqual(stored, w.obj.room.events.at(-1))
    console.log('OK Worker events bounded in bytes: a guest past 128 KB refused, a host cut and stored as kept')
  }

  // Streams alone hear room changes: broadcast never opens a TCP or public
  // attachment (D8b). A refused connection writes nothing: the room's minute
  // of opens is memory's (D-m5). The helpers' credit window is the server's (D9g).
  {
    const w = await world(), tcpPair = await open(w), publicPair = await openPublic(w, w.pid)
    assert(w.control.tags.includes('stream'))
    const opened = { n: 0 }
    for (const ws of [tcpPair.guest, tcpPair.host, publicPair.guest, publicPair.host]) {
      const read = ws.deserializeAttachment.bind(ws)
      ws.deserializeAttachment = () => { opened.n++; return read() }
    }
    const sent = w.control.sent.length
    w.obj.broadcast()
    assert.equal(opened.n, 0); assert.equal(w.control.sent.length, sent + 1)
    // The line a stream hears says what's shared now (Room.previewList).
    assert.deepEqual(JSON.parse(w.control.sent.at(-1)).previews, [{ pid: w.pid, port: 34567, tcp: true, title: 'localhost:34567' }])
    const r = await world()
    const connect = bearer => r.obj.fetch(req(r, `previews/${r.pid}/tunnel`, bearer, 'GET', undefined, true))
    r.obj.room.tcpSeatOpens.set(r.seat, { start: now, count: TCP_LIMITS.seatOpensPerMinute })
    let writes = r.state.storage.writes.length
    assert.equal((await connect(r.member)).status, 429)
    assert.deepEqual(r.state.storage.writes.slice(writes), [], "a seat's refusal changes nothing to save")
    r.obj.room.tcpStats.opens = { start: now, count: TCP_LIMITS.opensPerMinute }
    const other = (await (await r.obj.fetch(req(r, 'join', null, 'POST', { name: 'Other' }))).json()).token
    writes = r.state.storage.writes.length
    assert.equal((await connect(other)).status, 429)
    assert.deepEqual(r.state.storage.writes.slice(writes), [], "the room's minute moved, in memory: nothing written")
    assert.equal(r.obj.room.tcpStats.opens.count, TCP_LIMITS.opensPerMinute + 1)
    // A connection is admitted with no barrier and nothing written, so every
    // channel's messages go on while a browser opens more; the alarm is
    // written only when its time is sooner than the one already set.
    const c = await world()
    let barriers = 0
    const block = c.state.blockConcurrencyWhile.bind(c.state)
    c.state.blockConcurrencyWhile = fn => { barriers++; return block(fn) }
    writes = c.state.storage.writes.length
    await open(c, c.member, false)
    assert.equal(c.state.storage.alarm, now + TCP_LIMITS.pairMs, 'the pairing deadline is sooner: set')
    const alarms = c.state.storage.alarms
    for (let i = 0; i < 5; i++) await open(c, c.member, false)
    assert.equal(barriers, 0)
    assert.deepEqual(c.state.storage.writes.slice(writes), [])
    assert.equal(c.state.storage.alarms, alarms, 'the same deadline again writes no alarm')
    await reconstruct(c)
    assert.equal(c.obj.alarmAt, now + TCP_LIMITS.pairMs, 'a woken room knows the alarm it set')
    const helper = (await import('../plugin/relay/tcp-relay.cjs')).default
    assert.deepEqual([helper.DATA_MAX, helper.WINDOW_FRAMES, helper.WINDOW_BYTES], [TCP_LIMITS.dataBytes, TCP_LIMITS.creditFrames, TCP_LIMITS.creditBytes])
    console.log("OK broadcast to streams alone; refused and admitted connections write nothing, under no barrier; alarms only when sooner; the helpers' credit window is the server's")
  }
  console.log('PASS TCP Worker/core protocol checks (stdlib stubs; not a deployed Cloudflare test)')
} finally {
  Date.now = nativeNow
  globalThis.Response = NativeResponse
  globalThis.WebSocketPair = NativePair
}

// A client's wire frame, masked as a browser's are (or not), for raw sockets
// to the Workers under wrangler dev.
function masked(op, payload = Buffer.alloc(0), fin = true) {
  const n = payload.length, h = Buffer.alloc(n < 126 ? 2 : n < 65536 ? 4 : 10)
  h[0] = (fin ? 128 : 0) | op; h[1] = 128 | (n < 126 ? n : n < 65536 ? 126 : 127)
  if (h.length === 4) h.writeUInt16BE(n, 2)
  if (h.length === 10) h.writeBigUInt64BE(BigInt(n), 2)
  return Buffer.concat([h, Buffer.alloc(4), payload]) // deterministic test mask
}
async function rawSocket(port, path, bearer, cookie) {
  const socket = createConnection({ port, host: '127.0.0.1' })
  let buf = Buffer.alloc(0), status = 0, resolveHeaders, rejectHeaders
  const headers = new Promise((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject })
  const messages = [], waiters = []
  const deliver = value => {
    const waiter = waiters.shift()
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(value) } else messages.push(value)
  }
  socket.on('data', data => {
    buf = Buffer.concat([buf, data])
    if (!status) {
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      status = Number(/^HTTP\/1\.1 (\d+)/.exec(buf.subarray(0, end).toString())[1])
      buf = buf.subarray(end + 4); resolveHeaders(status)
    }
    if (status !== 101) return
    while (buf.length >= 2) {
      let n = buf[1] & 127, at = 2
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); at = 4 }
      if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); at = 10 }
      if (buf.length < at + n) return
      deliver({ op: buf[0] & 15, data: Buffer.from(buf.subarray(at, at + n)) })
      buf = buf.subarray(at + n)
    }
  })
  const ended = error => {
    rejectHeaders(error)
    for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error) }
  }
  socket.on('error', ended); socket.on('close', () => ended(new Error('wire socket closed')))
  await once(socket, 'connect')
  socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nAuthorization: Bearer ${bearer}\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`)
  await headers
  return { socket, status, next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: setTimeout(() => { const at = waiters.indexOf(waiter); if (at >= 0) waiters.splice(at, 1); reject(new Error('wire frame timeout')) }, 5000) }
    waiters.push(waiter)
  }) }
}
async function workerdFrames() {
  const server = await startWorkerd()
  const { origin, port, previewPort: preview } = server
  let reader
  const post = (path, bearer, body = {}) => fetch(`${origin}${path}`, { method: 'POST', headers: { authorization: bearer ? `Bearer ${bearer}` : '', 'x-shared-session-version': PLUGIN_LATEST }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  const api = (path, bearer, body = {}) => post(path, bearer, body).then(async r => { assert.equal(r.status, 200, await r.clone().text()); return r.json() })
  const heldPost = (path, bearer, length) => {
    let request, timer
    const answer = new Promise((resolve, reject) => {
      request = httpRequest(`${origin}${path}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-length': length } }, res => { res.resume(); resolve(res.statusCode) })
      request.on('error', reject)
      timer = setTimeout(() => request.destroy(new Error('HTTP rejection timeout')), 5000)
      request.flushHeaders()
    })
    answer.finally(() => clearTimeout(timer)).catch(() => {})
    return { request, answer }
  }
  try {
    const room = await api('/api/rooms', null, { name: 'Host' })
    const member = await api(`/api/rooms/${room.id}/join`, null, { name: 'Guest' })
    const p = await api(`/api/rooms/${room.id}/previews`, room.token, { port: 34567, tcp: true })
    const control = await fetch(`${origin}/api/rooms/${room.id}/stream?after=0`, { headers: { authorization: `Bearer ${room.token}` } })
    reader = control.body.getReader()
    let lines = ''
    const notice = async (kind = 'tcp') => {
      for (;;) {
        const end = lines.indexOf('\n')
        if (end >= 0) { const line = lines.slice(0, end); lines = lines.slice(end + 1); const data = JSON.parse(line); if (data[kind]) return data[kind]; continue }
        const chunk = await reader.read(); assert(!chunk.done)
        lines += new TextDecoder().decode(chunk.value)
      }
    }
    // A guest's TCP half comes with its seat's own token.
    const pending = async (bearer = member.token, pid = p.pid) => {
      const guest = await rawSocket(port, `/api/rooms/${room.id}/previews/${pid}/tunnel`, bearer)
      assert.equal(guest.status, 101)
      return { guest, id: (await notice()).id }
    }
    const pair = async (bearer = member.token, pid = p.pid) => {
      const waiting = await pending(bearer, pid), host = await rawSocket(port, `/api/rooms/${room.id}/ws/${waiting.id}`, room.token)
      assert.equal(host.status, 101)
      assert.deepEqual(JSON.parse((await waiting.guest.next()).data), { t: 'ready' })
      assert.deepEqual(JSON.parse((await host.next()).data), { t: 'ready' })
      return { ...waiting, host }
    }
    const rejection = await pending(), rejectPath = id => `/api/rooms/${room.id}/ws/${id}/reject`
    for (const bearer of [null, member.token]) assert.equal((await post(rejectPath(rejection.id), bearer, { code: 'BUSY' })).status, 401)
    const unauthorized = heldPost(rejectPath(rejection.id), member.token, 1_000_000)
    assert.equal(await unauthorized.answer, 401); unauthorized.request.destroy() // no body sent
    const oversized = heldPost(rejectPath(rejection.id), room.token, 1_000_000)
    oversized.request.write(' '.repeat(257))
    assert.equal(await oversized.answer, 400); oversized.request.destroy() // no EOF required
    for (const body of ['{', {}, [], { code: 'busy' }, { code: 'BUSY', extra: 1 }]) assert.equal((await post(rejectPath(rejection.id), room.token, body)).status, 400)
    assert.equal((await post(rejectPath('short'), room.token, { code: 'BUSY' })).status, 404)
    assert.equal((await post(rejectPath(token(12)), room.token, { code: 'BUSY' })).status, 404)
    const other = await api('/api/rooms', null, { name: 'Other room' })
    assert.equal((await post(`/api/rooms/${other.id}/ws/${rejection.id}/reject`, other.token, { code: 'BUSY' })).status, 404)
    const ticket = await api(`/api/rooms/${room.id}/previews/${p.pid}/ticket`, member.token)
    // The clearing page first (D2-3), then its next link, the browser's cookies cleared.
    const clearing = await fetch(ticket.url, { redirect: 'manual' })
    assert.equal(clearing.headers.get('clear-site-data'), '"cache", "cookies", "storage"')
    const entered = await fetch(new URL(/url=([^"]+)"/.exec(await clearing.text())[1].replaceAll('&amp;', '&'), ticket.url), { redirect: 'manual' })
    const cookie = entered.headers.get('set-cookie').split(';')[0]
    const publicSocket = await rawSocket(preview, '/live', '', cookie)
    assert.equal(publicSocket.status, 101)
    const publicId = (await notice('ws')).id
    // A waiting public browser is the host's to turn away too (C-reject).
    assert.equal((await post(rejectPath(publicId), member.token, { code: 'BUSY' })).status, 401)
    assert.equal((await post(rejectPath(publicId), room.token, { code: 'BUSY' })).status, 200)
    const publicClose = await publicSocket.next()
    assert.equal(publicClose.op, 8); assert.equal(publicClose.data.readUInt16BE(), 1013)
    publicSocket.socket.destroy()
    assert.deepEqual(await (await post(rejectPath(rejection.id), room.token, { code: 'BUSY' })).json(), { ok: true })
    assert.equal((await rejection.guest.next()).data.readUInt16BE(), 1013)
    assert.equal((await post(rejectPath(rejection.id), room.token, { code: 'CONNECT' })).status, 404)
    const lateHost = await rawSocket(port, `/api/rooms/${room.id}/ws/${rejection.id}`, room.token)
    assert.equal(lateHost.status, 410, 'that TCP channel has ended'); lateHost.socket.destroy(); rejection.guest.socket.destroy()
    const connectFailure = await pending()
    assert.equal((await post(rejectPath(connectFailure.id), room.token, JSON.stringify({ code: 'CONNECT' }).padStart(256, ' '))).status, 200)
    assert.equal((await connectFailure.guest.next()).data.readUInt16BE(), 1011); connectFailure.guest.socket.destroy()
    const raced = await pending(), delayed = heldPost(rejectPath(raced.id), room.token, 15)
    delayed.request.write('{"code":')
    const pairedHost = await rawSocket(port, `/api/rooms/${room.id}/ws/${raced.id}`, room.token)
    assert.equal(pairedHost.status, 101)
    delayed.request.end('"BUSY"}')
    assert.equal(await delayed.answer, 409)
    assert.deepEqual(JSON.parse((await raced.guest.next()).data), { t: 'ready' })
    assert.deepEqual(JSON.parse((await pairedHost.next()).data), { t: 'ready' })
    assert.equal((await post(rejectPath(raced.id), room.token, { code: 'CONNECT' })).status, 409)
    raced.guest.socket.destroy()
    assert.equal((await pairedHost.next()).data.readUInt16BE(), 1011); pairedHost.socket.destroy()
    const duplicateReject = await pending()
    const answers = await Promise.all(['BUSY', 'CONNECT'].map(code => post(rejectPath(duplicateReject.id), room.token, { code })))
    assert.deepEqual(answers.map(r => r.status).sort(), [200, 404])
    assert([1011, 1013].includes((await duplicateReject.guest.next()).data.readUInt16BE())); duplicateReject.guest.socket.destroy()
    console.log('OK workerd host-only rejection before body/EOF, bounded JSON, purpose/room checks and pairing races')
    // How a malformed frame closes (RSV bits, lengths, masks, fragments) is
    // the Workers runtime's own, as it parses frames: not tested here.
    const q = await pair()
    const cross = await rawSocket(port, `/api/rooms/${other.id}/ws/${q.id}`, other.token)
    assert.equal(cross.status, 410, 'no such socket in that room'); cross.socket.destroy()
    const duplicate = await rawSocket(port, `/api/rooms/${room.id}/ws/${q.id}`, room.token)
    assert.equal(duplicate.status, 409); duplicate.socket.destroy()
    q.guest.socket.write(Buffer.concat([masked(2, Buffer.from([11]), false), masked(9, Buffer.from([7])), masked(0, Buffer.from([22]))]))
    assert.deepEqual((await q.host.next()).data, Buffer.from([11, 22]))
    const credit = JSON.parse((await q.host.next()).data)
    assert.equal((await q.guest.next()).op, 10)
    q.host.socket.write(masked(1, Buffer.from(JSON.stringify({ t: 'ack', n: credit.n, nonce: credit.nonce }))))
    assert.equal(JSON.parse((await q.guest.next()).data).t, 'ack')
    q.guest.socket.write(masked(1, Buffer.from('{"t":"fin"}')))
    assert.equal(JSON.parse((await q.host.next()).data).t, 'fin')
    q.host.socket.write(masked(1, Buffer.from('{"t":"fin"}')))
    assert.equal(JSON.parse((await q.guest.next()).data).t, 'fin')
    assert.equal((await q.guest.next()).data.readUInt16BE(), 1000)
    assert.equal((await q.host.next()).data.readUInt16BE(), 1000)
    q.guest.socket.destroy(); q.host.socket.destroy()
    assert.equal((await post(`/api/rooms/${room.id}/previews/${p.pid}/tunnel`, member.token)).status, 404, 'no grant to ask for')
    const otherPort = await api(`/api/rooms/${room.id}/previews`, room.token, { port: 34568, tcp: true })
    const lanes = [p.pid, p.pid, otherPort.pid], slots = []
    for (let i = 0; i < 31; i++) slots.push(await (i % 2 ? pending : pair)(member.token, lanes[i % lanes.length]))
    const racedOpens = await Promise.all([0, 1].map(() => rawSocket(port, `/api/rooms/${room.id}/previews/${p.pid}/tunnel`, member.token)))
    assert.deepEqual(racedOpens.map(r => r.status).sort(), [101, 429])
    slots.push({ guest: racedOpens.find(r => r.status === 101), id: (await notice()).id })
    racedOpens.find(r => r.status === 429).socket.destroy()
    for (const pid of [p.pid, otherPort.pid]) {
      const denied = await rawSocket(port, `/api/rooms/${room.id}/previews/${pid}/tunnel`, member.token)
      assert.equal(denied.status, 429); denied.socket.destroy()
    }
    // A released slot is reusable at once.
    const released = slots.find(s => !s.host)
    assert.equal((await post(rejectPath(released.id), room.token, { code: 'BUSY' })).status, 200)
    assert.equal((await released.guest.next()).data.readUInt16BE(), 1013)
    slots.push(await pending())
    // Another seat's channels are its own: its Leave closes them alone, and
    // its token connects no more.
    const second = await api(`/api/rooms/${room.id}/join`, null, { name: 'Second' })
    const theirs = await pair(second.token, otherPort.pid)
    await api(`/api/rooms/${room.id}/leave`, second.token)
    assert.equal((await theirs.guest.next()).data.readUInt16BE(), 1008)
    assert.equal((await theirs.host.next()).data.readUInt16BE(), 1008)
    const gone = await rawSocket(port, `/api/rooms/${room.id}/previews/${otherPort.pid}/tunnel`, second.token)
    assert.equal(gone.status, 401); gone.socket.destroy()
    for (const s of [...slots, theirs]) { s.guest.socket.destroy(); s.host?.socket.destroy() }
    console.log("PASS workerd binary/credit/FIN, synchronous seat32 admission across previews, release, and a seat's Leave closing its own")
  } finally {
    await reader?.cancel().catch(() => {})
    await server.stop()
  }
}
await workerdFrames()
