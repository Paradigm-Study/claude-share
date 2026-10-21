// Standalone Node 20+ checks: no models, deps, OAuth or saved room data.
//   node test/local-preview.mjs                 (real Room + Node + both helpers)
//   node test/local-preview.mjs --helpers-only (parser/listener checks only)
//   EXTERNAL_SERVER=1 SHARE_SERVER=http://127.0.0.1:8787 node test/local-preview.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import dgram from 'node:dgram'
import { randomBytes, createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, access, realpath, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { tmpdir, homedir, networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import helper from '../plugin/relay/local-preview.cjs'
import wsHelper from '../plugin/relay/ws-relay.cjs'
import ws from '../plugin/relay/ws.cjs'
import tcpRelay from '../plugin/relay/tcp-relay.cjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const GUEST = fileURLToPath(new URL('../plugin/relay/local-preview.cjs', import.meta.url))
const HOST = fileURLToPath(new URL('../plugin/relay/tcp-worker.cjs', import.meta.url))
const PROXY = fileURLToPath(new URL('../plugin/relay/browser-proxy.cjs', import.meta.url))
const PUBLIC = fileURLToPath(new URL('../plugin/relay/ws-relay.cjs', import.meta.url))
const NODE = fileURLToPath(new URL('../server/node.mjs', import.meta.url))
const VERSION = JSON.parse(await readFile(new URL('../plugin/.claude-plugin/plugin.json', import.meta.url))).version
const scratch = await mkdtemp(`${tmpdir()}/shared-tcp-`)
const children = new Set(), servers = new Set(), sockets = new Set(), running = new Set(), websockets = new Set(), requests = new Set()
const ROOM = 'R'.repeat(24), PID = 'P'.repeat(12), CAP = 'C'.repeat(32)
const dummy = port => ({ port, strict: true, url: `http://127.0.0.1:1/api/rooms/${ROOM}/previews/${PID}/tunnel`, token: CAP, expiresAt: Date.now() + 60_000 })
let ipv6 = true

async function until(check, label, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await pause(10) }
  throw new Error(`Timed out: ${label}`)
}
// A promise that must settle within ms: one that never does fails, never hangs.
function within(promise, label, ms = 5000) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms) })]).finally(() => clearTimeout(timer))
}
const listen = (server, host = '127.0.0.1', port = 0) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen({ host, port, ipv6Only: host === '::1' }, () => { server.removeListener('error', reject); resolve(server.address().port) })
})
const close = server => new Promise(resolve => server.listening ? server.close(resolve) : resolve())
// Whether nothing answers on 127.0.0.1 at this port (a refused connect).
const refused = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port })
  socket.once('connect', () => { socket.destroy(); resolve(false) })
  socket.once('error', () => resolve(true))
})
function track(server) {
  servers.add(server)
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)) })
  return server
}
async function freePort() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const v4 = track(net.createServer()), v6 = track(net.createServer())
    const port = await listen(v4)
    try { await listen(v6, '::1', port); await Promise.all([close(v4), close(v6)]); return port } catch (error) {
      await close(v4)
      if (['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)) { ipv6 = false; return port }
      if (error.code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error('Could not reserve a dual-stack test port')
}
const answers = (host, port) => new Promise(resolve => {
  const socket = net.createConnection({ host, port })
  const done = value => { socket.destroy(); resolve(value) }
  socket.setTimeout(300, () => done(true))
  socket.once('connect', () => done(true))
  socket.once('error', error => done(!['ECONNREFUSED', 'EADDRNOTAVAIL', 'ENETUNREACH', 'EAFNOSUPPORT'].includes(error.code)))
})
// A free port below the usual ephemeral ranges (Linux 32768+, macOS 49152+), so
// an OS-assigned fallback never equals it; nothing may answer there either.
async function fixedPort() {
  for (let attempt = 0; attempt < 64; attempt++) {
    const port = 20000 + randomBytes(2).readUInt16BE(0) % 10000
    if (await answers('127.0.0.1', port) || await answers('::1', port)) continue
    const v4 = net.createServer(), v6 = net.createServer()
    try { await listen(v4, '127.0.0.1', port); if (ipv6) await listen(v6, '::1', port); return port } catch {} finally { await Promise.all([close(v4), close(v6)]) }
  }
  throw new Error('Could not find a free fixed test port')
}
function launch(file, cfg, env = {}) {
  const child = spawn(process.execPath, [file], { cwd: scratch, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const log = { child, stdout: '', stderr: '', rows: [], exit: null }
  children.add(child)
  child.stdin.on('error', () => {})
  let input = ''
  child.stdout.on('data', bytes => {
    log.stdout += bytes
    if (file === NODE) return
    input += bytes
    let at
    while ((at = input.indexOf('\n')) !== -1) {
      const line = input.slice(0, at); input = input.slice(at + 1)
      if (line.trim()) log.rows.push(JSON.parse(line))
    }
  })
  child.stderr.on('data', bytes => (log.stderr += bytes))
  child.once('exit', (code, signal) => { log.exit = { code, signal }; children.delete(child) })
  child.stdin.end(typeof cfg === 'string' ? cfg : JSON.stringify(cfg ?? {}))
  return log
}
async function ready(cfg) {
  const log = launch(GUEST, cfg)
  await until(() => log.rows.length || log.exit, 'guest listener ready')
  assert.equal(log.rows[0]?.state, 'ready', JSON.stringify(log.rows))
  assert.ok(Number.isInteger(log.rows[0].port))
  assert.equal(typeof log.rows[0].ipv6, 'boolean')
  log.port = log.rows[0].port
  log.ipv6 = log.rows[0].ipv6
  return log
}
async function stop(log) {
  if (!log.exit) log.child.kill('SIGTERM')
  await until(() => log.exit, 'helper stopped')
  assert.equal(log.stderr, '')
  assert.equal(log.exit.code, 0)
}
async function startupError(cfg, code, file = GUEST) {
  const log = launch(file, cfg)
  await until(() => log.exit, `startup ${code}`)
  assert.deepEqual(log.rows, [{ state: 'error', code }])
  assert.notEqual(log.exit.code, 0)
  assert.equal(log.stderr, '')
}
async function wire(port, host = '127.0.0.1', collect = true) {
  const client = net.createConnection({ host, port, allowHalfOpen: true })
  sockets.add(client)
  const result = { client, parts: [], closed: false, ended: false }
  Object.defineProperty(result, 'bytes', { get: () => Buffer.concat(result.parts) })
  if (collect) client.on('data', bytes => result.parts.push(bytes))
  client.on('error', () => {})
  client.on('end', () => { result.ended = true; client.end() })
  client.on('close', () => { result.closed = true; sockets.delete(client) })
  await once(client, 'connect')
  return result
}
function request(port, path = '/', { method = 'GET', body, headers = {}, host = '127.0.0.1', onData = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: host, port, method, path, agent: false, headers: { host: `localhost:${port}`, ...headers } }, res => {
      const parts = []
      res.on('data', bytes => { parts.push(bytes); onData(bytes) })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }))
      res.on('error', reject)
    })
    requests.add(req)
    const timer = setTimeout(() => req.destroy(new Error('Test HTTP timeout')), 15_000)
    req.once('close', () => { clearTimeout(timer); requests.delete(req) })
    req.on('error', reject)
    req.end(body)
  })
}
async function worker(room, token = CAP) {
  const controlToken = randomBytes(32).toString('hex')
  const log = launch(HOST, { room, token, controlToken, version: VERSION })
  await until(() => log.rows.length || log.exit, 'host worker ready')
  assert.equal(log.rows[0]?.state, 'ready', JSON.stringify(log.rows))
  log.port = log.rows[0].port
  log.controlToken = controlToken
  return log
}
function ipc(log, command, options = {}) {
  return request(log.port, options.path ?? '/', { method: options.method ?? 'POST', body: options.body ?? JSON.stringify(command), headers: { host: `127.0.0.1:${log.port}`, authorization: `Bearer ${log.controlToken}`, 'content-type': 'application/json', ...options.headers } })
}
async function rss(log) {
  const { stdout } = await promisify(execFile)('ps', ['-o', 'rss=', '-p', String(log.child.pid)])
  return Number(stdout.trim()) * 1024
}
// Test-only wire frames, not another production parser.
function frame(op, payload, { fin = true, mask = false, rsv = 0 } = {}) {
  payload = Buffer.from(payload)
  const head = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10)
  head[0] = (fin ? 128 : 0) | rsv | op
  head[1] = (mask ? 128 : 0) | (payload.length < 126 ? payload.length : payload.length < 65536 ? 126 : 127)
  if (head.length === 4) head.writeUInt16BE(payload.length, 2)
  if (head.length === 10) head.writeBigUInt64BE(BigInt(payload.length), 2)
  const key = Buffer.from([1, 2, 3, 4]), body = Buffer.from(payload)
  if (mask) for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3]
  return Buffer.concat([head, ...(mask ? [key] : []), body])
}
function readFrames(socket, head, receive) {
  let bytes = head || Buffer.alloc(0)
  function read() {
    while (bytes.length >= 2) {
      let at = 2, length = bytes[1] & 127
      if (length === 126) { if (bytes.length < 4) return; length = bytes.readUInt16BE(2); at = 4 }
      if (length === 127) { if (bytes.length < 10) return; length = Number(bytes.readBigUInt64BE(2)); at = 10 }
      const masked = !!(bytes[1] & 128), payloadAt = at + (masked ? 4 : 0)
      if (bytes.length < payloadAt + length) return
      const op = bytes[0] & 15, data = Buffer.from(bytes.subarray(payloadAt, payloadAt + length))
      if (masked) for (let i = 0; i < data.length; i++) data[i] ^= bytes[at + (i & 3)]
      bytes = bytes.subarray(payloadAt + length)
      receive(op, data)
    }
  }
  socket.on('data', data => { bytes = Buffer.concat([bytes, data]); read() })
  read()
}
function handshake(req, socket, extra = '') {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n${extra}\r\n`)
}
function connect(url, headers = {}, on = {}, options) {
  const socket = ws.connect(url, headers, [], on, options)
  websockets.add(socket)
  return socket
}

// The browsers the plugin opens a preview window in (macOS .app bundles under
// /Applications and ~/Applications; Linux names on PATH), or why there is none.
const MAC_BROWSERS = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium']
const LINUX_BROWSERS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']
async function executable(file) { try { await access(file, fsConstants.X_OK); return true } catch { return false } }
async function appBinary(app) {
  const dir = `${app}/Contents/MacOS`, name = app.split('/').pop().replace(/\.app$/, '')
  for (const file of [`${dir}/${name}`, ...(await readdir(dir).catch(() => [])).map(entry => `${dir}/${entry}`)]) if (await executable(file)) return file
  return null
}
async function findChrome() {
  const root = process.getuid?.() === 0 ? { reason: 'running as root: Chrome needs --no-sandbox there, which production never passes' } : null
  const named = process.env.SHARED_SESSION_TEST_CHROME?.replace(/\/+$/, '')
  if (named) {
    // A named browser that is not there is a mistake to report, not a SKIP.
    const file = named.endsWith('.app') ? await appBinary(named) : named
    assert.ok(file && await executable(file), `SHARED_SESSION_TEST_CHROME is not an executable browser: ${named}`)
    return root ?? { path: file }
  }
  const candidates = process.platform === 'darwin'
    ? MAC_BROWSERS.flatMap(name => ['/Applications', `${homedir()}/Applications`].map(dir => `${dir}/${name}.app/Contents/MacOS/${name}`))
    : LINUX_BROWSERS.flatMap(name => (process.env.PATH ?? '').split(':').filter(Boolean).map(dir => `${dir}/${name}`))
  let snap
  for (const file of candidates) {
    if (!await executable(file)) continue
    if ((await realpath(file)).startsWith('/snap/')) { snap ??= file; continue }
    return root ?? { path: file }
  }
  return { reason: snap ? `snap browser (${snap}) cannot use a private profile; production falls back too` : `no Chrome, Edge, Brave or Chromium${process.platform === 'darwin' ? ' app' : ' on PATH'}; set SHARED_SESSION_TEST_CHROME` }
}
// Firefox the way the plugin finds it: an app's lowercase `firefox` binary on
// macOS, these names on PATH on Linux, never a snap (nor the wrapper that runs one).
const MAC_FIREFOX = ['Firefox', 'Firefox Developer Edition', 'Firefox Nightly']
const LINUX_FIREFOX = ['firefox', 'firefox-esr', 'firefox-developer-edition', 'firefox-nightly']
async function findFirefox() {
  const named = process.env.SHARED_SESSION_TEST_FIREFOX?.replace(/\/+$/, '')
  if (named) {
    const file = named.endsWith('.app') ? `${named}/Contents/MacOS/firefox` : named
    assert.ok(await executable(file), `SHARED_SESSION_TEST_FIREFOX is not an executable browser: ${named}`)
    return { path: file }
  }
  const candidates = process.platform === 'darwin'
    ? MAC_FIREFOX.flatMap(name => ['/Applications', `${homedir()}/Applications`].map(dir => `${dir}/${name}.app/Contents/MacOS/firefox`))
    : LINUX_FIREFOX.flatMap(name => (process.env.PATH ?? '').split(':').filter(Boolean).map(dir => `${dir}/${name}`))
  let snap
  for (const file of candidates) {
    if (!await executable(file)) continue
    const real = await realpath(file)
    const wrapper = (await stat(real)).size < 65536 ? await readFile(real, 'latin1').catch(() => '') : ''
    if (real.startsWith('/snap/') || wrapper.includes('/snap/')) { snap ??= file; continue }
    return { path: file }
  }
  return { reason: snap ? `snap Firefox (${snap}) cannot use a private profile; production falls back too` : `no Firefox${process.platform === 'darwin' ? ' app' : ' on PATH'}; set SHARED_SESSION_TEST_FIREFOX` }
}
// The preview window's Firefox settings, read from the plugin's own list
// (FIREFOX_PREFS in plugin/hooks/window.ts), written as `firefoxUserJs` writes them.
async function firefoxUserJs(proxyPort) {
  const source = await readFile(new URL('../plugin/hooks/window.ts', import.meta.url), 'utf8')
  const list = /export const FIREFOX_PREFS[^=]*= \[\n([\s\S]*?)\n\]/.exec(source)?.[1] ?? ''
  const prefs = list.split('\n').map(line => /^\s*\['([^']+)', ('[^']*'|-?\d+|true|false)\],$/.exec(line)).filter(Boolean).map(([, name, raw]) => [name, raw.startsWith("'") ? raw.slice(1, -1) : JSON.parse(raw)])
  assert.ok(prefs.length >= 30 && prefs.length === list.split('\n').filter(l => l.trim()).length, 'every FIREFOX_PREFS line was read')
  const all = [['network.proxy.socks', '127.0.0.1'], ['network.proxy.socks_port', proxyPort], ...prefs]
  return ['// shared-session: a preview window (written before every start)', ...all.map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`), ''].join('\n')
}
// A preview window started as the plugin starts one, headless, on a throwaway
// profile, talking to the SOCKS proxy on socksPort. Chrome: the plugin's
// flags (the list chromeFlags in plugin/hooks/window.ts makes), and the
// profile's WebRTC setting written as the plugin writes it before a start
// (where this Node loads TypeScript).
const launchChrome = binary => async ({ socksPort, profile, url }) => {
  if (windowScripts) await shOut(windowScripts.chromePrefsScript(profile, windowScripts.chromePrefs(null)))
  return spawn(binary, ['--headless=new', `--user-data-dir=${profile}/chrome`, `--proxy-server=socks5://127.0.0.1:${socksPort}`, '--proxy-bypass-list=<-loopback>', '--no-first-run', '--no-default-browser-check', '--new-window',
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : process.platform === 'linux' ? ['--password-store=basic'] : []), url], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
}
// Firefox: the production settings (user.js) and flags, --headless in front;
// its HOME inside the throwaway profile, so nothing of a real one is touched.
const launchFirefox = binary => async ({ socksPort, profile, url }) => {
  await mkdir(`${profile}/firefox`, { recursive: true, mode: 0o700 })
  await mkdir(`${profile}/home`, { recursive: true, mode: 0o700 })
  await writeFile(`${profile}/firefox/user.js`, await firefoxUserJs(socksPort), { mode: 0o600 })
  return spawn(binary, ['--headless', '-profile', `${profile}/firefox`, url], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: `${profile}/home`, MOZ_CRASHREPORTER_DISABLE: '1' } })
}
// Every process still naming this unique temporary profile was started by our Chrome.
async function holdingProfile(profile) {
  const { stdout } = await promisify(execFile)('ps', ['-eo', 'pid=,args='], { maxBuffer: 32 * 1024 * 1024 })
  return stdout.split('\n').filter(line => line.includes(profile)).map(line => Number(line.trim().split(/\s+/)[0])).filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
}
// The plugin's own window probes (plugin/hooks/window.ts), where this Node
// strips TypeScript's types itself (22.18+); elsewhere those checks are skipped.
const windowScripts = await import('../plugin/hooks/window.ts').catch(() => null)
function shOut(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-s'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', bytes => { out += bytes })
    child.on('error', reject)
    child.on('close', () => resolve(out))
    child.stdin.end(script)
  })
}
async function endBrowser(browser, exited, profile) {
  for (const [signal, wait] of [['SIGTERM', 5000], ['SIGKILL', 2000]]) {
    try { process.kill(-browser.pid, signal) } catch {}
    if (await Promise.race([exited.then(() => true), pause(wait).then(() => false)]) && !(await holdingProfile(profile)).length) break
  }
  for (let i = 0; i < 20; i++) {
    const left = await holdingProfile(profile)
    if (!left.length) break
    for (const pid of left) try { process.kill(pid, 'SIGKILL') } catch {}
    await pause(100)
  }
  assert.deepEqual(await holdingProfile(profile), [], 'no process of ours keeps the profile')
  await rm(profile, { recursive: true, force: true })
}

// The window probe's last resort, against a made-up process list: Firefox's
// own child processes listed first (macOS's plugin-container carries
// -profile; Linux's carry -contentproc) and a stale Linux lock link, so only
// the scan can find the window. Read-only: nothing here is ever signalled.
async function probeChecks() {
  if (!windowScripts) return console.log("SKIP the window probe's scan against made-up processes (this Node can't load TypeScript)")
  const dir = await mkdtemp(`${scratch}/probe-`), profile = `${dir}/0123456789abcdef`, bin = `${dir}/bin`
  await mkdir(`${profile}/firefox`, { recursive: true })
  await mkdir(bin)
  await writeFile(`${profile}/firefox/user.js`, windowScripts.firefoxUserJs(47100))
  await writeFile(`${dir}/ps.list`, [
    `4001 /Applications/Firefox.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -isForBrowser -parentBuildID 20261001000000 -profile ${profile}/firefox 4002 tab`,
    `4003 /usr/lib/firefox/firefox -contentproc -profile ${profile}/firefox -childID 1 4002 tab`,
    `4004 /usr/lib/firefox/firefox -profile ${profile}-other/firefox http://localhost:3000/`,
    `4002 /Applications/Firefox.app/Contents/MacOS/firefox -profile ${profile}/firefox http://localhost:3000/`,
  ].join('\n') + '\n')
  // ps: -U lists them all; -p names one (none for a pid not there). lsof finds no holder.
  await writeFile(`${bin}/ps`, ['#!/bin/sh', 'want=', 'while [ $# -gt 0 ]; do [ "$1" = -p ] && want=$2; shift; done', 'if [ -z "$want" ]; then cat "$PS_LIST"; exit 0; fi', 'while read -r q x; do [ "$q" = "$want" ] && printf "%s\\n" "$x"; done < "$PS_LIST"', 'exit 0', ''].join('\n'), { mode: 0o755 })
  await writeFile(`${bin}/lsof`, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const probe = () => new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-s'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PS_LIST: `${dir}/ps.list` } })
    let out = ''
    child.stdout.on('data', bytes => { out += bytes })
    child.on('error', reject)
    child.on('close', () => resolve(out))
    child.stdin.end(windowScripts.lockScript(profile))
  })
  assert.deepEqual(windowScripts.windowOf(await probe(), profile), { pid: 4002, port: 47100, family: 'firefox' }, 'the scan passes over child processes to the window')
  // A Linux lock link left by a window long gone (its pid not running) isn't taken at its word.
  const { symlink } = await import('node:fs/promises')
  await symlink('127.0.1.1:+99999', `${profile}/firefox/lock`)
  assert.deepEqual(windowScripts.windowOf(await probe(), profile), { pid: 4002, port: 47100, family: 'firefox' }, 'a stale lock link falls back to the scan')
  await rm(dir, { recursive: true, force: true })
  console.log("ok window probe's scan: macOS plugin-container and Linux -contentproc children and another profile passed over; a stale lock link falls back to it")
}

// The detection script against made-up browsers, on either platform's
// branch: every one listed with what its files say, the person's default by
// bundle id on macOS alone, a binary under two names once. Nothing here is a
// real browser, and none is run but a stand-in's --version.
async function detectChecks() {
  if (!windowScripts) return console.log("SKIP browser detection against made-up browsers (this Node can't load TypeScript)")
  const { symlink, unlink } = await import('node:fs/promises')
  const dir = await mkdtemp(`${scratch}/detect-`), bin = `${dir}/bin`, log = `${dir}/osascript.log`
  const appsA = `${dir}/Applications`, appsB = `${dir}/home/Applications`
  await mkdir(bin)
  // Only these on PATH: the tools the script uses, and the stand-ins.
  for (const tool of ['sed', 'head', 'readlink', 'ls', 'wc', 'grep', 'tr']) {
    const real = await new Promise(resolve => execFile('/bin/sh', ['-c', `command -v ${tool}`], (error, out) => resolve(error ? '' : out.trim())))
    assert.ok(real.startsWith('/'), `${tool} for the detection check`)
    await symlink(real, `${bin}/${tool}`)
  }
  await writeFile(`${bin}/uname`, '#!/bin/sh\necho "$FAKE_OS"\n', { mode: 0o755 })
  await writeFile(`${bin}/osascript`, '#!/bin/sh\necho ran >> "$FAKE_LOG"\n[ -n "$FAKE_DEFAULT" ] || exit 1\necho "$FAKE_DEFAULT"\n', { mode: 0o755 })
  await writeFile(`${bin}/defaults`, '#!/bin/sh\n[ "$1" = read ] && [ "$3" = CFBundleIdentifier ] || exit 1\nsed -n "s|.*<key>CFBundleIdentifier</key><string>\\(.*\\)</string>.*|\\1|p" "$2.plist"\n', { mode: 0o755 })
  const app = async (root, name, binary, id, milestone) => {
    const contents = `${root}/${name}.app/Contents`
    await mkdir(`${contents}/MacOS`, { recursive: true })
    await writeFile(`${contents}/MacOS/${binary}`, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await writeFile(`${contents}/Info.plist`, `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>\n`)
    if (milestone) await mkdir(`${contents}/Resources`).then(() => writeFile(`${contents}/Resources/platform.ini`, `[Build]\nMilestone=${milestone}\n`))
    else await mkdir(`${contents}/Frameworks/${name} Framework.framework`, { recursive: true })
  }
  await app(appsA, 'Google Chrome', 'Google Chrome', 'com.google.Chrome')
  await app(appsB, 'Firefox', 'firefox', 'org.mozilla.firefox', '158.0')
  const ran = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length
  const detect = (env, override = '', dirs = [appsA, appsB]) => new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-s'], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: bin, HOME: `${dir}/home`, FAKE_LOG: log, ...env } })
    let out = ''
    child.stdout.on('data', bytes => { out += bytes })
    child.on('error', reject)
    child.on('close', () => resolve(out))
    child.stdin.end(windowScripts.detectScript(override, dirs))
  })
  const chrome = `${appsA}/Google Chrome.app`, firefox = `${appsB}/Firefox.app`
  let out = await detect({ FAKE_OS: 'Darwin', FAKE_DEFAULT: 'com.google.Chrome' })
  assert.deepEqual(windowScripts.detectedBrowsers(out), { platform: 'darwin', candidates: [{ browser: chrome, family: 'chromium', isDefault: true }, { browser: firefox, gecko: 158 }] })
  assert.deepEqual(windowScripts.parseDetect(out), { platform: 'darwin', browser: firefox, gecko: 158 }, "a browser that isn't the default first")
  out = await detect({ FAKE_OS: 'Darwin', FAKE_DEFAULT: 'org.mozilla.firefox' })
  assert.deepEqual(windowScripts.detectedBrowsers(out).candidates, [{ browser: chrome, family: 'chromium' }, { browser: firefox, gecko: 158, isDefault: true }])
  out = await detect({ FAKE_OS: 'Darwin' })
  assert.deepEqual(windowScripts.detectedBrowsers(out).candidates, [{ browser: chrome, family: 'chromium' }, { browser: firefox, gecko: 158 }], 'no default known: none marked')
  out = await detect({ FAKE_OS: 'Darwin', FAKE_DEFAULT: 'com.google.chrome' }, '', [appsA])
  assert.deepEqual(windowScripts.parseDetect(out), { platform: 'darwin', browser: chrome, family: 'chromium', isDefault: true }, 'the default, compared without case, when it is the only one')
  const before = await ran()
  out = await detect({ FAKE_OS: 'Darwin', FAKE_DEFAULT: 'com.google.Chrome' }, chrome)
  assert.deepEqual(windowScripts.detectedBrowsers(out).candidates, [{ browser: chrome, family: 'chromium' }], "the person's choice alone")
  assert.equal(await ran(), before, "the person's choice asks nothing more")
  // Linux: names on PATH; one binary under two names once; a wrapper says its version itself.
  await mkdir(`${dir}/opt/chrome`, { recursive: true })
  await mkdir(`${dir}/opt/firefox`, { recursive: true })
  await writeFile(`${dir}/opt/chrome/chrome`, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(`${dir}/opt/chrome/resources.pak`, '')
  await writeFile(`${dir}/opt/firefox/firefox`, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(`${dir}/opt/firefox/platform.ini`, '[Build]\nMilestone=128.0\n')
  await symlink(`${dir}/opt/chrome/chrome`, `${bin}/google-chrome`)
  await symlink(`${dir}/opt/chrome/chrome`, `${bin}/google-chrome-stable`)
  await symlink(`${dir}/opt/firefox/firefox`, `${bin}/firefox`)
  await writeFile(`${bin}/firefox-esr`, '#!/bin/sh\n[ "$1" = --version ] && echo "Mozilla Firefox 153.5.0esr"\nexit 0\n', { mode: 0o755 })
  await writeFile(`${bin}/vivaldi`, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const linuxBefore = await ran()
  out = await detect({ FAKE_OS: 'Linux', FAKE_DEFAULT: 'com.google.Chrome' })
  assert.deepEqual(windowScripts.detectedBrowsers(out), { platform: 'linux', candidates: [{ browser: `${bin}/google-chrome`, family: 'chromium' }, { browser: `${bin}/firefox`, gecko: 128 }, { browser: `${bin}/firefox-esr`, gecko: 153 }, { browser: `${bin}/vivaldi` }] })
  assert.equal(await ran(), linuxBefore, 'no default browser is asked for on Linux')
  await unlink(`${bin}/google-chrome`)
  await unlink(`${bin}/google-chrome-stable`)
  out = await detect({ FAKE_OS: 'Linux' })
  assert.deepEqual(windowScripts.parseDetect(out), { platform: 'linux', browser: `${bin}/firefox-esr`, gecko: 153 }, 'Firefox 128 gives way to a newer one after it')
  assert.deepEqual(windowScripts.parseDetect(out, false), { platform: 'linux', browser: `${bin}/vivaldi` }, 'a Firefox whose profile path is too long gives way to another browser')
  await rm(dir, { recursive: true, force: true })
  console.log("ok browser detection against made-up browsers: every one listed as its files say (Framework, platform.ini, resources.pak, a wrapper's --version), the default by bundle id on macOS only and not for the person's choice, a binary under two names once; the pick passes over the default, an old Firefox and one whose path doesn't fit")
}

async function parserChecks() {
  let attack
  const fixture = track(http.createServer((_req, _res) => {}))
  fixture.on('upgrade', (req, socket) => attack(req, socket))
  const url = `ws://127.0.0.1:${await listen(fixture)}/`
  async function rejected(run, code, options, status) {
    attack = run
    let ended, reportedStatus
    connect(url, {}, { close: (c, s) => { ended = c; reportedStatus = s } }, options)
    await until(() => ended !== undefined, `WS rejected ${code}`)
    assert.equal(ended, code)
    assert.equal(reportedStatus, status)
  }
  for (const [status, code] of [[401, 1008], [403, 1008], [429, 1013], [500, 1011]]) await rejected((_req, s) => s.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`), code, undefined, status)
  await rejected((_req, s) => s.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: wrong\r\n\r\n'), 1002)
  for (const bytes of [frame(2, 'masked', { mask: true }), frame(2, 'rsv', { rsv: 64 }), frame(3, ''), frame(0, ''), frame(9, '', { fin: false }), frame(9, Buffer.alloc(126)), Buffer.from([0x82, 126, 0, 1]), Buffer.from([0x88, 1, 0]), frame(1, Buffer.from([255])), Buffer.concat([frame(2, 'a', { fin: false }), frame(1, 'b')])]) {
    const utf8 = bytes.equals(frame(1, Buffer.from([255])))
    await rejected((req, s) => { handshake(req, s); s.write(bytes) }, utf8 ? 1007 : 1002)
  }
  for (const length of [65537n, 0x8000000000000000n]) {
    const bytes = Buffer.alloc(10); bytes[0] = 0x82; bytes[1] = 127; bytes.writeBigUInt64BE(length, 2)
    await rejected((req, s) => { handshake(req, s); s.write(bytes) }, 1009, { maxMessage: 65536 })
  }
  await rejected((req, s) => { handshake(req, s); s.write(frame(2, Buffer.alloc(600 * 1024), { fin: false })); s.write(frame(0, Buffer.alloc(600 * 1024))) }, 1009)
  await rejected((_req, s) => s.end(`HTTP/1.1 101 Switching Protocols\r\nX-Large: ${'x'.repeat(17 * 1024)}\r\n\r\n`), 1006)
  const messages = []
  attack = (req, s) => { handshake(req, s); s.write(Buffer.concat([frame(2, [0, 255], { fin: false }), frame(9, 'ping'), frame(0, [128, 1])])) }
  const fragmented = connect(url, {}, { message: (data, binary) => messages.push({ data, binary }) })
  await until(() => messages.length, 'fragmented WS with interleaved ping')
  assert.deepEqual(messages, [{ data: Buffer.from([0, 255, 128, 1]), binary: true }])
  fragmented.close()
  attack = () => {}
  let overflow
  const queued = connect(url, {}, { close: code => (overflow = code) })
  for (let i = 0; i < 17; i++) queued.send(Buffer.alloc(65536), true)
  assert.equal(overflow, 1009, 'pre-handshake queue is bounded')
  attack = (req, s) => { handshake(req, s); s.pause() }
  let sendingCode, opened = false
  const sending = connect(url, {}, { open: () => (opened = true), close: code => (sendingCode = code) })
  await until(() => opened, 'send buffer fixture')
  for (let i = 0; i < 1024 && sendingCode === undefined; i++) sending.send(Buffer.alloc(65536), true)
  assert.equal(sendingCode, 1009, 'WS sending cannot grow without limit')
  let handshakeTimeout
  attack = () => {}
  connect(url, {}, { close: code => (handshakeTimeout = code) }, { timeoutMs: 80 })
  await until(() => handshakeTimeout !== undefined, 'bounded WS handshake')
  assert.equal(handshakeTimeout, 1006)
  console.log('ok WS accept, UTF-8/64-bit/RSV/opcode/mask/control/fragments, handshake/receive/send/queue limits')
}

// A throwaway self-signed certificate for localhost, or null without openssl.
async function selfSigned() {
  const dir = await mkdtemp(`${scratch}/tls-`)
  try {
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`, '-days', '2', '-subj', '/CN=localhost'], { timeout: 30_000 })
    return { key: await readFile(`${dir}/key.pem`), cert: await readFile(`${dir}/cert.pem`) }
  } catch { return null } finally { await rm(dir, { recursive: true, force: true }) }
}

async function publicRelayChecks() {
  const messages = [], headers = new Map(), peers = new Map()
  const roomLeg = id => `/api/rooms/${ROOM}/ws/${id}`, ROOM_LEG = roomLeg('PUBLIC000000')
  const fixture = track(http.createServer())
  fixture.on('upgrade', (req, socket, head) => {
    headers.set(req.url, req.headers); peers.set(req.url, socket)
    handshake(req, socket, req.url === '/local' ? 'Sec-WebSocket-Protocol: dev\r\n' : '')
    readFrames(socket, head, (op, payload) => {
      if (op === 8) return socket.end(frame(8, payload))
      if (req.url === '/local') socket.write(frame(op, payload))
      else messages.push({ url: req.url, op, payload })
    })
  })
  const port = await listen(fixture)
  const cfg = { local: `ws://localhost:${port}/local`, origin: `http://localhost:${port}`, protocols: ['dev'], room: `ws://localhost:${port}${ROOM_LEG}`, token: CAP, version: VERSION }
  // Its settings come whole from the plugin; anything else is refused before any connection.
  for (const bad of [{ tcp: true, port, room: cfg.room, token: CAP, version: VERSION }, { ...cfg, extra: 1 }, { ...cfg, token: 'short' }, { ...cfg, version: 7 }, { ...cfg, protocols: 'dev' }, { ...cfg, insecureLocal: 'yes' },
    { ...cfg, local: `ws://example.test:${port}/local` }, { ...cfg, local: `ws://192.168.1.2:${port}/local` }, { ...cfg, local: `http://localhost:${port}/local` }, { ...cfg, local: `ws://user:pass@localhost:${port}/local` }, { ...cfg, local: `ws://localhost:${port}/local#x` },
    { ...cfg, origin: `http://localhost:${port}/path` }, { ...cfg, origin: 'https://elsewhere.test' }, { ...cfg, origin: undefined },
    { ...cfg, room: `ws://localhost:${port}/room` }, { ...cfg, room: `${cfg.room}?token=${CAP}` }, { ...cfg, room: `http://localhost:${port}${ROOM_LEG}` }, { ...cfg, room: cfg.room.replace('ws://', 'ws://user:pass@') },
    { ...cfg, room: `ws://${'r'.repeat(4100)}.test${ROOM_LEG}` }]) await startupError(bad, 'INVALID_CONFIG', PUBLIC)
  assert.equal(peers.size, 0, 'a refused setting connects nothing')
  const relay = wsHelper.start(cfg)
  running.add(relay)
  await until(() => peers.size === 2, 'ordinary/public WS relay still connects both halves')
  assert.equal(headers.get('/local').origin, `http://localhost:${port}`)
  assert.equal(headers.get('/local')['sec-websocket-protocol'], 'dev')
  assert.equal(headers.get(ROOM_LEG).authorization, `Bearer ${CAP}`)
  assert.equal(headers.get(ROOM_LEG)['x-shared-session-version'], VERSION)
  peers.get(ROOM_LEG).write(frame(1, 'public text'))
  await until(() => messages.length === 1, 'ordinary relay text')
  peers.get(ROOM_LEG).write(frame(2, [0, 255, 128]))
  await until(() => messages.length === 2, 'ordinary relay binary')
  assert.deepEqual(messages, [{ url: ROOM_LEG, op: 1, payload: Buffer.from('public text') }, { url: ROOM_LEG, op: 2, payload: Buffer.from([0, 255, 128]) }])
  relay.close(); running.delete(relay)
  await until(() => [...peers.values()].every(peer => peer.destroyed), 'ordinary relay graceful close')

  // A TLS dev server (wss://localhost): its own certificate is accepted on the
  // local leg with insecureLocal alone; the room leg always verifies.
  const pem = await selfSigned()
  if (!pem) return console.log('ok ordinary/public WS helper compatibility, strict settings (the old Host-TCP form refused), protocols/Origin, text/binary and graceful cleanup; SKIP the wss:// local leg (no openssl to make a certificate)')
  const secure = track(https.createServer({ key: pem.key, cert: pem.cert })), upgrades = []
  let tcpConnections = 0
  secure.on('connection', () => tcpConnections++)
  secure.on('upgrade', (req, socket, head) => {
    upgrades.push({ url: req.url, headers: req.headers })
    handshake(req, socket)
    readFrames(socket, head, (op, payload) => op === 8 ? socket.end(frame(8, payload)) : socket.write(frame(op, payload)))
  })
  const tlsPort = await listen(secure)
  const tls = { ...cfg, local: `wss://localhost:${tlsPort}/_next/webpack-hmr?id=1`, origin: `https://localhost:${tlsPort}`, protocols: [] }
  // connect() itself: verifying by default, and `insecure` only when asked.
  let verified, accepted = false
  connect(`wss://localhost:${tlsPort}/verify`, {}, { close: code => (verified = code) })
  connect(`wss://localhost:${tlsPort}/insecure`, {}, { open: () => (accepted = true) }, { insecure: true })
  await until(() => verified !== undefined && accepted, 'a self-signed certificate: refused by default, accepted with insecure')
  assert.equal(verified, 1006)
  assert.deepEqual(upgrades.map(u => u.url), ['/insecure'])
  const secured = wsHelper.start({ ...tls, insecureLocal: true, room: `ws://localhost:${port}${roomLeg('SECURE000000')}` })
  running.add(secured)
  await until(() => peers.has(roomLeg('SECURE000000')) && upgrades.length === 2, 'insecureLocal reaches the TLS dev server')
  assert.equal(upgrades[1].url, '/_next/webpack-hmr?id=1')
  assert.equal(upgrades[1].headers.origin, `https://localhost:${tlsPort}`)
  assert.equal(upgrades[1].headers.host, `localhost:${tlsPort}`)
  peers.get(roomLeg('SECURE000000')).write(frame(1, 'over TLS'))
  await until(() => messages.some(m => m.url === roomLeg('SECURE000000') && m.payload.toString() === 'over TLS'), 'the TLS leg echoes through the room')
  secured.close(); running.delete(secured)
  // Without insecureLocal the same certificate is refused: CONNECT, and the room is never dialled.
  const connectionsBefore = tcpConnections
  const verifying = wsHelper.start({ ...tls, room: `ws://localhost:${port}${roomLeg('VERIFY000000')}` })
  running.add(verifying)
  await assert.rejects(within(verifying.connected, 'the unverified local leg fails'), { code: 'CONNECT' })
  assert.ok(tcpConnections > connectionsBefore, 'the local leg is tried')
  assert.equal(upgrades.length, 2, 'an unverified TLS dev server is never upgraded')
  assert.ok(!peers.has(roomLeg('VERIFY000000')), 'nor is its room leg dialled')
  verifying.close(); running.delete(verifying)
  // insecureLocal never reaches the room leg: a room with that certificate is refused.
  const fakeRoom = track(https.createServer({ key: pem.key, cert: pem.cert }))
  let roomUpgrades = 0, roomConnections = 0
  fakeRoom.on('connection', () => roomConnections++)
  fakeRoom.on('upgrade', (_req, socket) => { roomUpgrades++; socket.destroy() })
  const fakeRoomPort = await listen(fakeRoom)
  const unverified = wsHelper.start({ ...tls, insecureLocal: true, room: `wss://localhost:${fakeRoomPort}${roomLeg('ROOMLEG00000')}` })
  running.add(unverified)
  await until(() => roomConnections > 0, 'the room leg is tried')
  await pause(300)
  assert.equal(roomUpgrades, 0, 'the room leg verifies its certificate, insecureLocal or not')
  unverified.close(); running.delete(unverified)
  console.log('ok ordinary/public WS helper compatibility, strict settings (the old Host-TCP form refused), protocols/Origin, text/binary and graceful cleanup; a wss:// TLS dev server with insecureLocal on the local leg alone (the room leg verifies)')
}

// The public relay's failures, each told to the room as it happens: the
// local leg goes first, so a dev server that refuses the browser's socket is
// CONNECT (the row, exit 1) before the room is dialled; one that drops it
// mid-session closes the room's leg 1011, never 1000; and the browser's whole
// path, past 4 KiB, reaches the dev server.
async function publicRelayFailures() {
  const held = [], devs = new Map(), rooms = new Map()
  let roomConnections = 0
  const dev = track(http.createServer())
  dev.on('upgrade', (req, socket, head) => {
    if (req.url === '/refuse') return socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    if (req.url === '/hold') return held.push({ req, socket })
    handshake(req, socket)
    const leg = { socket, closes: [] }
    devs.set(req.url, leg)
    readFrames(socket, head, (op, payload) => { if (op === 8) { leg.closes.push(payload.readUInt16BE(0)); socket.end(frame(8, payload)) } })
  })
  const devPort = await listen(dev)
  const room = track(http.createServer())
  room.on('connection', () => roomConnections++)
  room.on('upgrade', (req, socket, head) => {
    handshake(req, socket)
    const leg = { socket, closes: [] }
    rooms.set(req.url, leg)
    readFrames(socket, head, (op, payload) => { if (op === 8) { leg.closes.push(payload.readUInt16BE(0)); socket.end(frame(8, payload)) } })
  })
  const roomPort = await listen(room)
  const legOf = id => `/api/rooms/${ROOM}/ws/${id}`
  const relayCfg = (path, id, port = devPort) => ({ local: `ws://localhost:${port}${path}`, origin: `http://localhost:${port}`, protocols: [], room: `ws://127.0.0.1:${roomPort}${legOf(id)}`, token: CAP, version: VERSION })

  // The room hears of the browser's socket only once the dev server took it.
  const waiting = wsHelper.start(relayCfg('/hold', 'HOLD00000000'))
  running.add(waiting)
  await until(() => held.length === 1, 'the dev server holds the local leg')
  await pause(200)
  assert.equal(roomConnections, 0, 'the room is dialled only once the local leg is open')
  handshake(held[0].req, held[0].socket)
  await within(waiting.connected, 'the held local leg opens')
  await until(() => rooms.has(legOf('HOLD00000000')), 'then the room leg')
  waiting.close(); running.delete(waiting)

  // Refused (nothing listening, or an HTTP answer): CONNECT and exit 1, the room never dialled.
  const nobody = await freePort()
  for (const [path, port, label] of [['/x', nobody, 'nothing listening'], ['/refuse', devPort, 'an HTTP answer, not an upgrade']]) {
    const before = roomConnections, log = launch(PUBLIC, relayCfg(path, 'DEAD00000000', port))
    await until(() => log.exit, `CONNECT: ${label}`)
    assert.deepEqual(log.rows, [{ state: 'error', code: 'CONNECT' }], label)
    assert.equal(log.exit.code, 1, label)
    assert.equal(log.stderr, '')
    assert.equal(roomConnections, before, `${label}: the room is never dialled`)
  }
  await assert.rejects(within(wsHelper.start(relayCfg('/x', 'DEAD00000001', nobody)).connected, 'CONNECT in process'), { code: 'CONNECT' })
  // Stopped before its local leg opened, it says nothing and exits 0: the plugin's own stop is no failure.
  const dialled = roomConnections, stopping = launch(PUBLIC, relayCfg('/hold', 'HOLD00000001'))
  await until(() => held.length === 2, 'a second held local leg')
  await stop(stopping)
  assert.deepEqual(stopping.rows, [])
  assert.equal(roomConnections, dialled)

  // Mid-session: a dev server that drops the socket (no close frame: a crash
  // or restart) closes the room's leg 1011; its own close code goes as it is.
  for (const [id, end, code] of [['DROP00000000', socket => socket.destroy(), 1011], ['BYE000000000', socket => socket.write(frame(8, Buffer.from([0x03, 0xe9]))), 1001]]) {
    const path = `/live-${id}`, relay = wsHelper.start(relayCfg(path, id))
    running.add(relay)
    await until(() => devs.has(path) && rooms.has(legOf(id)), `both legs (${id})`)
    end(devs.get(path).socket)
    await until(() => rooms.get(legOf(id)).closes.length, `the room leg closes (${id})`)
    assert.deepEqual(rooms.get(legOf(id)).closes, [code], id)
    running.delete(relay)
  }
  // A room leg that vanishes closes the dev server's 1000, as a browser leaving would.
  const gone = wsHelper.start(relayCfg('/live-GONE00000000', 'GONE00000000'))
  running.add(gone)
  await until(() => devs.has('/live-GONE00000000') && rooms.has(legOf('GONE00000000')), 'both legs (room gone)')
  rooms.get(legOf('GONE00000000')).socket.destroy()
  await until(() => devs.get('/live-GONE00000000').closes.length, 'the dev server leg closes')
  assert.deepEqual(devs.get('/live-GONE00000000').closes, [1000])
  running.delete(gone)

  // The browser's whole path and query (SignalR's access_token runs past 4
  // KiB) reach the dev server through the executable's stdin; past stdin's
  // 16 KiB the settings are refused.
  const longPath = `/hub?id=1&access_token=${'x'.repeat(8000)}`
  const long = launch(PUBLIC, relayCfg(longPath, 'LONG00000000'))
  await until(() => devs.has(longPath) && rooms.has(legOf('LONG00000000')), 'an 8,000-character local path reaches the dev server')
  await stop(long)
  assert.deepEqual(long.rows, [])
  await startupError(relayCfg(`/hub?access_token=${'x'.repeat(17_000)}`, 'LONG00000001'), 'INVALID_CONFIG', PUBLIC)
  console.log('ok public relay failures: the local leg first (the room dialled once it opens); refused or answered with HTTP is CONNECT, exit 1, the room never dialled; stopped first is quiet; a dropped dev server socket closes the room leg 1011, its own close code goes as is, a vanished room leg is 1000 to the dev server; an 8,000-character path reaches the dev server, stdin over 16 KiB refused')
}

async function bridgeChecks() {
  const control = row => frame(1, JSON.stringify(row)), ready = control({ t: 'ready' }), credit = n => control({ t: 'credit', n, nonce: 'N'.repeat(24) })
  let attack
  const checksSaid = []
  const fixture = track(http.createServer())
  fixture.on('upgrade', (req, socket, head) => { checksSaid.push(req.headers['x-tcp-checks']); handshake(req, socket); attack(socket, head) })
  const url = `http://127.0.0.1:${await listen(fixture)}/api/rooms/${ROOM}/previews/${PID}/tunnel`
  for (const bytes of [frame(2, 'before ready'), Buffer.concat([ready, ready]), Buffer.concat([ready, credit(1)]), Buffer.concat([ready, frame(2, 'a'), frame(2, 'b')]), Buffer.concat([ready, frame(2, 'a'), credit(2)]), Buffer.concat([ready, control({ t: 'fin' }), control({ t: 'fin' })]), Buffer.concat([ready, control({ t: 'unknown' })]), Buffer.concat([ready, frame(1, 'x'.repeat(257))]), Buffer.concat([ready, control({ t: 'check', nonce: 'short' })]), Buffer.concat([ready, control({ t: 'check', n: 1, nonce: 'C'.repeat(24) })])]) {
    const states = []
    attack = socket => socket.write(bytes)
    const listener = await helper.start({ ...dummy(await freePort()), url }, { emit: row => states.push(row) })
    running.add(listener)
    const client = await wire(listener.port)
    await until(() => client.closed, 'invalid DATA/control closes TCP')
    assert.ok(states.some(row => row.state === 'channel-error' && row.code === 'PROTOCOL'), JSON.stringify(states))
    await listener.close(); running.delete(listener)
  }
  // A policy close is not proof of bad credentials; only HTTP 401/403 is.
  for (const [code, expected] of [[1008, 'CONNECT'], [1013, 'BUSY']]) {
    const states = []
    attack = socket => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(code); socket.end(Buffer.concat([ready, frame(8, bytes)])) }
    const listener = await helper.start({ ...dummy(await freePort()), url }, { emit: row => states.push(row) })
    running.add(listener)
    const client = await wire(listener.port)
    await until(() => client.closed, `policy close ${code}`)
    assert.ok(states.some(row => row.state === 'channel-error' && row.code === expected), JSON.stringify(states))
    assert.ok(!states.some(row => row.state === 'error' || row.code === 'AUTH'))
    await listener.close(); running.delete(listener)
  }
  let roomSocket, received = [], noCredit = true
  attack = (socket, head) => {
    roomSocket = socket
    readFrames(socket, head, (op, bytes) => received.push({ op, bytes }))
    socket.write(Buffer.concat([ready, frame(2, 'reply')]))
  }
  const states = [], listener = await helper.start({ ...dummy(await freePort()), url }, { emit: row => states.push(row) })
  running.add(listener)
  const client = await wire(listener.port)
  await until(() => client.bytes.length === 5, 'raw DATA delivered to TCP')
  await pause(30)
  assert.equal(received.length, 0, 'receiver cannot guess ACK without server challenge')
  roomSocket.write(credit(5)); noCredit = false
  await until(() => received.length === 1, 'challenge ACK')
  assert.deepEqual(JSON.parse(received[0].bytes), { t: 'ack', n: 5, nonce: 'N'.repeat(24) })
  // A check, which this helper said it answers as it connected: its nonce back, and nothing else.
  assert.ok(checksSaid.length && checksSaid.every(said => said === '1'), JSON.stringify(checksSaid))
  roomSocket.write(control({ t: 'check', nonce: 'C'.repeat(24) }))
  await until(() => received.length === 2, 'check answered')
  assert.deepEqual(JSON.parse(received[1].bytes), { t: 'seen', nonce: 'C'.repeat(24) })
  roomSocket.write(control({ t: 'fin' }))
  await until(() => received.some(row => row.op === 1 && JSON.parse(row.bytes).t === 'fin'), 'reverse FIN')
  roomSocket.end(frame(8, Buffer.from([3, 232])))
  await until(() => client.closed, 'normal FIN TCP close')
  assert.ok(!noCredit && states.every(row => ['ready', 'channel-ready'].includes(row.state)))
  await listener.close(); running.delete(listener)

  // Even a 1000 close is abnormal if the TCP halves did not finish.
  const disconnectedStates = []
  attack = socket => socket.end(Buffer.concat([ready, frame(8, Buffer.from([3, 232]))]))
  const disconnected = await helper.start({ ...dummy(await freePort()), url }, { emit: row => disconnectedStates.push(row) })
  running.add(disconnected)
  const oldTCP = await wire(disconnected.port)
  await until(() => oldTCP.closed, 'WS disconnect destroys unfinished TCP')
  assert.ok(disconnectedStates.some(row => row.code === 'CONNECT'))
  await disconnected.close(); running.delete(disconnected)

  let targetSocket
  const target = track(net.createServer(socket => { targetSocket = socket; socket.on('end', () => socket.end()) }))
  const targetPort = await listen(target), timeoutStates = []
  attack = () => {} // WS upgrade succeeds, but the room never pairs it.
  const timedHost = tcpRelay.startHost({ port: targetPort, room: url.replace(/^http/, 'ws').replace(`/previews/${PID}/tunnel`, '/ws/HHHHHHHHHHHH'), token: CAP, version: VERSION }, { emit: row => timeoutStates.push(row), timeoutMs: 80 })
  await timedHost.closed
  await until(() => targetSocket?.destroyed, 'host timeout closes loopback target')
  assert.deepEqual(timeoutStates, [{ state: 'error', code: 'TIMEOUT' }])

  const sent = [], payload = randomBytes(300 * 1024 + 37)
  let forwarding = false, incomingACK = false, closing = false
  attack = (socket, head) => {
    roomSocket = socket
    readFrames(socket, head, (op, bytes) => {
      if (op === 2) {
        sent.push(Buffer.from(bytes))
        if (forwarding) socket.write(control({ t: 'ack', n: bytes.length, nonce: randomBytes(18).toString('base64url') }))
      } else if (op === 1) {
        const row = JSON.parse(bytes)
        if (row.t === 'ack') incomingACK = true
        if (row.t === 'fin' && !closing) { closing = true; socket.end(Buffer.concat([control({ t: 'fin' }), frame(8, Buffer.from([3, 232]))])) }
      }
    })
    socket.write(ready)
  }
  const windowRun = await helper.start({ ...dummy(await freePort()), url }, { emit: () => {} })
  running.add(windowRun)
  const windowClient = await wire(windowRun.port); windowClient.client.end(payload)
  await until(() => sent.length === 4, 'four-frame outstanding window')
  await pause(50)
  assert.equal(sent.length, 4, 'no fifth frame before ACK')
  assert.ok(sent.every(bytes => bytes.length <= 65536))
  assert.ok(Buffer.concat(sent).length <= 256 * 1024)
  roomSocket.write(Buffer.concat([frame(2, 'reverse'), credit(7)]))
  await until(() => incomingACK, 'reverse ACK stays readable despite full send window')
  forwarding = true
  for (const bytes of sent) roomSocket.write(control({ t: 'ack', n: bytes.length, nonce: randomBytes(18).toString('base64url') }))
  await until(() => windowClient.closed, 'window resumes and both FINs drain')
  assert.deepEqual(Buffer.concat(sent), payload)
  assert.equal(windowClient.bytes.toString(), 'reverse')
  await windowRun.close(); running.delete(windowRun)
  console.log('ok ready/DATA-credit pairing/control validation, no guessed ACK, a check answered with its nonce, four-frame window, reverse ACK without deadlock and FIN ordering')
}

async function workerChecks() {
  const notices = [], upgrades = [], peers = new Map(), localSockets = new Set()
  let holdRejects = false
  const fixture = track(http.createServer((req, res) => {
    const chunks = []
    req.on('data', data => chunks.push(data))
    req.on('end', () => {
      notices.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) })
      if (!holdRejects) res.end('{}')
    })
  }))
  fixture.on('upgrade', (req, socket, head) => {
    upgrades.push({ path: req.url, headers: req.headers })
    peers.set(req.url, socket)
    socket.once('close', () => { if (peers.get(req.url) === socket) peers.delete(req.url) })
    handshake(req, socket)
    readFrames(socket, head, (op, payload) => { if (op === 8) socket.end(frame(8, payload)) })
    // Half are paired, half wait: both kinds count against the worker's cap.
    if (Number(req.url.split('/').at(-1).slice(2)) < 32) socket.write(frame(1, '{"t":"ready"}'))
  })
  const room = `http://127.0.0.1:${await listen(fixture)}/api/rooms/${ROOM}`
  const controlToken = randomBytes(32).toString('hex'), cfg = { room, token: CAP, controlToken, version: VERSION }
  for (const bad of ['{bad', 'x'.repeat(20_000), { ...cfg, extra: 1 }, { ...cfg, token: 'bad' }, { ...cfg, controlToken: CAP }, { ...cfg, token: controlToken }, { ...cfg, controlToken: 'x'.repeat(42) }, { ...cfg, room: room + '/' }, { ...cfg, room: room + '?x=1' }, { ...cfg, room: room.replace('http:', 'ws:') }, { ...cfg, room: room.replace('127.0.0.1', 'other.test') }, { ...cfg, room: room.replace('/api/', '/a/../api/') }, { ...cfg, room: room.replace('http://', 'http://user:pass@') }]) await startupError(bad, 'INVALID_CONFIG', HOST)
  const host = await worker(room), row = { op: 'open', id: 'CH0000000000', pid: 'pv1', port: await freePort() }
  // The helpers' one control server (tcp-relay.cjs): 403 for the token, Host or Origin; 413 over the 4 KiB body; 400 malformed.
  for (const [options, status] of [[{ headers: { authorization: '' } }, 403], [{ headers: { authorization: `Bearer ${CAP}` } }, 403], [{ headers: { host: `localhost:${host.port}` } }, 403], [{ headers: { origin: '' } }, 403], [{ headers: { origin: 'https://elsewhere.test' } }, 403], [{ method: 'PUT' }, 400], [{ path: '/open' }, 400], [{ headers: { 'content-type': 'text/plain' } }, 400], [{ body: 'x'.repeat(4097) }, 413], [{ body: 'x'.repeat(4097), headers: { 'transfer-encoding': 'chunked' } }, 413], [{ body: '{bad' }, 400], [{ body: Buffer.from([255]) }, 400]]) assert.equal((await ipc(host, row, options)).status, status, JSON.stringify(options).slice(0, 80))
  for (const bad of [null, [], {}, { ...row, id: '../not-an-id' }, { ...row, pid: '' }, { ...row, pid: 'a'.repeat(65) }, { ...row, port: '123' }, { ...row, port: 0 }, { ...row, port: 65536 }, { ...row, token: CAP }, { ...row, url: room }, { op: 'close-preview' }, { op: 'close-preview', pid: 'pv1', port: 1 }, { op: 'reject', id: row.id, code: 'AUTH' }, { op: 'reject', id: row.id, code: 'CONNECT', url: room }]) assert.equal((await ipc(host, bad)).status, 400)
  assert.equal(upgrades.length, 0, 'invalid commands never reach a target')
  const check = await ipc(host, { op: 'close-preview', pid: 'pv1' })
  assert.equal(check.status, 200)
  assert.equal(check.headers.connection, 'close')
  assert.deepEqual(JSON.parse(check.body), { ok: true })
  // Unfinished headers and bodies share the same eight-socket hard deadline.
  const stalled = []
  for (let i = 0; i < 8; i++) {
    const connection = await wire(host.port)
    connection.client.write(i < 4 ? 'POST / HTTP/1.1\r\n' : `POST / HTTP/1.1\r\nHost: 127.0.0.1:${host.port}\r\nAuthorization: Bearer ${host.controlToken}\r\nContent-Type: application/json\r\nContent-Length: 99\r\n\r\n{`)
    stalled.push(connection)
  }
  const excessControl = await wire(host.port)
  await until(() => excessControl.closed, 'ninth control socket refused')
  assert.match(excessControl.bytes.toString(), /^HTTP\/1\.1 503 Service Unavailable\r\n/, 'the ninth is answered 503 at once')
  assert.ok(stalled.every(s => !s.closed))
  const refusedOpen = await ipc(host, { ...row, id: 'REFUSED00000' })
  assert.equal(refusedOpen.status, 503, 'a whole command on a refused socket is answered 503')
  await until(() => stalled.every(s => s.closed), 'slow headers/bodies time out', 3500)
  assert.equal((await ipc(host, { op: 'close-preview', pid: 'pv1' })).status, 200)
  const oversizedHeader = await wire(host.port)
  oversizedHeader.client.write(`POST / HTTP/1.1\r\nX-Large: ${'a'.repeat(9000)}\r\n\r\n`)
  await until(() => oversizedHeader.closed, 'oversized control headers refused')
  assert.match(oversizedHeader.bytes.toString(), /^HTTP\/1\.1 400/)

  const missing = 'MISSING00000', began = Date.now()
  assert.equal((await ipc(host, { ...row, id: missing })).status, 200, 'open accepts before localhost connects')
  await until(() => host.rows.some(r => r.state === 'closed' && r.id === missing), 'failed local TCP releases reservation')
  await until(() => notices.some(r => r.path === `/api/rooms/${ROOM}/ws/${missing}/reject`), 'failed TCP rejects pending remote channel')
  assert.ok(Date.now() - began < 2000, 'local failure does not wait for the pairing deadline')
  assert.ok(!upgrades.some(r => r.path.endsWith(missing)), 'never fake-pair before localhost connects')
  assert.deepEqual(host.rows.find(r => r.id === missing), { state: 'closed', id: missing, code: 'CONNECT' })
  assert.deepEqual(notices.at(-1).body, { code: 'CONNECT' })
  assert.equal(notices.at(-1).headers.authorization, `Bearer ${CAP}`)
  assert.equal(notices.at(-1).headers['x-shared-session-version'], VERSION)

  // Each open of a port nobody listens on is refused CONNECT to the room: 64 such at once, at most.
  holdRejects = true
  const beforeRejects = notices.length, nobody = await freePort()
  for (let i = 0; i < 80; i++) assert.equal((await ipc(host, { op: 'open', id: `RJ${String(i).padStart(10, '0')}`, pid: 'pv1', port: nobody })).status, 200)
  await until(() => notices.length >= beforeRejects + 64, 'reject notification bound exercised')
  await until(() => host.rows.filter(r => r.state === 'closed' && r.id.startsWith('RJ')).length === 80, 'every refused open released')
  assert.equal(notices.length, beforeRejects + 64, 'no unbounded reject queue')
  await pause(2100)
  holdRejects = false
  assert.equal((await ipc(host, { op: 'open', id: 'REJECTAGAIN', pid: 'pv1', port: nobody })).status, 200)
  await until(() => notices.at(-1).path.endsWith('/REJECTAGAIN/reject'), 'reject slots recover after timeout')
  assert.equal(notices.length, beforeRejects + 65, 'rejects are never retried')

  const target = track(net.createServer({ allowHalfOpen: true }, socket => { localSockets.add(socket); socket.once('close', () => localSockets.delete(socket)); socket.on('end', () => socket.end()) }))
  const targetPort = await listen(target), commands = Array.from({ length: 64 }, (_, i) => ({ op: 'open', id: `CH${String(i).padStart(10, '0')}`, pid: i % 2 ? PID : 'pv1', port: targetPort }))
  for (const command of commands) assert.equal((await ipc(host, command)).status, 200)
  await until(() => peers.size === 64 && localSockets.size === 64, '64 active + connecting host relays')
  assert.equal((await ipc(host, { ...commands[0], pid: PID, port: 1 })).status, 200, 'duplicate id is idempotent even while full')
  await pause(30)
  assert.equal(localSockets.size, 64)
  assert.equal(upgrades.length, 64)
  const extra = await ipc(host, { ...commands[0], id: 'OVERFLOW0000' })
  assert.equal(extra.status, 429)
  assert.deepEqual(JSON.parse(extra.body), { ok: false, code: 'BUSY' })
  await until(() => notices.some(r => r.path.endsWith('/OVERFLOW0000/reject') && r.body.code === 'BUSY'), 'full worker rejects pending room channel')
  assert.equal(localSockets.size, 64, 'full worker creates no local peer')
  assert.equal((await ipc(host, { op: 'close-preview', pid: 'pv1' })).status, 200)
  const closed = id => host.rows.filter(r => r.state === 'closed' && r.id === id)
  await until(() => commands.filter(c => c.pid === 'pv1').every(c => closed(c.id).length === 1), 'only selected preview releases')
  assert.ok(commands.filter(c => c.pid === PID).every(c => closed(c.id).length === 0), 'other preview is untouched')
  assert.equal((await ipc(host, commands[0])).status, 200, 'a released id can be admitted afresh')
  await until(() => localSockets.size === 33, 'released worker capacity reused')
  await stop(host)
  assert.equal(closed(commands[0].id).length, 2)
  assert.ok(commands.slice(1).every(c => closed(c.id).length === 1), 'shutdown closes each admitted peer exactly once')
  await until(() => localSockets.size === 0 && peers.size === 0, 'worker shutdown owns all TCP/WS sockets')
  const rebound = track(net.createServer()); await listen(rebound, '127.0.0.1', host.port); await close(rebound)
  assert.deepEqual(host.rows.filter(r => r.state === 'ready'), [{ state: 'ready', port: host.port }])
  assert.ok(!host.stdout.includes(host.controlToken) && !host.stdout.includes(CAP))
  assert.ok(!host.rows.some(r => r.id === 'REFUSED00000') && !notices.some(r => r.path.includes('REFUSED00000')), 'the open refused 503 never ran')
  console.log('ok production worker bootstrap/IPC auth/Host/Origin 403, schema 400, body 413, header/socket deadlines (the ninth 503, its command never run), duplicate ids, 64-peer cap, bounded rejects, setup failure, preview isolation and owned shutdown')
}

async function listenerChecks() {
  const preferred = await freePort(), cfg = dummy(preferred)
  for (const bad of ['{broken', 'x'.repeat(20_000), { ...cfg, port: 0 }, { ...cfg, port: 0, strict: undefined }, { ...cfg, port: '0', strict: false }, { ...cfg, port: -1, strict: false }, { ...cfg, port: 0.5, strict: false }, { ...cfg, port: '123' }, { ...cfg, port: 65536 }, { ...cfg, strict: undefined }, { ...cfg, ticket: 'old' }, { ...cfg, token: 'bad\r\nsecret' }, { ...cfg, expiresAt: 'tomorrow' }, { ...cfg, url: cfg.url + '?' }, { ...cfg, url: cfg.url + '#' }, { ...cfg, url: cfg.url.replace('http://', 'http://user:password@') }, { ...cfg, url: cfg.url.replace('127.0.0.1:1', 'unrelated.test') }, { ...cfg, url: cfg.url.replace('/tunnel', '/other') }, { ...cfg, url: cfg.url.replace('/api/', '/a/../api/') }]) await startupError(bad, 'INVALID_CONFIG')
  await startupError({ ...cfg, expiresAt: Date.now() - 1 }, 'EXPIRED')
  const busy = track(net.createServer(s => s.end('unrelated listener'))), busyPort = await listen(busy)
  await startupError(dummy(busyPort), 'EADDRINUSE')
  const automatic = await ready({ ...dummy(busyPort), strict: false })
  assert.notEqual(automatic.port, busyPort)
  const unrelated = await wire(busyPort)
  await until(() => unrelated.closed, 'unrelated listener still works')
  assert.equal(unrelated.bytes.toString(), 'unrelated listener')
  await stop(automatic)
  if (ipv6) {
    const busy6 = track(net.createServer(s => s.end('IPv6 listener'))), busy6Port = await listen(busy6, '::1')
    await startupError(dummy(busy6Port), 'EADDRINUSE')
    const rolledBack = track(net.createServer()); await listen(rolledBack, '127.0.0.1', busy6Port); await close(rolledBack)
    const fallback = await ready({ ...dummy(busy6Port), strict: false })
    assert.notEqual(fallback.port, busy6Port)
    const stillFree4 = track(net.createServer()); await listen(stillFree4, '127.0.0.1', busy6Port); await close(stillFree4)
    await stop(fallback)
    const original = await wire(busy6Port, '::1'); await until(() => original.closed, 'unrelated IPv6 listener')
    assert.equal(original.bytes.toString(), 'IPv6 listener')
  }
  // macOS lets a specific bind sit beside another process's wildcard listener
  // (SO_REUSEADDR) and silently take its localhost traffic; Linux refuses the
  // bind itself. Either way the owner keeps every connection.
  for (const host of [undefined, '0.0.0.0']) {
    const label = host ?? 'listen(P) without a host'
    const owner = track(net.createServer(s => s.end('wildcard owner')))
    const ownerPort = await new Promise((resolve, reject) => {
      owner.once('error', reject)
      owner.listen(host ? { host, port: 0 } : { port: 0 }, () => { owner.removeListener('error', reject); resolve(owner.address().port) })
    })
    await startupError(dummy(ownerPort), 'EADDRINUSE')
    const moved = await ready({ ...dummy(ownerPort), strict: false })
    assert.notEqual(moved.port, ownerPort, `non-strict moves off ${label}`)
    for (const target of !host && ipv6 ? ['127.0.0.1', '::1'] : ['127.0.0.1']) {
      const reached = await wire(ownerPort, target)
      await until(() => reached.closed, `${label} keeps ${target}`)
      assert.equal(reached.bytes.toString(), 'wildcard owner', `${label} still receives ${target}:P`)
    }
    await stop(moved)
    await close(owner)
  }
  const vacantPort = await freePort(), exactly = await ready({ ...dummy(vacantPort), strict: false })
  assert.equal(exactly.port, vacantPort, 'a free requested port is still taken exactly')
  await stop(exactly)
  // The knock: a connection, or ~300 ms without an answer, means taken; only a
  // refusal (or no IPv6 at all) means free. Port 0 knocks only on ::1 (below).
  // The behaviors are the requested port's (`only`); any other number is free.
  const knocks = []
  const knock = (v4, v6, only) => ({ host, port }) => {
    knocks.push({ host, port })
    const behavior = only !== undefined && port !== only ? 'ECONNREFUSED' : host === '::1' ? v6 : v4, socket = new net.Socket()
    if (behavior !== 'silent') setImmediate(() => behavior === 'answer' ? socket.emit('connect') : socket.destroy(Object.assign(new Error('knock'), { code: behavior })))
    return socket
  }
  for (const [v4, v6, free] of [['ECONNREFUSED', 'ECONNREFUSED', true], ['ECONNREFUSED', 'EAFNOSUPPORT', true], ['ECONNREFUSED', 'EADDRNOTAVAIL', true], ['ENETUNREACH', 'ENETUNREACH', true],
    ['answer', 'ECONNREFUSED', false], ['ECONNREFUSED', 'answer', false], ['silent', 'ECONNREFUSED', false], ['ECONNREFUSED', 'silent', false], ['EACCES', 'ECONNREFUSED', false], ['ECONNREFUSED', 'ECONNRESET', false], ['EAFNOSUPPORT', 'ECONNREFUSED', false]]) {
    const wanted = await fixedPort(), began = Date.now()
    knocks.length = 0
    const run = await helper.start({ ...dummy(wanted), strict: false }, { emit: () => {}, connect: knock(v4, v6, wanted) })
    assert.deepEqual(knocks.filter(k => k.port === wanted).map(k => k.host).sort(), ['127.0.0.1', '::1'], 'both families are knocked on')
    assert.equal(run.port === wanted, free, `knock ${v4}/${v6}`)
    // A taken one moves to port 0, whose own number is knocked on ::1 alone.
    assert.deepEqual(knocks.filter(k => k.port !== wanted), free ? [] : [{ host: '::1', port: run.port }])
    if (v4 === 'silent' || v6 === 'silent') assert.ok(Date.now() - began >= 280, 'an unanswered knock waits out its deadline')
    else assert.ok(Date.now() - began < 280, 'knocks run in parallel and answer at once')
    await run.close()
  }
  const strictStates = []
  await assert.rejects(helper.start(dummy(await fixedPort()), { emit: row => strictStates.push(row), connect: knock('ECONNREFUSED', 'silent') }), { code: 'EADDRINUSE' })
  assert.deepEqual(strictStates, [{ state: 'error', code: 'EADDRINUSE' }], 'strict reports a taken port exactly as a bind conflict')
  // Port 0's own number is knocked on ::1 alone, after the IPv4 bind and
  // before the exact ::1 bind: the IPv4 allocator passes over an IPv6-only
  // listener's port ([::]:P), which macOS would let ::1:P sit beside. A number
  // answering there is rolled back and passed over for another.
  const knockedAt = []
  let answering
  const v6Owner = ({ host, port }) => {
    knockedAt.push({ host, port })
    answering ??= port
    const socket = new net.Socket()
    setImmediate(() => port === answering ? socket.emit('connect') : socket.destroy(Object.assign(new Error('knock'), { code: 'ECONNREFUSED' })))
    return socket
  }
  const passedOver = await helper.start({ ...dummy(0), strict: false }, { emit: () => {}, connect: v6Owner })
  assert.ok(knockedAt.length >= 2 && knockedAt.every(k => k.host === '::1'), `port 0 knocks ::1 alone, once a number: ${JSON.stringify(knockedAt)}`)
  assert.notEqual(passedOver.port, answering, 'a number answering on ::1 is passed over')
  assert.equal(knockedAt.at(-1).port, passedOver.port)
  for (const host of ipv6 ? ['127.0.0.1', '::1'] : ['127.0.0.1']) { const rolled = track(net.createServer()); await listen(rolled, host, answering); await close(rolled) }
  await passedOver.close()
  // Port 0 (non-strict only) takes one OS-assigned port and binds both families on it.
  const ephemeral = await ready({ ...cfg, port: 0, strict: false })
  assert.ok(ephemeral.port >= 1 && ephemeral.port <= 65535)
  assert.equal(ephemeral.ipv6, ipv6)
  for (const host of ipv6 ? ['127.0.0.1', '::1'] : ['127.0.0.1']) await assert.rejects(listen(track(net.createServer()), host, ephemeral.port), { code: 'EADDRINUSE' })
  assert.ok(!ephemeral.stdout.includes(CAP))
  await stop(ephemeral)
  let made = 0, firstPort
  const retried = await helper.start({ ...dummy(0), strict: false }, { emit: () => {}, createServer: (...args) => {
    const server = net.createServer(...args), index = ++made
    if (index === 1) server.once('listening', () => { firstPort = server.address().port })
    // The ::1 half of the first OS-assigned port conflicts: roll back, ask again.
    if (index === 2) server.listen = () => { queueMicrotask(() => server.emit('error', Object.assign(new Error(), { code: 'EADDRINUSE' }))); return server }
    return server
  } })
  assert.equal(made, 4)
  assert.ok(Number.isInteger(firstPort) && retried.port !== firstPort)
  assert.equal(retried.ipv6, ipv6)
  const releasedFirst = track(net.createServer()); await listen(releasedFirst, '127.0.0.1', firstPort); await close(releasedFirst)
  await retried.close()
  const good = await ready(cfg)
  assert.equal(good.port, preferred)
  assert.equal(good.stdout, JSON.stringify({ state: 'ready', port: preferred, ipv6 }) + '\n')
  assert.ok(!good.stdout.includes(CAP) && !good.stderr.includes(CAP))
  await stop(good)
  const again = await ready(cfg); await stop(again)
  // A requested port is cancelled during its knock; port 0 during a late 'listening'.
  for (const request of [dummy(await freePort()), { ...dummy(0), strict: false }]) {
    const states = [], controller = new AbortController()
    const cancelled = helper.start(request, { signal: controller.signal, emit: row => states.push(row), createServer: (...args) => {
      const server = net.createServer(...args), native = server.listen.bind(server)
      server.listen = (...args) => { setTimeout(() => native(...args), 30); return server }
      return server
    } })
    controller.abort()
    await assert.rejects(cancelled)
    assert.deepEqual(states, [], 'cancelled startup cannot emit late ready')
  }
  // Only a genuinely unsupported IPv6 bind permits IPv4-only operation.
  let number = 0
  const v4states = []
  const v4only = await helper.start(dummy(await freePort()), { emit: row => v4states.push(row), createServer: (...args) => {
    const server = net.createServer(...args)
    if (++number === 2) server.listen = () => { queueMicrotask(() => server.emit('error', Object.assign(new Error(), { code: 'EAFNOSUPPORT' }))); return server }
    return server
  } })
  assert.equal(v4only.ipv6, false)
  assert.deepEqual(v4states, [{ state: 'ready', port: v4only.port, ipv6: false }])
  await v4only.close()
  // A bind the system refuses (EACCES below 1024 on Linux, EPERM in a sandbox),
  // on either family, is DENIED and never STARTUP: strict reports it (the plugin
  // falls back as for a taken port); non-strict moves on as for a taken one.
  for (const [code, family] of [['EACCES', '127.0.0.1'], ['EPERM', '::1']]) {
    const wanted = await fixedPort(), refuse = (...args) => {
      const server = net.createServer(...args), native = server.listen.bind(server)
      server.listen = options => options.host === family && options.port === wanted ? (queueMicrotask(() => server.emit('error', Object.assign(new Error(), { code }))), server) : native(options)
      return server
    }
    const states = []
    await assert.rejects(helper.start(dummy(wanted), { emit: row => states.push(row), createServer: refuse }), { code: 'DENIED' })
    assert.deepEqual(states, [{ state: 'error', code: 'DENIED' }], `strict ${code} on ${family}`)
    const rebind = track(net.createServer()); await listen(rebind, '127.0.0.1', wanted); await close(rebind)
    const moved = [], elsewhere = await helper.start({ ...dummy(wanted), strict: false }, { emit: row => moved.push(row), createServer: refuse })
    assert.notEqual(elsewhere.port, wanted, `non-strict ${code} on ${family} moves to a free port`)
    assert.deepEqual(moved, [{ state: 'ready', port: elsewhere.port, ipv6: elsewhere.ipv6 }])
    await elsewhere.close()
  }
  assert.equal(tcpRelay.safeCode({ code: 'DENIED' }), 'DENIED')
  console.log(`ok bounded stdin/config, automatic vs strict port, knock before bind (wildcard owners keep localhost, timeout/refusal/no-IPv6 semantics; port 0 on ::1 alone, an answering number passed over), non-strict port 0 (OS-assigned, strict refused), rollback${ipv6 ? '/dual-stack' : ' (IPv6 unsupported)'}, explicit IP-family readiness, a refused bind DENIED (strict) or moved (non-strict), cancel/rebind/sanitized stdout`)
}

async function listenerCapacity() {
  let accepted = 0, paired = false
  const channels = []
  const fixture = track(http.createServer())
  fixture.on('upgrade', (req, socket, head) => {
    accepted++
    channels.push(socket)
    handshake(req, socket)
    readFrames(socket, head, (op, payload) => { if (op === 8) socket.end(frame(8, payload)) })
    if (paired) socket.write(frame(1, '{"t":"ready"}'))
  })
  const url = `http://127.0.0.1:${await listen(fixture)}/api/rooms/${ROOM}/previews/${PID}/tunnel`
  for (paired of [false, true]) {
    const states = [], clients = [], before = accepted
    const listener = await helper.start({ ...dummy(await freePort()), url }, { emit: row => states.push(row) })
    running.add(listener)
    for (let i = 0; i < 32; i++) clients.push(await wire(listener.port, ipv6 && i % 2 ? '::1' : '127.0.0.1'))
    await until(() => accepted === before + 32, '32 accepted/pending channels across both families')
    const extra = await wire(listener.port)
    await until(() => extra.closed, '33rd guest socket fails alone')
    assert.equal(extra.bytes.length, 0, 'BUSY never fabricates an HTTP reply')
    assert.ok(states.some(row => row.state === 'channel-error' && row.code === 'BUSY'))
    assert.ok(!states.some(row => row.state === 'error' || row.state === 'expired'))
    assert.ok(clients.every(client => !client.closed), 'capacity never tears down old channels')
    assert.equal(accepted, before + 32, 'over-capacity guest never opens a room WS')
    channels[before].end(frame(8, Buffer.from([3, 240])))
    await until(() => clients[0].closed, 'guest slot closed')
    const again = await wire(listener.port)
    await until(() => accepted === before + 33, 'guest slot reusable without listener restart')
    assert.equal(states.filter(row => row.state === 'ready').length, 1)
    const beforeCancel = states.length
    await listener.close(); running.delete(listener)
    await until(() => [...clients, again].every(c => c.closed), 'guest cancellation closes owned sockets')
    assert.equal(states.length, beforeCancel, 'cancellation is quiet')
  }
  console.log('ok guest 32-socket accepted/pending dual-family cap, per-channel BUSY, capacity reuse and quiet cancellation')
}

async function realChain() {
  let origin
  if (process.env.EXTERNAL_SERVER === '1') {
    assert.ok(process.env.SHARE_SERVER, 'SHARE_SERVER is required with EXTERNAL_SERVER=1')
    origin = new URL(process.env.SHARE_SERVER).origin
  } else {
    const mainPort = await freePort(), previewPort = await freePort()
    origin = `http://127.0.0.1:${mainPort}`
    const node = launch(NODE, undefined, { PORT: String(mainPort), PREVIEW_PORT: String(previewPort), PUBLIC_URL: origin, DATA_FILE: '', AUTH_TEST: '' })
    await until(() => node.stdout.includes('shared sessions on') || node.exit, 'Node room server', 10_000)
    assert.equal(node.exit, null, node.stderr)
  }
  async function api(path, token, body, expected = 200) {
    const res = await fetch(`${origin}${path}`, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json', 'x-shared-session-version': VERSION, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) })
    const result = await res.json()
    assert.equal(res.status, expected, JSON.stringify(result))
    return result
  }
  const room = await api('/api/rooms', null, { name: 'Host', title: 'TCP fixture' })
  const base = `/api/rooms/${room.id}`, guest = await api(`${base}/join`, null, { name: 'Guest' })
  const target = new URL(origin)
  const interruptible = target.protocol === 'http:' && (target.hostname === 'localhost' || target.hostname === '[::1]' || (net.isIP(target.hostname) === 4 && target.hostname.startsWith('127.')))
  // A stand-in for the network between a helper and the room, which can go
  // down. It passes each write on at once (no Nagle): holding a second small
  // write for the first's ACK, which Linux delays 40 ms, made every exchange
  // past it some 80 ms, and the 20,000-frame check below ran out of time on CI.
  async function faultGate() {
    const active = new Set()
    let online = true, refused = 0
    const server = track(net.createServer({ allowHalfOpen: true, noDelay: true }, client => {
      if (!online) { refused++; client.destroy(); return }
      const upstream = net.createConnection({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 80), allowHalfOpen: true, noDelay: true })
      const destroy = () => { client.destroy(); upstream.destroy() }
      for (const socket of [client, upstream]) {
        active.add(socket); sockets.add(socket)
        socket.on('error', destroy)
        socket.on('close', () => { active.delete(socket); sockets.delete(socket); destroy() })
      }
      client.pipe(upstream).pipe(client)
    }))
    const port = await listen(server)
    return { server, port, origin: `http://127.0.0.1:${port}`, active, get refused() { return refused },
      down() { online = false; for (const socket of active) socket.destroy() },
      up() { online = true },
    }
  }
  const guestGate = interruptible ? await faultGate() : null, hostGate = interruptible ? await faultGate() : null
  const guestOrigin = guestGate?.origin ?? origin, hostOrigin = hostGate?.origin ?? origin
  const seenTCP = [], hostLogs = [], sharedPorts = new Map(), commandFailures = []
  let hostWorker, startingWorker, hostControl = Promise.resolve()
  async function ensureWorker() {
    if (hostWorker && !hostWorker.exit) return hostWorker
    startingWorker ??= worker(`${hostOrigin}${base}`, room.token).then(log => { hostWorker = log; hostLogs.push(log); return log }).finally(() => { startingWorker = undefined })
    return startingWorker
  }
  function openHost(ask) {
    hostControl = hostControl.then(async () => {
      assert.match(ask.id, /^[A-Za-z0-9_-]{8,40}$/)
      assert.equal(sharedPorts.get(ask.port), ask.pid, 'driver rechecks authorized port/pid')
      const host = await ensureWorker()
      assert.equal((await ipc(host, { op: 'open', id: ask.id, pid: ask.pid, port: ask.port })).status, 200)
      host.ids ??= new Set()
      host.ids.add(ask.id)
    }).catch(error => { commandFailures.push(error) })
    return hostControl
  }
  const activeHost = () => (hostWorker.ids?.size ?? 0) - hostWorker.rows.filter(row => row.state === 'closed').length
  await ensureWorker()
  async function subscribe() {
    const state = { ready: false, closed: false }
    const req = (target.protocol === 'https:' ? https : http).get(`${origin}${base}/stream?after=0&tcp=1`, { headers: { authorization: `Bearer ${room.token}`, 'x-shared-session-version': VERSION } })
    requests.add(req)
    req.on('error', () => {})
    req.once('close', () => { state.closed = true; requests.delete(req) })
    req.on('response', res => {
      assert.equal(res.statusCode, 200)
      let input = ''
      res.on('data', bytes => {
        input += bytes
        let at
        while ((at = input.indexOf('\n')) !== -1) {
          const line = input.slice(0, at); input = input.slice(at + 1)
          if (!line) continue
          const row = JSON.parse(line)
          state.ready = true
          if (!row.tcp) continue
          seenTCP.push(row.tcp)
          assert.ok(Number.isInteger(row.tcp.port) && row.tcp.pid)
          void openHost(row.tcp)
        }
      })
      res.on('error', () => {})
    })
    await until(() => state.ready || state.closed, 'host TCP-capable control stream')
    assert.equal(state.ready, true)
    return { request: req, get closed() { return state.closed } }
  }
  let stream = await subscribe()
  async function share(port) {
    const pid = (await api(`${base}/previews`, room.token, { port, tcp: true })).pid
    sharedPorts.set(port, pid)
    return pid
  }
  async function grant(pid, member = guest.token) {
    const result = await api(`${base}/previews/${pid}/tunnel`, member)
    assert.equal(result.protocol, 1, 'server must support the fixed TCP protocol')
    assert.ok(Number.isSafeInteger(result.expiresAt) && result.expiresAt > Date.now())
    return { port: result.port, strict: false, url: `${guestOrigin}${base}/previews/${pid}/tunnel`, token: result.token, expiresAt: result.expiresAt }
  }
  const echo = track(net.createServer({ allowHalfOpen: true }, socket => {
    socket.on('data', bytes => { if (!socket.write(bytes)) socket.pause() })
    socket.on('drain', () => socket.resume())
    socket.on('end', () => socket.end(Buffer.from([0, 255, 70, 73, 78])))
  }))
  const echoPort = await listen(echo), echoPid = await share(echoPort), echoCfg = await grant(echoPid)
  const raw = await ready(echoCfg)
  assert.notEqual(raw.port, echoPort, 'guest default auto-selects when the host port is busy on this machine')
  const bytes = randomBytes(4 * 1024 * 1024 + 37), rawWire = await wire(raw.port)
  rawWire.client.end(bytes)
  await until(() => rawWire.closed, 'multi-frame binary + bidirectional FIN', 20_000)
  assert.deepEqual(rawWire.bytes, Buffer.concat([bytes, Buffer.from([0, 255, 70, 73, 78])]))
  const headers = Buffer.from('POST /callback?code=once HTTP/1.1\r\nHost: other-origin.test\r\nCookie: session=A; cs_pv=application-cookie\r\nCookie: extra=1\r\nAuthorization: Bearer application-auth\r\nOrigin: https://oauth-provider.test\r\nConnection: close, x-keep\r\nX-Keep: unchanged\r\nContent-Length: 4\r\n\r\n\x00\xffhi', 'latin1')
  const rawHeaders = await wire(raw.port); rawHeaders.client.end(headers)
  await until(() => rawHeaders.closed, 'raw HTTP headers')
  assert.deepEqual(rawHeaders.bytes.subarray(0, headers.length), headers)
  if (ipv6) {
    const v6guest = await wire(raw.port, '::1'); v6guest.client.end('ipv6 guest')
    await until(() => v6guest.closed, 'IPv6 guest')
    assert.ok(v6guest.bytes.subarray(0, 10).equals(Buffer.from('ipv6 guest')))
    const v6app = track(net.createServer({ allowHalfOpen: true }, socket => { socket.on('data', b => socket.write(b)); socket.on('end', () => socket.end()) }))
    // An IPv6-only app on a number nothing holds on 127.0.0.1 (the room's own
    // server could hold it there, and the host would reach that first).
    let v6port = await listen(v6app, '::1')
    while (!(await refused(v6port))) {
      await close(v6app)
      v6port = await listen(v6app, '::1')
    }
    const v6cfg = await grant(await share(v6port))
    const v6run = await ready({ ...v6cfg, port: await freePort(), strict: true })
    const v6host = await wire(v6run.port); v6host.client.end('host IPv6 fallback')
    await until(() => v6host.closed, 'IPv6-only host fallback')
    assert.equal(v6host.bytes.toString(), 'host IPv6 fallback')
    await stop(v6run)
  }
  console.log('ok real Room/control stream + host/guest helpers, binary/multiframe, exact headers and duplex FIN')

  // One connection past the ~20,000 frames after which a channel used to
  // close (each forwarded ack charged to its sender for the channel's life):
  // request/response, one byte a frame each way, its acks proving each half
  // read; and one way, the host's app writing a byte only once the last one
  // arrived, so each is a frame of its own and the guest sends nothing back,
  // the room's checks proving the host's helper read its acks. 800 frames a
  // second, under the room's 1024 a half (loopback answers far faster than
  // any room across a network, whose round trip bounds a four-frame window).
  {
    const FRAMES = 21_000, began = Date.now()
    let paced = Date.now()
    const pace = async i => { if (i % 400 === 399) { await pause(Math.max(0, paced + 500 - Date.now())); paced = Date.now() } }
    const ping = await wire(raw.port, '127.0.0.1', false)
    let echoed = 0, arrived
    ping.client.on('data', bytes => { echoed += bytes.length; arrived?.() })
    await within((async () => {
      for (let i = 0; i < FRAMES; i++) {
        const back = new Promise(resolve => (arrived = resolve))
        ping.client.write(Buffer.from([i & 255]))
        await back
        await pace(i)
      }
    })(), 'request/response past 20,000 frames', 120_000).catch(error => { throw new Error(`${error.message}: ${echoed} echoed in ${Date.now() - began} ms, closed ${ping.closed}`) })
    assert.equal(echoed, FRAMES)
    ping.client.end()
    await until(() => ping.closed, 'request/response channel finished', 10_000)
    let more = () => {}
    const drip = track(net.createServer({ allowHalfOpen: true }, socket => {
      let sent = 0
      more = () => { if (sent < FRAMES) socket.write(Buffer.from([sent++ & 255])); else if (!socket.writableEnded) socket.end() }
      more()
    }))
    const dripRun = await ready(await grant(await share(await listen(drip))))
    const oneWay = await wire(dripRun.port, '127.0.0.1', false)
    let dripped = 0
    paced = Date.now()
    oneWay.client.on('data', async bytes => {
      for (let i = 0; i < bytes.length; i++) { await pace(dripped++); more() }
    })
    await until(() => oneWay.closed, 'one way past 20,000 frames', 120_000).catch(error => { throw new Error(`${error.message}: ${dripped} arrived`) })
    assert.equal(dripped, FRAMES)
    assert.ok(!dripRun.rows.some(row => row.state === 'channel-error') && !hostWorker.rows.some(row => row.state === 'error'), JSON.stringify([...dripRun.rows, ...hostWorker.rows].filter(row => row.state?.includes('error'))))
    await stop(dripRun)
    console.log(`ok one connection past 20,000 frames: ${FRAMES} request/response exchanges and ${FRAMES} one-way frames (${((Date.now() - began) / 1000).toFixed(1)} s)`)
  }

  const appRequests = [], upgrades = [], largeResponses = [], LARGE = 24 * 1024 * 1024 + 11, chunk = Buffer.alloc(65536, 0x6a)
  let largeWritten = 0
  const app = track(http.createServer(async (req, res) => {
    const parts = []; for await (const bytes of req) parts.push(bytes)
    const body = Buffer.concat(parts), seen = { method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: body.toString('base64') }
    appRequests.push(seen)
    const url = new URL(req.url, 'http://fixture.test')
    if (url.pathname === '/drop') return req.socket.destroy()
    if (url.pathname === '/hold') { req.socket.once('end', () => req.socket.destroy()); return }
    if (url.pathname === '/binary') { res.writeHead(200, { 'content-length': body.length, 'set-cookie': ['one=1', 'two=2', 'cs_pv=app-owned'], 'x-keep': 'unchanged' }); return res.end(body) }
    if (url.pathname === '/redirect') { res.writeHead(302, { location: url.searchParams.get('to'), 'set-cookie': 'state=A; Path=/; HttpOnly; SameSite=Lax' }); return res.end() }
    if (url.pathname.startsWith('/status/')) { res.writeHead(Number(url.pathname.split('/').at(-1))); return res.end('app response') }
    if (url.pathname === '/large') {
      const response = { path: req.url, written: 0 }
      largeResponses.push(response)
      res.writeHead(200, { 'content-length': LARGE })
      try {
        for (let at = 0; at < LARGE && !res.destroyed; at += chunk.length) {
          const b = chunk.subarray(0, Math.min(chunk.length, LARGE - at))
          largeWritten += b.length; response.written += b.length
          if (!res.write(b)) await new Promise(resolve => {
            const done = () => { res.removeListener('drain', done); res.removeListener('close', done); resolve() }
            res.once('drain', done); res.once('close', done)
          })
        }
        res.end()
      } catch {}
      return
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (let i = 0; i < 8; i++) { res.write(`data: ${i}\n\n`); await pause(15) }
      return res.end()
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(seen))
  }))
  app.on('upgrade', (req, socket, head) => {
    upgrades.push({ headers: req.headers, rawHeaders: req.rawHeaders, head: Buffer.from(head) })
    handshake(req, socket, 'Set-Cookie: cs_pv=application-cookie\r\n')
    readFrames(socket, head, (op, payload) => {
      if (op === 8) return socket.end(frame(8, payload))
      socket.write(frame(op, payload))
    })
  })
  const appPort = await listen(app), appPid = await share(appPort), appCfg = await grant(appPid), live = await ready(appCfg), port = live.port
  const provider = 'https://oauth-provider.test', local = `http://localhost:${port}`
  const got = await request(port, '/nested/page?x=one%20two&x=three', { headers: { host: `unrelated.test:${port}`, origin: provider, referer: `${provider}/authorize`, cookie: 'session=A; cs_pv=browser-owned; flag=1', authorization: 'Bearer application-auth', 'x-keep': 'unchanged' } })
  const seen = JSON.parse(got.body)
  assert.equal(seen.url, '/nested/page?x=one%20two&x=three')
  assert.equal(seen.headers.host, `unrelated.test:${port}`)
  assert.equal(seen.headers.origin, provider)
  assert.equal(seen.headers.cookie, 'session=A; cs_pv=browser-owned; flag=1')
  assert.equal(seen.headers.authorization, 'Bearer application-auth')
  const binary = await request(port, '/binary', { method: 'POST', body: bytes, headers: { 'content-length': bytes.length } })
  assert.deepEqual(binary.body, bytes)
  assert.deepEqual(binary.headers['set-cookie'], ['one=1', 'two=2', 'cs_pv=app-owned'])
  assert.equal(binary.headers['x-keep'], 'unchanged')
  for (const location of [`${provider}/authorize?redirect_uri=${encodeURIComponent(local + '/callback')}`, `http://localhost:${appPort}/callback?code=1#done`, `${origin}/unchanged`]) assert.equal((await request(port, `/redirect?to=${encodeURIComponent(location)}`)).headers.location, location)
  for (const state of ['A', 'B']) {
    const cookie = `session=${state}; state=${state}`
    const get = JSON.parse((await request(port, `/callback?state=${state}&code=one`, { headers: { cookie, origin: provider } })).body)
    const post = JSON.parse((await request(port, '/callback', { method: 'POST', body: `state=${state}&code=two`, headers: { cookie, origin: provider, 'content-type': 'application/x-www-form-urlencoded' } })).body)
    assert.equal(get.headers.cookie, cookie); assert.equal(post.headers.cookie, cookie); assert.equal(post.headers.origin, provider)
  }
  for (const status of [401, 404]) { const before = appRequests.length; assert.equal((await request(port, `/status/${status}`, { method: 'POST', body: 'once' })).status, status); assert.equal(appRequests.length, before + 1) }
  const beforeDrop = appRequests.length
  await assert.rejects(request(port, '/drop', { method: 'POST', body: 'not replayed' }))
  await pause(100); assert.equal(appRequests.length, beforeDrop + 1)
  assert.equal((await request(port, '/new-connection')).status, 200, 'only a new TCP connection gets a new channel')
  assert.ok(appRequests.every(row => !JSON.stringify(row).includes(appCfg.token) && !JSON.stringify(row).includes(guest.token) && !JSON.stringify(row).includes(room.token)))
  console.log('ok HTTP/cookies/Host/Origin/auth unchanged, separate browser jars, external/absolute Location, callback GET/POST; no 401/404/reset replay')

  const browserHeaders = { origin: provider, cookie: 'session=A; cs_pv=application-cookie', authorization: 'Bearer app-WS' }
  async function openAppWS(localPort = port) {
    const state = { opened: false, closed: undefined, messages: [] }
    const socket = connect(`ws://localhost:${localPort}/ws`, browserHeaders, { open: () => (state.opened = true), message: (data, binary) => state.messages.push({ data, binary }), close: code => (state.closed = code) })
    await until(() => state.opened || state.closed !== undefined, 'application WS through TCP')
    assert.equal(state.opened, true)
    return { socket, state }
  }
  async function appEcho(ws, data, binary = false) {
    assert.equal(ws.state.closed, undefined, 'old application WS must still be connected')
    const count = ws.state.messages.length
    assert.equal(ws.socket.send(data, binary), true)
    await until(() => ws.state.messages.length > count, 'application WS echo')
    assert.deepEqual(ws.state.messages.slice(count), [{ data, binary }])
  }
  async function events() {
    let firstEvent, finished = false, received = ''
    const first = new Promise(resolve => (firstEvent = resolve))
    const pending = request(port, '/events', { host: 'localhost', onData: bytes => { received += bytes; if (received.includes('data: 0')) firstEvent() } }).then(result => { finished = true; return result })
    await Promise.race([first, pending])
    assert.equal(finished, false, 'SSE first event arrives before the response ends')
    const result = await pending
    assert.equal(result.headers['content-type'], 'text/event-stream')
    assert.equal(result.body.toString(), Array.from({ length: 8 }, (_, i) => `data: ${i}\n\n`).join(''))
  }
  const browser = await openAppWS()
  await appEcho(browser, 'HMR text')
  await appEcho(browser, Buffer.from([0, 255, 128]), true)
  assert.equal(upgrades.at(-1).headers.cookie, browserHeaders.cookie)
  assert.equal(upgrades.at(-1).headers.authorization, browserHeaders.authorization)
  assert.equal(upgrades.at(-1).headers.origin, provider)
  browser.socket.close(); await until(() => browser.state.closed !== undefined, 'application WS close')
  const slow = await wire(port, '127.0.0.1', false)
  slow.client.pause()
  slow.client.write(`GET /large HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`)
  await until(() => largeWritten > 0, 'large response begins')
  await pause(150)
  assert.ok(largeWritten < LARGE, 'slow consumer bounds upstream instead of buffering the whole response')
  slow.client.on('data', bytes => slow.parts.push(bytes)); slow.client.resume()
  await until(() => slow.closed, '24 MiB slow response drains', 30_000)
  const response = slow.bytes, end = response.indexOf('\r\n\r\n') + 4
  assert.equal(response.length - end, LARGE)
  assert.equal(createHash('sha256').update(response.subarray(end)).digest('hex'), createHash('sha256').update(Buffer.alloc(LARGE, 0x6a)).digest('hex'))
  await events()
  console.log('ok authenticated application WS/HMR, SSE and >old-HTTP-limit stream with slow-consumer backpressure')

  // A page and what it uses beside it, each its own preview, as Open forwards
  // them in the person's own browser: at fixed ports, strictly (the host's
  // numbers, were this another machine), and a raw TCP backend at a free
  // port. A fixed port taken here fails without touching its owner and binds
  // once free; another guest's listeners are its own; a Stop ends that
  // preview's streams alone, all on the room's one Host worker.
  {
    const frontPort = await freePort(), dataPort = await freePort()
    let finishSSE
    const releaseSSE = new Promise(resolve => { finishSSE = resolve })
    const backend = track(http.createServer(async (req, res) => {
      if (req.url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: first\n\n'); await releaseSSE; return res.end('data: last\n\n')
      }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ service: 'separate backend', url: req.url }))
    }))
    backend.on('upgrade', (req, socket, head) => {
      handshake(req, socket)
      readFrames(socket, head, (op, payload) => op === 8 ? socket.end(frame(8, payload)) : socket.write(frame(op, payload)))
    })
    const backendPort = await listen(backend)
    const html = `<!doctype html><title>Page fixture</title><script>fetch('http://127.0.0.1:${dataPort}/data');new WebSocket('ws://127.0.0.1:${dataPort}/ws')</script>`
    const frontend = track(http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(html) }))
    const frontendPort = await listen(frontend)
    const database = track(net.createServer({ allowHalfOpen: true }, socket => { socket.on('data', bytes => socket.write(bytes)); socket.on('end', () => socket.end()) }))
    const databasePort = await listen(database)
    const webPid = await share(frontendPort), dataPid = await share(backendPort), dbPid = await share(databasePort)
    const fixed = async (pid, port, seat = guest.token) => ({ ...(await grant(pid, seat)), port, strict: true })
    const workerIdentity = hostWorker.child.pid
    const dataCfg = await fixed(dataPid, dataPort)
    const blocker = track(net.createServer(socket => socket.end('unrelated fixed-port owner')))
    await listen(blocker, '127.0.0.1', dataPort)
    await startupError(dataCfg, 'EADDRINUSE')
    const untouched = await wire(dataPort); await until(() => untouched.closed, 'a fixed-port conflict leaves its owner alone')
    assert.equal(untouched.bytes.toString(), 'unrelated fixed-port owner')
    await close(blocker)
    const dataRun = await ready(dataCfg)
    assert.equal(dataRun.port, dataPort, 'a strict start binds its fixed port once free, never another')
    const frontRun = await ready(await fixed(webPid, frontPort)), dbRun = await ready(await grant(dbPid))
    assert.equal(frontRun.port, frontPort)
    assert.equal((await request(frontPort, '/nested?fixture=page')).body.toString(), html)
    assert.equal(JSON.parse((await request(dataPort, '/data')).body).service, 'separate backend')
    let firstData, firstBody = '', sseFinished = false
    const firstSSE = new Promise(resolve => (firstData = resolve))
    const pendingSSE = request(dataPort, '/events', { onData: bytes => { firstBody += bytes.toString(); if (firstBody.includes('data: first')) firstData() } }).then(result => { sseFinished = true; return result })
    await Promise.race([firstSSE, pendingSSE]); assert.equal(sseFinished, false)
    // Finish only after the first event arrives: scheduling may coalesce any timed gap.
    finishSSE()
    assert.equal((await pendingSSE).body.toString(), 'data: first\n\ndata: last\n\n')
    const dataWS = await openAppWS(dataPort)
    await appEcho(dataWS, 'separate dependency WS')
    const databaseWire = await wire(dbRun.port); databaseWire.client.write('raw backend bytes')
    await until(() => databaseWire.bytes.toString() === 'raw backend bytes', 'non-HTTP backend')
    // Another guest on this machine: its fixed attempt meets this guest's listener; a free port is its own.
    const peer = await api(`${base}/join`, null, { name: 'Second guest' })
    await startupError(await fixed(dataPid, dataPort, peer.token), 'EADDRINUSE')
    await appEcho(dataWS, "another guest's conflict leaves the working dependency alone")
    const peerFront = await ready(await grant(webPid, peer.token))
    assert.notEqual(peerFront.port, frontPort); assert.notEqual(peerFront.port, frontendPort)
    assert.equal((await request(peerFront.port)).body.toString(), html)
    // Stop of the dependency ends its streams; the others go on.
    await api(`${base}/previews/${dataPid}/end`, room.token)
    sharedPorts.delete(backendPort)
    await until(() => dataWS.state.closed !== undefined, "Stop ends the dependency's live WS")
    databaseWire.client.write(' survives another Stop')
    await until(() => databaseWire.bytes.toString().endsWith(' survives another Stop'), "another preview's stream survives a Stop")
    assert.equal((await request(frontPort)).body.toString(), html)
    assert.equal(hostWorker.child.pid, workerIdentity, 'every preview shares the room worker')
    await api(`${base}/previews/${dbPid}/end`, room.token)
    sharedPorts.delete(databasePort)
    await until(() => databaseWire.closed, "Stop ends the raw backend's stream")
    for (const log of [frontRun, dbRun, dataRun, peerFront]) await stop(log)
    await api(`${base}/previews/${webPid}/end`, room.token)
    sharedPorts.delete(frontendPort)
    await api(`${base}/leave`, peer.token)
    await until(() => activeHost() === 0, 'page checks release worker channels')
    // Upgraded fixture sockets are drained by the suite's global teardown;
    // server.close() alone waits for half-open upgraded sockets indefinitely.
    console.log("ok page + fixed-port HTTP/WS/SSE dependency + raw TCP backend; fixed-port conflict leaves its owner and retries exactly, another guest independent, a Stop ends that preview's streams alone, one Host worker")
  }

  // The isolated preview window, for real: Chrome with the production flags,
  // and Firefox with the production settings, talk only to the SOCKS proxy,
  // which routes the Host's port numbers to Guest helpers on OS-assigned
  // ports. Guest-owned servers hold the same numbers on [::1] and an unshared
  // port on 127.0.0.1; none of them may see a connection.
  const probed = []
  const realWindow = async (name, binary, start) => {
    const version = await promisify(execFile)(binary, ['--version'], { timeout: 15_000 }).then(({ stdout }) => stdout.trim(), () => 'unknown version')
    const E = await freePort(), D = await freePort(), U = await freePort(), marker = randomBytes(8).toString('hex')
    const counts = { hostE: 0, hostD: 0, ownE: 0, ownD: 0, ownU: 0 }, reports = [], dependency = [], upstreamTargets = []
    const bodyOf = req => new Promise(resolve => { const parts = []; req.on('data', bytes => parts.push(bytes)); req.on('end', () => resolve(Buffer.concat(parts).toString())) })
    const page = `<!doctype html><meta charset="utf-8"><title>Shared preview</title><script>
(async () => {
  const dep = 'http://127.0.0.1:${D}', result = { origin: location.origin, secure: isSecureContext }
  document.cookie = 'pagejs=J1; Path=/; SameSite=Lax'
  try { result.api = await (await fetch(dep + '/api')).json() } catch (error) { result.api = 'failed: ' + error }
  result.ws = await new Promise(resolve => {
    const timer = setTimeout(() => resolve('timeout'), 10000), ws = new WebSocket('ws://127.0.0.1:${D}/ws')
    ws.onopen = () => ws.send('ws-ping')
    ws.onmessage = event => { clearTimeout(timer); resolve('echo:' + event.data); ws.close() }
    ws.onerror = () => { clearTimeout(timer); resolve('error') }
  })
  result.sse = await new Promise(resolve => {
    const got = [], source = new EventSource(dep + '/events')
    const timer = setTimeout(() => { source.close(); resolve(got) }, 10000)
    source.onmessage = event => { got.push(event.data); if (got.length === 2) { clearTimeout(timer); source.close(); resolve(got) } }
  })
  result.visible = document.cookie
  try { result.cookies = (await (await fetch('/cookies')).json()).cookie } catch (error) { result.cookies = 'failed: ' + error }
  await fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) })
  let unshared = 'reached'
  try { await fetch('http://127.0.0.1:${U}/', { mode: 'no-cors', cache: 'no-store' }) } catch { unshared = 'refused' }
  await fetch('/report-final', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unshared }) })
})()
</script>`
    const app = track(http.createServer(async (req, res) => {
      const text = await bodyOf(req)
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': 'hostonly=H1; HttpOnly; Path=/; SameSite=Lax' })
        return res.end(page)
      }
      if (req.url === '/cookies') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ cookie: req.headers.cookie ?? '' })) }
      if (req.method === 'POST' && req.url.startsWith('/report')) { reports.push({ path: req.url, cookie: req.headers.cookie ?? '', body: JSON.parse(text) }); res.writeHead(204); return res.end() }
      res.writeHead(404); res.end()
    }))
    app.on('connection', () => counts.hostE++)
    const cors = { 'access-control-allow-origin': `http://localhost:${E}`, vary: 'origin' }
    const dependencyServer = track(http.createServer((req, res) => {
      res.on('error', () => {})
      dependency.push({ url: req.url, origin: req.headers.origin })
      if (req.url === '/api') { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify({ service: 'dependency', marker })) }
      if (req.url === '/events') {
        res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        res.write('data: one\n\n')
        return setTimeout(() => { if (!res.destroyed && !res.writableEnded) res.write('data: two\n\n') }, 50)
      }
      res.writeHead(404, cors); res.end()
    }))
    dependencyServer.on('connection', () => counts.hostD++)
    dependencyServer.on('upgrade', (req, socket, head) => {
      dependency.push({ url: req.url, origin: req.headers.origin, upgrade: true })
      handshake(req, socket)
      readFrames(socket, head, (op, payload) => op === 8 ? socket.end(frame(8, payload)) : socket.write(frame(op, payload)))
    })
    await listen(app, '127.0.0.1', E)
    await listen(dependencyServer, '127.0.0.1', D)
    const own = key => { const server = track(http.createServer((_req, res) => res.end('the Guest\'s own service'))); server.on('connection', () => counts[key]++); return server }
    if (ipv6) { await listen(own('ownE'), '::1', E); await listen(own('ownD'), '::1', D) }
    await listen(own('ownU'), '127.0.0.1', U)
    // The browser's own background traffic goes to a refusing upstream, not the internet.
    const refuser = track(net.createServer(socket => {
      let head = '', answered = false
      socket.on('data', bytes => {
        head += bytes.toString('latin1')
        if (answered || !head.includes('\r\n\r\n')) return
        answered = true
        upstreamTargets.push(/^CONNECT (\S+) /.exec(head)?.[1] ?? '?')
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      })
    }))
    const upstreamPort = await listen(refuser)
    const seat = await api(`${base}/join`, null, { name: `${name} guest` })
    const pidE = await share(E), pidD = await share(D)
    const helperE = await ready({ ...await grant(pidE, seat.token), port: 0, strict: false })
    const helperD = await ready({ ...await grant(pidD, seat.token), port: 0, strict: false })
    assert.ok([helperE.port, helperD.port].every(port => ![E, D, U].includes(port)), 'Guest helpers take OS-assigned ports, never the Host numbers')
    const controlToken = randomBytes(32).toString('base64url')
    const socks = launch(PROXY, { port: 0, controlToken, upstream: { kind: 'http', host: '127.0.0.1', port: upstreamPort, bypass: [] } })
    await until(() => socks.rows.length || socks.exit, 'browser proxy ready')
    assert.equal(socks.rows[0]?.state, 'ready', JSON.stringify(socks.rows) + socks.stderr)
    const [{ port: socksPort, control: controlPort }] = socks.rows
    assert.equal((await ipc({ port: controlPort, controlToken }, { op: 'routes', routes: { [E]: helperE.port, [D]: helperD.port }, startable: [] })).status, 200)
    const profile = await mkdtemp(`${scratch}/${name.toLowerCase()}-`)
    let browserLog = '', early
    const browser = await start({ socksPort, profile, url: `http://localhost:${E}/` })
    const exited = new Promise(resolve => browser.once('exit', (code, signal) => { early = { code, signal }; resolve() }))
    browser.once('error', error => { early = { error: error.message } })
    for (const stream of [browser.stdout, browser.stderr]) stream.on('data', bytes => { browserLog = (browserLog + bytes).slice(-6000) })
    try {
      await until(() => reports.some(r => r.path === '/report-final') || early, 'the page reports through the proxy', 90_000)
      assert.ok(!early, `${name} stopped early ${JSON.stringify(early)}: ${browserLog}`)
      const first = reports.find(r => r.path === '/report'), final = reports.find(r => r.path === '/report-final'), result = first.body
      assert.equal(result.origin, `http://localhost:${E}`, 'the page keeps the Host address as its origin')
      assert.equal(result.secure, true, 'http://localhost stays a secure context through the proxy')
      assert.deepEqual(result.api, { service: 'dependency', marker }, 'fetch to 127.0.0.1:D')
      assert.equal(result.ws, 'echo:ws-ping', 'WebSocket to 127.0.0.1:D')
      assert.deepEqual(result.sse, ['one', 'two'], 'EventSource to 127.0.0.1:D')
      assert.equal(result.visible, 'pagejs=J1', 'the HttpOnly cookie stays hidden from the page')
      for (const cookies of [result.cookies, first.cookie, final.cookie]) {
        assert.match(cookies, /(^|; )hostonly=H1(;|$)/, 'the HttpOnly cookie round-trips')
        assert.match(cookies, /(^|; )pagejs=J1(;|$)/, 'the page cookie round-trips')
      }
      assert.equal(final.body.unshared, 'refused', 'an unshared loopback port is refused')
      await until(() => socks.rows.some(r => r.state === 'blocked' && r.port === U), 'blocked reported for the unshared port')
      for (const port of [E, D, U]) assert.equal(socks.rows.filter(r => r.state === 'seen' && r.port === port).length, 1, `seen once for ${port}`)
      assert.deepEqual(socks.rows.filter(r => r.state === 'blocked' || r.state === 'want'), [{ state: 'blocked', port: U }])
      assert.ok(['/api', '/events'].every(url => dependency.some(hit => hit.url === url)) && dependency.some(hit => hit.upgrade && hit.url === '/ws'))
      assert.ok(dependency.every(hit => hit.origin === `http://localhost:${E}`), 'the dependency sees the page origin unchanged')
      // Every Host-side connection is one the worker opened for a tunnel channel.
      await until(() => counts.hostE === seenTCP.filter(t => t.pid === pidE).length && counts.hostD === seenTCP.filter(t => t.pid === pidD).length, 'Host apps see only tunnel connections')
      assert.ok([helperE, helperD].every(log => log.rows.some(r => r.state === 'channel-ready')), 'both helpers carried channels')
      assert.deepEqual([counts.ownE, counts.ownD, counts.ownU], [0, 0, 0], "the Guest's own servers got zero connections")
      assert.ok(upstreamTargets.every(target => !/^(localhost|127\.|\[::1\]|\[::ffff:|\[::\]|0\.0\.0\.0)/i.test(target)), 'loopback never goes upstream')
      for (const target of upstreamTargets) assert.ok(!socks.stdout.includes(target.replace(/:[0-9]+$/, '')), 'proxy stdout carries no outbound names')
      assert.ok(!socks.stdout.includes(controlToken))
      // The plugin's own probe finds the window as this one process, its proxy port with it, and its close ends it.
      if (windowScripts) {
        const seen = windowScripts.windowOf(await shOut(windowScripts.lockScript(profile)), profile)
        assert.deepEqual(seen, { pid: browser.pid, port: socksPort, family: name === 'Firefox' ? 'firefox' : 'chromium' }, `the plugin finds the ${name} window by its profile`)
        // A close for another proxy port (another session's, on a host's profile) leaves it alone.
        assert.equal((await shOut(windowScripts.killScript(profile, true, socksPort === 65535 ? socksPort - 1 : socksPort + 1))).trim(), '')
        assert.equal(windowScripts.windowOf(await shOut(windowScripts.lockScript(profile)), profile)?.pid, browser.pid, `the ${name} window on another port is left open`)
        assert.equal((await shOut(windowScripts.killScript(profile, true, socksPort))).trim(), 'killed')
        await Promise.race([exited, pause(10_000)])
        assert.ok(early, `the ${name} window ended`)
        assert.equal(await shOut(windowScripts.lockScript(profile)), '', 'nothing holds the profile then')
        probed.push(name)
      }
    } finally {
      await endBrowser(browser, exited, profile)
    }
    for (const log of [helperE, helperD, socks]) await stop(log)
    await api(`${base}/previews/${pidE}/end`, room.token)
    await api(`${base}/previews/${pidD}/end`, room.token)
    await api(`${base}/leave`, seat.token)
    sharedPorts.delete(E); sharedPorts.delete(D)
    await until(() => activeHost() === 0, `${name} channels released`, 15_000)
    console.log(`ok real ${name} window (${version}, production ${name === 'Firefox' ? 'settings' : 'flags'}, headless): origin localhost:${E} + secure context, fetch/WS/SSE to 127.0.0.1 dependency and HttpOnly/page cookies through the tunnel; unshared port refused + blocked; Guest-own ${ipv6 ? '[::1]:E/[::1]:D/' : ''}127.0.0.1:U servers untouched; helpers on OS ports; ${upstreamTargets.length} background requests refused upstream; ${probed.includes(name) ? "the plugin's probe found it by its profile and its close ended it" : "the plugin's probe not run (this Node can't load TypeScript)"}`)
  }
  {
    const chrome = await findChrome()
    if (!chrome.path) console.log(`SKIP real browser preview window (${chrome.reason})`)
    else await realWindow('browser', chrome.path, launchChrome(chrome.path))
  }
  {
    const firefox = await findFirefox()
    if (!firefox.path) console.log(`SKIP real Firefox preview window (${firefox.reason})`)
    else await realWindow('Firefox', firefox.path, launchFirefox(firefox.path))
  }

  const unavailablePort = await freePort(), unavailablePid = await share(unavailablePort)
  const unavailable = await ready({ ...await grant(unavailablePid), port: await freePort(), strict: true })
  const refusedAt = Date.now(), unavailableWire = await wire(unavailable.port)
  unavailableWire.client.end('not paired')
  await until(() => unavailableWire.closed, 'host localhost failure rejects pending channel promptly', 3000)
  assert.ok(Date.now() - refusedAt < 3000)
  assert.equal(unavailableWire.bytes.length, 0)
  assert.ok(unavailable.rows.some(row => row.state === 'channel-error' && row.code === 'CONNECT'))
  assert.ok(!unavailable.rows.some(row => row.state === 'error' || row.state === 'expired'))
  const nowAvailable = track(net.createServer({ allowHalfOpen: true }, socket => { socket.on('data', bytes => socket.write(bytes)); socket.on('end', () => socket.end()) }))
  await listen(nowAvailable, '127.0.0.1', unavailablePort)
  const retried = await wire(unavailable.port); retried.client.end('a new independent request')
  await until(() => retried.closed, 'same listener works after localhost becomes available')
  assert.equal(retried.bytes.toString(), 'a new independent request')
  assert.equal(unavailable.rows.filter(row => row.state === 'ready').length, 1)
  assert.ok(unavailable.rows.some(row => row.state === 'channel-ready'))
  await stop(unavailable)
  await api(`${base}/previews/${unavailablePid}/end`, room.token)

  const oneWorker = hostWorker.child.pid, halfTargets = [], halfClients = []
  const halfApp = track(net.createServer({ allowHalfOpen: true }, socket => {
    const state = { socket, data: [], ended: false }
    halfTargets.push(state)
    socket.on('data', bytes => state.data.push(bytes))
    socket.on('end', () => { state.ended = true }) // Keep the response half open.
  }))
  // halfApp counts raw connections; on one machine a knock on its (Host) port would be one.
  const halfPid = await share(await listen(halfApp)), halfRun = await ready({ ...await grant(halfPid), port: 0 })
  for (let i = 0; i < 6; i++) { const client = await wire(halfRun.port); client.client.end(`half-${i}`); halfClients.push(client) }
  await until(() => halfTargets.length === 6 && halfTargets.every(s => s.ended), 'six held half-closes reached app unchanged')
  assert.ok(halfClients.every(client => !client.closed && !client.ended))
  const longWS = await openAppWS(), heldParallel = []
  await appEcho(longWS, 'seven active streams including six half-closes')
  for (let i = 0; i < 8; i++) {
    const held = await wire(port)
    held.client.write(`GET /hold?parallel=${i} HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`)
    heldParallel.push(held)
    await until(() => appRequests.some(r => r.url === `/hold?parallel=${i}`), `held parallel ${i}`)
    if (i === 0) assert.equal((await request(port, '/ninth-stream')).status, 200, 'ninth stream works with eight already held')
  }
  assert.equal((await request(port, '/sixteenth-stream')).status, 200, 'sixteenth stream works with fifteen already held')
  assert.ok(activeHost() >= 15)
  assert.equal(hostWorker.child.pid, oneWorker)
  assert.equal(hostLogs.length, 1, 'one host process serves every socket')
  await appEcho(longWS, 'same WS survives the ninth and sixteenth channels')
  for (const target of halfTargets) target.socket.end(Buffer.concat(target.data))
  await until(() => halfClients.every(client => client.closed), 'held response halves finish normally')
  assert.deepEqual(halfClients.map(client => client.bytes.toString()), Array.from({ length: 6 }, (_, i) => `half-${i}`))
  for (const client of heldParallel) client.client.destroy()
  longWS.socket.close()
  await stop(halfRun)
  await api(`${base}/previews/${halfPid}/end`, room.token)
  await until(() => activeHost() === 0, 'parallel channels release all worker slots')
  console.log('ok one production worker: six held half-closes + long-lived app WS, ninth/sixteenth streams, normal FIN and capacity release')

  const guest2 = await api(`${base}/join`, null, { name: 'Guest two' }), guest3 = await api(`${base}/join`, null, { name: 'Guest three' })
  const second = await ready(await grant(appPid, guest2.token)), third = await ready(await grant(echoPid, guest3.token))
  const peerWS = await openAppWS(second.port), keptWS = await openAppWS()
  await appEcho(peerWS, 'another guest, same preview')
  const anotherPreview = await wire(third.port); anotherPreview.client.end('third guest, other preview')
  await until(() => anotherPreview.closed, 'another preview is isolated')
  assert.equal(anotherPreview.bytes.subarray(0, -5).toString(), 'third guest, other preview')
  const heldCapacity = []
  for (let i = 0; i < 31; i++) {
    const held = await wire(port)
    held.client.write(`GET /hold?capacity=${i} HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`)
    heldCapacity.push(held)
  }
  await until(() => appRequests.filter(r => r.url.startsWith('/hold?capacity=')).length === 31, '32 channels admitted for one guest')
  const localFull = await wire(port)
  await until(() => localFull.closed, 'local guest capacity fails only new connection')
  assert.equal(localFull.bytes.length, 0)
  assert.ok(live.rows.some(row => row.state === 'channel-error' && row.code === 'BUSY'))
  // A second listener bypasses the local 32 socket cap, not the seat's quota.
  const overflow = await ready(await grant(appPid))
  const seatFull = await wire(overflow.port)
  await until(() => seatFull.closed, 'room seat capacity returns BUSY')
  assert.equal(seatFull.bytes.length, 0)
  assert.ok(overflow.rows.some(row => row.state === 'channel-error' && row.code === 'BUSY'), JSON.stringify(overflow.rows))
  assert.ok(!overflow.rows.some(row => row.state === 'error' || row.state === 'expired' || row.code === 'AUTH'))
  await appEcho(keptWS, 'old WS still alive when this guest is full')
  await appEcho(peerWS, 'other guest is unaffected by capacity')
  assert.equal((await request(second.port, '/guest-two', { headers: { cookie: 'guest=two' } })).status, 200)
  const beforeRelease = activeHost()
  heldCapacity[0].client.destroy()
  await until(() => activeHost() < beforeRelease, 'one full-seat channel released')
  assert.equal((await request(overflow.port, '/after-capacity-release')).status, 200, 'same listener and grant recover when a slot frees')
  assert.equal(overflow.rows.filter(row => row.state === 'ready').length, 1)
  assert.ok(overflow.rows.some(row => row.state === 'channel-ready'))
  await appEcho(keptWS, 'same WS after capacity release')
  for (const held of heldCapacity) held.client.destroy()
  keptWS.socket.close(); peerWS.socket.close()
  await stop(overflow); await stop(second); await stop(third)
  await api(`${base}/leave`, guest2.token); await api(`${base}/leave`, guest3.token)
  await until(() => activeHost() === 0, 'multi-guest capacity test releases channels')
  console.log('ok three guests/two previews isolated; 32-seat/local capacity is BUSY not AUTH, old WS survives and listeners recover after release')

  const pressureWS = await openAppWS(), pressure = [], memory = [await rss(hostWorker)]
  for (let i = 0; i < 8; i++) {
    const client = await wire(port, '127.0.0.1', false)
    client.client.pause()
    client.client.write(`GET /large?pressure=${i} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`)
    pressure.push(client)
  }
  await until(() => largeResponses.filter(r => r.path.includes('pressure=')).length === 8, 'eight non-reading consumers start')
  for (let i = 0; i < 4; i++) { await pause(100); memory.push(await rss(hostWorker)) }
  const growing = largeResponses.filter(r => r.path.includes('pressure='))
  assert.ok(growing.every(r => r.written < LARGE), 'credit + TCP backpressure bounds every non-reading flow')
  // This is an observed RSS bound with headroom for Node, TLS and allocator
  // retention, not a claim that the protocol's 32 MiB credit sum is an RSS cap.
  assert.ok(Math.max(...memory) - memory[0] < 128 * 1024 * 1024, `bounded worker RSS growth: ${Math.max(...memory) - memory[0]}`)
  await appEcho(pressureWS, 'unrelated WS works while consumers do not read')
  for (const client of pressure) client.client.destroy()
  pressureWS.socket.close()
  await until(() => activeHost() === 0, 'non-reading flows release bounded queues', 10_000)
  assert.equal((await request(port, '/after-pressure')).status, 200)
  console.log('ok non-reading peers bound upstream queues and sampled worker RSS; unrelated WS and new connections remain usable')

  if (guestGate && hostGate) {
    const identity = live.child.pid, capability = appCfg.token
    const sameListener = () => {
      assert.equal(live.exit, null, 'the guest helper stays running throughout recovery')
      assert.equal(live.child.pid, identity)
      assert.equal(live.port, port)
      assert.equal(appCfg.token, capability)
      assert.deepEqual(live.rows.filter(row => row.state === 'ready'), [{ state: 'ready', port, ipv6: live.ipv6 }])
    }
    for (const [side, gate] of [['guest', guestGate], ['host', hostGate]]) {
      const marker = randomBytes(8).toString('hex'), path = `/hold?outage=${side}-${marker}`, body = `state=${marker}&code=once`
      const matching = () => appRequests.filter(row => row.method === 'POST' && row.url === path)
      const oldWS = await openAppWS()
      await appEcho(oldWS, `${side}: before outage`)
      const held = await wire(port)
      held.client.write(`POST ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
      await until(() => matching().length === 1, `${side} POST fully received before outage`)
      assert.equal(matching()[0].body, Buffer.from(body).toString('base64'))
      assert.ok(gate.active.size >= 4, 'both POST and app WS use the selected network leg')
      gate.down()
      await until(() => gate.active.size === 0, `${side} gate destroys both socket legs`)
      await until(() => held.closed, `${side} outage fails the in-flight POST`)
      await until(() => oldWS.state.closed !== undefined, `${side} outage closes the old application WS`)
      assert.equal(held.bytes.length, 0, 'no fabricated response and no old TCP continuation')
      assert.equal(matching().length, 1)
      const refused = gate.refused, blockedPath = `/offline-${side}-${marker}`
      const blocked = await wire(port)
      blocked.client.write(`GET ${blockedPath} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`)
      // A host-side failure before pairing uses the existing 10 s setup budget.
      await until(() => blocked.closed && gate.refused > refused, `${side} rejects a new connection while offline`, 15_000)
      assert.equal(blocked.bytes.length, 0)
      assert.ok(!appRequests.some(row => row.url === blockedPath))
      assert.equal(matching().length, 1)
      sameListener()
      gate.up()
      const recovered = await request(port, `/recovered-${side}-${marker}`, { host: 'localhost' })
      assert.equal(recovered.status, 200)
      assert.equal(JSON.parse(recovered.body).url, `/recovered-${side}-${marker}`)
      const newWS = await openAppWS()
      await appEcho(newWS, `${side}: new HMR connection`)
      await appEcho(newWS, Buffer.from([0, 255, 128]), true)
      newWS.socket.close(); await until(() => newWS.state.closed !== undefined, `${side} recovered WS closes`)
      await events()
      sameListener()
      assert.equal(oldWS.state.messages.length, 1, 'the dead application WS was not resumed')
      assert.ok(!appRequests.some(row => row.url === blockedPath), 'the refused connection was not replayed after recovery')
      assert.equal(matching().length, 1, 'recovery must not replay the accepted POST')
      console.log(`ok ${side} relay outage/refusal -> same localhost listener/cap recovers HTTP, app WS/HMR and SSE; old POST exactly once`)
    }
    const surviving = await openAppWS()
    await appEcho(surviving, 'before control-stream outage')
    stream.request.destroy()
    await until(() => stream.closed, 'host control stream disconnected')
    await appEcho(surviving, 'data still works without the host control stream')
    const before = seenTCP.length, blockedPath = `/control-offline-${randomBytes(8).toString('hex')}`
    const blocked = await wire(port)
    blocked.client.write(`GET ${blockedPath} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`)
    await until(() => blocked.closed, 'new TCP channel fails while control stream is offline', 15_000)
    assert.equal(blocked.bytes.length, 0)
    assert.ok(!appRequests.some(row => row.url === blockedPath))
    assert.equal(seenTCP.length, before)
    await appEcho(surviving, 'old data channel still works after failed new connection')
    // This driver resubscribes explicitly; the plugin's automatic retry has its own UI-fixture regression.
    stream = await subscribe()
    assert.equal((await request(port, '/control-recovered')).status, 200)
    assert.ok(seenTCP.length > before)
    await appEcho(surviving, 'same data channel after control resubscription')
    surviving.socket.close(); await until(() => surviving.state.closed !== undefined, 'surviving WS closes')
    sameListener()
    console.log('ok host control-stream outage preserves paired data; explicit resubscription restores new channels without renewing the cap')
  } else console.log('SKIP relay outage injection: requires a loopback HTTP room; other transport checks still run')

  await until(() => activeHost() === 0, 'old data channels ended before worker crash test')
  const crashedWorker = hostWorker, oldWS = await openAppWS(), crashPath = `/hold?worker-crash=${randomBytes(8).toString('hex')}`
  await appEcho(oldWS, 'before host worker crash')
  const crashPost = await wire(port)
  crashPost.client.write(`POST ${crashPath} HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Length: 4\r\n\r\nonce`)
  await until(() => appRequests.some(row => row.url === crashPath), 'POST accepted before worker crash')
  await hostControl
  crashedWorker.child.kill('SIGKILL')
  await until(() => crashedWorker.exit, 'host worker crashes')
  await until(() => crashPost.closed && oldWS.state.closed !== undefined, 'crash fails only old TCP streams')
  assert.equal(crashPost.bytes.length, 0)
  await pause(100)
  assert.equal(hostLogs.length, 1, 'idle crash never restarts or replays old opens')
  assert.equal((await request(port, '/worker-restarted-by-new-request')).status, 200)
  assert.equal(hostLogs.length, 2, 'only a new independent request starts a replacement worker')
  assert.notEqual(hostWorker.child.pid, crashedWorker.child.pid)
  assert.notEqual(hostWorker.controlToken, crashedWorker.controlToken)
  const newWS = await openAppWS()
  await appEcho(newWS, 'fresh WS after worker restart')
  newWS.socket.close()
  await pause(50)
  assert.equal(appRequests.filter(row => row.url === crashPath).length, 1, 'worker restart never replays an accepted POST')
  assert.equal(oldWS.state.messages.length, 1, 'old application WS is not resumed')
  assert.equal(live.rows.filter(row => row.state === 'ready').length, 1, 'guest listener survives worker restart')
  console.log('ok host worker crash fails old POST/WS without replay; only a new request starts one replacement worker')

  const expStates = [], expPort = await freePort()
  const expiring = await helper.start({ ...appCfg, port: expPort, strict: true, expiresAt: Date.now() + 500 }, { emit: row => expStates.push(row) })
  running.add(expiring)
  const expWire = await wire(expPort); expWire.client.write(`GET /hold HTTP/1.1\r\nHost: localhost:${expPort}\r\n\r\n`)
  await until(() => appRequests.at(-1)?.url === '/hold', 'active expiry channel')
  await until(() => expStates.some(row => row.state === 'expired'), 'cap expiry closes listener')
  await until(() => expWire.closed, 'expiry closes old TCP')
  assert.equal(expWire.bytes.length, 0, 'no fabricated HTTP reconnect page')
  await expiring.close(); running.delete(expiring)
  const rebound = await ready({ ...appCfg, port: expPort, strict: true }); await stop(rebound)
  async function denied(cfg) {
    const states = [], deniedRun = await helper.start({ ...cfg, port: await freePort(), strict: true }, { emit: row => states.push(row) })
    running.add(deniedRun)
    const deniedWire = await wire(deniedRun.port); deniedWire.client.end('must never reach an app')
    await until(() => deniedWire.closed, 'denied cap TCP destroyed')
    assert.equal(deniedWire.bytes.length, 0)
    assert.ok(states.some(row => row.state === 'channel-error' && row.code === 'AUTH'), JSON.stringify(states))
    assert.ok(!JSON.stringify(states).includes(cfg.token))
    await deniedRun.close(); running.delete(deniedRun)
  }
  const appCount = appRequests.length
  await denied({ ...appCfg, token: guest.token })
  await denied({ ...appCfg, url: echoCfg.url })
  const otherRoom = await api('/api/rooms', null, { name: 'Other' })
  await denied({ ...appCfg, url: appCfg.url.replace(room.id, otherRoom.id) })
  assert.equal(appRequests.length, appCount, 'room member tokens and wrong-pid/room caps cannot open a tunnel')
  const stopWire = await wire(port); stopWire.client.write(`GET /hold HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`)
  await until(() => appRequests.length === appCount + 1, 'active stop channel')
  await api(`${base}/previews/${appPid}/end`, room.token)
  await until(() => stopWire.closed, 'server Stop revokes active channel')
  const leaveWire = await wire(raw.port); leaveWire.client.write('before leaving')
  await until(() => leaveWire.bytes.length, 'active leave channel')
  await api(`${base}/leave`, guest.token)
  await until(() => leaveWire.closed, 'server Leave revokes active cap/channel')
  await stop(raw); await stop(live)
  const finalGuest = await api(`${base}/join`, null, { name: 'Last guest' })
  const finalRun = await ready(await grant(echoPid, finalGuest.token))
  const finalWire = await wire(finalRun.port); finalWire.client.write('before room End')
  await until(() => finalWire.bytes.length, 'active room End channel')
  await api(`${base}/end`, room.token)
  await until(() => finalWire.closed, 'server End revokes active channel')
  await stop(finalRun)
  await api(`/api/rooms/${otherRoom.id}/end`, otherRoom.token)
  await hostControl
  assert.deepEqual(commandFailures, [], 'driver IPC commands all completed without replay')
  await stop(hostWorker)
  assert.equal(hostLogs.length, 2, 'one original worker and one intentional crash replacement')
  for (const log of hostLogs) {
    const closed = log.rows.filter(row => row.state === 'closed')
    assert.equal(new Set(closed.map(row => row.id)).size, closed.length, 'worker releases an id once')
    assert.ok(closed.every(row => log.ids.has(row.id)))
    assert.deepEqual(log.rows.filter(row => row.state === 'ready'), [{ state: 'ready', port: log.port }])
    assert.equal(log.stderr, '')
  }
  for (const gate of [guestGate, hostGate].filter(Boolean)) {
    await until(() => gate.active.size === 0, 'fault gate released both socket legs')
    await close(gate.server)
    const rebound = track(net.createServer()); await listen(rebound, '127.0.0.1', gate.port); await close(rebound)
  }
  assert.ok(seenTCP.length > 10, 'tests exercised real per-socket host notifications')
  assert.ok(hostLogs.every(log => !log.stdout.includes(room.token) && !log.stderr.includes(room.token)))
  console.log('ok expiry/cancel/rebind, no fabricated HTTP, capability pid/room/purpose isolation, active Stop/Leave cleanup and no secret leaks')
}

// WebRTC in a preview window started as the plugin starts it. The page asks a
// STUN server at this machine's own network address over UDP and a TURN
// server there over TCP, and checks made-up peers there over UDP and TCP. The
// listeners count what reaches them directly; a SOCKS5 stand-in for the
// window's proxy (test-only: the production proxy refuses this machine's own
// addresses, so TURN here couldn't pass it) counts what comes through it.
// Nothing may reach the STUN server or the peers directly, and TURN/TCP must
// come through the proxy: Chrome by the profile's disable_non_proxied_udp,
// Firefox by its proxy settings (checked on 153 ESR and 158; without them,
// both send STUN and peer UDP straight out).
async function webrtcChecks() {
  const lan = Object.values(networkInterfaces()).flat().find(a => a?.family === 'IPv4' && !a.internal)?.address
  if (!lan) return console.log('SKIP WebRTC in a preview window (no network address here)')
  const firewall = process.platform === 'darwin' ? await promisify(execFile)('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate'], { timeout: 3000 }).then(({ stdout }) => stdout, () => '') : 'disabled'
  if (!/disabled/i.test(firewall)) return console.log("SKIP WebRTC in a preview window (macOS's firewall is on: a listener on this machine's address would ask the person)")
  const chrome = await findChrome(), firefox = await findFirefox()
  if (!chrome.path) console.log(`SKIP WebRTC in a Chrome window (${chrome.reason})`)
  else if (!windowScripts) console.log("SKIP WebRTC in a Chrome window (this Node can't load TypeScript, so the profile's WebRTC setting isn't written as the plugin writes it)")
  if (!firefox.path) console.log(`SKIP WebRTC in a Firefox window (${firefox.reason})`)
  const windows = [chrome.path && windowScripts && ['Chrome', chrome.path, launchChrome(chrome.path)], firefox.path && ['Firefox', firefox.path, launchFirefox(firefox.path)]].filter(Boolean)
  for (const [name, binary, start] of windows) {
    const version = await promisify(execFile)(binary, ['--version'], { timeout: 15_000 }).then(({ stdout }) => stdout.trim(), () => 'unknown version')
    const counts = { stun: 0, peer: 0, peerTcp: 0, turn: 0, turnViaProxy: 0 }, datagrams = []
    const udp = async key => {
      const socket = dgram.createSocket('udp4')
      datagrams.push(socket)
      socket.on('message', () => counts[key]++)
      await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, lan, () => { socket.removeListener('error', reject); resolve() }) })
      socket.on('error', () => {})
      return socket.address().port
    }
    const tcp = key => listen(track(net.createServer(socket => { counts[key]++; setTimeout(() => socket.destroy(), 500) })), lan)
    const STUN = await udp('stun'), PEER = await udp('peer'), TURN = await tcp('turn'), PEER_TCP = await tcp('peerTcp')
    let report
    const page = `<!doctype html><meta charset="utf-8"><title>WebRTC</title><script>
(async () => {
  const out = { candidates: [], errors: [] }
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:${lan}:${STUN}' }, { urls: 'turn:${lan}:${TURN}?transport=tcp', username: 'u', credential: 'p' }] })
    pc.createDataChannel('x')
    pc.onicecandidate = e => { if (e.candidate && e.candidate.candidate) out.candidates.push(e.candidate.candidate) }
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    // A made-up peer: the offer back as its answer, its own credentials, host candidates at the listeners.
    const sdp = offer.sdp.replace(/a=ice-ufrag:.*\\r\\n/, 'a=ice-ufrag:peer\\r\\n').replace(/a=ice-pwd:.*\\r\\n/, 'a=ice-pwd:peerpasswordpeerpassword12\\r\\n').replace('a=setup:actpass', 'a=setup:active')
    await pc.setRemoteDescription({ type: 'answer', sdp })
    await pc.addIceCandidate({ candidate: 'candidate:1 1 udp 2122260223 ${lan} ${PEER} typ host', sdpMid: '0', sdpMLineIndex: 0 })
    await pc.addIceCandidate({ candidate: 'candidate:2 1 tcp 1518280447 ${lan} ${PEER_TCP} typ host tcptype passive', sdpMid: '0', sdpMLineIndex: 0 })
  } catch (error) { out.errors.push(String(error)) }
  await new Promise(resolve => setTimeout(resolve, 7000))
  await fetch('/report', { method: 'POST', body: JSON.stringify(out) })
})()
</script>`
    const app = track(http.createServer((req, res) => {
      if (req.url === '/report') { const parts = []; req.on('data', bytes => parts.push(bytes)); req.on('end', () => { report = JSON.parse(Buffer.concat(parts)); res.end('ok') }); return }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(page)
    }))
    const APP = await listen(app)
    // Test-only SOCKS5, not another production parser: the page's own address
    // to the page, the TURN address to the TURN listener (counted), the rest refused.
    const standIn = track(net.createServer(client => {
      let buffer = Buffer.alloc(0), greeted = false
      const data = chunk => {
        buffer = Buffer.concat([buffer, chunk])
        if (!greeted) {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
          buffer = buffer.subarray(2 + buffer[1]); greeted = true
          client.write(Buffer.from([5, 0]))
        }
        if (buffer.length < 5) return
        const atyp = buffer[3], size = atyp === 1 ? 10 : atyp === 4 ? 22 : 7 + buffer[4]
        if (buffer.length < size) return
        client.removeListener('data', data)
        const host = atyp === 1 ? [...buffer.subarray(4, 8)].join('.') : atyp === 3 ? buffer.toString('latin1', 5, 5 + buffer[4]) : 'IPv6', port = buffer.readUInt16BE(size - 2)
        const to = port === APP && ['localhost', '127.0.0.1'].includes(host) ? { host: '127.0.0.1', port } : port === TURN && host === lan ? { host: lan, port } : null
        if (!to) return client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]))
        if (to.port === TURN) counts.turnViaProxy++
        const upstream = net.connect(to, () => { client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); client.pipe(upstream).pipe(client) })
        sockets.add(upstream)
        upstream.on('error', () => client.destroy())
        upstream.on('close', () => { sockets.delete(upstream); client.destroy() })
        client.on('close', () => upstream.destroy())
      }
      client.on('data', data)
    }))
    const socksPort = await listen(standIn), profile = await mkdtemp(`${scratch}/webrtc-${name.toLowerCase()}-`)
    let early, browserLog = ''
    const browser = await start({ socksPort, profile, url: `http://localhost:${APP}/` })
    const exited = new Promise(resolve => browser.once('exit', (code, signal) => { early = { code, signal }; resolve() }))
    browser.once('error', error => { early = { error: error.message } })
    for (const stream of [browser.stdout, browser.stderr]) stream.on('data', bytes => { browserLog = (browserLog + bytes).slice(-6000) })
    try {
      await until(() => report || early, `the ${name} WebRTC page reports`, 60_000)
      assert.ok(report, `${name} stopped early ${JSON.stringify(early)}: ${browserLog}`)
      await pause(1000) // A late retransmit still counts.
      assert.deepEqual({ stun: counts.stun, peer: counts.peer, peerTcp: counts.peerTcp, turn: counts.turn - counts.turnViaProxy }, { stun: 0, peer: 0, peerTcp: 0, turn: 0 }, `${name} (${version}): WebRTC reaches this machine's address directly`)
      assert.ok(counts.turnViaProxy >= 1, `${name} (${version}): TURN over TCP must come through the proxy (${JSON.stringify(report.errors)})`)
    } finally {
      await endBrowser(browser, exited, profile)
      for (const socket of datagrams) socket.close()
    }
    console.log(`ok WebRTC in a real ${name} window (${version}, the plugin's ${name === 'Firefox' ? 'settings' : 'flags and profile setting'}, headless): no STUN or peer UDP and no peer TCP reached this machine's address directly; TURN over TCP came through the proxy`)
  }
}

try {
  await parserChecks()
  await probeChecks()
  await detectChecks()
  await publicRelayChecks()
  await publicRelayFailures()
  await bridgeChecks()
  await listenerChecks()
  await listenerCapacity()
  await workerChecks()
  if (!process.argv.includes('--helpers-only')) { await realChain(); await webrtcChecks() }
  console.log(process.argv.includes('--helpers-only') ? 'Helper-only tests passed (real server deliberately not exercised).' : 'All local preview TCP tests passed.')
} finally {
  for (const request of requests) request.destroy()
  for (const websocket of websockets) websocket.close(1001)
  await Promise.all([...running].map(helper => helper.close()))
  for (const socket of sockets) socket.destroy()
  for (const child of children) child.kill('SIGTERM')
  await Promise.all([...servers].map(close))
  await Promise.all([...children].map(child => child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve()))
  await rm(scratch, { recursive: true, force: true })
}
