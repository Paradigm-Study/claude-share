// Accounts and teams for shared sessions: sign-in with GitHub or Google, teams
// people join by invite link, by their email's domain or by their GitHub
// organization, and the sessions shared with a team, listed for its members.
//
// Everything lives in one key-value store (a Durable Object's storage on
// Cloudflare, a JSON file for the Node server):
//   acct:<id>                 an account { id, provider, subject, name, login, email, emailVerified, githubOrgs }
//                             (email: the address it's shown with; emailVerified: its newest sign-in proved it)
//   ident:<provider>:<sub>    → account id; email:<address> → account id (verified emails only)
//   tok:<sha256>              a signed-in Claude Code { account, at } (the token itself is never kept)
//   login:<hash>              a sign-in under way (ten minutes): 'pending', then 'confirm' (who the provider
//                             said, waiting for the browser's Continue), then 'done' (the account id, until
//                             Claude Code collects it: its token is made then)
//   state:<id>                a provider's sign-in under way (ten minutes)
//   npgrant:<hash>            a native-pool enrollment proof (two minutes); only its hash is kept
//   team:<id>                 { id, name, createdAt, access: 'members' | 'link', domains, githubOrgs, invite }
//   inv:<code>                → team id
//   mem:<team>:<acct>         { role: 'owner' | 'member', at }; myteam:<acct>:<team> → 1
//   left:<team>:<acct>        left or was removed: its domain or org rule doesn't take them back
//   dom:<domain>:<team>, org:<org>:<team>   who joins by themselves
//   live:<team>:<room>        a session shared with the team { id, url, title, host, hostAccount, createdAt }
//   sinv:<acct>:<room>        a host's invite to that session { room: { id, url, title, host }, from: { id, name }, at, exp };
//                             rinv:<room>:<acct> → 1, so a session's invites go with it
//
// What's timed (invites, sign-ins under way) is deleted when it's due
// (`sweep`), the adapter woken for the next (`onDue`: a Durable Object's
// alarm, a Node timer) whether or not anyone asks; a session's end or expiry
// takes its invites and its place on its team's list (`roomEnded`).
//
// Rooms ask it two things (`shareCheck` when one is shared with a team,
// `joinCheck` when someone joins one) and tell it two (`register`,
// `unregister`); it asks rooms how they are (`roomInfo`) when listing, and
// tells a members-only team's rooms whom it has now (`keepTeam`), so someone
// who leaves it or is removed leaves its sessions too.

import { json, token, brandPage, commandBox, COPY_SCRIPT, INSTALL_COMMAND } from './core/index.ts'
import type { DirectoryClient, JsonObject } from './core/index.ts'
import { NativePoolGrants } from './native-pool.ts'
import type { NativePoolConfig } from './native-pool.ts'

// The records above, as the directory writes them.
export type Account = {
  id: string
  provider: string
  subject: string
  name: string
  login?: string
  email: string
  emailVerified: boolean
  githubOrgs: string[]
  idents?: string[]
  createdAt: number
  seenAt: number
}
// Who a provider said someone is.
export type Identity = {
  provider: string
  subject: string
  name?: string
  login?: string
  email?: string
  emailVerified: boolean
  githubOrgs?: string | string[]
}
type Role = 'owner' | 'member'
export type Team = { id: string; name: string; createdAt: number; access: 'members' | 'link'; domains?: string[]; githubOrgs?: string[]; invite: string }
type Membership = { role: Role; at: number }
type Listing = { id: string; url: string; title: string; host: string; hostAccount?: string; createdAt: number }
type SessionInvite = { room: { id: string; url: string; title: string; host: string }; from: { id: string; name: string }; at: number; exp: number }
// How a room is, as it answers for a team's list (RoomObject's `info`).
export type RoomInfo = { title?: string; ended?: boolean; people?: { name: string; role: string; online: boolean; account?: string }[] }
// The one key-value store: a Durable Object's storage, or a Map (mapStore).
// Its values are what the keys above say they are.
export type Kv = {
  get(key: string): Promise<any>
  put(key: string, value: unknown): Promise<unknown>
  delete(key: string): Promise<unknown>
  list(prefix: string): Promise<[string, any][]>
}
// A provider this server signs in with: its OAuth app's id and secret (none for the test one).
type ProviderKeys = { id?: string; secret?: string }
export type DirectoryOptions = {
  providers?: Record<string, ProviderKeys>
  roomInfo?: (id: string) => Promise<RoomInfo | null>
  keepTeam?: (room: string, team: string, allowed: string[]) => Promise<unknown>
  onDue?: (at: number) => void
  fetch?: typeof fetch
  nativePool?: NativePoolConfig | null
}

const LOGIN_MS = 10 * 60 * 1000
const INVITE_MS = 12 * 60 * 60 * 1000 // a session invite lasts half a day at most
// What Claude Code sends: the SHA-256 of its secret, in hex (anything else could never be collected).
const LOGIN_ID = /^[0-9a-f]{64}$/
// What one account may change in a minute: its teams, their invite links and
// members, invites it takes or sends. Counted in memory, in the one
// directory (a Durable Object on Cloudflare, the process on Node).
const CHANGES = { limit: 30, periodMs: 60_000, message: 'Too many changes from your account. Try again in a minute.' }
const TEAM_ID = /^[A-Za-z0-9_-]{8,40}$/
const NAME_MAX = 60
const DOMAIN = /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/
const ORG = /^[a-z0-9](?:[a-z0-9-]{0,38})$/
// Email providers anyone can sign up at: a team can't take everyone at one.
const PUBLIC_DOMAINS = new Set(
  'gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me gmx.com gmx.net mail.com yandex.com yandex.ru zoho.com qq.com 163.com 126.com naver.com hey.com fastmail.com tutanota.com duck.com users.noreply.github.com'.split(
    ' ',
  ),
)

// A store key's last part: the team in dom:<domain>:<team>, the account in
// mem:<team>:<account>.
const lastPart = (key: string) => key.slice(key.lastIndexOf(':') + 1)

export const PROVIDERS: Record<string, { label: string; authorize: string; scope: string }> = {
  github: {
    label: 'GitHub',
    authorize: 'https://github.com/login/oauth/authorize',
    scope: 'read:user user:email read:org',
  },
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'openid email profile',
  },
}

// Which providers this server can sign people in with: those with a client id
// and secret configured (and the test one, for the end-to-end test only).
export function providersFrom(env: {
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  AUTH_TEST?: string
}) {
  const out: Record<string, ProviderKeys> = {}
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) out.github = { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) out.google = { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET }
  if (env.AUTH_TEST === '1') out.test = {}
  return out
}

async function sha256(text: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('')
}

const clean = (v: unknown, max = NAME_MAX) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, max)
const domainOf = (email: unknown) =>
  (
    String(email ?? '')
      .toLowerCase()
      .split('@')[1] ?? ''
  ).trim()
const listOf = (value: unknown, test: RegExp): string[] =>
  [
    ...new Set(
      (Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/))
        .map((v: unknown) => String(v).trim().toLowerCase().replace(/^@/, ''))
        .filter(v => v && test.test(v)),
    ),
  ].slice(0, 20)

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, c => ESCAPES[c] ?? c)

// The sign-in and invite pages, in the site's look (brandPage): an eyebrow,
// the heading, then its words as paragraphs (escaped here) and whatever
// follows them (already markup).
function page(eyebrow: string, heading: string, lines: string | string[], more: { after?: string; script?: string; status?: number } = {}) {
  const body = (Array.isArray(lines) ? lines : [lines]).map(line => `<p class="sub-copy">${line}</p>`).join('')
  return brandPage({ title: heading, eyebrow, heading, body, ...more })
}
const startAgain = 'Start again from Claude Code: press <b>Team</b> above the prompt, or type <code>/team</code>.'
const alreadyIn = () => page('Signed in', "You're already signed in", 'Go back to Claude Code. You can close this tab.')
// Where a sign-in started from a page of this server's goes once it's done:
// the session traces' consent page (server/traces/oauth.ts), in the same
// tab. Only that path, so a start link can't send a browser anywhere else.
const BACK_PATH = /^\/oauth\/continue\?id=[A-Za-z0-9_-]{40,64}$/
const goBack = (back: string) => new Response(null, { status: 303, headers: { location: back, 'cache-control': 'no-store' } })
const doneAnswer = (rec: { back?: string }) => (rec.back ? goBack(rec.back) : alreadyIn())

// The confirmation page's Continue starts disabled, and this enables it once
// the page has been shown and focused for 400 ms and the pointer has moved
// over it since (a move with no distance, which a browser makes up as a
// window appears under the pointer, doesn't count), or a key is pressed after
// those 400 ms. Losing sight or focus starts it over. So a page someone else
// controls can't time a person's double-click to raise this window under it
// and have the second click continue. Without script it stays enabled
// (noscript): nobody can turn script off in someone else's browser.
const CONTINUE_SCRIPT = `(function () {
  var button = document.getElementById('continue'), since = 0, moved = false, at = '', timer = 0;
  function reset() { since = 0; moved = false; at = ''; clearTimeout(timer); button.disabled = true; }
  function shown() {
    if (document.visibilityState !== 'visible' || !document.hasFocus()) { reset(); return false; }
    if (!since) since = performance.now();
    return true;
  }
  function left() { return 400 - (performance.now() - since); }
  function ready() {
    clearTimeout(timer);
    if (!shown() || !moved) return;
    if (left() > 0) timer = setTimeout(ready, left() + 10);
    else button.disabled = false;
  }
  document.addEventListener('pointermove', function (e) {
    if (!shown()) return;
    var p = e.screenX + ',' + e.screenY;
    if ((at && p !== at) || e.movementX || e.movementY) moved = true;
    at = p;
    ready();
  });
  document.addEventListener('keydown', function () { if (shown() && left() <= 0) button.disabled = false; });
  document.addEventListener('visibilitychange', shown);
  window.addEventListener('focus', shown);
  window.addEventListener('blur', reset);
  shown();
})();`
// …allowed by its hash, the one script the page may run.
let continueHash: Promise<string> | null = null
const continueSource = () =>
  (continueHash ??= crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(CONTINUE_SCRIPT))
    .then(d => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(d)))}'`))

// The page whose Continue finishes a sign-in: never in a frame (nothing drawn
// over it can take the click), running no script but its own, never cached,
// and its address (the login) never sent on.
async function guarded(res: Response) {
  const headers = new Headers(res.headers)
  headers.set('x-frame-options', 'DENY')
  headers.set('content-security-policy', `frame-ancestors 'none'; script-src ${await continueSource()}`)
  headers.set('cache-control', 'no-store')
  headers.set('referrer-policy', 'no-referrer')
  return new Response(res.body, { status: res.status, headers })
}

export class Directory {
  kv: Kv
  providers: Record<string, ProviderKeys>
  roomInfo: (id: string) => Promise<RoomInfo | null>
  keepTeam: (room: string, team: string, allowed: string[]) => Promise<unknown>
  onDue: (at: number) => void
  fetch: typeof fetch
  changes: Map<string, { start: number; count: number }>
  nativePool: NativePoolGrants

  constructor(kv: Kv, opts: DirectoryOptions = {}) {
    this.kv = kv
    this.providers = opts.providers ?? {}
    this.roomInfo = opts.roomInfo ?? (async () => null)
    this.keepTeam = opts.keepTeam ?? (async () => {})
    this.onDue = opts.onDue ?? (() => {})
    this.fetch = opts.fetch ?? ((input, init) => fetch(input, init))
    this.changes = new Map() // account id → { start, count }: its minute (CHANGES)
    this.nativePool = new NativePoolGrants(kv, opts.nativePool ?? null, this.onDue)
  }

  // One change on the account's minute: false once it has made CHANGES.limit.
  change(accountId: string, now: number) {
    const w = this.changes.get(accountId)
    if (w && now - w.start < CHANGES.periodMs) return ++w.count <= CHANGES.limit
    if (this.changes.size >= 10_000) for (const [id, v] of this.changes) if (now - v.start >= CHANGES.periodMs) this.changes.delete(id)
    this.changes.set(accountId, { start: now, count: 1 })
    return true
  }

  // -- accounts --------------------------------------------------------------

  async accountOf(tokenText: unknown): Promise<Account | null> {
    const t = String(tokenText ?? '')
      .replace(/^Bearer\s+/i, '')
      .trim()
    if (!/^ssa_[A-Za-z0-9_-]{20,80}$/.test(t)) return null
    const rec = await this.kv.get(`tok:${await sha256(t)}`)
    return rec ? ((await this.kv.get(`acct:${rec.account}`)) ?? null) : null
  }

  // The account a confirmed identity is, made or brought up to date, and the
  // teams it now joins by itself. Its token is made only when Claude Code
  // collects the sign-in (mint, from poll).
  async signIn(identity: Identity, now: number) {
    const ident = `ident:${identity.provider}:${identity.subject}`
    const email = identity.emailVerified && identity.email ? String(identity.email).toLowerCase() : ''
    let id = (await this.kv.get(ident)) ?? (email ? await this.byEmail(email, identity.provider) : null)
    const before = id ? await this.kv.get(`acct:${id}`) : null
    id = before?.id ?? token(12)
    const account: Account = {
      ...before,
      id,
      provider: identity.provider,
      subject: String(identity.subject),
      name: clean(identity.name || identity.login || email.split('@')[0] || 'teammate'),
      login: identity.login ? clean(identity.login) : before?.login,
      // Shown as it was, but proof only of what this sign-in proved: an
      // address the provider no longer vouches for leads nowhere, and takes
      // no team by its domain.
      email: email || before?.email || '',
      emailVerified: Boolean(email),
      githubOrgs: identity.githubOrgs ? listOf(identity.githubOrgs, ORG) : (before?.githubOrgs ?? []),
      idents: [...new Set([...(before?.idents ?? []), ident])],
      createdAt: before?.createdAt ?? now,
      seenAt: now,
    }
    await this.kv.put(`acct:${id}`, account)
    await this.kv.put(ident, id)
    // An address the account moved from, or that its provider stopped
    // vouching for, is no longer its way in: whoever has it next (an address
    // reassigned, a domain sold) is someone else.
    if (before?.email && before.email !== email) await this.unindex(before.email, id)
    if (email) await this.kv.put(`email:${email}`, id)
    await this.autoJoin(account, now)
    return account
  }

  // The account a provider's verified address signs in to, when it's another
  // provider's identity of the same person: the account must still have that
  // address, and no identity of its own at this provider (a second one there,
  // with the same address, is that address deleted and made again for someone
  // else). Anything else in the index takes nobody.
  async byEmail(email: string, provider: string): Promise<string | null> {
    const id = await this.kv.get(`email:${email}`)
    const account: Account | null = id ? await this.kv.get(`acct:${id}`) : null
    if (!account || !account.emailVerified || account.email !== email) return null
    const idents = new Set([...(account.idents ?? []), `ident:${account.provider}:${account.subject}`])
    return [...idents].some(i => i.startsWith(`ident:${provider}:`)) ? null : account.id
  }

  // The address's index entry, only while it is this account's.
  async unindex(email: string, id: string) {
    if ((await this.kv.get(`email:${email}`)) === id) await this.kv.delete(`email:${email}`)
  }

  // A signed-in Claude Code's token, handed straight over: only its hash is kept.
  async mint(accountId: string, now: number) {
    const secret = `ssa_${token(24)}`
    await this.kv.put(`tok:${await sha256(secret)}`, { account: accountId, at: now })
    return secret
  }

  // Teams that take this account by its email's domain or its GitHub orgs.
  async autoJoin(account: Account, now: number) {
    const teams = new Set<string>()
    const domain = account.emailVerified ? domainOf(account.email) : ''
    if (domain) for (const [key] of await this.kv.list(`dom:${domain}:`)) teams.add(lastPart(key))
    for (const org of account.githubOrgs ?? []) for (const [key] of await this.kv.list(`org:${org}:`)) teams.add(lastPart(key))
    for (const team of teams) {
      if (await this.kv.get(`mem:${team}:${account.id}`)) continue
      if (await this.kv.get(`left:${team}:${account.id}`)) continue
      await this.addMember(team, account.id, 'member', now)
    }
  }

  async addMember(teamId: string, accountId: string, role: Role, now: number) {
    await this.kv.put(`mem:${teamId}:${accountId}`, { role, at: now })
    await this.kv.put(`myteam:${accountId}:${teamId}`, 1)
    await this.kv.delete(`left:${teamId}:${accountId}`)
  }

  async removeMember(teamId: string, accountId: string, opts: { remember?: boolean } = {}) {
    await this.kv.delete(`mem:${teamId}:${accountId}`)
    await this.kv.delete(`myteam:${accountId}:${teamId}`)
    if (opts.remember !== false) await this.kv.put(`left:${teamId}:${accountId}`, 1)
    const team: Team | undefined = await this.kv.get(`team:${teamId}`)
    const rooms: string[] = (await this.kv.list(`live:${teamId}:`)).map(([, entry]) => entry.id)
    // A team keeps an owner while it has anyone: the longest-standing member.
    // With nobody left, it goes, with its invite and what joined it by itself.
    const members: [string, Membership][] = await this.kv.list(`mem:${teamId}:`)
    await this.enforce(teamId, rooms, team?.access, members)
    if (!members.length) {
      if (team) {
        for (const [key] of await this.kv.list(`left:${teamId}:`)) await this.kv.delete(key)
        await this.kv.delete(`inv:${team.invite}`)
        for (const d of team.domains ?? []) await this.kv.delete(`dom:${d}:${teamId}`)
        for (const o of team.githubOrgs ?? []) await this.kv.delete(`org:${o}:${teamId}`)
        for (const [key] of await this.kv.list(`live:${teamId}:`)) await this.kv.delete(key)
        await this.kv.delete(`team:${teamId}`)
      }
      return
    }
    if (!members.some(([, m]) => m.role === 'owner')) {
      const [key, m] = members.sort((a, b) => a[1].at - b[1].at)[0]!
      await this.kv.put(key, { ...m, role: 'owner' })
    }
  }

  // A members-only team's sessions keep only its members as they are now
  // (someone left or was removed, or it just turned members-only): each room
  // lets go of the guests whose account isn't one, with what they hold open.
  async enforce(teamId: string, rooms: string[], access: string | undefined, members?: [string, Membership][]) {
    if (access !== 'members' || !rooms.length) return
    const allowed = (members ?? (await this.kv.list(`mem:${teamId}:`))).map(([key]) => lastPart(key))
    for (const id of rooms) await this.keepTeam(id, teamId, allowed).catch(() => {})
  }

  async teamsOf(account: Account) {
    const out: ReturnType<Directory['teamView']>[] = []
    for (const [key] of await this.kv.list(`myteam:${account.id}:`)) {
      const teamId = key.split(':')[2]
      const team = await this.kv.get(`team:${teamId}`)
      const mem = await this.kv.get(`mem:${teamId}:${account.id}`)
      if (team && mem) out.push(this.teamView(team, mem.role))
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  teamView(team: Team, role: Role) {
    return {
      id: team.id,
      name: team.name,
      role,
      access: team.access,
      ...(role === 'owner' ? { domains: team.domains ?? [], githubOrgs: team.githubOrgs ?? [] } : {}),
      invite: team.invite,
    }
  }

  // -- what rooms ask ---------------------------------------------------------

  // May this account share with this team? Returns its name for the room.
  async shareCheck(teamId: string, tokenText: string): ReturnType<DirectoryClient['shareCheck']> {
    const account = await this.accountOf(tokenText)
    if (!account) return { ok: false, status: 401, error: 'Sign in to share with a team: /team in Claude Code.' }
    const team: Team | null = TEAM_ID.test(String(teamId)) ? await this.kv.get(`team:${teamId}`) : null
    if (!team || !(await this.kv.get(`mem:${team.id}:${account.id}`))) return { ok: false, status: 403, error: "You're not in that team." }
    return { ok: true, team: { id: team.id, name: team.name }, account: { id: account.id, name: account.name } }
  }

  // May this person join a session shared with this team? The team's access
  // setting decides, as it is now.
  async joinCheck(teamId: string, tokenText: string): ReturnType<DirectoryClient['joinCheck']> {
    const team: Team | undefined = await this.kv.get(`team:${teamId}`)
    // The team is gone (its last person left): nobody can be checked against it.
    if (!team) return { ok: false, status: 403, error: 'This session was shared with a team that no longer exists. Ask the host to share it again.' }
    if (team.access === 'link') return { ok: true }
    const account = await this.accountOf(tokenText)
    if (!account)
      return {
        ok: false,
        status: 401,
        team: team.name,
        error: `This session is for ${team.name}. Sign in with an account in that team (/team in Claude Code), then open the link again.`,
      }
    if (!(await this.kv.get(`mem:${team.id}:${account.id}`)))
      return {
        ok: false,
        status: 403,
        team: team.name,
        error: `This session is for ${team.name}, and ${account.name} isn't in it. Ask someone in the team for its invite link.`,
      }
    return { ok: true, account: { id: account.id, name: account.name } }
  }

  // Who a sign-in is, for a room to know a person across their sessions.
  async whoIs(tokenText: string) {
    const account = await this.accountOf(tokenText)
    return account ? { id: account.id, name: account.name } : null
  }

  // A team's access setting, for a session's page to say who can join.
  async teamAccess(teamId: string): Promise<string | null> {
    return (await this.kv.get(`team:${teamId}`))?.access ?? null
  }

  // People who share a team with this account: whom it may invite.
  async teammates(account: Account) {
    const seen = new Map<string, { id: string; name: string; login?: string }>()
    for (const [key] of await this.kv.list(`myteam:${account.id}:`)) {
      for (const m of await this.members(lastPart(key))) if (m.id !== account.id && !seen.has(m.id)) seen.set(m.id, { id: m.id, name: m.name, login: m.login })
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  // A host invites teammates to the session it shares: each sees it in their
  // own Claude Code until they join, dismiss it, it ends, or a day passes.
  // Only people who share a team with the host can be invited.
  async sessionInvite(tokenText: string, room: SessionInvite['room'], to: unknown, now = Date.now()): ReturnType<DirectoryClient['sessionInvite']> {
    const account = await this.accountOf(tokenText)
    if (!account) return { ok: false, status: 401, error: 'Sign in to invite people: /team in Claude Code.' }
    if (!this.change(account.id, now)) return { ok: false, status: 429, error: CHANGES.message }
    const mates = new Map((await this.teammates(account)).map(m => [m.id, m]))
    const invited: string[] = []
    const refused: string[] = []
    for (const id of (Array.isArray(to) ? to : []).slice(0, 50).map(String)) {
      const mate = mates.get(id)
      if (!mate) {
        refused.push(id)
        continue
      }
      await this.kv.put(`sinv:${id}:${room.id}`, { room, from: { id: account.id, name: account.name }, at: now, exp: now + INVITE_MS })
      await this.kv.put(`rinv:${room.id}:${id}`, 1)
      invited.push(mate.name)
    }
    if (invited.length) this.onDue(now + INVITE_MS)
    return { ok: true, invited, refused }
  }

  // An invite gone (answered, ended, expired, its account deleted), with
  // its session's index of it.
  async dropInvite(accountId: string, roomId: string) {
    await this.kv.delete(`sinv:${accountId}:${roomId}`)
    await this.kv.delete(`rinv:${roomId}:${accountId}`)
  }

  // A session ended or expired: its invites go, and its place on its team's list.
  async roomEnded(roomId: string, teamId: string | null) {
    if (teamId) await this.kv.delete(`live:${teamId}:${roomId}`)
    for (const [key] of await this.kv.list(`rinv:${roomId}:`)) await this.dropInvite(key.slice(`rinv:${roomId}:`.length), roomId)
  }

  // What's due goes: invites past their 12 hours, sign-ins past their ten
  // minutes. Returns when the next is due, or null.
  async sweep(now: number) {
    let next: number | null = await this.nativePool.sweep(now)
    for (const prefix of ['sinv:', 'login:', 'state:']) {
      for (const [key, rec] of await this.kv.list(prefix)) {
        if (!(rec?.exp > now)) {
          const [, accountId = '', roomId = ''] = key.split(':')
          if (prefix === 'sinv:') await this.dropInvite(accountId, roomId)
          else await this.kv.delete(key)
        } else if (next === null || rec.exp < next) next = rec.exp
      }
    }
    return next
  }

  // An account's invites still good: an ended or expired session's go.
  async invitesOf(account: Account, now: number) {
    const out: { room: SessionInvite['room']; from: { name: string }; at: number }[] = []
    for (const [key, invite] of (await this.kv.list(`sinv:${account.id}:`)) as [string, SessionInvite][]) {
      const info = invite.exp > now ? await this.roomInfo(invite.room.id).catch(() => null) : null
      // Already there (another session of theirs joined): nothing to answer.
      const there = Array.isArray(info?.people) && info.people.some(p => p.account === account.id && p.online)
      if (!info || info.ended || there) {
        await this.dropInvite(account.id, key.slice(`sinv:${account.id}:`.length))
        continue
      }
      out.push({ room: { ...invite.room, title: info.title ?? invite.room.title }, from: { name: invite.from.name }, at: invite.at })
    }
    return out.sort((a, b) => b.at - a.at)
  }

  async register(teamId: string, room: Listing) {
    await this.kv.put(`live:${teamId}:${room.id}`, room)
  }

  async unregister(teamId: string, roomId: string) {
    await this.kv.delete(`live:${teamId}:${roomId}`)
  }

  async sessions(teamId: string) {
    const out: (Omit<Listing, 'title'> & { title: string; hostOnline: boolean; people: string[]; accounts: string[] })[] = []
    for (const [key, entry] of (await this.kv.list(`live:${teamId}:`)) as [string, Listing][]) {
      const info = await this.roomInfo(entry.id).catch(() => null)
      if (!info || info.ended) {
        await this.kv.delete(key) // ended or expired: off the list
        continue
      }
      const people = Array.isArray(info.people) ? info.people : []
      out.push({
        id: entry.id,
        url: entry.url,
        title: info.title ?? entry.title,
        host: entry.host,
        hostAccount: entry.hostAccount,
        hostOnline: people.some(p => p.role === 'host' && p.online),
        people: people.filter(p => p.online).map(p => p.name),
        // Who's in it by account: a person's own sessions are "in it" anywhere.
        accounts: people.filter(p => p.online && p.account).map(p => p.account ?? ''),
        createdAt: entry.createdAt,
      })
    }
    return out.sort((a, b) => Number(b.hostOnline) - Number(a.hostOnline) || b.createdAt - a.createdAt)
  }

  // -- HTTP ---------------------------------------------------------------------

  // Every path this owns: /auth/…, /api/auth/…, /api/me, /api/teams…, /api/invites/…, /i/<code>.
  static owns(pathname: string) {
    return (
      pathname === '/api/native-pool/enrollment' || /^\/(auth\/|api\/auth\/|api\/me(\/invites(\/[^/]+)?)?$|api\/teams(\/|$)|api\/invites\/|i\/)/.test(pathname)
    )
  }

  // What one address may do only so often (the join limit): start a sign-in,
  // make a team, take an invite. Polling and listing are not counted.
  static limited(pathname: string, method: string) {
    return (
      /^\/auth\/[^/]+\/start$/.test(pathname) ||
      (method === 'POST' && (/^\/api\/(teams|invites\/[^/]+)$/.test(pathname) || pathname === '/api/native-pool/enrollment'))
    )
  }

  async handle(req: Request, origin: string, now = Date.now()): Promise<Response> {
    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean)
    const method = req.method
    try {
      if (url.pathname === '/api/auth/providers') {
        return json({ providers: Object.keys(this.providers).map(id => ({ id, label: PROVIDERS[id]?.label ?? 'Test' })) })
      }
      if (parts[0] === 'auth' && parts.length === 3 && parts[2] === 'start') return this.start(parts[1]!, url, origin, now)
      if (parts[0] === 'auth' && parts.length === 3 && parts[2] === 'callback') return this.callback(parts[1]!, url, origin, now)
      if (url.pathname === '/auth/confirm')
        return method === 'POST' ? this.confirm(await readForm(req), now) : page('Sign-in', "This sign-in link isn't complete", startAgain)
      if (url.pathname === '/api/auth/poll' && method === 'POST') return this.poll(await readBody(req), now)
      if (parts[0] === 'i' && parts.length === 2) return this.invitePage(parts[1]!, origin)

      const account = await this.accountOf(req.headers.get('authorization'))
      if (!account) return json({ error: 'Sign in first: /team in Claude Code.' }, 401)

      if (url.pathname === '/api/auth/logout' && method === 'POST') {
        await this.kv.delete(
          `tok:${await sha256(
            String(req.headers.get('authorization'))
              .replace(/^Bearer\s+/i, '')
              .trim(),
          )}`,
        )
        return json({ ok: true })
      }
      if (url.pathname === '/api/me' && method === 'DELETE') return this.deleteAccount(account)
      // Every other change counts against the account's minute; signing out
      // and deleting the account always go through.
      if (method !== 'GET' && !this.change(account.id, now)) return json({ error: CHANGES.message }, 429)
      if (url.pathname === '/api/native-pool/enrollment' && method === 'POST') return this.nativePool.enroll(account.id, req, now)
      if (url.pathname === '/api/me' && method === 'GET')
        return json({ account: this.accountView(account), teams: await this.teamsOf(account), teammates: await this.teammates(account) })
      if (url.pathname === '/api/me/invites' && method === 'GET') return json({ invites: await this.invitesOf(account, now) })
      if (parts[0] === 'api' && parts[1] === 'me' && parts[2] === 'invites' && parts.length === 4 && method === 'DELETE') {
        await this.dropInvite(account.id, parts[3]!)
        return json({ ok: true })
      }
      if (url.pathname === '/api/teams' && method === 'POST') return this.createTeam(account, await readBody(req), now)
      if (parts[0] === 'api' && parts[1] === 'invites' && parts.length === 3 && method === 'POST') return this.acceptInvite(account, parts[2]!, now)
      if (parts[0] === 'api' && parts[1] === 'teams' && parts.length >= 3) {
        const team: Team | null = TEAM_ID.test(parts[2]!) ? await this.kv.get(`team:${parts[2]}`) : null
        const mem: Membership | null = team ? await this.kv.get(`mem:${team.id}:${account.id}`) : null
        if (!team || !mem) return json({ error: "No such team, or you're not in it." }, 404)
        const owner = mem.role === 'owner'
        const sub = parts.slice(3).join('/')
        if (sub === '' && method === 'GET') return json({ team: this.teamView(team, mem.role), members: await this.members(team.id) })
        if (sub === '' && method === 'PATCH') {
          if (!owner) return json({ error: 'Only an owner changes the team.' }, 403)
          const body = await readBody(req)
          const refused = this.unclaimable(account, body)
          if (refused) return json({ error: refused }, 400)
          return json({ team: this.teamView(await this.updateTeam(team, body, now), 'owner') })
        }
        if (sub === 'invite' && method === 'POST') {
          if (!owner) return json({ error: 'Only an owner makes a new invite link.' }, 403)
          await this.kv.delete(`inv:${team.invite}`)
          const next = { ...team, invite: token(12) }
          await this.kv.put(`inv:${next.invite}`, team.id)
          await this.kv.put(`team:${team.id}`, next)
          return json({ team: this.teamView(next, 'owner') })
        }
        if (sub === 'sessions' && method === 'GET') return json({ sessions: await this.sessions(team.id) })
        if (parts[3] === 'members' && parts.length === 5 && method === 'DELETE') {
          const who = parts[4] === 'me' ? account.id : parts[4]!
          if (who !== account.id && !owner) return json({ error: 'Only an owner removes people.' }, 403)
          // Only someone in it: a `left:` mark for anyone else would only grow the store.
          if (await this.kv.get(`mem:${team.id}:${who}`)) await this.removeMember(team.id, who)
          return json({ ok: true })
        }
      }
      return json({ error: 'Not found' }, 404)
    } catch (error) {
      return json({ error: String((error as Error | null)?.message ?? error).slice(0, 200) }, 400)
    }
  }

  accountView(account: Account) {
    return { id: account.id, name: account.name, login: account.login, email: account.email, provider: account.provider }
  }

  async members(teamId: string) {
    const out: { id: string; name: string; login?: string; role: Role }[] = []
    for (const [key, m] of (await this.kv.list(`mem:${teamId}:`)) as [string, Membership][]) {
      const a: Account | undefined = await this.kv.get(`acct:${key.split(':')[2]}`)
      if (a) out.push({ id: a.id, name: a.name, login: a.login, role: m.role })
    }
    return out.sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner') || a.name.localeCompare(b.name))
  }

  async createTeam(account: Account, body: JsonObject, now: number) {
    const name = clean(body.name)
    if (!name) return json({ error: 'A team needs a name.' }, 400)
    const team: Team = { id: token(9), name, createdAt: now, access: 'members', domains: [], githubOrgs: [], invite: token(12) }
    await this.kv.put(`team:${team.id}`, team)
    await this.kv.put(`inv:${team.invite}`, team.id)
    await this.addMember(team.id, account.id, 'owner', now)
    return json({ team: this.teamView(team, 'owner') })
  }

  // Who joins by themselves is limited to what the owner can show is theirs:
  // the domain of their own verified email (not a public provider's), and
  // GitHub organizations they're in. Otherwise anyone could pull strangers in,
  // and with them what those strangers share.
  unclaimable(account: Account, body: JsonObject) {
    const own = account.emailVerified ? domainOf(account.email) : ''
    if (body.domains !== undefined) {
      const bad = listOf(body.domains, DOMAIN).filter(d => d !== own || PUBLIC_DOMAINS.has(d))
      if (bad.length) {
        return own && !PUBLIC_DOMAINS.has(own)
          ? `You can add ${own}, the domain of your verified email, not ${bad.join(', ')}.`
          : `A team takes people by the domain of its owner's verified work email; yours (${own || 'none'}) isn't one. Use the invite link instead.`
      }
    }
    if (body.githubOrgs !== undefined) {
      const mine = new Set(account.githubOrgs ?? [])
      const bad = listOf(body.githubOrgs, ORG).filter(o => !mine.has(o))
      if (bad.length) return `You can add GitHub organizations you're in (sign in with GitHub to list them): not ${bad.join(', ')}.`
    }
    return ''
  }

  // An owner's changes. Only what changed is written, and only accounts a
  // newly added domain or organization takes are looked at: saving the same
  // lists again (or none) scans nothing.
  async updateTeam(team: Team, body: JsonObject, now = Date.now()) {
    const next: Team = { ...team }
    if (body.name !== undefined && clean(body.name)) next.name = clean(body.name)
    if (body.access === 'members' || body.access === 'link') next.access = body.access
    if (body.domains !== undefined) next.domains = listOf(body.domains, DOMAIN)
    if (body.githubOrgs !== undefined) next.githubOrgs = listOf(body.githubOrgs, ORG)
    const minus = (a: string[] | undefined, b: string[] | undefined) => (a ?? []).filter(x => !(b ?? []).includes(x))
    for (const d of minus(team.domains, next.domains)) await this.kv.delete(`dom:${d}:${team.id}`)
    for (const o of minus(team.githubOrgs, next.githubOrgs)) await this.kv.delete(`org:${o}:${team.id}`)
    const domains = minus(next.domains, team.domains)
    const orgs = minus(next.githubOrgs, team.githubOrgs)
    for (const d of domains) await this.kv.put(`dom:${d}:${team.id}`, 1)
    for (const o of orgs) await this.kv.put(`org:${o}:${team.id}`, 1)
    await this.kv.put(`team:${team.id}`, next)
    // Turned members-only: its sessions keep only its members.
    if (next.access === 'members' && team.access !== 'members')
      await this.enforce(
        team.id,
        (await this.kv.list(`live:${team.id}:`)).map(([, entry]) => entry.id),
        'members',
      )
    // People already signed in whom the new rules take in. Only an account
    // says which organizations it's in, so a new one reads every account
    // once; a new domain alone reads the verified-email index.
    const takes = (a: Account) => (a.emailVerified && domains.includes(domainOf(a.email))) || (a.githubOrgs ?? []).some(o => orgs.includes(o))
    const found = new Map<string, Account>()
    if (orgs.length) {
      for (const [, a] of (await this.kv.list('acct:')) as [string, Account][]) if (takes(a)) found.set(a.id, a)
    } else if (domains.length) {
      for (const [key, id] of (await this.kv.list('email:')) as [string, string][]) {
        if (found.has(id) || !domains.includes(domainOf(key.slice('email:'.length)))) continue
        const a: Account | undefined = await this.kv.get(`acct:${id}`)
        if (a && takes(a)) found.set(id, a)
      }
    }
    for (const a of found.values()) await this.autoJoin(a, now)
    return next
  }

  // The team an invite code is for, while it works.
  async inviteTeam(code: unknown): Promise<Team | null> {
    const teamId = /^[A-Za-z0-9_-]{8,40}$/.test(String(code ?? '')) ? await this.kv.get(`inv:${code}`) : null
    return teamId ? ((await this.kv.get(`team:${teamId}`)) ?? null) : null
  }

  async acceptInvite(account: Account, code: unknown, now: number) {
    const team = await this.inviteTeam(code)
    if (!team) return json({ error: "That invite link doesn't work any more. Ask for a new one." }, 404)
    const mem: Membership | undefined = await this.kv.get(`mem:${team.id}:${account.id}`)
    if (!mem) await this.addMember(team.id, account.id, 'member', now)
    return json({ team: this.teamView(team, mem?.role ?? 'member'), joined: !mem })
  }

  async deleteAccount(account: Account) {
    const teams = (await this.kv.list(`myteam:${account.id}:`)).map(([key]) => lastPart(key))
    // The sessions it shares, off its teams' lists (they go on, by link).
    for (const team of teams) for (const [key, entry] of await this.kv.list(`live:${team}:`)) if (entry?.hostAccount === account.id) await this.kv.delete(key)
    for (const team of teams) await this.removeMember(team, account.id, { remember: false })
    for (const [key, rec] of await this.kv.list('tok:')) if (rec.account === account.id) await this.kv.delete(key)
    // Invites to it, and those it sent, which carry its name.
    for (const [key, invite] of await this.kv.list('sinv:')) {
      const [, to = '', roomId = ''] = key.split(':')
      if (to === account.id || invite?.from?.id === account.id) await this.dropInvite(to, roomId)
    }
    for (const ident of new Set([...(account.idents ?? []), `ident:${account.provider}:${account.subject}`])) await this.kv.delete(ident)
    if (account.email) await this.unindex(account.email, account.id)
    await this.kv.delete(`acct:${account.id}`)
    return json({ ok: true })
  }

  // -- sign-in --------------------------------------------------------------------

  // Claude Code opens this in the person's browser with `login`, the SHA-256
  // of a secret it keeps, and then asks for the sign-in with that secret: a
  // link seen in a browser's history, or a process list, can't collect it.
  // Whoever makes a start link chooses its `login`, though, so the provider's
  // answer only asks (ask): the browser says yes before anything is signed
  // in. An invite code, when given, is taken once they're signed in.
  async start(provider: string, url: URL, origin: string, now: number) {
    if (!this.providers[provider])
      return page('Sign-in', "This sign-in isn't set up", 'This share server has no sign-in with that provider. Sharing by link works without one.')
    const login = url.searchParams.get('login') ?? ''
    if (!LOGIN_ID.test(login)) return page('Sign-in', "This sign-in link isn't complete", startAgain)
    const invite = url.searchParams.get('invite') ?? ''
    const then = url.searchParams.get('then') ?? ''
    const back = BACK_PATH.test(then) ? then : ''
    const known = await this.kv.get(`login:${login}`)
    if (known?.status === 'done') return doneAnswer(known)
    // Sign-ins nobody finished or collected go after their ten minutes.
    for (const prefix of ['login:', 'state:']) for (const [key, rec] of await this.kv.list(prefix)) if (rec.exp < now) await this.kv.delete(key)
    await this.kv.put(`login:${login}`, { status: 'pending', exp: now + LOGIN_MS })
    this.onDue(now + LOGIN_MS)
    if (provider === 'test') {
      // The end-to-end test's own provider: who to be comes in the link. It
      // asks in the browser as the others do.
      const email = clean(url.searchParams.get('email'), 120).toLowerCase()
      const identity: Identity = {
        provider: 'test',
        subject: email || login,
        name: url.searchParams.get('name') || email,
        email,
        emailVerified: Boolean(email),
        githubOrgs: url.searchParams.get('orgs') ?? '',
      }
      return this.ask(identity, login, invite, now, back)
    }
    const state = token(18)
    await this.kv.put(`state:${state}`, { provider, login, invite, back, exp: now + LOGIN_MS })
    const p = PROVIDERS[provider]!
    const q = new URLSearchParams({ client_id: this.providers[provider]!.id ?? '', redirect_uri: `${origin}/auth/${provider}/callback`, scope: p.scope, state })
    if (provider === 'google') {
      q.set('response_type', 'code')
      q.set('prompt', 'select_account')
    }
    return new Response(null, { status: 302, headers: { location: `${p.authorize}?${q}`, 'cache-control': 'no-store' } })
  }

  async callback(provider: string, url: URL, origin: string, now: number) {
    const state = await this.kv.get(`state:${url.searchParams.get('state') ?? ''}`)
    if (!state || state.provider !== provider || state.exp < now) return page('Sign-in', 'This sign-in expired', ['A sign-in waits ten minutes.', startAgain])
    await this.kv.delete(`state:${url.searchParams.get('state')}`)
    const code = url.searchParams.get('code')
    if (!code) return page('Sign-in', 'Sign-in cancelled', 'Nothing changed. Sign in from Claude Code whenever you like.')
    try {
      const identity = await this.identity(provider, code, `${origin}/auth/${provider}/callback`)
      return await this.ask(identity, state.login, state.invite, now, state.back ?? '')
    } catch (error) {
      return page('Sign-in', "Sign-in didn't work", [esc(String((error as Error | null)?.message ?? error).slice(0, 200)), startAgain])
    }
  }

  // The provider has said who this is: the browser is asked before anything
  // is signed in. The page shows the code Claude Code shows (the start of
  // `login`), so someone who opened another person's start link can tell
  // it isn't theirs, and only its Continue, a POST carrying this page's
  // nonce, goes on (CONTINUE_SCRIPT: not a click timed for it).
  async ask(identity: Identity, login: string, invite: string, now: number, back = '') {
    const known = await this.kv.get(`login:${login}`)
    if (known?.status === 'done') return doneAnswer(known)
    const nonce = token(18)
    await this.kv.put(`login:${login}`, { status: 'confirm', identity, invite, back, nonce, exp: now + LOGIN_MS })
    const email = clean(identity.email, 120)
    const name = clean(identity.name || identity.login || email.split('@')[0] || 'teammate')
    const team = invite ? await this.inviteTeam(invite) : null
    const code = `${login.slice(0, 4)}-${login.slice(4, 8)}`.toUpperCase()
    const as = `${esc(name)}${email ? ` (${esc(email)})` : ''}`
    // Started from a page of this server's, that page showed the code.
    const who = back ? `You're signing in as ${as}. The page you came from` : `Claude Code is signing in as ${as}. It`
    return guarded(
      page(
        'Sign-in',
        'Finish signing in',
        [
          `${who} shows the code <b>${code}</b>. Continue only if you started signing in from Claude Code just now and the codes match.`,
          ...(team ? [`Continuing also joins you to the team <b>${esc(team.name)}</b>.`] : []),
        ],
        {
          after: `<form class="cta" method="post" action="/auth/confirm"><input type="hidden" name="login" value="${esc(login)}"><input type="hidden" name="nonce" value="${esc(nonce)}"><button type="submit" class="btn-primary" id="continue" disabled>Continue</button><noscript><style>#continue{display:none}</style><button type="submit" class="btn-primary">Continue</button></noscript></form>`,
          script: CONTINUE_SCRIPT,
        },
      ),
    )
  }

  // The confirmation page's Continue. Only the page's own nonce finishes
  // it: a form another site posts can't, nor a page a newer start has
  // replaced.
  async confirm(form: URLSearchParams, now: number) {
    const login = String(form.get('login') ?? '')
    const rec = LOGIN_ID.test(login) ? await this.kv.get(`login:${login}`) : null
    if (!rec || rec.exp < now) {
      if (rec) await this.kv.delete(`login:${login}`)
      return page('Sign-in', 'This sign-in expired', ['A sign-in waits ten minutes.', startAgain], { status: 410 })
    }
    if (rec.status === 'done') return doneAnswer(rec)
    if (rec.status !== 'confirm' || !rec.nonce || form.get('nonce') !== rec.nonce) {
      return page(
        'Sign-in',
        'This sign-in page is out of date',
        ['Nothing changed: a newer sign-in started since it opened, or it came from somewhere else.', startAgain],
        { status: 403 },
      )
    }
    return this.finish(rec.identity, login, rec.invite, now, rec.back ?? '')
  }

  // Signs the confirmed identity in and takes its invite. No token yet:
  // storage never holds one, so it's made as Claude Code collects it (poll).
  async finish(identity: Identity, login: string, invite: string, now: number, back = '') {
    const account = await this.signIn(identity, now)
    let joined: { id: string; name: string } | null = null
    if (invite) {
      const res = await this.acceptInvite(account, invite, now)
      if (res.ok) joined = ((await res.json()) as { team?: { id: string; name: string } }).team ?? null
    }
    await this.kv.put(`login:${login}`, { status: 'done', account: account.id, joined: joined?.id ?? null, back, exp: now + LOGIN_MS })
    // Back to the page the sign-in started from, whose own press finishes it.
    if (back) return goBack(back)
    return page('Signed in', `You're signed in, ${account.name}`, [
      ...(joined ? [`You're in <b>${esc(joined.name)}</b> now: its live sessions show in your Team panel.`] : []),
      'Go back to Claude Code: it has picked up the sign-in. You can close this tab.',
    ])
  }

  // Delivered once, to whoever has the secret behind `login`, and only once
  // the browser's Continue finished it: the token is made now, so Claude
  // Code keeps it and the server only its hash. An expired sign-in is
  // deleted as it's asked for, not only by the next start's sweep.
  async poll(body: JsonObject, now: number) {
    const verifier = String(body.verifier ?? '')
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(verifier)) return json({ error: 'bad verifier' }, 400)
    const login = await sha256(verifier)
    const rec = await this.kv.get(`login:${login}`)
    if (rec && rec.exp < now) await this.kv.delete(`login:${login}`)
    if (!rec || rec.exp < now) return json({ status: 'expired' })
    if (rec.status !== 'done') return json({ status: rec.status === 'confirm' ? 'confirm' : 'pending' })
    await this.kv.delete(`login:${login}`)
    // The account went since (deleted from another session): nothing to
    // hand over.
    const account = rec.account ? await this.kv.get(`acct:${rec.account}`) : null
    if (!account) return json({ status: 'expired' })
    return json({
      status: 'done',
      token: await this.mint(account.id, now),
      joined: rec.joined ?? null,
      account: this.accountView(account),
      teams: await this.teamsOf(account),
    })
  }

  async identity(provider: string, code: string, redirect: string): Promise<Identity> {
    const cfg = this.providers[provider]
    if (!cfg) throw new Error(`no sign-in with ${provider} here`)
    if (provider === 'github') {
      const tok = await this.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: cfg.id, client_secret: cfg.secret, code, redirect_uri: redirect }),
      }).then(r => r.json() as Promise<JsonObject>)
      if (!tok.access_token) throw new Error(`GitHub sign-in failed: ${tok.error_description ?? tok.error ?? 'no token'}`)
      const gh = (path: string): Promise<any> =>
        this.fetch(`https://api.github.com${path}`, {
          headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'claude-share' },
        }).then(r => (r.ok ? r.json() : null))
      const [user, emails, orgs] = await Promise.all([gh('/user'), gh('/user/emails'), gh('/user/orgs?per_page=100')])
      if (!user?.id) throw new Error('GitHub sign-in failed: no user')
      // Its addresses unread say nothing either way: try again, rather than take that as none.
      if (!Array.isArray(emails)) throw new Error("GitHub sign-in failed: couldn't read your email addresses. Try again.")
      const primary = emails.find((e: JsonObject) => e.primary && e.verified) ?? emails.find((e: JsonObject) => e.verified) ?? null
      return {
        provider,
        subject: String(user.id),
        login: user.login,
        name: user.name || user.login,
        email: primary?.email ?? '',
        emailVerified: Boolean(primary),
        githubOrgs: Array.isArray(orgs) ? orgs.map((o: JsonObject) => o.login) : [],
      }
    }
    if (provider === 'google') {
      const tok = await this.fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: cfg.id ?? '', client_secret: cfg.secret ?? '', redirect_uri: redirect, grant_type: 'authorization_code' }),
      }).then(r => r.json() as Promise<JsonObject>)
      if (!tok.access_token) throw new Error(`Google sign-in failed: ${tok.error_description ?? tok.error ?? 'no token'}`)
      const user = await this.fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } }).then(
        r => r.json() as Promise<JsonObject>,
      )
      if (!user?.sub) throw new Error('Google sign-in failed: no user')
      return { provider, subject: user.sub, name: user.name || user.email, email: user.email ?? '', emailVerified: user.email_verified === true }
    }
    throw new Error('unknown provider')
  }

  // An invite link opened in a browser: what it is, and how to take it in
  // Claude Code (Desktop opens a new session with the link as its prompt).
  async invitePage(code: string, origin: string) {
    const team = await this.inviteTeam(code)
    if (!team)
      return page(
        'Team invite',
        "This invite doesn't work any more",
        'Someone in the team made a new link, or the team is gone. Ask them for the current one.',
        { status: 404 },
      )
    const link = `${origin}/i/${code}`
    const name = esc(team.name)
    return page(
      'Team invite',
      `Join ${team.name}`,
      [`${name} shares its Claude Code sessions here. Join, and they show in your Team panel as they go live, a press from joining.`],
      {
        after: `<div class="cta">
  <a class="btn-primary" href="claude://code/new?q=${encodeURIComponent(link)}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>Open in Claude Desktop</a>
  <button type="button" class="btn-ghost" data-copy="invite-link">Copy link</button>
</div>
<p class="status">A new session opens with the invite as its message: press Enter, then sign in with GitHub or Google.</p>
<code id="invite-link" hidden>${esc(link)}</code>
<details class="first">
  <summary>First time? Install the plugin once</summary>
  <p>Paste this in a terminal, then start a new Claude Code session (or quit and reopen Claude Desktop):</p>
  ${commandBox('install', INSTALL_COMMAND, 'Copy install command')}
  <p>In a terminal instead of Desktop? Start <code class="inline">claude</code> and paste the invite link as your message.</p>
</details>`,
        script: COPY_SCRIPT,
      },
    )
  }
}

// The directory's bodies, in characters (the Worker bounds their bytes at
// three a character before reading them): JSON, or a browser's form ('form').
export const BODY_CHARS = 16_000
async function bodyText(req: Request) {
  const text = await req.text()
  if (text.length > BODY_CHARS) throw new Error('body too large')
  return text
}
async function readBody(req: Request): Promise<JsonObject> {
  const text = await bodyText(req)
  return text ? JSON.parse(text) : {}
}
const readForm = async (req: Request) => new URLSearchParams(await bodyText(req))

// A store over a plain Map, for the Node server (persisted by its caller).
export function mapStore(map: Map<string, unknown>, onChange = () => {}): Kv {
  return {
    get: async key => map.get(key),
    put: async (key, value) => {
      map.set(key, value)
      onChange()
    },
    delete: async key => {
      map.delete(key)
      onChange()
    },
    list: async prefix => [...map.entries()].filter(([k]) => k.startsWith(prefix)),
  }
}
