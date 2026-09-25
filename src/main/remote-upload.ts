import { open, stat } from 'node:fs/promises'
import { basename } from 'node:path'

/**
 * Sending a file to the machine that will read it.
 *
 * The relay carries frames, so a file travels in bounded chunks and the peer
 * assembles them into one of its own attachments; the message that follows names
 * that attachment by id. The bytes never enter the renderer: it asks for the
 * file to be sent, and the process that owns the file and the socket sends it.
 */
export const REMOTE_UPLOAD_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_CHUNK_BYTES = 384 * 1024

export type RemoteAttachmentRef = { id: string; name: string; kind?: string; size?: number; mimeType?: string }

export async function uploadRemoteFile(options: {
  request: (kind: string, payload: Record<string, unknown>) => Promise<unknown>
  taskId: string
  path: string
  onProgress?: (sent: number, total: number) => void
}): Promise<RemoteAttachmentRef> {
  const info = await stat(options.path).catch(() => undefined)
  if (!info?.isFile()) throw Error('Only files can be attached.')
  if (info.size > REMOTE_UPLOAD_MAX_BYTES) throw Error('This file is larger than the 64 MB attachment limit.')
  const name = basename(options.path)
  const begun = await options.request('attachment.upload.begin', { taskId: options.taskId, name, size: info.size }) as { uploadId?: string; chunkSize?: number }
  const uploadId = String(begun?.uploadId || '')
  if (!uploadId) throw Error('The other Shun did not accept the upload.')
  const chunkSize = Number(begun?.chunkSize) > 0 ? Number(begun?.chunkSize) : DEFAULT_CHUNK_BYTES
  const handle = await open(options.path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(chunkSize)
    let offset = 0
    while (offset < info.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(chunkSize, info.size - offset), offset)
      if (!bytesRead) break
      await options.request('attachment.upload.chunk', {
        uploadId,
        index: Math.floor(offset / chunkSize),
        data: buffer.subarray(0, bytesRead).toString('base64url'),
      })
      offset += bytesRead
      options.onProgress?.(offset, info.size)
    }
    if (offset !== info.size) throw Error('The file could not be read to its end.')
  } catch (error) {
    await options.request('attachment.upload.abort', { uploadId }).catch(() => {})
    throw error
  } finally {
    await handle.close()
  }
  const ready = await options.request('attachment.upload.complete', { uploadId }) as RemoteAttachmentRef
  if (!ready?.id) throw Error('The other Shun did not finish the upload.')
  return ready
}
