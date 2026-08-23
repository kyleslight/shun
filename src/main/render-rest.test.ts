import assert from 'node:assert/strict'
import test from 'node:test'
import { MemoryPluginSecretStore } from './plugin-secrets.ts'
import { RenderRestService } from './render-rest.ts'

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

test('Render connection validates and stores an API key after listing workspaces', async () => {
  const secrets = new MemoryPluginSecretStore()
  const seen: Array<{ url: string; authorization: string | null }> = []
  const service = new RenderRestService(secrets, async (input, init) => {
    seen.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') })
    return response([{ owner: { id: 'tea-example', name: 'Example Workspace' }, cursor: 'next' }])
  })

  assert.deepEqual(await service.connect('rnd_secret'), {
    connected: true, status: 'connected', account: 'Example Workspace', message: 'Connected to Example Workspace',
  })
  assert.equal(await secrets.get('render'), 'rnd_secret')
  assert.deepEqual(seen, [{ url: 'https://api.render.com/v1/owners?limit=20', authorization: 'Bearer rnd_secret' }])
})

test('Render rejects an API key that cannot list workspaces without retaining or replacing it', async () => {
  const emptyStore = new MemoryPluginSecretStore()
  const rejected = new RenderRestService(emptyStore, async () => response({ message: 'Unauthorized' }, 401))
  assert.equal((await rejected.connect('rnd_invalid')).connected, false)
  assert.equal(await emptyStore.get('render'), undefined)

  const configuredStore = new MemoryPluginSecretStore(); await configuredStore.set('render', 'rnd_existing')
  const replacement = new RenderRestService(configuredStore, async () => response({ message: 'Unauthorized' }, 401))
  assert.equal((await replacement.connect('rnd_invalid')).connected, false)
  assert.equal(await configuredStore.get('render'), 'rnd_existing')
})

test('Render tools use bounded official REST endpoints and explicit deploy bodies', async () => {
  const secrets = new MemoryPluginSecretStore(); await secrets.set('render', 'rnd_secret')
  const seen: Array<{ url: string; method: string; body?: string }> = []
  const service = new RenderRestService(secrets, async (input, init) => {
    seen.push({ url: String(input), method: init?.method || 'GET', body: init?.body ? String(init.body) : undefined })
    return response({ ok: true })
  })

  assert.equal(await service.services({ ownerId: 'tea-example', name: 'api', type: 'web_service', limit: 5 }), '{"ok":true}')
  await service.service('srv-example')
  await service.deploys('srv-example', { status: 'live', limit: 4 })
  await service.logs({ ownerId: 'tea-example', resourceId: 'srv-example', startTime: '2026-08-23T00:00:00Z', direction: 'backward', level: 'error', text: 'timeout', limit: 25 })
  await service.triggerDeploy('srv-example', { clearCache: true, commitId: 'abcdef1234567' })

  assert.deepEqual(seen, [
    { url: 'https://api.render.com/v1/services?ownerId=tea-example&name=api&type=web_service&limit=5', method: 'GET', body: undefined },
    { url: 'https://api.render.com/v1/services/srv-example', method: 'GET', body: undefined },
    { url: 'https://api.render.com/v1/services/srv-example/deploys?status=live&limit=4', method: 'GET', body: undefined },
    { url: 'https://api.render.com/v1/logs?ownerId=tea-example&resource=srv-example&startTime=2026-08-23T00%3A00%3A00.000Z&direction=backward&level=error&text=timeout&limit=25', method: 'GET', body: undefined },
    { url: 'https://api.render.com/v1/services/srv-example/deploys', method: 'POST', body: '{"clearCache":"clear","commitId":"abcdef1234567"}' },
  ])
})

test('Render disconnect removes the stored API key and invalid IDs never reach the network', async () => {
  const secrets = new MemoryPluginSecretStore(); await secrets.set('render', 'rnd_secret')
  let calls = 0
  const service = new RenderRestService(secrets, async () => { calls++; return response({}) })
  await assert.rejects(() => service.service('../owners'), /valid Render service ID/)
  assert.equal(calls, 0)
  assert.equal((await service.disconnect()).status, 'disconnected')
  assert.equal(await secrets.get('render'), undefined)
})
