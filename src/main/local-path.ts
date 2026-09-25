import { realpath, stat } from 'node:fs/promises'
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

export async function existingLocalPath(value: unknown) {
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
