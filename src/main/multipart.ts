/**
 * Minimal multipart/form-data writer.
 *
 * A publisher signs the exact bytes it uploads, so the body cannot be produced
 * by `FormData` and then described after the fact: the same bytes have to be
 * built, hashed, signed, and sent.
 */
export type MultipartFile = { field: string; filename: string; contentType: string; bytes: Uint8Array }

export function buildMultipartBody(fields: Record<string, string>, file: MultipartFile) {
  const boundary = `----shun-${crypto.randomUUID()}`
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(encoder.encode(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  parts.push(
    encoder.encode(`--${boundary}\r\ncontent-disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\ncontent-type: ${file.contentType}\r\n\r\n`),
    file.bytes,
    encoder.encode(`\r\n--${boundary}--\r\n`),
  )
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const body = new Uint8Array(total)
  let offset = 0
  for (const part of parts) { body.set(part, offset); offset += part.byteLength }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}
