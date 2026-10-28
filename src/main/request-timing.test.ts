import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequestTimingExtension, type RequestTiming } from './request-timing.ts'

function harness() {
  let time = 0
  const rows: RequestTiming[] = [], handlers = new Map<string, Function>()
  createRequestTimingExtension(row => rows.push(row), () => time)({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any)
  return { rows, fire: (at: number, name: string, event: any = {}) => { time = at; return handlers.get(name)?.(event) } }
}

test('request timing separates first response, reasoning and text without storing content', () => {
  const h = harness()
  h.fire(100, 'before_provider_request', { payload: { messages: ['private question'], thinking_budget: 256 } })
  h.fire(150, 'after_provider_response')
  h.fire(170, 'message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'private reasoning' } })
  h.fire(220, 'message_update', { assistantMessageEvent: { type: 'thinking_delta' } })
  h.fire(240, 'message_update', { assistantMessageEvent: { type: 'text_delta' } })
  h.fire(260, 'message_update', { assistantMessageEvent: { type: 'text_delta' } })
  h.fire(270, 'message_end', { message: { role: 'assistant', stopReason: 'stop', usage: { input: 10, output: 20, cacheRead: 4 } } })
  h.fire(280, 'agent_end')
  assert.equal(h.rows.length, 1)
  assert.deepEqual({ ...h.rows[0], inputCharacters: 0 }, { request: 1, startedAt: 100, elapsedMs: 170, inputCharacters: 0,
    thinkingBudget: 256, responseMs: 50, firstDeltaMs: 70, firstThinkingMs: 70, lastThinkingMs: 120,
    firstTextMs: 140, lastTextMs: 160, stopReason: 'stop', inputTokens: 10, outputTokens: 20, cacheReadTokens: 4 })
  assert.doesNotMatch(JSON.stringify(h.rows), /private/)
})

test('unfinished requests, retries and concurrent sessions have independent measurements', () => {
  const a = harness(), b = harness()
  a.fire(0, 'before_provider_request', { payload: {} })
  b.fire(5, 'before_provider_request', { payload: {} })
  a.fire(20, 'before_provider_request', { payload: {} })
  a.fire(30, 'agent_end')
  b.fire(50, 'agent_end')
  assert.deepEqual(a.rows.map(row => [row.request, row.elapsedMs]), [[1, 20], [2, 10]])
  assert.deepEqual(b.rows.map(row => [row.request, row.elapsedMs]), [[1, 45]])
})


test('request timing measures retained message prefixes without recording their contents', () => {
  const h=harness(),messages=[{role:'system',content:'private system'},{role:'user',content:'private question'}]
  h.fire(0,'before_provider_request',{payload:{messages}})
  h.fire(20,'before_provider_request',{payload:{messages:[...messages,{role:'assistant',content:'private answer'}]}})
  h.fire(40,'agent_end')
  assert.equal(h.rows[1].sharedPrefixMessages,2)
  assert.equal(h.rows[1].sharedPrefixCharacters,messages.reduce((n,m)=>n+JSON.stringify(m).length,0))
  assert.equal(h.rows[1].firstChangedRole,'assistant')
  assert.doesNotMatch(JSON.stringify(h.rows),/private/)
})
