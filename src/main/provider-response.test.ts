import assert from 'node:assert/strict'
import test from 'node:test'
import { completeProviderResponse } from './provider-response.ts'

const encoder = new TextEncoder()
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
