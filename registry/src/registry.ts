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
import { marketplaceArchiveKey, marketplaceIconKey, marketplaceIdPattern, marketplaceManifestKey, marketplaceScreenshotKey, marketplaceSearch, type MarketplaceEntry, type MarketplaceSort } from '../../src/marketplace.ts'
import { readPluginArchive, pluginArchiveManifest } from '../../src/plugin-archive-core.ts'
import { validatePluginPackage } from '../../src/plugin-manifest.ts'
import { blockedEntries, entryFromRows, pluginById, publishedPlugins, publishedVersion, publishStatements, reservedIds, searchPublished, submissionFor, summaryFromEntry, versionsFor, versionFromRow, type PluginRow, type RegistryDatabase, type SubmissionRow, type VersionRow } from './store.ts'
import { challengeTtlMs, hashCode, hashEmail, maxChallengesPerHour, maxCodeAttempts, normalizeEmail, normalizeHandle, parsePublisherAuthorization, randomCode, randomId, verifyPublisherSignature } from './publishers.ts'

export type RegistryObjectBody = { text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }
export type RegistryBucket = {
  get(key: string): Promise<RegistryObjectBody | null>
  put(key: string, value: Uint8Array | ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
  delete?(key: string): Promise<unknown>
}
export type RegistryEnv = {
  ARCHIVES: RegistryBucket
  DB: RegistryDatabase
  /** Held only by the operator: publishes, review decisions, and yanks. */
  OPERATOR_TOKEN?: string
  /**
   * Handles whose own publishes go straight to the store. Review exists so the
   * curator can look at what strangers submit; asking the curator to approve
   * their own package is a step that can only slow them down.
   */
  TRUSTED_PUBLISHERS?: string
  /** Pepper for publisher email hashes, so a leaked table does not leak addresses. */
  EMAIL_PEPPER?: string
  /** Resend API key. When absent, codes are printed to the worker log outside production. */
  RESEND_API_KEY?: string
  MAIL_FROM?: string
  MAIL_TRANSPORT?: string
  /** Test-only hook so the email path can be exercised without a provider. */
  MAIL_SEND?: (message: { to: string; subject: string; text: string }) => Promise<void>
  ENV?: string
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const marketplaceSorts = new Set<MarketplaceSort>(['featured', 'updated', 'name', 'relevance'])

export async function handleRegistryRequest(request: Request, env: RegistryEnv): Promise<Response> {
  const cors = corsHeaders()
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })

  const url = new URL(request.url)
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] !== 'v1') return json({ error: 'not_found' }, 404, cors)

  if (request.method === 'POST') return await handleWrite(request, env, segments, cors)
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method_not_allowed' }, 405, cors)

  // The review queue is a read, but never a public one.
  if (segments[1] === 'submissions') {
    if (!operatorAuthorized(request, env)) return json({ error: 'unauthorized' }, 401, cors)
    if (segments.length === 2) return await listSubmissions(env, url.searchParams.get('state') || 'review', cors)
    return json({ error: 'not_found' }, 404, cors)
  }

  if (segments[1] === 'health') {
    const plugins = await publishedPlugins(env.DB, 500)
    return json({ status: 'ok', plugins: plugins.length, updatedAt: newestUpdate(plugins), environment: env.ENV || 'unknown' }, 200, { ...cors, 'cache-control': 'no-store' })
  }

  if (segments[1] === 'blocklist') {
    const blocked = await blockedEntries(env.DB)
    return json({ updatedAt: newestBlock(blocked), blocked: blocked.map(row => ({ id: row.plugin_id, version: row.version, reason: row.reason, blockedAt: row.blocked_at })) }, 200, { ...cors, 'cache-control': 'public, max-age=300' })
  }

  if (segments[1] !== 'plugins') return json({ error: 'not_found' }, 404, cors)

  // /v1/plugins
  if (segments.length === 2) {
    const limit = Number(url.searchParams.get('limit') || 20)
    const offset = Number(url.searchParams.get('offset') || 0)
    const query = url.searchParams.get('q') ?? undefined
    const requested = url.searchParams.get('sort') || (query ? 'relevance' : 'featured')
    if (!marketplaceSorts.has(requested as MarketplaceSort)) return json({ error: 'invalid_sort', sort: requested }, 400, cors)
    // The catalog has no upper bound, so the database filters, counts, and pages it
    // and only this window is hydrated. Relevance is a ranking, and ranking reads
    // the window it was given rather than an unbounded set.
    const window = await searchPublished(env.DB, { query, sort: requested, limit: Number.isFinite(limit) ? limit : 20, offset: Number.isFinite(offset) ? offset : 0 })
    const entries = await Promise.all(window.rows.map(async row => entryFromRows(row, await versionsFor(env.DB, row.id))))
    const results = marketplaceSearch(entries, query, requested as MarketplaceSort, entries.length || 1)
    return json({ results, total: window.total, offset: Math.max(0, Math.trunc(offset) || 0), sort: requested, updatedAt: newestUpdate(window.rows) }, 200, { ...cors, 'cache-control': 'public, max-age=30' })
  }

  const id = segments[2]
  if (!marketplaceIdPattern.test(id) || id.length > 80) return json({ error: 'invalid_plugin_id' }, 400, cors)
  const row = await pluginById(env.DB, id)
  if (!row) return json({ error: 'not_found', id }, 404, cors)
  const versions = await versionsFor(env.DB, id)
  const entry = entryFromRows(row, versions)

  // /v1/plugins/:id
  if (segments.length === 3) return json(entry, 200, { ...cors, 'cache-control': 'public, max-age=30' })

  // /v1/plugins/:id/icon — the package's own SVG, served from the registry so a
  // storefront never has to understand the archive format.
  if (segments[3] === 'icon' && segments.length === 4) {
    const wanted = url.searchParams.get('v')
    const published = (wanted ? versions.find(item => item.version === wanted) : undefined) || versions.find(item => item.version === entry.latest) || versions.find(item => !item.yanked_at)
    if (!published) return json({ error: 'not_found', id }, 404, cors)
    if (!row.icon || !/\.svg$/i.test(row.icon)) return json({ error: 'no_icon', id }, 404, cors)
    return await serveIcon(env, id, published.version, published.content_sha256, cors)
  }

  // /v1/plugins/:id/screenshot/:index — a cover image from the package itself.
  if (segments[3] === 'screenshot' && segments.length === 5) {
    const index = Number(segments[4])
    if (!Number.isInteger(index) || index < 0) return json({ error: 'not_found', id }, 404, cors)
    const wanted = url.searchParams.get('v')
    const published = (wanted ? versions.find(item => item.version === wanted) : undefined) || versions.find(item => item.version === entry.latest) || versions.find(item => !item.yanked_at)
    if (!published) return json({ error: 'not_found', id }, 404, cors)
    return await serveScreenshot(env, id, published.version, published.content_sha256, index, cors)
  }

  if (segments[3] === 'versions' && segments.length >= 5) {
    const published = versions.find(item => item.version === segments[4] && !item.yanked_at)
    if (!published) return json({ error: 'not_found', id, version: segments[4] }, 404, cors)
    if (segments.length === 6 && segments[5] === 'download') {
      return await downloadArchive(env, entry, published.content_sha256, published.archive_sha256, published.version, cors)
    }
    if (segments.length === 5) {
      const manifest = await env.ARCHIVES.get(marketplaceManifestKey(id, published.version))
      if (!manifest) return json({ error: 'not_found', id, version: published.version }, 404, cors)
      return json({ ...versionFromRow(published), manifest: JSON.parse(await manifest.text()) }, 200, { ...cors, 'cache-control': 'public, max-age=300' })
    }
  }

  return json({ error: 'not_found' }, 404, cors)
}


/* ---------------------------------------------------------------------------
   Publisher identity: one verified email, one device key.

   The address proves control of a mailbox once. Everything after that is a
   signature from a key that never leaves the publisher's machine, so the
   registry holds no credential worth stealing. Publishing is still curated:
   a verified publisher's submission lands in the review queue.
--------------------------------------------------------------------------- */

async function requestChallenge(request: Request, env: RegistryEnv, cors: Record<string, string>): Promise<Response> {
  let body: { email?: string; handle?: string }
  try {
    body = await request.json() as typeof body
  } catch {
    return json({ error: 'invalid_body', message: 'Expected { email }.' }, 400, cors)
  }
  const pepper = env.EMAIL_PEPPER
  if (!pepper) return json({ error: 'not_configured', message: 'Publisher identity is not configured on this registry.' }, 503, cors)

  let email: ReturnType<typeof normalizeEmail>
  try {
    email = normalizeEmail(body.email)
  } catch (error) {
    return json({ error: 'invalid_email', message: message(error) }, 400, cors)
  }
  const emailHash = await hashEmail(pepper, email.email)
  const recent = await env.DB.prepare("SELECT COUNT(*) AS total FROM challenges WHERE email_hash = ? AND created_at > ?").bind(emailHash, new Date(Date.now() - 60 * 60 * 1000).toISOString()).first<{ total: number }>()
  if ((recent?.total ?? 0) >= maxChallengesPerHour) return json({ error: 'rate_limited', message: 'Too many codes requested for this address. Try again later.' }, 429, cors)

  const id = randomId('ch')
  const code = randomCode()
  const now = new Date()
  const handle = (() => {
    try {
      return normalizeHandle(body.handle, email.local)
    } catch {
      return normalizeHandle(undefined, email.local)
    }
  })()
  await env.DB.prepare('INSERT INTO challenges (id, email_hash, email_domain, code_hash, handle, created_at, expires_at, attempts, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)')
    .bind(id, emailHash, email.domain, await hashCode(pepper, id, code), handle, now.toISOString(), new Date(now.getTime() + challengeTtlMs).toISOString()).run()

  let delivery = false
  try {
    delivery = await sendPublisherCode(env, email.email, code)
  } catch (error) {
    // A registry without a sending domain says so, instead of failing obscurely.
    // The message is written for whoever has to act on it: the agent relays it
    // verbatim, and the fix is a sending domain and one worker secret.
    return json({ error: 'mail_unavailable', message: 'Publisher codes cannot be emailed yet: this registry has no sending domain configured. Publishing stays unavailable until RESEND_API_KEY and MAIL_FROM are set on the registry.' }, 503, cors)
  }
  return json({
    status: 'code_sent',
    challengeId: id,
    expiresAt: new Date(now.getTime() + challengeTtlMs).toISOString(),
    handle,
    domain: email.domain,
    delivered: delivery,
    // Local development is the only place a code comes back in the response.
    ...(delivery ? {} : { code: env.ENV === 'production' ? undefined : code }),
  }, 202, cors)
}

async function verifyChallenge(request: Request, env: RegistryEnv, cors: Record<string, string>): Promise<Response> {
  let body: { challengeId?: string; code?: string; handle?: string; devicePublicKey?: string }
  try {
    body = await request.json() as typeof body
  } catch {
    return json({ error: 'invalid_body', message: 'Expected { challengeId, code, devicePublicKey }.' }, 400, cors)
  }
  const pepper = env.EMAIL_PEPPER
  if (!pepper) return json({ error: 'not_configured' }, 503, cors)
  const challenge = await env.DB.prepare('SELECT * FROM challenges WHERE id = ?').bind(String(body.challengeId || '')).first<{ id: string; email_hash: string; email_domain: string; code_hash: string; handle: string | null; expires_at: string; attempts: number; consumed_at: string | null }>()
  if (!challenge) return json({ error: 'unknown_challenge' }, 404, cors)
  if (challenge.consumed_at) return json({ error: 'already_used', message: 'This code was already used. Request a new one.' }, 409, cors)
  if (challenge.expires_at < new Date().toISOString()) return json({ error: 'expired', message: 'This code expired. Request a new one.' }, 410, cors)
  if (challenge.attempts >= maxCodeAttempts) return json({ error: 'too_many_attempts', message: 'Too many attempts. Request a new code.' }, 429, cors)

  const supplied = String(body.code || '').trim()
  const expected = await hashCode(pepper, challenge.id, supplied)
  if (expected !== challenge.code_hash) {
    await env.DB.prepare('UPDATE challenges SET attempts = attempts + 1 WHERE id = ?').bind(challenge.id).run()
    return json({ error: 'invalid_code', message: 'That code is not right.', attemptsLeft: Math.max(0, maxCodeAttempts - (challenge.attempts + 1)) }, 400, cors)
  }

  const publicKey = String(body.devicePublicKey || '').trim()
  if (publicKey.length < 32) return json({ error: 'device_key_required', message: 'A device public key is required.' }, 400, cors)

  // The person gave an address, nothing else, so the display name is ours to
  // resolve: their existing one if this address already publishes, otherwise a
  // free name derived from it. A collision with somebody else's address must not
  // become a question the person cannot answer.
  const existing = await env.DB.prepare('SELECT handle, email_hash, status FROM publishers WHERE email_hash = ?').bind(challenge.email_hash).first<{ handle: string; status: string }>()
  if (existing && existing.status !== 'active') return json({ error: 'suspended', message: 'This publisher is suspended.' }, 403, cors)
  const handle = existing?.handle || await freeHandle(env.DB, normalizeHandle(body.handle ?? challenge.handle, challenge.email_domain.split('.')[0]))

  const now = new Date().toISOString()
  const deviceId = randomId('dev')
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO publishers (handle, email_hash, email_domain, created_at, status) VALUES (?, ?, ?, ?, 'active')").bind(handle, challenge.email_hash, challenge.email_domain, now),
    env.DB.prepare('INSERT INTO devices (id, publisher_handle, public_key, created_at, revoked_at, last_seen_at) VALUES (?, ?, ?, ?, NULL, ?)').bind(deviceId, handle, publicKey, now, now),
    env.DB.prepare('UPDATE challenges SET consumed_at = ? WHERE id = ?').bind(now, challenge.id),
  ])

  return json({ status: 'verified', handle, domain: challenge.email_domain, deviceId, createdAt: now }, 201, cors)
}

/** The first name nobody else holds, so a second `alice@` still gets a name. */
async function freeHandle(db: RegistryDatabase, base: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`
    const candidate = `${base.slice(0, 40 - suffix.length)}${suffix}`
    const taken = await db.prepare('SELECT handle FROM publishers WHERE handle = ?').bind(candidate).first<{ handle: string }>()
    if (!taken) return candidate
  }
  return `${base.slice(0, 34)}-${randomId('').slice(0, 4) || 'x'}`
}

async function revokeDevice(env: RegistryEnv, handle: string, deviceId: string, cors: Record<string, string>): Promise<Response> {
  await env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND publisher_handle = ?').bind(new Date().toISOString(), deviceId, handle).run()
  return json({ status: 'revoked', handle, deviceId }, 200, cors)
}

/** Verify the device signature over this exact request, or explain why not. */
async function authorizePublisher(request: Request, env: RegistryEnv) {
  const auth = parsePublisherAuthorization(request.headers.get('authorization'))
  if (!auth) return { error: 'unauthorized', message: 'Expected a Shun-Publisher authorization header.' }
  const body = request.method === 'POST' ? new Uint8Array(await request.clone().arrayBuffer()) : new Uint8Array()
  const result = await verifyPublisherSignature(env.DB, auth, { method: request.method, path: new URL(request.url).pathname, body })
  return result.ok ? result : { error: 'unauthorized', message: result.error }
}

/**
 * The code goes out through Resend. Without a key it is printed to the worker log
 * outside production, so the flow is testable before a sending domain exists —
 * and impossible to enable in production by accident.
 */
async function sendPublisherCode(env: RegistryEnv, email: string, code: string) {
  const text = `Your Shun publisher code is ${code}. It expires in 10 minutes. If you did not ask to publish a plugin, ignore this message.`
  if (env.MAIL_SEND) {
    await env.MAIL_SEND({ to: email, subject: 'Your Shun publisher code', text })
    return true
  }
  if (!env.RESEND_API_KEY || env.MAIL_TRANSPORT === 'console') {
    if (env.ENV === 'production') throw Error('Email delivery is not configured on this registry.')
    console.log(`[publisher-code] ${email} ${code}`)
    return false
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Shun Marketplace <publish@shunagent.com>',
      to: [email],
      subject: 'Your Shun publisher code',
      text,
    }),
  })
  if (!response.ok) throw Error(`Could not send the code (HTTP ${response.status}).`)
  return true
}

/* ---------------------------------------------------------------------------
   Write side: curated publishing.

   Anyone may create a plugin and hand over the archive, but the catalog only
   shows what a reviewer approved. A first submission lands in `review`; the
   operator can publish it directly, approve a queued one, reject it with a note,
   or yank a version without deleting the record an installed copy resolves to.
--------------------------------------------------------------------------- */

async function handleWrite(request: Request, env: RegistryEnv, segments: string[], cors: Record<string, string>): Promise<Response> {
  // Binding a publisher is how a community author gets an identity at all, so it
  // is public — rate limited, single use, and never a bearer credential.
  if (segments[1] === 'publishers' && segments.length === 3 && segments[2] === 'challenge') return await requestChallenge(request, env, cors)
  if (segments[1] === 'publishers' && segments.length === 3 && segments[2] === 'verify') return await verifyChallenge(request, env, cors)

  const operator = operatorAuthorized(request, env)

  if (segments[1] === 'publish' && segments.length === 2) {
    let verifiedHandle: string | undefined
    if (!operator) {
      const publisher = await authorizePublisher(request, env)
      if ('error' in publisher) return json(publisher, 401, cors)
      verifiedHandle = publisher.handle
    }
    return await publishPackage(request, env, cors, verifiedHandle)
  }

  if (segments[1] === 'publishers' && segments.length === 3 && segments[2] === 'revoke-device') {
    const publisher = await authorizePublisher(request, env)
    if ('error' in publisher) return json(publisher, 401, cors)
    return await revokeDevice(env, publisher.handle, publisher.deviceId, cors)
  }

  if (!operator) return json({ error: 'unauthorized' }, 401, cors)

  if (segments[1] === 'submissions' && segments.length === 4 && segments[3] === 'review') return await reviewSubmission(request, env, segments[2], cors)

  const yank = segments[1] === 'plugins' && segments.length === 6 && segments[3] === 'versions' && segments[5] === 'yank'
  if (yank) return await yankVersion(env, segments[2], segments[4], cors)
  const block = segments[1] === 'plugins' && segments.length === 6 && segments[3] === 'versions' && segments[5] === 'block'
  if (block) return await blockVersion(request, env, segments[2], segments[4], cors)
  const transfer = segments[1] === 'plugins' && segments.length === 4 && segments[3] === 'publisher'
  if (transfer) return await transferPublisher(request, env, segments[2], cors)
  if (segments[1] === 'plugins' && segments.length === 4 && segments[3] === 'block') return await blockVersion(request, env, segments[2], '*', cors)

  return json({ error: 'not_found' }, 404, cors)
}

async function publishPackage(request: Request, env: RegistryEnv, cors: Record<string, string>, verifiedHandle?: string): Promise<Response> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return json({ error: 'invalid_body', message: 'Expected multipart/form-data with an archive field.' }, 400, cors)
  }
  const file = form.get('archive')
  if (!(file instanceof File)) return json({ error: 'archive_required', message: 'Send the .shunplugin file in the archive field.' }, 400, cors)
  const bytes = new Uint8Array(await file.arrayBuffer())

  let read: ReturnType<typeof readPluginArchive>
  try {
    read = readPluginArchive(bytes)
  } catch (error) {
    return json({ error: 'invalid_archive', message: message(error) }, 400, cors)
  }

  let manifest: ReturnType<typeof validatePluginPackage>
  try {
    manifest = validatePluginPackagePluginArchive(read.files)
  } catch (error) {
    return json({ error: 'invalid_manifest', message: message(error) }, 400, cors)
  }

  const reserved = await reservedIds(env.DB)
  const conflict = reserved.find(item => item.id === manifest.id)
  if (conflict) return json({ error: 'reserved_plugin_id', id: manifest.id, message: `${manifest.id} is ${conflict.note || `owned by ${conflict.owner}`} and cannot be published to the registry.` }, 409, cors)

  const existing = await pluginById(env.DB, manifest.id)
  // A verified publisher publishes under their own handle, never a claimed one.
  const requestedPublisher = verifiedHandle || String(form.get('publisher') || '').trim() || manifest.publisher
  if (existing && existing.publisher !== requestedPublisher) return json({ error: 'publisher_mismatch', id: manifest.id, publisher: existing.publisher, message: `${manifest.id} is already published by ${existing.publisher}.` }, 409, cors)
  if (await submissionFor(env.DB, manifest.id, manifest.version)) return json({ error: 'version_exists', id: manifest.id, version: manifest.version, message: `${manifest.id} ${manifest.version} is already published. Versions are immutable; bump the version and publish again.` }, 409, cors)

  // Community submissions are curated. The operator — and any publisher the
  // operator trusts with the store — publishes directly, because for them the
  // review step approves their own work.
  const publishNow = String(form.get('state') || 'published') === 'published' && (!verifiedHandle || isTrustedPublisher(env, verifiedHandle))
  const changelog = String(form.get('changelog') || '').trim() || null
  const featuredValue = form.get('featured')
  const featured = typeof featuredValue === 'string' && featuredValue.trim() ? Number(featuredValue) : undefined
  const now = new Date().toISOString()

  await env.ARCHIVES.put(marketplaceManifestKey(manifest.id, manifest.version), new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`), { httpMetadata: { contentType: 'application/json' } })
  const icon = manifest.iconAsset && /\.svg$/i.test(manifest.iconAsset) ? read.files.get(manifest.iconAsset) : undefined
  if (icon) await env.ARCHIVES.put(marketplaceIconKey(manifest.id, manifest.version), icon, { httpMetadata: { contentType: 'image/svg+xml' } })
  // Cover images are stored from the package's own bytes, so the store never links
  // to an image the publisher did not sign. A declared file that is missing or is
  // not an image is a broken listing, and it is refused here rather than rendered
  // as a hole in the store page.
  const declaredScreenshots = Array.isArray(manifest.screenshots) ? manifest.screenshots : []
  for (const [index, path] of declaredScreenshots.entries()) {
    const bytes = read.files.get(path)
    const type = screenshotContentType(path)
    if (!bytes || !type) return json({ error: 'screenshot_missing', id: manifest.id, version: manifest.version, path, message: `The package declares the screenshot ${path}, but the archive does not contain that PNG, JPEG, or WebP file.` }, 400, cors)
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
    await env.ARCHIVES.put(marketplaceScreenshotKey(manifest.id, manifest.version, index, extension), bytes, { httpMetadata: { contentType: type } })
  }
  const screenshots = declaredScreenshots.map(path => String(path))
  await env.ARCHIVES.put(marketplaceArchiveKey(manifest.id, manifest.version, read.contentSha256), bytes, { httpMetadata: { contentType: 'application/octet-stream' } })

  const submission: SubmissionRow = {
    id: `${manifest.id}@${manifest.version}`,
    plugin_id: manifest.id,
    version: manifest.version,
    publisher_handle: requestedPublisher,
    archive_sha256: read.sha256,
    content_sha256: read.contentSha256,
    files: read.files_count,
    bytes: read.contentBytes,
    archive_bytes: read.archiveBytes,
    manifest: JSON.stringify(manifest),
    changelog,
    submitted_at: now,
    state: publishNow ? 'published' : 'review',
    reviewed_at: publishNow ? now : null,
    review_note: publishNow ? (verifiedHandle ? 'Published directly by a trusted publisher.' : 'Published directly by the operator.') : null,
  }
  await env.DB.batch(publishStatements(env.DB, {
    submission,
    published: publishNow,
    entry: {
      permissions: manifest.permissions || [],
      ...(manifest.keywords ? { keywords: manifest.keywords } : {}),
      ...(manifest.categories ? { categories: manifest.categories as string[] } : {}),
      ...(screenshots.length ? { screenshots } : {}),
      ...(manifest.iconAsset || manifest.icon ? { icon: manifest.iconAsset || manifest.icon } : {}),
      ...(manifest.license ? { license: manifest.license } : {}),
      ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
      ...(manifest.repository ? { repository: manifest.repository } : {}),
    },
    manifestName: manifest.name,
    manifestDescription: manifest.description,
    publisher: requestedPublisher,
    ...(Number.isFinite(featured) ? { featured } : {}),
    ...(manifest.engines ? { engines: manifest.engines } : {}),
  }))

  return json({
    status: publishNow ? 'published' : 'review',
    id: manifest.id,
    version: manifest.version,
    publisher: requestedPublisher,
    archiveSha256: read.sha256,
    contentSha256: read.contentSha256,
    files: read.files_count,
    bytes: read.contentBytes,
  }, publishNow ? 201 : 202, cors)
}

async function listSubmissions(env: RegistryEnv, state: string, cors: Record<string, string>): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT id, plugin_id, version, publisher_handle, content_sha256, files, bytes, submitted_at, state, review_note FROM submissions WHERE state = ? ORDER BY submitted_at DESC LIMIT 100').bind(state).all<Record<string, unknown>>()
  return json({ state, submissions: results || [] }, 200, { ...cors, 'cache-control': 'no-store' })
}

async function reviewSubmission(request: Request, env: RegistryEnv, id: string, cors: Record<string, string>): Promise<Response> {
  let body: { decision?: string; note?: string; featured?: number }
  try {
    body = await request.json() as typeof body
  } catch {
    return json({ error: 'invalid_body', message: 'Expected a JSON decision.' }, 400, cors)
  }
  const decision = String(body.decision || '')
  if (decision !== 'publish' && decision !== 'reject' && decision !== 'hide') return json({ error: 'invalid_decision', message: 'decision must be publish, reject, or hide.' }, 400, cors)

  const submission = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first<SubmissionRow>()
  if (!submission) return json({ error: 'not_found', id }, 404, cors)
  const now = new Date().toISOString()
  const state = decision === 'publish' ? 'published' : decision === 'reject' ? 'rejected' : 'hidden'
  const manifest = JSON.parse(submission.manifest) as Record<string, unknown>

  await env.DB.batch(publishStatements(env.DB, {
    submission: { ...submission, state, reviewed_at: now, review_note: String(body.note || '').trim() || null },
    published: decision === 'publish',
    entry: {
      permissions: (manifest.permissions as never) || [],
      ...(manifest.keywords ? { keywords: manifest.keywords as string[] } : {}),
      ...(manifest.categories ? { categories: manifest.categories as string[] } : {}),
      ...(manifest.screenshots ? { screenshots: manifest.screenshots as string[] } : {}),
      ...(manifest.iconAsset || manifest.icon ? { icon: String(manifest.iconAsset || manifest.icon) } : {}),
      ...(manifest.license ? { license: String(manifest.license) } : {}),
      ...(manifest.homepage ? { homepage: String(manifest.homepage) } : {}),
      ...(manifest.repository ? { repository: String(manifest.repository) } : {}),
    },
    manifestName: String(manifest.name),
    manifestDescription: String(manifest.description),
    publisher: submission.publisher_handle,
    ...(Number.isFinite(body.featured) ? { featured: Number(body.featured) } : {}),
    ...(manifest.engines ? { engines: manifest.engines as { shun?: string } } : {}),
  }))
  if (decision === 'hide') await env.DB.prepare("UPDATE plugins SET status = 'hidden' WHERE id = ?").bind(submission.plugin_id).run()
  return json({ status: state, id: submission.plugin_id, version: submission.version }, 200, cors)
}

async function yankVersion(env: RegistryEnv, id: string, version: string, cors: Record<string, string>): Promise<Response> {
  const published = await publishedVersion(env.DB, id, version)
  if (!published) return json({ error: 'not_found', id, version }, 404, cors)
  await env.DB.prepare('UPDATE plugin_versions SET yanked_at = ? WHERE plugin_id = ? AND version = ?').bind(new Date().toISOString(), id, version).run()
  const remaining = (await versionsFor(env.DB, id)).filter(item => !item.yanked_at)
  const row = await pluginById(env.DB, id)
  const latest = remaining.find(item => item.version === row?.latest)?.version || remaining[0]?.version
  if (latest) await env.DB.prepare('UPDATE plugins SET latest = ? WHERE id = ?').bind(latest, id).run()
  else await env.DB.prepare("UPDATE plugins SET status = 'hidden' WHERE id = ?").bind(id).run()
  return json({ status: 'yanked', id, version, latest: latest ?? null }, 200, cors)
}

/**
 * Move a plugin to a different publisher.
 *
 * Ownership is what decides who may publish the next version, and it is not
 * something a client can claim: the target publisher has to exist, which means
 * somebody verified an email address for it. Transfers happen here, before the
 * first version is submitted under the new handle, because a version can never
 * change hands after the fact.
 */
async function transferPublisher(request: Request, env: RegistryEnv, id: string, cors: Record<string, string>): Promise<Response> {
  if (!marketplaceIdPattern.test(id) || id.length > 80) return json({ error: 'invalid_plugin_id' }, 400, cors)
  let handle = ''
  try {
    handle = String(((await request.json()) as { handle?: string })?.handle || '').trim().toLowerCase()
  } catch {
    handle = ''
  }
  if (!handle) return json({ error: 'handle_required', message: 'A transfer names the publisher handle it moves to.' }, 400, cors)

  const row = await pluginById(env.DB, id)
  if (!row) return json({ error: 'not_found', id }, 404, cors)
  if (row.publisher === handle) return json({ status: 'unchanged', id, publisher: handle }, 200, cors)

  const publisher = await env.DB.prepare("SELECT handle, status FROM publishers WHERE handle = ? AND status = 'active'").bind(handle).first<{ handle: string }>()
  if (!publisher) return json({ error: 'unknown_publisher', handle, message: `${handle} is not a verified publisher. It binds by email first, then a plugin can move to it.` }, 409, cors)

  const previous = row.publisher
  await env.DB.batch([
    env.DB.prepare('UPDATE plugins SET publisher = ? WHERE id = ?').bind(handle, id),
    env.DB.prepare('UPDATE submissions SET publisher_handle = ? WHERE plugin_id = ?').bind(handle, id),
  ])
  return json({ status: 'transferred', id, publisher: handle, previous }, 200, cors)
}

/**
 * Withdraw a version from copies that already exist. The reason is stored and
 * served, because a withdrawn plugin is only acceptable when the person running
 * it is told why.
 */
async function blockVersion(request: Request, env: RegistryEnv, id: string, version: string, cors: Record<string, string>): Promise<Response> {
  if (!marketplaceIdPattern.test(id) || id.length > 80) return json({ error: 'invalid_plugin_id' }, 400, cors)
  let reason = ''
  try {
    reason = String(((await request.json()) as { reason?: string })?.reason || '').trim()
  } catch {
    reason = ''
  }
  if (!reason) return json({ error: 'reason_required', message: 'Blocking a plugin requires a reason that a user will read.' }, 400, cors)
  const now = new Date().toISOString()
  await env.DB.prepare('INSERT INTO blocked (plugin_id, version, reason, blocked_at) VALUES (?, ?, ?, ?) ON CONFLICT(plugin_id, version) DO UPDATE SET reason = excluded.reason, blocked_at = excluded.blocked_at')
    .bind(id, version, reason, now).run()
  if (version === '*') await env.DB.prepare("UPDATE plugins SET status = 'hidden' WHERE id = ?").bind(id).run()
  else await env.DB.prepare('UPDATE plugin_versions SET yanked_at = ? WHERE plugin_id = ? AND version = ?').bind(now, id, version).run()
  return json({ status: 'blocked', id, version, reason }, 200, cors)
}

function newestBlock(rows: { blocked_at: string }[]) {
  return rows.reduce((newest, row) => row.blocked_at > newest ? row.blocked_at : newest, new Date(0).toISOString())
}

function operatorAuthorized(request: Request, env: RegistryEnv) {
  const token = env.OPERATOR_TOKEN
  if (!token) return false
  const header = request.headers.get('authorization') || ''
  const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!supplied || supplied.length !== token.length) return false
  // Constant-time comparison: a token check should not leak its prefix.
  let difference = 0
  for (let index = 0; index < token.length; index++) difference |= supplied.charCodeAt(index) ^ token.charCodeAt(index)
  return difference === 0
}

/**
 * A handle the operator trusts to publish without waiting for review. Trust is
 * configuration, not a database flag: it is granted by whoever deploys the
 * registry, and it applies only to that publisher's own verified identity.
 */
function isTrustedPublisher(env: RegistryEnv, handle: string) {
  const trusted = String(env.TRUSTED_PUBLISHERS || '').split(',').map(value => value.trim()).filter(Boolean)
  return trusted.includes(handle.trim())
}

function newestUpdate(rows: PluginRow[]) {
  return rows.reduce((newest, row) => row.updated_at > newest ? row.updated_at : newest, new Date(0).toISOString())
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function validatePluginPackagePluginArchive(files: ReadonlyMap<string, Uint8Array>) {
  return validatePluginPackage(pluginArchiveManifest(files), 'installed')
}

/**
 * Icons are stored beside the version they belong to. A version published before
 * the registry stored icons is extracted once, from its own archive, and cached
 * under its content digest — the same bytes every client already verified.
 */
async function serveIcon(env: RegistryEnv, id: string, version: string, contentSha256: string, headers: Record<string, string>) {
  const key = marketplaceIconKey(id, version)
  const stored = await env.ARCHIVES.get(key)
  if (stored) return new Response(await stored.arrayBuffer(), { status: 200, headers: { ...headers, 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=31536000, immutable' } })

  const archive = await env.ARCHIVES.get(marketplaceArchiveKey(id, version, contentSha256))
  if (!archive) return json({ error: 'not_found', id, version }, 404, headers)
  let icon: Uint8Array | undefined
  try {
    const read = readPluginArchive(new Uint8Array(await archive.arrayBuffer()))
    const manifest = validatePluginPackagePluginArchive(read.files)
    const asset = manifest.iconAsset
    if (asset && /\.svg$/i.test(asset)) icon = read.files.get(asset)
  } catch {
    icon = undefined
  }
  if (!icon) return json({ error: 'no_icon', id, version }, 404, headers)
  await env.ARCHIVES.put(key, icon, { httpMetadata: { contentType: 'image/svg+xml' } })
  return new Response(icon.slice().buffer as ArrayBuffer, { status: 200, headers: { ...headers, 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=31536000, immutable' } })
}

function screenshotContentType(path: string) {
  if (/\.png$/i.test(path)) return 'image/png'
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg'
  if (/\.webp$/i.test(path)) return 'image/webp'
  return undefined
}

/**
 * Cover images are stored beside the version they belong to, like the icon. A
 * version published before the registry stored them is extracted once from its own
 * archive and cached, so the served bytes are the ones the client already verified.
 */
async function serveScreenshot(env: RegistryEnv, id: string, version: string, contentSha256: string, index: number, headers: Record<string, string>) {
  const path = await declaredScreenshot(env, id, version, contentSha256, index)
  const type = path ? screenshotContentType(path) : undefined
  if (!path || !type) return json({ error: 'not_found', id, version, index }, 404, headers)
  const key = marketplaceScreenshotKey(id, version, index, path.slice(path.lastIndexOf('.')).toLowerCase())

  const stored = await env.ARCHIVES.get(key)
  if (stored) return new Response(await stored.arrayBuffer(), { status: 200, headers: { ...headers, 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' } })

  const archive = await env.ARCHIVES.get(marketplaceArchiveKey(id, version, contentSha256))
  if (!archive) return json({ error: 'not_found', id, version }, 404, headers)
  try {
    const read = readPluginArchive(new Uint8Array(await archive.arrayBuffer()))
    const bytes = read.files.get(path)
    if (!bytes) return json({ error: 'not_found', id, version, index }, 404, headers)
    await env.ARCHIVES.put(key, bytes, { httpMetadata: { contentType: type } })
    return new Response(bytes.slice().buffer as ArrayBuffer, { status: 200, headers: { ...headers, 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' } })
  } catch { return json({ error: 'not_found', id, version, index }, 404, headers) }
}

/**
 * Which file a screenshot index refers to. The published manifest is the record,
 * and the archive is the fallback for a version published before the registry kept
 * one, so serving never depends on guessing a name.
 */
async function declaredScreenshot(env: RegistryEnv, id: string, version: string, contentSha256: string, index: number): Promise<string | undefined> {
  const stored = await env.ARCHIVES.get(marketplaceManifestKey(id, version)).catch(() => undefined)
  if (stored) {
    try {
      const declared = JSON.parse(await new Response(await stored.arrayBuffer()).text())?.screenshots
      if (Array.isArray(declared)) return typeof declared[index] === 'string' ? declared[index] : undefined
    } catch {}
  }
  try {
    const archive = await env.ARCHIVES.get(marketplaceArchiveKey(id, version, contentSha256))
    if (!archive) return undefined
    const manifest = validatePluginPackagePluginArchive(readPluginArchive(new Uint8Array(await archive.arrayBuffer())).files)
    return Array.isArray(manifest.screenshots) && typeof manifest.screenshots[index] === 'string' ? manifest.screenshots[index] : undefined
  } catch { return undefined }
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

/**
 * The read API is public, credential-free data — the same catalog anyone can
 * fetch — so every origin may read it, including a local preview of the site.
 * A write endpoint must not inherit this: publishing is authorized by a device
 * signature, never by an origin.
 */
function corsHeaders(): Record<string, string> {
  return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' }
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } })
}
