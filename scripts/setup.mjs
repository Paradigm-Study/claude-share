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
//   NEEDS HUMAN ...  a person must act (sign in, approve in a browser); the line says what
//   FAIL ...         could not be done; the line says why
// Exit codes: 0 all OK, 2 a person must act, 1 something failed.
// Nothing here prints a token or credential.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const MARKETPLACE = 'Paradigm-Study/claude-share'
const PLUGIN = 'shared-session@claude-share'
const MIN_VERSION = [2, 1, 286]

const [command, ...rest] = process.argv.slice(2)
const flag = name => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true) : undefined
}

let status = 0
const ok = line => console.log(`OK ${line}`)
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

// A Claude Code new enough for function-hook plugins: $CLAUDE_BIN, `claude` on
// PATH, or the newest one Claude Desktop bundles (macOS).
function findClaude() {
  const candidates = []
  if (process.env.CLAUDE_BIN) candidates.push(process.env.CLAUDE_BIN)
  candidates.push('claude')
  const bundled = join(homedir(), 'Library/Application Support/Claude/claude-code')
  if (existsSync(bundled)) {
    for (const version of readdirSync(bundled).sort().reverse()) {
      const dir = join(bundled, version)
      for (const build of existsSync(dir) ? readdirSync(dir) : []) {
        candidates.push(join(dir, build, 'claude.app/Contents/MacOS/claude'))
      }
    }
  }
  let newestSeen = null
  for (const bin of candidates) {
    const r = run(bin, ['--version'], { timeout: 20_000 })
    if (r.error || r.code !== 0) continue
    const v = versionOf(r.out)
    if (atLeast(v, MIN_VERSION)) return { bin, version: v.join('.') }
    newestSeen ??= v.join('.')
  }
  return { bin: null, version: newestSeen }
}

function needClaude() {
  const { bin, version } = findClaude()
  if (!bin) {
    fail(
      version
        ? `Claude Code ${version} is too old for this plugin; it needs ${MIN_VERSION.join('.')} or newer. Run \`claude update\` (or install Claude Desktop, which bundles a current one).`
        : 'Claude Code is not installed. Install it (https://claude.com/claude-code) or Claude Desktop, then run this again.',
    )
    process.exit(status)
  }
  ok(`Claude Code ${version} (${bin === 'claude' ? 'on PATH' : bin})`)
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
  ok('new Claude Code sessions load it; quit and reopen Claude Desktop so open sessions do too (a session keeps the plugin copy it started with)')
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

async function roomRoundTrip(server) {
  const created = await fetch(`${server}/api/rooms`, { method: 'POST', body: JSON.stringify({ name: 'setup-check', title: 'setup check' }) }).then(r => r.json())
  const joined = await fetch(`${server}/api/rooms/${created.id}/join`, { method: 'POST', body: JSON.stringify({ name: 'setup-guest' }) }).then(r => r.json())
  const page = await fetch(created.url)
  await fetch(`${server}/api/rooms/${created.id}/end`, { method: 'POST', headers: { authorization: `Bearer ${created.token}` } })
  return Boolean(created.url?.startsWith(server) && joined.token && page.ok)
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
  const ready = await health(url, { waitMs: 300_000 }) // a new subdomain's certificate takes a minute or so
  if (ready !== true) return fail(`the server is not answering yet (${ready}); a new workers.dev certificate can take a few minutes — run \`node scripts/setup.mjs check --server ${url}\` shortly`)
  ok('server is up')
  installPlugin(claude, url)
  console.log(`\nTeammates install with one line:\n  claude plugin marketplace add ${MARKETPLACE} && claude plugin install ${PLUGIN} --config server=${url}`)
}

async function check(claude) {
  const listed = run(claude, ['plugin', 'list'])
  const block = listed.out.slice(listed.out.indexOf(PLUGIN), listed.out.indexOf(PLUGIN) + 200)
  if (!listed.out.includes(PLUGIN)) fail('the plugin is not installed: run `node scripts/setup.mjs join`')
  else ok(`plugin installed${/Version: (\S+)/.exec(block) ? ` (${/Version: (\S+)/.exec(block)[1]})` : ''}${/enabled/.test(block) ? ', enabled' : ''}`)

  const server = validServer(flag('server')) ?? validServer(configuredServer(claude))
  if (!server) {
    ok('no share server set: this machine can join links but not share. To share, run `node scripts/setup.mjs host --server <url>` (or `deploy`)')
    return
  }
  const up = await health(server)
  if (up !== true) return fail(`share server ${server} is not answering (${up})`)
  ok(`share server ${server} is up`)
  if (await roomRoundTrip(server)) ok('a room can be created, joined, opened and ended')
  else fail('the room round trip failed')

  if (flag('live')) {
    // A real Claude Code session shares and stops, with nothing of this machine's sessions involved.
    const dir = mkdtempSync(join(tmpdir(), 'shared-session-check-'))
    const r = run(claude, ['-p', '/share-session'], { cwd: dir, env: { ...process.env, SHARED_SESSION_SERVER: server }, timeout: 120_000 })
    rmSync(dir, { recursive: true, force: true })
    if (r.out.includes(`${server}/s/`)) ok('a real session shared (and stopped when it exited)')
    else fail(`a real session could not share: ${r.out.trim().split('\n').pop()}`)
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
