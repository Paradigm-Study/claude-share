// Search: the traces this person may read (their own and their teams'), by
// words and meaning, as Claude Code's traces search finds them. Where the
// server keeps no traces, the page says so and asks nothing.
import { useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { getMe, search } from './api.ts'

export function SearchPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: getMe })
  const [query, setQuery] = useState('')
  const [since, setSince] = useState('')
  const find = useMutation({ mutationFn: (q: { query: string; since: string }) => search(q.query, q.since) })
  if (me.data && !me.data.traces)
    return <p className="quiet">This server doesn't keep session traces, so there is nothing to search. Live sessions still show under Live.</p>
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (query.trim()) find.mutate({ query: query.trim(), since })
  }
  return (
    <>
      <form className="search" onSubmit={submit}>
        <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="What was asked or answered" aria-label="Search" autoFocus />
        <select value={since} onChange={e => setSince(e.target.value)} aria-label="Since">
          <option value="">Any time</option>
          <option value="1d">Last day</option>
          <option value="7d">Last week</option>
          <option value="30d">Last month</option>
        </select>
        <button type="submit" className="btn-primary" disabled={find.isPending || !query.trim()}>
          Search
        </button>
      </form>
      {find.error ? <p className="error">{find.error.message}</p> : null}
      {find.data ? (
        find.data.hits.length ? (
          <ul className="hits">
            {find.data.hits.map(h => (
              <li key={`${h.session}/${h.turn}`}>
                <div className="facts">
                  {h.title || 'Untitled session'} · {h.who.name || 'someone'} · {new Date(h.at).toLocaleString()}
                </div>
                <div className="snippet">{h.snippet}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="quiet">Nothing found in the traces you can read.</p>
        )
      ) : null}
    </>
  )
}
