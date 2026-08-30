import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { extname, relative, resolve, sep } from 'node:path'
import { createTwoFilesPatch } from 'diff'

type Snapshot = { workspace: string; files: Record<string, string>; capturedAt: number }
type WorkspaceCollector = (workspace: string) => Promise<Record<string, string>>
export type WorkspaceReviewFile = { path: string; status: 'A' | 'M' | 'D' }
export type WorkspaceReviewOverview = { root: string; capturedAt: number; files: WorkspaceReviewFile[] }

const ignoredDirectories = new Set([
  '.git', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
  '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '__pycache__',
  'node_modules', 'dist', 'build', 'out', 'release', 'coverage', 'target',
])
const ignoredFiles = new Set(['.DS_Store'])
const maxFiles = 2_000
const maxFileBytes = 1_000_000
const maxSnapshotBytes = 12_000_000
const binarySnapshotPrefix = '\0shun-binary:'
const knownBinaryExtensions = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.dmg', '.wasm',
  '.mp3', '.m4a', '.wav', '.flac', '.mp4', '.mov', '.webm',
])
const maximumWorkerOutputBytes = 80 * 1024 * 1024
const maximumWorkerDiagnosticBytes = 64 * 1024

export type IsolatedWorkspaceBaselineOptions = {
  workerEntry: string
  signal?: AbortSignal
  timeoutMs?: number
}

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

export async function ensureWorkspaceBaselineIsolated(workspace: string, taskId: string, storeDir: string, options: IsolatedWorkspaceBaselineOptions) {
  if (!workspace || !taskId) return
  options.signal?.throwIfAborted()
  const path = baselinePath(storeDir, taskId)
  try {
    const saved = JSON.parse(await readFile(path, 'utf8')) as Snapshot
    if (saved.workspace === resolve(workspace) && saved.files && typeof saved.files === 'object') return
  } catch (error) {
    if (options.signal?.aborted) options.signal.throwIfAborted()
  }
  const files = await collectWorkspaceFilesIsolated(workspace, options)
  options.signal?.throwIfAborted()
  const snapshot: Snapshot = { workspace: resolve(workspace), files, capturedAt: Date.now() }
  await mkdir(storeDir, { recursive: true })
  options.signal?.throwIfAborted()
  await writeFile(path, JSON.stringify(snapshot))
}

export async function collectWorkspaceFilesIsolated(workspace: string, options: IsolatedWorkspaceBaselineOptions) {
  options.signal?.throwIfAborted()
  const timeoutMs = Math.max(100, Math.min(120_000, Math.round(options.timeoutMs ?? 30_000)))
  const child = spawn(process.execPath, [options.workerEntry], {
    detached: process.platform !== 'win32',
    env: {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      USERPROFILE: process.env.USERPROFILE || '',
      SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || '',
      SYSTEMROOT: process.env.SYSTEMROOT || process.env.SystemRoot || '',
      TEMP: process.env.TEMP || '',
      TMP: process.env.TMP || '',
      TMPDIR: process.env.TMPDIR || '',
      ELECTRON_RUN_AS_NODE: '1',
      SHUN_WORKSPACE_SNAPSHOT_WORKER: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  let stdoutBytes = 0, stderrBytes = 0, outputExceeded = false
  child.stdout.on('data', chunk => {
    const value = Buffer.from(chunk), remaining = maximumWorkerOutputBytes - stdoutBytes
    if (remaining <= 0) { outputExceeded = true; terminateSnapshotWorker(child); return }
    stdout.push(value.subarray(0, remaining)); stdoutBytes += Math.min(value.length, remaining)
    if (value.length > remaining) { outputExceeded = true; terminateSnapshotWorker(child) }
  })
  child.stderr.on('data', chunk => {
    const value = Buffer.from(chunk), remaining = maximumWorkerDiagnosticBytes - stderrBytes
    if (remaining <= 0) return
    stderr.push(value.subarray(0, remaining)); stderrBytes += Math.min(value.length, remaining)
  })
  child.stdin.on('error', () => {})
  child.stdin.end(JSON.stringify({ workspace: resolve(workspace) }))
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; aborted: boolean }>((resolveWorker, rejectWorker) => {
    let timedOut = false, aborted = false
    const timer = setTimeout(() => { timedOut = true; terminateSnapshotWorker(child) }, timeoutMs)
    const abort = () => { aborted = true; terminateSnapshotWorker(child) }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
    child.once('error', error => { cleanup(); rejectWorker(error) })
    child.once('close', (code, signal) => { cleanup(); resolveWorker({ code, signal, timedOut, aborted }) })
  })
  if (outcome.aborted || options.signal?.aborted) options.signal?.throwIfAborted()
  const diagnostics = Buffer.concat(stderr).toString('utf8').trim()
  if (outcome.timedOut) throw Error(`Workspace preparation timed out after ${timeoutMs} ms.${diagnostics ? `\n${diagnostics}` : ''}`)
  if (outputExceeded) throw Error('Workspace snapshot exceeds the 80 MB structured-output limit.')
  if (outcome.code !== 0) throw Error(`Workspace snapshot worker exited with code ${outcome.code ?? outcome.signal ?? 'unknown'}.${diagnostics ? `\n${diagnostics}` : ''}`)
  const text = Buffer.concat(stdout).toString('utf8').trim()
  if (!text) throw Error(`Workspace snapshot worker returned no data.${diagnostics ? `\n${diagnostics}` : ''}`)
  let files: unknown
  try { files = JSON.parse(text) }
  catch { throw Error(`Workspace snapshot worker returned invalid data.${diagnostics ? `\n${diagnostics}` : ''}`) }
  if (!workspaceSnapshotFiles(files)) throw Error('Workspace snapshot worker returned an invalid file map.')
  return files
}

export async function removeWorkspaceBaseline(taskId: string, storeDir: string) {
  await rm(baselinePath(storeDir, taskId), { force: true })
}

export async function resetWorkspaceBaselinesIsolated(workspace: string, taskIds: string[], storeDir: string, options: IsolatedWorkspaceBaselineOptions) {
  const ids = [...new Set(taskIds.filter(Boolean))]
  if (!workspace || !ids.length) return
  const files = await collectWorkspaceFilesIsolated(workspace, options)
  options.signal?.throwIfAborted()
  const snapshot: Snapshot = { workspace: resolve(workspace), files, capturedAt: Date.now() }
  await mkdir(storeDir, { recursive: true })
  await Promise.all(ids.map(taskId => writeFile(baselinePath(storeDir, taskId), JSON.stringify(snapshot))))
}

export async function workspaceSnapshotDiff(workspace: string, taskId: string, storeDir: string, hintedFiles: string[] = [], hintedPatches: string[] = [], collect: WorkspaceCollector = collectWorkspaceFiles) {
  const current = await collect(workspace)
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

export async function workspaceReviewOverview(workspace: string, taskId: string, storeDir: string, collect: WorkspaceCollector = collectWorkspaceFiles): Promise<WorkspaceReviewOverview> {
  const root = resolve(workspace), current = await collect(root)
  let baseline = await readWorkspaceBaseline(root, taskId, storeDir)
  if (!baseline) {
    baseline = { workspace: root, files: current, capturedAt: Date.now() }
    await writeWorkspaceBaseline(taskId, storeDir, baseline)
  }
  const files: WorkspaceReviewFile[] = []
  for (const path of [...new Set([...Object.keys(baseline.files), ...Object.keys(current)])].sort()) {
    const before = baseline.files[path], after = current[path]
    if (before === after) continue
    files.push({ path, status: before === undefined ? 'A' : after === undefined ? 'D' : 'M' })
  }
  return { root, capturedAt: baseline.capturedAt, files }
}

export async function workspaceReviewDiff(workspace: string, taskId: string, storeDir: string, requestedPath: string) {
  const root = resolve(workspace), path = normalizeReviewPath(requestedPath), baseline = await readWorkspaceBaseline(root, taskId, storeDir)
  if (!baseline) throw Error('Workspace review baseline is unavailable.')
  const before = baseline.files[path], after = await readSnapshotFile(safe(root, path))
  if (before === undefined && after === undefined) throw Error('The selected workspace file is unavailable.')
  if (before === after) return 'No changes.'
  if (isBinarySnapshot(before) || isBinarySnapshot(after)) return binaryChangeSummary(path, before, after)
  if (before === undefined) return createTwoFilesPatch('/dev/null', path, '', after || '', '', 'current', { context: 3 }).slice(0, 2_000_000)
  if (after === undefined) return createTwoFilesPatch(path, '/dev/null', before, '', 'baseline', '', { context: 3 }).slice(0, 2_000_000)
  return createTwoFilesPatch(path, path, before, after, 'baseline', 'current', { context: 3 }).slice(0, 2_000_000)
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

export function snapshotPatches(baseline: Record<string, string>, current: Record<string, string>) {
  const patches: string[] = []
  for (const path of [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort()) {
    const before = baseline[path]
    const after = current[path]
    if (before === after) continue
    if (isBinarySnapshot(before) || isBinarySnapshot(after)) patches.push(binaryChangeSummary(path, before, after))
    else if (before === undefined) patches.push(createTwoFilesPatch('/dev/null', path, '', after, '', 'current', { context: 3 }))
    else if (after === undefined) patches.push(createTwoFilesPatch(path, '/dev/null', before, '', 'baseline', '', { context: 3 }))
    else patches.push(createTwoFilesPatch(path, path, before, after, 'baseline', 'current', { context: 3 }))
  }
  return patches.join('\n').slice(0, 2_000_000)
}

function baselinePath(storeDir: string, taskId: string) {
  const id = String(taskId).replace(/[^a-z0-9_-]/gi, '_').slice(0, 100) || 'unknown'
  return resolve(storeDir, `${id}.json`)
}

async function readWorkspaceBaseline(workspace: string, taskId: string, storeDir: string): Promise<Snapshot | null> {
  try {
    const saved = JSON.parse(await readFile(baselinePath(storeDir, taskId), 'utf8')) as Snapshot
    return saved.workspace === workspace && saved.files && typeof saved.files === 'object' ? saved : null
  } catch { return null }
}

async function writeWorkspaceBaseline(taskId: string, storeDir: string, snapshot: Snapshot) {
  await mkdir(storeDir, { recursive: true })
  await writeFile(baselinePath(storeDir, taskId), JSON.stringify(snapshot))
}

function normalizeReviewPath(value: string) {
  const path = String(value || '').trim().split('\\').join('/')
  if (!path || path === '.') throw Error('Workspace review path is required.')
  return path
}

async function readTextFile(path: string) {
  try {
    const data = await readFile(path)
    if (data.length > maxFileBytes || looksBinary(data)) return undefined
    return data.toString('utf8')
  } catch {
    // Workspaces can change while a snapshot is being collected. A deleted,
    // replaced, or temporarily inaccessible file must not abort the task.
    return undefined
  }
}

async function readSnapshotFile(path: string) {
  try {
    if (knownBinaryExtensions.has(extname(path).toLowerCase())) {
      const info = await stat(path)
      return `${binarySnapshotPrefix}${info.size}:${Math.trunc(info.mtimeMs)}`
    }
    const data = await readFile(path)
    if (data.length > maxFileBytes) return undefined
    if (looksBinary(data)) return `${binarySnapshotPrefix}${data.length}:${createHash('sha256').update(data).digest('hex')}`
    return data.toString('utf8')
  } catch {
    return undefined
  }
}

function looksBinary(data: Buffer) {
  if (data.includes(0)) return true
  if (data.subarray(0, 5).toString('ascii') === '%PDF-') return true
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return true
  return false
}

function isBinarySnapshot(value: string | undefined) {
  return typeof value === 'string' && value.startsWith(binarySnapshotPrefix)
}

function binaryChangeSummary(path: string, before: string | undefined, after: string | undefined) {
  const status = before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified'
  return `Binary file ${path} was ${status}.`
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

function workspaceSnapshotFiles(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([path, content]) => Boolean(path) && typeof content === 'string')
}

function terminateSnapshotWorker(child: ChildProcess) {
  if (!child.pid || child.killed) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
    else spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).unref()
  } catch { try { child.kill('SIGKILL') } catch {} }
}
