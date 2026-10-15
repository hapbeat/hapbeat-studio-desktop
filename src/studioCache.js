'use strict'
// Studio without a network.
//
// The app keeps one complete copy of the latest Studio build: the installer ships
// the copy current when it was built (resources/studio-snapshot), and after each
// online launch the app downloads any newer build that Studio lists in
// /precache.json (hapbeat-studio scripts/write-precache.mjs). Studio's own URL
// stays the same either way (https://studio.hapbeat.com), so its saved folders,
// settings and USB ports are the same online and offline:
//   - a page load tries the network first; if it fails, the saved copy answers
//   - once a page came from the copy, the rest of that page is read from the copy
//     too, so files of one build are never mixed with another's
// Offline the app cannot update and has no firmware list (not part of the build).

const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

const MANIFEST = 'precache.json'
const CURRENT = 'current.json'
const DOCUMENT_TIMEOUT_MS = 8000
const DOWNLOAD_CONCURRENCY = 4

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.zip': 'application/zip',
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/** A relative path inside the build: no absolute paths, drive letters, backslashes or "..". */
function isSafeRelativePath(p) {
  return typeof p === 'string'
    && p.length > 0
    && p.length < 512
    && !p.startsWith('/')
    && !p.includes('\\')
    && !p.includes(':')
    && !p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
}

/** The build's file list, checked before anything is written. Throws when malformed. */
function parseManifest(json) {
  const m = typeof json === 'string' ? JSON.parse(json) : json
  if (!m || typeof m !== 'object' || !/^[0-9a-f]{8,64}$/.test(m.id) || !Array.isArray(m.files)) {
    throw new Error('invalid precache manifest')
  }
  for (const f of m.files) {
    if (!f || !isSafeRelativePath(f.path) || !Number.isInteger(f.size) || f.size < 0 || !/^[0-9a-f]{64}$/.test(f.sha256)
      || (f.inline !== undefined && typeof f.inline !== 'string')) {
      throw new Error(`invalid precache entry: ${JSON.stringify(f)?.slice(0, 120)}`)
    }
  }
  if (!m.files.some((f) => f.path === 'index.html')) throw new Error('precache manifest has no index.html')
  return { id: m.id, builtAt: typeof m.builtAt === 'string' ? m.builtAt : null, files: m.files }
}

/** URL path → file in `root` ("/" and ".../" → index.html), or null when it would leave `root`. */
function fileForUrlPath(root, pathname) {
  let rel
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    return null
  }
  rel = rel.replace(/^\/+/, '')
  if (rel === '' || rel.endsWith('/')) rel += 'index.html'
  if (!isSafeRelativePath(rel)) return null
  const file = path.resolve(root, ...rel.split('/'))
  return file.startsWith(path.resolve(root) + path.sep) ? file : null
}

/** Paths that load a page (Studio's routes are "/" and "/en/"). */
function isDocumentPath(pathname) {
  return pathname.endsWith('/') || pathname.endsWith('.html')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

class StudioCache {
  /**
   * @param {{ cacheDir: string, bundledDir?: string | null }} options
   *   cacheDir: the app's own folder for downloaded builds (userData/studio-cache)
   *   bundledDir: the copy shipped in the installer (read only)
   */
  constructor({ cacheDir, bundledDir = null }) {
    this.cacheDir = cacheDir
    this.bundledDir = bundledDir
    this.syncing = null
  }

  /** The copy to serve: the newest downloaded build, else the installer's. */
  current() {
    const saved = readJson(path.join(this.cacheDir, CURRENT))
    if (saved && /^[0-9a-f]{8,64}$/.test(saved.id)) {
      const root = path.join(this.cacheDir, saved.id)
      if (fs.existsSync(path.join(root, MANIFEST))) {
        return { root, id: saved.id, savedAt: saved.savedAt ?? null, source: 'saved' }
      }
    }
    if (this.bundledDir) {
      const manifest = readJson(path.join(this.bundledDir, MANIFEST))
      if (manifest && /^[0-9a-f]{8,64}$/.test(manifest.id)) {
        return { root: this.bundledDir, id: manifest.id, savedAt: manifest.builtAt ?? null, source: 'bundled' }
      }
    }
    return null
  }

  /** A file of the current copy for a Studio URL path: { body, type } or null. */
  async lookup(pathname) {
    const copy = this.current()
    if (!copy) return null
    const file = fileForUrlPath(copy.root, pathname)
    if (!file) return null
    try {
      const body = await fs.promises.readFile(file)
      return { body, type: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }
    } catch {
      return null
    }
  }

  /**
   * Download the build Studio lists now, if it is not the one already kept.
   * `fetchFile(relPath)` resolves a Buffer of that file from Studio. Files that did
   * not change are copied from the current copy instead of downloaded.
   * Resolves { updated, id }. One sync at a time.
   */
  sync(fetchManifest, fetchFile) {
    if (!this.syncing) {
      this.syncing = this.doSync(fetchManifest, fetchFile).finally(() => {
        this.syncing = null
      })
    }
    return this.syncing
  }

  async doSync(fetchManifest, fetchFile) {
    const manifest = parseManifest(await fetchManifest())
    const current = this.current()
    if (current?.id === manifest.id) return { updated: false, id: manifest.id }
    const known = new Map()
    if (current) {
      const old = readJson(path.join(current.root, MANIFEST))
      for (const f of old?.files ?? []) known.set(f.path, f.sha256)
    }

    fs.mkdirSync(this.cacheDir, { recursive: true })
    const partial = path.join(this.cacheDir, `${manifest.id}.partial`)
    fs.rmSync(partial, { recursive: true, force: true })
    await writeBuild(partial, manifest, async (f) => {
      if (current && known.get(f.path) === f.sha256) {
        const reused = await fs.promises.readFile(path.join(current.root, ...f.path.split('/'))).catch(() => null)
        if (reused && sha256(reused) === f.sha256) return reused
      }
      return fetchFile(f.path)
    })

    const finalDir = path.join(this.cacheDir, manifest.id)
    fs.rmSync(finalDir, { recursive: true, force: true })
    fs.renameSync(partial, finalDir)
    fs.writeFileSync(path.join(this.cacheDir, CURRENT), JSON.stringify({ id: manifest.id, savedAt: new Date().toISOString() }))
    // Keep only the copy just saved (older builds and interrupted downloads go).
    for (const name of fs.readdirSync(this.cacheDir)) {
      if (name !== manifest.id && /^[0-9a-f]{8,64}(\.partial)?$/.test(name)) {
        fs.rmSync(path.join(this.cacheDir, name), { recursive: true, force: true })
      }
    }
    return { updated: true, id: manifest.id }
  }
}

/**
 * Write every file of `manifest` into `dir` (checked against its size and sha256), then
 * the manifest. HTML comes inside the list (`inline`): the CDN rewrites HTML responses.
 */
async function writeBuild(dir, manifest, getFile) {
  fs.mkdirSync(dir, { recursive: true })
  const queue = [...manifest.files]
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const data = f.inline !== undefined ? Buffer.from(f.inline, 'base64') : await getFile(f)
      if (!data || data.length !== f.size || sha256(data) !== f.sha256) {
        throw new Error(`file does not match the precache list: ${f.path}`)
      }
      const out = path.join(dir, ...f.path.split('/'))
      await fs.promises.mkdir(path.dirname(out), { recursive: true })
      await fs.promises.writeFile(out, data)
    }
  }
  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker))
  const files = manifest.files.map(({ inline, ...f }) => f) // the files are on disk now
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ schema: 1, id: manifest.id, builtAt: manifest.builtAt, files }))
}

/**
 * Answers the window's requests to the Studio origin: network first for a page
 * load, the saved copy when the network fails, and the copy for everything else
 * on a page that came from it. Other origins and non-GET requests go to the network.
 */
class StudioServer extends EventEmitter {
  /**
   * @param {{ cache: StudioCache, origin: string, fetch: (request: Request, init?: object) => Promise<Response> }} options
   */
  constructor({ cache, origin, fetch }) {
    super()
    this.cache = cache
    this.origin = origin
    this.fetch = fetch
    this.offline = false
    this.preferCopyOnce = false
  }

  status() {
    const copy = this.cache.current()
    return {
      mode: this.offline ? 'offline' : 'online',
      copy: copy ? { id: copy.id, savedAt: copy.savedAt, source: copy.source } : null,
    }
  }

  setOffline(offline) {
    if (this.offline === offline) return
    this.offline = offline
    this.emit('status', this.status())
  }

  /** Next page load comes from the copy (e.g. the network redirected away from Studio). */
  useCopyForNextLoad() {
    this.preferCopyOnce = true
  }

  async fromCopy(url) {
    const hit = await this.cache.lookup(url.pathname)
    if (!hit) return null
    return new Response(hit.body, { status: 200, headers: { 'content-type': hit.type, 'cache-control': 'no-store' } })
  }

  async handle(request) {
    const url = new URL(request.url)
    if (url.origin !== this.origin || request.method !== 'GET') return this.fetch(request)
    const isDocument = isDocumentPath(url.pathname)

    const copyFirst = isDocument ? this.preferCopyOnce : this.offline
    if (isDocument) this.preferCopyOnce = false
    if (copyFirst) {
      const hit = await this.fromCopy(url)
      if (hit) {
        if (isDocument) this.setOffline(true)
        return hit
      }
    }
    try {
      const response = await this.fetch(request, isDocument ? { signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS) } : undefined)
      if (isDocument && response.status >= 500) {
        const hit = await this.fromCopy(url)
        if (hit) {
          this.setOffline(true)
          return hit
        }
      }
      if (isDocument) this.setOffline(false)
      return response
    } catch (err) {
      const hit = await this.fromCopy(url)
      if (!hit) throw err
      if (isDocument) this.setOffline(true)
      return hit
    }
  }
}

module.exports = {
  StudioCache,
  StudioServer,
  parseManifest,
  fileForUrlPath,
  isDocumentPath,
  writeBuild,
  sha256,
  MANIFEST,
}
