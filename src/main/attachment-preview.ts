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
const MAX_REMOTE_RASTER_DIMENSION = 1600
export type AttachmentPreviewPurpose = 'display' | 'model' | 'remote' | 'ocr' | 'visual'

/**
 * One part of an image, as fractions of the whole from the top-left corner.
 *
 * Fractions are the only shape a model can name: it is shown pixels, not
 * dimensions, so a share of the frame is something it can point at while a pixel
 * rectangle is something it cannot know. Rendering the crop then enlarges it,
 * which is the difference between seeing that a shelf holds forty boxes and
 * reading what is printed on them.
 */
export type AttachmentRegion = [x: number, y: number, width: number, height: number]

/** How far a region may be enlarged past its own pixels before it is only interpolation. */
const MAX_REGION_ZOOM = 4
/** A region narrower than this renders too little to be worth the request. */
const MIN_REGION_PIXELS = 16

export function normalizeAttachmentRegion(value: unknown): AttachmentRegion {
  if (!Array.isArray(value) || value.length !== 4) throw Error('region needs exactly four numbers: [x, y, width, height], each a fraction of the image from the top-left corner.')
  const region = value.map(Number) as AttachmentRegion
  if (region.some(number => !Number.isFinite(number))) throw Error('region needs four finite numbers.')
  const [x, y, width, height] = region
  if (width <= 0 || height <= 0) throw Error('region width and height must both be greater than zero.')
  // A region that runs past the edge is refused rather than clipped, because
  // clipping would answer a question the model did not ask.
  if (x < 0 || y < 0 || x + width > 1.000001 || y + height > 1.000001) throw Error('region must stay inside the image: x and y are at least 0, and x+width and y+height are at most 1.')
  return region
}

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

function encodeCanvas(canvas: any, quality: number) {
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
  let transparent = false
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index] !== 255) { transparent = true; break }
  const png = canvas.toBuffer('image/png'), jpeg = transparent ? undefined : canvas.toBuffer('image/jpeg', quality)
  const outputMime = !jpeg || png.length <= jpeg.length ? 'image/png' : 'image/jpeg'
  const output = outputMime === 'image/png' ? png : jpeg!
  return { data: output.toString('base64'), mimeType: outputMime, width: canvas.width, height: canvas.height }
}

async function rasterImage(bytes: Buffer, mimeType: string, maxDimension: number, quality = 92): Promise<{ data: string; mimeType: string; width?: number; height?: number }> {
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas')
    const source = await loadImage(bytes), scale = Math.min(1, maxDimension / Math.max(source.width, source.height)), canvas = createCanvas(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)))
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height)
    return encodeCanvas(canvas, quality)
  } catch (error) {
    // The source is passed through undecoded, so its dimensions are genuinely
    // unknown here rather than zero.
    if (bytes.length <= MAX_UNCOMPRESSED_FALLBACK && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)) return { data: bytes.toString('base64'), mimeType }
    throw error
  }
}

/**
 * One region of an image, enlarged on the way out.
 *
 * The model is already looking at the whole frame, so a crop is only worth
 * rendering if it comes back bigger than the part of the frame it came from.
 * The enlargement is bounded, and the source pixels are the source pixels: this
 * makes existing detail legible, it never invents detail that was not there.
 */
async function regionImage(bytes: Buffer, mimeType: string, region: AttachmentRegion, quality = 92) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const source = await loadImage(bytes)
  const left = Math.max(0, Math.min(source.width - 1, Math.round(region[0] * source.width)))
  const top = Math.max(0, Math.min(source.height - 1, Math.round(region[1] * source.height)))
  const width = Math.max(1, Math.min(source.width - left, Math.round((region[0] + region[2]) * source.width) - left))
  const height = Math.max(1, Math.min(source.height - top, Math.round((region[1] + region[3]) * source.height) - top))
  if (width < MIN_REGION_PIXELS || height < MIN_REGION_PIXELS) {
    throw Error(`region is too small to read: it resolved to ${width}x${height} pixels of a ${source.width}x${source.height} image, and each side needs at least ${MIN_REGION_PIXELS}.`)
  }
  const scale = Math.min(MAX_MODEL_RASTER_DIMENSION / Math.max(width, height), MAX_REGION_ZOOM)
  const canvas = createCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)))
  const context = canvas.getContext('2d')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, left, top, width, height, 0, 0, canvas.width, canvas.height)
  return encodeCanvas(canvas, quality)
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

export async function previewAttachmentBytes(metadata: AttachmentRef, bytes: Buffer, page = 1, purpose: AttachmentPreviewPurpose = 'model', region?: AttachmentRegion): Promise<AttachmentPreview> {
  const maxDimension = purpose === 'display' ? 3200 : purpose === 'remote' ? MAX_REMOTE_RASTER_DIMENSION : MAX_MODEL_RASTER_DIMENSION
  const key = `${metadata.taskId}:${metadata.id}:${metadata.sha256}:${page}:${purpose}${region ? `:${region.join(',')}` : ''}`
  if (region && metadata.kind !== 'image') throw Error(`A region read is only available for image attachments; ${metadata.name} is ${metadata.kind}.`)
  if (metadata.kind === 'pdf' && purpose !== 'ocr' && purpose !== 'visual' && purpose !== 'display') throw Error('PDF visual reading requires an explicit OCR or visual-inspection intent. Use attachment_read by default.')
  if (purpose === 'display' && !['image', 'text', 'pdf', 'document', 'spreadsheet', 'presentation'].includes(metadata.kind)) throw Error(`Preview is not available for ${metadata.kind} attachments.`)
  const cached = cache.get(key)
  if (cached) return cached
  if (metadata.kind === 'image') {
    if (region) return remember(key, { attachment: metadata, mode: 'image', region, ...(await regionImage(bytes, metadata.mimeType, region)) })
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

export async function previewAttachment(store: AttachmentStore, taskId: string, attachmentId: string, page = 1, purpose: AttachmentPreviewPurpose = 'model', region?: AttachmentRegion): Promise<AttachmentPreview> {
  const { metadata, bytes } = await store.read(taskId, attachmentId)
  return previewAttachmentBytes(metadata, bytes, page, purpose, region)
}
