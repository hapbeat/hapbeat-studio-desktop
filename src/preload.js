'use strict'
// The only bridge between Studio (web page) and the app. Studio checks for
// `window.hapbeatDesktop` to show its desktop layout and the helper panel.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hapbeatDesktop', {
  shell: 'electron',
  /** Raised when this API changes; Studio checks it before using newer calls. */
  apiVersion: 3,
  /**
   * (2) getDisplayMedia({ video, audio }) from a click returns what the PC plays
   * (system audio, no picker) plus Studio's own page as the video track to stop.
   */
  systemAudio: process.platform === 'win32',
  /** { appVersion, platform, helper, studio } */
  getInfo: () => ipcRenderer.invoke('desktop:info'),
  helper: {
    /** { state, source, version, port, error } */
    status: () => ipcRenderer.invoke('desktop:helper-status'),
    restart: () => ipcRenderer.invoke('desktop:helper-restart'),
    openLogFolder: () => ipcRenderer.invoke('desktop:open-log-folder'),
    /** Called on every helper state change; returns an unsubscribe function. */
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('desktop:helper-status', listener)
      return () => ipcRenderer.removeListener('desktop:helper-status', listener)
    },
  },
  /**
   * (3) Where Studio's page came from: { mode: 'online' | 'offline', copy: { id, savedAt,
   * source: 'saved' | 'bundled' } | null } — offline = the saved copy, as no network answered.
   */
  studio: {
    status: () => ipcRenderer.invoke('desktop:studio-status'),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('desktop:studio-status', listener)
      return () => ipcRenderer.removeListener('desktop:studio-status', listener)
    },
  },
  /** { state: 'dev' | 'none' | 'downloading' | 'downloaded' | 'error', version?, error? } */
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-updates'),
})
