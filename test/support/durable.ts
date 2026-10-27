// What the Worker's Durable Objects take from workerd, for the suites that
// run them in Node: a hibernatable socket, storage, the object's state, and
// a WebSocketPair with a 101 Response carrying its socket. Each stands in
// for only what the server's code uses; `asState` hands one over as
// workerd's type.

import { randomBytes } from 'node:crypto'

export class Socket {
  sent: unknown[] = []
  closes: { code?: number; reason?: string }[] = []
  tags: string[] = []
  attachment: unknown = null
  send(data: unknown) {
    if (this.closes.length) throw new Error('closed')
    this.sent.push(structuredClone(data))
  }
  close(code?: number, reason?: string) {
    this.closes.push({ code, reason })
  }
  serializeAttachment(att: unknown) {
    this.attachment = structuredClone(att)
  }
  deserializeAttachment(): any {
    return structuredClone(this.attachment)
  }
}

export class Storage {
  data = new Map<string, any>()
  alarm: number | null = null
  alarms = 0
  async get(key: string | string[]): Promise<any> {
    if (Array.isArray(key)) return new Map(key.filter(k => this.data.has(k)).map(k => [k, structuredClone(this.data.get(k))]))
    return structuredClone(this.data.get(key))
  }
  async put(key: string | Record<string, unknown>, value?: unknown) {
    for (const [k, v] of typeof key === 'string' ? [[key, value] as const] : Object.entries(key)) this.data.set(k, structuredClone(v))
  }
  async list({ prefix = '', end = '￿', limit = Infinity } = {}) {
    return new Map(
      [...this.data]
        .filter(([k]) => k.startsWith(prefix) && k < end)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit)
        .map(([k, v]) => [k, structuredClone(v)]),
    )
  }
  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key)
  }
  async deleteAll() {
    this.data.clear()
  }
  async setAlarm(at: number) {
    this.alarm = at
    this.alarms += 1
  }
  async getAlarm() {
    return this.alarm
  }
  async transaction<T>(fn: (txn: Storage) => T) {
    return fn(this)
  }
}

export class State {
  id = (hex => ({ toString: () => hex }))(randomBytes(32).toString('hex'))
  storage = new Storage()
  sockets: Socket[] = []
  barrier: Promise<unknown> = Promise.resolve()
  blockConcurrencyWhile<T>(fn: () => T) {
    const result = this.barrier.then(fn)
    this.barrier = result.catch(() => {})
    return result
  }
  acceptWebSocket(ws: Socket, tags: string[]) {
    ws.tags = tags
    this.sockets.push(ws)
  }
  getWebSockets(tag?: string) {
    return this.sockets.filter(ws => !tag || ws.tags.includes(tag))
  }
}

export const asState = (state: State | { storage: Storage }) => state as unknown as DurableObjectState
export const asSocket = (socket: Socket) => socket as unknown as WebSocket

// Sets workerd's WebSocketPair and a Response that may be a 101 with its
// socket; the function it returns puts Node's Response back.
export function installRuntime() {
  const runtime = globalThis as unknown as { WebSocketPair: unknown; Response: unknown }
  const NativeResponse = globalThis.Response
  runtime.WebSocketPair = class {
    0 = new Socket()
    1 = new Socket()
  }
  runtime.Response = class extends NativeResponse {
    constructor(body?: BodyInit | null, options: ResponseInit & { webSocket?: unknown } = {}) {
      super(body, options.status === 101 ? { ...options, status: 200 } : options)
      if (options.status === 101) Object.defineProperty(this, 'status', { value: 101 })
      if (options.webSocket) Object.defineProperty(this, 'webSocket', { value: options.webSocket })
    }
  }
  return () => {
    runtime.Response = NativeResponse
  }
}
