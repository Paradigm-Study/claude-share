#!/usr/bin/env node
// A guest's loopback-only TCP listener. One room WS per accepted TCP socket;
// application bytes (including HTTP, cookies and WS) are never interpreted.
'use strict'

const net = require('net')
const { bridge, run, endpoint, portOK, tokenOK, notify, failure, safeCode, DATA_MAX } = require('./tcp-relay.cjs')
const UNSUPPORTED_V6 = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'])
const BIND_TRIES = 8

function configOf(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || Object.keys(cfg).some(k => !['port', 'strict', 'url', 'token', 'expiresAt'].includes(k)) || !portOK(cfg.port) || typeof cfg.strict !== 'boolean' || !tokenOK(cfg.token) || !Number.isSafeInteger(cfg.expiresAt)) throw failure('INVALID_CONFIG')
  const url = endpoint(cfg.url)
  if (cfg.expiresAt <= Date.now()) throw failure('EXPIRED')
  return { port: cfg.port, strict: cfg.strict, url, token: cfg.token, expiresAt: cfg.expiresAt }
}

// testoptions are internal, never accepted from stdin.
async function start(cfg, { emit = notify, signal, createServer = net.createServer } = {}) {
  const servers = new Set(), sockets = new Set(), relays = new Set()
  let settings, port, ready = false, stopped = false, closing, expiryTimer
  const close = () => {
    if (closing) return closing
    stopped = true
    ready = false
    clearTimeout(expiryTimer)
    signal?.removeEventListener('abort', close)
    for (const relay of relays) relay.close()
    for (const socket of sockets) socket.destroy()
    closing = Promise.all([...servers].map(unbind)).then(() => {})
    return closing
  }
  const expire = () => {
    if (stopped) return
    // ponytail: grants expire; Open obtains a new one. An old TCP flow is
    // never resumed, and an HTTP request or OAuth callback is never replayed.
    if (Date.now() < settings.expiresAt) return scheduleExpiry()
    emit({ state: 'expired' })
    void close()
  }
  const scheduleExpiry = () => { expiryTimer = setTimeout(expire, Math.min(0x7fffffff, Math.max(1, settings.expiresAt - Date.now()))) }
  function unbind(server) {
    return new Promise(resolve => {
      if (!server.listening) return resolve()
      server.close(() => { servers.delete(server); resolve() })
    })
  }
  async function bind(host, askedPort) {
    const server = createServer({ allowHalfOpen: true, highWaterMark: DATA_MAX }, socket => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => sockets.delete(socket))
      socket.pause()
      if (!ready || stopped || Date.now() >= settings.expiresAt) { socket.destroy(); if (Date.now() >= settings.expiresAt) expire(); return }
      const relay = bridge(socket, settings.url, { authorization: `Bearer ${settings.token}` }, { emit })
      relays.add(relay)
      relay.closed.then(() => relays.delete(relay))
    })
    servers.add(server)
    server.on('error', () => {}) // Do not print native errors containing URLs.
    await new Promise((resolve, reject) => {
      const failed = error => { server.removeListener('listening', listening); reject(error) }
      const listening = () => { server.removeListener('error', failed); resolve() }
      server.once('error', failed)
      server.once('listening', listening)
      server.listen({ host, port: askedPort, ipv6Only: host === '::1' })
    })
    if (stopped) { await unbind(server); throw failure('STARTUP') }
    return server.address().port
  }
  try {
    settings = configOf(cfg)
    cfg = null
    signal?.addEventListener('abort', close, { once: true })
    if (signal?.aborted) { await close(); throw failure('STARTUP') }
    for (let attempt = 0; attempt < BIND_TRIES; attempt++) {
      try {
        port = await bind('127.0.0.1', attempt ? 0 : settings.port)
        try { await bind('::1', port) } catch (error) { if (!UNSUPPORTED_V6.has(error.code)) throw error }
        break
      } catch (error) {
        // Conflict on either family rolls back every bind from this attempt.
        await Promise.all([...servers].map(unbind))
        servers.clear()
        if (stopped || settings.strict || error.code !== 'EADDRINUSE' || attempt === BIND_TRIES - 1) throw error
      }
    }
    if (stopped) throw failure('STARTUP')
    if (Date.now() >= settings.expiresAt) throw failure('EXPIRED')
    ready = true
    scheduleExpiry()
    emit({ state: 'ready', port })
    return { close, port }
  } catch (error) {
    await close()
    const code = safeCode(error)
    if (!signal?.aborted) emit({ state: 'error', code })
    throw Object.assign(failure(code), { reported: true })
  }
}

module.exports = { start }
if (require.main === module) run(start)
