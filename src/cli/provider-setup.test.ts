import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShunHostService } from '../host/service.ts'
import { setupProvider } from './provider-setup.ts'

test('built-in onboarding asks only for a masked key and persists connection and model defaults', async t => {
  const home = await mkdtemp(join(tmpdir(), 'shun-setup-'))
  const service = new ShunHostService(home)
  await service.initialize()
  t.after(async () => { await service.close(); await rm(home, { recursive: true, force: true }) })
  const id = await setupProvider(service.call.bind(service), {
    choose: async (_label, items) => { assert.ok(items.some(item => item.value === 'anthropic')); return 'anthropic' },
    ask: async (label, _initial, secret) => { assert.match(label, /API key/); assert.equal(secret, true); return 'test-secret' },
  })
  const config = await service.call('configuration')
  const provider = config.providers.find((item: any) => item.id === id)
  assert.equal(provider.name, 'Anthropic')
  assert.equal(provider.api, 'anthropic-messages')
  assert.equal(provider.endpoint, 'https://api.anthropic.com')
  assert.equal(provider.hasKey, true)
  assert.ok(provider.models.length)
  assert.equal(JSON.stringify(config).includes('test-secret'), false)
})

test('cancelling authentication does not save a partial provider', async () => {
  let saved = false
  await assert.rejects(setupProvider(async method => {
    if (method === 'provider.catalog') return { providers: [{ id: 'cloud', name: 'Cloud', endpoint: 'https://example.com', credentialLabel: 'API key', authHelpUrl: '' }] }
    if (method === 'configuration') return { providers: [] }
    saved = true
  }, { choose: async () => 'cloud', ask: async () => { throw Error('Cancelled.') } }), /Cancelled/)
  assert.equal(saved, false)
})

test('local onboarding only asks for the server address', async () => {
  let input: any
  const id = await setupProvider(async (method, value) => {
    if (method === 'provider.catalog') return { providers: [] }
    if (method === 'configuration') return { providers: [] }
    input = value; return { providers: [{ id: 'local' }] }
  }, { choose: async () => '__ollama__', ask: async (_label, initial, secret) => { assert.equal(secret, undefined); return initial! } })
  assert.equal(id, 'local')
  assert.equal(input.endpoint, 'http://localhost:11434/v1')
  assert.equal(input.apiKey, '')
})
