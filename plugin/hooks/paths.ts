// Paths a guest's tool call touches, checked against the host's project.

// A guest's read runs without asking only inside this project: a share link
// can be forwarded, and ~/.ssh is one Read away. Paths are the ones the read
// tools take; anything relative climbing out, or absolute elsewhere, asks.
export function readsInside(tool: string, input: Record<string, unknown>, cwd: string): boolean {
  const paths = [input.file_path, input.notebook_path, input.path, tool === 'Glob' ? input.pattern : undefined].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  )
  const root = cwd.replace(/\/+$/, '')
  return paths.every(p => {
    if (p.startsWith('~')) return false
    const parts: string[] = []
    for (const part of (p.startsWith('/') ? p : `${root}/${p}`).split('/')) {
      if (part === '..') parts.pop()
      else if (part && part !== '.') parts.push(part)
    }
    const full = `/${parts.join('/')}`
    return full === root || full.startsWith(`${root}/`)
  })
}
