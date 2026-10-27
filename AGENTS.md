# Working in this repo (for agents)

Shared Sessions for Claude Code: a Claude Code plugin (`plugin/`, function hooks) and a small room server (`server/`). A person shares a Claude Code session with a link; teammates join from their own Claude Code. README.md says what it does; this file is how to set it up and change it, and where the rules the code keeps are (`docs/rules/`). The code is the authority on details.

## Before you change code: read its rules

The rules that shaped the design live in `docs/rules/`, one file an area: what the code keeps that is easy to undo by accident. Don't undo one without new evidence. Before you change an area, read its file:

- Before you touch the plugin's hooks, dispatches, waits, prompts, `$` calls, fetches, viewers, auto mode or drawing: read [docs/rules/engine.md](docs/rules/engine.md).
- Before you touch what a guest's session does (rides, replayed calls, a join's history, what a guest sends, messages from a guest's other sessions, the host's mailbox): read [docs/rules/guest.md](docs/rules/guest.md).
- Before you touch what the host's session does (approvals, reads inside the project, Always allow, teammates' prompts, the live feed, refused events, versions): read [docs/rules/host.md](docs/rules/host.md).
- Before you touch checkpoints, resuming, `closeRoom`, cancellation or updates in place: read [docs/rules/rooms.md](docs/rules/rooms.md).
- Before you touch previews (what's shared and who decides, discovery, the public link, TCP forwarding, a guest's listeners, the separate window and its proxy): read [docs/rules/previews.md](docs/rules/previews.md).
- Before you touch the cloud host (`HostContainer`, the runner, approvers, Move and Bring home, its image): read [docs/rules/cloud.md](docs/rules/cloud.md).
- Before you touch `server/` (the Workers and Durable Objects, timers, bounds, seats, teams, sign-in, traces, the native pool, invites): read [docs/rules/server.md](docs/rules/server.md).

## Setting it up for someone

Use `scripts/setup.ts`; it is non-interactive and safe to re-run. Every step prints one line, `OK …`, `NOTE …` (informational), `NEEDS HUMAN …` or `FAIL …`, and it exits 0 (all OK), 2 (a person must act) or 1 (failed). On `NEEDS HUMAN`, stop and relay that line to the person verbatim, then re-run the same command once they say it's done. Relay `NOTE` lines too.

It finds a Claude Code new enough for this plugin: `CLAUDE_BIN` if set, else `claude` on PATH, else (macOS) the newest one Claude Desktop bundles. If it FAILs on the version, set `CLAUDE_BIN=/path/to/claude` to a 2.1.286+ binary.

It needs Node 22.18+, which runs it as TypeScript. An older Node stops before setup starts, with `ERR_UNKNOWN_FILE_EXTENSION` for `.ts`: install a newer Node (or `nvm install 22`) and run it again.

| The person wants | Run |
| --- | --- |
| only to join links teammates send | `node scripts/setup.ts join` |
| to share (and join), and the team already has a server | `node scripts/setup.ts host --server <https://…>` (includes `join`) |
| to share, and nobody has a server yet | `node scripts/setup.ts deploy` (Cloudflare; prints the teammates' one-line install) |
| to know whether it works | `node scripts/setup.ts check --live` |

`check --live` proves that the plugin is installed and the saved server answers; that the server can create, seat, serve and end a room; that a real throwaway session shares with the saved setting, its room outlives that session, and reopening it (`--resume`) to `/stop-sharing` ends it; and that a real throwaway session joins a room from its link. Its sessions run in the system temp folder, and their transcripts and room checkpoints are deleted afterwards; a room one of them left open, on whatever https server, is ended with its own token. They run without `CLAUDE_CODE_HOST_SESSION_ID`, so neither takes up a room the Claude Desktop session running the check saved. It reads the saved server as the plugin does: a plugin folder named in `CLAUDE_CODE_PLUGIN_DIRS` has its own option alone, and only the automatic-update folder falls back to the installed plugin's. It can't see Claude Desktop's UI (the Share button, the Room panel): ask the person to look.

Facts that matter:

- **Joining needs the plugin and nothing else**: no server, account or sign-in, since the link carries its server. The exception is a session shared with a team whose access is "Only people in the team", which needs a sign-in (`/team`) with an account in that team. Sharing uses the public server unless the plugin's `server` option (what `setup.ts` sets) or `SHARED_SESSION_SERVER` names another.
- **Steps only a person can do.** Never attempt these yourself; `setup.ts` stops at each with a `NEEDS HUMAN` line:
  - `npx wrangler login`, which is a browser OAuth approval;
  - creating the Cloudflare account's `workers.dev` subdomain, once, in the dashboard;
  - making the GitHub and Google OAuth apps for teams' sign-in on a server of one's own (README, "Teams on your own server"), and `npx wrangler secret put` of their ids and secrets: secrets a person pastes, never an agent.
- **A share server is https**, except one on this computer (`secureServer`; the plugin refuses another, `PlainServer`, and so does `setup.ts`, `validServer`): plain http would carry room tokens, sign-ins and the session unencrypted. A room saved on one isn't taken up again, host's or guest's (`plainSaved`, in `resumeHosting` and `resumeJoined`), so no room is ever active on one; `api` and the stream refuse one too.
- **A new `workers.dev` certificate takes a minute or so.** TLS handshake errors right after a first deploy are expected; `setup.ts deploy` waits for it.
- **Claude Code 2.1.286+ is required** (function-hook plugins), or 2.1.285 with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, which `setup.ts` sets in the settings Claude Code reads (`$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`). 2.1.284 and older lack `session.append`. A `claude` on PATH can be older than Claude Desktop's bundled one. Where the hooks module doesn't load (a version too old, a session started before the plugin was installed or updated, hooks switched off), `plugin/commands/share-session.md` answers `/share-session` with the fixes; where it loads, the module answers the command itself under both names Claude Code lists, so the markdown never reaches the model.
- **A session keeps the plugin copy it started with.** After installing or updating, new sessions get it; an open Claude Desktop session needs the app quit and reopened, and `/reload-plugins` re-reads the same old copy. Updates in place (docs/rules/rooms.md) are the exception.
- **The plugin's commands** are `/share-session`, `/room`, `/who`, `/team`, `/invite`, `/share-file`, `/share-preview` and `/stop-sharing`. `/share-preview <port or http://localhost:port/path> [title]` lets teammates open a local web server at the same address. They are deliberately not `/share`, which is Claude's own.
- **Sharing sends the session's whole history**: prompts, replies, tool calls and the first lines of tool results, to everyone with the link and through the server. Before sharing an existing session for someone, tell them that. The plugin asks too: Share asks first what teammates can do (**Prompt Claude** or **Only watch and chat**, `/share-session watch`; a watch-only room sends its policy before anything else), then in a session with prompts offers **Share everything** or **Only from now on**, and `/share-session` there answers with `/share-session all` and `/share-session new` instead of sharing. In a fresh session, Share shares once the first question is answered, and `/share-session` at once.

## Changing it

```bash
npm install                                             # wrangler: the suites that need a room server run the Workers under wrangler dev (test/support/workerd.ts)
npm run check                                           # type checks (server, scripts, relay, test), oxlint and the format check: what CI's server types job runs
npm run typecheck:plugin                                # the plugin against the engine's API (needs plugin/.claude/types, below)
npm run format                                          # oxfmt over server/ and scripts/ (.oxfmtrc.json); test/ and plugin/ join once the sessions moving them are done
claude plugin validate --strict plugin                  # what the engine and the plugin directory check
claude plugin test plugin                               # plugin/tests: the UI tests (band.test.tsx, desktop and terminal) and the pure modules' (window, preview, proxy, upstream)
npm run typecheck:test && npm test                      # the suites moved to Vitest (test/*.test.ts), strictly typed: setup (setup.ts against a fake CLI and a temporary home, the deploy order included), and peer, teams, cloud, security and traces (below; traces' end to end only with TRACES_DATABASE_URL)
node test/local-preview.mjs                             # TCP helpers through the real Workers under wrangler dev; real Chrome and Firefox preview windows and their WebRTC when installed
node test/browser-proxy.mjs                             # the preview window's SOCKS5 helper, its DNS-over-HTTPS against a local TLS fixture (openssl for the test CA)
node test/discover.mjs                                  # same-project service discovery, and who holds a port
node test/tcp-worker.mjs                                # the Worker's TCP lifecycle and hibernation, its public link, files and preview keys
#   test/peer.test.ts                                   # messages and receipts between a guest's own sessions and the host's
node test/mailbox.mjs                                   # the host's mailbox helper and relay/receipt.mts through real Unix sockets (macOS or Linux)
node test/previews.mjs                                  # preview shares, forwarding, Stop, needs, the public link, bounded bodies and events, a worst-case meta, the home page's claims
#   test/teams.test.ts                                  # accounts and teams, the sign-in's confirmation, Continue in a real headless Chrome when there is one
#   test/cloud.test.ts                                  # the cloud host's handoff through the core; with CLOUD_DOCKER=1 and model access, a real runner in Docker under wrangler dev
#   test/security.test.ts                               # where a room's files land on a teammate's computer (relay/save.sh) and where a guest's read really goes (relay/real.sh), through real links; names, the room page, what a seat holds open, uploads, and on the Worker team removals, what a room serves and the daily room count
TRACES_DATABASE_URL=… npm test -- test/traces.test.ts   # traces end to end against a throwaway Postgres (its tables are dropped first): OAuth, keeping turns, keyword and meaning search
CLAUDE_BIN=$(which claude) node test/e2e.ts             # a real host and guests through a local server (needs model access)
EXTERNAL_SERVER=1 SHARE_SERVER=https://… node test/e2e.ts    # …or through a deployed one (`npx wrangler dev` runs the Worker locally: SHARE_SERVER=http://127.0.0.1:8787)
```

All but the e2e run without a model. Every project is strict and checked against its own runtime's types alone: the server's against the Worker's (wrangler writes them), the rest against Node's. Node runs scripts/ and plugin/relay/*.mts as they are, types stripped, so they keep to erasable syntax (no enums, namespaces or parameter properties). The lint is type-aware: a promise nobody awaits or catches fails it (`.oxlintrc.json`). A Vitest suite that starts the Workers (`startWorkerd`) goes in `vitest.config.ts`'s `WORKERD` list, whose tests have minutes; the others have 30 s. Under Vitest, `vitest.config.ts` aliases `cloudflare:workers`, workerd's own module, to `test/support/cloudflare-workers.ts`, and a suite imports the server as it likes. The `node test/x.mjs` suites that load anything of `server/` import `test/support/cloudflare.mjs` first (it is `cloudflare.ts`, which registers a hook for the same stand-in) and the server with `import()` after it. `workerd.mjs` and `cloudflare.mjs` are names kept for those suites alone, and go with the last of them. Node strips the server's TypeScript types itself.

- `plugin/.claude/types/claude-code.d.ts` is the engine's API, at least 2.1.299's (copy it in from a Claude Code session with `/plugin-types plugin/.claude/types`; it is git-ignored). It is the authority on every hook, `$` call and element.
- The validator enforces three engine rules: `$` may only be passed to functions declared at the top of `register.tsx`; `atom(...)` references use literal plugin and key strings; a link element accepts only `https:` (or `http://localhost`) addresses.
- The UI tests run as 2.1.299 (the world's `AI_AGENT`); a copy of them with the world on 2.1.295, run by a 2.1.295 binary, must pass all but the test of the type scale. Nothing answers beneath the plugins there: answer `ui.render` with `{ type: 'engine', ref: 0 }`.
- To drive the terminal by hand or by script, run `claude` in a pty and keep reading its output the whole time: an undrained pty blocks the app on write, which looks exactly like a hung turn.

## Release

1. Bump `plugin/.claude-plugin/plugin.json` `version`. Claude Code updates by version, not by commit: a push without a bump reaches nobody.
2. Run the checks above.
3. Push to `main`, then deploy the server, in that order. On an update, deploy the preview Worker first (`npx wrangler deploy -c wrangler.preview.toml`, then `npx wrangler deploy`), since it must already route what the new main Worker's rooms make; the first time, the main Worker goes first, since the preview Worker's `ROOMS` binding names its `RoomObject`. `node scripts/setup.ts deploy` does both in the right order, and on an update stops with FAIL before the main Worker if the preview Worker's deploy fails. The server reports the version it was deployed with as the newest, and plugins that update in place then download `main`, so `main` must already have it; the others show "Version X is out". Without updates in place: `claude plugin marketplace update claude-share && claude plugin update shared-session@claude-share`.
4. When an older version must stop being used, raise `PLUGIN_MIN` in `server/core/http.ts` and deploy after the push: the server then turns that version away from sharing and joining, with the update command. A plugin that sends no `x-shared-session-version` counts as too old.
5. Rolling the main Worker back to 0.11.24 or older loses the files of rooms made since 0.11.30: those Workers read file records from `meta`, which no longer lists them. Rooms last 24 hours.

## Running the public server

The plugin shares through `SERVER_URL` (`plugin/hooks/server.ts`) unless its `server` option or `SHARED_SESSION_SERVER` says otherwise.

- **Costs** are bounded by `LIMITS` in `server/core/limits.ts` (on Cloudflare by the `[[ratelimits]]` bindings in `wrangler.toml`, which must say the same), the room ceilings in docs/rules/server.md, the previews' `TCP_LIMITS` and `PUBLIC_LIMITS`, `SERVE_LIMITS` and the 24 h expiry. `SERVE_LIMITS` bounds what a room sends out of its files and its previews' links, which no rate limit covers (a GET has none): 8 GiB a room a day (UTC), reserved 64 MiB at a time with the TCP counters (`tcpStats.served`, `serveReserve`) and kept as the request that reserved it is answered (a file's before its bytes go, a preview answer's just after it's handed over), so a restart can't reset the day and misses one reservation at most, and 256 MiB a seat a minute; past either, 429, and the host isn't asked (`serveLeft`). New rooms are counted by the Worker's `GateObject` per address a day, kept in its storage (`a:<date>:<keyed hash>`, the key a random one of that day's, `k:<date>`) so a gate loaded again counts on, one Share at a time, and deleted by its alarm at the day's end. Cloudflare has no hard spending cap; a person sets a budget alert in the dashboard (Billing → Budget alerts).
- **Stop new rooms at once:** `npx wrangler deploy --var NEW_ROOMS:off` (joining existing links keeps working); deploy again without it to reopen.
- **End an abused room:** `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" <server>/api/admin/rooms/<id>/end`, the token set by `npx wrangler secret put ADMIN_TOKEN`.
- **What it may say it keeps** is in three places that must agree: the home page (`homePage` in `server/core/pages.ts`), the full list in `docs/guide.md`'s "Privacy and the public server" (every limit, count and expiry), and the README's section of the same name, a short summary of what a person needs before sharing, which links to the guide. Change all three with any change to what's stored or for how long; a new limit or expiry goes in the guide alone. `node test/previews.mjs` checks the home page's sentences against the constants they name.
- **Sidebar marks never stack**: `markSidebar` strips earlier marks (`unmarked`) before marking, since a share that never unmarked leaves one behind.
- **Never commit `rooms.json` or `rooms.json.tcp`**, which the removed Node server wrote and older clones may still hold: room tokens, accounts and room ids. `.gitignore` lists both.
