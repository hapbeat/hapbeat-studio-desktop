// Put the copy of Studio that the installer ships into studio-snapshot/ (the app opens
// it when there is no network and nothing newer has been saved yet).
//
//   node scripts/fetch-studio-snapshot.mjs                        # from https://studio.hapbeat.com
//   node scripts/fetch-studio-snapshot.mjs --url <origin>         # another deploy
//   node scripts/fetch-studio-snapshot.mjs --dist <studio dist>   # a local Studio build (npm run build)
//
// Studio lists its files in precache.json (hapbeat-studio scripts/write-precache.mjs);
// every file is checked against its size and sha256.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { parseManifest, writeBuild, MANIFEST } = require('../src/studioCache.js')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'studio-snapshot')
const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const dist = option('--dist')
const origin = (option('--url') || 'https://studio.hapbeat.com').replace(/\/+$/, '')

async function fromUrl(rel) {
  const res = await fetch(`${origin}/${rel.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${res.status} ${rel}`)
  return Buffer.from(await res.arrayBuffer())
}

const read = dist ? async (rel) => fs.promises.readFile(path.join(dist, ...rel.split('/'))) : fromUrl
const manifest = parseManifest((await read(MANIFEST)).toString('utf8'))
fs.rmSync(out, { recursive: true, force: true })
await writeBuild(out, manifest, (f) => read(f.path))
const total = manifest.files.reduce((sum, f) => sum + f.size, 0)
console.log(`studio-snapshot: build ${manifest.id}, ${manifest.files.length} files, ${(total / 1e6).toFixed(1)} MB (from ${dist || origin})`)
