# Keeping a shared session running in the cloud

A shared session's host is a Claude Code on someone's laptop. When the laptop
sleeps, the room stays open but nobody's prompts run. **Move to cloud** hands
the host over to a Claude Code in a container next to the room server, so the
session keeps going for everyone; **Bring home** hands it back.

Anthropic's cloud sessions (Claude Desktop's "Continue in cloud") can't do
this: they don't install a repository's plugins, and their machine pauses after
a few minutes idle, with nothing outside able to wake it with a teammate's
prompt. So the room server runs the host itself.

## What happens

1. **Move to cloud** (the Room, host only). The host's plugin gets the mover's
   Claude sign-in for the runner (`claude setup-token`, approved in their
   browser; kept on their machine for next time), packs the session (the
   project's files as git tracks them plus untracked ones not ignored, and the
   conversation's transcript), and posts it to the room
   (`POST rooms/:id/cloud`). The room starts the runner and makes the mover
   the room's **approver**. The laptop's session stays in the room as a guest:
   it follows every turn, and its prompts go to the cloud host like anyone's.
2. **The runner** (`cloud/runner.mjs`, image `cloud/Dockerfile`) lays the
   project out at the path it had on the laptop (so the conversation's paths
   still hold) as a git repository whose first commit is what was moved,
   writes the room into the plugin's own checkpoint, and runs Claude Code
   headless with the plugin (`--resume` the moved conversation). The plugin
   takes the room up exactly as a host does after a restart.
3. **Approvals go to the approver.** A runner has nobody at its screen, so a
   teammate's call that would ask the host is put to the room (`ask`); only the
   approver's session draws it (the row above the prompt, the Room), and only
   the approver's seats may answer (`answer`). Ten minutes unanswered is a no.
   Every question the host's row would ask about its localhost is asked the
   same way, one at a time: sharing a page its Claude gives out
   (`http://localhost:3000/…`), letting teammates open it at the same address,
   what it uses beside it, a teammate's window needing a port. Unanswered in
   ten minutes, nothing is shared, and it's asked again later. After a yes,
   the approver is told what it came to: shared, or that the cloud host
   couldn't share or forward it. The container's own control port (8080) is
   never asked about or shared.
   While it runs, the approver's Room → Settings are the cloud host's: who may
   prompt (never turning the approver away), what it asks about first (every
   call, or all but reading the project; never nothing), where what Claude
   shows goes, and Ask again for whom they always allowed. Only the
   approver's seats may change them (`set`).
4. **Bring home** (approver only). The room stops the runner, which answers
   with its changes since the move (a git diff of the repository); the
   approver's session takes the host back with a fresh host token and offers
   the changes to apply. The laptop's transcript already holds every turn the
   cloud ran (they played there as rides), so its Claude goes on knowing them.

The room's end, its expiry, and the approver leaving for good stop the runner.

## Who runs what

- **Cloudflare**: `HostContainer`, a Durable Object with a container, one per
  room in the cloud (`idFromName(roomId)`). The room asks it to start and stop;
  it hands the runner its configuration and the packed session over the
  container's own port, never a public address, and keeps nothing after.
- **Tests**: `wrangler dev` builds the image from `cloud/Dockerfile` with
  Docker (`CLOUD_DOCKER=1 node test/cloud.mjs`).
- **The image** is built once and kept in this project's Cloudflare registry,
  so deploying needs no Docker (`scripts/push-image.mjs` makes a new one after
  `cloud/` changes). It doesn't change with releases: the runner takes the
  plugin from GitHub's `main` at the room server's version, falling back to
  the one built in.

## Secrets

- The mover's Claude token (from `claude setup-token`, model use only) goes to
  the runner's Claude Code and nowhere else; the room server holds it only
  while starting the runner. Revoke it at claude.ai to stop it anywhere.
- The runner's host token is minted for it; the laptop's host token stops
  working at the move, and a new one is minted at Bring home.
- Teammates' prompts run with that token inside the container's reach, so
  every call of theirs that touches the shell, files or the network is asked
  of the approver, whatever the room's approval setting.
