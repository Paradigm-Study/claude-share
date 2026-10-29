// The public link, Stops told again, dependencies' Open preview, and the
// window's launch check and refusals.

import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { profileName } from '../hooks/window'
import {
  LINK,
  band,
  world,
  eventually,
  PREVIEW_PEOPLE,
  LOCAL_SHOWN,
  savedRoom,
  START,
  checkpointPath,
  savedAt,
  STEP,
  CHROME,
  WINDOW_SHOWN,
  WINDOW_URL,
  roomProfile,
  windowWorld,
  roomPane,
  routesOf,
  forwardedPids,
  tunnels,
  tunnelUnstarted,
  refuseForGood,
  openedInWindow,
  SIGNED_IN,
  hostProfilePath,
  LOOK_UNKNOWN,
  FIREFOX,
  firefoxWorld,
  DEP_SHOWN,
  PAGE_B,
  DISCOVERED,
  NEEDS,
  needLine,
  HOST_ONLY,
  LINKED,
  sharingLink,
  allowShow,
  deliver,
  stopInRoom,
  proxyAsk,
  proxyAnswers,
  proxyPages,
  HOST_FROM,
  within,
  removedProfiles,
} from './support/world'

test("a HEAD through the public link is curl's own head: no body is waited for or sent, and the answer has none", async ($, on) => {
  const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/')
  await deliver(asked, stream, [proxyAsk(1, { method: 'HEAD', path: '/health', body: btoa('x=1') })], () => proxyAnswers(asked).length)
  const head = asked.proxyFetches[0]!.input.split('\n')
  expect(head).toContain('url = "http://localhost:3340/health"')
  // Asked as a method of its own, curl waits out its 25 s for the body the length says.
  expect(head).toContain('head')
  expect(head.some(l => l.startsWith('request = '))).toBe(false)
  expect(head).toContain(`printf '%s' '' | base64 --decode > "$d/body" 2>/dev/null || : > "$d/body"`)
  // What curl wrote where the body goes (the head again) is emptied, once the fetch went through.
  const emptied = head.indexOf(': > "$d/b"')
  expect(emptied).toBeGreaterThan(head.indexOf('if [ $e -ne 0 ]; then rm -rf "$d"; echo "exit=$e"; exit 0; fi'))
  expect(emptied).toBeLessThan(head.findIndex(l => l.startsWith("printf 'exit=0")))
  // Any other method goes as itself, its body as fetched.
  await deliver(asked, stream, [proxyAsk(2, { method: 'GET' })], () => proxyAnswers(asked).length === 2)
  const get = asked.proxyFetches[1]!.input.split('\n')
  expect(get).toContain('request = "GET"')
  expect(get).not.toContain('head')
  expect(get).not.toContain(': > "$d/b"')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a public socket or request asked for while a Stop is taken in starts nothing: no relay, no fetch, and the request hears the preview ended', async ($, on) => {
  let armed = false,
    holding = false
  let release!: () => void
  const held = new Promise<void>(done => {
    release = done
  })
  // The Stop's removal of the share, held: its relays and fetches are closed, the share not gone yet.
  const beforeSet = async (key: string, value: unknown) => {
    if (armed && key === 'shares' && value && typeof value === 'object' && !('3340' in value)) {
      holding = true
      await held
    }
  }
  const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/', { wsRelays: true, beforeSet })
  armed = true
  await stopInRoom($, asked, stream)
  await eventually(asked.clock, () => holding)
  await deliver(
    asked,
    stream,
    [
      { ws: { id: 'socket00000009', pid: 'pv1', port: 3340, path: '/', protocols: [] } },
      proxyAsk(1, { method: 'POST', path: '/api/delete-all', body: btoa('x=1') }),
    ],
    () => proxyPages(asked).length,
  )
  await asked.clock.advance(100)
  expect(asked.wsRelays).toHaveLength(0)
  expect(asked.proxyFetches).toHaveLength(0)
  expect(proxyPages(asked)[0]!.input).toContain('\\"status\\":404')
  release()
  await eventually(asked.clock, () => asked.sent.some(x => x.path.endsWith('/previews/pv1/end')))
  await asked.clock.advance(100)
  expect(asked.state.shares?.['3340']).toBeUndefined()
  expect(asked.wsRelays).toHaveLength(0)
  expect(asked.proxyFetches).toHaveLength(0)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test(
  "a Stop the room didn't hear keeps its Stop in the Room and is told again as the stream connects; its link's requests hear at once that it ended",
  { timeoutMs: 20_000 },
  async ($, on) => {
    const endFail = { count: 1 }
    const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/', { endFail })
    const pane = await stopInRoom($, asked, stream)
    await asked.clock.advance(100)
    const ends = () => asked.sent.filter(x => x.path.endsWith('/previews/pv1/end'))
    expect(ends()).toHaveLength(1)
    expect(asked.toasted.at(-1)).toBe(
      "Stopped sharing localhost:3340. The server couldn't be told yet, so guests may still see it listed, but nothing reaches it. The server is told again when this session reconnects, or when you press Stop again.",
    )
    expect(asked.state.shares?.['3340']).toBeUndefined()
    // Not ended in Shown before the room heard it: its Stop is still there.
    expect(asked.state.shown?.find(s => s.pid === 'pv1')?.closed).toBeUndefined()
    expect(await pane.find({ key: 'stop-preview:pv1' })).toBeDefined()
    // The room still sends its link's requests here: each hears it ended, at once, and nothing is fetched.
    await deliver(asked, stream, [proxyAsk(7)], () => proxyPages(asked).length)
    expect(asked.proxyFetches).toHaveLength(0)
    expect(proxyPages(asked)[0]!.input).toContain('\\"status\\":404')
    expect(proxyPages(asked)[0]!.input).toContain('This preview has ended')
    expect(proxyPages(asked)[0]!.input).toContain('scott is no longer sharing it.')
    // Connected again, past its wait: told again, heard, and ended in Shown; never told after.
    await within(asked.clock, () => ends().length === 2, 60_000)
    await eventually(asked.clock, () => asked.state.shown?.find(s => s.pid === 'pv1')?.closed)
    expect(ends()).toHaveLength(2)
    expect(await pane.find({ key: 'stop-preview:pv1' })).toBeUndefined()
    await asked.clock.advance(10 * 60_000)
    expect(ends()).toHaveLength(2)
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  },
)

// A second preview the host shares through its link, as the room's stream says it.
const LINKED_API = {
  seq: 3,
  events: [
    {
      seq: 3,
      type: 'artifact',
      ts: 901,
      from: { seat: 'host', name: 'scott', role: 'host' },
      body: { kind: 'preview', pid: 'pv2', port: 3341, path: '/', title: 'localhost:3341', host: '127.0.0.1' },
    },
  ],
  people: HOST_ONLY,
  ended: false,
  title: 'demo',
}

test("Stops told again each look at what's shared as they go: one shared again while another was told stands", async ($, on) => {
  // Both Stops unheard; then the first told again waits on the room.
  const endFail = { count: 2 },
    ended: string[] = []
  let release = () => {}
  const held = new Promise<void>(done => (release = done))
  const beforeEnd = async (pid: string) => {
    ended.push(pid)
    if (ended.length === 3) await held
  }
  const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/', { endFail, beforeEnd })
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'And the API at http://localhost:3341/' }] },
    door: 'response',
    origin: { kind: 'composer' },
    uuid: 'a2',
  } as never)
  await eventually(asked.clock, () => asked.state.shares?.['3341']?.pid === 'pv2')
  const pane = await stopInRoom($, asked, stream)
  await deliver(asked, stream, [LINKED_API], () => asked.state.shown?.some(s => s.pid === 'pv2'))
  await pane.press({ key: 'stop-preview:pv2' })
  await asked.clock.advance(50)
  expect(ended).toEqual(['pv1', 'pv2'])
  expect(asked.state.shares?.['3340']).toBeUndefined()
  expect(asked.state.shares?.['3341']).toBeUndefined()
  // Connected again: the first told again waits on the room.
  await within(asked.clock, () => ended.length === 3, 60_000)
  const first = ended[2]!,
    other = first === 'pv1' ? { pid: 'pv2', port: 3341 } : { pid: 'pv1', port: 3340 }
  // Meanwhile the host shares the other's port again: the room gives it the same preview back.
  await $.command.run({ command: 'share-preview', args: `${other.port} Again` } as never)
  await eventually(asked.clock, () => asked.state.shares?.[String(other.port)]?.pid === other.pid)
  release()
  await eventually(asked.clock, () => asked.state.shown?.find(s => s.pid === first)?.closed)
  await asked.clock.advance(100)
  // Only the first is told again: the one shared again stands.
  expect(ended).toEqual(['pv1', 'pv2', first])
  expect(asked.state.shares?.[String(other.port)]?.pid).toBe(other.pid)
  expect(asked.state.shown?.find(s => s.pid === other.pid)?.closed).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a share of a port waits for the room to hear its Stop told again, so it never takes back the preview the room then ends', async ($, on) => {
  const endFail = { count: 1 },
    ended: string[] = []
  let release = () => {}
  const held = new Promise<void>(done => (release = done))
  const beforeEnd = async (pid: string) => {
    ended.push(pid)
    if (ended.length === 2) await held
  }
  const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/', { endFail, beforeEnd })
  await stopInRoom($, asked, stream)
  // Connected again: the Stop is told again, and the room takes its time.
  await within(asked.clock, () => ended.length === 2, 60_000)
  const posts = () => asked.sent.filter(x => x.path.endsWith('/previews')).length
  const before = posts()
  const sharing = $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await asked.clock.advance(1_000)
  expect(posts()).toBe(before)
  // Heard: the room is asked for the share's preview only now.
  release()
  await within(asked.clock, () => posts() > before, 5_000)
  await sharing
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).at(-1)?.body).toEqual({ port: 3340, title: 'App', tcp: true })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a share of a port whose Stop the room is still being told after five seconds isn't made, so that Stop can't end it", async ($, on) => {
  const endFail = { count: 1 },
    ended: string[] = []
  let release = () => {}
  const held = new Promise<void>(done => (release = done))
  const beforeEnd = async (pid: string) => {
    ended.push(pid)
    if (ended.length === 2) await held
  }
  const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/', { endFail, beforeEnd })
  await stopInRoom($, asked, stream)
  // Connected again: the Stop is told again, and the room doesn't answer.
  await within(asked.clock, () => ended.length === 2, 60_000)
  const posts = () => asked.sent.filter(x => x.path.endsWith('/previews')).length
  const before = posts()
  const sharing = $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await asked.clock.advance(6_000)
  // Past its wait, nothing is asked of the room: what it answered would be the preview that Stop then ends.
  expect(JSON.stringify(await sharing)).toContain("Couldn't share localhost:3340.")
  expect(posts()).toBe(before)
  expect(asked.logged.some(l => l.includes("Couldn't share localhost:3340 yet: the room is still being told it stopped. Try again in a moment."))).toBe(true)
  // Heard at last: shared again, the room asked only now.
  release()
  await eventually(asked.clock, () => asked.state.shown?.find(s => s.pid === 'pv1')?.closed)
  const again = $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await within(asked.clock, () => posts() > before, 5_000)
  await again
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).at(-1)?.body).toEqual({ port: 3340, title: 'App', tcp: true })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("polling (no curl here), a Stop the room didn't hear is told again as a poll goes through", async ($, on) => {
  const endFail = { count: 1 }
  // No stream: curl can't start, so the room is polled.
  const asked = world(on, { endFail, people: HOST_ONLY, polled: [LINKED()] })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await within(asked.clock, () => asked.state.shown?.some(s => s.pid === 'pv1'), 5_000)
  expect(asked.filter(a => a === 'GET /api/rooms/room0000000000000002/events').length).toBeGreaterThan(0)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'stop-preview:pv1' })
  const ends = () => asked.sent.filter(x => x.path.endsWith('/previews/pv1/end'))
  await eventually(asked.clock, () => ends().length === 1)
  await asked.clock.advance(100)
  expect(asked.state.shown?.find(s => s.pid === 'pv1')?.closed).toBeUndefined()
  await within(asked.clock, () => ends().length === 2, 60_000)
  await eventually(asked.clock, () => asked.state.shown?.find(s => s.pid === 'pv1')?.closed)
  expect(ends()).toHaveLength(2)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a Stop the room heard though its answer never came back isn't told again once the room says the preview closed", async ($, on) => {
  const endFail = { count: 1 }
  const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/', { endFail })
  await stopInRoom($, asked, stream)
  await asked.clock.advance(100)
  const closed = {
    seq: 3,
    events: [{ seq: 3, type: 'preview', ts: 950, from: { seat: 'host', name: 'scott', role: 'host' }, body: { pid: 'pv1', port: 3340, state: 'closed' } }],
    people: HOST_ONLY,
    ended: false,
    title: 'demo',
  }
  await deliver(asked, stream, [closed], () => asked.state.shown?.find(s => s.pid === 'pv1')?.closed)
  await asked.clock.advance(60_000)
  expect(asked.sent.filter(x => x.path.endsWith('/previews/pv1/end'))).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// What Claude showed after a preview: files the room hands back, by count.
const filesShown = (n: number, from = 'scott') =>
  Array.from({ length: n }, (_, i) => ({
    seq: 3 + i,
    type: 'artifact',
    ts: 901 + i,
    from: { seat: 'host', name: from, role: 'host' },
    body: {
      kind: 'send',
      files: [{ id: `${'f'.repeat(60)}${String(i).padStart(4, '0')}`, name: `notes${i}.md`, type: 'text/markdown', size: 10 }],
      display: 'render',
      caption: '',
    },
  }))

test("however much Claude shows after a preview, the host's Shown keeps drawing it with its Stop, and the newest 12 of the rest", async ($, on) => {
  const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/')
  await deliver(
    asked,
    stream,
    [LINKED(), { seq: 15, events: filesShown(13), people: HOST_ONLY, ended: false, title: 'demo' }],
    () => (asked.state.shown ?? []).length >= 14,
  )
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  expect(await pane.find({ key: 'stop-preview:pv1' })).toBeDefined()
  expect(await pane.find({ key: 'forward-preview:pv1' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'notes0.md' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'notes1.md' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'notes12.md' })).toBeDefined()
  await pane.press({ key: 'stop-preview:pv1' })
  await eventually(asked.clock, () => asked.sent.some(x => x.path.endsWith('/previews/pv1/end')))
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("however much the host's Claude shows after a forwarded preview, a guest's Shown keeps its Open and Public link", async ($, on) => {
  const asked = world(on, { stream: [{ seq: 14, events: [LOCAL_SHOWN, ...filesShown(12, 'Sam')], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }] })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  await eventually(asked.clock, () => (asked.state.shown ?? []).length >= 13)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  expect(await pane.find({ key: 'open-preview:pv-local' })).toBeDefined()
  expect(await pane.find({ key: 'public-preview:pv-local' })).toBeDefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a preview shared again while its Stop went unheard stays shared: the room isn't told again that it ended", async ($, on) => {
  const endFail = { count: 1 }
  const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/', { endFail })
  await stopInRoom($, asked, stream)
  await asked.clock.advance(100)
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await asked.clock.advance(60_000)
  expect(asked.sent.filter(x => x.path.endsWith('/previews/pv1/end'))).toHaveLength(1)
  expect(asked.state.shares?.['3340']).toMatchObject({ pid: 'pv1', tcp: true })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("an answer's head goes first in its body; past 20 MB, too slow or nothing there, a page says so in the same form", async ($, on) => {
  const said: NonNullable<NonNullable<Parameters<typeof world>[1]>['proxyFetch']> = {}
  const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/', { proxyFetch: said })
  await deliver(asked, stream, [proxyAsk(1)], () => proxyAnswers(asked).length)
  const answer = proxyAnswers(asked)[0]!.input!.split('\n')
  expect(answer).toContain('{"status":200,"headers":[["content-type","text/html"]]}')
  expect(answer.some(l => l.includes('x-proxy-'))).toBe(false)
  expect(asked.proxyFetches[0]!.input.split('\n')).toContain('url = "http://localhost:3340/"')
  expect(asked.proxyFetches[0]!.input.split('\n')).not.toContain('insecure')
  for (const [n, exit, status, words] of [
    [2, 63, 502, 'over 20 MB'],
    [3, 28, 504, 'took too long'],
    [4, 7, 502, "Nothing answered on scott's localhost:3340."],
  ] as const) {
    said.exit = exit
    await deliver(asked, stream, [proxyAsk(n)], () => proxyPages(asked).length === n - 1)
    const page = proxyPages(asked).at(-1)!.input!
    expect(page).toContain(`/proxy/proxyask0000000${n}"`)
    expect(page).not.toContain('x-proxy-')
    expect(page).toContain(`data-binary = "{\\"status\\":${status},\\"headers\\":[[\\"content-type\\",\\"text/html; charset=utf-8\\"]]}\\n<!doctype html>`)
    expect(page).toContain(words)
  }
  // Nothing else went back for them.
  expect(proxyAnswers(asked)).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('the public link fetches 16 at once and holds 256 more, past that a busy page; Stop ends its fetches and drops what waits', async ($, on) => {
  let release!: () => void
  const hold = new Promise<void>(done => {
    release = done
  })
  const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/', { proxyFetch: { hold } })
  await deliver(
    asked,
    stream,
    Array.from({ length: 300 }, (_, i) => proxyAsk(i)),
    () => asked.proxyFetches.length >= 16 && proxyPages(asked).length,
  )
  await asked.clock.advance(100)
  expect(asked.proxyFetches).toHaveLength(16)
  const busy = proxyPages(asked)
  expect(busy.length > 0).toBe(true)
  expect(busy.every(p => p.input!.includes('\\"status\\":503'))).toBe(true)
  await stopInRoom($, asked, stream)
  await eventually(asked.clock, () => asked.proxyFetches.every(f => f.stopped))
  release()
  await asked.clock.advance(1_000)
  // Every fetch ended at once, nothing went back for one, none waiting started, and their folders went.
  expect(asked.proxyFetches).toHaveLength(16)
  expect(asked.proxyFetches.every(f => f.stopped)).toBe(true)
  expect(proxyAnswers(asked)).toHaveLength(0)
  expect(asked.spawned.filter(s => s.argv[0] === '/bin/sh' && s.input?.startsWith("rm -rf -- '/tmp/cs-proxy.Fetch"))).toHaveLength(16)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("past the room's own 30 s, an ask is neither fetched nor answered: its browser has the room's page already", async ($, on) => {
  let release!: () => void
  const hold = new Promise<void>(done => {
    release = done
  })
  const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/', { proxyFetch: { hold } })
  await deliver(
    asked,
    stream,
    Array.from({ length: 17 }, (_, i) => proxyAsk(i)),
    () => asked.proxyFetches.length >= 16,
  )
  await asked.clock.advance(31_000)
  release()
  const discarded = () => asked.spawned.filter(s => s.argv[0] === '/bin/sh' && s.input?.startsWith("rm -rf -- '/tmp/cs-proxy.Fetch"))
  await eventually(asked.clock, () => discarded().length === 16)
  await asked.clock.advance(1_000)
  // The 16 fetched go nowhere; the one still waiting never starts.
  expect(asked.proxyFetches).toHaveLength(16)
  expect(proxyAnswers(asked)).toHaveLength(0)
  expect(proxyPages(asked)).toHaveLength(0)
  expect(discarded()).toHaveLength(16)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("public sockets: 32 relays at most, the rest refused busy; an https preview's relay speaks TLS to localhost; Stop closes them", async ($, on) => {
  const { asked, stream } = await sharingLink($, on, 'https://localhost:3340/app', { wsRelays: true })
  const sockets = Array.from({ length: 33 }, (_, i) => ({
    ws: { id: `socket${String(i).padStart(8, '0')}`, pid: 'pv1', port: 3340, path: '/_next/webpack-hmr?id=1', protocols: [] },
  }))
  const refusals = () => asked.spawned.filter(s => s.argv[0] === 'curl' && s.input?.includes('/reject"'))
  await deliver(asked, stream, sockets, () => asked.wsRelays.length >= 32 && refusals().length)
  await asked.clock.advance(100)
  expect(asked.wsRelays).toHaveLength(32)
  expect(asked.wsRelays[0]!.config).toEqual({
    local: 'wss://localhost:3340/_next/webpack-hmr?id=1',
    insecureLocal: true,
    origin: 'https://localhost:3340',
    protocols: [],
    room: 'ws://localhost:8787/api/rooms/room0000000000000002/ws/socket00000000',
    token: 't',
    version: '0.7.1',
  })
  expect(refusals()).toHaveLength(1)
  expect(refusals()[0]!.input).toContain('data = "{\\"code\\":\\"BUSY\\"}"')
  await stopInRoom($, asked, stream)
  await eventually(asked.clock, () => asked.wsRelays.every(r => r.stopped))
  expect(asked.wsRelays.every(r => r.stopped)).toBe(true)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a public socket with no Node to relay it is refused at once, and Stop sharing closes the relays still up', async ($, on) => {
  const opts: NonNullable<Parameters<typeof world>[1]> = { wsRelays: 'missing' }
  const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/', opts)
  const refusals = () => asked.spawned.filter(s => s.argv[0] === 'curl' && s.input?.includes('/reject"'))
  await deliver(asked, stream, [{ ws: { id: 'socket00000001', pid: 'pv1', port: 3340, path: '/', protocols: [] } }], () => refusals().length)
  expect(refusals()[0]!.input).toContain('/ws/socket00000001/reject"')
  expect(refusals()[0]!.input).toContain('data = "{\\"code\\":\\"CONNECT\\"}"')
  opts.wsRelays = true
  await deliver(asked, stream, [{ ws: { id: 'socket00000002', pid: 'pv1', port: 3340, path: '/', protocols: ['vite-hmr'] } }], () => asked.wsRelays.length)
  expect(asked.wsRelays[0]!.config).toMatchObject({ local: 'ws://localhost:3340/', origin: 'http://localhost:3340', protocols: ['vite-hmr'] })
  expect(asked.wsRelays[0]!.config.insecureLocal).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  await eventually(asked.clock, () => asked.wsRelays[0]!.stopped)
  expect(asked.wsRelays[0]!.stopped).toBe(true)
})

for (const failed of ['connect', 'invalid'] as const) {
  test(`a public socket whose relay fails (${failed === 'connect' ? 'its dev server never took the socket' : 'settings it refused'}, exit 1) is refused at once: CONNECT`, async ($, on) => {
    const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/', { wsRelays: failed })
    const refusals = () => asked.spawned.filter(s => s.argv[0] === 'curl' && s.input?.includes('/reject"'))
    await deliver(asked, stream, [{ ws: { id: 'socket00000001', pid: 'pv1', port: 3340, path: '/', protocols: [] } }], () => refusals().length)
    expect(asked.wsRelays.length).toBeGreaterThan(0)
    expect(refusals()[0]!.input).toContain('/ws/socket00000001/reject"')
    expect(refusals()[0]!.input).toContain('data = "{\\"code\\":\\"CONNECT\\"}"')
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test("a public socket's relay that came and went (exit 0), or one a Stop ended, is refused nothing", async ($, on) => {
  const opts: NonNullable<Parameters<typeof world>[1]> = { wsRelays: 'ended' }
  const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/', opts)
  const refusals = () => asked.spawned.filter(s => s.argv[0] === 'curl' && s.input?.includes('/reject"'))
  await deliver(asked, stream, [{ ws: { id: 'socket00000001', pid: 'pv1', port: 3340, path: '/', protocols: [] } }], () => asked.wsRelays.length)
  await asked.clock.advance(100)
  opts.wsRelays = true
  const up = () => asked.wsRelays.find(r => r.config.room === 'ws://localhost:8787/api/rooms/room0000000000000002/ws/socket00000002')
  await deliver(asked, stream, [{ ws: { id: 'socket00000002', pid: 'pv1', port: 3340, path: '/', protocols: [] } }], up)
  await stopInRoom($, asked, stream)
  await eventually(asked.clock, () => up()!.stopped)
  await asked.clock.advance(100)
  expect(up()!.stopped).toBe(true)
  expect(refusals()).toHaveLength(0)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('an ask from the room whose answer fails is logged for debugging, and the next is answered', async ($, on) => {
  // A read that fails: the store answers nothing a read can use.
  let failing = false
  on('state.get', async ($, e, next) => (failing && e.plugin === 'shared-session' && e.key === 'shares' ? ({ value: null } as never) : next(e)))
  const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/', { wsRelays: true })
  failing = true
  const said = () => asked.logged.filter(l => l.startsWith("Shared session: the room's ws: "))
  await deliver(asked, stream, [{ ws: { id: 'socket00000001', pid: 'pv1', port: 3340, path: '/', protocols: [] } }], () => said().length)
  expect(said()).toHaveLength(1)
  expect(asked.wsRelays).toHaveLength(0)
  failing = false
  await deliver(asked, stream, [{ ws: { id: 'socket00000002', pid: 'pv1', port: 3340, path: '/', protocols: [] } }], () => asked.wsRelays.length)
  expect(asked.wsRelays[0]!.config).toMatchObject({
    local: 'ws://localhost:3340/',
    room: 'ws://localhost:8787/api/rooms/room0000000000000002/ws/socket00000002',
  })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

const APP_SHOWN = {
  seq: 2,
  type: 'artifact',
  ts: 900,
  from: HOST_FROM,
  body: { kind: 'preview', pid: 'pv-app', port: 61198, path: '/', title: 'Host app', tcp: true },
}

const API_SHOWN = {
  seq: 3,
  type: 'artifact',
  ts: 901,
  from: HOST_FROM,
  body: { kind: 'preview', pid: 'pv-api', port: 61199, path: '/', title: 'localhost:61199 (host-api.cjs)', tcp: true, host: 'localhost', dependency: 61198 },
}

// The same two as a plugin before dependencies shares them: no field.
const API_OLD = { ...API_SHOWN, body: { kind: 'preview', pid: 'pv-api', port: 61199, path: '/', title: 'host-api.cjs (localhost:61199)', tcp: true } }

// Previews: Always a separate window: these are about what the window reaches.
const dependencyWorld = (on: On, events: unknown[], opts: Parameters<typeof world>[1] = {}) =>
  world(on, {
    browser: { platform: 'Darwin', path: CHROME },
    localPreviewByPid: { 'pv-app': { port: 45020 }, 'pv-api': { port: 45021 } },
    stream: [{ seq: 3, events, people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
    ...opts,
    store: { previewOpen: 'window', ...opts.store },
  })

test('Open preview opens the app, never its newer dependency, and the window still reaches the dependency', async ($, on) => {
  const asked = dependencyWorld(on, [APP_SHOWN, API_SHOWN])
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(10)
  expect(asked.launches[0]!.at(-1)).toBe('http://localhost:61198/')
  // The dependency follows the host's authority as any forwarded port does.
  expect(routesOf(asked)).toEqual({ routes: { '61198': 45020 }, startable: [61199] })
  asked.proxies[0]!.send({ state: 'want', port: 61199 })
  await eventually(asked.clock, () => routesOf(asked)?.routes['61199'] === 45021)
  expect(routesOf(asked)).toEqual({ routes: { '61198': 45020, '61199': 45021 }, startable: [] })
  // Open, the app leaves the row, and its dependency never takes its place.
  await asked.clock.advance(10)
  expect(await ui.find({ key: 'open-preview' })).toBeUndefined()
  expect(asked.launches).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('with only dependencies forwarded there is no Open preview; the Room still lists them, with Open', async ($, on) => {
  const asked = dependencyWorld(on, [API_SHOWN])
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await asked.clock.advance(10)
  expect(await ui.find({ key: 'open-preview' })).toBeUndefined()
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await asked.clock.advance(10)
  expect(await pane.find({ type: 'Text', text: 'localhost:61199 (host-api.cjs) · used by localhost:61198' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Used for the preview of localhost:61198' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /in a preview window$/ })).toBeUndefined()
  // Looked at on purpose, it opens at its own address.
  await pane.press({ key: 'open-preview:pv-api' })
  await eventually(asked.clock, () => asked.launches.length)
  expect(asked.launches[0]!.at(-1)).toBe('http://localhost:61199/')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("the host's Room says what a dependency is shared for", async ($, on) => {
  const asked = world(on, { stream: [{ seq: 3, events: [APP_SHOWN, API_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }] })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await asked.clock.advance(10)
  expect(await pane.find({ type: 'Text', text: 'Shared for the preview of localhost:61198' })).toBeDefined()
  expect(await pane.find({ key: 'stop-preview:pv-api' })).toBeDefined()
  expect(await pane.find({ key: 'stop-preview:pv-app' })).toBeDefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a dependency shared live is said as what it is, never as something to open', async ($, on) => {
  const asked = dependencyWorld(on, [APP_SHOWN, API_SHOWN])
  on('tool.list', () => ({ value: [] }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const ride = async (turnId: string, text: string) => {
    await eventually(asked.clock, () => asked.submitted.some(p => p.text === text))
    await $.turn.start({ turnId, text })
    const chunks = []
    for await (const chunk of $.turn.step({ ...STEP, turnId } as never)) chunks.push(chunk)
    await $.turn.complete({ turnId, isAborted: false, durationMs: 0, reason: 'answer' } as never)
    await asked.clock.advance(10)
    return {
      said: chunks
        .filter(c => c.kind === 'text')
        .map(c => c.text)
        .join(''),
      calls: chunks.filter(c => c.kind === 'tool').length,
    }
  }
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  await $.turn.start({ turnId: 'join', text: LINK })
  await $.turn.complete({ turnId: 'join', isAborted: false, durationMs: 0, reason: 'answer' } as never)
  await asked.clock.advance(10)
  // The app is what to open.
  const app = await ride('show-app', 'Sam shared Host app (preview)')
  expect(app.said).toContain('press **Open preview** above the prompt (or **Open** in the Room) to open it at http://localhost:61198/')
  // Its dependency is said as what it's for.
  const api = await ride('show-api', 'Sam shared localhost:61199 (host-api.cjs) · used by localhost:61198')
  expect(api.said).toContain('◧ **Sam shares** localhost:61199 (host-api.cjs) for the preview of localhost:61198; the page reaches it when you open it')
  expect(api.said).not.toContain('Open preview')
  expect(api.calls).toBe(0)
  expect(asked.launches).toHaveLength(0)
  expect(asked.localHelpers).toHaveLength(0)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

for (const [label, history, opened] of [
  ['the app, even with its dependency shown after it', [APP_SHOWN, API_SHOWN], 'Sam has Host app (preview) open'],
  ['the newest preview, as before, for previews without the field', [APP_SHOWN, API_OLD], 'Sam has host-api.cjs (localhost:61199) (preview) open'],
  ['nothing, when every preview still open is a dependency', [API_SHOWN], null],
] as const) {
  test(`a join replays as the preview to open ${label}`, async ($, on) => {
    const asked = world(on, {
      browser: { platform: 'Darwin', path: CHROME },
      joinHistory: [...history],
      stream: [{ seq: 3, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
    })
    on('tool.list', () => ({ value: [] }) as never)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))
    await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
    await asked.clock.advance(10)
    await $.turn.start({ turnId: 'join', text: LINK })
    await $.turn.complete({ turnId: 'join', isAborted: false, durationMs: 0, reason: 'answer' } as never)
    await asked.clock.advance(50)
    if (opened) await eventually(asked.clock, () => asked.submitted.some(p => p.text.startsWith('Sam has')))
    expect(asked.submitted.filter(p => p.text.startsWith('Sam has')).map(p => p.text)).toEqual(opened ? [opened] : [])
    if (opened) {
      await $.turn.start({ turnId: 'still-open', text: opened })
      const chunks = []
      for await (const chunk of $.turn.step({ ...STEP, turnId: 'still-open' } as never)) chunks.push(chunk)
      const text = chunks
        .filter(c => c.kind === 'text')
        .map(c => c.text)
        .join('')
      expect(text).toContain(`to open it at http://localhost:${history.at(-1) === API_OLD ? 61199 : 61198}/`)
      await $.turn.complete({ turnId: 'still-open', isAborted: false, durationMs: 0, reason: 'answer' } as never)
    }
    // Above the prompt, the same choice.
    const ui = await $.ui.mount(band('desktop'))
    await asked.clock.advance(10)
    expect(Boolean(await ui.find({ key: 'open-preview' }))).toBe(Boolean(opened))
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test('previews without the field open newest first, as before', async ($, on) => {
  const asked = dependencyWorld(on, [APP_SHOWN, API_OLD])
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  expect(asked.launches[0]!.at(-1)).toBe('http://localhost:61199/')
  await asked.clock.advance(10)
  // The other is next.
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length === 2)
  expect(asked.launches[1]!.at(-1)).toBe('http://localhost:61198/')
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  expect(await pane.find({ type: 'Text', text: /^Used for/ })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

const PLACE = 'local_0123abcd-0000-0000-0000-000000000001'

test("a page's request to this computer's network is refused, and said once a session with the way to allow it", async ($, on) => {
  const asked = windowWorld(on)
  await openedInWindow($, asked)
  asked.proxies[0]!.send({ state: 'lan' })
  asked.proxies[0]!.send({ state: 'lan' })
  await eventually(asked.clock, () => asked.toasted.some(t => t.includes('local network')))
  await asked.clock.advance(20)
  expect(asked.toasted.filter(t => t.includes('local network'))).toEqual([
    "The preview window refused a request to your local network (a private address). Pages from Sam can't reach your network; set SHARED_SESSION_PREVIEW_LAN=1 where Claude Code starts to allow it.",
  ])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('SHARED_SESSION_PREVIEW_LAN=1 lets the window reach this network; what it still refuses says nothing', async ($, on) => {
  const asked = windowWorld(on, { env: { SHARED_SESSION_PREVIEW_LAN: '1' } })
  await openedInWindow($, asked)
  expect(asked.proxies[0]!.config.lan).toBe(true)
  asked.proxies[0]!.send({ state: 'lan' })
  await asked.clock.advance(50)
  expect(asked.toasted.some(t => t.includes('local network'))).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a dependency the host's side refused comes back with its page's Open preview", async ($, on) => {
  const asked = dependencyWorld(on, [APP_SHOWN, API_SHOWN])
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(10)
  asked.proxies[0]!.send({ state: 'want', port: 61199 })
  await eventually(asked.clock, () => routesOf(asked)?.routes['61199'] === 45021)
  await refuseForGood(asked, 'pv-api', 61199)
  await asked.clock.advance(20)
  expect(asked.state.previewNeedsOpen).toEqual(['pv-api'])
  expect(routesOf(asked)).toEqual({ routes: { '61198': 45020 }, startable: [] })
  await asked.clock.advance(1_500)
  expect(asked.toasted).toContain(
    "Sam's side refused the preview window's connection to localhost:61199, which the preview of localhost:61198 uses. Press Open preview for that page to reconnect.",
  )
  // The page it's for is what Open preview opens again, and that Open clears it.
  expect((await ui.find({ key: 'open-preview' }))?.props.label).toBe('Open preview')
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length === 2)
  await asked.clock.advance(10)
  expect(asked.launches[1]!.at(-1)).toBe('http://localhost:61198/')
  expect(asked.state.previewNeedsOpen).toEqual([])
  expect(routesOf(asked)).toEqual({ routes: { '61198': 45020 }, startable: [61199] })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("an open preview outlives Shown's pruning of everything else: still opened, still reached, nobody asked", async ($, on) => {
  const links = Array.from({ length: 45 }, (_, i) => ({
    seq: 3 + i,
    type: 'artifact',
    ts: 901 + i,
    from: HOST_FROM,
    body: { kind: 'link', url: `https://example.test/${i}` },
  }))
  const asked = windowWorld(on, {
    joinHistory: [WINDOW_SHOWN, ...links],
    stream: [{ seq: 47, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  // The newest 40 links, and the preview older than all of them.
  await eventually(asked.clock, () => (asked.state.shown ?? []).length === 41)
  expect(asked.state.shown!.filter(s => s.kind === 'link')).toHaveLength(40)
  expect(asked.state.shown![0]).toMatchObject({ pid: 'pv-local', tcp: true, host: '127.0.0.1' })
  expect(forwardedPids(asked)).toEqual(['pv-local'])
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(10)
  expect(asked.launches[0]!.at(-1)).toBe(WINDOW_URL)
  expect(routesOf(asked)).toEqual({ routes: { '3340': 45001 }, startable: [] })
  // Its tunnel gone (it failed), it's still there to start, and nobody is asked for it.
  asked.localHelpers[0]!.send({ state: 'error', code: 'STARTUP' })
  await eventually(asked.clock, () => routesOf(asked)?.startable.includes(3340))
  asked.proxies[0]!.send({ state: 'blocked', port: 3340 })
  await asked.clock.advance(20)
  expect(asked.sent.filter(s => s.path.endsWith('/need'))).toHaveLength(0)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// The window's Open, left at each of its waits by each way out of the room
// (Leave, the room ending, a /clear, a session closing): nothing it started
// stays (no window, proxy or tunnel, nothing of it in the state), and the
// room's profile goes with a room left for good, or stays with the place a
// session closing keeps. The exit removes the profile it knows of (a /clear
// at once and again once the open is done); the open removes the one it made
// itself, so a profile made after the exit looked (the first wait) goes too.
const WINDOW_WAITS = [
  ['its profile is made', (hold: Promise<void>) => ({ beforeProfile: () => hold })],
  ['its proxy starts', (hold: Promise<void>) => ({ proxyHold: hold })],
  ['its tunnel starts', () => ({ localPreview: 'wait' as const })],
  ['the browser starts', (hold: Promise<void>) => ({ beforeLaunch: () => hold })],
] as const

for (const [step, waits] of WINDOW_WAITS) {
  for (const exit of ['leave', 'ended', 'clear', 'keep'] as const) {
    test(`an Open left while ${step}, by ${exit === 'keep' ? 'the session closing' : exit === 'ended' ? 'the room ending' : exit === 'clear' ? 'a /clear' : 'Leave'}, leaves nothing it started running`, async ($, on) => {
      let release!: () => void
      const hold = new Promise<void>(done => {
        release = done
      })
      const stream: unknown[] = [{ seq: 2, events: [WINDOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
      const asked = windowWorld(on, { stream, ...waits(hold) })
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      on('session.end', ($, e) => ({ sessionId: e.sessionId }))
      await $.session.start(START)
      await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
      await asked.clock.advance(10)
      const ui = await $.ui.mount(band('desktop'))
      await ui.press({ key: 'open-preview' })
      const reached = () =>
        step === 'its profile is made'
          ? asked.spawned.some(s => s.input?.startsWith('umask 077') && s.input.includes('mkdir -p "$p"'))
          : step === 'its proxy starts'
            ? asked.proxies.length > 0
            : step === 'its tunnel starts'
              ? asked.localHelpers.length > 0
              : asked.launches.length > 0
      expect(await eventually(asked.clock, reached)).toBe(true)
      if (exit === 'ended') {
        // The room's end comes on the stream; the open stays held through it.
        stream.push({ seq: 3, events: [{ seq: 3, type: 'ended', ts: 950, from: HOST_FROM, body: {} }], people: PREVIEW_PEOPLE, ended: true, title: 'demo' })
        await within(asked.clock, () => asked.state.mode === 'idle', 15_000)
        release()
      } else {
        const exiting =
          exit === 'leave'
            ? $.command.run({ command: 'stop-sharing', args: '' } as never)
            : $.session.end({ reason: exit === 'clear' ? 'clear' : 'other', sessionId: 'session-test-0001', resume: {} } as never)
        await asked.clock.advance(10)
        release()
        await asked.clock.advance(3_100)
        await exiting
      }
      await asked.clock.advance(3_500)
      expect(asked.state.mode).toBe('idle')
      expect(asked.state.room).toBeNull()
      expect(asked.state.previewWindow).toBeNull()
      expect(asked.windowState.alive).toBe(false)
      expect(asked.launches).toHaveLength(step === 'the browser starts' ? 1 : 0)
      if (step === 'its profile is made' || step === 'its proxy starts') expect(asked.localHelpers).toHaveLength(0)
      expect(asked.proxies.every(p => p.stopped)).toBe(true)
      expect(asked.localHelpers.every(h => h.stopped)).toBe(true)
      expect(asked.toasted.some(t => t.startsWith("Opened Sam's"))).toBe(false)
      const profile = await roomProfile()
      const removed = removedProfiles(asked).filter(s => s.input?.includes(`p='${profile}'`)).length
      if (exit === 'keep') {
        expect(removed).toBe(0)
        const kept = savedAt(asked, 'joined:session-test-0001')
        expect(kept.previewWindow?.profile).toBe(step === 'its profile is made' ? undefined : profile.split('/').pop())
      } else expect(removed).toBe((step === 'its profile is made' ? 0 : exit === 'clear' ? 2 : 1) + 1)
    })
  }
}

test('leaving while the browser starts closes the window it started and removes its profile again', async ($, on) => {
  let release!: () => void
  const asked = windowWorld(on, {
    beforeLaunch: () =>
      new Promise<void>(done => {
        release = done
      }),
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  const stopping = $.command.run({ command: 'stop-sharing', args: '' } as never)
  await asked.clock.advance(10)
  release()
  await stopping
  await asked.clock.advance(50)
  expect(asked.windowState.alive).toBe(false)
  expect(asked.windowState.kills).toBe(1)
  const profile = await roomProfile()
  // Removed after the browser started (it may have made the profile anew), and again by Leave.
  expect(removedProfiles(asked).filter(s => s.input?.includes(`p='${profile}'`)).length).toBeGreaterThanOrEqual(1)
  // The window it started is closed before its profile goes.
  const closed = asked.spawned.findIndex(s => s.input?.startsWith('# shared-session: close the preview window') && s.input.includes(profile))
  expect(asked.spawned.slice(closed).some(s => s.input?.startsWith('# shared-session: remove a preview profile'))).toBe(true)
  expect(asked.state.previewWindow).toBeNull()
  expect(asked.toasted.some(t => t.startsWith("Opened Sam's"))).toBe(false)
})

test("Stop sharing answers the host's question at once, and a new room starts with none", async ($, on) => {
  const asked = world(on, { surfaces: ['desktop'], discover: { 3340: DISCOVERED } })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await eventually(asked.clock, () => asked.state.hostAsk)
  expect(await ui.find({ key: 'host-ask-yes' })).toBeDefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  await asked.clock.advance(20)
  expect(asked.state.hostAsk).toBeNull()
  expect(asked.state.hostMemory).toBeNull()
  // Shared again: nothing of the old room's question is there, and nothing of it was shared.
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body.port)).toEqual([3340])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('pressing Share twice answers one question, never the next one', async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const api = { state: 'done', platform: 'darwin', target: { port: 4000, label: 'api', web: 'yes', devtools: false }, related: [] }
  const asked = world(on, { stream, surfaces: ['desktop'], discover: { 3340: DISCOVERED, 4000: api } })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await eventually(asked.clock, () => asked.state.hostAsk?.kind === 'related')
  // A guest's window asks too: its question waits behind the first.
  stream.push(needLine(4000))
  await eventually(asked.clock, () => asked.needLooks.some(d => d.port === 4000), 2000)
  stream.length = 0
  await asked.clock.advance(20)
  expect(asked.state.hostAsk?.kind).toBe('related')
  await Promise.all([ui.press({ key: 'host-ask-yes' }), ui.press({ key: 'host-ask-yes' })])
  await eventually(asked.clock, () => asked.state.hostAsk?.kind === 'need')
  await asked.clock.advance(50)
  expect(asked.state.hostAsk?.kind).toBe('need')
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body.port)).toEqual([3340, 3610])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a port the host just stopped isn't asked about for a guest's window, until the host shares it again", async ($, on) => {
  const api = { seq: 2, type: 'artifact', ts: 900, from: HOST_FROM, body: { kind: 'preview', pid: 'pv1', port: 3610, path: '/', title: 'API', tcp: true } }
  const stream: unknown[] = [{ seq: 2, events: [api], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = world(on, { stream, surfaces: ['desktop'], discover: NEEDS })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'stop-preview:pv1' })
  await eventually(asked.clock, () => asked.state.hostMemory?.declined.includes(3610))
  // A guest's window asking for it right after: nothing to look at, nothing to ask.
  stream.length = 0
  stream.push(needLine(3610))
  await asked.clock.advance(40_000)
  stream.length = 0
  await asked.clock.advance(20)
  expect(asked.needLooks).toHaveLength(0)
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  // Shared again on purpose: that Stop no longer stands.
  await $.command.run({ command: 'share-preview', args: '3610 API' } as never)
  await asked.clock.advance(20)
  expect(asked.state.hostMemory?.declined).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a preview the host stops isn't asked for by the window afterwards", async ($, on) => {
  const stream: unknown[] = [{ seq: 2, events: [WINDOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = windowWorld(on, { stream })
  await openedInWindow($, asked)
  stream.length = 0
  stream.push({
    seq: 3,
    events: [{ seq: 3, type: 'preview', ts: 950, from: HOST_FROM, body: { pid: 'pv-local', state: 'closed' } }],
    people: PREVIEW_PEOPLE,
    ended: false,
    title: 'demo',
  })
  await within(asked.clock, () => asked.state.needAsked?.ports.includes(3340), 3000)
  stream.length = 0
  expect(asked.state.shown?.find(s => s.pid === 'pv-local')).toMatchObject({ closed: true, tcp: false })
  asked.proxies[0]!.send({ state: 'blocked', port: 3340 })
  await asked.clock.advance(50)
  expect(asked.sent.filter(s => s.path.endsWith('/need'))).toHaveLength(0)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("the host's Stop as the window's browser starts: the window is this session's, but the page isn't said open in it", async ($, on) => {
  const stream: unknown[] = [{ seq: 2, events: [WINDOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  let launch: (() => void) | undefined
  const asked = windowWorld(on, {
    stream,
    beforeLaunch: () =>
      new Promise<void>(done => {
        launch = done
      }),
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => Boolean(launch))
  stream.splice(0, stream.length, {
    seq: 3,
    events: [{ seq: 3, type: 'preview', ts: 950, from: HOST_FROM, body: { pid: 'pv-local', port: 3340, state: 'closed' } }],
    people: PREVIEW_PEOPLE,
    ended: false,
    title: 'demo',
  })
  await within(asked.clock, () => asked.state.shown?.find(s => s.pid === 'pv-local')?.closed, 5000)
  stream.length = 0
  launch!()
  await asked.clock.advance(100)
  expect(asked.launches).toHaveLength(1)
  expect(asked.toasted.some(t => t.startsWith("Opened Sam's localhost:3340"))).toBe(false)
  expect(asked.state.previewWindow).toMatchObject({ port: 47100, opened: [] })
  // Leave closes it, as it does any window of this session's.
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  await asked.clock.advance(50)
  expect(asked.windowState.alive).toBe(false)
})

test("the host's Stop as the window's settings are written: no browser starts for a page nothing reaches, and the proxy stops", async ($, on) => {
  const stream: unknown[] = [{ seq: 2, events: [WINDOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  let settings: (() => void) | undefined
  const asked = windowWorld(on, {
    stream,
    beforeSettings: () =>
      new Promise<void>(done => {
        settings = done
      }),
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => Boolean(settings))
  // Its tunnel is up by now: the Stop is past every check before this one.
  expect(tunnels(asked)).toHaveLength(1)
  stream.splice(0, stream.length, {
    seq: 3,
    events: [{ seq: 3, type: 'preview', ts: 950, from: HOST_FROM, body: { pid: 'pv-local', port: 3340, state: 'closed' } }],
    people: PREVIEW_PEOPLE,
    ended: false,
    title: 'demo',
  })
  await within(asked.clock, () => asked.state.shown?.find(s => s.pid === 'pv-local')?.closed, 5000)
  stream.length = 0
  settings!()
  await asked.clock.advance(100)
  expect(asked.launches).toHaveLength(0)
  expect(asked.proxies.every(p => p.stopped)).toBe(true)
  expect(asked.toasted.some(t => t.startsWith("Opened Sam's localhost:3340"))).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("the host's memory of a room is in its state: a reload still knows Not now", async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = world(on, { stream, surfaces: ['desktop'], discover: NEEDS })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  stream.push(needLine(3610))
  await eventually(asked.clock, () => asked.state.hostAsk, 2000)
  stream.length = 0
  await ui.press({ key: 'host-ask-no' })
  await asked.clock.advance(20)
  // Not now to forwarding is no Stop: the port isn't marked stopped.
  expect(asked.state.hostMemory).toEqual({ declined: [3610], stopped: [], askedAt: { '3610': expect.any(Number) } })
  await $.session.start(START)
  await asked.clock.advance(11 * 60_000)
  stream.push(needLine(3610))
  await asked.clock.advance(40_000)
  stream.length = 0
  await asked.clock.advance(20)
  expect(asked.needLooks).toHaveLength(1)
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

for (const status of [429, 503] as const) {
  test(`a need the room refused for too many asks, or didn't answer (${status}), is asked again later`, async ($, on) => {
    const opts: Parameters<typeof world>[1] = {
      browser: { platform: 'Darwin', path: CHROME },
      localPreviewPort: 45001,
      stream: [{ seq: 2, events: [WINDOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
      needStatus: status,
      store: { previewOpen: 'window' },
    }
    const asked = world(on, opts)
    await openedInWindow($, asked)
    asked.proxies[0]!.send({ state: 'blocked', port: 5555 })
    await eventually(asked.clock, () => asked.sent.some(s => s.path.endsWith('/need')))
    await asked.clock.advance(20)
    expect(asked.state.needAsked?.ports).toEqual([])
    expect(asked.toasted.some(t => t.startsWith('Your preview tried'))).toBe(false)
    opts.needStatus = undefined
    asked.proxies[0]!.send({ state: 'blocked', port: 5555 })
    await eventually(asked.clock, () => asked.sent.filter(s => s.path.endsWith('/need')).length === 2)
    await asked.clock.advance(20)
    expect(asked.state.needAsked?.ports).toEqual([5555])
    expect(asked.toasted).toContain("Your preview tried localhost:5555, which Sam hasn't shared. The request went to Sam.")
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test("guests' windows asking for many ports: each port looked at once, one question in the row and three waiting, the rest not asked", async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const ports = [4001, 4002, 4003, 4004, 4005, 4006]
  const web = (port: number) => ({ state: 'done', platform: 'darwin', target: { port, label: `svc${port}`, web: 'yes', devtools: false }, related: [] })
  const asked = world(on, { stream, surfaces: ['desktop'], discover: Object.fromEntries(ports.map(p => [p, web(p)])) })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  stream.push(...ports.map(needLine))
  await eventually(asked.clock, () => asked.needLooks.length === 6, 2000)
  stream.length = 0
  await asked.clock.advance(50)
  // Each looked at once, in two seconds at most; no full discovery for a need.
  expect(asked.needLooks.map(d => [d.port, d.deadlineMs])).toEqual(ports.map(p => [p, 2000]))
  expect(asked.discovered).toHaveLength(0)
  const questions: number[] = []
  for (let i = 0; i < 6 && asked.state.hostAsk; i++) {
    questions.push(asked.state.hostAsk.port)
    await ui.press({ key: 'host-ask-no' })
    await asked.clock.advance(50)
  }
  expect(questions).toHaveLength(4)
  expect(new Set(questions).size).toBe(4)
  expect(asked.state.hostAsk).toBeFalsy()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('discovery is given 64 of the forwarded ports at most, and what it finds is checked against them all', async ($, on) => {
  const forwarded = Array.from({ length: 70 }, (_, i) => 5000 + i)
  const saved = { ...savedRoom('room0000000000000001', 900), shares: Object.fromEntries(forwarded.map((p, i) => [String(p), { pid: `pv-f${i}`, tcp: true }])) }
  const found = {
    state: 'done',
    platform: 'darwin',
    target: { port: 3340, label: 'next-server', web: 'yes', devtools: false },
    related: [
      { port: 5000, label: 'old-api', web: 'yes', devtools: false },
      { port: 3610, label: 'convex-local-backend', web: 'yes', devtools: false },
    ],
  }
  const asked = world(on, { discover: { 3340: found }, files: { [checkpointPath('hosting:session-test-0001')]: JSON.stringify({ version: 1, value: saved }) } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await asked.clock.advance(50)
  const reply = await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  expect(asked.discovered[0]!.exclude).toHaveLength(64)
  expect(asked.discovered[0]!.exclude).not.toContain(5000)
  expect(JSON.stringify(reply)).not.toContain('localhost:5000')
  expect(JSON.stringify(reply)).toContain('localhost:3610 · convex-local-backend')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('/share-preview of an https address shares an https preview; plain http says no scheme', async ($, on) => {
  const asked = world(on)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: 'https://localhost:3443/app App' } as never)
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact'))
  expect(asked.posted.find(e => e.type === 'artifact')?.body).toMatchObject({
    kind: 'preview',
    port: 3443,
    path: '/app',
    tcp: true,
    host: 'localhost',
    scheme: 'https',
  })
  await $.command.run({ command: 'share-preview', args: 'http://localhost:3340/ Web' } as never)
  await eventually(asked.clock, () => asked.posted.filter(e => e.type === 'artifact').length === 2)
  expect(asked.posted.filter(e => e.type === 'artifact')[1]!.body.scheme).toBeUndefined()
  // Its usage names both forms.
  expect(await $.command.run({ command: 'share-preview', args: 'nope' } as never)).toEqual({
    text: 'Which port? /share-preview <port|http://localhost:port/path> [title], e.g. /share-preview 3000',
  })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('an https localhost address Claude gives out is looked at over TLS and shared as https', async ($, on) => {
  const asked = world(on, { surfaces: ['desktop'], stream: [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }] })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  const reply = { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Running at https://localhost:3340/dash' }] }
  await $.session.append({ message: reply, door: 'response', origin: { kind: 'composer' }, uuid: 'a1' } as never)
  await allowShow(asked, ui)
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact'))
  expect(asked.spawned.find(s => s.input?.startsWith('r=$(curl '))?.input).toContain(
    "curl -gsk -o /dev/null -H 'Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' -w '%{http_code} %{content_type}' --connect-timeout 2 -m 3 'https://localhost:3340/')",
  )
  expect(asked.posted.find(e => e.type === 'artifact')?.body).toMatchObject({ kind: 'preview', port: 3340, path: '/dash', scheme: 'https' })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

const HTTPS_SHOWN = { ...WINDOW_SHOWN, body: { ...WINDOW_SHOWN.body, scheme: 'https' } }

test('an https preview opens at its own https address in the window', async ($, on) => {
  const asked = windowWorld(on, { stream: [{ seq: 2, events: [HTTPS_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }] })
  const pane = await openedInWindow($, asked)
  expect(asked.launches[0]!.at(-1)).toBe('https://127.0.0.1:3340/login?next=%2Faccount')
  expect(await pane.find({ type: 'Text', text: 'Opens https://127.0.0.1:3340/login?next=%2Faccount in a preview window' })).toBeDefined()
  expect(asked.state.shown?.find(s => s.pid === 'pv-local')?.scheme).toBe('https')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("an https preview opens with https in the person's own browser too", async ($, on) => {
  const asked = world(on, {
    localPreviewPort: 45001,
    env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
    stream: [{ seq: 2, events: [HTTPS_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount(roomPane('terminal'))
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length)
  expect(asked.externals).toEqual(['https://127.0.0.1:3340/login?next=%2Faccount'])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a browser that reports a start and opens no window says so, never that it ignores its proxy', async ($, on) => {
  const asked = windowWorld(on, { launchNoWindow: true })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  const failed =
    "Google Chrome didn't open a preview window within 10 seconds. If none opens, set Previews to Claude's browser in Room → Settings, and a preview whose ports are free here opens there instead."
  // A cold first start takes a while: not said before ten seconds.
  await asked.clock.advance(9_000)
  expect(asked.toasted).not.toContain(failed)
  await within(asked.clock, () => asked.toasted.includes(failed), 3000)
  expect(asked.toasted).toContain(failed)
  expect(asked.toasted.some(t => t.startsWith("Opened Sam's"))).toBe(false)
  await asked.clock.advance(16_000)
  expect(asked.toasted.some(t => t.includes("doesn't seem to use its proxy"))).toBe(false)
  expect(asked.state.previewWindow?.opened).toEqual([])
  expect(await ui.find({ key: 'open-preview' })).toBeDefined()
  // Not seen isn't failed: nothing opened it at the host's numbers.
  expect(tunnels(asked).map(t => [t.port, t.strict])).toEqual([[0, false]])
  expect(asked.externals).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('one failed look at the window changes nothing; three in a row, and it counts as gone', async ($, on) => {
  const lockFails = { count: 0 }
  const asked = windowWorld(on, { lockFails })
  await openedInWindow($, asked)
  lockFails.count = 1
  await asked.clock.advance(30_100)
  await asked.clock.advance(20)
  expect(asked.proxies[0]!.stopped).toBe(false)
  expect(asked.state.previewWindow?.opened).toEqual(['pv-local'])
  lockFails.count = 3
  for (let i = 0; i < 3; i++) await asked.clock.advance(30_000)
  await eventually(asked.clock, () => asked.proxies[0]!.stopped)
  expect(asked.proxies[0]!.stopped).toBe(true)
  expect(asked.state.previewWindow?.opened).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

for (const status of [503, 403, 400])
  test(`a routes post the window's proxy answers ${status} is sent again; three in a row end the proxy`, async ($, on) => {
    const routesFail = { count: 1, status }
    const asked = windowWorld(on, { routesFail })
    await openedInWindow($, asked)
    await asked.clock.advance(1_100)
    expect(asked.proxies[0]!.stopped).toBe(false)
    expect(routesOf(asked)).toEqual({ routes: { '3340': 45001 }, startable: [] })
    routesFail.count = 3
    asked.localHelpers[0]!.send({ state: 'error', code: 'STARTUP' })
    await within(asked.clock, () => asked.proxies[0]!.stopped, 5000, 500)
    expect(asked.proxies[0]!.stopped).toBe(true)
    // Ended by this session: its port is no window of this session's any more.
    await eventually(asked.clock, () => asked.state.previewWindow?.port === 0)
    expect(asked.state.previewWindow).toMatchObject({ port: 0, opened: [] })
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })

for (const cause of ['its routes refused three times', 'three looks at it failing'] as const) {
  test(`a host's-profile window whose proxy this session ends (${cause}) is closed on its port first: Leave leaves nothing open, and the next Open is on the host's profile again`, async ($, on) => {
    const routesFail = { count: 0, status: 503 }
    const lockFails = { count: 0 }
    const asked = windowWorld(on, { routesFail, lockFails, stream: [{ seq: 2, events: [WINDOW_SHOWN], people: SIGNED_IN, ended: false, title: 'demo' }] })
    const pane = await openedInWindow($, asked)
    const host = await hostProfilePath()
    expect(asked.launches[0]).toContain(`--user-data-dir=${host}/chrome`)
    if (cause === 'its routes refused three times') {
      routesFail.count = 3
      asked.localHelpers[0]!.send({ state: 'error', code: 'STARTUP' })
      await within(asked.clock, () => asked.proxies[0]!.stopped, 5000, 500)
    } else {
      lockFails.count = 3
      for (let i = 0; i < 3; i++) await asked.clock.advance(30_000)
      await eventually(asked.clock, () => asked.proxies[0]!.stopped)
    }
    await eventually(asked.clock, () => asked.state.previewWindow?.port === 0)
    await asked.clock.advance(20)
    // Its window can reach nothing now: closed, on this session's proxy port alone, and said.
    expect(asked.windowState.alive).toBe(false)
    expect(
      asked.spawned
        .filter(s => s.input?.startsWith('# shared-session: close the preview window') && s.input.includes(host))
        .every(s => s.input?.includes('w=47100')),
    ).toBe(true)
    expect(asked.toasted).toContain("The preview window closed: its connection to Sam's previews stopped working. Press Open preview to open it again.")
    // Opened again: the host's profile, nothing there now.
    await pane.press({ key: 'open-preview:pv-local' })
    await within(asked.clock, () => asked.launches.length === 2, 5_000)
    expect(asked.launches[1]).toContain(`--user-data-dir=${host}/chrome`)
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
    await asked.clock.advance(50)
    expect(asked.windowState.alive).toBe(false)
  })
}

// A second page's Open that ends without a window: what serves the window
// open already isn't this Open's to end.
const WINDOW_AND_B = (people: typeof PREVIEW_PEOPLE) => [{ seq: 4, events: [WINDOW_SHOWN, PAGE_B], people, ended: false, title: 'demo' }]

const pageRunning = (asked: ReturnType<typeof world>) => asked.localHelpers.filter(h => h.pid === 'pv-local' && !h.stopped).length

test("a second page's Open whose look at the window fails, its tunnel not starting, leaves the window open for the first: its proxy and tunnel go on, and Leave closes it", async ($, on) => {
  const failB = { now: false }
  const lockFails = { count: 0 }
  const asked = windowWorld(on, {
    beforeHelper: pid => {
      if (pid === 'pv-b' && failB.now) throw new Error("it didn't start")
    },
    lockFails,
    stream: WINDOW_AND_B(PREVIEW_PEOPLE),
  })
  const pane = await openedInWindow($, asked)
  failB.now = true
  lockFails.count = 1
  const before = asked.toasted.length
  await pane.press({ key: 'open-preview:pv-b' })
  await within(asked.clock, () => asked.toasted.includes(tunnelUnstarted(3341)), 6_000)
  await asked.clock.advance(6_000)
  expect(lockFails.count).toBe(0)
  // A look that failed knows nothing, and the proxy was the window's already: nothing of it ends.
  expect(asked.windowState).toMatchObject({ alive: true, kills: 0 })
  expect(asked.proxies.map(p => p.stopped)).toEqual([false])
  expect(pageRunning(asked)).toBe(1)
  expect(asked.state.previewWindow).toMatchObject({ port: 47100, opened: ['pv-local'] })
  expect(asked.toasted.slice(before)).toEqual([tunnelUnstarted(3341)])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  await asked.clock.advance(50)
  expect(asked.windowState.alive).toBe(false)
})

test("a second page's Open while another session of this person's holds the host's profile, its tunnel not starting, leaves this session's window there working through its looks, until Leave closes it", async ($, on) => {
  const failB = { now: false }
  const launchLockHeld = { count: 0 }
  const asked = windowWorld(on, {
    beforeHelper: pid => {
      if (pid === 'pv-b' && failB.now) throw new Error("it didn't start")
    },
    launchLockHeld,
    stream: WINDOW_AND_B(SIGNED_IN),
  })
  const pane = await openedInWindow($, asked)
  const host = await hostProfilePath()
  expect(asked.launches[0]).toContain(`--user-data-dir=${host}/chrome`)
  asked.proxies[0]!.send({ state: 'seen', port: 3340 })
  failB.now = true
  launchLockHeld.count = 20
  const before = asked.toasted.length
  await pane.press({ key: 'open-preview:pv-b' })
  await within(asked.clock, () => asked.toasted.includes(tunnelUnstarted(3341)), 6_000)
  await asked.clock.advance(100)
  // It turned to the room's own profile for that page and opened nothing there.
  expect(asked.launches).toHaveLength(1)
  expect(asked.windowState).toMatchObject({ alive: true, kills: 0, profile: host })
  expect(asked.proxies.map(p => p.stopped)).toEqual([false])
  expect(pageRunning(asked)).toBe(1)
  // The record is still that window's, so its looks find it on its port.
  expect(asked.state.previewWindow).toMatchObject({ port: 47100, opened: ['pv-local'], profile: host.split('/').pop() })
  launchLockHeld.count = 0
  for (let i = 0; i < 3; i++) await asked.clock.advance(30_000)
  expect(asked.proxies.map(p => p.stopped)).toEqual([false])
  expect(pageRunning(asked)).toBe(1)
  expect(asked.state.previewWindow).toMatchObject({ port: 47100, opened: ['pv-local'] })
  expect(asked.toasted.slice(before)).toEqual([tunnelUnstarted(3341)])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  await asked.clock.advance(50)
  expect(asked.windowState.alive).toBe(false)
  expect(
    asked.spawned
      .filter(s => s.input?.startsWith('# shared-session: close the preview window') && s.input.includes(host))
      .every(s => s.input?.includes('w=47100')),
  ).toBe(true)
})

test("a second page's Open while another session holds the host's profile opens in the room's own window: the record names it, with only what's open in it", async ($, on) => {
  const launchLockHeld = { count: 0 }
  const asked = windowWorld(on, { launchLockHeld, stream: WINDOW_AND_B(SIGNED_IN) })
  const pane = await openedInWindow($, asked)
  launchLockHeld.count = 20
  await pane.press({ key: 'open-preview:pv-b' })
  await within(asked.clock, () => asked.launches.length === 2, 6_000)
  await asked.clock.advance(20)
  const own = await roomProfile()
  expect(asked.launches[1]).toContain(`--user-data-dir=${own}/chrome`)
  expect(asked.state.previewWindow).toEqual({ room: 'https://share.test/room0000000000000001', port: 47100, opened: ['pv-b'], profile: own.split('/').pop() })
  launchLockHeld.count = 0
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a second page's Open whose look at the window keeps failing leaves the first page's window, its proxy and its tunnel as they were", async ($, on) => {
  const lockFails = { count: 0 }
  const asked = windowWorld(on, { lockFails, stream: WINDOW_AND_B(PREVIEW_PEOPLE) })
  const pane = await openedInWindow($, asked)
  lockFails.count = 2
  const before = asked.toasted.length,
    spawned = asked.spawned.length
  await pane.press({ key: 'open-preview:pv-b' })
  await within(asked.clock, () => asked.toasted.includes(LOOK_UNKNOWN), 3_000)
  await asked.clock.advance(6_000)
  expect(lockFails.count).toBe(0)
  // A look that knows nothing ends nothing (P7-1): the window, its proxy and the first page's tunnel go on.
  expect(asked.windowState).toMatchObject({ alive: true, kills: 0 })
  expect(asked.launches).toHaveLength(1)
  expect(asked.proxies.map(p => p.stopped)).toEqual([false])
  expect(pageRunning(asked)).toBe(1)
  expect(asked.localHelpers.some(h => h.pid === 'pv-b')).toBe(false)
  expect(asked.state.previewWindow).toMatchObject({ port: 47100, opened: ['pv-local'] })
  expect(
    asked.spawned
      .slice(spawned)
      .some(s => s.input?.startsWith('# shared-session: chrome preferences') || s.input?.startsWith('# shared-session: close the preview window')),
  ).toBe(false)
  expect(asked.toasted.slice(before)).toEqual([LOOK_UNKNOWN])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  await asked.clock.advance(50)
  expect(asked.windowState.alive).toBe(false)
})

test("an Open that can't tell whether the window is open keeps the page's refusal as it was: the next Open starts it anew", async ($, on) => {
  const lockFails = { count: 0 }
  const asked = windowWorld(on, { lockFails })
  const pane = await openedInWindow($, asked)
  const refused = await refuseForGood(asked, 'pv-local', 3340)
  await eventually(asked.clock, () => asked.state.previewNeedsOpen?.includes('pv-local'))
  const starts = () => tunnels(asked).filter(t => t.url.endsWith('/previews/pv-local/tunnel')).length
  const before = starts()
  lockFails.count = 2
  await pane.press({ key: 'open-preview:pv-local' })
  await within(asked.clock, () => asked.toasted.includes(LOOK_UNKNOWN), 3_000)
  await asked.clock.advance(20)
  expect(asked.state.previewNeedsOpen).toContain('pv-local')
  expect(starts()).toBe(before)
  expect(refused.stopped).toBe(true)
  // Asked again with the look answering: its own Open starts it anew.
  await pane.press({ key: 'open-preview:pv-local' })
  await within(asked.clock, () => starts() > before, 3_000)
  await asked.clock.advance(20)
  expect(asked.state.previewNeedsOpen ?? []).not.toContain('pv-local')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a look after closing a window of another browser that keeps failing starts nothing there: it says so, and the proxy waits for the next Open', async ($, on) => {
  const lockFails = { count: 0 }
  let closes = 0
  const asked = firefoxWorld(on, {
    windowOpen: { profile: await roomProfile(), port: 47100 },
    lockFails,
    beforeKill: async () => {
      if (closes++ === 0) lockFails.count = 2
    },
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await within(asked.clock, () => asked.toasted.includes(LOOK_UNKNOWN), 3_000)
  await asked.clock.advance(20)
  expect(lockFails.count).toBe(0)
  expect(asked.windowState.kills).toBe(1)
  expect(asked.launches).toHaveLength(0)
  expect(asked.firefoxSettings.size).toBe(0)
  expect(tunnels(asked)).toHaveLength(0)
  expect(asked.proxies.map(p => p.stopped)).toEqual([false])
  // Pressed again: the look finds no window now, and Firefox opens on that proxy.
  await ui.press({ key: 'open-preview' })
  await within(asked.clock, () => asked.launches.length, 3_000)
  expect(asked.launches[0]?.[3]).toBe(FIREFOX)
  expect(asked.proxies).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("the window's proxy saying many lines at once goes on; one line past 8 KiB ends it, and the window's tunnels with it", async ($, on) => {
  const asked = windowWorld(on)
  await openedInWindow($, asked)
  const proxy = asked.proxies[0]!
  // Four hundred short lines in one go: more than a line holds, each line within it.
  const lines = Array.from({ length: 400 }, () => JSON.stringify({ state: 'seen', port: 3340 })).join('\n') + '\n'
  expect(lines.length > 8192).toBe(true)
  proxy.output(lines)
  await asked.clock.advance(20)
  expect(proxy.stopped).toBe(false)
  // One line past the bound: no proxy says that, so it's ended.
  proxy.output(`${JSON.stringify({ state: 'seen', port: 3340, more: 'x'.repeat(8200) })}\n`)
  await eventually(asked.clock, () => proxy.stopped && asked.localHelpers.every(h => h.stopped))
  expect(proxy.stopped).toBe(true)
  expect(asked.localHelpers.every(h => h.stopped)).toBe(true)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('each session in a room has a window profile of its own, named for its lasting place', async ($, on) => {
  const asked = windowWorld(on, { env: { CLAUDE_CODE_HOST_SESSION_ID: PLACE } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start(START)
  await openedInWindow($, asked)
  const profile = await roomProfile(PLACE)
  expect(profile).not.toBe(await roomProfile())
  expect(asked.launches[0]).toContain(`--user-data-dir=${profile}/chrome`)
  await $.session.end({ reason: 'other', sessionId: 'session-test-0001', resume: {} } as never)
  const kept = savedAt(asked, 'joined:session-test-0001')
  expect(kept.place).toBe(PLACE)
  expect(kept.previewWindow.profile).toBe(profile.split('/').pop())
})

test('a session Claude Desktop reopens under a new id takes its window profile back, and what the host forwards', async ($, on) => {
  const name = await profileName('https://share.test', 'room0000000000000001', PLACE)
  const saved = {
    at: 900,
    room: { server: 'https://share.test', id: 'room0000000000000001', url: LINK, title: 'demo', host: 'Sam', token: 'g', seat: 'seat1', seq: 2, since: 1 },
    autoOpen: true,
    policy: { prompts: 'everyone', approvals: 'edits', files: 'on' },
    localPreviews: [],
    activity: [],
    chat: [],
    sidebar: null,
    place: PLACE,
    previewWindow: { port: 47100, profile: name },
    // What the host forwards, in the place's Shown.
    shown: [
      {
        key: 'preview:pv-local',
        kind: 'preview',
        name: 'Sign in (preview)',
        ts: 900,
        pid: 'pv-local',
        port: 3340,
        path: '/login?next=%2Faccount',
        tcp: true,
        host: '127.0.0.1',
      },
    ],
  }
  const asked = windowWorld(on, {
    sessionId: 'session-test-0002',
    env: { CLAUDE_CODE_HOST_SESSION_ID: PLACE },
    files: {
      [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: saved }),
      '/home/scott/.claude/shared-session/browser/.keep': '',
    },
    stream: [{ seq: 2, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
    roomList: { previews: [{ pid: 'pv-local', port: 3340, tcp: true }] },
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await eventually(asked.clock, () => asked.state.mode === 'guest')
  expect(asked.state.previewWindow).toEqual({ room: 'https://share.test/room0000000000000001', port: 47100, opened: [], profile: name })
  const gc = await eventually(asked.clock, () => asked.spawned.find(s => s.input?.startsWith('# shared-session: clean up preview profiles')))
  expect(gc?.input).toContain(`keep='${name}'`)
  // No new events: what the place kept, and the room's list of it, are enough to open.
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  expect(asked.launches[0]).toContain(`--user-data-dir=/home/scott/.claude/shared-session/browser/${name}/chrome`)
  expect(asked.launches[0]!.at(-1)).toBe(WINDOW_URL)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("the window's own tunnel says what failed in the preview window's words", async ($, on) => {
  const asked = windowWorld(on)
  await openedInWindow($, asked)
  asked.localHelpers[0]!.send({ state: 'channel-error', code: 'BUSY' })
  asked.localHelpers[0]!.send({ state: 'channel-error', code: 'CONNECT' })
  asked.localHelpers[0]!.send({ state: 'channel-error', code: 'CONNECT' })
  await asked.clock.advance(1_000)
  expect(asked.toasted.some(t => t.startsWith('The preview window'))).toBe(false)
  await within(asked.clock, () => asked.toasted.some(t => t.startsWith("The preview window couldn't connect")), 2000)
  expect(asked.toasted.filter(t => t.startsWith('The preview window'))).toHaveLength(2)
  expect(asked.toasted).toContain('The preview window reached its connection or request limit. Close unused tabs in it or wait a minute, then reload the page.')
  expect(asked.toasted).toContain("The preview window couldn't connect to Sam's localhost:3340. Check that it's running there, then reload the page.")
  expect(asked.toasted.some(t => t.startsWith('Preview connection or request limit') || t.startsWith('The last channel'))).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a need answered after Leave says nothing', async ($, on) => {
  let release!: () => void
  const asked = windowWorld(on, {
    needWait: new Promise<void>(done => {
      release = done
    }),
  })
  await openedInWindow($, asked)
  asked.proxies[0]!.send({ state: 'blocked', port: 5555 })
  await eventually(asked.clock, () => asked.sent.some(s => s.path.endsWith('/need')))
  const stopping = $.command.run({ command: 'stop-sharing', args: '' } as never)
  await asked.clock.advance(10)
  release()
  await stopping
  await asked.clock.advance(50)
  expect(asked.toasted.some(t => t.startsWith('Your preview tried'))).toBe(false)
})

test('an HTTP-only preview has one way to open it; a forwarded one keeps its Public link', async ($, on) => {
  const link = { seq: 3, type: 'artifact', ts: 901, from: HOST_FROM, body: { kind: 'preview', pid: 'pv-link', port: 4000, path: '/', title: 'Docs' } }
  const asked = windowWorld(on, { stream: [{ seq: 3, events: [WINDOW_SHOWN, link], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }] })
  const pane = await openedInWindow($, asked)
  await asked.clock.advance(10)
  expect(await pane.find({ key: 'open-preview:pv-link' })).toBeDefined()
  expect(await pane.find({ key: 'public-preview:pv-link' })).toBeUndefined()
  expect(await pane.find({ key: 'public-preview:pv-local' })).toBeDefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('what a page uses has no Open or Public link of its own: it opens with the page', async ($, on) => {
  const asked = windowWorld(on, { stream: [{ seq: 3, events: [WINDOW_SHOWN, DEP_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }] })
  const pane = await openedInWindow($, asked)
  await asked.clock.advance(10)
  expect(await pane.find({ key: 'open-preview:pv-local' })).toBeDefined()
  expect(await pane.find({ key: 'public-preview:pv-local' })).toBeDefined()
  expect(await pane.find({ key: 'open-preview:pv-dep' })).toBeUndefined()
  expect(await pane.find({ key: 'public-preview:pv-dep' })).toBeUndefined()
  expect((await pane.find({ type: 'Text', text: 'Used for the preview of localhost:3340' }))?.text).toBe('Used for the preview of localhost:3340')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

for (const [how, start] of [
  ['back from a restart', 'resume'],
  ['reloaded', 'reload'],
] as const) {
  test(`a host ${how} still forwards what it shared itself`, async ($, on) => {
    const stream: unknown[] = []
    const saved = { ...savedRoom('room0000000000000001', 900), shares: { '3340': { pid: 'pv1', tcp: true } } }
    const opts: Parameters<typeof world>[1] = {
      stream,
      tcpRelays: true,
      ...(start === 'resume' ? { files: { [checkpointPath('hosting:session-test-0001')]: JSON.stringify({ version: 1, value: saved }) } } : {}),
    }
    const asked = world(on, opts)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    if (start === 'reload') {
      await $.command.run({ command: 'share-session', args: '' } as never)
      await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
      await asked.clock.advance(20)
    }
    await $.session.start(START)
    await asked.clock.advance(50)
    stream.push({ tcp: { id: 'connection0001', pid: 'pv1', port: 3340 } })
    await within(asked.clock, () => asked.sent.some(s => s.body.op === 'open'), 6000, 500)
    expect(asked.sent.filter(s => s.body.op === 'open').map(s => s.body.id)).toEqual(['connection0001'])
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

// Second review: a dependency Claude opens, what Open preview promises after
// a refusal, a need the room answers with its preview, a slow first start,
// a Leave between an open's steps, and a Stop racing a page's connection.

test('a page Claude opens on a forwarded dependency goes out still a dependency, at the address it was forwarded at', async ($, on) => {
  const asked = world(on, { surfaces: ['desktop'], discover: { 3340: DISCOVERED } })
  on('tool.call', { tool: 'mcp__Claude_Browser__navigate' }, () => ({ result: [], text: 'navigated' }) as never)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: 'http://127.0.0.1:3340/app App' } as never)
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact' && e.body.port === 3340))
  expect((await ui.find({ key: 'host-ask-yes' }))?.props.label).toBe('Share too')
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact' && e.body.port === 3610))
  await asked.clock.advance(10)
  // Claude opens the API's health page, then the page at another spelling of loopback.
  await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'http://localhost:3610/health' } as never)
  await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'http://localhost:3340/app/settings' } as never)
  await asked.clock.advance(200)
  const api = asked.posted.filter(e => e.type === 'artifact' && e.body.port === 3610)
  expect(api).toHaveLength(2)
  expect(api[1]!.body.pid).toBe(api[0]!.body.pid)
  expect(api[1]!.body).toMatchObject({ kind: 'preview', tcp: true, host: 'localhost', path: '/health', dependency: 3340 })
  const page = asked.posted.filter(e => e.type === 'artifact' && e.body.port === 3340)
  expect(page.at(-1)!.body).toMatchObject({ kind: 'preview', tcp: true, host: '127.0.0.1', path: '/app/settings' })
  expect(page.at(-1)!.body.dependency).toBeUndefined()
  // What it was forwarded as lasts through a restart of the host's session.
  expect(asked.state.shares?.['3610']).toEqual({ pid: api[0]!.body.pid, tcp: true, host: 'localhost', dependency: 3340 })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  expect(asked.state.shares).toEqual({})
})

test('a host back from a restart keeps what each forwarded preview was shared as', async ($, on) => {
  const shown = {
    key: 'preview:pv2',
    kind: 'preview',
    name: 'localhost:3610 (convex-local-backend)',
    ts: 900,
    pid: 'pv2',
    port: 3610,
    path: '/',
    tcp: true,
    host: 'localhost',
    dependency: 3340,
  }
  // As this version saves a place: its shares.
  const shares = { '3610': { pid: 'pv2', tcp: true, host: 'localhost', dependency: 3340 }, '3611': { pid: 'pv 3', tcp: true }, '70000': { pid: 'pv4' } }
  const saved = { ...savedRoom('room0000000000000001', 900), shares, shown: [shown] }
  const asked = world(on, { stream: [], files: { [checkpointPath('hosting:session-test-0001')]: JSON.stringify({ version: 1, value: saved }) } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', { tool: 'mcp__Claude_Browser__navigate' }, () => ({ result: [], text: 'navigated' }) as never)
  await $.session.start(START)
  await asked.clock.advance(50)
  // Only shares that check out come back.
  expect(asked.state.shares).toEqual({ '3610': { pid: 'pv2', tcp: true, host: 'localhost', dependency: 3340 } })
  await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'http://127.0.0.1:3610/health' } as never)
  await asked.clock.advance(200)
  expect(asked.posted.find(e => e.type === 'artifact' && e.body.port === 3610)?.body).toMatchObject({
    pid: 'pv2',
    tcp: true,
    host: 'localhost',
    path: '/health',
    dependency: 3340,
  })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a host's saved place keeps its shares, its TLS ones too", async ($, on) => {
  const asked = world(on, { surfaces: ['desktop'], stream: [{ seq: 1, events: [], people: HOST_ONLY, ended: false, title: 'demo' }] })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start(START)
  await $.command.run({ command: 'share-session', args: 'new' } as never)
  // A page Claude gave out, over TLS, the host's Share for it, and a port the host forwards.
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Running at https://localhost:3340/app' }] },
    door: 'response',
    origin: { kind: 'composer' },
    uuid: 'a1',
  } as never)
  await allowShow(asked, await $.ui.mount(band('desktop')))
  await eventually(asked.clock, () => asked.state.shares?.['3340'])
  await $.command.run({ command: 'share-preview', args: '3610 API' } as never)
  const shares = { '3340': { pid: 'pv1', scheme: 'https' }, '3610': { pid: 'pv2', tcp: true } }
  expect(asked.state.shares).toEqual(shares)
  await $.session.end({ reason: 'other', sessionId: 'session-test-0001', resume: {} } as never)
  const saved = savedAt(asked, 'hosting:session-test-0001')
  expect(saved.shares).toEqual(shares)
  expect(Object.keys(saved).filter(k => k === 'previews' || k === 'forwardPorts')).toEqual([])
  expect(asked.state.shares).toEqual({})
  // Back again: as saved, its TLS too.
  await $.session.start(START)
  await eventually(asked.clock, () => Object.keys(asked.state.shares ?? {}).length)
  expect(asked.state.shares).toEqual(shares)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a dependency Claude opened stays one for the guest: Open preview opens its page, whose Open clears the dependency's refusal", async ($, on) => {
  // What the host sends now when Claude opens the API's /health: still the app's dependency.
  const NAVIGATED = {
    seq: 4,
    type: 'artifact',
    ts: 902,
    from: HOST_FROM,
    body: { kind: 'preview', pid: 'pv-api', port: 61199, path: '/health', title: 'localhost:61199', tcp: true, host: 'localhost', dependency: 61198 },
  }
  const asked = dependencyWorld(on, [APP_SHOWN, API_SHOWN, NAVIGATED], {
    stream: [{ seq: 4, events: [APP_SHOWN, API_SHOWN, NAVIGATED], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  expect(asked.state.shown?.find(s => s.pid === 'pv-api')).toMatchObject({ port: 61199, path: '/health', tcp: true, dependency: 61198 })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(10)
  expect(asked.launches[0]!.at(-1)).toBe('http://localhost:61198/')
  asked.proxies[0]!.send({ state: 'want', port: 61199 })
  await eventually(asked.clock, () => routesOf(asked)?.routes['61199'] === 45021)
  await refuseForGood(asked, 'pv-api', 61199)
  await asked.clock.advance(1_520)
  expect(asked.toasted).toContain(
    "Sam's side refused the preview window's connection to localhost:61199, which the preview of localhost:61198 uses. Press Open preview for that page to reconnect.",
  )
  expect((await ui.find({ key: 'open-preview' }))?.props.label).toBe('Open preview')
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length === 2)
  await asked.clock.advance(10)
  expect(asked.launches[1]!.at(-1)).toBe('http://localhost:61198/')
  expect(asked.state.previewNeedsOpen).toEqual([])
  expect(routesOf(asked)).toEqual({ routes: { '61198': 45020 }, startable: [61199] })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

const DOCS_SHOWN = {
  seq: 4,
  type: 'artifact',
  ts: 902,
  from: HOST_FROM,
  body: { kind: 'preview', pid: 'pv-docs', port: 61200, path: '/', title: 'Docs', tcp: true },
}

const threeWorld = (on: On, events: unknown[]) =>
  world(on, {
    browser: { platform: 'Darwin', path: CHROME },
    localPreviewByPid: { 'pv-app': { port: 45020 }, 'pv-api': { port: 45021 }, 'pv-docs': { port: 45022 } },
    stream: [{ seq: 4, events, people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
    store: { previewOpen: 'window' },
  })

test('after a refusal, Open preview opens what reconnects it, in the order refused, before a newer page', async ($, on) => {
  const asked = threeWorld(on, [APP_SHOWN, API_SHOWN, DOCS_SHOWN])
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await asked.clock.advance(10)
  // The app, opened from the Room: the newer page is still to open.
  await pane.press({ key: 'open-preview:pv-app' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(10)
  expect(asked.launches[0]!.at(-1)).toBe('http://localhost:61198/')
  asked.proxies[0]!.send({ state: 'want', port: 61199 })
  await eventually(asked.clock, () => routesOf(asked)?.routes['61199'] === 45021)
  await refuseForGood(asked, 'pv-api', 61199)
  await asked.clock.advance(1_520)
  expect(asked.toasted).toContain(
    "Sam's side refused the preview window's connection to localhost:61199, which the preview of localhost:61198 uses. Press Open preview for that page to reconnect.",
  )
  // What the toast promised: the app, not the newer page.
  expect((await ui.find({ key: 'open-preview' }))?.props.label).toBe('Open preview')
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length === 2)
  await asked.clock.advance(10)
  expect(asked.launches[1]!.at(-1)).toBe('http://localhost:61198/')
  expect(asked.state.previewNeedsOpen).toEqual([])
  // Nothing refused now: the newest page not open yet is next, as before.
  expect((await ui.find({ key: 'open-preview' }))?.props.label).toBe('Open preview')
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length === 3)
  expect(asked.launches[2]!.at(-1)).toBe('http://localhost:61200/')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a refusal Open preview can't reopen points to the Room's Open for it", async ($, on) => {
  // The API alone (its page isn't forwarded), and a newer page it has nothing to do with.
  const asked = threeWorld(on, [API_SHOWN, DOCS_SHOWN])
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  await $.ui.mount(band('desktop'))
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await asked.clock.advance(10)
  await pane.press({ key: 'open-preview:pv-api' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(10)
  expect(asked.launches[0]!.at(-1)).toBe('http://localhost:61199/')
  await refuseForGood(asked, 'pv-api', 61199)
  await asked.clock.advance(1_520)
  expect(asked.toasted).toContain(
    "Sam's side refused the preview window's connection to localhost:61199, which the preview of localhost:61198 uses. Press Open on localhost:61199 in Room → Shown to reconnect.",
  )
  expect(asked.toasted.some(t => t.includes('61199') && t.includes('Press Open preview'))).toBe(false)
  // The band's Open preview is the other page, as it was; the Room's Open reconnects the API.
  await pane.press({ key: 'open-preview:pv-api' })
  await eventually(asked.clock, () => asked.launches.length === 2)
  await asked.clock.advance(10)
  expect(asked.launches[1]!.at(-1)).toBe('http://localhost:61199/')
  expect(asked.state.previewNeedsOpen).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a slow first start whose page reaches the proxy opens; the ten-second check says nothing', async ($, on) => {
  const asked = windowWorld(on, { launchNoWindow: true })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(7_000)
  asked.proxies[0]!.send({ state: 'seen', port: 3340 })
  await within(asked.clock, () => (asked.state.previewWindow?.opened ?? []).includes('pv-local'), 2000)
  expect(asked.state.previewWindow?.opened).toEqual(['pv-local'])
  await asked.clock.advance(12_000)
  expect(asked.toasted.some(t => t.startsWith("Couldn't open"))).toBe(false)
  expect(asked.toasted.some(t => t.startsWith("Opened Sam's localhost:3340"))).toBe(true)
  expect(await ui.find({ key: 'open-preview' })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a window said not to open whose page reaches the proxy later opens after all, with nothing more said', async ($, on) => {
  const asked = windowWorld(on, { launchNoWindow: true })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  const failed =
    "Google Chrome didn't open a preview window within 10 seconds. If none opens, set Previews to Claude's browser in Room → Settings, and a preview whose ports are free here opens there instead."
  await within(asked.clock, () => asked.toasted.includes(failed), 12_000)
  expect(asked.state.previewWindow?.opened).toEqual([])
  expect(await ui.find({ key: 'open-preview' })).toBeDefined()
  const said = [...asked.toasted]
  asked.proxies[0]!.send({ state: 'seen', port: 3340 })
  await within(asked.clock, () => (asked.state.previewWindow?.opened ?? []).includes('pv-local'), 2000)
  expect(asked.state.previewWindow?.opened).toEqual(['pv-local'])
  await asked.clock.advance(16_000)
  expect(asked.toasted).toEqual(said)
  expect(await ui.find({ key: 'open-preview' })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('an open left between its check and the write it guards still removes the profile it made', async ($, on) => {
  let made = false,
    held = false
  let hold: (() => void) | undefined
  // The profile made, the open's check passed (its room's scope open): the
  // write it guards (the window's profile) lands only once the Leave is in.
  const beforeSet = async (key: string, value: unknown) => {
    if (!made || held || key !== 'previewWindow' || !(value as { profile?: string } | null)?.profile) return
    held = true
    await new Promise<void>(done => {
      hold = done
    })
  }
  const asked = windowWorld(on, {
    beforeSet,
    beforeProfile: async () => {
      made = true
    },
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await ui.unmount()
  await eventually(asked.clock, () => Boolean(hold))
  expect(Boolean(hold)).toBe(true)
  // The Leave begins: it finds no window saved for the room, and waits for the open.
  const stopping = $.command.run({ command: 'stop-sharing', args: '' } as never)
  await asked.clock.advance(10)
  hold!()
  await asked.clock.advance(3_100)
  await stopping
  await asked.clock.advance(50)
  expect(asked.launches).toHaveLength(0)
  expect(asked.state.previewWindow).toBeNull()
  // The Leave knew of no profile; the open removed the one it made.
  const profile = await roomProfile()
  expect(removedProfiles(asked).filter(s => s.input?.includes(`p='${profile}'`))).toHaveLength(1)
})

for (const code of ['CONNECT', 'BUSY', 'AUTH'] as const) {
  test(`a page's connection failing (${code}) as the host stops sharing its port says the Stop, once, not the failure`, async ($, on) => {
    const stream: unknown[] = [{ seq: 2, events: [WINDOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
    const asked = windowWorld(on, { stream })
    await openedInWindow($, asked)
    // The host pressed Stop: the page's connections fail before the end reaches this session.
    asked.localHelpers[0]!.send({ state: 'channel-error', code })
    asked.localHelpers[0]!.send({ state: 'channel-error', code })
    await asked.clock.advance(5)
    stream.push({
      seq: 3,
      events: [{ seq: 3, type: 'preview', ts: 950, from: HOST_FROM, body: { pid: 'pv-local', port: 3340, state: 'closed' } }],
      people: PREVIEW_PEOPLE,
      ended: false,
      title: 'demo',
    })
    await within(asked.clock, () => asked.toasted.some(t => t.includes('stopped sharing')), 3000)
    await asked.clock.advance(3_000)
    expect(asked.toasted.filter(t => t.startsWith('The preview window') || t.includes('stopped sharing') || t.includes('refused'))).toEqual([
      'Sam stopped sharing localhost:3340.',
    ])
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test("a page's connection failing while the host still shares its port is said a moment on, once", async ($, on) => {
  const asked = windowWorld(on)
  await openedInWindow($, asked)
  asked.localHelpers[0]!.send({ state: 'channel-error', code: 'CONNECT' })
  await asked.clock.advance(1_400)
  expect(asked.toasted.some(t => t.startsWith('The preview window'))).toBe(false)
  await asked.clock.advance(200)
  expect(asked.toasted.filter(t => t.startsWith('The preview window'))).toEqual([
    "The preview window couldn't connect to Sam's localhost:3340. Check that it's running there, then reload the page.",
  ])
  // The same again says nothing more; working again, a later failure is said again.
  asked.localHelpers[0]!.send({ state: 'channel-error', code: 'CONNECT' })
  await asked.clock.advance(1_600)
  expect(asked.toasted.filter(t => t.startsWith('The preview window'))).toHaveLength(1)
  asked.localHelpers[0]!.send({ state: 'channel-ready' })
  await asked.clock.advance(20)
  asked.localHelpers[0]!.send({ state: 'channel-error', code: 'CONNECT' })
  asked.localHelpers[0]!.send({ state: 'channel-ready' })
  await asked.clock.advance(1_600)
  // Recovered within the moment: nothing to say.
  expect(asked.toasted.filter(t => t.startsWith('The preview window'))).toHaveLength(1)
  asked.localHelpers[0]!.send({ state: 'channel-error', code: 'CONNECT' })
  await asked.clock.advance(1_600)
  expect(asked.toasted.filter(t => t.startsWith('The preview window'))).toHaveLength(2)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// ---------------------------------------------------------------------------
// Refusals and the launch check: what an independent review found after the
// second round of window fixes.

test("the person's own Open within 1.5 s of a refusal, once reconnected, says nothing stale", async ($, on) => {
  const asked = windowWorld(on)
  await openedInWindow($, asked)
  const ui = await $.ui.mount(band('desktop'))
  await eventually(asked.clock, () => routesOf(asked)?.routes['3340'] === 45001)
  const first = await refuseForGood(asked, 'pv-local', 3340)
  await asked.clock.advance(20)
  expect(asked.state.previewNeedsOpen).toEqual(['pv-local'])
  await asked.clock.advance(300)
  expect((await ui.find({ key: 'open-preview' }))?.props.label).toBe('Open preview')
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length === 2)
  await asked.clock.advance(10)
  expect(asked.state.previewNeedsOpen).toEqual([])
  const second = asked.localHelpers.at(-1)!
  expect(second).not.toBe(first)
  second.send({ state: 'channel-ready' })
  await asked.clock.advance(1_600)
  const stale = asked.toasted.filter(t => t.includes("refused the preview window's connection"))
  expect(stale).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a seen landing just as the ten-second launch check gives up still counts the window', async ($, on) => {
  const asked = windowWorld(on, { launchNoWindow: true })
  let base = -1,
    injected = false
  const probes = () => asked.spawned.filter(s => s.input?.startsWith('# shared-session: is the preview window open')).length
  on('state.get', async ($, e, next) => {
    if (!injected && base >= 0 && probes() >= base + 20 && e.key === 'room') {
      injected = true
      asked.proxies[0]!.send({ state: 'seen', port: 3340 })
      for (let i = 0; i < 30; i++) await Promise.resolve()
    }
    return next(e)
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  base = probes()
  const failed =
    "Google Chrome didn't open a preview window within 10 seconds. If none opens, set Previews to Claude's browser in Room → Settings, and a preview whose ports are free here opens there instead."
  await within(asked.clock, () => asked.toasted.includes(failed) || (asked.state.previewWindow?.opened ?? []).includes('pv-local'), 12_000, 100)
  await asked.clock.advance(3_000)
  expect(injected).toBe(true)
  expect(asked.toasted.includes(failed) && !(asked.state.previewWindow?.opened ?? []).includes('pv-local')).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})
