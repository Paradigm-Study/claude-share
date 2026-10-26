#!/usr/bin/env node
// One host process owns all raw TCP relays. Its loopback command port accepts
// only the plugin's independent bearer; room credentials arrive once on stdin.
'use strict'

const { startHost, controlServer, run, roomSettings, roomPost, endpoint, portOK, notify, failure, safeCode } = require('./tcp-relay.mts')
const LIMITS = Object.freeze({ peers: 64, sockets: 8, body: 4096, headers: 8192, notifications: 64, timeoutMs: 2000 })
const ID = /^[A-Za-z0-9_-]{8,40}$/, PID = /^[A-Za-z0-9_-]{1,64}$/

function configOf(cfg) {
  const settings = roomSettings(cfg, 'controlToken,room,token,version')
  // Reuse the transport's origin/path rules; no command supplies a URL or auth.
  endpoint(`${settings.room.replace(/^http/, 'ws')}/ws/WWWWWWWW`, true)
  return settings
}

function commandOf(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw failure('INVALID_CONFIG')
  const keys = Object.keys(command).sort().join(',')
  if (command.op === 'open' && keys === 'id,op,pid,port' && typeof command.id === 'string' && ID.test(command.id) && typeof command.pid === 'string' && PID.test(command.pid) && portOK(command.port)) return command
  if (command.op === 'close-preview' && keys === 'op,pid' && typeof command.pid === 'string' && PID.test(command.pid)) return command
  throw failure('INVALID_CONFIG')
}

async function start(cfg, { emit = notify, signal } = {}) {
  const settings = configOf(cfg), peers = new Map(), notifications = new Set()
  let stopped = false, closing

  // The room closes a guest's socket this worker couldn't take: BUSY, or CONNECT.
  function remoteReject(id, code) {
    if (stopped || notifications.size >= LIMITS.notifications) return
    const controller = new AbortController()
    notifications.add(controller)
    void roomPost(settings, `ws/${id}/reject`, { code }, controller, LIMITS.timeoutMs).finally(() => notifications.delete(controller))
  }
  function release(id, peer) {
    if (peers.get(id) !== peer) return
    peers.delete(id)
    if (!peer.paired && !peer.cancelled && peer.code) remoteReject(id, 'CONNECT')
    emit({ state: 'closed', id, ...(peer.code ? { code: peer.code } : {}) })
  }
  function command(row) {
    if (row.op === 'close-preview') {
      for (const peer of peers.values()) if (peer.pid === row.pid) { peer.cancelled = true; peer.controller.close() }
      return true
    }
    if (peers.has(row.id)) return true
    if (peers.size >= LIMITS.peers) { remoteReject(row.id, 'BUSY'); return false }
    const peer = { pid: row.pid, paired: false, cancelled: false, code: undefined, controller: undefined }
    peers.set(row.id, peer) // Reserve before startHost: connecting counts too.
    try {
      peer.controller = startHost({ port: row.port, room: endpoint(`${settings.room.replace(/^http/, 'ws')}/ws/${row.id}`, true), token: settings.token, version: settings.version }, {
        emit: error => { peer.code = safeCode(error) },
        onReady: () => { peer.paired = true },
      })
      peer.controller.closed.then(() => release(row.id, peer))
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
    signal?.removeEventListener('abort', close)
    const ending = control.close() // First: no command is taken after this.
    for (const peer of peers.values()) { peer.cancelled = true; peer.controller.close() }
    for (const controller of notifications) controller.abort()
    closing = (async () => {
      await ending
      await Promise.all([...peers.values()].map(peer => peer.controller.closed))
    })()
    return closing
  }
  try {
    signal?.addEventListener('abort', close, { once: true })
    if (signal?.aborted) throw failure('STARTUP')
    const port = await control.listen()
    if (stopped) throw failure('STARTUP')
    emit({ state: 'ready', port })
    return { close, port }
  } catch (error) { await close(); throw error }
}

module.exports = { start, LIMITS }
if (require.main === module) run(start)
