import type { AttachmentPreview, AttachmentRef } from '../shared.ts'
import { readAttachmentBytes } from './attachment-reader.ts'
import type { AttachmentStore } from './attachments.ts'

const cache = new Map<string, AttachmentPreview>()
const cacheCosts = new Map<string, number>()
const MAX_CACHE_BYTES = 32 * 1024 * 1024
let cacheBytes = 0
const MAX_UNCOMPRESSED_FALLBACK = 2 * 1024 * 1024
const MAX_MODEL_SOURCE_BYTES = 4 * 1024 * 1024
const MAX_MODEL_SOURCE_DIMENSION = 3072
const MAX_MODEL_RASTER_DIMENSION = 2560
export type AttachmentPreviewPurpose = 'display' | 'model' | 'ocr' | 'visual'

export function clearAttachmentPreviewCache(taskId: string, attachmentId?: string) {
  const prefix = `${taskId}:${attachmentId ? `${attachmentId}:` : ''}`
  let removed = 0
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) {
    cache.delete(key)
    cacheBytes -= cacheCosts.get(key) || 0
    cacheCosts.delete(key)
    removed++
  }
  return removed
}

function remember(key: string, preview: AttachmentPreview) {
  const previous = cacheCosts.get(key) || 0, cost = preview.mode === 'image' ? Math.ceil(preview.data.length * .75) : preview.content.length * 2
  cacheBytes += cost - previous
  cache.set(key, preview)
  cacheCosts.set(key, cost)
  while (cache.size > 20 || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value!
    if (oldest === key && cache.size === 1) break
    cache.delete(oldest)
    cacheBytes -= cacheCosts.get(oldest) || 0
    cacheCosts.delete(oldest)
  }
  return preview
}

async function rasterImage(bytes: Buffer, mimeType: string, maxDimension: number, quality = 92) {
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas')
    const source = await loadImage(bytes), scale = Math.min(1, maxDimension / Math.max(source.width, source.height)), canvas = createCanvas(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)))
    const context = canvas.getContext('2d')
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let transparent = false
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] !== 255) { transparent = true; break }
    const png = canvas.toBuffer('image/png'), jpeg = transparent ? undefined : canvas.toBuffer('image/jpeg', quality)
    const outputMime = !jpeg || png.length <= jpeg.length ? 'image/png' : 'image/jpeg'
    const output = outputMime === 'image/png' ? png : jpeg!
    return { data: output.toString('base64'), mimeType: outputMime, width: canvas.width, height: canvas.height }
  } catch (error) {
    if (bytes.length <= MAX_UNCOMPRESSED_FALLBACK && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)) return { data: bytes.toString('base64'), mimeType }
    throw error
  }
}

export async function normalizeImageForModel(bytes: Buffer, mimeType: string) {
  if (bytes.length <= MAX_MODEL_SOURCE_BYTES && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)) {
    try {
      const { loadImage } = await import('@napi-rs/canvas'), source = await loadImage(bytes)
      if (Math.max(source.width, source.height) <= MAX_MODEL_SOURCE_DIMENSION) {
        return { bytes, mimeType, width: source.width, height: source.height }
      }
    } catch {}
  }
  const image = await rasterImage(bytes, mimeType, MAX_MODEL_RASTER_DIMENSION)
  return { bytes: Buffer.from(image.data, 'base64'), mimeType: image.mimeType, width: image.width, height: image.height }
}

async function pdfPage(bytes: Buffer, pageValue: number, maxDimension: number) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'), { createCanvas } = await import('@napi-rs/canvas')
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, useSystemFonts: true }), document = await loading.promise
  try {
    const pageNumber = Math.max(1, Math.min(document.numPages, Math.floor(pageValue))), page = await document.getPage(pageNumber), base = page.getViewport({ scale: 1 })
    const scale = Math.min(2, maxDimension / Math.max(base.width, base.height)), viewport = page.getViewport({ scale }), canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)), context = canvas.getContext('2d')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas: canvas as any, canvasContext: context as any, viewport, background: '#fff' }).promise
    page.cleanup()
    return { data: canvas.toBuffer('image/jpeg', 90).toString('base64'), mimeType: 'image/jpeg', width: canvas.width, height: canvas.height, page: pageNumber, pages: document.numPages }
  } finally { await loading.destroy() }
}

export async function previewAttachmentBytes(metadata: AttachmentRef, bytes: Buffer, page = 1, purpose: AttachmentPreviewPurpose = 'model'): Promise<AttachmentPreview> {
  const maxDimension = purpose === 'display' ? 3200 : MAX_MODEL_RASTER_DIMENSION, key = `${metadata.taskId}:${metadata.id}:${metadata.sha256}:${page}:${purpose}`
  if (metadata.kind === 'pdf' && purpose !== 'ocr' && purpose !== 'visual') throw Error('PDF visual reading requires an explicit OCR or visual-inspection intent. Use attachment_read by default.')
  if (purpose === 'display' && metadata.kind !== 'image' && metadata.kind !== 'text') throw Error(`Preview is not available for ${metadata.kind} attachments.`)
  const cached = cache.get(key)
  if (cached) return cached
  if (metadata.kind === 'image') {
    if (purpose === 'display' && ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].includes(metadata.mimeType)) {
      return remember(key, { attachment: metadata, mode: 'image', mimeType: metadata.mimeType, data: bytes.toString('base64') })
    }
    if (purpose === 'model') {
      const image = await normalizeImageForModel(bytes, metadata.mimeType)
      return remember(key, { attachment: metadata, mode: 'image', mimeType: image.mimeType, data: image.bytes.toString('base64'), width: image.width, height: image.height })
    }
    const image = await rasterImage(bytes, metadata.mimeType, maxDimension)
    return remember(key, { attachment: metadata, mode: 'image', ...image })
  }
  if (metadata.kind === 'pdf') return remember(key, { attachment: metadata, mode: 'image', ...(await pdfPage(bytes, page, maxDimension)) })
  try {
    const parsed: any = await readAttachmentBytes(metadata, bytes, { maxChars: 20_000 })
    return { attachment: metadata, mode: 'text', content: parsed.content || JSON.stringify(parsed, null, 2), pages: parsed.pages }
  } catch (error) {
    return { attachment: metadata, mode: 'text', content: '', warning: error instanceof Error ? error.message : String(error) }
  }
}

export async function previewAttachment(store: AttachmentStore, taskId: string, attachmentId: string, page = 1, purpose: AttachmentPreviewPurpose = 'model'): Promise<AttachmentPreview> {
  const { metadata, bytes } = await store.read(taskId, attachmentId)
  return previewAttachmentBytes(metadata, bytes, page, purpose)
}
