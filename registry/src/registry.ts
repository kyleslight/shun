/**
 * The Shun plugin registry API.
 *
 * Read-only for now: it serves the catalog, per-version manifests, and package
 * archives. Publishing, publisher identity, and revocation arrive with the
 * write side; until then the catalog is produced at release time by
 * `scripts/build-registry-catalog.mjs` and uploaded to R2.
 *
 * The handler takes a small storage interface instead of an R2 binding so the
 * whole API can be exercised in-process by tests with no Cloudflare account.
 */
import { marketplaceArchiveKey, marketplaceCatalogKey, marketplaceEntry, marketplaceIdPattern, marketplaceManifestKey, marketplaceSearch, marketplaceVersion, type MarketplaceCatalog, type MarketplaceEntry } from '../../src/marketplace.ts'

export type RegistryObjectBody = { text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }
export type RegistryBucket = { get(key: string): Promise<RegistryObjectBody | null> }
export type RegistryEnv = {
  ARCHIVES: RegistryBucket
  /** `production` disables the permissive local-development CORS origins. */
  ENV?: string
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const LOCAL_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/

export async function handleRegistryRequest(request: Request, env: RegistryEnv): Promise<Response> {
  const origin = request.headers.get('origin')
  const cors = corsHeaders(origin, env)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method_not_allowed' }, 405, cors)

  const url = new URL(request.url)
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] !== 'v1') return json({ error: 'not_found' }, 404, cors)

  if (segments[1] === 'health') {
    const catalog = await readCatalog(env)
    return json({ status: 'ok', plugins: catalog.entries.length, updatedAt: catalog.updatedAt, environment: env.ENV || 'unknown' }, 200, { ...cors, 'cache-control': 'no-store' })
  }

  if (segments[1] === 'plugins') {
    // /v1/plugins
    if (segments.length === 2) {
      const catalog = await readCatalog(env)
      const limit = Number(url.searchParams.get('limit') || 20)
      const results = marketplaceSearch(catalog, url.searchParams.get('q') || '', Number.isFinite(limit) ? limit : 20)
      return json({ results, updatedAt: catalog.updatedAt }, 200, { ...cors, 'cache-control': 'public, max-age=30' })
    }
    const id = segments[2]
    if (!marketplaceIdPattern.test(id) || id.length > 80) return json({ error: 'invalid_plugin_id' }, 400, cors)
    const catalog = await readCatalog(env)
    const entry = marketplaceEntry(catalog, id)
    if (!entry) return json({ error: 'not_found', id }, 404, cors)

    // /v1/plugins/:id
    if (segments.length === 3) return json(entry, 200, { ...cors, 'cache-control': 'public, max-age=30' })

    if (segments[3] === 'versions' && segments.length >= 5) {
      const version = segments[4]
      const published = marketplaceVersion(entry, version)
      if (!published) return json({ error: 'not_found', id, version }, 404, cors)

      // /v1/plugins/:id/versions/:version/download
      if (segments.length === 6 && segments[5] === 'download') return await downloadArchive(env, entry, published.contentSha256, published.sha256, published.version, cors)

      // /v1/plugins/:id/versions/:version
      if (segments.length === 5) {
        const manifest = await env.ARCHIVES.get(marketplaceManifestKey(id, version))
        if (!manifest) return json({ error: 'not_found', id, version }, 404, cors)
        return json({ ...published, manifest: JSON.parse(await manifest.text()) }, 200, { ...cors, 'cache-control': 'public, max-age=300' })
      }
    }
  }

  return json({ error: 'not_found' }, 404, cors)
}

async function downloadArchive(env: RegistryEnv, entry: MarketplaceEntry, contentSha256: string, sha256: string, version: string, headers: Record<string, string>) {
  const object = await env.ARCHIVES.get(marketplaceArchiveKey(entry.id, version, contentSha256))
  if (!object) return json({ error: 'archive_missing', id: entry.id, version }, 404, headers)
  return new Response(await object.arrayBuffer(), {
    status: 200,
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      // The digests travel with the bytes so a client can verify before extracting.
      'x-shun-archive-sha256': sha256,
      'x-shun-content-sha256': contentSha256,
      'x-shun-version': version,
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
}

async function readCatalog(env: RegistryEnv): Promise<MarketplaceCatalog> {
  const object = await env.ARCHIVES.get(marketplaceCatalogKey())
  if (!object) return { updatedAt: new Date(0).toISOString(), entries: [] }
  const parsed = JSON.parse(await object.text()) as MarketplaceCatalog
  return { updatedAt: String(parsed?.updatedAt || ''), entries: Array.isArray(parsed?.entries) ? parsed.entries : [] }
}

function corsHeaders(origin: string | null, env: RegistryEnv): Record<string, string> {
  const allowed = origin === 'https://shunagent.com' || (env.ENV !== 'production' && origin !== null && LOCAL_ORIGIN.test(origin))
  return allowed && origin
    ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': 'content-type', 'vary': 'origin' }
    : {}
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } })
}
