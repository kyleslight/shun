import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { realDirectory } from './local-path.ts'
import { ignoredDirectories, ignoredFiles } from './workspace-review.ts'

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
  /** Entries this listing left out because they are generated state or hidden. */
  hiddenCount?: number
}

/**
 * A workspace as someone browsing it expects to see it: source, not the state
 * around it. Dependency and build trees and dotfiles are left out unless they
 * are asked for, using the same list that already decides what this product
 * treats as source rather than generated state.
 */
export function isHiddenWorkspaceEntry(name: string) {
  return name.startsWith('.') || ignoredDirectories.has(name) || ignoredFiles.has(name)
}

export async function listWorkspaceDirectory(root: string, requested?: string, options: { includeHidden?: boolean } = {}): Promise<WorkspaceDirectoryListing> {
  const workspace = await realDirectory(root)
  const wanted = String(requested ?? '').trim() || workspace
  const target = await realDirectory(wanted)
  const inside = relative(workspace, target)
  if (inside && (inside.startsWith('..') || isAbsolute(inside))) throw Error('That folder is outside this task workspace.')

  const all = (await readdir(target, { withFileTypes: true })).filter(entry => !entry.isSymbolicLink())
  const directories = options.includeHidden ? all : all.filter(entry => !isHiddenWorkspaceEntry(entry.name))
  directories.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
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
    ...(all.length > directories.length ? { hiddenCount: all.length - directories.length } : {}),
  }
}
