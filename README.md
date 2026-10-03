# Shared Sessions for Claude Code

Share a Claude Code session with a link. Teammates open it, land in a Claude Code session of their own that is attached to yours, and talk to it. Everyone sees every prompt and every reply, live, as normal transcript rows.

- **One machine does the work.** The session that shared is the host. Every turn and every tool runs there, in its folder, under its login.
- **Everyone else is a guest.** A guest's prompt goes to the host and runs in turn. Every host turn plays out in each guest's own transcript as a prompt and a streamed reply. A guest's own model is never called.
- **The host stays in charge.** When a guest's prompt makes Claude write a file, run a command or reach the network, the host is asked first, whatever the host's permission mode. The question shows the exact command or diff. The host can also make the session watch-only.
- **It lives in Claude's own UI.** In Claude Desktop and the terminal:
  - a teammate's prompts carry their dot avatar and name;
  - the footer and working line say who's here and whose turn it is;
  - a Room panel has people, activity, host controls and a side chat Claude never reads;
  - in Desktop, the session list marks shared sessions.

Built as a Claude Code plugin of function hooks (a "mod"), plus a small room server that runs on Cloudflare or as a single Node process.

## Install

One line in a terminal:

```bash
claude plugin marketplace add Paradigm-Study/claude-share && claude plugin install shared-session@claude-share
```

Requires Claude Code 2.1.286 or later (`claude update`; Claude Desktop includes it). New sessions pick it up. (Claude Code installs third-party plugins from a marketplace it knows, hence the two steps in one line.)

**For a whole team, nothing to type:** in your organization's managed settings (or a project's checked-in `.claude/settings.json`), add:

```json
{
  "extraKnownMarketplaces": { "claude-share": { "source": { "source": "github", "repo": "Paradigm-Study/claude-share" } } },
  "enabledPlugins": { "shared-session@claude-share": true }
}
```

## Use it

- **Join:** open a share link. Its page opens Claude Desktop with the link in a new session's prompt box, so you press Enter. Pasting a link into any Claude Code session works too. Joining needs no setup.
- **Share:** press **Share** above the prompt, or type `/share-session`. The link is copied. Sharing needs a server; see below.
- **Room:** press **Room** above the prompt, or type `/room`, for:
  - who's here and who Claude is working for;
  - the timeline and the side chat;
  - for the host, the controls.
- **Stop:** press **Leave** or **Stop sharing**, or type `/stop-sharing`. Esc in a guest stops the shared turn.

## Host a server

Sharing needs a room server you run. Rooms are short-lived: they expire 24 hours after the host was last seen, and nothing is kept after that.

**Cloudflare (recommended):** a Worker with one Durable Object per room; fits the free plan.

```bash
git clone https://github.com/Paradigm-Study/claude-share && cd claude-share
```
```bash
npx wrangler login
```
```bash
npx wrangler deploy
```

**Anywhere else:** any machine with Node 20 behind HTTPS.

```bash
PORT=8787 PUBLIC_URL=https://share.example.com DATA_FILE=./rooms.json node server/node.mjs
```

**Then point Claude Code at it.** Use any one of these:

- run `/plugin configure shared-session` and enter the address;
- set `SHARED_SESSION_SERVER` in the `env` block of `~/.claude/settings.json`, or in your organization's managed settings so a whole team gets it;
- in your own fork, bake the address in with `node scripts/set-server.mjs https://your-server`.

## Security model

- **The link is the key.** Room ids are 128-bit random values; anyone holding a link can join while the host shares. Names are self-declared (`git config user.name`).
- **The server relays plaintext.** It sees the shared transcript: prompts, replies, tool calls and results. Run it somewhere you trust.
- **Guests can't act on the host's machine without the host.** By default, a guest's request to edit, run commands or use the web asks the host. "Always allow" trusts one person for the session. The host can require approval for every tool, or none.
- **Only what a person types travels.** Desktop's hidden context notes are stripped from prompts before they leave a machine. A link relayed by another session, a channel or a task never joins anything.

## Limits

- **Guests see tool calls as text.** The host's tool calls appear in guests' transcripts as compact lines (`❯ Bash`, `✎ Edit` with a diff), not native tool cards.
- **Not mirrored:** subagents' inner steps and pasted images.
- **No "Alex is typing…".** The engine doesn't see keystrokes in Claude Desktop's composer.
- **Polling, not streaming connections.** The plugin polls (0.4 s while active, 1.5 s idle), because a plugin request held open delays the next prompt's dispatch.
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

Add `EXTERNAL_SERVER=1 SHARE_SERVER=https://your-server` to run it against a deployed server instead of a local one.

The end-to-end run starts a host (in bypass mode, on purpose) and two guests, then checks:
- sharing and joining;
- history and attribution;
- live replies, and that guests never call a model;
- ordering;
- Esc from a guest;
- that a guest's write is refused without approval;
- that sharing ends cleanly.

## License

MIT, see [LICENSE](LICENSE). The Paradigm name, logo and the Clover character used in the link page and Room banner are trademarks of Paradigm Study and are not covered by the license; see [TRADEMARKS.md](TRADEMARKS.md).
