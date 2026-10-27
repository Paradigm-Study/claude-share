// Drawings for the engine that's running. Claude Code 2.1.299 draws a type
// scale (`Text` `size`, `weight`, `mono`, `tabular`) and named spacing
// (`gap="sm"`); 2.1.295 refuses a whole tree that holds any of them and draws
// its own in its place. So everything is drawn for the newer engine and, on
// an older one, passed through `fit`, which says the same thing in what that
// engine knows: a heavy weight as `bold`, the rest left out, steps as cells.
// The engine's version is in the environment it gives the plugin
// (`AI_AGENT=claude-code_2-1-299_agent`).

/** The first engine with the type scale and named spacing. */
export const MODERN = [2, 1, 299] as const

/** `claude-code_2-1-299_agent` → [2, 1, 299]; null when it says no version. */
export function engineVersion(agent: string | undefined): number[] | null {
  const m = /claude-code_(\d+)-(\d+)-(\d+)/.exec(agent ?? '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Whether the engine draws the type scale and named spacing. */
export function isModern(agent: string | undefined): boolean {
  const v = engineVersion(agent)
  if (!v) return false
  for (let i = 0; i < 3; i++) if (v[i] !== MODERN[i]) return v[i]! > MODERN[i]!
  return true
}

// Named steps as cells, for an engine that counts only cells.
const STEP: Record<string, number> = { xs: 0, sm: 1, md: 1, lg: 2, xl: 3 }
const SPACE = [
  'gap',
  'columnGap',
  'rowGap',
  'margin',
  'marginX',
  'marginY',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'padding',
  'paddingX',
  'paddingY',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
]
const TYPE = new Set(['size', 'weight', 'mono', 'tabular', 'dir'])

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] } & Record<string, unknown>

/** The tree as an engine before 2.1.299 draws it; unchanged when `modern`. */
export function fit<T>(tree: T, modern: boolean): T {
  if (modern) return tree
  return down(tree) as T
}

function down(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(down)
  if (!node || typeof node !== 'object') return node
  const n = node as Node
  // The engine's own drawing, held by reference: as it came.
  if (n.type === 'engine') return node
  const props = n.props ? { ...n.props } : undefined
  if (props) {
    if (n.type === 'Text') {
      const weight = props.weight
      for (const k of TYPE) delete props[k]
      if ((weight === 'semibold' || weight === 'bold') && props.bold === undefined) props.bold = true
    }
    for (const k of SPACE) {
      const v = props[k]
      if (typeof v === 'string') props[k] = STEP[v] ?? 1
    }
  }
  return { ...n, ...(props ? { props } : {}), ...(n.children ? { children: n.children.map(down) } : {}) }
}
