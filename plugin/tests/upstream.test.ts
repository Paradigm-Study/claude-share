// The person's own proxy, which a preview window's other traffic goes on
// through: from the environment, else macOS's settings, split into a kind, a
// host and a port. Whether the window's proxy can take the host is its own
// to say (test/browser-proxy.test.ts). Run with `claude plugin test plugin`.

import { expect, test } from 'claude-code/testing'
import { upstreamFromEnv, upstreamFromScutil } from '../hooks/upstream'

test("the person's proxy from the environment: HTTPS_PROXY first, never one with credentials", () => {
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://proxy.corp:8080', ALL_PROXY: 'socks5://127.0.0.1:7890', NO_PROXY: 'localhost,.corp, 10.0.0.0/8' })).toEqual({
    upstream: { kind: 'http', host: 'proxy.corp', port: 8080, bypass: ['localhost', '.corp', '10.0.0.0/8'] },
    userinfo: false,
    unsupported: false,
    invalid: false,
  })
  expect(upstreamFromEnv({ all_proxy: 'socks5h://127.0.0.1:7890' }).upstream).toEqual({ kind: 'socks5', host: '127.0.0.1', port: 7890, bypass: [] })
  expect(upstreamFromEnv({ https_proxy: '127.0.0.1:7890' }).upstream).toEqual({ kind: 'http', host: '127.0.0.1', port: 7890, bypass: [] })
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://[::1]:3128' }).upstream?.host).toBe('::1')
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://proxy.corp' }).upstream?.port).toBe(80)
  expect(upstreamFromEnv({ ALL_PROXY: 'socks5://proxy.corp' }).upstream?.port).toBe(1080)
  // Credentials aren't used (and say so); the next one is.
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://user:secret@proxy.corp:8080', ALL_PROXY: 'socks5://127.0.0.1:7890' })).toEqual({ upstream: { kind: 'socks5', host: '127.0.0.1', port: 7890, bypass: [] }, userinfo: true, unsupported: false, invalid: false })
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://user:secret@proxy.corp:8080' })).toEqual({ upstream: null, userinfo: true, unsupported: false, invalid: false })
  // Schemes the window's proxy doesn't speak, and what's no address at all, aren't used, and say so.
  expect(upstreamFromEnv({ HTTPS_PROXY: 'https://proxy.corp:443' })).toEqual({ upstream: null, userinfo: false, unsupported: true, invalid: false })
  expect(upstreamFromEnv({ ALL_PROXY: 'socks4://proxy.corp:1080' })).toEqual({ upstream: null, userinfo: false, unsupported: true, invalid: false })
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://proxy.corp:99999' })).toEqual({ upstream: null, userinfo: false, unsupported: false, invalid: true })
  // A host the URL parser takes goes on to the window's proxy, which leaves out one it can't take and says so itself.
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://bad_host-:8080' })).toEqual({ upstream: { kind: 'http', host: 'bad_host-', port: 8080, bypass: [] }, userinfo: false, unsupported: false, invalid: false })
  expect(upstreamFromEnv({ HTTPS_PROXY: 'https://proxy.corp:443', ALL_PROXY: 'socks5://127.0.0.1:7890' }).upstream?.kind).toBe('socks5')
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://PROXY.Corp.:8080' }).upstream?.host).toBe('proxy.corp')
  expect(upstreamFromEnv({}).upstream).toBeNull()
  expect(upstreamFromEnv({ no_proxy: 'a.test\u202e,b.test', HTTPS_PROXY: 'http://p:1' }).upstream?.bypass).toEqual(['a.test', 'b.test'])
})

test('a variable set to nothing counts as unset, as curl takes it: the lowercase one or the next is used', () => {
  expect(upstreamFromEnv({ HTTPS_PROXY: '', https_proxy: 'http://proxy.corp:8080' }).upstream).toEqual({ kind: 'http', host: 'proxy.corp', port: 8080, bypass: [] })
  expect(upstreamFromEnv({ HTTPS_PROXY: '', https_proxy: '', ALL_PROXY: 'socks5://127.0.0.1:7890' }).upstream).toEqual({ kind: 'socks5', host: '127.0.0.1', port: 7890, bypass: [] })
  expect(upstreamFromEnv({ HTTPS_PROXY: '  ', ALL_PROXY: '', all_proxy: 'socks5://127.0.0.1:7890' }).upstream?.kind).toBe('socks5')
  expect(upstreamFromEnv({ HTTPS_PROXY: '', https_proxy: '', ALL_PROXY: '', all_proxy: '' })).toEqual({ upstream: null, userinfo: false, unsupported: false, invalid: false })
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://p:1', NO_PROXY: '', no_proxy: 'a.test,.corp' }).upstream?.bypass).toEqual(['a.test', '.corp'])
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://p:1', NO_PROXY: ' ', no_proxy: 'b.test' }).upstream?.bypass).toEqual(['b.test'])
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://p:1', NO_PROXY: '', no_proxy: '' }).upstream?.bypass).toEqual([])
  // One set to something is used even when the lowercase one says otherwise.
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://p:1', NO_PROXY: 'c.test', no_proxy: 'd.test' }).upstream?.bypass).toEqual(['c.test'])
})

test("the person's exceptions stay small: 64 at most, none over 253 characters, 6 KiB in all, nothing JSON would escape", () => {
  const many = Array.from({ length: 100 }, (_, i) => `host${i}.corp.example`).join(',')
  const bypass = upstreamFromEnv({ HTTPS_PROXY: 'http://p:1', NO_PROXY: many }).upstream!.bypass
  expect(bypass).toHaveLength(64)
  expect(bypass[0]).toBe('host0.corp.example')
  const long = `${'a'.repeat(254)},ok.test,${'b'.repeat(253)}`
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://p:1', NO_PROXY: long }).upstream!.bypass).toEqual(['ok.test', 'b'.repeat(253)])
  const big = Array.from({ length: 60 }, (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(200)}`).join(',')
  const sized = upstreamFromEnv({ HTTPS_PROXY: 'http://p:1', NO_PROXY: big }).upstream!.bypass
  expect(sized.reduce((n, e) => n + e.length + 3, 0)).toBeLessThanOrEqual(6144)
  expect(JSON.stringify({ port: 0, controlToken: 'x'.repeat(43), lan: false, upstream: { kind: 'http', host: 'p', port: 1, bypass: sized } }).length).toBeLessThan(8192)
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://p:1', NO_PROXY: 'a"b,c\\d,ok.test,*.corp,10.0.0.0/8,<local>,[::1]' }).upstream!.bypass).toEqual(['ok.test', '*.corp', '10.0.0.0/8', '<local>', '[::1]'])
})

// The window's proxy takes an upstream's host only as an IP literal or a
// plain host name (relay/browser-proxy.mts, `address` and `hostname`), and
// leaves out one it can't take, saying so (test/browser-proxy.test.ts). Here
// it's only split from its URL: its brackets, case and trailing dot go, and
// one the URL parser takes no host from isn't used, so the next one is.
test("an upstream's address is split by the URL parser alone: one it takes no host from isn't used, and the next one is", () => {
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://[::1]:3128' }).upstream?.host).toBe('::1')
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://Proxy.Corp.Example.:8080' }).upstream?.host).toBe('proxy.corp.example')
  // A socks5:// URL's host is kept as written: lowercased here.
  expect(upstreamFromEnv({ ALL_PROXY: 'socks5://My_Proxy.Corp:1080' }).upstream).toEqual({ kind: 'socks5', host: 'my_proxy.corp', port: 1080, bypass: [] })
  // A URL's own parse writes an IPv4 tail in hex, which the proxy takes too.
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://[::ffff:10.0.0.1]:8080' }).upstream?.host).toBe('::ffff:a00:1')
  // Hosts the URL parser takes that the window's proxy doesn't: its to say.
  for (const host of ['-bad.corp', 'a..b', '*.corp']) expect(upstreamFromEnv({ HTTPS_PROXY: `http://${host}:8080` }).upstream?.host).toBe(host)
  // No host the URL parser takes: not used, said, and the next one is.
  for (const raw of ['http://[1.2.3.4::]:8080', 'http://bad host:8080', 'http://:8080', 'socks5:///', 'http://256.1.1.1:8080', 'http://[fe80::1%25en0]:8080', 'http://proxy.corp:abc']) {
    expect([raw, upstreamFromEnv({ HTTPS_PROXY: raw })]).toEqual([raw, { upstream: null, userinfo: false, unsupported: false, invalid: true }])
  }
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://bad host:8080', ALL_PROXY: 'socks5://127.0.0.1:7890' })).toEqual({ upstream: { kind: 'socks5', host: '127.0.0.1', port: 7890, bypass: [] }, userinfo: false, unsupported: false, invalid: true })
  // Port 0 is no port.
  expect(upstreamFromEnv({ HTTPS_PROXY: 'http://proxy.corp:0' }).invalid).toBe(true)
})

test("macOS's proxy settings: HTTPS, else SOCKS, with its exceptions; a PAC file isn't followed", () => {
  const scutil = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7891
  SOCKSProxy : 127.0.0.1
}`
  expect(upstreamFromScutil(scutil)).toEqual({ upstream: { kind: 'http', host: '127.0.0.1', port: 7890, bypass: ['*.local', '169.254/16'] }, pac: false, invalid: false })
  expect(upstreamFromScutil(scutil.replace('HTTPSEnable : 1', 'HTTPSEnable : 0')).upstream).toEqual({ kind: 'socks5', host: '127.0.0.1', port: 7891, bypass: ['*.local', '169.254/16'] })
  expect(upstreamFromScutil('<dictionary> {\n  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://wpad/proxy.pac\n}')).toEqual({ upstream: null, pac: true, invalid: false })
  expect(upstreamFromScutil('<dictionary> {\n  HTTPEnable : 0\n}')).toEqual({ upstream: null, pac: false, invalid: false })
})

test("macOS's proxy given as a URL is taken without its scheme and path; one that's no address at all is left out", () => {
  const https = (host: string, port = '8080') => `<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : ${port}\n  HTTPSProxy : ${host}\n}`
  expect(upstreamFromScutil(https('http://proxy.corp.example/')).upstream).toEqual({ kind: 'http', host: 'proxy.corp.example', port: 8080, bypass: [] })
  expect(upstreamFromScutil(https('https://Proxy.Corp.Example:8443/path?x=1')).upstream?.host).toBe('proxy.corp.example')
  expect(upstreamFromScutil(https('[::1]')).upstream?.host).toBe('::1')
  expect(upstreamFromScutil(https('proxy.corp.example.')).upstream?.host).toBe('proxy.corp.example')
  expect(upstreamFromScutil(https('::1')).upstream?.host).toBe('::1')
  expect(upstreamFromScutil(https('bad host'))).toEqual({ upstream: null, pac: false, invalid: true })
  // A host the URL parser takes goes on to the window's proxy, which says itself what it can't take.
  expect(upstreamFromScutil(https('-bad.corp'))).toEqual({ upstream: { kind: 'http', host: '-bad.corp', port: 8080, bypass: [] }, pac: false, invalid: false })
  // An invalid HTTPS proxy, a valid SOCKS one: the SOCKS one, nothing to say.
  expect(upstreamFromScutil(`${https('bad host').replace(/\n}$/, '')}\n  SOCKSEnable : 1\n  SOCKSPort : 7891\n  SOCKSProxy : 127.0.0.1\n}`)).toEqual({ upstream: { kind: 'socks5', host: '127.0.0.1', port: 7891, bypass: [] }, pac: false, invalid: false })
})
