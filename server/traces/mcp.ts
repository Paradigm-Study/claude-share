// Session traces as an MCP server (Streamable HTTP, answered as plain JSON,
// no session): `claude mcp add --transport http shared-session-traces
// <server>/mcp`. The OAuth provider (oauth.ts) lets a call through only with
// its access token, and hands over what the person's sign-in left in the
// grant (`props`); every call reads only the traces that account may read
// now, its teams' and its own, as the directory says at that call.

import { searchTraces, sessionOf, sessionsOf, turnOf, whoIs } from './index.ts'
import type { TracesEnv } from './index.ts'
import { timeOf } from './time.ts'

export type GrantProps = { token: string; account: string }

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']
const SERVER = { name: 'shared-session-traces', version: '0.1.0' }

const TOOLS = [
  {
    name: 'search',
    description: 'Search the traces of shared Claude Code sessions you can read (your teams\' and your own) by what was asked and answered. Matches words, Chinese included, and meaning. Each hit names a session and a turn: read it whole with get_turn.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words or a question.' },
        since: { type: 'string', description: 'Only turns after this: an ISO date, or a span back from now such as 7d or 12h.' },
        person: { type: 'string', description: 'Only prompts this person typed, by their name in the room.' },
        mode: { type: 'string', enum: ['hybrid', 'keyword', 'semantic'], description: 'hybrid (default): words and meaning together.' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_turn',
    description: 'One turn whole: the prompt and Claude\'s reply.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' }, turn: { type: 'string' } }, required: ['session', 'turn'] },
  },
  {
    name: 'get_session',
    description: 'A session\'s title and each of its prompts, first 200 characters.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, required: ['session'] },
  },
  {
    name: 'list_sessions',
    description: 'The sessions you can read, the most recently active first, 50 at most.',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'string' }, before: { type: 'string', description: 'An ISO date: the page after one ending here.' }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
    },
  },
]

const reply = (id: unknown, result: unknown) => Response.json({ jsonrpc: '2.0', id, result })
const failure = (id: unknown, code: number, message: string, status = 200) => Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status })

export async function handleMcp(req: Request, env: TracesEnv, props: GrantProps | undefined): Promise<Response> {
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  // The sign-in behind the grant, as it is now: one signed out or deleted
  // since reads nothing, and the client is sent to sign in again.
  const who = props?.token ? await whoIs(env, props.token) : null
  if (!who?.account?.id || who.account.id !== props?.account) {
    return Response.json({ error: 'invalid_token', error_description: 'The sign-in behind this token has ended.' }, { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } })
  }
  const scopes = [`u:${who.account.id}`, ...(who.teams ?? []).map(t => `t:${t.id}`)]
  let msg: any
  try { msg = await req.json() } catch { return failure(null, -32700, 'Parse error', 400) }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') return failure(msg?.id, -32600, 'Invalid request', 400)
  // A notification (no id) is taken, never answered.
  if (msg.id === undefined) return new Response(null, { status: 202 })
  const { id, method, params = {} } = msg
  if (method === 'initialize') {
    const asked = params.protocolVersion
    return reply(id, { protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: {} }, serverInfo: SERVER })
  }
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method !== 'tools/call') return failure(id, -32601, `Method not found: ${method}`)
  const args = params.arguments ?? {}
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  try {
    let result: any
    if (params.name === 'search') {
      if (!str(args.query)?.trim()) throw new Error('query is required.')
      const hits = await searchTraces(env, scopes, { query: args.query.trim(), since: timeOf(args.since), person: str(args.person), mode: str(args.mode) ?? 'hybrid', limit: Number(args.limit) || 20 })
      result = { hits }
    } else if (params.name === 'get_turn') {
      result = await turnOf(env, scopes, String(args.session ?? ''), String(args.turn ?? ''))
      if (!result) throw new Error('No such turn in the traces you can read.')
    } else if (params.name === 'get_session') {
      result = await sessionOf(env, scopes, String(args.session ?? ''))
      if (!result) throw new Error('No such session in the traces you can read.')
    } else if (params.name === 'list_sessions') {
      result = { sessions: await sessionsOf(env, scopes, { since: timeOf(args.since), before: timeOf(args.before), limit: Number(args.limit) || 50 }) }
    } else {
      return failure(id, -32602, `Unknown tool: ${params.name}`)
    }
    return reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result })
  } catch (error) {
    return reply(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true })
  }
}
