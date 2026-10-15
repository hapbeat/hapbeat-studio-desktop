'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  StudioCache, StudioServer, parseManifest, fileForUrlPath, isDocumentPath, sha256,
} = require('../src/studioCache')

const ORIGIN = 'https://studio.hapbeat.com'

/** A Studio build in memory: { files: {path: content}, manifest } */
function build(files) {
  const entries = Object.entries(files).map(([p, content]) => {
    const data = Buffer.from(content)
    return { path: p, size: data.length, sha256: sha256(data) }
  })
  const id = sha256(Buffer.from(entries.map((e) => e.path + e.sha256).join())).slice(0, 16)
  return { files, manifest: { schema: 1, id, builtAt: '2026-10-15T00:00:00Z', files: entries } }
}

function source(b, served = []) {
  return {
    manifest: async () => JSON.stringify(b.manifest),
    file: async (rel) => {
      served.push(rel)
      if (!(rel in b.files)) throw new Error(`404 ${rel}`)
      return Buffer.from(b.files[rel])
    },
  }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hb-studio-cache-'))

test('manifest: rejects paths that leave the build and malformed entries', () => {
  const ok = build({ 'index.html': '<p>', 'assets/a.js': 'x' }).manifest
  assert.equal(parseManifest(ok).id, ok.id)
  const bad = (files) => ({ ...ok, files })
  const entry = ok.files[0]
  assert.throws(() => parseManifest(bad([...ok.files, { ...entry, path: '../evil.js' }])))
  assert.throws(() => parseManifest(bad([...ok.files, { ...entry, path: 'C:/evil.js' }])))
  assert.throws(() => parseManifest(bad([...ok.files, { ...entry, path: 'a\\b.js' }])))
  assert.throws(() => parseManifest(bad([...ok.files, { ...entry, path: '/abs.js' }])))
  assert.throws(() => parseManifest(bad([...ok.files, { ...entry, sha256: 'nope' }])))
  assert.throws(() => parseManifest({ ...ok, id: '../x' }))
  assert.throws(() => parseManifest(bad(ok.files.filter((f) => f.path !== 'index.html'))))
})

test('URL paths map into the copy and never outside it', () => {
  const root = path.resolve('/copy')
  assert.equal(fileForUrlPath(root, '/'), path.join(root, 'index.html'))
  assert.equal(fileForUrlPath(root, '/en/'), path.join(root, 'en', 'index.html'))
  assert.equal(fileForUrlPath(root, '/assets/a%20b.js'), path.join(root, 'assets', 'a b.js'))
  assert.equal(fileForUrlPath(root, '/../secret'), null)
  assert.equal(fileForUrlPath(root, '/%2e%2e/secret'), null)
  assert.equal(fileForUrlPath(root, '/a/..%2f..%2fsecret'), null)
  assert.equal(fileForUrlPath(root, '/%E0%A4%A'), null)
  assert.ok(isDocumentPath('/') && isDocumentPath('/en/') && isDocumentPath('/popout.html'))
  assert.ok(!isDocumentPath('/assets/index.js') && !isDocumentPath('/precache.json'))
})

test('sync saves a complete build, reuses unchanged files, and keeps only the newest', async () => {
  const dir = tmp()
  const cache = new StudioCache({ cacheDir: path.join(dir, 'cache') })
  assert.equal(cache.current(), null)

  const v1 = build({ 'index.html': 'v1', 'assets/a.js': 'A1', 'library/clip.wav': 'WAV' })
  const s1 = source(v1)
  assert.deepEqual(await cache.sync(s1.manifest, s1.file), { updated: true, id: v1.manifest.id })
  assert.equal(cache.current().id, v1.manifest.id)
  assert.equal((await cache.lookup('/')).body.toString(), 'v1')
  assert.equal((await cache.lookup('/library/clip.wav')).type, 'audio/wav')
  assert.deepEqual(await cache.sync(s1.manifest, s1.file), { updated: false, id: v1.manifest.id })

  const v2 = build({ 'index.html': 'v2', 'assets/b.js': 'B2', 'library/clip.wav': 'WAV' })
  const served = []
  const s2 = source(v2, served)
  await cache.sync(s2.manifest, s2.file)
  assert.equal(cache.current().id, v2.manifest.id)
  assert.ok(!served.includes('library/clip.wav'), 'unchanged file is copied, not downloaded')
  assert.equal(await cache.lookup('/assets/a.js'), null, 'files of the old build are gone')
  assert.deepEqual(fs.readdirSync(path.join(dir, 'cache')).sort(), [v2.manifest.id, 'current.json'].sort())
})

test('a download that does not match the list keeps the previous copy', async () => {
  const dir = tmp()
  const cache = new StudioCache({ cacheDir: path.join(dir, 'cache') })
  const v1 = build({ 'index.html': 'v1' })
  await cache.sync(source(v1).manifest, source(v1).file)
  const v2 = build({ 'index.html': 'v2', 'assets/x.js': 'X' })
  const tampered = { manifest: source(v2).manifest, file: async (rel) => Buffer.from(rel === 'assets/x.js' ? 'Y' : v2.files[rel]) }
  await assert.rejects(cache.sync(tampered.manifest, tampered.file))
  assert.equal(cache.current().id, v1.manifest.id)
  assert.equal((await cache.lookup('/')).body.toString(), 'v1')
})

test('the installer copy is used until a build has been saved', async () => {
  const dir = tmp()
  const bundled = path.join(dir, 'bundled')
  const b = build({ 'index.html': 'shipped' })
  fs.mkdirSync(bundled)
  fs.writeFileSync(path.join(bundled, 'index.html'), 'shipped')
  fs.writeFileSync(path.join(bundled, 'precache.json'), JSON.stringify(b.manifest))
  const cache = new StudioCache({ cacheDir: path.join(dir, 'cache'), bundledDir: bundled })
  assert.equal(cache.current().source, 'bundled')
  assert.equal((await cache.lookup('/')).body.toString(), 'shipped')
})

test('server: network first for pages, the copy when the network fails, the copy for the rest of that page', async () => {
  const dir = tmp()
  const cache = new StudioCache({ cacheDir: path.join(dir, 'cache') })
  const v1 = build({ 'index.html': 'saved page', 'assets/a.js': 'saved js' })
  await cache.sync(source(v1).manifest, source(v1).file)

  let online = true
  const calls = []
  const fetch = async (request) => {
    calls.push(new URL(request.url).pathname)
    if (!online) throw new Error('net::ERR_INTERNET_DISCONNECTED')
    return new Response('live', { status: 200 })
  }
  const server = new StudioServer({ cache, origin: ORIGIN, fetch })
  const statuses = []
  server.on('status', (s) => statuses.push(s.mode))
  const get = (p) => server.handle(new Request(`${ORIGIN}${p}`))

  assert.equal(await (await get('/?shell=desktop')).text(), 'live')
  assert.equal(server.status().mode, 'online')

  online = false
  const page = await get('/?shell=desktop')
  assert.equal(await page.text(), 'saved page')
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(server.status().mode, 'offline')
  calls.length = 0
  assert.equal(await (await get('/assets/a.js')).text(), 'saved js')
  assert.deepEqual(calls, [], 'offline page reads its files from the copy without trying the network')
  await assert.rejects(get('/firmware/manifest.json'), /DISCONNECTED/)

  online = true
  assert.equal(await (await get('/')).text(), 'live')
  assert.deepEqual(statuses, ['offline', 'online'])

  // other origins and non-GET requests always go to the network
  calls.length = 0
  await server.handle(new Request('https://devtools.hapbeat.com/release-feed.json'))
  await server.handle(new Request(`${ORIGIN}/x`, { method: 'POST', body: 'b' }))
  assert.deepEqual(calls, ['/release-feed.json', '/x'])
})

test('server: a redirect away from Studio makes the next page load come from the copy', async () => {
  const dir = tmp()
  const cache = new StudioCache({ cacheDir: path.join(dir, 'cache') })
  const v1 = build({ 'index.html': 'saved page' })
  await cache.sync(source(v1).manifest, source(v1).file)
  const server = new StudioServer({ cache, origin: ORIGIN, fetch: async () => new Response('portal') })
  server.useCopyForNextLoad()
  assert.equal(await (await server.handle(new Request(`${ORIGIN}/`))).text(), 'saved page')
  assert.equal(server.status().mode, 'offline')
  assert.equal(await (await server.handle(new Request(`${ORIGIN}/`))).text(), 'portal')
})
