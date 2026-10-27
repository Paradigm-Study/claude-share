// Session traces, in the Worker: a shared session's turns kept in Postgres
// (store.ts) as each one ends, and searched from Claude Code over MCP
// (mcp.ts), which people reach by signing in with OAuth (oauth.ts). On only
// where the Worker has a database (TRACES_DB, a Hyperdrive binding) and
// somewhere for OAuth's grants (OAUTH_KV); without them, nothing is kept
// beyond the room's day. Embeddings come from Workers AI (AI) when bound;
// without them, search is by keywords alone.

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { getSession, getTurn, hasCjk, listSessions, putTurns, search } from './store.ts'
import type { Db, ListOptions, SearchOptions, Session } from './store.ts'
import type { Turn } from './turns.ts'

export { takeTurns, tracesScope, authorOf } from './turns.ts'
export { tracesFetch, isTracesPath } from './oauth.ts'

export interface TracesEnv {
  TRACES_DB?: Hyperdrive
  OAUTH_KV?: KVNamespace
  AI?: Ai
  DIRECTORY: DurableObjectNamespace
  OAUTH_PROVIDER?: OAuthHelpers
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  AUTH_TEST?: string
}

export const EMBED_MODEL = '@cf/qwen/qwen3-embedding-0.6b'
// What a query is embedded with: Qwen3's embeddings expect queries to say what they're for.
const QUERY_TASK = 'Instruct: Given a question about past coding sessions, retrieve the conversation turns that answer it\nQuery: '
const EMBED_CHARS = 6000

// One connection a call, as Hyperdrive wants: it pools them near the database.
export async function withDb<T>(env: TracesEnv, use: (db: Db) => Promise<T>): Promise<T> {
  const { Client } = (await import('pg')).default
  const db = new Client({ connectionString: env.TRACES_DB!.connectionString })
  await db.connect()
  try {
    return await use(db)
  } finally {
    await db.end().catch(() => {})
  }
}

export async function embed(env: TracesEnv, texts: string[]): Promise<(number[] | null)[]> {
  if (!env.AI || !texts.length) return texts.map(() => null)
  const res = (await env.AI.run(EMBED_MODEL as any, { text: texts.map(t => t.slice(0, EMBED_CHARS)) } as any)) as { data?: number[][] }
  return texts.map((_, i) => res?.data?.[i] ?? null)
}

// A room's closed turns into its traces, embedded first. Throws when the
// database can't take them: the room keeps them and tries again.
export async function keepTurns(env: TracesEnv, session: Session, turns: Turn[]) {
  if (!turns.length) return
  const vectors = await embed(
    env,
    turns.map(t => `${t.prompt}\n\n${t.reply}`),
  ).catch(() => turns.map(() => null))
  const embedded = turns.map((t, i) => ({ ...t, embedding: vectors[i] }))
  await withDb(env, async db => putTurns(db, session, embedded, await hasCjk(db)))
}

export async function searchTraces(env: TracesEnv, scopes: string[], args: SearchOptions) {
  const embedding = args.mode !== 'keyword' && args.query ? (await embed(env, [QUERY_TASK + args.query]).catch(() => [null]))[0] : null
  return withDb(env, db => search(db, scopes, { ...args, embedding }))
}

export const turnOf = (env: TracesEnv, scopes: string[], session: string, turn: string) => withDb(env, db => getTurn(db, scopes, session, turn))
export const sessionOf = (env: TracesEnv, scopes: string[], session: string) => withDb(env, db => getSession(db, scopes, session))
export const sessionsOf = (env: TracesEnv, scopes: string[], args: ListOptions) => withDb(env, db => listSessions(db, scopes, args))

// What the directory says of a sign-in: the account and its teams, or null
// when the sign-in is gone (signed out, or the account deleted).
export async function whoIs(env: TracesEnv, token: string): Promise<{ account: { id: string; name: string }; teams: { id: string }[] } | null> {
  const res = await directory(env).fetch('https://directory.internal/api/me', { headers: { authorization: `Bearer ${token}` } })
  return res.ok ? res.json() : null
}

export const directory = (env: TracesEnv) => env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'))
