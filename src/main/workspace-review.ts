import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { createTwoFilesPatch } from 'diff'

type Snapshot = { workspace: string; files: Record<string, string>; capturedAt: number }

const ignoredDirectories = new Set([
  '.git', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
  'node_modules', 'dist', 'build', 'out', 'coverage', 'target',
])
const ignoredFiles = new Set(['.DS_Store'])
const maxFiles = 2_000
const maxFileBytes = 1_000_000
const maxSnapshotBytes = 12_000_000

export async function ensureWorkspaceBaseline(workspace: string, taskId: string, storeDir: string) {
  if (!workspace || !taskId) return
  const path = baselinePath(storeDir, taskId)
  try {
    const saved = JSON.parse(await readFile(path, 'utf8')) as Snapshot
    if (saved.workspace === resolve(workspace) && saved.files && typeof saved.files === 'object') return
  } catch {}
  const snapshot: Snapshot = { workspace: resolve(workspace), files: await collectWorkspaceFiles(workspace), capturedAt: Date.now() }
  await mkdir(storeDir, { recursive: true })
  await writeFile(path, JSON.stringify(snapshot))
}

export async function workspaceSnapshotDiff(workspace: string, taskId: string, storeDir: string, hintedFiles: string[] = [], hintedPatches: string[] = []) {
  const current = await collectWorkspaceFiles(workspace)
  let baseline: Record<string, string> = {}
  try {
    const saved = JSON.parse(await readFile(baselinePath(storeDir, taskId), 'utf8')) as Snapshot
    if (saved.workspace === resolve(workspace) && saved.files && typeof saved.files === 'object') baseline = saved.files
  } catch {
    // Tasks created before workspace baselines existed still need a complete
    // review. Treat the current bounded source tree as additions, rather than
    // falling back to the subset of files mentioned by edit/write tools.
  }
  const patches = snapshotPatches(baseline, current)
  if (patches) return patches
  const hinted = await patchesForFiles(workspace, hintedFiles)
  return hinted || hintedPatches.filter(Boolean).join('\n\n').slice(0, 2_000_000) || 'No changes.'
}

export async function patchesForFiles(workspace: string, files: string[]) {
  const patches: string[] = []
  for (const name of [...new Set(files)].slice(0, maxFiles)) try {
    const path = safe(workspace, name)
    const content = await readTextFile(path)
    if (content !== undefined) patches.push(createTwoFilesPatch('/dev/null', normalizePath(relative(resolve(workspace), path)), '', content, '', 'current', { context: 3 }))
  } catch {}
  return patches.join('\n').slice(0, 2_000_000)
}

export async function collectWorkspaceFiles(workspace: string) {
  const root = resolve(workspace)
  const files: Record<string, string> = {}
  let count = 0
  let bytes = 0
  async function visit(directory: string) {
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
      const content = await readTextFile(path)
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

export function snapshotPatches(baseline: Record<string, string>, current: Record<string, string>) {
  const patches: string[] = []
  for (const path of [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort()) {
    const before = baseline[path]
    const after = current[path]
    if (before === after) continue
    if (before === undefined) patches.push(createTwoFilesPatch('/dev/null', path, '', after, '', 'current', { context: 3 }))
    else if (after === undefined) patches.push(createTwoFilesPatch(path, '/dev/null', before, '', 'baseline', '', { context: 3 }))
    else patches.push(createTwoFilesPatch(path, path, before, after, 'baseline', 'current', { context: 3 }))
  }
  return patches.join('\n').slice(0, 2_000_000)
}

function baselinePath(storeDir: string, taskId: string) {
  const id = String(taskId).replace(/[^a-z0-9_-]/gi, '_').slice(0, 100) || 'unknown'
  return resolve(storeDir, `${id}.json`)
}

async function readTextFile(path: string) {
  const data = await readFile(path)
  if (data.length > maxFileBytes || data.includes(0)) return undefined
  return data.toString('utf8')
}

function safe(root: string, path: string) {
  const base = resolve(root)
  const target = resolve(base, path)
  if (target !== base && !target.startsWith(base + sep)) throw Error('Path escapes workspace.')
  return target
}

function normalizePath(path: string) {
  return path.split(sep).join('/')
}
