'use strict'
// USB serial ports for Studio's Web Serial use (USB setup, firmware writing).
//
// A browser shows its own port chooser for navigator.serial.requestPort(); Electron
// leaves that to the app. The chooser here lists the ports with Hapbeat (Espressif)
// first. Chosen ports are remembered across launches, as Chrome does, so Studio's
// getPorts() can reconnect to them without asking again.

const fs = require('node:fs')
const path = require('node:path')
const { t } = require('./i18n')

// USB vendor IDs of the serial bridges Hapbeat boards use.
const ESPRESSIF_VID = 0x303a // ESP32-S3 native USB (Hapbeat)
const KNOWN_BRIDGE_VIDS = new Set([0x10c4, 0x1a86, 0x0403]) // CP210x, CH34x, FTDI

/** Electron reports USB ids as decimal strings; accept numbers and 0x-hex too. */
function usbId(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') return value
  const text = String(value).trim()
  const n = /^0x/i.test(text) ? parseInt(text, 16) : parseInt(text, 10)
  return Number.isFinite(n) ? n : null
}

/** What identifies a port across launches: vendor, product and (when the device has one) serial number. */
function portKey(port) {
  return {
    vendorId: usbId(port.vendorId),
    productId: usbId(port.productId),
    serialNumber: port.serialNumber || null,
  }
}

function sameDevice(a, b) {
  if (a.vendorId === null || a.vendorId !== b.vendorId || a.productId !== b.productId) return false
  // Without a serial number (e.g. CH340) the vendor + product pair is all there is.
  return !a.serialNumber || !b.serialNumber || a.serialNumber === b.serialNumber
}

function isHapbeatPort(port) {
  return usbId(port.vendorId) === ESPRESSIF_VID
}

/** Hapbeat first, then known USB-serial bridges, then the rest; each group by port name. */
function sortPorts(ports) {
  const rank = (p) => (isHapbeatPort(p) ? 0 : KNOWN_BRIDGE_VIDS.has(usbId(p.vendorId)) ? 1 : 2)
  return [...ports].sort((a, b) => rank(a) - rank(b) || String(a.portName).localeCompare(String(b.portName)))
}

function portLabel(port) {
  const name = isHapbeatPort(port) ? t('serial.hapbeat') : port.displayName || t('serial.unknown')
  return port.portName ? `${name} (${port.portName})` : name
}

/** Ports the user chose before, stored in the app's data folder. */
class SerialGrants {
  constructor(file) {
    this.file = file
    this.grants = []
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(data)) this.grants = data.filter((g) => g && typeof g === 'object')
    } catch {
      this.grants = []
    }
  }

  has(port) {
    const key = portKey(port)
    return this.grants.some((g) => sameDevice(g, key))
  }

  add(port) {
    const key = portKey(port)
    if (key.vendorId === null || this.has(port)) return
    this.grants.push(key)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.grants, null, 2))
    } catch {
      /* remembered for this run only */
    }
  }
}

/**
 * Ask which port to use. Resolves the chosen portId, or '' when cancelled / none.
 * One port that is a Hapbeat is chosen without asking (the common USB setup case).
 */
async function choosePort(dialog, win, portList) {
  const ports = sortPorts(portList || [])
  if (ports.length === 0) {
    await dialog.showMessageBox(win, {
      type: 'info',
      title: t('serial.title'),
      message: t('serial.none.message'),
      detail: t('serial.none.detail'),
      buttons: [t('common.ok')],
      noLink: true,
    })
    return ''
  }
  if (ports.length === 1 && isHapbeatPort(ports[0])) return ports[0].portId
  const shown = ports.slice(0, 8)
  const buttons = [...shown.map(portLabel), t('common.cancel')]
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: t('serial.title'),
    message: t('serial.message'),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  })
  return response < shown.length ? shown[response].portId : ''
}

module.exports = { SerialGrants, choosePort, sortPorts, portKey, usbId, isHapbeatPort, ESPRESSIF_VID }
