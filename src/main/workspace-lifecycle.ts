import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export type WorkspaceAvailability =
  | { available: true; path: string; resolvedPath: string; device: number; inode: number }
  | { available: false; path: string; reason: 'missing' | 'not-directory' }

export class WorkspaceUnavailableError extends Error {
  readonly code = 'WORKSPACE_UNAVAILABLE'
  readonly workspace: string

  constructor(workspace: string) {
    super(`Workspace moved or deleted: ${workspace}`)
    this.name = 'WorkspaceUnavailableError'
    this.workspace = workspace
  }
}

export async function workspaceAvailability(workspace: string): Promise<WorkspaceAvailability> {
  const path = resolve(workspace)
  try {
    const info = await stat(path)
    if (!info.isDirectory()) return { available: false, path, reason: 'not-directory' }
    return { available: true, path, resolvedPath: await realpath(path), device: info.dev, inode: info.ino }
  } catch {
    return { available: false, path, reason: 'missing' }
  }
}

export async function requireWorkspace(workspace: string) {
  const status = await workspaceAvailability(workspace)
  if (!status.available) throw new WorkspaceUnavailableError(status.path)
  return status
}

export async function monitorWorkspace(
  workspace: string,
  unavailable: (error: WorkspaceUnavailableError) => void,
  intervalMs = 500,
) {
  const initial = await requireWorkspace(workspace)
  let checking = false, stopped = false
  const timer = setInterval(async () => {
    if (checking || stopped) return
    checking = true
    try {
      const status = await workspaceAvailability(initial.path)
      if (stopped) return
      if (!status.available || status.resolvedPath !== initial.resolvedPath || status.device !== initial.device || status.inode !== initial.inode) {
        stopped = true
        clearInterval(timer)
        unavailable(new WorkspaceUnavailableError(initial.path))
      }
    } finally {
      checking = false
    }
  }, intervalMs)
  timer.unref()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

export function isWorkspaceUnavailable(error: unknown): error is WorkspaceUnavailableError {
  return error instanceof WorkspaceUnavailableError
}
