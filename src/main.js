'use strict'
// Hapbeat Studio for Windows.
//
// The window shows the online Studio (studio.hapbeat.com), loaded on every launch,
// so a Studio deploy — screens, templates, firmware list — reaches the app without
// reinstalling it. The app adds only what a browser cannot do by itself:
//   - the Hapbeat Helper, bundled and started with the app (no Python / pipx)
//   - a chooser for USB serial ports (Web Serial)
//   - updates of the app itself (when the bundled helper or this shell changes)

const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron')
const { HelperProcess, DEFAULT_PORT } = require('./helper')
const { SerialGrants, choosePort } = require('./serial')
const { resolveStudioUrl, isStudioOrigin, isExternalWebUrl } = require('./urls')
const { setLocale, t } = require('./i18n')
const updater = require('./updater')

const DOCS_URL = 'https://devtools.hapbeat.com/docs/tools/studio/initial-setup/'
const OFFLINE_PAGE = path.join(__dirname, 'offline.html')

const studioUrl = resolveStudioUrl()
let mainWindow = null
let helper = null

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

function bundledHelperPath() {
  // Packaged: <install>/resources/helper/. Development: helper/dist/ of this repo.
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'helper')
    : path.join(__dirname, '..', 'helper', 'dist', 'hapbeat-helper')
  return path.join(base, 'hapbeat-helper.exe')
}

function isTrustedPage(url) {
  return isStudioOrigin(url, studioUrl) || url.startsWith(pathToFileURL(OFFLINE_PAGE).href)
}

async function onReady() {
  setLocale(app.getLocale())
  app.setAppUserModelId('com.hapbeat.studio.desktop')

  const port = Number(process.env.HAPBEAT_HELPER_PORT) || DEFAULT_PORT
  helper = new HelperProcess({ exePath: bundledHelperPath(), logDir: app.getPath('logs'), port })
  helper.on('status', (status) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('desktop:helper-status', status)
  })
  void helper.start()

  setupSession(session.defaultSession)
  setupIpc()
  Menu.setApplicationMenu(buildMenu())
  createWindow()
  if (app.isPackaged) setTimeout(() => void updater.checkForUpdates(), 5000)
}

function setupSession(ses) {
  const grants = new SerialGrants(path.join(app.getPath('userData'), 'serial-grants.json'))

  // Studio is our own page; it gets what Chrome would let it ask for. Nothing else does.
  const REQUESTABLE = new Set([
    'serial', 'fileSystem', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen',
    'pointerLock', 'storage-access', 'top-level-storage-access', 'notifications',
  ])
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = details?.requestingUrl || webContents?.getURL()
    callback(isStudioOrigin(origin, studioUrl) && REQUESTABLE.has(permission))
  })
  ses.setPermissionCheckHandler((_webContents, _permission, requestingOrigin) =>
    isStudioOrigin(requestingOrigin, studioUrl))

  // Web Serial: ports chosen once stay usable across launches (as in Chrome).
  ses.setDevicePermissionHandler((details) =>
    details.deviceType === 'serial'
    && isStudioOrigin(details.origin, studioUrl)
    && grants.has(details.device))
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault()
    if (!isStudioOrigin(webContents.getURL(), studioUrl)) return callback('')
    const win = BrowserWindow.fromWebContents(webContents) || mainWindow
    void choosePort(dialog, win, portList).then((portId) => {
      const port = portList.find((p) => p.portId === portId)
      if (port) grants.add(port)
      callback(portId)
    })
  })
}

function setupIpc() {
  const guard = (handler) => (event, ...args) => {
    if (!isTrustedPage(event.senderFrame?.url || '')) throw new Error('not allowed')
    return handler(event, ...args)
  }
  ipcMain.handle('desktop:info', guard(() => ({
    appVersion: app.getVersion(),
    platform: process.platform,
    helper: helper.status(),
  })))
  ipcMain.handle('desktop:helper-status', guard(() => helper.status()))
  ipcMain.handle('desktop:helper-restart', guard(() => helper.restart()))
  ipcMain.handle('desktop:open-log-folder', guard(() => shell.openPath(app.getPath('logs'))))
  ipcMain.handle('desktop:check-updates', guard(() => updater.checkForUpdates()))
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

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3 = aborted (a navigation replaced this one), not a failure.
    if (!isMainFrame || code === -3 || !isStudioOrigin(url, studioUrl)) return
    void mainWindow.loadFile(OFFLINE_PAGE, {
      query: { target: studioUrl.href, error: `${description} (${code})`, lang: app.getLocale() },
    })
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  void mainWindow.loadURL(studioUrl.href)
}

// Every window (the main one and Studio's pop-outs) stays on Studio; other links
// open in the default browser.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (isTrustedPage(url)) return
    event.preventDefault()
    if (isExternalWebUrl(url)) void shell.openExternal(url)
  })
  contents.setWindowOpenHandler(({ url }) => {
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

let quitting = false
app.on('before-quit', (event) => {
  if (quitting || !helper) return
  // Stop the bundled helper before exiting so its ports are free for the next launch.
  event.preventDefault()
  quitting = true
  void helper.stop().finally(() => app.quit())
})

app.on('window-all-closed', () => app.quit())
