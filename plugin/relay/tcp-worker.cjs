#!/usr/bin/env node
// One host process owns all raw TCP relays. Its loopback command port accepts
// only the plugin's independent bearer; room credentials arrive once on stdin.
'use strict'

const http = require('http')
const https = require('https')
const { timingSafeEqual } = require('crypto')
const { isUtf8 } = require('buffer')
const { startHost, run, endpoint, portOK, tokenOK, notify, failure, safeCode } = require('./tcp-relay.cjs')
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
  const settings = configOf(cfg), peers = new Map(), sockets = new Set(), notifications = new Set()
  const authorization = Buffer.from(`Bearer ${settings.controlToken}`)
  let stopped = false, closing, binding, port

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
      peer.controller = startHost({ tcp: true, port: row.port, room: endpoint(`${settings.room.replace(/^http/, 'ws')}/ws/${row.id}`, true), token: settings.token, version: settings.version }, {
        emit: error => { peer.code = safeCode(error) },
        onReady: () => { peer.paired = true },
      })
      peer.controller.closed.then(() => release(row.id, peer))
    } catch (error) { peer.code = safeCode(error); release(row.id, peer) }
    return true
  }
  function reply(res, status, code) {
    if (res.writableEnded || res.destroyed) return
    res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify({ ok: status === 200, ...(code ? { code } : {}) }))
  }
  const server = http.createServer({ maxHeaderSize: LIMITS.headers }, (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '')
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) return reply(res, 401)
    if (req.headers.host !== `127.0.0.1:${port}` || 'origin' in req.headers) return reply(res, 403)
    if (stopped || req.method !== 'POST' || req.url !== '/' || req.headers['content-type'] !== 'application/json' || req.headers['content-encoding'] || ['host', 'authorization', 'content-type'].some(key => req.rawHeaders.filter((_, i) => !(i % 2) && req.rawHeaders[i].toLowerCase() === key).length !== 1) || (req.headers['content-length'] !== undefined && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > LIMITS.body))) return reply(res, 400)
    let chunks = [], size = 0, failed = false
    req.on('error', () => { failed = true; chunks = [] })
    req.on('data', chunk => {
      if (failed) return
      size += chunk.length
      if (size > LIMITS.body) { failed = true; chunks = []; return reply(res, 400) }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (failed || stopped) return reply(res, 400)
      let row
      try {
        const bytes = Buffer.concat(chunks, size)
        chunks = []
        if (!isUtf8(bytes)) throw failure('INVALID_CONFIG')
        row = commandOf(JSON.parse(bytes.toString('utf8')))
      } catch { return reply(res, 400) }
      const accepted = command(row)
      reply(res, accepted ? 200 : 429, accepted ? undefined : 'BUSY')
    })
  })
  server.requestTimeout = server.headersTimeout = LIMITS.timeoutMs
  server.maxRequestsPerSocket = 1
  server.on('connection', socket => {
    socket.on('error', () => {})
    if (stopped || sockets.size >= LIMITS.sockets) return socket.destroy()
    sockets.add(socket)
    // A hard lifetime also bounds slow-drip headers/bodies, not just idle time.
    const timer = setTimeout(() => socket.destroy(), LIMITS.timeoutMs)
    socket.once('close', () => { clearTimeout(timer); sockets.delete(socket) })
  })
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'))
  server.on('error', () => {}) // Never print native errors or addresses.
  const close = () => {
    if (closing) return closing
    stopped = true
    signal?.removeEventListener('abort', close)
    for (const peer of peers.values()) { peer.cancelled = true; peer.controller.close() }
    for (const req of notifications) req.destroy()
    for (const socket of sockets) socket.destroy()
    closing = (async () => {
      await binding?.catch(() => {})
      await new Promise(resolve => server.listening ? server.close(resolve) : resolve())
      await Promise.all([...peers.values()].map(peer => peer.controller.closed))
    })()
    return closing
  }
  try {
    signal?.addEventListener('abort', close, { once: true })
    if (signal?.aborted) throw failure('STARTUP')
    binding = new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0 }, () => { server.removeListener('error', reject); resolve() })
    })
    await binding
    if (stopped) throw failure('STARTUP')
    port = server.address().port
    emit({ state: 'ready', port })
    return { close, port }
  } catch (error) { await close(); throw error }
}

module.exports = { start, LIMITS }
if (require.main === module) run(start)
