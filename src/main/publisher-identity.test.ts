import assert from 'node:assert/strict'
import test from 'node:test'
import { PublisherIdentityStore } from './publisher-identity.ts'
import { MemoryPluginSecretStore } from './plugin-secrets.ts'

function registry(overrides: Record<string, unknown> = {}) {
  const requests: { url: string; body: unknown }[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const payload = overrides[url.replace('https://registry.test', '')]
    if (payload === undefined) return new Response(JSON.stringify({ message: 'no route' }), { status: 404 })
    const failed = Boolean((payload as { error?: string }).error)
    return new Response(JSON.stringify(payload), { status: failed ? 400 : 200 })
  }) as typeof fetch
  return { impl, requests }
}

test('binding creates a device key that never leaves this machine', async () => {
  const { impl, requests } = registry({
    '/v1/publishers/challenge': { status: 'code_sent', challengeId: 'ch_1', domain: 'example.com', handle: 'author', expiresAt: 'later', delivered: true },
    '/v1/publishers/verify': { status: 'verified', handle: 'author', domain: 'example.com', deviceId: 'dev_1', createdAt: '2026-09-13T00:00:00.000Z' },
    '/v1/publishers/revoke-device': { status: 'revoked' },
  })
  const secrets = new MemoryPluginSecretStore()
  const identity = new PublisherIdentityStore(secrets, impl, 'https://registry.test')

  assert.equal(await identity.status(), undefined)
  const challenge = await identity.requestCode('author@example.com', 'author')
  assert.equal(challenge.challengeId, 'ch_1')
  assert.equal(requests[0].url, 'https://registry.test/v1/publishers/challenge')

  const bound = await identity.verify({ challengeId: 'ch_1', code: '123456' })
  assert.equal(bound.handle, 'author')
  assert.equal(bound.deviceId, 'dev_1')
  const sent = requests[1].body as { devicePublicKey: string; code: string }
  assert.equal(sent.code, '123456')
  assert.ok(sent.devicePublicKey.length > 40, 'the public key is sent, the private key is not')

  // The stored private key signs a request the registry can verify independently.
  const body = new TextEncoder().encode('the package bytes')
  const header = await identity.authorization('POST', '/v1/publish', body)
  const fields = Object.fromEntries(header.replace('Shun-Publisher ', '').split(',').map(part => part.trim().split('=') as [string, string]))
  assert.equal(fields.handle, 'author')
  assert.equal(fields.device, 'dev_1')
  const publicKey = await crypto.subtle.importKey('raw', Buffer.from(sent.devicePublicKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), { name: 'Ed25519' }, false, ['verify'])
  const { createHash } = await import('node:crypto')
  const payload = `POST\n/v1/publish\n${fields.timestamp}\n${createHash('sha256').update(body).digest('hex')}`
  const signature = Buffer.from(fields.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  assert.equal(await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, new TextEncoder().encode(payload)), true)

  const stored = await secrets.get('publisher-identity')
  assert.ok(stored?.includes('privateKeyPkcs8'))
  assert.equal(await identity.unbind(), true)
  assert.equal(await identity.status(), undefined)
  assert.equal(await identity.authorization('POST', '/v1/publish', body).then(() => 'signed', error => (error as Error).message), 'No publisher identity is bound on this computer.')
})

test('a refusal from the registry is reported as the registry wrote it', async () => {
  const { impl } = registry({ '/v1/publishers/verify': { error: 'invalid_code', message: 'That code is not right.' } })
  const identity = new PublisherIdentityStore(new MemoryPluginSecretStore(), impl, 'https://registry.test')
  await assert.rejects(identity.verify({ challengeId: 'ch_1', code: '000000' }), /That code is not right\./)

  const offline = new PublisherIdentityStore(new MemoryPluginSecretStore(), (async () => { throw Error('ECONNREFUSED') }) as typeof fetch, 'https://registry.test')
  await assert.rejects(offline.requestCode('author@example.com'), /Could not reach the plugin registry/)
})
