import assert from 'node:assert/strict'
import test from 'node:test'
import { assistantContextPolicy, assistantForegroundContextExtension } from './assistant-context.ts'
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


test('foreground defers optional compaction but preserves manual and capacity recovery', async () => {
  const hooks: Record<string, (event: any) => any> = {}
  assistantForegroundContextExtension({ text: 'Next question', settings: { contextWindow: 524288, maxTokens: 32768 } } as AgentRequest)({ on: (name: string, handler: any) => { hooks[name] = handler } } as any)
  const event = { reason: 'threshold', willRetry: false, preparation: { tokensBefore: 60000 } }
  assert.deepEqual(hooks.session_before_compact(event), { cancel: true })
  assert.equal(hooks.session_before_compact({ ...event, preparation: { tokensBefore: 510000 } }), undefined)
  assert.equal(hooks.session_before_compact({ ...event, reason: 'overflow', willRetry: true }), undefined)
  assert.equal(hooks.session_before_compact({ ...event, reason: 'manual' }), undefined)
  hooks.agent_end({ messages: [{ role: 'assistant', stopReason: 'stop' }] })
  assert.deepEqual(hooks.session_before_compact({ ...event, preparation: { tokensBefore: 510000 } }), { cancel: true })
  assert.equal(hooks.session_before_compact({ ...event, reason: 'overflow', willRetry: true }), undefined)
})


test('child sessions use a bounded working set and retain capacity compaction during execution', () => {
  const request = { text: 'Continue', settings: { contextWindow: 524288, maxTokens: 32768 } } as AgentRequest
  assert.equal(assistantContextPolicy(request, undefined, true).workingSetTokens, 65536)
  const hooks: Record<string, (event: any) => any> = {}
  assistantForegroundContextExtension(request, false)({ on: (name: string, handler: any) => { hooks[name] = handler } } as any)
  const threshold = { reason: 'threshold', willRetry: false, preparation: { tokensBefore: 70000 } }
  assert.deepEqual(hooks.session_before_compact(threshold), { cancel: true })
  hooks.agent_start({})
  assert.equal(hooks.session_before_compact(threshold), undefined)
  hooks.agent_end({ messages: [{ role: 'assistant', stopReason: 'stop' }] })
  assert.deepEqual(hooks.session_before_compact(threshold), { cancel: true })
  assert.equal(hooks.session_before_compact({ ...threshold, reason: 'manual' }), undefined)
})


test('cancelled child execution never starts post-run compaction, even when transport reports error', () => {
  const controller = new AbortController()
  const hooks: Record<string, (event: any) => any> = {}
  assistantForegroundContextExtension({ text: 'Correction', settings: { contextWindow: 524288 } } as AgentRequest, false, controller.signal)({ on: (name: string, handler: any) => { hooks[name] = handler } } as any)
  controller.abort()
  hooks.agent_end({ messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'This operation was aborted' }] })
  for (const reason of ['threshold', 'overflow', 'manual']) {
    assert.deepEqual(hooks.session_before_compact({ reason, willRetry: true, preparation: { tokensBefore: 92070 } }), { cancel: true })
  }
})


test('compaction output budget is independent of the physical-window reservation', () => {
  const hooks: Record<string, (event: any) => any> = {}
  assistantForegroundContextExtension({ text: '', settings: { contextWindow: 524288 } } as AgentRequest, false)({ on: (name: string, handler: any) => { hooks[name] = handler } } as any)
  hooks.agent_start({})
  const preparation = { tokensBefore: 90000, settings: { reserveTokens: 466944, keepRecentTokens: 12288 }, firstKeptEntryId: 'retained' }
  assert.equal(hooks.session_before_compact({ reason: 'threshold', preparation }), undefined)
  assert.equal(preparation.settings.reserveTokens, 8192)
  assert.equal(preparation.settings.keepRecentTokens, 12288)
  assert.equal(preparation.firstKeptEntryId, 'retained')
})
