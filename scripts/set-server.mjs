// Bakes your team's share server into the plugin, so nobody configures it:
//   node scripts/set-server.mjs https://claude-share.your-team.workers.dev
import { readFileSync, writeFileSync } from 'node:fs'

const url = process.argv[2]?.replace(/\/+$/, '')
// https, or plain http for a server on this computer alone (as the plugin
// takes it): plain http elsewhere would carry everyone's tokens unencrypted.
const local = /^http:\/\/(?:(?:[a-z0-9-]+\.)*localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i
if (!url || !(/^https:\/\/[^\s/'"]+$/.test(url) || local.test(url))) {
  console.error('usage: node scripts/set-server.mjs https://your-share-server (plain http:// only for a server on this computer)')
  process.exit(1)
}
const path = new URL('../plugin/hooks/server.ts', import.meta.url)
const source = readFileSync(path, 'utf8').replace(/SERVER_URL = '[^']*'/, `SERVER_URL = '${url}'`)
writeFileSync(path, source)
console.log(`Share links will be created on ${url}. Bump plugin/.claude-plugin/plugin.json's version so installs pick it up.`)
