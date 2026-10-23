// Paths a guest's tool call touches, checked against the host's project.

// The paths a read tool's call names, absolute, with `.` and `..` worked out
// as written, or null when one is outside the project as written: absolute
// elsewhere, climbing out, or `~`. A Glob's pattern counts up to its first
// wildcard, from the folder it's given, and one that climbs (`..`) after a
// wildcard is outside: `**` can stand for no folder at all. Every other path
// is a name as it is, whatever characters it holds. Links are the caller's
// to follow (`readsInsideReally`): as written, a link in the project names a
// place in it, and a path climbing back out of one (`notes/../x`) goes on
// from where the link points, so that one is given as written too.
export function readTargets(tool: string, input: Record<string, unknown>, cwd: string): string[] | null {
  const root = cwd.replace(/\/+$/, '')
  const named = (p: unknown): p is string => typeof p === 'string' && p.length > 0
  // A path's names as written, absolute: a pattern's up to its first wildcard.
  const names = (p: string, from: string, pattern: boolean): string[] | null => {
    const all = (p.startsWith('/') ? p : `${from}/${p}`).split('/').filter(part => part && part !== '.')
    const first = pattern ? all.findIndex(part => /[*?[{]/.test(part)) : -1
    if (first < 0) return all
    return all.slice(first).some(part => part.includes('..')) ? null : all.slice(0, first)
  }
  // Worked out as written: `..` takes the name before it.
  const lexical = (list: readonly string[]) => {
    const parts: string[] = []
    for (const part of list) {
      if (part === '..') parts.pop()
      else parts.push(part)
    }
    return `/${parts.join('/')}`
  }
  const inside = (full: string) => full === root || full.startsWith(`${root}/`)
  const given: { path: string; from: string; pattern: boolean }[] = [input.file_path, input.notebook_path, input.path].filter(named).map(path => ({ path, from: root, pattern: false }))
  if (tool === 'Glob' && named(input.pattern)) given.push({ path: input.pattern, from: named(input.path) ? lexical(names(input.path, root, false)!) : root, pattern: true })
  const out: string[] = []
  for (const { path, from, pattern } of given) {
    if (path.startsWith('~') || path.includes('\n')) return null
    const list = names(path, from, pattern)
    if (!list || !inside(lexical(list))) return null
    out.push(lexical(list))
    if (list.includes('..')) out.push(`/${list.join('/')}`)
  }
  return out
}

// A guest's read runs without asking only inside this project: a share link
// can be forwarded, and ~/.ssh is one Read away. Paths are the ones the read
// tools take; anything relative climbing out, or absolute elsewhere, asks.
export const readsInside = (tool: string, input: Record<string, unknown>, cwd: string): boolean => readTargets(tool, input, cwd) !== null

// Whether every real path (links followed) is the project's real folder or in it.
export const realInside = (root: string, paths: readonly string[]): boolean => {
  const top = root.replace(/\/+$/, '')
  return paths.every(p => p === top || p.startsWith(`${top}/`) || (top === '' && p.startsWith('/')))
}
