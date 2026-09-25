import assert from 'node:assert/strict'
import test from 'node:test'
import { browserQuietMs, createBrowserSettle } from './browser-settle.ts'

function harness(quietMs = 1_000) {
  const released: string[] = []
  const errors: unknown[] = []
  const settle = createBrowserSettle({
    quietMs,
    release: async taskId => { released.push(taskId) },
    onError: error => errors.push(error),
  })
  return { released, errors, settle }
}

test('a task that goes quiet releases its tab after the quiet window', async () => {
  const { released, settle } = harness(20)
  settle.schedule('task-a')
  assert.deepEqual(settle.pending(), ['task-a'])
  assert.deepEqual(released, [], 'nothing is released while the task may still be between steps')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(released, ['task-a'])
  assert.deepEqual(settle.pending(), [])
})

test('a step that follows keeps the tab, because the task is not finished', async () => {
  const { released, settle } = harness(30)
  settle.schedule('task-a')
  settle.cancel('task-a')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(released, [], 'work resumed, so the pending release was not due')
  assert.deepEqual(settle.pending(), [])
})

test('the quiet window is the one the product chose', () => {
  assert.equal(browserQuietMs, 30 * 1000)
})

test('a release that fails is reported rather than becoming an unhandled rejection', async () => {
  const errors: unknown[] = []
  const settle = createBrowserSettle({ quietMs: 10, release: async () => { throw new Error('Chrome is gone') }, onError: error => errors.push(error) })
  settle.schedule('task-a')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(errors.length, 1)
  assert.match(String((errors[0] as Error).message), /Chrome is gone/)
})

test('stopping clears pending releases', () => {
  const { released, settle } = harness(20)
  settle.schedule('task-a')
  settle.stop()
  assert.deepEqual(settle.pending(), [])
  assert.deepEqual(released, [])
})
