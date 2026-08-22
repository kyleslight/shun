import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSearchQuery, canonicalUrl, contentWindow, curlTransportArguments, curlTransportFailure, extractPageLinks, githubQueryVariants, needsRenderedLinkDiscovery, normalizeWorkspaceCommand, parseFallbackSearch, parseOpenSearchTemplates, parseSearchAnchors, parseSearxInstances, parseSiteIndex, parseSiteSearchDiscovery, pdfPageText, pdfSearchExcerpts, rankAndDedupe, readWeb, searchDeclaredSites, searchIntent, searchWeb, sourceSite, webReadCharacterLimit, webReadCharacterOffset, webReadReceipt } from './web.ts'

test('canonicalUrl removes tracking and unwraps search redirects', () => {
  assert.equal(canonicalUrl('https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fguide%2F%3Futm_source%3Dsearch%26x%3D1'), 'https://example.com/guide?x=1')
  assert.equal(canonicalUrl('javascript:alert(1)'), '')
})

test('web reads stay bounded for small-model context windows', () => {
  assert.equal(webReadCharacterLimit(undefined), 8_000)
  assert.equal(webReadCharacterLimit(15_000), 12_000)
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
