import { extname } from 'node:path'

export const MAX_PLUGIN_EXPORT_BYTES = 64 * 1024 * 1024

export function pluginExportPayload(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Plugin export request must be an object.')
  const request = input as { name?: unknown; data?: unknown }
  const rawName = String(request.name || '').trim()
  const leaf = rawName.split(/[\\/]/).at(-1)?.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim() || ''
  if (!leaf || leaf === '.' || leaf === '..' || leaf.length > 180) throw Error('Plugin export file name is invalid.')

  const value = request.data
  const bytes = value instanceof ArrayBuffer
    ? Buffer.from(value)
    : ArrayBuffer.isView(value)
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : null
  if (!bytes || !bytes.length) throw Error('Plugin export data is empty or invalid.')
  if (bytes.length > MAX_PLUGIN_EXPORT_BYTES) throw Error('Plugin export exceeds the 64 MB limit.')
  return { name: leaf, bytes }
}

export function pluginExportCandidate(name: string, index: number) {
  if (!Number.isInteger(index) || index < 0) throw Error('Plugin export candidate index is invalid.')
  if (index === 0) return name
  const extension = extname(name)
  const stem = extension ? name.slice(0, -extension.length) : name
  return `${stem} ${index + 1}${extension}`
}
