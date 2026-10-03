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
}

export type SharePerson = { id: string; name: string; role: 'host' | 'guest'; online: boolean }

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
  kind: 'join' | 'leave' | 'prompt' | 'allowed' | 'denied' | 'stop' | 'policy'
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
      /** Claude Desktop's sidebar row as it was before sharing marked it, to put back. */
      sidebar: { title: string; pinned: boolean } | null
    }
  }
}
