// What the dashboard reads from its server (server/worker/dash.ts): same
// origin, its cookie alone. A 401 means signed out; the app shows Sign in.

export type Account = { id: string; name: string; login?: string; email?: string; provider?: string }
export type Me = { account: Account; teams: { id: string; name: string; role: string }[]; traces: boolean }
export type LiveSession = {
  id: string
  url: string
  title: string
  host: string
  hostOnline: boolean
  people: string[]
  createdAt: number
  mine: boolean
  inIt: boolean
}
export type Live = { teams: { id: string; name: string; sessions: LiveSession[] }[] }
export type SignIn = { code: string; providers: { id: string; label: string; href: string }[] }
export type Hit = {
  session: string
  turn: string
  at: string
  who: { name: string; account: string | null; role: string }
  title: string | null
  prompt: string
  snippet: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `The server answered ${res.status}.`)
  return data
}

export const getMe = () => call<Me>('/api/dash/me')
export const getLive = () => call<Live>('/api/dash/live')
export const startSignIn = () => call<SignIn>('/api/dash/signin', { method: 'POST', body: {} })
export const signOut = () => call<{ ok: true }>('/api/dash/signout', { method: 'POST', body: {} })
export const search = (query: string, since: string) =>
  call<{ hits: Hit[] }>('/api/dash/search', { method: 'POST', body: { query, since: since || undefined } })

// Join, as the plugin's Join does: a new Claude Desktop session with the link as its message.
export const joinLink = (url: string) => `claude://code/new?q=${encodeURIComponent(url)}`
