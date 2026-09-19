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
  assert.match(policy.snapshot().reason || '', /no new evidence/i)
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
  assert.match(policy.snapshot().reason || '', /search-call limit reached \(2\)/)
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
  assert.equal(policy.snapshot().networkCalls, 2)
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
    assert.match(policy.snapshot().reason || '', /research time limit reached \(60s\)/)
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
    // A closed tool explains what to do next. The product's own ceiling, phase, reset,
    // and waiting language is what a model turns into an answer about quotas.
    const closed = (policy.beforeToolCall('web_search') || {}).reason || ''
    assert.match(closed, /already discovered/)
    assert.doesNotMatch(closed, /limit|budget|quota|phase|ceiling|wait|reached/i)

    // The same query repeats within a phase, but a later phase may search again.
    mock.timers.tick(5 * 60_000)
    const fresh = JSON.parse(await policy.search('three', async () => searchOutput('three', ['https://example.test/three'])))
    assert.equal(fresh.research.search_exhausted, false)
    assert.equal(fresh.research.exhausted, false)
    assert.equal(policy.snapshot().searchCalls, 1)
    assert.deepEqual(policy.beforeToolCall('web_search'), undefined)
    assert.deepEqual(policy.beforeToolCall('web_read'), undefined)
  } finally {
    mock.timers.reset()
  }
})

test('an answer naming something no opened page contains is sent back while leads remain', async () => {
  const policy = new WebResearchPolicy({ ...generous, verifyUnsupportedClaims: true, maxVerificationRequests: 2 })
  await policy.search('episode list', async () => JSON.stringify({ query: 'episode list', results: [
    { title: 'List of episodes', url: 'https://example.test/episodes', match: { confidence: 'direct' } },
    { title: 'Episode index', url: 'https://example.test/index', match: { confidence: 'lead' } },
  ] }))
  await policy.search('second attempt', async () => JSON.stringify({ query: 'second attempt', results: [] }))
  await policy.read({ url: 'https://example.test/episodes' }, async () => JSON.stringify({
    ok: true, requested_url: 'https://example.test/episodes', final_url: 'https://example.test/episodes',
    content_type: 'text/html', content_offset: 0, content: 'Season two episode four is titled Cero Miedo and opened with a tag match.',
  }))

  const turn = (text: string) => ({
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    context: { messages: [{ role: 'user', content: 'Which episode of the series opened with a three match card?' }] },
  } as any)

  // A conclusion that names no page the run opened is asked for its source first.
  const uncited = await policy.evaluate(turn('The episode is titled Cero Miedo.'))
  assert.equal(uncited.status, 'continue')
  assert.match(uncited.feedback || '', /names no page this run opened/)
  assert.match(uncited.feedback || '', /https:\/\/example\.test\/(episodes|index)/)
  // The request is about the answer, not an audit of how the run read: asking for a
  // candidate-by-candidate account of its own sources is what a model answers instead
  // of the question.
  assert.doesNotMatch(uncited.feedback || '', /candidate|which clue|List the/i)
  // A title the page states is supported, and cited; a value the page never mentions is not.
  const supported = await policy.evaluate(turn('The episode is titled Cero Miedo. https://example.test/episodes'))
  assert.equal(supported.status, 'accept')
  const unsupported = await policy.evaluate(turn('The episode is titled Ultraviolet Mayhem. https://example.test/episodes'))
  assert.equal(unsupported.status, 'continue')
  assert.match(unsupported.feedback || '', /"ultraviolet"/)
  assert.match(unsupported.feedback || '', /none of the pages this run opened/)
  assert.match(unsupported.feedback || '', /https:\/\/example\.test\/index/)

  // It is bounded, and a turn that is still working is not a claim to check.
  await policy.evaluate(turn('The episode is titled Ultraviolet Mayhem. https://example.test/episodes'))
  assert.equal((await policy.evaluate(turn('The episode is titled Ultraviolet Mayhem. https://example.test/episodes'))).status, 'accept')
  assert.equal((await policy.evaluate({ message: { role: 'assistant', content: [{ type: 'text', text: 'Ultraviolet Mayhem' }, { type: 'tool_call' }] }, context: { messages: [] } } as any)).status, 'accept')
})

test('a phase that keeps producing evidence is allowed to keep going', async () => {
  const page = (url: string, body: string) => JSON.stringify({ ok: true, requested_url: url, final_url: url, content_type: 'text/html', content_offset: 0, content: body })
  const generousBase = { ...generous, maxSearchCalls: 2, maxReadCalls: 2, productiveCallBonus: 4 }
  const productive = new WebResearchPolicy(generousBase)
  for (let index = 0; index < 5; index++) {
    await productive.search(`query ${index}`, async () => searchOutput(`query ${index}`, [`https://example.test/${index}`]))
  }
  assert.equal(productive.snapshot().searchExhausted, false)

  // The same budget with searches that teach nothing stops where the base budget says.
  const barren = new WebResearchPolicy(generousBase)
  for (let index = 0; index < 5; index++) {
    await barren.search(`query ${index}`, async () => searchOutput(`query ${index}`, []))
  }
  assert.equal(barren.snapshot().searchExhausted, true)

  // Reads earn the same extension from the evidence they add.
  const reader = new WebResearchPolicy(generousBase)
  for (let index = 0; index < 5; index++) {
    await reader.read({ url: `https://example.test/page-${index}` }, async () => page(`https://example.test/page-${index}`, `new evidence number ${index}`))
  }
  assert.equal(reader.snapshot().readExhausted, false)
})

test('a page is read for the reason it was found, even when no query is supplied', async () => {
  const policy = new WebResearchPolicy(generous)
  // The tool call hook is where the run's own question becomes known to the policy.
  policy.beforeToolCall('web_read', { context: { messages: [{ role: 'user', content: 'Which episode of the series opened with a three match card?' }] } } as any)
  await policy.search('season 2 episode 4 Cero Miedo', async () => JSON.stringify({ query: 'season 2 episode 4 Cero Miedo', results: [
    { title: 'List of episodes', url: 'https://example.test/episodes', match: { confidence: 'direct' } },
  ] }))

  // The originating search and the task are the reason the page is open, and the
  // reader gets them as its query so the returned window follows the answer.
  const request: { url: unknown; query?: unknown } = { url: 'https://example.test/episodes' }
  await policy.read(request, async () => JSON.stringify({ ok: true, requested_url: 'https://example.test/episodes', final_url: 'https://example.test/episodes', content_type: 'text/html', content_offset: 0, content: 'Season two episode four is titled Cero Miedo.' }))
  assert.match(String(request.query), /season 2 episode 4 Cero Miedo/)
  assert.match(String(request.query), /Which episode of the series/)

  // A caller that says what it is looking for narrows the window, and the task stays
  // part of the reason: a caller looking for an episode list still needs the row its
  // clues describe, which is not in the list-page words it searched with.
  const explicit: { url: unknown; query?: unknown } = { url: 'https://example.test/other', query: 'goals scored' }
  await policy.read(explicit, async () => JSON.stringify({ ok: true, requested_url: 'https://example.test/other', final_url: 'https://example.test/other', content_type: 'text/html', content_offset: 0, content: 'goals scored' }))
  assert.equal(explicit.query, 'goals scored Which episode of the series opened with a three match card?')
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

test('a closed web tool reports what to do next instead of the product’s bookkeeping', async () => {
  const policy = new WebResearchPolicy({ ...generous, maxNetworkCalls: 1 })
  const output = JSON.parse(await policy.search('lead', async () => searchOutput('lead', ['https://example.test/lead'])))
  const blocked = policy.beforeToolCall('web_read')?.reason || ''
  const verdict = await policy.evaluate({} as any)

  // Counters, ceilings, phases, and waiting are the product's own bookkeeping. Handed to
  // the model they come back as an answer about quotas, or as advice to wait for one.
  for (const key of ['search_calls', 'read_calls', 'network_calls', 'reason']) assert.equal(key in output.research, false)
  const seen = [output.research.instruction, blocked, verdict.feedback || ''].join('\n')
  assert.doesNotMatch(seen, /limit|budget|quota|ceiling|phase|reached/i)
  assert.match(seen, /Do not wait/)
})

test('a fan-out that named its sources is the citation, so the answer is not sent back for one', async () => {
  const policy = new WebResearchPolicy({ ...generous, verifyUnsupportedClaims: true, maxVerificationRequests: 2 })
  // The explorer read the page it reports, and the finding the lead agent received names it.
  await policy.read({ url: 'https://example.test/episodes' }, async () => JSON.stringify({
    ok: true, requested_url: 'https://example.test/episodes', final_url: 'https://example.test/episodes',
    content_type: 'text/html', content_offset: 0, content: 'Season two episode four is titled Cero Miedo and opened with a tag match.',
  }))
  policy.observe({
    type: 'tool_execution_end', toolCallId: 'fanout-1', toolName: 'research_fanout', isError: false,
    result: { content: [{ type: 'text', text: '### which episode\nSeason two episode four is titled Cero Miedo.\nhttps://example.test/episodes' }] },
  } as any)

  const turn = {
    message: { role: 'assistant', content: [{ type: 'text', text: 'The episode is titled Cero Miedo.' }] },
    context: { messages: [{ role: 'user', content: 'Which episode of the series opened with a three match card?' }] },
  } as any
  // The reader can check the answer against the findings in the transcript: citing it again
  // in prose is not something the answer is sent back for.
  assert.equal((await policy.evaluate(turn)).status, 'accept')
})

test('a call that did not go out says so instead of looking like an empty source', async () => {
  const policy = new WebResearchPolicy({ ...generous, maxNetworkCalls: 1 })
  await policy.search('lead', async () => searchOutput('lead', ['https://example.test/lead']))
  const blocked = JSON.parse(await policy.search('another lead', async () => searchOutput('another lead', ['https://example.test/other'])))
  const read = JSON.parse(await policy.read({ url: 'https://example.test/other' }, async () => 'never fetched'))

  // A closed tool that answers with an empty result list is read as a source with nothing in
  // it, and reported onward as a finding about the web.
  assert.equal(blocked.blocked, true)
  assert.match(blocked.note, /did not go out/)
  assert.equal(read.blocked, true)
  assert.match(read.note, /did not go out/)
  // The explorer that told its lead agent "the search channel is empty" was quoting this
  // shape, so it must not be reopenable as a refusal to answer either.
  assert.match(blocked.note, /Answer from what has already been read/)
})

test('a fan-out pays its own way and leaves the caller’s allowance alone', async () => {
  const policy = new WebResearchPolicy({ ...generous, maxSearchCalls: 2 })
  policy.observe({ type: 'tool_execution_start', toolCallId: 'fanout-1', toolName: 'research_fanout', args: {} } as any)
  for (const question of ['one', 'two', 'three']) await policy.search(question, async () => searchOutput(question, [`https://example.test/${question}`]))

  // The explorers' searches are the fan-out's cost, not the answer's.
  assert.equal(policy.snapshot().searchCalls, 0)
  assert.equal(policy.snapshot().networkCalls, 0)
  assert.equal(policy.snapshot().searchExhausted, false)

  policy.observe({ type: 'tool_execution_end', toolCallId: 'fanout-1', toolName: 'research_fanout', isError: false, result: { content: [] } } as any)
  const after = JSON.parse(await policy.search('the answer’s own question', async () => searchOutput('the answer’s own question', ['https://example.test/answer'])))
  assert.equal(after.number_of_results, 1)
  assert.equal(policy.snapshot().searchCalls, 1)
})

test('an answer is not sent back to verify once no page can be opened', async () => {
  const policy = new WebResearchPolicy({ ...generous, maxNetworkCalls: 2, verifyUnsupportedClaims: true, maxVerificationRequests: 2 })
  await policy.search('episode list', async () => JSON.stringify({ query: 'episode list', results: [
    { title: 'List of episodes', url: 'https://example.test/episodes', match: { confidence: 'direct' } },
  ] }))
  await policy.read({ url: 'https://example.test/episodes' }, async () => JSON.stringify({
    ok: true, requested_url: 'https://example.test/episodes', final_url: 'https://example.test/episodes',
    content_type: 'text/html', content_offset: 0, content: 'Season two episode four is titled Cero Miedo and opened with a tag match.',
  }))

  // With no room left to open a page, sending the answer back to cite one only buys a turn
  // about why it cannot: the answer is asked for instead.
  const verdict = await policy.evaluate({
    message: { role: 'assistant', content: [{ type: 'text', text: 'The episode is titled Ultraviolet Mayhem.' }] },
    context: { messages: [{ role: 'user', content: 'Which episode of the series opened with a three match card?' }] },
  } as any)
  assert.equal(verdict.status, 'continue')
  assert.doesNotMatch(verdict.feedback || '', /open the page|names no page/i)
  assert.match(verdict.feedback || '', /best-supported conclusion/)
})
