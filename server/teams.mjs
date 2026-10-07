// Accounts and teams for shared sessions: sign-in with GitHub or Google, teams
// people join by invite link, by their email's domain or by their GitHub
// organization, and the sessions shared with a team, listed for its members.
//
// Everything lives in one key-value store (a Durable Object's storage on
// Cloudflare, a JSON file for the Node server):
//   acct:<id>                 an account { id, provider, subject, name, login, email, emailVerified, githubOrgs }
//   ident:<provider>:<sub>    → account id; email:<address> → account id (verified emails only)
//   tok:<sha256>              a signed-in Claude Code { account, at } (the token itself is never kept)
//   login:<hash>, state:<id>  a sign-in under way (ten minutes)
//   team:<id>                 { id, name, createdAt, access: 'members' | 'link', domains, githubOrgs, invite }
//   inv:<code>                → team id
//   mem:<team>:<acct>         { role: 'owner' | 'member', at }; myteam:<acct>:<team> → 1
//   left:<team>:<acct>        left or was removed: its domain or org rule doesn't take them back
//   dom:<domain>:<team>, org:<org>:<team>   who joins by themselves
//   live:<team>:<room>        a session shared with the team { id, url, title, host, hostAccount, createdAt }
//
// Rooms ask it two things (`shareCheck` when one is shared with a team,
// `joinCheck` when someone joins one) and tell it two (`register`,
// `unregister`); it asks rooms how they are (`roomInfo`) when listing.

import { json, token, brandPage, commandBox, COPY_SCRIPT, INSTALL_COMMAND } from './core.mjs'

const LOGIN_MS = 10 * 60 * 1000
const LOGIN_ID = /^[A-Za-z0-9_-]{20,64}$/
const TEAM_ID = /^[A-Za-z0-9_-]{8,40}$/
const NAME_MAX = 60
const DOMAIN = /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/
const ORG = /^[a-z0-9](?:[a-z0-9-]{0,38})$/
// Email providers anyone can sign up at: a team can't take everyone at one.
const PUBLIC_DOMAINS = new Set(
  'gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me gmx.com gmx.net mail.com yandex.com yandex.ru zoho.com qq.com 163.com 126.com naver.com hey.com fastmail.com tutanota.com duck.com users.noreply.github.com'.split(' '),
)

export const PROVIDERS = {
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
export function providersFrom(env) {
  const out = {}
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) out.github = { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) out.google = { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET }
  if (env.AUTH_TEST === '1') out.test = {}
  return out
}

async function sha256(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('')
}

const clean = (v, max = NAME_MAX) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max)
const domainOf = email => (String(email ?? '').toLowerCase().split('@')[1] ?? '').trim()
const listOf = (value, test) =>
  [...new Set((Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/)).map(v => String(v).trim().toLowerCase().replace(/^@/, '')).filter(v => v && test.test(v)))].slice(0, 20)

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// The sign-in and invite pages, in the site's look (brandPage): an eyebrow,
// the heading, then its words as paragraphs (escaped here) and whatever
// follows them (already markup).
function page(eyebrow, heading, lines, more = {}) {
  const body = (Array.isArray(lines) ? lines : [lines]).map(line => `<p class="sub-copy">${line}</p>`).join('')
  return brandPage({ title: heading, eyebrow, heading, body, ...more })
}
const startAgain = 'Start again from Claude Code: press <b>Team</b> above the prompt, or type <code>/team</code>.'

export class Directory {
  // kv: { get(key), put(key, value), delete(key), list(prefix) → [key, value][] }
  // opts: { providers, roomInfo(id) → info | null, fetch }
  constructor(kv, opts = {}) {
    this.kv = kv
    this.providers = opts.providers ?? {}
    this.roomInfo = opts.roomInfo ?? (async () => null)
    this.fetch = opts.fetch ?? ((...a) => fetch(...a))
  }

  // -- accounts --------------------------------------------------------------

  async accountOf(tokenText) {
    const t = String(tokenText ?? '').replace(/^Bearer\s+/i, '').trim()
    if (!/^ssa_[A-Za-z0-9_-]{20,80}$/.test(t)) return null
    const rec = await this.kv.get(`tok:${await sha256(t)}`)
    return rec ? ((await this.kv.get(`acct:${rec.account}`)) ?? null) : null
  }

  async signIn(identity, now) {
    const ident = `ident:${identity.provider}:${identity.subject}`
    const email = identity.emailVerified && identity.email ? String(identity.email).toLowerCase() : ''
    let id = (await this.kv.get(ident)) ?? (email ? await this.kv.get(`email:${email}`) : null)
    const before = id ? await this.kv.get(`acct:${id}`) : null
    id = before?.id ?? token(12)
    const account = {
      ...before,
      id,
      provider: identity.provider,
      subject: String(identity.subject),
      name: clean(identity.name || identity.login || email.split('@')[0] || 'teammate'),
      login: identity.login ? clean(identity.login) : before?.login,
      email: email || before?.email || '',
      emailVerified: Boolean(email) || Boolean(before?.emailVerified),
      githubOrgs: identity.githubOrgs ? listOf(identity.githubOrgs, ORG) : before?.githubOrgs ?? [],
      idents: [...new Set([...(before?.idents ?? []), ident])],
      createdAt: before?.createdAt ?? now,
      seenAt: now,
    }
    await this.kv.put(`acct:${id}`, account)
    await this.kv.put(ident, id)
    if (email) await this.kv.put(`email:${email}`, id)
    await this.autoJoin(account, now)
    const secret = `ssa_${token(24)}`
    await this.kv.put(`tok:${await sha256(secret)}`, { account: id, at: now })
    return { account, token: secret }
  }

  // Teams that take this account by its email's domain or its GitHub orgs.
  async autoJoin(account, now) {
    const teams = new Set()
    const domain = account.emailVerified ? domainOf(account.email) : ''
    if (domain) for (const [key] of await this.kv.list(`dom:${domain}:`)) teams.add(key.split(':')[2])
    for (const org of account.githubOrgs ?? []) for (const [key] of await this.kv.list(`org:${org}:`)) teams.add(key.split(':')[2])
    for (const team of teams) {
      if (await this.kv.get(`mem:${team}:${account.id}`)) continue
      if (await this.kv.get(`left:${team}:${account.id}`)) continue
      await this.addMember(team, account.id, 'member', now)
    }
  }

  async addMember(teamId, accountId, role, now) {
    await this.kv.put(`mem:${teamId}:${accountId}`, { role, at: now })
    await this.kv.put(`myteam:${accountId}:${teamId}`, 1)
    await this.kv.delete(`left:${teamId}:${accountId}`)
  }

  async removeMember(teamId, accountId, opts = {}) {
    await this.kv.delete(`mem:${teamId}:${accountId}`)
    await this.kv.delete(`myteam:${accountId}:${teamId}`)
    if (opts.remember !== false) await this.kv.put(`left:${teamId}:${accountId}`, 1)
    // A team keeps an owner while it has anyone: the longest-standing member.
    // With nobody left, it goes, with its invite and what joined it by itself.
    const members = await this.kv.list(`mem:${teamId}:`)
    if (!members.length) {
      const team = await this.kv.get(`team:${teamId}`)
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
      const [key, m] = members.sort((a, b) => a[1].at - b[1].at)[0]
      await this.kv.put(key, { ...m, role: 'owner' })
    }
  }

  async teamsOf(account) {
    const out = []
    for (const [key] of await this.kv.list(`myteam:${account.id}:`)) {
      const teamId = key.split(':')[2]
      const team = await this.kv.get(`team:${teamId}`)
      const mem = await this.kv.get(`mem:${teamId}:${account.id}`)
      if (team && mem) out.push(this.teamView(team, mem.role))
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  teamView(team, role) {
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
  async shareCheck(teamId, tokenText) {
    const account = await this.accountOf(tokenText)
    if (!account) return { ok: false, status: 401, error: 'Sign in to share with a team: /team in Claude Code.' }
    const team = TEAM_ID.test(String(teamId)) ? await this.kv.get(`team:${teamId}`) : null
    if (!team || !(await this.kv.get(`mem:${team.id}:${account.id}`))) return { ok: false, status: 403, error: "You're not in that team." }
    return { ok: true, team: { id: team.id, name: team.name }, account: { id: account.id, name: account.name } }
  }

  // May this person join a session shared with this team? The team's access
  // setting decides, as it is now.
  async joinCheck(teamId, tokenText) {
    const team = await this.kv.get(`team:${teamId}`)
    // The team is gone (its last person left): nobody can be checked against it.
    if (!team) return { ok: false, status: 403, error: 'This session was shared with a team that no longer exists. Ask the host to share it again.' }
    if (team.access === 'link') return { ok: true }
    const account = await this.accountOf(tokenText)
    if (!account) return { ok: false, status: 401, team: team.name, error: `This session is for ${team.name}. Sign in with an account in that team (/team in Claude Code), then open the link again.` }
    if (!(await this.kv.get(`mem:${team.id}:${account.id}`))) return { ok: false, status: 403, team: team.name, error: `This session is for ${team.name}, and ${account.name} isn't in it. Ask someone in the team for its invite link.` }
    return { ok: true, account: { id: account.id, name: account.name } }
  }

  // A team's access setting, for a session's page to say who can join.
  async teamAccess(teamId) {
    return (await this.kv.get(`team:${teamId}`))?.access ?? null
  }

  async register(teamId, room) {
    await this.kv.put(`live:${teamId}:${room.id}`, room)
  }

  async unregister(teamId, roomId) {
    await this.kv.delete(`live:${teamId}:${roomId}`)
  }

  async sessions(teamId) {
    const out = []
    for (const [key, entry] of await this.kv.list(`live:${teamId}:`)) {
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
        createdAt: entry.createdAt,
      })
    }
    return out.sort((a, b) => Number(b.hostOnline) - Number(a.hostOnline) || b.createdAt - a.createdAt)
  }

  // -- HTTP ---------------------------------------------------------------------

  // Every path this owns: /auth/…, /api/auth/…, /api/me, /api/teams…, /api/invites/…, /i/<code>.
  static owns(pathname) {
    return /^\/(auth\/|api\/auth\/|api\/me$|api\/teams(\/|$)|api\/invites\/|i\/)/.test(pathname)
  }

  // What one address may do only so often (the join limit): start a sign-in,
  // make a team, take an invite. Polling and listing are not counted.
  static limited(pathname, method) {
    return /^\/auth\/[^/]+\/start$/.test(pathname) || (method === 'POST' && /^\/api\/(teams|invites\/[^/]+)$/.test(pathname))
  }

  async handle(req, origin, now = Date.now()) {
    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean)
    const method = req.method
    try {
      if (url.pathname === '/api/auth/providers') {
        return json({ providers: Object.keys(this.providers).map(id => ({ id, label: PROVIDERS[id]?.label ?? 'Test' })) })
      }
      if (parts[0] === 'auth' && parts.length === 3 && parts[2] === 'start') return this.start(parts[1], url, origin, now)
      if (parts[0] === 'auth' && parts.length === 3 && parts[2] === 'callback') return this.callback(parts[1], url, origin, now)
      if (url.pathname === '/api/auth/poll' && method === 'POST') return this.poll(await readBody(req), now)
      if (parts[0] === 'i' && parts.length === 2) return this.invitePage(parts[1], origin)

      const account = await this.accountOf(req.headers.get('authorization'))
      if (!account) return json({ error: 'Sign in first: /team in Claude Code.' }, 401)

      if (url.pathname === '/api/auth/logout' && method === 'POST') {
        await this.kv.delete(`tok:${await sha256(String(req.headers.get('authorization')).replace(/^Bearer\s+/i, '').trim())}`)
        return json({ ok: true })
      }
      if (url.pathname === '/api/me' && method === 'GET') return json({ account: this.accountView(account), teams: await this.teamsOf(account) })
      if (url.pathname === '/api/me' && method === 'DELETE') return this.deleteAccount(account)
      if (url.pathname === '/api/teams' && method === 'POST') return this.createTeam(account, await readBody(req), now)
      if (parts[0] === 'api' && parts[1] === 'invites' && parts.length === 3 && method === 'POST') return this.acceptInvite(account, parts[2], now)
      if (parts[0] === 'api' && parts[1] === 'teams' && parts.length >= 3) {
        const team = TEAM_ID.test(parts[2]) ? await this.kv.get(`team:${parts[2]}`) : null
        const mem = team ? await this.kv.get(`mem:${team.id}:${account.id}`) : null
        if (!team || !mem) return json({ error: "No such team, or you're not in it." }, 404)
        const owner = mem.role === 'owner'
        const sub = parts.slice(3).join('/')
        if (sub === '' && method === 'GET') return json({ team: this.teamView(team, mem.role), members: await this.members(team.id) })
        if (sub === '' && method === 'PATCH') {
          if (!owner) return json({ error: 'Only an owner changes the team.' }, 403)
          const body = await readBody(req)
          const refused = this.unclaimable(account, body)
          if (refused) return json({ error: refused }, 400)
          return json({ team: this.teamView(await this.updateTeam(team, body), 'owner') })
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
          const who = parts[4] === 'me' ? account.id : parts[4]
          if (who !== account.id && !owner) return json({ error: 'Only an owner removes people.' }, 403)
          await this.removeMember(team.id, who)
          return json({ ok: true })
        }
      }
      return json({ error: 'Not found' }, 404)
    } catch (error) {
      return json({ error: String(error?.message ?? error).slice(0, 200) }, 400)
    }
  }

  accountView(account) {
    return { id: account.id, name: account.name, login: account.login, email: account.email, provider: account.provider }
  }

  async members(teamId) {
    const out = []
    for (const [key, m] of await this.kv.list(`mem:${teamId}:`)) {
      const a = await this.kv.get(`acct:${key.split(':')[2]}`)
      if (a) out.push({ id: a.id, name: a.name, login: a.login, role: m.role })
    }
    return out.sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner') || a.name.localeCompare(b.name))
  }

  async createTeam(account, body, now) {
    const name = clean(body.name)
    if (!name) return json({ error: 'A team needs a name.' }, 400)
    const team = { id: token(9), name, createdAt: now, access: 'members', domains: [], githubOrgs: [], invite: token(12) }
    await this.kv.put(`team:${team.id}`, team)
    await this.kv.put(`inv:${team.invite}`, team.id)
    await this.addMember(team.id, account.id, 'owner', now)
    return json({ team: this.teamView(team, 'owner') })
  }

  // Who joins by themselves is limited to what the owner can show is theirs:
  // the domain of their own verified email (not a public provider's), and
  // GitHub organizations they're in. Otherwise anyone could pull strangers in,
  // and with them what those strangers share.
  unclaimable(account, body) {
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

  async updateTeam(team, body) {
    const next = { ...team }
    if (body.name !== undefined && clean(body.name)) next.name = clean(body.name)
    if (body.access === 'members' || body.access === 'link') next.access = body.access
    if (body.domains !== undefined) {
      for (const d of team.domains ?? []) await this.kv.delete(`dom:${d}:${team.id}`)
      next.domains = listOf(body.domains, DOMAIN)
      for (const d of next.domains) await this.kv.put(`dom:${d}:${team.id}`, 1)
    }
    if (body.githubOrgs !== undefined) {
      for (const o of team.githubOrgs ?? []) await this.kv.delete(`org:${o}:${team.id}`)
      next.githubOrgs = listOf(body.githubOrgs, ORG)
      for (const o of next.githubOrgs) await this.kv.put(`org:${o}:${team.id}`, 1)
    }
    await this.kv.put(`team:${team.id}`, next)
    // People already signed in whom the new rules take in.
    if (body.domains !== undefined || body.githubOrgs !== undefined) {
      const now = Date.now()
      for (const [, a] of await this.kv.list('acct:')) await this.autoJoin(a, now)
    }
    return next
  }

  async acceptInvite(account, code, now) {
    const teamId = /^[A-Za-z0-9_-]{8,40}$/.test(code) ? await this.kv.get(`inv:${code}`) : null
    const team = teamId ? await this.kv.get(`team:${teamId}`) : null
    if (!team) return json({ error: "That invite link doesn't work any more. Ask for a new one." }, 404)
    const mem = await this.kv.get(`mem:${team.id}:${account.id}`)
    if (!mem) await this.addMember(team.id, account.id, 'member', now)
    return json({ team: this.teamView(team, mem?.role ?? 'member'), joined: !mem })
  }

  async deleteAccount(account) {
    for (const [key] of await this.kv.list(`myteam:${account.id}:`)) await this.removeMember(key.split(':')[2], account.id, { remember: false })
    for (const [key, rec] of await this.kv.list('tok:')) if (rec.account === account.id) await this.kv.delete(key)
    for (const ident of new Set([...(account.idents ?? []), `ident:${account.provider}:${account.subject}`])) await this.kv.delete(ident)
    if (account.email) await this.kv.delete(`email:${account.email}`)
    await this.kv.delete(`acct:${account.id}`)
    return json({ ok: true })
  }

  // -- sign-in --------------------------------------------------------------------

  // Claude Code opens this in the person's browser with `login`, the SHA-256
  // of a secret it keeps, and then asks for the sign-in with that secret: a
  // link seen in a browser's history, or a process list, can't collect it. An
  // invite code, when given, is taken once they're signed in.
  async start(provider, url, origin, now) {
    if (!this.providers[provider]) return page('Sign-in', "This sign-in isn't set up", 'This share server has no sign-in with that provider. Sharing by link works without one.')
    const login = url.searchParams.get('login') ?? ''
    if (!LOGIN_ID.test(login)) return page('Sign-in', "This sign-in link isn't complete", startAgain)
    const invite = url.searchParams.get('invite') ?? ''
    const known = await this.kv.get(`login:${login}`)
    if (known?.status === 'done') return page('Signed in', "You're already signed in", 'Go back to Claude Code. You can close this tab.')
    // Sign-ins nobody finished or collected go after their ten minutes.
    for (const prefix of ['login:', 'state:']) for (const [key, rec] of await this.kv.list(prefix)) if (rec.exp < now) await this.kv.delete(key)
    await this.kv.put(`login:${login}`, { status: 'pending', exp: now + LOGIN_MS })
    if (provider === 'test') {
      // The end-to-end test's own provider: who to be comes in the link.
      const email = clean(url.searchParams.get('email'), 120).toLowerCase()
      const identity = { provider: 'test', subject: email || login, name: url.searchParams.get('name') || email, email, emailVerified: Boolean(email), githubOrgs: url.searchParams.get('orgs') ?? '' }
      return this.finish(identity, login, invite, now)
    }
    const state = token(18)
    await this.kv.put(`state:${state}`, { provider, login, invite, exp: now + LOGIN_MS })
    const p = PROVIDERS[provider]
    const q = new URLSearchParams({ client_id: this.providers[provider].id, redirect_uri: `${origin}/auth/${provider}/callback`, scope: p.scope, state })
    if (provider === 'google') {
      q.set('response_type', 'code')
      q.set('prompt', 'select_account')
    }
    return new Response(null, { status: 302, headers: { location: `${p.authorize}?${q}`, 'cache-control': 'no-store' } })
  }

  async callback(provider, url, origin, now) {
    const state = await this.kv.get(`state:${url.searchParams.get('state') ?? ''}`)
    if (!state || state.provider !== provider || state.exp < now) return page('Sign-in', 'This sign-in expired', ['A sign-in waits ten minutes.', startAgain])
    await this.kv.delete(`state:${url.searchParams.get('state')}`)
    const code = url.searchParams.get('code')
    if (!code) return page('Sign-in', 'Sign-in cancelled', 'Nothing changed. Sign in from Claude Code whenever you like.')
    try {
      const identity = await this.identity(provider, code, `${origin}/auth/${provider}/callback`)
      return await this.finish(identity, state.login, state.invite, now)
    } catch (error) {
      return page('Sign-in', "Sign-in didn't work", [esc(String(error?.message ?? error).slice(0, 200)), startAgain])
    }
  }

  async finish(identity, login, invite, now) {
    const { account, token: secret } = await this.signIn(identity, now)
    let joined = null
    if (invite) {
      const res = await this.acceptInvite(account, invite, now)
      if (res.ok) joined = (await res.json()).team ?? null
    }
    await this.kv.put(`login:${login}`, { status: 'done', token: secret, joined: joined?.id ?? null, exp: now + LOGIN_MS })
    return page('Signed in', `You're signed in, ${account.name}`, [
      ...(joined ? [`You're in <b>${esc(joined.name)}</b> now: its live sessions show in your Team panel.`] : []),
      'Go back to Claude Code: it has picked up the sign-in. You can close this tab.',
    ])
  }

  // Delivered once, to whoever has the secret behind `login`: Claude Code
  // keeps the token, the server only its hash.
  async poll(body, now) {
    const verifier = String(body.verifier ?? '')
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(verifier)) return json({ error: 'bad verifier' }, 400)
    const login = await sha256(verifier)
    const rec = await this.kv.get(`login:${login}`)
    if (!rec || rec.exp < now) return json({ status: 'expired' })
    if (rec.status !== 'done') return json({ status: 'pending' })
    await this.kv.delete(`login:${login}`)
    const account = await this.accountOf(rec.token)
    return json({ status: 'done', token: rec.token, joined: rec.joined ?? null, account: account ? this.accountView(account) : null, teams: account ? await this.teamsOf(account) : [] })
  }

  async identity(provider, code, redirect) {
    const cfg = this.providers[provider]
    if (provider === 'github') {
      const tok = await this.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: cfg.id, client_secret: cfg.secret, code, redirect_uri: redirect }),
      }).then(r => r.json())
      if (!tok.access_token) throw new Error(`GitHub sign-in failed: ${tok.error_description ?? tok.error ?? 'no token'}`)
      const gh = path => this.fetch(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'claude-share' } }).then(r => (r.ok ? r.json() : null))
      const [user, emails, orgs] = await Promise.all([gh('/user'), gh('/user/emails'), gh('/user/orgs?per_page=100')])
      if (!user?.id) throw new Error('GitHub sign-in failed: no user')
      const primary = Array.isArray(emails) ? emails.find(e => e.primary && e.verified) ?? emails.find(e => e.verified) : null
      return { provider, subject: String(user.id), login: user.login, name: user.name || user.login, email: primary?.email ?? '', emailVerified: Boolean(primary), githubOrgs: Array.isArray(orgs) ? orgs.map(o => o.login) : [] }
    }
    if (provider === 'google') {
      const tok = await this.fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: cfg.id, client_secret: cfg.secret, redirect_uri: redirect, grant_type: 'authorization_code' }),
      }).then(r => r.json())
      if (!tok.access_token) throw new Error(`Google sign-in failed: ${tok.error_description ?? tok.error ?? 'no token'}`)
      const user = await this.fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } }).then(r => r.json())
      if (!user?.sub) throw new Error('Google sign-in failed: no user')
      return { provider, subject: user.sub, name: user.name || user.email, email: user.email ?? '', emailVerified: user.email_verified === true }
    }
    throw new Error('unknown provider')
  }

  // An invite link opened in a browser: what it is, and how to take it in
  // Claude Code (Desktop opens a new session with the link as its prompt).
  async invitePage(code, origin) {
    const teamId = /^[A-Za-z0-9_-]{8,40}$/.test(code) ? await this.kv.get(`inv:${code}`) : null
    const team = teamId ? await this.kv.get(`team:${teamId}`) : null
    if (!team) return page('Team invite', "This invite doesn't work any more", 'Someone in the team made a new link, or the team is gone. Ask them for the current one.', { status: 404 })
    const link = `${origin}/i/${code}`
    const name = esc(team.name)
    return page('Team invite', `Join ${team.name}`, [`${name} shares its Claude Code sessions here. Join, and they show in your Team panel as they go live, a press from joining.`], {
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
    })
  }
}

async function readBody(req) {
  const text = await req.text()
  if (text.length > 16_000) throw new Error('body too large')
  return text ? JSON.parse(text) : {}
}

// A store over a plain Map, for the Node server (persisted by its caller).
export function mapStore(map, onChange = () => {}) {
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
