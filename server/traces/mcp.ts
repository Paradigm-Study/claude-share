// Session traces as an MCP server, over Streamable HTTP: `claude mcp add
// --transport http shared-session-traces <server>/mcp`. The protocol is the
// MCP SDK's (@modelcontextprotocol/server: a fresh McpServer a request, no
// session); this file is the four tools. The OAuth provider (oauth.ts) lets a
// call through only with its access token, and hands over what the person's
// sign-in left in the grant (`props`); every call reads only the traces that
// account may read now, its teams' and its own, as the directory says at that
// call.

import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { searchTraces, sessionOf, sessionsOf, turnOf, whoIs } from './index.ts'
import type { TracesEnv } from './index.ts'
import { timeOf } from './time.ts'

// What a request reads as: an OAuth grant's (the account it was made for), or
// the plugin's own sign-in (`account` absent: whoever the token is now).
export type GrantProps = { token: string; account?: string }

const SERVER = { name: 'shared-session-traces', version: '0.2.0' }

const answer = (result: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result })
const refusal = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true })

// The tools, for one request, reading what `scopes` lets this account read.
function tracesServer(env: TracesEnv, scopes: string[]) {
  const server = new McpServer(SERVER)
  server.registerTool(
    'search',
    {
      description:
        "Search the traces of shared Claude Code sessions you can read (your teams' and your own) by what was asked and answered. Matches words, Chinese included, and meaning. Each hit names a session and a turn: read it whole with get_turn.",
      inputSchema: z.object({
        query: z.string().trim().min(1).describe('Words or a question.'),
        since: z.string().optional().describe('Only turns after this: an ISO date, or a span back from now such as 7d or 12h.'),
        person: z.string().optional().describe('Only prompts this person typed, by their name in the room.'),
        mode: z.enum(['hybrid', 'keyword', 'semantic']).optional().describe('hybrid (default): words and meaning together.'),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, since, person, mode, limit }) =>
      answer({ hits: await searchTraces(env, scopes, { query, since: timeOf(since), person, mode: mode ?? 'hybrid', limit: limit ?? 20 }) }),
  )
  server.registerTool(
    'get_turn',
    {
      description: "One turn whole: the prompt and Claude's reply.",
      inputSchema: z.object({ session: z.string(), turn: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ session, turn }) => {
      const found = await turnOf(env, scopes, session, turn)
      return found ? answer(found) : refusal('No such turn in the traces you can read.')
    },
  )
  server.registerTool(
    'get_session',
    {
      description: "A session's title and each of its prompts, first 200 characters.",
      inputSchema: z.object({ session: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ session }) => {
      const found = await sessionOf(env, scopes, session)
      return found ? answer(found) : refusal('No such session in the traces you can read.')
    },
  )
  server.registerTool(
    'list_sessions',
    {
      description: 'The sessions you can read, the most recently active first, 50 at most.',
      inputSchema: z.object({
        since: z.string().optional(),
        before: z.string().optional().describe('An ISO date: the page after one ending here.'),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ since, before, limit }) =>
      answer({ sessions: await sessionsOf(env, scopes, { since: timeOf(since), before: timeOf(before), limit: limit ?? 50 }) }),
  )
  return server
}

export async function handleMcp(req: Request, env: TracesEnv, props: GrantProps | undefined): Promise<Response> {
  // The sign-in behind the grant, as it is now: one signed out or deleted
  // since reads nothing, and the client is sent to sign in again.
  const who = props?.token ? await whoIs(env, props.token) : null
  if (!who?.account?.id || (props?.account !== undefined && who.account.id !== props.account)) {
    return Response.json(
      { error: 'invalid_token', error_description: 'The sign-in behind this token has ended.' },
      { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } },
    )
  }
  const scopes = [`u:${who.account.id}`, ...(who.teams ?? []).map(t => `t:${t.id}`)]
  return createMcpHandler(() => tracesServer(env, scopes)).fetch(req)
}
