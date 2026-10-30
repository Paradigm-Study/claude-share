// Live: each team's shared sessions as the plugin's Team panel lists them,
// asked again every 10 s. Join opens it in a new Claude Desktop session.
import { useQuery } from '@tanstack/react-query'
import { getLive, joinLink } from './api.ts'
import type { LiveSession } from './api.ts'

const POLL_MS = 10_000

function ago(at: number, now: number) {
  const m = Math.max(0, Math.round((now - at) / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} h` : `${Math.round(h / 24)} d`
}

export function LivePage() {
  const live = useQuery({ queryKey: ['live'], queryFn: getLive, refetchInterval: POLL_MS })
  if (live.isPending) return <p className="quiet">Loading…</p>
  if (live.error) return <p className="error">{live.error.message}</p>
  const { teams } = live.data
  if (!teams.length)
    return (
      <p className="quiet">
        You're in no team yet. In Claude Code, press <b>Team</b> above the prompt (or type <code>/team</code>) to make one or join one.
      </p>
    )
  const now = Date.now()
  return (
    <>
      {teams.map(team => (
        <section key={team.id} className="team">
          <h2>{team.name}</h2>
          {team.sessions.length ? (
            <ul className="rows">
              {team.sessions.map(s => (
                <Row key={s.id} s={s} now={now} />
              ))}
            </ul>
          ) : (
            <p className="quiet">Nothing shared with {team.name} right now.</p>
          )}
        </section>
      ))}
      <p className="quiet small">Updated every 10 seconds.</p>
    </>
  )
}

function Row({ s, now }: { s: LiveSession; now: number }) {
  const others = s.people.filter(n => n !== s.host)
  const facts = [
    s.mine ? 'You' : s.host,
    s.hostOnline ? ago(s.createdAt, now) : 'away',
    others.length ? `with ${others.join(', ')}` : '',
    s.inIt ? "you're in it" : '',
  ]
  return (
    <li className={s.hostOnline ? 'row' : 'row away'}>
      <div className="what">
        <span className="title">{s.title || 'Untitled session'}</span>
        <span className="facts">{facts.filter(Boolean).join(' · ')}</span>
      </div>
      {s.hostOnline && !s.mine && !s.inIt ? (
        <a className="btn-primary" href={joinLink(s.url)}>
          Join
        </a>
      ) : null}
    </li>
  )
}
