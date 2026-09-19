import { execFile as execFileCb } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Defuddle } from 'defuddle/node'
import { DOMParser, parseHTML } from 'linkedom'
import { isSoftNotFoundSource } from '../shared.ts'
import { contentWindow, queryWindow } from './content-window.ts'
import { readPdfBytes } from './pdf-reader.ts'
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
  match: { exact_phrase_matches: number; title_exact_phrase_matches: number; matched_terms: number; term_coverage: number; site_match: boolean; confidence: 'direct' | 'lead' }
}
export type RawResult = SearchCandidate
export type WebResource = { body: Buffer; status: number; contentType: string; finalUrl: string }
export type RenderPage = (url: string, options?: { network?: 'configured' | 'direct' }) => Promise<{ html: string; finalUrl: string }>
export type FetchResource = (url: string, maxBytes: number, timeoutMs: number) => Promise<WebResource>

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
export function webReadReceipt(output: string, requested: string) {
  try {
    const parsed = JSON.parse(output), requestedUrl = canonicalUrl(requested), content = String(parsed.content || '')
    if (!requestedUrl || parsed.ok !== true || !content.trim()) return null
    const finalUrl = canonicalUrl(parsed.final_url) || requestedUrl, start = Math.max(0, Number(parsed.content_offset) || 0)
    if (isSoftNotFoundSource({ finalUrl, title: String(parsed.title || '') })) return null
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
    if (/(?:^|\.)(?:gov|edu)(?:\.|$)|(?:^|\.)(?:github|gitlab)\.com$|^(?:www\.)?(?:rfc-editor|ietf|iana|openapis)\.org$|^spec\.openapis\.org$/i.test(host) || /\/(?:docs?|documentation|standards?|press|newsroom|investors?|filings?)\//i.test(path)) return 'official_or_primary_candidate'
    // An encyclopedia article is the curated record of an entity, not a community
    // mention: a question that describes a person resolves to their article, so
    // demoting it as a lead ranks the answer below the articles that mention it.
    if (/(?:^|\.)wikipedia\.org$|baike\.baidu\.com$/i.test(host)) return 'official_or_primary_candidate'
    // A social or user-generated post is a mention, not the record of a fact: it can
    // quote a source but is never the source, and it should not lead a read phase.
    if (/(?:zhihu|reddit|medium\.com|substack\.com|facebook\.com|instagram\.com|pinterest\.|tiktok\.com|twitter\.com|\bx\.com|threads\.net|quora\.com|answers\.)/i.test(host)) return 'community_or_reference_lead'
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
function searchTerms(query: string) {
  const withoutOperators = query.replace(/\bsite:[^\s"']+/gi, ' '), normalized = matchText(withoutOperators)
  // Chinese is not word-delimited: chunking a run into fixed-width pieces produces tokens no page
  // contains, so a page about the company scores the same as an unrelated one that shares 「公司」.
  // Two-character pieces are how such a query is matched without shipping a dictionary.
  const cjk = [...normalized.matchAll(/[\u3400-\u9fff]+/g)].flatMap(match => bigrams(match[0]))
  return [...new Set([...(normalized.match(/[a-z0-9][a-z0-9._+-]{2,}/g) || []), ...cjk])].filter(term => !['site', 'http', 'https', 'www', 'com', 'org', 'net'].includes(term))
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
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '').split('.').flatMap(label => label.split('-')).filter(Boolean)
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
 * equals the subject counts, plus the documented reverse case where a longer
 * query subject names a shorter brand host.
 */
function carriesSubject(url: string, subjects: string[]) {
  return subjects.some(subject => hostLabels(url).some(label => label === subject || (label.length >= 5 && subject.includes(label))))
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

export function rankAndDedupe(query: string, raw: RawResult[], maxResults = 5) {
  const intent = searchIntent(query), subjects = subjectSearchTerms(intent.terms), seen = new Set<string>(), requestedRfc = query.match(/\bRFC\s*(\d{3,5})\b/i)?.[1]
  return raw.map((item, index) => {
    const url = canonicalUrl(item.url), title = clean(item.title), snippet = clean(item.snippet || item.content).slice(0, 420), kind = sourceClass(url), farmPenalty = contentFarmPenalty(url), collectionBoost = collectionPageBoost(title, query), normalizedTitle = matchText(title), haystack = matchText(`${title} ${snippet}`), titleCoverage = intent.terms.length ? intent.terms.filter(term => matchText(title).includes(term)).length / intent.terms.length : 1, siteMatch = matchesSite(url, intent.sites), titleExactMatches = intent.exactPhrases.filter(phrase => normalizedTitle.includes(phrase)).length, exactMatches = intent.exactPhrases.filter(phrase => haystack.includes(phrase)).length, matchedTerms = intent.terms.filter(term => haystack.includes(term)).length, coverage = intent.terms.length ? matchedTerms / intent.terms.length : 1, relevant = exactMatches > 0 || matchedTerms > 0 || (!intent.terms.length && !intent.exactPhrases.length), sourceBoost = relevant ? (kind === 'official_or_primary_candidate' ? 5 : kind === 'community_or_reference_lead' ? -2 : 0) : 0, primaryTermInTitle = !intent.terms.length || normalizedTitle.includes(intent.terms[0]), subjectDomain = Boolean(subjects.length) && carriesSubject(url, subjects), // A page is a direct match only when it is about what was asked. Measuring coverage over the whole
// page let a brand or marketing page count terms from its own body and call itself the answer, so
// without a site, a quoted phrase, or a subject the title has to carry the leading term and half the
// rest of the query.
      confidence = siteMatch && (intent.exactPhrases.length ? titleExactMatches > 0 : intent.sites.length ? relevant : subjects.length ? relevant && subjectDomain : primaryTermInTitle && titleCoverage >= 0.5) ? 'direct' : 'lead', score = titleExactMatches * 22 + exactMatches * 10 + matchedTerms * 2 + (primaryTermInTitle ? 6 : 0) + (intent.sites.length && siteMatch ? 10 : 0) + (relevant && subjectDomain ? 24 : 0) + sourceBoost + farmPenalty + collectionBoost + (requestedRfc && new RegExp(`^https://(?:www\\.)?rfc-editor\\.org/rfc/rfc${requestedRfc}(?:\\.html)?$`, 'i').test(url) ? 20 : 0)
    const result = { title, url, snippet, engine: clean(item.engine) || 'unknown', source_class: kind, match: { exact_phrase_matches: exactMatches, title_exact_phrase_matches: titleExactMatches, matched_terms: matchedTerms, term_coverage: Number(coverage.toFixed(3)), site_match: siteMatch, confidence } } satisfies WebSearchResult
    return { result, score, index, relevant, siteMatch, exactMatches, coverage }
  }).filter(item => item.result.url && item.result.title && item.siteMatch && item.relevant && (!intent.exactPhrases.length || item.exactMatches > 0 || item.coverage >= 0.5) && (intent.terms.length < 4 || item.exactMatches > 0 || item.coverage >= 0.25)).sort((a, b) => b.score - a.score || b.coverage - a.coverage || a.index - b.index).filter(item => {
    const key = item.result.url.replace(/\/$/, '')
    if (seen.has(key)) return false
    seen.add(key); return true
  }).slice(0, clamp(maxResults, 5, 1, 10)).map(item => item.result)
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

async function curlResource(url: string, timeoutSeconds = 20, maxBytes = 20_000_000, headers: string[] = []): Promise<WebResource> {
  const parsed = new URL(url)
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw Error('web tools accept public http(s) URLs without embedded credentials')
  const dir = await mkdtemp(join(tmpdir(), 'shun-web-')), bodyPath = join(dir, 'body'), headerPath = join(dir, 'headers')
  try {
    const args = [...curlTransportArguments(timeoutSeconds, maxBytes, acceptLanguageFor(url)), ...headers.flatMap(header => ['--header', header]), '--dump-header', headerPath, '--output', bodyPath, '--write-out', '%{http_code}\n%{content_type}\n%{url_effective}\n%{size_download}', url], proxyUrl = await proxy()
    if (proxyUrl) args.splice(args.length - 1, 0, '--proxy', proxyUrl)
    let stdout = ''
    try { ({ stdout } = await execFile('curl', args, { timeout: (timeoutSeconds + 8) * 1000, maxBuffer: 200_000 })) }
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
  const { document } = parseHTML(html), results: RawResult[] = []
  for (const element of document.querySelectorAll('a[href], [data-url]')) {
    const url = externalUrl(element.getAttribute('href') || element.getAttribute('data-url'), base)
    if (!url) continue
    const title = clean(element.querySelector('h3')?.textContent || element.querySelector('img')?.getAttribute('alt') || element.getAttribute('aria-label') || element.textContent), content = clean(element.parentElement?.textContent).slice(0, 420)
    if (title.length >= 3) results.push({ title, url, content, engine })
  }
  return results
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

async function searchPage(url: string, fetchResource?: FetchResource) {
  if (fetchResource) {
    try {
      const result = await fetchResource(url, 2_000_000, 12_000)
      if (result.status >= 200 && result.status < 300) return textDecoder(result.contentType, result.body)
    } catch {}
  }
  const result = await curlResource(url, 12, 2_000_000)
  return result.status >= 200 && result.status < 300 ? textDecoder(result.contentType, result.body) : ''
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

async function searchFallback(query: string, fetchResource?: FetchResource) {
  const [pages, github] = await Promise.all([
    Promise.all(fallbackSearchRequests(query).map(async ({ parser, url }) => {
      try { return { parser, html: await searchPage(url, fetchResource) } } catch { return { parser, html: '' } }
    })),
    searchGitHubRepositories(query)
  ])
  const rfcs: RawResult[] = [...new Set(query.match(/\bRFC\s*\d{3,5}\b/gi) || [])].map(value => { const number = value.match(/\d+/)![0]; return { title: `RFC ${number}`, url: `https://www.rfc-editor.org/rfc/rfc${number}.html`, content: 'Canonical RFC Editor publication.', engine: 'rfc-registry' } })
  const indexed = pages.flatMap(({ parser, html }) => html ? parseFallbackSearch({ [parser]: html } as PublicSearchHtml) : [])
  return [...github, ...rfcs, ...indexed]
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

/** A slow extra pass must never delay an answer that the first pass already supports. */
async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([promise, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs) })])
  } finally { if (timer) clearTimeout(timer) }
}

async function widenSearch(query: string, maxResults: number, providers: SearchProvider[]) {
  const variants = searchQueryVariants(query)
  if (!variants.length) return { variants: [] as string[], candidates: [] as RawResult[], providers: [] as SearchCoordinationResult['providers'], cache: 'miss' as const }
  const subjects = subjectSearchTerms(searchIntent(query).terms)
  const settled = await Promise.all(variants.map(async variant => {
    try {
      const coordinated = await searchCoordinator.search(variant, maxResults, providers, candidates => rankAndDedupe(variant, candidates, maxResults).some(item => item.match.confidence === 'direct'))
      return { variant, ...coordinated }
    } catch { return { variant, results: [] as RawResult[], providers: [] as SearchCoordinationResult['providers'], cache: 'miss' as const } }
  }))
  // The widened pass exists to reach the subject's own domain, so it contributes
  // only results that sit on it. A bare brand term also matches usernames, repos,
  // and videos that merely share the name, and those dilute the evidence the
  // model has to reason with.
  return {
    variants: settled.map(item => item.variant),
    candidates: settled.flatMap(item => item.results).filter(candidate => carriesSubject(canonicalUrl(candidate.url), subjects)),
    providers: settled.flatMap(item => item.providers),
    cache: settled.some(item => item.cache === 'fresh') ? 'fresh' as const : 'miss' as const,
  }
}

const providerStatusSeverity: Record<SearchCoordinationResult['providers'][number]['status'], number> = { blocked: 4, failed: 3, cooldown: 2, ok: 1, empty: 0 }

/** A blocked channel is the most important thing to surface, so the worst status per source wins. */
function mergeProviderStatus(base: SearchCoordinationResult['providers'], extra: SearchCoordinationResult['providers']) {
  const merged = new Map<string, SearchCoordinationResult['providers'][number]>()
  for (const item of [...base, ...extra]) {
    const current = merged.get(item.id)
    if (!current || providerStatusSeverity[item.status] > providerStatusSeverity[current.status]) merged.set(item.id, item)
  }
  return [...merged.values()]
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

export function searchProviders(options: { sites: SiteConstraint[]; renderPage?: RenderPage; fetchResource?: FetchResource; userBrowser?: (query: string, limit: number) => Promise<RawResult[]> }): SearchProvider[] {
  // With an API key configured, the API leads and every scraper is demoted, so a
  // sufficient API answer never waits on a rendered or rate-limited source.
  const apiConfigured = Boolean(searchApiKey()), freeTier = apiConfigured ? 1 : 0
  return [
    ...(apiConfigured ? [{ id: 'search-api', tier: 0, timeoutMs: 8_000, search: (value: string, limit: number) => searchApi(value, limit) } satisfies SearchProvider] : []),
    { id: 'wikipedia-search', tier: freeTier, timeoutMs: 6_000, search: (value, limit) => searchWikipedia(value, limit, options.fetchResource) },
    { id: 'webserp', tier: freeTier, timeoutMs: 7_000, search: (value, limit) => webserp(value, limit) },
    ...(options.sites.length ? [{ id: 'site-native', tier: freeTier, timeoutMs: 8_000, search: (value: string) => searchDeclaredSites(value, options.fetchResource, options.renderPage) } satisfies SearchProvider] : []),
    ...(options.renderPage ? [{ id: 'chromium-google', tier: apiConfigured || options.sites.length ? 1 : 0, timeoutMs: 7_000, search: (value: string) => searchRendered(value, options.renderPage, 'google') } satisfies SearchProvider] : []),
    ...(options.renderPage ? [{ id: 'chromium-bing', tier: 1, timeoutMs: 7_000, search: (value: string) => searchRendered(value, options.renderPage, 'bing') } satisfies SearchProvider] : []),
    { id: 'crossref', tier: freeTier, timeoutMs: 9_000, search: (value, limit) => searchCrossref(value, limit, options.fetchResource) },
    { id: 'fallback-indexes', tier: 2, timeoutMs: 7_000, search: value => searchFallback(value, options.fetchResource) },
    { id: 'searxng-federation', tier: 2, timeoutMs: 6_000, search: (value, limit) => searchSearx(value, limit, options.fetchResource) },
    // Last, and only when the user turned it on: discovery through their own Chrome, which answers
    // engines that refuse this machine. Its results are labelled with that origin so nothing here
    // presents a session-dependent page as an independent source.
    ...(options.userBrowser ? [{ id: 'user-browser', tier: 3, timeoutMs: 30_000, search: (value: string, limit: number) => options.userBrowser!(value, limit) } satisfies SearchProvider] : []),
  ]
}

/**
 * Search-source health is the product's scheduling state: which source is cooling down, and
 * for how long, is Shun's business. Written into a tool result it comes back as an answer
 * about rate limits and waiting, so the model is told only whether a source answered — the
 * one fact that changes how an empty result should be read.
 */
function providerReport(providers: SearchCoordinationResult['providers']) {
  return providers.map(provider => ({
    id: provider.id,
    status: provider.status === 'cooldown' ? 'unavailable' : provider.status,
    ...(typeof provider.results === 'number' ? { results: provider.results } : {}),
  }))
}

export async function searchWeb(queryValue: unknown, maxValue?: unknown, options: { site?: unknown; exactPhrases?: unknown; renderPage?: RenderPage; fetchResource?: FetchResource; providers?: SearchProvider[]; userBrowser?: (query: string, limit: number) => Promise<RawResult[]> } = {}) {
  const query = buildSearchQuery(queryValue, options), maxResults = clamp(maxValue, 5, 1, 10)
  if (!query) throw Error('search query is required')
  const intent = searchIntent(query), subjects = subjectSearchTerms(intent.terms)
  const providers = options.providers || searchProviders({ sites: intent.sites, renderPage: options.renderPage, fetchResource: options.fetchResource, userBrowser: options.userBrowser })
  const sufficient = (candidates: RawResult[]) => rankAndDedupe(query, candidates, maxResults).some(item => item.match.confidence === 'direct')
  const base = searchCoordinator.search(query, maxResults, providers, sufficient)
  const coordinated = await base
  let candidates = [...coordinated.results], providerStatus = [...coordinated.providers], cache = coordinated.cache, widenedWith: string[] = []
  // The variant pass runs only after the first pass settles, and only when the
  // subject was not reached: free sources are shared, and an optional extra query
  // contending with the required one both bursts the source and delays the answer.
  if (!sufficient(candidates) && searchQueryVariants(query).length) {
    const widened = await settleWithin(widenSearch(query, maxResults, providers), 6_000)
    if (widened && (widened.candidates.length || widened.providers.length)) {
      widenedWith = widened.variants
      candidates = [...candidates, ...widened.candidates]
      providerStatus = mergeProviderStatus(providerStatus, widened.providers)
      if (widened.cache === 'fresh') cache = 'fresh'
    }
  }
  const results = rankAndDedupe(query, candidates, maxResults)
  const hasDirect = results.some(item => item.match.confidence === 'direct')
  // A narrow query that found little is the common failure: the words are so specific that no
  // page matches them, and the run then repeats the same shape. The receipt carries the broader
  // forms of the same question instead, so widening costs no extra request and no extra turn.
  const suggestedQueries = results.length < 3
    ? [...new Set([
        // A search engine matches words, and the page that states a fact states it in a few of
        // them: a query longer than a handful of words mostly excludes the pages it wanted.
        shortenQuery(query),
        distillQuery(query),
        clean(query.replace(/["“”]/g, ' ')),
        subjectSearchTerms(intent.terms)[0] || '',
      ].map(value => clean(value)).filter(value => value && value.length > 3 && value !== query))].slice(0, 3)
    : []
  // A partial answer that names its own confidence is more useful than a refusal,
  // and it is the only shape that stays honest when a source was unreachable.
  const instruction = hasDirect ? undefined : results.length
    ? 'Only indirect leads were found: their snippets mention the clues, but their URLs are not confirmed as the target. Open the strongest lead when that can settle the target; if it cannot, answer the question with the best-supported reading, state how strongly the evidence supports it, and name the single check that would settle it. Never present a merely similar site as the target.'
    : 'No result satisfied the query constraints across the currently healthy sources. Answer with the best-supported reading from all evidence gathered so far, state what stays unverified and the single check that would settle it, and name any source that was unreachable from this network path. Do not answer with a bare refusal, and never present a merely similar site as the target.'
  const usedUserBrowser = results.some(item => String(item.engine || '').startsWith('user-browser'))
  return JSON.stringify({ query, ...(usedUserBrowser ? { origin_note: 'Results whose engine is user-browser were discovered in the user’s own Chrome session, not in Shun’s public sources: treat them as leads to open, and do not present that session as an independent source.' } : {}), constraints: { sites: intent.sites.map(item => `${item.host}${item.path}`), exact_phrases: intent.exactPhrases }, ...(suggestedQueries.length ? { suggested_queries: suggestedQueries, suggestion_note: 'This query returned little because its words are too specific for any page to carry them. Search again with one of these broader forms before concluding.' } : {}), number_of_results: results.length, direct_matches: results.filter(item => item.match.confidence === 'direct').length, retrieval: { cache, providers: providerReport(providerStatus), ...(widenedWith.length ? { widened_with: widenedWith } : {}) }, ...(widenedWith.length ? { widening: { queries_tried: widenedWith, note: 'Automatic query widening already ran inside this call; do not repeat these as separate searches.' } } : {}), results, ...(instruction ? { instruction } : {}) }, null, 2).slice(0, 16_000)
}

export function isWebChallenge(text: string) {
  return /unusual activity|verify (?:that )?you are human|access denied|captcha|checking your browser|security check|enable javascript and cookies|automated access|bot detection|访问超频|当前\s*IP.{0,80}触发安全规则|被暂停服务|访问被阻断|可能对网站造成安全威胁|当前暂时无法访问|当前所在地区暂不支持访问|中国大陆以外的地区.{0,40}暂不支持访问|aliyun_waf|acw_sc__v2/i.test(text)
}

export type WebPageLink = {
  title: string
  url: string
  matched_terms: number
  term_coverage: number
}

function pageLinks(document: any, base: string, queryValue?: unknown): WebPageLink[] {
  const current = canonicalUrl(base), terms = searchTerms(clean(queryValue)), exact = matchText(queryValue)
  const seen = new Set<string>(), ranked: Array<WebPageLink & { score: number; index: number }> = []
  let index = 0
  const add = (urlValue: unknown, titleValue: unknown) => {
    const url = canonicalUrl(urlValue, base)
    if (!url || url === current || seen.has(url)) return
    seen.add(url)
    const title = clean(titleValue || new URL(url).pathname).slice(0, 240)
    if (!title) return
    const normalizedTitle = matchText(title), normalizedUrl = matchText(url), matched = terms.filter(term => normalizedTitle.includes(term) || normalizedUrl.includes(term)).length
    const coverage = terms.length ? matched / terms.length : 1
    ranked.push({ title, url, matched_terms: matched, term_coverage: Number(coverage.toFixed(3)), score: (exact && normalizedTitle.includes(exact) ? 100 : 0) + matched * 10 + (terms.length && matched === terms.length ? 20 : 0), index: index++ })
  }
  for (const element of document.querySelectorAll('a[href]')) {
    add(element.getAttribute('href'), element.getAttribute('aria-label') || element.getAttribute('title') || element.querySelector('img')?.getAttribute('alt') || element.textContent)
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

export function needsRenderedLinkDiscovery(readable: { outbound_links?: WebPageLink[] }, queryValue?: unknown) {
  return Boolean(clean(queryValue)) && !(readable.outbound_links || []).some(link => link.matched_terms > 0)
}

async function readableHtml(html: string, url: string, maxChars: number, offset: number, fetchMethod: string, queryValue?: unknown) {
  const { document } = parseHTML(html)
  const outboundLinks = pageLinks(document, url, queryValue)
  for (const element of document.querySelectorAll('meta[property="og:url"],meta[property="twitter:url"],link[rel="canonical"]')) {
    const attribute = element.localName === 'meta' ? 'content' : 'href', value = element.getAttribute(attribute), absolute = canonicalUrl(value, url)
    if (absolute) element.setAttribute(attribute, absolute)
  }
  let result: any = {}
  try { result = await Defuddle(document, url, { markdown: true, useAsync: false }) }
  catch {}
  const article = String(result.content || result.contentMarkdown || ''), compact = clean(article)
  if (isWebChallenge(`${result.title || ''} ${compact}`)) throw Error('page yielded a bot challenge instead of usable content')
  if (isSoftNotFoundSource({ finalUrl: url, title: String(result.title || '') })) throw Error('resource-not-found (soft 404); rediscover the current canonical URL')
  let full = article
  if (!compact || compact.length < 120) {
    if (!fetchMethod.startsWith('chromium')) throw Error('page yielded no usable article content')
    const bodyText = clean(document.body?.textContent).slice(0, 20_000)
    if (isWebChallenge(bodyText) || (!bodyText && !outboundLinks.length)) throw Error('page yielded no usable content or links')
    full = [`# ${clean(result.title || document.title || new URL(url).hostname)}`, bodyText].filter(Boolean).join('\n\n')
  }
  return { ok: true, url, fetch_method: fetchMethod, title: result.title || document.title || null, author: result.author || null, published: result.published || null, site: result.site || null, description: result.description || null, word_count: result.wordCount ?? null, outbound_links: outboundLinks, ...queryWindow(full, queryValue, maxChars, offset) }
}

async function renderedReadable(renderPage: RenderPage, url: string, maxChars: number, offset: number, fetchMethod: string, queryValue?: unknown) {
  const modes: Array<'configured' | 'direct'> = (await proxy()) ? ['configured', 'direct'] : ['configured']
  let firstError: unknown
  for (const network of modes) {
    try {
      const rendered = await renderPage(url, { network })
      const readable = await readableHtml(rendered.html, rendered.finalUrl, maxChars, offset, `${fetchMethod}${network === 'direct' ? '-direct' : ''}`, queryValue)
      return { rendered, readable }
    } catch (error) { firstError ||= error }
  }
  throw firstError || Error('page yielded no usable content')
}

export async function readWeb(urlValue: unknown, maxValue?: unknown, renderPage?: RenderPage, offsetValue?: unknown, fetchResource?: FetchResource, queryValue?: unknown) {
  const requestedUrl = canonicalUrl(urlValue), maxChars = webReadCharacterLimit(maxValue), offset = webReadCharacterOffset(offsetValue)
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
  let resource: WebResource | undefined
  try { resource = await curlResource(requestedUrl, 25, 25_000_000) }
  catch (curlError) {
    if (fetchResource) try { resource = await fetchResource(requestedUrl, 25_000_000, 25_000) } catch {}
    if (!resource) {
      const github = await readGitHubRepository(requestedUrl, maxChars, offset).catch(() => '')
      if (github) return github
      if (renderPage) try {
        const { rendered, readable } = await renderedReadable(renderPage, requestedUrl, maxChars, offset, 'chromium-after-network-error', queryValue)
        return JSON.stringify({ requested_url: requestedUrl, final_url: rendered.finalUrl, status: 200, content_type: 'text/html', ...readable }, null, 2)
      } catch {}
      throw curlError
    }
  }
  if (resource.status === 404 || resource.status === 410) throw Error(`resource-not-found (${resource.status}); rediscover the current canonical URL`)
  if (resource.status < 200 || resource.status >= 400) {
    if (renderPage && ([401, 403, 407, 408, 418, 423, 425, 429, 451].includes(resource.status) || resource.status >= 500)) {
      try {
        const { rendered, readable } = await renderedReadable(renderPage, resource.finalUrl, maxChars, offset, 'chromium-after-http-block', queryValue)
        return JSON.stringify({ requested_url: requestedUrl, final_url: rendered.finalUrl, status: resource.status, content_type: resource.contentType, ...readable }, null, 2)
      } catch {}
    }
    throw Error(`HTTP ${resource.status} for ${resource.finalUrl}`)
  }
  const type = resource.contentType.toLowerCase(), looksPdf = type.includes('pdf') || resource.body.subarray(0, 5).toString() === '%PDF-'
  if (looksPdf) return JSON.stringify({ ok: true, requested_url: requestedUrl, final_url: resource.finalUrl, status: resource.status, content_type: resource.contentType, fetch_method: 'binary+pdf', ...(await readPdfBytes(resource.body, { maxChars, offset, query: queryValue })) }, null, 2)
  const looksHtml = type.includes('html') || /<!doctype html|<html|<head|<body/i.test(resource.body.subarray(0, 1024).toString())
  if (looksHtml) {
    const html = textDecoder(resource.contentType, resource.body)
    try {
      const readable = await readableHtml(html, resource.finalUrl, maxChars, offset, 'curl', queryValue)
      if (renderPage && needsRenderedLinkDiscovery(readable, queryValue)) {
        try {
          const rendered = await renderPage(resource.finalUrl), renderedReadable = await readableHtml(rendered.html, rendered.finalUrl, maxChars, offset, 'chromium-link-discovery', queryValue)
          if (!needsRenderedLinkDiscovery(renderedReadable, queryValue) || (renderedReadable.outbound_links?.length || 0) > (readable.outbound_links?.length || 0)) {
            return JSON.stringify({ requested_url: requestedUrl, final_url: rendered.finalUrl, status: resource.status, content_type: resource.contentType, ...renderedReadable }, null, 2)
          }
        } catch {}
      }
      return JSON.stringify({ requested_url: requestedUrl, final_url: resource.finalUrl, status: resource.status, content_type: resource.contentType, ...readable }, null, 2)
    }
    catch (error) {
      if (!renderPage) throw error
      const { rendered, readable } = await renderedReadable(renderPage, resource.finalUrl, maxChars, offset, 'chromium', queryValue)
      return JSON.stringify({ requested_url: requestedUrl, final_url: rendered.finalUrl, status: resource.status, content_type: resource.contentType, ...readable }, null, 2)
    }
  }
  const content = textDecoder(resource.contentType, resource.body)
  return JSON.stringify({ ok: true, requested_url: requestedUrl, final_url: resource.finalUrl, status: resource.status, content_type: resource.contentType, fetch_method: 'curl', ...contentWindow(content, maxChars, offset) }, null, 2)
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
