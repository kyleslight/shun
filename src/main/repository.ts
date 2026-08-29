import { execFile as execFileCallback } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { GitChangedFile, GitCommit, GitCommitFiles, GitReference, GitRemote, GitWorkbenchOverview, RepositoryFileState, RepositorySnapshot } from '../shared.ts'
import { patchesForFiles } from './workspace-review.ts'

const execFile = promisify(execFileCallback)
const maxWorkbenchDiffBytes = 1_500_000
const maxWorkbenchPreviewBytes = 12 * 1024 * 1024

export async function repositorySnapshot(workspace: string): Promise<RepositorySnapshot | null> {
  if (!workspace) return null
  let root: string, raw: string
  try {
    root = (await git(workspace, ['rev-parse', '--show-toplevel'])).trim()
    raw = await git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
  } catch { return null }
  return parsePorcelainV2(root, raw)
}

export async function repositoryFullDiff(workspace: string) {
  const snapshot = await repositorySnapshot(workspace)
  if (!snapshot) throw Error('Workspace is not a Git repository.')
  const [unstaged, staged, untracked] = await Promise.all([
    git(snapshot.root, ['diff', '--no-ext-diff', '--no-color', '--binary', '--', '.']),
    git(snapshot.root, ['diff', '--cached', '--no-ext-diff', '--no-color', '--binary', '--', '.']),
    patchesForFiles(snapshot.root, snapshot.files.filter(file => file.untracked).map(file => file.path)),
  ])
  return [staged.trim(), unstaged.trim(), untracked.trim()].filter(Boolean).join('\n\n') || 'No changes.'
}

export async function gitWorkbenchOverview(workspace: string, options: { ref?: string; skip?: number; limit?: number } = {}): Promise<GitWorkbenchOverview> {
  const repository = await repositorySnapshot(workspace)
  if (!repository) throw Error('Workspace is not a Git repository.')
  return gitWorkbenchOverviewForRepository(repository, options)
}

export async function gitWorkbenchOverviewState(workspace: string, options: { ref?: string; skip?: number; limit?: number } = {}) {
  const repository = await repositorySnapshot(workspace)
  if (!repository) return { unavailable: 'not-repository' as const }
  return gitWorkbenchOverviewForRepository(repository, options)
}

async function gitWorkbenchOverviewForRepository(repository: RepositorySnapshot, options: { ref?: string; skip?: number; limit?: number }): Promise<GitWorkbenchOverview> {
  const limit = Math.max(25, Math.min(500, Math.trunc(Number(options.limit) || 160)))
  const skip = Math.max(0, Math.min(10_000, Math.trunc(Number(options.skip) || 0)))
  const selectedRef = normalizeRevision(options.ref)
  // A newly initialized repository has an unborn HEAD until its first commit.
  const hasCommits = /^[0-9a-f]{40,64}$/i.test(repository.oid)
  const [refText, remoteText, logText] = await Promise.all([
    git(repository.root, ['for-each-ref', '--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)', 'refs/heads', 'refs/remotes', 'refs/tags']),
    git(repository.root, ['remote', '-v']),
    hasCommits ? git(repository.root, [
      'log', '--no-color', '--no-show-signature', '--topo-order', '--date-order',
      `--max-count=${limit + 1}`, `--skip=${skip}`,
      '--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D',
      ...(selectedRef ? [selectedRef] : ['--all']), '--',
    ]) : Promise.resolve(''),
  ])
  const commits = parseGitLog(logText)
  return {
    repository,
    refs: parseGitReferences(refText),
    remotes: parseGitRemotes(remoteText),
    commits: commits.slice(0, limit),
    hasMore: commits.length > limit,
  }
}

export async function gitCommitFiles(workspace: string, revision: string): Promise<GitCommitFiles> {
  const snapshot = await repositorySnapshot(workspace)
  if (!snapshot) throw Error('Workspace is not a Git repository.')
  const oid = normalizeOid(revision)
  const [metadata, changes] = await Promise.all([
    git(snapshot.root, ['show', '--no-color', '--no-show-signature', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D', oid]),
    git(snapshot.root, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '--find-renames', oid]),
  ])
  const commit = parseGitCommitRecord(metadata.trim())
  if (!commit) throw Error('Commit metadata is unavailable.')
  return { commit, files: parseGitChangedFiles(changes) }
}

export async function gitWorkbenchDiff(workspace: string, request: { revision?: string; path?: string; working?: boolean }) {
  const snapshot = await repositorySnapshot(workspace)
  if (!snapshot) throw Error('Workspace is not a Git repository.')
  const path = normalizeGitPath(request.path)
  if (request.working) {
    const file = snapshot.files.find(item => item.path === path)
    if (!file) throw Error('The selected working-tree file is no longer changed.')
    const [staged, unstaged, untracked] = await Promise.all([
      file.staged ? git(snapshot.root, ['diff', '--cached', '--no-ext-diff', '--no-color', '--unified=4', '--', path]) : '',
      file.unstaged ? git(snapshot.root, ['diff', '--no-ext-diff', '--no-color', '--unified=4', '--', path]) : '',
      file.untracked ? patchesForFiles(snapshot.root, [path]) : '',
    ])
    return boundWorkbenchDiff([staged.trim(), unstaged.trim(), untracked.trim()].filter(Boolean).join('\n\n') || 'No changes.')
  }
  const oid = normalizeOid(request.revision)
  return boundWorkbenchDiff((await git(snapshot.root, ['show', '--no-color', '--no-show-signature', '--format=', '--find-renames', '--unified=4', oid, '--', path])).trim() || 'No textual changes.')
}

export async function gitWorkbenchFilePreview(workspace: string, request: { revision?: string; path?: string; working?: boolean; status?: string }) {
  const snapshot = await repositorySnapshot(workspace)
  if (!snapshot) throw Error('Workspace is not a Git repository.')
  const path = normalizeGitPath(request.path)
  let data: Buffer
  if (request.working) {
    const file = snapshot.files.find(item => item.path === path)
    if (!file) throw Error('The selected working-tree file is no longer changed.')
    data = file.index === 'D' || file.worktree === 'D'
      ? await gitBinary(snapshot.root, ['show', `HEAD:${path}`])
      : await readWorkingTreeFile(snapshot.root, path)
  } else {
    const oid = normalizeOid(request.revision)
    const revision = String(request.status || '').startsWith('D') ? `${oid}^` : oid
    data = await gitBinary(snapshot.root, ['show', `${revision}:${path}`])
  }
  if (data.length > maxWorkbenchPreviewBytes) throw Error('Image preview exceeds the 12 MB limit.')
  const mimeType = previewImageMime(data)
  if (!mimeType) throw Error('This file is not a supported preview image.')
  return { kind: 'image' as const, path, mimeType, size: data.length, encoding: 'base64' as const, data: data.toString('base64') }
}

export async function gitWorkbenchExecute(workspace: string, input: unknown) {
  if (!input || typeof input !== 'object') throw Error('Git action payload must be an object.')
  const request = input as { action?: unknown; paths?: unknown; ref?: unknown; name?: unknown; message?: unknown; mode?: unknown }
  const action = String(request.action || '')
  if (action === 'init') {
    if (await repositorySnapshot(workspace)) throw Error('Workspace already belongs to a Git repository.')
    const output = await git(workspace, ['init'])
    return { action, message: output.trim() || 'Git repository initialized.' }
  }
  if (action === 'stage' || action === 'unstage' || action === 'reset-file') {
    const { snapshot, paths } = await scopedChangedPaths(workspace, request.paths)
    const run = (args: string[]) => git(snapshot.root, args, 30_000)
    let output = ''
    if (action === 'stage' || action === 'unstage') {
      output = action === 'stage' ? await run(['add', '--', ...paths]) : await run(['restore', '--staged', '--', ...paths])
    } else {
      const files = new Map(snapshot.files.map(file => [file.path, file]))
      const added = paths.filter(path => files.get(path)?.untracked || files.get(path)?.index === 'A')
      const addedToIndex = added.filter(path => files.get(path)?.index === 'A')
      const tracked = paths.filter(path => !added.includes(path))
      if (tracked.length) await run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked])
      if (addedToIndex.length) await run(['restore', '--staged', '--', ...addedToIndex])
      if (added.length) await run(['clean', '-f', '--', ...added])
      output = 'Selected file changes discarded.'
    }
    return { action, message: output.trim() || `${action} completed.` }
  }
  const snapshot = await repositorySnapshot(workspace)
  if (!snapshot) throw Error('Workspace is not a Git repository.')
  const run = (args: string[], network = false) => git(snapshot.root, args, network ? 120_000 : 30_000, network)
  let output = ''

  if (action === 'fetch') output = await run(['fetch', '--all', '--prune'], true)
  else if (action === 'pull') output = await run(['pull', '--ff-only'], true)
  else if (action === 'push') output = await run(['push'], true)
  else if (action === 'commit') {
    const message = normalizeGitMessage(request.message, 'Commit message')
    output = await run(['commit', '-m', message])
  } else if (action === 'stash') {
    const message = request.message === undefined ? 'Git Workbench stash' : normalizeGitMessage(request.message, 'Stash message')
    output = await run(['stash', 'push', '--include-untracked', '-m', message])
  } else if (action === 'checkout') {
    const ref = normalizeLocalBranch(request.ref)
    output = await run(['switch', ref.slice('refs/heads/'.length)])
  } else if (action === 'create-branch') {
    const name = await normalizeNewRefName(snapshot.root, request.name, 'branch')
    const start = request.ref ? normalizeActionRevision(request.ref) : ''
    output = await run(['switch', '-c', name, ...(start ? [start] : [])])
  } else if (action === 'merge') {
    output = await run(['merge', '--no-edit', normalizeActionRevision(request.ref)])
  } else if (action === 'tag') {
    const name = await normalizeNewRefName(snapshot.root, request.name, 'tag')
    output = await run(['tag', name, normalizeActionRevision(request.ref)])
  } else if (action === 'reset') {
    const mode = String(request.mode || 'mixed')
    if (!['soft', 'mixed', 'hard'].includes(mode)) throw Error('Reset mode must be soft, mixed, or hard.')
    output = await run(['reset', `--${mode}`, normalizeOid(request.ref)])
  } else if (action === 'cherry-pick' || action === 'revert') {
    output = await run([action, ...(action === 'revert' ? ['--no-edit'] : []), normalizeOid(request.ref)])
  } else throw Error('Unsupported Git action.')

  return { action, message: output.trim() || `${action} completed.` }
}

export async function gitConnectionState() {
  try {
    const version = (await git(process.cwd(), ['--version'])).trim()
    return { connected: true, status: 'connected' as const, message: version }
  } catch (error) {
    return { connected: false, status: 'unavailable' as const, message: error instanceof Error ? error.message : 'Git is unavailable.' }
  }
}

export function parseGitReferences(raw: string): GitReference[] {
  return raw.split('\n').flatMap(line => {
    if (!line) return []
    const [fullName, name, oid, upstream, head] = line.split('\0')
    const kind = fullName.startsWith('refs/heads/') ? 'branch' : fullName.startsWith('refs/remotes/') ? 'remote-branch' : fullName.startsWith('refs/tags/') ? 'tag' : undefined
    if (!kind || !name || !oid) return []
    return [{ name, fullName, oid, kind, ...(head === '*' ? { current: true } : {}), ...(upstream ? { upstream } : {}) }]
  })
}

export function parseGitRemotes(raw: string): GitRemote[] {
  const remotes = new Map<string, GitRemote>()
  for (const line of raw.split('\n')) {
    const match = line.match(/^(\S+)\s+(.+)\s+\((fetch|push)\)$/)
    if (!match) continue
    const item = remotes.get(match[1]) || { name: match[1] }
    if (match[3] === 'fetch') item.fetchUrl = match[2]
    else item.pushUrl = match[2]
    remotes.set(item.name, item)
  }
  return [...remotes.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function parseGitLog(raw: string): GitCommit[] {
  return raw.split('\x1e').map(record => parseGitCommitRecord(record.trim())).filter((item): item is GitCommit => Boolean(item))
}

export function parseGitChangedFiles(raw: string): GitChangedFile[] {
  const parts = raw.split('\0'), files: GitChangedFile[] = []
  for (let index = 0; index < parts.length;) {
    const status = parts[index++]
    if (!status) continue
    const renamed = status[0] === 'R' || status[0] === 'C'
    const first = parts[index++] || ''
    const second = renamed ? parts[index++] || '' : ''
    const path = renamed ? second : first
    if (path) files.push({ path, status, ...(renamed && first ? { previousPath: first } : {}) })
  }
  return files
}

function parseGitCommitRecord(record: string): GitCommit | null {
  const [oid, parents = '', authorName = '', authorEmail = '', authoredAt = '', subject = '', decorations = ''] = record.split('\x1f')
  if (!/^[0-9a-f]{40,64}$/i.test(oid || '')) return null
  return {
    oid,
    parents: parents.trim() ? parents.trim().split(/\s+/) : [],
    authorName,
    authorEmail,
    authoredAt,
    subject,
    refs: decorations.split(',').map(item => item.trim()).filter(Boolean),
  }
}

function normalizeRevision(value: unknown) {
  const revision = String(value || '').trim()
  if (!revision) return ''
  if (revision === 'HEAD') return revision
  if (!/^refs\/(?:heads|remotes|tags)\/[\p{L}\p{N}._/@+-]+$/u.test(revision) || revision.includes('..') || revision.endsWith('/')) throw Error('Invalid Git reference.')
  return revision
}

function normalizeOid(value: unknown) {
  const oid = String(value || '').trim()
  if (!/^[0-9a-f]{7,64}$/i.test(oid)) throw Error('Invalid commit identifier.')
  return oid
}

function normalizeGitPath(value: unknown) {
  const path = String(value || '')
  if (!path || path.includes('\0') || path.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(path)) throw Error('Invalid repository path.')
  return path
}

function normalizeChangedPaths(value: unknown, snapshot: RepositorySnapshot) {
  const paths = normalizeChangedPathList(value)
  const changed = new Set(snapshot.files.map(file => file.path))
  if (paths.some(path => !changed.has(path))) throw Error('Git action path is not a current working-tree change.')
  return paths
}

function normalizeChangedPathList(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 200) throw Error('Git action requires between 1 and 200 changed paths.')
  return [...new Set(value.map(normalizeGitPath))]
}

async function scopedChangedPaths(workspace: string, value: unknown) {
  const paths = normalizeChangedPathList(value)
  const root = (await git(workspace, ['rev-parse', '--show-toplevel'])).trim()
  const raw = await git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', ...paths])
  const snapshot = parsePorcelainV2(root, raw)
  return { snapshot, paths: normalizeChangedPaths(paths, snapshot) }
}

function normalizeGitMessage(value: unknown, label: string) {
  const message = String(value || '').trim()
  if (!message || message.length > 5_000 || message.includes('\0')) throw Error(`${label} must contain 1 to 5000 characters.`)
  return message
}

function normalizeActionRevision(value: unknown) {
  const revision = String(value || '').trim()
  if (/^[0-9a-f]{7,64}$/i.test(revision)) return revision
  return normalizeRevision(revision)
}

function normalizeLocalBranch(value: unknown) {
  const revision = normalizeRevision(value)
  if (!revision.startsWith('refs/heads/')) throw Error('Checkout requires a local branch.')
  return revision
}

async function normalizeNewRefName(root: string, value: unknown, kind: 'branch' | 'tag') {
  const name = String(value || '').trim()
  if (!name || name.length > 250 || name.startsWith('-') || name.includes('\0')) throw Error(`Invalid Git ${kind} name.`)
  const candidate = kind === 'tag' ? `refs/tags/${name}` : `refs/heads/${name}`
  try { await git(root, ['check-ref-format', candidate]) } catch { throw Error(`Invalid Git ${kind} name.`) }
  return name
}

function boundWorkbenchDiff(value: string) {
  const bytes = Buffer.from(value)
  if (bytes.length <= maxWorkbenchDiffBytes) return value
  return `${bytes.subarray(0, maxWorkbenchDiffBytes).toString('utf8').replace(/\uFFFD$/, '')}\n\n[Diff truncated at ${Math.round(maxWorkbenchDiffBytes / 1000)} KB]`
}

async function readWorkingTreeFile(root: string, path: string) {
  const realRoot = await realpath(root), target = await realpath(resolve(realRoot, path)), resolved = relative(realRoot, target)
  if (resolved === '..' || resolved.startsWith(`..${sep}`) || isAbsolute(resolved)) throw Error('Repository file escapes the selected workspace.')
  const info = await stat(target)
  if (!info.isFile()) throw Error('Repository preview target must be a file.')
  if (info.size > maxWorkbenchPreviewBytes) throw Error('Image preview exceeds the 12 MB limit.')
  return readFile(target)
}

function previewImageMime(data: Buffer) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (data.length >= 2 && data.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp'
  if (data.length >= 4 && data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 0) return 'image/x-icon'
  if (data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp' && /^(?:avif|avis)$/.test(data.subarray(8, 12).toString('ascii'))) return 'image/avif'
  return ''
}

export function parsePorcelainV2(root: string, raw: string): RepositorySnapshot {
  const records = raw.split('\0'), files: RepositoryFileState[] = []
  let head = '', oid = '', upstream: string | undefined, ahead = 0, behind = 0
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record) continue
    if (record.startsWith('# branch.oid ')) { oid = record.slice(13); continue }
    if (record.startsWith('# branch.head ')) { head = record.slice(14); continue }
    if (record.startsWith('# branch.upstream ')) { upstream = record.slice(18); continue }
    if (record.startsWith('# branch.ab ')) {
      const match = record.match(/\+(\d+)\s+-(\d+)/)
      ahead = Number(match?.[1] || 0); behind = Number(match?.[2] || 0); continue
    }
    if (record.startsWith('? ')) {
      files.push({ path: record.slice(2), index: '?', worktree: '?', staged: false, unstaged: false, untracked: true, conflicted: false })
      continue
    }
    const kind = record[0]
    if (kind !== '1' && kind !== '2' && kind !== 'u') continue
    const parts = record.split(' '), xy = parts[1] || '..'
    const pathOffset = kind === '1' ? 8 : kind === '2' ? 9 : 10
    const path = parts.slice(pathOffset).join(' ')
    if (kind === '2') index++ // The original path is the next NUL record.
    const indexState = xy[0] || '.', worktreeState = xy[1] || '.', conflicted = kind === 'u' || /[ADU]/.test(indexState + worktreeState)
    files.push({
      path,
      index: indexState,
      worktree: worktreeState,
      staged: indexState !== '.',
      unstaged: worktreeState !== '.',
      untracked: false,
      conflicted,
    })
  }
  const detached = head === '(detached)'
  return { root, head: detached ? oid.slice(0, 12) : head, oid, upstream, ahead, behind, detached, files }
}

async function git(cwd: string, args: string[], timeout = 15_000, nonInteractive = false) {
  const env = nonInteractive ? { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } : undefined
  const { stdout } = await execFile('git', args, { cwd, timeout, maxBuffer: 8_000_000, encoding: 'utf8', env })
  return stdout
}

async function gitBinary(cwd: string, args: string[]) {
  return new Promise<Buffer>((resolve, reject) => execFileCallback('git', args, { cwd, timeout: 15_000, maxBuffer: maxWorkbenchPreviewBytes + 1024, encoding: 'buffer' }, (error, stdout) => {
    if (error) reject(error)
    else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
  }))
}
