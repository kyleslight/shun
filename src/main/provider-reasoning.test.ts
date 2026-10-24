import assert from 'node:assert/strict'
import test from 'node:test'
import type { Model, ProviderStreams, StreamOptions } from '@earendil-works/pi-ai'
import { deploymentReasoningApi, withReasoningBudget } from './provider-reasoning.ts'

const model = (reasoning = false): Model<'openai-completions'> => ({
  id: 'deployment', name: 'Deployment', provider: 'configured', api: 'openai-completions', baseUrl: 'http://localhost/v1',
  reasoning, compat: { thinkingFormat: 'deepseek' }, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048,
})

test('both request entry points preserve hooks and explicitly disable endpoint thinking defaults', async () => {
  for (const entry of ['stream', 'streamSimple'] as const) {
    let forwarded: StreamOptions | undefined
    const sentinel = {} as ReturnType<ProviderStreams['stream']>
    const stream: ProviderStreams['stream'] = (_model, _context, options) => { forwarded = options; return sentinel }
    const api = deploymentReasoningApi({ stream, streamSimple: stream })
    const controller = new AbortController()
    let hooks = 0
    const options: StreamOptions = { signal: controller.signal, onPayload: async payload => { hooks++; return { ...(payload as object), trace: 'preserved' } } }
    assert.equal(api[entry](model(), { messages: [] }, options), sentinel)
    assert.equal(forwarded?.signal, controller.signal)
    const original = { messages: [{ role: 'user', content: 'Question' }], reasoning_effort: 'medium' }
    const payload = await forwarded!.onPayload!(original, model())
    assert.deepEqual(payload, { messages: original.messages, trace: 'preserved', thinking: { type: 'disabled' } })
    assert.equal(hooks, 1)
    assert.equal(original.reasoning_effort, 'medium')
  }
})

test('enabled reasoning and unrelated protocols retain their original request options', () => {
  let forwarded: StreamOptions | undefined
  const stream: ProviderStreams['stream'] = (_model, _context, options) => { forwarded = options; return {} as ReturnType<ProviderStreams['stream']> }
  const api = deploymentReasoningApi({ stream, streamSimple: stream })
  const options = { onPayload: () => undefined }
  for (const configured of [model(true), { ...model(), compat: {} }]) {
    api.stream(configured, { messages: [] }, options)
    assert.equal(forwarded, options)
  }
})


test('a declared reading budget preserves thinking mode and caller effort', () => {
  const request={messages:[{role:'user',content:'Read the evidence'}],thinking:{type:'enabled'},reasoning_effort:'medium'}
  assert.deepEqual(withReasoningBudget(request,'thinking_budget',64),{...request,thinking_budget:64})
  assert.equal(withReasoningBudget(request,undefined,64),request)
  assert.deepEqual(withReasoningBudget({...request,thinking_budget:32},'thinking_budget',64),{...request,thinking_budget:32})
  assert.deepEqual(withReasoningBudget({thinking:{type:'disabled'}},'thinking_budget',64),{thinking:{type:'disabled'},thinking_budget:64})
  assert.equal(withReasoningBudget(request,'thinking_budget',0),request)
})
