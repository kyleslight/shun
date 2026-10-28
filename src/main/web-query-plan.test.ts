import test from 'node:test'
import assert from 'node:assert/strict'
import { planWebQuery, queryPlanningRequest } from './web-query-plan.ts'

test('query-only reasoning configuration leaves the main request and other models unchanged', () => {
  const request: any = { settings: { model: 'selected', providerId: 'local', reasoningEffort: 'high',
    providers: [{ id: 'local', models: [{ id: 'selected', reasoning: true }, { id: 'other', reasoning: true }] }] } }
  const transformed = queryPlanningRequest(request)
  assert.equal(transformed.settings.providers[0].models?.[0].reasoning, false)
  assert.equal(transformed.settings.providers[0].models?.[1].reasoning, true)
  assert.equal(request.settings.providers[0].models[0].reasoning, true)
  assert.equal(transformed.settings.reasoningEffort, 'high')
})

test('query planning uses only submitted search inputs and does not extend a stalled completion', async () => {
  let received = '', cancelled = false
  const queries = ['Example model version 7', 'Example hardware throughput']
  assert.equal(await planWebQuery(queries, 'Concurrent requests', async input => { received = input; return 'Example model version 7 Example hardware concurrency benchmark' }), 'Example model version 7 Example hardware concurrency benchmark')
  assert.deepEqual(JSON.parse(received), { requested_outcome: 'Concurrent requests', queries })
  assert.equal(await planWebQuery(queries, 'Concurrent requests', async (_input, signal) => {
    signal.addEventListener('abort', () => { cancelled = true })
    return new Promise(() => {})
  }, undefined, 10), undefined)
  assert.equal(cancelled, true)
  assert.equal(await planWebQuery(queries, 'Concurrent requests', async () => 'Multiple\nqueries'), undefined)
  assert.equal(await planWebQuery(queries, 'Concurrent requests', async () => '"Example hardware" concurrency benchmark'), '"Example hardware" concurrency benchmark')
})

test('query rewriting retains literal release and version qualifiers', async () => {
  const result = await planWebQuery(['Example v2.4 release 1077', 'Example hardware performance'], 'Measured concurrency', async () => 'Example v2.4 hardware concurrency benchmark')
  assert.equal(result, 'Example v2.4 hardware concurrency benchmark 1077')
})
