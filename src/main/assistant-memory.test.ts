import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssistantMemoryStore } from './assistant-memory.ts'

test('memory survives restart with provenance, supports scoped retrieval, replacement and forgetting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shun-memory-'))
  try {
    const path = join(dir, 'memory.json'), store = new AssistantMemoryStore(path)
    const [first] = await Promise.all([store.update('conversation-a', { text: 'Prefer concise Chinese replies' }), store.update('conversation-b', { text: 'Use blue for the website', scope: '/project' })])
    assert.equal((await store.list()).length, 2)
    assert.equal((await store.list('blue', 'personal')).length, 0)
    assert.equal((await store.list('blue', '/project'))[0].sourceTaskId, 'conversation-b')
    const restarted = new AssistantMemoryStore(path)
    assert.equal((await restarted.list('concise'))[0].sourceTaskId, 'conversation-a')
    const id = 'id' in first ? first.id : ''
    await restarted.update('conversation-c', { id, text: 'Prefer detailed Chinese replies' })
    assert.equal((await restarted.list('concise')).length, 0)
    assert.equal((await restarted.list('detailed'))[0].sourceTaskId, 'conversation-c')
    await restarted.update('conversation-c', { id, remove: true })
    assert.equal((await restarted.list()).length, 1)
    await assert.rejects(restarted.update('x', { id, text: 'gone' }), /not found/)
    await assert.rejects(restarted.update('x', { text: ' ' }), /1–2000/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('assistant results enter session context once through the extension hook', async () => {
  const { assistantContextExtension } = await import('./assistant-memory.ts')
  let hook: any
  const extension = assistantContextExtension({ personal: true, readUpdates: async () => [{ id: 'one', text: 'New result' }] })
  await extension({ on: (_event: string, handler: unknown) => { hook = handler } } as any)
  const first = await hook({ systemPrompt: 'Base' }, { sessionManager: { getEntries: () => [] } })
  assert.equal(first.message.customType, 'shun.assistant.updates')
  assert.deepEqual(first.message.details.ids, ['one'])
  assert.match(first.message.content, /New result/)
  const second = await hook({ systemPrompt: 'Base' }, { sessionManager: { getEntries: () => [{ type: 'custom_message', ...first.message }] } })
  assert.equal(second.message, undefined)
  assert.ok(second.systemPrompt.startsWith('Base'))
})

test('assistant behavior is scoped to the configured personal session', async () => {
  const { assistantContextExtension } = await import('./assistant-memory.ts')
  let hook: any
  const register = { on: (_event: string, handler: unknown) => { hook = handler } } as any
  const context = { sessionManager: { getEntries: () => [] } }
  await assistantContextExtension({ personal: false, readUpdates: async () => [] })(register)
  assert.equal(await hook({ systemPrompt: 'Ordinary task' }, context), undefined)
  await assistantContextExtension({ personal: true, readUpdates: async () => [] })(register)
  const personal = await hook({ systemPrompt: 'Base' }, context)
  assert.match(personal.systemPrompt, /assistant_task_start BEFORE/)
  assert.match(personal.systemPrompt, /assistant_task_continue with the same taskId/)
  assert.match(personal.systemPrompt, /genuinely independent/)
  assert.match(personal.systemPrompt, /Results return automatically/)
  await assistantContextExtension({ personal: false, background: true, readUpdates: async () => [] })(register)
  const background = await hook({ systemPrompt: 'Base' }, context)
  assert.match(background.systemPrompt, /assistant_publish/)
  assert.doesNotMatch(background.systemPrompt, /assistant_task_start BEFORE/)
})

 test('monitor checkpoints keep a stable scope across independent runs', async () => {
  const { assistantContextExtension } = await import('./assistant-memory.ts')
  let hook: any
  const register = { on: (_event: string, handler: unknown) => { hook = handler } } as any
  await assistantContextExtension({ personal: false, background: true, monitorId: 'mail-watch', readUpdates: async () => [] })(register)
  const result = await hook({ systemPrompt: 'Base' }, {})
  assert.match(result.systemPrompt, /monitor:mail-watch/)
  assert.match(result.systemPrompt, /Never advance the checkpoint after a failed or incomplete read/)
  assert.match(result.systemPrompt, /first check establish a baseline/)
})

test('delegated handoff uses only the terminal answer, never streamed progress or tool narration', async () => {
  const { assistantContextExtension } = await import('./assistant-memory.ts')
  const hooks = new Map<string, any>(), results: string[] = []
  await assistantContextExtension({ personal: false, onResult: text => results.push(text), readUpdates: async () => [] })({ on: (name: string, fn: unknown) => hooks.set(name, fn) } as any)
  const answer = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Both registrations completed. https://example.com/result' }] }
  await hooks.get('agent_end')({ messages: [
    { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'First I will read the preferences.' }, { type: 'toolCall', name: 'read' }] },
    { role: 'toolResult', content: [{ type: 'text', text: 'Private execution detail' }] }, answer,
  ] })
  assert.deepEqual(results, ['Both registrations completed. https://example.com/result'])
  const policy = await hooks.get('before_agent_start')({ systemPrompt: 'Base' }, {})
  assert.match(policy.systemPrompt, /essential deliverable links/)
  assert.match(policy.systemPrompt, /Do not repeat progress messages/)
  await hooks.get('agent_end')({ messages: [answer, { role: 'toolResult', content: [] }] })
  assert.equal(results.at(-1), '')
  await hooks.get('agent_end')({ messages: [{ ...answer, stopReason: 'aborted' }] })
  assert.equal(results.at(-1), '')
})


test('memory pages filter monitoring records before limiting and can reach beyond 100 entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shun-memory-pages-'))
  try {
    const file = join(dir, 'memory.json')
    const items = Array.from({ length: 240 }, (_, i) => ({ id: String(i), text: 'fact', scope: i < 120 ? 'monitor:mail' : 'personal', sourceTaskId: 'a', updatedAt: 240 - i }))
    await writeFile(file, JSON.stringify(items))
    const store = new AssistantMemoryStore(file)
    const page = await store.list('', undefined, { excludeMonitor: true, limit: 126 })
    assert.equal(page.length, 120)
    assert.equal(page[0].id, '120')
    assert.equal(page.at(-1)?.id, '239')
    assert.equal((await store.list()).length, 100)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
