// A shared session's turns, as traces keep them: a person's prompt (a user
// row) and the text Claude wrote after it, until the next prompt, the turn's
// end or the room's. Tool calls give only their names; their inputs and
// results are not searched. Only the host's rows count: a guest's posts never
// reach traces. Each turn says who asked it (`author`: a name, and the
// account behind it when the room can tell, `resolve`).

export type Author = { name: string; account: string | null; role: 'host' | 'guest' | 'unknown' }
export type Turn = { turnId: string; at: number; author: Author; prompt: string; reply: string; tools: string[] }
type RoomEvent = { seq: number; ts: number; type: string; from?: { role?: string; name?: string }; body?: Record<string, unknown> }
type Seat = { name: string; account?: string }
type RoomLike = { team?: { id?: string } | null; host?: { name?: string; account?: string }; seats?: Map<string, Seat>; away?: Map<string, Seat> }

const PROMPT_MAX = 32_000
const REPLY_MAX = 200_000
const TOOLS_MAX = 50

const unknown = (name: string): Author => ({ name, account: null, role: 'unknown' })

export function takeTurns(events: RoomEvent[], open: Turn | null = null, resolve: (name: string) => Author = unknown) {
  const closed: Turn[] = []
  let turn = open
  const close = () => {
    if (turn && (turn.prompt || turn.reply)) closed.push(turn)
    turn = null
  }
  const start = (e: RoomEvent, name: string, prompt: string): Turn => ({
    turnId: String(e.seq),
    at: e.ts,
    author: resolve(name),
    prompt: prompt.slice(0, PROMPT_MAX),
    reply: '',
    tools: [],
  })
  for (const e of events) {
    if (e.from?.role !== 'host') continue
    const body = e.body ?? {}
    if (e.type === 'row' && typeof body.text === 'string') {
      if (body.kind === 'user') {
        close()
        turn = start(e, typeof body.who === 'string' ? body.who : (e.from.name ?? ''), body.text)
      } else if (body.kind === 'assistant' && body.text.trim()) {
        turn ??= start(e, '', '')
        if (turn.reply.length < REPLY_MAX) turn.reply = (turn.reply ? `${turn.reply}\n\n${body.text}` : body.text).slice(0, REPLY_MAX)
      } else if (body.kind === 'tool' && typeof body.tool === 'string' && turn && !turn.tools.includes(body.tool) && turn.tools.length < TOOLS_MAX) {
        turn.tools.push(body.tool)
      }
    } else if ((e.type === 'turn' && body.state === 'end') || e.type === 'ended') {
      close()
    }
  }
  return { closed, open: turn }
}

// Where a room's turns go: its team's traces, else its host's own, else
// nowhere (a share without a sign-in has no one to answer for it).
export function tracesScope(room: RoomLike): string | null {
  if (room.team?.id) return `t:${room.team.id}`
  if (room.host?.account) return `u:${room.host.account}`
  return null
}

// Who a prompt's name is in the room: the host (its account, as the share
// carried it), or the one person seated or away under it. Two accounts under
// one name, or none, leave the account unknown: a name alone is never proof.
export function authorOf(room: RoomLike, name: string): Author {
  if (name && name === room.host?.name) return { name, account: room.host.account ?? null, role: 'host' }
  const seats = [...(room.seats?.values() ?? []), ...(room.away?.values() ?? [])].filter(s => s.name === name)
  const accounts = new Set(seats.map(s => s.account ?? null))
  if (seats.length && accounts.size === 1) return { name, account: [...accounts][0] ?? null, role: 'guest' }
  return { name, account: null, role: seats.length ? 'guest' : 'unknown' }
}
