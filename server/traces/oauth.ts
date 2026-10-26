// Signing in to session traces over OAuth 2.1, for Claude Code's MCP client.
// The provider (@cloudflare/workers-oauth-provider) does the protocol: its
// metadata, client registration, tokens, PKCE, and the 401 that sends a
// client to sign in. This file is the one page it leaves to us, /oauth/authorize
// (Hono): who is asking, the person's sign-in through the server's own
// accounts (GitHub, Google), and their Allow.
//
// The sign-in is the one Claude Code's /team uses (server/teams.ts): the page
// makes a secret, opens /auth/<provider>/start with its hash, and the server
// collects the account token by polling the directory with the secret, never
// letting it reach the page. The grant keeps that token (encrypted by the
// provider), so signing out, or leaving a team, holds at the next MCP call.
//
// Only a client that redirects to an app on this computer (Claude Code), or
// to Claude's own site, is let through: dynamic registration lets anyone
// register a client, and a page that ended on another site would hand that
// site this person's traces.

import { Hono } from 'hono'
import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import type { ConsentDescription } from '@cloudflare/workers-oauth-provider'
import { brandPage, escapeHtml } from '../core/index.ts'
import { providersFrom } from '../teams.ts'
import { directory, whoIs } from './index.ts'
import type { TracesEnv } from './index.ts'
import { handleMcp } from './mcp.ts'
import type { GrantProps } from './mcp.ts'

export const SCOPE = 'traces:read'
const SIGN_IN_TTL = 900 // seconds a page's sign-in waits
const CLAUDE_HOSTS = new Set(['claude.ai', 'claude.com'])
const PROVIDER_NAMES: Record<string, string> = { github: 'GitHub', google: 'Google', test: 'the test provider' }

export const isTracesPath = (path: string) => path === '/mcp' || path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-')
const allowedRedirect = (c: ConsentDescription) => c.redirectIsLoopback || CLAUDE_HOSTS.has(c.redirectHost)

const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
const secret = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const codeOf = (login: string) => `${login.slice(0, 4)}-${login.slice(4, 8)}`.toUpperCase()
const signInKey = (id: string) => `traces-signin:${id}`
type SignIn = { verifier: string; handle: string; token?: string; account?: string; name?: string }

// The page's one script: it asks every two seconds whether the sign-in it
// opened is done, then shows who signed in and lets Allow be pressed.
const PAGE_SCRIPT = `(function () {
  var box = document.getElementById('signin'), done = document.getElementById('done'), who = document.getElementById('who'), allow = document.getElementById('allow')
  function look() {
    fetch('/oauth/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: box.getAttribute('data-id') }) })
      .then(function (r) { return r.json() })
      .then(function (d) {
        if (d.status === 'done') { who.textContent = d.name; box.hidden = true; done.hidden = false; allow.disabled = false; return }
        if (d.status === 'expired') { box.textContent = 'This sign-in expired. Connect again from Claude Code.'; return }
        setTimeout(look, 2000)
      }, function () { setTimeout(look, 4000) })
  }
  look()
})()`
let scriptHash: Promise<string> | undefined
const scriptSource = () => (scriptHash ??= crypto.subtle.digest('SHA-256', new TextEncoder().encode(PAGE_SCRIPT)).then(d => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(d)))}'`))

async function page(heading: string, body: string, { status = 200, script = false, headers }: { status?: number; script?: boolean; headers?: Headers } = {}) {
  const res: Response = brandPage({ title: heading, eyebrow: 'Session traces', heading, body, status, script: script ? PAGE_SCRIPT : '' })
  const out = new Headers(headers)
  res.headers.forEach((v, k) => out.set(k, v))
  out.set('content-security-policy', `default-src 'none'; script-src ${script ? await scriptSource() : "'none'"}; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'`)
  out.set('referrer-policy', 'no-referrer')
  out.set('x-frame-options', 'DENY')
  return new Response(res.body, { status, headers: out })
}
const sorry = (heading: string, line: string, status = 400) => page(heading, `<p class="sub-copy">${escapeHtml(line)}</p>`, { status })

const app = new Hono<{ Bindings: TracesEnv }>()

app.get('/oauth/authorize', async c => {
  const helpers = c.env.OAUTH_PROVIDER!
  let request, consent
  try {
    request = await helpers.parseAuthRequest(c.req.raw)
    consent = await helpers.describeConsent(request)
  } catch {
    return sorry("This sign-in link isn't valid", 'Connect again from Claude Code.')
  }
  if (!allowedRedirect(consent)) return sorry("This app can't sign in here", `It would send your sign-in to ${consent.redirectHost}. Only Claude Code on this computer, or Claude's own site, can sign in to session traces.`, 403)
  const { handle, headers } = await helpers.beginConsent(request)
  const verifier = secret(), login = await sha256(verifier), id = secret()
  await c.env.OAUTH_KV!.put(signInKey(id), JSON.stringify({ verifier, handle: await sha256(handle) } satisfies SignIn), { expirationTtl: SIGN_IN_TTL })
  const links = Object.keys(providersFrom(c.env)).map(p => `<a class="btn-primary" href="/auth/${p}/start?login=${login}" target="_blank" rel="noopener">Sign in with ${escapeHtml(PROVIDER_NAMES[p] ?? p)}</a>`).join(' ')
  const where = consent.redirectIsLoopback ? `${escapeHtml(consent.redirectHost)}, an app on this computer` : escapeHtml(consent.redirectHost)
  const body = `
    <p class="sub-copy"><b>${escapeHtml(consent.clientName || 'An app')}</b> asks to search the traces of the shared sessions you can read: your teams' and your own. It can't change anything.</p>
    <p class="sub-copy">When you allow it, your sign-in goes to <b>${where}</b>.</p>
    <div id="signin" data-id="${id}">
      <p class="sub-copy first">First, sign in. The sign-in page shows the code <b>${codeOf(login)}</b>: continue there only if it matches.</p>
      <p class="cta">${links || 'This server has no sign-in set up.'}</p>
    </div>
    <form method="post" action="/oauth/authorize">
      <p class="sub-copy first" id="done" hidden>Signed in as <b id="who"></b>.</p>
      <input type="hidden" name="handle" value="${escapeHtml(handle)}">
      <input type="hidden" name="id" value="${id}">
      <p class="cta"><button class="btn-primary" id="allow" name="decision" value="allow" disabled>Allow</button><button class="btn-ghost" name="decision" value="deny">Deny</button></p>
    </form>`
  return page(`Let ${consent.clientName || 'this app'} search session traces`, body, { script: true, headers })
})

// Whether the page's sign-in is done; once it is, the account token is
// collected here and kept with the sign-in, never sent to the page.
app.post('/oauth/poll', async c => {
  const { id } = await c.req.json<{ id?: string }>().catch(() => ({ id: undefined }))
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(id)) return c.json({ status: 'expired' })
  const kv = c.env.OAUTH_KV!
  const entry = await kv.get<SignIn>(signInKey(id), 'json')
  if (!entry) return c.json({ status: 'expired' })
  if (entry.token) return c.json({ status: 'done', name: entry.name })
  const res = await directory(c.env).fetch('https://directory.internal/api/auth/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verifier: entry.verifier }) })
  const polled = (await res.json().catch(() => ({}))) as { status?: string; token?: string }
  // The directory knows a sign-in only once its link is opened, and says
  // `expired` before that: this page's own record (SIGN_IN_TTL) says when
  // it's over.
  if (polled.status !== 'done' || !polled.token) return c.json({ status: 'waiting' })
  const who = await whoIs(c.env, polled.token)
  if (!who) return c.json({ status: 'expired' })
  await kv.put(signInKey(id), JSON.stringify({ ...entry, token: polled.token, account: who.account.id, name: who.account.name } satisfies SignIn), { expirationTtl: SIGN_IN_TTL })
  return c.json({ status: 'done', name: who.account.name })
})

app.post('/oauth/authorize', async c => {
  const helpers = c.env.OAUTH_PROVIDER!
  const form = await c.req.parseBody()
  const handle = String(form.handle ?? ''), id = String(form.id ?? '')
  try {
    if (form.decision !== 'allow') {
      const denied = await helpers.denyConsent(c.req.raw, handle)
      return new Response(null, { status: 302, headers: denied.headers })
    }
    const entry = /^[A-Za-z0-9_-]{40,64}$/.test(id) ? await c.env.OAUTH_KV!.get<SignIn>(signInKey(id), 'json') : null
    // The sign-in must be the one this page started, for this consent.
    if (!entry?.token || !entry.account || entry.handle !== (await sha256(handle))) return sorry('Sign in first', 'Sign in on the previous page, then press Allow. Or connect again from Claude Code.')
    const approved = await helpers.approveConsent(c.req.raw, handle, { scope: [SCOPE] })
    await c.env.OAUTH_KV!.delete(signInKey(id))
    const props: GrantProps = { token: entry.token, account: entry.account }
    const { redirectTo } = await helpers.completeAuthorization({ request: approved.request, userId: entry.account, metadata: { name: entry.name }, scope: [SCOPE], props })
    const headers = new Headers(approved.headers)
    headers.set('location', redirectTo)
    return new Response(null, { status: 302, headers })
  } catch {
    return sorry('This sign-in has ended', 'It was used already, or it took too long. Connect again from Claude Code.')
  }
})

app.notFound(c => c.json({ error: 'Not found' }, 404))

// One provider an origin: its metadata names the origin it was reached at
// (PUBLIC_URL, or the request's own), which tests and a deploy differ in.
const providers = new Map<string, OAuthProvider<TracesEnv>>()
export function tracesFetch(req: Request, env: TracesEnv, ctx: ExecutionContext, origin: string) {
  let provider = providers.get(origin)
  if (!provider) {
    provider = new OAuthProvider<TracesEnv>({
      apiRoute: '/mcp',
      apiHandler: { fetch: (r, e, c) => handleMcp(r as Request, e, (c as ExecutionContext & { props?: GrantProps }).props) },
      defaultHandler: app as unknown as ExportedHandler<TracesEnv>,
      authorizeEndpoint: '/oauth/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: [SCOPE],
      requiredScopes: [SCOPE],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    })
    providers.set(origin, provider)
  }
  return provider.fetch(req, env, ctx)
}
