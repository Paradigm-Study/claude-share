// The suites in test/ (npm test). Each file runs in a process of its own
// (forks): the suites spawn children, change process.env and intercept
// fetch. `cloudflare:workers` is workerd's own module; under Node the
// server's imports of it get the stand-in in test/support.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/support/cloudflare-workers.mjs', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 90_000,
    teardownTimeout: 10_000,
  },
})
