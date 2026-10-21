export type ShareMode = 'idle' | 'host' | 'guest'

export type ShareRoom = {
  /** The room server's origin, from the share link or the plugin's default. */
  server: string
  id: string
  url: string
  title: string
  /** The host's display name. */
  host: string
  /** This seat's bearer token (the host's or a guest's). */
  token: string
  /** This seat's id in the room: `host`, or the guest seat the server gave. */
  seat: string
  /** Last event seq this session has seen. */
  seq: number
  /** When this session started sharing or joined, ms since the epoch. */
  since: number
  /** The team it's shared with: listed for its people, whose access setting says who joins. */
  team?: { id: string; name: string } | null
  /**
   * Host: shared Only from now on. A reopened session's look back at its
   * history shares only the pages Claude opened since `since`. Older plugins
   * ignore it.
   */
  fromNow?: true
  /**
   * The room's server passes messages between a teammate's own sessions and
   * the host's session on (its create or join answered `peer`): only then do
   * they go. Older plugins ignore it.
   */
  peer?: true
}

export type SharePerson = {
  id: string
  name: string
  role: 'host' | 'guest'
  online: boolean
  /** Their plugin's version, as the room heard it. */
  version?: string
  /** Every seat of theirs (a person signed in from several sessions is one entry). */
  seats?: string[]
  /** Their account on the share server, when they're signed in. */
  account?: string
}

/** Host: a teammate's prompt waiting to go to Claude: who, as Claude reads it (`framed`), as guests see it (`text`), its id, whether it has gone, and `aside` once it went and no turn started with it for a while: out of the line, but still theirs if its turn starts later. */
export type ShareGuestPrompt = { who: string; framed: string; text: string; pid: string; sent?: true; aside?: true }

export type ShareWorking = {
  turnId: string
  /** Who the running turn is for. */
  by: string
  /** True when a guest's prompt started it (its tools need the host's approval). */
  byGuest: boolean
  startedAt: number
  /** The tail of the text Claude is streaming, for guests. */
  tail: string
  /** A tool call waiting for the host's approval, as guests see it. */
  waitingFor: string | null
  /** What the host's Claude is doing this moment, as guests see it: thinking, writing a tool call, or running one. */
  doing?: ShareDoing | null
}

/** A moment of a host's step, live: thinking, writing a call (which tool, what for, how far), or running one. */
export type ShareDoing = { kind: 'thinking' | 'writing' | 'running'; tool?: string; target?: string; chars?: number }

/** One line of the Room panel's timeline. */
export type ShareActivity = {
  ts: number
  who: string
  kind: 'join' | 'leave' | 'prompt' | 'allowed' | 'denied' | 'stop' | 'policy' | 'shown'
  text?: string
}

/** One turn of the session, as the Timeline draws it: who asked, what, how long it took. */
export type ShareTurn = { id: string; who: string; prompt: string; at: number; /** How long it ran, once it ended. */ ms?: number }

/** A file Claude changed this session, for whom, and its patch (unified-diff hunks). */
export type ShareChange = { path: string; who: string; added: number; removed: number; patch: string; at: number }

/** What a person hears and sees of the room, kept across sessions. */
export type SharePrefs = {
  /** `mentions`: a ping when someone @mentions you, a chime when your prompt starts; `all`: a knock when someone joins too. */
  sounds: 'off' | 'mentions' | 'all'
  /** Joins and mentions said out loud by the computer's voice. */
  voice: boolean
  /** The room in the status line under the prompt. */
  statusLine: boolean
  /** A guest: messages from their other Claude sessions here go on to the host's Claude (relayed, as from that session). */
  relayPeers: boolean
}

/** The room's side channel: people talk, Claude never reads it. */
export type ShareChat = { ts: number; who: string; seat: string; text: string }

/** The host's say over what guests may do. */
export type SharePolicy = {
  /** `everyone`: guests' prompts run; `watch`: guests follow along and chat. */
  prompts: 'everyone' | 'watch'
  /** Which of a guest's tool calls ask the host first. */
  approvals: 'edits' | 'all' | 'none'
  /** Whether what the host's Claude shows (files, widgets, pages, previews) reaches guests. */
  files?: 'on' | 'off'
}

/** A file as the room keeps it: its bytes are at files/<id>. */
export type ShareFileMeta = { id: string; name: string; type: string; size: number; /** Where a page's file sits beside it (`img/01.jpg`). */ path?: string }

/**
 * Something the host's Claude showed: a file in the side panel or the Files
 * pane, a widget, a page, or a preview of the host's localhost.
 */
export type ShareShown = {
  key: string
  kind: 'send' | 'widget' | 'file' | 'page' | 'preview' | 'link'
  name: string
  /** A preview's title as its artifact (or the room) gave it, without what `name` adds to it. Absent from entries saved before it was kept. */
  title?: string
  ts: number
  files?: ShareFileMeta[]
  pid?: string
  port?: number
  /** A preview's page: where its links land. */
  path?: string
  url?: string
  /** A preview the host has stopped. */
  closed?: boolean
  /**
   * A preview the host chose to share for forwarding to a guest's localhost
   * (raw TCP); else it opens through its link. A guest takes it from the
   * room (its preview events, and what it lists as shared), and a later
   * artifact that doesn't say it (a page Claude opened there) keeps it.
   */
  tcp?: boolean
  /** A preview's address as the host gave it (`0.0.0.0` is `localhost`): a preview window opens exactly this origin. */
  host?: 'localhost' | '127.0.0.1' | '[::1]'
  /** A preview the host serves over TLS (`https://localhost:3000`); absent is http. Older plugins ignore it. */
  scheme?: 'https'
  /**
   * A preview shared for another page's sake (an API the app calls): the
   * host port of the page that uses it, or `true` when that isn't known.
   * Pages in a guest's preview window reach it at its own address; it is
   * never what Open preview opens. Older plugins ignore it.
   */
  dependency?: number | true
}

/** Guest: the room's preview window, by its proxy's port (Chrome keeps the flags it started with), and the previews opened in it. */
export type SharePreviewWindow = {
  room: string
  port: number
  opened: string[]
  /** Its profile's folder name: the room's and this session's lasting place's, so a reopened session finds its own. */
  profile?: string
}

/**
 * Host: one localhost port this session shares, by port (`shares`): its
 * preview, and whether the host forwards it and as what, or it opens only
 * through its link.
 */
export type HostShare = {
  pid: string
  /** The host chose to let guests forward it to their own localhost over raw TCP (/share-preview, Allow forwarding…); absent, only its link. */
  tcp?: true
  /** Forwarded: its address as the host spelled it (`0.0.0.0` is `localhost`); a page Claude opens on it later says the same. */
  host?: 'localhost' | '127.0.0.1' | '[::1]'
  /** Its server speaks TLS: its link's requests and sockets go to https and wss. Forwarded, as its forward said it, once said; else as the newest page shown on it said. */
  scheme?: 'https'
  /** Forwarded for another page's sake: that page's host port, or `true` when that isn't known; a page Claude opens on it later stays one. */
  dependency?: number | true
}

/**
 * Host: what the host said about sharing more in the room it shares, kept
 * through a reload and cleared with the room. A hosting place saves it with
 * its room's name (`room`), and it's taken back only for that room.
 */
export type ShareHostMemory = {
  /** Ports the host said Not now to, or stopped: not asked about again until the host shares them again. */
  declined: number[]
  /** Ports the host stopped: not shared again for Claude's mention of them (or a reopened session's look back) until the host shares them again. */
  stopped: number[]
  /** When each port was last asked about: once in ten minutes at most. */
  askedAt: Record<string, number>
}

/**
 * Messages between sessions, by id: whose each is. Guest: a handle, which the
 * room carries in the place of one of this person's sessions (`to`, its
 * address, which never leaves this computer; `name`, what it calls itself),
 * at the seat it was made at. Host: a mailbox (relay/mailbox.cjs), standing
 * for a teammate's session by the seat and handle the room brought its
 * message with, that teammate's name (`who`) and the session's (`name`).
 * `at`: when it was last used.
 */
export type SharePeerRoute =
  | { kind: 'guest'; to: string; name: string; seat: string; at: number }
  | { kind: 'host'; seat: string; handle: string; who: string; name: string; at: number }

/**
 * Guest: a message one of this person's sessions wrote here, relayed to the
 * host's session: the message id its session gave it (`id`, which the host's
 * Claude Code's receipts name; `native` false when it couldn't be read and
 * this one is new), the turn it plays in here (`pid`), its handle and that
 * session's address (`to`), and whether a hold went back to that session.
 */
export type SharePeerRelay = { id: string; pid: string; handle: string; to: string; native: boolean; held?: true; at: number }

/**
 * Guest: a message this session sent one of this person's sessions, in the
 * order sent: a reply of the host's session's (its `handle` and message id,
 * `ref`) or a note of this plugin's (neither), and the message id Claude
 * Code gave it once one of its delivery notices named it.
 */
export type SharePeerSend = { to: string; at: number; handle?: string; ref?: string; id?: string }

/** Host: the mailboxes' helper running for a room (detached), which a reload ends by its pid. */
export type ShareMailboxHelper = { room: string; pid: number; port: number }

/** Guest: the ports the preview window asked the host about in the room it's in (once each), and when (five a minute). */
export type ShareNeedAsked = { ports: number[]; times: number[] }

/** Host: a question in the row above the prompt about sharing more of this machine's localhost. Only a proposal: the host's press shares. */
export type ShareHostAsk = {
  id: string
  /** `related`: what a shared port also uses; `mention`: forward a port Claude's mention shared as a page; `need`: a guest's preview asked for it. */
  kind: 'related' | 'mention' | 'need'
  port: number
  label?: string
  /** The guest whose preview asked (`need`). */
  who?: string
  /** `related`: the ports of the one service beside the page that a yes forwards, three at most (a service a question: one process, so a backend on two ports is one question; one on more ports, a question each three, in turn); empty for `mention` and `need`, whose yes forwards `port`. */
  related: { port: number; label: string }[]
}

/**
 * Guest: a localhost listener to restore, without its process or
 * credentials, saved once the Open (or the restore) that brought it up was
 * done.
 */
export type ShareLocalPreview = {
  pid: string
  /** Host's target port. */
  port: number
  /** Its actual local port (0.11.24 binds there first): a reload or resume binds exactly there again, or not at all. */
  localPort?: number
  /**
   * 0.11.24's Local port, a port the person chose (which it binds exactly).
   * No longer written; read only where `localPort` is missing (0.11.24
   * saved a chosen port before its listener was up), as where it was.
   */
  requestedPort?: number
  /**
   * What a page uses, opened by its own Open (its row in Room → Shown), not
   * only for a page: it stays when a page that uses it is Closed or Stopped.
   * Absent from what 0.11.24 and older saved.
   */
  own?: true
}

/** The person signed in to the share server (GitHub or Google). */
export type ShareAccount = { id: string; name: string; login?: string; email?: string; provider: string }

/** A team, as one of its people sees it (domains and orgs: owners only). */
export type ShareTeam = {
  id: string
  name: string
  role: 'owner' | 'member'
  /** `members`: only people in the team join its sessions; `link`: anyone with a link. */
  access: 'members' | 'link'
  domains?: string[]
  githubOrgs?: string[]
  invite: string
}

/** A session shared with a team, as the team's list shows it. */
export type ShareTeamSession = { id: string; url: string; title: string; host: string; hostAccount?: string; hostOnline: boolean; people: string[]; /** Who's in it by account. */ accounts?: string[]; createdAt: number }

/** A host's invite to a session, as the invitee's Claude Code shows it. */
export type ShareInvite = { room: { id: string; url: string; title: string; host: string }; from: { name: string }; at: number }

/** The Team panel: who's signed in, their teams, and what's shared with the one shown. */
export type ShareTeams = {
  /** The share server these are on. */
  server: string
  account: ShareAccount | null
  teams: ShareTeam[]
  /** The team the panel shows, and Share goes to unless `byLink`. */
  current: string | null
  /** Share goes by link alone, not to the team. */
  byLink: boolean
  sessions: ShareTeamSession[]
  members: { id: string; name: string; login?: string; role: 'owner' | 'member' }[]
  /** Everyone who shares a team with you: whom you can invite to a session. */
  teammates?: { id: string; name: string; login?: string }[]
  /** Who the server signs people in with. */
  providers: { id: string; label: string }[]
  /**
   * A sign-in waiting in the browser. `code`: what the server's page shows
   * too (the first eight hex of the hash sent, `XXXX-XXXX`), to continue
   * only if they match; absent in one an older version began.
   */
  signingIn: { provider: string; url: string; until: number; code?: string } | null
  /** An invite link to take once signed in. */
  invite: { server: string; code: string } | null
  /** When the list was last asked for, ms since the epoch (0: never). */
  loaded: number
  error: string | null
  /** The panel's new-team field is open. */
  creating?: boolean
  /** Rooms another session on this computer is in, and as what. */
  here?: Record<string, 'host' | 'guest'>
}

declare module 'claude-code' {
  interface PluginState {
    'shared-session': {
      mode: ShareMode
      room: ShareRoom | null
      people: SharePerson[]
      working: ShareWorking | null
      activity: ShareActivity[]
      chat: ShareChat[]
      /** Chat lines that arrived while the Room panel was closed. */
      unread: number
      policy: SharePolicy
      /** Guests whose tool calls the host allowed for the rest of the session. */
      trusted: string[]
      /** Host: who each tool call of a guest's turn was for, by tool_use_id. */
      owners: Record<string, string>
      /**
       * What the host's Claude showed, newest last (the Room panel's Files):
       * the newest 40 of what isn't an open preview, and every open preview
       * (the newest 128). A guest's is what the host forwards, too: the
       * window's authority, Open preview's list and a restore's.
       */
      shown: ShareShown[]
      /** Guest: open what the host's Claude shows without asking (default), or ask each time. */
      autoOpen: boolean
      /** Host: what this session shares, by port: its preview, and whether (and as what) it's forwarded. */
      shares: Record<string, HostShare>
      /** 0.11.24's (host): the previews it shared, port → preview id. An update in place moves them into `shares` as it loads, and empties them; nothing else is kept here. */
      previews: Record<string, string>
      /** 0.11.24's (host): the shared ports it forwarded over raw TCP, moved into `shares` with `previews`. */
      forwardPorts: string[]
      /** An unreleased build's (host): the shared previews whose server speaks TLS, by preview id, moved into `shares` with `previews`. */
      previewSchemes: Record<string, 'https'>
      /** Guest: previews opened on this machine's localhost, restored after reload/resume. */
      localPreviews: ShareLocalPreview[]
      /** Guest: the room's preview window, its proxy port kept through a reload. */
      previewWindow: SharePreviewWindow | null
      /** Guest: previews whose authorization was refused in the window: only an explicit Open reconnects them. */
      previewNeedsOpen: string[]
      /** Host: the question in the row above the prompt about sharing another port, one at a time. */
      hostAsk: ShareHostAsk | null
      /** Host: what the host said about sharing more in this room. */
      hostMemory: ShareHostMemory | null
      /** Guest: the ports the preview window asked the host about. */
      needAsked: ShareNeedAsked | null
      /** Messages between sessions: the host's mailboxes, or a guest's handles, by id (the newest 64): whose each is. */
      peerRoutes: Record<string, SharePeerRoute>
      /** Guest: messages relayed to the host's session (the newest 64). */
      peerRelays: SharePeerRelay[]
      /** Guest: messages sent to this person's other sessions (the newest 64). */
      peerSends: SharePeerSend[]
      /** Host: the mailboxes' helper this module started. */
      mailboxHelper: ShareMailboxHelper | null
      /** Claude Desktop's sidebar row as it was before sharing marked it, to put back. */
      sidebar: { title: string; pinned: boolean; id?: string; /** The pin sharing or joining made took. */ pinOk?: boolean } | null
      /** Share was pressed in a session with history: the row asks whether to include it. */
      asking: { prompts: number } | null
      /** Whether this session hears the room: `live`, or `reconnecting` after failed tries. */
      connection: 'live' | 'reconnecting'
      /** Guest, in a terminal: replayed reads, searches and commands folded into count lines, or each drawn. */
      toolRows: 'grouped' | 'each'
      /** Guest: per replayed call (by tool_use_id), its run's tools on the first call, `hidden` on the rest. */
      replayRun: StateFamily<{ tools?: string[]; hidden?: true } | null>
      /** Host: a teammate's tool call waiting for an answer in the row above the prompt (the question dialog didn't show): the oldest waiting there, its id (what its buttons answer), whose, what its one line leaves out (`extent`: a command's lines after its first, an edit's or a new file's size; the Room shows it whole), and how many more wait after it. */
      approving: { id: string; who: string; what: string; extent?: string; always: string; more: number } | null
      /** Host: a teammate's calls put to the host and not answered yet, by tool_use_id (the newest 64). A hook whose module ends under it has its `.catch` asked in the module after it, which denies these. */
      unanswered: string[]
      /** The hooks module that started last in this session, by its own id. A module a reload replaced finds another here, declines the calls still waiting in its row, whose buttons are now the new module's, and stops hearing the room. */
      module: string | null
      /** Host: whose each agent is, by its loop's id (the newest 200): the teammate whose turn or agent started it, '' for the host's own. Its calls are put to the host as theirs, whatever turn runs by then; the host's own, or one not here, are the running turn's. */
      agents: Record<string, string>
      /** Host: teammates' prompts waiting to go to Claude, one turn each, oldest first; the first is `sent` once submitted, until its turn starts, and one that hasn't started a while on is `aside` (the newest 8), known still when it does. */
      guestPrompts: ShareGuestPrompt[]
      /** The main loop's turn running now, by its id, whatever the mode: a teammate's prompt goes to Claude only once none runs. */
      turn: string | null
      /** A button pressed once that ends something for everyone, waiting for its second press. */
      confirming: 'stop' | null
      /**
       * A way out of the room under way (`closeRoom`): how, and its room
       * (`server/id`). Written as the close begins, just before the mode
       * goes idle; cleared with the room's state. A start that finds it (a
       * reload cut the close short) finishes the close; one naming another
       * room than the one set clears nothing.
       */
      closing: { how: 'leave' | 'stop' | 'ended' | 'keep' | 'clear'; room: string } | null
      /** A newer plugin than this one, as the share server last said. */
      newer: string | null
      /** Whether Claude Code updates this plugin by itself (the marketplace's `autoUpdate`); null when unknown. */
      updates: boolean | null
      /** Updates in place: this session runs the copy that updates itself (`running`), or new sessions will (`next`). */
      liveUpdates: 'running' | 'next' | 'pinned' | null
      /** Pages the host's Claude published, by artifact id: what goes to the room again when one is opened again. */
      pages: Record<string, Record<string, unknown>>
      /** The Team panel's sign-in, teams and team sessions. */
      teams: ShareTeams
      /** Sessions teammates invited you to, newest first, until joined or dismissed. */
      invites: ShareInvite[]
      /** Host: teammates invited to this session, by account id, and when. */
      invited: Record<string, number>
      /** Claude Code (auto mode) wouldn't let this session be pinned: the Room offers to allow it. */
      pinRefused: boolean
      /** Auto mode refused the plugin's call to Claude's browser: not tried again until an allow rule names it, which the Room offers to add. */
      paneRefused: boolean
      /** Guest: a forwarded preview whose window (Always a separate window) couldn't open, and why: Open anyway, above the prompt, opens it without one. */
      windowFailed: { pid: string; reason: string } | null
      /** The Room's page showing: who's here, the chat, every turn, the files changed, what Claude showed, or the settings. */
      roomTab: 'people' | 'chat' | 'timeline' | 'changes' | 'shown' | 'settings'
      /** Every turn of the session, oldest first (the newest 200). */
      turns: ShareTurn[]
      /** The files Claude changed, newest last (the newest 40). */
      changes: ShareChange[]
      /** Reactions to Claude's replies: by the reply's key, by emoji, who. */
      reactions: Record<string, Record<string, string[]>>
      /** Who has had each reply on screen, by the reply's key. */
      seen: Record<string, string[]>
      /** Who each of Claude's replies was for, by message id. */
      replyFor: Record<string, string>
      /** Tool calls Claude made this session. */
      calls: number
      /** The file open on the Room's Changes page. */
      changeOpen: string | null
      /** The link was just copied: the Room's Copy says so for a moment. */
      copied: boolean
      /** What this person hears and sees of the room. */
      prefs: SharePrefs
      /** The Team panel's page showing: live sessions, the team's people, or the settings. */
      teamTab: 'live' | 'people' | 'settings'
    }
  }
}
