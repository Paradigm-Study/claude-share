// The shapes the room's modules and their adapters (server/worker/) pass between
// them. A request's JSON is the sender's to shape: it's `JsonObject`, and
// every route checks what it reads.

export type JsonObject = { [key: string]: any }

export type Role = 'host' | 'guest'
// Who a request is, once its token is known.
export type Auth = { role: Role; seat: string; name: string }
// Who an event is from, as the room stamps it.
export type From = { seat: string; name: string; role: Role; approver?: boolean }
export type RoomEvent = { seq: number; type: string; from: From; ts: number; body: JsonObject }

export type Host = { name: string; token: string; lastSeen: number; version?: string; account?: string }
export type Seat = { id: string; name: string; joinedAt: number; lastSeen: number; version?: string; account?: string }
// Shared with a team: `account` is the host's, who shared it.
export type RoomTeam = { id: string; name: string; account?: string }
export type FileMeta = { id: string; name: string; type: string; size: number; ts: number }
export type CloudState = 'starting' | 'running' | 'stopped'
export type Cloud = {
  state: CloudState
  approver: { seat: string; account: string | null; name: string }
  since: number
  until: number
  changes?: FileMeta | null
}
export type Preview = { pid: string; port: number; title: string; ts: number; tcp?: boolean }
// A browser's session on the public link.
export type PreviewSession = { pid: string; exp: number; seat: string }
// A link that opens a preview in one browser.
export type Ticket = { pid: string; exp: number; path: string; seat: string; used?: boolean; clear?: boolean }
// A minute's count, wherever one is kept.
export type Minute = { start: number; count: number }
export type TCPStats = { used: number; refunded?: number; opens: Minute; served?: { day: string; reserved: number } }
// What a revocation covers: every field it names must match; none covers all.
export type RevokeFilter = { pid?: string; seat?: string; session?: string }

// A room as it's saved, and loaded again.
export type RoomData = {
  id: string
  title: string
  host: Host
  createdAt: number
  endedAt?: number | null
  fromNow?: boolean
  team?: RoomTeam | null
  cloud?: Cloud | null
  seq?: number
  events?: RoomEvent[]
  seats?: Record<string, Seat>
  away?: Record<string, Seat>
  leftElsewhere?: Record<string, number>
  files?: Record<string, FileMeta>
  previews?: Record<string, Preview>
  previewKey?: string
  previewSessions?: Record<string, PreviewSession>
  tickets?: Record<string, Ticket>
  tcpStats?: TCPStats
}

// Where file bytes live: memory, or a Durable Object's storage.
export type FileStore = {
  put(id: string, data: Uint8Array, meta: FileMeta): Promise<void>
  get(id: string): Promise<{ data: Uint8Array } | null>
}
// An open stream this process serves.
export type Subscriber = { seat: string; push: () => void; send: (message: unknown) => void }
// A poll waiting for the room to change.
export type Waiter = { after: number; seat: string; done: () => void; timer?: ReturnType<typeof setTimeout> }
// A proxied request in flight, answered once; `seat` is the asking browser's.
export type Settle = ((response: Response) => void) & { seat: string }

// What a route answers; `changed` tells the adapter to save the room.
export type RouteResult = { response: Response; changed?: boolean }

type Refusal = { ok: false; status: number; error: string; team?: string }
type Person = { id: string; name: string }
// What the room lists on its team's list.
export type TeamListing = { id: string; url: string; title: string; host: string; hostAccount?: string; createdAt: number }
// What a room asks the directory and tells it (teams.ts, `Directory`).
export type DirectoryClient = {
  shareCheck(teamId: string, account: string): Promise<{ ok: true; team: { id: string; name: string }; account: Person } | Refusal>
  joinCheck(teamId: string, account: string): Promise<{ ok: true; account?: Person } | Refusal>
  whoIs(account: string): Promise<Person | null>
  teamAccess(teamId: string): Promise<string | null>
  sessionInvite(
    account: string,
    room: { id: string; url: string; title: string; host: string },
    to: unknown,
  ): Promise<{ ok: true; invited: string[]; refused: string[] } | Refusal>
  roomEnded(roomId: string, teamId: string | null): Promise<void>
  register(teamId: string, room: TeamListing): Promise<void>
  unregister(teamId: string, roomId: string): Promise<void>
}

// The cloud host's runner, which the room server starts and stops.
export type CloudConfig = {
  server: string
  room: string
  token: string
  session: string
  cwd: string
  title: string
  host: string
  url: string
  seq: number
  model: string
  state: JsonObject
  auth: CloudAuth
  plugin: { version: string; source: string }
}
export type CloudAuth = { oauthToken: string } | { apiKey: string } | { baseUrl: string; authToken: string }
export type CloudHosts = {
  start(id: string, payload: { ticket: string; config: CloudConfig }): Promise<void>
  stop(id: string): Promise<Uint8Array | ArrayBuffer>
}

// What the adapter hands a room's request: what it can reach, and how.
export type RoomContext = {
  // Where previews are served; absent, previews are off.
  previewOrigin?: string
  admin?: boolean
  directory?: DirectoryClient | null
  // False once the adapter replaced this room (an expiry, an end elsewhere).
  isCurrent?: () => boolean
  cloud?: CloudHosts | null
  pluginSource?: string
}
