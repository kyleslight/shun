export type RetrievalDepth = 'fact_lookup' | 'deep_research'

/** Return the selected scope with evidence so each follow-up can judge whether to finish. */
export function withRetrievalDecision(output: string, depth?: unknown): string {
  const selected = depth === 'deep_research' ? 'deep_research' : 'fact_lookup'
  const instruction = selected === 'fact_lookup'
    ? 'This is a quick lookup: one parallel search batch, then at most one parallel web_read batch for an essential missing fact. Answer the requested fact in a few sentences, citing supporting passages. An ambiguous identity is unresolved; do not inventory guessed entities or fill claims from memory. If sources leave the fact unconfirmed, report that uncertainty now. Do not repeat discovery or relabel this question as deep research.'
    : 'Continue only for unresolved parts of the requested investigation. Stop when those parts are answered or remaining uncertainty can be clearly reported; new pages alone do not establish progress.'
  try { return JSON.stringify({ ...JSON.parse(output), retrieval_decision: { depth: selected, instruction } }) }
  catch { return output }
}

/** The caller selects scope explicitly; question wording never changes tool availability. */
export function retrievalProfile(value?: unknown) {
  const depth: RetrievalDepth = value === 'deep_research' ? 'deep_research' : 'fact_lookup'
  return depth === 'deep_research'
    ? { depth, maxResults: 8, readChars: 12000, networkTimeoutMs: 25000, excerptChars: 4000, excerptPages: 3, coverage: 'expanded' as const }
    : { depth, maxResults: 3, readChars: 4000, networkTimeoutMs: 8000, excerptChars: 2000, excerptPages: 2, coverage: 'standard' as const }
}
