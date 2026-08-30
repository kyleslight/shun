import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskRunRegistry } from './task-runs.ts'

test('different tasks can own runs concurrently while one task cannot', () => {
  const runs = new TaskRunRegistry()
  assert.equal(runs.claim('task-a', 'run-a'), undefined)
  assert.equal(runs.claim('task-b', 'run-b'), undefined)
  assert.equal(runs.get('task-a'), 'run-a')
  assert.equal(runs.get('task-b'), 'run-b')
  assert.deepEqual(runs.snapshot(), { 'task-a': 'run-a', 'task-b': 'run-b' })
  assert.equal(runs.claim('task-a', 'run-a2'), 'run-a')
})

test('only the owning run can release a task slot', () => {
  const runs = new TaskRunRegistry()
  runs.claim('task-a', 'run-a')
  runs.release('task-a', 'stale-run')
  assert.equal(runs.get('task-a'), 'run-a')
  runs.release('task-a', 'run-a')
  assert.equal(runs.get('task-a'), undefined)
  assert.equal(runs.claim('task-a', 'run-a2'), undefined)
})
