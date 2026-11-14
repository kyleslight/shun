import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskPauseBarrier } from './task-pause.ts'

test('pause dispatches cancellation synchronously and blocks delayed delivery only for its task', () => {
  const barrier = new TaskPauseBarrier(), run = new AbortController(), compaction = new AbortController()
  barrier.pause('rss', () => { run.abort(); compaction.abort() }, 100)
  assert.equal(run.signal.aborted, true)
  assert.equal(compaction.signal.aborted, true)
  assert.equal(barrier.has('rss'), true)
  assert.equal(barrier.has('dimsum'), false)
  assert.throws(() => barrier.assertDelivery('rss', 99), /paused/)
  assert.throws(() => barrier.assertDelivery('rss', 100), /paused/)
  barrier.assertDelivery('dimsum', 0)
  barrier.assertDelivery('rss', 101)
  barrier.resume('rss')
  assert.equal(barrier.has('rss'), false)
})
