import { execFile as execFileCb } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Defuddle } from 'defuddle/node'
import { DOMParser, parseHTML } from 'linkedom'
import { isSoftNotFoundSource } from '../shared.ts'
import { contentWindow } from './content-window.ts'
import { readPdfBytes } from './pdf-reader.ts'
import { FreeSearchCoordinator, type SearchCandidate, type SearchProvider } from './web-search-coordinator.ts'
import { isLoopbackHttpUrl } from './browser-debug.ts'

export { contentWindow } from './content-window.ts'
export { pdfPageText, pdfSearchExcerpts } from './pdf-reader.ts'

const execFile = promisify(execFileCb)
export function webUserAgent() {
  const system = platform() === 'win32' ? 'Windows NT 10.0; Win64; x64' : platform() === 'linux' ? 'X11; Linux x86_64' : 'Macintosh; Intel Mac OS X 10_15_7'
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome || '130.0.0.0'} Safari/537.36`
}
const USER_AGENT = webUserAgent()
const TRACKING = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_[ce]id|ref_src|ref_url|campaign|source)$/i

export type WebSearchResult = {
  title: string
  url: string
  snippet: string
  engine: string
  source_class: string
  match: { exact_phrase_matches: number; title_exact_phrase_matches: number; matched_terms: number; term_coverage: number; site_match: boolean; confidence: 'direct' | 'lead' }
}
type RawResult = SearchCandidate
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
export function webReadCharacterLimit(value: unknown) { return clamp(value, 8_000, 1_000, 12_000) }
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

export function sourceClass(value: string) {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase(), path = url.pathname.toLowerCase()
    if (/(?:^|\.)(?:gov|edu)(?:\.|$)|(?:^|\.)(?:github|gitlab)\.com$|^(?:www\.)?(?:rfc-editor|ietf|iana|openapis)\.org$|^spec\.openapis\.org$/i.test(host) || /\/(?:docs?|documentation|standards?|press|newsroom|investors?|filings?)\//i.test(path)) return 'official_or_primary_candidate'
    if (/(?:wikipedia|baike|zhihu|reddit|medium\.com|substack\.com)/i.test(host)) return 'community_or_reference_lead'
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
  return [...new Set([...(normalized.match(/[a-z0-9][a-z0-9._+-]{2,}/g) || []), ...(normalized.match(/[\u3400-\u9fff]{2,8}/g) || [])])].filter(term => !['site', 'http', 'https', 'www', 'com', 'org', 'net'].includes(term))
}

type SiteConstraint = { host: string; path: string }
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

export function rankAndDedupe(query: string, raw: RawResult[], maxResults = 5) {
  const intent = searchIntent(query), seen = new Set<string>(), requestedRfc = query.match(/\bRFC\s*(\d{3,5})\b/i)?.[1]
  return raw.map((item, index) => {
    const url = canonicalUrl(item.url), title = clean(item.title), snippet = clean(item.snippet || item.content).slice(0, 420), kind = sourceClass(url), normalizedTitle = matchText(title), haystack = matchText(`${title} ${snippet}`), siteMatch = matchesSite(url, intent.sites), titleExactMatches = intent.exactPhrases.filter(phrase => normalizedTitle.includes(phrase)).length, exactMatches = intent.exactPhrases.filter(phrase => haystack.includes(phrase)).length, matchedTerms = intent.terms.filter(term => haystack.includes(term)).length, coverage = intent.terms.length ? matchedTerms / intent.terms.length : 1, relevant = exactMatches > 0 || matchedTerms > 0 || (!intent.terms.length && !intent.exactPhrases.length), sourceBoost = relevant ? (kind === 'official_or_primary_candidate' ? 5 : kind === 'community_or_reference_lead' ? -2 : 0) : 0, primaryTermInTitle = !intent.terms.length || normalizedTitle.includes(intent.terms[0]), confidence = siteMatch && (intent.exactPhrases.length ? titleExactMatches > 0 : intent.sites.length ? relevant : primaryTermInTitle && coverage >= 0.5) ? 'direct' : 'lead', score = titleExactMatches * 22 + exactMatches * 10 + matchedTerms * 2 + (primaryTermInTitle ? 6 : 0) + (intent.sites.length && siteMatch ? 10 : 0) + sourceBoost + (requestedRfc && new RegExp(`^https://(?:www\\.)?rfc-editor\\.org/rfc/rfc${requestedRfc}(?:\\.html)?$`, 'i').test(url) ? 20 : 0)
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
  const args = [query, '--engines', 'brave,google,duckduckgo,startpage', '--max-results', String(maxResults), '--timeout', '10'], proxyUrl = await proxy()
  if (proxyUrl) args.push('--proxy', proxyUrl)
  const { stdout } = await execFile(binary, args, { timeout: 16000, maxBuffer: 2_000_000 })
  const json = JSON.parse(String(stdout)); return Array.isArray(json.results) ? json.results as RawResult[] : []
}

export function curlTransportArguments(timeoutSeconds: number, maxBytes: number) {
  return ['--silent', '--show-error', '--location', '--compressed', '--retry', '2', '--retry-all-errors', '--retry-delay', '1', '--http1.1', '--max-time', String(timeoutSeconds), '--max-filesize', String(maxBytes), '--user-agent', USER_AGENT, '--header', 'Accept-Language: en-US,en;q=0.8']
}

export function curlTransportFailure(error: unknown) {
  const value = error as { code?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown }
  const diagnostic = String(value.stderr || value.stdout || value.message || error || 'unknown transport failure')
    .replace(/^Command failed:[^\n]*\n?/i, '').replace(/\s+/g, ' ').trim().slice(-700)
  return `curl transport failed${value.code ? ` (${String(value.code)})` : ''}: ${diagnostic}`
}

async function curlResource(url: string, timeoutSeconds = 20, maxBytes = 20_000_000): Promise<WebResource> {
  const parsed = new URL(url)
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw Error('web tools accept public http(s) URLs without embedded credentials')
  const dir = await mkdtemp(join(tmpdir(), 'shun-web-')), bodyPath = join(dir, 'body'), headerPath = join(dir, 'headers')
  try {
    const args = [...curlTransportArguments(timeoutSeconds, maxBytes), '--dump-header', headerPath, '--output', bodyPath, '--write-out', '%{http_code}\n%{content_type}\n%{url_effective}\n%{size_download}', url], proxyUrl = await proxy()
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

function externalUrl(value: unknown, base: string) {
  const url = canonicalUrl(value, base)
  if (!url) return ''
  try { const host = new URL(url).hostname; return /(^|\.)(?:google|bing|so|naver)\.com$|(^|\.)search\.naver\.com$/i.test(host) ? '' : url } catch { return '' }
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

export function parseFallbackSearch(html: { google?: string; bing?: string; bingRss?: string; so360?: string; naver?: string }) {
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

async function searchFallback(query: string, fetchResource?: FetchResource) {
  const q = encodeURIComponent(query), urls = { so360: `https://www.so.com/s?q=${q}`, bingRss: `https://www.bing.com/search?q=${q}&format=rss&setlang=en`, google: `https://www.google.com/search?q=${q}&num=10&hl=en`, bing: `https://www.bing.com/search?q=${q}&count=10&setlang=en`, naver: `https://search.naver.com/search.naver?query=${q}` }
  const [rows, github] = await Promise.all([
    Promise.all(Object.entries(urls).map(async ([key, url]) => { try { return [key, await searchPage(url, fetchResource)] as const } catch { return [key, ''] as const } })),
    searchGitHubRepositories(query)
  ])
  const rfcs: RawResult[] = [...new Set(query.match(/\bRFC\s*\d{3,5}\b/gi) || [])].map(value => { const number = value.match(/\d+/)![0]; return { title: `RFC ${number}`, url: `https://www.rfc-editor.org/rfc/rfc${number}.html`, content: 'Canonical RFC Editor publication.', engine: 'rfc-registry' } })
  return [...github, ...rfcs, ...parseFallbackSearch(Object.fromEntries(rows))]
}

async function searchRendered(query: string, renderPage?: RenderPage, engine: 'google' | 'bing' = 'google') {
  if (!renderPage) return []
  try {
    const url = engine === 'google' ? `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=en` : `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10&setlang=en`, rendered = await renderPage(url)
    return parseSearchAnchors(rendered.html, rendered.finalUrl || url, `${engine}-chromium`)
  } catch { return [] }
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

export async function searchWeb(queryValue: unknown, maxValue?: unknown, options: { site?: unknown; exactPhrases?: unknown; renderPage?: RenderPage; fetchResource?: FetchResource; providers?: SearchProvider[] } = {}) {
  const query = buildSearchQuery(queryValue, options), maxResults = clamp(maxValue, 5, 1, 10)
  if (!query) throw Error('search query is required')
  const intent = searchIntent(query)
  const providers: SearchProvider[] = options.providers || [
    { id: 'webserp', tier: 0, timeoutMs: 13_000, search: (value, limit) => webserp(value, limit) },
    ...(intent.sites.length ? [{ id: 'site-native', tier: 0, timeoutMs: 16_000, search: (value: string) => searchDeclaredSites(value, options.fetchResource, options.renderPage) } satisfies SearchProvider] : []),
    ...(options.renderPage ? [{ id: 'chromium-google', tier: intent.sites.length ? 1 : 0, timeoutMs: 14_000, search: (value: string) => searchRendered(value, options.renderPage, 'google') } satisfies SearchProvider] : []),
    ...(options.renderPage ? [{ id: 'chromium-bing', tier: 1, timeoutMs: 14_000, search: (value: string) => searchRendered(value, options.renderPage, 'bing') } satisfies SearchProvider] : []),
    { id: 'fallback-indexes', tier: 2, timeoutMs: 14_000, search: value => searchFallback(value, options.fetchResource) },
    { id: 'searxng-federation', tier: 2, timeoutMs: 11_000, search: (value, limit) => searchSearx(value, limit, options.fetchResource) },
  ]
  const coordinated = await searchCoordinator.search(query, maxResults, providers, candidates => {
    const ranked = rankAndDedupe(query, candidates, maxResults)
    return ranked.some(item => item.match.confidence === 'direct')
  })
  const results = rankAndDedupe(query, coordinated.results, maxResults)
  const hasDirect = results.some(item => item.match.confidence === 'direct')
  return JSON.stringify({ query, constraints: { sites: intent.sites.map(item => `${item.host}${item.path}`), exact_phrases: intent.exactPhrases }, number_of_results: results.length, direct_matches: results.filter(item => item.match.confidence === 'direct').length, retrieval: { cache: coordinated.cache, providers: coordinated.providers }, results, ...(!hasDirect ? { instruction: results.length ? 'Only indirect leads were found: their snippets mention the clues, but their URLs are not confirmed as the target. Open the strongest leads and inspect query-ranked outbound links before searching again.' : 'No relevant result satisfied the query constraints across the currently healthy free sources. Report that the exact source could not be verified; do not substitute a merely similar result.' } : {}) }, null, 2).slice(0, 16_000)
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
  return { ok: true, url, fetch_method: fetchMethod, title: result.title || document.title || null, author: result.author || null, published: result.published || null, site: result.site || null, description: result.description || null, word_count: result.wordCount ?? null, outbound_links: outboundLinks, ...contentWindow(full, maxChars, offset) }
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
