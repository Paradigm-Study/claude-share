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
}

export type SharePerson = { id: string; name: string; role: 'host' | 'guest'; online: boolean; /** Their plugin's version, as the room heard it. */ version?: string }

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
}

/** One line of the Room panel's timeline. */
export type ShareActivity = {
  ts: number
  who: string
  kind: 'join' | 'leave' | 'prompt' | 'allowed' | 'denied' | 'stop' | 'policy' | 'shown'
  text?: string
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
  ts: number
  files?: ShareFileMeta[]
  pid?: string
  port?: number
  /** A preview's page: where its links land. */
  path?: string
  url?: string
  /** A preview the host has stopped. */
  closed?: boolean
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
export type ShareTeamSession = { id: string; url: string; title: string; host: string; hostAccount?: string; hostOnline: boolean; people: string[]; createdAt: number }

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
  /** Who the server signs people in with. */
  providers: { id: string; label: string }[]
  /** A sign-in waiting in the browser. */
  signingIn: { provider: string; url: string; until: number } | null
  /** An invite link to take once signed in. */
  invite: { server: string; code: string } | null
  /** When the list was last asked for, ms since the epoch (0: never). */
  loaded: number
  error: string | null
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
      /** What the host's Claude showed, newest last (the Room panel's Files). */
      shown: ShareShown[]
      /** Guest: open what the host's Claude shows without asking (default), or ask each time. */
      autoOpen: boolean
      /** Host: the previews this session shares, port → preview id. */
      previews: Record<string, string>
      /** Claude Desktop's sidebar row as it was before sharing marked it, to put back. */
      sidebar: { title: string; pinned: boolean; id?: string } | null
      /** Share was pressed in a session with history: the row asks whether to include it. */
      asking: { prompts: number } | null
      /** Whether this session hears the room: `live`, or `reconnecting` after failed tries. */
      connection: 'live' | 'reconnecting'
      /** Guest, in a terminal: replayed reads, searches and commands folded into count lines, or each drawn. */
      toolRows: 'grouped' | 'each'
      /** Guest: per replayed call (by tool_use_id), its run's tools on the first call, `hidden` on the rest. */
      replayRun: StateFamily<{ tools?: string[]; hidden?: true } | null>
      /** Host: a teammate's tool call waiting for an answer in the row above the prompt (the question dialog didn't show). */
      approving: { who: string; what: string; always: string } | null
      /** A button pressed once that ends something for everyone, waiting for its second press. */
      confirming: 'stop' | null
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
    }
  }
}
