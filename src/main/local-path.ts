import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
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
