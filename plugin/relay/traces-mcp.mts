#!/usr/bin/env node
// Session traces for Claude Code, as the plugin's own MCP server (stdio):
// the turns of the shared sessions this person can read, kept by the share
// server Share uses (server/traces). Claude Code starts it with the plugin
// (plugin.json, mcpServers); Node 22.18+ runs it as it is, its types stripped.
//
// It signs in with the plugin's own sign-in, the one /team makes and Share
// sends: so one sign-in both owns a shared session's turns and reads them.
// That token is read from shared-session/account.json at each request, sent
// only to the server that gave it, in a header, never in argv or a URL. A
// sign-in made after Claude Code started is taken up at once: the tool list
// is said to have changed, and the next call goes with it.
//
// stdin and stdout: newline-delimited JSON-RPC, as Claude Code speaks it. Each
// request goes to <server>/mcp as one POST (the server keeps no MCP session);
// its answer, JSON or an event stream, comes back as the lines it holds.
// `initialize` is answered here, so the server shows as connected before
// anyone has signed in.

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { SERVER_URL } from '../hooks/server.ts'

type Message = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: unknown }
const INSTALLED_ID = 'shared-session@claude-share'
const LOOK_MS = 5_000 // how often a missing sign-in is looked for again

const configDir = (process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(process.env.HOME ?? '', '.claude')).replace(/\/+$/, '')

// A value Claude Code didn't fill in reaches us as written: not an option.
const given = (v: string | undefined) => (v && !v.startsWith('${') ? v.trim() : '')

// The server Share uses (the plugin's serverOf): the plugin's option, the
// environment, the build's default. The copy that updates itself is a plugin
// folder, configured under another id: the installed copy's option counts.
function serverOf(): string {
  let saved = given(process.env.SHARED_SESSION_OPTION_SERVER) || given(process.env.CLAUDE_PLUGIN_OPTION_SERVER)
  const root = given(process.env.CLAUDE_PLUGIN_ROOT).replace(/\/+$/, '')
  if (!saved && root === `${configDir}/shared-session/plugin`) {
    try {
      const settings = JSON.parse(fs.readFileSync(`${configDir}/settings.json`, 'utf8'))
      const server = settings?.pluginConfigs?.[INSTALLED_ID]?.options?.server
      if (typeof server === 'string') saved = server.trim()
    } catch {}
  }
  return (saved || given(process.env.SHARED_SESSION_SERVER) || SERVER_URL).replace(/\/+$/, '')
}

// Over HTTPS only, or plain http to this computer (as the plugin's secureServer).
function secure(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || (u.protocol === 'http:' && /^(?:(?:[a-z0-9-]+\.)*localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(u.hostname))
  } catch {
    return false
  }
}

// This server's sign-in, as the plugin saved it; null: none.
function tokenFor(server: string): string | null {
  try {
    const all = JSON.parse(fs.readFileSync(`${configDir}/shared-session/account.json`, 'utf8'))?.servers
    const token = all?.[server]?.token
    return typeof token === 'string' && token ? token : null
  } catch {
    return null
  }
}

const server = serverOf()
const out = (m: Message) => process.stdout.write(`${JSON.stringify(m)}\n`)
const fail = (id: Message['id'], message: string) => out({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } })
const notSignedIn = `Not signed in to ${server}. In Claude Code, run /team signin (or /share-session, which asks), then try again.`

// One request to the server; the answer's messages, from JSON or an event stream.
async function forward(m: Message, token: string): Promise<Message[]> {
  const res = await fetch(`${server}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify(m),
    signal: AbortSignal.timeout(60_000),
  })
  if (res.status === 401) throw new Error(`The sign-in to ${server} has ended. In Claude Code, run /team signin again.`)
  const text = await res.text()
  if (!res.ok && !text) throw new Error(`${server} answered ${res.status}.`)
  const lines = (res.headers.get('content-type') ?? '').startsWith('text/event-stream')
    ? text
        .split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trim())
    : [text]
  const said: Message[] = []
  for (const line of lines) {
    try {
      said.push(JSON.parse(line))
    } catch {}
  }
  return said
}

async function handle(m: Message) {
  if (m.method === 'initialize') {
    const asked = (m.params as { protocolVersion?: string } | undefined)?.protocolVersion
    return out({
      jsonrpc: '2.0',
      id: m.id ?? null,
      result: {
        protocolVersion: asked ?? '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'shared-session-traces', version: '1' },
        instructions: `Search the turns of shared Claude Code sessions kept by ${server}: your own and your teams'.`,
      },
    })
  }
  // Notifications (initialized, cancelled) need nothing from the server.
  if (m.id === undefined || m.id === null) return
  if (m.method === 'ping') return out({ jsonrpc: '2.0', id: m.id, result: {} })
  if (!secure(server)) return fail(m.id, `The share server ${server} is plain http; only https (or this computer) is used.`)
  const token = tokenFor(server)
  if (!token) return m.method === 'tools/list' ? out({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }) : fail(m.id, notSignedIn)
  try {
    const said = await forward(m, token)
    const answer = said.find(x => x.id === m.id)
    if (answer) return out(answer)
    fail(m.id, `${server} gave no answer.`)
  } catch (error) {
    fail(m.id, String((error as Error)?.message ?? error))
  }
}

// A sign-in made while this runs: the tools appear without a restart.
let signedIn = tokenFor(server) !== null
setInterval(() => {
  const now = tokenFor(server) !== null
  if (now !== signedIn) out({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  signedIn = now
}, LOOK_MS).unref()

readline.createInterface({ input: process.stdin }).on('line', line => {
  let m: Message
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  void handle(m)
})
