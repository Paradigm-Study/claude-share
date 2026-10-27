// Stdlib WebSocket client, shared by the public preview's relay
// (ws-relay.mts) and every raw TCP stream (tcp-relay.mts's bridge).
// Credentials come from its callers, never argv or addresses. Node 22.18+
// (its types are stripped as it loads), no deps.

import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import type { Duplex } from 'node:stream'

/** What a connection tells its caller. */
export type WsEvents = {
  open?: () => void
  message?: (data: string | Buffer, binary: boolean) => void
  drain?: () => void
  close?: (code: number, status?: number) => void
}
export type WsOptions = { maxMessage?: number; timeoutMs?: number; insecure?: boolean }
export type Ws = { send: (data: string | Buffer, binary?: boolean) => boolean; close: (code?: number, reply?: boolean, status?: number) => void; isOpen: () => boolean }

export const BUFFER_MAX = 1024 * 1024
const HEADER_MAX = 16 * 1024
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const validClose = (code: number) => Number.isInteger(code) && ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code < 5000))
const sendable = (code: number) => validClose(code) ? code : 1000

// send() accepts the message, returning false until drain when the transport
// is full. It never pauses WS reads: TCP relays need the reverse direction's ACK.
// `insecure` skips certificate checks, for a loopback dev server's own
// certificate alone (start's local leg); everything else verifies.
export function connect(url: string, headers: Record<string, string> = {}, protocols: string[] = [], on: WsEvents = {}, { maxMessage = BUFFER_MAX, timeoutMs = 10_000, insecure = false }: WsOptions = {}): Ws {
  const u = new URL(url)
  if (!['ws:', 'wss:'].includes(u.protocol) || u.username || u.password || u.hash || !Array.isArray(protocols) || protocols.length > 16 || protocols.some(p => typeof p !== 'string' || !/^[!#$%&'*+.^_`|~\w-]{1,128}$/.test(p)) || new Set(protocols).size !== protocols.length || !Number.isInteger(maxMessage) || maxMessage < 1 || maxMessage > BUFFER_MAX || typeof insecure !== 'boolean') throw new Error('Invalid WebSocket settings')
  const secure = u.protocol === 'wss:'
  const hostname = u.hostname.replace(/^\[|\]$/g, '')
  const hosts = hostname === 'localhost' ? ['127.0.0.1', '::1'] : [hostname]
  const queue: [number, Buffer][] = []
  let queuedBytes = 0, open = false, closed = false
  let socket: Duplex | undefined, request: http.ClientRequest | undefined, closeTimer: NodeJS.Timeout | undefined
  const timer = setTimeout(() => end(1006), timeoutMs)

  const frame = (op: number, payload: Buffer) => {
    const mask = crypto.randomBytes(4), len = payload.length
    const head = Buffer.alloc(len < 126 ? 2 : len < 65536 ? 4 : 10)
    head[0] = 0x80 | op
    head[1] = 0x80 | (len < 126 ? len : len < 65536 ? 126 : 127)
    if (len >= 126 && len < 65536) head.writeUInt16BE(len, 2)
    if (len >= 65536) head.writeBigUInt64BE(BigInt(len), 2)
    const body = Buffer.from(payload)
    // i is within body, and i & 3 within the mask's four bytes.
    for (let i = 0; i < body.length; i++) body[i]! ^= mask[i & 3]!
    return Buffer.concat([head, mask, body])
  }
  const write = (op: number, payload: Buffer) => {
    if (!socket || socket.destroyed) return false
    if (socket.writableLength + payload.length + 14 > BUFFER_MAX) { end(1009); return false }
    return socket.write(frame(op, payload))
  }
  function end(code = 1000, reply = true, status?: number): void {
    if (closed) return
    closed = true
    open = false
    clearTimeout(timer)
    queuedBytes = 0
    queue.length = 0
    if (!socket) request?.destroy()
    if (socket && !socket.destroyed) {
      if (reply) {
        const payload = Buffer.alloc(2)
        payload.writeUInt16BE(sendable(code))
        if (socket.writableLength + 8 <= BUFFER_MAX) socket.write(frame(8, payload))
      }
      socket.end()
      const s = socket
      closeTimer = setTimeout(() => s.destroy(), 1000)
      closeTimer.unref()
    }
    on.close?.(code, status)
  }
  const send = (data: string | Buffer, binary = false) => {
    if (closed) return false
    const payload = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
    if (payload.length > maxMessage) { end(1009); return false }
    if (!open) {
      const size = payload.length + 14
      if (queuedBytes + size > BUFFER_MAX || queue.length >= 4096) { end(1009); return false }
      queue.push([binary ? 2 : 1, payload])
      queuedBytes += size
      return false
    }
    return write(binary ? 2 : 1, payload)
  }

  const attach = (s: Duplex, head: Buffer) => {
    socket = s
    open = true
    clearTimeout(timer)
    let buf: Buffer = Buffer.alloc(0), parts: Buffer[] = [], partOp = 0, partBytes = 0, partCount = 0
    const read = (): void => {
      while (!closed && buf.length >= 2) {
        // The loop runs only while buf has its first two bytes.
        const b0 = buf[0]!, b1 = buf[1]!
        const fin = !!(b0 & 0x80), op = b0 & 15
        if (b0 & 0x70 || b1 & 0x80 || ![0, 1, 2, 8, 9, 10].includes(op)) return end(1002)
        let len = b1 & 127, at = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2); at = 4
          if (len < 126) return end(1002)
        } else if (len === 127) {
          if (buf.length < 10) return
          const wide = buf.readBigUInt64BE(2)
          if (wide >> 63n || wide > BigInt(maxMessage)) return end(1009)
          len = Number(wide); at = 10
          if (len < 65536) return end(1002)
        }
        if (op >= 8 && (!fin || len > 125)) return end(1002)
        if (len > maxMessage || partBytes + len > BUFFER_MAX) return end(1009)
        if (op < 8 && ((op === 0 && !partOp) || (op !== 0 && partOp))) return end(1002)
        if (buf.length < at + len) return
        const payload = buf.subarray(at, at + len)
        buf = buf.subarray(at + len)
        if (op === 8) {
          if (len === 1 || (len >= 2 && (!validClose(payload.readUInt16BE(0)) || !isUtf8(payload.subarray(2))))) return end(1002)
          return end(len >= 2 ? payload.readUInt16BE(0) : 1000)
        }
        if (op === 9) { write(10, payload); continue }
        if (op === 10) continue
        if (op) partOp = op
        partBytes += len
        if (partBytes > maxMessage || ++partCount > 4096) return end(1009)
        // A fragment must not retain the entire TCP read (including discarded
        // ping frames). Count and retain its own bytes, not a slab-sized slice.
        const piece = Buffer.allocUnsafeSlow(len)
        payload.copy(piece)
        parts.push(piece)
        if (fin) {
          const data = Buffer.concat(parts, partBytes), binary = partOp === 2
          parts = []; partOp = 0; partBytes = 0; partCount = 0
          if (!binary && !isUtf8(data)) return end(1007)
          try { on.message?.(binary ? data : data.toString('utf8'), binary) } catch { end(1002) }
        }
      }
    }
    const receive = (d: Buffer): void => {
      if (closed) return
      // Include fragments retained outside buf in the same hard memory ceiling.
      if (buf.length + partBytes + d.length > BUFFER_MAX) return end(1009)
      buf = buf.length ? Buffer.concat([buf, d]) : d
      read()
      if (!buf.length) buf = Buffer.alloc(0)
      else if (buf.byteOffset || buf.buffer.byteLength !== buf.length) {
        const rest = Buffer.allocUnsafeSlow(buf.length)
        buf.copy(rest)
        buf = rest
      }
    }
    s.on('data', receive)
    s.on('drain', () => { if (!closed) on.drain?.() })
    s.on('close', () => { clearTimeout(closeTimer); end(1006, false) })
    s.on('error', () => { s.destroy(); end(1006, false) })
    for (const [op, payload] of queue.splice(0)) { queuedBytes -= payload.length + 14; if (!closed) write(op, payload) }
    if (closed) return
    try { on.open?.() } catch { return end(1011) }
    if (head?.length) receive(head)
    if (!closed && !s.writableNeedDrain) on.drain?.()
  }

  const attempt = (i: number): void => {
    if (closed) return
    const key = crypto.randomBytes(16).toString('base64')
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64')
    // SNI takes a name, never an address (RFC 6066; Node warns on stderr for one).
    const req = request = (secure ? https : http).request({
      host: hosts[i], port: u.port || (secure ? 443 : 80),
      path: `${u.pathname}${u.search}`, servername: secure && !net.isIP(hostname) ? hostname : undefined,
      ...(secure ? { rejectUnauthorized: !insecure } : {}),
      agent: false, maxHeaderSize: HEADER_MAX,
      headers: { ...headers, host: u.host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13', ...(protocols.length ? { 'sec-websocket-protocol': protocols.join(', ') } : {}) },
    })
    req.on('upgrade', (res, s, head) => {
      if (closed) return s.destroy()
      const selected = res.headers['sec-websocket-protocol']
      if (res.statusCode !== 101 || res.headers.upgrade?.toLowerCase() !== 'websocket' || !res.headers.connection?.toLowerCase().split(/\s*,\s*/).includes('upgrade') || res.headers['sec-websocket-accept'] !== accept || res.headers['sec-websocket-extensions'] || (selected !== undefined && !protocols.includes(selected))) { s.destroy(); return end(1002, false) }
      attach(s, head)
    })
    req.on('response', (res: http.IncomingMessage) => { const status = res.statusCode; res.destroy(); end(status === 401 || status === 403 ? 1008 : status === 429 ? 1013 : 1011, false, status) })
    req.on('error', () => {
      if (closed || open) return
      if (i + 1 < hosts.length) attempt(i + 1)
      else end(1006, false)
    })
    req.end()
  }
  attempt(0)
  return { send, close: end, isOpen: () => open && !closed }
}

