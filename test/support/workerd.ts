// The room server as it runs on Cloudflare, here: the main Worker and the
// preview Worker under `wrangler dev` (workerd, real Durable Objects, real
// WebSocket hibernation, the rate limit bindings simulated). Two processes,
// since `wrangler dev` serves only its first Worker on a port; the preview
// Worker reaches the main one's RoomObject through wrangler's dev registry.
// That registry is this run's own (WRANGLER_REGISTRY_PATH, in its folder):
// wrangler's default is one per machine, where Workers find each other by
// name, so two runs at once (two suites, two sessions) would reach each
// other's Workers, which have the same names.
//
// The configs are wrangler.toml and wrangler.preview.toml with what needs a
// Cloudflare login left out (the cloud host's container image, kept in the
// account's registry), so this runs without an account, as CI does.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WRANGLER = join(ROOT, 'node_modules/wrangler/bin/wrangler.js')

export function freePort() {
  return new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo
      s.close(() => resolve(port))
    })
  })
}

// A config's text with `main` made absolute (the config is written elsewhere)
// and its [[containers]] block left out, or (`containers`) its image built
// here from cloud/Dockerfile, which needs Docker and no account.
function forTest(text: string, containers = false) {
  const lines = []
  let skipping = false
  for (const line of text.split('\n')) {
    if (line.startsWith('[[containers]]')) skipping = !containers
    else if (skipping && line.startsWith('[')) skipping = false
    if (skipping) continue
    if (line.startsWith('image = ')) {
      lines.push(`image = ${JSON.stringify(join(ROOT, 'cloud/Dockerfile'))}`, `image_build_context = ${JSON.stringify(ROOT)}`)
      continue
    }
    lines.push(line.replace(/^main = "(.+)"$/, (_: string, path: string) => `main = ${JSON.stringify(join(ROOT, path))}`))
  }
  return lines.join('\n')
}

async function ready(origin: string, child: ChildProcess, logs: () => string, ms: number) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited: ${logs()}`)
    if (
      await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }).then(
        r => r.status > 0,
        () => false,
      )
    )
      return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`wrangler dev did not answer within ${ms} ms: ${logs()}`)
}

// Starts both Workers, on free ports unless `port` and `previewPort` say. `extra` is TOML added to the main Worker's config (a binding). `vars` are added to both (AUTH_TEST, PUBLIC_URL…), or
// made from the ports when a function (a PREVIEW_URL that names the port).
// `restart()` stops and starts them again on the same ports and storage, as a
// deploy or an eviction would; `stop()` ends them and deletes their storage.
function checkTools() {
  if (!existsSync(WRANGLER)) throw new Error('wrangler is not installed: run npm install first')
}

// The two Workers, running: where they answer, their output, and a restart or stop.
export type Workerd = {
  origin: string
  previewOrigin: string
  port: number
  previewPort: number
  logs(): string
  restart(): Promise<void>
  stop(): Promise<void>
}
type Vars = Record<string, string>
export async function startWorkerd({
  vars = {},
  quiet = true,
  containers = false,
  port: fixedPort,
  previewPort: fixedPreview,
  extra = '',
}: {
  vars?: Vars | ((ports: { port: number; previewPort: number }) => Vars)
  quiet?: boolean
  containers?: boolean
  port?: number
  previewPort?: number
  extra?: string
} = {}): Promise<Workerd> {
  checkTools()
  const dir = await mkdtemp(join(tmpdir(), 'share-workerd-'))
  const mainConfig = join(dir, 'main.toml'),
    previewConfig = join(dir, 'preview.toml')
  await writeFile(mainConfig, `${forTest(await readFile(join(ROOT, 'wrangler.toml'), 'utf8'), containers)}\n${extra}\n`)
  await writeFile(previewConfig, forTest(await readFile(join(ROOT, 'wrangler.preview.toml'), 'utf8')))
  const port = fixedPort ?? (await freePort())
  let previewPort = fixedPreview ?? (await freePort())
  while (previewPort === port) previewPort = await freePort()
  const origin = `http://127.0.0.1:${port}`,
    previewOrigin = `http://127.0.0.1:${previewPort}`
  const all = { PREVIEW_URL: previewOrigin, ...(typeof vars === 'function' ? vars({ port, previewPort }) : vars) }
  let output = ''
  let children: ChildProcess[] = []
  const logs = () => output.slice(-4000)
  const run = (config: string, p: number) => {
    const args = [
      'dev',
      '-c',
      config,
      '--ip',
      '127.0.0.1',
      '--port',
      String(p),
      '--inspector-port',
      '0',
      '--persist-to',
      join(dir, 'state'),
      '--show-interactive-dev-session=false',
      '--log-level',
      quiet ? 'warn' : 'log',
      ...Object.entries(all).flatMap(([k, v]) => ['--var', `${k}:${v}`]),
    ]
    const child = spawn(process.execPath, [WRANGLER, ...args], {
      cwd: dir,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', WRANGLER_REGISTRY_PATH: join(dir, 'registry') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', b => {
      output += b
    })
    child.stderr.on('data', b => {
      output += b
    })
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
    await Promise.all(
      children.map(child =>
        child.exitCode !== null
          ? Promise.resolve()
          : new Promise(resolve => {
              child.once('exit', resolve)
              child.kill('SIGTERM')
              setTimeout(() => child.kill('SIGKILL'), 5000).unref()
            }),
      ),
    )
    children = []
  }
  await start()
  return {
    origin,
    previewOrigin,
    port,
    previewPort,
    logs,
    async restart() {
      await halt()
      await start()
    },
    async stop() {
      await halt()
      await rm(dir, { recursive: true, force: true })
    },
  }
}
