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

import type { ShareActivity, ShareChat, ShareFileMeta, ShareMode, SharePerson, SharePolicy, ShareRoom, ShareShown, ShareWorking } from '../types'
import { ACCENT, BAD, GOOD, ROSE, ago, avatarSvg, bannerSvg, labelsFor, stackSvg, toolGlyph } from './look'
import type { Face } from './look'
import { delivered, rowsFromMessage, rowsToMarkdown, splitSpeaker, summarizeTool } from './rows'
import type { Media, RoomImage, Row } from './rows'
import { SERVER_URL } from './server'
import { readsInside } from './paths'

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

const DEFAULT_POLICY: SharePolicy = { prompts: 'everyone', approvals: 'edits', files: 'on' }

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
const sidebarA = atom({ plugin: 'shared-session', key: 'sidebar' } as const, null as { title: string; pinned: boolean; id?: string } | null)
const shownA = atom({ plugin: 'shared-session', key: 'shown' } as const, [] as ShareShown[])
const previewsA = atom({ plugin: 'shared-session', key: 'previews' } as const, {} as Record<string, string>)
const autoOpenA = atom({ plugin: 'shared-session', key: 'autoOpen' } as const, true)
const askingA = atom({ plugin: 'shared-session', key: 'asking' } as const, null as { prompts: number } | null)
const connectionA = atom({ plugin: 'shared-session', key: 'connection' } as const, 'live' as 'live' | 'reconnecting')
const confirmingA = atom({ plugin: 'shared-session', key: 'confirming' } as const, null as 'stop' | null)
const newerA = atom({ plugin: 'shared-session', key: 'newer' } as const, null as string | null)
const pagesA = atom({ plugin: 'shared-session', key: 'pages' } as const, {} as Record<string, Record<string, unknown>>)
const updatesA = atom({ plugin: 'shared-session', key: 'updates' } as const, null as boolean | null)

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
async function selfUpdate($: $, latest: string) {
  if (!runsLive($) || updatingTo === latest || !(await read($, updatesA))) return
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
      '  [ -n "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ] && rmdir "$lock" 2>/dev/null && mkdir "$lock" 2>/dev/null || { echo busy; exit 0; }',
      'fi',
      'tmp=$(mktemp -d) || { rmdir "$lock"; exit 1; }',
      `curl -fsSL --max-time 90 ${sq(url)} -o "$tmp/r.tgz" && tar -xzf "$tmp/r.tgz" -C "$tmp" || { rm -rf "$tmp"; rmdir "$lock"; echo failed; exit 0; }`,
      'pj=$(find "$tmp" -path "*/plugin/.claude-plugin/plugin.json" | head -1); src="${pj%/.claude-plugin/plugin.json}"',
      '[ -n "$pj" ] && [ -f "$src/hooks/register.tsx" ] || { rm -rf "$tmp"; rmdir "$lock"; echo failed; exit 0; }',
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
        'rm -rf "$next"; rmdir "$lock" 2>/dev/null; echo done',
        '',
      ].join('\n'),
    )
  }
  if (!apply) {
    updatingTo = null // try again at the next check
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
  if (!runsLive($)) return
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

// Host: guest prompts submitted and not yet started, oldest first.
const pendingGuestPrompts: { who: string; framed: string; text: string; pid: string }[] = []
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
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.token) headers.authorization = `Bearer ${init.token}`
  const version = await ownVersion($)
  if (version) headers['x-shared-session-version'] = version
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
  scheduleFlush($, type === 'delta' ? 250 : 30)
  if (type !== 'delta') {
    void $.clock.now().then(now => {
      lastActivity = now
    })
    kickPoll($)
  }
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
    if (isGone(error)) outbox = []
    else {
      // Keep what matters and try again; live text is not worth replaying.
      outbox.unshift(...batch.filter(item => item.type !== 'delta'))
      retry = true
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
      `url = "${room.server}/api/rooms/${room.id}/stream?after=${room.seq}"`,
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
      const mode = await read($, modeA)
      await reset($)
      $.ui.log(mode === 'guest' ? `${room.host}'s session is no longer shared.` : 'Sharing ended: the room closed on the server. Press Share to start a new one.')
      return
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
    await setConnection($, 'live')
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
      $.ui.log(mode === 'guest' ? `${room.host}'s session is no longer shared.` : 'Sharing ended: the room closed on the server. Press Share to start a new one.')
      return
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
    case 'preview':
      if (body.state === 'closed' && typeof body.pid === 'string') {
        const pid = body.pid
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
    url: typeof body.url === 'string' ? body.url : undefined,
  }
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
          await acceptPrompt($, event.from.name, body.text, typeof body.pid === 'string' ? body.pid : '')
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

async function reset($: $, opts: { keepSidebar?: boolean } = {}) {
  // The sidebar row first, while the room is still known: the host's title
  // comes back; a guest's says whose session it was.
  const was = await read($, roomA)
  const wasMode = await read($, modeA)
  if (!opts.keepSidebar) await unmarkSidebar($, wasMode === 'guest' && was ? `${was.host}'s session · ${was.title}`.slice(0, 120) : undefined)
  pollGeneration += 1
  stopStream()
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
  await update($, shownA, () => [])
  await update($, previewsA, () => ({}))
  await update($, askingA, () => null)
  await update($, connectionA, () => 'live')
  await update($, confirmingA, () => null)
  bandAnswer?.('Decline')
  await update($, approvingA, () => null)
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
async function desk($: $, server: DeskServer, tool: string, args: Record<string, unknown>) {
  if (inDesktop === undefined) inDesktop = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'
  if (!inDesktop) return null
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
async function setPinned($: $, pinned: boolean) {
  for (const id of [...new Set([selfId, 'self'].filter(Boolean))]) {
    if ((await desk($, 'ccd_sidebar', 'set_pinned', { session_id: id, pinned })) === null) continue
    const after = await sessionInfo($, selfId || 'self')
    if (!after || (after.pinned === true) === pinned) return
  }
  if (pinned) $.ui.log("Shared session: couldn't pin this session in Claude's sidebar. Pin it by hand to keep it at the top.")
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
const unmarked = (title: string) => title.replace(/^(?:👥 [^·]{1,80} · )+/u, '').replace(/^(?:[^·]{1,80}'s session · )+/u, '')

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
const HISTORY_MESSAGES = 6000
type HistoryMessage = { role?: string; content: unknown }
async function sessionHistory($: $): Promise<HistoryMessage[]> {
  try {
    const id = await $.session.id()
    if (/^[\w-]{8,80}$/.test(id)) {
      const found = await sh($, `ls -1 "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${id}.jsonl 2>/dev/null | head -1\n`)
      const path = found.out.trim()
      if (path) {
        const out: { role: string; content: unknown[] }[] = []
        for (const line of (await $.fs.read(path)).split('\n')) {
          if (!line) continue
          let d: { type?: unknown; isSidechain?: unknown; isCompactSummary?: unknown; message?: { role?: unknown; content?: unknown } }
          try {
            d = JSON.parse(line)
          } catch {
            continue
          }
          if ((d.type !== 'user' && d.type !== 'assistant') || d.isSidechain || d.isCompactSummary || !d.message) continue
          const content = typeof d.message.content === 'string' ? [{ type: 'text', text: d.message.content }] : d.message.content
          if (Array.isArray(content)) out.push({ role: String(d.message.role ?? d.type), content })
        }
        if (out.length) return out.slice(-HISTORY_MESSAGES)
      }
    }
  } catch {}
  const held = await $.session.messages({ as: 'api' }).catch(() => [])
  return Array.isArray(held) ? (held as HistoryMessage[]) : []
}

// `history: false` shares only what happens from now on: nothing earlier goes
// out, not even the first prompt as the room's title.
async function share($: $, surface?: RenderSurface, opts: { history?: boolean } = {}): Promise<ShareRoom> {
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
  const title = firstPrompt ? `${folder}: ${(firstPrompt.split('\n')[0] ?? '').slice(0, 80)}` : folder

  const created = await api<{ id: string; url: string; token: string; seq: number; title: string; latest?: string }>(
    $,
    server,
    '/api/rooms',
    { method: 'POST', body: { name, title, fromNow: opts.history === false || undefined } },
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
  $.ui.toast(copied.isCopied ? 'Sharing · link copied' : 'Sharing · the link is in the transcript')
  $.ui.log(
    `Sharing${opts.history === false ? ' from now on' : ''}. Anyone with this link can join and prompt this session: ${room.url}`,
  )
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
  shown: ShareShown[]
  activity: ShareActivity[]
  chat: ShareChat[]
  sidebar: { title: string; pinned: boolean; id?: string } | null
  place?: string
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
  if ((await $.store.get(own)) !== undefined) return { key: own, older: [] }
  const place = await placeOf($)
  if (!place) return { key: null, older: [] }
  const mine: { key: string; at: number }[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(prefix)) continue
    const saved = (await $.store.get(key)) as { at?: unknown; place?: unknown; sidebar?: { id?: unknown } | null } | undefined
    // Places saved before `place` was: the sidebar row's id is the same one.
    if (typeof saved?.at === 'number' && (saved.place ?? saved.sidebar?.id) === place) mine.push({ key, at: saved.at })
  }
  mine.sort((a, b) => b.at - a.at)
  return { key: mine[0]?.key ?? null, older: mine.slice(1).map(m => m.key) }
}

async function keepHosting($: $, sessionId: string) {
  const room = await read($, roomA)
  if (!room) return
  const saved: Hosting = {
    at: await $.clock.now(),
    room,
    policy: await read($, policyA),
    trusted: await read($, trustedA),
    previews: await read($, previewsA),
    shown: (await read($, shownA)).slice(-20),
    activity: (await read($, activityA)).slice(-40),
    chat: (await read($, chatA)).slice(-40),
    sidebar: await read($, sidebarA),
    place: (await placeOf($)) || undefined,
  }
  await $.store.set(`${HOSTING_KEY}${sessionId}`, saved)
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
    activity: (await read($, activityA)).slice(-40),
    chat: (await read($, chatA)).slice(-40),
    sidebar: await read($, sidebarA),
    place: (await placeOf($)) || undefined,
  }
  await $.store.set(`${JOINED_KEY}${sessionId}`, saved)
  stopStream()
  // This process may go on as another session (a /resume): that one isn't in the room.
  await reset($, { keepSidebar: true })
}

async function resumeJoined($: $) {
  const { key, older } = await savedKey($, JOINED_KEY)
  for (const stale of older) await $.store.delete(stale)
  if (!key) return
  const saved = (await $.store.get(key)) as Joined | undefined
  if (!saved?.room?.token || saved.room.seat === 'host') return
  await $.store.delete(key)
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
    const page = await api<EventsPage>($, room.server, `/api/rooms/${room.id}/events?after=${room.seq}&wait=0`, { token: room.token })
    if (page.ended) return void (await over())
    missed = page.events
    people = page.people
    room = { ...room, seq: page.seq }
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 410)) return void (await over())
    if (error instanceof ApiError && error.status === 401) {
      // The seat was let go: a new one, and what happened since the old one's last.
      try {
        const joined = await api<{ token: string; seat: string; seq: number; title: string; history: ServerEvent[]; people: SharePerson[] }>(
          $,
          room.server,
          `/api/rooms/${room.id}/join`,
          { method: 'POST', body: { name: await whoami($) } },
        )
        missed = joined.history.filter(e => e.seq > saved.room.seq)
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
  await update($, activityA, () => saved.activity ?? [])
  await update($, chatA, () => saved.chat ?? [])
  await update($, sidebarA, () => saved.sidebar ?? null)
  await update($, modeA, () => 'guest')
  if (people) await update($, peopleA, () => people)
  await readyReplay($)
  for (const event of missed) await absorb($, room, 'guest', event, false)
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
    await $.store.delete(`${HOSTING_KEY}${await $.session.id()}`)
  } catch {}
}

async function resumeHosting($: $) {
  const id = await $.session.id()
  const now = await $.clock.now()
  // Places saved by sessions that never came back, past any room's life.
  for (const other of await $.store.keys()) {
    if (!(other.startsWith(HOSTING_KEY) || other.startsWith(JOINED_KEY)) || other.endsWith(`:${id}`)) continue
    const at = ((await $.store.get(other)) as Partial<Hosting> | undefined)?.at
    if (typeof at !== 'number' || now - at > HOSTING_KEEP_MS) await $.store.delete(other)
  }
  const found = await savedKey($, HOSTING_KEY)
  // Rooms this Desktop session left before and never took back: over.
  for (const stale of found.older) {
    const left = (await $.store.get(stale)) as Hosting | undefined
    await $.store.delete(stale)
    if (left?.room?.token && left.room.seat === 'host') void api($, left.room.server, `/api/rooms/${left.room.id}/end`, { method: 'POST', token: left.room.token }).catch(() => {})
  }
  if (!found.key) return
  const saved = (await $.store.get(found.key)) as Hosting | undefined
  if (!saved?.room?.token || saved.room.seat !== 'host') return
  await $.store.delete(found.key)
  if (now - saved.at > HOSTING_KEEP_MS) return
  let page: EventsPage | null = null
  try {
    page = await api<EventsPage>($, saved.room.server, `/api/rooms/${saved.room.id}/events?after=${saved.room.seq}&wait=0`, { token: saved.room.token })
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
  await update($, shownA, () => saved.shown ?? [])
  await update($, activityA, () => saved.activity ?? [])
  await update($, chatA, () => saved.chat ?? [])
  await update($, sidebarA, () => saved.sidebar ?? null)
  await update($, modeA, () => 'host')
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
  }
  startFeed($)
  $.ui.log(`Still sharing this session: ${room.url}`)
  // Dev servers this session's Claude opened, running again (or never shared
  // by the version that was running before), open for everyone too.
  void shareLocal($, localOpens(await sessionHistory($))).catch(() => {})
}

async function stopSharing($: $) {
  const room = await read($, roomA)
  await forgetHosting($)
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
    latest?: string
    fromNow?: boolean
    hostVersion?: string
  }>($, server, `/api/rooms/${id}/join`, { method: 'POST', body: { name } })
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
  }
  await update($, roomA, () => room)
  await update($, modeA, () => 'guest')
  await readyReplay($)
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
  // Previews the host still has open open here too, after the history (one
  // shown in the running turn opens as that turn plays out).
  const closed = new Set(joined.history.filter(e => e.type === 'preview' && e.body.state === 'closed').map(e => e.body.pid))
  const open = new Map<string, ServerEvent>()
  for (const e of joined.history) {
    if (e.type !== 'artifact' || e.body.kind !== 'preview' || typeof e.body.pid !== 'string' || closed.has(e.body.pid)) continue
    if (running && e.seq > running.seq) continue
    open.set(e.body.pid, e)
  }
  startFeed($)
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
async function ensurePreview($: $, room: ShareRoom, port: number, title: string): Promise<string | null> {
  const known = (await read($, previewsA))[String(port)]
  if (known) return known
  try {
    const { pid } = await api<{ pid: string }>($, room.server, `/api/rooms/${room.id}/previews`, { method: 'POST', token: room.token, body: { port, title } })
    await update($, previewsA, map => ({ ...map, [String(port)]: pid }))
    return pid
  } catch (error) {
    $.ui.log(`Couldn't share localhost:${port}: ${String((error as Error)?.message ?? error)}`)
    return null
  }
}

async function stopPreview($: $, pid: string) {
  const room = await read($, roomA)
  if (!room) return
  await update($, previewsA, map => Object.fromEntries(Object.entries(map).filter(([, p]) => p !== pid)))
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
    // Something listening is enough: a dev server compiling its first page
    // can take far longer than this to answer, and a refused connection
    // (curl's 7) is the only sign nothing is there.
    const probe = await sh($, `curl -s -o /dev/null --connect-timeout 2 -m 3 http://localhost:${port}/; echo "exit=$?"\n`)
    const exit = /exit=(\d+)/.exec(probe.out)?.[1]
    if (exit === undefined || exit === '6' || exit === '7') {
      mentionedPorts.delete(port) // nothing there yet: a later mention tries again
      continue
    }
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
// mode refuses a plugin's step to the browser pane): a fresh link for a
// preview, where the file is for anything else, and the Room's Open.
async function refusedNote($: $, room: ShareRoom, event: ServerEvent, reason: string): Promise<string> {
  const shown = shownOf(event)
  const why = /auto mode/i.test(reason) ? 'auto mode only opens what you asked for' : 'it was not allowed'
  if (shown?.kind === 'preview' && shown.pid) {
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

// Guest: the Room panel's Open, outside any turn. The Files pane opens from
// a plugin's own call; the browser pane may ask first, or (in auto mode)
// refuse, and then the link is copied instead.
async function openShown($: $, shown: ShareShown, surface?: RenderSurface) {
  const room = await read($, roomA)
  if (!room) return
  if (shown.kind === 'preview' && shown.pid) {
    const url = await previewTicket($, room, shown.pid, shown.path)
    if (!url) return void $.ui.toast('That preview has ended')
    if (inDesktop === undefined) inDesktop = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'
    const opened = inDesktop ? await $.mcp.call('Claude_Browser', 'preview_start', { url }).catch(() => null) : null
    if (!opened || opened.isError) {
      await $.ui.copy({ text: url, surface }).catch(() => {})
      $.ui.toast('Preview link copied: open it within 10 minutes')
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
  if (!id || !Number.isInteger(port) || !Object.values(await read($, previewsA)).includes(String(ask.pid ?? ''))) return
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
    await $.store.delete(`${JOINED_KEY}${await $.session.id()}`)
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

async function openRoom($: $) {
  roomOpen = true
  await update($, unreadA, () => 0)
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
  connection: 'live' | 'reconnecting'
  confirming: 'stop' | null
  asking: { prompts: number } | null
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
    connection: await read($, connectionA),
    confirming: await read($, confirmingA),
    asking: await read($, askingA),
  }
}

// One face per name (a person in two sessions is still one person).
function faces(v: View): Face[] {
  const seen = new Map<string, Face>()
  for (const p of v.everyone) {
    const known = seen.get(p.name)
    const note = [p.role === 'host' ? 'host' : '', p.id === v.me ? 'you' : '', p.online ? '' : 'away'].filter(Boolean).join(' · ')
    const face: Face = { name: p.name, online: p.online || Boolean(known?.online), note, active: v.working?.by === p.name, version: p.version ?? known?.version }
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
  if (v.connection === 'reconnecting') return `↻  Reconnecting to the room… what you send goes out once it's back`
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
    case 'shown':
      return `${a.who}'s Claude showed ${a.text ?? 'something'}`
  }
}

// Share pressed in a session with history: everything earlier would go to
// everyone with the link, so the row (or the Room) asks first.
function shareChoice($: $, el: UI, prompts: number, where: 'band' | 'room', surface: RenderSurface) {
  const { Box, Text, Button } = el
  const go = (history: boolean, surface?: RenderSurface) =>
    void share($, surface, { history }).catch(error => {
      $.ui.toast("Couldn't share")
      $.ui.log(`Couldn't share: ${String(error?.message ?? error)}`)
    })
  return (
    <Box flexDirection="column" gap={where === 'room' ? 1 : 0} paddingRight={where === 'band' && surface === 'terminal' ? 4 : 0}>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text bold>Share this session?</Text>
        <Text dimColor>{`Everyone with the link will see its ${prompts} earlier prompt${prompts === 1 ? '' : 's'} and Claude's replies.`}</Text>
      </Box>
      <Box flexDirection="row" gap={1} justifyContent={where === 'band' ? 'flex-end' : 'flex-start'}>
        <Button key="share-all" label="Share everything" variant="primary" onPress={press => go(true, press.surface)} />
        <Button key="share-new" label="Only from now on" onPress={press => go(false, press.surface)} />
        <Button key="share-cancel" label="Cancel" plain dimColor onPress={() => void update($, askingA, () => null)} />
      </Box>
    </Box>
  )
}

// Why a link didn't join, in words a person can act on.
function joinFailure(error: unknown, server: string): string {
  if (isGone(error)) return "That shared session has ended: the host stopped sharing, or the room expired. Ask them for a new link."
  if (error instanceof ApiError) return `Couldn't join that shared session: ${error.message}`
  return `Couldn't reach the share server at ${server}. Check your connection, then paste the link again.`
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

// ---------------------------------------------------------------------------

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
  const choice = e.args.trim().toLowerCase()
  try {
    if ((await read($, modeA)) === 'idle' && choice !== 'all' && choice !== 'new') {
      const prompts = await earlierPrompts($)
      if (prompts > 0) {
        // The row above the prompt offers the same two, a press away (by keys in a terminal).
        await update($, askingA, () => ({ prompts }))
        return {
          text: [
            `This session has ${prompts} earlier prompt${prompts === 1 ? '' : 's'}. Everyone with the link would see them, and Claude's replies.`,
            '',
            '- `/share-session all` shares the session as it is',
            '- `/share-session new` shares only what happens from now on',
          ].join('\n'),
        }
      }
    }
    const room = await share($, undefined, { history: choice !== 'new' })
    return { text: `Sharing this session${choice === 'new' ? ' from now on' : ''}. Anyone with the link can join: ${room.url}` }
  } catch (error) {
    return { text: `Couldn't share: ${String((error as Error)?.message ?? error)}` }
  }
}

export const register: Register = (on, options) => {
  configuredServer = typeof options.server === 'string' ? options.server : ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Not /share: Claude has its own. Every name here is the plugin's alone.
    await $.command.register({ name: 'share-session', description: 'Share this session with a link: /share-session [all | new]' })
    await $.command.register({ name: 'stop-sharing', description: 'Stop sharing this session, or leave the one you joined' })
    await $.command.register({ name: 'room', description: 'Open the Room: who is here, activity, side chat' })
    await $.command.register({ name: 'share-file', description: 'Show a file to everyone in the shared session: /share-file <path>' })
    await $.command.register({ name: 'share-preview', description: "Let teammates open this machine's localhost: /share-preview <port> [title]" })
    void readUpdates($)
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
    return started
  })

  on('session.end', async ($, e, next) => {
    const mode = await read($, modeA)
    // A host session that closes (the app quits, a restart to update) keeps
    // its room for when it comes back; /clear and a logout end it.
    if (mode === 'host') {
      if (e.reason === 'clear' || e.reason === 'logout') await stopSharing($).catch(() => {})
      else await keepHosting($, e.sessionId).catch(() => {})
    }
    // A guest's too: still pinned and named, back in the room when reopened.
    if (mode === 'guest') {
      if (e.reason === 'clear' || e.reason === 'logout') await leave($).catch(() => {})
      else await keepJoined($, e.sessionId).catch(() => {})
    }
    return next(e)
  })

  // Both names: the markdown fallback (commands/share-session.md) is listed
  // under the plugin-qualified one, and here, where this module loaded, it
  // never reaches the model.
  on('command.run', { command: 'share-session' }, ($, e) => shareCommand($, e))
  on('command.run', { command: 'shared-session:share-session' }, ($, e) => shareCommand($, e))

  on('command.run', { command: 'room' }, async $ => {
    if ((await read($, modeA)) === 'idle') return { text: 'This session is not shared. Press Share above the prompt, or type /share-session.' }
    await openRoom($)
    return { text: 'Opened the Room.' }
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
    const pid = await ensurePreview($, room, port, title)
    if (!pid) return { text: `Couldn't share localhost:${port}.` }
    send($, 'artifact', { kind: 'preview', pid, port, title, path: '/' })
    return { text: `Sharing localhost:${port}. Teammates can open it from their Room panel; stop it there too.` }
  })

  on('command.run', { command: 'stop-sharing' }, async $ => {
    const mode = await read($, modeA)
    if (mode === 'host') await stopSharing($)
    else if (mode === 'guest') await leave($)
    return { text: mode === 'idle' ? 'This session is not shared.' : mode === 'host' ? 'Stopped sharing. The link no longer works.' : 'Left the shared session.' }
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
        const { room, history, open, fromNow, hostVersion } = await join($, link[1], link[2])
        const policy = await read($, policyA)
        answerWith({
          kind: 'note',
          text: [
            `You joined **${room.host}'s session**.`,
            policy.prompts === 'watch'
              ? `It's watch-only for now: you see every turn live and can chat with everyone in the **Room**.`
              : `What you type here runs there, on ${room.host}'s machine, and everyone sees the replies live.`,
            `The **Room** (above the prompt, or \`/room\`) shows who's here and has a side chat Claude doesn't read. **Leave** is up there too.${history.length ? ` What happened before you joined follows, ${history.length === 1 ? 'one prompt' : `${history.length} prompts`} with their replies.` : fromNow ? ` ${room.host} shared from that point on, so what came before isn't shown.` : ''}`,
            hostVersion && newerThan(CARDS_FROM, hostVersion)
              ? `\n\n> ${room.host}'s Claude Code runs Shared Sessions ${hostVersion}, so their tool calls show here as text, not cards. Once they update (\`${UPDATE_COMMAND}\`) and restart Claude Code, they show as cards.`
              : '',
          ].join(' '),
          then: history,
          open,
        })
      } catch (error) {
        answerWith({ kind: 'note', text: joinFailure(error, link[1]), then: [] })
      }
      return next(e)
    }
    // The update command, typed here by a guest (the "is out" line names it):
    // run on this computer, never sent to the host's Claude to run there.
    if (mode === 'guest' && UPDATE_TYPED.test(typed)) {
      answerWith({ kind: 'note', text: `Updating Shared Sessions on this computer (this didn't go to ${(await read($, roomA))?.host ?? 'the host'}). A line below says when it's done.`, then: [] })
      void updateHere($)
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
      // Only what the person typed leaves this machine, never the host app's context.
      send($, 'prompt', { text: typed, pid })
    }
    lastActivity = await $.clock.now()
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
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
      await update($, workingA, w => (w?.turnId === e.turnId ? null : w))
      send($, 'turn', { state: 'end', turnId: e.turnId, aborted: e.isAborted, durationMs: e.durationMs, reason: e.reason })
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
        const refused = run.lastCall ? refusedCalls.get(run.lastCall.id) : undefined
        if (run.lastCall && refused !== undefined) {
          const line = await refusedNote($, room, run.lastCall.event, refused)
          answer += line
          yield { kind: 'text', index: 0, text: line } satisfies TurnStepChunk
        }
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
            const line = `\n\n${replay.label}${replay.note ? ` · ${replay.note}` : ''}\n\n`
            answer += line
            yield { kind: 'text', index: 0, text: line } satisfies TurnStepChunk
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
            const piece = rideStep(ride, state, event, room.host)
            if (piece) {
              answer += piece
              yield { kind: 'text', index: 0, text: piece } satisfies TurnStepChunk
            }
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
          yield { kind: 'tool', index: 1, id, name: call.name } satisfies TurnStepChunk
          yield { kind: 'input', index: 1, json: JSON.stringify(call.input) } satisfies TurnStepChunk
          yield { kind: 'stop', stopReason: 'tool_use', usage: null } satisfies TurnStepChunk
          return { turnId: e.turnId, index: e.index, answer, toolUses: [{ name: call.name, input: call.input }], stopReason: 'tool_use', usage: null }
        }
        // The step after a call ends with something to read: an empty reply
        // makes the engine ask for one more step.
        if (!answer && e.index > 0) {
          answer = 'Opened.'
          yield { kind: 'text', index: 0, text: answer } satisfies TurnStepChunk
        }
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
    for await (const chunk of stream) {
      if (chunk.kind === 'text' && chunk.text) send($, 'delta', { turnId: e.turnId, text: chunk.text })
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
    if (e.agentId !== undefined || (await read($, modeA)) !== 'host') return stored
    const room = await read($, roomA)
    const host = room?.host ?? 'host'
    const fromGuest = e.origin.kind === 'plugin' && 'name' in e.origin && e.origin.name === PLUGIN
    const typed = fromGuest || ['composer', 'sdk', 'bridge', 'unclassified'].includes(e.origin.kind)
    const cwd = await $.session.cwd()
    for (const row of rowsFromMessage(stored.message ?? e.message, typed ? host : null, cwd)) {
      // A guest's prompt reached the model as "Name: text"; show it as theirs.
      const spoken = fromGuest && row.kind === 'user' ? splitSpeaker(row.text) : null
      sendRow($, spoken ? { ...row, who: spoken.who, text: spoken.text } : row)
      if (row.kind === 'assistant' && LOCAL_URL.test(row.text)) void shareLocal($, localPages(row.text))
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
    const result = await next(e)
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
    // A message another session sent them, passed on: its body, and whence it
    // came (its wrapper drawn as markdown would hide the first lines).
    const relayed = delivered(said.text)
    const el = $.ui.resolve(e)
    const { Box, Text, Markdown } = el
    const Svg = svgOf(el, e.surface)
    const avatar = Svg ? <Svg source={avatarSvg({ name: said.who, online: true }, 24)} alt={said.who} width={24} height={24} /> : <Text>●</Text>
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
          <Box flexDirection="column" flexShrink={1}>
            <Box flexDirection="row" gap={1}>
              <Text bold>{said.who}</Text>
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
        <Box flexDirection="column" flexShrink={1}>
          <Text bold>{said.who}</Text>
          <Markdown key="said" text={said.text} />
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

  // The Room: who's here, the side chat, what was shown, what happened, and
  // the settings, in that order; the one button that ends it last. Plain rows
  // in the app's own type, grouped by space, with the meta on the right.
  on('ui.render', { component: 'Pane', requestId: ROOM }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
    const Svg = svgOf(el, e.surface)
    const Input = inputOf(el)
    const Select = selectOf(el)
    const v = await view($)
    const room = v.room
    // A section: its name, what it holds on the right, then its rows.
    const section = (key: string, title: string, meta: string, rows: RenderChildren) => (
      <Box key={key} flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold>{title}</Text>
          {meta ? <Text dimColor>{meta}</Text> : null}
        </Box>
        {rows}
      </Box>
    )
    // A setting: its name in a fixed column, the picker beside it.
    const setting = (label: string, picker: RenderChildren) => (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Box width="40%" flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Box flexGrow={1}>{picker}</Box>
      </Box>
    )

    if (v.mode === 'idle' || !room) {
      if (v.asking) return shareChoice($, el, v.asking.prompts, 'room', e.surface)
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
    const newer = await read($, newerA)
    const updates = await read($, updatesA)
    const people = faces(v)
    // Who runs an older plugin than the newest known: said beside their name.
    const latest = await latestKnown($)
    const behind = (p: Face) => Boolean(p.version && latest && newerThan(latest, p.version))
    const online = people.filter(p => p.online).length
    const isHost = v.mode === 'host'
    const live = v.connection === 'live'
    const updatesSetting = Select
      ? setting(
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
    const updatesNote =
      updates && liveUpdates === 'running'
        ? 'This session updates itself: a release loads in place.'
        : updates && liveUpdates === 'next'
          ? 'From your next new session on, a release loads in place, no restart.'
          : null
    const switchTo = liveUpdates === 'pinned' ? await switchCommand($) : ''
    const updatesRow = switchTo ? (
      <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
        <Box flexShrink={1}>
          <Text dimColor>
            Claude Desktop runs the copy installed from your local marketplace folder, ahead of the one that updates itself, so a release loads only when you quit and reopen it. Add the marketplace from GitHub to update in place.
          </Text>
        </Box>
        <Button key="copy-switch" label="Copy command" plain onPress={press => void copyText($, switchTo, 'Command copied: run it in a terminal, then quit and reopen Claude', press.surface)} />
      </Box>
    ) : updatesNote ? (
      <Text dimColor>{updatesNote}</Text>
    ) : null
    const joinedAt = (name: string) => activity.find(a => a.kind === 'join' && a.who === name)?.ts
    const prompts = (name: string) => activity.filter(a => a.kind === 'prompt' && a.who === name).length
    const detail = live ? `${isHost ? "You're sharing" : `Hosted by ${room.host}`} · ${online} here` : 'Reconnecting to the room…'
    const roles = (p: Face) =>
      [p.note?.includes('host') ? 'Host' : '', p.note?.includes('you') ? 'You' : '', p.online ? '' : 'Away'].filter(Boolean).join(' · ')

    return (
      <Box flexDirection="column" gap={2}>
        <Box flexDirection="column" gap={1}>
          {Svg ? (
            <Svg
              source={bannerSvg({ title: room.title, host: room.host, live, detail, status: 'RECONNECTING' })}
              alt={`${room.title}, hosted by ${room.host}, ${live ? 'live' : 'reconnecting'}`}
            />
          ) : (
            <Box flexDirection="column">
              <Text bold>{room.title}</Text>
              <Text dimColor>{`${live ? '● Live' : '↻ Reconnecting'} · ${detail}`}</Text>
            </Box>
          )}
          <Box flexDirection="row" alignItems="center" gap={1} borderStyle="round" borderDimColor paddingX={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor wrap="truncate-middle">
                {room.url.replace(/^https?:\/\//, '')}
              </Text>
            </Box>
            <Button key="room-copy" label="Copy link" plain onPress={press => void copyLink($, room.url, press.surface)} />
          </Box>
          {isHost ? null : <Text dimColor>{rulesLine(v.policy, room.host)}</Text>}
          {newer ? (
            <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
              <Text dimColor>{updates ? `Version ${newer} installs by itself; new sessions get it` : `Version ${newer} is out`}</Text>
              {updates ? null : <Button key="copy-update" label="Copy update command" plain onPress={press => void copyText($, UPDATE_COMMAND, 'Update command copied: paste it in a terminal', press.surface)} />}
            </Box>
          ) : null}
        </Box>

        {section(
          'people',
          'People',
          `${online} here`,
          <Box flexDirection="column" gap={1}>
            {people.map(p => {
              const joined = joinedAt(p.name)
              const asked = prompts(p.name)
              return (
                <Box key={`person-${p.name}`} flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
                  <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1}>
                    {Svg ? (
                      <Svg source={avatarSvg(p, 24)} alt={p.name} width={24} height={24} />
                    ) : (
                      <Text dimColor={!p.online}>{p.online ? '●' : '○'}</Text>
                    )}
                    <Text bold={p.online} dimColor={!p.online} wrap="truncate-end">
                      {p.name}
                    </Text>
                    {roles(p) ? <Text dimColor>{roles(p)}</Text> : null}
                    {behind(p) ? <Text dimColor>{`on ${p.version}, needs an update`}</Text> : null}
                  </Box>
                  <Text dimColor wrap="truncate-end">
                    {p.active
                      ? v.working?.waitingFor
                        ? 'Waiting for approval'
                        : 'Claude is working'
                      : p.note?.includes('host')
                        ? ''
                        : [joined ? `Joined ${ago(joined, now)}` : '', asked ? `${asked} prompt${asked === 1 ? '' : 's'}` : '', trusted.includes(p.name) ? 'Always allowed' : '']
                            .filter(Boolean)
                            .join(' · ')}
                  </Text>
                </Box>
              )
            })}
            {isHost && people.length <= 1 ? <Text dimColor>No one yet. Send the link to a teammate; it opens in their Claude Code.</Text> : null}
          </Box>,
        )}

        {section(
          'chat',
          'Chat',
          "Claude doesn't read this",
          <Box flexDirection="column" gap={1}>
            {chat.slice(-12).map((c, i) => (
              <Box key={`chat-${c.ts}-${i}`} flexDirection="column">
                <Box flexDirection="row" gap={1} justifyContent="space-between">
                  <Text bold>{c.seat === v.me ? 'You' : c.who}</Text>
                  <Text dimColor>{ago(c.ts, now)}</Text>
                </Box>
                <Text>{c.text}</Text>
              </Box>
            ))}
            {Input ? (
              <Input key={`chat-input-${chat.length}`} placeholder="Message everyone…" submitLabel="Send" onSubmit={(value: string) => void postChat($, value)} />
            ) : (
              <Text dimColor>Chat from Claude Code on desktop or in a terminal.</Text>
            )}
          </Box>,
        )}

        {shown.length
          ? section(
              'shown',
              'Shown',
              isHost ? 'what Claude showed everyone' : `from ${room.host}'s Claude`,
              <Box flexDirection="column">
                {shown
                  .slice(-8)
                  .reverse()
                  .map(item => (
                    <Box key={`shown-${item.key}`} flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
                      <Box flexDirection="row" gap={1} flexShrink={1}>
                        <Text dimColor={item.closed}>{shownGlyph(item)}</Text>
                        <Text wrap="truncate-end" dimColor={item.closed}>{`${item.name}${item.closed ? ' · ended' : ''}`}</Text>
                      </Box>
                      <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
                        <Text dimColor>{ago(item.ts, now)}</Text>
                        {!isHost && !item.closed && item.kind !== 'widget' && item.kind !== 'link' ? (
                          <Button key={`open-${item.key}`} label="Open" plain onPress={press => void openShown($, item, press.surface)} />
                        ) : null}
                        {isHost && item.kind === 'preview' && item.pid && !item.closed ? (
                          <Button key={`stop-${item.key}`} label="Stop" plain onPress={() => void stopPreview($, item.pid as string)} />
                        ) : null}
                      </Box>
                    </Box>
                  ))}
              </Box>,
            )
          : null}

        {activity.length
          ? section(
              'activity',
              'Activity',
              '',
              <Box flexDirection="column">
                {activity
                  .slice(-8)
                  .reverse()
                  .map((a, i) => (
                    <Box key={`act-${a.ts}-${i}`} flexDirection="row" gap={1} justifyContent="space-between">
                      <Box flexDirection="row" gap={1} flexShrink={1}>
                        {a.kind === 'allowed' || a.kind === 'denied' ? (
                          <Text color={a.kind === 'allowed' ? GOOD : BAD}>{a.kind === 'allowed' ? '✓' : '✕'}</Text>
                        ) : (
                          <Text dimColor>{a.kind === 'leave' ? '○' : '●'}</Text>
                        )}
                        <Text wrap="truncate-end">{describe(a)}</Text>
                      </Box>
                      <Box flexShrink={0}>
                        <Text dimColor>{ago(a.ts, now)}</Text>
                      </Box>
                    </Box>
                  ))}
              </Box>,
            )
          : null}

        {isHost
          ? section(
              'settings',
              'Settings',
              'for everyone here',
              <Box flexDirection="column" gap={1}>
                {Select
                  ? setting(
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
                  ? setting(
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
                  ? setting(
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
                {updatesSetting}
                {updatesRow}
                {trusted.length ? (
                  <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
                    <Text dimColor wrap="truncate-end">{`Always allowed: ${listNames(trusted)}`}</Text>
                    <Button key="untrust" label="Ask again" plain onPress={() => void update($, trustedA, () => [])} />
                  </Box>
                ) : null}
              </Box>,
            )
          : section(
              'settings',
              'Settings',
              'just for you',
              <Box flexDirection="column" gap={1}>
                {Select
                  ? setting(
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
                {Select && e.surface === 'terminal'
                  ? setting(
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
                {updatesSetting}
                {updatesRow}
              </Box>,
            )}

        {isHost ? (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button
              key="room-stop"
              label={v.confirming === 'stop' ? 'Stop for everyone' : 'Stop sharing'}
              variant={v.confirming === 'stop' ? 'primary' : 'secondary'}
              onPress={() => void confirmStop($)}
            />
            <Text dimColor>{v.confirming === 'stop' ? 'Press again to end the room. The link stops working.' : ''}</Text>
          </Box>
        ) : (
          <Box flexDirection="row">
            <Button key="room-leave" label={`Leave ${room.host}'s session`} variant="secondary" onPress={() => void leave($)} />
          </Box>
        )}
      </Box>
    )
  })

  // The row above the prompt: the room at a glance, and its buttons.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
    const Svg = svgOf(el, e.surface)
    const v = await view($)

    if (v.mode === 'idle') {
      if (v.asking) return shareChoice($, el, v.asking.prompts, 'band', e.surface)
      return (
        <Box flexDirection="row" justifyContent="flex-end" paddingRight={e.surface === 'terminal' ? 4 : 0}>
          <Button
            key="share"
            label="Share"
            plain
            dimColor
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

    const people = faces(v)
    const live = v.connection === 'live'
    const stack = stackSvg(people, { live, size: 24, max: 6 })
    const status = statusLine(v)
    const here = presence(v)
    const roomLabel = v.unread ? `Room · ${v.unread} new` : `Room · ${people.filter(p => p.online).length}`
    const stopping = v.confirming === 'stop'
    const approving = await read($, approvingA)

    return (
      <Box flexDirection="column" paddingRight={e.surface === 'terminal' ? 4 : 0}>
        <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1}>
            {Svg ? (
              <Svg
                source={stack.source}
                alt={`${live ? 'Live' : 'Reconnecting'} with ${people.map(p => p.name).join(', ')}`}
                width={stack.width}
                height={24}
              />
            ) : (
              // In letters, one live mark: who's here is said in words beside it.
              <Text color={live ? ROSE : undefined} dimColor={!live}>
                {live ? '●' : '↻'}
              </Text>
            )}
            <Text bold>{v.mode === 'host' ? 'Sharing' : `${v.room?.host}'s session`}</Text>
            {here ? (
              <Text dimColor wrap="truncate-end">
                {here}
              </Text>
            ) : null}
          </Box>
          <Box flexDirection="row" gap={1}>
            <Button key="room" label={roomLabel} plain dimColor={!v.unread} onPress={() => void openRoom($)} />
            {v.mode === 'host' && !stopping ? (
              <Button key="copy" label="Copy link" plain dimColor onPress={press => void (v.room ? copyLink($, v.room.url, press.surface) : undefined)} />
            ) : null}
            {v.mode === 'host' ? (
              stopping ? (
                <Button key="stop-sharing" label="Stop for everyone?" variant="primary" onPress={() => void confirmStop($)} />
              ) : (
                <Button key="stop-sharing" label="Stop sharing" plain dimColor onPress={() => void confirmStop($)} />
              )
            ) : (
              <Button key="leave" label="Leave" plain dimColor onPress={() => void leave($)} />
            )}
          </Box>
        </Box>
        {v.mode === 'host' && approving ? (
          <Box flexDirection="column">
            <Text wrap="truncate-end">{`⚠  ${approving.who} wants Claude to run ${approving.what}`}</Text>
            <Box flexDirection="row" gap={1}>
              <Button key="approve-once" label="Allow once" variant="primary" onPress={() => bandAnswer?.('Allow once')} />
              <Button key="approve-always" label={approving.always} plain onPress={() => bandAnswer?.(approving.always)} />
              <Button key="approve-no" label="Decline" plain onPress={() => bandAnswer?.('Decline')} />
            </Box>
          </Box>
        ) : stopping ? (
          <Text dimColor wrap="truncate-end">
            Press again to end the room for everyone. The link stops working.
          </Text>
        ) : status ? (
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
