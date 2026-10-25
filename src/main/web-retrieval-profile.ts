export type RetrievalDepth = 'fact_lookup' | 'deep_research'

export type ReadSource = { url: string; title?: string }

/** A successful read identifies a page, not the truth of every claim on it. */
export function readSources(receipt: unknown): ReadSource[] {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return []
  const record = receipt as Record<string, unknown>
  const pages = Array.isArray(record.pages) ? record.pages : [record]
  const sources = new Map<string, ReadSource>()
  for (const value of pages) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const page = value as Record<string, unknown>
    if (page.ok !== true || typeof page.content !== 'string' || !page.content.trim()) continue
    const target = page.final_url || page.url || page.requested_url
    if (typeof target !== 'string') continue
    try {
      const url = new URL(target)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
      const title = typeof page.title === 'string' ? page.title.trim() : ''
      sources.set(url.href, { url: url.href, ...(title ? { title } : {}) })
    } catch {}
  }
  return [...sources.values()]
}

/** Return the selected scope with evidence so each follow-up can judge whether to finish. */
export function withRetrievalDecision(output: string, depth?: unknown, requestedOutcome?: string): string {
  const selected = depth === 'deep_research' ? 'deep_research' : 'fact_lookup'
  const question = requestedOutcome && requestedOutcome.length <= 1000 ? requestedOutcome.trim() : undefined
  const instruction = selected === 'fact_lookup'
    ? 'Quick lookup: resolve the requested subject before investigating its details. If several real subjects remain plausible and the conversation cannot choose, give brief supported alternatives or ask one clarification; do not research every branch. For a resolved subject, batch independent retrievals and answer briefly once supported. Retrieve again only for a missing fact that changes the answer. Report uncertainty and avoid repeated successful reads without a new information need. Cite a successfully read page only when its fetched content supports the claim; search results and links inside a page remain unverified until read. A dated pending status does not establish current absence of an announcement: make a meaningful current publisher-channel check, then report precisely what could not be confirmed instead of seeking universal proof of absence.'
    : 'Continue only for unresolved parts of the requested investigation. Stop when those parts are answered or remaining uncertainty can be clearly reported; new pages alone do not establish progress.'
  try {
    const receipt = JSON.parse(output)
    return JSON.stringify({ ...receipt, retrieval_decision: { depth: selected, ...(question ? { requested_outcome: question } : {}), read_sources: readSources(receipt), instruction } })
  }
  catch { return output }
}

/** The caller selects scope explicitly; question wording never changes tool availability. */
export function retrievalProfile(value?: unknown) {
  const depth: RetrievalDepth = value === 'deep_research' ? 'deep_research' : 'fact_lookup'
  return depth === 'deep_research'
    ? { depth, maxResults: 8, readChars: 12000, networkTimeoutMs: 25000, excerptChars: 4000, excerptPages: 3, coverage: 'expanded' as const }
    : { depth, maxResults: 3, readChars: 12000, networkTimeoutMs: 8000, excerptChars: 8000, excerptPages: 2, coverage: 'standard' as const }
}
