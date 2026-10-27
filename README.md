# Shared Sessions for Claude Code

Share a Claude Code session with a link. Teammates join from their own Claude Code and see your prompts, replies and tool results live. Their prompts run on your machine, and you approve what they do.

[Install](#install) · [Quick start](#quick-start) · [Commands](#commands) · [Full guide](docs/guide.md) · [Contribute](CONTRIBUTING.md)

[![A teammate's invitation above the composer in Claude Desktop](docs/assets/invitation-demo.png)](https://x.com/thescottfan/status/2109815791441072416)

[Watch the 90-second demo](https://x.com/thescottfan/status/2109815791441072416). Recorded with fictional teammates; [credits](docs/assets/README.md).

## What you get

- **Pair on a real task.** A teammate joins your session, history included, and prompts Claude on the same code.
- **Stay in control.** A guest's edit, command or network call asks you first. Watch-only mode is available.
- **Share your dev server.** `/share-preview 3000` lets guests open your app at `http://localhost:3000` on their machine.
- **Keep working while you sleep.** Move the session to a cloud container and bring it home later.
- **Find your team.** Optional teams add sign-in, session lists and invitations.

Works in Claude Desktop and the terminal, on a public server or [your own](#host-your-own-server).

## How it works

![Shared Sessions architecture: the host and guests talk to the room server on Cloudflare, a main Worker and a preview Worker in front of Durable Objects, with storage and external services](docs/assets/architecture.svg)

The host's machine does all the work. A guest's prompt goes through the room server to the host's Claude Code, which runs it as a turn of its own.

By default, every edit, command and network call that a guest's prompt makes asks the host first, agents included. A call the host does not answer is declined.

Guests see the host's tool calls replayed in their own Claude Code. A replay runs nothing on the guest's machine, and the guest's model is never called. [Permissions, files and preview boundaries](docs/guide.md#security-model).

## Privacy

The link is the key. Anyone with it can join, unless you limit the room to a team.

The room server receives the shared transcript, tool results, chat and files. Traffic is encrypted in transit, **not end to end**. The public server deletes a room and its files 24 hours after the host stops or was last seen. It keeps no analytics and no request logs.

Only a server that turns on traces keeps a session's turns for its team to search. The public server does not.

A preview page left open in a browser can reach the previews of a session that browser opens next. Close previews from a session you do not trust before you open another one's.

A session moved to the cloud sends your project files, conversation and Claude token to a container. The container is deleted when you bring the session home, the room ends, or a week passes.

[What the server keeps, and for how long](docs/guide.md#privacy-and-the-public-server).

## Install

Both people need Claude Code **2.1.286 or later** (`claude --version`) and this plugin:

```bash
claude plugin marketplace add Paradigm-Study/claude-share
claude plugin install shared-session@claude-share
```

Start a new session after you install. In Claude Desktop, quit and reopen the app.

Is your terminal `claude` older than the one Claude Desktop bundles? Run the setup script instead. It needs Git and Node 22.18+:

```bash
git clone https://github.com/Paradigm-Study/claude-share.git && cd claude-share
node scripts/setup.ts join
```

`join` installs the plugin for sharing and joining. If it prints `NEEDS HUMAN`, do that step and run it again. [More install options](docs/guide.md#install).

## Quick start

Sharing sends the session's whole history to everyone with the link. In a session that already has messages, Share asks first. Choose **Only from now on** to leave earlier messages out.

1. **Host:** press **Share** above the prompt, or type `/share-session`. Copy the link.
2. **Teammate:** paste the link into a new Claude Code session and send it.
3. **Teammate:** ask Claude to read the README. The prompt runs on the host's machine, and both sessions show the reply and tool calls.
4. **Host:** type `/stop-sharing`. The room ends for everyone.

## Commands

| Command | Does |
| --- | --- |
| `/share-session` | Share this session. Add `watch` so teammates can only watch, or `new` to leave out earlier messages |
| `/stop-sharing` | Host: end the room for everyone. Guest: leave it |
| `/room` | People, timeline, changed files, side chat, settings |
| `/who` | Who is here, and what each person is doing |
| `/share-preview <port>` | Host: let teammates open a local web server |
| `/share-file <path>` | Host: show a file to everyone |
| `/team` | Sign in, make a team, and see its shared sessions |
| `/invite <name>` | Invite a teammate into this session. Needs sign-in and a shared team |

[Every command, previews and the cloud host](docs/guide.md#use-it).

## Troubleshooting

- **No Share button, or unknown command:** the session started before the install. Start a new one.
- **`hooks: Invalid input`:** your Claude Code is too old. See [Install](#install).
- **A pasted link gets a normal Claude reply:** the plugin is not loaded. Paste the link into a new session.
- **Check the setup:** run `node scripts/setup.ts check --live` from a clone.

[More troubleshooting](docs/guide.md#troubleshooting) · [Known limits](docs/guide.md#limits) · [Report a bug](https://github.com/Paradigm-Study/claude-share/issues/new/choose)

## Host your own server

```bash
node scripts/setup.ts deploy
```

This deploys the room server to your Cloudflare account. It needs Node 22.18+, and a person must approve the browser sign-in. To use a server that already exists: `node scripts/setup.ts host --server https://your-server`. [Cloudflare and team sign-in setup](docs/guide.md#host-a-server).

## Develop

The plugin is in `plugin/`. The room server is in `server/`. [CONTRIBUTING.md](CONTRIBUTING.md) covers tests. [AGENTS.md](AGENTS.md) records setup and the release steps. [docs/rules/](docs/rules/) records the rules the design keeps.

## License

[MIT](LICENSE). The Paradigm name, logo and Clover character are [trademarks of Paradigm Study](TRADEMARKS.md). Demo music has [its own terms](docs/assets/README.md).
