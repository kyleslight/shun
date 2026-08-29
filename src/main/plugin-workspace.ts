import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const maxEntries = 2_000
const maxChunkBytes = 1024 * 1024
const maxSearchEntries = 500
const maxSearchScanned = 100_000
const skippedSearchDirectories = new Set(['.git', 'node_modules'])
const execFile = promisify(execFileCallback)

export type PluginWorkspaceEntry = { path: string; name: string; kind: 'file' | 'directory'; size?: number; modifiedAt: string }

export async function listPluginWorkspace(workspace: string, input: unknown) {
  const request = object(input), requestedLimit = integer(request.limit, 500, 1, maxEntries), recursive = request.recursive === true
  const root = await realpath(resolve(workspace)), start = await inside(root, request.path || '.')
  if (!(await stat(start)).isDirectory()) throw Error('Workspace list target must be a directory.')
  const entries: PluginWorkspaceEntry[] = []
  async function walk(directory: string, depth: number) {
    if (depth > 20 || entries.length >= requestedLimit) return
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= requestedLimit) return
      const path = resolve(directory, entry.name), info = await lstat(path)
      if (info.isSymbolicLink()) continue
      const relativePath = relative(root, path).split(sep).join('/')
      if (entry.isDirectory()) {
        entries.push({ path: relativePath, name: entry.name, kind: 'directory', modifiedAt: info.mtime.toISOString() })
        if (recursive && entry.name !== '.git' && entry.name !== 'node_modules') await walk(path, depth + 1)
      } else if (entry.isFile()) entries.push({ path: relativePath, name: entry.name, kind: 'file', size: info.size, modifiedAt: info.mtime.toISOString() })
    }
  }
  await walk(start, 0)
  return { root: relative(root, start).split(sep).join('/') || '.', entries, truncated: entries.length >= requestedLimit, limit: requestedLimit }
}

export async function readPluginWorkspaceFile(workspace: string, input: unknown) {
  const request = object(input), pathValue = String(request.path || '').trim()
  if (!pathValue) throw Error('Workspace file path is required.')
  const root = await realpath(resolve(workspace)), target = await inside(root, pathValue), info = await stat(target)
  if (!info.isFile()) throw Error('Workspace read target must be a file.')
  const offset = integer(request.offset, 0, 0, info.size), requested = integer(request.length, maxChunkBytes, 1, maxChunkBytes), length = Math.min(requested, info.size - offset)
  const buffer = Buffer.alloc(length), handle = await open(target, 'r')
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, offset), nextOffset = offset + bytesRead
    return {
      path: relative(root, target).split(sep).join('/'),
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      offset,
      bytesRead,
      nextOffset: nextOffset < info.size ? nextOffset : undefined,
      encoding: 'base64' as const,
      data: buffer.subarray(0, bytesRead).toString('base64'),
    }
  } finally { await handle.close() }
}

export async function resolvePluginWorkspaceFile(workspace: string, pathValue: unknown) {
  const value = String(pathValue || '').trim()
  if (!value) throw Error('Workspace file path is required.')
  const root = await realpath(resolve(workspace)), target = await inside(root, value), info = await stat(target)
  if (!info.isFile()) throw Error('Workspace path must identify a file.')
  return { root, target, path: relative(root, target).split(sep).join('/'), info }
}

export async function searchPluginWorkspace(workspace: string, input: unknown) {
  const request = object(input), query = String(request.query || '').trim().toLowerCase()
  if (!query) return { entries: [] as PluginWorkspaceEntry[], truncated: false, scanned: 0 }
  if (query.length > 200) throw Error('Workspace search query is too long.')
  const requestedLimit = integer(request.limit, 200, 1, maxSearchEntries), root = await realpath(resolve(workspace))
  if (request.includeIgnored !== true) {
    const gitResult = await searchGitWorkspace(root, query, requestedLimit)
    if (gitResult) return gitResult
  }
  const entries: PluginWorkspaceEntry[] = [], pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }]
  let scanned = 0, capped = false
  while (pending.length && entries.length < requestedLimit && scanned < maxSearchScanned) {
    const current = pending.pop()!
    let children
    try { children = await readdir(current.directory, { withFileTypes: true }) }
    catch (error) { if (current.directory === root) throw error; continue }
    for (const entry of children) {
      if (++scanned > maxSearchScanned) { capped = true; break }
      if (entry.isSymbolicLink()) continue
      const target = resolve(current.directory, entry.name), path = relative(root, target).split(sep).join('/'), directory = entry.isDirectory()
      if (directory && current.depth < 30 && !skippedSearchDirectories.has(entry.name)) pending.push({ directory: target, depth: current.depth + 1 })
      if ((!directory && !entry.isFile()) || !path.toLowerCase().includes(query)) continue
      const info = await lstat(target)
      entries.push({ path, name: entry.name, kind: directory ? 'directory' : 'file', ...(directory ? {} : { size: info.size }), modifiedAt: info.mtime.toISOString() })
      if (entries.length >= requestedLimit) break
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return { entries, truncated: capped || entries.length >= requestedLimit || pending.length > 0, scanned }
}

async function searchGitWorkspace(root: string, query: string, limit: number) {
  let stdout = ''
  try {
    const result = await execFile('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], { encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024 })
    stdout = result.stdout
  } catch { return undefined }
  const paths = stdout.split('\0').filter(Boolean), entries: PluginWorkspaceEntry[] = []
  let scanned = 0
  for (const path of paths) {
    if (scanned >= maxSearchScanned || entries.length >= limit) break
    scanned++
    if (path.split('/').some(part => skippedSearchDirectories.has(part)) || !path.toLowerCase().includes(query)) continue
    const target = resolve(root, path)
    assertInside(root, target)
    let info
    try { info = await lstat(target) } catch { continue }
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) continue
    entries.push({ path, name: path.split('/').pop() || path, kind: info.isDirectory() ? 'directory' : 'file', ...(info.isFile() ? { size: info.size } : {}), modifiedAt: info.mtime.toISOString() })
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return { entries, truncated: scanned < paths.length || scanned >= maxSearchScanned, scanned }
}

export async function revealPluginWorkspacePath(workspace: string, input: unknown) {
  const request = object(input), pathValue = String(request.path || '').trim()
  if (!pathValue) throw Error('Workspace path is required.')
  const root = await realpath(resolve(workspace)), requested = resolve(root, pathValue)
  assertInside(root, requested)
  let target = requested, exact = true
  while (true) {
    try { target = await realpath(target); break }
    catch {
      const parent = dirname(target)
      if (parent === target || target === root) throw Error('Workspace path is unavailable.')
      target = parent; exact = false
    }
  }
  assertInside(root, target)
  const info = await stat(target), path = relative(root, target).split(sep).join('/') || '.'
  return { target, path, kind: info.isDirectory() ? 'directory' as const : 'file' as const, exact }
}

async function inside(root: string, value: unknown) {
  const requested = String(value || '.')
  if (isAbsolute(requested)) throw Error('Plugin workspace paths must be relative.')
  const target = await realpath(resolve(root, requested))
  assertInside(root, target)
  return target
}

function assertInside(root: string, target: string) {
  const path = relative(root, target)
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw Error('Plugin workspace path escapes the selected workspace.')
}

function object(value: unknown): Record<string, any> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Plugin workspace request must be an object.')
  return value as Record<string, any>
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw Error(`Value must be an integer from ${minimum} to ${maximum}.`)
  return number
}
