import assert from 'node:assert/strict'
import test from 'node:test'
import { PluginRegistryClient } from './plugin-registry.ts'

const entry = {
  id: 'regex-tester', name: 'Regex Tester', description: 'Try a regular expression.', publisher: 'Shun',
  permissions: [], latest: '0.1.0', updatedAt: '2026-09-13T00:00:00.000Z', example: true,
  versions: [{ version: '0.1.0', publishedAt: '2026-09-13T00:00:00.000Z', sha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), files: 5, bytes: 6787, archiveBytes: 5 }],
}

function stubFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = []
  const impl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))
    if (!route) return new Response('{"error":"not_found"}', { status: 404 })
    return route[1]()
  }) as typeof fetch
  return { impl, calls }
}

test('search asks for a bounded page and tolerates a registry that answers oddly', async () => {
  const { impl, calls } = stubFetch({
    'https://registry.test/v1/plugins': () => new Response(JSON.stringify({ results: [{ id: 'regex-tester' }], updatedAt: 'now' }), { status: 200 }),
  })
  const client = new PluginRegistryClient(impl, 'https://registry.test/')
  assert.equal(client.baseUrl, 'https://registry.test')
  const response = await client.search('regex tester', 500)
  assert.deepEqual(response.results.map(item => item.id), ['regex-tester'])
  assert.match(calls[0], /\/v1\/plugins\?q=regex\+tester&limit=100$/)

  const empty = new PluginRegistryClient(stubFetch({ 'https://registry.test/v1/plugins': () => new Response('{}', { status: 200 }) }).impl, 'https://registry.test')
  assert.deepEqual(await empty.search(''), { results: [], updatedAt: '' })

  const broken = new PluginRegistryClient(stubFetch({ 'https://registry.test/v1/plugins': () => new Response('<html>', { status: 200 }) }).impl, 'https://registry.test')
  await assert.rejects(broken.search('x'), /unreadable response/)
})

test('detail refuses a record the client cannot act on', async () => {
  const good = new PluginRegistryClient(stubFetch({ 'https://registry.test/v1/plugins/regex-tester': () => new Response(JSON.stringify(entry), { status: 200 }) }).impl, 'https://registry.test')
  assert.equal((await good.detail('regex-tester')).latest, '0.1.0')
  assert.equal((await good.detail('Regex-Tester')).id, 'regex-tester')

  const wrongId = new PluginRegistryClient(stubFetch({ 'https://registry.test/v1/plugins/regex-tester': () => new Response(JSON.stringify({ ...entry, id: 'other' }), { status: 200 }) }).impl, 'https://registry.test')
  await assert.rejects(wrongId.detail('regex-tester'), /unusable record/)

  const noVersions = new PluginRegistryClient(stubFetch({ 'https://registry.test/v1/plugins/regex-tester': () => new Response(JSON.stringify({ ...entry, versions: [] }), { status: 200 }) }).impl, 'https://registry.test')
  await assert.rejects(noVersions.detail('regex-tester'), /unusable record/)

  const missing = new PluginRegistryClient(stubFetch({}).impl, 'https://registry.test')
  await assert.rejects(missing.detail('regex-tester'), /does not have plugin regex-tester/)
  await assert.rejects(missing.detail('Not Valid!'), /Not a valid plugin id/)

  const offline = new PluginRegistryClient((async () => { throw Error('connect ECONNREFUSED') }) as typeof fetch, 'https://registry.test')
  await assert.rejects(offline.detail('regex-tester'), /Could not reach the plugin registry/)
})

test('download returns bytes and refuses an archive the registry contradicts itself about', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const { impl } = stubFetch({
    'https://registry.test/v1/plugins/regex-tester/versions/0.1.0/download': () => new Response(bytes, { status: 200, headers: { 'x-shun-content-sha256': 'b'.repeat(64) } }),
  })
  const client = new PluginRegistryClient(impl, 'https://registry.test')
  assert.deepEqual(await client.download('regex-tester', '0.1.0', { sha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), archiveBytes: 3 }), bytes)

  const mismatched = new PluginRegistryClient(stubFetch({
    'https://registry.test/v1/plugins/regex-tester/versions/0.1.0/download': () => new Response(bytes, { status: 200, headers: { 'x-shun-content-sha256': 'c'.repeat(64) } }),
  }).impl, 'https://registry.test')
  await assert.rejects(mismatched.download('regex-tester', '0.1.0', { sha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), archiveBytes: 3 }), /different content digest/)

  const empty = new PluginRegistryClient(stubFetch({ 'https://registry.test/v1/plugins/regex-tester/versions/0.1.0/download': () => new Response(new Uint8Array(), { status: 200 }) }).impl, 'https://registry.test')
  await assert.rejects(empty.download('regex-tester', '0.1.0', { sha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), archiveBytes: 3 }), /empty archive/)

  const refused = new PluginRegistryClient(stubFetch({ 'https://registry.test/v1/plugins/x/versions/0.1.0/download': () => new Response('{}', { status: 403 }) }).impl, 'https://registry.test')
  await assert.rejects(refused.download('x', '0.1.0', { sha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), archiveBytes: 3 }), /refused/)
})

test('the application owns the store link, and a link never installs by itself', async () => {
  const { readFile } = await import('node:fs/promises')
  const [main, preload, renderer] = await Promise.all([
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../preload/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
  ])
  // Scheme ownership, both platform entry points, and cold-start argv.
  assert.match(main, /setAsDefaultProtocolClient\('shun'\)/)
  assert.match(main, /app\.on\('open-url'[\s\S]*handleDeepLink\(url\)/)
  assert.match(main, /app\.on\('second-instance', \(_event, argv\)[\s\S]*startsWith\('shun:\/\/'\)/)
  assert.match(main, /if \(!parseMarketplaceDeepLink\(url\)\) return/)
  // The store transport uses the Chromium stack, like every other REST service.
  assert.match(main, /new PluginRegistryClient\(productFetch\(\), process\.env\.SHUN_REGISTRY_URL \|\| defaultMarketplaceUrl\)/)
  // Installing from the store verifies the published digests before extraction.
  assert.match(main, /stagePluginArchive\(bytes, \{ sha256: published\.sha256, contentSha256: published\.contentSha256 \}\)[\s\S]*installFromDirectory\(staged\.root, 'marketplace'\)/)
  assert.match(preload, /onPluginDeepLink: fn => \{ const listener = \(_: unknown, url: string\) => fn\(url\)/)
  // A link selects and, at most, offers consent. It never writes settings on its own.
  assert.match(renderer, /window\.shun\.onPluginDeepLink\(\(url: string\) => focusPlugin\(parseMarketplaceDeepLink\(url\)\)\)/)
  assert.match(renderer, /setConsent\(\{ id: entry\.id, name: entry\.name, version: focus\.version \|\| entry\.latest, origin: "marketplace", permissions: entry\.permissions \}\)/)
  assert.match(renderer, /installPluginFromMarketplace\(target\.id, target\.version\)/)
  assert.doesNotMatch(renderer, /onPluginDeepLink\([\s\S]{0,200}installPluginFromMarketplace/)
})
