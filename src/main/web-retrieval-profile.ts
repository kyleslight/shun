export type RetrievalDepth = 'fact_lookup' | 'deep_research'

/** Return the selected scope with evidence so each follow-up can judge whether to finish. */
export function withRetrievalDecision(output: string, depth?: unknown, requestedOutcome?: string): string {
  const selected = depth === 'deep_research' ? 'deep_research' : 'fact_lookup'
  const question = requestedOutcome && requestedOutcome.length <= 1000 ? requestedOutcome.trim() : undefined
  const instruction = selected === 'fact_lookup'
    ? 'Quick lookup: resolve the requested subject before investigating its details. If several real subjects remain plausible and the conversation cannot choose, give brief supported alternatives or ask one clarification; do not research every branch. For a resolved subject, batch independent retrievals and answer briefly once supported. Retrieve again only for a missing fact that changes the answer. Report uncertainty, cite supporting sources, and avoid repeated successful reads without a new information need.'
    : 'Continue only for unresolved parts of the requested investigation. Stop when those parts are answered or remaining uncertainty can be clearly reported; new pages alone do not establish progress.'
  try { return JSON.stringify({ ...JSON.parse(output), retrieval_decision: { depth: selected, ...(question ? { requested_outcome: question } : {}), instruction } }) }
  catch { return output }
}

/** The caller selects scope explicitly; question wording never changes tool availability. */
export function retrievalProfile(value?: unknown) {
  const depth: RetrievalDepth = value === 'deep_research' ? 'deep_research' : 'fact_lookup'
  return depth === 'deep_research'
    ? { depth, maxResults: 8, readChars: 12000, networkTimeoutMs: 25000, excerptChars: 4000, excerptPages: 3, coverage: 'expanded' as const }
    : { depth, maxResults: 3, readChars: 4000, networkTimeoutMs: 8000, excerptChars: 2000, excerptPages: 2, coverage: 'standard' as const }
}
