import assert from 'node:assert/strict'
import test from 'node:test'
import { retrievalBatch } from './web-retrieval-batch.ts'

test('independent retrievals all start before any must finish and preserve partial source failures', async () => {
  const started: string[] = [], release: Array<() => void> = []
  const result = retrievalBatch('search', ['alpha', 'beta', 'alpha'], async target => {
    started.push(target)
    await new Promise<void>(resolve => release.push(resolve))
    if (target === 'beta') throw Error('source timed out')
    return JSON.stringify({ results: [{ url: 'https://example.com' }], pages: [{ ok: true, content: 'source passage' }] })
  })
  assert.deepEqual(started, ['alpha', 'beta'])
  release.forEach(resolve => resolve())
  const output = JSON.parse(await result)
  assert.equal(output.parallel, true)
  assert.equal(output.pages[0].content, 'source passage')
  assert.equal(output.responses[1].ok, false)
  assert.equal(output.responses[1].error, 'source timed out')
})

test('batch reading retains each URL and passage, while a single target retains its original receipt', async () => {
  const run = async (url: string) => JSON.stringify({ ok: true, requested_url: url, final_url: url, content: url, has_more: false })
  const batch = JSON.parse(await retrievalBatch('read', ['https://a.test', 'https://b.test'], run))
  assert.deepEqual(batch.pages.map((page: { requested_url: string }) => page.requested_url), ['https://a.test', 'https://b.test'])
  assert.equal(await retrievalBatch('read', ['https://a.test'], run), await run('https://a.test'))
})
