import assert from 'node:assert/strict'
import test from 'node:test'
import { decisionRouteForEndpoint, decisionRouteForId, decisionRoutes, defaultComputerUseAcceleration, type Provider } from '../shared.ts'
import { decisionsEndpointFor, normalizeDecisionResponse, OpenRouterJevClient, OPENROUTER_DECISIONS_ENDPOINT, resolveComputerUseAcceleration } from './jev-client.ts'

function openRouterProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'openrouter', name: 'OpenRouter', kind: 'cloud', catalogId: 'openrouter', api: 'openai-completions',
    endpoint: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test', contextWindow: 32_768, ...overrides,
  }
}

test('acceleration resolves only when a compatible credential already exists', () => {
  assert.equal(resolveComputerUseAcceleration({ providers: [] }), undefined)
  assert.equal(resolveComputerUseAcceleration({ providers: [openRouterProvider({ apiKey: '' })] }), undefined)
  assert.equal(resolveComputerUseAcceleration({ providers: [openRouterProvider({ apiKey: '   ' })] }), undefined)
  assert.equal(resolveComputerUseAcceleration({ providers: [openRouterProvider({ enabled: false })] }), undefined)
  assert.equal(resolveComputerUseAcceleration({ providers: [openRouterProvider()], computerUseAcceleration: { enabled: false } }), undefined)
  assert.equal(resolveComputerUseAcceleration({ providers: [openRouterProvider({ catalogId: 'custom', id: 'mine', endpoint: 'https://api.example.com/v1' })] }), undefined)

  const resolved = resolveComputerUseAcceleration({ providers: [openRouterProvider()] })
  assert.equal(resolved?.providerId, 'openrouter')
  assert.equal(resolved?.model, 'typesafe/jev-1.13')
  assert.equal(resolved?.endpoint, OPENROUTER_DECISIONS_ENDPOINT)
  assert.equal(resolved?.minActionConfidence, defaultComputerUseAcceleration.minActionConfidence)
  assert.equal(resolved?.minCompletionConfidence, defaultComputerUseAcceleration.minCompletionConfidence)

  // A user's own provider entry pointing at the same service is still reusable,
  // and an explicitly named provider is honoured before the default lookup.
  const renamed = resolveComputerUseAcceleration({ providers: [openRouterProvider({ id: 'or-2', catalogId: undefined })] })
  assert.equal(renamed?.providerId, 'or-2')
  const tuned = resolveComputerUseAcceleration({
    providers: [openRouterProvider(), openRouterProvider({ id: 'second', catalogId: undefined })],
    computerUseAcceleration: { providerId: 'second', model: 'typesafe/jev-latest', maxSteps: 4, timeoutMs: 2_000, minActionConfidence: 0.95 },
  })
  assert.equal(tuned?.model, 'typesafe/jev-latest')
  assert.equal(tuned?.minActionConfidence, 0.95)
  assert.equal(tuned?.maxSteps, 4)
  assert.equal(tuned?.timeoutMs, 2_000)
  // A configuration value outside the supported range is clamped, not honoured.
  assert.equal(resolveComputerUseAcceleration({ providers: [openRouterProvider()], computerUseAcceleration: { maxSteps: 400, timeoutMs: 5 } })?.maxSteps, 30)
  assert.equal(resolveComputerUseAcceleration({ providers: [openRouterProvider()], computerUseAcceleration: { maxSteps: 400, timeoutMs: 5 } })?.timeoutMs, 1_000)
})

test('the decisions endpoint sits beside the configured provider endpoint', () => {
  assert.equal(decisionsEndpointFor('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/alpha/decisions')
  assert.equal(decisionsEndpointFor('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/alpha/decisions')
  assert.equal(decisionsEndpointFor('not a url'), OPENROUTER_DECISIONS_ENDPOINT)
  // A gateway provider is recognised by host, so its credential reaches the right route.
  assert.equal(decisionsEndpointFor('https://ai-gateway.vercel.sh/v1'), decisionRoutes.vercel.endpoint)
  assert.equal(decisionsEndpointFor('https://api.typesafe.ai/v1'), decisionRoutes.typesafe.endpoint)
})

test('every supported decision service is recognised by host and by name', () => {
  assert.equal(decisionRouteForEndpoint('https://api.typesafe.ai/v1')?.id, 'typesafe')
  assert.equal(decisionRouteForEndpoint('https://ai-gateway.vercel.sh/v1')?.id, 'vercel')
  assert.equal(decisionRouteForEndpoint('https://openrouter.ai/api/v1')?.id, 'openrouter')
  assert.equal(decisionRouteForEndpoint('https://api.example.com/v1'), undefined)
  assert.equal(decisionRouteForEndpoint(''), undefined)
  assert.equal(decisionRouteForId('TypeSafe')?.model, 'jev-latest')
  assert.equal(decisionRouteForId('vercel')?.model, 'typesafe-ai/jev')
  assert.equal(decisionRouteForId('openrouter')?.model, 'typesafe/jev-1.13')
  assert.equal(decisionRouteForId('not-a-route'), undefined)
})

test('a decision service is reached through whichever provider already has its credential', () => {
  // The official service, with no gateway provider configured at all.
  const official = resolveComputerUseAcceleration({ providers: [decisionProvider('typesafe', 'https://api.typesafe.ai/v1')] })
  assert.equal(official?.route, 'typesafe')
  assert.equal(official?.endpoint, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(official?.model, 'jev-latest')
  assert.equal(official?.providerId, 'typesafe')

  // A gateway provider resolves to the gateway route and the gateway model id.
  const gateway = resolveComputerUseAcceleration({ providers: [decisionProvider('vercel', 'https://ai-gateway.vercel.sh/v1')] })
  assert.equal(gateway?.route, 'vercel')
  assert.equal(gateway?.endpoint, 'https://ai-gateway.vercel.sh/typesafe/v1/systemone')
  assert.equal(gateway?.model, 'typesafe-ai/jev')

  // Naming a route picks that route's endpoint even when another service is configured.
  const named = resolveComputerUseAcceleration({
    providers: [openRouterProvider(), decisionProvider('typesafe', 'https://api.typesafe.ai/v1')],
    computerUseAcceleration: { provider: 'typesafe' },
  })
  assert.equal(named?.route, 'typesafe')
  assert.equal(named?.model, 'jev-latest')

  // Naming a route nobody has a credential for resolves to nothing at all.
  assert.equal(resolveComputerUseAcceleration({ providers: [openRouterProvider()], computerUseAcceleration: { provider: 'typesafe' } }), undefined)

  // An explicit credential for a service Shun does not know by name is honoured as given.
  const custom = resolveComputerUseAcceleration({
    providers: [],
    computerUseAcceleration: { endpoint: 'https://decisions.example.com/v1/evaluate', apiKey: 'k', model: 'local-reflex-1' },
  })
  assert.equal(custom?.route, undefined)
  assert.equal(custom?.endpoint, 'https://decisions.example.com/v1/evaluate')
  assert.equal(custom?.model, 'local-reflex-1')

  // A provider on an unknown host is not resolved on a guess: Shun cannot know
  // where that service keeps its decision endpoint.
  assert.equal(resolveComputerUseAcceleration({ providers: [decisionProvider('custom', 'https://api.example.com/v1')] }), undefined)
  assert.equal(
    resolveComputerUseAcceleration({
      providers: [decisionProvider('custom', 'https://api.example.com/v1')],
      computerUseAcceleration: { provider: 'custom', endpoint: 'https://api.example.com/v1/evaluate', model: 'custom-decision' },
    })?.model,
    'custom-decision',
  )
})

function decisionProvider(id: string, endpoint: string, overrides: Partial<Provider> = {}): Provider {
  return { id, name: id, kind: 'cloud', api: 'openai-completions', endpoint, apiKey: 'secret-key', contextWindow: 32_768, ...overrides }
}

test('only typed answers Shun can act on survive normalization', () => {
  const response = normalizeDecisionResponse({
    model: 'jev-1.13.0',
    answers: {
      urgent: { type: 'noul', noul: 0.95 },
      unreadable_noul: { type: 'noul', noul: 'yes' },
      missing_choice: { type: 'choice' },
      partial: { type: 'choice', choice: 'click:18', confidence: 0.8, probabilities: { 'click:18': 0.9, escalate: 'unknown' } },
      scored: { type: 'score', score: 1.4 },
      prose: { text: 'I would click Settings.' },
    },
    usage: { input_tokens: 296, output_tokens: 20 },
  })

  assert.deepEqual(Object.keys(response.answers).sort(), ['partial', 'scored', 'urgent'])
  assert.deepEqual(response.answers.partial, { type: 'choice', choice: 'click:18', probabilities: { 'click:18': 0.9 }, confidence: 0.8 })
  assert.equal(response.usage?.inputTokens, 296)
})

test('the decision client sends typed questions to the decisions endpoint', async () => {
  const seen: Array<{ url: string; body: any; authorization: string | undefined }> = []
  const fetchImpl = (async (url: any, init: any) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)), authorization: init?.headers?.authorization })
    return new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: { done: { type: 'noul', noul: 0.97 }, next: { type: 'choice', choice: 'click:18', probabilities: { 'click:18': 0.98, escalate: 0.02 }, confidence: 0.9 } },
      usage: { input_tokens: 42, output_tokens: 3 },
    }), { status: 200 })
  }) as unknown as typeof fetch

  const client = new OpenRouterJevClient({ apiKey: 'sk-secret', fetchImpl })
  const response = await client.decide({
    model: 'typesafe/jev-1.13',
    state: { goal: 'Open settings' },
    questions: { done: { type: 'noul', instructions: 'Complete?', criteria: { true: 'yes', false: 'no' } } },
  })

  assert.equal(seen[0].url, OPENROUTER_DECISIONS_ENDPOINT)
  assert.equal(seen[0].authorization, 'Bearer sk-secret')
  assert.equal(seen[0].body.model, 'typesafe/jev-1.13')
  assert.deepEqual(seen[0].body.state, { goal: 'Open settings' })
  assert.deepEqual(Object.keys(seen[0].body.questions), ['done'])
  assert.deepEqual(response.answers.next, { type: 'choice', choice: 'click:18', probabilities: { 'click:18': 0.98, escalate: 0.02 }, confidence: 0.9 })
})

test('a failed or unreadable decision response stays in Shun’s own words', async () => {
  const failing = new OpenRouterJevClient({ apiKey: 'k', fetchImpl: (async () => new Response('upstream', { status: 502 })) as unknown as typeof fetch })
  await assert.rejects(
    () => failing.decide({ model: 'm', state: {}, questions: {} }),
    (error: Error) => {
      assert.match(error.message, /unavailable/i)
      assert.match(error.message, /normal Browser Use tools/i)
      assert.doesNotMatch(error.message, /openrouter|typesafe|api key|bearer/i)
      return true
    },
  )

  const unreadable = new OpenRouterJevClient({ apiKey: 'k', fetchImpl: (async () => new Response('<html>gateway</html>', { status: 200 })) as unknown as typeof fetch })
  await assert.rejects(() => unreadable.decide({ model: 'm', state: {}, questions: {} }), /could not be read/i)
})

test('a read-only decision is repeated when the service is busy, and a malformed one is not', async () => {
  // Backpressure is not a refusal: a busy service is asked again, with a short backoff, and
  // the answer that finally arrives is the answer.
  const statuses = [429, 503, 200]
  let calls = 0
  const busy = new OpenRouterJevClient({
    apiKey: 'k', retryDelayMs: 0,
    fetchImpl: (async () => {
      const status = statuses[Math.min(calls, statuses.length - 1)]
      calls += 1
      return status === 200
        ? new Response(JSON.stringify({ answers: { done: { type: 'noul', noul: 0.9 } } }), { status })
        : new Response('busy', { status })
    }) as unknown as typeof fetch,
  })
  const recovered = await busy.decide({ model: 'm', state: {}, questions: {} })
  assert.equal(recovered.answers.done.type, 'noul')
  assert.equal(calls, 3, 'the original attempt and two retries')

  // Past the limit the failure is reported in Shun's own words and never as a provider's.
  let always = 0
  const failing = new OpenRouterJevClient({
    apiKey: 'k', retryDelayMs: 0,
    fetchImpl: (async () => { always += 1; return new Response('busy', { status: 503 }) }) as unknown as typeof fetch,
  })
  await assert.rejects(() => failing.decide({ model: 'm', state: {}, questions: {} }), (error: Error) => {
    assert.match(error.message, /unavailable/i)
    assert.match(error.message, /normal Browser Use tools/i)
    assert.doesNotMatch(error.message, /503|openrouter|bearer/i)
    return true
  })
  assert.equal(always, 3, 'the original attempt and two retries')

  // A request that never reached the service is repeated too, because nothing was decided on
  // the strength of the answer it never gave.
  let offline = 0
  const network = new OpenRouterJevClient({
    apiKey: 'k', retryDelayMs: 0,
    fetchImpl: (async () => { offline += 1; throw new TypeError('fetch failed') }) as unknown as typeof fetch,
  })
  await assert.rejects(() => network.decide({ model: 'm', state: {}, questions: {} }), /unavailable/i)
  assert.equal(offline, 3)

  // A refusal is a decision about this request, not a busy moment, so it is never repeated.
  let refused = 0
  const bad = new OpenRouterJevClient({
    apiKey: 'k', retryDelayMs: 0,
    fetchImpl: (async () => { refused += 1; return new Response('nope', { status: 400 }) }) as unknown as typeof fetch,
  })
  await assert.rejects(() => bad.decide({ model: 'm', state: {}, questions: {} }), /unavailable/i)
  assert.equal(refused, 1)
})

test('a probability outside zero to one is dropped rather than rounded into a choice', () => {
  const response = normalizeDecisionResponse({
    answers: {
      next: { type: 'choice', choice: 'click:18', probabilities: { 'click:18': 1.4, 'click:19': -0.2, 'click:20': 'lots' } },
    },
  })
  assert.deepEqual(response.answers.next, { type: 'choice', choice: 'click:18' })
})
