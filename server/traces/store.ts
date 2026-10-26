// Session traces's tables, in Postgres (Neon, reached through Hyperdrive),
// and its search: keywords and meaning together, fused by rank (RRF),
// filtered by whose traces the asker may read (`scopes`: `t:<team>` and
// `u:<account>`).
//
// Two keyword indexes, so the two can be compared on real text:
// - `tsv_cjk`: Lakebase Search's Chinese tokenizer (Jieba, `mixed` mode, which
//   also emits a word's parts) under its BM25 index, where Neon has them;
// - `tsv_simple`: the `simple` parser over text rewritten into pairs of CJK
//   characters (grams.ts), ranked by ts_rank_cd, which any Postgres has.
// Meaning is a 1024-number embedding per turn (Workers AI), searched by
// cosine distance.

import { grams, queryWords } from './grams.ts'
import type { Author, Turn } from './turns.ts'

// What pg's Client gives, and all this uses of it.
export type Db = { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> }
export type Session = { id: string; scope: string; team?: string | null; owner?: { name: string; account: string | null }; title?: string | null }
export type SearchOptions = { query?: string; embedding?: number[] | null; since?: number; person?: string; limit?: number; mode?: string; keywords?: 'bm25' | 'bigram' }
export type ListOptions = { since?: number; before?: number; limit?: number }

export const DIMENSIONS = 1024
const CJK_CONFIG = 'tokenizer_ext.tokenizer_chinese'
const CANDIDATES = 40
// A turn this far from the query in meaning is no hit, however few there are.
export const MAX_DISTANCE = 0.75

export async function migrate(db: Db) {
  await db.query('create extension if not exists vector')
  let cjk = true
  try {
    await db.query('create extension if not exists lakebase_text')
    await db.query('create schema if not exists tokenizer_ext')
    await db.query('create extension if not exists lakebase_tokenizer with schema tokenizer_ext')
    await db.query(`select to_tsvector('${CJK_CONFIG}', '测试')`)
  } catch {
    cjk = false
  }
  await db.query(`
    create table if not exists settings (key text primary key, value text not null);
    create table if not exists sessions (
      id          text primary key,
      scope       text not null,
      team_id     text,                 -- the team it was shared with, if any
      owner_account text,               -- who shared it: their account
      owner_name  text not null,        -- and their name in the room
      title       text,
      started_at  timestamptz not null,
      updated_at  timestamptz not null,
      turn_count  integer not null default 0
    );
    create index if not exists sessions_scope on sessions (scope, updated_at desc);
    create table if not exists turns (
      session_id  text not null references sessions on delete cascade,
      turn_id     text not null,
      scope       text not null,
      at          timestamptz not null,
      author_name text not null,        -- who typed the prompt, by their name in the room
      author_account text,              -- and their account, when the room could tell
      author_role text not null,        -- host, guest or unknown
      prompt      text not null,
      reply       text not null,
      tools       text[] not null default '{}',
      tsv_simple  tsvector not null,
      tsv_cjk     tsvector,
      embedding   vector(${DIMENSIONS}),
      primary key (session_id, turn_id)
    );
    create index if not exists turns_scope on turns (scope, at desc);
    create index if not exists turns_simple on turns using gin (tsv_simple);
    create index if not exists turns_embedding on turns using hnsw (embedding vector_cosine_ops);
  `)
  if (cjk) await db.query('create index if not exists turns_bm25 on turns using lakebase_bm25 (tsv_cjk)')
  await db.query(`insert into settings values ('cjk', $1) on conflict (key) do update set value = excluded.value`, [cjk ? '1' : '0'])
  return { cjk }
}

// BM25 counts its corpus when its index is built; rebuilt, it counts what's there now.
export const reindex = (db: Db) => db.query('reindex index turns_bm25')

export async function hasCjk(db: Db) {
  const { rows } = await db.query(`select value from settings where key = 'cjk'`)
  return rows[0]?.value === '1'
}

const ms = (t: number | string | Date) => new Date(t).toISOString()
const by = (r: any): Author => ({ name: r.author_name, account: r.author_account, role: r.author_role })
const vec = (v: number[] | null | undefined) => (v ? `[${v.join(',')}]` : null)

// A session's turns, written whole each time: the same turn again changes
// nothing but what it says now, so a retry writes nothing twice.
export async function putTurns(db: Db, session: Session, turns: (Turn & { embedding?: number[] | null })[], cjk: boolean) {
  if (!turns.length) return
  await db.query('begin')
  try {
    const first = Math.min(...turns.map(t => t.at)), last = Math.max(...turns.map(t => t.at))
    await db.query(
      `insert into sessions (id, scope, team_id, owner_account, owner_name, title, started_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do update set title = coalesce(excluded.title, sessions.title),
         started_at = least(sessions.started_at, excluded.started_at), updated_at = greatest(sessions.updated_at, excluded.updated_at)`,
      [session.id, session.scope, session.team ?? null, session.owner?.account ?? null, session.owner?.name ?? '', session.title ?? null, ms(first), ms(last)],
    )
    for (const t of turns) {
      await db.query(
        `insert into turns (session_id, turn_id, scope, at, author_name, author_account, author_role, prompt, reply, tools, tsv_simple, tsv_cjk, embedding)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           setweight(to_tsvector('simple', $11), 'A') || setweight(to_tsvector('simple', $12), 'B'),
           ${cjk ? `to_tsvector('${CJK_CONFIG}', $8 || E'\\n' || $9)` : 'null'}, $13)
         on conflict (session_id, turn_id) do update set at = excluded.at, author_name = excluded.author_name,
           author_account = excluded.author_account, author_role = excluded.author_role, prompt = excluded.prompt,
           reply = excluded.reply, tools = excluded.tools, tsv_simple = excluded.tsv_simple, tsv_cjk = excluded.tsv_cjk,
           embedding = coalesce(excluded.embedding, turns.embedding)`,
        [session.id, t.turnId, session.scope, ms(t.at), t.author?.name ?? '', t.author?.account ?? null, t.author?.role ?? 'unknown', t.prompt, t.reply, t.tools ?? [], grams(t.prompt), grams(t.reply), vec(t.embedding)],
      )
    }
    await db.query('update sessions set turn_count = (select count(*) from turns where session_id = $1) where id = $1', [session.id])
    await db.query('commit')
  } catch (error) {
    await db.query('rollback').catch(() => {})
    throw error
  }
}

// The keyword half of a search, as a CTE named kw over $1 (scopes) and the
// filters' parameters, ranked from 1; null when the query has nothing to match.
function keywordPart(query: string, cjk: boolean, params: unknown[], filters: string): string | null {
  if (cjk) {
    params.push(query)
    return `kw as (
      select session_id, turn_id, rank() over (order by s, at desc) as r from (
        select session_id, turn_id, at, tsv_cjk <@> to_bm25query(to_tsvector('${CJK_CONFIG}', $${params.length}), 'turns_bm25') as s
        from turns where scope = any($1)${filters}) z
      where s < 0 order by s, at desc limit ${CANDIDATES})`
  }
  const words = queryWords(query)
  if (!words.length) return null
  const parts = words.map(w => {
    params.push('prefix' in w ? w.prefix : w.phrase)
    return 'prefix' in w ? `to_tsquery('simple', quote_literal($${params.length}) || ':*')` : `phraseto_tsquery('simple', $${params.length})`
  })
  return `kw as (
    select session_id, turn_id, rank() over (order by ts_rank_cd(tsv_simple, q) desc, at desc) as r
    from turns, (select ${parts.join(' && ')}) as qq(q)
    where scope = any($1) and tsv_simple @@ q${filters}
    order by r limit ${CANDIDATES})`
}

// Hits newest-first among equals: the session, the turn, who asked, when,
// the prompt's start and a piece of the turn around the first word found.
// `keywords`: 'bm25' (Lakebase, where there) or 'bigram'; `mode`: 'hybrid',
// 'keyword' or 'semantic'.
export async function search(db: Db, scopes: string[], opts: SearchOptions = {}) {
  const { query, embedding, since, person, limit = 20, mode = 'hybrid', keywords } = opts
  const cjk = keywords ? keywords === 'bm25' : await hasCjk(db)
  const params: unknown[] = [scopes]
  let filters = ''
  if (since) { params.push(ms(since)); filters += ` and at >= $${params.length}` }
  if (person) { params.push(person); filters += ` and (author_name = $${params.length} or author_account = $${params.length})` }
  const parts: string[] = []
  if (mode !== 'semantic' && query) {
    const kw = keywordPart(query, cjk, params, filters)
    if (kw) parts.push(kw)
  }
  if (mode !== 'keyword' && embedding) {
    params.push(vec(embedding))
    parts.push(`vec as (
      select session_id, turn_id, rank() over (order by d) as r from (
        select session_id, turn_id, embedding <=> $${params.length}::vector as d
        from turns where scope = any($1) and embedding is not null${filters}
        order by d limit ${CANDIDATES}) z
      where d < ${MAX_DISTANCE})`)
  }
  if (!parts.length) return []
  const names = parts.map(p => p.slice(0, p.indexOf(' ')))
  params.push(Math.min(Math.max(1, limit), 50))
  const { rows } = await db.query(
    `with ${parts.join(',\n')},
     fused as (
       select session_id, turn_id, sum(1.0 / (60 + r)) as score, array_agg(src) as found
       from (${names.map(n => `select session_id, turn_id, r, '${n}' as src from ${n}`).join(' union all ')}) x
       group by session_id, turn_id)
     select t.session_id, t.turn_id, t.at, t.author_name, t.author_account, t.author_role, s.title, t.prompt, t.reply, f.score, f.found
     from fused f join turns t using (session_id, turn_id) join sessions s on s.id = t.session_id
     order by f.score desc, t.at desc limit $${params.length}`,
    params,
  )
  return rows.map(r => ({
    session: r.session_id,
    turn: r.turn_id,
    at: new Date(r.at).toISOString(),
    who: by(r),
    title: r.title,
    prompt: r.prompt.slice(0, 200),
    snippet: snippet(`${r.prompt}\n\n${r.reply}`, query),
    found: r.found,
    score: Number(r.score),
  }))
}

export function snippet(text: string, query: string | undefined, width = 300) {
  const flat = text.replace(/\s+/g, ' ')
  const words = String(query ?? '').trim().split(/\s+/).filter(Boolean)
  const lower = flat.toLowerCase()
  const at = words.map(w => lower.indexOf(w.toLowerCase())).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0
  const from = Math.max(0, at - width / 3)
  return `${from > 0 ? '…' : ''}${flat.slice(from, from + width)}${from + width < flat.length ? '…' : ''}`
}

export async function getTurn(db: Db, scopes: string[], session: string, turn: string) {
  const { rows } = await db.query(
    `select t.session_id, t.turn_id, t.at, t.author_name, t.author_account, t.author_role, t.prompt, t.reply, t.tools, s.title, s.owner_name, s.owner_account
     from turns t join sessions s on s.id = t.session_id
     where t.session_id = $2 and t.turn_id = $3 and t.scope = any($1)`,
    [scopes, session, turn],
  )
  const r = rows[0]
  return r ? { session: r.session_id, turn: r.turn_id, title: r.title, at: new Date(r.at).toISOString(), who: by(r), sharedBy: { name: r.owner_name, account: r.owner_account }, prompt: r.prompt, reply: r.reply, tools: r.tools } : null
}

export async function getSession(db: Db, scopes: string[], session: string) {
  const { rows: [s] } = await db.query('select * from sessions where id = $2 and scope = any($1)', [scopes, session])
  if (!s) return null
  const { rows } = await db.query(`select turn_id, at, author_name, author_account, author_role, left(prompt, 200) as prompt, tools from turns where session_id = $1 order by at, turn_id`, [session])
  return {
    session: s.id, scope: s.scope, title: s.title, sharedBy: { name: s.owner_name, account: s.owner_account }, started: new Date(s.started_at).toISOString(), updated: new Date(s.updated_at).toISOString(),
    turns: rows.map(r => ({ turn: r.turn_id, at: new Date(r.at).toISOString(), who: by(r), prompt: r.prompt, tools: r.tools })),
  }
}

export async function listSessions(db: Db, scopes: string[], opts: ListOptions = {}) {
  const { since, before, limit = 50 } = opts
  const params: unknown[] = [scopes, Math.min(Math.max(1, limit), 50)]
  let filters = ''
  if (since) { params.push(ms(since)); filters += ` and updated_at >= $${params.length}` }
  if (before) { params.push(ms(before)); filters += ` and updated_at < $${params.length}` }
  const { rows } = await db.query(`select id, scope, title, owner_name, owner_account, started_at, updated_at, turn_count from sessions where scope = any($1)${filters} order by updated_at desc limit $2`, params)
  return rows.map(r => ({ session: r.id, scope: r.scope, title: r.title, sharedBy: { name: r.owner_name, account: r.owner_account }, started: new Date(r.started_at).toISOString(), updated: new Date(r.updated_at).toISOString(), turns: r.turn_count }))
}
