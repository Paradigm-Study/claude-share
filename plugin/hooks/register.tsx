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

import type { ShareAccount, ShareActivity, ShareChange, ShareChat, ShareDoing, ShareFileMeta, ShareInvite, ShareLocalPreview, ShareMode, SharePerson, SharePolicy, SharePrefs, ShareRoom, ShareShown, ShareTeam, ShareTeams, ShareTeamSession, ShareTurn, ShareWorking } from '../types'
import { fit, isModern } from './fit'
import { BAD, GOOD, ago, avatarSvg, cloverSvg, colorFor, colorsFor, labelsFor, liveSvg, stackSvg, toolGlyph } from './look'
import { REACTS, diffOf, mentionsOf, patchOf, replyKey, took, writeOf } from './room'
import type { Patch } from './room'
import type { Face } from './look'
import { attachmentsOf, delivered, rowsFromMessage, rowsToMarkdown, splitSpeaker, summarizeTool } from './rows'
import type { Media, RoomImage, Row } from './rows'
import { SERVER_URL } from './server'
import { readsInside } from './paths'

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
const trustedA = atom({ plugin: 'shared-session', key: 'trusted' } as const, [] as string[])
const ownersA = atom({ plugin: 'shared-session', key: 'owners' } as const, {} as Record<string, string>)
const liveUpdatesA = atom({ plugin: 'shared-session', key: 'liveUpdates' } as const, null as 'running' | 'next' | 'pinned' | null)
const replayRunF = atom({ plugin: 'shared-session', key: 'replayRun' } as const, null as { tools?: string[]; hidden?: true } | null)
const toolRowsA = atom({ plugin: 'shared-session', key: 'toolRows' } as const, 'grouped' as 'grouped' | 'each')
const approvingA = atom({ plugin: 'shared-session', key: 'approving' } as const, null as { who: string; what: string; always: string } | null)
const sidebarA = atom({ plugin: 'shared-session', key: 'sidebar' } as const, null as { title: string; pinned: boolean; id?: string; pinOk?: boolean } | null)
const shownA = atom({ plugin: 'shared-session', key: 'shown' } as const, [] as ShareShown[])
const previewsA = atom({ plugin: 'shared-session', key: 'previews' } as const, {} as Record<string, string>)
const forwardPortsA = atom({ plugin: 'shared-session', key: 'forwardPorts' } as const, [] as string[])
const localPreviewsA = atom({ plugin: 'shared-session', key: 'localPreviews' } as const, [] as ShareLocalPreview[])
const autoOpenA = atom({ plugin: 'shared-session', key: 'autoOpen' } as const, true)
const askingA = atom({ plugin: 'shared-session', key: 'asking' } as const, null as { prompts: number } | null)
const connectionA = atom({ plugin: 'shared-session', key: 'connection' } as const, 'live' as 'live' | 'reconnecting')
const confirmingA = atom({ plugin: 'shared-session', key: 'confirming' } as const, null as 'stop' | null)
const newerA = atom({ plugin: 'shared-session', key: 'newer' } as const, null as string | null)
const pagesA = atom({ plugin: 'shared-session', key: 'pages' } as const, {} as Record<string, Record<string, unknown>>)
const updatesA = atom({ plugin: 'shared-session', key: 'updates' } as const, null as boolean | null)
const NO_TEAMS: ShareTeams = { server: '', account: null, teams: [], current: null, byLink: false, sessions: [], members: [], providers: [], signingIn: null, invite: null, loaded: 0, error: null }
const teamsA = atom({ plugin: 'shared-session', key: 'teams' } as const, NO_TEAMS)
const invitesA = atom({ plugin: 'shared-session', key: 'invites' } as const, [] as ShareInvite[])
const invitedA = atom({ plugin: 'shared-session', key: 'invited' } as const, {} as Record<string, number>)
const pinRefusedA = atom({ plugin: 'shared-session', key: 'pinRefused' } as const, false)
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
  from: { seat: string; name: string; role: 'host' | 'guest' }
  ts: number
  body: Record<string, unknown>
}

type EventsPage = { seq: number; events: ServerEvent[]; people: SharePerson[]; ended: boolean; title: string; more?: boolean }

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
const CARDS_FROM = '0.9.0' // the first version whose tool calls guests draw as cards
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
  // Changing the loader changes $.store's identity. Preserve its room
  // checkpoints before either direction of that transition is enabled.
  try { await migrateRoomCheckpoints($) } catch (error) {
    $.ui.log(`Couldn't preserve saved shared sessions, so the plugin loader was not changed: ${String((error as Error)?.message ?? error)}`)
    return false
  }
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
  const home = await $.env.get('HOME')
  if (!mine || !home) return
  let installed: { installPath?: unknown; version?: unknown } | undefined
  try {
    const list = JSON.parse(await $.fs.read(`${home}/.claude/plugins/installed_plugins.json`))
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

async function settingsFile($: $): Promise<string | null> {
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude/settings.json` : null
}

// Claude Desktop hands each session the installed copy's own folder when
// its marketplace is a local one (a folder or a file, as a clone added by
// path is). That folder comes ahead of the one that updates itself, so in
// Desktop a release loads only at a restart; a GitHub marketplace's plugin is
// left to Claude Code's loader, where the updating folder wins.
async function pinnedByDesktop($: $): Promise<boolean> {
  if ((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) !== 'claude-desktop') return false
  const home = await $.env.get('HOME')
  if (!home) return false
  try {
    const known = JSON.parse(await $.fs.read(`${home}/.claude/plugins/known_marketplaces.json`)) as Record<string, { source?: { source?: unknown } }>
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
  // Automatic updates chosen before they could load in place (or the folder
  // named for them gone): in place now.
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
    $.ui.toast("Couldn't read ~/.claude/settings.json, so nothing changed")
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
  return url
}
let myName: string | undefined
// An entry held (`hold`) waits for its pictures to go up, and what follows it waits too.
let outbox: { type: string; body: Record<string, unknown>; hold?: boolean }[] = []
let flushTimer: Timer | null = null
let flushing = false
let flushFailures = 0
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

type LocalPreviewRun = {
  room: string
  port: number
  preferredPort: number
  requestedPort?: number
  localPort?: number
  generation: number
  child?: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  timer?: Timer
  ready: Promise<boolean>
  settle: (ready: boolean) => void
  started: boolean
  expired: boolean
  error: string
  channelError?: string
  stopping?: Promise<void>
}
const localPreviewRuns = new Map<string, LocalPreviewRun>()
let localPreviewGeneration = 0

type TcpRelayRun = { id: string; pid: string; port: number; generation: number; worker: TcpWorkerRun }
type TcpWorkerRun = {
  room: ShareRoom
  generation: number
  controlToken: string
  ready: Promise<boolean>
  settle: (ready: boolean) => void
  queue: Promise<void>
  started: boolean
  stopped: boolean
  port?: number
  child?: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  timer?: Timer
  stopping?: Promise<void>
}
const tcpRelays = new Map<string, TcpRelayRun>()
const tcpRevoking = new Set<string>()
const tcpRejecting = new Set<string>()
let tcpWorker: TcpWorkerRun | null = null
let tcpAccepting = true
const TCP_RELAYS = 64
const TCP_BUSY = 'Preview connection or request limit reached. Close unused preview tabs or wait a minute, then retry.'
const TCP_AUTH = 'Preview authorization was refused. Press Open in the Room to reconnect.'

// Host: guest prompts submitted and not yet started, oldest first.
const pendingGuestPrompts: { who: string; framed: string; text: string; pid: string; attached?: string[] }[] = []
// Guest: a prompt with attachments, held until its stored message hands over
// their bytes (a prompt's hook sees only their kinds), then sent with them.
let heldPrompt: { text: string; pid: string; names: string[]; timer: Timer } | null = null
// Host: the approval question on screen, so its dialog can show a preview.
let pendingAsk: { who: string; preview: string; descriptions: Record<string, string> } | null = null
// The row-above-the-prompt answer to a teammate's call, when the dialog didn't show.
let bandAnswer: ((label: string) => void) | null = null

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
    try {
      // The smallest page of history: this seat already has it.
      const joined = await api<{ token: string; seat: string }>($, room.server, `/api/rooms/${room.id}/join?max=64000`, {
        method: 'POST',
        body: { name: await whoami($) },
        account: (await signInFor($, room.server))?.token,
      })
      await update($, roomA, r => (r && r.id === room.id ? { ...r, token: joined.token, seat: joined.seat } : r))
      $.ui.log('Shared session: the room let this seat go; took a new one', { to: 'debug' })
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
    await reset($)
    $.ui.log(again.why && !/no longer shared/i.test(again.why) ? `Left ${room.host}'s session: ${again.why}` : `${room.host}'s session is no longer shared.`)
    return false
  }
  const mode = await read($, modeA)
  await reset($)
  $.ui.log(mode === 'guest' ? `${room.host}'s session is no longer shared.` : 'Sharing ended: the room closed on the server. Press Share to start a new one.')
  return false
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
// its arguments: they arrive whole in the call's row once it's made.
async function liveFeed($: $, turnId: string): Promise<(chunk: TurnStepChunk) => void> {
  const othersHere = async () => (await read($, peopleA)).some(p => p.online && p.role !== 'host')
  let watching = await othersHere()
  let seen = 0
  const drafts = new Map<number, { tool: string; head: string; chars: number; sent: number; target: string }>()
  return chunk => {
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
    return
  }
  // Up to 200 events and ~400 KB a post (the server takes 512 KB).
  let take = 0
  let bytes = 0
  while (take < Math.min(200, outbox.length) && !outbox[take]!.hold) {
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
  } catch (error) {
    const reseated = error instanceof ApiError && error.status === 401 && (await read($, modeA)) === 'guest' && (await reseat($, room)).ok
    if (isGone(error) && !reseated) outbox = []
    else {
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
      `url = "${room.server}/api/rooms/${room.id}/stream?after=${room.seq}${(await read($, modeA)) === 'host' ? '&tcp=1' : ''}"`,
      `header = "Authorization: Bearer ${room.token}"`,
      'header = "Accept: application/x-ndjson"',
      // Which plugin this is, so the room knows who needs to update.
      `header = "x-shared-session-version: ${await ownVersion($)}"`,
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
          else if (message.proxy && typeof message.proxy === 'object') {
            // Host: a guest's browser, through a preview, asking this machine.
            void answerProxy($, room, message.proxy as Record<string, unknown>)
          } else if (message.ws && typeof message.ws === 'object') {
            // …or opening a WebSocket on it (live reload, a dev page's debug data).
            void relaySocket($, room, message.ws as Record<string, unknown>)
          } else if (message.tcp && typeof message.tcp === 'object') {
            void relayTcp($, room, message.tcp as Record<string, unknown>)
          }
          else if (Array.isArray(message.events)) {
            if (!streamUp && !delivered) $.ui.log('Shared session: listening on a stream', { to: 'debug' })
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
      // A server without streams answers the address itself with "Not found".
      if (status === 404 && refusal === 'Not found') return void startPolls($, generation, 'the server has no stream')
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
  if ((await read($, connectionA)) !== state) await update($, connectionA, () => state)
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
// for much longer than 10 s before a word arrives. So waits are `sleep`s.
async function pause($: $, ms: number) {
  try {
    await $.process.run(['sleep', (ms / 1000).toFixed(2)], { timeoutMs: ms + 2_000 })
  } catch {
    await new Promise<void>(resolve => $.clock.after(ms, resolve))
  }
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
    pollFailures = 0
    await setConnection($, 'live')
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
      await note({ ts: event.ts, who, kind: 'leave', text: lost ? 'timeout' : undefined })
      if (lost) lostAt.set(who, event.ts)
      else if (live && !mine) $.ui.log(`${who} left`)
      break
    }
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
      await update($, shownA, list => [...list.filter(s => s.key !== shown.key), shown].slice(-40))
      await note({ ts: event.ts, who: room.host, kind: 'shown', text: shown.name })
      break
    }
    case 'turn':
      if (body.state === 'start') {
        const by = typeof body.by === 'string' ? body.by : room.host
        const prompt = typeof body.prompt === 'string' ? body.prompt : ''
        turnBy = by
        const turn: ShareTurn = { id: String(body.turnId ?? event.seq), who: by, prompt: prompt.replace(/\s+/g, ' ').trim().slice(0, 400), at: event.ts }
        await update($, turnsA, list => [...list.filter(t => t.id !== turn.id), turn].slice(-200))
        if (live && !mine && prompt) await noteMention($, room, by, prompt, 'prompt')
        // A guest's own prompt starting on the host's Claude.
        if (live && mode === 'guest' && by === (await meIn($, room))) void cue($, 'turn')
      } else if (body.state === 'end') {
        const id = String(body.turnId ?? '')
        lastTurnFor = turnBy
        turnBy = null
        await update($, turnsA, list => list.map(t => (t.id === id && t.ms === undefined ? { ...t, ms: typeof body.durationMs === 'number' ? body.durationMs : Math.max(0, event.ts - t.at) } : t)))
      }
      break
    case 'row':
      await noteRow($, room, body as unknown as Row, event.ts)
      break
    case 'react':
      if (typeof body.key === 'string' && typeof body.emoji === 'string' && (REACTS as readonly string[]).includes(body.emoji)) {
        const key = body.key
        const emoji = body.emoji
        const on = body.on !== false
        await update($, reactionsA, all => {
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
          const out = { ...all }
          for (const k of keys) out[k] = [...new Set([...(out[k] ?? []), who])]
          return out
        })
      }
      break
    case 'preview':
      if (body.state === 'closed' && typeof body.pid === 'string') {
        const pid = body.pid
        if (mode === 'host') await revokeTcpPreview($, pid)
        await stopLocalPreview($, pid)
        await update($, shownA, list => list.map(s => (s.pid === pid ? { ...s, closed: true } : s)))
      }
      break
  }
}

// What the Room panel lists for an artifact event.
function shownOf(event: ServerEvent): ShareShown | null {
  const body = event.body
  const kind = body.kind
  if (kind !== 'send' && kind !== 'widget' && kind !== 'file' && kind !== 'page' && kind !== 'preview' && kind !== 'link') return null
  const files = Array.isArray(body.files) ? (body.files as ShareFileMeta[]) : undefined
  const name =
    kind === 'preview'
      ? `${typeof body.title === 'string' && body.title ? body.title : 'localhost'} (preview)`
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
    ts: event.ts,
    files,
    pid: typeof body.pid === 'string' ? body.pid : undefined,
    port: typeof body.port === 'number' ? body.port : undefined,
    path: kind === 'preview' && typeof body.path === 'string' && body.path.startsWith('/') ? body.path : undefined,
    ...(kind === 'preview' && body.tcp === true ? { tcp: true } : {}),
    url: typeof body.url === 'string' ? body.url : undefined,
  }
}

// ---------------------------------------------------------------------------
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
async function noteRow($: $, room: ShareRoom, row: Row, ts: number) {
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
    const was = list.find(c => c.path === call.path)
    const merged: ShareChange = was
      ? { path: call.path, who, added: was.added + change.added, removed: was.removed + change.removed, patch: joinPatches(change.patch, was.patch), at: ts }
      : { path: call.path, who, ...change, at: ts }
    return [...list.filter(c => c.path !== call.path), merged].slice(-40)
  })
}

// The calls a page of events (or a history replay) counted, written at once.
async function flushCalls($: $) {
  if (!callsPending) return
  const n = callsPending
  callsPending = 0
  await update($, callsA, c => c + n)
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
async function updateHere($: $) {
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
  if (code !== 0) {
    $.ui.log(`Couldn't update Shared Sessions here (${out.trim().split('\n').pop() || 'no output'}). In a terminal on this computer, run: ${UPDATE_COMMAND}`)
    return
  }
  let installed = ''
  try {
    const list = JSON.parse(await $.fs.read(`${home}/.claude/plugins/installed_plugins.json`))
    installed = String(((list.plugins ?? list)[INSTALLED_ID] as { version?: unknown }[] | undefined)?.find(x => typeof x.version === 'string')?.version ?? '')
  } catch {}
  const mine = await ownVersion($)
  if (runsLive($) && installed && newerThan(installed, mine)) {
    await catchUpFromInstalled($)
    return void $.ui.log(`Shared Sessions ${installed} is installed here and loads into this session in place.`)
  }
  if (installed && newerThan(installed, mine)) return void $.ui.log(`Shared Sessions ${installed} is installed here. Start a new session to use it (in Claude Desktop, quit and reopen the app); with Updates on in the Room, later releases load in place.`)
  $.ui.log(`Shared Sessions is up to date here (${installed || mine}).`)
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
  const hostWas = (await read($, peopleA)).find(p => p.role === 'host')?.online
  await update($, peopleA, () => page.people)
  if (mode === 'host') await noteBehind($, page.people)
  const hostIs = page.people.find(p => p.role === 'host')?.online
  if (mode === 'guest' && hostWas !== undefined && hostIs !== undefined && hostWas !== hostIs) {
    $.ui.toast(hostIs ? `${room.host} is back` : `${room.host}'s Claude Code closed; the room waits for them`)
  }
  let seq = room.seq
  for (const event of page.events) {
    seq = Math.max(seq, event.seq)
    const body = event.body
    await absorb($, room, mode, event, true)
    switch (event.type) {
      case 'prompt':
        if (mode === 'host' && typeof body.text === 'string') {
          await acceptPrompt($, event.from.name, body.text, typeof body.pid === 'string' ? body.pid : '', Array.isArray(body.attachments) ? (body.attachments as ShareFileMeta[]) : [])
        }
        break
      case 'stop':
        if (mode === 'host') await stopTurn($, event.from.name)
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
          await update($, roomA, r => (r ? { ...r, title } : r))
        }
        break
      case 'ended':
        await reset($)
        $.ui.log(mode === 'guest' ? `${room.host} stopped sharing this session.` : 'This shared session ended.')
        return
    }
  }
  await update($, roomA, r => (r && r.id === room.id ? { ...r, seq: Math.max(r.seq, seq) } : r))
  await flushCalls($)
  await refreshStatus($)
  if (mode === 'guest') scheduleRides($)
}

async function reset($: $, opts: { keepSidebar?: boolean } = {}) {
  // Revoke local work before slow sidebar or network cleanup. The room is
  // still known when its old sidebar title is restored below.
  pollGeneration += 1
  localPreviewGeneration += 1
  const stopped = stopTcpRelays($)
  stopStream()
  const was = await read($, roomA)
  const wasMode = await read($, modeA)
  await update($, modeA, () => 'idle')
  await stopLocalPreviews($)
  await stopped
  if (!opts.keepSidebar) await unmarkSidebar($, wasMode === 'guest' && was ? `${was.host}'s session · ${was.title}`.slice(0, 120) : undefined)
  outbox = []
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
  pendingGuestPrompts.length = 0
  await update($, roomA, () => null)
  void holdRoom($).catch(() => {})
  await update($, peopleA, () => [])
  await update($, workingA, () => null)
  await update($, activityA, () => [])
  await update($, chatA, () => [])
  await update($, unreadA, () => 0)
  await update($, policyA, () => DEFAULT_POLICY)
  await update($, trustedA, () => [])
  await update($, ownersA, () => ({}))
  await update($, shownA, () => [])
  await update($, previewsA, () => ({}))
  await update($, forwardPortsA, () => [])
  await update($, askingA, () => null)
  await update($, connectionA, () => 'live')
  await update($, confirmingA, () => null)
  bandAnswer?.('Decline')
  await update($, approvingA, () => null)
  await update($, turnsA, () => [])
  await update($, changesA, () => [])
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

// Adds allow rules for the sidebar tools above to ~/.claude/settings.json
// (the person pressed Allow pinning), the rest kept; then pins.
async function allowDeskTools($: $) {
  const found = await readSettings($)
  if (!found) return void $.ui.toast("Couldn't read ~/.claude/settings.json, so nothing changed")
  const permissions = { ...((found.settings.permissions ?? {}) as Record<string, unknown>) }
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]).filter((r): r is string => typeof r === 'string') : []
  permissions.allow = [...allow, ...DESK_TOOLS.filter(t => !allow.includes(t))]
  try {
    await $.fs.write(found.path, `${JSON.stringify({ ...found.settings, permissions }, null, 2)}\n`)
  } catch {
    return void $.ui.toast("Couldn't change ~/.claude/settings.json")
  }
  $.ui.toast('Pinning allowed: shared sessions pin themselves again')
  await setPinned($, true, 2)
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

// Share pressed. Sharing sends everything earlier to everyone with the link,
// so a session with earlier prompts asks first, in the row above the prompt
// (and the Room), whether to include them; a fresh one shares at once.
async function requestShare($: $, surface?: RenderSurface) {
  const prompts = (await read($, modeA)) === 'idle' ? await earlierPrompts($) : 0
  if (prompts === 0) {
    await share($, surface)
    return
  }
  await update($, askingA, () => ({ prompts }))
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
// saying who joins); `team: false` shares by link alone.
async function share($: $, surface?: RenderSurface, opts: { history?: boolean; team?: boolean } = {}): Promise<ShareRoom> {
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
  await update($, roomA, () => room)
  await update($, modeA, () => 'host')
  tcpAccepting = true
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
    await stopSharing($)
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
  trusted: string[]
  previews: Record<string, string>
  forwardPorts?: string[]
  shown: ShareShown[]
  activity: ShareActivity[]
  chat: ShareChat[]
  sidebar: { title: string; pinned: boolean; id?: string } | null
  place?: string
}

// Installed marketplace and inline-folder copies have different $.store
// identities. Room checkpoints belong to the person's Claude configuration,
// outside the live plugin folder that updates replace. Each session has its
// own file, so saving another room cannot overwrite this one's checkpoint.
type RoomCheckpoint = Hosting | Joined
type RoomCheckpointFile = { version: 1; value: RoomCheckpoint | null }

async function roomCheckpointDir($: $): Promise<string> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR'))?.trim()
  const home = await $.env.get('HOME')
  if (!config && !home) throw new Error('No Claude configuration directory is available')
  return `${(config || `${home}/.claude`).replace(/\/+$/, '')}/shared-session/rooms`
}

function isRoomCheckpointKey(key: string): boolean {
  return key.startsWith(HOSTING_KEY) || key.startsWith(JOINED_KEY)
}

function isRoomCheckpoint(value: unknown): value is RoomCheckpoint {
  const saved = value as Partial<RoomCheckpoint> | null
  return Boolean(saved && typeof saved.at === 'number' && Number.isFinite(saved.at) && saved.room && typeof saved.room.token === 'string' && typeof saved.room.seat === 'string')
}

async function readRoomCheckpointFile($: $, key: string): Promise<RoomCheckpointFile | undefined> {
  const path = `${await roomCheckpointDir($)}/${encodeURIComponent(key)}.json`
  if (!(await $.fs.exists(path))) return undefined
  const text = await $.fs.read(path)
  let record: RoomCheckpointFile
  try { record = JSON.parse(text) as RoomCheckpointFile } catch {
    // JSON's syntax error may quote the damaged payload, which holds tokens.
    throw new Error('A saved room checkpoint is invalid; it was left untouched')
  }
  if (record?.version !== 1 || (record.value !== null && !isRoomCheckpoint(record.value))) throw new Error('A saved room checkpoint is invalid; it was left untouched')
  return record
}

async function readRoomCheckpoint($: $, key: string): Promise<RoomCheckpoint | undefined> {
  return (await readRoomCheckpointFile($, key))?.value ?? undefined
}

async function writeRoomCheckpoint($: $, key: string, value: RoomCheckpoint | null, migrate = false) {
  const dir = await roomCheckpointDir($)
  const path = `${dir}/${encodeURIComponent(key)}.json`
  const tmp = `${dir}/.checkpoint-${randomSecret()}.tmp`
  const body = JSON.stringify({ version: 1, value })
  const tag = fence(body)
  // A migration never replaces an existing canonical file, even a tombstone.
  // ln publishes atomically only if absent: a concurrent save/consume wins.
  // Unique private temp files keep unrelated sessions independent. Credentials
  // travel on stdin, never argv, and failed writes leave the old file intact.
  const publish = migrate
    ? `if ln ${sq(tmp)} ${sq(path)} 2>/dev/null; then :; elif [ -f ${sq(path)} ]; then :; else exit 1; fi`
    : `mv ${sq(tmp)} ${sq(path)}`
  const result = await sh($, `umask 077\nset -e\nmkdir -p ${sq(dir)}\nchmod 700 ${sq(dir)}\ntmp=${sq(tmp)}\ntrap 'rm -f "$tmp"' 0\ncat > ${sq(tmp)} <<'${tag}'\n${body}\n${tag}\nchmod 600 ${sq(tmp)}\n${publish}\n`)
  if (result.code !== 0) throw new Error('Could not write the private saved room checkpoint')
}

async function deleteRoomCheckpoint($: $, key: string) {
  // Retain a small receipt without credentials. An old store encountered
  // after switching back must not resurrect a consumed or stopped room.
  await writeRoomCheckpoint($, key, null)
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

async function migrateRoomCheckpoints($: $) {
  for (const key of await $.store.keys()) {
    if (!isRoomCheckpointKey(key)) continue
    const value = await $.store.get(key)
    if (value === undefined) continue
    // Once present, canonical state is authoritative. In particular, no
    // timestamp on a legacy value can override an intentional tombstone.
    if (!(await readRoomCheckpointFile($, key))) {
      if (!isRoomCheckpoint(value)) throw new Error('A legacy saved room checkpoint is invalid; it was left untouched')
      await writeRoomCheckpoint($, key, value, true)
    }
    // A lost ln race is safe only when the winning file is valid and readable.
    if (!(await readRoomCheckpointFile($, key))) throw new Error('The saved room checkpoint could not be verified')
    await $.store.delete(key)
  }
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
    // Places saved before `place` was: the sidebar row's id is the same one.
    if (typeof saved?.at === 'number' && (saved.place ?? saved.sidebar?.id) === place) mine.push({ key, at: saved.at })
  }
  mine.sort((a, b) => b.at - a.at)
  return { key: mine[0]?.key ?? null, older: mine.slice(1).map(m => m.key) }
}

async function keepHosting($: $, sessionId: string) {
  await stopTcpRelays($)
  const room = await read($, roomA)
  if (!room) return
  const saved: Hosting = {
    at: await $.clock.now(),
    room,
    policy: await read($, policyA),
    trusted: await read($, trustedA),
    previews: await read($, previewsA),
    forwardPorts: await read($, forwardPortsA),
    shown: (await read($, shownA)).slice(-20),
    activity: (await read($, activityA)).slice(-40),
    chat: (await read($, chatA)).slice(-40),
    sidebar: await read($, sidebarA),
    place: (await placeOf($)) || undefined,
  }
  await writeRoomCheckpoint($, `${HOSTING_KEY}${sessionId}`, saved)
  stopStream()
  await flush($) // what Claude said last, if the exit gives it time
  // This process may go on as another session (a /resume): that one isn't sharing.
  await reset($, { keepSidebar: true })
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
  shown: ShareShown[]
  localPreviews?: ShareLocalPreview[]
  activity: ShareActivity[]
  chat: ShareChat[]
  sidebar: { title: string; pinned: boolean; id?: string } | null
  place?: string
}

async function keepJoined($: $, sessionId: string) {
  const room = await read($, roomA)
  if (!room) return
  const saved: Joined = {
    at: await $.clock.now(),
    room,
    autoOpen: await read($, autoOpenA),
    policy: await read($, policyA),
    shown: (await read($, shownA)).slice(-20),
    localPreviews: await read($, localPreviewsA),
    activity: (await read($, activityA)).slice(-40),
    chat: (await read($, chatA)).slice(-40),
    sidebar: await read($, sidebarA),
    place: (await placeOf($)) || undefined,
  }
  await writeRoomCheckpoint($, `${JOINED_KEY}${sessionId}`, saved)
  stopStream()
  // This process may go on as another session (a /resume): that one isn't in the room.
  await reset($, { keepSidebar: true })
}

async function resumeJoined($: $) {
  const { key, older } = await savedKey($, JOINED_KEY)
  for (const stale of older) await deleteRoomCheckpoint($, stale)
  if (!key) return
  const saved = (await readRoomCheckpoint($, key)) as Joined | undefined
  if (!saved?.room?.token || saved.room.seat === 'host') return
  await deleteRoomCheckpoint($, key)
  if ((await $.clock.now()) - saved.at > HOSTING_KEEP_MS) return
  // Over while this was closed: only now does the sidebar row go back.
  const over = async () => {
    await update($, sidebarA, () => saved.sidebar ?? null)
    await unmarkSidebar($, `${saved.room.host}'s session · ${saved.room.title}`.slice(0, 120))
    $.ui.log(`${saved.room.host}'s session ended while this one was closed.`)
  }
  let room = saved.room
  let missed: ServerEvent[] = []
  let people: SharePerson[] | null = null
  try {
    const page = await eventsSince($, room, room.seq)
    if (page.ended) return void (await over())
    missed = page.events
    people = page.people
    room = { ...room, seq: page.seq }
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 410)) return void (await over())
    if (error instanceof ApiError && error.status === 401) {
      // The seat was let go: a new one, and what happened since the old one's last.
      try {
        const joined = await api<{ token: string; seat: string; seq: number; title: string; history: ServerEvent[]; people: SharePerson[]; more?: boolean; historySeq?: number }>(
          $,
          room.server,
          `/api/rooms/${room.id}/join?max=${PAGE_BYTES}`,
          { method: 'POST', body: { name: await whoami($) }, account: (await signInFor($, room.server))?.token },
        )
        // Only what came after the old seat's last: page from there.
        const from = Math.max(saved.room.seq, joined.more && typeof joined.historySeq === 'number' ? joined.historySeq : joined.seq)
        missed = joined.history.filter(e => e.seq > saved.room.seq)
        if (joined.more && from < joined.seq) missed.push(...(await eventsSince($, { server: room.server, id: room.id, token: joined.token }, from, joined.seq)).events.filter(e => e.seq > saved.room.seq && e.type !== 'delta'))
        people = joined.people
        room = { ...room, token: joined.token, seat: joined.seat, seq: joined.seq, title: joined.title }
      } catch (again) {
        if (again instanceof ApiError && (again.status === 404 || again.status === 410)) return void (await over())
        throw again
      }
    }
    // Unreachable for now: back in anyway, and the feed keeps trying.
  }
  await update($, roomA, () => room)
  await update($, policyA, () => ({ ...DEFAULT_POLICY, ...saved.policy }))
  await update($, autoOpenA, () => saved.autoOpen !== false)
  await update($, shownA, () => saved.shown ?? [])
  await update($, localPreviewsA, () => saved.localPreviews ?? [])
  await update($, activityA, () => saved.activity ?? [])
  await update($, chatA, () => saved.chat ?? [])
  await update($, sidebarA, () => saved.sidebar ?? null)
  await update($, modeA, () => 'guest')
  if (people) await update($, peopleA, () => people)
  await readyReplay($)
  for (const event of missed) await absorb($, room, 'guest', event, false)
  await flushCalls($)
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
}

async function forgetHosting($: $) {
  try {
    await deleteRoomCheckpoint($, `${HOSTING_KEY}${await $.session.id()}`)
  } catch {}
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
  await deleteRoomCheckpoint($, found.key)
  if (now - saved.at > HOSTING_KEEP_MS) return
  let page: EventsPage | null = null
  try {
    page = await eventsSince($, saved.room, saved.room.seq)
  } catch (error) {
    if (isGone(error)) return void $.ui.log('The session you shared ended while this one was closed.')
    // Unreachable for now: share on, and the feed keeps trying.
  }
  if (page?.ended) return void $.ui.log('The session you shared ended while this one was closed.')
  const room: ShareRoom = { ...saved.room, seq: page?.seq ?? saved.room.seq }
  await update($, roomA, () => room)
  await update($, policyA, () => ({ ...DEFAULT_POLICY, ...saved.policy }))
  await update($, trustedA, () => saved.trusted ?? [])
  await update($, previewsA, () => saved.previews ?? {})
  await update($, forwardPortsA, () => saved.forwardPorts ?? [])
  await update($, shownA, () => saved.shown ?? [])
  await update($, activityA, () => saved.activity ?? [])
  await update($, chatA, () => saved.chat ?? [])
  await update($, sidebarA, () => saved.sidebar ?? null)
  await update($, modeA, () => 'host')
  tcpAccepting = true
  if (page) {
    await update($, peopleA, () => page.people)
    // What happened while it was closed: the chat and comings and goings are
    // kept; a prompt sent then is answered, not run late.
    for (const event of page.events) {
      if (event.type === 'prompt' && event.from.role === 'guest') {
        send($, 'declined', { pid: typeof event.body.pid === 'string' ? event.body.pid : '', who: event.from.name, reason: `${room.host}'s Claude Code was closed when you sent this, so it didn't run. Send it again.` })
        continue
      }
      await absorb($, room, 'host', event, false)
    }
    await flushCalls($)
  }
  startFeed($)
  $.ui.log(`Still sharing this session: ${room.url}`)
  // Dev servers this session's Claude opened, running again (or never shared
  // by the version that was running before), open for everyone too.
  void shareLocal($, localOpens(await sessionHistory($))).catch(() => {})
}

async function stopSharing($: $) {
  await stopTcpRelays($)
  const room = await read($, roomA)
  try { await forgetHosting($) } finally { await reset($) }
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

async function acceptPrompt($: $, who: string, text: string, pid: string, attachments: ShareFileMeta[] = []) {
  if ((await read($, policyA)).prompts === 'watch') {
    send($, 'declined', { pid, who, reason: 'This session is watch-only right now. Chat in the Room panel.' })
    return
  }
  // What they attached, saved in the project, each named in the prompt with
  // how to see it: a plugin's prompt carries words alone (no pictures, and its
  // own hooks can't add context to it), and Read shows images and PDFs.
  const attached = await saveAttachments($, who, attachments)
  const cwd = await $.session.cwd()
  const marks = attached.map(p => `📎 ${p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p} (attached by ${who}; open it with the Read tool to see it)`).join('\n')
  const framed = `${who}: ${text}${marks ? `${text ? '\n\n' : ''}${marks}` : ''}`
  pendingGuestPrompts.push({ who, framed, text: framed.slice(who.length + 2), pid, attached })
  // Runs once the session is idle, after any turn already running.
  submitLater($, framed)
}

// Host: a guest's attachments into .shared-session/<guest>/ in this session's
// folder, each under its own name.
async function saveAttachments($: $, who: string, files: ShareFileMeta[]): Promise<string[]> {
  const room = await read($, roomA)
  if (!room || !files.length) return []
  const cwd = await $.session.cwd()
  const dir = `${cwd}/.shared-session/${who.replace(/[^\w.-]+/g, '-').slice(0, 40) || 'guest'}`
  await sh($, `mkdir -p ${sq(dir)}\n`)
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
    hostVersion?: string
    team?: { id: string; name: string }
    more?: boolean
    historySeq?: number
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
    await update($, roomA, () => room)
    await update($, modeA, () => 'guest')
    await readyReplay($)
    await update($, peopleA, () => joined.people)
    await update($, workingA, () => null)
    // The room as it stands: its timeline, its chat, the host's policy.
    for (const event of history) await absorb($, room, 'guest', event, false)
    await flushCalls($)

    // A turn still running on the host plays out live; everything before it is
    // shown as it was, one exchange per prompt.
    const starts = history.filter(e => e.type === 'turn' && e.body.state === 'start')
    const ends = new Set(history.filter(e => e.type === 'turn' && e.body.state === 'end').map(e => e.body.turnId))
    const running = starts.filter(e => !ends.has(e.body.turnId)).at(-1)
    const past = history.filter(e => e.type === 'row' && (!running || e.seq < running.seq))
    if (running) noteHostTurn(running)
    // Previews the host still has open open here too, after the history (one
    // shown in the running turn opens as that turn plays out).
    const closed = new Set(history.filter(e => e.type === 'preview' && e.body.state === 'closed').map(e => e.body.pid))
    const open = new Map<string, ServerEvent>()
    for (const e of history) {
      if (e.type !== 'artifact' || e.body.kind !== 'preview' || typeof e.body.pid !== 'string' || closed.has(e.body.pid)) continue
      if (running && e.seq > running.seq) continue
      open.set(e.body.pid, e)
    }
    startFeed($)
    void holdRoom($).catch(() => {})
    await markSidebar($, () => `👥 ${room.host} · ${room.title}`)
    return {
      room,
      history: exchanges(past.map(e => e.body as unknown as Row), joined.host),
      // One preview opens: they share one host name, so a browser holds one at a
      // time (the newest); the rest are in the Room, a press of Open away.
      open: [...open.values()].slice(-1),
      fromNow: joined.fromNow === true,
      hostVersion: typeof joined.hostVersion === 'string' ? joined.hostVersion : null,
    }
  } catch (error) {
    // Seated but not in: the seat goes, so nobody sees a guest who isn't there.
    await api($, server, `/api/rooms/${id}/leave`, { method: 'POST', token: joined.token }).catch(() => {})
    if ((await read($, roomA))?.id === id) await reset($)
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

async function sh($: $, script: string): Promise<{ out: string; code: number | null }> {
  let out = ''
  try {
    const child = $.process.spawn({ argv: ['/bin/sh', '-s'], input: script })
    for await (const chunk of child) if (chunk.stream === 'stdout') out += chunk.text
    return { out, code: (await child.result.catch(() => ({ code: null }))).code }
  } catch {
    return { out, code: null }
  }
}

function roomConfig(room: ShareRoom, path: string): string {
  return [`url = ${cfg(`${room.server}/api/rooms/${room.id}/${path}`)}`, `header = ${cfg(`Authorization: Bearer ${room.token}`)}`, 'silent'].join('\n')
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

// Guest: a room file into .shared-session/<host>/ in this session's folder
// (inside the project, so the browser pane runs its pages live), kept out of git.
async function downloadFile($: $, room: ShareRoom, meta: ShareFileMeta, into?: string): Promise<string | null> {
  const cwd = await $.session.cwd()
  const dir = into ? into.slice(0, into.lastIndexOf('/')) : `${cwd}/.shared-session/${room.host.replace(/[^\w.-]+/g, '-').slice(0, 40) || 'host'}`
  const clean = meta.name.replace(/[^\w.\- ()]+/g, '-').replace(/^\.+/, '') || 'file'
  const owner = savedNames.get(`${dir}/${clean}`)
  const dot = clean.lastIndexOf('.')
  const name = !owner || owner === meta.id ? clean : dot > 0 ? `${clean.slice(0, dot)}-${meta.id.slice(0, 6)}${clean.slice(dot)}` : `${clean}-${meta.id.slice(0, 6)}`
  const path = into ?? `${dir}/${name}`
  const config = roomConfig(room, `files/${meta.id}`)
  const tag = fence(config)
  const exclude = excluded
    ? ''
    : `f=$(git rev-parse --git-path info/exclude 2>/dev/null) && { mkdir -p "$(dirname "$f")"; grep -qxF '.shared-session/' "$f" 2>/dev/null || echo '.shared-session/' >> "$f"; }\n`
  const { code } = await sh($, `mkdir -p ${sq(dir)} || exit 1\n${exclude}curl -K - -f -o ${sq(path)} <<'${tag}'\n${config}\n${tag}\n`)
  if (code !== 0) return null
  excluded = true
  savedNames.set(path, meta.id)
  return path
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
  const dir = `${cwd}/.shared-session/${room.host.replace(/[^\w.-]+/g, '-').slice(0, 40) || 'host'}/page-${files[0]!.id.slice(0, 8)}`
  for (const meta of files) {
    const at = pagePath(meta.path ?? meta.name)
    if (!at) continue
    if (at.includes('/')) await sh($, `mkdir -p ${sq(`${dir}/${at.slice(0, at.lastIndexOf('/'))}`)}\n`)
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

// Host: a preview of one localhost port, made once per port.
// `forward`: the host chose to let guests forward it to their own localhost
// over raw TCP (/share-preview, or Allow forwarding in the Room). A port
// shared because Claude mentioned it never is: it opens through its link,
// so a guest can't reach whatever happens to listen there (a database).
async function ensurePreview($: $, room: ShareRoom, port: number, title: string, forward = false): Promise<string | null> {
  const known = (await read($, previewsA))[String(port)]
  if (known && (!forward || (await read($, forwardPortsA)).includes(String(port)))) return known
  try {
    const { pid } = await api<{ pid: string }>($, room.server, `/api/rooms/${room.id}/previews`, { method: 'POST', token: room.token, body: { port, title, ...(forward ? { tcp: true } : {}) } })
    await update($, previewsA, map => ({ ...map, [String(port)]: pid }))
    if (forward) await update($, forwardPortsA, list => [...new Set([...list, String(port)])])
    return pid
  } catch (error) {
    $.ui.log(`Couldn't share localhost:${port}: ${String((error as Error)?.message ?? error)}`)
    return null
  }
}

// Host: Allow forwarding in the Room, for a preview Claude's mention shared.
async function allowForwarding($: $, item: ShareShown) {
  const room = await read($, roomA)
  if (!room || (await read($, modeA)) !== 'host' || !validPort(item.port)) return
  const title = item.name.replace(/ \(preview\)$/, '')
  const pid = await ensurePreview($, room, item.port, title, true)
  if (!pid) return void $.ui.toast(`Couldn't allow forwarding localhost:${item.port}`)
  send($, 'artifact', { kind: 'preview', pid, port: item.port, title, path: item.path ?? '/', tcp: true })
  $.ui.toast(`Guests can forward localhost:${item.port} to their own localhost now`)
}

async function stopPreview($: $, pid: string) {
  const room = await read($, roomA)
  if (!room) return
  await revokeTcpPreview($, pid)
  await api($, room.server, `/api/rooms/${room.id}/previews/${pid}/end`, { method: 'POST', token: room.token }).catch(() => {})
}

// Host: a localhost address Claude gave out (a dev server it started, say),
// or one it opened before Share, is shared like one it opens in the browser
// pane while sharing: when what Claude shows goes to everyone, and only once
// something answers there. On its own turn for guests, not the one that
// mentioned it (that may have ended).
const mentionedPorts = new Set<number>()
const localPages = (text: string) => [...text.matchAll(new RegExp(LOCAL_URL.source, 'gi'))].map(m => ({ port: Number(m[1]), path: m[2] ?? '/' }))

// The pages a browser_batch call opened, in order.
function batchOpens(input: Record<string, unknown>): string[] {
  const actions = Array.isArray(input.actions) ? (input.actions as { name?: unknown; input?: { url?: unknown } }[]) : []
  return actions.filter(a => (a?.name === 'navigate' || a?.name === 'preview_start') && typeof a.input?.url === 'string').map(a => a.input?.url as string)
}

// The localhost pages a session's Claude opened in the browser pane or gave
// the address of, each port at the page it was at last.
function localOpens(messages: unknown[]): { port: number; path: string }[] {
  const last = new Map<number, string>()
  for (const message of messages) {
    const m = message as { role?: unknown; content?: unknown }
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const block of m.content as { type?: unknown; text?: unknown; name?: unknown; input?: Record<string, unknown> }[]) {
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
          last.delete(page.port) // most recently used last
          last.set(page.port, page.path)
        }
      }
    }
  }
  return [...last].map(([port, path]) => ({ port, path }))
}

async function shareLocal($: $, pages: { port: number; path: string }[]) {
  if ((await read($, modeA)) !== 'host' || (await read($, policyA)).files === 'off') return
  const room = await read($, roomA)
  if (!room) return
  for (const { port, path } of pages.slice(-5)) {
    if (!port || mentionedPorts.has(port) || (await read($, previewsA))[String(port)]) continue
    mentionedPorts.add(port)
    // A web server: one that answers HTTP, or a dev server still compiling
    // its first page (it took the connection and is slow to answer, curl's
    // 28). Anything else listening there (a database, a cache: an empty or
    // garbled reply) isn't shared; refused (curl's 7) means nothing yet.
    const probe = await sh($, `curl -s -o /dev/null -w 'code=%{http_code}' --connect-timeout 2 -m 3 http://localhost:${port}/; echo " exit=$?"\n`)
    const exit = /exit=(\d+)/.exec(probe.out)?.[1]
    const code = /code=(\d{3})/.exec(probe.out)?.[1] ?? '000'
    if (exit === undefined || exit === '6' || exit === '7') {
      mentionedPorts.delete(port) // nothing there yet: a later mention tries again
      continue
    }
    if (code === '000' && exit !== '28') continue
    const title = `localhost:${port}`
    const pid = await ensurePreview($, room, port, title)
    if (!pid) continue
    send($, 'artifact', { kind: 'preview', pid, port, title, path })
    $.ui.toast(`Sharing localhost:${port} with the room (stop it in the Room)`)
  }
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
      .filter(Boolean)
      .at(-1)
    if (local) {
      const port = Number(local[1])
      const pid = await ensurePreview($, room, port, `localhost:${port}`)
      if (pid) send($, 'artifact', { kind: 'preview', turnId, pid, port, title: `localhost:${port}`, path: local[2] ?? '/' })
    }
  } else if (/^mcp__Claude_Browser__(preview_start|navigate)$/.test(tool)) {
    let url = str(input.url)
    if (!url) url = LOCAL_URL.exec(JSON.stringify(result ?? ''))?.[0] ?? ''
    if (url.startsWith('file://')) {
      const files = await uploads([decodeURIComponent(url.slice(7).split(/[?#]/)[0] ?? '')])
      if (files.length) send($, 'artifact', { kind: 'page', turnId, files })
      return
    }
    const local = LOCAL_URL.exec(url)
    if (local) {
      const port = Number(local[1])
      const title = str(input.name) || `localhost:${port}`
      const pid = await ensurePreview($, room, port, title)
      if (pid) send($, 'artifact', { kind: 'preview', turnId, pid, port, title, path: local[2] ?? '/' })
    } else if (/^https:\/\//.test(url)) {
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
      // Forwarded to this computer's localhost only when the guest says so:
      // Open in the Room starts the listener, never a replay.
      if (shown.tcp) return { label, note: `press **Open** in the Room to forward it to your own localhost:${shown.port}` }
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

// Guest: local and remote ports are independent. A chosen local port stays
// exact; automatic allocation may move, and only the actual address is opened.
async function ensureLocalPreview($: $, room: ShareRoom, shown: ShareShown): Promise<{ url?: string; error?: string }> {
  const generation = localPreviewGeneration
  const current = await read($, roomA)
  const port = shown.port
  const path = shown.path ?? '/'
  if (!current || current.id !== room.id || current.server !== room.server || (await read($, modeA)) !== 'guest' || generation !== localPreviewGeneration) return { error: 'This shared session is no longer open.' }
  if (!shown.pid || !/^[A-Za-z0-9_-]{1,64}$/.test(shown.pid) || shown.closed || !validPort(port) || !path.startsWith('/') || /[\x00-\x20\\]/.test(path)) return { error: 'That preview has ended or has no valid localhost address.' }
  const pid = shown.pid
  const key = `${current.server}/${current.id}`
  const saved = (await read($, localPreviewsA)).find(p => p.pid === pid && p.port === port)
  const requestedPort = validPort(saved?.requestedPort) ? saved.requestedPort : undefined
  let run = localPreviewRuns.get(pid)
  while (run && (run.stopping || run.expired || run.room !== key || run.port !== port || run.requestedPort !== requestedPort)) {
    await stopLocalPreview($, pid, false)
    if (generation !== localPreviewGeneration) return { error: 'This shared session is no longer open.' }
    run = localPreviewRuns.get(pid)
  }
  if (!run) {
    let settle!: (ready: boolean) => void
    const ready = new Promise<boolean>(done => { settle = done })
    const preferredPort = requestedPort ?? (validPort(saved?.localPort) ? saved.localPort : port)
    run = { room: key, port, preferredPort, requestedPort, generation, ready, settle, started: false, expired: false, error: `Couldn't forward localhost:${port}. Press Open in the Room to retry, or choose Public link.` }
    localPreviewRuns.set(pid, run)
    void startLocalPreview($, current, pid, run)
  }
  const ready = await run.ready
  const choice = (await read($, localPreviewsA)).find(p => p.pid === pid)
  if (!ready || !run.localPort || choice?.requestedPort !== run.requestedPort || localPreviewRuns.get(pid) !== run || run.stopping || run.expired || run.generation !== localPreviewGeneration) return { error: run.error }
  return { url: `http://localhost:${run.localPort}${path}` }
}

function validPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
}

async function changeLocalPort($: $, shown: ShareShown, value: string) {
  const room = await read($, roomA)
  const generation = localPreviewGeneration
  if (!room || (await read($, modeA)) !== 'guest' || !shown.pid || shown.closed || !validPort(shown.port)) return
  const words = value.trim()
  const requestedPort = !words || /^auto$/i.test(words) ? undefined : /^\d{1,5}$/.test(words) ? Number(words) : NaN
  if (requestedPort !== undefined && !validPort(requestedPort)) return void $.ui.toast('Choose a local port from 1 to 65535, or Auto.')
  await update($, localPreviewsA, list => [...list.filter(p => p.pid !== shown.pid), { pid: shown.pid!, port: shown.port!, requestedPort }])
  await stopLocalPreview($, shown.pid, false)
  if (generation !== localPreviewGeneration) return
  const opened = await ensureLocalPreview($, room, shown)
  $.ui.toast(opened.error ?? `Forwarded ${opened.url} to the host's localhost:${shown.port}. Press Open to use it.`)
}

async function startLocalPreview($: $, room: ShareRoom, pid: string, run: LocalPreviewRun) {
  let child: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
  try {
    const url = `${room.server}/api/rooms/${room.id}/previews/${pid}/tunnel`
    const grant = await api<{ token: string; expiresAt: number; port: number; protocol: number }>($, room.server, `/api/rooms/${room.id}/previews/${pid}/tunnel`, { method: 'POST', token: room.token })
    if (grant.protocol !== 1 || grant.port !== run.port || typeof grant.token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(grant.token) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= await $.clock.now()) {
      run.error = 'This server does not support local TCP forwarding. Update the server and host plugin, or choose Public link.'
      return
    }
    if (localPreviewRuns.get(pid) !== run || run.stopping || run.generation !== localPreviewGeneration) return
    child = $.process.spawn({ argv: ['/bin/sh', '-c', FIND_NODE, 'sh', `${$.plugin.root}/relay/local-preview.cjs`], input: JSON.stringify({ port: run.preferredPort, strict: run.requestedPort !== undefined, url, token: grant.token, expiresAt: grant.expiresAt }) })
    run.child = child
    // Don't let an unresponsive child consume a riding step's ten-second budget.
    run.timer = $.clock.after(8_000, () => {
      if (localPreviewRuns.get(pid) === run && !run.started) {
        run.error = `Local preview on localhost:${run.port} took too long to start. Press Open in the Room to retry.`
        void stopLocalPreview($, pid, false)
      }
    })
    let buffer = ''
    const result = child.result.catch(() => null)
    for await (const chunk of child) {
      if (localPreviewRuns.get(pid) !== run || run.stopping || run.generation !== localPreviewGeneration) break
      // No child diagnostics or credentials go into the transcript or logs.
      if (chunk.stream !== 'stdout') continue
      buffer += chunk.text
      let i: number
      while ((i = buffer.indexOf('\n')) >= 0) {
        if (i > 8192) throw new Error('Invalid local preview output')
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        let message: { state?: string; code?: string; port?: number }
        try { message = JSON.parse(line) } catch { continue }
        if (message.state === 'ready') {
          if (run.started || !validPort(message.port) || (run.requestedPort !== undefined && message.port !== run.requestedPort)) {
            run.error = 'The local preview did not report a valid listening port. Press Open in the Room to retry.'
            void stopLocalPreview($, pid, false)
            break
          }
          run.localPort = message.port
          run.started = true
          run.timer?.cancel()
          await update($, localPreviewsA, list => localPreviewRuns.get(pid) === run && !run.stopping && run.generation === localPreviewGeneration && list.find(p => p.pid === pid)?.requestedPort === run.requestedPort ? [...list.filter(p => p.pid !== pid), { pid, port: run.port, localPort: run.localPort, requestedPort: run.requestedPort }] : list)
          if (run.localPort !== run.port) $.ui.toast(`Forwarded localhost:${run.localPort} to the host's localhost:${run.port}. Fixed OAuth callbacks must match the local address.`)
          run.settle(true)
        } else if (message.state === 'expired') {
          run.expired = true
          run.error = 'Local preview authorization expired. Press Open in the Room to reconnect.'
          $.ui.toast(run.error)
          await $.ui.invalidate('ui.render')
        } else if (message.state === 'channel-ready') {
          if (run.channelError) {
            run.channelError = undefined
            await $.ui.invalidate('ui.render')
          }
        } else if (message.state === 'channel-error') {
          const error = message.code === 'BUSY' ? TCP_BUSY : message.code === 'AUTH' ? TCP_AUTH : ''
          // Browsers cancel individual sockets during navigation. A failed
          // channel doesn't stop this listener or any of its other channels.
          if (error && run.channelError !== error) {
            run.channelError = error
            $.ui.toast(error)
            await $.ui.invalidate('ui.render')
          }
        } else if (message.state === 'error') {
          run.error = message.code === 'EADDRINUSE'
            ? `localhost:${run.preferredPort} is already in use on this computer. Choose another Local port or Auto in the Room, then press Open.`
            : message.code === 'AUTH'
              ? 'The preview could not be authenticated. Press Open in the Room to retry, or choose Public link.'
              : `Couldn't forward the host's localhost:${run.port}. Check the host is connected, then press Open in the Room to retry.`
          if (run.started) {
            run.expired = true
            $.ui.toast(run.error)
            await $.ui.invalidate('ui.render')
          }
        }
      }
      if (buffer.length > 8192) throw new Error('Invalid local preview output')
    }
    const ended = await result
    if (ended?.code === 127) run.error = 'Local previews need Node on this computer. Install Node and press Open in the Room, or choose Public link.'
  } catch (error) {
    if (error instanceof ApiError) run.error = error.status === 429
      ? TCP_BUSY
      : [404, 426, 501].includes(error.status)
        ? 'This server does not support local TCP forwarding. Update the server and host plugin, or choose Public link.'
        : 'Local forwarding is unavailable. Check the host has an updated plugin, Node and a live stream, then press Open, or choose Public link.'
    // Never echo child diagnostics, credentials or a server's untrusted text.
  } finally {
    run.timer?.cancel()
    run.settle(false)
    if (localPreviewRuns.get(pid) === run && !run.stopping) {
      localPreviewRuns.delete(pid)
      if (run.started && !run.expired && run.generation === localPreviewGeneration) $.ui.toast(`Local preview on localhost:${run.localPort} stopped. Press Open in the Room to reconnect.`)
      await $.ui.invalidate('ui.render')
    }
  }
}

async function finishLocalPreview(pid: string, run: LocalPreviewRun) {
  run.timer?.cancel()
  run.settle(false)
  try { await run.child?.return(undefined as never) } catch {}
  if (localPreviewRuns.get(pid) === run) localPreviewRuns.delete(pid)
}

async function stopLocalPreview($: $, pid: string, forget = true) {
  const run = localPreviewRuns.get(pid)
  if (run) {
    run.stopping ??= finishLocalPreview(pid, run)
    await run.stopping
  }
  if (forget) await update($, localPreviewsA, list => localPreviewRuns.has(pid) ? list : list.filter(p => p.pid !== pid))
}

async function stopLocalPreviews($: $) {
  await Promise.all([...localPreviewRuns.keys()].map(pid => stopLocalPreview($, pid)))
  await update($, localPreviewsA, () => [])
}

async function restoreLocalPreviews($: $) {
  if ((await read($, modeA)) !== 'guest') return
  const room = await read($, roomA)
  if (!room) return
  const shown = await read($, shownA)
  for (const preview of await read($, localPreviewsA)) {
    const item = shown.find(s => s.pid === preview.pid) ?? { ...preview, key: preview.pid, kind: 'preview' as const, name: `localhost:${preview.port}`, ts: 0, tcp: true }
    // Only what this guest opened before, and still forwarded.
    if (item.closed || !item.tcp) await stopLocalPreview($, preview.pid)
    else {
      const opened = await ensureLocalPreview($, room, item)
      if (opened.error) $.ui.toast(opened.error)
    }
  }
}

// The public origin is an explicit alternative, never an automatic fallback
// that changes an OAuth callback's origin after a failed localhost bind.
async function openPublicPreview($: $, shown: ShareShown, surface?: RenderSurface) {
  const room = await read($, roomA)
  if (!room || !shown.pid || shown.closed) return
  const url = await previewTicket($, room, shown.pid, shown.path)
  if (!url) return void $.ui.toast('That preview has ended or is not reachable')
  if (inDesktop === undefined) inDesktop = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'
  const opened = inDesktop ? await $.mcp.call('Claude_Browser', 'preview_start', { url }).catch(() => null) : null
  if (!opened || opened.isError) {
    await $.ui.copy({ text: url, surface }).catch(() => {})
    $.ui.toast('Public preview link copied: open it within 10 minutes')
  }
}

// Guest: the Room panel's Open, outside any turn. The Files pane opens from
// a plugin's own call; the browser pane may ask first, or (in auto mode)
// refuse, and then the link is copied instead.
async function openShown($: $, shown: ShareShown, surface?: RenderSurface) {
  const room = await read($, roomA)
  if (!room) return
  if (shown.kind === 'preview' && shown.pid && !shown.tcp) return openPublicPreview($, shown, surface)
  if (shown.kind === 'preview' && shown.pid) {
    if (localPreviewRuns.get(shown.pid)?.channelError === TCP_AUTH) await stopLocalPreview($, shown.pid, false)
    const preview = await ensureLocalPreview($, room, shown)
    if (!preview.url) return void $.ui.toast(preview.error ?? 'That preview could not be opened')
    if (inDesktop === undefined) inDesktop = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'
    const opened = inDesktop ? await $.mcp.call('Claude_Browser', 'preview_start', { url: preview.url }).catch(() => null) : null
    if (!opened || opened.isError) {
      await $.ui.copy({ text: preview.url, surface }).catch(() => {})
      $.ui.toast('Local preview link copied: open it in your browser')
    }
    return
  }
  const path = (await downloadShown($, room, shown.files ?? []))[0] ?? null
  if (!path) return void $.ui.toast("Couldn't get that file")
  // A page opens in the browser pane, where it runs (inside the project).
  if (shown.kind === 'page') {
    if (inDesktop === undefined) inDesktop = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'
    const opened = inDesktop ? await $.mcp.call('Claude_Browser', 'preview_start', { url: `file://${path}` }).catch(() => null) : null
    if (opened && !opened.isError) return
  }
  const result = await desk($, 'ccd_view', 'show_pane', { pane: 'file', path })
  if (result === null) $.ui.log(`Saved to ${path}`)
}

// Host: a guest's browser asked a preview for something. Ask this machine's
// localhost (only ports this session shares) and post the answer back.
async function answerProxy($: $, room: ShareRoom, ask: Record<string, unknown>) {
  const port = Number(ask.port)
  const id = typeof ask.id === 'string' ? ask.id : ''
  const path = typeof ask.path === 'string' && ask.path.startsWith('/') ? ask.path : '/'
  const method = typeof ask.method === 'string' && /^[A-Z]{3,7}$/.test(ask.method) ? ask.method : 'GET'
  const shared = Object.values(await read($, previewsA))
  if (!id || !Number.isInteger(port) || !shared.includes(String(ask.pid ?? ''))) return
  const headers = Array.isArray(ask.headers) ? (ask.headers as unknown[]) : []
  const request = [
    `url = ${cfg(`http://localhost:${port}${path}`)}`,
    `request = ${cfg(method)}`,
    ...headers.filter((h): h is [string, string] => Array.isArray(h) && typeof h[0] === 'string' && typeof h[1] === 'string').map(([k, v]) => `header = ${cfg(`${k}: ${v}`)}`),
  ].join('\n')
  const body = typeof ask.body === 'string' && /^[A-Za-z0-9+/=]*$/.test(ask.body) ? ask.body : ''
  const answer = roomConfig(room, `proxy/${id}`)
  const t1 = fence(request)
  const t2 = fence(answer)
  await sh(
    $,
    [
      'd=$(mktemp -d) || exit 1',
      `trap 'rm -rf "$d"' EXIT`,
      `cat > "$d/req" <<'${t1}'`,
      request,
      t1,
      `printf '%s' ${sq(body)} | base64 --decode > "$d/body" 2>/dev/null || : > "$d/body"`,
      `if [ -s "$d/body" ]; then data="--data-binary @$d/body"; else data=; fi`,
      `status=$(curl -s -K "$d/req" $data -D "$d/h" -o "$d/b" -w '%{http_code}' --max-time 25) || status=502`,
      `[ -f "$d/b" ] || : > "$d/b"; [ -f "$d/h" ] || : > "$d/h"`,
      `hdr=$(base64 < "$d/h" | tr -d '\\n')`,
      `{ cat <<'${t2}'`,
      answer,
      t2,
      `printf 'header = "x-proxy-status: %s"\\nheader = "x-proxy-headers: %s"\\n' "$status" "$hdr"; } > "$d/up"`,
      `curl -K "$d/up" -X POST --data-binary @"$d/b" -o /dev/null`,
      '',
    ].join('\n'),
  )
}

// Host: a guest's browser opened a WebSocket on a preview. A relay (Node, as
// the dev server runs on) opens it on this machine's localhost, only on ports
// this session shares, and one back to the room for it; its settings, token
// included, go on stdin. Without Node, the browser's socket just closes.
const FIND_NODE = [
  'for n in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" $(ls -d "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node "$HOME"/.asdf/installs/nodejs/*/bin/node 2>/dev/null | sort -r); do',
  '  [ -n "$n" ] && [ -x "$n" ] && exec "$n" "$1"',
  'done',
  'echo "Shared session: no node to relay a preview WebSocket" >&2; exit 127',
].join('\n')

async function relaySocket($: $, room: ShareRoom, ask: Record<string, unknown>) {
  const id = typeof ask.id === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(ask.id) ? ask.id : ''
  const port = Number(ask.port)
  const path = typeof ask.path === 'string' && ask.path.startsWith('/') ? ask.path : '/'
  const protocols = (Array.isArray(ask.protocols) ? ask.protocols : []).filter((p): p is string => typeof p === 'string' && /^[\w.-]{1,64}$/.test(p)).slice(0, 4)
  if (!id || !validPort(port) || (await read($, previewsA))[String(port)] !== ask.pid) return
  const config = {
    local: `ws://localhost:${port}${path}`,
    origin: `http://localhost:${port}`,
    protocols,
    room: `${room.server.replace(/^http/, 'ws')}/api/rooms/${room.id}/ws/${id}`,
    token: room.token,
    version: await ownVersion($),
  }
  try {
    const child = $.process.spawn({ argv: ['/bin/sh', '-c', FIND_NODE, 'sh', `${$.plugin.root}/relay/ws-relay.cjs`], input: JSON.stringify(config) })
    for await (const chunk of child) if (chunk.stream === 'stderr') $.ui.log(chunk.text.trim(), { to: 'debug' })
  } catch {}
}

// Host: all raw TCP connections share one supervised Node process. Control
// requests finish at admission; neither a plugin HTTP request nor its stdin
// stays open for the lifetime of an application connection.
function tcpKey(room: ShareRoom, id: string): string {
  return `${room.server}/${room.id}/${id}`
}

function tcpCurrent(run: TcpRelayRun): boolean {
  return tcpAccepting && !run.worker.stopped && tcpWorker === run.worker && run.generation === localPreviewGeneration && !tcpRevoking.has(`${run.generation}/${run.pid}`) && tcpRelays.get(tcpKey(run.worker.room, run.id)) === run
}

async function tcpAllowed($: $, run: TcpRelayRun): Promise<boolean> {
  const room = run.worker.room
  const current = await read($, roomA)
  const previews = await read($, previewsA)
  const ports = await read($, forwardPortsA)
  const mode = await read($, modeA)
  return tcpCurrent(run) && mode === 'host' && current?.id === room.id && current.server === room.server && current.token === room.token && previews[String(run.port)] === run.pid && ports.includes(String(run.port))
}

function finishTcpWorker(worker: TcpWorkerRun): Promise<void> {
  if (worker.stopping) return worker.stopping
  worker.stopped = true
  worker.timer?.cancel()
  worker.settle(false)
  for (const [key, run] of tcpRelays) if (run.worker === worker) tcpRelays.delete(key)
  worker.stopping = (async () => {
    try { await worker.child?.return(undefined as never) } catch {}
    if (tcpWorker === worker) tcpWorker = null
  })()
  return worker.stopping
}

async function runTcpWorker($: $, worker: TcpWorkerRun) {
  try {
    const version = await ownVersion($)
    if (worker.stopped || tcpWorker !== worker || !tcpAccepting || worker.generation !== localPreviewGeneration) return
    const config = { room: `${worker.room.server}/api/rooms/${worker.room.id}`, token: worker.room.token, controlToken: worker.controlToken, version }
    const child = $.process.spawn({ argv: ['/bin/sh', '-c', FIND_NODE, 'sh', `${$.plugin.root}/relay/tcp-worker.cjs`], input: JSON.stringify(config) })
    worker.child = child
    const result = child.result.catch(() => null)
    let buffer = ''
    for await (const chunk of child) {
      if (worker.stopped || tcpWorker !== worker || worker.generation !== localPreviewGeneration) break
      if (chunk.stream !== 'stdout') continue
      buffer += chunk.text
      let i: number
      while ((i = buffer.indexOf('\n')) >= 0) {
        if (i > 8192) throw new Error('Invalid TCP worker output')
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        let message: { state?: string; port?: number; id?: string }
        try { message = JSON.parse(line) } catch { continue }
        if (message?.state === 'ready') {
          if (worker.port || !validPort(message.port)) throw new Error('Invalid TCP worker readiness')
          worker.port = message.port
          worker.timer?.cancel()
          worker.settle(true)
        } else if (message?.state === 'closed' && typeof message.id === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(message.id)) {
          const key = tcpKey(worker.room, message.id)
          if (tcpRelays.get(key)?.worker === worker) tcpRelays.delete(key)
        }
      }
      if (buffer.length > 8192) throw new Error('Invalid TCP worker output')
    }
    await result
  } catch {
    // Owned sockets fail. Only a new independent request may start another
    // worker; no open command or application bytes are replayed.
  } finally {
    await finishTcpWorker(worker)
  }
}

async function tcpControl($: $, worker: TcpWorkerRun, body: Record<string, unknown>, run?: TcpRelayRun): Promise<number> {
  const task = worker.queue.then(async () => {
    if (!(await worker.ready) || worker.stopped || tcpWorker !== worker) return 0
    if (run && (!(await tcpAllowed($, run)) || !tcpCurrent(run))) return 0
    let timeout!: () => void
    const expired = new Promise<null>(done => { timeout = () => done(null) })
    const timer = $.clock.after(2_000, () => {
      void finishTcpWorker(worker)
      timeout()
    })
    try {
      const response = await Promise.race([
        $.http.fetch(`http://127.0.0.1:${worker.port}/`, { method: 'POST', headers: { authorization: `Bearer ${worker.controlToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null),
        expired,
      ])
      if (!response || ![200, 429].includes(response.status)) void finishTcpWorker(worker)
      return !worker.stopped && tcpWorker === worker ? response?.status ?? 0 : 0
    } finally {
      timer.cancel()
    }
  })
  worker.queue = task.then(() => {}, () => {})
  return task
}

// Failures before a worker is ready still get a bounded refusal. Curl is
// already required for the Host's TCP feed; credentials stay on stdin here too.
async function rejectTcp($: $, room: ShareRoom, id: string, code: 'BUSY' | 'CONNECT') {
  const key = tcpKey(room, id)
  if (tcpRejecting.has(key) || tcpRejecting.size >= TCP_RELAYS) return
  tcpRejecting.add(key)
  try {
    const worker = tcpWorker
    if (worker?.port && !worker.stopped && worker.room.id === room.id && worker.room.server === room.server && worker.room.token === room.token) {
      if (await tcpControl($, worker, { op: 'reject', id, code }) === 200) return
    }
    const input = `${roomConfig(room, `ws/${id}/reject`)}\nrequest = "POST"\nheader = "content-type: application/json"\ndata = ${cfg(JSON.stringify({ code }))}\n`
    const child = $.process.spawn({ argv: ['curl', '--silent', '--max-time', '2', '--output', '/dev/null', '--config', '-'], input })
    for await (const _chunk of child) { /* Never log credentials or a server's answer. */ }
  } catch {} finally {
    tcpRejecting.delete(key)
  }
}

async function relayTcp($: $, room: ShareRoom, ask: Record<string, unknown>) {
  const id = typeof ask.id === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(ask.id) ? ask.id : ''
  const pid = typeof ask.pid === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(ask.pid) ? ask.pid : ''
  const port = ask.port
  if (!id || !pid || !validPort(port) || !tcpAccepting) return
  // A drained old stream can still have a notification in its current chunk.
  // Never let it install an unstarted worker for the room that replaced it.
  const generation = localPreviewGeneration
  const current = await read($, roomA)
  const mode = await read($, modeA)
  if (!tcpAccepting || generation !== localPreviewGeneration || mode !== 'host' || current?.id !== room.id || current.server !== room.server || current.token !== room.token) return
  const key = tcpKey(room, id)
  if (tcpRelays.has(key)) return
  if (tcpRelays.size >= TCP_RELAYS) return void rejectTcp($, room, id, 'BUSY')
  let worker = tcpWorker
  if (!worker) {
    let settle!: (ready: boolean) => void
    const ready = new Promise<boolean>(done => { settle = done })
    worker = { room, generation: localPreviewGeneration, controlToken: randomSecret(), ready, settle, queue: Promise.resolve(), started: false, stopped: false }
    tcpWorker = worker
  }
  if (worker.stopped || worker.generation !== localPreviewGeneration || worker.room.id !== room.id || worker.room.server !== room.server || worker.room.token !== room.token) return
  const run: TcpRelayRun = { id, pid, port, generation: localPreviewGeneration, worker }
  tcpRelays.set(key, run) // No await since the capacity check: queued + connecting + active.
  let accepted = false, refused = false
  try {
    if (!(await tcpAllowed($, run)) || !tcpCurrent(run)) return
    if (!worker.started) {
      worker.started = true
      worker.timer = $.clock.after(5_000, () => void finishTcpWorker(worker!))
      void runTcpWorker($, worker)
    }
    const status = await tcpControl($, worker, { op: 'open', id, pid, port }, run)
    accepted = status === 200
    refused = status === 429 // The worker already sent BUSY, not CONNECT.
  } catch {} finally {
    if (!accepted) {
      if (tcpRelays.get(key) === run) tcpRelays.delete(key)
      if (!worker.started && tcpWorker === worker && ![...tcpRelays.values()].some(r => r.worker === worker)) await finishTcpWorker(worker)
      if (!refused && tcpAccepting && run.generation === localPreviewGeneration) void rejectTcp($, room, id, 'CONNECT')
    }
  }
}

async function stopTcpRelays($: $, pid?: string) {
  if (!pid) tcpAccepting = false
  for (const [key, run] of tcpRelays) if (!pid || run.pid === pid) tcpRelays.delete(key)
  const worker = tcpWorker
  if (!worker) return
  if (!pid) return finishTcpWorker(worker)
  if (!worker.started) return
  if (await tcpControl($, worker, { op: 'close-preview', pid }) !== 200) await finishTcpWorker(worker)
}

async function revokeTcpPreview($: $, pid: string) {
  const generation = localPreviewGeneration
  const key = `${generation}/${pid}`
  tcpRevoking.add(key)
  const stopped = stopTcpRelays($, pid)
  try {
    const ports = Object.entries(await read($, previewsA)).filter(([, p]) => p === pid).map(([port]) => port)
    await update($, forwardPortsA, list => generation === localPreviewGeneration ? list.filter(p => !ports.includes(p)) : list)
    await update($, previewsA, map => generation === localPreviewGeneration ? Object.fromEntries(Object.entries(map).filter(([, p]) => p !== pid)) : map)
    await stopped
  } finally {
    tcpRevoking.delete(key)
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

async function leave($: $) {
  const room = await read($, roomA)
  try {
    await deleteRoomCheckpoint($, `${JOINED_KEY}${await $.session.id()}`)
  } catch {}
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
      return a.text === 'timeout' ? `${a.who} lost connection` : `${a.who} left`
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
    void share($, surface, { history }).catch(error => {
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
  const { room, history, fromNow, hostVersion } = joined
  const policy = await read($, policyA)
  return [
    `You joined **${room.host}'s session**${room.team ? ` in ${room.team.name}` : ''}.`,
    policy.prompts === 'watch'
      ? `It's watch-only for now: you see every turn live and can chat with everyone in the **Room**.`
      : `What you type here runs there, on ${room.host}'s machine, and everyone sees the replies live.`,
    `The **Room** (above the prompt, or \`/room\`) shows who's here and has a side chat Claude doesn't read. **Leave** is up there too.${history.length ? ` What happened before you joined follows, ${history.length === 1 ? 'one prompt' : `${history.length} prompts`} with their replies.` : fromNow ? ` ${room.host} shared from that point on, so what came before isn't shown.` : ''}`,
    hostVersion && newerThan(CARDS_FROM, hostVersion)
      ? `\n\n> ${room.host}'s Claude Code runs Shared Sessions ${hostVersion}, so their tool calls show here as text, not cards. Once they update (\`${UPDATE_COMMAND}\`) and restart Claude Code, they show as cards.`
      : '',
  ].join(' ')
}

// Why a link didn't join, in words a person can act on.
function joinFailure(error: unknown, server: string): string {
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
          {named(w.by)}
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
// token, kept in ~/.claude/shared-session/account.json (only this user can
// read it) per server, sent in a header to the server that gave it, never in
// an address or a process's arguments.

type SavedSignIn = { token: string; account: ShareAccount; /** The team Share goes to; null: by link alone; absent: the first team. */ current?: string | null }

async function accountFile($: $): Promise<string | null> {
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude/shared-session/account.json` : null
}

async function readSignIns($: $): Promise<Record<string, SavedSignIn>> {
  const path = await accountFile($)
  if (!path) return {}
  try {
    const data = JSON.parse(await $.fs.read(path)) as { servers?: Record<string, SavedSignIn> }
    return data?.servers && typeof data.servers === 'object' ? data.servers : {}
  } catch {
    return {}
  }
}

async function signInFor($: $, server: string): Promise<SavedSignIn | null> {
  const saved = (await readSignIns($))[server]
  return saved && typeof saved.token === 'string' && saved.account ? saved : null
}

// Written through a shell with a umask, so the file is never readable by
// anyone else, not even for a moment; the token goes on stdin.
async function saveSignIn($: $, server: string, value: SavedSignIn | null) {
  const path = await accountFile($)
  if (!path) return
  const all = await readSignIns($)
  if (value) all[server] = value
  else delete all[server]
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

// The person's own browser (or Claude Desktop, for a claude:// link).
// SHARED_SESSION_NO_BROWSER=1 (the end-to-end test) opens nothing.
async function openExternal($: $, url: string): Promise<boolean> {
  if ((await $.env.get('SHARED_SESSION_NO_BROWSER')) === '1') return false
  const { code } = await sh($, `u=${sq(url)}\nif command -v open >/dev/null 2>&1; then open "$u"\nelif command -v xdg-open >/dev/null 2>&1; then xdg-open "$u" >/dev/null 2>&1 &\nelse exit 1\nfi\n`)
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

// Opens the server's sign-in in the browser with the hash of a secret kept
// here, then asks for the sign-in with that secret every 2 s for ten minutes.
async function startSignIn($: $, provider: string): Promise<string> {
  const server = await serverOf($)
  const verifier = randomSecret()
  const t = await read($, teamsA)
  const invite = t.invite && t.invite.server === server ? `&invite=${encodeURIComponent(t.invite.code)}` : ''
  const url = `${server}/auth/${encodeURIComponent(provider)}/start?login=${await sha256Hex(verifier)}${invite}`
  const run = ++signInRun
  const until = (await $.clock.now()) + 10 * 60_000
  await update($, teamsA, x => ({ ...x, server, signingIn: { provider, url, until }, error: null }))
  await openExternal($, url)
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
  return url
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
        const url = await startSignIn($, provider)
        return { text: `Sign in with ${t.providers.find(p => p.id === provider)?.label ?? provider} in your browser; this session picks it up when you're done. If no browser opened: ${url}` }
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
  try {
    if ((await read($, modeA)) === 'idle' && !choice) {
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
    // Not /share: Claude has its own. Every name here is the plugin's alone.
    await $.command.register({ name: 'share-session', description: 'Share this session (with your team when signed in): /share-session [all | new] [link]' })
    await $.command.register({ name: 'team', description: "Your team's shared sessions, one click to join: /team [signin | create <name> | invite | signout]" })
    await $.command.register({ name: 'invite', description: 'Invite a teammate into this shared session, in their Claude Code: /invite <name>' })
    await $.command.register({ name: 'stop-sharing', description: 'Stop sharing this session, or leave the one you joined' })
    await $.command.register({ name: 'room', description: 'Open the Room: who is here, activity, side chat' })
    await $.command.register({ name: 'share-file', description: 'Show a file to everyone in the shared session: /share-file <path>' })
    await $.command.register({ name: 'share-preview', description: "Let teammates open this machine's localhost: /share-preview <port> [title]" })
    await $.command.register({ name: 'who', description: "Who's in this shared session and what each is doing" })
    // Do this before readUpdates can move the next load to another identity.
    await migrateRoomCheckpoints($).catch(error => $.ui.log(`Couldn't preserve saved shared sessions: ${String((error as Error)?.message ?? error)}`))
    void readUpdates($)
    // Signed in: the team and what's shared with it, for Share and the Team button.
    void serverOf($)
      .then(server => signInFor($, server))
      .then(saved => (saved ? refreshTeams($) : undefined))
      .catch(() => {})
    // This session's room, for the others here (`holdRoom`): kept fresh.
    $.clock.every(60_000, () => {
      void holdRoom($).catch(() => {})
      void repinIfAllowed($).catch(() => {})
    })
    // Invites teammates sent: a look every 10 s at the machine's shared copy.
    $.clock.after(2_000, () => void pollInvites($).catch(() => {}))
    $.clock.every(10_000, () => void pollInvites($).catch(() => {}))
    // …and kept current while this session isn't in one, for the Team button's count.
    $.clock.every(5 * 60_000, () => {
      void (async () => {
        if (teamOpen || !(await read($, teamsA)).account || (await read($, modeA)) !== 'idle') return
        await refreshTeams($)
      })().catch(() => {})
    })
    // Loaded anew (an update in place, a reload): the rows this plugin drew
    // draw again with this code, the room and the transcript as they were.
    $.ui.invalidate('ui.render')
    $.clock.after(3_000, () => void catchUpFromInstalled($))
    $.clock.after(15_000, () => void checkForUpdate($))
    $.clock.every(30 * 60_000, () => void checkForUpdate($))
    // A reload keeps $.state: pick the room back up. A restart doesn't: a
    // host session saved its room when it closed, and takes it up again.
    const room = await read($, roomA)
    if (room && (await read($, modeA)) !== 'idle') startFeed($)
    if (room && (await read($, modeA)) === 'guest') await readyReplay($)
    if (!room) await resumeHosting($).catch(error => $.ui.log(`Couldn't pick the shared session back up: ${String(error?.message ?? error)}`))
    if (!(await read($, roomA))) await resumeJoined($).catch(error => $.ui.log(`Couldn't get back into the shared session: ${String(error?.message ?? error)}`))
    void restoreLocalPreviews($).catch(() => {})
    void holdRoom($).catch(() => {})
    void refreshStatus($).catch(() => {})
    $.clock.after(2_000, () => void repinMarked($).catch(() => {}))
    return started
  })

  on('session.end', async ($, e, next) => {
    await stopTcpRelays($)
    const mode = await read($, modeA)
    // A host session that closes (the app quits, a restart to update) keeps
    // its room for when it comes back; /clear and a logout end it.
    if (mode === 'host') {
      if (e.reason === 'clear' || e.reason === 'logout') await stopSharing($).catch(() => {})
      else await keepHosting($, e.sessionId).catch(error => $.ui.log(`Couldn't save the shared session for reopening: ${String((error as Error)?.message ?? error)}`))
    }
    // A guest's too: still pinned and named, back in the room when reopened.
    if (mode === 'guest') {
      if (e.reason === 'clear' || e.reason === 'logout') await leave($).catch(() => {})
      else await keepJoined($, e.sessionId).catch(error => $.ui.log(`Couldn't save the joined session for reopening: ${String((error as Error)?.message ?? error)}`))
    }
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
    const port = Number(LOCAL_URL.exec(first ?? '')?.[1] ?? first)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { text: 'Which port? /share-preview <port> [title], e.g. /share-preview 3000' }
    const title = rest.join(' ') || `localhost:${port}`
    const pid = await ensurePreview($, room, port, title, true)
    if (!pid) return { text: `Couldn't share localhost:${port}.` }
    send($, 'artifact', { kind: 'preview', pid, port, title, path: '/', tcp: true })
    return { text: `Sharing localhost:${port}. Teammates open it from their Room panel, forwarded to their own localhost; stop it there too.` }
  })

  on('command.run', { command: 'stop-sharing' }, async $ => {
    const mode = await read($, modeA)
    if (mode === 'host') await stopSharing($)
    else if (mode === 'guest') await leave($)
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
        if (mode === 'guest') await leave($)
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
    // The update command, typed here by a guest (the "is out" line names it):
    // run on this computer, never sent to the host's Claude to run there.
    if (mode === 'guest' && UPDATE_TYPED.test(typed)) {
      answerWith({ kind: 'note', text: `Updating Shared Sessions on this computer (this didn't go to ${(await read($, roomA))?.host ?? 'the host'}). A line below says when it's done.`, then: [] })
      void updateHere($)
      return next(e)
    }
    const isMeta = Boolean((e as { isMeta?: true }).isMeta)
    const fromPerson = GUEST_SENDS.has(e.origin.kind) && !isMeta
    // Another of this person's sessions wrote to this one: relayed to the
    // host's Claude as that session's message, if they let it.
    const fromOwn = mode === 'guest' && OWN_SESSIONS.has(e.origin.kind) && !isMeta ? delivered(typed) : null
    if (fromOwn && !(await prefsOf($)).relayPeers) {
      const room = await read($, roomA)
      answerWith({ kind: 'note', text: `A message from **${tidySender(fromOwn.from)}** stayed here: your **Room**'s Settings keep your other sessions' messages from ${room?.host ?? 'the host'}'s Claude.`, then: [] })
      return next(e)
    }
    const relay = fromOwn?.text ? `<cross-session-message from-name="${tidySender(fromOwn.from).replaceAll('"', '’')}">\n${fromOwn.text}\n</cross-session-message>` : null
    if (mode === 'guest' && (fromPerson || relay) && (typed || e.attachments?.length) && !typed.startsWith('/')) {
      const room = await read($, roomA)
      if ((await read($, policyA)).prompts === 'watch') {
        answerWith({
          kind: 'note',
          text: `**${room?.host}** has this session on watch-only, so this didn't go to Claude. You can still follow every turn and talk to everyone in the **Room** panel.`,
          then: [],
        })
        return next(e)
      }
      if ((await read($, peopleA)).some(p => p.role === 'host' && !p.online)) {
        answerWith({
          kind: 'note',
          text: `**${room?.host}**'s Claude Code is closed right now, so this didn't go to Claude. The room stays open and carries on when they're back (the **Room** shows them here again); send it then.`,
          then: [],
        })
        return next(e)
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
      } else send($, 'prompt', { text: relay ?? typed, pid })
    }
    lastActivity = await $.clock.now()
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // From 2.1.300 a subagent's run starts a turn too: not a prompt anyone
    // typed, and its end never clears the host's working line.
    if ((e as { agentId?: string }).agentId !== undefined) return next(e)
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
    const index = pendingGuestPrompts.findIndex(p => e.text.includes(p.framed))
    const guest = index >= 0 ? pendingGuestPrompts.splice(index, 1)[0] : undefined
    const by = guest?.who ?? room?.host ?? 'host'
    const startedAt = await $.clock.now()
    await update($, workingA, () => ({ turnId: e.turnId, by, byGuest: Boolean(guest), startedAt, tail: '', waitingFor: null }))
    // A prompt another session delivered is shown as its text, not its markup.
    const said = typedText(e.text)
    const sent = guest ? null : delivered(said)
    const relayed = guest ? delivered(guest.text) : null
    const guestPrompt = guest ? (relayed ? `(from ${relayed.from}) ${relayed.text}` : guest.text) : undefined
    send($, 'turn', { state: 'start', turnId: e.turnId, by: sent?.from ?? by, prompt: guestPrompt ?? sent?.text ?? (said || startedBy(e.text)), pid: guest?.pid ?? '' })
    void refreshStatus($)
    return next(e)
  })

  // Guest: every turn here plays the shared session back (no model runs), so
  // the person's own Stop hooks (a notifier, a channel bridge) stay out of
  // it: each cost a second or more per replayed turn, told a channel about
  // turns nobody here took, and one could keep a finished ride going.
  on('classic.Stop', async ($, e, next) => ((await read($, modeA)) === 'guest' ? {} : next(e)))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const mode = await read($, modeA)
    if (mode === 'host') {
      lastTurnFor = (await read($, workingA))?.by ?? lastTurnFor
      await update($, workingA, w => (w?.turnId === e.turnId ? null : w))
      send($, 'turn', { state: 'end', turnId: e.turnId, aborted: e.isAborted, durationMs: e.durationMs, reason: e.reason })
      void refreshStatus($)
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
      } else if (ride.kind === 'note') {
        answer = ride.text
        yield { kind: 'text', index: 0, text: answer } satisfies TurnStepChunk
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
    // and let the host turn it was showing play again, whole, after it.
    if ((await read($, modeA)) !== 'guest' || e.agentId !== undefined) return yield* next(e)
    const ride = ridesByTurn.get(e.turnId)
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
    for (const row of rowsFromMessage(stored.message ?? e.message, typed ? host : null, cwd)) {
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
      if (working?.byGuest) {
        const who = working.by
        await update($, ownersA, owners => {
          const entries = Object.entries({ ...owners, [e.tool_use_id]: who })
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
    const working = await read($, workingA)
    if (!working?.byGuest) return verdict
    const policy = await read($, policyA)
    if (policy.approvals === 'none') return verdict
    if (policy.approvals === 'edits' && READ_ONLY.has(e.tool) && readsInside(e.tool, (e.input ?? {}) as Record<string, unknown>, await $.session.cwd())) return verdict
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
        Decline: `Claude is told you declined and carries on without it.`,
      },
    }
    const options = ['Allow once', always, 'Decline']
    let answer = 'Decline'
    const askedAt = await $.clock.now()
    let shown = true
    try {
      answer = await $.ui.ask(`${working.by} wants Claude to run ${what.slice(0, 200)}. Allow it?`, { header: ASK_HEADER, options })
      if (!options.includes(answer)) shown = false // something else answered for it (a settings hook)
    } catch {
      // Dismissed after a look is a no; refused at once, it never showed (a
      // settings hook on AskUserQuestion, a host with no dialog).
      shown = (await $.clock.now()) - askedAt > 1500
    }
    // Asked in the row above the prompt instead, the person's own buttons,
    // when anything draws it (a plain -p run draws nothing: a no, as before).
    if (!shown && (await $.session.surfaces()).length > 0) {
      await update($, approvingA, () => ({ who: working.by, what, always }))
      $.ui.toast(`${working.by} wants Claude to run ${what.slice(0, 80)}: answer above the prompt`)
      nudgeSidebar($)
      answer = await new Promise<string>(resolve => {
        bandAnswer = resolve
        $.clock.after(10 * 60_000, () => resolve('Decline'))
      })
      bandAnswer = null
      await update($, approvingA, () => null)
    }
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
    const who = (await read($, ownersA))[e.props.tool_use_id]
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
          <Box flexShrink={0}>
            {inIt ? (
              <Text color="claude">{mode === 'host' ? 'This session' : "You're in it"}</Text>
            ) : here[s.id] ? (
              <Button key={`open-${s.id}`} label="Open" plain onPress={() => void openHere($, s.id)} />
            ) : canJoin ? (
              <Button key={`join-${s.id}`} label="Join" variant={joinable.length === 1 ? 'primary' : undefined} onPress={press => void joinFromTeam($, [s], press.surface)} />
            ) : mine ? null : (
              <Button key={`join-${s.id}`} label="Join" plain dimColor onPress={press => void joinFromTeam($, [s], press.surface)} />
            )}
          </Box>
        </Box>
      )
    }

    // On top: the team (a picker when you're in several), where shares go,
    // and this session's own place in it.
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
    const { Box, Text, Button } = el
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
          <Box flexDirection="row" marginTop={1}>
            <Button
              key="room-share"
              label="Share this session"
              variant="primary"
              onPress={press => void requestShare($, press.surface).catch(error => $.ui.log(`Couldn't share: ${String(error?.message ?? error)}`))}
            />
          </Box>
        </Box>
      )
    }

    const now = await $.clock.now()
    const activity = await read($, activityA)
    const chat = await read($, chatA)
    const trusted = await read($, trustedA)
    const shown = await read($, shownA)
    const localPreviews = await read($, localPreviewsA)
    const newer = await read($, newerA)
    const updates = await read($, updatesA)
    const colors = roomColors(v.everyone, [...chat.map(c => c.who), ...activity.map(a => a.who)])
    const colorOf = (name: string) => colors.get(name) ?? colorFor(name)
    const people = faces(v, colors)
    const isHost = v.mode === 'host'
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
            {isHost ? `${w.by} is waiting for your OK on ${w.waitingFor}` : `Waiting for ${room.host} to allow ${w.waitingFor}`}
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
        { id: 'settings', label: newer || pinRefused ? 'Settings ●' : 'Settings' },
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
          {[joined && !p.note?.includes('host') ? `joined ${ago(joined, now)}` : '', asked ? `${asked} prompt${asked === 1 ? '' : 's'}` : '', trusted.includes(p.name) ? 'always allowed' : '']
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
        {shown
          .slice(-12)
          .reverse()
          .map(item => {
            const local = localPreviews.find(p => p.pid === item.pid)
            const run = item.pid ? localPreviewRuns.get(item.pid) : undefined
            const active = run?.started && !run.expired && !run.stopping
            const preview = !isHost && item.kind === 'preview' && item.pid && !item.closed && item.tcp
            return (
              <Box key={`shown-${item.key}`} flexDirection="column" gap={1}>
                <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
                  <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
                    <Text color={item.closed ? undefined : 'claude'} dimColor={item.closed}>{shownGlyph(item)}</Text>
                    <Text wrap="truncate-end" dimColor={item.closed}>{`${item.name}${item.closed ? ' · ended' : ''}`}</Text>
                  </Box>
                  <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
                    <Text dimColor>{ago(item.ts, now)}</Text>
                    {!isHost && !item.closed && item.kind !== 'widget' && item.kind !== 'link' ? <Button key={`open-${item.key}`} label="Open" plain onPress={press => void openShown($, item, press.surface)} /> : null}
                    {preview ? <Button key={`public-${item.key}`} label="Public link" plain onPress={press => void openPublicPreview($, item, press.surface)} /> : null}
                    {isHost && item.kind === 'preview' && item.pid && !item.closed && !item.tcp ? <Button key={`forward-${item.key}`} label="Allow forwarding" plain dimColor onPress={() => void allowForwarding($, item)} /> : null}
                    {isHost && item.kind === 'preview' && item.pid && !item.closed ? <Button key={`stop-${item.key}`} label="Stop" plain onPress={() => void stopPreview($, item.pid as string)} /> : null}
                  </Box>
                </Box>
                {preview && local?.localPort ? <Text key={`mapping-${item.key}`} dimColor>{`${active ? '' : 'Last: '}localhost:${local.localPort} → host localhost:${item.port}`}</Text> : null}
                {preview && active && run?.channelError ? <Text key={`connection-${item.key}`} color="warning">{run.channelError}</Text> : null}
                {preview && Input ? (
                  <Box flexDirection="row" gap={1} alignItems="center">
                    <Text dimColor>Local port</Text>
                    <Box flexGrow={1} minWidth={0}>
                      <Input key={`port-${item.key}-${local?.requestedPort ?? 'auto'}`} value={local?.requestedPort ? String(local.requestedPort) : ''} placeholder="Auto" submitLabel="Set" onSubmit={(value: string) => void changeLocalPort($, item, value)} />
                    </Box>
                    {local?.requestedPort ? <Button key={`auto-${item.key}`} label="Auto" plain onPress={() => void changeLocalPort($, item, 'auto')} /> : null}
                  </Box>
                ) : null}
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
    const settingsPage = (
      <Box flexDirection="column" gap={2}>
        {newer ? (
          <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
            <Text color="claude" wrap="truncate-end">
              {updates ? `● Version ${newer} installs by itself; new sessions get it` : `● Version ${newer} is out`}
            </Text>
            {updates ? null : <Button key="copy-update" label="Copy update command" plain onPress={press => void copyText($, UPDATE_COMMAND, 'Update command copied: paste it in a terminal', press.surface)} />}
          </Box>
        ) : null}
        {pinRefused ? (
          <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
            <Box flexShrink={1} minWidth={0}>
              <Text dimColor>Auto mode won't let shared sessions pin themselves in the sidebar.</Text>
            </Box>
            <Button key="allow-pin" label="Allow pinning" plain onPress={() => void allowDeskTools($)} />
          </Box>
        ) : null}
        {isHost ? (
          <Box flexDirection="column" gap={1}>
            {headingOf(el, 'Everyone here', '')}
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
                    onSelect={(value: string) => void setPolicy($, { prompts: value === 'watch' ? 'watch' : 'everyone' })}
                  />,
                )
              : null}
            {Select
              ? settingOf(
                  el,
                  'Ask me before',
                  <Select
                    key="policy-approvals"
                    value={v.policy.approvals}
                    options={[
                      { value: 'edits', label: 'Anything but reading this project' },
                      { value: 'all', label: 'Every tool, reads too' },
                      { value: 'none', label: 'Nothing' },
                    ]}
                    onSelect={(value: string) => void setPolicy($, { approvals: value === 'all' || value === 'none' ? value : 'edits' })}
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
                      { value: 'off', label: 'Stays with me' },
                    ]}
                    onSelect={(value: string) => void setPolicy($, { files: value === 'off' ? 'off' : 'on' })}
                  />,
                )
              : null}
            {trusted.length ? (
              <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
                <Text dimColor wrap="truncate-end">{`Always allowed: ${listNames(trusted)}`}</Text>
                <Button key="untrust" label="Ask again" plain onPress={() => void update($, trustedA, () => [])} />
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
        {isHost ? (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button key="room-stop" label={v.confirming === 'stop' ? 'Stop for everyone' : 'Stop sharing'} variant={v.confirming === 'stop' ? 'primary' : 'secondary'} onPress={() => void confirmStop($)} />
            {v.confirming === 'stop' ? <Text color="error">Press again to end the room. The link stops working.</Text> : null}
          </Box>
        ) : (
          <Box flexDirection="row">
            <Button key="room-leave" label={`Leave ${room.host}'s session`} variant="secondary" onPress={() => void leave($)} />
          </Box>
        )}
      </Box>
    )

    return fit(
      <Box flexDirection="column" gap="lg">
        {header}
        {nowBlock}
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
    const row = (left: RenderChildren, right: RenderChildren) => (
      <Box flexDirection="row" gap={2} alignItems="center" justifyContent="space-between" paddingRight={e.surface === 'terminal' ? 4 : 0}>
        <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0}>
          {left}
        </Box>
        <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
          {right}
        </Box>
      </Box>
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
            <Button key="invite-join" label="Join" variant="primary" onPress={press => void joinInvited($, invite, press.surface).catch(error => $.ui.toast(`Couldn't join: ${String(error?.message ?? error)}`))} />,
            <Button key="invite-dismiss" label="Dismiss" plain dimColor onPress={() => void dropInvite($, invite.room.id)} />,
          ],
        )
      }
      // Quiet when nothing's shared: Share, and Team with how many teammates
      // are live now in Claude's orange.
      const t = await read($, teamsA)
      const me = t.account?.id
      const live = me ? t.sessions.filter(s => s.hostOnline && s.hostAccount !== me && !t.here?.[s.id] && !s.accounts?.includes(me)).length : 0
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
        </Box>
      )
    }

    const colors = roomColors(v.everyone, (await read($, chatA)).map(c => c.who))
    const people = faces(v, colors)
    const isHost = v.mode === 'host'
    const live = v.connection === 'live'
    const stopping = v.confirming === 'stop'
    const approving = await read($, approvingA)

    // A teammate waiting for the host's OK takes the row until it's answered.
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
          </Text>,
        ],
        [
          <Button key="approve-once" label="Allow once" variant="primary" onPress={() => bandAnswer?.('Allow once')} />,
          <Button key="approve-always" label={approving.always} plain onPress={() => bandAnswer?.(approving.always)} />,
          <Button key="approve-no" label="Decline" plain dimColor onPress={() => bandAnswer?.('Decline')} />,
        ],
      )
    }

    const stack = stackSvg(people, { size: 24, max: 5 })
    const roomLabel = v.unread ? `Room · ${v.unread} new` : `Room · ${people.filter(p => p.online).length}`
    // Live: Claude's orange dot, its ring widening; Reconnecting in the warning color.
    const liveMark = (
      <Box key="live" flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
        {live && Svg ? <Svg source={liveSvg()} alt="Live" width={12} height={12} /> : null}
        <Text weight="semibold" color={live ? 'claude' : 'warning'}>
          {live ? (Svg ? 'Live' : '● Live') : '● Reconnecting'}
        </Text>
      </Box>
    )
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
          <Button key="leave" label="Leave" plain dimColor onPress={() => void leave($)} />
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
