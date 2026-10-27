import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { Directory, mapStore } from '../server/teams.ts'
import type { Account, Team } from '../server/teams.ts'
import { nativePoolConfig, NATIVE_POOL_BODY_MAX } from '../server/native-pool.ts'
import worker, { DirectoryObject } from '../server/worker/index.ts'
import type { ServerEnv } from '../server/worker/index.ts'

const teamId = 'B-pTJOWkq5wl'
const pool = 'https://pool.example'
const accountId = 'member_account_1'
const now = 1_800_000_000_000
const verifier = 'v'.repeat(43)
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const proof = { challenge: sha(verifier), device_name: 'Teammate’s Mac' }

async function fixture() {
  const data = new Map<string, any>()
  const due: number[] = []
  const kv = mapStore(data)
  const directory = new Directory(kv, { nativePool: { teamId, server: pool }, onDue: at => due.push(at) })
  const account: Account = {
    id: accountId,
    provider: 'test',
    subject: accountId,
    name: 'Member',
    email: 'member@else.example',
    emailVerified: true,
    githubOrgs: [],
    createdAt: now,
    seenAt: now,
  }
  const team: Team = { id: teamId, name: 'Paradigm', createdAt: now, access: 'link', invite: 'test_invite' }
  data.set(`acct:${accountId}`, account)
  data.set(`team:${teamId}`, team)
  await directory.addMember(teamId, accountId, 'member', now)
  const token = await directory.mint(accountId, now)
  const at = (body: unknown = proof, when = now, auth: string | null = token) =>
    directory.handle(
      new Request('https://share.example/api/native-pool/enrollment', {
        method: 'POST',
        headers: auth ? { authorization: `Bearer ${auth}` } : {},
        body: JSON.stringify(body),
      }),
      'https://share.example',
      when,
    )
  const issue = async (when = now) => {
    const response = await at(proof, when)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return response.json<{ grant: string; expires_at: number; pool_server: string; team: { id: string; name: string } }>()
  }
  return { data, kv, directory, due, token, at, issue }
}

describe('native pool enrollment grants', () => {
  test('an actual member receives a hashed, verifier-bound, short-lived grant for the configured pool', async () => {
    const f = await fixture()
    const got = await f.issue()
    expect(got).toEqual({
      grant: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expires_at: (now + 120_000) / 1000,
      pool_server: pool,
      team: { id: teamId, name: 'Paradigm' },
    })
    expect(f.data.has(`npgrant:${sha(got.grant)}`)).toBe(true)
    expect(JSON.stringify([...f.data])).not.toContain(got.grant)
    expect(JSON.stringify([...f.data])).not.toContain(f.token)
    expect(f.due).toContain(now + 120_000)
    expect(await f.directory.nativePool.consume(got.grant, verifier, pool, now)).toEqual({
      ok: true,
      account_id: accountId,
      team_id: teamId,
      device_name: proof.device_name,
      expires_at: got.expires_at,
    })
    expect([...f.data.keys()].filter(key => key.startsWith('np'))).toEqual([])
    expect(await f.directory.nativePool.consume(got.grant, verifier, pool, now)).toMatchObject({ ok: false, status: 401 })
  })

  test('sign-in, email domain, selected team and link-access never substitute for actual membership', async () => {
    const f = await fixture()
    expect((await f.at(proof, now, null)).status).toBe(401)
    f.data.delete(`mem:${teamId}:${accountId}`)
    f.data.get(`acct:${accountId}`).email = 'member@paradigm.study'
    f.data.set(`mem:another_team:${accountId}`, { role: 'owner', at: now })
    expect((await f.at()).status).toBe(403)
    expect(await f.directory.nativePool.member(accountId, teamId, pool)).toEqual({ ok: false })
    expect(await f.directory.nativePool.member(accountId, 'another_team', pool)).toMatchObject({ ok: false, status: 503 })
    expect([...f.data.keys()].filter(key => key.startsWith('npgrant:'))).toEqual([])
  })

  test('strict request keys, device names, challenge and small bodies', async () => {
    const f = await fixture()
    for (const body of [
      null,
      [],
      {},
      { ...proof, team_id: 'other_team' },
      { ...proof, pool_server: 'https://evil.example' },
      { ...proof, challenge: 'A'.repeat(64) },
      { ...proof, device_name: '' },
      { ...proof, device_name: 'x'.repeat(81) },
      { ...proof, device_name: 'Mac\n' },
      { ...proof, device_name: '\u202eMac' },
      { ...proof, device_name: ' Mac' },
      { ...proof, device_name: 'x'.repeat(NATIVE_POOL_BODY_MAX) },
    ])
      expect((await f.at(body)).status).toBe(400)
  })

  test('wrong verifier and origin cannot consume; expiry clears the record', async () => {
    const f = await fixture()
    const got = await f.issue()
    expect(await f.directory.nativePool.consume(got.grant, 'x'.repeat(43), pool, now)).toMatchObject({ ok: false, status: 403 })
    for (const server of ['https://other.example', `${pool}/`, `${pool}/path`, `http://pool.example`])
      expect(await f.directory.nativePool.consume(got.grant, verifier, server, now)).toMatchObject({ ok: false, status: 403 })
    expect(f.data.has(`npgrant:${sha(got.grant)}`)).toBe(true)
    expect(await f.directory.nativePool.consume(got.grant, verifier, pool, now + 120_000)).toMatchObject({ ok: false, status: 401 })
    expect([...f.data.keys()].filter(key => key.startsWith('np'))).toEqual([])
  })

  test('simultaneous collection succeeds exactly once, and concurrent grants stay bounded per account', async () => {
    const f = await fixture()
    const issued = await Promise.all(Array.from({ length: 10 }, () => f.at()))
    expect(issued.filter(res => res.status === 200)).toHaveLength(5)
    expect(issued.filter(res => res.status === 429)).toHaveLength(5)
    const first = await issued.find(res => res.status === 200)!.json<{ grant: string }>()
    const consumed = await Promise.all(Array.from({ length: 10 }, () => f.directory.nativePool.consume(first.grant, verifier, pool, now)))
    expect(consumed.filter(result => result.ok)).toHaveLength(1)
    expect(consumed.filter(result => !result.ok)).toHaveLength(9)
    expect((await f.at()).status).toBe(200)
  })

  test('existing account change rate limits apply even when every grant is consumed', async () => {
    const f = await fixture()
    for (let i = 0; i < 30; i++) {
      const got = await f.issue()
      expect((await f.directory.nativePool.consume(got.grant, verifier, pool, now)).ok).toBe(true)
    }
    expect((await f.at()).status).toBe(429)
    expect((await f.at(proof, now + 60_000)).status).toBe(200)
  })

  test('removal, account deletion, team deletion and reconfiguration invalidate existing grants', async () => {
    for (const remove of ['member', 'account', 'team', 'config']) {
      const f = await fixture()
      const got = await f.issue()
      if (remove === 'member') f.data.delete(`mem:${teamId}:${accountId}`)
      if (remove === 'account') f.data.delete(`acct:${accountId}`)
      if (remove === 'team') f.data.delete(`team:${teamId}`)
      if (remove === 'config') f.directory.nativePool.config = { teamId: 'another_team', server: pool }
      expect((await f.directory.nativePool.consume(got.grant, verifier, pool, now)).ok).toBe(false)
      expect(await f.directory.nativePool.member(accountId, teamId, pool)).toEqual(
        remove === 'config' ? { ok: false, status: 503, error: expect.any(String) } : { ok: false },
      )
    }
  })

  test('bridge configuration outages and audience disagreement never report definitive nonmembership', async () => {
    const f = await fixture()
    expect(await f.directory.nativePool.member(accountId, teamId, 'https://different-pool.example')).toMatchObject({ ok: false, status: 503 })
    expect(await f.directory.nativePool.member(accountId, 'another_team', pool)).toMatchObject({ ok: false, status: 503 })
    expect(await f.directory.nativePool.member('', teamId, pool)).toMatchObject({ ok: false, status: 400 })
    f.directory.nativePool.config = null
    expect(await f.directory.nativePool.member(accountId, teamId, pool)).toMatchObject({ ok: false, status: 503 })
    expect((await f.at()).status).toBe(503)
    f.directory.nativePool.config = { teamId, server: pool }
    expect(await f.directory.nativePool.member(accountId, teamId, pool)).toEqual({ ok: true })
    f.data.delete(`mem:${teamId}:${accountId}`)
    expect(await f.directory.nativePool.member(accountId, teamId, pool)).toEqual({ ok: false })
  })

  test('the directory alarm sweeps expired grants without a client request', async () => {
    const f = await fixture()
    await f.issue()
    expect(await f.directory.sweep(now)).toBe(now + 120_000)
    expect(await f.directory.sweep(now + 120_000)).toBeNull()
    expect([...f.data.keys()].filter(key => key.startsWith('np'))).toEqual([])
  })

  test('only a valid configured team and https origin enable enrollment', () => {
    expect(nativePoolConfig({ NATIVE_POOL_TEAM_ID: teamId, NATIVE_POOL_URL: `${pool}/` })).toEqual({ teamId, server: pool })
    for (const url of ['', 'http://pool.example', `${pool}/path`, `${pool}?x=1`, `${pool}#secret`, 'https://user:secret@pool.example'])
      expect(nativePoolConfig({ NATIVE_POOL_TEAM_ID: teamId, NATIVE_POOL_URL: url })).toBeNull()
    expect(nativePoolConfig({ NATIVE_POOL_TEAM_ID: 'bad:id', NATIVE_POOL_URL: pool })).toBeNull()
  })
})

test('only private DirectoryObject fetch reaches pool RPC; public routing remains blocked', async () => {
  const f = await fixture()
  let alarm: number | null = null
  const storage = {
    get: f.kv.get,
    put: f.kv.put,
    delete: f.kv.delete,
    list: async ({ prefix }: { prefix: string }) => new Map(await f.kv.list(prefix)),
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at
    },
  }
  let forwards = 0
  const env = { NATIVE_POOL_TEAM_ID: teamId, NATIVE_POOL_URL: pool, JOIN_LIMIT: { limit: async () => ({ success: true }) } } as unknown as ServerEnv
  const object = new DirectoryObject({ storage } as unknown as DurableObjectState, env)
  Object.assign(env, {
    DIRECTORY: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (req: Request) => {
          forwards++
          return object.fetch(req)
        },
      }),
    },
  })
  const publicFetch = (path: string, body: unknown, auth = f.token) =>
    worker.fetch(
      new Request(`https://share.example${path}`, { method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body) }),
      env,
      {} as ExecutionContext,
    )
  const issued = await publicFetch('/api/native-pool/enrollment', proof)
  expect(issued.status).toBe(200)
  expect(forwards).toBe(1)
  const grant = (await issued.json<{ grant: string }>()).grant
  for (const path of [
    '/rpc/consumeNativePoolGrant',
    '/rpc/nativePoolMembership',
    '/api/native-pool/../..//rpc/nativePoolMembership',
    '/rpc%2FnativePoolMembership',
  ]) {
    expect((await publicFetch(path, [grant, verifier, pool])).status).not.toBe(200)
    expect(forwards).toBe(1)
  }
  const privateFetch = (path: string, args: unknown) =>
    object.fetch(new Request(`https://directory.internal/rpc/${path}`, { method: 'POST', body: JSON.stringify(args) }))
  expect(await (await privateFetch('nativePoolMembership', [accountId, teamId, pool])).json()).toEqual({ result: { ok: true } })
  expect(await (await privateFetch('consumeNativePoolGrant', [grant, verifier, pool])).json()).toMatchObject({
    result: { ok: true, account_id: accountId, team_id: teamId, device_name: proof.device_name },
  })
  expect(await (await privateFetch('consumeNativePoolGrant', [grant, verifier, pool])).json()).toMatchObject({ result: { ok: false, status: 401 } })
  expect((await privateFetch('nativePoolMembership', { accountId, teamId, pool })).status).toBe(400)
  expect((await privateFetch('nativePoolMembership', [accountId, teamId, pool, 'extra'])).status).toBe(400)
  const oversized = new Request('https://share.example/api/native-pool/enrollment', {
    method: 'POST',
    headers: { 'content-length': String(NATIVE_POOL_BODY_MAX + 1) },
    body: 'x',
  })
  expect((await worker.fetch(oversized, env, {} as ExecutionContext)).status).toBe(413)
  expect(forwards).toBe(1)
  f.data.delete(`mem:${teamId}:${accountId}`)
  expect(await (await privateFetch('nativePoolMembership', [accountId, teamId, pool])).json()).toEqual({ result: { ok: false } })
  object.directory.nativePool.config = null
  expect(await (await privateFetch('nativePoolMembership', [accountId, teamId, pool])).json()).toMatchObject({ result: { ok: false, status: 503 } })
  expect(Directory.owns('/rpc/consumeNativePoolGrant')).toBe(false)
  expect(Directory.limited('/api/native-pool/enrollment', 'POST')).toBe(true)
})
