import assert from 'node:assert/strict'
import test from 'node:test'
import { recoverTaskEvents, readTaskEventHistory } from '../task-event-recovery.ts'
import type { Task, TaskEventEnvelope } from '../shared.ts'
const task = { id: 'task', turns: [{ id: 'run', role: 'assistant', content: 'tail', phase: 'Thinking' }] } as Task
const payloads: TaskEventEnvelope['payload'][] = [
  { type: 'request', runId: 'run', text: 'work' },
  { type: 'agent', runId: 'run', event: { id: 'run', type: 'tool', tool: { id: 'tool', name: 'bash', input: '{}', output: '', state: 'running' } } },
  { type: 'agent', runId: 'run', event: { id: 'run', type: 'tool', tool: { id: 'tool', name: 'bash', input: '{}', output: 'result', state: 'done' } } },
  { type: 'agent', runId: 'run', event: { id: 'run', type: 'delta', text: 'complete ' } },
  { type: 'agent', runId: 'run', event: { id: 'run', type: 'delta', text: 'answer' } },
  { type: 'agent', runId: 'run', event: { id: 'run', type: 'done' } },
]
const events = payloads.map((payload, i) => ({ taskId: 'task', seq: i + 1, at: 100 + i, payload }))
test('recovery replaces truncated prose and unfinished tools without duplicating text', () => {
  const recovered = recoverTaskEvents(task, events)
  assert.equal(recovered.turns[0].content, 'complete answer')
  assert.equal(recovered.turns[0].tools?.[0].state, 'done')
  assert.equal(recovered.turns[0].phase, '')
  assert.equal(recovered.turns[0].completedAt, 105)
  assert.deepEqual(recoverTaskEvents(recovered, events), recovered)
})
test('active snapshots use the same event prefix as their watermark', () => {
  assert.equal(recoverTaskEvents(task, events.slice(0, 5), false).turns[0].content, 'complete answer')
  assert.equal(recoverTaskEvents(task, events.slice(0, 5)).turns[0].content, 'tail')
})
test('recovery reads beyond one page and refuses gaps', async () => {
  assert.deepEqual(await readTaskEventHistory('task', async (_, after) => events.filter(e => e.seq > after).slice(0, 2)), events)
  await assert.rejects(readTaskEventHistory('task', async () => [events[1]]), /incomplete/)
})
