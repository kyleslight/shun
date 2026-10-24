import assert from 'node:assert/strict'
import test from 'node:test'
import { completeProviderResponse, providerRequestInit } from './provider-response.ts'

const encoder = new TextEncoder()
test('provider transport closes proxy connections without losing headers, payloads, or cancellation', () => {
  const controller = new AbortController()
  const input = new Request('https://example.com', { headers: { Authorization: 'Bearer test' }, signal: controller.signal })
  const inherited = providerRequestInit(input)
  assert.equal(new Headers(inherited.headers).get('authorization'), 'Bearer test')
  assert.equal(new Headers(inherited.headers).get('connection'), 'close')
  assert.equal(inherited.signal, input.signal)
  assert.equal(input.headers.get('connection'), null)
  const options = { method: 'POST', body: 'payload', headers: { 'X-Test': 'yes' }, signal: controller.signal }
  const explicit = providerRequestInit(input, options)
  assert.equal(explicit.body, options.body)
  assert.equal(explicit.signal, controller.signal)
  assert.equal(new Headers(explicit.headers).get('x-test'), 'yes')
  assert.equal(new Headers(explicit.headers).get('authorization'), null)
})
function streamResponse(chunks: string[], cancel: () => void | Promise<void> = () => {}) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)) },
    cancel,
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-request-id': 'test' } })
}
async function boundedText(response: Response) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      response.text(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Response did not complete')), 500) }),
    ])
  } finally { clearTimeout(timer) }
}

test('a terminal event completes a native stream even when EOF and cancellation never resolve', async () => {
  let cancelled = false
  const text = 'data: {"choices":[{"delta":{"content":"收到"}}]}\n\ndata: {"usage":{"total_tokens":42}}\n\ndata: [DONE]\n\n'
  const native = streamResponse([text], () => { cancelled = true; return new Promise<void>(() => {}) })
  const response = completeProviderResponse(native)
  assert.equal(await boundedText(response), text)
  assert.equal(cancelled, true)
  assert.equal(response.headers.get('x-request-id'), 'test')
})

test('split CRLF framing and a DONE string inside JSON preserve all output through the actual terminator', async () => {
  const text = 'data: {"content":"[DONE]"}\r\n\ndata: {"content":"continue"}\r\n\r\ndata: [DONE]\r\n\r\n'
  const bytes = encoder.encode(text)
  const native = new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)) },
  }), { headers: { 'content-type': 'text/event-stream' } })
  assert.equal((await boundedText(completeProviderResponse(native))).replace(/\r?\n/g, '\n').trim(), text.replace(/\r?\n/g, '\n').trim())
})

test('ordinary EOF, transport errors, and non-streaming responses retain their meaning', async () => {
  const plain = new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
  assert.equal(completeProviderResponse(plain), plain)
  const eof = new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode('data: hello\n\n')); c.close() } }), { headers: { 'content-type': 'text/event-stream' } })
  assert.equal(await boundedText(completeProviderResponse(eof)), 'data: hello\n\n')
  const failed = new Response(new ReadableStream({ start(c) { c.error(Error('connection interrupted')) } }), { headers: { 'content-type': 'text/event-stream' } })
  await assert.rejects(boundedText(completeProviderResponse(failed)), /connection interrupted/)
})

test('cancelling a consumer propagates to the native reader without hanging on native cancellation', async () => {
  let cancelled = false
  const response = completeProviderResponse(streamResponse([], () => { cancelled = true; return new Promise<void>(() => {}) }))
  await response.body!.cancel('user stopped')
  assert.equal(cancelled, true)
})

test('terminal completion releases transport slots even when native reader cancellation never settles', async () => {
  let active = 0, released = 0
  for (let request = 0; request < 24; request++) {
    assert.ok(active < 6, 'the next request must not be starved by completed responses')
    active++
    const native = streamResponse(['data: {"content":"OK"}\n\ndata: [DONE]\n\n'], () => new Promise<void>(() => {}))
    const response = completeProviderResponse(native, () => { active--; released++ })
    assert.match(await boundedText(response), /OK/)
    assert.equal(active, 0)
  }
  assert.equal(released, 24)
})

test('consumer cancellation aborts its own transport without waiting for a terminal event', async () => {
  const transport = new AbortController()
  const response = completeProviderResponse(streamResponse([], () => new Promise<void>(() => {})), reason => transport.abort(reason))
  await response.body!.cancel('user stopped')
  assert.equal(transport.signal.aborted, true)
  assert.equal(transport.signal.reason, 'user stopped')
})
