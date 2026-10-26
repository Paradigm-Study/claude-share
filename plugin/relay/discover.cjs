#!/usr/bin/env node
// Which other web services does a shared localhost page need? The current
// user's loopback/wildcard TCP listeners whose own cwd is inside the shared
// port's project and that answer HTTP. Read-only: it lists processes and
// sockets and makes short GETs to local ports; it never signals anything it
// did not start. stdout is one row of ports and the processes listening on
// them (each one's pid and short name), never paths, argv, users or
// environment. Node 20+, stdlib only.
//
// Owner mode (`owner: true`): who holds one port, nothing else. The current
// user's listeners on it, any family, and whether any of them is one of this
// plugin's own helpers (a guest's listener for another shared session's
// preview, a preview window's proxy, a relay's control port), which the host
// never shares on. No project, git or HTTP: it's on the share path. With
// `web: true` (a guest's need), the port is asked too, beside the listing:
// whether it answers HTTP, and whether it's a debugger.
'use strict'

const fs = require('fs')
const os = require('os')
const net = require('net')
const http = require('http')
const path = require('path')
const { execFile } = require('child_process')
const { run, notify, failure, portOK } = require('./tcp-relay.mts')

const LIMITS = Object.freeze({ deadlineMs: 8000, ownerMs: 2000, marginMs: 500, backstopMs: 200, listMs: 4000, gitMs: 2000, probeMs: 1500, minProbeMs: 250, headers: 65536, body: 65536, listeners: 1024, candidates: 24, concurrency: 4, related: 6, exclude: 64, label: 40, text: 8192 })
const SYSTEM = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' })
// Never suggested: Claude Code, browsers, IDE helpers, tunnels and Docker's port forwarders.
const NOT_SERVICES = [/^claude(?: helper\b.*)?$/i, /^google chrome/i, /^chrome(?:_crashpad_handler)?$/i, /^chromium/i, /^msedge$/i, /^microsoft edge/i, /^brave/i, /^firefox/i, /^safari$/i, /^code$/i, /^code helper/i, /^cursor$/i, /^cursor helper/i, /^idea/i, /^webstorm/i, /^pycharm/i, /^zed$/i, /^sshd?$/i, /^kubectl$/i, /^docker$/i, /^com\.docker/i, /^vpnkit/i]
// This plugin's own helpers, from any installed copy, not only the caller's.
// .cjs or .mts: a helper of a version before or after they moved to TypeScript.
const RELAY = /\/relay\/(?:tcp-worker|local-preview|ws-relay|browser-proxy|discover|mailbox)\.(?:cjs|mts)(?:\s|$)/
// Interpreters, whose label is their script's: node, bun, deno, python, ruby.
const INTERPRETER = /^(?:node(?:js)?\d*|bun|deno|python(?:\d+(?:\.\d+)*)?[a-z]?|ruby(?:\d+(?:\.\d+)*)?)$/i
// A word naming a file: a dot or a slash and a letter (not `.`, an address or
// a version), and nothing code or a host:port has (spaces, quotes, brackets,
// operators, colons).
const FILE_WORD = /^(?=.*[./])(?=.*[A-Za-z])[^\s"'`()[\]{};:|&<>$=]+$/
// The options whose value, the next word, can look like a file: a preload
// (node -r x.js server.js) or a config (deno -c deno.json main.ts) is never
// the script. Code (-e, python's -c) means there is none.
const VALUE_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--preload', '--env-file', '--env-file-if-exists', '--watch-path', '--title', '-c', '--config', '--cwd', '-C', '-I', '--import-map', '--tsconfig-override', '--cert', '--lock'])
const CODE = new Set(['-e', '--eval', '-p', '--print'])

// Owner mode takes no exclude (or an empty one): it looks at its one port alone.
function configOf(cfg) {
  const owner = cfg?.owner === true, web = cfg?.web === true
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || Object.keys(cfg).some(k => !['port', 'pluginRoot', 'exclude', 'deadlineMs', 'owner', 'web'].includes(k)) || (cfg.owner !== undefined && !owner) || (cfg.web !== undefined && !(web && owner)) || !portOK(cfg.port) || typeof cfg.pluginRoot !== 'string' || !cfg.pluginRoot || cfg.pluginRoot.length > 4096 || /[\0-\x1f\x7f]/.test(cfg.pluginRoot) || !path.isAbsolute(cfg.pluginRoot) || (owner ? cfg.exclude !== undefined && !(Array.isArray(cfg.exclude) && cfg.exclude.length === 0) : !Array.isArray(cfg.exclude) || cfg.exclude.length > LIMITS.exclude || !cfg.exclude.every(portOK)) || (cfg.deadlineMs !== undefined && !(Number.isInteger(cfg.deadlineMs) && cfg.deadlineMs >= 1000 && cfg.deadlineMs <= 15_000))) throw failure('INVALID_CONFIG')
  const root = path.resolve(cfg.pluginRoot)
  return { port: cfg.port, owner, web, exclude: new Set(cfg.exclude ?? []), deadlineMs: cfg.deadlineMs ?? (owner ? LIMITS.ownerMs : LIMITS.deadlineMs), markers: [...new Set([root, real(root)].map(dir => `${dir.replace(/\/+$/, '')}/relay/`))] }
}

const real = file => { try { return fs.realpathSync.native(file) } catch { return file } }
const isFile = file => { try { return fs.statSync(file).isFile() } catch { return false } }
const unique = list => [...new Set(list)]
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const baseName = file => String(file ?? '').replace(/ \(deleted\)$/, '').split('/').filter(Boolean).pop() ?? ''
const loginName = () => { try { return os.userInfo().username } catch { return undefined } }
const homeDir = () => { try { return os.homedir() } catch { return '' } }
const PRINTABLE = /[^\p{L}\p{M}\p{N}\p{P}\p{S} ]/gu
// Labels are short names a person reads: never a path, at most 40 characters.
function clean(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').replace(PRINTABLE, '').trim()
  return Array.from(text).slice(0, LIMITS.label).join('').trim()
}
function inside(root, dir) {
  const rel = path.relative(root, dir)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}
// Not '/', the home folder or anything holding it: those would take in every project.
function usableRoot(root, home = homeDir()) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root === path.parse(root).root) return false
  return !(home && path.isAbsolute(home) && [home, real(home)].some(dir => inside(root, dir)))
}

function canonical(address) {
  if (!net.isIPv6(address)) return address
  let host
  try { host = new URL(`http://[${address}]/`).hostname.slice(1, -1) } catch { return address }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (!mapped) return host
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16)
  return `::ffff:${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}
// Loopback (127/8, ::1) or wildcard; a LAN-only listener isn't what localhost reaches.
function exposed(address) {
  if (['*', '0.0.0.0', '::', '::1', '::ffff:0.0.0.0'].includes(address)) return true
  const v4 = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1]
  return !!v4 && net.isIPv4(v4) && v4.startsWith('127.')
}
// The Host relay dials 127.0.0.1, then ::1: the listener it reaches first stands for the port.
function rank(address) {
  if (['127.0.0.1', '*', '0.0.0.0', '::ffff:127.0.0.1', '::ffff:0.0.0.0'].includes(address)) return 0
  return address === '::' ? 1 : address === '::1' ? 2 : 3
}
function byPort(listeners) {
  const ports = new Map()
  for (const row of listeners) {
    const held = ports.get(row.port)
    if (!held || rank(row.address) - rank(held.address) < 0 || (rank(row.address) === rank(held.address) && row.pid < held.pid)) ports.set(row.port, row)
  }
  return ports
}

// lsof -F: a 'p' line starts each process (c, u, L follow), each 'n' is one listener.
function parseLsof(text) {
  const rows = []
  let proc = null
  for (const line of String(text).split('\n')) {
    const field = line[0], value = line.slice(1)
    if (field === 'p') proc = { pid: Number(value), command: '', uid: undefined, login: undefined }
    else if (!proc || !Number.isSafeInteger(proc.pid) || proc.pid < 1) continue
    else if (field === 'c') proc.command = value
    else if (field === 'u' && /^\d+$/.test(value)) proc.uid = Number(value)
    else if (field === 'L') proc.login = value
    else if (field === 'n' && !value.includes('->')) {
      const at = value.lastIndexOf(':'), port = Number(value.slice(at + 1))
      if (at < 1 || !/^\d+$/.test(value.slice(at + 1)) || !portOK(port)) continue
      const address = value.slice(0, at).replace(/^\[(.*)\]$/, '$1')
      rows.push({ pid: proc.pid, command: proc.command, uid: proc.uid, login: proc.login, address: canonical(address), port })
    }
  }
  return rows
}
function lsofListeners(text, uid, login) {
  return parseLsof(text).filter(row => (row.uid !== undefined ? row.uid === uid : login !== undefined && row.login === login) && exposed(row.address)).slice(0, LIMITS.listeners).map(row => ({ pid: row.pid, port: row.port, address: row.address, name: row.command, names: [row.command] }))
}
function parseLsofCwd(text) {
  const cwds = new Map()
  let pid = 0, fd = ''
  for (const line of String(text).split('\n')) {
    if (line[0] === 'p') { pid = Number(line.slice(1)); fd = '' }
    else if (line[0] === 'f') fd = line.slice(1)
    else if (line[0] === 'n' && fd === 'cwd' && Number.isSafeInteger(pid) && pid > 0 && !cwds.has(pid) && path.isAbsolute(line.slice(1))) cwds.set(pid, line.slice(1))
  }
  return cwds
}
function parsePs(text, wanted) {
  const commands = new Map()
  for (const line of String(text).split('\n')) {
    const row = /^\s*(\d+) (.*)$/.exec(line)
    const pid = Number(row?.[1])
    if (row && (!wanted || wanted.has(pid)) && !commands.has(pid)) commands.set(pid, { text: row[2].trim() })
  }
  return commands
}
// /proc/net/tcp{,6}: each 32-bit word is printed in host byte order; 0A is LISTEN.
function parseProcNet(text, v6, endian = os.endianness()) {
  const rows = []
  for (const line of String(text).split('\n')) {
    const parts = line.trim().split(/\s+/)
    const local = /^([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/.exec(parts[1] ?? '')
    if (parts.length < 10 || !/^\d+:$/.test(parts[0]) || parts[3] !== '0A' || !local || (local[1].length === 32) !== v6 || !/^\d+$/.test(parts[7]) || !/^[1-9]\d*$/.test(parts[9])) continue
    const port = parseInt(local[2], 16)
    if (portOK(port)) rows.push({ address: hexAddress(local[1], endian), port, uid: Number(parts[7]), inode: parts[9] })
  }
  return rows
}
function hexAddress(hex, endian) {
  const bytes = Buffer.from(hex, 'hex')
  if (endian === 'LE') for (let i = 0; i < bytes.length; i += 4) bytes.subarray(i, i + 4).reverse()
  if (bytes.length === 4) return [...bytes].join('.')
  if (bytes.subarray(0, 10).every(byte => byte === 0) && bytes[10] === 255 && bytes[11] === 255) return `::ffff:${[...bytes.subarray(12)].join('.')}`
  const groups = []
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16))
  return canonical(groups.join(':'))
}

// macOS ps joins argv with spaces. argv[0] ends at the executable's name (lsof's
// command), so an interpreter under "Application Support" still reads as one word.
function splitText(text, name) {
  text = String(text ?? '').slice(0, LIMITS.text).trim()
  if (!text || /^\(.*\)$/.test(text)) return [] // "(node)": argv unreadable
  const exe = name ? new RegExp(`^(?:/.*?/)?${escape(name)}(?=\\s|$)`).exec(text)?.[0] : undefined
  const first = exe ?? text.split(/\s+/)[0], rest = text.slice(first.length).trim()
  return [first, ...(rest ? rest.split(/\s+/) : [])]
}
function commandOf(raw, name) {
  if (Array.isArray(raw?.argv)) return { argv: raw.argv, joined: false, text: raw.argv.join(' ') }
  if (typeof raw?.text === 'string') return { argv: splitText(raw.text, name), joined: true, text: raw.text }
  return { argv: [], joined: false, text: '' }
}
function commandName(arg) {
  const text = String(arg ?? '').trim()
  return baseName(text.startsWith('/') ? text : text.split(/\s+/)[0]).replace(/:$/, '')
}
// An interpreter's script: its first word naming a file that no option takes
// (python -m's module instead). A -c followed by code (python's) means none.
function scriptOf(argv, joined, exists) {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-m') return argv[i + 1] ?? null
    if (CODE.has(arg) || (arg === '-c' && !FILE_WORD.test(argv[i + 1] ?? ''))) return null
    if (VALUE_OPTIONS.has(arg)) i++
    else if (!arg.startsWith('-') && FILE_WORD.test(arg)) return pathAt(argv, i, joined, exists)
  }
  return null
}
function pathAt(argv, i, joined, exists) {
  // A script path with spaces, split by ps: the longest join that is a file.
  if (joined && !exists(argv[i])) for (let j = Math.min(argv.length, i + 8); j > i + 1; j--) if (exists(argv.slice(i, j).join(' '))) return argv.slice(i, j).join(' ')
  return argv[i]
}
// Display only (exclusion reads commandName and RELAY): an interpreter's
// script by its basename (dev-frontend.mjs), else a process title's first word
// (next-server) or the executable's name (convex-local-backend).
function labelOf(name, command, exists = () => false) {
  const exe = clean(baseName(name)), argv = command?.argv ?? []
  const first = argv.length ? commandName(argv[0]) : ''
  if (!INTERPRETER.test(first)) return clean(first) || exe || 'unknown'
  return clean(baseName(scriptOf(argv, command.joined, exists))) || exe || 'unknown'
}
const excludedName = names => names.some(name => NOT_SERVICES.some(pattern => pattern.test(name)))
// One of this plugin's helpers: under the caller's own copy's relay/, or a
// helper's name from any installed copy.
const pluginHelper = (command, markers) => markers.some(marker => command.text.includes(marker)) || RELAY.test(command.text)
function excludedCommand(command, markers) {
  return pluginHelper(command, markers) || (command.argv.length > 0 && excludedName([commandName(command.argv[0])]))
}

// No shell, a minimal environment, bounded time and output. A child that outlives
// its time is killed and let go, so it can never hold the answer back.
const exec = (file, args, ctx, ms, env) => execAnswer(file, args, ctx, ms, env).then(answer => answer.out)
// `ok`: the command ran to its end, exiting 0 or 1 (lsof's "nothing matched"),
// so an empty `out` is an empty answer; not when it was out of time, killed,
// past its output's bound or never started.
function execAnswer(file, args, ctx, ms, env = SYSTEM) {
  return new Promise(resolve => {
    const timeout = Math.min(ms, ctx.end - Date.now())
    let child, timer, done = false
    const finish = (stdout, ok = false) => {
      if (done) return
      done = true
      clearTimeout(timer)
      ctx.pending.delete(cancel)
      resolve({ out: typeof stdout === 'string' ? stdout : '', ok })
    }
    const cancel = () => {
      try { child.kill('SIGKILL') } catch {}
      child.unref()
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy()
      finish('')
    }
    if (ctx.closed || timeout <= 0) return finish('')
    try { child = execFile(file, args, { encoding: 'utf8', env, maxBuffer: 4 << 20, windowsHide: true }, (error, stdout) => finish(stdout, !error || (error.code === 1 && !error.signal))) } catch { return finish('') }
    ctx.pending.add(cancel)
    child.on('error', () => finish(''))
    child.stdin?.on('error', () => {})
    child.stdin?.end()
    timer = setTimeout(cancel, timeout)
  })
}

// Apple's /usr/bin/git without developer tools opens an install dialog instead.
function developerTools() {
  const dirs = [process.env.DEVELOPER_DIR, '/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer']
  try { dirs.push(fs.readlinkSync('/var/db/xcode_select_link')) } catch {}
  return dirs.some(dir => typeof dir === 'string' && path.isAbsolute(dir) && isFile(path.join(dir, 'usr/bin/git')))
}
function gitBinary(platform = process.platform) {
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(dir, 'git')
    if (!path.isAbsolute(dir) || !isFile(file)) continue
    try { fs.accessSync(file, fs.constants.X_OK) } catch { continue }
    if (platform !== 'darwin' || file !== '/usr/bin/git' || developerTools()) return file
  }
  return null
}
// git's top level, so a monorepo's apps/web finds packages/backend; else the cwd.
// git never climbs into the home folder: a dotfiles repo there isn't the project.
async function projectRoot(cwd, ctx) {
  const git = gitBinary(), home = homeDir()
  if (!git) return cwd
  const env = { PATH: process.env.PATH ?? SYSTEM.PATH, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  for (const key of ['HOME', 'XDG_CONFIG_HOME']) if (process.env[key]) env[key] = process.env[key]
  if (home && path.isAbsolute(home)) env.GIT_CEILING_DIRECTORIES = unique([home, real(home)]).join(path.delimiter)
  const top = (await exec(git, ['-C', cwd, 'rev-parse', '--show-toplevel'], ctx, LIMITS.gitMs, env)).replace(/\n$/, '')
  return top && !top.includes('\n') && path.isAbsolute(top) ? top : cwd
}

const procRead = (pid, name) => { try { return fs.readFileSync(`/proc/${pid}/${name}`, 'utf8') } catch { return '' } }
const procLink = (pid, name) => { try { return fs.readlinkSync(`/proc/${pid}/${name}`) } catch { return '' } }
const procUid = pid => Number(/^Uid:\s+(\d+)/m.exec(procRead(pid, 'status'))?.[1] ?? NaN)
// Socket inode -> the lowest pid of this user holding it, through readable fd links.
function socketOwners(inodes, uid, until) {
  const owners = new Map()
  if (!inodes.size) return owners
  let pids = []
  try { pids = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b) } catch {}
  for (const pid of pids) {
    if (owners.size === inodes.size || Date.now() > until) break
    if (procUid(pid) !== uid) continue
    let fds = []
    try { fds = fs.readdirSync(`/proc/${pid}/fd`) } catch { continue }
    for (const fd of fds) {
      const inode = /^socket:\[(\d+)\]$/.exec(procLink(pid, `fd/${fd}`))?.[1]
      if (inode && inodes.has(inode) && !owners.has(inode)) owners.set(inode, pid)
    }
  }
  return owners
}

const ADAPTERS = {
  // `port`: only that port's listeners (owner mode), or null when they couldn't
  // all be listed (out of time, the listing failed): "nobody" must be known.
  darwin: {
    async listeners(ctx, port) {
      const { out, ok } = await execAnswer('/usr/sbin/lsof', ['-nP', '-w', port ? `-iTCP:${port}` : '-iTCP', '-sTCP:LISTEN', '-FpcuLn'], ctx, LIMITS.listMs)
      return port && !ok ? null : lsofListeners(out, process.getuid(), loginName())
    },
    async cwds(pids, ctx) {
      return pids.length ? parseLsofCwd(await exec('/usr/sbin/lsof', ['-w', '-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'], ctx, LIMITS.listMs)) : new Map()
    },
    async commands(pids, ctx) {
      return pids.length ? parsePs(await exec('/bin/ps', ['-ww', '-o', 'pid=,args=', '-p', pids.join(',')], ctx, LIMITS.listMs), new Set(pids)) : new Map()
    },
  },
  linux: {
    async listeners(ctx, port) {
      const uid = process.getuid(), rows = []
      let read = 0
      for (const [file, v6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]]) {
        try { rows.push(...parseProcNet(fs.readFileSync(file, 'latin1'), v6)); read++ } catch {}
      }
      const mine = rows.filter(row => row.uid === uid && exposed(row.address) && (!port || row.port === port)).slice(0, LIMITS.listeners)
      const owners = socketOwners(new Set(mine.map(row => row.inode)), uid, Math.min(ctx.end, Date.now() + LIMITS.listMs))
      // A socket of this user whose holder wasn't found in time (or can't be read).
      if (port && (!read || mine.some(row => !owners.has(row.inode)))) return null
      return mine.flatMap(row => {
        const pid = owners.get(row.inode)
        if (!pid) return []
        // A process title (libuv's prctl) rewrites comm; the executable keeps its name.
        const exe = baseName(procLink(pid, 'exe')), comm = procRead(pid, 'comm').trim()
        return [{ pid, port: row.port, address: row.address, name: exe || comm, names: [exe, comm].filter(Boolean) }]
      })
    },
    async cwds(pids) {
      const cwds = new Map()
      for (const pid of pids) {
        const cwd = procLink(pid, 'cwd')
        if (cwd && !cwd.endsWith(' (deleted)') && path.isAbsolute(cwd)) cwds.set(pid, cwd)
      }
      return cwds
    },
    async commands(pids) {
      const commands = new Map()
      for (const pid of pids) {
        const argv = procRead(pid, 'cmdline').split('\0').filter(Boolean).slice(0, 256)
        if (argv.length) commands.set(pid, { argv })
      }
      return commands
    },
  },
}

// GET http://127.0.0.1:P/ (then [::1] if IPv4 doesn't connect, as the relay dials):
// any HTTP answer is 'yes', a connection with no answer yet 'slow', else 'no'.
function request(port, family, pathname, ctx, { onConnect, body = false } = {}) {
  return new Promise(resolve => {
    const timeout = Math.min(LIMITS.probeMs, ctx.end - Date.now())
    let req, timer, connected = false, done = false
    const finish = (verdict, text) => {
      if (done) return
      done = true
      clearTimeout(timer)
      ctx.pending.delete(cancel)
      req?.destroy()
      resolve({ verdict, family, connected, text })
    }
    const cancel = () => finish(connected ? 'slow' : 'no')
    if (ctx.closed || timeout <= 0) return finish('no')
    try {
      // Lenient like a browser: a sloppy dev server is still a web server.
      req = http.request({ host: family === 6 ? '::1' : '127.0.0.1', family, port, path: pathname, method: 'GET', agent: false, insecureHTTPParser: true, maxHeaderSize: LIMITS.headers, headers: { host: `localhost:${port}`, accept: '*/*', connection: 'close' } })
    } catch { return finish('no') }
    ctx.pending.add(cancel)
    timer = setTimeout(cancel, timeout)
    req.on('socket', socket => socket.once('connect', () => { connected = true; onConnect?.() }))
    req.on('error', error => finish(error?.code === 'HPE_HEADER_OVERFLOW' ? 'yes' : 'no'))
    req.on('information', () => finish('yes'))
    req.on('upgrade', (_res, socket) => { socket.destroy(); finish('yes') })
    req.on('response', res => {
      res.on('error', () => {})
      if (!body) return finish('yes')
      const parts = []
      let size = 0
      res.on('data', chunk => { size += chunk.length; if (size > LIMITS.body) finish('yes'); else parts.push(chunk) })
      res.on('end', () => finish('yes', Buffer.concat(parts).toString('utf8')))
    })
    req.end()
  })
}
// Chrome's /json/version names its socket; Node's and Deno's inspectors (whose
// GET / is an HTTP 400) name a protocol instead. Either way it's a debugger.
function devtoolsBody(text) {
  let row
  try { row = JSON.parse(text) } catch { return false }
  return !!row && typeof row === 'object' && !Array.isArray(row) && (typeof row.webSocketDebuggerUrl === 'string' || (typeof row.Browser === 'string' && typeof row['Protocol-Version'] === 'string'))
}
async function check(port, ctx, { target = false, onConnect } = {}) {
  let web = await request(port, 4, '/', ctx, { onConnect })
  if (!web.connected && web.verdict === 'no') web = await request(port, 6, '/', ctx, { onConnect })
  // A debugger answers at once; a page still compiling (slow) isn't asked again.
  const ask = web.verdict === 'yes' || (target && web.verdict === 'no' && web.connected)
  const devtools = ask && devtoolsBody((await request(port, web.family, '/json/version', ctx, { body: true })).text)
  return { web: web.verdict, devtools }
}
async function pool(items, size, work) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) await work(items[next++]) }))
}
// Answering ones first, then by port; at most six, listed by port. Each
// with its listener's pid, so the host is asked about one process's ports
// together (a backend on two ports is one question), and about two
// processes of the same name apart.
function pick(rows) {
  const seen = new Set()
  return rows.filter(row => !seen.has(row.port) && seen.add(row.port)).sort((a, b) => (a.web === 'yes' ? 0 : 1) - (b.web === 'yes' ? 0 : 1) || a.port - b.port).slice(0, LIMITS.related).sort((a, b) => a.port - b.port).map(({ port, label, web, pid }) => ({ port, label, web, pid }))
}

async function discover(settings, adapter, ctx, out) {
  const ports = byPort(await adapter.listeners(ctx))
  const target = ports.get(settings.port)
  if (!target || ctx.closed) return
  const shown = out.target = { port: settings.port, label: clean(target.name) || 'unknown', web: 'no', devtools: false }
  const checked = check(settings.port, ctx, { target: true, onConnect: () => { if (shown.web === 'no') shown.web = 'slow' } }).then(result => Object.assign(shown, result))
  const others = [...ports.values()].filter(row => row.port !== settings.port && !settings.exclude.has(row.port) && !excludedName(row.names))
  const cwds = await adapter.cwds(unique([target.pid, ...others.map(row => row.pid)]), ctx)
  // Only each listener's own cwd: Claude Code's children (a debugging Chrome) share the project's.
  const home = cwds.get(target.pid), top = home ? await projectRoot(home, ctx) : null
  const root = top && usableRoot(top) ? top : null
  const nearby = root ? others.filter(row => cwds.has(row.pid) && inside(root, cwds.get(row.pid))) : []
  const raw = await adapter.commands(unique([target.pid, ...nearby.map(row => row.pid)]), ctx)
  const command = row => commandOf(raw.get(row.pid), row.name)
  // Only files inside the project are looked at, to rejoin a script path ps split.
  const exists = row => file => { const full = path.resolve(cwds.get(row.pid) ?? '/', file); return !!root && inside(root, full) && isFile(full) }
  shown.label = labelOf(target.name, command(target), exists(target))
  const candidates = nearby.filter(row => !excludedCommand(command(row), settings.markers)).sort((a, b) => a.port - b.port).slice(0, LIMITS.candidates)
  await pool(candidates, LIMITS.concurrency, async row => {
    if (ctx.closed || ctx.end - Date.now() < LIMITS.minProbeMs) return
    const result = await check(row.port, ctx)
    if (result.web !== 'no' && !result.devtools) out.related.push({ port: row.port, label: labelOf(row.name, command(row), exists(row)), web: result.web, pid: row.pid })
  })
  await checked
}

// Owner mode: every listener of this user on the port, and whether any of
// them is one of this plugin's helpers. `relay` stays null when the listing
// or a holder's command couldn't be read (time ran out, lsof or ps failed):
// the caller can't tell. `target` is null only once the listing said nobody.
async function owners(settings, adapter, ctx, out) {
  const answer = out.answer = { web: 'no', devtools: false }
  const asked = settings.web ? check(settings.port, ctx, { target: true, onConnect: () => { if (answer.web === 'no') answer.web = 'slow' } }).then(result => Object.assign(answer, result)) : null
  await holders(settings, adapter, ctx, out)
  await asked
}
async function holders(settings, adapter, ctx, out) {
  const unknown = () => { out.target = { port: settings.port, label: 'unknown', relay: null } }
  const listed = await adapter.listeners(ctx, settings.port)
  if (!listed) return unknown()
  const rows = listed.filter(row => row.port === settings.port)
  const first = byPort(rows).get(settings.port)
  if (!first || ctx.closed) return
  const shown = out.target = { port: settings.port, label: clean(first.name) || 'unknown', relay: null }
  const pids = unique(rows.map(row => row.pid))
  const raw = await adapter.commands(pids, ctx)
  const command = row => commandOf(raw.get(row.pid), row.name)
  shown.label = labelOf(first.name, command(first))
  const held = pids.map(pid => rows.find(row => row.pid === pid))
  if (held.some(row => raw.has(row.pid) && pluginHelper(command(row), settings.markers))) shown.relay = true
  else if (held.every(row => raw.has(row.pid))) shown.relay = false
}

// testoptions (platform, adapters, emit) are internal, never accepted from stdin.
async function start(cfg, { emit = notify, signal, platform = process.platform, adapters = ADAPTERS } = {}) {
  const settings = configOf(cfg)
  const began = Date.now(), adapter = Object.hasOwn(adapters, platform) ? adapters[platform] : null
  const out = { platform: adapter ? platform : 'unsupported', target: null, related: [] }
  const ctx = { end: began + settings.deadlineMs - LIMITS.marginMs, closed: false, pending: new Set() }
  // Owner mode's answer before its look is done (the backstop) is "can't tell", never "nobody".
  let sent = false, finished = false, backstop
  const close = () => {
    ctx.closed = true
    clearTimeout(backstop)
    signal?.removeEventListener('abort', close)
    for (const cancel of [...ctx.pending]) cancel() // our own lsof/ps/git children and GETs only
  }
  // What is known by the deadline goes out once; nothing is printed after an abort.
  const send = () => {
    if (sent) return
    sent = true
    close()
    if (signal?.aborted) return
    const t = settings.owner && adapter && !finished ? out.target ?? { port: settings.port, label: 'unknown', relay: null } : out.target
    if (settings.owner) return emit({ state: 'done', platform: out.platform, target: t && { port: t.port, label: t.label, relay: t.relay, ...(settings.web ? { web: out.answer?.web ?? 'no', devtools: out.answer?.devtools ?? false } : {}) }, related: [] })
    emit({ state: 'done', platform: out.platform, target: t && { port: t.port, label: t.label, web: t.web, devtools: t.devtools }, related: pick(out.related) })
  }
  if (adapter && !signal?.aborted) {
    signal?.addEventListener('abort', close, { once: true })
    backstop = setTimeout(send, Math.max(0, began + settings.deadlineMs - LIMITS.backstopMs - Date.now()))
    try { await (settings.owner ? owners : discover)(settings, adapter, ctx, out); finished = true } catch {}
  }
  send()
  return { close }
}

module.exports = { start, execAnswer, LIMITS, configOf, parseLsof, lsofListeners, parseLsofCwd, parsePs, parseProcNet, exposed, rank, byPort, splitText, commandOf, labelOf, excludedName, excludedCommand, pluginHelper, inside, usableRoot, devtoolsBody, pick }
if (require.main === module) run(start)
