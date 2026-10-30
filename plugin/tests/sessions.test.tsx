// A session's history, files and stream; places kept and taken back; Shares
// and joins that meet each other.

import { expect, test } from 'claude-code/testing'
import {
  SURFACES,
  LINK,
  band,
  savesOf,
  world,
  eventually,
  TEAM_PANE,
  teamSession,
  FROM_AGENT,
  PEER_ENV,
  PEER_TRANSCRIPT,
  MSG,
  CHAIN,
  peerRow,
  guestJoined,
  PANE,
  HISTORY,
  savedRoom,
  START,
  checkpointPath,
  savedAt,
  holding,
  INVITE,
  STEP,
  roomProfile,
  roomPane,
  hostAsked,
  allowShow,
  TRANSCRIPT,
  transcriptRow,
  within,
} from './support/world'

// The kit's own timer, in real time, which the mocked clock never moves: for
// what the engine counts in real time (a hook's 10 s budget).
declare const setTimeout: (done: () => void, ms: number) => unknown

test('a session reopened after a compaction shares its whole history, from the file before too, and asks first', async ($, on) => {
  const row = (o: Record<string, unknown>) => JSON.stringify(o)
  const old = '/home/scott/.claude/projects/-tmp-demo/session-a-0001.jsonl'
  const now = '/home/scott/.claude/projects/-tmp-demo/session-b-0002.jsonl'
  const asked = world(on, {
    sessionId: 'session-b-0002',
    transcripts: {
      [old]: [
        row({ type: 'user', uuid: 'a1', parentUuid: null, message: { role: 'user', content: 'First prompt, in the old file' } }),
        row({
          type: 'assistant',
          uuid: 'a2',
          parentUuid: 'a1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'An answer from before the compaction' }] },
        }),
        row({ type: 'attachment', uuid: 'x1', parentUuid: 'a2' }),
        row({
          type: 'assistant',
          uuid: 'a3',
          parentUuid: 'x1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Copied into the new file too' }] },
        }),
      ].join('\n'),
      [now]: [
        row({ type: 'attachment', uuid: 'x1', parentUuid: 'a2' }),
        row({ type: 'user', uuid: 'b1', parentUuid: 'x1', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued…' } }),
        row({
          type: 'assistant',
          uuid: 'b2',
          parentUuid: 'b1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Copied into the new file too' }] },
        }),
        row({ type: 'user', uuid: 'b3', parentUuid: 'b2', message: { role: 'user', content: 'A prompt after reopening' } }),
      ].join('\n'),
    },
  })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
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
  await ui.press({ key: 'share-prompt' })
  await $.tool.call({
    tool: 'Artifact',
    file_path: '/tmp/demo/mkt/index.html',
    root: 'mkt',
    files: { 'img/01-start.jpg': 'img/01-start.jpg', '../escape.txt': 'x.txt' },
  } as never)
  await asked.clock.advance(200)
  const uploaded = asked.spawned
    .filter(s => s.argv[0] === '/bin/sh' && s.input?.includes('/files"'))
    .map(s => /--data-binary @'([^']+)'/.exec(s.input ?? '')?.[1])
  expect(uploaded).toEqual(['/tmp/demo/mkt/index.html', '/tmp/demo/mkt/img/01-start.jpg', '/tmp/demo/mkt/x.txt'])
  const page = asked.posted.find(e => e.type === 'artifact')
  expect(page?.body.kind).toBe('page')
  // Each file's place beside the page; never outside it.
  expect((page?.body.files as { path?: string }[]).map(f => f.path)).toEqual(['index.html', 'img/01-start.jpg', 'escape.txt'])
})

test('a guest saves a page and the files beside it in a folder of its own, and opens it from the Room', async ($, on) => {
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
  await pane.press({ key: 'tab-shown' })
  expect(await pane.find({ type: 'Text', text: /index\.html \(a page and 1 file\)/ })).toBeDefined()
  await pane.press({ key: 'open-seq:2' })
  await asked.clock.advance(200)
  const dir = `/tmp/demo/.shared-session/Sam/page-${'b'.repeat(8)}`
  expect(savesOf(asked.spawned)).toEqual([`${dir}/index.html`, `${dir}/img/01-start.jpg`])
  expect(opened).toContain(`Claude_Browser.preview_start {"url":"file://${dir}/index.html"}`)
})

test("Claude asking for the share command itself hears where things stand, never that the plugin isn't running", async ($, on) => {
  const asked = world(on)
  const idle = await $.tool.call({ tool: 'Skill', skill: 'shared-session:share-session' } as never)
  expect(JSON.stringify(idle)).toContain('Sharing starts only when the person chooses it')
  expect(asked).not.toContain('POST /api/rooms') // Claude never starts it
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  const shared = await $.tool.call({ tool: 'Skill', skill: 'shared-session:share-session' } as never)
  expect(JSON.stringify(shared)).toContain('already shared (http://localhost:8787/s/room0000000000000002)')
})

test('a page opened again goes to the room again with its files, even one published before, and Claude hears it went', async ($, on) => {
  const ART = 'https://claude.ai/artifact/8nAyoRXM6doAg4ZND1fZ26'
  const history = [
    { role: 'user', content: 'Make the asset pack' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_pub',
          name: 'Artifact',
          input: { file_path: '/tmp/demo/mkt/index.html', root: 'mkt', files: { 'img/01.jpg': 'img/01.jpg' } },
        },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_pub', content: `Published /tmp/demo/mkt/index.html at ${ART} (Version 1)` }] },
  ]
  const asked = world(on, { history })
  on('tool.call', { tool: 'Artifact' }, () => ({ result: `Opened the Artifact at ${ART} for the user.` }) as never)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
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
  await $.prompt.submit({
    text: 'claude plugin marketplace update claude-share && claude plugin update shared-session@claude-share',
    origin: { kind: 'composer' },
    wait: false,
  })
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
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20_000)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect(await pane.find({ type: 'Text', text: /^on 0\.6\.0 · update to / })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^on 0\.7\.1 · update to / })).toBeUndefined()
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
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(2_000)
  const saved = `/tmp/demo/.shared-session/Alex/${'d'.repeat(6)}-shot.png`
  expect(savesOf(asked.spawned)).toContain(saved)
  const sent = asked.submitted.find(p => p.text.startsWith('Alex: What is this?'))
  expect(sent?.text).toBe(`Alex: What is this?\n\n📎 .shared-session/Alex/${'d'.repeat(6)}-shot.png (attached by Alex; open it with the Read tool to see it)`)
})

test("a host named `..` has its files saved in .shared-session/host, never the guest's project folder", async ($, on) => {
  const people = [
    { id: 'host', name: '..', role: 'host', online: true },
    { id: 'seat1', name: 'scott', role: 'guest', online: true },
  ]
  const files = [{ id: 'b'.repeat(64), name: 'package.json', type: 'application/json', size: 42 }]
  const shown = { seq: 2, type: 'artifact', ts: 900, from: { seat: 'host', name: '..', role: 'host' }, body: { kind: 'file', files } }
  const asked = world(on, { hostName: '..', stream: [{ seq: 2, events: [shown], people, ended: false, title: 'demo' }] })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-seq:2' })
  await asked.clock.advance(200)
  const saves = asked.spawned.filter(s => s.argv[1]?.endsWith('/relay/save.sh'))
  expect(savesOf(asked.spawned)).toEqual(['/tmp/demo/.shared-session/host/package.json'])
  // The project it must stay inside, and curl's settings on stdin, never argv.
  expect(saves[0]!.argv[2]).toBe('/tmp/demo')
  expect(saves[0]!.argv.join(' ')).not.toContain('Bearer')
  expect(saves[0]!.input).toContain('header = "Authorization: Bearer g"')
})

test("a guest named `..` has their attachment saved in .shared-session/guest on the host, never the host's project folder", async ($, on) => {
  const people = [
    { id: 'host', name: 'scott', role: 'host', online: true },
    { id: 'seat2', name: '..', role: 'guest', online: true },
  ]
  const prompt = {
    seq: 2,
    type: 'prompt',
    ts: 900,
    from: { seat: 'seat2', name: '..', role: 'guest' },
    body: { text: 'What is this?', pid: 'p1', attachments: [{ id: 'd'.repeat(64), name: 'shot.png', type: 'image/png', size: 68 }] },
  }
  const asked = world(on, { stream: [{ seq: 2, events: [prompt], people, ended: false, title: 'demo' }] })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(2_000)
  // Every place it was saved (the test's stream brings the prompt again on each reconnect).
  expect([...new Set(savesOf(asked.spawned))]).toEqual([`/tmp/demo/.shared-session/guest/${'d'.repeat(6)}-shot.png`])
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
  await pane.press({ key: 'tab-settings' })
  expect(await pane.find({ key: 'auto-open' })).toBeDefined()
  await pane.select({ key: 'auto-open', value: 'ask' })
  await pane.unmount()
  // The Room opens again on the page it was left on.
  const again = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect((await again.find({ key: 'auto-open' }))?.props.value).toBe('ask')
})

test('Share in a session with history asks first; "Only from now on" sends none of it', async ($, on) => {
  const asked = world(on, { history: HISTORY })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    await ui.press({ key: 'share' })
    await ui.press({ key: 'share-prompt' })
    expect(asked).not.toContain('POST /api/rooms') // nothing leaves until they choose
    expect(await ui.find({ type: 'Text', text: 'Share this session?' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 earlier prompts/ })).toBeDefined()
    await ui.press({ key: 'share-cancel' })
    expect(await ui.find({ key: 'share' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await ui.press({ key: 'share-new' })
  expect(asked).toContain('POST /api/rooms')
  await asked.clock.advance(100)
  expect(asked.posted.filter(e => e.type === 'row')).toHaveLength(0)
})

test('"Share everything" sends the history', async ($, on) => {
  const asked = world(on, { history: HISTORY })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await ui.press({ key: 'share-all' })
  await asked.clock.advance(100)
  expect(asked.posted.filter(e => e.type === 'row').length).toBeGreaterThan(0)
  expect((await ui.find({ type: 'Text', text: /^Sharing$/ }))?.props.bold).toBe(true)
})

test("a subagent's run is no new prompt for the room, and the host's own turn still ends", async ($, on) => {
  const asked = world(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(50)
  await $.turn.start({ turnId: 'main', text: 'Find the flaky test' })
  await $.turn.start({ turnId: 'sub', text: 'Search the repo for retries', agentId: 'agent-1' } as never)
  await $.turn.complete({ turnId: 'sub', agentId: 'agent-1', isAborted: false, durationMs: 0, reason: 'answer' } as never)
  await $.turn.complete({ turnId: 'main', isAborted: false, durationMs: 0, reason: 'answer' } as never)
  await asked.clock.advance(100)
  const turns = asked.posted.filter(e => e.type === 'turn').map(e => [e.body.state, e.body.turnId])
  expect(turns).toEqual([
    ['start', 'main'],
    ['end', 'main'],
  ])
})

test('a prompt the host types mid-turn goes to the room once, as it goes in, not as it waits', async ($, on) => {
  const asked = world(on)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(50)
  const message = { type: 'user', role: 'user', content: [{ type: 'text', text: 'Also check the docs' }] }
  await $.session.append({ message, door: 'queue', origin: { kind: 'composer' }, uuid: 'q1' } as never)
  await asked.clock.advance(100)
  expect(asked.posted.filter(e => e.type === 'row')).toHaveLength(0)
  await $.session.append({ message, door: 'prompt', origin: { kind: 'composer' }, uuid: 'p1' } as never)
  await asked.clock.advance(100)
  expect(asked.posted.filter(e => e.type === 'row').map(e => e.body.text)).toEqual(['Also check the docs'])
})

test('"Share everything" opens the dev servers Claude opened before, still running, at the page it was on', async ($, on) => {
  const asked = world(on, {
    history: [
      { role: 'user', content: 'Build the course sheet' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_a',
            name: 'mcp__Claude_Browser__browser_batch',
            input: { actions: [{ name: 'navigate', input: { url: 'http://localhost:3340/dev/start' } }] },
          },
          {
            type: 'text',
            text: 'Built: http://localhost:3340/dev/course-sheet (the old app is at http://localhost:3320/home; the database at http://localhost:5432)',
          },
        ],
      },
    ],
    surfaces: ['desktop'],
  })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await ui.press({ key: 'share-all' })
  // Nothing goes until the host says so.
  await asked.clock.advance(200)
  expect(asked.posted.filter(e => e.type === 'artifact')).toEqual([])
  await allowShow(asked, ui)
  await asked.clock.advance(200)
  const previews = asked.posted.filter(e => e.type === 'artifact' && e.body.kind === 'preview')
  // 3320 isn't answering; 5432 answers, but not as a web server (a database): neither is shared.
  // 3340 at the page the browser was on: mentioned after, course-sheet doesn't move it (live, a mention of a shared port doesn't either).
  expect(previews.map(e => [e.body.port, e.body.path])).toEqual([[3340, '/dev/start']])
  // Shared because Claude mentioned it: through its link, never forwarded.
  expect(previews[0]?.body.tcp).toBeUndefined()
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body)).toEqual([{ port: 3340, title: 'localhost:3340' }])
})

test("a page the host's Claude opens with browser_batch goes to the room, once the host says so", async ($, on) => {
  const asked = world(on, { surfaces: ['desktop'] })
  on('tool.call', { tool: 'mcp__Claude_Browser__browser_batch' }, () => ({ result: [], text: 'navigated' }) as never)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.tool.call({
    tool: 'mcp__Claude_Browser__browser_batch',
    actions: [
      { name: 'navigate', input: { url: 'http://localhost:5173/settings' } },
      { name: 'computer', input: { action: 'screenshot' } },
    ],
  } as never)
  expect(await hostAsked(ui)).toBe('Share localhost:5173 with the room?')
  await allowShow(asked, ui, 5173)
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
    expect(await ui.find({ type: 'Text', text: /Reconnecting/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /goes out once it's back/ })).toBeDefined()
    await ui.unmount()
  }
})

// A connection that died without a word (Wi-Fi changed, a VPN reconnected)
// still looks open: only the room's lines stopping says so.
test('a stream quiet for 35 s is given up, says Reconnecting at once, and opens again', async ($, on) => {
  let held: Promise<void> | null = null
  let release = () => {}
  const asked = await guestJoined($, on, { streamHeld: () => held ?? Promise.resolve() })
  const streams = () => asked.spawned.filter(s => s.argv[0] === 'curl' && s.input?.includes('/stream?after=')).length
  // Live until it's ever written otherwise.
  const connection = () => asked.state.connection ?? 'live'
  expect(await within(asked.clock, () => connection() === 'live' && streams() === 1, 1_000)).toBe(true)
  held = new Promise<void>(done => (release = done))
  // Keepalives every 10 s: three missed is still a quiet room.
  await asked.clock.advance(30_000)
  expect([streams(), connection()]).toEqual([1, 'live'])
  // Past 35 s, looked at every 5 s: given up, said at once, opened again.
  await asked.clock.advance(12_000)
  expect([streams(), connection()]).toEqual([2, 'reconnecting'])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ type: 'Text', text: /Reconnecting/ })).toBeDefined()
    await ui.unmount()
  }
  // The room answers on the new one: live again.
  release()
  expect(await within(asked.clock, () => connection() === 'live', 1_000)).toBe(true)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// The watchdog's own look at the row's state takes a moment; a room made
// meanwhile is another stream's to describe.
test("a quiet stream's Reconnecting never lands on the room that replaced it", async ($, on) => {
  const hold = { armed: false, held: false }
  let release!: () => void
  const holding = new Promise<void>(done => (release = done))
  on('state.get', async ($, e, next) => {
    const got = await next(e)
    if (hold.armed && !hold.held && e.plugin === 'shared-session' && e.key === 'connection') {
      hold.held = true
      await holding
    }
    return got
  })
  const asked = await guestJoined($, on)
  const streams = () => asked.spawned.filter(s => s.argv[0] === 'curl' && s.input?.includes('/stream?after=')).length
  const connection = () => asked.state.connection ?? 'live'
  expect(await within(asked.clock, () => streams() === 1, 1_000)).toBe(true)
  // Past 35 s quiet: its watchdog looks at the row's state, held there.
  hold.armed = true
  await asked.clock.advance(42_000)
  expect(hold.held).toBe(true)
  // Meanwhile this session leaves and shares a room of its own, whose stream answers.
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  expect(await within(asked.clock, () => streams() === 2 && asked.state.mode === 'host', 5_000)).toBe(true)
  release()
  // Healthy keepalives on the new stream: it stays live.
  for (let i = 0; i < 3; i++) {
    asked.lines.push({ t: i })
    await asked.clock.advance(10_000)
  }
  expect([streams(), connection()]).toEqual([2, 'live'])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('every request says the plugin version, and a newer one shows in the Room with its command', async ($, on) => {
  const asked = world(on, { latest: '9.9.9', settings: '{}' })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  expect(asked.versions.length).toBeGreaterThan(0)
  expect(asked.versions.every(v => v === '0.7.1')).toBe(true)
  expect(asked.logged.some(line => line.includes('9.9.9 is out'))).toBe(true)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-settings' })
  expect(await pane.find({ type: 'Text', text: /Version 9\.9\.9 is out \(this session runs 0\.7\.1\)/ })).toBeDefined()
  // Updates off: it installs for new sessions, and offers to load later ones in place.
  expect((await pane.find({ key: 'update-now' }))?.props.label).toBe('Install update')
  expect(await pane.find({ key: 'updates-on' })).toBeDefined()
})

test("the Room's Update runs the update command on this computer and says on its line what it did", async ($, on) => {
  const installed = JSON.stringify({
    version: 2,
    plugins: {
      'shared-session@claude-share': [{ scope: 'user', installPath: '/home/scott/.claude/plugins/cache/claude-share/shared-session/9.9.9', version: '9.9.9' }],
    },
  })
  const asked = world(on, { latest: '9.9.9', settings: '{}', files: { '/home/scott/.claude/plugins/installed_plugins.json': installed } })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-settings' })
  await pane.press({ key: 'update-now' })
  await asked.clock.advance(100)
  const run = asked.spawned.find(s => s.input?.includes('plugin update shared-session@claude-share'))
  expect(run?.input).toContain('plugin marketplace update claude-share')
  const said =
    'Shared Sessions 9.9.9 is installed here. Start a new session to use it (in Claude Desktop, quit and reopen the app); with Updates on in the Room, later releases load in place.'
  expect(await pane.find({ type: 'Text', text: said })).toBeDefined()
  expect(asked.logged).toContain(said)
  // Two minutes on, the line goes.
  await asked.clock.advance(121_000)
  expect(await pane.find({ type: 'Text', text: said })).toBeUndefined()
})

test("the Team panel's header says a newer release is out, with its Update", async ($, on) => {
  const asked = world(on, { latest: '9.9.9', team: { signedIn: true, sessions: [teamSession(2, 'Kim')] } })
  // The server names the newest release in its answers (a join's here).
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  await $.command.run({ command: 'team' } as never)
  await asked.clock.advance(10)
  const pane = await $.ui.mount(TEAM_PANE)
  expect(await pane.find({ type: 'Text', text: '● 9.9.9 is out' })).toBeDefined()
  expect((await pane.find({ key: 'update-now' }))?.props.label).toBe('Install update')
  // The header keeps to the button: Turn on Updates is the Room's.
  expect(await pane.find({ key: 'updates-on' })).toBeUndefined()
})

test("the Room's Updates setting turns on auto-update in the person's settings, keeping the rest", async ($, on) => {
  const asked = world(on, { settings: '{\n  "theme": "dark"\n}\n' })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-settings' })
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

test('automatic updates chosen outside the Room (setup.ts) load in place, keeping other plugin folders', async ($, on) => {
  const asked = world(on, {
    settings: JSON.stringify({
      env: { CLAUDE_CODE_PLUGIN_DIRS: '/home/scott/mods/other' },
      extraKnownMarketplaces: { 'claude-share': { source: { source: 'github', repo: 'Paradigm-Study/claude-share' }, autoUpdate: true } },
    }),
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const saved = JSON.parse(asked.written.at(-1)?.text ?? '{}')
  expect(saved.env.CLAUDE_CODE_PLUGIN_DIRS).toBe('/home/scott/mods/other:/home/scott/.claude/shared-session/plugin')
  expect(asked.logged.some(l => l.includes('updates in place'))).toBe(true)
})

for (const role of ['host', 'guest'] as const) {
  test(`${role} checkpoint survives a loader store change and is gone after Stop or Leave`, async ($, on) => {
    const asked = world(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    await $.session.start(START)
    if (role === 'host') await $.command.run({ command: 'share-session', args: 'new' } as never)
    else await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
    await $.session.end({ reason: 'other', sessionId: 'session-test-0001', resume: {} } as never)
    const key = `${role === 'host' ? 'hosting' : 'joined'}:session-test-0001`
    expect(savedAt(asked, key).room.seat === 'host').toBe(role === 'host')
    // The next loader identity has none of this identity's plugin store.
    asked.store.clear()
    await $.session.start(START)
    const ui = await $.ui.mount(band('desktop'))
    expect(await ui.find({ key: role === 'host' ? 'stop-sharing' : 'leave' })).toBeDefined()
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
    expect(asked.files.has(checkpointPath(key))).toBe(false)
    await $.session.start(START)
    expect(await ui.find({ key: 'share' })).toBeDefined()
    expect(asked.spawned.filter(s => s.input?.includes('/shared-session/rooms/')).every(s => JSON.stringify(s.argv) === '["/bin/sh","-s"]')).toBe(true)
  })
}

test("a custom configuration's places are its own, and an unrelated session's stays", async ($, on) => {
  const config = '/home/scott/claude-work'
  const mine = savedRoom('room0000000000000009', 950)
  const other = savedRoom('room0000000000000007', 900)
  const asked = world(on, {
    env: { CLAUDE_CONFIG_DIR: config },
    sessionId: 'mine',
    files: {
      [checkpointPath('hosting:mine', config)]: JSON.stringify({ version: 1, value: mine }),
      [checkpointPath('hosting:other', config)]: JSON.stringify({ version: 1, value: other }),
    },
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  expect(asked.logged).toContain(`Still sharing this session: ${mine.room.url}`)
  expect(savedAt(asked, 'hosting:other', config)).toEqual(other)
  expect([...asked.files.keys()].some(path => path.startsWith('/home/scott/.claude/shared-session/rooms/'))).toBe(false)
})

test('an unreadable checkpoint is left as it is, and nothing of it is logged', async ($, on) => {
  const corrupt = 'private-checkpoint-token is not JSON'
  const asked = world(on, { sessionId: 'mine', files: { [checkpointPath('hosting:mine')]: corrupt } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  expect(asked.files.get(checkpointPath('hosting:mine'))).toBe(corrupt)
  expect(asked.logged.join('\n')).not.toContain('private-checkpoint-token')
})

test('a failed new checkpoint write leaves the previous file intact and reports the failure', async ($, on) => {
  const asked = world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.command.run({ command: 'share-session', args: 'new' } as never)
  const path = checkpointPath('hosting:session-test-0001')
  const previous = JSON.stringify({ version: 1, value: savedRoom('room0000000000000009', 900) })
  asked.files.set(path, previous)
  asked.checkpointWrites.fail = true
  await $.session.end({ reason: 'other', sessionId: 'session-test-0001', resume: {} } as never)
  expect(asked.files.get(path)).toBe(previous)
  expect(asked.logged.some(line => line.includes("Couldn't save the shared session for reopening"))).toBe(true)
})

test('a host session reopened takes its room back, on the same link', async ($, on) => {
  const asked = world(on, {
    files: { [checkpointPath('hosting:cli-1')]: JSON.stringify({ version: 1, value: savedRoom('room0000000000000009', 900) }) },
    sessionId: 'cli-1',
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await asked.clock.advance(10)
  expect(asked.logged).toContain('Still sharing this session: http://localhost:8787/s/room0000000000000009')
})

// A room saved on a plain http server elsewhere isn't taken up again, a
// host's or a guest's: its token would go with the first request. (One on
// this computer is: the test above.)
const PLAIN_SAVED =
  "This session's room is on http://share.test, plain http, which would send its tokens unencrypted, so it isn't taken up again. Share or join again through an https:// server."

const tokenWent = (asked: ReturnType<typeof world>, token: string) => [
  ...asked.sent.filter(x => JSON.stringify(x.headers).includes(token) || JSON.stringify(x.body).includes(token)),
  ...asked.spawned.filter(p => JSON.stringify(p).includes(token)),
]

test("a host's room saved on a plain http server elsewhere isn't taken up again, and its token goes nowhere", async ($, on) => {
  const saved = savedRoom('room0000000000000009', 900)
  const plain = { ...saved, room: { ...saved.room, server: 'http://share.test', url: 'http://share.test/s/room0000000000000009' } }
  const asked = world(on, { files: { [checkpointPath('hosting:cli-1')]: JSON.stringify({ version: 1, value: plain }) }, sessionId: 'cli-1' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await asked.clock.advance(5_000)
  expect(asked.logged).toContain(PLAIN_SAVED)
  expect(asked.state.room ?? null).toBeNull()
  expect(tokenWent(asked, plain.room.token)).toEqual([])
  expect(asked.urls.filter(u => u.startsWith('http://share.test'))).toEqual([])
})

test("a guest's place saved on a plain http server elsewhere isn't taken up again, and its token goes nowhere", async ($, on) => {
  const plain = {
    ...JOINED_PLACE,
    room: { ...JOINED_PLACE.room, server: 'http://share.test', url: 'http://share.test/s/room0000000000000001', token: 'g-plain-token' },
  }
  const asked = world(on, { files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: plain }) } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await asked.clock.advance(5_000)
  expect(asked.logged).toContain(PLAIN_SAVED)
  expect(asked.state.room ?? null).toBeNull()
  expect(tokenWent(asked, 'g-plain-token')).toEqual([])
  expect(asked.urls.filter(u => u.startsWith('http://share.test'))).toEqual([])
})

// A guest's place, as a session closing saves it.
const JOINED_PLACE = {
  at: 900,
  room: { server: 'https://share.test', id: 'room0000000000000001', url: LINK, title: 'demo', host: 'Sam', token: 'g', seat: 'seat1', seq: 2, since: 1 },
  autoOpen: true,
  policy: { prompts: 'everyone', approvals: 'edits', files: 'on' },
  shown: [],
  localPreviews: [],
  activity: [],
  chat: [],
  sidebar: null,
}

// A place being taken back (the room's first answer still on its way) when
// the session ends: closing, it's saved again for the next start; a /clear
// leaves the room instead (a host's ends). The resume then writes nothing.
for (const role of ['guest', 'host'] as const) {
  for (const reason of ['other', 'clear'] as const) {
    test(`a ${role}'s place still being taken back ${reason === 'clear' ? 'leaves the room at a /clear' : 'is saved again when the session closes'}`, async ($, on) => {
      let answer: (() => void) | undefined
      const key = `${role === 'host' ? 'hosting' : 'joined'}:session-test-0001`
      const saved = role === 'host' ? savedRoom('room0000000000000009', 900) : JOINED_PLACE
      const asked = world(on, {
        files: { [checkpointPath(key)]: JSON.stringify({ version: 1, value: saved }) },
        beforeEvents: () =>
          answer
            ? Promise.resolve()
            : new Promise<void>(done => {
                answer = done
              }),
      })
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      on('session.end', ($, e) => ({ sessionId: e.sessionId }))
      const starting = $.session.start(START)
      expect(await eventually(asked.clock, () => Boolean(answer))).toBe(true)
      // Taken: no other session takes it meanwhile.
      expect(savedAt(asked, key)).toBeNull()
      await $.session.end({ reason, sessionId: 'session-test-0001', resume: {} } as never)
      answer!()
      await starting
      await asked.clock.advance(50)
      const now = savedAt(asked, key)
      if (reason === 'other') expect(now).toEqual(saved)
      else {
        expect(now).toBeNull()
        expect(asked).toContain(`POST /api/rooms/${saved.room.id}/${role === 'host' ? 'end' : 'leave'}`)
      }
      // Not in the room: the resume wrote nothing after the session's end.
      expect(asked.state.mode ?? 'idle').toBe('idle')
      expect(asked.state.room ?? null).toBeNull()
      expect(asked.logged.some(l => l.startsWith('Still sharing') || l.startsWith('Back in'))).toBe(false)
    })
  }
}

const SHARING_9 = `Sharing this session. Anyone with this link can join and prompt this session: http://localhost:8787/s/room0000000000000009`

// A room given up told it's over in the background (a host's ends, a guest
// leaves): one curl, bounded in time, its token on stdin, never in argv.
function toldOver(asked: ReturnType<typeof world>, room: { server: string; id: string; token: string }, how: 'end' | 'leave' = 'end') {
  const told = asked.spawned.filter(s => s.argv[0] === 'curl' && s.input?.includes(`url = "${room.server}/api/rooms/${room.id}/${how}"`))
  for (const s of told) {
    expect(s.input).toContain(`header = "Authorization: Bearer ${room.token}"`)
    expect(s.input).toContain('request = "POST"')
    expect(s.argv).toContain('--max-time')
    expect(s.argv.some(a => a === room.token || a.includes(`Bearer ${room.token}`) || a.includes(room.id))).toBe(false)
  }
  return told
}

test("/share-session while this session's room is being taken back makes no second room: the row and the Room offer no Share meanwhile, and it answers as a session sharing already", async ($, on) => {
  const held = holding()
  const saved = savedRoom('room0000000000000009', 900)
  const asked = world(on, { files: { [checkpointPath('hosting:session-test-0001')]: JSON.stringify({ version: 1, value: saved }) }, beforeEvents: held.wait })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  const ui = await $.ui.mount(band('desktop'))
  expect(await ui.find({ key: 'share' })).toBeUndefined()
  expect(await ui.find({ key: 'team' })).toBeDefined()
  const pane = await $.ui.mount(roomPane())
  expect(await pane.find({ key: 'room-share' })).toBeUndefined()
  let reply: unknown
  void $.command.run({ command: 'share-session', args: '' } as never).then(r => {
    reply = r
  })
  await asked.clock.advance(1_000)
  expect(reply).toBeUndefined()
  expect(asked).not.toContain('POST /api/rooms')
  held.release!()
  await starting
  expect(await within(asked.clock, () => reply, 3_000)).toEqual({ text: SHARING_9 })
  expect(asked).not.toContain('POST /api/rooms')
  expect(asked.state.room?.id).toBe('room0000000000000009')
  expect(asked.state.mode).toBe('host')
  expect(asked.logged).toContain('Still sharing this session: http://localhost:8787/s/room0000000000000009')
  expect(await ui.find({ key: 'stop-sharing' })).toBeDefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('/share-session while a room being taken back turns out gone waits for that, then shares a new room', async ($, on) => {
  const held = holding()
  const asked = world(on, {
    files: { [checkpointPath('hosting:session-test-0001')]: JSON.stringify({ version: 1, value: savedRoom('room0000000000000009', 900) }) },
    beforeEvents: held.wait,
    goneRoom: 'room0000000000000009',
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  let reply: unknown
  void $.command.run({ command: 'share-session', args: '' } as never).then(r => {
    reply = r
  })
  await asked.clock.advance(1_000)
  // It waits for the room's answer first.
  expect(reply).toBeUndefined()
  expect(asked).not.toContain('POST /api/rooms')
  held.release!()
  await starting
  expect(await within(asked.clock, () => reply, 3_000)).toEqual({
    text: 'Sharing this session. Anyone with this link can join and prompt this session: http://localhost:8787/s/room0000000000000002',
  })
  expect(asked.logged).toContain('The session you shared ended while this one was closed.')
  expect(asked.state.room?.id).toBe('room0000000000000002')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a room whose take-back hasn't come back in 10 s is ended for /share-session: it goes on in no room, and the take-back writes nothing after", async ($, on) => {
  const held = holding()
  const key = 'hosting:session-test-0001'
  const saved = savedRoom('room0000000000000009', 900)
  const asked = world(on, { files: { [checkpointPath(key)]: JSON.stringify({ version: 1, value: saved }) }, beforeEvents: held.wait })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  expect(savedAt(asked, key)).toBeNull()
  let reply: unknown
  void $.command.run({ command: 'share-session', args: '' } as never).then(r => {
    reply = r
  })
  await asked.clock.advance(9_000)
  expect(reply).toBeUndefined()
  expect(asked).not.toContain('POST /api/rooms')
  expect(toldOver(asked, saved.room)).toHaveLength(0)
  await within(asked.clock, () => reply, 3_000)
  expect(reply).toEqual({ text: 'Sharing this session. Anyone with this link can join and prompt this session: http://localhost:8787/s/room0000000000000002' })
  // Given up, it's over: the room ends (one bounded request, its token on
  // stdin), and its place isn't saved again for a start to take back.
  expect(toldOver(asked, saved.room)).toHaveLength(1)
  expect(savedAt(asked, key)).toBeNull()
  held.release!()
  await starting
  await asked.clock.advance(50)
  expect(asked.state.room?.id).toBe('room0000000000000002')
  expect(asked.logged.some(l => l.includes('room0000000000000009'))).toBe(false)
  // Nothing more of it: the request that hung, and the end.
  expect(asked.filter(a => a.includes('room0000000000000009'))).toEqual(['GET /api/rooms/room0000000000000009/events'])
  expect(toldOver(asked, saved.room)).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a link pasted while this session's place in a room is being taken back waits for it, then leaves that room for the new one, as a link pasted in a room does", async ($, on) => {
  const held = holding()
  const asked = world(on, {
    files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: JOINED_PLACE }) },
    beforeEvents: held.wait,
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  const other = 'https://share.test/s/room0000000000000003'
  const pasted = $.prompt.submit({ text: other, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(1_000)
  expect(asked.some(a => a.includes('room0000000000000003'))).toBe(false)
  held.release!()
  await starting
  await pasted
  await eventually(asked.clock, () => asked.state.room?.id === 'room0000000000000003')
  // Back in the first room, then left for the second, as in a room.
  const at = (call: string) => asked.indexOf(call)
  expect(asked.logged).toContain("Back in Sam's session.")
  expect(at('POST /api/rooms/room0000000000000001/leave')).toBeGreaterThan(at('GET /api/rooms/room0000000000000001/events'))
  expect(at('POST /api/rooms/room0000000000000003/join')).toBeGreaterThan(at('POST /api/rooms/room0000000000000001/leave'))
  expect(asked.state.mode).toBe('guest')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a prompt typed while this session's place in a room is being taken back goes to that room once it's back, never to this session's own Claude", async ($, on) => {
  const held = holding()
  const asked = world(on, {
    files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: JOINED_PLACE }) },
    beforeEvents: held.wait,
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  const typed = $.prompt.submit({ text: 'Run the tests', origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(500)
  held.release!()
  await starting
  await typed
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'prompt'))
  expect(asked.posted.filter(e => e.type === 'prompt').map(e => e.body.text)).toEqual(['Run the tests'])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("the Team panel's Join while this session's place in a room is being taken back waits for it, then opens a new session, as Join does in a room", async ($, on) => {
  const held = holding()
  const asked = world(on, {
    team: { signedIn: true, sessions: [teamSession(1)] },
    files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: JOINED_PLACE }) },
    beforeEvents: held.wait,
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.command.run({ command: 'team' } as never)
  await asked.clock.advance(10)
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  const pane = await $.ui.mount(TEAM_PANE)
  await pane.press({ key: 'join-room0000000000000101' })
  await asked.clock.advance(1_000)
  expect(asked.some(a => a.includes('room0000000000000101/join'))).toBe(false)
  held.release!()
  await starting
  await eventually(asked.clock, () => asked.externals.length)
  expect(asked.externals).toEqual([`claude://code/new?q=${encodeURIComponent('http://localhost:8787/s/room0000000000000101')}`])
  expect(asked.some(a => a.includes('room0000000000000101/join'))).toBe(false)
  expect(asked.state.room?.id).toBe('room0000000000000001')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("an invite shown while this session's room is being taken back offers no Join until it's back: then it waits in the room's row", async ($, on) => {
  const held = holding()
  const asked = world(on, {
    team: { signedIn: true },
    invites: [INVITE],
    files: { [checkpointPath('hosting:session-test-0001')]: JSON.stringify({ version: 1, value: savedRoom('room0000000000000009', 900) }) },
    beforeEvents: held.wait,
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.command.run({ command: 'team', args: 'invites' } as never)
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  const row = await $.ui.mount(band('desktop'))
  expect(await row.find({ type: 'Text', text: 'Sam invites you' })).toBeDefined()
  expect(await row.find({ key: 'invite-join' })).toBeUndefined()
  expect(await row.find({ key: 'invite-dismiss' })).toBeDefined()
  held.release!()
  await starting
  await asked.clock.advance(20)
  expect(await row.find({ key: 'stop-sharing' })).toBeDefined()
  expect(await row.find({ key: 'invite-open' })).toBeDefined()
  expect(asked.some(a => a.includes('room0000000000000201/join'))).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("an invite's Join in the Team panel while this session's place in a room is being taken back waits for it, then opens a new session, as Join does in a room", async ($, on) => {
  const held = holding()
  const asked = world(on, {
    team: { signedIn: true },
    invites: [INVITE],
    files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: JOINED_PLACE }) },
    beforeEvents: held.wait,
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.command.run({ command: 'team', args: 'invites' } as never)
  await asked.clock.advance(10)
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  const pane = await $.ui.mount(TEAM_PANE)
  await pane.press({ key: 'inv-join-room0000000000000201' })
  await asked.clock.advance(1_000)
  expect(asked.some(a => a.includes('room0000000000000201'))).toBe(false)
  held.release!()
  await starting
  await eventually(asked.clock, () => asked.externals.length)
  expect(asked.externals).toEqual([`claude://code/new?q=${encodeURIComponent('http://localhost:8787/s/room0000000000000201')}`])
  expect(asked.some(a => a.includes('room0000000000000201/join'))).toBe(false)
  expect(asked.state.room?.id).toBe('room0000000000000001')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// A take-back slow to come back (its room's first answer 12 s on: a stalled
// network, a guest's long catch-up). Only what makes or joins a room here
// gives it up: a prompt a person typed waits its 10 s and then goes on
// beside it, a channel's message doesn't wait, and the room is back once
// it answers.
for (const role of ['host', 'guest'] as const) {
  for (const kind of ['composer', 'channel'] as const) {
    test(`a ${kind === 'composer' ? 'prompt typed' : "channel's message"} while ${role === 'host' ? "this session's room" : "this session's place in a room"} is slow to come back never gives it up: ${kind === 'composer' ? 'it waits 10 s, then goes on' : "it doesn't wait"}, and the room is back once it answers`, async ($, on) => {
      const held = holding()
      const key = `${role === 'host' ? 'hosting' : 'joined'}:session-test-0001`
      const saved = role === 'host' ? savedRoom('room0000000000000009', 900) : JOINED_PLACE
      const asked = world(on, { files: { [checkpointPath(key)]: JSON.stringify({ version: 1, value: saved }) }, beforeEvents: held.wait })
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      const starting = $.session.start(START)
      await eventually(asked.clock, () => Boolean(held.release))
      const origin = kind === 'composer' ? { kind: 'composer' } : { kind: 'channel', server: 'slack' }
      const typed = $.prompt.submit({ text: 'Run the tests', origin, wait: false } as never)
      const went = () => asked.submitted.some(p => p.text === 'Run the tests')
      if (kind === 'composer') {
        await asked.clock.advance(9_500)
        expect(went()).toBe(false)
        expect(await within(asked.clock, went, 1_000)).toBe(true)
      } else expect(await eventually(asked.clock, went)).toBe(true)
      await typed
      // Still being taken back, its place still taken: not given up.
      await asked.clock.advance(1_500)
      expect(savedAt(asked, key)).toBeNull()
      held.release!()
      await starting
      await asked.clock.advance(50)
      expect(asked.state.mode).toBe(role)
      expect(asked.state.room?.id).toBe(saved.room.id)
      expect(asked.logged).toContain(role === 'host' ? `Still sharing this session: ${saved.room.url}` : "Back in Sam's session.")
      await $.command.run({ command: 'stop-sharing', args: '' } as never)
    })
  }
}

// A link pasted then joins a room here: it waits its 10 s too, and then
// gives the take-back up as Share does: the place it gives up is left.
test("a link pasted while this session's place in a room is slow to come back waits 10 s, then gives it up and joins the new room: the place it gives up is left", async ($, on) => {
  const held = holding()
  const key = 'joined:session-test-0001'
  // Its window opened before: the room's profile goes with the place, as at a Leave.
  const asked = world(on, {
    files: { [checkpointPath(key)]: JSON.stringify({ version: 1, value: { ...JOINED_PLACE, previewWindow: { port: 47100 } } }) },
    beforeEvents: held.wait,
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  const pasted = $.prompt.submit({ text: 'https://share.test/s/room0000000000000003', origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(9_500)
  expect(asked.some(a => a.includes('room0000000000000003'))).toBe(false)
  expect(await within(asked.clock, () => asked.state.room?.id === 'room0000000000000003', 1_000)).toBe(true)
  await pasted
  expect(asked.state.mode).toBe('guest')
  expect(toldOver(asked, JOINED_PLACE.room, 'leave')).toHaveLength(1)
  expect(savedAt(asked, key)).toBeNull()
  const trash = await eventually(asked.clock, () => asked.spawned.find(s => s.input?.startsWith('# shared-session: remove a preview profile')))
  expect(trash?.input).toContain(`p='${await roomProfile()}'`)
  held.release!()
  await starting
  await asked.clock.advance(50)
  expect(asked.state.room?.id).toBe('room0000000000000003')
  expect(asked.logged).not.toContain("Back in Sam's session.")
  expect(asked.filter(a => a.includes('room0000000000000001'))).toEqual(['GET /api/rooms/room0000000000000001/events'])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// The Team panel's Join, or an invite's there, in a session with prompts
// while its room is slow to come back: it waits its 10 s, then opens a new
// session as it would have, and the room is back once it answers.
for (const which of ['team', 'invite'] as const) {
  test(`${which === 'team' ? "the Team panel's Join" : "an invite's Join in the Team panel"} while this session's room is slow to come back opens a new session after 10 s and never gives the room up`, async ($, on) => {
    const held = holding()
    const key = 'hosting:session-test-0001'
    const saved = savedRoom('room0000000000000009', 900)
    const asked = world(on, {
      team: { signedIn: true, sessions: which === 'team' ? [teamSession(1)] : [] },
      ...(which === 'invite' ? { invites: [INVITE] } : {}),
      files: { [checkpointPath(key)]: JSON.stringify({ version: 1, value: saved }) },
      transcripts: { [TRANSCRIPT]: [transcriptRow('u1', 500, 'user', 'Fix the login page'), transcriptRow('a1', 600, 'assistant', 'Fixed it.')].join('\n') },
      beforeEvents: held.wait,
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.command.run({ command: 'team', ...(which === 'invite' ? { args: 'invites' } : {}) } as never)
    await asked.clock.advance(10)
    const starting = $.session.start(START)
    await eventually(asked.clock, () => Boolean(held.release))
    const room = which === 'team' ? 'room0000000000000101' : 'room0000000000000201'
    const pane = await $.ui.mount(TEAM_PANE)
    await pane.press({ key: which === 'team' ? `join-${room}` : `inv-join-${room}` })
    await asked.clock.advance(9_500)
    expect(asked.externals).toEqual([])
    await within(asked.clock, () => asked.externals.length, 1_000)
    expect(asked.externals).toEqual([`claude://code/new?q=${encodeURIComponent(`http://localhost:8787/s/${room}`)}`])
    expect(asked.some(a => a.includes(`${room}/join`))).toBe(false)
    // Still being taken back, its place still taken: not given up.
    expect(savedAt(asked, key)).toBeNull()
    held.release!()
    await starting
    await asked.clock.advance(50)
    expect(asked.state.mode).toBe('host')
    expect(asked.state.room?.id).toBe('room0000000000000009')
    expect(asked.logged).toContain(`Still sharing this session: ${saved.room.url}`)
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

// A take-back whose first request hangs (a stalled proxy or VPN at
// startup): Share, and an invite's Join, are hidden for its first 10 s
// only. Pressed then in a fresh session, Share gives it up at once (its
// room ends) and shares anew; an invite's Join in a fresh session joins
// here the same way.
for (const invited of [false, true] as const) {
  test(`a take-back that hangs hides ${invited ? "an invite's Join" : 'Share'} for 10 s only: pressed then, it gives the take-back up at once and ${invited ? 'joins' : 'shares'} here`, async ($, on) => {
    const held = holding()
    const key = 'hosting:session-test-0001'
    const saved = savedRoom('room0000000000000009', 900)
    const asked = world(on, {
      team: { signedIn: true },
      ...(invited ? { invites: [INVITE] } : {}),
      files: { [checkpointPath(key)]: JSON.stringify({ version: 1, value: saved }) },
      beforeEvents: held.wait,
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    if (invited) await $.command.run({ command: 'team', args: 'invites' } as never)
    const starting = $.session.start(START)
    await eventually(asked.clock, () => Boolean(held.release))
    const press = invited ? 'invite-join' : 'share'
    const row = await $.ui.mount(band('desktop'))
    const pane = await $.ui.mount(roomPane())
    const offered = async () => ({ row: Boolean(await row.find({ key: press })), room: Boolean(await pane.find({ key: 'room-share' })) })
    await asked.clock.advance(1_000)
    expect(await offered()).toEqual({ row: false, room: false })
    await asked.clock.advance(8_500)
    expect(await offered()).toEqual({ row: false, room: false })
    await asked.clock.advance(600)
    expect(await offered()).toEqual({ row: true, room: true })
    // Pressed now, it doesn't wait another 10 s.
    await row.press({ key: press })
    if (!invited) await row.press({ key: 'share-prompt' })
    const id = invited ? 'room0000000000000201' : 'room0000000000000002'
    expect(await within(asked.clock, () => asked.state.room?.id === id, 500)).toBe(true)
    expect(asked.state.mode).toBe(invited ? 'guest' : 'host')
    expect(asked).toContain(invited ? `POST /api/rooms/${id}/join` : 'POST /api/rooms')
    // Given up, it's over: the room ends, and its place isn't saved again.
    expect(toldOver(asked, saved.room)).toHaveLength(1)
    expect(savedAt(asked, key)).toBeNull()
    held.release!()
    await starting
    await asked.clock.advance(50)
    expect(asked.state.room?.id).toBe(id)
    expect(asked.logged.some(l => l.includes('room0000000000000009'))).toBe(false)
    expect(asked.filter(a => a.includes('room0000000000000009'))).toEqual(['GET /api/rooms/room0000000000000009/events'])
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

// A session with earlier prompts: what a Share asks first, as the row asks it.
const prompted = () => ({
  [TRANSCRIPT]: [transcriptRow('u1', 500, 'user', 'Fix the login page'), transcriptRow('a1', 600, 'assistant', 'Fixed it.')].join('\n'),
})

// In a session with earlier prompts, Share asks first which to share, and
// asking leaves a late take-back be: Cancel lets it come back; Share
// everything gives it up (its room ends) and shares anew.
for (const answer of ['share-cancel', 'share-all'] as const) {
  test(`Share pressed with earlier prompts while this session's room is late coming back asks first and gives nothing up: ${answer === 'share-all' ? 'Share everything then ends that room and shares anew' : 'Cancel leaves it to come back'}`, async ($, on) => {
    const held = holding()
    const key = 'hosting:session-test-0001'
    const saved = savedRoom('room0000000000000009', 900)
    const asked = world(on, {
      transcripts: prompted(),
      files: { [checkpointPath(key)]: JSON.stringify({ version: 1, value: saved }) },
      beforeEvents: held.wait,
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    const starting = $.session.start(START)
    await eventually(asked.clock, () => Boolean(held.release))
    const row = await $.ui.mount(band('desktop'))
    await asked.clock.advance(10_100)
    await row.press({ key: 'share' })
    await row.press({ key: 'share-prompt' })
    expect(await eventually(asked.clock, () => asked.state.asking)).toEqual({ prompts: 1, teammates: 'everyone' })
    // Asked, nothing is given up.
    expect(toldOver(asked, saved.room)).toHaveLength(0)
    expect(asked).not.toContain('POST /api/rooms')
    await row.press({ key: answer })
    if (answer === 'share-all') {
      expect(await within(asked.clock, () => asked.state.room?.id === 'room0000000000000002', 1_000)).toBe(true)
      expect(toldOver(asked, saved.room)).toHaveLength(1)
    } else {
      await asked.clock.advance(1_000)
      expect(asked.state.asking ?? null).toBeNull()
      expect(toldOver(asked, saved.room)).toHaveLength(0)
    }
    held.release!()
    await starting
    await asked.clock.advance(50)
    expect(asked.state.mode).toBe('host')
    if (answer === 'share-all') {
      expect(asked.state.room?.id).toBe('room0000000000000002')
      expect(asked.filter(a => a.includes('room0000000000000009'))).toEqual(['GET /api/rooms/room0000000000000009/events'])
    } else {
      expect(asked.state.room?.id).toBe('room0000000000000009')
      expect(asked.logged).toContain(`Still sharing this session: ${saved.room.url}`)
      expect(asked).not.toContain('POST /api/rooms')
    }
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test("/share-session with earlier prompts while this session's room is late coming back answers with the choice and gives nothing up; /share-session all then ends that room and shares anew", async ($, on) => {
  const held = holding()
  const key = 'hosting:session-test-0001'
  const saved = savedRoom('room0000000000000009', 900)
  const asked = world(on, { transcripts: prompted(), files: { [checkpointPath(key)]: JSON.stringify({ version: 1, value: saved }) }, beforeEvents: held.wait })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  let reply: { text: string } | undefined
  void $.command.run({ command: 'share-session', args: '' } as never).then(r => {
    reply = r as { text: string }
  })
  await asked.clock.advance(9_000)
  expect(reply).toBeUndefined()
  await within(asked.clock, () => reply, 3_000)
  expect(reply?.text).toContain('This session has 1 earlier prompt.')
  expect(reply?.text).toContain('`/share-session all` shares the session as it is')
  expect(asked.state.asking).toEqual({ prompts: 1, teammates: 'everyone' })
  expect(toldOver(asked, saved.room)).toHaveLength(0)
  expect(asked).not.toContain('POST /api/rooms')
  let shared: unknown
  void $.command.run({ command: 'share-session', args: 'all' } as never).then(r => {
    shared = r
  })
  await within(asked.clock, () => shared, 3_000)
  expect(shared).toEqual({ text: 'Sharing this session. Anyone with this link can join and prompt this session: http://localhost:8787/s/room0000000000000002' })
  expect(toldOver(asked, saved.room)).toHaveLength(1)
  held.release!()
  await starting
  await asked.clock.advance(50)
  expect(asked.state.room?.id).toBe('room0000000000000002')
  expect(asked.filter(a => a.includes('room0000000000000009'))).toEqual(['GET /api/rooms/room0000000000000009/events'])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// A Share whose late take-back comes back while it counts the session's
// prompts (nothing read before, so what `share` reads is now): it's a
// session sharing already, and no second room is made.
for (const how of ['press', 'command'] as const) {
  test(`${how === 'press' ? 'Share pressed' : '/share-session'} in a fresh session whose late room comes back while its prompts are counted makes no second room: it's sharing already`, async ($, on) => {
    const held = holding()
    const key = 'hosting:session-test-0001'
    const saved = savedRoom('room0000000000000009', 900)
    let counting = async () => {}
    // No earlier prompts: a reply alone.
    const asked = world(on, {
      transcripts: { [TRANSCRIPT]: transcriptRow('a1', 600, 'assistant', 'Hello.') },
      files: { [checkpointPath(key)]: JSON.stringify({ version: 1, value: saved }) },
      beforeEvents: held.wait,
      beforeHistory: () => counting(),
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    const starting = $.session.start(START)
    await eventually(asked.clock, () => Boolean(held.release))
    const row = await $.ui.mount(band('desktop'))
    await asked.clock.advance(10_100)
    // As the Share looks at the session's prompts, the room answers and is back.
    counting = async () => {
      counting = async () => {}
      held.release!()
      await eventually(asked.clock, () => asked.state.mode === 'host')
    }
    let reply: unknown
    if (how === 'press') await row.press({ key: 'share' })
    else
      void $.command.run({ command: 'share-session', args: '' } as never).then(r => {
        reply = r
      })
    await within(asked.clock, () => (how === 'press' ? asked.toasted.includes('Link copied') : reply), 3_000)
    await starting
    await asked.clock.advance(50)
    expect(asked).not.toContain('POST /api/rooms')
    expect(asked.state.mode).toBe('host')
    expect(asked.state.room?.id).toBe('room0000000000000009')
    expect(toldOver(asked, saved.room)).toHaveLength(0)
    if (how === 'command') expect(reply).toEqual({ text: `Sharing this session. Anyone with this link can join and prompt this session: ${saved.room.url}` })
    else expect(asked.toasted).toContain('Link copied')
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

// A place given up for another room, whose first request then comes back
// refused (the room let its seat go): no seat is taken there again.
test("a guest's place given up for a link while its first request hung takes no seat in that room when the request comes back refused", async ($, on) => {
  const held = holding()
  const asked = world(on, {
    files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: JOINED_PLACE }) },
    beforeEvents: held.wait,
    seatGone: 'room0000000000000001',
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  const pasted = $.prompt.submit({ text: 'https://share.test/s/room0000000000000003', origin: { kind: 'composer' }, wait: false })
  expect(await within(asked.clock, () => asked.state.room?.id === 'room0000000000000003', 11_000)).toBe(true)
  await pasted
  expect(toldOver(asked, JOINED_PLACE.room, 'leave')).toHaveLength(1)
  held.release!()
  await starting
  await asked.clock.advance(50)
  expect(asked.filter(a => a.includes('room0000000000000001'))).toEqual(['GET /api/rooms/room0000000000000001/events'])
  expect(asked.state.room?.id).toBe('room0000000000000003')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// A late take-back given up for a room that then isn't made or joined
// (refused, unreachable, gone): nothing of it is over. Its room hears
// nothing, and its place is saved again, window and all, for the next
// start to take back; the take-back writes nothing after.
test("a link pasted while this session's place in a room is late coming back, whose room refuses the join, gives nothing up: that room hears nothing, and the place is saved again for the next start", async ($, on) => {
  const held = holding()
  const key = 'joined:session-test-0001'
  const saved = { ...JOINED_PLACE, previewWindow: { port: 47100 } }
  const asked = world(on, {
    files: { [checkpointPath(key)]: JSON.stringify({ version: 1, value: saved }) },
    beforeEvents: held.wait,
    joinStatus: { room0000000000000003: 410 },
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  const pasted = $.prompt.submit({ text: 'https://share.test/s/room0000000000000003', origin: { kind: 'composer' }, wait: false })
  expect(await within(asked.clock, () => asked.includes('POST /api/rooms/room0000000000000003/join'), 11_000)).toBe(true)
  await pasted
  await asked.clock.advance(50)
  expect(asked.state.mode ?? 'idle').toBe('idle')
  expect(asked.state.room ?? null).toBeNull()
  expect(toldOver(asked, JOINED_PLACE.room, 'leave')).toHaveLength(0)
  expect(asked.spawned.some(s => s.input?.startsWith('# shared-session: remove a preview profile'))).toBe(false)
  expect(savedAt(asked, key)).toEqual(saved)
  held.release!()
  await starting
  await asked.clock.advance(50)
  expect(asked.state.room ?? null).toBeNull()
  expect(asked.logged).not.toContain("Back in Sam's session.")
  expect(asked.filter(a => a.includes('room0000000000000001'))).toEqual(['GET /api/rooms/room0000000000000001/events'])
  expect(toldOver(asked, JOINED_PLACE.room, 'leave')).toHaveLength(0)
  expect(savedAt(asked, key)).toEqual(saved)
})

// The same for a join whose seat comes but not its history: its seat goes
// back, so it isn't in that room after all.
test("a link pasted while this session's place in a room is late coming back, whose join gets a seat but not its history, keeps that place: saved again, and its room hears nothing", async ($, on) => {
  const held = holding()
  const key = 'joined:session-test-0001'
  const asked = world(on, {
    files: { [checkpointPath(key)]: JSON.stringify({ version: 1, value: JOINED_PLACE }) },
    beforeEvents: held.wait,
    paged: { failRest: true },
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  const pasted = $.prompt.submit({ text: 'https://share.test/s/room0000000000000003', origin: { kind: 'composer' }, wait: false })
  expect(await within(asked.clock, () => asked.includes('POST /api/rooms/room0000000000000003/leave'), 11_000)).toBe(true)
  await pasted
  await asked.clock.advance(50)
  expect(asked.state.room ?? null).toBeNull()
  expect(toldOver(asked, JOINED_PLACE.room, 'leave')).toHaveLength(0)
  expect(savedAt(asked, key)).toEqual(JOINED_PLACE)
  held.release!()
  await starting
  await asked.clock.advance(50)
  expect(asked.filter(a => a.includes('room0000000000000001'))).toEqual(['GET /api/rooms/room0000000000000001/events'])
  expect(savedAt(asked, key)).toEqual(JOINED_PLACE)
})

test("/share-session in a fresh session whose room is late coming back, its new room refused, gives nothing up: that room isn't ended, and the next start takes it back", async ($, on) => {
  const held = holding()
  const key = 'hosting:session-test-0001'
  const saved = savedRoom('room0000000000000009', 900)
  const asked = world(on, { files: { [checkpointPath(key)]: JSON.stringify({ version: 1, value: saved }) }, beforeEvents: held.wait, createStatus: 429 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  let reply: unknown
  void $.command.run({ command: 'share-session', args: '' } as never).then(r => {
    reply = r
  })
  expect(await within(asked.clock, () => reply, 12_000)).toEqual({
    text: "Couldn't share: Too many new shared sessions from your network. Try again in a minute.",
  })
  expect(asked).toContain('POST /api/rooms')
  expect(asked.state.room ?? null).toBeNull()
  expect(toldOver(asked, saved.room)).toHaveLength(0)
  expect(savedAt(asked, key)).toEqual(saved)
  held.release!()
  await starting
  await asked.clock.advance(50)
  expect(asked.state.room ?? null).toBeNull()
  expect(asked.filter(a => a.includes('room0000000000000009'))).toEqual(['GET /api/rooms/room0000000000000009/events'])
  expect(toldOver(asked, saved.room)).toHaveLength(0)
  // The next start takes it back, on the same link.
  await $.session.start(START)
  await asked.clock.advance(50)
  expect(asked.state.mode).toBe('host')
  expect(asked.state.room?.id).toBe('room0000000000000009')
  expect(asked.logged).toContain(`Still sharing this session: ${saved.room.url}`)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// The session ending while the room a late take-back was given up for is
// still being made (its request out): the place is saved again, as one
// still being taken back is, never lost with the session; a /clear ends
// that room instead. Whether that new room is made or refused after, it
// changes nothing more of the one given up.
for (const reason of ['other', 'clear'] as const) {
  for (const then of ['made', 'refused'] as const) {
    test(`a session ${reason === 'clear' ? 'cleared' : 'closing'} while the room it gave a late take-back up for is still being made ${reason === 'clear' ? 'ends the room given up' : 'saves the place given up again for the next start'}; that room ${then} after changes nothing more`, async ($, on) => {
      const held = holding()
      const making = holding()
      const key = 'hosting:session-test-0001'
      const saved = savedRoom('room0000000000000009', 900)
      const asked = world(on, {
        files: { [checkpointPath(key)]: JSON.stringify({ version: 1, value: saved }) },
        beforeEvents: held.wait,
        beforeCreate: making.wait,
        ...(then === 'refused' ? { createStatus: 429 } : {}),
      })
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      on('session.end', ($, e) => ({ sessionId: e.sessionId }))
      const starting = $.session.start(START)
      await eventually(asked.clock, () => Boolean(held.release))
      let reply: { text: string } | undefined
      void $.command.run({ command: 'share-session', args: '' } as never).then(r => {
        reply = r as { text: string }
      })
      expect(await within(asked.clock, () => Boolean(making.release), 11_000)).toBe(true)
      // Given up, its new room not made yet: nothing told, the place taken.
      expect(toldOver(asked, saved.room)).toHaveLength(0)
      const now = () => savedAt(asked, key)
      expect(now()).toBeNull()
      await $.session.end({ reason, sessionId: 'session-test-0001', resume: {} } as never)
      const ended = () => asked.filter(a => a === 'POST /api/rooms/room0000000000000009/end')
      expect(now()).toEqual(reason === 'clear' ? null : saved)
      expect(ended()).toHaveLength(reason === 'clear' ? 1 : 0)
      making.release!()
      held.release!()
      await starting
      await within(asked.clock, () => reply, 3_000)
      await asked.clock.advance(50)
      expect(reply?.text.startsWith(then === 'made' ? 'Sharing this session.' : "Couldn't share:")).toBe(true)
      // Settled at the end: told nothing more, and never saved again.
      expect(toldOver(asked, saved.room)).toHaveLength(0)
      expect(ended()).toHaveLength(reason === 'clear' ? 1 : 0)
      expect(now()).toEqual(reason === 'clear' ? null : saved)
      if (then === 'made') await $.command.run({ command: 'stop-sharing', args: '' } as never)
    })
  }
}

// What a person types while their place is late coming back (past its 10 s,
// the room's first answer still on its way): a guest's gets a note, as with
// the host away, and never reaches this session's own Claude; a host's goes
// on to this session's own Claude, which is the host's.
for (const role of ['guest', 'host'] as const) {
  test(`a prompt typed while ${role === 'guest' ? "this session's place in a room" : "this session's room"} is late coming back ${role === 'guest' ? "gets a note and never reaches this session's own Claude" : "goes on to this session's own Claude, the host's"}`, async ($, on) => {
    const held = holding()
    const key = `${role === 'host' ? 'hosting' : 'joined'}:session-test-0001`
    const saved = role === 'host' ? savedRoom('room0000000000000009', 900) : JOINED_PLACE
    const asked = world(on, { files: { [checkpointPath(key)]: JSON.stringify({ version: 1, value: saved }) }, beforeEvents: held.wait })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))
    let own = 0
    on('turn.step', async function* ($, e) {
      own += 1
      yield { kind: 'text', index: 0, text: 'Ran them here.' } as never
      yield { kind: 'stop', stopReason: 'end_turn', usage: null } as never
      return { turnId: e.turnId, index: e.index, answer: 'Ran them here.', toolUses: [], stopReason: 'end_turn', usage: null } as never
    })
    const starting = $.session.start(START)
    await eventually(asked.clock, () => Boolean(held.release))
    // Its turn, as the engine runs it once the prompt went on: what it said.
    const turn = async (turnId: string, text: string) => {
      await $.turn.start({ turnId, text })
      const said: string[] = []
      for await (const chunk of $.turn.step({ ...STEP, turnId } as never))
        if ((chunk as { kind?: string }).kind === 'text') said.push((chunk as { text: string }).text)
      await $.turn.complete({ turnId, isAborted: false, durationMs: 0, reason: 'answer' } as never)
      return said.join('')
    }
    const note = "Still getting back into **Sam**'s session, so this didn't go to Claude. Send it again in a moment."
    // Typed in the take-back's first 10 s: it waits them out.
    const typed = $.prompt.submit({ text: 'Run the tests', origin: { kind: 'composer' }, wait: false })
    const went = (text: string) => () => asked.submitted.some(p => p.text === text)
    await asked.clock.advance(9_500)
    expect(went('Run the tests')()).toBe(false)
    expect(await within(asked.clock, went('Run the tests'), 1_000)).toBe(true)
    await typed
    expect(await turn('mine', 'Run the tests')).toBe(role === 'guest' ? note : 'Ran them here.')
    expect(own).toBe(role === 'guest' ? 0 : 1)
    // Typed once it's late: answered at once, the same way.
    await asked.clock.advance(2_000)
    const again = $.prompt.submit({ text: 'And the linter', origin: { kind: 'composer' }, wait: false })
    expect(await within(asked.clock, went('And the linter'), 500)).toBe(true)
    await again
    expect(await turn('mine-2', 'And the linter')).toBe(role === 'guest' ? note : 'Ran them here.')
    expect(own).toBe(role === 'guest' ? 0 : 2)
    // Still being taken back: not given up for a prompt, and back once it answers.
    expect(savedAt(asked, key)).toBeNull()
    held.release!()
    await starting
    await asked.clock.advance(50)
    expect(asked.state.mode).toBe(role)
    expect(asked.state.room?.id).toBe(saved.room.id)
    // Neither went to the room.
    expect(asked.posted.filter(e => e.type === 'prompt')).toEqual([])
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

// A message from another of the guest's sessions while their place comes
// back waits for it, as what they type does: once back, it goes on to the
// host's session, never to this session's own Claude.
test("another of the guest's sessions' message while their place comes back waits, then goes on to the host's session", async ($, on) => {
  const held = holding()
  const key = 'joined:session-test-0001'
  const place = JOINED_PLACE
  const transcripts = { [PEER_TRANSCRIPT]: `${peerRow(FROM_AGENT, MSG)}\n` }
  const asked = world(on, {
    files: { [checkpointPath(key)]: JSON.stringify({ version: 1, value: place }) },
    beforeEvents: held.wait,
    env: PEER_ENV,
    transcripts,
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  let done = false
  void $.prompt.submit({ text: FROM_AGENT, origin: { kind: 'peer' }, isMeta: true, wait: false } as never).then(() => void (done = true))
  await asked.clock.advance(3_000)
  expect(done).toBe(false)
  expect(asked.peerPosts).toEqual([])
  held.release!()
  await starting
  expect(await within(asked.clock, () => asked.peerPosts.length > 0, 5_000)).toBe(true)
  expect(asked.peerPosts[0]).toMatchObject({
    name: 'Agent composition experience',
    id: MSG,
    chain: CHAIN,
    body: 'Please share the raw traces from your testing.',
  })
  expect(asked.peerSends).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// Kept here (Messages from my other sessions: Stay here), it waits for the
// place just the same, and gets the note there: never this session's own
// Claude's to answer.
test("another of the guest's sessions' message kept here waits for the place too, then gets its note, never a model call", async ($, on) => {
  const held = holding()
  const key = 'joined:session-test-0001'
  const asked = world(on, {
    store: { prefs: { relayPeers: false } },
    files: { [checkpointPath(key)]: JSON.stringify({ version: 1, value: JOINED_PLACE }) },
    beforeEvents: held.wait,
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  let own = 0
  on('turn.step', async function* ($, e) {
    own += 1
    yield { kind: 'stop', stopReason: 'end_turn', usage: null } as never
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  let done = false
  void $.prompt.submit({ text: FROM_AGENT, origin: { kind: 'peer' }, isMeta: true, wait: false } as never).then(() => void (done = true))
  await asked.clock.advance(3_000)
  expect(done).toBe(false)
  held.release!()
  await starting
  expect(await within(asked.clock, () => done, 1_000)).toBe(true)
  await $.turn.start({ turnId: 'kept', text: FROM_AGENT })
  const said: string[] = []
  for await (const chunk of $.turn.step({ ...STEP, turnId: 'kept' } as never))
    if ((chunk as { kind?: string }).kind === 'text') said.push((chunk as { text: string }).text)
  await $.turn.complete({ turnId: 'kept', isAborted: false, durationMs: 0, reason: 'answer' } as never)
  expect(said.join('')).toContain('stayed here')
  expect(own).toBe(0)
  expect(asked.posted.some(e => e.type === 'prompt')).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// One delivered into a turn already playing here, that isn't going on to the
// host's Claude, is said in a toast and goes no further: no note waits for a
// turn of its own that never starts, ahead of the host's turns.
test("another session's message delivered mid-turn that stays here is a toast, and dropped", async ($, on) => {
  const asked = world(on, { store: { prefs: { relayPeers: false } } })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(50)
  const busy = FROM_AGENT.replace('sent a message:', 'sent a message while you were working:')
  const result = await $.prompt.submit({ text: busy, origin: { kind: 'peer' }, isMeta: true, wait: false } as never)
  expect(result).toMatchObject({ drop: expect.stringContaining('stayed here') })
  expect(asked.toasted.some(t => t.includes('A message from Agent composition experience stayed here'))).toBe(true)
  expect(asked.posted.some(e => e.type === 'prompt')).toBe(false)
})

// A note's turn is the plugin's own, whatever the mode. One given while a
// guest's place is late coming back is given idle: the person's own Stop
// hook (one that keeps a turn going) isn't run for it, and a step after the
// note (a Stop hook above the plugin's continuing the turn) ends it, never
// on this session's own Claude. A turn of the person's own meanwhile (a
// background task's notice) has their Stop hook and their Claude as ever.
test("a note given while this session's place in a room is late coming back is its turn's last word: the person's own Stop hook isn't run for it, and a step after it never reaches this session's own Claude", async ($, on) => {
  const held = holding()
  const asked = world(on, {
    files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: JOINED_PLACE }) },
    beforeEvents: held.wait,
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  let own = 0
  on('turn.step', async function* ($, e) {
    own += 1
    yield { kind: 'text', index: 0, text: 'Ran them here.' } as never
    yield { kind: 'stop', stopReason: 'end_turn', usage: null } as never
    return { turnId: e.turnId, index: e.index, answer: 'Ran them here.', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  // The person's own Stop hook, as their settings have it: it keeps a turn going.
  let stopHook = 0
  on('classic.Stop', () => {
    stopHook += 1
    return { block: 'Keep going until the tests pass.' } as never
  })
  const classic = ($ as unknown as { classic: { Stop: (e: unknown) => Promise<unknown> } }).classic
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  await asked.clock.advance(10_100)
  // A turn as the engine runs it: a step, the Stop hooks, a step after them.
  const step = async (turnId: string, index: number) => {
    const said: string[] = []
    for await (const chunk of $.turn.step({ ...STEP, turnId, index, messageCount: 1 + 2 * index } as never))
      if ((chunk as { kind?: string }).kind === 'text') said.push((chunk as { text: string }).text)
    return said.join('')
  }
  const stop = (said: string) => classic.Stop({ stop_hook_active: false, last_assistant_message: said })
  const typed = $.prompt.submit({ text: 'Run the tests', origin: { kind: 'composer' }, wait: false })
  await within(asked.clock, () => asked.submitted.some(p => p.text === 'Run the tests'), 1_000)
  await typed
  await $.turn.start({ turnId: 'mine', text: 'Run the tests' })
  const note = "Still getting back into **Sam**'s session, so this didn't go to Claude. Send it again in a moment."
  expect(await step('mine', 0)).toBe(note)
  expect(await stop(note)).toEqual({})
  expect(stopHook).toBe(0)
  expect(await step('mine', 1)).toBe('')
  await $.turn.complete({ turnId: 'mine', isAborted: false, durationMs: 0, reason: 'answer' } as never)
  expect(own).toBe(0)
  // The person's own turn, still late: their Claude answers it, and their Stop hook runs.
  const notice = '<task-notification><summary>The build finished</summary></task-notification>'
  await $.prompt.submit({ text: notice, origin: { kind: 'task-notification' }, wait: false } as never)
  await $.turn.start({ turnId: 'task', text: notice })
  expect(await step('task', 0)).toBe('Ran them here.')
  expect(await stop('Ran them here.')).toEqual({ block: 'Keep going until the tests pass.' })
  expect(stopHook).toBe(1)
  await $.turn.complete({ turnId: 'task', isAborted: false, durationMs: 0, reason: 'answer' } as never)
  expect(own).toBe(1)
  // Back in the room once it answers, and nothing went to it.
  held.release!()
  await starting
  await asked.clock.advance(50)
  expect(asked.state.mode).toBe('guest')
  expect(asked.posted.filter(e => e.type === 'prompt')).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// /team join waits for a room being taken back as the Team panel's Join
// does, and before it reads anything: then it goes on as in that room.
test("/team join while this session's place in a room is being taken back waits for it before reading anything, then opens a new session, as Join does in a room", async ($, on) => {
  const held = holding()
  const asked = world(on, {
    team: { signedIn: true, sessions: [teamSession(1)] },
    files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: JOINED_PLACE }) },
    beforeEvents: held.wait,
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.command.run({ command: 'team' } as never)
  await asked.clock.advance(10)
  const starting = $.session.start(START)
  await eventually(asked.clock, () => Boolean(held.release))
  let reply: unknown
  void $.command.run({ command: 'team', args: 'join 1' } as never).then(r => {
    reply = r
  })
  await asked.clock.advance(1_000)
  expect(reply).toBeUndefined()
  expect(asked.some(a => a.includes('room0000000000000101'))).toBe(false)
  held.release!()
  await starting
  expect(await within(asked.clock, () => reply, 3_000)).toEqual({ text: 'Joining demo: work 1.' })
  expect(asked.externals).toEqual([`claude://code/new?q=${encodeURIComponent('http://localhost:8787/s/room0000000000000101')}`])
  expect(asked.some(a => a.includes('room0000000000000101/join'))).toBe(false)
  expect(asked.state.room?.id).toBe('room0000000000000001')
  expect(asked.state.mode).toBe('guest')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// One Share at a time: Shares at once (/share-session twice, the row's and
// the Room's) make one room; the others wait for it and answer as a session
// sharing already.
test('Shares at once make one room: the others wait for it, then answer as a session sharing already', async ($, on) => {
  const asked = world(on)
  const ui = await $.ui.mount(band('desktop'))
  const pane = await $.ui.mount(roomPane())
  const replies: unknown[] = []
  const commands = [1, 2].map(() => $.command.run({ command: 'share-session', args: '' } as never).then(r => void replies.push(r)))
  const presses = [ui.press({ key: 'share' }), pane.press({ key: 'room-share' })]
  await within(asked.clock, () => replies.length === 2, 5_000)
  await Promise.all([...commands, ...presses])
  await asked.clock.advance(50)
  expect(asked.filter(a => a === 'POST /api/rooms')).toHaveLength(1)
  const sharing = 'Sharing this session. Anyone with this link can join and prompt this session: http://localhost:8787/s/room0000000000000002'
  expect(replies).toEqual([{ text: sharing }, { text: sharing }])
  expect(asked.state.mode).toBe('host')
  expect(asked.state.room?.id).toBe('room0000000000000002')
  // The one that made it says it's sharing; the rest, sharing already, copy its link.
  expect(asked.toasted.filter(t => t.startsWith('Sharing'))).toEqual(['Sharing · link copied'])
  expect(asked.toasted.filter(t => t === 'Link copied')).toHaveLength(3)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  // Stopped, the next Share makes a room of its own.
  await $.command.run({ command: 'share-session', args: '' } as never)
  expect(asked.filter(a => a === 'POST /api/rooms')).toHaveLength(2)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// In a session with earlier prompts, a Share asking first at the same
// moment as one that shares asks nothing: it's a session sharing already.
test('/share-session all and /share-session at once, with earlier prompts: one room, and the second answers as sharing already, never asks', async ($, on) => {
  const asked = world(on, {
    transcripts: { [TRANSCRIPT]: [transcriptRow('u1', 500, 'user', 'Fix the login page'), transcriptRow('a1', 600, 'assistant', 'Fixed it.')].join('\n') },
  })
  const replies: unknown[] = []
  for (const args of ['all', '']) void $.command.run({ command: 'share-session', args } as never).then(r => void replies.push(r))
  await within(asked.clock, () => replies.length === 2, 5_000)
  await asked.clock.advance(50)
  expect(asked.filter(a => a === 'POST /api/rooms')).toHaveLength(1)
  const sharing = 'Sharing this session. Anyone with this link can join and prompt this session: http://localhost:8787/s/room0000000000000002'
  expect(replies).toEqual([{ text: sharing }, { text: sharing }])
  expect(asked.state.asking ?? null).toBeNull()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// The share question's answer is a Share too: pressed at the same moment as
// /share-session all, one room.
test("the share question's Share everything at the same moment as /share-session all: one room, and the second is sharing already", async ($, on) => {
  const asked = world(on, {
    transcripts: { [TRANSCRIPT]: [transcriptRow('u1', 500, 'user', 'Fix the login page'), transcriptRow('a1', 600, 'assistant', 'Fixed it.')].join('\n') },
  })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  expect(await ui.find({ key: 'share-all' })).toBeDefined()
  let reply: unknown
  void $.command.run({ command: 'share-session', args: 'all' } as never).then(r => {
    reply = r
  })
  const pressed = ui.press({ key: 'share-all' })
  await within(asked.clock, () => reply, 5_000)
  await pressed
  await asked.clock.advance(50)
  expect(asked.filter(a => a === 'POST /api/rooms')).toHaveLength(1)
  expect(reply).toEqual({ text: 'Sharing this session. Anyone with this link can join and prompt this session: http://localhost:8787/s/room0000000000000002' })
  expect(asked.toasted.filter(t => t.startsWith('Sharing'))).toEqual(['Sharing · link copied'])
  expect(asked.toasted).toContain('Link copied')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// A Share that takes longer than a hook's 10 s, all of it in its own $
// calls (a look at the transcript and the room's making, six seconds each
// of real time): a /share-session behind it waits its turn in naps, its own
// budget stopped as a real `sleep` stops it, and answers once that Share is
// done. Waiting on a plain promise, its 10 s ran out, and the engine
// answered it without the plugin.
test(
  "a /share-session behind a Share that takes longer than a hook's 10 s waits its turn without running out of time, then answers as a session sharing already",
  { timeoutMs: 40_000 },
  async ($, on) => {
    const slow = () => new Promise<void>(done => setTimeout(done, 6_000))
    let looked = false
    const asked = world(on, {
      realSleep: true,
      transcripts: {},
      beforeHistory: () => (looked ? Promise.resolve() : ((looked = true), slow())),
      beforeCreate: slow,
    })
    const replies: unknown[] = []
    const run = () =>
      $.command.run({ command: 'share-session', args: '' } as never).then(
        r => void replies.push(r),
        error => void replies.push(`threw: ${String((error as Error)?.message ?? error)}`),
      )
    const first = run()
    expect(await eventually(asked.clock, () => looked)).toBe(true)
    const second = run()
    await Promise.all([first, second])
    const sharing = 'Sharing this session. Anyone with this link can join and prompt this session: http://localhost:8787/s/room0000000000000002'
    expect(replies).toEqual([{ text: sharing }, { text: sharing }])
    expect(asked.filter(a => a === 'POST /api/rooms')).toHaveLength(1)
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  },
)

// A close that takes longer than a hook's 10 s, all of it in its own $
// calls (Stop sharing putting its marker up and telling the room, six
// seconds of real time each, as a stalled machine and network hold them):
// a /share-session meanwhile waits for it in naps, its own budget stopped
// as a real `sleep` stops it, and shares anew once it's done. A second
// Stop sharing begun before the first set the session idle (its moment
// still has the room) waits for that close the same way, and answers as it
// does. On a plain promise each ran out of its 10 s, and the engine
// answered them without the plugin.
test(
  "/share-session while Stop sharing takes longer than a hook's 10 s to tell the room waits for it without running out of time, then shares anew; a second Stop sharing begun with the first waits the same way",
  { timeoutMs: 40_000 },
  async ($, on) => {
    const slow = () => new Promise<void>(done => setTimeout(done, 6_000))
    let marking = false
    const beforeSet = (key: string, value: unknown) => (key === 'closing' && value && !marking ? ((marking = true), slow()) : undefined)
    let told = false
    const beforeTell = () => (told ? Promise.resolve() : ((told = true), slow()))
    const asked = world(on, { realSleep: true, transcripts: {}, beforeSet, beforeTell })
    const sharing = { text: 'Sharing this session. Anyone with this link can join and prompt this session: http://localhost:8787/s/room0000000000000002' }
    expect(await $.command.run({ command: 'share-session', args: '' } as never)).toEqual(sharing)
    const stops: unknown[] = [],
      shares: unknown[] = []
    const run = (command: string, replies: unknown[]) =>
      $.command.run({ command, args: '' } as never).then(
        r => void replies.push(r),
        error => void replies.push(`threw: ${String((error as Error)?.message ?? error)}`),
      )
    const first = run('stop-sharing', stops)
    // The first close, putting its marker up: the session isn't idle yet.
    expect(await eventually(asked.clock, () => marking)).toBe(true)
    const second = run('stop-sharing', stops)
    const again = run('share-session', shares)
    await Promise.all([first, second, again])
    const stopped = { text: 'Stopped sharing. The link no longer works.' }
    expect(stops).toEqual([stopped, stopped])
    expect(shares).toEqual([sharing])
    expect(asked.filter(a => a === 'POST /api/rooms')).toHaveLength(2)
    expect(asked.filter(a => a === 'POST /api/rooms/room0000000000000002/end')).toHaveLength(1)
    expect(asked.state.mode).toBe('host')
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  },
)
