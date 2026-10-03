// Cloudflare Worker + one Durable Object per shared session.
// Deploy with `npx wrangler deploy` (see wrangler.toml at the repo root).

import { Room, ROOM_ID, createRoom, roomRequest, notFound, json, publicOrigin, token } from './core.mjs'

const SWEEP_MS = 10_000
const ROOM_TTL_MS = 24 * 60 * 60 * 1000
const pad = seq => String(seq).padStart(12, '0')

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const origin = publicOrigin(req, env.PUBLIC_URL)
    const parts = url.pathname.split('/').filter(Boolean)

    if (url.pathname === '/api/health') return json({ ok: true })

    let id
    let rest
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      id = token(16)
      rest = 'create'
    } else if (parts[0] === 's' && parts.length === 2) {
      id = parts[1]
      rest = 'page'
    } else if (parts[0] === 'api' && parts[1] === 'rooms' && parts.length >= 3) {
      id = parts[2]
      rest = parts.slice(3).join('/')
    } else {
      return notFound()
    }
    if (!ROOM_ID.test(id)) return notFound()

    const stub = env.ROOMS.get(env.ROOMS.idFromName(id))
    const headers = new Headers(req.headers)
    headers.set('x-share-origin', origin)
    return stub.fetch(
      new Request(`https://room.internal/${id}/${rest}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      }),
    )
  },
}

export class RoomObject {
  constructor(state) {
    this.state = state
    this.room = null
    this.savedSeq = 0
    state.blockConcurrencyWhile(async () => {
      const meta = await state.storage.get('meta')
      if (!meta) return
      const stored = await state.storage.list({ prefix: 'e:' })
      this.room = new Room({ ...meta, events: [...stored.values()] })
      this.savedSeq = this.room.seq
    })
  }

  async fetch(req) {
    const url = new URL(req.url)
    const origin = req.headers.get('x-share-origin') ?? url.origin
    const [id, ...restParts] = url.pathname.split('/').filter(Boolean)
    const rest = restParts.join('/')
    const now = Date.now()

    if (rest === 'create') {
      if (this.room) return json({ error: 'exists' }, 409)
      const { room, response } = await createRoom(req, id, now, origin)
      this.room = room
      await this.persist()
      await this.state.storage.setAlarm(now + SWEEP_MS)
      return response
    }

    if (!this.room) {
      return rest === 'page'
        ? new Response('<!doctype html><meta charset="utf-8"><title>Not found</title><p>This shared session does not exist.', {
            status: 404,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        : json({ error: 'This shared session does not exist.' }, 404)
    }

    const { response, changed } = await roomRequest(this.room, req, rest, now, origin)
    if (changed) await this.persist()
    return response
  }

  async persist() {
    const room = this.room
    const { events, ...meta } = room.toJSON()
    const entries = { meta }
    for (const event of events) if (event.seq > this.savedSeq) entries[`e:${pad(event.seq)}`] = event
    const keys = Object.keys(entries)
    for (let i = 0; i < keys.length; i += 100) {
      await this.state.storage.put(Object.fromEntries(keys.slice(i, i + 100).map(k => [k, entries[k]])))
    }
    this.savedSeq = room.seq
    const oldest = events[0]?.seq
    if (oldest) {
      const stale = await this.state.storage.list({ prefix: 'e:', end: `e:${pad(oldest)}`, limit: 500 })
      if (stale.size) await this.state.storage.delete([...stale.keys()])
    }
  }

  async alarm() {
    if (!this.room) return
    const now = Date.now()
    if (this.room.sweep(now)) await this.persist()
    const lastActive = Math.max(this.room.host.lastSeen, this.room.endedAt ?? 0)
    if (now - lastActive > ROOM_TTL_MS) {
      await this.state.storage.deleteAll()
      this.room = null
      return
    }
    await this.state.storage.setAlarm(now + SWEEP_MS)
  }
}
