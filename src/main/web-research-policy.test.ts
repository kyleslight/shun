import assert from 'node:assert/strict'
import test from 'node:test'
import { WebResearchPolicy, type WebResearchLimits } from './web-research-policy.ts'

const generous: WebResearchLimits = {
  maxSearchCalls: 20,
  maxReadCalls: 20,
  maxNetworkCalls: 30,
  maxConsecutiveNoGain: 2,
  maxElapsedMs: 60_000,
}

function searchOutput(query: string, urls: string[]) {
  return JSON.stringify({ query, number_of_results: urls.length, results: urls.map((url, index) => ({ title: `Result ${index}`, url, snippet: '', engine: 'test', source_class: 'other_candidate' })) })
}

test('run-scoped web research caches equivalent queries and converges after repeated zero gain', async () => {
  const policy = new WebResearchPolicy(generous)
  let networkRuns = 0
  const run = async () => { networkRuns++; return searchOutput('Exact title', ['https://example.test/video']) }

  const first = JSON.parse(await policy.search('"Exact title"', run))
  const second = JSON.parse(await policy.search('  "exact   title" ', run))
  const third = JSON.parse(await policy.search('“EXACT TITLE”', run))

  assert.equal(networkRuns, 1)
  assert.equal(first.research.new_evidence, 1)
  assert.equal(second.research.cached, true)
  assert.equal(third.research.exhausted, false)
  assert.equal(third.research.search_exhausted, true)
  assert.equal(third.research.read_exhausted, false)
  assert.match(third.research.reason, /no new evidence/i)
  assert.equal(policy.evaluate({} as any).status, 'continue')
  assert.equal(policy.evaluate({} as any).status, 'accept')
  assert.match(policy.beforeToolCall('web_search')?.reason || '', /web_read/)
  assert.equal(policy.beforeToolCall('web_read'), undefined)
})

test('search cache keeps operators, exact phrases, and structured constraints semantically distinct', async () => {
  const policy = new WebResearchPolicy(generous)
  let calls = 0
  const run = async () => { calls++; return searchOutput('', [`https://example.test/${calls}`]) }
  await policy.search('exact title', run)
  await policy.search('"exact title"', run)
  await policy.search({ query: 'exact title', site: 'example.test', exactPhrases: ['publisher'] }, run)
  assert.equal(calls, 3)
})

test('search budget exhaustion preserves the page-verification phase', async () => {
  const policy = new WebResearchPolicy({ ...generous, maxSearchCalls: 2 })
  let calls = 0
  const first = JSON.parse(await policy.search('one', async () => { calls++; return searchOutput('one', ['https://example.test/one']) }))
  const second = JSON.parse(await policy.search('two', async () => { calls++; return searchOutput('two', ['https://example.test/two']) }))

  assert.equal(calls, 2)
  assert.equal(first.research.exhausted, false)
  assert.equal(second.research.exhausted, false)
  assert.equal(second.research.search_exhausted, true)
  assert.equal(second.research.read_exhausted, false)
  assert.match(second.research.reason, /search-call limit reached \(2\)/)
  assert.ok(policy.beforeToolCall('web_search'))
  assert.equal(policy.beforeToolCall('web_read'), undefined)

  const read = JSON.parse(await policy.read({ url: 'https://example.test/two', query: 'exact clue' }, async () => JSON.stringify({
    ok: true,
    requested_url: 'https://example.test/two',
    final_url: 'https://example.test/two',
    content_type: 'text/html',
    content_offset: 0,
    content: 'verified detail',
  })))
  assert.equal(read.research.new_evidence, 1)
  assert.equal(read.research.read_exhausted, false)
})

test('web reads reuse identical content windows without another network operation', async () => {
  const policy = new WebResearchPolicy(generous)
  let calls = 0
  const input = { url: 'https://example.test/article?utm_source=x', query: 'needle', maxChars: 8000, offset: 0 }
  const run = async () => {
    calls++
    return JSON.stringify({ ok: true, requested_url: input.url, final_url: 'https://example.test/article', content_type: 'text/html', title: 'Article', content_offset: 0, content: 'useful evidence' })
  }

  const first = JSON.parse(await policy.read(input, run))
  const second = JSON.parse(await policy.read({ ...input, url: 'https://example.test/article' }, run))

  assert.equal(calls, 1)
  assert.equal(first.research.new_evidence, 1)
  assert.equal(second.research.cached, true)
  assert.equal(second.research.new_evidence, 0)
})

test('distinct empty searches still converge through the generic no-evidence rule', async () => {
  const policy = new WebResearchPolicy(generous)
  const empty = async () => searchOutput('', [])
  const first = JSON.parse(await policy.search('first attempt', empty))
  const second = JSON.parse(await policy.search('different wording', empty))

  assert.equal(first.research.exhausted, false)
  assert.equal(second.research.exhausted, false)
  assert.equal(second.research.search_exhausted, true)
  assert.equal(second.research.network_calls, 2)
  assert.match(second.research.instruction, /web_read/)
})

test('global network ceiling blocks both discovery and verification', async () => {
  const policy = new WebResearchPolicy({ ...generous, maxNetworkCalls: 1 })
  const first = JSON.parse(await policy.search('lead', async () => searchOutput('lead', ['https://example.test/lead'])))

  assert.equal(first.research.exhausted, true)
  assert.equal(first.research.search_exhausted, true)
  assert.equal(first.research.read_exhausted, true)
  assert.ok(policy.beforeToolCall('web_search'))
  assert.ok(policy.beforeToolCall('web_read'))
})
