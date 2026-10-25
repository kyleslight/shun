import {readSources} from './web-retrieval-profile.ts'

export class SourceNotFoundError extends Error {
  readonly url: string
  readonly status: string
  constructor(url: string, status: string) {
    super(`resource-not-found (${status}). Do not guess sibling URL paths. Use web_search with site="${new URL(url).hostname}" and the unresolved fact to discover a real source link, then read that link. This failed URL supplies no factual evidence.`)
    this.name = 'SourceNotFoundError'
    this.url = url
    this.status = status
  }
}

/** One discovery operation for a missing page; alternative readers do not recurse here. */
export async function readWithSourceRecovery(
  input: {url: string; query?: unknown; signal?: AbortSignal},
  read: () => Promise<string>,
  discover: (query: string, site: string, sourceUrl: string) => Promise<string>,
  recoveries = new Map<string, Promise<string>>(),
) {
  try { return await read() }
  catch (error) {
    input.signal?.throwIfAborted()
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (!(error instanceof SourceNotFoundError) || !query) throw error
    const site = new URL(error.url).hostname, key = JSON.stringify([site, query])
    let discovery = recoveries.get(key)
    if (!discovery) { discovery = discover(query, site, error.url); recoveries.set(key, discovery) }
    let receipt: any
    try { receipt = JSON.parse(await discovery) } catch { input.signal?.throwIfAborted(); throw error }
    input.signal?.throwIfAborted()
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw error
    const pages = Array.isArray(receipt.pages) ? receipt.pages : []
    const results = Array.isArray(receipt.results) ? receipt.results : []
    if (!pages.length && !results.length) throw error
    return JSON.stringify({ ...receipt, batch: true,
      ok: readSources({pages}).length > 0,
      source_recovery: {requested_url: input.url, unavailable_url: error.url, status: error.status},
      recovery_note: 'The requested page was not found. These are rediscovered alternatives, not the original page. Only successfully read content supports facts; retain each alternative’s own source URL.',
    })
  }
}

