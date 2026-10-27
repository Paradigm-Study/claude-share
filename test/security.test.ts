// No model or product accounts. What the security review of the plugin and
// the server asked for, checked: where a room's files are saved on a
// teammate's computer, where a guest's read really goes on the host's, the
// names a room keeps, the room page, what a seat may hold open (streams,
// long polls, a stream nobody reads), uploads
// against a room's quota, and on the Worker, a members-only team's rooms
// letting go of whoever leaves it and a room's end clearing the directory.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, symlink, lstat, readdir, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, test } from 'vitest'
import {
  Room,
  FILE_UPLOADS,
  LIMITS,
  PLUGIN_LATEST,
  ROOMS_PER_ADDRESS_DAY,
  SEAT_POLLS,
  SEAT_STREAMS,
  SERVE_LIMITS,
  landingPage,
  roomRequest,
  token,
} from '../server/core/index.ts'
import worker, { DirectoryObject, GateObject, RoomObject } from '../server/worker/index.ts'
import type { ServerEnv } from '../server/worker/index.ts'
import { Storage, State, asState, installRuntime } from './support/durable.ts'

const SAVE = fileURLToPath(new URL('../plugin/relay/save.sh', import.meta.url))
const REAL = fileURLToPath(new URL('../plugin/relay/real.sh', import.meta.url))
let scratch = ''
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'shared-security-'))
})
afterAll(() => rm(scratch, { recursive: true, force: true }))

// relay/save.sh: a room's file lands in <project>/.shared-session/ and nowhere
// else, through no link, with curl's settings on stdin.
test("relay/save.sh saves inside the project's .shared-session/ alone: no `..`, no link followed or made through, a link at the file replaced, a folder kept, nothing left by a failure", async () => {
  const bin = join(scratch, 'bin')
  await mkdir(bin)
  // A stand-in for curl: what it was given on stdin, written where -o says;
  // FAIL in its settings fails it as a refused download would.
  await writeFile(
    join(bin, 'curl'),
    '#!/bin/sh\nout=\nwhile [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; *) shift ;; esac; done\ncat > "$out"\ngrep -q FAIL "$out" && exit 22\nexit 0\n',
  )
  await chmod(join(bin, 'curl'), 0o755)
  // save.sh <project> <folder inside .shared-session/> <name> [exclude]
  const save = (project: string, folder: string, name: string, settings = 'url = "https://share.test/api/rooms/r/files/f"', extra: string[] = []) =>
    spawnSync('/bin/sh', [SAVE, project, folder, name, ...extra], {
      input: settings,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    }).status
  const project = join(scratch, 'project'),
    outside = join(scratch, 'outside')
  await mkdir(project)
  await mkdir(outside)
  await writeFile(join(project, 'package.json'), 'original')
  const box = join(project, '.shared-session')
  const leftovers = async (dir: string) => (await readdir(dir)).filter(n => n.startsWith('.download.'))

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
})

// relay/real.sh: where a guest's read really goes, links followed, so a link
// in the project (a repository's own) to a file of the host's is no read
// inside it. The plugin compares what it prints with the project's own.
test("relay/real.sh says where each path really is: through a folder's link, a file's and back out of one, a new path by its nearest folder, a dangling link not at all", async () => {
  const project = join(scratch, 'reads'),
    away = join(scratch, 'away')
  await mkdir(join(project, 'src'), { recursive: true })
  await mkdir(away)
  await writeFile(join(away, 'id_ed25519'), 'secret')
  await symlink(away, join(project, 'notes'))
  await symlink(join(away, 'id_ed25519'), join(project, 'key'))
  await symlink(join(scratch, 'gone'), join(project, 'dangling'))
  const real = (...paths: string[]) => {
    const run = spawnSync('/bin/sh', [REAL, ...paths], { encoding: 'utf8' })
    return run.status === 0 ? run.stdout.split('\n').slice(0, -1) : run.status
  }
  const [root] = real(project) as string[]
  assert.equal(root, spawnSync('/bin/sh', ['-c', 'cd -P -- "$1" && pwd -P', 'sh', project], { encoding: 'utf8' }).stdout.trim())
  assert.deepEqual(real(join(project, 'src'), join(project, 'src', 'new.ts'), join(project, 'new', 'deeper')), [
    `${root}/src`,
    `${root}/src/new.ts`,
    `${root}/new/deeper`,
  ])
  const [awayReal] = real(away) as string[]
  // Through a folder's link, a file's, and climbing back out of one.
  assert.deepEqual(real(join(project, 'notes', 'id_ed25519'), join(project, 'key'), `${project}/src/../notes/../x`), [
    `${awayReal}/id_ed25519`,
    `${awayReal}/id_ed25519`,
    `${awayReal!.slice(0, awayReal!.lastIndexOf('/'))}/x`,
  ])
  // A dangling link can't be told.
  assert.equal(real(join(project, 'dangling', 'x')), 1)
})

// The names a room keeps: one line, never only dots (a teammate's plugin names
// a folder after it).
test('a name that is only dots is kept as "teammate", and control characters as spaces', async () => {
  const now = Date.now()
  for (const [given, kept] of [
    ['..', 'teammate'],
    ['.', 'teammate'],
    ['...', 'teammate'],
    [' .. ', 'teammate'],
    ['', 'teammate'],
    ['Al\nex', 'Al ex'],
    ['Sam\x00', 'Sam'],
    ['.kyle', '.kyle'],
    ['a..b', 'a..b'],
  ]) {
    assert.equal(Room.create({ id: token(16), title: undefined, name: given, now, version: PLUGIN_LATEST }).host.name, kept, JSON.stringify(given))
    const room = Room.create({ id: token(16), title: undefined, name: 'Host', now, version: PLUGIN_LATEST })
    room.join(given, now, PLUGIN_LATEST)
    assert.ok(
      room.people(now).some(p => p.role !== 'host' && p.name === kept),
      JSON.stringify(given),
    )
  }
})

// The room page: a name can't end its script, and the page runs its own alone.
test('the room page escapes what it embeds, and its policy runs only its own script', async () => {
  const now = Date.now()
  const room = Room.create({ id: token(16), title: undefined, name: 'Host', now, version: PLUGIN_LATEST })
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
  const data = JSON.parse(/var data = (.*);\n/.exec(html)![1]!)
  assert.ok(
    data.people.some((p: { name: string }) => p.name === evil),
    'the name still shows as given',
  )
})

// What a seat holds open: SEAT_POLLS long polls, one more answering the
// oldest at once. Its SEAT_STREAMS streams are the Worker's (below).
test('a seat holds four long polls, one more answering the oldest at once', async () => {
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const room = Room.create({ id: token(16), title: undefined, name: 'Host', now: Date.now(), version: PLUGIN_LATEST })
  const guest = room.join('Gia', Date.now(), PLUGIN_LATEST)
  const ask = (path: string, bearer = guest.token) =>
    roomRequest(
      room,
      new Request(`https://share.test/api/rooms/${room.id}/${path}`, {
        headers: { authorization: `Bearer ${bearer}`, 'x-shared-session-version': PLUGIN_LATEST },
      }),
      path.split('?')[0]!,
      Date.now(),
      'https://share.test',
    )
  const polls = Array.from({ length: SEAT_POLLS + 1 }, () => ask(`events?after=${room.seq}&wait=20000`))
  const answered = await Promise.race([polls[0]!.then(() => true), wait(500).then(() => false)])
  assert.equal(answered, true, "a seat's long poll past SEAT_POLLS answers its oldest at once")
  assert.equal(room.waiters.size, SEAT_POLLS)
  room.append({ seat: 'host', name: 'Host', role: 'host' }, 'row', { kind: 'assistant', text: 'here' }, Date.now())
  room.wake()
  await Promise.all(polls)
  assert.equal(room.waiters.size, 0)
})

// A room's files: uploads at once count against its 100 MB together (each
// reserved before it's stored), and only FILE_UPLOADS are read at once.
test("uploads at once count against a room's 100 MB together, four read at a time", async () => {
  const MB = 1024 * 1024
  // A room whose store holds each file until let go.
  const gated = () => {
    const room = Room.create({ id: token(16), title: undefined, name: 'Host', now: Date.now(), version: PLUGIN_LATEST })
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    room.store = { put: async () => gate, get: async () => null }
    const up = (n: number, size: number) =>
      roomRequest(
        room,
        new Request(`https://share.test/api/rooms/${room.id}/files`, {
          method: 'POST',
          headers: { authorization: `Bearer ${room.host.token}`, 'x-shared-session-version': PLUGIN_LATEST, 'x-file-name': `up${n}.bin` },
          body: randomBytes(size),
        }),
        'files',
        Date.now(),
        'https://share.test',
      )
    return { room, up, release }
  }
  const busy = gated()
  const going = Array.from({ length: FILE_UPLOADS }, (_, n) => busy.up(n, 1024))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal((await busy.up(FILE_UPLOADS, 1024)).response.status, 429, `a file past ${FILE_UPLOADS} going up at once waits for its turn`)
  busy.release()
  assert.deepEqual(
    (await Promise.all(going)).map(r => r.response.status),
    Array(FILE_UPLOADS).fill(200),
  )
  const full = gated()
  for (let i = 0; i < 8; i++) full.room.files.set(`held${i}`, { id: `held${i}`, name: 'held', type: 'application/octet-stream', size: 10 * MB, ts: 0 })
  const ups = Array.from({ length: FILE_UPLOADS }, (_, n) => full.up(n, 9 * MB))
  await new Promise(resolve => setTimeout(resolve, 200))
  full.release()
  const codes = (await Promise.all(ups)).map(r => r.response.status).sort()
  assert.deepEqual(codes, [200, 200, 413, 413], 'uploads at once count together: 80 MB held, two of 9 MB fit')
  assert.equal(
    [...full.room.files.values()].reduce((n, f) => n + f.size, 0),
    98 * MB,
  )
  assert.equal(full.room.filesPending.size + full.room.uploading, 0)
})

// On the Worker: the directory object tells a members-only team's room
// objects whom it has now, and a room lets the others go and closes their
// streams; nothing from outside can say it. The stubs are test/support/durable.ts's.
describe('on the Worker', () => {
  let restore = () => {}
  beforeAll(() => {
    restore = installRuntime()
  })
  afterAll(() => restore())
  const env = { AUTH_TEST: '1', PUBLIC_URL: 'https://share.test', JOIN_LIMIT: { limit: async () => ({ success: true }) } } as unknown as ServerEnv
  const objects = new Map<string, { state: State; obj: RoomObject }>()
  const roomObject = async (id: string) => {
    if (!objects.has(id)) {
      const state = new State()
      objects.set(id, { state, obj: new RoomObject(asState(state), env) })
    }
    await objects.get(id)!.state.barrier
    return objects.get(id)!
  }
  // A stub: the object's methods, as RPC calls them.
  const rooms = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (input: RequestInfo, init?: RequestInit) => (await roomObject(id)).obj.fetch(new Request(input, init)),
      keepTeam: async (...args: Parameters<RoomObject['keepTeam']>) => (await roomObject(id)).obj.keepTeam(...args),
      info: async () => (await roomObject(id)).obj.info(),
    }),
  }
  const directoryStorage = new Storage()
  const directory = new DirectoryObject(asState({ storage: directoryStorage }), env)
  // A stub: the object's methods, as RPC calls them.
  Object.assign(env, { ROOMS: rooms, DIRECTORY: { idFromName: (name: string) => name, get: () => directory } })
  const ctx = {} as ExecutionContext
  const V = { 'x-shared-session-version': PLUGIN_LATEST, 'content-type': 'application/json' }
  // The server's answers, as the suite reads them.
  type Answer = { status: number; data: any }
  const at = async (
    path: string,
    { method = 'GET', body, tok, acct }: { method?: string; body?: unknown; tok?: string; acct?: string } = {},
  ): Promise<Answer> => {
    const headers = { ...V, ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(acct ? { 'x-shared-session-account': acct } : {}) }
    const res = await worker.fetch(
      new Request(`https://share.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      env,
      ctx,
    )
    const text = await res.text()
    try {
      return { status: res.status, data: JSON.parse(text) }
    } catch {
      return { status: res.status, data: text }
    }
  }
  const signIn = async (email: string, name: string, invite = ''): Promise<string> => {
    const verifier = randomBytes(24).toString('hex'),
      login = createHash('sha256').update(verifier).digest('hex')
    const page = String((await at(`/auth/test/start?login=${login}&email=${email}&name=${name}${invite ? `&invite=${invite}` : ''}`)).data)
    const nonce = /name="nonce" value="([^"]*)"/.exec(page)?.[1] ?? ''
    await worker.fetch(
      new Request('https://share.test/auth/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ login, nonce }),
      }),
      env,
      ctx,
    )
    return (await at('/api/auth/poll', { method: 'POST', body: { verifier } })).data.token
  }
  test("a members-only team's room lets go of someone removed from it as the directory says, closing their stream, saved so; no request from outside can say it; a seat's streams past four end its oldest; and a room's end takes its invites and listing from the directory, whose alarm is set for what's due", async () => {
    const wes = await signIn('wes@crew.test', 'Wes')
    const crew = (await at('/api/teams', { method: 'POST', tok: wes, body: { name: 'Crew' } })).data.team
    const fred = await signIn('fred@else.test', 'Fred', crew.invite)
    const gus = await signIn('gus@else.test', 'Gus', crew.invite)
    const fredId = (await at('/api/me', { tok: fred })).data.account.id
    const room = (await at('/api/rooms', { method: 'POST', acct: wes, body: { name: 'Wes', title: 'crew', team: crew.id } })).data
    assert.equal(room.team?.name, 'Crew', JSON.stringify(room))
    const [fredSeat, gusSeat] = [
      (await at(`/api/rooms/${room.id}/join`, { method: 'POST', acct: fred, body: { name: 'Fred' } })).data,
      (await at(`/api/rooms/${room.id}/join`, { method: 'POST', acct: gus, body: { name: 'Gus' } })).data,
    ]
    const { state, obj } = await roomObject(room.id)
    const socketOf = async (seat: { token: string }) => {
      const res = await obj.fetch(
        new Request(`https://room.internal/${room.id}/socket?after=0`, { headers: { ...V, authorization: `Bearer ${seat.token}`, upgrade: 'websocket' } }),
      )
      assert.equal(res.status, 101)
      return state.sockets.at(-1)!
    }
    const [fredWs, gusWs] = [await socketOf(fredSeat), await socketOf(gusSeat)]
    const out = async (seat: { token: string }) => (await at(`/api/rooms/${room.id}/events?after=0&wait=0`, { tok: seat.token })).status
    // A share link opens its page with a slash added, or doubled, as it did
    // before Hono; the server's own paths still don't take one.
    for (const path of [`/s/${room.id}`, `/s/${room.id}/`, `//s/${room.id}`]) {
      const page = await at(path)
      assert.equal(page.status, 200, path)
      assert.match(String(page.data), /is sharing a Claude Code session/, path)
    }
    assert.equal((await at(`/api/rooms/${room.id}/events/?after=0&wait=0`, { tok: fredSeat.token })).status, 200)
    for (const path of ['/api/version/', '/api/health/', `/s/${room.id}/x`]) assert.equal((await at(path)).status, 404, path)
    // Nobody outside says it: the Worker forwards no __ path to a room.
    assert.equal((await at(`/api/rooms/${room.id}/__team`, { method: 'POST', tok: room.token, body: { team: crew.id, allowed: [] } })).status, 404)
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
    objects.get(room.id)!.obj = new RoomObject(asState(state), env)
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
    assert.ok(directoryStorage.alarm! > Date.now() && directoryStorage.alarm! <= Date.now() + 12 * 60 * 60 * 1000 + 2000, 'the directory wakes for what is due')
    assert.equal((await at(`/api/rooms/${room.id}/end`, { method: 'POST', tok: room.token })).status, 200)
    assert.deepEqual(held(), [], "the room's end takes its invites and its place on the team's list")
    await directory.alarm()
    // The directory reads a room for its team's list over RPC; the paths of the
    // version before RPC are gone from both objects.
    {
      const again = (await at('/api/rooms', { method: 'POST', acct: wes, body: { name: 'Wes', title: 'crew again', team: crew.id } })).data
      assert.equal(
        (await at(`/api/teams/${crew.id}/sessions`, { tok: wes })).data.sessions?.[0]?.id,
        again.id,
        "the team's list reads the room through its info",
      )
      // An old directory's `__team` lets nobody go: Gus, in the team, is told
      // the team has no one, and stays.
      const seat = (await at(`/api/rooms/${again.id}/join`, { method: 'POST', acct: gus, body: { name: 'Gus' } })).data
      const { obj: againObj } = await roomObject(again.id)
      assert.notEqual(
        (
          await againObj.fetch(
            new Request(`https://room.internal/${again.id}/__team`, {
              method: 'POST',
              headers: { ...V, authorization: `Bearer ${again.token}` },
              body: JSON.stringify({ team: crew.id, allowed: [] }),
            }),
          )
        ).status,
        200,
      )
      assert.equal((await at(`/api/rooms/${again.id}/events?after=0&wait=0`, { tok: seat.token })).status, 200)
      // …and the directory answers no `/rpc/` call.
      assert.notEqual(
        (await directory.fetch(new Request('https://directory.internal/rpc/teamAccess', { method: 'POST', body: JSON.stringify([crew.id]) }))).status,
        200,
      )
    }
  })

  // What a room serves of its files is counted against its day, the
  // reservation saved before the bytes go (tcp:stats), so a room object
  // loaded again counts on from it.
  test('what a room serves of its files is counted against its day, saved before the bytes go, and counts on when the room object is loaded again', async () => {
    const made = (await at('/api/rooms', { method: 'POST', body: { name: 'Ivy', title: 'files' } })).data
    const put = await worker.fetch(
      new Request(`https://share.test/api/rooms/${made.id}/files`, {
        method: 'POST',
        headers: { ...V, authorization: `Bearer ${made.token}`, 'content-type': 'text/plain', 'x-file-name': 'a.txt' },
        body: 'hello',
      }),
      env,
      ctx,
    )
    assert.equal(put.status, 200)
    const file = (await put.json()) as { id: string }
    const get = () =>
      worker.fetch(
        new Request(`https://share.test/api/rooms/${made.id}/files/${file.id}`, { headers: { ...V, authorization: `Bearer ${made.token}` } }),
        env,
        ctx,
      )
    assert.equal(await (await get()).text(), 'hello')
    const { state: ivy } = objects.get(made.id)!
    const today = new Date().toISOString().slice(0, 10)
    assert.deepEqual(ivy.storage.data.get('tcp:stats').served, { day: today, reserved: SERVE_LIMITS.reserveBytes })
    // Spent, as saved: loaded again, nothing more goes out today.
    await ivy.storage.put('tcp:stats', { ...ivy.storage.data.get('tcp:stats'), served: { day: today, reserved: SERVE_LIMITS.roomBytesPerDay } })
    objects.get(made.id)!.obj = new RoomObject(asState(ivy), env)
    await ivy.barrier
    assert.equal((await get()).status, 429)
  })

  // The gate: today's rooms per address kept in storage under a keyed hash,
  // never the address, so a gate loaded again counts on; its alarm at the
  // day's end takes the day's counts and key.
  test("the gate's rooms per address a day survive the gate being loaded again, Shares at once counted one at a time, kept as keyed hashes and gone at the day's end", async () => {
    // Its reads take a moment, as a Durable Object's do, so Shares at once overlap.
    const storage = new (class extends Storage {
      override async get(key: string | string[]) {
        await new Promise(resolve => setTimeout(resolve, 5))
        return super.get(key)
      }
    })()
    const realNow = Date.now
    let clock = Date.parse('2026-10-22T10:00:00Z')
    Date.now = () => clock
    try {
      const admit = async (gate: GateObject, ip: string) =>
        (await gate.fetch(new Request('https://gate.internal/', { method: 'POST', body: JSON.stringify({ ip, max: 3000 }) }))).json() as Promise<{
          ok: boolean
          reason?: string
        }>
      let gate = new GateObject(asState({ storage }))
      for (let i = 0; i < ROOMS_PER_ADDRESS_DAY - 1; i++) {
        if (i % LIMITS.create.limit === 0) clock += 61_000 // its minute's own limit
        assert.equal((await admit(gate, '203.0.113.7')).ok, true, `room ${i}`)
      }
      clock += 61_000
      // Loaded again (a deploy, an eviction): the address's day goes on, and
      // two Shares at once for its last, each read from storage, make one.
      gate = new GateObject(asState({ storage }))
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
      assert.deepEqual(
        (await Promise.all([admit(gate, '203.0.113.7'), admit(gate, '198.51.100.2')])).map(b => b.ok),
        [true, true],
      )
      assert.deepEqual([...storage.data.keys()].map(k => k.replace(/[0-9a-f]{32}$/, '<hash>')).sort(), [
        'a:2026-10-23:<hash>',
        'a:2026-10-23:<hash>',
        'day:2026-10-23',
        'k:2026-10-23',
      ])
      assert.equal(storage.data.get('day:2026-10-23'), 2)
    } finally {
      Date.now = realNow
    }
  })
})
