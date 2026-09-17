import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSearchQuery, canonicalUrl, classifyRenderedSearch, contentFarmPenalty, distillQuery, fuseRankedResults, parseCrossrefResults, queryWindow, searchPageQuery, searchPageResults, wikipediaQueryVariants, fallbackSearchRequests, parseWikipediaSearch, sourceClass, wikipediaEndpoint, contentWindow, curlTransportArguments, curlTransportFailure, extractPageLinks, githubQueryVariants, isWebChallenge, needsRenderedLinkDiscovery, normalizeWorkspaceCommand, parseFallbackSearch, parseOpenSearchTemplates, parseSearchAnchors, parseSearchApiResults, parseSearxInstances, parseSiteIndex, parseSiteSearchDiscovery, pdfPageText, pdfSearchExcerpts, rankAndDedupe, readWeb, searchDeclaredSites, searchEngineList, searchIntent, searchProviders, searchQueryVariants, searchWeb, sourceSite, transportFailureKind, webReadCharacterLimit, webReadCharacterOffset, webReadReceipt } from './web.ts'

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

test('a query too specific for any page comes back with broader forms of itself', async () => {
  const providers = [{ id: 'empty-index', tier: 0, search: async () => [] }]
  const thin = JSON.parse(await searchWeb('wrestler named after a famous landmark defeated by a king gimmick AEW Dark episode three matches', 5, { providers }))
  // The run is told how to widen instead of repeating the same shape of query.
  assert.ok(thin.suggested_queries.length > 0)
  assert.ok(thin.suggested_queries.every(query => query !== thin.query))
  assert.match(thin.suggestion_note, /too specific/)

  // A query that found results is not told to widen.
  const found = [{ id: 'index', tier: 0, search: async () => [1, 2, 3, 4, 5].map(index => ({ title: `marsgame 海外 游戏 官网 ${index}`, url: `https://example.test/${index}`, content: 'marsgame 海外 游戏 官网' })) }]
  const rich = JSON.parse(await searchWeb('marsgame 海外 游戏 官网', 5, { providers: found }))
  assert.equal(rich.suggested_queries, undefined)
})

test('a read with a query returns the region that carries the query, not the page top', () => {
  const filler = index => `Filler paragraph ${index} with no clue words at all in it whatsoever`
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
  assert.equal(results.find(item => item.url.includes('qcc'))?.match.confidence, 'direct')
  assert.equal(results[0].url, 'https://www.qcc.com/firm/example')
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
    assert.ok(['wikipedia-search', 'webserp'].includes(free[0].id))
    assert.equal(free.some(provider => provider.id === 'search-api'), false)
  })
  withEnvironment('BRAVE_SEARCH_API_KEY', 'test-key', () => {
    const providers = searchProviders({ sites: [] })
    assert.equal(providers[0].id, 'search-api')
    assert.equal(providers[0].tier, 0)
    assert.equal(providers.find(provider => provider.id === 'webserp')?.tier, 1)
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

test('web search widens itself once when the subject domain was not reached, and says what it tried', async () => {
  const queries: string[] = []
  const providers = [{
    id: 'index', tier: 0, search: async (query: string) => {
      queries.push(query)
      return query.includes('marsgame') && !query.includes('官网')
        ? [{ title: 'MarsGame 官方网站', url: 'https://www.marsgame.hk/', content: 'MarsGame 火游网络 海外发行' }]
        : [{ title: 'MarsGame 微信号 -135编辑器', url: 'https://www.135editor.com/wxes/17935', content: 'MarsGame 游戏 官网 海外 资料' }]
    },
  }]
  const output = JSON.parse(await searchWeb('MARSGAME 游戏 官网 海外', 5, { providers }))
  assert.equal(output.direct_matches, 1)
  // The subject's own domain must lead, ahead of an article that merely mentions it.
  assert.equal(output.results[0].url, 'https://www.marsgame.hk/')
  assert.equal(output.results[0].match.confidence, 'direct')
  assert.deepEqual(output.widening.queries_tried, ['marsgame'])
  assert.ok(queries.includes('marsgame'))
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
  // A curated article about an entity is the record of it, not a community mention:
  // demoting it is how the answer ranked below the articles that mention the answer.
  assert.equal(sourceClass('https://en.wikipedia.org/wiki/Raffaele_Contigiani'), 'official_or_primary_candidate')
  assert.equal(sourceClass('https://www.reddit.com/r/architecture'), 'community_or_reference_lead')
})
