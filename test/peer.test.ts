// No model or product accounts. Messages between a teammate's own sessions
// and the host's session (POST peer), and receipts for them, both ways:
// through the real Workers under wrangler dev, to the other side's streams alone, the guest's
// seat and name stamped by the room, never stored, never anyone else's; their
// refusals and minute allowances; and the Worker's routing of the same by its
// streams' tags and attachments, through a reconstruction, with stdlib
// storage/hibernatable-socket stubs.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, describe, test } from 'vitest'
import { PLUGIN_LATEST, PEER_LIMIT, PEER_HANDLE, PEER_STATUS, PEER_DROPS, streamedRoomBody, homePage, token } from '../server/core/index.ts'
import { RoomObject } from '../server/worker/index.ts'
import type { ServerEnv } from '../server/worker/index.ts'
import { State, asSocket, asState, installRuntime } from './support/durable.ts'
import type { Socket } from './support/durable.ts'
import { startWorkerd } from './support/workerd.mjs'
import type { Workerd } from './support/workerd.mjs'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const HANDLE = 'a1'.repeat(16)
const CHAIN = ['ab'.repeat(12), 'cd'.repeat(12)]
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e', REF = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

test('a streamed route, its bounds, and the home page says these messages pass through and are never kept', async () => {
  assert.equal(streamedRoomBody('POST', 'peer'), true, 'the peer route reads its own bounded body')
  assert.equal(streamedRoomBody('GET', 'peer'), false)
  assert.equal(streamedRoomBody('POST', 'reply'), false, 'no reply route any more')
  assert(PEER_HANDLE.test(HANDLE) && !PEER_HANDLE.test('A1'.repeat(16)) && !PEER_HANDLE.test('a1'.repeat(15)))
  assert.deepEqual([PEER_LIMIT.host, PEER_LIMIT.seat, PEER_LIMIT.periodMs, PEER_LIMIT.bodyBytes, PEER_LIMIT.bodyChars, PEER_LIMIT.chain, PEER_LIMIT.nameChars], [120, 60, 60_000, 128 * 1024, 32_000, 32, 80])
  assert.deepEqual([...PEER_STATUS], ['held', 'denied', 'delivered', 'expired', 'refused', 'dropped'], "Claude Code's receipts' statuses")
  assert.deepEqual([...PEER_DROPS], ['rate-limited', 'duplicate', 'hop-loop', 'hop-runaway', 'queue-full'], "and why it drops one")
  const text = await homePage().text()
  const said = "messages between a teammate's own other sessions and the host's session, which go to the other side alone (passed along, never kept)"
  assert(text.includes(said), said)
})

// One stream as the plugin reads it: every line kept, and a wait for one.
type Line = { events?: unknown[], peer?: Record<string, any> }
function reader(response: Response) {
  const lines: Line[] = []
  const body = response.body!.getReader()
  let buffer = ''
  const done = (async () => {
    for (;;) {
      const { value, done } = await body.read().catch(() => ({ done: true, value: undefined }))
      if (done) return
      buffer += new TextDecoder().decode(value)
      let i
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim()
        buffer = buffer.slice(i + 1)
        if (line) lines.push(JSON.parse(line))
      }
    }
  })()
  return {
    lines,
    peers: () => lines.filter(l => l.peer).map(l => l.peer),
    until: async (test: (line: Line) => boolean, ms = 3000) => {
      for (const end = Date.now() + ms; Date.now() < end; await wait(10)) if (lines.some(test)) return true
      return false
    },
    close: async () => { await body.cancel().catch(() => {}); await done },
  }
}

type Reader = ReturnType<typeof reader>
describe('through the real Workers under wrangler dev', () => {
  let server: Workerd
  const streams: Reader[] = []
  beforeAll(async () => { server = await startWorkerd() })
  afterAll(async () => {
    for (const s of streams) await s.close()
    await server?.stop()
  })
  const http = (path: string, bearer: string | null, method = 'GET', body?: unknown) => fetch(`${server.origin}${path}`, { method, headers: {
    authorization: bearer ? `Bearer ${bearer}` : '', 'x-shared-session-version': PLUGIN_LATEST,
  }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
  const ok = async (...args: Parameters<typeof http>): Promise<any> => { const r = await http(...args); assert.equal(r.status, 200, await r.clone().text()); return r.json() }
  const stream = async (base: string, bearer: string, query: string) => {
    const r = await http(`${base}/stream?after=0${query}`, bearer)
    assert.equal(r.status, 200)
    const s = reader(r)
    streams.push(s)
    assert(await s.until(l => Array.isArray(l.events)), 'the stream opened')
    return s
  }
  type Seat = { token: string, seat: string }
  // Made by the first test, and used by the ones after it, in order.
  // As the server answers them: what they hold is what the checks read.
  let room: any, base: string, scott: any, alex: any, riley: any, later: any
  let hostStream: Reader, scottStream: Reader, scottAgain: Reader, alexStream: Reader, rileyStream: Reader
  let fromHost: (body: unknown) => Promise<Response>, fromGuest: (who: Seat, body: unknown) => Promise<Response>
  let up: Record<string, unknown>, good: Record<string, unknown>

  test("a guest's message and receipts go to the host's streams with its seat and name stamped, the host's to that seat's alone, never others, history or a later joiner", async () => {
    room = await ok('/api/rooms', null, 'POST', { name: 'Host' })
    assert.equal(room.peer, undefined, 'a room says nothing of what its server passes on')
    assert.equal(room.replies, undefined)
    base = `/api/rooms/${room.id}`
    scott = await ok(`${base}/join`, null, 'POST', { name: 'Scott' })
    assert.equal(scott.peer, undefined, 'nor a join')
    alex = await ok(`${base}/join`, null, 'POST', { name: 'Alex' })
    riley = await ok(`${base}/join`, null, 'POST', { name: 'Riley' })
    // Streams say nothing of what they take: every one takes these.
    hostStream = await stream(base, room.token, '')
    scottStream = await stream(base, scott.token, '')
    scottAgain = await stream(base, scott.token, '')
    alexStream = await stream(base, alex.token, '')
    rileyStream = await stream(base, riley.token, '')
    fromHost = (body: unknown) => http(`${base}/peer`, room.token, 'POST', body)
    fromGuest = (who: Seat, body: unknown) => http(`${base}/peer`, who.token, 'POST', body)

    // A guest's message: to the host's streams alone, its seat and name the room's.
    up = { handle: HANDLE, name: 'composition', mode: 'prompting', chain: CHAIN, id: ID, pid: 'p1abc', body: 'Can you check the build?' }
    assert.deepEqual(await (await fromGuest(scott, { ...up })).json(), { delivered: true })
    assert(await hostStream.until(l => l.peer?.handle === HANDLE), 'the host got it')
    assert.deepEqual(hostStream.peers(), [{ seat: scott.seat, who: 'Scott', handle: HANDLE, name: 'composition', mode: 'prompting', chain: CHAIN, id: ID, pid: 'p1abc', body: 'Can you check the build?' }])
    for (const body of [{ ...up, seat: alex.seat }, { ...up, who: 'Alex' }, { ...up, to: alex.seat }, { ...up, ref: REF }]) assert.equal((await fromGuest(scott, body)).status, 400, 'a guest names no seat, no sender, no recipient and no ref')
    // The host's answer: to Scott's seat, both of its streams, no one else's.
    assert.deepEqual(await (await fromHost({ to: scott.seat, handle: HANDLE, body: 'Here are the traces.', ref: REF })).json(), { delivered: true })
    for (const s of [scottStream, scottAgain]) assert(await s.until(l => l.peer?.handle === HANDLE), 'the seat got it')
    for (const s of [scottStream, scottAgain]) assert.deepEqual(s.peers(), [{ handle: HANDLE, body: 'Here are the traces.', ref: REF }])
    // Receipts either way: what became of the host's message at the
    // teammate's session, and of the teammate's at the host's.
    assert.deepEqual(await (await fromGuest(scott, { handle: HANDLE, status: 'held', ref: REF })).json(), { delivered: true })
    assert(await hostStream.until(l => l.peer?.status === 'held'), 'the host got the receipt')
    assert.deepEqual(hostStream.peers().at(-1), { seat: scott.seat, handle: HANDLE, status: 'held', ref: REF })
    assert.deepEqual(await (await fromGuest(scott, { handle: HANDLE, status: 'dropped', ref: REF, reason: 'hop-loop' })).json(), { delivered: true })
    assert(await hostStream.until(l => l.peer?.reason === 'hop-loop'))
    assert.deepEqual(hostStream.peers().at(-1), { seat: scott.seat, handle: HANDLE, status: 'dropped', ref: REF, reason: 'hop-loop' })
    assert.deepEqual(await (await fromHost({ to: scott.seat, handle: HANDLE, status: 'delivered', id: ID })).json(), { delivered: true })
    assert(await scottStream.until(l => l.peer?.status === 'delivered'), 'the seat got the receipt')
    assert.deepEqual(scottStream.peers().at(-1), { handle: HANDLE, status: 'delivered', id: ID })
    for (const body of [{ handle: HANDLE, status: 'read', ref: REF }, { handle: HANDLE, status: 'held', ref: 'nope' }, { handle: HANDLE, status: 'held', id: ID }, { handle: HANDLE, status: 'held', ref: REF, reason: 'hop-loop' },
      { handle: HANDLE, status: 'dropped', ref: REF, reason: 'bored' }, { handle: HANDLE, status: 'held', ref: REF, body: 'x' }]) {
      assert.equal((await fromGuest(scott, body)).status, 400, JSON.stringify(body).slice(0, 80))
    }
    for (const body of [{ to: scott.seat, handle: HANDLE, status: 'held', ref: REF }, { to: scott.seat, handle: HANDLE, status: 'held', id: 'x' }, { handle: HANDLE, status: 'held', id: ID }]) {
      assert.equal((await fromHost(body)).status, 400, JSON.stringify(body).slice(0, 80))
    }
    await wait(150)
    for (const s of [alexStream, rileyStream]) assert.deepEqual(s.peers(), [], 'nobody else hears it')
    assert.equal(hostStream.peers().length, 3, 'the host hears only what guests send')
    // Not stored: not in history, not in what a later joiner gets.
    const events = await ok(`${base}/events?after=0&wait=0`, alex.token)
    for (const words of ['Here are the traces.', 'Can you check the build?', REF]) {
      assert(!JSON.stringify(events).includes(words), 'not in the room\'s events')
      for (const s of [scottStream, alexStream, hostStream]) assert(!s.lines.some(l => JSON.stringify(l.events ?? []).includes(words)), 'never on a page of events')
    }
    later = await ok(`${base}/join`, null, 'POST', { name: 'Kim' })
    assert(!JSON.stringify(later).includes('Here are the traces.') && !JSON.stringify(later).includes('Can you check'), 'not in a joiner\'s history')
  })

  test("offline, a seat not the room's, and a seat that left", async () => {

    // A side with no stream open, a seat not the room's, one gone.
    const reply = { handle: HANDLE, body: 'x', ref: REF }
    assert.deepEqual(await (await fromHost({ to: later.seat, ...reply })).json(), { delivered: false, reason: 'offline' })
    assert.equal((await fromHost({ to: 'nosuchseat', ...reply })).status, 403, 'not a seat of the room')
    assert.equal((await fromHost({ to: 'host', ...reply })).status, 403)
    await ok(`${base}/leave`, alex.token, 'POST', {})
    assert.equal((await fromHost({ to: alex.seat, ...reply })).status, 403, 'a seat that left hears nothing, its stream still open')
    await wait(100)
    assert.deepEqual(alexStream.peers(), [])
    await hostStream.close()
    // The Worker that held the host's stream hears of its close, then tells
    // the room: a moment, not at once.
    let offline: any
    for (const end = Date.now() + 15_000; Date.now() < end; await wait(100)) if ((offline = await (await fromGuest(scott, up)).json<any>()).delivered === false) break
    assert.deepEqual(offline, { delivered: false, reason: 'offline' }, 'the host not connected')
  })

  test('401, 404 and 400 for each malformed body; 32,000 characters go', async () => {

    // Who may, and what's well formed.
    assert.equal((await http(`${base}/peer`, '', 'POST', up)).status, 401)
    assert.equal((await http(`/api/rooms/${token(16)}/peer`, room.token, 'POST', { to: scott.seat, ...up })).status, 404)
    good = { to: scott.seat, handle: HANDLE, body: 'x', ref: REF }
    for (const body of ['{', '[]', { to: scott.seat, handle: HANDLE, ref: REF }, { ...good, more: 1 }, { ...good, handle: 'nothex'.repeat(6) },
      { ...good, body: '' }, { ...good, body: 'x'.repeat(32_001) }, { ...good, ref: undefined }, { ...good, ref: 'r1' }, { ...good, name: 'n' },
      { ...good, chain: CHAIN }, { ...good, mode: 'prompting' }, { ...good, note: true }, { ...good, to: 7 }]) {
      assert.equal((await fromHost(body)).status, 400, JSON.stringify(body).slice(0, 80))
    }
    const guestGood = { handle: HANDLE, name: 'work-8d', id: ID, pid: 'p1', body: 'x' }
    for (const body of [{ ...guestGood, name: '' }, { ...guestGood, name: 'n'.repeat(81) }, { ...guestGood, name: 'a\nb' }, { ...guestGood, mode: 'Bypass' }, { ...guestGood, mode: 'x'.repeat(33) },
      { ...guestGood, chain: 'ab' }, { ...guestGood, chain: ['ab'] }, { ...guestGood, chain: Array(33).fill(CHAIN[0]) }, { ...guestGood, id: undefined }, { ...guestGood, id: 'A'.repeat(36) },
      { ...guestGood, pid: '' }, { ...guestGood, pid: 'a b' }, { ...guestGood, pid: 'p'.repeat(65) }]) {
      assert.equal((await fromGuest(scott, body)).status, 400, JSON.stringify(body).slice(0, 80))
    }
    // 413 past the bound is checked on the Worker below: wrangler dev's proxy
    // loses a request whose answer comes before its body is read.
    assert.equal((await fromHost({ ...good, body: 'x'.repeat(32_000) })).status, 200, 'a message of 32,000 characters goes')
    assert.equal((await fromGuest(scott, { ...guestGood, body: 'x'.repeat(32_000), chain: Array(32).fill(CHAIN[0]) })).status, 200, 'and a chain of 32 with it')
  })

  test('429 past 60 a minute a seat and 120 the host, 410 once the room ends', async () => {

    // The minute's allowance, counted before the body: refused ones count.
    // Each guest seat its own, apart from the host's.
    const statuses = []
    for (let i = 0; i <= PEER_LIMIT.seat; i++) statuses.push((await fromGuest(riley, { ...up, body: `n${i}` })).status)
    assert(statuses.includes(429), 'past a seat\'s minute, 429')
    assert.equal((await fromGuest(riley, up)).status, 429)
    assert.notEqual((await fromGuest(scott, up)).status, 429, 'another seat\'s minute is its own')
    const hostStatuses = []
    for (let i = 0; i < PEER_LIMIT.host; i++) hostStatuses.push((await fromHost({ ...good, body: `n${i}` })).status)
    assert(hostStatuses.includes(429), 'past the host\'s minute, 429')
    await ok(`${base}/end`, room.token, 'POST', {})
    assert.equal((await fromGuest(scott, up)).status, 410, 'an ended room')
  })
})

// The Worker: the room in a Durable Object, each stream a hibernatable
// socket tagged with its seat, its attachment saying whether it takes
// messages between sessions. The stubs are test/support/durable.ts's.
describe('on the Worker', () => {
  let restore = () => {}
  beforeAll(() => { restore = installRuntime() })
  afterAll(() => restore())
  test("messages and receipts go both ways by the seat's tag and its attachment, through a reconstruction; never to others, to storage or to a closing stream", async () => {
    const state = new State()
    const env = {} as ServerEnv
    const w = { state, obj: new RoomObject(asState(state), env), id: token(16) }
    await state.barrier
    const req = (path: string, bearer: string | null, method = 'GET', body?: unknown, upgrade = false) => new Request(`https://room.internal/${w.id}/${path}`, { method, headers: {
      'x-shared-session-version': PLUGIN_LATEST, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(upgrade ? { upgrade: 'websocket' } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const api = async (...args: Parameters<typeof req>): Promise<any> => { const r = await w.obj.fetch(req(...args)); assert.equal(r.status, 200, await r.clone().text()); return r.json() }
    const created = await api('create', null, 'POST', { name: 'Host' })
    assert.equal(created.peer, undefined)
    const host = created.token
    const scott = await api('join', null, 'POST', { name: 'Scott' })
    const riley = await api('join', null, 'POST', { name: 'Riley' })
    const socket = async (bearer: string, query: string) => {
      const r = await w.obj.fetch(req(`socket?after=0${query}`, bearer, 'GET', undefined, true))
      assert.equal(r.status, 101)
      return state.sockets.at(-1)!
    }
    const hostWs = await socket(host, '')
    const scottWs = await socket(scott.token, '')
    const rileyWs = await socket(riley.token, '')
    for (const ws of [hostWs, scottWs, rileyWs]) assert.deepEqual(Object.keys(ws.deserializeAttachment()).sort(), ['after', 'at', 'role', 'seat'], 'a stream keeps nothing of what it takes')
    const peersOf = (ws: Socket) => ws.sent.filter((x): x is string => typeof x === 'string').map(x => JSON.parse(x)).filter(m => m.peer).map(m => m.peer)
    const fromHost = async (body: unknown) => (await w.obj.fetch(req('peer', host, 'POST', body))).json()
    const fromGuest = async (who: { token: string }, body: unknown) => (await w.obj.fetch(req('peer', who.token, 'POST', body))).json()
    const up = (body: string) => ({ handle: HANDLE, name: 'composition', id: ID, pid: 'p1', body })
    assert.deepEqual(await fromGuest(scott, up('Up.')), { delivered: true })
    assert.deepEqual(peersOf(hostWs), [{ seat: scott.seat, who: 'Scott', handle: HANDLE, name: 'composition', chain: [], id: ID, pid: 'p1', body: 'Up.' }])
    assert.deepEqual(await fromHost({ to: scott.seat, handle: HANDLE, body: 'Here.', ref: REF }), { delivered: true })
    assert.deepEqual(peersOf(scottWs), [{ handle: HANDLE, body: 'Here.', ref: REF }])
    assert.deepEqual(await fromGuest(scott, { handle: HANDLE, status: 'expired', ref: REF }), { delivered: true })
    assert.deepEqual(peersOf(hostWs).at(-1), { seat: scott.seat, handle: HANDLE, status: 'expired', ref: REF })
    assert.deepEqual(await fromHost({ to: scott.seat, handle: HANDLE, status: 'refused', id: ID }), { delivered: true })
    assert.deepEqual(peersOf(scottWs).at(-1), { handle: HANDLE, status: 'refused', id: ID })
    assert.deepEqual(peersOf(rileyWs), [])
    assert.deepEqual(await fromHost({ to: riley.seat, handle: HANDLE, body: 'riley', ref: REF }), { delivered: true })
    assert.deepEqual(peersOf(rileyWs), [{ handle: HANDLE, body: 'riley', ref: REF }], "a seat's own streams alone")
    assert(!JSON.stringify([...state.storage.data.values()]).includes('Here.') && !JSON.stringify([...state.storage.data.values()]).includes('Up.'), 'never in storage')
    // Woken from hibernation: the sockets outlive the object, and so does what
    // their attachments say.
    w.obj = new RoomObject(asState(state), env)
    await state.barrier
    assert.deepEqual(await fromHost({ to: scott.seat, handle: HANDLE, body: 'After a sleep.', ref: REF }), { delivered: true })
    assert.deepEqual(peersOf(scottWs).filter(m => m.body).map(m => m.body), ['Here.', 'After a sleep.'])
    assert.deepEqual(await fromGuest(scott, up('Up again.')), { delivered: true })
    assert.deepEqual(peersOf(hostWs).filter(m => m.body).map(m => m.body), ['Up.', 'Up again.'])
    assert.equal(peersOf(rileyWs).length, 1, 'nothing more to another seat')
    // Past 128 KiB of body (each character escaped in six bytes), refused before the rest is read.
    assert.equal((await w.obj.fetch(req('peer', host, 'POST', { to: scott.seat, handle: HANDLE, body: '\u0001'.repeat(25_000), ref: REF }))).status, 413, 'past 128 KiB of body')
    // A stream closing (still listed while its close is handled) hears nothing.
    await w.obj.webSocketClose(asSocket(scottWs), 1000, 'gone')
    assert.deepEqual(await fromHost({ to: scott.seat, handle: HANDLE, body: 'x', ref: REF }), { delivered: false, reason: 'offline' })
    await w.obj.webSocketClose(asSocket(hostWs), 1000, 'gone')
    assert.deepEqual(await fromGuest(riley, up('x')), { delivered: false, reason: 'offline' })
  })
})
