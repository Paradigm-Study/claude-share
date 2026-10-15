# Contributing

Bug reports, reproducible examples, documentation fixes, and focused pull requests are welcome. For a larger change, open an issue describing the workflow and proposed behavior so the approach can be discussed first.

## Run the local checks

Use Node.js 20 or later on macOS or Linux. From the repository root, these suites need no npm install, Claude account, model access, or Cloudflare credentials:

```sh
node test/setup.mjs
node test/teams.mjs
node test/tcp-worker.mjs
node test/local-preview.mjs
```

The setup suite uses a fake CLI, intercepted network requests, and a temporary home directory without changing your Claude settings. The other suites start and stop their own local servers. The teams suite uses ports 8899 and 8900 by default; set `TEAMS_PORT` to an available port if necessary (the next port must also be free). The TCP suites choose temporary ports. The local-preview suite also uses the system `ps` command. GitHub Actions runs each suite separately on Node 20 and 24.

These checks cover installer failures and server selection, accounts and room access, Worker protocol and hibernation behavior with stubs, and real local TCP forwarding through the production helpers. They do not validate Claude's UI or a deployed Cloudflare Worker.

## Work on the plugin

Use a compatible Claude Code installation; see the [README](README.md) for requirements. Start a development session from the repository root:

```sh
claude --plugin-dir ./plugin
```

In that session, run `/plugin-types plugin/.claude/types` to generate the engine's API types. Those files are ignored by git. Then run:

```sh
(cd plugin && npx -y -p typescript@5 tsc -p .)
claude plugin validate --strict plugin
claude plugin test plugin
```

For changes to sharing, joining, or transcript behavior, also run the real host-and-guests test with a signed-in Claude Code that can call a model:

```sh
CLAUDE_BIN="$(command -v claude)" node test/e2e.mjs
```

This test uses model access and starts a host in bypass mode. See [AGENTS.md](AGENTS.md) for the interaction contracts, server setup, and additional test options.

## Send a pull request

Explain the user-visible problem, what changes, and how you checked the result. Include a small reproduction or screenshots when they help; for behavior changes, cover the relevant regression. Say which checks you could not run and why.

Keep room links, tokens, private transcripts, and generated session data out of issues and commits. In particular, never commit `rooms.json`. Plugin version bumps and server deployment are release steps described in [AGENTS.md](AGENTS.md).
