import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import type { RepositoryFileState, RepositorySnapshot } from '../shared.ts'
import { patchesForFiles } from './workspace-review.ts'

const execFile = promisify(execFileCallback)

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

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFile('git', args, { cwd, timeout: 15_000, maxBuffer: 8_000_000, encoding: 'utf8' })
  return stdout
}
