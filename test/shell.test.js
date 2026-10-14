'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const { resolveStudioUrl, isStudioOrigin, isExternalWebUrl } = require('../src/urls')
const { SerialGrants, choosePort, sortPorts, usbId, isHapbeatPort } = require('../src/serial')
const { HelperProcess, isPortOpen, parseStartLine } = require('../src/helper')

test('Studio URL: production by default, marked as the desktop shell', () => {
  const url = resolveStudioUrl({})
  assert.equal(url.origin, 'https://studio.hapbeat.com')
  assert.equal(url.searchParams.get('shell'), 'desktop')
  const dev = resolveStudioUrl({ HAPBEAT_STUDIO_URL: 'http://localhost:5175/?x=1' })
  assert.equal(dev.origin, 'http://localhost:5175')
  assert.equal(dev.searchParams.get('x'), '1')
  assert.throws(() => resolveStudioUrl({ HAPBEAT_STUDIO_URL: 'file:///c:/x.html' }))
})

test('only the Studio origin is trusted; web links go to the browser', () => {
  const studio = resolveStudioUrl({})
  assert.ok(isStudioOrigin('https://studio.hapbeat.com/popout.html', studio))
  assert.ok(isStudioOrigin('https://studio.hapbeat.com', studio))
  assert.ok(!isStudioOrigin('https://studio.hapbeat.com.evil.example/', studio))
  assert.ok(!isStudioOrigin('http://studio.hapbeat.com/', studio))
  assert.ok(!isStudioOrigin('https://devtools.hapbeat.com/docs/', studio))
  assert.ok(!isStudioOrigin('', studio))
  assert.ok(isExternalWebUrl('https://devtools.hapbeat.com/docs/'))
  assert.ok(!isExternalWebUrl('file:///c:/windows/system32/calc.exe'))
  assert.ok(!isExternalWebUrl('javascript:alert(1)'))
})

test('USB ids: decimal strings, hex and numbers', () => {
  assert.equal(usbId('12346'), 0x303a)
  assert.equal(usbId('0x303a'), 0x303a)
  assert.equal(usbId(0x303a), 0x303a)
  assert.equal(usbId(undefined), null)
  assert.equal(usbId(''), null)
})

const hapbeat = { portId: 'a', portName: 'COM7', vendorId: '12346', productId: '4097', serialNumber: 'AA:BB' }
const cp210x = { portId: 'b', portName: 'COM3', vendorId: '4292', productId: '60000', displayName: 'CP2102' }
const bluetooth = { portId: 'c', portName: 'COM4', displayName: 'Bluetooth link' }

test('ports: Hapbeat first, then USB-serial bridges, then the rest', () => {
  assert.deepEqual(sortPorts([bluetooth, cp210x, hapbeat]).map((p) => p.portId), ['a', 'b', 'c'])
  assert.ok(isHapbeatPort(hapbeat))
  assert.ok(!isHapbeatPort(cp210x))
})

test('chooser: a single Hapbeat is taken without asking; otherwise the user picks', async () => {
  let asked = 0
  const dialog = { showMessageBox: async (_win, opts) => { asked++; return { response: opts.buttons.length - 1 } } }
  assert.equal(await choosePort(dialog, null, [hapbeat]), 'a')
  assert.equal(asked, 0)
  assert.equal(await choosePort(dialog, null, [hapbeat, cp210x]), '') // cancelled
  assert.equal(asked, 1)
  const pickSecond = { showMessageBox: async () => ({ response: 1 }) }
  assert.equal(await choosePort(pickSecond, null, [cp210x, hapbeat]), 'b')
  assert.equal(await choosePort(dialog, null, []), '')
})

test('serial grants persist and match by vendor, product and serial number', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hb-grants-')), 'grants.json')
  const grants = new SerialGrants(file)
  assert.ok(!grants.has(hapbeat))
  grants.add(hapbeat)
  grants.add(bluetooth) // no USB ids → not remembered
  const reloaded = new SerialGrants(file)
  assert.ok(reloaded.has(hapbeat))
  assert.ok(!reloaded.has({ ...hapbeat, serialNumber: 'CC:DD' }))
  assert.ok(!reloaded.has(bluetooth))
  assert.ok(!reloaded.has(cp210x))
})

test('helper start line gives the version', () => {
  assert.equal(parseStartLine('hapbeat-helper 0.5.0 starting on ws://localhost:7703'), '0.5.0')
  assert.equal(parseStartLine('Press Ctrl+C to stop.'), null)
})

test('a helper already listening is used instead of starting another', async () => {
  const server = net.createServer().listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const { port } = server.address()
  assert.ok(await isPortOpen(port))
  const helper = new HelperProcess({ exePath: 'C:/nonexistent/hapbeat-helper.exe', logDir: os.tmpdir(), port })
  await helper.ensureRunning()
  assert.equal(helper.status().state, 'external')
  await new Promise((r) => server.close(r))
  assert.ok(!(await isPortOpen(port)))
  await helper.ensureRunning()
  assert.equal(helper.status().state, 'missing') // nothing listening and no bundled exe
})
