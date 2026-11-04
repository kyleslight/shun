import test from 'node:test'
import assert from 'node:assert/strict'
import { reportMonitorHealth } from './monitor-health.ts'
import { ensureAssistant, queueAssistantResult, deliverAssistantResults, mergeAssistantTasks } from './assistant-tasks.ts'
import type { SavedState } from '../shared.ts'
const fixture = () => { const state = { tasks: [], settings: { language: 'zh-CN' } } as unknown as SavedState; return { state, parent: ensureAssistant(state) } }
test('short outages and recovery add no activity or conversation messages', () => {
  const { state, parent } = fixture()
  for (let now = 0; now < 15 * 60000; now += 60000)
    assert.equal(reportMonitorHealth(state, parent.id, [{ name: 'mail', failures: 20, firstFailedAt: 0 }], now), undefined)
  assert.equal(reportMonitorHealth(state, parent.id, [{ name: 'mail' }], 16 * 60000), undefined)
  assert.equal(parent.turns.length, 0); assert.equal(state.tasks.length, 1)
})
test('sustained shared outage is grouped, survives restart and cannot drown out real events', () => {
  const { state, parent } = fixture(), now = 31 * 60000
  const issues = ['mail', 'feed'].map(name => ({ name, failures: 5, firstFailedAt: 0 }))
  assert.ok(reportMonitorHealth(state, parent.id, issues, now))
  assert.match(parent.turns[0].content, /mail、feed/)
  const recovered = JSON.parse(JSON.stringify(state)) as SavedState
  assert.equal(reportMonitorHealth(recovered, parent.id, issues, now + 60000), undefined)
  assert.equal(reportMonitorHealth(recovered, parent.id, [], now + 120000), undefined)
  assert.equal(mergeAssistantTasks(recovered.tasks, [{ ...parent, turns: [] }])[0].turns.length, 1)
  recovered.tasks.push({ id: 'mail-event', title: 'mail', parentTaskId: parent.id, purpose: 'background', scheduleId: 'watch', workspace: '', turns: [], createdAt: now, updatedAt: now })
  queueAssistantResult(recovered, 'mail-event', 'Important new reply', 'message-1')
  deliverAssistantResults(recovered)
  assert.equal(recovered.tasks[0].turns.length, 2)
  assert.match(recovered.tasks[0].turns[1].content, /Important new reply/)
})
