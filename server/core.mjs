import { CLOVER_WEBP, LOGO_PATHS } from './brand.mjs'

// Room logic shared by the Node server (node.mjs) and the Cloudflare Durable
// Object (worker.mjs). Everything speaks the Fetch API: a Request in, a
// Response out, so both hosts route into the same functions.
//
// A room is one shared Claude Code session. The host's session posts what its
// transcript keeps (rows), live text (deltas) and turn state; guests post
// prompts and stop requests; everyone long-polls `events?after=<seq>`.

const HISTORY_LIMIT = 5000 // replayable events kept per room
const LIVE_LIMIT = 400 // ephemeral events (deltas) kept for pollers only
const SEAT_TIMEOUT_MS = 45_000 // a seat that has not polled for this long left
const POLL_WAIT_MS = 20_000
const MAX_TEXT = 32_000 // chars; keeps one stored event under the Durable Object value limit
const MAX_BODY = 512_000

// What each seat may post. `chat` is the room's side channel: people talk,
// Claude never reads it. `policy` is the host's say over what guests may do;
// `declined` answers a guest prompt the host's policy turned away.
const HOST_TYPES = new Set(['row', 'delta', 'turn', 'approval', 'title', 'policy', 'declined', 'chat'])
const GUEST_TYPES = new Set(['prompt', 'stop', 'chat'])
const LIVE_TYPES = new Set(['delta'])

export const ROOM_ID = /^[A-Za-z0-9_-]{16,64}$/

export function token(bytes = 16) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...raw))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

const clampName = name => String(name ?? '').trim().slice(0, 40) || 'teammate'

function clampBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {}
  const out = {}
  for (const [k, v] of Object.entries(body)) {
    out[k] = typeof v === 'string' && v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}\n…(cut)` : v
  }
  return out
}

export class Room {
  constructor(data) {
    this.id = data.id
    this.title = data.title
    this.host = data.host // { name, token, lastSeen }
    this.createdAt = data.createdAt
    this.endedAt = data.endedAt ?? null
    this.seq = data.seq ?? 0
    this.events = data.events ?? []
    this.seats = new Map(Object.entries(data.seats ?? {}))
    this.live = []
    this.waiters = new Set()
  }

  static create({ id, name, title, now }) {
    return new Room({
      id,
      title: String(title ?? '').trim().slice(0, 120) || 'Claude Code session',
      host: { name: clampName(name), token: token(24), lastSeen: now },
      createdAt: now,
    })
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      host: this.host,
      createdAt: this.createdAt,
      endedAt: this.endedAt,
      seq: this.seq,
      events: this.events,
      seats: Object.fromEntries(this.seats),
    }
  }

  auth(bearer) {
    if (!bearer) return null
    if (bearer === this.host.token) return { role: 'host', seat: 'host', name: this.host.name }
    const seat = this.seats.get(bearer)
    return seat ? { role: 'guest', seat: seat.id, name: seat.name } : null
  }

  touch(auth, now) {
    if (auth.role === 'host') this.host.lastSeen = now
    else for (const seat of this.seats.values()) if (seat.id === auth.seat) seat.lastSeen = now
  }

  people(now) {
    const online = t => !this.endedAt && now - t < SEAT_TIMEOUT_MS
    return [
      { id: 'host', name: this.host.name, role: 'host', online: online(this.host.lastSeen) },
      ...[...this.seats.values()].map(s => ({ id: s.id, name: s.name, role: 'guest', online: true })),
    ]
  }

  append(from, type, body, now) {
    const event = { seq: ++this.seq, type, from, ts: now, body: clampBody(body) }
    if (LIVE_TYPES.has(type)) {
      this.live.push(event)
      if (this.live.length > LIVE_LIMIT) this.live.splice(0, this.live.length - LIVE_LIMIT)
    } else {
      this.events.push(event)
      if (this.events.length > HISTORY_LIMIT) this.events.splice(0, this.events.length - HISTORY_LIMIT)
    }
    return event
  }

  wake() {
    for (const waiter of [...this.waiters]) {
      if (this.seq > waiter.after) waiter.done()
    }
  }

  since(after) {
    const pick = list => list.filter(e => e.seq > after)
    return [...pick(this.events), ...pick(this.live)].sort((a, b) => a.seq - b.seq)
  }

  wait(after, ms) {
    if (this.seq > after || this.endedAt) return Promise.resolve()
    return new Promise(resolve => {
      const waiter = {
        after,
        done: () => {
          clearTimeout(waiter.timer)
          this.waiters.delete(waiter)
          resolve()
        },
      }
      waiter.timer = setTimeout(waiter.done, ms)
      this.waiters.add(waiter)
    })
  }

  join(name, now) {
    const seatToken = token(24)
    const seat = { id: token(6), name: clampName(name), joinedAt: now, lastSeen: now }
    this.seats.set(seatToken, seat)
    this.append({ seat: seat.id, name: seat.name, role: 'guest' }, 'join', {}, now)
    this.wake()
    return { token: seatToken, seat }
  }

  leave(bearer, reason, now) {
    const seat = this.seats.get(bearer)
    if (!seat) return
    this.seats.delete(bearer)
    this.append({ seat: seat.id, name: seat.name, role: 'guest' }, 'leave', { reason }, now)
    this.wake()
  }

  // Drops seats that stopped polling; returns whether anything changed.
  sweep(now) {
    let changed = false
    for (const [bearer, seat] of [...this.seats]) {
      if (now - seat.lastSeen > SEAT_TIMEOUT_MS) {
        this.leave(bearer, 'timeout', now)
        changed = true
      }
    }
    return changed
  }

  end(now) {
    if (this.endedAt) return
    this.endedAt = now
    this.append({ seat: 'host', name: this.host.name, role: 'host' }, 'ended', {}, now)
    this.wake()
  }
}

// ---------------------------------------------------------------------------
// HTTP

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const bearerOf = req => (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()

async function readJson(req) {
  const text = await req.text()
  if (text.length > MAX_BODY) throw new Error('body too large')
  return text ? JSON.parse(text) : {}
}

export function publicOrigin(req, configured) {
  if (configured) return configured.replace(/\/+$/, '')
  const url = new URL(req.url)
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')
  return `${proto}://${host}`
}

export function shareUrl(origin, id) {
  return `${origin}/s/${id}`
}

// POST /api/rooms: the host's Share. Returns the room and the host's token.
export async function createRoom(req, id, now, origin) {
  const body = await readJson(req)
  const room = Room.create({ id, name: body.name, title: body.title, now })
  return {
    room,
    response: json({
      id: room.id,
      url: shareUrl(origin, room.id),
      token: room.host.token,
      seq: room.seq,
      title: room.title,
    }),
  }
}

// Everything under /api/rooms/:id/... and /s/:id. `changed` tells the caller
// whether to persist the room.
export async function roomRequest(room, req, rest, now, origin) {
  const method = req.method
  const url = new URL(req.url)

  if (rest === 'page' && method === 'GET') {
    return { response: landingPage(room, shareUrl(origin, room.id), now) }
  }

  if (rest === '' && method === 'GET') {
    return {
      response: json({
        id: room.id,
        title: room.title,
        host: room.host.name,
        people: room.people(now),
        ended: Boolean(room.endedAt),
      }),
    }
  }

  if (rest === 'join' && method === 'POST') {
    if (room.endedAt) return { response: json({ error: 'This session is no longer shared.' }, 410) }
    const body = await readJson(req)
    const { token: seatToken, seat } = room.join(body.name, now)
    return {
      changed: true,
      response: json({
        token: seatToken,
        seat: seat.id,
        name: seat.name,
        title: room.title,
        host: room.host.name,
        seq: room.seq,
        history: room.events,
        people: room.people(now),
      }),
    }
  }

  const auth = room.auth(bearerOf(req))
  if (!auth) return { response: json({ error: 'Not a member of this session.' }, 401) }

  if (rest === 'events' && method === 'GET') {
    const after = Number(url.searchParams.get('after') ?? 0) || 0
    const wait = Math.min(Number(url.searchParams.get('wait') ?? POLL_WAIT_MS) || 0, 25_000)
    room.touch(auth, now)
    await room.wait(after, wait)
    const at = Date.now()
    room.touch(auth, at)
    return {
      response: json({
        seq: room.seq,
        events: room.since(after),
        people: room.people(at),
        ended: Boolean(room.endedAt),
        title: room.title,
      }),
    }
  }

  if (rest === 'events' && method === 'POST') {
    if (room.endedAt) return { response: json({ error: 'This session is no longer shared.' }, 410) }
    const body = await readJson(req)
    const allowed = auth.role === 'host' ? HOST_TYPES : GUEST_TYPES
    const from = { seat: auth.seat, name: auth.name, role: auth.role }
    room.touch(auth, now)
    let changed = false
    for (const item of Array.isArray(body.events) ? body.events.slice(0, 200) : []) {
      if (!item || !allowed.has(item.type)) continue
      if (item.type === 'title' && typeof item.body?.title === 'string') {
        room.title = item.body.title.slice(0, 120)
      }
      room.append(from, item.type, item.body, now)
      if (!LIVE_TYPES.has(item.type)) changed = true
    }
    room.wake()
    return { changed, response: json({ seq: room.seq }) }
  }

  if (rest === 'leave' && method === 'POST') {
    if (auth.role === 'guest') room.leave(bearerOf(req), 'left', now)
    return { changed: true, response: json({ ok: true }) }
  }

  if (rest === 'end' && method === 'POST') {
    if (auth.role !== 'host') return { response: json({ error: 'Only the host can stop sharing.' }, 403) }
    room.end(now)
    return { changed: true, response: json({ ok: true }) }
  }

  return { response: json({ error: 'Not found' }, 404) }
}

export function notFound() {
  return json({ error: 'Not found' }, 404)
}

export function badRequest(message) {
  return json({ error: message }, 400)
}

export { json }

// ---------------------------------------------------------------------------
// The page a share link opens in a browser: hands the link to Claude Desktop
// as a new Claude Code session's prompt, where the plugin joins on Enter.

const escapeHtml = s =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function landingPage(room, url, now) {
  const deepLink = `claude://code/new?q=${encodeURIComponent(url)}`
  const data = {
    id: room.id,
    url,
    deepLink,
    title: room.title,
    host: room.host.name,
    ended: Boolean(room.endedAt),
    people: room.people(now),
  }
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  const host = escapeHtml(room.host.name)
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${host} is sharing a Claude Code session</title>
<meta name="description" content="${escapeHtml(room.title)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@500;600&family=Gowun+Batang:wght@400;700&display=swap" rel="stylesheet">
<style>
/* Paradigm's landing design (paradigm-study-web, "A School of One"): paper and
   ink, a faint dot grid, the notebook window with three muted dots, mono
   eyebrows, a serif display face, warm shadows. Dark is ours: ink paper. */
:root {
  --ink:#011121; --ink-soft:#1b2430; --muted:#4b5563; --faint:#a19f9a; --line:#dde1e7; --step-line:#d9d9d9;
  --bg:#faf8f7; --surface:#fffdfc; --accent:#6e94cc; --accent-ink:#2c4a7b; --accent-wash:#e4ecf7;
  --rose:#dd7f77; --sand:#d2b99f; --sage:#799586; --good:#2e7d32; --grid:rgba(1,17,33,.05);
  --dot:#011121; --dot-ink:#fff;
  --shadow-md:0 4px 12px -6px rgba(82,66,50,.12), 0 1px 3px rgba(82,66,50,.05);
  --shadow-lg:0 14px 38px -18px rgba(82,66,50,.16), 0 3px 8px rgba(82,66,50,.05);
  --ease:cubic-bezier(.22,1,.36,1);
  --display:"Gowun Batang","Iowan Old Style",Georgia,serif;
  --body:"Geist",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root {
  --ink:#f3f1ee; --ink-soft:#d9dde3; --muted:#a3abb5; --faint:#7d8590; --line:#223247; --step-line:#2a3a50;
  --bg:#011121; --surface:#0b1726; --accent:#8fb0e0; --accent-ink:#b9cdeb; --accent-wash:#16263d;
  --good:#6fbf7a; --grid:rgba(255,255,255,.055); --dot:#ececec; --dot-ink:#011121;
  --shadow-md:0 4px 12px -6px rgba(0,0,0,.5); --shadow-lg:0 18px 44px -18px rgba(0,0,0,.7);
  color-scheme: dark;
} }
* { box-sizing:border-box; }
html, body { margin:0; }
body { min-height:100vh; font:15px/1.5 var(--body); color:var(--ink); background-color:var(--bg);
  background-image:radial-gradient(circle, var(--grid) 1px, transparent 1.4px); background-size:22px 22px;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
a { color:inherit; text-decoration:none; }
.wrap { max-width:1120px; margin:0 auto; padding:0 40px; }
.nav { display:flex; align-items:center; justify-content:space-between; padding-top:28px; }
.brand { display:inline-flex; align-items:center; gap:11px; }
.brand svg { width:26px; height:26px; } .brand svg path { fill:var(--ink); }
.brand .word { font-family:var(--display); font-weight:700; font-size:21px; letter-spacing:-.015em; }
.brand .sub { font-family:var(--mono); font-size:11.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint); margin-left:4px; }
.live { display:inline-flex; align-items:center; gap:8px; font-family:var(--mono); font-size:11.5px; font-weight:600; letter-spacing:.14em; color:var(--rose); }
.live i { width:7px; height:7px; border-radius:50%; background:var(--rose); animation:pulse 2s var(--ease) infinite; }
.live.ended { color:var(--faint); } .live.ended i { background:var(--faint); animation:none; }
@keyframes pulse { 0% { box-shadow:0 0 0 0 rgba(221,127,119,.55); } 80%,100% { box-shadow:0 0 0 8px rgba(221,127,119,0); } }
.hero { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.05fr); gap:56px; align-items:center; padding:64px 0 88px; }
.hero > * { min-width:0; }
.eyebrow { display:inline-block; font-family:var(--mono); font-size:12px; letter-spacing:.12em; text-transform:uppercase; font-weight:500;
  color:var(--accent-ink); background:var(--accent-wash); padding:6px 13px; border-radius:999px; margin-bottom:22px; }
h1 { font-family:var(--display); font-weight:400; font-size:46px; line-height:1.08; letter-spacing:.005em; margin:0 0 18px; overflow-wrap:anywhere; text-wrap:balance; }
.sub-copy { margin:0; font-size:16px; line-height:1.55; color:var(--muted); max-width:46ch; }
.people { display:flex; align-items:center; gap:14px; margin:26px 0 0; }
.dots { display:flex; gap:5px; }
.dot { position:relative; display:grid; place-items:center; width:30px; height:30px; border-radius:50%; background:var(--dot); color:var(--dot-ink);
  font-size:12px; font-weight:650; letter-spacing:.02em; transition:transform .22s var(--ease); }
.dot.two { font-size:10.5px; }
.dot.away { background:transparent; color:var(--dot); box-shadow:inset 0 0 0 1.5px var(--dot); }
.dot:hover { transform:scale(1.1); }
.dot[data-name]:hover::after { content:attr(data-name); position:absolute; bottom:calc(100% + 8px); left:50%; transform:translateX(-50%); white-space:nowrap;
  padding:3px 8px; border-radius:6px; background:var(--ink); color:var(--bg); font-size:11px; font-weight:500; pointer-events:none; }
.count { font-size:14px; color:var(--muted); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .count b { color:var(--ink); font-weight:600; }
.cta { display:flex; align-items:center; gap:22px; margin-top:30px; }
.btn-primary { display:inline-flex; align-items:center; gap:9px; background:var(--ink); color:var(--bg); font:500 15px var(--body); padding:13px 24px; border:0;
  border-radius:.5rem; box-shadow:var(--shadow-md); cursor:pointer; transition:transform .14s var(--ease), opacity .14s; }
.btn-primary:hover { transform:translateY(-1px); opacity:.92; }
.btn-ghost { font:500 15px var(--body); color:var(--accent-ink); background:none; border:0; padding:0; cursor:pointer; transition:opacity .14s; }
.btn-ghost:hover { opacity:.6; }
.status { min-height:20px; margin:14px 0 0; font-size:13px; color:var(--faint); }
/* the notebook window */
.window { position:relative; width:100%; max-width:520px; margin:0 0 0 auto; background:var(--surface); border:1px solid var(--line); border-radius:6px; box-shadow:var(--shadow-lg); }
.cat { position:absolute; top:-50px; right:26px; width:96px; height:66px; pointer-events:none; background:url("${CLOVER_WEBP}") center bottom / contain no-repeat; }
@media (prefers-color-scheme: dark) { .cat { filter:invert(1) opacity(.9); } }
.bar { display:flex; align-items:center; gap:8px; padding:13px 16px; border-bottom:1px solid var(--line); }
.bar .d { width:11px; height:11px; border-radius:50%; } .d.r { background:var(--rose); } .d.y { background:var(--sand); } .d.g { background:var(--sage); }
.bar .label { margin-left:8px; font-family:var(--mono); font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint); }
.bar .live { margin-left:auto; }
.main { padding:28px 30px 24px; display:flex; flex-direction:column; gap:12px; }
.step { display:flex; align-items:center; gap:13px; padding:15px 17px; border-radius:4px; background:var(--bg); border:1px solid var(--step-line); border-left-width:2px;
  font-size:14px; color:var(--ink-soft); animation:stepin .5s var(--ease) both; }
.step:nth-child(2) { animation-delay:.08s; } .step:nth-child(3) { animation-delay:.16s; } .step:nth-child(4) { animation-delay:.24s; }
@keyframes stepin { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
.step .ico { flex:none; width:16px; height:16px; color:var(--muted); }
.step.done { color:var(--ink); } .step.done .ico { color:var(--good); }
.step b { font-weight:600; color:var(--ink); }
.step.go { cursor:pointer; border-color:var(--accent); background:var(--accent-wash); color:var(--ink); transition:transform .14s var(--ease), box-shadow .18s; }
.step.go:hover { transform:translateY(-1px); box-shadow:var(--shadow-md); }
.step.go .ico { color:var(--accent-ink); }
.composer { margin-top:4px; border:1px solid var(--line); border-radius:6px; background:var(--surface); padding:12px 14px; display:flex; align-items:center; gap:8px; }
.composer .slash { color:var(--faint); font-family:var(--mono); }
.composer code { flex:1; min-width:0; font:12.5px var(--mono); color:var(--ink-soft); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.composer button { flex:none; border:0; background:none; color:var(--muted); cursor:pointer; padding:2px; transition:color .15s, transform .14s var(--ease); }
.composer button:hover { color:var(--ink); transform:translateY(-1px); }
.first { margin-top:6px; font-size:13px; color:var(--muted); }
.first summary { cursor:pointer; list-style:none; color:var(--accent-ink); font-weight:500; }
.first summary::-webkit-details-marker { display:none; }
.first summary::before { content:"+ "; font-family:var(--mono); }
.first[open] summary::before { content:"– "; }
.first p { margin:8px 0; }
.first .composer { margin-top:0; }
footer { padding:0 0 40px; color:var(--faint); font-size:13px; }
footer q { font-family:var(--display); font-size:17px; color:var(--muted); quotes:"\\201C" "\\201D"; }
[hidden] { display:none !important; }
@media (max-width: 880px) { .hero { grid-template-columns:minmax(0,1fr); gap:64px; padding:40px 0 64px; } .window { margin:0 auto; } h1 { font-size:36px; } }
@media (max-width: 480px) { .wrap { padding:0 18px; } h1 { font-size:30px; } .main { padding:22px 18px 18px; } .cta { gap:16px; flex-wrap:wrap; } .brand .sub { display:none; } }
@media (prefers-reduced-motion: reduce) { * { animation:none !important; transition:none !important; } }
</style></head>
<body>
<header class="wrap nav">
  <a class="brand" href="#"><svg viewBox="0 0 500 500" aria-hidden="true">${LOGO_PATHS}</svg><span class="word">Paradigm</span><span class="sub">Shared session</span></a>
  <span class="live" id="pill"><i></i><span>LIVE</span></span>
</header>
<main class="wrap">
  <section class="hero">
    <div>
      <span class="eyebrow" id="eyebrow">${host} is sharing</span>
      <h1 id="title"></h1>
      <p class="sub-copy" id="subcopy">A live Claude Code session. Join from your own Claude Code: your prompts run in <span class="hn"></span>'s session, and everyone sees the replies as they stream.</p>
      <div class="people"><div class="dots" id="dots"></div><div class="count" id="count"></div></div>
      <div class="cta" id="cta">
        <a class="btn-primary" id="open" href="#"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>Open in Claude Code</a>
        <button class="btn-ghost" id="copy">Copy link</button>
      </div>
      <p class="status" id="status"></p>
    </div>
    <div class="window">
      <div class="cat" aria-hidden="true"></div>
      <div class="bar"><span class="d r"></span><span class="d y"></span><span class="d g"></span><span class="label">claude code · shared</span><span class="live" id="pill2"><i></i><span>LIVE</span></span></div>
      <div class="main" id="steps">
        <div class="step done"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><span><b class="hn"></b> shared this session</span></div>
        <div class="step"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/></svg><span>Opens a <b>new Claude Code session</b> with this link in the prompt box</span></div>
        <div class="step"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg><span><b>Press Enter</b> to join. The conversation so far plays back first</span></div>
        <a class="step go" id="go" href="#"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg><span><b>Open in Claude Code</b> and talk to it together</span></a>
        <div class="composer"><span class="slash">/</span><code id="link"></code><button id="copy2" title="Copy link" aria-label="Copy link"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg></button></div>
        <details class="first" id="first">
          <summary>First time? Install the plugin once</summary>
          <p>Paste this in a terminal, then start a new Claude Code session (or restart Claude Desktop):</p>
          <div class="composer"><span class="slash">$</span><code id="install"></code><button id="copy3" title="Copy command" aria-label="Copy install command"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg></button></div>
        </details>
      </div>
    </div>
  </section>
</main>
<footer class="wrap"><q>Everyone in one session, Claude in the middle.</q></footer>
<script>
(function () {
  var data = ${json};
  var $ = function (id) { return document.getElementById(id); };
  // One initial, two for two words; two letters when single-word names share one.
  function labels(names) {
    var first = function (n) { return (n.trim()[0] || '?').toUpperCase(); }; var counts = {};
    names.forEach(function (n) { counts[first(n)] = (counts[first(n)] || 0) + 1; });
    var out = {}; names.forEach(function (n) { var w = n.trim().split(/[\\s._-]+/).filter(Boolean);
      out[n] = w.length >= 2 ? (w[0][0] + w[1][0]).toUpperCase() : counts[first(n)] > 1 ? first(n) + (w[0] || '').slice(1, 2).toLowerCase() : first(n); });
    return out;
  }
  var label = {};
  function dot(p) { var d = document.createElement('div'); var i = label[p.name] || p.name.slice(0, 1).toUpperCase(); d.className = 'dot' + (i.length > 1 ? ' two' : '') + (p.online ? '' : ' away'); d.textContent = i;
    d.setAttribute('data-name', p.name + (p.role === 'host' ? ' · host' : '') + (p.online ? '' : ' · away')); return d; }
  $('title').textContent = data.title;
  $('link').textContent = data.url;
  var INSTALL = 'claude plugin marketplace add Paradigm-Study/claude-share && claude plugin install shared-session@claude-share';
  $('install').textContent = INSTALL;
  $('copy3').addEventListener('click', function () { navigator.clipboard.writeText(INSTALL).then(function () { $('install').textContent = 'Copied. Paste it in a terminal.'; setTimeout(function () { $('install').textContent = INSTALL; }, 1800); }); });
  Array.prototype.forEach.call(document.querySelectorAll('.hn'), function (n) { n.textContent = data.host; });
  $('open').href = data.deepLink; $('go').href = data.deepLink;
  function render(d) {
    var seen = {}; var people = d.people.filter(function (p) { if (seen[p.name]) return false; seen[p.name] = 1; return true; });
    people.sort(function (a, b) { return (b.role === 'host') - (a.role === 'host') || b.online - a.online; });
    label = labels(people.map(function (p) { return p.name; }));
    var dots = $('dots'); dots.textContent = ''; people.slice(0, 8).forEach(function (p) { dots.appendChild(dot(p)); });
    var here = people.filter(function (p) { return p.online; });
    var count = $('count'); count.textContent = '';
    var b = document.createElement('b'); b.textContent = here.length + ' here'; count.appendChild(b);
    if (here.length) count.appendChild(document.createTextNode(' · ' + here.map(function (p) { return p.name; }).join(', ')));
    ['pill', 'pill2'].forEach(function (id) { $(id).classList.toggle('ended', d.ended); $(id).lastElementChild.textContent = d.ended ? 'ENDED' : 'LIVE'; });
    $('cta').hidden = d.ended; $('go').hidden = d.ended;
    if (d.ended) { $('eyebrow').textContent = 'Sharing ended'; $('subcopy').textContent = 'This session is no longer shared. Ask ' + data.host + ' for a new link.'; }
  }
  render(data);
  setInterval(function () {
    fetch('/api/rooms/' + data.id, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) render({ people: d.people, ended: d.ended }); }).catch(function () {});
  }, 4000);
  function copy() { navigator.clipboard.writeText(data.url).then(function () { $('copy').textContent = 'Copied'; setTimeout(function () { $('copy').textContent = 'Copy link'; }, 1600); }); }
  $('copy').addEventListener('click', copy); $('copy2').addEventListener('click', copy);
  function opening() { $('status').textContent = 'Opening Claude… then press Enter in the new session.'; }
  $('open').addEventListener('click', opening); $('go').addEventListener('click', opening);
  if (!data.ended && location.hash !== '#stay') {
    var key = 'opened:' + data.id; var already = false; try { already = sessionStorage.getItem(key) === '1'; sessionStorage.setItem(key, '1'); } catch (e) {}
    if (!already) setTimeout(function () { opening(); location.href = data.deepLink; }, 700);
  }
})();
</script>
</body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}
