#!/usr/bin/env node
// The cloud host's image (cloud/Dockerfile, docs/cloud-host.md), built for
// Cloudflare's x86 machines, pushed to this Cloudflare account's registry,
// and named in wrangler.toml, so deploying needs no Docker. Its tag is a hash
// of the Dockerfile and the runner: run this after changing either (the
// plugin itself the runner takes from GitHub at the server's version, so a
// release doesn't need a new image). Needs Docker with buildx, and wrangler
// signed in to the account the server deploys to.
//
//   node scripts/push-image.ts
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const imageTag = (root = ROOT) =>
  `r-${createHash('sha256')
    .update(readFileSync(join(root, 'cloud/Dockerfile')))
    .update(readFileSync(join(root, 'cloud/runner.mjs')))
    .digest('hex')
    .slice(0, 10)}`

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tag = `claude-share-host:${imageTag()}`
  const run = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 }).toString()
  console.log(`building ${tag} for linux/amd64`)
  run('docker', ['buildx', 'build', '--platform', 'linux/amd64', '-f', 'cloud/Dockerfile', '-t', tag, '--load', '.'])
  console.log('pushing it to the account’s registry')
  const pushed = /Pushed image: (registry\.cloudflare\.com\/[0-9a-f]{32}\/\S+)/.exec(run('npx', ['-y', 'wrangler@4', 'containers', 'push', tag]))?.[1]
  if (!pushed) throw new Error("wrangler didn't say where it pushed the image")
  const config = join(ROOT, 'wrangler.toml')
  const before = readFileSync(config, 'utf8')
  const after = before.replace(/^image = ".*"$/m, `image = "${pushed}"`)
  if (after === before && !before.includes(`image = "${pushed}"`)) throw new Error('wrangler.toml has no image line to update')
  writeFileSync(config, after)
  console.log(`wrangler.toml now names ${pushed}`)
}
