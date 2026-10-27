// Previews, the pure parts both sides use: a preview's address as the host
// gave it (its spelling of localhost, its scheme, its path), what a page uses
// beside it (a dependency) and how that's named, and what the host's
// discovery found. Labels from outside (a process's, a person's) are made
// safe to show here too.

/** The host's own spelling of its loopback address, kept so the window opens exactly that origin. */
export type PreviewHost = 'localhost' | '127.0.0.1' | '[::1]'
/** A port discovery found, what runs there, and (where discovery says) the process listening. */
export type DiscoveredService = { port: number; label: string; web: 'yes' | 'slow' | 'no'; devtools: boolean; pid?: number }
export type Discovered = { platform: string; target: DiscoveredService | null; related: DiscoveredService[] }

/** A TCP port: 1 to 65535. */
export const isPort = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535

/** What a label from outside may not carry: control and direction characters (used with `replace`). */
export const CONTROL = /[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩]/g

/** A loopback host as the host wrote it; 0.0.0.0 (listening everywhere) is opened as localhost. */
export function previewHost(hostname: unknown): PreviewHost | undefined {
  const h = typeof hostname === 'string' ? hostname.toLowerCase() : ''
  if (h === 'localhost' || h === '0.0.0.0') return 'localhost'
  if (h === '127.0.0.1') return '127.0.0.1'
  if (h === '[::1]' || h === '::1') return '[::1]'
  return undefined
}

/** The host of a loopback address in a URL as it was given. */
export function urlHost(url: string): PreviewHost | undefined {
  return previewHost(/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/]|$)/i.exec(url.trim())?.[1])
}

/** A URL's scheme when it's https (a preview's absent scheme is http). */
export function urlScheme(url: string): 'https' | undefined {
  return /^https:\/\//i.test(url.trim()) ? 'https' : undefined
}

/** A preview's `scheme` as an artifact carries it: https, else absent (http). */
export const previewScheme = (value: unknown): 'https' | undefined => (value === 'https' ? 'https' : undefined)

/** The host's exact address for a preview: what the window opens. */
export function previewUrl(host: string | undefined, port: number, path?: string, scheme?: string): string {
  const at = typeof path === 'string' && path.startsWith('/') && !/[\x00-\x20\\]/.test(path) ? path : '/'
  return `${previewScheme(scheme) ?? 'http'}://${previewHost(host) ?? 'localhost'}:${port}${at}`
}

/** A label a process gave itself, safe to show in a row: no control or direction characters, short. */
export function cleanLabel(label: unknown, max = 40): string {
  return typeof label === 'string' ? label.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function serviceOf(value: unknown): DiscoveredService | null {
  const s = value as Partial<DiscoveredService> | null
  if (!s || typeof s !== 'object' || !isPort(s.port)) return null
  const web = s.web === 'yes' || s.web === 'slow' || s.web === 'no' ? s.web : 'no'
  const pid = typeof s.pid === 'number' && Number.isSafeInteger(s.pid) && s.pid > 0 ? { pid: s.pid } : {}
  return { port: s.port, label: cleanLabel(s.label), web, devtools: s.devtools === true, ...pid }
}

/** What discovery printed, checked: the shared port's own service, and the web services beside it (six at most). */
export function discoverResult(line: string): Discovered | null {
  let v: Record<string, unknown>
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || v.state !== 'done') return null
  const related = (Array.isArray(v.related) ? v.related : []).map(serviceOf).filter((s): s is DiscoveredService => Boolean(s) && s!.web !== 'no' && !s!.devtools)
  const seen = new Set<number>()
  return {
    platform: typeof v.platform === 'string' ? v.platform : 'unsupported',
    target: v.target ? serviceOf(v.target) : null,
    related: related.filter(s => !seen.has(s.port) && Boolean(seen.add(s.port))).slice(0, 6),
  }
}

/**
 * What discovery's owner mode printed for `port`, checked: true when one of
 * the plugin's own helpers holds it (a guest's listener for another shared
 * session's preview, a preview window's proxy), false when something else or
 * nothing of this user's listens there, undefined when it can't tell (an
 * unsupported platform, a holder it couldn't read, anything else it said).
 */
export function relayedResult(line: string, port: number): boolean | undefined {
  let v: { state?: unknown; platform?: unknown; target?: { port?: unknown; relay?: unknown } | null }
  try {
    v = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!v || typeof v !== 'object' || v.state !== 'done' || typeof v.platform !== 'string' || v.platform === 'unsupported') return undefined
  if (v.target === null) return false
  if (!v.target || typeof v.target !== 'object' || v.target.port !== port) return undefined
  return typeof v.target.relay === 'boolean' ? v.target.relay : undefined
}

/**
 * What owner mode with `web` printed for `port` (a guest's need's look),
 * checked: what runs there, whether it answers HTTP or is a debugger, and
 * whether one of the plugin's own helpers holds it (`relay`, as
 * `relayedResult` reads it: undefined when it can't tell). Null when
 * nobody listens there, or it can't tell anything.
 */
export type HeldPort = DiscoveredService & { relay?: boolean }
export function heldResult(line: string, port: number): HeldPort | null {
  let v: { state?: unknown; target?: { port?: unknown } | null }
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  const service = v && typeof v === 'object' && v.state === 'done' && v.target?.port === port ? serviceOf(v.target) : null
  if (!service) return null
  const relay = relayedResult(line, port)
  return relay === undefined ? service : { ...service, relay }
}

/**
 * What a look at a port's `/` says of sharing it through its link
 * (`pageProbe`'s output: `exit=`, `code=<status> <content type>`, then, after
 * `--`, what `/json/version` answered). `page`: share it. `not`: never (a
 * debugger; an answer that isn't HTTP, a database or a cache; for a mention,
 * an answer that isn't a page: an API's JSON, its 404). `later`: not now, a
 * later mention looks again (nothing there yet, or a server error). A dev
 * server still compiling its first page holds the connection (curl's 28,
 * no status): a page. One Claude `opened` in the browser is shared whatever
 * it answers, but a debugger or a non-HTTP answer.
 */
export type PageLook = 'page' | 'not' | 'later'
export function pageLook(out: string, opened = false): PageLook {
  const exit = /^exit=(\d+)$/m.exec(out)?.[1]
  const answer = /^code=(\d{3}) ?(.*)$/m.exec(out)
  const code = Number(answer?.[1] ?? 0)
  const type = (answer?.[2] ?? '').split(';')[0]!.trim().toLowerCase()
  if (exit === undefined) return opened ? 'page' : 'later'
  if (exit === '6' || exit === '7') return opened ? 'page' : 'later'
  if (!code) return exit === '28' ? 'page' : 'not'
  if (debuggerAnswer(out.split(/^--$/m)[1] ?? '')) return 'not'
  if (opened || (code >= 300 && code < 400)) return 'page'
  if ((code === 401 || (code >= 200 && code < 300)) && (type === 'text/html' || type === 'application/xhtml+xml')) return 'page'
  return code >= 500 ? 'later' : 'not'
}

/** A `/` that's an HTML 404 (an app mounted at a base path, or an API's "Cannot GET /"): the page Claude gave out is looked at too. */
export function rootMissing(out: string): boolean {
  const answer = /^code=(\d{3}) ?(.*)$/m.exec(out)
  return answer?.[1] === '404' && /^(text\/html|application\/xhtml\+xml)\b/i.test((answer[2] ?? '').trim())
}

/** Chrome's `/json/version` names its socket; Node's and Deno's inspectors name a protocol (discover.mts's `devtoolsBody`). */
export function debuggerAnswer(text: string): boolean {
  let row: unknown
  try {
    row = JSON.parse(text)
  } catch {
    return false
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  const r = row as Record<string, unknown>
  return typeof r.webSocketDebuggerUrl === 'string' || (typeof r.Browser === 'string' && typeof r['Protocol-Version'] === 'string')
}

/** A preview's `dependency` as an artifact carries it: the host port of the page that uses it, or true when that page isn't known. */
export function dependencyOf(value: unknown): number | true | undefined {
  return value === true ? true : isPort(value) ? value : undefined
}

/** A dependency's title: its address first, then what runs there ("localhost:3610 (convex-local-backend)"). */
export const dependencyTitle = (port: number, label?: string) => `localhost:${port}${label ? ` (${label})` : ''}`

/** Whose it is: "for the preview of localhost:3000", or "for previews" when that page isn't known. */
export const dependencyFor = (dependency: number | true) => (dependency === true ? 'for previews' : `for the preview of localhost:${dependency}`)

/** "localhost:3610 · convex-local-backend" */
export const serviceName = (s: { port: number; label?: string }) => `localhost:${s.port}${s.label ? ` · ${s.label}` : ''}`

/** Every one of them, in a sentence: "a", "a and b", "a, b and c". */
export const everyName = (names: readonly string[]) => (names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join(' and '))

/**
 * What discovery found, by service: one process (its pid, where discovery
 * says), else one label (discovery looks in one project for them all). A
 * port with no label, or one discovery couldn't name, is a service alone.
 * In the order found.
 */
export function servicesOf<T extends { port: number; label?: string; pid?: number }>(found: readonly T[]): T[][] {
  const by = new Map<string, T[]>()
  for (const s of found) {
    const key = s.pid !== undefined ? `pid ${s.pid}` : s.label && s.label !== 'unknown' ? `label ${s.label}` : `port ${s.port}`
    by.set(key, [...(by.get(key) ?? []), s])
  }
  return [...by.values()]
}

/**
 * Services in a sentence, each its ports first and then what runs there
 * (`labels`): "localhost:3510 and 3511 · convex-local-backend". A comma
 * comes before the last "and" once a service has several ports.
 */
export function everyService(services: readonly (readonly { port: number; label?: string }[])[], labels = true): string {
  const names = services.map(service => `localhost:${everyName(service.map(s => String(s.port)))}${labels && service[0]?.label ? ` · ${service[0].label}` : ''}`)
  return names.length > 1 && services.some(service => service.length > 1) ? `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}` : everyName(names)
}

/**
 * Every one of them by name, by service, each service's ports before its
 * label: what /share-preview's reply says it found. "localhost:3510 and
 * 3511 · convex-local-backend, and localhost:5432 · postgres".
 */
export const alsoUses = (related: readonly { port: number; label?: string; pid?: number }[]) => everyService(servicesOf(related))

/**
 * The most ports one question names. The row above the prompt gives its
 * words 41 columns in an 80-column terminal (80, less the engine's 5 at its
 * right end, the row's own 4 there, its 2 before the buttons, `[ Share too ]`
 * and `Not now` with 1 between them, and `● Live` with 1 after it), and
 * three five-digit ports and what comes before them take 38 ("Share
 * localhost:35100, 35101 and 35102").
 */
export const ASK_PORTS = 3

/**
 * The questions asking about these services: a service a question, or, on
 * more than ASK_PORTS ports, a question each ASK_PORTS of them, in order,
 * one after another.
 */
export function questionsOf<T>(services: readonly (readonly T[])[]): T[][] {
  return services.flatMap(service => Array.from({ length: Math.ceil(service.length / ASK_PORTS) }, (_, i) => service.slice(i * ASK_PORTS, (i + 1) * ASK_PORTS)))
}

/**
 * The row's question about what a page uses beside it: first every port its
 * yes forwards, then what runs there and the page, so a row too narrow cuts
 * those, never a port. "Share localhost:3510 and 3511 too?
 * convex-local-backend, beside localhost:3009"; with nothing to call it,
 * "Share localhost:4000 too? Found beside localhost:3009".
 */
export function shareTooWords(page: number, related: readonly { port: number; label?: string }[]): string {
  const labels = [...new Set(related.map(s => s.label ?? '').filter(label => label && label !== 'unknown'))]
  return `Share localhost:${everyName(related.map(s => String(s.port)))} too? ${labels.length ? `${everyName(labels)}, beside` : 'Found beside'} localhost:${page}`
}
