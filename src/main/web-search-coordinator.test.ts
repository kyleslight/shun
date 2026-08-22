import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FreeSearchCoordinator, fuseCandidates, type SearchProvider } from './web-search-coordinator.ts'

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
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(JSON.parse(await readFile(storageFile, 'utf8')).health.broken.consecutiveFailures, 2)
})

test('fresh persistent cache returns immediately without touching providers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-search-cache-')), storageFile = join(directory, 'state.json')
  let calls = 0
  const provider: SearchProvider = { id: 'source', tier: 0, search: async () => { calls++; return [candidate('https://example.test/cached')] } }
  const first = new FreeSearchCoordinator({ storageFile })
  await first.search('same query', 5, [provider], rows => rows.length > 0)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.doesNotMatch(await readFile(storageFile, 'utf8'), /same query/i)
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
