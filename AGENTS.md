# Working in this repo (for agents)

Shared Sessions for Claude Code: a Claude Code plugin (`plugin/`, function hooks) and a small room server (`server/`). A person shares a Claude Code session with a link; teammates join from their own Claude Code. See README.md for what it does; this file is how to set it up and change it.

## Setting it up for someone

Use `scripts/setup.mjs`; it is non-interactive and safe to re-run. Every step prints one line, `OK …`, `NOTE …` (informational), `NEEDS HUMAN …` or `FAIL …`, and it exits 0 (all OK), 2 (a person must act) or 1 (failed). On `NEEDS HUMAN`, stop and relay that line to the person verbatim, then re-run the same command once they say it's done. Relay `NOTE` lines too.

It finds a Claude Code new enough for this plugin: `CLAUDE_BIN` if set, else `claude` on PATH, else (macOS) the newest one Claude Desktop bundles. If it FAILs on the version, set `CLAUDE_BIN=/path/to/claude` to a 2.1.286+ binary.

| The person wants | Run |
| --- | --- |
| only to join links teammates send | `node scripts/setup.mjs join` |
| to share (and join), and the team already has a server | `node scripts/setup.mjs host --server <https://…>` (includes `join`) |
| to share, and nobody has a server yet | `node scripts/setup.mjs deploy` (Cloudflare; prints the teammates' one-line install) |
| to know whether it works | `node scripts/setup.mjs check --live` |

What `check --live` proves:
- the plugin is installed and the saved server answers;
- the server can create, seat, serve and end a room;
- a real throwaway session shares using the saved setting, and its room ends when it exits;
- a real throwaway session joins a room from its link.

Its throwaway sessions run in the system temp folder, and their transcripts are deleted afterwards. It can't see Claude Desktop's UI (the Share button, the Room panel): ask the person to look.

Facts that matter:

- **Joining needs the plugin and nothing else: no server, no account, no sign-in.** The link carries its server. Only sharing needs a server address, set in the plugin's `server` option (what `setup.mjs` sets), or in `SHARED_SESSION_SERVER`.
- **Steps only a person can do.** Never attempt these yourself; `setup.mjs` stops at each with a `NEEDS HUMAN` line.
  - `npx wrangler login`, which is a browser OAuth approval.
  - Creating the Cloudflare account's `workers.dev` subdomain, once, in the dashboard.
- **A new `workers.dev` certificate takes a minute or so.** TLS handshake errors right after a first deploy are expected; `setup.mjs deploy` waits for it.
- **Claude Code 2.1.286+ is required** (function-hook plugins). A `claude` on PATH can be older than Claude Desktop's bundled one; `setup.mjs` finds a new-enough binary (or set `CLAUDE_BIN`). An older CLI reports `hooks: Invalid input` on this plugin: that is the version, not the plugin.
- **A session keeps the plugin copy it started with.** After installing or updating, *new* sessions get it; an open Claude Desktop session needs the app quit and reopened. `/reload-plugins` re-reads the same old copy, so it does not pick up a new version.
- **The plugin's commands** are `/share-session`, `/room` and `/stop-sharing`. They are deliberately not `/share`, which is Claude's own.
- **Sharing sends the session's whole history.** That's prompts, replies, tool calls and the first lines of tool results, sent to everyone with the link and through the server. Before sharing an existing session for someone, tell them that. A fresh session shares only what happens in it.

## Changing it

```bash
cd plugin && npx -y -p typescript@5 tsc -p .          # type-check against the engine's API (needs plugin/.claude/types, below)
claude plugin validate --strict plugin                  # what the engine and the plugin directory check
claude plugin test plugin                               # UI tests (desktop + terminal surfaces)
CLAUDE_BIN=$(which claude) node test/e2e.mjs            # real host + guests through a local server (needs model access)
EXTERNAL_SERVER=1 SHARE_SERVER=https://… node test/e2e.mjs   # …or through a deployed one
```

- `plugin/.claude/types/claude-code.d.ts` is the engine's API (copy it in from a Claude Code session with `/plugin-types plugin/.claude/types`; it is git-ignored). It is the authority on every hook, `$` call and element.
- **Engine rules the validator enforces:**
  - `$` may only be passed to functions declared at the top of `register.tsx`;
  - `atom(...)` references use literal plugin and key strings;
  - a link element accepts only `https:` (or `http://localhost`) addresses.
- **Behavior that shaped the design.** Don't undo these without new evidence:
  - **No long-polling from the plugin; updates come through a `curl` child.** While a plugin has a request in flight, the engine holds every prompt after the first until it returns. A child process's open stream holds nothing. So each shared session runs one `curl` (via `$.process.spawn`) reading `stream?after=<seq>`, one JSON line per room change. Riding turns read what it brings, too. Its address and token go to curl on stdin, never in argv. Without curl, or when the server has no stream, it polls: requests that return at once, every 0.4 s when busy, down to every 15 s when quiet.
  - **No prompts from inside another hook's dispatch.** A prompt submitted there is refused, so the plugin's prompts go out from a timer (`submitLater`).
  - **No running its own commands for output.** A plugin's own `$.command.run` skips that plugin's command hooks, so guest transcripts are drawn by riding turns (`turn.step` answered from the room, no model call) instead.
  - **Strip the app's context.** Claude Desktop puts a `<system-reminder>` into a first prompt. `typedText()` strips it before matching links or forwarding prompts.
  - **Plain images, not interactive art.** Interactive (sandboxed-frame) art paints an opaque box on dark themes, so the drawings are plain images styled with `prefers-color-scheme`.
- **Release:**
  1. Bump `plugin/.claude-plugin/plugin.json` `version`.
  2. Run the checks above.
  3. Push to `main`. Installs update with `claude plugin marketplace update claude-share && claude plugin update shared-session@claude-share`.
- **Server:** `server/core.mjs` is shared by `node.mjs` (Node 20+) and `worker.mjs` (Cloudflare Worker + Durable Object, deploy with `npx wrangler deploy`). Keep `wrangler.toml`'s `compatibility_date` no newer than the wrangler you deploy with supports.
  - **Nothing runs on a timer while a room is quiet.** Who is still here is settled by the next request, or by an alarm a disconnect sets for when its 45 s grace ends. The only other timer is the room's expiry.
  - **On Cloudflare, streams end at the Worker, not the Durable Object.** A Durable Object holding an open HTTP response is billed for every second. So the Worker holds the client's stream and talks to the room over a WebSocket the object accepts with the hibernation API; the object sleeps between changes. A closing socket is still listed by `getWebSockets()` while its close is handled; `worker.mjs` tracks closed ones itself.
  - **Every stream ends itself after 5 minutes** (`STREAM_MAX_MS`), and the plugin reconnects at once. Presence doesn't depend on noticing a dead connection (a sleeping laptop's can look alive for many minutes): a client that's gone just never reconnects. A stream that ends within a minute backs off instead, so a proxy that cuts streams short isn't hammered.
  - **A room loaded from storage starts its seq numbers past any it may have handed out** (`Room.resume`), because live events (deltas) are never stored.
  - `npx wrangler dev` runs the Worker locally (real Durable Objects and WebSockets); point the e2e at it with `EXTERNAL_SERVER=1 SHARE_SERVER=http://127.0.0.1:8787`.
- **Never commit `rooms.json`.** It holds room tokens; it is git-ignored.
