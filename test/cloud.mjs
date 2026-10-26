// The cloud host's handoff (docs/cloud-host.md), through the room core with a
// stand-in for the container: who may move a session and bring it home, whose
// tokens work when, who may answer the runner's questions, and that the
// runner's changes come home. No model, no Docker.
//
//   node test/cloud.mjs
//
// With CLOUD_DOCKER=1 (Docker running: wrangler dev builds cloud/Dockerfile)
// and model access in ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN, it also moves a
// session into a real container through the Workers under wrangler dev and
// has a teammate's prompt answered there.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startWorkerd } from './support/workerd.mjs'
import { randomUUID } from 'node:crypto'
import { Room, roomRequest, CLOUD_MAX_MS } from '../server/core.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ORIGIN = 'https://share.test'
let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}\n     ${error?.stack?.split('\n').slice(0, 8).join('\n     ') ?? error}`)
  }
}

// A request as the adapters hand it to the core.
const ask = (room, { method = 'GET', rest = '', token, account, body, now = Date.now(), cloud, directory }) =>
  roomRequest(
    room,
    new Request(`${ORIGIN}/api/rooms/${room.id}/${rest}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-shared-session-version': '0.11.31', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(account ? { 'x-shared-session-account': account } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    rest,
    now,
    ORIGIN,
    { cloud, directory },
  ).then(async ({ response, changed }) => ({ status: response.status, body: await response.clone().json().catch(() => null), raw: response, changed }))

// The container, as the room sees it: what it was started with, and its changes.
function standIn({ fail = false, diff = 'diff --git a/x b/x\n' } = {}) {
  const calls = { started: [], stopped: [] }
  return {
    calls,
    async start(id, payload) {
      if (fail) throw new Error('no capacity')
      calls.started.push({ id, payload })
    },
    async stop(id) {
      calls.stopped.push(id)
      return new TextEncoder().encode(diff)
    },
  }
}

const moveBody = { session: randomUUID(), cwd: '/Users/scott/project', auth: { oauthToken: 'sk-ant-oat01-test' }, state: { policy: { prompts: 'everyone', approvals: 'edits' } } }

function freshRoom(now = Date.now()) {
  const room = Room.create({ id: 'room0000000000000001', name: 'Scott', title: 'demo', now, version: '0.11.31' })
  const guest = room.join('Kyle', now, '0.11.31')
  return { room, host: room.host.token, guest: guest.token }
}

await check('only the host moves a session, and a server without containers says so', async () => {
  const { room, guest, host } = freshRoom()
  assert.equal((await ask(room, { method: 'POST', rest: 'cloud', token: guest, body: moveBody, cloud: standIn() })).status, 403)
  const none = await ask(room, { method: 'POST', rest: 'cloud', token: host, body: moveBody })
  assert.equal(none.status, 501)
  assert.match(none.body.error, /can't keep sessions running in the cloud/)
  assert.equal(room.cloud, null)
})

await check('a move hands the host to the runner and seats the mover as the approver', async () => {
  const { room, host } = freshRoom()
  const cloud = standIn()
  const moved = await ask(room, { method: 'POST', rest: 'cloud', token: host, body: moveBody, cloud })
  assert.equal(moved.status, 200)
  assert.ok(moved.body.token && moved.body.seat && moved.body.ticket)
  const { config, ticket } = cloud.calls.started[0].payload
  assert.equal(ticket, moved.body.ticket)
  assert.equal(config.session, moveBody.session)
  assert.equal(config.cwd, moveBody.cwd)
  assert.deepEqual(config.auth, { oauthToken: 'sk-ant-oat01-test' })
  assert.equal(config.url, `${ORIGIN}/s/${room.id}`)
  // The old host token stops working; the runner's is the host's; the mover is a guest.
  assert.equal((await ask(room, { method: 'GET', rest: 'events', token: host })).status, 401)
  assert.equal(room.auth(config.token)?.role, 'host')
  assert.equal(room.auth(moved.body.token)?.role, 'guest')
  assert.equal(room.cloud.state, 'starting')
  assert.equal(room.cloud.approver.name, 'Scott')
  // Everyone hears it, and the host shows as in the cloud.
  assert.ok(room.events.some(e => e.type === 'cloud' && e.body.state === 'starting'))
  const info = await ask(room, { rest: '' })
  assert.equal(info.body.cloud.state, 'starting')
  assert.equal(info.body.people.find(p => p.role === 'host').cloud, true)
  // The runner's first request: running.
  const first = await ask(room, { method: 'GET', rest: 'events', token: config.token, cloud })
  assert.equal(first.status, 200)
  assert.equal(room.cloud.state, 'running')
  assert.equal(first.changed, true)
  // A second move is refused.
  assert.equal((await ask(room, { method: 'POST', rest: 'cloud', token: config.token, body: moveBody, cloud })).status, 409)
})

await check("a runner that doesn't start leaves the room as it was", async () => {
  const { room, host } = freshRoom()
  const seats = room.seats.size
  const moved = await ask(room, { method: 'POST', rest: 'cloud', token: host, body: moveBody, cloud: standIn({ fail: true }) })
  assert.equal(moved.status, 502)
  assert.match(moved.body.error, /didn't start: no capacity/)
  assert.equal(room.auth(host)?.role, 'host')
  assert.equal(room.seats.size, seats)
  assert.equal(room.cloud, null)
})

await check('a move needs a session, an absolute folder and a sign-in, and keeps nothing else of the sign-in', async () => {
  const { room, host } = freshRoom()
  const cloud = standIn()
  for (const body of [
    { ...moveBody, session: 'nope' },
    { ...moveBody, cwd: 'relative/path' },
    { ...moveBody, cwd: '/a/../etc' },
    { ...moveBody, auth: {} },
    { ...moveBody, auth: { baseUrl: 'file:///x', authToken: 't' } },
  ]) assert.equal((await ask(room, { method: 'POST', rest: 'cloud', token: host, body, cloud })).status, 400)
  await ask(room, { method: 'POST', rest: 'cloud', token: host, body: { ...moveBody, auth: { oauthToken: 'secret-token', extra: 'x' } }, cloud })
  assert.ok(!JSON.stringify(room.toJSON()).includes('secret-token'))
  assert.ok(!JSON.stringify(room.events).includes('secret-token'))
  assert.deepEqual(cloud.calls.started[0].payload.config.auth, { oauthToken: 'secret-token' })
})

await check("only the approver answers the runner's questions, once each, and only questions asked", async () => {
  const { room, host, guest } = freshRoom()
  const cloud = standIn()
  const moved = await ask(room, { method: 'POST', rest: 'cloud', token: host, body: moveBody, cloud })
  const runner = cloud.calls.started[0].payload.config.token
  const post = (token, events) => ask(room, { method: 'POST', rest: 'events', token, body: { events }, cloud })
  // Unasked: nothing.
  await post(moved.body.token, [{ type: 'answer', body: { id: 'q1', answer: 'Allow once' } }])
  assert.ok(!room.events.some(e => e.type === 'answer'))
  await post(runner, [{ type: 'ask', body: { id: 'q1', who: 'Kyle', what: 'Bash npm test', options: ['Allow once', 'Decline'] } }])
  // A teammate who isn't the approver: nothing.
  await post(guest, [{ type: 'answer', body: { id: 'q1', answer: 'Allow once' } }])
  assert.ok(!room.events.some(e => e.type === 'answer'))
  // The approver: kept, once.
  await post(moved.body.token, [{ type: 'answer', body: { id: 'q1', answer: 'Allow once' } }])
  await post(moved.body.token, [{ type: 'answer', body: { id: 'q1', answer: 'Decline' } }])
  const answers = room.events.filter(e => e.type === 'answer')
  assert.equal(answers.length, 1)
  assert.deepEqual(answers[0].body, { id: 'q1', answer: 'Allow once' })
  // A guest can't ask.
  await post(guest, [{ type: 'ask', body: { id: 'q2', what: 'x' } }])
  assert.ok(!room.events.some(e => e.type === 'ask' && e.body.id === 'q2'))
})

await check("the approver's other sessions (the same account) may answer too", async () => {
  const now = Date.now()
  const room = Room.create({ id: 'room0000000000000002', name: 'Scott', title: 'demo', now, version: '0.11.31', account: 'acct-scott' })
  const cloud = standIn()
  const moved = await ask(room, { method: 'POST', rest: 'cloud', token: room.host.token, body: moveBody, cloud })
  const runner = cloud.calls.started[0].payload.config.token
  const other = room.join('Scott', now, '0.11.31', 'acct-scott')
  const stranger = room.join('Mallory', now, '0.11.31', 'acct-mallory')
  await ask(room, { method: 'POST', rest: 'events', token: runner, body: { events: [{ type: 'ask', body: { id: 'q1', what: 'x' } }] }, cloud })
  await ask(room, { method: 'POST', rest: 'events', token: stranger.token, body: { events: [{ type: 'answer', body: { id: 'q1', answer: 'Allow once' } }] }, cloud })
  assert.ok(!room.events.some(e => e.type === 'answer'))
  await ask(room, { method: 'POST', rest: 'events', token: other.token, body: { events: [{ type: 'answer', body: { id: 'q1', answer: 'Decline' } }] }, cloud })
  assert.equal(room.events.filter(e => e.type === 'answer').length, 1)
  assert.ok(moved.body.token)
})

await check("only the approver changes the cloud host's settings, only as its Room would, and their prompts say they're theirs; home again, nobody does", async () => {
  const now = Date.now()
  const room = Room.create({ id: 'room0000000000000003', name: 'Scott', title: 'demo', now, version: '0.11.33', account: 'acct-scott' })
  const cloud = standIn()
  const moved = await ask(room, { method: 'POST', rest: 'cloud', token: room.host.token, body: moveBody, cloud })
  const other = room.join('Scott', now, '0.11.33', 'acct-scott')
  const guest = room.join('Alex', now, '0.11.33', 'acct-alex')
  const post = (token, events) => ask(room, { method: 'POST', rest: 'events', token, body: { events }, cloud })
  // A teammate: nothing.
  await post(guest.token, [{ type: 'set', body: { approvals: 'all' } }])
  assert.ok(!room.events.some(e => e.type === 'set'))
  // The approver: what the Room sets, nothing else; "ask before nothing" isn't the cloud host's.
  await post(moved.body.token, [{ type: 'set', body: { approvals: 'none', prompts: 'watch', files: 'off', untrust: true, extra: 1 } }])
  await post(moved.body.token, [{ type: 'set', body: { approvals: 'none' } }])
  await post(other.token, [{ type: 'set', body: { approvals: 'all' } }])
  assert.deepEqual(room.events.filter(e => e.type === 'set').map(e => e.body), [{ prompts: 'watch', files: 'off', untrust: true }, { approvals: 'all' }])
  // Their prompts say so (the cloud host's watch-only keeps to teammates); a teammate's don't.
  await post(moved.body.token, [{ type: 'prompt', body: { text: 'Fix it', pid: 'p1' } }])
  await post(guest.token, [{ type: 'prompt', body: { text: 'Break it', pid: 'p2' } }])
  assert.deepEqual(room.events.filter(e => e.type === 'prompt').map(e => [e.body.pid, e.from.approver === true]), [['p1', true], ['p2', false]])
  // Home again: no approver, no settings from a guest seat, no mark.
  assert.equal((await ask(room, { method: 'POST', rest: 'cloud/home', token: moved.body.token, cloud })).status, 200)
  await post(other.token, [{ type: 'set', body: { prompts: 'everyone' } }, { type: 'prompt', body: { text: 'Again', pid: 'p3' } }])
  assert.equal(room.events.filter(e => e.type === 'set').length, 2)
  assert.equal(room.events.find(e => e.type === 'prompt' && e.body.pid === 'p3')?.from.approver, undefined)
})

await check('Bring home: the approver alone, the runner stopped, its changes a room file, a new host token', async () => {
  const { room, host, guest } = freshRoom()
  const cloud = standIn({ diff: 'diff --git a/README.md b/README.md\n+from the cloud\n' })
  const moved = await ask(room, { method: 'POST', rest: 'cloud', token: host, body: moveBody, cloud })
  const runner = cloud.calls.started[0].payload.config.token
  assert.equal((await ask(room, { method: 'POST', rest: 'cloud/home', token: guest, cloud })).status, 403)
  assert.equal((await ask(room, { method: 'POST', rest: 'cloud/home', token: runner, cloud })).status, 403)
  const home = await ask(room, { method: 'POST', rest: 'cloud/home', token: moved.body.token, cloud })
  assert.equal(home.status, 200)
  assert.deepEqual(cloud.calls.stopped, [room.id])
  assert.equal(room.auth(home.body.token)?.role, 'host')
  assert.equal(room.auth(runner), null)
  assert.equal(room.auth(moved.body.token), null) // their guest seat became the host
  assert.equal(room.cloud, null)
  assert.equal(home.body.changes.name, 'cloud-changes.patch')
  const file = await ask(room, { rest: `files/${home.body.changes.id}`, token: home.body.token })
  assert.match(await file.raw.text(), /from the cloud/)
  assert.ok(room.events.some(e => e.type === 'cloud' && e.body.state === 'home' && e.body.changes === home.body.changes.id))
})

await check("the cloud host's week ends: stopped, its changes kept, and Bring home still takes it back", async () => {
  const start = Date.now()
  const { room, host } = freshRoom(start)
  const cloud = standIn({ diff: 'diff --git a/a b/a\n' })
  const moved = await ask(room, { method: 'POST', rest: 'cloud', token: host, body: moveBody, cloud, now: start })
  const runner = cloud.calls.started[0].payload.config.token
  const later = start + CLOUD_MAX_MS + 1
  await ask(room, { method: 'GET', rest: 'events', token: moved.body.token, cloud, now: later })
  assert.equal(room.cloud.state, 'stopped')
  assert.equal(room.auth(runner), null)
  assert.ok(room.cloud.changes?.id)
  const home = await ask(room, { method: 'POST', rest: 'cloud/home', token: moved.body.token, cloud, now: later + 1 })
  assert.equal(home.status, 200)
  assert.equal(cloud.calls.stopped.length, 1) // stopped once
  assert.equal(home.body.changes.id, room.events.find(e => e.type === 'cloud' && e.body.state === 'stopped').body.changes)
})

await check("the room's end stops its runner, by the host or the approver", async () => {
  const { room, host } = freshRoom()
  const cloud = standIn()
  const moved = await ask(room, { method: 'POST', rest: 'cloud', token: host, body: moveBody, cloud })
  assert.equal((await ask(room, { method: 'POST', rest: 'end', token: moved.body.token, cloud })).status, 200)
  assert.ok(room.endedAt)
  assert.deepEqual(cloud.calls.stopped, [room.id])
  assert.equal(room.cloud, null)
})

await check("the host's sign-in ending the room (the Team panel's Stop) stops its runner too", async () => {
  const now = Date.now()
  const room = Room.create({ id: 'room0000000000000003', name: 'Scott', title: 'demo', now, version: '0.11.31', account: 'acct-scott' })
  const cloud = standIn()
  const directory = { whoIs: async tok => (tok === 'sign-in-scott' ? { id: 'acct-scott' } : tok === 'sign-in-eve' ? { id: 'acct-eve' } : null), roomEnded: async () => {} }
  await ask(room, { method: 'POST', rest: 'cloud', token: room.host.token, body: moveBody, cloud })
  assert.equal((await ask(room, { method: 'POST', rest: 'end', account: 'sign-in-eve', cloud, directory })).status, 403)
  assert.deepEqual(cloud.calls.stopped, [])
  assert.equal((await ask(room, { method: 'POST', rest: 'end', account: 'sign-in-scott', cloud, directory })).status, 200)
  assert.ok(room.endedAt)
  assert.deepEqual(cloud.calls.stopped, [room.id])
  assert.equal(room.cloud, null)
})

await check('a saved room keeps its cloud host, never the sign-in', async () => {
  const { room, host } = freshRoom()
  const cloud = standIn()
  await ask(room, { method: 'POST', rest: 'cloud', token: host, body: moveBody, cloud })
  const back = Room.resume(JSON.parse(JSON.stringify(room)), Date.now())
  assert.equal(back.cloud.state, 'starting')
  assert.equal(back.cloud.approver.name, 'Scott')
  assert.ok(!JSON.stringify(room).includes('sk-ant-oat01-test'))
})

await check('wrangler.toml names the image built from cloud/ as it is (node scripts/push-image.mjs after changing it)', async () => {
  const { imageTag } = await import('../scripts/push-image.mjs')
  const named = /^image = "registry\.cloudflare\.com\/[0-9a-f]{32}\/claude-share-host:(r-[0-9a-f]{10})"$/m.exec(readFileSync(join(ROOT, 'wrangler.toml'), 'utf8'))?.[1]
  assert.equal(named, imageTag())
})

// ---------------------------------------------------------------------------
// The real thing: the Workers under wrangler dev starting the image in Docker.
// The runner reaches the room at the address links name (PUBLIC_URL).
if (process.env.CLOUD_DOCKER === '1' && process.env.ANTHROPIC_AUTH_TOKEN) {
  const server = await startWorkerd({ containers: true, vars: ({ port }) => ({ PUBLIC_URL: `http://host.docker.internal:${port}` }) })
  const S = server.origin
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const call = async (path, { token, body, method = body ? 'POST' : 'GET', raw } = {}) => {
    const r = await fetch(S + path, {
      method,
      signal: AbortSignal.timeout(130_000),
      headers: { 'x-shared-session-version': '0.11.31', ...(raw ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
      ...(raw ? { duplex: 'half' } : {}),
    })
    const text = await r.text()
    try { return { status: r.status, body: JSON.parse(text) } } catch { return { status: r.status, body: text } }
  }
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`${S}/api/version`)).ok) break } catch {} await sleep(100) }
    await check('in Docker: a session moves to a container, a teammate is answered there, and Bring home brings its changes', async () => {
      const made = (await call('/api/rooms', { body: { name: 'Scott', title: 'cloud test' } })).body
      const kyle = (await call(`/api/rooms/${made.id}/join`, { body: { name: 'Kyle' } })).body
      // The packed session: a small project, no conversation yet.
      // As the plugin packs it (packSession): project.tgz from the project's root, beside the conversation.
      const work = mkdtempSync(join(tmpdir(), 'ss-cloud-'))
      mkdirSync(join(work, 'project'))
      writeFileSync(join(work, 'project', 'README.md'), '# demo\n')
      execFileSync('tar', ['-czf', join(work, 'project.tgz'), '-C', join(work, 'project'), 'README.md'])
      const bundle = execFileSync('tar', ['-czf', '-', '-C', work, 'project.tgz'])
      rmSync(work, { recursive: true, force: true })
      const moved = await call(`/api/rooms/${made.id}/cloud`, {
        token: made.token,
        body: { session: randomUUID(), cwd: '/Users/scott/demo', model: 'claude-haiku-4-5-20251001', auth: { baseUrl: 'http://host.docker.internal:8317', authToken: process.env.ANTHROPIC_AUTH_TOKEN } },
      })
      assert.equal(moved.status, 200, JSON.stringify(moved.body))
      const sent = await call(`/api/rooms/${made.id}/cloud/bundle`, { method: 'PUT', token: moved.body.ticket, raw: bundle })
      assert.equal(sent.status, 200, JSON.stringify(sent.body))
      // Taken up: running.
      let state = ''
      for (let i = 0; i < 120 && state !== 'running'; i++) { await sleep(1000); state = (await call(`/api/rooms/${made.id}`)).body.cloud?.state }
      assert.equal(state, 'running')
      await sleep(3000) // its takeover read the room
      await call(`/api/rooms/${made.id}/events`, { token: kyle.token, body: { events: [{ type: 'prompt', body: { text: 'Reply with exactly: answered from the cloud', pid: 'p1' } }] } })
      let seq = kyle.seq, answered = false
      for (let i = 0; i < 90 && !answered; i++) {
        await sleep(1000)
        const page = (await call(`/api/rooms/${made.id}/events?after=${seq}&wait=0`, { token: kyle.token })).body
        for (const e of page.events ?? []) {
          seq = Math.max(seq, e.seq)
          if (e.type === 'row' && e.body?.kind === 'assistant' && /answered from the cloud/i.test(e.body.text)) answered = true
        }
      }
      assert.ok(answered, 'the cloud host answered')
      // A teammate's write is asked of the approver, through the room; their yes lets it run there.
      await call(`/api/rooms/${made.id}/events`, { token: kyle.token, body: { events: [{ type: 'prompt', body: { text: 'Use the Read tool on /Users/scott/demo/README.md, then use the Write tool to create /Users/scott/demo/hello.txt containing exactly: hi from the cloud, then that file\'s first line', pid: 'p2' } }] } })
      let question = null
      let readThere = false
      for (let i = 0; i < 90 && !question; i++) {
        await sleep(1000)
        const page = (await call(`/api/rooms/${made.id}/events?after=${seq}&wait=0`, { token: moved.body.token })).body
        for (const e of page.events ?? []) {
          seq = Math.max(seq, e.seq)
          if (process.env.CLOUD_DEBUG && e.type !== 'delta') console.log('     ', e.seq, e.type, e.from?.role, JSON.stringify(e.body).slice(0, 220))
          if (e.type === 'ask') question = e.body
          if (e.type === 'row' && e.body?.kind === 'result' && /# demo/.test(e.body.text ?? '')) readThere = true
        }
      }
      assert.ok(question, 'the approver was asked')
      // The project came along: Claude read it there.
      assert.ok(readThere, 'the project was laid out')
      assert.match(question.what, /hello\.txt/)
      // Kyle isn't the approver: his answer isn't taken.
      await call(`/api/rooms/${made.id}/events`, { token: kyle.token, body: { events: [{ type: 'answer', body: { id: question.id, answer: 'Allow once' } }] } })
      await call(`/api/rooms/${made.id}/events`, { token: moved.body.token, body: { events: [{ type: 'answer', body: { id: question.id, answer: 'Allow once' } }] } })
      let written = false
      for (let i = 0; i < 90 && !written; i++) {
        await sleep(1000)
        const page = (await call(`/api/rooms/${made.id}/events?after=${seq}&wait=0`, { token: moved.body.token })).body
        for (const e of page.events ?? []) {
          seq = Math.max(seq, e.seq)
          if (process.env.CLOUD_DEBUG && e.type !== 'delta') console.log('     ', e.seq, e.type, e.from?.role, JSON.stringify(e.body).slice(0, 220))
          if (e.type === 'turn' && e.body?.state === 'end') written = true
        }
      }
      assert.ok(written, 'the turn ended')
      const home = await call(`/api/rooms/${made.id}/cloud/home`, { token: moved.body.token, body: {} })
      assert.equal(home.status, 200, JSON.stringify(home.body))
      assert.equal(home.body.changes?.name, 'cloud-changes.patch')
      const patch = await fetch(`${S}/api/rooms/${made.id}/files/${home.body.changes.id}`, { headers: { authorization: `Bearer ${home.body.token}`, 'x-shared-session-version': '0.11.31' } }).then(r => r.text())
      assert.match(patch, /hello\.txt/)
      assert.match(patch, /hi from the cloud/)
      assert.equal((await call(`/api/rooms/${made.id}/events?after=0&wait=0`, { token: home.body.token })).status, 200)
      assert.ok(!execFileSync('docker', ['ps', '-q', '--filter', `name=ss-host-${made.id}`]).toString().trim(), 'the container is gone')
    })
  } finally {
    await server.stop()
  }
} else console.log('skip in Docker (set CLOUD_DOCKER=1 and model access)')

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
