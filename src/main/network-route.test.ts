import assert from 'node:assert/strict'
import test from 'node:test'
import { createNetworkFetch, isLocalNetworkUrl } from './network-route.ts'

test('local routing recognizes address ranges, normalized literals, and local names without treating public hosts as local', () => {
  for (const url of ['http://10.0.0.1', 'https://172.16.0.1', 'http://172.31.255.255', 'http://192.168.50.27:30041/v1', 'http://127.0.0.1', 'http://127.1', 'http://169.254.1.1', 'http://[::1]', 'http://[fd12::1]', 'http://[fe80::1]', 'http://[::ffff:192.168.1.1]', 'http://localhost.', 'http://host.local', 'http://app.localhost'])
    assert.equal(isLocalNetworkUrl(url), true, url)
  for (const url of ['https://example.com', 'https://192.168.example.com', 'https://localhost.example.com', 'http://172.15.255.255', 'http://172.32.0.1', 'http://11.0.0.1', 'http://[2606:4700::1111]', 'file:///tmp/test', 'invalid'])
    assert.equal(isLocalNetworkUrl(url), false, url)
})

test('concurrent local requests share direct-route setup and preserve bodies, credentials, and cancellation; public requests keep the system route', async () => {
  let setups = 0
  const directCalls: unknown[][] = [], systemCalls: unknown[][] = []
  const system = (async (...args) => { systemCalls.push(args); return new Response('public') }) as typeof fetch
  const direct = (async (...args) => { directCalls.push(args); return new Response('local') }) as typeof fetch
  const fetch = createNetworkFetch(system, async () => { setups++; await Promise.resolve(); return direct })
  const controller = new AbortController()
  const init = { method: 'POST', body: 'request', headers: { Authorization: 'Bearer test' }, signal: controller.signal }
  const local = new URL('http://192.168.1.2/v1')
  await Promise.all([fetch(local, init), fetch(new Request('http://[::1]/v1'), init), fetch('https://example.com', init)])
  assert.equal(setups, 1)
  assert.equal(directCalls.length, 2)
  assert.equal(directCalls[0][0], local)
  assert.equal(directCalls[0][1], init)
  assert.equal(systemCalls.length, 1)
  assert.equal(systemCalls[0][1], init)
})

test('a failed local-route setup does not poison subsequent requests or affect public requests', async () => {
  let attempts = 0
  const fetch = createNetworkFetch(async () => new Response('public'), async () => {
    if (++attempts === 1) throw Error('setup failed')
    return async () => new Response('local')
  })
  await assert.rejects(fetch('http://localhost'), /setup failed/)
  assert.equal(await (await fetch('https://example.com')).text(), 'public')
  assert.equal(await (await fetch('http://localhost')).text(), 'local')
  assert.equal(attempts, 2)
})
