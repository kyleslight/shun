import assert from 'node:assert/strict'
import test from 'node:test'
import { toolActivity, toolSummary } from './tool-activity.ts'
import type { ToolEvent } from '../shared.ts'

const tool = (id: string, state: ToolEvent['state'] = 'done', output = 'Internal instructions\n'.repeat(200)): ToolEvent => ({ id, name: 'read', input: JSON.stringify({ path: 'SKILL.md' }), state, output })

test('completed operations collapse without leaking Skill bodies or mutating events', () => {
  const tools = Array.from({ length: 50 }, (_, i) => tool(String(i)))
  const before = JSON.stringify(tools)
  const text = toolActivity(tools)
  assert.equal(text, '')
  assert.doesNotMatch(text, /Internal instructions|SKILL.md/)
  assert.equal(JSON.stringify(tools), before)
  assert.match(toolActivity(tools, true), /Internal instructions/)
  assert.equal(toolActivity(tools), text)
})

test('running activity and failure stay visible while error dumps remain collapsed', () => {
  const text = toolActivity([tool('1'), tool('2', 'running'), tool('3', 'error', 'Connection expired\n' + 'stack trace\n'.repeat(100))])
  assert.match(text, /◌ Read/)
  assert.match(text, /✗ Read/)
  assert.match(text, /Connection expired/)
  assert.doesNotMatch(text, /stack trace|Internal instructions/)
})

test('details sanitize terminal controls and compact labels fit narrow terminals', () => {
  const event = tool('1', 'error', '\x1b[2JFailure\x00')
  event.input = JSON.stringify({ path: 'long-path/'.repeat(100) })
  assert.doesNotMatch(toolActivity([event], true), /\x1b|\x00/)
  assert.ok(toolActivity([event], false, 30).split('\n').every(line => line.length <= 30))
  assert.equal(toolActivity([]), '')
})

test('collapsed activity names the work and tracks its state without exposing output', () => {
  const search = { id: 'search', name: 'web_search', input: '{"query":"example"}', state: 'running', output: 'private output' } as ToolEvent
  assert.equal(toolSummary([search]), 'Searching web')
  assert.equal(toolSummary([{ ...search, state: 'done' }]), 'Searched web')
  assert.equal(toolSummary([{ ...search, state: 'error' }]), 'Web search failed')
  assert.equal(toolSummary([search, search]), 'Searching web')
  assert.doesNotMatch(toolSummary([search]), /private output|operation/)
})
