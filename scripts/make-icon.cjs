'use strict'
// Renders build/icon.svg (the same artwork as Studio's favicon) to build/icon.png at
// 256 px, the size electron-builder needs to make the Windows .ico. Run: npm run build:icon
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const SIZE = 256
const SVG = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8')
  .replace('<svg ', `<svg width="${SIZE}" height="${SIZE}" `)

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
