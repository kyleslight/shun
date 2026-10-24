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

test('live progress exposes overlapping queries and completes each line with real timings', async () => {
  const snapshots: import('../shared').FanoutProgress[] = []
  const releases: Array<() => void> = []
  const pending = retrievalBatch('search', ['original subject', 'independent variant'], async () => {
    await new Promise<void>(resolve => releases.push(resolve))
    return JSON.stringify({ results: [] })
  }, progress => snapshots.push(progress))
  assert.equal(snapshots[0].unit, 'queries')
  assert.deepEqual(snapshots[0].lines.map(line => line.state), ['running', 'running'])
  releases[0]()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(snapshots.at(-1)!.lines.map(line => line.state), ['done', 'running'])
  releases[1]()
  const output = JSON.parse(await pending)
  assert.equal(snapshots.at(-1)!.running, false)
  assert.equal(snapshots.at(-1)!.done, 2)
  assert.ok(output.responses[1].started_at <= output.responses[0].finished_at)
  assert.ok(output.responses.every((row: { started_at: number; finished_at: number }) => row.finished_at >= row.started_at))
})
