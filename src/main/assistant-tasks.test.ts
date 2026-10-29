import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureAssistant, queueAssistantResult, deliverAssistantResults, mergeAssistantTasks } from './assistant-tasks.ts'
import type { SavedState, Task } from '../shared.ts'
const fixture = () => {
  const state = { tasks: [], settings: {}, currentId: 'visible' } as unknown as SavedState
  const parent = ensureAssistant(state)
  const child: Task = { id: 'check-1', parentTaskId: parent.id, purpose: 'background', scheduleId: 'hourly', title: 'Check', workspace: '', turns: [], createdAt: 1, updatedAt: 1 }
  state.tasks.push(child)
  return { state, parent, child }
}
test('assistant identity is stable without changing selected task', () => {
  const { state, parent } = fixture()
  assert.equal(ensureAssistant(state), parent)
  assert.equal(state.tasks.length, 2)
  assert.equal(state.currentId, 'visible')
})
test('quiet checks add no message; multiple findings persist and wait for both tasks to settle', () => {
  const { state, parent, child } = fixture()
  assert.deepEqual(deliverAssistantResults(state, () => false), [])
  queueAssistantResult(state, child.id, 'First', 'a')
  queueAssistantResult(state, child.id, 'Second', 'b')
  assert.equal(child.assistantDeliveries?.length, 2)
  assert.deepEqual(deliverAssistantResults(state, id => id === child.id), [])
  assert.deepEqual(deliverAssistantResults(state, id => id === parent.id), [])
  const recovered = JSON.parse(JSON.stringify(state)) as SavedState
  assert.equal(deliverAssistantResults(recovered, () => false).length, 2)
  assert.equal(recovered.tasks[0].turns.length, 2)
  assert.deepEqual(deliverAssistantResults(recovered, () => false), [])
})
test('schedule deduplication survives a fresh execution session and restart', () => {
  const { state, parent, child } = fixture()
  queueAssistantResult(state, child.id, 'News', 'article-1')
  deliverAssistantResults(state, () => false)
  state.tasks.push({ ...child, id: 'check-2', assistantDeliveries: [] })
  assert.deepEqual(queueAssistantResult(state, 'check-2', 'News again', 'article-1'), { queued: false, duplicate: true })
  assert.equal(parent.turns.length, 1)
})
test('stale window saves retain service tasks, queued results and delivered messages while preserving drafts', () => {
  const { state, parent, child } = fixture()
  const stale = JSON.parse(JSON.stringify(parent)) as Task
  stale.draft = 'still typing'
  queueAssistantResult(state, child.id, 'News', 'a')
  assert.equal(mergeAssistantTasks(state.tasks, [stale]).find(task => task.id === child.id)?.assistantDeliveries?.length, 1)
  deliverAssistantResults(state, () => false)
  const merged = mergeAssistantTasks(state.tasks, [stale])
  assert.equal(merged[0].draft, 'still typing')
  assert.equal(merged[0].turns.length, 1)
  assert.equal(merged.length, 2)
})
test('unowned task cannot publish into another conversation', () => {
  const { state, child } = fixture()
  delete child.parentTaskId
  assert.throws(() => queueAssistantResult(state, child.id, 'News', 'a'), /not attached/)
})
