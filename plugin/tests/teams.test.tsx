// Updates, sign-in, teams and invites, the sidebar's pin, a guest's working line.

import { expect, test } from 'claude-code/testing'
import { readsInside, readTargets, realInside } from '../hooks/paths'
import {
  LINK,
  band,
  world,
  eventually,
  ACCOUNT_FILE,
  TEAM_TOKEN,
  ME,
  TEAM_PANE,
  teamSession,
  ROW,
  PANE,
  sidebar,
  START,
  NAMED,
  KNOWN,
  LIVE,
  INVITE,
  model,
  STEP,
  within,
} from './support/world'

test('in Claude Desktop, a copy installed from a local marketplace folder says how to update in place', async ($, on) => {
  const asked = world(on, {
    latest: '9.9.9',
    settings: JSON.stringify({
      env: NAMED,
      extraKnownMarketplaces: { 'claude-share': { source: { source: 'directory', path: '/home/scott/claude-share' }, autoUpdate: true } },
    }),
    files: {
      [LIVE]: '{}',
      [KNOWN]: JSON.stringify({ 'claude-share': { source: { source: 'directory', path: '/home/scott/claude-share' }, autoUpdate: true } }),
    },
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const command =
    'claude plugin marketplace remove claude-share && claude plugin marketplace add Paradigm-Study/claude-share && claude plugin install shared-session@claude-share'
  expect(asked.logged.some(l => l.includes('9.9.9 is out') && l.includes('local marketplace folder') && l.includes(command))).toBe(true)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-settings' })
  expect(await pane.find({ type: 'Text', text: /runs the copy installed from your local marketplace folder/ })).toBeDefined()
  expect(await pane.find({ key: 'copy-switch' })).toBeDefined()
})

test('a GitHub marketplace in Claude Desktop shows no such note', async ($, on) => {
  const asked = world(on, {
    settings: JSON.stringify({
      env: NAMED,
      extraKnownMarketplaces: { 'claude-share': { source: { source: 'github', repo: 'Paradigm-Study/claude-share' }, autoUpdate: true } },
    }),
    files: {
      [LIVE]: '{}',
      [KNOWN]: JSON.stringify({ 'claude-share': { source: { source: 'github', repo: 'Paradigm-Study/claude-share' }, autoUpdate: true } }),
    },
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-settings' })
  expect(await pane.find({ key: 'copy-switch' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /next new session on, a release loads in place/ })).toBeDefined()
})

test('a marketplace added again keeps automatic updates when updates in place were chosen', async ($, on) => {
  const asked = world(on, {
    settings: JSON.stringify({
      theme: 'dark',
      env: NAMED,
      extraKnownMarketplaces: { 'claude-share': { source: { source: 'github', repo: 'Paradigm-Study/claude-share' } } },
    }),
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const saved = JSON.parse(asked.written.at(-1)?.text ?? '{}')
  expect(saved.extraKnownMarketplaces['claude-share']).toEqual({ source: { source: 'github', repo: 'Paradigm-Study/claude-share' }, autoUpdate: true })
  expect(saved.env).toEqual(NAMED)
  expect(saved.theme).toBe('dark')
})

test("a guest's read runs without asking only inside the host's project", async () => {
  const cwd = '/tmp/demo'
  expect(readsInside('Read', { file_path: '/tmp/demo/src/app.ts' }, cwd)).toBe(true)
  expect(readsInside('Read', { file_path: 'src/app.ts' }, cwd)).toBe(true)
  expect(readsInside('Grep', { pattern: 'TODO' }, cwd)).toBe(true) // no path: the project
  expect(readsInside('Read', { file_path: '/Users/scott/.ssh/id_ed25519' }, cwd)).toBe(false)
  expect(readsInside('Read', { file_path: '~/.aws/credentials' }, cwd)).toBe(false)
  expect(readsInside('Read', { file_path: '../other/secrets.env' }, cwd)).toBe(false)
  expect(readsInside('Read', { file_path: '/tmp/demo/../demo-other/x' }, cwd)).toBe(false)
  expect(readsInside('Glob', { pattern: '/etc/**' }, cwd)).toBe(false)
  expect(readsInside('Grep', { pattern: 'key', path: '/' }, cwd)).toBe(false)
  // What's looked at for links: each path as written, a Glob's pattern up to
  // its first wildcard, from the folder it's given.
  expect(readTargets('Grep', { pattern: 'TODO' }, cwd)).toEqual([])
  expect(readTargets('Read', { file_path: 'src/./app.ts' }, cwd)).toEqual(['/tmp/demo/src/app.ts'])
  expect(readTargets('Glob', { pattern: 'notes/**/*.md', path: 'docs' }, cwd)).toEqual(['/tmp/demo/docs', '/tmp/demo/docs/notes'])
  expect(readTargets('Glob', { pattern: '../**', path: 'docs' }, cwd)).toEqual(['/tmp/demo/docs', '/tmp/demo', '/tmp/demo/docs/..'])
  expect(readTargets('Glob', { pattern: '../../**', path: 'docs' }, cwd)).toBeNull()
  // Past a wildcard nothing climbs: `**` may be no folder at all, and a brace may hold `..`.
  expect(readTargets('Glob', { pattern: '**/../x/*' }, cwd)).toBeNull()
  expect(readTargets('Glob', { pattern: '{..,src}/*' }, cwd)).toBeNull()
  // A name with a wildcard's characters is a name to every other tool, looked at whole.
  expect(readTargets('Read', { file_path: 'notes[1].md' }, cwd)).toEqual(['/tmp/demo/notes[1].md'])
  // Climbing back out of a link goes on from where the link points: also given as written.
  expect(readTargets('Read', { file_path: 'notes/../x' }, cwd)).toEqual(['/tmp/demo/x', '/tmp/demo/notes/../x'])
  // Real paths: in the project's real folder, or it.
  expect(realInside('/private/tmp/demo', ['/private/tmp/demo', '/private/tmp/demo/src/app.ts'])).toBe(true)
  expect(realInside('/private/tmp/demo', ['/private/tmp/demo-other/x'])).toBe(false)
  expect(realInside('/private/tmp/demo', ['/Users/scott/.ssh/id_ed25519'])).toBe(false)
})

// A link in the project (a repository's own, committed) can name any file
// of the host's: a guest's read through it is no read inside the project.
test("a teammate's read runs without asking only where it really is inside the project: through a link out of it, the host is asked", async ($, on) => {
  const people = [
    { id: 'host', name: 'scott', role: 'host', online: true },
    { id: 'seat2', name: 'Alex', role: 'guest', online: true },
  ]
  const prompt = { seq: 2, type: 'prompt', ts: 900, from: { seat: 'seat2', name: 'Alex', role: 'guest' }, body: { text: 'Read the notes', pid: 'p1' } }
  const asked = world(on, {
    surfaces: ['desktop'],
    links: { '/tmp/demo/notes': '/Users/scott/.ssh' },
    stream: [{ seq: 2, events: [prompt], people, ended: false, title: 'demo' }],
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.check', () => ({ decision: 'allow', reason: 'Allowed in this mode' }))
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  expect(await within(asked.clock, () => asked.submitted.some(p => p.text === 'Alex: Read the notes'), 5_000)).toBe(true)
  await $.turn.start({ turnId: 'alex-1', text: 'Alex: Read the notes' })
  expect(await $.tool.check({ tool: 'Read', input: { file_path: '/tmp/demo/src/app.ts' }, tool_use_id: 'toolu_in' } as never)).toEqual({
    decision: 'allow',
    reason: 'Allowed in this mode',
  })
  expect(await $.tool.check({ tool: 'Grep', input: { pattern: 'TODO' }, tool_use_id: 'toolu_grep' } as never)).toEqual({
    decision: 'allow',
    reason: 'Allowed in this mode',
  })
  const verdicts: Record<string, unknown> = {}
  for (const [id, tool, input] of [
    ['link', 'Read', { file_path: 'notes/id_ed25519' }],
    ['glob', 'Glob', { pattern: '*', path: '/tmp/demo/notes' }],
    ['out', 'Read', { file_path: 'src/../notes/../x' }],
  ] as const) {
    void $.tool.check({ tool, input, tool_use_id: `toolu_${id}` } as never).then(v => void (verdicts[id] = v))
    expect(await eventually(asked.clock, () => asked.state.approving)).toMatchObject({ who: 'Alex' })
    const row = await $.ui.mount(band('desktop'))
    await row.press({ key: 'approve-no' })
    await eventually(asked.clock, () => verdicts[id])
    expect(verdicts[id]).toEqual({ decision: 'deny', reason: `scott did not allow this ${tool} call from the shared session.` })
  }
  await $.command.run({ command: 'stop-sharing', args: '' } as never)
})

test('signing in opens the browser with only a hash of the secret, and keeps the sign-in where only this user reads it', async ($, on) => {
  const asked = world(on)
  await $.command.run({ command: 'team' } as never)
  expect(asked.opened).toContain('shared-team')
  await asked.clock.advance(10)
  const pane = await $.ui.mount(TEAM_PANE)
  await pane.press({ key: 'signin-github' })
  const browser = await eventually(asked.clock, () => asked.spawned.find(s => s.input?.includes('/auth/github/start?login=')))
  const login = /login=([0-9a-f]{64})/.exec(browser?.input ?? '')?.[1]
  expect(login).toBeDefined()
  await asked.clock.advance(2_100)
  const poll = await eventually(asked.clock, () => asked.sent.find(r => r.path === '/api/auth/poll'))
  const verifier = String(poll?.body.verifier ?? '')
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  expect([...digest].map(b => b.toString(16).padStart(2, '0')).join('')).toBe(login)
  expect(asked.urls.some(u => u.includes(verifier))).toBe(false)
  // Saved through a umask, the token on stdin, never in arguments or an address.
  const save = await eventually(asked.clock, () => asked.spawned.find(s => s.input?.startsWith('umask 077')))
  expect(save?.input).toContain(TEAM_TOKEN)
  expect(asked.spawned.some(s => s.argv.join(' ').includes('ssa_'))).toBe(false)
  expect(asked.urls.some(u => u.includes('ssa_'))).toBe(false)
  expect(JSON.parse(asked.files.get(ACCOUNT_FILE) ?? '{}').servers['http://localhost:8787'].token).toBe(TEAM_TOKEN)
  await eventually(asked.clock, () => asked.sent.some(r => r.path === '/api/teams/team0001'))
  await asked.clock.advance(10)
  expect(await pane.find({ type: 'Text', text: 'Acme' })).toBeDefined()
})

// The sign-in follows Claude Code's own folder, as the checkpoints and the
// settings do: ~/.claude's unless CLAUDE_CONFIG_DIR names another.
const OWN_CONFIG = '/home/scott/cfg'

const CONFIG_ACCOUNT = `${OWN_CONFIG}/shared-session/account.json`

const accountWrites = (asked: ReturnType<typeof world>, path: string) =>
  asked.spawned.filter(s => s.input?.startsWith('umask 077') && s.input.includes(`mv '${path}.tmp' '${path}'`))

for (const config of [undefined, OWN_CONFIG] as const) {
  test(`signing in ${config ? 'with CLAUDE_CONFIG_DIR set keeps the sign-in in that folder, and reads it back from there' : 'keeps the sign-in in ~/.claude when CLAUDE_CONFIG_DIR is unset, as before'}`, async ($, on) => {
    const asked = world(on, config ? { env: { CLAUDE_CONFIG_DIR: config } } : {})
    await $.command.run({ command: 'team', args: 'signin github' } as never)
    await asked.clock.advance(2_100)
    const file = config ? CONFIG_ACCOUNT : ACCOUNT_FILE
    await eventually(asked.clock, () => asked.files.has(file))
    expect(JSON.parse(asked.files.get(file)!).servers['http://localhost:8787'].token).toBe(TEAM_TOKEN)
    expect(accountWrites(asked, file).map(s => s.argv)).toEqual([['/bin/sh', '-s']])
    if (config) expect(asked.files.has(ACCOUNT_FILE)).toBe(false)
    expect(await $.command.run({ command: 'team', args: 'signin' } as never)).toEqual({ text: `Signed in as ${ME.name}. /team signout to sign out.` })
  })
}

for (const how of ['signout', 'delete-account'] as const) {
  test(`/team ${how} with CLAUDE_CONFIG_DIR set clears that folder's sign-in, and writes nothing in ~/.claude`, async ($, on) => {
    const asked = world(on, { env: { CLAUDE_CONFIG_DIR: OWN_CONFIG }, team: { signedIn: true } })
    await $.command.run({ command: 'team', args: how } as never)
    expect(asked).toContain(how === 'signout' ? 'POST /api/auth/logout' : 'DELETE /api/me')
    expect(JSON.parse(asked.files.get(CONFIG_ACCOUNT)!).servers).toEqual({})
    expect(asked.files.has(ACCOUNT_FILE)).toBe(false)
    // Signed out: a sign-in starts over.
    const again = await $.command.run({ command: 'team', args: 'signin' } as never)
    expect(JSON.stringify(again)).toContain('Sign in with: /team signin github or /team signin google')
    expect(JSON.parse(asked.files.get(CONFIG_ACCOUNT)!).servers).toEqual({})
  })
}

// What the server's confirmation page shows: the first eight hex of the hash
// the sign-in sent (C2-signin), as the person compares them.
const codeOf = (opened: string | undefined) => {
  const login = /login=([0-9a-f]{64})/.exec(opened ?? '')?.[1] ?? ''
  const code = `${login.slice(0, 4)}-${login.slice(4, 8)}`.toUpperCase()
  return { login, code, said: `Your browser will show the code ${code}: continue there only if it matches.` }
}

test('/team signin says the code the browser will show, from the hash it sends, once: in its reply', async ($, on) => {
  const asked = world(on)
  const reply = await $.command.run({ command: 'team', args: 'signin github' } as never)
  const { login, said } = codeOf(asked.spawned.find(s => s.input?.includes('/auth/github/start?login='))?.input)
  expect(login).toMatch(/^[0-9a-f]{64}$/)
  expect(reply).toEqual({
    text: `Sign in with GitHub in your browser; this session picks it up when you're done. ${said} If no browser opened: http://localhost:8787/auth/github/start?login=${login}`,
  })
  expect(asked.toasted.some(t => t.includes('Your browser will show the code'))).toBe(false)
})

test("the Team panel's sign-in says the code the browser will show, as it opens and while it waits", async ($, on) => {
  const asked = world(on)
  await $.command.run({ command: 'team' } as never)
  await asked.clock.advance(10)
  const pane = await $.ui.mount(TEAM_PANE)
  await pane.press({ key: 'signin-github' })
  const opened = (await eventually(asked.clock, () => asked.spawned.find(s => s.input?.includes('/auth/github/start?login='))))?.input
  const { login, code, said } = codeOf(opened)
  expect(opened).toContain(`/auth/github/start?login=${login}'`)
  expect(asked.toasted).toContain(said)
  expect(await pane.find({ type: 'Text', text: 'Finish signing in with GitHub in your browser…' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: said })).toBeDefined()
  expect(asked.state.teams?.signingIn?.code).toBe(code)
})

test('signed in with a team, Share goes to it, the sign-in in a header and never an address', async ($, on) => {
  const asked = world(on, { team: { signedIn: true } })
  await $.command.run({ command: 'team', args: 'sessions' } as never)
  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ key: 'share' }))?.props.label).toBe('Share with Acme')
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  const made = asked.sent.find(r => r.path === '/api/rooms')
  expect(made?.body.team).toBe('team0001')
  expect(made?.headers['x-shared-session-account']).toBe(TEAM_TOKEN)
  expect(asked.urls.some(u => u.includes('ssa_'))).toBe(false)
  expect(
    asked.logged.some(l =>
      l.startsWith('Sharing with Acme. Everyone in Acme sees it in their Team panel and can join; the link works only for people in Acme'),
    ),
  ).toBe(true)
})

test('/share-session link shares by link alone, even signed in', async ($, on) => {
  const asked = world(on, { team: { signedIn: true } })
  const r = await $.command.run({ command: 'share-session', args: 'link' } as never)
  await asked.clock.advance(100)
  expect(asked.sent.find(x => x.path === '/api/rooms')?.body.team).toBeUndefined()
  // No team, but the room knows the host by account: their other sessions are them.
  expect(asked.sent.find(x => x.path === '/api/rooms')?.headers['x-shared-session-account']).toBe(TEAM_TOKEN)
  expect(JSON.stringify(r)).toContain('Anyone with this link can join')
})

test("the Team panel lists the team's live sessions; Join in a fresh session joins here, the sign-in sent", async ($, on) => {
  const asked = world(on, { team: { signedIn: true, sessions: [teamSession(1), teamSession(2, 'Kim')] } })
  await $.command.run({ command: 'team' } as never)
  await asked.clock.advance(10)
  const pane = await $.ui.mount(TEAM_PANE)
  expect(await pane.find({ type: 'Text', text: 'demo: work 1' })).toBeDefined()
  // One primary: Join all, the rows' own Join quieter.
  expect((await pane.find({ key: 'join-all' }))?.props.variant).toBe('primary')
  expect((await pane.find({ key: 'join-room0000000000000101' }))?.props.variant).toBeUndefined()
  await pane.press({ key: 'join-room0000000000000101' })
  const join = await eventually(asked.clock, () => asked.sent.find(r => r.path.startsWith('/api/rooms/room0000000000000101/join')))
  expect(join?.headers['x-shared-session-account']).toBe(TEAM_TOKEN)
  await eventually(asked.clock, () => asked.submitted.some(p => p.text === "Join Sam's session"))
  expect(asked.submitted.some(p => p.text === "Join Sam's session")).toBe(true)
  const row = await $.ui.mount(band('desktop'))
  expect((await row.find({ type: 'Text', text: /^Joined$/ }))?.props.bold).toBe(true)
})

test('Join all from a session in use opens a new Claude Desktop session, and each that joins opens the next', async ($, on) => {
  const asked = world(on, {
    team: { signedIn: true, sessions: [teamSession(1), teamSession(2, 'Kim')] },
    history: [{ role: 'user', content: 'Fix the build' }],
  })
  await $.command.run({ command: 'team', args: '' } as never)
  await asked.clock.advance(10)
  const pane = await $.ui.mount(TEAM_PANE)
  await pane.press({ key: 'join-all' })
  // Desktop holds one new-session draft at a time: one opens, the other waits.
  const deep = () => asked.spawned.filter(s => s.input?.includes('claude://code/new?q='))
  expect(deep().length).toBe(1)
  expect(deep()[0]?.input).toContain(encodeURIComponent('http://localhost:8787/s/room0000000000000101'))
  expect(asked.sent.some(r => r.path.endsWith('/join'))).toBe(false)
  // The session it opened joins (here, as the same store stands in for it): the next opens.
  await $.prompt.submit({ text: 'http://localhost:8787/s/room0000000000000101', origin: { kind: 'composer' }, wait: false })
  await eventually(asked.clock, () => deep().length === 2)
  expect(deep().length).toBe(2)
  expect(deep()[1]?.input).toContain(encodeURIComponent('http://localhost:8787/s/room0000000000000102'))
})

test('a members-only session refuses someone not signed in, and the Team panel opens to sign in', async ($, on) => {
  const asked = world(on, { team: { refuseJoin: true } })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await eventually(asked.clock, () => asked.opened.includes('shared-team'))
  expect(asked.opened).toContain('shared-team')
  const row = await $.ui.mount(band('desktop'))
  expect(await row.find({ key: 'share' })).toBeDefined() // still not joined
})

test('an invite link pasted joins the team when signed in; signed out, signing in carries it', async ($, on) => {
  const asked = world(on)
  await $.prompt.submit({ text: 'http://localhost:8787/i/invite0001', origin: { kind: 'composer' }, wait: false })
  await eventually(asked.clock, () => asked.opened.includes('shared-team'))
  expect(asked.opened).toContain('shared-team')
  const pane = await $.ui.mount(TEAM_PANE)
  await pane.press({ key: 'signin-google' })
  expect(
    await eventually(asked.clock, () => asked.spawned.some(s => s.input?.includes('/auth/google/start?login=') && s.input.includes('&invite=invite0001'))),
  ).toBe(true)
  await asked.clock.advance(2_100)
  await eventually(asked.clock, () => asked.files.has(ACCOUNT_FILE))
  // Signed in now: another invite is taken at once.
  await $.prompt.submit({ text: 'http://localhost:8787/i/invite0002', origin: { kind: 'composer' }, wait: false })
  const taken = await eventually(asked.clock, () => asked.sent.find(r => r.path === '/api/invites/invite0002'))
  expect(taken?.headers.authorization).toBe(`Bearer ${TEAM_TOKEN}`)
})

test('signed out, the Team panel asks for the sign-ins each time, so one the server gains shows up', async ($, on) => {
  const providers = [{ id: 'github', label: 'GitHub' }]
  const asked = world(on, { team: { providers } })
  await $.command.run({ command: 'team', args: '' } as never)
  await eventually(asked.clock, () => asked.sent.some(r => r.path === '/api/auth/providers'))
  await asked.clock.advance(10)
  const pane = await $.ui.mount(TEAM_PANE)
  expect(await pane.find({ key: 'signin-github' })).toBeDefined()
  expect(await pane.find({ key: 'signin-google' })).toBeUndefined()
  providers.push({ id: 'google', label: 'Google' })
  await asked.clock.advance(20_000) // the open panel's refresh
  await eventually(asked.clock, () => asked.sent.filter(r => r.path === '/api/auth/providers').length >= 2)
  await asked.clock.advance(10)
  expect(await pane.find({ key: 'signin-google' })).toBeDefined()
})

test('a long history comes in pages: the join asks for them, and reads every one', async ($, on) => {
  const asked = world(on, { paged: {} })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await eventually(asked.clock, () => asked.urls.some(u => u.includes('/events?after=1&wait=0&max=')))
  expect(asked.urls.some(u => /\/join\?max=\d+/.test(u))).toBe(true)
  // Every read of the room's events asks for pages the engine can carry.
  expect(asked.urls.filter(u => u.includes('/events?')).every(u => u.includes('max='))).toBe(true)
  const row = await $.ui.mount(band('desktop'))
  expect((await row.find({ type: 'Text', text: /^Joined$/ }))?.props.bold).toBe(true)
})

test('a join that fails after the seat was taken gives the seat back', async ($, on) => {
  const asked = world(on, { paged: { failRest: true } })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await eventually(asked.clock, () => asked.includes('POST /api/rooms/room0000000000000001/leave'))
  expect(asked).toContain('POST /api/rooms/room0000000000000001/leave')
  const row = await $.ui.mount(band('desktop'))
  expect(await row.find({ key: 'share' })).toBeDefined() // not left half in
})

test("a teammate's invite shows above the prompt; Join joins it and clears it everywhere", async ($, on) => {
  const asked = world(on, { team: { signedIn: true }, invites: [INVITE] })
  await $.command.run({ command: 'team', args: 'invites' } as never)
  const row = await $.ui.mount(band('desktop'))
  expect(await row.find({ type: 'Text', text: 'Sam invites you' })).toBeDefined()
  expect(await row.find({ type: 'Text', text: 'demo: fix the build' })).toBeDefined()
  expect((await row.find({ key: 'invite-join' }))?.props.variant).toBe('primary')
  expect(await row.find({ key: 'share' })).toBeUndefined() // one thing at a time
  await row.press({ key: 'invite-join' })
  await eventually(asked.clock, () => asked.urls.some(u => u.includes('/api/rooms/room0000000000000201/join')))
  expect(asked).toContain('DELETE /api/me/invites/room0000000000000201')
  expect(asked.sent.find(r => r.path.startsWith('/api/rooms/room0000000000000201/join'))?.headers['x-shared-session-account']).toBe(TEAM_TOKEN)
})

test('Dismiss sets an invite aside, and the row goes back to Share', async ($, on) => {
  const asked = world(on, { team: { signedIn: true }, invites: [INVITE] })
  await $.command.run({ command: 'team', args: 'invites' } as never)
  const row = await $.ui.mount(band('desktop'))
  await row.press({ key: 'invite-dismiss' })
  await eventually(asked.clock, () => asked.includes('DELETE /api/me/invites/room0000000000000201'))
  expect(await row.find({ key: 'share' })).toBeDefined()
})

test('the host invites a teammate from the Room, as themselves, and sees who was invited', async ($, on) => {
  const asked = world(on, { team: { signedIn: true } })
  const row = await $.ui.mount(band('desktop'))
  await $.command.run({ command: 'team', args: 'sessions' } as never)
  await row.press({ key: 'share' })
  await row.press({ key: 'share-prompt' })
  await asked.clock.advance(50)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect(await pane.find({ type: 'Text', text: 'Kim (kimk)' })).toBeDefined()
  await pane.press({ key: 'invite-acct-kim' })
  const sentInvite = await eventually(asked.clock, () => asked.sent.find(r => r.path === '/api/rooms/room0000000000000002/invite'))
  expect(sentInvite?.body.to).toEqual(['acct-kim'])
  expect(sentInvite?.headers['x-shared-session-account']).toBe(TEAM_TOKEN)
  await asked.clock.advance(10)
  expect(await pane.find({ type: 'Text', text: /^Invited/ })).toBeDefined()
  // Not here yet: invited again from the same row, and the invite goes out again.
  expect((await pane.find({ key: 'invite-acct-kim' }))?.props.label).toBe('Invite again')
  const invitesSent = () => asked.sent.filter(r => r.path === '/api/rooms/room0000000000000002/invite').length
  const before = invitesSent()
  await pane.press({ key: 'invite-acct-kim' })
  await eventually(asked.clock, () => invitesSent() > before)
  expect(invitesSent()).toBe(before + 1)
  // And by name, in a terminal.
  const r = await $.command.run({ command: 'invite', args: 'kim' } as never)
  expect(JSON.stringify(r)).toContain('Invited Kim')
})

test('a host signed in has Invite in the row, and an empty team says how to fill it', async ($, on) => {
  const asked = world(on, { team: { signedIn: true } })
  await $.command.run({ command: 'team', args: 'sessions' } as never)
  const row = await $.ui.mount(band('desktop'))
  await row.press({ key: 'share' })
  await row.press({ key: 'share-prompt' })
  await asked.clock.advance(50)
  // Invite lives in the Room's header, the row's three words are Room, Copy link and Stop.
  expect(await row.find({ key: 'invite' })).toBeUndefined()
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  expect((await pane.find({ key: 'room-invite' }))?.props.label).toBe('Invite')
})

test('a new invite raises one desktop notification for the machine, not again at the next look', async ($, on) => {
  const asked = world(on, { team: { signedIn: true }, invites: [INVITE] })
  on('ui.notify', () => ({ value: { isSent: false as const, reason: 'no-surface' as const } })) // Claude Desktop: no terminal
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await asked.clock.advance(2_100) // the first look, 2 s after start
  await eventually(asked.clock, () => asked.spawned.some(s => s.input?.includes('display notification')))
  const raised = asked.spawned.filter(s => s.input?.includes('display notification'))
  expect(raised.length).toBe(1)
  expect(raised[0]?.input).toContain('with title "Sam invites you"')
  expect(raised[0]?.input).toContain('demo: fix the build')
  await asked.clock.advance(31_000) // the next look at the server: the same invite
  await asked.clock.advance(10_000)
  expect(asked.spawned.filter(s => s.input?.includes('display notification')).length).toBe(1)
})

test('a terminal that notifies gets it on its own channel; turned off, nothing', async ($, on) => {
  const asked = world(on, { team: { signedIn: true }, invites: [INVITE] })
  const notified: string[] = []
  on('ui.notify', ($, e) => {
    notified.push(`${e.title}: ${e.text}`)
    return { value: { isSent: true as const, channel: 'iterm2' as const } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await asked.clock.advance(2_100)
  await eventually(asked.clock, () => notified.length > 0)
  expect(notified[0]).toContain('Sam invites you')
  expect(asked.spawned.some(s => s.input?.includes('display notification'))).toBe(false)
})

test('invites can be just shown, without a notification', async ($, on) => {
  const asked = world(on, { team: { signedIn: true }, invites: [INVITE], store: { inviteNotify: false } })
  on('ui.notify', () => ({ value: { isSent: false as const, reason: 'no-surface' as const } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  await asked.clock.advance(2_100)
  await eventually(asked.clock, () => asked.urls.some(u => u.includes('/api/me/invites')))
  await asked.clock.advance(100)
  expect(asked.spawned.some(s => s.input?.includes('display notification'))).toBe(false)
  const row = await $.ui.mount(band('desktop'))
  expect(await row.find({ type: 'Text', text: 'Sam invites you' })).toBeDefined() // still shown
})

test('a long invite title is cut to fit beside Join, its paths shortened, never pushing the buttons out', async ($, on) => {
  const long = {
    ...INVITE,
    room: {
      ...INVITE.room,
      title: 'interview-prep-handoff-c305f4: @"/Users/jingjing/Desktop/paradigm-study-web/artifacts/interview-prep-notes.md" read this and take over the prep',
    },
  }
  const asked = world(on, { team: { signedIn: true }, invites: [long] })
  await $.command.run({ command: 'team', args: 'invites' } as never)
  void asked
  const row = await $.ui.mount(band('desktop'))
  // One row: who, then the title, its paths shortened; the whole line is what's cut.
  expect(await row.find({ type: 'Text', text: /^ · interview-prep-handoff-c305f4: interview-prep-notes\.md read this/ })).toBeDefined()
  const line = (await row.findAll({ type: 'Text' })).find(t => /invites you · interview-prep-handoff/.test(t.text ?? ''))
  expect(line?.props.wrap).toBe('truncate-end')
  // The words sit in a column that may shrink to nothing; the buttons keep their width.
  const tree = JSON.stringify(await row.drawn())
  expect(tree).toContain('"minWidth":0')
  expect(await row.find({ key: 'invite-join' })).toBeDefined()
  expect(await row.find({ key: 'invite-dismiss' })).toBeDefined()
})

test("a title made from a prompt with a picture leaves Claude Code's note about it out", async ($, on) => {
  const asked = world(on, {
    team: {
      signedIn: true,
      sessions: [
        {
          ...teamSession(1),
          title:
            'agent-composition-ux-9e06eb: [Image: original 1280x14646, displayed at 175x2000. Multiply coordinates by 7.31 to map to original image.] make this match the mock',
        },
      ],
    },
  })
  await $.command.run({ command: 'team', args: '' } as never)
  await eventually(asked.clock, () => asked.sent.some(r => r.path === '/api/teams/team0001/sessions'))
  await asked.clock.advance(10)
  const pane = await $.ui.mount(TEAM_PANE)
  expect(await pane.find({ type: 'Text', text: 'agent-composition-ux-9e06eb: make this match the mock' })).toBeDefined()
})

test('a refused pin puts Allow pinning above the prompt; pressing it adds the rules and pins', async ($, on) => {
  const asked = world(on, { settings: '{"model":"opus"}' })
  const calls = sidebar(on, { title: 'Fix login flow', refuse: true })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(81_000) // refused, tried again twice
  expect(asked.store.get('pinLog')).toBeDefined()
  expect(await ui.find({ key: 'band-allow-pin' })).toBeDefined()
  // Not in a terminal: it has no sidebar.
  const terminal = await $.ui.mount(band('terminal'))
  expect(await terminal.find({ key: 'band-allow-pin' })).toBeUndefined()
  calls.refuse(false) // an allow rule lets the call through
  await ui.press({ key: 'band-allow-pin' })
  await asked.clock.advance(10)
  const settings = JSON.parse(asked.files.get('/home/scott/.claude/settings.json') ?? '{}')
  expect(settings.permissions.allow).toContain('mcp__ccd_sidebar__set_pinned')
  expect(calls.at(-2)).toBe('set_pinned {"session_id":"local_test","pinned":true}')
  expect(await ui.find({ key: 'band-allow-pin' })).toBeUndefined()
})

test('a guest whose seat the room let go (asleep, offline) takes a new one and stays in the session', async ($, on) => {
  const asked = world(on, { stream: [{ seq: 2, events: [], people: [], ended: false, title: 'demo' }], streamRefuses: 1 })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(100)
  expect(asked.filter(a => a === 'POST /api/rooms/room0000000000000001/join')).toHaveLength(2)
  expect(asked.logged.some(line => line.includes('no longer shared'))).toBe(false)
  // The stream goes on with the new seat's token, from where it was.
  const streams = asked.spawned.filter(s => s.argv[0] === 'curl')
  expect(streams.at(-1)?.input).toContain('Authorization: Bearer g2')
  expect(streams.at(-1)?.input).toContain('stream?after=1')
  const ui = await $.ui.mount(band('desktop'))
  expect(await ui.find({ key: 'leave' })).toBeDefined()
  // A prompt then goes out with the new seat.
  await $.prompt.submit({ text: 'Run the tests', origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(100)
  expect(asked.posted.find(e => e.type === 'prompt')?.body.text).toBe('Run the tests')
  expect(asked.sent.filter(x => x.path.endsWith('/events') && x.body.events).at(-1)?.headers.authorization).toBe('Bearer g2')
})

test('the Room counts you once, with every session of yours', async ($, on) => {
  world(on, {
    people: [
      { id: 'host', name: 'Sam', role: 'host', online: true },
      { id: 'seat9', name: 'scott', role: 'guest', online: true, seats: ['seat9', 'seat1'], account: 'acct0001' } as never,
      { id: 'seat2', name: 'Alex', role: 'guest', online: true },
    ],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  const ui = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.filter(t => t === 'scott')).toHaveLength(1)
  expect(texts.some(t => /\byou\b/.test(t))).toBe(true)
  const footer = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
  expect((await footer.find({ type: 'Text' }))?.text).toBe("in Sam's session with Alex")
})

const HOLD = (room: string, mode: 'host' | 'guest' = 'guest') => ({
  room,
  session: 'session-other-0002',
  place: 'local_0000aaaa-0000-4000-8000-000000000001',
  mode,
  title: 'demo: work',
  host: 'Sam',
  at: 900,
})

test("the Team panel opens a session you're already in, and Join all leaves out what's yours", async ($, on) => {
  const sessions = [teamSession(1), teamSession(2, 'Kim'), { ...teamSession(3, 'Lee'), accounts: ['acct-Lee', ME.id] }, teamSession(4, 'Ana')]
  const asked = world(on, { team: { signedIn: true, sessions }, store: { 'live:room0000000000000101:session-other-0002': HOLD('room0000000000000101') } })
  await $.command.run({ command: 'team' } as never)
  await asked.clock.advance(10)
  const pane = await $.ui.mount(TEAM_PANE)
  // In another session here: Open, not Join.
  expect(await pane.find({ key: 'join-room0000000000000101' })).toBeUndefined()
  expect((await pane.find({ key: 'open-room0000000000000101' }))?.props.label).toBe('Open')
  expect(await pane.find({ type: 'Text', text: /you're in it in another session/ })).toBeDefined()
  // In it on another computer: said, and not in Join all.
  expect(await pane.find({ type: 'Text', text: /you're in it elsewhere/ })).toBeDefined()
  await pane.press({ key: 'join-all' })
  // A fresh session: the first joins here, the next opens; yours never.
  await eventually(asked.clock, () => asked.spawned.some(s => s.input?.includes('claude://code/new?q=')))
  expect(asked).toContain('POST /api/rooms/room0000000000000102/join')
  const opened = asked.spawned.filter(s => s.input?.includes('claude://code/new?q=')).map(s => s.input ?? '')
  expect(opened.some(i => i.includes('room0000000000000104'))).toBe(true)
  expect(opened.some(i => /room000000000000010[13]/.test(i))).toBe(false)
  expect(asked.some(a => /room000000000000010[13]\/join/.test(a))).toBe(false)
  await pane.press({ key: 'open-room0000000000000101' })
  await asked.clock.advance(10)
  expect(asked.spawned.some(s => s.input?.includes('claude://claude.ai/epitaxy/local_0000aaaa-0000-4000-8000-000000000001'))).toBe(true)
})

test('the Team panel leaves a session you are in elsewhere by your sign-in, after asking once', async ($, on) => {
  const elsewhere = { ...teamSession(3, 'Lee'), accounts: ['acct-Lee', ME.id] }
  const asked = world(on, { team: { signedIn: true, sessions: [elsewhere, teamSession(2, 'Kim')] } })
  await $.command.run({ command: 'team' } as never)
  await asked.clock.advance(10)
  const pane = await $.ui.mount(TEAM_PANE)
  // In it elsewhere: Leave beside Join; not in it: no Leave.
  expect((await pane.find({ key: 'leave-room0000000000000103' }))?.props.label).toBe('Leave')
  expect(await pane.find({ key: 'join-room0000000000000103' })).toBeDefined()
  expect(await pane.find({ key: 'leave-room0000000000000102' })).toBeUndefined()
  await pane.press({ key: 'leave-room0000000000000103' })
  await asked.clock.advance(10)
  expect((await pane.find({ key: 'leave-room0000000000000103' }))?.props.label).toBe('Leave everywhere?')
  expect(asked).not.toContain('POST /api/rooms/room0000000000000103/leave')
  await pane.press({ key: 'leave-room0000000000000103' })
  await eventually(asked.clock, () => asked.some(a => a === 'POST /api/rooms/room0000000000000103/leave'))
  const leave = asked.sent.find(r => r.path === '/api/rooms/room0000000000000103/leave')
  // The sign-in, not a seat's token: the seats are other sessions'.
  expect(leave?.headers['x-shared-session-account']).toBe(TEAM_TOKEN)
  expect(leave?.headers.authorization).toBeUndefined()
})

test('a guest whose seat was left from the Team panel says so, and is out of the room', async ($, on) => {
  const opts: NonNullable<Parameters<typeof world>[1]> = { leftHere: true }
  const asked = world(on, opts)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  expect(await eventually(asked.clock, () => asked.state.room?.id)).toBe('room0000000000000001')
  // The room is still shared, and refuses this seat: it was left from elsewhere.
  opts.roomGone = true
  expect(await eventually(asked.clock, () => asked.logged.find(line => line.includes('from the Team panel')))).toBe(
    "You left Sam's session from the Team panel.",
  )
  expect(await eventually(asked.clock, () => (asked.state.room ?? null) === null)).toBe(true)
  // A seat refused never takes a new one.
  expect(asked.filter(a => a.endsWith('/join')).length).toBe(1)
})

test('the Team panel stops a session of yours by your sign-in, after asking once', async ($, on) => {
  const away = { ...teamSession(1, 'Scott'), hostAccount: ME.id, hostOnline: false }
  const asked = world(on, { team: { signedIn: true, sessions: [away, teamSession(2, 'Kim')] } })
  await $.command.run({ command: 'team' } as never)
  await asked.clock.advance(10)
  const pane = await $.ui.mount(TEAM_PANE)
  // Yours: Stop, never Join; someone else's: no Stop.
  expect(await pane.find({ key: 'join-room0000000000000101' })).toBeUndefined()
  expect((await pane.find({ key: 'stop-room0000000000000101' }))?.props.label).toBe('Stop')
  expect(await pane.find({ key: 'stop-room0000000000000102' })).toBeUndefined()
  await pane.press({ key: 'stop-room0000000000000101' })
  await asked.clock.advance(10)
  expect((await pane.find({ key: 'stop-room0000000000000101' }))?.props.label).toBe('Stop for everyone?')
  expect(asked).not.toContain('POST /api/rooms/room0000000000000101/end')
  await pane.press({ key: 'stop-room0000000000000101' })
  await eventually(asked.clock, () => asked.some(a => a === 'POST /api/rooms/room0000000000000101/end'))
  const end = asked.sent.find(r => r.path === '/api/rooms/room0000000000000101/end')
  // The sign-in, not a room token: the session that shared it may be gone.
  expect(end?.headers['x-shared-session-account']).toBe(TEAM_TOKEN)
  expect(end?.headers.authorization).toBeUndefined()
  // Stopped: its row goes.
  await asked.clock.advance(10)
  expect(await pane.find({ key: 'ts-room0000000000000101' })).toBeUndefined()
  expect(await pane.find({ key: 'ts-room0000000000000102' })).toBeDefined()
})

test('a link to a room another session here is in opens that one; pasted again, it joins here too', async ($, on) => {
  const asked = world(on, { store: { 'live:room0000000000000001:session-other-0002': HOLD('room0000000000000001') } })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  expect(asked.some(a => a.endsWith('/join'))).toBe(false)
  expect(asked.spawned.some(s => s.input?.includes('claude://claude.ai/epitaxy/local_0000aaaa-0000-4000-8000-000000000001'))).toBe(true)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  expect(asked).toContain('POST /api/rooms/room0000000000000001/join')
})

test("a session that shares or joins tells the others here, and stops when it's done", async ($, on) => {
  const asked = world(on)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const held = asked.store.get('live:room0000000000000001:session-test-0001') as { mode: string; host: string } | undefined
  expect(held?.mode).toBe('guest')
  expect(held?.host).toBe('Sam')
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'leave' })
  await asked.clock.advance(10)
  expect(asked.store.has('live:room0000000000000001:session-test-0001')).toBe(false)
})

test('a joined row whose pin never took pins when pinning is allowed, or the plugin loads again', async ($, on) => {
  const asked = world(on, { settings: '{}' })
  const calls = sidebar(on, { title: 'Session room0000000000000001', refuse: true })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const pins = () => calls.filter(c => c === 'set_pinned {"session_id":"local_test","pinned":true}').length
  await $.session.start(START)
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(100_000) // refused, tried again twice, given up
  expect(await (await $.ui.mount(band('desktop'))).find({ key: 'band-allow-pin' })).toBeDefined()
  // Pinning allowed in another session: this one pins within a minute.
  calls.refuse(false)
  asked.files.set('/home/scott/.claude/settings.json', JSON.stringify({ permissions: { allow: ['mcp__ccd_sidebar__set_pinned'] } }))
  const before = pins()
  await asked.clock.advance(60_100)
  expect(pins()).toBe(before + 1)
  // Pinned once: a later load leaves the row as the person keeps it.
  calls.pin(false)
  await $.session.start(START)
  await asked.clock.advance(2_100)
  expect(pins()).toBe(before + 1)
})

test('a row a version before this marked, its pin refused, pins when this version loads', async ($, on) => {
  const asked = world(on)
  const calls = sidebar(on, { title: 'Session room0000000000000001', refuse: true })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(100_000)
  calls.refuse(false)
  await $.session.start(START) // the update loads in place
  await asked.clock.advance(2_100)
  expect(calls.at(-2)).toBe('set_pinned {"session_id":"local_test","pinned":true}')
  expect((asked.store.get('pinLog') as { line: string }[]).some(e => e.line.startsWith('pinning again'))).toBe(true)
})

test('everyone has a color of their own, the same in the row, the Room and the transcript', async ($, on) => {
  const people = [
    { id: 'host', name: 'Sam', role: 'host', online: true },
    { id: 'seat1', name: 'scott', role: 'guest', online: true },
    { id: 'seat2', name: 'Alex', role: 'guest', online: true },
    { id: 'seat3', name: 'Riley', role: 'guest', online: true },
  ]
  const asked = world(on, { people })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(10)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  const named = async (ui: typeof pane, name: string) =>
    (await ui.findAll({ type: 'Text' })).find(t => t.text?.trim() === name)?.props.color as string | undefined
  const colors = await Promise.all(people.map(p => named(pane, p.name)))
  expect(new Set(colors).size).toBe(4) // four people, four colors
  const alex = colors[2]!
  expect(alex).toMatch(/^#[0-9a-f]{6}$/)
  // The row's faces wear the same colors…
  const row = await $.ui.mount(band('desktop'))
  expect((await row.findAll({ type: 'Svg' })).some(svg => String(svg.props.source).includes(alex))).toBe(true)
  // …and so does Alex's prompt in the transcript.
  const prompt = await $.ui.mount({ ...ROW('Alex: Run the tests', { kind: 'plugin', name: 'shared-session', asUser: true }), surface: 'desktop' })
  expect((await prompt.find({ type: 'Text', text: 'Alex' }))?.props.color).toBe(alex)
})

test('a dropped connection and its return stay out of the transcript; the Room keeps them', async ($, on) => {
  const riley = { seat: 'seat3', name: 'Riley', role: 'guest' }
  const ev = (seq: number, type: string, body: Record<string, unknown> = {}) => ({ seq, type, from: riley, ts: 900 + seq, body })
  const asked = world(on, {
    stream: [{ seq: 4, events: [ev(2, 'join'), ev(3, 'leave', { reason: 'timeout' }), ev(4, 'join')], people: [], ended: false, title: 'demo' }],
  })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(50)
  expect(asked.logged.filter(l => l === 'Riley joined')).toHaveLength(1)
  expect(asked.logged.some(l => /lost connection/.test(l))).toBe(false)
  const pane = await $.ui.mount({ plugin: 'shared-session', surface: 'desktop', component: 'Pane', requestId: 'shared-room', props: PANE })
  await pane.press({ key: 'tab-chat' })
  expect(await pane.find({ type: 'Text', text: ' lost connection' })).toBeDefined()
})

test('the row above the prompt stays one row: a refused pin is a button in it, not a line under it', async ($, on) => {
  const asked = world(on)
  sidebar(on, { title: 'Fix login flow', refuse: true })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(81_000)
  const tree = (await ui.drawn()) as { props: { flexDirection?: string } }
  expect(tree.props.flexDirection).toBe('row')
  expect((await ui.find({ key: 'band-allow-pin' }))?.props.label).toBe('Pin')
  expect(await ui.find({ type: 'Text', text: /^(Sharing|Joined)$/ })).toBeDefined()
})

test("while someone watches, the host's Claude thinking, writing and drafting a call goes out live", async ($, on) => {
  const people = [
    { id: 'host', name: 'scott', role: 'host', online: true },
    { id: 'seat2', name: 'Alex', role: 'guest', online: true },
  ]
  const asked = world(on, { stream: [{ seq: 1, events: [], people, ended: false, title: 'demo' }] })
  model(on)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(50)
  for await (const _ of $.turn.step(STEP)) void _
  await asked.clock.advance(300)
  const deltas = asked.posted.filter(e => e.type === 'delta').map(e => e.body)
  expect(deltas.find(d => typeof d.thinking === 'string')?.thinking).toBe('Let me think about the layout')
  expect(deltas.find(d => typeof d.text === 'string')?.text).toBe('Writing it now.')
  // The call goes as a line saying what it's for and how far along, never its arguments.
  const drafting = deltas.map(d => d.drafting as { tool: string; target: string; chars: number } | undefined).filter(Boolean)
  expect(drafting.at(-1)).toEqual({ tool: 'Write', target: 'notes.md', chars: 2545 })
  expect(JSON.stringify(deltas)).not.toContain('xxxxxxxxxx')
})

test('a host alone in the room sends nothing live', async ($, on) => {
  const asked = world(on, {
    stream: [{ seq: 1, events: [], people: [{ id: 'host', name: 'scott', role: 'host', online: true }], ended: false, title: 'demo' }],
  })
  model(on)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(50)
  for await (const _ of $.turn.step(STEP)) void _
  await asked.clock.advance(300)
  expect(asked.posted.some(e => e.type === 'delta')).toBe(false)
})

test("a guest's working line says what the host's Claude is doing this moment", async ($, on) => {
  const sam = { seat: 'host', name: 'Sam', role: 'host' }
  const people = [
    { id: 'host', name: 'Sam', role: 'host', online: true },
    { id: 'seat1', name: 'scott', role: 'guest', online: true },
  ]
  const events = [
    { seq: 2, type: 'turn', from: sam, ts: 902, body: { state: 'start', turnId: 'turn-9', by: 'Alex', prompt: 'Write the notes' } },
    { seq: 3, type: 'delta', from: sam, ts: 903, body: { turnId: 'turn-9', drafting: { tool: 'Write', target: 'notes.md', chars: 4200 } } },
  ]
  const asked = world(on, { people, stream: [{ seq: 3, events, people, ended: false, title: 'demo' }] })
  await $.prompt.submit({ text: LINK, origin: { kind: 'composer' }, wait: false })
  await asked.clock.advance(50)
  const spinner = await $.ui.mount({
    plugin: 'shared-session',
    surface: 'desktop',
    component: 'Spinner',
    props: { word: 'Working', message: null, suffix: '…', mode: 'requesting' },
  })
  expect((await spinner.find({ type: 'Text' }))?.text).toBe('Writing notes.md · 4k characters · for Alex')
  // The row above the prompt: for whom, for how long, and what, on its own clock.
  const row = await $.ui.mount(band('desktop'))
  expect(await row.find({ in: 'band-live', type: 'Text', text: ' · Writing notes.md · 4k characters' })).toBeDefined()
  expect(await row.find({ in: 'band-live', type: 'Text', text: 'Alex' })).toBeDefined()
})

test("an invite shows in a session that's in a room too: a button in its row, Join a press away", async ($, on) => {
  const asked = world(on, { team: { signedIn: true }, invites: [INVITE] })
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'share' })
  await ui.press({ key: 'share-prompt' })
  await asked.clock.advance(50)
  await $.command.run({ command: 'team', args: 'invites' } as never) // the machine's look at its invites
  await asked.clock.advance(10)
  // Still one row, the room's: the invite is a button in it, in place of two it can spare.
  expect(((await ui.drawn()) as { props: { flexDirection?: string } }).props.flexDirection).toBe('row')
  expect((await ui.find({ key: 'invite-open' }))?.props.label).toBe('Sam invites you')
  expect(await ui.find({ key: 'copy' })).toBeUndefined()
  expect(await ui.find({ key: 'room' })).toBeDefined()
  expect(await ui.find({ key: 'stop-sharing' })).toBeDefined()
  await ui.press({ key: 'invite-open' })
  expect(asked.opened).toContain('shared-team')
  const pane = await $.ui.mount(TEAM_PANE)
  expect(await pane.find({ key: 'inv-join-room0000000000000201' })).toBeDefined()
  // Dismissed there, the row has its buttons back.
  await pane.press({ key: 'inv-dismiss-room0000000000000201' })
  await asked.clock.advance(10)
  expect(await ui.find({ key: 'invite-open' })).toBeUndefined()
  expect(await ui.find({ key: 'copy' })).toBeDefined()
})
