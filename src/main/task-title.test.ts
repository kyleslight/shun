import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeTaskTitle, taskTitleFromMessage } from './task-title.ts'

test('normalizes task title text', () => {
  assert.equal(normalizeTaskTitle('标题： “修复思考中动画重影。”'), '修复思考中动画重影')
  assert.equal(normalizeTaskTitle('```text\nFix streaming title generation\n```'), 'Fix streaming title generation')
})

test('keeps task titles bounded', () => {
  assert.equal([...normalizeTaskTitle('一'.repeat(80))].length, 48)
})

test('a first-message title is immediate and preserves the user language', () => {
  assert.equal(taskTitleFromMessage('Explain SQLite WAL concurrency'), 'Explain SQLite WAL concurrency')
  assert.equal(taskTitleFromMessage('请解释 SQLite WAL 的并发规则？'), '请解释 SQLite WAL 的并发规则')
  assert.equal(taskTitleFromMessage('\n# Fix cancellation\nDetails follow'), 'Fix cancellation')
  assert.equal(taskTitleFromMessage(''), '')
  assert.equal([...taskTitleFromMessage('🙂'.repeat(70))].length, 48)
})
