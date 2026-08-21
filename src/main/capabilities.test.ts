import assert from 'node:assert/strict'
import test from 'node:test'
import { activeToolNames, capabilityPrompt } from './capabilities.ts'

test('current-price requests cannot lose web capability to prompt classification', () => {
  const tools = activeToolNames('/workspace', ['history_search', 'web_search', 'web_read'])
  assert.deepEqual(tools, ['read', 'bash', 'edit', 'write', 'history_search', 'web_search', 'web_read'])
  assert.match(capabilityPrompt(tools).join('\n'), /outside.*web_search.*web_read/i)
})

test('product tools remain available without a workspace', () => {
  assert.deepEqual(activeToolNames('', ['web_search', 'web_read']), ['web_search', 'web_read'])
})
