// How a shared session looks. People are monochrome dots: ink on a light
// theme, near-white on a dark one, a person's initial knocked out of theirs;
// the dot breathes while Claude works for that person, and goes hollow when
// they are away. The rest borrows Paradigm's landing page: paper and ink, the
// window frame with its three muted dots, mono eyebrows, a serif title, and
// Clover on the window's edge.
//
// The Desktop app draws these as images: transparent, animated, and styled
// for light and dark under `prefers-color-scheme`, which follows the app's
// theme. (Not `isInteractive`: that sandboxed frame paints an opaque page
// behind the art, a white box on a dark theme.) Pure: strings in, strings out.

import { CLOVER_WEBP } from './brand'

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

// Paradigm's landing tokens, light and dark (the landing page itself is light).
export const INK = '#011121'
export const PAPER = '#faf8f7'
export const ACCENT = '#6e94cc' // reads on both themes
export const ROSE = '#dd7f77' // the window's red dot; "live"
export const SAGE = '#799586'
export const SAND = '#d2b99f'
export const GOOD = '#5c9a6a' // allowed, on both themes
export const BAD = '#d0776b' // declined, on both themes

const FONT = `-apple-system,"Geist","SF Pro Text","Segoe UI",Inter,sans-serif`
const SERIF = `"Gowun Batang","Iowan Old Style",Georgia,serif`
const MONO = `"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace`

/** One letter for one word, two for two: "Sam" → S, "Alex Chen" → AC. */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean)
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
    const words = n.trim().split(/[\s._-]+/).filter(Boolean)
    if (words.length >= 2) out.set(n, `${words[0]![0]}${words[1]![0]}`.toUpperCase())
    else if ((counts.get(first(n)) ?? 0) > 1) out.set(n, `${first(n)}${(words[0] ?? '').slice(1, 2).toLowerCase()}`)
    else out.set(n, first(n))
  }
  return out
}

export type Face = { name: string; online: boolean; note?: string; active?: boolean; label?: string }

const DOTS = `<style>
.dot{fill:${INK}}.ini{fill:#fff}.away .dot{fill:none;stroke:${INK}}.away .ini{fill:${INK}}.more{fill:#8a8f96}
@media (prefers-color-scheme: dark){.dot{fill:#ececec}.ini{fill:${INK}}.away .dot{stroke:#ececec}.away .ini{fill:#ececec}.more{fill:#9aa0a6}}
.face{transform-box:fill-box;transform-origin:center;transition:transform .22s cubic-bezier(.22,1,.36,1)}
.face:hover{transform:scale(1.1)}
.breathe .dot{transform-box:fill-box;transform-origin:center;animation:breathe 1.9s cubic-bezier(.45,0,.55,1) infinite}
@keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.14)}}
.live{transform-box:fill-box;transform-origin:center;animation:live 2s ease-out infinite}
@keyframes live{0%{transform:scale(.6);opacity:.55}100%{transform:scale(2);opacity:0}}
</style>`

function face(f: Face, cx: number, cy: number, r: number): string {
  const classes = ['face', f.active ? 'breathe' : '', f.online ? '' : 'away'].filter(Boolean).join(' ')
  const letters = f.label ?? initials(f.name)
  const size = letters.length > 1 ? r * 0.78 : r * 0.95
  return `<g class="${classes}"><title>${esc(f.name)}${f.note ? ` · ${esc(f.note)}` : ''}</title><circle class="dot" cx="${cx}" cy="${cy}" r="${f.online ? r : r - 0.8}" stroke-width="1.5"/><text class="ini" x="${cx}" y="${cy}" dy=".36em" text-anchor="middle" font-family='${FONT}' font-size="${size.toFixed(1)}" font-weight="650">${esc(letters)}</text></g>`
}

/** One person's dot, `size` CSS pixels square. */
export function avatarSvg(f: Face, size = 22): string {
  const r = size / 2 - 1.5
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${DOTS}${face(f, size / 2, size / 2, r)}</svg>`
}

/**
 * The room at a glance: a live mark, then a row of dots (at most `max`, then
 * "+N"). Returns the markup and its width.
 */
export function stackSvg(faces: readonly Face[], opts: { live: boolean; size?: number; max?: number }): { source: string; width: number } {
  const size = opts.size ?? 22
  const r = size / 2 - 2
  const gap = 5
  const shown = faces.slice(0, opts.max ?? 6)
  const extra = faces.length - shown.length
  const lead = 16
  const cy = size / 2
  const width = Math.ceil(lead + shown.length * (r * 2 + gap) + (extra > 0 ? 22 : 0))
  const live = opts.live
    ? `<g><title>Live</title><circle class="live" cx="5" cy="${cy}" r="4" fill="${ROSE}"/><circle cx="5" cy="${cy}" r="3.2" fill="${ROSE}"/></g>`
    : `<circle cx="5" cy="${cy}" r="3.2" fill="#9aa0a6"/>`
  const dots = shown.map((f, i) => face(f, lead + r + i * (r * 2 + gap), cy, r)).join('')
  const more =
    extra > 0
      ? `<text class="more" x="${lead + shown.length * (r * 2 + gap) + 1}" y="${cy}" dy=".36em" font-family='${FONT}' font-size="11" font-weight="600"><title>${extra} more</title>+${extra}</text>`
      : ''
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${size}" viewBox="0 0 ${width} ${size}">${DOTS}${live}${dots}${more}</svg>`,
    width,
  }
}

/**
 * The Room panel's banner, as Paradigm's landing window: a paper card with a
 * hairline edge, the three muted dots and a mono label in its bar, the host's
 * dot, a serif title, and Clover perched on the frame. Dark: ink card.
 */
export function bannerSvg(o: { title: string; host: string; live: boolean; detail: string; status?: string; width?: number }): string {
  const w = o.width ?? 420
  const top = 30 // room above the frame for Clover
  const h = top + 108
  const fit = (text: string, px: number, size: number) => {
    const max = Math.floor(px / (size * 0.55))
    return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text
  }
  const title = fit(o.title, w - 70 - 20, 16)
  const detail = fit(o.detail, w - 70 - 20, 12)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<style>
.card{fill:#fffdfc;stroke:#dde1e7}.bar{stroke:#dde1e7}.grid{fill:${INK};fill-opacity:.05}.title{fill:${INK}}.detail{fill:#4b5563}.label{fill:#2c4a7b}.wash{fill:#e4ecf7}
${DOTS.replace(/^<style>|<\/style>$/g, '')}
@media (prefers-color-scheme: dark){.card{fill:#0b1726;stroke:#223247}.bar{stroke:#223247}.grid{fill:#ffffff;fill-opacity:.06}.title{fill:${PAPER}}.detail{fill:#9aa3ad}.label{fill:#b9cdeb}.wash{fill:#1b2b43}.cat{filter:url(#night)}}
</style>
<defs><filter id="night" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="-1 0 0 0 1 0 -1 0 0 1 0 0 -1 0 1 0 0 0 .9 0"/></filter>
<pattern id="g" width="14" height="14" patternUnits="userSpaceOnUse"><circle class="grid" cx="2" cy="2" r="1"/></pattern>
<clipPath id="c"><rect x=".5" y="${top + 0.5}" width="${w - 1}" height="${h - top - 1}" rx="7"/></clipPath></defs>
<rect class="card" x=".5" y="${top + 0.5}" width="${w - 1}" height="${h - top - 1}" rx="7"/>
<g clip-path="url(#c)"><rect x="0" y="${top + 34}" width="${w}" height="${h}" fill="url(#g)"/></g>
<line class="bar" x1="1" y1="${top + 34}" x2="${w - 1}" y2="${top + 34}"/>
<circle cx="18" cy="${top + 17}" r="4.5" fill="${ROSE}"/><circle cx="32" cy="${top + 17}" r="4.5" fill="${SAND}"/><circle cx="46" cy="${top + 17}" r="4.5" fill="${SAGE}"/>
<rect class="wash" x="62" y="${top + 8}" rx="9" width="132" height="18"/>
<text class="label" x="72" y="${top + 21}" font-family='${MONO}' font-size="9.5" font-weight="600" letter-spacing="1.2">SHARED SESSION</text>
${
  o.live
    ? `<g><circle class="live" cx="${w - 52}" cy="${top + 17}" r="4" fill="${ROSE}"/><circle cx="${w - 52}" cy="${top + 17}" r="3.2" fill="${ROSE}"/><text x="${w - 43}" y="${top + 21}" font-family='${MONO}' font-size="10" font-weight="700" letter-spacing="1.2" fill="${ROSE}">LIVE</text></g>`
    : `<text class="detail" x="${w - 16}" y="${top + 21}" text-anchor="end" font-family='${MONO}' font-size="10" font-weight="700" letter-spacing="1.2">${esc(o.status ?? 'ENDED')}</text>`
}
${face({ name: o.host, online: true }, 36, top + 71, 15)}
<text class="title" x="62" y="${top + 67}" font-family='${SERIF}' font-size="16.5">${esc(title)}</text>
<text class="detail" x="62" y="${top + 87}" font-family='${FONT}' font-size="12">${esc(detail)}</text>
<image class="cat" href="${CLOVER_WEBP}" x="${w - 118}" y="0" width="92" height="${top + 10}" preserveAspectRatio="xMidYMax meet"/>
</svg>`
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
