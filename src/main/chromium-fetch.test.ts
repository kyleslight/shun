import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import type { ClientRequest } from 'electron'
import { createChromiumFetch } from './chromium-fetch.ts'

function fixture(status: number, statusText = 'OK') {
  const request = new PassThrough() as PassThrough & { abort(): void; setHeader(): void }
  let aborted = false
  request.abort = () => { aborted = true }
  request.setHeader = () => {}
  const response = Object.assign(new PassThrough(), { statusCode: status, statusMessage: statusText, headers: { 'content-type': 'text/plain' } })
  const fetch = createChromiumFetch(() => request as unknown as ClientRequest)
  return { request, response, fetch, aborted: () => aborted }
}
for (const status of [0, 101, 199, 600, NaN]) test(`invalid status ${status} rejects without escaping the native callback`, async () => {
  const f = fixture(status)
  const pending = f.fetch('https://example.com/test')
  const rejection = assert.rejects(pending, /invalid status/)
  assert.doesNotThrow(() => f.request.emit('response', f.response))
  await rejection
  assert.equal(f.aborted(), true)
})
test('malformed response metadata rejects instead of throwing from the callback', async () => {
  const f = fixture(200, 'invalid\nreason')
  const pending = f.fetch('https://example.com/test')
  const rejection = assert.rejects(pending)
  assert.doesNotThrow(() => f.request.emit('response', f.response))
  await rejection
})
test('abort after headers rejects body readers and releases request', async () => {
  const f = fixture(200), controller = new AbortController()
  const pending = f.fetch('https://example.com/test', { signal: controller.signal })
  f.request.emit('response', f.response)
  const response = await pending
  const body = response.text()
  controller.abort(Error('cancelled'))
  await assert.rejects(body, /cancelled/)
  assert.equal(f.aborted(), true)
})
test('successful response streams and preserves final URL', async () => {
  const f = fixture(200)
  const pending = f.fetch('https://example.com/test')
  f.request.emit('redirect', 302, 'GET', 'https://example.com/final')
  f.request.emit('response', f.response)
  f.response.end('complete')
  const response = await pending
  assert.equal(await response.text(), 'complete')
  assert.equal(response.url, 'https://example.com/final')
  assert.equal(response.redirected, true)
})
