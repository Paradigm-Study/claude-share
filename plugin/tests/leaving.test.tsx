// Leaving, Stop sharing and a session closing, while previews and windows are
// open; seated anew; Claude's browser and the Room's settings.

import { expect, test } from 'claude-code/testing'
import {
  LINK,
  band,
  world,
  eventually,
  PANE,
  PREVIEW_PEOPLE,
  LOCAL_SHOWN,
  HISTORY,
  START,
  checkpointPath,
  savedAt,
  NAMED,
  LIVE,
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
  openedInWindow,
  SIGNED_IN,
  hostProfilePath,
  DEP_SHOWN,
  autoWorld,
  localWorld,
  refusing,
  reloaded,
  CUT_HOST,
  CUT_GUEST,
  paneCalls,
  LOCAL_URL,
  localStream,
  HOST_ONLY,
  HOST_FROM,
  within,
  removedProfiles,
} from './support/world'

// Leaving goes idle first: from the moment a room is left, what the mode
// drives is this session's own (D2-16).
test("a prompt typed while Leave is still closing the room is this person's own: it never reaches the host's Claude", async ($, on) => {
  let gone: (() => void) | undefined
  const asked = windowWorld(on, {
    beforeKill: wait =>
      wait
        ? new Promise<void>(done => {
            gone = done
          })
        : Promise.resolve(),
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  let own = 0
  on('turn.step', async function* ($, e) {
    own += 1
    yield { kind: 'text', index: 0, text: 'Ran them here.' } as never
    yield { kind: 'stop', stopReason: 'end_turn', usage: null } as never
    return { turnId: e.turnId, index: e.index, answer: 'Ran them here.', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await openedInWindow($, asked)
  const leaving = $.command.run({ command: 'stop-sharing', args: '' } as never)
  // Its window closing (seconds, at worst): the room not told yet, the seat still good.
  expect(await eventually(asked.clock, () => Boolean(gone))).toBe(true)
  expect(asked.some(a => a.endsWith('/leave'))).toBe(false)
  await $.prompt.submit({ text: 'Run my own tests please', origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(200)
  expect(asked.posted.filter(e => e.type === 'prompt')).toEqual([])
  expect(asked.submitted.at(-1)?.text).toBe('Run my own tests please')
  // Its turn is this session's own Claude's, not a ride of the host's.
  await $.turn.start({ turnId: 'mine', text: 'Run my own tests please' })
  const said: string[] = []
  for await (const chunk of $.turn.step({ ...STEP, turnId: 'mine' } as never))
    if ((chunk as { kind?: string }).kind === 'text') said.push((chunk as { text: string }).text)
  expect(own).toBe(1)
  expect(said).toEqual(['Ran them here.'])
  gone!()
  await leaving
  await asked.clock.advance(100)
  expect(asked.posted.filter(e => e.type === 'prompt')).toEqual([])
  expect(asked.filter(a => a === 'POST /api/rooms/room0000000000000001/leave')).toHaveLength(1)
})

// An earlier exchange whose calls a join draws as cards (the replay tool
// registered), the run they make one count line, kept in the state: a step
// riding it fails when that write is refused.
const PAST_FROM = { seat: 'host', name: 'Sam', role: 'host' }

const PAST = [
  { seq: 1, type: 'row', ts: 900, from: PAST_FROM, body: { kind: 'user', who: 'Sam', text: 'Look at the config' } },
  {
    seq: 2,
    type: 'row',
    ts: 901,
    from: PAST_FROM,
    body: { kind: 'tool', id: 'toolu_h1', tool: 'Read', text: 'config.json', input: { file_path: '/tmp/demo/config.json' } },
  },
  { seq: 3, type: 'row', ts: 902, from: PAST_FROM, body: { kind: 'result', id: 'toolu_h1', text: '{"port": 3340}' } },
  { seq: 4, type: 'row', ts: 903, from: PAST_FROM, body: { kind: 'tool', id: 'toolu_h2', tool: 'Grep', text: 'port', input: { pattern: 'port' } } },
  { seq: 5, type: 'row', ts: 904, from: PAST_FROM, body: { kind: 'result', id: 'toolu_h2', text: 'config.json:1' } },
  { seq: 6, type: 'row', ts: 905, from: PAST_FROM, body: { kind: 'assistant', text: 'It listens on 3340.' } },
]

for (const when of ['as a guest', 'while Leave is still closing the room'] as const) {
  test(`a riding step that fails ${when} ends the turn here: this person's own Claude never answers the host's prompt`, async ($, on) => {
    const refuse = { on: false },
      hold = { on: false }
    let release: (() => void) | undefined
    const asked = world(on, {
      joinHistory: PAST,
      beforeSet: (key, value) => {
        if (refuse.on && key === 'replayRun') return { value: 10n as unknown }
        // Leave held as it lets go of the room, the mode idle already.
        if (hold.on && key === 'room' && value === null) {
          hold.on = false
          return new Promise<void>(done => {
            release = done
          })
        }
      },
    })
    on('tool.register', ($, e) => ({ value: { tool: `mcp__shared-session__${e.name}` } }) as never)
    on('tool.list', () => ({ value: [] }) as never)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))
    let own = 0
    on('turn.step', async function* ($, e) {
      own += 1
      yield { kind: 'text', index: 0, text: 'Answered here.' } as never
      yield { kind: 'stop', stopReason: 'end_turn', usage: null } as never
      return { turnId: e.turnId, index: e.index, answer: 'Answered here.', toolUses: [], stopReason: 'end_turn', usage: null } as never
    })
    await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
    await asked.clock.advance(10)
    await $.turn.start({ turnId: 'join', text: LINK })
    await $.turn.complete({ turnId: 'join', isAborted: false, durationMs: 0, reason: 'answer' } as never)
    await eventually(asked.clock, () => asked.submitted.some(p => p.text === 'Sam: Look at the config'))
    await $.turn.start({ turnId: 'past', text: 'Sam: Look at the config' })
    let leaving: Promise<unknown> | undefined
    if (when === 'while Leave is still closing the room') {
      hold.on = true
      leaving = $.command.run({ command: 'stop-sharing', args: '' } as never)
      await eventually(asked.clock, () => Boolean(release))
      expect(asked.state.mode).toBe('idle')
      expect(asked.state.room?.id).toBe('room0000000000000001')
    }
    refuse.on = true
    const said: string[] = []
    for await (const chunk of $.turn.step({ ...STEP, turnId: 'past' } as never))
      if ((chunk as { kind?: string }).kind === 'text') said.push((chunk as { text: string }).text)
    refuse.on = false
    expect(own).toBe(0)
    expect(said.join('')).toBe("\n\n_Lost the thread of Sam's reply here; it plays again below._")
    expect(asked.logged.some(l => l.startsWith('Shared session: a riding step failed (throw'))).toBe(true)
    release?.()
    await leaving
    await asked.clock.advance(50)
    if (leaving) expect(asked.state.room).toBeNull()
  })
}

test('a turn started while Stop sharing is still closing the room goes nowhere: the room never hears it', async ($, on) => {
  let exited: (() => void) | undefined
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = world(on, {
    stream,
    tcpRelays: true,
    tcpWorkerExit: new Promise<void>(done => {
      exited = done
    }),
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  stream.push({ tcp: { id: 'connection0001', pid: 'pv1', port: 3340 } })
  await asked.clock.advance(5000)
  expect(asked.tcpHelpers).toHaveLength(1)
  // Stop sharing waits for its TCP worker to exit: the room not told yet, the host's token still good.
  const stopping = $.command.run({ command: 'stop-sharing', args: '' } as never)
  await eventually(asked.clock, () => asked.tcpHelpers[0]!.stopped)
  expect(asked.some(a => a === 'POST /api/rooms/room0000000000000002/end')).toBe(false)
  await $.turn.start({ turnId: 'after-stop', text: 'here is the prod password: hunter2' })
  await asked.clock.advance(200)
  expect(asked.posted.filter(e => e.type === 'turn')).toEqual([])
  exited!()
  await stopping
  await asked.clock.advance(100)
  expect(asked.posted.filter(e => e.type === 'turn')).toEqual([])
  expect(asked.filter(a => a === 'POST /api/rooms/room0000000000000002/end')).toHaveLength(1)
  expect(asked.logged).toContain('Stopped sharing. The link no longer works.')
})

test('a step running as the host stops sharing goes on here, and none of what it writes after goes out live', async ($, on) => {
  let exited: (() => void) | undefined
  let stopped: (() => void) | undefined
  const stream: unknown[] = [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = world(on, {
    stream,
    tcpRelays: true,
    tcpWorkerExit: new Promise<void>(done => {
      exited = done
    }),
  })
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'Looking at the config. ' } as never
    await new Promise<void>(done => {
      stopped = done
    })
    yield { kind: 'text', index: 0, text: 'The prod password is hunter2.' } as never
    yield { kind: 'stop', stopReason: 'end_turn', usage: null } as never
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'Looking at the config. The prod password is hunter2.',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    } as never
  })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await $.command.run({ command: 'share-preview', args: '3340 App' } as never)
  stream.push({ tcp: { id: 'connection0001', pid: 'pv1', port: 3340 } })
  await asked.clock.advance(5000)
  expect(asked.tcpHelpers).toHaveLength(1)
  const said: string[] = []
  const stepping = (async () => {
    for await (const chunk of $.turn.step(STEP)) if ((chunk as { kind?: string }).kind === 'text') said.push((chunk as { text: string }).text)
  })()
  await eventually(asked.clock, () => Boolean(stopped))
  await asked.clock.advance(300)
  const live = () =>
    asked.posted
      .filter(e => e.type === 'delta')
      .map(e => String(e.body.text ?? ''))
      .join('')
  expect(live()).toBe('Looking at the config. ')
  // Stop sharing, held on its TCP worker: the room not told yet, the host's token still good.
  const stopping = $.command.run({ command: 'stop-sharing', args: '' } as never)
  await eventually(asked.clock, () => asked.tcpHelpers[0]!.stopped)
  expect(asked.some(a => a === 'POST /api/rooms/room0000000000000002/end')).toBe(false)
  stopped!()
  await stepping
  await asked.clock.advance(300)
  // This person's own Claude goes on; nothing of it reaches the room.
  expect(said).toEqual(['Looking at the config. ', 'The prod password is hunter2.'])
  expect(live()).toBe('Looking at the config. ')
  exited!()
  await stopping
  await asked.clock.advance(300)
  expect(live()).toBe('Looking at the config. ')
  expect(JSON.stringify(asked.posted)).not.toContain('hunter2')
  expect(asked.filter(a => a === 'POST /api/rooms/room0000000000000002/end')).toHaveLength(1)
})

test('a start while Leave is still closing the room waits for it: nothing of the room comes back, and it is left once', async ($, on) => {
  let gone: (() => void) | undefined
  const asked = windowWorld(on, {
    beforeKill: wait =>
      wait
        ? new Promise<void>(done => {
            gone = done
          })
        : Promise.resolve(),
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await openedInWindow($, asked)
  const streams = () => asked.spawned.filter(s => s.argv[0] === 'curl' && s.argv.includes('-K')).length
  const leaving = $.command.run({ command: 'stop-sharing', args: '' } as never)
  expect(await eventually(asked.clock, () => Boolean(gone))).toBe(true)
  const before = { streams: streams(), helpers: asked.localHelpers.length, proxies: asked.proxies.length }
  // Started again meanwhile (the same module: an enable, a reload of it).
  const started = $.session.start(START)
  await asked.clock.advance(100)
  expect({ streams: streams(), helpers: asked.localHelpers.length, proxies: asked.proxies.length }).toEqual(before)
  gone!()
  await leaving
  await started
  await asked.clock.advance(1_000)
  expect({ streams: streams(), helpers: asked.localHelpers.length, proxies: asked.proxies.length }).toEqual(before)
  expect(asked.filter(a => a === 'POST /api/rooms/room0000000000000001/leave')).toHaveLength(1)
  expect(asked.state.mode).toBe('idle')
  expect(asked.state.room).toBeNull()
  expect(asked.state.closing).toBeNull()
})

test('a start that finds a Stop sharing cut short finishes it: the room hears it ended, and nothing of it comes back', async ($, on) => {
  const cut = { on: false }
  const asked = world(on, { stream: [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }], beforeSet: refusing(cut, 'mode', 'idle') })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(50)
  cut.on = true
  await ui.press({ key: 'stop-sharing' })
  await ui.press({ key: 'stop-sharing' })
  await asked.clock.advance(50)
  cut.on = false
  // Cut right after its marker: the state still a host's, the room not told.
  expect(asked.state.mode).toBe('host')
  expect(asked.state.room?.id).toBe('room0000000000000002')
  expect(asked.state.closing).toEqual({ how: 'stop', room: 'http://localhost:8787/room0000000000000002' })
  expect(asked.some(a => a.endsWith('/end'))).toBe(false)
  const streams = () => asked.spawned.filter(s => s.argv[0] === 'curl' && s.argv.includes('-K')).length
  const before = streams()
  // Loaded again, $.state as it was.
  await $.session.start(START)
  await asked.clock.advance(1_000)
  expect(asked.filter(a => a === 'POST /api/rooms/room0000000000000002/end')).toHaveLength(1)
  expect(streams()).toBe(before)
  expect(asked.state.mode).toBe('idle')
  expect(asked.state.room).toBeNull()
  expect(asked.state.closing).toBeNull()
  expect(asked.logged.some(l => l.startsWith('Still sharing'))).toBe(false)
  expect(await ui.find({ key: 'share' })).toBeDefined()
})

test('a start that finds a Leave cut short finishes it: the room hears it, the window closes, and nothing of it comes back', async ($, on) => {
  const cut = { on: false }
  const asked = windowWorld(on, { beforeSet: refusing(cut, 'mode', 'idle') })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await openedInWindow($, asked)
  const profile = await roomProfile()
  cut.on = true
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  await asked.clock.advance(50)
  cut.on = false
  expect(asked.state.mode).toBe('guest')
  expect(asked.state.closing).toEqual({ how: 'leave', room: 'https://share.test/room0000000000000001' })
  expect(asked.windowState.alive).toBe(true)
  expect(asked.some(a => a.endsWith('/leave'))).toBe(false)
  const before = { helpers: asked.localHelpers.length, proxies: asked.proxies.length }
  await $.session.start(START)
  await asked.clock.advance(1_000)
  expect({ helpers: asked.localHelpers.length, proxies: asked.proxies.length }).toEqual(before)
  expect(asked.filter(a => a === 'POST /api/rooms/room0000000000000001/leave')).toHaveLength(1)
  expect(asked.windowState.alive).toBe(false)
  expect(removedProfiles(asked).some(s => s.input?.includes(`p='${profile}'`))).toBe(true)
  expect(asked.state.mode).toBe('idle')
  expect(asked.state.room).toBeNull()
  expect(asked.state.previewWindow).toBeNull()
  expect(asked.state.closing).toBeNull()
})

test('/share-session after a Stop sharing cut short finishes that first, then asks about the earlier prompts as any session with them does', async ($, on) => {
  const cut = { on: false }
  const asked = world(on, { history: HISTORY, beforeSet: refusing(cut, 'mode', 'idle') })
  await $.command.run({ command: 'share-session', args: 'new' } as never)
  await asked.clock.advance(50)
  const id = asked.state.room!.id
  cut.on = true
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  await asked.clock.advance(50)
  cut.on = false
  expect(asked.state.mode).toBe('host')
  expect(asked.state.closing).toEqual({ how: 'stop', room: `http://localhost:8787/${id}` })
  const rooms = asked.filter(a => a === 'POST /api/rooms').length
  const reply = (await $.command.run({ command: 'share-session', args: '' } as never)) as { text: string }
  expect(asked.filter(a => a === `POST /api/rooms/${id}/end`)).toHaveLength(1)
  expect(reply.text).toStartWith('This session has 2 earlier prompts.')
  expect(asked.filter(a => a === 'POST /api/rooms')).toHaveLength(rooms)
  await asked.clock.advance(100)
  expect(asked.posted.filter(e => e.type === 'row')).toHaveLength(0)
  expect(asked.state.closing).toBeNull()
})

test('loaded again after a reload cut Stop sharing short, the close is finished: the room hears it ended, and nothing of it comes back', async ($, on) => {
  // Cut once the mode was idle, before the room was told.
  const asked = world(on, {
    beforeSet: reloaded(on, { room: CUT_HOST, mode: 'idle', closing: { how: 'stop', room: 'http://localhost:8787/room0000000000000002' } }),
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await asked.clock.advance(1_000)
  expect(asked.filter(a => a === 'POST /api/rooms/room0000000000000002/end')).toHaveLength(1)
  expect(asked.spawned.filter(s => s.argv[0] === 'curl' && s.argv.includes('-K'))).toHaveLength(0)
  expect(asked.state.room).toBeNull()
  expect(asked.state.mode).toBe('idle')
  expect(asked.state.closing).toBeNull()
  const ui = await $.ui.mount(band('desktop'))
  expect(await ui.find({ key: 'share' })).toBeDefined()
})

test('loaded again after a reload cut Leave short, the close is finished: the room hears it, and neither its stream nor a listener comes back', async ($, on) => {
  // Cut before the mode went idle: the state still a guest's, its listener saved.
  const stored = {
    room: CUT_GUEST,
    mode: 'guest',
    closing: { how: 'leave', room: 'https://share.test/room0000000000000001' },
    localPreviews: [{ pid: 'pv-local', port: 3340, localPort: 3340 }],
  }
  const asked = world(on, { beforeSet: reloaded(on, stored) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await asked.clock.advance(1_000)
  expect(asked.filter(a => a === 'POST /api/rooms/room0000000000000001/leave')).toHaveLength(1)
  expect(asked.spawned.filter(s => s.argv[0] === 'curl' && s.argv.includes('-K'))).toHaveLength(0)
  expect(asked.localHelpers).toHaveLength(0)
  expect(asked.state.mode).toBe('idle')
  expect(asked.state.room).toBeNull()
  expect(asked.state.localPreviews).toEqual([])
  expect(asked.state.closing).toBeNull()
})

test('loaded again with a marker naming another room than the one set, nothing is closed: that room is taken up as after any reload', async ($, on) => {
  const stored = { room: CUT_GUEST, mode: 'guest', closing: { how: 'leave', room: 'https://share.test/room0000000000000009' } }
  const asked = world(on, { beforeSet: reloaded(on, stored) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await asked.clock.advance(1_000)
  expect(asked.some(a => a.endsWith('/leave'))).toBe(false)
  expect(asked.spawned.filter(s => s.argv[0] === 'curl' && s.argv.includes('-K')).length).toBeGreaterThan(0)
  expect(asked.state.room).not.toBeNull()
  expect(asked.state.closing).toBeNull()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a /clear cut short after the room was told leaves the next conversation this person's own: its turns run here, and it takes no seat", async ($, on) => {
  const cut = { on: false }
  const asked = world(on, { stream: [{ seq: 1, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }], beforeSet: refusing(cut, 'people', []) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  let own = 0
  on('turn.step', async function* ($, e) {
    own += 1
    yield { kind: 'text', index: 0, text: 'four' } as never
    yield { kind: 'stop', stopReason: 'end_turn', usage: null } as never
    return { turnId: e.turnId, index: e.index, answer: 'four', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.session.start(START)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(20)
  cut.on = true
  await $.session.end({ reason: 'clear', sessionId: 'session-test-0001', resume: {} } as never)
  cut.on = false
  // Told, and its token gone with it; cut before the rest of its state cleared.
  expect(asked.filter(a => a === 'POST /api/rooms/room0000000000000001/leave')).toHaveLength(1)
  expect(asked.state.mode).toBe('idle')
  expect(asked.state.room).toBeNull()
  expect(asked.state.people?.length).toBeGreaterThan(0)
  // The next conversation, in the same process (no start for it).
  await $.turn.start({ turnId: 'fresh', text: 'what is 2+2' })
  const said: string[] = []
  for await (const chunk of $.turn.step({ ...STEP, turnId: 'fresh' } as never))
    if ((chunk as { kind?: string }).kind === 'text') said.push((chunk as { text: string }).text)
  expect(own).toBe(1)
  expect(said).toEqual(['four'])
  await $.prompt.submit({ text: 'summarize the README', origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(500)
  expect(asked.filter(a => a.endsWith('/join'))).toHaveLength(1)
  expect(asked.posted.filter(e => e.type === 'prompt')).toEqual([])
})

test('a seat the room let go while this session is leaving is not taken again: what waited to go is dropped', async ($, on) => {
  const cut = { on: false }
  const refused = { count: 0 }
  const asked = world(on, { eventsRefused: refused, beforeSet: refusing(cut, 'mode', 'idle') })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(20)
  cut.on = true
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  cut.on = false
  // Cut as it began: its scope closed, the state still a guest's.
  expect(asked.state.mode).toBe('guest')
  // A prompt then, whose post the room refuses: it let the seat go.
  refused.count = 1
  await $.prompt.submit({ text: 'one more thing', origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(500)
  expect(refused.count).toBe(0)
  expect(asked.filter(a => a.endsWith('/join'))).toHaveLength(1)
  expect(asked.posted.filter(e => e.type === 'prompt')).toEqual([])
})

test("a host's session closing with its place kept, cut short as it clears, leaves the conversation after it sharing nothing", async ($, on) => {
  const cut = { on: false }
  const asked = world(on, { stream: [{ seq: 1, events: [], people: HOST_ONLY, ended: false, title: 'demo' }], beforeSet: refusing(cut, 'people', []) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  await $.session.start(START)
  await $.command.run({ command: 'share-session', args: 'new' } as never)
  await asked.clock.advance(50)
  cut.on = true
  // /resume: another conversation takes this one's place in the process.
  await $.session.end({ reason: 'resume', sessionId: 'session-test-0001', resume: {} } as never)
  cut.on = false
  // Its place saved, the room kept (never told); cut before its state cleared.
  expect(asked.files.get(checkpointPath('hosting:session-test-0001'))).toBeDefined()
  expect(asked.some(a => a.endsWith('/end'))).toBe(false)
  expect(asked.state.mode).toBe('idle')
  await $.turn.start({ turnId: 'other-conversation', text: 'my unrelated private work' })
  await asked.clock.advance(200)
  expect(asked.posted.filter(e => e.type === 'turn')).toEqual([])
})

test("a guest's session closing with its place kept, cut short as it clears, leaves the conversation after it this person's own", async ($, on) => {
  const cut = { on: false }
  const asked = world(on, { beforeSet: refusing(cut, 'people', []) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  let own = 0
  on('turn.step', async function* ($, e) {
    own += 1
    yield { kind: 'text', index: 0, text: 'four' } as never
    yield { kind: 'stop', stopReason: 'end_turn', usage: null } as never
    return { turnId: e.turnId, index: e.index, answer: 'four', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.session.start(START)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(20)
  cut.on = true
  // /resume: another conversation takes this one's place in the process.
  await $.session.end({ reason: 'resume', sessionId: 'session-test-0001', resume: {} } as never)
  cut.on = false
  // Its place saved, the room kept (never told); cut before its state cleared.
  expect(asked.files.get(checkpointPath('joined:session-test-0001'))).toBeDefined()
  expect(asked.some(a => a.endsWith('/leave'))).toBe(false)
  expect(asked.state.mode).toBe('idle')
  await $.prompt.submit({ text: 'what is 2+2', origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(200)
  expect(asked.posted.filter(e => e.type === 'prompt')).toEqual([])
  await $.turn.start({ turnId: 'other-conversation', text: 'what is 2+2' })
  const said: string[] = []
  for await (const chunk of $.turn.step({ ...STEP, turnId: 'other-conversation' } as never))
    if ((chunk as { kind?: string }).kind === 'text') said.push((chunk as { text: string }).text)
  expect(own).toBe(1)
  expect(said).toEqual(['four'])
})

const LUNCH = { seq: 2, type: 'chat', ts: 950, from: { seat: 'seat2', name: 'Alex', role: 'guest' }, body: { text: 'lunch?' } }

test('a Leave cut short is finished by the next Join: nothing of the room left carries into the next', async ($, on) => {
  const cut = { on: false }
  const history: (typeof LUNCH)[] = [LUNCH]
  const asked = world(on, { joinHistory: history, beforeSet: refusing(cut, 'people', []) })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(20)
  expect(asked.state.chat?.map(c => c.text)).toEqual(['lunch?'])
  cut.on = true
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  cut.on = false
  // Told, then cut as its state cleared: the room's chat still here, its marker up.
  expect(asked.filter(a => a.endsWith('/leave'))).toHaveLength(1)
  expect(asked.state.chat?.map(c => c.text)).toEqual(['lunch?'])
  expect(asked.state.closing).toEqual({ how: 'leave', room: 'https://share.test/room0000000000000001' })
  // No close runs here now: the row offers Share, and the next Join finishes that one first.
  const ui = await $.ui.mount(band('desktop'))
  expect(await ui.find({ key: 'share' })).toBeDefined()
  history.length = 0
  await $.prompt.submit({ text: 'https://share.test/s/room0000000000000002', origin: { kind: 'composer' }, wait: false })
  await eventually(asked.clock, () => asked.state.room?.id === 'room0000000000000002')
  expect(asked.state.room?.id).toBe('room0000000000000002')
  expect(asked.state.chat).toEqual([])
  expect(asked.state.closing).toBeNull()
  expect(asked.filter(a => a.endsWith('/leave'))).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a reload brings the proxy back on the window's own port, never opening a browser", async ($, on) => {
  const asked = windowWorld(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await openedInWindow($, asked)
  // A reload ends the old module's children; the window stays open.
  asked.proxies[0]!.exit()
  for (const helper of asked.localHelpers) helper.exit()
  await asked.clock.advance(10)
  await $.session.start(START)
  await eventually(asked.clock, () => asked.proxies.length === 2)
  await asked.clock.advance(20)
  expect(asked.proxies[1]!.config.port).toBe(47100)
  expect(asked.launches).toHaveLength(1)
  expect(asked.windowState.alive).toBe(true)
  expect(asked.copied).toHaveLength(0)
  // The page's next request starts its tunnel again.
  asked.proxies[1]!.send({ state: 'want', port: 3340 })
  await eventually(asked.clock, () => asked.proxies[1]!.routes.at(-1)?.routes['3340'] === 45001)
  expect(asked.launches).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a reload that finds the window's proxy port taken closes the window and says so", async ($, on) => {
  const asked = windowWorld(on, { proxyBusy: [47100] })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await openedInWindow($, asked)
  asked.proxies[0]!.exit()
  await asked.clock.advance(10)
  await $.session.start(START)
  await eventually(asked.clock, () => !asked.windowState.alive)
  await asked.clock.advance(20)
  expect(asked.windowState.kills).toBe(1)
  expect(asked.launches).toHaveLength(1)
  expect(asked.toasted.some(t => t.includes("its proxy's port (47100) was taken"))).toBe(true)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a reload whose look at the window fails takes it to be there still: its proxy comes back on its port, and Leave closes it', async ($, on) => {
  const lockFails = { count: 0 }
  const asked = windowWorld(on, { lockFails, stream: [{ seq: 2, events: [WINDOW_SHOWN], people: SIGNED_IN, ended: false, title: 'demo' }] })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await openedInWindow($, asked)
  const host = await hostProfilePath()
  // A reload ends the old module's children; the window stays open.
  asked.proxies[0]!.exit()
  for (const helper of asked.localHelpers) helper.exit()
  await asked.clock.advance(10)
  lockFails.count = 1
  await $.session.start(START)
  await eventually(asked.clock, () => asked.proxies.length === 2)
  await asked.clock.advance(20)
  expect(lockFails.count).toBe(0)
  expect(asked.proxies[1]!.config.port).toBe(47100)
  expect(asked.windowState).toMatchObject({ alive: true, kills: 0 })
  expect(asked.state.previewWindow).toMatchObject({ port: 47100, profile: host.split('/').pop() })
  expect(asked.toasted.filter(t => t.startsWith('The preview window closed'))).toEqual([])
  // The looks from here on find it on its port.
  await asked.clock.advance(31_000)
  expect(asked.proxies[1]!.stopped).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  await asked.clock.advance(50)
  expect(asked.windowState.alive).toBe(false)
  expect(
    asked.spawned
      .filter(s => s.input?.startsWith('# shared-session: close the preview window') && s.input.includes(host))
      .every(s => s.input?.includes('w=47100')),
  ).toBe(true)
})

const WINDOW_BUSY_SAID = 'The preview window reached its connection or request limit. Close unused tabs in it or wait a minute, then reload the page.'

test("seated anew by the room, the window goes on: its failures are still said, and a refused tunnel starts again with the new seat's token", async ($, on) => {
  const refusals = { count: 0 }
  const asked = windowWorld(on, { streamRefusals: refusals })
  await openedInWindow($, asked)
  // The room let the seat go (asleep past its grace, then dropped): the stream is refused, and a new seat taken.
  refusals.count = 1
  await within(asked.clock, () => asked.state.room?.token === 'g2', 5_000)
  expect(asked.state.room?.token).toBe('g2')
  // A page's sockets on the tunnel started before: said a moment on, as before the reseat.
  const first = asked.localHelpers[0]!
  first.send({ state: 'channel-error', code: 'BUSY' })
  await within(asked.clock, () => asked.toasted.includes(WINDOW_BUSY_SAID), 2_000)
  expect(asked.toasted.filter(t => t === WINDOW_BUSY_SAID)).toHaveLength(1)
  // It carries the old seat's token: refused, the page's next ask starts it with the new one.
  first.send({ state: 'channel-error', code: 'AUTH' })
  await eventually(asked.clock, () => first.stopped)
  asked.proxies[0]!.send({ state: 'want', port: 3340 })
  await eventually(asked.clock, () => routesOf(asked)?.routes['3340'] === 45001 && asked.localHelpers.length === 2)
  expect(tunnels(asked).at(-1)?.token).toBe('g2')
  // Refused again: said, and only an Open reconnects it.
  asked.localHelpers[1]!.send({ state: 'channel-error', code: 'AUTH' })
  await within(asked.clock, () => asked.toasted.some(t => t.includes("refused the preview window's connection")), 2_000)
  expect(asked.state.previewNeedsOpen).toEqual(['pv-local'])
  // The window and its proxy went on through all of it.
  expect(asked.windowState.alive).toBe(true)
  expect(asked.windowState.kills).toBe(0)
  expect(asked.proxies[0]!.stopped).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("seated anew while the window's tunnel starts again, the page's next ask starts it at once, with the new seat", async ($, on) => {
  let starts = 0
  let hold: (() => void) | undefined
  const refusals = { count: 0 }
  const asked = windowWorld(on, {
    streamRefusals: refusals,
    beforeHelper: pid =>
      pid === 'pv-local' && ++starts === 2
        ? new Promise<void>(done => {
            hold = done
          })
        : undefined,
  })
  await openedInWindow($, asked)
  // Its tunnel failed: the page asks again, and that start is held, with the old seat's token.
  asked.localHelpers[0]!.send({ state: 'error', code: 'STARTUP' })
  await eventually(asked.clock, () => routesOf(asked)?.startable.includes(3340))
  asked.proxies[0]!.send({ state: 'want', port: 3340 })
  await eventually(asked.clock, () => Boolean(hold))
  refusals.count = 1
  await within(asked.clock, () => asked.state.room?.token === 'g2', 5_000)
  expect(asked.state.room?.token).toBe('g2')
  hold!()
  await asked.clock.advance(50)
  // Not held back as a start that failed: offered again at once.
  expect(routesOf(asked)).toEqual({ routes: {}, startable: [3340] })
  asked.proxies[0]!.send({ state: 'want', port: 3340 })
  await eventually(asked.clock, () => routesOf(asked)?.routes['3340'] === 45001)
  expect(routesOf(asked)?.routes['3340']).toBe(45001)
  expect(tunnels(asked).at(-1)?.token).toBe('g2')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a reseat while Open starts the browser keeps the window it started, and says it opened', async ($, on) => {
  let launch: (() => void) | undefined
  const refusals = { count: 0 }
  const asked = windowWorld(on, {
    streamRefusals: refusals,
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
  refusals.count = 1
  await within(asked.clock, () => asked.state.room?.token === 'g2', 5_000)
  expect(asked.state.room?.token).toBe('g2')
  launch!()
  await asked.clock.advance(50)
  expect(asked.windowState.alive).toBe(true)
  expect(asked.windowState.kills).toBe(0)
  expect(asked.state.previewWindow?.opened).toEqual(['pv-local'])
  expect(asked.toasted).toContain(
    "Opened Sam's localhost:3340 in a separate Google Chrome window. In it, localhost reaches only what Sam shares; your own servers aren't touched.",
  )
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a reseat keeps the room's tunnels and the window's proxy: only a request with the old seat's token ends", async ($, on) => {
  const refusals = { count: 0 }
  const asked = windowWorld(on, { streamRefusals: refusals })
  await openedInWindow($, asked)
  const proxy = asked.proxies[0]!,
    tunnel = asked.localHelpers[0]!
  refusals.count = 1
  await within(asked.clock, () => asked.state.room?.token === 'g2', 5_000)
  await asked.clock.advance(100)
  expect(proxy.stopped).toBe(false)
  expect(tunnel.stopped).toBe(false)
  expect(asked.windowState.alive).toBe(true)
  expect(asked.state.previewWindow?.opened).toEqual(['pv-local'])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  expect(proxy.stopped).toBe(true)
  expect(tunnel.stopped).toBe(true)
})

test("a host's-profile window this session no longer has is never taken for its own: another session's there, on the same port number, stays open", async ($, on) => {
  const asked = windowWorld(on, { stream: [{ seq: 2, events: [WINDOW_SHOWN], people: SIGNED_IN, ended: false, title: 'demo' }], proxyBusy: [47100] })
  const pane = await openedInWindow($, asked)
  const host = await hostProfilePath()
  expect(asked.launches[0]).toContain(`--user-data-dir=${host}/chrome`)
  // The person closes it: the next look finds it gone, and its proxy ends.
  asked.windowState.alive = false
  await asked.clock.advance(30_100)
  expect(asked.proxies[0]!.stopped).toBe(true)
  expect(asked.state.previewWindow).toMatchObject({ port: 0, opened: [] })
  // Another session of theirs opens the host's profile, its proxy given the same number.
  Object.assign(asked.windowState, { alive: true, profile: host, port: 47100, family: 'chromium' })
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.launches.length === 2)
  await asked.clock.advance(10)
  expect(asked.windowState.kills).toBe(0)
  expect(asked.launches[1]).toContain(`--user-data-dir=${await roomProfile()}/chrome`)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a window whose proxy can't start again for another reason than its port (no Node) stays open, and that is said", async ($, on) => {
  const asked = windowWorld(on, { windowOpen: { profile: await roomProfile(), port: 49999 }, proxyMissing: true })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.toasted.some(t => t.startsWith('Preview windows need Node')))
  await asked.clock.advance(10)
  // Nothing else opens it (its listeners need Node too).
  expect(asked.toasted).toContain(
    'Preview windows need Node 22.18 or later on this computer. Install it, then press Open preview again, or choose Public link in Room → Shown.',
  )
  expect(asked.windowState.kills).toBe(0)
  expect(asked.windowState.alive).toBe(true)
  expect(asked.launches).toHaveLength(0)
  // Tried once, on the window's own port: not again on another, which would fail the same way.
  expect(asked.spawned.filter(s => s.argv.at(-1)?.endsWith('/relay/browser-proxy.mts')).map(s => JSON.parse(s.input!).port)).toEqual([49999])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a look for a browser that failed isn't kept: redrawing doesn't look again at once, and the Open looks again and opens the window", async ($, on) => {
  const asked = windowWorld(on, { detectFails: { count: 1 } })
  const looks = () => asked.spawned.filter(s => s.input?.startsWith('# shared-session: find a browser')).length
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  // Open preview above the prompt looks for a browser ahead of the press: that look fails.
  const ui = await $.ui.mount(band('desktop'))
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-settings' })
  await asked.clock.advance(10)
  expect(looks()).toBe(1)
  expect(await pane.find({ type: 'Text', text: /separate window can't open here/ })).toBeUndefined()
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  expect(looks()).toBe(2)
  expect(asked.launches[0]!.at(-1)).toBe(WINDOW_URL)
  expect(asked.externals).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a reload that finds another session's window on the host's profile leaves it open and says nothing", async ($, on) => {
  const host = await hostProfilePath()
  const saved = {
    at: 900,
    room: { server: 'https://share.test', id: 'room0000000000000001', url: LINK, title: 'demo', host: 'Sam', token: 'g', seat: 'seat1', seq: 2, since: 1 },
    autoOpen: true,
    policy: { prompts: 'everyone', approvals: 'edits', files: 'on' },
    shown: [],
    localPreviews: [],
    activity: [],
    chat: [],
    sidebar: null,
    previewWindow: { port: 47100, profile: host.split('/').pop() },
  }
  const asked = windowWorld(on, {
    windowOpen: { profile: host, port: 47999 },
    files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: saved }) },
    stream: [{ seq: 2, events: [], people: SIGNED_IN, ended: false, title: 'demo' }],
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await eventually(asked.clock, () => asked.state.mode === 'guest')
  await asked.clock.advance(50)
  expect(asked.windowState.alive).toBe(true)
  expect(asked.windowState.kills).toBe(0)
  expect(asked.toasted.filter(t => t.startsWith('The preview window closed'))).toEqual([])
  expect(asked.proxies).toHaveLength(0)
  expect(asked.state.previewWindow).toMatchObject({ port: 0, opened: [] })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a reload that finds the window closed forgets its port: a window on the host's profile with that number later is another session's, left open", async ($, on) => {
  const host = await hostProfilePath()
  const saved = {
    at: 900,
    room: { server: 'https://share.test', id: 'room0000000000000001', url: LINK, title: 'demo', host: 'Sam', token: 'g', seat: 'seat1', seq: 1, since: 1 },
    autoOpen: true,
    policy: { prompts: 'everyone', approvals: 'edits', files: 'on' },
    shown: [],
    localPreviews: [],
    activity: [],
    chat: [],
    sidebar: null,
    previewWindow: { port: 47100, profile: host.split('/').pop() },
  }
  const asked = windowWorld(on, {
    proxyBusy: [47100],
    files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: saved }) },
    stream: [{ seq: 2, events: [WINDOW_SHOWN], people: SIGNED_IN, ended: false, title: 'demo' }],
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await eventually(asked.clock, () => asked.state.mode === 'guest' && asked.state.previewWindow?.port === 0)
  expect(asked.state.previewWindow).toMatchObject({ port: 0, opened: [] })
  // Another session of theirs opens the host's profile, its proxy given the same number.
  Object.assign(asked.windowState, { alive: true, profile: host, port: 47100, family: 'chromium' })
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(10)
  expect(asked.windowState.kills).toBe(0)
  expect(asked.launches[0]).toContain(`--user-data-dir=${await roomProfile()}/chrome`)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// One source of what the host forwards: Shown, as the room says (its preview
// events, and the list of what's shared it gives), shown as the artifacts say.

test("a later showing of a forwarded preview moves its page, and says again what it's forwarded as: its address, its scheme and the page it's for", async ($, on) => {
  const APP = {
    seq: 2,
    type: 'artifact',
    ts: 900,
    from: HOST_FROM,
    body: { kind: 'preview', pid: 'pv-app', port: 61198, path: '/', title: 'Host app', tcp: true, host: '127.0.0.1', scheme: 'https' },
  }
  const API = {
    seq: 3,
    type: 'artifact',
    ts: 901,
    from: HOST_FROM,
    body: { kind: 'preview', pid: 'pv-api', port: 61199, path: '/', title: 'localhost:61199 (host-api.cjs)', tcp: true, host: 'localhost', dependency: 61198 },
  }
  // What the host sends as its Claude opens each address again (`sharedAs`): its share's forwarding with the new page.
  const APP_AGAIN = {
    seq: 4,
    type: 'artifact',
    ts: 902,
    from: HOST_FROM,
    body: { kind: 'preview', pid: 'pv-app', port: 61198, path: '/account', title: 'Account', tcp: true, host: '127.0.0.1', scheme: 'https' },
  }
  const API_AGAIN = {
    seq: 5,
    type: 'artifact',
    ts: 903,
    from: HOST_FROM,
    body: { kind: 'preview', pid: 'pv-api', port: 61199, path: '/health', title: 'localhost:61199', tcp: true, host: 'localhost', dependency: 61198 },
  }
  const asked = windowWorld(on, {
    localPreviewByPid: { 'pv-app': { port: 45020 }, 'pv-api': { port: 45021 } },
    stream: [{ seq: 5, events: [APP, API, APP_AGAIN, API_AGAIN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  await eventually(asked.clock, () => asked.state.shown?.find(s => s.pid === 'pv-api')?.path === '/health')
  const app = asked.state.shown!.find(s => s.pid === 'pv-app')!,
    api = asked.state.shown!.find(s => s.pid === 'pv-api')!
  expect(app).toMatchObject({ name: 'Account (preview)', path: '/account', ts: 902, tcp: true, host: '127.0.0.1', scheme: 'https' })
  expect(app.dependency).toBeUndefined()
  expect(api).toMatchObject({ name: 'localhost:61199 · used by localhost:61198', path: '/health', tcp: true, host: 'localhost', dependency: 61198 })
  expect(api.scheme).toBeUndefined()
  // The window opens the page at the origin it was forwarded at, on its newest page.
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  expect(asked.launches[0]!.at(-1)).toBe('https://127.0.0.1:61198/account')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("forwarding reaches a guest as the room's list says it, before any artifact of the host's does", async ($, on) => {
  // Shown through its link first.
  const LINKED = {
    ...WINDOW_SHOWN,
    body: { kind: 'preview', pid: 'pv-local', port: 3340, path: '/login?next=%2Faccount', title: 'Sign in', host: '127.0.0.1' },
  }
  const stream: unknown[] = [{ seq: 2, events: [LINKED], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = windowWorld(on, { stream })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  expect(await ui.find({ key: 'open-preview' })).toBeUndefined()
  // The host's Allow forwarding: the room says so.
  stream.push({
    seq: 3,
    events: [{ seq: 3, type: 'preview', ts: 950, from: HOST_FROM, body: { state: 'open', pid: 'pv-local', port: 3340, tcp: true, title: 'Sign in' } }],
    people: PREVIEW_PEOPLE,
    ended: false,
    title: 'demo',
  })
  await within(asked.clock, () => forwardedPids(asked).includes('pv-local'), 5_000)
  // How it shows stays its artifact's: the page, the address's spelling.
  expect(asked.state.shown?.find(s => s.pid === 'pv-local')).toMatchObject({
    name: 'Sign in (preview)',
    path: '/login?next=%2Faccount',
    host: '127.0.0.1',
    tcp: true,
  })
  await asked.clock.advance(10)
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  expect(asked.launches[0]!.at(-1)).toBe(WINDOW_URL)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('joining, a guest lists what the room shares though its history lost the artifact, and a preview the room no longer lists is ended', async ($, on) => {
  // Its end went out of the room's history before this join (the room keeps the newest events).
  const GONE = { ...WINDOW_SHOWN, body: { ...WINDOW_SHOWN.body, pid: 'pv-gone', port: 3341, title: 'Old app' } }
  const asked = windowWorld(on, {
    joinHistory: [GONE],
    roomList: { previews: [{ pid: 'pv-late', port: 3342, tcp: true, title: 'Admin' }] },
    stream: [{ seq: 2, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  await eventually(asked.clock, () => asked.state.shown?.some(s => s.pid === 'pv-late'))
  expect(asked.state.shown?.find(s => s.pid === 'pv-gone')).toMatchObject({ closed: true, tcp: false })
  // Known by its title until an artifact says more, older than what Shown has.
  expect(asked.state.shown![0]).toEqual({
    key: 'preview:pv-late',
    kind: 'preview',
    name: 'Admin (preview)',
    ts: expect.any(Number),
    pid: 'pv-late',
    port: 3342,
    tcp: true,
  })
  expect(forwardedPids(asked)).toEqual(['pv-late'])
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  expect(asked.launches[0]!.at(-1)).toBe('http://localhost:3342/')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// A place with two forwarded previews and their listeners, saved as the
// session closed.
const placeShown = (pid: string, port: number, tcp: boolean) => ({
  key: `preview:${pid}`,
  kind: 'preview',
  name: 'App (preview)',
  ts: 900,
  pid,
  port,
  path: '/',
  ...(tcp ? { tcp: true } : {}),
})

const LOST_PLACE = {
  at: 900,
  room: { server: 'https://share.test', id: 'room0000000000000001', url: LINK, title: 'demo', host: 'Sam', token: 'g', seat: 'seat1', seq: 3, since: 1 },
  autoOpen: true,
  policy: { prompts: 'everyone', approvals: 'edits', files: 'on' },
  activity: [],
  chat: [],
  sidebar: null,
  shown: [placeShown('pv-local', 3340, true), placeShown('pv-ended', 3341, true)],
  localPreviews: [
    { pid: 'pv-local', port: 3340, localPort: 3340 },
    { pid: 'pv-ended', port: 3341, localPort: 3341 },
  ],
}

test('a reopened place takes what the room shares from its answer before its listeners come back: one ended meanwhile stays closed', async ($, on) => {
  const asked = localWorld(on, {
    roomList: { previews: [{ pid: 'pv-local', port: 3340, tcp: true, title: 'App' }] },
    files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: LOST_PLACE }) },
    stream: [{ seq: 3, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await eventually(asked.clock, () => asked.localHelpers.some(h => h.pid === 'pv-local'))
  await asked.clock.advance(20)
  expect(tunnels(asked).map(t => [t.port, t.strict])).toEqual([[3340, true]])
  expect(asked.state.shown?.find(s => s.pid === 'pv-local')?.tcp).toBe(true)
  expect(asked.state.shown?.find(s => s.pid === 'pv-ended')).toMatchObject({ closed: true, tcp: false })
  expect((asked.state.localPreviews ?? []).map(p => p.pid)).toEqual(['pv-local'])
  expect(asked.toasted.some(t => t.includes('forwarded again'))).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a reload whose room is slow to send its first page brings its listeners back anyway, a moment on', async ($, on) => {
  let release: (() => void) | undefined
  const hold: { until?: Promise<void> } = {}
  const roomList = {
    previews: [
      { pid: 'pv-local', port: 3340, tcp: true, title: 'Sign in' },
      { pid: 'pv-dep', port: 3610, tcp: true },
    ],
  }
  const asked = autoWorld(on, { roomList, streamHeld: () => hold.until ?? Promise.resolve() })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.externals.length)
  await asked.clock.advance(10)
  // A reload (the helpers go with the old module) while the room is slow to answer.
  hold.until = new Promise<void>(done => {
    release = done
  })
  for (const helper of asked.localHelpers) helper.exit()
  await asked.clock.advance(10)
  await $.session.start(START)
  const before = asked.localHelpers.length
  await asked.clock.advance(2_000)
  expect(asked.localHelpers.length).toBe(before)
  await within(asked.clock, () => asked.localHelpers.length > before, 2_000)
  await asked.clock.advance(20)
  expect(asked.localHelpers.filter(h => h.pid === 'pv-local' && !h.stopped)).toHaveLength(1)
  hold.until = undefined
  release!()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a reload's listeners come back once the room's next page says what it shares: one it ended meanwhile doesn't", async ($, on) => {
  const roomList = {
    previews: [
      { pid: 'pv-local', port: 3340, tcp: true, title: 'Sign in' },
      { pid: 'pv-dep', port: 3610, tcp: true },
    ],
  }
  const asked = autoWorld(on, { roomList })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.externals.length)
  await asked.clock.advance(10)
  // A reload while the host stopped what the page used, the room's events of it gone past.
  roomList.previews = [roomList.previews[0]!]
  for (const helper of asked.localHelpers) helper.exit()
  await asked.clock.advance(10)
  const before = asked.localHelpers.length
  await $.session.start(START)
  await within(asked.clock, () => asked.localHelpers.length > before, 1_000)
  await asked.clock.advance(50)
  expect(asked.localHelpers.slice(before).map(h => h.pid)).toEqual(['pv-local'])
  expect(asked.state.shown?.find(s => s.pid === 'pv-dep')).toMatchObject({ closed: true, tcp: false })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("seated anew, a guest takes what the room shares from the room's next page", async ($, on) => {
  const refusals = { count: 0 }
  const roomList = { previews: [{ pid: 'pv-local', port: 3340, tcp: true, title: 'Sign in' }] }
  const stream: unknown[] = [{ seq: 2, events: [WINDOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = windowWorld(on, { stream, roomList, streamRefusals: refusals })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  expect(forwardedPids(asked)).toEqual(['pv-local'])
  // The room let the seat go, and the host stopped the preview meanwhile: that end went past this seat.
  roomList.previews = []
  stream.splice(0, stream.length, { seq: 3, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' })
  refusals.count = 1
  await within(asked.clock, () => asked.state.shown?.find(s => s.pid === 'pv-local')?.closed === true, 5_000)
  expect(asked.state.shown?.find(s => s.pid === 'pv-local')).toMatchObject({ closed: true, tcp: false })
  expect(forwardedPids(asked)).toEqual([])
  // From the room's next page to the new seat, nothing else asked.
  expect(asked.state.room?.token).toBe('g2')
  expect(asked.urls.some(u => u.endsWith('/previews'))).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("seated anew, a guest never takes its join's list over a newer page: a preview the stream brought meanwhile stays open", async ($, on) => {
  const refused = { count: 0 }
  const roomList = { previews: [{ pid: 'pv-local', port: 3340, tcp: true, title: 'Sign in' }] }
  const stream: unknown[] = [{ seq: 2, events: [WINDOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  let joining = false,
    release = () => {}
  const held = new Promise<void>(done => (release = done))
  const asked = windowWorld(on, {
    stream,
    roomList,
    eventsRefused: refused,
    joinHold: async () => {
      joining = true
      await held
    },
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  expect(forwardedPids(asked)).toEqual(['pv-local'])
  // The room let the seat go: a prompt's post is refused, and the new seat's join answer is slow to come back.
  refused.count = 1
  await $.prompt.submit({ text: 'one more thing', origin: { kind: 'composer' }, wait: false })
  await within(asked.clock, () => joining, 5_000)
  // Meanwhile the stream says the host forwards another preview.
  roomList.previews = [...roomList.previews, { pid: 'pv-api', port: 3341, tcp: true, title: 'API' }]
  stream.splice(0, stream.length, {
    seq: 3,
    events: [{ seq: 3, type: 'preview', ts: 950, from: HOST_FROM, body: { pid: 'pv-api', port: 3341, state: 'open', tcp: true, title: 'API' } }],
    people: PREVIEW_PEOPLE,
    ended: false,
    title: 'demo',
  })
  await within(asked.clock, () => forwardedPids(asked).includes('pv-api'), 5_000)
  // The join's answer, made before that, comes back: it ends nothing the stream said since.
  release()
  await within(asked.clock, () => asked.state.room?.token === 'g2', 5_000)
  await asked.clock.advance(500)
  expect(forwardedPids(asked).sort()).toEqual(['pv-api', 'pv-local'])
  expect(asked.state.shown?.find(s => s.pid === 'pv-api')?.closed).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("back after a gap in its connection, a guest takes what the room shares from the room's next page", async ($, on) => {
  const roomList = { previews: [{ pid: 'pv-local', port: 3340, tcp: true, title: 'Sign in' }] }
  const stream: unknown[] = [{ seq: 2, events: [WINDOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = windowWorld(on, { stream, roomList })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  // Nothing comes for a while.
  stream.length = 0
  await within(asked.clock, () => asked.state.connection === 'reconnecting', 20_000)
  expect(asked.state.connection).toBe('reconnecting')
  expect(asked.urls.some(u => u.endsWith('/previews'))).toBe(false)
  // The host stopped it meanwhile, and that end went past this session.
  roomList.previews = []
  stream.push({ seq: 3, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' })
  await within(asked.clock, () => asked.state.shown?.find(s => s.pid === 'pv-local')?.closed === true, 60_000)
  expect(asked.state.shown?.find(s => s.pid === 'pv-local')).toMatchObject({ closed: true, tcp: false })
  // Ended as its own end would: the window asking for it again asks the host nothing.
  expect(asked.state.needAsked?.ports).toEqual([3340])
  expect(asked.state.connection).toBe('live')
  expect(asked.urls.some(u => u.endsWith('/previews'))).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a preview the room ended stays ended for a guest, though an artifact of the host's for it comes late", async ($, on) => {
  const CLOSED = { seq: 3, type: 'preview', ts: 950, from: HOST_FROM, body: { pid: 'pv-local', port: 3340, state: 'closed' } }
  const LATE = { ...WINDOW_SHOWN, seq: 4, ts: 960, body: { ...WINDOW_SHOWN.body, path: '/late' } }
  const asked = windowWorld(on, { stream: [{ seq: 4, events: [WINDOW_SHOWN, CLOSED, LATE], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }] })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  await eventually(asked.clock, () => asked.state.shown?.some(s => s.pid === 'pv-local'))
  await asked.clock.advance(50)
  expect(asked.state.shown?.find(s => s.pid === 'pv-local')).toMatchObject({ closed: true, tcp: false, path: '/login?next=%2Faccount' })
  expect(forwardedPids(asked)).toEqual([])
  const ui = await $.ui.mount(band('desktop'))
  expect(await ui.find({ key: 'open-preview' })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a need the room answers as forwarded already takes nothing up itself: the room's next page lists it, forwarded as the page it was shown as", async ($, on) => {
  const LINKED = { seq: 3, type: 'artifact', ts: 901, from: HOST_FROM, body: { kind: 'preview', pid: 'pv-earlier', port: 5555, path: '/docs', title: 'Docs' } }
  const stream: unknown[] = [{ seq: 3, events: [WINDOW_SHOWN, LINKED], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = windowWorld(on, { need: 'shared', localPreviewByPid: { 'pv-earlier': { port: 45030 } }, stream })
  await openedInWindow($, asked)
  asked.proxies[0]!.send({ state: 'blocked', port: 5555 })
  await eventually(asked.clock, () => asked.sent.some(s => s.path.endsWith('/need')))
  await asked.clock.advance(50)
  // Nothing taken up from the answer alone, and nothing said.
  expect(forwardedPids(asked)).toEqual(['pv-local'])
  expect(asked.toasted.some(t => t.startsWith('Your preview tried localhost:5555'))).toBe(false)
  // The host's Allow forwarding, as the room's page says it.
  stream.push({
    seq: 4,
    events: [{ seq: 4, type: 'preview', ts: 950, from: HOST_FROM, body: { state: 'open', pid: 'pv-earlier', port: 5555, tcp: true, title: 'Docs' } }],
    people: PREVIEW_PEOPLE,
    ended: false,
    title: 'demo',
  })
  await within(asked.clock, () => forwardedPids(asked).includes('pv-earlier'), 5_000)
  await asked.clock.advance(20)
  expect(asked.state.shown?.find(s => s.pid === 'pv-earlier')).toMatchObject({ name: 'Docs (preview)', path: '/docs', tcp: true })
  expect(asked.state.shown?.find(s => s.pid === 'pv-earlier')?.dependency).toBeUndefined()
  expect(routesOf(asked)?.startable).toContain(5555)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a closing place keeps every preview the host shares, however much was shown since', async ($, on) => {
  const links = Array.from({ length: 30 }, (_, i) => ({
    seq: 4 + i,
    type: 'artifact',
    ts: 901 + i,
    from: HOST_FROM,
    body: { kind: 'link', url: `https://example.test/${i}` },
  }))
  const asked = windowWorld(on, {
    joinHistory: [WINDOW_SHOWN, DEP_SHOWN, ...links],
    stream: [{ seq: 33, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start(START)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  await eventually(asked.clock, () => (asked.state.shown ?? []).length === 32)
  await $.session.end({ reason: 'other', sessionId: 'session-test-0001', resume: {} } as never)
  const kept = savedAt(asked, 'joined:session-test-0001') as { shown: { kind: string; pid?: string; tcp?: boolean; dependency?: unknown }[] }
  // Both previews, older than every link kept, and the newest 20 links.
  expect(kept.shown.filter(s => s.kind === 'link')).toHaveLength(20)
  expect(kept.shown.slice(0, 2)).toMatchObject([
    { pid: 'pv-local', tcp: true },
    { pid: 'pv-dep', tcp: true, dependency: 3340 },
  ])
})

test('Shown keeps the newest 128 open previews', async ($, on) => {
  const previews = Array.from({ length: 130 }, (_, i) => ({
    seq: 2 + i,
    type: 'artifact',
    ts: 900 + i,
    from: HOST_FROM,
    body: { kind: 'preview', pid: `pv-${i}`, port: 4000 + i, path: '/', title: `App ${i}`, tcp: true },
  }))
  const asked = world(on, { joinHistory: previews, stream: [{ seq: 131, events: [], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }] })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  await eventually(asked.clock, () => (asked.state.shown ?? []).length >= 128)
  await asked.clock.advance(10)
  expect(asked.state.shown).toHaveLength(128)
  expect(asked.state.shown!.map(s => s.pid).slice(0, 2)).toEqual(['pv-2', 'pv-3'])
  expect(asked.state.shown!.at(-1)?.pid).toBe('pv-129')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a guest sees no Previews setting, and no browser is looked for, until the room forwards something', async ($, on) => {
  const linkOnly = { seq: 2, type: 'artifact', ts: 900, from: HOST_FROM, body: { kind: 'preview', pid: 'pv-link', port: 4000, path: '/', title: 'Docs' } }
  // Not forwarded, though it says what it's for: no line about it either.
  const unforwarded = {
    seq: 3,
    type: 'artifact',
    ts: 901,
    from: HOST_FROM,
    body: { kind: 'preview', pid: 'pv-odd', port: 4001, path: '/', title: 'API', dependency: 4000 },
  }
  const stream: unknown[] = [{ seq: 3, events: [linkOnly, unforwarded], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = world(on, { browser: { platform: 'Darwin', path: null }, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, stream })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount(roomPane('terminal'))
  await pane.press({ key: 'tab-shown' })
  await asked.clock.advance(10)
  expect(await pane.find({ type: 'Text', text: /^Used for/ })).toBeUndefined()
  await pane.press({ key: 'tab-settings' })
  await asked.clock.advance(10)
  expect(await pane.find({ key: 'preview-open' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /separate window can't open here/ })).toBeUndefined()
  expect(asked.spawned.some(s => s.input?.startsWith('# shared-session: find a browser'))).toBe(false)
  // The host forwards one: the setting shows, and why no window opens here.
  stream.push({ seq: 4, events: [{ ...LOCAL_SHOWN, seq: 4 }], people: PREVIEW_PEOPLE, ended: false, title: 'demo' })
  await within(asked.clock, () => asked.state.shown?.some(s => s.pid === 'pv-local' && s.tcp), 5_000)
  await asked.clock.advance(50)
  expect(await pane.find({ key: 'preview-open' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /A separate window can't open here: no Chrome/ })).toBeDefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a place that comes back to a room that ended removes its preview profile', async ($, on) => {
  const saved = {
    at: 900,
    room: { server: 'https://share.test', id: 'room0000000000000001', url: LINK, title: 'demo', host: 'Sam', token: 'g', seat: 'seat1', seq: 2, since: 1 },
    autoOpen: true,
    policy: { prompts: 'everyone', approvals: 'edits', files: 'on' },
    shown: [],
    localPreviews: [],
    activity: [],
    chat: [],
    sidebar: null,
    previewWindow: { port: 47100 },
  }
  const asked = world(on, { roomGone: true, files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: saved }) } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  const trash = await eventually(asked.clock, () => asked.spawned.find(s => s.input?.startsWith('# shared-session: remove a preview profile')))
  expect(trash?.input).toContain(`p='${await roomProfile()}'`)
  expect(asked.state.room ?? null).toBeNull()
})

test('a session start cleans up old preview profiles, never the room it is in', async ($, on) => {
  const asked = world(on, { files: { '/home/scott/.claude/shared-session/browser/.keep': '' } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  const gc = await eventually(asked.clock, () => asked.spawned.find(s => s.input?.startsWith('# shared-session: clean up preview profiles')))
  expect(gc?.input).toContain("b='/home/scott/.claude/shared-session/browser'; keep=''")
})

test('without a preview profile folder nothing is cleaned up', async ($, on) => {
  const asked = world(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await asked.clock.advance(50)
  expect(asked.spawned.some(s => s.input?.startsWith('# shared-session: clean up preview profiles'))).toBe(false)
})

for (const [why, opts, reason] of [
  ['no browser', { browser: { platform: 'Darwin', path: null } }, 'no Chrome, Edge, Brave, Chromium, Firefox, Vivaldi or Opera was found'],
  ['no display', { browser: { platform: 'Linux', path: '/usr/bin/chromium' } }, 'there is no display for a window here'],
  ['an SSH session', { browser: { platform: 'Darwin', path: CHROME }, env: { SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' } }, 'this is an SSH session'],
  ['SHARED_SESSION_NO_BROWSER', { browser: { platform: 'Darwin', path: CHROME }, env: { SHARED_SESSION_NO_BROWSER: '1' } }, 'SHARED_SESSION_NO_BROWSER=1'],
  ['another platform', { browser: { platform: 'MINGW64_NT-10.0', path: '/c/chrome.exe' } }, 'preview windows work on macOS and Linux'],
  [
    'a Firefox too old',
    { browser: { platform: 'Darwin', path: '/Applications/Firefox.app', gecko: 128 } },
    'Firefox 128 is too old for preview windows, which need Firefox 140 or newer',
  ],
  [
    "a Firefox whose version can't be read",
    { browser: { platform: 'Linux', path: '/usr/bin/firefox', gecko: null }, env: { DISPLAY: ':0' } },
    "Firefox's version couldn't be read, and preview windows need Firefox 140 or newer",
  ],
  [
    'a browser of neither kind',
    { browser: { platform: 'Darwin', path: '/Applications/Safari.app' } },
    "Safari can't be used for preview windows, which need a Chromium-family browser or Firefox",
  ],
  [
    'a profile folder too deep for Firefox on Linux',
    { browser: { platform: 'Linux', path: '/usr/bin/firefox' }, env: { DISPLAY: ':0', CLAUDE_CONFIG_DIR: `/home/scott/${'deep/'.repeat(30)}claude` } },
    "the preview window's profile folder is too deep for Firefox on Linux (170 bytes at most",
  ],
] as const) {
  test(`without a preview window (${why}), a port taken here moves the page, and the note says why there's no window, once`, async ($, on) => {
    const extra = opts as Parameters<typeof world>[1] & { env?: Record<string, string> }
    const asked = world(on, {
      ...extra,
      localPreviewByPid: { 'pv-local': { taken: [3340], port: 44321 } },
      env: { CLAUDE_CODE_ENTRYPOINT: 'cli', ...extra.env },
      stream: [{ seq: 2, events: [WINDOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
    })
    await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
    await asked.clock.advance(10)
    // The row above the prompt opens it the same way.
    const ui = await $.ui.mount(band('terminal'))
    await ui.press({ key: 'open-preview' })
    const moved = 'http://127.0.0.1:44321/login?next=%2Faccount'
    // With SHARED_SESSION_NO_BROWSER, nothing opens: the address is copied.
    const opened = () => [...asked.externals, ...asked.copied]
    await eventually(asked.clock, () => opened().length)
    await asked.clock.advance(10)
    expect(opened()).toEqual([moved])
    expect(asked.launches).toHaveLength(0)
    expect(asked.proxies).toHaveLength(0)
    expect(tunnels(asked).map(t => [t.port, t.strict])).toEqual([
      [3340, true],
      [3340, false],
    ])
    const note =
      "Sam's preview opened at localhost:44321 here, not localhost:3340, which is in use on this computer, so sign-ins registered for localhost:3340 won't work. A separate window would keep Sam's addresses, but "
    expect(asked.toasted.filter(t => t.startsWith(note))).toHaveLength(1)
    expect(asked.toasted.find(t => t.startsWith(note))).toContain(reason)
    expect(await ui.find({ key: 'open-preview' })).toBeUndefined()
    // Opened again from the Room: the same listener, and nothing said again.
    const pane = await $.ui.mount(roomPane('terminal'))
    await pane.press({ key: 'tab-shown' })
    expect(await pane.find({ type: 'Text', text: "localhost:44321 here → Sam's localhost:3340" })).toBeDefined()
    await pane.press({ key: 'open-preview:pv-local' })
    await eventually(asked.clock, () => opened().length === 2)
    expect(tunnels(asked)).toHaveLength(2)
    expect(asked.toasted.filter(t => t.startsWith(note))).toHaveLength(1)
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test("Previews: Always a separate window, in Room → Settings, opens the window though every port is free; a terminal's default is your browser", async ($, on) => {
  // The settings before this one (window or a local port; an unreleased build's Automatic) read as the default.
  const asked = world(on, {
    browser: { platform: 'Darwin', path: CHROME },
    localPreviewPort: 45001,
    env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
    stream: [{ seq: 2, events: [WINDOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
    store: { previewMode: 'local', previewOpen: 'auto' },
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount(roomPane('terminal'))
  await pane.press({ key: 'tab-shown' })
  expect(await pane.find({ type: 'Text', text: `Opens ${WINDOW_URL}` })).toBeDefined()
  await pane.press({ key: 'tab-settings' })
  // A terminal has no Claude's browser: the person's own, or always the window.
  const select = await pane.find({ key: 'preview-open' })
  expect(select?.props.value).toBe('browser')
  expect((select?.props.options as { value: string }[]).map(o => o.value)).toEqual(['browser', 'window'])
  await pane.select({ key: 'preview-open', value: 'window' })
  expect(asked.store.get('previewOpen')).toBe('window')
  await pane.press({ key: 'tab-shown' })
  expect(await pane.find({ type: 'Text', text: `Opens ${WINDOW_URL} in a preview window` })).toBeDefined()
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(10)
  expect(asked.launches[0]!.at(-1)).toBe(WINDOW_URL)
  expect(asked.externals).toEqual([])
  expect(tunnels(asked).map(t => [t.port, t.strict])).toEqual([[0, false]])
  await pane.press({ key: 'tab-settings' })
  await pane.select({ key: 'preview-open', value: 'browser' })
  expect(asked.store.get('previewOpen')).toBe('browser')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

const PUBLIC_URL = 'https://preview.test/__share/enter?room=room0000000000000001&ticket=ticket-1'

test("in Claude Desktop, Previews offers Claude's browser, its default, then Your browser and Always a separate window; Your browser opens the person's own", async ($, on) => {
  const asked = world(on, { browser: { platform: 'Darwin', path: CHROME }, stream: localStream, store: { previewOpen: 'auto' } })
  const pane = paneCalls(on, false)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const room = await $.ui.mount(roomPane())
  await room.press({ key: 'tab-settings' })
  const select = await room.find({ key: 'preview-open' })
  expect(select?.props.value).toBe('pane')
  expect((select?.props.options as { label: string }[]).map(o => o.label)).toEqual([
    "Claude's browser, or a separate window when ports are taken",
    'Your browser, or a separate window when ports are taken',
    'Always a separate window',
  ])
  await room.select({ key: 'preview-open', value: 'browser' })
  expect(asked.store.get('previewOpen')).toBe('browser')
  await room.press({ key: 'tab-shown' })
  await room.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length)
  expect(asked.externals).toEqual([LOCAL_URL])
  expect(pane).toEqual([])
  expect(asked.toasted.filter(t => t.startsWith("Opened Sam's localhost:3340"))).toEqual([
    "Opened Sam's localhost:3340 in your browser. While you're in the room, localhost:3340 here reaches Sam's, your cookies for it included; Close in Room → Shown, or Leave, frees it.",
  ])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("auto mode refusing Claude's browser: the person's own opens, it's said once and not asked again; Allow previews in Claude adds exactly its rule", async ($, on) => {
  const asked = world(on, { settings: '{"permissions":{"allow":["Bash(npm test)"]},"model":"opus"}', stream: localStream })
  const pane = paneCalls(on, true)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const room = await $.ui.mount(roomPane())
  await room.press({ key: 'tab-shown' })
  await room.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length)
  expect(pane).toEqual([LOCAL_URL])
  expect(asked.externals).toEqual([LOCAL_URL])
  const refused =
    "Auto mode doesn't let the plugin open previews in Claude's browser, so they open in your browser. Press Allow previews in Claude, in Room → Settings, to let it."
  expect(asked.toasted.filter(t => t === refused)).toHaveLength(1)
  expect(asked.toasted.filter(t => t.startsWith("Opened Sam's localhost:3340 in your browser."))).toHaveLength(1)
  // Not tried again while no rule lets it: the next Open goes straight to the person's own.
  await room.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length === 2)
  expect(pane).toHaveLength(1)
  expect(asked.externals).toEqual([LOCAL_URL, LOCAL_URL])
  expect(asked.toasted.filter(t => t === refused)).toHaveLength(1)
  expect((await room.find({ key: 'tab-settings' }))?.props.label).toBe('Settings ●')
  await room.press({ key: 'tab-settings' })
  // What else the rule lets, said beside its button.
  expect(await room.find({ type: 'Text', text: /also lets your own Claude open pages in Claude's browser without auto mode's review/ })).toBeDefined()
  await room.press({ key: 'allow-pane' })
  await asked.clock.advance(10)
  const settings = JSON.parse(asked.files.get('/home/scott/.claude/settings.json') ?? '{}')
  expect(settings.permissions.allow).toEqual(['Bash(npm test)', 'mcp__Claude_Browser__preview_start'])
  expect(settings.model).toBe('opus') // the rest kept
  expect(asked.toasted).toContain("Previews in Claude allowed: the next one opens in Claude's browser.")
  expect(await room.find({ key: 'allow-pane' })).toBeUndefined()
  expect((await room.find({ key: 'tab-settings' }))?.props.label).toBe('Settings')
  // Let through now: the next Open goes to Claude's browser.
  pane.refuse(false)
  await room.press({ key: 'tab-shown' })
  await room.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => pane.length === 2)
  expect(pane).toEqual([LOCAL_URL, LOCAL_URL])
  expect(asked.externals).toHaveLength(2)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// Claude Code under CLAUDE_CONFIG_DIR reads the person's settings, and keeps
// its plugins, there: what the plugin writes for it goes there too.
const CONFIG = '/home/scott/cfg'

test('with CLAUDE_CONFIG_DIR set, Allow previews in Claude adds its rule to the settings Claude Code reads there, and the next Open reads it back', async ($, on) => {
  const asked = world(on, {
    settings: '{}',
    env: { CLAUDE_CONFIG_DIR: `${CONFIG}/` },
    files: { [`${CONFIG}/settings.json`]: '{"model":"opus"}' },
    stream: localStream,
  })
  const pane = paneCalls(on, true)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const room = await $.ui.mount(roomPane())
  await room.press({ key: 'tab-shown' })
  await room.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length)
  await room.press({ key: 'tab-settings' })
  await room.press({ key: 'allow-pane' })
  await asked.clock.advance(10)
  expect(JSON.parse(asked.files.get(`${CONFIG}/settings.json`) ?? '{}')).toEqual({
    model: 'opus',
    permissions: { allow: ['mcp__Claude_Browser__preview_start'] },
  })
  expect(asked.files.get('/home/scott/.claude/settings.json')).toBe('{}')
  expect(asked.written.map(w => w.path)).toEqual([`${CONFIG}/settings.json`])
  pane.refuse(false)
  await room.press({ key: 'tab-shown' })
  await room.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => pane.length === 2)
  expect(pane).toEqual([LOCAL_URL, LOCAL_URL])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("with CLAUDE_CONFIG_DIR set, the Room's Updates setting is written to the settings Claude Code reads there", async ($, on) => {
  const asked = world(on, { settings: '{}', env: { CLAUDE_CONFIG_DIR: CONFIG }, files: { [`${CONFIG}/settings.json`]: '{"theme":"dark"}' } })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-settings' })
  expect((await pane.find({ key: 'updates' }))?.props.value).toBe('manual')
  await pane.select({ key: 'updates', value: 'auto' })
  const saved = JSON.parse(asked.files.get(`${CONFIG}/settings.json`) ?? '{}')
  expect(saved.theme).toBe('dark')
  expect(saved.extraKnownMarketplaces['claude-share']).toEqual({ source: { source: 'github', repo: 'Paradigm-Study/claude-share' }, autoUpdate: true })
  expect(saved.env).toEqual(NAMED)
  expect(asked.files.get('/home/scott/.claude/settings.json')).toBe('{}')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("with CLAUDE_CONFIG_DIR set, Updates read back from the settings there, and Desktop's copy of a local marketplace from its plugins there", async ($, on) => {
  const local = { 'claude-share': { source: { source: 'directory', path: '/home/scott/claude-share' }, autoUpdate: true } }
  const asked = world(on, {
    latest: '9.9.9',
    env: { CLAUDE_CONFIG_DIR: CONFIG },
    files: {
      [`${CONFIG}/settings.json`]: JSON.stringify({ env: NAMED, extraKnownMarketplaces: local }),
      [LIVE]: '{}',
      [`${CONFIG}/plugins/known_marketplaces.json`]: JSON.stringify(local),
    },
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-settings' })
  expect((await pane.find({ key: 'updates' }))?.props.value).toBe('auto')
  expect(await pane.find({ type: 'Text', text: /runs the copy installed from your local marketplace folder/ })).toBeDefined()
})

test("with CLAUDE_CONFIG_DIR set, the update command a guest types says what it installed, from Claude Code's plugins there", async ($, on) => {
  const installed = (version: string, dir: string) =>
    JSON.stringify({
      version: 2,
      plugins: { 'shared-session@claude-share': [{ scope: 'user', installPath: `${dir}/plugins/cache/claude-share/shared-session/${version}`, version }] },
    })
  const asked = world(on, {
    env: { CLAUDE_CONFIG_DIR: CONFIG },
    files: {
      [`${CONFIG}/plugins/installed_plugins.json`]: installed('9.9.9', CONFIG),
      '/home/scott/.claude/plugins/installed_plugins.json': installed('0.7.0', '/home/scott/.claude'),
    },
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  await $.prompt.submit({
    text: 'claude plugin marketplace update claude-share && claude plugin update shared-session@claude-share',
    origin: { kind: 'composer' },
    wait: false,
  })
  await asked.clock.advance(100)
  expect(asked.logged.some(l => l.startsWith('Shared Sessions 9.9.9 is installed here. Start a new session to use it'))).toBe(true)
  expect(asked.logged.some(l => l.includes('up to date here'))).toBe(false)
})

test("a rule for Claude's browser added by hand lets the next Open try it again", async ($, on) => {
  const asked = world(on, { settings: '{}', stream: localStream })
  const pane = paneCalls(on, true)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const room = await $.ui.mount(roomPane())
  await room.press({ key: 'tab-shown' })
  await room.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length)
  expect(pane).toHaveLength(1)
  // Allowed in the settings file by hand (or by another session): read again at the next Open.
  asked.files.set('/home/scott/.claude/settings.json', JSON.stringify({ permissions: { allow: ['mcp__Claude_Browser__preview_start'] } }))
  pane.refuse(false)
  await room.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => pane.length === 2)
  expect(pane).toEqual([LOCAL_URL, LOCAL_URL])
  expect(asked.externals).toHaveLength(1)
  await room.press({ key: 'tab-settings' })
  expect(await room.find({ key: 'allow-pane' })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a shared page Claude's browser refuses opens in the Files pane, said once in its own words, and the next isn't tried there", async ($, on) => {
  const files = [{ id: 'b'.repeat(64), name: 'index.html', type: 'text/html', size: 42, path: 'index.html' }]
  const shown = { seq: 2, type: 'artifact', ts: 900, from: { seat: 'host', name: 'Sam', role: 'host' }, body: { kind: 'page', files } }
  const asked = world(on, { stream: [{ seq: 2, events: [shown], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }] })
  const calls: string[] = []
  on('mcp.call', ($, e) => {
    calls.push(`${e.server}.${e.tool}`)
    if (e.server === 'Claude_Browser')
      return { value: { content: [{ type: 'text', text: 'The server-side auto mode classifier gave no verdict' }], isError: true } } as never
    return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } } as never
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const room = await $.ui.mount(roomPane())
  await room.press({ key: 'tab-shown' })
  await room.press({ key: 'open-seq:2' })
  await asked.clock.advance(200)
  expect(calls.filter(c => c === 'Claude_Browser.preview_start')).toHaveLength(1)
  expect(calls.filter(c => c === 'ccd_view.show_pane')).toHaveLength(1)
  await room.press({ key: 'open-seq:2' })
  await asked.clock.advance(200)
  expect(calls.filter(c => c === 'Claude_Browser.preview_start')).toHaveLength(1)
  expect(calls.filter(c => c === 'ccd_view.show_pane')).toHaveLength(2)
  expect(asked.toasted.filter(t => t.startsWith("Auto mode doesn't let the plugin open"))).toEqual([
    "Auto mode doesn't let the plugin open shared pages in Claude's browser, so they open in the Files pane. Press Allow previews in Claude, in Room → Settings, to let it.",
  ])
})

for (const [where, opts, opens] of [
  ["a terminal's own browser (Claude's browser, saved in Claude Desktop, reads as it)", { store: { previewOpen: 'pane' } }, true],
  [
    'over SSH, its address copied: a browser would open on another screen',
    { env: { CLAUDE_CODE_ENTRYPOINT: 'cli', SSH_CONNECTION: '203.0.113.9 50000 10.0.0.5 22' } },
    false,
  ],
  ['on Linux with no display, its address copied', { browser: { platform: 'Linux' } }, false],
  ['on Linux with a display, the browser xdg-open starts', { browser: { platform: 'Linux' }, env: { CLAUDE_CODE_ENTRYPOINT: 'cli', DISPLAY: ':0' } }, true],
] as const) {
  test(`a forwarded preview and its public link open in ${where}`, async ($, on) => {
    const asked = world(on, { env: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, stream: localStream, ...opts })
    const pane = paneCalls(on, false)
    await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
    await asked.clock.advance(10)
    const room = await $.ui.mount(roomPane('terminal'))
    await room.press({ key: 'tab-shown' })
    await room.press({ key: 'open-preview:pv-local' })
    await eventually(asked.clock, () => asked.externals.length + asked.copied.length)
    await room.press({ key: 'public-preview:pv-local' })
    await eventually(asked.clock, () => asked.externals.length + asked.copied.length === 2)
    expect(pane).toEqual([])
    expect(asked.externals).toEqual(opens ? [LOCAL_URL, PUBLIC_URL] : [])
    expect(asked.copied).toEqual(opens ? [] : [LOCAL_URL, PUBLIC_URL])
    if (!opens) {
      expect(asked.toasted).toContain(`Sam's preview is ready at ${LOCAL_URL}: the address is copied.`)
      expect(asked.toasted).toContain('Public preview link copied: open it within 10 minutes')
    }
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test('an Open whose ports are all free here never waits on the browser look', async ($, on) => {
  let release!: () => void
  const asked = world(on, {
    browser: { platform: 'Darwin', path: CHROME },
    detectWait: new Promise<void>(done => {
      release = done
    }),
    stream: localStream,
  })
  const pane = paneCalls(on, false)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => pane.length)
  // Opened at the host's number while the look for a window's browser is still out.
  expect(pane).toEqual([LOCAL_URL])
  release()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a preview window that fails to start, with Previews: Always a separate window, opens nothing else, and says how to open it without one', async ($, on) => {
  const asked = windowWorld(on, { launchFails: true })
  const pane = paneCalls(on, false)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  const failed = "Couldn't open the preview window: Google Chrome didn't start. To open Sam's localhost:3340 without one, change Previews in Room → Settings."
  await eventually(asked.clock, () => asked.toasted.includes(failed))
  expect(asked.toasted).toContain(failed)
  // Neither Claude's browser nor the person's own: their cookies and servers stay apart from Sam's until they say.
  expect(pane).toEqual([])
  expect(asked.externals).toEqual([])
  expect(tunnels(asked).map(t => [t.port, t.strict])).toEqual([[0, false]])
  // What it started for the window (its proxy, the page's tunnel) stops: nothing will use it.
  await eventually(asked.clock, () => asked.localHelpers.every(h => h.stopped))
  expect(asked.proxies.every(p => p.stopped)).toBe(true)
  expect(asked.localHelpers.every(h => h.stopped)).toBe(true)
  // Open preview stays: pressed again, it tries the window again, and nothing else.
  expect(await ui.find({ key: 'open-preview' })).toBeDefined()
  expect(asked.state.localPreviews ?? []).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

for (const [why, opts, reason] of [
  [
    'no browser here can open one',
    { browser: { platform: 'Darwin', path: '/Applications/Safari.app' } },
    "Safari can't be used for preview windows, which need a Chromium-family browser or Firefox",
  ],
  ['the look for a browser failing', { detectFails: { count: 2 } }, "looking for a browser here didn't work (it's tried again at the next Open)"],
] as const) {
  test(`Previews: Always a separate window, with no window possible (${why}), opens nothing else, and says how to open it without one`, async ($, on) => {
    const asked = windowWorld(on, opts as Parameters<typeof world>[1])
    const pane = paneCalls(on, true)
    await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
    await asked.clock.advance(10)
    const ui = await $.ui.mount(band('desktop'))
    await asked.clock.advance(10)
    await ui.press({ key: 'open-preview' })
    const failed = `Couldn't open the preview window: ${reason}. To open Sam's localhost:3340 without one, change Previews in Room → Settings.`
    await eventually(asked.clock, () => asked.toasted.includes(failed))
    await asked.clock.advance(10)
    // Neither Claude's browser nor the person's own, nor the host's numbers taken here.
    expect(asked.toasted).toContain(failed)
    expect(pane).toEqual([])
    expect(asked.externals).toEqual([])
    expect(tunnels(asked)).toEqual([])
    expect(asked.launches).toHaveLength(0)
    expect(await ui.find({ key: 'open-preview' })).toBeDefined()
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test("with Previews: Always a separate window, Shown says the page opens in a preview window while the browser look isn't known", async ($, on) => {
  const asked = windowWorld(on, { detectFails: { count: 1 } })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await asked.clock.advance(20)
  // The look failed: nothing's known, and the line still says where it opens.
  expect(asked.spawned.some(s => s.input?.startsWith('# shared-session: find a browser'))).toBe(true)
  expect(await pane.find({ type: 'Text', text: `Opens ${WINDOW_URL} in a preview window` })).toBeDefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('with Previews: Always a separate window and none possible here, Shown says why, and what Open does instead', async ($, on) => {
  const asked = windowWorld(on, { browser: { platform: 'Darwin', path: '/Applications/Safari.app' } })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await asked.clock.advance(20)
  expect(
    await pane.find({
      type: 'Text',
      text: `Opens ${WINDOW_URL} in a preview window, which can't open here: Safari can't be used for preview windows, which need a Chromium-family browser or Firefox. Change Previews in Settings to open it without one.`,
    }),
  ).toBeDefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a port taken here and a preview window that fails to start: the page opens elsewhere, its note saying why there was no window', async ($, on) => {
  const asked = world(on, {
    browser: { platform: 'Darwin', path: CHROME },
    launchFails: true,
    localPreviewByPid: { 'pv-local': { taken: [3340], port: 44321 } },
    stream: localStream,
  })
  const pane = paneCalls(on, false)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => pane.length)
  expect(asked.launches).toHaveLength(1)
  expect(pane).toEqual(['http://localhost:44321/login?next=%2Faccount'])
  expect(tunnels(asked).map(t => [t.port, t.strict])).toEqual([
    [3340, true],
    [0, false],
    [3340, false],
  ])
  expect(asked.toasted.filter(t => t.startsWith("Sam's preview opened"))).toEqual([
    "Sam's preview opened at localhost:44321 here, not localhost:3340, which is in use on this computer, so sign-ins registered for localhost:3340 won't work. A separate window would keep Sam's addresses, but Google Chrome didn't start.",
  ])
  expect(asked.toasted.some(t => t.startsWith("Couldn't open the preview window"))).toBe(false)
  expect(asked.state.localPreviews).toEqual([{ pid: 'pv-local', port: 3340, localPort: 44321 }])
  expect(asked.proxies.every(p => p.stopped)).toBe(true)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a port taken here and a preview window not seen within ten seconds: nothing else opens it, and the note says what would', async ($, on) => {
  const asked = world(on, {
    browser: { platform: 'Darwin', path: CHROME },
    launchNoWindow: true,
    localPreviewByPid: { 'pv-local': { taken: [3340], port: 44321 } },
    stream: localStream,
  })
  const pane = paneCalls(on, false)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  const said =
    "Google Chrome didn't open a preview window within 10 seconds. If none opens, free localhost:3340 on this computer and press Open preview to open it in Claude's browser instead."
  await within(asked.clock, () => asked.toasted.includes(said), 12_000)
  expect(asked.toasted).toContain(said)
  // It may still show: nothing moves the page meanwhile.
  expect(pane).toEqual([])
  expect(asked.externals).toEqual([])
  expect(tunnels(asked).map(t => [t.port, t.strict])).toEqual([
    [3340, true],
    [0, false],
  ])
  expect(asked.state.localPreviews ?? []).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a page open in the window, whose window then fails to start, opens at the host's own numbers, free here by then", async ($, on) => {
  const byPid: Record<string, { taken?: number[]; port?: number }> = { 'pv-local': { taken: [3340], port: 44321 } }
  const opts: NonNullable<Parameters<typeof world>[1]> = { browser: { platform: 'Darwin', path: CHROME }, localPreviewByPid: byPid, stream: localStream }
  const asked = world(on, opts)
  const pane = paneCalls(on, false)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const room = await $.ui.mount(roomPane())
  await room.press({ key: 'tab-shown' })
  await room.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(10)
  expect(asked.state.previewWindow?.opened).toEqual(['pv-local'])
  // 3340 is free here now, and the window's next start fails.
  byPid['pv-local'] = {}
  opts.launchFails = true
  await room.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => pane.length)
  expect(asked.launches).toHaveLength(2)
  expect(asked.toasted).toContain("Couldn't open the preview window: Google Chrome didn't start.")
  expect(pane).toEqual([LOCAL_URL])
  expect(tunnels(asked).at(-1)).toMatchObject({ port: 3340, strict: true })
  // The window is still open: its proxy stays for its other tabs.
  expect(asked.proxies.map(p => p.stopped)).toEqual([false])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("an Open saves where its page listens only once it's done: one still starting leaves the saved mapping as it was", async ($, on) => {
  const byPid: Record<string, { taken?: number[]; port?: number; mode?: 'wait' }> = { 'pv-local': { taken: [3340], port: 44321 } }
  const asked = localWorld(on, { localPreviewByPid: byPid, stream: [{ seq: 2, events: [WINDOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }] })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount(roomPane('terminal'))
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length)
  await asked.clock.advance(10)
  expect(asked.state.localPreviews).toEqual([{ pid: 'pv-local', port: 3340, localPort: 44321 }])
  // The host refuses it; 3340 is free here now, and the next listener is slow to start.
  asked.localHelpers.at(-1)!.send({ state: 'channel-error', code: 'AUTH' })
  await asked.clock.advance(20)
  byPid['pv-local'] = { mode: 'wait' }
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => tunnels(asked).length === 3)
  expect(tunnels(asked).at(-1)).toMatchObject({ port: 3340, strict: true })
  // Still starting: nothing saved for it, so a session closing now comes back at 44321, where the page was.
  expect(asked.state.localPreviews).toEqual([{ pid: 'pv-local', port: 3340, localPort: 44321 }])
  asked.localHelpers.at(-1)!.send({ state: 'ready', port: 3340 })
  await eventually(asked.clock, () => asked.externals.length === 2)
  expect(asked.externals.at(-1)).toBe(WINDOW_URL)
  expect(asked.state.localPreviews).toEqual([{ pid: 'pv-local', port: 3340, localPort: 3340 }])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})
