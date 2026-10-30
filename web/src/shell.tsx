// Around every page: who's signed in, the two tabs and Sign out; or, signed
// out, the sign-in.
import { Link, Outlet } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, getMe, signOut, startSignIn } from './api.ts'

export function Shell() {
  const me = useQuery({ queryKey: ['me'], queryFn: getMe })
  const client = useQueryClient()
  const out = useMutation({ mutationFn: signOut, onSettled: () => client.resetQueries() })
  const signedOut = me.error instanceof ApiError && me.error.status === 401
  return (
    <div className="wrap">
      <header className="nav">
        <a className="brand" href="/">
          <span className="word">Shared Sessions</span>
          <span className="sub">Dashboard</span>
        </a>
        {me.data ? (
          <div className="who">
            <span>{me.data.account.name}</span>
            <button type="button" className="btn-ghost" onClick={() => out.mutate()} disabled={out.isPending}>
              Sign out
            </button>
          </div>
        ) : null}
      </header>
      {me.data ? (
        <>
          <nav className="tabs">
            <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: 'on' }}>
              Live
            </Link>
            <Link to="/search" activeProps={{ className: 'on' }}>
              Search
            </Link>
          </nav>
          <main>
            <Outlet />
          </main>
        </>
      ) : signedOut ? (
        <SignIn />
      ) : me.isPending ? (
        <p className="quiet">Loading…</p>
      ) : (
        <p className="error">{me.error?.message ?? 'The server did not answer.'}</p>
      )}
    </div>
  )
}

// A fresh sign-in each time this shows: the code the sign-in page will
// show too, and a link a provider. Continue there brings the browser back.
function SignIn() {
  const start = useQuery({ queryKey: ['signin'], queryFn: startSignIn, staleTime: 5 * 60_000, refetchOnWindowFocus: false })
  const failed = new URLSearchParams(location.search).get('signin') === 'failed'
  return (
    <main className="card">
      <p className="eyebrow">Sign in</p>
      <h1>Your teams' sessions</h1>
      <p>See which of your teams' sessions are live, join them in Claude Code, and search what your teams asked and Claude answered.</p>
      {failed ? <p className="error">That sign-in didn't finish here. Start again below.</p> : null}
      {start.data ? (
        start.data.providers.length ? (
          <>
            <p>
              The sign-in page shows the code <b className="code">{start.data.code}</b>. Press Continue there only if it matches.
            </p>
            <p className="cta">
              {start.data.providers.map(p => (
                <a key={p.id} className="btn-primary" href={p.href}>
                  Sign in with {p.label}
                </a>
              ))}
            </p>
          </>
        ) : (
          <p>This server has no sign-in set up.</p>
        )
      ) : start.error ? (
        <p className="error">{start.error.message}</p>
      ) : (
        <p className="quiet">Loading…</p>
      )}
    </main>
  )
}
