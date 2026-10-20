import { canonicalUrl, readWeb, webReadReceipt, withinWebDeadline, type FetchResource } from './web.ts'

type ReadExcerpt = (url: string, query: string, maxChars: number, signal: AbortSignal) => Promise<string>
type Options = {
  query: string
  signal?: AbortSignal
  fetchResource?: FetchResource
  includeContent?: boolean
  deadlineMs?: number
  read?: ReadExcerpt
}

/** Fetch a small amount of source evidence in the discovery call, without another model turn. */
export async function supplementSearchEvidence(output: string, options: Options): Promise<string> {
  if (options.includeContent === false || (options.deadlineMs !== undefined && options.deadlineMs <= 0)) return output
  const result = JSON.parse(output)
  const candidates = Array.isArray(result.results) ? result.results : []
  // Read the best lead; extra reads require a direct match rather than a merely related result.
  const selected = candidates.filter((item: { match?: { confidence?: unknown } }, index: number) => index === 0 || item?.match?.confidence === 'direct')
  const urls = [...new Set<string>(selected.map((item: { url?: unknown }) => canonicalUrl(item?.url)).filter(Boolean))].slice(0, 2)
  if (!urls.length) return output
  const maxChars = 3000, deadlineMs = options.deadlineMs ?? 2500
  const read = options.read || ((url, query, limit, signal) => readWeb(url, limit, undefined, undefined, options.fetchResource, query, signal))
  const pages = await Promise.all(urls.map(async url => {
    const controller = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    try {
      const raw = await withinWebDeadline(read(url, options.query, maxChars, signal), {
        signal, ms: deadlineMs, message: 'Source excerpt did not finish within the search read window.',
      })
      const receipt = webReadReceipt(raw, url)
      if (!receipt) return { ok: false, requested_url: url, error: 'No usable source excerpt returned.' }
      const page = JSON.parse(raw)
      return {
        ok: true, requested_url: url, final_url: receipt.finalUrl,
        title: receipt.title, content_type: receipt.contentType,
        content_offset: page.content_offset, content_end: page.content_end,
        content_characters: page.content_characters, has_more: page.has_more,
        outbound_links: Array.isArray(page.outbound_links) ? page.outbound_links.slice(0, 4) : [],
        content: receipt.content,
      }
    } catch {
      return { ok: false, requested_url: url, error: 'Source excerpt unavailable within the search read window.' }
    } finally { controller.abort() }
  }))
  options.signal?.throwIfAborted()
  return JSON.stringify({ ...result, evidence_status: pages.some(page => page.ok) ? 'page_excerpts' : 'discovery_only', pages }, null, 2)
}
