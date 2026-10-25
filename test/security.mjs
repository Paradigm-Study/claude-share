// No model or product accounts. What the security review of the plugin and
// the server asked for, checked: where a room's files are saved on a
// teammate's computer, where a guest's read really goes on the host's, the
// names a room keeps, the room page, what a seat may hold open (streams,
// long polls, a stream nobody reads, on a real Node server too), uploads
// against a room's quota, and on the Worker, a members-only team's rooms
// letting go of whoever leaves it and a room's end clearing the directory.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { connect, createServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, symlink, lstat, readdir, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Room, FILE_UPLOADS, LIMITS, PLUGIN_LATEST, ROOMS_PER_ADDRESS_DAY, SEAT_POLLS, SEAT_STREAMS, SERVE_LIMITS, STREAM_PAGE, STREAM_UNREAD, landingPage, roomRequest, token } from '../server/core.mjs'

const SAVE = fileURLToPath(new URL('../plugin/relay/save.sh', import.meta.url))
const REAL = fileURLToPath(new URL('../plugin/relay/real.sh', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'shared-security-'))
const ok = label => console.log(`ok ${label}`)

// relay/save.sh: a room's file lands in <project>/.shared-session/ and nowhere
// else, through no link, with curl's settings on stdin.
{
  const bin = join(scratch, 'bin')
  await mkdir(bin)
  // A stand-in for curl: what it was given on stdin, written where -o says;
  // FAIL in its settings fails it as a refused download would.
  await writeFile(join(bin, 'curl'), '#!/bin/sh\nout=\nwhile [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; *) shift ;; esac; done\ncat > "$out"\ngrep -q FAIL "$out" && exit 22\nexit 0\n')
  await chmod(join(bin, 'curl'), 0o755)
  // save.sh <project> <folder inside .shared-session/> <name> [exclude]
  const save = (project, folder, name, settings = 'url = "https://share.test/api/rooms/r/files/f"', extra = []) =>
    spawnSync('/bin/sh', [SAVE, project, folder, name, ...extra], { input: settings, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).status
  const project = join(scratch, 'project'), outside = join(scratch, 'outside')
  await mkdir(project)
  await mkdir(outside)
  await writeFile(join(project, 'package.json'), 'original')
  const box = join(project, '.shared-session')
  const leftovers = async dir => (await readdir(dir)).filter(n => n.startsWith('.download.'))

  // An ordinary file, its folders made, and the project's git told to leave
  // .shared-session/ alone.
  const git = spawnSync('git', ['init', '-q', project]).status === 0
  assert.equal(save(project, 'Sam', 'notes.md', 'url = "a"', git ? ['exclude'] : []), 0)
  assert.equal(await readFile(join(box, 'Sam', 'notes.md'), 'utf8'), 'url = "a"')
  if (git) assert.match(await readFile(join(project, '.git', 'info', 'exclude'), 'utf8'), /^\.shared-session\/$/m)
  assert.equal(save(project, 'Sam/page-1a2b3c4d/img', '01.jpg', 'url = "jpg"'), 0)
  assert.equal(await readFile(join(box, 'Sam', 'page-1a2b3c4d', 'img', '01.jpg'), 'utf8'), 'url = "jpg"')
  // Again: the same place, replaced.
  assert.equal(save(project, 'Sam', 'notes.md', 'url = "b"'), 0)
  assert.equal(await readFile(join(box, 'Sam', 'notes.md'), 'utf8'), 'url = "b"')
  // A folder named from the root is still a place inside.
  assert.equal(save(project, '/etc', 'x.txt'), 0)
  assert.equal((await lstat(join(box, 'etc', 'x.txt'))).isFile(), true)

  // A folder that resolves outside .shared-session/ (a person named `..`).
  for (const folder of ['..', 'Sam/../..', 'Sam/./x', '.']) {
    assert.equal(save(project, folder, 'package.json', 'url = "evil"'), 3, folder)
    assert.equal(await readFile(join(project, 'package.json'), 'utf8'), 'original')
  }

  // A person's folder that's a link out of the project: nothing written or
  // made there.
  await symlink(outside, join(box, 'Linked'))
  assert.equal(save(project, 'Linked', 'x.txt'), 3)
  assert.equal(save(project, 'Linked/deeper', 'x.txt'), 3)
  assert.deepEqual(await readdir(outside), [])

  // A link left where the file goes: replaced, never written through.
  await symlink(join(project, 'package.json'), join(box, 'Sam', 'package.json'))
  assert.equal(save(project, 'Sam', 'package.json', 'url = "new"'), 0)
  assert.equal(await readFile(join(project, 'package.json'), 'utf8'), 'original')
  assert.equal((await lstat(join(box, 'Sam', 'package.json'))).isSymbolicLink(), false)
  assert.equal(await readFile(join(box, 'Sam', 'package.json'), 'utf8'), 'url = "new"')

  // A folder (or a link to one) in the file's place, and names that are no file's.
  await mkdir(join(box, 'Sam', 'folder'))
  assert.equal(save(project, 'Sam', 'folder'), 4)
  await symlink(outside, join(box, 'Sam', 'away'))
  assert.equal(save(project, 'Sam', 'away'), 4)
  assert.deepEqual(await readdir(outside), [])
  for (const name of ['', '.', '..', 'a/b', '../package.json']) assert.equal(save(project, 'Sam', name), 3, name)

  // A failed download leaves nothing behind, and keeps what was there.
  assert.equal(save(project, 'Sam', 'notes.md', 'FAIL'), 1)
  assert.equal(await readFile(join(box, 'Sam', 'notes.md'), 'utf8'), 'url = "b"')
  assert.deepEqual(await leftovers(join(box, 'Sam')), [])

  // .shared-session itself a link out of the project: nothing at all.
  const other = join(scratch, 'other')
  await mkdir(other)
  await symlink(outside, join(other, '.shared-session'))
  assert.equal(save(other, 'Sam', 'x.txt'), 3)
  assert.deepEqual(await readdir(outside), [])
  ok('relay/save.sh saves inside the project\'s .shared-session/ alone: no `..`, no link followed or made through, a link at the file replaced, a folder kept, nothing left by a failure')
}

// relay/real.sh: where a guest's read really goes, links followed, so a link
// in the project (a repository's own) to a file of the host's is no read
// inside it. The plugin compares what it prints with the project's own.
{
  const project = join(scratch, 'reads'), away = join(scratch, 'away')
  await mkdir(join(project, 'src'), { recursive: true })
  await mkdir(away)
  await writeFile(join(away, 'id_ed25519'), 'secret')
  await symlink(away, join(project, 'notes'))
  await symlink(join(away, 'id_ed25519'), join(project, 'key'))
  await symlink(join(scratch, 'gone'), join(project, 'dangling'))
  const real = (...paths) => {
    const run = spawnSync('/bin/sh', [REAL, ...paths], { encoding: 'utf8' })
    return run.status === 0 ? run.stdout.split('\n').slice(0, -1) : run.status
  }
  const [root] = real(project)
  assert.equal(root, spawnSync('/bin/sh', ['-c', 'cd -P -- "$1" && pwd -P', 'sh', project], { encoding: 'utf8' }).stdout.trim())
  assert.deepEqual(real(join(project, 'src'), join(project, 'src', 'new.ts'), join(project, 'new', 'deeper')), [`${root}/src`, `${root}/src/new.ts`, `${root}/new/deeper`])
  const [awayReal] = real(away)
  // Through a folder's link, a file's, and climbing back out of one.
  assert.deepEqual(real(join(project, 'notes', 'id_ed25519'), join(project, 'key'), `${project}/src/../notes/../x`), [`${awayReal}/id_ed25519`, `${awayReal}/id_ed25519`, `${awayReal.slice(0, awayReal.lastIndexOf('/'))}/x`])
  // A dangling link can't be told.
  assert.equal(real(join(project, 'dangling', 'x')), 1)
  ok('relay/real.sh says where each path really is: through a folder\'s link, a file\'s and back out of one, a new path by its nearest folder, a dangling link not at all')
}

// The names a room keeps: one line, never only dots (a teammate's plugin names
// a folder after it).
{
  const now = Date.now()
  for (const [given, kept] of [['..', 'teammate'], ['.', 'teammate'], ['...', 'teammate'], [' .. ', 'teammate'], ['', 'teammate'], ['Al\nex', 'Al ex'], ['Sam\x00', 'Sam'], ['.kyle', '.kyle'], ['a..b', 'a..b']]) {
    assert.equal(Room.create({ id: token(16), name: given, now, version: PLUGIN_LATEST }).host.name, kept, JSON.stringify(given))
    const room = Room.create({ id: token(16), name: 'Host', now, version: PLUGIN_LATEST })
    room.join(given, now, PLUGIN_LATEST)
    assert.ok(room.people(now).some(p => p.role !== 'host' && p.name === kept), JSON.stringify(given))
  }
  ok('a name that is only dots is kept as "teammate", and control characters as spaces')
}

// The room page: a name can't end its script, and the page runs its own alone.
{
  const now = Date.now()
  const room = Room.create({ id: token(16), name: 'Host', now, version: PLUGIN_LATEST })
  const evil = '</script><script>alert(1)</script>'
  room.join(evil, now, PLUGIN_LATEST)
  const response = landingPage(room, `https://share.test/s/${room.id}`, now)
  const html = await response.text()
  assert.ok(!html.includes('<script>alert(1)'), 'the name never closes the script')
  const policy = response.headers.get('content-security-policy') ?? ''
  const nonce = /script-src 'nonce-([\w-]+)'/.exec(policy)?.[1]
  assert.ok(nonce, policy)
  assert.match(policy, /default-src 'none'/)
  assert.match(policy, /frame-ancestors 'none'/)
  const scripts = [...html.matchAll(/<script([^>]*)>/g)].map(m => m[1])
  assert.deepEqual(scripts, [` nonce="${nonce}"`], 'one script, the nonce its own')
  const data = JSON.parse(/var data = (.*);\n/.exec(html)[1])
  assert.ok(data.people.some(p => p.name === evil), 'the name still shows as given')
  ok('the room page escapes what it embeds, and its policy runs only its own script')
}

// What a seat holds open: SEAT_STREAMS streams and SEAT_POLLS long polls,
// one more taking the oldest's place; a stream's events in pages of
// STREAM_PAGE as its reader takes them; and a stream whose reader stopped
// ends once it holds STREAM_UNREAD, with what it held.
{
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const room = Room.create({ id: token(16), name: 'Host', now: Date.now(), version: PLUGIN_LATEST })
  const guest = room.join('Gia', Date.now(), PLUGIN_LATEST)
  const ask = (path, bearer = guest.token) => roomRequest(room, new Request(`https://share.test/api/rooms/${room.id}/${path}`, { headers: { authorization: `Bearer ${bearer}`, 'x-shared-session-version': PLUGIN_LATEST } }), path.split('?')[0], Date.now(), 'https://share.test')
  const lines = async (reader, until) => {
    const out = []
    let text = ''
    while (!until(out)) {
      const { done, value } = await reader.read()
      if (done) return { out, done: true }
      text += new TextDecoder().decode(value)
      for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n')) { out.push({ bytes: at, page: JSON.parse(text.slice(0, at)) }); text = text.slice(at + 1) }
    }
    return { out, done: false }
  }
  const streams = []
  for (let i = 0; i <= SEAT_STREAMS; i++) streams.push((await ask(`stream?after=${room.seq}`)).response.body.getReader())
  const first = await lines(streams[0], () => false)
  assert.equal(first.done, true, 'a seat\'s stream past SEAT_STREAMS ends its oldest')
  assert.equal([...room.subscribers].filter(s => s.seat === guest.seat.id).length, SEAT_STREAMS)
  const host = (await ask(`stream?after=${room.seq}`, room.host.token)).response.body.getReader()
  assert.equal(room.subscribers.size, SEAT_STREAMS + 1, "another seat's streams are its own")
  for (const reader of [...streams, host]) await reader.cancel()
  assert.equal(room.subscribers.size, 0)

  const polls = Array.from({ length: SEAT_POLLS + 1 }, () => ask(`events?after=${room.seq}&wait=20000`))
  const answered = await Promise.race([polls[0].then(() => true), wait(500).then(() => false)])
  assert.equal(answered, true, 'a seat\'s long poll past SEAT_POLLS answers its oldest at once')
  assert.equal(room.waiters.size, SEAT_POLLS)
  room.append({ seat: 'host', name: 'Host', role: 'host' }, 'row', { kind: 'assistant', text: 'here' }, Date.now())
  room.wake()
  await Promise.all(polls)
  assert.equal(room.waiters.size, 0)

  // A long history in pages, as its reader takes them (an event's strings
  // are cut at 32,000 characters).
  for (let i = 0; i < 80; i++) room.append({ seat: 'host', name: 'Host', role: 'host' }, 'row', { kind: 'assistant', text: `${i} ${'x'.repeat(30_000)}` }, Date.now())
  const paged = (await ask('stream?after=0')).response.body.getReader()
  const read = await lines(paged, out => out.some(l => l.page.events && !l.page.more))
  const pages = read.out.filter(l => l.page.events)
  assert.ok(pages.length >= 4 && pages.slice(0, -1).every(l => l.page.more && l.bytes <= STREAM_PAGE + 64 * 1024), `pages of at most ${STREAM_PAGE} bytes of events: ${pages.map(l => l.bytes)}`)
  assert.deepEqual(pages.flatMap(l => l.page.events.map(e => e.seq)), room.since(0).map(e => e.seq), 'every event once, in order')
  await paged.cancel()

  // A reader that stopped: the stream ends once it holds STREAM_UNREAD.
  const stuck = (await ask(`stream?after=${room.seq}`)).response.body.getReader()
  let posted = 0
  while ([...room.subscribers].length && posted < 4 * STREAM_UNREAD) {
    room.append({ seat: 'host', name: 'Host', role: 'host' }, 'row', { kind: 'assistant', text: 'y'.repeat(30_000) }, Date.now())
    room.wake()
    posted += 30_000
  }
  assert.equal(room.subscribers.size, 0, 'a stream nobody reads ends')
  assert.ok(posted <= STREAM_UNREAD + 2 * STREAM_PAGE, `within what it may hold unread (${posted})`)
  assert.equal(await stuck.read().then(() => 'read', () => 'failed'), 'failed', 'and what it held goes with it')
  ok('a seat holds four streams and four long polls (one more takes the oldest\'s place), a stream pages its events as its reader takes them, and one nobody reads ends')
}

// A room's files: uploads at once count against its 100 MB together (each
// reserved before it's stored), and only FILE_UPLOADS are read at once.
{
  const MB = 1024 * 1024
  // A room whose store holds each file until let go.
  const gated = () => {
    const room = Room.create({ id: token(16), name: 'Host', now: Date.now(), version: PLUGIN_LATEST })
    let release
    const gate = new Promise(resolve => { release = resolve })
    room.store = { put: async () => gate, get: async () => null }
    const up = (n, size) => roomRequest(room, new Request(`https://share.test/api/rooms/${room.id}/files`, { method: 'POST', headers: { authorization: `Bearer ${room.host.token}`, 'x-shared-session-version': PLUGIN_LATEST, 'x-file-name': `up${n}.bin` }, body: randomBytes(size) }), 'files', Date.now(), 'https://share.test')
    return { room, up, release }
  }
  const busy = gated()
  const going = Array.from({ length: FILE_UPLOADS }, (_, n) => busy.up(n, 1024))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal((await busy.up(FILE_UPLOADS, 1024)).response.status, 429, `a file past ${FILE_UPLOADS} going up at once waits for its turn`)
  busy.release()
  assert.deepEqual((await Promise.all(going)).map(r => r.response.status), Array(FILE_UPLOADS).fill(200))
  const full = gated()
  for (let i = 0; i < 8; i++) full.room.files.set(`held${i}`, { id: `held${i}`, name: 'held', type: 'application/octet-stream', size: 10 * MB, ts: 0 })
  const ups = Array.from({ length: FILE_UPLOADS }, (_, n) => full.up(n, 9 * MB))
  await new Promise(resolve => setTimeout(resolve, 200))
  full.release()
  const codes = (await Promise.all(ups)).map(r => r.response.status).sort()
  assert.deepEqual(codes, [200, 200, 413, 413], 'uploads at once count together: 80 MB held, two of 9 MB fit')
  assert.equal([...full.room.files.values()].reduce((n, f) => n + f.size, 0), 98 * MB)
  assert.equal(full.room.filesPending.size + full.room.uploading, 0)
  ok('uploads at once count against a room\'s 100 MB together, four read at a time')
}

// Node's server writes a stream at its client's pace: one that stops reading
// is cut off once the room's stream holds what it may, never buffered whole.
{
  const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
  const port = await freePort(), previewPort = await freePort()
  const dir = await mkdtemp(join(tmpdir(), 'shared-security-node-'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/node.mjs', import.meta.url))], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, PORT: String(port), PREVIEW_PORT: String(previewPort), DATA_FILE: '' }, stdio: ['ignore', 'ignore', 'inherit'] })
  try {
    const origin = `http://127.0.0.1:${port}`
    for (let i = 0; i < 150 && !(await fetch(`${origin}/api/health`).then(r => r.ok, () => false)); i++) await new Promise(r => setTimeout(r, 20))
    const api = async (path, bearer, body) => (await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-shared-session-version': PLUGIN_LATEST, 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json()
    const room = await api('/api/rooms', null, { name: 'Host', title: 't' })
    const guest = await api(`/api/rooms/${room.id}/join`, null, { name: 'Gia' })
    // A client that asks for the stream and never reads.
    const socket = connect(port, '127.0.0.1')
    await once(socket, 'connect')
    socket.write(`GET /api/rooms/${room.id}/stream?after=0 HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${guest.token}\r\nx-shared-session-version: ${PLUGIN_LATEST}\r\n\r\n`)
    socket.pause()
    let received = 0, ended = false
    socket.on('data', b => { received += b.length })
    socket.on('close', () => { ended = true })
    const total = 32 * 1024 * 1024
    // Posts of 450 KB (the events route takes 512 KB), each a page of its own.
    for (let sent = 0; sent < total; sent += 15 * 30_000) {
      const posted = await api(`/api/rooms/${room.id}/events`, room.token, { events: Array.from({ length: 15 }, () => ({ type: 'row', body: { kind: 'assistant', text: 'z'.repeat(30_000) } })) })
      assert.equal(typeof posted.seq, 'number', JSON.stringify(posted))
    }
    socket.resume()
    for (let i = 0; i < 250 && !ended; i++) await new Promise(r => setTimeout(r, 20))
    assert.equal(ended, true, 'the stream ends')
    assert.ok(received < total / 2, `long before it would have sent everything (${received} bytes)`)
    ok("Node's server writes a stream at its client's pace, and ends one that stopped reading rather than buffering what it would send")
  } finally {
    child.kill()
    if (child.exitCode === null) await once(child, 'exit')
    await rm(dir, { recursive: true, force: true })
  }
}

// On the Worker: the directory object tells a members-only team's room
// objects whom it has now, and a room lets the others go and closes their
// streams; nothing from outside can say it. Stubs as test/peer.mjs has them.
{
  const NativeResponse = globalThis.Response
  class Socket {
    sent = []
    closes = []
    tags = []
    attachment = null
    send(data) { if (this.closes.length) throw new Error('closed'); this.sent.push(structuredClone(data)) }
    close(code, reason) { this.closes.push({ code, reason }) }
    serializeAttachment(att) { this.attachment = structuredClone(att) }
    deserializeAttachment() { return structuredClone(this.attachment) }
  }
  globalThis.WebSocketPair = class { constructor() { this[0] = new Socket(); this[1] = new Socket() } }
  globalThis.Response = class extends NativeResponse {
    constructor(body, options = {}) {
      super(body, options.status === 101 ? { ...options, status: 200 } : options)
      if (options.status === 101) Object.defineProperty(this, 'status', { value: 101 })
      if (options.webSocket) this.webSocket = options.webSocket
    }
  }
  class Storage {
    data = new Map()
    alarm = null
    async get(key) {
      if (Array.isArray(key)) return new Map(key.filter(k => this.data.has(k)).map(k => [k, structuredClone(this.data.get(k))]))
      return structuredClone(this.data.get(key))
    }
    async put(key, value) { for (const [k, v] of typeof key === 'string' ? [[key, value]] : Object.entries(key)) this.data.set(k, structuredClone(v)) }
    async list({ prefix = '' } = {}) { return new Map([...this.data].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, structuredClone(v)])) }
    async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key) }
    async deleteAll() { this.data.clear() }
    async setAlarm(at) { this.alarm = at }
    async getAlarm() { return this.alarm }
    async transaction(fn) { return fn(this) }
  }
  class State {
    id = (hex => ({ toString: () => hex }))(randomBytes(32).toString('hex'))
    storage = new Storage()
    sockets = []
    barrier = Promise.resolve()
    blockConcurrencyWhile(fn) { const result = this.barrier.then(fn); this.barrier = result.catch(() => {}); return result }
    acceptWebSocket(ws, tags) { ws.tags = tags; this.sockets.push(ws) }
    getWebSockets(tag) { return this.sockets.filter(ws => !tag || ws.tags.includes(tag)) }
  }
  const { default: worker, RoomObject, DirectoryObject } = await import('../server/worker.mjs')
  const env = { AUTH_TEST: '1', PUBLIC_URL: 'https://share.test', JOIN_LIMIT: { limit: async () => ({ success: true }) } }
  const objects = new Map()
  const roomObject = async id => {
    if (!objects.has(id)) { const state = new State(); objects.set(id, { state, obj: new RoomObject(state, env) }) }
    await objects.get(id).state.barrier
    return objects.get(id)
  }
  env.ROOMS = { idFromName: name => name, get: id => ({ fetch: async (input, init) => (await roomObject(id)).obj.fetch(new Request(input, init)), keepTeam: async (...args) => (await roomObject(id)).obj.keepTeam(...args) }) }
  const directoryStorage = new Storage()
  const directory = new DirectoryObject({ storage: directoryStorage }, env)
  // A stub: the object's methods, as RPC calls them.
  env.DIRECTORY = { idFromName: name => name, get: () => directory }
  const V = { 'x-shared-session-version': PLUGIN_LATEST, 'content-type': 'application/json' }
  const at = async (path, { method = 'GET', body, tok, acct } = {}) => {
    const headers = { ...V, ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(acct ? { 'x-shared-session-account': acct } : {}) }
    const res = await worker.fetch(new Request(`https://share.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
    const text = await res.text()
    try { return { status: res.status, data: JSON.parse(text) } } catch { return { status: res.status, data: text } }
  }
  const signIn = async (email, name, invite = '') => {
    const verifier = randomBytes(24).toString('hex'), login = createHash('sha256').update(verifier).digest('hex')
    const page = String((await at(`/auth/test/start?login=${login}&email=${email}&name=${name}${invite ? `&invite=${invite}` : ''}`)).data)
    const nonce = /name="nonce" value="([^"]*)"/.exec(page)?.[1] ?? ''
    await worker.fetch(new Request('https://share.test/auth/confirm', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ login, nonce }) }), env)
    return (await at('/api/auth/poll', { method: 'POST', body: { verifier } })).data.token
  }
  const wes = await signIn('wes@crew.test', 'Wes')
  const crew = (await at('/api/teams', { method: 'POST', tok: wes, body: { name: 'Crew' } })).data.team
  const [fred, gus] = [await signIn('fred@else.test', 'Fred', crew.invite), await signIn('gus@else.test', 'Gus', crew.invite)]
  const fredId = (await at('/api/me', { tok: fred })).data.account.id
  const room = (await at('/api/rooms', { method: 'POST', acct: wes, body: { name: 'Wes', title: 'crew', team: crew.id } })).data
  assert.equal(room.team?.name, 'Crew', JSON.stringify(room))
  const [fredSeat, gusSeat] = [(await at(`/api/rooms/${room.id}/join`, { method: 'POST', acct: fred, body: { name: 'Fred' } })).data, (await at(`/api/rooms/${room.id}/join`, { method: 'POST', acct: gus, body: { name: 'Gus' } })).data]
  const { state, obj } = await roomObject(room.id)
  const socketOf = async seat => {
    const res = await obj.fetch(new Request(`https://room.internal/${room.id}/socket?after=0`, { headers: { ...V, authorization: `Bearer ${seat.token}`, upgrade: 'websocket' } }))
    assert.equal(res.status, 101)
    return state.sockets.at(-1)
  }
  const [fredWs, gusWs] = [await socketOf(fredSeat), await socketOf(gusSeat)]
  const out = async seat => (await at(`/api/rooms/${room.id}/events?after=0&wait=0`, { tok: seat.token })).status
  // Nobody outside says it: the Worker forwards no __ path to a room, and the
  // room has no path for it at all (the directory calls its keepTeam).
  assert.equal((await at(`/api/rooms/${room.id}/__team`, { method: 'POST', tok: room.token, body: { team: crew.id, allowed: [] } })).status, 404)
  assert.equal((await obj.fetch(new Request(`https://room.internal/${room.id}/__team`, { method: 'POST', headers: { ...V, authorization: `Bearer ${room.token}` }, body: JSON.stringify({ team: crew.id, allowed: [] }) }))).status, 404)
  assert.equal(await out(gusSeat), 200)
  assert.equal((await at(`/api/teams/${crew.id}/members/${fredId}`, { method: 'DELETE', tok: wes })).status, 200)
  assert.deepEqual(fredWs.closes, [{ code: 1008, reason: 'left' }], "the removed member's stream closes")
  assert.deepEqual(gusWs.closes, [], "a member's stays open")
  assert.equal(await out(fredSeat), 401)
  assert.equal(await out(gusSeat), 200)
  assert.equal((await at(`/api/rooms/${room.id}/join`, { method: 'POST', acct: fred, body: { name: 'Fred' } })).status, 403)
  // A seat's streams past SEAT_STREAMS: its oldest ends.
  const more = []
  for (let i = 0; i < SEAT_STREAMS; i++) more.push(await socketOf(gusSeat))
  assert.deepEqual(gusWs.closes, [{ code: 1008, reason: 'Too many streams' }])
  assert.ok(more.every(ws => ws.closes.length === 0))
  // Its people, after a sleep: the seat is gone from what the room saved too.
  objects.get(room.id).obj = new RoomObject(state, env)
  await state.barrier
  assert.equal(await out(fredSeat), 401)
  assert.equal(await out(gusSeat), 200)
  // An invite from the room: the directory's alarm is set for when it goes,
  // and the room's end takes it and the room's place on its team's list.
  const gusId = (await at('/api/me', { tok: gus })).data.account.id
  assert.deepEqual((await at(`/api/rooms/${room.id}/invite`, { method: 'POST', tok: room.token, acct: wes, body: { to: [gusId] } })).data.invited, ['Gus'])
  const held = () => [...directoryStorage.data.keys()].filter(k => k.includes(room.id))
  assert.deepEqual(held().sort(), [`live:${crew.id}:${room.id}`, `rinv:${room.id}:${gusId}`, `sinv:${gusId}:${room.id}`])
  // Set for the soonest due (a sign-in under way here), then the next.
  assert.ok(directoryStorage.alarm > Date.now() && directoryStorage.alarm <= Date.now() + 12 * 60 * 60 * 1000 + 2000, 'the directory wakes for what is due')
  assert.equal((await at(`/api/rooms/${room.id}/end`, { method: 'POST', tok: room.token })).status, 200)
  assert.deepEqual(held(), [], "the room's end takes its invites and its place on the team's list")
  await directory.alarm()
  ok("on the Worker, a members-only team's room lets go of someone removed from it as the directory says, closing their stream, saved so; no request from outside can say it; a seat's streams past four end its oldest; and a room's end takes its invites and listing from the directory, whose alarm is set for what's due")

  // What a room serves of its files is counted against its day, the
  // reservation saved before the bytes go (tcp:stats), so a room object
  // loaded again counts on from it.
  {
    const made = (await at('/api/rooms', { method: 'POST', body: { name: 'Ivy', title: 'files' } })).data
    const put = await worker.fetch(new Request(`https://share.test/api/rooms/${made.id}/files`, { method: 'POST', headers: { ...V, authorization: `Bearer ${made.token}`, 'content-type': 'text/plain', 'x-file-name': 'a.txt' }, body: 'hello' }), env)
    assert.equal(put.status, 200)
    const file = await put.json()
    const get = () => worker.fetch(new Request(`https://share.test/api/rooms/${made.id}/files/${file.id}`, { headers: { ...V, authorization: `Bearer ${made.token}` } }), env)
    assert.equal(await (await get()).text(), 'hello')
    const { state: ivy } = objects.get(made.id)
    const today = new Date().toISOString().slice(0, 10)
    assert.deepEqual(ivy.storage.data.get('tcp:stats').served, { day: today, reserved: SERVE_LIMITS.reserveBytes })
    // Spent, as saved: loaded again, nothing more goes out today.
    await ivy.storage.put('tcp:stats', { ...ivy.storage.data.get('tcp:stats'), served: { day: today, reserved: SERVE_LIMITS.roomBytesPerDay } })
    objects.get(made.id).obj = new RoomObject(ivy, env)
    await ivy.barrier
    assert.equal((await get()).status, 429)
  }
  globalThis.Response = NativeResponse
  ok('on the Worker, what a room serves of its files is counted against its day, saved before the bytes go, and counts on when the room object is loaded again')

  // The gate: today's rooms per address kept in storage under a keyed hash,
  // never the address, so a gate loaded again counts on; its alarm at the
  // day's end takes the day's counts and key.
  {
    const { GateObject } = await import('../server/worker.mjs')
    // Its reads take a moment, as a Durable Object's do, so Shares at once overlap.
    const storage = new (class extends Storage { async get(key) { await new Promise(resolve => setTimeout(resolve, 5)); return super.get(key) } })()
    const realNow = Date.now
    let clock = Date.parse('2026-10-22T10:00:00Z')
    Date.now = () => clock
    try {
      const admit = async (gate, ip) => (await gate.fetch(new Request('https://gate.internal/', { method: 'POST', body: JSON.stringify({ ip, max: 3000 }) }))).json()
      let gate = new GateObject({ storage })
      for (let i = 0; i < ROOMS_PER_ADDRESS_DAY - 1; i++) {
        if (i % LIMITS.create.limit === 0) clock += 61_000 // its minute's own limit
        assert.equal((await admit(gate, '203.0.113.7')).ok, true, `room ${i}`)
      }
      clock += 61_000
      // Loaded again (a deploy, an eviction): the address's day goes on, and
      // two Shares at once for its last, each read from storage, make one.
      gate = new GateObject({ storage })
      const both = await Promise.all([admit(gate, '203.0.113.7'), admit(gate, '203.0.113.7')])
      assert.deepEqual(both.map(b => b.ok).sort(), [false, true])
      clock += 61_000
      assert.deepEqual(await admit(gate, '203.0.113.7'), { ok: false, reason: 'address' })
      assert.equal((await admit(gate, '198.51.100.2')).ok, true)
      assert.equal(storage.data.get('day:2026-10-22'), ROOMS_PER_ADDRESS_DAY + 1)
      // What's kept names no address.
      assert.ok(![...storage.data].some(([k, v]) => `${k} ${v}`.includes('203.0.113') || `${k} ${v}`.includes('198.51.100')))
      assert.equal([...storage.data.keys()].filter(k => k.startsWith('a:2026-10-22:')).length, 2)
      assert.equal(storage.alarm, Date.parse('2026-10-23T00:01:00Z'))
      clock = storage.alarm
      await gate.alarm()
      assert.deepEqual([...storage.data.keys()], [])
      // The next day, the address shares again, under the next day's one key
      // (the day's first Shares at once make one).
      assert.deepEqual((await Promise.all([admit(gate, '203.0.113.7'), admit(gate, '198.51.100.2')])).map(b => b.ok), [true, true])
      assert.deepEqual([...storage.data.keys()].map(k => k.replace(/[0-9a-f]{32}$/, '<hash>')).sort(), ['a:2026-10-23:<hash>', 'a:2026-10-23:<hash>', 'day:2026-10-23', 'k:2026-10-23'])
      assert.equal(storage.data.get('day:2026-10-23'), 2)
    } finally {
      Date.now = realNow
    }
  }
  ok("on the Worker, the gate's rooms per address a day survive the gate being loaded again, Shares at once counted one at a time, kept as keyed hashes and gone at the day's end")
}

await rm(scratch, { recursive: true, force: true })
