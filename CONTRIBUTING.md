# Contributing

Bug reports, reproducible examples, documentation fixes, and focused pull requests are welcome. For a larger change, open an issue first. Describe the workflow and the behavior you propose, so we can agree on the approach before you write it.

## Before you send a pull request

You need Node.js 22.18 or later on macOS or Linux. You do not need a Claude account, model access, or Cloudflare credentials.

```sh
npm install                  # once
npm run check                # type checks, lint, format
npm test                     # the Vitest suites in test/
node test/local-preview.ts   # the preview suite, a node script, not on Vitest
```

These are the same checks CI runs. If you changed the plugin (`plugin/`), also run [the plugin's checks](#work-on-the-plugin). If you changed sharing, joining, or transcripts, also run [the end-to-end test](#the-end-to-end-test).

| You changed | Run |
| --- | --- |
| anything | `npm run check`, `npm test` |
| previews, forwarding, the preview window | `node test/local-preview.ts` |
| `plugin/` | the plugin's checks below |
| sharing, joining, transcripts | the end-to-end test below |

To run one suite: `npx vitest run test/<name>.test.ts`.

## What the suites cover

Each suite starts and stops its own servers on free ports. The room server is the real pair of Workers under `wrangler dev` (`test/support/workerd.ts`). Nothing touches your Claude settings.

| Suite | Covers |
| --- | --- |
| `setup` | the installer, with a fake CLI, a temporary home and intercepted network requests |
| `teams` | accounts, teams, sign-in and its confirmation page |
| `tcp-worker` | the room's Durable Object, hibernation, files and preview keys |
| `previews` | preview shares, who may connect, Stop, needs, the public link |
| `peer` | messages and receipts between a guest's own sessions and the host's |
| `mailbox` | the host's mailbox helper, through real Unix sockets |
| `browser-proxy` | the preview window's SOCKS5 proxy and its DNS-over-HTTPS |
| `discover` | which of the project's web services are offered, and who holds a port |
| `security` | what the security review asked for: file paths, real read paths, quotas, team removals |
| `cloud` | the cloud host's handoff, with a stand-in container |
| `traces` | session traces; the database part runs only when a database is set up |
| `local-preview` | real TCP forwarding, the WebSocket relay, real headless browser windows, WebRTC |

The suites do not test Claude's UI or a deployed Worker. `wrangler dev` runs the same code in workerd, but it simulates rate limits and has no container image.

### Optional tools, and what is skipped without them

A missing tool skips its check and prints `SKIP` with the reason. It does not fail the suite.

- **A Chromium browser** (Chrome, Edge, Brave or Chromium). `teams` uses it to press the sign-in page's Continue. `local-preview` uses it for the preview window and WebRTC. Set `SHARED_SESSION_TEST_CHROME` to choose one. If that variable names a file that is not executable, the suite fails.
- **Firefox.** `local-preview` checks the preview window and WebRTC in it too. Set `SHARED_SESSION_TEST_FIREFOX` to choose one.
- **`openssl`.** `browser-proxy` and `local-preview` use it to make throwaway certificates.
- **A non-loopback IPv4 address.** The WebRTC checks listen on it for a few seconds. On macOS they are skipped when the firewall is on, because a listener would make it ask you.
- **`lsof` and `ps`** (macOS). `discover` and `local-preview` use them.

The browser checks are also skipped when you run as root, or when the only browser is a snap package.

`local-preview` takes about a minute on a laptop with both browsers, and 3 to 5 minutes on a CI runner.

## Work on the plugin

You need Claude Code 2.1.299 or later; see the [README](README.md). Start a development session from the repository root:

```sh
claude --plugin-dir ./plugin
```

In that session, run `/plugin-types plugin/.claude/types` once. It writes the engine's API types, which git ignores. The code is type-checked against 2.1.304. Types from an engine older than 2.1.299 lack the type scale, and `tsc` fails.

Then run:

```sh
npm run typecheck:plugin
claude plugin validate --strict plugin
claude plugin test plugin
```

`claude plugin test` runs every file in `plugin/tests/`. The `*.test.tsx` files hold the UI tests for the desktop and terminal surfaces, one file for each area: `share`, `previews`, `sessions`, `approvals`, `teams`, `preview-window`, `leaving`, `forwarding`, `preview-open`, `room-pane` and `cloud`. They share the stand-in world in `tests/support/world.tsx`. A helper that only one file uses stays in that file. The `*.test.ts` files test the pure modules beside `register.tsx`.

`claude plugin test plugin` takes about 60 seconds. It runs every file at the same time, each in its own child process. Four tests wait 10 to 12 seconds each in real time, because a hook's 10-second budget cannot run on the tests' mocked clock. A test that steps the mocked clock many times is slow in real time while the other files run, so it takes `{ timeoutMs: 20_000 }`.

CI does not run these checks, because they need Claude Code. Run them yourself.

## The end-to-end test

This test needs a signed-in Claude Code that can call a model. It starts a real host and real guests, and the host runs in bypass mode.

```sh
CLAUDE_BIN="$(command -v claude)" node test/e2e.ts
```

[AGENTS.md](AGENTS.md) lists more options, such as running against a deployed server. The rules each part of the code keeps are in [docs/rules/](docs/rules/).

## The pull request

Say three things:

1. The problem a user sees.
2. What you changed.
3. How you checked it, and which checks you could not run and why.

Add a small reproduction or screenshots when they help. For a change in behavior, add a test that fails without it.

Keep room links, tokens, private transcripts, and generated session data out of issues and commits. Never commit `rooms.json`.

Do not bump the plugin's version or deploy the server. Those are release steps; [AGENTS.md](AGENTS.md) describes them.
