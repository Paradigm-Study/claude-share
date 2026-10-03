// What a shared session sends its guests: the host's transcript as compact
// rows, converted from the Messages API blocks `session.append` and
// `$.session.messages({ as: 'api' })` hand over.

import { toolGlyph } from './look'

export type Row = {
  kind: 'user' | 'assistant' | 'tool' | 'result'
  /** Who typed a user row. */
  who?: string
  text: string
  /** A tool row's tool name. */
  tool?: string
  /** A few lines under a tool row: an edit's diff, a write's head. */
  detail?: string
  isError?: boolean
}

type Block = {
  type: string
  text?: string
  name?: string
  input?: unknown
  content?: unknown
  is_error?: boolean
}

// User-side text the engine records around a command or injects as context
// (a skill's instructions, a compacted conversation's summary, a background
// task's notice): none of it is something a person typed.
const ENGINE_TEXT =
  /^\s*(<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr|task-notification|user-prompt-submit-hook)\b|Base directory for this skill:|This session is being continued from a previous conversation|\[SYSTEM NOTIFICATION)/

// Context a host app or the engine puts into a user message; never shown to others.
const SYSTEM_BLOCKS = /<(system-reminder|task-notification)>[\s\S]*?<\/\1>/g

const RESULT_LINES = 8
const RESULT_CHARS = 1200
const DETAIL_LINES = 12

function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content as Block[]) : []
}

function textOf(content: unknown): string {
  return blocksOf(content)
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
}

function clip(text: string, lines: number, chars: number): string {
  const all = text.replace(/\s+$/, '').split('\n')
  let out = all.slice(0, lines).join('\n')
  if (out.length > chars) out = `${out.slice(0, chars)}…`
  const more = all.length - lines
  return more > 0 ? `${out}\n… +${more} lines` : out
}

function relative(path: unknown, cwd: string): string {
  if (typeof path !== 'string') return ''
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function summarizeTool(name: string, input: unknown, cwd: string): { text: string; detail?: string } {
  const i = (input ?? {}) as Record<string, unknown>
  switch (name) {
    case 'Bash':
      return { text: (str(i.command).split('\n')[0] ?? '').slice(0, 200) }
    case 'Read':
      return { text: relative(i.file_path, cwd) }
    case 'Write':
      return {
        text: relative(i.file_path, cwd),
        detail: clip(str(i.content), 6, 600),
      }
    case 'Edit': {
      const minus = str(i.old_string).split('\n').map(l => `- ${l}`)
      const plus = str(i.new_string).split('\n').map(l => `+ ${l}`)
      return { text: relative(i.file_path, cwd), detail: clip([...minus, ...plus].join('\n'), DETAIL_LINES, 1200) }
    }
    case 'NotebookEdit':
      return { text: relative(i.notebook_path, cwd) }
    case 'Grep':
      return { text: `${str(i.pattern)}${i.path ? ` in ${relative(i.path, cwd)}` : ''}` }
    case 'Glob':
      return { text: str(i.pattern) }
    case 'WebFetch':
      return { text: str(i.url) }
    case 'WebSearch':
      return { text: str(i.query) }
    case 'Agent':
    case 'Task':
      return { text: str(i.description) }
    case 'TodoWrite':
      return { text: `${Array.isArray(i.todos) ? i.todos.length : 0} todos` }
    default: {
      const json = JSON.stringify(input ?? {})
      return { text: json.length > 120 ? `${json.slice(0, 120)}…` : json }
    }
  }
}

/**
 * The rows one transcript message makes. `who` names the person behind a
 * user-typed row; `null` means the row was not typed by a person (skip it).
 */
export function rowsFromMessage(
  message: { role?: string; type?: string; isMeta?: boolean; content: unknown },
  who: string | null,
  cwd: string,
): Row[] {
  if (message.isMeta) return []
  const role = message.role ?? message.type
  const rows: Row[] = []
  for (const block of blocksOf(message.content)) {
    if (role === 'user') {
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = block.text.replace(SYSTEM_BLOCKS, '').trim()
        if (who === null || ENGINE_TEXT.test(text) || !text) continue
        rows.push({ kind: 'user', who, text })
      } else if (block.type === 'tool_result') {
        // A file read's lines come numbered ("   12\tcode"); the numbers are noise here.
        const text = textOf(block.content).replace(/^ *\d+\t/gm, '')
        rows.push({
          kind: 'result',
          text: text ? clip(text, RESULT_LINES, RESULT_CHARS) : '(no output)',
          isError: block.is_error === true || undefined,
        })
      }
    } else if (role === 'assistant') {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        rows.push({ kind: 'assistant', text: block.text.trim() })
      } else if (block.type === 'tool_use' && block.name) {
        const { text, detail } = summarizeTool(block.name, block.input, cwd)
        rows.push({ kind: 'tool', tool: block.name, text, detail })
      }
    }
  }
  return rows
}

/** Splits a guest prompt the host submitted as `Name: text`. */
export function splitSpeaker(text: string): { who: string; text: string } | null {
  const match = /^([^\n:]{1,40}): ([\s\S]*)$/.exec(text)
  return match?.[1] && match[2] !== undefined ? { who: match[1], text: match[2] } : null
}

/** The rows as markdown: what a guest's local transcript keeps as text. */
export function rowsToMarkdown(rows: readonly Row[]): string {
  const parts: string[] = []
  for (const row of rows) {
    switch (row.kind) {
      case 'user':
        parts.push(`**${row.who ?? 'Someone'}:** ${row.text}`)
        break
      case 'assistant':
        parts.push(row.text)
        break
      case 'tool': {
        const head = `${toolGlyph(row.tool ?? '')} **${row.tool}**${row.text ? ` \`${row.text.replaceAll('`', "'")}\`` : ''}`
        const diff = row.detail && (row.tool === 'Edit' || row.tool === 'Write')
        parts.push(diff ? `${head}\n\n\`\`\`${row.tool === 'Edit' ? 'diff' : ''}\n${row.detail}\n\`\`\`` : head)
        break
      }
      case 'result':
        parts.push(`  ⎿ ${row.isError ? 'Error: ' : ''}${row.text.replace(/^ *\d+\t/gm, '').split('\n')[0]}`)
        break
    }
  }
  return parts.join('\n\n')
}
