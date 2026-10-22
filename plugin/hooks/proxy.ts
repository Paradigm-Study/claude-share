// The public link's HTTP, as the host's plugin does it: what a guest's
// browser asks reaches this machine's localhost as from the preview's own
// page, and the answer goes back to the room (POST proxy/<id>). Pure; the
// shell around it is register.tsx's (answerProxy).

/** The most of one response the host fetches for the link (curl's max-filesize), under the room's 20 MiB. */
export const PROXY_FETCH_MAX = 20_000_000

/** An answer's first line at most, in bytes: the room reads no further for its newline. */
export const PROXY_HEAD_MAX = 64 * 1024

// A header's name as HTTP spells one (RFC 9110 token).
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * An answer's head, `{"status":N,"headers":[["name","value"],…]}`, for what
 * curl fetched: the header lines of the last response in what `-D` wrote
 * (base64; a 100 Continue or an early hint comes before it). A header is
 * bytes: a value keeps them as they came, one character a byte, and the
 * line goes out as ASCII (past it, \u00XX), so the room's strict UTF-8
 * reading takes whatever the app sent and hands the same bytes on. A folded
 * or broken line, or one no Headers would take, is left out. Null when
 * there's no response in it, or its status isn't one a browser can be
 * given; whether it fits the room's PROXY_HEAD_MAX is the caller's to say.
 */
export function proxyHead(status: number, dump: string): string | null {
  let raw: string
  try {
    raw = atob(dump)
  } catch {
    return null
  }
  const last = raw.split(/\r?\n\r?\n/).filter(b => /^HTTP\/\S+ \d{3}/.test(b.trimStart())).at(-1)
  if (last === undefined || !Number.isInteger(status) || status < 200 || status > 599) return null
  const headers: [string, string][] = []
  for (const line of last.trimStart().split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const name = line.slice(0, i)
    const value = line.slice(i + 1).replace(/^[ \t]+|[ \t]+$/g, '')
    if (TOKEN.test(name) && !/[\0\r\n]/.test(value)) headers.push([name, value])
  }
  return JSON.stringify({ status, headers }).replace(/[\u007f-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** The head for one of the plugin's own pages (`proxyPage`). */
export const pageHead = (status: number) => JSON.stringify({ status, headers: [['content-type', 'text/html; charset=utf-8']] })

const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A page the link answers with in the app's place (busy, too large, nothing answering), drawn as the room draws its own. */
export function proxyPage(title: string, text: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;font-family:-apple-system,Helvetica,sans-serif;background:#faf8f7;color:#011121"><div style="max-width:420px;padding:24px;text-align:center"><h1 style="font-weight:400;font-size:26px">${html(title)}</h1><p style="color:#4b5563">${html(text)}</p></div>`
}

/**
 * A request's headers as the host's localhost gets them. The browser's
 * Origin and Referer name the preview's own local address (`local`,
 * http(s)://localhost:P; a Referer keeps its path and query), as the link's
 * WebSockets already do, so an app that checks Origin against Host (Next.js
 * server actions, Django, Rails, SvelteKit, Astro) takes its own pages'
 * forms. That hands CSRF protection to the room's gateway: its cookie
 * (cs_pv) is host-only and SameSite=Lax, so no other site's request carries
 * it, and without it nothing reaches the host. An opaque origin (`null`) the
 * browser chose stays one.
 */
export function localHeaders(headers: readonly unknown[], local: string): [string, string][] {
  const out: [string, string][] = []
  for (const h of headers) {
    if (!Array.isArray(h) || typeof h[0] !== 'string' || typeof h[1] !== 'string') continue
    const name: string = h[0], value: string = h[1]
    const n = name.toLowerCase()
    if (n === 'origin' && value !== 'null') out.push([name, local])
    else if (n === 'referer') out.push([name, localReferer(value, local)])
    else out.push([name, value])
  }
  return out
}

function localReferer(value: string, local: string): string {
  try {
    const url = new URL(value)
    return `${local}${url.pathname}${url.search}`
  } catch {
    return `${local}/`
  }
}

/** A value in a curl config file's double quotes, every character kept (a body sent as `data-binary`). */
export const curlString = (value: string) =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/\v/g, '\\v')}"`
