import assert from 'node:assert/strict'
import test from 'node:test'
import { FigmaRestService, parseFigmaUrl } from './figma-rest.ts'
import { MemoryPluginSecretStore } from './plugin-secrets.ts'

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

test('Figma URLs expose stable file and node identities', () => {
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/design/AbCdEf123/My-file?node-id=12-34'), { fileKey: 'AbCdEf123', nodeId: '12:34' })
  assert.deepEqual(parseFigmaUrl('https://figma.com/file/AbCdEf123/My-file'), { fileKey: 'AbCdEf123', nodeId: undefined })
  assert.throws(() => parseFigmaUrl('https://evil.example/design/AbCdEf123/x'), /figma\.com/)
})

test('Figma without a configured PAT is a neutral disconnected state', async () => {
  const service = new FigmaRestService(new MemoryPluginSecretStore(), async () => {
    throw Error('unconfigured state must not make a request')
  })

  assert.deepEqual(await service.state(), { connected: false, status: 'disconnected' })
})

test('Figma PAT is verified before it is retained and never appears in output', async () => {
  const store = new MemoryPluginSecretStore(), seen: Array<{ url: string; token: string | null }> = []
  const service = new FigmaRestService(store, async (input, init) => {
    seen.push({ url: String(input), token: new Headers(init?.headers).get('x-figma-token') })
    return json({ id: '1', email: 'designer@example.com' })
  })
  const state = await service.connect('figd_secret')
  assert.equal(state.connected, true)
  assert.equal(state.account, 'designer@example.com')
  assert.equal(await store.get('figma'), 'figd_secret')
  assert.deepEqual(seen, [{ url: 'https://api.figma.com/v1/me', token: 'figd_secret' }])
  assert.doesNotMatch(JSON.stringify(state), /figd_secret/)
})

test('Figma design reads return a bounded normalized node tree', async () => {
  const store = new MemoryPluginSecretStore(); await store.set('figma', 'token')
  const service = new FigmaRestService(store, async input => {
    assert.match(String(input), /\/files\/AbCdEf123\/nodes\?ids=12%3A34&depth=2$/)
    return json({
      name: 'Checkout', version: '5', lastModified: 'now',
      nodes: { '12:34': { document: { id: '12:34', name: 'Button', type: 'FRAME', layoutMode: 'HORIZONTAL', paddingLeft: 12, children: [{ id: '12:35', name: 'Label', type: 'TEXT', characters: 'Pay now' }] } } },
      components: { abc: { name: 'Button', description: 'Primary', key: 'abc', ignored: 'large' } },
    })
  })
  const output = await service.readDesign('https://www.figma.com/design/AbCdEf123/Checkout?node-id=12-34')
  assert.match(output, /"layoutMode":"HORIZONTAL"/)
  assert.match(output, /"characters":"Pay now"/)
  assert.doesNotMatch(output, /"ignored"/)
})

test('Figma variables report the Enterprise limitation instead of pretending data is absent', async () => {
  const store = new MemoryPluginSecretStore(); await store.set('figma', 'token')
  const service = new FigmaRestService(store, async () => json({ message: 'Limited by Figma plan' }, 403))
  const output = await service.variables('https://www.figma.com/design/AbCdEf123/Checkout')
  assert.match(output, /"available":false/)
  assert.match(output, /Enterprise/)
})
