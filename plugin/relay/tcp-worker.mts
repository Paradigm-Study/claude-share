#!/usr/bin/env node
// One host process owns all raw TCP relays. Its loopback command port accepts
// only the plugin's independent bearer; room credentials arrive once on stdin.
// Node 22.18+ (its types are stripped as it loads).

import { startHost, controlServer, run, roomSettings, roomPost, endpoint, portOK, notify, failure, safeCode } from './tcp-relay.mts'
import type { Bridge, RoomSettings } from './tcp-relay.mts'

/** One guest connection this worker relays: its preview, and how it went. */
type Peer = { pid: string; paired: boolean; cancelled: boolean; code: string | undefined; controller: Bridge | undefined }

export const LIMITS = Object.freeze({ peers: 64, sockets: 8, body: 4096, headers: 8192, notifications: 64, timeoutMs: 2000 })
const ID = /^[A-Za-z0-9_-]{8,40}$/, PID = /^[A-Za-z0-9_-]{1,64}$/

function configOf(cfg: unknown): RoomSettings {
  const settings = roomSettings(cfg, 'controlToken,room,token,version')
  // Reuse the transport's origin/path rules; no command supplies a URL or auth.
  endpoint(`${settings.room.replace(/^http/, 'ws')}/ws/WWWWWWWW`, true)
  return settings
}

function commandOf(command: any): any {
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw failure('INVALID_CONFIG')
  const keys = Object.keys(command).sort().join(',')
  if (command.op === 'open' && keys === 'id,op,pid,port' && typeof command.id === 'string' && ID.test(command.id) && typeof command.pid === 'string' && PID.test(command.pid) && portOK(command.port)) return command
  if (command.op === 'close-preview' && keys === 'op,pid' && typeof command.pid === 'string' && PID.test(command.pid)) return command
  throw failure('INVALID_CONFIG')
}

export async function start(cfg: unknown, { emit = notify, signal }: { emit?: (row: Record<string, unknown>) => void; signal?: AbortSignal } = {}) {
  const settings = configOf(cfg), peers = new Map<string, Peer>(), notifications = new Set<AbortController>()
  let stopped = false, closing: Promise<void> | undefined

  // The room closes a guest's socket this worker couldn't take: BUSY, or CONNECT.
  function remoteReject(id: string, code: string) {
    if (stopped || notifications.size >= LIMITS.notifications) return
    const controller = new AbortController()
    notifications.add(controller)
    void roomPost(settings, `ws/${id}/reject`, { code }, controller, LIMITS.timeoutMs).finally(() => notifications.delete(controller))
  }
  function release(id: string, peer: Peer) {
    if (peers.get(id) !== peer) return
    peers.delete(id)
    if (!peer.paired && !peer.cancelled && peer.code) remoteReject(id, 'CONNECT')
    emit({ state: 'closed', id, ...(peer.code ? { code: peer.code } : {}) })
  }
  function command(row: any): boolean {
    if (row.op === 'close-preview') {
      for (const peer of peers.values()) if (peer.pid === row.pid) { peer.cancelled = true; peer.controller!.close() }
      return true
    }
    if (peers.has(row.id)) return true
    if (peers.size >= LIMITS.peers) { remoteReject(row.id, 'BUSY'); return false }
    const peer: Peer = { pid: row.pid, paired: false, cancelled: false, code: undefined, controller: undefined }
    peers.set(row.id, peer) // Reserve before startHost: connecting counts too.
    try {
      peer.controller = startHost({ port: row.port, room: endpoint(`${settings.room.replace(/^http/, 'ws')}/ws/${row.id}`, true), token: settings.token, version: settings.version }, {
        emit: (error: unknown) => { peer.code = safeCode(error) },
        onReady: () => { peer.paired = true },
      })
      void peer.controller.closed.then(() => release(row.id, peer))
    } catch (error) { peer.code = safeCode(error); release(row.id, peer) }
    return true
  }
  // A full worker answers 429 BUSY (and tells the room); a closing one 503.
  const control = controlServer({
    token: settings.controlToken, bodyLimit: LIMITS.body, sockets: LIMITS.sockets, timeoutMs: LIMITS.timeoutMs, headers: LIMITS.headers,
    onCommand: value => stopped ? { status: 503 } : command(commandOf(value)) ? undefined : { status: 429, code: 'BUSY' },
  })
  const close = () => {
    if (closing) return closing
    stopped = true
    signal?.removeEventListener('abort', onAbort)
    const ending = control.close() // First: no command is taken after this.
    for (const peer of peers.values()) { peer.cancelled = true; peer.controller!.close() }
    for (const controller of notifications) controller.abort()
    closing = (async () => {
      await ending
      await Promise.all([...peers.values()].map(peer => peer.controller!.closed))
    })()
    return closing
  }
  // The signal's listener: close() is a promise nobody waits for there.
  const onAbort = () => void close()
  try {
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) throw failure('STARTUP')
    const port = await control.listen()
    if (stopped) throw failure('STARTUP')
    emit({ state: 'ready', port })
    return { close, port }
  } catch (error) { await close(); throw error }
}

if (import.meta.main) run(start)
