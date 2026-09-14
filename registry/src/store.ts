import { marketplaceIconPath, type MarketplaceEntry, type MarketplacePermission, type MarketplaceSummary, type MarketplaceVersion } from '../../src/marketplace.ts'

/**
 * Data access for the registry. D1 holds metadata and the review state; R2 holds
 * bytes. Nothing else in the worker touches SQL, so the query shapes stay in one
 * place as the schema grows.
 */

export type RegistryStatement = {
  bind(...values: unknown[]): RegistryStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>
  run(): Promise<unknown>
}

export type RegistryDatabase = {
  prepare(query: string): RegistryStatement
  batch(statements: RegistryStatement[]): Promise<unknown>
}

export type PluginRow = {
  id: string
  name: string
  description: string
  publisher: string
  icon: string | null
  keywords: string | null
  license: string | null
  homepage: string | null
  repository: string | null
  permissions: string
  latest: string
  featured: number | null
  updated_at: string
  status: string
}

export type VersionRow = {
  plugin_id: string
  version: string
  published_at: string
  engines: string | null
  archive_sha256: string
  content_sha256: string
  files: number
  bytes: number
  archive_bytes: number
  changelog: string | null
  yanked_at: string | null
}

export type SubmissionRow = {
  id: string
  plugin_id: string
  version: string
  publisher_handle: string
  archive_sha256: string
  content_sha256: string
  files: number
  bytes: number
  archive_bytes: number
  manifest: string
  changelog: string | null
  submitted_at: string
  state: string
  reviewed_at: string | null
  review_note: string | null
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function versionFromRow(row: VersionRow): MarketplaceVersion {
  const engines = parseJson<{ shun?: string } | undefined>(row.engines, undefined)
  return {
    version: row.version,
    publishedAt: row.published_at,
    ...(engines?.shun ? { engines } : {}),
    sha256: row.archive_sha256,
    contentSha256: row.content_sha256,
    files: row.files,
    bytes: row.bytes,
    archiveBytes: row.archive_bytes,
    ...(row.changelog ? { changelog: row.changelog } : {}),
  }
}

export function entryFromRows(row: PluginRow, versions: VersionRow[]): MarketplaceEntry {
  const available = versions.filter(version => !version.yanked_at)
  const latestVersion = available.find(version => version.version === row.latest)?.version || available[0]?.version || row.latest
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    publisher: row.publisher,
    ...(row.icon ? { icon: row.icon } : {}),
    ...(row.keywords ? { keywords: parseJson<string[]>(row.keywords, []) } : {}),
    ...(row.license ? { license: row.license } : {}),
    ...(row.homepage ? { homepage: row.homepage } : {}),
    ...(row.repository ? { repository: row.repository } : {}),
    permissions: parseJson<MarketplacePermission[]>(row.permissions, []),
    latest: latestVersion,
    updatedAt: row.updated_at,
    ...(row.icon && /\.svg$/i.test(row.icon) ? { iconUrl: marketplaceIconPath(row.id, latestVersion) } : {}),
    versions: available.map(versionFromRow),
    ...(row.featured ? { featured: row.featured } : {}),
  }
}

export async function publishedPlugins(db: RegistryDatabase, limit = 200) {
  const { results } = await db.prepare("SELECT * FROM plugins WHERE status = 'published' ORDER BY featured IS NULL, featured ASC, updated_at DESC LIMIT ?").bind(limit).all<PluginRow>()
  return results || []
}

/**
 * One window of the published catalog, with the size of the whole match.
 *
 * A store has no upper bound on how many plugins exist, so filtering, counting,
 * and paging belong to the database and only the requested window is read and
 * hydrated. `total` describes every match, not the window, so a client can say
 * how much there is and ask for the next page.
 */
export async function searchPublished(db: RegistryDatabase, options: { query?: string; sort?: string; limit?: number; offset?: number }) {
  const query = String(options.query || '').trim().toLowerCase()
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 20)))
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const where = query
    ? `status = 'published' AND (id LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\' OR lower(description) LIKE ? ESCAPE '\\' OR lower(publisher) LIKE ? ESCAPE '\\' OR lower(coalesce(keywords,'')) LIKE ? ESCAPE '\\')`
    : "status = 'published'"
  const binds = query ? Array.from({ length: 5 }, () => `%${escapeLikePattern(query)}%`) : []
  const order = options.sort === 'name' ? 'lower(name) ASC' : options.sort === 'updated' ? 'updated_at DESC' : 'featured IS NULL, featured ASC, updated_at DESC'
  const counted = await db.prepare(`SELECT COUNT(*) AS total FROM plugins WHERE ${where}`).bind(...binds).first<{ total: number }>()
  const { results } = await db.prepare(`SELECT * FROM plugins WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all<PluginRow>()
  return { total: Number(counted?.total || 0), rows: results || [] }
}

/** A `%` or `_` in a search string is a character, not a wildcard. */
function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, character => `\\${character}`)
}

export async function versionsFor(db: RegistryDatabase, pluginId: string) {
  const { results } = await db.prepare('SELECT * FROM plugin_versions WHERE plugin_id = ? ORDER BY published_at DESC').bind(pluginId).all<VersionRow>()
  return results || []
}

export async function pluginById(db: RegistryDatabase, id: string) {
  return await db.prepare("SELECT * FROM plugins WHERE id = ? AND status = 'published'").bind(id).first<PluginRow>()
}

export async function reservedIds(db: RegistryDatabase) {
  const { results } = await db.prepare('SELECT id, owner, note FROM reserved_ids').all<{ id: string; owner: string; note: string | null }>()
  return results || []
}

export async function submissionFor(db: RegistryDatabase, id: string, version: string) {
  return await db.prepare('SELECT * FROM submissions WHERE plugin_id = ? AND version = ?').bind(id, version).first<SubmissionRow>()
}

export async function publishedVersion(db: RegistryDatabase, id: string, version: string) {
  return await db.prepare('SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ? AND yanked_at IS NULL').bind(id, version).first<VersionRow>()
}

/** Every write a publish performs, as one batch so a failure cannot half-apply it. */
export function publishStatements(db: RegistryDatabase, input: {
  submission: SubmissionRow
  published: boolean
  entry: { permissions: MarketplacePermission[]; keywords?: string[]; icon?: string; license?: string; homepage?: string; repository?: string }
  manifestName: string
  manifestDescription: string
  publisher: string
  featured?: number
  engines?: { shun?: string }
}) {
  const { submission, entry } = input
  const statements = [
    db.prepare('INSERT OR REPLACE INTO submissions (id, plugin_id, version, publisher_handle, archive_sha256, content_sha256, files, bytes, archive_bytes, manifest, changelog, submitted_at, state, reviewed_at, review_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(submission.id, submission.plugin_id, submission.version, submission.publisher_handle, submission.archive_sha256, submission.content_sha256, submission.files, submission.bytes, submission.archive_bytes, submission.manifest, submission.changelog, submission.submitted_at, submission.state, submission.reviewed_at, submission.review_note),
  ]
  if (!input.published) return statements

  statements.push(
    db.prepare(`INSERT INTO plugins (id, name, description, publisher, icon, keywords, license, homepage, repository, permissions, latest, featured, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, description = excluded.description, publisher = excluded.publisher,
        icon = COALESCE(excluded.icon, plugins.icon), keywords = COALESCE(excluded.keywords, plugins.keywords),
        license = COALESCE(excluded.license, plugins.license), homepage = COALESCE(excluded.homepage, plugins.homepage),
        repository = COALESCE(excluded.repository, plugins.repository), permissions = excluded.permissions,
        latest = excluded.latest, updated_at = excluded.updated_at, status = 'published',
        featured = CASE WHEN excluded.featured IS NOT NULL THEN excluded.featured ELSE plugins.featured END`)
      .bind(
        submission.plugin_id, input.manifestName, input.manifestDescription, input.publisher,
        entry.icon ?? null, entry.keywords ? JSON.stringify(entry.keywords) : null,
        entry.license ?? null, entry.homepage ?? null, entry.repository ?? null,
        JSON.stringify(entry.permissions), submission.version, input.featured ?? null, submission.submitted_at,
      ),
    db.prepare('INSERT INTO plugin_versions (plugin_id, version, published_at, engines, archive_sha256, content_sha256, files, bytes, archive_bytes, changelog, yanked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
      .bind(submission.plugin_id, submission.version, submission.submitted_at, input.engines ? JSON.stringify(input.engines) : null, submission.archive_sha256, submission.content_sha256, submission.files, submission.bytes, submission.archive_bytes, submission.changelog),
  )
  return statements
}

export async function blockedEntries(db: RegistryDatabase) {
  const { results } = await db.prepare('SELECT plugin_id, version, reason, blocked_at FROM blocked ORDER BY blocked_at DESC').bind().all<{ plugin_id: string; version: string; reason: string; blocked_at: string }>()
  return results || []
}

export function summaryFromEntry(entry: MarketplaceEntry): MarketplaceSummary {
  const { versions: _versions, homepage: _homepage, repository: _repository, icon: _icon, ...summary } = entry
  return summary
}
