// The cloud host under Node (docs/cloud-host.md): one Docker container of the
// runner image (cloud/Dockerfile) a room, its control port published on
// loopback alone, what Cloudflare's HostContainer does with a container.
// node.mjs uses it when CLOUD_IMAGE names the image; CLOUD_SERVER_URL is this
// server as the container reaches it (http://host.docker.internal:8787).
//
// The containers live as long as this process knows them: a restart removes
// any it left (their label), since it no longer holds their control keys.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { token, json } from './core.mjs'

const LABEL = 'shared-session-host'
const START_MS = 120_000

const docker = args =>
  new Promise((resolve, reject) =>
    execFile('docker', args, { timeout: START_MS, maxBuffer: 1024 * 1024 }, (error, out, err) =>
      error ? reject(new Error(String(err || error.message).trim().split('\n').pop())) : resolve(String(out).trim()),
    ),
  )
const sleep = ms => new Promise(r => setTimeout(r, ms))
const same = (a, b) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function dockerCloud({ image, serverUrl }) {
  const hosts = new Map() // room id → { name, port, key, ticket }
  const control = (h, path, init = {}) =>
    fetch(`http://127.0.0.1:${h.port}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${h.key}` } })
  // Whatever an earlier run of this server left.
  void docker(['ps', '-aq', '--filter', `label=${LABEL}`])
    .then(ids => (ids ? docker(['rm', '-f', ...ids.split('\n')]) : null))
    .catch(() => {})

  const cloud = {
    async start(id, { ticket, config }) {
      await cloud.stop(id)
      const key = token(32)
      const name = `ss-host-${id}`
      // The control key to the container through a private file, never argv.
      const dir = mkdtempSync(join(tmpdir(), 'ss-host-'))
      try {
        const envFile = join(dir, 'env')
        writeFileSync(envFile, `SS_CONTROL_KEY=${key}\n`, { mode: 0o600 })
        await docker(['run', '-d', '--name', name, '--label', LABEL, '--env-file', envFile, '-p', '127.0.0.1::8080', '--add-host', 'host.docker.internal:host-gateway', image])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      const port = Number((await docker(['port', name, '8080/tcp'])).split('\n')[0].split(':').pop())
      const h = { name, port, key, ticket }
      hosts.set(id, h)
      const until = Date.now() + START_MS
      while (!(await control(h, '/health').then(r => r.ok, () => false))) {
        if (Date.now() > until) {
          await cloud.stop(id)
          throw new Error("the container didn't come up")
        }
        await sleep(500)
      }
      const started = await control(h, '/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...config, server: serverUrl ?? config.server }),
      })
      if (!started.ok) {
        const why = (await started.json().catch(() => null))?.error ?? `status ${started.status}`
        await cloud.stop(id)
        throw new Error(`the runner refused its configuration (${why})`)
      }
    },

    // PUT cloud/bundle: the packed session, as it comes, against the room's ticket, once.
    async bundle(id, req) {
      const h = hosts.get(id)
      if (!h?.ticket || !same(req.headers.get('authorization') ?? '', `Bearer ${h.ticket}`)) return json({ error: 'Not a member of this session.' }, 401)
      h.ticket = null
      const res = await control(h, '/bundle', { method: 'PUT', body: req.body, duplex: 'half' })
      return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } })
    },

    async stop(id) {
      const h = hosts.get(id)
      if (!h) return new Uint8Array()
      hosts.delete(id)
      let diff = new Uint8Array()
      try {
        const res = await control(h, '/stop', { method: 'POST' })
        if (res.ok) diff = new Uint8Array(await res.arrayBuffer())
      } catch {}
      await docker(['rm', '-f', h.name]).catch(() => {})
      return diff
    },
  }
  return cloud
}
