import { contentWindow } from './content-window.ts'

export type PdfReadOptions = {
  query?: unknown
  startPage?: unknown
  endPage?: unknown
  maxPages?: number
  maxChars: number
  offset: number
}

export type PdfParser = {
  id: string
  read(bytes: Buffer, options: PdfReadOptions): Promise<Record<string, unknown>>
}

function clean(value: unknown) { return String(value || '').replace(/\s+/g, ' ').trim() }

export function pdfSearchExcerpts(pages: string[], queryValue: unknown, maxChars: number) {
  const query = clean(queryValue), phrase = query.toLowerCase(), terms = [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{1,}|[\u3400-\u9fff]{2,}/g) || [])]
  if (!query || !terms.length) return null
  const scored = pages.map((text, index) => {
    const lower = text.toLowerCase()
    const hits = terms.map(term => ({ term, at: lower.indexOf(term), count: lower.split(term).length - 1 })).filter(hit => hit.at >= 0)
    const score = hits.reduce((sum, hit) => sum + Math.min(8, hit.count), 0) + (lower.includes(phrase) ? 20 : 0) + (hits.length === terms.length ? 8 : 0)
    const anchor = hits.sort((a, b) => a.at - b.at)[0]?.at ?? -1
    return { page: index + 1, text, score, anchor }
  }).filter(page => page.score > 0).sort((a, b) => b.score - a.score || a.page - b.page)
  if (!scored.length) return { query, matched_pages: [] as number[], total_matching_pages: 0, content: '' }
  const chunks: string[] = [], matched: number[] = []
  for (const item of scored.slice(0, 8)) {
    const allowance = Math.max(700, Math.min(3_200, maxChars - chunks.join('').length - 80))
    if (allowance < 700) break
    const start = Math.max(0, item.anchor - Math.floor(allowance * .35)), excerpt = item.text.slice(start, start + allowance).trim()
    chunks.push(`--- Page ${item.page}${start ? ` (excerpt starts at character ${start})` : ''} ---\n${excerpt}`)
    matched.push(item.page)
  }
  return { query, matched_pages: matched, total_matching_pages: scored.length, content: chunks.join('\n\n').slice(0, maxChars) }
}

type PdfTextRun = {
  str: string
  dir?: string
  width?: number
  height?: number
  transform?: number[]
  hasEOL?: boolean
}

function sequentialPdfText(items: PdfTextRun[]) {
  let value = ''
  for (const item of items) {
    const text = String(item.str || '')
    if (!text) continue
    if (value && !/\s$/.test(value) && !/^\s/.test(text)) value += ' '
    value += text
    if (item.hasEOL) value += '\n'
  }
  return value.replace(/[ \t]+\n/g, '\n').trim()
}

/** Reconstruct a stable reading order from PDF text-layer coordinates. */
export function pdfPageText(value: unknown) {
  const items = (Array.isArray(value) ? value : []).filter((item): item is PdfTextRun => Boolean(item && typeof item === 'object' && typeof (item as PdfTextRun).str === 'string' && (item as PdfTextRun).str))
  const positioned = items.map((item, index) => {
    const transform = Array.isArray(item.transform) ? item.transform : []
    return { item, index, x: Number(transform[4]), y: Number(transform[5]), width: Math.max(0, Number(item.width) || 0), height: Math.max(1, Number(item.height) || Math.abs(Number(transform[3])) || 1) }
  }).filter(item => Number.isFinite(item.x) && Number.isFinite(item.y))
  if (!positioned.length || positioned.length < items.length * .7) return sequentialPdfText(items)

  const rows: { y: number; height: number; runs: typeof positioned }[] = []
  for (const run of positioned) {
    const row = rows.find(candidate => Math.abs(candidate.y - run.y) <= Math.max(1.5, Math.min(candidate.height, run.height) * .35))
    if (row) {
      row.runs.push(run)
      row.y = (row.y * (row.runs.length - 1) + run.y) / row.runs.length
      row.height = Math.max(row.height, run.height)
    } else rows.push({ y: run.y, height: run.height, runs: [run] })
  }
  rows.sort((a, b) => b.y - a.y)
  return rows.map(row => {
    const rtl = row.runs.filter(run => run.item.dir === 'rtl').length > row.runs.length / 2
    row.runs.sort((a, b) => rtl ? b.x - a.x || a.index - b.index : a.x - b.x || a.index - b.index)
    let line = '', previous: (typeof row.runs)[number] | undefined
    for (const run of row.runs) {
      const text = run.item.str
      if (previous && line && !/\s$/.test(line) && !/^\s/.test(text)) {
        const previousEnd = rtl ? run.x + run.width : previous.x + previous.width
        const gap = rtl ? previous.x - previousEnd : run.x - previousEnd
        const characterWidth = previous.width / Math.max(1, [...previous.item.str].length)
        if (gap > Math.max(.75, characterWidth * .22)) line += ' '
      }
      line += text
      previous = run
    }
    return line.trimEnd()
  }).filter(Boolean).join('\n').trim()
}

export const pdfJsParser: PdfParser = {
  id: 'pdfjs',
  async read(bytes, options) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, useSystemFonts: true })
    const document = await loading.promise
    try {
      const requestedStart = Number(options.startPage), requestedEnd = Number(options.endPage)
      const startPage = Number.isFinite(requestedStart) ? Math.max(1, Math.min(document.numPages, Math.floor(requestedStart))) : 1
      const desiredEnd = Number.isFinite(requestedEnd) ? Math.max(startPage, Math.min(document.numPages, Math.floor(requestedEnd))) : document.numPages
      const maxPages = Math.max(1, Math.min(500, Math.floor(options.maxPages || 200)))
      const endPage = Math.min(desiredEnd, startPage + maxPages - 1)
      let content = '', pagesRead = 0
      const pageTexts: string[] = [], pageNumbers: number[] = []
      for (let pageNumber = startPage; pageNumber <= endPage && (options.query || content.length <= options.offset + options.maxChars); pageNumber++) {
        const page = await document.getPage(pageNumber), text = await page.getTextContent(), pageText = pdfPageText(text.items)
        pageTexts.push(pageText)
        pageNumbers.push(pageNumber)
        content += `${content ? '\n\n' : ''}--- Page ${pageNumber} ---\n${pageText}`
        pagesRead++
        page.cleanup()
      }
      const metadata: any = await document.getMetadata().catch(() => null)
      const extractedCharacters = pageTexts.reduce((sum, text) => sum + text.trim().length, 0)
      const base = {
        pages: document.numPages, pages_read: pagesRead, page_start: startPage, page_end: pageNumbers.at(-1) || startPage,
        range_truncated: endPage < desiredEnd, text_layer: extractedCharacters > 0,
        title: metadata?.info?.Title || null, author: metadata?.info?.Author || null,
        ...(extractedCharacters ? {} : { warning: 'No extractable PDF text layer was found in the requested pages. The document may be scanned or image-only.' }),
      }
      if (!extractedCharacters) return { ...base, ...contentWindow(content, options.maxChars, options.offset, (pageNumbers.at(-1) || startPage) < desiredEnd) }
      const matches = pdfSearchExcerpts(pageTexts, options.query, options.maxChars)
      if (matches) {
        if (!matches.content) return { ...base, search_query: matches.query, matched_pages: [], total_matching_pages: 0, ...contentWindow('', options.maxChars, 0, endPage < desiredEnd) }
        const mappedPages = matches.matched_pages.map(page => pageNumbers[page - 1])
        const mappedContent = matches.content.replace(/--- Page (\d+)/g, (_match, page) => `--- Page ${pageNumbers[Number(page) - 1]}`)
        return { ...base, search_query: matches.query, matched_pages: mappedPages, total_matching_pages: matches.total_matching_pages, ...contentWindow(mappedContent, options.maxChars, 0, matches.total_matching_pages > matches.matched_pages.length || endPage < desiredEnd) }
      }
      return { ...base, ...contentWindow(content, options.maxChars, options.offset, (pageNumbers.at(-1) || startPage) < desiredEnd) }
    } finally {
      await loading.destroy()
    }
  },
}

export async function readPdfBytes(bytes: Buffer, options: PdfReadOptions, parser: PdfParser = pdfJsParser) {
  const output = await parser.read(bytes, options)
  return { parser: parser.id, ...output }
}
