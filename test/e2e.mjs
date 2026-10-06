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
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createHash, randomBytes } from 'node:crypto'
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
// A 16×16 red PNG: what the host's Claude reads in the picture check.
const SWATCH_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII='

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

function session(name, cwd, extraArgs = [], logName = name, extraEnv = {}) {
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
  Object.assign(env, extraEnv)
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
      join(WORK, `${logName}.debug.log`),
      ...extraArgs,
    ],
    { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  children.push(child)
  const out = createWriteStream(join(WORK, `${logName}.stream.jsonl`))
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

// The least WebSocket for the checks: an echo on the stand-in dev app, and a
// client that sends one text message and reads one back.
function wsFrame(op, payload, masked) {
  const len = payload.length
  const head = len < 126 ? Buffer.from([0x80 | op, (masked ? 0x80 : 0) | len]) : Buffer.from([0x80 | op, (masked ? 0x80 : 0) | 126, len >> 8, len & 255])
  if (!masked) return Buffer.concat([head, payload])
  const mask = randomBytes(4)
  const body = Buffer.from(payload).map((b, i) => b ^ mask[i & 3])
  return Buffer.concat([head, mask, body])
}
function wsReadText(buf) {
  if (buf.length < 2) return null
  let len = buf[1] & 0x7f
  let at = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    at = 4
  }
  const masked = buf[1] & 0x80
  const mask = masked ? buf.subarray(at, at + 4) : null
  if (masked) at += 4
  if (buf.length < at + len) return null
  const body = Buffer.from(buf.subarray(at, at + len)).map((b, i) => (mask ? b ^ mask[i & 3] : b))
  return { op: buf[0] & 0x0f, text: body.toString('utf8') }
}
function wsEchoServer(req, socket) {
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`)
  let buf = Buffer.alloc(0)
  socket.on('data', d => {
    buf = Buffer.concat([buf, d])
    const msg = wsReadText(buf)
    if (msg && msg.op === 1) {
      buf = Buffer.alloc(0)
      socket.write(wsFrame(1, Buffer.from(`echo:${msg.text}`), false))
    }
  })
  socket.on('error', () => {})
}
function wsEcho(url, cookie, text) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = (u.protocol === 'wss:' ? httpsRequest : httpRequest)({
      host: u.hostname,
      port: u.port || (u.protocol === 'wss:' ? 443 : 80),
      path: u.pathname,
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': randomBytes(16).toString('base64'), 'sec-websocket-version': '13', cookie },
    })
    const timer = setTimeout(() => reject(new Error('no echo in 30 s')), 30_000)
    req.on('upgrade', (res, socket) => {
      socket.write(wsFrame(1, Buffer.from(text), true))
      let buf = Buffer.alloc(0)
      socket.on('data', d => {
        buf = Buffer.concat([buf, d])
        const msg = wsReadText(buf)
        if (msg) {
          clearTimeout(timer)
          socket.destroy()
          resolve(msg.text)
        }
      })
    })
    req.on('response', res => reject(new Error(`HTTP ${res.statusCode}`)))
    req.on('error', reject)
    req.end()
  })
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

const UPDATE_LINE = 'claude plugin marketplace update claude-share && claude plugin update shared-session@claude-share'
const roomInfo = async id => (await fetch(`${SERVER}/api/rooms/${id}`)).json()

try {
  if (!process.env.EXTERNAL_SERVER) startServer()
  await until('server', async () => (await fetch(`${SERVER}/api/health`).catch(() => null))?.ok)

  // A plugin older than the server's minimum (or one that doesn't say) can't
  // share or join, and is told the command that updates it.
  const outdated = await fetch(`${SERVER}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'old', title: 'old' }) })
  const outdatedBody = await outdated.json().catch(() => ({}))
  const home = await fetch(`${SERVER}/`).then(r => r.text()).catch(() => '')
  check("the server's page says how to install and what it keeps", home.includes('claude plugin install shared-session@claude-share') && home.includes('What this server sees and keeps'))
  // The room knows which plugin its host runs, so a guest's can say what an older one can't show.
  const older = await fetch(`${SERVER}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shared-session-version': '0.10.1' }, body: JSON.stringify({ name: 'host', title: 'versions' }) }).then(r => r.json())
  await fetch(`${SERVER}/api/rooms/${older.id}/events?after=0&wait=0`, { headers: { authorization: `Bearer ${older.token}`, 'x-shared-session-version': '0.10.7' } })
  check('the room says which plugin its host runs now', (await roomInfo(older.id)).hostVersion === '0.10.7')
  await fetch(`${SERVER}/api/rooms/${older.id}/end`, { method: 'POST', headers: { authorization: `Bearer ${older.token}`, 'x-shared-session-version': '0.10.7' } })
  const tooOld = await fetch(`${SERVER}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shared-session-version': '0.9.7' }, body: JSON.stringify({ name: 'old', title: 'old' }) })
  check('a plugin older than the minimum is turned away with the update command', tooOld.status === 426 && String((await tooOld.json()).error).includes(UPDATE_LINE))
  check('an out-of-date plugin is told how to update', outdated.status === 426 && String(outdatedBody.error).includes('claude plugin update shared-session@claude-share'), `HTTP ${outdated.status}`)

  // Kim's session gave out a dev server's address before sharing: Share
  // everything opens it for whoever joins, at that page.
  // Slow to answer, like a dev server compiling its first page.
  const kimDev = createServer((req, res) => setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>kim ok</h1>'), 6000))
  await new Promise(r => kimDev.listen(0, '127.0.0.1', r))
  children.push({ kill: () => kimDev.close() })
  mkdirSync(join(WORK, 'kim'), { recursive: true })
  const kim = session('Kim', join(WORK, 'kim'))
  kim.say(`Reply with exactly this line and nothing else: Running at http://localhost:${kimDev.address().port}/dev/sheet`)
  await until('Kim answered', () => kim.lines.some(l => l.type === 'result'), 120_000)
  kim.say('/share-session all')
  const kimLink = await until("Kim's link", () => /\/s\/([A-Za-z0-9_-]{16,})/.exec(kim.text)?.[1], 60_000)
  const kimRoom = await until("Kim's dev server shared", async () => {
    const seat = await fetch(`${SERVER}/api/rooms/${kimLink}/join`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shared-session-version': '9.9.9' }, body: JSON.stringify({ name: 'probe' }) }).then(r => r.json())
    await fetch(`${SERVER}/api/rooms/${kimLink}/leave`, { method: 'POST', headers: { authorization: `Bearer ${seat.token}` } }).catch(() => {})
    return seat.history?.some(e => e.type === 'artifact' && e.body.kind === 'preview' && e.body.port === kimDev.address().port) && seat
  }, 30_000).catch(() => null)
  const kimShown = kimRoom?.history.find(e => e.type === 'artifact' && e.body.kind === 'preview')
  check('a dev server Claude gave out before Share opens for whoever joins, at that page', kimShown?.body.path === '/dev/sheet', kimShown ? `${kimShown.body.port}${kimShown.body.path}` : 'nothing shared')
  kim.say('/stop-sharing')

  // Scott's session: a normal session with some history, then Share.
  const hostFlags = ['--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions']
  // Claude Desktop's own id for the host's session, which outlives its Claude Code ids.
  const hostPlace = { CLAUDE_CODE_HOST_SESSION_ID: 'local_0e2e0000-0000-4000-8000-000000000001' }
  let host = session('Scott', hostDir, hostFlags, 'Scott', hostPlace)
  host.say('Read README.md and tell me the secret word in one word.')
  await until('host first turn', () => host.lines.some(l => l.type === 'result'))
  check('host answers its own first prompt', /marmalade/i.test(host.text))

  // A session with history asks before anything earlier leaves it.
  host.say('/share-session')
  await until('share asks first', () => /earlier prompt/.test(host.text), 60_000).catch(() => null)
  check('Share asks first in a session with history', /share-session all/.test(host.text) && !/\/s\/[A-Za-z0-9_-]{16,}/.test(host.text))
  host.say('/share-session all')
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
  let sam = session('Sam', join(WORK, 'sam'))
  sam.say(link)
  await until('Sam joined', async () => (await roomInfo(id)).people?.some(p => p.name === 'Sam'))
  await until('history shown to guest', () => /marmalade/i.test(guest.text), 30_000)
  check('guest sees what happened before Share', /marmalade/i.test(guest.text))
  await until('history card', () => guest.lines.some(l => l.type === 'assistant' && l.message.content.some(b => b.type === 'tool_use' && b.name === 'mcp__shared-session__replay' && b.input?.tool === 'Read')), 30_000).catch(() => null)
  check('what happened before shows its tool calls as cards too', guest.lines.some(l => l.type === 'assistant' && l.message.content.some(b => b.type === 'tool_use' && b.name === 'mcp__shared-session__replay' && b.input?.tool === 'Read')))

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

  // A host turn that goes quiet for longer than a step's 10 s budget (a slow
  // tool, a long think): the guest still shows it, never answering it itself.
  const quiet = host.lines.length
  host.say('Use the Bash tool to run `sleep 15 && touch replay-marker.txt`, then reply with just the word lantern.')
  await until('host ran the quiet turn', () => host.lines.slice(quiet).some(l => l.type === 'result' && /lantern/i.test(l.result ?? '')), 120_000).catch(() => null)
  await until('guest shows the quiet turn', () => assistantText(guest).some(t => /lantern/i.test(t)), 30_000).catch(() => null)
  // The host's Bash call is drawn in the guest as a card of the plugin's own
  // replay tool, answered with the host's result: nothing runs on the guest.
  const replayed = guest.lines.flatMap(l => (l.type === 'assistant' ? l.message.content : [])).find(b => b.type === 'tool_use' && b.name === 'mcp__shared-session__replay' && JSON.stringify(b.input).includes('replay-marker'))
  const answered = replayed && guest.lines.flatMap(l => (l.type === 'user' && Array.isArray(l.message?.content) ? l.message.content : [])).some(b => b.type === 'tool_result' && b.tool_use_id === replayed.id)
  check('a host tool call shows in the guest as a tool card with the host\'s result', Boolean(replayed && replayed.input?.tool === 'Bash' && answered), replayed ? JSON.stringify(replayed.input).slice(0, 80) : 'no card')
  // The host's Claude may run it in the background and answer first: wait for the host's file.
  await until('host made the marker', () => existsSync(join(hostDir, 'replay-marker.txt')), 60_000).catch(() => null)
  await new Promise(r => setTimeout(r, 2000))
  check('a replayed call never runs on the guest', existsSync(join(hostDir, 'replay-marker.txt')) && !existsSync(join(guestDir, 'replay-marker.txt')))
  check(
    'a host turn quiet for over 10 s plays in the guest, not its own model',
    assistantText(guest).some(t => /lantern/i.test(t)) && guest.lines.filter(l => l.type === 'result').every(l => !(l.total_cost_usd > 0)),
    guest.lines.filter(l => l.type === 'result').map(l => l.total_cost_usd).join(','),
  )

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

  // A picture the host's Claude looks at (an image it reads, a screenshot)
  // shows in the guest's card as an image, as it does in the host's.
  writeFileSync(join(hostDir, 'swatch.png'), Buffer.from(SWATCH_PNG, 'base64'))
  const pictureAt = guest.lines.length
  host.say('Use the Read tool on swatch.png, then reply with just its main color in one word.')
  await until('host read the picture', () => host.lines.some(l => l.type === 'result' && /red/i.test(l.result ?? '')), 120_000).catch(() => null)
  const pictured = () =>
    guest.lines
      .slice(pictureAt)
      .flatMap(l => (l.type === 'user' && Array.isArray(l.message?.content) ? l.message.content : []))
      .some(b => b.type === 'tool_result' && Array.isArray(b.content) && b.content.some(x => x.type === 'image' && x.source?.type === 'base64' && x.source.data?.length > 50))
  await until("guest's card has the picture", pictured, 60_000).catch(() => null)
  check("a picture the host's Claude reads shows in the guest's card as an image", pictured())

  // The update command a guest types (the "is out" line names it) runs on the
  // guest's computer; it never reaches the host's Claude to run there.
  guest.type(desktopPrompt('claude plugin marketplace update claude-share && claude plugin update shared-session@claude-share'))
  await until('guest answered the update itself', () => /Updating Shared Sessions on this computer/.test(guest.text), 30_000).catch(() => null)
  await new Promise(r => setTimeout(r, 3000))
  check(
    "the update command a guest types runs on the guest's computer, never at the host",
    /Updating Shared Sessions on this computer/.test(guest.text) && !transcriptOf(host).includes('claude plugin marketplace update'),
  )
  // Everyone's plugin version reaches the room, so the Room says who's behind.
  const versions = (await roomInfo(id)).people ?? []
  check("the room knows each person's plugin version", versions.length >= 2 && versions.every(p => /^\d+\.\d+\.\d+$/.test(p.version ?? '')), JSON.stringify(versions.map(p => [p.name, p.version])))

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
  app.on('upgrade', (req, socket) => wsEchoServer(req, socket))
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
    const back = await fetch(enter, { headers: { cookie }, redirect: 'manual' })
    previewed =
      opened.status === 302 &&
      page.includes('dev server ok') &&
      asset.ok &&
      (asset.headers.get('content-type') ?? '').includes('javascript') &&
      echoed === 'echo:ping' &&
      (echo.headers.get('set-cookie') ?? '').includes('app=1') &&
      moved.status === 302 &&
      moved.headers.get('location') === '/' &&
      again.status === 403 &&
      back.status === 302 &&
      back.headers.get('location') === '/'
  }
  check("a teammate opens the host's localhost through a preview (its link lets in one browser, which can come back)", previewed, enter ?? 'no link')

  // A WebSocket through the preview (a dev server's live reload; Next.js 16's
  // dev pages don't start without theirs): the app's echo answers.
  const echoed = origin ? await wsEcho(`${origin.replace(/^http/, 'ws')}/__echo`, cookie, 'ping-through-preview').catch(e => `error: ${e.message}`) : 'no preview'
  check("a WebSocket opened on a preview reaches the host's dev server and back", echoed === 'echo:ping-through-preview', echoed)

  // Someone who joins while the preview is open is handed it too, after the history.
  mkdirSync(join(WORK, 'lee'), { recursive: true })
  const lee = session('Lee', join(WORK, 'lee'))
  const leeJoined = Date.now()
  lee.say(link)
  await until('late joiner caught up', () => assistantText(lee).some(t => /kiwi/i.test(t)), 120_000).catch(() => null)
  const leeCaughtUp = Date.now()
  const late = await until('late joiner got the preview', () => /https?:\/\/[^\s)`'"]+\/__share\/enter\?room=[\w-]+&ticket=[\w-]+/.exec(lee.text)?.[0], 60_000).catch(() => null)
  check('someone who joins later is handed the open preview', Boolean(late) && late !== enter, late ?? 'no link')
  // Each earlier prompt arrives as a turn of its own, as it was for the host,
  // and quickly: one step for its calls, one for its last words.
  check('and sees each earlier prompt as its own turn, with its reply', ['marmalade', 'pineapple', 'kiwi'].every(w => assistantText(lee).some(t => t.toLowerCase().includes(w))) && lee.lines.filter(l => l.type === 'result').length >= 6, `${lee.lines.filter(l => l.type === 'result').length} turns in ${((leeCaughtUp - leeJoined) / 1000).toFixed(1)} s`)

  // A dev server the host's Claude gives the address of is shared too.
  const dev = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>mentioned ok</h1>'))
  await new Promise(r => dev.listen(0, '127.0.0.1', r))
  children.push({ kill: () => dev.close() })
  const enters = () => guest.text.match(/https?:\/\/[^\s)`'"]+\/__share\/enter\?room=[\w-]+&ticket=[\w-]+/g) ?? []
  const known = new Set(enters())
  host.say(`Reply with exactly this line and nothing else: The dev server is running at http://localhost:${dev.address().port}/dash`)
  const mentioned = await until('guest got the mentioned dev server', () => enters().find(u => !known.has(u)), 90_000).catch(() => null)
  let mentionedOk = false
  if (mentioned) {
    const opened = await fetch(mentioned, { redirect: 'manual' })
    const jar = (opened.headers.get('set-cookie') ?? '').split(';')[0]
    mentionedOk = opened.headers.get('location') === '/dash' && (await fetch(`${new URL(mentioned).origin}/`, { headers: { cookie: jar } }).then(r => r.text())).includes('mentioned ok')
  }
  check("a dev server the host's Claude mentions opens for guests, at the path it gave", mentionedOk, mentioned ?? 'no link')

  // How everyone heard the room: one open stream each, or polls when asked to.
  const polling = process.env.SHARED_SESSION_TRANSPORT === 'poll'
  const heard = ['Scott', 'Alex', 'Sam'].map(n => readFileSync(join(WORK, `${n}.debug.log`), 'utf8'))
  check(
    polling ? 'everyone polls when told to' : 'everyone hears the room over one open stream',
    heard.every(log => log.includes(polling ? 'Shared session: polling' : 'Shared session: listening on a stream')),
  )

  // The host's Claude Code closes (a restart to update, say): the room stays
  // open with the host away, and a guest's prompt meanwhile is answered here,
  // not sent. The same session reopened shares again, on the same link, even
  // under a new Claude Code id, as Claude Desktop reopens one after a rewind.
  const hostSession = host.lines.find(l => l.type === 'system' && l.subtype === 'init')?.session_id
  host.child.stdin.end()
  await until('host closed', () => host.child.exitCode !== null || host.child.signalCode !== null, 60_000).catch(() => null)
  await until('host shown away', async () => (await roomInfo(id)).people?.some(p => p.role === 'host' && !p.online), 90_000).catch(() => null)
  const away = await roomInfo(id)
  check('a host that closes leaves the room open, shown away', away.ended === false && away.people?.some(p => p.role === 'host' && !p.online))
  await new Promise(r => setTimeout(r, 2500)) // the room tells guests a moment after it counts the host gone
  guest.type(desktopPrompt('Say the word ember and nothing else.'))
  await until('guest told the host is closed', () => /Claude Code is closed right now/.test(guest.text), 30_000).catch(() => null)
  check("a guest's prompt while the host is closed is answered there, not sent", /Claude Code is closed right now/.test(guest.text))
  host = session('Scott', hostDir, [...hostFlags, '--resume', hostSession, '--fork-session'], 'Scott-reopened', hostPlace)
  await until('host back', async () => (await roomInfo(id)).people?.some(p => p.role === 'host' && p.online), 60_000).catch(() => null)
  check('the reopened session shares the same room again', (await roomInfo(id)).people?.some(p => p.role === 'host' && p.online) === true)
  guest.type(desktopPrompt('What is 9 times 4? Reply with just the number.'))
  await until('reopened host ran a guest prompt', () => host.lines.some(l => l.type === 'result' && /\b36\b/.test(l.result ?? '')), 120_000).catch(() => null)
  check("and runs a guest's prompt there", host.lines.some(l => l.type === 'result' && /\b36\b/.test(l.result ?? '')))
  // A stream-json session names its id once its first prompt comes in.
  const reopenedAs = host.lines.find(l => l.type === 'system' && l.subtype === 'init')?.session_id
  check('…though it was reopened under a new Claude Code id', Boolean(reopenedAs) && reopenedAs !== hostSession, `ids ${hostSession?.slice(0, 8)} → ${reopenedAs?.slice(0, 8)}`)
  check('a prompt sent while it was closed never ran', !/\bember\b/i.test(transcriptOf(host)))

  // A guest's Claude Code closes too, long enough for the room to let its
  // seat go; reopened, the session is back in the room by itself and plays
  // what it missed.
  const samSession = sam.lines.find(l => l.type === 'system' && l.subtype === 'init')?.session_id
  sam.child.stdin.end()
  await until('Sam closed', () => sam.child.exitCode !== null || sam.child.signalCode !== null, 60_000).catch(() => null)
  const missedAt = host.lines.length
  host.say('Say the word "walnut" and nothing else.')
  await until('host said walnut', () => host.lines.slice(missedAt).some(l => l.type === 'result' && /walnut/i.test(l.result ?? '')), 120_000).catch(() => null)
  await until("Sam's seat let go", async () => !(await roomInfo(id)).people?.some(p => p.name === 'Sam'), 90_000).catch(() => null)
  sam = session('Sam', join(WORK, 'sam'), ['--resume', samSession], 'Sam-reopened')
  await until('Sam back in the room', async () => (await roomInfo(id)).people?.some(p => p.name === 'Sam' && p.online), 60_000).catch(() => null)
  await until('Sam caught up', () => assistantText(sam).some(t => /walnut/i.test(t)), 60_000).catch(() => null)
  check(
    'a guest that closes and reopens is back in the room by itself, and sees what it missed',
    (await roomInfo(id)).people?.some(p => p.name === 'Sam' && p.online) === true && assistantText(sam).some(t => /walnut/i.test(t)),
    /Back in Scott's session/.test(sam.text) ? 'said it was back' : 'no back line',
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
