// Preview windows: a guest's Open of a forwarded preview opens the host's own
// address in a separate browser window, whose localhost goes through the
// plugin's proxy to what the host shares.

import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { DETACHED } from '../hooks/window'
import {
  LINK,
  band,
  world,
  eventually,
  PREVIEW_PEOPLE,
  LOCAL_SHOWN,
  START,
  checkpointPath,
  savedAt,
  CHROME,
  WINDOW_SHOWN,
  WINDOW_URL,
  roomProfile,
  windowWorld,
  roomPane,
  routesOf,
  tunnels,
  tunnelUnstarted,
  openedInWindow,
  SIGNED_IN,
  hostProfilePath,
  looks,
  LOOK_UNKNOWN,
  FIREFOX,
  firefoxWorld,
  DEP_SHOWN,
  autoWorld,
  localWorld,
  PAGE_B,
  paneCalls,
  LOCAL_URL,
  localStream,
  HOST_FROM,
  within,
  removedProfiles,
} from './support/world'

test("Open preview opens the host's own address in a separate window, through a proxy, with no credentials", async ($, on) => {
  const asked = windowWorld(on)
  const pane: string[] = []
  on('mcp.call', ($, e) => {
    if (e.server === 'Claude_Browser') pane.push(String(e.args?.url))
    return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } } as never
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ key: 'open-preview' }))?.props.label).toBe('Open preview')
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(10)
  const profile = await roomProfile()
  expect(asked.launches[0]).toEqual([
    'open',
    '-n',
    '-a',
    CHROME,
    '--args',
    `--user-data-dir=${profile}/chrome`,
    '--proxy-server=socks5://127.0.0.1:47100',
    '--proxy-bypass-list=<-loopback>',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    '--use-mock-keychain',
    WINDOW_URL,
  ])
  const argv = JSON.stringify(asked.launches[0])
  for (const secret of ['"g"', 'ticket', 'Bearer', 'ignore-certificate-errors']) expect(argv).not.toContain(secret)
  expect(pane).toHaveLength(0)
  // Its tunnel takes a port the system picks: no host port is taken here.
  expect(tunnels(asked)).toHaveLength(1)
  expect(tunnels(asked)[0]).toMatchObject({ port: 0, strict: false })
  // The proxy knows its port, its control secret, whether it may reach this
  // computer's network and the person's own proxy, nothing of the room.
  const proxy = asked.proxies[0]!
  expect(Object.keys(proxy.config).sort()).toEqual(['controlToken', 'lan', 'port', 'upstream'])
  expect(proxy.config.lan).toBe(false)
  expect(proxy.config.port).toBe(0)
  expect(proxy.config.controlToken).toMatch(/^[0-9a-f]{64}$/)
  expect(proxy.config.upstream).toBeNull()
  expect(proxy.routes[0]).toEqual({ routes: {}, startable: [3340] })
  expect(routesOf(asked)).toEqual({ routes: { '3340': 45001 }, startable: [] })
  expect(asked.toasted).toContain(
    "Opened Sam's localhost:3340 in a separate Google Chrome window. In it, localhost reaches only what Sam shares; your own servers aren't touched.",
  )
  // The profile is private, and no listener is saved for this computer's localhost.
  expect(asked.spawned.some(s => s.input?.startsWith('umask 077') && s.input.includes(profile))).toBe(true)
  expect(asked.state.localPreviews ?? []).toEqual([])
  expect(asked.state.previewWindow).toEqual({
    room: 'https://share.test/room0000000000000001',
    port: 47100,
    opened: ['pv-local'],
    profile: profile.split('/').pop(),
  })
  // Open, it leaves the row above the prompt.
  expect(await ui.find({ key: 'open-preview' })).toBeUndefined()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a signed-in host's rooms share one window profile: Leave closes this session's window and keeps the profile", async ($, on) => {
  const asked = windowWorld(on, { stream: [{ seq: 2, events: [WINDOW_SHOWN], people: SIGNED_IN, ended: false, title: 'demo' }] })
  await openedInWindow($, asked)
  const profile = await hostProfilePath()
  expect(asked.launches[0]).toContain(`--user-data-dir=${profile}/chrome`)
  expect(asked.state.previewWindow?.profile).toBe(profile.split('/').pop())
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  await asked.clock.advance(50)
  expect(asked.windowState.alive).toBe(false)
  // Only the window on this session's proxy port closes; the profile stays.
  expect(asked.spawned.filter(s => s.input?.startsWith('# shared-session: close the preview window') && s.input.includes(profile)).at(-1)?.input).toContain(
    'w=47100',
  )
  expect(removedProfiles(asked)).toHaveLength(0)
})

test("another session's window on the host's profile is left alone: this session opens the room's own", async ($, on) => {
  const other = await hostProfilePath()
  const asked = windowWorld(on, {
    stream: [{ seq: 2, events: [WINDOW_SHOWN], people: SIGNED_IN, ended: false, title: 'demo' }],
    windowOpen: { profile: other, port: 47999 },
  })
  await openedInWindow($, asked)
  const own = await roomProfile()
  expect(asked.windowState.kills).toBe(0)
  expect(asked.launches[0]).toContain(`--user-data-dir=${own}/chrome`)
  expect(asked.state.previewWindow?.profile).toBe(own.split('/').pop())
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  await asked.clock.advance(50)
  // The room's own profile goes with the room; the host's stays.
  expect(removedProfiles(asked).some(s => s.input?.includes(`p='${own}'`))).toBe(true)
  expect(removedProfiles(asked).some(s => s.input?.includes(`p='${other}'`))).toBe(false)
})

// Two sessions of this person's, in two of the host's rooms, could start a
// window on the host's one profile at once: each takes it first, and holds
// it from its look there through the start.
const lockTakes = (asked: ReturnType<typeof world>) => asked.spawned.filter(s => s.input?.startsWith('# shared-session: take a preview profile'))

const lockDone = (asked: ReturnType<typeof world>) => asked.spawned.filter(s => s.input?.startsWith('# shared-session: done starting'))

const lockToken = (input?: string) =>
  /^\[ "\$\(cat "\$l\/owner" 2>\/dev\/null\)" = '([0-9a-f]+)' \]/m.exec(input ?? '')?.[1] ??
  /^printf '%s\\n' '([0-9a-f]+)' > "\$l\/owner"/m.exec(input ?? '')?.[1]

const probed = (asked: ReturnType<typeof world>, profile: string) =>
  asked.spawned.findIndex(s => s.input?.startsWith('# shared-session: is the preview window open') && s.input.includes(`held '${profile}'`))

test("a host's profile is held from the look there through the start, and let go once the window is seen", async ($, on) => {
  let atLaunch = -1
  const asked = windowWorld(on, {
    stream: [{ seq: 2, events: [WINDOW_SHOWN], people: SIGNED_IN, ended: false, title: 'demo' }],
    beforeLaunch: async () => {
      atLaunch = lockDone(asked).length
    },
  })
  const pane = await openedInWindow($, asked)
  const host = await hostProfilePath()
  expect(asked.launches[0]).toContain(`--user-data-dir=${host}/chrome`)
  const take = asked.spawned.indexOf(lockTakes(asked)[0]!),
    prefs = asked.spawned.findIndex(s => s.input?.startsWith('# shared-session: chrome preferences') && s.input.includes(host))
  // Taken before the look, the look and the settings under it, still held as the browser starts, let go after.
  expect(take).toBeGreaterThanOrEqual(0)
  expect(lockTakes(asked)[0]!.input).toContain(`p='${host}'`)
  expect(take).toBeLessThan(probed(asked, host))
  expect(probed(asked, host)).toBeLessThan(prefs)
  expect(atLaunch).toBe(0)
  expect(lockDone(asked)).toHaveLength(1)
  expect(asked.spawned.indexOf(lockDone(asked)[0]!)).toBeGreaterThan(prefs)
  // Let go with the secret it was taken with, and only that.
  expect(lockToken(lockDone(asked)[0]!.input)).toMatch(/^[0-9a-f]{64}$/)
  expect(lockToken(lockDone(asked)[0]!.input)).toBe(lockToken(lockTakes(asked)[0]!.input))
  // The next page goes to this session's own window there: taken and let go again, nothing written under it.
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.launches.length === 2)
  await asked.clock.advance(10)
  expect(lockTakes(asked)).toHaveLength(2)
  expect(lockDone(asked)).toHaveLength(2)
  expect(lockToken(lockTakes(asked)[1]!.input)).not.toBe(lockToken(lockTakes(asked)[0]!.input))
  expect(asked.launches[1]).toEqual(asked.launches[0])
  expect(asked.spawned.filter(s => s.input?.startsWith('# shared-session: chrome preferences'))).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a host's profile another session of this person's is starting a window on: waited for a moment, then the room's own opens", async ($, on) => {
  const launchLockHeld = { count: 99 }
  const asked = windowWorld(on, { stream: [{ seq: 2, events: [WINDOW_SHOWN], people: SIGNED_IN, ended: false, title: 'demo' }], launchLockHeld })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  // Not before the two seconds' wait.
  await asked.clock.advance(1_500)
  expect(asked.launches).toHaveLength(0)
  await within(asked.clock, () => asked.launches.length, 3_000)
  await asked.clock.advance(10)
  const host = await hostProfilePath(),
    own = await roomProfile()
  // Asked every half second for two seconds, then the room's own profile.
  expect(lockTakes(asked)).toHaveLength(5)
  expect(lockTakes(asked).every(s => s.input?.includes(`p='${host}'`))).toBe(true)
  expect(asked.launches[0]).toContain(`--user-data-dir=${own}/chrome`)
  expect(asked.state.previewWindow?.profile).toBe(own.split('/').pop())
  // Nothing of the host's profile was looked at, written or started; never taken, so never let go.
  expect(probed(asked, host)).toBe(-1)
  expect(asked.spawned.some(s => s.input?.startsWith('# shared-session: chrome preferences') && s.input.includes(host))).toBe(false)
  expect(lockDone(asked)).toHaveLength(0)
  expect(asked.toasted.some(t => t.startsWith("Opened Sam's localhost:3340 in a separate Google Chrome window"))).toBe(true)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a host's profile let go within the wait, another session's window on it by then: it's left to that window, and the room's own opens", async ($, on) => {
  const host = await hostProfilePath()
  const asked = windowWorld(on, {
    stream: [{ seq: 2, events: [WINDOW_SHOWN], people: SIGNED_IN, ended: false, title: 'demo' }],
    launchLockHeld: { count: 2 },
    windowOpen: { profile: host, port: 47999 },
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await within(asked.clock, () => asked.launches.length, 3_000)
  await asked.clock.advance(10)
  // Busy twice, then taken: the look finds the other session's window, which is left open, and the hold goes at once.
  expect(lockTakes(asked)).toHaveLength(3)
  expect(probed(asked, host)).toBeGreaterThan(asked.spawned.indexOf(lockTakes(asked)[2]!))
  expect(asked.windowState.kills).toBe(0)
  expect(lockDone(asked)).toHaveLength(1)
  expect(asked.spawned.indexOf(lockDone(asked)[0]!)).toBeLessThan(probed(asked, await roomProfile()))
  expect(asked.launches[0]).toContain(`--user-data-dir=${await roomProfile()}/chrome`)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a look at a host's profile that fails once is asked again a moment later: answered, the window opens there as it would have", async ($, on) => {
  const lockFails = { count: 1 }
  const asked = windowWorld(on, { stream: [{ seq: 2, events: [WINDOW_SHOWN], people: SIGNED_IN, ended: false, title: 'demo' }], lockFails })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  const host = await hostProfilePath()
  await eventually(asked.clock, () => looks(asked, host))
  await asked.clock.advance(200)
  // Asked again about 300 ms on, not at once.
  expect(looks(asked, host)).toBe(1)
  expect(asked.launches).toHaveLength(0)
  await within(asked.clock, () => asked.launches.length, 3_000)
  expect(lockFails.count).toBe(0)
  expect(asked.launches[0]).toContain(`--user-data-dir=${host}/chrome`)
  // Never taken for someone else's: the room's own profile isn't looked at.
  expect(probed(asked, await roomProfile())).toBe(-1)
  expect(asked.toasted).not.toContain(LOOK_UNKNOWN)
  // Taken for the look, and let go.
  expect(lockTakes(asked)).toHaveLength(1)
  expect(lockDone(asked)).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a look at the window that never answers is given up in its time: the Open says so, and the next opens the window', async ($, on) => {
  let release!: () => void
  const lockHangs = {
    count: 2,
    release: new Promise<void>(done => {
      release = done
    }),
  }
  const asked = windowWorld(on, { stream: [{ seq: 2, events: [WINDOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }], lockHangs })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  const late = "Couldn't tell whether the preview window is open (the look at its profile took too long). Press Open preview again."
  await asked.clock.advance(14_000)
  expect(asked.toasted).not.toContain(late)
  // Each look given up after 15 s, the second about 300 ms after the first.
  await within(asked.clock, () => asked.toasted.includes(late), 20_000)
  expect(lockHangs.count).toBe(0)
  expect(asked.launches).toHaveLength(0)
  expect(asked.proxies).toHaveLength(0)
  // Nothing held the window's queue: pressed again, the look answers and it opens.
  await ui.press({ key: 'open-preview' })
  await within(asked.clock, () => asked.launches.length, 3_000)
  expect(asked.launches[0]).toContain(`--user-data-dir=${await roomProfile()}/chrome`)
  release()
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

for (const whose of ["the room's own", "a host's"] as const) {
  test(`a look at ${whose} profile that keeps failing writes no settings and starts no browser, proxy or tunnel: it says so, and the next Open opens`, async ($, on) => {
    const lockFails = { count: 2 }
    const people = whose === "a host's" ? SIGNED_IN : PREVIEW_PEOPLE
    const asked = windowWorld(on, { stream: [{ seq: 2, events: [WINDOW_SHOWN], people, ended: false, title: 'demo' }], lockFails })
    await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
    await asked.clock.advance(10)
    const ui = await $.ui.mount(band('desktop'))
    await ui.press({ key: 'open-preview' })
    await within(asked.clock, () => asked.toasted.includes(LOOK_UNKNOWN), 3_000)
    await asked.clock.advance(20)
    const profile = whose === "a host's" ? await hostProfilePath() : await roomProfile()
    expect(lockFails.count).toBe(0)
    expect(looks(asked, profile)).toBe(2)
    // Nothing written, started or closed on a guess.
    expect(
      asked.spawned.some(
        s => s.input?.startsWith('# shared-session: chrome preferences') || s.input?.startsWith('# shared-session: settings for a preview window'),
      ),
    ).toBe(false)
    expect(asked.spawned.some(s => s.input?.startsWith('umask 077') && s.input.includes(profile))).toBe(false)
    expect(asked.spawned.some(s => s.input?.startsWith('# shared-session: close the preview window'))).toBe(false)
    expect(asked.launches).toHaveLength(0)
    expect(asked.proxies).toHaveLength(0)
    expect(tunnels(asked)).toHaveLength(0)
    expect(asked.state.previewWindow ?? null).toBeNull()
    expect(asked.toasted.filter(t => t === LOOK_UNKNOWN)).toHaveLength(1)
    // Nor taken for someone else's: no turn to the room's own profile, and the host's hold let go.
    if (whose === "a host's") {
      expect(probed(asked, await roomProfile())).toBe(-1)
      expect(lockDone(asked)).toHaveLength(lockTakes(asked).length)
    }
    // Still offered; pressed again, the look answers and it opens.
    expect(await ui.find({ key: 'open-preview' })).toBeDefined()
    await ui.press({ key: 'open-preview' })
    await within(asked.clock, () => asked.launches.length, 3_000)
    expect(asked.launches[0]).toContain(`--user-data-dir=${profile}/chrome`)
    expect(asked.proxies).toHaveLength(1)
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test("leaving while the browser starts on a host's profile closes the window it started there and lets the profile go", async ($, on) => {
  let release!: () => void
  const asked = windowWorld(on, {
    stream: [{ seq: 2, events: [WINDOW_SHOWN], people: SIGNED_IN, ended: false, title: 'demo' }],
    beforeLaunch: () =>
      new Promise<void>(done => {
        release = done
      }),
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  expect(lockDone(asked)).toHaveLength(0)
  const stopping = $.command.run({ command: 'stop-sharing', args: '' } as never)
  await asked.clock.advance(10)
  release()
  await stopping
  await within(asked.clock, () => lockDone(asked).length, 5_000)
  const host = await hostProfilePath()
  expect(lockDone(asked)).toHaveLength(1)
  expect(lockToken(lockDone(asked)[0]!.input)).toBe(lockToken(lockTakes(asked)[0]!.input))
  // The window it started there closed (on its port alone); the host's profile stays for their other rooms.
  expect(asked.windowState.alive).toBe(false)
  expect(
    asked.spawned
      .filter(s => s.input?.startsWith('# shared-session: close the preview window') && s.input.includes(host))
      .every(s => s.input?.includes('w=47100')),
  ).toBe(true)
  expect(removedProfiles(asked)).toHaveLength(0)
  expect(asked.toasted.some(t => t.startsWith("Opened Sam's"))).toBe(false)
})

test("a Chromium window's profile sends WebRTC only through the proxy: set before it starts, the rest of its settings kept", async ($, on) => {
  const profile = await roomProfile()
  const asked = windowWorld(on, { files: { [`${profile}/chrome/Default/Preferences`]: JSON.stringify({ intl: { selected_languages: 'en' } }) } })
  const pane = await openedInWindow($, asked)
  const written = () => asked.spawned.filter(s => s.input?.startsWith('# shared-session: chrome preferences for a preview window'))
  expect(written()).toHaveLength(1)
  expect(written()[0]!.input).toContain(`f='${profile}/chrome/Default'`)
  expect(written()[0]!.input).toContain(`'{"intl":{"selected_languages":"en"},"webrtc":{"ip_handling_policy":"disable_non_proxied_udp"}}'`)
  // A second Open goes to the window already open: nothing is written under it.
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.launches.length === 2)
  expect(written()).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a second Open goes to the same window and proxy, and the Room says where it opens', async ($, on) => {
  const asked = windowWorld(on)
  const pane = await openedInWindow($, asked)
  expect(await pane.find({ type: 'Text', text: `Opens ${WINDOW_URL} in a preview window` })).toBeDefined()
  expect(await pane.find({ key: 'port-preview:pv-local-auto' })).toBeUndefined()
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.launches.length === 2)
  expect(asked.launches[1]).toEqual(asked.launches[0])
  expect(asked.proxies).toHaveLength(1)
  expect(asked.localHelpers).toHaveLength(1)
  expect(asked.windowState.kills).toBe(0)
  expect(asked.toasted.filter(t => t.startsWith("Opened Sam's localhost:3340"))).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a window left on a proxy port that's taken now is closed first, then opened on a new one", async ($, on) => {
  const profile = await roomProfile()
  const asked = windowWorld(on, { windowOpen: { profile, port: 49999 }, proxyBusy: [49999] })
  await openedInWindow($, asked)
  expect(asked.windowState.kills).toBe(1)
  expect(asked.proxies.map(p => p.config.port)).toEqual([0])
  expect(asked.spawned.filter(s => s.argv.at(-1)?.endsWith('/relay/browser-proxy.mts')).map(s => JSON.parse(s.input!).port)).toEqual([49999, 0])
  expect(asked.launches[0]).toContain('--proxy-server=socks5://127.0.0.1:47100')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('on Linux the window starts detached, with its own password store', async ($, on) => {
  const asked = windowWorld(on, { browser: { platform: 'Linux', path: '/usr/bin/google-chrome' }, env: { WAYLAND_DISPLAY: 'wayland-0' } })
  await openedInWindow($, asked)
  const profile = await roomProfile()
  expect(asked.launches[0]).toEqual([
    '/bin/sh',
    '-c',
    DETACHED,
    'sh',
    '/usr/bin/google-chrome',
    `--user-data-dir=${profile}/chrome`,
    '--proxy-server=socks5://127.0.0.1:47100',
    '--proxy-bypass-list=<-loopback>',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    '--password-store=basic',
    WINDOW_URL,
  ])
  expect(asked.toasted.some(t => t.includes('separate Google Chrome window'))).toBe(true)
  // Linux takes the person's proxy from the environment only.
  expect(asked.spawned.some(s => s.input?.startsWith('scutil'))).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// Which browser: one that isn't the person's default first (macOS hands a
// link from another app to a running copy of the default browser), and never
// one that can't open a window while another can.
test("on macOS the window opens in a browser that isn't the person's default, when there is one", async ($, on) => {
  const asked = windowWorld(on, { browser: { platform: 'Darwin', path: CHROME, isDefault: true, others: [{ path: '/Applications/Firefox.app' }] } })
  await openedInWindow($, asked)
  expect(asked.launches[0]!.slice(0, 4)).toEqual(['open', '-n', '-a', '/Applications/Firefox.app'])
  expect(asked.toasted).toContain(
    "Opened Sam's localhost:3340 in a separate Firefox window. In it, localhost reaches only what Sam shares; your own servers aren't touched.",
  )
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('the default browser opens the window when no other one can, and says where links may go', async ($, on) => {
  const asked = windowWorld(on, { browser: { platform: 'Darwin', path: CHROME, isDefault: true, others: [{ path: '/Applications/Firefox.app', gecko: 128 }] } })
  await openedInWindow($, asked)
  expect(asked.launches[0]!.slice(0, 4)).toEqual(['open', '-n', '-a', CHROME])
  expect(asked.toasted).toContain(
    "Opened Sam's localhost:3340 in a separate Google Chrome window. In it, localhost reaches only what Sam shares; your own servers aren't touched. Google Chrome is your default browser, so links you open in other apps may go to this window while it's open: quit it (⌘Q) when you're done.",
  )
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a Firefox too old for a window doesn't hide a browser found after it", async ($, on) => {
  const asked = windowWorld(on, {
    browser: { platform: 'Darwin', path: '/Applications/Firefox.app', gecko: 128, others: [{ path: '/Applications/Vivaldi.app' }] },
  })
  await openedInWindow($, asked)
  expect(asked.launches[0]!.slice(0, 4)).toEqual(['open', '-n', '-a', '/Applications/Vivaldi.app'])
  expect(asked.toasted.some(t => t.includes('separate Vivaldi window'))).toBe(true)
  expect(asked.toasted.some(t => t.includes('too old'))).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('on Linux a Firefox whose profile path is too long gives way to another browser', async ($, on) => {
  const asked = windowWorld(on, {
    browser: { platform: 'Linux', path: '/usr/bin/firefox', others: [{ path: '/usr/bin/vivaldi' }] },
    env: { DISPLAY: ':0', CLAUDE_CONFIG_DIR: `/home/scott/${'deep/'.repeat(30)}claude` },
  })
  await openedInWindow($, asked)
  expect(asked.launches[0]!.slice(0, 5)).toEqual(['/bin/sh', '-c', DETACHED, 'sh', '/usr/bin/vivaldi'])
  expect(asked.toasted.some(t => t.includes('too deep'))).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("in Firefox the window's settings are written first, and its address goes only to its own profile", async ($, on) => {
  const asked = firefoxWorld(on)
  await openedInWindow($, asked)
  const profile = await roomProfile()
  expect(asked.launches[0]).toEqual(['open', '-n', '-a', FIREFOX, '--args', '-profile', `${profile}/firefox`, WINDOW_URL])
  const argv = JSON.stringify(asked.launches[0])
  for (const secret of ['"g"', 'ticket', 'Bearer', 'ignore-certificate']) expect(argv).not.toContain(secret)
  // Its proxy is in the profile's settings, for the proxy's own port, written privately.
  const settings = asked.firefoxSettings.get(profile)!
  expect(settings.port).toBe(47100)
  expect(settings.text).toContain('umask 077')
  expect(settings.text).toContain('user_pref("network.proxy.allow_hijacking_localhost", true);')
  expect(settings.text).toContain('user_pref("network.proxy.failover_direct", false);')
  // Nothing goes to Mozilla from it, and no notice says otherwise.
  expect(settings.text).toContain('user_pref("datareporting.policy.dataSubmissionEnabled", false);')
  expect(settings.text).toContain('user_pref("app.normandy.enabled", false);')
  expect(settings.text).not.toContain(asked.proxies[0]!.config.controlToken)
  expect(tunnels(asked)[0]).toMatchObject({ port: 0, strict: false })
  expect(asked.toasted).toContain(
    "Opened Sam's localhost:3340 in a separate Firefox window. In it, localhost reaches only what Sam shares; your own servers aren't touched.",
  )
  expect(asked.state.previewWindow).toEqual({
    room: 'https://share.test/room0000000000000001',
    port: 47100,
    opened: ['pv-local'],
    profile: profile.split('/').pop(),
  })
  // Looked at on: the same window, its port read back from those settings.
  await asked.clock.advance(31_000)
  expect(asked.state.previewWindow?.opened).toEqual(['pv-local'])
  expect(asked.proxies[0]!.stopped).toBe(false)
  // Leaving closes it as that one process and removes its profile.
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  expect(asked.windowState.kills).toBe(1)
  expect(asked.spawned.some(s => s.input?.startsWith('# shared-session: remove a preview profile') && s.input.includes(`p='${profile}'`))).toBe(true)
})

test('a second page goes to the Firefox window already open: started again on its profile, which hands it over', async ($, on) => {
  const api = { ...WINDOW_SHOWN, seq: 3, body: { kind: 'preview', pid: 'pv-api', port: 3610, path: '/', title: 'API', tcp: true } }
  const asked = firefoxWorld(on, {
    localPreviewByPid: { 'pv-api': { port: 45002 } },
    stream: [{ seq: 3, events: [WINDOW_SHOWN, api], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  const pane = await openedInWindow($, asked)
  const settings = asked.spawned.filter(s => s.input?.startsWith('# shared-session: settings for a preview window')).length
  await pane.press({ key: 'open-preview:pv-api' })
  await eventually(asked.clock, () => asked.launches.length === 2)
  await asked.clock.advance(10)
  const profile = await roomProfile()
  expect(asked.launches[1]).toEqual(['open', '-n', '-a', FIREFOX, '--args', '-profile', `${profile}/firefox`, 'http://localhost:3610/'])
  expect(asked.startsAlive).toEqual([false, true])
  // The open window keeps its settings and its proxy; nothing is copied or closed.
  expect(asked.spawned.filter(s => s.input?.startsWith('# shared-session: settings for a preview window'))).toHaveLength(settings)
  expect(asked.windowState.kills).toBe(0)
  expect(asked.copied).toEqual([])
  expect(asked.proxies).toHaveLength(1)
  expect(asked.state.previewWindow?.opened).toEqual(['pv-local', 'pv-api'])
  expect(routesOf(asked)?.routes['3610']).toBe(45002)
  expect(asked.toasted.filter(t => t.startsWith('Opened Sam'))).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

for (const [bus, opts] of [
  ['an address', { env: { DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' } }],
  ['a socket', { env: { DISPLAY: ':0', XDG_RUNTIME_DIR: '/run/user/1000' }, busSocket: true }],
  ['none', { env: { DISPLAY: ':0' } }],
] as const) {
  test(`on Linux a second page goes to the Firefox window over the desktop's D-Bus session (${bus}), else its address is copied`, async ($, on) => {
    const api = { ...WINDOW_SHOWN, seq: 3, body: { kind: 'preview', pid: 'pv-api', port: 3610, path: '/', title: 'API', tcp: true } }
    const asked = firefoxWorld(on, {
      ...opts,
      browser: { platform: 'Linux', path: '/usr/bin/firefox' },
      localPreviewByPid: { 'pv-api': { port: 45002 } },
      stream: [{ seq: 3, events: [WINDOW_SHOWN, api], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
    })
    const pane = await openedInWindow($, asked)
    expect(asked.launches[0]?.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    await pane.press({ key: 'open-preview:pv-api' })
    await eventually(asked.clock, () => asked.state.previewWindow?.opened.length === 2)
    await asked.clock.advance(10)
    if (bus === 'none') {
      expect(asked.launches).toHaveLength(1)
      expect(asked.copied).toEqual(['http://localhost:3610/'])
      expect(asked.toasted).toContain(
        "Sam's localhost:3610 is ready in the Firefox preview window. Its address is copied: paste it into that window's address bar (http://localhost:3610/).",
      )
    } else {
      expect(asked.launches).toHaveLength(2)
      expect(asked.launches[1]?.slice(-3)).toEqual(['-profile', `${await roomProfile()}/firefox`, 'http://localhost:3610/'])
      expect(asked.copied).toEqual([])
    }
    expect(asked.windowState.kills).toBe(0)
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test('two Opens at once start one window: the second waits for it, then hands its page over', async ($, on) => {
  const api = { ...WINDOW_SHOWN, seq: 3, body: { kind: 'preview', pid: 'pv-api', port: 3610, path: '/', title: 'API', tcp: true } }
  const asked = firefoxWorld(on, {
    localPreviewByPid: { 'pv-api': { port: 45002 } },
    stream: [{ seq: 3, events: [WINDOW_SHOWN, api], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await pane.press({ key: 'open-preview:pv-api' })
  await eventually(asked.clock, () => asked.launches.length === 2)
  await asked.clock.advance(10)
  expect(asked.startsAlive).toEqual([false, true])
  expect(asked.spawned.filter(s => s.input?.startsWith('# shared-session: settings for a preview window'))).toHaveLength(1)
  expect(asked.proxies).toHaveLength(1)
  expect(asked.state.previewWindow?.opened).toEqual(['pv-local', 'pv-api'])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a reload finds the Firefox window by its profile and brings its proxy back on the port in its settings', async ($, on) => {
  const asked = firefoxWorld(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await openedInWindow($, asked)
  asked.proxies[0]!.exit()
  for (const helper of asked.localHelpers) helper.exit()
  await asked.clock.advance(10)
  await $.session.start(START)
  await eventually(asked.clock, () => asked.proxies.length === 2)
  await asked.clock.advance(20)
  expect(asked.proxies[1]!.config.port).toBe(47100)
  expect(asked.launches).toHaveLength(1)
  expect(asked.windowState.alive).toBe(true)
  expect(asked.copied).toHaveLength(0)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a window of another browser than the one chosen now is closed, and the chosen one opens', async ($, on) => {
  const asked = firefoxWorld(on, { windowOpen: { profile: await roomProfile(), port: 47100 } })
  await openedInWindow($, asked)
  expect(asked.windowState.kills).toBe(1)
  expect(asked.launches[0]?.[3]).toBe(FIREFOX)
  expect(asked.windowState.family).toBe('firefox')
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a window still closing isn't started over: Firefox would meet it on its own profile", async ($, on) => {
  const asked = firefoxWorld(on, { windowOpen: { profile: await roomProfile(), port: 47100 }, windowLingers: true })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.toasted.includes('The preview window is still closing. Open the preview again in a moment.'))
  await asked.clock.advance(10)
  expect(asked.windowState.kills).toBe(1)
  expect(asked.launches).toHaveLength(0)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a Firefox profile whose settings can't be written opens no window and says so", async ($, on) => {
  const asked = firefoxWorld(on, { firefoxSettingsFail: true })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  const said =
    "Couldn't open the preview window: its private profile couldn't be made. To open Sam's localhost:3340 without one, change Previews in Room → Settings."
  await eventually(asked.clock, () => asked.toasted.includes(said))
  await asked.clock.advance(10)
  expect(asked.toasted).toContain(said)
  expect(asked.launches).toHaveLength(0)
  // Nothing will use the proxy and the tunnel it started: they stop.
  expect(asked.proxies.every(p => p.stopped)).toBe(true)
  expect(asked.localHelpers.every(h => h.stopped)).toBe(true)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

const PAGE_URL = 'http://127.0.0.1:3340/login?next=%2Faccount'

test("Open with every port free: what the page uses at its number first, then the page at its own, in the person's own browser", async ($, on) => {
  const asked = autoWorld(on)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.externals.length)
  await asked.clock.advance(10)
  expect(tunnels(asked).map(t => [t.port, t.strict])).toEqual([
    [3610, true],
    [3340, true],
  ])
  // At the host's own address, as the host spelled it: no window, no proxy.
  expect(asked.externals).toEqual([PAGE_URL])
  expect(asked.launches).toHaveLength(0)
  expect(asked.proxies).toHaveLength(0)
  const saved = asked.state.localPreviews ?? []
  expect(saved.find(p => p.pid === 'pv-dep')).toEqual({ pid: 'pv-dep', port: 3610, localPort: 3610 })
  expect(saved.find(p => p.pid === 'pv-local')).toEqual({ pid: 'pv-local', port: 3340, localPort: 3340 })
  expect(asked.toasted).toContain(
    "Opened Sam's localhost:3340 in your browser. While you're in the room, localhost:3340 and localhost:3610 here reach Sam's, your cookies for them included; Close in Room → Shown, or Leave, frees them.",
  )
  // Opened again, nothing there starts again, and nothing more is said.
  const pane = await $.ui.mount(roomPane('desktop'))
  await pane.press({ key: 'tab-shown' })
  expect((await pane.find({ type: 'Text', text: "localhost:3340 here → Sam's localhost:3340" }))?.text).toBe("localhost:3340 here → Sam's localhost:3340")
  const said = asked.toasted.length
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length === 2)
  expect(tunnels(asked)).toHaveLength(2)
  expect(asked.toasted).toHaveLength(said)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  expect(asked.localHelpers.every(h => h.stopped)).toBe(true)
})

for (const [what, taken] of [
  ['the page uses', { 'pv-dep': { taken: [3610] } }],
  ['the page itself', { 'pv-local': { taken: [3340] } }],
] as [string, Record<string, { taken: number[] }>][]) {
  test(`a port ${what} taken here opens the separate window instead, and only what this Open started stops`, async ($, on) => {
    const asked = autoWorld(on, { localPreviewByPid: taken })
    await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
    await asked.clock.advance(10)
    const ui = await $.ui.mount(band('desktop'))
    await ui.press({ key: 'open-preview' })
    await eventually(asked.clock, () => asked.launches.length)
    await asked.clock.advance(10)
    // Tried at the host's numbers; the one taken settles it.
    expect(
      tunnels(asked)
        .filter(t => t.strict)
        .map(t => t.port),
    ).toEqual(what === 'the page uses' ? [3610] : [3610, 3340])
    // Of the listeners at the host's numbers, none is left.
    expect(asked.localHelpers.filter(h => h.pid === 'pv-dep').every(h => h.stopped)).toBe(true)
    expect(asked.externals).toEqual([])
    // The window, at the host's own address; nothing of this person's is touched.
    expect(asked.launches[0]!.at(-1)).toBe(PAGE_URL)
    expect((asked.state.localPreviews ?? []).map(p => p.pid)).toEqual([])
    expect(asked.toasted.some(t => t.startsWith("Opened Sam's localhost:3340 in a separate Google Chrome window."))).toBe(true)
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test('with no window possible, a taken port the page uses is said with what it costs; the page opens at its own number', async ($, on) => {
  const asked = localWorld(on, { localPreviewByPid: { 'pv-dep': { taken: [3610] } } })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.externals.length)
  await asked.clock.advance(10)
  expect(asked.externals).toEqual([PAGE_URL])
  expect(asked.toasted.filter(t => t.startsWith("Sam's preview opened"))).toEqual([
    "Sam's preview opened at localhost:3340 here. localhost:3610, which it uses, is in use here too: the page may reach your own server there. A separate window would keep Sam's addresses, but no Chrome, Edge, Brave, Chromium, Firefox, Vivaldi or Opera was found (a snap one cannot be used).",
  ])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('what the page uses failing for another reason (no Node here) says so, and nothing opens', async ($, on) => {
  const asked = autoWorld(on, { localPreviewByPid: { 'pv-dep': { mode: 'missing' } } })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.toasted.some(t => /need Node/.test(t)))
  await asked.clock.advance(10)
  expect(asked.externals).toEqual([])
  expect(asked.launches).toHaveLength(0)
  expect(tunnels(asked).map(t => t.port)).toEqual([3610])
  expect((asked.state.localPreviews ?? []).map(p => p.pid)).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a reload brings each listener back at its own number; one taken meanwhile stays closed and is said', async ($, on) => {
  const byPid: Record<string, { taken?: number[] }> = {}
  const asked = autoWorld(on, { localPreviewByPid: byPid })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.externals.length)
  await asked.clock.advance(10)
  // Meanwhile the person's own backend took 3610; the helpers went with the reload.
  byPid['pv-dep'] = { taken: [3610] }
  for (const helper of asked.localHelpers) helper.exit()
  await asked.clock.advance(10)
  await $.session.start(START)
  await eventually(asked.clock, () => asked.toasted.some(t => t.includes('forwarded again')))
  await asked.clock.advance(10)
  expect(
    tunnels(asked)
      .slice(2)
      .map(t => [t.port, t.strict]),
  ).toEqual([
    [3610, true],
    [3340, true],
  ])
  expect(asked.toasted).toContain("localhost:3610 of Sam's wasn't forwarded again: localhost:3610 is in use here now. Press Open in the Room when ready.")
  // Nothing opens by itself, and the page's listener is back at its number.
  expect(asked.externals).toHaveLength(1)
  expect(asked.launches).toHaveLength(0)
  expect(asked.localHelpers.filter(h => h.pid === 'pv-local' && !h.stopped)).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a moved listener the host refused comes back at its own port on Open, after the host number is tried again', async ($, on) => {
  const asked = localWorld(on, {
    localPreviewByPid: { 'pv-local': { taken: [3340], port: 44321 } },
    stream: [{ seq: 2, events: [WINDOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount(roomPane('terminal'))
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length)
  await asked.clock.advance(10)
  asked.localHelpers[0]!.send({ state: 'channel-error', code: 'AUTH' })
  await asked.clock.advance(20)
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length === 2)
  // The host's number first; taken, the listener goes back to its own port.
  expect(tunnels(asked).map(t => [t.port, t.strict])).toEqual([
    [3340, true],
    [3340, false],
    [3340, true],
    [44321, false],
  ])
  expect(asked.externals).toEqual(['http://127.0.0.1:44321/login?next=%2Faccount', 'http://127.0.0.1:44321/login?next=%2Faccount'])
  expect(asked.state.localPreviews).toEqual([{ pid: 'pv-local', port: 3340, localPort: 44321 }])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a page opened elsewhere comes back after a reload exactly where it was; taken meanwhile, it stays closed and is said, never moved', async ($, on) => {
  const byPid: Record<string, { taken?: number[]; port?: number }> = { 'pv-dep': { taken: [3610] } }
  const asked = localWorld(on, { localPreviewByPid: byPid })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.externals.length)
  await asked.clock.advance(10)
  // What it uses is taken here: no window, so the page opened at its own number, free then.
  expect(asked.state.localPreviews).toEqual([{ pid: 'pv-local', port: 3340, localPort: 3340 }])
  // The person's own server takes 3340 meanwhile; the helpers went with a reload.
  byPid['pv-local'] = { taken: [3340], port: 51234 }
  for (const helper of asked.localHelpers) helper.exit()
  await asked.clock.advance(10)
  await $.session.start(START)
  await eventually(asked.clock, () => asked.toasted.some(t => t.includes('forwarded again')))
  await asked.clock.advance(10)
  expect(tunnels(asked).at(-1)).toMatchObject({ port: 3340, strict: true })
  expect(asked.toasted).toContain("localhost:3340 of Sam's wasn't forwarded again: localhost:3340 is in use here now. Press Open in the Room when ready.")
  expect(asked.localHelpers.filter(h => h.pid === 'pv-local' && !h.stopped)).toHaveLength(0)
  expect(asked.externals).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("with no window possible, a page that fails to open stops what its Open started for it: nothing stays at the host's numbers", async ($, on) => {
  let starts = 0
  const asked = localWorld(on, {
    localPreviewByPid: { 'pv-local': { taken: [3340] } },
    beforeHelper: pid => {
      if (pid === 'pv-local' && ++starts === 2) throw new Error("it didn't start")
    },
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.toasted.some(t => t.startsWith("Couldn't forward localhost:3340")))
  await asked.clock.advance(10)
  // The host's numbers first (the page's taken), then what it uses again for the page elsewhere, whose own start failed.
  expect(tunnels(asked).map(t => [t.port, t.strict])).toEqual([
    [3610, true],
    [3340, true],
    [3610, true],
    [3340, false],
  ])
  expect(asked.localHelpers.filter(h => h.pid === 'pv-dep').every(h => h.stopped)).toBe(true)
  expect(asked.state.localPreviews ?? []).toEqual([])
  expect(asked.externals).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('Leave while Open moves the page puts nothing back: no mapping is left saved', async ($, on) => {
  let hold: (() => void) | undefined
  let starts = 0
  const saved = {
    at: 900,
    room: { server: 'https://share.test', id: 'room0000000000000001', url: LINK, title: 'demo', host: 'Sam', token: 'g', seat: 'seat1', seq: 3, since: 1 },
    autoOpen: true,
    policy: { prompts: 'everyone', approvals: 'edits', files: 'on' },
    shown: [],
    activity: [],
    chat: [],
    sidebar: null,
    // Where the page was last: on a free port, the host's number taken then.
    localPreviews: [{ pid: 'pv-local', port: 3340, localPort: 44321 }],
  }
  const asked = localWorld(on, {
    localPreviewByPid: { 'pv-local': { taken: [3340, 44321], port: 45555 } },
    files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: saved }) },
    roomList: { previews: [{ pid: 'pv-local', port: 3340, tcp: true }] },
    beforeHelper: pid =>
      pid === 'pv-local' && ++starts === 3
        ? new Promise<void>(done => {
            hold = done
          })
        : undefined,
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  // Its own port is taken now: it stays closed, and is said.
  await eventually(asked.clock, () => asked.toasted.some(t => t.includes('forwarded again')))
  expect(asked.state.localPreviews).toEqual([{ pid: 'pv-local', port: 3340, localPort: 44321 }])
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'open-preview' })
  // The host's number taken too, the page is moving: Leave while it starts there.
  await eventually(asked.clock, () => Boolean(hold))
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  hold!()
  await asked.clock.advance(50)
  expect(asked.state.localPreviews ?? []).toEqual([])
  expect(asked.externals).toEqual([])
})

// What an Open seated anew while it binds says (`bindForOpen`, the window's `readyProxy`).
const RESEATED = 'The room reconnected you while the preview was opening. Press Open again.'

test('seated anew while Open forwards the page, what that Open started stops and it says to press Open again: the next Open forwards both with the new seat', async ($, on) => {
  let hold: (() => void) | undefined
  const refusals = { count: 0 }
  const asked = localWorld(on, {
    streamRefusals: refusals,
    beforeHelper: pid =>
      pid === 'pv-local' && !hold
        ? new Promise<void>(done => {
            hold = done
          })
        : undefined,
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'open-preview' })
  // What the page uses is up at its number; the page's own listener is starting, with the old seat's token.
  await eventually(asked.clock, () => Boolean(hold) && asked.localHelpers.some(h => h.pid === 'pv-dep'))
  const first = asked.localHelpers.find(h => h.pid === 'pv-dep')!
  refusals.count = 1
  await within(asked.clock, () => asked.state.room?.token === 'g2', 5_000)
  expect(asked.state.room?.token).toBe('g2')
  hold!()
  await eventually(asked.clock, () => asked.toasted.includes(RESEATED))
  await asked.clock.advance(10)
  // What started with the old seat's token stops; nothing opens, and nothing is saved.
  expect(first.stopped).toBe(true)
  expect(asked.externals).toEqual([])
  expect(asked.state.localPreviews ?? []).toEqual([])
  // The next Open: both start with the new seat's token, and the page opens.
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.externals.length)
  await asked.clock.advance(10)
  expect(tunnels(asked).map(t => t.token)).toEqual(['g', 'g', 'g2', 'g2'])
  expect(asked.externals).toEqual([WINDOW_URL])
  expect((asked.state.localPreviews ?? []).map(p => [p.pid, p.localPort]).sort()).toEqual([
    ['pv-dep', 3610],
    ['pv-local', 3340],
  ])
  expect(asked.toasted.some(t => t.includes('no longer open'))).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('seated anew while a listener starts, the Open stops what it started and says to press Open again: the next opens the page once, with the new seat', async ($, on) => {
  const refusals = { count: 0 }
  const asked = world(on, { localPreview: 'wait', streamRefusals: refusals, stream: localStream })
  const pane = paneCalls(on, false)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const room = await $.ui.mount(roomPane())
  await room.press({ key: 'tab-shown' })
  await room.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.localHelpers.length)
  refusals.count = 1
  await within(asked.clock, () => asked.state.room?.token === 'g2', 5_000)
  // Up after the reseat: it carries the old seat's token, so it stops, and the Open says so.
  asked.localHelpers[0]!.send({ state: 'ready', port: 3340 })
  await eventually(asked.clock, () => asked.toasted.includes(RESEATED))
  await asked.clock.advance(10)
  expect(asked.localHelpers).toHaveLength(1)
  expect(asked.localHelpers[0]!.stopped).toBe(true)
  expect(pane).toEqual([])
  expect(asked.state.localPreviews ?? []).toEqual([])
  await room.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.localHelpers.length === 2)
  asked.localHelpers[1]!.send({ state: 'ready', port: 3340 })
  await eventually(asked.clock, () => pane.length)
  await asked.clock.advance(10)
  expect(pane).toEqual([LOCAL_URL])
  expect(asked.state.localPreviews).toEqual([{ pid: 'pv-local', port: 3340, localPort: 3340 }])
  expect(tunnels(asked).map(t => t.token)).toEqual(['g', 'g2'])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a host's showing that doesn't say it's forwarded takes nothing from a guest's listener: a reload brings it back", async ($, on) => {
  const stream: unknown[] = [{ seq: 3, events: [WINDOW_SHOWN, DEP_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = autoWorld(on, { stream })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.externals.length)
  await asked.clock.advance(10)
  // The room from here on: that showing is the preview's newest.
  stream.splice(0, stream.length, {
    seq: 4,
    events: [{ ...WINDOW_SHOWN, seq: 4, body: { kind: 'preview', pid: 'pv-local', port: 3340, path: '/account', title: 'localhost:3340', host: '127.0.0.1' } }],
    people: PREVIEW_PEOPLE,
    ended: false,
    title: 'demo',
  })
  await within(asked.clock, () => asked.state.shown?.find(s => s.pid === 'pv-local')?.path === '/account', 5000)
  // Shown keeps it forwarded: the page moved, the forwarding didn't.
  expect(asked.state.shown?.find(s => s.pid === 'pv-local')).toMatchObject({ tcp: true, host: '127.0.0.1', path: '/account' })
  // A reload: the helpers go with the old module, and come back.
  for (const helper of asked.localHelpers) helper.exit()
  await asked.clock.advance(10)
  await $.session.start(START)
  await eventually(asked.clock, () => asked.localHelpers.filter(h => h.pid === 'pv-local').length === 2)
  await asked.clock.advance(10)
  expect(asked.localHelpers.filter(h => h.pid === 'pv-local' && !h.stopped)).toHaveLength(1)
  expect(tunnels(asked).at(-1)).toMatchObject({ port: 3340, strict: true })
  expect((asked.state.localPreviews ?? []).map(p => p.pid).sort()).toEqual(['pv-dep', 'pv-local'])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a listener saves where it is, nothing more: whether IPv6 bound stays with its run', async ($, on) => {
  const asked = world(on, {
    env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
    localPreviewByPid: { 'pv-local': { ipv6: true } },
    stream: [{ seq: 2, events: [{ ...LOCAL_SHOWN, body: { ...LOCAL_SHOWN.body, host: '[::1]' } }], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount(roomPane('terminal'))
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length)
  expect(asked.externals).toEqual(['http://[::1]:3340/login?next=%2Faccount'])
  expect(asked.state.localPreviews).toEqual([{ pid: 'pv-local', port: 3340, localPort: 3340 }])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

const EVERY_PAGE = {
  ...WINDOW_SHOWN,
  seq: 5,
  body: { kind: 'preview', pid: 'pv-all', port: 3620, path: '/', title: 'localhost:3620 (auth)', tcp: true, dependency: true },
}

test('Close on a mapping frees its port here and what only its page uses; what every page uses stays while another page listens', async ($, on) => {
  const asked = autoWorld(on, {
    stream: [{ seq: 5, events: [WINDOW_SHOWN, DEP_SHOWN, PAGE_B, EVERY_PAGE], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length === 1)
  await pane.press({ key: 'open-preview:pv-b' })
  await eventually(asked.clock, () => asked.externals.length === 2)
  await asked.clock.advance(10)
  const running = (pid: string) => asked.localHelpers.filter(h => h.pid === pid && !h.stopped).length
  // The page on 3340 uses 3610 (its own) and 3620 (every page's); the one on 3341, 3620.
  expect((asked.state.localPreviews ?? []).map(p => p.pid).sort()).toEqual(['pv-all', 'pv-b', 'pv-dep', 'pv-local'])
  await pane.press({ key: 'close-preview:pv-local' })
  await asked.clock.advance(10)
  expect([running('pv-local'), running('pv-dep'), running('pv-all'), running('pv-b')]).toEqual([0, 0, 1, 1])
  expect((asked.state.localPreviews ?? []).map(p => p.pid).sort()).toEqual(['pv-all', 'pv-b'])
  expect(await pane.find({ type: 'Text', text: "localhost:3340 here → Sam's localhost:3340" })).toBeUndefined()
  expect(await pane.find({ key: 'close-preview:pv-local' })).toBeUndefined()
  // Opened again; then the other page's listener stops by itself (its line says Last:).
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length === 3)
  await asked.clock.advance(10)
  expect([running('pv-local'), running('pv-dep'), running('pv-all')]).toEqual([1, 1, 1])
  asked.localHelpers
    .filter(h => h.pid === 'pv-b' && !h.stopped)
    .at(-1)!
    .exit()
  await asked.clock.advance(10)
  expect((await pane.find({ type: 'Text', text: "localhost:3341 here → Sam's localhost:3341" }))?.text).toBe("Last: localhost:3341 here → Sam's localhost:3341")
  // No other page listens now: what every page uses goes with this one.
  await pane.press({ key: 'close-preview:pv-local' })
  await asked.clock.advance(10)
  expect([running('pv-local'), running('pv-dep'), running('pv-all'), running('pv-b')]).toEqual([0, 0, 0, 0])
  expect((asked.state.localPreviews ?? []).map(p => p.pid)).toEqual(['pv-b'])
  // Close on the Last: line forgets it.
  await pane.press({ key: 'close-preview:pv-b' })
  await asked.clock.advance(10)
  expect(asked.state.localPreviews).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// The host's side refusing a page's listeners and what it uses (the seat
// whose token they carry let go, say), each said as it is.
async function refusedHere($: Parameters<TestBody>[0], asked: ReturnType<typeof world>) {
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.externals.length)
  await asked.clock.advance(10)
  const dep = asked.localHelpers.find(h => h.pid === 'pv-dep')!
  for (const helper of [dep, asked.localHelpers.find(h => h.pid === 'pv-local')!]) helper.send({ state: 'channel-error', code: 'AUTH' })
  await asked.clock.advance(20)
  const pane = await $.ui.mount(roomPane('desktop'))
  await pane.press({ key: 'tab-shown' })
  return { dep, pane }
}

test("a page's Open after the host's side refused it and what it uses starts both again: the refused listener it uses isn't kept", async ($, on) => {
  const asked = autoWorld(on)
  const { dep, pane } = await refusedHere($, asked)
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length === 2)
  await asked.clock.advance(10)
  expect(tunnels(asked).map(t => [t.port, t.strict])).toEqual([
    [3610, true],
    [3340, true],
    [3610, true],
    [3340, true],
  ])
  expect(dep.stopped).toBe(true)
  expect(
    asked.localHelpers
      .filter(h => !h.stopped)
      .map(h => h.pid)
      .sort(),
  ).toEqual(['pv-dep', 'pv-local'])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a page's Open in the window after the host's side refused its listeners: the window asks for what it uses anew, not the refused listener", async ($, on) => {
  const asked = autoWorld(on)
  const { dep, pane } = await refusedHere($, asked)
  asked.store.set('previewOpen', 'window')
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(20)
  expect(dep.stopped).toBe(true)
  expect(routesOf(asked)?.routes['3610']).toBeUndefined()
  expect(routesOf(asked)?.startable).toContain(3610)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// The host's Stop of a page: what only it used here goes with it, as its Close takes it.
const pageStop = (seq: number) => ({
  seq,
  events: [{ seq, type: 'preview', ts: 950, from: HOST_FROM, body: { pid: 'pv-local', port: 3340, state: 'closed' } }],
  people: PREVIEW_PEOPLE,
  ended: false,
  title: 'demo',
})

test("the host's Stop of a page frees what only that page used here", async ($, on) => {
  const stream: unknown[] = [{ seq: 3, events: [WINDOW_SHOWN, DEP_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = autoWorld(on, { stream })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.externals.length)
  await asked.clock.advance(10)
  stream.splice(0, stream.length, pageStop(4))
  await within(asked.clock, () => asked.state.shown?.find(s => s.pid === 'pv-local')?.closed, 5000)
  stream.length = 0
  await asked.clock.advance(50)
  expect(asked.localHelpers.every(h => h.stopped)).toBe(true)
  expect(asked.state.localPreviews ?? []).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("the host's Stop of a page as its Open saves what it bound leaves nothing bound or saved", async ($, on) => {
  const stream: unknown[] = [{ seq: 3, events: [WINDOW_SHOWN, DEP_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  let held: (() => void) | undefined
  const beforeSet = async (key: string, value: unknown) => {
    if (held || key !== 'localPreviews' || !Array.isArray(value) || value.length !== 2) return
    await new Promise<void>(done => {
      held = done
    })
  }
  const asked = autoWorld(on, { stream, beforeSet })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => Boolean(held))
  stream.splice(0, stream.length, pageStop(4))
  await within(asked.clock, () => asked.state.shown?.find(s => s.pid === 'pv-local')?.closed, 5000)
  stream.length = 0
  held!()
  await asked.clock.advance(50)
  expect(asked.localHelpers.every(h => h.stopped)).toBe(true)
  expect(asked.state.localPreviews ?? []).toEqual([])
  expect(asked.externals).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("the host's Stop of a page keeps what another page listening here uses, and stops what only it used", async ($, on) => {
  const stream: unknown[] = [{ seq: 5, events: [WINDOW_SHOWN, DEP_SHOWN, PAGE_B, EVERY_PAGE], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = autoWorld(on, { stream })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  // The API the page uses has no Open of its own: it comes up with the page. Then the other page.
  expect(await pane.find({ key: 'open-preview:pv-dep' })).toBeUndefined()
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.externals.length === 1)
  await pane.press({ key: 'open-preview:pv-b' })
  await eventually(asked.clock, () => asked.externals.length === 2)
  await asked.clock.advance(10)
  expect((asked.state.localPreviews ?? []).find(p => p.pid === 'pv-dep')).toEqual({ pid: 'pv-dep', port: 3610, localPort: 3610 })
  stream.splice(0, stream.length, pageStop(6))
  await within(asked.clock, () => asked.state.shown?.find(s => s.pid === 'pv-local')?.closed, 5000)
  stream.length = 0
  await asked.clock.advance(50)
  const running = (pid: string) => asked.localHelpers.filter(h => h.pid === pid && !h.stopped).length
  // The page's own API goes with it; what every page uses stays while the other page listens.
  expect([running('pv-local'), running('pv-dep'), running('pv-all'), running('pv-b')]).toEqual([0, 0, 1, 1])
  expect((asked.state.localPreviews ?? []).map(p => p.pid).sort()).toEqual(['pv-all', 'pv-b'])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a mapping the window's own tunnel stands in for shows as Last:, and its Close forgets it, the window's page untouched", async ($, on) => {
  const byPid: Record<string, { taken?: number[] }> = {}
  const asked = autoWorld(on, { localPreviewByPid: byPid })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.externals.length)
  await asked.clock.advance(10)
  // The person's own server takes 3340 meanwhile; the page's listener doesn't come back with a reload.
  byPid['pv-local'] = { taken: [3340] }
  for (const helper of asked.localHelpers) helper.exit()
  await asked.clock.advance(10)
  await $.session.start(START)
  await eventually(asked.clock, () => asked.toasted.some(t => t.includes('forwarded again')))
  // Open: its number taken here, the page opens in the window, through a tunnel of the window's own.
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(10)
  expect((await pane.find({ type: 'Text', text: "localhost:3340 here → Sam's localhost:3340" }))?.text).toBe("Last: localhost:3340 here → Sam's localhost:3340")
  const tunnel = asked.localHelpers.filter(h => h.pid === 'pv-local').at(-1)!
  expect(routesOf(asked)?.routes['3340']).toBe(45001)
  await pane.press({ key: 'close-preview:pv-local' })
  await asked.clock.advance(10)
  expect((asked.state.localPreviews ?? []).some(p => p.pid === 'pv-local')).toBe(false)
  expect(tunnel.stopped).toBe(false)
  expect(routesOf(asked)?.routes['3340']).toBe(45001)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a page open in the window opens there again: the window's tunnel isn't stopped to try the host's number here first", async ($, on) => {
  const asked = autoWorld(on, { localPreviewByPid: { 'pv-local': { taken: [3340] } } })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(10)
  const tunnel = asked.localHelpers.filter(h => h.pid === 'pv-local').at(-1)!
  const started = tunnels(asked).length
  // Open again from the Room (the band hides a page that's open).
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.launches.length === 2)
  await asked.clock.advance(10)
  expect(tunnel.stopped).toBe(false)
  expect(tunnels(asked)).toHaveLength(started)
  expect(asked.launches[1]!.at(-1)).toBe(PAGE_URL)
  expect(asked.startsAlive).toEqual([false, true])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

// A second page, and what every page uses (`dependency: true`): an API, and a
// cache the API's page reaches first.
const SECOND_PAGE = { ...WINDOW_SHOWN, seq: 3, body: { kind: 'preview', pid: 'pv-docs', port: 3341, path: '/', title: 'Docs', tcp: true } }

const EVERY_CACHE = {
  ...WINDOW_SHOWN,
  seq: 4,
  body: { kind: 'preview', pid: 'pv-cache', port: 3620, path: '/', title: 'localhost:3620', tcp: true, dependency: true },
}

const EVERY_API = {
  ...WINDOW_SHOWN,
  seq: 5,
  body: { kind: 'preview', pid: 'pv-api', port: 3610, path: '/', title: 'localhost:3610', tcp: true, dependency: true },
}

// The page on 3340 open in the window (its number taken here), and the window
// reaching the API through a tunnel of its own.
async function apiInWindow($: Parameters<TestBody>[0], asked: ReturnType<typeof world>) {
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount(roomPane())
  await pane.press({ key: 'tab-shown' })
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(10)
  return pane
}

test("an Open of another page that uses what the window reaches goes to the window: that tunnel isn't taken over to try its number here", async ($, on) => {
  const asked = world(on, {
    browser: { platform: 'Darwin', path: CHROME },
    localPreviewPort: 45001,
    localPreviewByPid: { 'pv-local': { taken: [3340] }, 'pv-api': { port: 45002 }, 'pv-docs': { port: 45003 } },
    stream: [{ seq: 5, events: [WINDOW_SHOWN, SECOND_PAGE, EVERY_API], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  const pane = await apiInWindow($, asked)
  asked.proxies[0]!.send({ state: 'want', port: 3610 })
  await eventually(asked.clock, () => routesOf(asked)?.routes['3610'] === 45002)
  const api = asked.localHelpers.filter(h => h.pid === 'pv-api').at(-1)!
  const tried = tunnels(asked).length
  await pane.press({ key: 'open-preview:pv-docs' })
  await eventually(asked.clock, () => asked.launches.length === 2)
  await asked.clock.advance(10)
  // The API's tunnel serves the window still; nothing was tried at its number here.
  expect(api.stopped).toBe(false)
  expect(
    tunnels(asked)
      .slice(tried)
      .map(t => [t.port, t.strict]),
  ).toEqual([[0, false]])
  expect(routesOf(asked)?.routes).toEqual({ '3340': 45001, '3610': 45002, '3341': 45003 })
  expect(asked.externals).toEqual([])
  expect(asked.launches[1]!.at(-1)).toBe('http://localhost:3341/')
  expect(asked.startsAlive).toEqual([false, true])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("an Open of a page the window's pages already reach goes to the window: its tunnel is kept, and nothing it uses is tried here", async ($, on) => {
  const asked = world(on, {
    browser: { platform: 'Darwin', path: CHROME },
    localPreviewPort: 45001,
    localPreviewByPid: { 'pv-local': { taken: [3340] }, 'pv-api': { port: 45002 }, 'pv-docs': { port: 45003 } },
    stream: [{ seq: 5, events: [WINDOW_SHOWN, SECOND_PAGE, EVERY_API], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  const pane = await apiInWindow($, asked)
  // A page in the window reaches the docs: a tunnel of the window's own serves them.
  asked.proxies[0]!.send({ state: 'want', port: 3341 })
  await eventually(asked.clock, () => routesOf(asked)?.routes['3341'] === 45003)
  const docs = asked.localHelpers.filter(h => h.pid === 'pv-docs').at(-1)!
  const tried = tunnels(asked).length
  await pane.press({ key: 'open-preview:pv-docs' })
  await eventually(asked.clock, () => asked.launches.length === 2)
  await asked.clock.advance(10)
  // Its tunnel serves the window still, and neither its number nor the API's was tried here.
  expect(docs.stopped).toBe(false)
  expect(tunnels(asked).slice(tried)).toEqual([])
  expect(routesOf(asked)?.routes).toEqual({ '3340': 45001, '3341': 45003 })
  expect(asked.externals).toEqual([])
  expect(asked.launches[1]!.at(-1)).toBe('http://localhost:3341/')
  expect(asked.startsAlive).toEqual([false, true])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a page's Open whose dependency the window starts using meanwhile goes to the window, and stops what it started here", async ($, on) => {
  const byPid: Record<string, { mode?: 'wait'; taken?: number[]; port?: number }> = {
    'pv-local': { taken: [3340] },
    'pv-api': { port: 45002 },
    'pv-docs': { port: 45003 },
  }
  const asked = world(on, {
    browser: { platform: 'Darwin', path: CHROME },
    localPreviewPort: 45001,
    localPreviewByPid: byPid,
    stream: [{ seq: 5, events: [WINDOW_SHOWN, SECOND_PAGE, EVERY_CACHE, EVERY_API], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  const pane = await apiInWindow($, asked)
  // The cache's listener here is slow to come up this time.
  byPid['pv-cache'] = { mode: 'wait' }
  const tried = tunnels(asked).length
  await pane.press({ key: 'open-preview:pv-docs' })
  await eventually(asked.clock, () => tunnels(asked).length === tried + 1)
  const cache = asked.localHelpers.at(-1)!
  expect(tunnels(asked).at(-1)).toMatchObject({ port: 3620, strict: true })
  // Meanwhile the window's page asks for the API: a tunnel of the window's own serves it.
  asked.proxies[0]!.send({ state: 'want', port: 3610 })
  await eventually(asked.clock, () => routesOf(asked)?.routes['3610'] === 45002)
  const api = asked.localHelpers.filter(h => h.pid === 'pv-api').at(-1)!
  cache.send({ state: 'ready', port: 3620 })
  await eventually(asked.clock, () => asked.launches.length === 2)
  await asked.clock.advance(10)
  // The API's tunnel was left to the window, the cache's listener this Open started stopped, and the page went to the window.
  expect(api.stopped).toBe(false)
  expect(cache.stopped).toBe(true)
  expect(
    tunnels(asked)
      .slice(tried)
      .filter(t => t.strict)
      .map(t => t.port),
  ).toEqual([3620])
  expect(asked.externals).toEqual([])
  expect(asked.launches[1]!.at(-1)).toBe('http://localhost:3341/')
  expect((asked.state.localPreviews ?? []).map(p => p.pid)).toEqual([])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

const LOW_SHOWN = { ...WINDOW_SHOWN, body: { kind: 'preview', pid: 'pv-low', port: 80, path: '/', title: 'App', tcp: true } }

test("a host port this computer won't let Claude Code listen on opens the window, as a taken one does", async ($, on) => {
  const asked = world(on, {
    browser: { platform: 'Darwin', path: CHROME },
    localPreviewPort: 45001,
    localPreviewByPid: { 'pv-low': { denied: [80] } },
    stream: [{ seq: 2, events: [LOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.launches.length)
  await asked.clock.advance(10)
  expect(tunnels(asked).map(t => [t.port, t.strict])).toEqual([
    [80, true],
    [0, false],
  ])
  expect(asked.launches[0]!.at(-1)).toBe('http://localhost:80/')
  expect(asked.toasted.some(t => t.includes('Check the host is connected'))).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('with no window possible, a host port this computer refuses moves the page, and the note says the computer refused it', async ($, on) => {
  const asked = world(on, {
    browser: { platform: 'Darwin', path: null },
    env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
    localPreviewByPid: { 'pv-low': { denied: [80], port: 44321 } },
    stream: [{ seq: 2, events: [LOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.externals.length)
  await asked.clock.advance(10)
  expect(asked.externals).toEqual(['http://localhost:44321/'])
  expect(asked.toasted.filter(t => t.startsWith("Sam's preview opened"))).toEqual([
    "Sam's preview opened at localhost:44321 here, not localhost:80, which this computer doesn't let Claude Code listen on, so sign-ins registered for localhost:80 won't work. A separate window would keep Sam's addresses, but no Chrome, Edge, Brave, Chromium, Firefox, Vivaldi or Opera was found (a snap one cannot be used).",
  ])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a listener this computer no longer lets Claude Code listen on stays closed after a reload, and that is said as what it is', async ($, on) => {
  const saved = {
    at: 900,
    room: { server: 'https://share.test', id: 'room0000000000000001', url: LINK, title: 'demo', host: 'Sam', token: 'g', seat: 'seat1', seq: 2, since: 1 },
    autoOpen: true,
    policy: { prompts: 'everyone', approvals: 'edits', files: 'on' },
    shown: [{ key: 'preview:pv-low', kind: 'preview', name: 'App (preview)', ts: 900, pid: 'pv-low', port: 80, path: '/', tcp: true }],
    localPreviews: [{ pid: 'pv-low', port: 80, localPort: 80 }],
    activity: [],
    chat: [],
    sidebar: null,
  }
  const asked = world(on, {
    browser: { platform: 'Darwin', path: null },
    env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
    localPreviewByPid: { 'pv-low': { denied: [80] } },
    files: { [checkpointPath('joined:session-test-0001')]: JSON.stringify({ version: 1, value: saved }) },
    stream: [{ seq: 2, events: [LOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
    roomList: { previews: [{ pid: 'pv-low', port: 80, tcp: true }] },
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await eventually(asked.clock, () => asked.toasted.some(t => t.includes('forwarded again')))
  expect(tunnels(asked).map(t => [t.port, t.strict])).toEqual([[80, true]])
  expect(asked.toasted).toContain(
    "localhost:80 of Sam's wasn't forwarded again: this computer doesn't let Claude Code listen on localhost:80. Press Open in the Room when ready.",
  )
  expect(asked.localHelpers.filter(h => !h.stopped)).toHaveLength(0)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

const SCUTIL_SOCKS = '<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n  }\n  SOCKSEnable : 1\n  SOCKSPort : 7891\n  SOCKSProxy : 127.0.0.1\n}\n'

const scutilHttps = (host: string) => `<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 8080\n  HTTPSProxy : ${host}\n}\n`

const NOT_SPOKEN = "The preview window doesn't use your https:// or socks4:// proxy setting: its proxy goes on only through http:// and socks5:// proxies."

const NOT_TAKEN = "The preview window doesn't use your proxy setting: it isn't an address its proxy can take (a host name or IP address, and a port)."

// The window's proxy can't take a host the URL parser takes (`bad_host-`, `-bad.corp`): it says so, and goes on without it.
for (const [name, env, scutil, upstream, note, refused] of [
  [
    'the environment',
    { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,.corp' },
    undefined,
    { kind: 'http', host: '127.0.0.1', port: 7890, bypass: ['localhost', '.corp'] },
    null,
    0,
  ],
  ["macOS's settings", {}, SCUTIL_SOCKS, { kind: 'socks5', host: '127.0.0.1', port: 7891, bypass: ['*.local'] }, null, 0],
  ['a PAC file', {}, '<dictionary> {\n  ProxyAutoConfigEnable : 1\n}\n', null, "PAC proxies aren't followed", 0],
  ['credentials', { HTTPS_PROXY: 'http://me:secret@proxy.corp:8080' }, undefined, null, 'user name or password', 0],
  ['an https:// proxy', { HTTPS_PROXY: 'https://proxy.corp:443' }, undefined, null, NOT_SPOKEN, 0],
  ['a socks4:// proxy', { ALL_PROXY: 'socks4://127.0.0.1:1080' }, undefined, null, NOT_SPOKEN, 0],
  ['no address at all', { HTTPS_PROXY: 'http://bad host:8080' }, undefined, null, NOT_TAKEN, 0],
  [
    'a host its proxy cannot take',
    { HTTPS_PROXY: 'http://bad_host-:8080' },
    undefined,
    { kind: 'http', host: 'bad_host-', port: 8080, bypass: [] },
    NOT_TAKEN,
    1,
  ],
  [
    "macOS's proxy given as a URL",
    {},
    scutilHttps('http://proxy.corp.example/'),
    { kind: 'http', host: 'proxy.corp.example', port: 8080, bypass: [] },
    null,
    0,
  ],
  ["macOS's proxy that isn't a host", {}, scutilHttps('proxy corp'), null, NOT_TAKEN, 0],
  ["macOS's proxy at a host its proxy cannot take", {}, scutilHttps('-bad.corp'), { kind: 'http', host: '-bad.corp', port: 8080, bypass: [] }, NOT_TAKEN, 1],
] as const) {
  test(`the window's proxy goes on the way the person's own traffic does: ${name}`, async ($, on) => {
    const asked = windowWorld(on, { env, scutil, proxyRefusesUpstream: refused })
    await openedInWindow($, asked)
    await asked.clock.advance(10)
    expect(asked.proxies[0]!.config.upstream).toEqual(upstream)
    expect(JSON.stringify(asked.proxies[0]!.config)).not.toContain('secret')
    if (note) expect(asked.toasted.filter(t => t.includes(note))).toHaveLength(1)
    else expect(asked.toasted.filter(t => t.includes('proxy setting') || t.includes('PAC'))).toEqual([])
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test("the person's proxy not used is said once a session, whichever says so: the plugin, its proxy, or its proxy again", async ($, on) => {
  // HTTPS_PROXY is no address at all (said here); ALL_PROXY's host the window's proxy can't take (said there, twice).
  const asked = windowWorld(on, { env: { HTTPS_PROXY: 'http://bad host:8080', ALL_PROXY: 'socks5://-bad.corp:1080' }, proxyRefusesUpstream: 2 })
  const pane = await openedInWindow($, asked)
  await asked.clock.advance(10)
  expect(asked.proxies[0]!.config.upstream).toEqual({ kind: 'socks5', host: '-bad.corp', port: 1080, bypass: [] })
  // Its window closed and opened again: a new proxy, which says it again.
  asked.windowState.alive = false
  await asked.clock.advance(30_100)
  expect(asked.proxies[0]!.stopped).toBe(true)
  await pane.press({ key: 'open-preview:pv-local' })
  await eventually(asked.clock, () => asked.launches.length === 2)
  await asked.clock.advance(10)
  expect(asked.proxies).toHaveLength(2)
  expect(asked.toasted.filter(t => t === NOT_TAKEN)).toHaveLength(1)
  // Nothing of the proxy it couldn't use is said: not its address, nor what the proxy printed.
  expect(asked.toasted.some(t => t.includes('bad.corp') || t.includes('INVALID_UPSTREAM'))).toBe(false)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a page asking for another port the host forwards gets its own tunnel, and the routes follow it', async ($, on) => {
  const api = { ...WINDOW_SHOWN, seq: 3, body: { kind: 'preview', pid: 'pv-api', port: 3610, path: '/', title: 'API', tcp: true } }
  const asked = windowWorld(on, {
    localPreviewByPid: { 'pv-api': { port: 45002 } },
    stream: [{ seq: 3, events: [WINDOW_SHOWN, api], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }],
  })
  await openedInWindow($, asked)
  expect(routesOf(asked)).toEqual({ routes: { '3340': 45001 }, startable: [3610] })
  asked.proxies[0]!.send({ state: 'want', port: 3610 })
  asked.proxies[0]!.send({ state: 'want', port: 3610 })
  await eventually(asked.clock, () => routesOf(asked)?.routes['3610'] === 45002)
  expect(routesOf(asked)).toEqual({ routes: { '3340': 45001, '3610': 45002 }, startable: [] })
  expect(tunnels(asked).map(t => [t.port, t.strict])).toEqual([
    [0, false],
    [0, false],
  ])
  expect(asked.localHelpers.map(h => h.pid)).toEqual(['pv-local', 'pv-api'])
  expect(asked.launches).toHaveLength(1)
  // Stopped by the host: its tunnel goes, and the window can't ask for it again.
  asked.proxies[0]!.send({ state: 'seen', port: 3610 })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  expect(asked.localHelpers.every(h => h.stopped)).toBe(true)
})

for (const need of ['delivered', 'undelivered', 'shared'] as const) {
  test(`a page asking for a port nobody shared asks the host once (${need})`, async ($, on) => {
    const asked = windowWorld(on, { need })
    await openedInWindow($, asked)
    asked.proxies[0]!.send({ state: 'blocked', port: 5555 })
    asked.proxies[0]!.send({ state: 'blocked', port: 5555 })
    await eventually(asked.clock, () => asked.sent.some(s => s.path.endsWith('/need')))
    await asked.clock.advance(20)
    const needs = asked.sent.filter(s => s.path.endsWith('/need'))
    expect(needs.map(s => s.body)).toEqual([{ port: 5555 }])
    expect(needs[0]!.headers.authorization).toBe('Bearer g')
    const said = asked.toasted.filter(t => t.startsWith('Your preview tried localhost:5555'))
    expect(said).toEqual(
      need === 'shared'
        ? []
        : [`Your preview tried localhost:5555, which Sam hasn't shared. ${need === 'delivered' ? 'The request went to Sam.' : 'Ask Sam to share it.'}`],
    )
    // Answered: asked once for the room, kept through a reload.
    expect(asked.state.needAsked).toEqual({ ports: [5555], times: [expect.any(Number)] })
    // A port the host forwards isn't asked about: it's there to start.
    asked.proxies[0]!.send({ state: 'blocked', port: 3340 })
    await asked.clock.advance(20)
    expect(asked.sent.filter(s => s.path.endsWith('/need'))).toHaveLength(1)
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test('the window asks the host about five ports a minute at most', async ($, on) => {
  const stream: unknown[] = [{ seq: 2, events: [WINDOW_SHOWN], people: PREVIEW_PEOPLE, ended: false, title: 'demo' }]
  const asked = windowWorld(on, { stream })
  await openedInWindow($, asked)
  stream.length = 0 // a quiet room from here on: its stream reconnects rarely
  for (let port = 5550; port < 5558; port++) asked.proxies[0]!.send({ state: 'blocked', port })
  await eventually(asked.clock, () => asked.sent.filter(s => s.path.endsWith('/need')).length === 5)
  await asked.clock.advance(50)
  expect(asked.sent.filter(s => s.path.endsWith('/need')).map(s => s.body.port)).toEqual([5550, 5551, 5552, 5553, 5554])
  await asked.clock.advance(61_000)
  asked.proxies[0]!.send({ state: 'blocked', port: 5557 })
  await asked.clock.advance(50)
  expect(asked.sent.filter(s => s.path.endsWith('/need')).map(s => s.body.port)).toEqual([5550, 5551, 5552, 5553, 5554, 5557])
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("the host's side refusing the window's tunnel stops it; the page's next ask starts it once more; refused again, only this person's Open reconnects it", async ($, on) => {
  const asked = windowWorld(on)
  await openedInWindow($, asked)
  const first = asked.localHelpers[0]!
  // A page's sockets refused together: one refusal, and nothing more of it.
  first.send({ state: 'channel-error', code: 'AUTH' })
  first.send({ state: 'channel-error', code: 'AUTH' })
  await eventually(asked.clock, () => first.stopped)
  await asked.clock.advance(20)
  expect(asked.state.previewNeedsOpen).toEqual([])
  expect(routesOf(asked)).toEqual({ routes: {}, startable: [3340] })
  // The page asks again: started anew, at once, nothing said.
  asked.proxies[0]!.send({ state: 'want', port: 3340 })
  await eventually(asked.clock, () => routesOf(asked)?.routes['3340'] === 45001)
  expect(asked.localHelpers).toHaveLength(2)
  expect(tunnels(asked)).toHaveLength(2)
  await asked.clock.advance(1_600)
  expect(asked.toasted.filter(t => t.includes('refused'))).toEqual([])
  // Refused again: stopped until this person presses Open.
  const second = asked.localHelpers[1]!
  second.send({ state: 'channel-error', code: 'AUTH' })
  await eventually(asked.clock, () => second.stopped)
  await asked.clock.advance(20)
  expect(asked.state.previewNeedsOpen).toEqual(['pv-local'])
  expect(routesOf(asked)).toEqual({ routes: {}, startable: [] })
  // Said a moment on (a Stop on the host's side would say that instead).
  expect(asked.toasted.filter(t => t.includes("refused the preview window's connection"))).toHaveLength(0)
  await asked.clock.advance(1_500)
  expect(asked.toasted.filter(t => t.includes("refused the preview window's connection to localhost:3340"))).toEqual([
    "Sam's side refused the preview window's connection to localhost:3340. Press Open preview to reconnect.",
  ])
  // The window asking again starts nothing, nor asks the host.
  asked.proxies[0]!.send({ state: 'want', port: 3340 })
  asked.proxies[0]!.send({ state: 'blocked', port: 3340 })
  await asked.clock.advance(50)
  expect(asked.localHelpers).toHaveLength(2)
  expect(asked.sent.filter(s => s.path.endsWith('/need'))).toHaveLength(0)
  // Open preview is back above the prompt; pressing it reconnects, and a
  // refusal after it gets its one restart again.
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => routesOf(asked)?.routes['3340'] === 45001)
  expect(asked.localHelpers).toHaveLength(3)
  expect(asked.state.previewNeedsOpen).toEqual([])
  expect(tunnels(asked)).toHaveLength(3)
  asked.localHelpers[2]!.send({ state: 'channel-error', code: 'AUTH' })
  await eventually(asked.clock, () => asked.localHelpers[2]!.stopped)
  await asked.clock.advance(20)
  expect(asked.state.previewNeedsOpen).toEqual([])
  expect(routesOf(asked)).toEqual({ routes: {}, startable: [3340] })
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("seated anew while a window Open starts its proxy, the Open goes on: the page's tunnel starts with the new seat's token and the window opens", async ($, on) => {
  let release!: () => void
  const proxyHold = new Promise<void>(done => {
    release = done
  })
  const refusals = { count: 0 }
  const asked = windowWorld(on, { streamRefusals: refusals, proxyHold })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.proxies.length)
  refusals.count = 1
  await within(asked.clock, () => asked.state.room?.token === 'g2', 5_000)
  release()
  await within(asked.clock, () => asked.launches.length, 5_000)
  await asked.clock.advance(20)
  expect(asked.toasted.some(t => t.includes('no longer open'))).toBe(false)
  expect(asked.launches).toHaveLength(1)
  expect(tunnels(asked).map(t => t.token)).toEqual(['g2'])
  expect(asked.toasted.some(t => t.startsWith("Opened Sam's localhost:3340 in a separate Google Chrome window."))).toBe(true)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("seated anew while a window tunnel starts, what started with the old seat's token stops and the Open says to press Open again: the next one's tunnel serves the window", async ($, on) => {
  const refusals = { count: 0 }
  const asked = windowWorld(on, { localPreview: 'wait', streamRefusals: refusals })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.localHelpers.length)
  refusals.count = 1
  await within(asked.clock, () => asked.state.room?.token === 'g2', 5_000)
  asked.localHelpers[0]!.send({ state: 'ready', port: 45001 })
  await eventually(asked.clock, () => asked.toasted.includes(RESEATED))
  await asked.clock.advance(20)
  // Nothing opened for it: its tunnel and the proxy it started stop.
  expect(asked.localHelpers[0]!.stopped).toBe(true)
  expect(asked.proxies[0]!.stopped).toBe(true)
  expect(asked.launches).toHaveLength(0)
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.localHelpers.length === 2)
  asked.localHelpers[1]!.send({ state: 'ready', port: 45002 })
  await within(asked.clock, () => asked.launches.length, 5_000)
  await asked.clock.advance(20)
  expect(tunnels(asked).map(t => t.token)).toEqual(['g', 'g2'])
  expect(asked.proxies.at(-1)!.routes.at(-1)?.routes['3340']).toBe(45002)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test("a window Open whose tunnel doesn't start stops the proxy it started: nothing is left running for no window; the next Open starts anew", async ($, on) => {
  let fail = true
  const asked = windowWorld(on, {
    beforeHelper: () => {
      if (fail) throw new Error("it didn't start")
    },
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'open-preview' })
  await eventually(asked.clock, () => asked.toasted.includes(tunnelUnstarted(3340)))
  await asked.clock.advance(20)
  expect(asked.launches).toHaveLength(0)
  expect(asked.proxies[0]!.stopped).toBe(true)
  expect(asked.state.previewWindow?.port).toBe(0)
  fail = false
  await ui.press({ key: 'open-preview' })
  await within(asked.clock, () => asked.launches.length, 5_000)
  expect(asked.proxies).toHaveLength(2)
  expect(asked.launches).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('a window tunnel that fails once up says nothing, and starts again when the page next asks for it', async ($, on) => {
  const asked = windowWorld(on)
  await openedInWindow($, asked)
  const before = asked.toasted.length
  asked.localHelpers[0]!.send({ state: 'error', code: 'STARTUP' })
  await eventually(asked.clock, () => routesOf(asked)?.startable.includes(3340))
  expect(routesOf(asked)).toEqual({ routes: {}, startable: [3340] })
  expect(asked.toasted.slice(before)).toEqual([])
  asked.proxies[0]!.send({ state: 'want', port: 3340 })
  await eventually(asked.clock, () => routesOf(asked)?.routes['3340'] === 45001)
  expect(asked.localHelpers).toHaveLength(2)
  expect(asked.localHelpers[0]!.stopped).toBe(true)
  expect(tunnels(asked)).toHaveLength(2)
  expect(asked.launches).toHaveLength(1)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

for (const seen of [true, false]) {
  test(`a window that ${seen ? 'uses' : 'never uses'} its proxy ${seen ? 'says nothing more' : 'says so after 15 s'}`, async ($, on) => {
    const asked = windowWorld(on)
    await openedInWindow($, asked)
    if (seen) asked.proxies[0]!.send({ state: 'seen', port: 3340 })
    await asked.clock.advance(14_000)
    expect(asked.toasted.some(t => t.includes("doesn't seem to use its proxy"))).toBe(false)
    await asked.clock.advance(1_100)
    expect(asked.toasted.some(t => t.includes("doesn't seem to use its proxy"))).toBe(!seen)
    await $.command.run({ command: 'stop-sharing', args: '' } as never)
  })
}

test('leaving closes the window and removes its profile', async ($, on) => {
  const asked = windowWorld(on)
  await openedInWindow($, asked)
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
  const profile = await roomProfile()
  expect(asked.windowState.alive).toBe(false)
  expect(asked.windowState.kills).toBe(1)
  const trash = asked.spawned.find(s => s.input?.startsWith('# shared-session: remove a preview profile'))
  expect(trash?.input).toContain(`p='${profile}'`)
  expect(trash?.input).toMatch(/\.trash-[0-9a-f]{12}"/)
  expect(asked.proxies[0]!.stopped).toBe(true)
  expect(asked.localHelpers.every(h => h.stopped)).toBe(true)
  expect(asked.state.previewWindow).toBeNull()
})

test('a session closing closes its window first and keeps the profile with its place', async ($, on) => {
  const asked = windowWorld(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start(START)
  await openedInWindow($, asked)
  await $.session.end({ reason: 'other', sessionId: 'session-test-0001', resume: {} } as never)
  expect(asked.windowState.alive).toBe(false)
  expect(asked.spawned.some(s => s.input?.startsWith('# shared-session: remove a preview profile'))).toBe(false)
  const kept = savedAt(asked, 'joined:session-test-0001')
  expect(kept.previewWindow).toEqual({ port: 47100, profile: (await roomProfile()).split('/').pop() })
  // What the host forwards goes with the place in its Shown.
  expect(kept.forwarded).toBeUndefined()
  expect(kept.shown).toEqual([
    {
      key: 'preview:pv-local',
      kind: 'preview',
      name: 'Sign in (preview)',
      title: 'Sign in',
      ts: 900,
      pid: 'pv-local',
      port: 3340,
      path: '/login?next=%2Faccount',
      tcp: true,
      host: '127.0.0.1',
    },
  ])
  expect(kept.localPreviews).toEqual([])
  expect(JSON.stringify(kept)).not.toContain(asked.proxies[0]!.config.controlToken)
  expect(asked.proxies[0]!.stopped).toBe(true)
})

test('a session closing saves its place while its window is still being closed', async ($, on) => {
  let closed: (() => void) | undefined
  const asked = windowWorld(on, {
    beforeKill: wait =>
      wait
        ? Promise.resolve()
        : new Promise<void>(done => {
            closed = done
          }),
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start(START)
  await openedInWindow($, asked)
  const ending = $.session.end({ reason: 'other', sessionId: 'session-test-0001', resume: {} } as never)
  expect(await eventually(asked.clock, () => Boolean(closed))).toBe(true)
  // The window is told to close first; the place is saved without waiting on it.
  const path = checkpointPath('joined:session-test-0001')
  expect(await eventually(asked.clock, () => asked.files.has(path))).toBe(true)
  expect(JSON.parse(asked.files.get(path)!).value.previewWindow).toEqual({ port: 47100, profile: (await roomProfile()).split('/').pop() })
  expect(asked.windowState.alive).toBe(true)
  closed!()
  await ending
  expect(asked.windowState.alive).toBe(false)
  expect(asked.state.mode).toBe('idle')
  expect(removedProfiles(asked)).toHaveLength(0)
})

test("a /clear leaves the room and moves the window's profile aside before it waits on anything", async ($, on) => {
  let gone: (() => void) | undefined
  const asked = windowWorld(on, {
    beforeKill: wait =>
      wait
        ? new Promise<void>(done => {
            gone = done
          })
        : Promise.resolve(),
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start(START)
  await openedInWindow($, asked)
  const profile = await roomProfile()
  const ending = $.session.end({ reason: 'clear', sessionId: 'session-test-0001', resume: {} } as never)
  // Inside session.end's short bound: the window told to close, its profile
  // (sign-ins and cookies) out of the way, and the room told.
  expect(await eventually(asked.clock, () => asked.includes('POST /api/rooms/room0000000000000001/leave'))).toBe(true)
  expect(asked.windowState.alive).toBe(false)
  expect(removedProfiles(asked).some(s => s.input?.includes(`p='${profile}'`))).toBe(true)
  expect(savedAt(asked, 'joined:session-test-0001')).toBeNull()
  gone?.()
  await ending
  expect(asked.state.mode).toBe('idle')
  expect(asked.logged).toContain("Left Sam's session.")
})

test('a link pasted while the room is still closing joins once it has closed, and the new room stays', async ($, on) => {
  let gone: (() => void) | undefined
  const asked = windowWorld(on, {
    beforeKill: wait =>
      wait
        ? new Promise<void>(done => {
            gone = done
          })
        : Promise.resolve(),
  })
  const pane = await openedInWindow($, asked)
  const leaving = $.command.run({ command: 'stop-sharing', args: '' } as never)
  expect(await eventually(asked.clock, () => Boolean(gone))).toBe(true)
  // Still closing: out of the room already (idle, its close marked), and
  // nothing offers Share until it's done.
  expect(asked.state.mode).toBe('idle')
  expect(asked.state.closing).toEqual({ how: 'leave', room: 'https://share.test/room0000000000000001' })
  const ui = await $.ui.mount(band('desktop'))
  expect(await ui.find({ key: 'share' })).toBeUndefined()
  expect(await ui.find({ key: 'team' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: "This session isn't shared" })).toBeDefined()
  expect(await pane.find({ key: 'room-share' })).toBeUndefined()
  const pasted = $.prompt.submit({ text: 'https://share.test/s/room0000000000000002', origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  expect(asked.filter(a => a.endsWith('/join'))).toHaveLength(1)
  gone!()
  await leaving
  await pasted
  await eventually(asked.clock, () => asked.state.room?.id === 'room0000000000000002')
  expect(asked.state.room?.id).toBe('room0000000000000002')
  expect(asked.state.mode).toBe('guest')
  expect(asked.state.closing).toBeNull()
  expect(asked.logged).toContain("Left Sam's session.")
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('once the room is left, the row and the Room offer Share again', async ($, on) => {
  let gone: (() => void) | undefined
  const asked = windowWorld(on, {
    beforeKill: wait =>
      wait
        ? new Promise<void>(done => {
            gone = done
          })
        : Promise.resolve(),
  })
  const pane = await openedInWindow($, asked)
  const ui = await $.ui.mount(band('desktop'))
  const leaving = $.command.run({ command: 'stop-sharing', args: '' } as never)
  expect(await eventually(asked.clock, () => Boolean(gone))).toBe(true)
  expect(await ui.find({ key: 'share' })).toBeUndefined()
  expect(await pane.find({ key: 'room-share' })).toBeUndefined()
  gone!()
  await leaving
  await asked.clock.advance(10)
  expect(asked.state.closing).toBeNull()
  expect(await ui.find({ key: 'share' })).toBeDefined()
  expect(await pane.find({ key: 'room-share' })).toBeDefined()
})
