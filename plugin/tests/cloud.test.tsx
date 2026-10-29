// The cloud host (docs/cloud-host.md).

import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'
import { LINK, band, world, eventually, liveLines, PANE, START, checkpointPath, DISCOVERED, NEEDS, needLine, within } from './support/world'
import type { LiveLines } from './support/world'

// ---------------------------------------------------------------------------
// The cloud host (docs/cloud-host.md).

const CLOUD_PEOPLE = [
  { id: 'host', name: 'scott', role: 'host', online: true },
  { id: 'seat2', name: 'Alex', role: 'guest', online: true },
]

const CLOUD_TOKEN_FILE = '/home/scott/.claude/shared-session/cloud-token'

const SETUP_TOKEN = `sk-ant-oat01-${'x'.repeat(40)}`

// What every page of a room says while its host is in the cloud.
const IN_CLOUD = { state: 'running', approver: 'scott', since: 900 }

// A cloud host (cloud/runner.mjs starts it with SHARED_SESSION_RUNNER=1) has
// nobody at its screen: a teammate's call goes to the room's approver as a
// question, never a dialog, and their answer settles it. A room set to ask
// nothing still asks there: the runner holds its approver's sign-in.
test("a cloud host puts a teammate's call to its approver through the room, never a dialog, and the approver's answer settles it", async ($, on) => {
  const prompt = { seq: 2, type: 'prompt', ts: 900, from: { seat: 'seat2', name: 'Alex', role: 'guest' }, body: { text: 'Run the tests', pid: 'p1' } }
  const lines = liveLines({
    seq: 2,
    events: [prompt],
    people: CLOUD_PEOPLE,
    ended: false,
    title: 'demo',
    cloud: { state: 'running', approver: 'scott', since: 900 },
  })
  const asked = world(on, { live: lines, env: { SHARED_SESSION_RUNNER: '1' } })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.check', () => ({ decision: 'allow', reason: 'Allowed in this mode' }))
  let dialogs = 0
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    dialogs += 1
    throw new Error('no dialog here')
  })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  expect(await within(asked.clock, () => asked.submitted.some(p => p.text === 'Alex: Run the tests'), 5_000)).toBe(true)
  await $.turn.start({ turnId: 'alex-1', text: 'Alex: Run the tests' })
  // The room asks nothing: a cloud host asks anyway.
  asked.state.policy = { prompts: 'everyone', approvals: 'none', files: 'on' }
  let verdict: unknown
  void $.tool.check({ tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'toolu_t1' } as never).then(v => void (verdict = v))
  const question = await eventually(asked.clock, () => asked.posted.find(e => e.type === 'ask'))
  expect(question?.body).toMatchObject({ who: 'Alex', what: 'Bash npm test', options: ['Allow once', 'Always allow Alex', 'Decline'] })
  expect(dialogs).toBe(0)
  expect(asked.state.approving ?? null).toBeNull() // nothing drawn here
  // Not settled by anyone but its answer.
  await asked.clock.advance(60_000)
  expect(verdict).toBeUndefined()
  lines.push({
    seq: 4,
    events: [{ seq: 4, type: 'answer', ts: 950, from: { seat: 'seatC', name: 'scott', role: 'guest' }, body: { id: question!.body.id, answer: 'Allow once' } }],
    people: CLOUD_PEOPLE,
    ended: false,
    title: 'demo',
  })
  expect(await eventually(asked.clock, () => verdict)).toEqual({ decision: 'allow', reason: 'scott allowed it' })
  await asked.clock.advance(50)
  expect(asked.posted.filter(e => e.type === 'approval').at(-1)?.body).toEqual({
    pending: false,
    what: 'Bash npm test',
    allowed: true,
    by: 'Alex',
    id: question!.body.id,
  })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// Ten minutes unanswered is a no, as in the row above a host's prompt.
test("a cloud host's question unanswered for ten minutes is a no", { timeoutMs: 20_000 }, async ($, on) => {
  const prompt = { seq: 2, type: 'prompt', ts: 900, from: { seat: 'seat2', name: 'Alex', role: 'guest' }, body: { text: 'Run the tests', pid: 'p1' } }
  const asked = world(on, {
    live: liveLines({ seq: 2, events: [prompt], people: CLOUD_PEOPLE, ended: false, title: 'demo' }),
    env: { SHARED_SESSION_RUNNER: '1' },
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.check', () => ({ decision: 'allow', reason: 'Allowed in this mode' }))
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  expect(await within(asked.clock, () => asked.submitted.some(p => p.text === 'Alex: Run the tests'), 5_000)).toBe(true)
  await $.turn.start({ turnId: 'alex-1', text: 'Alex: Run the tests' })
  let verdict: { decision?: string } | undefined
  void $.tool.check({ tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'toolu_t2' } as never).then(v => void (verdict = v as never))
  expect(await eventually(asked.clock, () => asked.posted.some(e => e.type === 'ask'))).toBe(true)
  await asked.clock.advance(10 * 60_000 + 1_000)
  expect((await eventually(asked.clock, () => verdict))?.decision).toBe('deny')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// The approver (the session that moved it) sees the cloud host's question
// above the prompt and in the Room, answers it there, and it's off the list;
// one answered elsewhere (another of their sessions) goes too.
test("the approver answers the cloud host's question above the prompt, and the room hears only that", async ($, on) => {
  const saved = {
    at: 900,
    room: {
      server: 'https://share.test',
      id: 'room0000000000000001',
      url: LINK,
      title: 'demo',
      host: 'scott',
      token: 'g-cloud',
      seat: 'seatC',
      seq: 2,
      since: 1,
    },
    autoOpen: true,
    policy: { prompts: 'everyone', approvals: 'edits', files: 'on' },
    shown: [],
    activity: [],
    chat: [],
    sidebar: null,
    cloudMine: true,
  }
  const ask = (id: string, what: string, seq: number) => ({
    seq,
    type: 'ask',
    ts: 1_000,
    from: { seat: 'host', name: 'scott', role: 'host' },
    body: { id, who: 'Alex', what, preview: `\`\`\`\n${what}\n\`\`\``, always: 'Always allow Alex', options: ['Allow once', 'Always allow Alex', 'Decline'] },
  })
  const lines = liveLines({ seq: 3, events: [ask('q1', 'Bash npm test', 3)], people: CLOUD_PEOPLE, ended: false, title: 'demo', cloud: IN_CLOUD })
  const asked = world(on, { live: lines, files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: saved }) } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start(START)
  expect(await within(asked.clock, () => asked.state.cloudAsks?.length === 1, 5_000)).toBe(true)
  expect(asked.state.cloud).toMatchObject({ state: 'running', mine: true })
  const row = await $.ui.mount(band('desktop'))
  expect((await row.find({ type: 'Text', text: /wants the cloud host to run/ }))?.text).toBe('Alex wants the cloud host to run Bash npm test')
  await row.press({ key: 'cloud-once' })
  await asked.clock.advance(50)
  expect(asked.posted.filter(e => e.type === 'answer').map(e => e.body)).toEqual([{ id: 'q1', answer: 'Allow once' }])
  expect(asked.state.cloudAsks).toEqual([])
  // The Room shows the next one whole, and one answered elsewhere leaves it.
  lines.push({ seq: 5, events: [ask('q2', 'Bash rm -rf build', 5)], people: CLOUD_PEOPLE, ended: false, title: 'demo', cloud: IN_CLOUD })
  expect(await within(asked.clock, () => asked.state.cloudAsks?.length === 1, 5_000)).toBe(true)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect(await pane.find({ type: 'Text', text: 'In the cloud' })).toBeDefined()
  expect(await pane.find({ key: 'cloud-ask-once-q2' })).toBeDefined()
  expect(await pane.find({ key: 'cloud-home' })).toBeDefined()
  lines.push({
    seq: 6,
    events: [{ seq: 6, type: 'answer', ts: 1_100, from: { seat: 'seatD', name: 'scott', role: 'guest' }, body: { id: 'q2', answer: 'Decline' } }],
    people: CLOUD_PEOPLE,
    ended: false,
    title: 'demo',
    cloud: IN_CLOUD,
  })
  expect(await within(asked.clock, () => asked.state.cloudAsks?.length === 0, 5_000)).toBe(true)
  await $.session.end({ reason: 'other', sessionId: 'session-test-0001', resume: {} } as never)
})

// A cloud host draws nothing, so a page its Claude gives out is its
// approver's to give: asked through the room as its calls are, and shared
// only on their Share.
const cloudMention = ($: Parameters<TestBody>[0], port: number, uuid: string) =>
  $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: `Running at http://localhost:${port}/dash` }] },
    door: 'response',
    origin: { kind: 'composer' },
    uuid,
  } as never)

const approverSays = (lines: LiveLines, seq: number, id: string, answer: string) =>
  lines.push({
    seq,
    events: [{ seq, type: 'answer', ts: 950, from: { seat: 'seatC', name: 'scott', role: 'guest' }, body: { id, answer } }],
    people: CLOUD_PEOPLE,
    ended: false,
    title: 'demo',
    cloud: IN_CLOUD,
  })

test('a cloud host asks its approver through the room whether to share a page its Claude gives out, and shares it on their Share', async ($, on) => {
  const lines = liveLines({ seq: 1, events: [], people: CLOUD_PEOPLE, ended: false, title: 'demo', cloud: IN_CLOUD })
  const asked = world(on, { live: lines, env: { SHARED_SESSION_RUNNER: '1' } })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  await cloudMention($, 3340, 'a1')
  const question = await eventually(asked.clock, () => asked.posted.find(e => e.type === 'ask'))
  expect(question?.body).toMatchObject({ kind: 'show', port: 3340, related: [], options: ['Share', 'Not now'] })
  // Nothing drawn here, nothing shared until the approver says so.
  expect(asked.state.hostAsk ?? null).toBeNull()
  await asked.clock.advance(60_000)
  expect(asked.sent.filter(x => x.path.endsWith('/previews'))).toEqual([])
  expect(asked.posted.filter(e => e.type === 'artifact')).toEqual([])
  approverSays(lines, 3, String(question!.body.id), 'Share')
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact'))
  expect(asked.posted.find(e => e.type === 'artifact')?.body).toMatchObject({ kind: 'preview', port: 3340, path: '/dash' })
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body)).toEqual([{ port: 3340, title: 'localhost:3340' }])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a cloud host's question about a page: the approver's Not now holds for the room; unanswered in ten minutes, it's taken back, and asked again later", async ($, on) => {
  const lines = liveLines({ seq: 1, events: [], people: CLOUD_PEOPLE, ended: false, title: 'demo', cloud: IN_CLOUD })
  const asked = world(on, { live: lines, env: { SHARED_SESSION_RUNNER: '1' }, pages: { 3341: 'exit=28\ncode=000\n' } })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  const questions = () => asked.posted.filter(e => e.type === 'ask' && e.body.kind === 'show' && e.body.done !== true)
  await cloudMention($, 3340, 'a1')
  await eventually(asked.clock, () => questions().length === 1)
  approverSays(lines, 3, String(questions()[0]!.body.id), 'Not now')
  await eventually(asked.clock, () => asked.state.hostMemory?.declined.includes(3340))
  // Unanswered: taken back at ten minutes, off the approver's list.
  await cloudMention($, 3341, 'a2')
  await eventually(asked.clock, () => questions().length === 2)
  const second = String(questions()[1]!.body.id)
  await asked.clock.advance(10 * 60_000 + 1_000)
  expect(await eventually(asked.clock, () => asked.posted.some(e => e.type === 'ask' && e.body.id === second && e.body.done === true))).toBe(true)
  expect(asked.sent.filter(x => x.path.endsWith('/previews'))).toEqual([])
  // Later: the one taken back is asked again; the one declined isn't.
  await asked.clock.advance(60_000)
  await cloudMention($, 3340, 'a3')
  await cloudMention($, 3341, 'a4')
  await eventually(asked.clock, () => questions().length === 3)
  await asked.clock.advance(5_000)
  expect(questions().map(e => e.body.port)).toEqual([3340, 3341, 3341])
  expect(asked.sent.filter(x => x.path.endsWith('/previews'))).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// The approver (the session that moved it) answers it above the prompt or
// in the Room; a question the cloud host took back leaves the list.
test("the approver is asked whether to share the cloud host's page, above the prompt and in the Room; a question taken back goes", async ($, on) => {
  const saved = {
    at: 900,
    room: {
      server: 'https://share.test',
      id: 'room0000000000000001',
      url: LINK,
      title: 'demo',
      host: 'scott',
      token: 'g-cloud',
      seat: 'seatC',
      seq: 2,
      since: 1,
    },
    autoOpen: true,
    policy: { prompts: 'everyone', approvals: 'edits', files: 'on' },
    shown: [],
    activity: [],
    chat: [],
    sidebar: null,
    cloudMine: true,
  }
  const show = (id: string, port: number, seq: number) => ({
    seq,
    type: 'ask',
    ts: 1_000,
    from: { seat: 'host', name: 'scott', role: 'host' },
    body: { id, kind: 'show', port, who: '', what: `localhost:${port}`, options: ['Share', 'Not now'] },
  })
  const lines = liveLines({ seq: 3, events: [show('s1', 3340, 3)], people: CLOUD_PEOPLE, ended: false, title: 'demo', cloud: IN_CLOUD })
  const asked = world(on, { live: lines, files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: saved }) } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start(START)
  expect(await within(asked.clock, () => asked.state.cloudAsks?.length === 1, 5_000)).toBe(true)
  expect(asked.state.cloudAsks?.[0]).toMatchObject({
    id: 's1',
    kind: 'show',
    port: 3340,
    what: "Share the cloud host's localhost:3340 with the room?",
    always: '',
    options: ['Share', 'Not now'],
  })
  const row = await $.ui.mount(band('desktop'))
  expect((await row.find({ type: 'Text', text: /cloud host's localhost/ }))?.text).toBe("Share the cloud host's localhost:3340 with the room?")
  expect(await row.find({ key: 'cloud-once' })).toBeUndefined()
  expect((await row.find({ key: 'cloud-yes' }))?.props.label).toBe('Share')
  await row.press({ key: 'cloud-yes' })
  await asked.clock.advance(50)
  expect(asked.posted.filter(e => e.type === 'answer').map(e => e.body)).toEqual([{ id: 's1', answer: 'Share' }])
  expect(asked.state.cloudAsks).toEqual([])
  // The next, in the Room too, said as it comes; taken back, it goes.
  lines.push({ seq: 5, events: [show('s2', 3341, 5)], people: CLOUD_PEOPLE, ended: false, title: 'demo', cloud: IN_CLOUD })
  expect(await within(asked.clock, () => asked.state.cloudAsks?.length === 1, 5_000)).toBe(true)
  expect(asked.toasted).toContain("Share the cloud host's localhost:3341 with the room? Answer above the prompt")
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect(await pane.find({ key: 'cloud-ask-yes-s2' })).toBeDefined()
  expect(await pane.find({ key: 'cloud-ask-not-now-s2' })).toBeDefined()
  lines.push({
    seq: 6,
    events: [{ seq: 6, type: 'ask', ts: 1_100, from: { seat: 'host', name: 'scott', role: 'host' }, body: { id: 's2', done: true } }],
    people: CLOUD_PEOPLE,
    ended: false,
    title: 'demo',
    cloud: IN_CLOUD,
  })
  expect(await within(asked.clock, () => asked.state.cloudAsks?.length === 0, 5_000)).toBe(true)
  await $.session.end({ reason: 'other', sessionId: 'session-test-0001', resume: {} } as never)
})

// The approver's session, taken up as Move to cloud leaves it: joined, the
// cloud host's questions and settings its own.
async function approverHere($: Parameters<TestBody>[0], on: On, lines: LiveLines) {
  const saved = {
    at: 900,
    room: {
      server: 'https://share.test',
      id: 'room0000000000000001',
      url: LINK,
      title: 'demo',
      host: 'scott',
      token: 'g-cloud',
      seat: 'seatC',
      seq: 2,
      since: 1,
    },
    autoOpen: true,
    policy: { prompts: 'everyone', approvals: 'edits', files: 'on' },
    shown: [],
    activity: [],
    chat: [],
    sidebar: null,
    cloudMine: true,
  }
  const asked = world(on, { live: lines, files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: saved }) } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start(START)
  expect(await within(asked.clock, () => asked.state.cloud?.mine === true, 5_000)).toBe(true)
  return asked
}

const FROM_APPROVER = { seat: 'seatC', name: 'scott', role: 'guest', approver: true }

const cloudPage = (seq: number, events: unknown[]) => ({ seq, events, people: CLOUD_PEOPLE, ended: false, title: 'demo', cloud: IN_CLOUD })

// Everything a host's row asks about its localhost goes to a cloud host's
// approver, one question at a time: whether to share a page, whether
// teammates may open it at the same address, what it uses beside it.
test('a cloud host puts every question its row would ask to its approver, one at a time: Share, the same address, then what the page uses beside it', async ($, on) => {
  const lines = liveLines(cloudPage(1, []))
  const asked = world(on, { live: lines, env: { SHARED_SESSION_RUNNER: '1' }, discover: { 3340: DISCOVERED } })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  const questions = () => asked.posted.filter(e => e.type === 'ask' && typeof e.body.kind === 'string' && e.body.done !== true)
  await cloudMention($, 3340, 'a1')
  await eventually(asked.clock, () => questions().length === 1)
  expect(questions()[0]!.body).toMatchObject({ kind: 'show', port: 3340, options: ['Share', 'Not now'] })
  approverSays(lines, 3, String(questions()[0]!.body.id), 'Share')
  // Shared through its link; then, with a teammate here, the same address, as a question of its own.
  await eventually(asked.clock, () => questions().length === 2)
  expect(asked.posted.find(e => e.type === 'artifact')?.body).toMatchObject({ port: 3340, path: '/dash' })
  expect(asked.posted.find(e => e.type === 'artifact')?.body.tcp).toBeUndefined()
  expect(questions()[1]!.body).toMatchObject({ kind: 'mention', port: 3340, label: 'next-server', options: ['Allow', 'Not now'] })
  await asked.clock.advance(60_000)
  expect(asked.posted.some(e => e.type === 'artifact' && e.body.tcp === true)).toBe(false)
  approverSays(lines, 4, String(questions()[1]!.body.id), 'Allow')
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact' && e.body.tcp === true))
  // Then the server it uses, which a Share too forwards for that page.
  await eventually(asked.clock, () => questions().length === 3)
  expect(questions()[2]!.body).toMatchObject({
    kind: 'related',
    port: 3340,
    related: [{ port: 3610, label: 'convex-local-backend' }],
    options: ['Share too', 'Not now'],
  })
  approverSays(lines, 5, String(questions()[2]!.body.id), 'Share too')
  await eventually(asked.clock, () => asked.posted.filter(e => e.type === 'artifact' && e.body.tcp === true).length === 2)
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body)).toEqual([
    { port: 3340, title: 'localhost:3340' },
    { port: 3340, title: 'localhost:3340', tcp: true },
    { port: 3610, title: 'localhost:3610 (convex-local-backend)', tcp: true },
  ])
  expect(asked.posted.filter(e => e.type === 'artifact' && e.body.tcp === true).map(e => [e.body.port, e.body.dependency])).toEqual([
    [3340, undefined],
    [3610, 3340],
  ])
  // Each yes said what it came to, to the approver; none taken back.
  expect(asked.posted.filter(e => e.type === 'ask' && e.body.done === true).map(e => ({ ...e.body, id: undefined }))).toEqual([
    { id: undefined, done: true, kind: 'show', shared: [3340], failed: [] },
    { id: undefined, done: true, kind: 'mention', shared: [3340], failed: [] },
    { id: undefined, done: true, kind: 'related', shared: [3610], failed: [] },
  ])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// A teammate's window reaching a port nobody shared: the approver's to
// share. The container's own control port (8080) is never asked about.
test("a cloud host asks its approver about a teammate's window needing a port, and never about its runner's own", async ($, on) => {
  const CONTROL = { state: 'done', platform: 'linux', target: { port: 8080, label: 'runner.mjs', web: 'yes', devtools: false }, related: [] }
  const lines = liveLines(cloudPage(1, []))
  const asked = world(on, {
    live: lines,
    env: { SHARED_SESSION_RUNNER: '1' },
    discover: { ...NEEDS, 8080: CONTROL },
    pages: { 8080: 'exit=0\ncode=200 text/html\n' },
  })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  // The runner's control port, given out or needed: never put to the approver, never shared.
  await cloudMention($, 8080, 'a1')
  lines.push(needLine(8080))
  await eventually(asked.clock, () => asked.needLooks.some(d => d.port === 8080), 2_000)
  await asked.clock.advance(2_000)
  expect(asked.posted.filter(e => e.type === 'ask')).toEqual([])
  expect(asked.sent.filter(x => x.path.endsWith('/previews'))).toEqual([])
  // A web server of the project's, needed by Alex's window.
  lines.push(needLine(3610))
  const need = await eventually(asked.clock, () => asked.posted.find(e => e.type === 'ask' && e.body.kind === 'need'))
  expect(need?.body).toMatchObject({ kind: 'need', port: 3610, who: 'Alex', label: 'convex-local-backend', options: ['Share', 'Not now'] })
  approverSays(lines, 3, String(need!.body.id), 'Share')
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact' && e.body.port === 3610 && e.body.tcp === true))
  expect(asked.sent.filter(x => x.path.endsWith('/previews')).map(x => x.body)).toEqual([
    { port: 3610, title: 'localhost:3610 (convex-local-backend)', tcp: true },
  ])
  expect(await eventually(asked.clock, () => asked.posted.find(e => e.type === 'ask' && e.body.done === true)?.body)).toEqual({
    id: need!.body.id,
    done: true,
    kind: 'need',
    shared: [3610],
    failed: [],
  })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// A yes the cloud host couldn't carry out (the room refused to forward it)
// is said to the approver, as one it did: nobody's at the cloud host's
// screen to see its own word.
test("the cloud host tells its approver what their yes came to, and that one couldn't be done", async ($, on) => {
  const refuse = { now: false }
  const lines = liveLines(cloudPage(1, []))
  const asked = world(on, { live: lines, env: { SHARED_SESSION_RUNNER: '1' }, discover: { 3340: DISCOVERED }, refuseForward: refuse })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  const questions = () => asked.posted.filter(e => e.type === 'ask' && typeof e.body.kind === 'string' && e.body.done !== true)
  const outcome = (id: unknown) => asked.posted.find(e => e.type === 'ask' && e.body.done === true && e.body.id === id)?.body
  await cloudMention($, 3340, 'a1')
  await eventually(asked.clock, () => questions().length === 1)
  const share = questions()[0]!.body.id
  approverSays(lines, 3, String(share), 'Share')
  expect(await eventually(asked.clock, () => outcome(share))).toEqual({ id: share, done: true, kind: 'show', shared: [3340], failed: [] })
  // The room won't forward now: the Allow comes to nothing, and the approver is told so.
  await eventually(asked.clock, () => questions().length === 2)
  refuse.now = true
  const allow = questions()[1]!.body.id
  approverSays(lines, 4, String(allow), 'Allow')
  expect(await eventually(asked.clock, () => outcome(allow))).toEqual({ id: allow, done: true, kind: 'mention', shared: [], failed: [3340] })
  expect(asked.posted.some(e => e.type === 'artifact' && e.body.tcp === true)).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("the approver hears what their yes came to at the cloud host: shared, or that it couldn't be", async ($, on) => {
  const done = (seq: number, body: Record<string, unknown>) => ({ seq, type: 'ask', ts: 1_000, from: { seat: 'host', name: 'scott', role: 'host' }, body })
  const lines = liveLines(cloudPage(2, []))
  const asked = await approverHere($, on, lines)
  lines.push(cloudPage(3, [done(3, { id: 's1', done: true, kind: 'show', shared: [3340], failed: [] })]))
  expect(await eventually(asked.clock, () => asked.toasted.includes('The cloud host is sharing localhost:3340 with the room through its link.'))).toBe(true)
  lines.push(cloudPage(4, [done(4, { id: 'm1', done: true, kind: 'mention', shared: [], failed: [3340] })]))
  expect(await eventually(asked.clock, () => asked.toasted.includes("The cloud host couldn't forward localhost:3340 to teammates."))).toBe(true)
  lines.push(cloudPage(5, [done(5, { id: 'r1', done: true, kind: 'related', shared: [3610], failed: [3611] })]))
  expect(
    await eventually(asked.clock, () =>
      asked.toasted.includes("Teammates can reach the cloud host's localhost:3610 now. The cloud host couldn't forward localhost:3611 to teammates."),
    ),
  ).toBe(true)
  // Taken back unanswered: nothing to say.
  const before = asked.toasted.length
  lines.push(cloudPage(6, [done(6, { id: 'n1', done: true })]))
  await asked.clock.advance(1_000)
  expect(asked.toasted.length).toBe(before)
  await $.session.end({ reason: 'other', sessionId: 'session-test-0001', resume: {} } as never)
})

// The approver: each question drawn as the host's row draws it, of the
// cloud host's localhost, with its own yes; one that names nothing a yes
// would share is no question.
test("the approver is asked the cloud host's questions about its localhost as the host's row asks them, each with its own yes", async ($, on) => {
  const ask = (seq: number, body: Record<string, unknown>) => ({ seq, type: 'ask', ts: 1_000, from: { seat: 'host', name: 'scott', role: 'host' }, body })
  const lines = liveLines(
    cloudPage(5, [
      ask(3, { id: 'bad1', kind: 'related', port: 3340, related: [], options: ['Share too', 'Not now'] }),
      ask(4, { id: 'bad2', kind: 'need', port: 99999, who: 'Alex' }),
      ask(5, { id: 'm1', kind: 'mention', port: 3340, label: 'next-server', who: '', related: [], options: ['Allow', 'Not now'] }),
    ]),
  )
  const asked = await approverHere($, on, lines)
  expect(await within(asked.clock, () => asked.state.cloudAsks?.length === 1, 5_000)).toBe(true)
  const row = await $.ui.mount(band('desktop'))
  expect((await row.find({ type: 'Text', text: /^Let guests open/ }))?.text).toBe("Let guests open the cloud host's localhost:3340 at the same address?")
  expect((await row.find({ key: 'cloud-yes' }))?.props.label).toBe('Allow')
  await row.press({ key: 'cloud-yes' })
  await asked.clock.advance(50)
  expect(asked.posted.filter(e => e.type === 'answer').map(e => e.body)).toEqual([{ id: 'm1', answer: 'Allow' }])
  // What the page uses beside it: every port before what may be cut.
  lines.push(
    cloudPage(6, [
      ask(6, {
        id: 'r1',
        kind: 'related',
        port: 3340,
        related: [
          { port: 3610, label: 'convex-local-backend' },
          { port: 3611, label: 'convex-local-backend' },
        ],
        options: ['Share too', 'Not now'],
      }),
    ]),
  )
  expect(await within(asked.clock, () => asked.state.cloudAsks?.[0]?.id === 'r1', 5_000)).toBe(true)
  expect((await row.find({ type: 'Text', text: /^Share localhost/ }))?.text).toBe(
    "Share localhost:3610 and 3611 too? convex-local-backend, beside the cloud host's localhost:3340",
  )
  expect((await row.find({ key: 'cloud-yes' }))?.props.label).toBe('Share too')
  await row.press({ key: 'cloud-yes' })
  await asked.clock.advance(50)
  // A teammate's window: their name in their color, in the Room too.
  lines.push(
    cloudPage(7, [ask(7, { id: 'n1', kind: 'need', port: 3610, label: 'convex-local-backend', who: 'Alex', related: [], options: ['Share', 'Not now'] })]),
  )
  expect(await within(asked.clock, () => asked.state.cloudAsks?.[0]?.id === 'n1', 5_000)).toBe(true)
  expect((await row.find({ type: 'Text', text: /^Alex$/ }))?.props.bold).toBe(true)
  expect(await row.find({ type: 'Text', text: "'s preview needs the cloud host's localhost:3610 · convex-local-backend" })).toBeDefined()
  expect(asked.toasted).toContain("Alex's preview needs the cloud host's localhost:3610 · convex-local-backend: answer above the prompt")
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect((await pane.find({ key: 'cloud-ask-yes-n1' }))?.props.label).toBe('Share')
  await pane.press({ key: 'cloud-ask-not-now-n1' })
  await asked.clock.advance(50)
  expect(asked.posted.filter(e => e.type === 'answer').map(e => e.body)).toEqual([
    { id: 'm1', answer: 'Allow' },
    { id: 'r1', answer: 'Share too' },
    { id: 'n1', answer: 'Not now' },
  ])
  expect(asked.state.cloudAsks).toEqual([])
  await $.session.end({ reason: 'other', sessionId: 'session-test-0001', resume: {} } as never)
})

// The cloud host's settings are its approver's while it runs: set in their
// Room, held there (Bring home takes them), and sent to the room as `set`.
// It asks about every call when told nothing, so Nothing isn't offered.
test("the approver sets the cloud host's settings in the Room, and asks it again about whom they always allowed", async ($, on) => {
  const call = {
    seq: 3,
    type: 'ask',
    ts: 1_000,
    from: { seat: 'host', name: 'scott', role: 'host' },
    body: { id: 'q1', who: 'Alex', seat: 'seat2', what: 'Bash npm test', always: 'Always allow Alex', options: ['Allow once', 'Always allow Alex', 'Decline'] },
  }
  const lines = liveLines(cloudPage(3, [call]))
  const asked = await approverHere($, on, lines)
  expect(await within(asked.clock, () => asked.state.cloudAsks?.length === 1, 5_000)).toBe(true)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-settings' })
  expect(await pane.find({ type: 'Text', text: 'at the cloud host' })).toBeDefined()
  expect(((await pane.find({ key: 'policy-approvals' }))?.props.options as { value: string }[]).map(o => o.value)).toEqual(['edits', 'all'])
  await pane.select({ key: 'policy-approvals', value: 'all' })
  await pane.select({ key: 'policy-prompts', value: 'watch' })
  await asked.clock.advance(50)
  expect(asked.posted.filter(e => e.type === 'set').map(e => e.body)).toEqual([{ approvals: 'all' }, { prompts: 'watch' }])
  expect(asked.posted.filter(e => e.type === 'policy')).toEqual([])
  expect(asked.state.policy).toEqual({ prompts: 'watch', approvals: 'all', files: 'on' })
  // Always allow, then Ask again.
  expect(await pane.find({ key: 'untrust' })).toBeUndefined()
  const row = await $.ui.mount(band('desktop'))
  await row.press({ key: 'cloud-always' })
  await asked.clock.advance(50)
  expect(asked.state.cloudTrusted).toEqual(['Alex'])
  expect(await pane.find({ type: 'Text', text: 'Always allowed: Alex' })).toBeDefined()
  await pane.press({ key: 'untrust' })
  await asked.clock.advance(50)
  expect(asked.posted.filter(e => e.type === 'set').map(e => e.body)).toEqual([{ approvals: 'all' }, { prompts: 'watch' }, { untrust: true }])
  expect(asked.state.cloudTrusted).toEqual([])
  await $.session.end({ reason: 'other', sessionId: 'session-test-0001', resume: {} } as never)
})

// The approver's names for Ask again go with their place: closed and
// opened again, Always allowed and its Ask again are still there.
test("the approver's Always allowed survives their session closing and reopening, and so does its Ask again", async ($, on) => {
  const call = {
    seq: 3,
    type: 'ask',
    ts: 1_000,
    from: { seat: 'host', name: 'scott', role: 'host' },
    body: { id: 'q1', who: 'Alex', seat: 'seat2', what: 'Bash npm test', always: 'Always allow Alex', options: ['Allow once', 'Always allow Alex', 'Decline'] },
  }
  const lines = liveLines(cloudPage(3, [call]))
  const asked = await approverHere($, on, lines)
  expect(await within(asked.clock, () => asked.state.cloudAsks?.length === 1, 5_000)).toBe(true)
  const row = await $.ui.mount(band('desktop'))
  await row.press({ key: 'cloud-always' })
  await asked.clock.advance(50)
  expect(asked.state.cloudTrusted).toEqual(['Alex'])
  await $.session.end({ reason: 'other', sessionId: 'session-test-0001', resume: {} } as never)
  await asked.clock.advance(50)
  expect(asked.state.cloudTrusted).toEqual([])
  await $.session.start(START)
  expect(await within(asked.clock, () => asked.state.cloud?.mine === true, 5_000)).toBe(true)
  expect(asked.state.cloudTrusted).toEqual(['Alex'])
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-settings' })
  expect(await pane.find({ type: 'Text', text: 'Always allowed: Alex' })).toBeDefined()
  await pane.press({ key: 'untrust' })
  await asked.clock.advance(50)
  expect(asked.posted.filter(e => e.type === 'set').map(e => e.body)).toEqual([{ untrust: true }])
  await $.session.end({ reason: 'other', sessionId: 'session-test-0001', resume: {} } as never)
})

// At the cloud host: the approver's settings set as its own and said to
// everyone; watch-only turns teammates away, never the approver (the room
// says which prompt is theirs).
test("the cloud host sets its approver's settings as its own and says so; watch-only turns teammates away but never the approver", async ($, on) => {
  const lines = liveLines(cloudPage(1, []))
  const asked = world(on, { live: lines, env: { SHARED_SESSION_RUNNER: '1' } })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  lines.push(cloudPage(2, [{ seq: 2, type: 'set', ts: 950, from: FROM_APPROVER, body: { prompts: 'watch', approvals: 'all' } }]))
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'policy'))
  expect(asked.posted.filter(e => e.type === 'policy').map(e => e.body)).toEqual([{ prompts: 'watch', approvals: 'all', files: 'on' }])
  expect(asked.state.policy).toEqual({ prompts: 'watch', approvals: 'all', files: 'on' })
  const prompt = (seq: number, from: unknown, text: string, pid: string) => ({ seq, type: 'prompt', ts: 960, from, body: { text, pid } })
  lines.push(cloudPage(4, [prompt(3, { seat: 'seat2', name: 'Alex', role: 'guest' }, 'Run the tests', 'p1'), prompt(4, FROM_APPROVER, 'Fix the build', 'p2')]))
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'declined'))
  expect(asked.posted.filter(e => e.type === 'declined').map(e => e.body.pid)).toEqual(['p1'])
  expect(await within(asked.clock, () => asked.submitted.some(p => p.text === 'scott: Fix the build'), 5_000)).toBe(true)
  expect(asked.submitted.some(p => p.text.includes('Run the tests'))).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("the approver's Ask again reaches the cloud host: a teammate it always allowed is asked about again", async ($, on) => {
  const prompt = { seq: 2, type: 'prompt', ts: 900, from: { seat: 'seat2', name: 'Alex', role: 'guest' }, body: { text: 'Run the tests', pid: 'p1' } }
  const lines = liveLines(cloudPage(2, [prompt]))
  const asked = world(on, { live: lines, env: { SHARED_SESSION_RUNNER: '1' } })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.check', () => ({ decision: 'allow', reason: 'Allowed in this mode' }))
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  expect(await within(asked.clock, () => asked.submitted.some(p => p.text === 'Alex: Run the tests'), 5_000)).toBe(true)
  await $.turn.start({ turnId: 'alex-1', text: 'Alex: Run the tests' })
  const check = (id: string) => {
    const got: { verdict?: unknown } = {}
    void $.tool.check({ tool: 'Bash', input: { command: 'npm test' }, tool_use_id: id } as never).then(v => void (got.verdict = v))
    return got
  }
  const first = check('toolu_t1')
  const question = await eventually(asked.clock, () => asked.posted.find(e => e.type === 'ask'))
  lines.push(cloudPage(4, [{ seq: 4, type: 'answer', ts: 950, from: FROM_APPROVER, body: { id: question!.body.id, answer: 'Always allow Alex' } }]))
  expect(await eventually(asked.clock, () => first.verdict)).toMatchObject({ decision: 'allow' })
  expect(await $.tool.check({ tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'toolu_t2' } as never)).toMatchObject({
    decision: 'allow',
    reason: 'scott always allows Alex',
  })
  // Ask again, from the approver: Alex is asked about again.
  lines.push(cloudPage(5, [{ seq: 5, type: 'set', ts: 960, from: FROM_APPROVER, body: { untrust: true } }]))
  expect(await eventually(asked.clock, () => asked.state.trusted?.length === 0)).toBe(true)
  const third = check('toolu_t3')
  await eventually(asked.clock, () => asked.posted.filter(e => e.type === 'ask').length === 2)
  await asked.clock.advance(1_000)
  expect(third.verdict).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// A guest who isn't the approver never sees the cloud host's questions.
test("a teammate who isn't the approver isn't asked", async ($, on) => {
  const ask = {
    seq: 2,
    type: 'ask',
    ts: 1_000,
    from: { seat: 'host', name: 'Sam', role: 'host' },
    body: { id: 'q1', who: 'Alex', what: 'Bash npm test', always: 'Always allow Alex', options: ['Allow once', 'Always allow Alex', 'Decline'] },
  }
  const asked = world(on, {
    stream: [{ seq: 2, events: [ask], people: CLOUD_PEOPLE, ended: false, title: 'demo', cloud: { state: 'running', approver: 'Sam', since: 900 } }],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await eventually(asked.clock, () => asked.state.cloud)
  expect(asked.state.cloud).toMatchObject({ approver: 'Sam', mine: false })
  await asked.clock.advance(100)
  expect(asked.state.cloudAsks ?? []).toEqual([])
})

// Move to cloud: without a token kept here, the Room says how to make one;
// the copied token is taken from the clipboard (never shown), kept 0600, and
// the move goes on: the project packed, the room told, the packed session
// sent with its ticket on stdin, and this session goes on as the approver.
test('Move to cloud asks for a token once, then hands the host over and goes on here as its approver', async ($, on) => {
  const asked = world(on, {
    stream: [{ seq: 1, events: [], people: [{ id: 'host', name: 'scott', role: 'host', online: true }], ended: false, title: 'demo' }],
    cloud: { clipboard: `${SETUP_TOKEN}\n` },
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await eventually(asked.clock, () => asked.state.mode === 'host')
  let pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-settings' })
  await pane.press({ key: 'cloud-move' })
  expect(asked.state.cloudMove).toEqual({ stage: 'token' })
  await pane.unmount()
  pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect(await pane.find({ type: 'Text', text: /claude setup-token/ })).toBeDefined()
  await pane.press({ key: 'cloud-use-token' })
  expect(await eventually(asked.clock, () => asked.state.mode === 'guest', 300)).toBe(true)
  // The token kept here, private, and never on screen or in what the room keeps.
  expect(asked.files.get(CLOUD_TOKEN_FILE)).toBe(SETUP_TOKEN)
  const move = asked.sent.find(r => r.path.endsWith('/cloud'))!
  expect(move.headers.authorization).toBe('Bearer t')
  expect(move.body).toMatchObject({ session: expect.any(String), cwd: expect.any(String), auth: { oauthToken: SETUP_TOKEN } })
  const upload = asked.spawned.find(s => s.input?.includes('/cloud/bundle'))!
  expect(upload.input).toContain('Authorization: Bearer ticket-cloud')
  expect(upload.argv.join(' ')).not.toContain('ticket-cloud')
  expect(asked.state.room).toMatchObject({ token: 'g-cloud', seat: 'seatC' })
  expect(asked.state.cloud).toMatchObject({ mine: true })
  expect(asked.state.cloudMove).toBeNull()
  expect(JSON.stringify(asked.posted)).not.toContain(SETUP_TOKEN)
})

// A server that can't host in the cloud says so, and nothing moves.
test('a server without cloud hosts says so, and the session stays here', async ($, on) => {
  const asked = world(on, {
    stream: [{ seq: 1, events: [], people: [{ id: 'host', name: 'scott', role: 'host', online: true }], ended: false, title: 'demo' }],
    files: { [CLOUD_TOKEN_FILE]: SETUP_TOKEN },
    cloud: { refuse: true },
  })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await eventually(asked.clock, () => asked.state.mode === 'host')
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-settings' })
  await pane.press({ key: 'cloud-move' })
  expect(await eventually(asked.clock, () => asked.state.cloudMove?.stage === 'failed', 300)).toBe(true)
  expect(asked.state.cloudMove?.note).toMatch(/can't keep sessions running in the cloud/)
  expect(asked.state.mode).toBe('host')
  expect(asked.state.room?.token).toBe('t')
})

// A packed session the runner didn't take brings the host straight back.
test("a packed session that doesn't reach the cloud host leaves the session here", async ($, on) => {
  const asked = world(on, {
    stream: [{ seq: 1, events: [], people: [{ id: 'host', name: 'scott', role: 'host', online: true }], ended: false, title: 'demo' }],
    files: { [CLOUD_TOKEN_FILE]: SETUP_TOKEN },
    cloud: { bundleStatus: '502' },
  })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await eventually(asked.clock, () => asked.state.mode === 'host')
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-settings' })
  await pane.press({ key: 'cloud-move' })
  expect(await eventually(asked.clock, () => asked.state.cloudMove?.stage === 'failed', 300)).toBe(true)
  expect(asked.sent.some(r => r.path.endsWith('/cloud/home') && r.headers.authorization === 'Bearer g-cloud')).toBe(true)
  expect(asked.state.mode).toBe('host')
})

// Bring home: the approver's press. The room hands the host back, this
// session hosts again, and the cloud's changes go into the project.
test('Bring home takes the host back here with the cloud host’s changes', async ($, on) => {
  const saved = {
    at: 900,
    room: {
      server: 'https://share.test',
      id: 'room0000000000000001',
      url: LINK,
      title: 'demo',
      host: 'scott',
      token: 'g-cloud',
      seat: 'seatC',
      seq: 2,
      since: 1,
    },
    autoOpen: true,
    policy: { prompts: 'everyone', approvals: 'edits', files: 'on' },
    shown: [],
    activity: [],
    chat: [],
    sidebar: null,
    cloudMine: true,
  }
  const asked = world(on, {
    stream: [{ seq: 2, events: [], people: CLOUD_PEOPLE, ended: false, title: 'demo', cloud: { state: 'running', approver: 'scott', since: 900 } }],
    files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: saved }) },
    cloud: { changes: true },
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  expect(await eventually(asked.clock, () => asked.state.mode === 'guest' && asked.state.cloud?.mine)).toBe(true)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'cloud-home' })
  expect(await eventually(asked.clock, () => asked.state.mode === 'host', 300)).toBe(true)
  expect(asked.state.room).toMatchObject({ token: 't-home', seat: 'host' })
  expect(asked.sent.find(r => r.path.endsWith('/cloud/home'))?.headers.authorization).toBe('Bearer g-cloud')
  const applied = asked.spawned.find(s => s.input?.includes('git apply --check'))!
  expect(applied.input).toContain(`/files/${'c'.repeat(64)}`)
  expect(applied.input).toContain('Authorization: Bearer t-home')
  expect(await eventually(asked.clock, () => asked.logged.some(l => /with the cloud host's changes to 2 files/.test(l)))).toBe(true)
})
