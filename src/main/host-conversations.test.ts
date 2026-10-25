import test from 'node:test'
import assert from 'node:assert/strict'
import { HostConversations, mergeHostConversations } from '../renderer/src/host-conversations.ts'
import type { Task } from '../shared.ts'
const task = { id: 'shared', title: 'CLI conversation', workspace: '', providerId: 'p', model: 'm', createdAt: 1, updatedAt: 1 }

test('desktop observes streaming events once and preserves its draft and selection-independent tasks', async () => {
 let events: any[] = []
 let activeRun: string | undefined = 'run'
 const bridge = new HostConversations(async (method, input) => {
   if (method === 'task.list') return [task]
   if (method === 'task.snapshot') return { task, turns: [], sequence: 0, activeRun }
   return { task, events: events.filter(item => item.seq > Number(input?.after)), activeRun }
 })
 const native: Task = { ...task, id: 'desktop', title: 'Working elsewhere', turns: [], draft: 'keep me' }
 let tasks = mergeHostConversations([native], await bridge.poll())
 tasks[1] = { ...tasks[1], draft: 'unfinished' }
 events = [{ taskId: task.id, seq: 1, at: 1, payload: { type: 'request', runId: 'run', messageId: 'user', text: 'Hello' } }, { taskId: task.id, seq: 2, at: 2, payload: { type: 'agent', runId: 'run', event: { id: 'run', type: 'delta', text: 'First' } } }]
 tasks = mergeHostConversations(tasks, await bridge.poll())
 assert.equal(tasks[0], native)
 assert.equal(tasks[1].draft, 'unfinished')
 assert.equal(tasks[1].turns[1].content, 'First')
 const unchanged = mergeHostConversations(tasks, await bridge.poll())
 assert.equal(unchanged, tasks)
 activeRun = undefined
 events.push({ taskId: task.id, seq: 3, at: 3, payload: { type: 'agent', runId: 'run', event: { id: 'run', type: 'done' } } })
 const snapshots = await bridge.poll()
 assert.equal(snapshots[0].activeRun, undefined)
 assert.equal(snapshots[0].turns[1].content, 'First')
 assert.ok(snapshots[0].turns[1].completedAt)
})
test('deleted service conversations disappear without replacing native identity', () => {
 const native: Task = { ...task, turns: [], draft: 'keep' }
 const snapshot = { task, turns: [], sequence: 0, trustRequired: false }
 assert.equal(mergeHostConversations([native], [snapshot])[0], native)
 const shared: Task = { ...task, conversationSource: 'service', turns: [] }
 assert.deepEqual(mergeHostConversations([shared], []), [])
})
