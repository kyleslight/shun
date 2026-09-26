import type { AttachmentPreview, AttachmentRef } from '../shared.ts'
import { readAttachmentBytes } from './attachment-reader.ts'
import type { AttachmentStore } from './attachments.ts'

const cache = new Map<string, AttachmentPreview>()
const cacheCosts = new Map<string, number>()
const MAX_CACHE_BYTES = 32 * 1024 * 1024
let cacheBytes = 0
const MAX_UNCOMPRESSED_FALLBACK = 2 * 1024 * 1024
const MAX_MODEL_RASTER_DIMENSION = 2560
const MAX_REMOTE_RASTER_DIMENSION = 1600
/**
 * What the whole frame may cost the model.
 *
 * A dimension cap alone is not a budget: two 2560-pixel photographs of the same
 * subject can differ by a factor of two or three in bytes, and the frame that
 * crosses a threshold is the one that pays. Bytes are what an upload, a context
 * window and a bill are made of, so bytes are what this limits.
 *
 * This one is deliberately the tighter of the two, because the whole frame is
 * the image that enters the transcript and is therefore re-sent with every later
 * request in the conversation. Measured on a real photograph, its rendered frame
 * is 1350 KB at q92 and 1139 KB at q88.
 */
const MAX_MODEL_OVERVIEW_BYTES = 900_000
/**
 * What one magnified region may cost, which is where the detail is.
 *
 * A region is read once rather than repeated, and it is the read that has to
 * make small print legible, so it is not held to the overview's budget. Reading
 * the shelf photograph's left third comes back at 896 KB.
 */
const MAX_MODEL_REGION_BYTES = 1_500_000
/**
 * What one image may cost a phone fetching it over a relay.
 *
 * Fetched on demand rather than on every request, so this is about the link and
 * the data plan; at 1600 pixels a real photograph is 596 KB at q88.
 */
const MAX_REMOTE_IMAGE_BYTES = 600_000
/**
 * Quality is spent before pixels are.
 *
 * Downscaling destroys detail irreversibly, while a JPEG at 76 is still the
 * same picture; so a frame that has to get smaller first gets cheaper, and only
 * reduces its dimensions once the floor is reached.
 */
const JPEG_QUALITY_STEPS = [92, 88, 84, 80, 76]
const BUDGET_SCALE_STEPS = [1, 0.8, 0.64, 0.5]
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

/** One encoded frame: the bytes the caller gets, and how much was spent to fit it. */
type EncodedImage = { data: string; mimeType: string; width: number; height: number; quality?: number }

/**
 * Formats whose pictures are line art, text or flat colour, where PNG stays both
 * smaller and exact. A frame that arrived as JPEG was already a photograph, so
 * spending a PNG encode on it only buys a file that will not fit.
 */
const LOSSLESS_SOURCES = new Set(['image/png', 'image/gif', 'image/bmp', 'image/tiff'])

/** Whether the frame carries transparency, which JPEG cannot hold. */
function hasTransparency(canvas: any) {
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index] !== 255) return true
  return false
}

function scaleCanvas(canvas: any, factor: number, createCanvas: (width: number, height: number) => any) {
  const next = createCanvas(Math.max(1, Math.round(canvas.width * factor)), Math.max(1, Math.round(canvas.height * factor)))
  const context = next.getContext('2d')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(canvas, 0, 0, next.width, next.height)
  return next
}

/**
 * The encoding that holds the most picture inside a byte budget.
 *
 * Quality is spent before pixels are: downscaling destroys detail irreversibly,
 * while a JPEG at 76 is still the same picture, so a frame that has to get
 * smaller gets cheaper first. Only a frame that cannot fit at any quality is
 * made smaller — and every step works from the original, because rescaling an
 * already-rescaled frame compounds resampling blur.
 */
function encodeWithinBudget(canvas: any, budget: number, createCanvas: (width: number, height: number) => any, mimeType: string): EncodedImage {
  const transparent = hasTransparency(canvas), preferLossless = transparent || LOSSLESS_SOURCES.has(mimeType)
  let smallest: EncodedImage | undefined
  for (const [index, factor] of BUDGET_SCALE_STEPS.entries()) {
    const frame = factor === 1 ? canvas : scaleCanvas(canvas, factor, createCanvas)
    if (preferLossless) {
      const png = frame.toBuffer('image/png')
      smallest = { data: png.toString('base64'), mimeType: 'image/png', width: frame.width, height: frame.height }
      if (png.length <= budget) return smallest
    }
    // A lossless frame that still does not fit is not exempt from the budget: a
    // screenshot of dense text is larger as PNG than as JPEG, so it gives up
    // exactness before it gives up the ceiling. Alpha is the one thing JPEG
    // cannot carry, and flattening it onto a colour nobody chose would change
    // the picture rather than shrink it.
    if (!transparent) {
      for (const quality of JPEG_QUALITY_STEPS) {
        const jpeg = frame.toBuffer('image/jpeg', quality)
        smallest = { data: jpeg.toString('base64'), mimeType: 'image/jpeg', width: frame.width, height: frame.height, quality }
        if (jpeg.length <= budget) return smallest
      }
    }
    if (index === BUDGET_SCALE_STEPS.length - 1) return smallest!
  }
  return smallest!
}

/** The best encoding with no ceiling, for frames that are going to a person rather than to a model. */
function encodeCanvas(canvas: any, quality: number): EncodedImage {
  const transparent = hasTransparency(canvas)
  const png = canvas.toBuffer('image/png'), jpeg = transparent ? undefined : canvas.toBuffer('image/jpeg', quality)
  const outputMime = !jpeg || png.length <= jpeg.length ? 'image/png' : 'image/jpeg'
  const output = outputMime === 'image/png' ? png : jpeg!
  return { data: output.toString('base64'), mimeType: outputMime, width: canvas.width, height: canvas.height, ...(outputMime === 'image/jpeg' ? { quality } : {}) }
}

type RasterOptions = { maxDimension: number; quality?: number; budget?: number }

async function rasterImage(bytes: Buffer, mimeType: string, options: RasterOptions): Promise<{ data: string; mimeType: string; width?: number; height?: number }> {
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas')
    const source = await loadImage(bytes), scale = Math.min(1, options.maxDimension / Math.max(source.width, source.height)), canvas = createCanvas(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)))
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height)
    return options.budget ? encodeWithinBudget(canvas, options.budget, createCanvas, mimeType) : encodeCanvas(canvas, options.quality ?? 92)
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
async function regionImage(bytes: Buffer, mimeType: string, region: AttachmentRegion) {
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
  // A region is where the detail lives, so it spends its own budget the same
  // way: quality before pixels.
  return encodeWithinBudget(canvas, MAX_MODEL_REGION_BYTES, createCanvas, mimeType)
}

export async function normalizeImageForModel(bytes: Buffer, mimeType: string) {
  // A source that is already both sharp enough and cheap enough is the best
  // encoding there is, and re-encoding it would only lose. The threshold is the
  // frame that would be rendered anyway, so nothing pays a cliff for crossing it.
  if (bytes.length <= MAX_MODEL_OVERVIEW_BYTES && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)) {
    try {
      const { loadImage } = await import('@napi-rs/canvas'), source = await loadImage(bytes)
      if (Math.max(source.width, source.height) <= MAX_MODEL_RASTER_DIMENSION) {
        return { bytes, mimeType, width: source.width, height: source.height }
      }
    } catch {}
  }
  const image = await rasterImage(bytes, mimeType, { maxDimension: MAX_MODEL_RASTER_DIMENSION, budget: MAX_MODEL_OVERVIEW_BYTES })
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
    const image = await rasterImage(bytes, metadata.mimeType, { maxDimension, budget: purpose === 'remote' ? MAX_REMOTE_IMAGE_BYTES : undefined })
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
