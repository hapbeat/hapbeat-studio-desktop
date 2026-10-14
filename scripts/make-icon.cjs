'use strict'
// Renders Studio's favicon (the same artwork) to build/icon.png at 256 px, the size
// electron-builder needs to make the Windows .ico. Run: npm run build:icon
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const SIZE = 256
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${SIZE}" height="${SIZE}" fill="none">
  <rect width="64" height="64" rx="12" fill="#1a1a2e"/>
  <path d="M16 40 Q24 16 32 32 Q40 48 48 24" stroke="#7c5cbf" stroke-width="5" stroke-linecap="round" fill="none"/>
  <path d="M16 40 Q24 16 32 32 Q40 48 48 24" stroke="#a78bfa" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.6" stroke-dasharray="4 4"/>
</svg>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true },
  })
  const html = `<html><body style="margin:0;background:transparent">${SVG}</body></html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 300))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
  const out = path.join(__dirname, '..', 'build', 'icon.png')
  fs.writeFileSync(out, image.resize({ width: SIZE, height: SIZE }).toPNG())
  console.log(`wrote ${out}`)
  app.quit()
})
