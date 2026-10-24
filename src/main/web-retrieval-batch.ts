/** Fetch independent targets in the same tool round, preserving partial successes. */
export async function retrievalBatch(kind: 'search' | 'read', targets: string[], run: (target: string) => Promise<string>): Promise<string> {
  const unique = [...new Set(targets.map(value => value.trim()).filter(Boolean))]
  if (unique.length === 1) return run(unique[0])
  const settled = await Promise.allSettled(unique.map(run))
  const responses = settled.map((result, index) => {
    if (result.status === 'rejected') return { target: unique[index], ok: false, error: String(result.reason?.message || result.reason) }
    try { return { target: unique[index], ...JSON.parse(result.value) } }
    catch { return { target: unique[index], ok: true, content: result.value } }
  })
  const results = responses.flatMap(response => Array.isArray(response.results) ? response.results : [])
  const pages = responses.flatMap(response => kind === 'read' ? [response] : Array.isArray(response.pages) ? response.pages : [])
  const receipts = responses.map(response => ({ target: response.target, ok: response.ok !== false,
    ...(response.error ? { error: response.error } : {}),
    ...(response.number_of_results !== undefined ? { number_of_results: response.number_of_results } : {}) }))
  return JSON.stringify({ batch: true, parallel: true, targets: unique, responses: receipts, results, pages,
    number_of_results: results.length, evidence_status: pages.some(page => page.ok === true && page.content) ? 'page_excerpts' : 'discovery_only' })
}
