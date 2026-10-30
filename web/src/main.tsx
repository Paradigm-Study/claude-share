// The dashboard: Live (the teams' sessions, every 10 s) and Search (the
// traces this person may read), behind a sign-in. TanStack Router routes it
// under /app; TanStack Query fetches, polls and caches.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { Shell } from './shell.tsx'
import { LivePage } from './live.tsx'
import { SearchPage } from './search.tsx'
import { ApiError } from './api.ts'
import './styles.css'

const queries = new QueryClient({
  defaultOptions: {
    // Signed out is an answer, not a failure to try again.
    queries: { retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2, refetchOnWindowFocus: true },
  },
})

const root = createRootRoute({ component: Shell })
const live = createRoute({ getParentRoute: () => root, path: '/', component: LivePage })
const searchRoute = createRoute({ getParentRoute: () => root, path: '/search', component: SearchPage })
const router = createRouter({ routeTree: root.addChildren([live, searchRoute]), basepath: '/app' })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queries}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
