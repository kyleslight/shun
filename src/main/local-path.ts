import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

function decodedLocalPath(value: unknown) {
  const input = String(value || '').trim()
  if (!input || input.length > 16_384 || /\u0000/.test(input)) throw Error('Enter a valid absolute local path.')
  if (/^file:\/\//i.test(input)) {
    try { return fileURLToPath(input) } catch { throw Error('Enter a valid local file URL.') }
  }
  let decoded = input
  try { decoded = decodeURIComponent(input) } catch {}
  if (!isAbsolute(decoded)) throw Error('Only absolute local paths can be opened.')
  return resolve(decoded)
}

// Generated links can retain an incorrect home directory. Recover only managed
// task paths with a verifiable task identity, never arbitrary same-name files.
async function managedTaskPath(requested: string, runtimeRoot: string) {
  const match = requested.match(/^\/(?:Users|home)\/[^/]+\/\.shun\/standalone\/([A-Za-z0-9_-]+)\/(.+)$/)
  if (!match) return undefined
  const [, identity, suffix] = match
  const taskId = Buffer.from(identity, 'base64url').toString('utf8')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) return undefined
  if (Buffer.from(taskId).toString('base64url') !== identity) return undefined
  try {
    const root = await realpath(resolve(runtimeRoot, 'standalone', identity))
    const path = await realpath(resolve(root, suffix))
    const child = relative(root, path)
    if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) return undefined
    return path
  } catch { return undefined }
}

export async function existingLocalPath(value: unknown, runtimeRoot = process.env.SHUN_HOME || resolve(homedir(), '.shun')) {
  const requested = decodedLocalPath(value)
  const candidates = [requested]
  const withoutLocation = requested.match(/^(.*?):\d+(?::\d+)?$/)?.[1]
  if (withoutLocation && withoutLocation !== requested) candidates.push(withoutLocation)
  for (const path of candidates) try {
    const info = await stat(path)
    if (!info.isFile() && !info.isDirectory()) throw Error('Local path is not a file or directory.')
    return { path, kind: info.isDirectory() ? 'directory' as const : 'file' as const }
  } catch (error) {
    if (error instanceof Error && error.message === 'Local path is not a file or directory.') throw error
  }
  for (const candidate of candidates) {
    const path = await managedTaskPath(candidate, runtimeRoot)
    if (!path) continue
    const info = await stat(path)
    if (info.isFile() || info.isDirectory()) return { path, kind: info.isDirectory() ? 'directory' as const : 'file' as const }
  }
  throw Error('Local file or folder no longer exists.')
}

/**
 * The real path of a folder. Containment has to be decided on real paths:
 * comparing an unresolved path against a real one lets a symlink out of the
 * directory it appears to be inside of.
 */
export async function realDirectory(value: unknown) {
  const target = await existingLocalPath(value)
  if (target.kind !== 'directory') throw Error('Only folders can be browsed.')
  return realpath(target.path)
}

export async function describeLocalPath(value: unknown, workspaceValue?: unknown) {
  const target = await existingLocalPath(value)
  const path = await realpath(target.path)
  let workspaceRelative: string | undefined
  const workspace = String(workspaceValue || '').trim()
  if (workspace && isAbsolute(workspace)) try {
    const root = await realpath(resolve(workspace))
    const candidate = relative(root, path)
    if (!isAbsolute(candidate) && candidate !== '..' && !candidate.startsWith(`..${sep}`)) workspaceRelative = candidate ? candidate.split(sep).join('/') : '.'
  } catch {}
  return { ...target, path, ...(workspaceRelative ? { workspaceRelative } : {}) }
}
