'use strict'
// Hapbeat Studio for Windows.
//
// The window shows the online Studio (studio.hapbeat.com), loaded on every launch,
// so a Studio deploy — screens, templates, firmware list — reaches the app without
// reinstalling it. Without a network it opens the last saved copy of Studio
// (studioCache.js). The app adds only what a browser cannot do by itself:
//   - the Hapbeat Helper, bundled and started with the app (no Python / pipx)
//   - a chooser for USB serial ports (Web Serial)
//   - updates of the app itself (when the bundled helper or this shell changes)
//   - what the PC plays (Windows loopback) for Studio's "PC sound → Hapbeat" button

const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, Menu, dialog, ipcMain, net, session, shell } = require('electron')
const { HelperProcess, DEFAULT_PORT } = require('./helper')
const { StudioCache, StudioServer, MANIFEST } = require('./studioCache')
const { SerialGrants, choosePort } = require('./serial')
const { resolveStudioUrl, isStudioOrigin, isExternalWebUrl } = require('./urls')
const { isDisplayCaptureRequest, systemAudioGrant } = require('./systemAudio')
const { setLocale, t } = require('./i18n')
const updater = require('./updater')

const DOCS_URL = 'https://devtools.hapbeat.com/docs/tools/studio/initial-setup/'
const OFFLINE_PAGE = path.join(__dirname, 'offline.html')

// What Studio may use (asked or checked). Studio is our own page; nothing else gets any.
const STUDIO_PERMISSIONS = new Set([
  'serial', 'fileSystem', 'clipboard-read', 'clipboard-sanitized-write', 'notifications',
  'fullscreen', 'pointerLock', 'persistent-storage', 'storage-access', 'top-level-storage-access',
  // ws://localhost:7703 (the helper) from the https Studio page.
  'local-network-access', 'local-network', 'loopback-network',
])

// Development checks run with their own data folder (fresh cache, no single-instance clash).
if (!app.isPackaged && process.env.HAPBEAT_DESKTOP_USER_DATA) {
  app.setPath('userData', process.env.HAPBEAT_DESKTOP_USER_DATA)
}

const studioUrl = resolveStudioUrl(process.env, { packaged: app.isPackaged })
let mainWindow = null
let helper = null
let studioCache = null
let studioServer = null
let studioCopySynced = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.whenReady().then(onReady)
}

/** One line into logs/app.log (things the user never sees but support may need). */
function appLog(line) {
  try {
    const file = path.join(app.getPath('logs'), 'app.log')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.old`)
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* logging must never break the app */
  }
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

function bundledSnapshotDir() {
  // Packaged: <install>/resources/studio-snapshot/. Development: studio-snapshot/ of this repo.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'studio-snapshot')
    : path.join(__dirname, '..', 'studio-snapshot')
}

function bundledHelperPath() {
  // Packaged: <install>/resources/helper/. Development: helper/dist/ of this repo.
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'helper')
    : path.join(__dirname, '..', 'helper', 'dist', 'hapbeat-helper')
  return path.join(base, 'hapbeat-helper.exe')
}

async function onReady() {
  setLocale(app.getLocale())
  app.setAppUserModelId('com.hapbeat.studio.desktop')

  const port = Number(process.env.HAPBEAT_HELPER_PORT) || DEFAULT_PORT
  helper = new HelperProcess({ exePath: bundledHelperPath(), logDir: app.getPath('logs'), port })
  helper.on('status', (status) => broadcast('desktop:helper-status', status))
  void helper.start()

  studioCache = new StudioCache({
    cacheDir: path.join(app.getPath('userData'), 'studio-cache'),
    bundledDir: bundledSnapshotDir(),
  })
  studioServer = new StudioServer({
    cache: studioCache,
    origin: studioUrl.origin,
    fetch: (request, init) => net.fetch(request, { ...init, bypassCustomProtocolHandlers: true }),
  })
  studioServer.on('status', (status) => broadcast('desktop:studio-status', status))

  setupSession(session.defaultSession)
  setupIpc()
  Menu.setApplicationMenu(buildMenu())
  createWindow()
  if (app.isPackaged) setTimeout(() => void updater.checkForUpdates(), 5000)
}

function setupSession(ses) {
  const grants = new SerialGrants(path.join(app.getPath('userData'), 'serial-grants.json'))

  // Every request of the window to Studio's origin goes through the saved-copy
  // fallback; other origins pass straight to the network.
  ses.protocol.handle(studioUrl.protocol.slice(0, -1), (request) => studioServer.handle(request))

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = details?.requestingUrl || webContents?.getURL()
    callback(isStudioOrigin(origin, studioUrl)
      && (STUDIO_PERMISSIONS.has(permission) || isDisplayCaptureRequest(permission, details)))
  })
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    isStudioOrigin(requestingOrigin, studioUrl) && STUDIO_PERMISSIONS.has(permission))

  // Web Serial: ports chosen once stay usable across launches (as in Chrome).
  ses.setDevicePermissionHandler((details) =>
    details.deviceType === 'serial'
    && isStudioOrigin(details.origin, studioUrl)
    && grants.has(details.device))
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault()
    if (!isStudioOrigin(webContents.getURL(), studioUrl)) return callback('')
    const win = BrowserWindow.fromWebContents(webContents) || mainWindow
    choosePort(dialog, win, portList)
      .then((portId) => {
        const port = portList.find((p) => p.portId === portId)
        if (port) grants.add(port)
        callback(portId)
      })
      .catch(() => callback(''))
  })

  // PC sound → Hapbeat: Studio's getDisplayMedia (from a click) gets the system audio
  // without a picker (see systemAudio.js); anything else is refused.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    callback(systemAudioGrant(request, studioUrl))
  })
}

function setupIpc() {
  const guard = (handler) => (event, ...args) => {
    if (!isStudioOrigin(event.senderFrame?.url || '', studioUrl)) throw new Error('not allowed')
    return handler(event, ...args)
  }
  ipcMain.handle('desktop:info', guard(() => ({
    appVersion: app.getVersion(),
    platform: process.platform,
    helper: helper.status(),
    studio: studioServer.status(),
  })))
  ipcMain.handle('desktop:studio-status', guard(() => studioServer.status()))
  ipcMain.handle('desktop:helper-status', guard(() => helper.status()))
  ipcMain.handle('desktop:helper-restart', guard(() => helper.restart()))
  ipcMain.handle('desktop:open-log-folder', guard(() => shell.openPath(app.getPath('logs'))))
  ipcMain.handle('desktop:check-updates', guard(() => updater.checkForUpdates()))
}

/**
 * After an online page load, keep a copy of the Studio build now deployed (once per
 * run; a failed attempt is retried on the next load). Studio lists its files in
 * /precache.json; a development server without it is skipped quietly.
 */
function saveStudioCopy() {
  if (studioCopySynced || studioServer.offline) return
  const get = async (rel) => {
    const url = `${studioUrl.origin}/${rel.split('/').map(encodeURIComponent).join('/')}`
    const res = await net.fetch(url, { bypassCustomProtocolHandlers: true, cache: 'no-store' })
    if (!res.ok) throw new Error(`${res.status} ${rel}`)
    return Buffer.from(await res.arrayBuffer())
  }
  studioCache.sync(async () => (await get(MANIFEST)).toString('utf8'), get)
    .then((result) => {
      studioCopySynced = true
      if (result.updated) {
        appLog(`saved Studio build ${result.id}`)
        broadcast('desktop:studio-status', studioServer.status())
      }
    })
    .catch((err) => appLog(`could not save a copy of Studio: ${err.message}`))
}

function showOffline(error) {
  if (!mainWindow) return
  void mainWindow.loadFile(OFFLINE_PAGE, {
    query: { target: studioUrl.href, error, lang: app.getLocale() },
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    title: 'Hapbeat Studio',
    backgroundColor: '#1a1a2e',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  // Development check runs keep the PC silent (HAPBEAT_DESKTOP_MUTE=1).
  if (process.env.HAPBEAT_DESKTOP_MUTE === '1') mainWindow.webContents.setAudioMuted(true)

  // Reached only when there is no saved copy either (studioCache.js answers otherwise).
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3 = aborted (a navigation replaced this one), not a failure.
    if (!isMainFrame || code === -3 || !isStudioOrigin(url, studioUrl)) return
    showOffline(`${description} (${code})`)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    if (isStudioOrigin(mainWindow?.webContents.getURL(), studioUrl)) saveStudioCopy()
  })
  // A network that redirects elsewhere (a hotel / venue sign-in page) is not Studio:
  // open the saved copy instead (or the offline page when there is none).
  mainWindow.webContents.on('will-redirect', (details) => {
    if (!details.isMainFrame || isStudioOrigin(details.url, studioUrl)) return
    details.preventDefault()
    if (studioCache.current()) {
      studioServer.useCopyForNextLoad()
      void mainWindow.loadURL(studioUrl.href)
    } else {
      showOffline(new URL(details.url).host)
    }
  })
  // Closing the main window ends the app, pop-outs included.
  mainWindow.on('closed', () => {
    mainWindow = null
    app.quit()
  })
  void mainWindow.loadURL(studioUrl.href)
}

app.on('web-contents-created', (_event, contents) => {
  // Every window (the main one and Studio's pop-outs) stays on Studio; other links
  // open in the default browser.
  contents.on('will-navigate', (details) => {
    if (isStudioOrigin(details.url, studioUrl)) return
    details.preventDefault()
    if (isExternalWebUrl(details.url)) void shell.openExternal(details.url)
  })
  contents.setWindowOpenHandler(({ url }) => {
    // Studio's pop-outs: window.open('', name) and fills it in, or a page of its own.
    if (url === 'about:blank' || url === '' || isStudioOrigin(url, studioUrl)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: '#1a1a2e',
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
        },
      }
    }
    if (isExternalWebUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Studio asks before discarding unsaved edits (beforeunload). A browser shows its
  // own "Leave site?" prompt; Electron leaves that to the app.
  contents.on('will-prevent-unload', (event) => {
    const win = BrowserWindow.fromWebContents(contents)
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Hapbeat Studio',
      message: t('unload.message'),
      detail: t('unload.detail'),
      buttons: [t('unload.leave'), t('common.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (choice === 0) event.preventDefault() // ignore beforeunload and close
  })
})

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.reload'), accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: t('menu.help'),
      submenu: [
        { label: t('menu.docs'), click: () => void shell.openExternal(DOCS_URL) },
        { label: t('menu.updates'), click: () => void updater.checkFromMenu(mainWindow) },
        { label: t('menu.logs'), click: () => void shell.openPath(app.getPath('logs')) },
        { type: 'separator' },
        {
          label: t('menu.about'),
          click: () => void dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Hapbeat Studio',
            message: `Hapbeat Studio ${app.getVersion()}`,
            detail: [
              `Studio: ${studioUrl.origin}`,
              `Helper: ${helper.status().source === 'external' ? 'external' : helper.status().version || '-'}`,
              `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
            ].join('\n'),
            buttons: [t('common.ok')],
            noLink: true,
          }),
        },
      ],
    },
  ])
}

// The bundled helper stops once every window has closed (a window kept open by
// unsaved edits cancels the quit before anything is stopped). Its ports and files
// are then free for the next launch or an update.
let helperStopped = false
app.on('will-quit', (event) => {
  if (helperStopped || !helper) return
  if (!helper.isBundledRunning()) {
    // Nothing of ours to wait for (an adopted helper keeps running).
    helperStopped = true
    void helper.stop()
    return
  }
  event.preventDefault()
  void helper.stop().finally(() => {
    helperStopped = true
    // Quit again on a later turn: a quit requested while this will-quit is still
    // being handled is ignored, and the app would stay open with no window.
    setTimeout(() => app.quit(), 0)
  })
})

app.on('window-all-closed', () => app.quit())
