// Standalone Node 20+ checks for plugin/relay/discover.cjs: no model, deps or network.
//   node test/discover.mjs
// Parser fixtures first, then real listeners started here: a temp git project
// with web services, a silent one, raw TCP, a fake debugger, Node's inspector
// and fake plugin relays, plus a server outside the project. Only the project's
// web services are suggested. Owner mode (who holds one port) against the
// same kind of listeners: one of the plugin's helpers (a guest's listener on
// both loopbacks), an ordinary server, nobody. Every process and folder made
// here is removed.
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, copyFile, rm, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import discover from '../plugin/relay/discover.cjs'

const HELPER = fileURLToPath(new URL('../plugin/relay/discover.cjs', import.meta.url))
const children = new Set()
const SECRET = `argv-secret-${process.pid}-${Date.now()}`
let scratch

async function until(check, label, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await pause(10) }
  throw new Error(`Timed out: ${label}`)
}
function helper(input, env = process.env) {
  return new Promise((resolve, reject) => {
    const began = Date.now()
    const child = spawn(process.execPath, [HELPER], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child)
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', data => (stdout += data))
    child.stderr.setEncoding('utf8').on('data', data => (stderr += data))
    child.on('error', reject)
    child.on('close', (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr, ms: Date.now() - began }) })
    child.stdin.on('error', () => {})
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
  })
}
const labelOK = label => assert.ok(typeof label === 'string' && label.length > 0 && Array.from(label).length <= 40 && !label.includes('/') && !/[\0-\x1f]/.test(label), `label ${JSON.stringify(label)}`)
// One JSON row of the contract's fields and nothing else: no paths, argv or user names.
function answer(result, secrets = []) {
  assert.equal(result.stderr, '', 'nothing on stderr')
  assert.equal(result.code, 0, result.stdout)
  assert.match(result.stdout, /^[^\n]+\n$/, 'exactly one line')
  for (const secret of secrets.filter(secret => secret && secret.length >= 3)) assert.ok(!result.stdout.includes(secret), `stdout leaks ${secret}`)
  const row = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(row), ['state', 'platform', 'target', 'related'])
  assert.equal(row.state, 'done')
  assert.equal(row.platform, process.platform)
  if (row.target !== null) {
    assert.deepEqual(Object.keys(row.target), ['port', 'label', 'web', 'devtools'])
    assert.ok(['yes', 'slow', 'no'].includes(row.target.web))
    assert.equal(typeof row.target.devtools, 'boolean')
    labelOK(row.target.label)
  }
  assert.ok(Array.isArray(row.related) && row.related.length <= 6)
  for (const item of row.related) {
    assert.deepEqual(Object.keys(item), ['port', 'label', 'web', 'pid'])
    assert.ok(Number.isSafeInteger(item.pid) && item.pid > 0, `pid ${item.pid}`)
    assert.ok(['yes', 'slow'].includes(item.web))
    labelOK(item.label)
  }
  assert.deepEqual(row.related.map(item => item.port), row.related.map(item => item.port).sort((a, b) => a - b), 'related sorted by port')
  return row
}

// Owner mode's one row: who holds the port, never paths, argv or user names.
function ownerAnswer(result, secrets = []) {
  assert.equal(result.stderr, '', 'nothing on stderr')
  assert.equal(result.code, 0, result.stdout)
  assert.match(result.stdout, /^[^\n]+\n$/, 'exactly one line')
  for (const secret of secrets.filter(secret => secret && secret.length >= 3)) assert.ok(!result.stdout.includes(secret), `stdout leaks ${secret}`)
  const row = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(row), ['state', 'platform', 'target', 'related'])
  assert.equal(row.state, 'done')
  assert.equal(row.platform, process.platform)
  assert.deepEqual(row.related, [])
  if (row.target !== null) {
    assert.deepEqual(Object.keys(row.target), ['port', 'label', 'relay'])
    assert.equal(typeof row.target.relay, 'boolean')
    labelOK(row.target.label)
  }
  return row
}

function parserChecks() {
  const lsof = [
    'p23370', 'cconvex-local-backend', 'u501', 'Lkyle', 'f18', 'n*:3611', 'f19', 'n*:3610',
    'p23501', 'cnode', 'u501', 'Lkyle', 'f15', 'n[::1]:3000',
    'p5037', 'cadb', 'u501', 'Lkyle', 'f11', 'n127.0.0.1:5037',
    'p777', 'cotherd', 'u502', 'Lother', 'f3', 'n*:9999',
    'p888', 'cweird', 'u501', 'Lkyle', 'f4', 'n192.168.1.5:8080', 'f5', 'n[fe80::1%lo0]:631', 'f6', 'n127.0.0.1:1234->127.0.0.1:5678', 'f7', 'n[::ffff:127.0.0.1]:8443', 'f8', 'n*:*',
    'p999', 'cnouid', 'Lkyle', 'f3', 'n127.0.0.1:7000',
    'pnot-a-pid', 'cbad', 'u501', 'f3', 'n127.0.0.1:7001', '',
  ].join('\n')
  assert.deepEqual(discover.parseLsof(lsof).map(row => [row.pid, row.address, row.port]), [
    [23370, '*', 3611], [23370, '*', 3610], [23501, '::1', 3000], [5037, '127.0.0.1', 5037], [777, '*', 9999],
    [888, '192.168.1.5', 8080], [888, 'fe80::1%lo0', 631], [888, '::ffff:127.0.0.1', 8443], [999, '127.0.0.1', 7000],
  ])
  const mine = discover.lsofListeners(lsof, 501, 'kyle')
  assert.deepEqual(mine.map(row => [row.pid, row.address, row.port, row.name]), [
    [23370, '*', 3611, 'convex-local-backend'], [23370, '*', 3610, 'convex-local-backend'], [23501, '::1', 3000, 'node'],
    [5037, '127.0.0.1', 5037, 'adb'], [888, '::ffff:127.0.0.1', 8443, 'weird'], [999, '127.0.0.1', 7000, 'nouid'],
  ], 'own uid (login only without one), loopback or wildcard')
  assert.deepEqual(discover.lsofListeners(lsof, 501, undefined).map(row => row.pid).includes(999), false)
  assert.deepEqual(discover.parseLsofCwd('p23370\nfcwd\nn/Users/k/proj\np23501\nfcwd\nn/Users/k/My Proj\np42\nfcwd\nn(unknown)\np43\nftxt\nn/bin/x\n'), new Map([[23370, '/Users/k/proj'], [23501, '/Users/k/My Proj']]))
  assert.deepEqual(discover.parsePs('23370 /x/convex-local-backend --port 3610 --instance-secret s3cr3t\n23501 next-server (v16.3.8) \n  615 /usr/libexec/rapportd\n', new Set([23370, 23501])), new Map([
    [23370, { text: '/x/convex-local-backend --port 3610 --instance-secret s3cr3t' }], [23501, { text: 'next-server (v16.3.8)' }],
  ]))

  const tcp = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41001 1 0000000000000000 100 0 0 10 0',
    '   1: 00000000:0E1A 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41002 1 0000000000000000 100 0 0 10 0',
    '   2: 0100007F:0BB8 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 41003 1 0000000000000000 20 4 30 10 -1',
    '   3: 0501A8C0:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41004 1 0000000000000000 100 0 0 10 0',
    '   4: 0200007F:04D2 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 41005 1 0000000000000000 100 0 0 10 0',
    '   5: 0100007F:1F91 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 0 1 0000000000000000 100 0 0 10 0', '',
  ].join('\n')
  assert.deepEqual(discover.parseProcNet(tcp, false, 'LE'), [
    { address: '127.0.0.1', port: 3000, uid: 1000, inode: '41001' }, { address: '0.0.0.0', port: 3610, uid: 1000, inode: '41002' },
    { address: '192.168.1.5', port: 8080, uid: 1000, inode: '41004' }, { address: '127.0.0.2', port: 1234, uid: 0, inode: '41005' },
  ], 'LISTEN rows only, little-endian words, inode 0 skipped')
  assert.deepEqual(discover.parseProcNet('   0: 7F000001:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7 1 0 100 0 0 10 0', false, 'BE'), [{ address: '127.0.0.1', port: 3000, uid: 1000, inode: '7' }])
  const tcp6 = [
    '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52001 1 0000000000000000 100 0 0 10 0',
    '   1: 00000000000000000000000000000000:0E1A 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52002 1 0000000000000000 100 0 0 10 0',
    '   2: 0000000000000000FFFF00000100007F:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52003 1 0000000000000000 100 0 0 10 0',
    '   3: 000080FE00000000FF00545201A2D1FE:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52004 1 0000000000000000 100 0 0 10 0',
    '   4: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52005 1 0000000000000000 100 0 0 10 0', '',
  ].join('\n')
  assert.deepEqual(discover.parseProcNet(tcp6, true, 'LE').map(row => [row.address, row.port, row.inode]), [
    ['::1', 3000, '52001'], ['::', 3610, '52002'], ['::ffff:127.0.0.1', 8080, '52003'], ['fe80::5254:ff:fed1:a201', 22, '52004'],
  ], 'IPv6 rows only, v4-mapped readable')
  for (const [address, open] of [['*', true], ['0.0.0.0', true], ['::', true], ['::1', true], ['127.0.0.1', true], ['127.9.8.7', true], ['::ffff:127.0.0.1', true], ['192.168.1.5', false], ['10.0.0.1', false], ['fe80::1%lo0', false], ['::ffff:10.0.0.1', false], ['fe80::5254:ff:fed1:a201', false]]) assert.equal(discover.exposed(address), open, address)
  const ports = discover.byPort([{ pid: 20, port: 4000, address: '::1' }, { pid: 30, port: 4000, address: '127.0.0.1' }, { pid: 10, port: 4000, address: '127.0.0.2' }, { pid: 5, port: 5000, address: '*' }, { pid: 3, port: 5000, address: '*' }, { pid: 9, port: 6000, address: '::1' }, { pid: 8, port: 6000, address: '::' }])
  assert.deepEqual([...ports].map(([port, row]) => [port, row.pid]), [[4000, 30], [5000, 3], [6000, 8]], 'the listener the relay reaches first, then the lowest pid')
  console.log('ok lsof -F (u/L ownership, *, [::1], IPv4, v4-mapped, connected/LAN skipped), cwd/ps parsing, /proc/net/tcp{,6} both byte orders, loopback/wildcard and per-port choice')

  const text = (value, name, exists) => discover.labelOf(name, discover.commandOf({ text: value }, name), exists)
  const argv = (value, name) => discover.labelOf(name, discover.commandOf({ argv: value }, name))
  assert.equal(text('next-server (v16.3.8) ', 'node'), 'next-server')
  assert.equal(text('/Users/x/.cache/convex/binaries/p/convex-local-backend --port 3610 --instance-secret abc', 'convex-local-backend'), 'convex-local-backend')
  assert.equal(text('/opt/homebrew/bin/node /Users/x/proj/scripts/dev-frontend.mjs --port 3001', 'node'), 'dev-frontend.mjs')
  assert.equal(text('/Users/x/Library/Application Support/fnm/node-versions/v20/installation/bin/node /Users/x/My Proj/server.mjs --port 4000', 'node', file => file === '/Users/x/My Proj/server.mjs'), 'server.mjs', 'interpreter and script paths with spaces')
  assert.equal(text('(node)', 'node'), 'node')
  assert.equal(text('/usr/bin/python3 /srv/app/manage.py runserver', 'Python'), 'manage.py')
  assert.equal(argv(['node', '--inspect', '-r', 'dotenv/config', '--import=tsx', '/app/web.mjs', '--port', '3000'], 'node'), 'web.mjs')
  assert.equal(argv(['/usr/local/bin/node', '/app/node_modules/.bin/vite', '--host'], 'node'), 'vite')
  assert.equal(argv(['next-server (v16.3.8)'], 'node'), 'next-server')
  assert.equal(argv(['python3', '-u', '-m', 'http.server', '8000'], 'python3.12'), 'http.server')
  assert.equal(argv(['/usr/bin/python3', '-c', 'import http.server'], 'python3.12'), 'python3.12')
  assert.equal(argv(['node', '-e', 'require("http").createServer().listen(1)'], 'node'), 'node')
  assert.equal(argv(['bun', 'run', 'server.ts'], 'bun'), 'server.ts')
  assert.equal(argv(['deno', 'run', '-A', '--port', '8000', 'main.ts'], 'deno'), 'main.ts')
  assert.equal(argv(['ruby', 'bin/rails', 'server'], 'ruby'), 'rails')
  assert.equal(argv(['puma 6.4.2 (tcp://localhost:3000) [app]'], 'ruby'), 'puma')
  assert.equal(argv(['/srv/bin/api-gateway', '--token', SECRET], 'api-gateway'), 'api-gateway')
  // A word an option takes is never the script; a flag's next word is.
  assert.equal(argv(['node', '--require', 'x.js', 'server.js'], 'node'), 'server.js', 'a preload is not the script')
  assert.equal(argv(['node', '--loader', 'ts-node/esm', 'src/index.ts'], 'node'), 'index.ts')
  assert.equal(argv(['node', '--env-file', '.env', 'server.js'], 'node'), 'server.js')
  assert.equal(argv(['deno', 'run', '-c', 'deno.json', 'main.ts'], 'deno'), 'main.ts', "bun's and deno's -c is a config")
  assert.equal(argv(['node', '--inspect', 'server.js'], 'node'), 'server.js')
  assert.equal(argv(['node', '--watch', 'server.js', './public'], 'node'), 'server.js', "the script's own arguments come after it")
  assert.equal(argv(['python3', '-u', 'manage.py', 'runserver', '0.0.0.0:8000'], 'python3'), 'manage.py', 'an address is not a file')
  assert.equal(argv(['ruby', '-run', '-e', 'httpd', '.', '-p', '8000'], 'ruby'), 'ruby', 'code names no script')
  assert.equal(text('python3 -c import http.server; http.server.test()', 'python3'), 'python3', "python's -c, split by ps")
  assert.equal(discover.labelOf('x'.repeat(60), discover.commandOf(undefined, 'x')), 'x'.repeat(40))
  assert.equal(discover.labelOf('evil‮name\x07', discover.commandOf(undefined, '')), 'evilname')
  assert.equal(discover.labelOf('', discover.commandOf(undefined, '')), 'unknown')
  for (const name of ['Google Chrome', 'Google Chrome Helper (Renderer)', 'chrome', 'chromium-browser', 'msedge', 'Microsoft Edge', 'Brave Browser', 'firefox', 'Safari', 'claude', 'Claude Helper', 'code', 'Code Helper (Plugin)', 'cursor', 'Cursor Helper', 'idea', 'webstorm', 'pycharm', 'zed', 'ssh', 'sshd', 'kubectl', 'docker', 'com.docker.backend', 'vpnkit-bridge']) assert.equal(discover.excludedName([name]), true, name)
  for (const name of ['node', 'convex-local-backend', 'next-server', 'postgres', 'python3', 'claude-share-server']) assert.equal(discover.excludedName([name]), false, name)
  const markers = ['/opt/plug/relay/']
  assert.equal(discover.excludedCommand(discover.commandOf({ argv: ['node', '/opt/plug/relay/worker.cjs'] }, 'node'), markers), true, 'this plugin root')
  assert.equal(discover.excludedCommand(discover.commandOf({ text: '/usr/bin/node /other/copy/relay/tcp-worker.cjs' }, 'node'), markers), true, 'another installed copy')
  assert.equal(discover.excludedCommand(discover.commandOf({ argv: ['claude', '--resume'] }, '2.1.300'), markers), true, 'Claude Code by argv[0]')
  assert.equal(discover.excludedCommand(discover.commandOf({ argv: ['node', '/proj/relay/server.mjs'] }, 'node'), markers), false)
  // The plugin's own helpers, by its root or any copy's helper names; never a browser's or an IDE's name alone.
  assert.equal(discover.pluginHelper(discover.commandOf({ argv: ['node', '/opt/plug/relay/worker.cjs'] }, 'node'), markers), true)
  assert.equal(discover.pluginHelper(discover.commandOf({ text: '/opt/homebrew/bin/node /Users/k/.claude/shared-session/plugin/relay/local-preview.cjs' }, 'node'), markers), true)
  assert.equal(discover.pluginHelper(discover.commandOf({ argv: ['node', '/elsewhere/relay/browser-proxy.cjs'] }, 'node'), markers), true)
  assert.equal(discover.pluginHelper(discover.commandOf({ argv: ['claude', '--resume'] }, 'claude'), markers), false)
  assert.equal(discover.pluginHelper(discover.commandOf({ argv: ['node', '/proj/relay/local-preview.cjs.bak'] }, 'node'), markers), false)
  console.log("ok labels: script (an option's value passed over, an address or code never one), executable, process title, spaces, python -m, bun/deno/ruby, 40 printable chars; Claude Code/browser/IDE/tunnel/relay exclusions")

  assert.equal(discover.inside('/a/b', '/a/b'), true)
  assert.equal(discover.inside('/a/b', '/a/b/c/d'), true)
  assert.equal(discover.inside('/a/b', '/a/b/..c'), true)
  assert.equal(discover.inside('/a/b', '/a/bc'), false)
  assert.equal(discover.inside('/a/b', '/a'), false)
  assert.equal(discover.usableRoot('/', '/home/u'), false)
  assert.equal(discover.usableRoot('/home/u', '/home/u'), false)
  assert.equal(discover.usableRoot('/home', '/home/u'), false)
  assert.equal(discover.usableRoot('proj', '/home/u'), false)
  assert.equal(discover.usableRoot('/home/u/proj', '/home/u'), true)
  for (const [body, yes] of [['{"webSocketDebuggerUrl":"ws://127.0.0.1/devtools/browser/x"}', true], ['{"Browser":"node.js/v24.0.0","Protocol-Version":"1.1"}', true], ['{"Browser":"x"}', false], ['{"ok":false}', false], ['[]', false], ['not json', false], [undefined, false]]) assert.equal(discover.devtoolsBody(body), yes, body)
  const many = [9, 3, 7, 1, 5, 2, 8].map(port => ({ port, label: 'x', web: port === 1 || port === 2 ? 'slow' : 'yes' }))
  assert.deepEqual(discover.pick(many).map(row => `${row.port}${row.web[0]}`), ['1s', '3y', '5y', '7y', '8y', '9y'], 'answering first, then the lowest slow one; six, by port')
  assert.deepEqual(discover.pick([{ port: 4, label: 'x', web: 'yes', pid: 42 }, { port: 3, label: 'x', web: 'slow', pid: 42 }]), [{ port: 3, label: 'x', web: 'slow', pid: 42 }, { port: 4, label: 'x', web: 'yes', pid: 42 }], "each keeps its listener's pid")
  console.log('ok project root bounds (/, home, its parents, relative), DevTools bodies (Chrome, Node inspector) and the six-row pick, pids kept')
}

async function configChecks() {
  const good = { port: 3000, pluginRoot: '/opt/plug', exclude: [] }
  assert.doesNotThrow(() => discover.configOf({ ...good, exclude: Array(64).fill(80), deadlineMs: 15_000 }))
  assert.doesNotThrow(() => discover.configOf({ ...good, deadlineMs: 1000 }))
  const bad = ['not json', '[]', '{}', 'null', { ...good, port: 0 }, { ...good, port: 65536 }, { ...good, port: '3000' }, { ...good, port: 3000.5 }, { ...good, pluginRoot: 'relative/plug' }, { ...good, pluginRoot: '' }, { ...good, pluginRoot: '/opt/plug\n' }, { ...good, pluginRoot: 7 },
    { port: 3000, pluginRoot: '/opt/plug' }, { ...good, exclude: [0] }, { ...good, exclude: ['80'] }, { ...good, exclude: Array(65).fill(80) }, { ...good, exclude: 80 },
    { ...good, deadlineMs: 999 }, { ...good, deadlineMs: 15_001 }, { ...good, deadlineMs: 1500.5 }, { ...good, deadlineMs: null }, { ...good, extra: 1 },
    `{"port":3000,"pluginRoot":"/${'a'.repeat(20_000)}","exclude":[]}`,
    // Owner mode: `owner` is true or absent, and takes no exclude but an empty one.
    { ...good, owner: false }, { ...good, owner: 'yes' }, { ...good, owner: 1 }, { ...good, owner: true, exclude: [80] }, { ...good, owner: true, exclude: 80 }, { port: 0, pluginRoot: '/opt/plug', owner: true }, { pluginRoot: '/opt/plug', owner: true },
    { port: 3000, owner: true }, { port: 3000, pluginRoot: 'plug', owner: true }, { port: 3000, pluginRoot: '/opt/plug', owner: true, deadlineMs: 500 }, { port: 3000, pluginRoot: '/opt/plug', owner: true, extra: 1 }]
  const results = await Promise.all(bad.map(input => helper(input)))
  for (const [i, result] of results.entries()) {
    assert.equal(result.stdout, '{"state":"error","code":"INVALID_CONFIG"}\n', JSON.stringify(bad[i]).slice(0, 80))
    assert.equal(result.code, 1)
    assert.equal(result.stderr, '')
  }

  const rows = []
  await discover.start(good, { emit: row => rows.push(row), platform: 'win32' })
  assert.deepEqual(rows, [{ state: 'done', platform: 'unsupported', target: null, related: [] }], 'other platforms answer, not fail')
  const owner = { port: 3000, pluginRoot: '/opt/plug', owner: true }
  for (const cfg of [owner, { ...owner, exclude: [] }, { ...owner, deadlineMs: 1000 }]) assert.doesNotThrow(() => discover.configOf(cfg))
  assert.equal(discover.configOf(owner).deadlineMs, 2000, "owner mode's own deadline")
  assert.equal(discover.configOf(good).deadlineMs, 8000)
  const ownerRows = []
  await discover.start(owner, { emit: row => ownerRows.push(row), platform: 'win32' })
  assert.deepEqual(ownerRows, [{ state: 'done', platform: 'unsupported', target: null, related: [] }], 'owner mode on other platforms: unsupported, not fail')

  // Owner mode through an adapter as Linux's answers (argv from /proc/<pid>/cmdline): the port is
  // asked for, every holder's command read, and null when one couldn't be.
  const asked = []
  const fake = (listeners, commands) => ({ fake: {
    listeners: async (_ctx, port) => { asked.push(port); return listeners },
    commands: async pids => new Map(pids.filter(pid => commands[pid]).map(pid => [pid, { argv: commands[pid] }])),
    cwds: async () => { throw new Error('owner mode reads no cwd') },
  } })
  const holding = [{ pid: 41, port: 3000, address: '127.0.0.1', name: 'node', names: ['node'] }, { pid: 42, port: 3000, address: '::1', name: 'node', names: ['node'] }, { pid: 43, port: 4000, address: '127.0.0.1', name: 'next-server', names: ['next-server'] }]
  const ownerOf = async (listeners, commands, cfg = owner) => { const out = []; await discover.start(cfg, { emit: row => out.push(row), platform: 'fake', adapters: fake(listeners, commands) }); return out }
  assert.deepEqual(await ownerOf(holding, { 41: ['/usr/bin/node', '/srv/app/server.js'], 42: ['/usr/bin/node', '/home/u/.claude/shared-session/plugin/relay/local-preview.cjs'] }), [{ state: 'done', platform: 'fake', target: { port: 3000, label: 'server.js', relay: true }, related: [] }], 'any holder a helper, on either family')
  assert.deepEqual(await ownerOf(holding.slice(0, 1), { 41: ['/usr/bin/node', '/opt/plug/relay/anything.cjs'] }), [{ state: 'done', platform: 'fake', target: { port: 3000, label: 'anything.cjs', relay: true }, related: [] }], "under the caller's own relay/")
  assert.deepEqual(await ownerOf(holding, { 41: ['/usr/bin/node', '/srv/app/server.js'], 42: ['/usr/bin/node', '/srv/app/server.js'] }), [{ state: 'done', platform: 'fake', target: { port: 3000, label: 'server.js', relay: false }, related: [] }])
  assert.deepEqual(await ownerOf(holding, { 41: ['/usr/bin/node', '/srv/app/server.js'] }), [{ state: 'done', platform: 'fake', target: { port: 3000, label: 'server.js', relay: null }, related: [] }], "a holder whose command couldn't be read: can't tell")
  assert.deepEqual(await ownerOf(holding.slice(2), { 43: ['next-server (v16.3.8)'] }), [{ state: 'done', platform: 'fake', target: null, related: [] }], "another port's listener is no holder")
  assert.deepEqual(await ownerOf(null, {}), [{ state: 'done', platform: 'fake', target: { port: 3000, label: 'unknown', relay: null }, related: [] }], "a listing that failed or ran out of time: can't tell, never nobody")
  assert.deepEqual(asked, [3000, 3000, 3000, 3000, 3000, 3000])
  // A listing still running at the deadline (the backstop answers) is can't tell too.
  const lateRows = []
  await discover.start({ ...owner, deadlineMs: 1000 }, { emit: row => lateRows.push(row), platform: 'fake', adapters: { fake: { listeners: () => new Promise(resolve => setTimeout(() => resolve([]), 1200)), commands: async () => new Map() } } })
  assert.deepEqual(lateRows, [{ state: 'done', platform: 'fake', target: { port: 3000, label: 'unknown', relay: null }, related: [] }], 'the backstop says can\'t tell')
  // Whether a command ran to its end: exit 0 or 1 (lsof's nothing matched) answers; anything else doesn't.
  const ctx = () => ({ end: Date.now() + 5000, closed: false, pending: new Set() })
  assert.deepEqual(await discover.execAnswer('/bin/sh', ['-c', 'echo hi'], ctx(), 2000), { out: 'hi\n', ok: true })
  assert.deepEqual(await discover.execAnswer('/bin/sh', ['-c', 'exit 1'], ctx(), 2000), { out: '', ok: true })
  assert.deepEqual(await discover.execAnswer('/bin/sh', ['-c', 'exit 2'], ctx(), 2000), { out: '', ok: false })
  assert.deepEqual(await discover.execAnswer('/bin/sh', ['-c', 'exec sleep 5'], ctx(), 200), { out: '', ok: false }, 'out of time')
  assert.deepEqual(await discover.execAnswer('/nonexistent/lsof', [], ctx(), 2000), { out: '', ok: false }, 'never started')
  console.log("ok owner mode's stdin (owner true or absent, no exclude but [], its own 2 s deadline), unsupported platform, holders through an adapter (a helper on either family, under its own root, none, unreadable, another port's), a listing failed or late is can't tell, exit status read")
  // A listing that never returns still answers by the deadline; an abort prints nothing.
  const stuck = { stuck: { listeners: () => new Promise(() => {}) } }
  const late = [], aborted = [], controller = new AbortController(), began = Date.now()
  void discover.start({ ...good, deadlineMs: 1000 }, { emit: row => late.push({ row, ms: Date.now() - began }), platform: 'stuck', adapters: stuck })
  void discover.start({ ...good, deadlineMs: 1000 }, { emit: row => aborted.push(row), platform: 'stuck', adapters: stuck, signal: controller.signal })
  controller.abort()
  await until(() => late.length, 'deadline answer', 2000)
  assert.deepEqual(late[0].row, { state: 'done', platform: 'stuck', target: null, related: [] })
  assert.ok(late[0].ms < 1000, `answered after ${late[0].ms} ms`)
  await pause(300)
  assert.deepEqual(aborted, [])
  assert.equal(late.length, 1)
  console.log(`ok strict stdin (keys, ranges, 64 excludes, absolute root, size): INVALID_CONFIG exit 1; unsupported platform; stuck listing answers in ${late[0].ms} ms; abort is silent`)
}

const FIXTURE = `'use strict'
const net = require('net'), http = require('http'), path = require('path')
const kind = path.basename(__filename, '.cjs'), hosts = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
setInterval(() => {}, 1 << 30)
function server() {
  if (kind === 'slow') return net.createServer(socket => socket.on('error', () => {}))
  if (kind === 'garbage') return net.createServer(socket => { socket.on('error', () => {}); socket.end('SSH-2.0-OpenSSH_9.9\\r\\n') })
  if (kind === 'reset') return net.createServer(socket => { socket.on('error', () => {}); socket.resetAndDestroy() })
  return http.createServer((req, res) => {
    if (kind === 'devtools' && req.url === '/json/version') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ Browser: 'Chrome/155.0.0.0', 'Protocol-Version': '1.3', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/fixture' })) }
    res.writeHead(kind === 'devtools' ? 404 : kind.endsWith('worker') ? 401 : 200, { 'content-type': 'text/plain' })
    res.end(kind)
  })
}
Promise.all(hosts.map(host => new Promise((resolve, reject) => {
  const s = server()
  s.once('error', reject)
  s.listen(host === '*' ? { port: 0 } : { host, port: 0, ipv6Only: host === '::1' }, () => resolve(s.address().port))
}))).then(ports => process.stdout.write(JSON.stringify({ ports }) + '\\n'), error => { process.stdout.write(JSON.stringify({ error: error.code }) + '\\n'); process.exit(1) })
`

async function serve(file, cwd, args = [], nodeArgs = []) {
  const child = spawn(process.execPath, [...nodeArgs, file, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  child.once('exit', () => children.delete(child))
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', data => (stdout += data))
  child.stderr.setEncoding('utf8').on('data', data => (stderr += data))
  await until(() => stdout.includes('\n') || child.exitCode !== null, `${path.basename(file)} listening`)
  const row = JSON.parse(stdout.split('\n')[0] || '{}')
  if (!Array.isArray(row.ports)) throw new Error(`${path.basename(file)} did not start: ${row.error ?? stderr}`)
  return { child, ports: row.ports, stderr: () => stderr }
}
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const exited = once(child, 'exit')
  if (await Promise.race([exited.then(() => true), pause(3000).then(() => false)])) return
  child.kill('SIGKILL')
  await exited
}
async function ipv6Loopback() {
  const server = net.createServer()
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '::1', port: 0, ipv6Only: true }, resolve) })
    return true
  } catch { return false } finally { await new Promise(resolve => server.listening ? server.close(resolve) : resolve()) }
}
// A listener on 127.0.0.1 and, where there is IPv6, ::1 at the same port, as a guest's listener binds.
const BOTH = `'use strict'
const net = require('net')
setInterval(() => {}, 1 << 30)
const listen = options => new Promise((resolve, reject) => { const s = net.createServer(socket => socket.destroy()); s.once('error', reject); s.listen(options, () => resolve(s)) })
listen({ host: '127.0.0.1', port: 0 }).then(async v4 => {
  const port = v4.address().port
  if (process.argv[2] === 'v6') await listen({ host: '::1', port, ipv6Only: true })
  process.stdout.write(JSON.stringify({ ports: [port] }) + '\\n')
}, error => { process.stdout.write(JSON.stringify({ error: error.code }) + '\\n'); process.exit(1) })
`

// A wildcard bind on a Mac with the application firewall on would ask the person.
function wildcardQuiet() {
  if (process.platform !== 'darwin') return true
  try { return /disabled/i.test(execFileSync('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })) } catch { return false }
}
function hasGit(project) {
  try { execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', project], { stdio: 'ignore', timeout: 10_000 }); return true } catch { return false }
}

async function liveChecks() {
  const scripts = path.join(scratch, 'scripts'), project = path.join(scratch, 'project'), api = path.join(project, 'packages', 'api'), elsewhere = path.join(scratch, 'elsewhere')
  const pluginRoot = path.join(scratch, 'plugin'), otherCopy = path.join(scripts, 'other-copy')
  for (const dir of [scripts, api, elsewhere, path.join(pluginRoot, 'relay'), path.join(otherCopy, 'relay')]) await mkdir(dir, { recursive: true })
  const git = hasGit(project)
  const source = path.join(scripts, 'fixture.txt')
  await writeFile(source, FIXTURE)
  const script = async (name, dir = scripts) => { const file = path.join(dir, `${name}.cjs`); await copyFile(source, file); return file }
  const v6 = await ipv6Loopback(), wildcard = wildcardQuiet()

  // IPv4 and wildcard listeners first; the IPv6-only one last, on a port number none of them use.
  const [apiRun, docs, slow, garbage, reset, devtools, worker, otherWorker, outside, idle] = await Promise.all([
    serve(await script('api'), api, [wildcard ? '*' : '127.0.0.1', '127.0.0.1', `--token=${SECRET}`]),
    serve(await script('docs'), project, Array(5).fill('127.0.0.1')),
    serve(await script('slow'), project, ['127.0.0.1']),
    serve(await script('garbage'), project, ['127.0.0.1']),
    serve(await script('reset'), project, ['127.0.0.1']),
    serve(await script('devtools'), project, ['127.0.0.1']),
    serve(await script('worker', path.join(pluginRoot, 'relay')), project, ['127.0.0.1']),
    serve(await script('tcp-worker', path.join(otherCopy, 'relay')), project, ['127.0.0.1']),
    serve(await script('outside'), elsewhere, ['127.0.0.1']),
    serve(await script('idle'), project, [], ['--inspect=127.0.0.1:0']),
  ])
  await until(() => /Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//.test(idle.stderr()), 'inspector port')
  const inspector = Number(/Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(idle.stderr())[1])
  const taken = new Set([...[apiRun, docs, slow, garbage, reset, devtools, worker, otherWorker, outside].flatMap(run => run.ports), inspector])
  let web
  for (let attempt = 0; attempt < 8 && !web; attempt++) {
    const run = await serve(await script('web'), project, [v6 ? '::1' : '127.0.0.1', '127.0.0.1'])
    if (run.ports.some(port => taken.has(port))) await stopChild(run.child)
    else web = run
  }
  assert.ok(web, 'web fixture on unused port numbers')
  // A guest's listener (this plugin's helper by name, from any copy) on both loopbacks, inside the project.
  const relayDir = path.join(project, 'guest-copy', 'relay'), both = path.join(scripts, 'both.txt')
  await mkdir(relayDir, { recursive: true })
  await writeFile(both, BOTH)
  const bothScript = async (name, dir) => { const file = path.join(dir, `${name}.cjs`); await copyFile(both, file); return file }
  let guest
  for (let attempt = 0; attempt < 8 && !guest; attempt++) {
    const run = await serve(await bothScript('local-preview', relayDir), project, v6 ? ['v6'] : [])
    if (run.ports.some(port => taken.has(port) || web.ports.includes(port))) await stopChild(run.child)
    else guest = run
  }
  assert.ok(guest, 'guest listener fixture on an unused port number')
  const [main, hmr] = web.ports, [apiPort, apiPort2] = apiRun.ports, [d1, d2, d3, d4, d5] = docs.ports.slice().sort((a, b) => a - b)
  const forbidden = new Set([garbage.ports[0], reset.ports[0], devtools.ports[0], worker.ports[0], otherWorker.ports[0], outside.ports[0], inspector, guest.ports[0]])
  let closed
  for (let attempt = 0; attempt < 8 && !closed; attempt++) {
    const probe = net.createServer()
    await new Promise(resolve => probe.listen({ host: '127.0.0.1', port: 0 }, resolve))
    const port = probe.address().port
    await new Promise(resolve => probe.close(resolve))
    if (!taken.has(port) && !web.ports.includes(port) && !guest.ports.includes(port)) closed = port
  }

  assert.ok(closed, 'a port number nobody here listens on')
  const secrets = [scratch, await realpath(scratch), pluginRoot, SECRET, os.userInfo().username]
  const run = (port, extra = {}, env) => helper({ port, pluginRoot, exclude: [], ...extra }, env).then(result => ({ result, row: answer(result, secrets) }))
  const noGit = { ...process.env, PATH: path.join(scratch, 'no-git-on-this-path') }, repoHome = { ...process.env, HOME: project }
  const [all, excluded, fromApi, fromApiNoGit, fromApiRepoHome, nothing, debuggerTarget, inspectorTarget, slowTarget] = await Promise.all([
    run(main), run(main, { exclude: [d1, d2, d3] }), run(apiPort, { exclude: docs.ports }), run(apiPort, { exclude: docs.ports }, noGit), run(apiPort, { exclude: docs.ports }, repoHome),
    run(closed), run(devtools.ports[0]), run(inspector), run(slow.ports[0]),
  ])
  // Each with its listener's pid: one process's ports (api's two, docs' five) share it.
  const yes = (port, label, pid) => ({ port, label, web: 'yes', pid })
  const slowOne = { port: slow.ports[0], label: 'slow.cjs', web: 'slow', pid: slow.child.pid }
  const answering = [yes(hmr, 'web.cjs', web.child.pid), yes(apiPort, 'api.cjs', apiRun.child.pid), yes(apiPort2, 'api.cjs', apiRun.child.pid), ...[d1, d2, d3, d4, d5].map(port => yes(port, 'docs.cjs', docs.child.pid))].sort((a, b) => a.port - b.port)
  for (const { row } of [all, excluded, fromApi, fromApiNoGit, fromApiRepoHome, debuggerTarget, inspectorTarget, slowTarget]) {
    assert.deepEqual(row.related.filter(item => forbidden.has(item.port)), [], 'raw TCP, resets, debuggers, plugin relays and outside servers are never suggested')
  }
  assert.deepEqual(all.row.target, { port: main, label: 'web.cjs', web: 'yes', devtools: false })
  assert.deepEqual(all.row.related, answering.slice(0, 6), 'six answering services beat the slow one')
  assert.deepEqual(excluded.row.related, [...answering.filter(item => ![d1, d2, d3].includes(item.port)), slowOne].sort((a, b) => a.port - b.port), 'exclude, and a silent listener as slow')
  assert.deepEqual(fromApi.row.target, { port: apiPort, label: 'api.cjs', web: 'yes', devtools: false })
  const own = [yes(apiPort2, 'api.cjs', apiRun.child.pid)], siblings = [yes(main, 'web.cjs', web.child.pid), yes(hmr, 'web.cjs', web.child.pid), ...own, slowOne].sort((a, b) => a.port - b.port)
  assert.deepEqual(fromApi.row.related, git ? siblings : own, git ? 'git top level finds the project from packages/api' : 'without git the root is the cwd')
  assert.deepEqual(fromApiNoGit.row, { ...fromApi.row, related: own }, 'no git on PATH: the root is the target cwd')
  assert.deepEqual(fromApiRepoHome.row, { ...fromApi.row, related: own }, 'a git repo at the home folder is not the project: the root is the target cwd')
  assert.deepEqual(nothing.row, { state: 'done', platform: process.platform, target: null, related: [] }, 'a port nobody listens on')
  assert.deepEqual(debuggerTarget.row.target, { port: devtools.ports[0], label: 'devtools.cjs', web: 'yes', devtools: true })
  assert.deepEqual(inspectorTarget.row.target, { port: inspector, label: 'idle.cjs', web: 'yes', devtools: true }, "Node's inspector answers GET / with 400 and is a debugger")
  assert.deepEqual(slowTarget.row.target, { port: slow.ports[0], label: 'slow.cjs', web: 'slow', devtools: false })
  const slowest = Math.max(...[all, excluded, fromApi, fromApiNoGit, fromApiRepoHome, nothing, debuggerTarget, inspectorTarget, slowTarget].map(({ result }) => result.ms))
  console.log(`ok live ${process.platform}: ${v6 ? '[::1]-only' : 'IPv4'} target, ${wildcard ? 'wildcard' : 'loopback'} sibling, six-row cap, each with its listener's pid, exclude, slow; garbage/reset/DevTools/inspector/relay/outside never suggested; ${git ? 'git top level vs ' : ''}cwd root (no git, repo at home); closed port; slowest ${slowest} ms`)

  // Owner mode: who holds one port, on both families, by the holders' commands alone.
  const ownerRun = (port, extra = {}) => helper({ port, pluginRoot, owner: true, ...extra }).then(result => ({ result, row: ownerAnswer(result, secrets) }))
  const [guestOwner, workerOwner, otherCopyOwner, webOwner, apiOwner, nobody] = await Promise.all([ownerRun(guest.ports[0]), ownerRun(worker.ports[0], { exclude: [] }), ownerRun(otherWorker.ports[0]), ownerRun(main), ownerRun(apiPort), ownerRun(closed)])
  assert.deepEqual(guestOwner.row.target, { port: guest.ports[0], label: 'local-preview.cjs', relay: true }, `a guest's listener on ${v6 ? '127.0.0.1 and ::1' : '127.0.0.1'}`)
  assert.deepEqual(workerOwner.row.target, { port: worker.ports[0], label: 'worker.cjs', relay: true }, "under the caller's own relay/")
  assert.deepEqual(otherCopyOwner.row.target, { port: otherWorker.ports[0], label: 'tcp-worker.cjs', relay: true }, "another copy's helper")
  assert.deepEqual(webOwner.row.target, { port: main, label: 'web.cjs', relay: false }, v6 ? 'an ordinary server on [::1] alone' : 'an ordinary server')
  assert.deepEqual(apiOwner.row.target, { port: apiPort, label: 'api.cjs', relay: false }, wildcard ? 'an ordinary server on the wildcard' : 'an ordinary server')
  assert.deepEqual(nobody.row, { state: 'done', platform: process.platform, target: null, related: [] }, 'a port nobody holds')
  const ownerSlowest = Math.max(...[guestOwner, workerOwner, otherCopyOwner, webOwner, apiOwner, nobody].map(({ result }) => result.ms))
  assert.ok(ownerSlowest < 2000 + 400, `owner mode answered within its 2 s deadline (process start included): ${ownerSlowest} ms`)
  console.log(`ok owner mode ${process.platform}: a guest's listener (${v6 ? 'both loopbacks' : 'IPv4'}), the caller's own and another copy's helpers are relays; ordinary servers aren't; nobody holds a closed port; slowest ${ownerSlowest} ms`)

  const began = Date.now()
  const quick = await run(main, { deadlineMs: 1000 })
  assert.ok(quick.result.ms < 1000 + 400, `deadline 1000 answered after ${quick.result.ms} ms (process start included)`)
  assert.ok(quick.row.target?.port === main)
  const allowed = new Set([hmr, ...apiRun.ports, ...docs.ports, slow.ports[0]])
  assert.ok(quick.row.related.every(item => allowed.has(item.port)))
  console.log(`ok deadlineMs 1000: one answer in ${Date.now() - began} ms with ${quick.row.related.length} related`)
}

try {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'shared-discover-'))
  parserChecks()
  await configChecks()
  if (process.platform === 'darwin' || process.platform === 'linux') await liveChecks()
  else console.log(`SKIP live listeners: ${process.platform} is not supported by discover.cjs yet`)
  console.log('All discover tests passed.')
} finally {
  await Promise.all([...children].map(stopChild))
  if (scratch) await rm(scratch, { recursive: true, force: true })
}
