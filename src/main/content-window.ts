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
  return [...new Set(String(query ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, ' ').split(' ').filter(term => (term.length > 2 || /^[\p{Script=Han}]{2}$/u.test(term)) && !WINDOW_STOPWORDS.has(term)))]
}

export type QueryContentWindow = ReturnType<typeof contentWindow> & {
  matched_sections: number
  search_query?: string
  query_matches?: { before: number; after: number }
  section_complete?: boolean
  section_path?: string[]
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
export function queryWindow(content: string, query: unknown, maxChars: number, offset: number, options: { title?: unknown } = {}): QueryContentWindow {
  const words = String(query ?? '').normalize('NFKC').toLowerCase().match(/[a-z0-9_]+/g) || []
  const phrases = words.slice(1).map((word, index) => `${words[index]} ${word}`)
    .filter(phrase => phrase.split(' ').some(term => !WINDOW_STOPWORDS.has(term)))
  const terms = [...new Set([...windowTerms(query), ...phrases])]
  const base = contentWindow(content, maxChars, offset)
  if (!terms.length || !content) return { ...base, matched_sections: 0 }
  // Windowing is for pages that do not fit. A page that fits is returned whole, because
  // trimming what a query did not name loses the context that makes the rest mean anything.
  if (content.length <= maxChars) return { ...contentWindow(content, maxChars, offset), matched_sections: 0, search_query: String(query ?? '').slice(0, 200) }
  const haystack = content.normalize('NFKC').toLowerCase()
  // Citation lists repeat query words in titles and dates. They are still
  // searchable evidence, but should not outrank the prose they document merely
  // because many references are packed into the same character window.
  const citations = [...haystack.matchAll(/^\[\^[^\]\n]+\]:[^\n]*(?:\n(?![ \t]*\n)[^\n]*)*/gm)]
    .map(match => ({ start: match.index!, end: match.index! + match[0].length }))
  const inCitation = (at: number) => {
    let low = 0, high = citations.length
    while (low < high) { const middle = (low + high) >> 1; if (citations[middle].start <= at) low = middle + 1; else high = middle }
    return low > 0 && at < citations[low - 1].end
  }
  const positions = terms.map(term => {
    const found: number[] = []
    // Markdown may escape an identifier's underscores. Keep the identifier whole
    // and match either spelling without changing document offsets.
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '\\\\?_')
    const inflected = /^[a-z]{4,}$/.test(term) ? `${escaped}(?:s|es|ed|ing|ly)?` : escaped
    const pattern = /^[a-z0-9_ ]+$/.test(term) ? `(?<![a-z0-9_])${inflected}(?![a-z0-9_])` : escaped
    for (const match of haystack.matchAll(new RegExp(pattern, 'g'))) found.push(match.index!)
    return { term, found, body: found.filter(at => !inCitation(at)), citations: found.filter(inCitation) }
  }).filter(entry => entry.found.length)
  if (!positions.length) return { ...base, matched_sections: 0 }
  // A distinctive word locates a region and a generic one does not, so a match counts for
  // how rare it is on this page.
  const titleTerms = new Set(windowTerms(options.title))
  const isTitleTerm = (term: string) => term.split(' ').every(word => titleTerms.has(word))
  const hasDetailTerms = positions.some(entry => !isTitleTerm(entry.term))
  // A document's title identifies its subject. When the query also names details,
  // those details locate the answer; a rare title word must not pull it to the introduction.
  const weights = new Map(positions.map(entry => [entry.term,
    (hasDetailTerms && isTitleTerm(entry.term) ? 0.02 : 1) / Math.max(1, entry.body.length + entry.citations.length * 0.1)]))
  const matchScore = (entry: typeof positions[number], start: number, end: number) =>
    Math.min(countWithin(entry.body, start, end), 3) + 0.1 * Math.min(countWithin(entry.citations, start, end), 3)
  // Count bounded repetitions as well as presence: a navigation mention must not
  // tie with the section that repeatedly explains the requested concept.
  // The relevant part of a page is contiguous: a reader scrolls to it and reads. Choosing the
  // densest window on the character grid holds for prose and for a table of rows alike,
  // whereas picking scattered paragraphs drops whatever sits between them.
  // Sampling has to stay bounded on a very large page, and each window's score has to be a count
  // over sorted positions rather than a scan of every match: a page where a common word appears
  // tens of thousands of times made the scan quadratic, and the reader appeared to hang.
  const limit = Math.max(0, content.length - maxChars)
  const step = Math.max(200, Math.floor(maxChars / 8), Math.ceil(limit / 400))
  let best = { start: Math.min(offset, limit), end: Math.min(content.length, offset + maxChars), score: 0, centrality: -Infinity }
  const starts: number[] = []
  for (let start = Math.min(offset, limit); start <= limit; start += step) starts.push(start)
  // The last window starts exactly at the limit: stepping past it would leave the end of the page
  // unexamined, which is where a footer, a final table row, or a last chapter lives.
  if (!starts.includes(limit)) starts.push(limit)
  for (const start of starts) {
    const end = start + maxChars
    const score = positions.reduce((sum, entry) => sum + (weights.get(entry.term) || 0) * matchScore(entry, start, end), 0)
    const center = (start + end) / 2
    const centrality = positions.reduce((sum, entry) => {
      const bodyDistance = nearestMatchDistance(entry.body, center, start, end)
      const distance = Number.isFinite(bodyDistance) ? bodyDistance : nearestMatchDistance(entry.citations, center, start, end)
      return sum + (Number.isFinite(distance) ? (weights.get(entry.term) || 0) * (1 - distance / (maxChars / 2)) : 0)
    }, 0)
    if (score > best.score || (score === best.score && centrality > best.centrality)) best = { start, end, score, centrality }
  }
  // A complete, relevant section is more useful than padding the result with
  // unrelated sections to fill the character allowance. Keep every matched detail
  // term, preserve the section verbatim, and fall back to the full window otherwise.
  const details = positions.filter(entry => !isTitleTerm(entry.term))
  const headings = [...content.matchAll(/^ {0,3}(#{1,6})[ \t]+([^\n]+)$/gm)]
  let section: { start: number; end: number; score: number; path: string[] } | undefined
  if (details.length >= 2) for (let i = 0; i < headings.length; i++) {
    const heading = headings[i], start = heading.index!, level = heading[1].length
    const end = headings.slice(i + 1).find(next => next[1].length <= level)?.index ?? content.length
    if (start < offset || end - start < 160 || end - start > maxChars * 0.7) continue
    if (!details.every(entry => countWithin(entry.found, start, end) > 0)) continue
    const score = positions.reduce((sum, entry) => sum + (weights.get(entry.term) || 0) * matchScore(entry, start, end), 0)
    if (score < best.score * 0.85 || (section && score / (end - start) <= section.score / (section.end - section.start))) continue
    const ancestors: Array<{ level: number; title: string }> = []
    for (const ancestor of headings.slice(0, i + 1)) {
      while (ancestors.length && ancestors[ancestors.length - 1].level >= ancestor[1].length) ancestors.pop()
      ancestors.push({ level: ancestor[1].length, title: ancestor[2].trim() })
    }
    section = { start, end, score, path: ancestors.map(ancestor => ancestor.title) }
  }
  if (section) best = { ...best, ...section }
  const after = positions.reduce((total, entry) => total + entry.found.filter(at => at >= best.end).length, 0)
  const before = positions.reduce((total, entry) => total + entry.found.filter(at => at < best.start).length, 0)
  const matched = positions.length
  const value = content.slice(best.start, best.end)
  return {
    content_offset: best.start,
    content_end: best.end,
    content_characters: content.length,
    returned_characters: value.length,
    truncated: true,
    has_more: after > 0,
    search_query: String(query ?? '').slice(0, 200),
    ...(section ? { section_complete: true, section_path: section.path } : {}),
    matched_sections: matched,
    query_matches: { before, after },
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


/** Prefer context around a match over a window that cuts immediately after it. */
function nearestMatchDistance(positions: number[], center: number, from: number, to: number) {
  let low = 0, high = positions.length
  while (low < high) { const middle = (low + high) >> 1; if (positions[middle] < center) low = middle + 1; else high = middle }
  let distance = Infinity
  for (const index of [low - 1, low]) {
    const position = positions[index]
    if (position >= from && position < to) distance = Math.min(distance, Math.abs(position - center))
  }
  return distance
}
