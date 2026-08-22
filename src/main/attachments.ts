import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import type { AttachmentKind, AttachmentRef } from '../shared.ts'

export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024
export const ATTACHMENT_KIND_LIMITS: Partial<Record<AttachmentKind, number>> = {
  text: 16 * 1024 * 1024,
  image: 20 * 1024 * 1024,
  document: 32 * 1024 * 1024,
  spreadsheet: 32 * 1024 * 1024,
  presentation: 32 * 1024 * 1024,
}
const MAX_IMAGE_PIXELS = 50_000_000
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/
const textExtensions = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rb', '.php', '.java', '.kt', '.kts', '.swift', '.go', '.rs', '.c', '.h', '.cc', '.cpp',
  '.cs', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.sql', '.toml', '.ini', '.cfg', '.conf', '.env', '.log', '.tex', '.rtf',
])

function safeId(value: string, label: string) {
  if (!SAFE_ID.test(value)) throw Error(`Invalid ${label}.`)
  return value
}

function starts(bytes: Buffer, signature: number[]) { return signature.every((byte, index) => bytes[index] === byte) }
function imageDimensions(bytes: Buffer, mimeType: string) {
  if (mimeType === 'image/png' && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  if (mimeType === 'image/gif' && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  if (mimeType === 'image/bmp' && bytes.length >= 26) return { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) }
  if (mimeType === 'image/jpeg') {
    let offset = 2
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue }
      const marker = bytes[offset + 1], length = bytes.readUInt16BE(offset + 2)
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
      if (length < 2) break
      offset += length + 2
    }
  }
  return null
}
function printableText(bytes: Buffer) {
  if (!bytes.length) return true
  const sample = bytes.subarray(0, Math.min(bytes.length, 16_384))
  if (sample.includes(0)) return starts(sample, [0xff, 0xfe]) || starts(sample, [0xfe, 0xff])
  const text = sample.toString('utf8'), replacement = (text.match(/\uFFFD/g) || []).length
  return replacement <= Math.max(2, text.length * .01)
}

function officeKind(bytes: Buffer): AttachmentKind | undefined {
  try {
    const files = unzipSync(new Uint8Array(bytes), {
      filter(file) {
        if (file.name !== '[Content_Types].xml') return false
        if (file.originalSize > 2 * 1024 * 1024) throw Error('Invalid Office content types entry.')
        return true
      },
    })
    const entry = files['[Content_Types].xml']
    const contentTypes = entry ? new TextDecoder().decode(entry) : ''
    if (/wordprocessingml\.document\.main\+xml/i.test(contentTypes)) return 'document'
    if (/spreadsheetml\.sheet\.main\+xml/i.test(contentTypes)) return 'spreadsheet'
    if (/presentationml\.presentation\.main\+xml/i.test(contentTypes)) return 'presentation'
  } catch {}
  return undefined
}

export function detectAttachment(bytes: Buffer, name: string): Pick<AttachmentRef, 'kind' | 'mimeType' | 'capabilities'> {
  const extension = extname(name).toLowerCase()
  if (bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return { kind: 'pdf', mimeType: 'application/pdf', capabilities: { text: true, ocr: true } }
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mimeType: 'image/png', capabilities: { vision: true } }
  if (starts(bytes, [0xff, 0xd8, 0xff])) return { kind: 'image', mimeType: 'image/jpeg', capabilities: { vision: true } }
  if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) return { kind: 'image', mimeType: 'image/gif', capabilities: { vision: true } }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { kind: 'image', mimeType: 'image/webp', capabilities: { vision: true } }
  if (starts(bytes, [0x42, 0x4d])) return { kind: 'image', mimeType: 'image/bmp', capabilities: { vision: true } }
  if (starts(bytes, [0x49, 0x49, 0x2a, 0x00]) || starts(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return { kind: 'image', mimeType: 'image/tiff', capabilities: { vision: true } }
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06]) || starts(bytes, [0x50, 0x4b, 0x07, 0x08])) {
    const kind = officeKind(bytes)
    if (kind === 'document') return { kind, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', capabilities: { text: true } }
    if (kind === 'spreadsheet') return { kind, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', capabilities: { text: true } }
    if (kind === 'presentation') return { kind, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', capabilities: { text: true } }
    return { kind: 'archive', mimeType: 'application/zip', capabilities: {} }
  }
  if (textExtensions.has(extension) || printableText(bytes)) {
    const mimeType = extension === '.csv' ? 'text/csv' : extension === '.tsv' ? 'text/tab-separated-values' : extension === '.json' || extension === '.jsonl' ? 'application/json' : 'text/plain'
    return { kind: 'text', mimeType, capabilities: { text: true } }
  }
  return { kind: 'unknown', mimeType: 'application/octet-stream', capabilities: {} }
}

export class AttachmentStore {
  readonly root: string
  constructor(root: string) { this.root = root }

  private taskDir(taskId: string) { return join(this.root, safeId(taskId, 'task ID')) }
  private itemDir(taskId: string, attachmentId: string) { return join(this.taskDir(taskId), safeId(attachmentId, 'attachment ID')) }
  private contentPath(taskId: string, attachmentId: string) { return join(this.itemDir(taskId, attachmentId), 'content') }
  private metadataPath(taskId: string, attachmentId: string) { return join(this.itemDir(taskId, attachmentId), 'metadata.json') }

  private async persist(taskId: string, nameValue: string, bytes: Buffer, existing: AttachmentRef[], imported: AttachmentRef[]) {
    const name = basename(String(nameValue || 'attachment').replace(/\\/g, '/')).slice(0, 255) || 'attachment'
    if (!bytes.length) throw Error(`${name} is empty.`)
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw Error(`${name} is too large (${Math.ceil(bytes.length / 1024 / 1024)} MB; limit 64 MB).`)
    const detected = detectAttachment(bytes, name), kindLimit = ATTACHMENT_KIND_LIMITS[detected.kind]
    if (kindLimit && bytes.length > kindLimit) throw Error(`${name} is too large for a ${detected.kind} attachment (${Math.ceil(bytes.length / 1024 / 1024)} MB; limit ${Math.floor(kindLimit / 1024 / 1024)} MB).`)
    const dimensions = detected.kind === 'image' ? imageDimensions(bytes, detected.mimeType) : null
    if (dimensions && dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) throw Error(`${name} has unsafe image dimensions (${dimensions.width}×${dimensions.height}; limit ${MAX_IMAGE_PIXELS.toLocaleString('en-US')} pixels).`)
    const sha256 = createHash('sha256').update(bytes).digest('hex'), duplicate = [...existing, ...imported].find(item => item.sha256 === sha256)
    if (duplicate) return duplicate
    const id = randomUUID(), createdAt = Date.now()
    const metadata: AttachmentRef = { id, taskId, name, size: bytes.length, sha256, createdAt, ...detected }
    const taskDir = this.taskDir(taskId), temporary = join(taskDir, `.${id}.tmp`), target = this.itemDir(taskId, id)
    await mkdir(temporary, { recursive: true })
    try {
      await writeFile(join(temporary, 'content'), bytes)
      await writeFile(join(temporary, 'metadata.json'), JSON.stringify(metadata, null, 2))
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
    return metadata
  }

  async importPaths(taskId: string, paths: string[]) {
    safeId(taskId, 'task ID')
    const existing = await this.list(taskId), imported: AttachmentRef[] = []
    for (const sourceValue of paths.slice(0, 20)) {
      const source = await realpath(resolve(String(sourceValue || ''))), info = await stat(source)
      if (!info.isFile()) throw Error(`${basename(source)} is not a file.`)
      if (info.size > MAX_ATTACHMENT_BYTES) throw Error(`${basename(source)} is too large (${Math.ceil(info.size / 1024 / 1024)} MB; limit 64 MB).`)
      imported.push(await this.persist(taskId, basename(source), await readFile(source), existing, imported))
    }
    return imported
  }

  async importBuffers(taskId: string, files: Array<{ name: string; bytes: Buffer }>) {
    safeId(taskId, 'task ID')
    const existing = await this.list(taskId), imported: AttachmentRef[] = []
    for (const file of files.slice(0, 20)) imported.push(await this.persist(taskId, file.name, file.bytes, existing, imported))
    return imported
  }

  async list(taskId: string) {
    const directory = this.taskDir(taskId)
    let names: string[]
    try { names = await readdir(directory) } catch { return [] }
    const items: AttachmentRef[] = []
    for (const name of names) {
      if (!SAFE_ID.test(name)) continue
      try {
        const value = JSON.parse(await readFile(this.metadataPath(taskId, name), 'utf8')) as AttachmentRef
        if (value.id === name && value.taskId === taskId && typeof value.name === 'string') items.push(value)
      } catch {}
    }
    return items.sort((a, b) => a.createdAt - b.createdAt)
  }

  async read(taskId: string, attachmentId: string) {
    const metadata = JSON.parse(await readFile(this.metadataPath(taskId, attachmentId), 'utf8')) as AttachmentRef
    if (metadata.id !== attachmentId || metadata.taskId !== taskId) throw Error('Attachment metadata does not match this task.')
    const bytes = await readFile(this.contentPath(taskId, attachmentId))
    if (bytes.length !== metadata.size || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw Error('Attachment content failed its integrity check.')
    return { metadata, bytes }
  }

  async remove(taskId: string, attachmentId: string) {
    await rm(this.itemDir(taskId, attachmentId), { recursive: true, force: true })
    return true
  }

  async removeTask(taskId: string) {
    await rm(this.taskDir(taskId), { recursive: true, force: true })
    return true
  }
}

export function attachmentManifest(items: AttachmentRef[]) {
  if (!items.length) return ''
  return `\n\n<attachments>\n${items.map(item => `- id=${item.id} name=${JSON.stringify(item.name)} kind=${item.kind} mime=${item.mimeType} size=${item.size} capabilities=${Object.entries(item.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(',') || 'none'}`).join('\n')}\n</attachments>\nThese are task-owned attachment objects, not workspace files. Their original source paths are deliberately unavailable. Read them only by stable ID with attachment_read, which returns image content for images and bounded semantic content for supported documents. PDF reading is semantic by default; use mode=ocr or mode=visual with one page only for an explicit visual request. Never use workspace read, bash, find, or filename search to locate an upload.`
}
