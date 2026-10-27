// HostContainer: a room's cloud host (docs/cloud-host.md).

import { json, token } from '../core/index.ts'
import type { ServerEnv } from './env.ts'

// One room's cloud host: a container running cloud/runner.mts. It starts the
// container with a control key of its own, hands the runner the room and the
// session over the container's port (never a public address), streams it the
// packed session against the ticket the room minted, and stops it, answering
// with its changes. An alarm each minute keeps it (and so the container)
// going while the runner runs, and notices when it stopped.
const HOST_PORT = 8080
const HOST_START_MS = 120_000
const HOST_ALARM_MS = 60_000

// What the object keeps while its runner runs: the container's control key,
// the bundle's ticket (until used), and its room.
type Runner = { key: string; ticket: string | null; room: string; at: number }

export class HostContainer {
  state: DurableObjectState
  env: ServerEnv

  constructor(state: DurableObjectState, env: ServerEnv) {
    this.state = state
    this.env = env
  }

  runner() {
    const container = this.state.container
    if (!container) throw new Error('This server has no containers.')
    return container.getTcpPort(HOST_PORT)
  }

  async control(path: string, key: string, init: RequestInit & { duplex?: 'half' } = {}) {
    return this.runner().fetch(`http://runner${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${key}` } })
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const container = this.state.container
    if (!container) return json({ error: 'This server has no containers.' }, 501)
    const saved = (await this.state.storage.get<Runner>('runner')) ?? null

    if (url.pathname === '/start' && req.method === 'POST') {
      const { ticket, config } = await req.json<{ ticket: string; config: { room: string } }>()
      if (container.running) await container.destroy().catch(() => {})
      const key = token(32)
      container.start({ enableInternet: true, env: { SS_CONTROL_KEY: key } })
      // Up once the runner answers on its port (the image may be pulled first).
      const until = Date.now() + HOST_START_MS
      let up = false
      while (!up && Date.now() < until) {
        up = await this.control('/health', key).then(
          r => r.ok,
          () => false,
        )
        if (!up) await new Promise(r => setTimeout(r, 1_000))
      }
      if (!up) {
        await container.destroy().catch(() => {})
        return json({ error: "the container didn't come up" }, 504)
      }
      const started = await this.control('/start', key, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) })
      if (!started.ok) {
        await container.destroy().catch(() => {})
        return json({ error: (await started.json<{ error?: string }>().catch(() => null))?.error ?? 'the runner refused its configuration' }, 502)
      }
      await this.state.storage.put('runner', { key, ticket, room: config.room, at: Date.now() })
      await this.state.storage.setAlarm(Date.now() + HOST_ALARM_MS)
      return json({ ok: true })
    }

    if (url.pathname === '/bundle' && req.method === 'PUT') {
      const given = req.headers.get('authorization') ?? ''
      if (!saved?.ticket || !container.running || !safeEqual(given, `Bearer ${saved.ticket}`)) return json({ error: 'Not a member of this session.' }, 401)
      // Once: the ticket goes as the bundle starts.
      await this.state.storage.put('runner', { ...saved, ticket: null })
      const res = await this.control('/bundle', saved.key, {
        method: 'PUT',
        headers: { 'content-length': req.headers.get('content-length') ?? '' },
        body: req.body,
        duplex: 'half',
      })
      return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } })
    }

    if (url.pathname === '/stop' && req.method === 'POST') {
      let diff = new Uint8Array()
      if (saved && container.running) {
        const res = await this.control('/stop', saved.key, { method: 'POST' }).catch(() => null)
        if (res?.ok) diff = new Uint8Array(await res.arrayBuffer())
      }
      await container.destroy().catch(() => {})
      await this.state.storage.deleteAll()
      return new Response(diff, { headers: { 'content-type': 'application/octet-stream' } })
    }

    return json({ error: 'Not found' }, 404)
  }

  // Kept going while the runner runs; a container that stopped by itself is
  // forgotten (the room sees its host away, and Bring home still works).
  async alarm() {
    const saved = await this.state.storage.get<Runner>('runner')
    if (!saved) return
    if (!this.state.container?.running) return void (await this.state.storage.deleteAll())
    await this.state.storage.setAlarm(Date.now() + HOST_ALARM_MS)
  }
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
