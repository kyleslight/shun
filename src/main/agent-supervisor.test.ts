import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrepareNextTurnContext } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { AgentSupervisor, limitationClaim, noteworthySupervisorRecord, repetitionProfile, streamTokens } from './agent-supervisor.ts'

const event = (value: Record<string, unknown>) => value as unknown as AgentSessionEvent
const streamed = (delta: string) => event({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'thinking_delta', delta } })
const called = (id: string, name: string, args: unknown) => event({ type: 'tool_execution_start', toolCallId: id, toolName: name, args })
const ended = (id: string, name: string, isError = false, changed?: boolean) => event({
  type: 'tool_execution_end', toolCallId: id, toolName: name, isError, result: { content: [], ...(changed === undefined ? {} : { details: { changed } }) },
})
const turn = (content: Array<Record<string, unknown>>) => ({ message: { role: 'assistant', content }, toolResults: [], context: { messages: [] }, newMessages: [] }) as unknown as PrepareNextTurnContext
const concluding = (text: string) => turn([{ type: 'text', text }])
const working = (id: string, name: string, args: string) => turn([{ type: 'toolCall', id, name, arguments: args }])

/** The shape the failure actually took: the same short exchange, over and over. */
const degenerateOutput = 'write it. okay. execute. '.repeat(60)
const healthyOutput = Array.from({ length: 400 }, (_, index) => `distinct${index}`).join(' ')

test('a repeated phrase covers a window that healthy reasoning of the same length does not', () => {
  const degenerate = repetitionProfile(streamTokens(degenerateOutput))
  const healthy = repetitionProfile(streamTokens(healthyOutput))
  assert.ok(degenerate.repetitionRatio > 0.9, `repetition ${degenerate.repetitionRatio}`)
  assert.ok(degenerate.uniqueRatio < 0.05, `unique ${degenerate.uniqueRatio}`)
  assert.ok(healthy.repetitionRatio < 0.05, `repetition ${healthy.repetitionRatio}`)
  assert.ok(healthy.uniqueRatio > 0.9, `unique ${healthy.uniqueRatio}`)
})

test('repeating a tool call that changes nothing is not progress, and resolving one is', () => {
  const supervisor = new AgentSupervisor()
  supervisor.observe(called('a', 'bash', { command: 'node search.mjs' }))
  supervisor.observe(ended('a', 'bash'))
  supervisor.observe(called('b', 'bash', { command: 'node search.mjs' }))
  supervisor.observe(ended('b', 'bash'))
  supervisor.observe(streamed(degenerateOutput))
  assert.equal(typeof supervisor.interrupt(), 'string')

  // A call that produced something new resets the window, so repetition before it
  // is not counted against the state the run is in now.
  const next = new AgentSupervisor()
  const half = 'write it. okay. execute. '.repeat(40)
  next.observe(streamed(half))
  next.observe(called('a', 'read', { path: 'search.mjs' }))
  next.observe(ended('a', 'read'))
  next.observe(streamed(half))
  assert.equal(next.interrupt(), undefined)

  // The same call that failed before, now succeeding, is progress too.
  const resolved = new AgentSupervisor()
  resolved.observe(called('a', 'bash', { command: 'pnpm test' }))
  resolved.observe(ended('a', 'bash', true))
  resolved.observe(streamed(degenerateOutput))
  assert.equal(typeof resolved.interrupt(), 'string')
})

test('varying output of the same volume is never suspected', () => {
  const supervisor = new AgentSupervisor()
  supervisor.observe(streamed(healthyOutput))
  assert.equal(supervisor.interrupt(), undefined)
  assert.equal(supervisor.finish().degenerationDetections, 0)
})

test('guidance is delivered once per episode, and a second episode after progress gets its own', () => {
  const supervisor = new AgentSupervisor()
  supervisor.observe(called('a', 'read', { path: 'one.ts' }))
  supervisor.observe(ended('a', 'read'))
  supervisor.observe(streamed(degenerateOutput))
  assert.match(String(supervisor.interrupt()), /repeating the same reasoning/)
  // Still the same episode: no second message, and no escalation yet.
  supervisor.observe(streamed(degenerateOutput))
  assert.equal(supervisor.interrupt(), undefined)
  assert.equal(supervisor.telemetry().degenerationSteers, 1)

  // Progress closes the episode...
  supervisor.observe(called('b', 'read', { path: 'two.ts' }))
  supervisor.observe(ended('b', 'read'))
  // ...and repetition after it is a new one.
  supervisor.observe(streamed(degenerateOutput))
  assert.equal(typeof supervisor.interrupt(), 'string')
  const telemetry = supervisor.finish()
  assert.equal(telemetry.degenerationSteers, 2)
  assert.equal(telemetry.recoveryOutcome, 'recovered')
})

test('repetition that survives its guidance is recorded as the level the ladder would escalate to', () => {
  const supervisor = new AgentSupervisor()
  supervisor.observe(streamed(degenerateOutput))
  assert.equal(typeof supervisor.interrupt(), 'string')
  // The stream keeps repeating without changing anything after the guidance.
  supervisor.observe(streamed(degenerateOutput))
  supervisor.observe(streamed(degenerateOutput))
  assert.equal(supervisor.interrupt(), undefined)
  const telemetry = supervisor.finish()
  assert.equal(telemetry.degenerationEscalations, 1)
  assert.equal(telemetry.recoveryOutcome, 'persisted')
})

test('a tool call that fails identically again and again earns guidance naming it', () => {
  const supervisor = new AgentSupervisor()
  for (const id of ['a', 'b', 'c']) {
    supervisor.observe(called(id, 'bash', { command: 'curl https://example.com/api' }))
    supervisor.observe(ended(id, 'bash', true))
  }
  const decision = supervisor.shouldRecover()
  assert.equal(decision?.reason, 'repeated-identical-failure')
  assert.match(String(decision?.feedback), /curl|same tool call/)
  assert.match(String(decision?.feedback), /3 times/)
})

test('an ordinary conclusion is accepted, and a limitation claim is tested once', () => {
  const supervisor = new AgentSupervisor()
  for (const id of ['a', 'b']) {
    supervisor.observe(called(id, 'bash', { command: `pnpm test ${id}` }))
    supervisor.observe(ended(id, 'bash'))
  }

  assert.deepEqual(supervisor.inspectCompletion(working('c', 'bash', '{}')), { action: 'accept' })
  assert.deepEqual(supervisor.inspectCompletion(concluding('The build passes and the tests are green.')), { action: 'accept' })

  const verdict = supervisor.inspectCompletion(concluding('Search quality cannot be improved further: the remaining failures come from the search provider API.'))
  assert.equal(verdict.action, 'challenge')
  assert.match(verdict.action === 'challenge' ? verdict.feedback : '', /falsify/)

  // One challenge per run, whatever the model concludes next.
  assert.deepEqual(supervisor.inspectCompletion(concluding('Nothing more can be done without a stronger model.')), { action: 'accept' })
})

test('a challenge is only worth making to a run that has done real work', () => {
  const supervisor = new AgentSupervisor()
  supervisor.observe(called('a', 'bash', { command: 'pnpm test' }))
  assert.deepEqual(supervisor.inspectCompletion(concluding('This limitation cannot be improved further.')), { action: 'accept' })
})

test('the challenge asks the run to test its conclusion, in the run language', () => {
  const supervisor = new AgentSupervisor({ language: 'zh-CN' })
  for (const id of ['a', 'b']) {
    supervisor.observe(called(id, 'bash', { command: `pnpm bench ${id}` }))
    supervisor.observe(ended(id, 'bash'))
  }
  const verdict = supervisor.inspectCompletion(concluding('搜索结果已经接近极限，剩余问题来自搜索接口的限制，没有 API key 无法继续优化。'))
  assert.equal(verdict.action, 'challenge')
  assert.match(verdict.action === 'challenge' ? verdict.feedback : '', /证伪/)
  assert.match(String(supervisor.finish().challengeReason), /接近极限|限制/)
})

test('limitation claims are recognized across the phrasings and languages models actually use', () => {
  for (const claim of [
    'The remainder is a base model limitation.',
    'We are near the limit of what this approach can do.',
    'This needs a better model to go further.',
    'Without an API key this cannot be improved.',
    'Further optimization would provide little benefit.',
    'Nothing more can be done here.',
    'The failures are caused by the search provider, not by us.',
    'Digging deeper would hit diminishing returns.',
  ]) assert.ok(limitationClaim(claim), claim)
  for (const clean of [
    'The build succeeds and all 42 tests pass.',
    'I changed the parser and re-ran the suite; two failures remain, both in the date handling path.',
    '删除了重复的样式，测试全部通过。',
  ]) assert.equal(limitationClaim(clean), undefined, clean)
})

test('a challenge that resumes work is productive, and one that holds is a confirmed limit', () => {
  const productive = new AgentSupervisor()
  for (const id of ['a', 'b']) {
    productive.observe(called(id, 'bash', { command: `pnpm test ${id}` }))
    productive.observe(ended(id, 'bash'))
  }
  productive.inspectCompletion(concluding('Nothing more can be done with these tools.'))
  productive.observe(called('c', 'bash', { command: 'pnpm test --case 3' }))
  productive.observe(ended('c', 'bash'))
  const resumed = productive.finish()
  assert.equal(resumed.challengeOutcome, 'productive')
  assert.equal(resumed.supervisorChallenges, 1)

  const held = new AgentSupervisor()
  for (const id of ['a', 'b']) {
    held.observe(called(id, 'bash', { command: `pnpm test ${id}` }))
    held.observe(ended(id, 'bash'))
  }
  held.inspectCompletion(concluding('Nothing more can be done with these tools.'))
  held.inspectCompletion(concluding('The private data is unavailable without an authenticated API key.'))
  assert.equal(held.finish().challengeOutcome, 'confirmed_limit')
})

test('a healthy run reports what it did and nothing else', () => {
  const supervisor = new AgentSupervisor()
  supervisor.observe(called('a', 'write', { path: 'a.ts', content: 'x' }))
  supervisor.observe(ended('a', 'write'))
  supervisor.observe(event({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'stop',
      usage: { input: 1_000, output: 50, cacheRead: 180_000, cacheWrite: 0, totalTokens: 181_050, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  }))
  supervisor.observe(event({ type: 'compaction_end', reason: 'threshold', result: undefined, aborted: false, willRetry: false }))

  const telemetry = supervisor.finish()
  assert.equal(telemetry.peakContextTokens, 181_000)
  assert.equal(telemetry.providerCalls, 1)
  assert.equal(telemetry.compactionCount, 1)
  assert.equal(telemetry.totalToolCalls, 1)
  assert.equal(telemetry.finalStopReason, 'stop')
  assert.equal(telemetry.supervisorChallenges, 0)
  assert.equal(telemetry.degenerationSteers, 0)
  assert.equal(telemetry.challengeOutcome, undefined)
  assert.equal(telemetry.recoveryOutcome, undefined)
  assert.ok(telemetry.durationMs >= 0)
  assert.equal(noteworthySupervisorRecord(telemetry), true)
})

test('a trivial run is not worth a telemetry record', () => {
  const supervisor = new AgentSupervisor()
  supervisor.observe(called('a', 'read', { path: 'a.ts' }))
  supervisor.observe(ended('a', 'read'))
  supervisor.observe(event({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: { input: 12_000, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 12_040, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }))
  const telemetry = supervisor.finish()
  assert.equal(telemetry.degenerationDetections, 0)
  assert.equal(telemetry.supervisorChallenges, 0)
  assert.equal(telemetry.compactionCount, 0)
  assert.equal(noteworthySupervisorRecord(telemetry), false)
})
