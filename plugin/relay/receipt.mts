#!/usr/bin/env node
// A delivery receipt into a session on this computer: what became of a
// message it sent, as Claude Code's own receipt says it. A guest runs one for
// each receipt the host's session sends back for a message one of this
// person's sessions wrote (the host's session held it, released it, dropped
// it); the host's mailboxes' helper (mailbox.mts) writes the same lines. One
// line to the session's socket, half-closed, within two seconds; it never
// listens. Node 22.18+ (its types are stripped as it loads), macOS and Linux.
//
// Claude Code's messaging is undocumented: a receipt is a control line
// (`peer_message_status`) a session sends whoever wrote it a message, naming
// that message's msg_id (`orig_msg_id`). The sender takes any line naming a
// message it sent and is still waiting on, whoever wrote it, and tells its
// Claude: held (another permission mode class: its person must let it in),
// then released, denied or expired; or refused, or dropped and why. Claude
// Code itself writes `refused` as `expired` with `status_detail`.
// stdin: { path, status, from, ref, reason? }. Stdout: one short line.

import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export type Status = 'held' | 'denied' | 'delivered' | 'expired' | 'refused' | 'dropped'
export type Receipt = { status: string; from: unknown; ref: unknown; reason?: string }

export const STATUS = new Set(['held', 'denied', 'delivered', 'expired', 'refused', 'dropped'])
export const DROPS = new Set(['rate-limited', 'duplicate', 'hop-loop', 'hop-runaway', 'queue-full'])
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UDS = /^uds:\/[^\0\n"<>]{1,1023}$/
// A Unix socket's path, in bytes (macOS's sun_path is 104 with its NUL).
const PATH_MAX = 103
const WRITE_MS = 2000
// What Claude Code says with each receipt, word for word.
export const REASONS: Readonly<Record<Status, string>> = Object.freeze({
  held: "Your message is held for the recipient user's approval before it reaches their Claude session (permission-mode parity).",
  denied: 'The recipient user declined your message; it was not delivered to their Claude session.',
  expired: "Your held message expired without approval and was not delivered to the recipient's Claude session.",
  delivered: "Your previously-held message was approved and released to the recipient's Claude session.",
  refused: 'The recipient session is not accepting cross-session messages (the feature is off there, or a setting or policy there refuses them); your message was not delivered to its Claude.',
  dropped: "The recipient's session dropped your message at its inbox (rate limit, duplicate, relay loop, or full queue); it was not delivered and will not be.",
})

const failure = (code: string) => Object.assign(new Error('Receipt failed'), { code })

// A receipt as Claude Code writes one, in its order: `from` the session (or
// mailbox) the message went to, `ref` the msg_id the sender gave it.
export function receiptLine({ status, from, ref, reason }: Receipt): string {
  if (!STATUS.has(status) || typeof from !== 'string' || !UDS.test(from) || typeof ref !== 'string' || !UUID.test(ref)) throw failure('INVALID_CONFIG')
  if (reason !== undefined && (status !== 'dropped' || !DROPS.has(reason))) throw failure('INVALID_CONFIG')
  return JSON.stringify({
    type: 'control',
    action: 'peer_message_status',
    ...(status === 'refused' ? { status: 'expired', status_detail: 'refused' } : { status }),
    reason: REASONS[status as Status],
    from,
    orig_msg_id: ref,
    ...(reason ? { drop_reason: reason } : {}),
    msgV: 1,
    msg_id: randomUUID(),
  })
}

// A path a frame may go to: absolute, short enough for a socket, and a
// socket now (never a file, a symlink, or what isn't there).
export function socketPath(file: unknown): boolean {
  if (typeof file !== 'string' || !path.isAbsolute(file) || Buffer.byteLength(file) > PATH_MAX || /[\0\n]/.test(file)) return false
  try { return fs.lstatSync(file).isSocket() } catch { return false }
}

// One line into the socket at `file`, half-closed: true once it's written.
export function writeLine(file: string, line: string, ms = WRITE_MS): Promise<boolean> {
  if (!socketPath(file)) return Promise.resolve(false)
  return new Promise<boolean>(resolve => {
    const s = net.createConnection({ path: file })
    let done = false
    const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); resolve(ok) }
    const timer = setTimeout(() => finish(false), ms)
    s.once('error', () => finish(false))
    s.once('connect', () => s.end(`${line}\n`, () => finish(true)))
    s.resume()
  })
}

export function configOf(cfg: any): { path: string; line: string } {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw failure('INVALID_CONFIG')
  const keys = Object.keys(cfg).sort().join(',')
  if (keys !== 'from,path,ref,status' && keys !== 'from,path,reason,ref,status') throw failure('INVALID_CONFIG')
  const line = receiptLine(cfg)
  if (typeof cfg.path !== 'string' || !path.isAbsolute(cfg.path) || Buffer.byteLength(cfg.path) > PATH_MAX || /[\0\n]/.test(cfg.path)) throw failure('INVALID_CONFIG')
  return { path: cfg.path, line }
}

function main() {
  const say = (row: Record<string, unknown>) => { try { process.stdout.write(`${JSON.stringify(row)}\n`) } catch {} }
  process.stdout.on('error', () => {})
  if (process.platform !== 'darwin' && process.platform !== 'linux') { say({ state: 'error', code: 'UNSUPPORTED' }); process.exitCode = 1; return }
  let input = '', tooLarge = false
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (data: string) => { if ((input += data).length > 16_384) { tooLarge = true; input = '' } })
  process.stdin.on('error', () => { tooLarge = true })
  // Its work is a promise that never rejects; the stream's listener doesn't wait for it.
  process.stdin.on('end', () => void (async () => {
    let cfg: { path: string; line: string }
    try { if (tooLarge) throw failure('INVALID_CONFIG'); cfg = configOf(JSON.parse(input)) } catch { say({ state: 'error', code: 'INVALID_CONFIG' }); process.exitCode = 1; return }
    const sent = await writeLine(cfg.path, cfg.line)
    say(sent ? { state: 'sent' } : { state: 'error', code: 'CONNECT' })
    process.exitCode = sent ? 0 : 1
  })())
  // Bounded whatever happens: a session that never reads gets nothing more.
  setTimeout(() => { say({ state: 'error', code: 'TIMEOUT' }); process.exit(1) }, WRITE_MS + 500).unref()
}

if (import.meta.main) main()
