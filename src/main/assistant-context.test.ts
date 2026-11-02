import assert from 'node:assert/strict'
import test from 'node:test'
import { assistantContextPolicy } from './assistant-context.ts'
import type { AgentRequest } from '../shared.ts'

test('personal working-set configuration neither changes other tasks nor increases smaller model windows', () => {
  const request = { settings: { contextWindow: 524_288 }, text: 'unchanged', history: [] } as unknown as AgentRequest
  assert.equal(assistantContextPolicy(request).request, request)
  assert.equal(assistantContextPolicy(request, 'background').request, request)
  const personal = assistantContextPolicy(request, 'assistant')
  assert.equal(personal.request.settings.contextWindow, 524_288)
  assert.equal(personal.workingSetTokens, 65_536)
  assert.equal(personal.request.settings.contextWindow - personal.compactionSettings!.reserveTokens, 57_344)
  assert.equal(request.settings.contextWindow, 524_288)
  assert.equal(personal.request.history, request.history)
  const small = assistantContextPolicy({ ...request, settings: { ...request.settings, contextWindow: 8_192 } }, 'assistant')
  assert.equal(small.request.settings.contextWindow, 8_192)
  assert.ok(small.compactionSettings!.reserveTokens + small.compactionSettings!.keepRecentTokens < 8_192 / 2)
})
