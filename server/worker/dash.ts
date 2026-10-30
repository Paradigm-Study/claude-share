// The dashboard: a small single-page app (web/, built into web/dist/app and
// served from Workers Static Assets, the ASSETS binding) at /app, and the
// JSON it reads at /api/dash/*. Read-only: a browser sees its teams' live
// sessions and searches the traces it may read.
//
// A browser signs in as Claude Code's /team does (server/teams.ts), and only
// the sign-in page's Continue signs it in. POST /api/dash/signin keeps a
// secret in a cookie of this browser's and hands back the start links, made
// with its hash, and the code the sign-in page will show; the page shows the
// code beside them. Continue ends at /app/continue, which collects the
// sign-in with that secret (the directory's poll, `web: true`) and keeps the
// browser's token in a __Host- cookie, HttpOnly and SameSite=Lax. The token
// is never in an address, and the directory keeps only its hash, for 30 days
// (`WEB_SESSION_MS`). It reads through the directory's dash methods alone:
// it is no Bearer token anywhere.
//
// Every call asks the directory who the sign-in is now and which teams it's
// in, so signing out, deleting the account or leaving a team holds at the
// next call, as MCP's do (server/traces/mcp.ts). Every POST carries this
// server's Origin, or is refused.

import { json, notFound, readBody, statusOf, bodyTooLarge, badRequest, limitedResponse } from '../core/index.ts'
import type { ServerEnv } from './env.ts'
import { tracesOn, traces, hasDirectory, directoryStub } from './env.ts'
import { providersFrom, PROVIDERS, WEB_SESSION_MS } from '../teams.ts'
import type { TracesEnv } from '../traces/index.ts'
import { timeOf } from '../traces/time.ts'

export const isDashPath = (path: string) => path === '/app' || path.startsWith('/app/') || path.startsWith('/api/dash/')

const SESSION_COOKIE = '__Host-share-session'
const LOGIN_COOKIE = '__Host-share-login'
const LOGIN_SECONDS = 600 // as long as the directory's sign-in waits
const COOKIE = 'Path=/; Secure; HttpOnly; SameSite=Lax'
const keep = (name: string, value: string, seconds: number) => `${name}=${value}; ${COOKIE}; Max-Age=${seconds}`
const drop = (name: string) => `${name}=; ${COOKIE}; Max-Age=0`
const VERIFIER = /^[A-Za-z0-9_-]{43}$/
// A search's body: a query and two filters, in characters.
const SEARCH_BODY_MAX = 4096
const QUERY_MAX = 500

// The page's own script and styles alone: nothing else runs, frames it, or
// learns where it was.
const PAGE_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
}

function cookieOf(req: Request, name: string) {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return ''
}

// This server's own origin: PUBLIC_URL, else the address the request came
// to (never a header the client chose).
const ownOrigin = (req: Request, env: ServerEnv) => (env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/+$/, '') : new URL(req.url).origin)
const sameOrigin = (req: Request, env: ServerEnv) => req.headers.get('origin') === ownOrigin(req, env)

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
const secret = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const codeOf = (login: string) => `${login.slice(0, 4)}-${login.slice(4, 8)}`.toUpperCase()

const see = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  for (const c of cookies) headers.append('set-cookie', c)
  return new Response(null, { status: 303, headers })
}
const withCookies = (res: Response, cookies: string[]) => {
  for (const c of cookies) res.headers.append('set-cookie', c)
  return res
}
const signedOut = () => withCookies(json({ error: 'Sign in first.' }, 401), [drop(SESSION_COOKIE)])

export async function dashFetch(req: Request, env: ServerEnv): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method
  if (!path.startsWith('/api/dash/')) {
    if (path === '/app/continue' && method === 'GET') return collect(req, env)
    return method === 'GET' || method === 'HEAD' ? shell(req, env) : notFound()
  }
  if (!hasDirectory(env)) return json({ error: 'This server has no accounts.' }, 404)
  const address = req.headers.get('cf-connecting-ip') ?? 'unknown'
  // A sign-in's start and a search cost the most: the join limit. The rest
  // (a tab's poll every 10 s) the events limit.
  const heavy = path === '/api/dash/signin' || path === '/api/dash/search'
  const limiter = heavy ? env.JOIN_LIMIT : env.EVENTS_LIMIT
  if (!(await limiter.limit({ key: `dash:${address}` })).success) return limitedResponse(heavy ? 'join' : 'events')
  if (method === 'POST' && !sameOrigin(req, env)) return json({ error: 'This request did not come from this server’s page.' }, 403)

  if (path === '/api/dash/signin' && method === 'POST') return signin(env)
  const token = cookieOf(req, SESSION_COOKIE)
  const dir = directoryStub(env)
  if (path === '/api/dash/signout' && method === 'POST') {
    if (token) await dir.endWeb(token)
    return withCookies(json({ ok: true }), [drop(SESSION_COOKIE)])
  }
  if (!token) return json({ error: 'Sign in first.' }, 401)
  if (path === '/api/dash/me' && method === 'GET') {
    const me = await dir.dashMe(token)
    return me ? json({ ...me, traces: tracesOn(env) }) : signedOut()
  }
  if (path === '/api/dash/live' && method === 'GET') {
    const live = await dir.dashLive(token)
    return live ? json(live) : signedOut()
  }
  if (path === '/api/dash/search' && method === 'POST') return search(req, env, token)
  return notFound()
}

// A fresh sign-in for this browser: its secret in a cookie, the start links
// (one a provider) made with its hash, and the code the sign-in page shows.
async function signin(env: ServerEnv) {
  const verifier = secret()
  const login = await sha256(verifier)
  const then = encodeURIComponent('/app/continue')
  const providers = Object.keys(providersFrom(env)).map(id => ({
    id,
    label: PROVIDERS[id]?.label ?? 'Test',
    href: `/auth/${id}/start?login=${login}&then=${then}`,
  }))
  return withCookies(json({ code: codeOf(login), providers }), [keep(LOGIN_COOKIE, verifier, LOGIN_SECONDS)])
}

// Back from the sign-in page's Continue: the sign-in this browser started,
// collected with its secret, becomes its session cookie. Anything else (no
// secret here, a sign-in not finished, another browser's) signs nobody in.
async function collect(req: Request, env: ServerEnv) {
  const verifier = cookieOf(req, LOGIN_COOKIE)
  const failed = see('/app/?signin=failed', [drop(LOGIN_COOKIE)])
  if (!hasDirectory(env) || !VERIFIER.test(verifier)) return failed
  const res = await directoryStub(env).fetch('https://directory.internal/api/auth/poll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verifier, web: true }),
  })
  const polled = (await res.json().catch(() => ({}))) as { status?: string; token?: string }
  if (polled.status !== 'done' || !polled.token?.startsWith('ssw_')) return failed
  return see('/app/', [drop(LOGIN_COOKIE), keep(SESSION_COOKIE, polled.token, WEB_SESSION_MS / 1000)])
}

// The traces this account may read now: its own and its teams', as MCP reads them.
async function search(req: Request, env: ServerEnv, token: string) {
  if (!tracesOn(env) || !hasDirectory(env))
    return json({ error: "This server doesn't keep session traces, so there is nothing to search.", traces: false }, 404)
  let body: { query?: unknown; since?: unknown; person?: unknown }
  try {
    body = JSON.parse(new TextDecoder().decode(await readBody(req, SEARCH_BODY_MAX)))
  } catch (error) {
    return statusOf(error) === 413 ? bodyTooLarge(SEARCH_BODY_MAX) : badRequest('A search needs a JSON body: { "query": "…" }.')
  }
  const query = typeof body?.query === 'string' ? body.query.trim().slice(0, QUERY_MAX) : ''
  if (!query) return badRequest('A search needs words.')
  const me = await directoryStub(env).dashMe(token)
  if (!me) return signedOut()
  const scopes = [`u:${me.account.id}`, ...me.teams.map(t => `t:${t.id}`)]
  const { searchTraces } = await traces()
  const person = typeof body.person === 'string' && body.person.trim() ? body.person.trim().slice(0, 120) : undefined
  // TracesEnv types its directory's stub loosely (its own calls say what they get).
  const hits = await searchTraces(env as unknown as TracesEnv, scopes, { query, since: timeOf(body.since), person, mode: 'hybrid', limit: 20 })
  return json({ hits })
}

// The app itself: a file it has, else its page (the app routes in the browser).
async function shell(req: Request, env: ServerEnv) {
  const url = new URL(req.url)
  if (!env.ASSETS) return notFound()
  if (url.pathname === '/app') return see(`/app/${url.search}`)
  let res = await env.ASSETS.fetch(new Request(url, { method: req.method, headers: req.headers }))
  const file = url.pathname.startsWith('/app/assets/')
  if (res.status === 404 && !file) res = await env.ASSETS.fetch(new Request(new URL('/app/', url), { method: req.method }))
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(PAGE_HEADERS)) out.headers.set(k, v)
  // The page names its files by their hash: they never change, it always may.
  out.headers.set('cache-control', file && res.ok ? 'public, max-age=31536000, immutable' : 'no-cache')
  return out
}
