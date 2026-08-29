import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { gunzipSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const scriptRoot = dirname(fileURLToPath(import.meta.url))
const root = dirname(require.resolve('node-pty/package.json'))
const installed = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const cache = JSON.parse(await readFile(join(scriptRoot, 'native/node-pty/manifest.json'), 'utf8'))

if (installed.version !== cache.packageVersion) {
  throw Error(`Cached Terminal runtimes target node-pty ${cache.packageVersion}, but ${installed.version} is installed.`)
}

await installCachedRuntime(cache.runtimes['linux-x64'], join(root, 'prebuilds/linux-x64/pty.node'))
if (process.platform !== 'win32') await makeHelpersExecutable(root)

async function installCachedRuntime(record, destination) {
  const encoded = await readFile(join(scriptRoot, 'native/node-pty', record.payload), 'utf8')
  const binary = gunzipSync(Buffer.from(encoded.replace(/\s+/g, ''), 'base64'))
  const digest = createHash('sha256').update(binary).digest('hex')
  if (digest !== record.sha256) throw Error('Cached Linux Terminal runtime failed its SHA-256 check.')
  const current = await readFile(destination).catch(() => null)
  if (current && createHash('sha256').update(current).digest('hex') === digest) return
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, binary, { mode: 0o755 })
}

async function makeHelpersExecutable(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await makeHelpersExecutable(path)
    else if (entry.name === 'spawn-helper') await chmod(path, 0o755)
  }
}
