// The room server as it runs on Cloudflare, here: the main Worker and the
// preview Worker under `wrangler dev` (workerd, real Durable Objects, real
// WebSocket hibernation, the rate limit bindings simulated). Two processes,
// since `wrangler dev` serves only its first Worker on a port; the preview
// Worker reaches the main one's RoomObject through wrangler's dev registry.
//
// The configs are wrangler.toml and wrangler.preview.toml with what needs a
// Cloudflare login left out (the cloud host's container image, kept in the
// account's registry), so this runs without an account, as CI does.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WRANGLER = join(ROOT, 'node_modules/wrangler/bin/wrangler.js')
// wrangler needs Node 22+. The suites run on Node 20 too (the relay helpers
// promise it), so WRANGLER_NODE names a newer Node for wrangler alone.
const WRANGLER_NODE = process.env.WRANGLER_NODE || process.execPath

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

// A config's text with `main` made absolute (the config is written elsewhere)
// and its [[containers]] block left out, or (`containers`) its image built
// here from cloud/Dockerfile, which needs Docker and no account.
function forTest(text, containers = false) {
  const lines = []
  let skipping = false
  for (const line of text.split('\n')) {
    if (/^\[\[containers\]\]/.test(line)) skipping = !containers
    else if (skipping && /^\[/.test(line)) skipping = false
    if (skipping) continue
    if (/^image = /.test(line)) { lines.push(`image = ${JSON.stringify(join(ROOT, 'cloud/Dockerfile'))}`, `image_build_context = ${JSON.stringify(ROOT)}`); continue }
    lines.push(line.replace(/^main = "(.+)"$/, (_, path) => `main = ${JSON.stringify(join(ROOT, path))}`))
  }
  return lines.join('\n')
}

async function ready(origin, child, logs, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited: ${logs()}`)
    if (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }).then(r => r.status > 0, () => false)) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`wrangler dev did not answer within ${ms} ms: ${logs()}`)
}

// Starts both Workers, on free ports unless `port` and `previewPort` say. `vars` are added to both (AUTH_TEST, PUBLIC_URL…), or
// made from the ports when a function (a PREVIEW_URL that names the port).
// `restart()` stops and starts them again on the same ports and storage, as a
// deploy or an eviction would; `stop()` ends them and deletes their storage.
function checkTools() {
  if (!existsSync(WRANGLER)) throw new Error('wrangler is not installed: run npm install first')
  if (WRANGLER_NODE === process.execPath && Number(process.versions.node.split('.')[0]) < 22) throw new Error(`wrangler needs Node 22 or newer (this is ${process.version}): set WRANGLER_NODE to one`)
}

export async function startWorkerd({ vars = {}, quiet = true, containers = false, port: fixedPort, previewPort: fixedPreview } = {}) {
  checkTools()
  const dir = await mkdtemp(join(tmpdir(), 'share-workerd-'))
  const mainConfig = join(dir, 'main.toml'), previewConfig = join(dir, 'preview.toml')
  await writeFile(mainConfig, `${forTest(await readFile(join(ROOT, 'wrangler.toml'), 'utf8'), containers)}`)
  await writeFile(previewConfig, forTest(await readFile(join(ROOT, 'wrangler.preview.toml'), 'utf8')))
  const port = fixedPort ?? await freePort()
  let previewPort = fixedPreview ?? await freePort()
  while (previewPort === port) previewPort = await freePort()
  const origin = `http://127.0.0.1:${port}`, previewOrigin = `http://127.0.0.1:${previewPort}`
  const all = { PREVIEW_URL: previewOrigin, ...(typeof vars === 'function' ? vars({ port, previewPort }) : vars) }
  let output = ''
  let children = []
  const logs = () => output.slice(-4000)
  const run = (config, p) => {
    const args = ['dev', '-c', config, '--ip', '127.0.0.1', '--port', String(p), '--inspector-port', '0',
      '--persist-to', join(dir, 'state'), '--show-interactive-dev-session=false', '--log-level', quiet ? 'warn' : 'log',
      ...Object.entries(all).flatMap(([k, v]) => ['--var', `${k}:${v}`])]
    const child = spawn(WRANGLER_NODE, [WRANGLER, ...args], { cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', b => { output += b })
    child.stderr.on('data', b => { output += b })
    return child
  }
  const start = async () => {
    // The main Worker first: the preview Worker's ROOMS binding names its RoomObject.
    const main = run(mainConfig, port)
    children = [main]
    await ready(origin, main, logs, containers ? 600_000 : 30_000)
    const preview = run(previewConfig, previewPort)
    children.push(preview)
    await ready(previewOrigin, preview, logs, 30_000)
  }
  const halt = async () => {
    await Promise.all(children.map(child => child.exitCode !== null ? null : new Promise(resolve => {
      child.once('exit', resolve)
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    })))
    children = []
  }
  await start()
  return {
    origin,
    previewOrigin,
    port,
    previewPort,
    logs,
    async restart() { await halt(); await start() },
    async stop() { await halt(); await rm(dir, { recursive: true, force: true }) },
  }
}
