import assert from 'node:assert/strict'
import test from 'node:test'
import { applyRequestedTaskTurn } from '../renderer/src/task-runtime.ts'
import type { Task, TaskEventEnvelope } from '../shared.ts'

const task = (id: string): Task => ({ id, title: id, workspace: '/work', turns: [], draft: `draft-${id}`, createdAt: 1, updatedAt: 1 })
const request = (taskId: string, source?: 'scheduled'): TaskEventEnvelope => ({ taskId, seq: 1, at: 10, payload: { type: 'request', runId: `run-${taskId}`, messageId: `user-${taskId}`, text: 'Complete the requested work', source } })

test('an API-started run is visible in its existing task while other tasks and drafts are preserved', () => {
  const tasks = [task('visible'), task('background')]
  const next = applyRequestedTaskTurn(tasks, request('background'))
  assert.equal(next[0], tasks[0])
  assert.equal(next[1].draft, 'draft-background')
  assert.deepEqual(next[1].turns.map(t => [t.id, t.role]), [['user-background', 'user'], ['run-background', 'assistant']])
  assert.deepEqual(tasks[1].turns, [])
  const again = applyRequestedTaskTurn(next, request('background'))
  assert.equal(again[1], next[1])
})

test('optimistic and scheduled requests reconcile without duplicate user or assistant turns', () => {
  const tasks = [task('one')]
  const once = applyRequestedTaskTurn(tasks, request('one', 'scheduled'))
  assert.equal(applyRequestedTaskTurn(once, request('one'))[0], once[0])
  const userOnly = { ...tasks[0], turns: [once[0].turns[0]] }
  assert.equal(applyRequestedTaskTurn([userOnly], request('one'))[0].turns.length, 2)
  assert.equal(applyRequestedTaskTurn(tasks, request('unknown'))[0], tasks[0])
})
