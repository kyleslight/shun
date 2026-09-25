import { open, rm } from 'node:fs/promises'
import { basename } from 'node:path'

/**
 * Pulling a file off the other Shun.
 *
 * The peer only hands out paths it can justify — one the conversation mentions,
 * or one inside the task's workspace — so this side asks for a path and writes
 * the answer to a destination the person chose. A download that stops halfway
 * removes what it wrote: a partial file that looks whole is worse than none.
 */
export const REMOTE_DOWNLOAD_MAX_BYTES = 128 * 1024 * 1024

export type RemoteFileInfo = { path: string; name: string; size: number; mimeType: string; chunkSize: number }
export type RemoteFileChunk = { offset: number; data: string; bytes: number; eof: boolean }

export function remoteDownloadName(info: { name?: string; path: string }) {
  return info.name || basename(info.path)
}

export async function saveRemoteFile(options: {
  request: (kind: string, payload: Record<string, unknown>) => Promise<unknown>
  taskId: string
  path: string
  destination: string
  onProgress?: (bytes: number, total: number) => void
}) {
  const info = await options.request('file.download.info', { taskId: options.taskId, path: options.path }) as RemoteFileInfo
  if (!info?.path || !Number.isSafeInteger(info.size) || info.size < 0) throw Error('The other Shun did not describe that file.')
  if (info.size > REMOTE_DOWNLOAD_MAX_BYTES) throw Error('This file is larger than the 128 MB remote download limit.')
  const handle = await open(options.destination, 'w')
  let written = 0
  try {
    while (written < info.size) {
      const chunk = await options.request('file.download.chunk', { taskId: options.taskId, path: info.path, offset: written, length: info.chunkSize }) as RemoteFileChunk
      const buffer = Buffer.from(String(chunk?.data ?? ''), 'base64')
      if (!buffer.length) break
      if (buffer.length !== chunk.bytes) throw Error('The other Shun returned a truncated chunk.')
      await handle.write(buffer)
      written += buffer.length
      options.onProgress?.(written, info.size)
      if (chunk.eof) break
    }
    if (written !== info.size) throw Error('The download stopped before the whole file arrived.')
  } catch (error) {
    // Anything short of the whole file removes what was written: a partial file
    // that looks complete is worse than no file at all.
    await rm(options.destination, { force: true }).catch(() => {})
    throw error
  } finally {
    await handle.close()
  }
  return { source: info.path, name: remoteDownloadName(info), bytes: written, destination: options.destination }
}
