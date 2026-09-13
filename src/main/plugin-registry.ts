import { defaultMarketplaceUrl, marketplaceIdPattern, marketplaceVersionPattern, type MarketplaceBlock, type MarketplaceBlocklist, type MarketplaceEntry, type MarketplaceSearchResponse, type MarketplaceVersion } from '../marketplace.ts'

/**
 * Client for the Shun plugin registry.
 *
 * The transport is injected because the network stack matters: Node `fetch`
 * does not reach the internet on the TUN-mode proxy setup this project is
 * developed on, while Chromium's does, so the application passes `productFetch`.
 */
export class PluginRegistryClient {
  #fetch: typeof fetch
  #baseUrl: string

  constructor(fetchImpl: typeof fetch, baseUrl = defaultMarketplaceUrl) {
    this.#fetch = fetchImpl
    this.#baseUrl = String(baseUrl || defaultMarketplaceUrl).replace(/\/+$/, '')
  }

  get baseUrl() { return this.#baseUrl }

  async search(query = '', limit = 30): Promise<MarketplaceSearchResponse> {
    const url = new URL(`${this.#baseUrl}/v1/plugins`)
    if (String(query || '').trim()) url.searchParams.set('q', String(query).trim())
    url.searchParams.set('limit', String(Math.max(1, Math.min(100, limit))))
    const body = await this.#json(url, 'search')
    const results = Array.isArray((body as MarketplaceSearchResponse)?.results) ? (body as MarketplaceSearchResponse).results : []
    return { results, updatedAt: String((body as MarketplaceSearchResponse)?.updatedAt || '') }
  }

  async detail(pluginId: string): Promise<MarketplaceEntry> {
    const id = String(pluginId || '').trim().toLowerCase()
    if (!marketplaceIdPattern.test(id) || id.length > 80) throw Error(`Not a valid plugin id: ${pluginId || '(missing)'}.`)
    const entry = await this.#json(new URL(`${this.#baseUrl}/v1/plugins/${encodeURIComponent(id)}`), `plugin ${id}`) as MarketplaceEntry
    if (entry?.id !== id || !Array.isArray(entry.versions) || !entry.versions.length) throw Error(`The registry returned an unusable record for ${id}.`)
    if (!marketplaceVersionPattern.test(String(entry.latest || ''))) throw Error(`The registry did not name a latest version for ${id}.`)
    return entry
  }

  /**
   * Download a published archive, refusing bytes that do not match the published
   * digests. The body is read as a stream so a store row can show real progress
   * instead of an indeterminate spinner on a 20 MB package.
   */
  async download(pluginId: string, version: string, expected: Pick<MarketplaceVersion, 'sha256' | 'contentSha256' | 'archiveBytes'>, onProgress?: (progress: { received: number; total: number }) => void): Promise<Uint8Array> {
    const url = new URL(`${this.#baseUrl}/v1/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(version)}/download`)
    const response = await this.#request(url, `plugin ${pluginId} ${version}`)
    const announced = response.headers.get('x-shun-content-sha256')
    if (announced && announced !== expected.contentSha256) throw Error(`The registry is serving ${pluginId} ${version} with a different content digest than it published.`)
    const total = Number(response.headers.get('content-length')) || expected.archiveBytes || 0
    const bytes = response.body ? await readStream(response.body, total, onProgress) : new Uint8Array(await response.arrayBuffer())
    onProgress?.({ received: bytes.byteLength, total: total || bytes.byteLength })
    if (!bytes.length) throw Error(`The registry returned an empty archive for ${pluginId} ${version}.`)
    return bytes
  }

  /**
   * Versions withdrawn after publication. Fetch failures are not fatal: a client
   * that cannot reach the registry keeps working with what it already has, and
   * says nothing rather than blocking the interface.
   */
  async blocklist(): Promise<MarketplaceBlocklist> {
    try {
      const body = await this.#json(new URL(`${this.#baseUrl}/v1/blocklist`), 'the withdrawal list') as MarketplaceBlocklist
      return { updatedAt: String(body?.updatedAt || ''), blocked: Array.isArray(body?.blocked) ? body.blocked.filter(entry => marketplaceIdPattern.test(String(entry?.id || ''))) as MarketplaceBlock[] : [] }
    } catch {
      return { updatedAt: '', blocked: [] }
    }
  }

  async #json(url: URL, label: string) {
    const response = await this.#request(url, label)
    try {
      return await response.json()
    } catch {
      throw Error(`The plugin registry returned an unreadable response for ${label}.`)
    }
  }

  async #request(url: URL, label: string) {
    let response: Response
    try {
      response = await this.#fetch(url.href, { headers: { accept: 'application/json, application/octet-stream' }, signal: AbortSignal.timeout(20_000) })
    } catch (error) {
      throw Error(`Could not reach the plugin registry at ${this.#baseUrl}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw Error(response.status === 404 ? `The registry does not have ${label}.` : `The plugin registry refused ${label} (HTTP ${response.status}).`)
    return response
  }
}

async function readStream(body: ReadableStream<Uint8Array>, total: number, onProgress?: (progress: { received: number; total: number }) => void) {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let lastReported = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    received += value.byteLength
    // Report often enough to look alive, rarely enough not to flood the renderer.
    if (onProgress && received - lastReported > 256 * 1024) {
      lastReported = received
      onProgress({ received, total })
    }
  }
  const joined = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
  return joined
}
