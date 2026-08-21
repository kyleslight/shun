import assert from 'node:assert/strict'
import test from 'node:test'
import { hasContinuationState, isSoftNotFoundSource, keepCurrentDraft, latestProviderFailure, nextTaskWorkspace, type ToolEvent } from '../shared.ts'

test('new tasks inherit the selected project unless standalone was explicitly chosen', () => {
  assert.equal(nextTaskWorkspace(undefined, '/current', '/remembered'), '/current')
  assert.equal(nextTaskWorkspace(undefined, undefined, '/remembered'), '/remembered')
  assert.equal(nextTaskWorkspace('', '/current', '/remembered'), '')
})

test('the currently selected blank draft survives persistence and reload selection', () => {
  const tasks = [{ id: 'draft', messages: 0 }, { id: 'old', messages: 2 }, { id: 'other-blank', messages: 0 }]
  assert.deepEqual(keepCurrentDraft(tasks, 'draft', task => task.messages > 0).map(task => task.id), ['draft', 'old'])
})

test('web source metadata can survive compact tool output in saved task history', () => {
  const source = { requestedUrl: 'https://example.test/a', finalUrl: 'https://example.test/b', title: 'Evidence', contentType: 'text/html', fetchMethod: 'direct' }
  const tool: ToolEvent = { id: '1', name: 'web_read', input: '{"url":"https://example.test/a"}', output: '{"ok":true}', source, state: 'done' }
  assert.deepEqual(JSON.parse(JSON.stringify(tool)).source, source)
})

test('soft 404 source metadata is rejected even when the server returned HTTP 200', () => {
  assert.equal(isSoftNotFoundSource({ finalUrl: 'https://example.test/page-not-found', title: 'Example' }), true)
  assert.equal(isSoftNotFoundSource({ finalUrl: 'https://example.test/article', title: 'Page not found' }), true)
  assert.equal(isSoftNotFoundSource({ finalUrl: 'https://example.test/article', title: 'Actual article' }), false)
})

test('follow-ups retain continuation state after progress or tool activity', () => {
  assert.equal(hasContinuationState([{ progress: undefined, timeline: [], tools: [] }]), false)
  assert.equal(hasContinuationState([{ progress: { stage: 'implementation' } as any, timeline: [], tools: [] }]), true)
  assert.equal(hasContinuationState([{ progress: undefined, timeline: [{ type: 'tool', tool: {} as any }], tools: [] }]), true)
})

test('only the latest assistant failure activates provider recovery on retry', () => {
  assert.equal(latestProviderFailure([
    { role: 'assistant', content: 'Error: Model stream was idle.', error: true },
    { role: 'assistant', content: 'Recovered successfully.', error: false },
  ]), undefined)
  assert.match(latestProviderFailure([
    { role: 'assistant', content: 'Earlier success.', error: false },
    { role: 'assistant', content: 'Error: Model stream had no visible progress for 3 minutes.', error: true },
  ]) || '', /no visible progress/)
})
