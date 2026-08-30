import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'

const ignoredDirectories = new Set([
  '.git', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
  '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '__pycache__',
  'node_modules', 'dist', 'build', 'out', 'release', 'coverage', 'target',
])
const ignoredFiles = new Set(['.DS_Store'])
const knownBinaryExtensions = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.dmg', '.wasm',
  '.mp3', '.m4a', '.wav', '.flac', '.mp4', '.mov', '.webm',
])
const maxFiles = 2_000
const maxFileBytes = 1_000_000
const maxSnapshotBytes = 12_000_000
const binarySnapshotPrefix = '\0shun-binary:'

let input = ''
for await (const chunk of process.stdin) input += chunk
const request = JSON.parse(input)
if (!request || typeof request.workspace !== 'string' || !request.workspace) throw Error('Workspace snapshot input is invalid.')
process.stdout.write(JSON.stringify(await collectWorkspaceFiles(request.workspace)))

async function collectWorkspaceFiles(workspace) {
  const root = resolve(workspace)
  const files = {}
  let count = 0
  let bytes = 0
  async function visit(directory) {
    if (count >= maxFiles || bytes >= maxSnapshotBytes) return
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (count >= maxFiles || bytes >= maxSnapshotBytes) break
      if (entry.isSymbolicLink() || ignoredFiles.has(entry.name)) continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(path)
        continue
      }
      if (!entry.isFile()) continue
      const content = await readSnapshotFile(path)
      if (content === undefined) continue
      const size = Buffer.byteLength(content)
      if (bytes + size > maxSnapshotBytes) break
      files[normalizePath(relative(root, path))] = content
      bytes += size
      count++
    }
  }
  await visit(root)
  return files
}

async function readSnapshotFile(path) {
  try {
    if (knownBinaryExtensions.has(extname(path).toLowerCase())) {
      const info = await stat(path)
      return `${binarySnapshotPrefix}${info.size}:${Math.trunc(info.mtimeMs)}`
    }
    const data = await readFile(path)
    if (data.length > maxFileBytes) return undefined
    if (looksBinary(data)) return `${binarySnapshotPrefix}${data.length}:${createHash('sha256').update(data).digest('hex')}`
    return data.toString('utf8')
  } catch { return undefined }
}

function looksBinary(data) {
  if (data.includes(0)) return true
  if (data.subarray(0, 5).toString('ascii') === '%PDF-') return true
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return true
  return false
}

function normalizePath(path) {
  return path.split(sep).join('/')
}
