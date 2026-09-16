// Mechanical query reformulations any search engine would recognise, derived from a
// question's own words: no answer hints and no per-question rules, so the same
// function applies to a question nobody has seen before.
const QUESTION_WORDS = /\b(?:what|which|who|whom|whose|when|where|why|how|did|does|do|is|was|were)\b/i

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'by', 'with', 'from', 'that', 'this', 'these', 'those', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'is', 'was', 'were', 'are', 'be', 'been', 'being', 'did', 'does', 'do', 'had', 'has', 'have', 'it', 'its', 'as', 'but', 'not', 'no', 'than', 'then', 'there', 'their', 'they', 'them', 'he', 'she', 'his', 'her', 'you', 'your'])

/**
 * Reformulations any search engine would recognise, derived from the question's own
 * words: no answer hints, no per-question rules, nothing that could not be applied
 * to a question the probe has never seen.
 */
export function queryVariants(question, limit = 5) {
  const text = String(question ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return []
  const words = text.split(' ').map(word => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
  const keywords = words.filter(word => word.length > 2 && !STOPWORDS.has(word.toLowerCase()))
  const entities = words.filter(word => /^[A-Z0-9]/.test(word) || /\d/.test(word)).filter(word => word.length > 1)
  const phrase = longestPhrase(text)
  return [...new Set([
    text,
    phrase ? `"${phrase}"` : '',
    keywords.slice(0, 8).join(' '),
    [...new Set([...entities.slice(0, 4), ...keywords.slice(0, 4)])].join(' '),
    keywords.length ? `${keywords.slice(0, 6).join(' ')} wikipedia` : '',
  ].filter(value => value && value.trim().length > 2))].slice(0, limit)
}

function longestPhrase(text) {
  const words = text.split(' ')
  let best = ''
  for (let start = 0; start < words.length; start++) {
    for (let size = 3; size <= 5 && start + size <= words.length; size++) {
      const candidate = words.slice(start, start + size).join(' ')
      // A phrase that still contains the question's own asking words is not a phrase
      // a publisher would have written, so it is not worth quoting back at an index.
      if (QUESTION_WORDS.test(candidate)) continue
      const content = candidate.split(' ').filter(word => word.length > 2 && !STOPWORDS.has(word.toLowerCase()))
      if (content.length >= 2 && candidate.length > best.length) best = candidate
    }
  }
  return best.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}
