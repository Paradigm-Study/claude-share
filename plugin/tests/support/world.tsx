// The stand-in world the plugin's UI tests run over: a fixed clock, a fake
// share server, quiet toasts, and the row above the prompt as Claude Desktop
// and the terminal draw it. Shared by tests/*.test.tsx; run them with
// `claude plugin test plugin`, which runs every file at once, each in a
// child of its own: a test that steps the mocked clock many times is slow in
// real time then, and takes `{ timeoutMs: 20_000 }`.

import { expect, mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On, PluginState } from 'claude-code'
import { hostProfileName, profileName } from '../../hooks/window'

// The kit's own timer, in real time, which the mocked clock never moves: for
// what the engine counts in real time (a hook's 10 s budget).
declare const setTimeout: (done: () => void, ms: number) => unknown

export const SURFACES = ['desktop', 'terminal'] as const

export const LINK = 'https://share.test/s/room0000000000000001'

export function band<S extends (typeof SURFACES)[number]>(surface: S) {
  return {
    plugin: 'shared-session',
    surface,
    component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} },
    viewport: { columns: 100, rows: 30 },
  }
}

// Where relay/save.sh was asked to save each file: <project>/.shared-session/<folder>/<name>.
export const savesOf = (spawned: { argv: readonly string[] }[]) =>
  spawned.filter(s => s.argv[1]?.endsWith('/relay/save.sh')).map(s => `${s.argv[2]}/.shared-session/${s.argv[3]}/${s.argv[4]}`)

// Everything beneath the plugin a session would provide, plus a share server
// that answers from memory. Returns what the server was asked. `stream` is
// what the room's stream sends a curl child; without it, curl can't start and
// the plugin polls.
export function world(
  on: On,
  opts: {
    server?: boolean
    stream?: unknown[]
    history?: unknown[]
    down?: boolean
    latest?: string
    /** The share server keeps shared sessions' turns (server/traces), as /api/version says. */
    traces?: boolean
    settings?: string
    hostAway?: boolean
    env?: Record<string, string>
    store?: Record<string, unknown>
    files?: Record<string, string>
    people?: { id: string; name: string; role: string; online: boolean; version?: string }[]
    /** Transcript files by path: the shell's ls, cat/head | tac | grep, and grep -l over them. */
    transcripts?: Record<string, string>
    /** Waited for as the session's transcript is looked for (earlier prompts counted, a history read). */
    beforeHistory?: () => Promise<void>
    /** The share server's teams: signed in (account.json), its sessions, a join it refuses. */
    team?: { signedIn?: boolean; sessions?: unknown[]; refuseJoin?: boolean; access?: 'members' | 'link'; providers?: { id: string; label: string }[] }
    /** Sessions teammates invited this person to. */
    invites?: unknown[]
    /** The room's history comes in pages: the join's first, then events after it; `failRest` fails the second. */
    paged?: { failRest?: boolean }
    /** This session's Claude Code id. */
    sessionId?: string
    /** The host's name as the room's join answer gives it. */
    hostName?: string
    /** The first this many stream connections are refused (401): the room let the seat go. */
    streamRefuses?: number
    /** The next posts of events are refused (401), as many as `count`, set any time: the room let the seat go. */
    eventsRefused?: { count: number }
    /** Holds each join after the first, its answer made as it arrived (what's shared then), until it resolves. */
    joinHold?: () => Promise<void>
    /** This seat's person left the room from elsewhere (the Team panel's Leave): reading its events is answered 410, left. */
    leftElsewhere?: boolean
    /** Events the room takes as too large: a post holding one is refused (413) and nothing of it is taken, as for a guest's event past 128 KB. */
    tooLarge?: (event: { type: string; body: Record<string, unknown> }) => boolean
    /** The room's cloud host: a server without containers (`refuse`), Bring home with changes, what the clipboard holds, a bundle the runner didn't take. */
    cloud?: { refuse?: boolean; changes?: boolean; clipboard?: string; bundleStatus?: string; apply?: 'clean' | 'conflict' }
    /** The guest's localhost helper, without starting a real listener. */
    localPreview?: 'wait' | 'busy' | 'missing'
    localPreviewPort?: number
    // `taken`: ports in use here; an exact request for one fails, a flexible one moves to `port`.
    // `denied`: ports the system refuses to bind (EACCES, EPERM); an exact request fails DENIED, a flexible one moves.
    localPreviewByPid?: Record<string, { mode?: 'wait' | 'busy' | 'missing'; port?: number; ipv6?: boolean; taken?: number[]; denied?: number[] }>
    /** The next stream connections are refused (401), as many as `count`, set any time: the room let the seat go. */
    streamRefusals?: { count: number }
    /** The next browser detections fail (the shell itself), as many as `count`. */
    detectFails?: { count: number }
    /** Holds each browser detection until it resolves. */
    detectWait?: Promise<void>
    /** Sees each of the plugin's state writes before it lands: it may hold the write, or say what's written instead. */
    beforeSet?: (key: string, value: unknown) => Promise<{ value: unknown } | void> | { value: unknown } | void
    /** Before a local-preview helper says anything: it may hold its start, or fail it (it exits 1, saying nothing). */
    beforeHelper?: (pid: string, config: Record<string, unknown>) => Promise<void> | void
    /** A new pid after the old preview on the same port closed. */
    replacementPreviewPid?: string
    tcpRelays?: boolean
    /** The host's TCP worker: `wait` holds its ready line; `missing`, no Node to run it (exit 127). */
    tcpWorker?: 'wait' | 'missing'
    /** Holds each TCP worker's exit, once it's told to end, until it resolves. */
    tcpWorkerExit?: Promise<void>
    /** While `now`, the room won't make a preview forwarded (POST previews with `tcp` answers 503). */
    refuseForward?: { now: boolean }
    tcpControl?: 'wait' | 'busy'
    /** What the TCP worker answers an open with instead (400, 403, 413, 503: what it won't take, or full). */
    tcpControlStatus?: number
    /** A browser for preview windows: what the detection script prints (absent: an unsupported platform, no browser). */
    // `gecko`: the Firefox version its files say (null: none read); Chrome-like paths say Chromium.
    // `isDefault`: the person's default browser (macOS); `others`: more found after it, in order.
    browser?: {
      platform?: string
      path?: string | null
      gecko?: number | null
      isDefault?: boolean
      others?: { path: string; gecko?: number | null; isDefault?: boolean }[]
    }
    /** The window's proxy (relay/browser-proxy.mts): ports it finds taken, Node missing, the port it picks. */
    proxyBusy?: number[]
    proxyMissing?: boolean
    proxyPort?: number
    /** What the host's discovery prints, by the shared port. */
    discover?: Record<number, unknown>
    /**
     * Who holds each port, as discovery's owner mode says (changed live):
     * `true`, one of the plugin's helpers (a guest's listener for another
     * session's preview); `false`, something else. A port not named: nothing
     * holds it. Absent: owner mode prints nothing (it can't tell).
     */
    holders?: Record<number, boolean>
    /**
     * What a look at each port's `/` prints (`lookAtPage`'s `exit=`,
     * `code=…` and, after `--`, `/json/version`'s answer), or at one page of
     * it (keyed `port/path`). A port not named: 3340 is a dev server still
     * compiling (curl's 28), 5432 a database (an empty reply), anything else
     * refused.
     */
    pages?: Record<string, string>
    /**
     * Links on the host's disk, each path to where it points, for the look
     * at where a guest's read really goes (`readsInsideReally`). Every other
     * path is its own real path.
     */
    links?: Record<string, string>
    /** The share server's answer to a preview window's need. */
    need?: 'delivered' | 'undelivered' | 'shared'
    /** Where the session draws; the host's questions need one. */
    surfaces?: string[]
    /** What `scutil --proxy` prints. */
    scutil?: string
    /** A preview window already open on a profile, started with this proxy port (Chrome, unless said). */
    windowOpen?: { profile: string; port: number; family?: 'chromium' | 'firefox' }
    /** The window is still there after it was closed (a slow quit). */
    windowLingers?: boolean
    /** A D-Bus session socket exists under XDG_RUNTIME_DIR. */
    busSocket?: boolean
    /** Writing a Firefox profile's settings fails. */
    firefoxSettingsFail?: boolean
    /** The browser doesn't start. */
    launchFails?: boolean
    /** A saved place comes back to a room that's gone. */
    roomGone?: boolean
    /** With roomGone: the room is still shared (this seat left it from elsewhere). */
    leftHere?: boolean
    /** That one room is gone (its events answer 410); others are as ever. */
    goneRoom?: string
    /** That one room let this seat go: its events answer 401. */
    seatGone?: string
    /** What the room had already when this guest joined. */
    joinHistory?: { seq: number; type: string; body: Record<string, unknown> }[]
    /** The browser reports a start, and no window ever holds the profile. */
    launchNoWindow?: boolean
    /** Holds a browser start until it resolves. */
    beforeLaunch?: () => Promise<void>
    /** Holds writing what a browser reads as it starts (Chrome's preferences, Firefox's user.js) until it resolves. */
    beforeSettings?: () => Promise<void>
    /** The next lock probes fail (the shell itself), as many as `count`. */
    lockFails?: { count: number }
    /** The next lock probes never answer (a look stuck in lsof), as many as `count`, until `release`. */
    lockHangs?: { count: number; release: Promise<void> }
    /** Another session of this person's holds a host profile's launch lock: the next tries to take it find it held, as many as `count`. */
    launchLockHeld?: { count: number }
    /** The window's proxy can't take the person's own proxy: it starts without it and says so, after it's ready (`upstream`), as many times as this. */
    proxyRefusesUpstream?: number
    /** The next routes posts to the window's proxy fail, as many as `count`. */
    /** The next routes posts to the window's proxy answered `status` (503 unless said), as many as `count`. */
    routesFail?: { count: number; status?: number }
    /** Holds the window proxy's ready line until it resolves. */
    proxyHold?: Promise<void>
    /** The need post's status instead of an answer (429, 503), and a hold before it answers. */
    needStatus?: number
    needWait?: Promise<void>
    /** Holds each discovery until it resolves. */
    discoverWait?: () => Promise<void>
    /** Holds making a preview window's profile until it resolves. */
    beforeProfile?: () => Promise<void>
    /** Holds each read of the room's events (GET events: a place taken back asks it first) until it resolves. */
    beforeEvents?: () => Promise<void>
    /** Holds making a room (POST /api/rooms) until it resolves; `createStatus`: the room's making refused so (429: too many from this network). */
    beforeCreate?: () => Promise<void>
    createStatus?: number
    /** Holds each telling a room this session is out of it (POST its end, or a Leave) until it resolves. */
    beforeTell?: () => Promise<void>
    /** Joins of these rooms refused with that status (410: no longer shared). */
    joinStatus?: Record<string, number>
    /** `sleep` takes its time for real, as on a machine, a hook's budget stopped the while; else it fails, and a nap waits on the clock. */
    realSleep?: boolean
    /** Prompts a hook drops as they're submitted (`{ drop }`): never entered, nor counted in `submitted`. */
    dropPrompts?: string[]
    /** Holds each close of the preview window until it resolves; `wait`: one that waits for the window to go. */
    beforeKill?: (wait: boolean) => Promise<void>
    /** The host's fetch for the public link (answerProxy's first step): how it ended, the status and headers curl got, a hold before it ends. */
    proxyFetch?: { exit?: number; status?: number; headers?: string; hold?: Promise<void> }
    /**
     * The public link's WebSocket relays (relay/ws-relay.mts) stay up until
     * stopped; `missing`: no Node to run them. As the relay fails: `connect`,
     * its dev server never took the socket (exit 1); `invalid`, settings it
     * refused (exit 1); `ended`, the socket came and went (exit 0).
     */
    wsRelays?: true | 'missing' | 'connect' | 'invalid' | 'ended'
    /** The next preview ends the host posts answer 503, as many as `count`: the room didn't hear the Stop. */
    endFail?: { count: number }
    /** Holds each preview end the host posts (by its pid) until it resolves. */
    beforeEnd?: (pid: string) => Promise<void> | void
    /** What a poll of the room's events reads: the first of these pages past its `after`, else nothing new. */
    polled?: unknown[]
    /**
     * What the room shares now, as the join answer and every page list it
     * (`previews`, read as each is sent).
     * Absent: what the pages served so far opened (an artifact of a preview,
     * an `open` event), forwarded once one said so, less those closed since.
     */
    roomList?: { previews: { pid: string; port: number; tcp: boolean; title?: string }[] }
    /** While this resolves, a stream opened again (a reload's, a reconnect's) sends nothing: a room slow to answer. */
    streamHeld?: () => Promise<void>
    /** The ids new rooms get, in turn; then `room0000000000000002`, every time. */
    roomIds?: string[]
    /** What the room answers a POST peer (`{ delivered: true }` unless said), or the status it refuses it with (429, 410…). */
    peerAnswer?: Record<string, unknown> | number
    /** The host's mailboxes' helper: no Node to run it, a system it can't run on, or what its commands answer (200 unless said). */
    mailbox?: 'missing' | 'unsupported' | { open?: number; deliver?: number; receipt?: number }
    /** `$.session.send` refuses, so (the session it went to is gone). */
    peerSendRefused?: string
    /** The room's stream held open, as the server keeps it: each line goes out once, as it's pushed (`liveLines`). */
    live?: LiveLines
  } = {},
) {
  const asked: string[] = []
  const state: Partial<PluginState['shared-session']> = {}
  on('state.set', async ($, e, next) => {
    const instead = opts.beforeSet && e.plugin === 'shared-session' ? await opts.beforeSet(e.key, e.value) : undefined
    const written = instead ? ({ ...e, value: instead.value } as typeof e) : e
    const result = await next(written)
    if ('value' in result && result.value?.isSet && e.plugin === 'shared-session') Object.assign(state, { [e.key]: written.value })
    return result
  })
  const spawned: { argv: readonly string[]; input?: string }[] = []
  const checkpointWrites = { fail: false }
  let refusedStreams = 0
  let joins = 0
  const localHelpers: {
    pid?: string
    send: (message: { state: string; code?: string; port?: number; id?: string; ipv6?: boolean }) => void
    output: (text: string) => void
    exit: () => void
    stopped: boolean
  }[] = []
  const standalone = new Map<string, { port: number; tcp: boolean }>()
  const previews = new Map<number, string>()
  const rememberPreviews = (page: unknown) => {
    const events = (page as { events?: { type: string; body: Record<string, unknown> }[] })?.events ?? []
    for (const event of events) {
      const b = event.body
      if (event.type === 'artifact' && b.kind === 'preview' && typeof b.pid === 'string' && typeof b.port === 'number') {
        previews.set(b.port, b.pid)
        standalone.set(b.pid, { port: b.port, tcp: b.tcp === true })
      } else if (event.type === 'preview' && typeof b.pid === 'string' && b.state === 'open' && typeof b.port === 'number') {
        standalone.set(b.pid, { port: b.port, tcp: b.tcp === true })
      } else if (event.type === 'preview' && typeof b.pid === 'string' && b.state === 'closed') standalone.delete(b.pid)
    }
  }
  for (const page of opts.stream ?? []) rememberPreviews(page)
  if (opts.joinHistory) rememberPreviews({ events: opts.joinHistory })
  // What the room lists as shared on each page it sends (see `roomList`).
  const sharedNow = new Map<string, { pid: string; port: number; tcp: boolean; title?: string }>()
  const endedPids = new Set<string>()
  const served = (page: unknown) => {
    for (const event of (page as { events?: { type: string; body: Record<string, unknown> }[] })?.events ?? []) {
      const b = event.body,
        pid = b?.pid
      if (typeof pid !== 'string') continue
      if (event.type === 'preview' && b.state === 'closed') {
        sharedNow.delete(pid)
        endedPids.add(pid)
      } else if (
        ((event.type === 'artifact' && b.kind === 'preview') || (event.type === 'preview' && b.state === 'open')) &&
        typeof b.port === 'number' &&
        !endedPids.has(pid)
      ) {
        const title = typeof b.title === 'string' && b.title ? { title: b.title } : {}
        sharedNow.set(pid, { pid, port: b.port, tcp: sharedNow.get(pid)?.tcp === true || b.tcp === true, ...title })
      }
    }
  }
  const listed = () => (opts.roomList ? [...opts.roomList.previews] : [...sharedNow.values()])
  // A page as the room sends it: what's shared now beside its events.
  const withList = (page: unknown) => {
    served(page)
    const p = page as { events?: unknown; previews?: unknown } | null
    return p && typeof p === 'object' && Array.isArray(p.events) && !('previews' in p) ? { ...p, previews: listed() } : page
  }
  const tcpHelpers: typeof localHelpers = []
  // The host's mailboxes' helpers (started detached: their launchers are
  // gone once they're ready): their settings, pids, the commands they took,
  // and whether they're still running. What a guest wrote into another
  // session (receipt.mts), and the helpers ended by their pid.
  const mailboxes: { config: Record<string, unknown>; pid: number; commands: Record<string, unknown>[]; alive: boolean }[] = []
  const receipts: Record<string, unknown>[] = []
  const killed: number[] = []
  const tcpControls = new Map<string, { helper: (typeof localHelpers)[number]; peers: Map<string, string> }>()
  const blockedControls: { token: string; release: (status?: number) => void }[] = []
  // Preview windows: the browser's one window (its profile and proxy port),
  // the browsers started, the window proxies and what discovery was asked.
  const windowState = {
    alive: Boolean(opts.windowOpen),
    profile: opts.windowOpen?.profile,
    port: opts.windowOpen?.port,
    family: opts.windowOpen?.family ?? ('chromium' as 'chromium' | 'firefox'),
    kills: 0,
  }
  // What each Firefox profile's user.js was last written with.
  const firefoxSettings = new Map<string, { port: number; text: string }>()
  // For each start: whether a window was already open on its profile (it then took the address).
  const startsAlive: boolean[] = []
  const launches: string[][] = []
  const proxies: {
    config: { port: number; controlToken: string; lan?: boolean; upstream: unknown }
    send: (message: Record<string, unknown>) => void
    output: (text: string) => void
    exit: () => void
    stopped: boolean
    routes: { routes: Record<string, number>; startable: number[] }[]
    posts: number
  }[] = []
  const discovered: { port: number; pluginRoot: string; exclude: number[]; deadlineMs?: number }[] = []
  // Owner-mode looks (who holds a port), apart from discovery's.
  const owners: { port: number; pluginRoot: string; owner: true; deadlineMs?: number; web?: true }[] = []
  const needLooks: typeof owners = []
  // What auto-sharing looked at (`lookAtPage`): `port/path` each time.
  const looks: string[] = []
  // The public link: the host's fetches (their scripts, and whether a Stop
  // ended them) and its WebSocket relays (their settings).
  const proxyFetches: { input: string; stopped: boolean }[] = []
  const wsRelays: { config: Record<string, unknown>; stopped: boolean }[] = []
  if (opts.surfaces) on('session.surfaces', () => ({ value: opts.surfaces as never }))
  on('process.spawn', async function* ($, e, next) {
    spawned.push({ argv: e.argv, input: e.input })
    if (e.argv.at(-1)?.endsWith('/relay/mailbox.mts')) {
      if (opts.mailbox === 'missing') return { value: { code: 127, signal: null } }
      if (opts.mailbox === 'unsupported') {
        yield { stream: 'stdout' as const, text: '{"state":"error","code":"UNSUPPORTED"}\n' }
        return { value: { code: 1, signal: null } }
      }
      const helper = { config: JSON.parse(e.input!), pid: 4321 + mailboxes.length, commands: [] as Record<string, unknown>[], alive: true }
      mailboxes.push(helper)
      yield { stream: 'stdout' as const, text: `${JSON.stringify({ state: 'ready', port: 43555, pid: helper.pid })}\n` }
      return { value: { code: 0, signal: null } }
    }
    if (e.argv.at(-1)?.endsWith('/relay/receipt.mts')) {
      receipts.push(JSON.parse(e.input!))
      yield { stream: 'stdout' as const, text: '{"state":"sent"}\n' }
      return { value: { code: 0, signal: null } }
    }
    if (e.argv[0] === '/bin/sh' && e.input === 'uname -s\n') {
      yield { stream: 'stdout' as const, text: `${opts.env?.UNAME ?? 'Darwin'}\n` }
      return { value: { code: 0, signal: null } }
    }
    const killing = /ps -o command= -p (\d+)/.exec(e.input ?? '')
    if (e.argv[0] === '/bin/sh' && killing) {
      const helper = mailboxes.find(m => m.pid === Number(killing[1]))
      if (helper) helper.alive = false
      killed.push(Number(killing[1]))
      return { value: { code: 0, signal: null } }
    }
    // This session's transcript, its newest lines that came from another session.
    const tail = /^tail -n \d+ '([^']+)' \| grep -F '"kind":"peer"'\n$/.exec(e.input ?? '')
    if (e.argv[0] === '/bin/sh' && tail) {
      const lines = (opts.transcripts?.[tail[1]!] ?? '').split('\n').filter(l => l.includes('"kind":"peer"'))
      if (lines.length) yield { stream: 'stdout' as const, text: `${lines.join('\n')}\n` }
      return { value: { code: 0, signal: null } }
    }
    if (e.argv.at(-1)?.endsWith('/relay/browser-proxy.mts')) {
      const config = JSON.parse(e.input!)
      if (opts.proxyMissing) return { value: { code: 127, signal: null } }
      if (config.port && opts.proxyBusy?.includes(config.port)) {
        yield { stream: 'stdout' as const, text: '{"state":"error","code":"EADDRINUSE"}\n' }
        return { value: { code: 1, signal: null } }
      }
      const queue = [
        `${JSON.stringify({ state: 'ready', port: config.port || opts.proxyPort || 47100, control: 47001 })}\n`,
        ...Array.from({ length: opts.proxyRefusesUpstream ?? 0 }, () => '{"state":"upstream","reason":"INVALID_UPSTREAM"}\n'),
      ]
      let ended = false
      let wake: (() => void) | undefined
      const proxy = {
        config,
        send: (message: Record<string, unknown>) => {
          queue.push(`${JSON.stringify(message)}\n`)
          wake?.()
        },
        output: (text: string) => {
          queue.push(text)
          wake?.()
        },
        exit: () => {
          ended = true
          wake?.()
        },
        stopped: false,
        routes: [] as { routes: Record<string, number>; startable: number[] }[],
        posts: 0,
      }
      proxies.push(proxy)
      next.signal.addEventListener('abort', proxy.exit, { once: true })
      try {
        if (opts.proxyHold) await opts.proxyHold
        while (!ended && !next.signal.aborted) {
          const line = queue.shift()
          if (line) yield { stream: 'stdout' as const, text: line }
          else
            await new Promise<void>(done => {
              wake = done
            })
        }
      } finally {
        proxy.stopped = true
        next.signal.removeEventListener('abort', proxy.exit)
      }
      return { value: { code: 0, signal: null } }
    }
    if (e.argv.at(-1)?.endsWith('/relay/discover.mts') && JSON.parse(e.input!).owner === true) {
      const config = JSON.parse(e.input!)
      owners.push(config)
      // A guest's need's look (`web`): the port as discovery would find it, and who holds it.
      if (config.web === true) {
        needLooks.push(config)
        const found = (opts.discover?.[config.port] as { target?: { label: string; web: string; devtools: boolean } | null } | undefined)?.target
        const held = opts.holders?.[config.port]
        const target = found
          ? { port: config.port, label: found.label, relay: held ?? false, web: found.web, devtools: found.devtools }
          : held === undefined
            ? null
            : { port: config.port, label: held ? 'local-preview.mts' : 'next-server', relay: held, web: 'no', devtools: false }
        yield { stream: 'stdout' as const, text: `${JSON.stringify({ state: 'done', platform: 'darwin', target, related: [] })}\n` }
        return { value: { code: 0, signal: null } }
      }
      if (!opts.holders) return { value: { code: 0, signal: null } }
      const held = opts.holders[config.port]
      const target = held === undefined ? null : { port: config.port, label: held ? 'local-preview.mts' : 'next-server', relay: held }
      yield { stream: 'stdout' as const, text: `${JSON.stringify({ state: 'done', platform: 'darwin', target, related: [] })}\n` }
      return { value: { code: 0, signal: null } }
    }
    if (e.argv.at(-1)?.endsWith('/relay/discover.mts')) {
      const config = JSON.parse(e.input!)
      discovered.push(config)
      await opts.discoverWait?.()
      const found = opts.discover?.[config.port]
      if (found) yield { stream: 'stdout' as const, text: `${JSON.stringify(found)}\n` }
      return { value: { code: 0, signal: null } }
    }
    // The window's shell probes, each named on its first line.
    if (e.argv[0] === '/bin/sh' && e.input?.startsWith('# shared-session: ')) {
      const input = e.input
      const named = /(?:^|; )p='([^']*)'|^held '([^']*)'$/m.exec(input)
      const profile = named?.[1] ?? named?.[2]
      const mine = windowState.alive && profile === windowState.profile
      if (input.startsWith('# shared-session: is there a session bus')) return { value: { code: opts.busSocket ? 0 : 1, signal: null } }
      if (input.startsWith('# shared-session: is the preview window open') && opts.lockFails?.count) {
        opts.lockFails.count -= 1
        return { value: { code: 1, signal: null } }
      }
      if (input.startsWith('# shared-session: is the preview window open') && opts.lockHangs?.count) {
        opts.lockHangs.count -= 1
        await opts.lockHangs.release
        return { value: { code: 1, signal: null } }
      }
      if (input.startsWith('# shared-session: take a preview profile') && opts.launchLockHeld?.count) {
        opts.launchLockHeld.count -= 1
        return { value: { code: 3, signal: null } }
      }
      if (input.startsWith('# shared-session: find a browser') && opts.detectFails?.count) {
        opts.detectFails.count -= 1
        return { value: { code: 1, signal: null } }
      }
      if (input.startsWith('# shared-session: chrome preferences') || input.startsWith('# shared-session: settings for a preview window'))
        await opts.beforeSettings?.()
      if (input.startsWith('# shared-session: settings for a preview window')) {
        const dir = /^f='([^']*)\/firefox'$/m.exec(input)?.[1]
        const port = Number(/user_pref\("network\.proxy\.socks_port", (\d+)\);/.exec(input)?.[1])
        if (opts.firefoxSettingsFail) return { value: { code: 1, signal: null } }
        if (dir) firefoxSettings.set(dir, { port, text: input })
      } else if (input.startsWith('# shared-session: find a browser') && opts.browser) {
        await opts.detectWait
        const found = [
          ...(opts.browser.path ? [opts.browser as { path: string; gecko?: number | null; isDefault?: boolean }] : []),
          ...(opts.browser.others ?? []),
        ]
        const lines = found.map(({ path, gecko: given, isDefault }) => {
          const gecko = given === undefined ? (/firefox/i.test(path) ? 158 : undefined) : given
          const kind = gecko ? `gecko=${gecko}\n` : /chrom|edge|brave/i.test(path) ? 'chromium=1\n' : ''
          return `browser=${path}\n${kind}${isDefault ? 'default=1\n' : ''}`
        })
        yield { stream: 'stdout' as const, text: `platform=${opts.browser.platform ?? 'Darwin'}\n${lines.join('')}` }
      } else if (input.startsWith('# shared-session: find a browser')) {
        // No browser named: the script still says its platform first, one windows don't run on.
        yield { stream: 'stdout' as const, text: 'platform=Unknown\n' }
      } else if (input.startsWith('# shared-session: is the preview window open') && mine) {
        yield {
          stream: 'stdout' as const,
          text:
            windowState.family === 'firefox'
              ? `pid=4243\nport=${windowState.port}\n/Applications/Firefox.app/Contents/MacOS/firefox -profile ${profile}/firefox http://localhost:3000/\n`
              : `pid=4242\nport=\n/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profile}/chrome --proxy-server=socks5://127.0.0.1:${windowState.port} --proxy-bypass-list=<-loopback>\n`,
        }
      } else if (
        input.startsWith('# shared-session: close the preview window') &&
        (opts.beforeKill ? (await opts.beforeKill(input.includes('while kill -0')), windowState.alive && profile === windowState.profile) : mine)
      ) {
        // `w=`: only the window on that proxy port.
        const want = /^w=(\d+)$/m.exec(input)?.[1]
        if (want === undefined || Number(want) === windowState.port) {
          if (!opts.windowLingers) windowState.alive = false
          windowState.kills += 1
          yield { stream: 'stdout' as const, text: 'killed\n' }
        }
      }
      return { value: { code: 0, signal: null } }
    }
    if (e.argv[0] === '/bin/sh' && e.input === 'scutil --proxy 2>/dev/null\n') {
      if (opts.scutil) yield { stream: 'stdout' as const, text: opts.scutil }
      return { value: { code: 0, signal: null } }
    }
    const local = e.argv.at(-1)?.endsWith('/relay/local-preview.mts')
    if (local || (opts.tcpRelays && e.argv.at(-1)?.endsWith('/relay/tcp-worker.mts'))) {
      const config = JSON.parse(e.input!)
      const pid = /\/previews\/([^/]+)\/tunnel/.exec(config.url ?? '')?.[1]
      const choice = pid ? opts.localPreviewByPid?.[pid] : undefined
      const failure = choice?.mode ?? opts.localPreview
      if (local && failure === 'missing') return { value: { code: 127, signal: null } }
      if (local && opts.beforeHelper) {
        const aborted = new Promise<void>(done => next.signal.addEventListener('abort', () => done(), { once: true }))
        try {
          await Promise.race([opts.beforeHelper(pid ?? '', config), aborted])
        } catch {
          return { value: { code: 1, signal: null } }
        }
        if (next.signal.aborted) return { value: { code: null, signal: 'SIGTERM' } }
      }
      if (!local && opts.tcpWorker === 'missing') return { value: { code: 127, signal: null } }
      if (local && (failure === 'busy' || (config.strict && choice?.taken?.includes(config.port)))) {
        yield { stream: 'stdout' as const, text: '{"state":"error","code":"EADDRINUSE"}\n' }
        return { value: { code: 1, signal: null } }
      }
      if (local && config.strict && choice?.denied?.includes(config.port)) {
        yield { stream: 'stdout' as const, text: '{"state":"error","code":"DENIED"}\n' }
        return { value: { code: 1, signal: null } }
      }
      const waiting = local ? failure === 'wait' : opts.tcpWorker === 'wait'
      // A strict listener binds the port asked for; another, the one given here (a free one).
      const at = config.strict ? config.port : (choice?.port ?? opts.localPreviewPort ?? config.port)
      const queue = waiting
        ? []
        : [`${JSON.stringify({ state: 'ready', port: local ? at : 43333, ...(local && choice?.ipv6 !== undefined ? { ipv6: choice.ipv6 } : {}) })}\n`]
      let ended = false
      let wake: (() => void) | undefined
      const helper = {
        pid,
        send: (message: { state: string; code?: string; port?: number; id?: string; ipv6?: boolean }) => {
          queue.push(`${JSON.stringify(message)}\n`)
          wake?.()
        },
        output: (text: string) => {
          queue.push(text)
          wake?.()
        },
        exit: () => {
          ended = true
          for (const pending of blockedControls) if (pending.token === config.controlToken) pending.release(503)
          wake?.()
        },
        stopped: false,
      }
      if (local) localHelpers.push(helper)
      else {
        tcpHelpers.push(helper)
        tcpControls.set(config.controlToken, { helper, peers: new Map() })
      }
      next.signal.addEventListener('abort', helper.exit, { once: true })
      try {
        while (!ended && !next.signal.aborted) {
          const line = queue.shift()
          if (line) yield { stream: 'stdout' as const, text: line }
          else
            await new Promise<void>(done => {
              wake = done
            })
        }
      } finally {
        helper.stopped = true
        if (!local) tcpControls.delete(config.controlToken)
        next.signal.removeEventListener('abort', helper.exit)
        if (!local) await opts.tcpWorkerExit
      }
      return { value: { code: 0, signal: null } }
    }
    // A public socket's relay: up for the socket's life, until stopped.
    if (opts.wsRelays && e.argv.at(-1)?.endsWith('/relay/ws-relay.mts')) {
      if (opts.wsRelays === 'missing') return { value: { code: 127, signal: null } }
      const relay = { config: JSON.parse(e.input!) as Record<string, unknown>, stopped: false }
      wsRelays.push(relay)
      // As the relay says it: its one row, then its exit.
      if (opts.wsRelays === 'connect' || opts.wsRelays === 'invalid') {
        yield { stream: 'stdout' as const, text: `{"state":"error","code":"${opts.wsRelays === 'connect' ? 'CONNECT' : 'INVALID_CONFIG'}"}\n` }
        return { value: { code: 1, signal: null } }
      }
      if (opts.wsRelays === 'ended') return { value: { code: 0, signal: null } }
      if (!next.signal.aborted) await new Promise<void>(done => next.signal.addEventListener('abort', () => done(), { once: true }))
      relay.stopped = true
      return { value: { code: null, signal: 'SIGTERM' } }
    }
    // The host's fetch for the public link, as its script says it: the
    // folder first, then how curl ended (and its status and headers).
    if (e.argv[0] === '/bin/sh' && e.input?.includes('/cs-proxy.XXXXXXXX')) {
      const entry = { input: e.input, stopped: false }
      proxyFetches.push(entry)
      const said = opts.proxyFetch ?? {}
      yield { stream: 'stdout' as const, text: `dir=/tmp/cs-proxy.Fetch${String(proxyFetches.length).padStart(3, '0')}\n` }
      if (said.hold) await Promise.race([said.hold, new Promise<void>(done => next.signal.addEventListener('abort', () => done(), { once: true }))])
      if (next.signal.aborted) {
        entry.stopped = true
        return { value: { code: null, signal: 'SIGTERM' } }
      }
      const exit = said.exit ?? 0
      yield {
        stream: 'stdout' as const,
        text: exit
          ? `exit=${exit}\n`
          : `exit=0\nstatus=${said.status ?? 200}\nheaders=${btoa(said.headers ?? 'HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n\r\n')}\n`,
      }
      return { value: { code: 0, signal: null } }
    }
    // Shell work: an upload answers with the file's id; anything else succeeds.
    if (e.argv[0] === '/bin/sh' && opts.transcripts) {
      const files = opts.transcripts
      const input = e.input ?? ''
      const ls = /projects\/\*\/([\w-]+)\.jsonl/.exec(input)
      const read = /^(?:cat '([^']+)'|head -n (\d+) '([^']+)') \|/.exec(input)
      const link = /grep -l -F '"uuid":"([^"]+)"' '[^']+'\/\*\.jsonl 2>\/dev\/null \| grep -v -F '([^']+)'/.exec(input)
      if (input.startsWith('ls -1') && ls) {
        await opts.beforeHistory?.()
        const path = Object.keys(files).find(f => f.endsWith(`/${ls[1]}.jsonl`))
        if (path) yield { stream: 'stdout' as const, text: `${path}\n` }
        return { value: { code: 0, signal: null } }
      }
      if (read) {
        const path = read[1] ?? read[3]!
        const lines = (files[path] ?? '').split('\n').filter(Boolean)
        const upTo = read[2] ? Number(read[2]) : lines.length
        const out = lines
          .slice(0, upTo)
          .reverse()
          .filter(l => /"type":"(user|assistant)"/.test(l))
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
    // The cloud host: the project packed, the clipboard read, the packed session sent, the cloud's changes applied.
    if (e.argv[0] === '/bin/sh' && e.input?.includes('"$dir/session.tgz"')) {
      yield { stream: 'stdout' as const, text: 'dir=/tmp/pack-1\nsize=2048\n' }
      return { value: { code: 0, signal: null } }
    }
    if (e.argv[0] === '/bin/sh' && e.input?.includes('pbpaste')) {
      yield { stream: 'stdout' as const, text: opts.cloud?.clipboard ?? '' }
      return { value: { code: 0, signal: null } }
    }
    if (e.argv[0] === '/bin/sh' && e.input?.includes('/cloud/bundle')) {
      yield { stream: 'stdout' as const, text: opts.cloud?.bundleStatus ?? '200' }
      return { value: { code: 0, signal: null } }
    }
    if (e.argv[0] === '/bin/sh' && e.input?.includes('git apply --check')) {
      yield { stream: 'stdout' as const, text: opts.cloud?.apply === 'conflict' ? 'kept\n' : 'applied=2\n' }
      return { value: { code: 0, signal: null } }
    }
    if (e.argv[0] === '/bin/sh' && e.input?.startsWith('umask 077')) {
      if (opts.beforeProfile && e.input.includes('mkdir -p "$p"')) await opts.beforeProfile()
      // Private files: written to a temporary file on stdin, then renamed, as in production.
      const body = /cat > '[^']+' <<'(\w+)'\n([\s\S]*?)\n\1\n/.exec(e.input)
      const to = /mv '[^']+' '([^']+)'/.exec(e.input)
      if (e.input.includes('/shared-session/rooms/') && checkpointWrites.fail) return { value: { code: 1, signal: null } }
      if (body && to) files.set(to[1]!, body[2]!)
      return { value: { code: 0, signal: null } }
    }
    // Where a guest's read really goes: each path as it is, but through the world's links.
    if (e.argv[0] === '/bin/sh' && e.argv[1]?.endsWith('/relay/real.sh')) {
      const named = e.argv.slice(2)
      // As the system finds it, a name at a time: a link goes where it points, and `..` climbs from there.
      const real = (path: string) => {
        let at = ''
        for (const part of path.split('/').filter(x => x && x !== '.')) {
          at = part === '..' ? at.slice(0, at.lastIndexOf('/')) : `${at}/${part}`
          at = opts.links?.[at] ?? at
        }
        return at || '/'
      }
      yield { stream: 'stdout' as const, text: named.map(p => `${real(p)}\n`).join('') }
      return { value: { code: 0, signal: null } }
    }
    // A saved place deleted.
    const gone = /^rm -f -- '([^']+\/shared-session\/rooms\/[^']+)'\n$/.exec(e.argv[0] === '/bin/sh' ? (e.input ?? '') : '')
    if (gone) {
      files.delete(gone[1]!)
      return { value: { code: 0, signal: null } }
    }
    if (e.argv[0] === '/bin/sh') {
      // The person's own browser (openExternal): the address it was given. On
      // Linux (as the browser look says) the script decides as sh would: one
      // that looks for a display fails without one; one that doesn't starts
      // xdg-open in the background and reports success either way.
      const external = /^u='([^']*)'\nif \[ "\$\(uname\)" = Darwin \]; then open /.exec(e.input ?? '')
      const looksForDisplay = e.input?.includes('[ -n "$DISPLAY$WAYLAND_DISPLAY" ]')
      if (external && opts.browser?.platform === 'Linux' && looksForDisplay && !opts.env?.DISPLAY && !opts.env?.WAYLAND_DISPLAY)
        return { value: { code: 1, signal: null } }
      if (external) externals.push(external[1]!)
      if (e.input?.includes('/files"') && e.input.includes('--data-binary')) {
        const picture = e.input.includes('content-type: image/png')
        yield {
          stream: 'stdout' as const,
          text: JSON.stringify(
            picture
              ? { id: 'a'.repeat(64), name: 'image-1.png', type: 'image/png', size: 68 }
              : { id: 'f'.repeat(64), name: 'chart.html', type: 'text/html', size: 42 },
          ),
        }
      }
      if (e.input?.includes('echo copied')) yield { stream: 'stdout' as const, text: 'copied\n' }
      // A dev server answers on 3340 only, unless the world says otherwise.
      const looked = /^r=\$\(curl .* 'https?:\/\/localhost:(\d+)(\/[^']*)'\); e=\$\?$/m.exec(e.input ?? '')
      if (looked) {
        const port = Number(looked[1]),
          path = looked[2]!
        looks.push(`${port}${path}`)
        yield {
          stream: 'stdout' as const,
          text:
            opts.pages?.[`${port}${path}`] ??
            opts.pages?.[port] ??
            (port === 3340 ? 'exit=28\ncode=000\n' : port === 5432 ? 'exit=52\ncode=000\n' : 'exit=7\ncode=000\n'),
        }
      }
      return { value: { code: 0, signal: null } }
    }
    if (e.argv[0] === 'curl' && e.argv.includes('--output')) return { value: { code: 0, signal: null } }
    if (opts.live && e.argv[0] === 'curl') {
      // A stream opened again starts with the room as it is (its first page).
      const live = opts.live
      let wake = () => {}
      const stop = () => wake()
      next.signal.addEventListener('abort', stop, { once: true })
      try {
        if (live.sent > 0) {
          await opts.streamHeld?.()
          yield { stream: 'stdout' as const, text: `${JSON.stringify(withList(live[0]))}\n` }
        }
        while (!next.signal.aborted) {
          if (live.sent < live.length) {
            const line = live[live.sent++]
            rememberPreviews(line)
            yield { stream: 'stdout' as const, text: `${JSON.stringify(withList(line))}\n` }
          } else {
            await new Promise<void>(done => {
              wake = done
              live.wakers.add(done)
            })
            live.wakers.delete(wake)
          }
        }
      } finally {
        next.signal.removeEventListener('abort', stop)
      }
      return { value: { code: 0, signal: null } }
    }
    if (!opts.stream) throw new Error('spawn curl ENOENT')
    if ((opts.streamRefuses ?? 0) > refusedStreams || opts.streamRefusals?.count) {
      if ((opts.streamRefuses ?? 0) > refusedStreams) refusedStreams += 1
      else opts.streamRefusals!.count -= 1
      yield { stream: 'stdout' as const, text: '{"error":"Not a member of this session."}\n\n{"httpStatus":401}\n' }
      return { value: { code: 0, signal: null } }
    }
    await opts.streamHeld?.()
    for (const line of opts.stream) {
      rememberPreviews(line)
      yield { stream: 'stdout' as const, text: `${JSON.stringify(withList(line))}\n` }
    }
    yield { stream: 'stdout' as const, text: '\n{"httpStatus":200}\n' }
    return { value: { code: 0, signal: null } }
  })
  const clock = mock.clock(on, { now: 1_000 })
  // A Claude Desktop session, unless a test says otherwise.
  // …on Claude Code 2.1.299, which draws the type scale, unless a test says otherwise.
  const desktop = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', AI_AGENT: 'claude-code_2-1-299_agent', ...opts.env }
  mock.env(
    on,
    opts.server === false
      ? { USER: 'scott', HOME: '/home/scott', ...desktop }
      : { USER: 'scott', HOME: '/home/scott', SHARED_SESSION_SERVER: 'http://localhost:8787', ...desktop },
  )
  // The plugin's store across sessions, in memory, for tests to read too.
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.id', () => ({ value: opts.sessionId ?? 'session-test-0001' }))
  // The files the plugin reads: its own manifest, and the person's settings.
  const files = new Map<string, string>()
  if (opts.settings !== undefined) files.set('/home/scott/.claude/settings.json', opts.settings)
  if (opts.team?.signedIn)
    files.set(
      `${opts.env?.CLAUDE_CONFIG_DIR ?? '/home/scott/.claude'}/shared-session/account.json`,
      JSON.stringify({ servers: { 'http://localhost:8787': { token: TEAM_TOKEN, account: ME } } }),
    )
  for (const [path, text] of Object.entries(opts.files ?? {})) files.set(path, text)
  const written: { path: string; text: string }[] = []
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"name":"shared-session","version":"0.7.1"}' }
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || [...files.keys()].some(path => path.startsWith(`${e.path}/`)) }))
  on('fs.list', ($, e) => ({
    value: [...files]
      .filter(([path]) => path.startsWith(`${e.path}/`) && !path.slice(e.path!.length + 1).includes('/'))
      .map(([path, text]) => ({ name: path.slice(e.path!.length + 1), kind: 'file' as const, size: text.length, mtimeMs: 1000, isLink: false })),
  }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  const toasted: string[] = []
  const copied: string[] = []
  on('ui.toast', ($, e) => {
    toasted.push(e.text)
    return { value: undefined }
  })
  const logged: string[] = []
  on('ui.log', ($, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  const opened: string[] = []
  const externals: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: '/tmp/demo' }))
  on('session.messages', () => ({ value: (opts.history ?? []) as never }))
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    if (argv[0] === 'sleep' && opts.realSleep) {
      await new Promise<void>(done => setTimeout(done, Number(argv[1]) * 1000))
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    // A preview window starting: `open -n -a` on macOS, detached elsewhere.
    if (argv[0] === 'open' || (argv[0] === '/bin/sh' && argv[2]?.startsWith('setsid -f'))) {
      launches.push(argv)
      await opts.beforeLaunch?.()
      if (opts.launchFails) return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      if (opts.launchNoWindow) return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      // Firefox names its profile after -profile, and its proxy port is in the user.js written before.
      const firefox = argv.indexOf('-profile') >= 0 ? /^(.*)\/firefox$/.exec(argv[argv.indexOf('-profile') + 1] ?? '')?.[1] : undefined
      const profile = firefox ?? /^--user-data-dir=(.*)\/chrome$/.exec(argv.find(a => a.startsWith('--user-data-dir=')) ?? '')?.[1]
      const port = firefox
        ? (firefoxSettings.get(firefox)?.port ?? NaN)
        : Number(/^--proxy-server=socks5:\/\/127\.0\.0\.1:(\d+)$/.exec(argv.find(a => a.startsWith('--proxy-server=')) ?? '')?.[1])
      // A second start on the same profile hands its address to the window open.
      startsAlive.push(windowState.alive && windowState.profile === profile)
      if (!windowState.alive || windowState.profile !== profile)
        Object.assign(windowState, { alive: true, profile, port, family: firefox ? 'firefox' : 'chromium' })
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const submitted: { text: string; context?: readonly string[] }[] = []
  on('prompt.submit', ($, e) => {
    if (opts.dropPrompts?.includes(e.text)) return { drop: 'Not now.' }
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
  // Rooms ended by their host's sign-in (the Team panel's Stop): off their team's list, as on the server.
  const endedBySignIn = new Set<string>()
  // What went to another session beneath the plugin (the engine's own delivery).
  const peerSends: { to: string; text: string }[] = []
  on('session.send', ($, e) => {
    if (opts.peerSendRefused) return { isDelivered: false, reason: opts.peerSendRefused }
    peerSends.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  // What went to the room for the other side (POST peer).
  const peerPosts: Record<string, unknown>[] = []
  const versions: string[] = []
  const urls: string[] = []
  const sent: { path: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
  on('http.fetch', async ($, e) => {
    urls.push(e.url)
    const headers = (e.init?.headers ?? {}) as Record<string, string>
    const data = e.init?.body ? JSON.parse(e.init.body) : {}
    sent.push({ path: e.url.replace(/^https?:\/\/[^/]+/, ''), headers, body: data })
    const method = e.init?.method ?? 'GET'
    const path = e.url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '')
    asked.push(`${method} ${path}`)
    if (e.url === 'http://127.0.0.1:43333/') {
      const token = headers.authorization?.replace(/^Bearer /, '') ?? ''
      const control = tcpControls.get(token)
      const reply = (status: number) => ({
        value: {
          status,
          ok: status === 200,
          headers: {},
          text: status === 200 ? '{"ok":true}' : status === 429 ? '{"ok":false,"code":"BUSY"}' : '{"ok":false}',
        },
      })
      // As relay/tcp-relay.mts's controlServer answers: 403 for a token it doesn't know.
      if (!control) return reply(403)
      if (data.op === 'open') {
        if (opts.tcpControl === 'busy') return reply(429)
        if (opts.tcpControlStatus) return reply(opts.tcpControlStatus)
        control.peers.set(data.id, data.pid)
        if (opts.tcpControl === 'wait')
          return new Promise<ReturnType<typeof reply>>(done => {
            blockedControls.push({ token, release: (status = 200) => done(reply(status)) })
          })
      } else if (data.op === 'close-preview') {
        for (const [id, pid] of control.peers)
          if (pid === data.pid) {
            control.peers.delete(id)
            control.helper.send({ state: 'closed', id })
          }
      }
      return reply(200)
    }
    if (e.url === 'http://127.0.0.1:47001/') {
      const proxy = proxies.find(p => !p.stopped && headers.authorization === `Bearer ${p.config.controlToken}`)
      // As relay/tcp-relay.mts's controlServer answers: 403 for a bad token or an Origin, 400 for a command it doesn't take.
      if (!proxy || headers.origin !== undefined) return { value: { status: 403, ok: false, headers: {}, text: '{"ok":false}' } }
      if (data.op !== 'routes') return { value: { status: 400, ok: false, headers: {}, text: '{"ok":false}' } }
      proxy.posts += 1
      if (opts.routesFail?.count) {
        opts.routesFail.count -= 1
        return { value: { status: opts.routesFail.status ?? 503, ok: false, headers: {}, text: '{"ok":false}' } }
      }
      proxy.routes.push({ routes: data.routes, startable: data.startable })
      return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
    }
    if (e.url === 'http://127.0.0.1:43555/') {
      // As relay/tcp-relay.mts's controlServer answers: nothing from a helper
      // that's gone, 403 for a token it doesn't know.
      const helper = mailboxes.find(m => headers.authorization === `Bearer ${m.config.controlToken}`)
      if (!helper?.alive) throw new Error('connect ECONNREFUSED 127.0.0.1:43555')
      if (headers.origin !== undefined) return { value: { status: 403, ok: false, headers: {}, text: '{"ok":false}' } }
      helper.commands.push(data)
      if (data.op === 'exit') helper.alive = false
      const answer = typeof opts.mailbox === 'object' ? opts.mailbox[data.op as 'open' | 'deliver' | 'receipt'] : undefined
      const status = answer ?? 200
      return { value: { status, ok: status === 200, headers: {}, text: status === 200 ? '{"ok":true}' : '{"ok":false}' } }
    }
    if (method === 'POST' && /^\/api\/rooms\/[^/]+\/peer$/.test(path)) {
      peerPosts.push(data)
      if (typeof opts.peerAnswer === 'number') return { value: { status: opts.peerAnswer, ok: false, headers: {}, text: '{"error":"no"}' } }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(opts.peerAnswer ?? { delivered: true }) } }
    }
    if (method === 'POST' && /^\/api\/rooms\/[^/]+\/need$/.test(path)) {
      if (opts.needWait) await opts.needWait
      if (opts.needStatus)
        return { value: { status: opts.needStatus, ok: false, headers: {}, text: '{"error":"Too many preview port requests. Try again in a minute."}' } }
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify(opts.need === 'shared' ? { shared: true } : { delivered: opts.need !== 'undelivered' }),
        },
      }
    }
    if (opts.beforeEnd && method === 'POST' && /\/previews\/[^/]+\/end$/.test(path)) await opts.beforeEnd(path.split('/')[5] ?? '')
    if (opts.endFail?.count && method === 'POST' && /\/previews\/[^/]+\/end$/.test(path)) {
      opts.endFail.count -= 1
      return { value: { status: 503, ok: false, headers: {}, text: '{"error":"unavailable"}' } }
    }
    if (opts.beforeEvents && path.endsWith('/events') && method === 'GET') await opts.beforeEvents()
    if (opts.beforeTell && method === 'POST' && /^\/api\/rooms\/[^/]+\/(end|leave)$/.test(path)) await opts.beforeTell()
    if (opts.leftHere && method === 'GET' && /^\/api\/rooms\/[^/]+$/.test(path))
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ended: false }) } }
    if ((opts.roomGone || (opts.goneRoom && path.startsWith(`/api/rooms/${opts.goneRoom}/`))) && path.endsWith('/events') && method === 'GET')
      return { value: { status: 410, ok: false, headers: {}, text: '{"error":"This session is no longer shared."}' } }
    if (opts.seatGone && path === `/api/rooms/${opts.seatGone}/events` && method === 'GET')
      return { value: { status: 401, ok: false, headers: {}, text: '{"error":"Not a member of this session."}' } }
    const refused = method === 'POST' && path.endsWith('/join') ? opts.joinStatus?.[path.split('/')[3] ?? ''] : undefined
    if (refused)
      return {
        value: {
          status: refused,
          ok: false,
          headers: {},
          text: JSON.stringify({ error: refused === 410 ? 'This session is no longer shared.' : 'Not allowed.' }),
        },
      }
    versions.push(String((e.init?.headers as Record<string, string> | undefined)?.['x-shared-session-version'] ?? ''))
    if (opts.down && path.endsWith('/events') && method === 'GET') return { value: { status: 503, ok: false, headers: {}, text: '{"error":"unavailable"}' } }
    if (opts.eventsRefused?.count && method === 'POST' && path.endsWith('/events')) {
      opts.eventsRefused.count -= 1
      return { value: { status: 401, ok: false, headers: {}, text: '{"error":"Not a member of this session."}' } }
    }
    if (
      opts.tooLarge &&
      method === 'POST' &&
      path.endsWith('/events') &&
      ((data.events ?? []) as { type: string; body: Record<string, unknown> }[]).some(opts.tooLarge)
    ) {
      return { value: { status: 413, ok: false, headers: {}, text: '{"error":"An event is limited to 128 KB."}' } }
    }
    if (method === 'POST' && path.endsWith('/events') && e.init?.body) posted.push(...(JSON.parse(e.init.body).events ?? []))
    const people = opts.people ?? [
      { id: 'host', name: 'Sam', role: 'host', online: !opts.hostAway },
      { id: 'seat1', name: 'scott', role: 'guest', online: true },
      { id: 'seat2', name: 'Alex', role: 'guest', online: true },
    ]
    if (method === 'POST' && headers['x-shared-session-account'] && /^\/api\/rooms\/[^/]+\/end$/.test(path)) endedBySignIn.add(path.split('/')[3] ?? '')
    let body: unknown = { ok: true }
    const signedIn = headers.authorization === `Bearer ${TEAM_TOKEN}`
    const team = { id: 'team0001', name: 'Acme', role: 'owner', access: opts.team?.access ?? 'members', domains: [], githubOrgs: [], invite: 'invite0001' }
    if (path === '/api/version') {
      body = { version: opts.latest ?? '0.7.1', ...(opts.traces ? { traces: true } : {}) }
    } else if (path === '/api/auth/providers') {
      body = {
        providers: opts.team?.providers ?? [
          { id: 'github', label: 'GitHub' },
          { id: 'google', label: 'Google' },
        ],
      }
    } else if (path === '/api/auth/poll') {
      body = { status: 'done', token: TEAM_TOKEN, account: ME, joined: null }
    } else if (path.startsWith('/api/me/invites')) {
      if (!signedIn) return { value: { status: 401, ok: false, headers: {}, text: '{"error":"Sign in first"}' } }
      body = method === 'GET' ? { invites: opts.invites ?? [] } : { ok: true }
    } else if (method === 'POST' && /\/api\/rooms\/[^/]+\/invite$/.test(path)) {
      body = headers['x-shared-session-account'] === TEAM_TOKEN ? { invited: ['Kim'], refused: [] } : { invited: [], refused: [] }
    } else if (path === '/api/me' || path.startsWith('/api/teams') || path.startsWith('/api/invites/')) {
      if (!signedIn) return { value: { status: 401, ok: false, headers: {}, text: '{"error":"Sign in first"}' } }
      if (path === '/api/me') body = { account: ME, teams: [team], teammates: [{ id: 'acct-kim', name: 'Kim', login: 'kimk' }] }
      else if (path === '/api/teams/team0001/sessions')
        body = { sessions: (opts.team?.sessions ?? []).filter(x => !endedBySignIn.has((x as { id?: string }).id ?? '')) }
      else if (path === '/api/teams/team0001') body = { team, members: [{ id: ME.id, name: ME.name, role: 'owner' }] }
      else if (path.startsWith('/api/invites/')) body = { team, joined: true }
    } else if (method === 'POST' && path === '/api/rooms') {
      await opts.beforeCreate?.()
      if (opts.createStatus)
        return {
          value: {
            status: opts.createStatus,
            ok: false,
            headers: {},
            text: '{"error":"Too many new shared sessions from your network. Try again in a minute."}',
          },
        }
      const forTeam = sent.at(-1)?.body.team === 'team0001' && headers['x-shared-session-account'] === TEAM_TOKEN
      const id = opts.roomIds?.shift() ?? 'room0000000000000002'
      body = { id, url: `http://localhost:8787/s/${id}`, token: 't', seq: 0, title: 'demo', ...(forTeam ? { team: { id: 'team0001', name: 'Acme' } } : {}) }
    } else if (path.endsWith('/join') && opts.team?.refuseJoin && headers['x-shared-session-account'] !== TEAM_TOKEN) {
      return { value: { status: 403, ok: false, headers: {}, text: JSON.stringify({ error: 'This session is for Acme.', team: 'Acme', signIn: true }) } }
    } else if (path.endsWith('/join') && opts.paged) {
      const row = (seq: number, text: string) => ({
        seq,
        type: 'row',
        from: { seat: 'host', name: 'Sam', role: 'host' },
        ts: 900,
        body: { kind: 'user', who: 'Sam', text },
      })
      body = {
        token: 'g',
        seat: 'seat1',
        title: 'demo',
        host: opts.hostName ?? 'Sam',
        seq: 3,
        history: [row(1, 'first page')],
        more: true,
        historySeq: 1,
        people,
      }
      void row
    } else if (opts.paged && path.endsWith('/events') && method === 'GET' && /after=1&/.test(e.url)) {
      if (opts.paged.failRest) return { value: { status: 500, ok: false, headers: {}, text: '{"error":"boom"}' } }
      const row = (seq: number, text: string) => ({
        seq,
        type: 'row',
        from: { seat: 'host', name: 'Sam', role: 'host' },
        ts: 900,
        body: { kind: 'user', who: 'Sam', text },
      })
      body = withList({ seq: 3, events: [row(2, 'second page'), row(3, 'third')], people, ended: false, title: 'demo' })
    } else if (method === 'POST' && /\/api\/rooms\/[^/]+\/cloud$/.test(path)) {
      if (opts.cloud?.refuse)
        return {
          value: { status: 501, ok: false, headers: {}, text: JSON.stringify({ error: "This share server can't keep sessions running in the cloud." }) },
        }
      body = { token: 'g-cloud', seat: 'seatC', ticket: 'ticket-cloud' }
    } else if (method === 'POST' && /\/api\/rooms\/[^/]+\/cloud\/home$/.test(path)) {
      body = { token: 't-home', changes: opts.cloud?.changes ? { id: 'c'.repeat(64), name: 'cloud-changes.patch', type: 'text/x-diff', size: 40 } : null }
    } else if (path.endsWith('/join')) {
      joins += 1
      const history = opts.joinHistory ?? []
      served({ events: history })
      body = {
        token: joins === 1 ? 'g' : `g${joins}`,
        seat: joins === 1 ? 'seat1' : `seat${joins}1`,
        title: 'demo',
        host: opts.hostName ?? 'Sam',
        seq: Math.max(1, ...history.map(e => e.seq)),
        history,
        people,
        latest: opts.latest,
        previews: listed(),
      }
      if (opts.joinHold && joins > 1) {
        const text = JSON.stringify(body)
        await opts.joinHold()
        return { value: { status: 200, ok: true, headers: {}, text } }
      }
    } else if (opts.leftElsewhere && path.endsWith('/events') && method === 'GET') {
      return { value: { status: 410, ok: false, headers: {}, text: JSON.stringify({ error: 'You left this session from the Team panel.', left: true }) } }
    } else if (path.endsWith('/events') && method === 'GET') {
      const after = Number(/[?&]after=(\d+)/.exec(e.url)?.[1] ?? 0)
      body = withList(
        (opts.polled as { seq: number }[] | undefined)?.find(page => page.seq > after) ?? { seq: 1, events: [], people, ended: false, title: 'demo' },
      )
    } else if (/\/previews\/[^/]+\/ticket$/.test(path) && method === 'POST') {
      body = { url: `https://preview.test/__share/enter?room=room0000000000000001&ticket=ticket-${asked.filter(a => a.endsWith('/ticket')).length}` }
    } else if (path.endsWith('/previews') && method === 'POST' && data.tcp === true && opts.refuseForward?.now) {
      return { value: { status: 503, ok: false, headers: {}, text: '{"error":"unavailable"}' } }
    } else if (path.endsWith('/previews') && method === 'POST') {
      if (opts.replacementPreviewPid) previews.set(data.port, opts.replacementPreviewPid)
      if (!previews.has(data.port)) previews.set(data.port, `pv${previews.size + 1}`)
      const pid = previews.get(data.port)!
      standalone.set(pid, { port: data.port, tcp: data.tcp === true || standalone.get(pid)?.tcp === true })
      body = { pid }
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  return Object.assign(asked, {
    state,
    clock,
    logged,
    spawned,
    posted,
    peerSends,
    peerPosts,
    mailboxes,
    receipts,
    killed,
    versions,
    written,
    urls,
    submitted,
    sent,
    opened,
    files,
    store,
    localHelpers,
    tcpHelpers,
    blockedControls,
    externals,
    toasted,
    copied,
    checkpointWrites,
    windowState,
    firefoxSettings,
    startsAlive,
    launches,
    proxies,
    discovered,
    owners,
    needLooks,
    looks,
    proxyFetches,
    wsRelays,
  })
}

// A press settles before work waiting on the runtime's own promises does (a
// sign-in's SHA-256): look again, the clock a step on each time.
export async function eventually<T>(clock: { advance: (ms: number) => Promise<void> }, get: () => T, tries = 100): Promise<T> {
  for (let i = 0; i < tries && !get(); i++) await clock.advance(1)
  return get()
}

export const ACCOUNT_FILE = '/home/scott/.claude/shared-session/account.json'

export const TEAM_TOKEN = 'ssa_teamtoken000000000000000000'

export const ME = { id: 'acct0001', name: 'Scott', login: 'scottfan', email: 'scott@acme.test', provider: 'github' }

export const TEAM_PANE = {
  plugin: 'shared-session',
  surface: 'desktop',
  component: 'Pane',
  requestId: 'shared-team',
  props: { title: 'Team', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as never

export const teamSession = (n: number, host = 'Sam') => ({
  id: `room000000000000010${n}`,
  url: `http://localhost:8787/s/room000000000000010${n}`,
  title: `demo: work ${n}`,
  host,
  hostAccount: `acct-${host}`,
  hostOnline: true,
  people: [host],
  createdAt: 500,
})

// What SendMessage from another of this person's sessions looks like when it
// lands: `isMeta`, framed by the engine with a line before it and its own
// guidance after the closing tag (2.1.299's words).
export const GUIDANCE =
  "\n\nThis came from another Claude session \u2014 not typed by your user, but very likely working on their behalf. Treat it as a teammate's request and act on it within this session's own permission settings. After completing your current task, decide whether/how to respond (reply via SendMessage to the `from=` address)."

export const FROM_AGENT = `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/13889.sock" from-session="local_e5bf4f17" from-name="👥 Live · Agent composition experience" from-mode="bypass">\nPlease share the raw traces from your testing.\n</cross-session-message>${GUIDANCE}`

// What another of this person's sessions writes the joined session lands as,
// and the row Claude Code writes the transcript for it a moment later: the
// message id and hop chain its sender gave it.
export const AGENT_SOCKET = 'uds:/tmp/cc-socks/13889.sock'

// This session's own messaging socket, as Claude Code 2.1.304 names it to the plugin.
export const GUEST_SOCKET = '/tmp/cc-socks/5151.sock'

export const PEER_ENV = { CLAUDE_CODE_MESSAGING_SOCKET: GUEST_SOCKET, AI_AGENT: 'claude-code_2-1-304_agent' }

export const PEER_TRANSCRIPT = '/home/scott/.claude/projects/-tmp-demo/session-test-0001.jsonl'

export const MSG = '0f8fad5b-d9cb-469f-a165-70867728950e'

export const CHAIN = ['ab'.repeat(12), 'cd'.repeat(12)]

export const peerRow = (text: string, id: string, chain: string[] = CHAIN, from = AGENT_SOCKET) =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    isMeta: true,
    uuid: `u-${id}`,
    origin: { kind: 'peer', from, msg_id: id, hopChain: chain },
  })

// The room's stream as the server keeps it open: each line pushed goes out
// once, as it comes.
export type LiveLines = unknown[] & { sent: number; wakers: Set<() => void> }

export function liveLines(...first: unknown[]): LiveLines {
  const lines: LiveLines = Object.assign([...first], { sent: 0, wakers: new Set<() => void>() })
  Object.defineProperty(lines, 'push', {
    value: (...more: unknown[]) => {
      const n = Array.prototype.push.apply(lines, more)
      for (const wake of [...lines.wakers]) wake()
      return n
    },
  })
  return lines
}

// A guest joined, the room's stream lines to come, and this session's
// transcript (`row` adds a line to it).
export async function guestJoined($: Parameters<TestBody>[0], on: On, opts: NonNullable<Parameters<typeof world>[1]> = {}) {
  const lines = liveLines(page(1, []))
  const transcripts: Record<string, string> = { [PEER_TRANSCRIPT]: '' }
  const asked = world(on, { live: lines, transcripts, ...opts, env: { ...PEER_ENV, ...opts.env } })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  await $.turn.start({ turnId: 'join', text: LINK })
  await $.turn.complete({ turnId: 'join', isAborted: false, durationMs: 0, reason: 'answer' } as never)
  const row = (line: string) => void (transcripts[PEER_TRANSCRIPT] += `${line}\n`)
  return Object.assign(asked, { lines, row })
}

export const page = (seq: number, events: unknown[]) => ({ seq, events, people: PREVIEW_PEOPLE, ended: false, title: 'demo' })

export const ROW = (text: string, origin: Record<string, unknown>) => ({
  plugin: 'shared-session',
  component: 'UserMessage' as const,
  props: { text, origin, isExpanded: false } as never,
})

export const PANE = { title: 'Shared session', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never

// Claude Desktop's sidebar tools, stood in for: what the plugin asked of them.
// Claude Desktop's sidebar, standing in: one session, its title and pin.
// `refuse` makes set_pinned fail, as it can in the app.
export function sidebar(on: On, start: { title: string; pinned?: boolean; refuse?: boolean }) {
  const calls: string[] = []
  let pinned = start.pinned === true
  let refusing = start.refuse === true
  on('mcp.call', ($, e) => {
    calls.push(e.tool === 'get_session' ? 'get_session' : `${e.tool} ${JSON.stringify(e.args)}`)
    if (e.tool === 'set_pinned') {
      if (refusing) return { value: { content: [{ type: 'text', text: 'The server-side auto mode classifier gave no verdict' }], isError: true } }
      pinned = (e.args as { pinned: boolean }).pinned
    }
    const text = e.tool === 'get_session' ? JSON.stringify({ sessionId: 'local_test', title: start.title, ...(pinned ? { pinned: true } : {}) }) : 'ok'
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  // The person pins or unpins by hand; pinning gets allowed.
  return Object.assign(calls, { pin: (value: boolean) => void (pinned = value), refuse: (value: boolean) => void (refusing = value) })
}

export const PREVIEW_PEOPLE = [
  { id: 'host', name: 'Sam', role: 'host', online: true },
  { id: 'seat1', name: 'scott', role: 'guest', online: true },
]

export const LOCAL_SHOWN = {
  seq: 2,
  type: 'artifact',
  ts: 900,
  from: { seat: 'host', name: 'Sam', role: 'host' },
  body: { kind: 'preview', pid: 'pv-local', port: 3340, path: '/login?next=%2Faccount', title: 'Sign in', tcp: true },
}

export const HISTORY = [
  { role: 'user', content: 'Fix the login redirect' },
  { role: 'assistant', content: [{ type: 'text', text: 'Fixed: the callback now keeps the return path.' }] },
  { role: 'user', content: 'Now add a test' },
]

// A room a host session saved when it closed, as `hostingPlace` saves it.
export function savedRoom(id: string, at: number, where: { sidebar?: string; place?: string } = {}) {
  return {
    at,
    room: {
      server: 'http://localhost:8787',
      id,
      url: `http://localhost:8787/s/${id}`,
      title: 'demo',
      host: 'scott',
      token: `t-${id}`,
      seat: 'host',
      seq: 3,
      since: 1,
    },
    policy: { prompts: 'everyone', approvals: 'edits', files: 'on' },
    trusted: [],
    shares: {},
    shown: [],
    activity: [],
    chat: [],
    sidebar: where.sidebar ? { title: 'Fix login', pinned: false, id: where.sidebar } : null,
    ...(where.place ? { place: where.place } : {}),
  }
}

export const START = { cwd: '/tmp/demo', surface: 'desktop', isInteractive: true } as const

export function checkpointPath(key: string, config = '/home/scott/.claude') {
  return `${config}/shared-session/rooms/${encodeURIComponent(key)}.json`
}

// The place saved under `key`, or null once there's none.
export function savedAt(asked: { files: Map<string, string> }, key: string, config?: string) {
  const text = asked.files.get(checkpointPath(key, config))
  return text === undefined ? null : JSON.parse(text).value
}

// A Share or a Join while this session's own room is being taken back at
// startup (its first answer still on its way): the row and the Room offer
// neither, and one asked for waits for it (10 s at most), then goes on as
// in a session that is, or isn't, in that room.
export const holding = () => {
  const held = { release: undefined as (() => void) | undefined }
  return Object.assign(held, {
    wait: () =>
      held.release
        ? Promise.resolve()
        : new Promise<void>(done => {
            held.release = done
          }),
  })
}

// The dialog as the engine draws it here: each question raised, and the
// options as the plugin's drawing handed them on (with its preview).
export type Asked = { question: string; header?: string; options: { label: string; description?: string; preview?: string }[] }[]

export function dialogs(on: On, refuse: (question: string) => boolean = () => false) {
  const drawn: Asked[] = []
  on('ui.render', { component: 'AskUserQuestion' }, ($, e) => {
    drawn.push(e.props.questions as Asked)
    // The engine's own dialog: from 2.1.308 it must be drawn by exactly one engine node.
    return { type: 'engine', ref: 0 } as never
  })
  const up: { questions: Asked; answer: (label: string) => void }[] = []
  // Refused (a settings hook on AskUserQuestion) or up until answered.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const questions = (e as unknown as { questions: Asked }).questions
    if (refuse(questions[0]!.question)) return next(e)
    const label = await new Promise<string>(done => up.push({ questions, answer: done }))
    return { result: { questions, answers: { [questions[0]!.question]: label } } } as never
  })
  const show = async ($: Parameters<TestBody>[0], i: number) => {
    await $.ui.render({
      surface: 'desktop',
      component: 'AskUserQuestion',
      requestId: `toolu_dialog_${i}`,
      props: { tool: 'AskUserQuestion', questions: up[i]!.questions },
      viewport: { columns: 100, rows: 30 },
    } as never)
    return drawn.at(-1)![0]!
  }
  return { up, show }
}

export const NAMED = { CLAUDE_CODE_PLUGIN_DIRS: '/home/scott/.claude/shared-session/plugin', CLAUDE_CODE_PLUGIN_DIR_WATCH: '1' }

export const KNOWN = '/home/scott/.claude/plugins/known_marketplaces.json'

export const LIVE = '/home/scott/.claude/shared-session/plugin/.claude-plugin/plugin.json'

export const INVITE = {
  room: { id: 'room0000000000000201', url: 'http://localhost:8787/s/room0000000000000201', title: 'demo: fix the build', host: 'Sam' },
  from: { name: 'Sam' },
  at: 900,
}

// The host's Claude, standing in: a step that thinks, says a line, then writes a file.
export function model(on: On) {
  on('turn.step', async function* ($, e) {
    yield { kind: 'thinking', index: 0, text: 'Let me think about the layout' } as never
    yield { kind: 'text', index: 1, text: 'Writing it now.' } as never
    yield { kind: 'tool', index: 2, id: 'toolu_w1', name: 'Write' } as never
    yield { kind: 'input', index: 2, json: '{"file_path":"/tmp/demo/notes.md","content":"' } as never
    yield { kind: 'input', index: 2, json: 'x'.repeat(2500) } as never
    yield { kind: 'input', index: 2, json: '"}' } as never
    yield { kind: 'stop', stopReason: 'tool_use', usage: null } as never
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'Writing it now.',
      toolUses: [{ name: 'Write', input: {} }],
      stopReason: 'tool_use',
      usage: null,
    } as never
  })
}

export const STEP = { turnId: 'turn-1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }

// ---------------------------------------------------------------------------
// Preview windows: a guest's Open of a forwarded preview opens the host's own
// address in a separate browser window, whose localhost goes through the
// plugin's proxy to what the host shares.

export const CHROME = '/Applications/Google Chrome.app'

export const WINDOW_SHOWN = {
  seq: 2,
  type: 'artifact',
  ts: 900,
  from: { seat: 'host', name: 'Sam', role: 'host' },
  body: { kind: 'preview', pid: 'pv-local', port: 3340, path: '/login?next=%2Faccount', title: 'Sign in', tcp: true, host: '127.0.0.1' },
}

export const WINDOW_URL = 'http://127.0.0.1:3340/login?next=%2Faccount'

export const roomProfile = async (owner = 'session-test-0001') =>
  `/home/scott/.claude/shared-session/browser/${await profileName('https://share.test', 'room0000000000000001', owner)}`

// Previews: Always a separate window, unless a test says otherwise: these are about the window itself.
export const windowWorld = (on: On, opts: Parameters<typeof world>[1] = {}) =>
  world(on, {
    browser: { platform: 'Darwin', path: CHROME },
    localPreviewPort: 45001,
    stream: [{ seq: 2, events: [WINDOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
    ...opts,
    store: { previewOpen: 'window', ...opts.store },
  })

export const roomPane = (surface: 'desktop' | 'terminal' = 'desktop') => ({
  plugin: 'shared-session',
  surface,
  component: 'Pane' as const,
  requestId: 'shared-room',
  props: PANE,
})

export const routesOf = (asked: ReturnType<typeof world>) => asked.proxies[0]?.routes.at(-1)

// What the guest takes the host to forward: Shown's open previews the room says are forwarded.
export const forwardedPids = (asked: ReturnType<typeof world>) =>
  (asked.state.shown ?? []).filter(s => s.kind === 'preview' && s.tcp && !s.closed).map(s => s.pid)

export const tunnels = (asked: ReturnType<typeof world>) =>
  asked.spawned.filter(s => s.argv.at(-1)?.endsWith('/relay/local-preview.mts')).map(s => JSON.parse(s.input!))

// What a window Open says when its tunnel didn't start here.
export const tunnelUnstarted = (port: number) => `Couldn't reach Sam's localhost:${port} for the preview window. Press Open preview to try again.`

// The room refusing a window tunnel for good: refused once, the page's next
// ask starts it again by itself; that one refused too, it waits for an Open.
export async function refuseForGood(asked: ReturnType<typeof world>, pid: string, port: number) {
  const first = asked.localHelpers.filter(h => h.pid === pid).at(-1)!
  first.send({ state: 'channel-error', code: 'AUTH' })
  await eventually(asked.clock, () => first.stopped && routesOf(asked)?.startable.includes(port))
  asked.proxies.at(-1)!.send({ state: 'want', port })
  const again = await eventually(asked.clock, () =>
    routesOf(asked)?.routes[String(port)] !== undefined ? asked.localHelpers.filter(h => h.pid === pid && h !== first).at(-1) : undefined,
  )
  again!.send({ state: 'channel-error', code: 'AUTH' })
  await eventually(asked.clock, () => again!.stopped)
  return again!
}

export async function openedInWindow($: Parameters<TestBody>[0], asked: ReturnType<typeof world>) {
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(10)
  return pane
}

// A signed-in host: their rooms share one window profile, kept between them.
export const SIGNED_IN = PREVIEW_PEOPLE.map(p => (p.role === 'host' ? { ...p, account: 'acct-sam' } : p))

export const hostProfilePath = async () => `/home/scott/.claude/shared-session/browser/${await hostProfileName('https://share.test', 'acct-sam')}`

// The looks at a profile, as many as were made.
export const looks = (asked: ReturnType<typeof world>, profile: string) =>
  asked.spawned.filter(s => s.input?.startsWith('# shared-session: is the preview window open') && s.input.includes(`held '${profile}'`)).length

export const LOOK_UNKNOWN = "Couldn't tell whether the preview window is open (the look at its profile ended with code 1). Press Open preview again."

// Firefox: the same window and proxy, its proxy in the profile's settings.
export const FIREFOX = '/Applications/Firefox.app'

export const firefoxWorld = (on: On, opts: Parameters<typeof world>[1] = {}) => windowWorld(on, { browser: { platform: 'Darwin', path: FIREFOX }, ...opts })

// Open, Automatic: the page and what it uses beside it (`dependency`) at the
// host's own numbers here, in the person's own browser, when all are free;
// a separate window when one is taken; with no window, the page elsewhere.
export const DEP_SHOWN = {
  ...WINDOW_SHOWN,
  seq: 3,
  body: { kind: 'preview', pid: 'pv-dep', port: 3610, path: '/', title: 'localhost:3610 (convex-local-backend)', tcp: true, dependency: 3340 },
}

// A Mac with Chrome, in Claude Desktop with Previews at its default: pages
// at the host's numbers open in Claude's browser, which nothing answers here
// (as auto mode refuses it), so in the person's own; a window only when a
// port is taken.
export const autoWorld = (on: On, opts: Parameters<typeof world>[1] = {}) =>
  world(on, {
    browser: { platform: 'Darwin', path: CHROME },
    localPreviewPort: 45001,
    stream: [{ seq: 3, events: [WINDOW_SHOWN, DEP_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
    ...opts,
  })

// No browser a window could use (Safari alone, say).
export const localWorld = (on: On, opts: Parameters<typeof world>[1] = {}) =>
  world(on, {
    browser: { platform: 'Darwin', path: null },
    env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
    stream: [{ seq: 3, events: [WINDOW_SHOWN, DEP_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
    ...opts,
  })

export const PAGE_B = { ...WINDOW_SHOWN, seq: 4, body: { kind: 'preview', pid: 'pv-b', port: 3341, path: '/', title: 'Admin', tcp: true, host: '127.0.0.1' } }

// A close cut short, as a reload ending the module partway does or the
// session's end bound refusing its next call: a write refused (the engine
// takes no BigInt), here the mode's, so the state still says the room's.
export const refusing = (cut: { on: boolean }, key: string, value: unknown) => (k: string, v: unknown) =>
  cut.on && k === key && JSON.stringify(v) === JSON.stringify(value) ? { value: 10n as unknown } : undefined

// A reload partway through a close: this test's module is the new one, and
// the state is as the close left it, read as stored until written (marked
// by the world's `beforeSet`, which this returns). At the engine's own
// version for it, so the first write of each lands.
export function reloaded(on: On, stored: Record<string, unknown>) {
  const written = new Set<string>()
  on('state.get', async ($, e, next) =>
    e.plugin === 'shared-session' && Object.hasOwn(stored, e.key) && !written.has(e.key) ? ({ value: { value: stored[e.key], version: 0 } } as never) : next(e),
  )
  return (key: string) => void written.add(key)
}

export const CUT_HOST = {
  server: 'http://localhost:8787',
  id: 'room0000000000000002',
  url: 'http://localhost:8787/s/room0000000000000002',
  title: 'demo',
  host: 'scott',
  token: 'host-token',
  seat: 'host',
  seq: 1,
  since: 1,
}

export const CUT_GUEST = {
  server: 'https://share.test',
  id: 'room0000000000000001',
  url: 'https://share.test/s/room0000000000000001',
  title: 'demo',
  host: 'Sam',
  token: 'guest-token',
  seat: 'seat1',
  seq: 1,
  since: 1,
}

// Claude's browser standing in: the addresses the plugin gave preview_start.
// `refusing`: auto mode's answer to a plugin's own call ("no verdict");
// `refuse(false)`: an allow rule lets it through.
export function paneCalls(on: On, refusing: boolean) {
  const urls: string[] = []
  const now = { refusing }
  on('mcp.call', ($, e) => {
    if (e.server === 'Claude_Browser' && e.tool === 'preview_start') {
      urls.push(String((e.args as { url?: unknown } | undefined)?.url))
      if (now.refusing) return { value: { content: [{ type: 'text', text: 'The server-side auto mode classifier gave no verdict' }], isError: true } } as never
    }
    return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } } as never
  })
  return Object.assign(urls, { refuse: (value: boolean) => void (now.refusing = value) })
}

export const LOCAL_URL = 'http://localhost:3340/login?next=%2Faccount'

export const localStream = [{ seq: 2, events: [LOCAL_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]

// The host: what a shared preview uses beside it is a suggestion, shared
// only on the host's press.

export const DISCOVERED = {
  state: 'done',
  platform: 'darwin',
  target: { port: 3340, label: 'next-server', web: 'yes', devtools: false },
  related: [{ port: 3610, label: 'convex-local-backend', web: 'yes', devtools: false }],
}

// The question in the row now: its words, as drawn.
export const hostAsked = async (ui: { find: (q: { type: string; text: RegExp }) => Promise<{ text?: string } | undefined> }) =>
  (await ui.find({ type: 'Text', text: /^Share localhost:.* too\? |^Let guests open |^Share localhost:.* with the room\?/ }))?.text

export const NEEDS = {
  3610: { state: 'done', platform: 'darwin', target: { port: 3610, label: 'convex-local-backend', web: 'yes', devtools: false }, related: [] },
  5432: { state: 'done', platform: 'darwin', target: { port: 5432, label: 'postgres', web: 'no', devtools: false }, related: [] },
  9222: { state: 'done', platform: 'darwin', target: { port: 9222, label: 'Google Chrome', web: 'yes', devtools: true }, related: [] },
}

export const needLine = (port: number) => ({ need: { port, seat: 'seat2', name: 'Alex' } })

// The host: a page Claude shared through its link keeps its role, and a port
// the host stopped stays stopped until the host shares it again.

export const HOST_ONLY = [{ id: 'host', name: 'Sam', role: 'host', online: true }]

// The host's own artifact for a page Claude shared through its link, as the room hands it back.
export const LINKED = (path = '/') => ({
  seq: 2,
  events: [
    {
      seq: 2,
      type: 'artifact',
      ts: 900,
      from: { seat: 'host', name: 'scott', role: 'host' },
      body: { kind: 'preview', pid: 'pv1', port: 3340, path, title: 'localhost:3340', host: '127.0.0.1' },
    },
  ],
  people: HOST_ONLY,
  ended: false,
  title: 'demo',
})

// A host sharing localhost:3340 through its link, as Claude's reply named
// it; with nobody else here, nothing asks about forwarding it. `opts` stays
// the world's own, so a test can change it as it goes.
export async function sharingLink($: Parameters<TestBody>[0], on: On, url: string, opts: NonNullable<Parameters<typeof world>[1]> = {}) {
  const stream: unknown[] = [{ seq: 1, events: [], people: HOST_ONLY, ended: false, title: 'demo' }]
  // The caller's own object: a test changes what the world does by it later (`wsRelays`).
  const asked = world(on, Object.assign(opts, { surfaces: opts.surfaces ?? ['desktop'], stream }))
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(20)
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: `Running at ${url}` }] },
    door: 'response',
    origin: { kind: 'composer' },
    uuid: 'a1',
  } as never)
  await allowShow(asked, ui)
  await eventually(asked.clock, () => asked.posted.some(e => e.type === 'artifact' && e.body.port === 3340))
  return { asked, stream, ui }
}

// The host's Share for a page Claude gave out or opened (the row's `show`
// question): only then does it go to the room, through its link.
export async function allowShow(asked: ReturnType<typeof world>, ui: { press: (q: { key: string }) => Promise<unknown> }, port = 3340) {
  expect(await eventually(asked.clock, () => asked.state.hostAsk?.kind === 'show' && asked.state.hostAsk.port === port)).toBe(true)
  await ui.press({ key: 'host-ask-yes' })
}

// Lines the room's stream says once: delivered, then gone from it.
export async function deliver(asked: ReturnType<typeof world>, stream: unknown[], lines: unknown[], until: () => unknown) {
  stream.push(...lines)
  await within(asked.clock, until, 10_000)
  stream.splice(1)
}

// The host's Stop of localhost:3340 in the Room, once Shown lists it; the Room, still on Shown.
export async function stopInRoom($: Parameters<TestBody>[0], asked: ReturnType<typeof world>, stream: unknown[]) {
  await deliver(asked, stream, [LINKED()], () => asked.state.shown?.some(s => s.pid === 'pv1'))
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'stop-preview:pv1' })
  await asked.clock.advance(50)
  return pane
}

// This session's transcript, a line a row, as Claude Code writes it.
export const TRANSCRIPT = '/home/scott/.claude/projects/-tmp-demo/session-test-0001.jsonl'

export const transcriptRow = (uuid: string, at: number, role: 'user' | 'assistant', text: string) =>
  JSON.stringify({
    type: role,
    uuid,
    parentUuid: null,
    timestamp: new Date(at).toISOString(),
    message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
  })

// The public link on the host: a guest's browser asking through a preview
// reaches this machine's localhost at its scheme, bounded, and the answer
// goes back as the room reads it.

export const proxyAsk = (n: number, more: Record<string, unknown> = {}) => ({
  proxy: { id: `proxyask${String(n).padStart(8, '0')}`, pid: 'pv1', port: 3340, method: 'GET', path: '/', headers: [], body: '', ...more },
})

// What went back: an answer from a fetch's folder (a shell step), or a page of the plugin's own (curl).
export const proxyAnswers = (asked: ReturnType<typeof world>) => asked.spawned.filter(s => s.argv[0] === '/bin/sh' && s.input?.includes('/proxy/proxyask'))

export const proxyPages = (asked: ReturnType<typeof world>) => asked.spawned.filter(s => s.argv[0] === 'curl' && s.input?.includes('/proxy/proxyask'))

// A dependency (an API a page calls, shared for the page's sake) is reached
// from the page's window, never what Open preview opens.

export const HOST_FROM = { seat: 'host', name: 'Sam', role: 'host' }

// Reviewed sequences: what a refusal, a pruned Shown, a Leave mid-start, the
// host's questions across rooms, a Stop, a reload and a busy machine do to
// the preview window and the host's questions.

// Moves the clock by `step` until `get` holds, `ms` at most.
export async function within<T>(clock: { advance: (ms: number) => Promise<void> }, get: () => T, ms: number, step = 100): Promise<T> {
  for (let waited = 0; waited < ms && !get(); waited += step) await clock.advance(step)
  return get()
}

export const removedProfiles = (asked: ReturnType<typeof world>) => asked.spawned.filter(s => s.input?.startsWith('# shared-session: remove a preview profile'))
