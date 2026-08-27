import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, parse, resolve } from 'node:path'

export type RemoteWorkspaceEntry = {
  name: string
  path: string
}

export type RemoteWorkspaceDirectory = {
  path: string
  parent?: string
  entries: RemoteWorkspaceEntry[]
  truncated?: boolean
}

const MAX_REMOTE_WORKSPACE_ENTRIES = 250

/** Lists Desktop folders for an authenticated paired Mobile device. */
export async function browseRemoteWorkspaces(requestedPath?: string): Promise<RemoteWorkspaceDirectory> {
  const path = resolve(requestedPath?.trim() || homedir())
  const info = await stat(path)
  if (!info.isDirectory()) throw Error('Workspace path is not a folder.')

  const directories = (await readdir(path, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
  const visible = directories.slice(0, MAX_REMOTE_WORKSPACE_ENTRIES)
  const root = parse(path).root

  return {
    path,
    ...(path !== root ? { parent: dirname(path) } : {}),
    entries: visible.map(entry => ({ name: entry.name, path: resolve(path, entry.name) })),
    ...(directories.length > visible.length ? { truncated: true } : {}),
  }
}
