// The cloud host. Started in a container for one room, it takes that room's
// host over from the person who moved it here (docs/cloud-host.md): it lays
// out the session's project and conversation, saves the room as the plugin's
// own checkpoint (the one a host session takes its room back from after a
// restart), and runs Claude Code headless with this plugin, reading prompts on
// a stdin it keeps open. The plugin does the rest, as on the person's machine.
//
// The room server drives it over the container's own port, never a public
// address, each request carrying the key it was started with (SS_CONTROL_KEY):
//   POST /start    the room, the session and the Claude sign-in (JSON)
//   PUT  /bundle   the packed session (tar.gz: repo/…, transcript.jsonl); it starts
//   POST /stop     stops Claude Code and answers with the project's changes
//                  since the move (a binary git diff), then exits
//   GET  /health   whether Claude Code runs and the plugin has the room
//
// It runs as root only to lay the project out at the path it had on the
// person's machine (so the conversation's paths still hold) and hand it to
// the `runner` user; Claude Code runs as that user. Nothing here logs a token.
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, chmodSync, chownSync, existsSync, createWriteStream, statSync, renameSync, rmSync, readdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'

const PLUGIN = process.env.SS_PLUGIN_DIR ?? '/opt/shared-session/plugin'
const USER = { uid: 1001, gid: 1001, home: '/home/runner' }
const LOG = process.env.SS_LOG ?? '/tmp/claude.log'
const LOG_MAX = 5 * 1024 * 1024
const BUNDLE_MAX = 256 * 1024 * 1024
const CONFIG_MAX = 256 * 1024
const KEY = process.env.SS_CONTROL_KEY ?? ''
const STAGE = process.env.SS_STAGE ?? '/tmp/stage'
if (KEY.length < 32) {
  console.error('runner: SS_CONTROL_KEY must be set (32+ characters)')
  process.exit(2)
}
const say = line => console.log(`runner: ${line}`)

// As root (in the image), the session runs as `runner`; anywhere else (a test
// on someone's machine), as whoever runs this.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
const home = asRoot ? USER.home : (process.env.SS_HOME ?? process.env.HOME)
const configDir = join(home, '.claude')
const asUser = asRoot ? { uid: USER.uid, gid: USER.gid } : {}
const own = path => {
  if (asRoot) chownSync(path, USER.uid, USER.gid)
}
const makeDir = (path, mode = 0o755) => {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode })
  chmodSync(path, mode)
  own(path)
}
const git = (args, opts = {}) =>
  execFileSync('git', ['-c', 'user.name=Shared Sessions', '-c', 'user.email=cloud@shared-sessions.invalid', '-c', 'core.quotepath=off', ...args], {
    cwd: config.cwd,
    env: { PATH: process.env.PATH, HOME: home },
    maxBuffer: BUNDLE_MAX,
    ...asUser,
    ...opts,
  })

let config = null
const status = { stage: 'waiting', claude: 'none', ready: false, started: 0, restarts: 0, exitCode: null }

// What /start may say. Everything else is ignored.
function takeConfig(body) {
  const c = body && typeof body === 'object' ? body : {}
  const text = (v, max = 4096) => (typeof v === 'string' && v.length <= max ? v : null)
  const out = {
    server: text(c.server)?.replace(/\/+$/, ''),
    room: text(c.room, 64),
    token: text(c.token, 256),
    session: text(c.session, 64),
    cwd: text(c.cwd),
    title: text(c.title, 200) ?? 'Shared session',
    host: text(c.host, 80) ?? 'Host',
    url: text(c.url) ?? '',
    seq: Number.isSafeInteger(c.seq) ? c.seq : 0,
    model: text(c.model, 100) ?? '',
    state: c.state && typeof c.state === 'object' ? c.state : {},
    auth: c.auth && typeof c.auth === 'object' ? c.auth : {},
  }
  if (!out.server || !/^https?:\/\//.test(out.server)) return 'server'
  if (!out.room || !/^[A-Za-z0-9_-]{16,64}$/.test(out.room)) return 'room'
  if (!out.token) return 'token'
  if (!out.session || !/^[0-9a-f-]{36}$/.test(out.session)) return 'session'
  if (!out.cwd || !out.cwd.startsWith('/') || out.cwd.split('/').includes('..') || out.cwd.includes('\0')) return 'cwd'
  const { oauthToken, apiKey, baseUrl, authToken } = out.auth
  if (!(text(oauthToken, 512) || text(apiKey, 512) || (text(baseUrl) && text(authToken, 512)))) return 'auth'
  config = out
  return null
}

// The project at the path it had, a git repository whose first commit is
// what was moved, and the conversation where Claude Code keeps it.
function layOut() {
  if (asRoot) {
    // Each level made and handed over, so `runner` can work in the leaf.
    let path = ''
    for (const part of config.cwd.split('/').filter(Boolean)) {
      path += `/${part}`
      if (!existsSync(path)) {
        mkdirSync(path, { mode: 0o755 })
        own(path)
      }
    }
    own(config.cwd)
  } else makeDir(config.cwd)
  const repo = join(STAGE, 'repo')
  if (existsSync(repo)) {
    cpSync(repo, config.cwd, { recursive: true, force: true })
    if (asRoot) execFileSync('chown', ['-R', `${USER.uid}:${USER.gid}`, config.cwd])
  }
  if (!existsSync(join(config.cwd, '.git'))) git(['init', '-q'])
  git(['add', '-A'])
  git(['commit', '-q', '--allow-empty', '--no-verify', '-m', 'As moved to the cloud'])
  status.base = git(['rev-parse', 'HEAD']).toString().trim()
  makeDir(configDir, 0o700)
  const transcript = join(STAGE, 'transcript.jsonl')
  if (existsSync(transcript)) {
    const dir = projectDir()
    makeDir(join(configDir, 'projects'), 0o700)
    makeDir(dir, 0o700)
    const to = join(dir, `${config.session}.jsonl`)
    cpSync(transcript, to)
    chmodSync(to, 0o600)
    own(to)
  }
  rmSync(STAGE, { recursive: true, force: true })
}

// The room, saved where the plugin takes a host's room back from.
function saveCheckpoint() {
  makeDir(configDir, 0o700)
  const dir = join(configDir, 'shared-session')
  makeDir(dir, 0o700)
  const rooms = join(dir, 'rooms')
  makeDir(rooms, 0o700)
  const now = Date.now()
  const s = config.state
  const hosting = {
    at: now,
    room: { server: config.server, id: config.room, url: config.url, title: config.title, host: config.host, token: config.token, seat: 'host', seq: config.seq, since: now },
    policy: s.policy && typeof s.policy === 'object' ? s.policy : { prompts: 'everyone', approvals: 'edits', files: 'on' },
    trusted: Array.isArray(s.trusted) ? s.trusted : [],
    shares: {},
    shown: Array.isArray(s.shown) ? s.shown : [],
    activity: Array.isArray(s.activity) ? s.activity : [],
    chat: Array.isArray(s.chat) ? s.chat : [],
    sidebar: null,
  }
  const file = join(rooms, `${encodeURIComponent(`hosting:${config.session}`)}.json`)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, value: hosting }), { mode: 0o600 })
  own(tmp)
  renameSync(tmp, file)
}

// Claude Code keeps a session's conversation under its folder's name.
const projectDir = () => join(configDir, 'projects', config.cwd.replace(/[^a-zA-Z0-9]/g, '-'))
const hasConversation = () => existsSync(join(projectDir(), `${config.session}.jsonl`))

// What the session sees: Claude Code's own access, never the control key.
function sessionEnv() {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    SHARED_SESSION_NO_BROWSER: '1',
    SHARED_SESSION_RUNNER: '1',
    LANG: 'C.UTF-8',
  }
  const a = config.auth
  if (a.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = a.oauthToken
  else if (a.apiKey) env.ANTHROPIC_API_KEY = a.apiKey
  else {
    env.ANTHROPIC_BASE_URL = a.baseUrl
    env.ANTHROPIC_AUTH_TOKEN = a.authToken
  }
  return env
}

// Claude Code's output, kept to a bounded file for a person looking into it.
function logStream() {
  try {
    if (existsSync(LOG) && statSync(LOG).size > LOG_MAX) renameSync(LOG, `${LOG}.1`)
  } catch {}
  return createWriteStream(LOG, { flags: 'a', mode: 0o600 })
}

let child = null
let stopping = false

function startClaude() {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    ...(hasConversation() ? ['--resume', config.session] : ['--session-id', config.session]),
    '--plugin-dir', PLUGIN,
    '--permission-mode', 'bypassPermissions',
    '--allow-dangerously-skip-permissions',
    ...(config.model ? ['--model', config.model] : []),
  ]
  const out = logStream()
  child = spawn('claude', args, { cwd: config.cwd, env: sessionEnv(), stdio: ['pipe', 'pipe', 'pipe'], ...asUser })
  status.claude = 'running'
  status.started = Date.now()
  let tail = ''
  child.stdout.on('data', chunk => {
    out.write(chunk)
    // The plugin says it has the room once its takeover has read it.
    if (!status.ready) {
      tail = (tail + chunk.toString()).slice(-4096)
      if (/Still sharing this session/.test(tail)) status.ready = true
    }
  })
  child.stderr.pipe(out, { end: false })
  // Its stdin stays open: a headless session lives while it can read.
  child.stdin.on('error', () => {})
  child.on('exit', (code, signal) => {
    status.claude = 'exited'
    status.exitCode = code ?? signal
    status.ready = false
    child = null
    if (stopping) return
    // Back on its feet with the same conversation; slower each time it falls.
    status.restarts += 1
    const wait = Math.min(60_000, 2_000 * 2 ** Math.min(status.restarts, 5))
    say(`Claude Code exited (${status.exitCode}); again in ${wait / 1000} s`)
    setTimeout(startClaude, wait)
  })
}

// The project's changes since the move: everything, as one binary diff.
function changes() {
  if (!config || !status.base) return Buffer.alloc(0)
  git(['add', '-A'])
  return git(['diff', '--cached', '--binary', status.base])
}

async function stopClaude() {
  stopping = true
  if (!child) return
  const gone = new Promise(resolve => child.once('exit', resolve))
  child.kill('SIGTERM')
  await Promise.race([gone, new Promise(r => setTimeout(r, 5_000))])
  child?.kill('SIGKILL')
}

const authorized = req => {
  const given = Buffer.from(String(req.headers.authorization ?? ''))
  const want = Buffer.from(`Bearer ${KEY}`)
  return given.length === want.length && timingSafeEqual(given, want)
}
const reply = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const readAll = (req, max) =>
  new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > max) {
        reject(new Error('too large'))
        req.destroy()
      } else parts.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })

const control = createServer(async (req, res) => {
  if (!authorized(req)) return reply(res, 401, { error: 'unauthorized' })
  try {
    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ...status, base: undefined })
    if (req.method === 'POST' && req.url === '/start') {
      if (status.stage !== 'waiting') return reply(res, 409, { error: 'already started' })
      let body
      try {
        body = JSON.parse((await readAll(req, CONFIG_MAX)).toString())
      } catch {
        return reply(res, 400, { error: 'not JSON' })
      }
      const bad = takeConfig(body)
      if (bad) return reply(res, 400, { error: `bad ${bad}` })
      status.stage = 'configured'
      return reply(res, 200, { ok: true })
    }
    if (req.method === 'PUT' && req.url === '/bundle') {
      if (status.stage !== 'configured') return reply(res, 409, { error: 'not configured' })
      status.stage = 'unpacking'
      rmSync(STAGE, { recursive: true, force: true })
      mkdirSync(STAGE, { recursive: true, mode: 0o700 })
      // Unpacked as it arrives, bounded; members outside the stage are refused by tar.
      await new Promise((resolve, reject) => {
        const tar = spawn('tar', ['-xzf', '-', '--no-same-owner', '--no-same-permissions', '-C', STAGE], { stdio: ['pipe', 'ignore', 'pipe'] })
        let size = 0
        let err = ''
        tar.stderr.on('data', c => { err = (err + c).slice(-2000) })
        req.on('data', c => {
          size += c.length
          if (size > BUNDLE_MAX) {
            tar.kill()
            reject(new Error('the packed session is too large'))
          }
        })
        req.pipe(tar.stdin)
        tar.on('exit', code => (code === 0 ? resolve() : reject(new Error(`tar: ${err.trim().split('\n').pop() ?? code}`))))
      })
      layOut()
      saveCheckpoint()
      startClaude()
      status.stage = 'running'
      return reply(res, 200, { ok: true })
    }
    if (req.method === 'POST' && req.url === '/stop') {
      await stopClaude()
      const diff = status.base ? changes() : Buffer.alloc(0)
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': diff.length })
      res.end(diff)
      status.stage = 'stopped'
      setTimeout(() => process.exit(0), 1_000)
      return
    }
    reply(res, 404, { error: 'not found' })
  } catch (error) {
    status.stage = status.stage === 'unpacking' ? 'failed' : status.stage
    reply(res, 500, { error: String(error?.message ?? error).slice(0, 300) })
  }
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await stopClaude()
    process.exit(0)
  })
}

control.listen(Number(process.env.SS_PORT ?? 8080), () => say('waiting for the room'))
