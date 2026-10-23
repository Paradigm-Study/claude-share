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

import { atom, memberOf, read, update } from 'claude-code'
import type { Elements, EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, RenderChildren, RenderSurface, Timer, TurnStepChunk } from 'claude-code'

import type { HostShare, ShareAccount, ShareActivity, ShareChange, ShareChat, ShareCloud, ShareCloudAsk, ShareDoing, ShareFileMeta, ShareGuestPrompt, ShareHostAsk, ShareHostMemory, ShareInvite, ShareLocalPreview, ShareMailboxHelper, ShareMode, ShareNeedAsked, ShareOwner, SharePeerRelay, SharePeerRoute, SharePeerSend, SharePerson, SharePolicy, SharePrefs, SharePreviewWindow, ShareRoom, ShareShown, ShareTeam, ShareTeams, ShareTeamSession, ShareTrust, ShareTurn, ShareWorking } from '../types'
import { fit, isModern } from './fit'
import { BAD, GOOD, ago, avatarSvg, cloverSvg, colorFor, colorsFor, labelsFor, liveSvg, stackSvg, toolGlyph } from './look'
import { REACTS, diffOf, mentionsOf, patchOf, replyKey, took, writeOf } from './room'
import type { Patch } from './room'
import type { Face } from './look'
import { attachmentsOf, delivered, neutralize, PEER_ID, rowsFromMessage, rowsToMarkdown, splitSpeaker, summarizeTool } from './rows'
import type { Media, RoomImage, Row } from './rows'
import { SERVER_URL } from './server'
import { readTargets, realInside } from './paths'
import { browserFamily, browserName, chromeFlags, chromePrefs, chromePrefsScript, detectScript, FIREFOX_MIN, FIREFOX_PATH_MAX, firefoxFlags, firefoxProfileScript, gcScript, hostProfileName, killScript, LAUNCH_LOCK_BUSY, launchArgv, launchLockScript, launchUnlockScript, lockScript, parseDetect, profileName, profileScript, proxyLine, trashScript, windowOf } from './window'
import type { BrowserFamily, BrowserFound, WindowPlatform } from './window'
import { upstreamFromEnv, upstreamFromScutil } from './upstream'
import type { Upstream } from './upstream'
import { ASK_PORTS, alsoUses, cleanLabel, dependencyFor, dependencyOf, dependencyTitle, discoverResult, everyName, everyService, heldResult, pageLook, previewHost, previewScheme, previewUrl, questionsOf, relayedResult, rootMissing, serviceName, servicesOf, shareTooWords, urlHost, urlScheme } from './preview'
import type { Discovered, DiscoveredService, PageLook, PreviewHost } from './preview'
import { curlString, localHeaders, pageHead, PROXY_FETCH_MAX, PROXY_HEAD_MAX, proxyHead, proxyPage } from './proxy'

type $ = EngineInterface
type UI = Elements[RenderSurface]

const PLUGIN = 'shared-session'
const ROOM = 'shared-room' // the Room panel's id
const TEAM = 'shared-team' // the Team panel's id
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

const DEFAULT_POLICY: SharePolicy = { prompts: 'everyone', approvals: 'edits', files: 'on' }
// What a person hears and sees of the room: a ping when mentioned and a
// chime when their prompt starts, no voice, no status line, until they choose.
const DEFAULT_PREFS: SharePrefs = { sounds: 'mentions', voice: false, statusLine: false, relayPeers: true }
const PREFS_KEY = 'prefs' // in $.store: the same for every session of this person
type RoomTab = 'people' | 'chat' | 'timeline' | 'changes' | 'shown' | 'settings'

const modeA = atom({ plugin: 'shared-session', key: 'mode' } as const, 'idle' as ShareMode)
const roomA = atom({ plugin: 'shared-session', key: 'room' } as const, null as ShareRoom | null)
const peopleA = atom({ plugin: 'shared-session', key: 'people' } as const, [] as SharePerson[])
const workingA = atom({ plugin: 'shared-session', key: 'working' } as const, null as ShareWorking | null)
const activityA = atom({ plugin: 'shared-session', key: 'activity' } as const, [] as ShareActivity[])
const chatA = atom({ plugin: 'shared-session', key: 'chat' } as const, [] as ShareChat[])
const unreadA = atom({ plugin: 'shared-session', key: 'unread' } as const, 0)
const policyA = atom({ plugin: 'shared-session', key: 'policy' } as const, DEFAULT_POLICY)
const trustedA = atom({ plugin: 'shared-session', key: 'trusted' } as const, [] as ShareTrust[])
const ownersA = atom({ plugin: 'shared-session', key: 'owners' } as const, {} as Record<string, ShareOwner>)
const liveUpdatesA = atom({ plugin: 'shared-session', key: 'liveUpdates' } as const, null as 'running' | 'next' | 'pinned' | null)
const replayRunF = atom({ plugin: 'shared-session', key: 'replayRun' } as const, null as { tools?: string[]; hidden?: true } | null)
const toolRowsA = atom({ plugin: 'shared-session', key: 'toolRows' } as const, 'grouped' as 'grouped' | 'each')
const approvingA = atom({ plugin: 'shared-session', key: 'approving' } as const, null as { id: string; who: string; what: string; extent?: string; always: string; more: number } | null)
// The room's host in the cloud (docs/cloud-host.md), its approver's questions, and a move under way.
const cloudA = atom({ plugin: 'shared-session', key: 'cloud' } as const, null as ShareCloud | null)
const cloudAsksA = atom({ plugin: 'shared-session', key: 'cloudAsks' } as const, [] as ShareCloudAsk[])
const cloudTrustedA = atom({ plugin: 'shared-session', key: 'cloudTrusted' } as const, [] as string[])
const cloudMoveA = atom({ plugin: 'shared-session', key: 'cloudMove' } as const, null as { stage: 'idle' | 'token' | 'packing' | 'starting' | 'home' | 'failed'; note?: string } | null)
type CloudMove = { stage: 'idle' | 'token' | 'packing' | 'starting' | 'home' | 'failed'; note?: string }
const cloudMove = (stage: CloudMove['stage'], note?: string): CloudMove => (note ? { stage, note } : { stage })
// Host: a teammate's calls put to the host and not answered yet, by
// tool_use_id. In the state, not the module: a hook whose module ends under
// it has its `.catch` asked in the one that replaces it, which denies these.
const unansweredA = atom({ plugin: 'shared-session', key: 'unanswered' } as const, [] as string[])
// The hooks module that started last in this session, by its own id (`MODULE`).
const moduleA = atom({ plugin: 'shared-session', key: 'module' } as const, null as string | null)
// Host: whose each agent is, by its loop's id: the teammate whose turn (or
// agent) started it, `who: ''` for the host's own (`callOwner`).
const agentsA = atom({ plugin: 'shared-session', key: 'agents' } as const, {} as Record<string, ShareOwner>)
// Host: teammates' prompts waiting for Claude, oldest first, the first
// marked once it has gone (`nextGuestPrompt`); kept through a reload.
const guestPromptsA = atom({ plugin: 'shared-session', key: 'guestPrompts' } as const, [] as ShareGuestPrompt[])
// The main loop's turn running now, whatever the mode, by its id: one begun
// before Share (or before a reload) runs with no working line, and a
// teammate's prompt submitted then waits in the engine's queue behind it.
const turnA = atom({ plugin: 'shared-session', key: 'turn' } as const, null as string | null)
const sidebarA = atom({ plugin: 'shared-session', key: 'sidebar' } as const, null as { title: string; pinned: boolean; id?: string; pinOk?: boolean } | null)
const shownA = atom({ plugin: 'shared-session', key: 'shown' } as const, [] as ShareShown[])
// Host: what this session shares, by port (`HostShare`).
const sharesA = atom({ plugin: 'shared-session', key: 'shares' } as const, {} as Record<string, HostShare>)
const localPreviewsA = atom({ plugin: 'shared-session', key: 'localPreviews' } as const, [] as ShareLocalPreview[])
const previewWindowA = atom({ plugin: 'shared-session', key: 'previewWindow' } as const, null as SharePreviewWindow | null)
const previewNeedsOpenA = atom({ plugin: 'shared-session', key: 'previewNeedsOpen' } as const, [] as string[])
const hostAskA = atom({ plugin: 'shared-session', key: 'hostAsk' } as const, null as ShareHostAsk | null)
const hostMemoryA = atom({ plugin: 'shared-session', key: 'hostMemory' } as const, null as ShareHostMemory | null)
const needAskedA = atom({ plugin: 'shared-session', key: 'needAsked' } as const, null as ShareNeedAsked | null)
// Messages between sessions: the host's mailboxes and a guest's handles, by
// id (whose each is); a guest's relays and the replies it sent on; the host's
// mailboxes' helper, which a reload ends.
const peerRoutesA = atom({ plugin: 'shared-session', key: 'peerRoutes' } as const, {} as Record<string, SharePeerRoute>)
const peerRelaysA = atom({ plugin: 'shared-session', key: 'peerRelays' } as const, [] as SharePeerRelay[])
const peerSendsA = atom({ plugin: 'shared-session', key: 'peerSends' } as const, [] as SharePeerSend[])
const mailboxHelperA = atom({ plugin: 'shared-session', key: 'mailboxHelper' } as const, null as ShareMailboxHelper | null)
const autoOpenA = atom({ plugin: 'shared-session', key: 'autoOpen' } as const, true)
const askingA = atom({ plugin: 'shared-session', key: 'asking' } as const, null as { prompts: number } | null)
const connectionA = atom({ plugin: 'shared-session', key: 'connection' } as const, 'live' as 'live' | 'reconnecting')
const confirmingA = atom({ plugin: 'shared-session', key: 'confirming' } as const, null as 'stop' | null)
const closingA = atom({ plugin: 'shared-session', key: 'closing' } as const, null as { how: Exit; room: string } | null)
// The Team panel's Stop or Leave pressed once on a room (`stop:<id>`,
// `leave:<id>`): the next press does it.
const stoppingRoomA = atom({ plugin: 'shared-session', key: 'stoppingRoom' } as const, null as string | null)
const newerA = atom({ plugin: 'shared-session', key: 'newer' } as const, null as string | null)
// The Update button's run: under way, or what it did and when.
const updatingA = atom({ plugin: 'shared-session', key: 'updating' } as const, null as { state: 'running' } | { state: 'done'; ok: boolean; text: string; at: number } | null)
const pagesA = atom({ plugin: 'shared-session', key: 'pages' } as const, {} as Record<string, Record<string, unknown>>)
const updatesA = atom({ plugin: 'shared-session', key: 'updates' } as const, null as boolean | null)
const NO_TEAMS: ShareTeams = { server: '', account: null, teams: [], current: null, byLink: false, sessions: [], members: [], providers: [], signingIn: null, invite: null, loaded: 0, error: null }
const teamsA = atom({ plugin: 'shared-session', key: 'teams' } as const, NO_TEAMS)
const invitesA = atom({ plugin: 'shared-session', key: 'invites' } as const, [] as ShareInvite[])
const invitedA = atom({ plugin: 'shared-session', key: 'invited' } as const, {} as Record<string, number>)
const pinRefusedA = atom({ plugin: 'shared-session', key: 'pinRefused' } as const, false)
// Auto mode refused the plugin's own call to Claude's browser: not tried
// again until an allow rule names it (Allow previews in Claude).
const paneRefusedA = atom({ plugin: 'shared-session', key: 'paneRefused' } as const, false)
const roomTabA = atom({ plugin: 'shared-session', key: 'roomTab' } as const, 'people' as RoomTab)
const turnsA = atom({ plugin: 'shared-session', key: 'turns' } as const, [] as ShareTurn[])
const changesA = atom({ plugin: 'shared-session', key: 'changes' } as const, [] as ShareChange[])
const reactionsA = atom({ plugin: 'shared-session', key: 'reactions' } as const, {} as Record<string, Record<string, string[]>>)
const seenA = atom({ plugin: 'shared-session', key: 'seen' } as const, {} as Record<string, string[]>)
const replyForA = atom({ plugin: 'shared-session', key: 'replyFor' } as const, {} as Record<string, string>)
const callsA = atom({ plugin: 'shared-session', key: 'calls' } as const, 0)
const copiedA = atom({ plugin: 'shared-session', key: 'copied' } as const, false)
const changeOpenA = atom({ plugin: 'shared-session', key: 'changeOpen' } as const, null as string | null)
const prefsA = atom({ plugin: 'shared-session', key: 'prefs' } as const, DEFAULT_PREFS)
const teamTabA = atom({ plugin: 'shared-session', key: 'teamTab' } as const, 'live' as 'live' | 'people' | 'settings')

// Context a host app puts into the person's message (Claude Desktop adds a
// <system-reminder> to a first prompt): not typed, and never shared.
const SYSTEM_BLOCKS = /<(system-reminder|task-notification)>[\s\S]*?<\/\1>/g

function typedText(text: string): string {
  return text.replace(SYSTEM_BLOCKS, '').trim()
}

// Guest: the ride a starting turn is. Its text can differ from what the
// plugin submitted (an app's prompt hooks add to it, a long prompt is cut),
// so: the exact text, else the same beginning, else the oldest waiting.
function takeRide(text: string): Ride | undefined {
  const exact = ridesByText.get(text)?.shift()
  if (exact) return exact
  const head = (t: string) => t.slice(0, 200)
  for (const [key, list] of ridesByText) {
    if (list.length && (text.startsWith(head(key)) || key.startsWith(head(text)))) return list.shift()
  }
  for (const list of ridesByText.values()) if (list.length) return list.shift()
  return undefined
}

// Prompts a person typed: at the prompt box, through the Desktop app or an SDK
// host, or over Remote Control. Only these join a shared session; a message a
// peer session, channel or task delivered never does (once joined, everything
// typed here goes to someone else's machine).
const PERSON = new Set(['composer', 'sdk', 'bridge'])
// What a guest's session sends the host's Claude: a person's own prompts, and
// those from a same-user socket the engine can't attest (`unclassified`) or a
// follow-up to their own click. Never a channel's, a peer's or a task's
// message, nor one the engine marks as unseen (`isMeta`, 2.1.300).
const GUEST_SENDS = new Set([...PERSON, 'unclassified', 'auto-continuation'])
// A message one of this person's other Claude sessions on this computer sent
// (`SendMessage` to this session): theirs to relay, unless they've said not to.
// It goes as the message alone, from the sender's name, never its socket or id.
// The engine marks every such message `isMeta` (no person typed it), so that
// mark doesn't keep it here; its origin, from the engine's own socket, does the
// telling.
const OWN_SESSIONS = new Set(['peer', 'peer-send-message'])

// A share link: <server origin, with any path prefix>/s/<room id>, alone.
const LINK = /^\s*(https?:\/\/[^\s]+?)\/s\/([A-Za-z0-9_-]{16,64})\/?\s*$/
// A link pasted while another session here is in its room: pasted again soon, it joins.
let pastedAgain: { id: string; at: number } | null = null
// A team's invite link (`/i/<code>`), pasted as a message.
const INVITE = /^\s*(https?:\/\/[^\s]+?)\/i\/([A-Za-z0-9_-]{8,40})\/?\s*$/

type ServerEvent = {
  seq: number
  type: string
  /** `approver`: a prompt from the cloud host's approver, as the room says. */
  from: { seat: string; name: string; role: 'host' | 'guest'; approver?: boolean }
  ts: number
  body: Record<string, unknown>
}

type EventsPage = { seq: number; events: ServerEvent[]; people: SharePerson[]; previews?: unknown; ended: boolean; title: string; more?: boolean; cloud?: CloudSummary }
// What a room's pages say of its host in the cloud.
type CloudSummary = { state: ShareCloud['state']; approver: string; since: number; until?: number }

// This session is a cloud host's (cloud/runner.mjs starts it so): nobody is
// at its screen, so a teammate's call goes to the room's approver.
let runnerMode: boolean | null = null
async function isRunner($: $): Promise<boolean> {
  runnerMode ??= (await $.env.get('SHARED_SESSION_RUNNER')) === '1'
  return runnerMode
}

// The room's word on its cloud host, this session's part in it kept.
function cloudFrom(summary: CloudSummary | undefined, was: ShareCloud | null): ShareCloud | null {
  if (!summary) return null
  return { state: summary.state, approver: summary.approver, since: summary.since, ...(summary.until ? { until: summary.until } : {}), mine: was?.mine ?? false }
}

// The engine hands a plugin at most 4 MiB of a response body, in bytes, cut
// without a word (measured), and a long session's history is many times
// that: rooms send events in pages of at most this many bytes when asked (`max`).
const PAGE_BYTES = 3_000_000

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

// The request never got an answer: the server is unreachable from here.
class NetworkError extends Error {}

// ---------------------------------------------------------------------------
// Module state. A reload starts these over; what must survive is in $.state.

// The `server` option, as the plugin's options carry it (set by register).
let configuredServer = ''

const NO_SERVER =
  'Sharing needs a share server, and none is set up yet. Run your own (README: "Host a server"), then set it with `/plugin configure shared-session` or the SHARED_SESSION_SERVER environment variable. Joining a link someone sent you needs nothing.'

// ---------------------------------------------------------------------------
// Updates. The plugin says its version on every request: the server turns a
// version known to misbehave away (with the command that updates it) and says
// which is newest. Claude Code installs updates by itself when the marketplace
// has `autoUpdate` on, which the Room's Updates setting turns on.

const MARKETPLACE = 'claude-share'
const MARKETPLACE_SOURCE = { source: 'github', repo: 'Paradigm-Study/claude-share' }
const UPDATE_COMMAND = 'claude plugin marketplace update claude-share && claude plugin update shared-session@claude-share'
let pluginVersion: string | undefined

async function ownVersion($: $): Promise<string> {
  if (pluginVersion === undefined) {
    try {
      pluginVersion = String(JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)).version ?? '')
    } catch {
      pluginVersion = ''
    }
  }
  return pluginVersion
}

function newerThan(a: string, b: string): boolean {
  const x = a.split('.').map(n => Number.parseInt(n, 10) || 0)
  const y = b.split('.').map(n => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

// What the server said is newest: noted once, and shown in the Room.
async function noteLatest($: $, latest: unknown) {
  const mine = await ownVersion($)
  if (typeof latest !== 'string' || !mine || !newerThan(latest, mine) || (await read($, newerA)) === latest) return
  await update($, newerA, () => latest)
  const auto = await read($, updatesA)
  const live = await read($, liveUpdatesA)
  if (live === 'running') return void selfUpdate($, latest)
  if (live === 'pinned') {
    return void $.ui.log(
      `Shared Sessions ${latest} is out (this session runs ${mine}). Claude Desktop runs the copy installed from your local marketplace folder, so a release loads only when you quit and reopen it. To have releases load in place, add the marketplace from GitHub: ${await switchCommand($)}`,
    )
  }
  $.ui.log(
    auto
      ? `Shared Sessions ${latest} is out (this session runs ${mine}). It installs by itself; new sessions get it${live === 'next' ? ', and from then on updates load without a restart' : ''}.`
      : `Shared Sessions ${latest} is out (this session runs ${mine}). Turn on Updates in the Room, or run: ${UPDATE_COMMAND}`,
  )
}

// Updates in place. Claude Code loads a plugin folder named in the
// settings' CLAUDE_CODE_PLUGIN_DIRS in every session, ahead of the installed
// copy, and with CLAUDE_CODE_PLUGIN_DIR_WATCH=1 every running session reloads
// it when its files change. So with Updates on, the plugin keeps a copy of
// itself there, and that copy replaces its own files with each release (from
// the repository the marketplace installs from): open sessions take it up
// at once, no restart. Off, the folder is no longer named and new sessions
// run the installed copy again.
const LIVE_SUBDIR = '.claude/shared-session/plugin'
const RELEASE_URL = 'https://codeload.github.com/Paradigm-Study/claude-share/tar.gz/refs/heads/main'
const INSTALLED_ID = 'shared-session@claude-share'
let updatingTo: string | null = null

async function liveDirOf($: $): Promise<string | null> {
  const home = await $.env.get('HOME')
  return home ? `${home}/${LIVE_SUBDIR}` : null
}
const runsLive = ($: $) => $.plugin.root.replace(/\/+$/, '').endsWith(`/${LIVE_SUBDIR}`)

async function readSettings($: $): Promise<{ path: string; settings: Record<string, unknown> } | null> {
  const path = await settingsFile($)
  if (!path) return null
  try {
    return { path, settings: (await $.fs.exists(path)) ? JSON.parse(await $.fs.read(path)) : {} }
  } catch {
    return null
  }
}

// Names (or stops naming) the live folder in the settings' env, the rest kept.
async function nameLiveDir($: $, on: boolean): Promise<boolean> {
  const dir = await liveDirOf($)
  const read0 = await readSettings($)
  if (!dir || !read0) return false
  const env = { ...((read0.settings.env ?? {}) as Record<string, string>) }
  const dirs = String(env.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(':').filter(d => d && d !== dir)
  if (on) {
    env.CLAUDE_CODE_PLUGIN_DIRS = [...dirs, dir].join(':')
    env.CLAUDE_CODE_PLUGIN_DIR_WATCH = '1'
  } else if (dirs.length) env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(':')
  else {
    delete env.CLAUDE_CODE_PLUGIN_DIRS
    delete env.CLAUDE_CODE_PLUGIN_DIR_WATCH
  }
  try {
    await $.fs.write(read0.path, `${JSON.stringify({ ...read0.settings, env }, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

// Turns updates in place on: this copy into the live folder, then named.
async function enableLive($: $): Promise<boolean> {
  const dir = await liveDirOf($)
  if (!dir) return false
  if (!runsLive($)) {
    const copied = await sh(
      $,
      [
        `src=${sq($.plugin.root)}; live=${sq(dir)}`,
        'mkdir -p "$live" || exit 1',
        'if command -v rsync >/dev/null 2>&1; then rsync -a --delete --checksum --exclude .claude --exclude tests "$src/" "$live/"; else cp -R "$src/." "$live/"; fi && echo copied',
        '',
      ].join('\n'),
    )
    if (!copied.out.includes('copied')) return false
  }
  if (!(await nameLiveDir($, true))) return false
  const pinned = !runsLive($) && (await pinnedByDesktop($))
  await update($, liveUpdatesA, () => (runsLive($) ? 'running' : pinned ? 'pinned' : 'next'))
  return true
}

// The live copy: fetch the release, and when it's newer than this one, put
// its files in place of this folder's (one session at a time, by a lock);
// every session running the folder reloads with it.
// A session someone is looking at (Desktop, an interactive terminal). One
// with no surface (`claude -p`, a script, a test run) can be gone in seconds:
// it leaves the folder that updates itself to the sessions that stay.
async function drawn($: $): Promise<boolean> {
  return ((await $.session.surfaces().catch(() => [])) as unknown[]).length > 0
}

async function selfUpdate($: $, latest: string) {
  if (!runsLive($) || updatingTo === latest || !(await read($, updatesA)) || !(await drawn($))) return
  const mine = await ownVersion($)
  if (!mine || !newerThan(latest, mine)) return
  updatingTo = latest
  const live = $.plugin.root.replace(/\/+$/, '')
  const url = (await $.env.get('SHARED_SESSION_RELEASE_URL')) || RELEASE_URL
  const fetched = await sh(
    $,
    [
      `live=${sq(live)}; next="$live.next"; lock="$live.lock"`,
      'if ! mkdir "$lock" 2>/dev/null; then',
      '  owner=$(cat "$lock/owner" 2>/dev/null)',
      '  if { [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; } || [ -n "$(find "$lock" -maxdepth 0 -mmin +3 2>/dev/null)" ]; then',
      '    rm -rf "$lock" && mkdir "$lock" 2>/dev/null || { echo busy; exit 0; }',
      '  else echo busy; exit 0; fi',
      'fi',
      'echo "$PPID" > "$lock/owner"',
      'tmp=$(mktemp -d) || { rm -rf "$lock"; exit 1; }',
      `curl -fsSL --max-time 90 ${sq(url)} -o "$tmp/r.tgz" && tar -xzf "$tmp/r.tgz" -C "$tmp" || { rm -rf "$tmp" "$lock"; echo failed; exit 0; }`,
      'pj=$(find "$tmp" -path "*/plugin/.claude-plugin/plugin.json" | head -1); src="${pj%/.claude-plugin/plugin.json}"',
      '[ -n "$pj" ] && [ -f "$src/hooks/register.tsx" ] || { rm -rf "$tmp" "$lock"; echo failed; exit 0; }',
      'rm -rf "$next" && mkdir -p "$next" && cp -R "$src/." "$next/" && rm -rf "$next/tests" "$next/.claude" "$tmp"',
      `echo "version=$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "$next/.claude-plugin/plugin.json" | head -1)"`,
      '',
    ].join('\n'),
  )
  const got = /version=(\S+)/.exec(fetched.out)?.[1]
  const apply = Boolean(got && newerThan(got, mine))
  if (apply) $.ui.log(`Updating Shared Sessions to ${got}. It reloads in place; nothing to restart.`)
  if (got) {
    await sh(
      $,
      [
        `live=${sq(live)}; next="$live.next"; lock="$live.lock"`,
        apply ? 'if command -v rsync >/dev/null 2>&1; then rsync -a --delete --checksum --exclude .claude "$next/" "$live/"; else cp -R "$next/." "$live/"; fi' : ':',
        'rm -rf "$next" "$lock"; echo done',
        '',
      ].join('\n'),
    )
  }
  if (!apply) {
    updatingTo = null // try again at the next check
    // Another session is on it: look again soon, in case that one stops.
    if (/busy/.test(fetched.out)) $.clock.after(2 * 60_000, () => void checkForUpdate($))
    // Said once a version: the download failing here (a proxy, no curl) would
    // otherwise keep this session on its version unseen.
    if (!got && !/busy/.test(fetched.out) && failedFor !== latest) {
      failedFor = latest
      $.ui.log(`Shared Sessions ${latest} is out, but this machine couldn't download it. Run: ${UPDATE_COMMAND} — the next session picks it up.`)
    }
  }
}
let failedFor: string | null = null

// The live copy behind the installed one (someone ran the update command, or
// a download failed here): take the installed copy's files, no network; every
// session running the folder reloads with them.
async function catchUpFromInstalled($: $) {
  if (!runsLive($) || !(await drawn($))) return
  const mine = await ownVersion($)
  const dir = await configDirOf($)
  if (!mine || !dir) return
  let installed: { installPath?: unknown; version?: unknown } | undefined
  try {
    const list = JSON.parse(await $.fs.read(`${dir}/plugins/installed_plugins.json`))
    installed = ((list.plugins ?? list)[INSTALLED_ID] as { installPath?: unknown; version?: unknown }[] | undefined)?.find(e => typeof e.installPath === 'string')
  } catch {
    return
  }
  const version = typeof installed?.version === 'string' ? installed.version : ''
  if (!version || !newerThan(version, mine) || typeof installed?.installPath !== 'string') return
  $.ui.log(`Updating Shared Sessions to ${version} from the installed copy. It reloads in place; nothing to restart.`)
  await sh(
    $,
    [
      `src=${sq(installed.installPath)}; live=${sq($.plugin.root.replace(/\/+$/, ''))}`,
      '[ -f "$src/hooks/register.tsx" ] || exit 0',
      'if command -v rsync >/dev/null 2>&1; then rsync -a --delete --checksum --exclude .claude --exclude tests "$src/" "$live/"; else cp -R "$src/." "$live/"; fi',
      '',
    ].join('\n'),
  )
}

// What the server says is newest, asked now and then: a long-open session
// learns of a release without sharing or joining anything.
async function checkForUpdate($: $) {
  try {
    const info = await api<{ latest?: string }>($, await serverOf($), '/api/version')
    await noteLatest($, info.latest)
    if (typeof info.latest === 'string' && (await read($, liveUpdatesA)) === 'running') await selfUpdate($, info.latest)
  } catch {}
}

// Claude Code's own folder, where it reads the person's settings and keeps
// its plugins: CLAUDE_CONFIG_DIR, else ~/.claude. The plugin's checkpoints
// and window profiles live there too. Null: neither is set.
async function configDirOf($: $): Promise<string | null> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR'))?.trim()
  const home = await $.env.get('HOME')
  if (!config && !home) return null
  return (config || `${home}/.claude`).replace(/\/+$/, '')
}

// The person's settings, as Claude Code reads them: what Updates, Allow
// previews in Claude and Allow pinning write, and what reads them back.
async function settingsFile($: $): Promise<string | null> {
  const dir = await configDirOf($)
  return dir ? `${dir}/settings.json` : null
}

// Claude Desktop hands each session the installed copy's own folder when
// its marketplace is a local one (a folder or a file, as a clone added by
// path is). That folder comes ahead of the one that updates itself, so in
// Desktop a release loads only at a restart; a GitHub marketplace's plugin is
// left to Claude Code's loader, where the updating folder wins.
async function pinnedByDesktop($: $): Promise<boolean> {
  if ((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) !== 'claude-desktop') return false
  const dir = await configDirOf($)
  if (!dir) return false
  try {
    const known = JSON.parse(await $.fs.read(`${dir}/plugins/known_marketplaces.json`)) as Record<string, { source?: { source?: unknown } }>
    const kind = known[MARKETPLACE]?.source?.source
    return kind === 'directory' || kind === 'file'
  } catch {
    return false
  }
}

// From a local marketplace to the GitHub one, the plugin's server kept (the
// marketplace's removal takes the plugin and its options with it).
async function switchCommand($: $): Promise<string> {
  const options = ((await readSettings($))?.settings.pluginConfigs as Record<string, { options?: { server?: unknown } }> | undefined)?.[INSTALLED_ID]?.options
  const server = typeof options?.server === 'string' && options.server.replace(/\/+$/, '') !== SERVER_URL ? options.server : ''
  return `claude plugin marketplace remove ${MARKETPLACE} && claude plugin marketplace add ${MARKETPLACE_SOURCE.repo} && claude plugin install ${INSTALLED_ID}${server ? ` --config server=${server}` : ''}`
}

// Whether the marketplace auto-updates, from the person's settings.
async function readUpdates($: $) {
  const path = await settingsFile($)
  let on: boolean | null = null
  let settings: Record<string, unknown> = {}
  try {
    if (path) settings = JSON.parse(await $.fs.read(path)) ?? {}
    on = (settings.extraKnownMarketplaces as Record<string, { autoUpdate?: unknown }> | undefined)?.[MARKETPLACE]?.autoUpdate === true
  } catch {
    on = path && !(await $.fs.exists(path).catch(() => true)) ? false : null
  }
  const dir = await liveDirOf($)
  const named = Boolean(dir && String((settings.env as Record<string, unknown> | undefined)?.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(':').includes(dir))
  // The marketplace added again (moved to GitHub, say) comes back without
  // autoUpdate, and the plugin's options with it. The folder still named says
  // the person chose updates (turning them off un-names it): on again.
  const known = (settings.extraKnownMarketplaces ?? {}) as Record<string, Record<string, unknown>>
  if (path && named && known[MARKETPLACE] && known[MARKETPLACE].autoUpdate === undefined) {
    try {
      await $.fs.write(path, `${JSON.stringify({ ...settings, extraKnownMarketplaces: { ...known, [MARKETPLACE]: { ...known[MARKETPLACE], autoUpdate: true } } }, null, 2)}\n`)
      on = true
    } catch {}
  }
  await update($, updatesA, () => on)
  const pinned = named && !runsLive($) && (await pinnedByDesktop($))
  await update($, liveUpdatesA, () => (runsLive($) ? 'running' : pinned ? 'pinned' : named ? 'next' : null))
  // Automatic updates chosen outside the Room (setup.mjs turns on only the
  // marketplace's autoUpdate), or the folder named for them gone: in place now.
  const missing = named && dir ? !(await $.fs.exists(`${dir}/.claude-plugin/plugin.json`).catch(() => true)) : false
  if (on && (!named || missing) && !runsLive($) && (await enableLive($))) {
    $.ui.log('Shared Sessions now updates in place: from your next new session on, a release loads without a restart.')
  }
}

// The Room's Updates setting: the marketplace's `autoUpdate` in the person's
// own settings, everything else there left as it was.
async function writeUpdates($: $, on: boolean) {
  const path = await settingsFile($)
  if (!path) return
  let settings: Record<string, unknown> = {}
  try {
    if (await $.fs.exists(path)) settings = JSON.parse(await $.fs.read(path))
  } catch {
    $.ui.toast(`Couldn't read ${path}, so nothing changed`)
    return
  }
  const known = (settings.extraKnownMarketplaces ?? {}) as Record<string, Record<string, unknown>>
  const entry = known[MARKETPLACE] ?? { source: MARKETPLACE_SOURCE }
  settings.extraKnownMarketplaces = { ...known, [MARKETPLACE]: { ...entry, autoUpdate: on } }
  try {
    await $.fs.write(path, `${JSON.stringify(settings, null, 2)}\n`)
  } catch {
    $.ui.toast('Couldn\'t change it here: use /plugin → Marketplaces → claude-share')
    return
  }
  await update($, updatesA, () => on)
  if (on) {
    const live = await enableLive($)
    $.ui.toast(live ? (runsLive($) ? 'Updates: automatic, in place' : 'Updates: automatic. New sessions update in place') : 'Updates: automatic')
  } else {
    await nameLiveDir($, false)
    await update($, liveUpdatesA, () => (runsLive($) ? 'running' : null))
    $.ui.toast(runsLive($) ? 'Updates: manual, from your next new session on' : 'Updates: manual')
  }
}

// Where Share creates rooms: the plugin's option, the environment, or the
// build's default, in that order.
async function serverOf($: $): Promise<string> {
  const fromEnv = (await $.env.get('SHARED_SESSION_SERVER')) ?? ''
  // The live copy is a plugin folder, configured under another id: the
  // server saved for the installed copy (setup.mjs, /plugin configure) counts.
  let saved = configuredServer
  if (!saved && runsLive($)) {
    const options = ((await readSettings($))?.settings.pluginConfigs as Record<string, { options?: { server?: unknown } }> | undefined)?.[INSTALLED_ID]?.options
    saved = typeof options?.server === 'string' ? options.server : ''
  }
  const url = (saved || fromEnv || SERVER_URL).trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Error(NO_SERVER)
  if (!secureServer(url)) throw new PlainServer(url)
  return url
}

// Room tokens, and a sign-in's, go with every request to a share server:
// only over HTTPS, or plain http to a server on this computer (one run for
// testing).
function secureServer(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || (u.protocol === 'http:' && /^(?:(?:[a-z0-9-]+\.)*localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(u.hostname))
  } catch {
    return false
  }
}
class PlainServer extends Error {
  constructor(url: string) {
    super(`The share server ${url} is plain http, which would send everyone's tokens unencrypted. Use its https:// address (plain http works only for a server on this computer).`)
  }
}
// A room saved on such a server isn't taken up again (`resumeHosting`,
// `resumeJoined`): its token would go with the first request.
const plainSaved = (server: string) => `This session's room is on ${server}, plain http, which would send its tokens unencrypted, so it isn't taken up again. Share or join again through an https:// server.`
let myName: string | undefined
// An entry held (`hold`) waits for its pictures to go up, and what follows it waits too.
let outbox: { type: string; body: Record<string, unknown>; hold?: boolean }[] = []
let flushTimer: Timer | null = null
let flushing = false
let flushFailures = 0
// A post the room refused as too large (413): its events go again one at a
// time, this many more, so the one too large is found and the rest go on.
let singly = 0
// Prompts typed here the room refused as too large: never run there, so
// each one's turn here ends saying so, rather than wait for it (`tooLarge`).
const unsent = new Map<string, string | null>()
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
// The engine draws the type scale and named spacing (2.1.299+): read from
// AI_AGENT at session.start; until then, drawings fit the older engine.
let modern = false
// The room's extras, kept as events arrive: whose turn the rows belong to,
// each call made (by id) until its result says what it changed, and the
// count of calls a history replay found (written once it's done).
let turnBy: string | null = null
const openCalls = new Map<string, { tool: string; path: string; input?: Record<string, unknown> }>()
let callsPending = 0
// Host: each edit's hunks as the tool reported them, for its result row.
const patches = new Map<string, Patch>()
// Guest: replies that came on screen, to say so to the room (every 4 s).
const pendingSeen = new Set<string>()
const sentSeen = new Set<string>()
let seenTimer: Timer | null = null
// The prompts drawn in this transcript, by their text: where the Timeline scrolls.
const promptRows = new Map<string, string>()
// Who the last turn was for: the terminal's closing line says so.
let lastTurnFor: string | null = null

// Where a listener binds here, as its caller asks: exactly at `port`
// (`strict`: the host's own number, or the port a restore had), or there
// first and, taken, any free port. The window's own tunnel takes a port the
// system picks (0).
type LocalBind = { port: number; strict: boolean }

// Whose a run is (`LocalPreviewRun.owner`), as it starts, decides the rest:
// - a listener, an Open's or a restore's, is a mapping here: a page at
//   localhost:<its port> reaches the host's. Saved for a reload once its
//   Open is done (`commitMappings`), drawn and closed in Room → Shown, and
//   found by the next Open (`listening`), it lasts until it's stopped. Its
//   trouble is said at once, in the Room's words (`runTrouble`).
// - the preview window's own tunnel, on a port the system picks, is reached
//   only through the window's proxy: no mapping. It lasts while the window
//   does and the host allows it (`windowInterest`), and ends with the
//   window's proxy. A channel's trouble is said a moment on, in the window's
//   words, and a refusal starts it once more by itself (`windowChannel`);
//   failed once up, it says nothing: the window's next ask starts it
//   again. While it serves the window, an Open's listener doesn't
//   take it over, which would reset the window's sockets to try a port
//   here: that Open goes to the window (`windowServes`).
type RunOwner = 'listener' | 'window'

// What a run says, by its owner. What both say alike (a start that timed
// out, no Node here) is said where it happens, in the Room's words.
type RunWords = {
  /** It never came up. */
  unreachable: (host: string, port: number) => string
  /** Too many at once: a connection through it refused by the room's limits (BUSY). */
  busy: string
  /** A connection through it refused (AUTH): the seat's token it carries isn't the room's now. */
  refused: string
  /** A connection through it couldn't reach the host's target (CONNECT). */
  connect: (host: string, port: number) => string
}
const SAY: Record<RunOwner, RunWords> = {
  listener: {
    unreachable: (_host, port) => `Couldn't forward localhost:${port}. Press Open in the Room to try again.`,
    busy: 'Preview connection or request limit reached. Close unused preview tabs or wait a minute, then retry.',
    refused: 'Preview authorization was refused. Press Open in the Room to reconnect.',
    connect: () => 'The last channel could not connect to the host target. Mapping retained; target unverified.',
  },
  window: {
    unreachable: (host, port) => `Couldn't reach ${host}'s localhost:${port} for the preview window. Press Open preview to try again.`,
    busy: 'The preview window reached its connection or request limit. Close unused tabs in it or wait a minute, then reload the page.',
    refused: "The preview window's authorization was refused. Press Open preview to reconnect.",
    connect: (host, port) => `The preview window couldn't connect to ${host}'s localhost:${port}. Check that it's running there, then reload the page.`,
  },
}

type LocalPreviewRun = {
  /** The room's scope it runs in: closed, it ends (`runCurrent`). */
  scope: RoomScope
  port: number
  /** Where it binds here. */
  bind: LocalBind
  localPort?: number
  /** Its preview's epoch in the scope as it started: a Stop, Close or Leave since ends it. */
  epoch: number
  child?: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  timer?: Timer
  ready: Promise<boolean>
  settle: (ready: boolean) => void
  started: boolean
  /** Its helper failed once up: it serves nothing more. */
  failed: boolean
  error: string
  channelError?: string
  ipv6?: boolean
  stopping?: Promise<void>
  /** Whose it is: a listener here, or the preview window's own tunnel (`RunOwner`). */
  owner: RunOwner
  /** The window's: a failure waiting to be said, by its code (`sayWindowLater`). */
  saying?: Map<string, Timer>
  /** Its port refused here (`Refusal`). */
  refused?: Refusal
}

// Why a bind here failed at the port it asked: taken on this computer
// (something answered there, or the bind failed), or refused by the system
// (`denied`: EACCES or EPERM, a port below 1024 on Linux). Taken either way
// for the fallbacks (the window, else elsewhere); said as what it is.
type Refusal = 'taken' | 'denied'
type RefusedPort = { port: number; refused: Refusal }

type TcpRelayRun = { id: string; pid: string; port: number; scope: RoomScope; worker: TcpWorkerRun }
type TcpWorkerRun = Helper & { room: ShareRoom; started: boolean }
const tcpRejecting = new Set<string>()
const TCP_RELAYS = 64

// The room's scope. What this session does for the room it's in that can
// outlast a request (a listener, the window, its proxy and tunnels, the
// host's TCP worker, their queues, and what they say once) is the scope's:
// one for each room this session enters (Share, a join, a place taken back,
// the room picked up after a reload), closed at once as the session leaves
// it (`closeRoom`), before anything there waits. Work checks the scope it
// began in, with no $ call between: closed, it stops, and its writes don't
// land. What a row draws stays in $.state (a reload redraws from it), its
// writes fenced by the scope, and cleared as the room closes.
//
// A reseat (the room let the seat go, and a new one was taken) is no way
// out: listeners and the window go on. Only a request made with the old
// seat's token ends (`sameRoom`), checked against the token the scope holds
// now, which the reseat changes.
type Detection = { done?: BrowserFound; task?: Promise<BrowserFound & { failed?: true }>; failed?: true }

// Guest: the room's preview window, kept with its scope (`RoomScope.window`):
// its opens, one at a time, and those still running; what holds a tunnel
// back (a start that failed, a refusal's one restart); what it said once; the
// host's needs it's asking about; the look at it every 30 s while it's open;
// and whether a browser here can open one. Its proxy and tunnels are the
// scope's children (`RoomChildren`), ended with the rest of what the room
// runs. It closes with its scope, before anything waits: an open still going
// finds that at its next step (`windowStep`) and puts away what it made.
class WindowContext {
  /** Its opens, one at a time; a Leave waits for them (briefly) before the profile goes. */
  readonly opens = lane()
  readonly openings = new Set<Promise<void>>()
  /**
   * By preview: a window tunnel that failed to start isn't offered again for
   * 30 s (`until`); `retried`, the one restart a refusal got by itself since
   * the person's own Open (`retryOnce`). Their Open clears both
   * (`clearRefusals`).
   */
  readonly backoff = new Map<string, { until: number; retried?: true }>()
  /** Previews whose Stop was said in the window's words. */
  readonly stopSaid = new Set<string>()
  /** Ports a need of the window's is being asked of the host about now: one at a time each. */
  readonly needAsking = new Set<number>()
  /** The window, looked at every 30 s while open, and the looks that failed in a row. */
  watch: Timer | null = null
  misses = 0
  /** Whether a preview window can open here: looked for once a room (`detectBrowser`). */
  readonly detection: Detection = {}

  stopWatching() {
    this.watch?.cancel()
    this.watch = null
    this.misses = 0
  }

  // The window's tunnel was refused (AUTH): the seat whose token it carries
  // was let go (this session seated anew), or the room refuses it now. The
  // first time since the person's Open, the page's next ask starts it again,
  // with the token this session holds now; false, and it waits for their Open.
  retryOnce(pid: string): boolean {
    const backoff = this.backoff.get(pid)
    if (backoff?.retried) return false
    this.backoff.set(pid, { until: backoff?.until ?? 0, retried: true })
    return true
  }
}

// What runs here for a room, kept with its scope (`RoomScope.children`): a
// guest's listeners (the window's own tunnels among them: one run a
// preview) and the window's proxy; the host's TCP worker with its
// connections, the public link's socket relays and fetches, with the asks
// waiting for one, and its mailboxes' helper for messages between
// sessions. The scope closing stops all of it at once (`stop`),
// a Stop or unshare of a preview its public link's part (`closePublic`), and
// a room entered next starts with none of it.
class RoomChildren {
  /** Guest: by preview, its listener, or the window's own tunnel for it. */
  readonly listeners = new Map<string, LocalPreviewRun>()
  /** Guest: the window's proxy. */
  windowProxy: BrowserProxy | null = null
  /** Host: the TCP worker, and its connections queued, connecting or open (by `tcpKey`). */
  worker: TcpWorkerRun | null = null
  /** Host: the mailboxes' helper for messages between sessions (`MailboxRun`). */
  mailbox: MailboxRun | null = null
  readonly connections = new Map<string, TcpRelayRun>()
  /** Host: the public link's socket relays (by `tcpKey`), the fetches running for it, and the asks waiting for one, oldest first. */
  readonly relays = new Map<string, PublicRelay>()
  readonly fetches = new Set<ProxyRun>()
  readonly waiting: ProxyRun[] = []

  // The public link's work for a preview (all of it, without one) ends now:
  // its sockets' relays and its requests' fetches and answers are killed,
  // and its waiting asks go. Synchronous, so a Stop or a room's end takes
  // effect before anything else waits.
  closePublic(pid?: string) {
    for (const [key, relay] of this.relays) {
      if (pid && relay.pid !== pid) continue
      this.relays.delete(key)
      relay.stopped = true
      endChild(relay.child)
    }
    for (const run of this.fetches) {
      if (pid && run.pid !== pid) continue
      run.stopped = true
      endChild(run.child)
    }
    for (let i = this.waiting.length - 1; i >= 0; i--) if (!pid || this.waiting[i]!.pid === pid) this.waiting.splice(i, 1)
  }

  // All of it told to stop now (the public link's ended outright); settled
  // once the rest has.
  stop(): Promise<void> {
    this.closePublic()
    const worker = this.worker
    this.connections.clear()
    return Promise.all([
      ...[...this.listeners].map(([pid, run]) => (run.stopping ??= finishLocalPreview(pid, run))),
      ...(this.windowProxy ? [finishBrowserProxy(this.windowProxy)] : []),
      ...(worker ? [finishTcpWorker(worker)] : []),
      ...(this.mailbox ? [finishMailbox(this.mailbox)] : []),
    ]).then(() => {})
  }
}

class RoomScope {
  live = true
  /** How it ended: left for good (`end`: a room's window profile goes), or kept with the session's place (`keep`). */
  ending: 'end' | 'keep' = 'end'
  /** By preview: a Stop, Close or Leave of it bumps it, so what began before (an Open, a listener) ends. */
  readonly epochs = new Map<string, number>()
  /** Host: previews being unshared now: their TCP connections end, and none starts. */
  readonly revoking = new Set<string>()
  /** Host: when the Stops the room didn't hear were last told again (`endUnheard`). */
  toldEnds = -Infinity
  /** Host: ports a share is being made for now (`ensurePreview`): a Stop told again leaves them alone. */
  readonly sharingPorts = new Map<number, number>()
  /** Host: ports whose preview's end the room is being told now (`endPreview`): a share of one waits for it. */
  readonly endingPorts = new Map<number, number>()
  /** Guest: one Open of a preview at a time (`openShownPreview`). */
  readonly previewOpens = new Map<string, Promise<void>>()
  /** Guest: the room's preview window (`WindowContext`). */
  readonly window = new WindowContext()
  /** The room's notes said once (`noteOnce`): the window's welcome, what an Open costs, and the like. */
  readonly said = new Set<string>()
  /** Guest: what the room shares, as its newest list said (`takeRoomList`); an artifact after it shows a preview it has. */
  listed: ReadonlyMap<string, RoomPreview> = new Map()
  /** Guest: what waits for the room's next list (`nextList`): a reload's listeners. */
  private listWaiters: (() => void)[] = []
  /** What runs here for it (`RoomChildren`). */
  readonly children = new RoomChildren()
  constructor(
    /** The room, by its server and id (`roomIdentity`). */
    readonly key: string,
    /** The seat's token now: a reseat changes it, and a request made with another ends. */
    public token: string,
    readonly mode: 'host' | 'guest',
  ) {}
  // Settles as the room's next list is taken here (`takeRoomList`).
  nextList(): Promise<void> {
    return new Promise(done => this.listWaiters.push(done))
  }
  tookList() {
    for (const done of this.listWaiters.splice(0)) done()
  }
  // Closed at once: nothing of it starts or lands from here on, and what runs
  // for it is told to stop; settled once that has.
  close(ending: 'end' | 'keep'): Promise<void> {
    if (this.live) {
      this.live = false
      this.ending = ending
      this.window.stopWatching()
    }
    return this.children.stop()
  }
  epoch(pid: string): number {
    return this.epochs.get(pid) ?? 0
  }
}

// No room yet (or a reload before its start takes the room up): nothing of
// a room runs.
let scope = new RoomScope('', '', 'guest')
void scope.close('end')

// Into a room: a scope of its own. The one before is closed by then
// (`closeRoom`); were one still open, it ends as kept, its work with it.
function openScope(room: ShareRoom, mode: 'host' | 'guest'): RoomScope {
  void scope.close('keep')
  scope = new RoomScope(roomIdentity(room), room.token, mode)
  return scope
}

// Host: main-loop turns started so far: a teammate's prompt sent that no
// turn started with since is known by it (`watchGuestPrompt`).
let mainStarts = 0
// Guest: a prompt with attachments, held until its stored message hands over
// their bytes (a prompt's hook sees only their kinds), then sent with them.
let heldPrompt: { text: string; pid: string; names: string[]; timer: Timer } | null = null
// Host: every teammate's call put to the host and not answered yet, oldest
// first. The engine checks a response's calls together (two pages fetched,
// two subagents' commands), so several can wait at once. Each is asked in
// the dialog, one at a time (`waiting`, then `dialog`: the dialog previews
// its own call, where two up at once both showed the last one's), then,
// where the dialog didn't show, in the row above the prompt (`row`), which
// shows the oldest there. The working line names the oldest of them all.
// Each goes only with its own answer: its dialog or its buttons (by id),
// Always allow for that person (in a dialog or the row), its ten minutes in
// the row, its call given up, the room's end, or a reload. One answer for
// the row left the first with nothing on screen to answer it.
type Approval = {
  id: string
  /** Whose call it is (`callOwner`): their name, and the seat and account they're told by. */
  who: string
  seat: string
  account?: string
  what: string
  /** What the one line leaves out (`callExtent`), said beside it. */
  extent: string
  /** Always allow's label. */
  always: string
  question: string
  /** The dialog's preview, and the whole call, as the Room shows it. */
  preview: string
  whole: string
  descriptions: Record<string, string>
  /** The room it was asked in (`roomIdentity`): over by the answer, it's a no. */
  room: string
  /** `asked`: its dialog is done and it isn't in the row (yet). */
  stage: 'waiting' | 'dialog' | 'asked' | 'row'
  answer: (label: string) => void
}
const approvals: Approval[] = []
// Woken as the dialog frees or a call goes, so the next waiting is asked.
const approvalWaiters = new Set<() => void>()
// The questions this module asked, by id (the newest 64): one a reload
// replaced takes back only its own from the row, which is the new one's.
const madeHere = new Set<string>()
// Host: the calls this module put to the host (the dialog or the row) and
// has no answer for yet, by tool_use_id, with what each is, as `unanswered`
// has them; here too, so its own `.catch` knows them without a `$` call.
const askedHere = new Map<string, string>()
// This module's own id. A reload starts another module, which writes its id
// to `module` as it starts; the one it replaced keeps running a call waiting
// for an answer in it (the engine unloads a module once nothing runs in it),
// but the row is the new module's to draw now, and its buttons can't reach
// that wait: such a call is declined (`REPLACED`), and the replaced module
// takes back only what it put up (`takeBackAsk`).
const MODULE = newId()
const REPLACED = 'replaced'
// This module, once it has seen a reload replace it: it hears the room no
// more, and its timers are stopped (`retire`).
let retired = false
// The timers a start sets going, which a retire stops.
const everyTimers: Timer[] = []

// Guest: the host's turns as announced, and how this session shows them.
type HostTurn = { turnId: string; by: string; prompt: string; pid?: string; startSeq: number; shown: boolean; claimed: boolean }
type Ride =
  | { kind: 'own'; pid: string; fromSeq: number } // a prompt typed here
  | { kind: 'turn'; turnId: string } // someone else's turn
  | { kind: 'static'; rows: Row[] } // what happened before this session joined
  | { kind: 'note'; text: string; then: Exchange[]; open?: ServerEvent[] } // an answer from the plugin itself
  | { kind: 'artifact'; event: ServerEvent } // something the host showed outside a turn
type Exchange = { prompt: string; rows: Row[] }
const hostTurns: HostTurn[] = []
const ownPending = new Set<string>()
const ridesByText = new Map<string, Ride[]>()
const ridesByTurn = new Map<string, Ride>()
let localTurnActive = false
// The main thread's turn, as the latest turn.start named it: the Stop
// hooks are asked about it (`classic.Stop`), and their event names none.
let turnNow = ''
// Guest: turns this plugin starts go out one at a time (prompts submitted
// together reach the engine as one turn): what waits, and whether one has
// gone out and not started yet.
const laterRides: { text: string; ride: Ride }[] = []
let rideSubmitted = false

// ---------------------------------------------------------------------------
// Server

async function api<T>(
  $: $,
  server: string,
  path: string,
  init: { method?: string; token?: string; body?: unknown; account?: string } = {},
): Promise<T> {
  // Nothing to a share server over plain http elsewhere, whatever brought it here.
  if (!secureServer(server)) throw new PlainServer(server)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.token) headers.authorization = `Bearer ${init.token}`
  // Who's signed in, for a team's session: a header, never the address.
  if (init.account) headers['x-shared-session-account'] = init.account
  const version = await ownVersion($)
  if (version) headers['x-shared-session-version'] = version
  let res: Awaited<ReturnType<typeof $.http.fetch>>
  try {
    res = await $.http.fetch(`${server}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch (error) {
    throw new NetworkError(String((error as Error)?.message ?? error))
  }
  let data: Record<string, unknown> = {}
  let parsed = !res.text
  try {
    data = JSON.parse(res.text)
    parsed = true
  } catch {}
  if (!res.ok) throw new ApiError(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`, res.status, data)
  // An answer cut short (over the engine's 4 MiB) is a failure, never an empty one.
  if (!parsed) throw new ApiError("the share server's answer didn't come through whole", 502)
  return data as T
}

const isGone = (error: unknown) => error instanceof ApiError && [401, 404, 410].includes(error.status)
// People whose connection dropped, and when: their return isn't announced.
const lostAt = new Map<string, number>()

// Guest: the room let this seat go (a laptop asleep, a network gap past its
// 45 s grace) though the session is still shared, so the seat's token is
// refused (401). Take a new seat and go on from where this one was, rather than
// telling the person the session ended. Only the room's own answer that it is
// gone (or that this person may no longer join) ends the place here.
type Reseat = { ok: true } | { ok: false; gone: boolean; why?: string }
let reseating: Promise<Reseat> | null = null
function reseat($: $, room: ShareRoom): Promise<Reseat> {
  reseating ??= (async (): Promise<Reseat> => {
    const s = scope
    try {
      // A room this session is leaving, or has left: no seat is taken in it
      // (a refused request then drops what it carried, as for a room gone).
      if (!(s.live && s.key === roomIdentity(room))) return { ok: false, gone: true }
      // The smallest page of history: this seat already has it.
      const joined = await api<{ token: string; seat: string }>($, room.server, `/api/rooms/${room.id}/join?max=64000`, {
        method: 'POST',
        body: { name: await whoami($) },
        account: (await signInFor($, room.server))?.token,
      })
      // The room's scope goes on (its listeners, its window); a request still
      // in flight with the old seat's token ends (`sameRoom`).
      if (s.live && s.key === roomIdentity(room)) s.token = joined.token
      await update($, roomA, r => (r && r.id === room.id && s.live ? { ...r, token: joined.token, seat: joined.seat } : r))
      $.ui.log('Shared session: the room let this seat go; took a new one', { to: 'debug' })
      // Its answer's list isn't taken: the stream or a poll may have brought
      // a newer one meanwhile, which it would undo (a preview opened since
      // would end here for good), and the room's next page brings its list.
      return { ok: true }
    } catch (error) {
      const refused = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429
      return { ok: false, gone: refused, why: refused ? (error as ApiError).message : undefined }
    } finally {
      reseating = null
    }
  })()
  return reseating
}

// A seat's token refused: a guest takes a new seat (true), or the place here
// ends with what the room said.
async function stillSeated($: $, room: ShareRoom, status: number): Promise<boolean> {
  if (status === 401 && (await read($, modeA)) === 'guest') {
    const again = await reseat($, room)
    if (again.ok) return true
    if (!again.gone) return true // the server didn't answer: try again later
    await closeRoom($, 'ended', { room, log: again.why && !/no longer shared/i.test(again.why) ? `Left ${room.host}'s session: ${again.why}` : `${room.host}'s session is no longer shared.` })
    return false
  }
  const mode = await read($, modeA)
  // A room still shared refusing this seat (410): its person left it from
  // elsewhere (the Team panel's Leave, here or on another computer).
  const leftHere = mode === 'guest' && status === 410 && (await roomStillShared($, room))
  await closeRoom($, 'ended', {
    room,
    log: leftHere ? `You left ${room.host}'s session from the Team panel.` : mode === 'guest' ? `${room.host}'s session is no longer shared.` : 'Sharing ended: the room closed on the server. Press Share to start a new one.',
  })
  return false
}

async function roomStillShared($: $, room: ShareRoom): Promise<boolean> {
  try {
    return (await api<{ ended?: boolean }>($, room.server, `/api/rooms/${room.id}`)).ended === false
  } catch {
    return false
  }
}

// The kind of a live piece: what Claude writes, thinks, or a call it drafts.
const deltaKind = (body: Record<string, unknown>) => (typeof body.text === 'string' ? 'text' : typeof body.thinking === 'string' ? 'thinking' : 'drafting')

function send($: $, type: string, body: Record<string, unknown>) {
  const last = outbox.at(-1)
  if (type === 'delta' && last?.type === 'delta' && last.body.turnId === body.turnId && deltaKind(last.body) === deltaKind(body)) {
    // Pieces waiting for the next post join up; a draft's newest line replaces the last.
    const kind = deltaKind(body)
    last.body = kind === 'drafting' ? body : { ...last.body, [kind]: `${last.body[kind]}${body[kind]}` }
  } else {
    outbox.push({ type, body })
  }
  scheduleFlush($, type === 'delta' ? 250 : 30)
  if (type !== 'delta') {
    void $.clock.now().then(now => {
      lastActivity = now
    })
    kickPoll($)
  }
}

// Host: what the host's Claude writes, thinks and drafts while a step runs,
// live to whoever else is here: 'delta' events, which the room passes on and
// never stores. Alone in the room, nothing goes. A tool call being written
// goes as a progress line (which tool, what it's for, how far along), never
// its arguments: they arrive whole in the call's row once it's made. A step
// running as the host stops sharing: nothing more of it goes.
async function liveFeed($: $, turnId: string): Promise<(chunk: TurnStepChunk) => void> {
  const s = scope
  const othersHere = async () => (await read($, peopleA)).some(p => p.online && p.role !== 'host')
  let watching = await othersHere()
  let seen = 0
  const drafts = new Map<number, { tool: string; head: string; chars: number; sent: number; target: string }>()
  return chunk => {
    if (!s.live) return
    // Someone may join mid-step: looked at again every 50 pieces.
    if (++seen % 50 === 0) void othersHere().then(w => void (watching = w), () => {})
    if (!watching) return
    if (chunk.kind === 'text' && chunk.text) send($, 'delta', { turnId, text: chunk.text })
    else if (chunk.kind === 'thinking' && chunk.text) send($, 'delta', { turnId, thinking: chunk.text })
    else if (chunk.kind === 'tool') {
      drafts.set(chunk.index, { tool: chunk.name, head: '', chars: 0, sent: 0, target: '' })
      send($, 'delta', { turnId, drafting: { tool: chunk.name, target: '', chars: 0 } })
    } else if (chunk.kind === 'input') {
      const d = drafts.get(chunk.index)
      if (!d) return
      d.chars += chunk.json.length
      if (d.head.length < 2000) d.head += chunk.json
      const target = d.target || draftTarget(d.head)
      // A line when it's clear what the call is for, then every 2,000 characters.
      if ((target && !d.target) || d.chars - d.sent >= 2000) {
        d.target = target
        d.sent = d.chars
        send($, 'delta', { turnId, drafting: { tool: d.tool, target, chars: d.chars } })
      }
    }
  }
}

// What a tool call being written is for, from the start of its arguments: a
// file's name, a command's first line, a pattern.
function draftTarget(json: string): string {
  const m = /"(file_path|notebook_path|path|command|pattern|url|description|query|prompt)"\s*:\s*"((?:[^"\\]|\\.){1,240})"/.exec(json)
  if (!m) return ''
  const value = m[2]!.replace(/\\n/g, '\n').replace(/\\(.)/g, '$1')
  return /path$/.test(m[1]!) ? (value.split('/').pop() ?? value) : (value.split('\n')[0] ?? '').slice(0, 80)
}

// Host: a row to the room. A result's pictures (a screenshot, an image the
// host's Claude read) go up as room files first, the row waiting in order for
// them and what follows waiting for it, so a guest's card shows them as the
// host's does. "What Claude shows: Stays with me" keeps them here. `media`
// is the host's copy and never leaves.
function sendRow($: $, row: Row, withMedia = true) {
  const { media, ...plain } = row
  if (!media?.length || !withMedia) return send($, 'row', plain)
  const entry: { type: string; body: Record<string, unknown>; hold?: boolean } = { type: 'row', body: plain, hold: true }
  outbox.push(entry)
  void upImages($, media)
    .then(images => {
      if (images.length) entry.body = { ...entry.body, images }
    })
    .catch(() => {})
    .finally(() => {
      delete entry.hold
      scheduleFlush($, 0)
    })
  void $.clock.now().then(now => {
    lastActivity = now
  })
  kickPoll($)
}

const IMAGES_PER_RESULT = 8
const HISTORY_IMAGES = 60 // results whose pictures a shared history carries, newest first
const IMAGE_MAX = 8 * 1024 * 1024 // bytes; a room file holds 10 MB
let uploading = 0
const uploadWaiters: (() => void)[] = []

async function upImages($: $, media: Media[]): Promise<RoomImage[]> {
  const room = await read($, roomA)
  if (!room || (await read($, policyA)).files === 'off') return []
  const out: RoomImage[] = []
  for (const [i, m] of media.slice(0, IMAGES_PER_RESULT).entries()) {
    if (m.data.length * 0.75 > IMAGE_MAX) continue
    // A few at a time: a shared history can hold dozens.
    while (uploading >= 3) await new Promise<void>(done => uploadWaiters.push(done))
    uploading += 1
    try {
      const meta = await uploadImage($, room, m, `image-${i + 1}.${m.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'}`)
      if (meta) out.push({ id: meta.id, type: meta.type, size: meta.size })
    } finally {
      uploading -= 1
      uploadWaiters.shift()?.()
    }
  }
  return out
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
    singly = 0
    return
  }
  // Up to 200 events and ~400 KB a post (the server takes 512 KB); one a
  // post while one the room refused as too large is found (`singly`).
  let take = 0
  let bytes = 0
  while (take < Math.min(singly ? 1 : 200, outbox.length) && !outbox[take]!.hold) {
    bytes += JSON.stringify(outbox[take]).length
    if (take > 0 && bytes > 400_000) break
    take += 1
  }
  const batch = outbox.splice(0, take).map(({ type, body }) => ({ type, body }))
  if (batch.length === 0) return
  flushing = true
  let retry = false
  try {
    await api($, room.server, `/api/rooms/${room.id}/events`, {
      method: 'POST',
      token: room.token,
      body: { events: batch },
    })
    if (singly) singly -= 1
  } catch (error) {
    const reseated = error instanceof ApiError && error.status === 401 && (await read($, modeA)) === 'guest' && (await reseat($, room)).ok
    if (error instanceof ApiError && error.status === 413) tooLarge($, batch)
    else if (isGone(error) && !reseated) {
      outbox = []
      singly = 0
    } else {
      // Keep what matters and try again; live text is not worth replaying.
      outbox.unshift(...batch.filter(item => item.type !== 'delta'))
      retry = !reseated
      if (reseated) scheduleFlush($, 0)
    }
  } finally {
    flushing = false
  }
  if (retry) scheduleFlush($, Math.min(30_000, 2000 * 2 ** Math.min(flushFailures++, 4)))
  else {
    flushFailures = 0
    if (outbox.length) scheduleFlush($, 30)
  }
}

// The room refused the post as too large (413), taking nothing of it. Of
// several, each goes again on its own, so the one too large is found and the
// rest go on; that one alone is dropped, never sent again (it would hold back
// all that follows), and said once a room. A prompt typed here was never run
// there: its turn here ends saying so (`unsent`), and the host's turns after
// it play here as they come.
function tooLarge($: $, batch: { type: string; body: Record<string, unknown> }[]) {
  if (batch.length > 1) {
    const again = batch.filter(item => item.type !== 'delta')
    outbox.unshift(...again)
    singly = again.length
    return
  }
  if (singly) singly -= 1
  const pid = batch[0]?.type === 'prompt' ? batch[0].body.pid : undefined
  if (typeof pid === 'string' && ownPending.delete(pid)) unsent.set(pid, null)
  noteOnce($, 'too-large', 'A message was too large to send to the room.', scope)
}

// Starts hearing about the room: the stream, or polls where it can't run.
function startFeed($: $) {
  const generation = ++pollGeneration
  pollFailures = 0
  stopStream()
  $.clock.after(0, () => void runStream($, generation))
}

// A reload replaced this module while a call still waits in it (a dialog
// no one has answered): the engine keeps it running until that returns,
// its stream, polls and timers too, beside the new module's own. A
// teammate's prompt would then be taken by both, and run twice: so once it
// sees the new module (`replaced`, at each line the room sends, and each
// poll), it stops hearing the room, and its timers. The waiting call's
// answer still stands.
function retire() {
  if (retired) return
  retired = true
  pollGeneration += 1
  stopStream()
  for (const timer of everyTimers.splice(0)) timer.cancel()
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

// Host: what the room asks of this machine on its stream, by the field that
// carries it: a guest's browser asking through a preview (`proxy`), opening
// a WebSocket on it (`ws`: live reload, a dev page's debug data) or a raw TCP
// connection to a forwarded one (`tcp`), and a guest's preview window asking
// for a port nobody shared (`need`).
const ROOM_ASKS = ['proxy', 'ws', 'tcp', 'need'] as const
type RoomAsk = (typeof ROOM_ASKS)[number]

// Each answered on its own, never awaited by the stream, and whatever goes
// wrong in one goes to the debug log, never unhandled.
function answerRoomAsk($: $, room: ShareRoom, kind: RoomAsk, ask: Record<string, unknown>) {
  const answering = kind === 'proxy' ? answerProxy($, room, ask) : kind === 'ws' ? relaySocket($, room, ask) : kind === 'tcp' ? relayTcp($, room, ask) : hostNeed($, room, ask)
  void answering.catch(error => {
    try {
      $.ui.log(`Shared session: the room's ${kind}: ${String((error as Error)?.message ?? error)}`, { to: 'debug' })
    } catch {}
  })
}

// One curl per connection, its address and token on stdin (not in argv, where
// other local users could read them). Ends when the room is gone, this run is
// replaced, or curl can't run at all; otherwise reconnects, backing off.
async function runStream($: $, generation: number) {
  let failures = 0
  while (generation === pollGeneration) {
    const room = await read($, roomA)
    if (!room || (await read($, modeA)) === 'idle' || !secureServer(room.server)) return
    if ((await $.env.get('SHARED_SESSION_TRANSPORT')) === 'poll') return void startPolls($, generation, 'SHARED_SESSION_TRANSPORT=poll')
    // Messages between sessions (`peer`) come only on a stream: a poll gets
    // none, and the other side is told this one isn't connected.
    const host = (await read($, modeA)) === 'host'
    const config = [
      `url = "${room.server}/api/rooms/${room.id}/stream?after=${room.seq}"`,
      `header = "Authorization: Bearer ${room.token}"`,
      'header = "Accept: application/x-ndjson"',
      // Which plugin this is, so the room knows who needs to update.
      `header = "x-shared-session-version: ${await ownVersion($)}"`,
      'no-buffer',
      'silent',
      // The room's address taken as it is, as every curl to the room does (`roomConfig`).
      'globoff',
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
          if (await replaced($)) {
            retire()
            break
          }
          const ask = ROOM_ASKS.find(kind => message[kind] && typeof message[kind] === 'object')
          if (typeof message.httpStatus === 'number') status = message.httpStatus
          else if (ask) answerRoomAsk($, room, ask, message[ask] as Record<string, unknown>)
          else if (message.peer && typeof message.peer === 'object') void takePeer($, room, host, message.peer as Record<string, unknown>).catch(error => $.ui.log(`Shared session: a message between sessions: ${String((error as Error)?.message ?? error)}`, { to: 'debug' }))
          else if (Array.isArray(message.events)) {
            if (!streamUp && !delivered) $.ui.log('Shared session: listening on a stream', { to: 'debug' })
            // Connected: the Stops the room didn't hear are told again.
            if (host && !delivered) void endUnheard($, room, scope).catch(() => {})
            streamUp = true
            delivered = true
            failures = 0
            await setConnection($, 'live')
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
      // A guest whose seat was let go sits down again and reconnects at once.
      if (!(await stillSeated($, room, status))) return
      if (generation !== pollGeneration) return
      if ((await read($, roomA))?.token !== room.token) continue
    }
    // The server ends every stream after a few minutes: pick it up again at
    // once. One that never got going, or ended soon after, backs off, so a
    // proxy that cuts streams short is not hammered.
    if (delivered && (await $.clock.now()) - opened > 60_000) continue
    failures += 1
    if (failures >= 2) await setConnection($, 'reconnecting')
    await new Promise<void>(resolve => $.clock.after(Math.min(30_000, 500 * 2 ** failures), resolve))
  }
}

// Shown in the row above the prompt and the Room: a room this session can't
// reach says so, rather than looking live and quiet.
async function setConnection($: $, state: 'live' | 'reconnecting') {
  const was = await read($, connectionA)
  if (was === state) return
  await update($, connectionA, () => state)
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

// A wait inside a riding turn that its step's budget doesn't pay for. Each
// turn.step dispatch may spend 10 s of its own time, and past that the engine
// calls the model in its place; the clock stops while a $ call is in flight,
// but not for a plain timer (nor $.clock.sleep), and a host's Claude can think
// for much longer than 10 s before a word arrives. So waits are `sleep`s, and
// where `sleep` doesn't run, a plain timer (`nap`).
async function pause($: $, ms: number) {
  await nap($, ms)
}

// Guest: the result of a call the host's Claude made, for its card here: read
// from the room (the stream, or a short poll) until the host has it, the
// host's turn ends, or the person stops this turn. Waits are budget-free.
async function hostResult($: $, room: ShareRoom, call: { hostId: string; seq: number; turnId?: string }, signal: AbortSignal): Promise<string | ReplayBlock[]> {
  const deadline = (await $.clock.now()) + 30 * 60_000
  let cursor = call.seq
  while (!signal.aborted && (await $.clock.now()) < deadline) {
    const page = await ridePage($, room, cursor).catch(() => null)
    for (const event of page?.events ?? []) {
      cursor = Math.max(cursor, event.seq)
      const row = event.body as unknown as Row
      if (event.type === 'row' && row.kind === 'result' && row.id === call.hostId) return withImages($, room, `${row.isError ? 'Error: ' : ''}${stripLineNumbers(row.text)}`, row.images)
      if (event.type === 'turn' && event.body.state === 'end' && (!call.turnId || event.body.turnId === call.turnId)) return "(the host's turn ended before this finished)"
      if (event.type === 'ended') return '(sharing ended)'
    }
    if (page?.ended) return '(sharing ended)'
    if (!page) await pause($, 500)
  }
  return signal.aborted ? '(stopped)' : '(still running on the host)'
}

// Guest: the tool host calls are drawn as. Only a joined session has it.
async function readyReplay($: $) {
  if (replayReady) return
  replayReady = await $.tool
    .register({
      name: 'replay',
      description:
        "Shows a tool call made in the shared session this session joined, with the host's result. Used only by the Shared Sessions plugin; it runs nothing.",
      inputSchema: { type: 'object', properties: { tool: { type: 'string' }, summary: { type: 'string' }, input: { type: 'object' } }, required: ['tool'] },
    })
    .then(
      () => true,
      () => false,
    )
}

// What a riding turn reads next: from the stream when it is up and reaches
// back far enough, else one short poll of its own.
async function ridePage($: $, room: ShareRoom, cursor: number): Promise<EventsPage> {
  if (streamUp && cursor >= streamFloor) {
    const after = () => streamed.filter(e => e.seq > cursor)
    const until = (await $.clock.now()) + RIDE_WAIT_MS
    while (after().length === 0 && !streamEnded && streamUp && (await $.clock.now()) < until) await pause($, 150)
    const events = after()
    return { seq: Math.max(cursor, ...events.map(e => e.seq)), events, people: await read($, peopleA), ended: streamEnded, title: room.title }
  }
  // The seat's token as it is now: the room may have given this guest a new one.
  const now = await read($, roomA)
  const token = now?.id === room.id ? now.token : room.token
  return api<EventsPage>($, room.server, `/api/rooms/${room.id}/events?after=${cursor}&wait=${RIDE_WAIT_MS}&max=${PAGE_BYTES}`, { token })
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
    const page = await api<EventsPage>($, room.server, `/api/rooms/${room.id}/events?after=${room.seq}&wait=0&max=${PAGE_BYTES}`, {
      token: room.token,
    })
    if (generation !== pollGeneration) return
    if (await replaced($)) return void retire()
    pollFailures = 0
    await setConnection($, 'live')
    // Polling, every answer is a connection: Stops the room didn't hear are
    // told again, each once its wait is over (`endUnheard`).
    if (mode === 'host') void endUnheard($, room, scope).catch(() => {})
    const now = await $.clock.now()
    if (page.events.length > 0 || (await read($, workingA))) lastActivity = now
    await receive($, mode, room, page)
    if (generation === pollGeneration && (await read($, modeA)) !== 'idle') {
      pollDelay = page.more ? 0 : pollWait(now) // a page with more after it: the next at once
      $.clock.after(pollDelay, () => void pollOnce($, generation))
    }
  } catch (error) {
    if (generation !== pollGeneration) return
    if (isGone(error)) {
      if (!(await stillSeated($, room, (error as ApiError).status))) return
      if (generation !== pollGeneration) return
      if ((await read($, roomA))?.token !== room.token) return void $.clock.after(0, () => void pollOnce($, generation))
    }
    pollFailures += 1
    if (pollFailures >= 2) await setConnection($, 'reconnecting')
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
  // The room this event is of: what it adds to the Timeline, Changes and
  // reactions goes only while that room is this session's.
  const s = scope
  switch (event.type) {
    case 'join': {
      await note({ ts: event.ts, who, kind: 'join' })
      // Back after a dropped connection: the Room's timeline says so, the
      // transcript doesn't.
      const back = (lostAt.get(who) ?? -Infinity) > event.ts - 30 * 60_000
      lostAt.delete(who)
      if (live && !mine && !back) {
        $.ui.log(`${who} joined`)
        void cue($, 'join', `${who} joined your session`)
      }
      break
    }
    case 'leave': {
      // The room let a quiet seat go: they're likely back in a moment, so only
      // the Room's timeline notes it.
      const lost = body.reason === 'timeout'
      // Removed: no longer in the team a members-only session is shared with.
      const removed = body.reason === 'removed'
      await note({ ts: event.ts, who, kind: 'leave', text: lost ? 'timeout' : removed ? 'removed' : undefined })
      if (lost) lostAt.set(who, event.ts)
      else if (live && !mine) $.ui.log(removed ? `${who} left: no longer in the team` : `${who} left`)
      break
    }
    case 'prompt':
      if (typeof body.text === 'string') await note({ ts: event.ts, who, kind: 'prompt', text: body.text })
      if (live && !mine && mode === 'host') nudgeSidebar($)
      break
    case 'stop':
      await note({ ts: event.ts, who, kind: 'stop' })
      break
    case 'declined':
      // A message one of this person's sessions wrote here that the host's
      // side couldn't take in: that session hears why.
      if (live && mode === 'guest' && typeof body.pid === 'string' && typeof body.reason === 'string') void declinedRelay($, body.pid, body.reason).catch(() => {})
      break
    case 'approval':
      if (body.pending === false && typeof body.what === 'string') {
        await note({ ts: event.ts, who: room.host, kind: body.allowed ? 'allowed' : 'denied', text: body.what })
      }
      // Settled at the cloud host (answered, its ten minutes, given up): no longer its approver's to answer.
      if (body.pending === false && typeof body.id === 'string' && mode === 'guest') await update($, cloudAsksA, list => list.filter(a => a.id !== body.id))
      break
    // The cloud host's question, for its approver (taken in history too: one
    // asked while their computer slept is still theirs to answer); the
    // approver's answer, for the cloud host, and off every approver's list.
    case 'ask':
      if (mode === 'guest' && (await read($, cloudA))?.mine) await takeCloudAsk($, event, live)
      break
    // The approver changing the cloud host's settings (the room takes it from their seats alone).
    case 'set':
      if (mode === 'host' && (await isRunner($))) await takeSet($, body)
      break
    case 'answer':
      if (mode === 'host' && live) settleCloudAnswer(body)
      else if (mode === 'guest') await update($, cloudAsksA, list => list.filter(a => a.id !== body.id))
      break
    case 'chat':
      if (typeof body.text === 'string') {
        if (live && !mine) await noteMention($, room, who, body.text, 'chat')
        const line: ShareChat = { ts: event.ts, who, seat: event.from.seat, text: body.text }
        await update($, chatA, list => [...list, line].slice(-100))
        // Unread until the chat page shows it; a toast when the Room is shut.
        if (live && !mine && roomOpen && (await read($, roomTabA)) !== 'chat') await update($, unreadA, n => n + 1)
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
      const files = body.files === 'off' ? 'off' : 'on'
      await update($, policyA, (): SharePolicy => ({ prompts, approvals, files }))
      await note({ ts: event.ts, who: room.host, kind: 'policy', text: describePolicy({ prompts, approvals, files }) })
      break
    }
    case 'artifact': {
      const shown = shownOf(event)
      if (!shown) break
      const guest = mode === 'guest', preview = shown.kind === 'preview'
      let kept = shown
      await update($, shownA, list => {
        const old = list.find(s => s.key === shown.key)
        // A guest's ended preview stays ended: the room says when one ends,
        // and its id never comes back (an artifact a host sent late is old).
        if (guest && preview && old?.closed) {
          kept = old
          return list
        }
        kept = guest && preview ? listedAs(s, shown) : shown
        return keptShown([...list.filter(s => s.key !== shown.key), kept])
      })
      await note({ ts: event.ts, who: room.host, kind: 'shown', text: kept.name })
      if (guest && preview) void syncBrowserRoutes($)
      break
    }
    case 'turn':
      if (body.state === 'start') {
        const by = typeof body.by === 'string' ? body.by : room.host
        const prompt = typeof body.prompt === 'string' ? body.prompt : ''
        if (s.live) turnBy = by
        const turn: ShareTurn = { id: String(body.turnId ?? event.seq), who: by, prompt: prompt.replace(/\s+/g, ' ').trim().slice(0, 400), at: event.ts }
        await update($, turnsA, list => (s.live ? [...list.filter(t => t.id !== turn.id), turn].slice(-200) : list))
        if (live && !mine && prompt) await noteMention($, room, by, prompt, 'prompt')
        // A guest's own prompt starting on the host's Claude.
        if (live && mode === 'guest' && by === (await meIn($, room))) void cue($, 'turn')
      } else if (body.state === 'end') {
        const id = String(body.turnId ?? '')
        if (s.live) {
          lastTurnFor = turnBy
          turnBy = null
        }
        await update($, turnsA, list => (s.live ? list.map(t => (t.id === id && t.ms === undefined ? { ...t, ms: typeof body.durationMs === 'number' ? body.durationMs : Math.max(0, event.ts - t.at) } : t)) : list))
      }
      break
    case 'row':
      await noteRow($, room, s, body as unknown as Row, event.ts)
      break
    case 'react':
      if (typeof body.key === 'string' && typeof body.emoji === 'string' && (REACTS as readonly string[]).includes(body.emoji)) {
        const key = body.key
        const emoji = body.emoji
        const on = body.on !== false
        await update($, reactionsA, all => {
          if (!s.live) return all
          const now = all[key]?.[emoji] ?? []
          const next = on ? [...new Set([...now, who])] : now.filter(n => n !== who)
          return { ...all, [key]: { ...all[key], [emoji]: next } }
        })
      }
      break
    case 'seen':
      if (Array.isArray(body.keys)) {
        const keys = body.keys.filter((k): k is string => typeof k === 'string').slice(0, 200)
        await update($, seenA, all => {
          if (!s.live) return all
          const out = { ...all }
          for (const k of keys) out[k] = [...new Set([...(out[k] ?? []), who])]
          return out
        })
      }
      break
    case 'preview': {
      // The host's own preview ended (a guest takes that from the room's
      // list, `takeRoomList`): its Stop, or the room's.
      const pid = typeof body.pid === 'string' && PREVIEW_ID.test(body.pid) ? body.pid : ''
      if (!pid || mode !== 'host' || body.state !== 'closed') break
      let port = body.port
      await update($, shownA, list => {
        if (!s.live) return list
        port = list.find(x => x.kind === 'preview' && x.pid === pid)?.port ?? body.port
        return list.map(x => (x.pid === pid ? { ...x, closed: true, tcp: false } : x))
      })
      await previewEnded($, room, s, mode, pid, port)
      break
    }
  }
}

// A preview the room says has ended (the host: its `closed` event; a guest:
// the room's list leaving it out): nothing reaches it through this session
// any more. Long-lived work, so a reseat meanwhile changes nothing here.
async function previewEnded($: $, room: ShareRoom, s: RoomScope, mode: ShareMode, pid: string, port: unknown) {
  if (!s.live) return
  if (mode === 'host') await unshare($, room, pid)
  if (!s.live) return
  // Stopped by the host just now: the window asking for it again asks the
  // host nothing.
  if (mode === 'guest' && validPort(port)) await noteNeedAsked($, s, port)
  // A guest's page: what only it used here goes with it, as its Close takes
  // it (`onlyUsedBy`), so nothing stays bound at the host's numbers for a
  // page that's gone, however the Stop fell against its Open.
  const unused = mode === 'guest' && validPort(port) ? await onlyUsedBy($, s, { pid, port }) : []
  await stopLocalPreview($, pid, true, s)
  for (const p of unused) await closeMapping($, s, p)
  if (mode === 'guest') void syncBrowserRoutes($, s)
}

const PREVIEW_ID = /^[A-Za-z0-9_-]{1,64}$/

// Shown keeps the newest 40 of what isn't an open preview (20 in a saved
// place), and every open preview, the newest 128: one leaves the list only
// as the room ends it, so the window, Open preview, the Room and a reopened
// session know every preview the host still shares, however much Claude
// showed since.
const SHOWN_KEPT = 40
const PREVIEWS_KEPT = 128
const openPreview = (s: ShareShown) => s.kind === 'preview' && Boolean(s.pid) && !s.closed
function keptShown(list: readonly ShareShown[], others = SHOWN_KEPT): ShareShown[] {
  const previews = new Set(list.filter(openPreview).slice(-PREVIEWS_KEPT))
  const rest = new Set(list.filter(s => !openPreview(s)).slice(-others))
  return list.filter(s => previews.has(s) || rest.has(s))
}

// What the Room's Shown page draws, in order: every open preview (its Stop,
// Allow forwarding, Open and Close are in its row alone), however much
// Claude showed since, and the newest 12 of the rest.
function shownDrawn(list: readonly ShareShown[]): ShareShown[] {
  const rest = new Set(list.filter(s => !openPreview(s)).slice(-12))
  return list.filter(s => openPreview(s) || rest.has(s))
}

// A preview's line in Shown: its title, and whose it is when it was shared
// for another page's sake (an API that page calls).
const previewName = (title: unknown, dependency: number | true | undefined) =>
  `${typeof title === 'string' && title ? title : 'localhost'}${dependency === undefined ? ' (preview)' : ` · used by ${dependency === true ? 'previews' : `localhost:${dependency}`}`}`

// What a preview was forwarded as: forwarded at all, the page it's for, its
// address's spelling and its scheme. Absent fields stay absent.
function forwardedAs(s: Pick<ShareShown, 'tcp' | 'host' | 'scheme' | 'dependency'>): Pick<ShareShown, 'tcp' | 'host' | 'scheme' | 'dependency'> {
  return { ...(s.tcp ? { tcp: true } : {}), ...(s.host ? { host: s.host } : {}), ...(s.scheme ? { scheme: s.scheme } : {}), ...(s.dependency !== undefined ? { dependency: s.dependency } : {}) }
}

// What an artifact event shows in the Room panel.
function shownOf(event: ServerEvent): ShareShown | null {
  const body = event.body
  const kind = body.kind
  if (kind !== 'send' && kind !== 'widget' && kind !== 'file' && kind !== 'page' && kind !== 'preview' && kind !== 'link') return null
  const files = Array.isArray(body.files) ? (body.files as ShareFileMeta[]) : undefined
  // A preview shared for another page's sake (an API it calls): named for that page.
  const dependency = kind === 'preview' ? dependencyOf(body.dependency) : undefined
  const name =
    kind === 'preview'
      ? previewName(body.title, dependency)
      : kind === 'widget'
        ? `a widget${typeof body.title === 'string' ? `: ${body.title.replaceAll('_', ' ')}` : ''}`
        : kind === 'link'
          ? String(body.url ?? 'a page')
          : files?.some(f => f.path) && files.length > 1
            ? `${files[0]!.name} (a page and ${files.length - 1} ${files.length === 2 ? 'file' : 'files'})`
            : (files ?? []).map(f => f.name).join(', ') || 'a file'
  return {
    key: kind === 'preview' && typeof body.pid === 'string' ? `preview:${body.pid}` : `seq:${event.seq}`,
    kind,
    name,
    ...(kind === 'preview' && typeof body.title === 'string' && body.title ? { title: body.title } : {}),
    ts: event.ts,
    files,
    pid: typeof body.pid === 'string' ? body.pid : undefined,
    port: typeof body.port === 'number' ? body.port : undefined,
    path: kind === 'preview' && typeof body.path === 'string' && body.path.startsWith('/') ? body.path : undefined,
    ...(kind === 'preview' ? forwardedAs({ tcp: body.tcp === true, host: previewHost(body.host), scheme: previewScheme(body.scheme), dependency }) : {}),
    url: typeof body.url === 'string' ? body.url : undefined,
  }
}

// ---------------------------------------------------------------------------
// Guest: what the room says is shared. The join answer and every page the
// room sends (each stream line, each events answer) list what's shared now:
// whether a preview is there, and whether it's forwarded, are that list's to
// say, taken before the page's events (`takeRoomList`). How one shows (its
// page, address, scheme, what it's used by) stays its artifact's (`listedAs`).

type RoomPreview = { pid: string; port: number; tcp: boolean; title?: string }

function roomPreviewOf(value: unknown): RoomPreview | null {
  const v = value as Partial<RoomPreview> | null
  if (!v || typeof v !== 'object' || typeof v.pid !== 'string' || !PREVIEW_ID.test(v.pid) || !validPort(v.port)) return null
  return { pid: v.pid, port: v.port, tcp: v.tcp === true, ...(typeof v.title === 'string' && v.title ? { title: v.title.slice(0, 200) } : {}) }
}

// Shown as the room's list says: each preview it lists is there, as
// forwarded as it says, and an open one it doesn't list has ended (one ended
// stays ended: its id never comes back). One new here shows by its title,
// first in Shown (its artifact older, or out of the room's history), until
// its artifact says more.
function listedShown(list: readonly ShareShown[], listed: ReadonlyMap<string, RoomPreview>, now: number): { next: readonly ShareShown[]; ended: ShareShown[] } {
  const ended: ShareShown[] = [], known = new Set<string>()
  let changed = false
  const kept = list.map(x => {
    if (x.kind !== 'preview' || !x.pid) return x
    known.add(x.pid)
    const said = listed.get(x.pid)
    if (x.closed || (said && x.port === said.port && Boolean(x.tcp) === said.tcp)) return x
    changed = true
    if (!said) {
      ended.push(x)
      return { ...x, closed: true, tcp: false }
    }
    const moved: ShareShown = { ...x, port: said.port, tcp: true }
    if (!said.tcp) delete moved.tcp
    return moved
  })
  const fresh = [...listed.values()].filter(p => !known.has(p.pid)).map((p): ShareShown => ({ key: `preview:${p.pid}`, kind: 'preview', name: previewName(p.title ?? `localhost:${p.port}`, undefined), ts: now, pid: p.pid, port: p.port, ...(p.tcp ? { tcp: true } : {}) }))
  return { next: fresh.length ? keptShown([...fresh, ...kept]) : changed ? kept : list, ended }
}

// The room's list of what's shared now (the join answer's, or a page's):
// Shown follows it, and the previews it ended end here too. An artifact
// after it reads it (`RoomScope.listed`).
async function takeRoomList($: $, room: ShareRoom, s: RoomScope, value: unknown) {
  if (!Array.isArray(value) || !s.live || s.mode !== 'guest') return
  const listed = new Map<string, RoomPreview>()
  for (const raw of value.slice(0, 512)) {
    const preview = roomPreviewOf(raw)
    if (preview) listed.set(preview.pid, preview)
  }
  s.listed = listed
  // What waits for the list (a reload's listeners) goes on once Shown says it.
  try {
    const now = await $.clock.now()
    // Most pages change nothing of it: those write nothing.
    const before = await read($, shownA)
    if (listedShown(before, listed, now).next === before) return
    let ended: ShareShown[] = []
    await update($, shownA, list => {
      ended = []
      if (!s.live) return list
      const taken = listedShown(list, listed, now)
      ended = taken.ended
      return [...taken.next]
    })
    for (const x of ended) await previewEnded($, room, s, 'guest', x.pid!, x.port)
    void syncBrowserRoutes($, s)
  } finally {
    s.tookList()
  }
}

// A guest's preview as its artifact shows it, there and forwarded as the
// room's newest list says (taken before the artifact's page): one the list
// doesn't have has ended.
function listedAs(s: RoomScope, shown: ShareShown): ShareShown {
  const said = shown.pid ? s.listed.get(shown.pid) : undefined
  const next: ShareShown = { ...shown }
  delete next.tcp
  return said ? { ...next, port: said.port, ...(said.tcp ? { tcp: true } : {}) } : { ...next, closed: true, tcp: false }
}

// Guest: what the host forwards this moment, oldest first: Shown's open
// previews the room says are forwarded. The window's authority, Open
// preview's list, the Room and a restore all read this one list.
type Forwarded = ShareShown & { kind: 'preview'; pid: string; port: number; tcp: true }
const isForwarded = (s: ShareShown): s is Forwarded => s.kind === 'preview' && typeof s.pid === 'string' && validPort(s.port) && s.tcp === true && !s.closed
const forwardedIn = (shown: readonly ShareShown[]): Forwarded[] => shown.filter(isForwarded)
async function forwardedNow($: $): Promise<Forwarded[]> {
  return (await read($, roomA)) && (await read($, modeA)) === 'guest' ? forwardedIn(await read($, shownA)) : []
}
// What a page uses beside it: what the host forwarded for its port, or for
// every page (`dependency: true`); and the other way, the pages a
// dependency is for. One rule, read both ways.
const dependenciesOf = (forwarded: readonly Forwarded[], page: { pid: string; port: number }) => forwarded.filter(f => f.pid !== page.pid && (f.dependency === true || f.dependency === page.port))
const pagesOf = (forwarded: readonly Forwarded[], dependency: Pick<ShareShown, 'dependency'>) => forwarded.filter(f => f.dependency === undefined && (dependency.dependency === true || f.port === dependency.dependency))
// Where a forwarded page opens: the host's own address, as the host spelled it.
const pageUrl = (page: Forwarded) => previewUrl(page.host, page.port, page.path, page.scheme)
// The room beside the transcript: every turn, the files Claude changed,
// reactions and who saw each reply, mentions, and what each person hears.

// The name this session goes by in the room.
async function meIn($: $, room: ShareRoom): Promise<string> {
  const mine = (await read($, peopleA)).find(p => isMe(p, room.seat))
  return mine?.name ?? (room.seat === 'host' ? room.host : await whoami($))
}

// A sound for something that concerns this person, as their setting allows:
// a mention or their own prompt starting under "mentions", joins too under
// "all"; and, with the voice on, the moment said out loud.
async function prefsOf($: $): Promise<SharePrefs> {
  const kept = (await $.store.get(PREFS_KEY).catch(() => undefined)) as Partial<SharePrefs> | undefined
  return { ...DEFAULT_PREFS, ...(kept && typeof kept === 'object' ? kept : {}) }
}

async function cue($: $, kind: 'join' | 'mention' | 'turn', say?: string) {
  const prefs = await prefsOf($)
  if (prefs.sounds === 'all' || (prefs.sounds === 'mentions' && kind !== 'join')) void $.audio.play({ asset: `sounds/${kind}.wav` }).catch(() => {})
  if (prefs.voice && say) void $.audio.speak(say).catch(() => {})
}

// Someone's prompt or chat line that @mentions this person: a toast, a ping,
// and a reply begun in their empty prompt box.
async function noteMention($: $, room: ShareRoom, who: string, text: string, where: 'prompt' | 'chat') {
  const me = await meIn($, room)
  if (who === me || !mentionsOf(text, [me]).length) return
  const said = text.replace(/\s+/g, ' ').trim()
  $.ui.toast(`${who} mentioned you${where === 'chat' ? ' in the chat' : ''}: ${said.slice(0, 120)}${said.length > 120 ? '…' : ''}`)
  void cue($, 'mention', `${who} mentioned you`)
  void $.prompt.suggest({ text: `@${who} ` }).catch(() => {})
  nudgeSidebar($)
}

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write'])

// Where a call's file sits, as the room names it: the row's own words for an
// edit or a write (relative to the host's project), else its path's tail.
function changedPath(tool: string, text: string, input?: Record<string, unknown>): string {
  if ((tool === 'Edit' || tool === 'Write') && text) return text
  const path = typeof input?.file_path === 'string' ? input.file_path : ''
  return path.split('/').slice(-3).join('/') || text
}

// What a file call changed: the host's hunks when they came with its result,
// else worked out from the call's own input.
function changeOf(call: { tool: string; input?: Record<string, unknown> }, patch?: string): Patch | null {
  if (patch) {
    const lines = patch.split('\n')
    return { patch, added: lines.filter(l => l.startsWith('+')).length, removed: lines.filter(l => l.startsWith('-')).length }
  }
  const i = call.input ?? {}
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  if (call.tool === 'Write' && typeof i.content === 'string') return writeOf(i.content)
  if (call.tool === 'Edit' && typeof i.old_string === 'string') return diffOf(str(i.old_string), str(i.new_string))
  if (call.tool === 'MultiEdit' && Array.isArray(i.edits)) {
    const parts = (i.edits as { old_string?: unknown; new_string?: unknown }[]).map(x => diffOf(str(x.old_string), str(x.new_string)))
    if (!parts.length) return null
    return { patch: parts.map(x => x.patch).join('\n'), added: parts.reduce((n, x) => n + x.added, 0), removed: parts.reduce((n, x) => n + x.removed, 0) }
  }
  return null
}

// A file's patches, newest first, held to what the Changes page draws (cut
// at a hunk's start so it still reads as hunks).
function joinPatches(newer: string, older: string): string {
  const all = `${newer}\n${older}`.split('\n')
  if (all.join('\n').length <= 16_000) return all.join('\n')
  let chars = 0
  let end = 0
  for (let k = 0; k < all.length; k++) {
    chars += all[k]!.length + 1
    if (chars > 16_000) break
    if (all[k]!.startsWith('@@')) end = k
  }
  return all.slice(0, end || all.length).join('\n')
}

// A row of the host's transcript: a call counted, and a call that changed a
// file filed on the Changes page, for whoever's turn it was.
async function noteRow($: $, room: ShareRoom, s: RoomScope, row: Row, ts: number) {
  if (!s.live) return
  if (row.kind === 'tool' && row.id) {
    callsPending += 1 // written once per page (flushCalls)
    if (row.tool && FILE_TOOLS.has(row.tool)) {
      openCalls.set(row.id, { tool: row.tool, path: changedPath(row.tool, row.text, row.input), input: row.input })
      if (openCalls.size > 200) openCalls.delete(openCalls.keys().next().value as string)
    }
    return
  }
  if (row.kind !== 'result' || !row.id) return
  const call = openCalls.get(row.id)
  if (!call) return
  openCalls.delete(row.id)
  if (row.isError) return
  const change = changeOf(call, row.patch)
  if (!change || (!change.added && !change.removed)) return
  const who = turnBy ?? room.host
  await update($, changesA, list => {
    if (!s.live) return list
    const was = list.find(c => c.path === call.path)
    const merged: ShareChange = was
      ? { path: call.path, who, added: was.added + change.added, removed: was.removed + change.removed, patch: joinPatches(change.patch, was.patch), at: ts }
      : { path: call.path, who, ...change, at: ts }
    return [...list.filter(c => c.path !== call.path), merged].slice(-40)
  })
}

// The calls a page of events (or a history replay) counted, written at once,
// while their room is still this session's (what a closed one counted went
// with its state, clearRoomState).
async function flushCalls($: $, s: RoomScope) {
  if (!callsPending || !s.live) return
  const n = callsPending
  callsPending = 0
  await update($, callsA, c => (s.live ? c + n : c))
}

// Guest: the replies that came on screen since the last time, said to the room.
async function flushSeen($: $) {
  if (!pendingSeen.size || (await read($, modeA)) !== 'guest') return
  const keys = [...pendingSeen].slice(0, 100)
  for (const k of keys) {
    pendingSeen.delete(k)
    sentSeen.add(k)
  }
  send($, 'seen', { keys })
}

// The status line under the prompt, for whoever turned it on.
let statusShown = false
async function refreshStatus($: $) {
  const prefs = await prefsOf($)
  const v = await view($)
  if (!prefs.statusLine || v.mode === 'idle' || !v.room) {
    if (statusShown) $.ui.status(undefined)
    statusShown = false
    return
  }
  statusShown = true
  const here = [...new Set(v.everyone.filter(p => p.online).map(p => p.name))]
  const w = v.working
  $.ui.status(`● Live · ${v.mode === 'host' ? 'sharing' : `${v.room.host}'s session`} · ${listNames(here)} here${w ? ` · Claude for ${w.by}` : ''}`)
}

async function setPrefs($: $, change: Partial<SharePrefs>) {
  const next = { ...(await prefsOf($)), ...change }
  await update($, prefsA, () => next)
  await $.store.set(PREFS_KEY, next).catch(() => {})
  await refreshStatus($)
}

// The update command (or either half of it), as the "is out" line gives it.
const UPDATE_TYPED = /^\s*claude\s+plugin\s+(?:marketplace\s+update\s+claude-share|update\s+shared-session(?:@claude-share)?)(?:\s*(?:&&|;)\s*claude\s+plugin\s+(?:marketplace\s+update\s+claude-share|update\s+shared-session(?:@claude-share)?))*\s*$/

// Guest (or anyone who typed it here): the update, run on this computer with
// its own Claude Code (\`claude\` on the PATH, else Claude Desktop's newest),
// then said: in place when this session runs the folder that updates itself,
// else from a new session.
async function updateHere($: $): Promise<{ ok: boolean; text: string }> {
  // Said in the transcript too, as the typed update command always has.
  const say = (ok: boolean, text: string) => {
    $.ui.log(text)
    return { ok, text }
  }
  const home = (await $.env.get('HOME')) ?? ''
  const path = (await $.env.get('PATH')) ?? '/usr/bin:/bin'
  const { out, code } = await sh(
    $,
    [
      `export HOME=${sq(home)} PATH=${sq(path)}`,
      'C=$(command -v claude 2>/dev/null)',
      '[ -n "$C" ] || for d in "$HOME/Library/Application Support/Claude/claude-code"/*/*/claude.app/Contents/MacOS/claude; do [ -x "$d" ] && C="$d"; done',
      '[ -n "$C" ] || { echo "no claude"; exit 3; }',
      '"$C" plugin marketplace update claude-share 2>&1 | tail -1 && "$C" plugin update shared-session@claude-share 2>&1 | tail -1',
      '',
    ].join('\n'),
  )
  if (code !== 0) return say(false, `Couldn't update Shared Sessions here (${out.trim().split('\n').pop() || 'no output'}). In a terminal on this computer, run: ${UPDATE_COMMAND}`)
  let installed = ''
  try {
    const list = JSON.parse(await $.fs.read(`${(await configDirOf($)) ?? `${home}/.claude`}/plugins/installed_plugins.json`))
    installed = String(((list.plugins ?? list)[INSTALLED_ID] as { version?: unknown }[] | undefined)?.find(x => typeof x.version === 'string')?.version ?? '')
  } catch {}
  const mine = await ownVersion($)
  if (runsLive($) && installed && newerThan(installed, mine)) {
    await catchUpFromInstalled($)
    return say(true, `Shared Sessions ${installed} is installed here and loads into this session in place.`)
  }
  if (installed && newerThan(installed, mine)) return say(true, `Shared Sessions ${installed} is installed here. Start a new session to use it (in Claude Desktop, quit and reopen the app); with Updates on in the Room, later releases load in place.`)
  return say(true, `Shared Sessions is up to date here (${installed || mine}).`)
}

// The Update button (the Team panel's header, the Room's Settings): the
// update command run on this computer, as typing it does, and what it did on
// the button's line. A release that loads in place reloads this module; the
// line, kept in state, stays.
async function pressUpdate($: $) {
  if ((await read($, updatingA))?.state === 'running') return
  await update($, updatingA, () => ({ state: 'running' }))
  const done = await updateHere($).catch(error => ({ ok: false, text: `Couldn't update Shared Sessions here: ${String((error as Error)?.message ?? error)}` }))
  const at = await $.clock.now()
  await update($, updatingA, () => ({ state: 'done' as const, ...done, at }))
  // The line goes after two minutes (a module a reload replaced loses this
  // timer: the line's time, checked as it draws, keeps it from staying).
  $.clock.after(120_000, () => void update($, updatingA, u => (u?.state === 'done' && u.at === at ? null : u)))
}

// A newer release, and its Update button, like a Mac app's update prompt:
// "Update and load here" where releases load in place, "Install update"
// where only a new session gets it (with Turn on Updates beside it, in full).
// While it runs and for two minutes after, what it did. Null when there's
// nothing to say. `compact`: the Team panel's header, the button alone.
async function updateRow($: $, el: UI, compact: boolean) {
  const { Box, Text, Button } = el
  const mine = await ownVersion($)
  const newer = await read($, newerA)
  const updates = await read($, updatesA)
  const updating = await read($, updatingA)
  const now = await $.clock.now()
  if (updating?.state === 'running') return <Text key="updating" dimColor>Updating Shared Sessions…</Text>
  if (updating?.state === 'done' && now - updating.at < 120_000) {
    return (
      <Box key="updated" flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
        <Box flexShrink={1} minWidth={0}>
          <Text color={updating.ok ? 'success' : 'error'} wrap={compact ? 'truncate-end' : 'wrap'}>{updating.text}</Text>
        </Box>
        {updating.ok || compact ? null : <Button key="copy-update" label="Copy update command" plain onPress={press => void copyText($, UPDATE_COMMAND, 'Update command copied: paste it in a terminal', press.surface)} />}
      </Box>
    )
  }
  if (!newer || !mine || !newerThan(newer, mine)) return null
  const inPlace = runsLive($) && Boolean(updates)
  return (
    <Box key="update" flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
      <Box flexShrink={1} minWidth={0}>
        <Text color="claude" wrap="truncate-end">{compact ? `● ${newer} is out` : `● Version ${newer} is out (this session runs ${mine})`}</Text>
      </Box>
      <Box flexShrink={0} flexDirection="row" gap={1}>
        {[
          <Button key="update-now" label={inPlace ? 'Update and load here' : 'Install update'} variant="primary" onPress={() => void pressUpdate($)} />,
          compact || updates ? null : <Button key="updates-on" label="Turn on Updates" plain dimColor onPress={() => void writeUpdates($, true)} />,
        ]}
      </Box>
    </Box>
  )
}

// The newest plugin version this session knows of: its own, or the server's.
async function latestKnown($: $): Promise<string> {
  const mine = await ownVersion($)
  const newer = await read($, newerA)
  return newer && (!mine || newerThan(newer, mine)) ? newer : mine
}

// Host: a guest whose plugin is older than the newest, said once each, with
// the command that updates them (in a terminal on their computer, or typed
// in their Claude Code, where their plugin runs it there).
const notedBehind = new Set<string>()
async function noteBehind($: $, people: SharePerson[]) {
  const behind = people.filter(p => p.role === 'guest' && p.version && !notedBehind.has(`${p.name}@${p.version}`))
  if (!behind.length) return
  const latest = await latestKnown($)
  for (const p of behind) {
    notedBehind.add(`${p.name}@${p.version}`)
    if (!latest || !newerThan(latest, p.version!)) continue
    $.ui.log(`${p.name} runs Shared Sessions ${p.version}, older than ${latest}: some of what you show (pictures, pages) may not reach them as it does here. They update with: ${UPDATE_COMMAND}`)
  }
}

async function receive($: $, mode: ShareMode, room: ShareRoom, page: EventsPage) {
  // The room left meanwhile (its scope closed): none of the page is news.
  const s = scope
  if (!stillInRoom(room, s)) return
  const hostWas = (await read($, peopleA)).find(p => p.role === 'host')?.online
  await update($, peopleA, p => (s.live ? page.people : p))
  await update($, cloudA, c => (s.live ? cloudFrom(page.cloud, c) : c))
  if (mode === 'host') await noteBehind($, page.people)
  const hostIs = page.people.find(p => p.role === 'host')?.online
  if (mode === 'guest' && hostWas !== undefined && hostIs !== undefined && hostWas !== hostIs) {
    $.ui.toast(hostIs ? `${room.host} is back` : `${room.host}'s Claude Code closed; the room waits for them`)
  }
  // What's shared now, before the page's events: an artifact among them
  // shows a preview the list has.
  if (mode === 'guest' && !page.ended) await takeRoomList($, room, s, page.previews)
  let seq = room.seq
  for (const event of page.events) {
    if (!s.live) return
    seq = Math.max(seq, event.seq)
    const body = event.body
    await absorb($, room, mode, event, true)
    switch (event.type) {
      case 'prompt':
        if (mode === 'host' && typeof body.text === 'string') {
          await acceptPrompt($, event.from.name, event.from.seat ?? '', body.text, typeof body.pid === 'string' ? body.pid : '', Array.isArray(body.attachments) ? (body.attachments as ShareFileMeta[]) : [], event.from.approver === true)
        }
        break
      case 'stop':
        if (mode === 'host') await stopTurn($, event.from.name)
        break
      case 'cloud':
        await noteCloud($, room, mode, event)
        break
      case 'artifact':
        // Shown during a host turn: that turn's ride makes the call. Otherwise
        // (a /share-file, say) it gets a short turn of its own.
        if (mode === 'guest' && !(typeof body.turnId === 'string' && hostTurns.some(t => t.turnId === body.turnId))) {
          const shown = shownOf(event)
          if (shown) {
            laterRides.push({ text: `${room.host} shared ${shown.name}`, ride: { kind: 'artifact', event } })
            scheduleRides($)
          }
        }
        break
      case 'delta':
        if (mode !== 'guest' || body.turnId !== (await read($, workingA))?.turnId) break
        if (typeof body.text === 'string') {
          const text = body.text
          await update($, workingA, w => (w ? { ...w, tail: `${w.tail}${text}`.slice(-TAIL_CHARS), doing: null } : w))
        } else if (typeof body.thinking === 'string') {
          // Said once: the thinking itself plays in the turn.
          const thinking: ShareDoing = { kind: 'thinking' }
          if ((await read($, workingA))?.doing?.kind !== 'thinking') await update($, workingA, w => (w ? { ...w, doing: thinking } : w))
        } else if (body.drafting && typeof body.drafting === 'object') {
          const d = body.drafting as { tool?: unknown; target?: unknown; chars?: unknown }
          const doing: ShareDoing = { kind: 'writing', tool: String(d.tool ?? ''), target: typeof d.target === 'string' ? d.target : '', chars: Number(d.chars) || 0 }
          await update($, workingA, w => (w ? { ...w, doing } : w))
        }
        break
      case 'row':
        // A call made: it runs until its result comes back.
        if (mode === 'guest') {
          const row = body as unknown as Row
          if (row.kind === 'tool' && row.tool) {
            const doing: ShareDoing = { kind: 'running', tool: row.tool, target: (row.text ?? '').split('\n')[0]!.slice(0, 80) }
            await update($, workingA, w => (w ? { ...w, doing } : w))
          } else if (row.kind === 'result' || row.kind === 'assistant') {
            await update($, workingA, w => (w?.doing ? { ...w, doing: null } : w))
          }
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
          await update($, roomA, r => (r && s.live ? { ...r, title } : r))
        }
        break
      case 'ended':
        await closeRoom($, 'ended', { room, log: mode === 'guest' ? `${room.host} stopped sharing this session.` : 'This shared session ended.' })
        return
    }
  }
  await update($, roomA, r => (r && r.id === room.id && s.live ? { ...r, seq: Math.max(r.seq, seq) } : r))
  await flushCalls($, s)
  await refreshStatus($)
  if (mode === 'guest') scheduleRides($)
}

// ---------------------------------------------------------------------------
// Ways out of a room: Leave (`leave`), Stop sharing (`stop`), the room ending
// or refusing this seat (`ended`), the session closing with its place kept
// (`keep`), and a /clear or a logout (`clear`: a guest leaves, a host
// stops). Each goes in one order:
// 1. the room's scope closes, at once: nothing of it starts or lands from
//    here on; its feed stops, the public link's work ends, and what runs
//    here for it (listeners, the window's proxy, the TCP worker) is told to
//    stop; then the mode goes idle, with a marker of the close (`closingA`):
//    a prompt typed from now on is this person's own, a host's turn goes
//    nowhere, nothing offers Share or Join until the close is done, and a
//    Share, a Join or a start waits for it (`roomClosed`);
// 2. the place: saved for a session closing (`keep`), else deleted, before
//    anything slow;
// 3. the window: kept with its place, it's closed (begun before the save),
//    its profile kept; left for good, it's closed and a room's profile goes,
//    once a window still opening has finished (briefly);
// 4. local work has ended (and a host closing its session sends what's
//    waiting);
// 5. the server hears it: a guest's Leave, the host's end; told, the room
//    (its token) leaves the state;
// 6. the room's state clears, and with it the marker;
// 7. what happened is said.
// A session ending has one short bound for all of it (1.5 s): there the
// window is told to close and a room's profile moved aside at once, and the
// server told, before anything waits; what can wait comes last. A close cut
// short (that bound, or a reload ending the module partway) leaves its
// marker, and is finished by what waits for it (`finishClose`), never its
// room taken up again.
// One at a time: another way out meanwhile (the room ending as the person
// leaves it) waits for the first, and finds nothing more to close.
type Exit = 'leave' | 'stop' | 'ended' | 'keep' | 'clear'
type ExitOptions = { room?: { server: string; id: string }; log?: string; sessionId?: string }
let closing: Promise<void> | null = null
// The marker as this module knows it: the marker itself while a close of its
// own has it up (one cut short, its `$` calls refused at the session's end
// bound, leaves it so); `down`; `unknown` until the start looks (a reload
// may have cut a close, whose marker the state still holds). Every read of
// one dispatch sees one moment (its first read's, until it writes), so this,
// not a read after waiting, says whether a close here has cleared it since.
let closeMark: { how: Exit; room: string } | 'down' | 'unknown' = 'unknown'

function closeRoom($: $, how: Exit, opts: ExitOptions = {}): Promise<void> {
  if (closing) return untilClosed($)
  const s = scope, live = s.live
  // A room this session is no longer in (an old feed's news of it): nothing here.
  if (opts.room && !(live && s.key === roomIdentity(opts.room))) return Promise.resolve()
  // 1. At once, before anything waits: what runs for it (`RoomChildren`) too.
  const stopping = s.close(how === 'keep' ? 'keep' : 'end')
  pollGeneration += 1
  stopStream()
  clearHostAsks()
  closing = closeSteps($, s, live, how, opts, stopping)
    .catch(error => {
      try {
        $.ui.log(`Shared session: closing the room: ${String((error as Error)?.message ?? error)}`, { to: 'debug' })
      } catch {}
    })
    .finally(() => {
      closing = null
    })
  return closing
}

// A close running here, waited for (by another way out, a Share, a Join, a
// start) in `nap`s, which the waiting hook's own budget doesn't pay for: a
// close takes as long as telling the room does (Stop sharing on a stalled
// network), and a /share-session, a pasted link's join or a start waiting
// on it as a plain promise ran out of its 10 s, the engine answering in the
// plugin's place. One begun meanwhile is waited for too.
async function untilClosed($: $) {
  while (closing) await Promise.race([closing, nap($, 250)])
}

// A Share, a Join or a start waits for a room being closed: its state clears
// first. One whose close was cut short is finished first, once: a start
// looks for its marker (a reload may have cut it); the rest finish one this
// module's own close left up. A Share or a Join here waits for a room being
// taken back first, and gives a late one up (`takenBack`), unless it may
// only ask (`keep`: /share-session asking which to share gives nothing up).
// What it gave up comes back to it: over once its own room is made or
// joined, and kept if it isn't (`roomMade`, `notMade`).
async function roomClosed($: $, opts: { start?: boolean; keep?: boolean } = {}): Promise<Reclaim | null> {
  const gaveUp = opts.start ? null : await takenBack($, { keep: opts.keep })
  await untilClosed($)
  if (closeMark === 'unknown' && opts.start) {
    const up = await read($, closingA)
    if (closeMark === 'unknown') closeMark = up ?? 'down'
  }
  if (typeof closeMark === 'object' && !closing) {
    closing = finishClose($, closeMark)
      .catch(error => {
        try {
          $.ui.log(`Shared session: finishing leaving the room: ${String((error as Error)?.message ?? error)}`, { to: 'debug' })
        } catch {}
      })
      .finally(() => {
        closing = null
      })
  }
  await untilClosed($)
  return gaveUp
}

// A close running here, its marker up: the row and the Room offer no Share
// until it's done. A marker no close here runs for (one cut short) hides
// nothing: Share finishes that close first.
async function closingNow($: $): Promise<boolean> {
  return closing !== null && Boolean(await read($, closingA))
}

// A close cut short: the session's end ran out of time, or a reload ended
// the module partway (the engine cancels its waits). Its marker says how it
// was going: what's left of it is done here as the close would have, and the
// room isn't taken up again. The server hears it (a guest's Leave, the
// host's end) where the room is still set (told, the close drops it),
// unless the session was closing with its place kept or the room had ended;
// left for good, a guest's window closes and a room's profile goes.
async function finishClose($: $, cut: { how: Exit; room: string }) {
  const room = await read($, roomA)
  // A room live here now, or another set since: only the marker goes.
  if (!scope.live && (!room || roomIdentity(room) === cut.room)) {
    const guest = room ? room.seat !== 'host' : false, forGood = cut.how !== 'keep'
    const w = room && guest && forGood ? await read($, previewWindowA) : null
    await update($, modeA, () => 'idle')
    if (room && (cut.how === 'leave' || cut.how === 'stop' || cut.how === 'clear')) await tellRoom($, room, guest)
    if (room && w?.room === roomIdentity(room)) await endPreviewWindow($, room, w).catch(() => {})
    await clearRoomState($, forGood ? { unmark: room && guest ? `${room.host}'s session · ${room.title}`.slice(0, 120) : true } : {})
  }
  await update($, closingA, () => null)
  closeMark = 'down'
}

type WindowEnd = { dir: string; profile: string; name: string; port: number }

async function closeSteps($: $, s: RoomScope, live: boolean, how: Exit, opts: ExitOptions, stopping: Promise<void>) {
  const room = await read($, roomA), stateMode = await read($, modeA)
  // The room as its scope knew it, else as the state has it (a reload whose
  // start hasn't taken it up yet).
  const mode = live ? s.mode : stateMode === 'idle' ? null : stateMode
  if (!room || !mode || (live && roomIdentity(room) !== s.key)) return void (await stopping)
  const guest = mode === 'guest', forGood = how !== 'keep'
  // Out of the room for all the mode drives, before anything waits. The
  // marker first: a start finding it finishes the close (`finishClose`).
  const mark = (closeMark = { how, room: roomIdentity(room) })
  await update($, closingA, () => mark)
  await update($, modeA, () => 'idle')
  const place = `${guest ? JOINED_KEY : HOSTING_KEY}${opts.sessionId ?? (await $.session.id())}`
  // The window as it is now, read before anything clears what it's read from.
  const w = guest ? await read($, previewWindowA) : null
  const win: WindowEnd | null = w?.room === roomIdentity(room) ? { ...(await profileOf($, room)), port: w.port } : null
  // On a host's profile, only the window on this session's proxy port.
  const onPort = win && hostProfile(win.name) ? win.port : undefined
  // Kept with its place: the window closes first, and fast (it reaches
  // nothing once its proxy is gone), begun before the place is saved.
  const closingWindow = win && !forGood ? killWindow($, win.profile, false, onPort).catch(() => {}) : null
  // 2. The place.
  if (how === 'keep') {
    try {
      await writeRoomCheckpoint($, place, guest ? await joinedPlace($, room) : await hostingPlace($, room))
    } catch (error) {
      $.ui.log(`${guest ? "Couldn't save the joined session for reopening" : "Couldn't save the shared session for reopening"}: ${String((error as Error)?.message ?? error)}`)
    }
  } else if (how !== 'ended') await deleteRoomCheckpoint($, place).catch(() => {})
  // 3. The window.
  if (closingWindow) await closingWindow
  else if (how === 'clear') {
    // In the bound: told to close, and a room's profile (its sign-ins and
    // cookies) out of the way at once; then the room hears of it (5, here).
    if (win) await endPreviewWindow($, room, { profile: win.name, port: win.port }, false).catch(() => {})
    await tellRoom($, room, guest)
    await update($, roomA, () => null)
  } else if (guest) await endWindow($, s, room, win)
  // 4. Local work.
  await stopping
  // A host closing its session: what Claude said last, if the exit gives it time.
  if (how === 'keep' && !guest) await flush($)
  // 5. The room hears it. Told, its token leaves the state (what follows
  // reads the room from here): a close cut short from here never tells it
  // twice, nor takes a seat in it again.
  if (how === 'leave' || how === 'stop') {
    await tellRoom($, room, guest)
    await update($, roomA, () => null)
  }
  // 6. The room's state; left for good, the sidebar row goes back as it was.
  await clearRoomState($, forGood ? { unmark: guest ? `${room.host}'s session · ${room.title}`.slice(0, 120) : true } : {})
  await update($, closingA, () => null)
  closeMark = 'down'
  // 7.
  const said = how === 'ended' ? opts.log : how === 'keep' ? undefined : guest ? `Left ${room.host}'s session.` : 'Stopped sharing. The link no longer works.'
  if (said) $.ui.log(said)
  // What can wait, last in the bound: a window still opening closes what it
  // started, and left for good, the room's profile goes again (anything a
  // browser quitting made of it anew).
  if (guest && (how === 'keep' || how === 'clear')) await endWindow($, s, room, forGood ? win : null)
}

// A window still opening finishes first (three seconds at most), closing
// what it started; then, left for good, the room's window (`win`) closes and
// a room's profile goes.
async function endWindow($: $, s: RoomScope, room: ShareRoom, win: WindowEnd | null) {
  await windowsSettled($, s, 3_000)
  if (win) await endPreviewWindow($, room, { profile: win.name, port: win.port }).catch(() => {})
}

// The room hears this session is out of it: a guest's Leave, the host's end.
async function tellRoom($: $, room: { server: string; id: string; token: string }, guest: boolean) {
  await api($, room.server, `/api/rooms/${room.id}/${guest ? 'leave' : 'end'}`, { method: 'POST', token: room.token }).catch(() => {})
}

// The room's state, cleared: what's of the room, then the room, last. The
// mode went idle as its close began (`closeSteps`, `finishClose`); a place
// still being taken back never set it. `unmark`: the sidebar row goes back
// as it was (`true`), or with that title (a guest's: whose session it was).
async function clearRoomState($: $, opts: { unmark?: string | true } = {}) {
  await update($, previewWindowA, () => null)
  await update($, previewNeedsOpenA, () => [])
  await update($, hostAskA, () => null)
  await update($, hostMemoryA, () => null)
  await update($, needAskedA, () => null)
  await update($, peerRoutesA, () => ({}))
  await update($, peerRelaysA, () => [])
  await update($, peerSendsA, () => [])
  relaysHere.length = 0
  await update($, localPreviewsA, () => [])
  hostAsking.clear()
  if (opts.unmark) await unmarkSidebar($, opts.unmark === true ? undefined : opts.unmark)
  outbox = []
  singly = 0
  unsent.clear()
  hostTurns.length = 0
  ownPending.clear()
  ridesByText.clear()
  laterRides.length = 0
  rideSubmitted = false
  hostCalls.clear()
  staticRuns.clear()
  replayRuns.clear()
  openRuns.clear()
  mentionedPorts.clear()
  await update($, guestPromptsA, () => [])
  await update($, peopleA, () => [])
  await update($, workingA, () => null)
  await update($, activityA, () => [])
  await update($, chatA, () => [])
  await update($, unreadA, () => 0)
  await update($, policyA, () => DEFAULT_POLICY)
  await update($, trustedA, () => [])
  await update($, ownersA, () => ({}))
  await update($, shownA, () => [])
  await update($, sharesA, () => ({}))
  await update($, askingA, () => null)
  await update($, connectionA, () => 'live')
  await update($, confirmingA, () => null)
  // Every call waiting is declined, not only the one the row shows; one up in
  // the dialog is a no as its answer comes (the room it was asked in is over).
  for (const ask of approvals.filter(a => a.stage !== 'dialog')) ask.answer('Decline')
  await update($, approvingA, () => null)
  await update($, turnsA, () => [])
  await update($, changesA, () => [])
  await update($, cloudA, () => null)
  await update($, cloudAsksA, () => [])
  await update($, cloudTrustedA, () => [])
  await update($, reactionsA, () => ({}))
  await update($, seenA, () => ({}))
  await update($, replyForA, () => ({}))
  await update($, callsA, () => 0)
  turnBy = null
  openCalls.clear()
  callsPending = 0
  patches.clear()
  pendingSeen.clear()
  sentSeen.clear()
  seenTimer?.cancel()
  seenTimer = null
  lastTurnFor = null
  await refreshStatus($)
  savedNames.clear()
  await update($, roomA, () => null)
  void holdRoom($).catch(() => {})
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
  if (policy.files === 'off') return `${describePolicyCore(policy)}, files kept to the host`
  return describePolicyCore(policy)
}

function describePolicyCore(policy: SharePolicy): string {
  const prompts = policy.prompts === 'watch' ? 'watch-only' : 'everyone can prompt'
  const approvals =
    policy.approvals === 'none' ? 'no approvals' : policy.approvals === 'all' ? 'every tool needs approval' : 'anything beyond reading the project needs approval'
  return `${prompts}, ${approvals}`
}

// ---------------------------------------------------------------------------
// Claude Desktop's sidebar, through the MCP tools the app attaches to every
// session it runs (`ccd_session_mgmt`, `ccd_sidebar`): a live session gets a
// "👥" title and a pin while it is shared, and a blue dot when teammates talk.
// Elsewhere (a terminal, a headless run) the servers are absent: no-ops.

type DeskServer = 'ccd_session_mgmt' | 'ccd_sidebar' | 'ccd_view'

// Only Claude Desktop has these servers. Elsewhere a call to one can sit
// unanswered while a turn runs (the interactive terminal), holding up every
// other call this plugin makes, so outside Desktop it isn't made at all.
let inDesktop: boolean | undefined
async function isDesktop($: $) {
  if (inDesktop === undefined) inDesktop = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'
  return inDesktop
}
async function desk($: $, server: DeskServer, tool: string, args: Record<string, unknown>, failed?: (why: string) => void) {
  if (!(await isDesktop($))) return null
  try {
    const result = await $.mcp.call(server, tool, args)
    const text = result.content.map(block => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('')
    if (result.isError) {
      $.ui.log(`${server}.${tool}: ${text.slice(0, 200)}`, { to: 'debug' })
      failed?.(text)
      return null
    }
    return text
  } catch (error) {
    const why = String((error as Error)?.message ?? error)
    $.ui.log(`${server}.${tool} unavailable: ${why.slice(0, 200)}`, { to: 'debug' })
    failed?.(why)
    return null
  }
}

async function sessionInfo($: $, id: string): Promise<{ sessionId?: unknown; title?: unknown; pinned?: unknown } | null> {
  const raw = await desk($, 'ccd_session_mgmt', 'get_session', { session_id: id })
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

// The sidebar's own tools are told which session by its id: from a plugin's
// call, "self" has been seen to change nothing there while the title, set the
// same way through ccd_session_mgmt, did change.
let selfId = ''

// Pins or unpins this session's row, by id and then by "self", and checks it
// took; a pin that won't stick is said in the transcript, not just the debug log.
// Desktop's sidebar tools the plugin calls: harmless (a title, a pin, an
// unread dot), but auto mode's classifier often gives a plugin's own call to
// them no verdict, which refuses it. Allow rules for exactly these let them
// through; the Room offers to add them when a pin was refused.
const DESK_TOOLS = ['mcp__ccd_sidebar__set_pinned', 'mcp__ccd_sidebar__set_unread', 'mcp__ccd_session_mgmt__get_session', 'mcp__ccd_session_mgmt__set_session_title']

// What the plugin tried when pinning, kept in the store (the last 30, every
// session's) and the debug log: pins fail on other people's machines.
const PIN_LOG = 'pinLog'
async function notePin($: $, line: string) {
  $.ui.log(`Shared session pin: ${line}`, { to: 'debug' })
  try {
    const log = ((await $.store.get(PIN_LOG)) as { at: number; line: string }[] | undefined) ?? []
    await $.store.set(PIN_LOG, [...log, { at: await $.clock.now(), line: line.slice(0, 300) }].slice(-30))
  } catch {}
}

// Whether the row is as asked (or Desktop can't say).
async function pinTook($: $, pinned: boolean) {
  const after = await sessionInfo($, selfId || 'self')
  return !after || (after.pinned === true) === pinned
}

// A pin refused (auto mode) is tried again after 20 s and a minute, then
// said once, with Allow pinning above the prompt and in the Room. In auto
// mode only an allow rule lets it through: Desktop's own check that the call
// is about the caller's session misreads the id, so the call goes to auto
// mode's classifier, which runs on the server and reviews only calls a model
// turn produced; a plugin's has none behind it ("the request that produced
// this action did not ask for one"), so it gets no verdict, whatever it says.
async function setPinned($: $, pinned: boolean, attempt = 0) {
  const place = await placeOf($)
  let why = ''
  // Pinned: said, so a reload doesn't pin again a row the person unpinned since.
  const took = async () => {
    if (await read($, pinRefusedA)) await update($, pinRefusedA, () => false)
    await update($, sidebarA, s => (s ? { ...s, pinOk: true } : s))
  }
  for (const id of [...new Set([selfId, place, 'self'].filter(Boolean))]) {
    if ((await desk($, 'ccd_sidebar', 'set_pinned', { session_id: id, pinned }, text => void (why = text))) === null) continue
    if (await pinTook($, pinned)) {
      if (pinned) await took()
      return
    }
  }
  if (!pinned || !(await isDesktop($))) return
  await notePin($, `refused (try ${attempt + 1}): ${why || "the row didn't change"}`)
  const retries = [20_000, 60_000]
  if (attempt < retries.length) {
    $.clock.after(retries[attempt] ?? 60_000, () => {
      // Still marked (still sharing or joined): try again.
      void read($, sidebarA)
        .then(marked => (marked ? setPinned($, true, attempt + 1) : undefined))
        .catch(() => {})
    })
    return
  }
  // Said by the row's Pin button and the Room's settings, not in the transcript.
  await update($, pinRefusedA, () => true)
}

// Adds allow rules for exactly `tools` to the person's settings (where Claude
// Code reads them, `settingsFile`), the rest kept, on the person's press of a
// button that names what they allow; said with `said`. Whether it was written.
async function allowTools($: $, tools: readonly string[], said: string): Promise<boolean> {
  const found = await readSettings($)
  if (!found) {
    $.ui.toast(`Couldn't read ${(await settingsFile($)) ?? 'your Claude Code settings'}, so nothing changed`)
    return false
  }
  const permissions = { ...((found.settings.permissions ?? {}) as Record<string, unknown>) }
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]).filter((r): r is string => typeof r === 'string') : []
  permissions.allow = [...allow, ...tools.filter(t => !allow.includes(t))]
  try {
    await $.fs.write(found.path, `${JSON.stringify({ ...found.settings, permissions }, null, 2)}\n`)
  } catch {
    $.ui.toast(`Couldn't change ${found.path}`)
    return false
  }
  $.ui.toast(said)
  return true
}

// Allow pinning: rules for the sidebar tools above; then it pins.
async function allowDeskTools($: $) {
  if (await allowTools($, DESK_TOOLS, 'Pinning allowed: shared sessions pin themselves again')) await setPinned($, true, 2)
}

// Marks this session's row: retitles it (keeping what it was) and pins it.
async function markSidebar($: $, title: (current: string) => string) {
  const info = await sessionInfo($, 'self')
  if (info === null) return
  if (typeof info.sessionId === 'string') selfId = info.sessionId
  // The row as it was before any share: a mark an earlier share left (an app
  // that quit mid-share, a room taken back up) is not part of it.
  const current = unmarked(typeof info.title === 'string' ? info.title : '')
  const pinned = info.pinned === true
  if (!(await read($, sidebarA))) await update($, sidebarA, () => ({ title: current, pinned, id: selfId || undefined }))
  await desk($, 'ccd_session_mgmt', 'set_session_title', { session_id: 'self', title: title(current).slice(0, 120) })
  if (!pinned) await setPinned($, true)
}

// A title without the marks sharing and joining put in front of it.
// A session's name as a message from it is signed: its sidebar marks left out.
const tidySender = (name: string) => unmarked(name.trim()).slice(0, 80) || 'another session'
const unmarked = (title: string) => title.replace(/^(?:👥 [^·]{1,80} · )+/u, '').replace(/^(?:[^·]{1,80}'s session · )+/u, '')

// A row sharing or joining marked whose pin never took (refused in auto
// mode before pinning was allowed): pinned when the plugin loads again, an
// update in place included, and within a minute of pinning being allowed in
// any session (`repinIfAllowed`).
async function repinMarked($: $) {
  const marked = await read($, sidebarA)
  const room = await read($, roomA)
  const mode = await read($, modeA)
  if (!marked || marked.pinned || marked.pinOk || !room || mode === 'idle') return
  const info = await sessionInfo($, 'self')
  if (!info) return
  if (typeof info.sessionId === 'string') selfId = info.sessionId
  if (info.pinned === true) return void (await update($, sidebarA, s => (s ? { ...s, pinOk: true } : s)))
  await notePin($, 'pinning again: the pin made when this session was marked never took')
  await setPinned($, true)
}

// Pinning refused here, and allowed since (Allow pinning in any session):
// this row pins now rather than at the next load.
async function repinIfAllowed($: $) {
  if (!(await read($, pinRefusedA))) return
  const allow = ((await readSettings($))?.settings.permissions as { allow?: unknown } | undefined)?.allow
  if (Array.isArray(allow) && allow.includes('mcp__ccd_sidebar__set_pinned')) await repinMarked($)
}

// Puts the row back: the title it had (or `title`), unpinned unless it was pinned.
async function unmarkSidebar($: $, title?: string) {
  const saved = await read($, sidebarA)
  if (!saved) return
  await update($, sidebarA, () => null)
  if (saved.id) selfId = saved.id
  const restored = title ?? saved.title
  if (restored) await desk($, 'ccd_session_mgmt', 'set_session_title', { session_id: 'self', title: restored })
  if (!saved.pinned) await setPinned($, false)
}

function nudgeSidebar($: $) {
  void desk($, 'ccd_sidebar', 'set_unread', { session_id: selfId || 'self', unread: true })
}

// ---------------------------------------------------------------------------
// Host

// Share asked for (a press, /share-session, the Room, the share question's
// answers) goes in turns, one at a time (`inShareTurn`): each once the one
// before is done, and before it reads anything, since every read of one
// dispatch sees one moment. Asked for twice at once, one room is made, and
// the second is a session sharing already. A turn waits in `nap`s, which
// the hook's own budget doesn't pay for: a /share-session waiting on the
// turn before as a plain promise ran out of its 10 s behind a Share that
// took longer (a late take-back's wait, a long transcript read twice, a
// slow network), and the engine answered it without the plugin.
let shareTurn: { done: boolean; settled: Promise<void> } = { done: true, settled: Promise.resolve() }
async function inShareTurn<T>($: $, work: () => Promise<T>): Promise<T> {
  const before = shareTurn
  let settle!: () => void
  const mine = { done: false, settled: new Promise<void>(done => { settle = done }) }
  shareTurn = mine
  try {
    while (!before.done) await Promise.race([before.settled, nap($, 250)])
    return await work()
  } finally {
    mine.done = true
    settle()
  }
}

// Share pressed. Sharing sends everything earlier to everyone with the link,
// so a session with earlier prompts asks first, in the row above the prompt
// (and the Room), whether to include them; a fresh one shares at once. It
// goes in its turn, and waits for a room being taken back before it reads
// anything. Asking first gives nothing up: only the share that makes a room
// (`share`, through `roomClosed`) gives a late one up, so a Cancel leaves it
// to come back.
function requestShare($: $, surface?: RenderSurface): Promise<void> {
  return inShareTurn($, async () => {
    await takenBack($, { keep: true })
    // Late, on its way back still, it hasn't set the mode: idle, until it's
    // back or given up. Not read then: a read now would be what `share`
    // sees, should the room come back meanwhile.
    const idle = takingBack !== null || (await read($, modeA)) === 'idle'
    const prompts = idle ? await earlierPrompts($) : 0
    if (prompts === 0) {
      await share($, surface)
      return
    }
    await update($, askingA, () => ({ prompts }))
  })
}

// The prompts typed in this session so far.
async function earlierPrompts($: $): Promise<number> {
  const name = await whoami($)
  const cwd = await $.session.cwd()
  return (await sessionHistory($)).flatMap(m => rowsFromMessage(m, name, cwd)).filter(row => row.kind === 'user').length
}

// The whole conversation as the session stored it. What Claude still holds
// (`session.messages`) starts, after a compaction, at its summary, so a long
// session would share only its last stretch; the transcript file keeps every
// message (the summaries and subagents' messages left out). The newest
// HISTORY_MESSAGES of it; without the file, what Claude holds.
//
// Read newest line first through a child (a plugin's own file read refuses
// anything over 4 MiB, and a long session's transcript is many times that),
// stopping once there's enough. A session reopened after a compaction goes
// on in a new file that starts at the summary: its oldest message's parent
// is a row of the file before, read on from there back.
const HISTORY_MESSAGES = 6000
type HistoryMessage = { role?: string; content: unknown }
async function sessionHistory($: $): Promise<HistoryMessage[]> {
  try {
    const id = await $.session.id()
    if (/^[\w-]{8,80}$/.test(id)) {
      const found = await sh($, `ls -1 "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${id}.jsonl 2>/dev/null | head -1\n`)
      let path = found.out.trim()
      const newest: HistoryMessage[] = []
      const keep = { pictures: 0 }
      let upTo = 0 // read the file's lines before this one only (0: all of it)
      const read = new Set<string>()
      while (path && !read.has(path) && newest.length < HISTORY_MESSAGES) {
        read.add(path)
        const parent = await readBackward($, path, upTo, newest, keep)
        if (!parent || newest.length >= HISTORY_MESSAGES) break
        // The row it goes on from, in another file of the same project.
        const dir = path.slice(0, path.lastIndexOf('/'))
        const at = await sh(
          $,
          `f=$(grep -l -F ${sq(`"uuid":"${parent}"`)} ${sq(dir)}/*.jsonl 2>/dev/null | grep -v -F ${sq(path)} | head -1)\n[ -n "$f" ] && printf '%s\\n%s' "$(grep -n -F ${sq(`"uuid":"${parent}"`)} "$f" | head -1 | cut -d: -f1)" "$f"\n`,
        )
        const [line, next] = at.out.trim().split('\n')
        upTo = Number(line) || 0
        path = upTo && next ? next : ''
      }
      if (newest.length) return newest.reverse()
    }
  } catch {}
  const held = await $.session.messages({ as: 'api' }).catch(() => [])
  return Array.isArray(held) ? (held as HistoryMessage[]) : []
}

// One transcript, newest line first (its lines up to `upTo` only, when given),
// each conversation message into `out` until it holds HISTORY_MESSAGES; the
// pictures of all but the newest HISTORY_IMAGES results are left out as it
// goes. Returns the parent of the oldest message it reached, when it read
// back to the file's start without filling up.
async function readBackward($: $, path: string, upTo: number, out: HistoryMessage[], keep: { pictures: number }): Promise<string | null> {
  const source = upTo > 0 ? `head -n ${upTo} ${sq(path)}` : `cat ${sq(path)}`
  const child = $.process.spawn({
    argv: ['/bin/sh', '-s'],
    input: `${source} | { if command -v tac >/dev/null 2>&1; then tac; else tail -r; fi; } | grep -E '"type":"(user|assistant)"'\n`,
  })
  let parent: string | null = null
  // false: enough read, stop.
  const take = (line: string): boolean => {
    let d: { type?: unknown; isSidechain?: unknown; isCompactSummary?: unknown; parentUuid?: unknown; message?: { role?: unknown; content?: unknown } }
    try {
      d = JSON.parse(line)
    } catch {
      return true
    }
    if (d.type !== 'user' && d.type !== 'assistant') return true
    parent = typeof d.parentUuid === 'string' ? d.parentUuid : null
    if (d.isSidechain || d.isCompactSummary || !d.message) return true
    let content = typeof d.message.content === 'string' ? [{ type: 'text', text: d.message.content }] : d.message.content
    if (!Array.isArray(content)) return true
    // Pictures in results past the newest few: left out (a history carries those only).
    content = (content as { type?: unknown; content?: unknown }[]).map(b => {
      if (b?.type !== 'tool_result' || !Array.isArray(b.content) || !b.content.some((x: { type?: unknown }) => x?.type === 'image')) return b
      return keep.pictures++ < HISTORY_IMAGES ? b : { ...b, content: (b.content as { type?: unknown }[]).filter(x => x?.type !== 'image') }
    })
    out.push({ role: String(d.message.role ?? d.type), content })
    return out.length < HISTORY_MESSAGES
  }
  let buf = ''
  try {
    for await (const chunk of child) {
      if (chunk.stream !== 'stdout') continue
      buf += chunk.text
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line && !take(line)) return null // full: leaving the loop ends the child
      }
    }
    if (buf && !take(buf)) return null
  } catch {}
  return parent
}

// `history: false` shares only what happens from now on: nothing earlier goes
// out, not even the first prompt as the room's title. Signed in, it goes to
// the team the Team panel shows (listed for its people, its access setting
// saying who joins); `team: false` shares by link alone. Called in a share
// turn (`inShareTurn`), so a session sharing already is what it reads.
async function share($: $, surface?: RenderSurface, opts: { history?: boolean; team?: boolean } = {}): Promise<ShareRoom> {
  // A room being left finishes first: its state clears before this one's.
  // A late take-back it gives up is over once this room is made, and kept if
  // it isn't (`roomMade`, `notMade`).
  const gaveUp = await roomClosed($)
  return makeRoom($, surface, opts).catch(error => notMade($, gaveUp, error))
}

// The room made, and this session sharing it (or the one it shares already).
async function makeRoom($: $, surface: RenderSurface | undefined, opts: { history?: boolean; team?: boolean }): Promise<ShareRoom> {
  const mode = await read($, modeA)
  if (mode === 'guest') throw new Error('Leave the session you joined before sharing this one.')
  await update($, askingA, () => null)
  const existing = await read($, roomA)
  if (mode === 'host' && existing) {
    await copyLink($, existing.url, surface)
    return existing
  }

  const server = await serverOf($)
  const name = await whoami($)
  const cwd = await $.session.cwd()
  const messages = opts.history === false ? [] : await sessionHistory($)
  const firstPrompt = messages.flatMap(m => rowsFromMessage(m, name, cwd)).find(row => row.kind === 'user')?.text
  const folder = cwd.split('/').filter(Boolean).at(-1) ?? 'session'
  const said = firstPrompt ? promptWords(firstPrompt) : ''
  const title = said ? `${folder}: ${said.slice(0, 80)}` : folder
  // Signed in, the room knows the host by account (their other sessions are
  // them); the team, unless sharing by link alone.
  const signedIn = await signInFor($, server)
  const team = signedIn && opts.team !== false ? await shareTeam($, server) : null

  const created = await api<{ id: string; url: string; token: string; seq: number; title: string; latest?: string; team?: { id: string; name: string } }>(
    $,
    server,
    '/api/rooms',
    { method: 'POST', body: { name, title, fromNow: opts.history === false || undefined, team: team?.id }, account: signedIn?.token },
  )
  // Made: a late take-back given up for it is over.
  roomMade($)
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
    team: created.team ?? null,
  }
  // Its scope, before the room is anyone's to see.
  const s = openScope(room, 'host')
  await update($, roomA, () => room)
  await update($, modeA, () => 'host')
  await update($, invitedA, () => ({}))
  void readUpdates($).then(() => noteLatest($, created.latest))
  await update($, peopleA, () => [{ id: 'host', name, role: 'host', online: true }])

  // What happened before Share, so people who join see the whole session,
  // and the dev servers Claude opened then, still running, open for them too.
  // The newest rows a room keeps (it holds 5000 events), oldest first.
  const earlier = messages.flatMap(message => rowsFromMessage(message, name, cwd)).slice(-4000)
  // Pictures from the newest results only: a room holds 100 MB of files.
  let pictures = 0
  const withPictures = new Set(earlier.filter(r => r.media?.length).reverse().filter(() => pictures++ < HISTORY_IMAGES))
  for (const row of earlier) sendRow($, row, withPictures.has(row))
  void shareLocal($, localOpens(messages)).catch(() => {})
  startFeed($)
  const copied = await $.ui.copy({ text: room.url, surface }).catch(() => ({ isCopied: false }))
  $.ui.toast(copied.isCopied ? `Sharing${room.team ? ` with ${room.team.name}` : ''} · link copied` : 'Sharing · the link is in the transcript')
  const access = room.team ? ((await read($, teamsA)).teams.find(x => x.id === room.team?.id) ?? null) : null
  $.ui.log(`Sharing${opts.history === false ? ' from now on' : ''}${room.team ? ` with ${room.team.name}` : ''}. ${whoJoins(room, access)}: ${room.url}`)
  if (room.team) void refreshTeams($).catch(() => {})
  void holdRoom($).catch(() => {})
  await markSidebar($, current => `👥 Live · ${current || room.title}`)
  return room
}

async function copyText($: $, text: string, done: string, surface?: RenderSurface) {
  const copied = await $.ui.copy({ text, surface }).catch(() => ({ isCopied: false }))
  if (copied.isCopied) $.ui.toast(done)
  else $.ui.log(text)
}

async function copyLink($: $, url: string, surface?: RenderSurface) {
  const copied = await $.ui.copy({ text: url, surface }).catch(() => ({ isCopied: false }))
  if (copied.isCopied) $.ui.toast('Link copied')
  else $.ui.log(`The share link: ${url}`)
}

// Stop sharing ends the room for everyone: the first press asks, a second
// within five seconds stops.
async function confirmStop($: $) {
  if ((await read($, confirmingA)) === 'stop') {
    await update($, confirmingA, () => null)
    await closeRoom($, 'stop')
    return
  }
  await update($, confirmingA, () => 'stop')
  $.clock.after(5_000, () => void update($, confirmingA, c => (c === 'stop' ? null : c)))
}

// Host: a session that closes keeps its room. What it needs is saved by
// session id, and the same session (reopened after a restart, or resumed;
// in Claude Desktop, also reopened under a new id) takes it up again; guests
// see the host away meanwhile. Stop sharing, a /clear or the room's expiry
// ends it.
const HOSTING_KEY = 'hosting:'
const HOSTING_KEEP_MS = 24 * 60 * 60 * 1000
type Hosting = {
  at: number
  room: ShareRoom
  policy: SharePolicy
  trusted: ShareTrust[]
  /** What it shares, by port (`HostShare`). */
  shares: Record<string, HostShare>
  shown: ShareShown[]
  activity: ShareActivity[]
  chat: ShareChat[]
  sidebar: { title: string; pinned: boolean; id?: string } | null
  place?: string
  /** What the host said about sharing more here: declined, stopped, when asked; with the room's name. */
  hostMemory?: (ShareHostMemory & { room: string }) | null
  /** This session's mailboxes, by id: the `from=` addresses Claude may still reply to. */
  peerRoutes?: Record<string, SharePeerRoute>
}

// Installed marketplace and inline-folder copies have different $.store
// identities. Room checkpoints belong to the person's Claude configuration,
// outside the live plugin folder that updates replace. Each session has its
// own file, so saving another room cannot overwrite this one's checkpoint.
// A file holding null is no place (how one taken was marked before 0.11.30).
type RoomCheckpoint = Hosting | Joined
type RoomCheckpointFile = { version: 1; value: RoomCheckpoint | null }

async function roomCheckpointDir($: $): Promise<string> {
  const dir = await configDirOf($)
  if (!dir) throw new Error('No Claude configuration directory is available')
  return `${dir}/shared-session/rooms`
}

function isRoomCheckpointKey(key: string): boolean {
  return key.startsWith(HOSTING_KEY) || key.startsWith(JOINED_KEY)
}

function isRoomCheckpoint(value: unknown): value is RoomCheckpoint {
  const saved = value as Partial<RoomCheckpoint> | null
  return Boolean(saved && typeof saved.at === 'number' && Number.isFinite(saved.at) && saved.room && typeof saved.room.token === 'string' && typeof saved.room.seat === 'string')
}

async function readRoomCheckpoint($: $, key: string): Promise<RoomCheckpoint | undefined> {
  const path = `${await roomCheckpointDir($)}/${encodeURIComponent(key)}.json`
  if (!(await $.fs.exists(path))) return undefined
  const text = await $.fs.read(path)
  let record: RoomCheckpointFile
  try { record = JSON.parse(text) as RoomCheckpointFile } catch {
    // JSON's syntax error may quote the damaged payload, which holds tokens.
    throw new Error('A saved room checkpoint is invalid; it was left untouched')
  }
  if (record?.version !== 1 || (record.value !== null && !isRoomCheckpoint(record.value))) throw new Error('A saved room checkpoint is invalid; it was left untouched')
  return record.value ?? undefined
}

async function writeRoomCheckpoint($: $, key: string, value: RoomCheckpoint) {
  const dir = await roomCheckpointDir($)
  const path = `${dir}/${encodeURIComponent(key)}.json`
  const tmp = `${dir}/.checkpoint-${randomSecret()}.tmp`
  const body = JSON.stringify({ version: 1, value })
  const tag = fence(body)
  // Unique private temp files keep unrelated sessions independent. Credentials
  // travel on stdin, never argv, and failed writes leave the old file intact.
  const result = await sh($, `umask 077\nset -e\nmkdir -p ${sq(dir)}\nchmod 700 ${sq(dir)}\ntmp=${sq(tmp)}\ntrap 'rm -f "$tmp"' 0\ncat > ${sq(tmp)} <<'${tag}'\n${body}\n${tag}\nchmod 600 ${sq(tmp)}\nmv ${sq(tmp)} ${sq(path)}\n`)
  if (result.code !== 0) throw new Error('Could not write the private saved room checkpoint')
}

async function deleteRoomCheckpoint($: $, key: string) {
  const path = `${await roomCheckpointDir($)}/${encodeURIComponent(key)}.json`
  if ((await sh($, `rm -f -- ${sq(path)}\n`)).code !== 0) throw new Error('Could not delete the saved room checkpoint')
}

async function roomCheckpointKeys($: $): Promise<string[]> {
  const dir = await roomCheckpointDir($)
  if (!(await $.fs.exists(dir))) return []
  const keys: string[] = []
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    let key: string
    try { key = decodeURIComponent(entry.name.slice(0, -5)) } catch { continue }
    if (isRoomCheckpointKey(key) && (await readRoomCheckpoint($, key))) keys.push(key)
  }
  return keys
}

// Claude Desktop's own id for a session (`local_<uuid>`, the shape Claude Code
// itself accepts). It stays when Desktop reopens the session under a new
// Claude Code id (a rewind, or going on from an earlier message), so a place
// saved under the old id is still found.
async function placeOf($: $): Promise<string> {
  const id = ((await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')) ?? '').trim()
  return /^local_[0-9a-f-]{8,}$/.test(id) ? id : ''
}

// What this session saved when it closed: under its own id, else under the
// Desktop session's (the newest; older ones are places it never took back).
async function savedKey($: $, prefix: string): Promise<{ key: string | null; older: string[] }> {
  const own = `${prefix}${await $.session.id()}`
  if ((await readRoomCheckpoint($, own)) !== undefined) return { key: own, older: [] }
  const place = await placeOf($)
  if (!place) return { key: null, older: [] }
  const mine: { key: string; at: number }[] = []
  for (const key of await roomCheckpointKeys($)) {
    if (!key.startsWith(prefix)) continue
    const saved = await readRoomCheckpoint($, key)
    if (typeof saved?.at === 'number' && saved.place === place) mine.push({ key, at: saved.at })
  }
  mine.sort((a, b) => b.at - a.at)
  return { key: mine[0]?.key ?? null, older: mine.slice(1).map(m => m.key) }
}

// What a host's place keeps, to take the room up again.
async function hostingPlace($: $, room: ShareRoom): Promise<Hosting> {
  const shares = Object.entries(await read($, sharesA)), memory = await read($, hostMemoryA)
  return {
    at: await $.clock.now(),
    room,
    policy: await read($, policyA),
    trusted: await read($, trustedA),
    shares: Object.fromEntries(shares),
    shown: keptShown(await read($, shownA), 20),
    activity: (await read($, activityA)).slice(-40),
    chat: (await read($, chatA)).slice(-40),
    sidebar: await read($, sidebarA),
    place: (await placeOf($)) || undefined,
    // Saved with its room's name: taken back only for that room.
    hostMemory: memory ? { room: roomIdentity(room), ...memory } : null,
    peerRoutes: await read($, peerRoutesA),
  }
}

// Guest: a session that closes keeps its place the same way. It stays
// pinned and named; reopened, it takes its seat back (a new one if the room
// let the old one go after its grace) and plays what it missed, prompt by
// prompt, a turn still running on the host live. Leave, a /clear or a
// logout leaves for good.
const JOINED_KEY = 'joined:'
type Joined = {
  at: number
  room: ShareRoom
  autoOpen: boolean
  policy: SharePolicy
  /** Every open preview, what the host forwards among them (`tcp`), and the newest 20 of the rest. */
  shown: ShareShown[]
  localPreviews?: ShareLocalPreview[]
  activity: ShareActivity[]
  chat: ShareChat[]
  sidebar: { title: string; pinned: boolean; id?: string } | null
  place?: string
  /** A preview window was opened: its profile is kept with the place (by its name), and its proxy's port. */
  previewWindow?: { port: number; profile?: string }
  previewNeedsOpen?: string[]
  /** Ports the preview window asked the host about. */
  needAsked?: number[]
  /** This session's handles, by id: where the host's session's messages to this person's sessions go. */
  peerRoutes?: Record<string, SharePeerRoute>
  /** This session moved the room's host to the cloud: its approver. */
  cloudMine?: boolean
  /** The approver's: whom the cloud host always allows, as this session knew it (Ask again's). */
  cloudTrusted?: string[]
}

// What a guest's place keeps, to take its seat back.
async function joinedPlace($: $, room: ShareRoom): Promise<Joined> {
  return {
    at: await $.clock.now(),
    room,
    autoOpen: await read($, autoOpenA),
    policy: await read($, policyA),
    shown: keptShown(await read($, shownA), 20),
    localPreviews: (await read($, localPreviewsA)).filter(p => validPort(p.localPort)),
    activity: (await read($, activityA)).slice(-40),
    chat: (await read($, chatA)).slice(-40),
    sidebar: await read($, sidebarA),
    place: (await placeOf($)) || undefined,
    peerRoutes: await read($, peerRoutesA),
    ...((await read($, cloudA))?.mine ? { cloudMine: true, cloudTrusted: await read($, cloudTrustedA) } : {}),
    ...(await windowCheckpoint($, room)),
  }
}

// A place being taken back: read and deleted at once (two sessions on one
// Desktop place never both take it), and held here until the room is back,
// its mode set. The session ending meanwhile saves it again, or, for a
// /clear or a logout, leaves the room (a host's ends) instead
// (`settleReclaim`); the resume then writes nothing more.
type Reclaim = { key: string; saved: Hosting | Joined; deleted: Promise<void>; settled: Promise<void>; settle: () => void; late: boolean }
let reclaiming: Reclaim | null = null
// A take-back from its start until it's over: its room back with its mode,
// or not taken back (gone, the session ending, given up). Share and Join
// wait for it (`takenBack`), and the row and the Room offer neither for its
// first 10 s (`takingBackNow`): a room made or joined beside the one coming
// back would share this session's state with it.
let takingBack: Reclaim | null = null
// How long a take-back holds Share and Join back: past it, it's `late`.
const TAKE_BACK_WAIT_MS = 10_000

function takeBack($: $, key: string, saved: Hosting | Joined): Reclaim {
  let settle!: () => void
  const settled = new Promise<void>(done => { settle = done })
  const back: Reclaim = { key, saved, deleted: deleteRoomCheckpoint($, key), settled, settle, late: false }
  reclaiming = back
  takingBack = back
  // Not back in 10 s (its first request hangs on a stalled network, or a
  // guest's catch-up is long): Share and Join show again, and a room made
  // or joined then gives it up at once.
  $.clock.after(TAKE_BACK_WAIT_MS, () => {
    if (takingBack !== back) return
    back.late = true
    $.ui.invalidate('ui.render')
  })
  $.ui.invalidate('ui.render')
  return back
}

// The row and the Room hide Share, and an invite's row its Join, while a
// take-back is under 10 s old, never for as long as one hangs.
function takingBackNow(): boolean {
  return takingBack !== null && !takingBack.late
}

// A take-back over, however it went: what waited for it goes on, and the
// row and the Room draw again.
function tookBack($: $, back: Reclaim) {
  back.settle()
  if (takingBack !== back) return
  takingBack = null
  $.ui.invalidate('ui.render')
}

// Share and Join (the row's, /share-session, a pasted link, the Team
// panel's and an invite's), and what a person types, wait for a room being
// taken back at startup until it's over or `late`, then go on as in a
// session that is, or isn't, in that room: a room taken back is shared
// already, and a link pasted then is one pasted in a room. Only what makes
// or joins a room here gives a late one up: `share` and `join`, through
// `roomClosed` (a Share that shares, a pasted link, a Join in a fresh
// session). That goes on in no room, the take-back writes nothing more, and
// what it gave up comes back to it: over once its own room is made or
// joined, kept for the next start if it isn't (`roomMade`, `notMade`). The
// rest go on beside it without giving it up (`keep`: a Share asking first
// which to share, a prompt, a Join that opens a new session), and it
// finishes. Each waits before it reads anything of the room, since every
// read of one dispatch sees one moment. The waits are `nap`s, which a
// hook's own budget doesn't pay for.
async function takenBack($: $, opts: { keep?: boolean } = {}): Promise<Reclaim | null> {
  const back = takingBack
  if (!back) return null
  let over = false
  void back.settled.then(() => { over = true })
  // A waiter's own 10 s besides, should the take-back's timer never come.
  const until = (await $.clock.now()) + TAKE_BACK_WAIT_MS
  while (!over && !back.late && (await $.clock.now()) < until) await Promise.race([back.settled, nap($, 250)])
  if (over || opts.keep || reclaiming !== back) return null
  reclaiming = null
  givenUp = back
  await giveUp($, back).catch(() => {})
  tookBack($, back)
  return back
}

// A late take-back given up for a room being made or joined here: its place
// stays taken, and what the resume wrote of the room so far is cleared. Its
// room hears nothing yet (`roomMade`).
async function giveUp($: $, back: Reclaim) {
  await back.deleted.catch(() => {})
  await clearRoomState($)
}

// A late take-back given up for a room being made or joined here, until
// that room is (`roomMade`) or isn't (`notMade`), or the session ends first
// (saved again, or left).
let givenUp: Reclaim | null = null

// A room made here (its POST answered), or joined (this session in it): a
// late take-back given up for it is over now, never before, so a room
// refused doesn't leave the person in none with the one they had over. Its
// room hears it in the background (a host's ends, a guest's place is left)
// in one request bounded in time (`tellRoomSoon`), rather than keep this
// session away in it for a day, and a guest's room's window profile goes,
// as at a Leave. Whatever made or joined it, it ends one still given up.
function roomMade($: $) {
  const over = givenUp
  if (!over) return
  givenUp = null
  const room = over.saved.room, guest = room.seat !== 'host'
  void tellRoomSoon($, room, guest).catch(() => {})
  const w = guest ? (over.saved as Joined).previewWindow : undefined
  if (w) void endPreviewWindow($, room, w).catch(() => {})
}

// No room made or joined after all (refused, unreachable, gone, its history
// cut short and its seat given back): the late take-back this gave up
// (`back`) keeps its place, saved again for the next start to take back, as
// a session ending saves a place being taken back. Then the error goes on.
async function notMade($: $, back: Reclaim | null, error: unknown): Promise<never> {
  if (back && givenUp === back) {
    givenUp = null
    const guest = back.saved.room.seat !== 'host'
    await writeRoomCheckpoint($, back.key, back.saved).catch(e => $.ui.log(`${guest ? "Couldn't save the joined session for reopening" : "Couldn't save the shared session for reopening"}: ${String((e as Error)?.message ?? e)}`))
  }
  throw error
}

// The room hears this session is out of it, best effort: one curl, its
// token on stdin, done within 15 s. A take-back late because the network
// hangs is given up on that same network: a $.http.fetch hanging there
// would hold every prompt typed meanwhile, as the plugin's own request in
// flight does; a child holds nothing.
async function tellRoomSoon($: $, room: ShareRoom, guest: boolean) {
  const input = `${roomConfig(room, guest ? 'leave' : 'end')}\nrequest = "POST"\n`
  const child = $.process.spawn({ argv: ['curl', '--silent', '--max-time', '15', '--output', '/dev/null', '--config', '-'], input })
  for await (const _chunk of child) { /* Never log credentials or a server's answer. */ }
}

// A wait the hook's own budget doesn't pay for (a `sleep` child: its clock
// stops while a $ call is in flight), as `pause`; where `sleep` doesn't run,
// a plain timer.
async function nap($: $, ms: number) {
  const slept = await $.process.run(['sleep', (ms / 1000).toFixed(2)], { timeoutMs: ms + 2_000 }).then(
    r => r.exitCode === 0,
    () => false,
  )
  if (!slept) await new Promise<void>(done => $.clock.after(ms, done))
}

// The session ended while a place was being taken back, or given up for a
// room not made or joined yet: saved again for the next start, or, left
// for good, the room hears it (a host's room ends), the room's window
// profile goes and the sidebar row goes back as it was. What the resume
// wrote of the room so far is cleared.
async function settleReclaim($: $, back: Reclaim, forGood: boolean) {
  await back.deleted.catch(() => {})
  const saved = back.saved, room = saved.room, guest = room.seat !== 'host'
  if (!forGood) {
    await writeRoomCheckpoint($, back.key, saved).catch(error => $.ui.log(`${guest ? "Couldn't save the joined session for reopening" : "Couldn't save the shared session for reopening"}: ${String((error as Error)?.message ?? error)}`))
  } else {
    await tellRoom($, room, guest)
    const w = guest ? (saved as Joined).previewWindow : undefined
    if (w) await endPreviewWindow($, room, w, false).catch(() => {})
    await update($, sidebarA, () => saved.sidebar ?? null)
    await unmarkSidebar($, guest ? `${room.host}'s session · ${room.title}`.slice(0, 120) : undefined)
  }
  await clearRoomState($)
}

async function resumeJoined($: $) {
  const { key, older } = await savedKey($, JOINED_KEY)
  for (const stale of older) await deleteRoomCheckpoint($, stale)
  if (!key) return
  const saved = (await readRoomCheckpoint($, key)) as Joined | undefined
  if (!saved?.room?.token || saved.room.seat === 'host') return
  const back = takeBack($, key, saved)
  try {
    await back.deleted
    if ((await $.clock.now()) - saved.at > HOSTING_KEEP_MS) return
    const current = () => reclaiming === back
    // Over while this was closed: only now does the sidebar row go back, and
    // the room's preview window profile goes.
    const over = async (said = `${saved.room.host}'s session ended while this one was closed.`) => {
      if (!current()) return
      reclaiming = null
      await update($, sidebarA, () => saved.sidebar ?? null)
      await unmarkSidebar($, `${saved.room.host}'s session · ${saved.room.title}`.slice(0, 120))
      if (saved.previewWindow) await endPreviewWindow($, saved.room, saved.previewWindow).catch(() => {})
      $.ui.log(said)
    }
    // Joined over plain http elsewhere: never taken up again, its token unsent.
    if (!secureServer(saved.room.server)) return void (await over(plainSaved(saved.room.server)))
    let room = saved.room
    let missed: ServerEvent[] = []
    let people: SharePerson[] | null = null
    // What the room shares now, as its answer said (none: unreachable for now).
    let listed: unknown
    try {
      const page = await eventsSince($, room, room.seq)
      if (page.ended) return void (await over())
      missed = page.events
      people = page.people
      listed = page.previews
      room = { ...room, seq: page.seq }
    } catch (error) {
      // Its person left it from elsewhere meanwhile (the Team panel's Leave): said as such.
      if (error instanceof ApiError && error.status === 410 && error.data.left === true) return void (await over(`You left ${saved.room.host}'s session from the Team panel while this one was closed.`))
      if (error instanceof ApiError && (error.status === 404 || error.status === 410)) return void (await over())
      if (error instanceof ApiError && error.status === 401) {
        // Given up meanwhile (a room made or joined here, the session's end):
        // no seat is taken in it.
        if (!current()) return
        // The seat was let go: a new one, and what happened since the old one's last.
        try {
          const joined = await api<{ token: string; seat: string; seq: number; title: string; history: ServerEvent[]; people: SharePerson[]; previews?: unknown; more?: boolean; historySeq?: number }>(
            $,
            room.server,
            `/api/rooms/${room.id}/join?max=${PAGE_BYTES}`,
            { method: 'POST', body: { name: await whoami($) }, account: (await signInFor($, room.server))?.token },
          )
          // The new seat is the place's now: the session ending from here keeps it, or leaves it.
          back.saved = { ...saved, room: { ...saved.room, token: joined.token, seat: joined.seat } }
          // Only what came after the old seat's last: page from there.
          const from = Math.max(saved.room.seq, joined.more && typeof joined.historySeq === 'number' ? joined.historySeq : joined.seq)
          missed = joined.history.filter(e => e.seq > saved.room.seq)
          if (joined.more && from < joined.seq) {
            const rest = await eventsSince($, { server: room.server, id: room.id, token: joined.token }, from, joined.seq)
            missed.push(...rest.events.filter(e => e.seq > saved.room.seq && e.type !== 'delta'))
          }
          people = joined.people
          listed = joined.previews
          room = { ...room, token: joined.token, seat: joined.seat, seq: joined.seq, title: joined.title }
        } catch (again) {
          if (again instanceof ApiError && (again.status === 404 || again.status === 410)) return void (await over())
          throw again
        }
      }
      // Unreachable for now: back in anyway, and the feed keeps trying.
    }
    // The session ended meanwhile (its place saved again, or left), or the
    // place was given up for another room: nothing more of it here.
    if (!current()) return
    await update($, roomA, v => (reclaiming === back ? room : v))
    await update($, policyA, v => (reclaiming === back ? ({ ...DEFAULT_POLICY, ...saved.policy }) : v))
    await update($, autoOpenA, v => (reclaiming === back ? (saved.autoOpen !== false) : v))
    await update($, shownA, v => (reclaiming === back ? (saved.shown ?? []) : v))
    await update($, localPreviewsA, v => (reclaiming === back ? (saved.localPreviews ?? []) : v))
    await update($, activityA, v => (reclaiming === back ? (saved.activity ?? []) : v))
    await update($, chatA, v => (reclaiming === back ? (saved.chat ?? []) : v))
    await update($, sidebarA, v => (reclaiming === back ? (saved.sidebar ?? null) : v))
    const windowPort = saved.previewWindow?.port, windowProfile = saved.previewWindow?.profile
    const profile = typeof windowProfile === 'string' && PROFILE_NAME.test(windowProfile) ? { profile: windowProfile } : {}
    await update($, previewWindowA, v => (reclaiming === back ? (windowPort === 0 || validPort(windowPort) ? { room: roomIdentity(room), port: windowPort, opened: [], ...profile } : null) : v))
    await update($, previewNeedsOpenA, v => (reclaiming === back ? (Array.isArray(saved.previewNeedsOpen) ? saved.previewNeedsOpen.filter(p => typeof p === 'string').slice(-64) : []) : v))
    await update($, needAskedA, v => (reclaiming === back ? ({ ports: Array.isArray(saved.needAsked) ? saved.needAsked.filter(validPort).slice(-256) : [], times: [] }) : v))
    await update($, peerRoutesA, v => (reclaiming === back ? peerRoutesSaved(saved.peerRoutes, 'guest') : v))
    // The approver of the room's cloud host, as it was: its questions come here.
    await update($, cloudA, v => (reclaiming === back ? (saved.cloudMine ? { state: 'running' as const, approver: saved.room.host, since: saved.at, mine: true } : null) : v))
    await update($, cloudTrustedA, v => (reclaiming === back ? (saved.cloudMine && Array.isArray(saved.cloudTrusted) ? [...new Set(saved.cloudTrusted.filter((n): n is string => typeof n === 'string').map(n => n.slice(0, 40)))].slice(0, 64) : []) : v))
    if (!current()) return
    // Back in: the room's scope from here, and a session ending saves it as it would any room.
    reclaiming = null
    const s = openScope(room, 'guest')
    await update($, modeA, m => (s.live ? 'guest' : m))
    // In the room now: a Share or a Join that waited goes on as in it.
    tookBack($, back)
    if (people) await update($, peopleA, p => (s.live ? people : p))
    await readyReplay($)
    // What the room shares now, before a listener comes back: a preview it
    // ended, or forwarded, while this was closed. Then what happened since.
    await takeRoomList($, room, s, listed)
    for (const event of missed) {
      if (!s.live) return
      await absorb($, room, 'guest', event, false)
    }
    await flushCalls($, s)
    if (!s.live) return
    const starts = missed.filter(e => e.type === 'turn' && e.body.state === 'start')
    const ends = new Set(missed.filter(e => e.type === 'turn' && e.body.state === 'end').map(e => e.body.turnId))
    const running = starts.filter(e => !ends.has(e.body.turnId)).at(-1)
    const past = missed.filter(e => e.type === 'row' && (!running || e.seq < running.seq))
    if (running) noteHostTurn(running)
    const caught = exchanges(past.map(e => e.body as unknown as Row), room.host)
    for (const exchange of caught) laterRides.push({ text: exchange.prompt, ride: { kind: 'static', rows: exchange.rows } })
    startFeed($)
    $.ui.log(caught.length ? `Back in ${room.host}'s session. What you missed follows.` : `Back in ${room.host}'s session.`)
    if (caught.length || running) scheduleRides($)
  } finally {
    if (reclaiming === back) reclaiming = null
    tookBack($, back)
  }
}

async function resumeHosting($: $) {
  const id = await $.session.id()
  const now = await $.clock.now()
  // Places saved by sessions that never came back, past any room's life.
  for (const other of await roomCheckpointKeys($)) {
    if (!(other.startsWith(HOSTING_KEY) || other.startsWith(JOINED_KEY)) || other.endsWith(`:${id}`)) continue
    const at = (await readRoomCheckpoint($, other))?.at
    if (typeof at !== 'number' || now - at > HOSTING_KEEP_MS) await deleteRoomCheckpoint($, other)
  }
  const found = await savedKey($, HOSTING_KEY)
  // Rooms this Desktop session left before and never took back: over.
  for (const stale of found.older) {
    const left = (await readRoomCheckpoint($, stale)) as Hosting | undefined
    await deleteRoomCheckpoint($, stale)
    if (left?.room?.token && left.room.seat === 'host') void api($, left.room.server, `/api/rooms/${left.room.id}/end`, { method: 'POST', token: left.room.token }).catch(() => {})
  }
  if (!found.key) return
  const saved = (await readRoomCheckpoint($, found.key)) as Hosting | undefined
  if (!saved?.room?.token || saved.room.seat !== 'host') return
  const back = takeBack($, found.key, saved)
  try {
    await back.deleted
    if (now - saved.at > HOSTING_KEEP_MS) return
    const current = () => reclaiming === back
    // Shared over plain http elsewhere: never taken up again, its token unsent.
    if (!secureServer(saved.room.server)) return void (current() && $.ui.log(plainSaved(saved.room.server)))
    let page: EventsPage | null = null
    try {
      page = await eventsSince($, saved.room, saved.room.seq)
    } catch (error) {
      if (isGone(error)) {
        if (current()) $.ui.log('The session you shared ended while this one was closed.')
        return
      }
      // Unreachable for now: share on, and the feed keeps trying.
    }
    // The session ended meanwhile (its place saved again, or its room
    // ended), or the room was given up for another: nothing more of it here.
    if (!current()) return
    if (page?.ended) return void $.ui.log('The session you shared ended while this one was closed.')
    const room: ShareRoom = { ...saved.room, seq: page?.seq ?? saved.room.seq }
    const shares = sharesSaved(saved)
    await update($, roomA, v => (reclaiming === back ? room : v))
    await update($, policyA, v => (reclaiming === back ? ({ ...DEFAULT_POLICY, ...saved.policy }) : v))
    await update($, trustedA, v => (reclaiming === back ? (saved.trusted ?? []).filter(t => typeof t === 'object' && Boolean(t?.seat)) : v))
    await update($, sharesA, v => (reclaiming === back ? shares : v))
    await update($, shownA, v => (reclaiming === back ? (saved.shown ?? []) : v))
    await update($, activityA, v => (reclaiming === back ? (saved.activity ?? []) : v))
    await update($, chatA, v => (reclaiming === back ? (saved.chat ?? []) : v))
    await update($, sidebarA, v => (reclaiming === back ? (saved.sidebar ?? null) : v))
    await update($, hostMemoryA, v => (reclaiming === back ? (hostMemorySaved(saved.hostMemory, roomIdentity(room))) : v))
    await update($, peerRoutesA, v => (reclaiming === back ? peerRoutesSaved(saved.peerRoutes, 'host') : v))
    if (!current()) return
    // Back: the room's scope from here, and a session ending saves it as it would any room.
    reclaiming = null
    const s = openScope(room, 'host')
    await update($, modeA, m => (s.live ? 'host' : m))
    // Its mailboxes listen again where they were.
    void restoreMailboxes($).catch(() => {})
    // Sharing it again: a Share or a Join that waited goes on as in it.
    tookBack($, back)
    if (page) {
      const people = page.people
      await update($, peopleA, p => (s.live ? people : p))
      // What happened while it was closed: the chat and comings and goings are
      // kept; a prompt sent then is answered, not run late.
      for (const event of page.events) {
        if (!s.live) return
        if (event.type === 'prompt' && event.from.role === 'guest') {
          // A cloud host taking the room up: a prompt sent while it moved runs now.
          if ((await isRunner($)) && typeof event.body.text === 'string') {
            await acceptPrompt($, event.from.name, event.from.seat ?? '', event.body.text, typeof event.body.pid === 'string' ? event.body.pid : '', Array.isArray(event.body.attachments) ? (event.body.attachments as ShareFileMeta[]) : [], event.from.approver === true)
            continue
          }
          send($, 'declined', { pid: typeof event.body.pid === 'string' ? event.body.pid : '', who: event.from.name, reason: `${room.host}'s Claude Code was closed when you sent this, so it didn't run. Send it again.` })
          continue
        }
        await absorb($, room, 'host', event, false)
      }
      await flushCalls($, s)
    }
    if (!s.live) return
    startFeed($)
    $.ui.log(`Still sharing this session: ${room.url}`)
  } finally {
    if (reclaiming === back) reclaiming = null
    tookBack($, back)
  }
}

// The cloud host: a setting its approver changed (`set`), set here as the
// host's own Room sets it, and said to everyone; and their Ask again.
async function takeSet($: $, body: Record<string, unknown>) {
  const change: Partial<SharePolicy> = {
    ...(body.prompts === 'everyone' || body.prompts === 'watch' ? { prompts: body.prompts } : {}),
    ...(body.approvals === 'all' || body.approvals === 'edits' ? { approvals: body.approvals } : {}),
    ...(body.files === 'on' || body.files === 'off' ? { files: body.files } : {}),
  }
  if (body.untrust === true) await update($, trustedA, () => [])
  if (Object.keys(change).length) await setPolicy($, change)
}

// The approver: a setting of the cloud host's, changed here; it holds here
// too (Bring home takes it), and the cloud host sets it (`takeSet`).
async function setCloudPolicy($: $, change: Partial<SharePolicy> & { untrust?: true }) {
  const { untrust, ...policy } = change
  if (Object.keys(policy).length) await update($, policyA, p => ({ ...p, ...policy }))
  if (untrust) await update($, cloudTrustedA, () => [])
  send($, 'set', change)
  await flushOut($)
}

// A setting changed in the Room: the host's own, or, by its approver, the
// cloud host's while it runs.
async function setPolicyHere($: $, change: Partial<SharePolicy>) {
  const cloud = await read($, cloudA)
  if ((await read($, modeA)) === 'guest' && cloud?.mine && cloud.state !== 'stopped') return setCloudPolicy($, change)
  return setPolicy($, change)
}

async function setPolicy($: $, change: Partial<SharePolicy>) {
  const policy = { ...(await read($, policyA)), ...change }
  await update($, policyA, () => policy)
  send($, 'policy', policy)
}

// `approver`: the cloud host's approver's prompt, as the room says: their own
// session, which watch-only keeps to teammates.
async function acceptPrompt($: $, who: string, seat: string, text: string, pid: string, attachments: ShareFileMeta[] = [], approver = false) {
  if ((await read($, policyA)).prompts === 'watch' && !(approver && (await isRunner($)))) {
    send($, 'declined', { pid, who, reason: 'This session is watch-only right now. Chat in the Room panel.' })
    return
  }
  // What they attached, saved in the project, each named in the prompt with
  // how to see it: a plugin's prompt carries words alone (no pictures, and its
  // own hooks can't add context to it), and Read shows images and PDFs.
  const attached = await saveAttachments($, who, attachments)
  const cwd = await $.session.cwd()
  const marks = attached.map(p => `📎 ${p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p} (attached by ${who}; open it with the Read tool to see it)`).join('\n')
  // No `from=` in their words reaches Claude (`neutralize`): only an envelope
  // Claude Code frames itself carries one, a mailbox's among them.
  const words = neutralize(text)
  const framed = `${who}: ${words}${marks ? `${words ? '\n\n' : ''}${marks}` : ''}`
  await update($, guestPromptsA, list => [...list, { who, seat, framed, text: framed.slice(who.length + 2), pid }])
  // Runs once the session is idle, after any turn already running.
  nextGuestPromptSoon($)
}

// ---------------------------------------------------------------------------
// Messages between sessions
//
// A teammate's own session (A, say an agent of theirs) writes to their
// joined session (G); the host's Claude answers it; they go on writing to
// each other, through Claude Code's own messaging at both ends:
//   Guest: A's message reaches G as any session's does (queued, and held
//     there while A runs in another permission mode class), and at
//     `prompt.submit` goes on to the room with the hop chain and message id
//     A gave it, read from G's transcript (`relayQueued`). G's turn for it
//     plays the host's turn for it, as a typed prompt's does; G's own Claude
//     never runs. What the host's session writes back, G sends A itself
//     (`$.session.send`): A's next message comes to G natively, and Claude
//     Code gives a plugin's send the hop chain of the session's newest
//     prompt (A's message, while its turn plays), so A's and G's Claude Code
//     cut a loop between them as they would any.
//   Host: one helper a room (relay/mailbox.cjs), started detached (no
//     descendant of this Claude Code, or a session in bypass mode would take
//     its frames as its own), whose mailboxes are real Unix sockets beside
//     this session's own: a mailbox stands for one of a teammate's sessions
//     (the seat and handle the room brought its message with). A's message
//     goes into this session from it, with A's chain, mode and id; the host's
//     Claude's SendMessage to it comes back to it and goes to that seat.
// Receipts go both ways: where this session holds, releases or drops A's
// message, Claude Code tells the mailbox, the helper posts it, and G writes
// it into A (relay/receipt.cjs); where A holds or drops what G sent it,
// Claude Code tells G (a delivery notice), G posts it, and the helper writes
// it into this session from the mailbox. The room passes each on to the
// other side's streams alone and keeps none (POST peer). A message from a
// mailbox is the host's Claude's like any peer's: the host's mode decides its
// calls. Where something can't go, the session that wrote hears it: A from G
// (`tellPeer`), the host's Claude as a receipt.
const PEER_STATUS = new Set(['held', 'denied', 'delivered', 'expired', 'refused', 'dropped'])
const PEER_DROPS = new Set(['rate-limited', 'duplicate', 'hop-loop', 'hop-runaway', 'queue-full'])
type PeerStatus = 'held' | 'denied' | 'delivered' | 'expired' | 'refused' | 'dropped'
/** A message id as Claude Code gives one (`msg_id`), which its receipts name. */
const MSG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HOP_TOKEN = /^[0-9a-f]{24}$/

/** A new message id of Claude Code's kind (a version 4 UUID). */
function newMsgId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// A receipt as the room brings it, checked as the room checks it.
function peerReceiptOf(value: Record<string, unknown>, key: 'ref' | 'id'): { handle: string; status: PeerStatus; of: string; reason?: string } | null {
  const { handle, status, reason } = value
  const of = value[key]
  if (typeof handle !== 'string' || !PEER_ID.test(handle) || typeof status !== 'string' || !PEER_STATUS.has(status) || typeof of !== 'string' || !MSG_ID.test(of)) return null
  return { handle, status: status as PeerStatus, of, ...(status === 'dropped' && typeof reason === 'string' && PEER_DROPS.has(reason) ? { reason } : {}) }
}

// What this computer lacks for messages between sessions: null, or why.
// Claude Code 2.1.304's messaging (its socket, the ids and hop chains its
// transcript keeps), and Unix sockets (macOS, Linux).
let peerPlatform: Promise<boolean> | null = null
async function peerMissing($: $): Promise<string | null> {
  const engine = /claude-code_(\d+)-(\d+)-(\d+)/.exec((await $.env.get('AI_AGENT')) ?? '')
  const older = engine ? Number(engine[1]) * 1e6 + Number(engine[2]) * 1e3 + Number(engine[3]) < 2_001_304 : false
  if (older || !(await $.env.get('CLAUDE_CODE_MESSAGING_SOCKET'))) return "its Claude Code can't pass messages between sessions (that needs Claude Code 2.1.304 or later)"
  peerPlatform ??= sh($, 'uname -s\n').then(({ out }) => /^(Darwin|Linux)\s*$/.test(out))
  if (!(await peerPlatform)) return 'messages between sessions are passed on only on macOS and Linux'
  return null
}

// Host: the room's mailboxes' helper, started for the first message that
// needs it (or a start whose mailboxes must listen again) and kept with the
// room's scope (`RoomChildren.mailbox`). A launcher starts it detached and
// is gone; the room, the host's bearer and the helper's own come on stdin,
// commands in short POSTs (`controlPost`). Its pid and port are kept in the
// session's state (`mailboxHelperA`), so the module that replaces this one
// at a reload ends it (`endOldHelper`) and starts its own. It goes with the
// room, or once this Claude Code is gone; a failure's next message starts
// another.
// Why one never started (`error`): NODE, no Node here; UNSUPPORTED, a system
// it can't run on; STARTUP, anything else.
type MailboxRun = Helper & {
  room: ShareRoom
  /** The served helper's own pid, once it's ready (the launcher's gone by then). */
  pid?: number
  /** Tells it to go: an exit command, else its process ended. */
  end?: () => Promise<void>
}

function mailboxOf($: $, room: ShareRoom, s: RoomScope): MailboxRun | null {
  if (!s.live || !stillInRoom(room, s)) return null
  const had = s.children.mailbox
  if (had && !had.stopped) return had
  const run: MailboxRun = { ...newHelper(s), room }
  run.end = () => endMailbox($, run)
  s.children.mailbox = run
  void runMailbox($, run)
  return run
}

function finishMailbox(run: MailboxRun): Promise<void> {
  return finishHelper(run, async () => run.end?.(), () => {
    if (run.scope.children.mailbox === run) run.scope.children.mailbox = null
  })
}

// Gone: told to, else ended as the one process its pid names (`killHelper`).
async function endMailbox($: $, run: MailboxRun) {
  const told = run.control ? await controlPost($, run.control, run.controlToken, { op: 'exit' }, { answers: [200], failed: () => {} }) : 0
  if (told !== 200 && run.pid) await killHelper($, run.pid)
  if (run.pid) await update($, mailboxHelperA, h => (h?.pid === run.pid ? null : h))
}

// A helper by its pid, only while that pid is still a mailbox helper: a pid
// taken since by another process is never signalled.
async function killHelper($: $, pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return
  await sh($, `case "$(ps -o command= -p ${pid} 2>/dev/null)" in\n  *"/relay/mailbox.cjs --serve"*) kill -TERM ${pid} 2>/dev/null ;;\nesac\n`)
}

// A reload: the helper the module before this one started goes (its
// mailboxes with it), and this one's opens them again (`restoreMailboxes`).
async function endOldHelper($: $) {
  const old = await read($, mailboxHelperA)
  if (!old) return
  await update($, mailboxHelperA, h => (h?.pid === old.pid ? null : h))
  await killHelper($, old.pid)
}

// The launcher's lines are read to its end, stopped or not: the helper it
// started lives apart from it, so its ready line is how this one ends it.
async function runMailbox($: $, run: MailboxRun) {
  try {
    const own = await $.env.get('CLAUDE_CODE_MESSAGING_SOCKET')
    const version = await ownVersion($)
    if (!own || run.stopped || run.scope.children.mailbox !== run || !run.scope.live) return void finishMailbox(run)
    const settings = { room: `${run.room.server}/api/rooms/${run.room.id}`, token: run.room.token, controlToken: run.controlToken, version, own, dir: own.slice(0, own.lastIndexOf('/')) }
    const late = () => {
      $.ui.log("Shared session: the mailboxes' helper didn't start in 6 s", { to: 'debug' })
      return finishMailbox(run)
    }
    await runHelper($, run, 'mailbox.cjs', settings, 6_000, late, () => true, async said => {
      if (said.state === 'error') return void (run.error = said.code === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'STARTUP')
      if (said.state !== 'ready' || !validPort(said.port) || !Number.isSafeInteger(said.pid) || (said.pid as number) <= 1 || run.control !== undefined) return
      const pid = said.pid as number
      helperReady(run, said.port)
      run.pid = pid
      // A module that replaces this one ends it by this.
      await update($, mailboxHelperA, () => ({ room: roomIdentity(run.room), pid, port: said.port as number }))
      $.ui.log(`Shared session: the mailboxes' helper (${pid}) is ready`, { to: 'debug' })
      // Stopped meanwhile (the room's end, or a reload): it goes now.
      if (run.stopped || run.scope.children.mailbox !== run || !run.scope.live) {
        const first = !run.stopping
        await finishMailbox(run)
        if (!first) await endMailbox($, run)
        return
      }
      run.settle(true)
    })
    // The launcher is gone once the helper is ready; without that, nothing runs.
    if (run.control === undefined) await finishMailbox(run)
  } catch (error) {
    // Its mailboxes go with it; the next message starts another.
    $.ui.log(`Shared session: the mailboxes' helper: ${String((error as Error)?.message ?? error)}`, { to: 'debug' })
    await finishMailbox(run)
  }
}

// One command to the room's mailboxes' helper, in turn: 200, or why not (404
// a mailbox it doesn't have, 409 one it couldn't open or a frame it couldn't
// write, 429 full). Anything else, no answer in two seconds included, ends it.
function mailboxControl($: $, run: MailboxRun, body: Record<string, unknown>): Promise<number> {
  const failed = () => {
    $.ui.log(`Shared session: the mailboxes' helper didn't answer ${String(body.op)}, so it was ended`, { to: 'debug' })
    void finishMailbox(run)
  }
  return helperPost($, run, () => run.scope.children.mailbox === run, async () => body, { answers: [200, 404, 409, 429], failed })
}

// Host: a mailbox listening, its helper started as need be; else why not.
type MailboxOpen = MailboxRun | { error: string }
async function openMailbox($: $, room: ShareRoom, s: RoomScope, box: string, route: Extract<SharePeerRoute, { kind: 'host' }>): Promise<MailboxOpen> {
  const run = mailboxOf($, room, s)
  if (!run) return { error: 'STARTUP' }
  if (!(await run.ready)) return { error: run.error ?? 'STARTUP' }
  return (await mailboxControl($, run, { op: 'open', box, seat: route.seat, handle: route.handle })) === 200 ? run : { error: 'OPEN' }
}

// A route, this session's from now (the newest 64; a host's mailbox going
// out of them is closed), found by what it's for or made: a guest's handle
// for one of this person's sessions at this seat, a host's mailbox for a
// seat's handle. Its id is new, 128 random bits. Written only while the
// room's scope is open.
async function keepRoute($: $, room: ShareRoom, s: RoomScope, route: SharePeerRoute): Promise<string | null> {
  if (!stillInRoom(room, s)) return null
  const got = { id: null as string | null, evicted: [] as string[] }
  await update($, peerRoutesA, all => {
    if (!s.live) return all
    const same = (r: SharePeerRoute) => (r.kind === 'guest' && route.kind === 'guest' ? r.to === route.to && r.seat === route.seat : r.kind === 'host' && route.kind === 'host' && r.seat === route.seat && r.handle === route.handle)
    const id = Object.entries(all).find(([, r]) => same(r))?.[0] ?? randomSecret().slice(0, 32)
    got.id = id
    const entries = [...Object.entries(all).filter(([k]) => k !== id), [id, route] as const]
    got.evicted = entries.slice(0, -64).filter(([, r]) => r.kind === 'host').map(([k]) => k)
    return Object.fromEntries(entries.slice(-64))
  })
  const run = s.children.mailbox
  if (run && !run.stopped) for (const box of got.evicted) void mailboxControl($, run, { op: 'close', box }).catch(() => {})
  return s.live ? got.id : null
}

// Host, at a start, a reload or a resume: the mailboxes listen again at the
// same paths, so the `from=` addresses Claude remembers still reach them.
async function restoreMailboxes($: $) {
  const room = await read($, roomA)
  if (!room || (await read($, modeA)) !== 'host' || (await peerMissing($))) return
  const routes = Object.entries(await read($, peerRoutesA)).filter((e): e is [string, Extract<SharePeerRoute, { kind: 'host' }>] => e[1].kind === 'host')
  const s = scope
  for (const [box, route] of routes) {
    if (!s.live || 'error' in (await openMailbox($, room, s, box, route))) return
  }
}

// Why a message to the host's session didn't reach their Claude, in words for
// the session that wrote it (and its turn on the joined session).
function peerRefusal(host: string, result: string | undefined): string {
  if (result === 'offline') return `${host} isn't connected right now, so this didn't reach their Claude. Send it again later.`
  if (result === 'gone') return "The shared session has ended, so this didn't reach anyone's Claude."
  if (result === 'busy') return `Too many messages went to ${host}'s session this minute, so this one didn't. Send it again in a minute.`
  if (result === 'large') return `This was too large to send to ${host}'s session, so it didn't reach their Claude.`
  return `Couldn't reach the share server, so this didn't reach ${host}'s Claude.`
}

// To the room for the other side (POST peer): what came of it, in a word. A
// guest's refused bearer takes a new seat and goes once more with it.
async function postPeer($: $, room: ShareRoom, body: Record<string, unknown>): Promise<'delivered' | 'offline' | 'gone' | 'busy' | 'large' | 'unreachable'> {
  for (let again = room.seat !== 'host'; ; again = false) {
    const now = await read($, roomA)
    const token = now?.id === room.id ? now.token : room.token
    try {
      const answer = await api<{ delivered?: boolean }>($, room.server, `/api/rooms/${room.id}/peer`, { method: 'POST', token, body })
      return answer.delivered === true ? 'delivered' : 'offline'
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && again && (await reseat($, room)).ok) continue
      if (!(error instanceof ApiError)) return 'unreachable'
      return error.status === 429 ? 'busy' : error.status === 413 ? 'large' : isGone(error) || error.status === 403 ? 'gone' : 'unreachable'
    }
  }
}

// What the room brought from the other side: a message, or a receipt.
async function takePeer($: $, room: ShareRoom, host: boolean, value: Record<string, unknown>) {
  if (!stillInRoom(room, scope)) return
  if (host) return 'status' in value ? hostReceipt($, room, value) : hostPeer($, room, value)
  return 'status' in value ? guestReceipt($, room, value) : guestPeer($, room, value)
}

// Host: the relays delivered here, by mailbox and words, with the guest's id
// for the turn it plays them in (`pid`), so the turn they start, or the turn
// they go into, is told by it: the newest 32, in memory.
const relaysHere: { box: string; pid: string; text: string }[] = []
const relayPidOf = (box: string, text: string) => relaysHere.findLast(r => r.box === box && r.text === text)?.pid

// Host: a teammate's session's message, into this session natively, from
// the mailbox for its seat and handle. Where it can't go, the teammate's
// turn for it is declined, which tells their session why.
async function hostPeer($: $, room: ShareRoom, value: Record<string, unknown>) {
  const { seat, handle, name, mode, chain, id, pid, body } = value
  if (typeof seat !== 'string' || !seat || typeof handle !== 'string' || !PEER_ID.test(handle) || typeof pid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(pid) || typeof body !== 'string' || !body.trim()) return
  const who = typeof value.who === 'string' && value.who ? tidySender(value.who) : 'A teammate'
  const decline = (reason: string) => send($, 'declined', { pid, who, reason })
  const s = scope
  if ((await read($, policyA)).prompts === 'watch') return decline(`${room.host} has this shared session on watch-only, so this didn't reach their Claude.`)
  const missing = await peerMissing($)
  if (missing) return decline(`${room.host}'s computer can't take this: ${missing}.`)
  const route: SharePeerRoute = { kind: 'host', seat, handle, who, name: typeof name === 'string' && name ? tidySender(name.replace(/[\r\n<>"]+/g, ' ')) : 'another session', at: await $.clock.now() }
  const box = await keepRoute($, room, s, route)
  if (!box) return
  const run = await openMailbox($, room, s, box, route)
  if ('error' in run) {
    return decline(run.error === 'UNSUPPORTED' ? `${room.host}'s computer can't take messages from other sessions, so this didn't reach their Claude.`
      : run.error === 'NODE' ? `${room.host}'s computer couldn't take this in (it needs Node 20 or later), so this didn't reach their Claude.`
      : `${room.host}'s computer couldn't take this in, so it didn't reach their Claude.`)
  }
  const hops = Array.isArray(chain) ? chain.filter((t): t is string => typeof t === 'string' && HOP_TOKEN.test(t)).slice(-32) : []
  // Known before it's delivered: its turn may start before the helper answers.
  const text = body.slice(0, 32_000)
  const relay = { box, pid, text: text.trim() }
  relaysHere.push(relay)
  if (relaysHere.length > 32) relaysHere.shift()
  const status = await mailboxControl($, run, {
    op: 'deliver', box, name: `${route.name} · via ${who}`,
    ...(typeof mode === 'string' && /^[a-z-]{1,32}$/.test(mode) ? { mode } : {}),
    chain: hops, ...(typeof id === 'string' && MSG_ID.test(id) ? { id } : {}), body: text,
  })
  if (status === 200) return
  relaysHere.splice(relaysHere.indexOf(relay), 1)
  decline(`${room.host}'s Claude Code didn't take this, so it didn't reach their Claude.`)
}

// Host: what became of a message this session's Claude wrote to a mailbox,
// at the session it went to: into this session, from that mailbox, as that
// session's Claude Code would have said it.
async function hostReceipt($: $, room: ShareRoom, value: Record<string, unknown>) {
  const receipt = peerReceiptOf(value, 'ref')
  if (!receipt || typeof value.seat !== 'string') return
  const found = Object.entries(await read($, peerRoutesA)).find(([, r]) => r.kind === 'host' && r.seat === value.seat && r.handle === receipt.handle)
  if (!found || found[1].kind !== 'host') return
  const run = await openMailbox($, room, scope, found[0], found[1])
  if (!('error' in run)) await mailboxControl($, run, { op: 'receipt', box: found[0], status: receipt.status, ref: receipt.of, ...(receipt.reason ? { reason: receipt.reason } : {}) })
}

// Host: whose mailbox an address is, by its id: the route and the id, else null.
async function mailboxOwner($: $, address: string | undefined): Promise<(Extract<SharePeerRoute, { kind: 'host' }> & { box: string }) | null> {
  const box = /\/ss-([0-9a-f]{32})\.sock$/.exec(address ?? '')?.[1]
  const route = box ? (await read($, peerRoutesA))[box] : undefined
  return route?.kind === 'host' ? { ...route, box: box! } : null
}

// Host: a peer row from a mailbox, as the room keeps it: under the teammate's
// name, the session's name and its words, as a relayed prompt is drawn, with
// the teammate's id for the turn it went into (`pid`); never the mailbox's
// path. Null: no text of this message came from one.
async function mailboxRows($: $, message: { role?: string; type?: string; content: unknown }): Promise<Row[] | null> {
  if ((message.role ?? message.type) !== 'user') return null
  const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? (message.content as { type?: string; text?: unknown }[]) : []
  const rows: Row[] = []
  for (const block of blocks) {
    const sent = block.type === 'text' && typeof block.text === 'string' ? delivered(block.text) : null
    const owner = sent?.address ? await mailboxOwner($, sent.address) : null
    if (!owner || !sent?.text) continue
    const pid = relayPidOf(owner.box, sent.text)
    rows.push({ kind: 'user', who: owner.who, text: `<cross-session-message from-name="${owner.name.replaceAll('"', '’')}">\n${sent.text}\n</cross-session-message>`, ...(pid ? { pid } : {}) })
  }
  return rows.length ? rows : null
}

// Host: a row naming a mailbox (Claude's SendMessage to one), as the room
// keeps it: the session it stands for in its place, never the path.
function hideMailboxes(row: Row, routes: Record<string, SharePeerRoute>): Row {
  const text = JSON.stringify(row)
  if (!text.includes('/ss-')) return row
  const shown = text.replace(/(?:uds:)?\/[^"\s\\]*\/ss-([0-9a-f]{32})\.sock/g, (whole, id: string) => {
    const route = routes[id]
    return route?.kind === 'host' ? `${route.name} (${route.who}'s agent)`.replace(/["\\]/g, '') : 'another session'
  })
  try { return JSON.parse(shown) as Row } catch { return row }
}

// Host: teammates' prompts go to Claude one at a time, each a turn of its
// own: prompts submitted together reach the engine as one turn, and every
// call in it counted as the first teammate's (their Always allow ran the
// other's calls unasked, and the other's prompt never started for them).
// The oldest goes once the session is idle (no turn of the main loop runs,
// a host's begun before Share too, `turnA`) and none sent before it waits
// to start; its turn's start takes it off (`turn.start`), and the session
// going idle again sends the next. A moment after idle, so a prompt of the
// host's waiting in the engine's queue starts first rather than with it.
function nextGuestPromptSoon($: $) {
  $.clock.after(250, () => void nextGuestPrompt($).catch(error => $.ui.log(`Shared session: a teammate's prompt: ${String((error as Error)?.message ?? error)}`, { to: 'debug' })))
}

async function nextGuestPrompt($: $) {
  if ((await read($, modeA)) !== 'host' || (await read($, workingA)) || (await read($, turnA))) return
  // Marked as it goes, so it goes once whoever looks at the same time.
  const won = { prompt: null as ShareGuestPrompt | null }
  const list = await update($, guestPromptsA, queue => {
    const first = queue.find(p => !p.aside)
    won.prompt = first && !first.sent ? first : null
    return won.prompt ? queue.map(p => (p === first ? { ...p, sent: true as const } : p)) : queue
  })
  const prompt = won.prompt
  if (!prompt) {
    const first = list.find(p => !p.aside)
    if (first?.sent) watchGuestPrompt($, first.pid)
    return
  }
  // From a timer, never inside another hook's dispatch, where it's refused.
  await $.prompt.submit({ text: prompt.framed, asUser: true }).then(
    entered => (entered.drop !== undefined ? notTaken($, prompt) : watchGuestPrompt($, prompt.pid)),
    () => notTaken($, prompt),
  )
}

// One sent that never starts (a hook rewrote its words past knowing, or the
// person took it off the queue) would hold back every one after it: once the
// session has been idle 5 s with no turn started since, it's set aside, and
// the next goes. Set aside, never forgotten: one the engine still holds (a
// turn it runs that this session never saw start) is still theirs when it
// starts, its calls put to the host as theirs (the newest 8 kept).
function watchGuestPrompt($: $, pid: string) {
  const starts = mainStarts
  $.clock.after(5_000, () => {
    void (async () => {
      if (mainStarts !== starts || (await read($, workingA))) return
      const first = (await read($, guestPromptsA)).find(p => !p.aside)
      if (first?.pid !== pid || !first.sent) return
      await update($, guestPromptsA, list => {
        const aside = list.map(p => (p.pid === pid ? { ...p, aside: true as const } : p))
        const old = aside.filter(p => p.aside).slice(0, -8)
        return aside.filter(p => !old.includes(p))
      })
      $.ui.log(`Shared session: ${first.who}'s prompt hasn't started; the next goes`, { to: 'debug' })
      nextGuestPromptSoon($)
    })().catch(() => {})
  })
}

// One Claude Code didn't take (a hook dropped it, or the submit was refused):
// they hear so, and the next goes.
async function notTaken($: $, prompt: ShareGuestPrompt) {
  await update($, guestPromptsA, list => list.filter(p => p.pid !== prompt.pid))
  const room = await read($, roomA)
  send($, 'declined', { pid: prompt.pid, who: prompt.who, reason: `${room?.host ?? 'The host'}'s Claude Code didn't take this prompt, so it didn't run. Send it again.` })
  nextGuestPromptSoon($)
}

// Host: a guest's attachments into .shared-session/<guest>/ in this session's
// folder, each under its own name.
async function saveAttachments($: $, who: string, files: ShareFileMeta[]): Promise<string[]> {
  const room = await read($, roomA)
  if (!room || !files.length) return []
  const cwd = await $.session.cwd()
  const dir = `${cwd}/.shared-session/${personDir(who, 'guest')}`
  const out: string[] = []
  for (const meta of files.slice(0, 10)) {
    const name = `${meta.id.slice(0, 6)}-${(meta.name || 'attachment').replace(/[^\w.\- ()]+/g, '-').replace(/^\.+/, '') || 'attachment'}`
    const path = await downloadFile($, room, meta, `${dir}/${name}`)
    if (path) out.push(path)
  }
  return out
}

// Guest: a held prompt goes out, with what came through of its attachments.
async function releaseHeld($: $, media: Media[]) {
  const held = heldPrompt
  if (!held) return
  heldPrompt = null
  held.timer.cancel()
  const room = await read($, roomA)
  const attachments: ShareFileMeta[] = []
  for (const [i, m] of media.slice(0, 10).entries()) {
    if (!room || m.data.length * 0.75 > IMAGE_MAX) continue
    const ext = m.type.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^\w]/g, '') || 'bin'
    const name = held.names[i] || `attachment-${i + 1}.${ext}`
    const meta = await uploadImage($, room, m, name)
    if (meta) attachments.push(meta)
  }
  const missing = Math.max(held.names.length, media.length) - attachments.length
  if (missing > 0) $.ui.log(`${missing === 1 ? 'An attachment' : `${missing} attachments`} didn't go with this message (over 8 MB, unreadable, or the room is full); the words did.`)
  send($, 'prompt', { text: held.text, pid: held.pid, ...(attachments.length ? { attachments } : {}) })
}

async function stopTurn($: $, who: string) {
  const working = await read($, workingA)
  if (!working) return
  try {
    await $.turn.abort({ turnId: working.turnId })
    $.ui.toast(`${who} stopped the turn`)
  } catch {}
}

// What the approval dialog previews: the command, the diff, the new file,
// cut at `lines` with what's left said (the Room shows the whole call).
function approvalPreview(tool: string, input: unknown, cwd: string, lines = 40): string {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const rel = (p: unknown) => (typeof p === 'string' && cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : str(p))
  const fence = (lang: string, body: string) => {
    const all = body.split('\n'), more = all.length - lines
    return `\`\`\`${lang}\n${all.slice(0, lines).join('\n')}\n\`\`\`${more > 0 ? `\n\n… ${more} more line${more === 1 ? '' : 's'}` : ''}`
  }
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

// The Room's view of a call waiting for the host: all of it, a sane bound
// past which it says how much more.
const WHOLE_CALL_LINES = 400

// A call as the host is asked about it and guests hear of it: the tool, and one line.
function callWhat(tool: string, input: unknown, cwd: string): string {
  const { text } = summarizeTool(tool, input, cwd)
  return `${tool}${text ? ` ${text}` : ''}`
}

// What that one line leaves out, said beside it in the row and the dialog's
// question: a command's lines after its first, the size of an edit or a new
// file (named by its path alone). Without it, a second line that did the
// harm ran unseen.
function callExtent(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const count = (v: unknown) => (typeof v === 'string' && v.replace(/\n+$/, '') ? v.replace(/\n+$/, '').split('\n').length : 0)
  const lines = (n: number) => `${n} line${n === 1 ? '' : 's'}`
  if (tool === 'Bash') return count(i.command) > 1 ? `+${lines(count(i.command) - 1)}` : ''
  if (tool === 'Write') return lines(count(i.content))
  if (tool === 'Edit') return `${count(i.old_string)} → ${lines(count(i.new_string))}`
  return ''
}

// The row's question: the oldest call waiting there, and how many more wait.
async function showBandAsk($: $) {
  await update($, approvingA, () => {
    const row = approvals.filter(a => a.stage === 'row')
    const first = row[0]
    return first ? { id: first.id, who: first.who, what: first.what, ...(first.extent ? { extent: first.extent } : {}), always: first.always, more: row.length - 1 } : null
  })
}

// A press answers the call its row was drawn for, never the next one.
function answerBandAsk(id: string, label: string) {
  const ask = approvals.find(a => a.id === id && a.stage === 'row')
  if (ask) answerFor(ask, label)
}

// Always allow trusts that person: their other calls waiting go with it,
// those in the row and those yet to be asked, but one up in the dialog,
// whose answer is the dialog's.
function answerFor(ask: Approval, label: string) {
  const all = label === ask.always ? approvals.filter(a => samePerson(a, ask) && (a === ask || a.stage !== 'dialog')) : [ask]
  for (const a of all) a.answer(label)
}

// ---------------------------------------------------------------------------
// The cloud host (docs/cloud-host.md). Move to cloud hands this session's host
// to a runner the room server starts, with the person's own Claude sign-in
// (`claude setup-token`); this session goes on as a guest and the room's
// approver: the runner's questions are put to it. Bring home takes the host
// back, with the cloud's changes.

// A cloud host's answer, from the approver: settles the call it was asked
// for, or the question about its localhost now put to them (`pumpHostAsks`).
function settleCloudAnswer(body: Record<string, unknown>) {
  const label = typeof body.answer === 'string' ? body.answer : ''
  const active = hostAskActive
  if (active?.yes && active.id === body.id) return active.answer(label === active.yes ? 'yes' : label === 'Not now' ? 'no' : 'later')
  const ask = approvals.find(a => a.id === body.id && a.stage === 'row')
  if (ask && ['Allow once', ask.always, 'Decline'].includes(label)) answerFor(ask, label)
}

// Approver: a question from the cloud host, drawn above the prompt and in the
// Room; said as it comes, kept quietly from history (one asked while this
// computer slept), never once it's past its ten minutes.
async function takeCloudAsk($: $, event: ServerEvent, live: boolean) {
  const b = event.body
  // Done at the cloud host: taken back (unanswered), or what a yes came to
  // there, said as it comes.
  if (b.done === true && typeof b.id === 'string') {
    await update($, cloudAsksA, list => list.filter(a => a.id !== b.id))
    const ports = (v: unknown) => (Array.isArray(v) ? v.filter(validPort).slice(0, 8) : [])
    const shared = ports(b.shared), failed = ports(b.failed), link = b.kind === 'show'
    const said = [
      ...(shared.length ? [link ? `The cloud host is sharing ${portList(shared)} with the room through its link.` : `Teammates can reach the cloud host's ${portList(shared)} now.`] : []),
      ...(failed.length ? [link ? `The cloud host couldn't share ${portList(failed)} with the room.` : `The cloud host couldn't forward ${portList(failed)} to teammates.`] : []),
    ]
    if (live && said.length) $.ui.toast(said.join(' '))
    return
  }
  if (typeof b.id !== 'string') return
  if ((await $.clock.now()) - event.ts > 10 * 60_000) return
  // About its localhost: drawn from what a yes shares, never from its words.
  const local = localAskOf(b)
  if (!local && typeof b.what !== 'string') return
  const options = Array.isArray(b.options) ? b.options.filter((o): o is string => typeof o === 'string').slice(0, 3) : []
  const ask: ShareCloudAsk = local
    ? { id: b.id, who: local.who ?? '', kind: local.kind, port: local.port, ...(local.label ? { label: local.label } : {}), related: local.related, what: cloudHostWords(local), always: '', options: [hostAskYes(local), 'Not now'], ts: event.ts }
    : {
        id: b.id,
        who: typeof b.who === 'string' ? b.who : 'Someone',
        ...(typeof b.seat === 'string' && b.seat ? { seat: b.seat.slice(0, 64) } : {}),
        what: String(b.what).slice(0, 200),
        ...(typeof b.extent === 'string' && b.extent ? { extent: b.extent.slice(0, 80) } : {}),
        ...(typeof b.preview === 'string' && b.preview ? { preview: b.preview.slice(0, 4000) } : {}),
        always: typeof b.always === 'string' ? b.always : '',
        options: options.length ? options : ['Allow once', 'Decline'],
        ts: event.ts,
      }
  await update($, cloudAsksA, list => (list.some(a => a.id === ask.id) ? list : [...list, ask].slice(-20)))
  if (!live) return
  $.ui.toast(local ? (ask.what.endsWith('?') ? `${ask.what} Answer above the prompt` : `${ask.what}: answer above the prompt`) : `${ask.who} wants Claude to run ${ask.what.slice(0, 80)}: answer above the prompt`)
  void cue($, 'mention', local ? ask.what.slice(0, 80) : `${ask.who} wants Claude to run ${ask.what.slice(0, 60)}`)
  nudgeSidebar($)
}

// A cloud host's question about its localhost, as the approver takes it: its
// kind, the ports a yes shares (a page's servers three at most, like the
// host's own row), their labels, and the guest whose window asked.
function localAskOf(b: Record<string, unknown>): ShareHostAsk | null {
  const kind = b.kind === 'show' || b.kind === 'related' || b.kind === 'mention' || b.kind === 'need' ? b.kind : null
  if (!kind || !validPort(b.port)) return null
  const related = kind !== 'related' || !Array.isArray(b.related) ? [] : b.related.filter((r): r is { port: number; label?: unknown } => validPort(r?.port)).slice(0, ASK_PORTS).map(r => ({ port: Number(r.port), label: cleanLabel(r.label, 40) }))
  if (kind === 'related' && !related.length) return null
  const label = cleanLabel(b.label, 40)
  return { id: '', kind, port: Number(b.port), ...(label ? { label } : {}), ...(kind === 'need' ? { who: cleanLabel(b.who, 40) || 'A guest' } : {}), related }
}

// What the approver's yes does, said under the question in the Room.
function cloudAskMeans(ask: ShareCloudAsk): string {
  if (ask.kind === 'show') return 'Its Claude gave out this page. Shared, everyone in the room can open it through its link.'
  if (ask.kind === 'mention') return "Allowed, teammates open it at that address on their own computer, forwarded from the cloud host's."
  if (ask.kind === 'related') return 'Its page uses this beside it. Shared, it reaches teammates at the same address, for that page.'
  return "Their preview window reached this port of the cloud host's. Shared, it reaches them at the same address."
}

// The approver's words for it: the host's row's, of the cloud host's
// localhost, every port a yes shares before what may be cut.
function cloudHostWords(ask: ShareHostAsk): string {
  const theirs = "the cloud host's "
  if (ask.kind === 'related') return hostAskWords(ask).replace(/localhost:(\d+)$/, `${theirs}localhost:$1`)
  if (ask.kind === 'mention') return `Let guests open ${theirs}localhost:${ask.port} at the same address?`
  if (ask.kind === 'show') return `Share ${theirs}${serviceName({ port: ask.port, label: ask.label })} with the room?`
  return `${ask.who ?? 'A guest'}'s preview needs ${theirs}${serviceName({ port: ask.port, label: ask.label })}`
}

// Approver: an answer for the cloud host. Always allow answers that person's
// other questions too: the cloud host trusts them from there, by their seat
// (never their name, which anyone can join as), and says which it settled.
async function answerCloudAsk($: $, id: string, label: string) {
  const list = await read($, cloudAsksA)
  const ask = list.find(a => a.id === id)
  if (!ask) return
  send($, 'answer', { id, answer: label })
  if (label !== '' && label === ask.always) await update($, cloudTrustedA, names => (names.includes(ask.who) ? names : [...names, ask.who]))
  const gone = label !== '' && label === ask.always && ask.seat ? list.filter(a => a.seat === ask.seat) : [ask]
  await update($, cloudAsksA, now => now.filter(a => !gone.some(g => g.id === a.id)))
  await flushOut($)
}

// The room's word on its cloud host, said where people look.
async function noteCloud($: $, room: ShareRoom, mode: ShareMode, event: ServerEvent) {
  const b = event.body
  const by = typeof b.by === 'string' ? b.by : room.host
  if (b.state === 'home' || b.state === 'stopped') await update($, cloudAsksA, () => [])
  if (b.state === 'home') await update($, cloudTrustedA, () => [])
  if (mode !== 'guest') return
  const mine = (await read($, cloudA))?.mine
  const said =
    b.state === 'starting' ? (mine ? '' : `${by} moved this session to the cloud: it keeps running when their computer sleeps.`)
    : b.state === 'running' ? (mine ? 'Your session runs in the cloud now. Teammates’ calls come to you to approve, here and in the Room.' : '')
    : b.state === 'stopped' ? `The cloud host stopped${b.why === 'expired' ? ' after its week' : ''}. ${mine ? 'Press Bring home in the Room to take the session back.' : `${room.host} brings it home to go on.`}`
    : b.state === 'home' && !mine ? `${by} brought this session home.`
    : ''
  if (said) $.ui.log(said)
}

// The Claude sign-in a cloud host runs with: the person's own, made by
// `claude setup-token` (model use only, a year), kept here (0600) for the
// next move. Taken from the clipboard on their press, never shown.
const CLOUD_TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{20,400}$/
async function cloudTokenPath($: $): Promise<string> {
  const dir = await configDirOf($)
  if (!dir) throw new Error('No Claude configuration folder')
  return `${dir}/shared-session/cloud-token`
}
async function savedCloudToken($: $): Promise<string | null> {
  const path = await cloudTokenPath($)
  if (!(await $.fs.exists(path))) return null
  const token = (await $.fs.read(path)).trim()
  return CLOUD_TOKEN.test(token) ? token : null
}
async function takeCopiedToken($: $): Promise<boolean> {
  const pasted = await sh($, 'if command -v pbpaste >/dev/null 2>&1; then pbpaste; elif command -v wl-paste >/dev/null 2>&1; then wl-paste -n; elif command -v xclip >/dev/null 2>&1; then xclip -o -selection clipboard; fi\n', 5_000)
  const token = pasted.out.trim()
  if (!CLOUD_TOKEN.test(token)) {
    await update($, cloudMoveA, () => cloudMove('token', "That isn't a token from claude setup-token (it starts sk-ant-oat01-). Copy the token it printed, then press again."))
    return false
  }
  const path = await cloudTokenPath($)
  const tag = fence(token)
  const tmp = `${path}.${randomSecret()}.tmp`
  const saved = await sh($, `umask 077\nset -e\nmkdir -p ${sq(path.slice(0, path.lastIndexOf('/')))}\ncat > ${sq(tmp)} <<'${tag}'\n${token}\n${tag}\nchmod 600 ${sq(tmp)}\nmv ${sq(tmp)} ${sq(path)}\n`)
  if (saved.code !== 0) {
    await update($, cloudMoveA, () => cloudMove('failed', "Couldn't keep the token on this computer."))
    return false
  }
  // Not on the clipboard any longer than needed.
  void sh($, 'if command -v pbcopy >/dev/null 2>&1; then printf "" | pbcopy; fi\n', 5_000).catch(() => {})
  return true
}
async function forgetCloudToken($: $) {
  await sh($, `rm -f ${sq(await cloudTokenPath($))}\n`)
}

// The packed session: the project as git sees it (tracked, and untracked not
// ignored; else every file but .git and node_modules), never what this plugin
// saved under .shared-session/, and this session's conversation. Outer tar:
// project.tgz (paths from the project's root) and transcript.jsonl.
const CLOUD_BUNDLE_BYTES = 95 * 1024 * 1024
async function packSession($: $): Promise<{ path: string; dir: string; size: number }> {
  const cwd = await $.session.cwd()
  const config = await configDirOf($)
  const session = await $.session.id()
  const r = await sh(
    $,
    [
      'set -e',
      'umask 077',
      `cwd=${sq(cwd)}`,
      'dir=$(mktemp -d)',
      'cd "$cwd"',
      'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git ls-files -co --exclude-standard; else find . -type f -not -path "./.git/*" -not -path "./node_modules/*" | sed "s,^\\./,,"; fi \\',
      '  | grep -v -e "^\\.shared-session/" | while IFS= read -r f; do if [ -f "$f" ] || [ -L "$f" ]; then printf "%s\\n" "$f"; fi; done > "$dir/list"',
      'tar -czf "$dir/project.tgz" -T "$dir/list"',
      config ? `t=$(ls ${sq(config)}/projects/*/${sq(`${session}.jsonl`)} 2>/dev/null | head -1)` : 't=""',
      'if [ -n "$t" ]; then cp "$t" "$dir/transcript.jsonl"; set -- project.tgz transcript.jsonl; else set -- project.tgz; fi',
      'tar -czf "$dir/session.tgz" -C "$dir" "$@"',
      'rm -f "$dir/list" "$dir/project.tgz" "$dir/transcript.jsonl"',
      'echo "dir=$dir"',
      'echo "size=$(wc -c < "$dir/session.tgz" | tr -d " ")"',
      '',
    ].join('\n'),
    120_000,
  )
  const dir = /dir=(\S+)/.exec(r.out)?.[1]
  const size = Number(/size=(\d+)/.exec(r.out)?.[1])
  if (r.code !== 0 || !dir || !Number.isFinite(size)) throw new Error("Couldn't pack the project")
  return { path: `${dir}/session.tgz`, dir, size }
}

// Move to cloud: the host's own press. Packs, hands the room over, streams
// the packed session to the runner, and goes on here as the approver.
async function moveToCloud($: $) {
  const room = await read($, roomA)
  if (!room || (await read($, modeA)) !== 'host' || (await isRunner($))) return
  const signIn = await savedCloudToken($)
  if (!signIn) return void (await update($, cloudMoveA, () => cloudMove('token')))
  await update($, cloudMoveA, () => cloudMove('packing'))
  let packed: { path: string; dir: string; size: number } | null = null
  try {
    packed = await packSession($)
    if (packed.size > CLOUD_BUNDLE_BYTES) throw new Error(`This project is ${Math.round(packed.size / 1024 / 1024)} MB packed; a move takes up to ${CLOUD_BUNDLE_BYTES / 1024 / 1024} MB.`)
    // What only this computer serves can't come along: its previews end first.
    for (const share of Object.values(await read($, sharesA))) await stopPreview($, share.pid)
    await update($, cloudMoveA, () => cloudMove('starting'))
    const state = {
      policy: await read($, policyA),
      trusted: await read($, trustedA),
      shown: keptShown(await read($, shownA), 20).filter(x => x.kind !== 'preview'),
      activity: (await read($, activityA)).slice(-40),
      chat: (await read($, chatA)).slice(-40),
    }
    const moved = await api<{ token: string; seat: string; ticket: string }>($, room.server, `/api/rooms/${room.id}/cloud`, {
      method: 'POST',
      token: room.token,
      body: { session: await $.session.id(), cwd: await $.session.cwd(), state, auth: { oauthToken: signIn } },
    })
    // The packed session, as it is, to the runner: the ticket on stdin, never argv.
    const sent = await sh(
      $,
      `curl -sS -o /dev/null -w "%{http_code}" -X PUT --data-binary @${sq(packed.path)} -K - <<'CS_CFG'\nurl = ${cfg(`${room.server}/api/rooms/${room.id}/cloud/bundle`)}\nheader = ${cfg(`Authorization: Bearer ${moved.ticket}`)}\nheader = "Content-Type: application/gzip"\nCS_CFG\n`,
      300_000,
    )
    if (sent.out.trim() !== '200') {
      // Nothing to run on: the host comes straight back here.
      await api($, room.server, `/api/rooms/${room.id}/cloud/home`, { method: 'POST', token: moved.token, body: {} }).catch(() => {})
      throw new Error("The packed session didn't reach the cloud host, so the session stays here.")
    }
    // On here as the approver: this session's place as a guest, taken up as
    // a reopened session takes its seat back.
    const now = await $.clock.now()
    const place: Joined = {
      at: now,
      room: { ...room, token: moved.token, seat: moved.seat, since: now },
      autoOpen: await read($, autoOpenA),
      policy: state.policy,
      shown: state.shown,
      activity: state.activity,
      chat: state.chat,
      sidebar: await read($, sidebarA),
      place: (await placeOf($)) || undefined,
      cloudMine: true,
      // Whom it always allowed here, the cloud host's now: Ask again in the Room asks about them again.
      cloudTrusted: [...new Set(state.trusted.map(t => t.who))],
    }
    await closeRoom($, 'ended', { room })
    await writeRoomCheckpoint($, `${JOINED_KEY}${await $.session.id()}`, place)
    await resumeJoined($)
    await update($, cloudMoveA, () => null)
  } catch (error) {
    await update($, cloudMoveA, () => cloudMove('failed', String((error as Error)?.message ?? error).slice(0, 300)))
  } finally {
    if (packed) void sh($, `rm -rf ${sq(packed.dir)}\n`).catch(() => {})
  }
}

// Bring home: the approver's press. The runner stops, and this session takes
// the host back as a reopened host session does, with the cloud's changes.
async function bringHome($: $) {
  const room = await read($, roomA)
  if (!room || (await read($, modeA)) !== 'guest' || !(await read($, cloudA))?.mine) return
  await update($, cloudMoveA, () => cloudMove('home'))
  try {
    const home = await api<{ token: string; changes: ShareFileMeta | null }>($, room.server, `/api/rooms/${room.id}/cloud/home`, { method: 'POST', token: room.token, body: {} })
    const now = await $.clock.now()
    const place: Hosting = {
      at: now,
      room: { ...room, token: home.token, seat: 'host', since: now },
      policy: await read($, policyA),
      trusted: [],
      shares: {},
      shown: keptShown(await read($, shownA), 20).filter(x => x.kind !== 'preview'),
      activity: (await read($, activityA)).slice(-40),
      chat: (await read($, chatA)).slice(-40),
      sidebar: await read($, sidebarA),
      place: (await placeOf($)) || undefined,
    }
    await closeRoom($, 'ended', { room })
    await writeRoomCheckpoint($, `${HOSTING_KEY}${await $.session.id()}`, place)
    await resumeHosting($)
    await update($, cloudMoveA, () => null)
    if (home.changes) await applyCloudChanges($, { ...room, token: home.token }, home.changes)
    else $.ui.log('Back home. The cloud host changed no files.')
  } catch (error) {
    await update($, cloudMoveA, () => cloudMove('failed', String((error as Error)?.message ?? error).slice(0, 300)))
  }
}

// The cloud's changes, into the project: applied when they apply cleanly,
// else kept beside it with how to apply them.
async function applyCloudChanges($: $, room: ShareRoom, changes: ShareFileMeta) {
  const cwd = await $.session.cwd()
  const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
  const rel = `.shared-session/cloud/changes-${stamp}.patch`
  const r = await sh(
    $,
    [
      'set -e',
      'umask 077',
      `cd ${sq(cwd)}`,
      'mkdir -p .shared-session/cloud',
      `curl -sS -f -o ${sq(rel)} -K - <<'CS_CFG'\nurl = ${cfg(`${room.server}/api/rooms/${room.id}/files/${changes.id}`)}\nheader = ${cfg(`Authorization: Bearer ${room.token}`)}\nCS_CFG`,
      `if git apply --check ${sq(rel)} 2>/dev/null; then git apply ${sq(rel)}; echo applied=$(grep -c "^diff --git" ${sq(rel)}); else echo kept; fi`,
      '',
    ].join('\n'),
    120_000,
  )
  const applied = /applied=(\d+)/.exec(r.out)?.[1]
  if (applied) $.ui.log(`Back home, with the cloud host's changes to ${applied} file${applied === '1' ? '' : 's'} in your project (also kept in ${rel}).`)
  else if (/kept/.test(r.out)) $.ui.log(`Back home. The cloud host's changes don't apply cleanly over your files, so they're kept in ${rel}: apply them with git apply --3way ${rel}`)
  else $.ui.log("Back home. The cloud host's changes couldn't be downloaded; they're in the Room's files for a while.")
}

// Two calls put to the host are one person's: one seat, or one account.
const samePerson = (a: Approval, b: Approval) => (Boolean(a.seat) && a.seat === b.seat) || (Boolean(a.account) && a.account === b.account)

function wakeApprovals() {
  for (const done of [...approvalWaiters]) done()
}

// A call's wait for its turn at the dialog, or for its answer in the row:
// in `nap`s, which the hook's own budget doesn't pay for (it may wait
// minutes; on a plain promise it ran out of its 10 s, and the engine decided
// the call without the host: what the mode allows ran), woken at once as
// the dialog frees or a call goes. Replaced by a reload, this module no
// longer draws the row: the call goes, declined, rather than wait for a
// press that can't reach it, or put up a question no button answers.
async function approvalWait($: $, ask: Approval, answered: Promise<string>, done: () => boolean) {
  while (!done()) {
    let wake!: () => void
    const woken = new Promise<void>(resolve => { wake = resolve })
    approvalWaiters.add(wake)
    try {
      await Promise.race([answered, woken, nap($, 1_000)])
    } finally {
      approvalWaiters.delete(wake)
    }
    if (!done() && (await replaced($))) ask.answer(REPLACED)
  }
}

// The room a call was asked in, still the one this session hosts (read after
// a write of the hook's, so as it is now, not as its first read had it).
async function askedRoomOpen($: $, room: string): Promise<boolean> {
  const now = await read($, roomA)
  return Boolean(now && roomIdentity(now) === room && (await read($, modeA)) === 'host')
}

// Where the row above the prompt is drawn: the terminal and Desktop. VS Code
// (and a -p run) draw none, and a call asked there waited ten minutes on a
// row nobody saw.
function drawsRow(surfaces: readonly RenderSurface[]): boolean {
  return surfaces.some(s => s === 'terminal' || s === 'desktop')
}

// Host: whose a call is. On an agent's loop, the teammate whose turn (or
// agent) started it (`agentsA`), whatever turn runs by then, since a
// background agent goes on after the turn that started it. Otherwise the
// running turn's when that's a teammate's: on the main loop; the host's own
// agent, which a teammate's turn can tell what to do (SendMessage); and an
// agent this session never saw start (a forked skill, an engine's own fork,
// one begun before this version loaded). null is the host's own, which the
// mode decides: put to the host, those would be declined where no dialog or
// row shows (a -p host).
async function callOwner($: $, agentId: string | undefined): Promise<ShareOwner | null> {
  const owner = agentId === undefined ? undefined : ownerOf((await read($, agentsA))[agentId])
  if (owner?.who) return owner
  return turnOwner(await read($, workingA))
}

// The running turn's teammate, when a teammate's prompt started it.
const turnOwner = (working: ShareWorking | null): ShareOwner | null => (working?.byGuest ? { who: working.by, seat: working.seat ?? '' } : null)

// An owner as the state keeps it; one written as a bare name (by a module
// before owners had seats) has no seat it can be told by.
const ownerOf = (value: ShareOwner | string | undefined): ShareOwner | undefined =>
  value === undefined ? undefined : typeof value === 'string' ? { who: value, seat: '' } : value

// A guest's read inside the project as it really is: each path it names,
// links followed (a link in the project to ~/.ssh reads ~/.ssh), in the
// project's own real folder. A path that doesn't exist yet counts by the
// nearest folder that does; one that can't be told (no realpath here, a
// dangling link) asks. A call naming no path reads the project itself.
async function readsInsideReally($: $, tool: string, input: Record<string, unknown>, cwd: string): Promise<boolean> {
  const targets = readTargets(tool, input, cwd)
  if (!targets) return false
  if (!targets.length) return true
  // Paths have no newline (`readTargets`), so each is a line; one that hangs (a stalled mount) asks.
  const { code, out } = await spawned($, ['/bin/sh', `${$.plugin.root}/relay/real.sh`, cwd, ...targets], undefined, 5_000)
  const [root, ...paths] = out.split('\n').slice(0, targets.length + 1)
  return code === 0 && root !== undefined && paths.length === targets.length && realInside(root, paths)
}

// Always allow is for a person, never a name, which is whatever someone joins
// as: the seat it was given for, or that seat's account (their other
// sessions, a seat the room gave them anew). An owner with no seat it can be
// told by is never always allowed.
function trusts(trusted: readonly ShareTrust[], owner: ShareOwner, people: readonly SharePerson[]): boolean {
  if (!owner.seat) return false
  const account = seatAccount(owner.seat, people)
  return trusted.some(t => typeof t === 'object' && Boolean(t.seat) && (t.seat === owner.seat || (Boolean(account) && t.account === account)))
}

// The account a seat belongs to, as the room's people say.
const seatAccount = (seat: string, people: readonly SharePerson[]): string | undefined => (seat ? people.find(p => p.seats?.includes(seat))?.account : undefined)

// Whether the host always allows this person (the Room's list of people).
const trustsPerson = (trusted: readonly ShareTrust[], p: SharePerson): boolean =>
  trusted.some(t => typeof t === 'object' && Boolean(t.seat) && (Boolean(p.seats?.includes(t.seat)) || (Boolean(p.account) && t.account === p.account)))

// A teammate's call put to the host: unanswered until its hook has the
// answer. Recorded here first, so a write that fails still leaves it denied.
async function noteAsked($: $, id: string, what: string) {
  askedHere.set(id, what)
  await update($, unansweredA, list => [...list.filter(c => c !== id), id].slice(-64))
}

// Answered (or denied for want of an answer). A write that fails leaves a
// stale id, which nothing will ask about again: the answer stands.
async function noteAnswered($: $, id: string) {
  askedHere.delete(id)
  if ((await read($, unansweredA).catch(() => [] as string[])).includes(id)) await update($, unansweredA, list => list.filter(c => c !== id)).catch(() => {})
}

// Denied in the host's place (a reload replaced this module, or its hook
// failed): what the call put up goes with it, each part whatever another
// does. The working line's wait, when it names this call (the oldest still
// waiting here takes its place); guests' lines, told with an `approval`
// naming nothing (they clear, and draw nothing of it); and the row's
// question: replaced, this module takes back its own (`madeHere`), the row
// being the new module's; else the row is drawn again from what waits here.
async function takeBackAsk($: $, what: string, isReplaced: boolean) {
  const still = isReplaced ? undefined : approvals[0]
  if ((await read($, workingA).catch(() => null))?.waitingFor === what) await update($, workingA, w => (w?.waitingFor === what ? { ...w, waitingFor: still?.what ?? null } : w)).catch(() => {})
  send($, 'approval', { pending: false })
  if (still) send($, 'approval', { pending: true, what: still.what })
  if (!isReplaced) await showBandAsk($).catch(() => {})
  else if (madeHere.has((await read($, approvingA).catch(() => null))?.id ?? '')) await update($, approvingA, a => (a && madeHere.has(a.id) ? null : a)).catch(() => {})
}

// A module a reload replaced is unloaded as its last hook returns, its
// timers with it: what it still has to tell the room goes now, not on the
// outbox's timer.
async function flushOut($: $) {
  for (let i = 0; i < 5 && outbox.some(item => !item.hold); i++) {
    if (flushing) await nap($, 100)
    else await flush($)
  }
}

// Another module started after this one: a reload replaced it (`MODULE`).
// Every read of one dispatch sees one moment, its first read's, until the
// dispatch writes, and a hook waiting for the host's answer is one long
// dispatch: so the look is a write of what it reads (`update`), which sees
// the value as it is now, and so does every read after it.
async function replaced($: $): Promise<boolean> {
  const last = await update($, moduleA, m => m)
  return last !== null && last !== MODULE
}

// ---------------------------------------------------------------------------
// Guest

// Guest: why a message from another of this person's sessions can't go on
// to the host's session now, in words for that session (and for this one's
// turn for it): null when it can.
async function relayRefusal($: $, room: ShareRoom): Promise<string | null> {
  if ((await read($, policyA)).prompts === 'watch') return `${room.host} has this shared session on watch-only, so this didn't reach their Claude.`
  if ((await read($, peopleA)).some(p => p.role === 'host' && !p.online)) return peerRefusal(room.host, 'offline')
  const missing = await peerMissing($)
  return missing ? `This computer can't pass this on: ${missing}.` : null
}

// The row Claude Code wrote this session's transcript for a message from
// another session: the message id its sender gave it (that session's
// receipts name it) and the hop chain it came with (the host's Claude Code
// reads it to cut a loop). It's written a moment after the prompt enters
// (about 150 ms), so it's looked for every 100 ms, two seconds at most: the
// newest from that address with those words not taken already.
const rowsTaken = new Set<string>()
async function peerRow($: $, sent: { text: string; address: string }): Promise<{ id: string; chain: string[] } | null> {
  const sid = await $.session.id().catch(() => '')
  if (!/^[\w-]{8,80}$/.test(sid)) return null
  const file = (await sh($, `ls -1 "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${sid}.jsonl 2>/dev/null | head -1\n`)).out.trim()
  if (!file) return null
  for (let tries = 0; tries < 20; tries++) {
    const { out } = await sh($, `tail -n 200 ${sq(file)} | grep -F '"kind":"peer"'\n`)
    for (const line of out.split('\n').reverse()) {
      let row: { message?: { content?: unknown }; origin?: { kind?: unknown; from?: unknown; msg_id?: unknown; hopChain?: unknown } }
      try { row = JSON.parse(line) } catch { continue }
      const origin = row?.origin
      if (origin?.kind !== 'peer' || origin.from !== sent.address || typeof origin.msg_id !== 'string' || !MSG_ID.test(origin.msg_id) || rowsTaken.has(origin.msg_id)) continue
      const content = row.message?.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => (typeof b?.text === 'string' ? b.text : '')).join('') : ''
      if (delivered(text)?.text !== sent.text) continue
      rowsTaken.add(origin.msg_id)
      if (rowsTaken.size > 256) rowsTaken.delete(rowsTaken.values().next().value as string)
      return { id: origin.msg_id, chain: Array.isArray(origin.hopChain) ? origin.hopChain.filter((t): t is string => typeof t === 'string' && HOP_TOKEN.test(t)).slice(-32) : [] }
    }
    await pause($, 100)
  }
  return null
}

// A relay's turn here ends, saying what happened: at once if it's showing no
// one else's turn, else after it (`unsent`). One whose turn already came, or
// that went into a turn playing here, has none to end.
function endRelay(pid: string, note: string) {
  if (ownPending.delete(pid)) unsent.set(pid, note)
}

// How long a relay's turn here waits for the host's turn for it before it
// ends anyway: the host's Claude Code may hold it while the host decides,
// or take it up only after a long turn of its own.
const RELAY_WAIT_MS = 10 * 60_000

// Guest: a message from another of this person's sessions (A), on to the
// host's session, from a timer once its prompt entered here: with A's hop
// chain and message id from this session's transcript (a new id where that
// can't be read: then no receipt reaches A), A's name and mode class, and a
// handle for A at this seat, which the room carries in A's address's place.
// Where it can't go, A hears why, and its turn here ends saying so.
async function relayQueued($: $, room: ShareRoom, s: RoomScope, pid: string, sent: { from: string; text: string; address: string; mode?: string }) {
  const row = await peerRow($, sent)
  if (!stillInRoom(room, s)) return
  const name = tidySender(sent.from).replace(/[\x00-\x1f\x7f]+/g, ' ')
  const handle = await keepRoute($, room, s, { kind: 'guest', to: sent.address, name, seat: room.seat, at: await $.clock.now() })
  if (!handle) return
  const id = row?.id ?? newMsgId()
  const at = await $.clock.now()
  await update($, peerRelaysA, list => (s.live ? [...list.filter(r => r.id !== id), { id, pid, handle, to: sent.address, native: Boolean(row), at }].slice(-64) : list))
  const result = await postPeer($, room, { handle, name, ...(sent.mode && /^[a-z-]{1,32}$/.test(sent.mode) ? { mode: sent.mode } : {}), chain: row?.chain ?? [], id, pid, body: sent.text.slice(0, 32_000) })
  lastActivity = await $.clock.now()
  if (result === 'delivered') {
    $.clock.after(RELAY_WAIT_MS, () => endRelay(pid, `Passed on to **${room.host}**'s session; their Claude hasn't taken it up yet.`))
    return
  }
  const words = peerRefusal(room.host, result)
  endRelay(pid, words)
  tellPeer($, sent.address, words)
}

// Guest: what the host's session wrote back to one of this person's
// sessions, by the handle its message went with: sent to that session from
// this one (its next message comes here natively, with this send's hop chain
// on it). A handle this session didn't make goes nowhere: nothing reaches an
// address no message here came from. Where it can't go, the host's Claude
// hears it was dropped. The handles are read as a write, so the stream's
// long dispatch sees them as they are now.
async function guestPeer($: $, room: ShareRoom, value: Record<string, unknown>) {
  const { handle, body, ref } = value
  if (typeof handle !== 'string' || !PEER_ID.test(handle) || typeof body !== 'string' || !body.trim() || typeof ref !== 'string' || !MSG_ID.test(ref)) return
  const route = (await update($, peerRoutesA, all => all))[handle]
  const dropped = () => void postPeer($, room, { handle, status: 'dropped', ref }).catch(() => {})
  if (route?.kind !== 'guest') {
    $.ui.log("Shared session: a message for a session this one didn't relay went nowhere", { to: 'debug' })
    return dropped()
  }
  $.clock.after(0, () => void sendPeer($, route.to, body.slice(0, 32_000), { handle, ref }).then(ok => (ok ? undefined : dropped())))
}

// One message from this session to another of this person's: recorded once
// delivered, in the order sent, so a delivery notice about it is matched to
// it (`takeNotice`); a reply with the host's message's handle and id.
// Delivered means queued: a session in another permission mode class than
// this one holds it until its person lets it in.
async function sendPeer($: $, to: string, text: string, reply?: { handle: string; ref: string }): Promise<boolean> {
  const sent = await $.session.send({ to, text }).catch((error: unknown) => ({ isDelivered: false as const, reason: String((error as Error)?.message ?? error) }))
  if (!sent.isDelivered) {
    $.ui.log(`Shared session: a message to another session here didn't go: ${sent.reason}`, { to: 'debug' })
    return false
  }
  const at = await $.clock.now()
  await update($, peerSendsA, list => [...list, { to, at, ...reply }].slice(-64))
  return true
}

// Words for one of this person's sessions, from this session, from a timer:
// a peer's message there, never a prompt here.
function tellPeer($: $, to: string, text: string) {
  $.clock.after(0, () => void sendPeer($, to, text).catch(() => {}))
}

// What became of a session's message at the host's session: its turn here
// ends where the host's Claude Code holds, drops or refuses it, and the
// receipt goes into the session that wrote it (relay/receipt.cjs) as the
// host's Claude Code said it: only for the id that session gave it, and a
// release only after a hold.
const DROP_WORDS: Record<string, string> = {
  'rate-limited': 'too many messages too fast', duplicate: 'it repeated the one before', 'hop-loop': 'a relay loop between sessions was cut',
  'hop-runaway': 'a relay loop between sessions was cut', 'queue-full': 'too many messages were waiting there',
}
async function guestReceipt($: $, room: ShareRoom, value: Record<string, unknown>) {
  const receipt = peerReceiptOf(value, 'id')
  if (!receipt) return
  const relay = (await update($, peerRelaysA, list => list)).find(r => r.id === receipt.of && r.handle === receipt.handle)
  if (!relay) return
  if (receipt.status === 'held') endRelay(relay.pid, `**${room.host}**'s Claude Code is holding this until ${room.host} lets it in.`)
  else if (receipt.status === 'dropped') endRelay(relay.pid, `**${room.host}**'s Claude Code dropped this${receipt.reason ? ` (${DROP_WORDS[receipt.reason]})` : ''}.`)
  else if (receipt.status === 'refused') endRelay(relay.pid, `**${room.host}**'s Claude Code isn't taking messages from other sessions.`)
  if (!relay.native || !relay.to.startsWith('uds:') || (receipt.status === 'delivered' && !relay.held)) return
  if (receipt.status === 'held') await update($, peerRelaysA, list => list.map(r => (r.id === relay.id ? { ...r, held: true as const } : r)))
  const own = await $.env.get('CLAUDE_CODE_MESSAGING_SOCKET')
  if (!own) return
  const input = { path: relay.to.slice(4), status: receipt.status, from: `uds:${own}`, ref: receipt.of, ...(receipt.reason ? { reason: receipt.reason } : {}) }
  const child = $.process.spawn({ argv: ['/bin/sh', '-c', FIND_NODE, 'sh', `${$.plugin.root}/relay/receipt.cjs`], input: JSON.stringify(input) })
  let out = ''
  for await (const chunk of child) if (chunk.stream === 'stdout') out += chunk.text
  if (!out.includes('"sent"')) $.ui.log(`Shared session: a receipt didn't reach the session it's for (${out.trim().slice(0, 80) || 'no Node'})`, { to: 'debug' })
}

// A delivery notice Claude Code gives this session about what it sent
// another session (the host's replies, this plugin's notes): what became of
// them, the sessions they went to, and the message ids (five at most) it
// gave them, which a plugin's send never learns.
const NOTICE = '[Cross-session delivery notice] '
const NOTICE_STATUS: [RegExp, PeerStatus][] = [
  [/ dropped at that session's inbox/, 'dropped'], [/ held by that session/, 'held'], [/ denied by the recipient user/, 'denied'],
  [/ not approved before expiry/, 'expired'], [/ approved and released to that session/, 'delivered'], [/ (?:was|were) refused/, 'refused'],
]
const DROP_TEXTS: [string, string][] = [
  ['you sent faster than that session accepts', 'rate-limited'], ['it repeated your previous message', 'duplicate'],
  ['a relay loop between sessions was cut', 'hop-loop'], ['its queue of undelivered peer messages was full', 'queue-full'],
]
function noticeOf(text: string): { status: PeerStatus; to: string[]; ids: string[]; reason?: string } | null {
  if (!text.startsWith(NOTICE)) return null
  const status = NOTICE_STATUS.find(([re]) => re.test(text))?.[1]
  // " (recipient: <address>; msg_id: <id>)", or "2 recipients: …", three
  // addresses and five ids at most, "…" after.
  const detail = /\((?:(?:\d+ )?recipients?: ([^;)]*); )?msg_id: ([^)]*)\)/.exec(text)
  const ids = (detail?.[2] ?? '').split(', ').filter(id => MSG_ID.test(id))
  if (!status || !ids.length) return null
  const to = (detail?.[1] ?? '').split(', ').filter(a => /^(?:uds|bridge):\S/.test(a))
  const reason = status === 'dropped' ? DROP_TEXTS.find(([words]) => text.includes(words))?.[1] : undefined
  return { status, to, ids, ...(reason ? { reason } : {}) }
}

// Guest: a delivery notice, matched to what this session sent: a message id
// it named before is that send; a first receipt (a hold, a drop, a refusal)
// names the newest sends to those sessions no receipt named yet, in the
// order they went. A reply's goes to the host's session, for its helper to
// write into the host's Claude Code as the session it went to would have.
async function takeNotice($: $, text: string) {
  const notice = noticeOf(text)
  const room = await read($, roomA)
  if (!notice || !room || (await read($, modeA)) !== 'guest') return
  const first = notice.status === 'held' || notice.status === 'dropped' || notice.status === 'refused'
  const now = await $.clock.now()
  let matched: SharePeerSend[] = []
  await update($, peerSendsA, list => {
    const next = list.map(sent => ({ ...sent }))
    matched = []
    const unknown: string[] = []
    for (const id of notice.ids) {
      const known = next.find(sent => sent.id === id)
      if (known) matched.push(known)
      else if (first) unknown.push(id)
    }
    const open = next.filter(sent => !sent.id && now - sent.at < RELAY_WAIT_MS && (!notice.to.length || notice.to.includes(sent.to)))
    const taken = open.slice(Math.max(0, open.length - unknown.length))
    unknown.slice(unknown.length - taken.length).forEach((id, i) => {
      taken[i]!.id = id
      matched.push(taken[i]!)
    })
    return next
  })
  for (const sent of matched) {
    if (sent.handle && sent.ref) await postPeer($, room, { handle: sent.handle, status: notice.status, ref: sent.ref, ...(notice.reason ? { reason: notice.reason } : {}) })
  }
}

// Guest: the host's side declined a relay (its plugin couldn't take it in):
// the session that wrote it hears why. Its turn here ends with the same words
// as the ride reads the event.
async function declinedRelay($: $, pid: string, reason: string) {
  const relay = (await update($, peerRelaysA, list => list)).find(r => r.pid === pid)
  if (relay) tellPeer($, relay.to, reason)
}

// A saved place's routes of its side, checked: ids of the grammar, a guest's
// with an address a frame reaches.
function peerRoutesSaved(value: unknown, kind: SharePeerRoute['kind']): Record<string, SharePeerRoute> {
  if (!value || typeof value !== 'object') return {}
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null)
  const kept: [string, SharePeerRoute][] = []
  for (const [id, r] of Object.entries(value as Record<string, Record<string, unknown> | null>)) {
    if (!PEER_ID.test(id) || !r || typeof r !== 'object' || r.kind !== kind || !Number.isFinite(r.at)) continue
    const at = r.at as number
    if (kind === 'guest' && text(r.to) && /^(?:uds|bridge):\S/.test(r.to as string) && (r.to as string).length <= 512 && text(r.seat)) kept.push([id, { kind, to: r.to as string, name: tidySender(String(r.name ?? '')), seat: r.seat as string, at }])
    if (kind === 'host' && text(r.seat) && typeof r.handle === 'string' && PEER_ID.test(r.handle) && text(r.who)) kept.push([id, { kind, seat: r.seat as string, handle: r.handle, who: r.who as string, name: tidySender(String(r.name ?? '')), at }])
  }
  return Object.fromEntries(kept.slice(-64))
}

async function join($: $, server: string, id: string) {
  if (!secureServer(server)) throw new PlainServer(server)
  // A room being left finishes first: its state clears before this one's.
  // A late take-back it gives up is over once this room is joined, and kept
  // if it isn't (`roomMade`, `notMade`).
  const gaveUp = await roomClosed($)
  return joinRoom($, server, id).catch(error => notMade($, gaveUp, error))
}

// The room joined, and this session in it; its seat given back if not all of it came.
async function joinRoom($: $, server: string, id: string) {
  const name = await whoami($)
  // Signed in to that server: a session shared with a team asks who this is.
  const signedIn = await signInFor($, server)
  const joined = await api<{
    token: string
    seat: string
    title: string
    host: string
    seq: number
    history: ServerEvent[]
    people: SharePerson[]
    latest?: string
    fromNow?: boolean
    team?: { id: string; name: string }
    more?: boolean
    historySeq?: number
    /** What's shared now, whatever the history no longer holds. */
    previews?: unknown
  }>($, server, `/api/rooms/${id}/join?max=${PAGE_BYTES}`, { method: 'POST', body: { name }, account: signedIn?.token })
  try {
    // A long history comes in pages (the engine hands a plugin at most 4 MiB
    // of an answer): the rest of it, up to where the room stood at the join.
    let history = joined.history
    if (joined.more && typeof joined.historySeq === 'number') {
      const rest = await eventsSince($, { server, id, token: joined.token }, joined.historySeq, joined.seq)
      history = [...history, ...rest.events.filter(e => e.type !== 'delta')]
    }
    void readUpdates($).then(() => noteLatest($, joined.latest))
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
      team: joined.team ?? null,
    }
    // Its scope, before the room is anyone's to see. In it from here: a late
    // take-back given up for it is over.
    const s = openScope(room, 'guest')
    roomMade($)
    await update($, roomA, () => room)
    await update($, modeA, () => 'guest')
    await readyReplay($)
    await update($, peopleA, () => joined.people)
    await update($, workingA, () => null)
    // The room as it stands: what's shared now (a preview whose artifact is
    // out of the history is still listed), then its timeline, its chat and
    // the host's policy.
    await takeRoomList($, room, s, joined.previews)
    for (const event of history) await absorb($, room, 'guest', event, false)
    await flushCalls($, s)

    // A turn still running on the host plays out live; everything before it is
    // shown as it was, one exchange per prompt.
    const starts = history.filter(e => e.type === 'turn' && e.body.state === 'start')
    const ends = new Set(history.filter(e => e.type === 'turn' && e.body.state === 'end').map(e => e.body.turnId))
    const running = starts.filter(e => !ends.has(e.body.turnId)).at(-1)
    const past = history.filter(e => e.type === 'row' && (!running || e.seq < running.seq))
    if (running) noteHostTurn(running)
    // Previews the host still has open open here too, after the history (one
    // shown in the running turn opens as that turn plays out).
    const ended = (await read($, shownA)).filter(s => s.kind === 'preview' && s.closed).map(s => s.pid)
    const closed = new Set([...history.filter(e => e.type === 'preview' && e.body.state === 'closed').map(e => e.body.pid), ...ended])
    const open = new Map<string, ServerEvent>()
    for (const e of history) {
      if (e.type !== 'artifact' || e.body.kind !== 'preview' || typeof e.body.pid !== 'string' || closed.has(e.body.pid)) continue
      if (running && e.seq > running.seq) continue
      // Its latest showing, in the order last shown.
      open.delete(e.body.pid)
      open.set(e.body.pid, e)
    }
    // A page's dependency (an API it calls) is reached from the page, never what opens.
    const pages = [...open.values()].filter(e => dependencyOf(e.body.dependency) === undefined)
    startFeed($)
    void holdRoom($).catch(() => {})
    await markSidebar($, () => `👥 ${room.host} · ${room.title}`)
    return {
      room,
      history: exchanges(past.map(e => e.body as unknown as Row), joined.host),
      // One preview opens: they share one host name, so a browser holds one at a
      // time (the newest page); the rest are in the Room, a press of Open away.
      open: pages.slice(-1),
      fromNow: joined.fromNow === true,
    }
  } catch (error) {
    // Seated but not in: the seat goes, so nobody sees a guest who isn't there.
    await api($, server, `/api/rooms/${id}/leave`, { method: 'POST', token: joined.token }).catch(() => {})
    await closeRoom($, 'ended', { room: { server, id } })
    throw error
  }
}

// Everything in a room after `after` (up to `until`, when given), page by
// page so no answer passes what the engine hands a plugin.
async function eventsSince($: $, room: { server: string; id: string; token: string }, after: number, until = Number.POSITIVE_INFINITY): Promise<EventsPage> {
  const events: ServerEvent[] = []
  let cursor = after
  for (;;) {
    const page = await api<EventsPage>($, room.server, `/api/rooms/${room.id}/events?after=${cursor}&wait=0&max=${PAGE_BYTES}`, { token: room.token })
    for (const event of page.events) if (event.seq <= until) events.push(event)
    const stuck = page.seq <= cursor
    cursor = page.seq
    if (!page.more || stuck || cursor >= until) return { ...page, seq: Math.min(cursor, until), events, more: false }
  }
}

// ---------------------------------------------------------------------------
// What the host's Claude shows: files in the side panel or the Files pane,
// widgets, pages, previews of the host's localhost. The host's plugin sends
// each to the room (bytes as files); each guest's riding turn saves the files
// in .shared-session/ and makes the same call locally, so Claude Code's own
// viewers show it. A plugin's own call outside a turn opens nothing there; a
// call made as a step of a turn does.
//
// Shell work runs through `sh -s` from stdin, so room tokens never sit in a
// process's argv, and through $.process.spawn, whose open stream holds no
// prompt the way a $.http.fetch in flight does.

const MIME: Record<string, string> = {
  html: 'text/html', htm: 'text/html', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
  js: 'text/javascript', css: 'text/css', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mmd: 'text/plain',
}
const mimeOf = (path: string) => MIME[(path.split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream'
const baseName = (path: string) => path.split('/').filter(Boolean).at(-1) ?? 'file'
// A value inside a curl config file's double quotes.
const cfg = (value: string) => `"${value.replace(/[\r\n]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
// A string inside a shell script's single quotes.
const sq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
// A here-document delimiter that the body can't contain.
const fence = (body: string) => {
  let tag = 'CS_EOF'
  while (body.includes(tag)) tag += '_X'
  return tag
}
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(\/[^\s"'\\)<>]*)?/i

// Guest: the names files were saved under in this session, so a second file
// of the same name doesn't overwrite the first.
const savedNames = new Map<string, string>()
let excluded = false
let toolNames: Set<string> | null = null

// `within`: what must answer in that time, as the preview window's steps
// must (they go one at a time: one that hung would hold every Open after
// it). Past it the call answers `late`, with no code, and lets the child go.
async function sh($: $, script: string, within?: number): Promise<{ out: string; code: number | null; late?: true }> {
  return spawned($, ['/bin/sh', '-s'], script, within)
}

// A child's output and how it ended, as `sh`'s.
async function spawned($: $, argv: string[], input?: string, within?: number): Promise<{ out: string; code: number | null; late?: true }> {
  let out = ''
  let child: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
  const run = (async () => {
    try {
      child = $.process.spawn({ argv, ...(input === undefined ? {} : { input }) })
      for await (const chunk of child) if (chunk.stream === 'stdout') out += chunk.text
      return { out, code: (await child.result.catch(() => ({ code: null }))).code }
    } catch {
      return { out, code: null }
    }
  })()
  if (within === undefined) return run
  let timer: Timer | undefined
  const answer = await Promise.race([run, new Promise<null>(done => { timer = $.clock.after(within, () => done(null)) })])
  timer?.cancel()
  if (answer) return answer
  void child?.return(undefined as never).catch(() => {})
  return { out, code: null, late: true }
}

// A room address taken as it is (`globoff`): curl reads [1-9] and {a,b} in
// a URL as a pattern, one request into many.
function roomConfig(room: ShareRoom, path: string): string {
  return [`url = ${cfg(`${room.server}/api/rooms/${room.id}/${path}`)}`, `header = ${cfg(`Authorization: Bearer ${room.token}`)}`, 'silent', 'globoff'].join('\n')
}

// Host: one file to the room. Returns its id, name, type and size.
async function uploadFile($: $, room: ShareRoom, path: string, name = baseName(path)): Promise<ShareFileMeta | null> {
  const config = [roomConfig(room, 'files'), `header = ${cfg(`x-file-name: ${encodeURIComponent(name)}`)}`, `header = ${cfg(`content-type: ${mimeOf(name)}`)}`].join('\n')
  const tag = fence(config)
  const { out } = await sh($, `[ -f ${sq(path)} ] || exit 1\ncurl -K - -X POST --data-binary @${sq(path)} <<'${tag}'\n${config}\n${tag}\n`)
  try {
    const meta = JSON.parse(out) as Partial<ShareFileMeta>
    return typeof meta.id === 'string' ? (meta as ShareFileMeta) : null
  } catch {
    return null
  }
}

// Host: a picture's bytes (base64, as the transcript holds them) to the room.
async function uploadImage($: $, room: ShareRoom, media: Media, name: string): Promise<ShareFileMeta | null> {
  const config = [roomConfig(room, 'files'), `header = ${cfg(`x-file-name: ${encodeURIComponent(name)}`)}`, `header = ${cfg(`content-type: ${media.type}`)}`, 'max-time = 60'].join('\n')
  const b64 = (media.data.replace(/[^A-Za-z0-9+/=]/g, '').match(/.{1,76}/g) ?? []).join('\n')
  const data = fence(b64)
  const tag = fence(config)
  const { out } = await sh(
    $,
    [
      'd=$(mktemp -d) || exit 1',
      `trap 'rm -rf "$d"' EXIT`,
      `cat > "$d/b" <<'${data}'`,
      b64,
      data,
      '{ base64 -d < "$d/b" > "$d/f" || base64 -D -i "$d/b" -o "$d/f"; } 2>/dev/null || exit 1',
      `curl -K - -X POST --data-binary @"$d/f" <<'${tag}'`,
      config,
      tag,
      '',
    ].join('\n'),
  )
  try {
    const meta = JSON.parse(out) as Partial<ShareFileMeta>
    return typeof meta.id === 'string' ? (meta as ShareFileMeta) : null
  } catch {
    return null
  }
}

// Guest: a room picture's bytes, base64, kept for the session's later cards.
const pictureCache = new Map<string, string>()
async function downloadImage($: $, room: ShareRoom, image: RoomImage): Promise<string | null> {
  const kept = pictureCache.get(image.id)
  if (kept) return kept
  const config = [roomConfig(room, `files/${image.id}`), 'max-time = 60'].join('\n')
  const tag = fence(config)
  const { out, code } = await sh($, `curl -K - -f <<'${tag}' | base64 | tr -d '\\n\\r '\n${config}\n${tag}\n`)
  const data = out.trim()
  if (code !== 0 || !data || !/^[A-Za-z0-9+/=]+$/.test(data)) return null
  pictureCache.set(image.id, data)
  if (pictureCache.size > 40) pictureCache.delete(pictureCache.keys().next().value as string)
  return data
}

// Guest: a host result as the card shows it: its text, and its pictures as
// image blocks, as the host's own card holds them.
type ReplayBlock = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
async function withImages($: $, room: ShareRoom, text: string, images: RoomImage[] | undefined): Promise<string | ReplayBlock[]> {
  if (!images?.length) return text
  const blocks: ReplayBlock[] = text ? [{ type: 'text', text }] : []
  for (const image of images) {
    const data = await downloadImage($, room, image)
    if (data) blocks.push({ type: 'image', source: { type: 'base64', media_type: image.type, data } })
  }
  return blocks.length ? blocks : text || '(the picture didn\'t come through)'
}

// Host: text (a widget too big for an event) to the room, as a file.
async function uploadText($: $, room: ShareRoom, text: string, name: string): Promise<ShareFileMeta | null> {
  const tag = fence(text)
  const { out } = await sh($, `d=$(mktemp -d) || exit 1\ntrap 'rm -rf "$d"' EXIT\ncat > "$d/f" <<'${tag}'\n${text}\n${tag}\nprintf '%s' "$d/f"\n`)
  return out ? uploadFile($, room, out, name) : null
}

// A person's name as their folder in .shared-session/: one part of a path,
// never `.`, `..` or hidden. A room's names are whatever its people chose.
function personDir(name: string, fallback: string): string {
  return name.replace(/[^\w.-]+/g, '-').replace(/^\.+/, '').slice(0, 40) || fallback
}

// Guest: a room file into .shared-session/<host>/ in this session's folder
// (inside the project, so the browser pane runs its pages live), kept out of
// git, and only ever there (relay/save.sh): a name a room chose, or a link
// someone left in the folder, takes it nowhere else.
async function downloadFile($: $, room: ShareRoom, meta: ShareFileMeta, into?: string): Promise<string | null> {
  const cwd = await $.session.cwd()
  const dir = into ? into.slice(0, into.lastIndexOf('/')) : `${cwd}/.shared-session/${personDir(room.host, 'host')}`
  const clean = meta.name.replace(/[^\w.\- ()]+/g, '-').replace(/^\.+/, '') || 'file'
  const owner = savedNames.get(`${dir}/${clean}`)
  const dot = clean.lastIndexOf('.')
  const name = !owner || owner === meta.id ? clean : dot > 0 ? `${clean.slice(0, dot)}-${meta.id.slice(0, 6)}${clean.slice(dot)}` : `${clean}-${meta.id.slice(0, 6)}`
  const path = into ?? `${dir}/${name}`
  const box = `${cwd}/.shared-session/`
  if (!dir.startsWith(box)) return null
  const config = roomConfig(room, `files/${meta.id}`)
  const code = await saveHere($, [cwd, dir.slice(box.length), path.slice(path.lastIndexOf('/') + 1), ...(excluded ? [] : ['exclude'])], config)
  if (code !== 0) return null
  excluded = true
  savedNames.set(path, meta.id)
  return path
}

// relay/save.sh, its paths in argv and curl's settings (the room's token) on
// stdin: 0 when the file is saved.
async function saveHere($: $, args: string[], input: string): Promise<number | null> {
  try {
    const child = $.process.spawn({ argv: ['/bin/sh', `${$.plugin.root}/relay/save.sh`, ...args], input })
    for await (const _ of child) void _
    return (await child.result.catch(() => ({ code: null }))).code
  } catch {
    return null
  }
}

// Guest: what was shown, saved here. A page with files beside it (an Artifact's
// pictures) goes in a folder of its own, each file at its place, the page
// first, so it opens whole.
async function downloadShown($: $, room: ShareRoom, files: ShareFileMeta[]): Promise<string[]> {
  const paths: string[] = []
  if (!files.some(f => f.path)) {
    for (const meta of files) {
      const path = await downloadFile($, room, meta)
      if (path) paths.push(path)
    }
    return paths
  }
  const cwd = await $.session.cwd()
  const dir = `${cwd}/.shared-session/${personDir(room.host, 'host')}/page-${files[0]!.id.slice(0, 8)}`
  for (const meta of files) {
    const at = pagePath(meta.path ?? meta.name)
    if (!at) continue
    const path = await downloadFile($, room, meta, `${dir}/${at}`)
    if (path) paths.push(path)
  }
  return paths
}

async function hasTool($: $, name: string): Promise<boolean> {
  if (!toolNames) toolNames = new Set((await $.tool.list().catch(() => [])).map(t => t.name))
  return toolNames.has(name)
}

async function widgetTool($: $): Promise<string | null> {
  if (await hasTool($, 'mcp__visualize__show_widget')) return 'mcp__visualize__show_widget'
  return [...(toolNames ?? [])].find(n => n.endsWith('__show_widget')) ?? null
}

// ---------------------------------------------------------------------------
// Previews: what a click starts can outlive the room it began in. Each step
// after an await checks that room is still this session's.

const roomIdentity = (room: { server: string; id: string }) => `${room.server}/${room.id}`

// A request made with the room's token: its room's scope still open, at the
// seat it was made with. A reseat (the room let the old seat go) gives the
// scope the new seat's token, which ends it.
function sameRoom(room: ShareRoom, s: RoomScope): boolean {
  return s.live && s.key === roomIdentity(room) && s.token === room.token
}

// Long-lived work (a listener, the window, its proxy and tunnels, and what
// they say): its room's scope still open, at whatever seat this session
// holds now. A reseat changes the token, not the scope: listeners and the
// window go on, and their refusals and failures are still said.
function stillInRoom(room: { server: string; id: string }, s: RoomScope): boolean {
  return s.live && s.key === roomIdentity(room)
}

// Two holds of one room at one seat: its server, its id and the seat's
// token (a worker started with the room as it was, and the room asking now).
function sameRoomId(a: Pick<ShareRoom, 'server' | 'id' | 'token'>, b: Pick<ShareRoom, 'server' | 'id' | 'token'>): boolean {
  return a.server === b.server && a.id === b.id && a.token === b.token
}

// A listener lasts until it's stopped (Close, Stop, Leave: each fences it by
// its preview's epoch or its room's scope, never by the saved list, which only
// says what comes back after a reload); the window's own tunnel while the
// window does and the host allows it.
async function localInterest($: $, pid: string, run: LocalPreviewRun): Promise<boolean> {
  return run.owner === 'listener' || (await windowInterest($, pid, run.scope))
}

// One task at a time, each after the one before it settles, whatever it came
// to: the host's share writes and their revocations (`sharesLane`), and the
// commands to its TCP worker (`TcpWorkerRun.queue`).
type Lane = { run<T>(task: () => Promise<T>): Promise<T>; idle(): Promise<void> }
function lane(): Lane {
  let last: Promise<void> = Promise.resolve()
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const next = last.then(task)
      last = next.then(
        () => {},
        () => {},
      )
      return next
    },
    // Once what's in it now has run.
    idle: () => last,
  }
}

// Host: shares and their revocations are written in turn, never
// interleaved, so a Stop can't take away a newer share of its port.
const sharesLane = lane()

// Host: one port's share written, in turn (`sharesLane`) and only while its
// room's scope is open: `change` says what it is now, or undefined to leave
// it as it stands. What was written comes back.
async function writeShare($: $, s: RoomScope, port: number, change: (share: HostShare | undefined) => HostShare | undefined): Promise<HostShare | undefined> {
  let written: HostShare | undefined
  await sharesLane.run(async () => {
    if (!s.live) return
    await update($, sharesA, shares => {
      written = s.live ? change(shares[String(port)]) : undefined
      return written ? { ...shares, [String(port)]: written } : shares
    })
  })
  return written
}

// A port's share over what stood for it. A forward (`said.tcp`) says it all
// anew: what the port is forwarded as. A page shown through its link says
// only what its server speaks, where the port's forward didn't say it. One
// taken away since this looked (a Stop) stays away, unless this made it
// anew (`made`: the room was asked for it).
function shareOver(old: HostShare | undefined, pid: string, said: Omit<HostShare, 'pid'>, made: boolean): HostShare | undefined {
  const base: HostShare | undefined = old?.pid === pid ? old : made ? { pid } : undefined
  if (!base) return undefined
  if (said.tcp) return { pid, tcp: true, ...(said.host ? { host: said.host } : {}), ...(said.scheme ? { scheme: said.scheme } : {}), ...(said.dependency !== undefined ? { dependency: said.dependency } : {}) }
  if (base.tcp && base.scheme) return base
  const next: HostShare = { ...base }
  delete next.scheme
  return said.scheme ? { ...next, scheme: said.scheme } : next
}

// Host: a preview of one localhost port, made once per port, and what it's
// shared as written with it (`HostShare`). `said.tcp`: the host chose to let
// guests forward it to their own localhost over raw TCP (`hostForwards`). A
// port shared because Claude mentioned or opened it never is
// (`sharePublic`): it opens through its link, so a guest can't reach
// whatever happens to listen there (a database).
async function ensurePreview($: $, room: ShareRoom, port: number, title: string, said: Omit<HostShare, 'pid'>): Promise<HostShare | null> {
  const s = scope
  if (await runnerOwn($, port)) return null
  // A Stop told again meanwhile leaves this port alone (`endUnheard`).
  const done = markPort(s.sharingPorts, port)
  try {
    // A Stop being taken in finishes first: its old preview is never shared again.
    await sharesLane.idle()
    // The room still being told of a Stop of this port: once it has heard,
    // it answers with a preview of this share's own, never one it then ends
    // (a few seconds at most, in naps the hook's budget doesn't pay for).
    for (let waited = 0; s.endingPorts.has(port) && waited < 5_000; waited += 100) await nap($, 100)
    // Still being told: the room would answer with the preview that Stop
    // then ends, whenever it arrives, so nothing is shared yet.
    if (s.endingPorts.has(port)) {
      if (sameRoom(room, s)) $.ui.log(`Couldn't share localhost:${port} yet: the room is still being told it stopped. Try again in a moment.`)
      return null
    }
    const known = (await read($, sharesA))[String(port)]
    let pid = known && (!said.tcp || known.tcp) ? known.pid : ''
    const made = !pid
    if (made) pid = (await api<{ pid: string }>($, room.server, `/api/rooms/${room.id}/previews`, { method: 'POST', token: room.token, body: { port, title, ...(said.tcp ? { tcp: true } : {}) } })).pid
    if (!sameRoom(room, s)) return null
    const share = await writeShare($, s, port, old => shareOver(old, pid, said, made))
    return share && sameRoom(room, s) ? share : null
  } catch (error) {
    if (sameRoom(room, s)) $.ui.log(`Couldn't share localhost:${port}: ${String((error as Error)?.message ?? error)}`)
    return null
  } finally {
    done()
  }
}

// Host: work under way on a port (a share being made, a Stop being told),
// counted, so one of two at once finishing leaves the other's mark.
function markPort(marks: Map<number, number>, port: number): () => void {
  marks.set(port, (marks.get(port) ?? 0) + 1)
  return () => {
    const left = (marks.get(port) ?? 1) - 1
    if (left > 0) marks.set(port, left)
    else marks.delete(port)
  }
}

// What an artifact says of a preview's share beside the page it shows:
// forwarded, that it is and as what (its address as the host spelled it,
// over the page's own; the page it's for); its server's scheme either way.
// A page Claude opens later on a forwarded port goes out saying the same,
// so a dependency stays one (a guest's Open preview opens the page, not
// the API it uses), at the address it was forwarded at.
function sharedAs(share: HostShare, host?: PreviewHost): Pick<ShareShown, 'tcp' | 'host' | 'scheme' | 'dependency'> {
  const spelled = (share.tcp && share.host) || host
  return {
    ...(spelled ? { host: spelled } : {}),
    ...(share.scheme ? { scheme: share.scheme } : {}),
    ...(share.tcp ? { tcp: true } : {}),
    ...(share.tcp && share.dependency !== undefined ? { dependency: share.dependency } : {}),
  }
}

// A share as saved, checked.
function shareOf(value: unknown): HostShare | null {
  const s = value as Partial<HostShare> | null
  if (!s || typeof s !== 'object' || typeof s.pid !== 'string' || !PREVIEW_ID.test(s.pid)) return null
  const host = previewHost(s.host), dependency = dependencyOf(s.dependency)
  return { pid: s.pid, ...(s.tcp === true ? { tcp: true } : {}), ...(host ? { host } : {}), ...(s.scheme === 'https' ? { scheme: 'https' } : {}), ...(dependency !== undefined ? { dependency } : {}) }
}

// A place's shares, each checked.
function sharesSaved(saved: Hosting): Record<string, HostShare> {
  const kept: unknown = saved.shares
  if (!kept || typeof kept !== 'object' || Array.isArray(kept)) return {}
  const shares: Record<string, HostShare> = {}
  for (const [port, value] of Object.entries(kept)) {
    const share = validPort(Number(port)) ? shareOf(value) : null
    if (share) shares[String(Number(port))] = share
  }
  return shares
}

// Host: Allow forwarding in the Room, for a preview Claude's mention shared.
async function allowForwarding($: $, item: ShareShown) {
  const room = await read($, roomA)
  if (!room || !hostHere(room) || !validPort(item.port)) return
  const port = item.port
  // Forwarding again keeps what it was shared as (a page, or a page's dependency).
  const forwarded = await hostForwards($, room, { port, title: shownTitle(item), path: item.path ?? '/', host: item.host, scheme: item.scheme, dependency: item.dependency }, { offerRelated: 8_000 })
  if (hostHere(room)) $.ui.toast(forwarded && 'pid' in forwarded ? forwardedSaid([port]) : (forwarded?.refused ?? `Couldn't allow forwarding localhost:${port}`))
}

async function stopPreview($: $, pid: string) {
  const s = scope, room = await read($, roomA)
  if (!room || !sameRoom(room, s)) return
  // Stopped on purpose: a guest's window asking for it right after asks
  // nothing, and Claude mentioning it again (after a reload, or a reopened
  // session looking back) doesn't share it again.
  const port = Number(Object.entries(await read($, sharesA)).find(([, share]) => share.pid === pid)?.[0] ?? (await read($, shownA)).find(x => x.pid === pid)?.port)
  if (validPort(port)) await stopPorts($, room, [port])
  // Nothing reaches it through this session from now on, whatever the server hears.
  await unshare($, room, pid)
  if (!sameRoom(room, s) || (await endPreview($, room, s, pid, port))) return
  if (sameRoom(room, s)) $.ui.toast(`Stopped sharing ${validPort(port) ? `localhost:${port}` : 'that preview'}. The server couldn't be told yet, so guests may still see it listed, but nothing reaches it. The server is told again when this session reconnects, or when you press Stop again.`)
}

// Host: the room told a preview stopped here has ended. It ends in Shown
// once the room has heard it (or never had it): until then it stays open
// there with its Stop, which, with nothing here sharing it, is a Stop the
// room didn't hear (`endUnheard`), so guests don't see a preview listed that
// nothing reaches for long.
async function endPreview($: $, room: ShareRoom, s: RoomScope, pid: string, port?: number): Promise<boolean> {
  // A share of its port meanwhile waits for the room to hear it (`ensurePreview`).
  const done = validPort(port) ? markPort(s.endingPorts, port) : () => {}
  try {
    try {
      await api($, room.server, `/api/rooms/${room.id}/previews/${pid}/end`, { method: 'POST', token: room.token })
    } catch (error) {
      // The room has no such preview (404) or is gone (410): nothing to tell.
      if (!(error instanceof ApiError && (error.status === 404 || error.status === 410))) return false
    }
    await update($, shownA, list => (!s.live ? list : list.map(x => (x.pid === pid ? { ...x, closed: true } : x))))
    return true
  } finally {
    done()
  }
}

// Host, connected: the Stops the room didn't hear (a preview open in Shown
// that nothing here shares now), told again, once a minute at most. One
// shared again since (the room gave its port the same preview back) is
// shared, so it stands. Shown and what's shared are kept through a reload
// and with the place, so those are told again after one too.
async function endUnheard($: $, room: ShareRoom, s: RoomScope) {
  const now = await $.clock.now()
  if (!sameRoom(room, s) || now - s.toldEnds < 60_000) return
  s.toldEnds = now
  for (const x of await read($, shownA)) {
    if (!sameRoom(room, s)) return
    if (x.kind !== 'preview' || !x.pid || x.closed) continue
    // What's shared as it is now, not as this began: one told before may
    // have waited long, and the host may have shared its port again
    // meanwhile, which the room answers with the same preview. The look is
    // a write (`update`): a read would see this dispatch's first moment.
    await sharesLane.idle()
    const shares = await update($, sharesA, v => v)
    if (Object.values(shares).some(share => share.pid === x.pid) || s.revoking.has(x.pid) || (validPort(x.port) && s.sharingPorts.has(x.port))) continue
    await endPreview($, room, s, x.pid, x.port)
  }
}

// Host: a localhost address Claude gave out (a dev server it started, say),
// or one it opened before Share, is shared like one it opens in the browser
// pane while sharing: when what Claude shows goes to everyone, and only once
// a page answers there (`lookAtPage`). On its own turn for guests, not the
// one that mentioned it (that may have ended). `opened`: Claude opened it in
// the browser pane, so it's shared whatever page it is.
const mentionedPorts = new Set<number>()
type LocalPage = { port: number; path: string; host?: PreviewHost; scheme?: 'https'; opened?: true }
// A localhost address (`LOCAL_URL`'s match) as a page to share: its port, its
// page, its spelling of loopback and its scheme.
const localPageOf = (m: RegExpMatchArray): LocalPage => ({ port: Number(m[1]), path: m[2] ?? '/', host: urlHost(m[0]), scheme: urlScheme(m[0]) })
const localPages = (text: string) => [...text.matchAll(new RegExp(LOCAL_URL.source, 'gi'))].map(localPageOf)

// Host: a page shared through its link: Claude gave out its address, or
// opened it in the browser pane. Never forwarded by this: its preview is
// made without `tcp` (`ensurePreview`). One the host forwards already goes
// out saying so, as what it was forwarded as (`sharedAs`). One another
// session's preview holds here (`relayedHere`) isn't shared. Whether guests
// may open it at the same address is its callers' to ask after
// (`offerSameAddress`), once their own question lets go of the port.
async function sharePublic($: $, room: ShareRoom, page: LocalPage, opts: { title?: string; turnId?: string } = {}): Promise<HostShare | null> {
  const title = opts.title || `localhost:${page.port}`
  // Another session's preview forwarded here: never shared on, and nothing said (Claude's mention, not the host's ask).
  if (await relayedHere($, page.port)) {
    $.ui.log(`Not sharing localhost:${page.port}: another shared session's preview forwarded here`, { to: 'debug' })
    return null
  }
  const share = await ensurePreview($, room, page.port, title, page.scheme ? { scheme: page.scheme } : {})
  if (!share) return null
  send($, 'artifact', { kind: 'preview', turnId: opts.turnId, pid: share.pid, port: page.port, title, path: page.path, ...sharedAs(share, page.host) })
  return share
}

// The pages a browser_batch call opened, in order.
function batchOpens(input: Record<string, unknown>): string[] {
  const actions = Array.isArray(input.actions) ? (input.actions as { name?: unknown; input?: { url?: unknown } }[]) : []
  return actions.filter(a => (a?.name === 'navigate' || a?.name === 'preview_start') && typeof a.input?.url === 'string').map(a => a.input?.url as string)
}

// The localhost pages a session's Claude opened in the browser pane or gave
// the address of, each port at the page it was at last.
function localOpens(messages: unknown[]): LocalPage[] {
  const last = new Map<number, LocalPage>()
  for (const message of messages) {
    const m = message as { role?: unknown; content?: unknown }
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const block of m.content as { type?: unknown; text?: unknown; name?: unknown; input?: Record<string, unknown> }[]) {
      const opened = block?.type === 'tool_use'
      const urls =
        block?.type === 'text' && typeof block.text === 'string'
          ? [block.text]
          : block?.type === 'tool_use' && block.input
            ? block.name === 'mcp__Claude_Browser__browser_batch'
              ? batchOpens(block.input)
              : /^mcp__Claude_Browser__(preview_start|navigate)$/.test(String(block.name)) && typeof block.input.url === 'string'
                ? [block.input.url]
                : []
            : []
      for (const url of urls) {
        for (const page of localPages(url)) {
          // Most recently used last; a page Claude opened stays the port's
          // page when only mentioned after (an API path in its reply).
          const was = last.get(page.port)
          last.delete(page.port)
          last.set(page.port, opened ? { ...page, opened: true } : was?.opened ? was : page)
        }
      }
    }
  }
  return [...last.values()]
}

async function shareLocal($: $, pages: LocalPage[]) {
  if ((await read($, modeA)) !== 'host' || (await read($, policyA)).files === 'off') return
  const room = await read($, roomA)
  if (!room) return
  for (const page of pages.slice(-5)) {
    const { port } = page
    if (!port || mentionedPorts.has(port) || (await read($, sharesA))[String(port)]) continue
    // Stopped by the host: a mention (or the history a reopened session
    // looks back on) never shares it again; the host's own share does.
    if ((await hostMemoryOf($, room)).stopped.includes(port)) continue
    // Another session's preview forwarded here: not shared, not even probed
    // (through it, that session's app would answer), and a later mention
    // looks again.
    if (await relayedHere($, port)) {
      $.ui.log(`Not sharing localhost:${port}: another shared session's preview forwarded here`, { to: 'debug' })
      continue
    }
    mentionedPorts.add(port)
    const look = await lookAtPage($, page)
    if (look === 'later') {
      mentionedPorts.delete(port) // nothing there yet, or failing: a later mention tries again
      continue
    }
    if (look === 'not') continue
    // Shared through its link once the host says so; with guests here, the
    // host is asked after whether they may open it at this address.
    void offerShow($, room, page).catch(() => {})
  }
}

// Claude gave out or opened a localhost page nobody shared: it goes to the
// room through its link only when the host says so. A guest's prompt can
// have Claude name or open any port of the host's, and what answers there
// (an admin page, a service behind a login redirect) is the host's to give.
// Not now: never again in this room, until the host shares it on purpose;
// unanswered, the row full, or nowhere drawn (a -p run), not shared, and a
// mention ten minutes on asks again. A cloud host, which draws nothing,
// asks its approver (`pumpHostAsks`).
async function offerShow($: $, room: ShareRoom, page: LocalPage, opts: { title?: string; turnId?: string } = {}) {
  const { port } = page
  const flight = `${roomIdentity(room)} ${port}`
  if (hostAsking.has(flight) || (await read($, sharesA))[String(port)] || !(await canAskHost($)) || hostAsking.has(flight)) return
  hostAsking.add(flight)
  let answer: HostAnswer = 'later'
  let shared: HostShare | null = null
  try {
    if (!(await claimAsks($, room, [port])).length) return
    answer = await offer($, room, { kind: 'show', port, related: [] }, [port], async () => {
      // Its own yes: the same-address question after it is a question of its own.
      await rememberHost($, room, m => ({ ...m, askedAt: Object.fromEntries(Object.entries(m.askedAt).filter(([p]) => Number(p) !== port)) }))
      shared = await sharePublic($, room, page, opts)
      if (shared) $.ui.toast(`Sharing localhost:${port} with the room (stop it in the Room)`)
      return { shared: [], refused: [] }
    })
  } finally {
    hostAsking.delete(flight)
    if (answer === 'later') mentionedPorts.delete(port)
  }
  // With guests here, whether they may open it at this address: asked once this question let go of the port.
  // (Set in the yes above, which control flow doesn't follow.)
  const share = shared as HostShare | null
  if (share) void offerSameAddress($, room, port, page.path, page.host, share.scheme).catch(() => {})
}

// One look at a port's `/`, asked as a browser asks for a page: its status
// and content type, and, once something answered, whether it's a debugger
// (`/json/version`; through its link, a page could drive it). `pageLook`
// says what that means. The page Claude gave out (a guest's prompt may have
// chosen it) is asked only when `/` is an HTML 404 (`rootMissing`: an app
// mounted at a base path), never followed past a redirect; its link would
// let guests ask it anyway. An https one answers over TLS, its own
// certificate this machine's (a dev server's, for localhost): not checked
// for this look.
async function lookAtPage($: $, page: LocalPage): Promise<PageLook> {
  const k = page.scheme ? 'k' : ''
  const at = `${page.scheme ?? 'http'}://localhost:${page.port}`
  // LOCAL_URL's page holds no quote or backslash, so it goes quoted, and `-g` keeps it one address.
  const look = async (path: string) =>
    (
      await sh(
        $,
        `r=$(curl -gs${k} -o /dev/null -H 'Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' -w '%{http_code} %{content_type}' --connect-timeout 2 -m 3 '${at}${path}'); e=$?\n` +
          `printf 'exit=%s\\ncode=%s\\n' "$e" "$r"\n` +
          `case "$r" in 000*|'') ;; *) echo --; curl -s${k} --connect-timeout 2 -m 2 --max-filesize 65536 ${at}/json/version | head -c 65536 ;; esac\n`,
      )
    ).out
  const root = await look('/')
  const said = pageLook(root, page.opened)
  if (said !== 'not' || page.opened || page.path === '/' || !page.path.startsWith('/') || !rootMissing(root)) return said
  return pageLook(await look(page.path))
}

// Host: a page Claude opened in the browser pane while sharing. One shared
// already goes out again (guests follow it to its new page); a new one is
// looked at first, as a mention is, but shared whatever page it is: not
// one the host stopped, another session's preview forwarded here, a
// debugger, or something that isn't a web server.
async function shareOpened($: $, room: ShareRoom, page: LocalPage, opts: { title?: string; turnId?: string }) {
  if (!(await read($, sharesA))[String(page.port)]) {
    if ((await hostMemoryOf($, room)).stopped.includes(page.port)) return
    if (await relayedHere($, page.port)) return void $.ui.log(`Not sharing localhost:${page.port}: another shared session's preview forwarded here`, { to: 'debug' })
    if ((await lookAtPage($, { ...page, opened: true })) === 'not') return
    // A new one goes once the host says so (never waited on here, in a tool's hook).
    return void offerShow($, room, page, opts).catch(() => {})
  }
  const share = await sharePublic($, room, page, opts)
  if (share) void offerSameAddress($, room, page.port, page.path, page.host, share.scheme).catch(() => {})
}

// Host: a tool call that showed something, sent to the room for guests.
async function captureShown($: $, e: Record<string, unknown>, result: unknown) {
  if ((await read($, modeA)) !== 'host' || (await read($, policyA)).files === 'off') return
  if (result && typeof result === 'object' && 'deny' in result && (result as { deny?: unknown }).deny) return
  const room = await read($, roomA)
  if (!room) return
  const tool = String(e.tool ?? '')
  const input = (e.input && typeof e.input === 'object' ? e.input : e) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const cwd = await $.session.cwd()
  const abs = (p: string) => (p.startsWith('/') ? p : `${cwd}/${p}`)
  const turnId = (await read($, workingA))?.turnId
  const uploads = async (paths: string[]) => (await Promise.all(paths.map(p => uploadFile($, room, abs(p))))).filter((m): m is ShareFileMeta => Boolean(m))

  if (tool === 'SendUserFile') {
    const files = await uploads((Array.isArray(input.files) ? input.files : []).filter((f): f is string => typeof f === 'string').slice(0, 10))
    if (files.length) send($, 'artifact', { kind: 'send', turnId, files, display: input.display === 'attach' ? 'attach' : 'render', caption: str(input.caption).slice(0, 300) })
  } else if (tool.endsWith('__show_widget')) {
    const code = str(input.widget_code)
    if (!code) return
    const title = str(input.title).slice(0, 80)
    const loading = Array.isArray(input.loading_messages) ? input.loading_messages.filter(m => typeof m === 'string').slice(0, 4) : []
    if (code.length <= 30_000) send($, 'artifact', { kind: 'widget', turnId, title, loading, code })
    else {
      const file = await uploadText($, room, code, `${title || 'widget'}.html`)
      if (file) send($, 'artifact', { kind: 'widget', turnId, title, loading, files: [file] })
    }
  } else if (tool === 'mcp__ccd_view__show_pane' && input.pane === 'file' && str(input.path)) {
    const files = await uploads([str(input.path)])
    if (files.length) send($, 'artifact', { kind: 'file', turnId, files, line: typeof input.line === 'number' ? input.line : undefined })
  } else if (tool === 'mcp__Claude_Browser__browser_batch') {
    // Steps in one call: the last localhost page it opened, as a navigate's.
    const local = batchOpens(input)
      .map(url => LOCAL_URL.exec(url))
      .filter(m => m !== null)
      .at(-1)
    if (local) await shareOpened($, room, localPageOf(local), { turnId })
  } else if (/^mcp__Claude_Browser__(preview_start|navigate)$/.test(tool)) {
    let url = str(input.url)
    if (!url) url = LOCAL_URL.exec(JSON.stringify(result ?? ''))?.[0] ?? ''
    if (url.startsWith('file://')) {
      const files = await uploads([decodeURIComponent(url.slice(7).split(/[?#]/)[0] ?? '')])
      if (files.length) send($, 'artifact', { kind: 'page', turnId, files })
      return
    }
    const local = LOCAL_URL.exec(url)
    if (local) await shareOpened($, room, localPageOf(local), { title: str(input.name), turnId })
    else if (/^https:\/\//.test(url)) {
      send($, 'artifact', { kind: 'link', turnId, url })
    }
  } else if (tool === 'Artifact' && str(input.file_path) && (!input.action || input.action === 'publish')) {
    const body = await pageEvent($, room, input, cwd)
    if (!body) return
    send($, 'artifact', { ...body, turnId })
    const id = artifactId(JSON.stringify(result ?? ''))
    if (id) await update($, pagesA, pages => ({ ...Object.fromEntries(Object.entries(pages).slice(-30)), [id]: body }))
  } else if (tool === 'Artifact' && input.action === 'open' && str(input.url)) {
    // A page published before, opened again: everyone sees it again, its
    // files beside it (one published before this plugin kept them is found
    // in the transcript).
    const id = artifactId(str(input.url))
    const body = id ? ((await read($, pagesA))[id] ?? (await earlierPage($, room, id, cwd))) : null
    if (body) send($, 'artifact', { ...body, turnId })
  }
}

// Host: a published page as the room gets it: the page, and its pictures,
// scripts and styles, each at its published path beside it, so it opens on
// a guest's side whole, as it does here.
async function pageEvent($: $, room: ShareRoom, input: Record<string, unknown>, cwd: string): Promise<Record<string, unknown> | null> {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const abs = (p: string) => (p.startsWith('/') ? p : `${cwd}/${p}`)
  const page = await uploadFile($, room, abs(str(input.file_path)))
  if (!page) return null
  const root = str(input.root) ? abs(str(input.root)) : cwd
  const listed = Array.isArray(input.files)
    ? (input.files as unknown[]).map(f => (f && typeof f === 'object' ? str((f as { path?: unknown }).path) : '')).map(p => [p, p] as const)
    : Object.entries((input.files ?? {}) as Record<string, unknown>).map(([to, from]) => [to, typeof from === 'string' ? from : from && typeof from === 'object' ? str((from as { from?: unknown }).from) : ''] as const)
  const beside: ShareFileMeta[] = []
  for (const [to, from] of listed.slice(0, PAGE_FILES)) {
    const path = pagePath(to)
    if (!path || !from) continue
    const meta = await uploadFile($, room, from.startsWith('/') ? from : `${root}/${from}`)
    if (meta) beside.push({ ...meta, path })
  }
  return beside.length
    ? { kind: 'page', files: [{ ...page, path: baseName(str(input.file_path)) }, ...beside] }
    : { kind: 'send', files: [page], display: 'render', caption: 'A page Claude published' }
}

// An Artifact's id, from its link (claude.ai/artifact/<id>, claude.ai/code/artifact/<id>).
function artifactId(text: string): string | null {
  return /claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9_-]{6,})/.exec(text)?.[1] ?? null
}

// Host: the newest publish of an Artifact this session's transcript holds,
// as the room gets it.
async function earlierPage($: $, room: ShareRoom, id: string, cwd: string): Promise<Record<string, unknown> | null> {
  const calls = new Map<string, Record<string, unknown>>()
  let found: Record<string, unknown> | null = null
  for (const message of await sessionHistory($)) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content as { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown }[]) {
      if (block.type === 'tool_use' && block.name === 'Artifact' && block.id && typeof block.input?.file_path === 'string') calls.set(block.id, block.input)
      if (block.type === 'tool_result' && block.tool_use_id && calls.has(block.tool_use_id) && JSON.stringify(block.content ?? '').includes(id)) found = calls.get(block.tool_use_id)!
    }
  }
  const body = found ? await pageEvent($, room, found, cwd) : null
  if (body) await update($, pagesA, pages => ({ ...pages, [id]: body }))
  return body
}

const PAGE_FILES = 60
// A page's file's place beside it, relative and inside: no `..`, no root.
function pagePath(raw: string): string {
  const parts = raw.split(/[\\/]+/).filter(p => p && p !== '.' && p !== '..').map(p => p.replace(/[^\w.\- ()]+/g, '-').replace(/^\.+/, '') || 'file')
  return parts.join('/')
}

type Replay = { label: string; call?: { name: string; input: Record<string, unknown> }; note?: string }

// Guest: how to show an artifact here, as one step of a riding turn: the call
// to make (after saving its files), or a note where this Claude Code has no
// viewer for it (a terminal).
async function replayOf($: $, room: ShareRoom, event: ServerEvent): Promise<Replay | null> {
  const body = event.body
  const shown = shownOf(event)
  if (!shown) return null
  const host = room.host
  const paths = await downloadShown($, room, shown.files ?? [])
  const cwd = await $.session.cwd()
  const rel = (p: string) => (p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p)
  const savedNote = paths.length ? `saved to ${(shown.files ?? []).some(f => f.path) ? `\`${rel(paths[0]!)}\`, with its files` : paths.map(p => `\`${rel(p)}\``).join(', ')}` : ''
  const label = `◧ **${host}'s Claude showed** ${shown.name}`
  switch (shown.kind) {
    case 'send':
      if (!paths.length) return { label, note: "the file didn't come through" }
      if (!(await hasTool($, 'SendUserFile'))) return { label, note: savedNote }
      return {
        label,
        call: {
          name: 'SendUserFile',
          input: { files: paths, display: body.display === 'attach' ? 'attach' : 'render', status: 'normal', caption: `From ${host}'s session${typeof body.caption === 'string' && body.caption ? `: ${body.caption}` : ''}` },
        },
      }
    case 'widget': {
      let code = typeof body.code === 'string' ? body.code : ''
      if (!code && paths[0]) code = (await sh($, `cat ${sq(paths[0])}\n`)).out
      const tool = code ? await widgetTool($) : null
      if (!tool) return { label, note: code ? 'this Claude Code has no widget viewer' : "the widget didn't come through" }
      const loading = Array.isArray(body.loading) && body.loading.length ? body.loading : [`Drawing what ${host} saw`]
      return { label, call: { name: tool, input: { title: typeof body.title === 'string' && body.title ? body.title : 'shared_widget', loading_messages: loading, widget_code: code } } }
    }
    case 'file':
      if (!paths[0]) return { label, note: "the file didn't come through" }
      if (!(await hasTool($, 'mcp__ccd_view__show_pane'))) return { label, note: savedNote }
      return { label, call: { name: 'mcp__ccd_view__show_pane', input: { pane: 'file', path: paths[0], ...(typeof body.line === 'number' ? { line: body.line } : {}) } } }
    case 'page':
      if (!paths[0]) return { label, note: "the page didn't come through" }
      if (!(await hasTool($, 'mcp__Claude_Browser__preview_start'))) return { label, note: savedNote }
      return { label, call: { name: 'mcp__Claude_Browser__preview_start', input: { url: `file://${paths[0]}` } } }
    case 'preview': {
      if (!shown.pid) return null
      // Shared for another page's sake: that page reaches it when it opens.
      if (shown.dependency !== undefined && validPort(shown.port)) {
        const title = typeof body.title === 'string' && body.title ? body.title : dependencyTitle(shown.port)
        return { label: `◧ **${host} shares** ${title} ${dependencyFor(shown.dependency)}; the page reaches it when you open it` }
      }
      // Forwarded only when the guest says so: Open preview above the
      // prompt, or Open in the Room, never a replay.
      if (shown.tcp) {
        if (validPort(shown.port)) return { label, note: `press **Open preview** above the prompt (or **Open** in the Room) to open it at ${previewUrl(shown.host, shown.port, shown.path, shown.scheme)}` }
        return { label, note: 'press **Open** in the Room to open it' }
      }
      const url = await previewTicket($, room, shown.pid, shown.path)
      if (!url) return { label, note: 'the preview could not be opened' }
      if (!(await hasTool($, 'mcp__Claude_Browser__preview_start'))) return { label, note: `open it in a browser within 10 minutes (the link opens in one browser): ${url}` }
      return { label, call: { name: 'mcp__Claude_Browser__preview_start', input: { url } } }
    }
    case 'link':
      if (!shown.url || !(await hasTool($, 'mcp__Claude_Browser__preview_start'))) return { label, note: shown.url ?? '' }
      return { label, call: { name: 'mcp__Claude_Browser__preview_start', input: { url: shown.url } } }
  }
}

// Guest: what to do when this Claude Code wouldn't open what was shown (auto
// mode refuses a plugin's step to the browser pane): the localhost link for
// a preview, where the file is for anything else, and the Room's Open.
async function refusedNote($: $, room: ShareRoom, event: ServerEvent, reason: string): Promise<string> {
  const shown = shownOf(event)
  const why = /auto mode/i.test(reason) ? 'auto mode only opens what you asked for' : 'it was not allowed'
  if (shown?.kind === 'preview' && shown.pid && !shown.tcp) {
    const url = await previewTicket($, room, shown.pid, shown.path)
    if (url) return `\n\n> This session didn't open it in the browser pane (${why}). [Open the preview](${url}) in your browser within 10 minutes (the link opens in one browser), or press **Open** in the Room panel.\n\n`
  }
  return `\n\n> This session didn't open it (${why}). Press **Open** in the Room panel${shown?.files?.length ? `, or find it in \`.shared-session/\`` : ''}.\n\n`
}

// A link (ten minutes, one browser) that opens a preview on the preview host name.
async function previewTicket($: $, room: ShareRoom, pid: string, path?: string): Promise<string | null> {
  try {
    return (await api<{ url: string }>($, room.server, `/api/rooms/${room.id}/previews/${pid}/ticket`, { method: 'POST', token: room.token, body: { path: path ?? '/' } })).url
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Helpers: the plugin's own Node processes (relay/*.cjs). A guest's
// listeners and the window's tunnels (local-preview.cjs), the window's proxy
// (browser-proxy.cjs), discovery (discover.cjs), the host's TCP worker
// (tcp-worker.cjs) and its public sockets' relays (ws-relay.cjs) each run
// under the Node a dev server would (`FIND_NODE`; exit 127: none here), take
// their settings on stdin, never argv, and say what happens in JSON lines on
// stdout (`helperLines`). One with a listener of its own on 127.0.0.1 takes
// commands in short POSTs (`controlPost`). Their stderr isn't read: no child
// diagnostics or credentials go into the transcript or logs (a public
// socket's relay's goes to the debug log alone).

type Child = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

const FIND_NODE = [
  'for n in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" $(ls -d "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node "$HOME"/.asdf/installs/nodejs/*/bin/node 2>/dev/null | sort -r); do',
  '  [ -n "$n" ] && [ -x "$n" ] && exec "$n" "$1"',
  'done',
  'echo "Shared session: no node to run a helper" >&2; exit 127',
].join('\n')

// A helper's stdout, a line at a time as it comes. A line holds 8192
// characters at most, and so does what waits for its end: past either, the
// helper is saying what no helper says, and the reading throws, so its
// caller ends the helper. (The room's stream and a transcript, whose lines
// run to megabytes, are read as they are, not by this.)
const HELPER_LINE_MAX = 8192
async function* helperLines(child: Child): AsyncGenerator<string, void, undefined> {
  let buffer = ''
  for await (const chunk of child) {
    if (chunk.stream !== 'stdout') continue
    buffer += chunk.text
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      if (i > HELPER_LINE_MAX) throw new Error('A helper said a line past its bound')
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      yield line
    }
    if (buffer.length > HELPER_LINE_MAX) throw new Error('A helper said a line past its bound')
  }
}

// How a helper ended: NODE when there was no Node here to run it. Asked as
// it starts (a child that can't start rejects at once, never unhandled).
async function helperEnded(child: Child): Promise<'NODE' | undefined> {
  return (await child.result.catch(() => null))?.code === 127 ? 'NODE' : undefined
}

// A helper's control listener on 127.0.0.1 (the window's proxy, the host's
// TCP worker): one short POST, its secret in a header, two seconds at most.
// Both answer alike (`controlServer`, relay/tcp-relay.cjs): 200; 400, 403
// or 413 for a request they won't take; 503 while full or closing; and the
// TCP worker's 429 (BUSY: its connections all taken, which it told the room
// itself). Which of those is an answer is the caller's (`answers`); anything
// else, no answer in time included, is a failure, and `failed` says what
// that does to the helper. 0: nothing came.
type ControlPolicy = { answers: readonly number[]; failed: () => void }
async function controlPost($: $, port: number, token: string, body: Record<string, unknown>, policy: ControlPolicy): Promise<number> {
  let timeout!: () => void
  const expired = new Promise<null>(done => { timeout = () => done(null) })
  const timer = $.clock.after(2_000, () => timeout())
  try {
    const response = await Promise.race([
      $.http.fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null),
      expired,
    ])
    const status = response?.status ?? 0
    if (!policy.answers.includes(status)) policy.failed()
    return status
  } finally {
    timer.cancel()
  }
}

// The helpers that last (the host's TCP worker and its mailboxes' helper,
// the window's proxy): one process each for the room, kept with its scope's
// children (`RoomChildren`). Each has a control secret of its own (256 bits,
// module memory only) and is ready once it says so in its time (`ready`:
// true). It's over (false) when it doesn't, says what it shouldn't, or
// ends: from then on its commands answer nothing (`helperPost`), and its
// own finish puts it away (`finishHelper`).
type Helper = {
  scope: RoomScope
  controlToken: string
  ready: Promise<boolean>
  settle: (ready: boolean) => void
  /** Its commands, one at a time (`helperPost`). */
  queue: Lane
  stopped: boolean
  stopping?: Promise<void>
  /** Its control listener's port on 127.0.0.1, once it's ready. */
  control?: number
  child?: Child
  /** Its time to say it's ready (`runHelper`). */
  timer?: Timer
  /** How it ended, when that's known: NODE, no Node here to run it; else its own word. */
  error?: string
}

function newHelper(scope: RoomScope): Helper {
  let settle!: (ready: boolean) => void
  const ready = new Promise<boolean>(done => { settle = done })
  return { scope, controlToken: randomSecret(), ready, settle, queue: lane(), stopped: false }
}

// Over, once: its commands answer nothing from now (`ready`: false), and
// `end` puts it away (its process, or however it lives), then `after`.
function finishHelper(h: Helper, end: () => Promise<unknown>, after?: () => void): Promise<void> {
  if (h.stopping) return h.stopping
  h.stopped = true
  h.timer?.cancel()
  h.settle(false)
  h.stopping = (async () => {
    try { await end() } catch {}
    after?.()
  })()
  return h.stopping
}

// Its process, under Node (`FIND_NODE`), its settings on stdin. What it says,
// a JSON line at a time, goes to `take` (which throws for a line it
// shouldn't say) until it ends or `still` says no more; not ready in
// `startMs`, it's over (`finish`). How it ended is kept (`error`).
async function runHelper($: $, h: Helper, file: string, settings: Record<string, unknown>, startMs: number, finish: () => unknown, still: () => boolean, take: (said: Record<string, unknown>) => unknown) {
  const child = $.process.spawn({ argv: ['/bin/sh', '-c', FIND_NODE, 'sh', `${$.plugin.root}/relay/${file}`], input: JSON.stringify(settings) })
  h.child = child
  h.timer = $.clock.after(startMs, () => void finish())
  const ended = helperEnded(child)
  for await (const line of helperLines(child)) {
    if (!still()) break
    let said: unknown
    try { said = JSON.parse(line) } catch { continue }
    if (said && typeof said === 'object' && !Array.isArray(said)) await take(said as Record<string, unknown>)
  }
  // Only a known end: a mailbox's open tells its failure by `error` being there.
  const end = await ended
  if (end) h.error ??= end
}

// It said it's ready: its control port, and its time to start no longer runs.
function helperReady(h: Helper, control: number) {
  h.control = control
  h.timer?.cancel()
}

// One command to a helper once it's ready, in turn: its answer, or 0 when
// it's over (or went over meanwhile), `still` says it isn't its room's any
// more, or `body` has nothing to send by then. Which answers are answers,
// and what a failure does, are the caller's (`ControlPolicy`).
async function helperPost($: $, h: Helper, still: () => boolean, body: () => Promise<Record<string, unknown> | null>, policy: ControlPolicy): Promise<number> {
  return h.queue.run(async () => {
    if (!(await h.ready) || h.stopped || !still()) return 0
    const command = await body()
    if (!command || h.stopped || h.control === undefined) return 0
    const status = await controlPost($, h.control, h.controlToken, command, policy)
    return !h.stopped && still() ? status : 0
  })
}

// Guest: local and remote ports are independent. Each caller says where a
// listener binds (`LocalBind`): an Open at the host's own number exactly, or
// not at all (`bindForOpen`; with no window here the page where it was last,
// else its own number, else any free port); a reload or resume exactly where
// it was, or not at all (an open tab would reach whatever took its port);
// the window's own tunnel on a port the system picks, never a listener to
// restore. Only the actual address opens, and nothing here is saved: an Open
// or a restore saves what it brought up once it's done (`commitMappings`).
// `keepWindow`: an Open that could go to the window, which a tunnel serving
// the window is left to (`windowServes`), never taken over.
type LocalPreviewAsk = { bind: LocalBind; keepWindow?: true } | { window: true }

// Still the request it was: its room's scope at the seat it was made with,
// and no Stop, Close, Leave or newer Open of the preview since.
function localRequestCurrent(room: ShareRoom, s: RoomScope, pid: string, epoch: number): boolean {
  return sameRoom(room, s) && s.epoch(pid) === epoch
}

// A run lasts across a reseat (only its start checks the seat,
// `startLocalPreview`; the room checks its token at each connection): its
// scope open, no Stop, Close or Leave of its preview since, and still the
// preview's run.
function runCurrent(pid: string, run: LocalPreviewRun): boolean {
  return run.scope.live && run.scope.epoch(pid) === run.epoch && run.scope.children.listeners.get(pid) === run && !run.stopping
}

// …and still wanted (a window's tunnel, while the window is and the host allows it).
async function localRunCurrent($: $, pid: string, run: LocalPreviewRun): Promise<boolean> {
  return runCurrent(pid, run) && (await localInterest($, pid, run)) && runCurrent(pid, run)
}

// A listener's address as the page knows it: the host's spelling of
// localhost ([::1] only where IPv6 really bound), at the port it has here.
function listenerUrl(shown: ShareShown, run: LocalPreviewRun): string {
  return previewUrl(shown.host === '[::1]' && run.ipv6 !== true ? 'localhost' : shown.host, run.localPort!, shown.path, shown.scheme)
}

// `made`: the run this call started, up or not (what an Open that fails
// stops again); `run`, the one it got, up and current; `inWindow`: the
// preview's tunnel serves the window, left to it (`keepWindow`).
type LocalPreviewReady = { url?: string; error?: string; run?: LocalPreviewRun; made?: LocalPreviewRun; refused?: Refusal; inWindow?: true }

// The window's own tunnel for a preview serves the window now: up, and the
// room's window proxy with it (a page in the window uses it, or is it).
function windowServes(s: RoomScope, pid: string): boolean {
  const run = s.children.listeners.get(pid), proxy = s.children.windowProxy
  return Boolean(run?.owner === 'window' && run.started && !run.failed && !run.stopping && proxy && !proxy.stopped)
}

// The preview's run, refused (AUTH) on a channel: the seat's token it
// carries isn't the room's now, so the person's own Open, theirs to retry
// with, starts it anew.
function refusedRun(s: RoomScope, pid: string): boolean {
  const run = s.children.listeners.get(pid)
  return Boolean(run && run.channelError === SAY[run.owner].refused)
}

async function ensureLocalPreview($: $, room: ShareRoom, s: RoomScope, shown: ShareShown, ask: LocalPreviewAsk): Promise<LocalPreviewReady> {
  const port = shown.port, path = shown.path ?? '/', pid = shown.pid
  const epoch = pid ? s.epoch(pid) : 0
  if (!sameRoom(room, s) || s.mode !== 'guest') return { error: 'This shared session is no longer open.' }
  if (!pid || !PREVIEW_ID.test(pid) || shown.closed || !validPort(port) || !path.startsWith('/') || /[\x00-\x20\\]/.test(path)) return { error: 'That preview has ended or has no valid localhost address.' }
  const owner: RunOwner = 'window' in ask ? 'window' : 'listener', runs = s.children.listeners
  const bind: LocalBind = 'window' in ask ? { port: 0, strict: false } : ask.bind
  // Still one run per pid: the window uses any current one; a listener asked
  // for replaces the window's own (routes follow it), and one that isn't (or
  // won't be) where this asks it to bind exactly. Not, for an Open that
  // could go to the window, a tunnel that serves the window.
  const fits = (run: LocalPreviewRun) =>
    !run.stopping && !run.failed && run.port === port && (owner === 'window' || (run.owner === 'listener' && (!bind.strict || (run.started ? run.localPort === bind.port : run.bind.strict && run.bind.port === bind.port))))
  for (let run = runs.get(pid); run && !fits(run); run = runs.get(pid)) {
    if ('keepWindow' in ask && ask.keepWindow && windowServes(s, pid)) return { error: "It's open in the preview window.", inWindow: true }
    await stopLocalPreview($, pid, false, s)
    if (!localRequestCurrent(room, s, pid, epoch)) return { error: 'The local mapping was cancelled.' }
  }
  if (owner === 'window' && (!(await windowInterest($, pid, s)) || !localRequestCurrent(room, s, pid, epoch))) return { error: 'The preview window closed, or the host no longer shares this preview.' }
  let run = runs.get(pid), made: LocalPreviewRun | undefined
  // Another start meanwhile, for somewhere else: not this one's to take over.
  if (run && !fits(run)) return { error: 'The local mapping was cancelled.' }
  if (!run) {
    let settle!: (ready: boolean) => void
    const ready = new Promise<boolean>(done => { settle = done })
    run = made = { scope: s, port, bind, epoch, ready, settle, started: false, failed: false, error: SAY[owner].unreachable(room.host, port), owner }
    runs.set(pid, run)
    void startLocalPreview($, room, pid, run)
  }
  const ready = await run.ready
  if (!ready || !run.localPort || run.failed || !(await localRunCurrent($, pid, run)) || !localRequestCurrent(room, s, pid, epoch)) return { error: run.error, ...(made ? { made } : {}), ...(run.refused ? { refused: run.refused } : {}) }
  return { url: listenerUrl(shown, run), run, ...(made ? { made } : {}) }
}

function validPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
}

async function startLocalPreview($: $, room: ShareRoom, pid: string, run: LocalPreviewRun) {
  let child: Child | undefined
  const runs = run.scope.children.listeners
  try {
    // Its connections carry the seat's token as it starts, which the room
    // checks at each. A reseat meanwhile ends the start; once up, a run lasts
    // across one, until the room refuses the old token (AUTH).
    if (!(await localRunCurrent($, pid, run)) || !sameRoom(room, run.scope)) return
    const url = `${room.server}/api/rooms/${room.id}/previews/${pid}/tunnel`
    // Where its caller asked (the window's tunnel: a port the system picks).
    child = $.process.spawn({ argv: ['/bin/sh', '-c', FIND_NODE, 'sh', `${$.plugin.root}/relay/local-preview.cjs`], input: JSON.stringify({ port: run.bind.port, strict: run.bind.strict, url, token: room.token }) })
    run.child = child
    // An unresponsive child doesn't hold an Open, a restore or the window's
    // page for long: eight seconds to say it's listening, then it's stopped.
    run.timer = $.clock.after(8_000, () => {
      if (runs.get(pid) === run && !run.started) {
        run.error = `Local preview on localhost:${run.port} took too long to start. Press Open in the Room to retry.`
        void stopLocalPreview($, pid, false, run.scope)
      }
    })
    const ended = helperEnded(child)
    for await (const line of helperLines(child)) {
      if (runs.get(pid) !== run || run.stopping || !run.scope.live) break
      let message: { state?: string; code?: string; port?: number; ipv6?: boolean }
      try { message = JSON.parse(line) } catch { continue }
      if (message.state === 'ready') {
        if (run.started || !validPort(message.port) || (run.bind.strict && message.port !== run.bind.port)) {
          run.error = 'The local preview did not report a valid listening port. Press Open in the Room to retry.'
          void stopLocalPreview($, pid, false, run.scope)
          break
        }
        // Up after a reseat: its connections would carry the old seat's
        // token, so it stops, and what wants it starts it again with the new one.
        if (!(await localRunCurrent($, pid, run)) || !sameRoom(room, run.scope)) {
          void stopLocalPreview($, pid, false, run.scope)
          break
        }
        run.localPort = message.port
        run.ipv6 = typeof message.ipv6 === 'boolean' ? message.ipv6 : undefined
        run.started = true
        run.timer?.cancel()
        // Listening: what asked for it saves it once its Open (or restore)
        // is done (`commitMappings`); the window's tunnel never is.
        run.settle(true)
        void syncBrowserRoutes($, run.scope)
      } else if (message.state === 'channel-ready') {
        run.channelError = undefined
        // The window's: working again, a failure waiting to be said isn't.
        if (run.owner === 'window') {
          for (const timer of run.saying?.values() ?? []) timer.cancel()
          run.saying?.clear()
          run.scope.window.stopSaid.delete(pid)
        }
        await $.ui.invalidate('ui.render')
      } else if (message.state === 'channel-error') {
        // Browsers cancel individual sockets during navigation: a failed
        // channel doesn't stop the run or any of its other channels.
        await runTrouble($, room, pid, run, 'channel', message.code)
      } else if (message.state === 'error') {
        if (message.code === 'EADDRINUSE' || message.code === 'DENIED') run.refused = message.code === 'DENIED' ? 'denied' : 'taken'
        run.error = message.code === 'EADDRINUSE'
          ? `localhost:${run.bind.port} is already in use on this computer. Nothing of yours was stopped.`
          : message.code === 'DENIED'
            ? `This computer doesn't let Claude Code listen on localhost:${run.bind.port}${run.bind.port < 1024 ? ' (on Linux, ports below 1024 need administrator rights)' : ''}.`
            : `Couldn't forward the host's localhost:${run.port}. Check the host is connected, then press Open in the Room to retry.`
        if (run.started) {
          run.failed = true
          await runTrouble($, room, pid, run, 'failed')
          await $.ui.invalidate('ui.render')
          void syncBrowserRoutes($, run.scope)
        }
      }
    }
    if ((await ended) === 'NODE') run.error = 'Local previews need Node on this computer. Install Node and press Open in the Room, or choose Public link.'
  } catch {
    // Never echo child diagnostics or credentials: the run's own words stand.
  } finally {
    run.timer?.cancel()
    run.settle(false)
    if (runs.get(pid) === run && !run.stopping) {
      runs.delete(pid)
      if (run.started && !run.failed && run.scope.live) await runTrouble($, room, pid, run, 'stopped')
      await $.ui.invalidate('ui.render')
      void syncBrowserRoutes($, run.scope)
    }
  }
}

// A run's trouble, said as its owner says it (`RunOwner`): a listener's at
// once (a failed channel, once for each kind; once up, its failure or
// stop); the window's tunnel a channel's its own way (`windowChannel`), and
// nothing of the rest: the window's next ask starts it again.
async function runTrouble($: $, room: ShareRoom, pid: string, run: LocalPreviewRun, what: 'channel' | 'failed' | 'stopped', code?: string) {
  const say = SAY[run.owner]
  if (what !== 'channel') {
    if (run.owner === 'listener') $.ui.toast(what === 'stopped' ? `Local preview on localhost:${run.localPort} stopped. Press Open in the Room to reconnect.` : run.error)
    return
  }
  const error = code === 'BUSY' ? say.busy : code === 'AUTH' ? say.refused : code === 'CONNECT' ? say.connect(room.host, run.port) : ''
  if (run.owner === 'window') return windowChannel($, room, pid, run, code, error)
  if (!error || run.channelError === error) return
  run.channelError = error
  $.ui.toast(error)
  await $.ui.invalidate('ui.render')
}

// A channel of the window's own tunnel failed (`code`; `error`, its words).
// Refused (AUTH): once since the person's own Open, the tunnel stops and
// the page's next ask starts it again with the seat's token this session
// holds now (its old seat let go); refused again, only their Open
// reconnects it (`needsOpen`). One refusal a tunnel: its other sockets say
// nothing more. Anything else is said a moment on, in the window's words,
// once the host's Stop (if that's what it was) has reached this session.
function windowChannel($: $, room: ShareRoom, pid: string, run: LocalPreviewRun, code: string | undefined, error: string) {
  if (code === 'AUTH') {
    if (run.channelError === error) return
    run.channelError = error
    if (run.scope.window.retryOnce(pid)) {
      void stopLocalPreview($, pid, false, run.scope)
      // A Stop the host pressed is said in the window's words, as below.
      sayWindowLater($, room, pid, run, 'AUTH', async () => {})
      return
    }
    void needsOpen($, room, pid, run).catch(() => {})
    return
  }
  if (!error || !code) return
  sayWindowLater($, room, pid, run, code, async () => {
    if (run.scope.children.listeners.get(pid) !== run || run.channelError === error) return
    run.channelError = error
    $.ui.toast(error)
    await $.ui.invalidate('ui.render')
  })
}

async function finishLocalPreview(pid: string, run: LocalPreviewRun) {
  run.timer?.cancel()
  run.settle(false)
  try { await run.child?.return(undefined as never) } catch {}
  if (run.scope.children.listeners.get(pid) === run) run.scope.children.listeners.delete(pid)
}

// `forget`: stopped on purpose (a Stop, a Close, the room saying it ended):
// what began for the preview in `s`, the room's scope, before now ends
// (its epoch moves on), and it's no listener to bring back.
async function stopLocalPreview($: $, pid: string, forget = true, s: RoomScope = scope) {
  if (forget) s.epochs.set(pid, s.epoch(pid) + 1)
  const run = s.children.listeners.get(pid)
  if (run) {
    run.stopping ??= finishLocalPreview(pid, run)
    await run.stopping
    // The window's proxy stops routing to it; a later ask starts it anew.
    void syncBrowserRoutes($, s)
  }
  if (forget) await update($, localPreviewsA, list => (!s.live || s.children.listeners.has(pid) ? list : list.filter(p => p.pid !== pid)))
}

// Guest: Close on a mapping in Room → Shown (or on a `Last:` one, to forget
// it): its listener stops, so its port here is free again, and so do the
// listeners of what only that page uses (`onlyUsedBy`). The window's own
// tunnel isn't a mapping: a page open there stays open.
async function closeLocalPreview($: $, pid: string) {
  const s = scope, room = await read($, roomA)
  if (!room || !stillInRoom(room, s) || s.mode !== 'guest') return
  const forwarded = await forwardedNow($), saved = await read($, localPreviewsA)
  const port = forwarded.find(f => f.pid === pid)?.port ?? saved.find(p => p.pid === pid)?.port ?? 0
  for (const p of [pid, ...(await onlyUsedBy($, s, { pid, port }))]) await closeMapping($, s, p)
  await $.ui.invalidate('ui.render')
}

// What a page uses that goes with it here (its Close, the host's Stop of it):
// mapped or listening here, used by no other page listening here or being
// opened (one for the page's own port is its alone; one for every page,
// `dependency: true`, stays while another page listens), and not opened by
// its own Open (`own`, or one opening now): that one the person wanted.
async function onlyUsedBy($: $, s: RoomScope, page: { pid: string; port: number }): Promise<string[]> {
  const forwarded = await forwardedNow($), saved = await read($, localPreviewsA)
  const dependencies = new Set(forwarded.filter(f => f.dependency !== undefined).map(f => f.pid))
  const others = [...s.children.listeners.keys(), ...s.previewOpens.keys()].some(p => p !== page.pid && !dependencies.has(p) && (Boolean(listening(p, s)) || s.previewOpens.has(p)))
  const mapped = (pid: string) => saved.some(x => x.pid === pid) || Boolean(listening(pid, s))
  const own = (pid: string) => saved.some(x => x.pid === pid && x.own) || s.previewOpens.has(pid)
  return dependenciesOf(forwarded, page).filter(f => mapped(f.pid) && !own(f.pid) && (f.dependency !== true || !others)).map(f => f.pid)
}

// A mapping closed for good: its listener stops and isn't saved; the
// window's own tunnel stands in for no mapping, so only what's saved goes.
async function closeMapping($: $, s: RoomScope, pid: string) {
  if (s.children.listeners.get(pid)?.owner === 'window') await update($, localPreviewsA, list => (s.live ? list.filter(x => x.pid !== pid) : list))
  else await stopLocalPreview($, pid, true, s)
}

// Where a saved listener was here: its last port, else the host's number.
const savedPort = (p: Pick<ShareLocalPreview, 'port' | 'localPort'>) => (validPort(p.localPort) ? p.localPort : p.port)

// What an Open (or a restore) brought up, saved once it's done, each where it
// is now (its actual port alone), so a reload or resume brings it back there.
// Only a run still up and current: no Stop, Close, Leave or newer start of it
// since. An Open that didn't finish saves nothing, so nothing it only tried
// comes back. `own`: what a page uses, opened by its own Open; kept as it was
// saved by an Open (or a restore) that reuses it.
async function commitMappings($: $, bound: readonly { pid: string; run: LocalPreviewRun; own?: true }[]) {
  await update($, localPreviewsA, list =>
    bound.reduce((next, { pid, run, own }) => {
      if (run.owner !== 'listener' || !run.started || run.failed || !validPort(run.localPort) || !runCurrent(pid, run)) return next
      const was = next.find(p => p.pid === pid)
      const kept = own ?? (was?.own && was.port === run.port ? was.own : undefined)
      return [...next.filter(p => p.pid !== pid), { pid, port: run.port, localPort: run.localPort, ...(kept ? { own: kept } : {}) }]
    }, list),
  )
}

// A reload or resume: each listener this guest had open comes back exactly at
// the port it had here (taken meanwhile, it stays closed rather than move: an
// open tab would reach whatever took it). What the host stopped or no longer
// forwards stays closed, as the window and the Room know it: Shown's, which
// the room's list keeps (and the room checks each connection again).
async function restoreLocalPreviews($: $) {
  const s = scope, room = await read($, roomA)
  if (!room || !sameRoom(room, s) || s.mode !== 'guest') return
  const shown = await read($, shownA)
  const failed: number[] = [], busy: number[] = [], denied: number[] = []
  for (const preview of await read($, localPreviewsA)) {
    if (!sameRoom(room, s)) return
    const item = shown.find(x => x.kind === 'preview' && x.pid === preview.pid)
    if (!item || item.closed || !item.tcp) {
      await stopLocalPreview($, preview.pid, true, s)
      continue
    }
    const at = savedPort(preview)
    const opened = await ensureLocalPreview($, room, s, item, { bind: { port: at, strict: true } })
    if (opened.run) await commitMappings($, [{ pid: preview.pid, run: opened.run }])
    if (!opened.error || !sameRoom(room, s)) continue
    // Left as it was: the Room says where it was (`Last:`), and Open may move it.
    failed.push(preview.port)
    if (opened.refused === 'denied') denied.push(at)
    else if (opened.refused) busy.push(at)
  }
  const why = [
    busy.length ? `${portsSaid(busy)} ${busy.length === 1 ? 'is' : 'are'} in use here now` : '',
    denied.length ? `this computer doesn't let Claude Code listen on ${portsSaid(denied)}` : '',
  ].filter(Boolean).join(', and ')
  if (failed.length) $.ui.toast(`${portsSaid(failed)} of ${room.host}'s ${failed.length === 1 ? "wasn't" : "weren't"} forwarded again${why ? `: ${why}` : ''}. Press Open in the Room when ready.`)
}

// The public origin is an explicit alternative, never an automatic fallback
// that changes an OAuth callback's origin after a failed localhost bind. It
// opens where a page does (`showPage`): Claude's browser in Desktop, else
// the person's own, else its link is copied.
async function openPublicPreview($: $, shown: ShareShown, surface?: RenderSurface) {
  const s = scope, room = await read($, roomA)
  if (!room || !shown.pid || shown.closed) return
  const pid = shown.pid, epoch = s.epoch(pid)
  const live = async () => localRequestCurrent(room, s, pid, epoch)
  if (!(await live())) return
  const url = await previewTicket($, room, pid, shown.path)
  if (!url) return void $.ui.toast('That preview has ended or is not reachable')
  await showPage($, room, url, surface, live, { copied: 'Public preview link copied: open it within 10 minutes', said: `Public preview link, for 10 minutes: ${url}` })
}

// ---------------------------------------------------------------------------
// Guest: preview windows. When a port a page needs is taken here (or with
// Previews: Always a separate window), a forwarded preview opens at the
// host's own address (http://localhost:3000, so its OAuth callbacks and
// cookies are the host's) in a browser window of its own: a Chromium-family
// browser or Firefox on a profile of its own, started with this plugin's
// SOCKS proxy for everything, localhost included (`<-loopback>`). The proxy
// (relay/browser-proxy.cjs) sends a localhost connection only to a tunnel of
// what the host shares: a run of local-preview.cjs on a port the system
// picks, so no host port is taken here and the guest's own servers on those
// ports never see the window. Anything else on localhost is refused (and the
// host asked, once), and so is this computer's own network (private
// addresses) unless SHARED_SESSION_PREVIEW_LAN=1; the rest of the web goes
// the way the person's own traffic goes. Without a browser, a display, or
// over SSH, the page opens elsewhere instead (`bindForOpen`, no window).

// Without a window: why not, and when it's that no browser here could open one (`none`) or one needs updating (`update`).
type WindowChoice = { window: true; platform: WindowPlatform; browser: string; name: string; family: BrowserFamily; isDefault?: true } | { window: false; reason: string; none?: true; update?: string }
// Said once a session, by key: the notes about the person's proxy, Claude's
// browser refused, and the like. A room's own (a preview's first Open and
// its cost, the window's welcome) are said once in that room (its scope's).
const saidOnce = new Set<string>()
const WINDOW_CLOSING = 'The preview window is still closing. Open the preview again in a moment.'
// How long each of the window's shell steps may take (sh's `within`): a look
// at a profile, its settings, a close (which waits up to 3 s) and a profile's
// cleanup all answer well inside it; the browser look can ask a Firefox
// wrapper's --version under `timeout 10`, so it gets longer.
const WINDOW_STEP_MS = 15_000, BROWSER_LOOK_MS = 30_000
// This session closed its own window as its proxy ended under it (routes the proxy refused, looks that failed).
const windowLost = (host: string) => `The preview window closed: its connection to ${host}'s previews stopped working. Press Open preview to open it again.`

// Looked for once a room (its scope's). A look that failed (the shell
// itself, no platform line) says nothing about this computer: it isn't kept,
// and the next Open looks again (a drawing doesn't, `failed`).
async function detectBrowser($: $, s: RoomScope = scope): Promise<BrowserFound & { failed?: true }> {
  const detection = s.window.detection
  detection.task ??= (async () => {
    try {
      const override = ((await $.env.get('SHARED_SESSION_BROWSER')) ?? '').trim()
      const { out, code } = await sh($, detectScript(override), BROWSER_LOOK_MS)
      if (code === 0 && /^platform=/m.test(out)) {
        // Another browser is taken before a Firefox whose profile path is too long for Linux (windowChoice says why when there's none).
        const found = parseDetect(out, !(await firefoxTooDeep($)))
        detection.done = found
        detection.failed = undefined
        return found
      }
    } catch {}
    detection.task = undefined
    detection.failed = true
    return { platform: 'unsupported' as const, browser: null, failed: true as const }
  })()
  return detection.task
}

// The desktop's D-Bus session, as Firefox looks for it.
async function sessionBus($: $): Promise<boolean> {
  if ((await $.env.get('DBUS_SESSION_BUS_ADDRESS'))?.trim()) return true
  const runtime = (await $.env.get('XDG_RUNTIME_DIR'))?.trim()
  return Boolean(runtime) && (await sh($, `# shared-session: is there a session bus\n[ -S ${sq(`${runtime}/bus`)} ]\n`, WINDOW_STEP_MS)).code === 0
}

// Whether a preview window can open here, and when it can't, why.
// `wait: false` (a drawing): what's known now; the browser is looked for
// meanwhile, and the rows draw again once it's known.
async function windowChoice($: $, wait = true, s: RoomScope = scope): Promise<WindowChoice | null> {
  if ((await $.env.get('SHARED_SESSION_NO_BROWSER')) === '1') return { window: false, reason: 'SHARED_SESSION_NO_BROWSER=1 opens no browser' }
  if ((await $.env.get('SSH_CONNECTION')) || (await $.env.get('SSH_TTY'))) return { window: false, reason: "this is an SSH session, so a window wouldn't open on your screen" }
  if (!wait && !s.window.detection.done) {
    // Drawn again once known. After a look that failed, a drawing doesn't look again: the next Open does.
    if (!s.window.detection.failed) void detectBrowser($, s).then(found => (found.failed ? undefined : $.ui.invalidate('ui.render'))).catch(() => {})
    return null
  }
  const found = await detectBrowser($, s)
  if (found.failed) return { window: false, reason: "looking for a browser here didn't work (it's tried again at the next Open)" }
  if (found.platform === 'unsupported') return { window: false, reason: 'preview windows work on macOS and Linux' }
  if (found.platform === 'linux' && !(await $.env.get('DISPLAY')) && !(await $.env.get('WAYLAND_DISPLAY'))) return { window: false, reason: 'there is no display for a window here (DISPLAY and WAYLAND_DISPLAY are unset)' }
  if (!found.browser) return { window: false, reason: 'no Chrome, Edge, Brave, Chromium, Firefox, Vivaldi or Opera was found (a snap one cannot be used)', none: true }
  const name = browserName(found.browser), family = browserFamily(found.browser, found)
  // Launched as the other kind, a browser could open the address in the person's own profile.
  if (!family) return { window: false, reason: `${name} can't be used for preview windows, which need a Chromium-family browser or Firefox`, none: true }
  // Firefox's hand-off of a second address goes only to the window's own profile from 67 on; the settings are tested from FIREFOX_MIN.
  if (family === 'firefox' && (found.gecko ?? 0) < FIREFOX_MIN) return found.gecko
    ? { window: false, reason: `${name} ${found.gecko} is too old for preview windows, which need Firefox ${FIREFOX_MIN} or newer`, update: name }
    : { window: false, reason: `${name}'s version couldn't be read, and preview windows need Firefox ${FIREFOX_MIN} or newer` }
  if (family === 'firefox' && found.platform === 'linux' && (await firefoxTooDeep($))) return { window: false, reason: `the preview window's profile folder is too deep for Firefox on Linux (${FIREFOX_PATH_MAX} bytes at most; set CLAUDE_CONFIG_DIR to a shorter path)` }
  return { window: true, platform: found.platform, browser: found.browser, name, family, ...(found.isDefault ? { isDefault: true as const } : {}) }
}

// Two rooms' Firefox profiles past this length could share one D-Bus name on Linux, and a page go to the other room's window.
async function firefoxTooDeep($: $): Promise<boolean> {
  return new TextEncoder().encode(`${await browserDirOf($)}/h-${'0'.repeat(16)}/firefox`).length > FIREFOX_PATH_MAX
}

// `s`: a room's note, said once in that room, and never once it's left.
function noteOnce($: $, key: string, text: string, s?: RoomScope) {
  const said = s ? s.said : saidOnce
  if ((s && !s.live) || said.has(key)) return
  said.add(key)
  $.ui.toast(text)
}

async function browserDirOf($: $): Promise<string> {
  const dir = await configDirOf($)
  if (!dir) throw new Error('No Claude configuration directory is available')
  return `${dir}/shared-session/browser`
}

const PROFILE_NAME = /^(?:h-)?[0-9a-f]{16}$/
// A signed-in host's profile (`h-…`), shared by their rooms.
const hostProfile = (name: string) => name.startsWith('h-')

// A preview window's profile. A signed-in host's rooms share one, named for
// their account on that server and kept between rooms, so sign-ins made in
// the window stay; it goes after thirty days unused. Otherwise it's the
// room's for this session: kept while the session keeps its place in the
// room, and gone with it. That one is named for the room and the session's
// lasting place, as its saved place is (Claude Desktop's own id for the
// session, which stays when Desktop reopens it under a new Claude Code id;
// else Claude Code's, which a resume keeps): two sessions in one room never
// share a window. The name a window got is kept with it.
async function profileOf($: $, room: { server: string; id: string }, saved?: string): Promise<{ dir: string; profile: string; name: string }> {
  const dir = await browserDirOf($)
  const w = await read($, previewWindowA)
  const kept = saved ?? (w?.room === `${room.server}/${room.id}` ? w.profile : undefined)
  const account = (await read($, peopleA)).find(p => p.role === 'host')?.account
  const name = kept && PROFILE_NAME.test(kept) ? kept : account ? await hostProfileName(room.server, account) : await roomProfileName($, room)
  return { dir, profile: `${dir}/${name}`, name }
}

async function roomProfileName($: $, room: { server: string; id: string }): Promise<string> {
  return profileName(room.server, room.id, (await placeOf($)) || (await $.session.id()))
}

type WindowSeen = { pid: number; port: number | null; family: BrowserFamily }

// The window open on a profile, if one is: the process holding it (Chrome's
// SingletonLock names it; Firefox's is the one started on that profile),
// when its command line names that profile, and its proxy's port.
// `undefined`: the look itself failed, which says nothing either way: never
// taken for no window, nothing ends a proxy or closes a window on one (three
// in a row, and the window counts as gone, `checkWindow`).
async function windowProbe($: $, profile: string): Promise<WindowSeen | null | undefined> {
  const look = await windowLook($, profile)
  return 'why' in look ? undefined : look.seen
}

// The look, and for one that failed, why: the shell never ran, took too long
// (WINDOW_STEP_MS), or ended in trouble.
async function windowLook($: $, profile: string): Promise<{ seen: WindowSeen | null } | { why: string }> {
  const { out, code, late } = await sh($, lockScript(profile), WINDOW_STEP_MS)
  if (code === 0) return { seen: windowOf(out, profile) }
  return { why: late ? 'the look at its profile took too long' : code === null ? "the look at its profile didn't run" : `the look at its profile ended with code ${code}` }
}

// A window just started is there once a process holds its profile, which
// can take a moment: Linux, and a bare binary on macOS, report a start at
// once, whatever happens next. Looked for every half second, `ms` at most.
// `seen`: another sign it's there (its page reached the proxy).
async function windowAppears($: $, profile: string, ms: number, seen: () => boolean = () => false): Promise<boolean> {
  for (let waited = 0; ; waited += 500) {
    if (seen() || (await windowProbe($, profile)) || seen()) return true
    if (waited >= ms) return false
    await new Promise<void>(done => $.clock.after(500, done))
  }
}

// That one process, never a pattern; `wait`: until it's gone (up to 3 s).
// `port`: only the window on that proxy port, as on a host's profile, which
// another session's window may hold. Whether there was one to close.
async function killWindow($: $, profile: string, wait: boolean, port?: number): Promise<boolean> {
  return (await sh($, killScript(profile, wait, port), WINDOW_STEP_MS)).out.includes('killed')
}

// Chrome reads its WebRTC setting as it starts: written before a start, so
// a page's WebRTC goes only through the proxy (`chromePrefs`). A file too big
// to read here was set at the profile's first start.
async function setChromePrefs($: $, profile: string): Promise<boolean> {
  const file = `${profile}/chrome/Default/Preferences`
  let text: string | null = null
  if (await $.fs.exists(file).catch(() => false)) {
    try {
      text = await $.fs.read(file)
    } catch {
      return true
    }
  }
  const merged = chromePrefs(text)
  return merged === null || (await sh($, chromePrefsScript(profile, merged), WINDOW_STEP_MS)).code === 0
}

// Its scope is the room's it serves: closed, it ends. `control` is its
// control port, `port` the one the window's browser is told to use.
type BrowserProxy = Helper & {
  room: ShareRoom
  key: string
  /** The port asked for: the window's own after a reload, else 0 (any). */
  asked: number
  port?: number
  /** The routes last sent, so the same ones aren't sent again. */
  sent?: string
  /** Routes posts that failed in a row: three, and the proxy is ended. */
  failures: number
  /** Whether it lets the window reach this computer's own network (SHARED_SESSION_PREVIEW_LAN=1). */
  lan: boolean
  /** Host ports the window has asked for through this proxy (`seen`). */
  seen: Set<number>
  /** Windows being started, listening for their page's first ask (`seen`). */
  asks: Set<Asked>
  /** A tunnel starting for the window, one per preview. */
  wants: Map<string, Promise<void>>
}
// A start's page reached the proxy (`seen`); `late`: after the start was
// said to have failed, what makes it open after all.
type Asked = { port: number; seen: boolean; late: (() => Promise<void>) | null }

// The person's own way out: their proxy from the environment (HTTPS_PROXY,
// ALL_PROXY, NO_PROXY), else macOS's settings. Never one with credentials,
// one the window's proxy can't speak, or a PAC file: each said once. One
// that's no address at all (the URL parser takes none from it) is passed
// over here; one whose host the window's proxy can't take, it leaves out
// itself and says so (its `upstream` line, `runBrowserProxy`): both said in
// the same words, once.
const UPSTREAM_NOT_TAKEN = "The preview window doesn't use your proxy setting: it isn't an address its proxy can take (a host name or IP address, and a port)."
async function upstreamProxy($: $): Promise<Upstream | null> {
  const env = upstreamFromEnv({
    HTTPS_PROXY: await $.env.get('HTTPS_PROXY'),
    https_proxy: await $.env.get('https_proxy'),
    ALL_PROXY: await $.env.get('ALL_PROXY'),
    all_proxy: await $.env.get('all_proxy'),
    NO_PROXY: await $.env.get('NO_PROXY'),
    no_proxy: await $.env.get('no_proxy'),
  })
  if (env.userinfo) noteOnce($, 'userinfo', "Your proxy setting has a user name or password, which the preview window's proxy doesn't use: sign-ins in the window may fail.")
  if (env.unsupported) noteOnce($, 'unsupported', "The preview window doesn't use your https:// or socks4:// proxy setting: its proxy goes on only through http:// and socks5:// proxies.")
  if (env.invalid) noteOnce($, 'invalid', UPSTREAM_NOT_TAKEN)
  if (env.upstream) return env.upstream
  if ((await detectBrowser($)).platform !== 'darwin') return null
  const system = upstreamFromScutil((await sh($, 'scutil --proxy 2>/dev/null\n', WINDOW_STEP_MS)).out)
  if (system.invalid) noteOnce($, 'invalid', UPSTREAM_NOT_TAKEN)
  if (system.pac) noteOnce($, 'pac', "PAC proxies aren't followed; Google sign-in may fail in the preview window.")
  return system.upstream
}

function startBrowserProxy($: $, room: ShareRoom, port: number, s: RoomScope): BrowserProxy {
  const proxy: BrowserProxy = { ...newHelper(s), room, key: roomIdentity(room), asked: port, failures: 0, lan: false, seen: new Set(), asks: new Set(), wants: new Map() }
  s.children.windowProxy = proxy
  void runBrowserProxy($, proxy)
  return proxy
}

// Gone from its scope at once: the next Open starts another beside it.
function finishBrowserProxy(proxy: BrowserProxy): Promise<void> {
  return finishHelper(proxy, async () => {
    if (proxy.scope.children.windowProxy === proxy) proxy.scope.children.windowProxy = null
    await proxy.child?.return(undefined as never)
  })
}

// Supervised as the host's TCP worker is: five seconds to say it's ready, its
// lines read as they come (8192 bytes each at most), and ended on anything
// unexpected. Its settings go on stdin: a port, its control secret, whether
// it may reach this computer's network, and the person's upstream proxy;
// never a room's token.
async function runBrowserProxy($: $, proxy: BrowserProxy) {
  try {
    const upstream = await upstreamProxy($).catch(() => null)
    proxy.lan = (await $.env.get('SHARED_SESSION_PREVIEW_LAN')) === '1'
    if (proxy.stopped || proxy.scope.children.windowProxy !== proxy || !proxy.scope.live) return
    const settings = { port: proxy.asked, controlToken: proxy.controlToken, lan: proxy.lan, upstream }
    await runHelper($, proxy, 'browser-proxy.cjs', settings, 5_000, () => finishBrowserProxy(proxy), () => !proxy.stopped && proxy.scope.children.windowProxy === proxy, async said => {
      const line = proxyLine(said)
      if (!line) return
      if (line.state === 'ready') {
        if (proxy.port || (proxy.asked && line.port !== proxy.asked)) throw new Error('Invalid preview proxy readiness')
        const port = line.port
        proxy.port = port
        helperReady(proxy, line.control)
        await update($, previewWindowA, w => (proxy.stopped || !proxy.scope.live ? w : { room: proxy.key, port, opened: w?.room === proxy.key && w.port === port ? w.opened : [], ...(w?.room === proxy.key && w.profile ? { profile: w.profile } : {}) }))
        proxy.settle(true)
        void syncBrowserRoutes($, proxy.scope)
      } else if (line.state === 'error') {
        proxy.error = line.code
        throw new Error('Preview proxy failed')
      } else if (!proxy.port) return
      // It left the person's own proxy out (a host it can't take) and goes on without it.
      else if (line.state === 'upstream') {
        if (line.reason === 'INVALID_UPSTREAM') noteOnce($, 'invalid', UPSTREAM_NOT_TAKEN)
      } else if (line.state === 'lan') void lanRefused($, proxy).catch(() => {})
      else if (line.state === 'want') void wantPort($, proxy, line.port).catch(() => {})
      else if (line.state === 'blocked') void blockedPort($, proxy, line.port).catch(() => {})
      else {
        proxy.seen.add(line.port)
        for (const asks of [...proxy.asks]) {
          if (asks.port !== line.port) continue
          asks.seen = true
          proxy.asks.delete(asks)
          if (asks.late) void asks.late().catch(() => {})
        }
      }
    })
  } catch {
    // Never echo the child's diagnostics: they can name hosts the window asked for.
  } finally {
    // Ended by this session (its window gone, the proxy failing, a newer one),
    // not by its child going (as with the module at a reload, which brings it
    // back on its window's port), and not as the room ends (the place keeps it).
    const ended = proxy.stopped && proxy.port !== undefined && proxy.scope.live
    await finishBrowserProxy(proxy)
    // Its window reaches nothing now (unless another proxy took over for the
    // room): its tunnels go, and Open preview shows again. Ended here, its
    // port goes too: another session's proxy may take that number and its
    // window open on a host's profile, which this session must never take
    // for its own (`openWindow`). So this session's window still up on that
    // port (its routes refused, its looks failing) is closed first, on that
    // port alone: kept open with its port forgotten, Leave would leave it
    // open and the next Open take it for another session's.
    // As the room closes, its state goes with it: nothing more here.
    try {
      const next = proxy.scope.children.windowProxy, successor = next && !next.stopped
      if (!successor && proxy.scope.live) {
        for (const [pid, run] of [...proxy.scope.children.listeners]) if (run.owner === 'window') await stopLocalPreview($, pid, false, proxy.scope)
        const forget = (w: SharePreviewWindow) => ended && w.port === proxy.port
        const was = await read($, previewWindowA)
        if (was?.room === proxy.key && forget(was) && (await killWindow($, (await profileOf($, proxy.room, was.profile)).profile, true, proxy.port)) && proxy.scope.live) $.ui.toast(windowLost(proxy.room.host))
        await update($, previewWindowA, w => (proxy.scope.live && w?.room === proxy.key && (w.opened.length || forget(w)) ? { ...w, opened: [], ...(forget(w) ? { port: 0 } : {}) } : w))
      }
      await $.ui.invalidate('ui.render')
    } catch {}
  }
}

// The proxy refused a page's request to this computer's own network (a
// private address): said once a session, with the way to allow it. With
// that allowed already, what's refused is never allowed (a cloud metadata
// address), and nothing is said.
async function lanRefused($: $, proxy: BrowserProxy) {
  const room = proxy.room
  if (proxy.lan || proxy.stopped || proxy.scope.children.windowProxy !== proxy || !stillInRoom(room, proxy.scope) || proxy.scope.mode !== 'guest') return
  noteOnce($, 'lan', `The preview window refused a request to your local network (a private address). Pages from ${room.host} can't reach your network; set SHARED_SESSION_PREVIEW_LAN=1 where Claude Code starts to allow it.`)
}

// The room's proxy, started if need be (on `port`: the open window's own),
// for the caller's room scope only: left meanwhile, nothing starts, and what
// started is ended.
async function ensureBrowserProxy($: $, room: ShareRoom, port: number, s: RoomScope): Promise<BrowserProxy | { error: string }> {
  if (!stillInRoom(room, s)) return { error: 'STALE' }
  // The room's own (its scope's): one ended is gone from it at once.
  const proxy = s.children.windowProxy ?? startBrowserProxy($, room, port, s)
  const ready = await proxy.ready
  if (!s.live) {
    await finishBrowserProxy(proxy)
    return { error: 'STALE' }
  }
  return ready && !proxy.stopped && proxy.port ? proxy : { error: proxy.error ?? 'STARTUP' }
}

// What the host shares this moment, by host port. In a window these follow
// the host's current authority by themselves (no port here is taken for
// them); a local listener still needs its own Open.
async function browserAuthority($: $): Promise<Map<number, Forwarded>> {
  return new Map((await forwardedNow($)).map(f => [f.port, f]))
}

// A window's own tunnel lasts while the window does and the host allows it.
async function windowInterest($: $, pid: string, s: RoomScope): Promise<boolean> {
  const proxy = s.children.windowProxy
  if (!proxy || proxy.stopped || !s.live || s.mode !== 'guest' || (await read($, previewNeedsOpenA)).includes(pid)) return false
  return (await forwardedNow($)).some(f => f.pid === pid)
}

// The proxy's two maps, replaced whole: each running tunnel by the host port
// it reaches (the current run's actual local port), and the host ports it may
// ask a tunnel for. One at a time, in order; a post that fails is tried
// again in a second, and only three in a row end the proxy.
async function syncBrowserRoutes($: $, s: RoomScope = scope) {
  const proxy = s.children.windowProxy
  if (!proxy || proxy.stopped) return
  await proxy.queue.run(async () => {
    if (!(await proxy.ready) || proxy.stopped || s.children.windowProxy !== proxy || !s.live || s.mode !== 'guest') return
    const routes: Record<string, number> = {}
    for (const run of s.children.listeners.values()) {
      if (Object.keys(routes).length >= 128) break
      if (run.started && !run.failed && !run.stopping && validPort(run.localPort)) routes[String(run.port)] = run.localPort
    }
    const now = await $.clock.now()
    const refused = new Set(await read($, previewNeedsOpenA))
    const startable = [...(await browserAuthority($))].filter(([port, a]) => routes[String(port)] === undefined && !refused.has(a.pid) && (s.window.backoff.get(a.pid)?.until ?? 0) <= now).map(([port]) => port).slice(0, 128)
    const body = { op: 'routes', routes, startable }
    const text = JSON.stringify(body)
    if (text === proxy.sent || proxy.stopped || !proxy.control) return
    // Not taken (no answer in two seconds included): sent again in a second;
    // three in a row, and the proxy is ended.
    const status = await controlPost($, proxy.control, proxy.controlToken, body, {
      answers: [200],
      failed: () => {
        if (++proxy.failures >= 3) void finishBrowserProxy(proxy)
        else $.clock.after(1_000, () => void syncBrowserRoutes($, s))
      },
    })
    if (status !== 200) return
    proxy.sent = text
    proxy.failures = 0
  }).catch(() => {})
}

// The window asked for a port the host shares and no tunnel serves yet.
async function wantPort($: $, proxy: BrowserProxy, port: number) {
  const s = proxy.scope, room = await read($, roomA)
  if (proxy.stopped || s.children.windowProxy !== proxy || !room || !stillInRoom(room, s) || s.mode !== 'guest') return
  const authority = (await browserAuthority($)).get(port)
  if (!authority || (await read($, previewNeedsOpenA)).includes(authority.pid) || (s.window.backoff.get(authority.pid)?.until ?? 0) > (await $.clock.now())) return void syncBrowserRoutes($, s)
  const pid = authority.pid
  if (proxy.wants.has(pid)) return
  const task = (async () => {
    const opened = await ensureLocalPreview($, room, s, authority, { window: true })
    // Ended by a reseat meanwhile (started with the old seat's token): the
    // page's next ask starts it again at once, with the new seat's.
    if (opened.error && s.children.windowProxy === proxy && !proxy.stopped && sameRoom(room, s)) {
      s.window.backoff.set(pid, { ...s.window.backoff.get(pid), until: (await $.clock.now()) + 30_000 })
      $.clock.after(30_000, () => void syncBrowserRoutes($, s))
    }
    await syncBrowserRoutes($, s)
  })()
    .catch(() => {})
    .finally(() => proxy.wants.delete(pid))
  proxy.wants.set(pid, task)
}

// Guest: the ports the window asked the host about, once each a room.
const NONE_ASKED: ShareNeedAsked = { ports: [], times: [] }

async function noteNeedAsked($: $, s: RoomScope, port: number) {
  await update($, needAskedA, n => {
    const cur = n ?? NONE_ASKED
    return !s.live || cur.ports.includes(port) ? n : { ...cur, ports: [...cur.ports, port].slice(-256) }
  })
}

// The window asked for a localhost port nobody shared: the host is asked
// (five ports a minute at most) and this person told. A port counts as asked
// only once the room answered; a request refused for too many, or not
// answered, is asked again later. One
// the host stopped isn't asked about (`previewEnded`).
async function blockedPort($: $, proxy: BrowserProxy, port: number) {
  const s = proxy.scope, room = await read($, roomA)
  if (!room || roomIdentity(room) !== proxy.key) return
  const live = () => !proxy.stopped && s.children.windowProxy === proxy && stillInRoom(room, s) && s.mode === 'guest'
  if (!live()) return
  // Shared, just not to be started now (refused, or a start that failed): no one to ask.
  if ((await browserAuthority($)).has(port)) return void syncBrowserRoutes($, s)
  if (s.window.needAsking.has(port)) return
  s.window.needAsking.add(port)
  try {
    // Asked already, or five this minute: nothing now. The slot is taken in
    // the same write that counts it, so asks at once can't pass five.
    const now = await $.clock.now()
    let slot = false
    await update($, needAskedA, n => {
      const cur = n ?? NONE_ASKED
      const times = cur.times.filter(t => now - t < 60_000)
      slot = s.live && times.length < 5 && !cur.ports.includes(port)
      return slot ? { ...cur, times: [...times, now] } : n
    })
    if (!slot) return
    let answer: { delivered?: boolean; shared?: boolean }
    try {
      answer = await api<{ delivered?: boolean; shared?: boolean }>($, room.server, `/api/rooms/${room.id}/need`, { method: 'POST', token: room.token, body: { port } })
    } catch {
      return
    }
    if (!live()) return
    await noteNeedAsked($, s, port)
    // Forwarded already, just now: the room's next page lists it, and the
    // routes follow it (`takeRoomList`).
    if (answer.shared) return void syncBrowserRoutes($, s)
    const said = `Your preview tried localhost:${port}, which ${room.host} hasn't shared.`
    $.ui.toast(answer.delivered ? `${said} The request went to ${room.host}.` : `${said} Ask ${room.host} to share it.`)
  } finally {
    s.window.needAsking.delete(port)
  }
}

// What a refused tunnel was for: a page Open preview opens, or a page's
// dependency (that page opens it).
type Refused = { kind: 'entry' | 'dependency'; entries: Set<string>; dependency?: number | true }
async function refusedOf($: $, pid: string): Promise<Refused> {
  const forwarded = await forwardedNow($)
  const refused = forwarded.find(f => f.pid === pid)
  if (refused?.dependency === undefined) return { kind: 'entry', entries: new Set([pid]) }
  return { kind: 'dependency', dependency: refused.dependency, entries: new Set(pagesOf(forwarded, refused).map(f => f.pid)) }
}

// `promised`: the band's Open preview opens what reconnects it (`bandEntry`);
// otherwise the Room's own button for it is named.
function refusedWords(host: string, port: number, r: Refused, promised: boolean): string {
  const said = `${host}'s side refused the preview window's connection to localhost:${port}`
  const which = r.kind === 'dependency' ? `, which ${r.dependency === true ? 'a preview uses' : `the preview of localhost:${r.dependency} uses`}` : ''
  if (!promised) return `${said}${which}. Press Open on localhost:${port} in Room → Shown to reconnect.`
  return `${said}${which}. Press Open preview${r.kind === 'dependency' ? ' for that page' : ''} to reconnect.`
}

// What the toast for a refusal says: computed when it's said, so it names
// what the band's Open preview opens then.
async function refusalSaid($: $, room: ShareRoom, pid: string, port: number): Promise<string> {
  const refused = await refusedOf($, pid), band = await bandEntry($)
  return refusedWords(room.host, port, refused, Boolean(band && refused.entries.has(band.pid)))
}

// The host refused the window's tunnel: it stops, and only the person's own
// Open reconnects it (never the window asking again by itself). What Open
// preview opens for it (the page, or the page that uses it) shows again.
async function needsOpen($: $, room: ShareRoom, pid: string, run: LocalPreviewRun) {
  const s = run.scope
  if (!s.live) return
  const first = !(await read($, previewNeedsOpenA)).includes(pid)
  await update($, previewNeedsOpenA, list => (!s.live || list.includes(pid) ? list : [...list, pid].slice(-64)))
  const refused = await refusedOf($, pid)
  await update($, previewWindowA, w => (w && s.live ? { ...w, opened: w.opened.filter(p => p !== pid && !refused.entries.has(p)) } : w))
  if (s.children.listeners.get(pid) === run) await stopLocalPreview($, pid, false, s)
  if (first && stillInRoom(room, s)) sayWindowLater($, room, pid, run, 'AUTH', async () => {
    if (!(await read($, previewNeedsOpenA)).includes(pid)) return
    $.ui.toast(await refusalSaid($, room, pid, run.port))
  })
  void syncBrowserRoutes($, s)
}

// A window tunnel's failure is said 1.5 s on, one of each kind at a time: a
// Stop the host pressed as a page used it reaches this session by then, and
// what happened is said instead, once ("Sam stopped sharing localhost:P"),
// never the failure it caused. Left meanwhile, nothing; shared again under
// a new preview, nothing (its tunnel starts as the window asks).
function sayWindowLater($: $, room: ShareRoom, pid: string, run: LocalPreviewRun, code: string, say: () => Promise<void>) {
  const saying = (run.saying ??= new Map())
  if (saying.has(code)) return
  saying.set(code, $.clock.after(1_500, () => {
    saying.delete(code)
    void (async () => {
      const s = run.scope
      if (!stillInRoom(room, s) || s.mode !== 'guest') return
      const authority = await browserAuthority($)
      if (![...authority.values()].some(a => a.pid === pid)) {
        if (authority.has(run.port) || s.window.stopSaid.has(pid)) return
        s.window.stopSaid.add(pid)
        return void $.ui.toast(`${room.host} stopped sharing localhost:${run.port}.`)
      }
      await say()
    })().catch(() => {})
  }))
}

// What a person's Open clears of the host's refusals before: the page's own,
// and the page's dependencies.
// Their Open clears the start backoff, and gives each a refusal's one restart again.
async function clearRefusals($: $, pids: readonly string[], s: RoomScope) {
  if (!pids.length || !s.live) return
  await update($, previewNeedsOpenA, list => (!s.live ? list : list.filter(p => !pids.includes(p))))
  for (const pid of pids) s.window.backoff.delete(pid)
}

// The person's own Open: a refusal before, the page's or of what it uses, is
// theirs to retry. A run the room refused (AUTH: the seat's token it carries
// isn't the room's now) stops, so this Open starts it anew with the token
// held now: what the page uses kept as it is would refuse the page's every
// request, a listener's and the window's alike (the window routes to
// whatever run serves a port).
async function retryRefused($: $, page: { pid: string; port: number }, s: RoomScope) {
  const clears = [page.pid, ...dependenciesOf(await forwardedNow($), page).map(f => f.pid)]
  await clearRefusals($, clears, s)
  for (const pid of clears) if (refusedRun(s, pid)) await stopLocalPreview($, pid, false, s)
}

// What Open preview opens: forwarded pages, newest first (Shown's order:
// an artifact moves its preview to the end, and the reverse puts the newest
// first), each at the host's exact address. Never a page's dependency: the
// page reaches those.
async function previewEntries($: $): Promise<Forwarded[]> {
  return (await forwardedNow($)).filter(f => f.dependency === undefined).reverse()
}

// The band's Open preview: what reconnects a refusal first, in the order the
// host's side refused them (the page, or the page that uses a dependency:
// what the refusal's toast promised), else the newest
// forwarded preview not open here yet (in the window, or on a local listener).
async function bandEntry($: $): Promise<Forwarded | null> {
  const entries = await previewEntries($)
  if (!entries.length) return null
  const room = await read($, roomA), w = await read($, previewWindowA)
  const opened = new Set(room && w?.room === roomIdentity(room) ? w.opened : [])
  const free = (e: Forwarded) => !opened.has(e.pid) && !listening(e.pid)
  for (const pid of await read($, previewNeedsOpenA)) {
    const reconnects = (await refusedOf($, pid)).entries
    const found = entries.find(e => reconnects.has(e.pid) && free(e))
    if (found) return found
  }
  return entries.find(free) ?? null
}

// Opens a preview at the host's exact address in the room's window: its
// tunnel first (so the page's first request has somewhere to go), then the
// window, or a new one of it when the open window started on another proxy
// port (Chrome keeps the flags a profile's first window started with).
// One Open at a time (the room's window's queue): a second waits for the
// first's window, then finds it open, rather than starting another browser
// on the same profile. A room left behind holds nothing up: an open finds
// that at its next step, and stops there (`windowStep`).

// Why the window: Previews: Always a separate window, the page open in it
// already, or a port the page needs taken (or refused) here. What came of
// it: open; a definite failure, and why (the Open goes on as its policy says
// without the window, `openForwarded`); or nothing more to do (said, left
// meanwhile, or not seen yet: a window that shows late opens by itself).
type WindowWhy = { always: true } | { again: true } | RefusedPort
type WindowOutcome = 'opened' | 'done' | { failed: string }

async function openInWindow($: $, room: ShareRoom, s: RoomScope, choice: Extract<WindowChoice, { window: true }>, page: Forwarded, why: WindowWhy): Promise<WindowOutcome> {
  const win = s.window
  const task = win.opens.run(async (): Promise<WindowOutcome> => (s.live ? openWindow($, room, s, choice, page, why) : 'done'))
  const opening = task.then(() => {}, () => {})
  win.openings.add(opening)
  try {
    return await task
  } finally {
    win.openings.delete(opening)
  }
}

// What opens a preview without the window, said after trouble with it, in
// this surface's words (`shownIn`). `ifNone`: the window may still show.
async function windowRemedy($: $, why: WindowWhy, ifNone: boolean): Promise<string> {
  const lead = ifNone ? 'If none opens, ' : ''
  if ('always' in why) {
    const setting = (await isDesktop($)) ? "Claude's browser" : 'Your browser'
    return `${lead}${ifNone ? 'set' : 'Set'} Previews to ${setting} in Room → Settings, and a preview whose ports are free here opens there instead.`
  }
  if ('refused' in why && why.refused === 'taken') {
    const viewer = (await shownIn($)) === 'pane' ? "Claude's browser" : 'your browser'
    return `${lead}${ifNone ? 'free' : 'Free'} localhost:${why.port} on this computer and press Open preview to open it in ${viewer} instead.`
  }
  return ifNone ? 'If none opens, press Open preview to try again.' : ''
}

// One open of the window as it goes (`openWindow`): the page, and why the
// window; then what it has taken, which the room left meanwhile puts away
// (`abandonWindow`): the profile (and on a host's, the hold on it, `lock`),
// the window it found open there (`alive`: null, none; a look that knows
// nothing ends the open before this is set, `openLook`), the room's proxy as
// the open began (`had`), whether the browser was started, and on which
// proxy port.
type WindowOpen = {
  room: ShareRoom
  s: RoomScope
  choice: Extract<WindowChoice, { window: true }>
  page: Forwarded
  why: WindowWhy
  key: string
  url: string
  dir?: string
  profile?: string
  name?: string
  alive?: WindowSeen | null
  had?: BrowserProxy | null
  lock?: { profile: string; token: string }
  launched: boolean
  port?: number
  /** The page's epoch as the open began: a Stop of it since (the host's, or its Close) ends the open before the browser starts, or leaves the window unannounced (`pageStopped`). */
  epoch: number
}

// The room left (Leave, Stop sharing, its end, the session closing) while
// its window was being opened: what the open's next step finds, thrown, and
// caught once (`openWindow`). A reseat is no way out: a window started over
// one is this room's, and stays open.
class Stale extends Error {}

// A step of an open, once it's done: still in its room, or Stale.
async function windowStep<T>(open: WindowOpen, step: Promise<T>): Promise<T> {
  const done = await step
  if (!stillInRoom(open.room, open.s)) throw new Stale('The room was left while its window opened')
  return done
}

// The page stopped since its open began (the host's Stop, or its Close): the
// room's still there, so nothing is put away, but nothing more opens the page.
const pageStopped = (open: WindowOpen) => open.s.epoch(open.page.pid) !== open.epoch

const PROFILE_UNMADE = "its private profile couldn't be made"

// The page in the room's window, in four steps: the profile it opens on, the
// proxy and tunnel that reach the host, the browser, and what's said. Left
// meanwhile, nothing more starts, and what it made goes (`abandonWindow`); a
// host's profile taken for it is let go however it ends.
async function openWindow($: $, room: ShareRoom, s: RoomScope, choice: Extract<WindowChoice, { window: true }>, page: Forwarded, why: WindowWhy): Promise<WindowOutcome> {
  const open: WindowOpen = { room, s, choice, page, why, key: roomIdentity(room), url: pageUrl(page), launched: false, epoch: s.epoch(page.pid) }
  try {
    const chosen = await chooseProfile($, open)
    if (chosen !== true) return chosen
    await retryRefused($, page, s)
    const proxy = await readyProxy($, open)
    if (typeof proxy === 'string' || 'failed' in proxy) return proxy
    const launched = await launchWindow($, open, proxy)
    return launched === 'seen' ? await announceWindow($, open, proxy) : launched
  } catch (error) {
    if (!(error instanceof Stale)) throw error
    if (open.dir && open.profile) await abandonWindow($, s, open.dir, open.profile, open.launched, open.port)
    return 'done'
  } finally {
    await letProfileGo($, open)
  }
}

// The profile the window opens on (`profileOf`): a signed-in host's, or the
// room's own for this session. A host's is taken first, and held through the
// start (`takeProfile`). Another session of this person's starting a window
// on it just now, or a window there this session didn't start (another
// session's, on its own proxy port): it's left to them, and this session
// takes the room's own instead. A look that knows nothing, asked twice,
// ends the open there (`openLook`). Made private, and named in the state: a
// room's goes when the person leaves the room. True: chosen; else how the
// open ends (its profile couldn't be made, or no look could tell).
async function chooseProfile($: $, open: WindowOpen): Promise<true | WindowOutcome> {
  const { room, s, key } = open
  const was = await read($, previewWindowA)
  let chosen = await windowStep(open, profileOf($, room))
  let alive: WindowSeen | null | { unknown: string } | undefined
  if (hostProfile(chosen.name)) {
    if (await windowStep(open, takeProfile($, open, chosen.dir, chosen.profile))) alive = await openLook($, open, chosen.profile)
    if (alive && 'unknown' in alive) return unknownLook($, alive.unknown)
    const ours = alive === null || (alive !== undefined && was?.room === key && was.profile === chosen.name && was.port === alive.port)
    if (!ours) {
      await letProfileGo($, open)
      chosen = await windowStep(open, profileOf($, room, await roomProfileName($, room)))
      alive = undefined
    }
  }
  if (alive === undefined) alive = await openLook($, open, chosen.profile)
  if (alive && 'unknown' in alive) return unknownLook($, alive.unknown)
  const { dir, profile, name } = chosen
  Object.assign(open, { dir, profile, name, alive })
  if ((await windowStep(open, sh($, profileScript(dir, profile), WINDOW_STEP_MS))).code !== 0) return { failed: PROFILE_UNMADE }
  // This session's window still up (its port kept) on the profile it fell
  // back from (a host's whose hold was busy) keeps its record:
  // its looks, and Leave, still find it. The room's own is named in its
  // place once a window opens there (`windowOpened`); never opened, it goes
  // in a start's sweep a day on (`gcPreviewProfiles`).
  await update($, previewWindowA, w => (!s.live ? w : w?.room === key ? (w.profile === name || w.port ? w : { ...w, port: 0, opened: [], profile: name }) : { room: key, port: 0, opened: [], profile: name }))
  return true
}

// An open's look at the window on a profile (`windowLook`): one that fails
// is asked again once, about 300 ms on. Never guessed: still unknown, the
// open ends there (`unknownLook`) rather than take it for no window (its
// settings written under one open there, a second browser started on it)
// or for someone else's.
async function openLook($: $, open: WindowOpen, profile: string): Promise<WindowSeen | null | { unknown: string }> {
  const first = await windowStep(open, windowLook($, profile))
  if (!('why' in first)) return first.seen
  await windowStep(open, new Promise<void>(done => $.clock.after(300, done)))
  const again = await windowStep(open, windowLook($, profile))
  return 'why' in again ? { unknown: again.why } : again.seen
}

// A look that still knows nothing: the open writes, starts and closes
// nothing more, and the person presses Open preview again.
function unknownLook($: $, why: string): WindowOutcome {
  $.ui.toast(`Couldn't tell whether the preview window is open (${why}). Press Open preview again.`)
  return 'done'
}

// A host's profile, taken to start a window on it (`launchLockScript`), so
// another session of this person's can't start one there at the same time.
// One holding it now is waited for briefly (two seconds), then not. Taken,
// it's the open's at once (`lock`), let go however the open ends.
async function takeProfile($: $, open: WindowOpen, dir: string, profile: string): Promise<boolean> {
  const token = randomSecret()
  for (let waited = 0; ; waited += 500) {
    const { code } = await sh($, launchLockScript(dir, profile, token), WINDOW_STEP_MS)
    if (code === 0) {
      open.lock = { profile, token }
      return true
    }
    if (code !== LAUNCH_LOCK_BUSY || waited >= 2_000 || !stillInRoom(open.room, open.s)) return false
    await new Promise<void>(done => $.clock.after(500, done))
  }
}

async function letProfileGo($: $, open: WindowOpen) {
  const lock = open.lock
  if (!lock) return
  open.lock = undefined
  await sh($, launchUnlockScript(lock.profile, lock.token), WINDOW_STEP_MS)
}

// The window's proxy for the open (on the port of the window open on the
// profile: Chrome keeps the flags its first window started with, and
// Firefox read its port as it started), then the page's tunnel and the
// routes to it: what the window reaches. The proxy's port taken, that window
// can't reach anything again: it's closed, and the proxy started anew. Any
// other failure (no Node, a slow start) leaves the window and its tabs: a
// start on another port would fail the same way. A window on another proxy
// port, or of another browser than the one chosen now, is closed for one
// anew. On a host's profile, only the window on this session's port closes.
async function readyProxy($: $, open: WindowOpen): Promise<BrowserProxy | WindowOutcome> {
  const { room, s, page, choice } = open
  const profile = open.profile!
  const onPort = () => (hostProfile(open.name!) ? open.alive?.port ?? undefined : undefined)
  // The room's proxy as it was: one this open finds running serves the
  // windows open already, whatever comes of this page (`idleProxy`).
  open.had = s.children.windowProxy
  let proxy = await windowStep(open, ensureBrowserProxy($, room, open.alive?.port ?? 0, s))
  if ('error' in proxy && proxy.error === 'EADDRINUSE' && open.alive) {
    await windowStep(open, killWindow($, profile, true, onPort()))
    open.alive = null
    proxy = await windowStep(open, ensureBrowserProxy($, room, 0, s))
  }
  // Without Node nothing here opens a forwarded preview (its listeners run
  // under Node too): only the public link, which goes through the room.
  if ('error' in proxy && proxy.error === 'NODE') {
    $.ui.toast('Preview windows need Node on this computer. Install Node, then press Open preview again, or choose Public link in Room → Shown.')
    return 'done'
  }
  if ('error' in proxy) return { failed: "its proxy didn't start" }
  if (open.alive && (open.alive.port !== proxy.port || open.alive.family !== choice.family)) {
    await windowStep(open, killWindow($, profile, true, onPort()))
    // Still closing (Firefox can take a while): a start now would meet it.
    // A look after the close that knows nothing ends the open too.
    const left = await openLook($, open, profile)
    if (left && 'unknown' in left) return unknownLook($, left.unknown)
    if (left) {
      $.ui.toast(WINDOW_CLOSING)
      return 'done'
    }
    open.alive = null
  }
  // Its tunnel starts with the seat's token this session holds now (the
  // window goes on through a reseat, `windowStep`); seated anew meanwhile,
  // what that started (with the old seat's token) stops, and the Open asks
  // to be pressed again.
  const asked = s.token
  const tunnel = await windowStep(open, ensureLocalPreview($, { ...room, token: asked }, s, page, { window: true }))
  const reseated = s.token !== asked
  if (!tunnel.run && reseated && tunnel.made && s.children.listeners.get(page.pid) === tunnel.made) await stopLocalPreview($, page.pid, false, s)
  // The preview's own trouble (its tunnel didn't start here, no Node for
  // it): it would be the same without the window. A proxy this open
  // started, and nothing else, may go with it (`idleProxy`).
  if (!tunnel.run) {
    await idleProxy(open, proxy)
    $.ui.toast(reseated ? RESEATED : tunnel.error ?? 'That preview could not be opened.')
    return 'done'
  }
  await windowStep(open, syncBrowserRoutes($, s))
  return proxy.stopped || s.children.windowProxy !== proxy ? 'done' : proxy
}

// An open that ends without its window: the proxy it started (and with it
// the page's tunnel) goes too when nothing would use it: no window on the
// profile, as the open's look found (a look that knew nothing ends the open
// with everything as it is, `openLook`), none slow to show awaited on it,
// and still the room's. One it found running serves the windows open
// already, and stays, whatever this page's trouble.
async function idleProxy(open: WindowOpen, proxy: BrowserProxy) {
  if (open.alive === null && proxy !== open.had && !proxy.asks.size && open.s.children.windowProxy === proxy) await finishBrowserProxy(proxy)
}

// The browser started on the profile, what it reads as it starts written
// first (never under an open window, which takes the address as it is), or
// the address handed to the window open there; then seen: a process holds
// the profile, or the page reached the proxy. Started isn't open: Linux and
// a bare binary on macOS report a start at once, and a cold first start can
// take ten seconds. Not seen by then isn't failed: a page that reaches the
// proxy later opens it after all (`late`), and nothing else opens it
// meanwhile.
async function launchWindow($: $, open: WindowOpen, proxy: BrowserProxy): Promise<'seen' | WindowOutcome> {
  const { room, s, choice, page, url } = open
  const profile = open.profile!, alive = open.alive, port = proxy.port!
  open.port = port
  // After a definite failure, or the page stopped: what this open started may go.
  const idle = () => idleProxy(open, proxy)
  const fail = async (why: string): Promise<WindowOutcome> => {
    await idle()
    return { failed: why }
  }
  // Firefox on Linux hands an address to its window over the desktop's D-Bus
  // session; without one, a second start meets "Firefox is already running".
  // The address is copied for pasting there instead (Linux Firefox quits
  // with its last window, so an open one has a window to paste into).
  if (alive && choice.family === 'firefox' && choice.platform === 'linux' && !(await windowStep(open, sessionBus($)))) {
    if (pageStopped(open)) return 'done'
    await windowOpened($, open, port)
    const copied = await $.ui.copy({ text: url }).catch(() => ({ isCopied: false }))
    $.ui.toast(copied.isCopied
      ? `${room.host}'s localhost:${page.port} is ready in the ${choice.name} preview window. Its address is copied: paste it into that window's address bar (${url}).`
      : `${room.host}'s localhost:${page.port} is ready in the ${choice.name} preview window: type ${url} into that window's address bar.`)
    return 'opened'
  }
  if (!alive && !(await windowStep(open, windowSettings($, open, port)))) return fail(PROFILE_UNMADE)
  // Stopped as its tunnel came up or its settings were written: the browser
  // isn't started on an address nothing reaches now.
  if (pageStopped(open)) {
    await idle()
    return 'done'
  }
  const argv = launchArgv(choice.platform, choice.browser, choice.family === 'firefox' ? firefoxFlags(profile, url) : chromeFlags(profile, port, choice.platform, url))
  // The page reaching the proxy says the window is there as well as its lock
  // does; listened for from before the start, so a quick one isn't missed.
  const asks: Asked = { port: page.port, seen: false, late: null }
  for (const old of [...proxy.asks].slice(0, Math.max(0, proxy.asks.size - 15))) proxy.asks.delete(old)
  proxy.asks.add(asks)
  let came: 'failed' | 'seen' | 'unseen' | undefined
  try {
    open.launched = true
    const started = await windowStep(open, $.process.run(argv, { timeoutMs: 15_000 }).catch(() => null))
    if (!started || started.exitCode !== 0) came = 'failed'
    else came = (await windowStep(open, windowAppears($, profile, 10_000, () => asks.seen))) || asks.seen ? 'seen' : 'unseen'
  } finally {
    // Listened for no more, unless a window slow to show may still open the page.
    if (came !== 'unseen') proxy.asks.delete(asks)
  }
  if (came === 'failed') return fail(`${choice.name} didn't start`)
  if (came === 'unseen') {
    asks.late = async () => {
      if (!stillInRoom(room, s) || proxy.stopped || s.children.windowProxy !== proxy) return
      await windowOpened($, open, port, !pageStopped(open))
      await $.ui.invalidate('ui.render')
    }
    $.ui.toast(`${choice.name} didn't open a preview window within 10 seconds. ${await windowRemedy($, open.why, true)}`)
    return 'done'
  }
  return 'seen'
}

// What the browser reads as it starts, written before a start: Firefox's
// settings, its proxy's port among them (`firefoxProfileScript`), or
// Chrome's WebRTC setting (`setChromePrefs`).
async function windowSettings($: $, open: WindowOpen, port: number): Promise<boolean> {
  return open.choice.family === 'firefox' ? (await sh($, firefoxProfileScript(open.profile!, port), WINDOW_STEP_MS)).code === 0 : setChromePrefs($, open.profile!)
}

// Open: the window's this session's, on its proxy's port, with the page in
// it. One started now says the first time in the room what it is; and one
// whose browser ignores the proxy flag (an organization's can) never asks
// the proxy for the page, which is said once.
async function announceWindow($: $, open: WindowOpen, proxy: BrowserProxy): Promise<WindowOutcome> {
  const { room, s, choice, page } = open
  // Stopped as the browser started: the window is this session's all the
  // same (looked at, its proxy going with it), but the page isn't said open.
  if (pageStopped(open)) {
    await windowOpened($, open, proxy.port!, false)
    return 'done'
  }
  await windowOpened($, open, proxy.port!)
  if (open.alive) return 'opened'
  // The only browser that could be is the person's default: macOS can hand it links from other apps.
  const links = choice.isDefault ? ` ${choice.name} is your default browser, so links you open in other apps may go to this window while it's open: quit it (⌘Q) when you're done.` : ''
  noteOnce($, 'welcome', `Opened ${room.host}'s localhost:${page.port} in a separate ${choice.name} window. In it, localhost reaches only what ${room.host} shares; your own servers aren't touched.${links}`, s)
  if (!proxy.seen.has(page.port)) {
    const remedy = await windowRemedy($, open.why, false)
    $.clock.after(15_000, () => {
      if (s.children.windowProxy !== proxy || proxy.stopped || proxy.seen.has(page.port)) return
      noteOnce($, 'ignored', `The preview window doesn't seem to use its proxy (a browser your organization manages can ignore it), so it may not reach ${room.host}'s localhost:${page.port}.${remedy ? ` ${remedy}` : ''}`, s)
    })
  }
  return 'opened'
}

// The window this session's, on its proxy's `port`, with the page open in
// it (`withPage`; not a page stopped as it opened): it's looked at every
// 30 s from now.
async function windowOpened($: $, open: WindowOpen, port: number, withPage = true) {
  const { s, key, page } = open
  // What's open in it: what the record had for this same window (profile and port), and the page.
  await update($, previewWindowA, w => (!s.live ? w : { room: key, port, opened: [...new Set([...(w?.room === key && w.port === port && w.profile === open.name ? w.opened : []), ...(withPage ? [page.pid] : [])])], profile: open.name }))
  watchWindow($, s, open.profile!)
}

// An open the room left behind: the window it started (on `port`) closes
// once it's there (its proxy is gone), and with the room left for good, a
// room's profile goes again (the browser may have made it anew after Leave
// removed it). A host's stays for their other rooms.
async function abandonWindow($: $, s: RoomScope, dir: string, profile: string, launched: boolean, port?: number) {
  if (launched && (await windowAppears($, profile, 3_000))) await killWindow($, profile, true, port)
  if (s.ending === 'end' && !hostProfile(profile.slice(profile.lastIndexOf('/') + 1))) await trashProfile($, dir, profile)
}

// Leaving: windows being opened finish first (three seconds at most), so
// what they started is closed before the profile goes.
async function windowsSettled($: $, s: RoomScope, ms: number) {
  const openings = s.window.openings
  if (!openings.size) return
  let timer: Timer | undefined
  await Promise.race([Promise.all([...openings]), new Promise<void>(done => { timer = $.clock.after(ms, done) })])
  timer?.cancel()
}

// While the window is open: looked at every 30 s. Closed, what it used goes,
// and Open preview shows again. A look that fails says nothing: three in a
// row, and the window counts as gone. The room closing stops the looks.
function watchWindow($: $, s: RoomScope, profile: string) {
  s.window.stopWatching()
  if (!s.live) return
  s.window.watch = $.clock.every(30_000, () => void checkWindow($, s, profile).catch(() => {}))
}

async function checkWindow($: $, s: RoomScope, profile: string) {
  const w = await read($, previewWindowA), win = s.window
  if (!s.live || s.mode !== 'guest' || w?.room !== s.key) return void win.stopWatching()
  const seen = await windowProbe($, profile)
  if (!s.live || (seen === undefined && ++win.misses < 3)) return
  if (seen && seen.port === w.port) {
    win.misses = 0
    return
  }
  win.stopWatching()
  // Three looks that failed can't tell it's gone: this session's window, if
  // it's still up on its port, closes before that port is forgotten (as the
  // proxy's end closes it, `runBrowserProxy`; this write may come first).
  if (seen === undefined && w.port && (await killWindow($, profile, true, w.port)) && s.live) $.ui.toast(windowLost((await read($, roomA))?.host ?? 'the host'))
  const proxy = s.children.windowProxy
  if (proxy) await finishBrowserProxy(proxy)
  // Its port is no window of this session's any more (`openWindow`).
  await update($, previewWindowA, x => (s.live && x?.room === s.key ? { ...x, port: 0, opened: [] } : x))
}

// A reload keeps the window (and $.state its proxy's port), not the proxy:
// it comes back on that same port, never opening a browser. Taken meanwhile,
// the window can't be reached again: it's closed, and said.
async function restorePreviewWindow($: $) {
  const s = scope, room = await read($, roomA), w = await read($, previewWindowA)
  if (!room || !stillInRoom(room, s) || s.mode !== 'guest' || !w || w.room !== roomIdentity(room)) return
  const { profile, name } = await profileOf($, room)
  const alive = await windowProbe($, profile)
  if (!stillInRoom(room, s)) return
  // Closed meanwhile: its port is no window of this session's any more. A
  // look that failed can't tell: the window is taken to be there still, on
  // its own port, and the looks from now on settle it (`checkWindow`).
  if (alive === null || (alive === undefined && !w.port)) return void (await update($, previewWindowA, x => (s.live && x?.room === w.room ? { ...x, port: 0, opened: [] } : x)))
  const proxy = alive === undefined || alive.port === w.port ? await ensureBrowserProxy($, room, w.port, s) : { error: 'MOVED' }
  if (!stillInRoom(room, s)) return
  if ('error' in proxy) {
    // On a host's profile, a window on another port is another session's:
    // left open, and nothing said (this session's own window is gone).
    const another = proxy.error === 'MOVED' && hostProfile(name)
    const closed = !another && (await killWindow($, profile, false, hostProfile(name) ? w.port : undefined))
    await update($, previewWindowA, x => (s.live && x?.room === w.room ? { ...x, port: 0, opened: [] } : x))
    // Nor where a look that failed took one to be there and there was none to close.
    if (another || (alive === undefined && !closed)) return
    $.ui.toast(proxy.error === 'EADDRINUSE' ? `The preview window closed: its proxy's port (${w.port}) was taken while the plugin reloaded. Press Open preview to open it again.` : "The preview window closed: its proxy couldn't start again. Press Open preview to open it again.")
    return
  }
  watchWindow($, s, profile)
}

// Leaving the room for good: the window closes, and a room's profile (its
// sign-ins and cookies) goes, out of the way at once and removed behind. A
// host's stays for their other rooms, and its window closes only if it's
// this session's (on its proxy port). `wait`: until the window's gone (up to
// 3 s), which a session's end has no time for.
async function endPreviewWindow($: $, room: { server: string; id: string }, saved?: { profile?: string; port?: number }, wait = true) {
  const { dir, profile, name } = await profileOf($, room, saved?.profile)
  if (hostProfile(name)) {
    if (saved?.port) await killWindow($, profile, wait, saved.port)
    return
  }
  await killWindow($, profile, wait)
  await trashProfile($, dir, profile)
}

// A profile moved out of the way at once, and removed behind.
async function trashProfile($: $, dir: string, profile: string) {
  await sh($, trashScript(dir, profile, randomSecret().slice(0, 12)), WINDOW_STEP_MS)
}

// At start: trash left over, and profiles of a day ago whose window is gone
// (rooms last a day), never the one of the room this session is in.
async function gcPreviewProfiles($: $) {
  const dir = await browserDirOf($)
  if (!(await $.fs.exists(dir).catch(() => false))) return
  const room = await read($, roomA)
  const keep = room && (await read($, modeA)) === 'guest' ? (await profileOf($, room)).name : ''
  await sh($, gcScript(dir, keep), WINDOW_STEP_MS)
}

// What a joined place keeps of its window: the profile is the room's while
// the place lasts (a 0 port: made, its proxy never started), the tunnels the
// host refused stay refused until the person's own Open, and the ports
// already asked about stay asked. What the host forwards goes in its Shown.
async function windowCheckpoint($: $, room: ShareRoom): Promise<Pick<Joined, 'previewWindow' | 'previewNeedsOpen' | 'needAsked'>> {
  const key = roomIdentity(room)
  const w = await read($, previewWindowA), refused = await read($, previewNeedsOpenA), asked = await read($, needAskedA)
  return {
    ...(w?.room === key ? { previewWindow: { port: w.port, ...(w.profile ? { profile: w.profile } : {}) } } : {}),
    ...(refused.length ? { previewNeedsOpen: refused.slice(-64) } : {}),
    ...(asked?.ports.length ? { needAsked: asked.ports.slice(-256) } : {}),
  }
}

async function setPreviewOpen($: $, value: string) {
  await $.store.set(PREVIEW_OPEN_KEY, value === 'pane' || value === 'browser' || value === 'window' ? value : (await isDesktop($)) ? 'pane' : 'browser')
  await $.ui.invalidate('ui.render')
}

// ---------------------------------------------------------------------------
// Host: what a shared preview needs beside it. A page on localhost:3000 often
// calls another server its project runs (an API, a backend on 3610), which a
// guest's window can reach only if the host shares it too. Discovery
// (relay/discover.cjs) finds the web servers whose process runs in the same
// project as the shared port's, and the host is asked in the row above the
// prompt. Nothing is shared without the host's press: what discovery finds,
// and what a guest's window asks for, are only suggestions.

type HostAnswer = 'yes' | 'no' | 'later'
type HostAskItem = { ask: ShareHostAsk; key: string; resolve: (answer: HostAnswer) => void }
const hostAskQueue: HostAskItem[] = []
// The question on screen (or about to be), answered only by its own id: a
// second press, or one for a question gone, answers nothing else.
let hostAskActive: { id: string; answer: (answer: HostAnswer) => void; yes?: string } | null = null
let hostAskRunning = false
// Ports a question is being made about now: a look, then the question,
// until it's answered or goes. A question waits behind up to three others,
// ten minutes each, longer than `askedAt` keeps its port from being asked
// about again (`claimAsks`), so this is what keeps it from being asked twice.
const hostAsking = new Set<string>()

// The room's, kept through a reload (and cleared with the room): ports the
// host said Not now to or stopped, and when each was last asked about.
// `stopped` apart from `declined`: Not now to a question about forwarding is
// no Stop of a page's link. A yes forwards the port, which no question asks
// about; one that couldn't forward is asked about again ten minutes on.
const NO_MEMORY: ShareHostMemory = { declined: [], stopped: [], askedAt: {} }

async function hostMemoryOf($: $, room: ShareRoom): Promise<ShareHostMemory> {
  const memory = stillInRoom(room, scope) ? await read($, hostMemoryA) : null
  return memory ? { ...memory, stopped: memory.stopped ?? [] } : NO_MEMORY
}

async function rememberHost($: $, room: ShareRoom, change: (memory: ShareHostMemory) => ShareHostMemory) {
  const s = scope
  if (!stillInRoom(room, s)) return
  await update($, hostMemoryA, m => {
    if (!s.live) return m
    const next = change(m ? { ...m, stopped: m.stopped ?? [] } : NO_MEMORY)
    return { declined: [...new Set(next.declined)].slice(-256), stopped: [...new Set(next.stopped)].slice(-256), askedAt: Object.fromEntries(Object.entries(next.askedAt).slice(-256)) }
  })
}

const declinePorts = ($: $, room: ShareRoom, ports: number[]) => rememberHost($, room, m => ({ ...m, declined: [...m.declined.filter(p => !ports.includes(p)), ...ports] }))
// Stopped by the host: asked about no more, and its link not shared again
// for Claude's mention (`shareLocal`, a reopened session's look back too).
const stopPorts = ($: $, room: ShareRoom, ports: number[]) =>
  rememberHost($, room, m => ({ ...m, declined: [...m.declined.filter(p => !ports.includes(p)), ...ports], stopped: [...m.stopped.filter(p => !ports.includes(p)), ...ports] }))
// Shared again on purpose (`hostForwards`): asked about again, and shared
// again for Claude's mention.
const undeclinePorts = ($: $, room: ShareRoom, ports: number[]) => rememberHost($, room, m => ({ ...m, declined: m.declined.filter(p => !ports.includes(p)), stopped: m.stopped.filter(p => !ports.includes(p)) }))
const askedLately = (memory: ShareHostMemory, port: number, now: number) => now - (memory.askedAt[String(port)] ?? -Infinity) < 10 * 60_000

// Of these ports, those to ask about now (not declined, and not asked about
// in the last ten minutes), marked asked in the same write: two asks at
// once never both get a port.
async function claimAsks($: $, room: ShareRoom, ports: readonly number[]): Promise<number[]> {
  const now = await $.clock.now(), s = scope
  if (await isRunner($)) ports = ports.filter(p => p !== RUNNER_PORT)
  let claimed: number[] = []
  await rememberHost($, room, m => {
    claimed = ports.filter(p => !m.declined.includes(p) && !askedLately(m, p, now))
    // The newest last: what the record keeps of 256.
    const rest = Object.entries(m.askedAt).filter(([p]) => !claimed.includes(Number(p)))
    return { ...m, askedAt: Object.fromEntries([...rest, ...claimed.map(p => [String(p), now] as const)]) }
  })
  return s.live ? claimed : []
}

// A saved room's memory, checked: only what was saved with that room's name.
function hostMemorySaved(value: unknown, key: string): ShareHostMemory | null {
  const m = value as Partial<ShareHostMemory & { room: string }> | null
  if (!m || typeof m !== 'object' || m.room !== key) return null
  const ports = (list: unknown) => (Array.isArray(list) ? list.filter(validPort).slice(-256) : [])
  const askedAt = m.askedAt && typeof m.askedAt === 'object' ? Object.fromEntries(Object.entries(m.askedAt).filter(([p, t]) => validPort(Number(p)) && Number.isFinite(t)).slice(-256)) : {}
  return { declined: ports(m.declined), stopped: ports(m.stopped), askedAt }
}

// Only where something draws the row (a plain -p run draws nothing), or on
// a cloud host, whose questions go to its approver (`pumpHostAsks`).
async function canAskHost($: $): Promise<boolean> {
  if (await isRunner($)) return true
  return (await $.session.surfaces().catch(() => [] as readonly RenderSurface[])).length > 0
}

// A cloud host's container holds its runner's control port (cloud/runner.mjs,
// HOST_PORT in server/worker.mjs): never asked about or shared from there.
const RUNNER_PORT = 8080
const runnerOwn = async ($: $, port: number) => port === RUNNER_PORT && (await isRunner($))

const forwardedPort = async ($: $, port: number) => Boolean((await read($, sharesA))[String(port)]?.tcp)

// One question at a time (three more wait, at most), below a teammate's tool
// approval; unanswered in ten minutes, it goes.
function askHost($: $, room: ShareRoom, ask: Omit<ShareHostAsk, 'id'>, id = newId()): Promise<HostAnswer> {
  if (hostAskQueue.length >= 3) return Promise.resolve('later')
  return new Promise<HostAnswer>(resolve => {
    hostAskQueue.push({ ask: { ...ask, id }, key: roomIdentity(room), resolve })
    void pumpHostAsks($).catch(() => {})
  })
}

function answerHostAsk(id: string, answer: HostAnswer) {
  if (hostAskActive?.id === id) hostAskActive.answer(answer)
}

async function pumpHostAsks($: $) {
  if (hostAskRunning) return
  hostAskRunning = true
  // A cloud host draws nothing: its approver is asked through the room, and
  // their answer comes back as the room's `answer` (`settleCloudAnswer`).
  const runner = await isRunner($)
  try {
    for (let item = hostAskQueue.shift(); item; item = hostAskQueue.shift()) {
      const current = item
      const here = async () => {
        const room = await read($, roomA)
        return Boolean(room && roomIdentity(room) === current.key && (await read($, modeA)) === 'host')
      }
      if (!(await here())) {
        current.resolve('later')
        continue
      }
      let answer!: (answer: HostAnswer) => void
      const answered = new Promise<HostAnswer>(done => { answer = done })
      // Known before it shows: Stop sharing, or a new room, answers it at once.
      hostAskActive = { id: current.ask.id, answer, ...(runner ? { yes: hostAskYes(current.ask) } : {}) }
      const timer = $.clock.after(10 * 60_000, () => answer('later'))
      let result: HostAnswer = 'later'
      try {
        if (runner) send($, 'ask', approverAsk(current.ask))
        else await update($, hostAskA, () => current.ask)
        if (!(await here())) answer('later')
        result = await answered
      } finally {
        timer.cancel()
        if (hostAskActive?.id === current.ask.id) hostAskActive = null
        // Unanswered (its ten minutes, the room's end): taken back, off the approver's list.
        if (runner && result === 'later') send($, 'ask', { id: current.ask.id, done: true })
        if (!runner) await update($, hostAskA, a => (a?.id === current.ask.id ? null : a)).catch(() => {})
        current.resolve(result)
      }
    }
  } finally {
    hostAskRunning = false
    for (const item of hostAskQueue.splice(0)) item.resolve('later')
  }
}

function clearHostAsks() {
  hostAskActive?.answer('later')
  for (const item of hostAskQueue.splice(0)) item.resolve('later')
}

// A question about this machine's localhost as a cloud host puts it to its
// approver (`ask`, by its kind): what a yes shares, the guest whose window
// asked, and its two answers, the host's own row's. The approver words it
// from these (`cloudHostWords`).
const approverAsk = (ask: ShareHostAsk) => ({
  id: ask.id,
  kind: ask.kind,
  port: ask.port,
  ...(ask.label ? { label: ask.label } : {}),
  who: ask.who ?? '',
  related: ask.related,
  options: [hostAskYes(ask), 'Not now'],
})

// One question to the host about ports claimed for it (`claimAsks`) and held
// meanwhile by its caller (`hostAsking`): Not now declines them for the
// room; a yes forwards them (`forward`), and what that came to is said. A
// cloud host's approver hears it through the room: the question's ports
// shared now (through the link, or forwarded), and those that couldn't be,
// as its shares say, whatever the yes said (`takeCloudAsk`).
// `asked`: once the question is in the row, or waiting for it.
async function offer($: $, room: ShareRoom, ask: Omit<ShareHostAsk, 'id'>, ports: readonly number[], forward: () => Promise<{ shared: number[]; refused: string[] }>, asked?: () => void): Promise<HostAnswer> {
  const id = newId()
  const answering = askHost($, room, ask, id)
  asked?.()
  const answer = await answering
  if (!hostHere(room)) return 'later'
  if (answer === 'no') await declinePorts($, room, [...ports])
  if (answer !== 'yes') return answer
  const { shared, refused } = await forward()
  if ((shared.length || refused.length) && hostHere(room)) $.ui.toast([...(shared.length ? [forwardedSaid(shared)] : []), ...refused].join(' '))
  if ((await isRunner($)) && hostHere(room)) {
    const now = await read($, sharesA)
    const done = ports.filter(p => (ask.kind === 'show' ? Boolean(now[String(p)]) : Boolean(now[String(p)]?.tcp)))
    send($, 'ask', { id, done: true, kind: ask.kind, shared: done, failed: ports.filter(p => !done.includes(p)) })
  }
  return answer
}

// What discovery found for a shared port: its own service, and the web
// servers beside it in the same project. Nothing when it can't tell. What's
// shared already isn't offered again, a page shared through its link too (it
// keeps its role, never made another page's dependency): 64 of those go to
// discovery (all it takes), the rest are left out of what it found after.
async function discoverPort($: $, port: number, deadlineMs = 8_000): Promise<Discovered | null> {
  const shared = Object.keys(await read($, sharesA)).map(Number).filter(p => validPort(p) && p !== port)
  const exclude = [...((await isRunner($)) ? [RUNNER_PORT] : []), ...shared].slice(-64)
  let child: Child | undefined
  let timer: Timer | undefined
  try {
    child = $.process.spawn({ argv: ['/bin/sh', '-c', FIND_NODE, 'sh', `${$.plugin.root}/relay/discover.cjs`], input: JSON.stringify({ port, pluginRoot: $.plugin.root, exclude, deadlineMs }) })
    const running = child
    timer = $.clock.after(deadlineMs + 2_000, () => void running.return(undefined as never).catch(() => {}))
    // Its one line: what it found. A line past the bound throws, and is nothing found.
    for await (const line of helperLines(running)) {
      const found = discoverResult(line)
      if (!found || (found.target && found.target.port !== port)) return null
      return { ...found, related: found.related.filter(s => s.port !== port && !shared.includes(s.port)) }
    }
    return null
  } catch {
    return null
  } finally {
    timer?.cancel()
    try { await child?.return(undefined as never) } catch {}
  }
}

// Whether one of this plugin's own helpers holds a localhost port on this
// computer (discover.cjs's owner mode: this user's listeners on the port, any
// family, by their commands): most likely a guest's listener for another
// shared session's preview, which that session's Open forwarded here, or a
// preview window's proxy. Such a port is never shared on: its host agreed
// to the people in their own room, not to this one's. True: a helper holds
// it. False: something else does, or nothing. Undefined: it can't tell (no
// Node, a platform discovery doesn't read, the helper failing or out of
// time, its listing or a holder's command unread), and the port is shared
// as before: the guard fails open. Kept in this module's memory by port, a
// yes for 30 s (a guest's listener lasts as long as their Open), anything
// else 5 s at a share and 1 s at a teammate's connection (`noMs`, so an Open
// that took the number just after a look is seen), a look under way shared,
// so a burst of connections asks once.
const RELAYED_LOOK_MS = 2_000
const RELAYED_YES_MS = 30_000
const RELAYED_NO_MS = 5_000
const RELAYED_NOW_MS = 1_000
const RELAYED_KEPT = 64
const relayedSeen = new Map<number, { at: number; answer?: boolean; done: boolean; look: Promise<boolean | undefined> }>()
async function relayedHere($: $, port: number, noMs = RELAYED_NO_MS): Promise<boolean | undefined> {
  if (!validPort(port)) return undefined
  const now = await $.clock.now(), seen = relayedSeen.get(port)
  if (seen && (!seen.done || now - seen.at < (seen.answer === true ? RELAYED_YES_MS : noMs))) return seen.look
  const entry: { at: number; answer?: boolean; done: boolean; look: Promise<boolean | undefined> } = { at: now, done: false, look: Promise.resolve(undefined) }
  entry.look = ownerLook($, port).then(line => {
    const answer = line === null ? undefined : relayedResult(line, port)
    entry.answer = answer
    entry.done = true
    return answer
  })
  relayedSeen.delete(port)
  relayedSeen.set(port, entry)
  for (const old of relayedSeen.keys()) if (relayedSeen.size > RELAYED_KEPT) relayedSeen.delete(old)
  return entry.look
}

// One owner-mode look: its one line, within its deadline and two seconds
// more, or null. `web`: a guest's need's, at the port's answer too.
async function ownerLook($: $, port: number, web = false): Promise<string | null> {
  let child: Child | undefined
  let timer: Timer | undefined
  try {
    child = $.process.spawn({ argv: ['/bin/sh', '-c', FIND_NODE, 'sh', `${$.plugin.root}/relay/discover.cjs`], input: JSON.stringify({ port, pluginRoot: $.plugin.root, owner: true, deadlineMs: RELAYED_LOOK_MS, ...(web ? { web: true } : {}) }) })
    const running = child
    timer = $.clock.after(RELAYED_LOOK_MS + 2_000, () => void running.return(undefined as never).catch(() => {}))
    for await (const line of helperLines(running)) return line
    return null
  } catch {
    return null
  } finally {
    timer?.cancel()
    try { await child?.return(undefined as never) } catch {}
  }
}

// The host's word for a port it can't share on, as /share-preview says it.
const relayedSaid = (port: number) => `localhost:${port} is another shared session's preview forwarded to this computer, so it can't be shared on.`
// A share the host asked for that isn't made, and why.
type ShareRefused = { refused: string }

// Host, at a teammate's connection: a port shared before that one of the
// plugin's helpers holds now (the host's own server stopped, and an Open of
// another session's preview took the number). Refused, and said once a port
// a room; the share stays, the host's to Stop.
async function relayedNow($: $, s: RoomScope, port: number): Promise<boolean> {
  if ((await relayedHere($, port, RELAYED_NOW_MS)) !== true) return false
  $.ui.log(`localhost:${port} is held by a shared session's own helper: teammates' connections to it are refused`, { to: 'debug' })
  noteOnce($, `relayed-${port}`, `Teammates' connections to localhost:${port} are refused: it's another shared session's preview forwarded to this computer now, so it can't be shared on. Stop it in Room → Shown.`, s)
  return true
}

// Host: a port forwarded on the host's own say: /share-preview, Allow
// forwarding, Allow for a port Claude's mention shared, Share too for what a
// page uses, Share for a guest's window's need. Here, and only here, a Not
// now or a Stop of it before no longer stands. Its preview is made with
// `tcp` (`ensurePreview`), and its page goes out at the host's own address
// (its host name, scheme and page). `dependency`: shared for another page's
// sake (the host port of the page that uses it, or true when that isn't
// known), so a guest's Open preview never picks it. A port another
// session's preview holds here (`relayedHere`) isn't
// shared: `refused` says why. With `offerRelated`, discovery's deadline: what the page uses beside
// it is looked for and offered in the row above the prompt
// (`offerRelated`), and `related` says what was put to the host and what
// was left out.
type ForwardPage = { port: number; title: string; path?: string; host?: PreviewHost; scheme?: 'https'; dependency?: number | true }
async function hostForwards($: $, room: ShareRoom, page: ForwardPage, opts: { offerRelated?: number } = {}): Promise<{ pid: string; related: Promise<RelatedOffer> } | ShareRefused | null> {
  const s = scope
  // Another session's preview forwarded here: nothing is shared, and a Not now or a Stop of it stands.
  if (await relayedHere($, page.port)) return { refused: relayedSaid(page.port) }
  if (!sameRoom(room, s)) return null
  await undeclinePorts($, room, [page.port])
  const share = await ensurePreview($, room, page.port, page.title, { tcp: true, ...(page.host ? { host: page.host } : {}), ...(page.scheme ? { scheme: page.scheme } : {}), ...(page.dependency !== undefined ? { dependency: page.dependency } : {}) })
  if (!share || !sameRoom(room, s)) return null
  send($, 'artifact', { kind: 'preview', pid: share.pid, port: page.port, title: page.title, path: page.path ?? '/', ...sharedAs(share) })
  const deadline = opts.offerRelated
  const related: Promise<RelatedOffer> =
    deadline === undefined ? Promise.resolve(NO_OFFER) : discoverPort($, page.port, deadline).then(found => (found?.related.length ? offerRelated($, room, page.port, found.related) : NO_OFFER))
  return { pid: share.pid, related }
}

// A Shown entry's title: as its artifact gave it, else its name without
// what Shown adds to it.
const shownTitle = (item: ShareShown) => (typeof item.title === 'string' && item.title ? item.title : item.name.replace(/ \(preview\)$| · used by (?:previews|localhost:\d+)$/, ''))

// Host: a port forwarded for a page's sake (`dependency`: that page's host
// port, or true for a guest's window), as Share too and a guest's need do.
// One shared already through its link (a page Claude mentioned or opened)
// keeps its role: forwarded as that page, its title, page, address and
// scheme as they were, never marked a dependency, so a guest's Open
// preview still opens it.
async function forwardFor($: $, room: ShareRoom, port: number, label: string, dependency: number | true): Promise<string | ShareRefused | null> {
  const share = (await read($, sharesA))[String(port)]
  const page = share ? (await read($, shownA)).find(s => s.kind === 'preview' && s.pid === share.pid) : undefined
  const forwarded = !share
    ? await hostForwards($, room, { port, title: dependencyTitle(port, label), host: 'localhost', dependency })
    : await hostForwards($, room, { port, title: page ? shownTitle(page) : `localhost:${port}`, path: page?.path ?? '/', host: page?.host, scheme: page?.scheme ?? share.scheme, ...(page?.dependency !== undefined ? { dependency: page.dependency } : {}) })
  return !forwarded ? null : 'refused' in forwarded ? forwarded : forwarded.pid
}

// What the page on `entry` uses beside it, shared for it. A port already
// forwarded (as a page of its own, say) stays as it is; one shared through
// its link keeps its role (`forwardFor`). `refused`: why one wasn't
// (another session's preview holds it here).
async function shareRelated($: $, room: ShareRoom, related: readonly { port: number; label: string }[], entry: number): Promise<{ shared: number[]; refused: string[] }> {
  const shared: number[] = [], refused: string[] = []
  for (const s of related.slice(0, 6)) {
    if (await forwardedPort($, s.port)) continue
    const forwarded = await forwardFor($, room, s.port, s.label, entry)
    if (typeof forwarded === 'string') shared.push(s.port)
    else if (forwarded) refused.push(forwarded.refused)
  }
  return { shared, refused }
}

const portList = (ports: number[]) => everyName(ports.map(p => `localhost:${p}`))
const hostHere = (room: ShareRoom) => sameRoom(room, scope) && scope.mode === 'host'

// The host's word once ports are forwarded: which, and where to stop them.
// Never where teammates open them: Claude's browser, their own or a
// separate window is each teammate's own setting.
const forwardedSaid = (ports: number[]) => `Teammates can reach ${portList(ports)} now. Stop ${ports.length > 1 ? 'them' : 'it'} in Room → Shown.`

// What the servers a page uses beside it came to: the questions put to the
// host in the row above the prompt (the first there now, the rest in turn),
// each with the ports it names, and the ports left out, by a Not now in this
// room or because they can't be asked about now (asked about lately, being
// asked about already, the row full, nothing here to draw it).
// /share-preview's reply says it (`relatedSaid`).
type RelatedOffer = { asked: DiscoveredService[][]; left: { service: DiscoveredService; declined: boolean }[] }
const NO_OFFER: RelatedOffer = { asked: [], left: [] }

// After /share-preview, Allow forwarding or a mention's Allow: the servers
// its page uses too, asked about a service a question (`servicesOf`: one
// process, so a backend on two ports is one question), and one on more
// than ASK_PORTS ports in questions of that many, one after another
// (`questionsOf`): a yes forwards just the ports its row names, every one
// first (`shareTooWords`: a row too narrow cuts the label and the page,
// never a port it forwards). Each port is claimed as its question is made,
// and looked at again then: one forwarded since, said Not now to meanwhile
// (another question about it) or asked about lately is left out of that
// question. Not now: none of its ports is asked about again in this room,
// until shared on purpose, and the next question is asked; unanswered (or
// the row full), the rest wait for another time; a yes that couldn't
// forward, not again for ten minutes. Settles once the first question is in
// the row (or none can be).
function offerRelated($: $, room: ShareRoom, port: number, related: readonly DiscoveredService[]): Promise<RelatedOffer> {
  let said!: (offer: RelatedOffer) => void
  const offered = new Promise<RelatedOffer>(done => { said = done })
  void askRelated($, room, port, related, said).catch(() => {}).finally(() => said(NO_OFFER))
  return offered
}

async function askRelated($: $, room: ShareRoom, port: number, related: readonly DiscoveredService[], said: (offer: RelatedOffer) => void) {
  const key = roomIdentity(room), flight = (s: DiscoveredService) => `${key} ${s.port}`
  const memory = await hostMemoryOf($, room), now = await $.clock.now()
  const left: RelatedOffer['left'] = []
  const leave = (list: readonly DiscoveredService[], declined = false) => void left.push(...list.map(service => ({ service, declined })))
  let ask: DiscoveredService[] = []
  for (const s of related) {
    if (s.port === port || [...ask, ...left.map(l => l.service)].some(x => x.port === s.port) || (await forwardedPort($, s.port))) continue
    if (memory.declined.includes(s.port)) leave([s], true)
    else ask.push(s)
  }
  if (!ask.length || !hostHere(room) || !(await canAskHost($))) return said({ asked: [], left: [...left, ...ask.map(service => ({ service, declined: false }))] })
  // Held from here, each until it's answered: no other question takes one
  // while it waits its turn. One asked about lately, or being asked about
  // already, is left.
  leave(ask.filter(s => askedLately(memory, s.port, now) || hostAsking.has(flight(s))))
  ask = ask.filter(s => !left.some(l => l.service === s))
  const held = new Set(ask.map(flight))
  for (const f of held) hostAsking.add(f)
  const release = (s: DiscoveredService) => void (held.delete(flight(s)) && hostAsking.delete(flight(s)))
  let told = false
  const tell = (asked: DiscoveredService[][]) => {
    if (!told) said({ asked, left })
    told = true
  }
  const questions = questionsOf(servicesOf(ask))
  try {
    for (const [i, question] of questions.entries()) {
      if (!hostHere(room)) break
      const open: DiscoveredService[] = []
      for (const s of question) {
        if (await forwardedPort($, s.port)) release(s)
        else open.push(s)
      }
      if (!open.length) continue
      // Three questions waiting already: the rest wait for another time.
      if (hostAskQueue.length >= 3) {
        if (!told) leave([open, ...questions.slice(i + 1)].flat())
        break
      }
      const claimed = await claimAsks($, room, open.map(s => s.port))
      const asking = open.filter(s => claimed.includes(s.port))
      const out = open.filter(s => !asking.includes(s))
      if (out.length) {
        const declined = (await hostMemoryOf($, room)).declined
        if (!told) for (const s of out) leave([s], declined.includes(s.port))
        for (const s of out) release(s)
      }
      if (!asking.length) continue
      if (!hostHere(room)) break
      if (hostAskQueue.length >= 3) {
        if (!told) leave([asking, ...questions.slice(i + 1)].flat())
        break
      }
      const ask = { kind: 'related' as const, port, related: asking.map(s => ({ port: s.port, label: s.label })) }
      const answer = await offer($, room, ask, asking.map(s => s.port), () => shareRelated($, room, asking, port), () => tell([asking, ...questions.slice(i + 1)]))
      for (const s of asking) release(s)
      if (!hostHere(room) || (answer !== 'yes' && answer !== 'no')) break
    }
  } finally {
    for (const s of ask) release(s)
    tell([])
  }
}

// /share-preview's word on what its page uses too: what it found, by
// service, and the questions the row above the prompt asks about it, as the
// row asks them (a service on more ports than a question holds, in turn);
// and how to share what it doesn't ask about.
function relatedSaid({ asked, left }: RelatedOffer): string {
  if (!asked.length && !left.length) return ''
  const one = (count: number, it: string, them: string) => (count > 1 ? them : it)
  const inRow = ` too from the row above the prompt${asked.length > 1 ? ', one at a time' : ''}`
  // A question a service: "share it", "share them"; a service asked about
  // in several, each question named.
  const split = asked.length > servicesOf(asked.flat()).length
  if (!left.length && !split) return ` It looks like it also uses ${alsoUses(asked.flat())}: share ${one(asked.length, 'it', 'them')}${inRow}.`
  const ports = (list: readonly DiscoveredService[]) => portList(list.map(s => s.port))
  const commands = (list: readonly DiscoveredService[]) => everyName(list.map(s => `/share-preview ${s.port}`))
  const declined = left.filter(l => l.declined).map(l => l.service), other = left.filter(l => !l.declined).map(l => l.service)
  const found = [...asked.flat(), ...left.map(l => l.service)].sort((a, b) => a.port - b.port)
  return [
    ` It looks like it also uses ${alsoUses(found)}.`,
    asked.length ? ` Share ${everyService(asked, false)}${inRow}.` : '',
    declined.length ? ` You said Not now to ${ports(declined)} in this room; to share ${one(declined.length, 'it', 'them')}, use ${commands(declined)}.` : '',
    other.length ? ` To share ${ports(other)} too, use ${commands(other)}.` : '',
  ].join('')
}

// Claude mentioned or opened a port, shared as a page through its link: with
// guests here, the host is asked whether they may open it at the same
// address (forwarded to their own localhost). Allow forwards that port
// alone; what it uses beside it is asked about after, a service a question
// (`offerRelated`). Not now: never again in this room, until the host
// shares it on purpose; unanswered (or with the row full), or a yes that
// couldn't forward, not again for ten minutes.
async function offerSameAddress($: $, room: ShareRoom, port: number, path: string, host?: PreviewHost, scheme?: 'https') {
  const flight = `${roomIdentity(room)} ${port}`
  if (hostAsking.has(flight) || (await forwardedPort($, port))) return
  if (!(await read($, peopleA)).some(p => p.role === 'guest' && p.online) || !(await canAskHost($)) || hostAsking.has(flight)) return
  hostAsking.add(flight)
  let beside: readonly DiscoveredService[] = []
  try {
    if (!(await claimAsks($, room, [port])).length) return
    const found = await discoverPort($, port)
    if (found?.target && (found.target.web === 'no' || found.target.devtools)) return
    let allowed = false
    await offer($, room, { kind: 'mention', port, ...(found?.target?.label ? { label: found.target.label } : {}), related: [] }, [port], async () => {
      const forwarded = await hostForwards($, room, { port, title: `localhost:${port}`, path, host, scheme })
      allowed = Boolean(forwarded && 'pid' in forwarded)
      return allowed ? { shared: [port], refused: [] } : { shared: [], refused: [(forwarded && 'refused' in forwarded && forwarded.refused) || `Couldn't allow forwarding localhost:${port}`] }
    })
    if (allowed && hostHere(room)) beside = found?.related ?? []
  } finally {
    hostAsking.delete(flight)
  }
  if (beside.length) void offerRelated($, room, port, beside)
}

// A guest's preview window asked for a localhost port nobody shared. Asked
// only about a web server (never a debugging port), with the host's say:
// once in ten minutes a port, never after Not now or Stop, never with what
// Claude shows kept to the host, and only where the row draws. One look at
// the port first, two seconds at most (`ownerLook` with `web`: who holds
// it, and what it answers); another session's preview held here is never
// put to the host, nor counted asked.
async function hostNeed($: $, room: ShareRoom, need: Record<string, unknown>) {
  const port = Number(need.port)
  const who = cleanLabel(need.name, 40) || 'A guest'
  const flight = `${roomIdentity(room)} ${port}`
  if (!validPort(port) || !hostHere(room) || hostAsking.has(flight)) return
  if ((await read($, policyA)).files === 'off' || (await forwardedPort($, port))) return
  const memory = await hostMemoryOf($, room), now = await $.clock.now()
  if (memory.declined.includes(port) || askedLately(memory, port, now) || hostAsking.has(flight) || !(await canAskHost($))) return
  hostAsking.add(flight)
  try {
    const line = await ownerLook($, port, true)
    const target = line === null ? null : heldResult(line, port)
    if (target?.relay === true || !hostHere(room) || !(await claimAsks($, room, [port])).length) return
    if (!target || target.web === 'no' || target.devtools || !hostHere(room)) return
    await offer($, room, { kind: 'need', port, who, ...(target.label ? { label: target.label } : {}), related: [] }, [port], async () => {
      if (await forwardedPort($, port)) return { shared: [], refused: [] }
      // For a page of the guest's window, which one the need doesn't say;
      // a page shared through its link stays that page (`forwardFor`).
      const pid = await forwardFor($, room, port, target.label, true)
      return typeof pid === 'string' ? { shared: [port], refused: [] } : { shared: [], refused: [pid?.refused ?? `Couldn't share localhost:${port}`] }
    })
  } finally {
    hostAsking.delete(flight)
  }
}

// The row above the prompt's words for a question. A yes forwards just what
// it names: the ports (three at most) of the service a page uses beside it,
// every one first, so a row too narrow cuts what runs there and the page,
// never a port ("Share localhost:3510 and 3511 too? convex-local-backend,
// beside localhost:3009"); or the port mentioned or needed itself. A
// question is one service's (`askRelated`): its ports aren't regrouped.
const hostAskYes = (ask: ShareHostAsk) => (ask.kind === 'related' ? 'Share too' : ask.kind === 'mention' ? 'Allow' : 'Share')

function hostAskWords(ask: ShareHostAsk): string {
  if (ask.kind === 'related') return shareTooWords(ask.port, ask.related)
  if (ask.kind === 'mention') return `Let guests open localhost:${ask.port} at the same address?`
  if (ask.kind === 'show') return `Share ${serviceName({ port: ask.port, label: ask.label })} with the room?`
  return `${ask.who ?? 'A guest'}'s preview needs ${serviceName({ port: ask.port, label: ask.label })}`
}

// Guest: the Room panel's Open (and Open preview above the prompt), outside
// any turn. A forwarded preview opens at the host's own address
// (http://localhost:3000), so its sign-ins, cookies and calls to the API
// beside it work as on the host's machine:
// - forwarded at the same numbers here, when the page's port and those it
//   uses beside it (what the host shared for it, `dependency`) are all free
//   on this computer: in Claude's browser in Claude Desktop, else (or as the
//   person chose) their own browser (`showPage`);
// - else in a separate window, whose localhost reaches only what the host
//   shares (relay/browser-proxy.cjs), the person's own servers untouched;
// - else, with no window here (or one that couldn't open), the page on a
//   free port and what it uses at their numbers where free, and one note of
//   what that costs.
// Previews: Always a separate window (Room → Settings) opens the window
// first, and nothing else by itself: one that couldn't open offers Open
// anyway. A file opens in the Files pane, which opens from a plugin's own
// call; a page in Claude's browser.

// Machine-wide (the store): where a forwarded preview opens. Claude's
// browser ('pane', Claude Desktop's default) or the person's own
// ('browser', a terminal's), each with a separate window when a port is
// taken; or always the window ('window'). Anything else (nothing chosen)
// reads as the surface's default, and 'pane' outside Desktop as 'browser'.
// Read here alone.
const PREVIEW_OPEN_KEY = 'previewOpen'
type PreviewOpen = 'pane' | 'browser' | 'window'
async function previewOpenOf($: $): Promise<PreviewOpen> {
  const saved = await $.store.get(PREVIEW_OPEN_KEY).catch(() => undefined)
  if (saved === 'browser' || saved === 'window') return saved
  return (await isDesktop($)) ? 'pane' : 'browser'
}

// Where a page opens without the window: Claude's browser in Desktop, unless
// the person chose their own.
async function shownIn($: $): Promise<'pane' | 'browser'> {
  return (await isDesktop($)) && (await previewOpenOf($)) !== 'browser' ? 'pane' : 'browser'
}

// Claude's browser, whose plugin calls auto mode refuses as it refuses
// pinning ("no verdict": nothing a model turn asked for). Refused once, it
// isn't tried again until an allow rule names it, read as `repinIfAllowed`
// reads pinning's (Allow previews in Claude, in Room → Settings, adds it).
// Said once for each kind of thing (`what`: previews, shared pages), with
// where they open instead and where to allow it.
const PANE_TOOL = 'mcp__Claude_Browser__preview_start'
async function paneAllowed($: $): Promise<boolean> {
  const allow = ((await readSettings($))?.settings.permissions as { allow?: unknown } | undefined)?.allow
  return Array.isArray(allow) && allow.includes(PANE_TOOL)
}

async function inPane($: $, url: string, what: string, instead: string): Promise<boolean> {
  if (!(await isDesktop($))) return false
  const refused = await read($, paneRefusedA)
  const say = () => noteOnce($, `pane-refused ${what}`, `Auto mode doesn't let the plugin open ${what} in Claude's browser, so they open ${instead}. Press Allow previews in Claude, in Room → Settings, to let it.`)
  if (refused && !(await paneAllowed($))) {
    say()
    return false
  }
  let why = ''
  const opened = await $.mcp.call('Claude_Browser', 'preview_start', { url }).catch(error => {
    why = String((error as Error)?.message ?? error)
    return null
  })
  if (opened && !opened.isError) {
    if (refused) await update($, paneRefusedA, () => false)
    return true
  }
  if (opened) why = opened.content.map(block => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('')
  $.ui.log(`Claude_Browser.preview_start refused: ${why.slice(0, 200)}`, { to: 'debug' })
  if (!refused) await update($, paneRefusedA, () => true)
  say()
  return false
}

// Allow previews in Claude (Room → Settings): an allow rule for exactly
// Claude's browser's preview_start. Its words say what else it lets: the
// person's own Claude opening pages there without auto mode's review.
async function allowPane($: $) {
  if (await allowTools($, [PANE_TOOL], "Previews in Claude allowed: the next one opens in Claude's browser.")) await update($, paneRefusedA, () => false)
}

// Where a preview's page opens (at the host's numbers here, a page moved
// elsewhere, the public link): Claude's browser in Desktop as the Previews
// setting says, else (or refused there) the person's own browser, else its
// address is copied. `live`: still the request it was; `words`: what's
// said when it's copied, or not even that.
type PageShown = 'pane' | 'browser' | 'copied' | 'said'
async function showPage($: $, room: ShareRoom, url: string, surface: RenderSurface | undefined, live: () => Promise<boolean>, words?: { copied: string; said: string }): Promise<PageShown | null> {
  if (!(await live())) return null
  if ((await shownIn($)) === 'pane' && (await inPane($, url, 'previews', 'in your browser'))) return 'pane'
  if (!(await live())) return null
  if (await openExternal($, url)) return 'browser'
  if (!(await live())) return null
  const copied = await $.ui.copy({ text: url, surface }).catch(() => ({ isCopied: false }))
  $.ui.toast(copied.isCopied ? words?.copied ?? `${room.host}'s preview is ready at ${url}: the address is copied.` : words?.said ?? `${room.host}'s preview is ready at ${url}.`)
  return copied.isCopied ? 'copied' : 'said'
}

const portsSaid = (ports: readonly number[]) => ports.map(p => `localhost:${p}`).join(ports.length === 2 ? ' and ' : ', ')

// A listener of this preview open here now (not the window's own tunnel).
function listening(pid: string, s: RoomScope = scope): LocalPreviewRun | null {
  const run = s.children.listeners.get(pid)
  return run?.owner === 'listener' && run.started && !run.failed && !run.stopping ? run : null
}

// The page and what it uses beside it, each listening here where the policy
// says, what it uses first (the page's first requests go to them):
// - same: each exactly at the host's number; one taken (by something of the
//   person's own, or a listener of it at another port already) or refused
//   by the system (`denied`, a fallback as a taken port is), nothing more
//   is tried: `{ taken }`;
// - elsewhere (no window here): what it uses at the host's numbers where
//   free (the rest go in the note), the page where it was last, else its
//   own number, else any free port.
// `keepWindow` (an Open that could go to the window): one whose tunnel
// serves the window is left to it, and nothing more is tried: `{ inWindow }`.
// Whatever doesn't come up, or the room left meanwhile, stops what this
// Open started and changes nothing else. What it starts carries the seat's
// token this session holds as it starts; seated anew while it binds (the
// room let the old seat go, and refuses its token), what it started stops
// and the Open asks to be pressed again (`RESEATED`).
// What's up is saved only once the page is (`commitMappings`), so nothing
// an Open only tried comes back; the page, when it's what another page uses,
// as opened on its own (`own`).
type Bound = { url: string; run: LocalPreviewRun; taken: number[]; denied: number[]; failed: string[] }
type BindResult = Bound | RefusedPort | { inWindow: true } | { error: string }
const RESEATED = 'The room reconnected you while the preview was opening. Press Open again.'
async function bindForOpen($: $, room: ShareRoom, s: RoomScope, page: Forwarded, uses: readonly Forwarded[], policy: 'same' | 'elsewhere', keepWindow = false): Promise<BindResult> {
  const seat = { ...room, token: s.token }
  const saved = await read($, localPreviewsA)
  const made: { pid: string; run: LocalPreviewRun }[] = [], bound: { pid: string; run: LocalPreviewRun; own?: true }[] = []
  const taken: number[] = [], denied: number[] = [], failed: string[] = []
  const undo = async (result: BindResult): Promise<BindResult> => {
    for (const { pid, run } of made) if (s.children.listeners.get(pid) === run) await stopLocalPreview($, pid, false, s)
    return result
  }
  const up = (want: Forwarded, run: LocalPreviewRun) => bound.push({ pid: want.pid, run, ...(want.pid === page.pid && page.dependency !== undefined ? { own: true as const } : {}) })
  for (const want of [...uses, page]) {
    // Only the page, with no window here, may move.
    const flexible = policy === 'elsewhere' && want.pid === page.pid
    const open = listening(want.pid, s)
    if (open) {
      if (flexible || open.localPort === want.port) up(want, open)
      else if (policy === 'same') return undo({ port: want.port, refused: 'taken' })
      else taken.push(want.port)
      continue
    }
    const at = flexible ? savedPort(saved.find(p => p.pid === want.pid && p.port === want.port) ?? want) : want.port
    const opened = await ensureLocalPreview($, seat, s, want, { bind: { port: at, strict: !flexible }, ...(keepWindow ? { keepWindow: true as const } : {}) })
    if (opened.made) made.push({ pid: want.pid, run: opened.made })
    if (!sameRoom(seat, s)) return undo({ error: stillInRoom(seat, s) ? RESEATED : 'This shared session is no longer open.' })
    if (opened.run) {
      up(want, opened.run)
      continue
    }
    if (opened.inWindow) return undo({ inWindow: true })
    if (policy === 'same' && opened.refused) return undo({ port: want.port, refused: opened.refused })
    if (policy === 'same' || flexible) return undo({ error: opened.error ?? `Couldn't forward localhost:${want.port}.` })
    if (opened.refused === 'denied') denied.push(want.port)
    else if (opened.refused) taken.push(want.port)
    else failed.push(opened.error ?? `Couldn't forward localhost:${want.port}.`)
  }
  const top = bound.find(b => b.pid === page.pid)!
  await commitMappings($, bound)
  return { url: listenerUrl(page, top.run), run: top.run, taken, denied, failed }
}

// What a page opened elsewhere costs, in one note: where it opened (and that
// sign-ins registered for its own number won't work at another), what it
// uses that's taken or refused here, what failed, and why no window keeps
// the host's addresses.
function elsewhereNote(room: ShareRoom, page: Forwarded, bound: Bound, why: RefusedPort, noWindow: string): string {
  const moved = bound.run.localPort !== page.port
  const refused = why.refused === 'denied' && why.port === page.port
  return [
    moved ? `${room.host}'s preview opened at localhost:${bound.run.localPort} here, not localhost:${page.port}, ${refused ? "which this computer doesn't let Claude Code listen on" : 'which is in use on this computer'}, so sign-ins registered for localhost:${page.port} won't work.` : `${room.host}'s preview opened at localhost:${page.port} here.`,
    bound.taken.length ? `${portsSaid(bound.taken)}, which it uses, ${bound.taken.length === 1 ? 'is' : 'are'} in use here too: the page may reach your own ${bound.taken.length === 1 ? 'server' : 'servers'} there.` : '',
    bound.denied.length ? `This computer doesn't let Claude Code listen on ${portsSaid(bound.denied)}, which it uses: the page can't reach ${bound.denied.length === 1 ? 'it' : 'them'} here.` : '',
    ...bound.failed,
    `A separate window would keep ${room.host}'s addresses, but ${noWindow}.`,
  ].filter(Boolean).join(' ')
}

// A forwarded preview's Open: Always a separate window, or the page open in
// the window already, goes there; else the host's own numbers here; one
// taken (or refused), the window; no window, the page elsewhere. A window
// that couldn't open: in Always, that's said, and the Previews setting is
// the way to open it without one (and so when none can open here at all);
// else the Open goes on without it. `without`: why no window this time
// (one just failed): the host's numbers, else elsewhere.
async function openForwarded($: $, room: ShareRoom, s: RoomScope, shown: ShareShown, surface?: RenderSurface, without?: string): Promise<void> {
  if (!isForwarded(shown)) return void $.ui.toast('That preview has ended or has no valid localhost address.')
  // The host away: nothing of theirs answers now, so nothing is bound or opened.
  if ((await read($, peopleA)).some(p => p.role === 'host' && !p.online)) return void $.ui.toast(`${room.host} is offline, so their previews can't open now. Press Open again once they're back.`)
  const page = shown, pid = page.pid, epoch = s.epoch(pid)
  // Still this Open: its room's scope, and no Stop, Close or Leave of the
  // preview since. A reseat isn't one: what the Open asks for goes with the
  // seat held as it's asked (`bindForOpen`, the window's `readyProxy`), and
  // one seated anew meanwhile says so (`RESEATED`) rather than end without a
  // word.
  const live = async () => stillInRoom(room, s) && s.epoch(pid) === epoch
  // Whether a window can open here, looked for only once one is wanted
  // (Always, the page in the window, a port taken): an Open whose ports are
  // free never waits on the browser look.
  let choice: WindowChoice | undefined
  const windowHere = async (): Promise<WindowChoice> => (choice ??= without ? { window: false, reason: without } : (await windowChoice($, true, s))!)
  const uses = dependenciesOf(await forwardedNow($), page)
  // No window here: the page where it can be, what it uses at their numbers
  // where free; one note of what that costs, said once a room.
  const elsewhere = async (why: RefusedPort, noWindow: string) => {
    const bound = await bindForOpen($, room, s, page, uses, 'elsewhere')
    if (!(await live())) return
    if (!('url' in bound)) return void $.ui.toast('error' in bound ? bound.error : 'That preview could not be opened.')
    if (!(await showPage($, room, bound.url, surface, async () => (await live()) && (await localRunCurrent($, pid, bound.run))))) return
    const note = elsewhereNote(room, page, bound, why, noWindow)
    noteOnce($, `elsewhere ${note}`, note, s)
  }
  // Always a separate window, and none opened (one failed, or none can open
  // here): nothing else opens it (the person's cookies and own servers stay
  // apart from the host's); their Previews setting does, changed.
  const alwaysFailed = (reason: string) => void $.ui.toast(`Couldn't open the preview window: ${reason}. To open ${room.host}'s localhost:${page.port} without one, change Previews in Room → Settings.`)
  const viaWindow = async (c: Extract<WindowChoice, { window: true }>, why: WindowWhy): Promise<void> => {
    const outcome = await openInWindow($, room, s, c, page, why)
    if (typeof outcome !== 'object' || !(await live())) return
    if ('always' in why) return alwaysFailed(outcome.failed)
    // A port taken here: the page elsewhere, its note saying why there's no window.
    if ('refused' in why) return elsewhere(why, outcome.failed)
    // Open in the window before (its ports may be free here): the host's numbers, else elsewhere.
    $.ui.toast(`Couldn't open the preview window: ${outcome.failed}.`)
    return openForwarded($, room, s, page, surface, outcome.failed)
  }
  if (!without && (await previewOpenOf($)) === 'window') {
    const c = await windowHere()
    if (!(await live())) return
    return c.window ? viaWindow(c, { always: true }) : alwaysFailed(c.reason)
  }
  // The page, or what it uses, served by the window already (the window's
  // own tunnel for it, up: the page open there, or reached from a page
  // that is): the Open goes there again, its tabs and their sockets
  // untouched, rather than the host's numbers being tried here first (the
  // tunnels they'd replace serve the window).
  if (!without && [page, ...uses].some(u => windowServes(s, u.pid))) {
    const c = await windowHere()
    if (!(await live())) return
    if (c.window) return viaWindow(c, { again: true })
  }
  await retryRefused($, page, s)
  if (!(await live())) return
  const same = await bindForOpen($, room, s, page, uses, 'same', !without)
  if (!(await live())) return
  if ('error' in same) return void $.ui.toast(same.error)
  // The window took up the page, or what it uses, while this Open tried
  // here (what it started here stopped again): the window then, too.
  if ('inWindow' in same) {
    const c = await windowHere()
    if (!(await live())) return
    return c.window ? viaWindow(c, { again: true }) : openForwarded($, room, s, page, surface, c.reason)
  }
  if ('url' in same) {
    const where = await showPage($, room, same.url, surface, async () => (await live()) && (await localRunCurrent($, pid, same.run)))
    if (!where) return
    // Said once a room: what the host's numbers here cost.
    const ports = [page.port, ...uses.filter(u => listening(u.pid, s)?.localPort === u.port).map(u => u.port)]
    const them = ports.length === 1 ? 'it' : 'them'
    const opened = where === 'pane' ? `Opened ${room.host}'s localhost:${page.port} in Claude's browser.` : where === 'browser' ? `Opened ${room.host}'s localhost:${page.port} in your browser.` : `${room.host}'s localhost:${page.port} is forwarded here, at the same address.`
    noteOnce($, 'same', `${opened} While you're in the room, ${portsSaid(ports)} here ${ports.length === 1 ? 'reaches' : 'reach'} ${room.host}'s, your cookies for ${them} included; Close in Room → Shown, or Leave, frees ${them}.`, s)
    return
  }
  const c = await windowHere()
  if (!(await live())) return
  if (c.window) return viaWindow(c, same)
  return elsewhere(same, c.reason)
}

// One Open of a preview at a time (the room scope's): a second press while
// one runs waits for it and opens nothing more (no second tab, and nothing of
// a failed attempt saved over the first's mapping).
async function openShownPreview($: $, shown: ShareShown, surface?: RenderSurface) {
  const s = scope, room = await read($, roomA)
  if (!room || !shown.pid || !stillInRoom(room, s)) return
  const pid = shown.pid
  const running = s.previewOpens.get(pid)
  if (running) return running
  const task = shown.tcp ? openForwarded($, room, s, shown, surface) : openPublicPreview($, shown, surface)
  s.previewOpens.set(pid, task)
  try {
    await task
  } finally {
    if (s.previewOpens.get(pid) === task) s.previewOpens.delete(pid)
  }
}

async function openShown($: $, shown: ShareShown, surface?: RenderSurface) {
  if (shown.kind === 'preview' && shown.pid) return openShownPreview($, shown, surface)
  const room = await read($, roomA)
  if (!room) return
  const path = (await downloadShown($, room, shown.files ?? []))[0] ?? null
  if (!path) return void $.ui.toast("Couldn't get that file")
  // A page opens in Claude's browser, where it runs (inside the project);
  // refused there (auto mode), in the Files pane as a file does.
  if (shown.kind === 'page' && (await inPane($, `file://${path}`, 'shared pages', 'in the Files pane'))) return
  const result = await desk($, 'ccd_view', 'show_pane', { pane: 'file', path })
  if (result === null) $.ui.log(`Saved to ${path}`)
}

// Host: the public link's HTTP. A guest's browser asked a preview for
// something (the room's `proxy`): this machine's localhost answers, only on
// a port this session shares and at the scheme its server speaks, and the
// answer goes back to the room (proxy/<id>): a line of status and headers,
// then the body, so the headers ride in the body, never in one request
// header a server caps at 16 KiB.
// At most PROXY_RUNS run at once and PROXY_QUEUE wait, oldest first; past
// that the browser gets a busy page at once. Each run is kept with its
// preview in the room's scope, so Stop, unshare and the room closing end
// what it started (`RoomChildren.closePublic`).
const PROXY_RUNS = 16
const PROXY_QUEUE = 256
// Busy pages being posted at once; past this many, an ask is left to the room's own timeout.
const PROXY_BUSY = 16
// What a fetch says on stdout (its folder, exit, status and headers) at most: past it, headers no room takes.
const PROXY_SAID_MAX = 512 * 1024
// How long the room waits for an answer (its PROXY_TIMEOUT_MS): an ask that waited longer is answered already.
const PROXY_ASK_MS = 30_000
type ProxyRun = { room: ShareRoom; id: string; pid: string; ask: Record<string, unknown>; scope: RoomScope; at: number; stopped: boolean; child?: Child }
let proxyBusy = 0

async function answerProxy($: $, room: ShareRoom, ask: Record<string, unknown>) {
  const id = typeof ask.id === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(ask.id) ? ask.id : ''
  const pid = typeof ask.pid === 'string' && PREVIEW_ID.test(ask.pid) ? ask.pid : ''
  if (!id || !pid) return
  const at = await $.clock.now()
  // No await from here to its place in a run or the queue. The same ask
  // read twice (a stream that delivered it again) runs once.
  const s = scope, { fetches, waiting } = s.children
  if (!sameRoom(room, s) || [...fetches, ...waiting].some(r => r.id === id)) return
  const run: ProxyRun = { room, id, pid, ask, scope: s, at, stopped: false }
  if (fetches.size < PROXY_RUNS) return startProxy($, run)
  if (waiting.length < PROXY_QUEUE) return void waiting.push(run)
  if (proxyBusy >= PROXY_BUSY) return
  proxyBusy += 1
  try {
    if (sameRoom(room, s) && (await read($, sharesA))[String(ask.port)]?.pid === pid) await answerPage($, run, 503, 'The preview is busy', 'Too many requests at once. Reload in a moment.')
  } catch {} finally {
    proxyBusy -= 1
  }
}

function startProxy($: $, run: ProxyRun) {
  const { fetches, waiting } = run.scope.children
  fetches.add(run)
  void proxyOnce($, run)
    .catch(() => {})
    .finally(() => {
      fetches.delete(run)
      // The oldest waiting ask, now there's room for it.
      const next = waiting.shift()
      if (next) startProxy($, next)
    })
}

// One ask: the fetch, then its answer, each a child kept with the run.
async function proxyOnce($: $, run: ProxyRun) {
  const { room, ask, pid, scope: s } = run
  const port = Number(ask.port)
  const path = typeof ask.path === 'string' && ask.path.startsWith('/') ? ask.path : '/'
  const method = typeof ask.method === 'string' && /^[A-Z]{3,7}$/.test(ask.method) ? ask.method : 'GET'
  // Still this room's, and the port still shared as this preview, not being
  // stopped (`unshare` takes the share away a step after it says so): before each step.
  const shared = async () => (!run.stopped && sameRoom(room, s) && s.mode === 'host' && !s.revoking.has(pid) ? (await read($, sharesA))[String(port)] : undefined)
  const live = async () => (await shared())?.pid === pid
  // Waited past the room's own deadline: its browser has the room's page already.
  if (!validPort(port) || (await $.clock.now()) - run.at >= PROXY_ASK_MS) return
  const share = await shared()
  if (share?.pid !== pid) {
    // One this session shared and stopped (a Stop under way, or one the room
    // didn't hear, whose link it still sends here): ended, said at once, not
    // at the room's own deadline.
    const stopped = s.revoking.has(pid) || (await read($, shownA)).some(x => x.kind === 'preview' && x.pid === pid)
    if (stopped && !run.stopped && sameRoom(room, s) && s.mode === 'host') await answerPage($, run, 404, 'This preview has ended', `${room.host} is no longer sharing it.`)
    return
  }
  // Another session's preview holds the port now: its app is never fetched for this room.
  if (await relayedNow($, s, port)) {
    if (await live()) await answerPage($, run, 403, "This preview isn't available", `localhost:${port} is another shared session's preview, forwarded to ${room.host}'s computer, so it can't be shared on.`)
    return
  }
  const local = `${share.scheme === 'https' ? 'https' : 'http'}://localhost:${port}`
  // HEAD as curl's own (`head`): asked as a method of its own, curl waits for
  // a body the length says until its time runs out, a 504 for an app that
  // answered at once. It writes the head where the body goes, emptied after.
  const headOnly = method === 'HEAD'
  const request = [
    `url = ${cfg(`${local}${path}`)}`,
    headOnly ? 'head' : `request = ${cfg(method)}`,
    // As from the preview's own page at its local address, Origin and
    // Referer too; CSRF protection is the gateway's cookie's (`localHeaders`).
    ...localHeaders(Array.isArray(ask.headers) ? ask.headers : [], local).map(([k, v]) => `header = ${cfg(`${k}: ${v}`)}`),
    // The guest's path as it came: curl reads [1-9] and {a,b} in a URL as a
    // pattern, one request into millions, unless told not to.
    'globoff',
    // A dev server's own certificate for localhost: this machine's, not checked for this.
    ...(local.startsWith('https:') ? ['insecure'] : []),
    // A video or a source map past what the room takes isn't fetched whole.
    `max-filesize = ${PROXY_FETCH_MAX}`,
  ].join('\n')
  // A HEAD has none (one alongside `head` is a curl error).
  const body = !headOnly && typeof ask.body === 'string' && /^[A-Za-z0-9+/=]*$/.test(ask.body) ? ask.body : ''
  const tag = fence(request)
  // The fetch. Its folder is said first, so a run stopped mid-way can still
  // remove it; curl runs in the background, so a Stop's signal ends it at
  // once, not after its 25 s. A failed fetch keeps nothing.
  const fetched = await proxyStep(
    $,
    run,
    [
      'd=$(mktemp -d "${TMPDIR:-/tmp}/cs-proxy.XXXXXXXX") || exit 1',
      `printf 'dir=%s\\n' "$d"`,
      'c=',
      `trap 'kill $c 2>/dev/null; rm -rf "$d"; exit 1' HUP INT TERM`,
      `cat > "$d/req" <<'${tag}'`,
      request,
      tag,
      `printf '%s' ${sq(body)} | base64 --decode > "$d/body" 2>/dev/null || : > "$d/body"`,
      'if [ -s "$d/body" ]; then set -- --data-binary "@$d/body"; else set --; fi',
      `curl -s -K "$d/req" "$@" -D "$d/h" -o "$d/b" -w '%{http_code}' --max-time 25 > "$d/s" & c=$!`,
      'wait $c; e=$?; c=',
      'if [ $e -ne 0 ]; then rm -rf "$d"; echo "exit=$e"; exit 0; fi',
      ...(headOnly ? [': > "$d/b"'] : []),
      `printf 'exit=0\\nstatus=%s\\nheaders=' "$(cat "$d/s")"`,
      `base64 < "$d/h" | tr -d '\\n\\r'`,
      'echo',
      '',
    ].join('\n'),
  )
  const out = fetched ?? ''
  const dir = /^dir=(\/.*\/cs-proxy\.[A-Za-z0-9]+)$/m.exec(out)?.[1]
  const exit = /^exit=(\d+)$/m.exec(out)?.[1]
  // Its folder stays only after a fetch that went through, or one cut off.
  const kept = exit === undefined || exit === '0' ? dir : undefined
  // Stopped meanwhile, or past the room's deadline: what it fetched goes nowhere.
  if ((await $.clock.now()) - run.at >= PROXY_ASK_MS || !(await live())) return discardFetch($, kept)
  if (exit !== '0' || !dir) {
    discardFetch($, kept)
    if (exit === '63') return answerPage($, run, 502, 'Too large for a preview', 'This response is over 20 MB, more than a preview carries.')
    if (exit === '28') return answerPage($, run, 504, 'The preview did not answer', `${room.host}'s app took too long to respond.`)
    return answerPage($, run, 502, 'The preview is not reachable', `Nothing answered on ${room.host}'s localhost:${port}.`)
  }
  const status = Number(/^status=(\d{3})$/m.exec(out)?.[1])
  const head = proxyHead(status, /^headers=([A-Za-z0-9+/=]*)$/m.exec(out)?.[1] ?? '')
  if (out.length >= PROXY_SAID_MAX || (head !== null && head.length > PROXY_HEAD_MAX)) {
    discardFetch($, dir)
    return answerPage($, run, 502, 'Too large for a preview', "This response's headers are over 64 KB, more than a preview carries.")
  }
  if (head === null || !(status >= 200 && status <= 599)) {
    discardFetch($, dir)
    return answerPage($, run, 502, 'The preview is not reachable', `Nothing answered on ${room.host}'s localhost:${port}.`)
  }
  const config = [
    roomConfig(room, `proxy/${run.id}`),
    // Taken in, or given up, within a minute.
    'max-time = 60',
  ].join('\n')
  const t1 = fence(config)
  const t2 = fence(head)
  // The answer: its head line, then the body as fetched. A Stop before it
  // starts sends nothing, and the folder goes.
  const answered = await proxyStep(
    $,
    run,
    [
      `d=${sq(dir)}`,
      'c=',
      `trap 'kill $c 2>/dev/null; rm -rf "$d"' EXIT`,
      `trap 'exit 1' HUP INT TERM`,
      `cat > "$d/up" <<'${t1}'`,
      config,
      t1,
      `cat > "$d/pre" <<'${t2}'`,
      head,
      t2,
      `cat "$d/pre" "$d/b" | curl -K "$d/up" -X POST --data-binary @- -o /dev/null & c=$!`,
      'wait $c; c=',
      '',
    ].join('\n'),
  )
  if (answered === null) discardFetch($, dir)
}

// One shell step of a run, its child kept with the run so a Stop ends it
// at once (`RoomChildren.closePublic`). Null when the run was stopped before it began.
async function proxyStep($: $, run: ProxyRun, script: string): Promise<string | null> {
  if (run.stopped) return null
  let out = ''
  try {
    const child = $.process.spawn({ argv: ['/bin/sh', '-s'], input: script })
    run.child = child
    for await (const chunk of child) if (chunk.stream === 'stdout' && out.length < PROXY_SAID_MAX) out += chunk.text
  } catch {} finally {
    run.child = undefined
  }
  return out
}

// A fetch's folder that no answer will be sent from.
function discardFetch($: $, dir: string | undefined) {
  if (dir) void sh($, `rm -rf -- ${sq(dir)}\n`)
}

// The link's answer when the app's can't be: a page of the plugin's own
// (busy, too large, nothing answering), posted by curl, its credentials on
// stdin, with no folder.
async function answerPage($: $, run: ProxyRun, status: number, title: string, text: string) {
  const page = proxyPage(title, text)
  const config = [
    roomConfig(run.room, `proxy/${run.id}`),
    'request = "POST"',
    'max-time = 60',
    `data-binary = ${curlString(`${pageHead(status)}\n${page}`)}`,
  ].join('\n')
  try {
    const child = $.process.spawn({ argv: ['curl', '--silent', '--output', '/dev/null', '--config', '-'], input: `${config}\n` })
    for await (const _chunk of child) { /* Never log credentials or a server's answer. */ }
  } catch {}
}

// A child ended now, without waiting on it (`RoomChildren.closePublic`).
function endChild(child: Child | undefined) {
  if (child) void Promise.resolve().then(() => child.return(undefined as never)).catch(() => {})
}

// Host: a guest's browser opened a WebSocket on a preview. A relay (Node, as
// the dev server runs on) opens it on this machine's localhost, only on ports
// this session shares and at the scheme its server speaks, and one back to
// the room for it; its settings, token included, go on stdin. Each is a
// process for the socket's life: at most PUBLIC_RELAYS at once, the rest
// refused (BUSY), and one that fails (no Node, or a dev server that doesn't
// take the socket) refused CONNECT; the room closes the browser's socket for
// either (`ws/<id>/reject`). Each is kept
// with its preview in the room's scope, so Stop, unshare and the room closing
// close it (`RoomChildren.closePublic`).
const PUBLIC_RELAYS = 32
type PublicRelay = { pid: string; stopped: boolean; child?: Child }

async function relaySocket($: $, room: ShareRoom, ask: Record<string, unknown>) {
  const id = typeof ask.id === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(ask.id) ? ask.id : ''
  const pid = typeof ask.pid === 'string' && PREVIEW_ID.test(ask.pid) ? ask.pid : ''
  const port = Number(ask.port)
  const path = typeof ask.path === 'string' && ask.path.startsWith('/') ? ask.path : '/'
  const protocols = (Array.isArray(ask.protocols) ? ask.protocols : []).filter((p): p is string => typeof p === 'string' && /^[\w.-]{1,64}$/.test(p)).slice(0, 4)
  const s = scope
  if (!id || !pid || !validPort(port) || !sameRoom(room, s)) return
  const share = (await read($, sharesA))[String(port)]
  // Not while it's being stopped: `unshare` closes its relays (`closePublic`)
  // a step before its share goes, and one let in between would outlive it.
  if (share?.pid !== pid || !sameRoom(room, s) || s.revoking.has(pid)) return
  // Another session's preview holds the port now: its socket is refused, never relayed.
  if (await relayedNow($, s, port)) return void (sameRoom(room, s) && rejectSocket($, room, id, 'CONNECT'))
  if (!sameRoom(room, s) || s.revoking.has(pid)) return
  const key = tcpKey(room, id), relays = s.children.relays
  if (relays.has(key)) return
  if (relays.size >= PUBLIC_RELAYS) return void rejectSocket($, room, id, 'BUSY')
  const relay: PublicRelay = { pid, stopped: false }
  relays.set(key, relay) // No await since the capacity check.
  let exit: number | null = null
  try {
    const tls = share.scheme === 'https'
    const config = {
      local: `${tls ? 'wss' : 'ws'}://localhost:${port}${path}`,
      // A TLS dev server's own certificate for localhost goes unchecked on
      // this leg alone; the room's is always checked.
      ...(tls ? { insecureLocal: true } : {}),
      origin: `${tls ? 'https' : 'http'}://localhost:${port}`,
      protocols,
      room: `${room.server.replace(/^http/, 'ws')}/api/rooms/${room.id}/ws/${id}`,
      token: room.token,
      version: await ownVersion($),
    }
    if (relay.stopped || !s.live) return
    const child = $.process.spawn({ argv: ['/bin/sh', '-c', FIND_NODE, 'sh', `${$.plugin.root}/relay/ws-relay.cjs`], input: JSON.stringify(config) })
    relay.child = child
    for await (const chunk of child) if (chunk.stream === 'stderr') $.ui.log(chunk.text.trim(), { to: 'debug' })
    exit = (await child.result.catch(() => null))?.code ?? null
  } catch {} finally {
    if (relays.get(key) === relay) relays.delete(key)
  }
  // A relay that failed, not one stopped here: no Node to relay with (127),
  // or its local leg never opened, or settings it refused (1). The relay
  // dials the room only once the dev server took the socket, so the room
  // hears nothing else, and the browser's socket closes now (1011), not at
  // its deadline. One that had paired gets only a refusal from the room.
  if (exit !== null && exit !== 0 && !relay.stopped) void rejectSocket($, room, id, 'CONNECT')
}

// Host: a socket the room should close (`ws/<id>/reject`: a TCP pair's, or
// the public link's), BUSY or CONNECT, never a relay's error text: one
// bounded curl, TCP_RELAYS at most at once. Curl is already required for the
// host's feed; credentials stay on stdin here too.
async function rejectSocket($: $, room: ShareRoom, id: string, code: 'BUSY' | 'CONNECT') {
  const key = tcpKey(room, id)
  if (tcpRejecting.has(key) || tcpRejecting.size >= TCP_RELAYS) return
  tcpRejecting.add(key)
  try {
    const input = `${roomConfig(room, `ws/${id}/reject`)}\nrequest = "POST"\nheader = "content-type: application/json"\ndata = ${cfg(JSON.stringify({ code }))}\n`
    const child = $.process.spawn({ argv: ['curl', '--silent', '--max-time', '2', '--output', '/dev/null', '--config', '-'], input })
    for await (const _chunk of child) { /* Never log credentials or a server's answer. */ }
  } catch {} finally {
    tcpRejecting.delete(key)
  }
}

// Host: all raw TCP connections share one supervised Node process. Control
// requests finish at admission; neither a plugin HTTP request nor its stdin
// stays open for the lifetime of an application connection.
function tcpKey(room: ShareRoom, id: string): string {
  return `${room.server}/${room.id}/${id}`
}

// A connection still to be made: its room's scope open, its preview not
// being unshared, its worker the one running, and still the one for its id.
function tcpCurrent(run: TcpRelayRun): boolean {
  const s = run.scope
  return s.live && !run.worker.stopped && s.children.worker === run.worker && run.worker.scope === s && !s.revoking.has(run.pid) && s.children.connections.get(tcpKey(run.worker.room, run.id)) === run
}

// …and still forwarded: its port shared as its preview, which the host
// chose to forward (`tcp`).
async function tcpAllowed($: $, run: TcpRelayRun): Promise<boolean> {
  const share = (await read($, sharesA))[String(run.port)]
  return tcpCurrent(run) && sameRoom(run.worker.room, run.scope) && run.scope.mode === 'host' && share?.pid === run.pid && share.tcp === true
}

// A worker that failed holds the room's place until its process has gone
// (`relayTcp`), and its connections go from the room's at once.
function finishTcpWorker(worker: TcpWorkerRun): Promise<void> {
  return finishHelper(
    worker,
    async () => {
      const { connections } = worker.scope.children
      for (const [key, run] of connections) if (run.worker === worker) connections.delete(key)
      await worker.child?.return(undefined as never)
    },
    () => {
      if (worker.scope.children.worker === worker) worker.scope.children.worker = null
    },
  )
}

const tcpWorking = (worker: TcpWorkerRun) => !worker.stopped && worker.scope.children.worker === worker && worker.scope.live

// A connection it closed (`closed`) goes from the room's: the same id asked
// for again while it was open was taken for the one it had.
async function runTcpWorker($: $, worker: TcpWorkerRun) {
  try {
    const version = await ownVersion($)
    if (!tcpWorking(worker)) return
    const settings = { room: `${worker.room.server}/api/rooms/${worker.room.id}`, token: worker.room.token, controlToken: worker.controlToken, version }
    await runHelper($, worker, 'tcp-worker.cjs', settings, 5_000, () => finishTcpWorker(worker), () => tcpWorking(worker), said => {
      if (said.state === 'closed' && typeof said.id === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(said.id)) {
        const key = tcpKey(worker.room, said.id), { connections } = worker.scope.children
        if (connections.get(key)?.worker === worker) connections.delete(key)
      } else if (said.state === 'ready') {
        if (worker.control !== undefined || !validPort(said.port)) throw new Error('Invalid TCP worker readiness')
        helperReady(worker, said.port)
        worker.settle(true)
      }
    })
  } catch {
    // Owned sockets fail. Only a new independent request may start another
    // worker; no open command or application bytes are replayed.
  } finally {
    await finishTcpWorker(worker)
  }
}

// BUSY (429): its connections all taken, which it told the room. Anything
// else, no answer in two seconds included, ends it: only a new connection
// starts another, and nothing it was asked is asked again.
function tcpControl($: $, worker: TcpWorkerRun, body: Record<string, unknown>, run?: TcpRelayRun): Promise<number> {
  const stands = async () => (run && (!(await tcpAllowed($, run)) || !tcpCurrent(run)) ? null : body)
  return helperPost($, worker, () => worker.scope.children.worker === worker, stands, { answers: [200, 429], failed: () => void finishTcpWorker(worker) })
}

async function relayTcp($: $, room: ShareRoom, ask: Record<string, unknown>) {
  const id = typeof ask.id === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(ask.id) ? ask.id : ''
  const pid = typeof ask.pid === 'string' && PREVIEW_ID.test(ask.pid) ? ask.pid : ''
  const port = ask.port
  // A drained old stream can still have a notification in its current chunk.
  // Never let it install an unstarted worker for the room that replaced it.
  const s = scope
  if (!id || !pid || !validPort(port) || !sameRoom(room, s) || s.mode !== 'host') return
  const key = tcpKey(room, id), { connections } = s.children
  if (connections.has(key)) return
  if (connections.size >= TCP_RELAYS) return void rejectSocket($, room, id, 'BUSY')
  let worker = s.children.worker
  if (!worker) {
    worker = { ...newHelper(s), room, started: false }
    s.children.worker = worker
  }
  // A worker that failed holds the room's place until its process has gone:
  // a connection meanwhile is refused now, not left to the room's deadline,
  // and the next one starts another.
  if (worker.stopped) return void rejectSocket($, room, id, 'CONNECT')
  if (worker.scope !== s || !sameRoomId(worker.room, room)) return
  const run: TcpRelayRun = { id, pid, port, scope: s, worker }
  connections.set(key, run) // No await since the capacity check: queued + connecting + active.
  let accepted = false, refused = false
  try {
    // Another session's preview holding the port now is refused (CONNECT), as a port not shared is.
    if (!(await tcpAllowed($, run)) || (await relayedNow($, s, port)) || !tcpCurrent(run)) return
    if (!worker.started) {
      worker.started = true
      void runTcpWorker($, worker)
    }
    const status = await tcpControl($, worker, { op: 'open', id, pid, port }, run)
    accepted = status === 200
    refused = status === 429 // The worker already sent BUSY, not CONNECT.
  } catch {} finally {
    if (!accepted) {
      if (connections.get(key) === run) connections.delete(key)
      if (!worker.started && s.children.worker === worker && ![...connections.values()].some(r => r.worker === worker)) await finishTcpWorker(worker)
      if (!refused && s.live) void rejectSocket($, room, id, 'CONNECT')
      // No Node here to run the worker: the host hears it, once a room (the
      // next connection starts one again, so installing Node is enough).
      if (worker.error === 'NODE') noteOnce($, 'tcp-node', `Forwarding localhost:${port} to teammates needs Node on this computer, and none was found. Install Node; their next connection tries again.`, s)
    }
  }
}

// Host: one preview's TCP connections end (a Stop, its end); the worker
// goes on for the others. All of them end with the room (`RoomChildren.stop`).
async function stopTcpRelays($: $, s: RoomScope, pid: string) {
  const { connections } = s.children
  for (const [key, run] of connections) if (run.pid === pid) connections.delete(key)
  const worker = s.children.worker
  if (!worker?.started) return
  if (await tcpControl($, worker, { op: 'close-preview', pid }) !== 200) await finishTcpWorker(worker)
}

// Host: a preview unshared (its Stop here, or its closed event from the
// room): its TCP connections end, its public link's sockets and requests
// too, and nothing reaches it through this session any more, by its link or
// forwarded. Only this pid, never a newer share of the same port.
async function unshare($: $, room: ShareRoom, pid: string) {
  const s = scope
  if (!sameRoom(room, s)) return
  s.revoking.add(pid)
  s.children.closePublic(pid)
  try {
    const stopped = stopTcpRelays($, s, pid)
    await sharesLane.run(async () => {
      if (!s.live) return
      await update($, sharesA, shares => (s.live ? Object.fromEntries(Object.entries(shares).filter(([, share]) => share.pid !== pid)) : shares))
    })
    await stopped
  } finally {
    s.revoking.delete(pid)
  }
}

// Host: what started a turn nobody typed (a background task finishing), as
// the line guests see in the prompt's place.
function startedBy(text: string): string {
  const note = /<task-notification>([\s\S]*?)<\/task-notification>/.exec(text)?.[1]
  if (!note) return ''
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(note)?.[1]?.trim()
  return `(${(summary || 'a background task finished').slice(0, 200)})`
}

// How the terminal names a tool in its rows.
function terminalName(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) return `${mcp[1]} - ${mcp[2]} (MCP)`
  return ({ Edit: 'Update', MultiEdit: 'Update', NotebookEdit: 'Update', Grep: 'Search', Glob: 'Search', WebFetch: 'Fetch', WebSearch: 'Web Search', TodoWrite: 'Update Todos', Task: 'Agent' } as Record<string, string>)[tool] ?? tool
}

// A replayed call's result as text, whatever shape the row kept it in.
function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  const blocks = Array.isArray(output) ? output : output && typeof output === 'object' && Array.isArray((output as { content?: unknown }).content) ? (output as { content: unknown[] }).content : null
  if (blocks) return blocks.map(b => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
  return output === undefined || output === null ? '' : JSON.stringify(output)
}

// How many pictures a result holds (image blocks).
function imageCount(output: unknown): number {
  const blocks = Array.isArray(output) ? output : output && typeof output === 'object' && Array.isArray((output as { content?: unknown }).content) ? (output as { content: unknown[] }).content : []
  return blocks.filter(b => b && typeof b === 'object' && (b as { type?: unknown }).type === 'image').length
}

// The line or two the terminal shows under a call, folded as it folds its own.
function replayLines(tool: string, input: Record<string, unknown>, out: string, errored: boolean, pictures = 0): string[] {
  const text = out.replace(/^Error: /, '').trimEnd()
  const all = text ? text.split('\n') : []
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  if (errored) return [`Error: ${all[0] ?? 'failed'}`]
  // A picture the host's Claude looked at: said as the terminal says its own.
  if (pictures) return tool === 'Read' ? [pictures === 1 ? 'Read image' : `Read ${count(pictures, 'image')}`] : [...(all.length ? [all[0]!] : []), pictures === 1 ? '[Image]' : `[${count(pictures, 'image')}]`]
  const first = (n: number) => (all.length <= n ? all : [...all.slice(0, n), `… +${count(all.length - n, 'line')}`])
  switch (tool) {
    case 'Read': {
      // A file read's last line can be just its number (an empty last line).
      const lines = all.length && /^\s*\d+\s*$/.test(all.at(-1) ?? '') ? all.length - 1 : all.length
      return [`Read ${count(lines, 'line')}`]
    }
    case 'Write':
      return [`Wrote ${count(String(input.content ?? '').split('\n').length, 'line')}`]
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input]
      const lines = (v: unknown) => (typeof v === 'string' && v ? v.split('\n').length : 0)
      const added = edits.reduce((n, x) => n + lines(x.new_string ?? x.new_source), 0)
      const removed = edits.reduce((n, x) => n + lines(x.old_string), 0)
      const file = String(input.file_path ?? input.notebook_path ?? '').split('/').pop()
      const parts = [added ? count(added, 'addition') : '', removed ? count(removed, 'removal') : ''].filter(Boolean)
      return [`Updated${file ? ` ${file}` : ''}${parts.length ? ` with ${parts.join(' and ')}` : ''}`]
    }
    case 'Grep':
    case 'Glob':
      return [all.length && !/^No (files|matches) found/.test(all[0] ?? '') ? `Found ${count(all.length, tool === 'Glob' ? 'file' : 'line')}` : 'Found nothing']
    case 'Bash':
      return all.length ? first(3) : ['(No output)']
    default:
      return all.length ? first(2) : []
  }
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

function queueRide($: $, text: string, ride: Ride, refused?: () => void) {
  const list = ridesByText.get(text) ?? []
  list.push(ride)
  ridesByText.set(text, list)
  submitLater($, text, () => {
    const left = (ridesByText.get(text) ?? []).filter(r => r !== ride)
    if (left.length) ridesByText.set(text, left)
    else ridesByText.delete(text)
    refused?.()
  })
}

// A prompt submitted from inside another hook's dispatch is refused, so every
// prompt this plugin starts goes out from a timer of its own.
function submitLater($: $, text: string, refused?: () => void) {
  $.clock.after(0, () => {
    void $.prompt.submit({ text, asUser: true }).catch(error => {
      $.ui.log(`prompt.submit refused: ${String(error?.message ?? error)}`, { to: 'debug' })
      refused?.()
    })
  })
}

// Starts the next local turn: what was queued first (what happened before
// joining, something shown outside a turn), then the next host turn nobody
// here has shown yet. A prompt typed here that is still waiting shows the
// turns ahead of it itself.
function scheduleRides($: $) {
  if (localTurnActive || rideSubmitted || ownPending.size > 0) return
  const retry = () => {
    rideSubmitted = false
    scheduleRides($)
  }
  const later = laterRides.shift()
  if (later) {
    rideSubmitted = true
    queueRide($, later.text, later.ride, retry)
    return
  }
  const next = hostTurns.find(t => !t.shown && !t.claimed && !(t.pid && ownPending.has(t.pid)))
  if (!next) return
  next.claimed = true
  rideSubmitted = true
  queueRide($, `${next.by}: ${next.prompt || '(carried on by itself)'}`, { kind: 'turn', turnId: next.turnId }, () => {
    next.claimed = false
    retry()
  })
}

async function postChat($: $, text: string) {
  const line = text.trim()
  if (!line) return
  send($, 'chat', { text: line.slice(0, 2000) })
}

async function openRoom($: $, page?: RoomTab) {
  roomOpen = true
  // On the page asked for; else, with messages waiting, on the chat.
  if (page) await update($, roomTabA, () => page)
  else if ((await read($, unreadA)) > 0) await update($, roomTabA, () => 'chat')
  if ((await read($, roomTabA)) === 'chat') await update($, unreadA, () => 0)
  // Who can be invited now: someone may have joined the team since.
  if ((await read($, teamsA)).account) void refreshTeams($).catch(() => {})
  // A dialog in a terminal: it takes the keys (Tab and the arrows walk it,
  // Esc closes it) and opens as tall as the Room is, not a third of the
  // screen. Desktop's side panel just comes forward.
  await $.ui.open({ id: ROOM, title: 'Shared session', focus: true, closeOnEscape: true, rows: 60 })
}

// What one riding poll adds to the reply being shown.
// A ride between its steps: what it has read and what is still to show.
type RideRun = { state: RideState; cursor: number; failures?: number; lastCall?: { id: string; event: ServerEvent } }
// Guest: calls a riding turn made that this Claude Code refused (auto mode
// gives a plugin's step no verdict), by tool_use_id, with the reason.
const refusedCalls = new Map<string, string>()
// Every argument the ride gave comes back unchanged (the engine may add its own).
function sameArgs(given: string, actual: unknown): boolean {
  let want: Record<string, unknown>
  try {
    want = JSON.parse(given)
  } catch {
    return false
  }
  const got = (actual && typeof actual === 'object' ? actual : {}) as Record<string, unknown>
  return Object.entries(want).every(([k, v]) => JSON.stringify(got[k]) === JSON.stringify(v))
}

// Guest: the calls riding turns made, by tool_use_id, and whether this
// plugin may approve them itself (everything but a public link).
const rideCalls = new Map<string, { name: string; input: string; approve: boolean }>()
// Guest: the ride each running turn is showing, while it shows it.
const liveRuns = new Map<string, RideRun>()
// Guest: each tool call the host's Claude made is drawn as a call of this
// plugin's own tool, answered with the host's result: the card a session
// draws for its own calls, and nothing runs on this machine. By card id.
const REPLAY_TOOL = 'mcp__shared-session__replay'
const hostCalls = new Map<string, { hostId: string; seq: number; turnId?: string; result?: string; images?: RoomImage[] }>()
// Guest: an earlier exchange's turn whose calls were shown, owed its last words.
const staticRuns = new Map<string, { tail: string }>()
const EXCHANGE_CARDS = 200 // calls drawn as cards in one earlier exchange; the rest as text

// Terminal: consecutive replayed reads, searches and shell commands fold into
// one count line, as the terminal folds its own. The engine groups by the
// tool that ran (this one, never grouped, and a registered tool can't say
// otherwise), so the plugin keeps the runs it made: the first call of a run
// draws the line, the rest draw nothing. Other calls keep their own rows.
type ReplayRun = { first: string; tools: string[]; ids: string[] }
const replayRuns = new Map<string, ReplayRun>()
const openRuns = new Map<string, ReplayRun | null>() // a live turn's run so far
const COLLAPSIBLE = /^(Read|Grep|Glob|Bash|LS)$/
function joinRun(run: ReplayRun | null, id: string, tool: string): ReplayRun | null {
  if (!COLLAPSIBLE.test(tool)) return null
  const joined = run ?? { first: id, tools: [], ids: [] }
  joined.tools.push(tool)
  joined.ids.push(id)
  replayRuns.set(id, joined)
  if (replayRuns.size > 5000) replayRuns.delete(replayRuns.keys().next().value as string)
  return joined
}
// Kept in the session's state, so a reload (an update in place) draws the
// rows it redraws the same: each call's row reads its own member.
async function saveRun($: $, run: ReplayRun) {
  for (const id of run.ids) await $.state.set({ plugin: 'shared-session', key: 'replayRun', id }, id === run.first ? { tools: [...run.tools] } : { hidden: true })
}

// In the terminal's own words: "Searched for 2 patterns, read 3 files".
function runLine(run: { tools: string[] }): string {
  const n = (re: RegExp) => run.tools.filter(t => re.test(t)).length
  const searched = n(/^(Grep|Glob)$/)
  const read = n(/^Read$/)
  const listed = n(/^LS$/)
  const ran = n(/^Bash$/)
  const parts = [
    searched ? `searched for ${searched} ${searched === 1 ? 'pattern' : 'patterns'}` : '',
    read ? `read ${read} ${read === 1 ? 'file' : 'files'}` : '',
    listed ? `listed ${listed} ${listed === 1 ? 'directory' : 'directories'}` : '',
    ran ? `ran ${ran} shell ${ran === 1 ? 'command' : 'commands'}` : '',
  ].filter(Boolean)
  const line = parts.join(', ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

// An earlier exchange as one response: its text, and each call a card with
// the result the room kept (preset, so the card answers at once), up to its
// last call; the words after that are the tail, said in the next step.
type HistoryBlock = { text: string } | { id: string; input: Record<string, unknown> }
function historyBlocks(rows: Row[]): { blocks: HistoryBlock[]; tail: string; runs: ReplayRun[] } {
  const results = new Map(rows.filter(r => r.kind === 'result' && r.id).map(r => [r.id as string, r]))
  const blocks: HistoryBlock[] = []
  const replayed = new Set<string>()
  let text = ''
  let run: ReplayRun | null = null
  const runs = new Set<ReplayRun>()
  for (const row of rows) {
    // Every call a card here, a page the host opened too: what's still open
    // is handed over after the history, not reopened at each step of it.
    if (row.kind === 'tool' && replayReady && row.id && row.input && row.tool && replayed.size < EXCHANGE_CARDS) {
      if (text.trim()) {
        blocks.push({ text: text.trim() })
        run = null // words between calls end a run
      }
      text = ''
      const id = `toolu_${newId()}${newId()}`
      run = joinRun(run, id, row.tool)
      if (run) runs.add(run)
      const res = results.get(row.id)
      hostCalls.set(id, { hostId: row.id, seq: 0, result: res ? `${res.isError ? 'Error: ' : ''}${stripLineNumbers(res.text)}` : '(no result)', images: res?.images })
      if (hostCalls.size > 3000) hostCalls.delete(hostCalls.keys().next().value as string)
      blocks.push({ id, input: { tool: row.tool, summary: row.text, input: row.input } })
      replayed.add(row.id)
      continue
    }
    if (row.kind === 'result' && row.id && replayed.has(row.id)) continue
    text += `${rowsToMarkdown([row])}\n\n`
  }
  return { blocks, tail: text.trim(), runs: [...runs] }
}
let replayReady = false
// Calls that show something (a file, a widget, a page) are made again here
// instead (replayOf), so their rows stay out of the card replay.
const VIEWER_TOOL = /^(SendUserFile|Artifact)$|show_widget$|^mcp__Claude_Browser__(preview_start|navigate)$|^mcp__ccd_view__show_pane$/
const ridesInStep = new Map<string, RideRun>()

type RideState = {
  current: HostTurn | null
  streamed: boolean
  done: boolean
  // What the host's Claude showed during the turn, still to show here: each
  // one becomes a step of this turn that makes the same call locally.
  actions: ServerEvent[]
  // Host calls drawn as cards: their results are the cards', not text.
  native?: Set<string>
}

// A file read's lines come numbered ("   12\tcode"), as the host's Read gave them.
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
    // A message relayed from here, gone into a turn already running on the
    // host's side: that turn is its own from here, and its end ends this.
    if (row.kind === 'user' && ride.kind === 'own' && row.pid === ride.pid && current.pid !== ride.pid) {
      current.pid = ride.pid
      ownPending.delete(ride.pid)
    }
    if (row.kind === 'user') return ''
    if (row.kind === 'assistant') {
      // Its text already streamed as deltas, unless those were missed.
      const streamed = state.streamed
      state.streamed = false
      return streamed ? '\n\n' : `${row.text}\n\n`
    }
    state.streamed = false
    if (row.kind === 'tool') {
      if (replayReady && row.id && row.input && row.tool && !VIEWER_TOOL.test(row.tool)) {
        ;(state.native ??= new Set()).add(row.id)
        state.actions.push(event)
        return ''
      }
      const head = `\n\n${toolGlyph(row.tool ?? '')} **${row.tool}** ${row.text ? `\`${row.text.replaceAll('`', "'")}\`` : ''}\n`
      if (row.detail && (row.tool === 'Edit' || row.tool === 'Write')) {
        return `${head}\n\`\`\`${row.tool === 'Edit' ? 'diff' : ''}\n${row.detail}\n\`\`\`\n`
      }
      return head
    }
    if (row.kind === 'result') {
      if (row.id && state.native?.has(row.id)) return ''
      return `  ⎿ ${row.isError ? '**Error:** ' : ''}${(stripLineNumbers(row.text).split('\n')[0] ?? '').slice(0, 200)}\n\n`
    }
  }
  if (event.type === 'artifact' && body.turnId === current.turnId) {
    state.actions.push(event)
    return ''
  }
  if (event.type === 'approval' && body.pending && typeof body.what === 'string') {
    return `\n> ◷ Waiting for **${host}** to allow \`${body.what}\`\n\n`
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
  connection: 'live' | 'reconnecting'
  confirming: 'stop' | null
  asking: { prompts: number } | null
}

async function view($: $): Promise<View> {
  // What the engine draws, before anything is drawn for it.
  modern = isModern(await $.env.get('AI_AGENT'))
  const room = await read($, roomA)
  return {
    mode: await read($, modeA),
    room,
    me: room?.seat ?? 'host',
    everyone: await read($, peopleA),
    working: await read($, workingA),
    policy: await read($, policyA),
    unread: await read($, unreadA),
    connection: await read($, connectionA),
    confirming: await read($, confirmingA),
    asking: await read($, askingA),
  }
}

// One face per name (a person in two sessions is still one person).
// This session's own entry: its seat, or one of the seats of the person it is.
const isMe = (p: SharePerson, me: string) => p.id === me || Boolean(p.seats?.includes(me))

function faces(v: View, colors: Map<string, string> = roomColors(v.everyone)): Face[] {
  const seen = new Map<string, Face>()
  for (const p of v.everyone) {
    const known = seen.get(p.name)
    const note = [p.role === 'host' ? 'host' : '', isMe(p, v.me) ? 'you' : '', p.online ? '' : 'away'].filter(Boolean).join(' · ')
    const face: Face = {
      name: p.name,
      online: p.online || Boolean(known?.online),
      note,
      active: v.working?.by === p.name,
      version: p.version ?? known?.version,
      color: colors.get(p.name) ?? colorFor(p.name),
    }
    if (!known || (!known.online && p.online)) seen.set(p.name, face)
  }
  // The host first, then whoever is here; labels tell same-initial people apart.
  const labels = labelsFor([...seen.keys()])
  for (const face of seen.values()) face.label = labels.get(face.name)
  return [...seen.values()].sort((a, b) => Number(b.note?.includes('host')) - Number(a.note?.includes('host')) || Number(b.online) - Number(a.online))
}

function presence(v: View): string {
  const others = [...new Set(v.everyone.filter(p => p.online && p.role === 'guest' && !isMe(p, v.me)).map(p => p.name))]
  // "Sharing with Acme" already says with: the people are just here.
  if (v.mode === 'host' && v.room?.team) return others.length ? `${listNames(others)} here` : 'no one has joined yet'
  if (v.mode === 'host') return others.length ? `with ${listNames(others)}` : 'waiting for people to join'
  const hostAway = !v.everyone.some(p => p.role === 'host' && p.online)
  return [others.length ? `with ${listNames(others)}` : '', hostAway ? `${v.room?.host} is away` : ''].filter(Boolean).join(' · ')
}

function describe(a: ShareActivity): string {
  switch (a.kind) {
    case 'join':
      return `${a.who} joined`
    case 'leave':
      return a.text === 'timeout' ? `${a.who} lost connection` : a.text === 'removed' ? `${a.who} left: no longer in the team` : `${a.who} left`
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
    case 'shown':
      return `${a.who}'s Claude showed ${a.text ?? 'something'}`
  }
}

// Share pressed in a session with history: everything earlier would go to
// everyone with the link, so the row (or the Room) asks first.
function shareChoice($: $, el: UI, prompts: number, where: 'band' | 'room', surface: RenderSurface, team: string | null) {
  const { Box, Text, Button } = el
  const go = (history: boolean, surface?: RenderSurface) =>
    void inShareTurn($, () => share($, surface, { history })).catch(error => {
      $.ui.toast("Couldn't share")
      $.ui.log(`Couldn't share: ${String(error?.message ?? error)}`)
    })
  const who = team ? `Everyone in ${team}` : 'Everyone with the link'
  const what = `${who} will see its ${prompts} earlier prompt${prompts === 1 ? '' : 's'} and Claude's replies.`
  const buttons = (
    <Box flexDirection="row" gap={1} flexShrink={0}>
      <Button key="share-all" label="Share everything" variant="primary" onPress={press => go(true, press.surface)} />
      <Button key="share-new" label="Only from now on" onPress={press => go(false, press.surface)} />
      <Button key="share-cancel" label="Cancel" plain dimColor onPress={() => void update($, askingA, () => null)} />
    </Box>
  )
  if (where === 'room') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Share this session?</Text>
        <Text dimColor>{what}</Text>
        {buttons}
      </Box>
    )
  }
  // The row asks in its one line: the question, then its answers. Too narrow
  // for both, the answers go under it: what everyone would see is never cut.
  return (
    <Box flexDirection="row" flexWrap="wrap" gap={2} alignItems="center" justifyContent="space-between" paddingRight={surface === 'terminal' ? 4 : 0}>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={36}>
        <Text bold>Share this session?</Text>
        <Text dimColor>{what}</Text>
      </Box>
      {buttons}
    </Box>
  )
}

// What joining did, as the first reply in the guest's transcript.
async function joinedNote($: $, joined: Awaited<ReturnType<typeof join>>): Promise<string> {
  const { room, history, fromNow } = joined
  const policy = await read($, policyA)
  return [
    `You joined **${room.host}'s session**${room.team ? ` in ${room.team.name}` : ''}.`,
    policy.prompts === 'watch'
      ? `It's watch-only for now: you see every turn live and can chat with everyone in the **Room**.`
      : `What you type here runs there, on ${room.host}'s machine, and everyone sees the replies live.`,
    `The **Room** (above the prompt, or \`/room\`) shows who's here and has a side chat Claude doesn't read. **Leave** is up there too.${history.length ? ` What happened before you joined follows, ${history.length === 1 ? 'one prompt' : `${history.length} prompts`} with their replies.` : fromNow ? ` ${room.host} shared from that point on, so what came before isn't shown.` : ''}`,
  ].join(' ')
}

// Why a link didn't join, in words a person can act on.
function joinFailure(error: unknown, server: string): string {
  if (error instanceof PlainServer) return error.message
  // A team's session: who may join is the team's to say.
  if (error instanceof ApiError && typeof error.data.team === 'string' && (error.status === 401 || error.status === 403)) {
    return error.data.signIn
      ? `This session is for **${error.data.team}**. Sign in with an account in that team in the **Team** panel (it just opened, or \`/team\`), then paste the link again.`
      : `${error.message} Once you're in, paste the link again.`
  }
  if (isGone(error)) return "That shared session has ended: the host stopped sharing, or the room expired. Ask them for a new link."
  if (error instanceof ApiError) return `Couldn't join that shared session: ${error.message}`
  // Only a request that got no answer is the network; anything else says what it was.
  if (error instanceof NetworkError) return `Couldn't reach the share server at ${server}. Check your connection, then paste the link again.`
  return `Couldn't join that shared session: ${String((error as Error)?.message ?? error)}. Paste the link again; if it keeps happening, the update command may help: \`${UPDATE_COMMAND}\``
}

// What a guest may do here, in a line.
function rulesLine(policy: SharePolicy, host: string): string {
  if (policy.prompts === 'watch') return `◎ Watch-only: you follow along and chat; ${host} prompts Claude`
  const asks =
    policy.approvals === 'none' ? 'nothing asks first' : policy.approvals === 'all' ? `every tool asks ${host} first` : `anything beyond reading the project asks ${host} first`
  return `✎ Everyone can prompt · ${asks}`
}

const shownGlyph = (item: ShareShown) => (item.kind === 'preview' ? '◍' : item.kind === 'widget' ? '◆' : item.kind === 'link' ? '↗' : '◧')

// Vector drawings only where the surface paints them: Claude Desktop. A
// terminal's table can carry an Svg it draws as nothing, so there the
// letters-and-dots fallbacks are drawn instead.
const svgOf = (el: UI, surface: RenderSurface) => (surface === 'desktop' && 'Svg' in el ? el.Svg : undefined)
// Fields and pickers: every surface but mobile draws them.
const inputOf = (el: UI) => ('Input' in el ? el.Input : undefined)
const selectOf = (el: UI) => ('Select' in el ? el.Select : undefined)
// A region that moves on the surface's own clock: the terminal and the desktop.
const clientOf = (el: UI) => ('Client' in el ? el.Client : undefined)

// The Room's Copy says Copied for a moment after it worked.
async function flashCopied($: $) {
  await update($, copiedA, () => true)
  $.clock.after(1_500, () => void update($, copiedA, () => false))
}

// A teammate's name put in the prompt box, to mention them.
async function mention($: $, name: string) {
  const filled = await $.prompt.fill({ text: `@${name} `, mode: 'insert' }).catch(() => null)
  if (!filled?.isFilled) $.ui.toast(`Type @${name} in your prompt to mention them`)
}

// ---------------------------------------------------------------------------
// The pieces every surface is built from: a person's face and name in their
// own color, a status chip, a panel's pages.

// Everyone's colors in this room: the people here and anyone the chat or the
// activity names, so a name keeps its color after its person leaves.
function roomColors(people: readonly { name: string; role?: string }[], also: readonly string[] = []): Map<string, string> {
  const hostFirst = [...people.filter(p => p.role === 'host'), ...people.filter(p => p.role !== 'host')]
  return colorsFor([...hostFirst.map(p => p.name), ...also])
}

// A face: a filled dot in the person's color on the desktop, a colored mark
// in a terminal.
function faceOf(el: UI, surface: RenderSurface, f: Face, size = 24) {
  const Svg = svgOf(el, surface)
  const { Text } = el
  const color = f.color ?? colorFor(f.name)
  return Svg ? <Svg source={avatarSvg({ ...f, color }, size)} alt={f.name} width={size} height={size} /> : <Text color={color}>{f.online ? '●' : '○'}</Text>
}

// A panel's pages, side by side: the one showing drawn as the pressed
// button, a count beside a label (in Claude's orange when it's news), each a
// digit from picked where the panel holds the keys.
type Tab<T extends string> = { id: T; label: string; count?: number; news?: boolean }
function tabsOf<T extends string>(el: UI, tabs: readonly Tab<T>[], current: T, pick: (id: T) => void) {
  const { Box, Button, Text } = el
  return (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      {tabs.map((t, i) => {
        const on = t.id === current
        return (
          <Button
            key={`tab-${t.id}`}
            label={t.count ? `${t.label} ${t.count}` : t.label}
            hotkey={String(i + 1)}
            variant={on ? 'secondary' : undefined}
            plain={on ? undefined : true}
            dimColor={!on && !t.news}
            onPress={() => pick(t.id)}
          >
            <Text bold={on}>{t.label}</Text>
            {t.count ? (
              <Text color={t.news ? 'claude' : undefined} dimColor={!t.news} bold={t.news}>
                {` ${t.count}`}
              </Text>
            ) : null}
          </Button>
        )
      })}
    </Box>
  )
}

// A page's heading: its name, and on the right what it holds or its action.
function headingOf(el: UI, title: string, right?: RenderChildren) {
  const { Box, Text } = el
  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
      <Text bold>{title}</Text>
      {typeof right === 'string' ? <Text dimColor>{right}</Text> : (right ?? null)}
    </Box>
  )
}

// A setting: its name in a fixed column, the picker beside it.
function settingOf(el: UI, label: string, picker: RenderChildren) {
  const { Box, Text } = el
  return (
    <Box flexDirection="row" alignItems="center" gap={1}>
      <Box width="40%" flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1}>{picker}</Box>
    </Box>
  )
}

// A moment of the host's step in words: "Writing notes.md · 4k characters".
function doingLine(d: ShareDoing): string {
  const what = d.target || d.tool || ''
  if (d.kind === 'thinking') return 'Thinking'
  if (d.kind === 'writing') {
    const size = d.chars && d.chars >= 1000 ? ` · ${Math.round(d.chars / 1000)}k characters` : ''
    const verb = d.tool === 'Write' ? 'Writing' : d.tool === 'Edit' || d.tool === 'MultiEdit' || d.tool === 'NotebookEdit' ? 'Editing' : d.tool === 'Bash' ? 'Writing a command:' : `Preparing ${d.tool}`
    return `${verb}${what && what !== d.tool ? ` ${what}` : ''}${size}`
  }
  const verb = d.tool === 'Bash' ? 'Running' : d.tool === 'Read' ? 'Reading' : d.tool === 'Grep' || d.tool === 'Glob' ? 'Searching' : d.tool === 'WebFetch' || d.tool === 'WebSearch' ? 'Looking up' : d.tool === 'Agent' || d.tool === 'Task' ? 'An agent is on' : `Running ${d.tool}`
  return `${verb}${what && what !== d.tool ? ` ${what}` : ''}`
}

// What's happening in the room, beside its name in the row above the prompt:
// whose turn it is (their name in their color), else who's here.
// Host: whose call the working line's wait is for. A teammate's agent can
// ask in another person's turn (`callOwner`), so it's the waiting call's
// owner, not the turn's.
const waitingWho = (w: ShareWorking) => approvals.find(a => a.what === w.waitingFor)?.who || w.by

function nowOf(el: UI, v: View, colors: Map<string, string>) {
  const { Text } = el
  const host = v.room?.host ?? 'the host'
  const w = v.working
  const named = (name: string) => (
    <Text bold color={colors.get(name) ?? colorFor(name)}>
      {name}
    </Text>
  )
  if (v.connection === 'reconnecting') return <Text dimColor wrap="truncate-end">what you send goes out once it's back</Text>
  if (w && (v.mode === 'guest' || w.byGuest)) {
    if (w.waitingFor) {
      return v.mode === 'host' ? (
        <Text wrap="truncate-end">
          {named(waitingWho(w))}
          <Text dimColor>{` is waiting for your OK on ${w.waitingFor}`}</Text>
        </Text>
      ) : (
        <Text dimColor wrap="truncate-end">{`waiting for ${host} to allow ${w.waitingFor}`}</Text>
      )
    }
    if (v.mode === 'guest' && w.doing) return <Text color="claude" wrap="truncate-end">{doingLine(w.doing)}</Text>
    if (v.mode === 'guest' && w.by === myName) return <Text color="claude" wrap="truncate-end">Claude is working on your prompt</Text>
    return (
      <Text wrap="truncate-end">
        <Text color="claude">Claude is working for </Text>
        {named(w.by)}
      </Text>
    )
  }
  if (v.policy.prompts === 'watch') return <Text dimColor wrap="truncate-end">{v.mode === 'host' ? 'watch-only' : `watch-only: ${host} prompts, you chat`}</Text>
  const here = presence(v)
  return here ? <Text dimColor wrap="truncate-end">{here}</Text> : null
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Teams: sign in with GitHub or Google, and what's shared goes to your team.
// The Team panel lists the sessions its people share, each a press from
// joining; their access setting (members only, or anyone with the link) is
// the server's to enforce at every join. The sign-in is the share server's
// token, kept in shared-session/account.json in Claude Code's own folder
// (`configDirOf`, as the checkpoints and the settings are: ~/.claude unless
// CLAUDE_CONFIG_DIR names another; only this user can read it) per server,
// sent in a header to the server that gave it, never in an address or a
// process's arguments.

type SavedSignIn = { token: string; account: ShareAccount; /** The team Share goes to; null: by link alone; absent: the first team. */ current?: string | null }

async function accountFile($: $): Promise<string | null> {
  const dir = await configDirOf($)
  return dir ? `${dir}/shared-session/account.json` : null
}

async function readSignIns($: $): Promise<Record<string, SavedSignIn>> {
  const path = await accountFile($)
  const text = path ? await $.fs.read(path).catch(() => null) : null
  try {
    const data = JSON.parse(text ?? '') as { servers?: Record<string, SavedSignIn> }
    return data?.servers && typeof data.servers === 'object' ? data.servers : {}
  } catch {
    return {}
  }
}

async function signInFor($: $, server: string): Promise<SavedSignIn | null> {
  const saved = (await readSignIns($))[server]
  return saved && typeof saved.token === 'string' && saved.account ? saved : null
}

async function saveSignIn($: $, server: string, value: SavedSignIn | null) {
  const path = await accountFile($)
  if (!path) return
  const all = await readSignIns($)
  if (value) all[server] = value
  else delete all[server]
  await writeSignIns($, path, all)
}

// Written through a shell with a umask, so the file is never readable by
// anyone else, not even for a moment; the token goes on stdin.
async function writeSignIns($: $, path: string, all: Record<string, SavedSignIn>) {
  const body = JSON.stringify({ servers: all }, null, 2)
  const tag = fence(body)
  const tmp = `${path}.tmp`
  await sh($, `umask 077\nmkdir -p ${sq(path.replace(/\/[^/]+$/, ''))}\ncat > ${sq(tmp)} <<'${tag}'\n${body}\n${tag}\nchmod 600 ${sq(tmp)}\nmv ${sq(tmp)} ${sq(path)}\n`)
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('')
}

// The person's own browser (or Claude Desktop, for a claude:// link), and
// whether it opened, so a caller copies the address when it didn't.
// SHARED_SESSION_NO_BROWSER=1 (the end-to-end test) opens nothing. Over SSH
// a browser would open on another screen, if at all. On Linux xdg-open goes
// to the background (it can wait on the browser), where it always reports
// success: it's run only where a browser can show (a display).
async function openExternal($: $, url: string): Promise<boolean> {
  if ((await $.env.get('SHARED_SESSION_NO_BROWSER')) === '1') return false
  if ((await $.env.get('SSH_CONNECTION')) || (await $.env.get('SSH_TTY'))) return false
  const { code } = await sh($, `u=${sq(url)}\nif [ "$(uname)" = Darwin ]; then open "$u"\nelif [ -n "$DISPLAY$WAYLAND_DISPLAY" ] && command -v xdg-open >/dev/null 2>&1; then xdg-open "$u" >/dev/null 2>&1 &\nelse exit 1\nfi\n`)
  return code === 0
}

// A link element takes only https: (or http://localhost) addresses.
const linkable = (url: string) => /^https:\/\//.test(url) || /^http:\/\/localhost[:/]/.test(url)

// Who can join a room, said plainly.
function whoJoins(room: ShareRoom, team: ShareTeam | { access?: string } | null): string {
  if (!room.team) return 'Anyone with this link can join and prompt this session'
  if (team?.access === 'link') return `Everyone in ${room.team.name} sees it in their Team panel, and anyone with the link can join`
  return `Everyone in ${room.team.name} sees it in their Team panel and can join; the link works only for people in ${room.team.name}`
}

// The team Share goes to now, if any.
async function shareTeam($: $, server: string): Promise<{ id: string; name: string } | null> {
  const saved = await signInFor($, server)
  if (!saved || saved.current === null) return null
  let t = await read($, teamsA)
  if (t.server !== server || !t.account) {
    await refreshTeams($)
    t = await read($, teamsA)
  }
  const team = t.teams.find(x => x.id === saved.current) ?? (saved.current === undefined ? t.teams[0] : undefined)
  return team ? { id: team.id, name: team.name } : null
}

async function shareTeamName($: $): Promise<string | null> {
  const t = await read($, teamsA)
  if (!t.account || t.byLink || !t.current) return null
  return t.teams.find(x => x.id === t.current)?.name ?? null
}

// Who's signed in, their teams, and the shown team's sessions and people.
async function refreshTeams($: $) {
  let server: string
  try {
    server = await serverOf($)
  } catch {
    return
  }
  const before = await read($, teamsA)
  const saved = await signInFor($, server)
  // Signed out, the sign-in buttons are what's shown: asked for each time, so
  // a provider the server gains (or loses) shows up without a new session.
  const providers =
    saved && before.server === server && before.providers.length
      ? before.providers
      : await api<{ providers: { id: string; label: string }[] }>($, server, '/api/auth/providers')
          .then(r => r.providers)
          .catch(() => (before.server === server ? before.providers : []))
  const now = await $.clock.now()
  if (!saved) {
    await update($, teamsA, t => ({ ...NO_TEAMS, server, providers, signingIn: t.server === server ? t.signingIn : null, invite: t.invite, loaded: now }))
    return
  }
  try {
    const me = await api<{ account: ShareAccount; teams: ShareTeam[]; teammates?: ShareTeams['teammates'] }>($, server, '/api/me', { token: saved.token })
    // Shown: the team Share goes to, else (by link alone, or it's gone) the first.
    const current = (me.teams.find(x => x.id === saved.current) ?? me.teams[0])?.id ?? null
    const [sessions, detail] = current
      ? await Promise.all([
          api<{ sessions: ShareTeamSession[] }>($, server, `/api/teams/${current}/sessions`, { token: saved.token }).then(r => r.sessions),
          api<{ members: ShareTeams['members'] }>($, server, `/api/teams/${current}`, { token: saved.token }).then(r => r.members),
        ])
      : [[], []]
    const here = Object.fromEntries((await holdsElsewhere($).catch(() => [])).map(h => [h.room, h.mode]))
    await update($, teamsA, t => ({
      ...t,
      server,
      providers,
      account: me.account,
      teams: me.teams,
      teammates: me.teammates ?? [],
      here,
      current,
      byLink: saved.current === null,
      sessions,
      members: detail,
      signingIn: null,
      loaded: now,
      error: null,
    }))
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // The sign-in was ended (signed out elsewhere, the account deleted).
      await saveSignIn($, server, null)
      await update($, teamsA, () => ({ ...NO_TEAMS, server, providers, loaded: now, error: 'Your sign-in ended. Sign in again.' }))
      return
    }
    await update($, teamsA, t => ({ ...t, server, providers, loaded: now, error: `Couldn't reach the share server: ${String((error as Error)?.message ?? error)}` }))
  }
}

let signInRun = 0

// What the server's page shows for a sign-in, from the hash this session
// sent (its first eight hex, `XXXX-XXXX`): whoever makes a sign-in link
// picks its hash, so the page's Continue is only for a code that matches.
const signInCode = (login: string) => `${login.slice(0, 4)}-${login.slice(4, 8)}`.toUpperCase()
const codeSaid = (code: string) => `Your browser will show the code ${code}: continue there only if it matches.`

// Opens the server's sign-in in the browser with the hash of a secret kept
// here, then asks for the sign-in with that secret every 2 s for ten minutes.
// `said`: the caller says the code itself (a command's reply); else a toast.
async function startSignIn($: $, provider: string, opts: { said?: boolean } = {}): Promise<{ url: string; code: string }> {
  const server = await serverOf($)
  const verifier = randomSecret()
  const t = await read($, teamsA)
  const invite = t.invite && t.invite.server === server ? `&invite=${encodeURIComponent(t.invite.code)}` : ''
  const login = await sha256Hex(verifier)
  const code = signInCode(login)
  const url = `${server}/auth/${encodeURIComponent(provider)}/start?login=${login}${invite}`
  const run = ++signInRun
  const until = (await $.clock.now()) + 10 * 60_000
  await update($, teamsA, x => ({ ...x, server, signingIn: { provider, url, until, code }, error: null }))
  await openExternal($, url)
  if (!opts.said) $.ui.toast(codeSaid(code))
  const tick = async () => {
    if (run !== signInRun) return
    if ((await $.clock.now()) > until) {
      await update($, teamsA, x => ({ ...x, signingIn: null }))
      return
    }
    const r = await api<{ status: string; token?: string; account?: ShareAccount; joined?: string | null }>($, server, '/api/auth/poll', { method: 'POST', body: { verifier } }).catch(() => null)
    if (run !== signInRun) return
    if (r?.status === 'done' && r.token && r.account) {
      signInRun++
      await saveSignIn($, server, { token: r.token, account: r.account, ...(r.joined ? { current: r.joined } : {}) })
      await update($, teamsA, x => ({ ...x, signingIn: null, invite: null }))
      $.ui.toast(`Signed in as ${r.account.name}`)
      await refreshTeams($)
      return
    }
    $.clock.after(2_000, () => void tick().catch(() => {}))
  }
  $.clock.after(2_000, () => void tick().catch(() => {}))
  return { url, code }
}

async function cancelSignIn($: $) {
  signInRun++
  await update($, teamsA, x => ({ ...x, signingIn: null }))
}

async function signOut($: $, opts: { deleteAccount?: boolean } = {}) {
  const server = await serverOf($)
  const saved = await signInFor($, server)
  if (saved) {
    await api($, server, opts.deleteAccount ? '/api/me' : '/api/auth/logout', { method: opts.deleteAccount ? 'DELETE' : 'POST', token: saved.token }).catch(() => {})
    await saveSignIn($, server, null)
  }
  await update($, teamsA, t => ({ ...NO_TEAMS, server, providers: t.providers }))
  $.ui.toast(opts.deleteAccount ? 'Account deleted' : 'Signed out')
}

// A call to the team API as the person signed in; their sign-in ending signs them out here.
async function teamCall<T>($: $, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const server = await serverOf($)
  const saved = await signInFor($, server)
  if (!saved) throw new ApiError('Sign in first: /team', 401)
  try {
    return await api<T>($, server, path, { ...init, token: saved.token })
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) await refreshTeams($)
    throw error
  }
}

// Which team Share goes to (and the panel shows): an id, or null for the link alone.
async function setCurrentTeam($: $, id: string | null) {
  const server = await serverOf($)
  const saved = await signInFor($, server)
  if (!saved) return
  await saveSignIn($, server, { ...saved, current: id })
  await refreshTeams($)
}

async function createTeam($: $, name: string): Promise<ShareTeam | null> {
  const trimmed = name.trim()
  if (!trimmed) return null
  const { team } = await teamCall<{ team: ShareTeam }>($, '/api/teams', { method: 'POST', body: { name: trimmed } })
  await setCurrentTeam($, team.id)
  $.ui.toast(`Made ${team.name}. Copy its invite link for your teammates`)
  return team
}

async function changeTeam($: $, body: Record<string, unknown>) {
  const t = await read($, teamsA)
  if (!t.current) return
  await teamCall($, `/api/teams/${t.current}`, { method: 'PATCH', body })
  await refreshTeams($)
}

async function newInvite($: $) {
  const t = await read($, teamsA)
  if (!t.current) return
  await teamCall($, `/api/teams/${t.current}/invite`, { method: 'POST' })
  await refreshTeams($)
  $.ui.toast('New invite link. The old one no longer works')
}

async function leaveTeam($: $) {
  const t = await read($, teamsA)
  const team = t.teams.find(x => x.id === t.current)
  if (!team) return
  await teamCall($, `/api/teams/${team.id}/members/me`, { method: 'DELETE' })
  const server = await serverOf($)
  const saved = await signInFor($, server)
  if (saved) await saveSignIn($, server, { ...saved, current: undefined })
  await refreshTeams($)
  $.ui.toast(`Left ${team.name}`)
}

const inviteUrl = (t: ShareTeams, team: ShareTeam) => `${t.server}/i/${team.invite}`

let teamOpen = false
let teamTimer: Timer | null = null

// The Team panel: fresh when it opens, and every 20 s while it's open.
async function openTeam($: $, page?: 'live' | 'people' | 'settings') {
  teamOpen = true
  if (page) await update($, teamTabA, () => page)
  // A session with no panels (a headless run) still answers in words.
  await $.ui.open({ id: TEAM, title: 'Team', focus: true, closeOnEscape: true, rows: 60 }).catch(() => {})
  void refreshTeams($).catch(() => {})
  if (!teamTimer) {
    teamTimer = $.clock.every(20_000, () => {
      if (teamOpen) void refreshTeams($).catch(() => {})
    })
  }
}

// Which sessions on this computer are in which room, so one person isn't in
// the same room twice: the Team panel, an invite and a pasted link open the
// session that's already in it instead. Each session writes its entry
// (`live:<room>:<session>`) when it shares or joins and every minute after;
// one not written for three minutes went away.
const LIVE_KEY = 'live:'
const LIVE_STALE_MS = 3 * 60_000
type LiveHold = { room: string; session: string; place: string; mode: 'host' | 'guest'; title: string; host: string; at: number }

async function holdRoom($: $) {
  const session = await $.session.id()
  const room = await read($, roomA)
  const mode = await read($, modeA)
  const mine = room && mode !== 'idle' ? `${LIVE_KEY}${room.id}:${session}` : ''
  for (const key of await $.store.keys()) if (key.startsWith(LIVE_KEY) && key.endsWith(`:${session}`) && key !== mine) await $.store.delete(key)
  if (!room || mode === 'idle') return
  await $.store.set(mine, { room: room.id, session, place: await placeOf($), mode, title: room.title, host: room.host, at: await $.clock.now() } satisfies LiveHold)
}

// Every room another live session here is in (`only`: just that one).
async function holdsElsewhere($: $, only?: string): Promise<LiveHold[]> {
  const session = await $.session.id()
  const now = await $.clock.now()
  const found: LiveHold[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(only ? `${LIVE_KEY}${only}:` : LIVE_KEY) || key.endsWith(`:${session}`)) continue
    const hold = (await $.store.get(key)) as LiveHold | undefined
    if (!hold || now - hold.at > LIVE_STALE_MS) await $.store.delete(key)
    else found.push(hold)
  }
  return found.sort((a, b) => b.at - a.at)
}

const heldElsewhere = async ($: $, roomId: string) => (await holdsElsewhere($, roomId))[0] ?? null

// Brings up the session that's in it: Claude Desktop opens it by its id. A
// terminal session can't be brought up from here.
async function openHeld($: $, hold: LiveHold): Promise<boolean> {
  if (!hold.place || !(await isDesktop($))) return false
  return openExternal($, `claude://claude.ai/epitaxy/${hold.place}`)
}

// What's said when a join finds a session here already in that room.
function alreadyIn(hold: LiveHold, opened: boolean): string {
  const where = hold.mode === 'host' ? "That's your own shared session, open in another Claude Code session" : `You're already in ${hold.host}'s session, in another Claude Code session`
  return `${where}${opened ? ': it just opened' : ` (“${tidyTitle(hold.title)}”)`}.`
}

// Joins sessions from the Team panel. The first joins here when this
// session is fresh; otherwise Claude Desktop opens a new session with its
// link ready (Desktop fills the prompt, the person presses Enter). Desktop
// holds one new-session draft at a time, so the rest wait in the store
// (`JOIN_QUEUE`, read by every session) and each session that joins one
// opens the next (`continueJoins`). In a terminal, the commands that start
// them are copied.
const JOIN_QUEUE = 'joinQueue'
type JoinQueue = { current: string; rest: { id: string; url: string }[]; at: number }
const deepLink = (url: string) => `claude://code/new?q=${encodeURIComponent(url)}`

async function joinFromTeam($: $, sessions: ShareTeamSession[], surface?: RenderSurface) {
  // In the room being taken back now, or not: it decides what Join does. A
  // Join that opens a new session leaves a late one be; one that joins here,
  // in a fresh session, gives it up (`join`).
  await takenBack($, { keep: true })
  const room = await read($, roomA)
  // A room a session here is already in opens there; Join all skips it.
  const list: ShareTeamSession[] = []
  for (const s of sessions.filter(s => s.id !== room?.id)) {
    const hold = await heldElsewhere($, s.id)
    if (!hold) list.push(s)
    else if (sessions.length === 1) return void $.ui.toast(alreadyIn(hold, await openHeld($, hold)))
  }
  const [first, ...rest] = list
  if (!first) return
  const fresh = (await read($, modeA)) === 'idle' && !localTurnActive && (await earlierPrompts($)) === 0
  const desktop = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'
  if (desktop) await $.store.set(JOIN_QUEUE, { current: first.id, rest: rest.map(s => ({ id: s.id, url: s.url })), at: await $.clock.now() } satisfies JoinQueue)
  const commands = (list: ShareTeamSession[]) =>
    copyText($, list.map(s => `claude ${sq(s.url)}`).join('\n'), list.length === 1 ? 'Command copied: run it in a new terminal to join' : `${list.length} commands copied: run each in its own terminal`, surface)
  if (fresh) {
    await $.ui.close({ id: TEAM }).catch(() => {})
    await joinHere($, first.url)
    if (!desktop && rest.length) await commands(rest)
    return
  }
  if (desktop && (await openExternal($, deepLink(first.url)))) {
    $.ui.toast(rest.length ? `Opened ${first.host}'s session: press Enter there to join. The other ${rest.length} open one after another as each joins` : `Opened ${first.host}'s session: press Enter there to join`)
    return
  }
  await commands([first, ...rest])
}

// A session joined the room Join all opened it for: the next one opens.
async function continueJoins($: $, joined: string) {
  const queue = (await $.store.get(JOIN_QUEUE).catch(() => undefined)) as JoinQueue | undefined
  if (!queue || queue.current !== joined) return
  const now = await $.clock.now()
  const [next, ...rest] = queue.rest
  if (!next || now - queue.at > 10 * 60_000) {
    await $.store.delete(JOIN_QUEUE).catch(() => {})
    return
  }
  await $.store.set(JOIN_QUEUE, { current: next.id, rest, at: now } satisfies JoinQueue)
  await openExternal($, deepLink(next.url))
}

// The Team panel's Stop on a session of yours: ends it for everyone by your
// sign-in, whichever session or computer shared it, even one that closed
// without saving its token. The first press asks, as the band's Stop does.
async function stopFromTeam($: $, roomId: string) {
  if (!(await pressedTwice($, `stop:${roomId}`))) return
  const server = await serverOf($)
  const saved = await signInFor($, server)
  if (!saved) return void $.ui.toast('Sign in first: /team')
  try {
    await api($, server, `/api/rooms/${roomId}/end`, { method: 'POST', account: saved.token })
    $.ui.toast('Stopped sharing. The link no longer works.')
  } catch (error) {
    // Already over: it only had to leave the list.
    if (!(error instanceof ApiError && (error.status === 404 || error.status === 410))) {
      $.ui.toast("Couldn't stop it")
      $.ui.log(`Couldn't stop sharing: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await refreshTeams($)
}

// The Team panel's Leave on a session you're in elsewhere: every seat of
// yours in it leaves by your sign-in, in other sessions here or on another
// computer, and those sessions hear they left. Asks once, as Stop does.
async function leaveFromTeam($: $, roomId: string) {
  if (!(await pressedTwice($, `leave:${roomId}`))) return
  const server = await serverOf($)
  const saved = await signInFor($, server)
  if (!saved) return void $.ui.toast('Sign in first: /team')
  try {
    await api($, server, `/api/rooms/${roomId}/leave`, { method: 'POST', account: saved.token })
    $.ui.toast('You left that session.')
  } catch (error) {
    if (!(error instanceof ApiError && (error.status === 404 || error.status === 410))) {
      $.ui.toast("Couldn't leave it")
      $.ui.log(`Couldn't leave: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await refreshTeams($)
}

// A button that ends something for everyone, or for you everywhere: the first
// press asks (its label changes for 5 s), the second goes ahead (true).
async function pressedTwice($: $, key: string): Promise<boolean> {
  if ((await read($, stoppingRoomA)) !== key) {
    await update($, stoppingRoomA, () => key)
    $.clock.after(5_000, () => void update($, stoppingRoomA, r => (r === key ? null : r)))
    return false
  }
  await update($, stoppingRoomA, () => null)
  return true
}

// The Team panel's Open: the session here that's in that room.
async function openHere($: $, roomId: string) {
  const hold = await heldElsewhere($, roomId)
  if (!hold) return void $.ui.toast('That session has closed')
  if (!(await openHeld($, hold))) $.ui.toast(alreadyIn(hold, false))
}

// In a fresh session: join, and the first turn says so and plays back what
// came before, as pasting the link does.
async function joinHere($: $, url: string) {
  const link = LINK.exec(url)
  if (!link?.[1] || !link[2]) return
  try {
    const joined = await join($, link[1], link[2])
    laterRides.unshift({ text: `Join ${joined.room.host}'s session`, ride: { kind: 'note', text: await joinedNote($, joined), then: joined.history, open: joined.open } })
    scheduleRides($)
    void continueJoins($, joined.room.id).catch(() => {})
  } catch (error) {
    $.ui.toast("Couldn't join")
    $.ui.log(joinFailure(error, link[1]).replace(/\*\*/g, ''))
  }
}

// An invite link pasted as a message: in the team now if signed in to its
// server, else once signed in (the Team panel opens for that).
async function takeInvite($: $, server: string, code: string): Promise<string> {
  const ours = await serverOf($).catch(() => '')
  if (server !== ours) {
    return `This invite is for the share server at ${server}, and this Claude Code shares through ${ours || 'another one'}. To use that team, set the plugin's server to ${server} (\`node scripts/setup.mjs host --server ${server}\` in the claude-share repo), then paste the link again.`
  }
  const saved = await signInFor($, server)
  if (saved) {
    try {
      const r = await api<{ team: ShareTeam; joined: boolean }>($, server, `/api/invites/${code}`, { method: 'POST', token: saved.token })
      await saveSignIn($, server, { ...saved, current: r.team.id })
      await openTeam($)
      return `${r.joined ? "You're in" : "You're already in"} **${r.team.name}**. The **Team** panel (it just opened, or \`/team\`) lists the sessions its people share; press **Join** on one. What you share now goes to ${r.team.name}.`
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) return `Couldn't use that invite: ${String((error as Error)?.message ?? error)}`
      await saveSignIn($, server, null)
    }
  }
  await update($, teamsA, t => ({ ...t, invite: { server, code } }))
  await openTeam($)
  return 'To join this team, sign in with GitHub or Google in the **Team** panel (it just opened, or `/team`). You join the team as soon as you\'re signed in.'
}

// Host: who an open room is shared with, a team or the link alone. Everyone already in stays.
async function setRoomTeam($: $, teamId: string | null) {
  const room = await read($, roomA)
  if (!room || (await read($, modeA)) !== 'host') return
  const saved = await signInFor($, room.server)
  try {
    const r = await api<{ team: { id: string; name: string } | null }>($, room.server, `/api/rooms/${room.id}/team`, { method: 'POST', token: room.token, account: saved?.token, body: { team: teamId } })
    await update($, roomA, rm => (rm ? { ...rm, team: r.team } : rm))
    $.ui.toast(r.team ? `Shared with ${r.team.name}` : 'Shared by link alone now')
    void refreshTeams($).catch(() => {})
  } catch (error) {
    $.ui.toast(`Couldn't change it: ${String((error as Error)?.message ?? error)}`)
  }
}

// /team, and its words for a terminal or a script.
async function teamCommand($: $, args: string): Promise<{ text: string }> {
  const [verb = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const arg = rest.join(' ')
  // `/team join` waits for a room being taken back as the Team panel's Join
  // does (`joinFromTeam`), before anything is read here: every read of one
  // dispatch sees one moment, so a wait after one would join as from then.
  if (verb.toLowerCase() === 'join') await takenBack($, { keep: true })
  const t0 = await read($, teamsA)
  try {
    switch (verb.toLowerCase()) {
      case '':
        await openTeam($)
        return { text: 'Opened the Team panel.' }
      case 'signin':
      case 'login': {
        await refreshTeams($)
        const t = await read($, teamsA)
        if (t.account) return { text: `Signed in as ${t.account.name}. /team signout to sign out.` }
        const provider = arg.toLowerCase() || (t.providers.length === 1 ? t.providers[0]?.id : '')
        if (!provider || !t.providers.some(p => p.id === provider)) {
          return { text: t.providers.length ? `Sign in with: ${t.providers.map(p => `/team signin ${p.id}`).join(' or ')}` : "This share server doesn't offer sign-in." }
        }
        const { url, code } = await startSignIn($, provider, { said: true })
        return { text: `Sign in with ${t.providers.find(p => p.id === provider)?.label ?? provider} in your browser; this session picks it up when you're done. ${codeSaid(code)} If no browser opened: ${url}` }
      }
      case 'signout':
      case 'logout':
        await signOut($)
        return { text: 'Signed out.' }
      case 'delete-account':
        await signOut($, { deleteAccount: true })
        return { text: 'Deleted your account on the share server: your sign-in, and your place in every team.' }
      case 'create': {
        const team = await createTeam($, arg)
        if (!team) return { text: 'Name it: /team create <name>' }
        return { text: `Made ${team.name}; what you share goes to it. Invite people with this link: ${(await read($, teamsA)).server}/i/${team.invite}` }
      }
      case 'invite': {
        const team = t0.teams.find(x => x.id === t0.current)
        if (!team) return { text: 'No team yet: /team create <name>' }
        await copyText($, inviteUrl(t0, team), 'Invite link copied')
        return { text: `Anyone who opens this link (and signs in) joins ${team.name}: ${inviteUrl(t0, team)}` }
      }
      case 'sessions':
      case 'list': {
        await refreshTeams($)
        const t = await read($, teamsA)
        const team = t.teams.find(x => x.id === t.current)
        if (!t.account) return { text: 'Sign in first: /team signin' }
        if (!team) return { text: 'No team yet: /team create <name>, or paste an invite link.' }
        if (!t.sessions.length) return { text: `Nothing is shared with ${team.name} right now.` }
        return { text: [`Shared with ${team.name}:`, ...t.sessions.map((s, i) => `${i + 1}. ${s.title} (${s.host}${s.hostOnline ? '' : ', away'}): ${s.url}`), '', 'Paste a link to join, or /team join all.'].join('\n') }
      }
      case 'invites': {
        const server = await serverOf($)
        const saved = await signInFor($, server)
        if (!saved) return { text: 'Sign in first: /team signin' }
        const list = (await api<{ invites: ShareInvite[] }>($, server, '/api/me/invites', { token: saved.token })).invites
        await update($, invitesA, () => list)
        if (!list.length) return { text: 'No invites right now.' }
        return { text: ['Invited:', ...list.map((i, n) => `${n + 1}. ${i.room.title} (from ${i.from.name}): ${i.room.url}`), '', 'Paste a link to join.'].join('\n') }
      }
      case 'join': {
        await refreshTeams($)
        const t = await read($, teamsA)
        const pick = arg.toLowerCase() === 'all' ? t.sessions : t.sessions.filter((_, i) => String(i + 1) === arg)
        if (!pick.length) return { text: 'Which? /team join <number from /team sessions>, or /team join all' }
        await joinFromTeam($, pick)
        return { text: `Joining ${pick.length === 1 ? pick[0]?.title : `${pick.length} sessions`}.` }
      }
      case 'use': {
        await refreshTeams($)
        const t = await read($, teamsA)
        if (arg.toLowerCase() === 'link') {
          await setCurrentTeam($, null)
          return { text: 'Share now goes by link alone.' }
        }
        const team = t.teams.find(x => x.name.toLowerCase() === arg.toLowerCase() || x.id === arg)
        if (!team) return { text: `Your teams: ${t.teams.map(x => x.name).join(', ') || 'none'}. /team use <name> or /team use link` }
        await setCurrentTeam($, team.id)
        return { text: `Share now goes to ${team.name}.` }
      }
      case 'access': {
        const access = arg.toLowerCase()
        if (access !== 'members' && access !== 'link') return { text: '/team access members (only people in the team join its sessions) or /team access link (anyone with a link)' }
        await changeTeam($, { access })
        return { text: access === 'members' ? 'Only people in the team join its sessions now.' : 'Anyone with a link joins the team\'s sessions now.' }
      }
      case 'domains':
        await changeTeam($, { domains: arg })
        return { text: arg ? `People who sign in with a verified email at ${arg} join by themselves.` : 'No email domain joins by itself now.' }
      case 'orgs':
        await changeTeam($, { githubOrgs: arg })
        return { text: arg ? `People in the GitHub organization${rest.length > 1 ? 's' : ''} ${arg} join by themselves when they sign in with GitHub.` : 'No GitHub organization joins by itself now.' }
      case 'leave':
        await leaveTeam($)
        return { text: 'Left the team.' }
      default:
        return { text: '/team opens the Team panel. Also: /team signin [github|google], /team create <name>, /team invite, /team invites, /team sessions, /team join <n|all>, /team use <name|link>, /team access members|link, /team domains <a.com …>, /team orgs <org …>, /team leave, /team signout, /team delete-account' }
    }
  } catch (error) {
    return { text: `Couldn't: ${String((error as Error)?.message ?? error)}` }
  }
}

// ---------------------------------------------------------------------------
// Session invites: a host invites teammates (by account) to the session it
// shares, and each one's Claude Code shows it above the prompt and in the
// Team panel, no link to pass around. A machine's sessions share one copy
// in the store; whichever finds it older than 30 s asks the server, so ten
// open sessions make one request, not ten.

const INVITES_KEY = 'sessionInvites'
const INVITES_EVERY_MS = 30_000
// `notified`: the invites this machine already raised a notification for.
type InviteCache = { at: number; server: string; list: ShareInvite[]; notified?: string[] }
const inviteKey = (i: ShareInvite) => `${i.room.id}@${i.at}`
// What a prompt says, for a title: its first line of words, without the notes
// Claude Code writes into a message ("[Image: original 1280x14646, …]",
// "[Pasted text #1 +40 lines]") or tags.
function promptWords(text: string): string {
  const clean = text.replace(/\[(?:Image|Pasted text|image)[^\]]*\]/g, ' ').replace(/<[^>\n]{1,200}>/g, ' ')
  return (clean.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '').trim()
}

// A session title for a narrow row: such notes left out, and an absolute path
// in it (a file the first prompt @-mentioned) shortened to its last part.
const tidyTitle = (title: string) => {
  const colon = title.indexOf(': ')
  const words = promptWords(colon > 0 ? title.slice(colon + 2) : title)
  const shown = colon > 0 ? (words ? `${title.slice(0, colon)}: ${words}` : title.slice(0, colon)) : words || title
  return shown.replace(/@?["']?(?<![:\w/])\/(?:[^\s"'/]+\/){2,}([^\s"'/]*)["']?/g, '$1')
}
// Whether a new invite raises a desktop notification (machine-wide, on unless turned off).
const NOTIFY_KEY = 'inviteNotify'

const sameInvites = (a: ShareInvite[], b: ShareInvite[]) =>
  a.length === b.length && a.every((x, i) => x.room.id === b[i]?.room.id && x.at === b[i]?.at && x.room.title === b[i]?.room.title)

async function pollInvites($: $) {
  let server: string
  try {
    server = await serverOf($)
  } catch {
    return
  }
  const saved = await signInFor($, server)
  if (!saved) {
    if ((await read($, invitesA)).length) await update($, invitesA, () => [])
    return
  }
  const now = await $.clock.now()
  const cache = (await $.store.get(INVITES_KEY).catch(() => undefined)) as InviteCache | undefined
  let list = cache?.server === server ? cache.list : []
  if (!cache || cache.server !== server || now - cache.at >= INVITES_EVERY_MS) {
    // Claimed first, so the machine's other sessions wait for this answer.
    const notified = cache?.server === server ? (cache.notified ?? []) : []
    await $.store.set(INVITES_KEY, { at: now, server, list, notified } satisfies InviteCache).catch(() => {})
    try {
      list = (await api<{ invites: ShareInvite[] }>($, server, '/api/me/invites', { token: saved.token })).invites
      // The session that fetched raises the notifications, once per invite for the machine.
      const fresh = list.filter(i => !notified.includes(inviteKey(i)))
      await $.store.set(INVITES_KEY, { at: now, server, list, notified: list.map(inviteKey) } satisfies InviteCache).catch(() => {})
      if (fresh.length && (await $.store.get(NOTIFY_KEY).catch(() => undefined)) !== false) {
        for (const invite of fresh.slice(0, 3)) await notifyInvite($, invite).catch(() => {})
      }
    } catch {}
  }
  const had = await read($, invitesA)
  if (sameInvites(had, list)) return
  await update($, invitesA, () => list)
  // In a room, this session's row is the room's: a new invite says so once,
  // and waits as a button in the row.
  const fresh = list.find(i => !had.some(h => inviteKey(h) === inviteKey(i))) // a new one, or one sent again
  if (fresh && (await read($, modeA)) !== 'idle') $.ui.toast(`${fresh.from.name} invites you to ${tidyTitle(fresh.room.title)}`)
}

// A desktop notification for an invite: the terminal's own channel where
// there is one (iTerm2, kitty, Ghostty); else (Claude Desktop, other
// terminals) the system's: macOS's notification centre, or notify-send.
async function notifyInvite($: $, invite: ShareInvite) {
  const title = `${invite.from.name} invites you`
  const body = `${invite.room.title} · Join it from Claude Code, above the prompt`
  const sent = await $.ui.notify(body, { title }).catch(() => null)
  if (sent?.isSent) return
  // A test's sessions (SHARED_SESSION_NO_BROWSER=1) open and raise nothing on the machine.
  if ((await $.env.get('SHARED_SESSION_NO_BROWSER')) === '1') return
  const as = (text: string) => `"${text.slice(0, 200).replace(/[\\"]/g, c => `\\${c}`)}"`
  await sh(
    $,
    [
      'if command -v osascript >/dev/null 2>&1; then',
      `  osascript -e ${sq(`display notification ${as(body)} with title ${as(title)} subtitle "Shared Sessions"`)} >/dev/null 2>&1`,
      'elif command -v notify-send >/dev/null 2>&1; then',
      `  notify-send ${sq(title)} ${sq(body)} >/dev/null 2>&1`,
      'fi',
      '',
    ].join('\n'),
  )
}

// An invite answered (joined or set aside): gone here, in the machine's other
// sessions at their next look, and on the server.
async function dropInvite($: $, roomId: string) {
  await update($, invitesA, list => list.filter(i => i.room.id !== roomId))
  const cache = (await $.store.get(INVITES_KEY).catch(() => undefined)) as InviteCache | undefined
  if (cache) await $.store.set(INVITES_KEY, { ...cache, list: cache.list.filter(i => i.room.id !== roomId) }).catch(() => {})
  const server = await serverOf($).catch(() => '')
  const saved = server ? await signInFor($, server) : null
  if (saved) await api($, server, `/api/me/invites/${encodeURIComponent(roomId)}`, { method: 'DELETE', token: saved.token }).catch(() => {})
}

// Join an invited session the way the Team panel joins one: here when this
// session is fresh, else in a new one with its link ready.
async function joinInvited($: $, invite: ShareInvite, surface?: RenderSurface) {
  // Before anything's read, as the Team panel's Join waits.
  await takenBack($, { keep: true })
  await dropInvite($, invite.room.id)
  await joinFromTeam($, [{ id: invite.room.id, url: invite.room.url, title: invite.room.title, host: invite.room.host, hostOnline: true, people: [], createdAt: invite.at }], surface)
}

// Host: invite teammates (account ids) to this session.
async function inviteToRoom($: $, ids: string[]): Promise<string> {
  const room = await read($, roomA)
  if (!room || (await read($, modeA)) !== 'host') return 'Share this session first: press Share or type /share-session.'
  const saved = await signInFor($, room.server)
  if (!saved) return 'Sign in first to invite teammates: press Team above the prompt, or /team signin.'
  const r = await api<{ invited: string[]; refused: string[] }>($, room.server, `/api/rooms/${room.id}/invite`, { method: 'POST', token: room.token, account: saved.token, body: { to: ids } })
  const now = await $.clock.now()
  await update($, invitedA, m => ({ ...m, ...Object.fromEntries(ids.filter(id => !r.refused.includes(id)).map(id => [id, now])) }))
  return r.invited.length ? `Invited ${listNames(r.invited)}: it shows in their Claude Code within a minute.` : "Couldn't invite them: you can invite people who share a team with you."
}

// /invite <name>: by name or GitHub login, a teammate's or several.
async function inviteCommand($: $, args: string): Promise<{ text: string }> {
  try {
    await refreshTeams($)
    const t = await read($, teamsA)
    if (!t.account) return { text: 'Sign in first to invite teammates: press Team above the prompt, or /team signin.' }
    const mates = t.teammates ?? []
    const wanted = args.split(/[,\s]+/).map(w => w.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
    if (!wanted.length) return { text: mates.length ? `Invite whom? ${mates.map(m => m.name).join(', ')}. /invite <name>` : 'No teammates to invite yet: make a team in /team and send its invite link.' }
    const picks = wanted.map(w => mates.find(m => m.name.toLowerCase() === w || m.login?.toLowerCase() === w) ?? mates.find(m => m.name.toLowerCase().startsWith(w) || m.login?.toLowerCase().startsWith(w)))
    const missing = wanted.filter((_, i) => !picks[i])
    if (missing.length) return { text: `No teammate called ${missing.join(', ')}. You can invite: ${mates.map(m => m.name).join(', ') || 'nobody yet'}.` }
    return { text: await inviteToRoom($, [...new Set(picks.map(m => m!.id))]) }
  } catch (error) {
    return { text: `Couldn't invite: ${String((error as Error)?.message ?? error)}` }
  }
}

// /share-session: shares, or in a session with earlier prompts asks first.
// What Claude is told when it asks for the share command itself.
async function shareAnswer($: $): Promise<string> {
  const mode = await read($, modeA)
  const room = await read($, roomA)
  if (mode === 'host' && room) {
    const here = [...new Set((await read($, peopleA)).filter(p => p.role === 'guest' && p.online).map(p => p.name))]
    return `This session is already shared (${room.url})${here.length ? `, with ${listNames(here)} here` : ''}. Everything that happens in it reaches them live, so there's nothing to share again. To show someone something again, show it again: publish or open the page, send the file, or open the page or preview; each of those goes to everyone in the room by itself.`
  }
  if (mode === 'guest' && room) return `This session joined ${room.host}'s shared session; only ${room.host} shares it. What's typed here runs there.`
  return 'Sharing starts only when the person chooses it: they type /share-session or press Share above the prompt. It sends this session\'s prompts, replies and tool calls to everyone with the link, so tell them that and let them start it; don\'t start it yourself.'
}

async function shareCommand($: $, e: { args: string }): Promise<{ text: string }> {
  const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const choice = words.find(w => w === 'all' || w === 'new') ?? ''
  // `link`: by link alone, not to the team.
  const byLink = words.includes('link')
  // In its turn: a Share under way finishes first, and this is then a
  // session sharing already.
  return inShareTurn($, () => shareAsked($, choice, byLink))
}

async function shareAsked($: $, choice: string, byLink: boolean): Promise<{ text: string }> {
  try {
    // A room being left finishes first: then the mode says whether to ask.
    // A room being taken back is waited for, not given up: asking gives
    // nothing up, and `share` does as it makes a room. Late, on its way
    // back still, the mode isn't read (as in `requestShare`).
    await roomClosed($, { keep: true })
    if (!choice && (takingBack !== null || (await read($, modeA)) === 'idle')) {
      const prompts = await earlierPrompts($)
      if (prompts > 0) {
        const team = byLink ? null : await shareTeamName($)
        // The row above the prompt offers the same two, a press away (by keys in a terminal).
        await update($, askingA, () => ({ prompts }))
        return {
          text: [
            `This session has ${prompts} earlier prompt${prompts === 1 ? '' : 's'}. ${team ? `Everyone in ${team}` : 'Everyone with the link'} would see them, and Claude's replies.`,
            '',
            `- \`/share-session all${byLink ? ' link' : ''}\` shares the session as it is`,
            `- \`/share-session new${byLink ? ' link' : ''}\` shares only what happens from now on`,
          ].join('\n'),
        }
      }
    }
    const room = await share($, undefined, { history: choice !== 'new', team: !byLink })
    const team = room.team ? (await read($, teamsA)).teams.find(t => t.id === room.team?.id) ?? null : null
    return { text: `Sharing this session${choice === 'new' ? ' from now on' : ''}${room.team ? ` with ${room.team.name}` : ''}. ${whoJoins(room, team)}: ${room.url}` }
  } catch (error) {
    return { text: `Couldn't share: ${String((error as Error)?.message ?? error)}` }
  }
}

export const register: Register = (on, options) => {
  configuredServer = typeof options.server === 'string' ? options.server : ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The engine's version says which drawings it takes (fit.ts).
    modern = isModern(await $.env.get('AI_AGENT'))
    const prefs = (await $.store.get(PREFS_KEY).catch(() => undefined)) as Partial<SharePrefs> | undefined
    if (prefs && typeof prefs === 'object') await update($, prefsA, () => ({ ...DEFAULT_PREFS, ...prefs }))
    // Started last, this module draws the row: one a reload replaced, its
    // calls still waiting there, finds another here and declines them
    // (`tool.check`), and hears the room no more (`retire`). With none of
    // its own waiting, the row's question and the host's working line's wait
    // are such a module's, whose buttons answer nothing now: they go, and
    // guests' lines with them.
    await update($, moduleA, () => MODULE)
    if (!approvals.length && !askedHere.size) {
      if (await read($, approvingA)) await update($, approvingA, () => null)
      if ((await read($, modeA)) === 'host' && (await read($, workingA))?.waitingFor) {
        await update($, workingA, w => (w ? { ...w, waitingFor: null } : w))
        send($, 'approval', { pending: false })
      }
    }
    // Not /share: Claude has its own. Every name here is the plugin's alone.
    await $.command.register({ name: 'share-session', description: 'Share this session (with your team when signed in): /share-session [all | new] [link]' })
    await $.command.register({ name: 'team', description: "Your team's shared sessions, one click to join: /team [signin | create <name> | invite | signout]" })
    await $.command.register({ name: 'invite', description: 'Invite a teammate into this shared session, in their Claude Code: /invite <name>' })
    await $.command.register({ name: 'stop-sharing', description: 'Stop sharing this session, or leave the one you joined' })
    await $.command.register({ name: 'room', description: 'Open the Room: who is here, activity, side chat' })
    await $.command.register({ name: 'share-file', description: 'Show a file to everyone in the shared session: /share-file <path>' })
    await $.command.register({ name: 'share-preview', description: "Let teammates open this machine's localhost: /share-preview <port|http://localhost:port/path> [title]" })
    await $.command.register({ name: 'who', description: "Who's in this shared session and what each is doing" })
    void readUpdates($)
    // Signed in: the team and what's shared with it, for Share and the Team button.
    void serverOf($)
      .then(server => signInFor($, server))
      .then(saved => (saved ? refreshTeams($) : undefined))
      .catch(() => {})
    // This session's room, for the others here (`holdRoom`): kept fresh.
    everyTimers.push(
      $.clock.every(60_000, () => {
        void holdRoom($).catch(() => {})
        void repinIfAllowed($).catch(() => {})
      }),
    )
    // Invites teammates sent: a look every 10 s at the machine's shared copy.
    $.clock.after(2_000, () => void pollInvites($).catch(() => {}))
    everyTimers.push($.clock.every(10_000, () => void pollInvites($).catch(() => {})))
    // …and kept current while this session isn't in one, for the Team button's count.
    everyTimers.push(
      $.clock.every(5 * 60_000, () => {
        void (async () => {
          if (teamOpen || !(await read($, teamsA)).account || (await read($, modeA)) !== 'idle') return
          await refreshTeams($)
        })().catch(() => {})
      }),
    )
    // Loaded anew (an update in place, a reload): the rows this plugin drew
    // draw again with this code, the room and the transcript as they were.
    $.ui.invalidate('ui.render')
    $.clock.after(3_000, () => void catchUpFromInstalled($))
    $.clock.after(15_000, () => void checkForUpdate($))
    everyTimers.push($.clock.every(30 * 60_000, () => void checkForUpdate($)))
    // A reload keeps $.state: pick the room back up. A restart doesn't: a
    // host session saved its room when it closed, and takes it up again. A
    // room being left is neither: its close ends first (the same module
    // started again), or is finished here (one a reload cut short).
    await roomClosed($, { start: true })
    const room = await read($, roomA), mode = await read($, modeA)
    // A guest's reload (an update in place included): what the room shares
    // now first, as its next page lists it (a preview it ended or forwarded
    // meanwhile, or one forwarded before the update that Shown lost a sign
    // of), then each listener it had (below).
    let listed: Promise<void> = Promise.resolve()
    if (room && mode !== 'idle') {
      // The module came back without its room's scope (a reload): it opens
      // again, its long-lived work (listeners, the window's proxy) restored
      // below. Still open (the same module, started again), it goes on.
      const s = scope.live && scope.key === roomIdentity(room) && scope.mode === mode ? scope : openScope(room, mode)
      s.token = room.token
      if (mode === 'guest') listed = s.nextList()
      startFeed($)
      // Teammates' prompts the module before this one had waiting go on.
      if (mode === 'host') nextGuestPromptSoon($)
    }
    const reloaded = room && (await read($, modeA)) === 'guest'
    if (reloaded) await readyReplay($)
    if (!room) await resumeHosting($).catch(error => $.ui.log(`Couldn't pick the shared session back up: ${String(error?.message ?? error)}`))
    if (!(await read($, roomA))) await resumeJoined($).catch(error => $.ui.log(`Couldn't get back into the shared session: ${String(error?.message ?? error)}`))
    // A room that doesn't answer holds a reload's listeners back only so long.
    void (async () => {
      if (reloaded) await Promise.race([listed, new Promise<void>(done => $.clock.after(3_000, done))])
      await restoreLocalPreviews($)
    })().catch(() => {})
    // A question asked before a reload has no one to answer it now: it goes.
    if (!hostAskRunning && (await read($, hostAskA))) await update($, hostAskA, () => null)
    void restorePreviewWindow($).catch(() => {})
    void gcPreviewProfiles($).catch(() => {})
    // The host's mailboxes listen again at the paths they had: a reload's
    // helper goes first (the module it was started by is gone).
    void endOldHelper($).then(() => restoreMailboxes($)).catch(() => {})
    void holdRoom($).catch(() => {})
    void refreshStatus($).catch(() => {})
    $.clock.after(2_000, () => void repinMarked($).catch(() => {}))
    return started
  })

  on('session.end', async ($, e, next) => {
    // /clear and a logout leave the room for good (a host's ends); any other
    // end keeps the place, to take the room up again when the session's back.
    const forGood = e.reason === 'clear' || e.reason === 'logout'
    // A place still being taken back, or given up for a room not made or
    // joined yet (its request still out): saved again, or left
    // (`settleReclaim`). Never lost with the session's end.
    const back = reclaiming ?? givenUp
    reclaiming = null
    givenUp = null
    if (back) {
      await settleReclaim($, back, forGood).catch(() => {})
      tookBack($, back)
    }
    await closeRoom($, forGood ? 'clear' : 'keep', { sessionId: e.sessionId })
    // Closed, it's in no room for the other sessions here (`holdRoom`).
    for (const key of await $.store.keys().catch(() => [] as string[])) {
      if (key.startsWith(LIVE_KEY) && key.endsWith(`:${e.sessionId}`)) await $.store.delete(key).catch(() => {})
    }
    return next(e)
  })

  // Both names: the markdown fallback (commands/share-session.md) is listed
  // under the plugin-qualified one, and here, where this module loaded, it
  // never reaches the model.
  on('command.run', { command: 'share-session' }, ($, e) => shareCommand($, e))
  on('command.run', { command: 'shared-session:share-session' }, ($, e) => shareCommand($, e))

  on('command.run', { command: 'invite' }, ($, e) => inviteCommand($, e.args ?? ''))
  on('command.run', { command: 'shared-session:invite' }, ($, e) => inviteCommand($, e.args ?? ''))
  on('command.run', { command: 'team' }, ($, e) => teamCommand($, e.args ?? ''))
  on('command.run', { command: 'shared-session:team' }, ($, e) => teamCommand($, e.args ?? ''))

  on('command.run', { command: 'room' }, async $ => {
    if ((await read($, modeA)) === 'idle') return { text: 'This session is not shared. Press Share above the prompt, or type /share-session.' }
    await openRoom($)
    return { text: 'Opened the Room.' }
  })

  // Who's here, as words the model can read too; the transcript draws it as a
  // card (the CommandOutput hook below).
  on('command.run', { command: 'who' }, async $ => {
    const v = await view($)
    if (v.mode === 'idle' || !v.room) return { text: 'This session is not shared. Press Share above the prompt, or type /share-session.' }
    const people = faces(v)
    const here = people.filter(p => p.online).map(p => p.name)
    const away = people.filter(p => !p.online).map(p => p.name)
    const w = v.working
    return {
      text: `${v.mode === 'host' ? 'Sharing this session' : `In ${v.room.host}'s session`}: ${listNames(here)} here${away.length ? `; ${listNames(away)} away` : ''}.${w ? ` Claude is working for ${w.by}.` : ''}`,
    }
  })

  // What a Client region posts: a turn picked on the Timeline scrolls the
  // transcript to its prompt (the person's own press, so the engine lets it).
  on('ui.message', async ($, e, next) => {
    const data = (e.data ?? {}) as { turn?: unknown }
    if (e.module.endsWith('timeline.tsx') && typeof data.turn === 'number') {
      const turn = (await read($, turnsA)).slice(-60)[data.turn]
      const id = turn ? (promptRows.get(turn.prompt) ?? [...promptRows.entries()].find(([text]) => text.startsWith(turn.prompt.slice(0, 60)))?.[1]) : undefined
      const moved = id ? await $.ui.scroll({ to: { requestId: id }, block: 'start' }).catch(() => ({ deny: 'no' })) : { deny: 'not drawn here' }
      if (moved.deny && turn) $.ui.toast(`${turn.who}: “${turn.prompt.slice(0, 100)}”`)
    }
    return next(e)
  })

  on('command.run', { command: 'share-file' }, async ($, e) => {
    const room = await read($, roomA)
    if ((await read($, modeA)) !== 'host' || !room) return { text: 'Share this session first: press Share or type /share-session.' }
    const arg = e.args.trim().replace(/^["']|["']$/g, '')
    if (!arg) return { text: 'Which file? /share-file <path>' }
    const cwd = await $.session.cwd()
    const path = arg.startsWith('/') ? arg : `${cwd}/${arg}`
    const file = await uploadFile($, room, path)
    if (!file) return { text: `Couldn't share ${arg}: no such file, or over 10 MB.` }
    send($, 'artifact', { kind: 'send', files: [file], display: 'render', caption: '' })
    return { text: `Shared ${file.name} with everyone here.` }
  })

  on('command.run', { command: 'share-preview' }, async ($, e) => {
    const room = await read($, roomA)
    if ((await read($, modeA)) !== 'host' || !room) return { text: 'Share this session first: press Share or type /share-session.' }
    const [first, ...rest] = e.args.trim().split(/\s+/)
    const url = LOCAL_URL.exec(first ?? '')
    const port = Number(url?.[1] ?? first)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { text: 'Which port? /share-preview <port|http://localhost:port/path> [title], e.g. /share-preview 3000' }
    const title = rest.join(' ') || `localhost:${port}`
    // What the page uses beside it, in the same project: asked about above
    // the prompt, a service a question, and named here, with how to share
    // one that isn't asked about (`relatedSaid`).
    const page = url ? localPageOf(url) : null
    const forwarded = await hostForwards($, room, { port, title, path: page?.path ?? '/', host: page?.host, scheme: page?.scheme }, { offerRelated: 4_000 })
    if (!forwarded) return { text: `Couldn't share localhost:${port}.` }
    if ('refused' in forwarded) return { text: forwarded.refused }
    return { text: `${forwardedSaid([port])}${relatedSaid(await forwarded.related)}` }
  })

  on('command.run', { command: 'stop-sharing' }, async $ => {
    const mode = await read($, modeA)
    if (mode !== 'idle') await closeRoom($, mode === 'host' ? 'stop' : 'leave')
    return { text: mode === 'idle' ? 'This session is not shared.' : mode === 'host' ? 'Stopped sharing. The link no longer works.' : 'Left the shared session.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === ROOM) roomOpen = false
    if (e.id === TEAM) {
      teamOpen = false
      teamTimer?.cancel()
      teamTimer = null
    }
    return next(e)
  })

  // Pasting a share link joins it; typing in a guest session talks to the
  // shared one.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    const fromPerson = GUEST_SENDS.has(e.origin.kind) && !(e as { isMeta?: true }).isMeta
    // A message from another of this person's sessions here, which a guest
    // relays to the host's session, or keeps with a note where they've said
    // so (OWN_SESSIONS, `relayPeers`): either way never this session's own
    // Claude's to answer, so it waits for a room coming back as typing does.
    const fromPeer = OWN_SESSIONS.has(e.origin.kind)
    // At startup, this session's room may be on its way back. What a person
    // typed (or a guest would send on: theirs, and their other sessions'
    // messages) waits for it, before anything of the room is read, and goes
    // where it would once it's over: a guest's prompt to the room, a host's
    // turn shared from its start, a link pasted then one pasted in it. The
    // wait never gives the room up: only a link that joins here does, in
    // `join`. A channel's or a task's message doesn't wait: a guest never
    // sends one on, and none joins a room.
    const back = fromPerson || fromPeer ? takingBack : null
    if (fromPerson || fromPeer) await takenBack($, { keep: true })
    // A guest's place still on its way back past its 10 s (`late`): not in
    // its room yet, and not given up for a prompt.
    const late = back && takingBack === back && back.saved.room.seat !== 'host' ? back.saved.room : null
    const mode = await read($, modeA)
    const typed = typedText(e.text)
    const link = LINK.exec(typed)
    const answerWith = (note: Ride) => {
      const list = ridesByText.get(typed) ?? []
      list.push(note)
      ridesByText.set(typed, list)
      localTurnActive = true // nothing else plays out before this answer
    }
    // A message from another of this person's sessions delivered into a turn
    // already playing here starts no turn of its own a note could answer in:
    // a note ride would wait for one never coming, ahead of every later ride.
    // So what it would say is a toast, and the message goes no further.
    const midTurn = fromPeer && (e.turnId !== undefined || Boolean(delivered(typed)?.midTurn))
    const keepHere = (text: string) => {
      if (!midTurn) {
        answerWith({ kind: 'note', text, then: [] })
        return next(e)
      }
      const plain = text.replaceAll('**', '')
      $.ui.toast(plain)
      return { drop: plain }
    }
    // Claude Code's notice of what became of a message this session sent
    // another (the host's replies, this plugin's notes): on to the host's
    // session where it was a reply, and nothing here, its own Claude never
    // asked. Answered without entering: no turn, nothing drawn.
    if (mode === 'guest' && (e as { isMeta?: true }).isMeta && typed.startsWith(NOTICE)) {
      $.clock.after(0, () => void takeNotice($, typed).catch(() => {}))
      return { text: e.text }
    }
    if (link?.[1] && link[2] && mode !== 'host' && PERSON.has(e.origin.kind)) {
      // Already in it in another session here: that one opens. Pasted again
      // soon after, it joins here too.
      const now = await $.clock.now()
      const hold = (await read($, roomA))?.id === link[2] ? null : await heldElsewhere($, link[2]).catch(() => null)
      if (hold && !(pastedAgain?.id === link[2] && now - pastedAgain.at < 2 * 60_000)) {
        pastedAgain = { id: link[2], at: now }
        answerWith({ kind: 'note', text: `${alreadyIn(hold, await openHeld($, hold))} Paste the link again to join here as well.`, then: [] })
        return next(e)
      }
      // The link stays in the transcript as typed; the reply says what joining
      // did, then what happened before plays back, all without a model call.
      try {
        if (mode === 'guest') await closeRoom($, 'leave')
        const joined = await join($, link[1], link[2])
        answerWith({ kind: 'note', text: await joinedNote($, joined), then: joined.history, open: joined.open })
        void continueJoins($, joined.room.id).catch(() => {})
      } catch (error) {
        answerWith({ kind: 'note', text: joinFailure(error, link[1]), then: [] })
        if (error instanceof ApiError && error.data.signIn) void openTeam($)
      }
      return next(e)
    }
    // A team's invite link: in the team once signed in, its sessions in the Team panel.
    const invite = INVITE.exec(typed)
    if (invite?.[1] && invite[2] && mode !== 'host' && PERSON.has(e.origin.kind)) {
      answerWith({ kind: 'note', text: await takeInvite($, invite[1], invite[2]), then: [] })
      return next(e)
    }
    // What a person typed while their place in a room is late coming back
    // gets a note, as with the host away, and no model call: a prompt meant
    // for the host's Claude never reaches this session's own. A host's place
    // goes on as typed: its own Claude is the host's.
    if (late && (typed || e.attachments?.length) && !typed.startsWith('/')) {
      // Another of their sessions' message: that session hears it too.
      const peer = fromPeer ? delivered(typed) : null
      if (peer?.address && (await prefsOf($)).relayPeers) tellPeer($, peer.address, `Still getting back into ${late.host}'s session, so this didn't reach their Claude. Send it again in a moment.`)
      return keepHere(`Still getting back into **${late.host}**'s session, so this didn't go to Claude. Send it again in a moment.`)
    }
    // The update command, typed here by a guest (the "is out" line names it):
    // run on this computer, never sent to the host's Claude to run there.
    if (mode === 'guest' && UPDATE_TYPED.test(typed)) {
      answerWith({ kind: 'note', text: `Updating Shared Sessions on this computer (this didn't go to ${(await read($, roomA))?.host ?? 'the host'}). A line below says when it's done.`, then: [] })
      void updateHere($)
      return next(e)
    }
    // Another of this person's sessions wrote to this one: on to the host's
    // session, if they let it, its turn here the host's turn for it (as a
    // typed prompt's is) unless it went into one playing here. Where it
    // can't go, that session hears why, and it stays here with a note.
    const fromOwn = mode === 'guest' && OWN_SESSIONS.has(e.origin.kind) ? delivered(typed) : null
    if (fromOwn) {
      const room = await read($, roomA)
      const name = tidySender(fromOwn.from)
      if (!(await prefsOf($)).relayPeers) return keepHere(`A message from **${name}** stayed here: your **Room**'s Settings keep your other sessions' messages from ${room?.host ?? 'the host'}'s Claude.`)
      if (!fromOwn.address || !fromOwn.text) return keepHere(`A message from **${name}** stayed here: it didn't say where an answer would go.`)
      const refusal = room ? await relayRefusal($, room) : "This session isn't in a shared session any more, so this didn't reach anyone's Claude."
      if (!room || refusal) {
        tellPeer($, fromOwn.address, refusal!)
        return keepHere(refusal!)
      }
      const pid = newId()
      const ride: Ride = { kind: 'own', pid, fromSeq: room.seq }
      if (!midTurn) {
        ownPending.add(pid)
        ridesByText.set(typed, [...(ridesByText.get(typed) ?? []), ride])
      }
      const s = scope
      const entered = await next(e)
      if (entered.drop !== undefined) {
        ownPending.delete(pid)
        ridesByText.set(typed, (ridesByText.get(typed) ?? []).filter(r => r !== ride))
        return entered
      }
      const sent = { from: fromOwn.from, text: fromOwn.text, address: fromOwn.address, ...(fromOwn.mode ? { mode: fromOwn.mode } : {}) }
      $.clock.after(0, () => void relayQueued($, room, s, pid, sent).catch(error => $.ui.log(`Shared session: relaying a message: ${String((error as Error)?.message ?? error)}`, { to: 'debug' })))
      lastActivity = await $.clock.now()
      return entered
    }
    if (mode === 'guest' && fromPerson && (typed || e.attachments?.length) && !typed.startsWith('/')) {
      const room = await read($, roomA)
      if ((await read($, policyA)).prompts === 'watch') {
        return keepHere(`**${room?.host}** has this session on watch-only, so this didn't go to Claude. You can still follow every turn and talk to everyone in the **Room** panel.`)
      }
      if ((await read($, peopleA)).some(p => p.role === 'host' && !p.online)) {
        return keepHere(`**${room?.host}**'s Claude Code is closed right now, so this didn't go to Claude. The room stays open and carries on when they're back (the **Room** shows them here again); send it then.`)
      }
      const pid = newId()
      ownPending.add(pid)
      const list = ridesByText.get(typed) ?? []
      list.push({ kind: 'own', pid, fromSeq: room?.seq ?? 0 })
      ridesByText.set(typed, list)
      // Only what the person typed (and attached) leaves this machine, never
      // the host app's context. Attachments' bytes come with the stored message.
      if (e.attachments?.length) {
        if (heldPrompt) await releaseHeld($, [])
        heldPrompt = { text: typed, pid, names: e.attachments.map(a => a.filename ?? ''), timer: $.clock.after(8_000, () => void releaseHeld($, [])) }
      } else send($, 'prompt', { text: typed, pid })
    }
    lastActivity = await $.clock.now()
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // From 2.1.300 a subagent's run starts a turn too: not a prompt anyone
    // typed, and its end never clears the host's working line.
    if ((e as { agentId?: string }).agentId !== undefined) return next(e)
    turnNow = e.turnId
    await update($, turnA, () => e.turnId)
    const mode = await read($, modeA)
    if (mode !== 'host') {
      rideSubmitted = false // whatever went out has started, alone or with others
      const ride = mode === 'guest' ? takeRide(typedText(e.text)) : ridesByText.get(typedText(e.text))?.shift()
      if (ride) {
        ridesByTurn.set(e.turnId, ride)
        localTurnActive = true
      }
      return next(e)
    }
    const room = await read($, roomA)
    mainStarts += 1
    // A teammate's prompt, known by its words: theirs, and off the queue.
    // One set aside is known too: the engine held it, and starts it first.
    // The longest whose words are in the turn's: a prompt quoting another's
    // queued words ("Alex: …") is its own sender's, never the one it quotes.
    const known = (await read($, guestPromptsA)).filter(p => e.text.includes(p.framed)).sort((a, b) => b.framed.length - a.framed.length)[0]
    if (known) await update($, guestPromptsA, list => list.filter(p => p.pid !== known.pid))
    const said = typedText(e.text)
    // None of the queue's, but framed as a teammate's (one set aside that
    // the queue's newest 8 no longer hold, or one the module before this one
    // submitted): still theirs, so its calls are put to the host. Asking more
    // is the safe side: the host typing "Alex: …" is asked about their own calls.
    const people = await read($, peopleA)
    const named = known ? undefined : people.find(p => p.role !== 'host' && p.name && said.startsWith(`${p.name}: `))?.name
    // Its seat, when one person has that name; else none (never always allowed).
    const namesake = named ? people.filter(p => p.role !== 'host' && p.name === named) : []
    const guest = known ?? (named ? { who: named, seat: namesake.length === 1 ? (namesake[0]!.seats?.[0] ?? namesake[0]!.id) : '', text: said.slice(named.length + 2), pid: '' } : null)
    // A prompt another session delivered is shown as its text, not its markup;
    // one from a teammate's session's mailbox as their agent's (the host's
    // turn all the same: its calls are the mode's, as any peer's are), with
    // the id their joined session plays it under (`pid`).
    const sent = guest ? null : delivered(said)
    const agent = sent ? await mailboxOwner($, sent.address) : null
    const relayPid = agent && sent ? relayPidOf(agent.box, sent.text) : undefined
    const by = guest?.who ?? (agent ? `${agent.who}'s agent` : room?.host ?? 'host')
    const startedAt = await $.clock.now()
    await update($, workingA, () => ({ turnId: e.turnId, by, byGuest: Boolean(guest), ...(guest ? { seat: guest.seat } : {}), startedAt, tail: '', waitingFor: null }))
    const relayed = guest ? delivered(guest.text) : null
    const guestPrompt = guest ? (relayed ? `(from ${relayed.from}) ${relayed.text}` : guest.text) : undefined
    const agentPrompt = agent && sent ? `(from ${agent.name}) ${sent.text}` : undefined
    send($, 'turn', { state: 'start', turnId: e.turnId, by: agent ? by : sent?.from ?? by, prompt: guestPrompt ?? agentPrompt ?? sent?.text ?? (said || startedBy(e.text)), pid: guest?.pid ?? relayPid ?? '' })
    void refreshStatus($)
    return next(e)
  })

  // Guest: every turn here plays the shared session back (no model runs), so
  // the person's own Stop hooks (a notifier, a channel bridge) stay out of
  // it: each cost a second or more per replayed turn, told a channel about
  // turns nobody here took, and one could keep a finished ride going. A
  // note's turn is the plugin's own whatever the mode (a place late coming
  // back is idle): theirs stay out of it too.
  on('classic.Stop', async ($, e, next) => (ridesByTurn.get(turnNow)?.kind === 'note' || (await read($, modeA)) === 'guest' ? {} : next(e)))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await update($, turnA, t => (t === e.turnId ? null : t))
    const mode = await read($, modeA)
    if (mode === 'host') {
      lastTurnFor = (await read($, workingA))?.by ?? lastTurnFor
      await update($, workingA, w => (w?.turnId === e.turnId ? null : w))
      send($, 'turn', { state: 'end', turnId: e.turnId, aborted: e.isAborted, durationMs: e.durationMs, reason: e.reason })
      void refreshStatus($)
      // Idle again: the next teammate's prompt goes.
      nextGuestPromptSoon($)
    } else {
      const ride = ridesByTurn.get(e.turnId)
      ridesInStep.delete(e.turnId)
      liveRuns.delete(e.turnId)
      staticRuns.delete(e.turnId)
      openRuns.delete(e.turnId)
      if (ride) {
        ridesByTurn.delete(e.turnId)
        localTurnActive = false
        if (ride.kind === 'note' && mode === 'guest') {
          const room = await read($, roomA)
          for (const exchange of ride.then) laterRides.push({ text: exchange.prompt, ride: { kind: 'static', rows: exchange.rows } })
          for (const event of ride.open ?? []) {
            const shown = shownOf(event)
            if (shown) laterRides.push({ text: `${room?.host ?? 'The host'} has ${shown.name} open`, ride: { kind: 'artifact', event } })
          }
        }
      }
      if (mode === 'guest') scheduleRides($)
    }
    return next(e)
  })

  // Host: live text for guests while Claude writes.
  // Guest: a turn that shows a host turn answers from the room, not a model.
  on('turn.step', async function* ($, e, next) {
    const ride = e.agentId === undefined ? ridesByTurn.get(e.turnId) : undefined
    // A note's turn is the plugin's own, whatever the mode (a place late
    // coming back is idle): its first step says it, and a step after (a
    // Stop hook continuing the turn) ends it, never on the model. Nothing
    // here waits, so nothing fails over to the model either.
    if (ride?.kind === 'note') {
      const answer = e.index === 0 ? ride.text : ''
      if (answer) yield { kind: 'text', index: 0, text: answer } satisfies TurnStepChunk
      yield { kind: 'stop', stopReason: 'end_turn', usage: null } satisfies TurnStepChunk
      return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
    }
    const mode = await read($, modeA)

    const progress = ridesInStep.get(e.turnId)
    const staticRun = staticRuns.get(e.turnId)
    if (ride && (e.index === 0 || progress || staticRun)) {
      const room = await read($, roomA)
      let answer = ''
      if (ride.kind === 'static' && staticRun) {
        staticRuns.delete(e.turnId)
        answer = staticRun.tail || '_(it stopped here)_'
        yield { kind: 'text', index: 0, text: answer } satisfies TurnStepChunk
      } else if (ride.kind === 'static') {
        // An earlier exchange, its own turn as it was for the host: its prompt
        // above, then everything up to its last call in this one step and the
        // last words in the next. No step per call, nothing to wait for.
        const { blocks, tail, runs } = historyBlocks(ride.rows)
        for (const run of runs) await saveRun($, run)
        const toolUses: { name: string; input: Record<string, unknown> }[] = []
        if (!blocks.length) {
          answer = tail || '(no reply)'
          yield { kind: 'text', index: 0, text: answer } satisfies TurnStepChunk
        }
        for (const [index, block] of blocks.entries()) {
          if ('text' in block) {
            answer += block.text
            yield { kind: 'text', index, text: block.text } satisfies TurnStepChunk
          } else {
            yield { kind: 'tool', index, id: block.id, name: REPLAY_TOOL } satisfies TurnStepChunk
            yield { kind: 'input', index, json: JSON.stringify(block.input) } satisfies TurnStepChunk
            toolUses.push({ name: REPLAY_TOOL, input: block.input })
          }
        }
        if (toolUses.length && !next.signal.aborted) {
          staticRuns.set(e.turnId, { tail })
          yield { kind: 'stop', stopReason: 'tool_use', usage: null } satisfies TurnStepChunk
          return { turnId: e.turnId, index: e.index, answer, toolUses, stopReason: 'tool_use', usage: null }
        }
        if (blocks.length && tail) {
          answer += tail
          yield { kind: 'text', index: blocks.length, text: tail } satisfies TurnStepChunk
        }
      } else if (room) {
        // A ride can take several steps: each thing the host's Claude showed
        // is a call made here, and the next step picks up where this one left.
        const run: RideRun = progress ?? {
          state: { current: null, streamed: false, done: ride.kind === 'artifact', actions: ride.kind === 'artifact' ? [ride.event] : [], native: new Set() },
          cursor:
            ride.kind === 'turn'
              ? (hostTurns.find(t => t.turnId === ride.turnId)?.startSeq ?? room.seq)
              : ride.kind === 'own'
                ? Math.min(ride.fromSeq, ...hostTurns.filter(t => !t.shown).map(t => t.startSeq))
                : room.seq,
        }
        ridesInStep.delete(e.turnId)
        liveRuns.set(e.turnId, run)
        const state = run.state
        // This step's blocks, numbered as they come, as a response's are: the
        // host's thinking (shown live, not kept), the words, then a call.
        let blocks = 0
        let textAt = -1
        let thinkAt = -1
        const words = (text: string) => {
          if (textAt < 0) textAt = blocks++
          answer += text
          return { kind: 'text', index: textAt, text } satisfies TurnStepChunk
        }
        const refused = run.lastCall ? refusedCalls.get(run.lastCall.id) : undefined
        if (run.lastCall && refused !== undefined) yield words(await refusedNote($, room, run.lastCall.event, refused))
        if (run.lastCall) refusedCalls.delete(run.lastCall.id)
        run.lastCall = undefined
        // Esc here stops the shared turn. The engine stops reading this stream
        // on an interrupt, so the stop goes out from the abort itself.
        const onAbort = () => {
          if (state.current && !state.done) send($, 'stop', {})
        }
        next.signal.addEventListener('abort', onAbort, { once: true })
        let call: Replay['call'] | undefined
        while (!next.signal.aborted) {
          const action = state.actions.shift()
          if (action && action.type === 'row' && (action.body as unknown as Row).kind === 'tool') {
            const row = action.body as unknown as Row
            call = { name: REPLAY_TOOL, input: { tool: row.tool, summary: row.text, input: row.input } }
            run.lastCall = { id: '', event: action }
            break
          }
          if (action) {
            const replay = await replayOf($, room, action).catch(() => null)
            if (!replay) continue
            yield words(`\n\n${replay.label}${replay.note ? ` · ${replay.note}` : ''}\n\n`)
            if (replay.call) {
              call = replay.call
              run.lastCall = { id: '', event: action }
              break
            }
            continue
          }
          if (state.done) break
          // Typed here and refused by the room as too large, or relayed and
          // not taken up there: it never runs there, so its turn ends, once
          // it shows no one else's (`tooLarge`, `endRelay`).
          if (ride.kind === 'own' && !state.current && unsent.has(ride.pid)) {
            const note = unsent.get(ride.pid)
            unsent.delete(ride.pid)
            yield words(note ?? `This was too large to send to **${room.host}**'s session, so it didn't go to Claude.`)
            break
          }
          let page: EventsPage
          try {
            page = await ridePage($, room, run.cursor)
            run.failures = 0
          } catch (error) {
            if (isGone(error)) break
            // A server that refuses at once must not be asked again at once:
            // back off, up to 10 s, so a stuck ride can't flood it.
            run.failures = (run.failures ?? 0) + 1
            await pause($, Math.min(10_000, 250 * 2 ** run.failures!))
            continue
          }
          for (const event of page.events) {
            run.cursor = Math.max(run.cursor, event.seq)
            // The host's Claude thinking: shown live here, as the host sees it.
            if (event.type === 'delta' && typeof event.body.thinking === 'string' && state.current && event.body.turnId === state.current.turnId) {
              if (thinkAt < 0 || textAt > thinkAt) thinkAt = blocks++
              yield { kind: 'thinking', index: thinkAt, text: event.body.thinking } satisfies TurnStepChunk
              continue
            }
            const piece = rideStep(ride, state, event, room.host)
            if (piece) yield words(piece)
            // A call to make: everything after it waits, so it lands in order.
            if (state.done || state.actions.length) break
          }
          if (page.ended) state.done = true
        }
        next.signal.removeEventListener('abort', onAbort)
        if (call && !next.signal.aborted) {
          ridesInStep.set(e.turnId, run)
          const id = `toolu_${newId()}${newId()}`
          if (run.lastCall) run.lastCall.id = id
          rideCalls.set(id, { name: call.name, input: JSON.stringify(call.input), approve: shownOf(run.lastCall?.event ?? ({ body: {} } as ServerEvent))?.kind !== 'link' })
          if (call.name === REPLAY_TOOL && run.lastCall) {
            const hostId = (run.lastCall.event.body as unknown as Row).id ?? ''
            hostCalls.set(id, { hostId, seq: run.lastCall.event.seq, turnId: state.current?.turnId })
            if (hostCalls.size > 1000) hostCalls.delete(hostCalls.keys().next().value as string)
          }
          if (rideCalls.size > 50) rideCalls.delete(rideCalls.keys().next().value as string)
          // A run goes on while steps bring calls with no words between them.
          const replayed = call.name === REPLAY_TOOL ? String((call.input as { tool?: unknown }).tool ?? '') : ''
          const before = answer.trim() ? null : (openRuns.get(e.turnId) ?? null)
          const grown = replayed ? joinRun(before, id, replayed) : null
          openRuns.set(e.turnId, grown)
          if (grown) await saveRun($, grown) // its first row's line counts one more
          const at = blocks++
          yield { kind: 'tool', index: at, id, name: call.name } satisfies TurnStepChunk
          yield { kind: 'input', index: at, json: JSON.stringify(call.input) } satisfies TurnStepChunk
          yield { kind: 'stop', stopReason: 'tool_use', usage: null } satisfies TurnStepChunk
          return { turnId: e.turnId, index: e.index, answer, toolUses: [{ name: call.name, input: call.input }], stopReason: 'tool_use', usage: null }
        }
        // The step after a call ends with something to read: an empty reply
        // makes the engine ask for one more step.
        if (!answer && e.index > 0) yield words('Opened.')
      }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null } satisfies TurnStepChunk
      return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
    }

    // A guest's own model is never called: everything a guest session shows
    // comes from the room. Any step not answered above ends here: a turn
    // nothing accounts for (a notice the app delivered, a ride that couldn't
    // be matched) gets a note; a step after a ride has finished (a Stop hook
    // in the guest's settings can ask the engine to keep going) gets nothing.
    if (mode === 'guest' && e.agentId === undefined) {
      const room = await read($, roomA)
      const note = e.index === 0 && !ride ? `_This session is attached to ${room?.host ?? 'the host'}'s; what you type goes there._` : ''
      if (note) yield { kind: 'text', index: 0, text: note } satisfies TurnStepChunk
      yield { kind: 'stop', stopReason: 'end_turn', usage: null } satisfies TurnStepChunk
      return { turnId: e.turnId, index: e.index, answer: note, toolUses: [], stopReason: 'end_turn', usage: null }
    }

    const stream = next(e)
    if (e.agentId !== undefined || mode !== 'host') return yield* stream
    const feed = await liveFeed($, e.turnId)
    for await (const chunk of stream) {
      feed(chunk)
      yield chunk
    }
    return await stream.result
  }).catch(async function* ($, e, next) {
    // A step of this hook threw or outran its budget. The engine would run
    // the model in its place: in a guest that answers the host's prompt with
    // this person's own Claude, on this machine. Never: end the turn here,
    // and let the host turn it was showing play again, whole, after it. A
    // ride of the room is a guest's whatever the mode says by now (a Leave
    // sets it idle as it begins, a ride still running).
    const ride = ridesByTurn.get(e.turnId)
    if (e.agentId !== undefined || (!(ride && ride.kind !== 'note') && (await read($, modeA)) !== 'guest')) return yield* next(e)
    const run = liveRuns.get(e.turnId)
    liveRuns.delete(e.turnId)
    ridesInStep.delete(e.turnId)
    const current = run?.state.current
    if (current) {
      current.shown = false
      current.claimed = false
    }
    if (ride?.kind === 'own') ownPending.delete(ride.pid)
    $.ui.log(`Shared session: a riding step failed (${next.error.kind}${next.error.message ? `: ${next.error.message}` : ''})`, { to: 'debug' })
    const room = await read($, roomA)
    const note = e.index === 0 || current ? `\n\n_Lost the thread of ${room?.host ?? 'the host'}'s reply here; it plays again below._` : ''
    if (note) yield { kind: 'text', index: 0, text: note } satisfies TurnStepChunk
    yield { kind: 'stop', stopReason: 'end_turn', usage: null } satisfies TurnStepChunk
    return { turnId: e.turnId, index: e.index, answer: note, toolUses: [], stopReason: 'end_turn', usage: null }
  })

  // Guest: a replay card's result is the host's. Answered here, never by
  // anything beneath: if this fails, the backstop answers instead.
  on('tool.call', { tool: REPLAY_TOOL }, async ($, e, next) => {
    const call = hostCalls.get(e.tool_use_id)
    const room = await read($, roomA)
    if (!call || !room) return { result: 'Nothing to show here: this tool replays a shared session.' } as never
    if (call.result !== undefined) return { result: await withImages($, room, call.result, call.images) } as never
    return { result: await hostResult($, room, call, next.signal) } as never
  }).catch(async () => ({ result: "The host's result didn't come through." }) as never)

  // Guest: a replay card is drawn as the call it replays (Bash, Read, Edit).
  on('ui.render', { component: 'ToolUse', props: { tool: REPLAY_TOOL } }, async ($, e, next) => {
    const input = (e.props.input ?? {}) as { tool?: unknown; input?: unknown; summary?: unknown }
    if (typeof input.tool !== 'string') return next(e)
    // Desktop draws a renamed call as that tool's own card. The terminal draws
    // by the tool that ran (this one, generically: every argument, the whole
    // result), so there the row is drawn as the terminal draws the real one:
    // `Name(summary)` and a folded line or two of what came back.
    if (e.surface !== 'terminal') return next({ ...e, props: { ...e.props, tool: input.tool, input: input.input ?? {} } })
    const { Box, Text } = $.ui.resolve(e)
    const run = (await read($, toolRowsA)) === 'grouped' ? await read($, memberOf(replayRunF, e)) : null
    if (run?.hidden) return <Box />
    if (run?.tools) return <Text dimColor>{`  ${runLine({ tools: run.tools })}`}</Text>
    const summary = typeof input.summary === 'string' ? input.summary.split('\n')[0]!.slice(0, 160) : ''
    const lines = e.props.isRunning ? [] : replayLines(input.tool, (input.input ?? {}) as Record<string, unknown>, outputText(e.props.output), e.props.isErrored, imageCount(e.props.output))
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={e.props.isErrored ? BAD : e.props.isRunning ? undefined : GOOD} dimColor={e.props.isRunning}>
            {'⏺ '}
          </Text>
          <Text bold>{terminalName(input.tool)}</Text>
          <Text wrap="truncate-end">{summary ? `(${summary})` : ''}</Text>
        </Box>
        {lines.map((line, i) => (
          <Text key={`l${i}`} dimColor={!e.props.isErrored} color={e.props.isErrored ? BAD : undefined} wrap="truncate-end">
            {`${i === 0 ? '  ⎿  ' : '     '}${line}`}
          </Text>
        ))}
      </Box>
    )
  })
  // …and its result is in that row already, folded: not again in full below it.
  on('ui.render', { component: 'ToolResult', props: { tool: REPLAY_TOOL } }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // Host: every row the conversation keeps goes to the room.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined && heldPrompt && e.door === 'prompt' && PERSON.has(e.origin.kind) && (await read($, modeA)) === 'guest') {
      void releaseHeld($, attachmentsOf((stored.message ?? e.message).content))
      return stored
    }
    // A prompt typed mid-turn is raised once as it's queued (`queue`, from
    // 2.1.300; never a row of the conversation) and again when it goes in.
    if (e.agentId !== undefined || (e.door as string) === 'queue') return stored
    const mode = await read($, modeA)
    // Who each of Claude's replies was for, by its message id: the line over
    // it in the transcript says so, for the host and in a guest's replay.
    const message = (stored.message ?? e.message) as { type?: string; role?: string }
    if (mode !== 'idle' && (message.role ?? message.type) === 'assistant') {
      const working = await read($, workingA)
      if (working) await update($, replyForA, all => Object.fromEntries(Object.entries({ ...all, [e.uuid]: working.by }).slice(-400)))
    }
    if (mode !== 'host') return stored
    const room = await read($, roomA)
    const host = room?.host ?? 'host'
    const fromGuest = e.origin.kind === 'plugin' && 'name' in e.origin && e.origin.name === PLUGIN
    const typed = fromGuest || ['composer', 'sdk', 'bridge', 'unclassified'].includes(e.origin.kind)
    const cwd = await $.session.cwd()
    // A teammate's session's message, delivered from its mailbox: under the
    // teammate's name, as a relayed prompt is drawn; and Claude's SendMessage
    // to one names the session it stands for. Never a mailbox's path.
    const relayed = await mailboxRows($, (stored.message ?? e.message) as { role?: string; type?: string; content: unknown })
    const routes = await read($, peerRoutesA)
    for (const found of relayed ?? rowsFromMessage(stored.message ?? e.message, typed ? host : null, cwd)) {
      const row = hideMailboxes(found, routes)
      // A guest's prompt reached the model as "Name: text"; show it as theirs.
      const spoken = fromGuest && row.kind === 'user' ? splitSpeaker(row.text) : null
      // An edit's result carries its hunks as the tool reported them.
      const patch = row.kind === 'result' && row.id ? patches.get(row.id) : undefined
      if (patch && row.id) patches.delete(row.id)
      sendRow($, spoken ? { ...row, who: spoken.who, text: spoken.text } : patch ? { ...row, patch: patch.patch } : row)
      if (row.kind === 'assistant' && LOCAL_URL.test(row.text)) void shareLocal($, localPages(row.text))
    }
    return stored
  })

  // Host: remember whose turn each tool call ran for, so its row can say so,
  // and say it under the approval dialog with who's watching.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined && (await read($, modeA)) === 'host') {
      const working = await read($, workingA)
      const owner = turnOwner(working)
      if (owner) {
        await update($, ownersA, owners => {
          const entries = Object.entries({ ...owners, [e.tool_use_id]: owner })
          return Object.fromEntries(entries.slice(-300))
        })
      }
      const room = await read($, roomA)
      const watching = [...new Set((await read($, peopleA)).filter(p => p.online && p.role === 'guest' && !(room && isMe(p, room.seat))).map(p => p.name))]
      const line = working?.byGuest ? `${working.by}'s prompt asked for this${watching.length ? ` · ${listNames(watching)} watching` : ''}` : watching.length ? `${listNames(watching)} ${watching.length === 1 ? 'is' : 'are'} watching this session` : ''
      if (line) {
        try {
          $.ui.notice(e.tool_use_id, line)
        } catch {}
      }
    }
    const result = await next(e)
    // Host: an edit's hunks as the tool reported them, for its row in the room.
    if (e.agentId === undefined && FILE_TOOLS.has(e.tool) && result && typeof result === 'object' && 'result' in result && (await read($, modeA)) === 'host') {
      const out = (result as { result?: { structuredPatch?: unknown; type?: unknown; content?: unknown } }).result
      const patch = patchOf(out?.structuredPatch) ?? (out?.type === 'create' && typeof out.content === 'string' ? writeOf(out.content) : null)
      if (patch) {
        patches.set(e.tool_use_id, patch)
        if (patches.size > 100) patches.delete(patches.keys().next().value as string)
      }
    }
    if (result && typeof result === 'object' && 'deny' in result && typeof result.deny === 'string' && (await read($, modeA)) === 'guest') {
      refusedCalls.set(e.tool_use_id, result.deny)
    }
    // Host: what Claude showed goes to the room for guests (not awaited:
    // uploads shouldn't hold the turn).
    if (e.agentId === undefined && (await read($, modeA)) === 'host') {
      void captureShown($, e as unknown as Record<string, unknown>, result).catch(() => {})
      // A page it publishes or opens reaches everyone here as a copy of its
      // own: said to Claude, so it doesn't send people after the link.
      const action = String((e as { action?: unknown }).action ?? 'publish')
      if (e.tool === 'Artifact' && (action === 'publish' || action === 'open') && result && typeof result === 'object' && !('deny' in result && result.deny) && (await read($, policyA)).files !== 'off') {
        const room = await read($, roomA)
        const note = `Shared Sessions: this page also went to everyone in ${room?.host ?? 'this'}'s shared session, with its pictures and files; it opens in their own Claude Code (the browser pane, or Open in their Room). They don't need the claude.ai link, which stays private unless it's shared on claude.ai.`
        return { ...result, context: [...((result as { context?: readonly string[] }).context ?? []), note] } as typeof result
      }
    }
    return result
  })

  // The share command, asked for by Claude (the Skill tool) instead of typed:
  // answered from here, with where things stand, never with the fallback
  // page's "the plugin isn't running". Sharing itself starts only when the
  // person chooses it, since it sends the session's history.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const skill = String((e as { skill?: unknown }).skill ?? '').replace(/^\//, '')
    if (skill !== `${PLUGIN}:share-session` && skill !== 'share-session') return next(e)
    return { result: { success: true, commandName: skill, status: 'forked', agentId: PLUGIN, result: await shareAnswer($) } } as never
  })

  // Host: an agent is whoever's turn started it, or whose agent did, and so
  // is every call it makes (`callOwner`): a background one goes on after that
  // turn ends, into the host's turns and other teammates'. On the main loop,
  // the starting call's, else the turn's; inside an agent this session never
  // saw start, nothing is kept, and its calls are the running turn's. Kept
  // whatever the mode, so the host's own from before a share stay theirs.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const id = started.agentId
    if (!id || (await read($, modeA)) === 'guest') return started
    const working = await read($, workingA)
    const who = e.parentAgentId !== undefined ? ownerOf((await read($, agentsA))[e.parentAgentId]) : (ownerOf((await read($, ownersA))[e.tool_use_id]) ?? turnOwner(working) ?? { who: '', seat: '' })
    if (who === undefined) return started
    await update($, agentsA, agents => Object.fromEntries([...Object.entries(agents).filter(([agent]) => agent !== id), [id, who] as [string, ShareOwner]].slice(-200)))
    return started
  })

  // Host: a guest's prompt runs tools on this machine. What the host's policy
  // names asks first (edits, commands and the web by default), whatever the
  // permission mode; "Always allow" trusts that person for the session.
  on('tool.check', async ($, e, next) => {
    // The replay tool only returns what the host's Claude got: nothing to ask.
    if (e.tool === REPLAY_TOOL) return { decision: 'allow', reason: "Shows a call the host's Claude made; nothing runs here" }
    // Guest: a riding turn's own call to a viewer (what the host's Claude
    // showed, made again here) is this plugin's to approve, so it opens like
    // it did for the host. Only that exact call, never a public link, never
    // over an explicit deny; and not when the guest asked to be asked.
    const own = e.tool_use_id ? rideCalls.get(e.tool_use_id) : undefined
    if (own && own.approve && own.name === e.tool && sameArgs(own.input, e.input) && (await read($, modeA)) === 'guest' && (await read($, autoOpenA))) {
      const native = await next(e)
      const reason = 'reason' in native && typeof native.reason === 'string' ? native.reason : ''
      if (native.decision === 'allow' || (native.decision === 'deny' && !/auto mode|classifier|verdict/i.test(reason))) return native
      const room = await read($, roomA)
      return { decision: 'allow', reason: `Shown by ${room?.host ?? 'the host'}'s Claude in the shared session` }
    }
    const verdict = await next(e)
    if (e.tool_use_id && verdict.decision === 'deny' && (await read($, modeA)) === 'guest') {
      refusedCalls.set(e.tool_use_id, 'reason' in verdict && typeof verdict.reason === 'string' ? verdict.reason : '')
    }
    if (!e.tool_use_id || verdict.decision === 'deny') return verdict
    if ((await read($, modeA)) !== 'host') return verdict
    // Whose call it is, by its loop (`callOwner`); the host's own is the mode's.
    const owner = await callOwner($, e.agentId)
    if (owner === null) return verdict
    const who = owner.who
    const policy = await read($, policyA)
    // A cloud host holds its approver's Claude sign-in: a teammate's call is never let through unasked there.
    if (policy.approvals === 'none' && !(await isRunner($))) return verdict
    if (policy.approvals === 'edits' && READ_ONLY.has(e.tool) && (await readsInsideReally($, e.tool, (e.input ?? {}) as Record<string, unknown>, await $.session.cwd()))) return verdict
    // "Always allow" is the host's answer for this person's later calls too, so
    // it settles them the way "Allow once" settles one, not back to the host's
    // own permission prompt.
    if (trusts(await read($, trustedA), owner, await read($, peopleA))) {
      const room = await read($, roomA)
      return { decision: 'allow', reason: `${room?.host ?? 'The host'} always allows ${who}` }
    }

    const cwd = await $.session.cwd()
    const what = callWhat(e.tool, e.input, cwd)
    const extent = callExtent(e.tool, e.input)
    const always = `Always allow ${who}`.slice(0, 40)
    const room = await read($, roomA)
    // The host's to answer from here: unanswered until this hook returns.
    const id = e.tool_use_id
    await noteAsked($, id, what)
    let over = false
    let settle!: (label: string) => void
    const answered = new Promise<string>(resolve => { settle = resolve })
    const account = seatAccount(owner.seat, await read($, peopleA))
    const ask: Approval = {
      id: newId(),
      who,
      seat: owner.seat,
      ...(account ? { account } : {}),
      what,
      extent,
      always,
      question: `${who} wants Claude to run ${what.slice(0, 200)}${extent ? ` (${extent})` : ''}. Allow it?`,
      preview: approvalPreview(e.tool, e.input, cwd),
      whole: approvalPreview(e.tool, e.input, cwd, WHOLE_CALL_LINES),
      descriptions: {
        'Allow once': `Run this one ${e.tool} call for ${who}.`,
        [always]: `Don't ask again for ${who}'s requests while this session is shared.`,
        Decline: `Claude is told you declined and carries on without it.`,
      },
      room: room ? roomIdentity(room) : '',
      stage: 'waiting',
      // Answered, it's out of the list and over at once (what comes next looks
      // at `over` straight away); the next is asked or drawn as this goes on.
      answer: label => {
        const at = approvals.indexOf(ask)
        if (at >= 0) approvals.splice(at, 1)
        over = true
        wakeApprovals()
        settle(label)
      },
    }
    madeHere.add(ask.id)
    for (const old of [...madeHere].slice(0, -64)) madeHere.delete(old)
    approvals.push(ask)
    send($, 'approval', { pending: true, what })
    await update($, workingA, w => (w ? { ...w, waitingFor: approvals[0]?.what ?? what } : w))
    // Given up (the person's Esc), it goes, so a call behind it isn't left
    // waiting on an answer no one needs.
    const giveUp = () => ask.answer('Decline')
    next.signal.addEventListener('abort', giveUp, { once: true })
    let answer = 'Decline'
    let timer: Timer | null = null
    try {
      if (next.signal.aborted) giveUp()
      // The dialog, one call at a time, the oldest first.
      await approvalWait($, ask, answered, () => over || (!approvals.some(a => a.stage === 'dialog') && approvals.find(a => a.stage === 'waiting') === ask))
      // Trusted meanwhile (Always allow, in a dialog, for another of theirs): it goes unasked.
      if (!over && trusts(await read($, trustedA), owner, await read($, peopleA))) ask.answer(always)
      // A cloud host: asked of its approver through the room, wherever they are.
      if (!over && (await isRunner($))) {
        ask.stage = 'row'
        timer = $.clock.after(10 * 60_000, giveUp)
        send($, 'ask', { id: ask.id, who, ...(owner.seat ? { seat: owner.seat } : {}), what, ...(extent ? { extent } : {}), preview: ask.whole.slice(0, 4000), always, options: ['Allow once', always, 'Decline'] })
        await approvalWait($, ask, answered, () => over)
      } else if (!over) {
        ask.stage = 'dialog'
        const options = ['Allow once', always, 'Decline']
        const askedAt = await $.clock.now()
        let shown = true
        let said = 'Decline'
        try {
          said = await $.ui.ask(ask.question, { header: ASK_HEADER, options })
          if (!options.includes(said)) shown = false // something else answered for it (a settings hook)
        } catch {
          // Dismissed after a look is a no; refused at once, it never showed (a
          // settings hook on AskUserQuestion, a host with no dialog).
          shown = (await $.clock.now()) - askedAt > 1500
        }
        ask.stage = 'asked'
        wakeApprovals()
        if (shown) ask.answer(said)
        else if (!over) {
          // Asked in the row above the prompt instead, the person's own
          // buttons, where something draws it (a plain -p run and VS Code draw
          // none: a no, as before), after any of the calls asked there before
          // it. Looked at anew first (a write: the moment this hook's reads
          // keep): replaced by a reload since, it goes; trusted meanwhile (Always
          // allow on another of theirs, pressed while this was on its way), it's
          // allowed, never asked again.
          if (await replaced($)) ask.answer(REPLACED)
          else if (trusts(await read($, trustedA), owner, await read($, peopleA))) ask.answer(always)
          else if (next.signal.aborted || !drawsRow(await $.session.surfaces()) || !(await askedRoomOpen($, ask.room))) ask.answer('Decline')
          else {
            ask.stage = 'row'
            timer = $.clock.after(10 * 60_000, giveUp)
            await showBandAsk($)
            $.ui.toast(`${who} wants Claude to run ${what.slice(0, 80)}: answer above the prompt`)
            nudgeSidebar($)
            await approvalWait($, ask, answered, () => over)
          }
        }
      }
      answer = await answered
    } finally {
      timer?.cancel()
      next.signal.removeEventListener('abort', giveUp)
      const inRow = ask.stage === 'row'
      ask.answer('Decline') // out of the list however this ended (answered, nothing changes)
      if (inRow && answer !== REPLACED) await showBandAsk($)
    }
    // From here, looked at anew: a reload since, and the room as it is now.
    const isReplaced = answer === REPLACED || (await replaced($))
    const now = await read($, roomA)
    const host = now?.host ?? 'The host'
    if (answer === REPLACED) {
      // Denied in the host's place: what it put up goes with it, and the room
      // hears now, as this module goes once nothing waits in it.
      await takeBackAsk($, what, true)
      await noteAnswered($, id)
      await flushOut($)
      return { decision: 'deny', reason: `${host} hadn't answered this ${e.tool} call from the shared session when the plugin reloaded, so it didn't run; try again if it's still needed.` }
    }
    // The room it was asked in is over (Stop sharing, its end) by its answer:
    // no, as the row's calls are. Its teammate may be gone too.
    if (!(await askedRoomOpen($, ask.room))) answer = 'Decline'
    const allowed = answer === 'Allow once' || (always !== '' && answer === always)
    if (allowed && answer === always) {
      if (owner.seat) await update($, trustedA, list => [...list.filter(t => typeof t === 'object' && t.seat !== owner.seat), { who, seat: owner.seat, ...(account ? { account } : {}) }])
      // Given in the dialog too: their calls still waiting go with it.
      answerFor(ask, always)
    }
    // A cloud host's says which question settled, so its approver's list drops it.
    send($, 'approval', { pending: false, what, allowed, by: who, ...((await isRunner($)) ? { id: ask.id } : {}) })
    if (isReplaced) await flushOut($)
    else {
      // The oldest call still waiting (in the dialog, the row or for its turn)
      // is what the turn waits on now: said again, so the working line names
      // it, here and for guests. Replaced (a dialog answered after a reload),
      // both are the new module's.
      const still = approvals[0]
      await update($, workingA, w => (w ? { ...w, waitingFor: still?.what ?? null } : w))
      if (still) send($, 'approval', { pending: true, what: still.what })
    }
    await noteAnswered($, id)
    return allowed
      ? { decision: 'allow', reason: `${host} allowed it` }
      : { decision: 'deny', reason: `${host} did not allow this ${e.tool} call from the shared session.` }
  }).catch(async ($, e, next) => {
    // The hook failed: it threw, ran out of time, or its module ended under
    // it (then this is asked in the module that replaced it). A failed hook
    // leaves the verdict beneath, which may allow what was the host's to
    // answer: a teammate's call put to the host and still unanswered (here,
    // or in the state for the next module) is denied instead, and its wait
    // goes from the working lines (`takeBackAsk`). Any other keeps that
    // verdict, as before.
    const id = e.tool_use_id
    if (!id || !(askedHere.has(id) || (await read($, unansweredA).catch(() => [] as string[])).includes(id))) return next(e)
    const what = askedHere.get(id) ?? callWhat(e.tool, e.input, await $.session.cwd().catch(() => ''))
    await noteAnswered($, id)
    await takeBackAsk($, what, false)
    const host = (await read($, roomA).catch(() => null))?.host ?? 'The host'
    return { decision: 'deny', reason: `${host} hadn't answered this ${e.tool} call from the shared session, so it didn't run; try again if it's still needed.` }
  })

  // -------------------------------------------------------------------------
  // Drawing

  // A teammate's prompt, here as the plugin submitted it ("Sam: text"): their
  // face and name over their words.
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'plugin' } } }, async ($, e, next) => {
    const origin = e.props.origin
    // Installed (`shared-session`, `…@claude-share`) or a folder copy (`…@inline`).
    if (!('name' in origin) || (origin.name !== PLUGIN && !String(origin.name).startsWith(`${PLUGIN}@`))) return next(e)
    const said = splitSpeaker(typedText(e.props.text))
    if (!said) return next(e)
    promptRows.set(said.text.replace(/\s+/g, ' ').trim().slice(0, 400), e.requestId)
    // A message another session sent them, passed on: its body, and whence it
    // came (its wrapper drawn as markdown would hide the first lines).
    const relayed = delivered(said.text)
    const el = $.ui.resolve(e)
    const { Box, Text, Markdown } = el
    // Their color in this room (a name keeps it after its person leaves).
    const color = roomColors(await read($, peopleA), (await read($, activityA)).map(a => a.who)).get(said.who) ?? colorFor(said.who)
    const avatar = faceOf(el, e.surface, { name: said.who, online: true, color })
    if (relayed) {
      // A message another session sent them, which they passed on: who passed
      // it and whence it came over its body as a quote, folded to its head
      // until ctrl+o as the terminal folds its own messages.
      const lines = relayed.text.split('\n')
      const shown = e.props.isExpanded || lines.length <= 8 ? lines : lines.slice(0, 6)
      const quoted = shown.map(line => (line ? `> ${line}` : '>')).join('\n')
      const more = shown.length < lines.length ? `\n>\n> … +${lines.length - shown.length} lines (ctrl+o to expand)` : ''
      return (
        <Box flexDirection="row" gap={1}>
          {avatar}
          <Box flexDirection="column" flexShrink={1} minWidth={0}>
            <Box flexDirection="row" gap={1}>
              <Text bold color={color} hover={{ scope: `person-${said.who}`, inverse: true }}>
                {said.who}
              </Text>
              <Text dimColor>{`relayed a message from ${relayed.from}`}</Text>
            </Box>
            <Markdown key="said" text={`${quoted}${more}`} />
          </Box>
        </Box>
      )
    }
    return (
      <Box flexDirection="row" gap={1}>
        {avatar}
        <Box flexDirection="column" flexShrink={1} minWidth={0}>
          <Text bold color={color} hover={{ scope: `person-${said.who}`, inverse: true }}>
            {said.who}
          </Text>
          <Markdown key="said" text={said.text} />
        </Box>
      </Box>
    )
  })

  // In a shared session, a person's own prompt: Desktop's bubble as it is,
  // under their name in their color, which lights up with them in the Room.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.isExpanded || !GUEST_SENDS.has(e.props.origin.kind)) return next(e)
    const v = await view($)
    if (v.mode === 'idle' || !v.room) return next(e)
    promptRows.set(typedText(e.props.text).replace(/\s+/g, ' ').trim().slice(0, 400), e.requestId)
    const me = await meIn($, v.room)
    const el = $.ui.resolve(e)
    const { Box, Text } = el
    const color = roomColors(v.everyone).get(me) ?? colorFor(me)
    const native = await next(e)
    return fit(
      <Box key={`prompt-${e.requestId}`} flexDirection="column">
        <Box flexDirection="row" alignItems="center" gap={1}>
          {faceOf(el, e.surface, { name: me, online: true, color }, 16)}
          <Text size="caption" weight="semibold" color={color} hover={{ scope: `person-${me}`, inverse: true }}>
            {` ${me} `}
          </Text>
          {v.mode === 'host' ? (
            <Text size="caption" dimColor>
              host
            </Text>
          ) : null}
        </Box>
        {native}
      </Box>,
      modern,
    )
  })

  // Claude's replies in a shared session: who the turn was for over its
  // first block, and under each, reactions and who has seen it. A row
  // nobody reacted to or saw shows its reactions when the reply is hovered.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary || !e.props.text.trim()) return next(e)
    const v = await view($)
    if (v.mode === 'idle' || !v.room) return next(e)
    const key = replyKey(e.props.text)
    // On screen here (or where the surface doesn't say): seen, said to the room.
    if (v.mode === 'guest' && e.props.onScreen !== null && !sentSeen.has(key) && !pendingSeen.has(key)) {
      pendingSeen.add(key)
      seenTimer ??= $.clock.after(4_000, () => {
        seenTimer = null
        void flushSeen($).catch(() => {})
      })
    }
    const me = await meIn($, v.room)
    const forWho = e.props.isFirstOfReply ? (await read($, replyForA))[e.requestId] : undefined
    const reactions = (await read($, reactionsA))[key] ?? {}
    const seen = (await read($, seenA))[key] ?? []
    const colors = roomColors(v.everyone, [...seen, ...Object.values(reactions).flat(), ...(forWho ? [forWho] : [])])
    const colorOf = (name: string) => colors.get(name) ?? colorFor(name)
    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
    const Svg = svgOf(el, e.surface)
    const native = await next(e)
    const counts = REACTS.map(r => ({ r, who: reactions[r] ?? [], mine: (reactions[r] ?? []).includes(me) }))
    const reacted = counts.filter(c => c.who.length)
    const unreacted = counts.filter(c => !c.who.length)
    const seenBy = [...new Set([...seen, ...reacted.flatMap(c => c.who)])].filter(n => n !== me)
    const shows = reacted.length > 0 || seenBy.length > 0
    const stack = seenBy.length && Svg ? stackSvg(seenBy.map(n => ({ name: n, online: true, color: colorOf(n) })), { size: 16, max: 6 }) : null
    const chip = (r: string, who: string[], mine: boolean) => (
      <Button key={`react-${r}`} plain onPress={() => void react($, key, r, !mine)}>
        {r}
        <Text tabular dimColor={!mine} color={mine ? 'claude' : undefined}>
          {` ${who.length || '+'}`}
        </Text>
      </Button>
    )
    return fit(
      <Box key={`reply-${e.requestId}-${key}`} flexDirection="column">
        {forWho ? (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text size="caption" color="claude">
              ◆
            </Text>
            <Text size="caption" dimColor>
              Claude, for
            </Text>
            <Text size="caption" weight="semibold" color={colorOf(forWho)} hover={{ scope: `person-${forWho}`, inverse: true }}>
              {` ${forWho} `}
            </Text>
          </Box>
        ) : null}
        {native}
        <Box flexDirection="row" alignItems="center" gap="xs" display={shows ? 'flex' : 'none'} hover={shows ? undefined : { display: 'flex' }}>
          {reacted.map(c => chip(c.r, c.who, c.mine))}
          {shows && unreacted.length ? (
            <Box flexDirection="row" gap="xs" display="none" hover={{ display: 'flex' }}>
              {unreacted.map(c => chip(c.r, c.who, c.mine))}
            </Box>
          ) : (
            unreacted.map(c => chip(c.r, c.who, c.mine))
          )}
          {stack && Svg ? <Svg source={stack.source} alt={`Seen by ${seenBy.join(', ')}`} width={stack.width} height={16} /> : null}
          {seenBy.length ? (
            <Text size="caption" dimColor>
              {`${listNames(seenBy)} saw this`}
            </Text>
          ) : null}
        </Box>
      </Box>,
      modern,
    )
  })

  // The terminal's line that closes a turn: who it was for, who watched.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const v = await view($)
    if (v.mode === 'idle' || !v.room || !lastTurnFor) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const watching = [...new Set(v.everyone.filter(p => p.online && !isMe(p, v.me)).map(p => p.name))]
    const native = await next(e)
    return (
      <Box flexDirection="row" gap={1}>
        {native}
        <Text dimColor>{`· for ${lastTurnFor}${watching.length ? ` · ${listNames(watching)} watching` : ''}`}</Text>
      </Box>
    )
  })

  // /who's answer as a card in the transcript: the room live, everyone in
  // their color with what they're doing, and the Room a press away.
  on('ui.render', { component: 'CommandOutput', props: { command: 'who' } }, async ($, e, next) => {
    const v = await view($)
    if (v.mode === 'idle' || !v.room) return next(e)
    return fit(whoCard($.ui.resolve(e), e.surface, v, await read($, turnsA), await $.clock.now(), () => void openRoom($)), modern)
  })
  on('ui.render', { component: 'CommandOutput', props: { command: 'shared-session:who' } }, async ($, e, next) => {
    const v = await view($)
    if (v.mode === 'idle' || !v.room) return next(e)
    return fit(whoCard($.ui.resolve(e), e.surface, v, await read($, turnsA), await $.clock.now(), () => void openRoom($)), modern)
  })

  // Host: a tool call Claude made for a teammate says for whom.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if ((await read($, modeA)) !== 'host') return next(e)
    const who = ownerOf((await read($, ownersA))[e.props.tool_use_id])?.who
    if (!who) return next(e)
    const drawn = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const color = roomColors(await read($, peopleA)).get(who) ?? colorFor(who)
    return (
      <Box flexDirection="column">
        {drawn}
        <Box flexDirection="row" gap={1} paddingLeft={2}>
          <Text dimColor>↳ for</Text>
          <Text bold color={color}>
            {who}
          </Text>
        </Box>
      </Box>
    )
  })

  // Host: the approval question previews exactly what would run: the call
  // whose dialog is up, one at a time, and only for its own question.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const ask = approvals.find(a => a.stage === 'dialog')
    const questions = e.props.questions as { question?: string; header?: string; options?: { label: string; description?: string }[] }[]
    const first = questions[0]
    if (!ask || first?.header !== ASK_HEADER || first.question !== ask.question || !first.options) return next(e)
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
    // The host's own turn: the engine's words, and who's watching it.
    const watching = v.mode === 'host' ? new Set(v.everyone.filter(p => p.online && p.role === 'guest' && !isMe(p, v.me)).map(p => p.name)).size : 0
    if (v.mode === 'host' && watching) message = `${message ?? e.props.message ?? e.props.word} · ${watching} watching`
    if (v.mode === 'guest') {
      if (w?.waitingFor) message = `Waiting for ${host} to allow ${w.waitingFor}`
      else if (w?.doing) message = `${doingLine(w.doing)}${w.by === myName ? '' : ` · for ${w.by}`}`
      else if (w) message = w.by === myName ? `Working on your prompt in ${host}'s session` : `Working for ${w.by}`
      else message = `Waiting for ${host}'s session`
    }
    return message ? next({ ...e, props: { ...e.props, message } }) : next(e)
  })

  // A guest's hint line says where typing goes.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const v = await view($)
    if (v.mode === 'host' && !e.props.isDraft) {
      // The host: who sees what they send.
      const others = [...new Set(v.everyone.filter(p => p.online && p.role === 'guest' && !isMe(p, v.me)).map(p => p.name))]
      if (!others.length) return next(e)
      const hint = e.props.isWorking ? `${listNames(others)} ${others.length === 1 ? 'sees' : 'see'} this turn as it happens` : `${listNames(others)} will see what you send · @name mentions someone`
      return next({ ...e, props: { ...e.props, hint } })
    }
    if (v.mode !== 'guest') return next(e)
    const hint =
      v.policy.prompts === 'watch'
        ? `Watch-only · chat in the Room (/room) · Leave anytime`
        : `↵ sends to ${v.room?.host}'s session · @name mentions someone · Esc stops the turn`
    return next({ ...e, props: { ...e.props, hint } })
  })

  // The Team panel. Signed out: what it's for and the sign-ins. In a team: its
  // name and where shares go, then its pages. Live: invites and the sessions
  // shared with it, a press from joining. People: who's in it and its invite
  // link. Settings: who may join, and your own.
  on('ui.render', { component: 'Pane', requestId: TEAM }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
    const Svg = svgOf(el, e.surface)
    const Input = inputOf(el)
    const Select = selectOf(el)
    const Link = 'Link' in el ? el.Link : undefined
    const t = await read($, teamsA)
    const now = await $.clock.now()
    const room = await read($, roomA)
    const mode = await read($, modeA)
    const fail = (what: string) => (error: unknown) => $.ui.toast(`Couldn't ${what}: ${String((error as Error)?.message ?? error)}`)
    const providerName = (id: string) => t.providers.find(p => p.id === id)?.label ?? (id === 'github' ? 'GitHub' : id === 'google' ? 'Google' : id)

    if (!t.account) {
      const signing = t.signingIn
      return (
        <Box flexDirection="column" gap={1}>
          {Svg ? <Svg key="clover" source={cloverSvg(96)} alt="Clover" width={96} height={54} /> : null}
          <Text bold>Share with your team</Text>
          <Text dimColor>Sign in, and your teammates' live sessions show up here, a press from joining. What you share goes to them.</Text>
          {t.invite ? <Text color="claude">Your invite is waiting: you join the team as soon as you're signed in.</Text> : null}
          {t.error ? <Text color="error">{t.error}</Text> : null}
          {signing ? (
            <Box flexDirection="column" gap={1} marginTop={1}>
              <Text>{`Finish signing in with ${providerName(signing.provider)} in your browser…`}</Text>
              <Text>{codeSaid(signing.code)}</Text>
              <Box flexDirection="row" gap={1} alignItems="center">
                {Link && linkable(signing.url) ? <Link href={signing.url} label="Open the sign-in page again" /> : null}
                <Button key="signin-cancel" label="Cancel" plain dimColor onPress={() => void cancelSignIn($)} />
              </Box>
            </Box>
          ) : t.providers.length ? (
            <Box flexDirection="row" gap={1} marginTop={1}>
              {t.providers.map((p, i) => (
                <Button key={`signin-${p.id}`} label={`Sign in with ${p.label}`} variant={i === 0 ? 'primary' : undefined} onPress={() => void startSignIn($, p.id).catch(fail('sign in'))} />
              ))}
            </Box>
          ) : t.loaded ? (
            <Text dimColor>This share server has no sign-in, so teams aren't available on it. Sharing by link still works.</Text>
          ) : (
            <Text dimColor>Loading…</Text>
          )}
        </Box>
      )
    }

    const account = t.account
    const team = t.teams.find(x => x.id === t.current) ?? null
    const invites = await read($, invitesA)
    const inviteRow = (invite: ShareInvite) => {
      const color = colorFor(invite.from.name)
      return (
        <Box key={`inv-${invite.room.id}`} flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0}>
            {faceOf(el, e.surface, { name: invite.from.name, online: true, color })}
            <Box flexDirection="column" flexShrink={1} minWidth={0}>
              <Text bold wrap="truncate-end">
                {tidyTitle(invite.room.title)}
              </Text>
              <Text wrap="truncate-end">
                <Text color={color}>{invite.from.name}</Text>
                <Text dimColor>{` invited you · ${ago(invite.at, now)}`}</Text>
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Button key={`inv-join-${invite.room.id}`} label="Join" variant="primary" onPress={press => void joinInvited($, invite, press.surface)} />
            <Button key={`inv-dismiss-${invite.room.id}`} label="Dismiss" plain dimColor onPress={() => void dropInvite($, invite.room.id)} />
          </Box>
        </Box>
      )
    }
    const accountRow = (
      <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
        <Text dimColor wrap="truncate-end">{`Signed in as ${account.name}${account.login && account.login !== account.name ? ` (${account.login})` : ''} · ${providerName(account.provider)}`}</Text>
        <Button key="signout" label="Sign out" plain dimColor onPress={() => void signOut($)} />
      </Box>
    )
    const newTeam = (autoFocus: boolean) =>
      Input ? (
        <Input
          key="team-new"
          placeholder="Team name"
          submitLabel="Create team"
          autoFocus={autoFocus || undefined}
          onSubmit={(value: string) => void createTeam($, value).then(() => update($, teamsA, x => ({ ...x, creating: false }))).catch(fail('make the team'))}
        />
      ) : (
        <Text dimColor>/team create &lt;name&gt;</Text>
      )

    if (!team) {
      return (
        <Box flexDirection="column" gap={2}>
          {invites.length ? (
            <Box flexDirection="column" gap={1}>
              {headingOf(el, 'Invited you')}
              {invites.map(inviteRow)}
            </Box>
          ) : null}
          <Box flexDirection="column" gap={1}>
            <Text bold>Make your team</Text>
            <Text dimColor>Name it, then send its invite link to teammates. Got a link from someone? Paste it as your message instead.</Text>
          </Box>
          {newTeam(true)}
          {t.error ? <Text color="error">{t.error}</Text> : null}
          {accountRow}
        </Box>
      )
    }

    const owner = team.role === 'owner'
    // You're one person across sessions: what you share or are in already
    // isn't offered again (another session here opens instead).
    const here = t.here ?? {}
    const stopping = await read($, stoppingRoomA)
    const yours = (s: ShareTeamSession) => s.hostAccount === account.id || Boolean(here[s.id]) || Boolean(s.accounts?.includes(account.id))
    const joinable = t.sessions.filter(s => s.id !== room?.id && s.hostOnline && !yours(s))
    const invite = inviteUrl(t, team)
    const sessionRow = (s: ShareTeamSession) => {
      const mine = s.hostAccount === account.id
      const inIt = room?.id === s.id
      const inElsewhere = !inIt && !mine && (Boolean(here[s.id]) || Boolean(s.accounts?.includes(account.id)))
      const others = s.people.filter(n => n !== s.host && !(inElsewhere && n === account.name))
      const canJoin = joinable.includes(s)
      const color = colorFor(s.host)
      return (
        <Box key={`ts-${s.id}`} flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0}>
            {faceOf(el, e.surface, { name: s.host, online: s.hostOnline, color })}
            <Box flexDirection="column" flexShrink={1} minWidth={0}>
              <Text bold={s.hostOnline} dimColor={!s.hostOnline} wrap="truncate-end">
                {tidyTitle(s.title)}
              </Text>
              <Text wrap="truncate-end">
                <Text color={s.hostOnline ? color : undefined} dimColor={!s.hostOnline}>
                  {mine ? 'You' : s.host}
                </Text>
                <Text dimColor>
                  {[
                    '',
                    s.hostOnline ? ago(s.createdAt, now) : 'away',
                    others.length ? `with ${listNames(others)}` : '',
                    inElsewhere ? (here[s.id] ? "you're in it in another session" : "you're in it elsewhere") : '',
                  ]
                    .filter((x, i) => i === 0 || x)
                    .join(' · ')}
                </Text>
              </Text>
            </Box>
          </Box>
          <Box flexShrink={0} flexDirection="row" gap={1}>
            {inIt ? (
              <Text color="claude">{mode === 'host' ? 'This session' : "You're in it"}</Text>
            ) : mine ? (
              [
                here[s.id] ? <Button key={`open-${s.id}`} label="Open" plain onPress={() => void openHere($, s.id)} /> : null,
                stopping === `stop:${s.id}` ? (
                  <Button key={`stop-${s.id}`} label="Stop for everyone?" variant="primary" onPress={() => void stopFromTeam($, s.id)} />
                ) : (
                  <Button key={`stop-${s.id}`} label="Stop" plain dimColor onPress={() => void stopFromTeam($, s.id)} />
                ),
              ]
            ) : inElsewhere ? (
              // In it in another session here (Open) or on another computer
              // (Join here too): Leave takes every seat of yours out.
              [
                here[s.id] ? (
                  <Button key={`open-${s.id}`} label="Open" plain onPress={() => void openHere($, s.id)} />
                ) : (
                  <Button key={`join-${s.id}`} label="Join" plain dimColor onPress={press => void joinFromTeam($, [s], press.surface)} />
                ),
                stopping === `leave:${s.id}` ? (
                  <Button key={`leave-${s.id}`} label="Leave everywhere?" variant="primary" onPress={() => void leaveFromTeam($, s.id)} />
                ) : (
                  <Button key={`leave-${s.id}`} label="Leave" plain dimColor onPress={() => void leaveFromTeam($, s.id)} />
                ),
              ]
            ) : here[s.id] ? (
              <Button key={`open-${s.id}`} label="Open" plain onPress={() => void openHere($, s.id)} />
            ) : canJoin ? (
              <Button key={`join-${s.id}`} label="Join" variant={joinable.length === 1 ? 'primary' : undefined} onPress={press => void joinFromTeam($, [s], press.surface)} />
            ) : (
              <Button key={`join-${s.id}`} label="Join" plain dimColor onPress={press => void joinFromTeam($, [s], press.surface)} />
            )}
          </Box>
        </Box>
      )
    }

    // On top: the team (a picker when you're in several), where shares go,
    // and this session's own place in it; a newer release and its Update.
    const teamUpdate = await updateRow($, el, true)
    const header = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} justifyContent="space-between" alignItems="center">
          {t.teams.length > 1 && Select ? (
            <Select key="team-pick" value={team.id} options={t.teams.map(x => ({ value: x.id, label: x.name }))} onSelect={(value: string) => void setCurrentTeam($, value)} />
          ) : (
            <Text bold>{team.name}</Text>
          )}
          <Text dimColor>{team.access === 'link' ? 'anyone with a link joins' : 'members only'}</Text>
        </Box>
        {teamUpdate}
        {Select
          ? settingOf(
              el,
              'Your shares go',
              <Select
                key="share-to"
                value={t.byLink ? 'link' : team.id}
                options={[...t.teams.map(x => ({ value: x.id, label: `To ${x.name}` })), { value: 'link', label: 'By link alone' }]}
                onSelect={(value: string) => void setCurrentTeam($, value === 'link' ? null : value)}
              />,
            )
          : null}
        {room && mode === 'host' ? (
          <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
            <Text dimColor wrap="truncate-end">{room.team ? `This session: shared with ${room.team.name}` : 'This session: shared by link'}</Text>
            {room.team ? (
              <Button key="room-unteam" label="Link only" plain onPress={() => void setRoomTeam($, null)} />
            ) : (
              <Button key="room-team" label={`Share with ${team.name}`} plain onPress={() => void setRoomTeam($, team.id)} />
            )}
          </Box>
        ) : null}
      </Box>
    )

    const liveCount = t.sessions.filter(s => s.hostOnline).length
    const tab = await read($, teamTabA)
    const tabs = tabsOf(
      el,
      [
        { id: 'live', label: 'Live', count: liveCount + invites.length || undefined, news: invites.length > 0 || joinable.length > 0 },
        { id: 'people', label: 'People', count: t.members.length || undefined },
        { id: 'settings', label: 'Settings' },
      ],
      tab,
      id => void update($, teamTabA, () => id),
    )

    const livePage = (
      <Box flexDirection="column" gap={2}>
        {invites.length ? (
          <Box flexDirection="column" gap={1}>
            {headingOf(el, 'Invited you')}
            {invites.map(inviteRow)}
          </Box>
        ) : null}
        <Box flexDirection="column" gap={1}>
          {headingOf(
            el,
            'Live now',
            joinable.length > 1 ? <Button key="join-all" label="Join all" variant="primary" onPress={press => void joinFromTeam($, joinable, press.surface)} /> : t.sessions.length ? `${t.sessions.length} shared` : '',
          )}
          {t.sessions.map(sessionRow)}
          {t.sessions.length ? null : <Text dimColor>{`Nothing is shared with ${team.name} right now. A session someone shares with it shows up here.`}</Text>}
          {joinable.length > 1 ? <Text dimColor>{mode === 'idle' ? 'Join all: the first joins here, the rest in new sessions.' : 'Join all: each opens in a new session.'}</Text> : null}
        </Box>
      </Box>
    )

    const memberColors = colorsFor(t.members.map(m => m.name))
    const peoplePage = (
      <Box flexDirection="column" gap={2}>
        <Box flexDirection="column" gap={1}>
          {t.members.map(m => (
            <Box key={`member-${m.id}`} flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
              <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0}>
                {faceOf(el, e.surface, { name: m.name, online: true, color: memberColors.get(m.name) })}
                <Text bold color={memberColors.get(m.name)} wrap="truncate-end">
                  {m.name}
                </Text>
                {m.login && m.login !== m.name ? <Text dimColor>{m.login}</Text> : null}
              </Box>
              <Text dimColor>{[m.role === 'owner' ? 'owner' : '', m.id === account.id ? 'you' : ''].filter(Boolean).join(' · ')}</Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" gap={1}>
          {headingOf(el, 'Invite to the team', 'they paste it, or open it')}
          <Box flexDirection="row" alignItems="center" gap={1} borderStyle="round" borderDimColor paddingX={1}>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-middle">
                {invite.replace(/^https?:\/\//, '')}
              </Text>
            </Box>
            <Button key="invite-copy" label="Copy invite link" plain onPress={press => void copyText($, invite, 'Invite link copied', press.surface)} />
          </Box>
          {owner ? (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Button key="invite-new" label="Replace invite link" plain dimColor onPress={() => void newInvite($).catch(fail('replace the link'))} />
              <Text dimColor>The old link stops working</Text>
            </Box>
          ) : null}
        </Box>
      </Box>
    )

    const settingsPage = (
      <Box flexDirection="column" gap={2}>
        {owner ? (
          <Box flexDirection="column" gap={1}>
            {headingOf(el, `Everyone in ${team.name}`, '')}
            {Select
              ? settingOf(
                  el,
                  'Who can join',
                  <Select
                    key="team-access"
                    value={team.access}
                    options={[
                      { value: 'members', label: 'Only people in the team' },
                      { value: 'link', label: 'Anyone with the link' },
                    ]}
                    onSelect={(value: string) => void changeTeam($, { access: value === 'link' ? 'link' : 'members' }).catch(fail('change it'))}
                  />,
                )
              : null}
            {Input
              ? settingOf(
                  el,
                  'Join by email domain',
                  <Input key={`team-domains-${(team.domains ?? []).join(',')}`} value={(team.domains ?? []).join(', ')} placeholder="example.com" submitLabel="Save" onSubmit={(value: string) => void changeTeam($, { domains: value }).catch(fail('save it'))} />,
                )
              : null}
            {Input
              ? settingOf(
                  el,
                  'Join by GitHub org',
                  <Input key={`team-orgs-${(team.githubOrgs ?? []).join(',')}`} value={(team.githubOrgs ?? []).join(', ')} placeholder="your-org" submitLabel="Save" onSubmit={(value: string) => void changeTeam($, { githubOrgs: value }).catch(fail('save it'))} />,
                )
              : null}
            <Text dimColor>People who sign in with a verified email at the domain, or with GitHub as a member of the org, join by themselves. You can add your own email's domain (not a public one like gmail.com) and orgs you're in.</Text>
          </Box>
        ) : null}
        <Box flexDirection="column" gap={1}>
          {headingOf(el, 'Just you', '')}
          {Select
            ? settingOf(
                el,
                'Invites to a session',
                <Select
                  key="invite-notify"
                  value={(await $.store.get(NOTIFY_KEY).catch(() => undefined)) === false ? 'quiet' : 'notify'}
                  options={[
                    { value: 'notify', label: 'Notify me' },
                    { value: 'quiet', label: 'Just show them' },
                  ]}
                  onSelect={(value: string) => void $.store.set(NOTIFY_KEY, value !== 'quiet').then(() => $.ui.invalidate('ui.render'))}
                />,
              )
            : null}
          {accountRow}
          {t.creating ? newTeam(true) : null}
          {t.error ? <Text color="error">{t.error}</Text> : null}
          <Box flexDirection="row" gap={1} justifyContent="space-between">
            <Button key="team-create" label={t.creating ? 'Cancel' : 'New team'} plain onPress={() => void update($, teamsA, x => ({ ...x, creating: !x.creating }))} />
            <Button key="team-leave" label={`Leave ${team.name}`} plain dimColor onPress={() => void leaveTeam($).catch(fail('leave'))} />
          </Box>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={2}>
        {header}
        {tabs}
        {tab === 'people' ? peoplePage : tab === 'settings' ? settingsPage : livePage}
      </Box>
    )
  })

  // The Room: the session on top (its name, Live, who's here, the link), then
  // its pages. People: who's here and, for the host, teammates to invite.
  // Chat: the side chat and what happened, one timeline. Shown: what Claude
  // showed. Settings: who may do what, updates, and the button that ends it.
  on('ui.render', { component: 'Pane', requestId: ROOM }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = el
    const Svg = svgOf(el, e.surface)
    const Input = inputOf(el)
    const Select = selectOf(el)
    const v = await view($)
    const room = v.room

    if (v.mode === 'idle' || !room) {
      if (v.asking) return shareChoice($, el, v.asking.prompts, 'room', e.surface, await shareTeamName($))
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>This session isn't shared</Text>
          <Text dimColor>Share it, and teammates join from their own Claude Code with a link. They see the conversation live and can prompt Claude here.</Text>
          {takingBackNow() || (await closingNow($)) ? null : (
            <Box flexDirection="row" marginTop={1}>
              <Button
                key="room-share"
                label="Share this session"
                variant="primary"
                onPress={press => void requestShare($, press.surface).catch(error => $.ui.log(`Couldn't share: ${String(error?.message ?? error)}`))}
              />
            </Box>
          )}
        </Box>
      )
    }

    const now = await $.clock.now()
    const activity = await read($, activityA)
    const chat = await read($, chatA)
    const trusted = await read($, trustedA)
    const cloudTrusted = await read($, cloudTrustedA)
    const shown = await read($, shownA)
    const localPreviews = await read($, localPreviewsA)
    const newer = await read($, newerA)
    const updates = await read($, updatesA)
    const colors = roomColors(v.everyone, [...chat.map(c => c.who), ...activity.map(a => a.who)])
    const colorOf = (name: string) => colors.get(name) ?? colorFor(name)
    const people = faces(v, colors)
    const isHost = v.mode === 'host'
    // The host: a teammate's call waiting in the row above the prompt, whole
    // (the row names it by one line), with the row's own answers.
    const approving = isHost ? await read($, approvingA) : null
    const waiting = approving ? approvals.find(a => a.id === approving.id) : undefined
    const approvalBlock = approving ? (
      <Box flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
        <Text wrap="truncate-end">
          <Text bold color={colorOf(approving.who)}>
            {approving.who}
          </Text>
          <Text>{' wants Claude to run '}</Text>
          <Text bold>{approving.what}</Text>
        </Text>
        {waiting ? <Markdown key="approval-whole" text={waiting.whole} /> : null}
        <Box flexDirection="row" gap={1}>
          <Button key="room-approve-once" label="Allow once" variant="primary" onPress={() => answerBandAsk(approving.id, 'Allow once')} />
          <Button key="room-approve-always" label={approving.always} plain onPress={() => answerBandAsk(approving.id, approving.always)} />
          <Button key="room-approve-no" label="Decline" plain dimColor onPress={() => answerBandAsk(approving.id, 'Decline')} />
        </Box>
      </Box>
    ) : null
    // The cloud host: its approver's status, questions and Bring home; the
    // host's Move to cloud, step by step.
    const cloud = await read($, cloudA)
    // The approver sets the cloud host's settings here while it runs, as its host's Room would.
    const cloudSettings = !isHost && Boolean(cloud?.mine) && cloud?.state !== 'stopped'
    const cloudMove = await read($, cloudMoveA)
    const cloudAsks = !isHost && cloud?.mine ? await read($, cloudAsksA) : []
    const runnerHere = await isRunner($)
    const hhmm = (ts: number) => {
      const d = new Date(ts)
      return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
    }
    const cloudBlock =
      !isHost && cloud?.mine ? (
        <Box key="cloud" flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
          <Text wrap="truncate-end">
            <Text weight="semibold" color="claude">
              In the cloud
            </Text>
            <Text dimColor>
              {` · ${cloud.state === 'starting' ? 'starting' : cloud.state === 'stopped' ? 'stopped' : `since ${hhmm(cloud.since)}`} · you approve teammates’ calls`}
            </Text>
          </Text>
          {cloudAsks.map(ask =>
            ask.kind ? (
              <Box key={`cloud-ask-${ask.id}`} flexDirection="column" gap={1}>
                <Text wrap="truncate-end">{ask.what}</Text>
                <Text dimColor>{cloudAskMeans(ask)}</Text>
                <Box flexDirection="row" gap={1}>
                  <Button key={`cloud-ask-yes-${ask.id}`} label={ask.options[0] ?? 'Share'} variant="primary" onPress={() => void answerCloudAsk($, ask.id, ask.options[0] ?? 'Share')} />
                  <Button key={`cloud-ask-not-now-${ask.id}`} label="Not now" plain dimColor onPress={() => void answerCloudAsk($, ask.id, 'Not now')} />
                </Box>
              </Box>
            ) : (
            <Box key={`cloud-ask-${ask.id}`} flexDirection="column" gap={1}>
              <Text wrap="truncate-end">
                <Text bold color={colorOf(ask.who)}>
                  {ask.who}
                </Text>
                <Text>{' wants the cloud host to run '}</Text>
                <Text bold>{ask.what}</Text>
              </Text>
              {ask.preview ? <Markdown key={`cloud-ask-whole-${ask.id}`} text={ask.preview} /> : null}
              <Box flexDirection="row" gap={1}>
                <Button key={`cloud-ask-once-${ask.id}`} label="Allow once" variant="primary" onPress={() => void answerCloudAsk($, ask.id, 'Allow once')} />
                {ask.always ? <Button key={`cloud-ask-always-${ask.id}`} label={ask.always} plain onPress={() => void answerCloudAsk($, ask.id, ask.always)} /> : null}
                <Button key={`cloud-ask-no-${ask.id}`} label="Decline" plain dimColor onPress={() => void answerCloudAsk($, ask.id, 'Decline')} />
              </Box>
            </Box>
            ),
          )}
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button key="cloud-home" label={cloudMove?.stage === 'home' ? 'Bringing it home…' : 'Bring home'} variant={cloudAsks.length ? 'secondary' : 'primary'} onPress={() => void bringHome($)} />
            <Box flexShrink={1} minWidth={0}>
              {cloudMove?.stage === 'failed' ? <Text color="error">{cloudMove.note ?? "Couldn't bring it home."}</Text> : <Text dimColor>Takes the session back here, with the cloud host's changes to your files.</Text>}
            </Box>
          </Box>
        </Box>
      ) : null
    const cloudMoveBlock =
      !isHost || runnerHere ? null : cloudMove?.stage === 'token' ? (
        <Box key="cloud-token" flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
          <Text weight="semibold">Move to cloud signs in to Claude as you</Text>
          <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
            <Box flexShrink={1} minWidth={0}>
              <Text>1. In a terminal, run claude setup-token and approve it in your browser.</Text>
            </Box>
            <Button key="cloud-copy-command" label="Copy command" plain onPress={press => void copyText($, 'claude setup-token', 'Command copied: run it in a terminal', press.surface)} />
          </Box>
          <Text>2. Copy the token it prints, then press Use copied token.</Text>
          <Text dimColor>The token stays on this computer and goes to the cloud host when you move; it's never shown. Teammates' prompts there use your Claude plan, and every call of theirs asks you first. Revoke it any time at claude.ai.</Text>
          {cloudMove.note ? <Text color="error">{cloudMove.note}</Text> : null}
          <Box flexDirection="row" gap={1}>
            <Button key="cloud-use-token" label="Use copied token" variant="primary" onPress={() => void takeCopiedToken($).then(ok => (ok ? moveToCloud($) : undefined))} />
            <Button key="cloud-cancel" label="Cancel" plain dimColor onPress={() => void update($, cloudMoveA, () => null)} />
          </Box>
        </Box>
      ) : cloudMove?.stage === 'packing' || cloudMove?.stage === 'starting' ? (
        <Text key="cloud-moving" dimColor>
          {cloudMove.stage === 'packing' ? 'Packing the project…' : 'Starting the cloud host. The first time can take a minute or two…'}
        </Text>
      ) : cloudMove?.stage === 'failed' ? (
        <Box key="cloud-failed" flexDirection="column" gap={1}>
          <Text color="error">{cloudMove.note ?? "Couldn't move the session."}</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="cloud-retry" label="Try again" variant="secondary" onPress={() => void moveToCloud($)} />
            <Button key="cloud-dismiss" label="Cancel" plain dimColor onPress={() => void update($, cloudMoveA, () => null)} />
          </Box>
        </Box>
      ) : (
        <Box key="cloud-move" flexDirection="row" gap={1} alignItems="center">
          <Button key="cloud-move" label="Move to cloud" variant="secondary" onPress={() => void moveToCloud($)} />
          <Box flexShrink={1} minWidth={0}>
            <Text dimColor>Keeps the session running for everyone when this computer sleeps. You approve teammates' calls from wherever you are.</Text>
          </Box>
        </Box>
      )
    const refusedHere = isHost ? [] : await read($, previewNeedsOpenA)
    // Ports are a guest's concern only once the room forwards one: before
    // that, no Previews setting, and no browser is looked for.
    const forwardedShown = forwardedIn(shown)
    const forwards = !isHost && forwardedShown.length > 0
    // Whether a preview window could open here, for Settings to say.
    const windowing = forwards ? await windowChoice($, false) : null
    const previewOpen = isHost ? null : await previewOpenOf($)
    // Where a forwarded page opens, said under it: Always a separate window
    // says so whatever the look for a browser knows yet, and once it's known
    // that none can open here, why, and what Open does instead.
    const inWindow =
      previewOpen !== 'window'
        ? ''
        : windowing && !windowing.window
          ? ` in a preview window, which can't open here: ${windowing.reason}. Change Previews in Settings to open it without one.`
          : ' in a preview window'
    // Claude's browser is Desktop's: auto mode refused it, and nothing allows it yet.
    const desktop = await isDesktop($)
    const paneRefused = !isHost && desktop && (await read($, paneRefusedA))
    const live = v.connection === 'live'
    const online = people.filter(p => p.online).length
    // Who runs an older plugin than the newest known: said beside their name.
    const latest = await latestKnown($)
    const behind = (p: Face) => Boolean(p.version && latest && newerThan(latest, p.version))
    const pinRefused = e.surface === 'desktop' && (await read($, pinRefusedA))
    const turns = await read($, turnsA)
    const changes = await read($, changesA)
    const calls = await read($, callsA)
    const copied = await read($, copiedA)
    const prefs = await read($, prefsA)
    const me = await meIn($, room)
    const Client = clientOf(el)
    const saved = await read($, roomTabA)
    const tab: RoomTab = (saved === 'shown' && !shown.length) || (saved === 'changes' && !changes.length) ? 'people' : saved
    const pick = (id: RoomTab) => {
      void update($, roomTabA, () => id)
      if (id === 'chat') void update($, unreadA, () => 0)
    }
    const label = (text: string) => (
      <Text key={`label-${text}`} size="caption" weight="semibold" dimColor>
        {text}
      </Text>
    )

    // On top: Live and for how long, the session's name, who's here, the
    // link, and (for the host) the one main action, Invite.
    const stack = stackSvg(people, { size: 26, max: 7 })
    const header = (
      <Box flexDirection="column" gap="xs">
        <Box flexDirection="row" alignItems="center" gap={1}>
          {live && Svg ? <Svg key="room-live-dot" source={liveSvg()} alt="Live" width={12} height={12} /> : null}
          <Text size="caption" weight="semibold" color={live ? 'claude' : 'warning'}>
            {live ? (Svg ? 'Live' : '● Live') : '● Reconnecting'}
          </Text>
          <Text size="caption" dimColor tabular>
            {`· ${ago(room.since, now).replace(' ago', '')} · ${turns.length} turn${turns.length === 1 ? '' : 's'}`}
          </Text>
        </Box>
        <Text size="title" weight="semibold" wrap="truncate-end">
          {tidyTitle(room.title)}
        </Text>
        <Box flexDirection="row" gap={1} alignItems="center">
          {Svg ? <Svg key="room-faces" source={stack.source} alt={`With ${people.map(p => p.name).join(', ')}`} width={stack.width} height={26} /> : null}
          <Text size="footnote" dimColor wrap="truncate-end">
            {`${isHost ? `You're sharing${room.team ? ` with ${room.team.name}` : ''}` : `${room.host}'s session${room.team ? ` · ${room.team.name}` : ''}`} · ${online} of ${people.length} here`}
          </Text>
        </Box>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text size="footnote" mono dimColor wrap="truncate-middle">
              {room.url.replace(/^https?:\/\//, '')}
            </Text>
          </Box>
          <Box flexDirection="row" gap="xs" flexShrink={0}>
            <Button key="room-copy" label={copied ? 'Copied ✓' : 'Copy link'} plain onPress={press => void copyLink($, room.url, press.surface).then(() => flashCopied($))} />
            {isHost ? <Button key="room-invite" label="Invite" variant="primary" onPress={() => pick('people')} /> : null}
          </Box>
        </Box>
        {isHost ? null : (
          <Text size="footnote" dimColor>
            {rulesLine(v.policy, room.host)}
          </Text>
        )}
      </Box>
    )

    // While Claude works: for whom (their lane, in their color), what it's
    // doing, and for how long, ticking on its own.
    const w = v.working
    const nowBlock = w ? (
      <Box key="room-now" flexDirection="row" gap={1}>
        <Text color={colorOf(w.by)}>{'▎\n▎'}</Text>
        {w.waitingFor ? (
          <Text color="permission" wrap="truncate-end">
            {isHost ? `${waitingWho(w)} is waiting for your OK on ${w.waitingFor}` : `Waiting for ${room.host} to allow ${w.waitingFor}`}
          </Text>
        ) : Client ? (
          <Box flexGrow={1} minWidth={0}>
            <Client
              key="room-live"
              module="./live.tsx"
              flexGrow={1}
              props={{ variant: 'room', who: { name: w.by, color: colorOf(w.by) }, mine: w.by === me, doing: w.doing ? doingLine(w.doing) : '', elapsedMs: Math.max(0, now - w.startedAt), claude: 'claude', modern }}
            />
          </Box>
        ) : (
          <Text wrap="truncate-end">{`Claude is working for ${w.by}`}</Text>
        )}
      </Box>
    ) : null

    const tabs = tabsOf(
      el,
      [
        { id: 'people', label: 'People', count: online },
        { id: 'chat', label: 'Chat', count: v.unread || undefined, news: v.unread > 0 },
        { id: 'timeline', label: 'Timeline', count: turns.length || undefined },
        ...(changes.length ? [{ id: 'changes' as const, label: 'Changes', count: changes.length }] : []),
        ...(shown.length ? [{ id: 'shown' as const, label: 'Shown', count: shown.length }] : []),
        { id: 'settings', label: newer || pinRefused || paneRefused ? 'Settings ●' : 'Settings' },
      ],
      tab,
      pick,
    )

    // People: everyone here in their color, what each is doing; for the host,
    // teammates to invite straight into this session.
    const joinedAt = (name: string) => activity.find(a => a.kind === 'join' && a.who === name)?.ts
    const prompts = (name: string) => Math.max(activity.filter(a => a.kind === 'prompt' && a.who === name).length, turns.filter(t => t.who === name).length)
    const roles = (p: Face) => [p.note?.includes('host') ? 'host' : '', p.note?.includes('you') ? 'you' : ''].filter(Boolean).join(' · ')
    const personRow = (p: Face) => {
      const joined = joinedAt(p.name)
      const asked = prompts(p.name)
      const doing = p.active ? (
        <Text color={v.working?.waitingFor ? 'permission' : 'claude'}>{v.working?.waitingFor ? 'Waiting for an OK' : 'Claude is working'}</Text>
      ) : !p.online ? (
        <Text dimColor>away</Text>
      ) : behind(p) ? (
        <Text color="warning">{`on ${p.version}, needs an update`}</Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          {[joined && !p.note?.includes('host') ? `joined ${ago(joined, now)}` : '', asked ? `${asked} prompt${asked === 1 ? '' : 's'}` : '', v.everyone.some(person => person.name === p.name && trustsPerson(trusted, person)) ? 'always allowed' : '']
            .filter(Boolean)
            .join(' · ')}
        </Text>
      )
      const isYou = p.note?.includes('you')
      return (
        <Box key={`person-${p.name}`} flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0}>
            {faceOf(el, e.surface, p, 22)}
            <Text weight="semibold" color={p.online ? p.color : undefined} dimColor={!p.online} wrap="truncate-end" hover={{ scope: `person-${p.name}`, inverse: true }}>
              {` ${p.name} `}
            </Text>
            {roles(p) ? (
              <Text size="footnote" dimColor>
                {roles(p)}
              </Text>
            ) : null}
          </Box>
          <Box flexShrink={0}>{doing}</Box>
          {/* Hovered: who they are, over the rows above; and @ to mention them. */}
          <Box position="absolute" top={-4} left={4} display="none" hover={{ display: 'flex' }} flexDirection="column" borderStyle="round" borderColor={p.color} paddingX={1} backgroundColor="inverseText">
            <Box flexDirection="row" gap={1}>
              <Text weight="semibold" color={p.color}>
                {p.name}
              </Text>
              <Text size="caption" dimColor>
                {[roles(p), joined && !p.note?.includes('host') ? `joined ${ago(joined, now)}` : ''].filter(Boolean).join(' · ') || (p.online ? 'here' : 'away')}
              </Text>
            </Box>
            <Text size="footnote">{`${asked ? `${asked} prompt${asked === 1 ? '' : 's'}` : 'No prompts yet'}${v.working?.by === p.name ? ' · Claude is working for them' : ''}`}</Text>
            {p.version ? (
              <Text size="caption" dimColor mono>
                {`shared-session ${p.version}`}
              </Text>
            ) : null}
          </Box>
          {isYou ? null : (
            <Box position="absolute" right={0} display="none" hover={{ display: 'flex' }}>
              <Button key={`mention-${p.name}`} label={`@${p.name}`} plain onPress={() => void mention($, p.name)} />
            </Box>
          )}
        </Box>
      )
    }
    const teamsNow = isHost ? await read($, teamsA) : null
    const invited = isHost ? await read($, invitedA) : {}
    const mates = (teamsNow?.teammates ?? []).filter(m => !people.some(p => p.online && p.name === m.name))
    const shownTeam = teamsNow?.teams.find(x => x.id === teamsNow.current) ?? null
    const inviteBlock = !isHost ? null : !teamsNow?.account ? (
      <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
        <Text dimColor wrap="truncate-end">Sign in to invite teammates into this session.</Text>
        <Button key="room-invite-signin" label="Team" plain onPress={() => void openTeam($)} />
      </Box>
    ) : mates.length ? (
      <Box flexDirection="column" gap={1}>
        {headingOf(el, 'Invite teammates', 'it shows in their Claude Code')}
        {mates.slice(0, 8).map(m => (
          <Box key={`mate-${m.id}`} flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
            <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0}>
              {faceOf(el, e.surface, { name: m.name, online: false })}
              <Text wrap="truncate-end">{m.login && m.login !== m.name ? `${m.name} (${m.login})` : m.name}</Text>
            </Box>
            {/* Invited, and still not here: asked again, it shows in their Claude
                Code anew (and notifies them again), even if they'd set it aside. */}
            <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
              {invited[m.id] ? <Text color="success">{`Invited ${ago(invited[m.id] ?? now, now)}`}</Text> : null}
              <Button
                key={`invite-${m.id}`}
                label={invited[m.id] ? 'Invite again' : 'Invite'}
                plain
                dimColor={Boolean(invited[m.id])}
                onPress={() =>
                  void inviteToRoom($, [m.id])
                    .then(text => $.ui.toast(text))
                    .catch(error => $.ui.toast(`Couldn't invite: ${String(error?.message ?? error)}`))
                }
              />
            </Box>
          </Box>
        ))}
        {mates.length > 8 ? <Text dimColor>{`And ${mates.length - 8} more: /invite <name>`}</Text> : null}
      </Box>
    ) : (
      <Box flexDirection="column" gap={1}>
        {headingOf(el, 'Invite teammates')}
        <Text dimColor>{shownTeam ? `Nobody else is in ${shownTeam.name} yet. Send them its invite link; once they're in, invite them here.` : 'Make a team first, then invite teammates straight into this session.'}</Text>
        <Box flexDirection="row" gap={1}>
          {shownTeam && teamsNow ? <Button key="room-team-invite" label="Copy team invite link" plain onPress={press => void copyText($, inviteUrl(teamsNow, shownTeam), 'Team invite link copied', press.surface)} /> : null}
          <Button key="room-open-team" label="Team" plain dimColor onPress={() => void openTeam($)} />
        </Box>
      </Box>
    )
    const longest = turns.reduce((m, t) => Math.max(m, t.ms ?? 0), 0)
    const stats: [string, string][] = [
      ['Turns', String(turns.length)],
      ['Tool calls', String(calls)],
      ['Files changed', changes.length ? `${changes.length} · +${changes.reduce((n, c) => n + c.added, 0)} −${changes.reduce((n, c) => n + c.removed, 0)}` : '0'],
      ...(longest ? [['Longest turn', took(longest)] as [string, string]] : []),
    ]
    const peoplePage = (
      <Box flexDirection="column" gap="lg">
        <Box flexDirection="column" gap="sm">
          {people.map(personRow)}
          {isHost && people.length <= 1 ? <Text dimColor>No one yet. Send the link to a teammate; it opens in their Claude Code.</Text> : null}
        </Box>
        {inviteBlock}
        <Box key="room-stats" flexDirection="column" gap="xs">
          {label('This session')}
          {stats.map(([k, value]) => (
            <Box key={`stat-${k}`} flexDirection="row" justifyContent="space-between">
              <Text size="footnote" dimColor>
                {k}
              </Text>
              <Text size="footnote" weight="medium" tabular>
                {value}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    )

    // Timeline: every turn as a bar in the color of who asked, then the
    // newest turns as words.
    const strip = turns.slice(-60)
    const timelinePage = (
      <Box flexDirection="column" gap="md">
        {turns.length && Client ? (
          <Client
            key="timeline"
            module="./timeline.tsx"
            props={{ turns: strip.map(t => ({ who: t.who, color: colorOf(t.who), prompt: t.prompt.slice(0, 200), seconds: t.ms === undefined ? null : Math.round(t.ms / 1000) })), claude: 'claude', modern }}
          />
        ) : null}
        <Text size="footnote" dimColor>
          {turns.length ? 'Hover a bar to read it; click it to go to that prompt, then ←/→ to walk.' : 'No turns yet. Every prompt shows here, in the color of whoever asked.'}
        </Text>
        <Box flexDirection="column" gap="xs">
          {turns
            .slice(-12)
            .reverse()
            .map(t => (
              <Box key={`turn-${t.id}`} flexDirection="row" gap={1} justifyContent="space-between">
                <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
                  <Text color={colorOf(t.who)}>▎</Text>
                  <Text size="footnote" wrap="truncate-end">
                    <Text weight="semibold" color={colorOf(t.who)}>
                      {t.who}
                    </Text>
                    <Text dimColor>{` ${t.prompt}`}</Text>
                  </Text>
                </Box>
                <Text size="caption" dimColor tabular>
                  {t.ms === undefined ? 'running' : took(t.ms)}
                </Text>
              </Box>
            ))}
        </Box>
      </Box>
    )

    // Changes: every file Claude changed, in the color of who asked for it,
    // and the one opened as a diff in the engine's own highlighter.
    const openPath = (await read($, changeOpenA)) ?? changes.at(-1)?.path
    const opened = changes.find(c => c.path === openPath) ?? changes.at(-1)
    const { Code } = el
    const changesPage = (
      <Box flexDirection="column" gap="md">
        <Box flexDirection="row" justifyContent="space-between">
          {label(`${changes.length} file${changes.length === 1 ? '' : 's'} changed`)}
          <Text size="caption" tabular>
            <Text color="success">{`+${changes.reduce((n, c) => n + c.added, 0)}`}</Text>
            <Text>{' '}</Text>
            <Text color="error">{`−${changes.reduce((n, c) => n + c.removed, 0)}`}</Text>
          </Text>
        </Box>
        <Box flexDirection="column" gap="xs">
          {[...changes].reverse().map(c => (
            <Box key={`change-${c.path}`} flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
              <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
                <Text color={colorOf(c.who)}>▎</Text>
                <Button key={`open-change-${c.path}`} label={c.path} plain dimColor={c.path !== opened?.path} onPress={() => void update($, changeOpenA, () => c.path)} />
              </Box>
              <Text size="caption" tabular>
                <Text color="success">{`+${c.added}`}</Text>
                <Text>{' '}</Text>
                <Text color="error">{`−${c.removed}`}</Text>
              </Text>
            </Box>
          ))}
        </Box>
        {opened ? (
          <Box flexDirection="column" gap="xs">
            <Box flexDirection="row" gap={1}>
              <Text size="footnote" mono weight="medium" wrap="truncate-middle">
                {opened.path}
              </Text>
              <Text size="footnote" dimColor>
                for
              </Text>
              <Text size="footnote" weight="semibold" color={colorOf(opened.who)} hover={{ scope: `person-${opened.who}`, inverse: true }}>
                {` ${opened.who} `}
              </Text>
            </Box>
            <Code key={`diff-${opened.path}`} source={opened.patch} path={opened.path} format="diff" />
          </Box>
        ) : null}
      </Box>
    )

    // Chat: what people say and what happened, one timeline, oldest first.
    type Line = { ts: number; chat?: ShareChat; event?: ShareActivity }
    const lines: Line[] = [...chat.map(c => ({ ts: c.ts, chat: c })), ...activity.map(a => ({ ts: a.ts, event: a }))].sort((x, y) => x.ts - y.ts).slice(-30)
    const eventRow = (a: ShareActivity, i: number) => {
      const said = describe(a)
      const rest = said.startsWith(a.who) ? said.slice(a.who.length) : ` ${said}`
      const mark = a.kind === 'allowed' ? '✓' : a.kind === 'denied' ? '✕' : a.kind === 'leave' ? '←' : a.kind === 'join' ? '→' : a.kind === 'prompt' ? '❯' : '·'
      return (
        <Box key={`act-${a.ts}-${i}`} flexDirection="row" gap={1} justifyContent="space-between">
          <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
            <Text color={a.kind === 'allowed' ? 'success' : a.kind === 'denied' ? 'error' : undefined} dimColor={a.kind !== 'allowed' && a.kind !== 'denied'}>
              {mark}
            </Text>
            <Text wrap="truncate-end">
              <Text bold color={colorOf(a.who)}>
                {a.who}
              </Text>
              <Text dimColor>{rest}</Text>
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor>{ago(a.ts, now)}</Text>
          </Box>
        </Box>
      )
    }
    const chatRow = (c: ShareChat, i: number) => (
      <Box key={`chat-${c.ts}-${i}`} flexDirection="column">
        <Box flexDirection="row" gap={1} justifyContent="space-between">
          <Text bold color={colorOf(c.who)}>
            {c.seat === v.me ? 'You' : c.who}
          </Text>
          <Text dimColor>{ago(c.ts, now)}</Text>
        </Box>
        <Text>{c.text}</Text>
      </Box>
    )
    const chatPage = (
      <Box flexDirection="column" gap={1}>
        {lines.length ? lines.map((l, i) => (l.chat ? chatRow(l.chat, i) : l.event ? eventRow(l.event, i) : null)) : <Text dimColor>Nothing yet. Say hi: everyone here sees it, and Claude doesn't.</Text>}
        {Input ? (
          <Input key={`chat-input-${chat.length}`} placeholder="Message everyone (Claude doesn't read this)" submitLabel="Send" onSubmit={(value: string) => void postChat($, value)} />
        ) : (
          <Text dimColor>Chat from Claude Code on desktop or in a terminal.</Text>
        )}
      </Box>
    )

    // Shown: what Claude showed, newest first.
    const shownPage = (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>{isHost ? 'What Claude showed everyone' : `What ${room.host}'s Claude showed`}</Text>
        {shownDrawn(shown)
          .reverse()
          .map(item => {
            const local = localPreviews.find(p => p.pid === item.pid)
            const run = item.pid ? scope.children.listeners.get(item.pid) : undefined
            const active = run?.started && !run.failed && !run.stopping
            // The mapping is live only on its own listener: the window's tunnel
            // for the page (on a port of its own) is no mapping here.
            const mapped = Boolean(active && run?.owner === 'listener' && run.localPort === local?.localPort)
            // A guest's open preview, and whether the room forwards it (Shown's own say, kept through a later page).
            const guestPreview = !isHost && item.kind === 'preview' && item.pid && !item.closed
            const forwarded = guestPreview && item.tcp
            // What a page uses beside it opens with that page, never on its
            // own: while that page is here (any forwarded page, for one used
            // by every page), it has no Open or Public link. Left alone (its
            // page stopped, or never forwarded), its Open is the way to it.
            const usedBy = forwarded && item.dependency !== undefined && pagesOf(forwardedShown, item).length > 0
            return (
              <Box key={`shown-${item.key}`} flexDirection="column" gap={1}>
                <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
                  <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
                    <Text color={item.closed ? undefined : 'claude'} dimColor={item.closed}>{shownGlyph(item)}</Text>
                    <Text wrap="truncate-end" dimColor={item.closed}>{`${item.name}${item.closed ? ' · ended' : ''}`}</Text>
                  </Box>
                  <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
                    <Text dimColor>{ago(item.ts, now)}</Text>
                    {!isHost && !item.closed && !usedBy && item.kind !== 'widget' && item.kind !== 'link' ? <Button key={`open-${item.key}`} label="Open" plain onPress={press => void openShown($, item, press.surface)} /> : null}
                    {forwarded && !usedBy ? <Button key={`public-${item.key}`} label="Public link" plain onPress={press => void openPublicPreview($, item, press.surface)} /> : null}
                    {isHost && item.kind === 'preview' && item.pid && !item.closed && !item.tcp ? <Button key={`forward-${item.key}`} label="Allow forwarding" plain dimColor onPress={() => void allowForwarding($, item)} /> : null}
                    {isHost && item.kind === 'preview' && item.pid && !item.closed ? <Button key={`stop-${item.key}`} label="Stop" plain onPress={() => void stopPreview($, item.pid as string)} /> : null}
                  </Box>
                </Box>
                {forwarded && item.dependency === undefined && validPort(item.port) && !local?.localPort ? <Text key={`address-${item.key}`} dimColor>{`Opens ${previewUrl(item.host, item.port, item.path, item.scheme)}${inWindow}`}</Text> : null}
                {item.kind === 'preview' && !item.closed && item.tcp && item.dependency !== undefined && validPort(item.port) ? (
                  <Text key={`dependency-${item.key}`} dimColor>
                    {`${isHost ? 'Shared' : 'Used'} ${dependencyFor(item.dependency)}`}
                  </Text>
                ) : null}
                {forwarded && refusedHere.includes(item.pid!) ? <Text key={`refused-${item.key}`} color="warning">{`${room.host}'s side refused the preview window's connection. Press Open to reconnect.`}</Text> : null}
                {forwarded && local?.localPort ? (
                  <Box key={`mapping-${item.key}`} flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
                    <Box flexDirection="row" flexShrink={1} minWidth={0}>
                      <Text dimColor wrap="truncate-end">{`${mapped ? '' : 'Last: '}localhost:${local.localPort} here → ${room.host}'s localhost:${item.port}`}</Text>
                    </Box>
                    <Box flexDirection="row" flexShrink={0}>
                      <Button key={`close-${item.key}`} label="Close" plain onPress={() => void closeLocalPreview($, item.pid as string)} />
                    </Box>
                  </Box>
                ) : null}
                {forwarded && active && run?.channelError ? <Text key={`connection-${item.key}`} color="warning">{run.channelError}</Text> : null}
              </Box>
            )
          })}
      </Box>
    )

    // Settings: who may do what (the host's, for everyone), this session's own,
    // updates, and the one button that ends it.
    const updatesSetting = Select
      ? settingOf(
          el,
          'Updates',
          <Select
            key="updates"
            value={updates ? 'auto' : 'manual'}
            options={[
              { value: 'auto', label: 'Install by themselves' },
              { value: 'manual', label: 'Only when I update' },
            ]}
            onSelect={(value: string) => void writeUpdates($, value === 'auto')}
          />,
        )
      : null
    const liveUpdates = await read($, liveUpdatesA)
    const switchTo = liveUpdates === 'pinned' ? await switchCommand($) : ''
    const updatesNote = switchTo ? null : updates && liveUpdates === 'running' ? 'This session updates itself: a release loads in place.' : updates && liveUpdates === 'next' ? 'From your next new session on, a release loads in place, no restart.' : null
    const versionRow = await updateRow($, el, false)
    const settingsPage = (
      <Box flexDirection="column" gap={2}>
        {versionRow}
        {pinRefused ? (
          <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
            <Box flexShrink={1} minWidth={0}>
              <Text dimColor>Auto mode won't let shared sessions pin themselves in the sidebar.</Text>
            </Box>
            <Button key="allow-pin" label="Allow pinning" plain onPress={() => void allowDeskTools($)} />
          </Box>
        ) : null}
        {isHost || cloudSettings ? (
          <Box flexDirection="column" gap={1}>
            {headingOf(el, 'Everyone here', cloudSettings ? 'at the cloud host' : '')}
            {Select
              ? settingOf(
                  el,
                  'Teammates can',
                  <Select
                    key="policy-prompts"
                    value={v.policy.prompts}
                    options={[
                      { value: 'everyone', label: 'Prompt Claude' },
                      { value: 'watch', label: 'Only watch and chat' },
                    ]}
                    onSelect={(value: string) => void setPolicyHere($, { prompts: value === 'watch' ? 'watch' : 'everyone' })}
                  />,
                )
              : null}
            {Select
              ? settingOf(
                  el,
                  'Ask me before',
                  <Select
                    key="policy-approvals"
                    // A cloud host asks about every call when told nothing: it holds your Claude sign-in.
                    value={cloudSettings && v.policy.approvals === 'none' ? 'all' : v.policy.approvals}
                    options={[
                      { value: 'edits', label: 'Anything but reading this project' },
                      { value: 'all', label: 'Every tool, reads too' },
                      ...(cloudSettings ? [] : [{ value: 'none', label: 'Nothing' }]),
                    ]}
                    onSelect={(value: string) => void setPolicyHere($, { approvals: value === 'all' || value === 'none' ? value : 'edits' })}
                  />,
                )
              : null}
            {Select
              ? settingOf(
                  el,
                  'What Claude shows',
                  <Select
                    key="policy-files"
                    value={v.policy.files ?? 'on'}
                    options={[
                      { value: 'on', label: 'Goes to everyone' },
                      { value: 'off', label: cloudSettings ? 'Stays in the cloud host' : 'Stays with me' },
                    ]}
                    onSelect={(value: string) => void setPolicyHere($, { files: value === 'off' ? 'off' : 'on' })}
                  />,
                )
              : null}
            {(cloudSettings ? cloudTrusted : trusted).length ? (
              <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
                <Text dimColor wrap="truncate-end">{`Always allowed: ${listNames(cloudSettings ? cloudTrusted : [...new Set(trusted.map(t => t.who))])}`}</Text>
                <Button key="untrust" label="Ask again" plain onPress={() => void (cloudSettings ? setCloudPolicy($, { untrust: true }) : update($, trustedA, () => []))} />
              </Box>
            ) : null}
          </Box>
        ) : null}
        <Box flexDirection="column" gap={1}>
          {headingOf(el, 'Just you', '')}
          {!isHost && Select
            ? settingOf(
                el,
                `${room.host}'s Claude shows`,
                <Select
                  key="auto-open"
                  value={(await read($, autoOpenA)) ? 'auto' : 'ask'}
                  options={[
                    { value: 'auto', label: 'Open it here' },
                    { value: 'ask', label: 'Ask me first' },
                  ]}
                  onSelect={(value: string) => void update($, autoOpenA, () => value !== 'ask')}
                />,
              )
            : null}
          {!isHost && forwards && previewOpen && Select
            ? settingOf(
                el,
                'Previews',
                <Select
                  key="preview-open"
                  value={previewOpen}
                  options={[
                    ...(desktop ? [{ value: 'pane', label: "Claude's browser, or a separate window when ports are taken" }] : []),
                    { value: 'browser', label: 'Your browser, or a separate window when ports are taken' },
                    { value: 'window', label: 'Always a separate window' },
                  ]}
                  onSelect={(value: string) => void setPreviewOpen($, value)}
                />,
              )
            : null}
          {!isHost && forwards && windowing && !windowing.window ? <Text dimColor>{`A separate window can't open here: ${windowing.reason}.`}</Text> : null}
          {paneRefused ? (
            <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
              <Box flexShrink={1} minWidth={0}>
                <Text dimColor>Auto mode doesn't let the plugin open previews in Claude's browser, so they open in your browser. Allowing it adds a rule to your settings that also lets your own Claude open pages in Claude's browser without auto mode's review.</Text>
              </Box>
              <Box flexShrink={0}>
                <Button key="allow-pane" label="Allow previews in Claude" plain onPress={() => void allowPane($)} />
              </Box>
            </Box>
          ) : null}
          {!isHost && Select && e.surface === 'terminal'
            ? settingOf(
                el,
                'Tool calls',
                <Select
                  key="tool-rows"
                  value={await read($, toolRowsA)}
                  options={[
                    { value: 'grouped', label: 'Grouped, as the terminal folds its own' },
                    { value: 'each', label: 'Each shown, with its result' },
                  ]}
                  onSelect={(value: string) => void update($, toolRowsA, () => (value === 'each' ? 'each' : 'grouped'))}
                />,
              )
            : null}
          {!isHost && Select
            ? settingOf(
                el,
                'Messages from my other sessions',
                <Select
                  key="pref-relay"
                  value={prefs.relayPeers ? 'relay' : 'keep'}
                  options={[
                    { value: 'relay', label: `Go to ${room.host}’s Claude` },
                    { value: 'keep', label: 'Stay here' },
                  ]}
                  onSelect={(value: string) => void setPrefs($, { relayPeers: value !== 'keep' })}
                />,
              )
            : null}
          {Select
            ? settingOf(
                el,
                'Sounds',
                <Select
                  key="pref-sounds"
                  value={prefs.sounds}
                  options={[
                    { value: 'mentions', label: 'Mentions and my turns' },
                    { value: 'all', label: 'Those and joins' },
                    { value: 'off', label: 'None' },
                  ]}
                  onSelect={(value: string) => void setPrefs($, { sounds: value === 'all' || value === 'off' ? value : 'mentions' })}
                />,
              )
            : null}
          {Select
            ? settingOf(
                el,
                'Said out loud',
                <Select
                  key="pref-voice"
                  value={prefs.voice ? 'on' : 'off'}
                  options={[
                    { value: 'off', label: 'Nothing' },
                    { value: 'on', label: 'Joins and mentions' },
                  ]}
                  onSelect={(value: string) => void setPrefs($, { voice: value === 'on' })}
                />,
              )
            : null}
          {Select
            ? settingOf(
                el,
                'Status line',
                <Select
                  key="pref-status"
                  value={prefs.statusLine ? 'on' : 'off'}
                  options={[
                    { value: 'off', label: 'Off' },
                    { value: 'on', label: 'Who’s here' },
                  ]}
                  onSelect={(value: string) => void setPrefs($, { statusLine: value === 'on' })}
                />,
              )
            : null}
          {updatesSetting}
          {switchTo ? (
            <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
              <Box flexShrink={1} minWidth={0}>
                <Text dimColor>Claude Desktop runs the copy installed from your local marketplace folder, so a release loads only when you quit and reopen it. Add the marketplace from GitHub to update in place.</Text>
              </Box>
              <Button key="copy-switch" label="Copy command" plain onPress={press => void copyText($, switchTo, 'Command copied: run it in a terminal, then quit and reopen Claude', press.surface)} />
            </Box>
          ) : updatesNote ? (
            <Text dimColor>{updatesNote}</Text>
          ) : null}
        </Box>
        {cloudMoveBlock}
        {isHost ? (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button key="room-stop" label={v.confirming === 'stop' ? 'Stop for everyone' : 'Stop sharing'} variant={v.confirming === 'stop' ? 'primary' : 'secondary'} onPress={() => void confirmStop($)} />
            {v.confirming === 'stop' ? <Text color="error">Press again to end the room. The link stops working.</Text> : null}
          </Box>
        ) : (
          <Box flexDirection="row">
            <Button key="room-leave" label={`Leave ${room.host}'s session`} variant="secondary" onPress={() => void closeRoom($, 'leave')} />
          </Box>
        )}
      </Box>
    )

    return fit(
      <Box flexDirection="column" gap="lg">
        {header}
        {cloudBlock}
        {approvalBlock ?? nowBlock}
        {tabs}
        {tab === 'chat' ? chatPage : tab === 'timeline' ? timelinePage : tab === 'changes' ? changesPage : tab === 'shown' ? shownPage : tab === 'settings' ? settingsPage : peoplePage}
      </Box>,
      modern,
    )
  })

  // The row above the prompt: one row, whatever is going on. An invite, the
  // share question and a teammate waiting for the host's OK each take the row
  // over while they last; nothing stacks under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
    const Svg = svgOf(el, e.surface)
    const v = await view($)
    // Every row fitted to the engine (fit.ts): the live mark's weight is 2.1.299's.
    const row = (left: RenderChildren, right: RenderChildren) =>
      fit(
        <Box flexDirection="row" gap={2} alignItems="center" justifyContent="space-between" paddingRight={e.surface === 'terminal' ? 4 : 0}>
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0}>
            {left}
          </Box>
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
            {right}
          </Box>
        </Box>,
        modern,
      )

    if (v.mode === 'idle') {
      const teamName = await shareTeamName($)
      if (v.asking) return shareChoice($, el, v.asking.prompts, 'band', e.surface, teamName)
      // A teammate's invite: who (in their color), then what, cut to fit
      // beside Join.
      const invites = await read($, invitesA)
      const invite = invites[0]
      if (invite) {
        const color = colorFor(invite.from.name)
        return row(
          [
            faceOf(el, e.surface, { name: invite.from.name, online: true, color }),
            <Box key="what" flexDirection="column" flexShrink={1} minWidth={0}>
              <Text wrap="truncate-end">
                <Text bold color={color}>
                  {invite.from.name}
                </Text>
                <Text bold>{' invites you'}</Text>
              </Text>
              <Text dimColor wrap="truncate-end">
                {`${tidyTitle(invite.room.title)}${invites.length > 1 ? ` · ${invites.length - 1} more in Team` : ''}`}
              </Text>
            </Box>,
          ],
          [
            // No Join while this session's own room is being taken back (its first 10 s).
            takingBackNow() ? null : <Button key="invite-join" label="Join" variant="primary" onPress={press => void joinInvited($, invite, press.surface).catch(error => $.ui.toast(`Couldn't join: ${String(error?.message ?? error)}`))} />,
            <Button key="invite-dismiss" label="Dismiss" plain dimColor onPress={() => void dropInvite($, invite.room.id)} />,
          ],
        )
      }
      // Quiet when nothing's shared: Share, and Team with how many teammates
      // are live now in Claude's orange. No Share while a room is being left,
      // or this session's own is being taken back (its first 10 s).
      const t = await read($, teamsA)
      const me = t.account?.id
      const live = me ? t.sessions.filter(s => s.hostOnline && s.hostAccount !== me && !t.here?.[s.id] && !s.accounts?.includes(me)).length : 0
      const leaving = takingBackNow() || (await closingNow($))
      return (
        <Box flexDirection="row" justifyContent="flex-end" gap={1} paddingRight={e.surface === 'terminal' ? 4 : 0}>
          <Button key="team" label={live ? `Team · ${live} live` : 'Team'} plain dimColor={!live} onPress={() => void openTeam($)}>
            {live
              ? [
                  <Text key="name">Team </Text>,
                  <Text key="count" bold color="claude">{`● ${live} live`}</Text>,
                ]
              : null}
          </Button>
          {leaving ? null : (
            <Button
              key="share"
              label={teamName ? `Share with ${teamName.length > 24 ? `${teamName.slice(0, 23)}…` : teamName}` : 'Share'}
              plain
              onPress={press => {
                void requestShare($, press.surface).catch(error => {
                  $.ui.toast("Couldn't share")
                  $.ui.log(`Couldn't share: ${String(error?.message ?? error)}`)
                })
              }}
            />
          )}
        </Box>
      )
    }

    const colors = roomColors(v.everyone, (await read($, chatA)).map(c => c.who))
    const people = faces(v, colors)
    const isHost = v.mode === 'host'
    const live = v.connection === 'live'
    const stopping = v.confirming === 'stop'
    const approving = await read($, approvingA)
    // Live: Claude's orange dot, its ring widening; Reconnecting in the warning color.
    const liveMark = (
      <Box key="live" flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
        {live && Svg ? <Svg source={liveSvg()} alt="Live" width={12} height={12} /> : null}
        <Text weight="semibold" color={live ? 'claude' : 'warning'}>
          {live ? (Svg ? 'Live' : '● Live') : '● Reconnecting'}
        </Text>
      </Box>
    )

    // A teammate waiting for the host's OK takes the row until it's answered:
    // the oldest of the calls waiting, and how many more wait after it. What
    // its one line leaves out (a command's next lines, an edit's size) is a
    // press away, the whole call in the Room.
    if (isHost && approving) {
      const color = colors.get(approving.who) ?? colorFor(approving.who)
      return row(
        [
          faceOf(el, e.surface, { name: approving.who, online: true, color, active: true }),
          <Text key="what" wrap="truncate-end">
            <Text bold color={color}>
              {approving.who}
            </Text>
            <Text>{' wants Claude to run '}</Text>
            <Text bold>{approving.what}</Text>
            {approving.more ? <Text dimColor>{` · ${approving.more} more waiting`}</Text> : null}
          </Text>,
        ],
        [
          ...(approving.extent ? [<Button key="approve-whole" label={approving.extent} plain dimColor onPress={() => void openRoom($)} />] : []),
          <Button key="approve-once" label="Allow once" variant="primary" onPress={() => answerBandAsk(approving.id, 'Allow once')} />,
          <Button key="approve-always" label={approving.always} plain onPress={() => answerBandAsk(approving.id, approving.always)} />,
          <Button key="approve-no" label="Decline" plain dimColor onPress={() => answerBandAsk(approving.id, 'Decline')} />,
        ],
      )
    }

    // The cloud host's approver: its oldest question takes the row, as a
    // teammate's call takes the host's.
    const cloudAsks = isHost ? [] : await read($, cloudAsksA)
    const cloudAsk = cloudAsks[0]
    // One about its localhost: the host's own row's question, of the cloud host's.
    if (cloudAsk?.kind) {
      const who = cloudAsk.kind === 'need' ? cloudAsk.who : ''
      const yes = cloudAsk.options[0] ?? 'Share'
      return row(
        [
          liveMark,
          <Text key="what" wrap="truncate-end">
            {who && cloudAsk.what.startsWith(who) ? (
              [
                <Text key="who" bold color={colors.get(who) ?? colorFor(who)}>
                  {who}
                </Text>,
                <Text key="rest">{cloudAsk.what.slice(who.length)}</Text>,
              ]
            ) : (
              <Text key="words">{cloudAsk.what}</Text>
            )}
            {cloudAsks.length > 1 ? <Text dimColor>{` · ${cloudAsks.length - 1} more waiting`}</Text> : null}
          </Text>,
        ],
        [
          <Button key="cloud-yes" label={yes} variant="primary" onPress={() => void answerCloudAsk($, cloudAsk.id, yes)} />,
          <Button key="cloud-not-now" label="Not now" plain dimColor onPress={() => void answerCloudAsk($, cloudAsk.id, 'Not now')} />,
        ],
      )
    }
    if (cloudAsk) {
      const color = colors.get(cloudAsk.who) ?? colorFor(cloudAsk.who)
      return row(
        [
          faceOf(el, e.surface, { name: cloudAsk.who, online: true, color, active: true }),
          <Text key="what" wrap="truncate-end">
            <Text bold color={color}>
              {cloudAsk.who}
            </Text>
            <Text>{' wants the cloud host to run '}</Text>
            <Text bold>{cloudAsk.what}</Text>
            {cloudAsks.length > 1 ? <Text dimColor>{` · ${cloudAsks.length - 1} more waiting`}</Text> : null}
          </Text>,
        ],
        [
          ...(cloudAsk.extent ? [<Button key="cloud-whole" label={cloudAsk.extent} plain dimColor onPress={() => void openRoom($)} />] : []),
          <Button key="cloud-once" label="Allow once" variant="primary" onPress={() => void answerCloudAsk($, cloudAsk.id, 'Allow once')} />,
          ...(cloudAsk.always ? [<Button key="cloud-always" label={cloudAsk.always} plain onPress={() => void answerCloudAsk($, cloudAsk.id, cloudAsk.always)} />] : []),
          <Button key="cloud-no" label="Decline" plain dimColor onPress={() => void answerCloudAsk($, cloudAsk.id, 'Decline')} />,
        ],
      )
    }

    // A question about what else to share (what a preview uses, a guest's
    // window asking): below a teammate's approval, the row while it lasts.
    const hostAsk = isHost && !stopping ? await read($, hostAskA) : null
    if (hostAsk) {
      const who = hostAsk.kind === 'need' ? hostAsk.who ?? 'A guest' : ''
      const color = who ? colors.get(who) ?? colorFor(who) : undefined
      const words = hostAskWords(hostAsk)
      return row(
        [
          // A terminal says Reconnecting here by its dot alone: the words
          // keep at least the 41 columns of an 80-column row (`ASK_PORTS`),
          // so no port a yes forwards is cut.
          e.surface === 'terminal' && !live ? <Text key="live" bold color="warning">●</Text> : liveMark,
          <Text key="what" wrap="truncate-end">
            {who && words.startsWith(who) ? (
              [
                <Text key="who" bold color={color}>
                  {who}
                </Text>,
                <Text key="rest">{words.slice(who.length)}</Text>,
              ]
            ) : (
              words
            )}
          </Text>,
        ],
        [
          <Button key="host-ask-yes" label={hostAskYes(hostAsk)} variant="primary" onPress={() => answerHostAsk(hostAsk.id, 'yes')} />,
          <Button key="host-ask-no" label="Not now" plain dimColor onPress={() => answerHostAsk(hostAsk.id, 'no')} />,
        ],
      )
    }
    // A guest's forwarded preview not open here yet: one press opens it.
    const openable = !isHost && !stopping ? await bandEntry($) : null
    if (openable) void windowChoice($, false).catch(() => {})

    const stack = stackSvg(people, { size: 24, max: 5 })
    const roomLabel = v.unread ? `Room · ${v.unread} new` : `Room · ${people.filter(p => p.online).length}`
    // While Claude works (and nothing waits on an OK): for whom, for how
    // long, what it's doing, moving on the surface's own clock.
    const Client = clientOf(el)
    const w = v.working
    const ticking =
      w && !w.waitingFor && Client && (v.mode === 'guest' || w.byGuest) ? (
        <Box key="now" flexGrow={1} flexShrink={1} minWidth={0}>
          <Client
            key="band-live"
            module="./live.tsx"
            flexGrow={1}
            props={{ variant: 'band', who: { name: w.by, color: colors.get(w.by) ?? colorFor(w.by) }, mine: v.mode === 'guest' && w.by === (await meIn($, v.room!)), doing: w.doing ? doingLine(w.doing) : '', elapsedMs: Math.max(0, (await $.clock.now()) - w.startedAt), claude: 'claude', modern }}
          />
        </Box>
      ) : null
    const pin = !stopping && e.surface === 'desktop' && (await read($, pinRefusedA))
    const signedIn = isHost && Boolean((await read($, teamsA)).account)
    // An invite to another session waits here too (every session may be in a
    // room): a button in the row, in place of the two it can spare.
    const invites = stopping ? [] : await read($, invitesA)
    const invite = invites[0]
    return fit(row(
      [
        liveMark,
        Svg ? (
          <Svg key="faces" source={stack.source} alt={`With ${people.map(p => p.name).join(', ')}`} width={stack.width} height={24} />
        ) : (
          // A terminal: a dot per person, in their colors.
          <Text key="faces">
            {people.slice(0, 8).map(p => (
              <Text key={p.name} color={p.color}>
                {p.online ? '●' : '○'}
              </Text>
            ))}
          </Text>
        ),
        <Text key="what" bold wrap="truncate-end">
          {isHost ? (v.room?.team ? `Sharing with ${v.room.team.name}` : 'Sharing') : `${v.room?.host}'s session`}
        </Text>,
        stopping ? (
          <Text key="now" color="error" wrap="truncate-end">
            Press again to end the room for everyone
          </Text>
        ) : (
          (ticking ?? nowOf(el, v, colors))
        ),
      ],
      [
        invite ? (
          <Button key="invite-open" label={`${invite.from.name} invites you${invites.length > 1 ? ` · ${invites.length}` : ''}`} plain onPress={() => void openTeam($, 'live')}>
            {[
              <Text key="who" bold color={colorFor(invite.from.name)}>
                {invite.from.name}
              </Text>,
              <Text key="what" color="claude">{` invites you${invites.length > 1 ? ` · ${invites.length}` : ''}`}</Text>,
            ]}
          </Button>
        ) : null,
        pin ? <Button key="band-allow-pin" label="Pin" plain onPress={() => void allowDeskTools($)} /> : null,
        openable ? <Button key="open-preview" label="Open preview" plain onPress={press => void openShown($, openable, press.surface)} /> : null,
        signedIn && !stopping && !invite ? <Button key="invite" label="Invite" plain onPress={() => void openRoom($, 'people')} /> : null,
        isHost && !stopping && !invite ? <Button key="copy" label="Copy link" plain dimColor onPress={press => void (v.room ? copyLink($, v.room.url, press.surface) : undefined)} /> : null,
        <Button key="room" label={roomLabel} plain dimColor={!v.unread} onPress={() => void openRoom($)}>
          {v.unread
            ? [
                <Text key="name">Room </Text>,
                <Text key="count" bold color="claude">{`● ${v.unread} new`}</Text>,
              ]
            : null}
        </Button>,
        isHost ? (
          stopping ? (
            <Button key="stop-sharing" label="Stop for everyone?" variant="primary" onPress={() => void confirmStop($)} />
          ) : (
            <Button key="stop-sharing" label="Stop sharing" plain dimColor onPress={() => void confirmStop($)} />
          )
        ) : (
          <Button key="leave" label="Leave" plain dimColor onPress={() => void closeRoom($, 'leave')} />
        ),
      ],
    ), modern)
  })
}

// A reaction of this person's to a reply, on or off: here at once, and to
// the room, which tells everyone (and this session again, which changes nothing).
async function react($: $, key: string, emoji: string, on: boolean) {
  const room = await read($, roomA)
  if (!room) return
  const me = await meIn($, room)
  await update($, reactionsA, all => {
    const now = all[key]?.[emoji] ?? []
    return { ...all, [key]: { ...all[key], [emoji]: on ? [...new Set([...now, me])] : now.filter(n => n !== me) } }
  })
  send($, 'react', { key, emoji, on })
}

// The room as a card: live and for how long, its name, everyone in their
// color with what they're doing, and the Room a press away.
function whoCard(el: UI, surface: RenderSurface, v: View, turns: ShareTurn[], now: number, open: () => void) {
  const { Box, Text, Button } = el
  const Svg = svgOf(el, surface)
  const room = v.room!
  const colors = roomColors(v.everyone)
  const people = faces(v, colors)
  const here = people.filter(p => p.online)
  const stack = stackSvg(here, { size: 24, max: 7 })
  const asked = (name: string) => turns.filter(t => t.who === name).length
  const doing = (p: Face) =>
    v.working?.by === p.name ? 'Claude is working for them' : !p.online ? 'away' : [p.note?.includes('host') ? 'hosting' : 'here', asked(p.name) ? `${asked(p.name)} prompt${asked(p.name) === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
  return (
    <Box flexDirection="column" gap="sm" borderStyle="round" borderDimColor paddingX={1}>
      <Box flexDirection="row" alignItems="center" gap={1}>
        {Svg ? <Svg source={liveSvg()} alt="Live" width={12} height={12} /> : null}
        <Text size="caption" weight="semibold" color="claude">
          {Svg ? 'Live' : '● Live'}
        </Text>
        <Text size="caption" dimColor tabular>
          {`· ${ago(room.since, now).replace(' ago', '')}`}
        </Text>
      </Box>
      <Box flexDirection="column">
        <Text size="heading" weight="semibold" wrap="truncate-end">
          {tidyTitle(room.title)}
        </Text>
        <Text size="footnote" dimColor>
          {`${v.mode === 'host' ? 'Your session' : `${room.host}'s session`} · ${here.length} of ${people.length} here`}
        </Text>
      </Box>
      <Box flexDirection="column" gap="xs">
        {people.map(p => (
          <Box key={`who-${p.name}`} flexDirection="row" alignItems="center" gap={1}>
            {faceOf(el, surface, p, 18)}
            <Text weight="semibold" color={p.online ? p.color : undefined} dimColor={!p.online} hover={{ scope: `person-${p.name}`, inverse: true }}>
              {p.name}
            </Text>
            <Text size="footnote" dimColor wrap="truncate-end">
              {doing(p)}
            </Text>
          </Box>
        ))}
      </Box>
      <Box flexDirection="row" alignItems="center" gap={1}>
        {Svg ? <Svg source={stack.source} alt={`Here: ${here.map(p => p.name).join(', ')}`} width={stack.width} height={24} /> : null}
        <Button key="who-room" variant="primary" onPress={open}>
          Open the Room
        </Button>
      </Box>
    </Box>
  )
}

// One person in several sessions is still one name.
function listNames(all: string[]): string {
  const names = [...new Set(all)]
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}
