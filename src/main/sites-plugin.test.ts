import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { validatePluginPackage } from '../plugin-manifest.ts'
// The gateway is uploaded to Cloudflare verbatim as a Workers ES module, so it
// stays plain JavaScript inside the plugin package rather than being compiled by
// this project. Its behaviour is asserted here as the public surface it is.
// @ts-expect-error plain Workers module without type declarations
import gatewayModule from '../../resources/plugins/sites/gateway/worker.mjs'

const worker = gatewayModule as { fetch: (request: Request, env: unknown) => Promise<Response> }
const pluginRoot = new URL('../../resources/plugins/sites/', import.meta.url)

async function manifest() {
  return validatePluginPackage(JSON.parse(await readFile(new URL('manifest.json', pluginRoot), 'utf8')), 'builtin')
}

/** A KV stand-in with the two reads the gateway uses, and nothing else. */
function kv(records: Record<string, { value: unknown, metadata?: Record<string, unknown> }>) {
  return {
    async get(key: string) { return records[key]?.value ?? null },
    async getWithMetadata(key: string) {
      const record = records[key]
      if (!record) return { value: null, metadata: null }
      return { value: record.value, metadata: record.metadata ?? null }
    },
  }
}

async function hash(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function gateway(records: Record<string, { value: unknown, metadata?: Record<string, unknown> }>) {
  return (url: string, init?: RequestInit) => worker.fetch(new Request(url, init), { SITES: kv(records) })
}

test('the Sites package is a bundled plugin that adds no worker, no secret, and no permanent rail entry', async () => {
  const value = await manifest()
  const view = value.contributes!.views![0]
  assert.equal(value.id, 'sites')
  assert.equal(value.distribution, 'required')
  assert.equal(value.runtime!.workspace, 'optional')
  assert.equal(value.contributes!.views!.length, 1)
  assert.equal(view.id, 'sites.manage')
  assert.equal(view.rail, 'transient')
  assert.deepEqual(view.launch, ['user', 'assistant', 'tool-result'])
  assert.deepEqual(value.contributes!.skills, [{ path: 'skills' }])
  // The sandboxed view never talks to Cloudflare: every call goes through the host,
  // which is what keeps a publish an explicit local action.
  assert.deepEqual(value.contributes!.workers, [])
  assert.equal(value.permissions!.some(permission => permission.id === 'workspace.process'), false)
  const html = await readFile(new URL('ui/index.html', pluginRoot), 'utf8')
  assert.match(html, /connect-src 'none'/)

  // The view asks for no decision that belongs to the product: the domain is
  // fixed, the address is assigned, and the Cloudflare account behind it is not
  // the panel's business.
  // The Skill has to distinguish "publish" from publishing with Sites, and has to
  // describe the offer instead of an automatic publish.
  const skill = await readFile(new URL('skills/sites-publishing/SKILL.md', pluginRoot), 'utf8')
  assert.match(skill, /is not a Sites request by itself/)
  assert.match(skill, /user asks to publish \*\*with Sites\*\*/)
  assert.match(skill, /Offer once; if they decline or ignore/)
  const publishTool = (await readFile(new URL('./index.ts', import.meta.url), 'utf8')).slice(0)
  assert.match(publishTool, /"Publish" on its own is ambiguous/)

  const app = await readFile(new URL('ui/app.js', pluginRoot), 'utf8')
  for (const forbidden of ['accountName', 'account_id', 'setup-zone', 'publish-slug', 'sites.zones', 'zone_id']) {
    assert.equal(app.includes(forbidden), false, `the Sites panel must not mention ${forbidden}`)
  }

  // Nothing in the client knows or says what the publishing service runs on: no
  // Cloudflare credential, no account, no zone, no vocabulary.
  const client = await readFile(new URL('./site-publishing.ts', import.meta.url), 'utf8')
  for (const [name, text] of [['the client', client], ['the panel', app], ['the manifest', JSON.stringify(value)], ['the Skill', await readFile(new URL('skills/sites-publishing/SKILL.md', pluginRoot), 'utf8')]] as const) {
    assert.equal(/cloudflare/i.test(text), false, `${name} must not mention Cloudflare`)
  }
  assert.equal(/basic |bearer [a-z]+key|api[_ -]?token/i.test(client), false, 'the client must not hold a credential of its own')
})

test('the gateway answers only for published hosts and serves assets with their own content type', async () => {
  const body = new TextEncoder().encode('<!doctype html><h1>hello</h1>').buffer
  const call = gateway({
    'h:quiet-lake.example.com': { value: { slug: 'quiet-lake', title: 'Quiet Lake', visibility: 'public' } },
    'a:quiet-lake/index.html': { value: body, metadata: { sha256: 'abc123', type: 'text/html; charset=utf-8' } },
  })

  const missing = await call('https://nothing-here.example.com/')
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('x-shun-sites'), 'gateway')
  assert.equal(missing.headers.get('x-robots-tag'), 'noindex')

  const page = await call('https://quiet-lake.example.com/')
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(page.headers.get('etag'), '"abc123"')
  assert.equal(await page.text(), '<!doctype html><h1>hello</h1>')

  const cached = await call('https://quiet-lake.example.com/', { headers: { 'if-none-match': '"abc123"' } })
  assert.equal(cached.status, 304)
})

test('the gateway refuses traversal, pauses an off site, and gates a password site without a stored secret', async () => {
  const salt = 'a1b2c3d4'
  const expected = await hash(`${salt}hunter2`)
  const call = gateway({
    'h:gated.example.com': { value: { slug: 'gated', title: 'Gated', visibility: 'password', salt, hash: expected } },
    'h:paused.example.com': { value: { slug: 'paused', visibility: 'off' } },
    'h:quiet-lake.example.com': { value: { slug: 'quiet-lake', visibility: 'public' } },
    'a:quiet-lake/index.html': { value: new TextEncoder().encode('ok').buffer, metadata: { type: 'text/html; charset=utf-8' } },
    'a:quiet-lake/secret.txt': { value: new TextEncoder().encode('nope').buffer, metadata: { type: 'text/plain' } },
  })

  assert.equal((await call('https://paused.example.com/')).status, 503)
  assert.equal((await call('https://quiet-lake.example.com/..%2f..%2fsecret.txt')).status, 404)

  const denied = await call('https://gated.example.com/')
  assert.equal(denied.status, 401)
  assert.match(await denied.text(), /name="password"/)

  const wrong = await call('https://gated.example.com/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=wrong',
  })
  assert.equal(wrong.status, 401)
  assert.match(await wrong.text(), /not correct/)

  const granted = await call('https://gated.example.com/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=hunter2',
  })
  assert.equal(granted.status, 303)
  assert.equal(granted.headers.get('set-cookie'), `__shun_site=${expected}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`)

  const withCookie = await call('https://gated.example.com/', { headers: { cookie: `__shun_site=${expected}` } })
  assert.equal(withCookie.status, 404)
  assert.equal(withCookie.headers.get('x-shun-sites'), 'gateway')
})

test('the empty address is the one page that may introduce the product', async () => {
  const records = {
    'h:paused.example.com': { value: { slug: 'paused', visibility: 'off' } },
    'h:live.example.com': { value: { slug: 'live', visibility: 'public' } },
  }
  const call = (url: string) => worker.fetch(new Request(url), { SITES: kv(records) })

  // Nobody published this address, so it may say what Shun is and link to it.
  const empty = await call('https://free-address.example.com/')
  const emptyBody = await empty.text()
  assert.equal(empty.status, 404)
  assert.match(emptyBody, /https:\/\/shunagent\.com/)
  assert.match(emptyBody, /See Shun/)
  assert.match(empty.headers.get('x-robots-tag') || '', /noindex/)

  // A site that exists but has no such page belongs to its owner: no promotion.
  const missing = await call('https://live.example.com/notes')
  assert.equal(missing.status, 404)
  assert.equal((await missing.text()).includes('shunagent.com'), false)

  // A paused site is factual too.
  const paused = await call('https://paused.example.com/')
  assert.equal(paused.status, 503)
  assert.equal((await paused.text()).includes('shunagent.com'), false)
})
