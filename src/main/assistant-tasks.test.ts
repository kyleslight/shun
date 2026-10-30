import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureAssistant, queueAssistantResult, pendingAssistantResults, completeAssistantResult, assistantResultPrompt, mergeAssistantTasks } from './assistant-tasks.ts'
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
  assert.deepEqual(pendingAssistantResults(state, () => false), [])
  queueAssistantResult(state, child.id, 'First', 'a')
  queueAssistantResult(state, child.id, 'Second', 'b')
  assert.equal(child.assistantDeliveries?.length, 2)
  assert.deepEqual(pendingAssistantResults(state, id => id === child.id), [])
  assert.deepEqual(pendingAssistantResults(state, id => id === parent.id), [])
  const recovered = JSON.parse(JSON.stringify(state)) as SavedState
  assert.equal(pendingAssistantResults(recovered, () => false).length, 1)
  assert.equal(recovered.tasks[0].turns.length, 0)
  const first = pendingAssistantResults(recovered, () => false)[0]
  assert.equal(completeAssistantResult(recovered, first, 'A useful summary'), true)
  assert.equal(recovered.tasks[0].turns.length, 1)
  assert.equal(recovered.tasks[0].turns[0].content, 'A useful summary\n\n[View task](shun://task/check-1)')
  assert.equal(completeAssistantResult(recovered, first, 'Duplicate'), false)
  const second = pendingAssistantResults(recovered, () => false)[0]
  assert.equal(completeAssistantResult(recovered, second, 'Another update'), true)
  assert.deepEqual(pendingAssistantResults(recovered, () => false), [])
})
test('schedule deduplication survives a fresh execution session and restart', () => {
  const { state, parent, child } = fixture()
  queueAssistantResult(state, child.id, 'News', 'article-1')
  completeAssistantResult(state, pendingAssistantResults(state, () => false)[0], 'Summary')
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
  completeAssistantResult(state, pendingAssistantResults(state, () => false)[0], 'Summary')
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

 test('stale window saves cannot discard or resurrect pending task follow-ups', () => {
  const held: Task = { id: 'child', parentTaskId: 'assistant', title: 'Task', workspace: '', turns: [], createdAt: 1, updatedAt: 2, assistantFollowUps: [{ id: 'message', text: 'Keep going' }] }
  const stale = { ...held, assistantFollowUps: undefined }
  assert.deepEqual(mergeAssistantTasks([held], [stale])[0].assistantFollowUps, held.assistantFollowUps)
  assert.deepEqual(mergeAssistantTasks([{ ...held, assistantFollowUps: [] }], [held])[0].assistantFollowUps, [])
})

test('empty or failed handoffs retain durable evidence and respect retry backoff', () => {
  const { state, parent, child } = fixture()
  queueAssistantResult(state, child.id, 'Detailed worker report', 'result')
  const item = pendingAssistantResults(state, () => false)[0]
  assert.equal(completeAssistantResult(state, item, '  '), false)
  assert.equal(completeAssistantResult(state, { ...item, parentId: 'other' }, 'Summary'), false)
  assert.equal(parent.turns.length, 0)
  child.assistantDeliveries![0].retryAt = 500
  assert.equal(pendingAssistantResults(state, () => false, 499).length, 0)
  const recovered = JSON.parse(JSON.stringify(state)) as SavedState
  assert.equal(pendingAssistantResults(recovered, () => false, 500).length, 1)
  const prompt = assistantResultPrompt(item, '/project with spaces')
  assert.ok(prompt.includes('absolute Markdown file links'))
  assert.ok(prompt.includes('important caveats'))
  assert.ok(prompt.includes('/project with spaces'))
  assert.ok(prompt.includes('Detailed worker report'))
})
