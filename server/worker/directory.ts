// DirectoryObject: accounts and teams (server/teams.ts) in one Durable Object.

import { DurableObject } from 'cloudflare:workers'
import { ROOM_ID, json, readBody } from '../core/index.ts'
import { Directory, providersFrom } from '../teams.ts'
import { nativePoolConfig, NATIVE_POOL_BODY_MAX } from '../native-pool.ts'
import type { Kv, RoomInfo } from '../teams.ts'
import type { ServerEnv } from './env.ts'

export class DirectoryObject extends DurableObject<ServerEnv> {
  state: DurableObjectState
  directory: Directory

  constructor(state: DurableObjectState, env: ServerEnv) {
    super(state, env)
    this.state = state
    const storage = state.storage
    const kv: Kv = {
      get: key => storage.get(key),
      put: (key, value) => storage.put(key, value),
      delete: key => storage.delete(key),
      list: async prefix => [...(await storage.list({ prefix })).entries()],
    }
    // How a room is, for a team's list: its own info, or nothing once it's gone.
    const roomInfo = async (id: string): Promise<RoomInfo | null> => ROOM_ID.test(id) ? env.ROOMS.get(env.ROOMS.idFromName(id)).info() : null
    // A members-only team's people now, for its room to let the others go.
    const keepTeam = async (id: string, team: string, allowed: string[]) => {
      if (!ROOM_ID.test(id)) return
      await env.ROOMS.get(env.ROOMS.idFromName(id)).keepTeam(team, allowed)
    }
    // What's timed goes when it's due: the alarm is set for the soonest.
    const onDue = (at: number) => void this.wakeAt(at).catch(() => {})
    this.directory = new Directory(kv, { providers: providersFrom(env), roomInfo, keepTeam, onDue, nativePool: nativePoolConfig(env) })
  }

  async wakeAt(at: number) {
    const set = await this.state.storage.getAlarm()
    if (!set || at + 1000 < set) await this.state.storage.setAlarm(at + 1000)
  }

  override async alarm() {
    const next = await this.directory.sweep(Date.now())
    if (next) await this.wakeAt(next)
  }

  // What a room asks (Directory's own methods, the same names).
  shareCheck(teamId: string, tokenText: string) { return this.directory.shareCheck(teamId, tokenText) }
  joinCheck(teamId: string, tokenText: string) { return this.directory.joinCheck(teamId, tokenText) }
  whoIs(tokenText: string) { return this.directory.whoIs(tokenText) }
  teamAccess(teamId: string) { return this.directory.teamAccess(teamId) }
  sessionInvite(tokenText: string, room: Parameters<Directory['sessionInvite']>[1], to: unknown) { return this.directory.sessionInvite(tokenText, room, to) }
  roomEnded(roomId: string, teamId: string | null) { return this.directory.roomEnded(roomId, teamId) }
  register(teamId: string, room: Parameters<Directory['register']>[1]) { return this.directory.register(teamId, room) }
  unregister(teamId: string, roomId: string) { return this.directory.unregister(teamId, roomId) }

  override async fetch(req: Request) {
    const path = new URL(req.url).pathname
    // Only a private Durable Object binding can reach these. The public
    // Worker forwards Directory.owns paths alone, which excludes /rpc/.
    if (path === '/rpc/consumeNativePoolGrant' || path === '/rpc/nativePoolMembership') {
      if (req.method !== 'POST') return json({ result: { ok: false, status: 405, error: 'POST required.' } }, 405)
      let args: unknown
      try { args = JSON.parse(new TextDecoder().decode(await readBody(req, NATIVE_POOL_BODY_MAX))) } catch { return json({ result: { ok: false, status: 400, error: 'Invalid request.' } }, 400) }
      if (!Array.isArray(args) || args.length !== 3 || !args.every(value => typeof value === 'string')) return json({ result: { ok: false, status: 400, error: 'Invalid arguments.' } }, 400)
      const result = path === '/rpc/consumeNativePoolGrant'
        ? await this.directory.nativePool.consume(args[0], args[1], args[2])
        : await this.directory.nativePool.member(args[0], args[1], args[2])
      return json({ result })
    }
    return this.directory.handle(req, req.headers.get('x-share-origin') ?? new URL(req.url).origin)
  }
}
