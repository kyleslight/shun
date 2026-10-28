import { canonicalUrl, resourceQueryMatch, readWeb, sameSourceHost, webReadReceipt, withinWebDeadline, type FetchResource } from './web.ts'

type ReadExcerpt = (url: string, query: string, maxChars: number, signal: AbortSignal) => Promise<string>

/** A source's read and recovery share a deadline instead of each spending it again. */
export async function withSourceReadWindow<T>(ms: number, signal: AbortSignal | undefined, read: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    combined.throwIfAborted()
    return await withinWebDeadline(read(combined), { signal: combined, ms, message: 'This source did not finish within the reading window. Its content remains unverified.' })
  } finally { controller.abort() }
}

/** Overlap a bounded number of reads with discovery; final ranking still chooses the evidence. */
export function createSearchReadAhead(options: { query: string; maxChars: number; signal?: AbortSignal; read: ReadExcerpt; deadlineMs?: number; maxPages?: number; onRead?: () => void }) {
  const pending = new Map<string, Promise<string | undefined>>()
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  return {
    prime(output: string) {
      if (signal.aborted || pending.size >= (options.maxPages ?? 3)) return
      let results: Array<{ url?: string; match?: { subject_match?: boolean; source_site_match?: boolean } }>
      try { results = JSON.parse(output).results } catch { return }
      if (!Array.isArray(results)) return
      const candidate = results.find(row => row.match?.subject_match !== false || row.match?.source_site_match === true)
      const url = canonicalUrl(candidate?.url)
      if (!url || pending.has(url)) return
      const readController = new AbortController()
      const readSignal = AbortSignal.any([signal, readController.signal])
      const result = withinWebDeadline(options.read(url, options.query, options.maxChars, readSignal), {
        signal: readSignal, ms: options.deadlineMs ?? 3500, message: 'Source read-ahead window ended.',
      }).then(output => { if (webReadReceipt(output, url)) options.onRead?.(); return output }).catch(() => undefined).finally(() => readController.abort())
      pending.set(url, result)
    },
    read: (async (url, query, maxChars, consumerSignal) => {
      const cached = query === options.query && maxChars === options.maxChars ? pending.get(canonicalUrl(url)) : undefined
      const output = cached ? await cached : undefined
      consumerSignal.throwIfAborted()
      // Speculation failure is not a final read failure; normal retrieval remains authoritative.
      return output !== undefined && webReadReceipt(output, url) ? output : options.read(url, query, maxChars, consumerSignal)
    }) satisfies ReadExcerpt,
    dispose() { controller.abort() },
  }
}
type Options = {
  query: string
  signal?: AbortSignal
  fetchResource?: FetchResource
  includeContent?: boolean
  deadlineMs?: number
  maxChars?: number
  maxPages?: number
  alreadyReadUrls?: ReadonlySet<string>
  /** Batch rankings already alternate independent queries. */
  preserveRanking?: boolean
  /** Follow one more specific same-site resource within the original read deadline. */
  refinePrimary?: boolean
  read?: ReadExcerpt
  onRead?: () => void
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
  const urls = (options.preserveRanking ? unread : [
    ...unread.slice(0, 1),
    ...unread.slice(1).filter(url => !sameSourceHost(host(url), primaryHost)),
    ...unread.slice(1).filter(url => sameSourceHost(host(url), primaryHost)),
  ]).slice(0, Math.max(1, Math.min(3, options.maxPages ?? 2)))
  if (!urls.length) return previouslyRead.length ? JSON.stringify({ ...result, previously_read_sources: previouslyRead }) : output
  const maxChars = Math.max(1000, Math.min(24000, options.maxChars ?? 3000)), deadlineMs = options.deadlineMs ?? 2500
  const read = options.read || ((url, query, limit, signal) => readWeb(url, limit, undefined, undefined, options.fetchResource, query, signal))
  const pages = await Promise.all(urls.map(async url => {
    const controller = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    try {
      const started = Date.now()
      let raw = await withinWebDeadline(read(url, options.query, maxChars, signal), {
        signal, ms: deadlineMs, message: 'Source excerpt did not finish within the search read window.',
      })
      let discoveredFrom: string | undefined
      let sourceUrl = url
      if (options.refinePrimary) {
        const initial = JSON.parse(raw), base = initial.final_url || initial.url || url
        const match = resourceQueryMatch(options.query, initial.title || '', base)
        const links = (Array.isArray(initial.outbound_links) ? initial.outbound_links : [])
          .filter((link: any) => {
            const target = canonicalUrl(link.url)
            return target && target !== base && !options.alreadyReadUrls?.has(target) && new URL(target).hostname === new URL(base).hostname
          })
          .map((link: any) => ({ url: canonicalUrl(link.url), ...resourceQueryMatch(options.query, link.title || '', link.url) }))
          .filter((link: any) => (link.matched > match.matched && link.coverage >= 0.65) || (link.matched >= match.matched && link.pathMatched >= 2 && link.pathMatched > match.pathMatched && match.pathTerms.every(term => link.pathTerms.includes(term))))
          .sort((a: any, b: any) => b.matched - a.matched)
        const remaining = deadlineMs - (Date.now() - started)
        if (initial.ok === true && links.length && remaining > 0) {
          try {
            const refined = await withinWebDeadline(read(links[0].url, options.query, maxChars, signal), {
              signal, ms: remaining, message: 'Linked source did not finish within the search read window.',
            })
            if (webReadReceipt(refined, links[0].url)) { raw = refined; discoveredFrom = base; sourceUrl = links[0].url }
          } catch { /* Keep the original evidence if the more specific link is unavailable. */ }
        }
      }
      const receipt = webReadReceipt(raw, sourceUrl)
      if (!receipt) return { ok: false, requested_url: url, error: 'No usable source excerpt returned.' }
      options.onRead?.()
      const page = JSON.parse(raw)
      return {
        ok: true, requested_url: sourceUrl, final_url: receipt.finalUrl,
        ...(discoveredFrom ? { discovered_from: discoveredFrom } : {}),
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
