// GateObject: the count of new rooms.

import { json, token, Windows, ROOMS_PER_ADDRESS_DAY } from '../core/index.ts'

// Counts new rooms exactly: per address this minute and today, and for the
// whole server today. Today's counts are kept in storage, so a restart
// doesn't reset the day: the server's under day:<date>, and each address's
// under a:<date>:<its keyed hash>, the key a random one made for that day
// (k:<date>), so what's kept can't be read back as addresses. An alarm at
// the day's end deletes them all, key included. Only a Share reaches it, so
// it costs one request per room made. Its minute is memory's, as every
// other minute is.
export class GateObject {
  state: DurableObjectState
  minute: Windows
  addresses: Map<string, number>
  day: { key: string; count: number; secret: string }
  queue: Promise<unknown>

  constructor(state: DurableObjectState) {
    this.state = state
    this.minute = new Windows()
    this.addresses = new Map() // a:<date>:<hash> → rooms today, as read or written here
    this.day = { key: '', count: 0, secret: '' }
    // One Share at a time: each reads and writes its address's count across awaits no gate holds.
    this.queue = Promise.resolve()
  }

  fetch(req: Request): Promise<Response> {
    const turn = this.queue.then(() => this.admit(req))
    this.queue = turn.catch(() => {})
    return turn
  }

  async admit(req: Request) {
    const { ip, max } = await req.json<{ ip: string; max: number }>()
    const now = Date.now()
    const key = new Date(now).toISOString().slice(0, 10)
    const storage = this.state.storage
    if (this.day.key !== key) {
      let secret = await storage.get<string>(`k:${key}`)
      if (!secret) {
        secret = token(32)
        await storage.put(`k:${key}`, secret)
        // The day's end, and a minute for the clocks.
        await storage.setAlarm(Date.parse(`${key}T00:00:00Z`) + 86_400_000 + 60_000)
      }
      this.day = { key, count: (await storage.get<number>(`day:${key}`)) ?? 0, secret }
      this.addresses.clear()
      await this.forget(key)
    }
    if (this.day.count >= max) return json({ ok: false, reason: 'day' })
    const who = `a:${key}:${await keyedHash(this.day.secret, ip)}`
    const made = this.addresses.get(who) ?? (await storage.get<number>(who)) ?? 0
    if (made >= ROOMS_PER_ADDRESS_DAY || !this.minute.hit('create', ip, now)) return json({ ok: false, reason: 'address' })
    this.addresses.set(who, made + 1)
    this.day.count += 1
    await storage.put({ [`day:${key}`]: this.day.count, [who]: made + 1 })
    return json({ ok: true })
  }

  async alarm() {
    const today = new Date(Date.now()).toISOString().slice(0, 10)
    await this.forget(today)
    if (this.day.key !== today) this.day = { key: '', count: 0, secret: '' }
  }

  // Every day's counts and key but today's.
  async forget(today: string) {
    const storage = this.state.storage
    for (const prefix of ['a:', 'k:', 'day:']) {
      const old = [...(await storage.list({ prefix })).keys()].filter(k => !k.startsWith(`${prefix}${today}`))
      for (let i = 0; i < old.length; i += 128) await storage.delete(old.slice(i, i + 128))
    }
  }
}

// A keyed hash of an address (HMAC-SHA-256, its first 16 bytes in hex).
async function keyedHash(secret: string, text: string) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)))
  return [...mac.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('')
}
