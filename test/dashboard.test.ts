// The dashboard (server/worker/dash.ts, web/): its page and files at /app,
// a browser's sign-in through the sign-in page's Continue into a cookie the
// server keeps only the hash of, its teams' live sessions, and how that
// access ends: signing out, the account deleted, removal from a team, 30
// days. The Workers run under wrangler dev with the test provider
// (AUTH_TEST); a server without traces says search has nothing.

import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { PLUGIN_LATEST } from '../server/core/index.ts'
import { Directory, WEB_SESSION_MS, mapStore } from '../server/teams.ts'
import { startWorkerd } from './support/workerd.ts'
import type { Workerd } from './support/workerd.ts'

const ok = (cond: unknown, label: string) => expect.soft(Boolean(cond), label).toBe(true)
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const secret = () => 'V' + Math.random().toString(36).slice(2).padEnd(40, 'x')

let S = ''
type Answer = { status: number; data: any; headers: Headers; cookies: string[] }
async function send(path: string, init: { method?: string; headers?: Record<string, string>; body?: string | URLSearchParams } = {}): Promise<Answer> {
  const res = await fetch(path.startsWith('http') ? path : `${S}${path}`, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
    redirect: 'manual',
  })
  const text = await res.text()
  let data: any = text
  try {
    data = JSON.parse(text)
  } catch {}
  return { status: res.status, data, headers: res.headers, cookies: res.headers.getSetCookie() }
}

// Claude Code's /team sign-in: an account token (ssa_), for making teams,
// sharing and deleting the account.
async function pluginSignIn(email: string, name: string) {
  const verifier = secret()
  const login = sha(verifier)
  const page = String((await send(`/auth/test/start?login=${login}&email=${encodeURIComponent(email)}&name=${name}`)).data)
  const nonce = /name="nonce" value="([^"]*)"/.exec(page)?.[1] ?? ''
  await send('/auth/confirm', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ login, nonce }) })
  return (await send('/api/auth/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verifier }) })).data
    .token as string
}
const api = (path: string, tok: string, { method = 'GET', body }: { method?: string; body?: unknown } = {}) =>
  send(path, {
    method,
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', 'x-shared-session-version': PLUGIN_LATEST },
    body: body ? JSON.stringify(body) : undefined,
  })

// A browser: its cookies kept as a browser keeps them (by name; Max-Age=0
// deletes), sent back on every request, and Origin on a POST as a page of
// this server's sends it (`origin: false`: a request from elsewhere).
function browser() {
  const jar = new Map<string, string>()
  const seen: string[] = [] // every Location it was sent to
  const take = (a: Answer) => {
    for (const c of a.cookies) {
      const [pair = ''] = c.split(';')
      const at = pair.indexOf('=')
      const name = pair.slice(0, at),
        value = pair.slice(at + 1)
      if (/max-age=0/i.test(c)) jar.delete(name)
      else jar.set(name, value)
    }
    const to = a.headers.get('location')
    if (to) seen.push(to)
    return a
  }
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  return {
    jar,
    seen,
    get: async (path: string) => take(await send(path, { headers: { cookie: cookie() } })),
    post: async (path: string, body: unknown = {}, { origin = true }: { origin?: boolean } = {}) =>
      take(
        await send(path, {
          method: 'POST',
          headers: { cookie: cookie(), 'content-type': 'application/json', ...(origin ? { origin: S } : {}) },
          body: JSON.stringify(body),
        }),
      ),
    form: async (path: string, fields: Record<string, string>) =>
      take(
        await send(path, {
          method: 'POST',
          headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(fields),
        }),
      ),
  }
}
type Browser = ReturnType<typeof browser>

// A person signing in on the dashboard: Sign in (the code and the links),
// the provider (the test one), the sign-in page's Continue, and back.
async function webSignIn(email: string, name: string, b: Browser = browser()) {
  const start = await b.post('/api/dash/signin')
  const link = start.data.providers.find((p: any) => p.id === 'test').href as string
  const page = await b.get(`${link}&email=${encodeURIComponent(email)}&name=${name}`)
  const nonce = /name="nonce" value="([^"]*)"/.exec(String(page.data))?.[1] ?? ''
  const login = /name="login" value="([^"]*)"/.exec(String(page.data))?.[1] ?? ''
  const done = await b.form('/auth/confirm', { login, nonce })
  const back = await b.get(done.headers.get('location') ?? '/app/continue')
  return { b, start, page, done, back }
}

describe('the dashboard, on the room server', () => {
  let srv: Workerd
  beforeAll(async () => {
    srv = await startWorkerd({ vars: { AUTH_TEST: '1' } })
    S = srv.origin
  })
  afterAll(() => srv?.stop())

  test('serves its page and files at /app, the page for any of its routes, with nothing from elsewhere; the preview host serves none of it', async () => {
    const bare = await send('/app')
    ok(bare.status === 303 && bare.headers.get('location') === '/app/', '/app goes to /app/')
    const page = await send('/app/')
    const csp = page.headers.get('content-security-policy') ?? ''
    ok(page.status === 200 && String(page.data).includes('<div id="root">'), 'the page')
    ok(
      csp.includes("default-src 'none'") && csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'") && !/unsafe-/.test(csp),
      `its own script alone, never framed (${csp})`,
    )
    ok(page.headers.get('referrer-policy') === 'no-referrer' && page.headers.get('x-frame-options') === 'DENY', 'never named in a referrer, never framed')
    ok(page.headers.get('cache-control') === 'no-cache', 'the page is asked for again each time')
    const deep = await send('/app/search')
    ok(deep.status === 200 && deep.data === page.data, 'a route of the app gets the page')
    const script = /src="(\/app\/assets\/[^"]+\.js)"/.exec(String(page.data))?.[1] ?? ''
    const file = await send(script)
    ok(script && file.status === 200 && /javascript/.test(file.headers.get('content-type') ?? ''), `its script is served (${script})`)
    ok(/immutable/.test(file.headers.get('cache-control') ?? ''), 'its files, named by hash, are kept')
    ok((await send('/app/assets/missing.js')).status === 404, 'a file it lacks is a 404, not the page')
    ok((await send('/app/', { method: 'POST' })).status === 404, 'nothing posts to the page')
    ok((await send('/')).status === 200 && (await send('/api/health')).data.ok === true, "the server's own routes are still its own")

    // The preview Worker is the same script: none of the dashboard there.
    for (const path of ['/app/', '/app/continue', '/api/dash/me', '/api/dash/signin']) {
      const r = await send(`${srv.previewOrigin}${path}`, { method: path.endsWith('signin') ? 'POST' : 'GET', headers: { origin: srv.previewOrigin } })
      ok(r.status === 404 && !String(r.data).includes('<div id="root">') && !r.cookies.length, `the preview host answers 404 for ${path}`)
    }
  })

  test('a browser signs in only through the sign-in page’s Continue, into a cookie of its own; the token is in no address', async () => {
    const stranger = await send('/api/dash/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    ok(stranger.status === 403 && !stranger.cookies.length, 'a sign-in asked for without this server’s Origin is refused')
    const elsewhere = await send('/api/dash/signin', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' })
    ok(elsewhere.status === 403, 'and from another site')

    const { b, start, page, done, back } = await webSignIn('alice@acme.com', 'Alice')
    const login = start.cookies.find(c => c.startsWith('__Host-share-login=')) ?? ''
    ok(/; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/.test(login), `the sign-in's secret waits in a cookie of this browser's (${login})`)
    const link = start.data.providers.find((p: any) => p.id === 'test')?.href ?? ''
    const verifier = /^__Host-share-login=([^;]+)/.exec(login)?.[1] ?? ''
    ok(
      link.includes(`login=${sha(verifier)}`) && link.endsWith('then=%2Fapp%2Fcontinue') && !link.includes(verifier),
      'its link carries the hash, never the secret',
    )
    ok(start.data.code === `${sha(verifier).slice(0, 4)}-${sha(verifier).slice(4, 8)}`.toUpperCase(), 'and the dashboard shows the code of that hash')
    ok(
      String(page.data).includes(
        `The page you came from shows the code <b>${start.data.code}</b>. Continue only if you started signing in just now and the codes match.`,
      ),
      'the sign-in page shows the same code, and asks first',
    )
    ok(done.status === 303 && done.headers.get('location') === '/app/continue', 'its Continue comes back to the dashboard')
    const session = back.cookies.find(c => c.startsWith('__Host-share-session=')) ?? ''
    ok(back.status === 303 && back.headers.get('location') === '/app/', 'and the dashboard opens, signed in')
    ok(
      new RegExp(`^__Host-share-session=ssw_[A-Za-z0-9_-]+; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${WEB_SESSION_MS / 1000}$`).test(session),
      `in a __Host- cookie, HttpOnly and SameSite=Lax, for 30 days (${session.replace(/ssw_[^;]+/, 'ssw_…')})`,
    )
    ok(!b.jar.has('__Host-share-login'), 'the secret is gone from the browser')
    ok(
      b.seen.every(to => !to.includes('ssw_') && !to.includes(verifier)),
      `no address it went to held the token or the secret (${b.seen.join(', ')})`,
    )
    const me = await b.get('/api/dash/me')
    ok(me.status === 200 && me.data.account.name === 'Alice' && me.data.traces === false, 'it is Alice’s, and the server says it keeps no traces')

    // Collected once: the same secret again signs nobody in.
    const replay = browser()
    replay.jar.set('__Host-share-login', verifier)
    const again = await replay.get('/app/continue')
    ok(again.headers.get('location') === '/app/?signin=failed' && !replay.jar.has('__Host-share-session'), 'a sign-in is collected once')
    const none = await browser().get('/app/continue')
    ok(none.status === 303 && none.headers.get('location') === '/app/?signin=failed', 'and a browser with no sign-in of its own gets none')

    // Someone else's start link: its Continue in this browser brings back nothing.
    const victim = browser()
    const theirs = secret()
    const pageOf = await victim.get(`/auth/test/start?login=${sha(theirs)}&then=%2Fapp%2Fcontinue&email=vic@acme.com&name=Vic`)
    const field = (n: string) => new RegExp(`name="${n}" value="([^"]*)"`).exec(String(pageOf.data))?.[1] ?? ''
    const cont = await victim.form('/auth/confirm', { login: field('login'), nonce: field('nonce') })
    const landed = await victim.get(cont.headers.get('location') ?? '/app/continue')
    ok(
      landed.headers.get('location') === '/app/?signin=failed' && !victim.jar.has('__Host-share-session'),
      'a start link made elsewhere signs this browser into nothing',
    )

    // The browser's token reads the dashboard alone: it is no Bearer token.
    const token = b.jar.get('__Host-share-session') ?? ''
    ok((await api('/api/me', token)).status === 401, 'the browser’s token is refused as a Bearer token')
    ok((await api('/api/teams', token, { method: 'POST', body: { name: 'Nope' } })).status === 401, 'it can make no team')
    ok((await api('/api/me', token, { method: 'DELETE' })).status === 401, 'nor delete the account')
  })

  test('Live lists the teams’ sessions as the Team panel does; a removal, signing out and deleting the account end access at the next call', async () => {
    const alice = await pluginSignIn('owner@acme.test', 'Owner')
    const team = (await api('/api/teams', alice, { method: 'POST', body: { name: 'Acme' } })).data.team
    await api(`/api/teams/${team.id}`, alice, { method: 'PATCH', body: { domains: 'acme.test' } })
    const room = (
      await send('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shared-session-version': PLUGIN_LATEST, 'x-shared-session-account': alice },
        body: JSON.stringify({ name: 'Owner', title: 'acme: the release', team: team.id }),
      })
    ).data
    ok(room.team?.name === 'Acme', 'Owner shares a session with Acme')

    const { b: bob } = await webSignIn('bob@acme.test', 'Bob')
    const me = (await bob.get('/api/dash/me')).data
    ok(
      me.teams.some((t: any) => t.id === team.id && t.name === 'Acme'),
      'Bob, in Acme by his domain, sees it on the dashboard',
    )
    const live = await bob.get('/api/dash/live')
    const row = live.data.teams?.find((t: any) => t.id === team.id)?.sessions?.[0]
    ok(
      live.status === 200 && row?.url === room.url && row.host === 'Owner' && row.title === 'acme: the release' && row.mine === false && row.inIt === false,
      'Live lists the session: its link, title and host',
    )
    ok(row && !('accounts' in row) && !('hostAccount' in row), 'and no account ids')
    ok(live.headers.get('cache-control') === 'no-store', 'never cached')

    const { b: carol } = await webSignIn('carol@else.test', 'Carol')
    ok((await carol.get('/api/dash/live')).data.teams.length === 0, 'someone in no team sees nothing')

    // Removed from the team: gone from Live at the next call.
    await api(`/api/teams/${team.id}/members/${me.account.id}`, alice, { method: 'DELETE' })
    ok(!(await bob.get('/api/dash/live')).data.teams.some((t: any) => t.id === team.id), 'removed from Acme, Bob sees none of it')
    ok((await bob.get('/api/dash/me')).data.teams.length === 0, 'and is in no team')

    // Search, on a server without traces, says so; and only from this server's page.
    ok((await bob.post('/api/dash/search', { query: 'release' }, { origin: false })).status === 403, 'a search from elsewhere is refused')
    const search = await bob.post('/api/dash/search', { query: 'release' })
    ok(
      search.status === 404 && search.data.traces === false && /doesn't keep session traces/.test(search.data.error),
      'without traces, search says there is nothing',
    )

    // Signing out: only from this server's page; then the cookie reads nothing.
    const kept = bob.jar.get('__Host-share-session') ?? ''
    ok((await bob.post('/api/dash/signout', {}, { origin: false })).status === 403, 'a sign-out from elsewhere is refused')
    ok((await bob.get('/api/dash/me')).status === 200, 'and Bob is still signed in')
    const out = await bob.post('/api/dash/signout')
    ok(out.status === 200 && !bob.jar.has('__Host-share-session'), 'signing out clears the cookie')
    const stale = await send('/api/dash/me', { headers: { cookie: `__Host-share-session=${kept}` } })
    ok(stale.status === 401 && stale.cookies.some(c => /^__Host-share-session=;.*Max-Age=0/.test(c)), 'and the old cookie reads nothing: the server forgot it')

    // The account deleted (from Claude Code): its browsers' sign-ins go too.
    const { b: dave } = await webSignIn('dave@acme.test', 'Dave')
    const daveCode = await pluginSignIn('dave@acme.test', 'Dave')
    ok((await dave.get('/api/dash/me')).data.account.name === 'Dave', 'Dave is signed in on the dashboard')
    await api('/api/me', daveCode, { method: 'DELETE' })
    ok((await dave.get('/api/dash/live')).status === 401, 'his account deleted, the dashboard reads nothing')
  })
})

describe('a browser’s sign-in, in the directory', () => {
  test('lasts 30 days from when it was made, is swept when due, and reads only through the dashboard', async () => {
    const store = new Map<string, unknown>()
    const due: number[] = []
    const dir = new Directory(mapStore(store), { onDue: at => due.push(at) })
    const now = Date.UTC(2026, 9, 1)
    const account = await dir.signIn({ provider: 'github', subject: '1', name: 'Ann', email: 'ann@x.test', emailVerified: true }, now)
    const token = await dir.mintWeb(account.id, now)
    const key = [...store.keys()].find(k => k.startsWith('web:')) ?? ''
    ok(token.startsWith('ssw_') && key === `web:${sha(token)}` && ![...store.values()].some(v => JSON.stringify(v).includes(token)), 'only its hash is kept')
    ok(due.includes(now + WEB_SESSION_MS), 'the directory is woken when it is due')
    ok((await dir.dashMe(token, now + WEB_SESSION_MS - 1))?.account.id === account.id, 'it reads until its 30 days are up')
    ok((await dir.accountOf(token)) === null && (await dir.accountOf(`Bearer ${token}`)) === null, 'it is no account token')
    ok((await dir.sweep(now + 1)) === now + WEB_SESSION_MS, 'the sweep keeps it until then')
    await dir.sweep(now + WEB_SESSION_MS + 1)
    ok(!store.has(key), 'and deletes it once they are')
    const late = await dir.mintWeb(account.id, now)
    ok(
      (await dir.dashLive(late, now + WEB_SESSION_MS + 1)) === null && ![...store.keys()].some(k => k.startsWith('web:')),
      'one used after its time reads nothing, and goes',
    )
    const ended = await dir.mintWeb(account.id, now)
    await dir.endWeb(ended)
    ok((await dir.dashMe(ended, now)) === null, 'signing out ends it')
  })
})
