# The cloud host: Claude Code with this plugin, taking a shared session's
# room over from the person who moved it there (cloud/runner.mts).
# Built from the repository's root: `docker build -f cloud/Dockerfile .`
# Pinned: the runner and the plugin's relay helpers are TypeScript that Node
# (22.18+) runs with its types stripped.
FROM node:22.23.4-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates procps \
  && rm -rf /var/lib/apt/lists/*

# Pinned: 2.1.304 is the first with the messaging the plugin's mailboxes use.
ARG CLAUDE_CODE_VERSION=2.1.304
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && claude --version

# Claude Code refuses to skip its permission prompts as root, and the plugin
# asks the approver for each call instead, so the session runs as a user.
RUN useradd --create-home --uid 1001 runner

COPY plugin /opt/shared-session/plugin
COPY cloud/runner.mts /opt/shared-session/runner.mts
RUN rm -rf /opt/shared-session/plugin/tests /opt/shared-session/plugin/.claude

EXPOSE 8080
# As root only to make the session's folder (at the same path it had on the
# person's machine, so the conversation's paths still hold), then as `runner`.
CMD ["node", "/opt/shared-session/runner.mts"]
