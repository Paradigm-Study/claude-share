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
- a real throwaway session shares using the saved setting, its room stays open when that session closes, and reopening it (`--resume`) to `/stop-sharing` ends it;
- a real throwaway session joins a room from its link.

Its throwaway sessions run in the system temp folder, and their transcripts are deleted afterwards. It can't see Claude Desktop's UI (the Share button, the Room panel): ask the person to look.

Facts that matter:

- **Joining needs the plugin and nothing else: no server, no account, no sign-in.** The link carries its server. Sharing uses the public server unless the plugin's `server` option (what `setup.mjs` sets) or `SHARED_SESSION_SERVER` names another.
- **Steps only a person can do.** Never attempt these yourself; `setup.mjs` stops at each with a `NEEDS HUMAN` line.
  - `npx wrangler login`, which is a browser OAuth approval.
  - Creating the Cloudflare account's `workers.dev` subdomain, once, in the dashboard.
- **A new `workers.dev` certificate takes a minute or so.** TLS handshake errors right after a first deploy are expected; `setup.mjs deploy` waits for it.
- **Claude Code 2.1.286+ is required** (function-hook plugins), or 2.1.285 with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` (early access there; `setup.mjs` sets it in `~/.claude/settings.json`). 2.1.284 and older can't run it: they lack `session.append`. A `claude` on PATH can be older than Claude Desktop's bundled one; `setup.mjs` finds a new-enough binary (or set `CLAUDE_BIN`). Where the hooks module doesn't load (a version too old, a session started before the plugin was installed or updated, hooks switched off), `plugin/commands/share-session.md` answers `/share-session` instead with the fixes. Where it does load, the module answers the command itself under both names Claude Code lists, `/share-session` and `/shared-session:share-session`, so the markdown never reaches the model.
- **A session keeps the plugin copy it started with.** After installing or updating, *new* sessions get it; an open Claude Desktop session needs the app quit and reopened. `/reload-plugins` re-reads the same old copy, so it does not pick up a new version.
- **The plugin's commands** are `/share-session`, `/room` and `/stop-sharing`. They are deliberately not `/share`, which is Claude's own.
- **Sharing sends the session's whole history.** That's prompts, replies, tool calls and the first lines of tool results, sent to everyone with the link and through the server. Before sharing an existing session for someone, tell them that. The plugin asks too: Share in a session with prompts offers **Share everything** or **Only from now on**, and `/share-session` there answers with `/share-session all` and `/share-session new` instead of sharing. A fresh session shares at once.

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
  - **Showing things in a guest's Claude Code happens in a turn.** A plugin's own call to a viewer, outside any turn, shows nothing: `SendUserFile` reports "delivered" but nothing opens, and auto mode refuses widgets and the browser pane. The same call made as a step of a turn (`turn.step` yielding a `tool` chunk) opens in Desktop's own viewers. So riding turns replay what the host's Claude showed as tool steps. The Files pane (`ccd_view.show_pane`) is the exception; it opens from a plugin's own call, which the Room panel's Open uses.
  - **A guest session never calls its own model.** Every turn there is a ride the plugin answers from the room. Rides are matched by the turn's text, then by its beginning, then oldest first, because the text a turn starts with can differ from what the plugin submitted. A turn that still matches nothing gets a short local note from `turn.step` without `next`, never a model call. Every later step of a guest's turn is answered too: a Stop hook in the guest's own settings can make the engine continue a turn the ride already ended.
  - **A riding step gets 10 s of its own time.** Each `turn.step` dispatch's budget counts the hook's own time, plain timers and `$.clock.sleep` included, and past it the engine runs the model in the hook's place: in a guest, that is the guest's own Claude answering the host's prompt on the guest's machine. A host's Claude can be silent far longer (a slow tool, a long think over a big context), so a ride waits through `pause()`, a `sleep` child, because the clock stops while a `$` call is in flight. The hook's `.catch` is the backstop: a guest step that throws or overruns ends quietly, and the host turn it was showing plays again after it.
  - **Host tool calls replay as cards of the plugin's own tool, never the real one.** A guest's ride yields each host tool call as `mcp__shared-session__replay` (registered on join), whose `tool.call` hook waits for the host's result row (paired by tool_use id) and returns it; its `.catch` answers too, so nothing beneath ever runs. The `ToolUse` render hook draws it as the call it replays (`tool` rewritten to `Bash`, `Read`…). Answering a built-in tool's call instead would be checked against that tool's output schema, and a result that fails the check lets the real tool run on the guest's machine. Viewer calls (files, widgets, pages) are still made again for real (`replayOf`), so their rows stay out of the card replay.
  - **A join's history is a turn per earlier prompt, two steps each.** Only a turn shows a prompt as the person's own message (`$.session.append` takes notes alone), so each exchange is a ride: one step with its text and every call as a replay card whose result is preset from the room (`historyBlocks`, `hostCalls`), the next with its last words (`staticRuns`). Never a step per call: 25 prompts and 300 calls land in about 3 s.
  - **A host's room outlives its process.** `$.state` lasts only through a hot reload, so a host session that ends (anything but `/clear` or a logout) saves its room in `$.store` under its session id (`keepHosting`), and `session.start` of the same id (a resume keeps it) takes it up again (`resumeHosting`), declining guest prompts sent meanwhile. The server never ends a room for its host going away; guests see the host offline after the 45 s grace, and a guest's prompt then gets a local note instead of going out. The room records the host's plugin version from its requests (`hostVersion`), so a guest's join note says when the host is too old for cards.
  - **The host shares a localhost address its Claude gives out** (`shareLocal`), like one opened in the browser pane: when "What Claude shows" goes to everyone and the port answers. Share with history, and a host session reopening its room, do the same for the pages the history opened (`navigate`, `preview_start`, `browser_batch`) or printed, each port at its last page (`localOpens`), and a live `browser_batch` open is shared like a `navigate`. Preview tickets carry the page's path, and the entry redirects there.
  - **The plugin's own turns go out one at a time.** Prompts submitted together reach the engine as one turn, so each ride waits for the last to finish (`laterRides`, `rideSubmitted`). A step that ends a turn says something, even after a call: an empty reply makes the engine ask for another step.
  - **Auto mode refuses a plugin's step to the browser pane** ("no verdict"). When it does, the ride's next step offers a preview link (10 minutes, one browser) and the Room's Open.
  - **The browser pane runs a local page live only inside the project folder**; outside, it shows a static snapshot. That's why guests save files under `.shared-session/` in their project.
  - **Desktop-only things stay in Desktop.** Drawings (`Svg`) only on the `desktop` surface: a terminal's table can carry an Svg it paints as nothing, so the letters-and-dots fallbacks draw there. Claude Desktop's own MCP servers (`ccd_*`, `Claude_Browser`) are called only when `CLAUDE_CODE_ENTRYPOINT` is `claude-desktop`. The terminal paints a collapse mark (`[-]`) over the right end of the row above the prompt, so the row keeps 4 columns clear there.
  - **Testing the terminal by hand or by script:** drive `claude` in a pty and keep reading its output the whole time. An undrained pty blocks the app on write, which looks exactly like a hung turn (no log lines, a late stream watchdog).
  - **Plain images, not interactive art.** Interactive (sandboxed-frame) art paints an opaque box on dark themes, so the drawings are plain images styled with `prefers-color-scheme`.
- **Release:**
  1. Bump `plugin/.claude-plugin/plugin.json` `version`. Claude Code updates by version, not by commit: a push without a bump reaches nobody.
  2. Run the checks above.
  3. Push to `main`, then deploy the server (both Workers). The server reports the version it was deployed with as the newest, and the plugin shows "Version X is out" against it. Installs with the marketplace's `autoUpdate` on (Room → Settings → Updates, or what `setup.mjs` sets) update within minutes of a session starting; others with `claude plugin marketplace update claude-share && claude plugin update shared-session@claude-share`.
  4. When an older version must stop being used (it misbehaves), raise `PLUGIN_MIN` in `server/core.mjs` and deploy *after* the push: the server then turns that version away from sharing and joining, with the update command in the message. Every plugin sends its version as `x-shared-session-version`; one that sends none is older than this scheme and counts as too old.
- **Server:** `server/core.mjs` is shared by `node.mjs` (Node 20+) and `worker.mjs` (Cloudflare Worker + Durable Object, deploy with `npx wrangler deploy`). Keep `wrangler.toml`'s `compatibility_date` no newer than the wrangler you deploy with supports.
  - **Nothing runs on a timer while a room is quiet.** Who is still here is settled by the next request, or by an alarm a disconnect sets for when its 45 s grace ends. The only other timer is the room's expiry.
  - **On Cloudflare, streams end at the Worker, not the Durable Object.** A Durable Object holding an open HTTP response is billed for every second. So the Worker holds the client's stream and talks to the room over a WebSocket the object accepts with the hibernation API; the object sleeps between changes. A closing socket is still listed by `getWebSockets()` while its close is handled; `worker.mjs` tracks closed ones itself.
  - **Every stream ends itself after 5 minutes** (`STREAM_MAX_MS`), and the plugin reconnects at once. Presence doesn't depend on noticing a dead connection (a sleeping laptop's can look alive for many minutes): a client that's gone just never reconnects. A stream that ends within a minute backs off instead, so a proxy that cuts streams short isn't hammered.
  - **A room loaded from storage starts its seq numbers past any it may have handed out** (`Room.resume`), because live events (deltas) are never stored.
  - **Previews run on a second Worker from the same script** (`wrangler.preview.toml`, `ROLE = "preview"`), its own workers.dev host name, so an app's root-relative paths work. A ticket becomes a cookie there; it lets in one browser, which may use it again (a reload, a reopened pane), and no other. Requests go room → host's stream → the host's plugin (`sh` + `curl` against localhost, only ports it shared) → `POST proxy/<id>` back.
  - `npx wrangler dev` runs the Worker locally (real Durable Objects and WebSockets); point the e2e at it with `EXTERNAL_SERVER=1 SHARE_SERVER=http://127.0.0.1:8787`.
- **The public server.** The plugin shares through `SERVER_URL` (`plugin/hooks/server.ts`) unless its `server` option or `SHARED_SESSION_SERVER` says otherwise. Running it:
  - **Costs** are bounded by `LIMITS` in `server/core.mjs` (enforced on Cloudflare by the `[[ratelimits]]` bindings in `wrangler.toml`, which must say the same), `ROOM_SEATS_MAX`, `ROOM_FILES_MAX` and the 24 h expiry. Cloudflare has no hard spending cap; a person sets a budget alert in the dashboard (Billing → Budget alerts).
  - **Stop new rooms at once:** `npx wrangler deploy --var NEW_ROOMS:off` (joining existing links keeps working); deploy again without it to reopen.
  - **End an abused room:** `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" <server>/api/admin/rooms/<id>/end`, with the token set by `npx wrangler secret put ADMIN_TOKEN` (Node: the `ADMIN_TOKEN` environment variable).
  - **What it may say it keeps** is on its home page (`homePage` in `server/core.mjs`) and in the README's "Privacy and the public server": change both with any change to what's stored or for how long.
- **Never commit `rooms.json`.** It holds room tokens; it is git-ignored.
