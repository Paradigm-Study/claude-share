// End-to-end: a real host Claude Code session and real guest sessions, all
// headless (stream-json), talking through a room server: a local one this
// starts, or a deployed one (EXTERNAL_SERVER=1 SHARE_SERVER=https://…). They
// load this repo's plugin with --plugin-dir, which a headless run only does
// with CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 (installed plugins don't need it).
//
//   CLAUDE_BIN=/path/to/claude node test/e2e.mjs
//
// The engine needs model access the usual way (a login, or ANTHROPIC_* env).

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, existsSync, rmSync, writeFileSync, createWriteStream, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude'
const MODEL = process.env.MODEL ?? 'claude-haiku-4-5-20251001'
const WORK = process.env.WORK_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'shared-session-e2e')
const PORT = Number(process.env.E2E_PORT ?? 8787)
// A running server to test against (EXTERNAL_SERVER=1), else a local one this starts.
const SERVER = (process.env.SHARE_SERVER ?? `http://localhost:${PORT}`).replace(/\/+$/, '')

// Model access as the machine's user has it: their settings' env, else ours.
const MODEL_ENV = (() => {
  try {
    return JSON.parse(readFileSync(join(process.env.HOME, '.claude', 'settings.json'), 'utf8')).env ?? {}
  } catch {
    return {}
  }
})()

rmSync(WORK, { recursive: true, force: true })
const hostDir = join(WORK, 'host-repo')
const guestDir = join(WORK, 'guest')
mkdirSync(hostDir, { recursive: true })
mkdirSync(guestDir, { recursive: true })
writeFileSync(join(hostDir, 'README.md'), '# demo repo\n\nThe secret word is "marmalade".\n')

const children = []
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

function startServer() {
  const child = spawn(process.execPath, [join(ROOT, 'server/node.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = createWriteStream(join(WORK, 'server.log'))
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  children.push(child)
}

function session(name, cwd, extraArgs = []) {
  // A home of its own: no installed plugins, settings hooks or transcripts of
  // the machine's user leak into the run (model access comes from the env).
  const home = join(WORK, `${name}-home`)
  mkdirSync(home, { recursive: true })
  const env = {
    HOME: home,
    PATH: process.env.PATH,
    USER: name,
    TERM: 'dumb',
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    SHARED_SESSION_SERVER: SERVER,
    GIT_CONFIG_GLOBAL: join(WORK, `${name}.gitconfig`),
  }
  if (process.env.SHARED_SESSION_TRANSPORT) env.SHARED_SESSION_TRANSPORT = process.env.SHARED_SESSION_TRANSPORT
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    const value = MODEL_ENV[key] ?? process.env[key]
    if (value) env[key] = value
  }
  writeFileSync(env.GIT_CONFIG_GLOBAL, `[user]\n\tname = ${name}\n`)
  const child = spawn(
    CLAUDE,
    [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      MODEL,
      '--plugin-dir',
      join(ROOT, 'plugin'),
      '--debug-file',
      join(WORK, `${name}.debug.log`),
      ...extraArgs,
    ],
    { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  children.push(child)
  const out = createWriteStream(join(WORK, `${name}.stream.jsonl`))
  const s = { name, child, home, lines: [], text: '' }
  let buffer = ''
  child.stdout.on('data', chunk => {
    out.write(chunk)
    buffer += chunk
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      if (!line.trim()) continue
      s.text += `${line}\n`
      try {
        s.lines.push(JSON.parse(line))
      } catch {}
    }
  })
  child.stderr.on('data', chunk => out.write(chunk))
  s.say = content => child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`)
  // As Claude Desktop sends what a person typed (the engine reads it as `composer`).
  s.type = content =>
    child.stdin.write(`${JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content } })}\n`)
  return s
}

async function until(what, fn, ms = 90_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`timed out waiting for: ${what}`)
}

// A first prompt as Claude Desktop sends it: its context block, then what was typed.
function desktopPrompt(text) {
  return [
    { type: 'text', text: '<system-reminder>\nGUEST-ONLY-CONTEXT: /Users/alex/private-project\n</system-reminder>\n\n' },
    { type: 'text', text },
  ]
}

function assistantText(s) {
  return s.lines
    .filter(l => l.type === 'assistant')
    .flatMap(l => (l.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text))
}

function transcriptRows(s) {
  return transcriptOf(s)
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(d => d.type === 'user' || d.type === 'assistant')
    .map(d => {
      const c = d.message?.content
      const text = typeof c === 'string' ? c : (c ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
      return { type: d.type, text }
    })
}

function transcriptOf(s) {
  const id = s.lines.find(l => l.type === 'system' && l.subtype === 'init')?.session_id
  const projects = join(s.home, '.claude', 'projects')
  if (!existsSync(projects)) return ''
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${id}.jsonl`)
    if (existsSync(file)) return readFileSync(file, 'utf8')
  }
  return ''
}

const roomInfo = async id => (await fetch(`${SERVER}/api/rooms/${id}`)).json()

try {
  if (!process.env.EXTERNAL_SERVER) startServer()
  await until('server', async () => (await fetch(`${SERVER}/api/health`).catch(() => null))?.ok)

  // Scott's session: a normal session with some history, then Share.
  const host = session('Scott', hostDir, ['--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions'])
  host.say('Read README.md and tell me the secret word in one word.')
  await until('host first turn', () => host.lines.some(l => l.type === 'result'))
  check('host answers its own first prompt', /marmalade/i.test(host.text))

  host.say('/share-session')
  const linkPattern = new RegExp(`${SERVER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/s/[A-Za-z0-9_-]{16,}`)
  const link = await until('share link', () => linkPattern.exec(host.text)?.[0])
  const id = link.split('/s/')[1]
  check('Share creates a link', true, link)

  const page = await fetch(link)
  const html = await page.text()
  check('link opens a page that hands off to Claude Desktop', page.ok && html.includes('claude://code/new?q='))

  // Alex opens the link: Claude Desktop starts a session with it in the
  // prompt box and, as it does for a first prompt, adds its own context block.
  const guest = session('Alex', guestDir)
  guest.type(desktopPrompt(link))
  const joined = await until('guest joined', async () => {
    const info = await roomInfo(id)
    return info.people?.some(p => p.name === 'Alex') && info
  })
  check('pasting the link joins', Boolean(joined), joined.people.map(p => `${p.name}:${p.role}`).join(', '))
  // Sam joins too, from a third session.
  mkdirSync(join(WORK, 'sam'), { recursive: true })
  const sam = session('Sam', join(WORK, 'sam'))
  sam.say(link)
  await until('Sam joined', async () => (await roomInfo(id)).people?.some(p => p.name === 'Sam'))
  await until('history shown to guest', () => /marmalade/i.test(guest.text), 30_000)
  check('guest sees what happened before Share', /marmalade/i.test(guest.text))

  // Alex talks to the shared session.
  const before = host.lines.length
  guest.type(desktopPrompt('What is 17 times 3? Reply with just the number.'))
  await until('host ran guest prompt', () => host.lines.slice(before).some(l => l.type === 'result' && /\b51\b/.test(l.result ?? '')))
  check('guest prompt runs in the host session', true)
  const hostTranscript = transcriptOf(host)
  check('host sees the prompt as Alex\'s', hostTranscript.includes('Alex: What is 17 times 3'))
  check('the host never sees context from Alex\'s app', !hostTranscript.includes('GUEST-ONLY-CONTEXT'))
  await until('answer streamed into the guest', () => assistantText(guest).some(t => /\b51\b/.test(t)), 30_000)
  check('guest sees the answer as a normal reply', true)

  // The host's own prompts play out in the guest too.
  host.say('Say the word "pineapple" and nothing else.')
  await until('host prompt shown in guest', () => assistantText(guest).some(t => /pineapple/i.test(t)), 60_000)
  check('guest sees Scott\'s prompt', transcriptOf(guest).includes('Scott: Say the word'))
  check('guest sees Scott\'s reply', assistantText(guest).some(t => /pineapple/i.test(t)))
  check(
    'guest never calls a model of its own',
    guest.lines.filter(l => l.type === 'result').every(l => !(l.total_cost_usd > 0)),
    guest.lines.filter(l => l.type === 'result').map(l => l.total_cost_usd).join(','),
  )

  await until('Sam sees Alex\'s exchange', () => transcriptOf(sam).includes('Alex: What is 17 times 3') && assistantText(sam).some(t => /\b51\b/.test(t)), 30_000).catch(() => null)
  check('a third person sees Alex\'s prompt and the answer', transcriptOf(sam).includes('Alex: What is 17 times 3') && assistantText(sam).some(t => /\b51\b/.test(t)))

  // Alex types while Scott's turn is running: both play out, in order.
  host.say('Count from 1 to 40, one number per line, nothing else.')
  await until('host busy', async () => assistantText(guest).some(t => /\b12\b/.test(t)) || host.text.includes('"12'), 30_000).catch(() => null)
  guest.type('Say the word "kiwi" and nothing else.')
  await until('kiwi shown', () => assistantText(guest).some(t => /kiwi/i.test(t)), 90_000)
  await until('transcript written', () => transcriptRows(guest).some(r => r.type === 'assistant' && /kiwi/i.test(r.text)), 10_000).catch(() => null)
  const shown = transcriptRows(guest).filter(r => r.type === 'assistant').map(r => r.text).join('\n')
  const countAt = shown.search(/\b40\b/)
  const kiwiAt = shown.search(/kiwi/i)
  check('a prompt typed while the host is busy runs after, in order', countAt >= 0 && kiwiAt > countAt, `count at ${countAt}, kiwi at ${kiwiAt}`)

  // Esc in Alex's session stops the shared turn.
  await until('host idle', () => host.lines.at(-1)?.type === 'result', 30_000).catch(() => null)
  await new Promise(r => setTimeout(r, 1500))
  const resultsBefore = host.lines.filter(l => l.type === 'result').length
  guest.say('Write a 1500-word story about a lighthouse keeper.')
  // Interrupt a few seconds into the host's turn (stream-json only shows whole blocks).
  await until('story turn started on host', () => existsSync(join(WORK, 'Scott.debug.log')) && readFileSync(join(WORK, 'Scott.debug.log'), 'utf8').split('Alex: Write a 1500-word story').length > 1, 30_000).catch(() => null)
  await new Promise(r => setTimeout(r, 4000))
  guest.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'esc-1', request: { subtype: 'interrupt' } })}\n`)
  const t0 = Date.now()
  await until('host turn stopped', () => host.lines.filter(l => l.type === 'result').length > resultsBefore, 90_000)
  const stoppedAfter = Date.now() - t0
  const story = assistantText(host).at(-1) ?? ''
  const words = story.split(/\s+/).length
  check('Esc in a guest stops the host turn', stoppedAfter < 15_000 && words < 1200, `${words} words, stopped ${stoppedAfter}ms after Esc`)

  // A guest asking for a write is gated even in bypass mode (nobody can approve headless).
  guest.say('Use the Write tool to create a file named pwned.txt containing "hi". Do not use Bash.')
  await until(
    'write attempt settled',
    () => host.lines.filter(l => l.type === 'result').length >= 8,
    90_000,
  )
  await new Promise(r => setTimeout(r, 1500))
  check('a guest cannot write on the host without approval', !existsSync(join(hostDir, 'pwned.txt')))

  // What the host shows reaches guests: a file, saved in the guest's project.
  writeFileSync(join(hostDir, 'report.html'), '<h1>Report 42</h1>\n')
  host.say('/share-file report.html')
  const saved = join(guestDir, '.shared-session', 'Scott', 'report.html')
  await until('guest saved the shared file', () => existsSync(saved), 60_000).catch(() => null)
  check("a file the host shares lands in the guest's project", existsSync(saved) && readFileSync(saved, 'utf8') === '<h1>Report 42</h1>\n')

  // A preview of the host's localhost: a stand-in dev app, opened through the
  // one-time link the guest is given, root-relative paths and all.
  const app = createServer((req, res) => {
    if (req.url === '/assets/app.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end('console.log("app")')
    if (req.url === '/redirect') return res.writeHead(302, { location: `http://localhost:${app.address().port}/` }).end()
    if (req.url === '/echo' && req.method === 'POST') {
      let body = ''
      req.on('data', c => (body += c))
      return req.on('end', () => res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'app=1; Path=/' }).end(`echo:${body}`))
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><script src="/assets/app.js"></script><h1>dev server ok</h1>')
  })
  await new Promise(r => app.listen(0, '127.0.0.1', r))
  children.push({ kill: () => app.close() })
  host.say(`/share-preview ${app.address().port} Dev app`)
  const enter = await until('guest got a preview link', () => /https?:\/\/[^\s)`'"]+\/__share\/enter\?room=[\w-]+&ticket=[\w-]+/.exec(guest.text)?.[0], 60_000).catch(() => null)
  let previewed = false
  let cookie = ''
  let origin = ''
  if (enter) {
    origin = new URL(enter).origin
    const opened = await fetch(enter, { redirect: 'manual' })
    cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0]
    const page = await fetch(`${origin}/`, { headers: { cookie } }).then(r => r.text())
    const asset = await fetch(`${origin}/assets/app.js`, { headers: { cookie } })
    const echo = await fetch(`${origin}/echo`, { method: 'POST', body: 'ping', headers: { cookie } })
    const echoed = await echo.text()
    const moved = await fetch(`${origin}/redirect`, { headers: { cookie }, redirect: 'manual' })
    const again = await fetch(enter, { redirect: 'manual' })
    previewed =
      opened.status === 302 &&
      page.includes('dev server ok') &&
      asset.ok &&
      (asset.headers.get('content-type') ?? '').includes('javascript') &&
      echoed === 'echo:ping' &&
      (echo.headers.get('set-cookie') ?? '').includes('app=1') &&
      moved.status === 302 &&
      moved.headers.get('location') === '/' &&
      again.status === 403
  }
  check("a teammate opens the host's localhost through a preview", previewed, enter ?? 'no link')

  // How everyone heard the room: one open stream each, or polls when asked to.
  const polling = process.env.SHARED_SESSION_TRANSPORT === 'poll'
  const heard = ['Scott', 'Alex', 'Sam'].map(n => readFileSync(join(WORK, `${n}.debug.log`), 'utf8'))
  check(
    polling ? 'everyone polls when told to' : 'everyone hears the room over one open stream',
    heard.every(log => log.includes(polling ? 'Shared session: polling' : 'Shared session: listening on a stream')),
  )

  // Stop sharing: the guest is told, the link stops working.
  host.say('/stop-sharing')
  await until('guest told sharing ended', () => /stopped sharing|no longer shared/i.test(guest.text), 30_000)
  check('guest is told when sharing stops', true)
  const after = await roomInfo(id)
  check('the room is ended on the server', after.ended === true)
  if (origin) {
    const gone = await fetch(`${origin}/`, { headers: { cookie } })
    check('previews end with the room', gone.status === 404)
  }
} catch (error) {
  check('run', false, String(error?.message ?? error))
} finally {
  for (const child of children) child.kill('SIGTERM')
  const failed = results.filter(r => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed · logs in ${WORK}`)
  process.exit(failed ? 1 : 0)
}
