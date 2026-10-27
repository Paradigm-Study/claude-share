#!/usr/bin/env node
// A guest's isolated preview browser uses this loopback-only SOCKS5 proxy.
// Loopback destinations (localhost, *.localhost, 127/8, ::1) reach only the
// tunnel helper routed for that Host port; any other name that points at this
// computer is refused (DNS rebinding: a page's own name turned to loopback
// would read the Host's previews as that page); the Guest's own addresses,
// its local network (private ranges and every on-link subnet) and cloud
// metadata are refused; everything else leaves directly or through the
// person's own upstream proxy (one it can't use is left out, and said once).
// An upstream is only ever given a checked address, never a name: a name is
// looked up over DNS-over-HTTPS through that upstream (its local answer when
// that fails), and each address checked, so the upstream's own lookup can't
// take a refused one. Routes arrive over an authenticated loopback control
// port and live only in memory. stdout carries ports and codes, never names
// or addresses. Node 22.18+ (its types are stripped as it loads).

import net from 'node:net'
import dns from 'node:dns'
import os from 'node:os'
import tls from 'node:tls'
import http from 'node:http'
import { run, controlServer, vacant, portOK, notify, failure, safeCode } from './tcp-relay.mts'
import type { ControlServer } from './tcp-relay.mts'

/** An IP literal, normalized: IPv4 by its bytes, IPv6 by its eight words. */
type Addr = { family: 4 | 6; bytes?: number[]; words?: number[]; key: string }
type Range = [number[], number]
type Subnet = { family: 4 | 6; range: Range; key: string }
type Rules = { all: boolean; suffixes: string[]; ips: Set<string>; subnets: net.BlockList }
type Upstream = { kind: 'http' | 'socks5'; host: string; port: number; bypass: Rules }
type Settings = { port: number; controlToken: string; lan: boolean; upstream: Upstream | null; unusable: boolean }
type Routes = { routes: Map<number, number>; startable: Set<number> }
/** Where a request may go: its kind, and for `outbound` what to dial. */
type Verdict = { kind: string; ip?: Addr | null; host?: string; addresses?: Addr[] | null; tainted?: boolean }
type Answer = { list: Addr[]; ttl: number }
type DohServer = { address: string; port: number; servername: string; path: string; ca?: string }
type Server = DohServer & { ip: Addr }
type Known = { own: Set<string>; onlink4: Range[]; onlink6: Range[] }
/** One client of the proxy, from its greeting to its end. */
type Conn = { client: net.Socket; target: net.Socket | null; timers: Set<NodeJS.Timeout>; done: boolean; spliced: boolean; closed: boolean; holding: boolean; wake: (() => void) | null }
type StartOptions = {
  emit?: (row: Record<string, unknown>) => void; signal?: AbortSignal
  timeouts?: Partial<Record<keyof typeof TIMEOUTS, number>>; limits?: Partial<Record<keyof typeof LIMITS, number>>
  lookup?: (...args: any[]) => void; interfaces?: () => any
  connect?: (options: any) => net.Socket; knock?: (options: any) => net.Socket; doh?: readonly DohServer[]
}

export const LIMITS = Object.freeze({ clients: 512, held: 64, routes: 128, startable: 128, bypass: 64, entry: 253, body: 8192, headers: 8192, line: 8192, controlSockets: 8, upstreamHead: 8192, upstreamTries: 4, stdout: 1 << 20, dohBody: 65_536, dohNames: 256 })
// doh: one name's whole look, every server; dohEach: one server's A and AAAA;
// dohDown: a server that couldn't be reached (and DoH as a whole, when none
// could) is skipped this long, doubling while it stays so, up to dohDownMax;
// dohMiss: a name no server answered in time (slow or bad) goes by its local
// answer this long; dohTTL: the longest an answer is kept.
export const TIMEOUTS = Object.freeze({ handshake: 10_000, firstConfig: 5_000, want: 8_000, wantEvery: 10_000, blockedEvery: 30_000, lanEvery: 30_000, interfaces: 30_000, lookup: 3_000, connect: 15_000, control: 2_000, linger: 2_000, doh: 6_000, dohEach: 2_500, dohDown: 30_000, dohDownMax: 600_000, dohMiss: 30_000, dohTTL: 60_000 })
// DNS-over-HTTPS servers, asked in order through the upstream at these
// addresses (never by name) and checked against their own certificates.
const DOH = Object.freeze([
  { address: '1.1.1.1', port: 443, servername: 'cloudflare-dns.com', path: '/dns-query' },
  { address: '1.0.0.1', port: 443, servername: 'cloudflare-dns.com', path: '/dns-query' },
  { address: '8.8.8.8', port: 443, servername: 'dns.google', path: '/resolve' },
  { address: '8.8.4.4', port: 443, servername: 'dns.google', path: '/resolve' },
].map(Object.freeze)) as readonly DohServer[]
// RFC 1928 replies: general failure, not allowed, host unreachable, refused, command, address type.
const FAILED = 1, NOT_ALLOWED = 2, UNREACHABLE = 4, REFUSED = 5, COMMAND = 7, ADDRESS = 8, NO_METHOD = 0xff
const SUCCESS = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'ETIMEDOUT', 'EADDRNOTAVAIL', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'EAI_NODATA'])
const plain = (value: any): boolean => !!value && typeof value === 'object' && !Array.isArray(value)

// The eight 16-bit words of a strict IPv6 literal (no zone), or null.
function words6(text: string): number[] | null {
  if (!net.isIPv6(text) || text.includes('%')) return null
  let tail: number[] = []
  const dotted = /^(.*:)([0-9.]+)$/.exec(text)
  if (dotted && dotted[2]!.includes('.')) {
    if (!net.isIPv4(dotted[2]!)) return null
    const b = dotted[2]!.split('.').map(Number)
    tail = [b[0]! << 8 | b[1]!, b[2]! << 8 | b[3]!]
    text = dotted[1]!.endsWith('::') ? dotted[1]! : dotted[1]!.slice(0, -1)
  }
  const halves = text.split('::'), groups = (part: string | undefined) => part ? part.split(':') : []
  const head = groups(halves[0]), back = groups(halves[1])
  if (halves.length > 2 || ![...head, ...back].every(group => /^[0-9a-f]{1,4}$/i.test(group))) return null
  const fill = 8 - head.length - back.length - tail.length
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null
  return [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...back].map(group => parseInt(group, 16)).concat(tail)
}
// RFC 5952 text: the longest run of two or more zero words becomes '::'.
function text6(words: number[]): string {
  let at = -1, length = 0
  for (let i = 0; i < 8;) {
    let j = i
    while (j < 8 && !words[j]) j++
    if (j - i > Math.max(1, length)) { at = i; length = j - i }
    i = j === i ? i + 1 : j
  }
  const hex = words.map(word => word.toString(16))
  return at < 0 ? hex.join(':') : `${hex.slice(0, at).join(':')}::${hex.slice(at + length).join(':')}`
}
// A normalized IP literal (IPv4-mapped IPv6 folds to IPv4; brackets allowed), or null.
function address(value: unknown): Addr | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/^\[(.*)\]$/, '$1')
  if (net.isIPv4(text)) return { family: 4, bytes: text.split('.').map(Number), key: text }
  const words = words6(text)
  if (!words) return null
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    const bytes = [words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255]
    return { family: 4, bytes, key: bytes.join('.') }
  }
  return { family: 6, words, key: text6(words) }
}
// Loopback or unspecified: 127/8, 0/8, ::, ::1 and IPv4-compatible forms of those.
const local = (a: Addr) => a.family === 4 ? a.bytes![0] === 127 || a.bytes![0] === 0 : a.words!.slice(0, 6).every(word => word === 0) && [0, 127].includes(a.words![6]! >> 8)
// A lower-case DNS name without its trailing dot, or null.
function hostname(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.toLowerCase().replace(/\.$/, '')
  return name.length && name.length <= 253 && name.split('.').every(label => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label)) ? name : null
}
// A name that ends in a number, as URL parsers put it: its last label is digits
// or 0x-hex. inet_aton reads these as IPv4 (10.1, 012.0.0.1, 0x0a.0.0.1,
// 2130706433, 1.2.3.4. once its dot goes); no real name ends so.
const numeric = (name: string) => /^(?:[0-9]+|0x[0-9a-f]*)$/.test(name.slice(name.lastIndexOf('.') + 1))

// The Guest's own network, never dialled for the window: private ranges and
// on-link subnets (both opened only by `lan: true`), and link-local (cloud
// metadata), IETF protocol assignments (192.0.0.0/24), multicast and reserved.
const PRIVATE4: Range[] = [[[10, 0, 0, 0], 8], [[172, 16, 0, 0], 12], [[192, 168, 0, 0], 16], [[100, 64, 0, 0], 10]]
const SHUT4: Range[] = [[[169, 254, 0, 0], 16], [[192, 0, 0, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4]]
const PRIVATE6: Range[] = [[[0xfc00], 7]]
const SHUT6: Range[] = [[[0xfe80], 10], [[0xfec0], 10], [[0xff00], 8], [[0x64, 0xff9b, 1], 48]]
// Metadata services inside ranges `lan` opens (Alibaba, AWS IPv6), and Azure's.
const METADATA = new Set(['100.100.100.200', 'fd00:ec2::254', '168.63.129.16'])
const v4n = (b: number[]) => (b[0]! << 24 | b[1]! << 16 | b[2]! << 8 | b[3]!) >>> 0
const within4 = (bytes: number[], [base, bits]: Range) => ((v4n(bytes) ^ v4n(base)) >>> (32 - bits)) === 0
function within6(words: number[], [base, bits]: Range) {
  for (let i = 0; bits > 0; i++, bits -= 16) {
    if ((words[i]! ^ (base[i] ?? 0)) & (bits >= 16 ? 0xffff : 0xffff << (16 - bits) & 0xffff)) return false
  }
  return true
}
// The IPv4 address an IPv4-compatible (::/96), SIIT (::ffff:0:0:0/96) or NAT64
// (64:ff9b::/96, as DNS64 synthesizes) address leads to, or null.
function embedded(words: number[]): Addr | null {
  const zero = (from: number, to: number) => words.slice(from, to).every(word => word === 0)
  if (!zero(0, 6) && !(zero(0, 4) && words[4] === 0xffff && !words[5]) && !(words[0] === 0x64 && words[1] === 0xff9b && zero(2, 6))) return null
  return address([words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255].join('.'))
}
// Point-to-point and tunnel interfaces: their cidr says nothing about a network beside this computer.
const TUNNEL = /^(?:utun|tun|ppp|ipsec|gif|stf)/
// The masked subnet an interface's cidr names: IPv4 /8-/32 or IPv6 /32-/128.
// A wider one (a misconfigured /0 or /4) would shut out the internet, so it doesn't count.
function subnetOf(cidr: unknown): Subnet | null {
  const match = typeof cidr === 'string' && /^([^/]+)\/([0-9]{1,3})$/.exec(cidr)
  if (!match) return null
  const bits = Number(match[2])
  if (net.isIPv4(match[1]!)) {
    if (bits < 8 || bits > 32) return null
    const n = (v4n(match[1]!.split('.').map(Number)) & 0xffffffff << (32 - bits)) >>> 0
    const bytes = [n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255]
    return { family: 4, range: [bytes, bits], key: `${bytes.join('.')}/${bits}` }
  }
  const words = words6(match[1]!)
  if (!words || bits < 32 || bits > 128) return null
  const masked = words.map((word, i) => word & 0xffff << (16 - Math.max(0, Math.min(16, bits - 16 * i))) & 0xffff)
  return { family: 6, range: [masked, bits], key: `${text6(masked)}/${bits}` }
}

// NO_PROXY-style rules, best effort: bad entries are skipped, never fatal. '*';
// a name, '.name' or '*.name' (that name and its subdomains, as curl and Go do);
// IP literals; CIDR (macOS lists '169.254/16'). The first 64 usable entries count.
function rulesOf(list: unknown): Rules {
  const rules: Rules = { all: false, suffixes: [], ips: new Set(), subnets: new net.BlockList() }
  let used = 0
  for (const raw of Array.isArray(list) ? list : []) {
    if (used >= LIMITS.bypass) break
    if (typeof raw !== 'string' || raw.length > LIMITS.entry) continue
    const text = raw.trim().toLowerCase(), ip = address(text)
    if (text === '*') rules.all = true
    else if (ip) rules.ips.add(ip.key)
    else if (/^[0-9a-f.:]+\/[0-9]{1,3}$/.test(text)) {
      let [base, prefix] = text.split('/') as [string, string]
      if (!base.includes(':') && /^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$/.test(base)) base = [...base.split('.'), '0', '0', '0'].slice(0, 4).join('.')
      const subnet = address(base)
      if (!subnet || Number(prefix) > (subnet.family === 4 ? 32 : 128)) continue
      try { rules.subnets.addSubnet(subnet.key, Number(prefix), subnet.family === 4 ? 'ipv4' : 'ipv6') } catch { continue }
    } else {
      const name = hostname(text.replace(/^\*?\./, ''))
      if (!name || numeric(name)) continue // A name ending in a number is never asked for.
      rules.suffixes.push(name)
    }
    used++
  }
  return rules
}
function bypassed(rules: Rules, verdict: Verdict): boolean {
  if (rules.all) return true
  if (verdict.ip) {
    try { return rules.ips.has(verdict.ip.key) || rules.subnets.check(verdict.ip.key, verdict.ip.family === 4 ? 'ipv4' : 'ipv6') } catch { return false }
  }
  return rules.suffixes.some(suffix => verdict.host === suffix || verdict.host!.endsWith(`.${suffix}`))
}

// The person's own proxy as this one can use it, or null: http (CONNECT) or
// socks5 at an IP literal or a plain host name (so never user:pass@host or
// host:port), with its bypass list.
function upstreamOf(up: any): Upstream | null {
  if (!plain(up) || Object.keys(up).sort().join(',') !== 'bypass,host,kind,port' || !['http', 'socks5'].includes(up.kind) || !portOK(up.port)) return null
  const ip = address(up.host), name = ip ? null : hostname(up.host)
  return ip || name ? { kind: up.kind, host: ip ? ip.key : name!, port: up.port, bypass: rulesOf(up.bypass) } : null
}
function configOf(cfg: any): Settings {
  if (!plain(cfg) || Object.keys(cfg).filter(key => key !== 'lan').sort().join(',') !== 'controlToken,port,upstream' || (Object.hasOwn(cfg, 'lan') && typeof cfg.lan !== 'boolean') || !(cfg.port === 0 || portOK(cfg.port)) || typeof cfg.controlToken !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(cfg.controlToken)) throw failure('INVALID_CONFIG')
  // An upstream it can't use is left out, never fatal: the window goes on
  // directly, and one row says so (the plugin's note), never what it was.
  const upstream = cfg.upstream === null ? null : upstreamOf(cfg.upstream)
  return { port: cfg.port, controlToken: cfg.controlToken, lan: cfg.lan === true, upstream, unusable: cfg.upstream !== null && !upstream }
}
function commandOf(row: any): Routes {
  if (!plain(row) || Object.keys(row).sort().join(',') !== 'op,routes,startable' || row.op !== 'routes' || !plain(row.routes) || !Array.isArray(row.startable) || row.startable.length > LIMITS.startable || !row.startable.every(portOK)) throw failure('INVALID_CONFIG')
  const entries = Object.entries(row.routes as Record<string, number>)
  if (entries.length > LIMITS.routes || !entries.every(([key, target]) => /^[1-9][0-9]{0,4}$/.test(key) && portOK(Number(key)) && portOK(target))) throw failure('INVALID_CONFIG')
  return { routes: new Map(entries.map(([key, target]) => [Number(key), target])), startable: new Set(row.startable) }
}
// Addresses in the order an upstream is given them: IPv4 first, then the
// families in turn (A, AAAA, A, AAAA…), each address once.
function alternate(pool: Addr[]): Addr[] {
  const keys = new Set<string>(), fours: Addr[] = [], sixes: Addr[] = []
  for (const a of pool) if (!keys.has(a.key)) { keys.add(a.key); (a.family === 4 ? fours : sixes).push(a) }
  const order: Addr[] = []
  for (let i = 0; i < Math.max(fours.length, sixes.length); i++) order.push(...([fours[i], sixes[i]].filter(Boolean) as Addr[]))
  return order
}
function codeOf(error: any): number {
  const codes = [error?.code, ...(Array.isArray(error?.errors) ? error.errors.map((e: any) => e?.code) : [])]
  if (codes.includes('ECONNREFUSED')) return REFUSED
  return codes.some(code => UNREACHABLE_CODES.has(code)) ? UNREACHABLE : FAILED
}
// A DNS JSON answer (RFC 8427's shape, as Cloudflare and Google give it): the
// addresses of its A (1) or AAAA (28) records and their least TTL in seconds.
// NXDOMAIN or no records is an empty list; any other status, or a record of
// the type asked whose data is no address, is a bad answer (the next server).
function answerOf(body: any, type: string): Answer {
  const want = type === 'A' ? 1 : 28
  if (!plain(body) || !Number.isInteger(body.Status)) throw failure('PROTOCOL')
  if (body.Status === 3) return { list: [], ttl: 30 }
  if (body.Status !== 0) throw failure('PROTOCOL')
  const list: Addr[] = []
  let ttl = 30
  for (const record of Array.isArray(body.Answer) ? body.Answer : []) {
    if (!plain(record) || record.type !== want) continue
    // A AAAA record holding a mapped IPv4 address is read as that address and judged as one.
    const a = want === 1 ? (net.isIPv4(record.data) ? address(record.data) : null) : (net.isIPv6(record.data) ? address(record.data) : null)
    if (!a) throw failure('PROTOCOL')
    if (list.length === 0) ttl = Infinity
    ttl = Math.min(ttl, Number.isFinite(record.TTL) && record.TTL >= 0 ? record.TTL : 0)
    list.push(a)
  }
  return { list, ttl }
}

// Test hooks (timeouts, limits, lookup, interfaces, connect for dials, knock
// for the port's own check, doh for the DNS-over-HTTPS servers with a ca of
// their own) are internal, never from stdin.
export async function start(cfg: any, { emit = notify, signal, timeouts: wait = {}, limits: cap = {}, lookup = dns.lookup, interfaces = os.networkInterfaces, connect = net.connect, knock = net.connect, doh = DOH }: StartOptions = {}) {
  const timeouts = { ...TIMEOUTS, ...wait }, limits = { ...LIMITS, ...cap }
  const conns = new Set<Conn>(), held = new Set<Conn>(), lookups = new Map<string, Promise<Addr[] | null>>()
  const servers = doh.map(server => ({ ...server, ip: address(server.address) })).filter((server): server is Server => Boolean(server.ip) && portOK(server.port))
  const answers = new Map<string, { list: Addr[] | null; until: number }>(), looks = new Map<string, Promise<Addr[] | null>>(), down = new Map<Server, { until: number; wait: number }>(), asking = new Set<net.Socket>(), off = { until: 0, wait: 0 }
  const seen = new Set<number>(), wanted = new Map<number, number>(), blocked = new Map<number, number>()
  let settings!: Settings, routes = new Map<number, number>(), startable = new Set<number>(), configured = false, lanAt = -Infinity, known: Known | null = null, knownAt = 0
  let stopped = false, closing: Promise<void> | undefined, binding: Promise<void> | undefined, socks: net.Server | undefined, control: ControlServer | undefined, port: number | undefined, controlPort: number | undefined

  const say = (row: Record<string, unknown>) => {
    try {
      if (JSON.stringify(row).length >= limits.line || (emit === notify && process.stdout.writableLength > limits.stdout)) return
      emit(row)
    } catch {}
  }
  const signalOnce = (map: Map<number, number>, state: string, hostPort: number, every: number) => {
    const now = Date.now(), last = map.get(hostPort)
    if (last !== undefined && now - last < every) return
    map.set(hostPort, now)
    say({ state, port: hostPort })
  }
  const close = () => {
    if (closing) return closing
    stopped = true
    signal?.removeEventListener('abort', close)
    const ending = control?.close()
    for (const conn of [...conns]) drop(conn)
    for (const socket of [...asking]) socket.destroy()
    closing = (async () => {
      await binding?.catch(() => {})
      await Promise.all([new Promise<void>(resolve => socks?.listening ? socks.close(() => resolve()) : resolve()), ending])
    })()
    return closing
  }

  function later(conn: Conn, ms: number, action: () => void) {
    const timer = setTimeout(() => { conn.timers.delete(timer); action() }, ms)
    conn.timers.add(timer)
    return timer
  }
  function settle(conn: Conn) {
    for (const timer of conn.timers) clearTimeout(timer)
    conn.timers.clear()
    if (conn.holding) { held.delete(conn); conn.holding = false }
    conn.wake?.()
  }
  function drop(conn: Conn) {
    if (conn.closed) return
    conn.done = true
    settle(conn)
    conn.target?.destroy()
    conn.client.destroy()
  }
  function refuse(conn: Conn, code: number) {
    if (conn.done || conn.closed) return
    conn.done = true
    settle(conn)
    conn.target?.destroy()
    conn.client.end(code === NO_METHOD ? Buffer.from([5, NO_METHOD]) : Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]))
    // Keep reading so the client's FIN closes this cleanly (unread data means RST).
    conn.client.resume()
    later(conn, timeouts.linger, () => conn.client.destroy())
  }
  function splice(conn: Conn, target: net.Socket) {
    if (conn.done || conn.closed || stopped) return target.destroy()
    conn.done = conn.spliced = true
    settle(conn)
    conn.target = target
    const { client } = conn, destroy = () => { client.destroy(); target.destroy() }
    // FIN travels as a half-close each way (allowHalfOpen); only an error tears
    // down the peer, so a normal close never truncates bytes still queued.
    for (const socket of [client, target]) {
      socket.on('error', destroy)
      socket.on('close', (hadError: boolean) => { if (hadError) destroy() })
    }
    client.write(SUCCESS)
    client.pipe(target)
    target.pipe(client)
  }
  function hold(conn: Conn, ms: number): Promise<boolean> {
    if (!conn.holding) {
      if (held.size >= limits.held) return Promise.resolve(false)
      held.add(conn)
      conn.holding = true
    }
    return new Promise<boolean>(resolve => {
      const timer = later(conn, ms, () => { conn.wake = null; resolve(true) })
      conn.wake = () => { conn.wake = null; clearTimeout(timer); conn.timers.delete(timer); resolve(true) }
    })
  }
  function configure(next: Routes) {
    ({ routes, startable } = next)
    configured = true
    for (const conn of [...held]) conn.wake?.()
  }

  function accept(client: net.Socket) {
    client.on('error', () => {})
    if (stopped || conns.size >= limits.clients) return client.destroy()
    const conn: Conn = { client, target: null, timers: new Set(), done: false, spliced: false, closed: false, holding: false, wake: null }
    conns.add(conn)
    client.once('close', () => {
      conn.closed = true
      conns.delete(conn)
      settle(conn)
      if (!conn.spliced) conn.target?.destroy()
    })
    // Reads pause once the request is in, so this only sees a FIN mid-handshake
    // (afterwards a FIN waits in the stream and reaches the target as a half-close).
    client.once('end', () => { if (!conn.done) drop(conn) })
    later(conn, timeouts.handshake, () => drop(conn))
    let buffer: Buffer = Buffer.alloc(0), greeted = false
    const data = (chunk: Buffer) => {
      if (conn.done) return
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
      if (!greeted) {
        if (buffer.length < 2) return
        if (buffer[0] !== 5) return drop(conn)
        if (buffer.length < 2 + buffer[1]!) return
        const methods = buffer.subarray(2, 2 + buffer[1]!)
        buffer = buffer.subarray(2 + buffer[1]!)
        if (!methods.includes(0)) return refuse(conn, NO_METHOD)
        greeted = true
        client.write(Buffer.from([5, 0]))
      }
      if (buffer.length < 4) return
      if (buffer[0] !== 5) return drop(conn)
      if (buffer[1] !== 1) return refuse(conn, COMMAND)
      const atyp = buffer[3]!
      if (![1, 3, 4].includes(atyp)) return refuse(conn, ADDRESS)
      const size = atyp === 1 ? 10 : atyp === 4 ? 22 : buffer.length < 5 ? Infinity : 7 + buffer[4]!
      if (buffer.length < size) return
      const host = atyp === 1 ? [...buffer.subarray(4, 8)].join('.')
        : atyp === 4 ? Array.from({ length: 8 }, (_, i) => buffer.readUInt16BE(4 + 2 * i).toString(16)).join(':')
        : buffer.toString('latin1', 5, 5 + buffer[4]!)
      const request = { host, port: buffer.readUInt16BE(size - 2) }, rest = buffer.subarray(size)
      buffer = null!
      // Hold further bytes until the target is ready; early data goes first.
      client.pause()
      client.removeListener('data', data)
      if (rest.length) client.unshift(rest)
      settle(conn)
      handle(conn, request).catch(() => drop(conn))
    }
    client.on('data', data)
  }

  async function handle(conn: Conn, request: { host: string; port: number }) {
    if (!request.port) return refuse(conn, NOT_ALLOWED)
    const verdict: Verdict = await classify(request.host).catch(() => ({ kind: 'error' }))
    if (conn.done || conn.closed) return
    if (verdict.kind === 'loopback') return loopback(conn, request.port)
    if (verdict.kind === 'outbound') return outbound(conn, request.port, verdict)
    if (verdict.kind === 'lan') return refuseNetwork(conn)
    refuse(conn, verdict.kind === 'own' || verdict.kind === 'rebound' ? NOT_ALLOWED : verdict.kind === 'invalid' ? UNREACHABLE : FAILED)
  }
  // Says only that the local network was refused: never what or where.
  function refuseNetwork(conn: Conn) {
    if (Date.now() - lanAt >= timeouts.lanEvery) { lanAt = Date.now(); say({ state: 'lan' }) }
    refuse(conn, NOT_ALLOWED)
  }
  // This computer's interfaces, read at most every `timeouts.interfaces`: its own
  // addresses (every interface, loopback-class aside) and on-link subnets (tunnels
  // aside). A read that throws is never kept: it fails closed until one works.
  function network(): Known | null {
    if (known && performance.now() - knownAt < timeouts.interfaces) return known
    try {
      const own = new Set<string>(), subnets = new Map<string, Subnet>()
      for (const [name, list] of Object.entries<any>(interfaces() ?? {})) for (const entry of Array.isArray(list) ? list : []) {
        const a = address(entry?.address)
        if (a && !local(a)) own.add(a.key)
        const subnet = TUNNEL.test(name) ? null : subnetOf(entry?.cidr)
        if (subnet) subnets.set(subnet.key, subnet)
      }
      const ranges = (family: number) => [...subnets.values()].filter(subnet => subnet.family === family).map(subnet => subnet.range)
      known = { own, onlink4: ranges(4), onlink6: ranges(6) }
      knownAt = performance.now()
      return known
    } catch { return null }
  }
  function resolve(name: string): Promise<Addr[] | null> {
    let pending = lookups.get(name)
    if (pending) return pending
    pending = new Promise<Addr[] | null>(done => {
      const timer = setTimeout(() => done(null), timeouts.lookup)
      const finish = (error: any, list?: any) => {
        clearTimeout(timer)
        const found = !error && Array.isArray(list) ? list.map((entry: any) => address(entry?.address)).filter(Boolean) as Addr[] : []
        done(found.length ? found : null)
      }
      try { lookup(name, { all: true }, finish) } catch (error) { finish(error) }
    })
    lookups.set(name, pending)
    const mine = pending
    pending.then(() => { if (lookups.get(name) === mine) lookups.delete(name) })
    return pending
  }
  // One address: 'loopback' (routed), 'own', 'lan' (the Guest's network) or 'ok'.
  function kindOf(a: Addr, here: Known): string {
    if (local(a)) return 'loopback'
    const lead = a.family === 6 ? embedded(a.words!) : null
    if (here.own.has(a.key) || (lead && here.own.has(lead.key))) return 'own'
    if (METADATA.has(a.key) || (lead && METADATA.has(lead.key))) return 'lan'
    const v4 = a.family === 4, hit = (ranges: Range[]) => ranges.some(range => v4 ? within4(a.bytes!, range) : within6(a.words!, range))
    if (hit(v4 ? SHUT4 : SHUT6) || (!settings.lan && (hit(v4 ? PRIVATE4 : PRIVATE6) || hit(v4 ? here.onlink4 : here.onlink6)))) return 'lan'
    // A loopback behind NAT64 or SIIT is some gateway's, never this computer's.
    return lead && (local(lead) || kindOf(lead, here) === 'lan') ? 'lan' : 'ok'
  }
  // Decided before any upstream or bypass: nothing refused here is ever tunnelled.
  async function classify(text: string): Promise<Verdict> {
    const ip = address(text)
    if (ip) {
      if (local(ip)) return { kind: 'loopback' }
      const here = network()
      if (!here) return { kind: 'error' }
      const kind = kindOf(ip, here)
      return kind === 'ok' ? { kind: 'outbound', ip, host: ip.key, addresses: [ip], tainted: false } : { kind }
    }
    const name = hostname(text)
    // Canonical dotted-decimal was an address above; any other numeric spelling
    // is refused unread, before a lookup or an upstream could read it as one.
    if (!name || numeric(name)) return { kind: 'invalid' }
    if (name === 'localhost' || name.endsWith('.localhost')) return { kind: 'loopback' }
    const found = await resolve(name)
    // Only localhost and loopback literals reach the Host's previews. Another
    // name pointing here may be a page's own, rebound to loopback after it
    // loaded: its script would read the previews as that page's origin.
    if (found?.some(local)) return { kind: 'rebound' }
    const here = network()
    if (!here) return { kind: 'error' }
    if (!found) return { kind: 'outbound', ip: null, host: name, addresses: null, tainted: false }
    const kinds = found.map(a => kindOf(a, here))
    if (kinds.includes('own')) return { kind: 'own' }
    // Direct dials only the allowed addresses (pinned); none left means the
    // network was all it had. Tainted: some address it gave was refused.
    const allowed = found.filter((_, i) => kinds[i] === 'ok')
    return allowed.length ? { kind: 'outbound', ip: null, host: name, addresses: allowed, tainted: allowed.length < found.length } : { kind: 'lan' }
  }

  async function loopback(conn: Conn, hostPort: number) {
    if (!seen.has(hostPort)) { seen.add(hostPort); say({ state: 'seen', port: hostPort }) }
    const firstUntil = Date.now() + timeouts.firstConfig
    let wantUntil = 0
    for (;;) {
      if (conn.done || conn.closed || stopped) return
      const target = routes.get(hostPort)
      if (target) return dial(conn, { host: '127.0.0.1', port: target, allowHalfOpen: true, noDelay: true }, () => REFUSED, socket => splice(conn, socket))
      let until = firstUntil
      if (configured && startable.has(hostPort)) {
        if (!wantUntil) { wantUntil = Date.now() + timeouts.want; signalOnce(wanted, 'want', hostPort, timeouts.wantEvery) }
        until = wantUntil
      } else if (configured) {
        signalOnce(blocked, 'blocked', hostPort, timeouts.blockedEvery)
        return refuse(conn, NOT_ALLOWED)
      }
      // Never configured within its wait: refused, but not reported as blocked.
      if (Date.now() >= until || !(await hold(conn, until - Date.now()))) return refuse(conn, NOT_ALLOWED)
    }
  }
  function dial(conn: Conn, options: any, codeFor: (error: any) => number, connected: (socket: net.Socket) => void) {
    if (conn.done || conn.closed || stopped) return
    later(conn, timeouts.connect, () => refuse(conn, codeFor({ code: 'ETIMEDOUT' })))
    let socket: net.Socket
    try { socket = connect(options) } catch (error) { return refuse(conn, codeFor(error)) }
    conn.target = socket
    socket.on('error', (error: any) => refuse(conn, codeFor(error)))
    socket.once('connect', () => { if (!conn.done && !conn.closed) connected(socket) })
  }
  function upstreamFor(verdict: Verdict): Upstream | null {
    const up = settings.upstream, ip = up && address(up.host)
    if (!up || bypassed(up.bypass, verdict)) return null
    // An upstream that is this proxy itself would only loop.
    return up.port === port && (up.host === 'localhost' || (ip && local(ip))) ? null : up
  }
  // An upstream is given an address, never a name: it would look the name up
  // again and could take one refused here. Literals go as they are; a name
  // goes at an address from DNS-over-HTTPS through that upstream (a local
  // answer can be poisoned where the upstream is needed), every one of which
  // must pass, else at its local answer's checked addresses; with neither, it
  // is refused.
  async function outbound(conn: Conn, targetPort: number, verdict: Verdict) {
    const up = upstreamFor(verdict)
    if (!up) {
      if (!verdict.addresses) return refuse(conn, UNREACHABLE)
      // Connect only to the addresses just checked: a second lookup could rebind.
      const fixed = verdict.addresses.map(a => ({ address: a.key, family: a.family }))
      const pinned = (_name: string, options: any, callback: any) => options?.all ? callback(null, fixed) : callback(null, fixed[0]!.address, fixed[0]!.family)
      return dial(conn, { host: verdict.host, port: targetPort, lookup: pinned, allowHalfOpen: true, noDelay: true, autoSelectFamily: true }, codeOf, socket => splice(conn, socket))
    }
    // Nothing the local answer refused is tunnelled, whatever DNS-over-HTTPS says.
    if (verdict.tainted) return refuseNetwork(conn)
    let pool: Addr[] | null | undefined = verdict.ip ? [verdict.ip] : null
    if (!pool) {
      const found = await resolveOver(up, verdict.host!)
      if (conn.done || conn.closed || stopped) return
      if (found?.length) {
        const here = network()
        if (!here) return refuse(conn, FAILED)
        const kinds = found.map(a => kindOf(a, here))
        if (kinds.includes('own')) return refuse(conn, NOT_ALLOWED)
        if (kinds.some(kind => kind !== 'ok')) return refuseNetwork(conn)
        pool = found
      } else pool = verdict.addresses
    }
    if (!pool?.length) return refuse(conn, UNREACHABLE)
    tunnel(conn, up, alternate(pool).slice(0, limits.upstreamTries), targetPort)
  }
  // The checked addresses one after another, each through a fresh tunnel,
  // until the upstream lets one through: autoSelectFamily only finds a way to
  // the upstream, never the address inside its tunnel, so a site whose IPv4
  // route is broken there still opens at its IPv6. One deadline covers every
  // try, from the first, and each try but the last has its share of what's
  // left of it, so one the upstream holds unanswered (a blackholed route)
  // can't take the others' turns. An upstream that couldn't be reached at
  // all says nothing of the address, so that is refused at once. All
  // refused: the last try's code.
  function tunnel(conn: Conn, up: Upstream, order: Addr[], targetPort: number) {
    if (conn.done || conn.closed || stopped) return
    const deadline = Date.now() + timeouts.connect
    later(conn, timeouts.connect, () => refuse(conn, codeOf({ code: 'ETIMEDOUT' })))
    const attempt = (i: number, last: number): void => {
      if (conn.done || conn.closed || stopped) return
      if (i >= order.length) return refuse(conn, last)
      let socket: net.Socket | undefined, share: NodeJS.Timeout | null = null, over = false, reached = false
      const settled = () => { if (share) { clearTimeout(share); conn.timers.delete(share) } }
      const failed = (code: number) => {
        if (over) return
        over = true
        settled()
        if (conn.target === socket) conn.target = null
        socket?.destroy()
        reached ? attempt(i + 1, code) : refuse(conn, code)
      }
      if (i < order.length - 1) share = later(conn, Math.max(1, (deadline - Date.now()) / (order.length - i)), () => failed(codeOf({ code: 'ETIMEDOUT' })))
      try { socket = connect({ host: up.host, port: up.port, allowHalfOpen: true, noDelay: true, autoSelectFamily: true }) } catch (error) { return failed(codeOf(error)) }
      // Held as the client's target, so a client leaving, a refusal or close() ends this try too.
      conn.target = socket
      const s = socket
      s.on('error', (error: any) => failed(codeOf(error)))
      s.once('close', () => failed(FAILED))
      s.once('connect', () => {
        reached = true
        if (conn.done || conn.closed) return s.destroy()
        through(up.kind, s, order[i]!, targetPort, () => { if (!over) { over = true; settled(); splice(conn, s) } }, failed)
      })
    }
    attempt(0, FAILED)
  }
  // Reads an upstream's reply: parse returns bytes used, 0 for more, or -REP.
  function collect(socket: net.Socket, max: number, parse: (buffer: Buffer) => number, done: () => void, fail: (code: number) => void) {
    let buffer: Buffer = Buffer.alloc(0)
    const finish = () => { socket.pause(); socket.removeListener('data', data); socket.removeListener('end', ended) }
    const ended = () => { finish(); fail(FAILED) }
    const data = (chunk: Buffer) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
      const used = parse(buffer)
      if (used === 0 && buffer.length < max) return
      finish()
      if (used <= 0) return fail(used < 0 ? -used : FAILED)
      if (used < buffer.length) socket.unshift(buffer.subarray(used))
      done()
    }
    socket.on('data', data)
    socket.once('end', ended)
    socket.resume()
  }
  // The upstream's handshake for one checked address (CONNECT a.b.c.d:p or
  // [v6]:p; SOCKS5 ATYP 1 or 4), then done() or fail(REP).
  function through(kind: string, socket: net.Socket, ip: Addr, targetPort: number, done: () => void, fail: (code: number) => void) {
    if (kind === 'http') return viaHTTP(socket, ip, targetPort, done, fail)
    viaSOCKS(socket, ip, targetPort, done, fail)
  }
  function viaHTTP(socket: net.Socket, ip: Addr, targetPort: number, done: () => void, fail: (code: number) => void) {
    const authority = `${ip.family === 6 ? `[${ip.key}]` : ip.key}:${targetPort}`
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    collect(socket, LIMITS.upstreamHead, buffer => {
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return 0
      if (end + 4 > LIMITS.upstreamHead) return -FAILED
      return /^HTTP\/1\.[01] 2[0-9]{2}[ \r]/.test(buffer.toString('latin1', 0, Math.min(end + 2, 64))) ? end + 4 : -FAILED
    }, done, fail)
  }
  function viaSOCKS(socket: net.Socket, ip: Addr, targetPort: number, done: () => void, fail: (code: number) => void) {
    socket.write(Buffer.from([5, 1, 0]))
    collect(socket, 2, (b: Buffer) => b.length < 2 ? 0 : b[0] === 5 && b[1] === 0 ? 2 : -FAILED, () => {
      const where = ip.family === 4 ? [1, ...ip.bytes!] : [4, ...ip.words!.flatMap(word => [word >> 8, word & 255])]
      socket.write(Buffer.from([5, 1, 0, ...where, targetPort >> 8, targetPort & 255]))
      collect(socket, 262, (b: Buffer) => {
        if (b.length < 4) return 0
        if (b[0] !== 5) return -FAILED
        if (b[1] !== 0) return -(b[1]! <= ADDRESS ? b[1]! : FAILED)
        const size = b[3] === 1 ? 10 : b[3] === 4 ? 22 : b[3] === 3 ? (b.length < 5 ? 263 : 7 + b[4]!) : 0
        return !size ? -FAILED : b.length < size ? 0 : size
      }, done, fail)
    }, fail)
  }

  // A name's addresses from DNS-over-HTTPS through the upstream: the first
  // server that answers both A and AAAA decides, its answer kept for its TTL
  // (at most a minute). null when none answers in time, so the caller falls
  // back to the local answer; concurrent looks of one name share one.
  // Unreachable (no tunnel, no TLS, the connection lost: the proxy or its
  // network) is the server's, skipped a while; slow once TLS is up, or a bad
  // answer, is the name's alone (a slow domain, or one made slow on purpose),
  // and never makes other names wait on their local answers.
  function resolveOver(up: Upstream, name: string): Promise<Addr[] | null> {
    const kept = answers.get(name)
    if (kept && kept.until > Date.now()) return Promise.resolve(kept.list)
    let pending = looks.get(name)
    if (pending) return pending
    // No server reachable on the last look: DoH waits, as a whole, for its back-off.
    if (off.until > Date.now()) return Promise.resolve(null)
    const remember = (list: Addr[] | null, ms: number) => {
      answers.delete(name)
      answers.set(name, { list, until: Date.now() + ms })
      while (answers.size > limits.dohNames) answers.delete(answers.keys().next().value!)
    }
    const backoff = (previous?: number) => Math.min(timeouts.dohDownMax, previous ? previous * 2 : timeouts.dohDown)
    pending = (async (): Promise<Addr[] | null> => {
      // Back-offs grow from what they were as this look began, so a burst of
      // looks failing together doubles them once, not once a look.
      const until = Date.now() + timeouts.doh, offWas = off.wait
      let named = false, unreachable = false
      for (const server of servers) {
        if (stopped || Date.now() >= until) break
        const skip = down.get(server)
        if (skip && skip.until > Date.now()) continue
        const by = Math.min(until, Date.now() + timeouts.dohEach)
        // Less than its own time (the whole look's ran short): a timeout says nothing of the server.
        const short = by < Date.now() + timeouts.dohEach
        const [a, aaaa] = await Promise.allSettled([ask(up, server, name, 'A', by, short), ask(up, server, name, 'AAAA', by, short)])
        if (a.status === 'fulfilled' && aaaa.status === 'fulfilled') {
          down.delete(server)
          off.until = off.wait = 0
          const list = [...a.value.list, ...aaaa.value.list]
          remember(list, Math.min(timeouts.dohTTL, 1000 * Math.min(a.value.ttl, aaaa.value.ttl)))
          return list
        }
        const codes = [a, aaaa].filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason?.code)
        if (codes.some(code => code === 'PROTOCOL' || code === 'SLOW')) named = true
        if (codes.some(code => code !== 'PROTOCOL' && code !== 'SLOW' && code !== 'SHORT')) {
          unreachable = true
          const wait = backoff(skip?.wait)
          down.set(server, { until: Date.now() + wait, wait })
        }
      }
      if (named) remember(null, timeouts.dohMiss)
      else if (unreachable && !stopped) {
        off.wait = backoff(offWas)
        off.until = Date.now() + off.wait
      }
      return null
    })().catch(() => null)
    looks.set(name, pending)
    const mine = pending
    pending.then(() => { if (looks.get(name) === mine) looks.delete(name) })
    return pending
  }
  // One GET of one record type from one server, over TLS (its certificate
  // checked for its name) inside a tunnel through the upstream to its address.
  // Its codes: PROTOCOL a bad answer, SLOW no answer in time once TLS was up
  // (the name's); SHORT no TLS in time when given less than its own time
  // (nobody's); anything else unreachable (the server's).
  function ask(up: Upstream, server: Server, name: string, type: string, until: number, short: boolean): Promise<Answer> {
    return new Promise<Answer>((resolve, reject) => {
      let socket: net.Socket | undefined, secure: tls.TLSSocket | undefined, over = false, reached = false
      const finish = (error: Error | null, value?: Answer) => {
        if (over) return
        over = true
        clearTimeout(timer)
        secure?.destroy()
        socket?.destroy()
        error ? reject(error) : resolve(value!)
      }
      const fail = (code = 'CONNECT') => finish(failure(code))
      const timer = setTimeout(() => fail(reached ? 'SLOW' : short ? 'SHORT' : 'CONNECT'), Math.max(1, until - Date.now()))
      if (stopped) return fail()
      try { socket = connect({ host: up.host, port: up.port, noDelay: true, autoSelectFamily: true }) } catch { return fail() }
      const s = socket
      asking.add(s)
      s.once('close', () => { asking.delete(s); fail() })
      s.on('error', () => fail())
      s.once('connect', () => through(up.kind, s, server.ip, server.port, () => {
        if (over) return
        const t = secure = tls.connect({ socket: s, servername: server.servername, ALPNProtocols: ['http/1.1'], ...(server.ca ? { ca: server.ca } : {}) })
        t.on('error', () => fail())
        t.once('secureConnect', () => { reached = true })
        const request = http.request({ createConnection: () => t, method: 'GET', path: `${server.path}?name=${encodeURIComponent(name)}&type=${type}`, headers: { host: server.servername, accept: 'application/dns-json' } }, response => {
          if (response.statusCode !== 200) return fail('PROTOCOL')
          const parts: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > limits.dohBody) return fail('PROTOCOL')
            parts.push(chunk)
          })
          response.on('end', () => {
            if (over) return
            let value: Answer
            try { value = answerOf(JSON.parse(Buffer.concat(parts, size).toString('utf8')), type) } catch { return fail('PROTOCOL') }
            finish(null, value)
          })
          response.on('error', () => fail())
        })
        request.on('error', () => fail())
        request.end()
      }, () => fail()))
    })
  }

  const bindTo = (server: net.Server, wanted: number) => new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.removeListener('listening', listening); reject(error) }
    const listening = () => { server.removeListener('error', failed); resolve() }
    server.once('error', failed)
    server.once('listening', listening)
    server.listen({ host: '127.0.0.1', port: wanted })
  })

  try {
    settings = configOf(cfg)
    cfg = null
    signal?.addEventListener('abort', close, { once: true })
    if (signal?.aborted) throw failure('STARTUP')
    // The window's own port again (a reload, a proxy that ended under its
    // window) is knocked on first, as the guest's listener knocks (vacant):
    // macOS would let this bind sit beside another process's wildcard
    // listener there and take its 127.0.0.1 traffic. Taken is EADDRINUSE, as
    // a bind conflict is, so the plugin closes the window and says why.
    if (settings.port && !(await vacant('127.0.0.1', settings.port, knock))) throw failure('EADDRINUSE')
    if (stopped) throw failure('STARTUP')
    socks = net.createServer({ allowHalfOpen: true, noDelay: true }, accept)
    socks.on('error', () => {}) // Never print native errors or addresses.
    await (binding = bindTo(socks, settings.port))
    if (stopped) throw failure('STARTUP')
    port = (socks.address() as net.AddressInfo).port
    // Routes arrive here, from the plugin alone; a bad table changes nothing.
    control = controlServer({
      token: settings.controlToken, bodyLimit: limits.body, sockets: limits.controlSockets, timeoutMs: timeouts.control, headers: limits.headers,
      onCommand: value => { if (stopped) return { status: 503 }; configure(commandOf(value)) },
    })
    controlPort = await control.listen()
    if (stopped) throw failure('STARTUP')
    say({ state: 'ready', port, control: controlPort })
    // After ready: the plugin reads a proxy's other rows only once it's ready.
    if (settings.unusable) say({ state: 'upstream', reason: 'INVALID_UPSTREAM' })
    return { close, port, control: controlPort }
  } catch (error) {
    await close()
    const code = safeCode(error)
    if (!signal?.aborted) say({ state: 'error', code })
    throw Object.assign(failure(code), { reported: true })
  }
}

if (import.meta.main) run(async (cfg, options) => {
  const proxy = await start(cfg, options)
  // A DNS lookup in flight cannot be cancelled; it must not hold up an exit.
  return { ...proxy, close: () => proxy.close().then(() => { setTimeout(() => process.exit(), 500).unref() }) }
})
