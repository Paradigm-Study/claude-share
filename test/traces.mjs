// Session traces (server/traces): turns taken from a room's events, and,
// with a database, end to end: a team's room under wrangler dev writes each
// turn to Postgres through its Hyperdrive binding, embedded by Workers AI;
// Claude Code's MCP client signs in over OAuth (registration, the page's
// sign-in through the server's own accounts, PKCE, tokens); and its calls
// find turns by words (Chinese too) and by meaning, for the team's people
// alone, for as long as their sign-in lasts.
//
//   node test/traces.mjs                                    # the pure parts
//   TRACES_DATABASE_URL='postgresql://…' node test/traces.mjs
//
// Needs Node 22.18 or newer (traces is TypeScript). The database must be a
// throwaway one: the traces tables are dropped first. Workers AI runs on
// Cloudflare even under wrangler dev, so it needs `npx wrangler login`;
// TRACES_NO_AI=1 leaves embeddings out (keywords only).

import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 18)) {
  console.log(`SKIP traces: Node ${process.version} can't load TypeScript (22.18 or newer can)`)
  process.exit(0)
}

const { takeTurns, tracesScope, authorOf } = await import('../server/traces/turns.ts')
const { grams, queryWords } = await import('../server/traces/grams.ts')
const { timeOf } = await import('../server/traces/time.ts')
const { PLUGIN_LATEST } = await import('../server/core.ts')

let failed = 0
const ok = (cond, label) => {
  console.log(cond ? 'OK  ' : 'FAIL', label)
  if (!cond) { failed += 1; process.exitCode = 1 }
}

// -- pure ---------------------------------------------------------------------

{
  const host = { seat: 'host', name: 'Alice', role: 'host' }
  const guest = { seat: 'g1', name: 'Bob', role: 'guest' }
  const ev = (seq, type, body, from = host) => ({ seq, ts: 1000 + seq, type, from, body })
  const events = [
    ev(1, 'row', { kind: 'user', who: 'Alice', text: '部署到生产' }),
    ev(2, 'row', { kind: 'tool', tool: 'Bash', text: 'npm run deploy' }),
    ev(3, 'row', { kind: 'assistant', text: '部署好了。' }),
    ev(4, 'row', { kind: 'assistant', text: 'All green.' }),
    ev(5, 'row', { kind: 'user', text: 'injected' }, guest),
    ev(6, 'turn', { state: 'end' }),
    ev(7, 'row', { kind: 'user', who: 'Bob', text: '下一个问题' }),
    ev(8, 'row', { kind: 'assistant', text: '还在写' }),
  ]
  const first = takeTurns(events.slice(0, 7))
  assert.deepEqual(first.closed, [{ turnId: '1', at: 1001, author: { name: 'Alice', account: null, role: 'unknown' }, prompt: '部署到生产', reply: '部署好了。\n\nAll green.', tools: ['Bash'] }])
  ok(first.open?.prompt === '下一个问题' && first.open.author.name === 'Bob', "a turn is a prompt and Claude's text after it, to the turn's end; a guest's rows count for nothing")
  const later = takeTurns(events.slice(7), first.open)
  ok(later.closed.length === 0 && later.open.reply === '还在写', 'an open turn carries on across looks')
  ok(takeTurns([ev(9, 'ended', {})], later.open).closed[0]?.reply === '还在写', "the room's end closes the open turn")
  ok(tracesScope({ team: { id: 'T' }, host: { account: 'a' } }) === 't:T' && tracesScope({ host: { account: 'a' } }) === 'u:a' && tracesScope({ host: {} }) === null, "a room's turns go to its team, else its host's account, else nowhere")
  const room = { host: { name: 'Alice', account: 'acctA' }, seats: new Map([['b1', { name: 'Bob', account: 'acctB' }], ['b2', { name: 'Bob', account: 'acctB' }], ['c1', { name: 'Sam', account: 'acctS1' }]]), away: new Map([['c2', { name: 'Sam', account: 'acctS2' }]]) }
  assert.deepEqual([authorOf(room, 'Alice'), authorOf(room, 'Bob'), authorOf(room, 'Sam'), authorOf(room, 'Zoe')], [
    { name: 'Alice', account: 'acctA', role: 'host' },
    { name: 'Bob', account: 'acctB', role: 'guest' },
    { name: 'Sam', account: null, role: 'guest' },
    { name: 'Zoe', account: null, role: 'unknown' },
  ])
  ok(true, "a prompt's author is the host, or the one account seated under that name; two accounts under one name leave it unknown")
  ok(grams('把服务部署到生产环境 with wrangler') === '把服 服务 务部 部署 署到 到生 生产 产环 环境 境 with wrangler', 'CJK runs become pairs; other text is left')
  assert.deepEqual(queryWords('部署 库 数据库迁移 Redis缓存'), [{ phrase: '部署' }, { prefix: '库' }, { phrase: '数据 据库 库迁 迁移' }, { phrase: 'Redis 缓存' }])
  ok(timeOf('7d', 10 * 86_400_000) === 3 * 86_400_000 && timeOf('2026-10-01') === Date.parse('2026-10-01') && timeOf('soon') === undefined, 'since: a span back from now or a date')
}

const url = process.env.TRACES_DATABASE_URL
if (!url) {
  console.log('SKIP end to end: TRACES_DATABASE_URL is not set')
  process.exit(process.exitCode ?? 0)
}

// -- end to end ---------------------------------------------------------------

const pg = (await import('pg')).default
const { migrate, reindex, search } = await import('../server/traces/store.ts')
const { startWorkerd } = await import('./support/workerd.mjs')

const direct = new pg.Client({ connectionString: url })
await direct.connect()
await direct.query('drop table if exists turns, sessions, settings cascade')
const { cjk } = await migrate(direct)
console.log(`NOTE Lakebase Search ${cjk ? 'is here: keywords by its Chinese tokenizer and BM25' : 'is not here: keywords by pairs of characters'}`)

const ai = !process.env.TRACES_NO_AI
const srv = await startWorkerd({
  vars: { AUTH_TEST: '1' },
  extra: [
    '[[hyperdrive]]',
    'binding = "TRACES_DB"',
    'id = "00000000000000000000000000000000"',
    `localConnectionString = ${JSON.stringify(url)}`,
    '[[kv_namespaces]]',
    'binding = "OAUTH_KV"',
    'id = "00000000000000000000000000000000"',
    ...(ai ? ['[ai]', 'binding = "AI"', 'remote = true'] : []),
  ].join('\n'),
})
const S = srv.origin
const V = { 'x-shared-session-version': PLUGIN_LATEST, 'content-type': 'application/json' }
const call = async (path, { method = 'GET', body, tok, acct, form } = {}) => {
  const headers = { ...V }
  if (tok) headers.authorization = `Bearer ${tok}`
  if (acct) headers['x-shared-session-account'] = acct
  if (form) headers['content-type'] = 'application/x-www-form-urlencoded'
  const res = await fetch(`${S}${path}`, { method, headers, body: form ? new URLSearchParams(form) : body ? JSON.stringify(body) : undefined, redirect: 'manual' })
  const text = await res.text()
  try { return { status: res.status, data: JSON.parse(text), headers: res.headers } } catch { return { status: res.status, data: text, headers: res.headers } }
}
const sha = text => createHash('sha256').update(text).digest('hex')
const b64url = buf => Buffer.from(buf).toString('base64url')
// A person's browser continuing a sign-in started under `login`.
const continueAs = async (login, email, name) => {
  const page = String((await call(`/auth/test/start?login=${login}&email=${encodeURIComponent(email)}&name=${name}`)).data)
  const nonce = /name="nonce" value="([^"]*)"/.exec(page)?.[1] ?? ''
  return call('/auth/confirm', { method: 'POST', form: { login, nonce } })
}
// Claude Code's /team sign-in: an account token, for making teams and sharing.
const signIn = async (email, name) => {
  const verifier = 'V' + Math.random().toString(36).slice(2).padEnd(40, 'x')
  await continueAs(sha(verifier), email, name)
  return (await call('/api/auth/poll', { method: 'POST', body: { verifier } })).data.token
}
const until = async (cond, ms = 30_000) => {
  const stop = Date.now() + ms
  while (Date.now() < stop) { if (await cond()) return true; await new Promise(r => setTimeout(r, 500)) }
  return false
}

// Claude Code's MCP client signing in over OAuth, as a person would: it
// registers, opens the page, the person signs in and presses Allow (or
// Deny), and the client trades the code for tokens with its PKCE verifier.
const REDIRECT = 'http://127.0.0.1:33418/callback'
async function connect(email, name, { redirect = REDIRECT, decision = 'allow', steps = {} } = {}) {
  const reg = await call('/oauth/register', { method: 'POST', body: { client_name: 'Claude Code', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] } })
  const clientId = reg.data.client_id
  const verifier = b64url(randomBytes(32))
  const state = b64url(randomBytes(12))
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, state, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', scope: 'traces:read', resource: `${S}/mcp` })
  const opened = await fetch(`${S}/oauth/authorize?${query}`, { redirect: 'manual' })
  const html = await opened.text()
  if (opened.status !== 200) return { status: opened.status, html }
  steps.csp = opened.headers.get('content-security-policy') ?? ''
  const cookie = opened.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]
  const id = /data-id="([^"]+)"/.exec(html)?.[1]
  const login = /login=([0-9a-f]{64})/.exec(html)?.[1]
  const code = /the code <b>([^<]+)<\/b>/.exec(html)?.[1]
  const poll = async () => (await call('/oauth/poll', { method: 'POST', body: { id } })).data
  steps.before = await poll()
  steps.codeMatches = code === `${login.slice(0, 4)}-${login.slice(4, 8)}`.toUpperCase()
  steps.early = await fetch(`${S}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ handle, id, decision: 'allow' }) }).then(r => r.status)
  await continueAs(login, email, name)
  steps.after = await poll()
  const press = () => fetch(`${S}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ handle, id, decision }) })
  const pressed = await press()
  const location = pressed.headers.get('location') ?? ''
  steps.again = (await press()).status
  if (decision !== 'allow') return { location }
  const back = new URL(location)
  steps.state = back.searchParams.get('state') === state && location.startsWith(redirect)
  const tokens = (await call('/oauth/token', { method: 'POST', form: { grant_type: 'authorization_code', code: back.searchParams.get('code') ?? '', redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource: `${S}/mcp` } })).data
  return { access: tokens.access_token, refresh: tokens.refresh_token, clientId }
}

let rpcId = 0
const mcp = async (tok, method, params) => {
  const res = await fetch(`${S}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })
  // A 2025-era request is answered as a stream of events: its answer is the
  // event that carries this request's id.
  const text = await res.text()
  const messages = (res.headers.get('content-type') ?? '').startsWith('text/event-stream')
    ? text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5)) } catch { return null } })
    : [(() => { try { return JSON.parse(text) } catch { return null } })()]
  return { status: res.status, headers: res.headers, data: messages.find(m => m?.id === rpcId) ?? messages.at(-1) ?? null }
}
const tool = async (tok, name, args) => (await mcp(tok, 'tools/call', { name, arguments: args })).data?.result
const hits = async (tok, query, more = {}) => (await tool(tok, 'search', { query, ...more }))?.structuredContent?.hits ?? []

try {
  // -- OAuth ------------------------------------------------------------------
  const bare = await mcp(null, 'initialize', {})
  const challenge = bare.headers.get('www-authenticate') ?? ''
  const resourceMeta = (await call('/.well-known/oauth-protected-resource/mcp')).data
  const serverMeta = (await call('/.well-known/oauth-authorization-server')).data
  ok(bare.status === 401 && challenge.includes('resource_metadata=') && resourceMeta?.resource === `${S}/mcp` && serverMeta?.authorization_endpoint === `${S}/oauth/authorize` && serverMeta.registration_endpoint === `${S}/oauth/register` && serverMeta.code_challenge_methods_supported?.includes('S256'),
    "MCP without a token: 401 naming the resource's metadata, which names this server's OAuth: registration, authorize, PKCE")

  const home = await (await fetch(`${S}/`)).text()
  ok((await call('/api/version')).data?.traces === true, '/api/version says this server keeps turns, for Share to say')
  ok(home.includes('<b>Traces, kept on this server:</b>') && home.includes('there is no way yet to delete them'), "the home page says this server keeps turns, for how long, and that they can't be deleted yet")

  const alice = await signIn('alice@acme.com', 'Alice')
  const bob = await signIn('bob@other.com', 'Bob')
  ok((await mcp(alice, 'initialize', {})).status === 401, 'an account token from /team is no MCP token')

  const steps = {}
  const a = await connect('alice@acme.com', 'Alice', { steps })
  ok(steps.before?.status === 'waiting' && steps.codeMatches && steps.early === 400, "the page shows the sign-in's code, waits for it, and Allow before signing in does nothing")
  ok(steps.after?.status === 'done' && steps.after.name === 'Alice' && !JSON.stringify(steps.after).includes('ssa_'), "once Alice continues, the page learns her name and never her token")
  ok(steps.state && steps.again === 400 && Boolean(a.access) && Boolean(a.refresh), 'Allow sends the code back to Claude Code with its state, once; the code and PKCE verifier get tokens')
  ok(/script-src 'sha256-[^']+'/.test(steps.csp) && steps.csp.includes("frame-ancestors 'none'"), 'the page runs its one script by hash and is never framed')
  const evil = await connect('alice@acme.com', 'Alice', { redirect: 'https://evil.example/callback' })
  ok(evil.status === 403 && String(evil.html).includes('evil.example'), "a client that would send the sign-in to another site is turned away, and the page says where")
  const denied = await connect('alice@acme.com', 'Alice', { decision: 'deny' })
  ok(new URL(denied.location).searchParams.get('error') === 'access_denied', 'Deny sends access_denied back')
  const refreshed = (await call('/oauth/token', { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: a.refresh, client_id: a.clientId } })).data
  ok(Boolean(refreshed.access_token) && (await mcp(refreshed.access_token, 'tools/list', {})).status === 200, 'a refresh token gets a new access token that works')

  // -- a shared session, kept -------------------------------------------------
  const made = await call('/api/teams', { method: 'POST', tok: alice, body: { name: 'Acme' } })
  const team = made.data?.team
  const shared = await call('/api/rooms', { method: 'POST', acct: alice, body: { name: 'Alice', title: 'acme: deploys', team: team?.id } })
  const room = shared.data
  // A refusal says why: a sign-in or team the share check turned away (401,
  // 403), or the room limit (429).
  for (const [what, res, id] of [['team', made, team?.id], ['room', shared, room?.id]]) if (!id) console.log(`NOTE the ${what} was not made: ${res.status} ${JSON.stringify(res.data).slice(0, 500)}`)
  ok(Boolean(team?.id && room?.id), 'Alice makes Acme and shares a session with it')

  const row = (kind, text, extra = {}) => ({ type: 'row', body: { kind, text, ...extra } })
  const end = { type: 'turn', body: { state: 'end' } }
  const turns = [
    [row('user', '把服务部署到生产环境，用 wrangler deploy', { who: 'Alice' }), row('tool', 'npx wrangler deploy', { tool: 'Bash' }), row('assistant', '我先跑了测试，然后执行 `npx wrangler deploy -c wrangler.preview.toml`，再部署主 Worker。两个都部署成功了。'), end],
    [row('user', '数据库迁移失败了，报错 relation "turns" does not exist', { who: 'Alice' }), row('assistant', '迁移脚本在建表之前就建了索引。我把 create index 移到 create table 之后，重新跑迁移，成功了。'), end],
    [row('user', 'Why does the Durable Object lose its state after hibernation?', { who: 'Alice' }), row('assistant', 'Hibernation evicts the object from memory: anything not in storage or in the WebSocket attachment is gone when it wakes. Keep the seat in serializeAttachment.'), end],
    // No end of its own: the room's end closes it.
    [row('user', '缓存击穿怎么处理？Redis 的热点 key 过期了', { who: 'Alice' }), row('assistant', '用互斥锁，或者逻辑过期：热点 key 不设物理过期时间，后台线程刷新。')],
  ]
  for (const events of turns) {
    const r = await call(`/api/rooms/${room.id}/events`, { method: 'POST', tok: room.token, body: { events } })
    if (r.status !== 200) throw new Error(`events: ${r.status} ${JSON.stringify(r.data)}`)
  }
  const count = async () => Number((await direct.query('select count(*) from turns')).rows[0].count)
  // Each write waits on Workers AI, which runs on Cloudflare even here.
  const three = await until(async () => (await count()) === 3, 60_000)
  ok(three, 'three ended turns reach Postgres; the fourth, still open, waits')
  ok((await call(`/api/rooms/${room.id}/end`, { method: 'POST', tok: room.token })).status === 200 && (await until(async () => (await count()) === 4, 60_000)), "the room's end keeps the open turn")
  const aliceId = (await call('/api/me', { tok: alice })).data.account.id
  const stored = (await direct.query('select scope, author_name, author_account, author_role, tools, embedding is not null as embedded from turns order by at')).rows
  ok(stored.every(r => r.scope === `t:${team.id}` && r.author_name === 'Alice' && r.author_account === aliceId && r.author_role === 'host') && stored[0].tools[0] === 'Bash', "every turn is in Acme's traces, asked by Alice's account, with its tools' names")
  const kept = (await direct.query('select team_id, owner_account, owner_name from sessions')).rows
  ok(kept.length === 1 && kept[0].team_id === team.id && kept[0].owner_account === aliceId && kept[0].owner_name === 'Alice', 'the session records who shared it, by account, and the team')
  if (ai) ok(stored.every(r => r.embedded), 'every turn is embedded by Workers AI')

  // -- MCP, as Alice ----------------------------------------------------------
  const init = (await mcp(a.access, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).data?.result
  const listed = (await mcp(a.access, 'tools/list', {})).data?.result?.tools?.map(t => t.name)
  ok(init?.protocolVersion === '2025-06-18' && init.serverInfo.name === 'shared-session-traces' && listed?.join() === 'search,get_turn,get_session,list_sessions', 'initialize, then four tools')

  if (cjk) await reindex(direct)
  const firstOf = async (query, more) => (await hits(a.access, query, { mode: 'keyword', ...more }))[0]?.prompt ?? ''
  for (const [query, expect, label] of [
    ['部署', '把服务部署', 'a two-character Chinese word'],
    ['数据库迁移', '数据库迁移', 'a longer Chinese phrase'],
    ['缓存击穿', '缓存击穿', "a word in the turn the room's end closed"],
    ['hibernation', 'Why does the Durable Object', 'an English word'],
    ['serializeAttachment', 'Why does the Durable Object', 'an identifier from a reply'],
  ]) ok((await firstOf(query)).startsWith(expect), `keyword search finds ${label}: ${query}`)

  const scopes = [`t:${team.id}`]
  for (const query of ['部署', '迁移', '热点', '缓存', '主 Worker', 'wrangler']) {
    const bigram = (await search(direct, scopes, { query, mode: 'keyword', keywords: 'bigram' })).length
    const bm25 = cjk ? (await search(direct, scopes, { query, mode: 'keyword', keywords: 'bm25' })).length : '-'
    console.log(`NOTE ${query.padEnd(10)} pairs: ${bigram} hit(s)   Lakebase BM25: ${bm25}`)
  }
  // Every word of a query must be in the turn, by either keyword path: 「怎么」
  // alone is in 「缓存击穿怎么处理」, 「上线」 is in no turn.
  for (const keywords of cjk ? ['bigram', 'bm25'] : ['bigram']) {
    const found = await search(direct, scopes, { query: '怎么上线', mode: 'keyword', keywords })
    ok(found.length === 0, `keyword search (${keywords}) finds no turn that has only one of the query's words: 怎么上线 → ${found[0]?.prompt.slice(0, 12) ?? 'nothing'}`)
  }

  if (ai) {
    for (const [query, expect] of [
      ['how do I release a new version to production', '把服务部署'],
      ['怎么上线', '把服务部署'],
      ['why is my object forgetting things after it sleeps', 'Why does the Durable Object'],
      ['热门数据失效导致数据库压力大', '缓存击穿'],
    ]) {
      const found = await hits(a.access, query, { mode: 'semantic' })
      ok(found[0]?.prompt.startsWith(expect), `search by meaning: "${query}" → ${found[0]?.prompt.slice(0, 20) ?? 'nothing'}`)
    }
    const hybrid = await hits(a.access, '部署')
    ok(hybrid[0]?.prompt.startsWith('把服务部署') && hybrid[0].found.includes('kw'), 'hybrid search puts the turn that has the word first')
    const filler = await hits(a.access, '怎么上线')
    ok(filler[0]?.prompt.startsWith('把服务部署') && !filler.some(h => h.found.includes('kw')), `hybrid search ranks by meaning when no turn has every word: 怎么上线 → ${filler[0]?.prompt.slice(0, 12) ?? 'nothing'}`)
  }

  const top = (await hits(a.access, '迁移', { mode: 'keyword' }))[0]
  const whole = (await tool(a.access, 'get_turn', { session: top.session, turn: top.turn }))?.structuredContent
  ok(whole?.reply.includes('create index 移到 create table 之后') && whole.who.account === aliceId && whole.sharedBy.account === aliceId && whole.title === 'acme: deploys', 'get_turn gives the turn whole, with who asked and who shared')
  const session = (await tool(a.access, 'get_session', { session: room.id }))?.structuredContent
  ok(session?.turns.length === 4 && session.turns[0].prompt.startsWith('把服务部署'), "get_session lists the session's prompts in order")
  const sessions = (await tool(a.access, 'list_sessions', {}))?.structuredContent?.sessions
  ok(sessions?.length === 1 && sessions[0].turns === 4, 'list_sessions lists it')

  // -- MCP, as Bob, who isn't in Acme -----------------------------------------
  const b = await connect('bob@other.com', 'Bob')
  ok((await hits(b.access, '部署')).length === 0, "Bob, not in Acme, finds nothing of Acme's")
  ok((await tool(b.access, 'get_turn', { session: top.session, turn: top.turn }))?.isError === true, 'nor can he read one of its turns by its id')
  ok((await tool(b.access, 'list_sessions', {}))?.structuredContent?.sessions?.length === 0, 'nor list its sessions')
  ok((await call('/api/me', { method: 'DELETE', tok: bob })).status === 200 && (await mcp(b.access, 'tools/list', {})).status === 401, "once Bob's account is deleted, his MCP token reads nothing")
} catch (error) {
  console.log('FAIL', error?.stack ?? error)
  process.exitCode = 1
} finally {
  if (process.exitCode) console.log(srv.logs().slice(-3000))
  await srv.stop()
  await direct.end()
}
console.log(failed ? `FAIL ${failed} check(s)` : 'PASS traces end to end')
