import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalUrl, contentWindow, curlTransportArguments, curlTransportFailure, githubQueryVariants, normalizeWorkspaceCommand, parseFallbackSearch, parseSiteIndex, pdfSearchExcerpts, rankAndDedupe, sourceSite, webReadCharacterLimit, webReadCharacterOffset, webReadReceipt } from './web.ts'

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

test('ranking deduplicates canonical URLs and favors primary candidates', () => {
  const results = rankAndDedupe('migration guide', [
    { title: 'Migration guide', url: 'https://blog.example/migration?utm_campaign=x', snippet: 'migration guide', engine: 'one' },
    { title: 'Migration guide duplicate', url: 'https://blog.example/migration', snippet: 'migration guide', engine: 'two' },
    { title: 'Official migration guide', url: 'https://agency.gov/docs/migration', snippet: 'migration guide', engine: 'three' }
  ], 5)
  assert.equal(results.length, 2)
  assert.equal(results[0].url, 'https://agency.gov/docs/migration')
})

test('declared site indexes expose relevant internal documentation links', () => {
  const results = parseSiteIndex('<nav><a href="/overlay/latest.html">Overlay Specification</a><a href="https://elsewhere.test/no">Other</a></nav>', 'https://spec.openapis.org/')
  assert.deepEqual(results.map(result => result.url), ['https://spec.openapis.org/overlay/latest.html'])
})

test('technical searches add bounded GitHub repository discovery variants', () => {
  assert.deepEqual(githubQueryVariants('OpenAPI Overlay Specification site:github.com'), ['overlay-specification in:name', 'OpenAPI Overlay Specification in:name,description'])
  assert.deepEqual(githubQueryVariants('weather tomorrow'), [])
})
