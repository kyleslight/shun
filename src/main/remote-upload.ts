import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

/**
 * Sending a file to the machine that will read it.
 *
 * The relay carries frames, so a file travels in bounded chunks and the peer
 * assembles them into one of its own attachments; the message that follows names
 * that attachment by id. The bytes never enter the renderer: it asks for the
 * file to be sent, and the process that owns the file and the socket sends it.
 */
export const REMOTE_UPLOAD_MAX_BYTES = 64 * 1024 * 1024
/** One message carries a handful of files, not a folder. */
export const REMOTE_UPLOAD_LIMIT = 8
const DEFAULT_CHUNK_BYTES = 384 * 1024

export type RemoteAttachmentRef = { id: string; name: string; kind?: string; size?: number; mimeType?: string }

export type RemoteUploadRequest = (kind: string, payload: Record<string, unknown>) => Promise<unknown>

/**
 * Uploading several files in one go, one at a time.
 *
 * The first refusal stops the batch: the files already uploaded belong to the
 * peer's task, and carrying on past one it refused would send a set nobody
 * asked for.
 */
export async function uploadRemoteFiles(options: {
  request: RemoteUploadRequest
  taskId: string
  paths: string[]
  onProgress?: (sent: number, total: number) => void
}): Promise<RemoteAttachmentRef[]> {
  const uploaded: RemoteAttachmentRef[] = []
  for (const path of options.paths.slice(0, REMOTE_UPLOAD_LIMIT)) {
    uploaded.push(await uploadRemoteFile({ request: options.request, taskId: options.taskId, path, onProgress: options.onProgress }))
  }
  return uploaded
}

/**
 * Uploading files this machine holds only in memory — a screenshot on the
 * clipboard.
 *
 * They travel the way a file on disk does, from a private temporary file named
 * after the attachment so the peer keeps the person's name. That file has to
 * outlive the upload that reads it: cleaning up *around* the upload rather than
 * after it deletes the file the upload is still opening, which is what an
 * unawaited return inside a `finally` did — every pasted image failed with its
 * own temporary path reported as missing.
 */
export async function uploadRemoteFileData(options: {
  request: RemoteUploadRequest
  taskId: string
  files: Array<{ name?: unknown; data?: unknown }>
}): Promise<RemoteAttachmentRef[]> {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-attach-'))
  try {
    const written: string[] = [], used = new Set<string>()
    for (const [index, item] of options.files.slice(0, REMOTE_UPLOAD_LIMIT).entries()) {
      const raw = item?.data
      const buffer = raw instanceof ArrayBuffer
        ? Buffer.from(raw)
        : ArrayBuffer.isView(raw) ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : Buffer.alloc(0)
      if (!buffer.length) continue
      const path = join(directory, uniqueAttachmentName(String(item?.name || ''), index, used))
      await writeFile(path, buffer)
      written.push(path)
    }
    if (!written.length) return []
    return await uploadRemoteFiles({ request: options.request, taskId: options.taskId, paths: written })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * A temporary file named after the attachment it carries.
 *
 * The peer names what it stores after the file it read, so the temporary file
 * has to keep the person's name — while that name must still never be able to
 * point outside the private folder, and two files pasted at once cannot be
 * allowed to overwrite each other.
 */
function uniqueAttachmentName(name: string, index: number, used: Set<string>) {
  const base = basename(name.replace(/[\\/]+/g, '-')).replace(/^\.+/, '').trim() || `Attachment-${index + 1}`
  let candidate = base, suffix = 2
  while (used.has(candidate)) {
    const dot = base.lastIndexOf('.')
    candidate = dot > 0 ? `${base.slice(0, dot)}-${suffix}${base.slice(dot)}` : `${base}-${suffix}`
    suffix += 1
  }
  used.add(candidate)
  return candidate
}

export async function uploadRemoteFile(options: {
  request: RemoteUploadRequest
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
