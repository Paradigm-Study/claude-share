// A preview's address as the host gave it, what a page uses beside it, and
// what the host's discovery found: the pure parts both sides use. Run with
// `claude plugin test plugin`.

import { expect, test } from 'claude-code/testing'
import {
  alsoUses,
  ASK_PORTS,
  cleanLabel,
  debuggerAnswer,
  dependencyFor,
  dependencyOf,
  dependencyTitle,
  discoverResult,
  everyName,
  everyService,
  heldResult,
  pageLook,
  previewHost,
  previewScheme,
  previewUrl,
  questionsOf,
  relayedResult,
  rootMissing,
  serviceName,
  servicesOf,
  shareTooWords,
  urlHost,
  urlScheme,
} from '../hooks/preview'

test("the host's spelling of loopback is kept; 0.0.0.0 opens as localhost", () => {
  expect(previewHost('localhost')).toBe('localhost')
  expect(previewHost('0.0.0.0')).toBe('localhost')
  expect(previewHost('127.0.0.1')).toBe('127.0.0.1')
  expect(previewHost('::1')).toBe('[::1]')
  expect(previewHost('[::1]')).toBe('[::1]')
  expect(previewHost('example.com')).toBeUndefined()
  expect(urlHost('http://127.0.0.1:3000/app')).toBe('127.0.0.1')
  expect(urlHost('http://[::1]:3000')).toBe('[::1]')
  expect(urlHost('http://0.0.0.0:3000/')).toBe('localhost')
  expect(urlHost('http://localhost.evil.test:3000/')).toBeUndefined()
  expect(previewUrl('127.0.0.1', 3000, '/login?next=%2F')).toBe('http://127.0.0.1:3000/login?next=%2F')
  expect(previewUrl(undefined, 3000)).toBe('http://localhost:3000/')
  expect(previewUrl('evil.test', 3000, 'javascript:alert(1)')).toBe('http://localhost:3000/')
})

test('an https preview keeps its scheme; anything else is http', () => {
  expect(urlScheme('https://localhost:3000/app')).toBe('https')
  expect(urlScheme('HTTPS://127.0.0.1:3000')).toBe('https')
  expect(urlScheme('http://localhost:3000/')).toBeUndefined()
  expect(previewScheme('https')).toBe('https')
  for (const value of ['http', 'HTTPS', 'ftp', undefined, 1]) expect(previewScheme(value)).toBeUndefined()
  expect(previewUrl('localhost', 3000, '/login', 'https')).toBe('https://localhost:3000/login')
  expect(previewUrl('[::1]', 8443, undefined, 'https')).toBe('https://[::1]:8443/')
  expect(previewUrl('localhost', 3000, '/', 'javascript')).toBe('http://localhost:3000/')
})

test("discovery's answer: web servers beside the shared one, six at most, labels made safe", () => {
  const related = Array.from({ length: 9 }, (_, i) => ({ port: 3600 + i, label: `svc-${i}`, web: i === 1 ? 'no' : 'yes', devtools: i === 2 }))
  const found = discoverResult(
    JSON.stringify({
      state: 'done',
      platform: 'darwin',
      target: { port: 3000, label: 'next-server\u202e', web: 'yes', devtools: false },
      related: [...related, related[0]],
    }),
  )
  expect(found?.target).toEqual({ port: 3000, label: 'next-server', web: 'yes', devtools: false })
  expect(found?.related.map(s => s.port)).toEqual([3600, 3603, 3604, 3605, 3606, 3607])
  expect(discoverResult('{"state":"error","code":"EPERM"}')).toBeNull()
  expect(discoverResult(JSON.stringify({ state: 'done', platform: 'linux', target: null, related: [] }))).toEqual({
    platform: 'linux',
    target: null,
    related: [],
  })
  expect(cleanLabel('a\nb\u0007c'.repeat(30)).length).toBeLessThanOrEqual(40)
  expect(serviceName({ port: 3610, label: 'convex-local-backend' })).toBe('localhost:3610 · convex-local-backend')
  expect(serviceName({ port: 3610, label: '' })).toBe('localhost:3610')
  // A yes forwards every one, so every one is named: never "+2 more".
  expect(
    alsoUses([
      { port: 3610, label: 'convex-local-backend' },
      { port: 3611, label: '' },
      { port: 27017, label: 'mongod' },
    ]),
  ).toBe('localhost:3610 · convex-local-backend, localhost:3611 and localhost:27017 · mongod')
  expect(
    alsoUses([
      { port: 3610, label: 'convex-local-backend' },
      { port: 3611, label: 'api' },
    ]),
  ).toBe('localhost:3610 · convex-local-backend and localhost:3611 · api')
  expect(alsoUses([{ port: 3610, label: 'convex-local-backend' }])).toBe('localhost:3610 · convex-local-backend')
  expect(everyName([])).toBe('')
})

test("who holds a port: one of the plugin's helpers, something else or nothing, or it can't tell", () => {
  const said = (target: unknown, platform = 'darwin') => JSON.stringify({ state: 'done', platform, target, related: [] })
  expect(relayedResult(said({ port: 3009, label: 'local-preview.cjs', relay: true }), 3009)).toBe(true)
  expect(relayedResult(said({ port: 3009, label: 'next-server', relay: false }), 3009)).toBe(false)
  expect(relayedResult(said(null), 3009)).toBe(false)
  // A holder it couldn't read, another port, another platform, anything else: it can't tell.
  expect(relayedResult(said({ port: 3009, label: 'node', relay: null }), 3009)).toBeUndefined()
  expect(relayedResult(said({ port: 3010, label: 'node', relay: true }), 3009)).toBeUndefined()
  expect(relayedResult(said(null, 'unsupported'), 3009)).toBeUndefined()
  expect(relayedResult('{"state":"error","code":"INVALID_CONFIG"}', 3009)).toBeUndefined()
  expect(relayedResult('not json', 3009)).toBeUndefined()
  // Ordinary discovery's answer (no `relay`) says nothing of it either.
  expect(relayedResult(said({ port: 3009, label: 'next-server', web: 'yes', devtools: false }), 3009)).toBeUndefined()
})

test("a need's look at a port: what runs there, what it answers, and who holds it when that's known", () => {
  const said = (target: unknown) => JSON.stringify({ state: 'done', platform: 'darwin', target, related: [] })
  expect(heldResult(said({ port: 3610, label: 'convex-local-backend', relay: false, web: 'yes', devtools: false }), 3610)).toEqual({
    port: 3610,
    label: 'convex-local-backend',
    relay: false,
    web: 'yes',
    devtools: false,
  })
  expect(heldResult(said({ port: 3610, label: 'local-preview.cjs', relay: true, web: 'slow', devtools: false }), 3610)).toMatchObject({
    relay: true,
    web: 'slow',
  })
  // A holder it couldn't read: no `relay`, the rest as said.
  expect(heldResult(said({ port: 9222, label: 'Google Chrome\u202e', relay: null, web: 'yes', devtools: true }), 9222)).toEqual({
    port: 9222,
    label: 'Google Chrome',
    web: 'yes',
    devtools: true,
  })
  // Nobody there, another port, or anything else: nothing.
  expect(heldResult(said(null), 3610)).toBeNull()
  expect(heldResult(said({ port: 3611, label: 'api', relay: false, web: 'yes', devtools: false }), 3610)).toBeNull()
  expect(heldResult('{"state":"error","code":"INVALID_CONFIG"}', 3610)).toBeNull()
  expect(heldResult('not json', 3610)).toBeNull()
})

test('what discovery found is asked about by service: one process, else one label; every port before the label', () => {
  const found = discoverResult(
    JSON.stringify({
      state: 'done',
      platform: 'darwin',
      target: null,
      related: [
        { port: 3510, label: 'convex-local-backend', web: 'yes', pid: 4242 },
        { port: 3511, label: 'convex-local-backend', web: 'yes', pid: 4242 },
        { port: 3512, label: 'x', web: 'yes', pid: -1 },
        { port: 3513, label: 'x', web: 'yes', pid: 1.5 },
      ],
    }),
  )
  // A pid discovery gives is kept, one that's no pid isn't.
  expect(found?.related.map(s => s.pid)).toEqual([4242, 4242, undefined, undefined])
  const s = (port: number, label: string, pid?: number) => ({ port, label, ...(pid ? { pid } : {}) })
  // By pid where discovery says; the same label in two processes is two services.
  expect(servicesOf([s(3510, 'server.js', 1), s(3511, 'server.js', 2), s(3512, 'server.js', 1)]).map(g => g.map(x => x.port))).toEqual([[3510, 3512], [3511]])
  // Else by label, in the order found; no label, or one discovery couldn't name, is a service alone.
  expect(
    servicesOf([
      s(3510, 'convex-local-backend'),
      s(3611, 'api'),
      s(3511, 'convex-local-backend'),
      s(4000, ''),
      s(4001, ''),
      s(5000, 'unknown'),
      s(5001, 'unknown'),
    ]).map(g => g.map(x => x.port)),
  ).toEqual([[3510, 3511], [3611], [4000], [4001], [5000], [5001]])
  // Every port before the label, so a row too narrow cuts the label first.
  expect(alsoUses([s(3510, 'convex-local-backend'), s(3511, 'convex-local-backend')])).toBe('localhost:3510 and 3511 · convex-local-backend')
  expect(alsoUses([s(3510, 'x'), s(3511, 'x'), s(3512, 'x')])).toBe('localhost:3510, 3511 and 3512 · x')
  // A comma before the last "and" once a service has several ports; none needed otherwise.
  expect(alsoUses([s(3510, 'convex-local-backend'), s(3511, 'convex-local-backend'), s(3611, 'api')])).toBe(
    'localhost:3510 and 3511 · convex-local-backend, and localhost:3611 · api',
  )
  expect(everyService([[s(3510, 'convex-local-backend'), s(3511, 'convex-local-backend')], [s(3611, 'api')]], false)).toBe(
    'localhost:3510 and 3511, and localhost:3611',
  )
  expect(everyService([[s(3610, 'a')], [s(3611, 'b')]], false)).toBe('localhost:3610 and localhost:3611')
})

test('a question names first every port its yes forwards, three at most, then what runs there and the page', () => {
  const s = (port: number, label = 'convex-local-backend') => ({ port, label })
  // A service a question; one on more ports, a question each three, in order.
  expect(ASK_PORTS).toBe(3)
  expect(questionsOf([[1, 2], [3, 4, 5, 6, 7], [8]])).toEqual([[1, 2], [3, 4, 5], [6, 7], [8]])
  expect(questionsOf([[1, 2, 3, 4, 5, 6]])).toEqual([
    [1, 2, 3],
    [4, 5, 6],
  ])
  expect(questionsOf([])).toEqual([])
  expect(shareTooWords(3009, [s(3510), s(3511)])).toBe('Share localhost:3510 and 3511 too? convex-local-backend, beside localhost:3009')
  expect(shareTooWords(3009, [s(3510), s(3511), s(3512)])).toBe('Share localhost:3510, 3511 and 3512 too? convex-local-backend, beside localhost:3009')
  // Nothing to call it (no label, or one discovery couldn't name): where it was found.
  expect(shareTooWords(3009, [s(4000, ''), s(4001, 'unknown')])).toBe('Share localhost:4000 and 4001 too? Found beside localhost:3009')
  // A question asked before a service was one process: every label it holds.
  expect(shareTooWords(3340, [s(3610), s(3611, 'api')])).toBe('Share localhost:3610 and 3611 too? convex-local-backend and api, beside localhost:3340')
  // Up to its last port, a question fits the 41 columns an 80-column
  // terminal's row gives its words, five-digit ports and all.
  const questions = questionsOf([[65535, 65534, 65533, 65532, 65531, 65530, 65529].map(port => s(port))])
  expect(questions.map(q => q.length)).toEqual([3, 3, 1])
  for (const question of questions) {
    const words = shareTooWords(65000, question)
    expect(words.slice(0, words.indexOf(' too?'))).toBe(`Share localhost:${everyName(question.map(q => String(q.port)))}`)
    expect(words.indexOf(' too?')).toBeLessThanOrEqual(41)
  }
})

test("a dependency names the page that uses it, or none when that isn't known", () => {
  expect(dependencyOf(61198)).toBe(61198)
  expect(dependencyOf(true)).toBe(true)
  for (const value of [undefined, null, false, 0, 65536, 3.5, '61198', {}]) expect(dependencyOf(value)).toBeUndefined()
  expect(dependencyTitle(61199, 'host-api.cjs')).toBe('localhost:61199 (host-api.cjs)')
  expect(dependencyTitle(61199)).toBe('localhost:61199')
  expect(dependencyFor(61198)).toBe('for the preview of localhost:61198')
  expect(dependencyFor(true)).toBe('for previews')
})

test("a look at a port's `/` shares a page, never an API, a 404, a debugger or what isn't HTTP", () => {
  const said = (exit: number, code: string, version = '') => `exit=${exit}\ncode=${code}\n${code === '000' ? '' : `--\n${version}`}`
  const inspector = '{"Browser":"node.js/v24.1.0","Protocol-Version":"1.1"}'
  expect(pageLook(said(0, '200 text/html; charset=utf-8'))).toBe('page')
  expect(pageLook(said(0, '200 application/xhtml+xml'))).toBe('page')
  expect(pageLook(said(0, '401 TEXT/HTML'))).toBe('page')
  expect(pageLook(said(0, '302 '))).toBe('page')
  // A dev server still compiling its first page holds the connection: a page.
  expect(pageLook(said(28, '000'))).toBe('page')
  // Headers in, the body slow: what it said decides.
  expect(pageLook(said(28, '200 application/json'))).toBe('not')
  expect(pageLook(said(0, '200 application/json', '{"ok":true}'))).toBe('not')
  expect(pageLook(said(0, '200 text/plain'))).toBe('not')
  expect(pageLook(said(0, '404 text/html', 'Cannot GET /json/version'))).toBe('not')
  expect(pageLook(said(0, '101 '))).toBe('not')
  // A database or a cache: an empty or garbled reply.
  expect(pageLook(said(52, '000'))).toBe('not')
  expect(pageLook(said(1, '000'))).toBe('not')
  // Nothing there yet, a server error, or the look didn't run: later.
  expect(pageLook(said(7, '000'))).toBe('later')
  expect(pageLook(said(6, '000'))).toBe('later')
  expect(pageLook(said(0, '503 text/html'))).toBe('later')
  expect(pageLook('')).toBe('later')
  // A debugger, whatever its `/` says.
  expect(pageLook(said(0, '400 text/html; charset=UTF-8', inspector))).toBe('not')
  expect(pageLook(said(0, '200 text/html', '{"webSocketDebuggerUrl":"ws://x"}'))).toBe('not')
  // Opened by Claude: shared whatever it is, but a debugger or what isn't HTTP.
  expect(pageLook(said(0, '200 application/json', '{}'), true)).toBe('page')
  expect(pageLook(said(0, '404 text/html'), true)).toBe('page')
  expect(pageLook(said(7, '000'), true)).toBe('page')
  expect(pageLook('', true)).toBe('page')
  expect(pageLook(said(0, '400 text/html', inspector), true)).toBe('not')
  expect(pageLook(said(52, '000'), true)).toBe('not')
  expect(debuggerAnswer('[]')).toBe(false)
  expect(debuggerAnswer('not json')).toBe(false)
})

test("a `/` that's an HTML 404 sends the look to the page Claude gave out", () => {
  expect(rootMissing('exit=0\ncode=404 text/html; charset=utf-8\n--\n')).toBe(true)
  expect(rootMissing('exit=0\ncode=404 application/json\n--\n')).toBe(false)
  expect(rootMissing('exit=0\ncode=400 text/html\n--\n')).toBe(false)
  expect(rootMissing('exit=7\ncode=000\n')).toBe(false)
})
