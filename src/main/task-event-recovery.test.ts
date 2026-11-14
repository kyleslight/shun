import assert from 'node:assert/strict'
import test from 'node:test'
import { applyProjectedAgentEvent, recoverTaskEvents, readTaskEventHistory, TaskEventRecovery } from '../task-event-recovery.ts'
import type { Task, TaskEventEnvelope, Turn } from '../shared.ts'
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

test('context measurements and cancelled attempts never become completed notices on replay', () => {
  let turn: Turn = { id: 'run', role: 'assistant', content: '' }
  const context = (state: 'ready' | 'compacting' | 'compacted') => {
    turn = applyProjectedAgentEvent(turn, { id: 'run', type: 'context', context: { state, usedCharacters: 100, budgetCharacters: 1000 } })
  }
  for (let i = 0; i < 3; i++) { context('compacting'); context('ready') }
  assert.deepEqual(turn.timeline, [])
  context('compacting'); context('compacted'); context('ready')
  turn = applyProjectedAgentEvent(turn, { id: 'run', type: 'delta', text: 'Answer' })
  context('compacting'); context('ready')
  assert.deepEqual(turn.timeline?.map(entry => entry.type === 'context' ? entry.context.state : entry.type), ['compacted', 'text'])
  assert.equal(turn.contextUsage?.state, 'ready')
})


test('snapshot recovery shares concurrent replay and reads only newly appended events', async () => {
  const log = [...events.slice(0, 5)]
  const reads: number[] = []
  const recovery = new TaskEventRecovery(async (_, after) => {
    reads.push(after)
    await new Promise(resolve => setTimeout(resolve, 1))
    return log.filter(event => event.seq > after).slice(0, 2)
  }, async () => log.length)
  const [a, b] = await Promise.all([recovery.recover(task, false), recovery.recover(task, false)])
  assert.equal(a.task.turns[0].content, 'complete answer')
  assert.deepEqual(a, b)
  assert.deepEqual(reads, [0, 2, 4])
  for (let i = 0; i < 20; i++) await recovery.recover(task, false)
  assert.deepEqual(reads, [0, 2, 4])
  log.push(events[5])
  const done = await recovery.recover(task)
  assert.equal(done.task.turns[0].content, 'complete answer')
  assert.equal(done.task.turns[0].completedAt, events[5].at)
  assert.deepEqual(reads, [0, 2, 4, 5])
})

test('recovery stops at its watermark while a run keeps producing and isolates task projections', async () => {
  const recovery = new TaskEventRecovery(async (id, after) => events.filter(event => event.seq > after).map(event => ({ ...event, taskId: id })), async () => 3)
  const result = await recovery.recover(task, false)
  assert.equal(result.sequence, 3)
  assert.equal(result.task.turns[0].content, '')
  assert.equal(result.task.turns[0].tools?.[0].state, 'done')
  const other = await recovery.recover({ ...task, id: 'other', turns: [{ id: 'unrelated', role: 'assistant', content: 'own answer' }] }, false)
  assert.equal(other.task.turns[0].content, 'own answer')
})
