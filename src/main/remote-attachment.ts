import { open, rm } from 'node:fs/promises'

/**
 * One attachment travelling over a link.
 *
 * An attachment is not a workspace file: it has no path either machine may hand
 * the other, and it belongs to the task that owns it. So it is named by that id
 * and read in the pieces the link can carry — the peer serves a range, and this
 * side is what writes them somewhere.
 *
 * The size of a piece is the peer's answer rather than a number written here
 * twice: whatever serves a range decides how large one may be.
 */
export const REMOTE_ATTACHMENT_CHUNK_BYTES = 192 * 1024
/** The attachment store's own ceiling: nothing larger can exist to be fetched. */
export const REMOTE_ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024

export type RemoteAttachmentInfo = { attachmentId: string; name: string; mimeType: string; size: number; chunkSize: number }
export type RemoteAttachmentChunk = { offset: number; data: string; bytes: number; eof: boolean }

export function remoteAttachmentInfo(metadata: { id: string; name: string; mimeType: string; size: number }): RemoteAttachmentInfo {
  return { attachmentId: metadata.id, name: metadata.name, mimeType: metadata.mimeType, size: metadata.size, chunkSize: REMOTE_ATTACHMENT_CHUNK_BYTES }
}

/**
 * Read one attachment in order, handing each piece to whoever asked for it.
 *
 * A file that stops arriving halfway is an error rather than a short file: the
 * caller decides what to do with what it already wrote, and a truncated picture
 * that looks whole is worse than none.
 */
async function readRemoteAttachment(options: {
  request: (kind: string, payload: Record<string, unknown>) => Promise<unknown>
  taskId: string
  attachmentId: string
  write: (chunk: Buffer) => Promise<void>
}): Promise<{ info: RemoteAttachmentInfo; bytes: number }> {
  const described = await options.request('attachment.download.info', { taskId: options.taskId, attachmentId: options.attachmentId }) as RemoteAttachmentInfo
  const info = {
    attachmentId: String(described?.attachmentId || options.attachmentId),
    name: String(described?.name || 'attachment'),
    mimeType: String(described?.mimeType || 'application/octet-stream'),
    size: Number(described?.size),
    chunkSize: Number(described?.chunkSize) || REMOTE_ATTACHMENT_CHUNK_BYTES,
  }
  if (!Number.isSafeInteger(info.size) || info.size < 0) throw Error('The other Shun did not describe that attachment.')
  if (info.size > REMOTE_ATTACHMENT_MAX_BYTES) throw Error('This attachment is larger than the 64 MB remote limit.')
  let written = 0
  while (written < info.size) {
    const chunk = await options.request('attachment.download.chunk', {
      taskId: options.taskId, attachmentId: options.attachmentId, offset: written, length: Math.min(info.chunkSize, info.size - written),
    }) as RemoteAttachmentChunk
    const buffer = Buffer.from(String(chunk?.data ?? ''), 'base64')
    if (!buffer.length) break
    if (buffer.length !== chunk.bytes) throw Error('The other Shun returned a truncated chunk.')
    await options.write(buffer)
    written += buffer.length
    if (chunk.eof) break
  }
  if (written !== info.size) throw Error('The attachment stopped arriving before it was whole.')
  return { info, bytes: written }
}

/** One attachment held in memory, for what is done with it there — a clipboard, a picture. */
export async function fetchRemoteAttachment(options: {
  request: (kind: string, payload: Record<string, unknown>) => Promise<unknown>
  taskId: string
  attachmentId: string
}): Promise<{ info: RemoteAttachmentInfo; bytes: Buffer }> {
  const pieces: Buffer[] = []
  const result = await readRemoteAttachment({ ...options, write: async (chunk) => { pieces.push(chunk) } })
  return { info: result.info, bytes: Buffer.concat(pieces, result.bytes) }
}

/** One attachment written to a path this machine chose. A partial file is removed. */
export async function saveRemoteAttachment(options: {
  request: (kind: string, payload: Record<string, unknown>) => Promise<unknown>
  taskId: string
  attachmentId: string
  destination: string
}) {
  const handle = await open(options.destination, 'w')
  let result: { info: RemoteAttachmentInfo; bytes: number } | undefined
  try {
    result = await readRemoteAttachment({ ...options, write: async (chunk) => { await handle.write(chunk) } })
  } catch (error) {
    await handle.close()
    await rm(options.destination, { force: true }).catch(() => {})
    throw error
  }
  await handle.close()
  return { source: result.info.attachmentId, name: result.info.name, bytes: result.bytes, destination: options.destination }
}
