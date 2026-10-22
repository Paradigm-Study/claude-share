#!/usr/bin/env node
// One host process owns all raw TCP relays. Its loopback command port accepts
// only the plugin's independent bearer; room credentials arrive once on stdin.
'use strict'

const http = require('http')
const https = require('https')
const { startHost, controlServer, run, endpoint, portOK, tokenOK, notify, failure, safeCode } = require('./tcp-relay.cjs')
const LIMITS = Object.freeze({ peers: 64, sockets: 8, body: 4096, headers: 8192, notifications: 64, timeoutMs: 2000 })
const ID = /^[A-Za-z0-9_-]{8,40}$/, PID = /^[A-Za-z0-9_-]{1,64}$/

function configOf(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || Object.keys(cfg).sort().join(',') !== 'controlToken,room,token,version' || !tokenOK(cfg.token) || typeof cfg.controlToken !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(cfg.controlToken) || cfg.controlToken === cfg.token || typeof cfg.version !== 'string' || !/^[\w.-]{0,64}$/.test(cfg.version) || typeof cfg.room !== 'string') throw failure('INVALID_CONFIG')
  // Reuse the transport's origin/path rules; no command supplies a URL or auth.
  endpoint(`${cfg.room.replace(/^http/, 'ws')}/ws/WWWWWWWW`, true)
  if (!/^https?:\/\//.test(cfg.room)) throw failure('INVALID_CONFIG')
  return { ...cfg }
}

function commandOf(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw failure('INVALID_CONFIG')
  const keys = Object.keys(command).sort().join(',')
  if (command.op === 'open' && keys === 'id,op,pid,port' && typeof command.id === 'string' && ID.test(command.id) && typeof command.pid === 'string' && PID.test(command.pid) && portOK(command.port)) return command
  if (command.op === 'close-preview' && keys === 'op,pid' && typeof command.pid === 'string' && PID.test(command.pid)) return command
  if (command.op === 'reject' && keys === 'code,id,op' && typeof command.id === 'string' && ID.test(command.id) && ['BUSY', 'CONNECT'].includes(command.code)) return command
  throw failure('INVALID_CONFIG')
}

async function start(cfg, { emit = notify, signal } = {}) {
  const settings = configOf(cfg), peers = new Map(), notifications = new Set()
  let stopped = false, closing

  function remoteReject(id, code) {
    if (stopped || notifications.size >= LIMITS.notifications) return
    let req
    try {
      const body = JSON.stringify({ code })
      req = (settings.room.startsWith('https:') ? https : http).request(`${settings.room}/ws/${id}/reject`, {
        method: 'POST', agent: false, maxHeaderSize: LIMITS.headers,
        headers: { authorization: `Bearer ${settings.token}`, 'x-shared-session-version': settings.version, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' },
      }, res => res.destroy())
      notifications.add(req)
      const timer = setTimeout(() => req.destroy(), LIMITS.timeoutMs)
      req.once('close', () => { clearTimeout(timer); notifications.delete(req) })
      req.on('error', () => {})
      req.end(body)
    } catch { req?.destroy() }
  }
  function release(id, peer) {
    if (peers.get(id) !== peer) return
    peers.delete(id)
    if (!peer.paired && !peer.cancelled && peer.code) remoteReject(id, 'CONNECT')
    emit({ state: 'closed', id, ...(peer.code ? { code: peer.code } : {}) })
  }
  function command(row) {
    if (row.op === 'reject') { remoteReject(row.id, row.code); return true }
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
    for (const req of notifications) req.destroy()
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
