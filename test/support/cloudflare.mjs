// The server's modules under Node: `cloudflare:workers` is workerd's own, so
// the suites that load anything of server/ import this first, and load the
// server with import() after it: this answers that import with
// cloudflare-workers.mjs. Node (22.18+) strips the server's types itself.
import { registerHooks } from 'node:module'

const WORKERS = new URL('./cloudflare-workers.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: WORKERS, shortCircuit: true }
    return next(specifier, context)
  },
})
