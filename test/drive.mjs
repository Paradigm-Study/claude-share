// Runs one headless Claude Code session as a pretend teammate, for trying a
// shared session by hand. Append lines to the inbox file to type prompts.
//
//   CLAUDE_BIN=... node test/drive.mjs <name> <cwd> <dir>
//   echo 'https://.../s/abc' >> <dir>/<name>.inbox
//
// <dir>/<name>.log gets one line per prompt sent and per reply shown.

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [name, cwd, dir] = process.argv.slice(2)
const inbox = join(dir, `${name}.inbox`)
const log = join(dir, `${name}.log`)
writeFileSync(inbox, '')
writeFileSync(log, '')
const gitconfig = join(dir, `${name}.gitconfig`)
writeFileSync(gitconfig, `[user]\n\tname = ${name}\n`)

const env = { HOME: process.env.HOME, PATH: process.env.PATH, USER: name, TERM: 'dumb', GIT_CONFIG_GLOBAL: gitconfig, SHARED_SESSION_SERVER: process.env.SHARED_SESSION_SERVER ?? 'http://localhost:8787' }
for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) if (process.env[key]) env[key] = process.env[key]
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', process.env.MODEL ?? 'claude-haiku-4-5-20251001', '--debug-file', join(dir, `${name}.debug.log`)]
if (process.env.PLUGIN_DIR) args.push('--plugin-dir', process.env.PLUGIN_DIR)
const child = spawn(process.env.CLAUDE_BIN ?? 'claude', args, { cwd, env })
const note = line => appendFileSync(log, `${new Date().toISOString().slice(11, 19)} ${line}\n`)

let buffer = ''
child.stdout.on('data', chunk => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i)
    buffer = buffer.slice(i + 1)
    try {
      const event = JSON.parse(line)
      if (event.type === 'assistant') {
        for (const block of event.message?.content ?? []) if (block.type === 'text') note(`CLAUDE> ${block.text}`)
      } else if (event.type === 'result') {
        note(`(turn done${event.result?.startsWith('Prompt dropped') ? `: ${event.result}` : ''})`)
      }
    } catch {}
  }
})
child.on('exit', code => note(`(session exited ${code})`))

let seen = 0
setInterval(() => {
  if (!existsSync(inbox)) return
  const lines = readFileSync(inbox, 'utf8').split('\n')
  for (const text of lines.slice(seen, lines.length - 1)) {
    if (!text.trim()) continue
    note(`${name}> ${text}`)
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`)
  }
  seen = Math.max(seen, lines.length - 1)
}, 300)
