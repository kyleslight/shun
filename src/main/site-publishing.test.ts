import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CloudflareApi } from './cloudflare-rest.ts'
import { SitePublishingService, slugify } from './site-publishing.ts'
import { MemoryPluginSecretStore } from './plugin-secrets.ts'

const zoneId = '9a7806061c88ada191ed06f989cc3dac'
const accountId = '023e105f4ecef8ad9ca31a8372d0c353'
const namespaceId = '0f2a1c3d4e5f60718293a4b5c6d7e8f9'

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/** A Cloudflare stand-in that keeps KV in a map and records every request path. */
function cloudflare(options: { dnsRecords?: Array<{ id: string, name: string, type: string }>, bindCustomDomain?: boolean, refuseKv?: boolean, extraZones?: Array<{ id: string, name: string, accountId: string }> } = {}) {
  const kv = new Map<string, string>()
  const calls: Array<{ method: string, path: string }> = []
  const keyOf = (path: string) => decodeURIComponent(path.split('/values/')[1] || '')
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace('https://api.cloudflare.com/client/v4', '')
    const method = init?.method || 'GET'
    calls.push({ method, path })
    if (path === '/user/tokens/verify') return json({ success: true, result: { status: 'active' } })
    if (options.refuseKv && path.includes('/storage/kv/namespaces')) return json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, 403)
    if (path.startsWith('/zones?')) return json({ success: true, result: [{ id: zoneId, name: 'shunagent.site', account: { id: accountId, name: 'Example' } }, ...(options.extraZones || []).map(zone => ({ id: zone.id, name: zone.name, account: { id: zone.accountId } }))] })
    if (path.includes('/storage/kv/namespaces') && path.includes('?') && method === 'GET') return json({ success: true, result: [{ id: namespaceId, title: 'shun-sites' }] })
    if (path.endsWith('/storage/kv/namespaces') && method === 'POST') return json({ success: true, result: { id: namespaceId } })
    if (path.includes('/workers/scripts/') && method === 'PUT') return json({ success: true, result: { id: 'shun-sites-gateway' } })
    if (path.endsWith('/workers/domains')) return options.bindCustomDomain === false ? json({ success: false, errors: [{ message: 'not available' }] }, 400) : json({ success: true, result: {} })
    if (path.includes('/workers/routes') && method === 'GET') return json({ success: true, result: [] })
    if (path.includes('/workers/routes')) return json({ success: true, result: {} })
    if (path.includes('/dns_records') && method === 'GET') return json({ success: true, result: options.dnsRecords || [] })
    if (path.includes('/dns_records')) return json({ success: true, result: { id: 'record' } })
    if (path.endsWith('/bulk') && method === 'PUT') {
      for (const entry of JSON.parse(String(init?.body)) as Array<{ key: string, value: string, base64?: boolean }>) kv.set(entry.key, entry.base64 ? Buffer.from(entry.value, 'base64').toString('utf8') : entry.value)
      return json({ success: true, result: {} })
    }
    if (path.endsWith('/bulk') && method === 'DELETE') {
      for (const key of JSON.parse(String(init?.body)) as string[]) kv.delete(key)
      return json({ success: true, result: {} })
    }
    if (path.includes('/values/')) {
      const key = keyOf(path)
      if (method === 'PUT') { kv.set(key, String(init?.body)); return json({ success: true, result: null }) }
      if (method === 'DELETE') { kv.delete(key); return json({ success: true, result: null }) }
      const stored = kv.get(key)
      return stored === undefined ? json({ success: false, errors: [{ code: 10009, message: 'key not found' }] }, 404) : new Response(stored, { status: 200 })
    }
    if (path.endsWith('/purge_cache')) return json({ success: true, result: {} })
    throw Error(`unexpected Cloudflare request: ${method} ${path}`)
  }) as typeof fetch
  return { kv, calls, fetcher }
}

async function serviceFor(options: Parameters<typeof cloudflare>[0] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'shun-sites-'))
  const workspace = join(root, 'project')
  await mkdir(join(workspace, 'dist', 'nested'), { recursive: true })
  await writeFile(join(workspace, 'dist', 'index.html'), '<h1>one</h1>')
  await writeFile(join(workspace, 'dist', 'app.js'), 'console.log(1)')
  await writeFile(join(workspace, 'dist', 'nested', 'deep.txt'), 'deep')
  const secrets = new MemoryPluginSecretStore()
  await secrets.set('cloudflare', 'cfut_token')
  const fake = cloudflare(options)
  const service = new SitePublishingService(new CloudflareApi(secrets, fake.fetcher), {
    configFile: join(root, 'sites.json'),
    readGatewaySource: async () => 'export default { async fetch() { return new Response("ok") } }',
    fetchUrl: (async () => new Response('ok', { status: 200, headers: { 'x-shun-sites': 'gateway' } })) as typeof fetch,
  })
  return { service, fake, workspace, root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('setup provisions one namespace and one wildcard host, and only calls itself ready once the gateway answers', async () => {
  const context = await serviceFor()
  const result = await context.service.setup({ zoneId })
  assert.equal(result.verified, true)
  assert.equal(result.config.baseDomain, 'shunagent.site')
  assert.equal(result.config.hostBinding, 'custom-domain')
  assert.equal(result.config.certificateWarning, false)
  assert.deepEqual(JSON.parse(await readFile(join(context.root, 'sites.json'), 'utf8')).config.zoneId, zoneId)
  const paths = context.fake.calls.map(call => `${call.method} ${call.path}`)
  assert.ok(paths.some(path => path.startsWith(`PUT /accounts/${accountId}/workers/scripts/shun-sites-gateway`)))
  assert.ok(paths.includes(`PUT /accounts/${accountId}/workers/domains`))
  await context.cleanup()
})

test('setup falls back to a zone route and warns when the sites domain sits below the certificate level', async () => {
  const context = await serviceFor({ bindCustomDomain: false })
  const result = await context.service.setup({ zoneId, baseDomain: 'sites.shunagent.site' })
  assert.equal(result.config.hostBinding, 'route')
  assert.equal(result.config.certificateWarning, true)
  assert.match(result.warning || '', /Universal SSL/)
  const paths = context.fake.calls.map(call => `${call.method} ${call.path}`)
  assert.ok(paths.includes(`POST /zones/${zoneId}/dns_records`))
  assert.ok(paths.includes(`POST /zones/${zoneId}/workers/routes`))
  await context.cleanup()
})

test('publishing uploads every file once, then only what changed, and removes what disappeared', async () => {
  const context = await serviceFor()
  await context.service.setup({ zoneId })

  const first = await context.service.publish({ workspace: context.workspace, path: 'dist', slug: 'demo-site' })
  assert.equal(first.uploaded, 3)
  assert.equal(first.unchanged, 0)
  assert.equal(first.live, true)
  assert.equal(first.site.url, 'https://demo-site.shunagent.site/')
  assert.equal(first.site.files, 3)
  assert.equal(context.fake.kv.get('a:demo-site/nested/deep.txt'), 'deep')
  assert.deepEqual(JSON.parse(context.fake.kv.get('index')!), ['demo-site'])
  assert.equal(JSON.parse(context.fake.kv.get('h:demo-site.shunagent.site')!).slug, 'demo-site')

  const second = await context.service.publish({ workspace: context.workspace, path: 'dist', slug: 'demo-site' })
  assert.equal(second.uploaded, 0)
  assert.equal(second.unchanged, 3)
  assert.equal(second.site.revision, 2)

  await writeFile(join(context.workspace, 'dist', 'app.js'), 'console.log(2)')
  await rm(join(context.workspace, 'dist', 'nested'), { recursive: true })
  const third = await context.service.publish({ workspace: context.workspace, path: 'dist', slug: 'demo-site' })
  assert.equal(third.uploaded, 1)
  assert.equal(third.removed, 1)
  assert.equal(context.fake.kv.has('a:demo-site/nested/deep.txt'), false)
  assert.equal(context.fake.kv.get('a:demo-site/app.js'), 'console.log(2)')

  const listed = await context.service.status()
  assert.deepEqual(listed.sites.map(site => site.slug), ['demo-site'])
  assert.equal(listed.sites[0].visibility, 'public')
  await context.cleanup()
})

test('a publish refuses what it cannot serve honestly, and resolves a taken name instead of asking', async () => {
  const context = await serviceFor({ dnsRecords: [{ id: 'r1', name: 'taken.shunagent.site', type: 'CNAME' }] })
  await context.service.setup({ zoneId })
  await mkdir(join(context.workspace, 'empty'), { recursive: true })
  await assert.rejects(() => context.service.publish({ workspace: context.workspace, path: 'empty' }), /index\.html/)
  await assert.rejects(() => context.service.publish({ workspace: context.workspace, path: '../outside' }), /inside the selected workspace|unavailable/)

  // A name the zone already answers on is skipped, not turned into a question.
  const varied = await context.service.publish({ workspace: context.workspace, path: 'dist', slug: 'taken' })
  assert.equal(varied.site.slug, 'taken-2')
  assert.equal(varied.site.url, 'https://taken-2.shunagent.site/')
  assert.match(varied.message, /taken was taken, so this site has its own address/)

  // Reserved names the same way: the user never has to know the list.
  const reserved = await context.service.publish({ workspace: context.workspace, path: 'dist', slug: 'www' })
  assert.equal(reserved.site.slug, 'www-2')
  await context.cleanup()
})

test('a password site stores a salted hash, never the password, and the change is reversible', async () => {
  const context = await serviceFor()
  await context.service.setup({ zoneId })
  await context.service.publish({ workspace: context.workspace, path: 'dist', slug: 'demo-site' })

  const secured = await context.service.setAccess({ slug: 'demo-site', visibility: 'password', password: 'hunter2' })
  assert.equal(secured.visibility, 'password')
  const record = JSON.parse(context.fake.kv.get('s:demo-site')!)
  const expected = createHash('sha256').update(`${record.salt}hunter2`).digest('hex')
  assert.equal(record.hash, expected)
  assert.equal(JSON.stringify(record).includes('hunter2'), false)
  assert.equal(JSON.parse(context.fake.kv.get('h:demo-site.shunagent.site')!).hash, expected)
  // Re-selecting the same mode without retyping keeps the working password, and a
  // site that has none yet cannot be password protected by accident.
  assert.equal((await context.service.setAccess({ slug: 'demo-site', visibility: 'password' })).visibility, 'password')
  assert.equal(JSON.parse(context.fake.kv.get('s:demo-site')!).hash, expected)
  assert.equal((await context.service.setAccess({ slug: 'demo-site', visibility: 'public' })).visibility, 'public')
  assert.equal(JSON.parse(context.fake.kv.get('h:demo-site.shunagent.site')!).hash, undefined)
  await context.cleanup()
})

test('taking a site down removes its files, its records, and its index entry', async () => {
  const context = await serviceFor()
  await context.service.setup({ zoneId })
  await context.service.publish({ workspace: context.workspace, path: 'dist', slug: 'demo-site' })
  const result = await context.service.remove('demo-site')
  assert.equal(result.files, 3)
  for (const key of [...context.fake.kv.keys()]) assert.equal(key.startsWith('a:demo-site/') || key === 's:demo-site' || key === 'f:demo-site' || key === 'h:demo-site.shunagent.site', false, key)
  assert.deepEqual(JSON.parse(context.fake.kv.get('index')!), [])
  assert.deepEqual((await context.service.status()).sites, [])
  await context.cleanup()
})

test('publishing sets publishing up on first use, so a conversation never needs a panel', async () => {
  const context = await serviceFor()
  // No setup call at all: the first publish resolves the zone, provisions, and reports both facts.
  const result = await context.service.publish({ workspace: context.workspace, path: 'dist', slug: 'demo-site' })
  assert.equal(result.setup?.baseDomain, 'shunagent.site')
  assert.equal(result.site.url, 'https://demo-site.shunagent.site/')
  assert.match(result.message, /Set up publishing under shunagent.site\. Published 3 files/)
  assert.equal(context.fake.kv.has('s:demo-site'), true)
  assert.ok(context.fake.calls.some(call => call.path.includes('/workers/scripts/shun-sites-gateway')))
  await context.cleanup()
})

test('a protected site gets a password when none was named, and the plaintext is never stored', async () => {
  const context = await serviceFor()
  const result = await context.service.publish({ workspace: context.workspace, path: 'dist', slug: 'demo-site', visibility: 'password' })
  const issued = result.password || ''
  // Four groups of five from a look-alike-free alphabet: long enough to matter,
  // short enough to retype from a chat message.
  assert.match(issued, /^[a-hj-km-np-z2-9]{5}(?:-[a-hj-km-np-z2-9]{5}){3}$/)
  const record = JSON.parse(context.fake.kv.get('s:demo-site')!)
  assert.equal(record.visibility, 'password')
  assert.equal(record.hash, createHash('sha256').update(`${record.salt}${issued}`).digest('hex'))
  assert.equal(JSON.stringify([...context.fake.kv.values()]).includes(issued), false)
  // Asking for protection again without naming a password keeps the working one.
  const again = await context.service.setAccess({ slug: 'demo-site', visibility: 'password' })
  assert.equal(again.password, undefined)
  assert.equal(JSON.parse(context.fake.kv.get('s:demo-site')!).hash, record.hash)
  await context.cleanup()
})

test('the publishing domain decides the zone, so an account with several zones is never a question', async () => {
  const one = await serviceFor()
  assert.equal((await one.service.setup({})).config.zoneName, 'shunagent.site')
  await one.cleanup()

  // Several zones in one account is ordinary: the fixed domain still resolves.
  const many = await serviceFor({ extraZones: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'other.example', accountId }] })
  assert.equal((await many.service.setup({})).config.zoneName, 'shunagent.site')
  // A domain that is not in the account is a named failure, not a menu.
  await assert.rejects(() => many.service.setup({ baseDomain: 'missing.example' }), /missing\.example is not in this Cloudflare account/)
  await many.cleanup()
})

test('a project keeps its own address, and a name clash resolves itself', async () => {
  const context = await serviceFor()
  await writeFile(join(context.workspace, 'package.json'), '{}')
  const first = await context.service.publish({ workspace: context.workspace, path: 'dist' })
  assert.equal(first.site.url, 'https://project.shunagent.site/')
  const again = await context.service.publish({ workspace: context.workspace, path: 'dist' })
  assert.equal(again.site.slug, 'project')
  assert.equal(again.uploaded, 0)

  // Another project with the same folder name is given its own address silently.
  const other = join(context.root, 'other', 'project')
  await mkdir(join(other, 'dist'), { recursive: true })
  await writeFile(join(other, 'package.json'), '{}')
  await writeFile(join(other, 'dist', 'index.html'), '<h1>other</h1>')
  const clashed = await context.service.publish({ workspace: other, path: 'dist' })
  assert.equal(clashed.site.slug, 'project-2')

  // Replacing that address is a deliberate act, and it moves ownership.
  const taken = await context.service.publish({ workspace: other, path: 'dist', slug: 'project', takeOver: true })
  assert.equal(taken.site.slug, 'project')
  const settled = await context.service.publish({ workspace: other, path: 'dist', slug: 'project' })
  assert.equal(settled.site.slug, 'project')
  assert.equal(settled.uploaded, 0)
  await context.cleanup()
})

test('a refused Cloudflare write names the one scope the token is missing', async () => {
  const context = await serviceFor({ refuseKv: true })
  await assert.rejects(() => context.service.setup({ zoneId }), /Workers KV Storage: Edit[\s\S]*Authentication error/)
  await context.cleanup()
})

test('site identity is a stable, safe name derived from the project folder', async () => {
  assert.equal(slugify('My Portfolio Site'), 'my-portfolio-site')
  assert.equal(slugify('  déjà vu  '), 'deja-vu')
  assert.equal(slugify('...'), 'site')
})
