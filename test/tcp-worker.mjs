// No model, dependencies or Cloudflare account. Exercise the real RoomObject
// with stdlib storage/hibernatable-socket stubs, including reconstruction.
import assert from 'node:assert/strict'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Room, PLUGIN_LATEST, TCP_LIMITS, token, tcpOperation, tcpSocketTarget, tcpState, tcpReserve, tcpControl, previewSocketTarget, previewRequest } from '../server/core.mjs'
import { RoomObject } from '../server/worker.mjs'

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
  async setAlarm(at) { this.alarm = at }
  async transaction(fn) { return fn(this) }
}
class State {
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
function req(w, path, bearer, method = 'GET', body, upgrade = false) {
  const headers = { 'x-shared-session-version': PLUGIN_LATEST }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  if (upgrade) headers.upgrade = 'websocket'
  return new Request(`https://room.internal/${w.id}/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
const jsonControl = ws => ws.sent.filter(x => typeof x === 'string').map(x => JSON.parse(x))
const tcp = ws => ws.deserializeAttachment().tcp
function live(w, side, id) { return w.state.getWebSockets(`${side === 'guest' ? 'tg' : 'th'}:${id}`).find(ws => !tcp(ws).closed) }
async function world(support = true) {
  const state = new State(), obj = new RoomObject(state, {})
  await state.barrier
  const w = { state, obj, id: token(16) }
  assert.equal((await obj.fetch(req(w, 'create', null, 'POST', { name: 'Host' }))).status, 200)
  w.host = obj.room.host.token
  const joined = await (await obj.fetch(req(w, 'join', null, 'POST', { name: 'Guest' }))).json()
  w.member = joined.token; w.seat = joined.seat
  w.pid = (await (await obj.fetch(req(w, 'previews', w.host, 'POST', { port: 34567 }))).json()).pid
  assert.equal((await obj.fetch(req(w, `socket?after=0${support ? '&tcp=1' : ''}`, w.host, 'GET', undefined, true))).status, 101)
  w.control = state.getWebSockets('host').at(-1)
  return w
}
async function grant(w, bearer = w.member) {
  const response = await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, bearer, 'POST'))
  assert.equal(response.status, 200)
  const cap = await response.json()
  assert.deepEqual(Object.keys(cap).sort(), ['expiresAt', 'port', 'protocol', 'token'])
  assert.equal(cap.protocol, 1); assert.equal(cap.port, 34567)
  return cap
}
async function open(w, cap, paired = true) {
  const seq = w.obj.room.seq
  assert.equal((await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, cap.token, 'GET', undefined, true))).status, 101)
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
async function ack(w, receiver) {
  const c = tcp(receiver).credits[0]
  assert(c)
  await w.obj.webSocketMessage(receiver, JSON.stringify({ t: 'ack', ...c }))
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

try {
  // Authentication, purpose isolation, cap persistence and legacy cookie path.
  {
    const w = await world(false), seq = w.obj.room.seq
    assert.equal((await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, w.member, 'POST'))).status, 503)
    const oldControl = w.control
    await w.obj.fetch(req(w, 'socket?tcp=1', w.host, 'GET', undefined, true))
    w.control = w.state.getWebSockets('host').at(-1)
    const cap = await grant(w)
    assert.equal(w.obj.room.seq, seq)
    assert.deepEqual(w.obj.room.previewSessions.get(cap.token), { pid: w.pid, seat: w.seat, scope: 'tcp', exp: cap.expiresAt })
    const copy = Room.resume(structuredClone(w.obj.room.toJSON()), now)
    assert.equal(copy.previewSessions.get(cap.token).scope, 'tcp')
    for (const [pid, bearer] of [[w.pid, w.member], [w.pid, w.host], ['wrong-pid', cap.token], [w.pid, 'missing']]) {
      assert.equal((await w.obj.fetch(req(w, `previews/${pid}/tunnel`, bearer, 'GET', undefined, true))).status, 401)
    }
    const cookieReq = new Request('https://preview.local/test', { headers: { cookie: `cs_pv=${w.id}.${cap.token}` } })
    assert.equal(previewSocketTarget(w.obj.room, cookieReq, now).ok, false)
    assert.equal((await previewRequest(w.obj.room, cookieReq, now)).response.status, 404)
    const ticket = await (await w.obj.fetch(req(w, `previews/${w.pid}/ticket`, w.member, 'POST', { path: '/app?a=1' }))).json()
    // RoomObject normally gets this header from the outer Worker.
    assert.equal(ticket.error, 'This server does not serve previews.')
    w.obj.room.previewSessions.set('old-http', { pid: w.pid, exp: now + 100_000 })
    const publicReq = new Request(`https://preview.local/app?a=1`, { headers: { cookie: `cs_pv=${w.id}.old-http` } })
    assert.equal(previewSocketTarget(w.obj.room, publicReq, now).ok, true)
    assert.equal((await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, 'old-http', 'GET', undefined, true))).status, 401)
    const pair = await open(w, cap)
    assert.equal(jsonControl(oldControl).some(x => x.tcp), false) // only capable host got tcp
    const other = await world()
    assert.equal((await other.obj.fetch(req(other, `previews/${other.pid}/tunnel`, cap.token, 'GET', undefined, true))).status, 401)
    assert.equal((await other.obj.fetch(req(other, `ws/${pair.id}`, other.host, 'GET', undefined, true))).status, 410)
    await w.obj.webSocketError(pair.guest); closed(pair, 1011)
    console.log('OK capability room/pid/scope isolation, persistence and host support')
  }

  // Both directions, half-close, challenge restoration, and no payload writes.
  {
    const w = await world(), cap = await grant(w), pair = await open(w, cap)
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
    assert.equal(w.state.storage.writes.length, writesBefore)
    assert.equal(w.obj.room.seq, resumedSeq) // resume advances seq, data never appends
    assert.equal(w.obj.room.events.some(e => e.type === 'tcp'), false)
    const used = w.obj.room.tcpStats.used
    await reconstruct(w)
    assert.equal(w.obj.room.tcpStats.used, used)
    assert.equal(w.obj.tcpSockets().length, 0) // close markers survive reload
    console.log('OK binary/credit/FIN, hibernation reconstruction and bounded metadata-only writes')
  }

  // Strict controls, FIFO single-consumption nonce and enforced credit window.
  {
    const w = await world(), cap = await grant(w)
    const premature = await open(w, cap, false)
    await w.obj.webSocketMessage(premature.guest, new Uint8Array([1]).buffer)
    closed(premature, 1008); assert.equal(w.obj.pending.size, 0)
    for (const bad of [new Uint8Array(65_537).buffer, ' '.repeat(257), '{"t":"ready"}', '{"t":"fin","extra":1}']) {
      const p = await open(w, cap)
      await w.obj.webSocketMessage(p.guest, bad)
      closed(p, typeof bad !== 'string' || bad.length > 256 ? 1009 : 1008)
    }
    const p = await open(w, cap)
    for (let i = 0; i < 4; i++) await w.obj.webSocketMessage(p.guest, new Uint8Array(TCP_LIMITS.dataBytes).buffer)
    assert.equal(tcp(p.host).credits.length, 4)
    await w.obj.webSocketMessage(p.guest, new Uint8Array([1]).buffer)
    closed(p, 1008)
    for (const mutation of ['wrong-n', 'wrong-direction', 'reordered', 'reused']) {
      const q = await open(w, cap)
      await w.obj.webSocketMessage(q.guest, new Uint8Array([1, 2]).buffer)
      const c = tcp(q.host).credits[0]
      if (mutation === 'reordered') await w.obj.webSocketMessage(q.guest, new Uint8Array([3, 4]).buffer)
      if (mutation === 'reused') await ack(w, q.host)
      const notice = mutation === 'reordered' ? tcp(q.host).credits[1] : { ...c, ...(mutation === 'wrong-n' ? { n: 1 } : {}) }
      await w.obj.webSocketMessage(mutation === 'wrong-direction' ? q.guest : q.host, JSON.stringify({ t: 'ack', ...notice }))
      closed(q, 1008)
    }
    const q = await open(w, cap)
    const s = tcp(q.guest); s.rate.data = TCP_LIMITS.dataPerWindow
    q.guest.serializeAttachment({ tcp: s })
    await w.obj.webSocketMessage(q.guest, new Uint8Array([1]).buffer); closed(q, 1008)
    console.log('OK premature data, frame/control size, nonce/FIFO/one-use, credit and DATA rate limits')
  }

  // Cumulative control ceiling is exact and survives hibernation; ACKs cannot
  // make the server queue unbounded control output to a non-reading sender.
  {
    const w = await world(), cap = await grant(w), p = await open(w, cap)
    const n = JSON.stringify({ t: 'credit', n: 1, nonce: 'a'.repeat(22) }).length
    const s = tcp(p.host); s.controlSent = TCP_LIMITS.bufferBytes - n
    p.host.serializeAttachment({ tcp: s })
    await w.obj.webSocketMessage(p.guest, new Uint8Array([1]).buffer)
    assert.equal(tcp(p.host).controlSent, TCP_LIMITS.bufferBytes)
    await reconstruct(w)
    assert.equal(tcp(p.host).controlSent, TCP_LIMITS.bufferBytes)
    await ack(w, p.host)
    await w.obj.webSocketMessage(p.guest, new Uint8Array([2]).buffer); closed(p, 1008)
    const exact = { controlSent: TCP_LIMITS.bufferBytes - 11 }
    assert.equal(tcpControl(exact, { t: 'fin' }).length, 11)
    assert.equal(exact.controlSent, TCP_LIMITS.bufferBytes)
    assert.throws(() => tcpControl(exact, { t: 'fin' }), /control output limit/)
    console.log('OK exact lifetime control-output bound and reconstruction')
  }

  // Rebind/Open/reload gets a fresh grant: roll this seat/pid's oldest rather
  // than locking a listener out for twelve hours. Other owners/ports stay live.
  {
    const w = await world(), first = await grant(w), p1 = await open(w, first)
    const second = await grant(w), p2 = await open(w, second)
    const otherMember = (await (await w.obj.fetch(req(w, 'join', null, 'POST', { name: 'Other' }))).json()).token
    const otherCap = await grant(w, otherMember), otherPair = await open(w, otherCap)
    const otherPid = (await (await w.obj.fetch(req(w, 'previews', w.host, 'POST', { port: 34568 }))).json()).pid
    const otherPort = { ...w, pid: otherPid }
    const portCap = await (await w.obj.fetch(req(w, `previews/${otherPid}/tunnel`, w.member, 'POST'))).json()
    const portPair = await open(otherPort, portCap)
    const third = await grant(w)
    closed(p1, 1008)
    assert.equal((await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, first.token, 'GET', undefined, true))).status, 401)
    const p3 = await open(w, third), fourth = await grant(w), p4 = await open(w, fourth)
    closed(p2, 1008)
    assert.equal(p3.guest.closes.length, 0); assert.equal(p4.guest.closes.length, 0)
    assert.equal(otherPair.guest.closes.length, 0); assert.equal(portPair.guest.closes.length, 0)
    assert(w.obj.room.previewSessions.has(otherCap.token)); assert(w.obj.room.previewSessions.has(portCap.token))
    assert.equal([...w.obj.room.previewSessions.values()].filter(s => s.scope === 'tcp' && s.seat === w.seat && s.pid === w.pid).length, 2)
    // A room at its cap ceiling can replace its own grant without exceeding it.
    for (let i = w.obj.room.previewSessions.size; i < TCP_LIMITS.roomCaps; i++) w.obj.room.previewSessions.set(`filler${i}`, { pid: w.pid, seat: `filler${i}`, scope: 'tcp', exp: now + TCP_LIMITS.capMs })
    await grant(w)
    assert.equal(w.obj.room.previewSessions.size, TCP_LIMITS.roomCaps)
    closed(p3, 1008)
    assert.equal(otherPair.guest.closes.length, 0); assert.equal(portPair.guest.closes.length, 0)
    console.log('OK rolling two-grant renewal, replaced-cap revocation and seat/preview isolation')
  }

  // Capability/concurrency/admission/budget ceilings do not reset on new caps.
  {
    const w = await world(), cap = await grant(w)
    await grant(w)
    const pairs = []
    for (let i = 0; i < TCP_LIMITS.capPairs; i++) pairs.push(await open(w, cap, false))
    assert.equal((await w.obj.fetch(req(w, `previews/${w.pid}/tunnel`, cap.token, 'GET', undefined, true))).status, 429)
    assert.equal(tcpSocketTarget(w.obj.room, req(w, '', cap.token), w.pid, now, Array.from({ length: TCP_LIMITS.roomPairs }, () => ({ cap: 'other' }))).status, 429)
    for (const p of pairs) await w.obj.webSocketError(p.guest)
    w.obj.room.tcpStats.opens = { start: now, count: 0 }
    for (let i = 0; i < TCP_LIMITS.opensPerMinute; i++) assert.equal(tcpOperation(w.obj.room, now), true)
    assert.equal(tcpOperation(w.obj.room, now), false)
    await w.obj.persistTCPStats(); await reconstruct(w)
    assert.equal(tcpOperation(w.obj.room, now), false)
    now += TCP_LIMITS.openWindowMs + 1
    assert.equal(tcpOperation(w.obj.room, now), true)
    w.obj.room.tcpStats.used = TCP_LIMITS.roomBytes - TCP_LIMITS.reserveBytes
    await w.obj.persistTCPStats()
    const q = await open(w, cap)
    await w.obj.webSocketMessage(q.guest, new Uint8Array([1]).buffer)
    assert.equal(w.obj.room.tcpStats.used, TCP_LIMITS.roomBytes)
    await reconstruct(w)
    await w.obj.webSocketMessage(q.host, new Uint8Array([2]).buffer); closed(q, 1008)
    assert.equal(w.obj.room.tcpStats.used, TCP_LIMITS.roomBytes)
    const restored = Room.resume(w.obj.room.toJSON(), now), fresh = tcpState(token(12), { ...tcp(q.guest), cap: 'new-cap' }, 'guest', now)
    assert.equal(tcpReserve(restored, fresh), false)
    const r = await world()
    for (let i = 0; i < TCP_LIMITS.roomCaps; i++) r.obj.room.previewSessions.set(`cap${i}`, { pid: r.pid, seat: `seat${i}`, scope: 'tcp', exp: now + TCP_LIMITS.capMs })
    assert.equal((await r.obj.fetch(req(r, `previews/${r.pid}/tunnel`, r.member, 'POST'))).status, 429)
    console.log('OK cap/pair/admission and monotonic room-lifetime reservation limits')
  }

  // Idle timeout and revocation are alarm-driven, including through reload.
  {
    const w = await world(), cap = await grant(w), p = await open(w, cap), idle = await open(w, cap, false)
    assert.equal(w.state.storage.alarm, now + TCP_LIMITS.pairMs)
    await reconstruct(w)
    now += TCP_LIMITS.pairMs + 1
    await w.obj.alarm(); closed(idle, 1008)
    // A duplicate host after the pairing deadline must not end a ready pair.
    assert.equal((await w.obj.fetch(req(w, `ws/${p.id}`, w.host, 'GET', undefined, true))).status, 409)
    assert.equal(p.guest.closes.length, 0); assert.equal(p.host.closes.length, 0)
    // Even before its deadline, a ready channel whose peer disappeared cannot
    // be re-paired: reconnecting never restores an old TCP byte stream.
    const orphan = await open(w, cap)
    w.state.sockets = w.state.sockets.filter(ws => ws !== orphan.host)
    assert.equal((await w.obj.fetch(req(w, `ws/${orphan.id}`, w.host, 'GET', undefined, true))).status, 410)
    assert.equal(orphan.guest.closes.at(-1)?.code, 1008)
    assert.equal(w.state.getWebSockets(`th:${orphan.id}`).length, 0)
    now += 50_000
    await w.obj.alarm()
    assert(w.obj.room.away.has(w.member)); assert(w.obj.room.previewSessions.has(cap.token))
    assert.equal(p.guest.closes.length, 0) // grace/away is not Leave
    assert.equal((await w.obj.fetch(req(w, 'leave', w.member, 'POST'))).status, 200)
    closed(p, 1008); assert.equal(w.obj.room.previewSessions.has(cap.token), false)
    for (const action of ['preview', 'room', 'expiry', 'ttl']) {
      const r = await world(), c = await grant(r), active = await open(r, c), waiting = await open(r, c, false)
      if (action === 'preview') await r.obj.fetch(req(r, `previews/${r.pid}/end`, r.host, 'POST'))
      if (action === 'room') await r.obj.fetch(req(r, 'end', r.host, 'POST'))
      if (action === 'expiry') { now = c.expiresAt; await reconstruct(r); await r.obj.alarm() }
      if (action === 'ttl') {
        await r.obj.webSocketClose(r.control, 1000, '')
        r.state.sockets = r.state.sockets.filter(ws => ws !== r.control)
        now += 24 * 60 * 60 * 1000 + 1001
        await r.obj.alarm()
        assert.equal(r.obj.room, null); assert.equal(r.state.storage.data.size, 0)
      }
      assert(active.guest.closes.length); assert(active.host.closes.length); assert(waiting.guest.closes.length)
    }
    console.log('OK alarms, away vs Leave, preview/room/expiry/TTL active and idle revocation')
  }
  console.log('PASS TCP Worker/core protocol checks (stdlib stubs; not a deployed Cloudflare test)')
} finally {
  Date.now = nativeNow
  globalThis.Response = NativeResponse
  globalThis.WebSocketPair = NativePair
}

// The Node adapter's RFC parser is not exercised by hibernation stubs. Feed it
// real masked/unmasked wire frames, including zero-byte fragments across its
// per-second rate window (the aggregate fragment count must still be bounded).
async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
function masked(op, payload = Buffer.alloc(0), fin = true) {
  const n = payload.length, h = Buffer.alloc(n < 126 ? 2 : n < 65536 ? 4 : 10)
  h[0] = (fin ? 128 : 0) | op; h[1] = 128 | (n < 126 ? n : n < 65536 ? 126 : 127)
  if (h.length === 4) h.writeUInt16BE(n, 2)
  if (h.length === 10) h.writeBigUInt64BE(BigInt(n), 2)
  return Buffer.concat([h, Buffer.alloc(4), payload]) // deterministic test mask
}
async function rawSocket(port, path, bearer) {
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
  socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nAuthorization: Bearer ${bearer}\r\n\r\n`)
  await headers
  return { socket, status, next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: setTimeout(() => { const at = waiters.indexOf(waiter); if (at >= 0) waiters.splice(at, 1); reject(new Error('wire frame timeout')) }, 5000) }
    waiters.push(waiter)
  }) }
}
async function nodeFrames() {
  const port = await freePort(), preview = await freePort()
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/node.mjs', import.meta.url))], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, PORT: String(port), PREVIEW_PORT: String(preview), DATA_FILE: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = '', reader
  child.stdout.on('data', b => { logs += b }); child.stderr.on('data', b => { logs += b })
  const origin = `http://127.0.0.1:${port}`
  const api = (path, bearer, body = {}) => fetch(`${origin}${path}`, { method: 'POST', headers: { authorization: bearer ? `Bearer ${bearer}` : '', 'x-shared-session-version': PLUGIN_LATEST }, body: JSON.stringify(body) }).then(async r => { assert.equal(r.status, 200, await r.clone().text()); return r.json() })
  try {
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(logs)
      if (await fetch(`${origin}/api/health`).then(r => r.ok).catch(() => false)) { ready = true; break }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert(ready, logs)
    const room = await api('/api/rooms', null, { name: 'Host' })
    const member = await api(`/api/rooms/${room.id}/join`, null, { name: 'Guest' })
    const p = await api(`/api/rooms/${room.id}/previews`, room.token, { port: 34567 })
    const control = await fetch(`${origin}/api/rooms/${room.id}/stream?tcp=1&after=0`, { headers: { authorization: `Bearer ${room.token}` } })
    reader = control.body.getReader()
    const cap = await api(`/api/rooms/${room.id}/previews/${p.pid}/tunnel`, member.token)
    let lines = ''
    const notice = async () => {
      for (;;) {
        const end = lines.indexOf('\n')
        if (end >= 0) { const line = lines.slice(0, end); lines = lines.slice(end + 1); const data = JSON.parse(line); if (data.tcp) return data.tcp; continue }
        const chunk = await reader.read(); assert(!chunk.done)
        lines += new TextDecoder().decode(chunk.value)
      }
    }
    const pair = async () => {
      const guest = await rawSocket(port, `/api/rooms/${room.id}/previews/${p.pid}/tunnel`, cap.token)
      assert.equal(guest.status, 101)
      const target = await notice(), host = await rawSocket(port, `/api/rooms/${room.id}/ws/${target.id}`, room.token)
      assert.equal(host.status, 101)
      assert.deepEqual(JSON.parse((await guest.next()).data), { t: 'ready' })
      assert.deepEqual(JSON.parse((await host.next()).data), { t: 'ready' })
      return { guest, host, id: target.id }
    }
    const lengthHeader = n => { const h = Buffer.alloc(14); h[0] = 0x82; h[1] = 0xff; h.writeBigUInt64BE(n, 2); return h }
    const malformed = [
      [Buffer.from([0x82, 1, 0]), 1002], // unmasked
      [Buffer.from([0xc2, 0x80, 0, 0, 0, 0]), 1002], // RSV
      [masked(0), 1002], // continuation without a fragmented message
      [Buffer.from([0x09, 0x80, 0, 0, 0, 0]), 1002], // fragmented ping
      [Buffer.from([0x82, 0xfe, 0, 1, 0, 0, 0, 0, 0]), 1002], // noncanonical length
      [lengthHeader(1n << 53n), 1009], [lengthHeader(1n << 63n), 1002],
      [lengthHeader(65_537n), 1009], [masked(1, Buffer.from([255])), 1007],
      [masked(8, Buffer.from([3, 238])), 1002], // reserved close code 1006
      [masked(1, Buffer.alloc(257, 32)), 1009],
    ]
    for (const [bytes, code] of malformed) {
      const q = await pair()
      q.guest.socket.write(bytes)
      const close = await q.guest.next(); assert.equal(close.op, 8); assert.equal(close.data.readUInt16BE(), code)
      const otherClose = await q.host.next(); assert.equal(otherClose.op, 8); assert.equal(otherClose.data.readUInt16BE(), code)
      q.guest.socket.destroy(); q.host.socket.destroy()
    }
    const q = await pair(), other = await api('/api/rooms', null, { name: 'Other room' })
    const cross = await rawSocket(port, `/api/rooms/${other.id}/ws/${q.id}`, other.token)
    assert.equal(cross.status, 404); cross.socket.destroy()
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
    const fragments = await pair()
    fragments.guest.socket.write(Buffer.concat([masked(2, Buffer.alloc(0), false), ...Array.from({ length: 2048 }, () => masked(0, Buffer.alloc(0), false))]))
    await new Promise(resolve => setTimeout(resolve, TCP_LIMITS.rateWindowMs + 30))
    fragments.guest.socket.write(Buffer.concat(Array.from({ length: 2048 }, () => masked(0, Buffer.alloc(0), false))))
    const fragmentClose = await fragments.guest.next()
    assert.equal(fragmentClose.op, 8); assert.equal(fragmentClose.data.readUInt16BE(), 1009)
    assert.equal((await fragments.host.next()).data.readUInt16BE(), 1009)
    fragments.guest.socket.destroy(); fragments.host.socket.destroy()
    console.log('PASS Node raw RFC frames, fragmentation across rate windows, binary/FIN and room/host binding')
  } finally {
    await reader?.cancel().catch(() => {})
    child.kill()
    if (child.exitCode === null) await once(child, 'exit')
  }
}
await nodeFrames()
