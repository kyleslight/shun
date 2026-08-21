import { execFile as execFileCb } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Defuddle } from 'defuddle/node'
import { DOMParser, parseHTML } from 'linkedom'
import { isSoftNotFoundSource } from '../shared.ts'

const execFile = promisify(execFileCb)
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36'
const TRACKING = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_[ce]id|ref_src|ref_url|campaign|source)$/i

export type WebSearchResult = { title: string; url: string; snippet: string; engine: string; source_class: string }
type RawResult = { title?: unknown; url?: unknown; content?: unknown; snippet?: unknown; engine?: unknown }
export type WebResource = { body: Buffer; status: number; contentType: string; finalUrl: string }
export type RenderPage = (url: string) => Promise<{ html: string; finalUrl: string }>
export type FetchResource = (url: string, maxBytes: number, timeoutMs: number) => Promise<WebResource>

let proxyPromise: Promise<string> | undefined

function clean(value: unknown) { return String(value || '').replace(/\s+/g, ' ').trim() }
function clamp(value: unknown, fallback: number, min: number, max: number) { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback }
export function webReadCharacterLimit(value: unknown) { return clamp(value, 8_000, 1_000, 12_000) }
export function webReadCharacterOffset(value: unknown) { return clamp(value, 0, 0, 10_000_000) }
export function contentWindow(content: string, maxChars: number, offset: number, knownHasMore = false) {
  const value = content.slice(offset, offset + maxChars), end = offset + value.length, hasMore = knownHasMore || end < content.length
  return { content_offset: offset, content_end: end, content_characters: content.length, returned_characters: value.length, truncated: offset > 0 || hasMore, has_more: hasMore, content: value }
}
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

function terms(query: string) { return [...new Set([...(query.toLowerCase().match(/[a-z0-9][a-z0-9._+-]{2,}/g) || []), ...(query.match(/[\u3400-\u9fff]{2,8}/g) || [])])] }

export function rankAndDedupe(query: string, raw: RawResult[], maxResults = 5) {
  const queryTerms = terms(query), seen = new Set<string>(), requestedRfc = query.match(/\bRFC\s*(\d{3,5})\b/i)?.[1]
  return raw.map((item, index) => {
    const url = canonicalUrl(item.url), title = clean(item.title), snippet = clean(item.snippet || item.content).slice(0, 420), kind = sourceClass(url), haystack = `${title} ${snippet}`.toLowerCase()
    const score = queryTerms.reduce((sum, term) => sum + (haystack.includes(term.toLowerCase()) ? 2 : 0), 0) + (kind === 'official_or_primary_candidate' ? 5 : kind === 'community_or_reference_lead' ? -2 : 0) + (requestedRfc && new RegExp(`^https://(?:www\\.)?rfc-editor\\.org/rfc/rfc${requestedRfc}(?:\\.html)?$`, 'i').test(url) ? 20 : 0)
    return { result: { title, url, snippet, engine: clean(item.engine) || 'unknown', source_class: kind } satisfies WebSearchResult, score, index }
  }).filter(item => item.result.url && item.result.title && (item.score > 0 || !queryTerms.length)).sort((a, b) => b.score - a.score || a.index - b.index).filter(item => {
    const key = item.result.url.replace(/[?].*$/, '').replace(/\/$/, '')
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
  try {
    const { stdout } = await execFile(binary, args, { timeout: 16000, maxBuffer: 2_000_000 })
    const json = JSON.parse(String(stdout)); return Array.isArray(json.results) ? json.results as RawResult[] : []
  } catch { return [] }
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
  try { const host = new URL(url).hostname; return /(^|\.)(?:google|bing|so)\.com$/i.test(host) ? '' : url } catch { return '' }
}

export function parseFallbackSearch(html: { google?: string; bing?: string; bingRss?: string; so360?: string }) {
  const results: RawResult[] = []
  if (html.google) {
    const { document } = parseHTML(html.google)
    for (const heading of document.querySelectorAll('a > h3')) { const anchor = heading.parentElement, url = externalUrl(anchor?.getAttribute('href'), 'https://www.google.com'), title = clean(heading.textContent), text = clean(anchor?.parentElement?.parentElement?.textContent); if (url && title) results.push({ title, url, content: text.replace(title, '').slice(0, 420), engine: 'google-html' }) }
  }
  if (html.bing) {
    const { document } = parseHTML(html.bing)
    for (const item of document.querySelectorAll('li.b_algo')) { const anchor = item.querySelector('h2 a'), url = externalUrl(anchor?.getAttribute('href'), 'https://www.bing.com'), title = clean(anchor?.textContent), content = clean(item.querySelector('.b_caption p')?.textContent || item.textContent); if (url && title) results.push({ title, url, content, engine: 'bing-html' }) }
  }
  if (html.bingRss) {
    const document = new DOMParser().parseFromString(html.bingRss, 'text/xml')
    for (const item of document.querySelectorAll('item')) { const title = clean(item.querySelector('title')?.textContent), url = externalUrl(item.querySelector('link')?.textContent, 'https://www.bing.com'), content = clean(item.querySelector('description')?.textContent); if (url && title) results.push({ title, url, content, engine: 'bing-rss' }) }
  }
  if (html.so360) {
    const { document } = parseHTML(html.so360)
    for (const item of document.querySelectorAll('li.res-list')) { const anchor = item.querySelector('h3.res-title a'), url = externalUrl(anchor?.getAttribute('data-mdurl') || anchor?.getAttribute('href'), 'https://www.so.com'), title = clean(anchor?.textContent), content = clean(item.querySelector('p')?.textContent || item.textContent); if (url && title) results.push({ title, url, content, engine: 'so360-html' }) }
  }
  return results
}

async function searchFallback(query: string) {
  const q = encodeURIComponent(query), urls = { so360: `https://www.so.com/s?q=${q}`, bingRss: `https://www.bing.com/search?q=${q}&format=rss&setlang=en`, google: `https://www.google.com/search?q=${q}&num=10&hl=en`, bing: `https://www.bing.com/search?q=${q}&count=10&setlang=en` }
  const [rows, site, github] = await Promise.all([
    Promise.all(Object.entries(urls).map(async ([key, url]) => { try { const result = await curlResource(url, 12, 2_000_000); return [key, result.status >= 200 && result.status < 300 ? textDecoder(result.contentType, result.body) : ''] as const } catch { return [key, ''] as const } })),
    searchDeclaredSites(query),
    searchGitHubRepositories(query)
  ])
  const rfcs: RawResult[] = [...new Set(query.match(/\bRFC\s*\d{3,5}\b/gi) || [])].map(value => { const number = value.match(/\d+/)![0]; return { title: `RFC ${number}`, url: `https://www.rfc-editor.org/rfc/rfc${number}.html`, content: 'Canonical RFC Editor publication.', engine: 'rfc-registry' } })
  return [...site, ...github, ...rfcs, ...parseFallbackSearch(Object.fromEntries(rows))]
}

export function parseSiteIndex(html: string, base: string) {
  const { document } = parseHTML(html), results: RawResult[] = []
  for (const anchor of document.querySelectorAll('a[href]')) {
    const url = canonicalUrl(anchor.getAttribute('href'), base), title = clean(anchor.textContent || new URL(url || base).pathname.replace(/[\/_-]+/g, ' ')), content = clean(anchor.parentElement?.textContent).slice(0, 420)
    if (url && title && new URL(url).hostname === new URL(base).hostname) results.push({ title, url, content, engine: 'site-index' })
  }
  return results
}

async function searchDeclaredSites(query: string) {
  const domains = [...new Set(query.match(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|gov|edu|io|dev)\b/gi) || [])].filter(host => !/(?:google|bing|so)\.com$/i.test(host)).slice(0, 2)
  const rows = await Promise.all(domains.map(async host => { try { const result = await curlResource(`https://${host}/`, 10, 2_000_000); return result.status >= 200 && result.status < 400 ? parseSiteIndex(textDecoder(result.contentType, result.body), result.finalUrl) : [] } catch { return [] } }))
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

export async function searchWeb(queryValue: unknown, maxValue?: unknown) {
  const query = clean(queryValue), maxResults = clamp(maxValue, 5, 1, 10)
  if (!query) throw Error('search query is required')
  const primary = await webserp(query, maxResults), fallback = primary.length < maxResults ? await searchFallback(query) : [], results = rankAndDedupe(query, [...primary, ...fallback], maxResults)
  return JSON.stringify({ query, number_of_results: results.length, results }, null, 2).slice(0, 16_000)
}

function challenge(text: string) { return /unusual activity|verify (?:that )?you are human|access denied|captcha|checking your browser|security check|enable javascript and cookies|automated access|bot detection/i.test(text) }

export function pdfSearchExcerpts(pages: string[], queryValue: unknown, maxChars: number) {
  const query = clean(queryValue), phrase = query.toLowerCase(), terms = [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{1,}|[\u3400-\u9fff]{2,}/g) || [])]
  if (!query || !terms.length) return null
  const scored = pages.map((text, index) => {
    const lower = text.toLowerCase()
    const hits = terms.map(term => ({ term, at: lower.indexOf(term), count: lower.split(term).length - 1 })).filter(hit => hit.at >= 0)
    const score = hits.reduce((sum, hit) => sum + Math.min(8, hit.count), 0) + (lower.includes(phrase) ? 20 : 0) + (hits.length === terms.length ? 8 : 0)
    const anchor = hits.sort((a, b) => a.at - b.at)[0]?.at ?? -1
    return { page: index + 1, text, score, anchor }
  }).filter(page => page.score > 0).sort((a, b) => b.score - a.score || a.page - b.page)
  if (!scored.length) return { query, matched_pages: [] as number[], total_matching_pages: 0, content: '' }
  const chunks: string[] = [], matched: number[] = []
  for (const item of scored.slice(0, 8)) {
    const allowance = Math.max(700, Math.min(3_200, maxChars - chunks.join('').length - 80))
    if (allowance < 700) break
    const start = Math.max(0, item.anchor - Math.floor(allowance * .35)), excerpt = item.text.slice(start, start + allowance).trim()
    chunks.push(`--- Page ${item.page}${start ? ` (excerpt starts at character ${start})` : ''} ---\n${excerpt}`)
    matched.push(item.page)
  }
  return { query, matched_pages: matched, total_matching_pages: scored.length, content: chunks.join('\n\n').slice(0, maxChars) }
}

async function readableHtml(html: string, url: string, maxChars: number, offset: number, fetchMethod: string) {
  const { document } = parseHTML(html)
  for (const element of document.querySelectorAll('meta[property="og:url"],meta[property="twitter:url"],link[rel="canonical"]')) {
    const attribute = element.localName === 'meta' ? 'content' : 'href', value = element.getAttribute(attribute), absolute = canonicalUrl(value, url)
    if (absolute) element.setAttribute(attribute, absolute)
  }
  const result = await Defuddle(document, url, { markdown: true, useAsync: false }), full = String(result.content || result.contentMarkdown || ''), compact = clean(full)
  if (!compact || compact.length < 120 || challenge(`${result.title || ''} ${compact}`)) throw Error('page yielded no usable article content')
  if (isSoftNotFoundSource({ finalUrl: url, title: String(result.title || '') })) throw Error('resource-not-found (soft 404); rediscover the current canonical URL')
  return { ok: true, url, fetch_method: fetchMethod, title: result.title || null, author: result.author || null, published: result.published || null, site: result.site || null, description: result.description || null, word_count: result.wordCount ?? null, ...contentWindow(full, maxChars, offset) }
}

async function readablePdf(bytes: Buffer, maxChars: number, offset: number, query?: unknown) {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'), document = await pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false }).promise
    let content = '', pagesRead = 0
    const pageTexts: string[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages && (query || content.length <= offset + maxChars); pageNumber++) { const page = await document.getPage(pageNumber), text = await page.getTextContent(), pageText = text.items.map(item => 'str' in item ? item.str : '').join(' '); pageTexts.push(pageText); content += `${pageNumber > 1 ? `\n\n--- Page ${pageNumber} ---\n` : ''}${pageText}`; pagesRead = pageNumber }
    const metadata: any = await document.getMetadata().catch(() => null)
    const matches = pdfSearchExcerpts(pageTexts, query, maxChars)
    if (matches) {
      if (!matches.content) throw Error(`PDF query "${matches.query}" matched no pages among ${document.numPages}. Refine the query.`)
      return { pages: document.numPages, pages_read: pagesRead, title: metadata?.info?.Title || null, author: metadata?.info?.Author || null, search_query: matches.query, matched_pages: matches.matched_pages, total_matching_pages: matches.total_matching_pages, ...contentWindow(matches.content, maxChars, 0, matches.total_matching_pages > matches.matched_pages.length) }
    }
    return { pages: document.numPages, pages_read: pagesRead, title: metadata?.info?.Title || null, author: metadata?.info?.Author || null, ...contentWindow(content, maxChars, offset, pagesRead < document.numPages) }
  } catch (firstError) {
    const dir = await mkdtemp(join(tmpdir(), 'shun-pdf-')), path = join(dir, 'source.pdf')
    try {
      await writeFile(path, bytes)
      const [{ stdout }, info] = await Promise.all([execFile('pdftotext', ['-layout', path, '-'], { timeout: 30000, maxBuffer: 10_000_000 }), execFile('pdfinfo', [path], { timeout: 10000, maxBuffer: 200_000 }).catch(() => ({ stdout: '' }))]), content = String(stdout), pages = Number(String(info.stdout).match(/^Pages:\s+(\d+)/m)?.[1]) || null, matches = pdfSearchExcerpts(content.split('\f'), query, maxChars)
      if (matches) {
        if (!matches.content) throw Error(`PDF query "${matches.query}" matched no pages among ${pages || content.split('\f').length}. Refine the query.`)
        return { pages, title: String(info.stdout).match(/^Title:\s+(.+)$/m)?.[1]?.trim() || null, author: String(info.stdout).match(/^Author:\s+(.+)$/m)?.[1]?.trim() || null, search_query: matches.query, matched_pages: matches.matched_pages, total_matching_pages: matches.total_matching_pages, ...contentWindow(matches.content, maxChars, 0, matches.total_matching_pages > matches.matched_pages.length) }
      }
      return { pages, title: String(info.stdout).match(/^Title:\s+(.+)$/m)?.[1]?.trim() || null, author: String(info.stdout).match(/^Author:\s+(.+)$/m)?.[1]?.trim() || null, ...contentWindow(content, maxChars, offset) }
    } catch { throw firstError } finally { await rm(dir, { recursive: true, force: true }) }
  }
}

export async function readWeb(urlValue: unknown, maxValue?: unknown, renderPage?: RenderPage, offsetValue?: unknown, fetchResource?: FetchResource, queryValue?: unknown) {
  const requestedUrl = canonicalUrl(urlValue), maxChars = webReadCharacterLimit(maxValue), offset = webReadCharacterOffset(offsetValue)
  if (!requestedUrl) throw Error('a valid public http(s) URL is required')
  let resource: WebResource | undefined
  try { resource = await curlResource(requestedUrl, 25, 25_000_000) }
  catch (curlError) {
    if (fetchResource) try { resource = await fetchResource(requestedUrl, 25_000_000, 25_000) } catch {}
    if (!resource) {
      const github = await readGitHubRepository(requestedUrl, maxChars, offset).catch(() => '')
      if (github) return github
      if (renderPage) try { const rendered = await renderPage(requestedUrl); return JSON.stringify({ requested_url: requestedUrl, final_url: rendered.finalUrl, status: 200, content_type: 'text/html', ...(await readableHtml(rendered.html, rendered.finalUrl, maxChars, offset, 'chromium-after-network-error')) }, null, 2) } catch {}
      throw curlError
    }
  }
  if (resource.status === 404 || resource.status === 410) throw Error(`resource-not-found (${resource.status}); rediscover the current canonical URL`)
  if (resource.status < 200 || resource.status >= 400) {
    if (renderPage && [401, 403, 429].includes(resource.status)) {
      try {
        const rendered = await renderPage(resource.finalUrl), readable = await readableHtml(rendered.html, rendered.finalUrl, maxChars, offset, 'chromium-after-http-block')
        return JSON.stringify({ requested_url: requestedUrl, final_url: rendered.finalUrl, status: resource.status, content_type: resource.contentType, ...readable }, null, 2)
      } catch {}
    }
    throw Error(`HTTP ${resource.status} for ${resource.finalUrl}`)
  }
  const type = resource.contentType.toLowerCase(), looksPdf = type.includes('pdf') || resource.body.subarray(0, 5).toString() === '%PDF-'
  if (looksPdf) return JSON.stringify({ ok: true, requested_url: requestedUrl, final_url: resource.finalUrl, status: resource.status, content_type: resource.contentType, fetch_method: 'binary+pdf', ...(await readablePdf(resource.body, maxChars, offset, queryValue)) }, null, 2)
  const looksHtml = type.includes('html') || /<!doctype html|<html|<head|<body/i.test(resource.body.subarray(0, 1024).toString())
  if (looksHtml) {
    const html = textDecoder(resource.contentType, resource.body)
    try { return JSON.stringify({ requested_url: requestedUrl, final_url: resource.finalUrl, status: resource.status, content_type: resource.contentType, ...(await readableHtml(html, resource.finalUrl, maxChars, offset, 'curl')) }, null, 2) }
    catch (error) {
      if (!renderPage) throw error
      const rendered = await renderPage(resource.finalUrl)
      return JSON.stringify({ requested_url: requestedUrl, final_url: rendered.finalUrl, status: resource.status, content_type: resource.contentType, ...(await readableHtml(rendered.html, rendered.finalUrl, maxChars, offset, 'chromium')) }, null, 2)
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
