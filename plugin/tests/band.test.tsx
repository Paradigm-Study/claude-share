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
function world(
  on: On,
  opts: {
    server?: boolean
    stream?: unknown[]
    history?: unknown[]
    down?: boolean
    latest?: string
    settings?: string
    hostAway?: boolean
    env?: Record<string, string>
    store?: Record<string, unknown>
    files?: Record<string, string>
    people?: { id: string; name: string; role: string; online: boolean; version?: string }[]
    /** Transcript files by path: the shell's ls, cat/head | tac | grep, and grep -l over them. */
    transcripts?: Record<string, string>
    /** The share server's teams: signed in (account.json), its sessions, a join it refuses. */
    team?: { signedIn?: boolean; sessions?: unknown[]; refuseJoin?: boolean; access?: 'members' | 'link' }
  } = {},
) {
  const asked: string[] = []
  const spawned: { argv: readonly string[]; input?: string }[] = []
  on('process.spawn', async function* ($, e) {
    spawned.push({ argv: e.argv, input: e.input })
    // Shell work: an upload answers with the file's id; anything else succeeds.
    if (e.argv[0] === '/bin/sh' && opts.transcripts) {
      const files = opts.transcripts
      const input = e.input ?? ''
      const ls = /projects\/\*\/([\w-]+)\.jsonl/.exec(input)
      const read = /^(?:cat '([^']+)'|head -n (\d+) '([^']+)') \|/.exec(input)
      const link = /grep -l -F '"uuid":"([^"]+)"' '[^']+'\/\*\.jsonl 2>\/dev\/null \| grep -v -F '([^']+)'/.exec(input)
      if (input.startsWith('ls -1') && ls) {
        const path = Object.keys(files).find(f => f.endsWith(`/${ls[1]}.jsonl`))
        if (path) yield { stream: 'stdout' as const, text: `${path}\n` }
        return { value: { code: 0, signal: null } }
      }
      if (read) {
        const path = read[1] ?? read[3]!
        const lines = (files[path] ?? '').split('\n').filter(Boolean)
        const upTo = read[2] ? Number(read[2]) : lines.length
        const out = lines.slice(0, upTo).reverse().filter(l => /"type":"(user|assistant)"/.test(l))
        if (out.length) yield { stream: 'stdout' as const, text: `${out.join('\n')}\n` }
        return { value: { code: 0, signal: null } }
      }
      if (link) {
        const [, uuid, not] = link
        const other = Object.keys(files).find(f => f !== not && files[f]!.includes(`"uuid":"${uuid}"`))
        if (other) yield { stream: 'stdout' as const, text: `${files[other]!.split('\n').findIndex(l => l.includes(`"uuid":"${uuid}"`)) + 1}\n${other}` }
        return { value: { code: 0, signal: null } }
      }
    }
    if (e.argv[0] === '/bin/sh' && e.input?.startsWith('umask 077')) {
      // The sign-in file: written from the here-document, then moved in place.
      const body = /cat > '[^']+' <<'(\w+)'\n([\s\S]*?)\n\1\n/.exec(e.input)
      const to = /mv '[^']+' '([^']+)'/.exec(e.input)
      if (body && to) files.set(to[1]!, body[2]!)
      return { value: { code: 0, signal: null } }
    }
    if (e.argv[0] === '/bin/sh') {
      if (e.input?.includes('/files"') && e.input.includes('--data-binary')) {
        const picture = e.input.includes('content-type: image/png')
        yield { stream: 'stdout' as const, text: JSON.stringify(picture ? { id: 'a'.repeat(64), name: 'image-1.png', type: 'image/png', size: 68 } : { id: 'f'.repeat(64), name: 'chart.html', type: 'text/html', size: 42 }) }
      }
      if (e.input?.includes('echo copied')) yield { stream: 'stdout' as const, text: 'copied\n' }
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
  const desktop = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', ...opts.env }
  mock.env(on, opts.server === false ? { USER: 'scott', HOME: '/home/scott', ...desktop } : { USER: 'scott', HOME: '/home/scott', SHARED_SESSION_SERVER: 'http://localhost:8787', ...desktop })
  mock.store(on, opts.store ?? {})
  // The files the plugin reads: its own manifest, and the person's settings.
  const files = new Map<string, string>()
  if (opts.settings !== undefined) files.set('/home/scott/.claude/settings.json', opts.settings)
  if (opts.team?.signedIn) files.set(ACCOUNT_FILE, JSON.stringify({ servers: { 'http://localhost:8787': { token: TEAM_TOKEN, account: ME } } }))
  for (const [path, text] of Object.entries(opts.files ?? {})) files.set(path, text)
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
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: '/tmp/demo' }))
  on('session.messages', () => ({ value: (opts.history ?? []) as never }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const submitted: { text: string; context?: readonly string[] }[] = []
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, context: e.context })
    return { text: e.text }
  })
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
  const sent: { path: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
  on('http.fetch', ($, e) => {
    urls.push(e.url)
    const headers = (e.init?.headers ?? {}) as Record<string, string>
    sent.push({ path: e.url.replace(/^https?:\/\/[^/]+/, ''), headers, body: e.init?.body ? JSON.parse(e.init.body) : {} })
    const method = e.init?.method ?? 'GET'
    const path = e.url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '')
    asked.push(`${method} ${path}`)
    versions.push(String((e.init?.headers as Record<string, string> | undefined)?.['x-shared-session-version'] ?? ''))
    if (opts.down && path.endsWith('/events') && method === 'GET') return { value: { status: 503, ok: false, headers: {}, text: '{"error":"unavailable"}' } }
    if (method === 'POST' && path.endsWith('/events') && e.init?.body) posted.push(...(JSON.parse(e.init.body).events ?? []))
    const people = opts.people ?? [
      { id: 'host', name: 'Sam', role: 'host', online: !opts.hostAway },
      { id: 'seat1', name: 'scott', role: 'guest', online: true },
      { id: 'seat2', name: 'Alex', role: 'guest', online: true },
    ]
    let body: unknown = { ok: true }
    const signedIn = headers.authorization === `Bearer ${TEAM_TOKEN}`
    const team = { id: 'team0001', name: 'Acme', role: 'owner', access: opts.team?.access ?? 'members', domains: [], githubOrgs: [], invite: 'invite0001' }
    if (path === '/api/auth/providers') {
      body = { providers: [{ id: 'github', label: 'GitHub' }, { id: 'google', label: 'Google' }] }
    } else if (path === '/api/auth/poll') {
      body = { status: 'done', token: TEAM_TOKEN, account: ME, joined: null }
    } else if (path === '/api/me' || path.startsWith('/api/teams') || path.startsWith('/api/invites/')) {
      if (!signedIn) return { value: { status: 401, ok: false, headers: {}, text: '{"error":"Sign in first"}' } }
      if (path === '/api/me') body = { account: ME, teams: [team] }
      else if (path === '/api/teams/team0001/sessions') body = { sessions: opts.team?.sessions ?? [] }
      else if (path === '/api/teams/team0001') body = { team, members: [{ id: ME.id, name: ME.name, role: 'owner' }] }
      else if (path.startsWith('/api/invites/')) body = { team, joined: true }
    } else if (method === 'POST' && path === '/api/rooms') {
      const forTeam = sent.at(-1)?.body.team === 'team0001' && headers['x-shared-session-account'] === TEAM_TOKEN
      body = { id: 'room0000000000000002', url: 'http://localhost:8787/s/room0000000000000002', token: 't', seq: 0, title: 'demo', ...(forTeam ? { team: { id: 'team0001', name: 'Acme' } } : {}) }
    } else if (path.endsWith('/join') && opts.team?.refuseJoin && headers['x-shared-session-account'] !== TEAM_TOKEN) {
      return { value: { status: 403, ok: false, headers: {}, text: JSON.stringify({ error: 'This session is for Acme.', team: 'Acme', signIn: true }) } }
    } else if (path.endsWith('/join')) {
      body = { token: 'g', seat: 'seat1', title: 'demo', host: 'Sam', seq: 1, history: [], people, latest: opts.latest }
    } else if (path.endsWith('/events') && method === 'GET') {
      body = { seq: 1, events: [], people, ended: false, title: 'demo' }
    } else if (path.endsWith('/previews') && method === 'POST') {
      body = { pid: 'pv1' }
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  return Object.assign(asked, { clock, logged, spawned, posted, versions, written, urls, submitted, sent, opened, files })
}

// A press settles before work waiting on the runtime's own promises does (a
// sign-in's SHA-256): look again, the clock a step on each time.
async function eventually<T>(clock: { advance: (ms: number) => Promise<void> }, get: () => T, tries = 100): Promise<T> {
  for (let i = 0; i < tries && !get(); i++) await clock.advance(1)
  return get()
}

const ACCOUNT_FILE = '/home/scott/.claude/shared-session/account.json'
const TEAM_TOKEN = 'ssa_teamtoken000000000000000000'
const ME = { id: 'acct0001', name: 'Scott', login: 'scottfan', email: 'scott@acme.test', provider: 'github' }
const TEAM_PANE = { plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-team', props: { title: 'Team', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as never
const teamSession = (n: number, host = 'Sam') => ({ id: `room000000000000010${n}`, url: `http://localhost:8787/s/room000000000000010${n}`, title: `demo: work ${n}`, host, hostAccount: `acct-${host}`, hostOnline: true, people: [host], createdAt: 500 })

test('a session that is not shared shows Share, and Team beside it', async ($, on) => {
  world(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    const share = await ui.find({ key: 'share' })
    expect(share?.type).toBe('Button')
    expect(share?.props.label).toBe('Share')
    expect((await ui.find({ key: 'team' }))?.props.label).toBe('Team')
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
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

test("a teammate's prompt that another session sent them shows its words and where it came from", async ($, on) => {
  world(on)
  const text = 'Kyle: <cross-session-message from="uds:/tmp/x.sock" from-name="claude-share-0f" from-mode="bypass">\nBug report from this guest\n\nDetails below.\n</cross-session-message>'
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...ROW(text, { kind: 'plugin', name: 'shared-session', asUser: true }), surface })
    expect((await ui.find({ type: 'Text', text: 'Kyle' }))?.props.bold).toBe(true)
    expect(await ui.find({ type: 'Text', text: 'relayed a message from claude-share-0f' })).toBeDefined()
    expect((await ui.find({ key: 'said' }))?.text).toBe('> Bug report from this guest\n>\n> Details below.')
    await ui.unmount()
  }
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

// A session whose Claude took a screenshot: a call, its result as the
// transcript keeps it (an image block, then text), and words after it.
const SHOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const SHOT_HISTORY = [
  { role: 'user', content: 'Show me the course page' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_shot1', name: 'mcp__Claude_Browser__computer', input: { action: 'screenshot' } }] },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_shot1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: SHOT } }, { type: 'text', text: 'Took a screenshot' }] }],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'Here is the course page.' }] },
]

test("a screenshot the host's Claude took goes to the room as a file, named on its row, in order", async ($, on) => {
  const asked = world(on, { history: SHOT_HISTORY })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
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
  const shown = { seq: 2, type: 'artifact', ts: 900, from: { seat: 'host', name: 'Sam', role: 'host' }, body: { kind: 'send', files: [{ id: 'f'.repeat(64), name: 'chart.html', type: 'text/html', size: 42 }], display: 'render' } }
  const asked = world(on, { stream: [{ seq: 2, events: [shown], people, ended: false, title: 'demo' }] })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect(await pane.find({ type: 'Text', text: /chart\.html/ })).toBeDefined()
  expect(await pane.find({ key: 'open-seq:2' })).toBeDefined()
})

test('a session reopened after a compaction shares its whole history, from the file before too, and asks first', async ($, on) => {
  const row = (o: Record<string, unknown>) => JSON.stringify(o)
  const old = '/home/scott/.claude/projects/-tmp-demo/session-a-0001.jsonl'
  const now = '/home/scott/.claude/projects/-tmp-demo/session-b-0002.jsonl'
  const asked = world(on, {
    transcripts: {
      [old]: [
        row({ type: 'user', uuid: 'a1', parentUuid: null, message: { role: 'user', content: 'First prompt, in the old file' } }),
        row({ type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'An answer from before the compaction' }] } }),
        row({ type: 'attachment', uuid: 'x1', parentUuid: 'a2' }),
        row({ type: 'assistant', uuid: 'a3', parentUuid: 'x1', message: { role: 'assistant', content: [{ type: 'text', text: 'Copied into the new file too' }] } }),
      ].join('\n'),
      [now]: [
        row({ type: 'attachment', uuid: 'x1', parentUuid: 'a2' }),
        row({ type: 'user', uuid: 'b1', parentUuid: 'x1', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued…' } }),
        row({ type: 'assistant', uuid: 'b2', parentUuid: 'b1', message: { role: 'assistant', content: [{ type: 'text', text: 'Copied into the new file too' }] } }),
        row({ type: 'user', uuid: 'b3', parentUuid: 'b2', message: { role: 'user', content: 'A prompt after reopening' } }),
      ].join('\n'),
    },
  })
  on('session.id', () => ({ value: 'session-b-0002' }))
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  expect(await ui.find({ type: 'Text', text: 'Share this session?' })).toBeDefined() // it has prompts: asks first
  await ui.press({ key: 'share-all' })
  await asked.clock.advance(100)
  const texts = asked.posted.filter(e => e.type === 'row').map(e => e.body.text)
  expect(texts).toEqual(['First prompt, in the old file', 'An answer from before the compaction', 'Copied into the new file too', 'A prompt after reopening'])
})

test("a page the host's Claude publishes goes to the room with the pictures beside it, each at its place", async ($, on) => {
  const asked = world(on)
  on('tool.call', { tool: 'Artifact' }, () => ({ result: 'Published https://claude.ai/artifact/x' }) as never)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await $.tool.call({ tool: 'Artifact', file_path: '/tmp/demo/mkt/index.html', root: 'mkt', files: { 'img/01-start.jpg': 'img/01-start.jpg', '../escape.txt': 'x.txt' } } as never)
  await asked.clock.advance(200)
  const uploaded = asked.spawned.filter(s => s.argv[0] === '/bin/sh' && s.input?.includes('/files"')).map(s => /--data-binary @'([^']+)'/.exec(s.input ?? '')?.[1])
  expect(uploaded).toEqual(['/tmp/demo/mkt/index.html', '/tmp/demo/mkt/img/01-start.jpg', '/tmp/demo/mkt/x.txt'])
  const page = asked.posted.find(e => e.type === 'artifact')
  expect(page?.body.kind).toBe('page')
  // Each file's place beside the page; never outside it.
  expect((page?.body.files as { path?: string }[]).map(f => f.path)).toEqual(['index.html', 'img/01-start.jpg', 'escape.txt'])
})

test("a guest saves a page and the files beside it in a folder of its own, and opens it from the Room", async ($, on) => {
  const people = [
    { id: 'host', name: 'Sam', role: 'host', online: true },
    { id: 'seat1', name: 'scott', role: 'guest', online: true },
  ]
  const files = [
    { id: 'b'.repeat(64), name: 'index.html', type: 'text/html', size: 42, path: 'index.html' },
    { id: 'c'.repeat(64), name: '01-start.jpg', type: 'image/jpeg', size: 99, path: 'img/01-start.jpg' },
  ]
  const shown = { seq: 2, type: 'artifact', ts: 900, from: { seat: 'host', name: 'Sam', role: 'host' }, body: { kind: 'page', files } }
  const asked = world(on, { stream: [{ seq: 2, events: [shown], people, ended: false, title: 'demo' }] })
  const opened: string[] = []
  on('mcp.call', ($, e) => {
    opened.push(`${e.server}.${e.tool} ${JSON.stringify(e.args)}`)
    return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } } as never
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect(await pane.find({ type: 'Text', text: /index\.html \(a page and 1 file\)/ })).toBeDefined()
  await pane.press({ key: 'open-seq:2' })
  await asked.clock.advance(200)
  const dir = `/tmp/demo/.shared-session/Sam/page-${'b'.repeat(8)}`
  const saved = asked.spawned.map(s => /-o '([^']+)'/.exec(s.input ?? '')?.[1]).filter(Boolean)
  expect(saved).toEqual([`${dir}/index.html`, `${dir}/img/01-start.jpg`])
  expect(asked.spawned.some(s => s.input?.includes(`mkdir -p '${dir}/img'`))).toBe(true)
  expect(opened).toContain(`Claude_Browser.preview_start {"url":"file://${dir}/index.html"}`)
})

test("Claude asking for the share command itself hears where things stand, never that the plugin isn't running", async ($, on) => {
  const asked = world(on)
  const idle = await $.tool.call({ tool: 'Skill', skill: 'shared-session:share-session' } as never)
  expect(JSON.stringify(idle)).toContain('Sharing starts only when the person chooses it')
  expect(asked).not.toContain('POST /api/rooms') // Claude never starts it
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  const shared = await $.tool.call({ tool: 'Skill', skill: 'shared-session:share-session' } as never)
  expect(JSON.stringify(shared)).toContain('already shared (http://localhost:8787/s/room0000000000000002)')
})

test('a page opened again goes to the room again with its files, even one published before, and Claude hears it went', async ($, on) => {
  const ART = 'https://claude.ai/artifact/8nAyoRXM6doAg4ZND1fZ26'
  const history = [
    { role: 'user', content: 'Make the asset pack' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_pub', name: 'Artifact', input: { file_path: '/tmp/demo/mkt/index.html', root: 'mkt', files: { 'img/01.jpg': 'img/01.jpg' } } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_pub', content: `Published /tmp/demo/mkt/index.html at ${ART} (Version 1)` }] },
  ]
  const asked = world(on, { history })
  on('tool.call', { tool: 'Artifact' }, () => ({ result: `Opened the Artifact at ${ART} for the user.` }) as never)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-new' })
  const opened = await $.tool.call({ tool: 'Artifact', action: 'open', url: ART } as never)
  await asked.clock.advance(200)
  const page = asked.posted.filter(e => e.type === 'artifact').at(-1)
  expect(page?.body.kind).toBe('page')
  expect((page?.body.files as { path?: string }[]).map(f => f.path)).toEqual(['index.html', 'img/01.jpg'])
  expect(JSON.stringify(opened)).toContain("They don't need the claude.ai link")
})

test('the update command a guest types runs on their computer, never at the host', async ($, on) => {
  const asked = world(on)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  await $.prompt.submit({ text: 'claude plugin marketplace update claude-share && claude plugin update shared-session@claude-share', origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(100)
  expect(asked.posted.some(e => e.type === 'prompt')).toBe(false)
  const run = asked.spawned.find(s => s.input?.includes('plugin update shared-session@claude-share'))
  expect(run?.input).toContain("export HOME='/home/scott'")
  expect(asked.logged.some(l => /up to date here|is installed here/.test(l))).toBe(true)
})

test('the Room says who runs an older plugin, and the host hears it once with the command', async ($, on) => {
  const asked = world(on, {
    people: [
      { id: 'host', name: 'scott', role: 'host', online: true, version: '0.7.1' },
      { id: 'seat2', name: 'Alex', role: 'guest', online: true, version: '0.6.0' },
      { id: 'seat3', name: 'Kim', role: 'guest', online: true, version: '0.7.1' },
    ],
  })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await asked.clock.advance(20_000)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect(await pane.find({ type: 'Text', text: 'on 0.6.0, needs an update' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'on 0.7.1, needs an update' })).toBeUndefined()
  const said = asked.logged.filter(l => l.startsWith('Alex runs Shared Sessions 0.6.0'))
  expect(said.length).toBe(1)
  expect(said[0]).toContain('claude plugin marketplace update claude-share')
})

test("a guest's attachment reaches the host's Claude: saved in the project and named in the prompt with how to see it", async ($, on) => {
  const people = [
    { id: 'host', name: 'scott', role: 'host', online: true },
    { id: 'seat2', name: 'Alex', role: 'guest', online: true },
  ]
  const prompt = {
    seq: 2,
    type: 'prompt',
    ts: 900,
    from: { seat: 'seat2', name: 'Alex', role: 'guest' },
    body: { text: 'What is this?', pid: 'p1', attachments: [{ id: 'd'.repeat(64), name: 'shot.png', type: 'image/png', size: 68 }] },
  }
  const asked = world(on, { stream: [{ seq: 2, events: [prompt], people, ended: false, title: 'demo' }] })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await asked.clock.advance(2_000)
  const saved = `/tmp/demo/.shared-session/Alex/${'d'.repeat(6)}-shot.png`
  expect(asked.spawned.some(s => s.input?.includes(`-o '${saved}'`))).toBe(true)
  const sent = asked.submitted.find(p => p.text.startsWith('Alex: What is this?'))
  expect(sent?.text).toBe(`Alex: What is this?\n\n📎 .shared-session/Alex/${'d'.repeat(6)}-shot.png (attached by Alex; open it with the Read tool to see it)`)
})

test('a guest message whose attachments never come through still goes, and says so', async ($, on) => {
  const asked = world(on)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  await $.prompt.submit({ text: 'What is this?', attachments: [{ type: 'image', mediaType: 'image/png' }], origin: { kind: 'composer' }, wait: false } as never)
  await asked.clock.advance(100)
  expect(asked.posted.some(e => e.type === 'prompt')).toBe(false) // held for its attachment
  await asked.clock.advance(9_000)
  const sent = asked.posted.find(e => e.type === 'prompt')
  expect(sent?.body.text).toBe('What is this?')
  expect(asked.logged.some(l => l.startsWith("An attachment didn't go with this message"))).toBe(true)
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
  // …and in place: a copy of the plugin in a folder every session loads and watches.
  expect(asked.spawned.some(s => s.input?.includes("live='/home/scott/.claude/shared-session/plugin'"))).toBe(true)
  expect(saved.env).toEqual({ CLAUDE_CODE_PLUGIN_DIRS: '/home/scott/.claude/shared-session/plugin', CLAUDE_CODE_PLUGIN_DIR_WATCH: '1' })
  expect(await pane.find({ type: 'Text', text: /next new session on, a release loads in place/ })).toBeDefined()
  // Off again: the folder isn't named, the person's other settings stay.
  await pane.select({ key: 'updates', value: 'manual' })
  const after = JSON.parse(asked.written.at(-1)?.text ?? '{}')
  expect(after.env).toEqual({})
  expect(after.theme).toBe('dark')
})

test('automatic updates chosen earlier move to updates in place, keeping other plugin folders', async ($, on) => {
  const asked = world(on, {
    settings: JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/home/scott/mods/other' }, extraKnownMarketplaces: { 'claude-share': { source: { source: 'github', repo: 'Paradigm-Study/claude-share' }, autoUpdate: true } } }),
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const saved = JSON.parse(asked.written.at(-1)?.text ?? '{}')
  expect(saved.env.CLAUDE_CODE_PLUGIN_DIRS).toBe('/home/scott/mods/other:/home/scott/.claude/shared-session/plugin')
  expect(asked.logged.some(l => l.includes('updates in place'))).toBe(true)
})

// A room a host session saved when it closed, as keepHosting saves it.
function savedRoom(id: string, at: number, where: { sidebar?: string; place?: string } = {}) {
  return {
    at,
    room: { server: 'http://localhost:8787', id, url: `http://localhost:8787/s/${id}`, title: 'demo', host: 'scott', token: `t-${id}`, seat: 'host', seq: 3, since: 1 },
    policy: { prompts: 'everyone', approvals: 'edits', files: 'on' },
    trusted: [],
    previews: {},
    shown: [],
    activity: [],
    chat: [],
    sidebar: where.sidebar ? { title: 'Fix login', pinned: false, id: where.sidebar } : null,
    ...(where.place ? { place: where.place } : {}),
  }
}
const START = { cwd: '/tmp/demo', surface: 'desktop', isInteractive: true } as const

test('a host session reopened takes its room back, on the same link', async ($, on) => {
  const asked = world(on, { store: { 'hosting:cli-1': savedRoom('room0000000000000009', 900) } })
  on('session.id', () => ({ value: 'cli-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await asked.clock.advance(10)
  expect(asked.logged).toContain('Still sharing this session: http://localhost:8787/s/room0000000000000009')
})

test('a Desktop session reopened under a new id (a rewind) takes its room back; rooms it left before end', async ($, on) => {
  const asked = world(on, {
    env: { CLAUDE_CODE_HOST_SESSION_ID: 'local_0000d351-0000-4000-8000-000000000001' },
    store: {
      'hosting:cli-old': savedRoom('room0000000000000009', 900, { place: 'local_0000d351-0000-4000-8000-000000000001' }),
      // Saved before places were: the sidebar row's id is Desktop's.
      'hosting:cli-older': savedRoom('room0000000000000008', 500, { sidebar: 'local_0000d351-0000-4000-8000-000000000001' }),
      'hosting:cli-other': savedRoom('room0000000000000007', 950, { place: 'local_0000d352-0000-4000-8000-000000000002' }),
    },
  })
  on('session.id', () => ({ value: 'cli-new' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await asked.clock.advance(10)
  expect(asked.logged).toContain('Still sharing this session: http://localhost:8787/s/room0000000000000009')
  expect(asked).toContain('POST /api/rooms/room0000000000000008/end')
  // Another Desktop session's room is its own.
  expect(asked.some(a => a.includes('room0000000000000007'))).toBe(false)
})

const NAMED = { CLAUDE_CODE_PLUGIN_DIRS: '/home/scott/.claude/shared-session/plugin', CLAUDE_CODE_PLUGIN_DIR_WATCH: '1' }
const KNOWN = '/home/scott/.claude/plugins/known_marketplaces.json'
const LIVE = '/home/scott/.claude/shared-session/plugin/.claude-plugin/plugin.json'

test('in Claude Desktop, a copy installed from a local marketplace folder says how to update in place', async ($, on) => {
  const asked = world(on, {
    latest: '9.9.9',
    settings: JSON.stringify({ env: NAMED, extraKnownMarketplaces: { 'claude-share': { source: { source: 'directory', path: '/home/scott/claude-share' }, autoUpdate: true } } }),
    files: { [LIVE]: '{}', [KNOWN]: JSON.stringify({ 'claude-share': { source: { source: 'directory', path: '/home/scott/claude-share' }, autoUpdate: true } }) },
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const command = 'claude plugin marketplace remove claude-share && claude plugin marketplace add Paradigm-Study/claude-share && claude plugin install shared-session@claude-share'
  expect(asked.logged.some(l => l.includes('9.9.9 is out') && l.includes('local marketplace folder') && l.includes(command))).toBe(true)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect(await pane.find({ type: 'Text', text: /runs the copy installed from your local marketplace folder/ })).toBeDefined()
  expect(await pane.find({ key: 'copy-switch' })).toBeDefined()
})

test('a GitHub marketplace in Claude Desktop shows no such note', async ($, on) => {
  const asked = world(on, {
    settings: JSON.stringify({ env: NAMED, extraKnownMarketplaces: { 'claude-share': { source: { source: 'github', repo: 'Paradigm-Study/claude-share' }, autoUpdate: true } } }),
    files: { [LIVE]: '{}', [KNOWN]: JSON.stringify({ 'claude-share': { source: { source: 'github', repo: 'Paradigm-Study/claude-share' }, autoUpdate: true } }) },
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect(await pane.find({ key: 'copy-switch' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /next new session on, a release loads in place/ })).toBeDefined()
})

test('a marketplace added again keeps automatic updates when updates in place were chosen', async ($, on) => {
  const asked = world(on, {
    settings: JSON.stringify({ theme: 'dark', env: NAMED, extraKnownMarketplaces: { 'claude-share': { source: { source: 'github', repo: 'Paradigm-Study/claude-share' } } } }),
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const saved = JSON.parse(asked.written.at(-1)?.text ?? '{}')
  expect(saved.extraKnownMarketplaces['claude-share']).toEqual({ source: { source: 'github', repo: 'Paradigm-Study/claude-share' }, autoUpdate: true })
  expect(saved.env).toEqual(NAMED)
  expect(saved.theme).toBe('dark')
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

test('signing in opens the browser with only a hash of the secret, and keeps the sign-in where only this user reads it', async ($, on) => {
  const asked = world(on)
  await $.command.run({ command: 'team' } as never)
  expect(asked.opened).toContain('shared-team')
  await asked.clock.advance(10)
  const pane = await $.ui.mount(TEAM_PANE)
  await pane.press({ key: 'signin-github' })
  const browser = await eventually(asked.clock, () => asked.spawned.find(s => s.input?.includes('/auth/github/start?login=')))
  const login = /login=([0-9a-f]{64})/.exec(browser?.input ?? '')?.[1]
  expect(login).toBeDefined()
  await asked.clock.advance(2_100)
  const poll = await eventually(asked.clock, () => asked.sent.find(r => r.path === '/api/auth/poll'))
  const verifier = String(poll?.body.verifier ?? '')
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  expect([...digest].map(b => b.toString(16).padStart(2, '0')).join('')).toBe(login)
  expect(asked.urls.some(u => u.includes(verifier))).toBe(false)
  // Saved through a umask, the token on stdin, never in arguments or an address.
  const save = await eventually(asked.clock, () => asked.spawned.find(s => s.input?.startsWith('umask 077')))
  expect(save?.input).toContain(TEAM_TOKEN)
  expect(asked.spawned.some(s => s.argv.join(' ').includes('ssa_'))).toBe(false)
  expect(asked.urls.some(u => u.includes('ssa_'))).toBe(false)
  expect(JSON.parse(asked.files.get(ACCOUNT_FILE) ?? '{}').servers['http://localhost:8787'].token).toBe(TEAM_TOKEN)
  await eventually(asked.clock, () => asked.sent.some(r => r.path === '/api/teams/team0001'))
  await asked.clock.advance(10)
  expect(await pane.find({ type: 'Text', text: 'Acme' })).toBeDefined()
})

test('signed in with a team, Share goes to it, the sign-in in a header and never an address', async ($, on) => {
  const asked = world(on, { team: { signedIn: true } })
  await $.command.run({ command: 'team', args: 'sessions' } as never)
  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ key: 'share' }))?.props.label).toBe('Share with Acme')
  await ui.press({ key: 'share' })
  const made = asked.sent.find(r => r.path === '/api/rooms')
  expect(made?.body.team).toBe('team0001')
  expect(made?.headers['x-shared-session-account']).toBe(TEAM_TOKEN)
  expect(asked.urls.some(u => u.includes('ssa_'))).toBe(false)
  expect(asked.logged.some(l => l.startsWith('Sharing with Acme. Everyone in Acme sees it in their Team panel and can join; the link works only for people in Acme'))).toBe(true)
})

test('/share-session link shares by link alone, even signed in', async ($, on) => {
  const asked = world(on, { team: { signedIn: true } })
  const r = await $.command.run({ command: 'share-session', args: 'link' } as never)
  await asked.clock.advance(100)
  expect(asked.sent.find(x => x.path === '/api/rooms')?.body.team).toBeUndefined()
  expect(asked.sent.find(x => x.path === '/api/rooms')?.headers['x-shared-session-account']).toBeUndefined()
  expect(JSON.stringify(r)).toContain('Anyone with this link can join')
})

test("the Team panel lists the team's live sessions; Join in a fresh session joins here, the sign-in sent", async ($, on) => {
  const asked = world(on, { team: { signedIn: true, sessions: [teamSession(1), teamSession(2, 'Kim')] } })
  await $.command.run({ command: 'team' } as never)
  await asked.clock.advance(10)
  const pane = await $.ui.mount(TEAM_PANE)
  expect(await pane.find({ type: 'Text', text: 'demo: work 1' })).toBeDefined()
  expect((await pane.find({ key: 'join-all' }))?.props.label).toBe('Join all 2')
  await pane.press({ key: 'join-room0000000000000101' })
  const join = await eventually(asked.clock, () => asked.sent.find(r => r.path === '/api/rooms/room0000000000000101/join'))
  expect(join?.headers['x-shared-session-account']).toBe(TEAM_TOKEN)
  await eventually(asked.clock, () => asked.submitted.some(p => p.text === "Join Sam's session"))
  expect(asked.submitted.some(p => p.text === "Join Sam's session")).toBe(true)
  const row = await $.ui.mount(band('desktop'))
  expect((await row.find({ type: 'Text', text: /Sam's session/ }))?.props.bold).toBe(true)
})

test('Join all from a session in use opens a new Claude Desktop session, and each that joins opens the next', async ($, on) => {
  const asked = world(on, { team: { signedIn: true, sessions: [teamSession(1), teamSession(2, 'Kim')] }, history: [{ role: 'user', content: 'Fix the build' }] })
  await $.command.run({ command: 'team', args: '' } as never)
  await asked.clock.advance(10)
  const pane = await $.ui.mount(TEAM_PANE)
  await pane.press({ key: 'join-all' })
  // Desktop holds one new-session draft at a time: one opens, the other waits.
  const deep = () => asked.spawned.filter(s => s.input?.includes('claude://code/new?q='))
  expect(deep().length).toBe(1)
  expect(deep()[0]?.input).toContain(encodeURIComponent('http://localhost:8787/s/room0000000000000101'))
  expect(asked.sent.some(r => r.path.endsWith('/join'))).toBe(false)
  // The session it opened joins (here, as the same store stands in for it): the next opens.
  await $.prompt.submit({ text: 'http://localhost:8787/s/room0000000000000101', origin: { kind: 'composer' }, wait: false })
  await eventually(asked.clock, () => deep().length === 2)
  expect(deep().length).toBe(2)
  expect(deep()[1]?.input).toContain(encodeURIComponent('http://localhost:8787/s/room0000000000000102'))
})

test("a members-only session refuses someone not signed in, and the Team panel opens to sign in", async ($, on) => {
  const asked = world(on, { team: { refuseJoin: true } })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await eventually(asked.clock, () => asked.opened.includes('shared-team'))
  expect(asked.opened).toContain('shared-team')
  const row = await $.ui.mount(band('desktop'))
  expect(await row.find({ key: 'share' })).toBeDefined() // still not joined
})

test('an invite link pasted joins the team when signed in; signed out, signing in carries it', async ($, on) => {
  const asked = world(on)
  await $.prompt.submit({ text: 'http://localhost:8787/i/invite0001', origin: { kind: 'composer' }, wait: false })
  await eventually(asked.clock, () => asked.opened.includes('shared-team'))
  expect(asked.opened).toContain('shared-team')
  const pane = await $.ui.mount(TEAM_PANE)
  await pane.press({ key: 'signin-google' })
  expect(await eventually(asked.clock, () => asked.spawned.some(s => s.input?.includes('/auth/google/start?login=') && s.input.includes('&invite=invite0001')))).toBe(true)
  await asked.clock.advance(2_100)
  await eventually(asked.clock, () => asked.files.has(ACCOUNT_FILE))
  // Signed in now: another invite is taken at once.
  await $.prompt.submit({ text: 'http://localhost:8787/i/invite0002', origin: { kind: 'composer' }, wait: false })
  const taken = await eventually(asked.clock, () => asked.sent.find(r => r.path === '/api/invites/invite0002'))
  expect(taken?.headers.authorization).toBe(`Bearer ${TEAM_TOKEN}`)
})
