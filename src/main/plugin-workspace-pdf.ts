import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { resolvePluginWorkspaceFile } from './plugin-workspace.ts'

const maxPdfBytes = 64 * 1024 * 1024
const maxDocuments = 3
const maxPageCacheBytes = 32 * 1024 * 1024

type CachedDocument = { path: string; key: string; loading: any; document: Promise<any> }
type RenderedPage = { data: string; mimeType: 'image/png'; width: number; height: number; page: number; pages: number }

const documents = new Map<string, CachedDocument>()
const pageCache = new Map<string, RenderedPage>()
const pageCosts = new Map<string, number>()
let pageCacheBytes = 0

export async function renderPluginWorkspacePdf(workspace: string, input: unknown): Promise<RenderedPage> {
  const request = object(input), file = await resolvePluginWorkspaceFile(workspace, request.path)
  if (extname(file.target).toLowerCase() !== '.pdf') throw Error('Workspace PDF preview accepts only .pdf files.')
  if (file.info.size > maxPdfBytes) throw Error(`PDF is too large for preview (${Math.ceil(file.info.size / 1024 / 1024)} MB; limit 64 MB).`)
  const documentKey = `${file.target}\0${file.info.size}\0${file.info.mtimeMs}`
  let cached = documents.get(documentKey)
  if (!cached) {
    const bytes = await readFile(file.target)
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw Error('File does not contain a valid PDF header.')
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, useSystemFonts: true })
    cached = { path: file.target, key: documentKey, loading, document: loading.promise }
    for (const [key, record] of documents) if (record.path === file.target && key !== documentKey) evictDocument(key, record)
    documents.set(documentKey, cached)
    while (documents.size > maxDocuments) {
      const oldest = documents.entries().next().value as [string, CachedDocument] | undefined
      if (!oldest) break
      evictDocument(oldest[0], oldest[1])
    }
  } else {
    documents.delete(documentKey)
    documents.set(documentKey, cached)
  }
  const document = await cached.document, pageNumber = integer(request.page, 1, 1, document.numPages), maxDimension = integer(request.maxDimension, 2200, 800, 3200)
  const cacheKey = `${documentKey}\0${pageNumber}\0${maxDimension}`, remembered = pageCache.get(cacheKey)
  if (remembered) {
    pageCache.delete(cacheKey); pageCache.set(cacheKey, remembered)
    return remembered
  }
  const page = await document.getPage(pageNumber)
  try {
    const { createCanvas } = await import('@napi-rs/canvas'), base = page.getViewport({ scale: 1 }), scale = Math.min(2.5, maxDimension / Math.max(base.width, base.height)), viewport = page.getViewport({ scale })
    const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height))), context = canvas.getContext('2d')
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas: canvas as any, canvasContext: context as any, viewport, background: '#fff' }).promise
    const result: RenderedPage = { data: canvas.toBuffer('image/png').toString('base64'), mimeType: 'image/png', width: canvas.width, height: canvas.height, page: pageNumber, pages: document.numPages }
    rememberPage(cacheKey, result)
    return result
  } finally { page.cleanup() }
}

function rememberPage(key: string, result: RenderedPage) {
  const cost = Math.ceil(result.data.length * .75), previous = pageCosts.get(key) || 0
  pageCacheBytes += cost - previous
  pageCache.delete(key); pageCache.set(key, result); pageCosts.set(key, cost)
  while (pageCache.size > 24 || pageCacheBytes > maxPageCacheBytes) {
    const oldest = pageCache.keys().next().value as string | undefined
    if (!oldest || (oldest === key && pageCache.size === 1)) break
    pageCache.delete(oldest); pageCacheBytes -= pageCosts.get(oldest) || 0; pageCosts.delete(oldest)
  }
}

function evictDocument(key: string, record: CachedDocument) {
  documents.delete(key)
  for (const pageKey of [...pageCache.keys()]) if (pageKey.startsWith(`${key}\0`)) {
    pageCache.delete(pageKey); pageCacheBytes -= pageCosts.get(pageKey) || 0; pageCosts.delete(pageKey)
  }
  void Promise.resolve(record.loading.destroy()).catch(() => undefined)
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Workspace PDF preview request must be an object.')
  return value as Record<string, any>
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw Error(`Value must be an integer from ${minimum} to ${maximum}.`)
  return number
}
