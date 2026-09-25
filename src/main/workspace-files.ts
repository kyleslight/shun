import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { realDirectory } from './local-path.ts'

/**
 * Browsing a task's workspace from the other Shun.
 *
 * The workspace is the boundary: a controller that drives a task can look at
 * the tree that task is working in — the same tree its tools already read and
 * write — and nothing outside it. Containment is checked on the resolved real
 * path, so a symlink pointing out of the workspace is refused rather than
 * followed.
 */
export const MAX_WORKSPACE_ENTRIES = 500

export type WorkspaceFileEntry = {
  name: string
  path: string
  kind: 'directory' | 'file'
  size?: number
  modifiedAt?: number
}

export type WorkspaceDirectoryListing = {
  path: string
  root: string
  parent?: string
  entries: WorkspaceFileEntry[]
  truncated?: boolean
}

export async function listWorkspaceDirectory(root: string, requested?: string): Promise<WorkspaceDirectoryListing> {
  const workspace = await realDirectory(root)
  const wanted = String(requested ?? '').trim() || workspace
  const target = await realDirectory(wanted)
  const inside = relative(workspace, target)
  if (inside && (inside.startsWith('..') || isAbsolute(inside))) throw Error('That folder is outside this task workspace.')

  const directories = (await readdir(target, { withFileTypes: true }))
    .filter(entry => !entry.isSymbolicLink())
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
  const visible = directories.slice(0, MAX_WORKSPACE_ENTRIES)
  const entries = await Promise.all(visible.map(async (entry): Promise<WorkspaceFileEntry> => {
    const path = join(target, entry.name)
    if (entry.isDirectory()) return { name: entry.name, path, kind: 'directory' }
    const metadata = await stat(path).catch(() => undefined)
    return { name: entry.name, path, kind: 'file', size: metadata?.size, modifiedAt: metadata?.mtimeMs }
  }))

  return {
    path: target,
    root: workspace,
    ...(target !== workspace ? { parent: resolve(target, '..') } : {}),
    entries,
    ...(directories.length > visible.length ? { truncated: true } : {}),
  }
}
