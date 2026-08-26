import assert from 'node:assert/strict'
import test from 'node:test'
import { detectTaskTitleLanguage, normalizeTaskTitle, taskTitleMatchesLanguage, taskTitlePrompt } from './task-title.ts'

test('normalizes model-generated task titles', () => {
  assert.equal(normalizeTaskTitle('标题： “修复思考中动画重影。”'), '修复思考中动画重影')
  assert.equal(normalizeTaskTitle('```text\nFix streaming title generation\n```'), 'Fix streaming title generation')
})

test('keeps generated task titles bounded', () => {
  assert.equal([...normalizeTaskTitle('一'.repeat(80))].length, 48)
})

test('derives title language from the first user message', () => {
  assert.equal(detectTaskTitleLanguage('tell me more about this article'), 'en')
  assert.equal(detectTaskTitleLanguage('请详细介绍这篇文章'), 'zh-CN')
  assert.equal(detectTaskTitleLanguage('请修复 React Native composer bug'), 'zh-CN')
  assert.equal(detectTaskTitleLanguage('tell me about 中文.pdf'), 'en')
})

test('makes the detected prompt language authoritative', () => {
  assert.match(taskTitlePrompt('tell me more about this article'), /MUST be written in English/)
  assert.match(taskTitlePrompt('请详细介绍这篇文章'), /标题必须使用简体中文/)
})

test('rejects generated titles that switch away from the prompt language', () => {
  assert.equal(taskTitleMatchesLanguage('Article details', 'en'), true)
  assert.equal(taskTitleMatchesLanguage('了解文章详情', 'en'), false)
  assert.equal(taskTitleMatchesLanguage('了解文章详情', 'zh-CN'), true)
  assert.equal(taskTitleMatchesLanguage('Article details', 'zh-CN'), false)
})
