// What the host's Claude shows, and previews on a guest's computer: their
// listeners, ports and TCP workers.

import { expect, test } from 'claude-code/testing'
import { LINK, band, world, eventually, PANE, PREVIEW_PEOPLE, LOCAL_SHOWN, START, checkpointPath, savedAt, STEP, tunnels, allowShow } from './support/world'

test('a host who keeps what Claude shows sends nothing', async ($, on) => {
  const asked = world(on)
  on('tool.call', { tool: 'SendUserFile' }, () => ({ result: { attachments: [] }, text: 'ok' }) as never)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-settings' })
  await pane.select({ key: 'policy-files', value: 'off' })
  await $.tool.call({ tool: 'SendUserFile', files: ['chart.html'], display: 'render', status: 'normal' } as never)
  await asked.clock.advance(200)
  expect(asked.posted.some(e => e.type === 'artifact')).toBe(false)
})

// A session whose Claude took a screenshot: a call, its result as the
// transcript keeps it (an image block, then text), and words after it.
const SHOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

const SHOT_HISTORY = [
  { role: 'user', content: 'Show me the course page' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_shot1', name: 'mcp__Claude_Browser__computer', input: { action: 'screenshot' } }] },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_shot1',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SHOT } },
          { type: 'text', text: 'Took a screenshot' },
        ],
      },
    ],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'Here is the course page.' }] },
]

test("a screenshot the host's Claude took goes to the room as a file, named on its row, in order", async ($, on) => {
  const asked = world(on, { history: SHOT_HISTORY })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await ui.press({ key: 'share-all' })
  await asked.clock.advance(200)
  const upload = asked.spawned.find(s => s.argv[0] === '/bin/sh' && s.input?.includes('content-type: image/png'))
  expect(upload?.input).toContain('base64 -d')
  expect(upload?.input).toContain(SHOT.slice(0, 40))
  expect(upload?.input).not.toContain("Bearer t'") // the token goes in curl's config on stdin
  const rows = asked.posted.filter(e => e.type === 'row')
  const shot = rows.find(e => e.body.id === 'toolu_shot1' && e.body.kind === 'result')
  expect(shot?.body.text).toBe('Took a screenshot')
  expect(shot?.body.images).toEqual([{ id: 'a'.repeat(64), type: 'image/png', size: 68 }])
  expect('media' in (shot?.body ?? {})).toBe(false) // the bytes go as a file, never in a row
  // What came after it waited for it.
  expect(rows.map(e => e.body.kind)).toEqual(['user', 'tool', 'result', 'assistant'])
})

test('a guest sees what the host showed in the Room, with Open', async ($, on) => {
  const people = [
    { id: 'host', name: 'Sam', role: 'host', online: true },
    { id: 'seat1', name: 'scott', role: 'guest', online: true },
  ]
  const shown = {
    seq: 2,
    type: 'artifact',
    ts: 900,
    from: { seat: 'host', name: 'Sam', role: 'host' },
    body: { kind: 'send', files: [{ id: 'f'.repeat(64), name: 'chart.html', type: 'text/html', size: 42 }], display: 'render' },
  }
  const asked = world(on, { stream: [{ seq: 2, events: [shown], people, ended: false, title: 'demo' }] })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect((await pane.find({ key: 'tab-shown' }))?.props.label).toBe('Shown 1')
  await pane.press({ key: 'tab-shown' })
  expect(await pane.find({ type: 'Text', text: /chart\.html/ })).toBeDefined()
  expect(await pane.find({ key: 'open-seq:2' })).toBeDefined()
})

test("a guest opens localhost in Claude's browser only after the helper is ready, at the host's number; Public link is a separate choice", async ($, on) => {
  const asked = world(on, { localPreview: 'wait', stream: [{ seq: 2, events: [LOCAL_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }] })
  const urls: string[] = []
  on('mcp.call', ($, e) => {
    if (e.server === 'Claude_Browser' && e.tool === 'preview_start') urls.push(String(e.args?.url))
    return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } } as never
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await pane.press({ key: 'open-preview:pv-local' }) // a second press while it starts opens nothing more
  await eventually(asked.clock, () => asked.localHelpers.length)
  expect(asked.localHelpers).toHaveLength(1)
  expect(asked.externals).toHaveLength(0)
  expect(urls).toHaveLength(0)
  asked.localHelpers[0]!.send({ state: 'ready', port: 3340 })
  await eventually(asked.clock, () => urls.length)
  await asked.clock.advance(20)
  // Claude's browser, Claude Desktop's default (it took the call), once; not the person's own.
  expect(urls).toEqual(['http://localhost:3340/login?next=%2Faccount'])
  expect(asked.externals).toHaveLength(0)
  expect(tunnels(asked)).toHaveLength(1)
  const spawn = asked.spawned.find(s => s.argv.at(-1)?.endsWith('/relay/local-preview.mts'))!
  expect(JSON.parse(spawn.input!).port).toBe(3340)
  // The seat's token, on stdin alone: no grant is asked for, and argv carries none.
  expect(JSON.parse(spawn.input!).token).toBe('g')
  expect(Object.keys(JSON.parse(spawn.input!)).sort()).toEqual(['port', 'strict', 'token', 'url'])
  expect(JSON.stringify(spawn.argv)).not.toMatch(/ticket=|"g"/)
  expect(asked.filter(a => a.endsWith('/tunnel'))).toHaveLength(0)
  // The host's own number, or nothing: a page that moves loses its sign-ins.
  expect(JSON.parse(spawn.input!).strict).toBe(true)
  // Said once: what the first preview at the host's numbers here costs.
  expect(asked.toasted.filter(t => t.startsWith("Opened Sam's localhost:3340"))).toEqual([
    "Opened Sam's localhost:3340 in Claude's browser. While you're in the room, localhost:3340 here reaches Sam's, your cookies for it included; Close in Room → Shown, or Leave, frees it.",
  ])
  await pane.press({ key: 'public-preview:pv-local' })
  await eventually(asked.clock, () => urls.length === 2)
  expect(urls[1]).toContain('https://preview.test/__share/enter?')
  expect(asked.copied).toHaveLength(0)
  expect(asked.filter(a => a.endsWith('/ticket'))).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  expect(asked.localHelpers[0]!.stopped).toBe(true)
})

test('with no window possible and the host port taken here, the page opens on a free port, and one note says what that costs', async ($, on) => {
  const asked = world(on, {
    localPreviewByPid: { 'pv-local': { taken: [3340], port: 44321 } },
    env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
    stream: [{ seq: 2, events: [LOCAL_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'terminal', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length)
  expect(asked.externals).toEqual(['http://localhost:44321/login?next=%2Faccount'])
  // The host's number first, exactly; taken, then any free port.
  expect(tunnels(asked).map(t => [t.port, t.strict])).toEqual([
    [3340, true],
    [3340, false],
  ])
  await asked.clock.advance(20)
  const mapping = await pane.find({ type: 'Text', text: "localhost:44321 here → Sam's localhost:3340" })
  expect(mapping?.text).toBe("localhost:44321 here → Sam's localhost:3340")
  expect(asked.toasted.filter(t => t.startsWith("Sam's preview opened"))).toEqual([
    "Sam's preview opened at localhost:44321 here, not localhost:3340, which is in use on this computer, so sign-ins registered for localhost:3340 won't work. A separate window would keep Sam's addresses, but preview windows work on macOS and Linux.",
  ])
  expect(asked.toasted.some(t => t.includes('Fixed OAuth callbacks'))).toBe(false)
  expect(asked.filter(a => a.endsWith('/ticket'))).toHaveLength(0)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

for (const invalid of [0, 65536]) {
  test(`a helper reporting invalid port ${invalid} never opens a local address`, async ($, on) => {
    const asked = world(on, {
      localPreview: 'wait',
      env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
      stream: [{ seq: 2, events: [LOCAL_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
    })
    await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
    await asked.clock.advance(10)
    const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'terminal', component: 'Pane', requestId: 'shared-room', props: PANE })
    await pane.press({ key: 'tab-shown' })
    await pane.press({ key: 'open-preview:pv-local' })
    await eventually(asked.clock, () => asked.localHelpers.length)
    asked.localHelpers[0]!.send({ state: 'ready', port: invalid })
    await eventually(asked.clock, () => asked.localHelpers[0]!.stopped)
    expect(asked.copied).toHaveLength(0)
    expect(asked.toasted.some(t => t.includes('valid listening port'))).toBe(true)
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test('Open while the host is offline binds nothing and says so, and never falls back to the public link', async ($, on) => {
  const offline = [{ ...PREVIEW_PEOPLE[0]!, online: false }, PREVIEW_PEOPLE[1]!]
  const asked = world(on, { env: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, stream: [{ seq: 2, events: [LOCAL_SHOWN], people: offline, ended: false, title: 'demo' }] })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'terminal', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.toasted.some(t => t.includes('is offline')))
  expect(asked.toasted).toContain("Sam is offline, so their previews can't open now. Press Open again once they're back.")
  expect(asked.localHelpers).toHaveLength(0)
  expect(asked.copied).toHaveLength(0)
  expect(asked.filter(a => a.endsWith('/ticket'))).toHaveLength(0)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

for (const [failure, message] of [
  ['busy', /localhost:3340 is already in use/],
  ['missing', /need Node/],
] as const) {
  test(`a ${failure} localhost helper reports the problem without opening a public preview`, async ($, on) => {
    const asked = world(on, {
      localPreview: failure,
      env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
      stream: [{ seq: 2, events: [LOCAL_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
    })
    await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
    await asked.clock.advance(10)
    const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'terminal', component: 'Pane', requestId: 'shared-room', props: PANE })
    await pane.press({ key: 'tab-shown' })
    await pane.press({ key: 'open-preview:pv-local' })
    await eventually(asked.clock, () => asked.toasted.some(t => message.test(t)))
    expect(asked.toasted.some(t => message.test(t))).toBe(true)
    expect(asked.externals).toHaveLength(0)
    // In use: the host's number, then (no window here) any other port, both refused.
    expect(tunnels(asked)).toHaveLength(failure === 'busy' ? 2 : 1)
  })
}

test('a channel failure keeps the listener and its port; success clears its transient warning', async ($, on) => {
  const asked = world(on, {
    env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
    stream: [{ seq: 2, events: [LOCAL_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'terminal', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length)
  const helper = asked.localHelpers[0]!
  const output = Array.from({ length: 200 }, () => JSON.stringify({ state: 'channel-error', code: 'CONNECT' })).join('\n') + '\n'
  expect(output.length > 8192).toBe(true)
  helper.output(output)
  helper.send({ state: 'channel-error', code: 'TIMEOUT' })
  await asked.clock.advance(20)
  expect(helper.stopped).toBe(false)
  expect(await pane.find({ type: 'Text', text: /connection or request limit reached|Preview authorization was refused/ })).toBeUndefined()
  helper.send({ state: 'channel-error', code: 'BUSY' })
  helper.send({ state: 'channel-error', code: 'BUSY' })
  await asked.clock.advance(20)
  expect(asked.toasted.filter(t => t.includes('connection or request limit reached'))).toHaveLength(1)
  expect((await pane.find({ type: 'Text', text: /connection or request limit reached|Preview authorization was refused/ }))?.text).toContain(
    'connection or request limit reached',
  )
  expect((await pane.find({ type: 'Text', text: "localhost:3340 here → Sam's localhost:3340" }))?.text).toBe("localhost:3340 here → Sam's localhost:3340")
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length === 2)
  expect(asked.localHelpers).toHaveLength(1)
  expect(helper.stopped).toBe(false)
  expect(tunnels(asked)).toHaveLength(1)
  helper.send({ state: 'channel-ready' })
  await asked.clock.advance(20)
  expect(await pane.find({ type: 'Text', text: /connection or request limit reached|Preview authorization was refused/ })).toBeUndefined()
  helper.send({ state: 'channel-error', code: 'AUTH' })
  await asked.clock.advance(20)
  expect((await pane.find({ type: 'Text', text: /Preview authorization was refused/ }))?.text).toContain('Press Open')
  expect(asked.localHelpers).toHaveLength(1)
  expect(helper.stopped).toBe(false)
  expect(tunnels(asked)).toHaveLength(1)
  // Only this person's explicit retry replaces a refused authorization.
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length === 3)
  expect(asked.localHelpers).toHaveLength(2)
  expect(helper.stopped).toBe(true)
  expect(asked.localHelpers[1]!.stopped).toBe(false)
  expect(tunnels(asked)).toHaveLength(2)
  expect(asked.filter(a => a.endsWith('/ticket'))).toHaveLength(0)
  expect(new Set(asked.externals)).toEqual(new Set(['http://localhost:3340/login?next=%2Faccount']))
  expect(await pane.find({ type: 'Text', text: /connection or request limit reached|Preview authorization was refused/ })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  expect(asked.localHelpers.every(h => h.stopped)).toBe(true)
})

test('a failed or exited localhost helper redraws and restarts on Open; Leave closes it', async ($, on) => {
  const asked = world(on, {
    env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
    stream: [{ seq: 2, events: [LOCAL_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'terminal', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length)
  asked.localHelpers[0]!.send({ state: 'error', code: 'STARTUP' })
  await asked.clock.advance(20)
  expect((await pane.find({ type: 'Text', text: 'Last: localhost:3340' }))?.text).toBe("Last: localhost:3340 here → Sam's localhost:3340")
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length === 2)
  expect(asked.localHelpers).toHaveLength(2)
  expect(asked.localHelpers[0]!.stopped).toBe(true)
  asked.localHelpers[1]!.exit()
  await asked.clock.advance(5)
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length === 3)
  expect(asked.localHelpers).toHaveLength(3)
  expect(new Set(asked.externals)).toEqual(new Set(['http://localhost:3340/login?next=%2Faccount']))
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  expect(asked.localHelpers.every(h => h.stopped)).toBe(true)
})

test('a replay never forwards by itself: a forwarded preview waits for Open; one Claude mentioned opens through its link', async ($, on) => {
  const linkOnly = { ...LOCAL_SHOWN, seq: 3, body: { kind: 'preview', pid: 'pv-link', port: 3341, path: '/', title: 'Docs' } }
  const asked = world(on, { stream: [{ seq: 3, events: [LOCAL_SHOWN, linkOnly], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }] })
  on('tool.list', () => ({ value: [{ name: 'mcp__Claude_Browser__preview_start', description: 'Preview', inputSchema: { type: 'object' } }] }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  await $.turn.start({ turnId: 'join-preview', text: LINK })
  await $.turn.complete({ turnId: 'join-preview', isAborted: false, durationMs: 0, reason: 'answer' } as never)
  await asked.clock.advance(10)
  // The host chose to forward it: nothing starts here until this guest says so.
  await $.turn.start({ turnId: 'show-forwarded', text: 'Sam shared Sign in (preview)' })
  const chunks = []
  for await (const chunk of $.turn.step({ ...STEP, turnId: 'show-forwarded' } as never)) chunks.push(chunk)
  expect(chunks.some(c => c.kind === 'tool')).toBe(false)
  expect(
    chunks
      .filter(c => c.kind === 'text')
      .map(c => c.text)
      .join(''),
  ).toContain('press **Open preview** above the prompt (or **Open** in the Room) to open it at http://localhost:3340/login?next=%2Faccount')
  expect(asked.localHelpers).toHaveLength(0)
  expect(tunnels(asked)).toHaveLength(0)
  await $.turn.complete({ turnId: 'show-forwarded', isAborted: false, durationMs: 0, reason: 'answer' } as never)
  await asked.clock.advance(10)
  // Shared because Claude mentioned it: its link, on the preview's own host name.
  await $.turn.start({ turnId: 'show-link', text: 'Sam shared Docs (preview)' })
  const more = []
  for await (const chunk of $.turn.step({ ...STEP, turnId: 'show-link' } as never)) more.push(chunk)
  const call = more.find(c => c.kind === 'tool')
  expect(call?.name).toBe('mcp__Claude_Browser__preview_start')
  expect(
    JSON.parse(
      more
        .filter(c => c.kind === 'input')
        .map(c => c.json)
        .join(''),
    ).url,
  ).toContain('https://preview.test/__share/enter')
  expect(asked.localHelpers).toHaveLength(0)
  // A forwarded preview keeps Public link as an explicit choice; an HTTP-only one's Open is its link.
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-shown' })
  expect(await pane.find({ key: 'public-preview:pv-local' })).toBeDefined()
  expect(await pane.find({ key: 'public-preview:pv-link' })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("the host's own /share-preview shares a port for forwarding", async ($, on) => {
  const asked = world(on)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(50)
  const r = await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  expect(r).toEqual({ text: 'Teammates can reach localhost:3340 now. Stop it in Room → Shown.' })
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).at(-1)?.body).toEqual({ port: 3340, title: 'App', tcp: true })
  await asked.clock.advance(100)
  expect(asked.posted.find(e => e.type === 'artifact' && e.body.kind === 'preview')?.body.tcp).toBe(true)
})

for (const ending of ['leave', 'timeout'] as const) {
  test(`a localhost startup interrupted by ${ending} cannot open a stale link`, async ($, on) => {
    const asked = world(on, {
      localPreview: 'wait',
      env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
      stream: [{ seq: 2, events: [LOCAL_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
    })
    await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
    await asked.clock.advance(10)
    const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'terminal', component: 'Pane', requestId: 'shared-room', props: PANE })
    await pane.press({ key: 'tab-shown' })
    await pane.press({ key: 'open-preview:pv-local' })
    await eventually(asked.clock, () => asked.localHelpers.length)
    if (ending === 'leave') await $.command.run({ command: 'stop-sharing', args: '' } as never)
    else await asked.clock.advance(8_001)
    expect(asked.localHelpers[0]!.stopped).toBe(true)
    asked.localHelpers[0]!.send({ state: 'ready', port: 3340 })
    await asked.clock.advance(10)
    expect(asked.copied).toHaveLength(0)
    if (ending === 'timeout') expect(asked.toasted.some(t => t.includes('took too long'))).toBe(true)
  })
}

// A session that was closed when its person left the room from elsewhere
// (the Team panel's Leave) says so when it opens again, not that the room ended.
test('a session reopened after its person left from the Team panel says they left', async ($, on) => {
  const saved = {
    at: 900,
    room: { server: 'https://share.test', id: 'room0000000000000001', url: LINK, title: 'demo', host: 'Sam', token: 'g', seat: 'seat1', seq: 2, since: 1 },
    autoOpen: true,
    policy: { prompts: 'everyone', approvals: 'edits', files: 'on' },
    shown: [],
    activity: [],
    chat: [],
    sidebar: null,
  }
  const asked = world(on, { leftElsewhere: true, files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: saved }) } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  expect(await eventually(asked.clock, () => asked.logged.some(l => l.includes('from the Team panel')))).toBe(true)
  expect(asked.logged).toContain("You left Sam's session from the Team panel while this one was closed.")
  expect(asked.logged.some(l => l.includes('ended while this one was closed'))).toBe(false)
  expect(asked.state.mode ?? 'idle').toBe('idle')
  expect(asked.some(a => a.endsWith('/join'))).toBe(false) // never seated again
})

test('saved localhost listeners resume and restore after helper loss without opening a browser', async ($, on) => {
  const saved = {
    at: 900,
    room: { server: 'https://share.test', id: 'room0000000000000001', url: LINK, title: 'demo', host: 'Sam', token: 'g', seat: 'seat1', seq: 2, since: 1 },
    autoOpen: true,
    policy: { prompts: 'everyone', approvals: 'edits', files: 'on' },
    shown: [
      { key: 'preview:pv-local', kind: 'preview', name: 'Sign in (preview)', ts: 900, pid: 'pv-local', port: 3340, path: '/login?next=%2Faccount', tcp: true },
    ],
    localPreviews: [{ pid: 'pv-local', port: 3340 }],
    activity: [],
    chat: [],
    sidebar: null,
  }
  const asked = world(on, {
    env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
    files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: saved }) },
    roomList: { previews: [{ pid: 'pv-local', port: 3340, tcp: true }] },
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start(START)
  await eventually(asked.clock, () => asked.localHelpers.length)
  expect(asked.localHelpers).toHaveLength(1)
  expect(asked.copied).toHaveLength(0)
  asked.localHelpers[0]!.exit() // a reload kills old module children
  await asked.clock.advance(5)
  await $.session.start(START)
  await eventually(asked.clock, () => asked.localHelpers.length === 2)
  expect(asked.localHelpers).toHaveLength(2)
  expect(asked.copied).toHaveLength(0)
  await $.session.end({ reason: 'other', sessionId: 'session-test-0001', resume: {} } as never)
  const kept = savedAt(asked, 'joined:session-test-0001') as typeof saved
  expect(kept.localPreviews).toEqual([{ pid: 'pv-local', port: 3340, localPort: 3340 }])
  expect(JSON.stringify(kept.localPreviews)).not.toContain('"g"')
  expect(JSON.stringify(kept.localPreviews)).not.toContain('ticket')
  expect(asked.localHelpers.every(h => h.stopped)).toBe(true)
})

test('a host stopping a preview closes its guest listener', async ($, on) => {
  const pages: unknown[] = [{ seq: 2, events: [LOCAL_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = world(on, { env: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, stream: pages })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'terminal', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.copied.length)
  pages.push({
    seq: 3,
    events: [{ seq: 3, type: 'preview', ts: 901, from: LOCAL_SHOWN.from, body: { pid: 'pv-local', state: 'closed' } }],
    people: PREVIEW_PEOPLE,
    ended: false,
    title: 'demo',
  })
  await asked.clock.advance(20_000)
  expect(asked.localHelpers[0]!.stopped).toBe(true)
  expect(await pane.find({ key: 'open-preview:pv-local' })).toBeUndefined()
})

test('the host advertises TCP, rejects mismatched targets, deduplicates connections and closes owned relays', async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = world(on, { stream, tcpRelays: true })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  stream.push(
    { tcp: { id: 'connection0001', pid: 'pv1', port: 3341 } },
    { tcp: { id: 'connection0002', pid: 'not-shared', port: 3340 } },
    { tcp: { id: 'connection0003', pid: 'pv1', port: 3340 } },
    { tcp: { id: 'connection0003', pid: 'pv1', port: 3340 } },
  )
  await asked.clock.advance(5000)
  expect(asked.tcpHelpers).toHaveLength(1)
  expect(asked.spawned.some(s => s.argv[0] === 'curl' && s.input?.includes('/stream?after='))).toBe(true)
  const spawn = asked.spawned.find(s => s.argv.at(-1)?.endsWith('/relay/tcp-worker.mts'))!
  const config = JSON.parse(spawn.input!)
  expect(config).toMatchObject({ room: 'http://localhost:8787/api/rooms/room0000000000000002', token: 't', version: '0.7.1' })
  expect(config.controlToken).toMatch(/^[a-f0-9]{64}$/)
  expect(Object.keys(config).sort()).toEqual(['controlToken', 'room', 'token', 'version'])
  expect(JSON.stringify(spawn.argv)).not.toContain(config.controlToken)
  expect(asked.sent.filter(x => x.body.op === 'open').map(x => x.body)).toEqual([{ op: 'open', id: 'connection0003', pid: 'pv1', port: 3340 }])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  expect(asked.tcpHelpers[0]!.stopped).toBe(true)
})

test('the host automatically retries an ordinary curl stream exit in the same room and handles new TCP requests', async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = world(on, { stream, tcpRelays: true })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await asked.clock.advance(10)
  const first = asked.spawned.filter(s => s.argv[0] === 'curl' && s.argv.includes('-K'))
  expect(first).toHaveLength(1)
  expect(first[0]!.input).toContain('url = "http://localhost:8787/api/rooms/room0000000000000002/stream?after=0"')
  expect(asked.tcpHelpers).toHaveLength(0)
  // The mock curl ended with HTTP 200 and EOF. Only the retry timer reconnects;
  // these notifications weren't present on its first connection.
  stream.push(
    { tcp: { id: 'connection0001', pid: 'pv1', port: 3341 } },
    { tcp: { id: 'connection0002', pid: 'not-shared', port: 3340 } },
    { tcp: { id: 'connection0003', pid: 'pv1', port: 3340 } },
  )
  await asked.clock.advance(1_000)
  const streams = asked.spawned.filter(s => s.argv[0] === 'curl' && s.argv.includes('-K'))
  expect(streams).toHaveLength(2)
  expect(streams[1]!.input).toBe(first[0]!.input) // same room, token and TCP advertisement
  expect(asked.filter(a => a === 'POST /api/rooms' || /\/(join|tunnel|ticket)$/.test(a))).toEqual(['POST /api/rooms'])
  expect(asked.tcpHelpers).toHaveLength(1)
  const relay = asked.spawned.find(s => s.argv.at(-1)?.endsWith('/relay/tcp-worker.mts'))!
  expect(JSON.parse(relay.input!)).toMatchObject({ room: 'http://localhost:8787/api/rooms/room0000000000000002', token: 't' })
  expect(asked.sent.filter(x => x.body.op === 'open').map(x => x.body)).toEqual([{ op: 'open', id: 'connection0003', pid: 'pv1', port: 3340 }])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  expect(asked.tcpHelpers[0]!.stopped).toBe(true)
})

test('the host relays only a port it chose, with 64 reservations in one worker', async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const history = [
    { role: 'user', content: 'Start the app' },
    { role: 'assistant', content: [{ type: 'text', text: 'Running at http://localhost:3340/' }] },
  ]
  const asked = world(on, { stream, tcpRelays: true, history, surfaces: ['terminal'] })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await ui.press({ key: 'share-all' })
  await allowShow(asked, ui)
  await asked.clock.advance(200)
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body)).toEqual([{ port: 3340, title: 'localhost:3340' }])
  // Shared because Claude mentioned it: even asked by the room, no relay.
  stream.push({ tcp: { id: 'connection0001', pid: 'pv1', port: 3340 } })
  await asked.clock.advance(5000)
  expect(asked.tcpHelpers).toHaveLength(0)
  // Queued, connecting and active all count, not just spawned processes.
  stream.length = 0
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  for (let i = 0; i < 66; i++) stream.push({ tcp: { id: `connection01${String(i).padStart(2, '0')}`, pid: 'pv1', port: 3340 } })
  await asked.clock.advance(5000)
  await eventually(asked.clock, () => asked.sent.filter(x => x.body.op === 'open').length === 64, 1000)
  expect(asked.tcpHelpers).toHaveLength(1)
  expect(asked.sent.filter(x => x.body.op === 'open')).toHaveLength(64)
  expect(asked.sent.filter(x => x.body.op === 'reject' && x.body.code === 'BUSY').length > 0 || asked.spawned.some(s => s.input?.includes('BUSY'))).toBe(true)
  stream.length = 0
  asked.tcpHelpers[0]!.send({ state: 'closed', id: 'connection0100' })
  await asked.clock.advance(10)
  stream.push({ tcp: { id: 'connection0200', pid: 'pv1', port: 3340 } })
  await asked.clock.advance(5000)
  await eventually(asked.clock, () => asked.sent.some(x => x.body.op === 'open' && x.body.id === 'connection0200'))
  expect(asked.sent.some(x => x.body.op === 'open' && x.body.id === 'connection0200')).toBe(true)
  expect(asked.tcpHelpers).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  expect(asked.tcpHelpers[0]!.stopped).toBe(true)
})

test('coalesced worker status lines are bounded per line, not per process chunk', async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = world(on, { stream, tcpRelays: true })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  stream.push({ tcp: { id: 'connection0001', pid: 'pv1', port: 3340 } })
  await asked.clock.advance(1000)
  await eventually(asked.clock, () => asked.sent.some(x => x.body.op === 'open'))
  stream.length = 0
  const output =
    Array.from({ length: 200 }, (_, i) => JSON.stringify({ state: 'closed', id: `earlierconnection${String(i).padStart(4, '0')}` })).join('\n') + '\n'
  expect(output.length > 8192).toBe(true)
  asked.tcpHelpers[0]!.output(output)
  await asked.clock.advance(20)
  expect(asked.tcpHelpers[0]!.stopped).toBe(false)
  stream.push({ tcp: { id: 'connection0002', pid: 'pv1', port: 3340 } })
  await asked.clock.advance(5000)
  expect(asked.tcpHelpers).toHaveLength(1)
  expect(asked.sent.some(x => x.body.op === 'open' && x.body.id === 'connection0002')).toBe(true)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('concurrent TCP asks wait for one worker; Stop cancels its startup and all queued opens', async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = world(on, { stream, tcpRelays: true, tcpWorker: 'wait' })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  for (let i = 0; i < 20; i++) stream.push({ tcp: { id: `connection${String(i).padStart(4, '0')}`, pid: 'pv1', port: 3340 } })
  await asked.clock.advance(1000)
  await eventually(asked.clock, () => asked.tcpHelpers.length)
  expect(asked.tcpHelpers).toHaveLength(1)
  expect(asked.sent.filter(x => x.body.op === 'open')).toHaveLength(0)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  asked.tcpHelpers[0]!.send({ state: 'ready', port: 43333 })
  await asked.clock.advance(10)
  expect(asked.tcpHelpers[0]!.stopped).toBe(true)
  expect(asked.sent.filter(x => x.body.op === 'open')).toHaveLength(0)
})

for (const failure of ['startup', 'control', 'exit'] as const) {
  test(`a TCP worker ${failure} failure ends it; only a new connection starts a replacement`, async ($, on) => {
    const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
    const opts = {
      stream,
      tcpRelays: true,
      tcpWorker: failure === 'startup' ? ('wait' as const) : undefined,
      tcpControl: failure === 'control' ? ('wait' as const) : undefined,
    }
    const asked = world(on, opts)
    const ui = await $.ui.mount(band('terminal'))
    await ui.press({ key: 'share' })
    await ui.press({ key: 'share-prompt' })
    await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
    stream.push({ tcp: { id: 'connection0001', pid: 'pv1', port: 3340 } }, { tcp: { id: 'connection0002', pid: 'pv1', port: 3340 } })
    await asked.clock.advance(1000)
    await eventually(asked.clock, () => asked.tcpHelpers.length)
    stream.length = 0
    if (failure === 'exit') asked.tcpHelpers[0]!.exit()
    await asked.clock.advance(failure === 'startup' ? 5001 : failure === 'control' ? 2001 : 20)
    await eventually(asked.clock, () => asked.tcpHelpers[0]!.stopped)
    expect(asked.tcpHelpers[0]!.stopped).toBe(true)
    expect(asked.tcpHelpers).toHaveLength(1)
    expect(asked.sent.filter(x => x.body.op === 'open')).toHaveLength(failure === 'startup' ? 0 : failure === 'control' ? 1 : 2)
    opts.tcpWorker = undefined
    opts.tcpControl = undefined
    stream.push({ tcp: { id: 'connection0003', pid: 'pv1', port: 3340 } })
    await asked.clock.advance(5000)
    await eventually(asked.clock, () => asked.tcpHelpers.length === 2)
    expect(asked.tcpHelpers).toHaveLength(2)
    const workers = asked.spawned.filter(s => s.argv.at(-1)?.endsWith('/relay/tcp-worker.mts'))
    const before = JSON.parse(workers[0]!.input!)
    const after = JSON.parse(workers[1]!.input!)
    expect(after.controlToken).not.toBe(before.controlToken)
    expect(asked.sent.filter(x => x.headers.authorization === `Bearer ${after.controlToken}` && x.body.op === 'open').map(x => x.body.id)).toEqual([
      'connection0003',
    ])
    expect(asked.filter(a => a === 'POST /api/rooms')).toHaveLength(1)
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
    expect(asked.tcpHelpers.every(h => h.stopped)).toBe(true)
  })
}

test('stopping one preview cancels queued opens before IPC without disturbing another preview', async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const opts = { stream, tcpRelays: true, tcpControl: 'wait' as 'wait' | undefined }
  const asked = world(on, opts)
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  await $.command.run({ command: 'share-preview', args: '3341 Docs' } as never)
  stream.push(
    {
      seq: 3,
      events: [
        { ...LOCAL_SHOWN, seq: 2, body: { kind: 'preview', pid: 'pv1', port: 3340, title: 'App', tcp: true } },
        { ...LOCAL_SHOWN, seq: 3, body: { kind: 'preview', pid: 'pv2', port: 3341, title: 'Docs', tcp: true } },
      ],
      people: PREVIEW_PEOPLE,
      ended: false,
      title: 'demo',
    },
    { tcp: { id: 'connection0001', pid: 'pv1', port: 3340 } },
    { tcp: { id: 'connection0002', pid: 'pv1', port: 3340 } },
    { tcp: { id: 'connection0003', pid: 'pv2', port: 3341 } },
  )
  await asked.clock.advance(1000)
  await eventually(asked.clock, () => asked.blockedControls.length)
  expect(asked.blockedControls).toHaveLength(1)
  stream.length = 0
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'terminal', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'stop-preview:pv1' })
  await asked.clock.advance(5)
  opts.tcpControl = undefined
  asked.blockedControls[0]!.release()
  await eventually(asked.clock, () => asked.some(x => x.endsWith('/pv1/end')))
  expect(asked.sent.filter(x => x.body.op === 'open').map(x => x.body.id)).toEqual(['connection0001', 'connection0003'])
  expect(asked.sent.filter(x => x.body.op === 'close-preview').map(x => x.body.pid)).toEqual(['pv1'])
  expect(asked.tcpHelpers).toHaveLength(1)
  expect(asked.tcpHelpers[0]!.stopped).toBe(false)
  stream.push({ tcp: { id: 'connection0004', pid: 'pv1', port: 3340 } }, { tcp: { id: 'connection0005', pid: 'pv2', port: 3341 } })
  await asked.clock.advance(5000)
  expect(asked.sent.some(x => x.body.op === 'open' && x.body.id === 'connection0004')).toBe(false)
  expect(asked.sent.some(x => x.body.op === 'open' && x.body.id === 'connection0005')).toBe(true)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

for (const closed of ['preview', 'room'] as const) {
  test(`a server-side ${closed} close revokes owned TCP work immediately`, async ($, on) => {
    const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
    const asked = world(on, { stream, tcpRelays: true })
    const ui = await $.ui.mount(band('terminal'))
    await ui.press({ key: 'share' })
    await ui.press({ key: 'share-prompt' })
    await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
    stream.push({ tcp: { id: 'connection0001', pid: 'pv1', port: 3340 } })
    await asked.clock.advance(1000)
    await eventually(asked.clock, () => asked.sent.some(x => x.body.op === 'open'))
    stream.length = 0
    stream.push({
      seq: 2,
      events: [
        {
          seq: 2,
          ts: 901,
          from: LOCAL_SHOWN.from,
          type: closed === 'room' ? 'ended' : 'preview',
          body: closed === 'room' ? {} : { pid: 'pv1', state: 'closed' },
        },
      ],
      people: PREVIEW_PEOPLE,
      ended: closed === 'room',
      title: 'demo',
    })
    await asked.clock.advance(5000)
    if (closed === 'room') {
      expect(asked.tcpHelpers[0]!.stopped).toBe(true)
      expect(await ui.find({ key: 'share' })).toBeDefined()
    } else {
      expect(asked.sent.some(x => x.body.op === 'close-preview' && x.body.pid === 'pv1')).toBe(true)
      stream.push({ tcp: { id: 'connection0002', pid: 'pv1', port: 3340 } })
      await asked.clock.advance(5000)
      expect(asked.sent.some(x => x.body.op === 'open' && x.body.id === 'connection0002')).toBe(false)
      await $.command.run({ command: 'stop-sharing', args: '' } as never)
    }
  })
}

test('no Node to run the TCP worker: each connection is refused at once, the host hears why once, and the next one tries again', async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const opts: NonNullable<Parameters<typeof world>[1]> = { stream, tcpRelays: true, tcpWorker: 'missing' }
  const asked = world(on, opts)
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  const workers = () => asked.spawned.filter(s => s.argv.at(-1)?.endsWith('/relay/tcp-worker.mts')).length
  const refused = (id: string) => asked.spawned.filter(s => s.argv[0] === 'curl' && s.input?.includes(`/ws/${id}/reject"`))
  const said = () => asked.toasted.filter(t => t.includes('needs Node 22.18 or later on this computer'))
  stream.push({ tcp: { id: 'connection0001', pid: 'pv1', port: 3340 } })
  await asked.clock.advance(1000)
  await eventually(asked.clock, () => refused('connection0001').length)
  stream.length = 0
  expect(refused('connection0001')[0]!.input).toContain('data = "{\\"code\\":\\"CONNECT\\"}"')
  expect(said()).toEqual([
    'Forwarding localhost:3340 to teammates needs Node 22.18 or later on this computer, and none was found. Install it; their next connection tries again.',
  ])
  // The next connection starts a worker again: refused the same way, and not said again.
  const before = workers()
  stream.push({ tcp: { id: 'connection0002', pid: 'pv1', port: 3340 } })
  await asked.clock.advance(5000)
  await eventually(asked.clock, () => refused('connection0002').length)
  stream.length = 0
  expect(workers()).toBeGreaterThan(before)
  expect(said()).toHaveLength(1)
  // Node installed: the next one goes through.
  opts.tcpWorker = undefined
  stream.push({ tcp: { id: 'connection0003', pid: 'pv1', port: 3340 } })
  await asked.clock.advance(5000)
  await eventually(asked.clock, () => asked.sent.some(x => x.body.op === 'open' && x.body.id === 'connection0003'))
  stream.length = 0
  expect(asked.sent.some(x => x.body.op === 'open' && x.body.id === 'connection0003')).toBe(true)
  expect(refused('connection0003')).toHaveLength(0)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

for (const status of [400, 403, 413, 503]) {
  test(`a TCP worker answering ${status} to an open is ended, its connection refused, and only a new one starts another`, async ($, on) => {
    const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
    const opts: NonNullable<Parameters<typeof world>[1]> = { stream, tcpRelays: true, tcpControlStatus: status }
    const asked = world(on, opts)
    const ui = await $.ui.mount(band('terminal'))
    await ui.press({ key: 'share' })
    await ui.press({ key: 'share-prompt' })
    await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
    const refused = (id: string) => asked.spawned.filter(s => s.argv[0] === 'curl' && s.input?.includes(`/ws/${id}/reject"`))
    stream.push({ tcp: { id: 'connection0001', pid: 'pv1', port: 3340 } })
    await asked.clock.advance(1000)
    await eventually(asked.clock, () => asked.tcpHelpers[0]?.stopped && refused('connection0001').length)
    stream.length = 0
    expect(asked.tcpHelpers[0]!.stopped).toBe(true)
    expect(refused('connection0001')[0]!.input).toContain('data = "{\\"code\\":\\"CONNECT\\"}"')
    opts.tcpControlStatus = undefined
    stream.push({ tcp: { id: 'connection0002', pid: 'pv1', port: 3340 } })
    await asked.clock.advance(5000)
    await eventually(asked.clock, () => asked.sent.some(x => x.body.op === 'open' && x.body.id === 'connection0002'))
    stream.length = 0
    const worker = asked.tcpHelpers.at(-1)!
    expect(worker).not.toBe(asked.tcpHelpers[0])
    expect(worker.stopped).toBe(false)
    expect(refused('connection0002')).toHaveLength(0)
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test('a connection while a failed TCP worker is still ending is refused at once; once it has gone, the next starts another', async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  let exited!: () => void
  const opts: NonNullable<Parameters<typeof world>[1]> = {
    stream,
    tcpRelays: true,
    tcpControlStatus: 503,
    tcpWorkerExit: new Promise<void>(done => {
      exited = done
    }),
  }
  const asked = world(on, opts)
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  const refused = (id: string) => asked.spawned.filter(s => s.argv[0] === 'curl' && s.input?.includes(`/ws/${id}/reject"`))
  stream.push({ tcp: { id: 'connection0001', pid: 'pv1', port: 3340 } })
  await asked.clock.advance(1000)
  await eventually(asked.clock, () => asked.tcpHelpers[0]?.stopped && refused('connection0001').length)
  stream.length = 0
  // Its process hasn't exited: a connection now is refused, not left for the room's deadline.
  opts.tcpControlStatus = undefined
  stream.push({ tcp: { id: 'connection0002', pid: 'pv1', port: 3340 } })
  await asked.clock.advance(5000)
  await eventually(asked.clock, () => refused('connection0002').length)
  stream.length = 0
  expect(refused('connection0002')[0]!.input).toContain('data = "{\\"code\\":\\"CONNECT\\"}"')
  expect(asked.tcpHelpers).toHaveLength(1)
  expect(asked.sent.some(x => x.body.op === 'open' && x.body.id === 'connection0002')).toBe(false)
  exited()
  await asked.clock.advance(10)
  stream.push({ tcp: { id: 'connection0003', pid: 'pv1', port: 3340 } })
  await asked.clock.advance(5000)
  await eventually(asked.clock, () => asked.sent.some(x => x.body.op === 'open' && x.body.id === 'connection0003'))
  stream.length = 0
  expect(asked.tcpHelpers).toHaveLength(2)
  expect(asked.tcpHelpers[1]!.stopped).toBe(false)
  expect(refused('connection0003')).toHaveLength(0)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a worker BUSY response is not replaced by a competing CONNECT rejection', async ($, on) => {
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = world(on, { stream, tcpRelays: true, tcpControl: 'busy' })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  stream.push({ tcp: { id: 'connection0001', pid: 'pv1', port: 3340 } })
  await asked.clock.advance(1000)
  await eventually(asked.clock, () => asked.sent.some(x => x.body.op === 'open'))
  stream.length = 0
  await asked.clock.advance(20)
  expect(asked.sent.filter(x => x.body.op === 'reject')).toHaveLength(0)
  expect(asked.spawned.some(s => s.argv[0] === 'curl' && s.input?.includes('/reject'))).toBe(false)
  expect(asked.tcpHelpers).toHaveLength(1)
  expect(asked.tcpHelpers[0]!.stopped).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})
