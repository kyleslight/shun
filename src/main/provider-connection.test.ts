import assert from 'node:assert/strict'
import test from 'node:test'
import { formatProviderFailure, listProviderModels, testModelDeployment } from './provider-connection.ts'

test('provider failures turn empty JSON errors into concise diagnostics', () => {
  assert.equal(
    formatProviderFailure('Error: {"error":{"message":"","code":404,"status":"Not Found"}}', 'zh-CN'),
    '404 Not Found：Provider 请求路径、API 格式或模型 ID 不匹配。',
  )
  assert.equal(formatProviderFailure('{"error":{"message":"insufficient balance","code":429}}', 'en'), '429 insufficient balance')
  assert.doesNotMatch(formatProviderFailure('bad key secret-key', 'en', 'secret-key'), /secret-key/)
})

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

test('deployment connectivity uses Anthropic messages authentication and payloads', async () => {
  let requestUrl = '', requestInit: RequestInit | undefined
  const result = await testModelDeployment('https://api.anthropic.com', 'secret', 'claude-test', async (input, init) => {
    requestUrl = String(input)
    requestInit = init
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }), { status: 200 })
  }, 'anthropic-messages')
  const headers = requestInit?.headers as Record<string, string>
  assert.equal(result.ok, true)
  assert.equal(requestUrl, 'https://api.anthropic.com/v1/messages')
  assert.equal(headers['x-api-key'], 'secret')
  assert.equal(headers.authorization, undefined)
  assert.equal(JSON.parse(String(requestInit?.body)).model, 'claude-test')
})

test('deployment connectivity uses the native Gemini generateContent route', async () => {
  let requestUrl = '', requestHeaders: Record<string, string> = {}
  const result = await testModelDeployment('https://generativelanguage.googleapis.com', 'google-key', 'gemini-test', async (input, init) => {
    requestUrl = String(input)
    requestHeaders = init?.headers as Record<string, string>
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }), { status: 200 })
  }, 'google-generative-ai')
  assert.equal(result.ok, true)
  assert.equal(requestUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent')
  assert.equal(requestHeaders['x-goog-api-key'], 'google-key')
})

test('deployment connectivity supports custom Responses API endpoints', async () => {
  let requestUrl = '', requestBody: any
  const result = await testModelDeployment('https://provider.example/v1', 'secret', 'response-model', async (input, init) => {
    requestUrl = String(input)
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ output: [{ type: 'message' }] }), { status: 200 })
  }, 'openai-responses')
  assert.equal(result.ok, true)
  assert.equal(requestUrl, 'https://provider.example/v1/responses')
  assert.deepEqual(requestBody, { model: 'response-model', input: 'Reply with OK.', max_output_tokens: 16 })
})

test('deployment connectivity normalizes Azure resource URLs to the v1 Responses API', async () => {
  let requestUrl = '', requestHeaders: Record<string, string> = {}
  const result = await testModelDeployment('https://example.openai.azure.com/openai', 'azure-key', 'deployment-a', async (input, init) => {
    requestUrl = String(input)
    requestHeaders = init?.headers as Record<string, string>
    return new Response(JSON.stringify({ output: [{ type: 'message' }] }), { status: 200 })
  }, 'azure-openai-responses')
  assert.equal(result.ok, true)
  assert.equal(requestUrl, 'https://example.openai.azure.com/openai/v1/responses')
  assert.equal(requestHeaders['api-key'], 'azure-key')
})

test('deployment connectivity uses the Bedrock Converse route and bearer token', async () => {
  let requestUrl = '', requestHeaders: Record<string, string> = {}, requestBody: any
  const result = await testModelDeployment('https://bedrock-runtime.us-east-1.amazonaws.com', 'bedrock-key', 'us.anthropic.claude-test', async (input, init) => {
    requestUrl = String(input)
    requestHeaders = init?.headers as Record<string, string>
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ output: { message: { content: [{ text: 'OK' }] } } }), { status: 200 })
  }, 'bedrock-converse-stream')
  assert.equal(result.ok, true)
  assert.equal(requestUrl, 'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-test/converse')
  assert.equal(requestHeaders.authorization, 'Bearer bedrock-key')
  assert.deepEqual(requestBody.inferenceConfig, { maxTokens: 1 })
})

test('model discovery uses Gemini models with native paths, auth, and generation filtering', async () => {
  let requestUrl = '', requestHeaders: Record<string, string> = {}
  const models = await listProviderModels('https://generativelanguage.googleapis.com', 'google-key', 'google-generative-ai', async (input, init) => {
    requestUrl = String(input)
    requestHeaders = init?.headers as Record<string, string>
    return new Response(JSON.stringify({ models: [
      { name: 'models/gemini-3.7-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ] }), { status: 200 })
  })
  assert.equal(requestUrl, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000')
  assert.equal(requestHeaders['x-goog-api-key'], 'google-key')
  assert.deepEqual(models, ['gemini-3.7-flash'])
})

test('model discovery uses Anthropic native model paths and headers', async () => {
  let requestUrl = '', requestHeaders: Record<string, string> = {}
  const models = await listProviderModels('https://api.anthropic.com', 'anthropic-key', 'anthropic-messages', async (input, init) => {
    requestUrl = String(input)
    requestHeaders = init?.headers as Record<string, string>
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-test' }] }), { status: 200 })
  })
  assert.equal(requestUrl, 'https://api.anthropic.com/v1/models')
  assert.equal(requestHeaders['x-api-key'], 'anthropic-key')
  assert.equal(requestHeaders['anthropic-version'], '2023-06-01')
  assert.deepEqual(models, ['claude-sonnet-test'])
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
