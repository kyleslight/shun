import assert from 'node:assert/strict'
import test from 'node:test'
import { activeToolNames, capabilityPrompt, productSystemPrompt } from './capabilities.ts'

test('current-price requests cannot lose web capability to prompt classification', () => {
  const tools = activeToolNames('/workspace', ['history_search', 'web_search', 'web_read'])
  assert.deepEqual(tools, ['read', 'bash', 'edit', 'write', 'history_search', 'web_search', 'web_read'])
  assert.match(capabilityPrompt(tools).join('\n'), /outside.*web_search.*web_read/i)
})

test('product tools remain available without a workspace', () => {
  assert.deepEqual(activeToolNames('', ['web_search', 'web_read']), ['web_search', 'web_read'])
})

test('local PDF capability advertises the built-in cross-platform reader', () => {
  const prompt = capabilityPrompt(activeToolNames('/workspace', ['read_pdf'])).join('\n')
  assert.match(prompt, /local PDF.*read_pdf/i)
  assert.match(prompt, /built in and cross-platform/i)
  assert.match(prompt, /do not install or invoke external PDF utilities/i)
})

test('the product identity answers model questions without exposing the internal runtime', () => {
  const prompt = productSystemPrompt('deepseek-v4-flash')
  assert.match(prompt, /You are Shun/)
  assert.match(prompt, /deepseek-v4-flash/)
  assert.match(prompt, /authoritative product state/)
  assert.match(prompt, /Never claim that you cannot access or determine the current model/)
  assert.match(prompt, /project context files.*do not define your public identity/i)
  assert.match(prompt, /Never describe Shun or yourself as derived from.*Pi/)
  assert.match(prompt, /fine to discuss a harness/i)
  assert.doesNotMatch(prompt, /operating inside pi/i)
})
