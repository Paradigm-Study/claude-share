// One-time enrollment in a separate native subscription pool. The Share
// sign-in stays here; the pool receives a short-lived, verifier-bound grant.
import { json, readBody, token } from './core/index.ts'
import { sha256 } from './core/http.ts'
import type { Kv, Team } from './teams.ts'

export type NativePoolConfig = { teamId: string; server: string }
type Grant = { account: string; team: string; challenge: string; device: string; server: string; exp: number }
type Refused = { ok: false; status: number; error: string }
type Consumed = { ok: true; account_id: string; team_id: string; device_name: string; expires_at: number }
const ID = /^[A-Za-z0-9_-]{8,40}$/
const GRANT = /^[A-Za-z0-9_-]{43}$/
const VERIFIER = /^[A-Za-z0-9_-]{32,128}$/
const CHALLENGE = /^[0-9a-f]{64}$/
export const NATIVE_POOL_BODY_MAX = 2048
const GRANT_MS = 120_000
const OUTSTANDING = 5
const digest = (text: string) => sha256(new TextEncoder().encode(text))
const refused = (status: number, error: string): Refused => ({ ok: false, status, error })

// This is an origin, not an arbitrary redirect or an address supplied by a
// joining client. A misconfigured deployment fails closed.
export function nativePoolConfig(env: { NATIVE_POOL_TEAM_ID?: string; NATIVE_POOL_URL?: string }): NativePoolConfig | null {
  if (!ID.test(env.NATIVE_POOL_TEAM_ID ?? '')) return null
  try {
    const url = new URL(env.NATIVE_POOL_URL ?? '')
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
    return { teamId: env.NATIVE_POOL_TEAM_ID!, server: url.origin }
  } catch { return null }
}

export class NativePoolGrants {
  kv: Kv
  config: NativePoolConfig | null
  onDue: (at: number) => void
  tail: Promise<unknown> = Promise.resolve()

  constructor(kv: Kv, config: NativePoolConfig | null, onDue: (at: number) => void) {
    this.kv = kv
    this.config = config
    this.onDue = onDue
  }

  // Storage reads and hashes yield. Serialize issuance and consumption so
  // simultaneous requests cannot exceed the cap or collect a grant twice.
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run)
    this.tail = result.catch(() => {})
    return result
  }

  async member(accountId: unknown, teamId: unknown, server: unknown): Promise<{ ok: boolean } | Refused> {
    const config = this.config
    // The pool revokes a device on a definitive nonmembership result. A
    // configuration outage or mismatched deployment cannot establish that
    // someone left the team; report an error so the pool pauses instead.
    if (!config || teamId !== config.teamId || server !== config.server) return refused(503, 'Native pool membership configuration is unavailable or does not match.')
    if (typeof accountId !== 'string' || !ID.test(accountId)) return refused(400, 'Invalid account identifier.')
    const account = await this.kv.get(`acct:${accountId}`)
    const team: Team | undefined = await this.kv.get(`team:${config.teamId}`)
    const member = await this.kv.get(`mem:${config.teamId}:${accountId}`)
    return { ok: Boolean(account?.id === accountId && team?.id === config.teamId && (member?.role === 'owner' || member?.role === 'member')) }
  }

  async enroll(accountId: string, req: Request, now: number): Promise<Response> {
    let body: unknown
    try { body = JSON.parse(new TextDecoder().decode(await readBody(req, NATIVE_POOL_BODY_MAX))) } catch { return json({ error: 'Invalid enrollment request.' }, 400) }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'challenge,device_name') return json({ error: 'Provide only challenge and device_name.' }, 400)
    const { challenge, device_name: device } = body as Record<string, unknown>
    if (typeof challenge !== 'string' || !CHALLENGE.test(challenge) || typeof device !== 'string' || !device.trim() || device !== device.trim() || device.length > 80 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(device)) return json({ error: 'Invalid challenge or device name.' }, 400)
    return this.serial(async () => {
      const config = this.config
      if (!config) return json({ error: 'Native subscription enrollment is not configured.' }, 503)
      if (!(await this.member(accountId, config.teamId, config.server)).ok) return json({ error: 'Membership in the configured Claude Share team is required.' }, 403)
      let outstanding = 0
      // The record is the source of truth. No second index can be left out
      // by an interrupted write and accidentally bypass the account cap.
      for (const [key, record] of await this.kv.list('npgrant:')) {
        if (record.account !== accountId) continue
        if (!(record.exp > now)) await this.kv.delete(key)
        else outstanding++
      }
      if (outstanding >= OUTSTANDING) return json({ error: 'Too many pending enrollments. Try again in two minutes.' }, 429)
      const grant = token(32)
      const hash = await digest(grant)
      // Recheck after the waits above: domain rules and link-access are never
      // substitutes for the current account and its actual membership row.
      if (!(await this.member(accountId, config.teamId, config.server)).ok) return json({ error: 'Team membership is no longer active.' }, 403)
      const record: Grant = { account: accountId, team: config.teamId, challenge, device, server: config.server, exp: now + GRANT_MS }
      await this.kv.put(`npgrant:${hash}`, record)
      this.onDue(record.exp)
      const team: Team = await this.kv.get(`team:${config.teamId}`)
      return json({ grant, expires_at: Math.floor(record.exp / 1000), pool_server: config.server, team: { id: config.teamId, name: team?.name ?? 'Team' } })
    })
  }

  consume(grant: unknown, verifier: unknown, server: unknown, now = Date.now()): Promise<Consumed | Refused> {
    return this.serial(async () => {
      if (typeof grant !== 'string' || !GRANT.test(grant) || typeof verifier !== 'string' || !VERIFIER.test(verifier)) return refused(400, 'Invalid enrollment proof.')
      const config = this.config
      if (!config || server !== config.server) return refused(403, 'The pool is not authorized.')
      const hash = await digest(grant)
      const record: Grant | undefined = await this.kv.get(`npgrant:${hash}`)
      if (!record) return refused(401, 'Enrollment grant is unavailable.')
      if (!(record.exp > now)) {
        await this.kv.delete(`npgrant:${hash}`)
        return refused(401, 'Enrollment grant has expired.')
      }
      if (record.server !== server || record.team !== config.teamId || await digest(verifier) !== record.challenge) return refused(403, 'Enrollment proof does not match.')
      const allowed = await this.member(record.account, record.team, server)
      await this.kv.delete(`npgrant:${hash}`)
      if (!allowed.ok) return refused(403, 'Team membership is no longer active.')
      return { ok: true, account_id: record.account, team_id: record.team, device_name: record.device, expires_at: Math.floor(record.exp / 1000) }
    })
  }

  sweep(now: number): Promise<number | null> {
    return this.serial(async () => {
      let next: number | null = null
      for (const [key, record] of await this.kv.list('npgrant:')) {
        if (!(record?.exp > now)) await this.kv.delete(key)
        else if (next === null || record.exp < next) next = record.exp
      }
      return next
    })
  }
}
