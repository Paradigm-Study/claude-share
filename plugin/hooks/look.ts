// How a shared session looks. Every person has a color of their own, the
// same wherever they appear: their face, their name in the Room and the chat,
// their prompts in the transcript, "Claude is working for …". "Live" is
// Claude's own orange; everything else takes the app's theme colors, so the
// plugin reads as part of Claude Code rather than a page pasted into it.
//
// The Desktop app draws faces as images: transparent, animated, and styled for
// light and dark under `prefers-color-scheme`, which follows the app's theme.
// (Not `isInteractive`: that sandboxed frame paints an opaque page behind the
// art, a white box on a dark theme.) Pure: strings in, strings out.

import { CLOVER_WEBP } from './brand'

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

export const GOOD = '#3ca146' // allowed, on both themes
export const BAD = '#d95b56' // declined, on both themes

// People's colors: eight hues spaced around the wheel at one lightness
// (OKLCH L 0.63), so a white initial reads on each (3.3:1 and up) and so does
// each as a bold name on Claude's light and dark surfaces (3.3:1 and up).
// Gold, not orange, so nobody wears the Live chip's color.
export const PEOPLE = ['#dd555d', '#ad8100', '#6a9a29', '#00a085', '#009abf', '#5983e9', '#a169da', '#d15697'] as const

const hash = (s: string) => {
  let h = 2166136261
  for (const c of s.trim().toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}

/** A person's own color, from their name: the same in every room. */
export const colorFor = (name: string): string => PEOPLE[hash(name) % PEOPLE.length]!

/**
 * Colors for everyone shown together, in the order they came (the host
 * first): each their own color, and when it's taken, the next free one. So
 * the host always has their own, and someone new never repaints anyone; and
 * everyone in a room, given the room's order, sees the same colors.
 */
export function colorsFor(names: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  const taken = new Set<number>()
  const n = PEOPLE.length
  const apart = (i: number) => Math.min(...[...taken].map(t => Math.min(Math.abs(i - t), n - Math.abs(i - t))))
  for (const name of new Set(names)) {
    let pick = hash(name) % n
    // Taken: the free color farthest round the wheel from those in use, so
    // two people never look alike; everyone's in use, their own again.
    if (taken.has(pick) && taken.size < n) {
      let best = -1
      for (let k = 0; k < n; k++) {
        const i = (pick + k) % n
        if (!taken.has(i) && apart(i) > best) [best, pick] = [apart(i), i]
      }
    }
    taken.add(pick)
    out.set(name, PEOPLE[pick]!)
  }
  return out
}

const FONT = `-apple-system,"SF Pro Text","Segoe UI",Inter,sans-serif`

/** One letter for one word, two for two: "Sam" → S, "Alex Chen" → AC. */
export function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? '?').slice(0, 1)
  return letters.toUpperCase()
}

/**
 * Dot labels for everyone shown together: one initial, or two words' two;
 * when single-word names share a first letter, two letters ("Sa", "Sc").
 */
export function labelsFor(names: readonly string[]): Map<string, string> {
  const first = (n: string) => (n.trim()[0] ?? '?').toUpperCase()
  const counts = new Map<string, number>()
  for (const n of new Set(names)) counts.set(first(n), (counts.get(first(n)) ?? 0) + 1)
  const out = new Map<string, string>()
  for (const n of names) {
    const words = n
      .trim()
      .split(/[\s._-]+/)
      .filter(Boolean)
    if (words.length >= 2) out.set(n, `${words[0]![0]}${words[1]![0]}`.toUpperCase())
    else if ((counts.get(first(n)) ?? 0) > 1) out.set(n, `${first(n)}${(words[0] ?? '').slice(1, 2).toLowerCase()}`)
    else out.set(n, first(n))
  }
  return out
}

export type Face = { name: string; online: boolean; note?: string; active?: boolean; label?: string; version?: string; color?: string }

const MOTION = `<style>
.face{transform-box:fill-box;transform-origin:center;transition:transform .22s cubic-bezier(.22,1,.36,1)}
.face:hover{transform:scale(1.1)}
.breathe .dot{transform-box:fill-box;transform-origin:center;animation:breathe 1.9s cubic-bezier(.45,0,.55,1) infinite}
@keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
@media (prefers-reduced-motion: reduce){.breathe .dot{animation:none}}
.more{fill:#73726c}@media (prefers-color-scheme: dark){.more{fill:#9c9a92}}
.edge{stroke:#fff}@media (prefers-color-scheme: dark){.edge{stroke:#30302e}}
.ring{transform-box:fill-box;transform-origin:center;animation:ring 2s cubic-bezier(.32,.72,0,1) infinite}
@keyframes ring{0%{transform:scale(.6);opacity:.55}100%{transform:scale(1.7);opacity:0}}
@media (prefers-reduced-motion: reduce){.ring{animation:none;opacity:0}}
</style>`

// A filled dot in the person's color with their initial knocked out in white;
// away, a ring in their color around their initial. Breathes while Claude
// works for them.
function face(f: Face, cx: number, cy: number, r: number, edge = false): string {
  const color = f.color ?? colorFor(f.name)
  const classes = ['face', f.active ? 'breathe' : ''].filter(Boolean).join(' ')
  const letters = f.label ?? initials(f.name)
  const size = letters.length > 1 ? r * 0.8 : r * 0.98
  const dot = f.online
    ? `<circle class="dot${edge ? ' edge' : ''}" cx="${cx}" cy="${cy}" r="${r}" fill="${color}"${edge ? ' stroke-width="1.5"' : ''}/>`
    : `<circle class="dot" cx="${cx}" cy="${cy}" r="${r - 0.9}" fill="none" stroke="${color}" stroke-width="1.8"/>`
  return `<g class="${classes}"><title>${esc(f.name)}${f.note ? ` · ${esc(f.note)}` : ''}</title>${dot}<text x="${cx}" y="${cy}" dy=".36em" text-anchor="middle" font-family='${FONT}' font-size="${size.toFixed(1)}" font-weight="650" fill="${f.online ? '#fff' : color}">${esc(letters)}</text></g>`
}

/** One person's face, `size` CSS pixels square. */
export function avatarSvg(f: Face, size = 22): string {
  const r = size / 2 - 1
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${MOTION}${face(f, size / 2, size / 2, r)}</svg>`
}

/**
 * Everyone here at a glance: their faces in a row, slightly overlapping (at
 * most `max`, then "+N"). Returns the markup and its width.
 */
export function stackSvg(faces: readonly Face[], opts: { size?: number; max?: number } = {}): { source: string; width: number } {
  const size = opts.size ?? 22
  const r = size / 2 - 1
  const step = r * 2 - 4
  const shown = faces.slice(0, opts.max ?? 6)
  const extra = faces.length - shown.length
  const cy = size / 2
  const width = Math.ceil(r * 2 + 2 + Math.max(0, shown.length - 1) * step + (extra > 0 ? 24 : 0))
  // Later faces under earlier ones: the host, first, sits on top.
  const dots = shown
    .map((f, i) => face(f, 1 + r + i * step, cy, r, true))
    .reverse()
    .join('')
  const more =
    extra > 0
      ? `<text class="more" x="${r * 2 + 6 + (shown.length - 1) * step}" y="${cy}" dy=".36em" font-family='${FONT}' font-size="11" font-weight="600"><title>${extra} more</title>+${extra}</text>`
      : ''
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${size}" viewBox="0 0 ${width} ${size}">${MOTION}${dots}${more}</svg>`,
    width,
  }
}

/** Live: Claude's orange dot, a ring around it that widens and fades (still under reduced motion). */
export function liveSvg(color = '#d97757', size = 12): string {
  const c = size / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${MOTION}<circle class="ring" cx="${c}" cy="${c}" r="${c - 1}" fill="none" stroke="${color}" stroke-width="1.2"/><circle cx="${c}" cy="${c}" r="${c / 2.4}" fill="${color}"/></svg>`
}

/** Clover, Paradigm's cat, for the one empty screen it brightens. */
export function cloverSvg(width = 96): string {
  const height = Math.round(width * 0.56)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>@media (prefers-color-scheme: dark){image{filter:invert(1) hue-rotate(180deg)}}</style><image href="${CLOVER_WEBP}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMax meet"/></svg>`
}

/** "3m ago" style ages for activity and chat. */
export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

/** Glyph per tool, for compact lines a guest's transcript shows. */
export function toolGlyph(tool: string): string {
  if (tool === 'Bash') return '❯'
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return '✎'
  if (tool === 'Read') return '◧'
  if (tool === 'Grep' || tool === 'Glob') return '⌕'
  if (tool === 'WebFetch' || tool === 'WebSearch') return '◍'
  if (tool === 'Agent' || tool === 'Task') return '◈'
  return '●'
}
