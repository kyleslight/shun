import type { RawResult } from './web.ts'

/**
 * Fallback discovery through the user's own Chrome.
 *
 * Shun's keyless sources are public indexes, and an index can refuse this machine while answering
 * the person sitting in front of it: the same query that returns an anti-bot page to a plain fetch
 * returns real results in their signed-in browser on their own network. When the user has installed
 * and connected the Browser Use plugin *and* turned this on, the search tool can therefore reach a
 * general engine the keyless path cannot.
 *
 * It is a fallback for two reasons that are properties of the channel, not of the code: the results
 * depend on a session this process does not own (so they are labelled as coming from the user's
 * browser and never presented as an independent source), and the queries are made in that account's
 * name (so they stay few, and only when the keyless path came back thin).
 */

export type ChromeSearchSnapshot = {
  tab?: { url?: string; title?: string }
  /** How far the page had loaded, which decides whether its tree is worth parsing yet. */
  readyState?: string
  nodes?: Array<Record<string, unknown>>
}

const ENGINE_HOSTS = /(?:^|\.)(?:google|bing|duckduckgo|yahoo|baidu|so|yandex|mojeek|startpage|ecosia|brave|search)\./i

/**
 * The engines a fallback query is sent to, strongest index first. Which index is strongest does not
 * depend on the language of the question — Google's Chinese index is deeper than Baidu's — so the
 * order is fixed and the next engine is tried only when the previous one answers nothing usable.
 */
export const USER_BROWSER_ENGINES = [
  { id: 'google', url: (query: string) => `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20&hl=en` },
  { id: 'bing', url: (query: string) => `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=20&setlang=en` },
  { id: 'baidu', url: (query: string) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}` },
] as const

/**
 * A search engine's own accessible name for a result carries the title, the site, and the address.
 * The address is the part that matters — a result without one cannot be opened — and the title is
 * what precedes it once the engine's decorations are taken off.
 */
/** One result as this channel states it: the address is always known once a row exists. */
export type UserBrowserResult = { title: string; url: string; content: string; engine: string }

export function parseUserBrowserResults(snapshot: ChromeSearchSnapshot, engine: string, limit = 8, query = ''): UserBrowserResult[] {
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : []
  const results: UserBrowserResult[] = [], seen = new Set<string>()
  let lastTitle = ''
  let openRow: UserBrowserResult | null = null
  let openSegments = 0
  for (const node of nodes) {
    const role = String(node?.role || '')
    const name = String(node?.name || '').replace(/\s+/g, ' ').trim()
    const description = String(node?.description || '').replace(/\s+/g, ' ').trim()
    const value = String(node?.value || '').replace(/\s+/g, ' ').trim()
    // An engine that states the address in parts puts the parts in the nodes that follow the title,
    // so the path is joined onto the result the previous nodes opened.
    if (openRow && /^[›»]/.test(name) && openSegments < 6) {
      // One node can carry several parts of the path; each part is a segment of the address.
      const segments = name.replace(/^[›»]\s*/, '').split(/[›»]/)
        .map(part => part.split(/\s*[·|]\s*/)[0].trim())
        .filter(segment => segment && !/\.\.\.$/.test(segment))
      if (segments.length) {
        for (const segment of segments.slice(0, 6 - openSegments)) {
          openRow.url = `${openRow.url.replace(/\/+$/, '')}/${segment.replace(/^\/+|\/+$/g, '')}`
          openSegments++
        }
        openRow.content = `${openRow.title} ${openRow.url}`.slice(0, 420)
        seen.add(openRow.url)
        continue
      }
    }
    if (role === 'link' && name && !/^https?:\/\//.test(name)) lastTitle = name
    // The address is not always inside the link: engines state it in the node beside the title, so
    // every piece of node text is examined and attributed to the link that preceded it.
    const address = firstAddress(name) || firstAddress(description) || firstAddress(value)
    if (!address || seen.has(address) || ENGINE_HOSTS.test(safeHost(address))) continue
    // The title is the link that preceded the address; when the address sits inside the link's own
    // name, the title is whatever preceded the address in that text.
    const leading = firstAddress(name) ? name.slice(0, name.indexOf(address)).trim() : ''
    const title = leading || lastTitle || safeHost(address)
    seen.add(address)
    const row: UserBrowserResult = { title: title.replace(/[·|—–-]\s*$/, '').trim().slice(0, 200) || address, url: address, content: `${title} ${description}`.trim().slice(0, 420), engine: `user-browser:${engine}` }
    results.push(row)
    openRow = row
    openSegments = 0
  }
  // An engine that silently answers a different question is worse than one that refuses: a page set
  // that shares no word with the query is discarded rather than reported as results for it.
  const terms = [...new Set(String(query).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').split(' ').filter(term => term.length > 3))]
  const relevant = terms.length
    ? results.filter(row => terms.some(term => `${row.title} ${row.content}`.toLowerCase().includes(term)))
    : results
  return relevant.slice(0, limit)
}

function firstAddress(text: string) {
  const source = String(text || '')
  const match = source.match(/https?:\/\/\S+/)
  if (!match) return ''
  let address = match[0]
  const tail = source.slice((match.index || 0) + match[0].length)
  for (const part of tail.split(/\s*›\s*/).slice(1)) {
    const segment = part.split(/\s*[·|]\s*/)[0].trim()
    if (!segment || address.split('/').length > 8) break
    address = `${address.replace(/\/+$/, '')}/${segment.replace(/^\/+|\/+$/g, '')}`
  }
  return address.replace(/[).,;]+$/, '')
}

function safeHost(value: string) {
  try { return new URL(value).hostname } catch { return '' }
}

export type UserBrowserSearchOptions = {
  /** Opens a background tab in the user's Chrome and returns the first snapshot of it. */
  openTab: (url: string, active: boolean) => Promise<{ sessionId: string; snapshot: ChromeSearchSnapshot }>
  /** Reads the tab again, for a page that was still rendering when its tab opened. */
  snapshot: (sessionId: string) => Promise<ChromeSearchSnapshot>
  attempts?: number
  pauseMs?: number
  /** Releases the tab this search opened; tool-created tabs are closed again. */
  closeTab: (sessionId: string) => Promise<void>
  limit?: number
}

/**
 * Runs one query in the user's browser and returns the results its engine page shows. The tab is
 * closed again, so a fallback search leaves the user's window as it found it.
 */
export function createUserBrowserSearch(options: UserBrowserSearchOptions) {
  const attempts = options.attempts || 5
  const pauseMs = options.pauseMs || 900
  return async (query: string, limit = 8): Promise<RawResult[]> => {
    for (const engine of USER_BROWSER_ENGINES) {
      const tab = await options.openTab(engine.url(query), false)
      try {
        // A result page is not ready when its tab opens: the first snapshot of it is an empty tree
        // while the engine is still rendering, so the page is asked for again until it has one.
        let snapshot = tab.snapshot
        for (let attempt = 1; attempt < attempts; attempt++) {
          if (pageHasContent(snapshot)) break
          await new Promise(resolve => setTimeout(resolve, pauseMs))
          snapshot = await options.snapshot(tab.sessionId).catch(() => snapshot)
        }
        const results = parseUserBrowserResults(snapshot, engine.id, Math.min(limit, options.limit || 8), query)
        if (results.length) return results
      } catch {
        // One engine failing is not the channel failing: the next one is tried.
      } finally {
        await options.closeTab(tab.sessionId).catch(() => {})
      }
    }
    return []
  }
}

function pageHasContent(snapshot: ChromeSearchSnapshot) {
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : []
  return String(snapshot?.readyState || '') === 'complete' && nodes.length > 20
}
