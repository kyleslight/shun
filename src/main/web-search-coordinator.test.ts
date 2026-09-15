import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FreeSearchCoordinator, fuseCandidates, markSourceBlocked, type SearchProvider } from './web-search-coordinator.ts'

const candidate = (url: string, title = url) => ({ url, title, snippet: title })

test('free search coordinator returns as soon as a concurrent source is sufficient', async () => {
  const calls: string[] = [], providers: SearchProvider[] = [
    { id: 'fast', tier: 0, search: async () => { calls.push('fast'); return [candidate('https://example.test/exact')] } },
    { id: 'fallback', tier: 1, search: async () => { calls.push('fallback'); return [candidate('https://example.test/other')] } },
  ]
  const result = await new FreeSearchCoordinator().search('exact', 5, providers, rows => rows.some(row => row.url === 'https://example.test/exact'))
  assert.deepEqual(calls, ['fast', 'fallback'])
  assert.equal(result.providers[0].status, 'ok')
})

test('free search coordinator expands tiers when early sources have no evidence', async () => {
  const calls: string[] = [], providers: SearchProvider[] = [
    { id: 'empty', tier: 0, search: async () => { calls.push('empty'); return [] } },
    { id: 'fallback', tier: 1, search: async () => { calls.push('fallback'); return [candidate('https://example.test/found')] } },
  ]
  const result = await new FreeSearchCoordinator().search('found', 5, providers, rows => rows.length > 0)
  assert.deepEqual(calls, ['empty', 'fallback'])
  assert.equal(result.results[0].url, 'https://example.test/found')
})

test('a fast sufficient source returns without waiting for the slowest concurrent provider', async () => {
  const slow: SearchProvider = { id: 'slow', tier: 0, search: async () => { await new Promise(resolve => setTimeout(resolve, 150)); return [candidate('https://example.test/slow')] } }
  const fast: SearchProvider = { id: 'fast', tier: 0, search: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return [candidate('https://example.test/exact')] } }
  const started = Date.now(), result = await new FreeSearchCoordinator({ maxParallel: 2 }).search('exact', 5, [slow, fast], rows => rows.some(row => row.url === 'https://example.test/exact'))
  assert.ok(Date.now() - started < 100)
  assert.equal(result.results[0].url, 'https://example.test/exact')
})

// Persistence is asynchronous, so wait for the state instead of assuming a
// fixed delay still holds on a loaded machine.
async function persistedState(storageFile: string) {
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      const state = JSON.parse(await readFile(storageFile, 'utf8'))
      if (state && typeof state === 'object') return state as { health: Record<string, { consecutiveFailures: number }>, cache?: Record<string, unknown> }
    } catch {}
    if (Date.now() >= deadline) throw Error(`Persisted search state did not appear at ${storageFile}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('provider failures trip a persisted circuit breaker without breaking other sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-search-')), storageFile = join(directory, 'state.json')
  let now = 1_000, failures = 0
  const broken: SearchProvider = { id: 'broken', tier: 0, search: async () => { failures++; throw Error('offline') } }
  const healthy: SearchProvider = { id: 'healthy', tier: 1, search: async () => [candidate('https://example.test/healthy')] }
  const coordinator = new FreeSearchCoordinator({ storageFile, failureThreshold: 2, cooldownMs: 10_000, now: () => now })
  await coordinator.search('one', 5, [broken, healthy], rows => rows.length > 0)
  now += 1
  await coordinator.search('two', 5, [broken, healthy], rows => rows.length > 0)
  now += 1
  const third = await coordinator.search('three', 5, [broken, healthy], rows => rows.length > 0)
  assert.equal(failures, 2)
  assert.equal(third.providers.some(item => item.id === 'broken' && item.status === 'cooldown'), true)
  assert.equal((await persistedState(storageFile)).health.broken.consecutiveFailures, 2)
})

test('an anti-bot interstitial benches a channel on the first strike, for longer than a rate limit', async () => {
  let now = 1_000, calls = 0
  const blocked: SearchProvider = { id: 'scraper', tier: 0, search: async () => { calls++; throw markSourceBlocked(Error('consent interstitial'), 'google anti-bot interstitial') } }
  const healthy: SearchProvider = { id: 'healthy', tier: 1, search: async () => [candidate('https://example.test/healthy')] }
  const coordinator = new FreeSearchCoordinator({ failureThreshold: 2, cooldownMs: 10_000, blockedCooldownMs: 60_000, now: () => now })
  const first = await coordinator.search('one', 5, [blocked, healthy], rows => rows.length > 0)
  assert.equal(first.providers.find(item => item.id === 'scraper')?.status, 'blocked')
  now += 1
  const second = await coordinator.search('two', 5, [blocked, healthy], rows => rows.length > 0)
  assert.equal(calls, 1)
  assert.equal(second.providers.find(item => item.id === 'scraper')?.status, 'cooldown')
  assert.match(second.providers.find(item => item.id === 'scraper')?.reason || '', /blocked/i)
  // Still benched after a normal rate-limit cooldown would have expired.
  now += 11_000
  await coordinator.search('three', 5, [blocked, healthy], rows => rows.length > 0)
  assert.equal(calls, 1)
  now += 60_000
  await coordinator.search('four', 5, [blocked, healthy], rows => rows.length > 0)
  assert.equal(calls, 2)
})

test('fresh persistent cache returns immediately without touching providers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-search-cache-')), storageFile = join(directory, 'state.json')
  let calls = 0
  const provider: SearchProvider = { id: 'source', tier: 0, search: async () => { calls++; return [candidate('https://example.test/cached')] } }
  const first = new FreeSearchCoordinator({ storageFile })
  await first.search('same query', 5, [provider], rows => rows.length > 0)
  assert.doesNotMatch(JSON.stringify(await persistedState(storageFile)), /same query/i)
  const second = new FreeSearchCoordinator({ storageFile })
  const result = await second.search(' SAME   QUERY ', 5, [provider], rows => rows.length > 0)
  assert.equal(calls, 1)
  assert.equal(result.cache, 'fresh')
})

test('reciprocal rank fusion rewards agreement and deduplicates tracking URLs', () => {
  const results = fuseCandidates([
    { provider: 'one', rank: 0, candidate: candidate('https://example.test/a?utm_source=x', 'A') },
    { provider: 'one', rank: 1, candidate: candidate('https://example.test/b', 'B') },
    { provider: 'two', rank: 2, candidate: candidate('https://example.test/a', 'Longer A title') },
  ])
  assert.equal(results.length, 2)
  assert.equal(results[0].title, 'Longer A title')
  assert.equal(results[0].engine, 'one,two')
})

test('a source that keeps answering nothing is benched instead of holding a slot', async () => {
  const calls: string[] = [], providers: SearchProvider[] = [
    { id: 'always-empty', tier: 0, search: async () => { calls.push('always-empty'); return [] } },
    { id: 'productive', tier: 1, search: async () => { calls.push('productive'); return [candidate('https://example.test/found')] } },
  ]
  const coordinator = new FreeSearchCoordinator({ emptyThreshold: 2, cooldownMs: 10_000 })
  await coordinator.search('one', 5, providers, rows => rows.length > 0)
  await coordinator.search('two', 5, providers, rows => rows.length > 0)
  calls.length = 0
  const third = await coordinator.search('three', 5, providers, rows => rows.length > 0)
  assert.deepEqual(calls, ['productive'])
  const benched = third.providers.find(item => item.id === 'always-empty')
  assert.equal(benched?.status, 'cooldown')
  assert.match(benched?.reason || '', /no results in 2 consecutive queries/)
})

test('a source that keeps failing backs off instead of waiting a flat cooldown', async () => {
  // A flat multi-minute bench turns one transient blip into a run that reports its
  // search sources as dead, so the wait has to start short and grow only on repeats.
  let now = 1_000
  const failing = (): SearchProvider => ({ id: 'flaky', tier: 0, search: async () => { throw Error('offline') } })
  const coordinator = new FreeSearchCoordinator({ failureThreshold: 1, cooldownMs: 1_000, maxCooldownMs: 4_000, now: () => now })
  const retryAfter = async (label: string, provider: SearchProvider) => (await coordinator.search(label, 5, [provider], () => true)).providers.find(item => item.id === 'flaky')?.retry_in_s

  assert.equal(await retryAfter('one', failing()), 1)
  now += 1_100
  assert.equal(await retryAfter('two', failing()), 2)
  now += 2_100
  assert.equal(await retryAfter('three', failing()), 4)
  now += 4_100
  assert.equal(await retryAfter('four', failing()), 4, 'the wait is capped')

  const recovered: SearchProvider = { id: 'flaky', tier: 0, search: async () => [candidate('https://example.test/ok')] }
  now += 4_100
  await coordinator.search('five', 5, [recovered], () => true)
  now += 1
  assert.equal(await retryAfter('six', failing()), 1, 'a success resets the backoff')
})

test('legacy persisted health without empty counters still benches an unproductive source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-search-legacy-')), storageFile = join(directory, 'state.json')
  await writeFile(storageFile, JSON.stringify({
    version: 1,
    health: { 'always-empty': { failures: 0, successes: 0, consecutiveFailures: 0, cooldownUntil: 0, latencyMs: 100 } },
    cache: {},
  }))
  let calls = 0
  const providers: SearchProvider[] = [
    { id: 'always-empty', tier: 0, search: async () => { calls++; return [] } },
    { id: 'productive', tier: 1, search: async () => [candidate('https://example.test/found')] },
  ]
  const coordinator = new FreeSearchCoordinator({ storageFile, emptyThreshold: 2, cooldownMs: 10_000 })
  await coordinator.search('one', 5, providers, rows => rows.length > 0)
  await coordinator.search('two', 5, providers, rows => rows.length > 0)
  const third = await coordinator.search('three', 5, providers, rows => rows.length > 0)
  assert.equal(calls, 2)
  assert.equal(third.providers.some(item => item.id === 'always-empty' && item.status === 'cooldown'), true)
})

test('a source that recovers is used again after its cooldown', async () => {
  let now = 1_000, available = false
  const provider: SearchProvider = { id: 'flaky', tier: 0, search: async () => available ? [candidate('https://example.test/found')] : [] }
  const coordinator = new FreeSearchCoordinator({ emptyThreshold: 1, cooldownMs: 500, now: () => now })
  const first = await coordinator.search('one', 5, [provider], rows => rows.length > 0)
  assert.equal(first.providers[0].status, 'empty')
  available = true
  now += 1_000
  const second = await coordinator.search('two', 5, [provider], rows => rows.length > 0)
  assert.equal(second.providers[0].status, 'ok')
  assert.equal(second.results[0].url, 'https://example.test/found')
})

test('two callers never hit the same shared source at once', async () => {
  // Bursts are what drive a free source into a rate limit, and a rate-limited
  // source then reads as a broken one, so requests to one source are serialized.
  let inFlight = 0, peak = 0
  const provider: SearchProvider = {
    id: 'shared',
    tier: 0,
    search: async () => {
      peak = Math.max(peak, ++inFlight)
      await new Promise(resolve => setTimeout(resolve, 20))
      inFlight--
      return [candidate('https://example.test/hit')]
    },
  }
  const coordinator = new FreeSearchCoordinator({ minIntervalMs: 0 })
  await Promise.all(['one', 'two', 'three'].map(query => coordinator.search(query, 5, [provider], () => true)))
  assert.equal(peak, 1)
})
