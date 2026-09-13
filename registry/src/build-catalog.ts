import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createPluginArchive } from '../../src/main/plugin-archive.ts'
import { validatePluginPackage } from '../../src/main/plugin-packages.ts'
import { marketplaceArchiveKey, marketplaceCatalogKey, marketplaceManifestKey, type MarketplaceCatalog, type MarketplaceEntry } from '../../src/marketplace.ts'

/**
 * Turn a directory of package sources into the exact objects the registry
 * serves.
 *
 * This is node-only on purpose: it imports the client's own validator and packer
 * so a published package and an installed package are checked by one
 * implementation, and it is never reachable from the Worker entry point, whose
 * bundle only follows `registry/src/index.ts`.
 */
export type BuiltCatalogObject = { key: string; bytes: Uint8Array }

export type BuiltCatalog = { catalog: MarketplaceCatalog; objects: BuiltCatalogObject[] }

export async function buildMarketplaceCatalog(input: { seedsRoot: string; publishedAt?: string; example?: boolean; featured?: string[] }): Promise<BuiltCatalog> {
  const publishedAt = input.publishedAt || new Date().toISOString()
  const featured = new Map((input.featured || []).map((id, index) => [id, index + 1]))
  const directories = (await readdir(input.seedsRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort()
  // An empty seed directory is a valid state: the catalog simply has no
  // first-party entries yet, and the registry serves what publishers uploaded.

  const entries: MarketplaceEntry[] = []
  const objects: BuiltCatalogObject[] = []
  for (const directory of directories) {
    const source = join(input.seedsRoot, directory)
    const manifest = validatePluginPackage(JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')), 'installed')
    const archive = await createPluginArchive(source)
    entries.push({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      publisher: manifest.publisher,
      icon: manifest.iconAsset || manifest.icon,
      ...(manifest.keywords ? { keywords: manifest.keywords } : {}),
      ...(manifest.license ? { license: manifest.license } : {}),
      ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
      ...(manifest.repository ? { repository: manifest.repository } : {}),
      permissions: manifest.permissions || [],
      latest: manifest.version,
      updatedAt: publishedAt,
      ...(featured.has(manifest.id) ? { featured: featured.get(manifest.id) } : {}),
      versions: [{
        version: manifest.version,
        publishedAt,
        ...(manifest.engines ? { engines: manifest.engines } : {}),
        sha256: archive.sha256,
        contentSha256: archive.contentSha256,
        files: archive.files,
        bytes: archive.contentBytes,
        archiveBytes: archive.bytes.length,
      }],
      ...(input.example === false ? {} : { example: true }),
    })
    objects.push(
      { key: marketplaceManifestKey(manifest.id, manifest.version), bytes: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) },
      { key: marketplaceArchiveKey(manifest.id, manifest.version, archive.contentSha256), bytes: archive.bytes },
    )
  }

  const catalog: MarketplaceCatalog = { updatedAt: publishedAt, entries }
  objects.push({ key: marketplaceCatalogKey(), bytes: new TextEncoder().encode(`${JSON.stringify(catalog, null, 2)}\n`) })
  return { catalog, objects }
}
