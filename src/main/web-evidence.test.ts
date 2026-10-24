import assert from 'node:assert/strict'
import test from 'node:test'
import { supplementSearchEvidence } from './web-evidence.ts'
import { rankAndDedupe } from './web.ts'

const discovery = JSON.stringify({results: [
  {title: 'Reference one', url: 'https://one.example/reference', match: {confidence: 'direct'}},
  {title: 'Reference two', url: 'https://two.example/reference', match: {confidence: 'direct'}},
  {title: 'Third lead', url: 'https://three.example/reference'},
]})
function page(url: string, content = 'Source evidence') {
  return JSON.stringify({ok: true, requested_url: url, final_url: url, title: 'Reference', content_type: 'text/plain', content_offset: 100, content_end: 100 + content.length, content_characters: 10000, has_more: true, content})
}

test('expanded queries retain and read subject-matching references when the primary source is blocked', async () => {
  const query = 'ExampleBrand free version pricing subscription monthly cost 2026'
  const results = rankAndDedupe(query, [
    { title: 'ExampleBrand', url: 'https://examplebrand.test', content: 'Application homepage.' },
    { title: 'ExampleBrand', url: 'https://reference.test/wiki/ExampleBrand', content: 'An overview of the application.' },
  ], 3, true)
  const fetched: string[] = []
  const output = JSON.parse(await supplementSearchEvidence(JSON.stringify({ results }), {
    query,
    read: async url => {
      fetched.push(url)
      if (new URL(url).hostname === 'examplebrand.test') throw Error('Source unavailable')
      return page(url, 'ExampleBrand offers a free version.')
    },
  }))
  assert.deepEqual(fetched.sort(), ['https://examplebrand.test/', 'https://reference.test/wiki/ExampleBrand'])
  assert.equal(output.evidence_status, 'page_excerpts')
  assert.equal(output.pages.find((entry: any) => entry.ok)?.content, 'ExampleBrand offers a free version.')
})

test('source reads overlap, remain bounded, and retain provenance separately from snippets', async () => {
  const started: string[] = []
  let release!: () => void
  const bothStarted = new Promise<void>(resolve => { release = resolve })
  const result = JSON.parse(await supplementSearchEvidence(discovery, {query: 'specific evidence', read: async (url, query, maxChars) => {
    started.push(url)
    assert.equal(query, 'specific evidence')
    assert.equal(maxChars, 3000)
    if (started.length === 2) release()
    await bothStarted
    return page(url)
  }}))
  assert.equal(started.length, 2)
  assert.equal(result.results.length, 3)
  assert.equal(result.pages.length, 2)
  assert.equal(result.evidence_status, 'page_excerpts')
  assert.equal(result.pages[0].final_url, 'https://one.example/reference')
  assert.equal(result.pages[0].content, 'Source evidence')
  assert.equal(result.pages[0].content_offset, 100)
})

test('a failed page does not hide an independently fetched source', async () => {
  const result = JSON.parse(await supplementSearchEvidence(discovery, {query: 'evidence', read: async url => {
    if (url.includes('one.example')) throw Error('not available')
    return page(url)
  }}))
  assert.equal(result.pages[0].ok, false)
  assert.equal(result.pages[1].ok, true)
  assert.equal(result.results.length, 3)
})

test('the short excerpt deadline cancels the underlying readers', async () => {
  let aborted = 0
  const result = JSON.parse(await supplementSearchEvidence(discovery, {query: 'evidence', deadlineMs: 15, read: async (_url, _query, _max, signal) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => { aborted++; reject(Error('stopped')) }, {once: true}))
  }))
  assert.equal(aborted, 2)
  assert.ok(result.pages.every((value: {ok: boolean}) => !value.ok))
  assert.equal(result.evidence_status, 'discovery_only')
})

test('discovery-only requests and empty searches issue no page reads', async () => {
  const read = async () => { throw Error('must not be called') }
  assert.equal(await supplementSearchEvidence(discovery, {query: 'evidence', includeContent: false, read}), discovery)
  const empty = '{"results":[]}'
  assert.equal(await supplementSearchEvidence(empty, {query: 'evidence', read}), empty)
})

test('user cancellation propagates instead of returning cached-looking empty evidence', async () => {
  const controller = new AbortController()
  const running = supplementSearchEvidence(discovery, {query: 'evidence', signal: controller.signal, read: async (_url, _query, _max, signal) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('stopped')), {once: true}))
  })
  controller.abort()
  await assert.rejects(running)
})


test('related results are retained as leads without expanding them into irrelevant page text', async () => {
  const readURLs: string[] = []
  const result = JSON.parse(await supplementSearchEvidence(JSON.stringify({results: [
    {url: 'https://source.example/reference', match: {confidence: 'direct'}},
    {url: 'https://unrelated.example/project', match: {confidence: 'lead'}},
  ]}), {query: 'evidence', read: async url => { readURLs.push(url); return page(url) }}))
  assert.deepEqual(readURLs, ['https://source.example/reference'])
  assert.equal(result.results.length, 2)
})


test('an exhausted overall search deadline does not start speculative page reads', async () => {
  let called = false
  const output = await supplementSearchEvidence(discovery, {query:'source',deadlineMs:0,read:async url => {called=true; return page(url)}})
  assert.equal(output, discovery)
  assert.equal(called, false)
})

test('a second strongly matching article is read even without a primary-domain match', async () => {
  const urls:string[]=[]
  const result=JSON.parse(await supplementSearchEvidence(JSON.stringify({results:[
    {url:'https://one.example/article',match:{confidence:'lead',term_coverage:0.8,matched_terms:4}},
    {url:'https://two.example/article',match:{confidence:'lead',term_coverage:0.75,matched_terms:3}},
    {url:'https://unrelated.example/article',match:{confidence:'lead',term_coverage:0.1,matched_terms:1}},
  ]}),{query:'specific evidence',read:async url=>{urls.push(url);return page(url)}}))
  assert.deepEqual(urls,['https://one.example/article','https://two.example/article'])
  assert.equal(result.pages.length,2)
})

test('a completely read source is not fetched again and unopened evidence remains available', async () => {
  const called:string[]=[]
  const output=JSON.parse(await supplementSearchEvidence(discovery,{query:'source',alreadyReadUrls:new Set(['https://one.example/reference']),read:async url=>{called.push(url);return page(url)}}))
  assert.deepEqual(called,['https://two.example/reference'])
  assert.deepEqual(output.previously_read_sources,['https://one.example/reference'])
  assert.equal(output.pages[0].ok,true)
  assert.equal(output.results.length,3)
})


test('a blocked primary source does not leave a matching alternative unread in the same batch', async () => {
  const started:string[]=[]
  const result=JSON.parse(await supplementSearchEvidence(JSON.stringify({results:[
    {url:'https://product.test/pricing',match:{confidence:'direct',subject_match:true}},
    {url:'https://reference.test/product',match:{confidence:'lead',subject_match:true,term_coverage:0.25,matched_terms:1}},
  ]}),{query:'product free plan',read:async url=>{
    started.push(url)
    if(url.startsWith('https://product.test/'))throw Error('HTTP 403')
    return page(url,'The product offers a free tier.')
  }}))
  assert.deepEqual(started,['https://product.test/pricing','https://reference.test/product'])
  assert.equal(result.pages[0].ok,false)
  assert.equal(result.pages[1].ok,true)
  assert.equal(result.evidence_status,'page_excerpts')
  assert.match(result.pages[1].content,/free tier/)
})

test('excerpt slots reach a different matching source before another primary subdomain', async () => {
  const started:string[]=[]
  await supplementSearchEvidence(JSON.stringify({results:[
    {url:'https://product.test/pricing',match:{confidence:'direct',subject_match:true}},
    {url:'https://social.product.test/',match:{confidence:'direct',subject_match:true}},
    {url:'https://reference.test/product',match:{confidence:'lead',subject_match:true}},
  ]}),{query:'product free plan',maxPages:2,read:async url=>{started.push(url);return page(url)}})
  assert.deepEqual(started,['https://product.test/pricing','https://reference.test/product'])
})
