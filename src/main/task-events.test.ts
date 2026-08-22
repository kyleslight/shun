import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TaskEventStore } from './task-events.ts'

test('task event sequences are durable and isolated per task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-task-events-'))
  const store = new TaskEventStore(root)
  const [first, second] = await Promise.all([
    store.append('task-a', { type: 'request', runId: 'run-a', text: 'one' }),
    store.append('task-a', { type: 'agent', runId: 'run-a', event: { id: 'run-a', type: 'done' } }),
  ])
  await store.append('task-b', { type: 'request', runId: 'run-b', text: 'other' })
  assert.deepEqual([first.seq, second.seq], [1, 2])
  assert.deepEqual((await store.read('task-a', 1)).map(event => event.seq), [2])
  assert.deepEqual((await store.read('task-b')).map(event => event.seq), [1])

  const restored = new TaskEventStore(root)
  assert.equal((await restored.append('task-a', { type: 'agent', runId: 'run-a2', event: { id: 'run-a2', type: 'done' } })).seq, 3)
})

test('task event subscribers observe events after they are durable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-task-events-listener-'))
  const store = new TaskEventStore(root), seen: number[] = []
  const unsubscribe = store.subscribe(event => seen.push(event.seq))
  await store.append('task-a', { type: 'request', runId: 'run-a', text: 'hello' })
  unsubscribe()
  await store.append('task-a', { type: 'agent', runId: 'run-a', event: { id: 'run-a', type: 'done' } })
  assert.deepEqual(seen, [1])
})

test('task event store rejects path-like task identifiers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-task-events-invalid-'))
  const store = new TaskEventStore(root)
  assert.throws(() => store.append('../escape', { type: 'request', runId: 'run-a', text: '' }), /Invalid task ID/)
})
