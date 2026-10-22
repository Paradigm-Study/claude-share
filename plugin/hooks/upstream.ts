// The person's own proxy, which a preview window's other traffic goes on
// through (relay/browser-proxy.cjs): from the environment as their own tools
// take it, else macOS's settings. Split here, by the URL parser, into a
// kind, a host and a port, and nothing more: whether the window's proxy can
// use that host (an IP literal, or a plain host name, as it takes them) is
// its own to say, and one it can't is left out there and said once (its
// `upstream` line). Pure.

import { CONTROL, isPort } from './preview'

/** Where the guest's non-local traffic goes on: the person's own proxy, never one with credentials. */
export type Upstream = { kind: 'http' | 'socks5'; host: string; port: number; bypass: string[] }

// NO_PROXY and macOS's exceptions: names, suffixes, CIDRs, as given; 64 at
// most, none over 253 characters, and 6 KiB in all, so the proxy's settings
// stay well inside what its stdin takes. Only the characters such entries
// use: nothing JSON would escape or encode longer.
const BYPASS_ENTRY = /^[A-Za-z0-9._*:/[\]<>%-]{1,253}$/
function bypassList(text: string): string[] {
  const out: string[] = []
  let size = 0
  for (const entry of new Set(text.split(/[,\s]+/).map(s => s.replace(CONTROL, '').trim()))) {
    if (!BYPASS_ENTRY.test(entry)) continue
    if (out.length >= 64 || size + entry.length + 3 > 6144) break
    out.push(entry)
    size += entry.length + 3
  }
  return out
}

// A URL's host as the window's proxy is given it: an IPv6 address without
// its brackets, lowercased (the URL parser keeps a socks5:// URL's host as
// written), its trailing dot gone.
const hostOf = (hostname: string) => hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '')

// An upstream's address: http:// (CONNECT), socks5:// or socks5h://. The
// URL parser refuses what's no address at all (a space in it, no host, a
// port past 65535): `invalid`. One with a user or password isn't used: the
// window's proxy keeps no secrets; nor one it doesn't speak (https://,
// socks4://).
type ProxyAddress = { kind: Upstream['kind']; host: string; port: number } | 'userinfo' | 'unsupported' | 'invalid'
function proxyAddress(raw: string): ProxyAddress {
  const text = raw.trim()
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`)
  } catch {
    return 'invalid'
  }
  if (url.username || url.password) return 'userinfo'
  const scheme = url.protocol.replace(/:$/, '').toLowerCase()
  const kind = scheme === 'http' ? 'http' : scheme === 'socks5' || scheme === 'socks5h' ? 'socks5' : null
  if (!kind) return 'unsupported'
  const host = hostOf(url.hostname)
  if (!host) return 'invalid'
  const port = url.port ? Number(url.port) : kind === 'http' ? 80 : 1080
  return isPort(port) ? { kind, host, port } : 'invalid'
}

export type ProxyEnv = Partial<Record<'HTTPS_PROXY' | 'https_proxy' | 'ALL_PROXY' | 'all_proxy' | 'NO_PROXY' | 'no_proxy', string | undefined>>
/** The person's own proxy, or none: `userinfo` (it has credentials), `unsupported` (https://, socks4://) and `invalid` (no address the URL parser takes) say why one wasn't used. */
export type UpstreamFound = { upstream: Upstream | null; userinfo: boolean; unsupported: boolean; invalid: boolean }

// A variable set to nothing (or blanks) is one not set, as curl takes it.
const setValue = (...values: (string | undefined)[]) => values.find(v => typeof v === 'string' && v.trim() !== '')

/** The person's proxy from the environment, the way their own tools take it: HTTPS_PROXY, then ALL_PROXY, NO_PROXY the exceptions; one set empty counts as unset. */
export function upstreamFromEnv(env: ProxyEnv): UpstreamFound {
  const bypass = bypassList(setValue(env.NO_PROXY, env.no_proxy) ?? '')
  const found: UpstreamFound = { upstream: null, userinfo: false, unsupported: false, invalid: false }
  for (const raw of [env.HTTPS_PROXY, env.https_proxy, env.ALL_PROXY, env.all_proxy]) {
    if (!raw?.trim()) continue
    const address = proxyAddress(raw)
    if (typeof address === 'object') return { ...found, upstream: { ...address, bypass } }
    found[address] = true
  }
  return found
}

// macOS's proxy host, given as a host, as a URL (`http://proxy.corp.example/`:
// its scheme and path go, and a port in it, since scutil gives the port
// apart), or as an IPv6 address without its brackets: the host alone, or
// null where the URL parser takes none.
function scutilHost(raw: string): string | null {
  const bare = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '')
  const literal = !/^\[.*\]$/.test(bare) && (bare.match(/:/g) ?? []).length > 1 ? `[${bare}]` : bare
  try {
    return hostOf(new URL(`http://${literal}`).hostname) || null
  } catch {
    return null
  }
}

/**
 * macOS's own proxy settings, as `scutil --proxy` prints them: the HTTPS
 * proxy, else the SOCKS one, its exceptions the bypass. A host given as a
 * URL (`http://proxy.corp.example/`) is taken without its scheme and path;
 * one the URL parser takes no host from is left out (`invalid`). A proxy
 * auto-configuration (PAC) file isn't followed; `pac` says one is set.
 */
export function upstreamFromScutil(text: string): { upstream: Upstream | null; pac: boolean; invalid: boolean } {
  const value = (key: string) => new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm').exec(text)?.[1]
  const on = (key: string) => value(key) === '1'
  const listed = /ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/.exec(text)?.[1] ?? ''
  const exceptions = listed.split('\n').map(line => /^\s*\d+\s*:\s*(.+?)\s*$/.exec(line)?.[1]).filter((x): x is string => Boolean(x))
  const bypass = bypassList(exceptions.join(','))
  let invalid = false
  const pick = (kind: Upstream['kind'], raw?: string, port?: string): Upstream | null => {
    const p = Number(port)
    if (!raw || !isPort(p)) return null
    const host = scutilHost(raw)
    if (!host) invalid = true
    return host ? { kind, host, port: p, bypass } : null
  }
  const upstream = (on('HTTPSEnable') ? pick('http', value('HTTPSProxy'), value('HTTPSPort')) : null) ?? (on('SOCKSEnable') ? pick('socks5', value('SOCKSProxy'), value('SOCKSPort')) : null)
  return { upstream, pac: !upstream && on('ProxyAutoConfigEnable'), invalid: !upstream && invalid }
}
