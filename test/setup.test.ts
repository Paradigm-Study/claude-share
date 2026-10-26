// Installer regressions with a fake CLI, isolated HOME and intercepted fetch.
// No real Claude settings, model calls, remote rooms or deployments are used.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pluginId = 'shared-session@claude-share'
const defaultSource = readFileSync(join(root, 'plugin/hooks/server.ts'), 'utf8')
const defaultUrl = /export const SERVER_URL = ['"]([^'"]*)['"]/.exec(defaultSource)![1]

const fakeCli = String.raw`
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const s = JSON.parse(readFileSync(process.env.SETUP_SCENARIO, 'utf8'))
const args = process.argv.slice(2)
appendFileSync(process.env.SETUP_LOG, JSON.stringify({ kind: 'cli', args, serverEnv: process.env.SHARED_SESSION_SERVER, place: process.env.CLAUDE_CODE_HOST_SESSION_ID }) + '\n')
const finish = (code, value) => { console.log(typeof value === 'string' ? value : JSON.stringify(value)); process.exit(code) }
const command = args.join(' ')
// pathVersion: the terminal's claude is that old, the one CLAUDE_BIN names (desk/claude) new enough.
if (command === '--version') finish(0, (s.pathVersion && !process.argv[1].endsWith('/desk/claude') ? s.pathVersion : '2.1.295') + ' (Claude Code)')
// account: the Cloudflare account wrangler is signed in to, as its table shows it.
if (command.includes('whoami')) finish(s.whoFail ? 1 : 0, s.whoFail ? 'network unavailable' : s.account ? '│ Account Name │ Account ID │\n│ Team │ ' + s.account + ' │' : 'signed in')
// docker: Docker with buildx is here.
if (command === 'buildx version') finish(s.docker ? 0 : 1, s.docker ? 'github.com/docker/buildx v0.38.0' : 'docker: unknown command: buildx')
if (command === '-y wrangler@4 deploy -c wrangler.selfhost.toml') finish(0, 'Deployed claude-share\n  https://claude-share.team.workers.dev')
// deployed: the main Worker is there already (an update); previewFail: the preview Worker's deploy fails
// ('late': after printing its workers.dev address); previewCustom: it deploys to a custom domain, printing none.
if (command === '-y wrangler@4 deployments list') finish(s.deployed ? 0 : 1, s.deployed ? 'Created: 2026-10-01T00:00:00Z' : 'This Worker does not exist on your account. [code: 10007]')
if (command === '-y wrangler@4 deploy -c wrangler.preview.toml') {
  if (s.previewCustom) finish(0, 'Uploaded claude-share-preview (1.10 sec)\nDeployed claude-share-preview triggers (0.42 sec)\n  previews.example.dev (custom domain)\nCurrent Version ID: 0f1e2d3c-0000-4000-8000-000000000000')
  if (s.previewFail === 'late') finish(1, 'Deployed claude-share-preview triggers (0.42 sec)\n  https://claude-share-preview.team.workers.dev\nA request to the Cloudflare API failed.')
  finish(s.previewFail ? 1 : 0, s.previewFail ? 'A request to the Cloudflare API failed.' : 'Deployed claude-share-preview\n  https://claude-share-preview.team.workers.dev')
}
if (command === '-y wrangler@4 deploy') finish(0, 'Deployed claude-share\n  https://claude-share.team.workers.dev')
if (command.startsWith('plugin marketplace add ')) finish(0, 'added')
if (command === 'plugin marketplace update claude-share') finish(s.marketplaceFail ? 1 : 0, s.marketplaceFail ? 'marketplace unavailable' : 'updated')
if (command === 'plugin list --json') {
  if (s.listFail) finish(1, 'listing unavailable')
  if (s.listMalformed) finish(0, 'not JSON')
  const plugins = s.missing ? [] : [{ id: 'shared-session@claude-share', version: '0.11.19', enabled: !s.disabled }]
  // inline: the automatic-update folder ('linked': reached through a link to
  // HOME); 'folder': a checkout of the plugin elsewhere; 'unsaid': a CLI that
  // gives no installPath.
  const where = { folder: '/src/claude-share/plugin', linked: '/../linked-home/.claude/shared-session/plugin/' }[s.inline] ?? '/.claude/shared-session/plugin'
  if (s.inline) plugins.push({ id: 'shared-session@inline', enabled: true, ...(s.inline === 'unsaid' ? {} : { installPath: process.env.HOME + where }) })
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
  // A session's transcript, where Claude Code keeps it: its folder's projects, by the session's folder.
  const project = (process.env.CLAUDE_CONFIG_DIR || process.env.HOME + '/.claude') + '/projects/' + process.cwd().replace(/[^A-Za-z0-9]/g, '-')
  mkdirSync(project, { recursive: true })
  writeFileSync(project + '/session.jsonl', '{}\n')
  appendFileSync(process.env.SETUP_LOG, JSON.stringify({ kind: 'transcript', path: project }) + '\n')
  // strayServer: the session shares somewhere other than the server checked, and
  // keeps its rooms as the plugin does (hosting:<session>, joined:<session>).
  const session = args[args.indexOf('--session-id') + 1]
  const keep = (prefix, room) => {
    const dir = (process.env.CLAUDE_CONFIG_DIR || process.env.HOME + '/.claude') + '/shared-session/rooms'
    mkdirSync(dir, { recursive: true })
    writeFileSync(dir + '/' + encodeURIComponent(prefix + session) + '.json', JSON.stringify({ version: 1, value: { at: 1, room } }))
  }
  if (s.strayServer && args.at(-1) === '/share-session') {
    keep('hosting:', { server: s.strayServer, id: 'stray-room-abcdefghijkl', url: s.strayServer + '/s/stray-room-abcdefghijkl', token: 'stray-token', seat: 'host' })
    finish(0, s.strayServer + '/s/stray-room-abcdefghijkl')
  }
  if (s.strayServer && args.includes('--session-id') && /\/s\//.test(args.at(-1))) keep('joined:', { server: 'x', id: 'y', token: 'guest-token', seat: 'g' })
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
  // strayEnded: the stray room ended already.
  if (s.strayEnded && parsed.pathname === '/api/rooms/stray-room-abcdefghijkl/end') return json({ error: 'This shared session has ended.' }, 410)
  if (parsed.pathname.endsWith('/end') || parsed.pathname.startsWith('/s/')) return json({ ok: true })
  throw new Error('Unexpected intercepted request: ' + url)
}
`

// What a scenario makes the fake CLI and the fake network do; the fakes'
// comments above say what each flag means.
type Scenario = {
  buildServer?: string, saved?: string, envServer?: string, configDir?: string, pathVersion?: string, place?: string, withToml?: boolean,
  settings?: Record<string, unknown>, rawSettings?: string, homeSettings?: Record<string, unknown>,
  [flag: string]: unknown,
}
// One line of the log the fakes write.
type Call = { kind: 'cli' | 'fetch' | 'transcript', args: string[], url: string, method: string, serverEnv?: string, place?: string, path?: string }
type Result = ReturnType<typeof setup>

function setup(args: string[], scenario: Scenario = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-share-setup-test-'))
  try {
    for (const path of ['bin', 'desk', 'scripts', 'plugin/hooks', 'plugin/.claude-plugin', '.claude']) mkdirSync(join(dir, path), { recursive: true })
    const buildServer = scenario.buildServer || defaultUrl
    writeFileSync(join(dir, 'scripts/setup.mjs'), readFileSync(join(root, 'scripts/setup.mjs')))
    writeFileSync(join(dir, 'plugin/.claude-plugin/plugin.json'), readFileSync(join(root, 'plugin/.claude-plugin/plugin.json')))
    writeFileSync(join(dir, 'plugin/hooks/server.ts'), defaultSource.replace(defaultUrl, buildServer))
    writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ ...scenario, buildServer }))
    writeFileSync(join(dir, 'fetch.mjs'), fakeFetch)
    // withToml: the repository's wrangler.toml, which names the cloud host's prebuilt image.
    if (scenario.withToml) writeFileSync(join(dir, 'wrangler.toml'), readFileSync(join(root, 'wrangler.toml')))
    for (const name of ['bin/claude', 'bin/npx', 'desk/claude', 'bin/docker']) {
      writeFileSync(join(dir, name), `#!${process.execPath}\n${fakeCli}`)
      chmodSync(join(dir, name), 0o755)
    }
    // Claude Code's folder: ~/.claude (CLAUDE_CONFIG_DIR unset), or the scenario's
    // configDir as CLAUDE_CONFIG_DIR, with ~/.claude beside it (homeSettings) a decoy.
    const configDir = join(dir, scenario.configDir ?? '.claude'), homeDir = join(dir, '.claude')
    mkdirSync(configDir, { recursive: true })
    const settingsPath = join(configDir, 'settings.json'), homeSettingsPath = join(homeDir, 'settings.json')
    if (scenario.settings) writeFileSync(settingsPath, JSON.stringify(scenario.settings))
    if (scenario.rawSettings) writeFileSync(settingsPath, scenario.rawSettings)
    if (scenario.homeSettings) writeFileSync(homeSettingsPath, JSON.stringify(scenario.homeSettings))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLAUDE') && !key.startsWith('SHARED_SESSION') && key !== 'NODE_OPTIONS') as [string, string][])
    Object.assign(env, {
      HOME: dir, PATH: join(dir, 'bin'), CLAUDE_BIN: join(dir, scenario.pathVersion ? 'desk/claude' : 'bin/claude'),
      SETUP_SCENARIO: join(dir, 'scenario.json'), SETUP_LOG: join(dir, 'calls.jsonl'), SETUP_STOPPED: join(dir, 'stopped'),
    })
    if (scenario.configDir) env.CLAUDE_CONFIG_DIR = configDir
    if (scenario.envServer) env.SHARED_SESSION_SERVER = scenario.envServer
    // place: run from a Claude Desktop session, as an agent there runs it.
    if (scenario.place) env.CLAUDE_CODE_HOST_SESSION_ID = scenario.place
    // A cast: the Worker's types (server/worker-configuration.d.ts) say process.env holds its vars.
    const result = spawnSync(process.execPath, ['--import', join(dir, 'fetch.mjs'), join(dir, 'scripts/setup.mjs'), ...args], { env: env as NodeJS.ProcessEnv, cwd: dir, encoding: 'utf8', timeout: 15_000 })
    assert.ifError(result.error)
    const calls = existsSync(env.SETUP_LOG) ? readFileSync(env.SETUP_LOG, 'utf8').trim().split('\n').map((line): Call => JSON.parse(line)) : []
    const read = (path: string) => {
      if (!existsSync(path)) return null
      const text = readFileSync(path, 'utf8')
      try { return JSON.parse(text) } catch { return text }
    }
    const list = (path: string) => existsSync(path) ? readdirSync(path) : []
    return {
      code: result.status, out: result.stdout + result.stderr, calls, configDir, selfhost: read(join(dir, 'wrangler.selfhost.toml')),
      settings: read(settingsPath), homeSettings: read(homeSettingsPath), projects: list(join(configDir, 'projects')), rooms: list(join(configDir, 'shared-session/rooms')),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const requests = (result: Result) => result.calls.filter(c => c.kind === 'fetch')
const commands = (result: Result) => result.calls.filter(c => c.kind === 'cli').map(c => c.args.join(' '))

test('fresh install checks the public build default and completes live share/join checks', () => {
  const result = setup(['check', '--live'])
  assert.equal(result.code, 0, result.out)
  assert.equal(requests(result)[0].url, defaultUrl + '/api/health')
  assert.match(result.out, /plugin's default server/)
  assert.match(result.out, /a real session shared/)
  assert.match(result.out, /a real session joined/)
  assert(commands(result).some(c => c.includes('/stop-sharing')))
  assert.equal(result.settings, null)
  assert(result.calls.some(c => c.kind === 'transcript'))
  assert.deepEqual(result.projects, [], 'the throwaway sessions\' transcripts are removed from ~/.claude')
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

test("a plugin folder elsewhere has its own option alone, as the plugin's serverOf reads it", () => {
  const settings = { pluginConfigs: { [pluginId]: { options: { server: 'https://saved.example.invalid' } } } }
  const plain = setup(['check'], { inline: 'folder', settings })
  assert.equal(plain.code, 0, plain.out)
  assert.equal(requests(plain)[0].url, defaultUrl + '/api/health')
  assert.match(plain.out, /NOTE sessions load the plugin from .*\/src\/claude-share\/plugin/)
  // The installed copy's saved setting doesn't reach a session there, so it doesn't refuse --server.
  const live = setup(['check', '--server', 'https://other.example.invalid', '--live'], { inline: 'folder', settings })
  assert.equal(live.code, 0, live.out)
  assert.equal(requests(live)[0].url, 'https://other.example.invalid/api/health')
  assert.match(live.out, /a real session shared/)
  assert.deepEqual(live.settings, settings)
})

test("a live check ends a room its session left open elsewhere, and removes its sessions' checkpoints", () => {
  const result = setup(['check', '--live'], { strayServer: 'https://stray.example.invalid' })
  assert.equal(result.code, 1, result.out)
  assert.match(result.out, /FAIL a real session could not share/)
  assert.match(result.out, /NOTE ended the room the check's session left open on https:\/\/stray\.example\.invalid/)
  assert(requests(result).some(r => r.url === 'https://stray.example.invalid/api/rooms/stray-room-abcdefghijkl/end' && r.method === 'POST'), JSON.stringify(requests(result)))
  assert.deepEqual(result.rooms, [], 'no checkpoint is left behind')
})

test('the automatic-update folder is told by its path, as the plugin tells it, and a CLI that gives no path falls back as before', () => {
  const settings = { pluginConfigs: { [pluginId]: { options: { server: 'https://saved.example.invalid' } } } }
  for (const inline of ['linked', 'unsaid']) {
    const result = setup(['check'], { inline, settings })
    assert.equal(result.code, 0, result.out)
    assert.equal(requests(result)[0].url, 'https://saved.example.invalid/api/health', inline)
    assert.doesNotMatch(result.out, /NOTE sessions load the plugin from/, inline)
  }
})

test("a live check's sessions are never the Claude Desktop session it runs in", () => {
  const result = setup(['check', '--live'], { place: 'local_0123abcd-0000-4000-8000-000000000000' })
  assert.equal(result.code, 0, result.out)
  const sessions = result.calls.filter(c => c.kind === 'cli' && c.args[0] === '-p')
  assert.equal(sessions.length, 3, JSON.stringify(sessions))
  assert(sessions.every(c => c.place === undefined), JSON.stringify(sessions))
})

test("a live check's leftover room that ended already is no failure; one on plain http is never sent its token", () => {
  const ended = setup(['check', '--live'], { strayServer: 'https://stray.example.invalid', strayEnded: true })
  assert.doesNotMatch(ended.out, /left a room open/, ended.out)
  assert.deepEqual(ended.rooms, [])
  const plain = setup(['check', '--live'], { strayServer: 'http://stray.example.invalid' })
  assert.match(plain.out, /FAIL the check's session left a room open on http:\/\/stray\.example\.invalid, not https/)
  assert(!requests(plain).some(r => r.url.startsWith('http://stray.example.invalid')), JSON.stringify(requests(plain)))
  assert.deepEqual(plain.rooms, [])
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
] as [string, Scenario, RegExp][]) test(`${name} fails before network and live checks`, () => {
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
] as [string, Scenario, RegExp][]) test(`${name} failure cannot report installed or change update settings`, () => {
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

// Claude Code reads its settings from CLAUDE_CONFIG_DIR when that's set, and
// keeps its transcripts there: setup's reads and writes go there too, and
// ~/.claude beside it (a decoy here) is left as it is.
test('updates are turned on in CLAUDE_CONFIG_DIR, never in ~/.claude', () => {
  const result = setup(['join'], { configDir: 'cfg', settings: { keep: true } })
  assert.equal(result.code, 0, result.out)
  assert.equal(result.settings.extraKnownMarketplaces['claude-share'].autoUpdate, true)
  assert.equal(result.settings.keep, true)
  assert.equal(result.homeSettings, null)
})

test('function hooks for a 2.1.285 terminal claude are set in CLAUDE_CONFIG_DIR', () => {
  const result = setup(['join'], { configDir: 'cfg', pathVersion: '2.1.285' })
  assert.equal(result.code, 0, result.out)
  assert.equal(result.settings.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, '1')
  assert(result.out.includes(`in ${join(result.configDir, 'settings.json')}`), result.out)
  assert.equal(result.homeSettings, null)
})

test('the saved server is read from CLAUDE_CONFIG_DIR, never ~/.claude', () => {
  const env = setup(['check'], { configDir: 'cfg', settings: { env: { SHARED_SESSION_SERVER: 'https://config.example.invalid' } }, homeSettings: { env: { SHARED_SESSION_SERVER: 'https://home.example.invalid' } } })
  assert.equal(env.code, 0, env.out)
  assert.equal(requests(env)[0].url, 'https://config.example.invalid/api/health')
  const saved = (server: string) => ({ pluginConfigs: { [pluginId]: { options: { server } } } })
  const inline = setup(['check'], { configDir: 'cfg', inline: true, settings: saved('https://config.example.invalid'), homeSettings: saved('https://home.example.invalid') })
  assert.equal(inline.code, 0, inline.out)
  assert.equal(requests(inline)[0].url, 'https://config.example.invalid/api/health')
  const unreadable = setup(['check'], { configDir: 'cfg', rawSettings: '{not json' })
  assert.equal(unreadable.code, 1, unreadable.out)
  assert(unreadable.out.includes(`could not read the saved server settings from ${join(unreadable.configDir, 'settings.json')}`), unreadable.out)
})

test('a live check removes its throwaway sessions from CLAUDE_CONFIG_DIR', () => {
  const result = setup(['check', '--live'], { configDir: 'cfg' })
  assert.equal(result.code, 0, result.out)
  const written = result.calls.filter(c => c.kind === 'transcript')
  assert(written.length && written.every(c => c.path?.startsWith(join(result.configDir, 'projects'))), JSON.stringify(written))
  assert.deepEqual(result.projects, [])
  assert.equal(result.homeSettings, null)
})

test('a plain http server elsewhere is refused before anything is installed; one on this computer is a server like any', () => {
  const result = setup(['host', '--server', 'http://share.example.invalid'])
  assert.equal(result.code, 1, result.out)
  assert.match(result.out, /FAIL host needs --server <https:\/\/your-share-server> \(plain http:\/\/ only for a server on this computer\)/)
  assert(!commands(result).some(c => c.startsWith('plugin ')))
  assert.equal(result.settings, null)
  const local = setup(['host', '--server', 'http://127.0.0.1:8787'], { healthFail: true })
  assert.match(local.out, /not answering/, 'looked at as a server, not refused for its scheme')
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

// An update deploys the preview Worker first: the new rooms' preview links name
// a key only the new preview Worker routes, and it still routes what the old
// rooms made. The first deploy goes the other way: the preview Worker's binding
// needs the main Worker's rooms.
const wrangler = (result: Result) => commands(result).filter(c => c.startsWith('-y wrangler@4 deploy'))
const MAIN = '-y wrangler@4 deploy', PREVIEW = '-y wrangler@4 deploy -c wrangler.preview.toml', PROBE = '-y wrangler@4 deployments list'

test('an update deploys the preview Worker before the main one', () => {
  const result = setup(['deploy'], { deployed: true, missing: true })
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(wrangler(result), [PROBE, PREVIEW, MAIN])
  const [preview, main] = ['OK previews deployed to https://claude-share-preview.team.workers.dev', 'OK deployed to https://claude-share.team.workers.dev'].map(line => result.out.indexOf(line))
  assert(preview >= 0 && preview < main, result.out)
  assert(commands(result).includes(`plugin install ${pluginId} --config server=https://claude-share.team.workers.dev`))
})

// The cloud host's image is kept in this project's Cloudflare account
// (scripts/push-image.mjs): deploying there needs no Docker; another account
// builds it from cloud/Dockerfile, which does.
const IMAGE_ACCOUNT = /registry\.cloudflare\.com\/([0-9a-f]{32})\//.exec(readFileSync(join(root, 'wrangler.toml'), 'utf8'))![1]

test("deploying to the account that keeps the cloud host's image needs no Docker", () => {
  const result = setup(['deploy'], { deployed: true, missing: true, withToml: true, account: IMAGE_ACCOUNT })
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(wrangler(result), [PROBE, PREVIEW, MAIN])
  assert(!commands(result).includes('buildx version'), result.out)
  assert.equal(result.selfhost, null)
})

test("another account builds the cloud host's image from cloud/Dockerfile", () => {
  const result = setup(['deploy'], { deployed: true, missing: true, withToml: true, account: 'f'.repeat(32), docker: true })
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(wrangler(result), [PROBE, PREVIEW, '-y wrangler@4 deploy -c wrangler.selfhost.toml'])
  assert.match(result.selfhost, /^image = "\.\/cloud\/Dockerfile"$/m)
  assert.match(result.selfhost, /^image_build_context = "\."$/m)
  assert.doesNotMatch(result.selfhost, /registry\.cloudflare\.com/)
  assert.match(result.out, /NOTE the cloud host's image is built here/)
})

test('another account without Docker is told to start it, and nothing deploys', () => {
  const result = setup(['deploy'], { deployed: true, missing: true, withToml: true, account: 'f'.repeat(32) })
  assert.equal(result.code, 2, result.out)
  assert.match(result.out, /NEEDS HUMAN This Cloudflare account builds the cloud host's image from cloud\/Dockerfile/)
  assert.deepEqual(wrangler(result), [])
})

test('a first deploy deploys the main Worker before the preview one', () => {
  const result = setup(['deploy'], { missing: true })
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(wrangler(result), [PROBE, MAIN, PREVIEW])
  assert.match(result.out, /OK previews deployed to https:\/\/claude-share-preview\.team\.workers\.dev/)
})

// Whether the preview Worker deployed is wrangler's exit status, never whether
// it printed a workers.dev address: on a custom domain it prints none.
test('an update whose preview Worker is on a custom domain goes on to the main one', () => {
  const result = setup(['deploy'], { deployed: true, previewCustom: true, missing: true })
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(wrangler(result), [PROBE, PREVIEW, MAIN])
  const [preview, main] = [/^OK previews deployed$/m, /^OK deployed to https:\/\/claude-share\.team\.workers\.dev$/m].map(line => result.out.search(line))
  assert(preview >= 0 && preview < main, result.out)
  assert.doesNotMatch(result.out, /FAIL|NOTE previews/)
  assert(commands(result).includes(`plugin install ${pluginId} --config server=https://claude-share.team.workers.dev`))
})

test('a first deploy whose preview Worker is on a custom domain says it deployed', () => {
  const result = setup(['deploy'], { previewCustom: true, missing: true })
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(wrangler(result), [PROBE, MAIN, PREVIEW])
  assert.match(result.out, /^OK previews deployed$/m)
  assert.doesNotMatch(result.out, /NOTE previews didn't deploy/)
})

for (const [name, previewFail] of [['fails to deploy', true], ['fails after printing its address', 'late']]) test(`an update whose preview Worker ${name} changes nothing else`, () => {
  const result = setup(['deploy'], { deployed: true, previewFail, missing: true })
  assert.equal(result.code, 1, result.out)
  assert.match(result.out, /FAIL the preview Worker didn't deploy \((.* \| )?A request to the Cloudflare API failed\.\), so nothing was updated/)
  assert.deepEqual(wrangler(result), [PROBE, PREVIEW])
  assert.doesNotMatch(result.out, /OK deployed to|OK previews deployed/)
  assert(!commands(result).some(c => c.startsWith('plugin ')))
  assert.deepEqual(requests(result), [])
})

test('a first deploy whose preview Worker fails still shares, with a note', () => {
  const result = setup(['deploy'], { previewFail: true, missing: true })
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(wrangler(result), [PROBE, MAIN, PREVIEW])
  assert.match(result.out, /OK deployed to https:\/\/claude-share\.team\.workers\.dev/)
  assert.match(result.out, /NOTE previews didn't deploy \(A request to the Cloudflare API failed\.\); sharing works/)
  assert(commands(result).includes(`plugin install ${pluginId} --config server=https://claude-share.team.workers.dev`))
})
