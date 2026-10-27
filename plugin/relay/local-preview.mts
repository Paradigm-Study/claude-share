#!/usr/bin/env node
// A guest's loopback-only TCP listener. One room WS per accepted TCP socket;
// application bytes (including HTTP, cookies and WS) are never interpreted.
// Node 22.18+ (its types are stripped as it loads).

import net from 'node:net'
import { bridge, run, vacant, endpoint, portOK, tokenOK, notify, failure, safeCode, UNSUPPORTED_V6, DATA_MAX } from './tcp-relay.mts'
import type { Bridge } from './tcp-relay.mts'

type Settings = { port: number; strict: boolean; url: string; token: string }
type StartOptions = {
  emit?: (row: Record<string, unknown>) => void
  signal?: AbortSignal
  createServer?: (options: any, listener: (socket: net.Socket) => void) => net.Server
  connect?: (options: net.NetConnectOpts) => net.Socket
}
// A bind the system refuses this user: a port below 1024 on Linux, a sandbox.
const REFUSED = new Set(['EACCES', 'EPERM'])
const BIND_TRIES = 8,
  SOCKETS_MAX = 32

// `token`: the guest's seat token, which each connection's room socket
// carries; it lasts as long as the seat does.
function configOf(cfg: any): Settings {
  // Port 0 asks the OS for any free port, so it only makes sense when not strict.
  if (
    !cfg ||
    typeof cfg !== 'object' ||
    Array.isArray(cfg) ||
    Object.keys(cfg).some(k => !['port', 'strict', 'url', 'token'].includes(k)) ||
    !(portOK(cfg.port) || (cfg.port === 0 && cfg.strict === false)) ||
    typeof cfg.strict !== 'boolean' ||
    !tokenOK(cfg.token)
  )
    throw failure('INVALID_CONFIG')
  return { port: cfg.port, strict: cfg.strict, url: endpoint(cfg.url), token: cfg.token }
}

// testoptions are internal, never accepted from stdin.
export async function start(cfg: any, { emit = notify, signal, createServer = net.createServer, connect = net.connect }: StartOptions = {}) {
  const servers = new Set<net.Server>(),
    sockets = new Set<net.Socket>(),
    relays = new Set<Bridge>()
  let settings!: Settings,
    port: number | undefined,
    ipv6 = false,
    ready = false,
    stopped = false,
    closing: Promise<void> | undefined
  const close = () => {
    if (closing) return closing
    stopped = true
    ready = false
    signal?.removeEventListener('abort', onAbort)
    for (const relay of relays) relay.close()
    for (const socket of sockets) socket.destroy()
    closing = Promise.all([...servers].map(unbind)).then(() => {})
    return closing
  }
  // The signal's listener: close() is a promise nobody waits for there.
  const onAbort = () => void close()
  function unbind(server: net.Server) {
    return new Promise<void>(resolve => {
      if (!server.listening) return resolve()
      server.close(() => {
        servers.delete(server)
        resolve()
      })
    })
  }
  async function bind(host: string, askedPort: number): Promise<number> {
    const server = createServer({ allowHalfOpen: true, highWaterMark: DATA_MAX }, (socket: net.Socket) => {
      socket.on('error', () => {})
      socket.pause()
      if (!ready || stopped) {
        socket.destroy()
        return
      }
      if (sockets.size >= SOCKETS_MAX) {
        emit({ state: 'channel-error', code: 'BUSY' })
        socket.destroy()
        return
      }
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      const relay = bridge(
        socket,
        settings.url,
        { authorization: `Bearer ${settings.token}` },
        {
          emit: row => emit({ state: 'channel-error', code: safeCode(row) }),
          onReady: () => emit({ state: 'channel-ready' }),
        },
      )
      relays.add(relay)
      void relay.closed.then(() => relays.delete(relay))
    })
    servers.add(server)
    server.on('error', () => {}) // Do not print native errors containing URLs.
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        server.removeListener('listening', listening)
        reject(error)
      }
      const listening = () => {
        server.removeListener('error', failed)
        resolve()
      }
      server.once('error', failed)
      server.once('listening', listening)
      server.listen({ host, port: askedPort, ipv6Only: host === '::1' })
    })
    if (stopped) {
      await unbind(server)
      throw failure('STARTUP')
    }
    return (server.address() as net.AddressInfo).port
  }
  try {
    settings = configOf(cfg)
    cfg = null
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      await close()
      throw failure('STARTUP')
    }
    for (let attempt = 0; attempt < BIND_TRIES; attempt++) {
      ipv6 = false
      const asked = attempt ? 0 : settings.port
      try {
        // An answering port is taken whatever bind() allows (vacant): a
        // requested one is knocked on in both families first. Port 0's own
        // number is knocked on ::1 alone, before the exact bind there: the
        // IPv4 allocator passes over an IPv6-only listener's port ([::]:P).
        if (asked && !(await Promise.all([vacant('127.0.0.1', asked, connect), vacant('::1', asked, connect)])).every(Boolean)) throw failure('EADDRINUSE')
        if (stopped) throw failure('STARTUP')
        port = await bind('127.0.0.1', asked)
        if (!asked && !(await vacant('::1', port, connect))) throw failure('EADDRINUSE')
        if (stopped) throw failure('STARTUP')
        try {
          await bind('::1', port)
          ipv6 = true
        } catch (error: any) {
          if (!UNSUPPORTED_V6.has(error.code)) throw error
        }
        break
      } catch (caught: any) {
        // Conflict on either family rolls back every bind from this attempt.
        await Promise.all([...servers].map(unbind))
        servers.clear()
        // A refused bind is DENIED, never STARTUP: strict reports it (the plugin
        // falls back as for a taken port), and non-strict moves on as for one.
        const error = REFUSED.has(caught.code) ? failure('DENIED') : caught
        if (stopped || settings.strict || !['EADDRINUSE', 'DENIED'].includes(error.code) || attempt === BIND_TRIES - 1) throw error
      }
    }
    if (stopped) throw failure('STARTUP')
    ready = true
    emit({ state: 'ready', port, ipv6 })
    return { close, port, ipv6 }
  } catch (error) {
    await close()
    const code = safeCode(error)
    if (!signal?.aborted) emit({ state: 'error', code })
    throw Object.assign(failure(code), { reported: true })
  }
}

if (import.meta.main) run(start)
