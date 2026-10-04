#!/usr/bin/env node
// Sets up shared sessions on this machine, for a person or an agent.
//
//   node scripts/setup.mjs join                   install the plugin (joining needs nothing else)
//   node scripts/setup.mjs host --server <url>    install, and share through an existing server
//   node scripts/setup.mjs deploy                 deploy a server to Cloudflare, then use it here
//   node scripts/setup.mjs check [--server <url>] [--live]
//                                                 verify the plugin, the server and (--live) a real share
//
// Non-interactive and safe to re-run. Every step prints one line:
//   OK ...           done or already so
//   NOTE ...         worth knowing, changes nothing (e.g. an old terminal `claude`)
//   NEEDS HUMAN ...  a person must act (sign in, approve in a browser); the line says what
//   FAIL ...         could not be done; the line says why
// Set CLAUDE_BIN=/path/to/claude to use a particular Claude Code binary.
// Exit codes: 0 all OK, 2 a person must act, 1 something failed.
// Nothing here prints a token or credential.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { basename } from 'node:path'
import { join } from 'node:path'

const MARKETPLACE = 'Paradigm-Study/claude-share'
const PLUGIN = 'shared-session@claude-share'
// This checkout's plugin version: what setup's own requests to a server say
// they are (a server turns away plugins older than its minimum).
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../plugin/.claude-plugin/plugin.json', import.meta.url), 'utf8')).version
  } catch {
    return ''
  }
})()
const MIN_VERSION = [2, 1, 286]
// 2.1.285 runs the plugin too, with function hooks turned on (early access there).
const EARLY_VERSION = [2, 1, 285]

const [command, ...rest] = process.argv.slice(2)
const flag = name => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true) : undefined
}

let status = 0
const ok = line => console.log(`OK ${line}`)
const note = line => console.log(`NOTE ${line}`)
const human = line => {
  console.log(`NEEDS HUMAN ${line}`)
  status = Math.max(status, 2)
}
const fail = line => {
  console.log(`FAIL ${line}`)
  status = 1
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 180_000, input: opts.input, cwd: opts.cwd, env: opts.env ?? process.env })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error }
}

const versionOf = out => (/(\d+)\.(\d+)\.(\d+)/.exec(out) ?? []).slice(1).map(Number)
const atLeast = (v, min) => {
  for (let i = 0; i < 3; i++) if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i]
  return true
}
const newestFirst = (a, b) => {
  const [x, y] = [versionOf(a), versionOf(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)
  return 0
}

// A Claude Code new enough for function-hook plugins: $CLAUDE_BIN, `claude` on
// PATH, or the newest one Claude Desktop bundles (macOS).
function findClaude() {
  const candidates = []
  if (process.env.CLAUDE_BIN) candidates.push(process.env.CLAUDE_BIN)
  candidates.push('claude')
  // The account's real home, even when HOME is overridden (a sandbox, CI).
  const bundled = join(userInfo().homedir, 'Library/Application Support/Claude/claude-code')
  if (existsSync(bundled)) {
    for (const version of readdirSync(bundled).sort(newestFirst)) {
      const dir = join(bundled, version)
      for (const build of existsSync(dir) ? readdirSync(dir) : []) {
        candidates.push(join(dir, build, 'claude.app/Contents/MacOS/claude'))
      }
    }
  }
  let newestSeen = null
  let early = null
  for (const bin of candidates) {
    const r = run(bin, ['--version'], { timeout: 20_000 })
    if (r.error || r.code !== 0) continue
    const v = versionOf(r.out)
    if (atLeast(v, MIN_VERSION)) return { bin, version: v.join('.') }
    if (atLeast(v, EARLY_VERSION)) early ??= { bin, version: v.join('.') }
    newestSeen ??= v.join('.')
  }
  if (early) {
    enableFunctionHooks(early.version)
    return early
  }
  return { bin: null, version: newestSeen }
}

// Claude Code 2.1.285 loads function-hook plugins only with this switch on
// (2.1.286 and newer have it on): set in the person's settings, nothing else
// there touched.
function enableFunctionHooks(version) {
  const path = join(homedir(), '.claude', 'settings.json')
  let settings = {}
  try {
    if (existsSync(path)) settings = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return note(`Claude Code ${version} needs CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 for this plugin, and ${path} couldn't be read to set it; set it in your environment, or run \`claude update\``)
  }
  if (settings.env?.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === '1') return
  settings.env = { ...(settings.env ?? {}), CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' }
  mkdirSync(join(homedir(), '.claude'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
  ok(`Claude Code ${version} runs this plugin with function hooks on: set CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 in ${path} (\`claude update\` to 2.1.286 or newer makes it unnecessary)`)
}

function needClaude() {
  const { bin, version } = findClaude()
  if (!bin) {
    fail(
      version
        ? `Claude Code ${version} is too old for this plugin; it needs ${MIN_VERSION.join('.')} or newer. Run \`claude update\`, or point at a newer binary with CLAUDE_BIN=/path/to/claude (Claude Desktop bundles one).`
        : 'Claude Code is not installed. Install it (https://claude.com/claude-code) or Claude Desktop, or set CLAUDE_BIN=/path/to/claude, then run this again.',
    )
    process.exit(status)
  }
  ok(`Claude Code ${version} (${bin === 'claude' ? 'on PATH' : bin})`)
  if (bin !== 'claude') {
    const onPath = run('claude', ['--version'], { timeout: 20_000 })
    if (!onPath.error && onPath.code === 0 && atLeast(versionOf(onPath.out), EARLY_VERSION) && !atLeast(versionOf(onPath.out), MIN_VERSION)) {
      enableFunctionHooks(versionOf(onPath.out).join('.'))
    } else if (!onPath.error && onPath.code === 0 && !atLeast(versionOf(onPath.out), MIN_VERSION)) {
      note(
        `your terminal \`claude\` is ${versionOf(onPath.out).join('.')}, older than ${MIN_VERSION.join('.')}: Claude Desktop sessions get the plugin, terminal sessions won't until you run \`claude update\``,
      )
    }
  }
  return bin
}

function validServer(url) {
  if (typeof url !== 'string' || !/^https?:\/\/[^\s/]+/.test(url)) return null
  return url.replace(/\/+$/, '')
}

function installPlugin(claude, server) {
  const added = run(claude, ['plugin', 'marketplace', 'add', MARKETPLACE])
  if (added.code !== 0 && !/already/i.test(added.out)) return fail(`adding the marketplace: ${added.out.trim().split('\n').pop()}`)
  run(claude, ['plugin', 'marketplace', 'update', 'claude-share'])
  const listed = run(claude, ['plugin', 'list'])
  if (listed.out.includes(PLUGIN)) {
    const updated = run(claude, ['plugin', 'update', PLUGIN])
    ok(`plugin installed (${(/updated from \S+ to (\S+)/.exec(updated.out) ?? [, 'already current'])[1]})`)
  } else {
    const args = ['plugin', 'install', PLUGIN]
    if (server) args.push('--config', `server=${server}`)
    const installed = run(claude, args)
    if (installed.code !== 0) return fail(`installing the plugin: ${installed.out.trim().split('\n').pop()}`)
    ok('plugin installed')
  }
  if (server) configureServer(claude, server)
  enableAutoUpdate()
  ok('new Claude Code sessions load it; quit and reopen Claude Desktop so open sessions do too (a session keeps the plugin copy it started with)')
}

// Claude Code updates a third-party marketplace's plugins by itself only when
// the marketplace has `autoUpdate` on (off by default): this turns it on in
// the person's settings, leaving everything else there as it was.
function enableAutoUpdate() {
  const path = join(homedir(), '.claude', 'settings.json')
  let settings = {}
  try {
    if (existsSync(path)) settings = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return note(`couldn't read ${path}, so updates stay manual; turn them on in /plugin → Marketplaces → claude-share`)
  }
  const known = settings.extraKnownMarketplaces ?? {}
  const entry = known['claude-share'] ?? { source: { source: 'github', repo: MARKETPLACE } }
  if (entry.autoUpdate === true) return ok('updates install by themselves')
  settings.extraKnownMarketplaces = { ...known, 'claude-share': { ...entry, autoUpdate: true } }
  mkdirSync(join(homedir(), '.claude'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
  ok('updates now install by themselves (the marketplace\'s autoUpdate is on)')
}

function configureServer(claude, server) {
  const r = run(claude, ['plugin', 'configure', PLUGIN, '--values-stdin'], { input: JSON.stringify({ server }) })
  if (r.code !== 0) return fail(`setting the share server: ${r.out.trim().split('\n').pop()}`)
  ok(`share server set to ${server}`)
}

async function health(server, { waitMs = 0 } = {}) {
  const end = Date.now() + waitMs
  let last = ''
  do {
    try {
      const res = await fetch(`${server}/api/health`, { signal: AbortSignal.timeout(8000) })
      const body = await res.json().catch(() => ({}))
      if (res.ok && body.ok) return true
      last = `HTTP ${res.status}`
    } catch (error) {
      last = String(error?.cause?.code ?? error?.message ?? error)
    }
    if (Date.now() < end) await new Promise(r => setTimeout(r, 10_000))
  } while (Date.now() < end)
  return last
}

// One request; never throws. A body that isn't JSON (a proxy's or Cloudflare's
// error page) reads as {}, and the status says what happened.
async function call(url, init = {}) {
  try {
    const headers = { 'content-type': 'application/json', 'x-shared-session-version': PLUGIN_VERSION, ...(init.headers ?? {}) }
    const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(15_000) })
    const text = await res.text()
    let body = {}
    try {
      body = JSON.parse(text)
    } catch {}
    return { ok: res.ok, status: res.status, body }
  } catch (error) {
    return { ok: false, status: 0, body: {}, error: String(error?.cause?.code ?? error?.message ?? error) }
  }
}

const why = r => (r.status ? `HTTP ${r.status}${r.body.error ? `: ${r.body.error}` : ''}` : r.error)

// Create a room, seat a guest, open the guest's stream, serve the link page,
// end the room. Returns { ok, stream } or { reason }.
async function roomRoundTrip(server) {
  const created = await call(`${server}/api/rooms`, { method: 'POST', body: JSON.stringify({ name: 'setup-check', title: 'setup check' }) })
  if (!created.ok) return { reason: `creating a room: ${why(created)}` }
  const { id, url, token } = created.body
  try {
    const joined = await call(`${server}/api/rooms/${id}/join`, { method: 'POST', body: JSON.stringify({ name: 'setup-guest' }) })
    if (!joined.ok) return { reason: `joining it: ${why(joined)}` }
    const page = await call(url)
    if (!page.ok || !url?.startsWith(server)) return { reason: `its link page: ${why(page)}` }
    return { ok: true, stream: await firstStreamLine(`${server}/api/rooms/${id}/stream?after=0`, joined.body.token) }
  } finally {
    await call(`${server}/api/rooms/${id}/end`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  }
}

// The first line a room's stream sends: true when it is the room as it stands,
// else why not (a server too old to stream answers "Not found").
async function firstStreamLine(url, token) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 10_000)
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal })
    if (!res.ok) return `HTTP ${res.status}`
    const reader = res.body.getReader()
    let text = ''
    while (!text.includes('\n')) {
      const { done, value } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    const line = JSON.parse(text.split('\n')[0])
    return Array.isArray(line.events) && line.people?.some(p => p.name === 'setup-guest') ? true : 'an unexpected first line'
  } catch (error) {
    return String(error?.name === 'AbortError' ? 'no line within 10 s' : error?.message ?? error)
  } finally {
    clearTimeout(timer)
    ctl.abort()
  }
}

function configuredServer(claude) {
  const r = run(claude, ['plugin', 'configure', PLUGIN, '--json'])
  try {
    const parsed = JSON.parse(r.out.slice(r.out.indexOf('{')))
    const found = JSON.stringify(parsed).match(/https?:\/\/[^"\s]+/)
    if (found) return found[0]
  } catch {}
  return process.env.SHARED_SESSION_SERVER || null
}

async function deploy(claude) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' }
  const who = run(npx, ['-y', 'wrangler@4', 'whoami'], { env })
  if (/not authenticated/i.test(who.out)) {
    human('Cloudflare sign-in: run `npx wrangler login` in this folder. It opens a browser where a person approves access; then run `node scripts/setup.mjs deploy` again.')
    return
  }
  ok('signed in to Cloudflare')
  const out = run(npx, ['-y', 'wrangler@4', 'deploy'], { env, timeout: 300_000 }).out
  const account = /accounts\/([0-9a-f]{32})/.exec(out)?.[1]
  if (/code: 10063|workers\.dev subdomain/i.test(out)) {
    human(
      `Cloudflare needs this account's workers.dev subdomain created once: open ${account ? `https://dash.cloudflare.com/${account}/workers-and-pages` : 'Workers & Pages in the Cloudflare dashboard'} (pick a subdomain if asked), then run \`node scripts/setup.mjs deploy\` again.`,
    )
    return
  }
  const url = validServer(/https:\/\/[^\s]+\.workers\.dev/.exec(out)?.[0])
  if (!url) return fail(`deploy: ${out.trim().split('\n').slice(-3).join(' | ')}`)
  ok(`deployed to ${url}`)
  // Previews of a host's localhost: the same script as a second Worker, on its own host name.
  const preview = run(npx, ['-y', 'wrangler@4', 'deploy', '-c', 'wrangler.preview.toml'], { env, timeout: 300_000 }).out
  const previewUrl = /https:\/\/[^\s]+\.workers\.dev/.exec(preview)?.[0]
  if (previewUrl) ok(`previews deployed to ${previewUrl}`)
  else note(`previews didn't deploy (${preview.trim().split('\n').slice(-2).join(' | ')}); sharing works, previews of localhost won't until \`npx wrangler deploy -c wrangler.preview.toml\` succeeds`)
  const ready = await health(url, { waitMs: 300_000 }) // a new subdomain's certificate takes a minute or so
  if (ready !== true) return fail(`the server is not answering yet (${ready}); a new workers.dev certificate can take a few minutes — run \`node scripts/setup.mjs check --server ${url}\` shortly`)
  ok('server is up')
  installPlugin(claude, url)
  console.log(`\nTeammates install with one line:\n  claude plugin marketplace add ${MARKETPLACE} && claude plugin install ${PLUGIN} --config server=${url}`)
}

// The session transcripts a check's throwaway sessions leave, removed by the
// throwaway folder's unique name.
function forgetSessions(dir) {
  const projects = join(process.env.HOME || homedir(), '.claude', 'projects')
  if (!existsSync(projects)) return
  for (const entry of readdirSync(projects)) if (entry.includes(basename(dir))) rmSync(join(projects, entry), { recursive: true, force: true })
}

async function check(claude) {
  const listed = run(claude, ['plugin', 'list'])
  const block = listed.out.slice(listed.out.indexOf(PLUGIN), listed.out.indexOf(PLUGIN) + 200)
  if (!listed.out.includes(PLUGIN)) fail('the plugin is not installed: run `node scripts/setup.mjs join`')
  else ok(`plugin installed${/Version: (\S+)/.exec(block) ? ` (${/Version: (\S+)/.exec(block)[1]})` : ''}${/enabled/.test(block) ? ', enabled' : ''}`)

  const saved = validServer(configuredServer(claude))
  const server = validServer(flag('server')) ?? saved
  if (!server) {
    ok('no share server set: this machine can join links but not share. To share, run `node scripts/setup.mjs host --server <url>` (or `deploy`)')
    return
  }
  if (!saved) note(`no share server is saved on this machine; checking ${server} as given`)
  const up = await health(server)
  if (up !== true) return fail(`share server ${server} is not answering (${up})`)
  ok(`share server ${server} is up`)
  const trip = await roomRoundTrip(server)
  if (!trip.ok) return fail(`the server's room round trip failed (${trip.reason})`)
  ok('the server can create a room, let a seat in over HTTP, serve its link page and end it')
  if (trip.stream === true) ok('the server streams room changes, so quiet rooms cost no requests')
  else note(`the server has no stream (${trip.stream}); Claude Code will poll it instead. Deploy the current server to fix that`)

  if (!flag('live')) return
  // Real Claude Code sessions in a throwaway folder: one shares with this
  // machine's saved settings, one joins a room by its link. Neither touches
  // this machine's other sessions; their transcripts are removed after.
  const dir = mkdtempSync(join(tmpdir(), 'shared-session-check-'))
  try {
    const env = flag('server') && !saved ? { ...process.env, SHARED_SESSION_SERVER: server } : process.env
    const shared = run(claude, ['-p', '/share-session'], { cwd: dir, env, timeout: 120_000 })
    const link = new RegExp(`${server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/s/([A-Za-z0-9_-]{16,})`).exec(shared.out)
    if (!link) fail(`a real session could not share: ${shared.out.trim().split('\n').pop()}`)
    else {
      const room = (await call(`${server}/api/rooms/${link[1]}`)).body
      if (room.ended) ok(`a real session shared${saved ? ' with the saved setting' : ''}, and its room ended when the session did`)
      else fail('a real session shared, but its room was still open after the session ended')
    }

    const made = await call(`${server}/api/rooms`, { method: 'POST', body: JSON.stringify({ name: 'setup-check', title: 'setup check' }) })
    if (!made.ok) return fail(`could not make a room for the join check (${why(made)})`)
    const host = made.body
    run(claude, ['-p', host.url], { cwd: dir, timeout: 120_000 })
    const page = (await call(`${server}/api/rooms/${host.id}/events?after=0&wait=0`, { headers: { authorization: `Bearer ${host.token}` } })).body
    await call(`${server}/api/rooms/${host.id}/end`, { method: 'POST', headers: { authorization: `Bearer ${host.token}` } })
    const joined = (page.events ?? []).find(e => e.type === 'join' && e.from?.role === 'guest')
    if (joined) ok(`a real session joined a room from its link (as "${joined.from.name}")`)
    else fail('a real session given a share link did not join it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    forgetSessions(dir)
  }
}

const usage = `usage:
  node scripts/setup.mjs join
  node scripts/setup.mjs host --server <url>
  node scripts/setup.mjs deploy
  node scripts/setup.mjs check [--server <url>] [--live]`

switch (command) {
  case 'join': {
    installPlugin(needClaude(), null)
    break
  }
  case 'host': {
    const server = validServer(flag('server'))
    if (!server) {
      fail('host needs --server <https://your-share-server> (or run `deploy` to make one)')
      break
    }
    const claude = needClaude()
    const up = await health(server)
    if (up !== true) fail(`share server ${server} is not answering (${up})`)
    else ok(`share server ${server} is up`)
    installPlugin(claude, server)
    break
  }
  case 'deploy': {
    await deploy(needClaude())
    break
  }
  case 'check': {
    await check(needClaude())
    break
  }
  default:
    console.log(usage)
    status = command ? 1 : 0
}
process.exit(status)
