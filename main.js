// tweetbar: post to X without the paid API by driving your real, logged-in
// Google Chrome through AppleScript (one background tab, reused).
const { app, BrowserWindow, Notification, dialog, globalShortcut, ipcMain, screen, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const { execFile } = require('child_process')
const { createDrafter } = require('./drafts')

const HOTKEY = 'CommandOrControl+Shift+X'
const API_PORT = 4777
const DRAFT_EVERY_MS = 60 * 60 * 1000

let ui, bar, drafter, handle = null
const cacheFile = () => path.join(app.getPath('userData'), 'tweets.json')
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const settings = {
  read() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) } catch { return {} } },
  write(patch) { try { fs.writeFileSync(settingsFile(), JSON.stringify({ ...settings.read(), ...patch })) } catch {} },
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// --- Chrome driver ----------------------------------------------------------

// Every x.com action navigates the same Chrome tab, so run them one at a time.
let chain = Promise.resolve()
const queued = fn => (chain = chain.catch(() => {}).then(fn))

function osa(script, ...args) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, ...args], (err, out, errOut) => {
      if (!err) return resolve(out.trim())
      const msg = String(errOut || err.message)
      if (msg.includes('turned off')) return reject(new Error('In Chrome, turn on View → Developer → Allow JavaScript from Apple Events'))
      if (msg.includes('-1743')) return reject(new Error('Allow tweetbar to control Chrome: System Settings → Privacy & Security → Automation'))
      reject(new Error(msg.replace(/^.*execution error: /s, '').trim()))
    })
  })
}

// Chrome's AppleScript can't pick the profile for a new window, but a tab
// always belongs to its window's profile. So you pick one of your windows that
// is logged in to X, and we add one background tab at its end. That tab's id
// is saved and reused across reloads and restarts.
const NEED_PROFILE = 'NEED_PROFILE'

const GOTO = `on run argv
  set winId to (item 1 of argv) as integer
  set tabId to (item 2 of argv) as integer
  set theUrl to item 3 of argv
  set sourceId to (item 4 of argv) as integer
  tell application "Google Chrome"
    try
      set URL of tab id tabId of window id winId to theUrl
      return (winId as text) & "," & tabId
    end try
    if not (exists window id sourceId) then error "${NEED_PROFILE}"
    set w to window id sourceId
    set prevIdx to active tab index of w
    set t to make new tab at end of tabs of w with properties {URL:theUrl}
    set newTabId to id of t
    set active tab index of w to prevIdx
    return (sourceId as text) & "," & newTabId
  end tell
end run`

const EXEC = `on run argv
  tell application "Google Chrome" to execute tab id ((item 2 of argv) as integer) of window id ((item 1 of argv) as integer) javascript (item 3 of argv)
end run`

const CLOSE_TAB = `on run argv
  tell application "Google Chrome" to close tab id ((item 2 of argv) as integer) of window id ((item 1 of argv) as integer)
end run`

// Lists your windows and whether each one's profile allows scripting.
// (Inside a Chrome tell block "tab" means a browser tab, hence character id 9.)
const LIST_WINDOWS = `set sep to character id 9
tell application "Google Chrome"
  set out to ""
  repeat with w in windows
    set ok to "1"
    try
      execute active tab of w javascript "1"
    on error errMsg
      if errMsg contains "turned off" then set ok to "0"
    end try
    set out to out & (id of w) & sep & ok & sep & (count of tabs of w) & sep & (title of active tab of w) & linefeed
  end repeat
  return out
end tell`

async function listChromeWindows() {
  const out = await osa(LIST_WINDOWS)
  return out.split('\n').filter(Boolean).map(line => {
    const [id, ok, tabs, ...title] = line.split('\t')
    return { id: Number(id), scriptable: ok === '1', tabs: Number(tabs), title: title.join('\t') }
  })
}

const tabRef = () => settings.read().tab || { win: 0, tab: 0 }

async function closeOurTab() {
  const { win, tab } = tabRef()
  if (tab) await osa(CLOSE_TAB, String(win), String(tab)).catch(() => {})
  settings.write({ tab: null })
}

async function goto(url) {
  const { win, tab } = tabRef()
  const out = await osa(GOTO, String(win), String(tab), url, String(settings.read().sourceWindowId || 0))
  const [w, t] = out.split(',').map(Number)
  if (w !== win || t !== tab) settings.write({ tab: { win: w, tab: t } })
  await sleep(1000)
}

async function exec(js) {
  const { win, tab } = tabRef()
  const out = await osa(EXEC, String(win), String(tab), `JSON.stringify(${js}) ?? 'null'`)
  try { return JSON.parse(out) } catch { return null }
}

async function waitFor(js, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const v = await exec(js)
    if (v) return v
    await sleep(400)
  }
  throw new Error('Timed out waiting for x.com')
}

const DETECT_HANDLE = `(() => {
  const a = document.querySelector('[data-testid="AppTabBar_Profile_Link"]')
  if (a) return a.getAttribute('href').slice(1)
  // Logged out, /home redirects to the "/" landing page (or a login flow).
  const landing = location.pathname === '/' && document.body.innerText.trim().length > 20
  if (landing || /login|\\/i\\/flow/.test(location.pathname)) return '__LOGGED_OUT__'
  return null
})()`

async function detectHandle() {
  await goto('https://x.com/home')
  const h = await waitFor(DETECT_HANDLE, 20000)
  handle = h === '__LOGGED_OUT__' ? null : h
  return handle
}

async function postTweet(text) {
  if (!handle) throw new Error('Not logged in to X')
  await goto('https://x.com/home')
  const editor = '[data-testid="tweetTextarea_0"]'
  await waitFor(`!!document.querySelector('${editor}')`)
  // A synthetic paste is what X's Draft.js editor handles most reliably (keeps newlines).
  await exec(`(() => {
    const el = document.querySelector('${editor}')
    el.focus()
    const dt = new DataTransfer()
    dt.setData('text/plain', ${JSON.stringify(text)})
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })()`)
  await waitFor(`(() => {
    const b = document.querySelector('[data-testid="tweetButtonInline"]')
    return b && b.getAttribute('aria-disabled') !== 'true'
  })()`, 5000).catch(() => { throw new Error('X did not accept the text (editor may have changed)') })
  await exec(`document.querySelector('[data-testid="tweetButtonInline"]').click()`)
  // Success = X clears the editor. A failure (duplicate, rate limit) leaves it and shows a toast.
  try {
    await waitFor(`document.querySelector('${editor}')?.innerText.trim() === ''`, 15000)
  } catch {
    const toast = await exec(`document.querySelector('[data-testid="toast"]')?.innerText || ''`).catch(() => '')
    throw new Error(toast || 'Post did not go through')
  }
}

async function fetchMyTweets() {
  if (!handle) return []
  await goto(`https://x.com/${handle}`)
  await waitFor(`document.querySelectorAll('article[data-testid="tweet"]').length > 0`).catch(() => {})
  await sleep(800) // let the first batch finish rendering
  const own = `/${handle.toLowerCase()}/status/`
  const tweets = (await exec(`[...document.querySelectorAll('article[data-testid="tweet"]')].map(a => {
    const t = a.querySelector('time')
    const href = t?.closest('a')?.getAttribute('href') || ''
    return { text: a.querySelector('[data-testid="tweetText"]')?.innerText || '', at: t?.getAttribute('datetime'), url: 'https://x.com' + href }
  }).filter(t => t.url.toLowerCase().includes(${JSON.stringify(own)}))`)) || []
  tweets.sort((a, b) => (b.at || '').localeCompare(a.at || ''))
  try { fs.writeFileSync(cacheFile(), JSON.stringify(tweets)) } catch {}
  return tweets
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) } catch { return [] }
}

const send = (ch, data) => ui && !ui.isDestroyed() && ui.webContents.send(ch, data)

function refresh() {
  return queued(fetchMyTweets)
    .then(tweets => send('tweets', tweets))
    .catch(err => send('status', { error: err.message }))
}

// Only pop a system notification when you aren't looking at the log window.
function notify(title, body) {
  if (ui.isFocused() || !Notification.isSupported()) return
  new Notification({ title, body, silent: true }).show()
}

// Every post (log window, quick bar, or the agent API) flows through here, so
// the log window always shows it live.
function post(text) {
  text = String(text || '').trim()
  if (!text) return Promise.reject(new Error('Empty tweet'))
  send('posting', { text })
  return queued(() => postTweet(text)).then(() => {
    send('posted', { text })
    notify('Shipped ✓', text)
    refresh()
    return { ok: true }
  }, err => {
    send('failed', { text, error: err.message })
    notify('Post failed', err.message)
    throw err
  })
}

// Ask which Chrome window (profile) to use. `reason` is shown above the list.
async function askForProfile(reason) {
  handle = null
  send('status', { handle: null })
  const windows = await listChromeWindows()
  send('pick', { reason, windows })
}

// Find out who is logged in to x.com in Chrome, then load their tweets.
function connect() {
  return queued(detectHandle).then(async h => {
    if (h) {
      send('status', { handle: h })
      return refresh()
    }
    // Our tab is in a profile that isn't logged in to X: drop it and ask.
    await closeOurTab()
    settings.write({ sourceWindowId: 0 })
    await askForProfile('That Chrome profile isn’t logged in to X. Pick another window.')
  }).catch(err => {
    if (err.message.includes(NEED_PROFILE)) return askForProfile('Which Chrome window is logged in to X?')
    send('status', { error: err.message })
  }).catch(err => send('status', { error: err.message }))
}

function pickChromeWindow(id) {
  return queued(closeOurTab).then(() => {
    settings.write({ sourceWindowId: Number(id) })
    return connect()
  })
}

// --- windows ----------------------------------------------------------------

const openLinksExternally = win => win.webContents.setWindowOpenHandler(({ url }) => {
  if (url.startsWith('https://x.com/')) shell.openExternal(url)
  return { action: 'deny' }
})

function createWindow() {
  ui = new BrowserWindow({
    width: 600, height: 820, minWidth: 440, minHeight: 480, title: 'tweetbar',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 },
    vibrancy: 'under-window', visualEffectState: 'active', backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  openLinksExternally(ui)
  ui.loadFile('index.html')
}

// The quick bar: a floating Spotlight-style composer summoned by the hotkey.
const BAR_WIDTH = 680
function createBar() {
  bar = new BrowserWindow({
    width: BAR_WIDTH, height: 120, show: false, frame: false, transparent: true,
    resizable: false, movable: false, alwaysOnTop: true, skipTaskbar: true,
    fullscreenable: false, hasShadow: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  bar.loadFile('index.html', { hash: 'bar' })
  bar.on('blur', () => bar.hide())
}

function toggleBar() {
  if (bar.isVisible()) return bar.hide()
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  bar.setPosition(Math.round(workArea.x + (workArea.width - BAR_WIDTH) / 2), Math.round(workArea.y + workArea.height * 0.24))
  bar.show(); bar.focus(); bar.webContents.send('focus')
}

ipcMain.handle('init', () => {
  connect()
  return { tweets: readCache(), drafts: drafter.list(), hotkey: HOTKEY }
})
ipcMain.handle('post', (_e, text) => post(text).catch(err => ({ error: err.message })))
ipcMain.handle('refresh', () => (handle ? refresh() : connect()))
ipcMain.handle('chrome:switch', () => queued(() => askForProfile('Which Chrome window is logged in to X?')).catch(err => send('status', { error: err.message })))
ipcMain.handle('chrome:pick', (_e, id) => pickChromeWindow(id))
ipcMain.handle('bar:hide', () => bar.hide())
ipcMain.handle('drafts:scan', () => runDraftScan({ force: true }))
ipcMain.handle('drafts:dismiss', (_e, id) => drafter.remove(id))
ipcMain.handle('drafts:post', (_e, id) => {
  const d = drafter.get(id)
  if (!d) return { error: 'Draft not found' }
  return post(d.text).then(() => { drafter.remove(id); return { ok: true } }, err => ({ error: err.message }))
})
ipcMain.handle('repos:list', () => settings.read().draftRepos || [])
ipcMain.handle('repos:add', async () => {
  const r = await dialog.showOpenDialog(ui, { title: 'Draft tweets from this repo', properties: ['openDirectory'] })
  if (r.canceled || !r.filePaths[0]) return settings.read().draftRepos || []
  const repos = [...new Set([...(settings.read().draftRepos || []), r.filePaths[0]])]
  settings.write({ draftRepos: repos })
  return repos
})
ipcMain.handle('repos:remove', (_e, repo) => {
  const repos = (settings.read().draftRepos || []).filter(r => r !== repo)
  settings.write({ draftRepos: repos })
  return repos
})
ipcMain.handle('bar:height', (_e, h) => bar.setSize(BAR_WIDTH, Math.max(80, Math.min(420, Math.round(h)))))

// --- drafts -------------------------------------------------------------------

function setupDrafter() {
  // Default allowlist is this app's own repo when run from source; the packaged
  // app starts empty and you add repos from the sources panel.
  if (!settings.read().draftRepos) settings.write({ draftRepos: app.isPackaged ? [] : [__dirname] })
  drafter = createDrafter({
    dir: app.getPath('userData'),
    settings,
    getContext: () => ({ handle, pastTweets: readCache().slice(0, 15).map(t => t.text) }),
    onChange: drafts => send('drafts', drafts),
  })
}

// At most one nudge a day, and only when you haven't tweeted today.
function nudge(added) {
  const today = new Date().toDateString()
  const tweetedToday = readCache().some(t => t.at && new Date(t.at).toDateString() === today)
  if (!added || tweetedToday || settings.read().lastNudge === today || ui.isFocused() || !Notification.isSupported()) return
  settings.write({ lastNudge: today })
  const n = new Notification({ title: 'You shipped today', body: `${added} tweet draft${added > 1 ? 's' : ''} ready from your commits.`, silent: true })
  n.on('click', () => { ui.show(); ui.focus() })
  n.show()
}

function runDraftScan(opts) {
  send('drafting', true)
  return drafter.scan(opts)
    .then(added => { nudge(added); return { added } }, err => ({ error: err.message }))
    .finally(() => send('drafting', false))
}

// --- local API for agents (curl / Claude Code) --------------------------------
// Bound to 127.0.0.1 and rejects any request carrying an Origin header, so a web
// page in your browser can't tweet on your behalf.

function startApi() {
  http.createServer((req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.headers.origin) return reply(403, { error: 'browser requests not allowed' })
    if (req.method === 'GET' && req.url === '/tweets') return reply(200, { handle, tweets: readCache() })
    if (req.method === 'POST' && req.url === '/tweet') {
      let body = ''
      req.on('data', c => { body += c; if (body.length > 1e5) req.destroy() })
      req.on('end', () => {
        let text
        try { text = JSON.parse(body).text } catch { return reply(400, { error: 'send JSON {"text": "..."}' }) }
        post(text).then(r => reply(200, r), err => reply(500, { error: err.message }))
      })
      return
    }
    if (req.method === 'POST' && req.url === '/draft') {
      let body = ''
      req.on('data', c => { body += c; if (body.length > 1e5) req.destroy() })
      req.on('end', () => {
        let data
        try { data = JSON.parse(body) } catch { return reply(400, { error: 'send JSON {"text": "...", "source": "..."}' }) }
        if (!String(data.text || '').trim()) return reply(400, { error: 'empty draft' })
        drafter.add(data.text, data.source || 'agent')
        reply(200, { ok: true })
      })
      return
    }
    reply(404, { error: 'GET /tweets, POST /tweet, or POST /draft' })
  }).on('error', err => send('status', { error: `API port ${API_PORT}: ${err.message}` }))
    .listen(API_PORT, '127.0.0.1')
}

app.whenReady().then(() => {
  setupDrafter()
  createWindow()
  createBar()
  startApi()
  setTimeout(() => runDraftScan(), 15000)
  setInterval(() => runDraftScan(), DRAFT_EVERY_MS)
  globalShortcut.register(HOTKEY, toggleBar)
})

app.on('activate', () => ui && ui.show())
app.on('before-quit', () => { app.isQuitting = true })
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => {}) // stay alive in the dock for the hotkey
