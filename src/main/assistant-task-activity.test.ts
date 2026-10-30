import test from 'node:test'
import assert from 'node:assert/strict'
import type { Task, ToolEvent } from '../shared.ts'
import { readAssistantTaskActivity, withLiveTaskActivity } from './assistant-task-activity.ts'
const tool = (id: string): ToolEvent => ({ id, name: 'read', input: '{"path":"results.json"}', output: 'Downloaded 418 MB; validation passed', state: 'done' })
const task = (): Task => ({ id: 'child', title: 'Research', workspace: '', createdAt: 1, updatedAt: 2000, turns: Array.from({ length: 12 }, (_, i) => ({ id: String(i), role: 'assistant', content: i === 11 ? '' : 'Earlier text' })) })
test('progress includes tool-only work and latest tool state without duplicating timeline entries', () => {
  const t = task()
  t.turns[11] = { ...t.turns[11], lastActivityAt: 2000, timeline: [{ type: 'tool', tool: { ...tool('download'), state: 'running' } }], tools: [tool('download')] }
  const result = readAssistantTaskActivity(t, true)
  const latest = result.turns.at(-1)!
  assert.equal(result.running, true)
  assert.equal(latest.content.text, '')
  assert.equal(latest.tools.length, 1)
  assert.equal(latest.tools[0].state, 'done')
  assert.match(latest.tools[0].output.text, /418 MB/)
  assert.equal(latest.lastActivityAtISO, new Date(2000).toISOString())
})
test('default page is newest and older pages cover every turn once', () => {
  const t = task()
  const first = readAssistantTaskActivity(t, false)
  assert.deepEqual(first.turns.map(t => t.id), ['7', '8', '9', '10', '11'])
  const second = readAssistantTaskActivity(t, false, { offset: first.nextOffset })
  const third = readAssistantTaskActivity(t, false, { offset: second.nextOffset })
  assert.deepEqual([...third.turns, ...second.turns, ...first.turns].map(t => t.id), t.turns.map(t => t.id))
  assert.equal(third.nextOffset, undefined)
})
test('long runs expose newest tools and page older tools even in a single turn', () => {
  const t = task()
  t.turns[11].tools = Array.from({ length: 25 }, (_, i) => tool(String(i)))
  t.turns[11].tools![24].output = 'start' + 'x'.repeat(10000) + 'end'
  const latest = readAssistantTaskActivity(t, true).turns.at(-1)!
  assert.equal(latest.totalTools, 25)
  assert.equal(latest.tools[0].id, '15')
  assert.equal(latest.tools.at(-1)!.output.truncated, true)
  assert.ok(latest.tools.at(-1)!.output.text.endsWith('end'))
  const older = readAssistantTaskActivity(t, true, { turnId: '11', toolOffset: latest.nextToolOffset }).turns[0]
  assert.equal(older.tools[0].id, '5')
  assert.equal(older.tools.at(-1)!.id, '14')
  assert.throws(() => readAssistantTaskActivity(t, false, { turnId: 'missing' }), /Turn not found/)
})

test('live event projection replaces stale saved progress without requiring an open view', () => {
  const t = task()
  const live = { ...t.turns[11], content: '', tools: [tool('latest')] }
  const snapshot = withLiveTaskActivity(t, live)
  assert.equal(snapshot.turns.length, t.turns.length)
  assert.equal(readAssistantTaskActivity(snapshot, true).turns.at(-1)!.tools[0].id, 'latest')
  assert.equal(t.turns[11].tools, undefined)
  assert.equal(withLiveTaskActivity(t, { ...live, id: 'new-run' }).turns.length, 13)
})
