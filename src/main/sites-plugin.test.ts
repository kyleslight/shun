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
  // Nothing may sit permanently in the composer path: the conversation is where
  // publishing happens, and the panel is offered through tool results instead.
  assert.deepEqual(value.contributes!.conversationActions, [])
  assert.equal(value.permissions!.some(permission => permission.id === 'conversation.ui'), false)
  assert.deepEqual(value.contributes!.skills, [{ path: 'skills' }])
  // The sandboxed view never talks to Cloudflare: every call goes through the host,
  // which is what keeps a publish an explicit local action.
  assert.deepEqual(value.contributes!.workers, [])
  assert.equal(value.permissions!.some(permission => permission.id === 'workspace.process'), false)
  const html = await readFile(new URL('ui/index.html', pluginRoot), 'utf8')
  assert.match(html, /connect-src 'none'/)
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
