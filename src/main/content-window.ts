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
  // dropping the paragraphs a query did not name loses the context that makes the
  // paragraphs it did name mean anything.
  if (content.length <= maxChars) return { ...contentWindow(content, maxChars, offset), matched_sections: 0, search_query: String(query ?? '').slice(0, 200) }
  const paragraphs: Array<{ start: number; text: string }> = []
  let cursor = 0
  for (const piece of content.split('\n')) {
    if (piece.trim()) paragraphs.push({ start: cursor, text: piece })
    cursor += piece.length + 1
  }
  const scored = paragraphs.map(paragraph => {
    const haystack = paragraph.text.normalize('NFKC').toLowerCase()
    return { ...paragraph, haystack, hits: terms.filter(term => haystack.includes(term)).length }
  }).filter(paragraph => paragraph.hits > 0)
  if (!scored.length) return { ...base, matched_sections: 0 }
  // A distinctive word locates a section and a generic one does not, so each matched
  // term counts for how rare it is on this page. Without that, the words every
  // paragraph shares decide the ranking and the section that carries the answer loses.
  const frequency = new Map(terms.map(term => [term, Math.max(1, scored.filter(paragraph => paragraph.haystack.includes(term)).length)]))
  const weighted = scored.map(paragraph => ({ ...paragraph, score: terms.reduce((total, term) => total + (paragraph.haystack.includes(term) ? 1 / (frequency.get(term) || 1) : 0), 0) }))
  // Strongest sections first, but returned in document order so the excerpt reads the
  // way the page does, and only as many as the budget holds.
  const ranked = [...weighted].sort((a, b) => b.score - a.score || a.start - b.start)
  const selected: Array<{ start: number; text: string }> = []
  let used = 0
  for (const paragraph of ranked) {
    const cost = paragraph.text.length + 1
    if (used + cost > maxChars && selected.length) continue
    selected.push(paragraph)
    used += cost
    if (used >= maxChars) break
  }
  selected.sort((a, b) => a.start - b.start)
  const head = selected[0], tail = selected[selected.length - 1]
  const body = selected.map(paragraph => paragraph.text).join('\n')
  const skippedEarlier = scored.filter(paragraph => paragraph.start < head.start).length
  const skippedBetween = selected.slice(1).reduce((total, paragraph, index) => total + countBetween(paragraphs, selected[index], paragraph), 0)
  const skippedLater = scored.filter(paragraph => paragraph.start > tail.start).length
  const notice = [
    skippedEarlier ? `${skippedEarlier} matching section(s) before this excerpt` : '',
    skippedBetween ? `… ${skippedBetween} paragraph(s) without the query's words …` : '',
    skippedLater ? `${skippedLater} matching section(s) after this excerpt` : '',
  ].filter(Boolean).join('\n')
  const content_ = notice ? `${notice}\n${body}` : body
  return {
    content_offset: head.start,
    content_end: tail.start + tail.text.length,
    content_characters: content.length,
    returned_characters: content_.length,
    truncated: skippedEarlier > 0 || skippedBetween > 0 || skippedLater > 0,
    has_more: skippedLater > 0 || skippedBetween > 0,
    search_query: String(query ?? '').slice(0, 200),
    matched_sections: scored.length,
    content: content_,
  }
}

function countBetween(paragraphs: Array<{ start: number }>, from: { start: number }, to: { start: number }) {
  return paragraphs.filter(paragraph => paragraph.start > from.start && paragraph.start < to.start).length
}
