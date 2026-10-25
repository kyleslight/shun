import type { FanoutProgress } from '../shared'

/** A batch may supply all queries together without inventing a separate primary query. */
export function retrievalQueries(query?: string, queries: string[] = []) {
  return retrievalTargets(query,queries,'search query')
}

export function retrievalUrls(url?: string, urls: string[] = []) {
  return retrievalTargets(url,urls,'source URL')
}

function retrievalTargets(primary: string | undefined, additional: string[], label: string) {
  const targets = [...new Set([primary, ...additional].filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean))]
  if (!targets.length) throw Error(`Provide at least one non-empty ${label}.`)
  if (targets.length > 6) throw Error('A retrieval batch accepts at most six independent targets.')
  return targets
}

/** Fetch independent targets in the same tool round, preserving partial successes and actual timing. */
export async function retrievalBatch(kind: 'search' | 'read', targets: string[], run: (target: string) => Promise<string>, onProgress?: (progress: FanoutProgress) => void): Promise<string> {
  const unique = [...new Set(targets.map(value => value.trim()).filter(Boolean))]
  const startedAt = Date.now()
  const lines: FanoutProgress['lines'] = unique.map(question => ({ question, state: 'running' }))
  const publish = () => onProgress?.({ unit: kind === 'search' ? 'queries' : 'pages', startedAt,
    ...(lines.every(line => line.state !== 'running') ? { finishedAt: Date.now() } : {}),
    done: lines.filter(line => line.state === 'done').length, failed: lines.filter(line => line.state === 'failed').length,
    running: lines.some(line => line.state === 'running'), lines: lines.map(line => ({ ...line })) })
  publish()
  const timings: Array<{ started_at: number; finished_at: number }> = []
  const settled = await Promise.allSettled(unique.map(async (target, index) => {
    const started = Date.now()
    try {
      const output = await run(target)
      let ok = true
      try { ok = JSON.parse(output).ok !== false } catch {}
      lines[index].state = ok ? 'done' : 'failed'
      return output
    } catch (error) {
      lines[index].state = 'failed'
      throw error
    } finally {
      timings[index] = { started_at: started, finished_at: Date.now() }
      lines[index].seconds = (Date.now() - started) / 1000
      publish()
    }
  }))
  if (unique.length === 1 && settled[0].status === 'fulfilled') return settled[0].value
  const responses = settled.map((result, index) => {
    if (result.status === 'rejected') return { target: unique[index], ok: false, error: String(result.reason?.message || result.reason) }
    try { return { target: unique[index], ...JSON.parse(result.value) } }
    catch { return { target: unique[index], ok: true, content: result.value } }
  })
  const found = new Set<string>(), passages = new Set<string>()
  const results = responses.flatMap(response => Array.isArray(response.results) ? response.results : []).filter(result => {
    const key = String(result.url || '')
    if (!key) return true
    if (found.has(key)) return false
    found.add(key); return true
  })
  const pages = responses.flatMap(response => kind === 'read' && !response.source_recovery ? [response] : Array.isArray(response.pages) ? response.pages : []).filter(page => {
    const key = JSON.stringify([page.final_url || page.requested_url, page.content_offset, page.content, page.error])
    if (passages.has(key)) return false
    passages.add(key); return true
  })
  const receipts = responses.map((response, index) => ({ target: response.target, ok: response.ok !== false, ...timings[index],
    ...(response.source_recovery ? {source_recovery: response.source_recovery} : {}),
    ...(response.error ? { error: response.error } : {}),
    ...(response.number_of_results !== undefined ? { number_of_results: response.number_of_results } : {}) }))
  return JSON.stringify({ batch: true, parallel: unique.length > 1, targets: unique, responses: receipts, results, pages,
    number_of_results: results.length, evidence_status: pages.some(page => page.ok === true && page.content) ? 'page_excerpts' : 'discovery_only' })
}
