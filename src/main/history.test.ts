import assert from 'node:assert/strict'
import test from 'node:test'
import { searchPersistedEvents, searchPersistedTask } from './history.ts'

test('persisted history search retrieves compacted-away dialogue and tool evidence', () => {
  const state = { tasks: [{ id: 'task-1', turns: [
    { role: 'user', content: 'Keep the frobnicator API backwards compatible.' },
    { role: 'assistant', content: '', timeline: [{ type: 'tool', tool: { name: 'read', input: '{"path":"src/api.ts"}', output: '42: export function frobnicate()', state: 'done' } }] }
  ] }] }
  assert.match(searchPersistedTask(state, 'task-1', 'frobnicator API'), /backwards compatible/)
  assert.match(searchPersistedTask(state, 'task-1', 'src\/api.ts'), /frobnicate/)
  assert.match(searchPersistedTask(state, 'missing', 'anything'), /No persisted history/)
})

test('append-only event history remains searchable independently of UI state', () => {
  const result = searchPersistedEvents([
    { type: 'request', text: 'Do not change the public package name.' },
    { type: 'tool', tool: { name: 'run', input: '{"command":"pnpm test"}', output: '30 tests passed' } }
  ], 'package name')
  assert.match(result, /Do not change/)
})
