// The server's modules under Node: `cloudflare:workers` is workerd's own,
// and Node 20 doesn't strip TypeScript's types. So the suites that load
// anything of server/ import this first, and load the server with import()
// after it: this answers that import with cloudflare-workers.mjs, and strips
// the types where Node doesn't (cloudflare-hooks.mjs).
import { register } from 'node:module'

register('./cloudflare-hooks.mjs', import.meta.url)
