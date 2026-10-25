import { isAbsolute, basename } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Accept a single pasted image path; ordinary pasted text stays in the editor. */
export async function pastedImage(text: string): Promise<{ bytes: Buffer; name: string } | undefined> {
  let path = text.trim()
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1)
  else path = path.replace(/\\([ ()\[\]'"\\])/g, '$1')
  try {
    if (path.startsWith('file://')) path = fileURLToPath(path)
    if (!isAbsolute(path) || !/\.(png|jpe?g|gif|webp)$/i.test(path)) return
    const info = await stat(path)
    if (!info.isFile() || info.size === 0 || info.size > 20 * 1024 * 1024) return
    return { bytes: await readFile(path), name: basename(path) }
  } catch { return }
}
