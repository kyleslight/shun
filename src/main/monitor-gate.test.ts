import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MonitorGate, probeHttp, type MonitorConfig } from './monitor-gate.ts'
const config: MonitorConfig = { source: { kind: 'gmail' }, delivery: 'evaluate' }
async function path() { return join(await mkdtemp(join(tmpdir(), 'monitor-')), 'state.json') }

test('quiet baseline and unchanged checks do not produce work; persisted pending survives restart', async () => {
  const file = await path()
  let revision = '1', calls = 0
  const probe = async (_: unknown, cursor?: string) => { calls++; return { cursor: revision, events: cursor !== revision ? ['mail'] : [] } }
  let gate = new MonitorGate(file, probe); await gate.init()
  assert.equal(await gate.check('watch', config), undefined)
  assert.equal(await gate.check('watch', config), undefined)
  revision = '2'
  const pending = await gate.check('watch', config)
  assert.ok(pending)
  gate = new MonitorGate(file, probe); await gate.init()
  assert.deepEqual(await gate.check('watch', config), pending)
  assert.equal(calls, 3)
  await gate.complete('watch', 'wrong-id')
  assert.deepEqual(await gate.check('watch', config), pending)
  await gate.complete('watch', pending.id)
  assert.equal(await gate.check('watch', config), undefined)
})

test('failures preserve the cursor and concurrent checks coalesce', async () => {
  let fail = false, calls = 0
  const cursors: Array<string | undefined> = []
  const gate = new MonitorGate(await path(), async (_, cursor) => {
    calls++; cursors.push(cursor)
    await new Promise(resolve => setTimeout(resolve, 5))
    if (fail) throw Error('offline')
    return { cursor: '1', events: [] }
  }); await gate.init()
  await Promise.all(Array.from({ length: 20 }, () => gate.check('watch', config)))
  assert.equal(calls, 1)
  fail = true; await assert.rejects(gate.check('watch', config), /offline/)
  fail = false; await assert.rejects(gate.check('watch', config), /waiting to retry/)
  assert.deepEqual(cursors, [undefined, '1'])
  assert.ok(gate.health('watch').retryAt)
})

test('large bursts drain durable bounded batches before advancing source checkpoint', async () => {
  let calls = 0
  const file = await path(), probe = async () => ({ cursor: String(++calls), events: Array(10).fill('x'.repeat(5000)) })
  let gate = new MonitorGate(file, probe); await gate.init(); await gate.check('w', config)
  let delivered = 0
  for (let i = 0; i < 5; i++) {
    const pending = await gate.check('w', config); assert.ok(pending)
    assert.equal(pending.events.length, 2); delivered += pending.events.length
    await gate.complete('w', pending.id)
    gate = new MonitorGate(file, probe); await gate.init()
  }
  assert.equal(delivered, 10); assert.equal(calls, 2)
})

test('corrupt checkpoints are reported rather than silently rebased', async () => {
  const file = await path(); await writeFile(file, 'broken')
  await assert.rejects(new MonitorGate(file, async () => ({ cursor: '1', events: [] })).init())
})

test('HTTP conditional requests, unchanged body and failure handling', async () => {
  const first = await probeHttp('https://example.com/feed', undefined, async () => new Response('a', { headers: { etag: 'v1' } }))
  assert.equal(first.events.length, 0)
  const same = await probeHttp('https://example.com/feed', first.cursor, async (_, init) => {
    assert.equal(new Headers(init?.headers).get('if-none-match'), 'v1')
    return new Response(null, { status: 304 })
  })
  assert.deepEqual(same, first)
  assert.equal((await probeHttp('https://example.com/feed', first.cursor, async () => new Response('b'))).events.length, 1)
  await assert.rejects(probeHttp('https://example.com/feed', first.cursor, async () => new Response('', { status: 429 })), /429/)
})

test('third-day outage backs off across restart and resumes from last committed cursor', async () => {
  const file = await path(); let now = 0, offline = false, version = '1', calls = 0
  const probe = async (_: unknown, cursor?: string) => {
    calls++
    if (offline) throw Error('offline')
    return { cursor: version, events: cursor === version ? [] : ['new event'] }
  }
  let gate = new MonitorGate(file, probe, () => now); await gate.init()
  for (let i = 0; i < 3 * 24 * 60; i++) {
    assert.equal(await gate.check('mail', config), undefined)
    now += 60000
  }
  offline = true
  await assert.rejects(gate.check('mail', config), /offline/)
  const count = calls, errorId = gate.health('mail').errorId
  gate = new MonitorGate(file, probe, () => now); await gate.init()
  await assert.rejects(gate.check('mail', config), /waiting to retry/)
  assert.equal(calls, count); assert.equal(gate.health('mail').errorId, errorId)
  now += 60000; offline = false; version = '2'
  const event = await gate.check('mail', config); assert.ok(event)
  assert.equal(gate.health('mail').errorId, undefined)
  await gate.complete('mail', event.id)
  assert.equal(await gate.check('mail', config), undefined)
})

test('failed evaluation backs off without dropping the durable event', async () => {
  let now = 0, version = '1'
  const gate = new MonitorGate(await path(), async () => ({ cursor: version, events: ['arrival'] }), () => now)
  await gate.init(); await gate.check('mail', config); version = '2'
  const event = await gate.check('mail', config); assert.ok(event)
  await gate.fail('mail', event.id)
  await assert.rejects(gate.check('mail', config), /waiting to retry/)
  now = 60000
  assert.deepEqual(await gate.check('mail', config), event)
  await gate.complete('mail', event.id)
  assert.equal(gate.health('mail').errorId, undefined)
})
