'use strict'
// Updates of the app itself (the window + the bundled helper) from GitHub Releases.
// Studio's own screens never need this: they are loaded from studio.hapbeat.com.

const { app, dialog } = require('electron')
const { t } = require('./i18n')

let autoUpdater = null
let lastResult = { state: 'idle' }
let readyVersion = null

function getUpdater() {
  if (!app.isPackaged) return null
  if (!autoUpdater) {
    autoUpdater = require('electron-updater').autoUpdater
    autoUpdater.autoDownload = true
    // Stable releases only. (A development build such as 0.1.0-d1 would otherwise look
    // only for releases of its own prerelease channel "d1" and never update.)
    autoUpdater.allowPrerelease = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('update-downloaded', (info) => {
      readyVersion = info.version
      lastResult = { state: 'downloaded', version: info.version }
      void askRestart(info.version)
    })
    autoUpdater.on('error', (err) => {
      lastResult = { state: 'error', error: String(err?.message || err) }
    })
  }
  return autoUpdater
}

async function askRestart(version) {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Hapbeat Studio',
    message: t('update.ready.message', { version }),
    detail: t('update.ready.detail'),
    buttons: [t('update.restart'), t('update.later')],
    // "Later" by default: Enter must not restart in the middle of a firmware write.
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (response === 0) getUpdater()?.quitAndInstall()
}

/**
 * Check now. Resolves { state: 'dev' | 'none' | 'downloading' | 'downloaded' | 'error', version?, error? }.
 * A found update downloads in the background and asks to restart when ready.
 */
async function checkForUpdates() {
  const updater = getUpdater()
  if (!updater) return { state: 'dev', version: app.getVersion() }
  if (readyVersion) return { state: 'downloaded', version: readyVersion }
  try {
    const result = await updater.checkForUpdates()
    const latest = result?.updateInfo?.version
    lastResult = result?.isUpdateAvailable && latest
      ? { state: 'downloading', version: latest }
      : { state: 'none', version: app.getVersion() }
  } catch (err) {
    lastResult = { state: 'error', error: String(err?.message || err) }
  }
  return lastResult
}

/** Menu → "Check for updates": the same check, answered in a dialog. */
async function checkFromMenu(win) {
  const result = await checkForUpdates()
  const message =
    result.state === 'dev' ? t('update.dev')
      : result.state === 'none' ? t('update.none', { version: result.version })
        : result.state === 'downloading' ? t('update.downloading', { version: result.version })
          : result.state === 'downloaded' ? t('update.ready.message', { version: result.version })
            : t('update.failed')
  if (result.state === 'downloaded') return askRestart(result.version)
  await dialog.showMessageBox(win, {
    type: result.state === 'error' ? 'warning' : 'info',
    title: 'Hapbeat Studio',
    message,
    detail: result.error || undefined,
    buttons: [t('common.ok')],
    noLink: true,
  })
}

module.exports = { checkForUpdates, checkFromMenu }
