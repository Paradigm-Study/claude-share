// What the room keeps beside the transcript, worked out the same way on every
// machine: a key for each of Claude's replies (reactions and who saw it are
// filed under it), who a prompt or chat line mentions, and a file change as
// unified-diff hunks for the Room's Changes page. Pure: no `$`.

/** The reactions a reply takes, in the order they're drawn. */
export const REACTS = ['👍', '🎉', '👀'] as const

/**
 * A reply's key: the same for the host, who wrote it, and for every guest,
 * whose replay draws the same text. Whitespace runs count as one.
 */
export function replyKey(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim().slice(0, 2000)
  let h = 2166136261
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619)
  return `${(h >>> 0).toString(36)}.${t.length}`
}

/** Which of `names` a text @mentions (`@Kyle`, `@kyle,`; a name with spaces by its first word). */
export function mentionsOf(text: string, names: readonly string[]): string[] {
  const out = new Set<string>()
  const at = [...text.matchAll(/(^|[^\w@])@([\p{L}\p{N}._-]+)/gu)].map(m => m[2]!.toLowerCase().replace(/[._-]+$/, ''))
  if (!at.length) return []
  for (const name of names) {
    const whole = name.toLowerCase().replace(/\s+/g, '')
    const first = name.toLowerCase().split(/\s+/)[0] ?? ''
    if (at.some(a => a === whole || a === first)) out.add(name)
  }
  return [...out]
}

export type Patch = { patch: string; added: number; removed: number }

const MAX_LINES = 400
const MAX_CHARS = 16_000

function capped(lines: string[]): string[] {
  const out: string[] = []
  let chars = 0
  for (const line of lines.slice(0, MAX_LINES)) {
    chars += line.length + 1
    if (chars > MAX_CHARS) break
    out.push(line)
  }
  return out
}

/** Hunks as the Edit and Write tools report them (`structuredPatch`). */
export function patchOf(hunks: unknown): Patch | null {
  if (!Array.isArray(hunks) || !hunks.length) return null
  const parts: string[] = []
  let added = 0
  let removed = 0
  for (const h of hunks as { oldStart?: unknown; oldLines?: unknown; newStart?: unknown; newLines?: unknown; lines?: unknown }[]) {
    if (!Array.isArray(h.lines)) continue
    const lines = h.lines.filter((l): l is string => typeof l === 'string' && /^[ +\-\\]/.test(l))
    added += lines.filter(l => l.startsWith('+')).length
    removed += lines.filter(l => l.startsWith('-')).length
    parts.push(`@@ -${Number(h.oldStart) || 0},${Number(h.oldLines) || 0} +${Number(h.newStart) || 0},${Number(h.newLines) || 0} @@`, ...lines)
  }
  if (!parts.length) return null
  return { patch: whole(parts), added, removed }
}

/**
 * An edit's change worked out from its two texts when the tool's own hunks
 * aren't at hand (a guest's copy, an older host): a line diff, its numbers
 * counted from the edit's own first line.
 */
export function diffOf(before: string, after: string): Patch {
  const a = before.split('\n')
  const b = after.split('\n')
  // Longest common subsequence over lines, small enough for an edit's region.
  const n = Math.min(a.length, 600)
  const m = Math.min(b.length, 600)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const lines: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`)
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) lines.push(`-${a[i++]}`)
    else lines.push(`+${b[j++]}`)
  }
  while (i < n) lines.push(`-${a[i++]}`)
  while (j < m) lines.push(`+${b[j++]}`)
  const added = lines.filter(l => l.startsWith('+')).length
  const removed = lines.filter(l => l.startsWith('-')).length
  const old = lines.filter(l => !l.startsWith('+')).length
  const neu = lines.filter(l => !l.startsWith('-')).length
  return { patch: whole([`@@ -1,${old} +1,${neu} @@`, ...lines]), added, removed }
}

/** A new file's lines, all added. */
export function writeOf(content: string): Patch {
  const lines = content.replace(/\n$/, '').split('\n')
  return { patch: whole([`@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)]), added: lines.length, removed: 0 }
}

// A patch held to a size the room carries. A hunk cut short gets its
// header counted again from what's kept, so it still reads as a hunk.
function whole(lines: string[]): string {
  const kept = capped(lines)
  if (kept.length === lines.length) return kept.join('\n')
  let start = -1
  for (let k = kept.length - 1; k >= 0; k--) {
    if (kept[k]!.startsWith('@@')) {
      start = k
      break
    }
  }
  if (start < 0) return kept.join('\n')
  const body = kept.slice(start + 1)
  const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(kept[start]!)
  if (!head || !body.length) return kept.slice(0, start).join('\n')
  const old = body.filter(l => !l.startsWith('+') && !l.startsWith('\\')).length
  const neu = body.filter(l => !l.startsWith('-') && !l.startsWith('\\')).length
  return [...kept.slice(0, start), `@@ -${head[1]},${old} +${head[2]},${neu} @@`, ...body].join('\n')
}

/** "41s", "2m 3s". */
export function took(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
