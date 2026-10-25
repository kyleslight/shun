import { canonicalUrl, readWeb, sameSourceHost, webReadReceipt, withinWebDeadline, type FetchResource } from './web.ts'

type ReadExcerpt = (url: string, query: string, maxChars: number, signal: AbortSignal) => Promise<string>
type Options = {
  query: string
  signal?: AbortSignal
  fetchResource?: FetchResource
  includeContent?: boolean
  deadlineMs?: number
  maxChars?: number
  maxPages?: number
  alreadyReadUrls?: ReadonlySet<string>
  read?: ReadExcerpt
}

/** Fetch a small amount of source evidence in the discovery call, without another model turn. */
export async function supplementSearchEvidence(output: string, options: Options): Promise<string> {
  if (options.includeContent === false || (options.deadlineMs !== undefined && options.deadlineMs <= 0)) return output
  const result = JSON.parse(output)
  const candidates = Array.isArray(result.results) ? result.results : []
  const host = (value: unknown) => { const url = canonicalUrl(value); return url ? new URL(url).hostname.replace(/^www\./, '') : '' }
  const firstHost = host(candidates[0]?.url)
  // Read the best lead and another strongly matching result, even when its host is not the query subject.
  const selected = candidates.filter((item: { url?: unknown; match?: { confidence?: unknown; subject_match?: boolean; source_site_match?: boolean; term_coverage?: number; matched_terms?: number } }, index: number) => {
    if (item?.match?.subject_match === false && item.match.source_site_match !== true) return false
    const otherMatchingSource = item?.match?.subject_match === true && host(item.url) && !sameSourceHost(host(item.url), firstHost)
    return index === 0 || item?.match?.confidence === 'direct' || item?.match?.source_site_match === true || otherMatchingSource || ((item?.match?.term_coverage ?? 0) >= 0.5 && (item?.match?.matched_terms ?? 0) >= 2)
  })
  const allUrls = [...new Set<string>(selected.map((item: { url?: unknown }) => canonicalUrl(item?.url)).filter(Boolean))]
  const previouslyRead = allUrls.filter(url => options.alreadyReadUrls?.has(url))
  const unread = allUrls.filter(url => !options.alreadyReadUrls?.has(url))
  const primaryHost = host(unread[0])
  const urls = [
    ...unread.slice(0, 1),
    ...unread.slice(1).filter(url => !sameSourceHost(host(url), primaryHost)),
    ...unread.slice(1).filter(url => sameSourceHost(host(url), primaryHost)),
  ].slice(0, Math.max(1, Math.min(3, options.maxPages ?? 2)))
  if (!urls.length) return previouslyRead.length ? JSON.stringify({ ...result, previously_read_sources: previouslyRead }) : output
  const maxChars = Math.max(1000, Math.min(12000, options.maxChars ?? 3000)), deadlineMs = options.deadlineMs ?? 2500
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
        ...(typeof page.published === 'string' && page.published.trim() ? { published: page.published } : {}),
        ...(typeof page.author === 'string' && page.author.trim() ? { author: page.author } : {}),
        ...(typeof page.site === 'string' && page.site.trim() ? { site: page.site } : {}),
        ...(page.section_complete ? { section_complete: true, section_path: page.section_path } : {}),
        content_offset: page.content_offset, content_end: page.content_end,
        content_characters: page.content_characters, has_more: page.has_more,
        outbound_links: Array.isArray(page.outbound_links) ? page.outbound_links.slice(0, 4) : [],
        ...(Array.isArray(page.outbound_links) ? {
          outbound_link_count: page.outbound_link_count ?? page.outbound_links.length,
          outbound_links_truncated: page.outbound_links_truncated === true || page.outbound_links.length > 4,
        } : {}),
        content: receipt.content,
      }
    } catch {
      return { ok: false, requested_url: url, error: 'Source excerpt unavailable within the search read window.' }
    } finally { controller.abort() }
  }))
  options.signal?.throwIfAborted()
  return JSON.stringify({ ...result, ...(previouslyRead.length ? { previously_read_sources: previouslyRead } : {}), evidence_status: pages.some(page => page.ok) ? 'page_excerpts' : 'discovery_only', pages }, null, 2)
}
