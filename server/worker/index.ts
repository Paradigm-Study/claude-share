// Cloudflare Worker + one Durable Object per shared session.
// Deploy with `npx wrangler deploy` (see wrangler.toml at the repo root).
//
// Open streams cost nothing while a room is quiet. A client's stream ends at
// the Worker, which is billed for CPU, not for time held open; the Worker
// talks to the room over a WebSocket the Durable Object accepts with the
// hibernation API, so the room leaves memory between changes and the next
// request or message wakes it. Its only timers: settle a seat that
// disconnected once its grace period is over, and drop the room a day after
// the host was last seen.
//
// Previews run on a second Worker from this same script (ROLE = "preview",
// wrangler.preview.toml), its own workers.dev host name, bound to the rooms
// here: every path there is the host's app.
//
// Accounts and teams (server/teams.ts) live in one more Durable Object, the
// directory: sign-in, teams and their lists of sessions. Rooms ask it who may
// share with a team and join one; it asks rooms how they are when listing.
// They call each other's methods (Durable Object RPC), never a path: what
// only the objects say to each other has no URL the Worker could forward.

export { default } from './app.ts'
export { RoomObject, metaOf } from './room-object.ts'
export { HostContainer } from './host-container.ts'
export { GateObject } from './gate.ts'
export { DirectoryObject } from './directory.ts'
export type { ServerEnv } from './env.ts'
