import { execFile as execFileCb } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Defuddle } from 'defuddle/node'
import { DOMParser, parseHTML } from 'linkedom'
import { isSoftNotFoundSource } from '../shared.ts'
import { contentWindow, queryWindow, jsonRecordWindow } from './content-window.ts'
import { readPdfBytes } from './pdf-reader.ts'
import { PublicHttpPool } from './web-http.ts'
import { retrievalProfile, type RetrievalDepth } from './web-retrieval-profile.ts'
import { SourceNotFoundError } from './web-source-recovery.ts'
import { FreeSearchCoordinator, markSourceBlocked, type SearchCandidate, type SearchCoordinationResult, type SearchProvider } from './web-search-coordinator.ts'
import { isLoopbackHttpUrl } from './browser-debug.ts'

export { contentWindow, queryWindow } from './content-window.ts'
export { pdfPageText, pdfSearchExcerpts } from './pdf-reader.ts'

const execFile = promisify(execFileCb)
export function webUserAgent() {
  const system = platform() === 'win32' ? 'Windows NT 10.0; Win64; x64' : platform() === 'linux' ? 'X11; Linux x86_64' : 'Macintosh; Intel Mac OS X 10_15_7'
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome || '130.0.0.0'} Safari/537.36`
}
const USER_AGENT = webUserAgent()
const TRACKING = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_[ce]id|ref_src|ref_url|campaign|source)$/i

/**
 * Shared metasearch engines for the free index. Yahoo leads because it is the
 * only engine that returns a usable result set on routes where Google,
 * DuckDuckGo, and Startpage answer with bot-mitigation shells that parse to
 * nothing. Brave is excluded because it answers 429 without a key, and Mojeek
 * (403) and Presearch (timeout) never returned a result while still charging
 * their latency to every query.
 */
const DEFAULT_SEARCH_ENGINES = ['yahoo', 'google', 'duckduckgo', 'startpage']

export function searchEngineList() {
  return clean(process.env.WEBSERP_ENGINES) || DEFAULT_SEARCH_ENGINES.join(',')
}

export type WebSearchResult = {
  title: string
  url: string
  snippet: string
  engine: string
  source_class: string
  match: { subject_match?: boolean; clue_coverage?: number; exact_phrase_matches: number; title_exact_phrase_matches: number; matched_terms: number; term_coverage: number; site_match: boolean; confidence: 'direct' | 'lead' }
}
export type RawResult = SearchCandidate
export type WebResource = { body: Buffer; status: number; contentType: string; finalUrl: string }
export type RenderPage = (url: string, options?: { network?: 'configured' | 'direct'; signal?: AbortSignal }) => Promise<{ html: string; finalUrl: string }>
export type FetchResource = (url: string, maxBytes: number, timeoutMs: number, signal?: AbortSignal) => Promise<WebResource>

/**
 * How long one public-web call may run before it is reported as unfinished.
 *
 * A research call that never returns is not a slow answer: the run has nothing to
 * say about it and the person watches a spinner. The bound is generous — a page, its
 * render, and a PDF parse all fit inside it — and a call that reaches it fails with a
 * name, which is a state the run can act on, instead of waiting forever.
 */
export const webCallDeadlineMs = 120_000

/**
 * The bound for one web call, and for the caller's own stop: whichever comes first
 * wins, so a stop is felt while the person is still looking at the run.
 */
export async function withinWebDeadline<T>(
  work: Promise<T>,
  options: { signal?: AbortSignal; ms?: number; message: string },
): Promise<T> {
  const ms = options.ms ?? webCallDeadlineMs, signal = options.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error(options.message)), ms)
    if (!signal) return
    onAbort = () => reject(Error('the run was stopped before this call finished'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work, bound])
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

let proxyPromise: Promise<string> | undefined
let searchCoordinator = new FreeSearchCoordinator()
let searxRegistryCache: { expiresAt: number; urls: string[] } | undefined

export function configureWebSearchPersistence(storageFile: string) {
  searchCoordinator = new FreeSearchCoordinator({ storageFile })
}

function clean(value: unknown) { return String(value || '').replace(/\s+/g, ' ').trim() }
function clamp(value: unknown, fallback: number, min: number, max: number) { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback }
// A read is bounded so one page cannot swallow the whole context, but a normal document —
// an episode list, a report, an archive index — has to fit inside one read or its middle is
// reachable only by guessing an offset. The window is what trims; the cap is what keeps a
// page whole.
export function webReadCharacterLimit(value: unknown) { return clamp(value, 12_000, 1_000, 24_000) }
export function webReadCharacterOffset(value: unknown) { return clamp(value, 0, 0, 10_000_000) }
export function hasExplicitWebReadOffset(value: unknown) {
  return value !== undefined && value !== null && String(value).trim() !== '' && Number.isFinite(Number(value))
}

export function webReadReceipt(output: string, requested: string) {
  try {
    const parsed = JSON.parse(output), requestedUrl = canonicalUrl(requested), content = String(parsed.content || '')
    if (!requestedUrl || parsed.ok !== true || !content.trim()) return null
    const finalUrl = canonicalUrl(parsed.final_url) || requestedUrl, start = Math.max(0, Number(parsed.content_offset) || 0)
    const readable = clean(content.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '').replace(/<[^>]*>/g, ''))
    if (!readable || (readable.length < 200 && /载入中|加载中|loading(?:\s|\.)|please wait/i.test(readable))) return null
    if (isSoftNotFoundSource({ finalUrl, title: String(parsed.title || '') }) || isWebInterstitial(finalUrl, String(parsed.title || ''))) return null
    return {
      requestedUrl, finalUrl, start, end: start + content.length, content,
      title: String(parsed.title || parsed.final_url || requestedUrl),
      contentType: String(parsed.content_type || ''),
      fetchMethod: String(parsed.fetch_method || ''),
      pages: Number(parsed.pages) || undefined,
      searched: Boolean(parsed.search_query),
    }
  } catch { return null }
}
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

export function normalizeWorkspaceCommand(value: unknown, root: string) {
  let command = String(value || '').trim()
  const targets = [root, root.replace(/ /g, '\\ '), `'${root.replace(/'/g, `'\\''`)}'`, `"${root.replace(/"/g, '\\"')}"`]
  for (const target of targets) {
    const next = command.replace(new RegExp(`^cd\\s+${escapeRegex(target)}\\s*&&\\s*`), '')
    if (next !== command) { command = next.trim(); break }
  }
  return command
}

export function canonicalUrl(value: unknown, base?: string) {
  try {
    let url = new URL(String(value || ''), base)
    if (url.hostname.endsWith('google.com') && url.pathname === '/url') {
      const target = url.searchParams.get('q') || url.searchParams.get('url')
      if (target) url = new URL(target)
    }
    if (url.hostname.endsWith('duckduckgo.com') && url.searchParams.get('uddg')) url = new URL(url.searchParams.get('uddg')!)
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key)
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/$/, '')
    return url.href
  } catch { return '' }
}

/**
 * Programmatic-SEO content farms generate a page per query string, so their URLs
 * and titles echo the searcher's own words back and win any word-matching ranking
 * without carrying any evidence. A page that merely mirrors the query is never a
 * source, and demoting the known generators is a quality call every query benefits
 * from — the list names publishing patterns, not topics, and no entry is specific
 * to any one question.
 */
const CONTENT_FARM_PATTERNS: Array<{ host: RegExp; path: RegExp }> = [
  { host: /(?:^|\.)wordplays\.com$/i, path: /\/crossword-solver\//i },
  { host: /(?:^|\.)dwell\.com$/i, path: /\/discover\//i },
  { host: /(?:^|\.)linkedin\.com$/i, path: /\/jobs\//i },
  { host: /(?:^|\.)instagram\.com$/i, path: /\/popular\//i },
]

export function contentFarmPenalty(value: string): number {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase().replace(/^www\./, '')
    return CONTENT_FARM_PATTERNS.some(pattern => pattern.host.test(host) && pattern.path.test(url.pathname)) ? -40 : 0
  } catch { return 0 }
}

export function sourceClass(value: string) {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase(), path = url.pathname.toLowerCase()
    if (/(?:^|\.)(?:github|gitlab)\.com$/i.test(host)) return 'repository_record'
    if (/(?:^|\.)(?:gov|edu)(?:\.|$)|^(?:www\.)?(?:rfc-editor|ietf|iana|openapis)\.org$|^spec\.openapis\.org$/i.test(host) || /\/(?:docs?|documentation|standards?|press|newsroom|investors?|filings?)\//i.test(path)) return 'official_or_primary_candidate'
    if (/(?:^|\.)wikipedia\.org$|baike\.baidu\.com$/i.test(host)) return 'community_or_reference_lead'
    // A social or user-generated post is a mention, not the record of a fact: it can
    // quote a source but is never the source, and it should not lead a read phase.
    if (/(?:zhihu|jianshu\.com|zhidao\.baidu\.com|cnblogs\.com|csdn\.net|reddit|medium\.com|substack\.com|facebook\.com|instagram\.com|pinterest\.|tiktok\.com|twitter\.com|\bx\.com|threads\.net|quora\.com|answers\.)/i.test(host)) return 'community_or_reference_lead'
    return 'other_candidate'
  } catch { return 'other_candidate' }
}

export function sourceSite(value: unknown) {
  try {
    const labels = new URL(canonicalUrl(value)).hostname.toLowerCase().split('.').filter(Boolean)
    return labels.slice(-2).join('.')
  } catch { return '' }
}

function matchText(value: unknown) { return clean(value).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim() }
const chineseWords = new Intl.Segmenter('zh', { granularity: 'word' })
const queryQuestionWords = new Set(['什么', '哪个', '哪些', '如何', '怎么', '为什么', '是否', '使用', '采用', '关于', '有关', '什么时候', '啥时候', '时候', '何时', '几时'])

/** Lexical matching uses words rather than treating a whole Chinese question as one phrase. */
function chineseQueryConcepts(query: string) {
  const chunks = [...new Set(query.replace(/\bsite:[^\s"']+/gi, ' ').replace(/什么时候|啥时候|何时|几时/g, ' ').match(/[\u3400-\u9fff]{2,}/g) || [])]
  return chunks.filter(chunk => !queryQuestionWords.has(chunk)).map(chunk => {
    const words = [...chineseWords.segment(chunk)].map(item => item.segment)
      .filter(word => /^[\u3400-\u9fff]{2,}$/.test(word) && !queryQuestionWords.has(word))
    return { words: words.length ? words : bigrams(chunk) }
  })
}

/** An alternate index query removes interrogative wording, never explicit constraints. */
export function compactDiscoveryQuery(query: string) {
  if (/["“”]/.test(query) || /\bsite:/i.test(query)) return query
  let value = query
  for (const phrase of ['使用什么', '采用什么', '是什么', '叫什么', '请问']) value = value.split(phrase).join(' ')
  return value.replace(/\s+/g, ' ').trim() || query
}

function searchTerms(query: string) {
  const withoutOperators = query.replace(/\bsite:[^\s"']+/gi, ' '), normalized = matchText(withoutOperators.replace(/什么时候|啥时候|何时|几时/g, ' '))
  // Chinese is not word-delimited: chunking a run into fixed-width pieces produces tokens no page
  // contains, so a page about the company scores the same as an unrelated one that shares 「公司」.
  // Two-character pieces are how such a query is matched without shipping a dictionary.
  const cjk = [...normalized.matchAll(/[\u3400-\u9fff]+/g)].flatMap(match => bigrams(match[0]))
  // Preserve words in every script, including short names and numeric versions.
  // An unsupported script used to produce no terms and therefore 100% coverage.
  const words = normalized.replace(/\p{Script=Han}+/gu, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}._+-]*/gu) || []
  return [...new Set([...words, ...cjk])].filter(term => !['site', 'http', 'https', 'www', 'com', 'org', 'net'].includes(term))
}

function containsSearchTerm(text: string, term: string) {
  // A requested version 3 must not match a publication year such as 2023.
  if (/^\d+$/.test(term)) return new RegExp(`(?<!\\p{N})${term}(?!\\p{N})`, 'u').test(text)
  return text.includes(term)
}

/** The overlapping two-character pieces of a run of Chinese, which is what a page can be matched on. */
function bigrams(run: string) {
  if (run.length <= 2) return [run]
  const pieces: string[] = []
  for (let index = 0; index + 2 <= run.length; index++) pieces.push(run.slice(index, index + 2))
  return pieces
}

function subjectForms(value: unknown) { return clean(value).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '') }

/** Every whole label of a host, so a brand label can be compared for equality. */
function hostLabels(value: string) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '').split('.').map(subjectForms).filter(Boolean)
  } catch { return [] }
}

/**
 * A Latin-script query names its subject as a brand, product, or host, so the
 * target resource sits on that subject's own domain. Keyword overlap in a title
 * or snippet makes no such claim, which is exactly how an unrelated article came
 * to be reported as a direct match.
 *
 * A host that merely contains the subject is a different party: `marsgamehk.com`
 * contains `marsgame` and belongs to someone else, and treating it as the target
 * ended discovery before the real site was ever seen. Only a whole host label that
 * equals the subject counts. A shorter name may belong to a different product.
 */
function carriesSubject(url: string, subjects: string[]) {
  return subjects.some(subject => hostLabels(url).some(label => label === subject))
}

/**
 * The leading Latin-script term is the query's subject: `MARSGAME 游戏 官网 海外`
 * and `MarsGame official website` both name the entity in front. Later words
 * describe it (`official`, `website`, `network`) and matching a domain against
 * them would make an unrelated site look like the target, so only the leading
 * qualifying term counts. A query that starts with a short or non-Latin term
 * yields no subject and keeps the lenient title rule below.
 */
function subjectSearchTerms(terms: string[]) {
  const leading = subjectForms(terms[0])
  return leading.length >= 5 && /^[a-z0-9]+$/.test(leading) ? [leading] : []
}

export type SiteConstraint = { host: string; path: string }
type SearchIntent = { sites: SiteConstraint[]; exactPhrases: string[]; terms: string[] }

function siteConstraint(value: unknown): SiteConstraint | null {
  const raw = clean(value).replace(/^site:/i, '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')
  if (!/^[a-z0-9.-]+(?:\/[^\s]*)?$/i.test(raw)) return null
  const slash = raw.indexOf('/'), host = (slash < 0 ? raw : raw.slice(0, slash)).toLowerCase(), path = slash < 0 ? '' : `/${raw.slice(slash + 1)}`
  return host.includes('.') ? { host, path } : null
}

export function searchIntent(queryValue: unknown): SearchIntent {
  const query = clean(queryValue), sites = [...query.matchAll(/\bsite:([^\s"']+)/gi)].map(match => siteConstraint(match[1])).filter((value): value is SiteConstraint => Boolean(value)), exactPhrases = [...query.matchAll(/["“”]([^"“”]{2,200})["“”]/g)].map(match => matchText(match[1])).filter(Boolean)
  return { sites, exactPhrases: [...new Set(exactPhrases)], terms: searchTerms(query) }
}

export function buildSearchQuery(queryValue: unknown, options: { site?: unknown; exactPhrases?: unknown } = {}) {
  const query = clean(queryValue), tokens = [query], existing = searchIntent(query), requestedSite = siteConstraint(options.site)
  if (requestedSite && !existing.sites.some(item => item.host === requestedSite.host && item.path === requestedSite.path)) tokens.push(`site:${requestedSite.host}${requestedSite.path}`)
  const phrases = Array.isArray(options.exactPhrases) ? options.exactPhrases : []
  for (const value of phrases.slice(0, 4)) {
    const phrase = clean(value).replace(/["“”]+/g, '').slice(0, 200)
    if (phrase && !existing.exactPhrases.includes(matchText(phrase))) tokens.push(`"${phrase}"`)
  }
  return clean(tokens.join(' '))
}

function matchesSite(urlValue: string, constraints: SiteConstraint[]) {
  if (!constraints.length) return true
  try {
    const url = new URL(urlValue), host = url.hostname.toLowerCase().replace(/^www\./, '')
    return constraints.some(item => (host === item.host || host.endsWith(`.${item.host}`)) && (!item.path || url.pathname.toLowerCase().startsWith(item.path.toLowerCase())))
  } catch { return false }
}

/**
 * A question about one item of a collection — an episode, a chapter, a track — is answered on
 * the collection's own page, and that page is what a reader would open first. The boost uses
 * only the collection word the question used and the shape of the title.
 */
export function collectionPageBoost(title: string, query: string) {
  const kind = collectionKind(query)
  if (!kind) return 0
  return new RegExp(`^list of\\b.*\\b${kind}\\b`, 'i').test(clean(title)) ? 24 : 0
}

export function rankAndDedupe(query: string, raw: RawResult[], maxResults = 5, diverse = false) {
  const intent = searchIntent(query), subjects = subjectSearchTerms(intent.terms), seen = new Set<string>(), requestedRfc = query.match(/\bRFC\s*(\d{3,5})\b/i)?.[1]
  // Independently supplied Chinese query chunks carry equal weight. Overlapping
  // character pairs still provide recall, but a long name cannot drown out a qualifier.
  const concepts = chineseQueryConcepts(query)
  const ranked = raw.map((item, index) => {
    const resourceTitle = matchText(`${clean(item.title)} ${canonicalUrl(item.url).replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0]}`)
    const conceptText = matchText(`${clean(item.title)} ${clean(item.snippet || item.content)}`)
    const clueCoverage = concepts.map(group => group.words.filter(term => conceptText.includes(term)).length / group.words.length)
    const textSubjectMatch = intent.exactPhrases.length > 0
      ? intent.exactPhrases.some(phrase => conceptText.includes(phrase))
      : /^[\u3400-\u9fff]/.test(query.trim()) && concepts[0]?.words[0]
      ? conceptText.includes(concepts[0].words[0])
      : Boolean(intent.terms.length) && (containsSearchTerm(resourceTitle, intent.terms[0]) || carriesSubject(canonicalUrl(item.url), subjects))
    // An explicitly scoped publisher may use a generic title and opaque article id.
    // A matching snippet is then a discovery lead, even without the subject in its URL.
    const subjectMatch = textSubjectMatch || carriesSubject(canonicalUrl(item.url), subjects) || (intent.sites.length > 0 && matchesSite(canonicalUrl(item.url), intent.sites) &&
      (intent.exactPhrases.length ? intent.exactPhrases.every(phrase => conceptText.includes(phrase)) : Boolean(intent.terms[0]) && containsSearchTerm(conceptText, intent.terms[0])))
    const conceptCoverage = clueCoverage.length ? clueCoverage.reduce((sum, value) => sum + value, 0) / clueCoverage.length : 1
    const resourceCoverage = intent.terms.length ? intent.terms.filter(term => containsSearchTerm(resourceTitle, term)).length / intent.terms.length : 0
    const url = canonicalUrl(item.url), title = clean(item.title), snippet = clean(item.snippet || item.content).slice(0, 420), kind = sourceClass(url), farmPenalty = contentFarmPenalty(url), collectionBoost = collectionPageBoost(title, query), normalizedTitle = matchText(title), haystack = matchText(`${title} ${snippet}`), titleCoverage = intent.terms.length ? intent.terms.filter(term => containsSearchTerm(normalizedTitle, term)).length / intent.terms.length : 0, siteMatch = matchesSite(url, intent.sites), titleExactMatches = intent.exactPhrases.filter(phrase => normalizedTitle.includes(phrase)).length, exactMatches = intent.exactPhrases.filter(phrase => haystack.includes(phrase)).length, matchedTerms = intent.terms.filter(term => containsSearchTerm(haystack, term)).length, coverage = intent.terms.length ? matchedTerms / intent.terms.length : 0, relevant = exactMatches > 0 || matchedTerms > 0, sourceBoost = relevant ? (kind === 'official_or_primary_candidate' ? 5 : kind === 'community_or_reference_lead' ? -2 : 0) : 0, primaryTermInTitle = Boolean(intent.terms.length) && containsSearchTerm(normalizedTitle, intent.terms[0]), subjectDomain = Boolean(subjects.length) && carriesSubject(url, subjects), // A page is a direct match only when it is about what was asked. Measuring coverage over the whole
// page let a brand or marketing page count terms from its own body and call itself the answer, so
// without a site, a quoted phrase, or a subject the title has to carry the leading term and half the
// rest of the query.
      confidence = farmPenalty === 0 && siteMatch && (intent.exactPhrases.length ? titleExactMatches > 0 && exactMatches === intent.exactPhrases.length && conceptCoverage >= 0.75 && (coverage >= 0.75 || intent.sites.length > 0) : intent.sites.length ? relevant && resourceCoverage >= 0.75 : subjects.length ? relevant && subjectDomain : primaryTermInTitle && titleCoverage >= 0.75 && conceptCoverage >= 0.75) ? 'direct' : 'lead', score = (subjectMatch ? 0 : -30) + conceptCoverage * 12 + titleExactMatches * 22 + exactMatches * 10 + matchedTerms * 2 + (primaryTermInTitle ? 6 : 0) + (intent.sites.length && siteMatch ? 10 : 0) + (relevant && subjectDomain ? 24 : 0) + sourceBoost + farmPenalty + collectionBoost + (requestedRfc && new RegExp(`^https://(?:www\\.)?rfc-editor\\.org/rfc/rfc${requestedRfc}(?:\\.html)?$`, 'i').test(url) ? 20 : 0)
    const result = { title, url, snippet, engine: clean(item.engine) || 'unknown', source_class: kind, match: { subject_match: subjectMatch, ...(clueCoverage.length > 1 ? { clue_coverage: Number(Math.min(...clueCoverage).toFixed(3)) } : {}), exact_phrase_matches: exactMatches, title_exact_phrase_matches: titleExactMatches, matched_terms: matchedTerms, term_coverage: Number(Math.min(coverage, conceptCoverage).toFixed(3)), site_match: siteMatch, confidence } } satisfies WebSearchResult
    return { result, score, index, relevant, siteMatch, exactMatches, coverage }
  })
  // Extra query qualifiers must not erase an identified publisher from discovery.
  // A preview can omit a quoted qualification; it remains an unverified lead
  // whose actual page must establish or reject that qualification.
  // Its coverage and confidence still describe a lead, not proof of the requested fact.
  .filter(item => item.result.url && item.result.title && item.siteMatch && item.relevant && (!intent.exactPhrases.length || item.exactMatches > 0 || item.result.match.subject_match || item.coverage >= 0.5) && (intent.terms.length < 4 || item.result.match.subject_match || item.exactMatches > 0 || item.coverage >= 0.25)).sort((a, b) => Number(b.result.match.confidence === 'direct') - Number(a.result.match.confidence === 'direct') || b.score - a.score || b.coverage - a.coverage || a.index - b.index).filter(item => {
    const key = item.result.url.replace(/\/$/, '')
    if (seen.has(key)) return false
    seen.add(key); return true
  }).map(item => item.result)
  const limit = clamp(maxResults, 5, 1, 10)
  return diverse ? diversifySearchResults(ranked, limit) : ranked.slice(0, limit)
}

export function sameSourceHost(left: string, right: string) {
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`)
}

/** Keep the strongest lead, then make room for other matching source hosts. */
export function diversifySearchResults(ranked: WebSearchResult[], limit: number) {
  const hosts = new Set<string>(), selected = new Set<WebSearchResult>()
  for (const row of ranked) {
    const host = new URL(row.url).hostname.replace(/^www\./, '')
    if (selected.size && ([...hosts].some(previous => sameSourceHost(previous, host)) || row.match.subject_match === false)) continue
    hosts.add(host)
    selected.add(row)
    if (selected.size === limit) break
  }
  // Site-specific requests and sparse result sets retain their other pages.
  for (const row of ranked) {
    if (selected.size >= limit) break
    selected.add(row)
  }
  return [...selected]
}

async function systemProxy() {
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (env) return env
  if (platform() !== 'darwin') return ''
  try {
    const { stdout } = await execFile('scutil', ['--proxy'], { timeout: 3000 })
    const text = String(stdout), enabled = /HTTPS?Enable\s*:\s*1/.test(text), host = text.match(/HTTPS?Proxy\s*:\s*(\S+)/)?.[1], port = text.match(/HTTPS?Port\s*:\s*(\d+)/)?.[1]
    return enabled && host && port ? `http://${host}:${port}` : ''
  } catch { return '' }
}

function proxy() { return proxyPromise ||= systemProxy() }

async function executable(path: string) { try { await access(path, constants.X_OK); return true } catch { return false } }

async function webserp(query: string, maxResults: number) {
  const configured = process.env.WEBSERP_BIN, cargo = join(homedir(), '.cargo', 'bin', 'webserp'), binary = configured || await executable(cargo) ? configured || cargo : 'webserp'
  const args = [query, '--engines', searchEngineList(), '--max-results', String(maxResults), '--timeout', '10'], proxyUrl = await proxy()
  if (proxyUrl) args.push('--proxy', proxyUrl)
  const { stdout } = await execFile(binary, args, { timeout: 16000, maxBuffer: 2_000_000 })
  const json = JSON.parse(String(stdout)); return Array.isArray(json.results) ? json.results as RawResult[] : []
}

/**
 * A request should ask for the language of what it is looking for. An engine that is asked for a
 * Chinese query while declaring an English preference answers with a cache of something else
 * entirely — measured directly: a Chinese query came back as a German car-insurance page — and the
 * results then look like a source with no coverage instead of a source that answered the wrong
 * question.
 */
export function acceptLanguageFor(value: unknown) {
  let text = String(value ?? '')
  try { text = decodeURIComponent(text) } catch {}
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text) ? 'zh-CN,zh;q=0.9,en;q=0.8' : 'en-US,en;q=0.8'
}

export function curlTransportArguments(timeoutSeconds: number, maxBytes: number, acceptLanguage = 'en-US,en;q=0.8') {
  return ['--silent', '--show-error', '--location', '--compressed', '--retry', '2', '--retry-all-errors', '--retry-delay', '1', '--http1.1', '--max-time', String(timeoutSeconds), '--max-filesize', String(maxBytes), '--user-agent', USER_AGENT, '--header', `Accept-Language: ${acceptLanguage}`]
}

export function curlTransportFailure(error: unknown) {
  const value = error as { code?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown }
  const diagnostic = String(value.stderr || value.stdout || value.message || error || 'unknown transport failure')
    .replace(/^Command failed:[^\n]*\n?/i, '').replace(/\s+/g, ' ').trim().slice(-700)
  return `curl transport failed${value.code ? ` (${String(value.code)})` : ''}: ${diagnostic}`
}

/**
 * An API-backed index is the only search source that survives anti-bot
 * interstitials and rate limiting, so it leads the provider list whenever a key
 * is configured. The keyless engines stay in the stack as the free fallback.
 */
export function searchApiKey() { return clean(process.env.BRAVE_SEARCH_API_KEY) }

/**
 * Brave Web Search response shape: `web.results[]` carries `title`, `url`, and
 * `description`. Anything else is treated as an empty result set rather than a
 * transport failure, because a keyless fallback still has to run.
 */
export function parseSearchApiResults(payload: unknown): RawResult[] {
  const rows = (payload as { web?: { results?: unknown } } | null)?.web?.results
  if (!Array.isArray(rows)) return []
  return rows.map(item => {
    const row = item as { title?: unknown; url?: unknown; description?: unknown }
    return { title: clean(row.title), url: clean(row.url), content: clean(row.description), engine: 'search-api' } satisfies RawResult
  }).filter(row => row.url)
}

async function searchApi(query: string, maxResults: number): Promise<RawResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(clamp(maxResults, 10, 1, 20)))
  const resource = await curlResource(url.href, 15, 4_000_000, [`X-Subscription-Token: ${searchApiKey()}`])
  if (resource.status < 200 || resource.status >= 300) throw Error(`search API responded ${resource.status}`)
  return parseSearchApiResults(JSON.parse(textDecoder(resource.contentType, resource.body)))
}

const publicHttpPool = new PublicHttpPool()
let connectionWarmup: Promise<unknown> | undefined
/** Connection setup only: no user query or page evidence is fetched ahead of a tool call. */
export function warmWebConnections() {
  if (!connectionWarmup) {
    const origins = [...new Set(fallbackSearchRequests('').filter(item => item.parser === 'bing' || item.parser === 'naver').map(item => new URL(item.url).origin))]
    connectionWarmup = Promise.allSettled(origins.map(origin => pooledResource(`${origin}/robots.txt`, 8, 100_000)))
      .finally(() => { connectionWarmup = undefined })
  }
  return connectionWarmup
}

async function pooledResource(url: string, timeoutSeconds: number, maxBytes: number, signal?: AbortSignal) {
  return publicHttpPool.fetch(url, { timeoutMs: timeoutSeconds * 1000, maxBytes, proxyUrl: await proxy(), signal,
    headers: { 'user-agent': webUserAgent(), 'accept-language': acceptLanguageFor(url) } })
}

async function curlResource(url: string, timeoutSeconds = 20, maxBytes = 20_000_000, headers: string[] = [], signal?: AbortSignal): Promise<WebResource> {
  const parsed = new URL(url)
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw Error('web tools accept public http(s) URLs without embedded credentials')
  const dir = await mkdtemp(join(tmpdir(), 'shun-web-')), bodyPath = join(dir, 'body'), headerPath = join(dir, 'headers')
  try {
    const args = [...curlTransportArguments(timeoutSeconds, maxBytes, acceptLanguageFor(url)), ...headers.flatMap(header => ['--header', header]), '--dump-header', headerPath, '--output', bodyPath, '--write-out', '%{http_code}\n%{content_type}\n%{url_effective}\n%{size_download}', url], proxyUrl = await proxy()
    if (proxyUrl) args.splice(args.length - 1, 0, '--proxy', proxyUrl)
    let stdout = ''
    try { ({ stdout } = await execFile('curl', args, { timeout: (timeoutSeconds + 8) * 1000, maxBuffer: 200_000, signal })) }
    catch (error) { throw Error(curlTransportFailure(error)) }
    const [status, contentType = '', finalUrl = url] = String(stdout).split('\n'), body = await readFile(bodyPath)
    return { body, status: Number(status), contentType, finalUrl }
  } finally { await rm(dir, { recursive: true, force: true }) }
}

function textDecoder(contentType: string, bytes: Buffer) {
  const header = `${contentType}\n${bytes.subarray(0, 16_384).toString('latin1')}`, charset = header.match(/charset\s*=\s*["']?([a-z0-9._-]+)/i)?.[1] || 'utf-8'
  try { return new TextDecoder(charset).decode(bytes) } catch { return new TextDecoder().decode(bytes) }
}

/**
 * A result page rarely links to its results directly: it wraps each one in a redirect on
 * its own host. Dropping those links (because they are not external) discards the results
 * themselves, so the wrapper is unwrapped into the page it points at.
 */
export function unwrapSearchRedirect(value: unknown, base = ''): string {
  const url = canonicalUrl(value, base)
  if (!url) return ''
  try {
    const parsed = new URL(url), host = parsed.hostname.toLowerCase().replace(/^www\./, ''), params = parsed.searchParams
    const direct = (candidate: unknown) => {
      const decoded = canonicalUrl(String(candidate || '').replace(/\s+/g, ''))
      return decoded && !isSearchHost(decoded) ? decoded : ''
    }
    // Google, Yahoo, and several clones put the destination in a query parameter.
    for (const key of ['q', 'url', 'u', 'RU', 'uddg', 'imgurl', 'target']) {
      const value = params.get(key)
      if (!value) continue
      const decoded = direct(decodeURIComponent(value))
      if (decoded) return decoded
    }
    // Bing wraps the destination in its own link format, base64url with a leading marker.
    if (host === 'bing.com' && /^\/ck\/a/.test(parsed.pathname)) {
      const wrapped = params.get('u') || ''
      if (/^a1/i.test(wrapped)) {
        const decoded = direct(decodeBase64Url(wrapped.slice(2)))
        if (decoded) return decoded
      }
    }
    return isSearchHost(url) ? '' : url
  } catch { return '' }
}

/** base64url as it appears inside a redirect wrapper, with its length marker. */
function decodeBase64Url(value: string) {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
    return Buffer.from(padded, 'base64').toString('utf8')
  } catch { return '' }
}

function isSearchHost(value: string) {
  try { return /(^|\.)(?:google|bing|so|naver|duckduckgo|yahoo)\.com$|(^|\.)search\.naver\.com$|(^|\.)r\.bing\.com$/i.test(new URL(value).hostname) } catch { return false }
}

function externalUrl(value: unknown, base: string) {
  // An engine's redirect wrapper carries the result the page is showing; the destination
  // is the result, and the wrapper on the engine's own host is not.
  const unwrapped = unwrapSearchRedirect(value, base)
  if (unwrapped) return unwrapped
  const url = canonicalUrl(value, base)
  if (!url) return ''
  return isSearchHost(url) ? '' : url
}

export function parseSearchAnchors(html: string, base: string, engine: string) {
  const { document } = parseHTML(html), results = new Map<string, { row: RawResult; priority: number }>()
  for (const element of document.querySelectorAll('a[href], [data-url]')) {
    const url = externalUrl(element.getAttribute('href') || element.getAttribute('data-url'), base)
    if (!url) continue
    const heading = element.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"],[class*="-type-headline"]')
    const text = clean(element.textContent || element.getAttribute('aria-label'))
    const title = clean(heading?.textContent || text || element.querySelector('img')?.getAttribute('alt'))
    if (title.length < 3) continue
    const content = clean(element.parentElement?.textContent).slice(0, 420)
    const priority = (element.matches('a[href]') ? 4 : 0) + (heading ? 2 : text ? 1 : 0)
    const previous = results.get(url)
    if (!previous) results.set(url, { row: { title, url, content, engine }, priority })
    else {
      // An index may link its title, image, excerpt and section links to the
      // same page. Keep one title; an excerpt is content, not another title
      // that can win ranking simply by containing more query words.
      if (priority > previous.priority) { previous.row.title = title; previous.priority = priority }
      if (content.length > String(previous.row.content || '').length) previous.row.content = content
    }
  }
  return [...results.values()].map(item => item.row)
}

export type PublicSearchHtml = { google?: string; bing?: string; bingRss?: string; so360?: string; naver?: string }

export function parseFallbackSearch(html: PublicSearchHtml) {
  const results: RawResult[] = []
  if (html.google) {
    const { document } = parseHTML(html.google)
    for (const heading of document.querySelectorAll('a > h3')) { const anchor = heading.parentElement, url = externalUrl(anchor?.getAttribute('href'), 'https://www.google.com'), title = clean(heading.textContent), text = clean(anchor?.parentElement?.parentElement?.textContent); if (url && title) results.push({ title, url, content: text.replace(title, '').slice(0, 420), engine: 'google-html' }) }
    results.push(...parseSearchAnchors(html.google, 'https://www.google.com/search', 'google-html-link'))
  }
  if (html.bing) {
    const { document } = parseHTML(html.bing)
    for (const item of document.querySelectorAll('li.b_algo')) { const anchor = item.querySelector('h2 a'), url = externalUrl(anchor?.getAttribute('href'), 'https://www.bing.com'), title = clean(anchor?.textContent), content = clean(item.querySelector('.b_caption p')?.textContent || item.textContent); if (url && title) results.push({ title, url, content, engine: 'bing-html' }) }
    results.push(...parseSearchAnchors(html.bing, 'https://www.bing.com/search', 'bing-html-link'))
  }
  if (html.bingRss) {
    const document = new DOMParser().parseFromString(html.bingRss, 'text/xml')
    for (const item of document.querySelectorAll('item')) { const title = clean(item.querySelector('title')?.textContent), url = externalUrl(item.querySelector('link')?.textContent, 'https://www.bing.com'), content = clean(item.querySelector('description')?.textContent); if (url && title) results.push({ title, url, content, engine: 'bing-rss' }) }
  }
  if (html.so360) {
    const { document } = parseHTML(html.so360)
    for (const item of document.querySelectorAll('li.res-list')) { const anchor = item.querySelector('h3.res-title a'), url = externalUrl(anchor?.getAttribute('data-mdurl') || anchor?.getAttribute('href'), 'https://www.so.com'), title = clean(anchor?.textContent), content = clean(item.querySelector('p')?.textContent || item.textContent); if (url && title) results.push({ title, url, content, engine: 'so360-html' }) }
  }
  if (html.naver) results.push(...parseSearchAnchors(html.naver, 'https://search.naver.com/', 'naver-html'))
  return results
}

/** Race independent transports and cancel the loser, including a stalled native request. */
export async function firstSuccessfulResource(transports: Array<(signal: AbortSignal) => Promise<WebResource>>, signal?: AbortSignal): Promise<WebResource> {
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    return await Promise.any(transports.map(async transport => {
      combined.throwIfAborted()
      const result = await transport(combined)
      if (result.status < 200 || result.status >= 300) throw Object.assign(Error(`HTTP ${result.status}`), { resource: result })
      return result
    }))
  } finally { controller.abort() }
}

async function searchPage(url: string, fetchResource?: FetchResource, signal?: AbortSignal) {
  const transports = [(abort: AbortSignal) => pooledResource(url, 7, 2_000_000, abort), (abort: AbortSignal) => curlResource(url, 7, 2_000_000, [], abort)]
  if (fetchResource) transports.unshift(abort => fetchResource(url, 2_000_000, 7_000, abort))
  const result = await firstSuccessfulResource(transports, signal)
  return textDecoder(result.contentType, result.body)
}

/**
 * The keyless public indexes, asked for two pages each.
 *
 * One page is a thin slice of any index, and the pages a hard question needs are
 * rarely in the first ten hits; the second page costs one extra request per engine
 * and reuses the same parser, so depth is bought without a second implementation.
 */
export function fallbackSearchRequests(query: string): Array<{ parser: keyof PublicSearchHtml; url: string }> {
  const q = encodeURIComponent(query)
  return [
    { parser: 'google', url: `https://www.google.com/search?q=${q}&num=10&hl=en` },
    { parser: 'google', url: `https://www.google.com/search?q=${q}&num=10&hl=en&start=10` },
    { parser: 'bing', url: `https://www.bing.com/search?q=${q}&count=10&setlang=en` },
    { parser: 'bing', url: `https://www.bing.com/search?q=${q}&count=10&setlang=en&first=11` },
    { parser: 'bingRss', url: `https://www.bing.com/search?q=${q}&format=rss&setlang=en` },
    { parser: 'so360', url: `https://www.so.com/s?q=${q}` },
    { parser: 'so360', url: `https://www.so.com/s?q=${q}&pn=2` },
    { parser: 'naver', url: `https://search.naver.com/search.naver?query=${q}` },
  ]
}

/** Each index page settles independently. A slow engine must not hide another's hits. */
export function publicIndexProviders(fetchResource?: FetchResource, tier = 0, page = 1): SearchProvider[] {
  const descriptors = fallbackSearchRequests('')
  return descriptors.map<SearchProvider>((descriptor, index) => ({
    id: `public-${descriptor.parser}-${index}`,
    tier: tier + (new URL(descriptor.url).searchParams.has('start') || new URL(descriptor.url).searchParams.has('first') || new URL(descriptor.url).searchParams.has('pn') ? 1 : 0),
    timeoutMs: 7_000,
    search: async (query, _limit, signal) => {
      const effectiveQuery = descriptor.parser === 'bingRss' ? compactDiscoveryQuery(query) : query
      const request = fallbackSearchRequests(effectiveQuery)[index]
      const target = new URL(request.url)
      if (page > 1) {
        if (request.parser === 'google') target.searchParams.set('start', String((page - 1) * 10))
        else if (request.parser === 'bing') target.searchParams.set('first', String((page - 1) * 10 + 1))
        else if (request.parser === 'so360') target.searchParams.set('pn', String(page))
      }
      const html = await searchPage(target.href, fetchResource, signal)
      return html ? parseFallbackSearch({ [request.parser]: html } as PublicSearchHtml) : []
    },
  })).filter((_, index) => page === 1 ? [0, 2, 4, 5, 7].includes(index) : [0, 2, 5].includes(index))
}

/**
 * The encyclopedia, asked as a source rather than as a special case.
 *
 * A keyless HTML index matches words, so a question that describes an entity by its
 * constraints ("architect, served in the Second World War, consultant to a
 * broadcaster") comes back as job advertisements and dictionary entries. An
 * encyclopedia is indexed by entity, and its own search answers exactly that shape
 * of question — the same description returns the article about the person. The
 * language follows the query, so a Chinese question is asked in Chinese.
 */
/**
 * The constraint words of a question, without the words that only ask it.
 *
 * An index built around entities answers a description well and a sentence about it
 * badly: interrogatives and connectives dilute the signal, so the same description
 * that returns job advertisements in sentence form returns the person's own article
 * in keyword form. This keeps the terms a publisher would have written.
 */
const QUERY_FILLER_CJK = ['是什么', '是哪些', '有哪些', '是什么名字', '叫什么', '哪些', '哪个', '哪里', '在哪', '为什么', '怎么', '如何', '请问', '的', '和', '与', '以及']

const QUERY_FILLER = new Set(['who', 'whom', 'whose', 'which', 'what', 'when', 'where', 'why', 'how', 'did', 'does', 'do', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'but', 'with', 'from', 'by', 'as', 'that', 'this', 'these', 'those', 'it', 'its', 'his', 'her', 'their', 'them', 'he', 'she', 'they', 'you', 'your', 'also', 'than', 'then', 'there', 'has', 'have', 'had', 'into', 'about', 'over', 'after', 'before', 'during', 'between'])

export function distillQuery(queryValue: unknown) {
  const query = clean(queryValue)
  if (!query) return ''
  const terms = query.split(/[\s,.;:()\[\]{}"“”‘’/]+/).filter(Boolean)
  const distilled = terms.map(term => {
    let value = term
    for (const filler of QUERY_FILLER_CJK) value = value.split(filler).join(' ')
    return value.trim()
  }).filter(term => {
    const bare = term.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    return bare.length > 0 && !QUERY_FILLER.has(bare)
  }).join(' ').replace(/\s+/g, ' ').trim()
  // A query that is already short is already distilled; never hand a source nothing.
  return distilled.length >= 3 ? distilled.slice(0, 300) : query.slice(0, 300)
}

export function wikipediaEndpoint(query: string) {
  return /[\u3400-\u9fff]/.test(query) ? 'zh.wikipedia.org' : 'en.wikipedia.org'
}

/**
 * An encyclopedia's own search is phrasing-sensitive: the same question worded two
 * ways can rank different articles first, so a single distilled query is a coin
 * flip. Asking with a few mechanical reorderings of the query's own words and
 * fusing the rankings buys recall without spending a model turn. Every variant is
 * derived from the query itself — no answer hints and no per-question rules — so
 * the same fan-out applies to a question nobody has seen before.
 */
export function wikipediaQueryVariants(query: string, limit = 4): string[] {
  const distilled = distillQuery(query), words = distilled.split(' ').filter(Boolean)
  const collection = collectionPageQuery(query)
  if (words.length < 4) return [...new Set([distilled, collection].filter(value => value.length >= 3))].slice(0, clamp(limit, 4, 1, 5))
  const entities = words.filter(word => /^[A-Z0-9]/.test(word) || /\d/.test(word)), rest = words.filter(word => !entities.includes(word))
  const reordered = entities.length && entities.length < words.length ? [...entities, ...rest].join(' ') : ''
  const trimmed = words.slice(0, Math.max(3, Math.ceil(words.length / 2))).join(' ')
  return [...new Set([distilled, reordered, trimmed, collection].filter(value => value.length >= 3))].slice(0, clamp(limit, 4, 1, 5))
}

/**
 * A question about one item of a collection — one episode, chapter, track, volume, issue —
 * is answered on the collection page, and an index only reaches that page when it is asked
 * for it in the words such a page is titled with. Every collection word here is the word the
 * question itself used; the subject comes from the question's own terms. Nothing about the
 * subject or the answer is assumed.
 */
export function collectionPageQuery(query: string) {
  const collections: Array<[RegExp, string]> = [
    [/\b(?:episodes?)\b/i, 'episodes'],
    [/\b(?:seasons?)\b/i, 'seasons'],
    [/\b(?:chapters?)\b/i, 'chapters'],
    [/\b(?:tracks?|songs?)\b/i, 'tracks'],
    [/\b(?:volumes?)\b/i, 'volumes'],
    [/\b(?:issues?)\b/i, 'issues'],
    [/\b(?:installments?)\b/i, 'installments'],
    [/\b(?:discograph(?:y|ies))\b/i, 'discography'],
  ]
  const matched = collections.find(([pattern]) => pattern.test(query))
  if (!matched) return ''
  const terms = searchIntent(query).terms.filter(term => term.length > 2)
    .filter(term => !/^(?:list|episode|episodes|season|seasons|chapter|chapters|track|tracks|song|songs|volume|volumes|issue|issues|installment|installments)$/.test(term))
  if (!terms.length) return ''
  return `list of ${terms.slice(0, 3).join(' ')} ${matched[1]}`
}

/** Reciprocal-rank fusion: a page several phrasings agree on outranks a page one phrasing happens to like. */
export function fuseRankedResults(lists: RawResult[][], maxResults: number): RawResult[] {
  const fused = new Map<string, { row: RawResult; score: number }>()
  lists.forEach(rows => rows.forEach((row, rank) => {
    // A parsed candidate carries unknown fields until ranking normalizes them.
    const url = String(row.url || '')
    if (!url) return
    const entry = fused.get(url) || { row, score: 0 }
    entry.score += 1 / (rank + 1)
    fused.set(url, entry)
  }))
  return [...fused.values()].sort((a, b) => b.score - a.score).map(entry => entry.row).slice(0, Math.max(1, maxResults))
}

/**
 * A printed work — a book, a paper, a thesis, a review of one — is not found by the sentences
 * that describe it, but by its bibliographic footprint: its title words, its DOI, the journal
 * that reviewed it. Crossref is the registration agency for that footprint and needs no key,
 * so a research question that names a publication gets a source that indexes publications.
 */
export function parseCrossrefResults(payload: unknown): RawResult[] {
  const items = (payload as { message?: { items?: unknown } } | null)?.message?.items
  if (!Array.isArray(items)) return []
  return items.map((item: any) => {
    const title = clean(Array.isArray(item?.title) ? item.title[0] : item?.title)
    const doi = clean(item?.DOI)
    const container = clean(Array.isArray(item?.['container-title']) ? item['container-title'][0] : item?.['container-title'])
    const year = String(item?.issued?.['date-parts']?.[0]?.[0] || '')
    if (!title || !doi) return null
    // A work this record cites is part of what the record states, and it is usually where the
    // publication a question describes is actually named — the reviewed or referenced title.
    const references = (Array.isArray(item?.reference) ? item.reference : [])
      .map((reference: any) => clean(reference?.article_title || reference?.unstructured || reference?.['volume-title'] || reference?.['series-title']))
      .filter((value: string) => value.length > 3)
    const summary = clean([container, year, doi, item?.abstract ? String(item.abstract).replace(/<[^>]*>/g, ' ') : ''].filter(Boolean).join(' · '))
    const cited = references.length ? `\nCites: ${[...new Set(references)].slice(0, 8).join('; ')}` : ''
    return {
      title,
      url: `https://doi.org/${doi}`,
      content: `${summary}${cited}`.slice(0, 900),
      engine: 'crossref',
    } as RawResult
  }).filter((row): row is RawResult => Boolean(row))
}

/** Crossref's bibliographic query, which matches the words of a work's own record. */
export async function searchCrossref(query: string, maxResults: number, fetchResource?: FetchResource) {
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(distillQuery(query).slice(0, 240))}&rows=${clamp(maxResults, 5, 1, 20)}&select=DOI,title,container-title,issued,abstract,reference&mailto=research@shun.dev`
  try {
    return parseCrossrefResults(JSON.parse(await searchPage(url, fetchResource)))
  } catch { return [] }
}

export function parseWikipediaPageLinks(payload: unknown): string[] {
  const pages = (payload as { query?: { pages?: Record<string, unknown> } } | null)?.query?.pages
  if (!pages || typeof pages !== 'object') return []
  return Object.values(pages).flatMap(page => Array.isArray((page as { links?: unknown }).links)
    ? ((page as { links: Array<{ title?: unknown }> }).links).map(link => clean(link?.title)).filter(Boolean)
    : [])
}

/** The collection word the question itself used, which is the word its collection page is titled with. */
export function collectionKind(query: string) {
  const kinds: Array<[RegExp, string]> = [[/\bepisodes?\b/i, 'episodes'], [/\bchapters?\b/i, 'chapters'], [/\btracks?\b/i, 'tracks'], [/\bvolumes?\b/i, 'volumes'], [/\bissues?\b/i, 'issues'], [/\bseasons?\b/i, 'seasons']]
  return kinds.find(([pattern]) => pattern.test(query))?.[1] || ''
}

/**
 * The page holding one item of a collection is linked from the collection's own article: an
 * episode lives on "List of <series> episodes", a chapter on a book's contents page, a track
 * on the discography. An index only reaches those pages when it is asked in their words, but
 * the article that was already found links to them, so the link is followed once in the same
 * call instead of waiting for a guess at the title.
 */
export function collectionPageLinks(links: string[], query: string, subject: string, limit = 2): string[] {
  const wanted = collectionKind(query)
  if (!wanted) return []
  const subjectWords = subject.toLowerCase().split(/\s+/).filter(word => word.length > 3)
  return links.filter(title => {
    const normalized = title.toLowerCase()
    if (!normalized.startsWith('list of ')) return false
    if (!new RegExp(`\\b${wanted}\\b`).test(normalized)) return false
    // The list has to be about the same subject: "List of AAA Champions" is not the episode
    // list of the series the question is about.
    return !subjectWords.length || subjectWords.filter(word => normalized.includes(word)).length >= Math.min(2, subjectWords.length)
  }).slice(0, limit)
}

async function wikipediaPageLinks(title: string, host: string, fetchResource?: FetchResource) {
  const links: string[] = []
  let cont = ''
  // Two pages of links covers a series article; past that the cost outweighs the reach.
  for (let page = 0; page < 2; page++) {
    const url = `https://${host}/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=links&pllimit=500&plnamespace=0&format=json&origin=*${cont ? `&plcontinue=${encodeURIComponent(cont)}` : ''}`
    const payload = JSON.parse(await searchPage(url, fetchResource))
    links.push(...parseWikipediaPageLinks(payload))
    cont = String((payload as { continue?: { plcontinue?: unknown } })?.continue?.plcontinue || '')
    if (!cont) break
  }
  return links
}

export function parseWikipediaSearch(payload: unknown, query: string): RawResult[] {
  const rows = (payload as { query?: { search?: unknown } } | null)?.query?.search
  if (!Array.isArray(rows)) return []
  return rows.map((row: any) => ({
    title: clean(row?.title),
    url: `https://${wikipediaEndpoint(query)}/wiki/${encodeURIComponent(String(row?.title || '').replace(/ /g, '_'))}`,
    content: clean(String(row?.snippet || '').replace(/<[^>]*>/g, ' ')).slice(0, 300),
    engine: 'wikipedia-search',
  })).filter((row: RawResult) => row.title)
}

async function searchWikipedia(query: string, maxResults: number, fetchResource?: FetchResource) {
  // Two phrasings, in parallel: the coordinator bounds the whole source call, so
  // the fan-out must cost the same wall-clock budget as one request, and parallel
  // requests to a public read API stay well inside its politeness envelope.
  const variants = wikipediaQueryVariants(query, 4)
  const settled = await Promise.allSettled(variants.map(async variant => {
    const host = wikipediaEndpoint(variant)
    const url = `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(variant)}&srlimit=${clamp(maxResults, 8, 1, 20)}&format=json&origin=*`
    return parseWikipediaSearch(JSON.parse(await searchPage(url, fetchResource)), variant)
  }))
  const lists = settled.filter((outcome): outcome is PromiseFulfilledResult<RawResult[]> => outcome.status === 'fulfilled').map(outcome => outcome.value)
  // Every phrasing failing is a source failure and must surface as one; a single
  // bad phrasing must not sink the rankings the other phrasing returned.
  if (!lists.length && settled[0]?.status === 'rejected') throw settled[0].reason
  const fused = fuseRankedResults(lists, maxResults)
  // A question about one item of a collection is answered on the collection page, and the
  // article already found links to it. Following that one link is cheap and mechanical, and
  // it is how a researcher gets from a series to its episode list.
  const kind = collectionKind(query)
  if (kind && fused.length && !fused.some(row => /^list of /i.test(String(row.title || '')))) {
    const host = wikipediaEndpoint(query), subject = subjectSearchTerms(searchIntent(query).terms)[0] || ''
    // A season article links to almost nothing while the series article links to everything,
    // so the first few results are each asked once, in rank order, until the collection shows up.
    for (const candidate of fused.slice(0, 3)) {
      try {
        const links = await wikipediaPageLinks(String(candidate.title || ''), host, fetchResource)
        const wanted = collectionPageLinks(links, query, subject)
        if (!wanted.length) continue
        return [...wanted.map(title => ({
          title,
          url: `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
          content: `${title} — the collection page ${candidate.title} links to for its ${kind}.`,
          engine: 'wikipedia-search-link',
        })), ...fused].slice(0, maxResults)
      } catch {}
    }
  }
  return fused
}

async function searchRendered(query: string, renderPage?: RenderPage, engine: 'google' | 'bing' = 'google') {
  if (!renderPage) return []
  const url = engine === 'google' ? `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=en` : `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10&setlang=en`
  const rendered = await renderPage(url), classified = classifyRenderedSearch(rendered.html, rendered.finalUrl || url, `${engine}-chromium`)
  if (classified.outcome === 'blocked') throw markSourceBlocked(Error(`${engine} answered an anti-bot interstitial instead of results`), `${engine} anti-bot interstitial`)
  return classified.results
}

/**
 * A rendered engine page fails in two very different ways, and collapsing them
 * into one empty result set hides the only signal that changes what the system
 * should do next. A consent or anti-bot interstitial means the channel is
 * unavailable from this network path and must be benched, while a genuinely
 * empty page means the query found nothing and the channel stays healthy.
 */
export function classifyRenderedSearch(html: string, base: string, engine: string): { outcome: 'ok' | 'blocked' | 'empty'; results: RawResult[]; reason?: string } {
  const results = parseSearchAnchors(html, base, engine)
  if (results.length) return { outcome: 'ok', results }
  if (!clean(html)) return { outcome: 'empty', results: [] }
  const body = clean(parseHTML(html).document.body?.textContent || html).slice(0, 4_000), interstitial = isWebChallenge(body) || /before you continue|we use cookies|consent to|not a robot|unusual traffic|verify (?:that )?you are human|enable javascript|javascript is disabled|access denied|are you a robot|请求过于频繁|访问被阻断|安全验证|人机验证/i.test(body)
  return interstitial ? { outcome: 'blocked', results: [], reason: 'anti-bot or consent interstitial instead of results' } : { outcome: 'empty', results: [] }
}

/**
 * A failed fetch is a fact about this machine's network path, and the kind of
 * failure decides what a conclusion may claim: a host that does not resolve from
 * here is not a company without a website, so the two must never be reported as
 * the same thing.
 */
export function transportFailureKind(text: string): 'unresolved' | 'timeout' | 'tls' | 'other' {
  if (/could not resolve|name or service not known|nodename nor servname|curl transport failed \(6\)/i.test(text)) return 'unresolved'
  if (/timed out|timeout|curl transport failed \(28\)/i.test(text)) return 'timeout'
  if (/ssl|tls|certificate|curl transport failed \((?:35|60)\)/i.test(text)) return 'tls'
  return 'other'
}

/**
 * Discovery for an entity question cannot wait for the model to reformulate:
 * seven sequential model turns produced here what two mechanical variants settle
 * in one call. A keyless index returns the subject's own site only when the
 * query still carries the subject, and these variants restate nothing the user
 * did not already say: they drop the descriptive words around the subject.
 */
export function searchQueryVariants(queryValue: unknown, limit = 2) {
  const query = clean(queryValue), intent = searchIntent(query), subject = subjectSearchTerms(intent.terms)[0]
  if (!subject) return []
  // A query that was narrowed with quoted phrases can return nothing at all when the
  // page does not spell the phrase the searcher assumed, so the first thing to try is
  // the same words without the quotes: still the user's own words, just less literal.
  const unquoted = clean(query.replace(/["“”]/g, ' '))
  // The bare subject alone: quoting it adds nothing for a single-token brand and a
  // third variant would only buy more traffic for the same recall.
  return [...new Set([unquoted, subject])].filter(variant => variant && variant !== query).slice(0, Math.max(0, limit))
}

export function parseSearxInstances(value: unknown) {
  const root = value && typeof value === 'object' ? value as Record<string, any> : {}, instances = root.instances && typeof root.instances === 'object' ? root.instances : root
  return Object.entries(instances).map(([url, metadata]) => {
    const item = metadata && typeof metadata === 'object' ? metadata as Record<string, any> : {}, status = Number(item.http?.status_code || item.status_code || 0), rawUptime = Number(item.uptime?.month || item.uptime?.week || item.uptime?.day || 0), uptime = rawUptime > 1 ? rawUptime / 100 : rawUptime, latency = Number(item.timing?.search?.all?.median || item.timing?.search?.all?.mean || item.timing?.initial?.all?.median || 99)
    return { url: canonicalUrl(url), status, uptime, latency, analytics: Boolean(item.analytics) }
  }).filter(item => item.url.startsWith('https://') && !item.url.includes('.onion') && !item.analytics && (!item.status || item.status === 200) && (!item.uptime || item.uptime >= .9)).sort((a, b) => b.uptime - a.uptime || a.latency - b.latency).map(item => item.url)
}

async function searxInstances(fetchResource?: FetchResource) {
  if (searxRegistryCache && searxRegistryCache.expiresAt > Date.now()) return searxRegistryCache.urls
  const json = await searchPage('https://searx.space/data/instances.json', fetchResource), urls = parseSearxInstances(JSON.parse(json))
  searxRegistryCache = { expiresAt: Date.now() + 24 * 60 * 60 * 1_000, urls }
  return urls
}

function stableSelection(value: string, length: number) {
  let hash = 2166136261
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return length ? Math.abs(hash) % length : 0
}

async function searchSearx(query: string, maxResults: number, fetchResource?: FetchResource) {
  const instances = (await searxInstances(fetchResource)).slice(0, 12)
  if (!instances.length) throw Error('no healthy public SearXNG instance is currently available')
  const base = instances[stableSelection(query, instances.length)], endpoint = new URL('search', base.endsWith('/') ? base : `${base}/`), q = encodeURIComponent(query)
  const jsonText = await searchPage(`${endpoint.href}?q=${q}&format=json&language=auto&safesearch=0`, fetchResource).catch(() => '')
  if (jsonText) try {
    const parsed = JSON.parse(jsonText), rows = Array.isArray(parsed.results) ? parsed.results.slice(0, maxResults * 2).map((item: any) => ({ title: item.title, url: item.url, content: item.content, engine: 'searxng-public' } satisfies RawResult)) : []
    if (rows.length) return rows
  } catch {}
  const html = await searchPage(`${endpoint.href}?q=${q}&language=auto&safesearch=0`, fetchResource)
  return parseSearchAnchors(html, endpoint.href, 'searxng-public').slice(0, maxResults * 2)
}

export function parseSiteIndex(html: string, base: string) {
  const { document } = parseHTML(html), results: RawResult[] = []
  for (const anchor of document.querySelectorAll('a[href]')) {
    const url = canonicalUrl(anchor.getAttribute('href'), base), title = clean(anchor.textContent || new URL(url || base).pathname.replace(/[\/_-]+/g, ' ')), content = clean(anchor.parentElement?.textContent).slice(0, 420)
    if (url && title && new URL(url).hostname === new URL(base).hostname) results.push({ title, url, content, engine: 'site-index' })
  }
  return results
}

export function parseSiteSearchDiscovery(html: string, base: string, queryValue: unknown) {
  const { document } = parseHTML(html), query = clean(queryValue).replace(/\bsite:[^\s"']+/gi, ' ').replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim(), descriptors: string[] = [], searches: string[] = []
  for (const link of document.querySelectorAll('link[rel][href]')) {
    const rel = clean(link.getAttribute('rel')).toLowerCase(), type = clean(link.getAttribute('type')).toLowerCase(), url = canonicalUrl(link.getAttribute('href'), base)
    if (url && rel.split(/\s+/).includes('search') && type.includes('opensearchdescription')) descriptors.push(url)
  }
  for (const form of document.querySelectorAll('form[action]')) {
    const action = canonicalUrl(form.getAttribute('action'), base)
    if (!action) continue
    const input = [...form.querySelectorAll('input[name]')].find((element: any) => /^(?:q|query|search|search_query|keyword|text)$/i.test(clean(element.getAttribute('name')))) as any
    const name = clean(input?.getAttribute('name'))
    if (!name) continue
    const url = new URL(action)
    for (const hidden of form.querySelectorAll('input[type="hidden"][name]')) {
      const key = clean(hidden.getAttribute('name')), value = clean(hidden.getAttribute('value'))
      if (key && value) url.searchParams.set(key, value)
    }
    url.searchParams.set(name, query)
    searches.push(url.href)
  }
  return { descriptors: [...new Set(descriptors)].slice(0, 2), searches: [...new Set(searches)].slice(0, 2) }
}

export function parseOpenSearchTemplates(xml: string, base: string, queryValue: unknown) {
  const document = new DOMParser().parseFromString(xml, 'text/xml'), query = encodeURIComponent(clean(queryValue).replace(/\bsite:[^\s"']+/gi, ' ').replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim()), rows: string[] = []
  for (const element of document.querySelectorAll('Url, url')) {
    const type = clean(element.getAttribute('type')).toLowerCase(), raw = clean(element.getAttribute('template'))
    if (!raw || (type && !type.includes('html'))) continue
    const expanded = raw.replace(/\{searchTerms\??\}/gi, query).replace(/\{[^{}]+\?\}/g, '')
    const url = canonicalUrl(expanded.replace(/&amp;/g, '&'), base)
    if (url) rows.push(url)
  }
  return [...new Set(rows)].slice(0, 3)
}

async function searchSiteResults(url: string, query: string, fetchResource?: FetchResource, renderPage?: RenderPage) {
  const attempts: Array<Promise<WebSearchResult[]>> = [searchPage(url, fetchResource).then(html => rankAndDedupe(query, parseSearchAnchors(html, url, 'site-native-search'), 10)).catch(() => [])]
  if (renderPage) attempts.push(renderPage(url).then(rendered => rankAndDedupe(query, parseSearchAnchors(rendered.html, rendered.finalUrl || url, 'site-native-chromium'), 10)).catch(() => []))
  const pending = new Map(attempts.map((attempt, index) => [index, attempt.then(rows => ({ index, rows }))]))
  let ranked: WebSearchResult[] = []
  while (pending.size) {
    const settled = await Promise.race(pending.values())
    pending.delete(settled.index)
    if (settled.rows.length) { ranked = settled.rows; break }
  }
  return ranked.map(row => ({ title: row.title, url: row.url, snippet: row.snippet, engine: row.engine } satisfies RawResult))
}

export async function searchDeclaredSites(query: string, fetchResource?: FetchResource, renderPage?: RenderPage) {
  const domains = searchIntent(query).sites.map(item => item.host).filter(host => !/(?:google|bing|so)\.com$/i.test(host)).slice(0, 2)
  const rows = await Promise.all(domains.map(async host => {
    try {
      const home = `https://${host}/`
      let html = await searchPage(home, fetchResource).catch(() => ''), discovery = parseSiteSearchDiscovery(html, home, query)
      const urls = [...discovery.searches], descriptors = new Set(discovery.descriptors)
      for (const descriptor of descriptors) {
        const xml = await searchPage(descriptor, fetchResource).catch(() => '')
        if (xml) urls.push(...parseOpenSearchTemplates(xml, descriptor, query))
      }
      if (!urls.length && renderPage) try {
        const rendered = await renderPage(home)
        html = rendered.html
        discovery = parseSiteSearchDiscovery(rendered.html, rendered.finalUrl || home, query)
        urls.push(...discovery.searches)
        for (const descriptor of discovery.descriptors) if (!descriptors.has(descriptor)) {
          descriptors.add(descriptor)
          const xml = await searchPage(descriptor, fetchResource).catch(() => '')
          if (xml) urls.push(...parseOpenSearchTemplates(xml, descriptor, query))
        }
      } catch {}
      const searched = (await Promise.all([...new Set(urls)].slice(0, 2).map(url => searchSiteResults(url, query, fetchResource, renderPage)))).flat()
      return searched.length ? searched : parseSiteIndex(html, home)
    } catch { return [] }
  }))
  return rows.flat()
}

export function githubQueryVariants(query: string) {
  if (!/(?:github|openapi|overlay|specification|library|package|repository|source|代码|源码|规范)/i.test(query)) return []
  const cleanQuery = query.replace(/\bsite:github\.com\b/gi, '').replace(/["']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120), variants = [`${cleanQuery} in:name,description`]
  if (/overlay/i.test(query) && /spec(?:ification)?/i.test(query)) variants.unshift('overlay-specification in:name')
  return [...new Set(variants)].slice(0, 2)
}

async function searchGitHubRepositories(query: string) {
  const rows = await Promise.all(githubQueryVariants(query).map(async value => {
    try {
      const resource = await curlResource(`https://api.github.com/search/repositories?q=${encodeURIComponent(value)}&per_page=8`, 10, 2_000_000), json = JSON.parse(textDecoder(resource.contentType, resource.body))
      return (json.items || []).map((item: any) => ({ title: item.full_name, url: item.html_url, content: item.description || '', engine: 'github-repository-search' } satisfies RawResult))
    } catch { return [] }
  }))
  return rows.flat()
}

export type SearchSource = 'web' | 'academic' | 'reference' | 'code'
export type SearchCoverage = 'standard' | 'expanded'

export function searchProviders(options: { sites: SiteConstraint[]; source?: SearchSource; coverage?: SearchCoverage; page?: number; renderPage?: RenderPage; fetchResource?: FetchResource; userBrowser?: (query: string, limit: number) => Promise<RawResult[]> }): SearchProvider[] {
  // With an API key configured, the API leads and every scraper is demoted, so a
  // sufficient API answer never waits on a rendered or rate-limited source.
  const apiConfigured = Boolean(searchApiKey()), freeTier = apiConfigured ? 1 : 0
  const source = options.source || 'web', page = options.page || 1, expanded = options.coverage === 'expanded'
  const indexes = publicIndexProviders(options.fetchResource, freeTier, page)
    .map(provider => ({ ...provider, tier: freeTier + (/public-bing/.test(provider.id) ? 0 : provider.id.startsWith('public-naver') ? 1 : 2) }))
    .sort((left, right) => left.tier - right.tier)
  // Keep HTTP fallbacks available on every machine. The coordinator's evidence
  // check, health tracking and deadline decide which sources need to run.
  // Adapters without pagination must not replay page one into a later-page request.
  if (page > 1) return indexes
  return [
    ...(apiConfigured && page === 1 ? [{ id: 'search-api', tier: 0, timeoutMs: 8_000, search: (value: string, limit: number) => searchApi(value, limit) } satisfies SearchProvider] : []),
    ...indexes,
    ...(source === 'reference' ? [{ id: 'wikipedia-search', tier: freeTier - 1, timeoutMs: 6_000, search: (value: string, limit: number) => searchWikipedia(value, limit, options.fetchResource) } satisfies SearchProvider] : []),
    { id: 'webserp', tier: freeTier + 1, timeoutMs: 7_000, search: (value, limit) => webserp(value, limit) },
    ...(options.sites.length ? [{ id: 'site-native', tier: freeTier, timeoutMs: 8_000, search: (value: string) => searchDeclaredSites(value, options.fetchResource, options.renderPage) } satisfies SearchProvider] : []),
    ...(expanded && options.renderPage ? [{ id: 'chromium-google', tier: freeTier + 4, timeoutMs: 7_000, search: (value: string) => searchRendered(value, options.renderPage, 'google') } satisfies SearchProvider] : []),
    ...(expanded && options.renderPage ? [{ id: 'chromium-bing', tier: freeTier + 3, timeoutMs: 7_000, search: (value: string) => searchRendered(value, options.renderPage, 'bing') } satisfies SearchProvider] : []),
    ...(source === 'academic' ? [{ id: 'crossref', tier: freeTier - 1, timeoutMs: 9_000, search: (value: string, limit: number) => searchCrossref(value, limit, options.fetchResource) } satisfies SearchProvider] : []),
    { id: 'rfc-registry', tier: freeTier, search: async value => [...new Set(value.match(/\bRFC\s*\d{3,5}\b/gi) || [])].map(title => ({ title, url: `https://www.rfc-editor.org/rfc/rfc${title.match(/\d+/)![0]}.html`, content: 'Canonical RFC Editor publication.', engine: 'rfc-registry' })) },
    ...(source === 'code' ? [{ id: 'github-repositories', tier: freeTier - 1, timeoutMs: 7_000, search: (value: string) => searchGitHubRepositories(value) } satisfies SearchProvider] : []),
    { id: 'searxng-federation', tier: freeTier + 2, timeoutMs: 6_000, search: (value, limit) => searchSearx(value, limit, options.fetchResource) },
    // Last, and only when the user turned it on: discovery through their own Chrome, which answers
    // engines that refuse this machine. Its results are labelled with that origin so nothing here
    // presents a session-dependent page as an independent source.
    ...(options.userBrowser ? [{ id: 'user-browser', tier: 3, maxParallel: 1, timeoutMs: 30_000, search: (value: string, limit: number) => options.userBrowser!(value, limit) } satisfies SearchProvider] : []),
  ]
}

/**
 * Search-source health is the product's scheduling state: which source is cooling down, and
 * for how long, is Shun's business. Written into a tool result it comes back as an answer
 * about rate limits and waiting, so the model is told only whether a source answered — the
 * one fact that changes how an empty result should be read.
 */
function providerReport(providers: SearchCoordinationResult['providers'], query: string) {
  return providers.map(provider => ({
    id: provider.id,
    ...(provider.status !== 'cooldown' && provider.id.startsWith('public-bingRss') && compactDiscoveryQuery(query) !== query ? { effective_query: compactDiscoveryQuery(query) } : {}),
    status: provider.status === 'cooldown' ? 'unavailable' : provider.status,
    ...(typeof provider.results === 'number' ? { results: provider.results } : {}),
  }))
}

export async function searchWeb(queryValue: unknown, maxValue?: unknown, options: { depth?: RetrievalDepth; site?: unknown; exactPhrases?: unknown; source?: SearchSource; coverage?: SearchCoverage; page?: number; renderPage?: RenderPage; fetchResource?: FetchResource; providers?: SearchProvider[]; userBrowser?: (query: string, limit: number) => Promise<RawResult[]> } = {}) {
  const query = buildSearchQuery(queryValue, options), profile = retrievalProfile(options.depth), maxResults = clamp(maxValue, profile.maxResults, 1, options.depth === 'fact_lookup' ? profile.maxResults : 10), coverage = options.coverage || profile.coverage
  if (!query) throw Error('search query is required')
  const intent = searchIntent(query)
  const providers = options.providers || searchProviders({ sites: intent.sites, renderPage: options.renderPage, fetchResource: options.fetchResource, userBrowser: options.userBrowser, source: options.source, coverage, page: options.page })
  const sufficient = (candidates: RawResult[]) => {
    const ranked = rankAndDedupe(query, candidates, maxResults)
    const useful = ranked.filter(item => item.match.site_match && item.match.subject_match !== false && item.match.exact_phrase_matches === intent.exactPhrases.length &&
      item.match.term_coverage >= 0.5 && (item.match.clue_coverage === undefined || item.match.clue_coverage >= 0.5) &&
      item.match.matched_terms >= Math.min(2, intent.terms.length))
    if (!useful.length) return false
    if (coverage !== 'expanded') return true
    // An expanded request buys another discovery channel, not a rendered copy of the same index.
    const family = (name: string) => /^(?:public-bing|chromium-bing)/.test(name) ? 'bing'
      : /^(?:public-google|chromium-google)/.test(name) ? 'google' : name
    const channels = new Set(useful.flatMap(item => item.engine.split(',').map(family)))
    return channels.size >= 2 && useful.some(item => !item.engine.split(',').some(name => family(name) === 'bing'))
  }
  const base = searchCoordinator.search(query, maxResults, providers, sufficient, `${profile.depth}:${options.source || 'web'}:${coverage}:${options.page || 1}`, profile.networkTimeoutMs)
  const coordinated = await base
  const candidates = coordinated.results, providerStatus = coordinated.providers, cache = coordinated.cache
  const results = rankAndDedupe(query, candidates, maxResults, true)
  // Query alternatives are suggestions, never extra searches hidden inside this call.
  const suggestedQueries = results.length < 3
    ? [...new Set([
        // A search engine matches words, and the page that states a fact states it in a few of
        // them: a query longer than a handful of words mostly excludes the pages it wanted.
        shortenQuery(query),
        distillQuery(query),
        clean(query.replace(/["“”]/g, ' ')),
      ].map(value => clean(value)).filter(value => value && value.length > 3 && value !== query))].slice(0, 3)
    : []
  const usedUserBrowser = results.some(item => String(item.engine || '').startsWith('user-browser'))
  return JSON.stringify({ query, ...(usedUserBrowser ? { origin_note: 'Results whose engine is user-browser were discovered in the user’s own Chrome session, not in Shun’s public sources: treat them as leads to open, and do not present that session as an independent source.' } : {}), constraints: { sites: intent.sites.map(item => `${item.host}${item.path}`), exact_phrases: intent.exactPhrases }, ...(suggestedQueries.length ? { suggested_queries: suggestedQueries, suggestion_note: 'Few matching leads returned. These optional query variants are unsearched; they may relax constraints.' } : {}), number_of_results: results.length, direct_matches: results.filter(item => item.match.confidence === 'direct').length, retrieval: { depth: profile.depth, cache, coverage, ...(coordinated.deadlineReached ? { discovery_incomplete: true } : {}), expansion_available: coverage === 'standard', providers: providerReport(providerStatus, query) }, evidence_status: 'discovery_only', source: options.source || 'web', page: options.page || 1, results }, null, 2).slice(0, 16_000)
}

export function isWebChallenge(text: string) {
  return /unusual activity|verify (?:that )?you are human|access denied|captcha|checking your browser|security check|enable javascript and cookies|automated access|bot detection|访问超频|当前\s*IP.{0,80}触发安全规则|被暂停服务|访问被阻断|可能对网站造成安全威胁|当前暂时无法访问|当前所在地区暂不支持访问|中国大陆以外的地区.{0,40}暂不支持访问|aliyun_waf|acw_sc__v2/i.test(text)
}

/** An authentication shell is not evidence from the requested article. */
export function isWebInterstitial(url: string, title: string) {
  if (/^(?:安全验证|人机验证|验证中心|security check|verify you are human)$/i.test(title.trim())) return true
  let path = ''
  try { path = new URL(url).pathname } catch { return false }
  return /(?:^|\/)(?:login|signin|unhuman|captcha)(?:\/|$)/i.test(path)
    && (/(?:登录|登入|验证)$/.test(title.trim()) || /^(?:sign in|log in|login)(?:\s+(?:to|with)\b.*)?$/i.test(title.trim()))
}

export type WebPageLink = {
  title: string
  url: string
  matched_terms: number
  term_coverage: number
  /** The fetched page's declared relationship, not a verification of the destination. */
  relationship?: 'declared_official' | 'external_resource'
}

function pageLinks(document: any, base: string, queryValue?: unknown): WebPageLink[] {
  const current = canonicalUrl(base), terms = searchTerms(clean(queryValue)), exact = matchText(queryValue)
  const seen = new Map<string, WebPageLink & { score: number; index: number }>(), ranked: Array<WebPageLink & { score: number; index: number }> = []
  let index = 0
  const add = (urlValue: unknown, titleValue: unknown, relationship?: WebPageLink['relationship']) => {
    const url = canonicalUrl(urlValue, base)
    if (!url || url === current) return
    const title = clean(titleValue || new URL(url).pathname).slice(0, 240)
    if (!title) return
    const normalizedTitle = matchText(title), normalizedUrl = matchText(url), matched = terms.filter(term => normalizedTitle.includes(term) || normalizedUrl.includes(term)).length
    const coverage = terms.length ? matched / terms.length : 1
    const baseScore = (exact && normalizedTitle.includes(exact) ? 100 : 0) + matched * 10 + (terms.length && matched === terms.length ? 20 : 0)
    const previous = seen.get(url)
    if (previous) {
      const previousBase = previous.score - (previous.relationship ? 120 : 0)
      if (baseScore > previousBase) Object.assign(previous, { title, matched_terms: matched, term_coverage: Number(coverage.toFixed(3)) })
      if (relationship && (!previous.relationship || relationship === 'declared_official')) previous.relationship = relationship
      previous.score = Math.max(baseScore, previousBase) + (previous.relationship ? 120 : 0)
      return
    }
    const row = { title, url, matched_terms: matched, term_coverage: Number(coverage.toFixed(3)), ...(relationship ? { relationship } : {}), score: baseScore + (relationship ? 120 : 0), index: index++ }
    seen.set(url, row)
    ranked.push(row)
  }
  for (const element of document.querySelectorAll('a[href]')) {
    const title = clean(element.getAttribute('aria-label') || element.getAttribute('title') || element.querySelector('img')?.getAttribute('alt') || element.textContent)
    const heading = clean(element.closest('section')?.querySelector('h1,h2,h3,h4,h5,h6')?.textContent).replace(/\s*\[edit\]\s*$/i, '')
    const declaredOfficial = /^(?:official\s*(?:web)?site|官方网站|官网|公式サイト|공식\s*(?:웹)?사이트)$/iu.test(title) || Boolean(element.closest('.official-website,.officialwebsite'))
    const externalResource = /^(?:external links|外部链接|外部連結|外部リンク|외부 링크)$/iu.test(heading) && (!terms.length || containsSearchTerm(matchText(title), terms[0]))
    add(element.getAttribute('href'), title, declaredOfficial ? 'declared_official' : externalResource ? 'external_resource' : undefined)
  }
  for (const candidate of embeddedStateLinks(document, base)) add(candidate.url, candidate.title)
  return ranked.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 40).map(({ score: _score, index: _index, ...link }) => link)
}

function embeddedStateLinks(document: any, base: string) {
  const rows: Array<{ title: string; url: string }> = [], seenObjects = new WeakSet<object>()
  let visited = 0
  const text = (value: any, depth = 0): string => {
    if (depth > 4 || value == null) return ''
    if (typeof value === 'string') return clean(value)
    if (Array.isArray(value)) return clean(value.slice(0, 8).map(item => text(item, depth + 1)).join(' '))
    if (typeof value !== 'object') return ''
    if (typeof value.simpleText === 'string') return clean(value.simpleText)
    if (Array.isArray(value.runs)) return clean(value.runs.slice(0, 8).map((item: any) => text(item?.text ?? item, depth + 1)).join(' '))
    return ''
  }
  const url = (value: any, depth = 0): string => {
    if (depth > 5 || !value || typeof value !== 'object') return ''
    for (const key of ['url', 'href', 'canonicalUrl', 'contentUrl']) if (typeof value[key] === 'string') {
      const normalized = canonicalUrl(value[key], base)
      if (normalized) return normalized
    }
    for (const key of ['navigationEndpoint', 'endpoint', 'commandMetadata', 'webCommandMetadata', 'link', 'target']) {
      const nested = url(value[key], depth + 1)
      if (nested) return nested
    }
    return ''
  }
  const walk = (value: any) => {
    if (!value || typeof value !== 'object' || visited++ > 80_000 || seenObjects.has(value)) return
    seenObjects.add(value)
    const target = url(value)
    if (target) {
      const primary = text(value.title) || text(value.name) || text(value.headline) || text(value.label)
      const attribution = text(value.longBylineText) || text(value.shortBylineText) || text(value.byline) || text(value.author) || text(value.publisher) || text(value.owner)
      const title = clean([primary, attribution].filter(Boolean).join(' — '))
      if (title) rows.push({ title, url: target })
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child)
  }
  for (const script of [...document.querySelectorAll('script')].slice(0, 30)) {
    const source = String(script.textContent || '').trim()
    if (!source || source.length > 8_000_000) continue
    const payload = jsonPayload(source)
    if (payload !== undefined) walk(payload)
  }
  return rows
}

function jsonPayload(source: string) {
  const attempts = [source]
  const first = source.search(/[\[{]/)
  if (first > 0) {
    const balanced = balancedJson(source, first)
    if (balanced) attempts.push(balanced)
  }
  for (const value of attempts) try { return JSON.parse(value) } catch {}
  return undefined
}

function balancedJson(source: string, start: number) {
  const open = source[start], stack = [open === '{' ? '}' : ']']
  let quoted = false, escaped = false
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === '{') stack.push('}')
    else if (character === '[') stack.push(']')
    else if (character === stack[stack.length - 1]) {
      stack.pop()
      if (!stack.length) return source.slice(start, index + 1)
    }
  }
  return ''
}

export function extractPageLinks(html: string, base: string, queryValue?: unknown) {
  return pageLinks(parseHTML(html).document, base, queryValue)
}

/**
 * Search engines whose result page is a query, not a document. An agent that wants a
 * second opinion on a query tends to open one, and fetching the engine's own HTML
 * spends a page read on an anti-bot page: the query is the only thing of value in it.
 */
const SEARCH_PAGE_HOSTS = /(?:^|\.)(?:google\.[a-z.]{2,6}|bing\.com|duckduckgo\.com|html\.duckduckgo\.com|lite\.duckduckgo\.com|search\.yahoo\.com|baidu\.com|so\.com|yandex\.[a-z]{2,4}|startpage\.com|ecosia\.org|search\.brave\.com|mojeek\.com|old-search\.marginalia\.nu|search\.marginalia\.nu)$/i

/** The query a search-engine result URL asks, or an empty string when the URL is a page. */
/**
 * A search engine matches words a page contains, so a query longer than a handful of words mostly
 * excludes the pages it was meant to find. The mechanical form of that rule keeps the leading
 * words, because a query leads with its subject.
 */
export function shortenQuery(query: string, maxWords = 6) {
  const words = clean(query).split(' ').filter(Boolean)
  if (words.length <= maxWords) return words.join(' ')
  return words.slice(0, maxWords).join(' ').replace(/[\s,;:.-]+$/, '')
}

export function searchPageQuery(urlValue: unknown) {
  try {
    const url = new URL(String(urlValue || ''))
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    // An encyclopedia's own search API is the same thing in a different shape: the
    // answer to it is the ranked articles, not the JSON envelope around them.
    if (/(?:^|\.)wikipedia\.org$/.test(host) && /\/w\/api\.php$/i.test(url.pathname)) return clean(url.searchParams.get('srsearch')).slice(0, 300)
    if (!SEARCH_PAGE_HOSTS.test(host)) return ''
    for (const key of ['q', 'query', 'p', 'text', 'wd']) {
      const value = clean(url.searchParams.get(key))
      if (value) return value.slice(0, 300)
    }
    return ''
  } catch { return '' }
}

/** A search page read as readable results, so the read budget buys evidence instead of SERP markup. */
export function searchPageResults(query: string, payload: string) {
  let results: Array<{ title?: string; url?: string; snippet?: string; match?: { confidence?: string; term_coverage?: number } }> = []
  let retrieval: { providers?: Array<{ id: string; status: string }> } | undefined
  try {
    const parsed = JSON.parse(payload)
    results = Array.isArray(parsed.results) ? parsed.results : []
    retrieval = parsed.retrieval
  } catch {}
  const lines = results.map((item, index) => [
    `${index + 1}. ${clean(item.url)}${item.match?.confidence ? ` (${item.match.confidence})` : ''}`,
    `   ${clean(item.title)}`,
    item.snippet ? `   ${clean(item.snippet).slice(0, 300)}` : '',
  ].filter(Boolean).join('\n'))
  const content = `Results for the search query "${query}", reached through the search pipeline rather than by fetching the engine page. Open the URLs that carry the answer with web_read; a search page is not evidence.
${lines.join('\n')}`
  return { content, results: results.length, providers: retrieval?.providers }
}

export function needsRenderedLinkDiscovery(readable: { outbound_links?: WebPageLink[]; content?: string }, queryValue?: unknown) {
  const terms = searchTerms(clean(queryValue)), content = matchText(readable.content || '')
  if (terms.length && terms.filter(term => content.includes(term)).length / terms.length >= 0.75) return false
  return Boolean(clean(queryValue)) && !(readable.outbound_links || []).some(link => link.matched_terms > 0)
}

/** Preserve explicit labels and states before graphics and styling are stripped. */
export function preserveTableCellSemantics(document: ReturnType<typeof parseHTML>['document']) {
  const stateAttributes = ['data-appearance', 'data-state', 'data-status', 'data-value', 'data-label', 'data-icon']
  for (const cell of document.querySelectorAll('td,th')) {
    if (clean(cell.textContent)) continue
    const elements = [cell, ...cell.querySelectorAll('*')]
    const labels = elements.map(element => clean(element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title'))).filter(Boolean)
    const states = elements.flatMap(element => stateAttributes.flatMap(attribute => {
      const value = clean(element.getAttribute(attribute))
      return value ? [`[${attribute.slice(5)}: ${value}]`] : []
    }))
    // Keep literal state names: an unknown graphic must never become an
    // invented yes/no value. Existing links and image references remain intact.
    const text = [...new Set(labels.length ? labels : states)].join('; ')
      || (cell.children.length ? '[Non-text cell; meaning unavailable in text]' : '')
    if (text) cell.appendChild(document.createTextNode(text))
  }
}

export async function readableHtml(html: string, url: string, maxChars: number, offset: number, fetchMethod: string, queryValue?: unknown, explicitOffset = false) {
  const { document } = parseHTML(html)
  if (isWebInterstitial(url, document.title || '')) throw Error('page requires sign-in or verification; no source evidence fetched')
  const allLinks = pageLinks(document, url, queryValue)
  const outboundLinks = clean(queryValue) ? allLinks.slice(0, 8) : allLinks
  preserveTableCellSemantics(document)
  // Binary decorations are not page text and must not consume the evidence window.
  for (const image of document.querySelectorAll('img')) {
    if (/^\s*(?:data|blob):/i.test(image.getAttribute('src') || '')) {
      image.replaceWith(document.createTextNode(image.getAttribute('alt') || ''))
    }
  }
  for (const graphic of document.querySelectorAll('svg,canvas')) graphic.replaceWith(document.createTextNode(graphic.textContent || ''))
  for (const element of document.querySelectorAll('meta[property="og:url"],meta[property="twitter:url"],link[rel="canonical"]')) {
    const attribute = element.localName === 'meta' ? 'content' : 'href', value = element.getAttribute(attribute), absolute = canonicalUrl(value, url)
    if (absolute) element.setAttribute(attribute, absolute)
  }
  const fallbackBody = (document.body?.textContent ? document.body : document.documentElement)?.cloneNode(true) as Element | undefined
  for (const hidden of fallbackBody?.querySelectorAll('script,style,noscript,template') || []) hidden.remove()
  const nativeBodyText = clean(fallbackBody?.textContent).slice(0, 20_000)
  let result: any = {}
  try { result = await Defuddle(document, url, { markdown: true, useAsync: false }) }
  catch {}
  const article = String(result.content || result.contentMarkdown || ''), compact = clean(article)
  if (isWebChallenge(`${result.title || ''} ${compact}`)) throw Error('page yielded a bot challenge instead of usable content')
  if (isSoftNotFoundSource({ finalUrl: url, title: String(result.title || '') })) throw new SourceNotFoundError(url, 'soft 404')
  let full = article
  if (!compact || compact.length < 120) {
    const bodyText = nativeBodyText
    if (isWebChallenge(bodyText) || (!bodyText && !outboundLinks.length)) throw Error('page yielded no usable content or links')
    full = [`# ${clean(result.title || document.title || new URL(url).hostname)}`, bodyText].filter(Boolean).join('\n\n')
  }
  return { ok: true, url, fetch_method: fetchMethod, title: result.title || document.title || null, author: result.author || null, published: result.published || null, site: result.site || null, description: result.description || null, word_count: result.wordCount ?? null, outbound_links: outboundLinks, outbound_link_count: allLinks.length, outbound_links_truncated: outboundLinks.length < allLinks.length, ...queryWindow(full, queryValue, maxChars, offset, { title: result.title || document.title, explicitOffset }) }
}

async function renderedReadable(renderPage: RenderPage, url: string, maxChars: number, offset: number, fetchMethod: string, queryValue?: unknown, explicitOffset = false) {
  const modes: Array<'configured' | 'direct'> = (await proxy()) ? ['configured', 'direct'] : ['configured']
  let firstError: unknown
  for (const network of modes) {
    try {
      const rendered = await renderPage(url, { network })
      const readable = await readableHtml(rendered.html, rendered.finalUrl, maxChars, offset, `${fetchMethod}${network === 'direct' ? '-direct' : ''}`, queryValue, explicitOffset)
      return { rendered, readable }
    } catch (error) { firstError ||= error }
  }
  throw firstError || Error('page yielded no usable content')
}

export async function readWeb(urlValue: unknown, maxValue?: unknown, renderPage?: RenderPage, offsetValue?: unknown, fetchResource?: FetchResource, queryValue?: unknown, signal?: AbortSignal, options: { networkTimeoutMs?: number } = {}) {
  signal?.throwIfAborted()
  const requestedUrl = canonicalUrl(urlValue), maxChars = webReadCharacterLimit(maxValue ?? (clean(queryValue) ? 6000 : undefined)), offset = webReadCharacterOffset(offsetValue)
  const explicitOffset = hasExplicitWebReadOffset(offsetValue)
  if (!requestedUrl) throw Error('a valid public http(s) URL is required')
  if (isLoopbackHttpUrl(requestedUrl)) throw Error('Loopback development pages must be inspected with browser_debug, not public web_read.')
  // A search page handed to the reader is a query, not a document: run it through the
  // same discovery pipeline the search tool uses and return readable results, so the
  // read budget buys evidence instead of an anti-bot page.
  const delegatedQuery = searchPageQuery(requestedUrl)
  if (delegatedQuery) {
    const payload = await searchWeb(delegatedQuery, 8, { renderPage, fetchResource })
    const { content, results, providers } = searchPageResults(delegatedQuery, payload)
    return JSON.stringify({
      ok: true,
      requested_url: requestedUrl,
      final_url: requestedUrl,
      status: 200,
      content_type: 'text/x-search-results',
      fetch_method: 'search-pipeline',
      title: `Search results for "${delegatedQuery}"`,
      search_query: delegatedQuery,
      result_count: results,
      ...(providers?.length ? { retrieval: { providers } } : {}),
      ...contentWindow(content, maxChars, offset),
    }, null, 2)
  }
  const networkTimeoutMs = Math.max(10, Math.min(60000, options.networkTimeoutMs ?? 25000))
  if (renderPage) {
    const render = renderPage
    renderPage = async (url, renderOptions) => {
      const controller = new AbortController()
      const renderSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), ...(renderOptions?.signal ? [renderOptions.signal] : [])])
      try {
        return await withinWebDeadline(render(url, { ...renderOptions, signal: renderSignal }), {
          signal: renderSignal, ms: networkTimeoutMs,
          message: 'Rendered source retrieval timed out; source content remains unverified.',
        })
      } finally { controller.abort() }
    }
  }
  let resource: WebResource | undefined
  try {
    const timeout = AbortSignal.timeout(networkTimeoutMs)
    const networkSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    resource = await withinWebDeadline(firstSuccessfulResource([
      signal => pooledResource(requestedUrl, networkTimeoutMs / 1000, 25_000_000, signal),
      signal => curlResource(requestedUrl, networkTimeoutMs / 1000, 25_000_000, [], signal),
      ...(fetchResource ? [(signal: AbortSignal) => fetchResource(requestedUrl, 25_000_000, networkTimeoutMs, signal)] : []),
    ], networkSignal), { signal: networkSignal, ms: networkTimeoutMs,
      message: 'Public HTTP retrieval timed out; source content remains unverified.' }).catch(error => {
      if (timeout.aborted && !signal?.aborted) throw Error('Public HTTP retrieval timed out; source content remains unverified.', { cause: error })
      throw error
    })
  }
  catch (curlError) {
    signal?.throwIfAborted()
    // Keep HTTP status handling (not-found versus a renderable block) after both
    // transports answer with errors. A successful transport always takes precedence.
    if (curlError instanceof AggregateError) {
      const responses = curlError.errors.map(error => error?.resource).filter(Boolean) as WebResource[]
      resource = responses.find(response => response.status === 404 || response.status === 410) || responses[0]
    }
    if (!resource) {
      const github = await readGitHubRepository(requestedUrl, maxChars, offset).catch(() => '')
      if (github) return github
      if (renderPage) try {
        const { rendered, readable } = await renderedReadable(renderPage, requestedUrl, maxChars, offset, 'chromium-after-network-error', queryValue, explicitOffset)
        return JSON.stringify({ requested_url: requestedUrl, final_url: rendered.finalUrl, status: 200, content_type: 'text/html', ...readable }, null, 2)
      } catch {}
      throw curlError
    }
  }
  if (resource.status === 404 || resource.status === 410) throw new SourceNotFoundError(resource.finalUrl, String(resource.status))
  if (resource.status < 200 || resource.status >= 400) {
    if (renderPage && ([401, 403, 407, 408, 418, 423, 425, 429, 451].includes(resource.status) || resource.status >= 500)) {
      try {
        const { rendered, readable } = await renderedReadable(renderPage, resource.finalUrl, maxChars, offset, 'chromium-after-http-block', queryValue, explicitOffset)
        return JSON.stringify({ requested_url: requestedUrl, final_url: rendered.finalUrl, status: resource.status, content_type: resource.contentType, ...readable }, null, 2)
      } catch {}
    }
    throw Error(`HTTP ${resource.status} for ${resource.finalUrl}`)
  }
  const type = resource.contentType.toLowerCase(), looksPdf = type.includes('pdf') || resource.body.subarray(0, 5).toString() === '%PDF-'
  if (looksPdf) return JSON.stringify({ ok: true, requested_url: requestedUrl, final_url: resource.finalUrl, status: resource.status, content_type: resource.contentType, fetch_method: 'binary+pdf', ...(await readPdfBytes(resource.body, { maxChars, offset, query: explicitOffset ? undefined : queryValue })) }, null, 2)
  const looksHtml = type.includes('html') || /<!doctype html|<html|<head|<body/i.test(resource.body.subarray(0, 1024).toString())
  if (looksHtml) {
    const html = textDecoder(resource.contentType, resource.body)
    try {
      const readable = await readableHtml(html, resource.finalUrl, maxChars, offset, 'http', queryValue, explicitOffset)
      if (renderPage && needsRenderedLinkDiscovery(readable, queryValue)) {
        try {
          const rendered = await renderPage(resource.finalUrl), renderedReadable = await readableHtml(rendered.html, rendered.finalUrl, maxChars, offset, 'chromium-link-discovery', queryValue, explicitOffset)
          if (!needsRenderedLinkDiscovery(renderedReadable, queryValue) || (renderedReadable.outbound_links?.length || 0) > (readable.outbound_links?.length || 0)) {
            return JSON.stringify({ requested_url: requestedUrl, final_url: rendered.finalUrl, status: resource.status, content_type: resource.contentType, ...renderedReadable }, null, 2)
          }
        } catch {}
      }
      return JSON.stringify({ requested_url: requestedUrl, final_url: resource.finalUrl, status: resource.status, content_type: resource.contentType, ...readable }, null, 2)
    }
    catch (error) {
      if (!renderPage) throw error
      const { rendered, readable } = await renderedReadable(renderPage, resource.finalUrl, maxChars, offset, 'chromium', queryValue, explicitOffset)
      return JSON.stringify({ requested_url: requestedUrl, final_url: rendered.finalUrl, status: resource.status, content_type: resource.contentType, ...readable }, null, 2)
    }
  }
  const content = textDecoder(resource.contentType, resource.body)
  const window = explicitOffset ? contentWindow(content, maxChars, offset)
    : (type.includes('json') ? jsonRecordWindow(content, queryValue, maxChars, offset) : undefined) ?? queryWindow(content, queryValue, maxChars, offset)
  return JSON.stringify({ ok: true, requested_url: requestedUrl, final_url: resource.finalUrl, status: resource.status, content_type: resource.contentType, fetch_method: 'http', ...window }, null, 2)
}

async function readGitHubRepository(url: string, maxChars: number, offset: number) {
  const parsed = new URL(url), match = parsed.hostname === 'github.com' && parsed.pathname.match(/^\/([^/]+)\/([^/]+?)\/?$/)
  if (!match) return ''
  const [, owner, repository] = match, [metadataResource, readmeResource] = await Promise.all([
    curlResource(`https://api.github.com/repos/${owner}/${repository}`, 15, 2_000_000),
    curlResource(`https://api.github.com/repos/${owner}/${repository}/readme`, 15, 4_000_000).catch(() => null)
  ]), metadata = JSON.parse(textDecoder(metadataResource.contentType, metadataResource.body)), readmeJson = readmeResource ? JSON.parse(textDecoder(readmeResource.contentType, readmeResource.body)) : {}, readme = readmeJson.content ? Buffer.from(String(readmeJson.content).replace(/\s+/g, ''), 'base64').toString('utf8') : '', content = [`# ${metadata.full_name || `${owner}/${repository}`}`, metadata.description || '', readme].filter(Boolean).join('\n\n')
  return JSON.stringify({ ok: true, requested_url: url, final_url: url, status: 200, content_type: 'text/markdown', fetch_method: 'github-api-readme', title: metadata.full_name || `${owner}/${repository}`, author: metadata.owner?.login || owner, site: 'GitHub', published: metadata.created_at || null, ...contentWindow(content, maxChars, offset) }, null, 2)
}
