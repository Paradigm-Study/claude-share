// The public link's answers, the pure parts: an answer's head from what curl
// wrote, a request's Origin and Referer at the preview's own address, and
// the plugin's own pages. Run with `claude plugin test plugin`.

import { expect, test } from 'claude-code/testing'
import { curlString, localHeaders, pageHead, PROXY_HEAD_MAX, proxyHead, proxyPage } from '../hooks/proxy'

// Bytes as curl's -D writes them, base64 as the fetch prints them.
const dump = (text: string) => btoa(text)

test("an answer's head is the last response's headers, each value's bytes kept, all of it ASCII", () => {
  const raw = 'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/html\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nX-Name: cafÃ©\r\nX-Latin: été\r\n\r\n'
  const head = proxyHead(200, dump(raw))!
  expect(/^[\x20-\x7e]+$/.test(head)).toBe(true)
  expect(JSON.parse(head)).toEqual({
    status: 200,
    headers: [['Content-Type', 'text/html'], ['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2'], ['X-Name', 'cafÃ©'], ['X-Latin', 'été']],
  })
  // The 100 Continue's block is passed over, the final one counts.
  expect(head).not.toContain('Continue')
})

test("an answer's head leaves out what no Headers would take, and is null without a response in it", () => {
  const raw = 'HTTP/2 302 \r\nlocation: http://localhost:3000/login\r\n folded: on\r\nbad name: x\r\n: empty\r\nx-cr: a\rb\r\nvalue-trim:  spaced \t\r\n\r\n'
  expect(JSON.parse(proxyHead(302, dump(raw))!).headers).toEqual([['location', 'http://localhost:3000/login'], ['value-trim', 'spaced']])
  expect(proxyHead(200, dump(''))).toBeNull()
  expect(proxyHead(200, dump('not a response\r\n\r\n'))).toBeNull()
  expect(proxyHead(200, '%%% not base64')).toBeNull()
  // A status no browser can be given goes as the caller's page instead.
  expect(proxyHead(0, dump('HTTP/1.1 200 OK\r\n\r\n'))).toBeNull()
  expect(proxyHead(101, dump('HTTP/1.1 101 Switching\r\n\r\n'))).toBeNull()
  expect(JSON.parse(proxyHead(204, dump('HTTP/1.1 204 No Content\r\n\r\n'))!)).toEqual({ status: 204, headers: [] })
})

test("a head past the room's 64 KiB is the caller's to see", () => {
  const raw = `HTTP/1.1 200 OK\r\nset-cookie: ${'a'.repeat(PROXY_HEAD_MAX)}\r\n\r\n`
  expect(proxyHead(200, dump(raw))!.length > PROXY_HEAD_MAX).toBe(true)
})

test("a request reaches the host's localhost as from the preview's own page", () => {
  const local = 'https://localhost:3340'
  const asked = [
    ['Origin', 'https://preview.example.dev'],
    ['Referer', 'https://preview.example.dev/app/page?x=1#top'],
    ['cookie', 'session=abc'],
    ['content-type', 'application/x-www-form-urlencoded'],
    ['broken'],
    'nothing',
  ]
  expect(localHeaders(asked, local)).toEqual([
    ['Origin', 'https://localhost:3340'],
    ['Referer', 'https://localhost:3340/app/page?x=1'],
    ['cookie', 'session=abc'],
    ['content-type', 'application/x-www-form-urlencoded'],
  ])
  // An opaque origin the browser chose stays one; a Referer that isn't a URL is the page's root.
  expect(localHeaders([['origin', 'null'], ['referer', 'not a url']], 'http://localhost:3000')).toEqual([['origin', 'null'], ['referer', 'http://localhost:3000/']])
})

test("the plugin's own pages: their head, nothing unescaped", () => {
  expect(JSON.parse(pageHead(503))).toEqual({ status: 503, headers: [['content-type', 'text/html; charset=utf-8']] })
  const page = proxyPage('The preview is busy', 'Sam <b>& co</b> "here"')
  expect(page.startsWith('<!doctype html>')).toBe(true)
  expect(page).toContain('Sam &lt;b&gt;&amp; co&lt;/b&gt; &quot;here&quot;')
  expect(page).not.toContain('\n')
})

test("a body in a curl config's quotes keeps every character", () => {
  expect(curlString('{"status":503}\n<p>a\\b</p>\t\r\v')).toBe('"{\\"status\\":503}\\n<p>a\\\\b</p>\\t\\r\\v"')
})
