/**
 * The marketplace contract shared by the Shun client and the registry worker.
 *
 * Platform-neutral on purpose: the registry runs on Cloudflare Workers and the
 * client runs on Electron, and both have to agree on what a catalog entry is,
 * how a search matches, and which fields a store page may trust. A downloaded
 * package's publisher is issued by the registry, never read from its manifest.
 */

export const defaultMarketplaceUrl = 'https://api.shunagent.com'
export const marketplaceArchiveExtension = '.shunplugin'
export const marketplaceIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
export const marketplaceVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export type MarketplacePermission = { id: string; reason: string }

export type MarketplaceVersion = {
  version: string
  publishedAt: string
  engines?: { shun?: string }
  /** Digest of the archive bytes; a client verifies the download against it. */
  sha256: string
  /** Digest of the package tree inside the archive. */
  contentSha256: string
  files: number
  /** Unpacked size. */
  bytes: number
  archiveBytes: number
  /** What the publisher says changed in this version. */
  changelog?: string
}

export type MarketplaceEntry = {
  id: string
  name: string
  description: string
  /** Registry-issued publisher handle. */
  publisher: string
  icon?: string
  keywords?: string[]
  license?: string
  homepage?: string
  repository?: string
  permissions: MarketplacePermission[]
  latest: string
  updatedAt: string
  /** Registry-served icon path, present only when the package ships an SVG asset. */
  iconUrl?: string
  versions: MarketplaceVersion[]
  /**
   * Curated position, set by the registry and never by a publisher. Lower comes
   * first; an entry without one is simply not curated.
   */
  featured?: number
  /** A first-party sample that ships with the registry, not a third-party publisher. */
  example?: boolean
}

export type MarketplaceCatalog = { updatedAt: string; entries: MarketplaceEntry[] }

/** What a list or search response carries; full versions stay behind the detail route. */
export type MarketplaceSummary = {
  id: string
  name: string
  description: string
  publisher: string
  keywords?: string[]
  license?: string
  permissions: MarketplacePermission[]
  latest: string
  updatedAt: string
  /** Registry-served icon path, present only when the package ships an SVG asset. */
  iconUrl?: string
  featured?: number
  example?: boolean
}

/**
 * `featured` is the store's own order: curated entries first, then whatever has
 * been updated most recently. `relevance` is what a search uses, and the three
 * simple orders exist so a caller can ask for exactly what it means.
 */
export type MarketplaceSort = 'featured' | 'updated' | 'name' | 'relevance'

export type MarketplaceSearchResponse = { results: MarketplaceSummary[]; /** Every match, not just this page. */ total: number; updatedAt: string }

export function marketplaceSummary(entry: MarketplaceEntry): MarketplaceSummary {
  return {
    id: entry.id, name: entry.name, description: entry.description, publisher: entry.publisher,
    permissions: entry.permissions, latest: entry.latest, updatedAt: entry.updatedAt,
    ...(entry.iconUrl ? { iconUrl: entry.iconUrl } : {}),
    ...(entry.keywords?.length ? { keywords: entry.keywords } : {}),
    ...(entry.license ? { license: entry.license } : {}),
    ...(entry.featured ? { featured: entry.featured } : {}),
    ...(entry.example ? { example: true } : {}),
  }
}

export function marketplaceEntry(catalog: MarketplaceCatalog, id: string) {
  return catalog.entries.find(entry => entry.id === id)
}

export function marketplaceVersion(entry: MarketplaceEntry, version: string) {
  return entry.versions.find(item => item.version === version)
}

/**
 * Deterministic relevance order, so a client cache and a retry always agree:
 * exact id, id prefix, name prefix, keyword, then anything in the description.
 */
export function marketplaceSearch(catalog: readonly MarketplaceEntry[], query: string | undefined, sort: MarketplaceSort, limit = 20): MarketplaceSummary[] {
  const needle = String(query || '').trim().toLowerCase()
  const mode: MarketplaceSort = sort === 'relevance' && !needle ? 'featured' : sort
  const entries = catalog.filter(entry => !needle || marketplaceScore(entry, needle) > 0)
  const byName = (left: MarketplaceEntry, right: MarketplaceEntry) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  const ordered = [...entries].sort((left, right) => {
    if (mode === 'relevance') return marketplaceScore(right, needle) - marketplaceScore(left, needle) || byName(left, right)
    if (mode === 'updated') return String(right.updatedAt).localeCompare(String(left.updatedAt)) || byName(left, right)
    if (mode === 'name') return byName(left, right)
    // Curated entries keep their position; everything else follows by recency.
    const leftFeatured = left.featured ?? Number.MAX_SAFE_INTEGER
    const rightFeatured = right.featured ?? Number.MAX_SAFE_INTEGER
    if (leftFeatured !== rightFeatured) return leftFeatured - rightFeatured
    return String(right.updatedAt).localeCompare(String(left.updatedAt)) || byName(left, right)
  })
  return ordered.slice(0, Math.max(1, Math.min(100, limit))).map(entry => marketplaceSummary(entry))
}

function marketplaceScore(entry: MarketplaceEntry, needle: string) {
  if (!needle) return 1
  const id = entry.id.toLowerCase(), name = entry.name.toLowerCase(), description = entry.description.toLowerCase(), publisher = String(entry.publisher || '').toLowerCase()
  if (id === needle) return 100
  if (id.startsWith(needle)) return 80
  if (name.startsWith(needle)) return 70
  if (entry.keywords?.some(keyword => keyword.toLowerCase() === needle)) return 60
  // A publisher is how people find the rest of what someone made, so a handle
  // matches as readily as a name does.
  if (publisher === needle) return 50
  if (id.includes(needle) || name.includes(needle) || publisher.includes(needle)) return 40
  if (entry.keywords?.some(keyword => keyword.toLowerCase().includes(needle))) return 30
  if (description.includes(needle)) return 10
  return 0
}

/**
 * `shun://plugin/<id>` and `shun://plugin/<id>?version=<version>`.
 * The link selects a plugin in the store; installing it stays a decision the
 * user makes in the application, never something a link performs.
 */
export function parseMarketplaceDeepLink(value: string): { id: string; version?: string } | undefined {
  let url: URL
  try {
    url = new URL(String(value || '').trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'shun:') return undefined
  if (url.hostname !== 'plugin' && url.hostname !== 'plugins') return undefined
  const id = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase()
  if (!marketplaceIdPattern.test(id) || id.length > 80) return undefined
  const version = url.searchParams.get('version')?.trim() || undefined
  if (version && !marketplaceVersionPattern.test(version)) return undefined
  return { id, ...(version ? { version } : {}) }
}

/**
 * One withdrawn version. `version: '*'` withdraws every version of a plugin.
 * A client applies this to copies it already installed: yanking only stops new
 * downloads, and a package that turned out to be harmful has usually already
 * been downloaded by then.
 */
export type MarketplaceBlock = { id: string; version: string; reason: string; blockedAt: string }
export type MarketplaceBlocklist = { updatedAt: string; blocked: MarketplaceBlock[] }

/** True when a block entry covers this exact installed version. */
export function marketplaceBlocks(entry: MarketplaceBlock, pluginId: string, version: string) {
  return entry.id === pluginId && (entry.version === '*' || entry.version === version)
}

/** Storage keys, shared so a publisher upload and a client download cannot disagree. */
export function marketplaceCatalogKey() { return 'catalog/index.json' }
export function marketplaceManifestKey(id: string, version: string) { return `plugins/${id}/${version}/manifest.json` }
export function marketplaceIconKey(id: string, version: string) { return `plugins/${id}/${version}/icon.svg` }
/** Where a client reads the icon for a published version. */
export function marketplaceIconPath(id: string, version: string) { return `/v1/plugins/${id}/icon?v=${encodeURIComponent(version)}` }
export function marketplaceArchiveKey(id: string, version: string, contentSha256: string) { return `plugins/${id}/${version}/${contentSha256}${marketplaceArchiveExtension}` }
