// Hooks (module.register): `cloudflare:workers` is this folder's stand-in, and
// the server's TypeScript loads on a Node without type stripping (Node 20),
// its types removed by the TypeScript the repository installs. A Node that
// strips types itself loads it as it is.
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: new URL('./cloudflare-workers.mjs', import.meta.url).href, shortCircuit: true }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (process.features.typescript || !url.startsWith('file:') || !url.endsWith('.ts')) return next(url, context)
  const { default: ts } = await import('typescript')
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL(url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    fileName: url,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
  })
  return { format: 'module', source: outputText, shortCircuit: true }
}
