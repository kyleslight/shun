import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

/**
 * Build the Chrome Web Store package for Shun Browser Use.
 *
 * The store rejects a package whose manifest carries the `key` field
 * ("key field is not allowed in manifest"), so this strips it from a copy and
 * leaves the source manifest alone — the bundled, unpacked copy still needs
 * that key to keep the extension ID the desktop bridge already accepts.
 *
 * Usage: node scripts/build-browser-use-store-package.mjs [output.zip]
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'resources', 'browser-use-extension')
const output = process.argv[2] || join(root, 'docs', 'browser-use-store', 'Shun-Browser-Use-store.zip')

async function collect(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collect(path, base))
    else files.push({ name: relative(base, path).split(/[\\/]/).join('/'), path })
  }
  return files
}

const manifestPath = join(source, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const { key: _key, ...uploadManifest } = manifest
if (!('key' in manifest)) throw Error('The source manifest has no key field; nothing to strip.')

const files = await collect(source)
const archive = {}
for (const file of files) archive[file.name] = new Uint8Array(await readFile(file.path))
archive['manifest.json'] = new TextEncoder().encode(`${JSON.stringify(uploadManifest, null, 2)}\n`)

const bytes = zipSync(archive, { level: 9 })
await writeFile(output, bytes)

const digest = createHash('sha256').update(bytes).digest('hex')
console.log(`Packaged ${Object.keys(archive).length} files → ${output}`)
console.log(`version ${uploadManifest.version} · ${bytes.length} bytes · sha256 ${digest}`)
console.log(`stripped: ${Object.keys(manifest).filter(field => !(field in uploadManifest)).join(', ')}`)
