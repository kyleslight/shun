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
  const pages = []
  let offset = 0
  do {
    const page = readAssistantTaskActivity(t, false, { detail: true, offset })
    pages.unshift(...page.turns)
    if (page.nextOffset === undefined) break
    offset = page.nextOffset
  } while (true)
  assert.deepEqual(pages.map(t => t.id), t.turns.map(t => t.id))
})
test('long runs expose newest tools and page older tools even in a single turn', () => {
  const t = task()
  t.turns[11].tools = Array.from({ length: 25 }, (_, i) => tool(String(i)))
  t.turns[11].tools![24].output = 'start' + 'x'.repeat(10000) + 'end'
  const latest = readAssistantTaskActivity(t, true, { detail: true }).turns.at(-1)!
  assert.equal(latest.totalTools, 25)
  assert.equal(latest.tools[0].id, '23')
  assert.equal(latest.tools.at(-1)!.output.truncated, true)
  assert.ok(latest.tools.at(-1)!.output.text.endsWith('end'))
  const older = readAssistantTaskActivity(t, true, { turnId: '11', toolOffset: latest.nextToolOffset, detail: true }).turns[0]
  assert.equal(older.tools[0].id, '21')
  assert.equal(older.tools.at(-1)!.id, '22')
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

 test('default progress snapshots stay small even when child tool outputs are large', () => {
  const t = task()
  for (const turn of t.turns) {
    turn.content = 'z'.repeat(20000)
    turn.tools = Array.from({ length: 30 }, (_, i) => ({ ...tool(String(i)), input: 'a'.repeat(5000), output: 'b'.repeat(20000) }))
  }
  const result = readAssistantTaskActivity(t, true)
  assert.equal(result.turns.length, 2)
  assert.equal(result.turns.at(-1)!.tools.length, 3)
  assert.equal(result.turns.at(-1)!.totalTools, 30)
  assert.ok(JSON.stringify(result).length < 12000)
  assert.equal(result.turns.at(-1)!.tools.at(-1)!.id, '29')
  assert.equal(result.turns.at(-1)!.tools.at(-1)!.output.truncated, true)
  assert.ok(JSON.stringify(readAssistantTaskActivity(t, true, {detail: true})).length < 12000)
  assert.ok(result.nextOffset)
  assert.ok(result.turns.at(-1)!.nextToolOffset)
 })

test('child snapshot exposes bounded pending delivery data without copying its full inbox', () => {
  const t = task()
  t.assistantPaused = true
  t.assistantFollowUps = Array.from({ length: 15 }, (_, i) => ({ id: String(i), text: 'x'.repeat(5000) }))
  const snapshot = readAssistantTaskActivity(t, false)
  assert.equal(snapshot.paused, true)
  assert.equal(snapshot.pendingMessageCount, 15)
  assert.equal(snapshot.pendingMessages.length, 10)
  assert.equal(snapshot.pendingMessages[0].content.truncated, true)
  assert.ok(snapshot.pendingMessages[0].content.text.length < 650)
})
