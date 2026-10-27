// The suites in test/ (npm test). Each file runs in a process of its own
// (forks): the suites spawn children, change process.env and intercept
// fetch. `cloudflare:workers` is workerd's own module; under Node the
// server's imports of it get the stand-in in test/support.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The suites that start the Workers under wrangler dev (startWorkerd): a
// test there waits on real Workers, and on a loaded machine one of teams'
// takes past 30 s, so these have minutes. A suite that starts them goes here.
const WORKERD = ['test/peer.test.ts', 'test/teams.test.ts', 'test/traces.test.ts', 'test/cloud.test.ts', 'test/tcp-worker.test.ts']

export default defineConfig({
  resolve: {
    alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/support/cloudflare-workers.ts', import.meta.url)) },
  },
  test: {
    pool: 'forks',
    teardownTimeout: 10_000,
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: WORKERD, testTimeout: 30_000, hookTimeout: 30_000 } },
      { extends: true, test: { name: 'workerd', include: WORKERD, testTimeout: 120_000, hookTimeout: 90_000 } },
    ],
  },
})
