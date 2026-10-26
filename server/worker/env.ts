// What every part of the Worker reads from its environment.

import type { TracesEnv } from '../traces/index.ts'
import type { RoomObject } from './room-object.ts'
import type { DirectoryObject } from './directory.ts'

// What the Workers are given: wrangler.toml's bindings and variables,
// wrangler.preview.toml's ROLE, and the secrets a person sets. The optional
// ones are what a server may go without (a preview Worker, no teams, no
// containers, no traces).
export type ServerEnv = Omit<TracesEnv, 'DIRECTORY'> & {
  ROLE?: string
  PUBLIC_URL?: string
  PREVIEW_URL?: string
  NEW_ROOMS?: string
  MAX_ROOMS_PER_DAY?: string
  ADMIN_TOKEN?: string
  PLUGIN_SOURCE?: string
  NATIVE_POOL_TEAM_ID?: string
  NATIVE_POOL_URL?: string
  CREATE_LIMIT: RateLimit
  JOIN_LIMIT: RateLimit
  EVENTS_LIMIT: RateLimit
  ROOMS: DurableObjectNamespace<RoomObject>
  // Reached by fetch alone (not RPC objects), so their stubs aren't typed by class.
  GATE?: DurableObjectNamespace
  DIRECTORY?: DurableObjectNamespace<DirectoryObject>
  HOSTS?: DurableObjectNamespace
}
// Session traces (server/traces): loaded only where a database is bound.
export const tracesOn = (env: ServerEnv | undefined) => Boolean(env?.TRACES_DB && env?.OAUTH_KV)
export const traces = () => import('../traces/index.ts')

export const hasDirectory = (env: ServerEnv): env is ServerEnv & { DIRECTORY: DurableObjectNamespace<DirectoryObject> } => Boolean(env.DIRECTORY)

// The one directory of accounts and teams.
export const directoryStub = (env: ServerEnv & { DIRECTORY: DurableObjectNamespace<DirectoryObject> }) =>
  env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'))

// What a room asks the directory: its stub, whose methods are the
// DirectoryObject's below.
export const directoryClient = (env: ServerEnv | undefined) => (env && hasDirectory(env) ? directoryStub(env) : null)
