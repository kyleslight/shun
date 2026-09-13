import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { extractPluginArchive, pluginPackageDigest } from '../src/main/plugin-archive.ts'
import { buildMarketplaceCatalog } from './src/build-catalog.ts'
import { handleRegistryRequest, type RegistryBucket, type RegistryEnv } from './src/registry.ts'
import { marketplaceArchiveKey, marketplaceCatalogKey, marketplaceManifestKey, parseMarketplaceDeepLink, type MarketplaceCatalog } from '../src/marketplace.ts'

const archiveBytes = new Uint8Array([1, 2, 3, 4, 5])
const catalog: MarketplaceCatalog = {
  updatedAt: '2026-09-13T00:00:00.000Z',
  entries: [
    {
      id: 'regex-tester', name: 'Regex Tester', description: 'Try a regular expression against sample text.', publisher: 'Shun',
      keywords: ['regex', 'text'], license: 'MIT', permissions: [], latest: '0.1.0', updatedAt: '2026-09-13T00:00:00.000Z', example: true,
      versions: [{ version: '0.1.0', publishedAt: '2026-09-13T00:00:00.000Z', engines: { shun: '>=0.1.34' }, sha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), files: 5, bytes: 6787, archiveBytes: 5 }],
    },
    {
      id: 'git-notes', name: 'Git Notes', description: 'Keep per-branch notes next to a repository.', publisher: 'someone',
      permissions: [{ id: 'workspace.git.read', reason: 'Read the current branch.' }], latest: '1.0.0', updatedAt: '2026-09-12T00:00:00.000Z',
      versions: [{ version: '1.0.0', publishedAt: '2026-09-12T00:00:00.000Z', sha256: 'c'.repeat(64), contentSha256: 'd'.repeat(64), files: 3, bytes: 100, archiveBytes: 5 }],
    },
  ],
}

function bucket(): RegistryBucket {
  const objects = new Map<string, { text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>([
    [marketplaceCatalogKey(), { text: async () => JSON.stringify(catalog), arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(catalog)).buffer }],
    [marketplaceManifestKey('regex-tester', '0.1.0'), { text: async () => JSON.stringify({ schemaVersion: 1, id: 'regex-tester', version: '0.1.0' }), arrayBuffer: async () => new ArrayBuffer(0) }],
    [marketplaceArchiveKey('regex-tester', '0.1.0', 'b'.repeat(64)), { text: async () => '', arrayBuffer: async () => archiveBytes.buffer.slice(0) }],
  ])
  return { get: async key => objects.get(key) ?? null }
}

const env: RegistryEnv = { ARCHIVES: bucket(), ENV: 'production' }
const get = (path: string, init?: RequestInit) => handleRegistryRequest(new Request(`https://api.shunagent.com${path}`, init), env)

test('health reports the catalog the worker is actually serving', async () => {
  const response = await get('/v1/health')
  assert.equal(response.status, 200)
  const body = await response.json() as { status: string; plugins: number; environment: string }
  assert.equal(body.status, 'ok')
  assert.equal(body.plugins, 2)
  assert.equal(body.environment, 'production')
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('search returns summaries ranked by relevance and never leaks versions', async () => {
  const all = await (await get('/v1/plugins')).json() as { results: { id: string }[]; updatedAt: string }
  assert.deepEqual(all.results.map(item => item.id), ['git-notes', 'regex-tester'])
  assert.equal(all.updatedAt, catalog.updatedAt)

  const exact = await (await get('/v1/plugins?q=regex-tester')).json() as { results: { id: string }[] }
  assert.deepEqual(exact.results.map(item => item.id), ['regex-tester'])

  const keyword = await (await get('/v1/plugins?q=text')).json() as { results: { id: string }[] }
  assert.deepEqual(keyword.results.map(item => item.id), ['regex-tester'])

  const limited = await (await get('/v1/plugins?limit=1')).json() as { results: unknown[] }
  assert.equal(limited.results.length, 1)

  const response = await get('/v1/plugins?q=regex')
  const body = await response.json() as { results: Record<string, unknown>[] }
  assert.equal('versions' in body.results[0], false)
  assert.equal(body.results[0].permissions instanceof Array, true)
})

test('detail and per-version manifests come from the catalog and the bucket', async () => {
  const detail = await get('/v1/plugins/regex-tester')
  assert.equal(detail.status, 200)
  const entry = await detail.json() as { id: string; latest: string; versions: unknown[] }
  assert.equal(entry.id, 'regex-tester')
  assert.equal(entry.latest, '0.1.0')
  assert.equal(entry.versions.length, 1)

  const published = await (await get('/v1/plugins/regex-tester/versions/0.1.0')).json() as { manifest: { id: string }; sha256: string }
  assert.equal(published.manifest.id, 'regex-tester')
  assert.equal(published.sha256, 'a'.repeat(64))

  assert.equal((await get('/v1/plugins/missing')).status, 404)
  assert.equal((await get('/v1/plugins/regex-tester/versions/9.9.9')).status, 404)
  assert.equal((await get('/v1/plugins/regex-tester/versions/0.1.0/download/extra')).status, 404)
  assert.equal((await get('/v1/plugins/regex-tester/unknown/0.1.0')).status, 404)
  assert.equal((await get('/v1/plugins/Not-Valid')).status, 400)
  assert.equal((await get('/v2/plugins')).status, 404)
})

test('a download carries the bytes and both published digests', async () => {
  const response = await get(`/v1/plugins/regex-tester/versions/0.1.0/download`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.equal(response.headers.get('x-shun-archive-sha256'), 'a'.repeat(64))
  assert.equal(response.headers.get('x-shun-content-sha256'), 'b'.repeat(64))
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), archiveBytes)

  const missing = await get('/v1/plugins/git-notes/versions/1.0.0/download')
  assert.equal(missing.status, 404)
  assert.equal((await missing.json() as { error: string }).error, 'archive_missing')
})

test('write methods are refused and CORS stays inside the allowed origins', async () => {
  assert.equal((await get('/v1/plugins', { method: 'POST' })).status, 405)
  assert.equal((await get('/v1/plugins', { method: 'OPTIONS' })).status, 204)

  const website = await get('/v1/plugins', { headers: { origin: 'https://shunagent.com' } })
  assert.equal(website.headers.get('access-control-allow-origin'), 'https://shunagent.com')
  const stranger = await get('/v1/plugins', { headers: { origin: 'https://evil.example' } })
  assert.equal(stranger.headers.get('access-control-allow-origin'), null)

  const localEnv: RegistryEnv = { ARCHIVES: bucket(), ENV: 'test' }
  const local = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/plugins', { headers: { origin: 'http://localhost:3000' } }), localEnv)
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:3000')
  const productionLocal = await get('/v1/plugins', { headers: { origin: 'http://localhost:3000' } })
  assert.equal(productionLocal.headers.get('access-control-allow-origin'), null)
})

test('an empty bucket serves an empty catalog instead of failing', async () => {
  const empty: RegistryEnv = { ARCHIVES: { get: async () => null }, ENV: 'production' }
  const response = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/plugins?q=anything'), empty)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { results: [], updatedAt: new Date(0).toISOString() })
  assert.equal((await handleRegistryRequest(new Request('https://api.shunagent.com/v1/plugins/x'), empty)).status, 404)
})

test('a store link is parsed into a plugin selection, never an install command', () => {
  assert.deepEqual(parseMarketplaceDeepLink('shun://plugin/regex-tester'), { id: 'regex-tester' })
  assert.deepEqual(parseMarketplaceDeepLink('shun://plugin/regex-tester?version=0.1.0'), { id: 'regex-tester', version: '0.1.0' })
  assert.deepEqual(parseMarketplaceDeepLink('shun://plugins/git-workbench/'), { id: 'git-workbench' })
  assert.equal(parseMarketplaceDeepLink('shun://plugin/Not Valid'), undefined)
  assert.equal(parseMarketplaceDeepLink('shun://plugin/regex-tester?version=one'), undefined)
  assert.equal(parseMarketplaceDeepLink('shun://other/regex-tester'), undefined)
  assert.equal(parseMarketplaceDeepLink('https://shunagent.com/plugins/regex-tester'), undefined)
  assert.equal(parseMarketplaceDeepLink(''), undefined)
})

test('the seed pipeline produces a catalog the worker serves and a client can verify', async () => {
  const { catalog, objects } = await buildMarketplaceCatalog({ seedsRoot: fileURLToPath(new URL('./seeds', import.meta.url)), publishedAt: '2026-09-13T00:00:00.000Z' })
  const seeded = catalog.entries.find(entry => entry.id === 'regex-tester')
  assert.ok(seeded, 'the seed catalog should contain the packaged example plugin')
  assert.equal(seeded.publisher, 'Shun')
  assert.equal(seeded.permissions.length, 0)
  assert.equal(seeded.versions[0].version, '0.1.0')
  assert.match(seeded.versions[0].sha256, /^[0-9a-f]{64}$/)
  assert.match(seeded.versions[0].contentSha256, /^[0-9a-f]{64}$/)

  // The objects the pipeline writes are exactly the objects the worker reads.
  const files = new Map(objects.map(object => [object.key, object.bytes]))
  assert.ok(files.has(marketplaceCatalogKey()))
  const served: RegistryEnv = {
    ENV: 'test',
    ARCHIVES: {
      get: async key => {
        const bytes = files.get(key)
        if (!bytes) return null
        return {
          text: async () => new TextDecoder().decode(bytes),
          arrayBuffer: async () => {
            const copy = new ArrayBuffer(bytes.byteLength)
            new Uint8Array(copy).set(bytes)
            return copy
          },
        }
      },
    },
  }
  const listed = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/plugins?q=regex'), served)
  assert.deepEqual(((await listed.json()) as { results: { id: string }[] }).results.map(item => item.id), ['regex-tester'])

  const response = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/plugins/regex-tester/versions/0.1.0/download'), served)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-shun-content-sha256'), seeded.versions[0].contentSha256)
  const download = new Uint8Array(await response.arrayBuffer())
  assert.equal(download.length, seeded.versions[0].archiveBytes)
  assert.equal((await pluginPackageDigest(await extractToTemp(download))).sha256, seeded.versions[0].contentSha256)
})

/** Unpack the served archive and confirm its content digest is the published one. */
async function extractToTemp(bytes: Uint8Array) {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const target = await mkdtemp(join(tmpdir(), 'shun-registry-digest-'))
  await extractPluginArchive(bytes, target)
  return target
}
