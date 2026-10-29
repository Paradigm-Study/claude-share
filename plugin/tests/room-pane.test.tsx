// The room beside the transcript: the type scale, every turn, the files
// changed, reactions and who saw each reply, mentions, sounds.

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { fit } from '../hooks/fit'
import { replyKey } from '../hooks/room'
import { SURFACES, LINK, band, world, ROW, roomPane } from './support/world'

// ---------------------------------------------------------------------------
// The room beside the transcript: the type scale, every turn, the files
// changed, reactions and who saw each reply, mentions, sounds.

const SAM = { seat: 'host', name: 'Sam', role: 'host' }

const ALEX = { seat: 'seat2', name: 'Alex', role: 'guest' }

const ROOM_PEOPLE = [
  { id: 'host', name: 'Sam', role: 'host', online: true },
  { id: 'seat1', name: 'scott', role: 'guest', online: true },
  { id: 'seat2', name: 'Alex', role: 'guest', online: true },
]

// What core draws for its own rows, beneath the plugins.
const NATIVE = { type: 'engine', ref: 0 } as never

const joinWith = async ($: Engine, asked: ReturnType<typeof world>) => {
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(50)
}

test('the Room draws the type scale on Claude Code 2.1.299', async ($, on) => {
  const asked = world(on)
  await joinWith($, asked)
  const ui = await $.ui.mount(roomPane('desktop'))
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('"size":"title"')
  expect(tree).toContain('"weight":"semibold"')
  expect(tree).toContain('"gap":"lg"')
  await ui.unmount()
})

test('on an older engine the same Room is drawn in what it takes: bold for weight, cells for steps', async ($, on) => {
  const asked = world(on, { env: { AI_AGENT: 'claude-code_2-1-295_agent' } })
  await joinWith($, asked)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(roomPane(surface))
    const tree = JSON.stringify(await ui.drawn())
    // (A newer engine under the test adds a weight beside bold by itself.)
    for (const prop of ['"size":', '"tabular":', '"mono":', '"gap":"']) expect(tree).not.toContain(prop)
    expect(tree).toContain('"bold":true')
    await ui.unmount()
  }
  // fit itself: the engine's own drawing is passed on as it came.
  const tree = {
    type: 'Box',
    props: { gap: 'sm' },
    children: [
      { type: 'Text', props: { size: 'title', weight: 'semibold', tabular: true }, children: ['x'] },
      { type: 'engine', ref: 3 },
    ],
  }
  expect(fit(tree, false)).toEqual({
    type: 'Box',
    props: { gap: 1 },
    children: [
      { type: 'Text', props: { bold: true }, children: ['x'] },
      { type: 'engine', ref: 3 },
    ],
  })
  expect(fit(tree, true)).toBe(tree)
})

test('the Timeline has every turn, in the color of who asked, and how long each took', async ($, on) => {
  const events = [
    { seq: 2, type: 'turn', from: SAM, ts: 900, body: { state: 'start', turnId: 't1', by: 'Sam', prompt: 'Why does the upload test fail?' } },
    { seq: 3, type: 'turn', from: SAM, ts: 950, body: { state: 'end', turnId: 't1', durationMs: 41_000 } },
    { seq: 4, type: 'turn', from: SAM, ts: 960, body: { state: 'start', turnId: 't2', by: 'Alex', prompt: 'Also cover the 503 path' } },
  ]
  const asked = world(on, { people: ROOM_PEOPLE, stream: [{ seq: 4, events, people: ROOM_PEOPLE, ended: false, title: 'demo' }] })
  await joinWith($, asked)
  const ui = await $.ui.mount(roomPane('desktop'))
  await ui.press({ key: 'tab-timeline' })
  expect(await ui.find({ in: 'timeline', type: 'Text', text: 'Alex' })).toBeDefined()
  expect(await ui.find({ in: 'timeline', text: /turn 2 of 2 · running/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '41s' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' Also cover the 503 path' })).toBeDefined()
  await ui.unmount()
})

test("Changes lists every file Claude changed, for whom, with its diff: the host's hunks, or worked out from the edit", async ($, on) => {
  const edit = (id: string, path: string, oldString: string, newString: string) => ({
    kind: 'tool',
    tool: 'Edit',
    id,
    text: path,
    input: { file_path: `/repo/${path}`, old_string: oldString, new_string: newString },
  })
  const events = [
    { seq: 2, type: 'turn', from: SAM, ts: 900, body: { state: 'start', turnId: 't1', by: 'Alex', prompt: 'Make the retry limit configurable' } },
    { seq: 3, type: 'row', from: SAM, ts: 901, body: edit('e1', 'src/upload.ts', 'const MAX = 3', 'const MAX = limit()') },
    {
      seq: 4,
      type: 'row',
      from: SAM,
      ts: 902,
      body: { kind: 'result', id: 'e1', text: 'ok', patch: '@@ -12,1 +12,1 @@\n-const MAX = 3\n+const MAX = limit()' },
    },
    { seq: 5, type: 'row', from: SAM, ts: 903, body: edit('e2', 'test/upload.test.ts', 'a\nb', 'a\nc\nd') },
    { seq: 6, type: 'row', from: SAM, ts: 904, body: { kind: 'result', id: 'e2', text: 'ok' } },
    { seq: 7, type: 'row', from: SAM, ts: 905, body: { kind: 'tool', tool: 'Bash', id: 'b1', text: 'npm test' } },
  ]
  const asked = world(on, { people: ROOM_PEOPLE, stream: [{ seq: 7, events, people: ROOM_PEOPLE, ended: false, title: 'demo' }] })
  await joinWith($, asked)
  const ui = await $.ui.mount(roomPane('desktop'))
  await ui.press({ key: 'tab-changes' })
  expect(await ui.find({ key: 'open-change-src/upload.ts' })).toBeDefined()
  // The newest file opens first: worked out from its edit, numbered from its first line.
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d')
  await ui.press({ key: 'open-change-src/upload.ts' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -12,1 +12,1 @@\n-const MAX = 3\n+const MAX = limit()')
  expect(await ui.find({ type: 'Text', text: ' Alex ' })).toBeDefined()
  // And the People page counts the calls, the files and the lines.
  await ui.press({ key: 'tab-people' })
  expect(await ui.find({ type: 'Text', text: '2 · +3 −2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '3' })).toBeDefined()
  await ui.unmount()
})

test("a reply shows the room's reactions and who saw it, and a press adds mine for everyone", async ($, on) => {
  const text = 'Done: the 503 path has its own test now.'
  const key = replyKey(text)
  const events = [
    { seq: 2, type: 'react', from: ALEX, ts: 900, body: { key, emoji: '👍', on: true } },
    { seq: 3, type: 'seen', from: ALEX, ts: 901, body: { keys: [key] } },
  ]
  const asked = world(on, { people: ROOM_PEOPLE, stream: [{ seq: 3, events, people: ROOM_PEOPLE, ended: false, title: 'demo' }] })
  on('ui.render', () => NATIVE)
  await joinWith($, asked)
  for (const surface of SURFACES) {
    const reply = await $.ui.mount({
      plugin: 'shared-session',
      surface,
      component: 'AssistantMessage',
      requestId: `m-${surface}`,
      props: { text, isFirstOfReply: true } as never,
    })
    expect(JSON.stringify(await reply.drawn())).toContain('"type":"engine"')
    expect((await reply.find({ key: 'react-👍' }))?.props.label).toBe('👍 1')
    expect(await reply.find({ type: 'Text', text: 'Alex saw this' })).toBeDefined()
    expect(Boolean(await reply.find({ type: 'Svg' }))).toBe(surface === 'desktop')
    await reply.unmount()
  }
  const reply = await $.ui.mount({
    plugin: 'shared-session',
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId: 'm-1',
    props: { text, isFirstOfReply: true } as never,
  })
  await reply.press({ key: 'react-🎉' })
  await asked.clock.advance(300)
  expect(asked.posted.find(e => e.type === 'react')?.body).toEqual({ key, emoji: '🎉', on: true })
  expect((await reply.find({ key: 'react-🎉' }))?.props.label).toBe('🎉 1')
  // On this guest's screen: said to the room as seen.
  await asked.clock.advance(4_100)
  expect(asked.posted.find(e => e.type === 'seen')?.body.keys).toContain(key)
})

test('a prompt that @mentions you pings, says so, and starts your reply', async ($, on) => {
  const played: string[] = []
  const suggested: string[] = []
  on('audio.play', ($, e) => {
    played.push(String((e as { clip?: { asset?: string } }).clip?.asset))
    return { value: undefined }
  })
  on('prompt.suggest', ($, e) => {
    suggested.push(e.text)
    return { isShown: true }
  })
  const events = [
    { seq: 2, type: 'turn', from: SAM, ts: 900, body: { state: 'start', turnId: 't1', by: 'Alex', prompt: '@scott can you look at the 503 test?' } },
  ]
  const asked = world(on, {
    people: ROOM_PEOPLE,
    stream: [
      { seq: 1, events: [], people: ROOM_PEOPLE, ended: false, title: 'demo' },
      { seq: 2, events, people: ROOM_PEOPLE, ended: false, title: 'demo' },
    ],
  })
  await joinWith($, asked)
  await asked.clock.advance(500)
  expect(asked.toasted.some(t => t.startsWith('Alex mentioned you: @scott can you look'))).toBe(true)
  expect(played).toContain('sounds/mention.wav')
  expect(suggested).toContain('@Alex ')
})

test('/who answers with a card: everyone, what each is doing, and the Room a press away', async ($, on) => {
  const asked = world(on, { people: ROOM_PEOPLE })
  await joinWith($, asked)
  const said = await $.command.run({ command: 'who', args: '' } as never)
  expect((said as { text: string }).text).toMatch(/In Sam's session: Sam, scott and 1 more here/)
  const card = await $.ui.mount({
    plugin: 'shared-session',
    surface: 'desktop',
    component: 'CommandOutput',
    requestId: 'out-1',
    props: { command: 'who', args: '', text: 'x', isErrored: false } as never,
  })
  for (const name of ['Sam', 'scott', 'Alex']) expect(await card.find({ type: 'Text', text: name })).toBeDefined()
  expect(await card.find({ key: 'who-room' })).toBeDefined()
})

test('your own prompt in a shared session keeps its bubble, under your name', async ($, on) => {
  const asked = world(on, { people: ROOM_PEOPLE })
  on('ui.render', () => NATIVE)
  await joinWith($, asked)
  const row = await $.ui.mount({ ...ROW('Add a test for the 503 path', { kind: 'composer' }), surface: 'desktop', requestId: 'u-1' } as never)
  // Under the name, the row as drawn beneath (here the test world's stand-in for the bubble).
  expect(await row.find({ type: 'Text', text: ' scott ' })).toBeDefined()
  expect(await row.find({ type: 'Text', text: 'Add a test for the 503 path' })).toBeDefined()
})

test("the host's edit goes to the room with its hunks, as the tool reported them", async ($, on) => {
  const asked = world(on)
  on(
    'tool.call',
    () =>
      ({
        result: { filePath: '/repo/src/a.ts', structuredPatch: [{ oldStart: 7, oldLines: 1, newStart: 7, newLines: 2, lines: ['-x', '+y', '+z'] }] },
      }) as never,
  )
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(50)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y\nz' } as never)
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] },
    door: 'tool-result',
    origin: { kind: 'composer' },
    uuid: 'r1',
  } as never)
  await asked.clock.advance(300)
  const result = asked.posted.find(e => e.type === 'row' && e.body.kind === 'result' && e.body.id === 'e1')
  expect(result?.body.patch).toBe('@@ -7,1 +7,2 @@\n-x\n+y\n+z')
})

test('what you hear is yours to set, and kept for your next session', async ($, on) => {
  const played: string[] = []
  on('audio.play', ($, e) => {
    played.push(String((e as { clip?: { asset?: string } }).clip?.asset))
    return { value: undefined }
  })
  // Chosen in an earlier session: someone joining knocks.
  const events = [{ seq: 2, type: 'join', from: ALEX, ts: 900, body: {} }]
  const asked = world(on, {
    store: { prefs: { sounds: 'all' } },
    people: ROOM_PEOPLE,
    stream: [
      { seq: 1, events: [], people: ROOM_PEOPLE, ended: false, title: 'demo' },
      { seq: 2, events, people: ROOM_PEOPLE, ended: false, title: 'demo' },
    ],
  })
  await joinWith($, asked)
  await asked.clock.advance(500)
  expect(played).toContain('sounds/join.wav')
  // Set in the Room: kept in the store for the next session.
  const pane = await $.ui.mount(roomPane('desktop'))
  await pane.press({ key: 'tab-settings' })
  await pane.select({ key: 'pref-voice', value: 'on' })
  expect(asked.store.get('prefs')).toMatchObject({ sounds: 'all', voice: true, statusLine: false })
})
