// Shared sessions: Share turns this Claude Code session into one teammates
// join from their own Claude Code by opening or pasting the link.
//
// The session that shares is the host: it runs every turn and every tool on
// its own machine and mirrors its transcript to the room server. A session
// that joins is a guest. What a guest types goes to the host as a prompt, and
// every host turn plays out in the guest as a turn of its own: the guest's
// `turn.step` answers from the host's stream instead of calling a model, so
// the guest's transcript draws prompts and replies the way it draws its own.
//
// Everything a shared session adds to the screen sits where the app already
// draws: a teammate's face and name on their prompt, who's here in the
// footer's labels, whose turn it is on the working line, "for Alex" under a
// tool call the host's Claude made for Alex, a preview in the approval
// dialog, one row above the prompt, and the Room panel (people, activity,
// a side chat Claude never reads, and the host's controls).

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, RenderSurface, Timer, TurnStepChunk } from 'claude-code'

import type { ShareActivity, ShareChat, ShareMode, SharePerson, SharePolicy, ShareRoom, ShareWorking } from '../types'
import { ACCENT, BAD, GOOD, ROSE, ago, avatarSvg, bannerSvg, labelsFor, stackSvg, toolGlyph } from './look'
import type { Face } from './look'
import { rowsFromMessage, rowsToMarkdown, splitSpeaker, summarizeTool } from './rows'
import type { Row } from './rows'
import { SERVER_URL } from './server'

type $ = EngineInterface
type UI = Elements[RenderSurface]

const PLUGIN = 'shared-session'
const ROOM = 'shared-room' // the Room panel's id
const ASK_HEADER = 'Shared' // marks the approval question this plugin asks
// How this session hears about the room. While a plugin has a request in
// flight, the engine holds every prompt after the first until it returns, so
// the plugin never long-polls. Instead a `curl` child, whose open stream holds
// nothing, keeps `stream?after=<seq>` open for the session's life, and the
// room sends a line whenever it changes: a quiet room costs no requests at
// all. Where curl can't start, or the server has no stream, the plugin polls
// with requests that return at once, less often the longer nothing happens.
const STREAM_STALE_MS = 70_000 // no line for this long (keepalives come every 25 s): reconnect
const POLL_HOT_MS = 400 // something happened in the last few seconds
const POLL_IDLE_MS = 1_500
const HOT_FOR_MS = 15_000
const RIDE_WAIT_MS = 600 // a riding turn waits this long for news at a time
const TAIL_CHARS = 600

// Tools a guest's turn runs without asking the host (policy `edits`): they only read.
const READ_ONLY = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoWrite',
  'ToolSearch',
  'WebSearch',
  'AskUserQuestion',
  'Skill',
  'EnterPlanMode',
  'ExitPlanMode',
  'TaskList',
  'TaskGet',
  'TaskOutput',
])

const DEFAULT_POLICY: SharePolicy = { prompts: 'everyone', approvals: 'edits' }

const modeA = atom({ plugin: 'shared-session', key: 'mode' } as const, 'idle' as ShareMode)
const roomA = atom({ plugin: 'shared-session', key: 'room' } as const, null as ShareRoom | null)
const peopleA = atom({ plugin: 'shared-session', key: 'people' } as const, [] as SharePerson[])
const workingA = atom({ plugin: 'shared-session', key: 'working' } as const, null as ShareWorking | null)
const activityA = atom({ plugin: 'shared-session', key: 'activity' } as const, [] as ShareActivity[])
const chatA = atom({ plugin: 'shared-session', key: 'chat' } as const, [] as ShareChat[])
const unreadA = atom({ plugin: 'shared-session', key: 'unread' } as const, 0)
const policyA = atom({ plugin: 'shared-session', key: 'policy' } as const, DEFAULT_POLICY)
const trustedA = atom({ plugin: 'shared-session', key: 'trusted' } as const, [] as string[])
const ownersA = atom({ plugin: 'shared-session', key: 'owners' } as const, {} as Record<string, string>)
const sidebarA = atom({ plugin: 'shared-session', key: 'sidebar' } as const, null as { title: string; pinned: boolean } | null)

// Context a host app puts into the person's message (Claude Desktop adds a
// <system-reminder> to a first prompt): not typed, and never shared.
const SYSTEM_BLOCKS = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function typedText(text: string): string {
  return text.replace(SYSTEM_BLOCKS, '').trim()
}

// Prompts a person typed: at the prompt box, through the Desktop app or an SDK
// host, or over Remote Control. Only these join a shared session; a message a
// peer session, channel or task delivered never does (once joined, everything
// typed here goes to someone else's machine).
const PERSON = new Set(['composer', 'sdk', 'bridge'])

// A share link: <server origin, with any path prefix>/s/<room id>, alone.
const LINK = /^\s*(https?:\/\/[^\s]+?)\/s\/([A-Za-z0-9_-]{16,64})\/?\s*$/

type ServerEvent = {
  seq: number
  type: string
  from: { seat: string; name: string; role: 'host' | 'guest' }
  ts: number
  body: Record<string, unknown>
}

type EventsPage = { seq: number; events: ServerEvent[]; people: SharePerson[]; ended: boolean; title: string }

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Module state. A reload starts these over; what must survive is in $.state.

// The `server` option, as the plugin's options carry it (set by register).
let configuredServer = ''

const NO_SERVER =
  'Sharing needs a share server, and none is set up yet. Run your own (README: "Host a server"), then set it with `/plugin configure shared-session` or the SHARED_SESSION_SERVER environment variable. Joining a link someone sent you needs nothing.'

// Where Share creates rooms: the plugin's option, the environment, or the
// build's default, in that order.
async function serverOf($: $): Promise<string> {
  const fromEnv = (await $.env.get('SHARED_SESSION_SERVER')) ?? ''
  const url = (configuredServer || fromEnv || SERVER_URL).trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Error(NO_SERVER)
  return url
}
let myName: string | undefined
let outbox: { type: string; body: Record<string, unknown> }[] = []
let flushTimer: Timer | null = null
let flushing = false
let pollGeneration = 0 // the room feed's run; a new one ends the old
let pollFailures = 0
let pollDelay = 0 // the wait before the next background poll
let lastActivity = 0
// The open stream: its child, the cursor it started after, the events it has
// brought since (riding turns read them), and those waiting for more.
let feedStream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | null = null
let streamUp = false
let streamFloor = 0
let streamEnded = false
const streamed: ServerEvent[] = []
const feedWaiters = new Set<() => void>()
let roomOpen = false

// Host: guest prompts submitted and not yet started, oldest first.
const pendingGuestPrompts: { who: string; framed: string; text: string; pid: string }[] = []
// Host: the approval question on screen, so its dialog can show a preview.
let pendingAsk: { who: string; preview: string; descriptions: Record<string, string> } | null = null

// Guest: the host's turns as announced, and how this session shows them.
type HostTurn = { turnId: string; by: string; prompt: string; pid?: string; startSeq: number; shown: boolean; claimed: boolean }
type Ride =
  | { kind: 'own'; pid: string; fromSeq: number } // a prompt typed here
  | { kind: 'turn'; turnId: string } // someone else's turn
  | { kind: 'static'; rows: Row[] } // what happened before this session joined
  | { kind: 'note'; text: string; then: Exchange[] } // an answer from the plugin itself
type Exchange = { prompt: string; rows: Row[] }
const hostTurns: HostTurn[] = []
const ownPending = new Set<string>()
const ridesByText = new Map<string, Ride[]>()
const ridesByTurn = new Map<string, Ride>()
let localTurnActive = false

// ---------------------------------------------------------------------------
// Server

async function api<T>(
  $: $,
  server: string,
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.token) headers.authorization = `Bearer ${init.token}`
  const res = await $.http.fetch(`${server}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(res.text)
  } catch {}
  if (!res.ok) throw new ApiError(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`, res.status)
  return data as T
}

const isGone = (error: unknown) => error instanceof ApiError && [401, 404, 410].includes(error.status)

function send($: $, type: string, body: Record<string, unknown>) {
  const last = outbox.at(-1)
  if (type === 'delta' && last?.type === 'delta' && last.body.turnId === body.turnId) {
    last.body = { ...last.body, text: `${last.body.text}${body.text}` }
  } else {
    outbox.push({ type, body })
  }
  scheduleFlush($, type === 'delta' ? 120 : 30)
  if (type !== 'delta') {
    void $.clock.now().then(now => {
      lastActivity = now
    })
    kickPoll($)
  }
}

function scheduleFlush($: $, ms: number) {
  if (flushTimer) return
  flushTimer = $.clock.after(ms, () => {
    flushTimer = null
    void flush($)
  })
}

async function flush($: $) {
  if (flushing) return scheduleFlush($, 50)
  const room = await read($, roomA)
  if (!room) {
    outbox = []
    return
  }
  const batch = outbox.splice(0, 200)
  if (batch.length === 0) return
  flushing = true
  let retry = false
  try {
    await api($, room.server, `/api/rooms/${room.id}/events`, {
      method: 'POST',
      token: room.token,
      body: { events: batch },
    })
  } catch (error) {
    if (isGone(error)) outbox = []
    else {
      // Keep what matters and try again; live text is not worth replaying.
      outbox.unshift(...batch.filter(item => item.type !== 'delta'))
      retry = true
    }
  } finally {
    flushing = false
  }
  if (retry) scheduleFlush($, 2000)
  else if (outbox.length) scheduleFlush($, 30)
}

// Starts hearing about the room: the stream, or polls where it can't run.
function startFeed($: $) {
  const generation = ++pollGeneration
  pollFailures = 0
  stopStream()
  $.clock.after(0, () => void runStream($, generation))
}

function stopStream() {
  const child = feedStream
  feedStream = null
  streamUp = false
  if (child) void child.return(undefined as never).catch(() => {})
  wakeFeedWaiters()
}

function wakeFeedWaiters() {
  for (const done of [...feedWaiters]) done()
}

// One curl per connection, its address and token on stdin (not in argv, where
// other local users could read them). Ends when the room is gone, this run is
// replaced, or curl can't run at all; otherwise reconnects, backing off.
async function runStream($: $, generation: number) {
  let failures = 0
  while (generation === pollGeneration) {
    const room = await read($, roomA)
    if (!room || (await read($, modeA)) === 'idle') return
    if ((await $.env.get('SHARED_SESSION_TRANSPORT')) === 'poll') return void startPolls($, generation, 'SHARED_SESSION_TRANSPORT=poll')
    const config = [
      `url = "${room.server}/api/rooms/${room.id}/stream?after=${room.seq}"`,
      `header = "Authorization: Bearer ${room.token}"`,
      'header = "Accept: application/x-ndjson"',
      'no-buffer',
      'silent',
      'connect-timeout = 10',
      'write-out = "\\n{\\"httpStatus\\":%{http_code}}\\n"',
    ].join('\n')
    const child = $.process.spawn({ argv: ['curl', '-K', '-'], input: `${config}\n` })
    feedStream = child
    streamFloor = room.seq
    streamEnded = false
    streamed.length = 0
    let started = false
    let delivered = false
    let status = 0
    let refusal = ''
    let buffer = ''
    const opened = await $.clock.now()
    let lastLine = opened
    const watch = () => {
      if (feedStream !== child) return
      void $.clock.now().then(now => {
        if (feedStream !== child) return
        if (now - lastLine > STREAM_STALE_MS) stopStream()
        else $.clock.after(20_000, watch)
      })
    }
    $.clock.after(20_000, watch)
    try {
      for await (const chunk of child) {
        started = true
        if (generation !== pollGeneration) break
        if (chunk.stream === 'stderr') continue
        buffer += chunk.text
        let i: number
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).trim()
          buffer = buffer.slice(i + 1)
          if (!line) continue
          let message: Record<string, unknown>
          try {
            message = JSON.parse(line)
          } catch {
            continue
          }
          lastLine = await $.clock.now()
          if (typeof message.httpStatus === 'number') status = message.httpStatus
          else if (typeof message.error === 'string') refusal = message.error
          else if (Array.isArray(message.events)) {
            if (!streamUp && !delivered) $.ui.log('Shared session: listening on a stream', { to: 'debug' })
            streamUp = true
            delivered = true
            failures = 0
            await streamPage($, generation, message as unknown as EventsPage)
          }
        }
      }
    } catch {
      // The first pull rejects when curl can't start: poll instead.
      if (!started) {
        if (feedStream === child) feedStream = null
        if (generation === pollGeneration) startPolls($, generation, 'curl could not start')
        return
      }
    }
    if (feedStream === child) {
      feedStream = null
      streamUp = false
      wakeFeedWaiters()
    }
    if (generation !== pollGeneration) return
    if ([401, 404, 410].includes(status)) {
      // A server without streams answers the address itself with "Not found".
      if (status === 404 && refusal === 'Not found') return void startPolls($, generation, 'the server has no stream')
      const mode = await read($, modeA)
      await reset($)
      $.ui.log(mode === 'guest' ? `${room.host}'s session is no longer shared.` : 'Sharing ended.')
      return
    }
    // The server ends every stream after a few minutes: pick it up again at
    // once. One that never got going, or ended soon after, backs off, so a
    // proxy that cuts streams short is not hammered.
    if (delivered && (await $.clock.now()) - opened > 60_000) continue
    failures += 1
    await new Promise<void>(resolve => $.clock.after(Math.min(30_000, 500 * 2 ** failures), resolve))
  }
}

function startPolls($: $, generation: number, why: string) {
  $.ui.log(`Shared session: polling (${why})`, { to: 'debug' })
  void pollOnce($, generation)
}

// A line from the stream: what a poll would have answered.
async function streamPage($: $, generation: number, page: EventsPage) {
  const room = await read($, roomA)
  const mode = await read($, modeA)
  if (!room || mode === 'idle' || generation !== pollGeneration) return
  streamed.push(...page.events)
  if (streamed.length > 2000) {
    streamFloor = Math.max(streamFloor, streamed[streamed.length - 2001]?.seq ?? streamFloor)
    streamed.splice(0, streamed.length - 2000)
  }
  if (page.ended) streamEnded = true
  if (page.events.length > 0) lastActivity = await $.clock.now()
  await receive($, mode, room, page)
  wakeFeedWaiters()
}

// What a riding turn reads next: from the stream when it is up and reaches
// back far enough, else one short poll of its own.
async function ridePage($: $, room: ShareRoom, cursor: number): Promise<EventsPage> {
  if (streamUp && cursor >= streamFloor) {
    const after = () => streamed.filter(e => e.seq > cursor)
    if (after().length === 0 && !streamEnded) {
      await new Promise<void>(resolve => {
        const done = () => {
          feedWaiters.delete(done)
          resolve()
        }
        feedWaiters.add(done)
        $.clock.after(RIDE_WAIT_MS, done)
      })
    }
    const events = after()
    return { seq: Math.max(cursor, ...events.map(e => e.seq)), events, people: await read($, peopleA), ended: streamEnded, title: room.title }
  }
  return api<EventsPage>($, room.server, `/api/rooms/${room.id}/events?after=${cursor}&wait=${RIDE_WAIT_MS}`, { token: room.token })
}

// Without a stream: poll, fast while something is happening, then less and
// less often (well inside the server's 45 s grace for a seat).
function pollWait(now: number): number {
  const quiet = now - lastActivity
  if (localTurnActive) return POLL_IDLE_MS
  if (quiet < HOT_FOR_MS) return POLL_HOT_MS
  if (quiet < 2 * 60_000) return POLL_IDLE_MS
  if (quiet < 10 * 60_000) return 5_000
  return 15_000
}

// Something happened here: a quiet poller looks now instead of in 15 s.
function kickPoll($: $) {
  if (feedStream || streamUp || pollDelay < 5_000) return
  const generation = ++pollGeneration
  pollDelay = 0
  $.clock.after(0, () => void pollOnce($, generation))
}

async function pollOnce($: $, generation: number) {
  if (generation !== pollGeneration) return
  const room = await read($, roomA)
  const mode = await read($, modeA)
  if (!room || mode === 'idle') return
  try {
    const page = await api<EventsPage>($, room.server, `/api/rooms/${room.id}/events?after=${room.seq}&wait=0`, {
      token: room.token,
    })
    if (generation !== pollGeneration) return
    pollFailures = 0
    const now = await $.clock.now()
    if (page.events.length > 0 || (await read($, workingA))) lastActivity = now
    await receive($, mode, room, page)
    if (generation === pollGeneration && (await read($, modeA)) !== 'idle') {
      pollDelay = pollWait(now)
      $.clock.after(pollDelay, () => void pollOnce($, generation))
    }
  } catch (error) {
    if (generation !== pollGeneration) return
    if (isGone(error)) {
      await reset($)
      $.ui.log(mode === 'guest' ? `${room.host}'s session is no longer shared.` : 'Sharing ended.')
      return
    }
    pollFailures += 1
    pollDelay = Math.min(15_000, 500 * 2 ** pollFailures)
    $.clock.after(pollDelay, () => void pollOnce($, generation))
  }
}

// What an event adds to the room as people see it: the timeline, the side
// chat, the host's policy. `live` is false while a join replays history.
async function absorb($: $, room: ShareRoom, mode: ShareMode, event: ServerEvent, live: boolean) {
  const who = event.from.name
  const mine = mode === 'host' ? event.from.role === 'host' : event.from.seat === room.seat
  const body = event.body
  const note = (entry: ShareActivity) => update($, activityA, list => [...list, entry].slice(-80))
  switch (event.type) {
    case 'join':
      await note({ ts: event.ts, who, kind: 'join' })
      if (live && !mine) $.ui.log(`${who} joined`)
      break
    case 'leave':
      await note({ ts: event.ts, who, kind: 'leave' })
      if (live && !mine) $.ui.log(`${who} left`)
      break
    case 'prompt':
      if (typeof body.text === 'string') await note({ ts: event.ts, who, kind: 'prompt', text: body.text })
      if (live && !mine && mode === 'host') nudgeSidebar($)
      break
    case 'stop':
      await note({ ts: event.ts, who, kind: 'stop' })
      break
    case 'approval':
      if (body.pending === false && typeof body.what === 'string') {
        await note({ ts: event.ts, who: room.host, kind: body.allowed ? 'allowed' : 'denied', text: body.what })
      }
      break
    case 'chat':
      if (typeof body.text === 'string') {
        const line: ShareChat = { ts: event.ts, who, seat: event.from.seat, text: body.text }
        await update($, chatA, list => [...list, line].slice(-100))
        if (live && !mine && !roomOpen) {
          await update($, unreadA, n => n + 1)
          $.ui.toast(`${who}: ${body.text.slice(0, 120)}`)
          nudgeSidebar($)
        }
      }
      break
    case 'policy': {
      const prompts = body.prompts === 'watch' ? 'watch' : 'everyone'
      const approvals = body.approvals === 'all' || body.approvals === 'none' ? body.approvals : 'edits'
      await update($, policyA, () => ({ prompts, approvals }))
      await note({ ts: event.ts, who: room.host, kind: 'policy', text: describePolicy({ prompts, approvals }) })
      break
    }
  }
}

async function receive($: $, mode: ShareMode, room: ShareRoom, page: EventsPage) {
  await update($, peopleA, () => page.people)
  let seq = room.seq
  for (const event of page.events) {
    seq = Math.max(seq, event.seq)
    const body = event.body
    await absorb($, room, mode, event, true)
    switch (event.type) {
      case 'prompt':
        if (mode === 'host' && typeof body.text === 'string') {
          await acceptPrompt($, event.from.name, body.text, typeof body.pid === 'string' ? body.pid : '')
        }
        break
      case 'stop':
        if (mode === 'host') await stopTurn($, event.from.name)
        break
      case 'delta':
        if (mode === 'guest' && typeof body.text === 'string') {
          const text = body.text
          await update($, workingA, w => (w ? { ...w, tail: `${w.tail}${text}`.slice(-TAIL_CHARS) } : w))
        }
        break
      case 'turn':
        if (mode !== 'guest') break
        if (body.state === 'start') {
          const turn = noteHostTurn(event)
          await update($, workingA, () => ({
            turnId: turn.turnId,
            by: turn.by,
            byGuest: turn.by !== room.host,
            startedAt: event.ts,
            tail: '',
            waitingFor: null,
          }))
        } else {
          await update($, workingA, w => (w?.turnId === body.turnId ? null : w))
        }
        break
      case 'approval':
        if (mode === 'guest') {
          const what = body.pending && typeof body.what === 'string' ? body.what : null
          await update($, workingA, w => (w ? { ...w, waitingFor: what } : w))
        }
        break
      case 'title':
        if (typeof body.title === 'string') {
          const title = body.title
          await update($, roomA, r => (r ? { ...r, title } : r))
        }
        break
      case 'ended':
        if (mode === 'guest') {
          await reset($)
          $.ui.log(`${room.host} stopped sharing this session.`)
          return
        }
        break
    }
  }
  await update($, roomA, r => (r && r.id === room.id ? { ...r, seq: Math.max(r.seq, seq) } : r))
  if (mode === 'guest') scheduleRides($)
}

async function reset($: $) {
  // The sidebar row first, while the room is still known: the host's title
  // comes back; a guest's says whose session it was.
  const was = await read($, roomA)
  const wasMode = await read($, modeA)
  await unmarkSidebar($, wasMode === 'guest' && was ? `${was.host}'s session · ${was.title}`.slice(0, 120) : undefined)
  pollGeneration += 1
  stopStream()
  outbox = []
  hostTurns.length = 0
  ownPending.clear()
  ridesByText.clear()
  pendingGuestPrompts.length = 0
  await update($, modeA, () => 'idle')
  await update($, roomA, () => null)
  await update($, peopleA, () => [])
  await update($, workingA, () => null)
  await update($, activityA, () => [])
  await update($, chatA, () => [])
  await update($, unreadA, () => 0)
  await update($, policyA, () => DEFAULT_POLICY)
  await update($, trustedA, () => [])
  await update($, ownersA, () => ({}))
}

async function whoami($: $): Promise<string> {
  if (myName) return myName
  try {
    const git = await $.process.run(['git', 'config', 'user.name'], { timeoutMs: 3000 })
    const name = git.stdout.trim()
    if (git.exitCode === 0 && name) return (myName = name)
  } catch {}
  return (myName = (await $.env.get('USER')) || 'teammate')
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
}

function describePolicy(policy: SharePolicy): string {
  const prompts = policy.prompts === 'watch' ? 'watch-only' : 'everyone can prompt'
  const approvals =
    policy.approvals === 'none' ? 'no approvals' : policy.approvals === 'all' ? 'every tool needs approval' : 'edits and commands need approval'
  return `${prompts}, ${approvals}`
}

// ---------------------------------------------------------------------------
// Claude Desktop's sidebar, through the MCP tools the app attaches to every
// session it runs (`ccd_session_mgmt`, `ccd_sidebar`): a live session gets a
// "👥" title and a pin while it is shared, and a blue dot when teammates talk.
// Elsewhere (a terminal, a headless run) the servers are absent: no-ops.

type DeskServer = 'ccd_session_mgmt' | 'ccd_sidebar'

async function desk($: $, server: DeskServer, tool: string, args: Record<string, unknown>) {
  try {
    const result = await $.mcp.call(server, tool, args)
    const text = result.content.map(block => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('')
    if (result.isError) {
      $.ui.log(`${server}.${tool}: ${text.slice(0, 200)}`, { to: 'debug' })
      return null
    }
    return text
  } catch (error) {
    $.ui.log(`${server}.${tool} unavailable: ${String((error as Error)?.message ?? error).slice(0, 200)}`, { to: 'debug' })
    return null
  }
}

// Marks this session's row: retitles it (keeping what it was) and pins it.
async function markSidebar($: $, title: (current: string) => string) {
  const raw = await desk($, 'ccd_session_mgmt', 'get_session', { session_id: 'self' })
  if (raw === null) return
  let info: { title?: unknown; pinned?: unknown } = {}
  try {
    info = JSON.parse(raw)
  } catch {}
  const current = typeof info.title === 'string' ? info.title : ''
  const pinned = info.pinned === true
  if (!(await read($, sidebarA))) await update($, sidebarA, () => ({ title: current, pinned }))
  await desk($, 'ccd_session_mgmt', 'set_session_title', { session_id: 'self', title: title(current).slice(0, 120) })
  if (!pinned) await desk($, 'ccd_sidebar', 'set_pinned', { session_id: 'self', pinned: true })
}

// Puts the row back: the title it had (or `title`), unpinned unless it was pinned.
async function unmarkSidebar($: $, title?: string) {
  const saved = await read($, sidebarA)
  if (!saved) return
  await update($, sidebarA, () => null)
  const restored = title ?? saved.title
  if (restored) await desk($, 'ccd_session_mgmt', 'set_session_title', { session_id: 'self', title: restored })
  if (!saved.pinned) await desk($, 'ccd_sidebar', 'set_pinned', { session_id: 'self', pinned: false })
}

function nudgeSidebar($: $) {
  void desk($, 'ccd_sidebar', 'set_unread', { session_id: 'self', unread: true })
}

// ---------------------------------------------------------------------------
// Host

async function share($: $, surface?: RenderSurface): Promise<ShareRoom> {
  const mode = await read($, modeA)
  if (mode === 'guest') throw new Error('Leave the session you joined before sharing this one.')
  const existing = await read($, roomA)
  if (mode === 'host' && existing) {
    await copyLink($, existing.url, surface)
    return existing
  }

  const server = await serverOf($)
  const name = await whoami($)
  const cwd = await $.session.cwd()
  const history = await $.session.messages({ as: 'api' })
  const messages = Array.isArray(history) ? history : []
  const firstPrompt = messages.flatMap(m => rowsFromMessage(m, name, cwd)).find(row => row.kind === 'user')?.text
  const folder = cwd.split('/').filter(Boolean).at(-1) ?? 'session'
  const title = firstPrompt ? `${folder}: ${(firstPrompt.split('\n')[0] ?? '').slice(0, 80)}` : folder

  const created = await api<{ id: string; url: string; token: string; seq: number; title: string }>(
    $,
    server,
    '/api/rooms',
    { method: 'POST', body: { name, title } },
  )
  const room: ShareRoom = {
    server,
    id: created.id,
    url: created.url,
    title: created.title,
    host: name,
    token: created.token,
    seat: 'host',
    seq: created.seq,
    since: await $.clock.now(),
  }
  await update($, roomA, () => room)
  await update($, modeA, () => 'host')
  await update($, peopleA, () => [{ id: 'host', name, role: 'host', online: true }])

  // What happened before Share, so people who join see the whole session.
  for (const message of messages) {
    for (const row of rowsFromMessage(message, name, cwd)) send($, 'row', row)
  }
  startFeed($)
  await copyLink($, room.url, surface)
  await markSidebar($, current => `👥 Live · ${current || room.title}`)
  return room
}

async function copyLink($: $, url: string, surface?: RenderSurface) {
  const copied = await $.ui.copy({ text: url, surface }).catch(() => ({ isCopied: false }))
  $.ui.toast(copied.isCopied ? 'Share link copied' : 'Shared: the link is in the transcript')
  $.ui.log(`Shared. Anyone with this link can join and talk to this session: ${url}`)
}

async function stopSharing($: $) {
  const room = await read($, roomA)
  await reset($)
  if (room) {
    await api($, room.server, `/api/rooms/${room.id}/end`, { method: 'POST', token: room.token }).catch(() => {})
    $.ui.log('Stopped sharing. The link no longer works.')
  }
}

async function setPolicy($: $, change: Partial<SharePolicy>) {
  const policy = { ...(await read($, policyA)), ...change }
  await update($, policyA, () => policy)
  send($, 'policy', policy)
}

async function acceptPrompt($: $, who: string, text: string, pid: string) {
  if ((await read($, policyA)).prompts === 'watch') {
    send($, 'declined', { pid, who, reason: 'This session is watch-only right now. Chat in the Room panel.' })
    return
  }
  const framed = `${who}: ${text}`
  pendingGuestPrompts.push({ who, framed, text, pid })
  // Runs once the session is idle, after any turn already running.
  submitLater($, framed)
}

async function stopTurn($: $, who: string) {
  const working = await read($, workingA)
  if (!working) return
  try {
    await $.turn.abort({ turnId: working.turnId })
    $.ui.toast(`${who} stopped the turn`)
  } catch {}
}

// What the approval dialog previews: the command, the diff, the new file.
function approvalPreview(tool: string, input: unknown, cwd: string): string {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const rel = (p: unknown) => (typeof p === 'string' && cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : str(p))
  const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body.split('\n').slice(0, 40).join('\n')}\n\`\`\``
  switch (tool) {
    case 'Bash':
      return `${fence('bash', str(i.command))}\n\nin \`${cwd}\``
    case 'Edit': {
      const minus = str(i.old_string).split('\n').map(l => `- ${l}`)
      const plus = str(i.new_string).split('\n').map(l => `+ ${l}`)
      return `\`${rel(i.file_path)}\`\n\n${fence('diff', [...minus, ...plus].join('\n'))}`
    }
    case 'Write':
      return `New file \`${rel(i.file_path)}\`\n\n${fence('', str(i.content))}`
    case 'WebFetch':
      return `Fetch ${str(i.url)}`
    default:
      return fence('json', JSON.stringify(input ?? {}, null, 2))
  }
}

// ---------------------------------------------------------------------------
// Guest

async function join($: $, server: string, id: string) {
  const name = await whoami($)
  const joined = await api<{
    token: string
    seat: string
    title: string
    host: string
    seq: number
    history: ServerEvent[]
    people: SharePerson[]
  }>($, server, `/api/rooms/${id}/join`, { method: 'POST', body: { name } })
  const room: ShareRoom = {
    server,
    id,
    url: `${server}/s/${id}`,
    title: joined.title,
    host: joined.host,
    token: joined.token,
    seat: joined.seat,
    seq: joined.seq,
    since: await $.clock.now(),
  }
  await update($, roomA, () => room)
  await update($, modeA, () => 'guest')
  await update($, peopleA, () => joined.people)
  await update($, workingA, () => null)
  // The room as it stands: its timeline, its chat, the host's policy.
  for (const event of joined.history) await absorb($, room, 'guest', event, false)

  // A turn still running on the host plays out live; everything before it is
  // shown as it was, one exchange per prompt.
  const starts = joined.history.filter(e => e.type === 'turn' && e.body.state === 'start')
  const ends = new Set(joined.history.filter(e => e.type === 'turn' && e.body.state === 'end').map(e => e.body.turnId))
  const running = starts.filter(e => !ends.has(e.body.turnId)).at(-1)
  const past = joined.history.filter(e => e.type === 'row' && (!running || e.seq < running.seq))
  if (running) noteHostTurn(running)
  startFeed($)
  await markSidebar($, () => `👥 ${room.host} · ${room.title}`)
  return { room, history: exchanges(past.map(e => e.body as unknown as Row), joined.host) }
}

// Groups rows into prompt + reply exchanges.
function exchanges(rows: Row[], host: string): Exchange[] {
  const out: Exchange[] = []
  for (const row of rows) {
    if (row.kind === 'user') out.push({ prompt: `${row.who ?? host}: ${row.text}`, rows: [] })
    else if (out.length === 0) out.push({ prompt: `${host}: (earlier)`, rows: [row] })
    else out.at(-1)!.rows.push(row)
  }
  return out
}

function noteHostTurn(event: ServerEvent): HostTurn {
  const turnId = String(event.body.turnId ?? '')
  const known = hostTurns.find(t => t.turnId === turnId)
  if (known) return known
  const turn: HostTurn = {
    turnId,
    by: typeof event.body.by === 'string' ? event.body.by : 'host',
    prompt: typeof event.body.prompt === 'string' ? event.body.prompt : '',
    pid: typeof event.body.pid === 'string' && event.body.pid ? event.body.pid : undefined,
    startSeq: event.seq - 1,
    shown: false,
    claimed: false,
  }
  hostTurns.push(turn)
  if (hostTurns.length > 200) hostTurns.splice(0, hostTurns.length - 200)
  return turn
}

function queueRide($: $, text: string, ride: Ride) {
  const list = ridesByText.get(text) ?? []
  list.push(ride)
  ridesByText.set(text, list)
  submitLater($, text)
}

// A prompt submitted from inside another hook's dispatch is refused, so every
// prompt this plugin starts goes out from a timer of its own.
function submitLater($: $, text: string) {
  $.clock.after(0, () => {
    void $.prompt.submit({ text, asUser: true }).catch(error => {
      $.ui.log(`prompt.submit refused: ${String(error?.message ?? error)}`, { to: 'debug' })
    })
  })
}

// Starts a local turn for the next host turn nobody here has shown yet. A
// prompt typed here that is still waiting shows the turns ahead of it itself.
function scheduleRides($: $) {
  if (localTurnActive || ownPending.size > 0) return
  const next = hostTurns.find(t => !t.shown && !t.claimed && !(t.pid && ownPending.has(t.pid)))
  if (!next) return
  next.claimed = true
  queueRide($, `${next.by}: ${next.prompt || '(continued)'}`, { kind: 'turn', turnId: next.turnId })
}

async function leave($: $) {
  const room = await read($, roomA)
  await reset($)
  if (room) {
    await api($, room.server, `/api/rooms/${room.id}/leave`, { method: 'POST', token: room.token }).catch(() => {})
    $.ui.log(`Left ${room.host}'s session.`)
  }
}

async function postChat($: $, text: string) {
  const line = text.trim()
  if (!line) return
  send($, 'chat', { text: line.slice(0, 2000) })
}

async function openRoom($: $) {
  roomOpen = true
  await update($, unreadA, () => 0)
  await $.ui.open({ id: ROOM, title: 'Shared session' })
}

// What one riding poll adds to the reply being shown.
type RideState = {
  current: HostTurn | null
  streamed: boolean
  done: boolean
}

// A file read's lines come numbered ("   12\tcode"); older hosts send them so.
function stripLineNumbers(text: string): string {
  return text.replace(/^ *\d+\t/gm, '')
}

function rideStep(ride: Ride, state: RideState, event: ServerEvent, host: string): string {
  const body = event.body
  if (event.type === 'ended') {
    state.done = true
    return `\n\n_${host} stopped sharing this session._`
  }
  if (event.type === 'declined' && ride.kind === 'own' && body.pid === ride.pid) {
    ownPending.delete(ride.pid)
    state.done = true
    return `_${typeof body.reason === 'string' ? body.reason : `${host} turned this prompt away.`}_`
  }
  if (event.type === 'turn' && body.state === 'start') {
    const turn = noteHostTurn(event)
    if (ride.kind === 'turn' && turn.turnId === ride.turnId && turn.shown) {
      // A prompt typed here already showed it.
      state.done = true
      return ''
    }
    if (turn.shown || (ride.kind === 'turn' && turn.turnId !== ride.turnId)) {
      state.current = null
      return ''
    }
    turn.shown = true
    turn.claimed = true
    state.current = turn
    state.streamed = false
    if (ride.kind === 'own' && turn.pid === ride.pid) {
      ownPending.delete(ride.pid)
      return ''
    }
    // Someone else's turn that ran ahead of the prompt typed here.
    return ride.kind === 'own' ? `**${turn.by}:** ${turn.prompt}\n\n` : ''
  }
  const current = state.current
  if (!current) return ''
  if (event.type === 'delta' && body.turnId === current.turnId && typeof body.text === 'string') {
    state.streamed = true
    return body.text
  }
  if (event.type === 'row') {
    const row = body as unknown as Row
    if (row.kind === 'user') return ''
    if (row.kind === 'assistant') {
      // Its text already streamed as deltas, unless those were missed.
      const streamed = state.streamed
      state.streamed = false
      return streamed ? '\n\n' : `${row.text}\n\n`
    }
    state.streamed = false
    if (row.kind === 'tool') {
      const head = `\n\n${toolGlyph(row.tool ?? '')} **${row.tool}** ${row.text ? `\`${row.text.replaceAll('`', "'")}\`` : ''}\n`
      if (row.detail && (row.tool === 'Edit' || row.tool === 'Write')) {
        return `${head}\n\`\`\`${row.tool === 'Edit' ? 'diff' : ''}\n${row.detail}\n\`\`\`\n`
      }
      return head
    }
    if (row.kind === 'result') {
      return `  ⎿ ${row.isError ? '**Error:** ' : ''}${(stripLineNumbers(row.text).split('\n')[0] ?? '').slice(0, 200)}\n\n`
    }
  }
  if (event.type === 'approval' && body.pending && typeof body.what === 'string') {
    return `\n> ⏳ Waiting for **${host}** to allow \`${body.what}\`\n\n`
  }
  if (event.type === 'approval' && body.pending === false && typeof body.what === 'string') {
    return body.allowed ? `> ✓ ${host} allowed it\n\n` : `> ✕ ${host} declined it\n\n`
  }
  if (event.type === 'turn' && body.state === 'end' && body.turnId === current.turnId) {
    const mine = ride.kind === 'turn' || (ride.kind === 'own' && current.pid === ride.pid)
    state.current = null
    if (mine) state.done = true
    if (body.reason === 'error') return `\n\n> ✕ ${host}'s Claude couldn't finish this turn (an error on ${host}'s side).\n\n`
    if (body.reason === 'refusal') return `\n\n> ✕ ${host}'s Claude declined this request.\n\n`
    return body.aborted ? '\n\n_(stopped)_' : mine ? '' : '\n\n'
  }
  return ''
}

// ---------------------------------------------------------------------------
// What the room looks like, shared by the row above the prompt and the panel.

type View = {
  mode: ShareMode
  room: ShareRoom | null
  me: string // this seat's id
  everyone: SharePerson[]
  working: ShareWorking | null
  policy: SharePolicy
  unread: number
}

async function view($: $): Promise<View> {
  const room = await read($, roomA)
  return {
    mode: await read($, modeA),
    room,
    me: room?.seat ?? 'host',
    everyone: await read($, peopleA),
    working: await read($, workingA),
    policy: await read($, policyA),
    unread: await read($, unreadA),
  }
}

// One face per name (a person in two sessions is still one person).
function faces(v: View): Face[] {
  const seen = new Map<string, Face>()
  for (const p of v.everyone) {
    const known = seen.get(p.name)
    const note = [p.role === 'host' ? 'host' : '', p.id === v.me ? 'you' : '', p.online ? '' : 'away'].filter(Boolean).join(' · ')
    const face: Face = { name: p.name, online: p.online || Boolean(known?.online), note, active: v.working?.by === p.name }
    if (!known || (!known.online && p.online)) seen.set(p.name, face)
  }
  // The host first, then whoever is here; labels tell same-initial people apart.
  const labels = labelsFor([...seen.keys()])
  for (const face of seen.values()) face.label = labels.get(face.name)
  return [...seen.values()].sort((a, b) => Number(b.note?.includes('host')) - Number(a.note?.includes('host')) || Number(b.online) - Number(a.online))
}

function presence(v: View): string {
  const others = [...new Set(v.everyone.filter(p => p.online && p.role === 'guest' && p.id !== v.me).map(p => p.name))]
  if (v.mode === 'host') return others.length ? `with ${listNames(others)}` : 'waiting for people to join'
  const hostAway = !v.everyone.some(p => p.role === 'host' && p.online)
  return [others.length ? `with ${listNames(others)}` : '', hostAway ? `${v.room?.host} is away` : ''].filter(Boolean).join(' · ')
}

function statusLine(v: View): string | null {
  const host = v.room?.host ?? 'the host'
  const w = v.working
  if (v.mode === 'host') {
    if (w?.byGuest && w.waitingFor) return `⚠  ${w.by} is waiting for your OK on ${w.waitingFor}`
    if (w?.byGuest) return `◐  Claude is working for ${w.by}`
    if (v.policy.prompts === 'watch') return '◎  Watch-only: teammates follow along and chat'
    return null
  }
  if (w?.waitingFor) return `⏳  Waiting for ${host} to allow ${w.waitingFor}`
  if (w) return `◐  Claude is working for ${w.by === myName ? 'you' : w.by}`
  if (v.policy.prompts === 'watch') return `◎  ${host} set this session to watch-only. Chat in the Room panel.`
  return null
}

function describe(a: ShareActivity): string {
  switch (a.kind) {
    case 'join':
      return `${a.who} joined`
    case 'leave':
      return `${a.who} left`
    case 'prompt':
      return `${a.who} asked “${(a.text ?? '').replace(/\s+/g, ' ').slice(0, 70)}${(a.text ?? '').length > 70 ? '…' : ''}”`
    case 'allowed':
      return `${a.who} allowed ${a.text ?? 'a tool call'}`
    case 'denied':
      return `${a.who} declined ${a.text ?? 'a tool call'}`
    case 'stop':
      return `${a.who} stopped the turn`
    case 'policy':
      return `${a.who} set: ${a.text ?? ''}`
  }
}

const svgOf = (el: UI) => ('Svg' in el ? el.Svg : undefined)
// Fields and pickers: every surface but mobile draws them.
const inputOf = (el: UI) => ('Input' in el ? el.Input : undefined)
const selectOf = (el: UI) => ('Select' in el ? el.Select : undefined)

// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  configuredServer = typeof options.server === 'string' ? options.server : ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Not /share: Claude has its own. Every name here is the plugin's alone.
    await $.command.register({ name: 'share-session', description: 'Share this session: copies a link teammates join with' })
    await $.command.register({ name: 'stop-sharing', description: 'Stop sharing this session, or leave the one you joined' })
    await $.command.register({ name: 'room', description: 'Open the Room: who is here, activity, side chat' })
    // A reload keeps $.state: pick the room back up.
    const room = await read($, roomA)
    if (room && (await read($, modeA)) !== 'idle') startFeed($)
    return started
  })

  on('session.end', async ($, e, next) => {
    const mode = await read($, modeA)
    if (mode === 'host') await stopSharing($).catch(() => {})
    if (mode === 'guest') await leave($).catch(() => {})
    return next(e)
  })

  on('command.run', { command: 'share-session' }, async $ => {
    try {
      const room = await share($)
      return { text: `Sharing this session. Anyone with the link can join: ${room.url}` }
    } catch (error) {
      return { text: `Couldn't share: ${String((error as Error)?.message ?? error)}` }
    }
  })

  on('command.run', { command: 'room' }, async $ => {
    if ((await read($, modeA)) === 'idle') return { text: 'This session is not shared. Press Share above the prompt, or type /share-session.' }
    await openRoom($)
    return { text: 'Opened the Room.' }
  })

  on('command.run', { command: 'stop-sharing' }, async $ => {
    const mode = await read($, modeA)
    if (mode === 'host') await stopSharing($)
    else if (mode === 'guest') await leave($)
    return { text: mode === 'idle' ? 'This session is not shared.' : 'Done.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === ROOM) roomOpen = false
    return next(e)
  })

  // Pasting a share link joins it; typing in a guest session talks to the
  // shared one.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    const mode = await read($, modeA)
    const typed = typedText(e.text)
    const link = LINK.exec(typed)
    const answerWith = (note: Ride) => {
      const list = ridesByText.get(typed) ?? []
      list.push(note)
      ridesByText.set(typed, list)
      localTurnActive = true // nothing else plays out before this answer
    }
    if (link?.[1] && link[2] && mode !== 'host' && PERSON.has(e.origin.kind)) {
      // The link stays in the transcript as typed; the reply says what joining
      // did, then what happened before plays back, all without a model call.
      try {
        if (mode === 'guest') await leave($)
        const { room, history } = await join($, link[1], link[2])
        const policy = await read($, policyA)
        answerWith({
          kind: 'note',
          text: [
            `You're in **${room.host}**'s session.`,
            policy.prompts === 'watch'
              ? `It's watch-only for now: you'll see every turn live, and you can chat with everyone in the **Room** panel.`
              : `What you type here goes to it and runs on ${room.host}'s machine; everyone sees the replies live.`,
            `The **Room** panel (above the prompt, or \`/room\`) shows who's here and has a side chat Claude doesn't read. To leave, press **Leave**.`,
          ].join(' '),
          then: history,
        })
      } catch (error) {
        answerWith({ kind: 'note', text: `Couldn't join that shared session: ${String((error as Error)?.message ?? error)}`, then: [] })
      }
      return next(e)
    }
    if (mode === 'guest' && typed && !typed.startsWith('/')) {
      const room = await read($, roomA)
      if ((await read($, policyA)).prompts === 'watch') {
        answerWith({
          kind: 'note',
          text: `**${room?.host}** has this session on watch-only, so this didn't go to Claude. You can still follow every turn and talk to everyone in the **Room** panel.`,
          then: [],
        })
        return next(e)
      }
      const pid = newId()
      ownPending.add(pid)
      const list = ridesByText.get(typed) ?? []
      list.push({ kind: 'own', pid, fromSeq: room?.seq ?? 0 })
      ridesByText.set(typed, list)
      // Only what the person typed leaves this machine, never the host app's context.
      send($, 'prompt', { text: typed, pid })
    }
    lastActivity = await $.clock.now()
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const mode = await read($, modeA)
    if (mode !== 'host') {
      const ride = ridesByText.get(typedText(e.text))?.shift()
      if (ride) {
        ridesByTurn.set(e.turnId, ride)
        localTurnActive = true
      }
      return next(e)
    }
    const room = await read($, roomA)
    const index = pendingGuestPrompts.findIndex(p => e.text.includes(p.framed))
    const guest = index >= 0 ? pendingGuestPrompts.splice(index, 1)[0] : undefined
    const by = guest?.who ?? room?.host ?? 'host'
    const startedAt = await $.clock.now()
    await update($, workingA, () => ({ turnId: e.turnId, by, byGuest: Boolean(guest), startedAt, tail: '', waitingFor: null }))
    send($, 'turn', { state: 'start', turnId: e.turnId, by, prompt: guest?.text ?? typedText(e.text), pid: guest?.pid ?? '' })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const mode = await read($, modeA)
    if (mode === 'host') {
      await update($, workingA, w => (w?.turnId === e.turnId ? null : w))
      send($, 'turn', { state: 'end', turnId: e.turnId, aborted: e.isAborted, durationMs: e.durationMs, reason: e.reason })
    } else {
      const ride = ridesByTurn.get(e.turnId)
      if (ride) {
        ridesByTurn.delete(e.turnId)
        localTurnActive = false
        if (ride.kind === 'note' && mode === 'guest') {
          for (const exchange of ride.then) queueRide($, exchange.prompt, { kind: 'static', rows: exchange.rows })
        }
        if (mode === 'guest') scheduleRides($)
      }
    }
    return next(e)
  })

  // Host: live text for guests while Claude writes.
  // Guest: a turn that shows a host turn answers from the room, not a model.
  on('turn.step', async function* ($, e, next) {
    const ride = e.agentId === undefined ? ridesByTurn.get(e.turnId) : undefined
    const mode = await read($, modeA)

    if (ride && e.index === 0) {
      const room = await read($, roomA)
      let answer = ''
      if (ride.kind === 'static' || ride.kind === 'note') {
        answer = ride.kind === 'note' ? ride.text : rowsToMarkdown(ride.rows) || '(no reply)'
        yield { kind: 'text', index: 0, text: answer } satisfies TurnStepChunk
      } else if (room) {
        const state: RideState = { current: null, streamed: false, done: false }
        // Esc here stops the shared turn. The engine stops reading this stream
        // on an interrupt, so the stop goes out from the abort itself.
        const onAbort = () => {
          if (state.current && !state.done) send($, 'stop', {})
        }
        next.signal.addEventListener('abort', onAbort, { once: true })
        let cursor =
          ride.kind === 'turn'
            ? (hostTurns.find(t => t.turnId === ride.turnId)?.startSeq ?? room.seq)
            : Math.min(ride.fromSeq, ...hostTurns.filter(t => !t.shown).map(t => t.startSeq))
        while (!state.done && !next.signal.aborted) {
          let page: EventsPage
          try {
            page = await ridePage($, room, cursor)
          } catch (error) {
            if (isGone(error)) break
            continue
          }
          for (const event of page.events) {
            cursor = Math.max(cursor, event.seq)
            const piece = rideStep(ride, state, event, room.host)
            if (piece) {
              answer += piece
              yield { kind: 'text', index: 0, text: piece } satisfies TurnStepChunk
            }
            if (state.done) break
          }
          if (page.ended) state.done = true
        }
        next.signal.removeEventListener('abort', onAbort)
      }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null } satisfies TurnStepChunk
      return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
    }

    const stream = next(e)
    if (e.agentId !== undefined || mode !== 'host') return yield* stream
    for await (const chunk of stream) {
      if (chunk.kind === 'text' && chunk.text) send($, 'delta', { turnId: e.turnId, text: chunk.text })
      yield chunk
    }
    return await stream.result
  })

  // Host: every row the conversation keeps goes to the room.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId !== undefined || (await read($, modeA)) !== 'host') return stored
    const room = await read($, roomA)
    const host = room?.host ?? 'host'
    const fromGuest = e.origin.kind === 'plugin' && 'name' in e.origin && e.origin.name === PLUGIN
    const typed = fromGuest || ['composer', 'sdk', 'bridge', 'unclassified'].includes(e.origin.kind)
    const cwd = await $.session.cwd()
    for (const row of rowsFromMessage(stored.message ?? e.message, typed ? host : null, cwd)) {
      // A guest's prompt reached the model as "Name: text"; show it as theirs.
      const spoken = fromGuest && row.kind === 'user' ? splitSpeaker(row.text) : null
      send($, 'row', spoken ? { ...row, who: spoken.who, text: spoken.text } : row)
    }
    return stored
  })

  // Host: remember whose turn each tool call ran for, so its row can say so.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined && (await read($, modeA)) === 'host') {
      const working = await read($, workingA)
      if (working?.byGuest) {
        const who = working.by
        await update($, ownersA, owners => {
          const entries = Object.entries({ ...owners, [e.tool_use_id]: who })
          return Object.fromEntries(entries.slice(-300))
        })
      }
    }
    return next(e)
  })

  // Host: a guest's prompt runs tools on this machine. What the host's policy
  // names asks first (edits, commands and the web by default), whatever the
  // permission mode; "Always allow" trusts that person for the session.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (!e.tool_use_id || verdict.decision === 'deny') return verdict
    if ((await read($, modeA)) !== 'host') return verdict
    const working = await read($, workingA)
    if (!working?.byGuest) return verdict
    const policy = await read($, policyA)
    if (policy.approvals === 'none') return verdict
    if (policy.approvals === 'edits' && READ_ONLY.has(e.tool)) return verdict
    // "Always allow" is the host's answer for this person's later calls too, so
    // it settles them the way "Allow once" settles one, not back to the host's
    // own permission prompt.
    if ((await read($, trustedA)).includes(working.by)) {
      const room = await read($, roomA)
      return { decision: 'allow', reason: `${room?.host ?? 'The host'} always allows ${working.by}` }
    }

    const cwd = await $.session.cwd()
    const { text } = summarizeTool(e.tool, e.input, cwd)
    const what = `${e.tool}${text ? ` ${text}` : ''}`
    const always = `Always allow ${working.by}`.slice(0, 40)
    send($, 'approval', { pending: true, what })
    await update($, workingA, w => (w ? { ...w, waitingFor: what } : w))
    pendingAsk = {
      who: working.by,
      preview: approvalPreview(e.tool, e.input, cwd),
      descriptions: {
        'Allow once': `Run this one ${e.tool} call for ${working.by}.`,
        [always]: `Don't ask again for ${working.by}'s requests while this session is shared.`,
        Deny: `Claude is told you declined and carries on without it.`,
      },
    }
    let answer = 'Deny'
    try {
      answer = await $.ui.ask(`${working.by} wants Claude to run ${what.slice(0, 200)}. Allow it?`, {
        header: ASK_HEADER,
        options: ['Allow once', always, 'Deny'],
      })
    } catch {}
    pendingAsk = null
    const allowed = answer === 'Allow once' || answer === always
    if (answer === always) await update($, trustedA, list => [...new Set([...list, working.by])])
    send($, 'approval', { pending: false, what, allowed, by: working.by })
    await update($, workingA, w => (w ? { ...w, waitingFor: null } : w))
    const room = await read($, roomA)
    const host = room?.host ?? 'The host'
    return allowed
      ? { decision: 'allow', reason: `${host} allowed it` }
      : { decision: 'deny', reason: `${host} did not allow this ${e.tool} call from the shared session.` }
  })

  // -------------------------------------------------------------------------
  // Drawing

  // A teammate's prompt, here as the plugin submitted it ("Sam: text"): their
  // face and name over their words.
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'plugin' } } }, async ($, e, next) => {
    const origin = e.props.origin
    if (!('name' in origin) || origin.name !== PLUGIN) return next(e)
    const spoken = splitSpeaker(typedText(e.props.text))
    if (!spoken) return next(e)
    const el = $.ui.resolve(e)
    const { Box, Text, Markdown } = el
    const Svg = svgOf(el)
    return (
      <Box flexDirection="row" gap={1}>
        {Svg ? (
          <Svg source={avatarSvg({ name: spoken.who, online: true }, 24)} alt={spoken.who} width={24} height={24} />
        ) : (
          <Text>●</Text>
        )}
        <Box flexDirection="column" flexShrink={1}>
          <Text bold>{spoken.who}</Text>
          <Markdown key="said" text={spoken.text} />
        </Box>
      </Box>
    )
  })

  // Host: a tool call Claude made for a teammate says for whom.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if ((await read($, modeA)) !== 'host') return next(e)
    const who = (await read($, ownersA))[e.props.tool_use_id]
    if (!who) return next(e)
    const drawn = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        <Box flexDirection="row" gap={1} paddingLeft={2}>
          <Text color={ACCENT}>↳</Text>
          <Text dimColor>for</Text>
          <Text bold>{who}</Text>
        </Box>
      </Box>
    )
  })

  // Host: the approval question previews exactly what would run.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const ask = pendingAsk
    const questions = e.props.questions as { header?: string; options?: { label: string; description?: string }[] }[]
    const first = questions[0]
    if (!ask || first?.header !== ASK_HEADER || !first.options) return next(e)
    const options = first.options.map(o => ({ ...o, description: ask.descriptions[o.label] ?? o.description ?? '', preview: ask.preview }))
    return next({ ...e, props: { ...e.props, questions: [{ ...first, options }, ...questions.slice(1)] } })
  })

  // The footer's labels: shared, and with whom.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const v = await view($)
    if (v.mode === 'idle') return next(e)
    const here = presence(v)
    const label = v.mode === 'host' ? `shared${here.startsWith('with') ? ` ${here}` : ''}` : `in ${v.room?.host}'s session${here ? ` ${here.startsWith('with') ? here : `· ${here}`}` : ''}`
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  })

  // The working line says whose turn it is, and what it waits on.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const v = await view($)
    const host = v.room?.host
    const w = v.working
    let message: string | null = null
    if (v.mode === 'host' && w?.byGuest) message = w.waitingFor ? `Waiting for your OK to run ${w.waitingFor}` : `Working for ${w.by}`
    if (v.mode === 'guest') {
      if (w?.waitingFor) message = `Waiting for ${host} to allow ${w.waitingFor}`
      else if (w) message = w.by === myName ? `Working on your prompt in ${host}'s session` : `Working for ${w.by}`
      else message = `Waiting for ${host}'s session`
    }
    return message ? next({ ...e, props: { ...e.props, message } }) : next(e)
  })

  // A guest's hint line says where typing goes.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const v = await view($)
    if (v.mode !== 'guest') return next(e)
    const hint =
      v.policy.prompts === 'watch'
        ? `Watch-only · chat in the Room (/room) · Leave anytime`
        : `↵ sends to ${v.room?.host}'s session · Esc stops the turn · /room opens the Room`
    return next({ ...e, props: { ...e.props, hint } })
  })

  // The Room: who's here, what happened, the side chat, and the host's controls.
  on('ui.render', { component: 'Pane', requestId: ROOM }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text, Button, Link } = el
    const Svg = svgOf(el)
    const Input = inputOf(el)
    const Select = selectOf(el)
    const v = await view($)
    const room = v.room
    if (v.mode === 'idle' || !room) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>This session is not shared.</Text>
          <Button
            key="room-share"
            label="Share this session"
            variant="primary"
            onPress={press => void share($, press.surface).catch(error => $.ui.log(`Couldn't share: ${String(error?.message ?? error)}`))}
          />
        </Box>
      )
    }
    const now = await $.clock.now()
    const activity = await read($, activityA)
    const chat = await read($, chatA)
    const trusted = await read($, trustedA)
    const people = faces(v)
    const online = people.filter(p => p.online).length
    const isHost = v.mode === 'host'
    const section = (title: string) => (
      <Text bold dimColor>
        {title}
      </Text>
    )
    const joinedAt = (name: string) => activity.find(a => a.kind === 'join' && a.who === name)?.ts
    const prompts = (name: string) => activity.filter(a => a.kind === 'prompt' && a.who === name).length

    return (
      <Box flexDirection="column" gap={1}>
        {Svg ? (
          <Svg
            source={bannerSvg({
              title: room.title,
              host: room.host,
              live: true,
              detail: `${isHost ? 'You are sharing this session' : `Hosted by ${room.host}`} · ${online} here`,
            })}
            alt={`${room.title}, hosted by ${room.host}, live`}
          />
        ) : (
          <Box flexDirection="column">
            <Text bold>{`● LIVE  ${room.title}`}</Text>
            <Text dimColor>{`${isHost ? 'You are sharing' : `Hosted by ${room.host}`} · ${online} here · ${describePolicy(v.policy)}`}</Text>
          </Box>
        )}

        <Text dimColor>{`${v.policy.prompts === 'watch' ? '◎ Watch-only' : '✎ Everyone can prompt'} · ${
          v.policy.approvals === 'none' ? 'no approvals' : v.policy.approvals === 'all' ? 'every tool asks the host' : 'edits and commands ask the host'
        }`}</Text>

        <Box flexDirection="row" gap={1} alignItems="center">
          <Text dimColor wrap="truncate-middle">
            {room.url}
          </Text>
          <Button key="room-copy" label="Copy link" onPress={press => void copyLink($, room.url, press.surface)} />
          {/^(https:|http:\/\/(localhost|127\.0\.0\.1)(:|\/))/.test(room.url) ? <Link href={room.url} label="Open page" /> : null}
        </Box>

        <Box flexDirection="column">
          {section(`PEOPLE · ${online}`)}
          {people.map(p => {
            const joined = joinedAt(p.name)
            const asked = prompts(p.name)
            return (
              <Box key={`person-${p.name}`} flexDirection="row" gap={1} alignItems="center">
                {Svg ? (
                  <Svg source={avatarSvg(p, 24)} alt={p.name} width={24} height={24} />
                ) : (
                  <Text dimColor={!p.online}>{p.online ? '●' : '○'}</Text>
                )}
                <Text bold={p.online} dimColor={!p.online}>
                  {p.name}
                </Text>
                <Text dimColor>
                  {[p.note, p.active ? (v.working?.waitingFor ? 'waiting for approval' : 'Claude is working for them') : '']
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
                <Box position="absolute" top={-1} left={6} display="none" hover={{ display: 'flex' }} paddingX={1} backgroundColor="#011121">
                  <Text color="#faf8f7">
                    {[
                      p.note?.includes('host') ? 'hosting' : joined ? `joined ${ago(joined, now)}` : 'here',
                      asked ? `${asked} prompt${asked === 1 ? '' : 's'}` : 'no prompts yet',
                      trusted.includes(p.name) ? 'trusted' : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </Box>
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="column">
          {section('ACTIVITY')}
          {activity.length === 0 ? <Text dimColor>Nothing yet.</Text> : null}
          {activity
            .slice(-8)
            .reverse()
            .map((a, i) => (
              <Box key={`act-${a.ts}-${i}`} flexDirection="row" gap={1}>
                {a.kind === 'allowed' || a.kind === 'denied' ? (
                  <Text color={a.kind === 'allowed' ? GOOD : BAD}>{a.kind === 'allowed' ? '✓' : '✕'}</Text>
                ) : (
                  <Text dimColor={a.kind === 'leave'}>{a.kind === 'leave' ? '○' : '●'}</Text>
                )}
                <Text dimColor>{ago(a.ts, now).padEnd(8)}</Text>
                <Text wrap="truncate-end">{describe(a)}</Text>
              </Box>
            ))}
        </Box>

        <Box flexDirection="column" gap={0}>
          {section('CHAT · Claude never sees this')}
          {chat.length === 0 ? <Text dimColor>Say hi. Messages here go to people, not to Claude.</Text> : null}
          {chat.slice(-12).map((c, i) => (
            <Box key={`chat-${c.ts}-${i}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text bold>{c.seat === v.me ? 'You' : c.who}</Text>
                <Text dimColor>{ago(c.ts, now)}</Text>
              </Box>
              <Text>{c.text}</Text>
            </Box>
          ))}
          {Input ? (
            <Input
              key={`chat-input-${chat.length}`}
              placeholder="Message everyone…"
              submitLabel="Send"
              onSubmit={(value: string) => void postChat($, value)}
            />
          ) : (
            <Text dimColor>Chat from Claude Code on desktop or in a terminal.</Text>
          )}
        </Box>

        {isHost ? (
          <Box flexDirection="column" gap={1}>
            {section('HOST CONTROLS')}
            {Select ? (
              <Select
              key="policy-prompts"
              label="Teammates can"
              value={v.policy.prompts}
              options={[
                { value: 'everyone', label: 'Prompt Claude' },
                { value: 'watch', label: 'Only watch and chat' },
              ]}
              onSelect={(value: string) => void setPolicy($, { prompts: value === 'watch' ? 'watch' : 'everyone' })}
            />
            ) : null}
            {Select ? (
              <Select
              key="policy-approvals"
              label="Ask me before a teammate's request runs"
              value={v.policy.approvals}
              options={[
                { value: 'edits', label: 'Edits, commands and web (recommended)' },
                { value: 'all', label: 'Every tool, reads included' },
                { value: 'none', label: 'Nothing: I trust everyone here' },
              ]}
              onSelect={(value: string) => void setPolicy($, { approvals: value === 'all' || value === 'none' ? value : 'edits' })}
            />
            ) : null}
            {trusted.length ? (
              <Box flexDirection="row" gap={1} alignItems="center">
                <Text dimColor>{`Always allowed: ${listNames(trusted)}`}</Text>
                <Button key="untrust" label="Ask again" plain onPress={() => void update($, trustedA, () => [])} />
              </Box>
            ) : null}
            <Button key="room-stop" label="Stop sharing" variant="primary" onPress={() => void stopSharing($)} />
          </Box>
        ) : (
          <Button key="room-leave" label={`Leave ${room.host}'s session`} variant="primary" onPress={() => void leave($)} />
        )}
      </Box>
    )
  })

  // The row above the prompt: the room at a glance, and its buttons.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
    const Svg = svgOf(el)
    const v = await view($)

    if (v.mode === 'idle') {
      return (
        <Box flexDirection="row" justifyContent="flex-end">
          <Button
            key="share"
            label="Share"
            plain
            dimColor
            onPress={press => {
              void share($, press.surface).catch(error => {
                $.ui.toast("Couldn't share")
                $.ui.log(`Couldn't share: ${String(error?.message ?? error)}`)
              })
            }}
          />
        </Box>
      )
    }

    const people = faces(v)
    const stack = stackSvg(people, { live: true, size: 24, max: 6 })
    const status = statusLine(v)
    const here = presence(v)
    const roomLabel = v.unread ? `Room · ${v.unread} new` : `Room · ${people.filter(p => p.online).length}`

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1}>
            {Svg ? (
              <Svg source={stack.source} alt={`Live with ${people.map(p => p.name).join(', ')}`} width={stack.width} height={24} />
            ) : (
              <Box flexDirection="row">
                <Text color={ROSE}>● </Text>
                {people.map(p => (
                  <Text dimColor={!p.online}>{p.online ? '●' : '○'}</Text>
                ))}
              </Box>
            )}
            <Text bold>{v.mode === 'host' ? 'Shared' : `${v.room?.host}'s session`}</Text>
            {here ? (
              <Text dimColor wrap="truncate-end">
                {here}
              </Text>
            ) : null}
          </Box>
          <Box flexDirection="row" gap={1}>
            <Button key="room" label={roomLabel} plain dimColor={!v.unread} onPress={() => void openRoom($)} />
            {v.mode === 'host' ? (
              <Button key="copy" label="Copy link" plain dimColor onPress={press => void (v.room ? copyLink($, v.room.url, press.surface) : undefined)} />
            ) : null}
            {v.mode === 'host' ? (
              <Button key="stop-sharing" label="Stop sharing" plain dimColor onPress={() => void stopSharing($)} />
            ) : (
              <Button key="leave" label="Leave" plain dimColor onPress={() => void leave($)} />
            )}
          </Box>
        </Box>
        {status ? (
          <Text dimColor wrap="truncate-end">
            {status}
          </Text>
        ) : null}
      </Box>
    )
  })
}

// One person in several sessions is still one name.
function listNames(all: string[]): string {
  const names = [...new Set(all)]
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}
