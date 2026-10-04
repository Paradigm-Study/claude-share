---
description: Share this session with a link
---
<!-- Where the plugin's hooks module loaded, it answers this command itself (as /share-session and /shared-session:share-session) and this file never reaches the model. Reaching the model means the module didn't load in this session. -->
The Shared Sessions plugin is installed, but its code isn't running in this session, so it can't share. Reply with only the following, in the user's language, and do nothing else:

Shared Sessions isn't running in this session. One of these fixes it:

1. **Start a new session.** A session keeps the plugins and the Claude Code version it started with, so after installing or updating either, open a new one (in Claude Desktop, quit and reopen the app). `/reload-plugins` isn't enough.
2. **Update Claude Code to 2.1.286 or newer:** `claude update` (or `npm install -g @anthropic-ai/claude-code@latest` for an npm install). `claude --version` shows the installed one.
3. **Still here on 2.1.285 or newer?** Plugin hooks may be off for your account: add `"env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }` to `~/.claude/settings.json`, then start a new session.
