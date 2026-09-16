import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { WebResearchPolicy, type WebResearchLimits } from './web-research-policy.ts'

const generous: WebResearchLimits = {
  maxSearchCalls: 20,
  maxReadCalls: 20,
  maxNetworkCalls: 30,
  maxConsecutiveNoGain: 2,
  maxSearchesBeforeRead: 2,
  maxElapsedMs: 60_000,
  phaseIdleMs: 120_000,
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
  assert.match(policy.beforeToolCall('skill_catalog_search')?.reason || '', /web_read/)
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

test('the read phase is pointed at the ranked lead it has not opened yet', async () => {
  const policy = new WebResearchPolicy({ ...generous, maxSearchesBeforeRead: 1 })
  const page = (url: string) => JSON.stringify({ ok: true, requested_url: url, final_url: url, content_type: 'text/html', content_offset: 0, content: 'verified detail' })
  await policy.search('first', async () => JSON.stringify({ query: 'first', results: [
    { title: 'Rival episode list', url: 'https://example.test/rival', match: { confidence: 'lead' } },
    { title: 'The episode list', url: 'https://example.test/list', match: { confidence: 'direct' } },
  ] }))

  // A count told the agent nothing about which page to open; naming the ranked lead does.
  const blocked = policy.beforeToolCall('web_search')?.reason || ''
  assert.match(blocked, /1\. https:\/\/example\.test\/list \(direct\); 2\. https:\/\/example\.test\/rival \(lead\)/)

  // Once a lead is opened it leaves the ladder, so the phase names the next read.
  await policy.read({ url: 'https://example.test/list' }, async () => page('https://example.test/list'))
  assert.deepEqual(policy.snapshot().nextLeads, ['https://example.test/rival'])
})

test('failed page reads count toward convergence and are not retried with a different query', async () => {
  const policy = new WebResearchPolicy({ ...generous, maxReadCalls: 2 })
  let calls = 0
  const run = async () => { calls++; throw Error('HTTP 567 for https://blocked.example/company') }

  await assert.rejects(() => policy.read({ url: 'https://blocked.example/company', query: 'shareholders' }, run), /public web reader.*not evidence.*Chrome.*Do not retry/si)
  await assert.rejects(() => policy.read({ url: 'https://blocked.example/company', query: 'investors' }, run), /HTTP 567/)

  assert.equal(calls, 1)
  assert.equal(policy.snapshot().readExhausted, true)
  assert.ok(policy.beforeToolCall('web_read'))
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

test('the research budget follows research activity instead of the run clock', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  try {
    const policy = new WebResearchPolicy({ ...generous, maxElapsedMs: 60_000 })
    // Files, commands, and downloads occupy the run long before it needs a search.
    mock.timers.tick(30 * 60_000)
    const first = JSON.parse(await policy.search('lead', async () => searchOutput('lead', ['https://example.test/lead'])))
    assert.equal(first.research.exhausted, false)
    assert.equal(first.research.search_exhausted, false)
    assert.equal(first.research.read_exhausted, false)
    assert.equal(policy.beforeToolCall('web_search'), undefined)

    // Continuous research is still bounded: the window covers the burst, not the run.
    mock.timers.tick(30_000)
    const second = JSON.parse(await policy.search('another lead', async () => searchOutput('another lead', ['https://example.test/other'])))
    mock.timers.tick(40_000)
    const third = JSON.parse(await policy.search('third lead', async () => searchOutput('third lead', ['https://example.test/third'])))
    assert.equal(second.research.exhausted, false)
    assert.equal(third.research.exhausted, true)
    assert.match(third.research.reason, /research time limit reached \(60s\)/)
    assert.ok(policy.beforeToolCall('web_read'))
  } finally {
    mock.timers.reset()
  }
})

test('web research opens a fresh bounded phase after the run moves on to other work', async () => {
  mock.timers.enable({ apis: ['Date'], now: 2_000_000 })
  try {
    const policy = new WebResearchPolicy({ ...generous, maxSearchCalls: 2, phaseIdleMs: 120_000 })
    await policy.search('one', async () => searchOutput('one', ['https://example.test/one']))
    const exhausted = JSON.parse(await policy.search('two', async () => searchOutput('two', ['https://example.test/two'])))
    assert.equal(exhausted.research.search_exhausted, true)
    assert.match((policy.beforeToolCall('web_search') || {}).reason || '', /fresh bounded phase/)

    // The same query repeats within a phase, but a later phase may search again.
    mock.timers.tick(5 * 60_000)
    const fresh = JSON.parse(await policy.search('three', async () => searchOutput('three', ['https://example.test/three'])))
    assert.equal(fresh.research.search_exhausted, false)
    assert.equal(fresh.research.exhausted, false)
    assert.equal(fresh.research.search_calls, 1)
    assert.deepEqual(policy.beforeToolCall('web_search'), undefined)
    assert.deepEqual(policy.beforeToolCall('web_read'), undefined)
  } finally {
    mock.timers.reset()
  }
})

test('a stopped research phase asks for a calibrated answer instead of a refusal', async () => {
  const policy = new WebResearchPolicy({ ...generous, maxNetworkCalls: 1 })
  const output = JSON.parse(await policy.search('lead', async () => searchOutput('lead', ['https://example.test/lead'])))

  assert.equal(output.research.exhausted, true)
  assert.match(output.research.instruction, /best-supported conclusion/)
  assert.match(output.research.instruction, /bare refusal/)

  const verdict = await policy.evaluate({} as any)
  assert.equal(verdict.status, 'continue')
  assert.match(verdict.feedback || '', /best-supported conclusion/)
  assert.match(verdict.feedback || '', /bare refusal/)
  assert.match(policy.beforeToolCall('web_read')?.reason || '', /best-supported conclusion/)
})
