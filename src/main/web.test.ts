import assert from 'node:assert/strict'
import test from 'node:test'
import { compactDiscoveryQuery, firstSuccessfulResource, publicIndexProviders, acceptLanguageFor, buildSearchQuery, canonicalUrl, classifyRenderedSearch, contentFarmPenalty, distillQuery, fuseRankedResults, parseCrossrefResults, queryWindow, shortenQuery, searchPageQuery, searchPageResults, wikipediaQueryVariants, fallbackSearchRequests, parseWikipediaSearch, sourceClass, wikipediaEndpoint, contentWindow, curlTransportArguments, curlTransportFailure, extractPageLinks, githubQueryVariants, isWebChallenge, needsRenderedLinkDiscovery, normalizeWorkspaceCommand, parseFallbackSearch, parseOpenSearchTemplates, parseSearchAnchors, parseSearchApiResults, parseSearxInstances, parseSiteIndex, parseSiteSearchDiscovery, pdfPageText, pdfSearchExcerpts, rankAndDedupe, readWeb, searchDeclaredSites, searchEngineList, searchIntent, searchProviders, searchQueryVariants, searchWeb, sourceSite, transportFailureKind, webReadCharacterLimit, webReadCharacterOffset, webReadReceipt, withinWebDeadline } from './web.ts'

test('canonicalUrl removes tracking and unwraps search redirects', () => {
  assert.equal(canonicalUrl('https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fguide%2F%3Futm_source%3Dsearch%26x%3D1'), 'https://example.com/guide?x=1')
  assert.equal(canonicalUrl('javascript:alert(1)'), '')
})

test('web reads stay bounded for small-model context windows', () => {
  // A normal document has to fit inside one read, or its middle is reachable only by
  // guessing an offset: the default holds an episode list and the cap holds a report.
  assert.equal(webReadCharacterLimit(undefined), 12_000)
  assert.equal(webReadCharacterLimit(40_000), 24_000)
  assert.equal(webReadCharacterLimit(500), 1_000)
  assert.equal(webReadCharacterOffset(undefined), 0)
  assert.equal(webReadCharacterOffset(12_000), 12_000)
  assert.equal(webReadCharacterOffset(676_626), 676_626)
  assert.equal(webReadCharacterOffset(-1), 0)
})

test('public web reading routes loopback pages to the local browser tool before network access', async () => {
  await assert.rejects(() => readWeb('http://localhost:5174/'), /browser_debug.*public web_read/i)
})

test('a web call that never returns is reported, and a stopped run is felt at once', async () => {
  // The failure this bound exists for: a call whose promise never settles. Reporting it is what
  // turns an unbounded wait into a state the run can act on instead of a spinner that never ends.
  await assert.rejects(
    () => withinWebDeadline(new Promise(() => {}), { ms: 20, message: 'the read of that page did not finish' }),
    /did not finish/,
  )
  assert.equal(await withinWebDeadline(Promise.resolve('page'), { ms: 1_000, message: 'unused' }), 'page')
  // A stop does not wait for the bound: the person is already looking at the run.
  const control = new AbortController()
  const stopped = withinWebDeadline(new Promise(() => {}), { signal: control.signal, message: 'unused' })
  control.abort()
  await assert.rejects(() => stopped, /stopped before this call finished/)
  const already = new AbortController()
  already.abort()
  await assert.rejects(
    () => withinWebDeadline(new Promise(() => {}), { signal: already.signal, message: 'unused' }),
    /stopped before this call finished/,
  )
})

test('web transport retries TLS failures and returns the actual diagnostic', () => {
  const args = curlTransportArguments(25, 25_000_000)
  assert.deepEqual(args.slice(args.indexOf('--retry'), args.indexOf('--max-time')), ['--retry', '2', '--retry-all-errors', '--retry-delay', '1', '--http1.1'])
  assert.equal(curlTransportFailure({ code: 35, stderr: 'curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL\n' }), 'curl transport failed (35): curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL')
  assert.doesNotMatch(curlTransportFailure({ message: 'Command failed: curl --secret internal\ncurl: (28) timeout' }), /--secret/)
})

test('Chinese enterprise-registry WAF pages are challenges rather than usable evidence', () => {
  assert.equal(isWebChallenge('当前IP在使用过程中触发安全规则，被暂停服务。'), true)
  assert.equal(isWebChallenge('由于您访问的链接有可能对网站造成安全威胁，您的访问被阻断。'), true)
  assert.equal(isWebChallenge('上海无尽梦科技有限公司是一家科技企业。'), false)
})

test('long PDF search returns bounded page-numbered evidence instead of the document head', () => {
  const result = pdfSearchExcerpts([
    'cover and table of contents',
    'Space Launch System overview without costs',
    'Artemis SLS Orion request is 7.2 billion dollars with schedule details',
    'appendix',
  ], 'Artemis SLS Orion cost', 2_000)
  assert.deepEqual(result?.matched_pages, [3, 2])
  assert.match(result?.content || '', /--- Page 3 ---[\s\S]*7\.2 billion/)
  assert.doesNotMatch(result?.content || '', /cover and table/)
})

test('PDF text reconstruction preserves visual line order and word spacing', () => {
  const text = pdfPageText([
    { str: '42.50', width: 30, height: 12, transform: [12, 0, 0, 12, 180, 680] },
    { str: 'Invoice', width: 40, height: 12, transform: [12, 0, 0, 12, 72, 700] },
    { str: 'USD', width: 24, height: 12, transform: [12, 0, 0, 12, 145, 680] },
    { str: 'INV-001', width: 48, height: 12, transform: [12, 0, 0, 12, 120, 700] },
  ])
  assert.equal(text, 'Invoice INV-001\nUSD 42.50')
})

test('a request asks for the language of what it is looking for', () => {
  // An engine asked for a Chinese query while declaring an English preference answers with a cache of
  // something else entirely — measured directly: a Chinese query came back as a German car-insurance
  // page, which reads as a source with no coverage rather than a source that answered wrongly.
  assert.equal(acceptLanguageFor('https://www.bing.com/search?q=%E6%AD%A6%E6%B1%89%E5%85%AD%E4%B8%AD'), 'zh-CN,zh;q=0.9,en;q=0.8')
  assert.equal(acceptLanguageFor('https://zh.wikipedia.org/wiki/武汉'), 'zh-CN,zh;q=0.9,en;q=0.8')
  assert.equal(acceptLanguageFor('https://en.wikipedia.org/wiki/Wuhan'), 'en-US,en;q=0.8')
  assert.match(curlTransportArguments(10, 1_000, acceptLanguageFor('武汉')).join(' '), /Accept-Language: zh-CN/)
  assert.match(curlTransportArguments(10, 1_000).join(' '), /Accept-Language: en-US/)
})

test('web read metadata distinguishes the full document from the returned segment', () => {
  const result = contentWindow('0123456789abcdefghij', 5, 10)
  assert.deepEqual(result, {
    content_offset: 10,
    content_end: 15,
    content_characters: 20,
    returned_characters: 5,
    truncated: true,
    has_more: true,
    content: 'abcde',
  })
  assert.equal(contentWindow('short', 10, 0).has_more, false)
  assert.equal(contentWindow('partial', 20, 0, true).has_more, true)
})

test('a query longer than a handful of words is shortened to the words a page would carry', () => {
  // The published research prompts converge on the same rule: keep queries short, because a page
  // that states a fact states it in a few words, not in the sentence describing it.
  assert.equal(shortenQuery('wrestler named after a famous landmark defeated by a king gimmick AEW Dark episode three matches'), 'wrestler named after a famous landmark')
  assert.equal(shortenQuery('Lucha Underground season 2'), 'Lucha Underground season 2')
  assert.equal(shortenQuery(''), '')
})

test('a query too specific for any page comes back with broader forms of itself', async () => {
  const providers = [{ id: 'empty-index', tier: 0, search: async () => [] }]
  const thin = JSON.parse(await searchWeb('wrestler named after a famous landmark defeated by a king gimmick AEW Dark episode three matches', 5, { providers }))
  // The run is told how to widen instead of repeating the same shape of query.
  assert.ok(thin.suggested_queries.length > 0)
  assert.ok(thin.suggested_queries.every((query: string) => query !== thin.query))
  assert.match(thin.suggestion_note, /unsearched/)

  // A query that found results is not told to widen.
  const found = [{ id: 'index', tier: 0, search: async () => [1, 2, 3, 4, 5].map((index: number) => ({ title: `marsgame 海外 游戏 官网 ${index}`, url: `https://example.test/${index}`, content: 'marsgame 海外 游戏 官网' })) }]
  const rich = JSON.parse(await searchWeb('marsgame 海外 游戏 官网', 5, { providers: found }))
  assert.equal(rich.suggested_queries, undefined)
})

test('a read with a query returns the region that carries the query, not the page top', () => {
  const filler = (index: number) => `Filler paragraph ${index} with no clue words at all in it whatsoever`
  const page = [
    'Navigation Home About Contact',
    ...Array.from({ length: 40 }, (_, index) => filler(index)),
    'Season 2 Episode 4 Cero Miedo aired in November 2015',
    ...Array.from({ length: 40 }, (_, index) => filler(index + 100)),
    'Footer legal notice',
  ].join('\n')

  // The region around the answer is what comes back: a list page is read by scrolling to the
  // part that matters, and scattered paragraphs would drop whatever sits between them.
  const window = queryWindow(page, 'season episode Cero Miedo', 400, 0)
  assert.match(window.content, /Cero Miedo/)
  assert.doesNotMatch(window.content, /Navigation Home About Contact/)
  assert.equal(window.content_characters, page.length)
  assert.equal(window.has_more, false)

  // The offsets report where the region is, so a caller can ask for what was left out.
  const later = queryWindow(page, 'Footer legal notice', 200, 0)
  assert.match(later.content, /Footer legal notice/)
  assert.ok(later.content_offset > 0)

  // A page that fits the budget is returned whole even with a query: dropping what the
  // query did not name would take the context with it.
  const tiny = 'Navigation\nSeason 2 Episode 4 Cero Miedo'
  const whole = queryWindow(tiny, 'Cero Miedo', 500, 0)
  assert.equal(whole.content, tiny)
  assert.equal(whole.matched_sections, 0)

  // No query, or nothing matching, stays the plain window it always was.
  assert.deepEqual(queryWindow('0123456789abcdefghij', '', 5, 10), { ...contentWindow('0123456789abcdefghij', 5, 10), matched_sections: 0 })
  const none = queryWindow(page, 'zebra', 200, 0)
  assert.equal(none.content, contentWindow(page, 200, 0).content)
})

test('only successfully parsed non-empty web reads produce source and coverage receipts', () => {
  const receipt = webReadReceipt(JSON.stringify({ ok: true, final_url: 'https://example.com/report', content_offset: 400_000, content: 'evidence' }), 'https://example.com/old?utm_source=x')
  assert.deepEqual(receipt && { requestedUrl: receipt.requestedUrl, finalUrl: receipt.finalUrl, start: receipt.start, end: receipt.end }, {
    requestedUrl: 'https://example.com/old', finalUrl: 'https://example.com/report', start: 400_000, end: 400_008,
  })
  assert.equal(webReadReceipt('Error: resource-not-found (404)', 'https://example.com/missing'), null)
  assert.equal(webReadReceipt(JSON.stringify({ ok: true, content: '' }), 'https://example.com/empty'), null)
  assert.equal(webReadReceipt(JSON.stringify({ ok: true, final_url: 'https://example.com/page-not-found', title: 'Page not found | Example', content: 'A navigation page with enough text to look readable.' }), 'https://example.com/old-page'), null)
})

test('sourceSite treats official subdomains as one discovered site', () => {
  assert.equal(sourceSite('https://www.nist.gov/news'), 'nist.gov')
  assert.equal(sourceSite('https://csrc.nist.gov/pubs/fips/203/final'), 'nist.gov')
})

test('standards bodies are ranked as primary sources', () => {
  const results = rankAndDedupe('RFC 9535 JSONPath official IETF', [
    { title: 'Community RFC 9535 guide', url: 'https://blog.example/rfc9535', snippet: 'RFC 9535 JSONPath IETF', engine: 'one' },
    { title: 'JSONPath function registry', url: 'https://www.iana.org/assignments/jsonpath/jsonpath.xhtml', snippet: 'RFC 9535 JSONPath IETF official registry', engine: 'iana' },
    { title: 'RFC 9535', url: 'https://www.rfc-editor.org/rfc/rfc9535.html', snippet: 'Canonical RFC Editor publication', engine: 'registry' }
  ], 5)
  assert.equal(results[0].url, 'https://www.rfc-editor.org/rfc/rfc9535.html')
  assert.equal(results[0].source_class, 'official_or_primary_candidate')
})

test('normalizeWorkspaceCommand removes only a leading redundant workspace cd', () => {
  const root = '/Users/example/code pool/project'
  assert.equal(normalizeWorkspaceCommand(`cd '${root}' && pnpm test`, root), 'pnpm test')
  assert.equal(normalizeWorkspaceCommand(`cd /tmp && pwd`, root), 'cd /tmp && pwd')
})

test('fallback parser extracts structured results from independent engines', () => {
  const results = parseFallbackSearch({
    bingRss: '<rss><channel><item><title>Official guide</title><link>https://example.gov/docs/guide?utm_source=x</link><description>Primary documentation</description></item></channel></rss>',
    so360: '<ul><li class="res-list"><h3 class="res-title"><a data-mdurl="https://example.org/report">Research report</a></h3><p>Independent analysis</p></li></ul>'
  })
  assert.deepEqual(results.map(result => result.engine), ['bing-rss', 'so360-html'])
  assert.equal(results[0].url, 'https://example.gov/docs/guide')
})

test('rendered search recovery extracts direct external result anchors', () => {
  const results = parseSearchAnchors('<main><a href="https://video.example/watch/123"><h3>Exact visible title</h3><p>Publisher name</p></a><a href="/search?q=noise"><h3>Search again</h3></a></main>', 'https://www.google.com/search?q=title', 'google-chromium')
  assert.deepEqual(results.map(item => item.url), ['https://video.example/watch/123'])
})

test('page reads rank followable links by the exact identifying clue', () => {
  const links = extractPageLinks(`
    <a href="/unrelated">Generic navigation</a>
    <a href="/watch/target">Jaychou Best songs Collection — Sweet Lemon</a>
    <a href="https://example.test/watch/other?utm_source=page">Another video</a>
  `, 'https://example.test/lead', 'Jaychou Best songs Collection Sweet Lemon')
  assert.equal(links[0].url, 'https://example.test/watch/target')
  assert.equal(links[0].term_coverage, 1)
  assert.equal(links[2].url, 'https://example.test/watch/other')
})

test('page reads recover followable links from generic SPA hydration state', () => {
  const links = extractPageLinks(`<script>window.__INITIAL_STATE__ = ${JSON.stringify({
    cards: [{ title: { runs: [{ text: 'Jaychou Best songs Collection' }] }, longBylineText: { runs: [{ text: 'Sweet Lemon' }] }, navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: '/watch?v=source123' } } } }],
  })};</script>`, 'https://video.example/lead', 'Jaychou Best songs Collection Sweet Lemon')
  assert.equal(links[0].url, 'https://video.example/watch?v=source123')
  assert.equal(links[0].title, 'Jaychou Best songs Collection — Sweet Lemon')
  assert.equal(links[0].term_coverage, 1)
})

test('query-guided page verification renders dynamic pages when static HTML has no useful links', () => {
  assert.equal(needsRenderedLinkDiscovery({ outbound_links: [{ title: 'Home', url: 'https://example.test', matched_terms: 0, term_coverage: 0 }] }, 'exact title publisher'), true)
  assert.equal(needsRenderedLinkDiscovery({ outbound_links: [{ title: 'Exact title', url: 'https://example.test/target', matched_terms: 2, term_coverage: 1 }] }, 'exact title'), false)
  assert.equal(needsRenderedLinkDiscovery({ outbound_links: [] }), false)
})

test('fallback search keeps secondary result-card links instead of discarding exact targets', () => {
  const results = parseFallbackSearch({ bing: `
    <li class="b_algo">
      <h2><a href="https://example.test/lead">A related page</a></h2>
      <div><a href="https://video.example/watch/target">Exact Visible Video Title</a></div>
      <p>Publisher Name</p>
    </li>
  ` })
  assert.ok(results.some(result => result.url === 'https://video.example/watch/target' && result.title === 'Exact Visible Video Title'))
})

test('ranking deduplicates canonical URLs and favors primary candidates', () => {
  const results = rankAndDedupe('migration guide', [
    { title: 'Migration guide', url: 'https://blog.example/migration?utm_campaign=x', snippet: 'migration guide', engine: 'one' },
    { title: 'Migration guide duplicate', url: 'https://blog.example/migration', snippet: 'migration guide', engine: 'two' },
    { title: 'Official migration guide', url: 'https://agency.gov/docs/migration', snippet: 'migration guide', engine: 'three' }
  ], 5)
  assert.equal(results.length, 2)
  assert.equal(results[0].url, 'https://agency.gov/docs/migration')
})

test('generic keyword overlap is a lead until the primary subject appears in the title', () => {
  const results = rankAndDedupe('无尽梦 公司 融资 红杉', [
    { title: '红杉资本_百度百科', url: 'https://baike.baidu.com/item/redwood', snippet: '公司融资与红杉投资案例', engine: 'search' },
    { title: '上海无尽梦科技有限公司 - 企查查', url: 'https://www.qcc.com/firm/example', snippet: '无尽梦公司工商信息与融资线索', engine: 'search' },
  ], 5)
  assert.equal(results.find(item => item.url.includes('baike'))?.match.confidence, 'lead')
  assert.equal(results.find(item => item.url.includes('qcc'))?.match.confidence, 'lead')
  assert.equal(results[0].url, 'https://www.qcc.com/firm/example')
})

test('a site constraint does not turn an off-topic official page into a direct match', () => {
  const results = rankAndDedupe('site:manual.example guide transactions', [
    { title: 'Guide index', url: 'https://manual.example/guide/index', snippet: 'Transactions, schemas and many other subjects are listed here.' },
    { title: 'Transactions', url: 'https://manual.example/guide/transactions', snippet: 'Transaction guide.' },
  ])
  assert.equal(results.find(row => row.url.endsWith('/index'))?.match.confidence, 'lead')
  assert.equal(results.find(row => row.url.endsWith('/transactions'))?.match.confidence, 'direct')
  assert.equal(results[0].url, 'https://manual.example/guide/transactions')
})

test('a Latin-script subject is direct only when the result itself carries it', () => {
  const results = rankAndDedupe('MARSGAME 游戏 官网 海外', [
    { title: 'MarsGame-微信公众号 -135编辑器', url: 'https://www.135editor.com/wxes/17935', snippet: 'MarsGame 游戏 官网 海外 资料', engine: 'index' },
    { title: 'MarsGame 官方网站', url: 'https://www.marsgame.hk/', snippet: 'MarsGame 火游网络 海外发行', engine: 'index' },
    { title: 'Mars Game Hong Kong registry', url: 'https://www.ltddir.com/companies/mars-game-hongkong-network-technology-co-limited/', snippet: 'MarsGame 游戏 官网 海外 Mars Game Hong Kong', engine: 'index' },
  ], 5)
  assert.equal(results.find(item => item.url.includes('135editor'))?.match.confidence, 'lead')
  assert.equal(results.find(item => item.url.includes('marsgame.hk'))?.match.confidence, 'direct')
  // A directory record or a registrar lookup is evidence about the subject, not
  // the subject's own site, so it stays a lead and cannot end discovery early.
  assert.equal(results.find(item => item.url.includes('ltddir'))?.match.confidence, 'lead')
})

test('a registrar lookup page for the subject domain is a lead, not the target', () => {
  const results = rankAndDedupe('MarsGame official website', [
    { title: 'marsgame.com whois查询', url: 'https://wanwang.aliyun.com/whois/marsgame.com', snippet: 'MarsGame official website 域名信息', engine: 'index' },
    { title: 'MarsGame 官方网站', url: 'https://marsgame.com/', snippet: 'MarsGame official website', engine: 'index' },
  ], 5)
  assert.equal(results.find(item => item.url.includes('aliyun'))?.match.confidence, 'lead')
  assert.equal(results.find(item => item.url === 'https://marsgame.com/')?.match.confidence, 'direct')
})

test('a lookalike domain that only contains the brand stays a lead', () => {
  // `marsgamehk.com` is a different party's parked page, and reporting it as the
  // target ended discovery before the real site was ever seen.
  const results = rankAndDedupe('MARSGAME 游戏 官网 海外', [
    { title: 'MarsGame Website', url: 'https://marsgamehk.com/', snippet: 'MarsGame Generated Project', engine: 'webserp' },
    { title: '- Mars Games', url: 'https://marsgames.com/', snippet: 'MarsGame 游戏平台 Come to where the action is', engine: 'webserp' },
    { title: 'MarsGame 官方网站', url: 'https://www.marsgame.hk/', snippet: 'MarsGame 火游网络 海外发行', engine: 'webserp,fallback-indexes' },
  ], 5)
  assert.equal(results.find(item => item.url === 'https://marsgamehk.com/')?.match.confidence, 'lead')
  assert.equal(results.find(item => item.url === 'https://marsgames.com/')?.match.confidence, 'lead')
  assert.equal(results.find(item => item.url === 'https://www.marsgame.hk/')?.match.confidence, 'direct')
  // The subject's own domain leads the list, ahead of the lookalikes.
  assert.equal(results[0].url, 'https://www.marsgame.hk/')
})

test('ranking preserves query parameters that identify distinct resources', () => {
  const results = rankAndDedupe('video source', [
    { title: 'Video source one', url: 'https://video.example/watch?v=one&utm_source=x', snippet: 'video source', engine: 'one' },
    { title: 'Video source one duplicate', url: 'https://video.example/watch?v=one', snippet: 'video source', engine: 'two' },
    { title: 'Video source two', url: 'https://video.example/watch?v=two', snippet: 'video source', engine: 'three' },
  ], 5)
  assert.deepEqual(results.map(item => item.url).sort(), ['https://video.example/watch?v=one', 'https://video.example/watch?v=two'])
})

test('structured search preserves exact clues and enforces site constraints before ranking', () => {
  const query = buildSearchQuery('Jay Chou collection', { site: 'youtube.com/watch', exactPhrases: ['Jaychou Best songs Collection', 'Sweet Lemon'] })
  assert.equal(query, 'Jay Chou collection site:youtube.com/watch "Jaychou Best songs Collection" "Sweet Lemon"')
  assert.deepEqual(searchIntent(query).sites, [{ host: 'youtube.com', path: '/watch' }])
  const results = rankAndDedupe(query, [
    { title: 'Best pizza collection', url: 'https://example.com/pizza', snippet: 'Sweet lemon', engine: 'noise' },
    { title: 'Jaychou Best songs Collection', url: 'https://www.youtube.com/watch?v=source12345', snippet: 'Published by Sweet Lemon', engine: 'search' },
    { title: 'Jaychou Best songs Collection', url: 'https://www.youtube.com/channel/source', snippet: 'Sweet Lemon', engine: 'wrong-path' },
  ], 10)
  assert.deepEqual(results.map(item => item.url), ['https://www.youtube.com/watch?v=source12345'])
  assert.equal(results[0].match.exact_phrase_matches, 2)
  assert.equal(results[0].match.title_exact_phrase_matches, 1)
  assert.equal(results[0].match.site_match, true)
  assert.equal(results[0].match.confidence, 'direct')
})

test('a source mentioned only inside another result snippet remains a lead rather than the target page', () => {
  const [result] = rankAndDedupe('site:youtube.com/watch "Target Video Title" "Publisher Name"', [
    { title: 'Different video', url: 'https://youtube.com/watch?v=abcdefghijk', snippet: 'Related: Target Video Title by Publisher Name', engine: 'search' },
  ], 5)
  assert.equal(result.match.exact_phrase_matches, 2)
  assert.equal(result.match.title_exact_phrase_matches, 0)
  assert.equal(result.match.confidence, 'lead')
})

test('irrelevant authoritative pages cannot outrank results with actual query overlap', () => {
  const results = rankAndDedupe('site:youtube.com/watch "specific source title" publisher', [
    { title: 'Search operators reference', url: 'https://github.com/example/search', snippet: 'official search guide', engine: 'noise' },
    { title: 'Specific source title', url: 'https://youtube.com/watch?v=abcdefghijk', snippet: 'Publisher', engine: 'video' },
  ], 5)
  assert.deepEqual(results.map(item => item.engine), ['video'])
})

function withEnvironment(name: string, value: string | undefined, run: () => void) {
  const previous = process.env[name]
  try {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    run()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

test('the free index leads with an engine that answers, and stays configurable', () => {
  withEnvironment('WEBSERP_ENGINES', undefined, () => assert.equal(searchEngineList(), 'yahoo,google,duckduckgo,startpage'))
  withEnvironment('WEBSERP_ENGINES', 'yahoo', () => assert.equal(searchEngineList(), 'yahoo'))
})

test('a configured search API leads and demotes every scraper source', () => {
  withEnvironment('BRAVE_SEARCH_API_KEY', undefined, () => {
    const free = searchProviders({ sites: [] })
    // The keyless stack leads with a source that answers, which is no longer a fixed
    // first entry now that the encyclopedia is one of them.
    assert.equal(free[0].tier, 0)
    assert.equal(free[0].id, 'public-bing-2')
    assert.equal(free.some(provider => provider.id === 'search-api'), false)
  })
  withEnvironment('BRAVE_SEARCH_API_KEY', 'test-key', () => {
    const providers = searchProviders({ sites: [] })
    assert.equal(providers[0].id, 'search-api')
    assert.equal(providers[0].tier, 0)
    assert.equal(providers.find(provider => provider.id === 'webserp')?.tier, 2)
  })
})

test('the search API contract maps documented fields and tolerates malformed payloads', () => {
  assert.deepEqual(parseSearchApiResults({ web: { results: [{ title: 'MarsGame 官方网站', url: 'https://www.marsgame.hk/', description: '火游网络 海外发行' }] } }), [
    { title: 'MarsGame 官方网站', url: 'https://www.marsgame.hk/', content: '火游网络 海外发行', engine: 'search-api' },
  ])
  assert.deepEqual(parseSearchApiResults({}), [])
  assert.deepEqual(parseSearchApiResults(null), [])
  assert.deepEqual(parseSearchApiResults({ web: { results: [{ title: 'Missing url' }] } }), [])
})

test('declared site indexes expose relevant internal documentation links', () => {
  const results = parseSiteIndex('<nav><a href="/overlay/latest.html">Overlay Specification</a><a href="https://elsewhere.test/no">Other</a></nav>', 'https://spec.openapis.org/')
  assert.deepEqual(results.map(result => result.url), ['https://spec.openapis.org/overlay/latest.html'])
})

test('site-native discovery understands generic OpenSearch descriptors and search forms', () => {
  const discovery = parseSiteSearchDiscovery(`
    <link rel="search" type="application/opensearchdescription+xml" href="/opensearch.xml">
    <form action="/find"><input type="hidden" name="lang" value="en"><input name="q"></form>
  `, 'https://video.example/', 'source title site:video.example/watch')
  assert.deepEqual(discovery.descriptors, ['https://video.example/opensearch.xml'])
  assert.deepEqual(discovery.searches, ['https://video.example/find?lang=en&q=source+title'])
  assert.deepEqual(parseOpenSearchTemplates('<OpenSearchDescription><Url type="text/html" template="https://video.example/results?q={searchTerms}&amp;lang=en"/></OpenSearchDescription>', discovery.descriptors[0], 'source title site:video.example/watch'), ['https://video.example/results?q=source%20title&lang=en'])
})

test('site-native search renders missing discovery and races result transports', async () => {
  const rendered: string[] = [], fetchResource = async (url: string) => ({
    body: Buffer.from(url.includes('/find?') ? '<a href="/watch/target">Exact Source Title — Publisher</a>' : '<main>Static shell</main>'),
    status: 200, contentType: 'text/html', finalUrl: url,
  }), renderPage = async (url: string) => {
    rendered.push(url)
    return url === 'https://video.example/'
      ? { html: '<form action="/find"><input name="q"></form>', finalUrl: url }
      : { html: '<a href="/watch/target">Exact Source Title — Publisher</a>', finalUrl: url }
  }
  const results = await searchDeclaredSites('site:video.example/watch "Exact Source Title" "Publisher"', fetchResource, renderPage)
  assert.deepEqual(rendered, ['https://video.example/', 'https://video.example/find?q=Exact+Source+Title+Publisher'])
  assert.equal(results[0].url, 'https://video.example/watch/target')
})

test('SearXNG registry parsing keeps only healthy privacy-preserving HTTPS instances', () => {
  assert.deepEqual(parseSearxInstances({ instances: {
    'https://healthy.example/': { analytics: false, http: { status_code: 200 }, uptime: { month: 99.5 }, timing: { search: { all: { median: 1 } } } },
    'https://tracked.example/': { analytics: true, http: { status_code: 200 }, uptime: { month: 100 } },
    'https://down.example/': { analytics: false, http: { status_code: 503 }, uptime: { month: 99 } },
    'http://insecure.example/': { analytics: false, http: { status_code: 200 }, uptime: { month: 100 } },
  } }), ['https://healthy.example/'])
})

test('web search exposes provider provenance while preserving exact-site matching', async () => {
  const output = JSON.parse(await searchWeb('unique source 92731', 5, {
    site: 'video.example/watch', exactPhrases: ['Exact Source Title', 'Publisher'], providers: [
      { id: 'free-index', tier: 0, search: async () => [{ title: 'Exact Source Title', url: 'https://video.example/watch?id=123', content: 'Publisher', engine: 'fixture' }] },
    ],
  }))
  assert.equal(output.direct_matches, 1)
  assert.equal(output.results[0].url, 'https://video.example/watch?id=123')
  assert.equal(output.retrieval.providers[0].id, 'free-index')
})

test('technical searches add bounded GitHub repository discovery variants', () => {
  assert.deepEqual(githubQueryVariants('OpenAPI Overlay Specification site:github.com'), ['overlay-specification in:name', 'OpenAPI Overlay Specification in:name,description'])
  assert.deepEqual(githubQueryVariants('weather tomorrow'), [])
})

test('a rendered engine interstitial is a blocked channel, not an empty query', () => {
  const results = classifyRenderedSearch('<html><body><a href="https://example.test/result"><h3>Example result</h3></a></body></html>', 'https://www.google.com/search?q=x', 'google-chromium')
  assert.equal(results.outcome, 'ok')
  assert.equal(results.results.length, 1)

  // Benching the channel is the point: a consent wall answers every query this way.
  assert.equal(classifyRenderedSearch('<html><body>Before you continue to Google. We use cookies and data to keep our services working.</body></html>', 'https://consent.google.com/', 'google-chromium').outcome, 'blocked')
  assert.equal(classifyRenderedSearch('<html><body>Our systems have detected unusual traffic from your computer network.</body></html>', 'https://www.google.com/search?q=x', 'google-chromium').outcome, 'blocked')

  // A page that honestly reports nothing must not bench a healthy channel.
  assert.equal(classifyRenderedSearch('<html><body><div id="res">Your search did not match any documents.</div></body></html>', 'https://www.google.com/search?q=x', 'google-chromium').outcome, 'empty')
})

test('a transport failure states whether the host resolved, so absence is never inferred from it', () => {
  assert.equal(transportFailureKind('curl transport failed (6): Could not resolve host: marsgame.hk'), 'unresolved')
  assert.equal(transportFailureKind('curl transport failed (28): Operation timed out'), 'timeout')
  assert.equal(transportFailureKind('curl transport failed (35): LibreSSL SSL_connect: SSL_ERROR_SYSCALL'), 'tls')
  assert.equal(transportFailureKind('HTTP 502 for https://marsgame.hk/'), 'other')
})

test('an entity query widens to the bare subject instead of waiting for another model turn', () => {
  assert.deepEqual(searchQueryVariants('MARSGAME 游戏 官网 海外'), ['marsgame'])
  assert.deepEqual(searchQueryVariants('marsgame 海外 游戏 官网'), ['marsgame'])
  assert.deepEqual(searchQueryVariants('无尽梦 公司 融资 红杉'), [])
  // A query narrowed with quoted phrases returns nothing when the page does not spell
  // the phrase as assumed, so the unquoted form is tried before the bare subject.
  assert.deepEqual(searchQueryVariants('"Raffaele Contigiani" brutalist auditorium', 3), [
    'Raffaele Contigiani brutalist auditorium',
    'raffaele',
  ])
})

test('a weak match returns its leads without silently dropping query constraints', async () => {
  const queries: string[] = []
  const output = JSON.parse(await searchWeb('MARSGAME 游戏 官网 海外', 5, { providers: [{
    id: 'index', tier: 0, search: async (query: string) => {
      queries.push(query)
      return [{ title: 'MarsGame 微信号', url: 'https://www.135editor.com/wxes/17935', content: 'MarsGame 游戏 官网 海外 资料' }]
    },
  }] }))
  assert.deepEqual(queries, ['MARSGAME 游戏 官网 海外'])
  assert.equal(output.direct_matches, 0)
  assert.equal(output.evidence_status, 'discovery_only')
})

test('a search that already reaches its subject never issues the widened query', async () => {
  const queries: string[] = []
  const providers = [{
    id: 'index', tier: 0, search: async (query: string) => {
      queries.push(query)
      return query === 'MARSGAME 游戏 官网'
        ? [{ title: 'MarsGame 官方网站', url: 'https://www.marsgame.hk/', content: 'MarsGame 火游网络', engine: 'fixture' }]
        : []
    },
  }]
  const output = JSON.parse(await searchWeb('MARSGAME 游戏 官网', 5, { providers }))
  assert.equal(output.direct_matches, 1)
  assert.equal(output.widening, undefined)
  // The invariant is behavioural, not a stopwatch: a query that already reached its
  // subject issues one query, and never the widened variant.
  assert.deepEqual(queries, ['MARSGAME 游戏 官网'])
})

test('the keyless indexes are asked for a second page instead of one thin slice', () => {
  const requests = fallbackSearchRequests('webview2 hosting doc')
  const engines = (name: string) => requests.filter(item => item.parser === name).map(item => item.url)
  assert.equal(engines('google').length, 2)
  assert.equal(engines('bing').length, 2)
  assert.equal(engines('so360').length, 2)
  assert.match(engines('google')[1], /start=10/)
  assert.match(engines('bing')[1], /first=11/)
  assert.match(engines('so360')[1], /pn=2/)
})

test('a Chinese query is matched on its own words rather than fixed-width chunks', () => {
  // Chinese has no spaces, so slicing a run into fixed-width pieces produces tokens no page
  // contains: every company page then looked equally relevant, and the real one scored low.
  const terms = searchIntent('上海无尽梦科技有限公司 管理团队').terms
  assert.ok(terms.includes('无尽') && terms.includes('尽梦') && terms.includes('梦科'))
  assert.ok(terms.includes('管理') && terms.includes('团队'))
  assert.ok(!terms.some(term => term.length > 2 && /^[\u3400-\u9fff]+$/.test(term)), 'no fixed-width chunk is left as a term')

  // A page about the company now covers the query, and an unrelated company page does not.
  const query = '无尽梦科技 陆玉斯 联合创始人 三位'
  const ranked = rankAndDedupe(query, [
    { title: 'AI浪潮下的上海超级创业者 - 中国网', url: 'https://www.china.com.cn/a/1.shtml', snippet: '上海无尽梦科技有限公司的三位创始人在一家大型企业从事AI产品相关工作，该公司联合创始人陆玉斯说。', engine: 'index' },
    { title: '东舢（上海）塑胶薄膜有限公司平湖分公司', url: 'https://www.otsukasoc.com/glgs/p-hys.html', snippet: '塑胶薄膜有限公司', engine: 'index' },
  ], 8)
  assert.equal(ranked.length, 1)
  assert.match(ranked[0].url, /china\.com\.cn/)
  assert.equal(ranked[0].match.term_coverage, 1)
})

test('a sentence becomes the constraint words an entity index can answer', () => {
  // The same description that returns job advertisements in sentence form returns
  // the person's own article in keyword form, so the asking words are dropped.
  assert.equal(
    distillQuery('architect who served in the Second World War and was a television consultant, brutalist'),
    'architect served Second World War television consultant brutalist',
  )
  assert.equal(distillQuery('marsgame 海外 游戏 官网是什么'), 'marsgame 海外 游戏 官网')
  // Never hand a source nothing: a query that is already distilled passes through.
  assert.equal(distillQuery('who is it'), 'who is it')
  assert.equal(distillQuery(''), '')
})

test('a publication is found by its own bibliographic record', () => {
  // A printed work is not found by the sentence describing it but by its title words, its DOI,
  // and the journal that reviewed it, which is the footprint Crossref registers.
  const rows = parseCrossrefResults({ message: { items: [
    { title: ['A New Landmark Publication for the South Pacific, Flora of the Cook Islands'], DOI: '10.12705/663.43', 'container-title': ['Taxon'], issued: { 'date-parts': [[2017]] }, abstract: '<jats:p>Review of a flora.</jats:p>' },
    { title: [], DOI: '10.1/empty' },
  ] } })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].url, 'https://doi.org/10.12705/663.43')
  assert.match(String(rows[0].content), /Taxon/)
  assert.match(String(rows[0].content), /Review of a flora/)
  assert.equal(parseCrossrefResults({}).length, 0)
})

test('the encyclopedia is asked in the language of the question', () => {
  assert.equal(wikipediaEndpoint('architect television consultant'), 'en.wikipedia.org')
  assert.equal(wikipediaEndpoint('上海 游戏 公司 出海'), 'zh.wikipedia.org')
})

test('the encyclopedia is asked more than one phrasing of the same question', () => {
  // Phrasing-sensitive ranking is why a single distilled query is a coin flip: an
  // entity-first reordering and a clause-drop are mechanical variants of the same
  // words, so they generalise to any question.
  const variants = wikipediaQueryVariants('architect who served in the Second World War and was a television consultant, brutalist')
  assert.equal(variants[0], 'architect served Second World War television consultant brutalist')
  assert.ok(variants.length >= 2 && variants.length <= 3)
  assert.ok(variants.some(variant => variant.startsWith('Second World War')))
  assert.ok(variants.every(variant => !/\bwho\b/i.test(variant)))
  assert.deepEqual(wikipediaQueryVariants('who is it'), ['who is it'])
  assert.deepEqual(wikipediaQueryVariants(''), [])
  // A CJK question has no space-separated reordering to try, so it is asked once.
  assert.equal(wikipediaQueryVariants('上海 游戏 公司').length, 1)
})

test('a search page handed to the reader is read as a query, not as a document', () => {
  // Opening an engine's result page spends a page read on an anti-bot page whose only
  // content of value is the query itself.
  assert.equal(searchPageQuery('https://www.google.com/search?q=architect+brutalist+consultant&num=20'), 'architect brutalist consultant')
  assert.equal(searchPageQuery('https://www.bing.com/search?q=%22exact+phrase%22+thesis'), '"exact phrase" thesis')
  assert.equal(searchPageQuery('https://duckduckgo.com/html/?q=band+interview'), 'band interview')
  assert.equal(searchPageQuery('https://lite.duckduckgo.com/lite/?q=Afrigo+Band'), 'Afrigo Band')
  assert.equal(searchPageQuery('https://search.marginalia.nu/search?query=botanist+book'), 'botanist book')
  // An encyclopedia's search API URL is the same query in a different shape.
  assert.equal(searchPageQuery('https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=insource%3A%22Cero+Miedo%22'), 'insource:"Cero Miedo"')
  assert.equal(searchPageQuery('https://en.wikipedia.org/w/api.php?action=query&titles=Foo'), '')
  // A page is a page: an article, an engine's own front page, and a search URL with
  // no query all stay ordinary reads.
  assert.equal(searchPageQuery('https://en.wikipedia.org/wiki/Raffaele_Contigiani'), '')
  assert.equal(searchPageQuery('https://www.google.com/'), '')
  assert.equal(searchPageQuery('not a url'), '')
})

test('delegated search results read as ranked evidence with their confidence', () => {
  const payload = JSON.stringify({
    results: [
      { url: 'https://example.test/list', title: 'The episode list', snippet: 'Cero Miedo', match: { confidence: 'direct' } },
      { url: 'https://example.test/rival', title: 'Rival list', snippet: '', match: { confidence: 'lead' } },
    ],
    retrieval: { providers: [{ id: 'wikipedia-search', status: 'ok' }] },
  })
  const rendered = searchPageResults('lucha underground episode list', payload)
  assert.equal(rendered.results, 2)
  assert.match(rendered.content, /1\. https:\/\/example\.test\/list \(direct\)/)
  assert.match(rendered.content, /2\. https:\/\/example\.test\/rival \(lead\)/)
  assert.match(rendered.content, /not evidence/)
  assert.deepEqual(rendered.providers, [{ id: 'wikipedia-search', status: 'ok' }])
})

test('rank fusion rewards the page several phrasings agree on', () => {
  const a = { title: 'A', url: 'https://en.wikipedia.org/wiki/A' }, b = { title: 'B', url: 'https://en.wikipedia.org/wiki/B' }, c = { title: 'C', url: 'https://en.wikipedia.org/wiki/C' }
  const fused = fuseRankedResults([[a, b], [b, c]], 10)
  assert.equal(fused[0].url, b.url)
  assert.deepEqual(fuseRankedResults([[a, b], [b, a]], 1).map(row => row.url), [a.url])
  assert.deepEqual(fuseRankedResults([], 10), [])
})

test('a page that merely mirrors the query is demoted below any real source', () => {
  assert.equal(contentFarmPenalty('https://www.wordplays.com/crossword-solver/%22consultant%22-architect-%27former-soldier%27'), -40)
  assert.equal(contentFarmPenalty('https://www.dwell.com/discover/architect-former-soldier-brutalist-building'), -40)
  assert.equal(contentFarmPenalty('https://www.linkedin.com/jobs/architect-consultant-jobs'), -40)
  assert.equal(contentFarmPenalty('https://en.wikipedia.org/wiki/Raffaele_Contigiani'), 0)
  assert.equal(contentFarmPenalty('not a url'), 0)
  // The farm page echoes the exact phrase and would outscore the article on word
  // matching alone; the penalty is what puts evidence ahead of the echo.
  const ranked = rankAndDedupe('architect "television consultant" brutalist', [
    { title: '"television consultant" architect brutalist', url: 'https://www.wordplays.com/crossword-solver/%22television-consultant%22-architect-brutalist', snippet: 'architect television consultant brutalist' },
    { title: 'Raffaele Contigiani', url: 'https://en.wikipedia.org/wiki/Raffaele_Contigiani', snippet: 'architect and television consultant known for a brutalist building' },
  ], 5)
  assert.equal(ranked[0].url, 'https://en.wikipedia.org/wiki/Raffaele_Contigiani')
})

test('encyclopedia hits become article URLs, and are ranked as the entity record', () => {
  const rows = parseWikipediaSearch({ query: { search: [{ title: 'Raffaele Contigiani', snippet: 'designed in the <span class="searchmatch">brutalist</span> style' }] } }, 'architect brutalist')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].url, 'https://en.wikipedia.org/wiki/Raffaele_Contigiani')
  assert.match(String(rows[0].content), /brutalist/)
  assert.equal(parseWikipediaSearch({}, 'x').length, 0)
  // An encyclopedia can identify an entity without becoming primary evidence for its claims.
  assert.equal(sourceClass('https://en.wikipedia.org/wiki/Raffaele_Contigiani'), 'community_or_reference_lead')
  assert.equal(sourceClass('https://www.reddit.com/r/architecture'), 'community_or_reference_lead')
})


test('quoted subject matches do not erase the remaining research constraints', () => {
  for (const [query, generic, specific] of [
    ['"星河输入法" 离线 模型', '星河输入法', '星河输入法 离线模型架构'],
    ['"Atlas" transaction isolation', 'Atlas documentation', 'Atlas transaction isolation reference'],
  ]) {
    const rows = rankAndDedupe(query, [
      { title: generic, url: 'https://example.test/home', snippet: generic },
      { title: specific, url: 'https://example.test/docs/detail', snippet: specific },
    ])
    assert.equal(rows.find(row => row.url.endsWith('/home'))?.match.confidence, 'lead')
    assert.equal(rows.find(row => row.url.endsWith('/detail'))?.match.confidence, 'direct')
  }
  assert.equal(sourceClass('https://baike.baidu.com/item/example'), 'community_or_reference_lead')
})

test('public index pages are independently scheduled and retain deeper result pages', () => {
  const providers = publicIndexProviders()
  assert.equal(providers.length, 5)
  assert.equal(new Set(providers.map(provider => provider.id)).size, 5)
  assert.ok(!providers.some(provider => provider.id === 'public-google-1'))
  assert.equal(publicIndexProviders(undefined, 0, 2).length, 3)
})

test('a working transport wins without waiting for a stalled transport and cancels it', async () => {
  let cancelled = false
  const resource = { body: Buffer.from('evidence'), status: 200, contentType: 'text/plain', finalUrl: 'https://example.test/' }
  const actual = await firstSuccessfulResource([
    signal => new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(Error('cancelled')) }, { once: true })),
    async () => resource,
  ])
  assert.equal(actual, resource)
  assert.equal(cancelled, true)
})

test('an HTTP error cannot beat a successful alternate transport', async () => {
  const resource = { body: Buffer.from('evidence'), status: 200, contentType: 'text/plain', finalUrl: 'https://example.test/' }
  assert.equal(await firstSuccessfulResource([async () => ({ ...resource, status: 403 }), async () => resource]), resource)
  await assert.rejects(firstSuccessfulResource([async () => ({ ...resource, status: 403 })]), AggregateError)
})


test('specialist discovery is explicitly selected instead of diluting every web query', () => {
  const general = searchProviders({ sites: [] }).map(provider => provider.id)
  for (const specialist of ['crossref', 'wikipedia-search', 'github-repositories']) assert.ok(!general.includes(specialist))
  assert.ok(searchProviders({ sites: [], source: 'academic' }).some(provider => provider.id === 'crossref'))
  assert.ok(searchProviders({ sites: [], source: 'reference' }).some(provider => provider.id === 'wikipedia-search'))
  assert.ok(searchProviders({ sites: [], source: 'code' }).some(provider => provider.id === 'github-repositories'))
})


test('a strongly matching snippet can return quickly without being labeled verified or direct', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  try {
    const result = JSON.parse(await searchWeb('"uncancel" "cancelling"', 5, { site: 'docs.example/library', providers: [
      { id: 'manual', tier: 0, search: async () => [{title: 'Coroutines and Tasks', url: 'https://docs.example/library/tasks', content: 'uncancel decrements the cancelling count.'}] },
      { id: 'slow', tier: 0, search: async () => { await pending; return [] } },
    ] }))
    assert.equal(result.results[0].match.confidence, 'lead')
    assert.equal(result.evidence_status, 'discovery_only')
    assert.deepEqual(result.retrieval.providers.map((row: any) => row.id), ['manual'])
  } finally { release() }
})

test('page reading returns usable native evidence without waiting for another transport', async () => {
  const output = JSON.parse(await readWeb('https://read-fixture.invalid/evidence', 2000, undefined, undefined,
    async url => ({body: Buffer.from('A primary document containing the requested evidence.'), status: 200, contentType: 'text/plain', finalUrl: url})))
  assert.equal(output.ok, true)
  assert.match(output.content, /requested evidence/)
  assert.equal(output.fetch_method, 'http')
})


test('a long Chinese entity name cannot outweigh missing subject constraints', () => {
  const rows = rankAndDedupe('银河智能输入法 离线 模型', [
    {title: '银河智能输入法 - 高效输入', url: 'https://example.test/home', content: '智能输入法软件下载'},
    {title: '银河智能输入法 离线模型技术说明', url: 'https://example.test/model', content: '离线模型技术说明'},
  ])
  assert.equal(rows[0].url, 'https://example.test/model')
  assert.equal(rows.find(row => row.url.endsWith('/home'))?.match.confidence, 'lead')
  assert.ok(rows.find(row => row.url.endsWith('/home'))!.match.term_coverage < 0.75)
})


test('a relevant body does not launch rendering merely because its links lack the query', () => {
  assert.equal(needsRenderedLinkDiscovery({content: 'The transaction isolation guarantee is documented here.', outbound_links: []}, 'transaction isolation'), false)
  assert.equal(needsRenderedLinkDiscovery({content: 'Welcome. Loading application.', outbound_links: []}, 'transaction isolation'), true)
})

test('long-document retrieval prefers the explanatory section over a navigation mention', () => {
  const content = 'Contents: frobnicate\n' + 'General introduction. '.repeat(120) +
    '\nFrobnicate behavior\nFrobnicate decrements a counter. Frobnicate also clears pending work when the count reaches zero.\n' + 'Other sections. '.repeat(100)
  const result = queryWindow(content, 'frobnicate', 400, 0)
  assert.match(result.content, /clears pending work/)
  assert.ok(result.content_offset > 400)
})

test('a long source read returns the explanatory evidence without starting browser rendering', async () => {
  let rendered = 0
  const html = `<html><head><title>Reference manual</title></head><body><article><p>Contents: frobnicate</p><p>${'General introduction. '.repeat(200)}</p><h2>Frobnicate behavior</h2><p>Frobnicate decrements a counter. Frobnicate clears pending work when the counter reaches zero.</p><p>${'Other sections. '.repeat(200)}</p></article></body></html>`
  const output = JSON.parse(await readWeb('https://read-fixture.invalid/manual', 1200, async () => {
    rendered++; throw Error('render should not run')
  }, undefined, async url => ({body: Buffer.from(html), status: 200, contentType: 'text/html', finalUrl: url}), 'frobnicate'))
  assert.match(output.content, /clears pending work/)
  assert.equal(rendered, 0)
  assert.ok(output.content_offset > 1200)
})


test('identifier queries retain underscores and locate their escaped Markdown spelling', () => {
  const content = 'A must cancel explanation. '.repeat(150) + '\nThe \\_pending\\_flag is cleared here.\n' + 'Other reference material. '.repeat(100)
  const result = queryWindow(content, '_pending_flag', 400, 0)
  assert.match(result.content, /cleared here/)
  assert.ok(result.content_offset > 400)
})

test('plain source documents honor the requested query instead of returning only the file header', async () => {
  const body = 'Header and imports\n'.repeat(300) + '\ndef frobnicate():\n    clear_pending_flag()\n' + '# unrelated code\n'.repeat(200)
  const output = JSON.parse(await readWeb('https://read-fixture.invalid/source.txt', 1200, undefined, undefined,
    async url => ({body: Buffer.from(body), status: 200, contentType: 'text/plain', finalUrl: url}), 'frobnicate'))
  assert.match(output.content, /def frobnicate/)
  assert.ok(output.content_offset > 1200)
})

test('a source excerpt keeps the explanation after a keyword near the window boundary', () => {
  const content = 'x'.repeat(9980) + '\ndef frobnicate():\n    clear_pending_flag()\n' + '\n# unrelated'.repeat(1200)
  const output = queryWindow(content, 'frobnicate', 4000, 0)
  assert.match(output.content, /clear_pending_flag/)
})


test('later public result pages advance engine offsets and never replay first-page adapters', async () => {
  const urls: string[] = []
  const providers = searchProviders({sites: [], page: 2, coverage:'expanded', fetchResource: async url => {
    urls.push(url)
    return {body: Buffer.from('<html><body>No matches</body></html>'), status: 200, contentType: 'text/html', finalUrl: url}
  }})
  assert.equal(providers.length, 3)
  await Promise.all(providers.map(provider => provider.search('distinctive identifier', 5)))
  assert.ok(urls.some(url => new URL(url).searchParams.get('start') === '10'))
  assert.ok(urls.some(url => new URL(url).searchParams.get('first') === '11'))
  assert.ok(urls.some(url => new URL(url).searchParams.get('pn') === '2'))
})


test('focused reads return bounded evidence and ranked links without pagination instructions in the source text', async () => {
  const links = Array.from({length: 45}, (_, i) => `<a href="https://references.example/${i}">frobnicate reference ${i}</a>`).join('')
  const html = `<html><head><title>Manual</title></head><body><article><p>${'Introduction. '.repeat(900)}</p><h2>Frobnicate behavior</h2><p>Frobnicate clears a pending flag. Frobnicate then returns the remaining count.</p><p>${'Other material. '.repeat(900)}</p>${links}</article></body></html>`
  const result = JSON.parse(await readWeb('https://read-fixture.invalid/focused', undefined, undefined, undefined,
    async url => ({body: Buffer.from(html), status: 200, contentType: 'text/html', finalUrl: url}), 'frobnicate'))
  assert.ok(result.returned_characters <= 6000)
  assert.equal(result.outbound_links.length, 8)
  assert.ok(result.outbound_link_count > 8)
  assert.equal(result.outbound_links_truncated, true)
  assert.doesNotMatch(result.content, /continue with offset|earlier match\(es\)/)
  assert.ok(result.content_end <= result.content_characters)
})


test('document title words cannot crowd the details out of a focused evidence window', () => {
  const page = 'Reference format. Introduction. ' + 'Background. '.repeat(900) +
    '\nParallel transaction details. A single writer coordinates with concurrent readers. Readers do not block a writer.\n' + 'Appendix. '.repeat(900)
  const output = queryWindow(page, 'reference format parallel transaction writer readers', 1200, 0, {title: 'Reference format'})
  assert.match(output.content, /single writer/)
  assert.match(output.content, /Readers do not block/)
})

test('two-character Chinese query details locate the evidence beyond an entity introduction', () => {
  const page = '星河输入法。' + '通用产品介绍。'.repeat(800) + '\n离线模型运行于本机，模型采用独立识别结构。\n' + '其他页面说明。'.repeat(600)
  const output = queryWindow(page, '星河输入法 离线 模型', 600, 0, {title: '星河输入法'})
  assert.match(output.content, /独立识别结构/)
})


test('a cardinal qualifier in a query keeps the constraint paragraph in the returned window', () => {
  const page = 'Reference format. Parallel readers and writers. ' + 'Readers and writers share the reference format. '.repeat(140) +
    '\nConcurrency details. Only one writer can modify the log at a time. Readers continue independently.\n' + 'Background appendix. '.repeat(600)
  const output = queryWindow(page, 'reference format concurrency one writer readers', 1200, 0, {title: 'Reference format'})
  assert.match(output.content, /Only one writer/)
})


test('repository hosting alone does not establish an official source for another product', () => {
  assert.equal(sourceClass('https://github.com/example/database-wrapper'), 'repository_record')
  assert.equal(sourceClass('https://gitlab.com/example/docs/guide'), 'repository_record')
})


test('identifier queries do not select unrelated substring matches in long reference pages', () => {
  const noise = ('print interface interval unpacked aliases subclassification Boolean-related metadata.\n').repeat(100)
  const answer = 'Boolean type: bool is a subclass of int. False and True act like zero and one.\n'
  const page = noise + answer + ('Other definitions.\n').repeat(200)
  const found = queryWindow(page, 'bool is a subclass of int', 500, 0)
  assert.match(found.content, /bool is a subclass of int/)
})


test('embedded image bytes never displace readable source evidence', async () => {
  const html = `<html><title>Product facts</title><body><main><h1>Product facts</h1><img src="data:image/svg+xml;base64,${'QUJD'.repeat(10000)}" alt="Product logo"><p>This product supports local recognition. Its model name is not listed on this page.</p></main><script>secretGeneratedState = 123</script></body></html>`
  const output = JSON.parse(await readWeb('https://read-fixture.invalid/product', 1000, undefined, undefined,
    async url => ({body: Buffer.from(html), status: 200, contentType: 'text/html', finalUrl: url}), 'local recognition model'))
  assert.equal(output.ok, true)
  assert.match(output.content, /supports local recognition/)
  assert.doesNotMatch(output.content, /base64|QUJD|secretGeneratedState/)
  assert.ok(output.content_characters < 1000)
})

test('a short native page remains usable evidence without requiring browser rendering', async () => {
  let rendered = false
  const output = JSON.parse(await readWeb('https://read-fixture.invalid/short', 1000, async () => { rendered = true; throw Error('unneeded rendering') }, undefined,
    async url => ({body: Buffer.from('<html><title>Release note</title><body><main><h1>Release note</h1><p>Version 2 fixes the pending counter.</p></main></body></html>'), status: 200, contentType: 'text/html', finalUrl: url}), 'pending counter'))
  assert.equal(output.ok, true)
  assert.equal(rendered, false)
  assert.match(output.content, /fixes the pending counter/)
})


test('user-published technical articles remain community leads rather than first-party records', () => {
  assert.equal(sourceClass('https://blog.csdn.net/example/article/details/123'), 'community_or_reference_lead')
  assert.equal(sourceClass('https://bbs.csdn.net/example/article/details/456'), 'community_or_reference_lead')
})


test('standard discovery returns relevant leads without waiting for an answer-shaped title', async () => {
  let fallback = false
  const output = JSON.parse(await searchWeb('compiler cancellation queued token', 5, { providers: [
    { id: 'fast-lead', tier: 0, search: async () => [{ title: 'Compiler cancellation overview', url: 'https://example.test/queued-cancellation', content: 'Compiler cancellation overview.' }] },
    { id: 'slow-answer', tier: 1, search: async () => { fallback = true; return [] } },
  ] }))
  assert.equal(fallback, false)
  assert.equal(output.results[0].match.confidence, 'lead')
  assert.equal(output.evidence_status, 'discovery_only')
})

test('fast discovery does not stop at a lead missing an explicit required phrase', async () => {
  let fallback = false
  const output = JSON.parse(await searchWeb('"Silver Compiler" "deferred cancellation"', 5, { providers: [
    { id: 'partial-clue', tier: 0, search: async () => [{ title: 'Silver Compiler', url: 'https://example.test/compiler', content: 'Compiler manual.' }] },
    { id: 'full-clue', tier: 1, search: async () => { fallback = true; return [{title:'Silver Compiler deferred cancellation',url:'https://example.test/deferred',content:'Silver Compiler supports deferred cancellation.'}] } },
  ] }))
  assert.equal(fallback, true)
  assert.equal(output.results[0].url, 'https://example.test/deferred')
})

test('expanded coverage reaches an additional channel and never reuses the standard result cache', async () => {
  let fast = 0, extra = 0
  const providers = [
    { id: 'public-bingRss-probe', tier: 0, search: async () => { fast++; return [{title:'CoverageProbe18931 deferred',url:'https://example.test/fast-probe',content:'CoverageProbe18931 deferred'}] } },
    { id: 'alternate-index', tier: 1, search: async () => { extra++; return [{title:'CoverageProbe18931 deferred independent',url:'https://example.test/extra-probe',content:'CoverageProbe18931 deferred'}] } },
  ]
  await searchWeb('CoverageProbe18931 deferred', 5, {providers})
  assert.equal(extra, 0)
  const output = JSON.parse(await searchWeb('CoverageProbe18931 deferred', 5, {providers, coverage:'expanded'}))
  assert.equal(fast, 2)
  assert.equal(extra, 1)
  assert.equal(output.retrieval.coverage, 'expanded')
  assert.ok(output.results.some((row: any) => row.url.endsWith('/extra-probe')))
})

test('expensive and unproductive channels are expanded options, not default discovery work', () => {
  const renderPage = async () => ({ finalUrl:'https://example.test/', html:'<html></html>' })
  const standard = searchProviders({sites:[],renderPage}).map(provider => provider.id)
  const expanded = searchProviders({sites:[],renderPage,coverage:'expanded'}).map(provider => provider.id)
  for (const id of ['public-google-0','public-so360-5','chromium-google','chromium-bing']) {
    assert.ok(!standard.includes(id))
    assert.ok(expanded.includes(id))
  }
})

test('verification and redirected sign-in shells never count as page evidence', () => {
  for (const [url, title] of [
    ['https://www.zhihu.com/account/unhuman?need_login=true', '安全验证'],
    ['https://sso.toutiao.com/login/?service=article', '今日头条登录'],
    ['https://example.com/signin', 'Sign in'],
  ]) {
    assert.equal(webReadReceipt(JSON.stringify({ok:true,final_url:url,title,content:'Generic navigation and legal links'}), 'https://example.com/article'), null)
  }
  assert.ok(webReadReceipt(JSON.stringify({ok:true,final_url:'https://example.com/docs/login',title:'Implement login authentication',content:'Technical documentation explaining login APIs.'}), 'https://example.com/docs/login'))
})


test('natural language discovery accepts a complete subject without treating it as verified evidence', async () => {
  let fallback = false
  const output = JSON.parse(await searchWeb('星河编辑器 离线版 使用什么引擎', 5, { providers: [
    { id: 'subject-lead', tier: 0, search: async () => [{ title: '星河编辑器离线引擎介绍', url: 'https://example.test/editor-natural', content: '产品说明与技术资料。' }] },
    { id: 'unneeded-fallback', tier: 1, search: async () => { fallback = true; return [] } },
  ] }))
  assert.equal(fallback, false)
  assert.equal(output.evidence_status, 'discovery_only')
  assert.equal(output.results[0].match.confidence, 'lead')
})

test('a partial Chinese brand does not satisfy a complete query subject', async () => {
  let fallback = false
  await searchWeb('星海编辑器 离线版 使用什么引擎', 5, { providers: [
    { id: 'partial-subject', tier: 0, search: async () => [{ title: '星海 离线版', url: 'https://example.test/partial-natural', content: '另一款产品。' }] },
    { id: 'subject-fallback', tier: 1, search: async () => { fallback = true; return [] } },
  ] })
  assert.equal(fallback, true)
})


test('the caller selects lookup or research before discovery without changing available providers', async () => {
  let primary=0, independent=0
  const providers=[
    {id:'depth-primary',tier:0,search:async()=>{primary++;return [{title:'DepthScope216 evidence',url:'https://first.test/depth-scope',content:'DepthScope216 evidence'}]}},
    {id:'depth-independent',tier:1,search:async()=>{independent++;return [{title:'DepthScope216 evidence',url:'https://second.test/depth-scope',content:'DepthScope216 evidence'}]}},
  ]
  const quick=JSON.parse(await searchWeb('DepthScope216 evidence',undefined,{providers,depth:'fact_lookup'}))
  assert.equal(quick.retrieval.depth,'fact_lookup')
  assert.equal(independent,0)
  const deep=JSON.parse(await searchWeb('DepthScope216 evidence',undefined,{providers,depth:'deep_research'}))
  assert.equal(deep.retrieval.depth,'deep_research')
  assert.equal(primary,2)
  assert.equal(independent,1)
  assert.equal(deep.results.length,2)
})


test('a generic product homepage cannot end a lookup for a Chinese qualifying detail', async () => {
  let fallback=false
  const output=JSON.parse(await searchWeb('星云编辑器 离线版 使用什么引擎',5,{providers:[
    {id:'generic-product',tier:0,search:async()=>[{title:'星云编辑器官方网站',url:'https://generic.test/',content:'高效工作，轻松编辑。'}]},
    {id:'qualifying-record',tier:1,search:async()=>{fallback=true;return [{title:'星云编辑器的离线引擎',url:'https://record.test/offline',content:'离线版本使用嵌入式引擎。'}]}},
  ]}))
  assert.equal(fallback,true)
  assert.equal(output.results[0].url,'https://record.test/offline')
})


test('alternate index queries remove question wording while preserving literal clues', () => {
  assert.equal(compactDiscoveryQuery('离线输入法 v4.1 不上传 使用什么模型'),'离线输入法 v4.1 不上传 模型')
  for(const query of ['\"采用什么协议\" v4.1','site:example.test 使用什么模型','离线输入法 不上传']) assert.equal(compactDiscoveryQuery(query),query)
})


test('a page transport deadline cancels stalled adapters and reports unverified content', async () => {
  let aborted = false
  await assert.rejects(readWeb('https://read-fixture.invalid/stalled', 2000, undefined, undefined,
    async (_url, _limit, _timeout, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true })
    }), undefined, undefined, { networkTimeoutMs: 30 }), /timed out|timeout/i)
  assert.equal(aborted, true)
})


test('an explicitly requested renderer receives cancellation when its scoped wait expires', { timeout: 3000 }, async () => {
  let cancelled = 0
  await assert.rejects(readWeb('https://read-fixture.invalid/render-block', 2000,
    async (_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => { cancelled++; reject(Error('render cancelled')) }, { once: true })
    }), undefined, async url => ({ body: Buffer.from('blocked'), status: 403, contentType: 'text/html', finalUrl: url }),
    undefined, undefined, { networkTimeoutMs: 30 }))
  assert.ok(cancelled > 0)
})
