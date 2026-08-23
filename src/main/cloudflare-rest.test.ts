import assert from 'node:assert/strict'
import test from 'node:test'
import { CloudflareRestService } from './cloudflare-rest.ts'
import { MemoryPluginSecretStore } from './plugin-secrets.ts'

const accountId = '023e105f4ecef8ad9ca31a8372d0c353'
const zoneId = '9a7806061c88ada191ed06f989cc3dac'
const deploymentId = 'f64788e9-fccd-4d4a-a28a-cb84f88f6677'

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

test('Cloudflare connection verifies and stores an active API token', async () => {
  const secrets = new MemoryPluginSecretStore()
  const seen: Array<{ url: string; authorization: string | null }> = []
  const service = new CloudflareRestService(secrets, async (input, init) => {
    seen.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') })
    return response({ success: true, errors: [], result: { id: 'token-id', status: 'active' } })
  })

  assert.deepEqual(await service.connect('cfut_secret'), { connected: true, status: 'connected', message: 'Cloudflare connected.' })
  assert.equal(await secrets.get('cloudflare'), 'cfut_secret')
  assert.deepEqual(seen, [{ url: 'https://api.cloudflare.com/client/v4/user/tokens/verify', authorization: 'Bearer cfut_secret' }])
})

test('Cloudflare rejects an inactive or unauthorized token without retaining or replacing it', async () => {
  const emptyStore = new MemoryPluginSecretStore()
  const inactive = new CloudflareRestService(emptyStore, async () => response({ success: true, errors: [], result: { status: 'disabled' } }))
  assert.equal((await inactive.connect('cfut_inactive')).connected, false)
  assert.equal(await emptyStore.get('cloudflare'), undefined)

  const configuredStore = new MemoryPluginSecretStore(); await configuredStore.set('cloudflare', 'cfut_existing')
  const unauthorized = new CloudflareRestService(configuredStore, async () => response({ success: false, errors: [{ message: 'Invalid API token' }] }, 403))
  assert.equal((await unauthorized.connect('cfut_invalid')).connected, false)
  assert.equal(await configuredStore.get('cloudflare'), 'cfut_existing')
})

test('Cloudflare tools use bounded official read and explicit mutation endpoints', async () => {
  const secrets = new MemoryPluginSecretStore(); await secrets.set('cloudflare', 'cfut_secret')
  const seen: Array<{ url: string; method: string; body?: string }> = []
  const service = new CloudflareRestService(secrets, async (input, init) => {
    seen.push({ url: String(input), method: init?.method || 'GET', body: init?.body ? String(init.body) : undefined })
    return response({ success: true, result: { env_vars: { SECRET: { type: 'secret_text', value: 'hidden' } }, id: 'ok' } })
  })

  assert.doesNotMatch(await service.accounts({ name: 'Example', limit: 10 }), /hidden/)
  await service.zones({ accountId, name: 'example.com', status: 'active', limit: 10 })
  await service.dnsRecords(zoneId, { name: 'www.example.com', type: 'CNAME', proxied: true, limit: 25 })
  await service.workers(accountId, { tags: 'production:yes' })
  await service.workerDeployments(accountId, 'edge-api')
  await service.pagesProjects(accountId, { limit: 12 })
  await service.pagesDeployments(accountId, 'dashboard', { environment: 'production', limit: 8 })
  await service.pagesDeploymentLogs(accountId, 'dashboard', deploymentId)
  await service.retryPagesDeployment(accountId, 'dashboard', deploymentId)
  await service.purgeCache(zoneId, { files: ['https://example.com/app.js'] })

  assert.deepEqual(seen, [
    { url: 'https://api.cloudflare.com/client/v4/accounts?page=1&per_page=10&name=Example', method: 'GET', body: undefined },
    { url: `https://api.cloudflare.com/client/v4/zones?page=1&per_page=10&account.id=${accountId}&name=example.com&status=active`, method: 'GET', body: undefined },
    { url: `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?page=1&per_page=25&name=www.example.com&type=CNAME&proxied=true`, method: 'GET', body: undefined },
    { url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts?tags=production%3Ayes`, method: 'GET', body: undefined },
    { url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/edge-api/deployments`, method: 'GET', body: undefined },
    { url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects?page=1&per_page=12`, method: 'GET', body: undefined },
    { url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/dashboard/deployments?page=1&per_page=8&env=production`, method: 'GET', body: undefined },
    { url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/dashboard/deployments/${deploymentId}/history/logs`, method: 'GET', body: undefined },
    { url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/dashboard/deployments/${deploymentId}/retry`, method: 'POST', body: undefined },
    { url: `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, method: 'POST', body: '{"files":["https://example.com/app.js"]}' },
  ])
})

test('Cloudflare disconnect removes the token and invalid targets never reach the network', async () => {
  const secrets = new MemoryPluginSecretStore(); await secrets.set('cloudflare', 'cfut_secret')
  let calls = 0
  const service = new CloudflareRestService(secrets, async () => { calls++; return response({ success: true, result: {} }) })
  await assert.rejects(() => service.dnsRecords('../zones'), /32-character Cloudflare zone ID/)
  await assert.rejects(() => service.purgeCache(zoneId, { files: ['http://example.com'] }), /valid HTTPS URLs/)
  await assert.rejects(() => service.purgeCache(zoneId, { files: [], purgeEverything: false }), /Choose either/)
  assert.equal(calls, 0)
  assert.equal((await service.disconnect()).status, 'disconnected')
  assert.equal(await secrets.get('cloudflare'), undefined)
})
