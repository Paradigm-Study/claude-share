// What the plugin and the room server say to each other, typed on both sides:
// the plugin imports it here, and server/core/types.ts with `import type`, so
// the plugin still stands alone and nothing of this exists at runtime.
//
// A body is what its sender shaped, and the room passes it on clamped, not
// checked: an older or newer plugin may leave out a field or add one. So every
// field is optional, whoever reads one still checks it, and what isn't listed
// reads as unknown.

declare const brand: unique symbol
type Brand<T, Name extends string> = T & { readonly [brand]: Name }

/** A room's id, which joins it: in share links and paths. */
export type RoomId = Brand<string, 'RoomId'>
/** A seat's id, which everyone in the room sees: `host`, or a guest's. */
export type SeatId = Brand<string, 'SeatId'> | 'host'
/** A seat's secret token, which only that seat holds. Never in an event. */
export type Bearer = Brand<string, 'Bearer'>

export type Role = 'host' | 'guest'
/** `approver`: a prompt from the cloud host's approver, as the room says. */
export type EventFrom = { seat: SeatId; name: string; role: Role; approver?: boolean }

type Fields<Known> = Known & Record<string, unknown>

/** Each event's body, by its type. */
export type RoomEventBodies = {
  // The host's.
  row: Fields<{ kind?: string; text?: string; who?: string; id?: string; tool?: string }>
  delta: Fields<{ turnId?: string; text?: string; thinking?: string; drafting?: { tool?: string; target?: string; chars?: number } }>
  turn: Fields<{ state?: 'start' | 'end'; turnId?: string; aborted?: boolean; durationMs?: number; reason?: string }>
  approval: Fields<{ pending?: boolean; what?: string }>
  title: Fields<{ title?: string }>
  policy: Fields<{ prompts?: string; approvals?: string; files?: string }>
  declined: Fields<{ pid?: string; who?: string; reason?: string }>
  artifact: Fields<{ turnId?: string }>
  ask: Fields<{ id?: string; done?: boolean; kind?: string }>
  // A guest's.
  prompt: Fields<{ text?: string; pid?: string }>
  stop: Fields<{}>
  answer: Fields<{ id?: string; answer?: string }>
  set: Fields<{}>
  // Either's.
  chat: Fields<{ text?: string }>
  react: Fields<{ key?: string; emoji?: string }>
  seen: Fields<{ keys?: string[] }>
  // The room's own.
  join: Fields<{}>
  leave: Fields<{ reason?: string }>
  ended: Fields<{}>
  preview: Fields<{ pid?: string; port?: number; state?: string; title?: string }>
  cloud: Fields<{ state?: string; by?: string; why?: string; changes?: string | null }>
}
export type RoomEventType = keyof RoomEventBodies
/** What each seat may post (the room's HOST_TYPES and GUEST_TYPES). */
export type HostEventType = 'row' | 'delta' | 'turn' | 'approval' | 'title' | 'policy' | 'declined' | 'chat' | 'artifact' | 'react' | 'seen' | 'ask'
export type GuestEventType = 'prompt' | 'stop' | 'chat' | 'react' | 'seen' | 'answer' | 'set'
export type PostedEventType = HostEventType | GuestEventType

/** One event in a room's feed: its `type` says its `body`'s shape. */
export type RoomEvent = { [T in RoomEventType]: { seq: number; type: T; from: EventFrom; ts: number; body: RoomEventBodies[T] } }[RoomEventType]
