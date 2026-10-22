// Accounts and teams on the room server, no model needed: sign-in (through
// the test provider, and its confirmation page's Continue, in a real headless
// Chrome, Edge, Brave or Chromium when there is one), teams, who joins
// by domain and invite, members-only sessions, the access setting, the team's
// list, leaving and deleting. Then the directory itself, over a store this
// test can see into: no token kept before it's collected, expired sign-ins
// gone, how much one account may change a minute, and whom a team's new
// rules look at.
//
//   node test/teams.mjs                                   # a local Node server it starts
//   TEAMS_SERVER=http://127.0.0.1:8787 node test/teams.mjs   # one already running with AUTH_TEST=1
//                                                          # (npx wrangler dev --var AUTH_TEST:1)
//   SHARED_SESSION_TEST_CHROME=/path/to/chrome node test/teams.mjs   # that browser for Continue (else SKIP without one)

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_LATEST } from '../server/core.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.TEAMS_PORT ?? 8899)
const S = (process.env.TEAMS_SERVER ?? `http://127.0.0.1:${PORT}`).replace(/\/+$/, '')
const srv = process.env.TEAMS_SERVER ? { kill() {} } : spawn(process.execPath, [join(ROOT, 'server/node.mjs')], { env: { ...process.env, PORT: String(PORT), PREVIEW_PORT: String(PORT + 1), AUTH_TEST: '1', DATA_FILE: '' }, stdio: ['ignore', 'pipe', 'inherit'] })
if (!process.env.TEAMS_SERVER) await new Promise(r => srv.stdout.once('data', r))

const V = { 'x-shared-session-version': PLUGIN_LATEST, 'content-type': 'application/json' }
// `tok`: a sign-in, as the team API takes it; `acct`: as a share or a join
// sends it; `form`: fields a browser's form posts.
const call = async (path, { method = 'GET', body, tok, acct, form } = {}) => {
  const headers = { ...V }
  if (tok) headers.authorization = `Bearer ${tok}`
  if (acct) headers['x-shared-session-account'] = acct
  if (form) headers['content-type'] = 'application/x-www-form-urlencoded'
  const res = await fetch(`${S}${path}`, { method, headers, body: form ? new URLSearchParams(form) : body ? JSON.stringify(body) : undefined, redirect: 'manual' })
  const text = await res.text()
  try {
    return { status: res.status, data: JSON.parse(text), headers: res.headers }
  } catch {
    return { status: res.status, data: text, headers: res.headers }
  }
}
const ok = (cond, label) => {
  console.log(cond ? 'ok  ' : 'FAIL', label)
  if (!cond) process.exitCode = 1
}
const sha = text => createHash('sha256').update(text).digest('hex')
// Whether a page says this (its heading's apostrophes come escaped).
const says = (html, text) => String(html).replaceAll('&#39;', "'").includes(text)
const secret = () => 'V' + Math.random().toString(36).slice(2).padEnd(40, 'x')
// What Claude Code shows beside its link: the start of its login, in capitals.
const codeOf = login => `${login.slice(0, 4)}-${login.slice(4, 8)}`.toUpperCase()
// The confirmation page's form, as a browser would post it, and the code it shows.
const formOf = html => {
  const field = name => new RegExp(`name="${name}" value="([^"]*)"`).exec(String(html))?.[1]
  return { action: /<form [^>]*action="([^"]+)"/.exec(String(html))?.[1], login: field('login'), nonce: field('nonce'), code: /the code <b>([^<]+)<\/b>/.exec(String(html))?.[1] }
}
const signIn = async (email, name, invite = '', teamName = '') => {
  const verifier = secret()
  const login = sha(verifier)
  const page = await call(`/auth/test/start?login=${login}&email=${encodeURIComponent(email)}&name=${name}${invite ? `&invite=${invite}` : ''}`)
  ok((await call('/api/auth/poll', { method: 'POST', body: { verifier: 'W'.repeat(40) } })).data.status === 'expired', 'a wrong secret gets nothing')
  // The provider's answer only asks: who, and the code Claude Code shows.
  const form = formOf(page.data)
  if (teamName) ok(String(page.data).includes(`joins you to the team <b>${teamName}</b>`), `${name}'s page says continuing joins ${teamName}, whose invite it carries`)
  const early = await call('/api/auth/poll', { method: 'POST', body: { verifier } })
  ok(page.status === 200 && String(page.data).includes(`signing in as ${name} (${email})`) && form.code === codeOf(login) && says(page.data, `It shows the code <b>${codeOf(login)}</b>. Continue only if you started signing in from Claude Code just now and the codes match.`) && form.login === login && form.action === '/auth/confirm' && early.data.status === 'confirm' && !early.data.token, `${name}'s browser is asked first, with Claude Code's code, and nothing is handed over yet`)
  const done = await call(form.action ?? '/auth/confirm', { method: 'POST', form: { login: form.login ?? login, nonce: form.nonce ?? '' } })
  const polled = await call('/api/auth/poll', { method: 'POST', body: { verifier } })
  const again = await call('/api/auth/poll', { method: 'POST', body: { verifier } })
  ok(done.status === 200 && String(done.data).includes(`signed in, ${name}`) && polled.data.status === 'done' && again.data.status === 'expired', `${name} continues, signs in, and the sign-in is handed over once`)
  return polled.data.token
}
// A real browser for the confirmation page's Continue, found as
// test/local-preview.mjs finds one: SHARED_SESSION_TEST_CHROME, else Chrome,
// Edge, Brave or Chromium (macOS apps, Linux names on PATH), never a snap.
const MAC_BROWSERS = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium']
const LINUX_BROWSERS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']
const executable = file => access(file, constants.X_OK).then(() => true, () => false)
async function findChrome() {
  const named = process.env.SHARED_SESSION_TEST_CHROME?.replace(/\/+$/, '')
  if (named) {
    const file = named.endsWith('.app') ? `${named}/Contents/MacOS/${basename(named, '.app')}` : named
    if (!(await executable(file))) return { wrong: `SHARED_SESSION_TEST_CHROME is not an executable browser: ${named}` }
    return process.getuid?.() === 0 ? { reason: 'running as root: Chrome needs --no-sandbox there' } : { path: file }
  }
  if (process.getuid?.() === 0) return { reason: 'running as root: Chrome needs --no-sandbox there' }
  const candidates = process.platform === 'darwin'
    ? MAC_BROWSERS.flatMap(name => ['/Applications', `${homedir()}/Applications`].map(dir => `${dir}/${name}.app/Contents/MacOS/${name}`))
    : LINUX_BROWSERS.flatMap(name => (process.env.PATH ?? '').split(':').filter(Boolean).map(dir => `${dir}/${name}`))
  let snap
  for (const file of candidates) {
    if (!(await executable(file))) continue
    if ((await realpath(file)).startsWith('/snap/')) { snap ??= file; continue }
    return { path: file }
  }
  return { reason: snap ? `a snap browser (${snap}) can't use a throwaway profile` : `no Chrome, Edge, Brave or Chromium${process.platform === 'darwin' ? ' app' : ' on PATH'}; set SHARED_SESSION_TEST_CHROME` }
}
const wait = ms => new Promise(r => setTimeout(r, ms))
// Continue in that browser, headless on a throwaway profile, over the
// DevTools pipe, reaching no host but this server's: a click with no pointer
// move, or within 400 ms of the page showing (keys too), does nothing, so a
// page that raises this one under a person's double-click doesn't get its
// second click; a move and then a click, or keys, after the 400 ms go on.
async function continueInChrome() {
  const chrome = await findChrome()
  if (chrome.wrong) return ok(false, chrome.wrong)
  if (!chrome.path) return console.log(`SKIP Continue in a real browser (${chrome.reason})`)
  const profile = await mkdtemp(join(tmpdir(), 'teams-chrome-'))
  const browser = spawn(chrome.path, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${new URL(S).hostname}`,
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : process.platform === 'linux' ? ['--password-store=basic'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
  let said = '', buffer = '', next = 0
  const waiting = new Map()
  browser.stderr.on('data', chunk => { said = (said + chunk).slice(-2000) })
  browser.on('error', () => {})
  browser.on('exit', () => { for (const done of waiting.values()) done({ error: { message: 'the browser exited' } }) })
  for (const fd of [3, 4]) browser.stdio[fd].on('error', () => {})
  browser.stdio[4].setEncoding('utf8')
  browser.stdio[4].on('data', chunk => {
    buffer += chunk
    for (let end; (end = buffer.indexOf('\0')) >= 0; buffer = buffer.slice(end + 1)) {
      const message = JSON.parse(buffer.slice(0, end))
      waiting.get(message.id)?.(message)
      waiting.delete(message.id)
    }
  })
  const send = (method, params = {}, sessionId) => new Promise(resolve => {
    const id = ++next
    waiting.set(id, resolve)
    setTimeout(() => waiting.has(id) && (waiting.delete(id), resolve({ error: { message: `no answer to ${method}` } })), 15_000).unref()
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
  })
  // A sign-in's confirmation page in a tab of its own, its script run; shown
  // and focused even behind another tab (emulate), or as a person's browser
  // shows the tab in front alone.
  const open = async (name, emulate = true) => {
    const verifier = secret()
    const login = sha(verifier)
    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
    const s = (method, params) => send(method, params, sessionId)
    if (emulate) await s('Emulation.setFocusEmulationEnabled', { enabled: true })
    await s('Page.navigate', { url: `${S}/auth/test/start?login=${login}&email=${name.toLowerCase()}@acme.com&name=${name}` })
    const value = async expression => (await s('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value
    for (let i = 0; i < 250 && (await value("document.readyState !== 'loading' && Boolean(document.getElementById('continue'))")) !== true; i++) await wait(20)
    const at = await value("(r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))(document.getElementById('continue').getBoundingClientRect())")
    const mouse = (type, x = at.x) => s('Input.dispatchMouseEvent', { type, x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 })
    const key = async (key, code, keyCode, text) => {
      await s('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) })
      await s('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
    }
    return {
      click: async () => { await mouse('mousePressed'); await mouse('mouseReleased') },
      move: async () => { await mouse('mouseMoved', at.x + 6); await mouse('mouseMoved') },
      // What a browser may make up as a window appears under a still pointer: a move that goes nowhere.
      still: () => mouse('mouseMoved'),
      tab: () => key('Tab', 'Tab', 9),
      enter: () => key('Enter', 'Enter', 13, '\r'),
      focused: () => value("document.activeElement?.id === 'continue'"),
      shown: () => value("document.visibilityState === 'visible' && document.hasFocus()"),
      // Where the sign-in is: 'confirm' until a Continue goes through, then 'done'.
      status: async (until = '') => {
        let status
        for (let i = 0; i < 30; i++) {
          status = (await call('/api/auth/poll', { method: 'POST', body: { verifier } })).data.status
          if (status !== 'confirm' || status === until || !until) return status
          await wait(100)
        }
        return status
      },
      close: () => send('Target.closeTarget', { targetId }),
    }
  }
  try {
    const started = await send('Browser.getVersion')
    if (!started.result) return console.log(`SKIP Continue in a real browser (${chrome.path} didn't start: ${started.error?.message} ${said.trim().split('\n').slice(-2).join(' | ')})`)
    const browserName = started.result.product
    // A click with no move does nothing; a move, and then one, goes on.
    const a = await open('Ann')
    await wait(500)
    await a.click()
    await wait(300)
    const still = await a.status()
    await a.move()
    await wait(400)
    await a.click()
    const went = await a.status('done')
    ok(still === 'confirm' && went === 'done', `in ${browserName}: a click with no pointer move does nothing, and after a move it continues (${still}, then ${went})`)
    await a.close()
    const e = await open('Eve')
    await wait(500)
    await e.still()
    await wait(100)
    await e.click()
    await wait(300)
    const raised = await e.status()
    await e.move()
    await e.click()
    const moved = await e.status('done')
    ok(raised === 'confirm' && moved === 'done', `in ${browserName}: a move that goes nowhere, as under a still pointer, doesn't count; one that goes somewhere does (${raised}, then ${moved})`)
    await e.close()
    // Out of sight (another tab in front) nothing counts, and back in sight
    // the 400 ms start over: where this browser shows its tab in front alone.
    const f = await open('Fay', false)
    const alone = await f.shown()
    const { result: { targetId: front } } = await send('Target.createTarget', { url: 'about:blank' })
    await wait(500)
    const behind = await f.shown()
    if (!alone || behind !== false) console.log(`SKIP out of sight in ${browserName} (its headless tab ${alone ? 'still shows behind another' : "isn't shown in front"})`)
    else {
      await f.move()
      await f.click()
      await wait(300)
      const hidden = await f.status()
      await send('Target.closeTarget', { targetId: front })
      await wait(50)
      await f.move()
      await f.click()
      await wait(100)
      const back = await f.status()
      await wait(450)
      await f.click()
      const shown = await f.status('done')
      ok(hidden === 'confirm' && back === 'confirm' && shown === 'done', `in ${browserName}: behind another tab nothing counts, and back in front the 400 ms start over (${hidden}, ${back}, then ${shown})`)
    }
    await send('Target.closeTarget', { targetId: front })
    await f.close()
    // A move and a click at once (a double-click's second click) do nothing; the same click once the page has been up 400 ms goes on.
    const b = await open('Ben')
    await b.move()
    await b.click()
    await wait(100)
    const early = await b.status()
    await wait(450)
    await b.click()
    const later = await b.status('done')
    ok(early === 'confirm' && later === 'done', `in ${browserName}: a click within 400 ms of the page showing does nothing, and the same click after them continues (${early}, then ${later})`)
    await b.close()
    // Keys at once do nothing; after the 400 ms, Tab to Continue and Enter go on.
    const c = await open('Cal')
    await c.tab()
    await c.tab()
    await c.enter()
    await wait(300)
    const keyed = await c.status()
    await c.close()
    const d = await open('Dee')
    await wait(500)
    for (let i = 0; i < 4 && !(await d.focused()); i++) await d.tab()
    await d.enter()
    const typed = await d.status('done')
    ok(keyed === 'confirm' && typed === 'done', `in ${browserName}: keys within 400 ms do nothing, and after them Tab to Continue and Enter continue (${keyed}, then ${typed})`)
    await d.close()
  } finally {
    // Closed through its own pipe, its helpers with it; killed (by its pid) only if that doesn't end it.
    if (browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise(r => browser.once('exit', () => r(true)))
      browser.stdio[3].write(JSON.stringify({ id: ++next, method: 'Browser.close' }) + '\0')
      if (!(await Promise.race([exited, wait(5000)]))) {
        browser.kill('SIGKILL')
        await exited
      }
    }
    await rm(profile, { recursive: true, force: true })
  }
}

try {
  ok((await call('/api/auth/providers')).data.providers.some(p => p.id === 'test'), 'test provider listed')
  // A start link someone else made: its maker chose the login (the hash of
  // their own secret), so finishing the provider's sign-in in the victim's
  // browser must not hand them anything without that page's own Continue.
  {
    const verifier = secret()
    const login = sha(verifier)
    const page = await call(`/auth/test/start?login=${login}&email=victim@acme.com&name=Victim`)
    const h = page.headers
    // Its one script, allowed by its hash: no other script, inline or not, runs there.
    const script = /<script>([\s\S]*?)<\/script>/.exec(String(page.data))?.[1] ?? ''
    const csp = `frame-ancestors 'none'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`
    ok(h.get('x-frame-options') === 'DENY' && h.get('content-security-policy') === csp && h.get('cache-control') === 'no-store' && h.get('referrer-policy') === 'no-referrer', 'the confirmation page is never framed, cached or named in a referrer, and runs only its own script')
    ok(script.includes("getElementById('continue')") && !/unsafe-inline|unsafe-eval/.test(h.get('content-security-policy')) && String(page.data).match(/<script/g).length === 1, 'that script is the Continue guard, allowed by hash alone')
    // Its Continue starts disabled and the guard enables it; without script, the noscript one is there.
    ok(String(page.data).includes('<button type="submit" class="btn-primary" id="continue" disabled>Continue</button><noscript><style>#continue{display:none}</style><button type="submit" class="btn-primary">Continue</button></noscript></form>'), "Continue starts disabled, and a browser without script gets one that isn't")
    // Every start link's page shows the code Claude Code shows, whatever else the link says.
    ok(says(page.data, `Claude Code is signing in as Victim (victim@acme.com). It shows the code <b>${codeOf(login)}</b>. Continue only if you started signing in from Claude Code just now and the codes match.`), 'the page shows the code to match')
    const forged = await call('/auth/confirm', { method: 'POST', form: { login, nonce: 'x'.repeat(24) } })
    const bare = await call('/auth/confirm', { method: 'POST', form: { login } })
    const got = await call('/api/auth/poll', { method: 'POST', body: { verifier } })
    ok(forged.status === 403 && bare.status === 403 && got.data.status === 'confirm' && !got.data.token && !got.data.account, "a Continue without the page's own nonce is refused, and the link's maker collects nothing")
    const stray = await call('/auth/confirm')
    ok(stray.status === 200 && says(stray.data, "This sign-in link isn't complete") && (await call('/api/auth/poll', { method: 'POST', body: { verifier } })).data.status === 'confirm', 'opening the Continue address itself signs nobody in')
    // A newer start of the same sign-in replaces the page: the older one's Continue can't finish it.
    const newer = formOf((await call(`/auth/test/start?login=${login}&email=victim@acme.com&name=Victim`)).data)
    const old = await call('/auth/confirm', { method: 'POST', form: { login, nonce: formOf(page.data).nonce } })
    const current = await call('/auth/confirm', { method: 'POST', form: { login, nonce: newer.nonce } })
    ok(old.status === 403 && current.status === 200 && (await call('/api/auth/poll', { method: 'POST', body: { verifier } })).data.status === 'done', "only the newest page's Continue finishes a sign-in")
    ok(says((await call(`/auth/test/start?login=${'A'.repeat(64)}&email=x@acme.com`)).data, "This sign-in link isn't complete"), "a login that isn't a SHA-256 in hex is refused at the start")
  }
  await continueInChrome()
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
  // Invites to a session, straight to a teammate's Claude Code.
  const bobId = (await call('/api/me', { tok: bob })).data.account.id
  const carolId = (await call('/api/me', { tok: carol })).data.account.id
  ok((await call('/api/me', { tok: alice })).data.teammates.some(m => m.id === bobId), "a host's teammates are listed for inviting")
  const inv = await call(`/api/rooms/${room.id}/invite`, { method: 'POST', tok: room.token, acct: alice, body: { to: [bobId, carolId] } })
  ok(inv.status === 200 && inv.data.invited.join() === 'Bob' && inv.data.refused.join() === carolId, 'a host invites a teammate, not someone outside their teams')
  const pending = (await call('/api/me/invites', { tok: bob })).data.invites
  ok(pending.length === 1 && pending[0].room.url === room.url && pending[0].from.name === 'Alice', 'the teammate sees the invite, from whom and to what')
  ok((await call('/api/me/invites', { tok: carol })).data.invites.length === 0, 'nobody else does')
  // Set aside, then invited again: it's back, and as a new one (its time moved on).
  await call(`/api/me/invites/${room.id}`, { method: 'DELETE', tok: bob })
  await new Promise(r => setTimeout(r, 5))
  await call(`/api/rooms/${room.id}/invite`, { method: 'POST', tok: room.token, acct: alice, body: { to: [bobId] } })
  const again = (await call('/api/me/invites', { tok: bob })).data.invites
  ok(again.length === 1 && again[0].at > pending[0].at, 'someone who set an invite aside can be invited again, and it counts as new')
  const bj = await call(`/api/rooms/${room.id}/join`, { method: 'POST', acct: bob, body: { name: 'Bob' } })
  ok(bj.status === 200 && bj.data.team?.name === 'Acme', 'Bob joins')
  ok((await call(`/api/rooms/${room.id}/invite`, { method: 'POST', tok: bj.data.token, acct: bob, body: { to: [carolId] } })).status === 403, "a guest can't invite")
  ok((await call('/api/me/invites', { tok: bob })).data.invites.length === 0, "an invite to a session you're already in isn't shown")
  // Bob from a second session: one Bob, here if either is, and no second "joined".
  const bj2 = await call(`/api/rooms/${room.id}/join`, { method: 'POST', acct: bob, body: { name: 'Bob' } })
  const people = (await call(`/api/rooms/${room.id}`)).data.people
  ok(bj2.status === 200 && people.filter(p => p.name === 'Bob').length === 1 && people.find(p => p.name === 'Bob').seats.length === 2, 'one person in two sessions is one entry, with both seats')
  const joins = (await call(`/api/rooms/${room.id}/events?after=0&wait=0`, { tok: room.token })).data.events.filter(e => e.type === 'join' && e.from.name === 'Bob')
  ok(joins.length === 1, 'and joined once')
  const listed = (await call(`/api/teams/${team.id}/sessions`, { tok: bob })).data.sessions[0]
  ok(listed.accounts.includes(bobId), "the team's list says who's in it by account")
  await call(`/api/me/invites/${room.id}`, { method: 'DELETE', tok: bob })
  ok((await call('/api/me/invites', { tok: bob })).data.invites.length === 0, 'a dismissed invite is gone')
  await call(`/api/rooms/${room.id}/invite`, { method: 'POST', tok: room.token, acct: alice, body: { to: [bobId] } })
  // access link
  ok((await call(`/api/teams/${team.id}`, { method: 'PATCH', tok: bob, body: { access: 'link' } })).status === 403, "Bob (member) can't change access")
  await call(`/api/teams/${team.id}`, { method: 'PATCH', tok: alice, body: { access: 'link' } })
  ok((await call(`/api/rooms/${room.id}/join`, { method: 'POST', body: { name: 'anon' } })).status === 200, 'anyone with the link joins once access is link')
  // invite
  const carol2 = await signIn('carol@other.com', 'Carol', team.invite, 'Acme')
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
  ok((await call('/api/me/invites', { tok: bob })).data.invites.length === 0, "an ended session's invite goes")
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

  // Someone who leaves a members-only team, or is removed, leaves its
  // sessions at once: their seats, and their open stream; a member stays.
  // And a team turning members-only lets go of whoever joined by its link.
  {
    const erin = await signIn('erin@erin.test', 'Erin')
    const crew = (await call('/api/teams', { method: 'POST', tok: erin, body: { name: 'Crew' } })).data.team
    const fred = await signIn('fred@else.test', 'Fred', crew.invite, 'Crew')
    const gus = await signIn('gus@else.test', 'Gus', crew.invite, 'Crew')
    const fredId = (await call('/api/me', { tok: fred })).data.account.id
    const shared = (await call('/api/rooms', { method: 'POST', acct: erin, body: { name: 'Erin', title: 'crew work', team: crew.id } })).data
    const seatOf = async (acct, name) => (await call(`/api/rooms/${shared.id}/join`, { method: 'POST', acct, body: { name } })).data
    const [fred1, fred2, gus1] = [await seatOf(fred, 'Fred'), await seatOf(fred, 'Fred'), await seatOf(gus, 'Gus')]
    const stream = await fetch(`${S}/api/rooms/${shared.id}/stream?after=0`, { headers: { ...V, authorization: `Bearer ${fred1.token}` } })
    const reader = stream.body.getReader()
    await reader.read()
    const drained = (async () => { for (;;) if ((await reader.read()).done) return true })()
    const out = async seat => (await call(`/api/rooms/${shared.id}/events?after=0&wait=0`, { tok: seat.token })).status
    ok((await call(`/api/teams/${crew.id}/members/${fredId}`, { method: 'DELETE', tok: erin })).status === 200, 'Erin removes Fred from Crew')
    ok(await Promise.race([drained, wait(3000).then(() => false)]), "Fred's open stream ends at once")
    ok((await out(fred1)) === 401 && (await out(fred2)) === 401 && (await out(gus1)) === 200 && (await out(shared)) === 200, 'both of his seats are let go; Gus and the host stay')
    const seen = (await call(`/api/rooms/${shared.id}/events?after=0&wait=0`, { tok: shared.token })).data
    ok(!seen.people.some(p => p.name === 'Fred') && seen.events.filter(e => e.type === 'leave' && e.from.name === 'Fred').map(e => e.body.reason).join() === 'removed', 'he leaves the room once, as removed')
    ok((await call(`/api/rooms/${shared.id}/join`, { method: 'POST', acct: fred, body: { name: 'Fred' } })).status === 403, "and can't join again")
    await call(`/api/teams/${crew.id}`, { method: 'PATCH', tok: erin, body: { access: 'link' } })
    const passer = (await call(`/api/rooms/${shared.id}/join`, { method: 'POST', body: { name: 'Passer' } })).data
    ok((await out(passer)) === 200, 'by link, anyone joins')
    await call(`/api/teams/${crew.id}`, { method: 'PATCH', tok: erin, body: { access: 'members' } })
    ok((await out(passer)) === 401 && (await out(gus1)) === 200, 'turned members-only, it lets go of whoever joined by link, and keeps its members')
    await call(`/api/rooms/${shared.id}/end`, { method: 'POST', tok: shared.token })
  }

  // Reactions to Claude's replies and who saw them: kept when they're well
  // formed, from the host and guests alike; anything else is dropped.
  const marks = (await call('/api/rooms', { method: 'POST', body: { name: 'Host', title: 'marks' } })).data
  const guest = (await call(`/api/rooms/${marks.id}/join`, { method: 'POST', body: { name: 'Gia' } })).data
  const post = (tok, events) => call(`/api/rooms/${marks.id}/events`, { method: 'POST', tok, body: { events } })
  await post(guest.token, [
    { type: 'react', body: { key: 'abc123.40', emoji: '🎉', on: true, extra: 'x'.repeat(5000) } },
    { type: 'react', body: { key: 'abc123.40', emoji: '💩' } },
    { type: 'react', body: { key: '<script>', emoji: '👍' } },
    { type: 'seen', body: { keys: ['abc123.40', 'not a key', 'zz9.7'] } },
    { type: 'seen', body: { keys: ['nope'] } },
    { type: 'row', body: { kind: 'assistant', text: 'a guest pretending to be Claude' } },
  ])
  await post(marks.token, [{ type: 'react', body: { key: 'abc123.40', emoji: '👍', on: false } }])
  const kept = (await call(`/api/rooms/${marks.id}/events?after=0&wait=0`, { tok: marks.token })).data.events
  const reacts = kept.filter(e => e.type === 'react')
  const seens = kept.filter(e => e.type === 'seen')
  ok(reacts.length === 2 && JSON.stringify(reacts[0].body) === JSON.stringify({ key: 'abc123.40', emoji: '🎉', on: true }) && reacts[1].from.role === 'host' && reacts[1].body.on === false, 'a reaction is kept as a key, an emoji and on, from a guest or the host')
  ok(seens.length === 1 && JSON.stringify(seens[0].body.keys) === JSON.stringify(['abc123.40', 'zz9.7']), 'seen keeps only the keys that are reply keys')
  ok(!kept.some(e => e.type === 'row'), "a guest can't post a row of the transcript")
  await call(`/api/rooms/${marks.id}/end`, { method: 'POST', tok: marks.token })

  // A guest away past the grace (asleep, offline): its token seats it again.
  const { Room } = await import('../server/core.mjs')
  const r0 = Room.create({ id: 'r0', name: 'Host', title: 't', now: 0 })
  const kyle = r0.join('Kyle', 0, '0.11.8')
  const lee = r0.join('Lee', 0)
  r0.leave(lee.token, 'left', 1_000)
  r0.sweep(60_000)
  ok(!r0.seats.has(kyle.token), 'a quiet seat is let go after its grace')
  const r1 = new Room(JSON.parse(JSON.stringify(r0))) // as a room loaded back from storage
  const back = r1.auth(kyle.token, 61_000)
  ok(back?.seat === kyle.seat.id && r1.people(61_000).some(p => p.name === 'Kyle' && p.online), 'and comes back with its token, the same seat, after a restart too')
  ok(r1.events.filter(e => e.type === 'join' && e.from.name === 'Kyle').length === 2, "its coming back says it joined")
  ok(r1.auth(lee.token, 61_000) === null, 'a seat that left stays out')
  r1.sweep(200_000)
  r1.end(200_001)
  ok(r1.auth(kyle.token, 200_002) === null, 'nobody comes back to an ended room')
  // A team's word reaches the seats it covers: here or away, and only for its own room.
  const r2 = Room.create({ id: 'r2', name: 'Host', title: 't', now: 0, team: { id: 'teamA', name: 'A', account: 'h' } })
  const [kept2, gone2, idle2] = [r2.join('Kim', 0, null, 'k'), r2.join('Ned', 0, null, 'n'), r2.join('Oz', 0, null, 'o')]
  r2.seats.get(kept2.token).lastSeen = r2.seats.get(gone2.token).lastSeen = 50_000
  r2.sweep(60_000)
  ok(r2.away.has(idle2.token) && !r2.keepTeam('teamB', [], 60_000), "an away seat is the room's still, and another team's word changes nothing")
  ok(r2.keepTeam('teamA', ['k'], 61_000) && Boolean(r2.auth(kept2.token, 61_000)) && r2.auth(gone2.token, 61_000) === null && r2.auth(idle2.token, 61_000) === null && !r2.away.has(idle2.token), 'its own team keeps its members, and lets the others go, here or away, for good')
} catch (error) {
  // Reported, so the checks below still run.
  console.error(error)
  ok(false, 'the checks against the server stopped at the error above')
} finally {
  srv.kill()
}

// The directory itself, over a store this test can see into, on a clock it sets.
{
  const { Directory, mapStore } = await import('../server/teams.mjs')
  const data = new Map()
  const lists = []
  const store = mapStore(data)
  const dir = new Directory({ ...store, list: async prefix => (lists.push(prefix), store.list(prefix)) }, { providers: { test: {} } })
  let clock = 1_000_000
  const here = async (path, { method = 'GET', body, tok, form } = {}) => {
    const headers = tok ? { authorization: `Bearer ${tok}` } : {}
    const res = await dir.handle(new Request(`http://dir.test${path}`, { method, headers, body: form ? new URLSearchParams(form) : body ? JSON.stringify(body) : undefined }), 'http://dir.test', clock)
    const text = await res.text()
    try {
      return { status: res.status, data: JSON.parse(text) }
    } catch {
      return { status: res.status, data: text }
    }
  }
  const stored = () => JSON.stringify([...data.values()])
  // A sign-in up to the confirmation page; then its Continue, and Claude Code collecting it.
  const begin = async (email, name, more = '') => {
    const verifier = secret()
    const login = sha(verifier)
    return { verifier, login, form: formOf((await here(`/auth/test/start?login=${login}&email=${encodeURIComponent(email)}&name=${name}${more}`)).data) }
  }
  const proceed = s => here('/auth/confirm', { method: 'POST', form: { login: s.login, nonce: s.form.nonce ?? '' } })
  const collect = s => here('/api/auth/poll', { method: 'POST', body: { verifier: s.verifier } })
  const signedIn = async (email, name, more = '') => {
    const s = await begin(email, name, more)
    await proceed(s)
    const got = (await collect(s)).data
    return { token: got.token, id: got.account?.id }
  }

  // No token in storage until Claude Code collects it, and then only its hash.
  const ada = await begin('ada@first.test', 'Ada')
  const asked = data.get(`login:${ada.login}`)
  await proceed(ada)
  const done = data.get(`login:${ada.login}`)
  ok(asked?.status === 'confirm' && done?.status === 'done' && done.account && !('token' in done) && !stored().includes('ssa_'), 'a finished sign-in keeps its account, not a token, until Claude Code collects it')
  const got = (await collect(ada)).data
  ok(got.status === 'done' && /^ssa_/.test(got.token) && Boolean(got.account?.id) && data.get(`tok:${sha(got.token)}`)?.account === got.account.id && !stored().includes('ssa_') && !data.has(`login:${ada.login}`), "its token is made as it's collected: only the hash is kept, and the sign-in is gone")
  ok((await dir.accountOf(got.token))?.name === 'Ada', 'and it signs Ada in')
  // A provider's own answer (GitHub's, made up here), which may come back
  // without a word from someone who authorized the app before, only asks too.
  const gh = new Directory(mapStore(new Map()), {
    providers: { github: { id: 'cid', secret: 'cs' } },
    fetch: async url => {
      const u = String(url)
      const body = u.includes('access_token') ? { access_token: 'gho_x' } : u.endsWith('/user') ? { id: 7, login: 'vic', name: 'Vic' } : u.includes('/user/emails') ? [{ email: 'vic@corp.dev', primary: true, verified: true }] : []
      return new Response(JSON.stringify(body))
    },
  })
  const ghAt = (path, init) => gh.handle(new Request(`http://dir.test${path}`, init), 'http://dir.test', clock)
  const ghPoll = async verifier => (await ghAt('/api/auth/poll', { method: 'POST', body: JSON.stringify({ verifier }) })).json()
  const vic = secret()
  const vicLogin = sha(vic)
  const stateOf = async (login = vicLogin) => new URL((await ghAt(`/auth/github/start?login=${login}`)).headers.get('location')).searchParams.get('state')
  const [s1, s2] = [await stateOf(), await stateOf()]
  const back = await ghAt(`/auth/github/callback?state=${s1}&code=c1`)
  const backPage = await back.text()
  const early = await ghPoll(vic)
  ok(back.status === 200 && back.headers.get('x-frame-options') === 'DENY' && says(backPage, 'signing in as Vic (vic@corp.dev)') && formOf(backPage).code === codeOf(vicLogin) && early.status === 'confirm' && !early.token, "GitHub's answer shows who and the code, and hands nothing over")
  await ghAt('/auth/confirm', { method: 'POST', body: new URLSearchParams({ login: vicLogin, nonce: formOf(backPage).nonce ?? '' }) })
  const second = await (await ghAt(`/auth/github/callback?state=${s2}&code=c2`)).text()
  const vicGot = await ghPoll(vic)
  ok(says(second, "You're already signed in") && vicGot.status === 'done' && /^ssa_/.test(vicGot.token) && vicGot.account?.name === 'Vic', "another answer for a sign-in already continued leaves it for Claude Code to collect")
  // The provider's answer shows the code, and so does a second answer before Continue.
  const wyn = sha(secret())
  const [w1, w2] = [await stateOf(wyn), await stateOf(wyn)]
  const answered = [await (await ghAt(`/auth/github/callback?state=${w1}&code=c1`)).text(), await (await ghAt(`/auth/github/callback?state=${w2}&code=c2`)).text()]
  ok(answered.every(html => formOf(html).code === codeOf(wyn) && says(html, 'and the codes match.')), "GitHub's answer shows the code, and a second answer too")
  // Expired sign-ins go when they're asked for, finished or not, and a late Continue does nothing.
  const unanswered = await begin('una@first.test', 'Una')
  const uncollected = await begin('uli@first.test', 'Uli')
  await proceed(uncollected)
  const tooLate = await begin('tim@first.test', 'Tim')
  clock += 10 * 60_000 + 1
  const answers = [(await collect(unanswered)).data.status, (await collect(uncollected)).data.status]
  ok(answers.every(s => s === 'expired') && !data.has(`login:${unanswered.login}`) && !data.has(`login:${uncollected.login}`), 'an expired sign-in is deleted when Claude Code asks for it, finished or not')
  const late = await proceed(tooLate)
  ok(late.status === 410 && !data.has(`login:${tooLate.login}`) && !(await dir.kv.get('ident:test:tim@first.test')), 'a Continue after the ten minutes signs nobody in, and the sign-in goes')

  // Removing someone who isn't in a team writes nothing; removing a member still remembers it.
  const olga = await signedIn('olga@acme.dev', 'Olga', '&orgs=acme-gh')
  const team = (await here('/api/teams', { method: 'POST', tok: olga.token, body: { name: 'Acme' } })).data.team
  for (const who of ['stranger1', 'stranger2', 'stranger3']) await here(`/api/teams/${team.id}/members/${who}`, { method: 'DELETE', tok: olga.token })
  const ann = await signedIn('ann@else.org', 'Ann')
  await here(`/api/invites/${team.invite}`, { method: 'POST', tok: ann.token })
  await here(`/api/teams/${team.id}/members/${ann.id}`, { method: 'DELETE', tok: olga.token })
  const lefts = [...data.keys()].filter(k => k.startsWith('left:'))
  ok(lefts.length === 1 && lefts[0] === `left:${team.id}:${ann.id}`, "removing someone who was never in the team writes nothing; removing a member still keeps the domain from taking them back")

  // A team's new rules look only at the accounts they take: none for an
  // unchanged list, one index for a new domain, one read of the accounts for
  // a new organization.
  for (let i = 0; i < 40; i++) {
    data.set(`acct:plain${i}`, { id: `plain${i}`, name: `P${i}`, email: `p${i}@else.org`, emailVerified: true, githubOrgs: [], idents: [] })
    data.set(`email:p${i}@else.org`, `plain${i}`)
  }
  const bea = await signedIn('bea@acme.dev', 'Bea')
  const gil = await signedIn('gil@else.org', 'Gil', '&orgs=acme-gh')
  const looked = []
  const autoJoin = dir.autoJoin.bind(dir)
  dir.autoJoin = async (a, now) => (looked.push(a.id), autoJoin(a, now))
  const patch = body => {
    looked.length = 0
    lists.length = 0
    return here(`/api/teams/${team.id}`, { method: 'PATCH', tok: olga.token, body })
  }
  const scans = () => lists.filter(p => p === 'acct:' || p === 'email:').join()
  const inTeam = async tok => (await here('/api/me', { tok })).data.teams.some(t => t.id === team.id)
  for (const body of [{ githubOrgs: [] }, { domains: '' }, { name: 'Acme Co' }, { access: 'link' }]) {
    const res = await patch(body)
    ok(res.status === 200 && looked.length === 0 && scans() === '', `an owner's change that adds no domain or organization looks at no account (${Object.keys(body)})`)
  }
  await patch({ domains: 'acme.dev' })
  ok(looked.sort().join() === [olga.id, bea.id].sort().join() && scans() === 'email:' && (await inTeam(bea.token)), 'a new domain looks only at the accounts it takes, through the verified-email index, and takes them in')
  await patch({ domains: 'acme.dev' })
  ok(looked.length === 0 && scans() === '', 'saving the same domain again looks at nobody')
  await patch({ githubOrgs: 'acme-gh' })
  ok(looked.sort().join() === [olga.id, gil.id].sort().join() && scans() === 'acct:' && (await inTeam(gil.token)), 'a new organization takes its members, with one read of the accounts')
  dir.autoJoin = autoJoin

  // How much one account may change a minute: 30, session invites included,
  // then 429 until the minute is over; reading, signing out and deleting the
  // account always go through, and nobody else's changes are refused.
  const zed = await signedIn('zed@zed.test', 'Zed')
  const zteam = (await here('/api/teams', { method: 'POST', tok: zed.token, body: { name: 'Zed' } })).data.team
  const fill = async () => {
    const codes = []
    for (let i = 0; codes.length < 40; i++) codes.push((await here(`/api/teams/${zteam.id}`, { method: 'PATCH', tok: zed.token, body: { name: `Zed ${i}` } })).status)
    return codes
  }
  const first = await fill()
  const room = { id: 'r'.repeat(16), url: 'http://dir.test/s/r', title: 't', host: 'Zed' }
  ok(first.indexOf(429) === 29 && first.slice(0, 29).every(s => s === 200) && (await dir.sessionInvite(zed.token, room, [], clock)).status === 429, "an account's 30 changes a minute (its team, then 29 edits) go through, and the next are refused, session invites too")
  ok((await here(`/api/teams/${team.id}`, { method: 'PATCH', tok: olga.token, body: { name: 'Acme' } })).status === 200 && (await here('/api/me', { tok: zed.token })).status === 200, "someone else's changes, and its own reading, go on")
  clock += 60_000
  ok((await fill()).indexOf(429) === 30, 'the next minute it may change again')
  const yan = await signedIn('yan@zed.test', 'Yan')
  for (let i = 0; i < 31; i++) await here(`/api/me/invites/${'r'.repeat(16)}`, { method: 'DELETE', tok: yan.token })
  ok((await here('/api/me/invites/x', { method: 'DELETE', tok: yan.token })).status === 429 && (await here('/api/auth/logout', { method: 'POST', tok: yan.token })).status === 200 && !(await dir.accountOf(yan.token)), 'past its minute an account can still sign out')
  ok((await here('/api/me', { method: 'DELETE', tok: zed.token })).status === 200 && !(await dir.kv.get(`acct:${zed.id}`)), 'and delete itself')
}

// A verified address signs in to an account only while that account still
// has it, and only from another provider: an address it moved from, a second
// account at the same provider with the address, or an index entry left
// behind take nobody's account.
{
  const { Directory, mapStore } = await import('../server/teams.mjs')
  const data = new Map()
  const dir = new Directory(mapStore(data), { providers: {} })
  const now = 1_000_000
  const github = (subject, email) => ({ provider: 'github', subject, login: `gh${subject}`, name: `GH ${subject}`, email, emailVerified: true })
  const google = (subject, email) => ({ provider: 'google', subject, name: `G ${subject}`, email, emailVerified: true })
  const alice = await dir.signIn(github('1', 'alice@old.test'), now)
  const moved = await dir.signIn(github('1', 'Alice@New.test'), now)
  ok(moved.id === alice.id && moved.email === 'alice@new.test' && !data.has('email:alice@old.test') && data.get('email:alice@new.test') === alice.id, 'an address an account moved from leaves the index')
  const heir = await dir.signIn(google('g9', 'alice@old.test'), now)
  ok(heir.id !== alice.id && data.get('email:alice@old.test') === heir.id, "whoever has that address next signs in to an account of their own, never the one that moved from it")
  const own = await dir.signIn(google('g1', 'alice@new.test'), now)
  ok(own.id === alice.id && own.idents.includes('ident:google:g1') && own.idents.includes('ident:github:1'), "another provider's identity with the address an account has now is that account")
  const recycled = await dir.signIn(google('g2', 'alice@new.test'), now)
  ok(recycled.id !== alice.id && (await dir.kv.get('ident:google:g1')) === alice.id, 'a second identity at the same provider with that address (the address made again for someone else) is someone else')
  data.set('email:left@old.test', alice.id)
  const stale = await dir.signIn(google('g3', 'left@old.test'), now)
  ok(stale.id !== alice.id && data.get('email:left@old.test') === stale.id, "an index entry whose account doesn't have that address any more takes nobody's account")
  data.set('email:alice@new.test', alice.id)
  const mine = await dir.signIn(github('5', 'mine@test.test'), now)
  data.set('email:mine@test.test', alice.id)
  await dir.deleteAccount(mine)
  ok(data.get('email:mine@test.test') === alice.id && !data.has(`acct:${mine.id}`), "deleting an account removes only the index entries that are its own")
  await dir.deleteAccount(await dir.kv.get(`acct:${alice.id}`))
  ok(!data.has('email:alice@new.test') && !data.has('ident:github:1') && !data.has('ident:google:g1'), 'and its own, with its identities')
}

// What's timed goes when it's due, whether anyone asks or not (the adapter is
// told when: `onDue`), and a session's end or expiry takes its invites and
// its place on its team's list; deleting an account takes the invites it
// sent and its sessions' places on its teams' lists too.
{
  const { Directory, mapStore } = await import('../server/teams.mjs')
  const data = new Map()
  const due = []
  const dir = new Directory(mapStore(data), { providers: { test: {} }, onDue: at => due.push(at), roomInfo: async () => ({ title: 't', people: [], ended: false }) })
  const now = 5_000_000, HOURS_12 = 12 * 60 * 60 * 1000
  const person = (subject, name) => dir.signIn({ provider: 'github', subject, login: name.toLowerCase(), name, email: `${name.toLowerCase()}@x.test`, emailVerified: true }, now)
  const [hana, milo] = [await person('h1', 'Hana'), await person('m1', 'Milo')]
  const crew = (await (await dir.createTeam(hana, { name: 'Crew' }, now)).json()).team
  await dir.addMember(crew.id, milo.id, 'member', now)
  const hanaToken = await dir.mint(hana.id, now)
  const room = id => ({ id: id.repeat(16), url: `http://dir.test/s/${id}`, title: 't', host: 'Hana' })
  const invited = r => data.has(`sinv:${milo.id}:${r.id}`) || data.has(`rinv:${r.id}:${milo.id}`)
  const [a, b, c] = [room('a'), room('b'), room('c')]
  await dir.sessionInvite(hanaToken, a, [milo.id], now)
  ok(invited(a) && due.at(-1) === now + HOURS_12, 'an invite is kept with its session\'s index of it, and the adapter told when it goes')
  ok((await dir.sweep(now + HOURS_12 - 1)) === now + HOURS_12 && invited(a), 'before its 12 hours it stays')
  ok((await dir.sweep(now + HOURS_12 + 1)) === null && !invited(a), 'and at them it goes, whether anyone asks or not')
  await dir.sessionInvite(hanaToken, b, [milo.id], now)
  await dir.register(crew.id, { ...b, createdAt: now, hostAccount: hana.id })
  await dir.roomEnded(b.id, crew.id)
  ok(!invited(b) && !data.has(`live:${crew.id}:${b.id}`), "a session's end takes its invites and its place on its team's list")
  const verifier = 'V'.repeat(40), login = sha(verifier)
  await dir.handle(new Request(`http://dir.test/auth/test/start?login=${login}&email=x@x.test&name=X`), 'http://dir.test', now)
  ok(data.has(`login:${login}`) && due.at(-1) === now + 10 * 60_000, 'a sign-in under way tells the adapter when it goes')
  await dir.sweep(now + 10 * 60_000 + 1)
  ok(!data.has(`login:${login}`), 'and goes at its ten minutes')
  await dir.sessionInvite(hanaToken, c, [milo.id], now)
  await dir.register(crew.id, { ...c, createdAt: now, hostAccount: hana.id })
  await dir.deleteAccount(hana)
  ok(!invited(c) && !data.has(`live:${crew.id}:${c.id}`), "deleting an account takes the invites it sent and its sessions' places on its teams' lists")
}

// The Worker sends the same sign-in, its Continue included, to its
// directory object (Directory.owns), over a stub of the namespace.
{
  const { default: worker, DirectoryObject } = await import('../server/worker.mjs')
  const kept = new Map()
  const storage = { get: async k => kept.get(k), put: async (k, v) => void kept.set(k, v), delete: async k => kept.delete(k), list: async ({ prefix }) => new Map([...kept].filter(([k]) => k.startsWith(prefix))) }
  const env = { AUTH_TEST: '1', PUBLIC_URL: 'https://share.test', JOIN_LIMIT: { limit: async () => ({ success: true }) } }
  const object = new DirectoryObject({ storage }, env)
  env.DIRECTORY = { idFromName: name => name, get: () => ({ fetch: req => object.fetch(req) }) }
  const at = (path, init) => worker.fetch(new Request(`https://share.test${path}`, init), env)
  const verifier = secret()
  const login = sha(verifier)
  const poll = async () => (await at('/api/auth/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verifier }) })).json()
  const started = await at(`/auth/test/start?login=${login}&email=wes@acme.dev&name=Wes`)
  const form = formOf(await started.text())
  const early = await poll()
  const done = await at('/auth/confirm', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ login, nonce: form.nonce ?? '' }) })
  const page = await done.text()
  const got = await poll()
  ok(early.status === 'confirm' && done.status === 200 && says(page, "You're signed in, Wes") && got.status === 'done' && /^ssa_/.test(got.token) && !JSON.stringify([...kept.values()]).includes('ssa_'), "on the Worker too, the sign-in waits for its Continue, and only the token's hash is stored")
  ok(form.code === codeOf(login) && /^frame-ancestors 'none'; script-src 'sha256-[A-Za-z0-9+/]{43}='$/.test(started.headers.get('content-security-policy') ?? ''), 'and its page shows the code, under the same script policy')
}
