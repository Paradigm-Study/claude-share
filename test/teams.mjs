// Accounts and teams on the room server, no model needed: sign-in (through
// the test provider), teams, who joins by domain and invite, members-only
// sessions, the access setting, the team's list, leaving and deleting.
//
//   node test/teams.mjs                                   # a local Node server it starts
//   TEAMS_SERVER=http://127.0.0.1:8787 node test/teams.mjs   # one already running with AUTH_TEST=1
//                                                          # (npx wrangler dev --var AUTH_TEST:1)

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.TEAMS_PORT ?? 8899)
const S = (process.env.TEAMS_SERVER ?? `http://127.0.0.1:${PORT}`).replace(/\/+$/, '')
const srv = process.env.TEAMS_SERVER ? { kill() {} } : spawn(process.execPath, [join(ROOT, 'server/node.mjs')], { env: { ...process.env, PORT: String(PORT), PREVIEW_PORT: String(PORT + 1), AUTH_TEST: '1', DATA_FILE: '' }, stdio: ['ignore', 'pipe', 'inherit'] })
if (!process.env.TEAMS_SERVER) await new Promise(r => srv.stdout.once('data', r))

const V = { 'x-shared-session-version': '0.11.0', 'content-type': 'application/json' }
// `tok`: a sign-in, as the team API takes it; `acct`: as a share or a join sends it.
const call = async (path, { method = 'GET', body, tok, acct } = {}) => {
  const headers = { ...V }
  if (tok) headers.authorization = `Bearer ${tok}`
  if (acct) headers['x-shared-session-account'] = acct
  const res = await fetch(`${S}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' })
  const text = await res.text()
  try {
    return { status: res.status, data: JSON.parse(text) }
  } catch {
    return { status: res.status, data: text }
  }
}
const ok = (cond, label) => {
  console.log(cond ? 'ok  ' : 'FAIL', label)
  if (!cond) process.exitCode = 1
}
const signIn = async (email, name, invite = '') => {
  const verifier = 'V' + Math.random().toString(36).slice(2).padEnd(40, 'x')
  const login = createHash('sha256').update(verifier).digest('hex')
  const page = await call(`/auth/test/start?login=${login}&email=${encodeURIComponent(email)}&name=${name}${invite ? `&invite=${invite}` : ''}`)
  ok((await call('/api/auth/poll', { method: 'POST', body: { verifier: 'W'.repeat(40) } })).data.status === 'expired', 'a wrong secret gets nothing')
  const polled = await call('/api/auth/poll', { method: 'POST', body: { verifier } })
  const again = await call('/api/auth/poll', { method: 'POST', body: { verifier } })
  ok(String(page.data).includes(`Signed in as ${name}`) && polled.data.status === 'done' && again.data.status === 'expired', `${name} signs in, and the sign-in is handed over once`)
  return polled.data.token
}
try {
  ok((await call('/api/auth/providers')).data.providers.some(p => p.id === 'test'), 'test provider listed')
  const alice = await signIn('alice@acme.com', 'Alice')
  const team = (await call('/api/teams', { method: 'POST', tok: alice, body: { name: 'Acme' } })).data.team
  ok(team?.role === 'owner' && team.access === 'members', 'Alice makes Acme, members only')
  ok((await call(`/api/teams/${team.id}`, { method: 'PATCH', tok: alice, body: { domains: 'gmail.com' } })).status === 400, "an owner can't claim a domain that isn't their own")
  ok((await call(`/api/teams/${team.id}`, { method: 'PATCH', tok: alice, body: { githubOrgs: 'someone-else' } })).status === 400, "or a GitHub org they aren't in")
  await call(`/api/teams/${team.id}`, { method: 'PATCH', tok: alice, body: { domains: 'acme.com' } })
  const bob = await signIn('bob@acme.com', 'Bob')
  ok((await call('/api/me', { tok: bob })).data.teams.some(t => t.id === team.id), 'Bob joins by domain')
  const carol = await signIn('carol@other.com', 'Carol')
  ok((await call('/api/me', { tok: carol })).data.teams.length === 0, 'Carol is in no team')
  // share to team
  const denied = await call('/api/rooms', { method: 'POST', acct: carol, body: { name: 'Carol', title: 't', team: team.id } })
  ok(denied.status === 403, `Carol can't share to Acme (${denied.status})`)
  const room = (await call('/api/rooms', { method: 'POST', acct: alice, body: { name: 'Alice', title: 'acme: work', team: team.id } })).data
  ok(room.team?.name === 'Acme', 'Alice shares with Acme')
  const list = (await call(`/api/teams/${team.id}/sessions`, { tok: bob })).data.sessions
  ok(list.length === 1 && list[0].url === room.url && list[0].host === 'Alice', 'Bob sees it listed')
  ok((await call(`/api/teams/${team.id}/sessions`, { tok: carol })).status === 404, "Carol can't list Acme")
  const anon = await call(`/api/rooms/${room.id}/join`, { method: 'POST', body: { name: 'anon' } })
  ok(anon.status === 403 && anon.data.signIn === true, 'no account: refused, asked to sign in')
  const cj = await call(`/api/rooms/${room.id}/join`, { method: 'POST', acct: carol, body: { name: 'Carol' } })
  ok(cj.status === 403 && !cj.data.signIn, `Carol refused: ${cj.data.error}`)
  const bj = await call(`/api/rooms/${room.id}/join`, { method: 'POST', acct: bob, body: { name: 'Bob' } })
  ok(bj.status === 200 && bj.data.team?.name === 'Acme', 'Bob joins')
  // access link
  ok((await call(`/api/teams/${team.id}`, { method: 'PATCH', tok: bob, body: { access: 'link' } })).status === 403, "Bob (member) can't change access")
  await call(`/api/teams/${team.id}`, { method: 'PATCH', tok: alice, body: { access: 'link' } })
  ok((await call(`/api/rooms/${room.id}/join`, { method: 'POST', body: { name: 'anon' } })).status === 200, 'anyone with the link joins once access is link')
  // invite
  const carol2 = await signIn('carol@other.com', 'Carol', team.invite)
  ok((await call('/api/me', { tok: carol2 })).data.teams.some(t => t.id === team.id), 'Carol joins by invite at sign-in')
  const newInv = (await call(`/api/teams/${team.id}/invite`, { method: 'POST', tok: alice })).data.team.invite
  ok(newInv && newInv !== team.invite && (await call(`/api/invites/${team.invite}`, { method: 'POST', tok: carol })).status === 404, 'new invite link; old stops working')
  ok(String((await call(`/i/${newInv}`)).data).includes('<!doctype'), 'invite page renders')
  // host moves room to link-only
  const moved = await call(`/api/rooms/${room.id}/team`, { method: 'POST', tok: room.token, body: { team: null } })
  ok(moved.status === 200 && (await call(`/api/teams/${team.id}/sessions`, { tok: bob })).data.sessions.length === 0, 'room taken off the team list')
  await call(`/api/rooms/${room.id}/team`, { method: 'POST', tok: room.token, acct: alice, body: { team: team.id } })
  ok((await call(`/api/teams/${team.id}/sessions`, { tok: bob })).data.sessions.length === 1, 'and back on')
  await call(`/api/rooms/${room.id}/end`, { method: 'POST', tok: room.token })
  ok((await call(`/api/teams/${team.id}/sessions`, { tok: bob })).data.sessions.length === 0, 'ended room leaves the list')
  // owner leaves -> next member owner
  await call(`/api/teams/${team.id}/members/me`, { method: 'DELETE', tok: alice })
  const members = (await call(`/api/teams/${team.id}`, { tok: bob })).data.members
  ok(members.some(m => m.role === 'owner') && !members.some(m => m.name === 'Alice'), 'Alice leaves; someone else owns it')
  const aliceAgain = await signIn('alice@acme.com', 'Alice')
  ok(!(await call('/api/me', { tok: aliceAgain })).data.teams.some(t => t.id === team.id), 'someone who left is not pulled back in by the domain')
  const dave = await signIn('dave@solo.dev', 'Dave')
  const solo = (await call('/api/teams', { method: 'POST', tok: dave, body: { name: 'Solo' } })).data.team
  const soloRoom = (await call('/api/rooms', { method: 'POST', acct: dave, body: { name: 'Dave', title: 's', team: solo.id } })).data
  await call(`/api/teams/${solo.id}/members/me`, { method: 'DELETE', tok: dave })
  ok((await call(`/api/rooms/${soloRoom.id}/join`, { method: 'POST', body: { name: 'x' } })).status === 403, "a deleted team's session lets nobody in by its link")
  ok((await call(`/api/invites/${solo.invite}`, { method: 'POST', tok: dave })).status === 404, "and its invite is gone")
  ok((await call('/api/me', { method: 'DELETE', tok: carol2 })).status === 200 && (await call('/api/me', { tok: carol2 })).status === 401, 'Carol deletes her account')
  ok((await call('/api/auth/logout', { method: 'POST', tok: bob })).status === 200 && (await call('/api/me', { tok: bob })).status === 401, 'Bob signs out')
  ok((await call('/auth/github/start?login=' + 'x'.repeat(24))).status === 200, 'unconfigured provider says so')
} finally {
  srv.kill()
}
