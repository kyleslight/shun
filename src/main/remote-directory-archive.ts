import { createReadStream, closeSync, openSync, writeSync } from 'node:fs'
import { lstat, mkdtemp, readdir, readlink, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Zip, ZipPassThrough } from 'fflate'

const sources = new Map<string, string>()
export const archiveSource = (path: string) => sources.get(path)

export async function archiveDirectory(path: string, maxBytes: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'shun-download-'))
  const destination = join(directory, `${basename(path) || 'folder'}.zip`)
  const fd = openSync(destination, 'wx')
  let closed = false
  let outputBytes = 0, inputBytes = 0, entries = 0
  let failure: Error | undefined
  const zip = new Zip((error, data) => {
    if (error) { failure = error; return }
    outputBytes += data.length
    if (outputBytes > maxBytes) { failure = Error('Folder archive exceeds the 256 MB download limit.'); return }
    let offset = 0
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset)
  })
  const check = () => { if (failure) throw failure }
  const walk = async (source: string, name: string): Promise<void> => {
    if (++entries > 10000) throw Error('Folder contains too many entries to download.')
    const info = await lstat(source)
    const folder = info.isDirectory()
    if (!folder && !info.isFile() && !info.isSymbolicLink()) throw Error('Folder contains an unsupported file type.')
    const entry = new ZipPassThrough(folder ? `${name}/` : name)
    entry.os = 3
    entry.attrs = ((folder ? 0o40755 : info.isSymbolicLink() ? 0o120777 : 0o100000 | (info.mode & 0o777)) << 16) >>> 0
    entry.mtime = info.mtime
    zip.add(entry)
    check()
    if (folder) {
      entry.push(new Uint8Array(), true)
      for (const child of await readdir(source)) await walk(join(source, child), `${name}/${child}`)
    } else if (info.isSymbolicLink()) {
      const bytes = Buffer.from(await readlink(source))
      inputBytes += bytes.length
      if (inputBytes > maxBytes) throw Error('Folder exceeds the 256 MB download limit.')
      entry.push(bytes, true)
    } else {
      for await (const chunk of createReadStream(source, { highWaterMark: 192 * 1024 })) {
        inputBytes += chunk.length
        if (inputBytes > maxBytes) throw Error('Folder exceeds the 256 MB download limit.')
        entry.push(chunk, false)
        check()
      }
      entry.push(new Uint8Array(), true)
    }
    check()
  }
  try {
    await walk(path, basename(path) || 'folder')
    zip.end()
    check()
    await stat(destination)
    sources.set(destination, path)
    setTimeout(() => {
      sources.delete(destination)
      void rm(directory, { recursive: true, force: true }).catch(() => {})
    }, 60 * 60 * 1000).unref()
    return destination
  } catch (error) {
    zip.terminate()
    closeSync(fd)
    closed = true
    await rm(directory, { recursive: true, force: true })
    throw error
  } finally { if (!closed) closeSync(fd) }
}
