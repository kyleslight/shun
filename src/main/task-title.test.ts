import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeTaskTitle } from './task-title.ts'

test('normalizes model-generated task titles', () => {
  assert.equal(normalizeTaskTitle('标题： “修复思考中动画重影。”'), '修复思考中动画重影')
  assert.equal(normalizeTaskTitle('```text\nFix streaming title generation\n```'), 'Fix streaming title generation')
})

test('keeps generated task titles bounded', () => {
  assert.equal([...normalizeTaskTitle('一'.repeat(80))].length, 48)
})
