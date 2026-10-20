import assert from 'node:assert/strict'
import test from 'node:test'
import { supplementSearchEvidence } from './web-evidence.ts'

const discovery = JSON.stringify({results: [
  {title: 'Reference one', url: 'https://one.example/reference', match: {confidence: 'direct'}},
  {title: 'Reference two', url: 'https://two.example/reference', match: {confidence: 'direct'}},
  {title: 'Third lead', url: 'https://three.example/reference'},
]})
function page(url: string, content = 'Source evidence') {
  return JSON.stringify({ok: true, requested_url: url, final_url: url, title: 'Reference', content_type: 'text/plain', content_offset: 100, content_end: 100 + content.length, content_characters: 10000, has_more: true, content})
}

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
