import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureAssistant, queueAssistantResult, completeAssistantResult, deliverAssistantResults, mergeAssistantTasks } from './assistant-tasks.ts'
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
test('quiet checks add no message and completed reports survive restart', () => {
  const { state, child } = fixture()
  assert.deepEqual(deliverAssistantResults(state), [])
  queueAssistantResult(state, child.id, 'First', 'a')
  queueAssistantResult(state, child.id, 'Second', 'b')
  const recovered = JSON.parse(JSON.stringify(state)) as SavedState
  assert.equal(deliverAssistantResults(recovered).length, 2)
  assert.equal(recovered.tasks[0].turns.length, 2)
  assert.match(recovered.tasks[0].turns[0].content, /First/)
  assert.match(recovered.tasks[0].turns[1].content, /Second/)
  assert.deepEqual(deliverAssistantResults(recovered), [])
})
test('schedule deduplication survives a fresh execution session and restart', () => {
  const { state, parent, child } = fixture()
  queueAssistantResult(state, child.id, 'News', 'article-1')
  deliverAssistantResults(state)
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
  deliverAssistantResults(state)
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

test('an unowned or empty report cannot be delivered into a conversation', () => {
  const { state, parent, child } = fixture()
  queueAssistantResult(state, child.id, 'Detailed worker report', 'result')
  const item = { parentId: parent.id, sourceId: child.id, id: child.assistantDeliveries![0].id, title: child.title, text: 'Report' }
  assert.equal(completeAssistantResult(state, item, '  '), false)
  assert.equal(completeAssistantResult(state, { ...item, parentId: 'other' }, 'Summary'), false)
  assert.equal(parent.turns.length, 0)
})

test('completed results are delivered exactly once without waiting for another model run', () => {
  const { state, parent, child } = fixture()
  queueAssistantResult(state, child.id, 'First completed report', 'a')
  queueAssistantResult(state, child.id, 'Second completed report', 'b')
  child.assistantDeliveries![0].retryAt = Date.now() + 60000
  parent.turns.push({ id: 'active-parent', role: 'assistant', content: '', startedAt: 1 })
  child.turns.push({ id: 'new-child-run', role: 'assistant', content: '', startedAt: 2 })
  const draft = 'Unsent user question'
  parent.draft = draft
  const delivered = deliverAssistantResults(state)
  assert.equal(delivered.length, 2)
  assert.equal(parent.turns[0].completedAt, undefined)
  assert.equal(child.turns[0].completedAt, undefined)
  assert.equal(parent.draft, draft)
  assert.equal(state.currentId, 'visible')
  assert.match(parent.turns[1].content, /Task result · Check/)
  assert.match(parent.turns[1].content, /First completed report/)
  assert.match(parent.turns[2].content, /Second completed report/)
  assert.deepEqual(child.assistantDeliveries, [])
  assert.deepEqual(deliverAssistantResults(JSON.parse(JSON.stringify(state))), [])
})

test('background schedule reports do not link to hidden activity; visible tasks retain their link', () => {
  const { state, parent, child } = fixture()
  queueAssistantResult(state, child.id, 'Important change', 'one')
  deliverAssistantResults(state)
  assert.doesNotMatch(parent.turns[0].content, /shun:\/\/task/)
  delete child.scheduleId
  queueAssistantResult(state, child.id, 'Completed work', 'two')
  deliverAssistantResults(state)
  assert.match(parent.turns[1].content, /shun:\/\/task\/check-1/)
})

test('stale window saves preserve direct corrections and their delivery fence', async () => {
  const { mergeAssistantTasks } = await import('./assistant-tasks.ts')
  const parent = { id: 'parent', purpose: 'assistant' as const, title: 'Shun', workspace: '', createdAt: 1, updatedAt: 3, turns: [{ id: 'update-direct-1', role: 'user' as const, content: 'Keep the original script' }] }
  const child = { id: 'child', parentTaskId: parent.id, title: 'Video', workspace: '', createdAt: 1, updatedAt: 3, turns: [], lastDirectMessageAt: 3 }
  const merged = mergeAssistantTasks([parent, child], [{ ...parent, turns: [], updatedAt: 2 }, { ...child, lastDirectMessageAt: undefined, updatedAt: 2 }])
  assert.equal(merged[0].turns[0].content, 'Keep the original script')
  assert.equal(merged[1].lastDirectMessageAt, 3)
})

test('stale window saves cannot clear a paused child or restore a resumed pause', () => {
  const { child } = fixture()
  assert.equal(mergeAssistantTasks([{ ...child, assistantPaused: true }], [child])[0].assistantPaused, true)
  assert.equal(mergeAssistantTasks([child], [{ ...child, assistantPaused: true }])[0].assistantPaused, undefined)
})
