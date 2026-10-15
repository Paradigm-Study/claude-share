// Installer regressions with a fake CLI, isolated HOME and intercepted fetch.
// No real Claude settings, model calls, remote rooms or deployments are used.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pluginId = 'shared-session@claude-share'
const defaultSource = readFileSync(join(root, 'plugin/hooks/server.ts'), 'utf8')
const defaultUrl = /export const SERVER_URL = ['"]([^'"]*)['"]/.exec(defaultSource)[1]

const fakeCli = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const s = JSON.parse(readFileSync(process.env.SETUP_SCENARIO, 'utf8'))
const args = process.argv.slice(2)
appendFileSync(process.env.SETUP_LOG, JSON.stringify({ kind: 'cli', args, serverEnv: process.env.SHARED_SESSION_SERVER }) + '\n')
const finish = (code, value) => { console.log(typeof value === 'string' ? value : JSON.stringify(value)); process.exit(code) }
const command = args.join(' ')
if (command === '--version') finish(0, '2.1.295 (Claude Code)')
if (command.includes('whoami')) finish(s.whoFail ? 1 : 0, s.whoFail ? 'network unavailable' : 'signed in')
if (command.startsWith('plugin marketplace add ')) finish(0, 'added')
if (command === 'plugin marketplace update claude-share') finish(s.marketplaceFail ? 1 : 0, s.marketplaceFail ? 'marketplace unavailable' : 'updated')
if (command === 'plugin list --json') {
  if (s.listFail) finish(1, 'listing unavailable')
  if (s.listMalformed) finish(0, 'not JSON')
  const plugins = s.missing ? [] : [{ id: 'shared-session@claude-share', version: '0.11.19', enabled: !s.disabled }]
  if (s.inline) plugins.push({ id: 'shared-session@inline', enabled: true })
  finish(0, plugins)
}
if (command.startsWith('plugin update ')) finish(s.updateFail ? 1 : 0, s.updateFail ? 'download failed' : 'already current')
if (command.startsWith('plugin install ')) finish(s.installFail ? 1 : 0, s.installFail ? 'install failed' : 'installed')
if (command.startsWith('plugin enable ')) finish(s.enableFail ? 1 : 0, s.enableFail ? 'enable failed' : 'enabled')
if (command.startsWith('plugin configure ')) {
  if (command.includes('--values-stdin')) finish(s.saveFail ? 1 : 0, s.saveFail ? 'save failed' : 'saved')
  if (s.configFail || (s.inline && args[2] === 'shared-session@claude-share')) finish(1, 'No installed plugin has that id')
  if (s.configMalformed) finish(0, '{}')
  finish(0, { schema: { server: { description: 'Documentation: https://docs.example.invalid/' } }, inputs: { server: s.saved || '' }, configured: s.saved ? ['server'] : [], unconfigured: s.saved ? [] : ['server'] })
}
if (args[0] === '-p') {
  if (args.at(-1) === '/share-session') finish(0, (s.saved || s.settings?.env?.SHARED_SESSION_SERVER || process.env.SHARED_SESSION_SERVER || s.buildServer) + '/s/live-room-abcdefghijkl')
  if (args.at(-1) === '/stop-sharing') writeFileSync(process.env.SETUP_STOPPED, 'yes')
  finish(0, 'done')
}
finish(1, 'unexpected fake CLI command: ' + command)
`

const fakeFetch = String.raw`
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
const s = JSON.parse(readFileSync(process.env.SETUP_SCENARIO, 'utf8'))
globalThis.fetch = async (url, init = {}) => {
  appendFileSync(process.env.SETUP_LOG, JSON.stringify({ kind: 'fetch', url, method: init.method || 'GET' }) + '\n')
  const parsed = new URL(url)
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
  if (parsed.pathname === '/api/health') return json({ ok: !s.healthFail }, s.healthFail ? 503 : 200)
  if (parsed.pathname === '/api/rooms' && init.method === 'POST') return json({ id: 'setup-room-abcdefghijkl', url: parsed.origin + '/s/setup-room-abcdefghijkl', token: 'test-only-token' })
  if (parsed.pathname.endsWith('/join')) return json({ token: 'test-only-guest' })
  if (parsed.pathname.endsWith('/stream')) return new Response(JSON.stringify({ events: [], people: [{ name: 'setup-guest' }] }) + '\n')
  if (parsed.pathname.endsWith('/events')) return json({ events: [{ type: 'join', from: { role: 'guest', name: 'test guest' } }] })
  if (parsed.pathname === '/api/rooms/live-room-abcdefghijkl') return json({ ended: existsSync(process.env.SETUP_STOPPED) })
  if (parsed.pathname.endsWith('/end') || parsed.pathname.startsWith('/s/')) return json({ ok: true })
  throw new Error('Unexpected intercepted request: ' + url)
}
`

function setup(args, scenario = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-share-setup-test-'))
  try {
    for (const path of ['bin', 'scripts', 'plugin/hooks', 'plugin/.claude-plugin', '.claude']) mkdirSync(join(dir, path), { recursive: true })
    const buildServer = scenario.buildServer || defaultUrl
    writeFileSync(join(dir, 'scripts/setup.mjs'), readFileSync(join(root, 'scripts/setup.mjs')))
    writeFileSync(join(dir, 'plugin/.claude-plugin/plugin.json'), readFileSync(join(root, 'plugin/.claude-plugin/plugin.json')))
    writeFileSync(join(dir, 'plugin/hooks/server.ts'), defaultSource.replace(defaultUrl, buildServer))
    writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ ...scenario, buildServer }))
    writeFileSync(join(dir, 'fetch.mjs'), fakeFetch)
    for (const name of ['claude', 'npx']) {
      writeFileSync(join(dir, 'bin', name), `#!${process.execPath}\n${fakeCli}`)
      chmodSync(join(dir, 'bin', name), 0o755)
    }
    const settingsPath = join(dir, '.claude/settings.json')
    if (scenario.settings) writeFileSync(settingsPath, JSON.stringify(scenario.settings))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLAUDE') && !key.startsWith('SHARED_SESSION') && key !== 'NODE_OPTIONS'))
    Object.assign(env, {
      HOME: dir, PATH: join(dir, 'bin'), CLAUDE_BIN: join(dir, 'bin/claude'), CLAUDE_CONFIG_DIR: join(dir, '.claude'),
      SETUP_SCENARIO: join(dir, 'scenario.json'), SETUP_LOG: join(dir, 'calls.jsonl'), SETUP_STOPPED: join(dir, 'stopped'),
    })
    if (scenario.envServer) env.SHARED_SESSION_SERVER = scenario.envServer
    const result = spawnSync(process.execPath, ['--import', join(dir, 'fetch.mjs'), join(dir, 'scripts/setup.mjs'), ...args], { env, cwd: dir, encoding: 'utf8', timeout: 15_000 })
    assert.ifError(result.error)
    const calls = existsSync(env.SETUP_LOG) ? readFileSync(env.SETUP_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
    return { code: result.status, out: result.stdout + result.stderr, calls, settings: existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : null }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const requests = result => result.calls.filter(c => c.kind === 'fetch')
const commands = result => result.calls.filter(c => c.kind === 'cli').map(c => c.args.join(' '))

test('fresh install checks the public build default and completes live share/join checks', () => {
  const result = setup(['check', '--live'])
  assert.equal(result.code, 0, result.out)
  assert.equal(requests(result)[0].url, defaultUrl + '/api/health')
  assert.match(result.out, /plugin's default server/)
  assert.match(result.out, /a real session shared/)
  assert.match(result.out, /a real session joined/)
  assert(commands(result).some(c => c.includes('/stop-sharing')))
  assert.equal(result.settings, null)
})

test('forks use the server baked into their plugin', () => {
  const result = setup(['check'], { buildServer: 'https://fork.example.invalid' })
  assert.equal(result.code, 0, result.out)
  assert.equal(requests(result)[0].url, 'https://fork.example.invalid/api/health')
})

test('saved server wins over environment and schema URLs', () => {
  const result = setup(['check'], { saved: 'https://saved.example.invalid/', envServer: 'https://env.example.invalid' })
  assert.equal(result.code, 0, result.out)
  assert.equal(requests(result)[0].url, 'https://saved.example.invalid/api/health')
})

test('environment server wins over the build default', () => {
  const result = setup(['check'], { envServer: 'https://env.example.invalid' })
  assert.equal(result.code, 0, result.out)
  assert.equal(requests(result)[0].url, 'https://env.example.invalid/api/health')
})

test('server in Claude settings env is checked without changing those settings', () => {
  const settings = { env: { SHARED_SESSION_SERVER: 'https://settings.example.invalid' } }
  const result = setup(['check', '--live'], { settings })
  assert.equal(result.code, 0, result.out)
  assert.equal(requests(result)[0].url, 'https://settings.example.invalid/api/health')
  assert.deepEqual(result.settings, settings)
  assert.match(result.out, /a real session shared/)
})

test('auto-update folder falls back to the installed copy saved setting', () => {
  const settings = { pluginConfigs: { [pluginId]: { options: { server: 'https://saved.example.invalid' } } }, keep: true }
  const result = setup(['check'], { inline: true, settings })
  assert.equal(result.code, 0, result.out)
  assert.equal(requests(result)[0].url, 'https://saved.example.invalid/api/health')
  assert.deepEqual(result.settings, settings)
})

test('explicit non-live server checks may differ from the saved setting', () => {
  const result = setup(['check', '--server', 'https://other.example.invalid'], { saved: 'https://saved.example.invalid' })
  assert.equal(result.code, 0, result.out)
  assert.equal(requests(result)[0].url, 'https://other.example.invalid/api/health')
})

test('conflicting live server override fails before creating rooms or sessions', () => {
  const result = setup(['check', '--live', '--server', 'https://other.example.invalid'], { saved: 'https://saved.example.invalid' })
  assert.equal(result.code, 1, result.out)
  assert.match(result.out, /saved server setting overrides --server/)
  assert.deepEqual(requests(result), [])
  assert(!commands(result).some(c => c.startsWith('-p ')))
})

test('live override cannot bypass a server in Claude settings env', () => {
  const result = setup(['check', '--live', '--server', 'https://other.example.invalid'], { settings: { env: { SHARED_SESSION_SERVER: 'https://settings.example.invalid' } } })
  assert.equal(result.code, 1, result.out)
  assert.match(result.out, /saved server setting overrides --server/)
  assert.deepEqual(requests(result), [])
})

for (const [name, scenario, message] of [
  ['missing plugin', { missing: true }, /not installed/],
  ['disabled plugin', { disabled: true }, /disabled/],
  ['failed listing', { listFail: true }, /listing plugins/],
  ['malformed listing', { listMalformed: true }, /unexpected response/],
  ['failed config read', { configFail: true }, /reading the share server/],
  ['malformed config read', { configMalformed: true }, /unexpected response/],
  ['invalid saved server', { saved: 'not a server' }, /not a valid/],
]) test(`${name} fails before network and live checks`, () => {
  const result = setup(['check', '--live'], scenario)
  assert.equal(result.code, 1, result.out)
  assert.match(result.out, message)
  assert.deepEqual(requests(result), [])
  assert(!commands(result).some(c => c.startsWith('-p ')))
})

test('invalid explicit server does not silently check the default', () => {
  const result = setup(['check', '--server'])
  assert.equal(result.code, 1, result.out)
  assert.deepEqual(requests(result), [])
})

for (const [name, scenario, message] of [
  ['marketplace update', { marketplaceFail: true }, /FAIL updating the marketplace/],
  ['plugin listing', { listFail: true }, /FAIL listing plugins/],
  ['plugin update', { updateFail: true }, /FAIL updating the plugin/],
  ['plugin install', { missing: true, installFail: true }, /FAIL installing the plugin/],
  ['plugin enable', { disabled: true, enableFail: true }, /FAIL enabling the plugin/],
]) test(`${name} failure cannot report installed or change update settings`, () => {
  const result = setup(['join'], scenario)
  assert.equal(result.code, 1, result.out)
  assert.match(result.out, message)
  assert.doesNotMatch(result.out, /OK plugin installed/)
  assert.equal(result.settings, null)
})

test('installing an existing disabled plugin enables it and preserves other settings', () => {
  const result = setup(['join'], { disabled: true, settings: { env: { KEEP: 'yes' }, unrelated: true } })
  assert.equal(result.code, 0, result.out)
  assert(commands(result).includes(`plugin enable ${pluginId}`))
  assert.equal(result.settings.env.KEEP, 'yes')
  assert.equal(result.settings.unrelated, true)
  assert.equal(result.settings.extraKnownMarketplaces['claude-share'].autoUpdate, true)
})

test('unhealthy host server prevents installation and configuration', () => {
  const result = setup(['host', '--server', 'https://down.example.invalid'], { healthFail: true })
  assert.equal(result.code, 1, result.out)
  assert.match(result.out, /not answering/)
  assert(!commands(result).some(c => c.startsWith('plugin ')))
  assert.equal(result.settings, null)
})

test('failed server configuration stops before update settings or success guidance', () => {
  const result = setup(['host', '--server', 'https://server.example.invalid'], { saveFail: true })
  assert.equal(result.code, 1, result.out)
  assert.match(result.out, /FAIL setting the share server/)
  assert.doesNotMatch(result.out, /new Claude Code sessions load it/)
  assert.equal(result.settings, null)
})

test('failed Cloudflare account check cannot deploy or claim signed in', () => {
  const result = setup(['deploy'], { whoFail: true })
  assert.equal(result.code, 1, result.out)
  assert.match(result.out, /FAIL checking Cloudflare sign-in/)
  assert.doesNotMatch(result.out, /OK signed in/)
  assert(!commands(result).some(c => c.includes(' deploy')))
  assert.deepEqual(requests(result), [])
})
