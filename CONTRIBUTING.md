# Contributing

Bug reports, reproducible examples, documentation fixes, and focused pull requests are welcome. For a larger change, open an issue describing the workflow and proposed behavior so the approach can be discussed first.

## Run the local checks

Use Node.js 22.18 or later on macOS or Linux, and run `npm install` once: the suites that need a room server run the real Workers under `wrangler dev`. They need no Claude account, model access, or Cloudflare credentials.

```sh
npm install
npm test
node test/tcp-worker.mjs
node test/local-preview.mjs
node test/browser-proxy.mjs
node test/discover.mjs
node test/previews.mjs
node test/mailbox.mjs
```

The setup suite uses a fake CLI, intercepted network requests, and a temporary home directory without changing your Claude settings. The other suites start and stop their own local servers, the room server as the two Workers under `wrangler dev` on free ports (`test/support/workerd.mjs`). When Chrome, Edge, Brave or Chromium is installed (or `SHARED_SESSION_TEST_CHROME` names one), it also opens one headless with a throwaway profile, reaching no host but its own server, to press the sign-in page's Continue as a person would and as a click timed for a double-click would; without one (or as root, with only a snap browser, or when it doesn't start), that check is skipped, and a `SHARED_SESSION_TEST_CHROME` that isn't an executable fails. The TCP suites choose temporary ports. The local-preview suite also uses the system `ps` command, and when Chrome, Edge, Brave or Chromium is installed (or `SHARED_SESSION_TEST_CHROME` names one) it opens one headless with a throwaway profile to check the preview window end to end, and Firefox the same way (or `SHARED_SESSION_TEST_FIREFOX`), running the plugin's own window probe against each and the browser detection against made-up browsers; a browser that isn't there has its check skipped. It then checks WebRTC in each browser it found, holding short-lived UDP and TCP listeners on this machine's first non-loopback IPv4 address while it runs; that check is skipped without such an address or, on macOS, with the firewall on (a listener there would ask you). Its checks of an `https://` dev server use `openssl` to make a throwaway certificate, and are skipped without it. Measured on 2026-10-19, the WebRTC check took about 9 to 10 seconds per browser (Firefox 158 and 153.5 ESR on Linux, Chrome 155 on macOS), and the whole local-preview suite 44 to 48 seconds; on a runner with both browsers, expect about a minute, well inside the CI job's 5-minute limit. The discovery suite starts small servers in a temporary git project and lists this machine's listening ports read-only, and asks who holds a few of them (one named as the plugin's guest listener, on both loopbacks); on macOS it uses `lsof` and `ps`. GitHub Actions runs each suite separately on Node 22.18 and 24.

These checks cover installer failures, server selection and the order a deploy updates the two Workers in, accounts, room access and the sign-in's confirmation page in a real browser, Worker protocol, hibernation behavior, file storage and preview links with stubs, real local TCP forwarding through the production helpers and their control ports, the public link's WebSocket relay (an `https://` dev server included), the preview window's SOCKS5 proxy and real headless Chromium and Firefox windows through it, WebRTC in those windows, same-project discovery, and the server's preview shares, who may connect to a forwarded one, Stop, needs, the public link's links, browser sessions, sockets and answers, the shared preview host name's protections, bounded requests and events, persistence, messages and receipts between a guest's own sessions and the host's session (only the other side's streams, never stored, under `wrangler dev` and with the Worker's stubs), the host's mailbox helper and its receipts through real Unix sockets (frames byte for byte, started detached, gone with its Claude Code), per-room preview host names, and the home page's statements of what the server keeps. The security suite checks what the security review asked for: where a room's files land on a teammate's computer and where a guest's reads really go, through real links in a real shell; the names a room keeps and the room page's escaping; how many streams and long polls a seat holds, and uploads against a room's quota; and with the Worker's stubs, a members-only team's removals reaching its rooms, what a room may send out a day, and the daily count of rooms per address across the gate being loaded again. They do not validate Claude's UI or a deployed Cloudflare Worker: `wrangler dev` runs the same code in workerd, with rate limits simulated and no container image.

## Work on the plugin

Use a compatible Claude Code installation; see the [README](README.md) for requirements. Start a development session from the repository root:

```sh
claude --plugin-dir ./plugin
```

In that session, run `/plugin-types plugin/.claude/types` to generate the engine's API types, from Claude Code 2.1.299 or newer (the code is type-checked against 2.1.304; older engines' types lack the type scale, and `tsc` fails). Those files are ignored by git. Then run these; `claude plugin test` runs every file in `plugin/tests/`: the UI tests for the desktop and terminal surfaces (`band.test.tsx`) and the tests of the pure modules beside `register.tsx` (`window.test.ts`, `preview.test.ts`, `proxy.test.ts`, `upstream.test.ts`):

```sh
(cd plugin && npx -y -p typescript@5 tsc -p .)
claude plugin validate --strict plugin
claude plugin test plugin
```

Four tests in `band.test.tsx` wait in real time, 10 to 12 seconds each (about 46 seconds together), so `claude plugin test plugin` takes about 140 seconds: a hook's 10-second budget runs in real time, which the tests' mocked clock can't stand in for.

For changes to sharing, joining, or transcript behavior, also run the real host-and-guests test with a signed-in Claude Code that can call a model:

```sh
CLAUDE_BIN="$(command -v claude)" node test/e2e.mjs
```

This test uses model access and starts a host in bypass mode. See [AGENTS.md](AGENTS.md) for the interaction contracts, server setup, and additional test options.

## Send a pull request

Explain the user-visible problem, what changes, and how you checked the result. Include a small reproduction or screenshots when they help; for behavior changes, cover the relevant regression. Say which checks you could not run and why.

Keep room links, tokens, private transcripts, and generated session data out of issues and commits. In particular, never commit `rooms.json`. Plugin version bumps and server deployment are release steps described in [AGENTS.md](AGENTS.md).
