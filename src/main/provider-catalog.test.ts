import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadProviderCatalog, normalizeModelsDevCatalog, recommendProviderModels, reconcileProviderCatalog } from './provider-catalog.ts'
import { compactCloudProviderDeployments, compactProviderModelMenu, type ProviderModel } from '../shared.ts'

const metadata = (overrides: Record<string, unknown> = {}) => ({
  name: 'Model', family: 'general', release_date: '2026-01-01', last_updated: '2026-01-01',
  tool_call: true, reasoning: true, limit: { context: 200_000, output: 32_000 },
  modalities: { input: ['text', 'image'], output: ['text'] }, ...overrides,
})

test('models.dev catalog filters non-agent models and recommends recent families including previews', () => {
  const catalog = normalizeModelsDevCatalog({
    openai: {
      id: 'openai', name: 'OpenAI', models: {
        'general-old': metadata({ name: 'General Old', family: 'general', last_updated: '2025-01-01' }),
        'general-new': metadata({ name: 'General New', family: 'general', last_updated: '2026-07-01' }),
        'coding-new': metadata({ name: 'Coding', family: 'coding', last_updated: '2026-06-01' }),
        'fast-new': metadata({ name: 'Fast', family: 'fast', last_updated: '2026-05-01' }),
        'small-new': metadata({ name: 'Small', family: 'small', last_updated: '2026-04-01' }),
        'new-preview': metadata({ name: 'Preview', family: 'preview', last_updated: '2026-08-01', status: 'beta' }),
        'image-model': metadata({ name: 'Image', family: 'image', modalities: { input: ['text'], output: ['image'] } }),
        'no-tools': metadata({ name: 'No tools', family: 'plain', tool_call: false }),
        'retired': metadata({ name: 'Retired', family: 'retired', status: 'deprecated' }),
      },
    },
  }, 123)
  const openai = catalog.providers.find(provider => provider.id === 'openai')!
  assert.equal(catalog.source, 'models.dev')
  assert.deepEqual(openai.models.map(model => model.id).sort(), ['coding-new', 'fast-new', 'general-new', 'general-old', 'new-preview', 'small-new'].sort())
  assert.deepEqual(openai.featuredModels.map(model => model.id), ['new-preview', 'general-new', 'coding-new', 'fast-new'])
  assert.equal(openai.featuredModels.every(model => model.featured), true)
})

test('recommendations keep model families diverse before filling remaining slots', () => {
  const models: ProviderModel[] = [
    { id: 'a-new', family: 'a', releaseDate: '2026-02-01', contextWindow: 100_000, maxOutputTokens: 10_000 },
    { id: 'a-old', family: 'a', releaseDate: '2025-02-01', contextWindow: 100_000, maxOutputTokens: 10_000 },
    { id: 'b', family: 'b', releaseDate: '2026-01-01', contextWindow: 100_000, maxOutputTokens: 10_000 },
  ]
  assert.deepEqual(recommendProviderModels(models, 2).map(model => model.id), ['a-new', 'b'])
})

test('cloud model menus keep recent models visible and fold historical models away', () => {
  const models: ProviderModel[] = [
    { id: 'moonshot-v1-128k', contextWindow: 128_000, maxOutputTokens: 8_000 },
    { id: 'kimi-k2.6', contextWindow: 256_000, maxOutputTokens: 32_000 },
    { id: 'kimi-k3', featured: true, contextWindow: 256_000, maxOutputTokens: 64_000 },
    { id: 'kimi-k2.7-code', contextWindow: 256_000, maxOutputTokens: 64_000 },
    { id: 'kimi-k2.7-code-highspeed', contextWindow: 256_000, maxOutputTokens: 64_000 },
    { id: 'moonshot-v1-32k', contextWindow: 32_000, maxOutputTokens: 8_000 },
  ]
  const compact = compactProviderModelMenu(models, 'kimi-k3', true, 4)
  assert.deepEqual(compact.primary.map(model => model.id), ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'])
  assert.deepEqual(compact.older.map(model => model.id), ['moonshot-v1-128k', 'moonshot-v1-32k'])
  assert.deepEqual(compactProviderModelMenu(models, 'moonshot-v1-32k', true, 4).primary[0].id, 'moonshot-v1-32k')
  assert.equal(compactProviderModelMenu(models, 'kimi-k3', false, 4).older.length, 0)
})

test('new DeepSeek generations outrank retired compatibility aliases even when aliases were featured', () => {
  const models: ProviderModel[] = [
    { id: 'deepseek-v4-pro', featured: true, lastUpdated: '2026-08-22', contextWindow: 1_000_000, maxOutputTokens: 384_000 },
    { id: 'deepseek-v4-flash', featured: true, lastUpdated: '2026-07-31', contextWindow: 1_000_000, maxOutputTokens: 384_000 },
    { id: 'deepseek-reasoner', featured: true, lastUpdated: '2026-02-28', reasoning: true, contextWindow: 128_000, maxOutputTokens: 64_000 },
    { id: 'deepseek-chat', featured: true, lastUpdated: '2026-02-28', contextWindow: 128_000, maxOutputTokens: 8_192 },
    { id: 'deepseek-v4-flash-vision-exp', lastUpdated: '2026-08-21', status: 'beta', vision: true, contextWindow: 1_000_000, maxOutputTokens: 384_000 },
  ]
  const compact = compactProviderModelMenu(models, 'deepseek-v4-flash', true, 4)
  assert.deepEqual(compact.primary.map(model => model.id), [
    'deepseek-v4-pro',
    'deepseek-v4-flash-vision-exp',
    'deepseek-v4-flash',
  ])
  assert.deepEqual(compact.older.map(model => model.id), ['deepseek-reasoner', 'deepseek-chat'])
})

test('an older catalog cohort cannot displace a newer preview from recommendations', () => {
  const models: ProviderModel[] = [
    { id: 'older-general', releaseDate: '2025-12-01', contextWindow: 128_000, maxOutputTokens: 8_192 },
    { id: 'older-reasoning', releaseDate: '2025-12-01', reasoning: true, contextWindow: 128_000, maxOutputTokens: 64_000 },
    { id: 'deepseek-v4-pro', family: 'v4', releaseDate: '2026-04-24', contextWindow: 1_000_000, maxOutputTokens: 384_000 },
    { id: 'deepseek-v4-flash-vision-exp', family: 'v4-vision', releaseDate: '2026-08-01', status: 'beta', vision: true, contextWindow: 1_000_000, maxOutputTokens: 384_000 },
  ]
  assert.deepEqual(recommendProviderModels(models, 2).map(model => model.id), [
    'deepseek-v4-flash-vision-exp',
    'deepseek-v4-pro',
  ])
})

test('oversized cloud model lists migrate to deployments instead of importing the provider catalog', () => {
  const models = Array.from({ length: 422 }, (_, index): ProviderModel => ({
    id: `model-${index}`, featured: index >= 418, contextWindow: 128_000, maxOutputTokens: 16_000,
  }))
  const compacted = compactCloudProviderDeployments(models, 'model-0')
  assert.equal(compacted.models.length, 4)
  assert.deepEqual(compacted.models.map(model => model.id), ['model-418', 'model-419', 'model-420', 'model-421'])
  assert.equal(compacted.selectedId, 'model-418')
})

test('provider picker keeps exactly eight mainstream entries and verified regional endpoints', () => {
  const catalog = normalizeModelsDevCatalog({}, 123)
  assert.deepEqual(catalog.providers.filter(provider => provider.topLevel).map(provider => provider.id), [
    'openai', 'anthropic', 'google', 'xai', 'zai', 'moonshotai', 'deepseek', 'openrouter',
  ])
  const zai = catalog.providers.find(provider => provider.id === 'zai')!
  assert.deepEqual(zai.variants?.map(variant => [variant.id, variant.endpoint]), [
    ['zhipu-cn', 'https://open.bigmodel.cn/api/paas/v4'],
    ['zai-global', 'https://api.z.ai/api/paas/v4'],
  ])
  assert.deepEqual(catalog.providers.find(provider => provider.id === 'moonshotai')?.variants?.map(variant => [variant.id, variant.endpoint]), [
    ['moonshot-cn', 'https://api.moonshot.cn/v1'],
    ['moonshot-global', 'https://api.moonshot.ai/v1'],
  ])
  assert.deepEqual(catalog.providers.find(provider => provider.id === 'minimax')?.variants?.map(variant => [variant.id, variant.endpoint]), [
    ['minimax-cn', 'https://api.minimaxi.com/v1'],
    ['minimax-global', 'https://api.minimax.io/v1'],
  ])
  const mimoTokenPlan = catalog.providers.find(provider => provider.id === 'xiaomi')?.variants?.find(variant => variant.id === 'xiaomi-token-plan')
  assert.equal(mimoTokenPlan?.requiresEndpoint, true)
  assert.equal(mimoTokenPlan?.endpoint, '')
  assert.equal(catalog.providers.find(provider => provider.id === 'xiaomi')?.topLevel, undefined)
})

test('cached catalogs gain newly bundled providers without waiting for cache expiry', () => {
  const catalog = normalizeModelsDevCatalog({ openai: { name: 'OpenAI', models: { current: metadata() } } }, 123)
  const oldCatalog = { ...catalog, providers: catalog.providers.filter(provider => !['xai', 'xiaomi'].includes(provider.id)) }
  const reconciled = reconcileProviderCatalog(oldCatalog)
  assert.deepEqual(reconciled.providers.slice(0, 5).map(provider => provider.id), ['openai', 'anthropic', 'google', 'xai', 'xiaomi'])
  assert.equal(reconciled.providers.find(provider => provider.id === 'openai')?.models[0]?.id, 'current')
})

test('cached catalogs recompute featured models from fresh metadata instead of preserving an old ranking', () => {
  const catalog = normalizeModelsDevCatalog({
    deepseek: { name: 'DeepSeek', models: {
      old: metadata({ family: 'old', release_date: '2025-01-01', last_updated: '2025-01-01' }),
      current: metadata({ family: 'current', release_date: '2026-08-01', last_updated: '2026-08-01' }),
      preview: metadata({ family: 'preview', release_date: '2026-08-20', last_updated: '2026-08-20', status: 'beta' }),
    } },
  }, 123)
  const deepseek = catalog.providers.find(provider => provider.id === 'deepseek')!
  deepseek.featuredModels = [deepseek.models.find(model => model.id === 'old')!]
  assert.deepEqual(reconcileProviderCatalog(catalog).providers.find(provider => provider.id === 'deepseek')?.featuredModels.map(model => model.id), [
    'preview',
    'current',
  ])
})

test('provider catalog persists an ETag cache and serves stale data on rate limits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shun-provider-catalog-')), cacheFile = join(dir, 'catalog.json')
  let calls = 0
  try {
    const first = await loadProviderCatalog({ cacheFile, now: 1_000, request: async () => {
      calls++
      return new Response(JSON.stringify({ openai: { name: 'OpenAI', models: { fresh: metadata() } } }), { status: 200, headers: { etag: 'catalog-v1', 'content-type': 'application/json' } })
    } })
    assert.equal(first.source, 'fallback')
    assert.deepEqual(first.providers.slice(0, 5).map(provider => provider.id), ['openai', 'anthropic', 'google', 'xai', 'xiaomi'])
    const refreshed = await loadProviderCatalog({ cacheFile, now: 1_000 })
    assert.equal(refreshed.source, 'models.dev')
    assert.equal(JSON.parse(await readFile(cacheFile, 'utf8')).etag, 'catalog-v1')

    const stale = await loadProviderCatalog({ cacheFile, now: 200_000_000, request: async (_url, init) => {
      calls++
      assert.equal(new Headers(init?.headers).get('if-none-match'), 'catalog-v1')
      return new Response('rate limited', { status: 429 })
    } })
    assert.equal(stale.providers.find(provider => provider.id === 'openai')?.models[0]?.id, 'fresh')
    assert.equal(calls, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
