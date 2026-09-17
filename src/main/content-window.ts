export function contentWindow(content: string, maxChars: number, offset: number, knownHasMore = false) {
  const value = content.slice(offset, offset + maxChars), end = offset + value.length, hasMore = knownHasMore || end < content.length
  return { content_offset: offset, content_end: end, content_characters: content.length, returned_characters: value.length, truncated: offset > 0 || hasMore, has_more: hasMore, content: value }
}

/**
 * Words that carry no locating power in a page of prose, so a paragraph is ranked by
 * the words that do.
 */
const WINDOW_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'was', 'were', 'are', 'his', 'her', 'its', 'had', 'has', 'have', 'not', 'but', 'who', 'whom', 'whose', 'which', 'what', 'when', 'where', 'why', 'how', 'did', 'does', 'into', 'than', 'then', 'there', 'their', 'they', 'them', 'she', 'him', 'you', 'your', 'our', 'out', 'one', 'two', 'all', 'any', 'also', 'been', 'being'])

export function windowTerms(query: unknown) {
  return [...new Set(String(query ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(term => term.length > 2 && !WINDOW_STOPWORDS.has(term)))]
}

/**
 * A page is read for a reason, and a long page usually answers it in one section.
 * Slicing the first N characters returns the navigation and the introduction of an
 * episode list, a CV, or an archive while the paragraph that carries the answer sits
 * thousands of characters further down — the page was read and the reason was not.
 *
 * With a query, the paragraphs that actually carry the query's words are returned, in
 * document order and inside the same character budget, and the offsets of the first
 * and last of them are reported so a caller can ask for more. Without a query, or when
 * nothing matches, this is the plain window it has always been.
 */
export function queryWindow(content: string, query: unknown, maxChars: number, offset: number) {
  const terms = windowTerms(query)
  const base = contentWindow(content, maxChars, offset)
  if (!terms.length || !content) return { ...base, matched_sections: 0 }
  // Windowing is for pages that do not fit. A page that fits is returned whole, because
  // trimming what a query did not name loses the context that makes the rest mean anything.
  if (content.length <= maxChars) return { ...contentWindow(content, maxChars, offset), matched_sections: 0, search_query: String(query ?? '').slice(0, 200) }
  const haystack = content.normalize('NFKC').toLowerCase()
  const positions = terms.map(term => {
    const found: number[] = []
    for (let at = haystack.indexOf(term); at >= 0; at = haystack.indexOf(term, at + 1)) found.push(at)
    return { term, found }
  }).filter(entry => entry.found.length)
  if (!positions.length) return { ...base, matched_sections: 0 }
  // A distinctive word locates a region and a generic one does not, so a match counts for
  // how rare it is on this page.
  const weights = new Map(positions.map(entry => [entry.term, 1 / Math.max(1, entry.found.length)]))
  // The relevant part of a page is contiguous: a reader scrolls to it and reads. Choosing the
  // densest window on the character grid holds for prose and for a table of rows alike,
  // whereas picking scattered paragraphs drops whatever sits between them.
  // Sampling has to stay bounded on a very large page, and each window's score has to be a count
  // over sorted positions rather than a scan of every match: a page where a common word appears
  // tens of thousands of times made the scan quadratic, and the reader appeared to hang.
  const limit = Math.max(0, content.length - maxChars)
  const step = Math.max(200, Math.floor(maxChars / 8), Math.ceil(limit / 400))
  const maxScore = [...weights.values()].reduce((sum, value) => sum + value, 0)
  let best = { start: Math.min(offset, limit), end: Math.min(content.length, offset + maxChars), score: 0 }
  const starts: number[] = []
  for (let start = Math.min(offset, limit); start <= limit; start += step) starts.push(start)
  // The last window starts exactly at the limit: stepping past it would leave the end of the page
  // unexamined, which is where a footer, a final table row, or a last chapter lives.
  if (!starts.includes(limit)) starts.push(limit)
  for (const start of starts) {
    const end = start + maxChars
    const score = positions.reduce((sum, entry) => sum + (countWithin(entry.found, start, end) > 0 ? weights.get(entry.term) || 0 : 0), 0)
    if (score > best.score) best = { start, end, score }
    if (score >= maxScore) break
  }
  const after = positions.reduce((total, entry) => total + entry.found.filter(at => at >= best.end).length, 0)
  const before = positions.reduce((total, entry) => total + entry.found.filter(at => at < best.start).length, 0)
  const matched = positions.length
  const notice = [
    before ? `[${before} earlier match(es) for this query are before this excerpt]` : '',
    after ? `[${after} later match(es) are after this excerpt: continue with offset ${best.end}]` : '',
  ].filter(Boolean).join('\n')
  const body = content.slice(best.start, best.end)
  const value = notice ? `${notice}\n${body}` : body
  return {
    content_offset: best.start,
    content_end: best.end,
    content_characters: content.length,
    returned_characters: value.length,
    truncated: true,
    has_more: after > 0,
    search_query: String(query ?? '').slice(0, 200),
    matched_sections: matched,
    content: value,
  }
}

/** How many sorted positions fall inside [from, to): counted by bisection, never by scanning. */
function countWithin(positions: number[], from: number, to: number) {
  let low = 0, high = positions.length
  while (low < high) { const middle = (low + high) >> 1; if (positions[middle] < from) low = middle + 1; else high = middle }
  const first = low
  low = first; high = positions.length
  while (low < high) { const middle = (low + high) >> 1; if (positions[middle] < to) low = middle + 1; else high = middle }
  return low - first
}
