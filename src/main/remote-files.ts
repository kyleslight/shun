import { open, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { existingLocalPath } from './local-path.ts'

export const REMOTE_FILE_CHUNK_BYTES = 192 * 1024
export const REMOTE_FILE_MAX_BYTES = 256 * 1024 * 1024

export type RemoteFileInfo = {
  path: string
  name: string
  size: number
  mimeType: string
  chunkSize: number
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
}

function mimeType(path: string) {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] || 'application/octet-stream'
}

export async function describeRemoteFile(value: unknown): Promise<RemoteFileInfo> {
  const target = await existingLocalPath(value)
  if (target.kind !== 'file') throw Error('Only files can be downloaded.')
  const metadata = await stat(target.path)
  if (metadata.size > REMOTE_FILE_MAX_BYTES) throw Error('File is larger than the 256 MB remote download limit.')
  return {
    path: target.path,
    name: basename(target.path),
    size: metadata.size,
    mimeType: mimeType(target.path),
    chunkSize: REMOTE_FILE_CHUNK_BYTES,
  }
}

export async function readRemoteFileChunk(value: unknown, offsetValue: unknown, lengthValue?: unknown) {
  const info = await describeRemoteFile(value)
  const offset = Number(offsetValue)
  const requestedLength = lengthValue === undefined ? info.chunkSize : Number(lengthValue)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > info.size) throw Error('Invalid file chunk offset.')
  if (!Number.isSafeInteger(requestedLength) || requestedLength < 1 || requestedLength > info.chunkSize) throw Error('Invalid file chunk length.')
  const length = Math.min(requestedLength, info.size - offset)
  if (!length) return { offset, data: '', bytes: 0, eof: true }
  const handle = await open(info.path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    return {
      offset,
      data: buffer.subarray(0, bytesRead).toString('base64'),
      bytes: bytesRead,
      eof: offset + bytesRead >= info.size,
    }
  } finally {
    await handle.close()
  }
}
