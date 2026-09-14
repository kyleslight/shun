import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { glob, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { handleRegistryRequest, type RegistryBucket, type RegistryEnv } from './src/registry.ts'
import type { RegistryDatabase, RegistryStatement } from './src/store.ts'
import { buildPluginArchive, readPluginArchive, sha256Of } from '../src/plugin-archive-core.ts'
import { sha256Hex } from './src/publishers.ts'
import { marketplaceBlocks, type MarketplaceBlock } from '../src/marketplace.ts'

/**
 * The registry is exercised against the real schema and real SQL: `node:sqlite`
 * runs the same statements D1 runs, so a query that no longer matches the schema
 * fails here instead of in production.
 */
function sqliteDatabase(schema: string): RegistryDatabase {
  const database = new DatabaseSync(':memory:')
  database.exec(schema)
  const adapt = (query: string, values: unknown[] = []): RegistryStatement => ({
    bind: (...next: unknown[]) => adapt(query, next),
    first: async <T = Record<string, unknown>>() => (database.prepare(query).get(...(values as never[])) ?? null) as T | null,
    all: async <T = Record<string, unknown>>() => ({ results: database.prepare(query).all(...(values as never[])) as T[] }),
    run: async () => database.prepare(query).run(...(values as never[])),
  })
  return {
    prepare: query => adapt(query),
    batch: async statements => { for (const statement of statements) await statement.run() },
  }
}

function memoryBucket(): RegistryBucket & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>()
  return {
    objects,
    get: async key => {
      const bytes = objects.get(key)
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
    put: async (key, value) => { objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value)) },
  }
}

const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8')

async function fixturePackage(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'shun-registry-fixture-'))
  await mkdir(join(root, 'ui'), { recursive: true })
  const manifest = {
    schemaVersion: 1, id: 'prism', name: 'TeX Lens', description: 'Compiles and previews the workspace TeX project.',
    version: '0.3.0', publisher: 'tex-lens', runtime: { workspace: 'required' },
    permissions: [{ id: 'workspace.read', reason: 'Find the main .tex file.' }],
    contributes: { views: [{ id: 'prism.main', title: 'TeX Lens', location: 'workspace.right', entry: 'ui/index.html' }] },
    ...overrides,
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'ui', 'index.html'), '<!doctype html><meta charset="utf-8">')
  const files = new Map<string, Uint8Array>([
    ['manifest.json', new TextEncoder().encode(JSON.stringify(manifest))],
    ['ui/index.html', new TextEncoder().encode('<!doctype html><meta charset="utf-8">')],
  ])
  const bytes = buildPluginArchive(files)
  return { manifest, bytes, sha256: sha256Of(bytes), contentSha256: readPluginArchive(bytes).contentSha256 }
}

function form(archive: Uint8Array, fields: Record<string, string> = {}) {
  const body = new FormData()
  const copy = new ArrayBuffer(archive.byteLength)
  new Uint8Array(copy).set(archive)
  body.set('archive', new File([copy], 'package.shunplugin', { type: 'application/octet-stream' }))
  for (const [key, value] of Object.entries(fields)) body.set(key, value)
  return body
}

function environment(overrides: Partial<RegistryEnv> = {}): RegistryEnv & { bucket: RegistryBucket & { objects: Map<string, Uint8Array> } } {
  const bucket = memoryBucket()
  return { ARCHIVES: bucket, DB: sqliteDatabase(schema), OPERATOR_TOKEN: 'operator-secret', EMAIL_PEPPER: 'test-pepper', ENV: 'test', bucket, ...overrides }
}

const publish = (env: RegistryEnv, archive: Uint8Array, fields: Record<string, string> = {}, token = 'operator-secret') =>
  handleRegistryRequest(new Request('https://api.shunagent.com/v1/publish', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form(archive, fields),
  }), env)

const read = (env: RegistryEnv, path: string) => handleRegistryRequest(new Request(`https://api.shunagent.com${path}`), env)

test('publishing requires authorization and a valid archive', async () => {
  const status = environment()
  const fixture = await fixturePackage()

  assert.equal((await handleRegistryRequest(new Request('https://api.shunagent.com/v1/publish', { method: 'POST', body: form(fixture.bytes) }), status)).status, 401)
  assert.equal((await publish(status, fixture.bytes, {}, 'wrong-token')).status, 401)

  const empty = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/publish', { method: 'POST', headers: { authorization: 'Bearer operator-secret' }, body: new FormData() }), status)
  assert.equal(empty.status, 400)
  assert.equal((await empty.json() as { error: string }).error, 'archive_required')

  // One flipped byte must never be accepted, whichever layer notices it first.
  const tampered = new Uint8Array(fixture.bytes)
  tampered[Math.floor(tampered.length / 2)] ^= 0xff
  const broken = await publish(status, tampered)
  assert.equal(broken.status, 400)
  assert.ok(['invalid_archive', 'invalid_manifest'].includes((await broken.json() as { error: string }).error))

  // A package whose manifest the client would refuse is refused here too.
  const badManifest = await fixturePackage({ id: 'Not Valid' })
  const refused = await publish(status, badManifest.bytes)
  assert.equal(refused.status, 400)
  assert.equal((await refused.json() as { error: string }).error, 'invalid_manifest')
})

test('a published version reaches the catalog with both digests and installs from the same bytes', async () => {
  const env = environment()
  const fixture = await fixturePackage()
  const response = await publish(env, fixture.bytes, { changelog: 'First release.' })
  assert.equal(response.status, 201)
  const body = await response.json() as { status: string; id: string; archiveSha256: string; contentSha256: string }
  assert.equal(body.status, 'published')
  assert.equal(body.id, 'prism')
  assert.equal(body.archiveSha256, fixture.sha256)
  assert.equal(body.contentSha256, fixture.contentSha256)

  const listed = await (await read(env, '/v1/plugins?q=tex')).json() as { results: { id: string; latest: string; permissions: unknown[] }[] }
  assert.deepEqual(listed.results.map(item => item.id), ['prism'])
  assert.equal(listed.results[0].latest, '0.3.0')
  assert.equal(listed.results[0].permissions.length, 1)

  const download = await read(env, '/v1/plugins/prism/versions/0.3.0/download')
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('x-shun-archive-sha256'), fixture.sha256)
  assert.equal(download.headers.get('x-shun-content-sha256'), fixture.contentSha256)
  const served = new Uint8Array(await download.arrayBuffer())
  assert.equal(sha256Of(served), fixture.sha256)

  const detail = await (await read(env, '/v1/plugins/prism')).json() as { versions: { version: string }[]; publisher: string }
  assert.equal(detail.publisher, 'tex-lens')
  assert.deepEqual(detail.versions.map(item => item.version), ['0.3.0'])

  const manifest = await (await read(env, '/v1/plugins/prism/versions/0.3.0')).json() as { manifest: { id: string } }
  assert.equal(manifest.manifest.id, 'prism')
})

test('versions are immutable, ownership is enforced, and bundled ids are reserved', async () => {
  const env = environment()
  const fixture = await fixturePackage()
  await publish(env, fixture.bytes)

  const again = await publish(env, fixture.bytes)
  assert.equal(again.status, 409)
  assert.equal((await again.json() as { error: string }).error, 'version_exists')

  const other = await fixturePackage({ version: '0.4.0' })
  const stolen = await publish(env, other.bytes, { publisher: 'someone-else' })
  assert.equal(stolen.status, 409)
  assert.equal((await stolen.json() as { error: string }).error, 'publisher_mismatch')

  await env.DB.prepare('INSERT INTO reserved_ids (id, owner, note) VALUES (?, ?, ?)').bind('terminal', 'first-party', 'bundled with Shun').run()
  const reserved = await fixturePackage({ id: 'terminal', version: '9.9.9' })
  const rejected = await publish(env, reserved.bytes)
  assert.equal(rejected.status, 409)
  assert.equal((await rejected.json() as { error: string }).error, 'reserved_plugin_id')
})

test('a submission can wait for review, and only approval moves the catalog', async () => {
  const env = environment()
  const first = await fixturePackage()
  await publish(env, first.bytes)

  const draft = await fixturePackage({ version: '0.4.0' })
  const queued = await publish(env, draft.bytes, { state: 'review', changelog: 'Adds a preview cache.' })
  assert.equal(queued.status, 202)
  assert.equal((await queued.json() as { status: string }).status, 'review')

  const before = await (await read(env, '/v1/plugins/prism')).json() as { latest: string; versions: unknown[] }
  assert.equal(before.latest, '0.3.0')
  assert.equal(before.versions.length, 1)

  const queueResponse = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/submissions?state=review', { headers: { authorization: 'Bearer operator-secret' } }), env)
  assert.equal(queueResponse.status, 200)
  const queue = await queueResponse.json() as { submissions: { id: string; version: string }[] }
  assert.deepEqual(queue.submissions.map(item => item.version), ['0.4.0'])

  const approved = await handleRegistryRequest(new Request(`https://api.shunagent.com/v1/submissions/${queue.submissions[0].id}/review`, {
    method: 'POST', headers: { authorization: 'Bearer operator-secret', 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'publish', note: 'Reads well.' }),
  }), env)
  assert.equal(approved.status, 200)

  const after = await (await read(env, '/v1/plugins/prism')).json() as { latest: string; versions: { version: string; changelog?: string }[] }
  assert.equal(after.latest, '0.4.0')
  assert.deepEqual(after.versions.map(item => item.version), ['0.4.0', '0.3.0'])

  const rejected = await fixturePackage({ version: '0.5.0' })
  await publish(env, rejected.bytes, { state: 'review' })
  await handleRegistryRequest(new Request('https://api.shunagent.com/v1/submissions/prism@0.5.0/review', {
    method: 'POST', headers: { authorization: 'Bearer operator-secret', 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'reject', note: 'Ships a vendored binary.' }),
  }), env)
  const still = await (await read(env, '/v1/plugins/prism')).json() as { latest: string }
  assert.equal(still.latest, '0.4.0')
})

test('a publisher the operator trusts publishes straight to the store', async () => {
  const sent: { to: string; text: string }[] = []
  const env: RegistryEnv = { ...environment({ TRUSTED_PUBLISHERS: 'author, someone-else' }), MAIL_SEND: async (message) => { sent.push(message) } }
  const { keyPair, identity } = await boundPublisher(env, 'author@example.com', sent)
  assert.equal(identity.handle, 'author')

  const fixture = await fixturePackage({ id: 'ink', publisher: 'author' })
  const response = await signedPublish(env, keyPair.privateKey, identity, '/v1/publish', fixture.bytes)
  assert.equal(response.status, 201)
  assert.equal((await response.json() as { status: string }).status, 'published')
  // Review exists to look at what strangers submit; a trusted publisher's own
  // package reaches the store on the same request.
  assert.equal((await read(env, '/v1/plugins/ink')).status, 200)
})

test('a publisher outside the trusted list still waits for review', async () => {
  const sent: { to: string; text: string }[] = []
  const env: RegistryEnv = { ...environment({ TRUSTED_PUBLISHERS: 'someone-else' }), MAIL_SEND: async (message) => { sent.push(message) } }
  const { keyPair, identity } = await boundPublisher(env, 'author@example.com', sent)

  const fixture = await fixturePackage({ id: 'ink', publisher: 'author' })
  const response = await signedPublish(env, keyPair.privateKey, identity, '/v1/publish', fixture.bytes)
  assert.equal((await response.json() as { status: string }).status, 'review')
  assert.equal((await read(env, '/v1/plugins/ink')).status, 404)
})

test('yanking a version keeps the record an installed copy resolves to', async () => {
  const env = environment()
  await publish(env, (await fixturePackage()).bytes)

  const yanked = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/plugins/prism/versions/0.3.0/yank', { method: 'POST', headers: { authorization: 'Bearer operator-secret' } }), env)
  assert.equal(yanked.status, 200)
  assert.equal((await yanked.json() as { status: string }).status, 'yanked')

  // The download is gone, the submission record is not: an installed copy still
  // has a name, a digest, and a reason.
  assert.equal((await read(env, '/v1/plugins/prism/versions/0.3.0/download')).status, 404)
  const row = await env.DB.prepare('SELECT * FROM submissions WHERE plugin_id = ?').bind('prism').first<{ state: string }>()
  assert.equal(row?.state, 'published')
  const versions = await env.DB.prepare('SELECT yanked_at FROM plugin_versions WHERE plugin_id = ?').bind('prism').all<{ yanked_at: string }>()
  assert.ok(versions.results?.[0]?.yanked_at)
  assert.equal((await read(env, '/v1/plugins/prism')).status, 404)
})

test('search, ordering, and health reflect the database, not a cached file', async () => {
  const env = environment()
  await publish(env, (await fixturePackage({ id: 'prism', name: 'TeX Lens' })).bytes)
  await publish(env, (await fixturePackage({ id: 'ink', name: 'Ink', description: 'Drafts prose from an outline.' })).bytes, { publisher: 'tex-lens' })

  const health = await (await read(env, '/v1/health')).json() as { status: string; plugins: number }
  assert.equal(health.status, 'ok')
  assert.equal(health.plugins, 2)

  const byName = await (await read(env, '/v1/plugins?sort=name')).json() as { results: { id: string }[]; sort: string }
  assert.deepEqual(byName.results.map(item => item.id), ['ink', 'prism'])
  assert.equal(byName.sort, 'name')

  const searched = await (await read(env, '/v1/plugins?q=outline')).json() as { results: { id: string }[] }
  assert.deepEqual(searched.results.map(item => item.id), ['ink'])
  // Someone who knows the author, not the plugin name, still finds the author's plugins.
  const byPublisher = await (await read(env, '/v1/plugins?q=tex-lens')).json() as { results: { id: string }[] }
  assert.deepEqual(byPublisher.results.map(item => item.id), ['ink', 'prism'])
  // A publisher match still ranks below a name match, so the exact thing wins.
  const ranked = await (await read(env, '/v1/plugins?q=ink')).json() as { results: { id: string }[] }
  assert.deepEqual(ranked.results.map(item => item.id), ['ink'])

  // A store cannot render an unbounded catalog, so every answer says how much
  // matched and which window it is, and the next window is a separate request.
  const windowed = await (await read(env, '/v1/plugins?limit=1')).json() as { results: { id: string }[]; total: number; offset: number }
  assert.equal(windowed.total, 2)
  assert.equal(windowed.results.length, 1)
  assert.equal(windowed.offset, 0)
  const second = await (await read(env, '/v1/plugins?limit=1&offset=1')).json() as { results: { id: string }[]; total: number; offset: number }
  assert.equal(second.total, 2)
  assert.deepEqual(second.results.map(item => item.id), ['prism'])
  assert.equal(second.offset, 1)
  const unmatched = await (await read(env, '/v1/plugins?q=nothing-matches')).json() as { results: unknown[]; total: number }
  assert.equal(unmatched.total, 0)
  assert.deepEqual(unmatched.results, [])
  assert.equal((await read(env, '/v1/plugins?sort=cheapest')).status, 400)
  assert.equal((await read(env, '/v1/plugins/missing')).status, 404)
  assert.equal((await read(env, '/v1/plugins/Not-Valid')).status, 400)
  assert.equal((await read(env, '/v2/plugins')).status, 404)
})

test('the read API stays public while every write needs the operator token', async () => {
  const env = environment()
  await publish(env, (await fixturePackage()).bytes)

  const anonymous = await read(env, '/v1/plugins')
  assert.equal(anonymous.status, 200)
  assert.equal(anonymous.headers.get('access-control-allow-origin'), '*')
  assert.equal(anonymous.headers.get('access-control-allow-methods')?.includes('POST'), true)

  const unauthorized = [
    new Request('https://api.shunagent.com/v1/publish', { method: 'POST', body: form(new Uint8Array([1])) }),
    new Request('https://api.shunagent.com/v1/submissions?state=review', { method: 'POST' }),
    new Request('https://api.shunagent.com/v1/plugins/prism/versions/0.3.0/yank', { method: 'POST' }),
  ]
  for (const request of unauthorized) {
    const response = await handleRegistryRequest(request, env)
    assert.equal(response.status, 401)
    assert.equal((await response.json() as { error: string }).error, 'unauthorized')
  }
  assert.equal((await read(env, '/v1/plugins')).status, 200)
  assert.equal((await handleRegistryRequest(new Request('https://api.shunagent.com/v1/plugins', { method: 'PUT' }), env)).status, 405)
})

test('the storefront gets the package icon without understanding the archive', async () => {
  const env = environment()
  const root = await mkdtemp(join(tmpdir(), 'shun-registry-icon-'))
  await mkdir(join(root, 'ui'), { recursive: true })
  const manifest = {
    schemaVersion: 1, id: 'prism', name: 'TeX Lens', description: 'Compiles TeX.', version: '0.3.0', publisher: 'tex-lens',
    icon: 'icon.svg', runtime: { workspace: 'none' }, permissions: [],
    contributes: { views: [{ id: 'prism.main', title: 'TeX Lens', location: 'workspace.right', entry: 'ui/index.html' }] },
  }
  const icon = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'icon.svg'), icon)
  await writeFile(join(root, 'ui', 'index.html'), '<!doctype html><meta charset="utf-8">')
  const files = new Map<string, Uint8Array>([
    ['manifest.json', new TextEncoder().encode(JSON.stringify(manifest))],
    ['icon.svg', new TextEncoder().encode(icon)],
    ['ui/index.html', new TextEncoder().encode('<!doctype html><meta charset="utf-8">')],
  ])
  const bytes = buildPluginArchive(files)
  assert.equal((await publish(env, bytes)).status, 201)

  const listed = await (await read(env, '/v1/plugins')).json() as { results: { iconUrl?: string }[] }
  assert.match(listed.results[0].iconUrl || '', /^\/v1\/plugins\/prism\/icon\?v=0\.3\.0$/)

  const served = await read(env, '/v1/plugins/prism/icon')
  assert.equal(served.status, 200)
  assert.equal(served.headers.get('content-type'), 'image/svg+xml')
  assert.equal(served.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(await served.text(), icon)

  // A version published before icons were stored is extracted once and cached.
  await env.bucket.objects.delete('plugins/prism/0.3.0/icon.svg')
  assert.equal(await (await read(env, '/v1/plugins/prism/icon')).text(), icon)
  assert.ok(env.bucket.objects.has('plugins/prism/0.3.0/icon.svg'))

  // A package with a built-in glyph id has no icon of its own to serve.
  const plain = new Map<string, Uint8Array>([
    ['manifest.json', new TextEncoder().encode(JSON.stringify({ ...manifest, id: 'plain', icon: 'plugin' }))],
    ['ui/index.html', new TextEncoder().encode('<!doctype html>')],
  ])
  assert.equal((await publish(env, buildPluginArchive(plain))).status, 201)
  assert.equal((await read(env, '/v1/plugins/plain/icon')).status, 404)
  const plainListed = await (await read(env, '/v1/plugins?q=plain')).json() as { results: { iconUrl?: string }[] }
  assert.equal(plainListed.results[0].iconUrl, undefined)
})

test('a publisher binds to an email once, then signs instead of holding a secret', async () => {
  const env = environment()
  const sent: { to: string; text: string }[] = []
  await env.DB.prepare("INSERT OR IGNORE INTO publishers (handle, email_hash, email_domain, created_at, status) VALUES ('tex-lens', 'existing-hash', 'example.com', ?, 'active')").bind(new Date().toISOString()).run()
  const withMail: RegistryEnv = { ...env, MAIL_SEND: async (message) => { sent.push(message) } }

  const challengeResponse = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/publishers/challenge', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'author@example.com' }),
  }), withMail)
  assert.equal(challengeResponse.status, 202, JSON.stringify(await challengeResponse.clone().json()))
  const challenge = await challengeResponse.json() as { challengeId: string; handle: string; domain: string; delivered: boolean }
  assert.equal(challenge.delivered, true)
  assert.equal(challenge.domain, 'example.com')
  assert.equal(challenge.handle, 'author')
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /\b\d{6}\b/)

  // The code is never stored; only its hash, and a wrong code costs an attempt.
  const row = await env.DB.prepare('SELECT * FROM challenges WHERE id = ?').bind(challenge.challengeId).first<{ code_hash: string }>()
  assert.match(row?.code_hash || '', /^[0-9a-f]{64}$/)

  const wrong = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/publishers/verify', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.challengeId, code: '000000', devicePublicKey: 'x'.repeat(40) }),
  }), env)
  assert.equal(wrong.status, 400)
  assert.equal((await wrong.json() as { error: string }).error, 'invalid_code')

  // Recover the real code the way the mail path would have delivered it.
  const code = sent[0].text.match(/\b(\d{6})\b/)![1]
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const publicKey = base64Url(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)))
  const verified = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/publishers/verify', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.challengeId, code, devicePublicKey: publicKey, handle: 'Author' }),
  }), env)
  assert.equal(verified.status, 201)
  const identity = await verified.json() as { handle: string; deviceId: string; domain: string }
  assert.equal(identity.handle, 'author')
  assert.equal(identity.domain, 'example.com')

  const reuse = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/publishers/verify', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.challengeId, code, devicePublicKey: publicKey }),
  }), env)
  assert.equal(reuse.status, 409)
  assert.equal((await reuse.json() as { error: string }).error, 'already_used')

  // A signed publish needs no token, and lands in review because publishing is curated.
  const fixture = await fixturePackage({ id: 'ink', publisher: 'author' })
  const unsigned = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/publish', { method: 'POST', body: form(fixture.bytes) }), env)
  assert.equal(unsigned.status, 401)

  const signed = await signedPublish(env, keyPair.privateKey, identity, '/v1/publish', fixture.bytes)
  assert.equal(signed.status, 202)
  const queued = await signed.json() as { status: string; publisher: string }
  assert.equal(queued.status, 'review')
  assert.equal(queued.publisher, 'author')
  assert.equal((await read(env, '/v1/plugins/ink')).status, 404)

  // A signature over different bytes is worthless, and so is a stale one.
  const tampered = new Uint8Array(fixture.bytes)
  tampered[tampered.length - 1] ^= 0xff
  const forged = await signedPublish(env, keyPair.privateKey, identity, '/v1/publish', fixture.bytes, tampered)
  assert.equal(forged.status, 401)

  const revoked = await signedRequest(env, keyPair.privateKey, identity, {
    method: 'POST', path: '/v1/publishers/revoke-device', body: new Uint8Array(), timestamp: Date.now() - 10 * 60 * 1000,
  })
  assert.equal(revoked.status, 401)
  assert.equal((await revoked.json() as { message: string }).message, 'stale_signature')

  const revoke = await signedRequest(env, keyPair.privateKey, identity, { method: 'POST', path: '/v1/publishers/revoke-device', body: new Uint8Array() })
  assert.equal(revoke.status, 200)
  const afterwards = await signedPublish(env, keyPair.privateKey, identity, '/v1/publish', fixture.bytes)
  assert.equal(afterwards.status, 401)
})

test('publisher identity stays unavailable rather than silently open', async () => {
  const env = environment({ EMAIL_PEPPER: undefined })
  const response = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/publishers/challenge', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'author@example.com' }),
  }), env)
  assert.equal(response.status, 503)
  assert.equal((await response.json() as { error: string }).error, 'not_configured')

  const invalid = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/publishers/challenge', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'not-an-email' }),
  }), environment())
  assert.equal(invalid.status, 400)
})

async function boundPublisher(env: RegistryEnv, email: string, sent: { to: string; text: string }[]) {
  const challengeResponse = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/publishers/challenge', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
  }), env)
  assert.equal(challengeResponse.status, 202, JSON.stringify(await challengeResponse.clone().json()))
  const challenge = await challengeResponse.json() as { challengeId: string }
  const code = sent[sent.length - 1].text.match(/\b(\d{6})\b/)![1]
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const publicKey = base64Url(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)))
  const verified = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/publishers/verify', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.challengeId, code, devicePublicKey: publicKey }),
  }), env)
  assert.equal(verified.status, 201, JSON.stringify(await verified.clone().json()))
  return { keyPair, identity: await verified.json() as { handle: string; deviceId: string } }
}

function copyBuffer(bytes: Uint8Array) {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A multipart body built by hand, so the test can sign exactly what it sends. */
function multipartArchive(archive: Uint8Array, fields: Record<string, string> = {}) {
  const boundary = '----shun-registry-test-boundary'
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  for (const [key, value] of Object.entries(fields)) parts.push(encoder.encode(`--${boundary}\r\ncontent-disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`))
  parts.push(
    encoder.encode(`--${boundary}\r\ncontent-disposition: form-data; name="archive"; filename="package.shunplugin"\r\ncontent-type: application/octet-stream\r\n\r\n`),
    archive,
    encoder.encode(`\r\n--${boundary}--\r\n`),
  )
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
  return { bytes, contentType: `multipart/form-data; boundary=${boundary}` }
}

async function signedRequest(env: RegistryEnv, privateKey: CryptoKey, identity: { handle: string; deviceId: string }, input: { method: string; path: string; body: Uint8Array; contentType?: string; timestamp?: number }, signedOver?: Uint8Array) {
  const timestamp = input.timestamp ?? Date.now()
  const payload = `${input.method}\n${input.path}\n${timestamp}\n${await sha256Hex(signedOver ?? input.body)}`
  const signature = base64Url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(payload))))
  return handleRegistryRequest(new Request(`https://api.shunagent.com${input.path}`, {
    method: input.method,
    headers: {
      authorization: `Shun-Publisher handle=${identity.handle}, device=${identity.deviceId}, timestamp=${timestamp}, signature=${signature}`,
      ...(input.contentType ? { 'content-type': input.contentType } : {}),
    },
    ...(input.body.byteLength ? { body: copyBuffer(input.body) } : {}),
  }), env)
}

function signedPublish(env: RegistryEnv, privateKey: CryptoKey, identity: { handle: string; deviceId: string }, path: string, archive: Uint8Array, signedOver?: Uint8Array) {
  const body = multipartArchive(archive)
  return signedRequest(env, privateKey, identity, { method: 'POST', path, body: body.bytes, contentType: body.contentType }, signedOver)
}

test('every id the application owns is reserved in the registry', async () => {
  const sql = await readFile(new URL('./reserved-ids.sql', import.meta.url), 'utf8')
  const reserved = new Set([...sql.matchAll(/VALUES \('([^']+)'/g)].map(match => match[1]))

  const bundled = []
  for await (const path of glob(new URL('../resources/plugins/*/manifest.json', import.meta.url).pathname)) {
    bundled.push((JSON.parse(await readFile(path, 'utf8')) as { id: string }).id)
  }
  const plugins = await readFile(new URL('../src/main/plugins.ts', import.meta.url), 'utf8')
  const connectors = [...plugins.matchAll(/\n    id: '([a-z0-9.-]+)',\n/g)].map(match => match[1])

  assert.ok(bundled.length >= 4)
  assert.ok(connectors.length >= 8)
  for (const id of [...bundled, ...connectors]) assert.ok(reserved.has(id), `${id} must be reserved so nobody can publish under it`)
  assert.ok(reserved.size >= bundled.length + connectors.length, 'reserved-ids.sql should not lose entries')

  // And the reserved list is what the worker refuses, not just a file.
  const env = environment()
  await env.DB.batch([...reserved].map(id => env.DB.prepare('INSERT OR REPLACE INTO reserved_ids (id, owner, note) VALUES (?, ?, ?)').bind(id, 'first-party', 'bundled with Shun')))
  const clash = await fixturePackage({ id: bundled[0], version: '9.9.9' })
  const refused = await publish(env, clash.bytes)
  assert.equal(refused.status, 409)
  assert.equal((await refused.json() as { error: string }).error, 'reserved_plugin_id')
})

test('a version can be withdrawn from the copies that already exist', async () => {
  const env = environment()
  const fixture = await fixturePackage()
  await publish(env, fixture.bytes)

  assert.deepEqual(await (await read(env, '/v1/blocklist')).json(), { updatedAt: new Date(0).toISOString(), blocked: [] })

  const noReason = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/plugins/prism/versions/0.3.0/block', {
    method: 'POST', headers: { authorization: 'Bearer operator-secret', 'content-type': 'application/json' }, body: JSON.stringify({}),
  }), env)
  assert.equal(noReason.status, 400)
  assert.equal((await noReason.json() as { error: string }).error, 'reason_required')

  const blocked = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/plugins/prism/versions/0.3.0/block', {
    method: 'POST', headers: { authorization: 'Bearer operator-secret', 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Sends workspace contents to a third party.' }),
  }), env)
  assert.equal(blocked.status, 200)

  const list = await (await read(env, '/v1/blocklist')).json() as { blocked: MarketplaceBlock[] }
  assert.deepEqual(list.blocked.map(item => [item.id, item.version, item.reason]), [['prism', '0.3.0', 'Sends workspace contents to a third party.']])

  // A blocked version is no longer downloadable, and a client can match the
  // entry against what it already installed.
  assert.equal((await read(env, '/v1/plugins/prism/versions/0.3.0/download')).status, 404)
  assert.equal(marketplaceBlocks(list.blocked[0], 'prism', '0.3.0'), true)
  assert.equal(marketplaceBlocks(list.blocked[0], 'prism', '0.4.0'), false)
  assert.equal(marketplaceBlocks(list.blocked[0], 'other', '0.3.0'), false)

  // Blocking every version at once hides the plugin from the store entirely.
  const whole = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/plugins/prism/block', {
    method: 'POST', headers: { authorization: 'Bearer operator-secret', 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Withdrawn by its author.' }),
  }), env)
  assert.equal(whole.status, 200)
  assert.equal((await read(env, '/v1/plugins/prism')).status, 404)
  const rest = await (await read(env, '/v1/blocklist')).json() as { blocked: { version: string }[] }
  assert.equal(rest.blocked.some(item => item.version === '*'), true)

  assert.equal((await handleRegistryRequest(new Request('https://api.shunagent.com/v1/plugins/prism/block', { method: 'POST', body: JSON.stringify({ reason: 'nope' }) }), env)).status, 401)
})

test('ownership moves before a version is published, and only to a verified publisher', async () => {
  const env = environment()
  const fixture = await fixturePackage()
  await publish(env, fixture.bytes)
  assert.equal((await read(env, '/v1/plugins/prism')).status, 200)

  const sign = (path: string, body: unknown, token = 'operator-secret') => handleRegistryRequest(new Request(`https://api.shunagent.com${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env)

  // A handle nobody verified cannot receive a plugin.
  const unknown = await sign('/v1/plugins/prism/publisher', { handle: 'kyleslight' })
  assert.equal(unknown.status, 409)
  assert.equal((await unknown.json() as { error: string }).error, 'unknown_publisher')

  await env.DB.prepare("INSERT INTO publishers (handle, email_hash, email_domain, created_at, status) VALUES ('kyleslight', 'hash', 'gmail.com', ?, 'active')").bind(new Date().toISOString()).run()
  const moved = await sign('/v1/plugins/prism/publisher', { handle: 'kyleslight' })
  assert.equal(moved.status, 200)
  assert.deepEqual(await moved.json(), { status: 'transferred', id: 'prism', publisher: 'kyleslight', previous: 'tex-lens' })

  // The store reports the new owner, the record of the first version moved with it.
  assert.equal(((await (await read(env, '/v1/plugins/prism')).json()) as { publisher: string }).publisher, 'kyleslight')
  const submission = await env.DB.prepare('SELECT publisher_handle FROM submissions WHERE plugin_id = ?').bind('prism').first<{ publisher_handle: string }>()
  assert.equal(submission?.publisher_handle, 'kyleslight')

  // And the old handle can no longer publish under this id.
  const next = await fixturePackage({ version: '0.4.0', publisher: 'tex-lens' })
  const refused = await publish(env, next.bytes, { publisher: 'tex-lens' })
  assert.equal(refused.status, 409)
  assert.equal((await refused.json() as { error: string }).error, 'publisher_mismatch')

  assert.equal((await sign('/v1/plugins/prism/publisher', { handle: 'kyleslight' })).status, 200)
  assert.equal((await sign('/v1/plugins/prism/publisher', {}, 'wrong')).status, 401)
  assert.equal((await sign('/v1/plugins/missing/publisher', { handle: 'kyleslight' })).status, 404)
})

test('two people with the same local part both get a publisher, without being asked to choose', async () => {
  const env = environment()
  const sent: { to: string; text: string }[] = []
  const withMail: RegistryEnv = { ...env, MAIL_SEND: async (message) => { sent.push(message) } }
  const bind = async (email: string) => {
    const challenge = await (await handleRegistryRequest(new Request('https://api.shunagent.com/v1/publishers/challenge', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
    }), withMail)).json() as { challengeId: string; handle: string }
    const code = sent[sent.length - 1].text.match(/\b(\d{6})\b/)![1]
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const response = await handleRegistryRequest(new Request('https://api.shunagent.com/v1/publishers/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: challenge.challengeId, code, devicePublicKey: base64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))) }),
    }), env)
    return { status: response.status, body: await response.json() as { handle?: string; error?: string } }
  }

  const first = await bind('alice@gmail.com')
  assert.equal(first.status, 201)
  assert.equal(first.body.handle, 'alice')

  // The second person is never asked to invent a name; the registry resolves it.
  const second = await bind('alice@outlook.com')
  assert.equal(second.status, 201)
  assert.equal(second.body.handle, 'alice-2')

  // The same address keeps the name it already has, even after the collision.
  const again = await bind('alice@gmail.com')
  assert.equal(again.status, 201)
  assert.equal(again.body.handle, 'alice')

  const rows = await env.DB.prepare('SELECT handle, email_domain FROM publishers ORDER BY handle').all<{ handle: string; email_domain: string }>()
  // SQLite hands back null-prototype rows; compare the fields, not the wrapper.
  assert.deepEqual((rows.results || []).map(row => `${row.handle}@${row.email_domain}`), ['alice@gmail.com', 'alice-2@outlook.com'])
})
