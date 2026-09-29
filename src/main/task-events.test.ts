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

test('live task event subscribers are not blocked by durable writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-task-events-live-'))
  const store = new TaskEventStore(root)
  let appendSettled = false
  let releaseLive!: () => void
  const live = new Promise<void>(resolve => { releaseLive = resolve })
  store.subscribeLive(() => releaseLive())

  const append = store.append('task-a', { type: 'request', runId: 'run-a', text: 'hello' }).then(event => {
    appendSettled = true
    return event
  })
  await live
  assert.equal(appendSettled, false)
  assert.equal((await append).seq, 1)
})

test('task event store rejects path-like task identifiers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-task-events-invalid-'))
  const store = new TaskEventStore(root)
  assert.throws(() => store.append('../escape', { type: 'request', runId: 'run-a', text: '' }), /Invalid task ID/)
})

/**
 * The newest sequence is not the last row of a bounded read.
 *
 * A reader that opens on a task takes this number as the point its snapshot is
 * current to. `read` answers from the *oldest* events it holds, so a long task
 * used to report a sequence hundreds of events behind its live one — and every
 * event after it looked like something the reader had missed, which is what it
 * then replayed as if it were news.
 */
test('the newest sequence is read from the end of a log that is longer than one page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-task-events-latest-'))
  const store = new TaskEventStore(root)
  for (let index = 0; index < 640; index += 1) {
    await store.append('task-a', { type: 'agent', runId: 'run-a', event: { id: 'run-a', type: 'delta', text: `chunk ${index}` } })
  }
  const page = await store.read('task-a')
  assert.equal(page.length, 500)
  assert.equal(page.at(-1)?.seq, 500)
  assert.equal(await store.lastSequence('task-a'), 640)

  // A store that has written nothing yet, and one that has just come back to a
  // file on disk, both answer the same way.
  assert.equal(await store.lastSequence('task-b'), 0)
  assert.equal(await new TaskEventStore(root).lastSequence('task-a'), 640)
})
