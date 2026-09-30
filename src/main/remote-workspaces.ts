import { mkdir, readdir, stat } from 'node:fs/promises'
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

/**
 * Creates one folder inside a folder Desktop is already showing a paired device,
 * and answers with that folder as it now is.
 *
 * A device that has to work in a folder that does not exist yet had no way to say
 * so: the only reachable folders were the ones already there, so the run had to be
 * started somewhere else and moved afterwards. The name is one segment on purpose
 * — the parent comes from the listing the device is looking at, and a name that
 * could carry a path would let a tap choose a directory nobody was shown.
 */
export async function createRemoteWorkspaceFolder(parent: string, name: string): Promise<RemoteWorkspaceDirectory> {
  const directory = resolve(parent?.trim() || homedir())
  const folder = String(name ?? '').trim()
  if (!folder) throw Error('Folder name is required.')
  if (folder.length > 128) throw Error('That folder name is too long.')
  if (folder !== folder.split(/[\\/]/).join('') || folder === '.' || folder === '..' || folder.startsWith('.')) {
    throw Error('That folder name cannot be used.')
  }
  if (folder.includes('\u0000')) throw Error('That folder name cannot be used.')
  const info = await stat(directory).catch(() => undefined)
  if (!info?.isDirectory()) throw Error('Workspace path is not a folder.')
  const target = resolve(directory, folder)
  if (dirname(target) !== directory || target === directory) throw Error('That folder name cannot be used.')
  try {
    await mkdir(target, { recursive: false })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw Error('A folder with that name already exists.')
    throw error
  }
  return browseRemoteWorkspaces(directory)
}
