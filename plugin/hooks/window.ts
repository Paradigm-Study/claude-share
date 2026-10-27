// Preview windows. A guest opens the host's localhost previews in a browser
// window of their own: a Chromium-family browser or Firefox on a profile kept
// for the room, whose localhost goes through the plugin's SOCKS proxy to what
// the host shares and nowhere else, so the page keeps the host's own address
// (OAuth callbacks match) and the guest's own servers on the same ports are
// never touched. These are the pure parts: the flags, settings and command
// that start the window, the shell probes and what they print, and what the
// window's proxy says. It imports nothing: test/local-preview.mjs loads this
// file under Node as it is, to start real browsers with these same flags and
// run these same probes (the person's own proxy is ./upstream.ts's; a
// preview's address, ./preview.ts's).

export type WindowPlatform = 'darwin' | 'linux'
/** Chromium takes the window's proxy as flags; Firefox as its profile's settings (user.js). */
export type BrowserFamily = 'chromium' | 'firefox'
/**
 * The browser found, with what its files say it is: `family` (null: neither
 * kind, so no window) and, for Firefox and its forks, the major version of
 * the Gecko it is built on (`gecko`, from its platform.ini).
 */
export type BrowserFound = { platform: WindowPlatform | 'unsupported'; browser: string | null; family?: BrowserFamily | null; gecko?: number; isDefault?: true }
/** One browser the detection found: what its files say it is, and whether it's the person's default browser (macOS). */
export type BrowserCandidate = { browser: string; family?: BrowserFamily; gecko?: number; isDefault?: true }
/** The oldest Gecko a preview window opens in: tested, and well past 67, from which Firefox's hand-off of an address goes only to an instance on the same profile. */
export const FIREFOX_MIN = 140
/**
 * What the window's proxy says (relay/browser-proxy.mts): `upstream`, once
 * after `ready`, that it left the person's own proxy out (`reason`,
 * INVALID_UPSTREAM: an address it can't take) and goes on without it.
 */
export type ProxyLine = { state: 'ready'; port: number; control: number } | { state: 'want' | 'blocked' | 'seen'; port: number } | { state: 'lan' } | { state: 'upstream'; reason: string } | { state: 'error'; code: string }

// Its own (this file imports nothing), as ./preview.ts's `isPort`.
const isPort = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535

// A string inside a shell script's single quotes.
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * The flags a preview window starts with, in this order, its address last.
 * `<-loopback>` makes the browser send localhost through the proxy too (by
 * default it goes direct, to the guest's own servers). Never a room token or
 * ticket, and never --ignore-certificate-errors. The real-Chrome test starts
 * Chrome with this same list.
 */
export function chromeFlags(profile: string, proxyPort: number, platform: WindowPlatform, url: string): string[] {
  return [
    `--user-data-dir=${profile}/chrome`,
    `--proxy-server=socks5://127.0.0.1:${proxyPort}`,
    '--proxy-bypass-list=<-loopback>',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    platform === 'darwin' ? '--use-mock-keychain' : '--password-store=basic',
    url,
  ]
}

/**
 * Firefox's flags, its address last: the window's own profile. Firefox hands
 * an address only to an instance running on the same profile (since 67; its
 * remoting is named by profile), so with the window open this opens the page
 * there, in a new window if it has none (macOS keeps Firefox running without
 * one), and with none it starts one; the person's own Firefox, on another
 * profile, never gets it. Not -no-remote (ignored since 131; before, it kept
 * the window from taking a second address) or -new-instance (a second Open
 * would then meet "Firefox is already running"). The proxy comes from the
 * profile's settings (`firefoxUserJs`).
 */
export function firefoxFlags(profile: string, url: string): string[] {
  return ['-profile', `${profile}/firefox`, url]
}

// The rest of what a preview window's Firefox profile is set to. Localhost
// goes through the proxy too (Firefox sends it direct otherwise, and before
// 144 it stops counting a proxied localhost as a secure context unless told
// to), a connection the proxy refuses never falls back to a direct one, names
// are the proxy's to resolve (no DNS of its own, over HTTPS or ahead of
// time), a new profile's first-run pages and prompts stay away, and nothing
// is reported to Mozilla from it (no telemetry, health report or studies).
// The real-Firefox test starts Firefox with this same list.
export const FIREFOX_PREFS: readonly (readonly [string, string | number | boolean])[] = [
  ['network.proxy.type', 1],
  ['network.proxy.socks_version', 5],
  ['network.proxy.socks_remote_dns', true],
  ['network.proxy.socks5_remote_dns', true],
  ['network.proxy.http', ''],
  ['network.proxy.http_port', 0],
  ['network.proxy.ssl', ''],
  ['network.proxy.ssl_port', 0],
  ['network.proxy.share_proxy_settings', false],
  ['network.proxy.no_proxies_on', ''],
  ['network.proxy.allow_hijacking_localhost', true],
  ['network.proxy.testing_localhost_is_secure_when_hijacked', true],
  ['network.proxy.failover_direct', false],
  ['network.trr.mode', 5],
  ['network.dns.disablePrefetch', true],
  ['network.prefetch-next', false],
  ['network.predictor.enabled', false],
  ['network.captive-portal-service.enabled', false],
  ['network.connectivity-service.enabled', false],
  ['browser.shell.checkDefaultBrowser', false],
  ['browser.aboutwelcome.enabled', false],
  ['browser.startup.homepage_override.mstone', 'ignore'],
  ['browser.startup.homepage', 'about:blank'],
  ['browser.startup.firstrunSkipsHomepage', true],
  ['startup.homepage_welcome_url', ''],
  ['startup.homepage_welcome_url.additional', ''],
  ['datareporting.policy.dataSubmissionEnabled', false],
  ['datareporting.policy.dataSubmissionPolicyBypassNotification', true],
  ['datareporting.policy.firstRunURL', ''],
  ['datareporting.healthreport.uploadEnabled', false],
  ['toolkit.telemetry.reportingpolicy.firstRun', false],
  ['app.normandy.enabled', false],
  ['app.shield.optoutstudies.enabled', false],
  ['browser.sessionstore.resume_from_crash', false],
  ['toolkit.startup.max_resumed_crashes', -1],
  ['browser.tabs.warnOnClose', false],
  ['browser.warnOnQuit', false],
]

/** The profile's user.js: the proxy on this port, then `FIREFOX_PREFS`. Firefox reads it at every start. */
export function firefoxUserJs(proxyPort: number): string {
  const prefs: (readonly [string, string | number | boolean])[] = [['network.proxy.socks', '127.0.0.1'], ['network.proxy.socks_port', proxyPort], ...FIREFOX_PREFS]
  return ['// shared-session: a preview window (written before every start)', ...prefs.map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`), ''].join('\n')
}

// A window's settings file, privately and in place at once: its folder
// made private (0700), the text written to a new file (0600) and renamed over
// the old, so the browser never reads half of one. One writer for both kinds
// (Firefox's user.js, Chrome's Preferences), named on its first line.
function privateFileScript(what: string, dir: string, name: 'user.js' | 'Preferences', text: string): string {
  return [
    `# shared-session: ${what}`,
    'umask 077',
    `f=${shellQuote(dir)}`,
    'mkdir -p "$f" && chmod 700 "$f" || exit 1',
    `t="$f/.${name}.$$"`,
    `printf '%s' ${shellQuote(text)} > "$t" && mv -f "$t" "$f/${name}" || { rm -f "$t"; exit 1; }`,
    '',
  ].join('\n')
}

/** Writes the Firefox profile's user.js before a start (`privateFileScript`). */
export function firefoxProfileScript(profile: string, proxyPort: number): string {
  return privateFileScript('settings for a preview window', `${profile}/firefox`, 'user.js', firefoxUserJs(proxyPort))
}

/** What a Chromium window's WebRTC may use: UDP only through the proxy, which has none, so TURN over TCP. */
export const WEBRTC_POLICY = 'disable_non_proxied_udp'

/**
 * A Chromium profile's Preferences with the window's WebRTC setting in it,
 * what else is there kept (a file that isn't JSON Chrome would set aside
 * anyway); null when it's set already. Chrome reads it as it starts.
 */
export function chromePrefs(text: string | null): string | null {
  let prefs: Record<string, unknown> = {}
  try {
    const parsed: unknown = text ? JSON.parse(text) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prefs = parsed as Record<string, unknown>
  } catch {}
  const webrtc = prefs.webrtc && typeof prefs.webrtc === 'object' && !Array.isArray(prefs.webrtc) ? (prefs.webrtc as Record<string, unknown>) : {}
  if (webrtc.ip_handling_policy === WEBRTC_POLICY) return null
  return JSON.stringify({ ...prefs, webrtc: { ...webrtc, ip_handling_policy: WEBRTC_POLICY } })
}

/** Writes a Chromium profile's Preferences before a start (`privateFileScript`). */
export function chromePrefsScript(profile: string, text: string): string {
  return privateFileScript('chrome preferences for a preview window', `${profile}/chrome/Default`, 'Preferences', text)
}

// Detached from this session: the window outlives the command that opened it.
export const DETACHED = 'setsid -f "$@" >/dev/null 2>&1 </dev/null || { nohup "$@" >/dev/null 2>&1 </dev/null & }'

/** An app bundle, named itself or by a binary inside it. */
export function appBundle(path: string): string | null {
  return /^(\/.*?\.app)(?:\/Contents\/MacOS\/[^/]+)?\/?$/.exec(path)?.[1] ?? null
}

/**
 * What `$.process.run` starts. macOS: `open -n -a <app> --args …`, a new
 * instance (without -n the flags go to the person's own running browser).
 * Elsewhere, and for a bare binary: the binary, detached.
 */
export function launchArgv(platform: WindowPlatform, browser: string, flags: readonly string[]): string[] {
  const app = platform === 'darwin' ? appBundle(browser) : null
  return app ? ['open', '-n', '-a', app, '--args', ...flags] : ['/bin/sh', '-c', DETACHED, 'sh', browser, ...flags]
}

/** The browser's name as people say it: "Google Chrome", "Microsoft Edge", "Brave Browser", "Firefox"… */
export function browserName(path: string): string {
  const app = appBundle(path)
  if (app) return app.split('/').pop()!.replace(/\.app$/, '')
  const base = path.replace(/\/+$/, '').split('/').pop() ?? ''
  const channel = (name: string, rest: string) => `${name}${rest === 'beta' ? ' Beta' : rest === 'dev' || rest === 'unstable' ? ' Dev' : rest === 'nightly' ? ' Nightly' : rest === 'canary' ? ' Canary' : ''}`
  let m: RegExpExecArray | null
  if ((m = /^google-chrome(?:-(\w+))?$/.exec(base)) || /^chrome$/.test(base)) return channel('Google Chrome', m?.[1] ?? '')
  if ((m = /^microsoft-edge(?:-(\w+))?$/.exec(base))) return channel('Microsoft Edge', m[1] ?? '')
  if ((m = /^brave-browser(?:-(\w+))?$/.exec(base)) || /^brave$/.test(base)) return channel('Brave Browser', m?.[1] ?? '')
  if (/^chromium/.test(base)) return 'Chromium'
  if (base === 'firefox-esr') return 'Firefox ESR'
  if (base === 'firefox-developer-edition') return 'Firefox Developer Edition'
  if ((m = /^firefox(?:-(nightly))?$/.exec(base))) return channel('Firefox', m[1] ?? '')
  if (/^vivaldi/.test(base)) return 'Vivaldi'
  if (/^opera$/.test(base)) return 'Opera'
  return base || 'browser'
}

/**
 * Firefox and the browsers built on it take settings rather than Chromium's
 * flags. What the detection read from the browser's files decides (a Gecko
 * version, or Chromium's own files); else the name; else neither (null),
 * and no window opens in it: launched as the other kind, it could open the
 * address in the person's own profile.
 */
export function browserFamily(path: string, found: Pick<BrowserFound, 'family' | 'gecko'> = {}): BrowserFamily | null {
  if (found.gecko !== undefined) return 'firefox'
  if (found.family !== undefined) return found.family
  const words = `${browserName(path)} ${path.replace(/\/+$/, '').split('/').pop() ?? ''}`
  if (/firefox|librewolf|waterfox|floorp/i.test(words)) return 'firefox'
  if (/chrom|edge|brave|vivaldi|opera/i.test(words)) return 'chromium'
  return null
}

// The browsers looked for, in this order: Chrome, Edge, Brave and Chromium
// and their other channels (the flags the window starts with are theirs),
// then Firefox, then Vivaldi and Opera. macOS: an app and the binary inside
// it (Firefox's is lowercase); Linux: names on PATH.
const MAC_APPS: readonly (readonly [app: string, binary: string])[] = [
  ...['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'].map(a => [a, a] as const),
  ...['Google Chrome Beta', 'Google Chrome Dev', 'Google Chrome Canary', 'Microsoft Edge Beta', 'Microsoft Edge Dev', 'Microsoft Edge Canary', 'Brave Browser Beta', 'Brave Browser Nightly'].map(a => [a, a] as const),
  ...['Firefox', 'Firefox Developer Edition', 'Firefox Nightly'].map(a => [a, 'firefox'] as const),
  ...['Vivaldi', 'Opera'].map(a => [a, a] as const),
]
const LINUX_BINARIES = [
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser',
  'google-chrome-beta', 'google-chrome-unstable', 'microsoft-edge-beta', 'microsoft-edge-dev', 'brave-browser-beta', 'brave-browser-nightly',
  'firefox', 'firefox-esr', 'firefox-developer-edition', 'firefox-nightly',
  'vivaldi', 'vivaldi-stable', 'opera',
]

// The bundle id of the app macOS opens a web link with, as NSWorkspace says
// (no Apple Event, so no permission asked).
const DEFAULT_BROWSER_JXA = 'ObjC.import("AppKit"); var u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com")); var b = u.isNil() ? null : $.NSBundle.bundleWithURL(u); b && !b.isNil() && !b.bundleIdentifier.isNil() ? b.bundleIdentifier.js : ""'

/**
 * One script that says the platform and the browsers there: the person's
 * choice (SHARED_SESSION_BROWSER: an app bundle or a binary) alone, else
 * every one of the browsers above installed, in that order (`pickBrowser`
 * chooses). A snap's sandbox can't use a profile under ~/.claude, so a snap
 * (or the wrapper that runs one) never counts. For each, what its files say
 * it is: Gecko's platform.ini (beside the binary, or in the app's Resources)
 * gives its version; Chromium's own framework (macOS) or resources.pak
 * (Linux) say Chromium. On macOS, also which is the person's default browser,
 * by bundle id, as the system hands it links. `appDirs`: where macOS apps
 * are looked for (/Applications and ~/Applications; a test's own folders).
 */
export function detectScript(override: string, appDirs?: readonly string[]): string {
  const notSnap = [
    '  r=$(readlink -f "$p" 2>/dev/null || printf %s "$p")',
    '  case "$p $r" in */snap/*) continue;; esac',
    '  s=$(wc -c < "$r" 2>/dev/null || echo 0); [ "${s:-0}" -lt 65536 ] && grep -q "/snap/" "$r" 2>/dev/null && continue',
  ]
  return [
    '# shared-session: find a browser for preview windows',
    'os=$(uname -s 2>/dev/null)',
    'echo "platform=$os"',
    `o=${shellQuote(override)}`,
    'dd=; seen=',
    // One browser: its path, what its files say it is, and on macOS whether it's the default.
    'say() {',
    '  f=$1; a=',
    '  case "$f" in',
    '  *.app|*.app/|*.app/Contents/MacOS/*) a=${f%/}; a=${a%%.app/Contents/MacOS/*}; a=${a%.app}.app; i="$a/Contents/Resources/platform.ini"; k=$(ls -d "$a"/Contents/Frameworks/*Framework.framework 2>/dev/null | head -n 1);;',
    '  *) r=$(readlink -f "$f" 2>/dev/null || printf %s "$f"); i="${r%/*}/platform.ini"; k=; [ -f "${r%/*}/resources.pak" ] && k=1;;',
    '  esac',
    '  echo "browser=$f"',
    '  v=$(sed -n \'s/^Milestone=\\([0-9][0-9]*\\).*/\\1/p\' "$i" 2>/dev/null | head -n 1)',
    // A wrapper script (Debian's /usr/bin/firefox) has no platform.ini beside it: Firefox says its own version.
    '  if [ -z "$v" ] && [ -z "$k" ]; then case "${f##*/}" in firefox|firefox-*) t=; command -v timeout >/dev/null 2>&1 && t="timeout 10"; v=$($t "$f" --version 2>/dev/null </dev/null | sed -n \'s/^Mozilla Firefox \\([0-9][0-9]*\\).*/\\1/p\' | head -n 1);; esac; fi',
    '  if [ -n "$v" ]; then echo "gecko=$v"; elif [ -n "$k" ]; then echo "chromium=1"; fi',
    '  if [ -n "$dd" ] && [ -n "$a" ]; then',
    '    id=$(defaults read "$a/Contents/Info" CFBundleIdentifier 2>/dev/null | tr "[:upper:]" "[:lower:]")',
    '    [ -n "$id" ] && [ "$id" = "$dd" ] && echo "default=1"',
    '  fi',
    '  return 0',
    '}',
    'if [ -n "$o" ]; then',
    '  case "$o" in /snap/*) exit 0;; esac',
    '  if [ -d "$o" ] || [ -x "$o" ]; then say "$o" </dev/null; fi',
    '  exit 0',
    'fi',
    'case "$os" in',
    'Darwin)',
    `  dd=$(osascript -l JavaScript -e ${shellQuote(DEFAULT_BROWSER_JXA)} 2>/dev/null </dev/null | tr "[:upper:]" "[:lower:]")`,
    `  for e in ${MAC_APPS.map(([app, binary]) => shellQuote(`${app}|${binary}`)).join(' ')}; do`,
    '    n=${e%%|*}; x=${e#*|}',
    `    for d in ${appDirs ? appDirs.map(shellQuote).join(' ') : '/Applications "$HOME/Applications"'}; do`,
    '      [ -x "$d/$n.app/Contents/MacOS/$x" ] && say "$d/$n.app" </dev/null',
    '    done',
    '  done;;',
    'Linux)',
    `  for b in ${LINUX_BINARIES.join(' ')}; do`,
    '  p=$(command -v "$b" 2>/dev/null) || continue',
    '  [ -n "$p" ] || continue',
    ...notSnap,
    // google-chrome and google-chrome-stable are often one binary: once each.
    '  case "|$seen|" in *"|$r|"*) continue;; esac; seen="$seen|$r"',
    '  say "$p" </dev/null',
    '  done;;',
    'esac',
    'exit 0',
    '',
  ].join('\n')
}

/** What the detection printed: the platform, and each browser found, in its order. */
export function detectedBrowsers(out: string): { platform: WindowPlatform | 'unsupported'; candidates: BrowserCandidate[] } {
  const os = /^platform=(\S*)/m.exec(out)?.[1] ?? ''
  const platform = os === 'Darwin' ? 'darwin' : os === 'Linux' ? 'linux' : 'unsupported'
  const candidates: BrowserCandidate[] = []
  if (platform === 'unsupported') return { platform, candidates }
  let current: BrowserCandidate | null = null
  for (const line of out.replace(/\r/g, '').split('\n')) {
    const path = /^browser=(\/.+)$/.exec(line)?.[1]?.trim()
    if (path !== undefined) {
      current = !/\/snap\//.test(path) && !/[\x00-\x1f]/.test(path) ? { browser: path } : null
      if (current) candidates.push(current)
    } else if (current) {
      const gecko = Number(/^gecko=(\d{1,4})$/.exec(line)?.[1])
      if (Number.isInteger(gecko) && gecko > 0) current.gecko = gecko
      else if (line === 'chromium=1') current.family = 'chromium'
      else if (line === 'default=1') current.isDefault = true
    }
  }
  return { platform, candidates }
}

/**
 * The browser a window opens in: the first one that can (Chromium-family, or
 * Firefox FIREFOX_MIN or newer whose profile path fits, `firefoxFits`), one
 * that isn't the person's default browser first: macOS hands a link opened
 * in another app to a running copy of the default browser, which a preview
 * window of it would be. With none that can, the first found, for what's
 * said to name it.
 */
export function pickBrowser(candidates: readonly BrowserCandidate[], firefoxFits = true): BrowserCandidate | null {
  const can = (c: BrowserCandidate) => {
    const family = browserFamily(c.browser, c)
    return family === 'chromium' || (family === 'firefox' && (c.gecko ?? 0) >= FIREFOX_MIN && firefoxFits)
  }
  return candidates.find(c => can(c) && !c.isDefault) ?? candidates.find(can) ?? candidates[0] ?? null
}

/** The browser to use, as `pickBrowser` picks it. `firefoxFits`: whether a Firefox profile's path fits on Linux. */
export function parseDetect(out: string, firefoxFits = true): BrowserFound {
  const { platform, candidates } = detectedBrowsers(out)
  const pick = pickBrowser(candidates, platform !== 'linux' || firefoxFits)
  if (!pick) return { platform, browser: null }
  const kind = pick.gecko !== undefined ? { gecko: pick.gecko } : pick.family ? { family: pick.family } : {}
  return { platform, browser: pick.browser, ...kind, ...(pick.isDefault ? { isDefault: true as const } : {}) }
}

/**
 * A room's profile folder for one session: the first 16 hex digits of
 * sha256(server/room/owner), the owner the session's lasting id (Claude
 * Desktop's own for the session, else Claude Code's), so two sessions in one
 * room never share a window, and a reopened one finds its own.
 */
export async function profileName(server: string, roomId: string, owner: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${server}/${roomId}/${owner}`)))
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

/** A signed-in host's profile: the same for every room of theirs on that server, kept between them. */
export async function hostProfileName(server: string, account: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${server}/host/${account}`)))
  return `h-${[...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)}`
}

// The lock probe: the process holding the profile, whose command line must
// name this exact profile, or it is someone else's process (a pid reused).
// Chrome's SingletonLock names `<hostname>-<pid>` of it. Firefox's lock on
// Linux is the profile's `lock` link (`<ip>:+<pid>`); on macOS, whoever has
// its `.parentlock` open. Failing those, it is the person's own process
// whose command line has this profile, never one of the window's own
// child processes (-contentproc on Linux; on macOS plugin-container, with
// -parentBuildID, which carries -profile too). Its proxy port is in the
// profile's settings. The script reaches
// sh on stdin, so its own command line never matches; `held` is a function
// so the cleanup asks the same.
const HELD = [
  'held() {',
  '  pid=; c=; port=',
  '  t=$(readlink "$1/chrome/SingletonLock" 2>/dev/null)',
  '  if [ -n "$t" ]; then',
  '    pid=${t##*-}',
  '    case "$pid" in ""|*[!0-9]*) pid=;; esac',
  '    if [ -n "$pid" ]; then c=$(ps -p "$pid" -ww -o command= 2>/dev/null) || c=; fi',
  '    case "$c" in *"--user-data-dir=$1/chrome"*) ;; *) pid=; c=;; esac',
  '  fi',
  '  [ -z "$pid" ] && [ -d "$1/firefox" ] || return 0',
  '  q=$(readlink "$1/firefox/lock" 2>/dev/null); q=${q##*+}',
  '  case "$q" in ""|*[!0-9]*) q=$(lsof -t -- "$1/firefox/.parentlock" 2>/dev/null | head -n 1);; esac',
  '  case "$q" in ""|*[!0-9]*) q=;; esac',
  '  if [ -n "$q" ]; then',
  '    x=$(ps -p "$q" -ww -o command= 2>/dev/null) || x=',
  '    case " $x " in *" -contentproc "*|*" -parentBuildID "*|*/plugin-container*) ;; *" -profile $1/firefox "*) pid=$q; c=$x;; esac',
  '  fi',
  '  if [ -z "$pid" ]; then',
  '    while read -r q x; do',
  '      case " $x " in *" -contentproc "*|*" -parentBuildID "*|*/plugin-container*) ;; *" -profile $1/firefox "*) pid=$q; c=$x; break;; esac',
  '    done <<EOF',
  '$(ps -U "$(id -u)" -ww -o pid= -o command= 2>/dev/null)',
  'EOF',
  '  fi',
  '  case "$pid" in ""|*[!0-9]*) pid=; c=; return 0;; esac',
  '  port=$(sed -n \'s/^user_pref("network\\.proxy\\.socks_port", \\([0-9][0-9]*\\));$/\\1/p\' "$1/firefox/user.js" 2>/dev/null | head -n 1)',
  '}',
]
const lockCheck = (profile: string) => [...HELD, `held ${shellQuote(profile)}`, '[ -n "$pid" ] || exit 0']

export function lockScript(profile: string): string {
  return ['# shared-session: is the preview window open', ...lockCheck(profile), 'printf "pid=%s\\nport=%s\\n%s\\n" "$pid" "$port" "$c"', ''].join('\n')
}

/**
 * Ends the window holding the profile: that one process, never by pattern.
 * `wait`: until it has gone, up to 3 s. `port`: only the window started with
 * that proxy port (a host's profile may hold another session's window).
 */
export function killScript(profile: string, wait: boolean, port?: number): string {
  return [
    '# shared-session: close the preview window',
    ...lockCheck(profile),
    ...(port === undefined ? [] : [`w=${port}`, 'case " $c " in *" --proxy-server=socks5://127.0.0.1:$w "*) ;; *) [ "$port" = "$w" ] || exit 0;; esac']),
    'kill "$pid" 2>/dev/null',
    wait ? 'i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i+1)); done' : ':',
    'echo killed',
    '',
  ].join('\n')
}

/** What the lock probe printed: the window's process, its kind, and the proxy port it started with. */
export function windowOf(out: string, profile: string): { pid: number; port: number | null; family: BrowserFamily } | null {
  const m = /^pid=(\d+)\nport=(\d*)\n([\s\S]*)$/.exec(out.replace(/\r/g, ''))
  if (!m) return null
  const command = m[3]!.trim()
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`--user-data-dir=${escape(`${profile}/chrome`)}(?:\\s|$)`).test(command)) {
    const port = Number(/--proxy-server=socks5:\/\/127\.0\.0\.1:(\d{1,5})(?:\s|$)/.exec(command)?.[1])
    return { pid: Number(m[1]), port: isPort(port) ? port : null, family: 'chromium' }
  }
  if (/(?:^|\s)-(?:contentproc|parentBuildID)(?:\s|$)|\/plugin-container/.test(command) || !new RegExp(`(?:^|\\s)-profile ${escape(`${profile}/firefox`)}(?:\\s|$)`).test(command)) return null
  const port = Number(m[2])
  return { pid: Number(m[1]), port: isPort(port) ? port : null, family: 'firefox' }
}

/** The profile's folder, made private (0700, as checkpoints are), touched so a cleanup sees it in use. */
export function profileScript(browserDir: string, profile: string): string {
  return [`umask 077`, `b=${shellQuote(browserDir)}; p=${shellQuote(profile)}`, 'mkdir -p "$b" && chmod 700 "$b" && mkdir -p "$p" && chmod 700 "$p" && touch "$p"', ''].join('\n')
}

/**
 * A host's profile is one for all their rooms, so two sessions of the
 * guest's (one in each of two of that host's rooms) could open a window on
 * it at once: each would find none there, write its settings and start one,
 * and the second's settings (Firefox's proxy port) or its page (Chrome's
 * hands it to the window already starting) would land in the other's window.
 * So a session takes the profile before it looks for a window there, and
 * holds it through the settings and the start: `mkdir` makes the lock, and
 * of two at once only one makes it. Its secret goes in it, so a session lets
 * go only of its own (`launchUnlockScript`); one held over
 * LAUNCH_LOCK_STALE minutes was left by a session that's gone (a start takes
 * well under one), and is taken over. Exits 0 taken, LAUNCH_LOCK_BUSY held
 * by another session now; anything else, not taken.
 */
export const LAUNCH_LOCK_BUSY = 3
export const LAUNCH_LOCK_STALE = 2
export function launchLockScript(browserDir: string, profile: string, token: string): string {
  return [
    '# shared-session: take a preview profile to start its window',
    'umask 077',
    `b=${shellQuote(browserDir)}; p=${shellQuote(profile)}; l="$p/.launching"`,
    'mkdir -p "$b" && chmod 700 "$b" && mkdir -p "$p" && chmod 700 "$p" || exit 1',
    `[ -n "$(find "$l" -maxdepth 0 -mmin +${LAUNCH_LOCK_STALE} 2>/dev/null)" ] && rm -rf "$l"`,
    `mkdir "$l" 2>/dev/null || exit ${LAUNCH_LOCK_BUSY}`,
    `printf '%s\\n' ${shellQuote(token)} > "$l/owner" || { rm -rf "$l"; exit 1; }`,
    'exit 0',
    '',
  ].join('\n')
}

/** Lets the profile go again, if this session's secret is still the lock's: never another session's. */
export function launchUnlockScript(profile: string, token: string): string {
  return [
    '# shared-session: done starting a preview profile\'s window',
    `p=${shellQuote(profile)}; l="$p/.launching"`,
    `[ "$(cat "$l/owner" 2>/dev/null)" = ${shellQuote(token)} ] && rm -rf "$l"`,
    'exit 0',
    '',
  ].join('\n')
}

/**
 * A room's profile out of the way at once, then removed by a shell that
 * outlives this one. Nothing is left in its place: a Firefox still starting
 * on it (a slow first start outlasting the waits) doesn't make a missing
 * profile folder anew, so it loads nothing (140 to 158 checked).
 */
export function trashScript(browserDir: string, profile: string, tag: string): string {
  return [
    '# shared-session: remove a preview profile',
    `b=${shellQuote(browserDir)}; p=${shellQuote(profile)}; t="$b/.trash-${tag.replace(/[^A-Za-z0-9]/g, '')}"`,
    '[ -d "$p" ] || exit 0',
    'mv "$p" "$t" 2>/dev/null || exit 0',
    '( rm -rf "$t" </dev/null >/dev/null 2>&1 & )',
    '',
  ].join('\n')
}

/**
 * The longest Firefox profile path a window takes on Linux: Firefox names
 * its D-Bus remote by the base64 of the path, cut at 255 characters, so past
 * this two rooms' profiles could share one name and a page go to the other
 * room's window. (macOS hashes long names instead.)
 */
export const FIREFOX_PATH_MAX = 170

/** A profile folder's name as `profileName` makes it: 16 hex digits, spelled out so no locale's ranges stretch it. */
export const PROFILE_GLOB = '[0123456789abcdef]'.repeat(16)
export const HOST_PROFILE_GLOB = `h-${PROFILE_GLOB}`

/**
 * What's left over: trash, and profiles a day old whose window is gone
 * (never `keep`, the room open here). Only what this plugin makes there is
 * ever touched: `.trash-*` and 16-hex-digit profile folders.
 */
export function gcScript(browserDir: string, keep: string): string {
  return [
    '# shared-session: clean up preview profiles',
    ...HELD,
    `b=${shellQuote(browserDir)}; keep=${shellQuote(keep)}`,
    '[ -d "$b" ] || exit 0',
    'for d in "$b"/.trash-*; do [ -e "$d" ] && rm -rf "$d"; done',
    'for d in "$b"/*; do',
    '  [ -d "$d" ] || continue',
    '  n=${d##*/}',
    // A room's profile goes a day unused (rooms last a day); a host's, thirty.
    `  case "$n" in ${PROFILE_GLOB}) m=1440;; ${HOST_PROFILE_GLOB}) m=43200;; *) continue;; esac`,
    '  [ "$n" = "$keep" ] && continue',
    '  [ -n "$(find "$d" -maxdepth 1 -mmin -$m 2>/dev/null | head -1)" ] && continue',
    '  held "$d"',
    '  [ -n "$pid" ] && continue',
    '  rm -rf "$d"',
    'done',
    '',
  ].join('\n')
}

/** One line from the window's proxy (its JSON, parsed), checked; anything else is ignored. */
export function proxyLine(said: unknown): ProxyLine | null {
  if (!said || typeof said !== 'object') return null
  const m = said as Record<string, unknown>
  const code = (value: unknown, otherwise: string) => (typeof value === 'string' && /^[A-Z_]{1,40}$/.test(value) ? value : otherwise)
  if (m.state === 'ready') return isPort(m.port) && isPort(m.control) ? { state: 'ready', port: m.port, control: m.control } : null
  if (m.state === 'want' || m.state === 'blocked' || m.state === 'seen') return isPort(m.port) ? { state: m.state, port: m.port } : null
  if (m.state === 'lan') return { state: 'lan' }
  if (m.state === 'upstream') return { state: 'upstream', reason: code(m.reason, 'UPSTREAM') }
  if (m.state === 'error') return { state: 'error', code: code(m.code, 'ERROR') }
  return null
}
