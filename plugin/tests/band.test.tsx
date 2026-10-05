// The row above the prompt, drawn and pressed the way Claude Desktop and the
// terminal draw it, over a stand-in world: a fixed clock, a fake share server,
// and quiet toasts. Run with `claude plugin test plugin`.

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { readsInside } from '../hooks/paths'

const SURFACES = ['desktop', 'terminal'] as const
const LINK = 'http://share.test/s/room0000000000000001'

function band<S extends (typeof SURFACES)[number]>(surface: S) {
  return {
    plugin: 'shared-session',
    surface,
    component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} },
    viewport: { columns: 100, rows: 30 },
  }
}

// Everything beneath the plugin a session would provide, plus a share server
// that answers from memory. Returns what the server was asked. `stream` is
// what the room's stream sends a curl child; without it, curl can't start and
// the plugin polls.
function world(on: On, opts: { server?: boolean; stream?: unknown[]; history?: unknown[]; down?: boolean; latest?: string; settings?: string; hostAway?: boolean } = {}) {
  const asked: string[] = []
  const spawned: { argv: readonly string[]; input?: string }[] = []
  on('process.spawn', async function* ($, e) {
    spawned.push({ argv: e.argv, input: e.input })
    // Shell work: an upload answers with the file's id; anything else succeeds.
    if (e.argv[0] === '/bin/sh') {
      if (e.input?.includes('/files"') && e.input.includes('--data-binary')) {
        yield { stream: 'stdout' as const, text: JSON.stringify({ id: 'f'.repeat(64), name: 'chart.html', type: 'text/html', size: 42 }) }
      }
      // A dev server answers on 3340 only.
      if (e.input?.includes('echo "exit=$?"')) yield { stream: 'stdout' as const, text: e.input.includes('localhost:3340/') ? 'exit=28\n' : 'exit=7\n' }
      return { value: { code: 0, signal: null } }
    }
    if (!opts.stream) throw new Error('spawn curl ENOENT')
    for (const line of opts.stream) yield { stream: 'stdout' as const, text: `${JSON.stringify(line)}\n` }
    yield { stream: 'stdout' as const, text: '\n{"httpStatus":200}\n' }
    return { value: { code: 0, signal: null } }
  })
  const clock = mock.clock(on, { now: 1_000 })
  // A Claude Desktop session, unless a test says otherwise.
  const desktop = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }
  mock.env(on, opts.server === false ? { USER: 'scott', HOME: '/home/scott', ...desktop } : { USER: 'scott', HOME: '/home/scott', SHARED_SESSION_SERVER: 'http://localhost:8787', ...desktop })
  // The files the plugin reads: its own manifest, and the person's settings.
  const files = new Map<string, string>()
  if (opts.settings !== undefined) files.set('/home/scott/.claude/settings.json', opts.settings)
  const written: { path: string; text: string }[] = []
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"name":"shared-session","version":"0.7.1"}' }
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  const logged: string[] = []
  on('ui.log', ($, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('session.cwd', () => ({ value: '/tmp/demo' }))
  on('session.messages', () => ({ value: (opts.history ?? []) as never }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  // The app's own drawing beneath the plugin: just the labels it was handed.
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.modes.join(' & ')}</Text>
  })
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.message ?? e.props.word}</Text>
  })
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  const posted: { type: string; body: Record<string, unknown> }[] = []
  const versions: string[] = []
  const urls: string[] = []
  on('http.fetch', ($, e) => {
    urls.push(e.url)
    const method = e.init?.method ?? 'GET'
    const path = e.url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '')
    asked.push(`${method} ${path}`)
    versions.push(String((e.init?.headers as Record<string, string> | undefined)?.['x-shared-session-version'] ?? ''))
    if (opts.down && path.endsWith('/events') && method === 'GET') return { value: { status: 503, ok: false, headers: {}, text: '{"error":"unavailable"}' } }
    if (method === 'POST' && path.endsWith('/events') && e.init?.body) posted.push(...(JSON.parse(e.init.body).events ?? []))
    const people = [
      { id: 'host', name: 'Sam', role: 'host', online: !opts.hostAway },
      { id: 'seat1', name: 'scott', role: 'guest', online: true },
      { id: 'seat2', name: 'Alex', role: 'guest', online: true },
    ]
    let body: unknown = { ok: true }
    if (method === 'POST' && path === '/api/rooms') {
      body = { id: 'room0000000000000002', url: 'http://localhost:8787/s/room0000000000000002', token: 't', seq: 0, title: 'demo' }
    } else if (path.endsWith('/join')) {
      body = { token: 'g', seat: 'seat1', title: 'demo', host: 'Sam', seq: 1, history: [], people, latest: opts.latest }
    } else if (path.endsWith('/events') && method === 'GET') {
      body = { seq: 1, events: [], people, ended: false, title: 'demo' }
    } else if (path.endsWith('/previews') && method === 'POST') {
      body = { pid: 'pv1' }
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  return Object.assign(asked, { clock, logged, spawned, posted, versions, written, urls })
}

test('a session that is not shared shows one Share button', async ($, on) => {
  world(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    const share = await ui.find({ key: 'share' })
    expect(share?.type).toBe('Button')
    expect(share?.props.label).toBe('Share')
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(1)
    await ui.unmount()
  }
})

test('Share makes the host row; Stop sharing asks once, then ends it', async ($, on) => {
  const asked = world(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    await ui.press({ key: 'share' })
    expect((await ui.find({ type: 'Text', text: /^Sharing$/ }))?.props.bold).toBe(true)
    expect(await ui.find({ type: 'Text', text: 'waiting for people to join' })).toBeDefined()
    // Desktop draws the live dot and faces as vector art; the terminal, letters.
    expect(Boolean(await ui.find({ type: 'Svg' }))).toBe(surface === 'desktop')
    expect(await ui.find({ key: 'copy' })).toBeDefined()
    await ui.press({ key: 'stop-sharing' })
    expect((await ui.find({ key: 'stop-sharing' }))?.props.label).toBe('Stop for everyone?')
    expect(await ui.find({ type: 'Text', text: /ends the room for everyone|end the room for everyone/ })).toBeDefined()
    await ui.press({ key: 'stop-sharing' })
    expect(await ui.find({ key: 'share' })).toBeDefined()
    await ui.unmount()
  }
  expect(asked).toContain('POST /api/rooms')
  expect(asked).toContain('POST /api/rooms/room0000000000000002/end')
})

test('a link typed in Desktop joins, and the row names the host', async ($, on) => {
  const asked = world(on)
  const typed = await $.prompt.submit({
    text: `<system-reminder>\nDesktop context\n</system-reminder>\n\n${LINK}`,
    origin: { kind: 'composer' },
    wait: false,
  })
  expect(typed.drop).toBeUndefined() // the link stays as typed; a reply answers it
  expect(asked).toContain('POST /api/rooms/room0000000000000001/join')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect((await ui.find({ type: 'Text', text: /Sam's session/ }))?.props.bold).toBe(true)
    expect(await ui.find({ type: 'Text', text: 'with Alex' })).toBeDefined()
    expect((await ui.find({ key: 'room' }))?.props.label).toBe('Room · 3')
    expect(await ui.find({ key: 'leave' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'leave' })
  expect(await ui.find({ key: 'share' })).toBeDefined()
})

test("a prompt typed while the host's Claude Code is closed stays here", async ($, on) => {
  const asked = world(on, { hostAway: true })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await $.prompt.submit({ text: 'Run the tests', origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(100)
  expect(asked.posted.some(e => e.type === 'prompt')).toBe(false)
})

test('with the host here, a guest prompt goes to the room', async ($, on) => {
  const asked = world(on)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await $.prompt.submit({ text: 'Run the tests', origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(100)
  expect(asked.posted.find(e => e.type === 'prompt')?.body.text).toBe('Run the tests')
})

test('a link another session sends never joins', async ($, on) => {
  const asked = world(on)
  const relayed = await $.prompt.submit({ text: LINK, origin: { kind: 'peer' }, wait: false })
  expect(relayed.drop).toBeUndefined()
  expect(asked.some(a => a.endsWith('/join'))).toBe(false)
  const ui = await $.ui.mount(band('desktop'))
  expect(await ui.find({ key: 'share' })).toBeDefined()
})

const ROW = (text: string, origin: Record<string, unknown>) => ({
  plugin: 'shared-session',
  component: 'UserMessage' as const,
  props: { text, origin, isExpanded: false } as never,
})

test("a teammate's prompt shows their name over their words", async ($, on) => {
  world(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...ROW('Sam: Read NOTES.md, please', { kind: 'plugin', name: 'shared-session', asUser: true }), surface })
    const name = await ui.find({ type: 'Text', text: 'Sam' })
    expect(name?.props.bold).toBe(true)
    expect(Boolean(await ui.find({ type: 'Svg' }))).toBe(surface === 'desktop')
    expect((await ui.find({ key: 'said' }))?.text).toBe('Read NOTES.md, please')
    await ui.unmount()
    const mine = await $.ui.mount({ ...ROW('Note: this is mine', { kind: 'composer' }), surface })
    expect(await mine.find({ type: 'Markdown' })).toBeUndefined()
    expect((await mine.find({ type: 'Text' }))?.text).toBe('Note: this is mine')
    await mine.unmount()
  }
})

test('the footer and the working line say who is here and whose turn it is', async ($, on) => {
  world(on)
  for (const surface of SURFACES) {
    const idle = await $.ui.mount({ plugin: 'shared-session', surface, component: 'SessionMode', props: { modes: ['plan'] } })
    expect((await idle.find({ type: 'Text' }))?.text).toBe('plan')
    await idle.unmount()
  }
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  for (const surface of SURFACES) {
    const footer = await $.ui.mount({ plugin: 'shared-session', surface, component: 'SessionMode', props: { modes: ['plan'] } })
    expect((await footer.find({ type: 'Text' }))?.text).toBe("plan & in Sam's session with Alex")
    const spinner = await $.ui.mount({
      plugin: 'shared-session',
      surface,
      component: 'Spinner',
      props: { word: 'Working', message: null, suffix: '…', mode: 'requesting' },
    })
    expect((await spinner.find({ type: 'Text' }))?.text).toBe("Waiting for Sam's session")
    await footer.unmount()
    await spinner.unmount()
  }
})

test("a joined session hears the room through curl's stream, and never polls it", async ($, on) => {
  const people = [
    { id: 'host', name: 'Sam', role: 'host', online: true },
    { id: 'seat1', name: 'scott', role: 'guest', online: true },
    { id: 'seat2', name: 'Alex', role: 'guest', online: true },
    { id: 'seat3', name: 'Riley', role: 'guest', online: true },
  ]
  const asked = world(on, { stream: [{ seq: 2, events: [], people, ended: false, title: 'demo' }, { t: 1 }] })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const footer = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
  expect((await footer.find({ type: 'Text' }))?.text).toBe("in Sam's session with Alex and Riley")
  await footer.unmount()
  expect(asked.filter(a => a.startsWith('GET ') && a.endsWith('/events'))).toEqual([])
  // The room's address and the seat's token go to curl on stdin, not in argv.
  expect(asked.spawned[0]?.argv).toEqual(['curl', '-K', '-'])
  expect(asked.spawned[0]?.input).toContain('/api/rooms/room0000000000000001/stream?after=1')
  expect(asked.spawned[0]?.input).toContain('Authorization: Bearer g')
})

const PANE = { title: 'Shared session', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never

test('the Room shows the banner, everyone, activity and the chat', async ($, on) => {
  const asked = world(on)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'shared-session', surface, component: 'Pane', requestId: 'shared-room', props: PANE })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(Boolean(await ui.find({ type: 'Svg' }))).toBe(surface === 'desktop')
    for (const name of ['Sam', 'scott', 'Alex']) expect(texts).toContain(name)
    expect(texts).toContain('People')
    expect(texts).toContain('3 here')
    expect(texts).toContain('Chat')
    expect(texts).toContain("Claude doesn't read this")
    expect(await ui.find({ key: 'room-leave' })).toBeDefined()
    expect(await ui.find({ key: 'policy-prompts' })).toBeUndefined() // the host's alone
    await ui.input({ key: 'chat-input-0', text: 'hello room' })
    await asked.clock.advance(100) // the send waits a beat to batch
    await ui.unmount()
  }
  expect(asked.filter(a => a === 'POST /api/rooms/room0000000000000001/events').length).toBeGreaterThan(0)
})

test('the host can make the session watch-only from the Room', async ($, on) => {
  const asked = world(on)
  const band0 = await $.ui.mount(band('desktop'))
  await band0.press({ key: 'share' })
  const ui = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect(await ui.find({ key: 'room-stop' })).toBeDefined()
  await ui.select({ key: 'policy-prompts', value: 'watch' })
  await asked.clock.advance(100)
  const row = await $.ui.mount(band('desktop'))
  expect(await row.find({ type: 'Text', text: /Watch-only/ })).toBeDefined()
  expect(asked).toContain('POST /api/rooms/room0000000000000002/events')
})

// Claude Desktop's sidebar tools, stood in for: what the plugin asked of them.
// Claude Desktop's sidebar, standing in: one session, its title and pin.
// `refuse` makes set_pinned fail, as it can in the app.
function sidebar(on: On, start: { title: string; pinned?: boolean; refuse?: boolean }) {
  const calls: string[] = []
  let pinned = start.pinned === true
  on('mcp.call', ($, e) => {
    calls.push(e.tool === 'get_session' ? 'get_session' : `${e.tool} ${JSON.stringify(e.args)}`)
    if (e.tool === 'set_pinned') {
      if (start.refuse) return { value: { content: [{ type: 'text', text: 'not allowed' }], isError: true } }
      pinned = (e.args as { pinned: boolean }).pinned
    }
    const text = e.tool === 'get_session' ? JSON.stringify({ sessionId: 'local_test', title: start.title, ...(pinned ? { pinned: true } : {}) }) : 'ok'
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  return calls
}

test("sharing marks the session's sidebar row, and stopping puts it back", async ($, on) => {
  world(on)
  const calls = sidebar(on, { title: 'Fix login flow' })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  expect(calls).toContain('set_session_title {"session_id":"self","title":"👥 Live · Fix login flow"}')
  expect(calls).toContain('set_pinned {"session_id":"local_test","pinned":true}')
  await ui.press({ key: 'stop-sharing' })
  await ui.press({ key: 'stop-sharing' })
  expect(calls.at(-3)).toBe('set_session_title {"session_id":"self","title":"Fix login flow"}')
  expect(calls.at(-2)).toBe('set_pinned {"session_id":"local_test","pinned":false}')
})

test("a pin the app won't take is said in the transcript", async ($, on) => {
  const asked = world(on)
  sidebar(on, { title: 'Fix login flow', refuse: true })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  expect(asked.logged.some(line => line.includes("couldn't pin this session"))).toBe(true)
})

test("a session that was pinned stays pinned after sharing", async ($, on) => {
  world(on)
  const calls = sidebar(on, { title: 'Pinned work', pinned: true })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'stop-sharing' })
  await ui.press({ key: 'stop-sharing' })
  expect(calls.some(c => c.startsWith('set_pinned'))).toBe(false)
  expect(calls.at(-1)).toBe('set_session_title {"session_id":"self","title":"Pinned work"}')
})

test("joining names the host in the sidebar; leaving says whose session it was", async ($, on) => {
  world(on)
  const calls = sidebar(on, { title: 'Session room0000000000000001' })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  expect(calls).toContain('set_session_title {"session_id":"self","title":"👥 Sam · demo"}')
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'leave' })
  expect(calls).toContain(`set_session_title {"session_id":"self","title":"Sam's session · demo"}`)
  expect(calls.at(-2)).toBe('set_pinned {"session_id":"local_test","pinned":false}')
})

test('with no share server set up, Share uses the public one, and joining still works', async ($, on) => {
  const world0 = world(on, { server: false })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  expect(world0.urls).toContain('https://claude-share.proud-limit-da0a.workers.dev/api/rooms')
  await ui.press({ key: 'stop-sharing' })
  await ui.press({ key: 'stop-sharing' })
  const joined = await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  expect(joined.drop).toBeUndefined()
  expect(world0).toContain('POST /api/rooms/room0000000000000001/join')
})

test("what the host's Claude shows goes to the room, its files uploaded", async ($, on) => {
  const asked = world(on)
  on('tool.call', { tool: 'SendUserFile' }, () => ({ result: { attachments: [] }, text: '1 file delivered to user.' }) as never)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await $.tool.call({ tool: 'SendUserFile', files: ['chart.html'], display: 'render', status: 'normal', caption: 'The chart' } as never)
  await asked.clock.advance(200)
  const upload = asked.spawned.find(s => s.argv[0] === '/bin/sh' && s.input?.includes('/files"'))
  expect(upload?.input).toContain("--data-binary @'/tmp/demo/chart.html'")
  expect(upload?.input).not.toContain('Bearer t\'') // the token goes in curl's config on stdin
  const shown = asked.posted.find(e => e.type === 'artifact')
  expect(shown?.body.kind).toBe('send')
  expect((shown?.body.files as { name: string }[])[0]?.name).toBe('chart.html')
  expect(shown?.body.caption).toBe('The chart')
})

test('a host who keeps what Claude shows sends nothing', async ($, on) => {
  const asked = world(on)
  on('tool.call', { tool: 'SendUserFile' }, () => ({ result: { attachments: [] }, text: 'ok' }) as never)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.select({ key: 'policy-files', value: 'off' })
  await $.tool.call({ tool: 'SendUserFile', files: ['chart.html'], display: 'render', status: 'normal' } as never)
  await asked.clock.advance(200)
  expect(asked.posted.some(e => e.type === 'artifact')).toBe(false)
})

test('a guest sees what the host showed in the Room, with Open', async ($, on) => {
  const people = [
    { id: 'host', name: 'Sam', role: 'host', online: true },
    { id: 'seat1', name: 'scott', role: 'guest', online: true },
  ]
  const shown = { seq: 2, type: 'artifact', ts: 900, from: { seat: 'host', name: 'Sam', role: 'host' }, body: { kind: 'send', files: [{ id: 'f'.repeat(64), name: 'chart.html', type: 'text/html', size: 42 }], display: 'render' } }
  const asked = world(on, { stream: [{ seq: 2, events: [shown], people, ended: false, title: 'demo' }] })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect(await pane.find({ type: 'Text', text: /chart\.html/ })).toBeDefined()
  expect(await pane.find({ key: 'open-seq:2' })).toBeDefined()
})

test('a guest can choose to be asked before what the host shows opens', async ($, on) => {
  const asked = world(on, { stream: [{ seq: 1, events: [], people: [{ id: 'host', name: 'Sam', role: 'host', online: true }], ended: false, title: 'demo' }] })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect(await pane.find({ key: 'auto-open' })).toBeDefined()
  await pane.select({ key: 'auto-open', value: 'ask' })
  await pane.unmount()
  const again = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect((await again.find({ key: 'auto-open' }))?.props.value).toBe('ask')
})

const HISTORY = [
  { role: 'user', content: 'Fix the login redirect' },
  { role: 'assistant', content: [{ type: 'text', text: 'Fixed: the callback now keeps the return path.' }] },
  { role: 'user', content: 'Now add a test' },
]

test('Share in a session with history asks first; "Only from now on" sends none of it', async ($, on) => {
  const asked = world(on, { history: HISTORY })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    await ui.press({ key: 'share' })
    expect(asked).not.toContain('POST /api/rooms') // nothing leaves until they choose
    expect(await ui.find({ type: 'Text', text: 'Share this session?' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 earlier prompts/ })).toBeDefined()
    await ui.press({ key: 'share-cancel' })
    expect(await ui.find({ key: 'share' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-new' })
  expect(asked).toContain('POST /api/rooms')
  await asked.clock.advance(100)
  expect(asked.posted.filter(e => e.type === 'row')).toHaveLength(0)
})

test('"Share everything" sends the history', async ($, on) => {
  const asked = world(on, { history: HISTORY })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-all' })
  await asked.clock.advance(100)
  expect(asked.posted.filter(e => e.type === 'row').length).toBeGreaterThan(0)
  expect((await ui.find({ type: 'Text', text: /^Sharing$/ }))?.props.bold).toBe(true)
})

test('"Share everything" opens the dev servers Claude opened before, still running, at the page it was on', async ($, on) => {
  const asked = world(on, {
    history: [
      { role: 'user', content: 'Build the course sheet' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'mcp__Claude_Browser__browser_batch', input: { actions: [{ name: 'navigate', input: { url: 'http://localhost:3340/dev/start' } }] } },
          { type: 'text', text: 'Built: http://localhost:3340/dev/course-sheet (the old app is at http://localhost:3320/home)' },
        ],
      },
    ],
  })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-all' })
  await asked.clock.advance(200)
  const previews = asked.posted.filter(e => e.type === 'artifact' && e.body.kind === 'preview')
  expect(previews.map(e => [e.body.port, e.body.path])).toEqual([[3340, '/dev/course-sheet']]) // 3320 isn't answering
})

test('a page the host\'s Claude opens with browser_batch goes to the room', async ($, on) => {
  const asked = world(on)
  on('tool.call', { tool: 'mcp__Claude_Browser__browser_batch' }, () => ({ result: [], text: 'navigated' }) as never)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await $.tool.call({ tool: 'mcp__Claude_Browser__browser_batch', actions: [{ name: 'navigate', input: { url: 'http://localhost:5173/settings' } }, { name: 'computer', input: { action: 'screenshot' } }] } as never)
  await asked.clock.advance(200)
  const shown = asked.posted.find(e => e.type === 'artifact')
  expect([shown?.body.kind, shown?.body.port, shown?.body.path]).toEqual(['preview', 5173, '/settings'])
})

test("a room this session can't reach says it is reconnecting", async ($, on) => {
  const asked = world(on, { down: true })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(5_000)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ type: 'Text', text: /Reconnecting to the room/ })).toBeDefined()
    if (surface === 'desktop') expect((await ui.find({ type: 'Svg' }))?.props.alt).toMatch(/^Reconnecting/)
    await ui.unmount()
  }
})

test('every request says the plugin version, and a newer one shows in the Room with its command', async ($, on) => {
  const asked = world(on, { latest: '9.9.9', settings: '{}' })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  expect(asked.versions.length).toBeGreaterThan(0)
  expect(asked.versions.every(v => v === '0.7.1')).toBe(true)
  expect(asked.logged.some(line => line.includes('9.9.9 is out'))).toBe(true)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect(await pane.find({ type: 'Text', text: /Version 9\.9\.9 is out/ })).toBeDefined()
  expect(await pane.find({ key: 'copy-update' })).toBeDefined()
})

test("the Room's Updates setting turns on auto-update in the person's settings, keeping the rest", async ($, on) => {
  const asked = world(on, { settings: '{\n  "theme": "dark"\n}\n' })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect((await pane.find({ key: 'updates' }))?.props.value).toBe('manual')
  await pane.select({ key: 'updates', value: 'auto' })
  const saved = JSON.parse(asked.written.at(-1)?.text ?? '{}')
  expect(saved.theme).toBe('dark')
  expect(saved.extraKnownMarketplaces['claude-share']).toEqual({ source: { source: 'github', repo: 'Paradigm-Study/claude-share' }, autoUpdate: true })
})

test("a guest's read runs without asking only inside the host's project", async () => {
  const cwd = '/tmp/demo'
  expect(readsInside('Read', { file_path: '/tmp/demo/src/app.ts' }, cwd)).toBe(true)
  expect(readsInside('Read', { file_path: 'src/app.ts' }, cwd)).toBe(true)
  expect(readsInside('Grep', { pattern: 'TODO' }, cwd)).toBe(true) // no path: the project
  expect(readsInside('Read', { file_path: '/Users/scott/.ssh/id_ed25519' }, cwd)).toBe(false)
  expect(readsInside('Read', { file_path: '~/.aws/credentials' }, cwd)).toBe(false)
  expect(readsInside('Read', { file_path: '../other/secrets.env' }, cwd)).toBe(false)
  expect(readsInside('Read', { file_path: '/tmp/demo/../demo-other/x' }, cwd)).toBe(false)
  expect(readsInside('Glob', { pattern: '/etc/**' }, cwd)).toBe(false)
  expect(readsInside('Grep', { pattern: 'key', path: '/' }, cwd)).toBe(false)
})
