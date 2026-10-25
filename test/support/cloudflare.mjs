// The Worker's module under Node: `cloudflare:workers` is workerd's own, so
// the suites that load server/worker.mjs start with this (node --import),
// which answers that import with cloudflare-workers.mjs below.
import { register } from 'node:module'

register('./cloudflare-hooks.mjs', import.meta.url)
