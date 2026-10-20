// The pure parts of preview windows: the flags and command that start one,
// the settings written before it starts, the shell probes and what they
// print, and what the window's proxy says. Run with `claude plugin test plugin`.

import { expect, test } from 'claude-code/testing'
import {
  appBundle,
  base64url,
  browserFamily,
  browserName,
  chromeFlags,
  chromePrefs,
  chromePrefsScript,
  DETACHED,
  detectScript,
  detectedBrowsers,
  FIREFOX_MIN,
  FIREFOX_PREFS,
  firefoxFlags,
  firefoxProfileScript,
  firefoxUserJs,
  gcScript,
  HOST_PROFILE_GLOB,
  hostProfileName,
  killScript,
  LAUNCH_LOCK_BUSY,
  LAUNCH_LOCK_STALE,
  launchArgv,
  launchLockScript,
  launchUnlockScript,
  lockScript,
  parseDetect,
  pickBrowser,
  profileName,
  PROFILE_GLOB,
  profileScript,
  proxyLine,
  shellQuote,
  trashScript,
  windowOf,
} from '../hooks/window'

const PROFILE = '/home/scott/.claude/shared-session/browser/0123456789abcdef'

test('a window starts with the proxy for localhost too, in this order, its address last', () => {
  expect(chromeFlags(PROFILE, 47100, 'darwin', 'http://localhost:3000/login')).toEqual([
    `--user-data-dir=${PROFILE}/chrome`,
    '--proxy-server=socks5://127.0.0.1:47100',
    '--proxy-bypass-list=<-loopback>',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    '--use-mock-keychain',
    'http://localhost:3000/login',
  ])
  const linux = chromeFlags(PROFILE, 47100, 'linux', 'http://127.0.0.1:3000/')
  expect(linux.at(-2)).toBe('--password-store=basic')
  expect(linux.at(-1)).toBe('http://127.0.0.1:3000/')
  expect(linux.some(f => /ignore-certificate-errors/.test(f))).toBe(false)
})

test('macOS opens a new instance of the app; Linux and a bare binary start detached', () => {
  const flags = ['--new-window', 'http://localhost:3000/']
  expect(launchArgv('darwin', '/Applications/Google Chrome.app', flags)).toEqual(['open', '-n', '-a', '/Applications/Google Chrome.app', '--args', ...flags])
  // A binary inside a bundle opens as its bundle, so -n applies.
  expect(launchArgv('darwin', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', flags)).toEqual(['open', '-n', '-a', '/Applications/Brave Browser.app', '--args', ...flags])
  expect(launchArgv('linux', '/usr/bin/google-chrome', flags)).toEqual(['/bin/sh', '-c', DETACHED, 'sh', '/usr/bin/google-chrome', ...flags])
  expect(launchArgv('darwin', '/opt/chromium/chrome', flags)[0]).toBe('/bin/sh')
  expect(DETACHED).toContain('setsid -f "$@"')
  expect(appBundle('/Users/s/Applications/Chromium.app/')).toBe('/Users/s/Applications/Chromium.app')
  expect(appBundle('/usr/bin/chromium')).toBeNull()
})

test('browsers are named as people say them', () => {
  expect(browserName('/Applications/Google Chrome.app')).toBe('Google Chrome')
  expect(browserName('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')).toBe('Microsoft Edge')
  expect(browserName('/usr/bin/google-chrome-stable')).toBe('Google Chrome')
  expect(browserName('/usr/bin/microsoft-edge')).toBe('Microsoft Edge')
  expect(browserName('/usr/bin/brave-browser')).toBe('Brave Browser')
  expect(browserName('/usr/bin/chromium-browser')).toBe('Chromium')
  expect(browserName('/usr/bin/google-chrome-beta')).toBe('Google Chrome Beta')
  expect(browserName('/usr/bin/google-chrome-unstable')).toBe('Google Chrome Dev')
  expect(browserName('/usr/bin/microsoft-edge-dev')).toBe('Microsoft Edge Dev')
  expect(browserName('/usr/bin/brave-browser-nightly')).toBe('Brave Browser Nightly')
  expect(browserName('/Applications/Firefox.app')).toBe('Firefox')
  expect(browserName('/Applications/Firefox Developer Edition.app')).toBe('Firefox Developer Edition')
  expect(browserName('/usr/bin/firefox')).toBe('Firefox')
  expect(browserName('/usr/bin/firefox-esr')).toBe('Firefox ESR')
  expect(browserName('/usr/bin/firefox-nightly')).toBe('Firefox Nightly')
  expect(browserName('/usr/bin/vivaldi-stable')).toBe('Vivaldi')
  expect(browserName('/usr/bin/opera')).toBe('Opera')
})

test('Firefox and the browsers built on it are told apart from Chromium, and a browser of neither kind is neither', () => {
  for (const path of ['/Applications/Firefox.app', '/Applications/Firefox Nightly.app/Contents/MacOS/firefox', '/usr/bin/firefox-esr', '/usr/lib/librewolf/librewolf']) expect(browserFamily(path)).toBe('firefox')
  for (const path of ['/Applications/Google Chrome.app', '/usr/bin/chromium', '/usr/bin/vivaldi', '/Applications/Opera.app', '/opt/brave/brave']) expect(browserFamily(path)).toBe('chromium')
  // What its files say decides: a Gecko version is Firefox's kind, whatever the name.
  expect(browserFamily('/Applications/Zen.app', { gecko: 158 })).toBe('firefox')
  expect(browserFamily('/Applications/Mullvad Browser.app', { gecko: 140 })).toBe('firefox')
  expect(browserFamily('/Applications/Arc.app', { family: 'chromium' })).toBe('chromium')
  // Neither by its files nor its name: no window (as the other kind it could open the person's own profile).
  for (const path of ['/Applications/Safari.app', '/Applications/Zen.app', '/Applications/Tor Browser.app', '/usr/bin/epiphany']) expect(browserFamily(path)).toBeNull()
})

test("a Firefox window's flags: its own profile, whose window alone takes the address, then the address", () => {
  // No -no-remote or -new-instance: an open window on this profile takes a second page; nothing else can.
  expect(firefoxFlags(PROFILE, 'http://localhost:3000/login')).toEqual(['-profile', `${PROFILE}/firefox`, 'http://localhost:3000/login'])
  for (const flag of firefoxFlags(PROFILE, 'http://localhost:3000/')) expect(flag).not.toMatch(/token|ticket|ignore-certificate/i)
})

test("a Firefox window's settings send everything through its proxy, localhost too, never directly", () => {
  const text = firefoxUserJs(47100)
  const prefs = Object.fromEntries([...text.matchAll(/^user_pref\(("[^"]+"), (.+)\);$/gm)].map(m => [JSON.parse(m[1]!), JSON.parse(m[2]!)]))
  expect(prefs).toMatchObject({
    'network.proxy.type': 1,
    'network.proxy.socks': '127.0.0.1',
    'network.proxy.socks_port': 47100,
    'network.proxy.socks_version': 5,
    'network.proxy.socks_remote_dns': true,
    'network.proxy.socks5_remote_dns': true,
    'network.proxy.no_proxies_on': '',
    'network.proxy.allow_hijacking_localhost': true,
    'network.proxy.testing_localhost_is_secure_when_hijacked': true,
    'network.proxy.failover_direct': false,
    'network.trr.mode': 5,
    // Nothing is reported to Mozilla from a preview window.
    'datareporting.policy.dataSubmissionEnabled': false,
    'datareporting.healthreport.uploadEnabled': false,
    'app.normandy.enabled': false,
    'app.shield.optoutstudies.enabled': false,
  })
  // Every line is a setting or the header; nothing else gets in.
  expect(text.split('\n').filter(Boolean).every(line => line.startsWith('user_pref(') || line.startsWith('// shared-session:'))).toBe(true)
  expect(Object.keys(prefs)).toHaveLength(FIREFOX_PREFS.length + 2)
  const write = firefoxProfileScript(PROFILE, 47100)
  expect(write.startsWith('# shared-session: settings for a preview window')).toBe(true)
  expect(write).toContain('umask 077')
  expect(write).toContain(`f=${shellQuote(`${PROFILE}/firefox`)}`)
  expect(write).toContain('mv -f "$t" "$f/user.js"')
  expect(write).toContain(shellQuote(text))
})

test('detection says the platform and a browser, never a snap one', () => {
  const script = detectScript('')
  expect(script.startsWith('# shared-session: find a browser for preview windows')).toBe(true)
  expect(script).toContain("'Google Chrome|Google Chrome' 'Microsoft Edge|Microsoft Edge' 'Brave Browser|Brave Browser' 'Chromium|Chromium'")
  // Firefox's binary is lowercase, and it comes after every Chromium channel.
  expect(script).toContain("'Firefox|firefox'")
  expect(script.indexOf("'Firefox|firefox'")).toBeGreaterThan(script.indexOf("'Brave Browser Nightly|Brave Browser Nightly'"))
  expect(script).toContain('"$d/$n.app/Contents/MacOS/$x"')
  expect(script).toMatch(/for b in google-chrome .* firefox firefox-esr .* opera; do/)
  expect(script).toContain('"$HOME/Applications"')
  expect(script).toContain('*/snap/*')
  // The override is quoted: it can't run as script.
  expect(detectScript("/tmp/x'; rm -rf ~; '")).toContain(shellQuote("/tmp/x'; rm -rf ~; '"))
  // What the browser's files say it is: Gecko's platform.ini (or Firefox's own --version behind a wrapper), Chromium's framework or resources.
  expect(script).toContain('/Contents/Resources/platform.ini')
  expect(script).toContain('Milestone=')
  expect(script).toContain('*Framework.framework')
  expect(script).toContain('resources.pak')
  expect(script).toContain("s/^Mozilla Firefox ")
  // A binary inside an app is read as that app (its Resources, its Frameworks).
  expect(script).toContain('*.app|*.app/|*.app/Contents/MacOS/*)')
  expect(script).toContain('firefox|firefox-*)')
  expect(parseDetect('platform=Darwin\nbrowser=/Applications/Firefox.app\ngecko=158\n')).toEqual({ platform: 'darwin', browser: '/Applications/Firefox.app', gecko: 158 })
  expect(parseDetect('platform=Darwin\nbrowser=/Applications/Google Chrome.app\nchromium=1\n')).toEqual({ platform: 'darwin', browser: '/Applications/Google Chrome.app', family: 'chromium' })
  expect(parseDetect('platform=Linux\nbrowser=/usr/bin/firefox\ngecko=x\n')).toEqual({ platform: 'linux', browser: '/usr/bin/firefox' })
  expect(parseDetect('platform=Darwin\nbrowser=/Applications/Google Chrome.app\n')).toEqual({ platform: 'darwin', browser: '/Applications/Google Chrome.app' })
  expect(parseDetect('platform=Linux\nbrowser=/usr/bin/chromium\n')).toEqual({ platform: 'linux', browser: '/usr/bin/chromium' })
  expect(parseDetect('platform=Linux\nbrowser=/snap/bin/chromium\n')).toEqual({ platform: 'linux', browser: null })
  expect(parseDetect('platform=Linux\n')).toEqual({ platform: 'linux', browser: null })
  expect(parseDetect('platform=MINGW64_NT\nbrowser=/c/chrome.exe\n')).toEqual({ platform: 'unsupported', browser: null })
  expect(parseDetect('')).toEqual({ platform: 'unsupported', browser: null })
})

test("detection lists every browser found, and on macOS says which is the person's default", () => {
  const script = detectScript('')
  // Every one, not the first: each is said with what its files say it is.
  expect(script).not.toContain('break')
  expect(script).toContain('say() {')
  expect(script).toContain('[ -x "$d/$n.app/Contents/MacOS/$x" ] && say "$d/$n.app" </dev/null')
  // The default browser by bundle id, from NSWorkspace (no Apple Event), compared without case, on macOS only.
  const mac = script.slice(script.indexOf('Darwin)'), script.indexOf('Linux)'))
  expect(mac).toContain('osascript -l JavaScript -e ')
  expect(mac).toContain('URLForApplicationToOpenURL')
  expect(script.slice(script.indexOf('Linux)'))).not.toContain('osascript')
  expect(script).toContain('defaults read "$a/Contents/Info" CFBundleIdentifier')
  expect(script).toContain('tr "[:upper:]" "[:lower:]"')
  expect(script).toContain('echo "default=1"')
  // The person's choice is asked nothing more.
  const chosen = script.slice(script.indexOf('if [ -n "$o" ]; then'), script.indexOf('case "$os" in'))
  expect(chosen).toContain('exit 0')
  expect(script.indexOf('if [ -n "$o" ]; then')).toBeLessThan(script.indexOf('osascript'))
  // One binary under two names (google-chrome, google-chrome-stable) once.
  expect(script).toContain('case "|$seen|" in *"|$r|"*) continue;; esac; seen="$seen|$r"')
  // A test's own folders in place of /Applications and ~/Applications, quoted.
  expect(detectScript('', ["/tmp/a b", "/tmp/x'y"])).toContain(`for d in ${shellQuote('/tmp/a b')} ${shellQuote("/tmp/x'y")}; do`)
  expect(script).toContain('for d in /Applications "$HOME/Applications"; do')
  const out = 'platform=Darwin\nbrowser=/Applications/Google Chrome.app\nchromium=1\ndefault=1\nbrowser=/Applications/Firefox.app\ngecko=158\nbrowser=/snap/bin/x\ngecko=150\n'
  expect(detectedBrowsers(out)).toEqual({ platform: 'darwin', candidates: [{ browser: '/Applications/Google Chrome.app', family: 'chromium', isDefault: true }, { browser: '/Applications/Firefox.app', gecko: 158 }] })
  expect(detectedBrowsers('platform=Linux\ngecko=158\n')).toEqual({ platform: 'linux', candidates: [] })
  expect(detectedBrowsers('platform=Plan9\nbrowser=/bin/x\n')).toEqual({ platform: 'unsupported', candidates: [] })
  expect(parseDetect(out)).toEqual({ platform: 'darwin', browser: '/Applications/Firefox.app', gecko: 158 })
})

test("the window's browser is the first that can open one, one that isn't the default first", () => {
  const chrome = { browser: '/Applications/Google Chrome.app', family: 'chromium' as const }
  const firefox = { browser: '/Applications/Firefox.app', gecko: 158 }
  const vivaldi = { browser: '/Applications/Vivaldi.app' }
  const safari = { browser: '/Applications/Safari.app' }
  expect(pickBrowser([chrome, firefox])).toBe(chrome)
  expect(pickBrowser([{ ...chrome, isDefault: true }, firefox])).toBe(firefox)
  // The default when nothing else can: Firefox 128 can't, nor one whose version is unread.
  const only = { ...chrome, isDefault: true as const }
  expect(pickBrowser([only, { ...firefox, gecko: 128 }])).toBe(only)
  expect(pickBrowser([only, { browser: '/usr/bin/firefox' }])).toBe(only)
  // An old Firefox, or one whose path doesn't fit, gives way to a browser after it.
  expect(pickBrowser([{ ...firefox, gecko: 128 }, vivaldi])).toBe(vivaldi)
  expect(pickBrowser([firefox, vivaldi], false)).toBe(vivaldi)
  expect(pickBrowser([{ ...firefox, gecko: FIREFOX_MIN }])).toEqual({ ...firefox, gecko: FIREFOX_MIN })
  // None can: the first, so what's said names it.
  const old = { ...firefox, gecko: 128 }
  expect(pickBrowser([old, safari])).toBe(old)
  expect(pickBrowser([safari])).toBe(safari)
  expect(pickBrowser([])).toBeNull()
  // Linux: the path's fit counts only there.
  expect(parseDetect('platform=Linux\nbrowser=/usr/bin/firefox\ngecko=158\nbrowser=/usr/bin/vivaldi\n', false)).toEqual({ platform: 'linux', browser: '/usr/bin/vivaldi' })
  expect(parseDetect('platform=Darwin\nbrowser=/Applications/Firefox.app\ngecko=158\nbrowser=/Applications/Vivaldi.app\n', false)).toEqual({ platform: 'darwin', browser: '/Applications/Firefox.app', gecko: 158 })
  expect(parseDetect('platform=Linux\nbrowser=/usr/bin/firefox\ngecko=158\n', false)).toEqual({ platform: 'linux', browser: '/usr/bin/firefox', gecko: 158 })
  expect(parseDetect('platform=Darwin\nbrowser=/Applications/Google Chrome.app\nchromium=1\ndefault=1\n')).toEqual({ platform: 'darwin', browser: '/Applications/Google Chrome.app', family: 'chromium', isDefault: true })
})

test("a room's profile is named by a hash of its server, its id and the session's lasting place", async () => {
  const name = await profileName('http://share.test', 'room0000000000000001', 'local_0123abcd-0000')
  expect(name).toMatch(/^[0-9a-f]{16}$/)
  expect(await profileName('http://share.test', 'room0000000000000001', 'local_0123abcd-0000')).toBe(name)
  expect(await profileName('http://other.test', 'room0000000000000001', 'local_0123abcd-0000')).not.toBe(name)
  // Two sessions in one room: two profiles, two windows.
  expect(await profileName('http://share.test', 'room0000000000000001', 'session-b')).not.toBe(name)
})

test('the window is found by its lock and its exact profile, and ended as that one process', () => {
  const probe = lockScript(PROFILE)
  expect(probe.startsWith('# shared-session: is the preview window open')).toBe(true)
  expect(probe).toContain('SingletonLock')
  expect(probe).toContain('ps -p "$pid" -ww -o command=')
  expect(probe).toContain('*"--user-data-dir=$1/chrome"*')
  expect(probe).toContain(`held ${shellQuote(PROFILE)}`)
  const kill = killScript(PROFILE, true)
  expect(kill).toContain('kill "$pid"')
  expect(kill).not.toContain('pkill')
  expect(kill).toContain('kill -0')
  expect(killScript(PROFILE, false)).not.toContain('kill -0')
  const command = `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${PROFILE}/chrome --proxy-server=socks5://127.0.0.1:47100 --proxy-bypass-list=<-loopback>`
  expect(windowOf(`pid=4242\nport=\n${command}\n`, PROFILE)).toEqual({ pid: 4242, port: 47100, family: 'chromium' })
  // Another profile whose name starts the same is someone else's window.
  expect(windowOf(`pid=4242\nport=\n--user-data-dir=${PROFILE}-old/chrome --proxy-server=socks5://127.0.0.1:47100\n`, PROFILE)).toBeNull()
  expect(windowOf(`pid=4242\nport=\n--user-data-dir=${PROFILE}/chrome\n`, PROFILE)).toEqual({ pid: 4242, port: null, family: 'chromium' })
  expect(windowOf('', PROFILE)).toBeNull()
  // The old shape (no port line) is someone else's output.
  expect(windowOf(`pid=4242\n${command}\n`, PROFILE)).toBeNull()
})

test("a Firefox window is the process holding its profile's lock, its proxy port from the profile's settings", () => {
  const probe = lockScript(PROFILE)
  // Linux names the holder in the lock link; macOS, whoever has .parentlock open.
  expect(probe).toContain('readlink "$1/firefox/lock"')
  expect(probe).toContain('q=${q##*+}')
  expect(probe).toContain('lsof -t -- "$1/firefox/.parentlock"')
  // Failing those, only the person's own processes, never the window's content processes.
  expect(probe).toContain('ps -U "$(id -u)" -ww -o pid= -o command=')
  expect(probe).toContain('*" -contentproc "*|*" -parentBuildID "*|*/plugin-container*) ;;')
  expect(probe).toContain('*" -profile $1/firefox "*')
  expect(probe).not.toContain('ps -A')
  expect(probe).toContain('network\\.proxy\\.socks_port')
  // The listing is read in this shell (a here-document), never through grep, whose own command line would match.
  expect(probe).not.toMatch(/\| *grep/)
  expect(killScript(PROFILE, true)).toContain(`held ${shellQuote(PROFILE)}`)
  const command = `/Applications/Firefox.app/Contents/MacOS/firefox -profile ${PROFILE}/firefox http://localhost:3000/`
  expect(windowOf(`pid=5151\nport=47100\n${command}\n`, PROFILE)).toEqual({ pid: 5151, port: 47100, family: 'firefox' })
  expect(windowOf(`pid=5151\nport=\n${command}\n`, PROFILE)).toEqual({ pid: 5151, port: null, family: 'firefox' })
  // Ending the command line, too.
  expect(windowOf(`pid=5151\nport=47100\n/usr/lib/firefox/firefox -profile ${PROFILE}/firefox\n`, PROFILE)).toEqual({ pid: 5151, port: 47100, family: 'firefox' })
  // One of its child processes (Linux's -contentproc; macOS's plugin-container, which carries -profile too), or a Firefox on another profile, isn't the window.
  expect(windowOf(`pid=5152\nport=47100\n/usr/lib/firefox/firefox -contentproc -profile ${PROFILE}/firefox -childID 1 tab\n`, PROFILE)).toBeNull()
  expect(windowOf(`pid=5153\nport=47100\n/Applications/Firefox.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -isForBrowser -prefsLen 31000 -parentBuildID 20261001000000 -profile ${PROFILE}/firefox 5151 tab\n`, PROFILE)).toBeNull()
  expect(windowOf(`pid=5154\nport=47100\n/Applications/Firefox.app/Contents/MacOS/firefox -parentBuildID 20261001000000 -profile ${PROFILE}/firefox gpu\n`, PROFILE)).toBeNull()
  expect(windowOf(`pid=5151\nport=47100\n/usr/lib/firefox/firefox -profile ${PROFILE}-old/firefox http://localhost:3000/\n`, PROFILE)).toBeNull()
  // Cleaning up asks the same of every profile it would remove.
  const gc = gcScript('/home/scott/.claude/shared-session/browser', '')
  expect(gc).toContain('held() {')
  expect(gc).toContain('  held "$d"')
  expect(gc).toContain('  [ -n "$pid" ] && continue')
})

test('profiles are private, removed out of the way at once, and cleaned up a day on', () => {
  const make = profileScript('/home/scott/.claude/shared-session/browser', PROFILE)
  expect(make.startsWith('umask 077')).toBe(true)
  expect(make).toContain('chmod 700 "$b"')
  expect(make).toContain('chmod 700 "$p"')
  const trash = trashScript('/home/scott/.claude/shared-session/browser', PROFILE, 'ab12; rm -rf /')
  expect(trash).toContain('mv "$p" "$t"')
  expect(trash).toContain('.trash-ab12rmrf')
  expect(trash).toContain('( rm -rf "$t" </dev/null >/dev/null 2>&1 & )')
  // Nothing is made in its place: a Firefox still starting finds no profile and loads nothing.
  expect(trash).not.toContain('mkdir')
  expect(trash).not.toContain('user.js')
  const gc = gcScript('/home/scott/.claude/shared-session/browser', '0123456789abcdef')
  expect(gc).toContain('.trash-*')
  // A room's profile a day unused, a host's thirty.
  expect(gc).toContain(`${PROFILE_GLOB}) m=1440;;`)
  expect(gc).toContain(`${HOST_PROFILE_GLOB}) m=43200;;`)
  expect(gc).toContain('-mmin -$m')
  expect(gc).toContain(`keep='0123456789abcdef'`)
})

test("a signed-in host's profile is one for all their rooms on a server, named apart from a room's", async () => {
  const host = await hostProfileName('https://share.test', 'acct-1')
  expect(host).toMatch(/^h-[0-9a-f]{16}$/)
  expect(await hostProfileName('https://share.test', 'acct-1')).toBe(host)
  expect(await hostProfileName('https://share.test', 'acct-2')).not.toBe(host)
  expect(await hostProfileName('https://other.test', 'acct-1')).not.toBe(host)
  expect(globRegex(HOST_PROFILE_GLOB).test(host)).toBe(true)
  expect(globRegex(PROFILE_GLOB).test(host)).toBe(false)
  expect(globRegex(HOST_PROFILE_GLOB).test(await profileName('https://share.test', 'room', 'place'))).toBe(false)
})

test('a close for a proxy port leaves a window started with another alone', () => {
  const kill = killScript(PROFILE, true, 47100)
  expect(kill).toContain('w=47100')
  // Chrome's port is on its command line; Firefox's in its settings.
  expect(kill).toContain('case " $c " in *" --proxy-server=socks5://127.0.0.1:$w "*) ;; *) [ "$port" = "$w" ] || exit 0;; esac')
  expect(kill.indexOf('w=47100')).toBeLessThan(kill.indexOf('kill "$pid"'))
  expect(killScript(PROFILE, true)).not.toContain('w=')
})

test("a Chromium window's WebRTC goes only through the proxy: its profile's own setting, the rest of the file kept", () => {
  const policy = { ip_handling_policy: 'disable_non_proxied_udp' }
  expect(JSON.parse(chromePrefs(null)!)).toEqual({ webrtc: policy })
  const used = JSON.stringify({ profile: { name: 'Person 1' }, webrtc: { multiple_routes_enabled: false }, intl: { selected_languages: 'en' } })
  expect(JSON.parse(chromePrefs(used)!)).toEqual({ profile: { name: 'Person 1' }, webrtc: { multiple_routes_enabled: false, ...policy }, intl: { selected_languages: 'en' } })
  expect(chromePrefs(JSON.stringify({ webrtc: policy, x: 1 }))).toBeNull()
  // A file that isn't an object of JSON is one Chrome would set aside: just the setting.
  for (const broken of ['{', '[]', 'null', '"text"']) expect(JSON.parse(chromePrefs(broken)!)).toEqual({ webrtc: policy })
  const script = chromePrefsScript(PROFILE, chromePrefs(null)!)
  expect(script.split('\n').slice(0, 2)).toEqual(['# shared-session: chrome preferences for a preview window', 'umask 077'])
  expect(script).toContain(`f=${shellQuote(`${PROFILE}/chrome/Default`)}`)
  expect(script).toContain('mv -f "$t" "$f/Preferences"')
  expect(script).toContain(shellQuote(chromePrefs(null)!))
})

// The glob in `case` as a regular expression: only bracket classes and plain characters appear in it.
const globRegex = (glob: string) => new RegExp(`^${glob.replace(/\[([^\]]+)\]|([^[])/g, (_, set: string | undefined, ch: string | undefined) => (set ? `[${set.replace(/[\\^\]-]/g, '\\$&')}]` : ch!.replace(/[.*+?^${}()|\\/]/g, '\\$&')))}$`)

test("cleaning up touches only what the plugin makes there: .trash-*, 16-hex-digit profiles and h- ones", () => {
  const gc = gcScript('/home/scott/.claude/shared-session/browser', '0123456789abcdef')
  const lines = gc.split('\n')
  const filter = lines.findIndex(line => line.includes('case "$n" in'))
  const remove = lines.findIndex((line, i) => i > filter && line.trim() === 'rm -rf "$d"')
  // The name is checked inside the loop over folders, before anything can remove one.
  expect(lines.findIndex(line => line.startsWith('for d in "$b"/*;'))).toBeLessThan(filter)
  expect(filter).toBeLessThan(remove)
  expect(lines[filter]!.trim()).toBe(`case "$n" in ${PROFILE_GLOB}) m=1440;; ${HOST_PROFILE_GLOB}) m=43200;; *) continue;; esac`)
  // Every rm in the script removes trash or a folder past that check, nothing else.
  expect(lines.filter(line => line.includes('rm -rf')).map(line => line.trim())).toEqual(['for d in "$b"/.trash-*; do [ -e "$d" ] && rm -rf "$d"; done', 'rm -rf "$d"'])
  const profile = globRegex(PROFILE_GLOB)
  for (const name of ['0123456789abcdef', 'ffffffffffffffff', '00000000000000a9']) expect(profile.test(name)).toBe(true)
  for (const name of ['my-notes', 'ABCDEF0123456789x', '0123456789abcdef0', 'ABCDEF0123456789', '0123456789abcde', '0123456789abcdeg', '.trash-0123456789abcdef', '0123456789abcde-']) expect(profile.test(name)).toBe(false)
  const host = globRegex(HOST_PROFILE_GLOB)
  expect(host.test('h-0123456789abcdef')).toBe(true)
  for (const name of ['h-0123456789abcde', 'h-0123456789abcdef0', 'H-0123456789abcdef', 'hh-0123456789abcdef', 'h_0123456789abcdef', '0123456789abcdef']) expect(host.test(name)).toBe(false)
})

test('a control secret is 43 base64url characters', () => {
  const token = base64url(new Uint8Array(32).fill(255))
  expect(token).toHaveLength(43)
  expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
})

test("a window's two settings files are written by one private writer: a private folder, a new file renamed over the old", () => {
  // Each says what it writes on its first line (the shell's own name for it), then the same steps.
  const steps = (what: string, dir: string, name: string, text: string) => [
    `# shared-session: ${what}`,
    'umask 077',
    `f=${shellQuote(dir)}`,
    'mkdir -p "$f" && chmod 700 "$f" || exit 1',
    `t="$f/.${name}.$$"`,
    `printf '%s' ${shellQuote(text)} > "$t" && mv -f "$t" "$f/${name}" || { rm -f "$t"; exit 1; }`,
    '',
  ].join('\n')
  expect(firefoxProfileScript(PROFILE, 47100)).toBe(steps('settings for a preview window', `${PROFILE}/firefox`, 'user.js', firefoxUserJs(47100)))
  expect(chromePrefsScript(PROFILE, '{"webrtc":{}}')).toBe(steps('chrome preferences for a preview window', `${PROFILE}/chrome/Default`, 'Preferences', '{"webrtc":{}}'))
  // What it writes is quoted: a profile path or settings text can't run as script.
  expect(chromePrefsScript("/tmp/x'; rm -rf ~; '", "'; echo pwned; '")).toContain(shellQuote("'; echo pwned; '"))
})

test("a host's profile is taken before its window is looked for and started: one session of two makes the lock, its own secret in it", () => {
  const dir = '/home/scott/.claude/shared-session/browser', host = `${dir}/h-0123456789abcdef`
  const take = launchLockScript(dir, host, 'secret-a')
  expect(take.startsWith('# shared-session: take a preview profile to start its window\numask 077\n')).toBe(true)
  expect(take).toContain(`b=${shellQuote(dir)}; p=${shellQuote(host)}; l="$p/.launching"`)
  // The profile's folder first, private, as profileScript makes it; then mkdir, which of two at once only one makes.
  expect(take).toContain('mkdir -p "$b" && chmod 700 "$b" && mkdir -p "$p" && chmod 700 "$p" || exit 1')
  expect(take).toContain(`mkdir "$l" 2>/dev/null || exit ${LAUNCH_LOCK_BUSY}`)
  expect(take).toContain(`printf '%s\\n' ${shellQuote('secret-a')} > "$l/owner"`)
  // One left past the stale age by a session that's gone is taken over, before the mkdir.
  expect(LAUNCH_LOCK_STALE).toBe(2)
  const stale = take.indexOf('-mmin +2')
  expect(stale).toBeGreaterThan(0)
  expect(stale).toBeLessThan(take.indexOf('mkdir "$l"'))
  expect(take.trimEnd().endsWith('exit 0')).toBe(true)
  // Let go only by the session whose secret is in it.
  const done = launchUnlockScript(host, 'secret-a')
  expect(done.startsWith('# shared-session: done starting a preview profile')).toBe(true)
  expect(done).toContain(`[ "$(cat "$l/owner" 2>/dev/null)" = ${shellQuote('secret-a')} ] && rm -rf "$l"`)
  // Quoted: neither the path nor the secret can run as script.
  expect(launchLockScript(dir, "/tmp/x'; rm -rf ~; '", "s'; echo pwned; '")).toContain(shellQuote("s'; echo pwned; '"))
})

test("the proxy's lines are checked, anything else ignored", () => {
  expect(proxyLine('{"state":"ready","port":47100,"control":47001}')).toEqual({ state: 'ready', port: 47100, control: 47001 })
  expect(proxyLine('{"state":"ready","port":0,"control":47001}')).toBeNull()
  expect(proxyLine('{"state":"want","port":3610}')).toEqual({ state: 'want', port: 3610 })
  expect(proxyLine('{"state":"blocked","port":5432}')).toEqual({ state: 'blocked', port: 5432 })
  expect(proxyLine('{"state":"seen","port":3000}')).toEqual({ state: 'seen', port: 3000 })
  // A request to the guest's own network refused: no address, never the host it named.
  expect(proxyLine('{"state":"lan","host":"10.0.0.5"}')).toEqual({ state: 'lan' })
  // The person's own proxy left out, said once after ready; never what it was.
  expect(proxyLine('{"state":"upstream","reason":"INVALID_UPSTREAM"}')).toEqual({ state: 'upstream', reason: 'INVALID_UPSTREAM' })
  expect(proxyLine('{"state":"upstream","reason":"<b>","host":"proxy.corp"}')).toEqual({ state: 'upstream', reason: 'UPSTREAM' })
  expect(proxyLine('{"state":"error","code":"EADDRINUSE"}')).toEqual({ state: 'error', code: 'EADDRINUSE' })
  expect(proxyLine('{"state":"error","code":"<script>"}')).toEqual({ state: 'error', code: 'ERROR' })
  expect(proxyLine('{"state":"connect","host":"mail.google.com"}')).toBeNull()
  expect(proxyLine('not json')).toBeNull()
})
