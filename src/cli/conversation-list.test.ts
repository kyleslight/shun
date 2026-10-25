import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationActivity, recentConversations } from '../conversation-list.ts'

test('history hides archives and ranks conversation activity ahead of metadata edits', () => {
 const tasks = [
  { id: 'archived', updatedAt: 9999, lastActivityAt: 900, archivedAt: 9999 },
  { id: 'renamed', updatedAt: 9998, lastActivityAt: 10 },
  { id: 'recent', updatedAt: 500, lastActivityAt: 500 },
 ]
 assert.deepEqual(recentConversations(tasks).map(task => task.id), ['recent', 'renamed'])
 assert.equal(tasks.length, 3)
})
test('desktop activity uses message timestamps with creation fallback for old history', () => {
 assert.equal(conversationActivity({createdAt: 1, turns:[{id:'a', role:'assistant', content:'x', startedAt:2, completedAt:8, lastActivityAt:7}]}), 8)
 assert.equal(conversationActivity({createdAt: 1, turns:[{id:'a', role:'assistant', content:'old'}]}), 1)
})
