import assert from 'node:assert/strict'
import test from 'node:test'
import { testModelDeployment } from './provider-connection.ts'

test('deployment connectivity sends a minimal completion to the selected model', async () => {
  let requestUrl = '', requestInit: RequestInit | undefined
  const result = await testModelDeployment('https://provider.example/v1/', 'secret', 'model-a', async (input, init) => {
    requestUrl = String(input)
    requestInit = init
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 })
  })

  assert.equal(result.ok, true)
  assert.equal(requestUrl, 'https://provider.example/v1/chat/completions')
  assert.equal((requestInit?.headers as Record<string, string>).authorization, 'Bearer secret')
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    model: 'model-a', messages: [{ role: 'user', content: 'Reply with OK.' }], temperature: 0, max_tokens: 1, stream: false,
  })
})

test('deployment connectivity returns bounded redacted provider errors', async () => {
  const secret = 'never-show-this-key'
  const result = await testModelDeployment('https://provider.example/v1', secret, 'missing', async () =>
    new Response(JSON.stringify({ error: { message: `bad credential ${secret} ${'x'.repeat(300)}` } }), { status: 401 }),
  )

  assert.equal(result.ok, false)
  assert.match(result.message, /^401 bad credential \[redacted\]/)
  assert.doesNotMatch(result.message, new RegExp(secret))
  assert.ok(result.message.length <= 184)
})

test('deployment connectivity rejects non-http provider URLs before requesting', async () => {
  let called = false
  const result = await testModelDeployment('file:///tmp/provider', '', 'model-a', async () => {
    called = true
    return new Response('{}')
  })

  assert.equal(called, false)
  assert.equal(result.ok, false)
  assert.match(result.message, /HTTP or HTTPS/)
})

test('deployment connectivity has a hard deadline even when the request ignores abort signals', async () => {
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((callback: (...args: any[]) => void, _delay?: number, ...args: any[]) =>
    originalSetTimeout(callback, 1, ...args)) as typeof setTimeout
  try {
    const result = await testModelDeployment('https://provider.example/v1', '', 'model-a', () => new Promise<Response>(() => {}))
    assert.equal(result.ok, false)
    assert.match(result.message, /timed out after 15 seconds/)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})
