// Allow forwarding: what the host is asked about a guest's window, a mention
// or a page's dependencies, and how often.

import { expect, test } from 'claude-code/testing'
import {
  LINK,
  band,
  world,
  eventually,
  PREVIEW_PEOPLE,
  savedRoom,
  START,
  checkpointPath,
  STEP,
  WINDOW_URL,
  windowWorld,
  roomPane,
  DISCOVERED,
  hostAsked,
  NEEDS,
  needLine,
  HOST_ONLY,
  LINKED,
  sharingLink,
  allowShow,
  deliver,
  stopInRoom,
  TRANSCRIPT,
  transcriptRow,
  proxyAsk,
  proxyAnswers,
  proxyPages,
  within,
} from './support/world'

test('a replayed forwarded preview points at Open preview and the address it opens at', async ($, on) => {
  const asked = windowWorld(on)
  on('tool.list', () => ({ value: [] }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  await $.turn.start({ turnId: 'join-preview', text: LINK })
  await $.turn.complete({ turnId: 'join-preview', isAborted: false, durationMs: 0, reason: 'answer' } as never)
  await asked.clock.advance(10)
  await $.turn.start({ turnId: 'show-forwarded', text: 'Sam shared Sign in (preview)' })
  const chunks = []
  for await (const chunk of $.turn.step({ ...STEP, turnId: 'show-forwarded' } as never)) chunks.push(chunk)
  const text = chunks
    .filter(c => c.kind === 'text')
    .map(c => c.text)
    .join('')
  expect(text).toContain(`press **Open preview** above the prompt (or **Open** in the Room) to open it at ${WINDOW_URL}`)
  expect(asked.launches).toHaveLength(0)
  expect(asked.localHelpers).toHaveLength(0)
  await $.turn.complete({ turnId: 'show-forwarded', isAborted: false, durationMs: 0, reason: 'answer' } as never)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// Three servers beside it, as discovery finds them.
const MANY = {
  state: 'done',
  platform: 'darwin',
  target: { port: 3340, label: 'next-server', web: 'yes', devtools: false },
  related: [
    { port: 3610, label: 'convex-local-backend', web: 'yes', devtools: false },
    { port: 3611, label: 'api', web: 'yes', devtools: false },
    { port: 27017, label: 'mongod', web: 'slow', devtools: false },
  ],
}

test('discovery saying a line past 8 KiB has found nothing: no question is asked', async ($, on) => {
  const asked = world(on, { surfaces: ['desktop'], discover: { 3340: { ...DISCOVERED, more: 'x'.repeat(8200) } } })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  const reply = await $.command.run({ command: 'share-preview', args: 'http://127.0.0.1:3340/app App' } as never)
  await asked.clock.advance(20)
  expect(asked.discovered).toHaveLength(1)
  expect(JSON.stringify(reply)).not.toContain('convex-local-backend')
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('/share-preview finds what the page uses beside it; Share too forwards it at the same address', async ($, on) => {
  const asked = world(on, { surfaces: ['desktop'], discover: { 3340: DISCOVERED } })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  const reply = await $.command.run({ command: 'share-preview', args: 'http://127.0.0.1:3340/app App' } as never)
  expect(JSON.stringify(reply)).toContain('localhost:3610 · convex-local-backend')
  expect(asked.discovered[0]).toMatchObject({ port: 3340, exclude: [], deadlineMs: 4000 })
  expect(asked.discovered[0]!.pluginRoot).toBeTruthy()
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact' && e.body.port === 3340))
  expect(asked.posted.find(e => e.type === 'artifact' && e.body.port === 3340)?.body).toMatchObject({
    kind: 'preview',
    port: 3340,
    path: '/app',
    tcp: true,
    host: '127.0.0.1',
  })
  expect(await ui.find({ type: 'Text', text: 'Share localhost:3610 too? convex-local-backend, beside localhost:3340' })).toBeDefined()
  expect((await ui.find({ key: 'host-ask-yes' }))?.props.label).toBe('Share too')
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact' && e.body.port === 3610))
  await asked.clock.advance(10)
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body)).toEqual([
    { port: 3340, title: 'App', tcp: true },
    { port: 3610, title: 'localhost:3610 (convex-local-backend)', tcp: true },
  ])
  expect(asked.posted.find(e => e.type === 'artifact' && e.body.port === 3610)?.body).toMatchObject({
    kind: 'preview',
    tcp: true,
    host: 'localhost',
    path: '/',
    dependency: 3340,
  })
  // The page itself is no dependency.
  expect(asked.posted.find(e => e.type === 'artifact' && e.body.port === 3340)?.body.dependency).toBeUndefined()
  expect(asked.toasted).toContain('Teammates can reach localhost:3610 now. Stop it in Room → Shown.')
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  expect(
    Object.entries(asked.state.shares ?? {})
      .filter(([, share]) => share.tcp)
      .map(([port]) => port)
      .sort(),
  ).toEqual(['3340', '3610'])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('Allow forwarding finds what the page uses too; Share too marks it for that page', async ($, on) => {
  const mentioned = {
    seq: 2,
    type: 'artifact',
    ts: 900,
    from: { seat: 'host', name: 'Sam', role: 'host' },
    body: { kind: 'preview', pid: 'pv1', port: 3340, path: '/', title: 'localhost:3340', host: '127.0.0.1' },
  }
  const asked = world(on, {
    surfaces: ['desktop'],
    discover: { 3340: DISCOVERED },
    stream: [{ seq: 2, events: [mentioned], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'forward-preview:pv1' })
  await eventually(asked.clock, () => asked.discovered.length)
  await asked.clock.advance(20)
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact' && e.body.port === 3610))
  expect(asked.posted.find(e => e.type === 'artifact' && e.body.port === 3610)?.body).toMatchObject({
    kind: 'preview',
    tcp: true,
    title: 'localhost:3610 (convex-local-backend)',
    dependency: 3340,
  })
  expect(asked.posted.filter(e => e.type === 'artifact' && e.body.port === 3340).every(e => e.body.dependency === undefined)).toBe(true)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('Allow forwarding finds what the page uses too; Not now is remembered for the room', async ($, on) => {
  const mentioned = {
    seq: 2,
    type: 'artifact',
    ts: 900,
    from: { seat: 'host', name: 'Sam', role: 'host' },
    body: { kind: 'preview', pid: 'pv1', port: 3340, path: '/', title: 'localhost:3340', host: '127.0.0.1' },
  }
  const asked = world(on, {
    surfaces: ['desktop'],
    discover: { 3340: DISCOVERED },
    stream: [{ seq: 2, events: [mentioned], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'forward-preview:pv1' })
  await eventually(asked.clock, () => asked.discovered.length)
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact' && e.body.tcp === true))
  await asked.clock.advance(20)
  expect(asked.posted.find(e => e.type === 'artifact' && e.body.tcp === true)?.body).toMatchObject({ pid: 'pv1', port: 3340, host: '127.0.0.1' })
  expect(asked.toasted).toContain('Teammates can reach localhost:3340 now. Stop it in Room → Shown.')
  expect(await ui.find({ type: 'Text', text: 'Share localhost:3610 too? convex-local-backend, beside localhost:3340' })).toBeDefined()
  await ui.press({ key: 'host-ask-no' })
  await asked.clock.advance(20)
  expect(await ui.find({ key: 'host-ask-no' })).toBeUndefined()
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body.port)).toEqual([3340])
  // Shared again in this room: Not now stands.
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await asked.clock.advance(20)
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("/share-preview with the row full (three questions waiting) says how to share what it found, and doesn't count it asked", async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  let release!: () => void
  const held = new Promise<void>(done => {
    release = done
  })
  const ports = [4001, 4002, 4003, 4004]
  const web = (port: number) => ({ state: 'done', platform: 'darwin', target: { port, label: `svc${port}`, web: 'yes', devtools: false }, related: [] })
  const asked = world(on, {
    stream,
    surfaces: ['desktop'],
    discover: { 3340: DISCOVERED, ...Object.fromEntries(ports.map(p => [p, web(p)])) },
    discoverWait: () => held,
  })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  // A guest's window's four needs: one question showing, three waiting.
  stream.push(...ports.map(needLine))
  await eventually(asked.clock, () => asked.discovered.length, 2000)
  stream.length = 0
  release()
  await eventually(asked.clock, () => asked.discovered.length === 4, 2000)
  await asked.clock.advance(50)
  expect(asked.state.hostAsk?.port).toBe(4001)
  const reply = JSON.stringify(await $.command.run({ command: 'share-preview', args: '3340 App' } as never))
  expect(reply).not.toContain('from the row above the prompt')
  expect(reply).toContain('It looks like it also uses localhost:3610 · convex-local-backend. To share localhost:3610 too, use /share-preview 3610.')
  expect(asked.state.hostMemory?.askedAt['3610']).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a port Claude mentions, with a guest here, asks once to open it at the same address; Allow forwards it alone, and what it uses is asked about after', async ($, on) => {
  const asked = world(on, {
    surfaces: ['desktop'],
    discover: { 3340: DISCOVERED },
    stream: [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  const reply = { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Running at http://127.0.0.1:3340/dash' }] }
  await $.session.append({ message: reply, door: 'response', origin: { kind: 'composer' }, uuid: 'a1' } as never)
  // Shared through its link only once the host says so; then the same address is asked about.
  expect(await eventually(asked.clock, () => asked.state.hostAsk?.kind === 'show')).toBe(true)
  expect(await hostAsked(ui)).toBe('Share localhost:3340 with the room?')
  expect((await ui.find({ key: 'host-ask-yes' }))?.props.label).toBe('Share')
  expect(asked.posted.filter(e => e.type === 'artifact')).toEqual([])
  await allowShow(asked, ui)
  await eventually(asked.clock, () => asked.discovered.length)
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact'))
  await asked.clock.advance(20)
  const shared = asked.posted.find(e => e.type === 'artifact')?.body
  expect(shared).toMatchObject({ kind: 'preview', port: 3340, path: '/dash', host: '127.0.0.1' })
  expect(shared?.tcp).toBeUndefined()
  // One port a question: what it uses beside it isn't in this one's yes.
  expect(await hostAsked(ui)).toBe('Let guests open localhost:3340 at the same address?')
  expect((await ui.find({ key: 'host-ask-yes' }))?.props.label).toBe('Allow')
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.toasted.includes('Teammates can reach localhost:3340 now. Stop it in Room → Shown.'))
  await asked.clock.advance(10)
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body)).toEqual([
    { port: 3340, title: 'localhost:3340' },
    { port: 3340, title: 'localhost:3340', tcp: true },
  ])
  // Then the server it uses, in a question of its own.
  await eventually(asked.clock, () => asked.state.hostAsk?.related[0]?.port === 3610)
  expect(await hostAsked(ui)).toBe('Share localhost:3610 too? convex-local-backend, beside localhost:3340')
  expect((await ui.find({ key: 'host-ask-yes' }))?.props.label).toBe('Share too')
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.posted.filter(e => e.type === 'artifact' && e.body.tcp === true).length === 2)
  await asked.clock.advance(10)
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body)).toEqual([
    { port: 3340, title: 'localhost:3340' },
    { port: 3340, title: 'localhost:3340', tcp: true },
    { port: 3610, title: 'localhost:3610 (convex-local-backend)', tcp: true },
  ])
  expect(asked.posted.filter(e => e.type === 'artifact' && e.body.tcp === true).map(e => [e.body.port, e.body.host, e.body.path, e.body.dependency])).toEqual([
    [3340, '127.0.0.1', '/dash', undefined],
    [3610, 'localhost', '/', 3340],
  ])
  expect(asked.toasted).toContain('Teammates can reach localhost:3610 now. Stop it in Room → Shown.')
  // Mentioned again: asked once a port.
  await $.session.append({ message: reply, door: 'response', origin: { kind: 'composer' }, uuid: 'a2' } as never)
  await asked.clock.advance(50)
  expect(asked.discovered).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// A page Claude gives out or opens is the host's to give: a guest's prompt
// can have Claude name any port of the host's, and what answers there (an
// admin page, a login redirect) went to the room through its link unasked.
test(
  'a page Claude gives out goes to the room only once the host says so: Not now shares nothing, and holds for the room',
  { timeoutMs: 20_000 },
  async ($, on) => {
    const asked = world(on, { surfaces: ['desktop'], stream: [{ seq: 1, events: [], people: HOST_ONLY, ended: false, title: 'demo' }] })
    const ui = await $.ui.mount(band('desktop'))
    await ui.press({ key: 'share' })
    await ui.press({ key: 'share-prompt' })
    await asked.clock.advance(20)
    const mention = (uuid: string) =>
      $.session.append({
        message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Admin at http://localhost:3340/admin' }] },
        door: 'response',
        origin: { kind: 'composer' },
        uuid,
      } as never)
    await mention('a1')
    expect(await eventually(asked.clock, () => asked.state.hostAsk?.kind === 'show')).toBe(true)
    expect(await hostAsked(ui)).toBe('Share localhost:3340 with the room?')
    await asked.clock.advance(1_000)
    expect(asked.sent.filter(x => x.path.endsWith('/previews'))).toEqual([])
    expect(asked.posted.filter(e => e.type === 'artifact')).toEqual([])
    await ui.press({ key: 'host-ask-no' })
    await asked.clock.advance(50)
    expect(asked.state.hostMemory?.declined).toEqual([3340])
    await asked.clock.advance(11 * 60_000)
    await mention('a2')
    await asked.clock.advance(300)
    expect(asked.state.hostAsk ?? null).toBeNull()
    expect(asked.sent.filter(x => x.path.endsWith('/previews'))).toEqual([])
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  },
)

test("with nowhere to ask the host (a -p run), a page Claude gives out or opens isn't shared", async ($, on) => {
  const asked = world(on, { surfaces: [], stream: [{ seq: 1, events: [], people: HOST_ONLY, ended: false, title: 'demo' }] })
  on('tool.call', { tool: 'mcp__Claude_Browser__navigate' }, () => ({ result: [], text: 'navigated' }) as never)
  await $.command.run({ command: 'share-session', args: '' } as never)
  await asked.clock.advance(20)
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Running at http://localhost:3340/' }] },
    door: 'response',
    origin: { kind: 'composer' },
    uuid: 'a1',
  } as never)
  await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'http://localhost:3341/' } as never)
  await asked.clock.advance(1_000)
  expect(asked.sent.filter(x => x.path.endsWith('/previews'))).toEqual([])
  expect(asked.state.hostAsk ?? null).toBeNull()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("an Allow that couldn't forward is asked about again ten minutes on: not at once, and not never", { timeoutMs: 20_000 }, async ($, on) => {
  const refused = { now: true }
  const asked = world(on, {
    surfaces: ['desktop'],
    discover: { 3340: { ...DISCOVERED, related: [] } },
    refuseForward: refused,
    stream: [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  on('tool.call', { tool: 'mcp__Claude_Browser__navigate' }, () => ({ result: [], text: 'navigated' }) as never)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  const opened = async () => {
    await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'http://localhost:3340/' } as never)
    await asked.clock.advance(200)
  }
  await opened()
  await allowShow(asked, ui)
  await eventually(asked.clock, () => asked.state.hostAsk?.kind === 'mention')
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.toasted.includes("Couldn't allow forwarding localhost:3340"))
  refused.now = false
  await opened()
  expect(asked.discovered).toHaveLength(1)
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  await asked.clock.advance(10 * 60_000)
  await opened()
  await eventually(asked.clock, () => asked.state.hostAsk)
  expect(asked.discovered).toHaveLength(2)
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.toasted.includes('Teammates can reach localhost:3340 now. Stop it in Room → Shown.'))
  expect(asked.state.shares?.['3340']).toMatchObject({ pid: 'pv1', tcp: true })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a guest's window asking for a web server the host didn't share asks the host; Share forwards it", async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = world(on, { stream, surfaces: ['desktop'], discover: NEEDS })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  // Not a web server, or a browser's debugging port: never asked about.
  stream.push(needLine(5432), needLine(9222))
  await eventually(asked.clock, () => asked.needLooks.length === 2, 2000)
  stream.length = 0
  await asked.clock.advance(20)
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  stream.push(needLine(3610))
  await eventually(asked.clock, () => asked.needLooks.some(d => d.port === 3610), 2000)
  stream.length = 0
  await asked.clock.advance(20)
  expect((await ui.find({ type: 'Text', text: /^Alex$/ }))?.props.bold).toBe(true)
  expect(await ui.find({ type: 'Text', text: "'s preview needs localhost:3610 · convex-local-backend" })).toBeDefined()
  expect((await ui.find({ key: 'host-ask-yes' }))?.props.label).toBe('Share')
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact' && e.body.port === 3610))
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body)).toEqual([
    { port: 3610, title: 'localhost:3610 (convex-local-backend)', tcp: true },
  ])
  // For a page of the guest's window, which the need doesn't name.
  expect(asked.posted.find(e => e.type === 'artifact' && e.body.port === 3610)?.body.dependency).toBe(true)
  expect(asked.toasted).toContain('Teammates can reach localhost:3610 now. Stop it in Room → Shown.')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("Not now to a guest's window is remembered for the room, and a teammate's tool approval comes first", async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = world(on, { stream, surfaces: ['desktop'], discover: NEEDS })
  let approving: unknown = null
  on('state.get', async ($, e, next) => (e.key === 'approving' && approving ? ({ value: { value: approving, version: 1 } } as never) : next(e)))
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  stream.push(needLine(3610))
  await eventually(asked.clock, () => asked.needLooks.length, 2000)
  stream.length = 0
  await asked.clock.advance(20)
  expect(await ui.find({ key: 'host-ask-yes' })).toBeDefined()
  approving = { who: 'Alex', what: 'Bash(npm test)', always: 'Always allow Alex' }
  await asked.clock.advance(10)
  const outranked = await $.ui.mount(band('desktop'))
  expect(await outranked.find({ key: 'approve-once' })).toBeDefined()
  expect(await outranked.find({ key: 'host-ask-yes' })).toBeUndefined()
  await outranked.unmount()
  approving = null
  const again = await $.ui.mount(band('desktop'))
  await again.press({ key: 'host-ask-no' })
  await asked.clock.advance(20)
  expect(await again.find({ key: 'host-ask-no' })).toBeUndefined()
  // Asked again much later: Not now stands for this room.
  await asked.clock.advance(11 * 60_000)
  stream.push(needLine(3610))
  await asked.clock.advance(40_000)
  stream.length = 0
  await asked.clock.advance(20)
  expect(asked.needLooks).toHaveLength(1)
  expect(await again.find({ key: 'host-ask-yes' })).toBeUndefined()
  expect(asked.sent.filter(x => x.path.endsWith('/previews'))).toHaveLength(0)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test(
  "a guest's window asking again while its question still waits isn't asked about twice, however long it has waited",
  { timeoutMs: 20_000 },
  async ($, on) => {
    const API = { state: 'done', platform: 'darwin', target: { port: 3611, label: 'api', web: 'yes', devtools: false }, related: [] }
    const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
    const asked = world(on, { stream, surfaces: ['desktop'], discover: { ...NEEDS, 3611: API } })
    const ui = await $.ui.mount(band('desktop'))
    await ui.press({ key: 'share' })
    await ui.press({ key: 'share-prompt' })
    await asked.clock.advance(20)
    const looked = (port: number) => asked.needLooks.filter(d => d.port === port).length
    // 3610's question shows; 3611's waits behind it.
    await deliver(asked, stream, [needLine(3610), needLine(3611)], () => looked(3611))
    await asked.clock.advance(20)
    expect(await ui.find({ type: 'Text', text: "'s preview needs localhost:3610 · convex-local-backend" })).toBeDefined()
    // 3610's goes unanswered; 3611's shows, ten minutes after it was first asked.
    await asked.clock.advance(10 * 60_000 + 1_000)
    expect(await ui.find({ type: 'Text', text: "'s preview needs localhost:3611 · api" })).toBeDefined()
    // Both asked for again: 3610 is asked about again, 3611 still is.
    await deliver(asked, stream, [needLine(3610), needLine(3611)], () => looked(3610) === 2)
    await asked.clock.advance(20)
    expect(looked(3611)).toBe(1)
    await ui.press({ key: 'host-ask-no' })
    await asked.clock.advance(20)
    expect(await ui.find({ type: 'Text', text: "'s preview needs localhost:3610 · convex-local-backend" })).toBeDefined()
    await ui.press({ key: 'host-ask-no' })
    await asked.clock.advance(20)
    expect(await ui.find({ key: 'host-ask-no' })).toBeUndefined()
    expect(looked(3611)).toBe(1)
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  },
)

for (const without of ['a row to ask in', 'What Claude shows'] as const) {
  test(`without ${without}, a guest's window asking never reaches the host`, async ($, on) => {
    const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
    const asked = world(on, { stream, discover: NEEDS, ...(without === 'What Claude shows' ? { surfaces: ['desktop'] } : {}) })
    const ui = await $.ui.mount(band('desktop'))
    await ui.press({ key: 'share' })
    await ui.press({ key: 'share-prompt' })
    await asked.clock.advance(20)
    if (without === 'What Claude shows') {
      const pane = await $.ui.mount(roomPane())
      await pane.press({ key: 'tab-settings' })
      await pane.select({ key: 'policy-files', value: 'off' })
    }
    stream.push(needLine(3610))
    await asked.clock.advance(40_000)
    stream.length = 0
    await asked.clock.advance(20)
    expect(asked.needLooks).toHaveLength(0)
    expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test('with three servers beside a page, the row asks about one port a question: a yes forwards just the port it names, Not now declines just that one', async ($, on) => {
  const asked = world(on, { surfaces: ['terminal'], discover: { 3340: MANY } })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  const reply = await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  expect(JSON.stringify(reply)).toContain(
    'It looks like it also uses localhost:3610 · convex-local-backend, localhost:3611 · api and localhost:27017 · mongod: share them too from the row above the prompt, one at a time.',
  )
  const forwarded = () => asked.sent.filter(x => x.path.endsWith('/previews')).map(x => [x.body.port, x.body.tcp])
  await eventually(asked.clock, () => asked.state.hostAsk)
  // A row cut short can't hide a port a yes forwards: it names one.
  expect(await hostAsked(ui)).toBe('Share localhost:3610 too? convex-local-backend, beside localhost:3340')
  expect(asked.state.hostAsk?.related).toEqual([{ port: 3610, label: 'convex-local-backend' }])
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.toasted.includes('Teammates can reach localhost:3610 now. Stop it in Room → Shown.'))
  expect(forwarded()).toEqual([
    [3340, true],
    [3610, true],
  ])
  await eventually(asked.clock, () => asked.state.hostAsk?.related[0]?.port === 3611)
  expect(await hostAsked(ui)).toBe('Share localhost:3611 too? api, beside localhost:3340')
  await ui.press({ key: 'host-ask-no' })
  await eventually(asked.clock, () => asked.state.hostAsk?.related[0]?.port === 27017)
  expect(await hostAsked(ui)).toBe('Share localhost:27017 too? mongod, beside localhost:3340')
  expect(asked.state.hostMemory?.declined).toEqual([3611])
  expect(forwarded()).toEqual([
    [3340, true],
    [3610, true],
  ])
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.toasted.includes('Teammates can reach localhost:27017 now. Stop it in Room → Shown.'))
  await asked.clock.advance(50)
  expect(forwarded()).toEqual([
    [3340, true],
    [3610, true],
    [27017, true],
  ])
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('Allow forwarding with three servers beside the page: its toast names the page alone, and each Share too forwards just the port its row names', async ($, on) => {
  const mentioned = {
    seq: 2,
    type: 'artifact',
    ts: 900,
    from: { seat: 'host', name: 'Sam', role: 'host' },
    body: { kind: 'preview', pid: 'pv1', port: 3340, path: '/', title: 'localhost:3340', host: '127.0.0.1' },
  }
  const asked = world(on, {
    surfaces: ['terminal'],
    discover: { 3340: MANY },
    stream: [{ seq: 2, events: [mentioned], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'forward-preview:pv1' })
  await eventually(asked.clock, () => asked.state.hostAsk)
  expect(asked.toasted).toContain('Teammates can reach localhost:3340 now. Stop it in Room → Shown.')
  expect(await hostAsked(ui)).toBe('Share localhost:3610 too? convex-local-backend, beside localhost:3340')
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.state.hostAsk?.related[0]?.port === 3611)
  await asked.clock.advance(20)
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => [x.body.port, x.body.tcp ?? false])).toEqual([
    [3340, true],
    [3610, true],
  ])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a port the host said Not now to while a mention's question waited is never forwarded by that question's Allow", async ($, on) => {
  const BESIDE_3000 = {
    state: 'done',
    platform: 'darwin',
    target: { port: 3000, label: 'next-server', web: 'yes', devtools: false },
    related: [{ port: 3610, label: 'convex-local-backend', web: 'yes', devtools: false }],
  }
  const asked = world(on, {
    surfaces: ['desktop'],
    discover: { 3000: BESIDE_3000, 3340: DISCOVERED },
    stream: [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  await $.command.run({ command: 'share-preview', args: '3000 App' } as never)
  await eventually(asked.clock, () => asked.state.hostAsk)
  expect(asked.state.hostAsk).toMatchObject({ kind: 'related', port: 3000, related: [{ port: 3610 }] })
  // Claude names 3340: whether it's shared waits behind the first question,
  // and then its address, whose discovery finds 3610 too.
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Running at http://localhost:3340/' }] },
    door: 'response',
    origin: { kind: 'composer' },
    uuid: 'a1',
  } as never)
  await asked.clock.advance(50)
  await ui.press({ key: 'host-ask-no' })
  await allowShow(asked, ui)
  await eventually(asked.clock, () => asked.state.hostAsk?.kind === 'mention')
  expect(asked.state.hostAsk).toMatchObject({ kind: 'mention', port: 3340, related: [] })
  expect(await hostAsked(ui)).toBe('Let guests open localhost:3340 at the same address?')
  expect(asked.state.hostMemory?.declined).toEqual([3610])
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.toasted.includes('Teammates can reach localhost:3340 now. Stop it in Room → Shown.'))
  await asked.clock.advance(200)
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => [x.body.port, x.body.tcp ?? false])).toEqual([
    [3000, true],
    [3340, false],
    [3340, true],
  ])
  // Its Not now stands: 3610 isn't asked about again for 3340.
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("/share-preview after Not now says how to share what the row won't ask about, never sends the host to the row for it", async ($, on) => {
  const asked = world(on, { surfaces: ['desktop'], discover: { 3340: DISCOVERED } })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  const first = await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  expect(JSON.stringify(first)).toContain('It looks like it also uses localhost:3610 · convex-local-backend: share it too from the row above the prompt.')
  await eventually(asked.clock, () => asked.state.hostAsk)
  await ui.press({ key: 'host-ask-no' })
  await asked.clock.advance(20)
  const again = JSON.stringify(await $.command.run({ command: 'share-preview', args: '3340 App' } as never))
  await asked.clock.advance(50)
  expect(again).not.toContain('from the row above the prompt')
  expect(again).toContain(
    'It looks like it also uses localhost:3610 · convex-local-backend. You said Not now to localhost:3610 in this room; to share it, use /share-preview 3610.',
  )
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

for (const why of ['no row here to ask in', 'its question asked already'] as const) {
  test(`/share-preview with ${why} says how to share what it found, never sends the host to the row for it`, async ($, on) => {
    const asked = world(on, { discover: { 3340: DISCOVERED }, ...(why === 'no row here to ask in' ? {} : { surfaces: ['desktop'] }) })
    const ui = await $.ui.mount(band('desktop'))
    await ui.press({ key: 'share' })
    await ui.press({ key: 'share-prompt' })
    if (why === 'its question asked already') {
      await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
      await eventually(asked.clock, () => asked.state.hostAsk)
    }
    const reply = JSON.stringify(await $.command.run({ command: 'share-preview', args: '3340 App' } as never))
    await asked.clock.advance(50)
    expect(reply).not.toContain('from the row above the prompt')
    expect(reply).toContain('It looks like it also uses localhost:3610 · convex-local-backend. To share localhost:3610 too, use /share-preview 3610.')
    // The one question there is (if any), not a second.
    expect(asked.discovered).toHaveLength(why === 'no row here to ask in' ? 1 : 2)
    expect(Boolean(asked.state.hostAsk)).toBe(why !== 'no row here to ask in')
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

// A question a service: a backend on two ports (nar-stack2's
// convex-local-backend on 3510 and 3511, beside its Next.js) is one process,
// one question, one press.
const svc = (port: number, label: string, pid?: number) => ({ port, label, web: 'yes', devtools: false, ...(pid ? { pid } : {}) })

const beside = (related: unknown[]) => ({
  state: 'done',
  platform: 'darwin',
  target: { port: 3340, label: 'next-server', web: 'yes', devtools: false },
  related,
})

const CONVEX = [svc(3510, 'convex-local-backend'), svc(3511, 'convex-local-backend')]

const previewPosts = (asked: ReturnType<typeof world>) => asked.sent.filter(x => x.path.endsWith('/previews')).map(x => [x.body.port, x.body.tcp ?? false])

test('a backend on two ports beside a page is one question, every port before its label: one Share too forwards both', async ($, on) => {
  const asked = world(on, { surfaces: ['terminal'], discover: { 3340: beside(CONVEX) } })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  const reply = JSON.stringify(await $.command.run({ command: 'share-preview', args: '3340 App' } as never))
  expect(reply).toContain('It looks like it also uses localhost:3510 and 3511 · convex-local-backend: share it too from the row above the prompt.')
  await eventually(asked.clock, () => asked.state.hostAsk)
  // Every port before the label: a row too narrow cuts the label, never a port the yes forwards.
  const words = await hostAsked(ui)
  expect(words).toBe('Share localhost:3510 and 3511 too? convex-local-backend, beside localhost:3340')
  expect(words!.indexOf('3511')).toBeLessThan(words!.indexOf('convex-local-backend'))
  expect(asked.state.hostAsk?.related).toEqual([
    { port: 3510, label: 'convex-local-backend' },
    { port: 3511, label: 'convex-local-backend' },
  ])
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.toasted.includes('Teammates can reach localhost:3510 and localhost:3511 now. Stop them in Room → Shown.'))
  await asked.clock.advance(50)
  expect(previewPosts(asked)).toEqual([
    [3340, true],
    [3510, true],
    [3511, true],
  ])
  expect(asked.posted.filter(e => e.type === 'artifact' && e.body.dependency === 3340).map(e => e.body.port)).toEqual([3510, 3511])
  // One press for the one service: nothing more to ask.
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

for (const by of ['what runs there', 'their process'] as const) {
  test(`two services beside a page, told apart by ${by}, are two questions, one after the other`, async ($, on) => {
    // The same label in two processes (where discovery says which) is two services too.
    const related =
      by === 'what runs there' ? [...CONVEX, svc(3611, 'api')] : [svc(3510, 'server.js', 101), svc(3511, 'server.js', 102), svc(3512, 'server.js', 101)]
    const [first, second] =
      by === 'what runs there'
        ? ['localhost:3510 and 3511 · convex-local-backend', 'localhost:3611 · api']
        : ['localhost:3510 and 3512 · server.js', 'localhost:3511 · server.js']
    const [asksFirst, asksSecond] =
      by === 'what runs there'
        ? ['Share localhost:3510 and 3511 too? convex-local-backend, beside localhost:3340', 'Share localhost:3611 too? api, beside localhost:3340']
        : ['Share localhost:3510 and 3512 too? server.js, beside localhost:3340', 'Share localhost:3511 too? server.js, beside localhost:3340']
    const asked = world(on, { surfaces: ['terminal'], discover: { 3340: beside(related) } })
    const ui = await $.ui.mount(band('terminal'))
    await ui.press({ key: 'share' })
    await ui.press({ key: 'share-prompt' })
    const reply = JSON.stringify(await $.command.run({ command: 'share-preview', args: '3340 App' } as never))
    expect(reply).toContain(`It looks like it also uses ${first}, and ${second}: share them too from the row above the prompt, one at a time.`)
    await eventually(asked.clock, () => asked.state.hostAsk)
    expect(await hostAsked(ui)).toBe(asksFirst)
    await ui.press({ key: 'host-ask-yes' })
    await eventually(asked.clock, () => asked.state.hostAsk?.related.length === 1)
    expect(await hostAsked(ui)).toBe(asksSecond)
    const yes = by === 'what runs there' ? [3510, 3511] : [3510, 3512]
    expect(previewPosts(asked)).toEqual([[3340, true], ...yes.map(p => [p, true])])
    await ui.press({ key: 'host-ask-no' })
    await asked.clock.advance(50)
    expect(asked.state.hostMemory?.declined).toEqual([by === 'what runs there' ? 3611 : 3511])
    expect(previewPosts(asked)).toEqual([[3340, true], ...yes.map(p => [p, true])])
    expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test('Not now to a backend on two ports declines both: neither is asked about again in the room, and /share-preview says how to share each', async ($, on) => {
  const asked = world(on, { surfaces: ['terminal'], discover: { 3340: beside(CONVEX) } })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await eventually(asked.clock, () => asked.state.hostAsk)
  await ui.press({ key: 'host-ask-no' })
  await asked.clock.advance(50)
  expect(asked.state.hostMemory?.declined).toEqual([3510, 3511])
  expect(previewPosts(asked)).toEqual([[3340, true]])
  const again = JSON.stringify(await $.command.run({ command: 'share-preview', args: '3340 App' } as never))
  await asked.clock.advance(50)
  expect(again).not.toContain('from the row above the prompt')
  expect(again).toContain(
    'It looks like it also uses localhost:3510 and 3511 · convex-local-backend. You said Not now to localhost:3510 and localhost:3511 in this room; to share them, use /share-preview 3510 and /share-preview 3511.',
  )
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a port of a backend declined earlier in the room is left out of its question's words and its yes", async ($, on) => {
  const discover: Record<number, unknown> = { 3340: beside([svc(3510, 'convex-local-backend')]) }
  const asked = world(on, { surfaces: ['terminal'], discover })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await eventually(asked.clock, () => asked.state.hostAsk)
  await ui.press({ key: 'host-ask-no' })
  await asked.clock.advance(50)
  expect(asked.state.hostMemory?.declined).toEqual([3510])
  // Now it's found on its other ports as well.
  discover[3340] = beside([...CONVEX, svc(3512, 'convex-local-backend')])
  const reply = JSON.stringify(await $.command.run({ command: 'share-preview', args: '3340 App' } as never))
  expect(reply).toContain(
    'It looks like it also uses localhost:3510, 3511 and 3512 · convex-local-backend. Share localhost:3511 and 3512 too from the row above the prompt. You said Not now to localhost:3510 in this room; to share it, use /share-preview 3510.',
  )
  await eventually(asked.clock, () => asked.state.hostAsk)
  expect(await hostAsked(ui)).toBe('Share localhost:3511 and 3512 too? convex-local-backend, beside localhost:3340')
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.toasted.includes('Teammates can reach localhost:3511 and localhost:3512 now. Stop them in Room → Shown.'))
  await asked.clock.advance(50)
  expect(previewPosts(asked).filter(([port]) => port !== 3340)).toEqual([
    [3511, true],
    [3512, true],
  ])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a backend's question waiting its turn is looked at again as it's asked: a port forwarded meanwhile, or stopped (declined), is left out of it", async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const own = (port: number) => ({
    state: 'done',
    platform: 'darwin',
    target: { port, label: 'convex-local-backend', web: 'yes', devtools: false },
    related: [],
  })
  const asked = world(on, {
    stream,
    surfaces: ['terminal'],
    discover: { 3340: beside([svc(3500, 'api'), ...CONVEX, svc(3512, 'convex-local-backend')]), 3510: own(3510), 3511: own(3511) },
  })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await eventually(asked.clock, () => asked.state.hostAsk)
  expect(await hostAsked(ui)).toBe('Share localhost:3500 too? api, beside localhost:3340')
  // While api's question shows, the host shares 3510 and 3511 itself, then stops 3511.
  await $.command.run({ command: 'share-preview', args: '3510' } as never)
  await $.command.run({ command: 'share-preview', args: '3511' } as never)
  await asked.clock.advance(50)
  const pid = asked.state.shares?.['3511']?.pid
  const echo = {
    seq: 2,
    events: [
      {
        seq: 2,
        type: 'artifact',
        ts: 900,
        from: { seat: 'host', name: 'scott', role: 'host' },
        body: { kind: 'preview', pid, port: 3511, path: '/', title: 'localhost:3511', tcp: true, host: 'localhost' },
      },
    ],
    people: PREVIEW_PEOPLE,
    ended: false,
    title: 'demo',
  }
  await deliver(asked, stream, [echo], () => asked.state.shown?.some(s => s.pid === pid))
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: `stop-preview:${pid}` })
  await eventually(asked.clock, () => asked.state.hostMemory?.declined.includes(3511))
  await ui.press({ key: 'host-ask-no' })
  // The backend's turn: 3510 forwarded, 3511 stopped, 3512 alone left to ask about.
  await eventually(asked.clock, () => asked.state.hostAsk?.related[0]?.port === 3512)
  expect(await hostAsked(ui)).toBe('Share localhost:3512 too? convex-local-backend, beside localhost:3340')
  expect(asked.state.hostAsk?.related).toEqual([{ port: 3512, label: 'convex-local-backend' }])
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.toasted.includes('Teammates can reach localhost:3512 now. Stop it in Room → Shown.'))
  await asked.clock.advance(50)
  expect(previewPosts(asked)).toEqual([
    [3340, true],
    [3510, true],
    [3511, true],
    [3512, true],
  ])
  // 3510 stays the page it was shared as; 3512 is the page's.
  expect(asked.posted.filter(e => e.type === 'artifact' && e.body.dependency === 3340).map(e => e.body.port)).toEqual([3512])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// A service on more ports than a question holds is asked about in turn,
// three ports a question, each named before anything else in its row: an
// 80-column terminal gives the words beside Share too and Not now 41
// columns, and three five-digit ports and what comes before them take 38.
const FIVE = [35100, 35101, 35102, 35103, 35104].map(port => svc(port, 'convex-local-backend', 4242))

type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }

const textOf = (node: unknown): string => (typeof node === 'string' ? node : ((node as Drawn | undefined)?.children ?? []).map(textOf).join(''))

// What a terminal `columns` wide gives a question's words, read off the row
// as drawn: less the engine's 5 at its right end (the band's `bodyColumns`),
// the row's own padding there and its gap before the buttons, the buttons
// as a terminal draws them (`[ label ]`; a plain one, its label alone) and
// the gaps between them, and what's before the words with the gap after it.
async function wordsColumns(ui: { drawn: () => Promise<unknown> }, columns = 80) {
  const row = (await ui.drawn()) as Drawn
  const [left, right] = row.children as [Drawn, Drawn]
  const [before, words] = left.children as [Drawn, Drawn]
  const buttons = (right.children as Drawn[]).map(b => (b.props?.plain ? String(b.props.label).length : `[ ${String(b.props?.label)} ]`.length))
  const gap = (box: Drawn) => Number(box.props?.gap ?? 0)
  const width =
    columns -
    5 -
    Number(row.props?.paddingRight ?? 0) -
    gap(row) -
    buttons.reduce((a, b) => a + b, 0) -
    gap(right) * (buttons.length - 1) -
    textOf(before).length -
    gap(left)
  return { width, words: textOf(words), before: textOf(before) }
}

test('a service on five ports is asked about three ports a question, each port first and inside what an 80-column terminal gives the words: each Share too forwards its own', async ($, on) => {
  const asked = world(on, { surfaces: ['terminal'], discover: { 3340: beside(FIVE) } })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  const reply = JSON.stringify(await $.command.run({ command: 'share-preview', args: '3340 App' } as never))
  // The reply names the questions as the row asks them.
  expect(reply).toContain(
    'It looks like it also uses localhost:35100, 35101, 35102, 35103 and 35104 · convex-local-backend. Share localhost:35100, 35101 and 35102, and localhost:35103 and 35104 too from the row above the prompt, one at a time.',
  )
  const questions = [
    {
      ports: [35100, 35101, 35102],
      words: 'Share localhost:35100, 35101 and 35102 too? convex-local-backend, beside localhost:3340',
      said: 'Teammates can reach localhost:35100, localhost:35101 and localhost:35102 now. Stop them in Room → Shown.',
    },
    {
      ports: [35103, 35104],
      words: 'Share localhost:35103 and 35104 too? convex-local-backend, beside localhost:3340',
      said: 'Teammates can reach localhost:35103 and localhost:35104 now. Stop them in Room → Shown.',
    },
  ]
  const forwarded: number[] = []
  for (const { ports, words, said } of questions) {
    await eventually(asked.clock, () => asked.state.hostAsk?.related[0]?.port === ports[0])
    expect(asked.state.hostAsk?.related.map(s => s.port)).toEqual(ports)
    const drawn = await wordsColumns(ui)
    expect(drawn.before).toBe('●')
    expect(drawn.width).toBe(46)
    expect(drawn.words).toBe(words)
    // Every port the yes forwards, before anything a narrow row cuts.
    expect(drawn.words.indexOf(' too?')).toBeLessThanOrEqual(drawn.width)
    await ui.press({ key: 'host-ask-yes' })
    await eventually(asked.clock, () => asked.toasted.includes(said))
    forwarded.push(...ports)
    await asked.clock.advance(50)
    expect(previewPosts(asked)).toEqual([[3340, true], ...forwarded.map(p => [p, true])])
  }
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a terminal's question while the room reconnects says so by its dot alone, so its words keep their columns: no port of it is cut", async ($, on) => {
  const asked = world(on, { surfaces: ['terminal'], down: true, discover: { 3340: beside(FIVE) } })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  expect(await within(asked.clock, () => asked.state.connection === 'reconnecting', 20_000)).toBe(true)
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await eventually(asked.clock, () => asked.state.hostAsk)
  const drawn = await wordsColumns(ui)
  expect(drawn.before).toBe('●')
  expect(await ui.find({ type: 'Text', text: '●' })).toMatchObject({ props: { color: 'warning' } })
  expect(drawn.width).toBe(46)
  expect(drawn.words).toBe('Share localhost:35100, 35101 and 35102 too? convex-local-backend, beside localhost:3340')
  expect(drawn.words.indexOf(' too?')).toBeLessThanOrEqual(drawn.width)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// Every page waiting to be shared through its link, said yes to, a question at a time.
async function allowShows(asked: ReturnType<typeof world>, ui: { press: (q: { key: string }) => Promise<unknown> }) {
  for (;;) {
    await asked.clock.advance(50)
    if (asked.state.hostAsk?.kind !== 'show') return
    await ui.press({ key: 'host-ask-yes' })
  }
}

test('discovery leaves out a page shared through its link: it is never offered as what another page uses', async ($, on) => {
  const DOCS = {
    state: 'done',
    platform: 'darwin',
    target: { port: 3341, label: 'docs', web: 'yes', devtools: false },
    related: [{ port: 3340, label: 'next-server', web: 'yes', devtools: false }],
  }
  const { asked, ui } = await sharingLink($, on, 'http://localhost:3340/', { surfaces: ['desktop'], discover: { 3341: DOCS } })
  const reply = await $.command.run({ command: 'share-preview', args: '3341 Docs' } as never)
  expect(asked.discovered.find(d => d.port === 3341)?.exclude).toEqual([3340])
  expect(JSON.stringify(reply)).not.toContain('also uses')
  await asked.clock.advance(50)
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  expect(asked.posted.filter(e => e.type === 'artifact' && e.body.port === 3340).every(e => e.body.dependency === undefined && e.body.tcp === undefined)).toBe(
    true,
  )
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a guest's window needing a page shared through its link forwards it as that page, never as a dependency", async ($, on) => {
  const NEXT = { 3340: { state: 'done', platform: 'darwin', target: { port: 3340, label: 'next-server', web: 'yes', devtools: false }, related: [] } }
  const { asked, stream, ui } = await sharingLink($, on, 'http://127.0.0.1:3340/dash', { surfaces: ['desktop'], discover: NEXT })
  stream.push(LINKED('/dash'))
  await within(asked.clock, () => asked.state.shown?.some(s => s.pid === 'pv1'), 5_000)
  stream.splice(1)
  await deliver(asked, stream, [needLine(3340)], () => asked.state.hostAsk)
  expect(await ui.find({ type: 'Text', text: "'s preview needs localhost:3340 · next-server" })).toBeDefined()
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact' && e.body.port === 3340 && e.body.tcp === true))
  const forwarded = asked.posted.find(e => e.type === 'artifact' && e.body.port === 3340 && e.body.tcp === true)!.body
  expect(forwarded).toMatchObject({ kind: 'preview', pid: 'pv1', title: 'localhost:3340', path: '/dash', host: '127.0.0.1', tcp: true })
  expect(forwarded.dependency).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// A port another shared session's preview holds on this computer (a guest's
// listener its Open started, one of the plugin's own helpers): never shared
// on, whoever asks, and refused at connection time once it holds a port
// shared before. Discovery's owner mode says who holds it (`holders`).
const RELAYED_SAID = (port: number) => `localhost:${port} is another shared session's preview forwarded to this computer, so it can't be shared on.`

const RELAYED_NOW = (port: number) =>
  `Teammates' connections to localhost:${port} are refused: it's another shared session's preview forwarded to this computer now, so it can't be shared on. Stop it in Room → Shown.`

test("/share-preview of a port another session's preview holds here shares nothing and says why; the look is kept a while", async ($, on) => {
  const asked = world(on, { surfaces: ['desktop'], holders: { 3340: true }, discover: { 3340: DISCOVERED } })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  expect(await $.command.run({ command: 'share-preview', args: '3340 App' } as never)).toEqual({ text: RELAYED_SAID(3340) })
  await asked.clock.advance(50)
  expect(asked.owners).toEqual([expect.objectContaining({ port: 3340, owner: true, deadlineMs: 2000 })])
  expect(asked.sent.filter(x => x.path.endsWith('/previews'))).toHaveLength(0)
  expect(asked.posted.some(e => e.type === 'artifact' && e.body.port === 3340)).toBe(false)
  expect(asked.state.shares?.['3340']).toBeUndefined()
  // Nothing beside it is looked for or asked about.
  expect(asked.discovered).toHaveLength(0)
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  // Asked again soon after: the same answer, from the look already made.
  expect(await $.command.run({ command: 'share-preview', args: '3340' } as never)).toEqual({ text: RELAYED_SAID(3340) })
  expect(asked.owners).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("Claude giving out a port another session's preview holds here shares nothing and says nothing; a later mention looks again", async ($, on) => {
  const holders: Record<number, boolean> = { 3340: true }
  const stream: unknown[] = [{ seq: 1, events: [], people: HOST_ONLY, ended: false, title: 'demo' }]
  const asked = world(on, { stream, holders, surfaces: ['desktop'] })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  const mention = (uuid: string) =>
    $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Running at http://localhost:3340/' }] },
      door: 'response',
      origin: { kind: 'composer' },
      uuid,
    } as never)
  await mention('a1')
  await eventually(asked.clock, () => asked.owners.length)
  await asked.clock.advance(200)
  expect(asked.sent.filter(x => x.path.endsWith('/previews'))).toHaveLength(0)
  expect(asked.posted.some(e => e.type === 'artifact' && e.body.port === 3340)).toBe(false)
  // Not even probed: through it, the other session's app would answer.
  expect(asked.spawned.some(s => s.input?.startsWith('r=$(curl '))).toBe(false)
  expect(asked.toasted.filter(t => t.includes('3340'))).toEqual([])
  // Neither declined nor stopped: the host's own say is untouched.
  expect(asked.state.hostMemory?.declined ?? []).toEqual([])
  expect(asked.state.hostMemory?.stopped ?? []).toEqual([])
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  // The guest's listener gone and the host's own app there now: the next mention asks, and shares it.
  holders[3340] = false
  await asked.clock.advance(31_000)
  await mention('a2')
  await allowShow(asked, ui)
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact' && e.body.port === 3340))
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body)).toEqual([{ port: 3340, title: 'localhost:3340' }])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("Claude opening a page another session's preview holds here in the browser pane shares nothing and says nothing", async ($, on) => {
  const holders: Record<number, boolean> = { 3340: true }
  const asked = world(on, { surfaces: ['desktop'], holders, stream: [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }] })
  on('tool.call', { tool: 'mcp__Claude_Browser__navigate' }, () => ({ result: [], text: 'navigated' }) as never)
  on('tool.call', { tool: 'mcp__Claude_Browser__browser_batch' }, () => ({ result: [], text: 'done' }) as never)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'http://localhost:3340/app' } as never)
  await $.tool.call({ tool: 'mcp__Claude_Browser__browser_batch', actions: [{ name: 'navigate', input: { url: 'http://localhost:3340/' } }] } as never)
  await eventually(asked.clock, () => asked.owners.length)
  await asked.clock.advance(200)
  expect(asked.sent.filter(x => x.path.endsWith('/previews'))).toHaveLength(0)
  expect(asked.posted.some(e => e.type === 'artifact' && e.body.port === 3340)).toBe(false)
  expect(asked.toasted.filter(t => t.includes('3340'))).toEqual([])
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  // Something else there now: the next open asks, and shares it.
  holders[3340] = false
  await asked.clock.advance(31_000)
  await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'http://localhost:3340/app' } as never)
  await allowShow(asked, ui)
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact' && e.body.port === 3340))
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body.port)).toEqual([3340])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("Share too for a port another session's preview holds now forwards nothing, and says why", async ($, on) => {
  const holders: Record<number, boolean> = {}
  const asked = world(on, { surfaces: ['desktop'], holders, discover: { 3340: DISCOVERED } })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact' && e.body.port === 3340))
  expect(await ui.find({ type: 'Text', text: 'Share localhost:3610 too? convex-local-backend, beside localhost:3340' })).toBeDefined()
  // While the question waits, another session's Open takes localhost:3610 here.
  holders[3610] = true
  await asked.clock.advance(6_000)
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.toasted.includes(RELAYED_SAID(3610)))
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body.port)).toEqual([3340])
  expect(asked.posted.some(e => e.type === 'artifact' && e.body.port === 3610)).toBe(false)
  expect(asked.toasted.some(t => t.startsWith('Teammates can reach localhost:3610'))).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a guest's window needing a port another session's preview holds here asks the host nothing; one held after the question is never forwarded by its Share", async ($, on) => {
  const holders: Record<number, boolean> = { 3610: true }
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = world(on, { stream, surfaces: ['desktop'], discover: NEEDS, holders })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  await deliver(asked, stream, [needLine(3610)], () => asked.owners.length)
  await asked.clock.advance(50)
  expect(await ui.find({ key: 'host-ask-yes' })).toBeUndefined()
  expect(asked.needLooks).toHaveLength(1)
  expect(asked.discovered).toHaveLength(0)
  expect(asked.state.hostMemory?.askedAt?.['3610']).toBeUndefined()
  // Nothing holds it later: the next need asks; the Share comes after another session's Open took it.
  holders[3610] = false
  await asked.clock.advance(31_000)
  await deliver(asked, stream, [needLine(3610)], () => asked.needLooks.length === 2)
  await eventually(asked.clock, async () => Boolean(await ui.find({ key: 'host-ask-yes' })))
  holders[3610] = true
  await asked.clock.advance(6_000)
  await ui.press({ key: 'host-ask-yes' })
  await eventually(asked.clock, () => asked.toasted.includes(RELAYED_SAID(3610)))
  expect(asked.sent.filter(x => x.path.endsWith('/previews'))).toHaveLength(0)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("Allow forwarding of a page whose port another session's preview holds now forwards nothing, and says why", async ($, on) => {
  const holders: Record<number, boolean> = {}
  const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/', { holders })
  await deliver(asked, stream, [LINKED()], () => asked.state.shown?.some(s => s.pid === 'pv1'))
  holders[3340] = true
  await asked.clock.advance(6_000)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'forward-preview:pv1' })
  await eventually(asked.clock, () => asked.toasted.includes(RELAYED_SAID(3340)))
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body)).toEqual([{ port: 3340, title: 'localhost:3340' }])
  expect(asked.state.shares?.['3340']?.tcp).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a forwarded port another session's preview holds now: teammates' TCP connections are refused CONNECT, one look for a burst, said to the host once", async ($, on) => {
  const holders: Record<number, boolean> = {}
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = world(on, { stream, tcpRelays: true, holders })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  expect(asked.state.shares?.['3340']).toMatchObject({ pid: 'pv1', tcp: true })
  // The host's own app stopped, and an Open of another session's preview took the number.
  holders[3340] = true
  await asked.clock.advance(6_000)
  const looks = asked.owners.length
  const refused = (id: string) => asked.spawned.filter(s => s.argv[0] === 'curl' && s.input?.includes(`/ws/${id}/reject"`))
  await deliver(
    asked,
    stream,
    [{ tcp: { id: 'connection0001', pid: 'pv1', port: 3340 } }, { tcp: { id: 'connection0002', pid: 'pv1', port: 3340 } }],
    () => refused('connection0001').length && refused('connection0002').length,
  )
  expect(refused('connection0001')[0]!.input).toContain('data = "{\\"code\\":\\"CONNECT\\"}"')
  expect(asked.owners.length - looks).toBe(1)
  expect(asked.tcpHelpers).toHaveLength(0)
  expect(asked.sent.filter(x => x.body.op === 'open')).toHaveLength(0)
  await deliver(asked, stream, [{ tcp: { id: 'connection0003', pid: 'pv1', port: 3340 } }], () => refused('connection0003').length)
  expect(asked.toasted.filter(t => t === RELAYED_NOW(3340))).toHaveLength(1)
  // The share stands: Stop is the host's.
  expect(asked.state.shares?.['3340']).toMatchObject({ pid: 'pv1', tcp: true })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// A share's "not a helper" stands 5 s for shares, a second at a connection:
// an Open that took the number just after the share's look is seen.
test("a port an Open took just after it was shared: the next teammate's TCP connection looks again and is refused", async ($, on) => {
  const holders: Record<number, boolean> = { 3340: false }
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = world(on, { stream, tcpRelays: true, holders })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  expect(asked.state.shares?.['3340']).toMatchObject({ pid: 'pv1', tcp: true })
  expect(asked.owners).toHaveLength(1)
  holders[3340] = true
  await asked.clock.advance(2_000)
  const refused = () => asked.spawned.filter(s => s.argv[0] === 'curl' && s.input?.includes('/ws/connection0001/reject"'))
  await deliver(asked, stream, [{ tcp: { id: 'connection0001', pid: 'pv1', port: 3340 } }], () => refused().length)
  expect(asked.owners).toHaveLength(2)
  expect(asked.tcpHelpers).toHaveLength(0)
  expect(asked.toasted.filter(t => t === RELAYED_NOW(3340))).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a page shared through its link whose port another session's preview holds now: its requests get a page saying so, its sockets are refused, nothing is fetched", async ($, on) => {
  const holders: Record<number, boolean> = {}
  const { asked, stream } = await sharingLink($, on, 'http://localhost:3340/', { holders, wsRelays: true })
  holders[3340] = true
  await asked.clock.advance(6_000)
  await deliver(asked, stream, [proxyAsk(1)], () => proxyPages(asked).length === 1)
  expect(asked.proxyFetches).toHaveLength(0)
  const said = proxyPages(asked)[0]!.input!
  expect(said).toContain('\\"status\\":403')
  expect(said).toContain('another shared session')
  expect(said).toMatch(/forwarded to [^ ]+ computer, so it can/)
  const refusals = () => asked.spawned.filter(s => s.argv[0] === 'curl' && s.input?.includes('/ws/socket00000001/reject"'))
  await deliver(asked, stream, [{ ws: { id: 'socket00000001', pid: 'pv1', port: 3340, path: '/', protocols: [] } }], () => refusals().length)
  expect(refusals()[0]!.input).toContain('data = "{\\"code\\":\\"CONNECT\\"}"')
  expect(asked.wsRelays).toHaveLength(0)
  expect(asked.toasted.filter(t => t === RELAYED_NOW(3340))).toHaveLength(1)
  expect(asked.state.shares?.['3340']?.pid).toBe('pv1')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

for (const look of ["can't tell", 'finds something else there'] as const) {
  test(`a share whose look at who holds the port ${look} goes on as before`, async ($, on) => {
    const asked = world(on, look === "can't tell" ? {} : { holders: { 3340: false } })
    const ui = await $.ui.mount(band('desktop'))
    await ui.press({ key: 'share' })
    await ui.press({ key: 'share-prompt' })
    expect(await $.command.run({ command: 'share-preview', args: '3340 App' } as never)).toEqual({
      text: 'Teammates can reach localhost:3340 now. Stop it in Room → Shown.',
    })
    expect(asked.owners).toHaveLength(1)
    expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body)).toEqual([{ port: 3340, title: 'App', tcp: true }])
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test("a port the host stopped isn't shared again for Claude's mention of it; the host's own share is", async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: HOST_ONLY, ended: false, title: 'demo' }]
  const asked = world(on, { stream })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await stopInRoom($, asked, stream)
  const shares = () => asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body)
  expect(shares()).toEqual([{ port: 3340, title: 'App', tcp: true }])
  // Claude names it again: it isn't even looked at.
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Running again at http://localhost:3340/' }] },
    door: 'response',
    origin: { kind: 'composer' },
    uuid: 'a1',
  } as never)
  await asked.clock.advance(200)
  expect(shares()).toHaveLength(1)
  expect(asked.spawned.some(s => s.input?.startsWith('r=$(curl '))).toBe(false)
  expect(asked.state.hostMemory?.stopped).toEqual([3340])
  // The host's own share stands, and the mark goes.
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await asked.clock.advance(50)
  expect(shares()).toHaveLength(2)
  expect(asked.state.hostMemory?.stopped).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// What a look at a port's `/` prints (`lookAtPage`): its exit, status and type, then `/json/version`'s answer.
const pageSays = (code: string, version = '') => `exit=0\ncode=${code}\n--\n${version}\n`

const INSPECTOR = '{"Browser":"node.js/v24.1.0","Protocol-Version":"1.1"}'

test("a mention shares a page, never an API's JSON, its 404 or a debugger; a server error is looked at again", async ($, on) => {
  const pages: Record<number, string> = {
    4000: pageSays('200 application/json', '{"ok":true}'),
    4001: pageSays('404 text/html', 'Cannot GET /json/version'),
    4002: pageSays('200 text/html; charset=utf-8', '<!doctype html>'),
    4003: pageSays('400 text/html; charset=UTF-8', INSPECTOR),
    4004: pageSays('302 '),
    4005: pageSays('500 text/html'),
    4006: pageSays('200 text/html', '{"webSocketDebuggerUrl":"ws://localhost:4006/devtools/browser/x"}'),
  }
  const asked = world(on, { pages, surfaces: ['desktop'], stream: [{ seq: 1, events: [], people: HOST_ONLY, ended: false, title: 'demo' }] })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  const say = async (text: string, uuid: string) => {
    await $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
      door: 'response',
      origin: { kind: 'composer' },
      uuid,
    } as never)
    await asked.clock.advance(300)
  }
  const shared = () => asked.sent.filter(x => x.path.endsWith('/previews')).map(x => (x.body as { port: number }).port)
  await say('API http://localhost:4000/api/items, http://localhost:4001/, web http://localhost:4002/', 'a1')
  await say('Debugger http://localhost:4003/, login http://localhost:4004/, http://localhost:4005/ and http://localhost:4006/', 'a2')
  // The pages are put to the host, in turn; nothing else is.
  expect(shared()).toEqual([])
  await allowShows(asked, ui)
  expect(shared()).toEqual([4002, 4004])
  // Asked at `/` alone, as a browser asks for a page: never the path Claude gave out.
  const probes = asked.spawned.filter(x => x.input?.startsWith('r=$(curl '))
  expect(probes.some(x => x.input?.includes('/api/items'))).toBe(false)
  expect(probes.find(x => x.input?.includes("localhost:4000/')"))?.input).toContain("-H 'Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'")
  // Mentioned again: the API and the debugger aren't looked at again; the failing server is, and shared once it's a page.
  const before = probes.length
  pages[4005] = pageSays('200 text/html')
  await say('http://localhost:4000/ http://localhost:4003/ http://localhost:4005/', 'a3')
  await allowShows(asked, ui)
  expect(asked.spawned.filter(x => x.input?.startsWith('r=$(curl ')).length).toBe(before + 1)
  expect(shared()).toEqual([4002, 4004, 4005])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("an app at a base path is shared at the page Claude gave out; an API's \"Cannot GET /\" isn't, and `/` alone isn't asked twice", async ($, on) => {
  const pages: Record<string, string> = {
    4100: pageSays('404 text/html', 'nope'),
    '4100/app/dash': pageSays('200 text/html'),
    4101: pageSays('404 text/html; charset=utf-8', 'Cannot GET /json/version'),
    '4101/api/items': pageSays('200 application/json', '[]'),
    4102: pageSays('404 text/html'),
  }
  const asked = world(on, { pages, surfaces: ['desktop'], stream: [{ seq: 1, events: [], people: HOST_ONLY, ended: false, title: 'demo' }] })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  const text = 'App: http://localhost:4100/app/dash\nAPI: http://localhost:4101/api/items\nAnd http://localhost:4102/'
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
    door: 'response',
    origin: { kind: 'composer' },
    uuid: 'a1',
  } as never)
  await asked.clock.advance(300)
  await allowShows(asked, ui)
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => (x.body as { port: number }).port)).toEqual([4100])
  expect(asked.posted.find(e => e.type === 'artifact')?.body).toMatchObject({ kind: 'preview', port: 4100, path: '/app/dash' })
  expect(asked.looks).toEqual(['4100/', '4100/app/dash', '4101/', '4101/api/items', '4102/'])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a page Claude opens is shared whatever it is, but never a debugger, nor once the host stopped it', async ($, on) => {
  const pages = { 4000: pageSays('200 application/json', '{"ok":true}'), 4003: pageSays('400 text/html', INSPECTOR) }
  const stream: unknown[] = [{ seq: 1, events: [], people: HOST_ONLY, ended: false, title: 'demo' }]
  const asked = world(on, { pages, stream, surfaces: ['desktop'] })
  on('tool.call', { tool: 'mcp__Claude_Browser__navigate' }, () => ({ result: [], text: 'navigated' }) as never)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  const open = async (url: string) => {
    await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url } as never)
    await asked.clock.advance(300)
  }
  const shared = () => asked.sent.filter(x => x.path.endsWith('/previews')).map(x => (x.body as { port: number }).port)
  // Stopped by the host: opening it again doesn't share it again.
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await stopInRoom($, asked, stream)
  await open('http://localhost:3340/')
  expect(shared()).toEqual([3340])
  await open('http://localhost:4000/api/health')
  await open('http://localhost:4003/json/list')
  await allowShows(asked, ui)
  expect(shared()).toEqual([3340, 4000])
  expect(asked.posted.find(e => e.type === 'artifact' && e.body.port === 4000)?.body).toMatchObject({ kind: 'preview', port: 4000, path: '/api/health' })
  // Opened again at another page: shared already, so it goes out again without a look.
  const before = asked.spawned.filter(x => x.input?.startsWith('r=$(curl ')).length
  await open('http://localhost:4000/api/items')
  expect(asked.spawned.filter(x => x.input?.startsWith('r=$(curl ')).length).toBe(before)
  expect(asked.posted.filter(e => e.type === 'artifact').at(-1)?.body).toMatchObject({ port: 4000, path: '/api/items' })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// A host back from a restart takes up what it shared (its saved shares)
// and reads no history for more: a page its Claude gave out before stays
// as it was, and a port it stopped stays stopped.
test('a host back from a restart shares no page of its history again, and a port it stopped stays stopped', async ($, on) => {
  const key = 'http://localhost:8787/room0000000000000001'
  const saved = { ...savedRoom('room0000000000000001', 900), hostMemory: { room: key, declined: [3340], stopped: [3340], offered: [], askedAt: {} } }
  const history = [
    { role: 'user', content: 'Start the app' },
    { role: 'assistant', content: [{ type: 'text', text: 'Running at http://localhost:3340/ and http://localhost:3341/' }] },
  ]
  const asked = world(on, { stream: [], history, files: { [checkpointPath('hosting:session-test-0001')]: JSON.stringify({ version: 1, value: saved }) } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await asked.clock.advance(500)
  expect(asked.logged.some(l => l.startsWith('Still sharing this session'))).toBe(true)
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body.port)).toEqual([])
  expect(asked.state.hostMemory?.stopped).toEqual([3340])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a room shared Only from now on shares no dev server Claude gave out before Share, nor once reopened', async ($, on) => {
  const asked = world(on, {
    stream: [],
    transcripts: {
      [TRANSCRIPT]: [
        transcriptRow('u1', 500, 'user', 'Start the admin app'),
        transcriptRow('a1', 600, 'assistant', 'Running at http://localhost:3340/admin'),
      ].join('\n'),
    },
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start(START)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await ui.press({ key: 'share-new' })
  await asked.clock.advance(500)
  const previews = () => asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body.port)
  expect(previews()).toEqual([])
  await $.session.end({ reason: 'other', sessionId: 'session-test-0001', resume: {} } as never)
  await $.session.start(START)
  await asked.clock.advance(500)
  expect(asked.logged.some(l => l.startsWith('Still sharing this session'))).toBe(true)
  expect(previews()).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("the public link asks the host's localhost at its scheme, the guest's path as it is, as from the preview's own page", async ($, on) => {
  const headers = 'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\ncontent-type: text/html\r\nset-cookie: app=2\r\nx-name: cafÃ©\r\n\r\n'
  const { asked, stream } = await sharingLink($, on, 'https://localhost:3340/app', { proxyFetch: { status: 201, headers } })
  const browser = [
    ['Origin', 'https://preview.test'],
    ['Referer', 'https://preview.test/app?x=1'],
    ['cookie', 'app=1'],
  ]
  await deliver(
    asked,
    stream,
    [proxyAsk(1, { method: 'POST', path: '/a/[1-100000000]?q={a,b}', headers: browser, body: btoa('x=1') })],
    () => proxyAnswers(asked).length,
  )
  const fetch = asked.proxyFetches[0]!.input.split('\n')
  expect(fetch).toContain('url = "https://localhost:3340/a/[1-100000000]?q={a,b}"')
  // One request, never curl's pattern of a hundred million; a TLS dev
  // server's own certificate; nothing past what the room takes.
  expect(fetch).toContain('globoff')
  expect(fetch).toContain('insecure')
  expect(fetch).toContain('max-filesize = 20000000')
  // Every curl to the room takes its address as it is, the stream's too.
  expect(asked.spawned.find(s => s.argv[0] === 'curl' && s.input?.includes('/stream?after='))?.input?.split('\n')).toContain('globoff')
  expect(fetch).toContain('request = "POST"')
  // As from the preview's own page, at the host's address.
  expect(fetch).toContain('header = "Origin: https://localhost:3340"')
  expect(fetch).toContain('header = "Referer: https://localhost:3340/app?x=1"')
  expect(fetch).toContain('header = "cookie: app=1"')
  expect(fetch.join('\n')).not.toContain('preview.test')
  expect(fetch).toContain(`printf '%s' '${btoa('x=1')}' | base64 --decode > "$d/body" 2>/dev/null || : > "$d/body"`)
  // The last response's status and headers in the body's first line, each byte kept.
  const answer = proxyAnswers(asked)[0]!.input!.split('\n')
  expect(answer).toContain("d='/tmp/cs-proxy.Fetch001'")
  expect(answer).toContain('url = "http://localhost:8787/api/rooms/room0000000000000002/proxy/proxyask00000001"')
  expect(answer).toContain('globoff')
  expect(answer).toContain('max-time = 60')
  expect(answer).toContain('{"status":201,"headers":[["content-type","text/html"],["set-cookie","app=2"],["x-name","caf\\u00c3\\u00a9"]]}')
  expect(answer).toContain('cat "$d/pre" "$d/b" | curl -K "$d/up" -X POST --data-binary @- -o /dev/null & c=$!')
  expect(answer.some(l => l.includes('x-proxy-'))).toBe(false)
  expect(proxyPages(asked)).toHaveLength(0)
  // What the preview's server speaks is kept with its share, apart from Shown, and goes with the room.
  expect(asked.state.shares).toEqual({ '3340': { pid: 'pv1', scheme: 'https' } })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  expect(asked.state.shares).toEqual({})
})
