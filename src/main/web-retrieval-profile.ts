export type RetrievalDepth = 'fact_lookup' | 'deep_research'

/** The caller selects scope explicitly; question wording never changes tool availability. */
export function retrievalProfile(value?: unknown) {
  const depth: RetrievalDepth = value === 'deep_research' ? 'deep_research' : 'fact_lookup'
  return depth === 'deep_research'
    ? { depth, maxResults: 8, excerptChars: 4000, excerptPages: 3, coverage: 'expanded' as const }
    : { depth, maxResults: 3, excerptChars: 2000, excerptPages: 2, coverage: 'standard' as const }
}
