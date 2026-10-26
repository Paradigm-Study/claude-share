// The Worker's module under Node: `cloudflare:workers` is workerd's own, so
// the suites that load server/worker.mjs import this first, and load the
// Worker with import() after it: this answers that import with
// cloudflare-workers.mjs.
import { register } from 'node:module'

register('./cloudflare-hooks.mjs', import.meta.url)
