import { token } from './http.ts'
import { CLOVER_WEBP, LOGO_PATHS } from '../brand.ts'
import type { Room } from './room.ts'

// The server's own front page: what this is, the one-line install, and what
// the server sees and keeps (the disclosure a public server owes its users).
// `traces`: whether this server keeps shared sessions' turns (server/traces),
// which it then says.
export function homePage({ traces = false }: { traces?: boolean } = {}) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shared Sessions for Claude Code</title>
<meta name="description" content="Share a Claude Code session with a link. Teammates join from their own Claude Code and work in it together.">
<meta property="og:title" content="Shared Sessions for Claude Code">
<meta property="og:description" content="Share a Claude Code session with a link. Teammates join from their own Claude Code and work in it together.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@500;600&family=Gowun+Batang:wght@400;700&display=swap" rel="stylesheet">
<style>
${PAGE_CSS}
.prose { max-width:64ch; color:var(--muted); font-size:15px; line-height:1.6; text-wrap:pretty; }
.prose h2 { font-family:var(--display); font-weight:400; font-size:26px; color:var(--ink); margin:0 0 12px; }
.prose ul { padding-left:18px; margin:10px 0; } .prose li { margin:6px 0; }
.prose b { color:var(--ink); font-weight:600; }
.prose a { color:var(--accent-ink); text-decoration:underline; text-underline-offset:2px; }
.install { max-width:640px; margin-top:28px; }
.install .composer code { white-space:normal; overflow-wrap:anywhere; }
section.more { padding:0 0 72px; }
</style></head>
<body>
<header class="wrap nav">
  <a class="brand" href="/"><svg viewBox="0 0 500 500" aria-hidden="true">${LOGO_PATHS}</svg><span class="word">Paradigm</span><span class="sub">Shared sessions</span></a>
  <a class="btn-ghost" href="https://github.com/Paradigm-Study/claude-share">GitHub</a>
</header>
<main class="wrap">
  <section class="hero" style="grid-template-columns:minmax(0,1fr);padding-bottom:56px">
    <div>
      <span class="eyebrow">A Claude Code plugin</span>
      <h1>Share a Claude Code session with a link</h1>
      <p class="sub-copy">Teammates join from their own Claude Code and talk to it. One session does the work, everyone sees every turn as it streams, and the host approves what runs on their machine.</p>
      <div class="install">
        ${commandBox('install', INSTALL_COMMAND, 'Copy install command')}
        <p class="status">Then start a new session and press <b>Share</b> above the prompt (or type /share-session). For your team, press <b>Team</b>: sign in with GitHub or Google, and everything your team shares is a press from joining. Requires Claude Code 2.1.286 or later.</p>
      </div>
    </div>
  </section>
  <section class="more prose" id="privacy">
    <h2>What this server sees and keeps</h2>
    <ul>
      <li><b>What passes through:</b> while a session is shared, its prompts and the files people attach to them, Claude's replies and, while someone else is in the room, its thinking as it happens (passed along, never kept), the tools it runs with the first lines of their results and the pictures in them (screenshots, images it opens), the side chat, people's reactions to Claude's replies and which replies each person has had on screen, any files or local previews the host's Claude shows, and messages between a teammate's own other sessions and the host's session, which go to the other side alone (passed along, never kept). Sharing a session that already has history asks first whether to include it.</li>
      <li><b>How long:</b> a room and everything in it is deleted 24 hours after the host stops sharing or was last seen. A room keeps its newest 5000 events, 16 MB of them at most. For TCP previews the room keeps only coarse connection and byte-budget counters, until the room is deleted. For a preview opened through its link, the room keeps the link (which preview, which seat made it, the page it opens) for 10 minutes, and the browser session it starts (which preview and seat) for 12 hours from the last link that browser opened; both end when that seat leaves or the host stops the preview. A seat keeps its newest 4 browser sessions per preview, and a room its newest 128 links and 256 browser sessions. A link or session that expired is removed at the room's next activity, or with the room; one that ended goes at once. Application bytes are relayed, never stored. To count the rooms each network makes in a day, the server on Cloudflare keeps a hash of each new room's network address, keyed by a random key made for that day, with that count, until the day (UTC) ends; then all of it goes, the key too. There are no analytics, and no request logs kept.</li>
${
  traces
    ? `      <li><b>Traces, kept on this server:</b> this server keeps the turns of sessions shared by someone signed in, so their team can search them later from Claude Code. Each turn keeps its prompt, Claude's reply, the names of the tools it ran (not what they were given or answered), when it was, who asked it and who shared the session. Files, pictures, the side chat, reactions and thinking are not kept. A session shared with a team can be searched by anyone in that team, including people who join it later; one shared with no team, by its host alone. A session shared without signing in is not kept. Turns are kept with no end date, and there is no way yet to delete them: deleting your account doesn't. Each turn's words go to Cloudflare's Workers AI to be indexed by meaning. Searching needs a sign-in on this server's page, the same as for teams.</li>
`
    : ''
}      <li><b>Previews share a host name:</b> every shared session's previews are served on one preview host name, and their links name the session by a key of its own, which can't join it. A browser not already in a session's previews has that host name's storage and cache, and its domain's cookies, cleared before it enters; browsers clear them only over HTTPS (or on localhost). No preview can register a service worker there. Clearing can't stop a page that's still open, though: a preview page of one session left open in a browser can reach the previews of another session that browser opens after it. Close the previews of a session you don't trust before opening another's, or open them in a browser profile of their own. A server of your own can give each session's previews a host name of its own, which closes this (<a href="https://github.com/Paradigm-Study/claude-share/blob/main/docs/guide.md#host-a-server">how</a>).</li>
      <li><b>Accounts, only for teams:</b> sharing and joining need none. If you sign in (GitHub or Google) to use teams, the server keeps your name, username, the email your provider last verified (once it stops verifying one, it's shown but no longer signs anyone in or matches a team's domain), which GitHub organizations you're in, the teams you're in and their settings, which open sessions are shared with each team, and invites to a session (who invited whom, until it's joined, dismissed, ends, or 12 hours pass). Signing in finishes only when you press Continue on this server's page. The page and Claude Code show the same code, and you continue only if they match. Until you press Continue, the server keeps who GitHub or Google said you are; after ten minutes that sign-in stops working, and it's deleted then. Claude Code's token is made when it picks up the sign-in, and the server keeps only its hash, never the token itself. Sign-ins stay until you delete your account (<code>/team delete-account</code>), which removes them at once. A browser signed in to this server's dashboard (<code>/app</code>) keeps its sign-in in a cookie, and the server keeps only its hash, with your account. A browser sign-in lasts 30 days, and signing out there, or deleting your account, ends it at once. It only reads: your teams' live sessions, and the traces you could search from Claude Code. Signed in, a session you share or join also knows your account for as long as it lasts, so your sessions count as one person.</li>
      <li><b>Native subscription pools, where configured:</b> a separate Mac helper may use your Share sign-in to enroll in a pool for a configured team. Share checks actual team membership and keeps a hashed grant with the account, team, device name and verifier hash for at most two minutes. The pool receives the account and team IDs and device name and checks current membership before giving out credentials. Your Share sign-in token stays with Share. A room link grants no pool access, and one-time Mac setup is required.</li>
      <li><b>In the cloud, if a host chooses it:</b> Move to cloud sends the session's project files, its conversation and the host's Claude token to a container this server starts for that room, which runs Claude Code as the host. The server passes them on and keeps none of them. The container, with everything in it, is deleted when the host brings the session home, the room ends, or a week after the move; its changes are kept as a room file for Bring home, deleted with the room.</li>
      <li><b>Who can see it:</b> anyone with the room's link, or for a session shared with a team that keeps it to its people, only the people in that team. Links are long and random; forward one only to people you'd hand the session to. Content is encrypted in transit, not end to end: the server can read what passes through it.</li>
      <li><b>What runs where:</b> a teammate's prompt runs on the host's machine. Reads inside the host's project run without asking (one through a link out of it asks); everything else asks the host first, by default. A local page the host's Claude opens or gives the address of is shared only once the host says so.</li>
      <li><b>Limits:</b> new rooms and joins are rate-limited per network; rooms hold up to 20 people, 100 MB of files (10,240 files at most), 128 open previews, and events of 128 KB each. Previews opened through their link limit request bodies to 1 MB and response bodies to 20 MB, and allow 512 requests waiting per room, 32 WebSockets per seat and 128 per room (one the host's Claude Code doesn't take up within 10 seconds closes, and those waiting hold 8 MB per room at most), and 30 new links a minute per seat (120 per room). A room sends out at most 8 GB a day of its files and of what its previews' links answer, and to any one seat at most 256 MB a minute of it. Such a WebSocket closes once 1 MB sent through it waits unread; on Cloudflare, which can't see that, once one side sends more than 4 MB in a second. TCP previews instead allow 32 connections per seat across all previews, 64 per room, and 1200 new connections per minute (240 for any one seat). Only a port the host chose to forward can be reached this way, and only by someone in the room: their connections close when they leave or the host stops that preview. Unpaired connections close after 10 seconds. A room has a lifetime 1 GiB TCP byte budget, reserved in 1 MiB chunks per direction, unused parts given back when a connection closes. Data messages are at most 64 KiB, with at most 4 messages / 256 KiB outstanding per direction, and a connection closes if 1 MiB of control messages to one side goes unacknowledged (each acknowledgement covers everything sent before it), however long it lives. Rooms that are abused get ended.</li>
      <li><b>Your own server:</b> teams that want their sessions on their own infrastructure can run the same server on their own Cloudflare account in a few minutes (<a href="https://github.com/Paradigm-Study/claude-share#host-a-server">how</a>), and set it in the plugin.</li>
    </ul>
    <p>Questions or abuse reports: open an issue on <a href="https://github.com/Paradigm-Study/claude-share/issues">GitHub</a>.</p>
  </section>
</main>
<footer class="wrap"><q>Everyone in one session, Claude in the middle.</q></footer>
<script>${COPY_SCRIPT}</script>
</body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } })
}

// A page in the site's own look: the nav, an eyebrow, a serif heading, its
// words, then whatever follows (buttons, a command to copy). The account,
// invite and not-found pages are all this; callers escape what they pass.
export function brandPage({
  title,
  eyebrow = '',
  heading,
  body = '',
  after = '',
  mark = '',
  status = 200,
  script = '',
}: {
  title: string
  eyebrow?: string
  heading: string
  body?: string
  after?: string
  mark?: string
  status?: number
  script?: string
}) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title ?? heading)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@500;600&family=Gowun+Batang:wght@400;700&display=swap" rel="stylesheet">
<style>
${PAGE_CSS}
.page { max-width:640px; padding:64px 0 72px; }
.page .sub-copy + .sub-copy { margin-top:12px; }
.page .cta { margin-top:28px; }
.page .first { margin-top:22px; }
</style></head>
<body>
<header class="wrap nav">
  <a class="brand" href="/"><svg viewBox="0 0 500 500" aria-hidden="true">${LOGO_PATHS}</svg><span class="word">Paradigm</span><span class="sub">Shared sessions</span></a>
  ${mark}
</header>
<main class="wrap">
  <section class="page">
    ${eyebrow ? `<span class="eyebrow">${escapeHtml(eyebrow)}</span>` : ''}
    <h1>${escapeHtml(heading)}</h1>
    ${body}
    ${after}
  </section>
</main>
<footer class="wrap"><q>Everyone in one session, Claude in the middle.</q></footer>
${script ? `<script>${script}</script>` : ''}
</body></html>`
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

// The one-line install, as a command to copy (pages that hand people off to
// Claude Code show it under "First time?").
export const INSTALL_COMMAND = 'claude plugin marketplace add Paradigm-Study/claude-share && claude plugin install shared-session@claude-share'
export const COPY_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>'
export const commandBox = (id: string, text: string, label: string) =>
  `<div class="composer"><span class="slash" aria-hidden="true">$</span><code id="${id}">${escapeHtml(text)}</code><button type="button" data-copy="${id}" aria-label="${escapeHtml(label)}">${COPY_ICON}</button></div>`
// Every [data-copy] button copies its code's text and says so for a moment:
// in the code's place when it shows, else on the button itself.
export const COPY_SCRIPT = `document.querySelectorAll('[data-copy]').forEach(function (b) { b.addEventListener('click', function () {
  var code = document.getElementById(b.getAttribute('data-copy')); var text = code.getAttribute('data-text') || code.textContent; code.setAttribute('data-text', text);
  var where = code.hidden ? b : code; var was = where.getAttribute('data-was') || where.innerHTML; where.setAttribute('data-was', was);
  navigator.clipboard.writeText(text).then(function () { where.textContent = 'Copied'; setTimeout(function () { where.innerHTML = was; }, 1500); }); }); });`

// A link to a room that isn't here (ended long ago and swept, or mistyped):
// the landing page's look, and what to do.
export function missingPage() {
  return brandPage({
    title: "This shared session isn't here",
    eyebrow: 'Link not found',
    heading: "This shared session isn't here",
    body: '<p class="sub-copy">It ended, or the link is incomplete. Ask whoever sent it for a new one.</p>',
    mark: '<span class="live ended"><i></i><span>ENDED</span></span>',
    status: 404,
  })
}

// ---------------------------------------------------------------------------
// The page a share link opens in a browser: hands the link to Claude Desktop
// as a new Claude Code session's prompt, where the plugin joins on Enter.

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (s: unknown) => String(s).replace(/[&<>"']/g, c => ENTITIES[c] ?? c)

const PAGE_CSS = `/* Paradigm's landing design (paradigm-study-web, "A School of One"): paper and
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
.sub-copy { margin:0; font-size:16px; line-height:1.55; color:var(--muted); max-width:46ch; text-wrap:pretty; }
.note { display:flex; gap:9px; align-items:flex-start; margin:18px 0 0; max-width:46ch; font-size:14px; line-height:1.5; color:var(--ink-soft); text-wrap:pretty; }
.note svg { flex:none; width:15px; height:15px; margin-top:3px; color:var(--accent-ink); }
.people { display:flex; align-items:center; gap:14px; margin:26px 0 0; }
.dots { display:flex; gap:5px; }
.dot { position:relative; display:grid; place-items:center; width:30px; height:30px; border-radius:50%; background:var(--dot); color:var(--dot-ink);
  font-size:12px; font-weight:650; letter-spacing:.02em; transition:transform .2s var(--ease); }
.dot.two { font-size:10.5px; }
.dot.away { background:transparent; color:var(--dot); box-shadow:inset 0 0 0 1.5px var(--dot); }
@media (hover: hover) and (pointer: fine) { .dot:hover { transform:scale(1.06); } }
.dot[data-name]:hover::after { content:attr(data-name); position:absolute; bottom:calc(100% + 8px); left:50%; transform:translateX(-50%); white-space:nowrap;
  padding:3px 8px; border-radius:6px; background:var(--ink); color:var(--bg); font-size:11px; font-weight:500; pointer-events:none; }
.count { font-size:14px; color:var(--muted); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-variant-numeric:tabular-nums; } .count b { color:var(--ink); font-weight:600; }
.cta { display:flex; align-items:center; gap:22px; margin-top:30px; }
.btn-primary { display:inline-flex; align-items:center; gap:9px; min-height:46px; background:var(--ink); color:var(--bg); font:500 15px var(--body); padding:13px 24px; border:0;
  border-radius:.5rem; box-shadow:var(--shadow-md); cursor:pointer; transition:transform .14s var(--ease), opacity .14s ease; }
.btn-primary:active { transform:scale(.97); }
.btn-ghost { display:inline-flex; align-items:center; min-height:44px; font:500 15px var(--body); color:var(--accent-ink); background:none; border:0; padding:0 4px; margin:0 -4px; cursor:pointer; transition:opacity .14s ease; }
.btn-ghost:active { opacity:.5; }
@media (hover: hover) and (pointer: fine) {
  .btn-primary:hover { opacity:.9; }
  .btn-ghost:hover { opacity:.65; }
}
.btn-primary:disabled { opacity:.5; cursor:default; transform:none; }
:focus-visible { outline:2px solid var(--accent); outline-offset:3px; border-radius:6px; }
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
.step.go { cursor:pointer; border-color:var(--accent); background:var(--accent-wash); color:var(--ink); transition:transform .14s var(--ease), box-shadow .18s ease; }
.step.go:active { transform:scale(.99); }
@media (hover: hover) and (pointer: fine) { .step.go:hover { box-shadow:var(--shadow-md); } }
.step.go .ico { color:var(--accent-ink); }
.composer { margin-top:4px; border:1px solid var(--line); border-radius:6px; background:var(--surface); padding:12px 14px; display:flex; align-items:center; gap:8px; }
.composer .slash { color:var(--faint); font-family:var(--mono); }
.composer code { flex:1; min-width:0; font:12.5px var(--mono); color:var(--ink-soft); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.composer button { flex:none; display:grid; place-items:center; width:36px; height:36px; margin:-9px -9px -9px 0; border:0; border-radius:6px; background:none; color:var(--muted); cursor:pointer; transition:color .15s ease, background-color .15s ease, transform .12s var(--ease); }
.composer button:active { transform:scale(.94); }
@media (hover: hover) and (pointer: fine) { .composer button:hover { color:var(--ink); background:var(--accent-wash); } }
.first { margin-top:6px; font-size:13px; color:var(--muted); }
.first summary { display:inline-block; padding:6px 0; cursor:pointer; list-style:none; color:var(--accent-ink); font-weight:500; }
.first summary::-webkit-details-marker { display:none; }
.first summary::before { content:"+ "; font-family:var(--mono); }
.first[open] summary::before { content:"– "; }
.first p { margin:8px 0; text-wrap:pretty; }
.first .composer { margin-top:0; }
.first code.inline { font:12.5px var(--mono); background:var(--accent-wash); color:var(--accent-ink); padding:1px 5px; border-radius:4px; }
.status a { color:var(--accent-ink); text-decoration:underline; text-underline-offset:2px; }
footer { padding:0 0 40px; color:var(--faint); font-size:13px; }
footer q { font-family:var(--display); font-size:17px; color:var(--muted); quotes:"\\201C" "\\201D"; }
[hidden] { display:none !important; }
@media (max-width: 880px) { .hero { grid-template-columns:minmax(0,1fr); gap:64px; padding:40px 0 64px; } .window { margin:0 auto; } h1 { font-size:36px; } }
@media (max-width: 480px) { .wrap { padding:0 18px; } h1 { font-size:30px; } .main { padding:22px 18px 18px; } .cta { gap:16px; flex-wrap:wrap; } .brand .sub { display:none; } }
@media (prefers-reduced-motion: reduce) { * { animation:none !important; transition:none !important; } }
`

export function landingPage(room: Room, url: string, now: number, opts: { access?: string | null } = {}) {
  const deepLink = `claude://code/new?q=${encodeURIComponent(url)}`
  const data = {
    id: room.id,
    url,
    deepLink,
    title: room.title,
    host: room.host.name,
    ended: Boolean(room.endedAt),
    people: room.people(now),
    team: room.team?.name ?? '',
  }
  // Inside a script element `</script>` in a name would end it, and what
  // follows would run: every `<` goes as its escape.
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  const membersOnly = room.team && opts.access === 'members' ? room.team : null
  const nonce = token(16)
  const host = escapeHtml(room.host.name)
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${host} is sharing a Claude Code session</title>
<meta name="description" content="${escapeHtml(room.title)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Claude Code · Shared session">
<meta property="og:title" content="${host} is sharing a Claude Code session">
<meta property="og:description" content="${escapeHtml(room.title)} · Join from your own Claude Code and work in it together.">
<meta name="twitter:card" content="summary">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@500;600&family=Gowun+Batang:wght@400;700&display=swap" rel="stylesheet">
<style>
${PAGE_CSS}</style></head>
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
      ${membersOnly ? `<p class="note join"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><span>Only people in ${escapeHtml(membersOnly.name)} can join. In Claude Code, press <b>Team</b> above the prompt and sign in first.</span></p>` : ''}
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
        <div class="step done" id="ended-step" hidden><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 12h7"/></svg><span>Sharing has ended. Ask <b class="hn"></b> for a new link</span></div>
        <a class="step go join" id="go" href="#"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg><span><b>Open in Claude Code.</b> A new session opens with this link in the prompt box</span></a>
        <div class="step join"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg><span><b>Press Enter</b> to join. The conversation so far plays back, then you're in it live</span></div>
        <div class="composer join"><span class="slash">/</span><code id="link"></code><button id="copy2" title="Copy link" aria-label="Copy link"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg></button></div>
        <details class="first join" id="first">
          <summary>First time? Install the plugin once</summary>
          <p>Paste this in a terminal, then start a new Claude Code session (or quit and reopen Claude Desktop). Needs Claude Code 2.1.286 or newer: <code class="inline">claude update</code>.</p>
          <div class="composer"><span class="slash">$</span><code id="install"></code><button id="copy3" title="Copy command" aria-label="Copy install command"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg></button></div>
          <p>In a terminal instead? Start <code class="inline">claude</code> and paste the link as your first message.</p>
        </details>
      </div>
    </div>
  </section>
</main>
<footer class="wrap"><q>Everyone in one session, Claude in the middle.</q></footer>
<script nonce="${nonce}">
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
  if (data.team) $('eyebrow').textContent = data.host + ' is sharing with ' + data.team;
  function render(d) {
    var seen = {}; var people = d.people.filter(function (p) { if (seen[p.name]) return false; seen[p.name] = 1; return true; });
    people.sort(function (a, b) { return (b.role === 'host') - (a.role === 'host') || b.online - a.online; });
    label = labels(people.map(function (p) { return p.name; }));
    var dots = $('dots'); dots.textContent = ''; people.slice(0, 8).forEach(function (p) { dots.appendChild(dot(p)); });
    var here = people.filter(function (p) { return p.online; });
    var count = $('count'); count.textContent = '';
    if (!here.length) { count.textContent = data.host + ' is away right now'; }
    else { var b = document.createElement('b'); b.textContent = here.length + ' here'; count.appendChild(b);
      count.appendChild(document.createTextNode(' · ' + here.map(function (p) { return p.name; }).join(', '))); }
    ['pill', 'pill2'].forEach(function (id) { $(id).classList.toggle('ended', d.ended); $(id).lastElementChild.textContent = d.ended ? 'ENDED' : 'LIVE'; });
    $('cta').hidden = d.ended; $('ended-step').hidden = !d.ended; document.querySelector('.people').hidden = d.ended;
    Array.prototype.forEach.call(document.querySelectorAll('.join'), function (n) { n.hidden = d.ended; });
    if (d.ended) { $('eyebrow').textContent = 'Sharing ended'; $('subcopy').textContent = 'This session is no longer shared. Ask ' + data.host + ' for a new link.'; }
  }
  render(data);
  // Refresh who's here only while someone is looking, and never after the end.
  var ended = data.ended;
  function refresh() {
    if (ended || document.visibilityState !== 'visible') return;
    fetch('/api/rooms/' + data.id, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) { ended = d.ended; render({ people: d.people, ended: d.ended }); } }).catch(function () {});
  }
  setInterval(refresh, 4000);
  document.addEventListener('visibilitychange', refresh);
  function copy() { navigator.clipboard.writeText(data.url).then(function () { $('copy').textContent = 'Copied'; setTimeout(function () { $('copy').textContent = 'Copy link'; }, 1600); }); }
  $('copy').addEventListener('click', copy); $('copy2').addEventListener('click', copy);
  // The app opening takes this window's focus. Still here after a moment: say what else works.
  var left = false;
  window.addEventListener('blur', function () { left = true; });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') left = true; });
  function opening() {
    left = false;
    $('status').textContent = 'Opening Claude… then press Enter in the new session.';
    setTimeout(function () {
      if (left) return;
      $('status').textContent = "Didn't open? You need the Claude desktop app, or start claude in a terminal and paste the link. First time? Install the plugin below.";
      $('first').open = true;
    }, 2500);
  }
  $('open').addEventListener('click', opening); $('go').addEventListener('click', opening);
  if (!data.ended && location.hash !== '#stay') {
    var key = 'opened:' + data.id; var already = false; try { already = sessionStorage.getItem(key) === '1'; sessionStorage.setItem(key, '1'); } catch (e) {}
    if (!already) setTimeout(function () { opening(); location.href = data.deepLink; }, 700);
  }
})();
</script>
</body></html>`
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': landingPolicy(nonce) },
  })
}

// The room page runs its one script, by this response's nonce, and loads its
// fonts; anything a name or title might smuggle in runs nowhere.
const landingPolicy = (nonce: string) =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
