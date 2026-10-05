# Shared Sessions for Claude Code

Share a Claude Code session with a link. Teammates open it, land in a Claude Code session of their own that is attached to yours, and talk to it. Everyone sees every prompt and every reply, live, as normal transcript rows.

- **One machine does the work.** The session that shared is the host. Every turn and every tool runs there, in its folder, under its login.
- **Everyone else is a guest.** A guest's prompt goes to the host and runs in turn. Every host turn plays out in each guest's own transcript as a prompt and a streamed reply. A guest's own model is never called.
- **The host stays in charge.** When a guest's prompt makes Claude write a file, run a command or reach the network, the host is asked first, whatever the host's permission mode. The question shows the exact command or diff. The host can also make the session watch-only.
- **It lives in Claude's own UI.** In Claude Desktop and the terminal:
  - a teammate's prompts carry their dot avatar and name;
  - the footer and working line say who's here and whose turn it is;
  - a Room panel has people, activity, host controls and a side chat Claude never reads;
  - in Desktop, the session list marks and pins shared sessions.
- **What Claude shows, everyone sees.** When the host's Claude opens a file in the side panel or the Files pane, draws a widget, or opens a page or a local dev server in the browser pane, each guest's own Claude Code opens the same thing. A dev server it only gives the address of (`http://localhost:3000/…`) is shared too, at that page, once something answers there. Files are saved in the guest's project under `.shared-session/` (kept out of git), and a dev server is reached through the room server.

Built as a Claude Code plugin of function hooks (a "mod"), plus a small room server that runs on Cloudflare or as a single Node process. **It works right after install:** sharing goes through a public server this project runs ([what it sees and keeps](#privacy-and-the-public-server)), and teams can point it at their own.

## Install

One line in a terminal:

```bash
claude plugin marketplace add Paradigm-Study/claude-share && claude plugin install shared-session@claude-share
```

Works in Claude Desktop and in the terminal. Requires Claude Code 2.1.286 or later: `claude update` (or `npm install -g @anthropic-ai/claude-code@latest` for an npm install); Claude Desktop includes it. On 2.1.285 (the "stable" channel today) it works with `"env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }` in `~/.claude/settings.json`, which the setup script sets for you. An older Claude Code answers `/share-session` with how to update. The installer mentions one optional setting (the share server); leave it, and sharing uses the public server. New sessions pick it up; quit and reopen Claude Desktop for sessions already open. (Claude Code installs third-party plugins from a marketplace it knows, hence the two steps in one line.)

**Updates.** Claude Code updates a marketplace's plugins by itself only when that marketplace has auto-update on, and for one like this it starts off. Turn it on once: **Room → Settings → Updates → Install by themselves**, or `/plugin` → Marketplaces → claude-share → Enable auto-update (the setup script does it for you). After that, a new version arrives within minutes of starting a session and new sessions run it. A share server also turns away versions too old to work right, and says the one command that updates them:

```bash
claude plugin marketplace update claude-share && claude plugin update shared-session@claude-share
```

**Or let the setup script do it.** It works for a person or an agent; see [AGENTS.md](AGENTS.md). From a clone of this repo:

```bash
node scripts/setup.mjs join
```

It also handles three more cases:
- `host --server <url>` installs too, then shares through your team's server.
- `deploy` makes a server on Cloudflare.
- `check --live` has real throwaway sessions share and join, then removes them.

It stops with a `NEEDS HUMAN` line at the one or two steps that need a person. Set `CLAUDE_BIN=/path/to/claude` to use a particular Claude Code binary.

**For a whole team, nothing to type:** in your organization's managed settings (or a project's checked-in `.claude/settings.json`), add:

```json
{
  "extraKnownMarketplaces": { "claude-share": { "source": { "source": "github", "repo": "Paradigm-Study/claude-share" }, "autoUpdate": true } },
  "enabledPlugins": { "shared-session@claude-share": true }
}
```

## Use it

- **Join:** open a share link. Its page opens Claude Desktop with the link in a new session's prompt box, so you press Enter. Pasting a link into any Claude Code session works too. Joining needs only the plugin: no server, account or sign-in.
- **Share:** press **Share** above the prompt, or type `/share-session`. In a session that already has prompts, it asks first whether teammates may see them: **Share everything**, or **Only from now on** (`/share-session all` or `/share-session new`). The link is copied. It goes through the public server unless you set your own (below).
- **Room:** press **Room** above the prompt, or type `/room`, for:
  - who's here and who Claude is working for;
  - the side chat, what was shown, and the activity;
  - settings: the host's rules for everyone, and each guest's own.
- **Show:** what the host's Claude shows reaches everyone by itself. The host can also type `/share-file <path>` to show a file, or `/share-preview <port>` to let teammates open a local dev server. Both are listed in the Room, where guests reopen them and the host stops previews. Someone who joins later gets everything so far in the join reply at once, its tool calls as cards, then any preview still open.
- **In a terminal:** the same, by keyboard. Type `/share-session`, `/room` and `/stop-sharing`; paste a link as a prompt to join. The row above the prompt says who's here and whose turn it is, and its buttons take focus like the rest of the prompt area. What the host's Claude shows reaches a terminal guest as a saved file or a link to open in a browser.
- **Stop:** press **Leave**, or **Stop sharing** twice (it ends the room for everyone), or type `/stop-sharing`. Esc in a guest stops the shared turn.
- **Restarting is fine.** If the host quits Claude Code (to update, say), the room stays open: guests see the host away, and what they type meanwhile is answered there, not run. Reopening the same session (Claude Desktop does it after a restart; `claude --resume` in a terminal) picks the room back up on the same link. `/clear` ends it, as Stop sharing does. A guest who restarts joins again from the link.
- **Connection:** if the room can't be reached, the row above the prompt says it is reconnecting; anything sent meanwhile goes out once it's back.

## Privacy and the public server

Out of the box, Share uses `https://claude-share.proud-limit-da0a.workers.dev`, run by this project ([its page](https://claude-share.proud-limit-da0a.workers.dev/)). Joining a link always uses the server in that link.

- **What it sees:** while a session is shared, its prompts, Claude's replies, the tools it runs with the first lines of their results, the side chat, and files or local previews the host's Claude shows. Sharing a session that already has history asks first whether to include it.
- **How long:** a room and everything in it is deleted 24 hours after the host stops sharing or was last seen. No accounts, no analytics, no request logs.
- **Who can see it:** anyone with the room's link. It's encrypted in transit, not end to end: the server can read what passes through it.
- **Limits:** per network, 6 new rooms and 30 joins a minute; per room, 20 people, 50 MB of files and 900 posts a minute. Abused rooms get ended.

To keep sessions on your own infrastructure, run your own server (below) and set it in the plugin's `server` option or `SHARED_SESSION_SERVER`.

## Host a server

Teams can run their own room server instead of the public one. Rooms are short-lived: they expire 24 hours after the host was last seen, and nothing is kept after that.

**Cloudflare (recommended):** a Worker with one Durable Object per room. A quiet room costs nothing: open streams end at the Worker, and the room sleeps between changes. It fits the free plan for a small team. From a clone of this repo:

```bash
node scripts/setup.mjs deploy
```

That signs you in (`npx wrangler login` in a browser), deploys and waits for the server. It then points this machine at it and prints the one-line install for teammates. By hand, it's `npx wrangler login`, `npx wrangler deploy`, then `npx wrangler deploy -c wrangler.preview.toml`. The second Worker serves previews of a host's localhost on a host name of its own.

**Anywhere else:** any machine with Node 20 behind HTTPS.

```bash
PORT=8787 PUBLIC_URL=https://share.example.com DATA_FILE=./rooms.json node server/node.mjs
```

Previews are served on a second port (`PREVIEW_PORT`, default `PORT` + 1); set `PREVIEW_URL` to how people reach it, such as `https://preview.example.com`.

**Then point Claude Code at it.** Use any one of these:

- run `/plugin configure shared-session` and enter the address;
- set `SHARED_SESSION_SERVER` in the `env` block of `~/.claude/settings.json`, or in your organization's managed settings so a whole team gets it;
- in your own fork, bake the address in with `node scripts/set-server.mjs https://your-server`.

## Troubleshooting

| You see | What it means |
| --- | --- |
| No Share button, or `Unknown command: /share-session` | The session started before the plugin was installed. Start a new session, or quit and reopen Claude Desktop. |
| An old error after updating the plugin | Same cause: a session keeps the plugin copy it started with, and `/reload-plugins` re-reads that copy. Restart Desktop or use a new session. |
| `Couldn't share: Sharing needs a share server…` | No server is set. Run `node scripts/setup.mjs host --server <url>`, or `deploy` to make one. |
| `ECONNREFUSED` when sharing | The server address points at a machine that isn't running a server. Run `node scripts/setup.mjs check` to see which address is set. |
| `hooks: Invalid input` from `claude plugin …` | That `claude` is older than 2.1.286. Run `claude update`. `setup.mjs` uses Claude Desktop's bundled one instead on a Mac, or whatever you set in `CLAUDE_BIN`; it then notes that your terminal `claude` still needs `claude update`. |
| `You need a workers.dev subdomain` on deploy | One-time Cloudflare setup: open Workers & Pages in the dashboard once, then deploy again. |
| TLS handshake errors right after the first deploy | The new certificate takes a minute or so. |
| A pasted link goes to Claude as a normal prompt | The plugin isn't loaded in that session (see the first row), or the link was edited. |

## Security model

- **The link is the key.** Room ids are 128-bit random values; anyone holding a link can join while the host shares. Names are self-declared: `git config user.name`, else the computer's username.
- **The server relays plaintext.** It sees the shared transcript: prompts, replies, tool calls and results. Run it somewhere you trust.
- **Guests can't act on the host's machine without the host.** By default, only reads inside the host's project run without asking; a guest's request to read anywhere else, edit, run commands or use the web asks the host first. "Always allow" trusts one person for the session. The host can require approval for every tool, or none.
- **What Claude shows travels too, unless the host keeps it.** Files Claude shows go through the server (10 MB each, deleted with the room). The host can keep them in Room → Host controls.
- **Previews are for the room only.** Each guest opens a preview with a link that lasts ten minutes and lets in only the first browser that uses it. The host's plugin only fetches ports the host shared, and previews end with the room.
- **Only what a person types travels.** Desktop's hidden context notes are stripped from prompts before they leave a machine. A link relayed by another session, a channel or a task never joins anything.

## Limits

- **Guests' tool cards are replays.** The host's tool calls show in a guest's transcript as tool cards (Bash, Read, Edit…) with the host's results, drawn by the plugin's own `replay` tool, which runs nothing. Each result is cut to its first 40 lines. A guest's session lists that tool while joined.
- **Not mirrored:** subagents' inner steps and pasted images.
- **No "Alex is typing…".** The engine doesn't see keystrokes in Claude Desktop's composer.
- **Needs `curl` for live updates.** Each shared session keeps one `curl` process reading the room's stream, so a quiet room makes no requests. Without `curl`, or against a server too old to stream, the plugin polls instead, from every 0.4 s while busy down to every 15 s when quiet.
- **Failed host turns:** guests see a note in the reply when the host's turn errors or is refused.
- **Previews are plain HTTP.** No WebSockets, so a dev server's hot reload doesn't reach guests; they reload. Request bodies are limited to 1 MB and responses to 20 MB. The host needs `sh` and `curl` (macOS or Linux).
- **What's shown opens by itself.** A page or preview opens in a guest's browser pane without asking, even in auto mode; a guest can choose in the Room to be asked first, and a public link always asks. A terminal guest gets the file saved and a note instead of a viewer.
- **Session list changes are Desktop-only.** The 👥 title and the pin use Claude Desktop's own sidebar tools. Elsewhere they're skipped.

## Develop

| Path | What it is |
| --- | --- |
| `plugin/` | The plugin: `hooks/register.tsx` (hooks), `hooks/rows.ts` (transcript rows), `hooks/look.ts` (drawings), `tests/` |
| `server/core.mjs` | Room logic and the link page, shared by both servers |
| `server/worker.mjs`, `wrangler.toml` | Cloudflare Worker + Durable Object |
| `server/node.mjs` | Zero-dependency Node server |
| `test/e2e.mjs` | End to end: a real host and guests through a server |

```bash
node server/node.mjs
```
```bash
claude --plugin-dir ./plugin
```
```bash
claude plugin test plugin
```
```bash
CLAUDE_BIN=$(which claude) node test/e2e.mjs
```

Add `EXTERNAL_SERVER=1 SHARE_SERVER=https://your-server` to run it against a deployed server instead of a local one, or `SHARED_SESSION_TRANSPORT=poll` to test the polling fallback.

The end-to-end run starts a host (in bypass mode, on purpose) and two guests, then checks:
- sharing and joining;
- history and attribution;
- live replies, and that guests never call a model;
- ordering;
- Esc from a guest;
- that everyone hears the room over one open stream;
- that a file the host shares lands in the guest's project, that a guest opens the host's localhost through a preview, that someone who joins later is handed it with everything before in the join reply, and that a dev server the host's Claude gives the address of opens for guests at that page;
- that a guest's write is refused without approval;
- that sharing ends cleanly.

## License

MIT, see [LICENSE](LICENSE). The Paradigm name, logo and the Clover character used in the link page and Room banner are trademarks of Paradigm Study and are not covered by the license; see [TRADEMARKS.md](TRADEMARKS.md).
