import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeAssistantTask } from '../renderer/src/assistant-task-merge.ts'
import type { Task } from '../shared.ts'
const current = { id: 'personal', updatedAt: 20, draft: 'keep', turns: [{ id: 'run', role: 'assistant', content: 'complete live text', lastActivityAt: 20, timeline: [{ type: 'text', text: 'complete live text' }] }] } as Task

test('late saved snapshot cannot erase live prose or its timeline', () => {
  const stale = { ...current, updatedAt: 10, turns: [{ ...current.turns[0], content: '', timeline: [], lastActivityAt: 10 }] }
  const merged = mergeAssistantTask(current, stale)
  assert.equal(merged.turns[0], current.turns[0])
  assert.equal(merged.draft, 'keep')
  assert.equal(merged.updatedAt, 20)
})
test('snapshot adds delivered results without dropping an unsaved live turn', () => {
  const incoming = { ...current, turns: [{ id: 'delivery', role: 'assistant' as const, content: 'result', completedAt: 30 }] }
  assert.deepEqual(mergeAssistantTask(current, incoming).turns.map(t => t.id), ['delivery', 'run'])
})
test('newer terminal snapshot replaces the matching live turn', () => {
  const incoming = { ...current, turns: [{ ...current.turns[0], content: 'final', completedAt: 30, lastActivityAt: 30 }] }
  assert.equal(mergeAssistantTask(current, incoming).turns[0].content, 'final')
})
