/**
 * Parsers for the research loop's structured steps, kept apart from the loop so they can be tested
 * without running a benchmark. A plan or a ledger the model formatted imperfectly is not a missing
 * plan or an empty ledger: both are read tolerantly, the way the published implementations read
 * them, because a silently dropped plan looks exactly like a round that found nothing.
 */
export function shortenQuery(query, maxWords = 6) {
  const words = String(query || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (words.length <= maxWords) return words.join(' ')
  return words.slice(0, maxWords).join(' ').replace(/[\s,;:.-]+$/, '')
}

export function parsePlannedQueries(text, limit = 6) {
  const source = String(text || '')
  const start = source.indexOf('{'), end = source.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(source.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'))
      const rows = Array.isArray(parsed?.queries) ? parsed.queries : []
      const cleaned = rows.map(row => ({ query: String(row?.query || '').trim(), goal: String(row?.goal || '').trim() })).filter(row => row.query)
      if (cleaned.length) return cleaned.slice(0, limit)
    } catch {}
  }
  const queries = [], goals = []
  for (const line of source.split('\n')) {
    const query = line.match(/^\s*(?:[-*]|\d+[.)])?\s*(?:\**\s*)?query\s*\**\s*[:\-]\s*(.+)$/i)?.[1]
    const goal = line.match(/^\s*(?:[-*]|\d+[.)])?\s*(?:\**\s*)?(?:goal|research goal)\s*\**\s*[:\-]\s*(.+)$/i)?.[1]
    if (query) queries.push(query.replace(/^["'`]+|["'`]+$/g, '').trim())
    else if (goal) goals.push(goal.replace(/^["'`]+|["'`]+$/g, '').trim())
  }
  return queries.map((query, index) => ({ query, goal: goals[index] || '' })).slice(0, limit)
}

export function parseLedger(text) {
  const source = String(text || '')
  const sections = { established: [], candidates: [], open: [] }
  let current = ''
  const heading = line => {
    const match = line.match(/^\s*(?:\**\s*)?(ESTABLISHED|CANDIDATES?|OPEN(?:\s+QUESTIONS?)?)\s*\**\s*:?\s*(.*)$/i)
    return match ? { name: match[1].toUpperCase().startsWith('ESTAB') ? 'established' : match[1].toUpperCase().startsWith('CAND') ? 'candidates' : 'open', rest: match[2] } : null
  }
  for (const raw of source.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const found = heading(line)
    if (found) {
      current = found.name
      if (found.rest.trim()) sections[current].push(found.rest.trim())
      continue
    }
    if (!current || !line.trim()) continue
    sections[current].push(line.trim())
  }
  const clean = (lines, cap) => lines.join('\n').replace(/^\s*[`*]+|[`*]+\s*$/g, '').trim().slice(0, cap)
  return { established: clean(sections.established, 4_000), candidates: clean(sections.candidates, 2_000), open: clean(sections.open, 2_000) }
}

