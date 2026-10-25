import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { agentThinkingLevel, branchPastCrossModelThinkingAbort, compactAgentSession, configureManualCompaction, estimateContextBreakdown, isMcpBridgeTool, redactTaskRoot, removeAgentSessions, resolveAgentProviderConnection, runAgentSession, searchPluginTools, toolSearchMissMessage, utilityThinkingLevel, type DeferredTool } from './agent-runtime.ts'
import { contextAfterCompaction } from '../shared.ts'
import { AgentSupervisor } from './agent-supervisor.ts'
import { completeProviderResponse } from './provider-response.ts'
import type { OutcomePolicy } from './outcome-policy.ts'
import { createShellTool } from './shell-tool.ts'
import { productToolNamesToDefer } from './capabilities.ts'
import { createLookupDeliveryExtension } from './web-lookup-delivery.ts'
import { CONFIG_DIR_NAME, DefaultResourceLoader, SessionManager, SettingsManager, defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { AgentEvent, AgentRequest, Settings } from '../shared.ts'

function settings(endpoint: string, workspace = '', model = 'test-model'): Settings {
  return {
    endpoint, apiKey: '', providerId: 'test-provider',
    providers: [{ id: 'test-provider', name: model.includes('deepseek') ? 'DeepSeek' : 'Test', kind: 'custom', endpoint, apiKey: '', contextWindow: 32_768 }],
    model, workspace, temperature: 0, maxTokens: 2048, contextWindow: 32_768,
    autoCompact: true,
  }
}

test('utility prompts use the lowest thinking level supported by reasoning models', () => {
  assert.equal(utilityThinkingLevel({ reasoning: true }), 'low')
  assert.equal(utilityThinkingLevel({ reasoning: false }), 'off')
})

test('a research context thinks as hard as the session does, not as cheaply as a utility prompt', () => {
  // Effort is the dominant performance term on retrieval work, and a fan-out's lines are that
  // work done in parallel: handing them the utility effort is asking each of them worse.
  assert.equal(agentThinkingLevel({ reasoning: true }), 'medium')
  assert.equal(agentThinkingLevel({ reasoning: false }), 'off')
  assert.notEqual(agentThinkingLevel({ reasoning: true }), utilityThinkingLevel({ reasoning: true }))
  for (const effort of ['low', 'medium', 'high'] as const) {
    assert.equal(agentThinkingLevel({ reasoning: true }, effort), effort)
    assert.equal(agentThinkingLevel({ reasoning: false }, effort), 'off')
  }
})

test('a new model branches past a thinking-only aborted assistant without deleting it', () => {
  const manager = SessionManager.inMemory('/tmp/shun-cross-model-abort')
  manager.appendModelChange('provider-old', 'model-old')
  const userId = manager.appendMessage({ role: 'user', content: 'Replace the document.', timestamp: Date.now() })
  const abortedId = manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'I will inspect and replace the document.' }],
    api: 'openai-completions', provider: 'provider-old', model: 'model-old',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'aborted', timestamp: Date.now(),
  })

  assert.equal(branchPastCrossModelThinkingAbort(manager, { provider: 'provider-new', id: 'model-new' }), true)
  assert.equal(manager.getLeafId(), userId)
  assert.equal(manager.getEntry(abortedId)?.id, abortedId)
  assert.deepEqual(manager.buildSessionContext().messages.map(message => message.role), ['user'])
})

test('cross-model recovery preserves aborted visible output and same-model hidden thinking', () => {
  const visible = SessionManager.inMemory('/tmp/shun-visible-abort')
  visible.appendMessage({ role: 'user', content: 'Change it.', timestamp: Date.now() })
  const visibleId = visible.appendMessage({
    role: 'assistant', content: [{ type: 'text', text: 'Starting the change.' }],
    api: 'openai-completions', provider: 'provider-old', model: 'model-old',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'aborted', timestamp: Date.now(),
  })
  assert.equal(branchPastCrossModelThinkingAbort(visible, { provider: 'provider-new', id: 'model-new' }), false)
  assert.equal(visible.getLeafId(), visibleId)

  const sameModel = SessionManager.inMemory('/tmp/shun-same-model-abort')
  sameModel.appendMessage({ role: 'user', content: 'Change it.', timestamp: Date.now() })
  const thinkingId = sameModel.appendMessage({
    role: 'assistant', content: [{ type: 'thinking', thinking: 'Working.' }],
    api: 'openai-completions', provider: 'provider-current', model: 'model-current',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'aborted', timestamp: Date.now(),
  })
  assert.equal(branchPastCrossModelThinkingAbort(sameModel, { provider: 'provider-current', id: 'model-current' }), false)
  assert.equal(sameModel.getLeafId(), thinkingId)
})

test('explicit compaction can summarize low-usage sessions without changing automatic defaults', () => {
  const manager = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 4_096, keepRecentTokens: 20_000 } })
  configureManualCompaction(manager)
  assert.deepEqual(manager.getCompactionSettings(), { enabled: true, reserveTokens: 4_096, keepRecentTokens: 1 })

  const automatic = SettingsManager.inMemory()
  assert.deepEqual(automatic.getCompactionSettings(), { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 })
})

test('explicit compaction summarizes a short completed conversation', async () => {
  let responseNumber = 0
  const server = await withServer((body, res) => sse(res, textResponse(body.model, responseNumber++ ? 'Compact summary' : 'Initial answer')))
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-manual-compact-'))
  const taskId = crypto.randomUUID(), agentDir = join(root, 'agent'), sessionDir = join(root, 'sessions')
  const request: AgentRequest = { id: crypto.randomUUID(), taskId, text: 'Short request', history: [], settings: settings(server.endpoint) }
  try {
    await runAgentSession(request, new AbortController().signal, () => {}, { agentDir, sessionDir, activeTools: [] })
    const compaction = await compactAgentSession({ ...request, id: crypto.randomUUID(), text: '' }, { agentDir, sessionDir })
    assert.match(compaction.summary, /Compact summary/)
    // Explicit compaction reports the summarized message tokens, because the
    // renderer has to replace the reading it already shows.
    assert.ok(compaction.tokensBefore > 0)
    assert.ok(compaction.tokensAfter >= 0)
    assert.equal(server.bodies.length, 2)
  } finally { await server.close() }
})

test('a compacted context replaces the previous reading with the summarized delta', () => {
  const previous = {
    state: 'ready' as const,
    usedCharacters: 120_000,
    budgetCharacters: 600_000,
    usedTokens: 40_000,
    budgetTokens: 200_000,
    exactTokens: true,
    breakdown: { systemTokens: 4_000, toolTokens: 6_000, mcpTokens: 200, conversationTokens: 29_800, estimated: true as const },
  }
  const compacted = contextAfterCompaction(previous, { tokensBefore: 30_000, tokensAfter: 5_000 })
  assert.equal(compacted?.state, 'compacted')
  assert.equal(compacted?.usedTokens, 15_000)
  assert.equal(compacted?.usedCharacters, 45_000)
  assert.equal(compacted?.exactTokens, false)
  // Fixed prompt and tool schemas survive; only conversation data shrinks.
  assert.equal(compacted?.breakdown?.systemTokens, 4_000)
  assert.equal(compacted?.breakdown?.toolTokens, 6_000)
  assert.equal(compacted?.breakdown?.conversationTokens, 4_800)

  assert.equal(contextAfterCompaction(undefined, { tokensBefore: 30_000, tokensAfter: 5_000 }), undefined)
  assert.equal(contextAfterCompaction(previous, { tokensBefore: 0, tokensAfter: 5_000 }), undefined)
  assert.equal(contextAfterCompaction(previous, { tokensBefore: 30_000, tokensAfter: Number.NaN }), undefined)
  assert.equal(contextAfterCompaction(previous, { tokensBefore: 40_000, tokensAfter: 0 })?.usedTokens, 0)
})

test('the MCP bridge stays in the breakdown while its schemas are deferred', () => {
  const bridge = { name: 'mcp_list', description: 'List configured MCP servers.', parameters: { type: 'object' } }
  const deferred = estimateContextBreakdown(10_000, 'System instructions', [bridge])
  assert.ok(deferred.mcpTokens > 0)
  assert.equal(deferred.systemTokens + deferred.toolTokens + deferred.mcpTokens + deferred.conversationTokens, 10_000)
  assert.equal(isMcpBridgeTool('mcp_list'), true)
  assert.equal(isMcpBridgeTool('mcp_call'), true)
  assert.equal(isMcpBridgeTool('read'), false)
})

test('context breakdown separates active MCP bridge schemas and preserves the provider total', () => {
  const breakdown = estimateContextBreakdown(1_000, 'System instructions', [
    { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
    { name: 'mcp_list', description: 'Discover MCP tools', parameters: { type: 'object' } },
    { name: 'mcp_call', description: 'Call an MCP tool', parameters: { type: 'object' } },
  ])
  assert.ok(breakdown.systemTokens > 0)
  assert.ok(breakdown.toolTokens > 0)
  assert.ok(breakdown.mcpTokens > 0)
  assert.equal(breakdown.systemTokens + breakdown.toolTokens + breakdown.mcpTokens + breakdown.conversationTokens, 1_000)
  assert.equal(breakdown.estimated, true)
})

test('runtime provider registration normalizes native Google and Azure API roots', () => {
  const google: AgentRequest = { id: 'google', text: 'hi', history: [], settings: settings('https://generativelanguage.googleapis.com') }
  google.settings.providers[0].api = 'google-generative-ai'
  assert.deepEqual(resolveAgentProviderConnection(google), {
    api: 'google-generative-ai', endpoint: 'https://generativelanguage.googleapis.com/v1beta',
  })
  google.settings.endpoint = 'https://generativelanguage.googleapis.com/v1beta/'
  assert.equal(resolveAgentProviderConnection(google).endpoint, 'https://generativelanguage.googleapis.com/v1beta')

  const azure: AgentRequest = { id: 'azure', text: 'hi', history: [], settings: settings('https://example.openai.azure.com/openai') }
  azure.settings.providers[0].api = 'azure-openai-responses'
  assert.deepEqual(resolveAgentProviderConnection(azure), {
    api: 'azure-openai-responses', endpoint: 'https://example.openai.azure.com/openai/v1',
  })
})

test('automatic compaction reports the summarized delta instead of the stale total', async () => {
  // Long messages are what make the summarization boundary cut at all.
  const filler = 'The task keeps a long evidence trail. '.repeat(1_500)
  const server = await withServer((body, res) => sse(res, longTextResponse(body.model, filler)))
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-auto-compact-'))
  const taskId = crypto.randomUUID(), events: AgentEvent[] = []
  const common = { agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: [] }
  try {
    for (const text of ['first', 'second', 'third']) {
      await runAgentSession(
        { id: crypto.randomUUID(), taskId, text, history: [], settings: settings(server.endpoint) },
        new AbortController().signal,
        event => events.push(event),
        common,
      )
    }
    const contexts = events.flatMap(event => event.type === 'context' && event.context ? [event.context] : [])
    const compacting = contexts.filter(context => context.state === 'compacting').at(-1)
    const compacted = contexts.filter(context => context.state === 'compacted').at(-1)
    assert.ok(compacting && compacted, 'automatic compaction should report both states')
    assert.ok(compacted.usedTokens! > 0, 'a compacted reading must not collapse to zero')
    assert.ok(compacted.usedTokens! < compacting.usedTokens!, 'a compacted reading must shrink')
    assert.equal(compacted.exactTokens, false)
  } finally { await server.close() }
})

test('cancellation stops an in-flight automatic compaction and never resumes tools or emits done', { timeout: 10_000 }, async () => {
  const filler = 'The task keeps a long evidence trail. '.repeat(1_500)
  const controller = new AbortController()
  const events: AgentEvent[] = []
  let compacting = false, cancelledCompactions = 0, toolCalls = 0
  const server = await withServer((body, res) => {
    if (!compacting) { sse(res, longTextResponse(body.model, filler)); return }
    cancelledCompactions++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 'compacting', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`)
    setTimeout(() => controller.abort(), 10)
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-compact-cancel-'))
  const taskId = crypto.randomUUID()
  const common = {
    agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: [],
    beforeToolCall: async () => { toolCalls++; return undefined },
  }
  try {
    let cancelled = false
    for (const text of ['first', 'second', 'third']) {
      try {
        await runAgentSession({ id: crypto.randomUUID(), taskId, text, history: [], settings: settings(server.endpoint) }, controller.signal, event => {
          events.push(event)
          if (event.type === 'context' && event.context?.state === 'compacting') compacting = true
        }, common)
      } catch (error) {
        assert.ok(error instanceof Error && error.name === 'AbortError')
        cancelled = true
        break
      }
    }
    assert.equal(cancelled, true)
    assert.equal(cancelledCompactions, 1)
    assert.equal(toolCalls, 0)
    const compactionStart = events.findIndex(event => event.type === 'context' && event.context?.state === 'compacting')
    assert.ok(compactionStart >= 0)
    assert.equal(events.slice(compactionStart).some(event => event.type === 'done'), false)
    assert.equal(events.slice(compactionStart).some(event => event.type === 'compacted'), false, 'a cancelled summary must not be presented as completed compaction')
    const before = events[compactionStart].context!
    const after = events.flatMap(event => event.type === 'context' && event.context ? [event.context] : []).at(-1)!
    assert.equal(after.state, 'ready')
    assert.equal(after.usedTokens, before.usedTokens, 'unsummarized history keeps its original context reading')
  } finally { server.closeAllConnections?.(); await server.close() }
})

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sse(res: ServerResponse, chunks: any[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.end('data: [DONE]\n\n')
}

async function withServer(handler: (body: any, res: ServerResponse) => void | Promise<void>) {
  const bodies: any[] = []
  const server = createServer(async (req, res) => {
    try {
      const body = await readJson(req)
      bodies.push(body)
      await handler(body, res)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(error instanceof Error ? error.message : String(error))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Missing test server address')
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    bodies,
    closeAllConnections: () => server.closeAllConnections(),
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

function textResponse(model: string, text: string) {
  const base = { id: crypto.randomUUID(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ]
}

test('configured reasoning effort reaches the provider on each run', async () => {
  const server = await withServer((body, res) => sse(res, textResponse(body.model, 'done')))
  const root = await mkdtemp(join(tmpdir(), 'shun-reasoning-effort-'))
  const configured = settings(server.endpoint, root, 'deepseek-v4.1-flash-local')
  configured.providers[0].models = [{ id: configured.model, contextWindow: 32_768, maxOutputTokens: 2048, reasoning: true }]
  const taskId = crypto.randomUUID()
  try {
    for (const reasoningEffort of ['low', 'high'] as const) {
      await runAgentSession({ id: crypto.randomUUID(), taskId, text: 'Continue.', history: [], settings: { ...configured, reasoningEffort } }, new AbortController().signal, () => {}, {
        cwd: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: [],
      })
    }
    assert.deepEqual(server.bodies.map(body => body.reasoning_effort), ['low', 'high'])
    assert.deepEqual(server.bodies.map(body => body.thinking), [{ type: 'enabled' }, { type: 'enabled' }])
  } finally { await server.close() }
})

test('explicitly disabled reasoning overrides endpoint defaults while undeclared reasoning leaves them intact', async () => {
  const server = await withServer((body, res) => sse(res, textResponse(body.model, 'done')))
  const root = await mkdtemp(join(tmpdir(), 'shun-disabled-reasoning-'))
  const configured = settings(server.endpoint, root, 'deepseek-v4.1-flash-local')
  try {
    for (const reasoning of [undefined, false]) {
      configured.providers[0].models = [{ id: configured.model, contextWindow: 32_768, maxOutputTokens: 2048, reasoning }]
      await runAgentSession({ id: crypto.randomUUID(), text: 'Continue.', history: [], settings: configured }, new AbortController().signal, () => {}, {
        cwd: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: [],
      })
    }
    assert.deepEqual(server.bodies.map(body => body.thinking), [undefined, { type: 'disabled' }])
    assert.ok(server.bodies.every(body => !('reasoning_effort' in body)))
  } finally { await server.close() }
})

test('installing project tooling between runs preserves the provider prompt prefix', async () => {
  const server = await withServer((body, res) => sse(res, textResponse(body.model, 'done')))
  const root = await mkdtemp(join(tmpdir(), 'shun-tooling-prefix-'))
  const configured = settings(server.endpoint, root, 'deepseek-v4.1-flash-local')
  const taskId = crypto.randomUUID()
  const run = () => runAgentSession({ id: crypto.randomUUID(), taskId, text: 'Continue.', history: [], settings: configured }, new AbortController().signal, () => {}, {
    cwd: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['bash'], customTools: [createShellTool(root)],
  })
  try {
    await run()
    await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
    await run()
    const [before, after] = server.bodies
    assert.deepEqual(after.tools, before.tools, 'project installation must not rewrite tool schemas ahead of conversation history')
    assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages)
    assert.equal(after.messages.at(-1).role, 'user')
    assert.equal(after.messages.length, before.messages.length + 2)
  } finally { await server.close() }
})

test('text, screenshot, and text follow-ups keep the same provider tools across runs', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  const server = await withServer((body, res) => sse(res, textResponse(body.model, 'done')))
  const root = await mkdtemp(join(tmpdir(), 'shun-attachment-prefix-'))
  const taskId = crypto.randomUUID()
  const customTools = ['attachment_list', 'attachment_read'].map(name => defineTool({
    name, label: name, description: 'Read task-owned attachments.', parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'attachment' }], details: {} }),
  }))
  try {
    for (const image of [false, true, false]) {
      const names = new Set(productToolNamesToDefer(customTools.map(tool => tool.name)))
      await runAgentSession({ id: crypto.randomUUID(), taskId, text: 'Continue.', history: [], settings: settings(server.endpoint, root) }, new AbortController().signal, () => {}, {
        cwd: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), customTools,
        activeTools: customTools.filter(tool => !names.has(tool.name)).map(tool => tool.name),
        deferredTools: customTools.filter(tool => names.has(tool.name)).map(tool => ({ ownerId: 'shun-product', ownerName: 'Shun', tool })),
        enableExtensionTools: true,
        initialImages: image ? [{ type: 'image', mimeType: 'image/png', data: png }] : [],
      })
    }
    const [first, image, last] = server.bodies
    assert.deepEqual(image.tools, first.tools)
    assert.deepEqual(last.tools, first.tools)
    assert.deepEqual(image.messages.slice(0, first.messages.length), first.messages)
    assert.deepEqual(last.messages.slice(0, image.messages.length), image.messages)
    assert.match(JSON.stringify(image.messages.at(-1)), /data:image\/png;base64/)
  } finally { await server.close() }
})

function longTextResponse(model: string, text: string) {
  const base = { id: crypto.randomUUID(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30_000, completion_tokens: 2, total_tokens: 30_002 } },
  ]
}

function toolResponse(model: string, name: string, args: string, finishReason = 'tool_calls') {
  const base = { id: crypto.randomUUID(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name, arguments: args } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]
}

test('terminal event completion lets a tool run and its follow-up answer finish without HTTP EOF', async t => {
  const originalFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    completeProviderResponse(await originalFetch(input, init)))
  let requests = 0, executions = 0
  const server = await withServer((body, res) => {
    requests++
    const chunks = requests === 1
      ? toolResponse(body.model, 'inspect_system', '{}')
      : textResponse(body.model, 'Open Remote Login in Sharing.')
    if (requests === 2) assert.ok(body.messages.some((message: any) => message.role === 'tool' && JSON.stringify(message.content).includes('platform=darwin')))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.write('data: [DONE]\n\n')
    // Keep the HTTP body open, reproducing the native reader's missing EOF.
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-tool-stream-completion-'))
  const events: AgentEvent[] = []
  const inspectSystem = defineTool({
    name: 'inspect_system', label: 'Inspect system', description: 'Read the operating system.', parameters: Type.Object({}),
    execute: async () => { executions++; return { content: [{ type: 'text' as const, text: 'platform=darwin' }], details: {} } },
  })
  try {
    await runAgentSession({ id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'How do I enable remote login on this computer?', history: [], settings: settings(server.endpoint) }, AbortSignal.timeout(5_000), event => events.push(event), {
      cwd: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['inspect_system'], customTools: [inspectSystem],
    })
    assert.equal(requests, 2)
    assert.equal(executions, 1)
    assert.equal(events.filter(event => event.type === 'done').length, 1)
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Open Remote Login in Sharing.')
    const toolDone = events.findIndex(event => event.type === 'tool' && event.tool?.state === 'done')
    assert.ok(toolDone >= 0 && toolDone < events.findIndex(event => event.type === 'delta'))
    assert.equal(events.at(-1)?.type, 'done')
  } finally {
    server.closeAllConnections()
    await server.close()
  }
})

test('all Shun turns resume their exact persisted transcript without loading the global session catalog', async t => {
  t.mock.method(SessionManager, 'listAll', () => { throw Error('Unrelated task histories must not be loaded to open one task') })
  let responseNumber = 0
  const server = await withServer((body, res) => sse(res, textResponse(body.model, responseNumber++ ? 'two' : 'one')))
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-runtime-'))
  const taskId = crypto.randomUUID(), events: AgentEvent[] = []
  const common = { agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: [] }
  try {
    const first: AgentRequest = { id: crypto.randomUUID(), taskId, text: 'first', history: [], settings: settings(server.endpoint) }
    await runAgentSession(first, new AbortController().signal, event => events.push(event), common)
    const second: AgentRequest = { ...first, id: crypto.randomUUID(), text: 'second', history: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'one' }], settings: settings(server.endpoint, '', 'test-model-2') }
    await runAgentSession(second, new AbortController().signal, event => events.push(event), common)
    assert.equal(events.filter(event => event.type === 'done').length, 2)
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'onetwo')
    assert.equal(server.bodies.length, 2)
    assert.equal(server.bodies[1].model, 'test-model-2')
    const content = (message: any) => Array.isArray(message.content) ? message.content.map((item: any) => item.text || '').join('') : message.content
    assert.deepEqual(server.bodies[1].messages.slice(-3).map((message: any) => [message.role, content(message)]), [
      ['user', 'first'], ['assistant', 'one'], ['user', 'second'],
    ])
    const sessionFiles = await import('node:fs/promises').then(fs => fs.readdir(common.sessionDir))
    const transcript = await readFile(join(common.sessionDir, sessionFiles[0]), 'utf8')
    assert.match(transcript, /"parentId"/)
    assert.match(transcript, /"text":"second"/)
    assert.match(transcript, /"modelId":"test-model-2"/)
    assert.equal(await removeAgentSessions(taskId, common.sessionDir), 1)
    assert.deepEqual(await readdir(common.sessionDir), [])
  } finally { await server.close() }
})

test('editing a message branches the persisted conversation before that message', async () => {
  let responseNumber = 0
  const responses = ['foundation answer', 'answer based on wrong wording', 'answer based on corrected wording']
  const server = await withServer((body, res) => sse(res, textResponse(body.model, responses[responseNumber++])))
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-branch-'))
  const taskId = crypto.randomUUID()
  const common = { agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: [] }
  try {
    const first: AgentRequest = { id: crypto.randomUUID(), taskId, text: 'foundation', history: [], settings: settings(server.endpoint) }
    await runAgentSession(first, new AbortController().signal, () => {}, common)

    let parentBeforeWrong: string | null = null
    const wrong: AgentRequest = { ...first, id: crypto.randomUUID(), text: 'wrong wording' }
    await runAgentSession(wrong, new AbortController().signal, () => {}, {
      ...common,
      beforePrompt: context => { parentBeforeWrong = context.parentEntryId; return Promise.resolve() },
    })
    assert.ok(parentBeforeWrong)

    let parentBeforeCorrection: string | null = null
    const corrected: AgentRequest = { ...first, id: crypto.randomUUID(), text: 'corrected wording' }
    await runAgentSession(corrected, new AbortController().signal, () => {}, {
      ...common,
      branchFrom: { entryId: parentBeforeWrong },
      beforePrompt: context => { parentBeforeCorrection = context.parentEntryId; return Promise.resolve() },
    })

    assert.equal(parentBeforeCorrection, parentBeforeWrong)
    const content = (message: any) => Array.isArray(message.content) ? message.content.map((item: any) => item.text || '').join('') : message.content
    const messages = server.bodies[2].messages.map((message: any) => [message.role, content(message)])
    assert.deepEqual(messages.slice(-3), [
      ['user', 'foundation'],
      ['assistant', 'foundation answer'],
      ['user', 'corrected wording'],
    ])
    assert.equal(JSON.stringify(messages).includes('wrong wording'), false)
  } finally { await server.close() }
})

test('an image-only message is sent directly to the provider without inventing visible prompt text', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  const server = await withServer((body, res) => {
    const user = body.messages.findLast((message: any) => message.role === 'user')
    const content = JSON.stringify(user?.content)
    assert.match(content, /data:image\/png;base64/)
    assert.doesNotMatch(content, /Please inspect and process these attachments/)
    sse(res, textResponse(body.model, 'visible'))
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-image-'))
  try {
    const taskId = crypto.randomUUID()
    const req: AgentRequest = {
      id: crypto.randomUUID(), taskId, text: '', history: [], settings: settings(server.endpoint),
      attachments: [{ id: 'image_1', taskId, name: 'image.png', mimeType: 'image/png', kind: 'image', size: 68, sha256: 'hash', createdAt: 1, capabilities: { vision: true } }],
    }
    await runAgentSession(req, new AbortController().signal, () => {}, {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: [],
      initialImages: [{ type: 'image', mimeType: 'image/png', data: png }],
    })
    assert.equal(server.bodies.length, 1)
  } finally { await server.close() }
})

test('a screenshot returned by a tool can reach the model after a text-only prompt', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  let requestNumber = 0
  const server = await withServer((body, res) => {
    if (requestNumber++ === 0) {
      sse(res, toolResponse(body.model, 'screenshot_tool', '{}'))
      return
    }
    assert.match(JSON.stringify(body.messages), /data:image\/png;base64/)
    sse(res, textResponse(body.model, 'I can see the tool screenshot.'))
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-tool-image-'))
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'inspect the page', history: [], settings: settings(server.endpoint) }
    const events: AgentEvent[] = []
    const screenshotTool = defineTool({
      name: 'screenshot_tool', label: 'Screenshot', description: 'Return a screenshot.', parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text' as const, text: 'Screenshot captured.' }, { type: 'image' as const, mimeType: 'image/png', data: png }], details: {} }),
    })
    await runAgentSession(req, new AbortController().signal, event => events.push(event), {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['screenshot_tool'], customTools: [screenshotTool],
      materializeToolResultImages: async result => {
        assert.equal(result.toolName, 'screenshot_tool')
        assert.deepEqual(result.images, [{ mimeType: 'image/png', data: png }])
        return [{ id: 'captured_image', taskId: req.taskId!, name: 'Screenshot.png', mimeType: 'image/png', kind: 'image', size: 68, sha256: 'hash', createdAt: 1, capabilities: { vision: true } }]
      },
    })
    assert.equal(server.bodies.length, 2)
    assert.equal(events.find(event => event.type === 'tool' && event.tool?.state === 'done')?.tool?.attachments?.[0]?.id, 'captured_image')
  } finally { await server.close() }
})

test('a current-price question is sent through the agent runtime with stable web capabilities', async () => {
  let requests = 0
  const server = await withServer((body, res) => {
    requests++
    const names = (body.tools || []).map((tool: any) => tool.function?.name)
    assert.equal(names.includes('web_search'), true)
    assert.equal(names.includes('web_read'), true)
    const system = body.messages.find((message: any) => message.role === 'system')?.content || ''
    assert.match(String(system), /You are Shun/)
    assert.match(String(system), /test-model/)
    assert.match(String(system), /Verify changing claims.*web_search.*web_read/i)
    sse(res, textResponse(body.model, 'checked'))
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-current-price-'))
  const customTools = ['web_search', 'web_read'].map(name => defineTool({
    name, label: name, description: name, parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
  }))
  try {
    const taskId = crypto.randomUUID()
    const options = {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), customTools, activeTools: customTools.map(tool => tool.name),
    }
    const greeting: AgentRequest = { id: crypto.randomUUID(), taskId, text: 'hi', history: [], settings: settings(server.endpoint) }
    await runAgentSession(greeting, new AbortController().signal, () => {}, options)
    const price: AgentRequest = { ...greeting, id: crypto.randomUUID(), text: '现在 DGX Spark 的国内价格是多少', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'checked' }] }
    await runAgentSession(price, new AbortController().signal, () => {}, options)
    assert.equal(requests, 2)
  } finally { await server.close() }
})

test('local Agent Skills use progressive disclosure and Shun enablement', async () => {
  const server = await withServer((body, res) => sse(res, textResponse(body.model, 'ok')))
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-skills-'))
  const agentDir = join(root, 'agent')
  await mkdir(join(agentDir, 'skills', 'design-review'), { recursive: true })
  await writeFile(join(agentDir, 'skills', 'design-review', 'SKILL.md'), '---\nname: design-review\ndescription: Reviews design implementation when UI work is requested.\n---\n\n# Private workflow marker\n')
  try {
    const enabled: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'hello', history: [], settings: settings(server.endpoint) }
    await runAgentSession(enabled, new AbortController().signal, () => {}, { agentDir, sessionDir: join(root, 'sessions'), activeTools: ['read'] })
    const enabledSystem = String(server.bodies[0].messages.find((message: any) => message.role === 'system')?.content || '')
    assert.match(enabledSystem, /<name>design-review<\/name>/)
    assert.match(enabledSystem, /Reviews design implementation/)
    assert.doesNotMatch(enabledSystem, /Private workflow marker/)

    const disabled: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'hello again', history: [], settings: { ...settings(server.endpoint), skills: [{ id: 'skill:design-review', enabled: false }] } }
    await runAgentSession(disabled, new AbortController().signal, () => {}, { agentDir, sessionDir: join(root, 'sessions'), activeTools: ['read'] })
    const disabledSystem = String(server.bodies[1].messages.find((message: any) => message.role === 'system')?.content || '')
    assert.doesNotMatch(disabledSystem, /design-review/)
  } finally { await server.close() }
})

test('a product read definition overrides the built-in read through the public tool boundary', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    if (turn++ === 0) return sse(res, toolResponse(body.model, 'read', '{"path":"huge.log","mode":"overview"}'))
    const toolMessage = body.messages.findLast((message: any) => message.role === 'tool')
    assert.match(String(toolMessage?.content), /streamed overview/)
    sse(res, textResponse(body.model, 'done'))
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-read-override-')), workspace = join(root, 'workspace')
  await mkdir(workspace)
  const read = defineTool({
    name: 'read', label: 'Read', description: 'streaming read',
    parameters: Type.Object({ path: Type.String(), mode: Type.Optional(Type.String()) }),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'streamed overview' }], details: { streaming: true } }),
  })
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'inspect huge.log', history: [], settings: settings(server.endpoint, workspace) }
    await runAgentSession(req, new AbortController().signal, () => {}, {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['read'], customTools: [read],
    })
    assert.equal(turn, 2)
  } finally { await server.close() }
})

test('the stable Bash capability metadata reaches the model through the tool definition', async () => {
  const server = await withServer((body, res) => {
    const names = (body.tools || []).map((tool: any) => tool.function?.name)
    assert.equal(['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'].every(name => names.includes(name)), true)
    const bash = body.tools?.find((tool: any) => tool.function?.name === 'bash')
    assert.match(String(bash?.function?.description), /120-second timeout/)
    assert.match(String(bash?.function?.description), /inherited non-interactive environment/)
    assert.match(String(bash?.function?.description), /explicit project configuration for a local environment or tool manager/)
    assert.match(String(bash?.function?.description), /do not scan unrelated host paths/)
    assert.doesNotMatch(String(bash?.function?.description), /anonymous HTTP failure/i)
    sse(res, textResponse(body.model, 'ok'))
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-shell-metadata-')), workspace = join(root, 'workspace')
  await mkdir(workspace)
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'inspect the environment', history: [], settings: settings(server.endpoint, workspace) }
    await runAgentSession(req, new AbortController().signal, () => {}, {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'], customTools: [createShellTool(workspace)],
    })
  } finally { await server.close() }
})

test('tool execution preserves DeepSeek reasoning replay and writes through the workspace tool', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    const base = { id: crypto.randomUUID(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model }
    if (turn++ === 0) {
      sse(res, [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'inspect then write' }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'write', arguments: '{"path":"result.txt","content":"ok"}' } }] }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ])
    } else {
      const replay = body.messages.find((message: any) => message.role === 'assistant' && message.tool_calls)
      assert.equal(replay.reasoning_content, 'inspect then write')
      assert.equal(body.messages.at(-1).role, 'tool')
      sse(res, textResponse(body.model, 'completed'))
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-tool-'))
  const workspace = join(root, 'workspace')
  await import('node:fs/promises').then(fs => fs.mkdir(workspace))
  const events: AgentEvent[] = []
  try {
    const req: AgentRequest = {
      id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'write result.txt', history: [],
      settings: settings(server.endpoint, workspace, 'deepseek-v4-flash'),
    }
    await runAgentSession(req, new AbortController().signal, event => events.push(event), {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['write'],
    })
    assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'ok')
    assert.equal(events.some(event => event.type === 'tool' && event.tool?.name === 'write' && event.tool.state === 'done'), true)
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'completed')
    const running = events.findIndex(event => event.type === 'tool' && event.tool?.state === 'running')
    const finished = events.findIndex(event => event.type === 'tool' && event.tool?.state === 'done')
    const answer = events.findIndex(event => event.type === 'delta' && event.text === 'completed')
    const done = events.findIndex(event => event.type === 'done')
    assert.equal(running < finished && finished < answer && answer < done, true)
  } finally { await server.close() }
})

test('persisted tool sessions replay reasoning across user turns without shortening earlier evidence', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    const base = { id: crypto.randomUUID(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model }
    if (turn++ === 0) {
      sse(res, [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Check the installed source before changing the hypothesis.' }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'evidence-1', type: 'function', function: { name: 'read', arguments: '{"path":"evidence.txt"}' } }] }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ])
    } else {
      const replay = body.messages.find((message: any) => message.role === 'assistant' && message.tool_calls)
      assert.equal(replay.reasoning_content, 'Check the installed source before changing the hypothesis.')
      assert.equal(body.messages.find((message: any) => message.role === 'tool').content.includes('The observed value is 7, which contradicts the earlier estimate of 4.'), true)
      if (turn === 3) {
        assert.equal(body.messages.at(-1).role, 'user')
        assert.match(JSON.stringify(body.messages.at(-1).content), /Continue with the evidence\./)
        assert.equal(body.messages.find((message: any) => message.role === 'assistant' && message.content === 'Evidence retained.').reasoning_content, 'The first hypothesis was contradicted.')
      }
      sse(res, [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'The first hypothesis was contradicted.' }, finish_reason: null }] },
        ...textResponse(body.model, 'Evidence retained.'),
      ])
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-persisted-evidence-'))
  await writeFile(join(root, 'evidence.txt'), 'The observed value is 7, which contradicts the earlier estimate of 4.')
  const configured = settings(server.endpoint, root, 'deepseek-v4.1-flash-local')
  configured.providers[0].models = [{ id: configured.model, contextWindow: 32_768, maxOutputTokens: 2048, reasoning: true }]
  const taskId = crypto.randomUUID()
  try {
    for (const text of ['Inspect evidence.txt', 'Continue with the evidence.']) {
      await runAgentSession({ id: crypto.randomUUID(), taskId, text, history: [], settings: configured }, new AbortController().signal, () => {}, {
        cwd: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['read'],
      })
    }
    assert.equal(turn, 3)
  } finally { await server.close() }
})

test('direct execution runs Bash without a product approval gate or command classifier', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    if (turn++ === 0) sse(res, toolResponse(body.model, 'bash', '{"command":"rm -rf disposable"}'))
    else {
      assert.equal(body.messages.at(-1).role, 'tool')
      sse(res, textResponse(body.model, 'removed'))
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-full-access-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'disposable'), { recursive: true })
  await writeFile(join(workspace, 'disposable', 'file.txt'), 'temporary')
  try {
    const req: AgentRequest = {
      id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'remove disposable', history: [],
      settings: settings(server.endpoint, workspace),
    }
    await runAgentSession(req, new AbortController().signal, () => {}, {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['bash'],
    })
    await assert.rejects(readFile(join(workspace, 'disposable', 'file.txt'), 'utf8'))
  } finally { await server.close() }
})

test('a standalone task uses an internal cwd without claiming a selected workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-standalone-')), cwd = join(root, 'task-cwd')
  let turn = 0
  const server = await withServer((body, res) => {
    if (turn++ === 0) {
      const system = String(body.messages.find((message: any) => message.role === 'system')?.content || '')
      assert.match(system, /private task-owned storage.*complete project.*use it silently/i)
      assert.match(system, /Do not mention or expose its absolute path or internal layout/i)
      sse(res, toolResponse(body.model, 'write', JSON.stringify({ path: join(cwd, 'standalone.txt'), content: 'private cwd' })))
    }
    else sse(res, textResponse(body.model, 'written'))
  })
  await mkdir(cwd, { recursive: true })
  const events: AgentEvent[] = []
  try {
    const req: AgentRequest = {
      id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'write standalone.txt', history: [],
      settings: settings(server.endpoint),
    }
    assert.equal(req.settings.workspace, '')
    await runAgentSession(req, new AbortController().signal, event => events.push(event), {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), cwd, activeTools: ['write'],
    })
    assert.equal(await readFile(join(cwd, 'standalone.txt'), 'utf8'), 'private cwd')
    const visibleTools = events.filter(event => event.type === 'tool').map(event => event.tool!)
    assert.equal(visibleTools.length > 0, true)
    assert.equal(visibleTools.every(tool => !tool.input.includes(cwd) && !tool.output?.includes(cwd)), true)
    assert.match(visibleTools.at(-1)?.input || '', /\.\/standalone\.txt/)
  } finally { await server.close() }
})

test('task root redaction handles standalone and selected project paths across platforms', () => {
  assert.equal(redactTaskRoot('/Users/example/.shun/standalone/task/data.json', '/Users/example/.shun/standalone/task'), './data.json')
  assert.equal(redactTaskRoot('/Users/example/project/src/index.ts', '/Users/example/project'), './src/index.ts')
  assert.equal(redactTaskRoot('C:\\\\Users\\\\example\\\\project\\\\data.json', 'C:\\Users\\example\\project'), '.\\\\data.json')
  assert.equal(redactTaskRoot('/Users/example/project/data.json', ''), '/Users/example/project/data.json')
})

test('the runtime rejects a length-truncated tool call and continues without executing it', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    if (turn++ === 0) sse(res, toolResponse(body.model, 'write', '{"path":"truncated.txt","content":"partial"}', 'length'))
    else {
      assert.equal(body.messages.at(-1).role, 'tool')
      assert.match(String(body.messages.at(-1).content), /output token limit|truncat/i)
      sse(res, textResponse(body.model, 'recovered'))
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-truncated-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const events: AgentEvent[] = []
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'write safely', history: [], settings: settings(server.endpoint, workspace) }
    await runAgentSession(req, new AbortController().signal, event => events.push(event), {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['write'],
    })
    await assert.rejects(readFile(join(workspace, 'truncated.txt'), 'utf8'))
    assert.equal(events.some(event => event.type === 'tool' && event.tool?.state === 'error'), true)
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'recovered')
  } finally { await server.close() }
})

test('the runtime validates tool arguments and returns schema failures to the model', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    if (turn++ === 0) sse(res, toolResponse(body.model, 'write', '{"path":"invalid.txt"}'))
    else {
      assert.equal(body.messages.at(-1).role, 'tool')
      assert.match(String(body.messages.at(-1).content), /content|required|validation/i)
      sse(res, textResponse(body.model, 'invalid call handled'))
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-validation-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'write a file', history: [], settings: settings(server.endpoint, workspace) }
    await runAgentSession(req, new AbortController().signal, () => {}, {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['write'],
    })
    await assert.rejects(readFile(join(workspace, 'invalid.txt'), 'utf8'))
  } finally { await server.close() }
})

test('product beforeToolCall hook blocks execution and returns the failure to the model', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    if (turn++ === 0) sse(res, toolResponse(body.model, 'write', '{"path":"blocked.txt","content":"no"}'))
    else {
      assert.equal(body.messages.at(-1).role, 'tool')
      assert.match(String(body.messages.at(-1).content), /policy denied/i)
      sse(res, textResponse(body.model, 'blocked as expected'))
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-hook-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'try write', history: [], settings: settings(server.endpoint, workspace) }
    await runAgentSession(req, new AbortController().signal, () => {}, {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['write'],
      beforeToolCall: async () => ({ block: true, reason: 'policy denied' }),
    })
    await assert.rejects(readFile(join(workspace, 'blocked.txt'), 'utf8'))
  } finally { await server.close() }
})

test('global extension tools stay deferred while untrusted project extensions stay disabled', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    const names = (body.tools || []).map((tool: any) => tool.function?.name)
    assert.equal(names.includes('project_escape'), false)
    assert.equal(names.includes('global_hidden'), false)
    if (turn++ === 0) {
      assert.equal(names.includes('plugin_tool_search'), true)
      assert.equal(names.includes('global_echo'), false)
      sse(res, toolResponse(body.model, 'plugin_tool_search', '{"query":"global echo"}'))
    } else if (turn === 2) {
      assert.equal(names.includes('global_echo'), true)
      sse(res, toolResponse(body.model, 'global_echo', '{"value":"ok"}'))
    } else {
      assert.equal(body.messages.at(-1).role, 'tool')
      assert.match(String(body.messages.at(-1).content), /global:ok/)
      sse(res, textResponse(body.model, 'plugin completed'))
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-extension-'))
  const workspace = join(root, 'workspace')
  const agentDir = join(root, 'agent')
  await mkdir(join(agentDir, 'extensions'), { recursive: true })
  await mkdir(join(workspace, '.pi', 'extensions'), { recursive: true })
  const extension = (name: string, prefix: string) => `import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
export default function (api) { api.registerTool(defineTool({ name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)}, description: 'test', parameters: Type.Object({ value: Type.String() }), async execute(_id, args) { return { content: [{ type: 'text', text: ${JSON.stringify(prefix)} + args.value }], details: {} } } })) }`
  await writeFile(join(agentDir, 'extensions', 'global.ts'), extension('global_echo', 'global:'))
  await writeFile(join(agentDir, 'extensions', 'hidden.ts'), extension('global_hidden', 'hidden:'))
  await writeFile(join(workspace, '.pi', 'extensions', 'project.ts'), extension('project_escape', 'project:'))
  const events: AgentEvent[] = []
  try {
    const settingsManager = SettingsManager.create(workspace, agentDir)
    const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager })
    await loader.reload({ resolveProjectTrust: async () => false })
    const loaded = loader.getExtensions()
    assert.equal(loaded.extensions.length, 2, JSON.stringify(loaded.errors))
    const trustedSettings = SettingsManager.create(workspace, agentDir)
    const trustedLoader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager: trustedSettings })
    await trustedLoader.reload({ resolveProjectTrust: async () => true })
    assert.equal(trustedLoader.getExtensions().extensions.length, 3)
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'use extension', history: [], capabilities: { extensionToolNames: ['global_echo'] }, settings: settings(server.endpoint, workspace) }
    await runAgentSession(req, new AbortController().signal, event => events.push(event), {
      agentDir, sessionDir: join(root, 'sessions'), activeTools: [], enableExtensionTools: true,
      resolveProjectTrust: async () => false, extensionToolNames: req.capabilities?.extensionToolNames,
    })
    assert.equal(events.some(event => event.type === 'tool' && event.tool?.name === 'global_echo' && event.tool.state === 'done'), true, events.map(event => event.text).filter(Boolean).join('\n'))
  } finally { await server.close() }
})

test('large installed Skill sets keep bounded prompt metadata and remain searchable', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    const system = String(body.messages.find((message: any) => message.role === 'system')?.content || '')
    const names = (body.tools || []).map((tool: any) => tool.function?.name)
    if (turn++ === 0) {
      assert.equal((system.match(/<skill>/g) || []).length, 8)
      assert.doesNotMatch(system, /z-special-weather/)
      assert.equal(names.includes('skill_search'), true)
      sse(res, toolResponse(body.model, 'skill_search', '{"query":"meteorology forecast"}'))
    } else {
      const lastToolContent = String(body.messages.findLast((message: any) => message.role === 'tool')?.content || '')
      assert.match(lastToolContent, /z-special-weather/)
      assert.match(lastToolContent, /SKILL\.md:/)
      sse(res, textResponse(body.model, 'skill found'))
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-many-skills-')), agentDir = join(root, 'agent')
  for (let index = 0; index < 29; index++) {
    const directory = join(agentDir, 'skills', `generic-${String(index).padStart(2, '0')}`)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), `---\nname: generic-${String(index).padStart(2, '0')}\ndescription: Generic workflow number ${index}.\n---\n\nGeneric instructions.\n`)
  }
  const special = join(agentDir, 'skills', 'z-special-weather')
  await mkdir(special, { recursive: true })
  await writeFile(join(special, 'SKILL.md'), '---\nname: z-special-weather\ndescription: Analyze meteorology data and produce a weather forecast.\n---\n\nUse verified weather observations.\n')
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'forecast', history: [], settings: settings(server.endpoint) }
    await runAgentSession(req, new AbortController().signal, () => {}, {
      agentDir, sessionDir: join(root, 'sessions'), activeTools: ['read'], enableSkillSearch: true,
    })
    assert.equal(turn, 2)
  } finally { await server.close() }
})

test('a Skill written while the run is working is searchable in that same run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-live-skill-')), agentDir = join(root, 'agent')
  const skillDirectory = join(agentDir, 'skills', 'daily-build-digest')
  let turn = 0
  const server = await withServer(async (body, res) => {
    // The run's Skill set is resolved before its first provider request, so authoring
    // the Skill here is exactly the mid-run creation that used to stay invisible.
    if (turn++ === 0) {
      await mkdir(skillDirectory, { recursive: true })
      await writeFile(join(skillDirectory, 'SKILL.md'), '---\nname: daily-build-digest\ndescription: Summarize the nightly build digest into one short mail.\n---\n\nSend the digest.\n')
      sse(res, toolResponse(body.model, 'skill_search', '{"query":"nightly build digest"}'))
      return
    }
    const toolResult = String(body.messages.findLast((message: any) => message.role === 'tool')?.content || '')
    assert.match(toolResult, /daily-build-digest/)
    assert.equal(toolResult.includes(join(skillDirectory, 'SKILL.md')), true, toolResult)
    sse(res, textResponse(body.model, 'found'))
  })
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'make a mail skill', history: [], settings: settings(server.endpoint) }
    await runAgentSession(req, new AbortController().signal, () => {}, {
      agentDir, sessionDir: join(root, 'sessions'), activeTools: ['read'], enableSkillSearch: true,
    })
    assert.equal(turn, 2)
  } finally { await server.close() }
})

test('an untrusted project keeps its own Skill out of the search catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-project-skill-'))
  const workspace = join(root, 'workspace'), agentDir = join(root, 'agent')
  const skillDirectory = join(workspace, CONFIG_DIR_NAME, 'skills', 'project-only-skill')
  let turn = 0
  const server = await withServer(async (body, res) => {
    if (turn++ === 0) {
      await mkdir(skillDirectory, { recursive: true })
      await writeFile(join(skillDirectory, 'SKILL.md'), '---\nname: project-only-skill\ndescription: Project only skill about nothing in particular.\n---\n\nDo the project thing.\n')
      sse(res, toolResponse(body.model, 'skill_search', '{"query":"project only skill"}'))
      return
    }
    const toolResult = String(body.messages.findLast((message: any) => message.role === 'tool')?.content || '')
    assert.match(toolResult, /No enabled installed Skill matched/)
    sse(res, textResponse(body.model, 'nothing'))
  })
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'use the project skill', history: [], settings: settings(server.endpoint, workspace) }
    await runAgentSession(req, new AbortController().signal, () => {}, {
      agentDir, sessionDir: join(root, 'sessions'), activeTools: ['read'], enableSkillSearch: true,
      resolveProjectTrust: async () => false,
    })
    assert.equal(turn, 2)
  } finally { await server.close() }
})

test('plugin tool search ranks a bounded exact subset from a large enabled catalog', () => {
  const catalog = Array.from({ length: 60 }, (_, index) => ({
    ownerId: index < 30 ? 'issues' : 'design',
    ownerName: index < 30 ? 'Issue tracker' : 'Design system',
    name: index === 47 ? 'design_render_preview' : `catalog_tool_${index}`,
    description: index === 47 ? 'Render a design node preview image' : `Generic operation ${index}`,
  }))
  assert.deepEqual(searchPluginTools(catalog, 'render design preview', undefined, 3).map(item => item.name), ['design_render_preview'])
  // The person's spelling of a plugin is an id, a name, or both joined differently;
  // an exact comparison made a correct query look like a missing capability.
  assert.deepEqual(searchPluginTools([
    { ownerId: 'browser-use', ownerName: 'Browser Use', name: 'browser_tabs', description: 'List open tabs in the user’s Chrome.' },
  ], 'list chrome tabs', 'Browser Use', 3).map(item => item.name), ['browser_tabs'])
  assert.deepEqual(searchPluginTools([
    { ownerId: 'browser-use', ownerName: 'Browser Use', name: 'browser_open', description: 'Open a new HTTP(S) tab in Chrome.' },
  ], 'open a new tab', 'browser_use', 3).map(item => item.name), ['browser_open'])
  assert.equal(searchPluginTools(catalog, 'generic operation', 'issues', 5).length, 5)
  assert.equal(searchPluginTools(catalog, 'generic operation', 'issues', 20).length, 5)
})

test('a tool search with no matches names the real cause instead of implying absence', () => {
  const catalog = [
    { ownerId: 'browser-use', ownerName: 'Browser Use', name: 'browser_tabs', description: 'List open tabs in the user’s Chrome.' },
    { ownerId: 'github', ownerName: 'GitHub', name: 'github_issue', description: 'Read an issue.' },
  ]
  // A wrong plugin filter is reported as a wrong plugin filter, not as a query miss.
  const unknownPlugin = toolSearchMissMessage(catalog, 'browser_tabs', 'browser-preview')
  assert.match(unknownPlugin, /No enabled tool belongs to plugin "browser-preview"/)
  assert.match(unknownPlugin, /Enabled sources: Browser Use, GitHub/)
  assert.doesNotMatch(unknownPlugin, /No enabled tool matched/)
  // A query whose words are nowhere in the catalog says what to try instead of
  // letting a model conclude the capability does not exist.
  const miss = toolSearchMissMessage(catalog, '打开新标签页', undefined)
  assert.match(miss, /No enabled tool matched "打开新标签页"/)
  assert.match(miss, /name is the surest query/)
  assert.match(miss, /Enabled sources: Browser Use, GitHub/)
})

test('deferred plugin tools are absent initially and exact matches become callable after discovery', async () => {
  let requests = 0
  const server = await withServer((body, res) => {
    requests++
    const names = (body.tools || []).map((tool: any) => tool.function?.name)
    const lastToolContent = String(body.messages.findLast((message: any) => message.role === 'tool')?.content || '')
    if (!lastToolContent) {
      assert.equal(names.includes('plugin_tool_search'), true)
      assert.equal(names.some((name: string) => name.startsWith('bulk_tool_')), false)
      sse(res, toolResponse(body.model, 'plugin_tool_search', '{"query":"weather forecast","limit":2}'))
    } else if (/Loaded exact tools: bulk_tool_weather/.test(lastToolContent)) {
      assert.equal(names.includes('bulk_tool_weather'), true, JSON.stringify({ names, lastToolContent }))
      assert.equal(names.filter((name: string) => name.startsWith('bulk_tool_')).length, 1)
      sse(res, toolResponse(body.model, 'bulk_tool_weather', '{"value":"Shanghai"}'))
    } else {
      assert.match(String(body.messages.at(-1)?.content), /weather:Shanghai/)
      sse(res, textResponse(body.model, 'done'))
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-deferred-tools-'))
  const tools = Array.from({ length: 60 }, (_, index) => defineTool({
    name: index === 41 ? 'bulk_tool_weather' : `bulk_tool_${index}`,
    label: `Bulk ${index}`,
    description: index === 41 ? 'Look up a city weather forecast' : `Unrelated bulk operation ${index}`,
    parameters: Type.Object({ value: Type.String() }),
    execute: async (_id, args) => ({ content: [{ type: 'text' as const, text: index === 41 ? `weather:${args.value}` : String(args.value) }], details: {} }),
  }))
  const deferred: DeferredTool[] = tools.map(tool => ({ ownerId: 'bulk', ownerName: 'Bulk plugin', tool }))
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'weather forecast', history: [], settings: settings(server.endpoint) }
    await runAgentSession(req, new AbortController().signal, () => {}, {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: [], customTools: tools, deferredTools: deferred, enableExtensionTools: true,
    })
    assert.equal(requests, 3)
  } finally { await server.close() }
})

test('direct tools remain discoverable without activating unrelated deferred tools', async () => {
  let requests = 0
  const server = await withServer((body, res) => {
    const names = (body.tools || []).map((tool: any) => tool.function?.name)
    assert.equal(names.includes('fixture_lookup'), true)
    assert.equal(names.includes('unrelated_write'), false)
    const call = requests++
    if (call === 0) sse(res, toolResponse(body.model, 'plugin_tool_search', '{"query":"fixture_lookup","limit":1}'))
    else if (call === 1) {
      const result = String(body.messages.findLast((message: any) => message.role === 'tool')?.content || '')
      assert.match(result, /Matching tools were already active/)
      assert.match(result, /fixture_lookup/)
      assert.doesNotMatch(result, /unrelated_write/)
      sse(res, toolResponse(body.model, 'fixture_lookup', '{}'))
    } else sse(res, textResponse(body.model, 'done'))
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-direct-discovery-'))
  const tools = ['fixture_lookup', 'unrelated_write'].map(name => defineTool({
    name, label: name, description: name, parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'observed' }], details: {} }),
  }))
  try {
    await runAgentSession({ id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'Use the enabled lookup.', history: [], settings: settings(server.endpoint) }, new AbortController().signal, () => {}, {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['fixture_lookup'], customTools: tools,
      deferredTools: [{ ownerId: 'fixture', ownerName: 'Fixture', tool: tools[1] }], enableExtensionTools: true,
    })
    assert.equal(requests, 3)
  } finally { await server.close() }
})

test('deferred plugin tools disclosed in one turn remain active on the next turn', async () => {
  let request = 0
  const server = await withServer((body, res) => {
    const names = (body.tools || []).map((tool: any) => tool.function?.name)
    if (request === 0) {
      assert.equal(names.includes('plugin_tool_search'), true)
      assert.equal(names.includes('render_deploy_list'), false)
      sse(res, toolResponse(body.model, 'plugin_tool_search', '{"query":"render deployments"}'))
    } else if (request === 1) {
      assert.equal(names.includes('render_deploy_list'), true)
      sse(res, toolResponse(body.model, 'render_deploy_list', '{"service_id":"srv-test"}'))
    } else if (request === 2) {
      sse(res, textResponse(body.model, 'first turn complete'))
    } else if (request === 3) {
      assert.equal(names.includes('plugin_tool_search'), true)
      assert.equal(names.includes('render_deploy_list'), true)
      sse(res, toolResponse(body.model, 'render_deploy_list', '{"service_id":"srv-test"}'))
    } else if (request === 4) {
      sse(res, textResponse(body.model, 'second turn complete'))
    } else {
      assert.equal(names.includes('render_deploy_list'), false)
      sse(res, textResponse(body.model, 'plugin disabled'))
    }
    request++
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-deferred-tools-resume-'))
  const renderDeployList = defineTool({
    name: 'render_deploy_list',
    label: 'Render deployments',
    description: 'List recent Render deployments for a service',
    parameters: Type.Object({ service_id: Type.String() }),
    execute: async (_id, args) => ({ content: [{ type: 'text' as const, text: `deployments:${args.service_id}` }], details: {} }),
  })
  const taskId = crypto.randomUUID()
  const options = {
    agentDir: join(root, 'agent'),
    sessionDir: join(root, 'sessions'),
    activeTools: [] as string[],
    customTools: [renderDeployList],
    deferredTools: [{ ownerId: 'render', ownerName: 'Render', tool: renderDeployList }],
    enableExtensionTools: true,
  }
  const events: AgentEvent[] = []
  try {
    const first: AgentRequest = { id: crypto.randomUUID(), taskId, text: 'check deployment', history: [], settings: settings(server.endpoint) }
    await runAgentSession(first, new AbortController().signal, event => events.push(event), options)
    const second: AgentRequest = { ...first, id: crypto.randomUUID(), text: 'check again' }
    await runAgentSession(second, new AbortController().signal, event => events.push(event), options)
    const third: AgentRequest = { ...first, id: crypto.randomUUID(), text: 'plugin is disabled now' }
    await runAgentSession(third, new AbortController().signal, event => events.push(event), {
      ...options,
      customTools: [],
      deferredTools: [],
    })
    assert.equal(request, 6)
    assert.equal(events.some(event => event.type === 'tool' && event.tool?.output === 'Tool render_deploy_list not found'), false)
    assert.equal(events.filter(event => event.type === 'tool' && event.tool?.name === 'render_deploy_list' && event.tool.state === 'done').length, 2)
  } finally { await server.close() }
})

test('message-scoped tool declarations preserve the request prefix through discovery and session reopen', async () => {
  let request = 0
  const server = await withServer((body, res) => {
    const names = (body.tools || []).map((tool: any) => tool.function?.name)
    assert.equal(names.includes('fixture_read'), false)
    if (request++ === 0) sse(res, toolResponse(body.model, 'plugin_tool_search', '{"query":"fixture read"}'))
    else if (request === 2 || request === 4) {
      assert.ok(body.messages.some((message: any) => message.role === 'system' && message.tools?.some((tool: any) => tool.function?.name === 'fixture_read')))
      sse(res, toolResponse(body.model, 'fixture_read', '{}'))
    } else sse(res, textResponse(body.model, 'done'))
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-message-tools-'))
  const configured = settings(server.endpoint, root)
  configured.providers[0].models = [{ id: configured.model, contextWindow: 32768, maxOutputTokens: 2048, toolSchemaPlacement: 'message' }]
  const fixture = defineTool({ name: 'fixture_read', label: 'Read fixture', description: 'Read fixture.', parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'fixture value' }], details: {} }),
  })
  const options = { agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: [] as string[], customTools: [fixture],
    deferredTools: [{ ownerId: 'fixture', ownerName: 'Fixture', tool: fixture }], enableExtensionTools: true }
  const taskId = crypto.randomUUID()
  try {
    for (let turn = 0; turn < 2; turn++) await runAgentSession({ id: crypto.randomUUID(), taskId, text: 'Read fixture.', history: [], settings: configured }, new AbortController().signal, () => {}, options)
    assert.equal(request, 5)
    const first = server.bodies[0]
    for (const body of server.bodies.slice(1)) {
      assert.deepEqual(body.tools, first.tools)
      assert.deepEqual(body.messages.slice(0, first.messages.length), first.messages)
    }
    const beforeReopen = server.bodies[2]
    assert.deepEqual(server.bodies[3].messages.slice(0, beforeReopen.messages.length), beforeReopen.messages)
  } finally { await server.close() }
})

test('session encoding survives schema updates while current tool registration still changes', async () => {
  let request = 0, executions = 0
  const server = await withServer((body, res) => {
    const index = request++
    if (index === 0) sse(res, toolResponse(body.model, 'plugin_tool_search', '{"query":"fixture read"}'))
    else if ([1, 3, 5].includes(index)) sse(res, toolResponse(body.model, 'fixture_read', '{}'))
    else sse(res, textResponse(body.model, 'done'))
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-stable-context-'))
  const configured = settings(server.endpoint, root)
  configured.providers[0].models = [{ id: configured.model, contextWindow: 32768, maxOutputTokens: 2048, reasoning: true, toolSchemaPlacement: 'message' }]
  const makeFixture = (description: string) => defineTool({ name: 'fixture_read', label: 'Read fixture', description, parameters: Type.Object({}),
    execute: async () => { executions++; return { content: [{ type: 'text' as const, text: description }], details: {} } },
  })
  const options = { agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: [] as string[], enableExtensionTools: true }
  const taskId = crypto.randomUUID()
  try {
    for (const description of ['original', 'updated', undefined]) {
      const fixture = description ? makeFixture(description) : undefined
      await runAgentSession({ id: crypto.randomUUID(), taskId, text: 'Read fixture.', history: [], settings: configured }, new AbortController().signal, () => {}, {
        ...options, customTools: fixture ? [fixture] : [], deferredTools: fixture ? [{ ownerId: 'fixture', ownerName: 'Fixture', tool: fixture }] : [],
      })
    }
    assert.equal(request, 7)
    assert.equal(executions, 2)
    assert.equal(server.bodies[0].messages[0].role, 'developer')
    const beforeUpdate = server.bodies[2]
    assert.deepEqual(server.bodies[3].tools, beforeUpdate.tools)
    assert.deepEqual(server.bodies[3].messages.slice(0, beforeUpdate.messages.length), beforeUpdate.messages)
    const updated = server.bodies[3].messages.findLast((message: any) => message.tools_remove || message.tools?.some((tool: any) => tool.function?.description === 'updated'))
    assert.equal(updated.tools.find((tool: any) => tool.function.name === 'fixture_read').function.description, 'updated')
    const removed = server.bodies[5].messages.findLast((message: any) => Array.isArray(message.tools) && message.tools.length === 0)
    assert.equal(removed.content, 'Unavailable tools: fixture_read.')
    assert.ok(server.bodies[6].messages.some((message: any) => message.role === 'tool' && /not found/i.test(message.content)))
  } finally { await server.close() }
})

test('abort cancels an in-flight provider stream without emitting done', async () => {
  const server = await withServer((_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"id":"waiting","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n')
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-abort-'))
  const controller = new AbortController()
  const events: AgentEvent[] = []
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'wait', history: [], settings: settings(server.endpoint) }
    const running = runAgentSession(req, controller.signal, event => events.push(event), {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: [],
    })
    setTimeout(() => controller.abort(), 30)
    await assert.rejects(running, error => error instanceof Error && error.name === 'AbortError')
    assert.equal(events.some(event => event.type === 'done'), false)
  } finally { await server.close() }
})

test('cancellation during session preparation never starts a provider request', async () => {
  let requests = 0
  const server = await withServer(() => { requests += 1 })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-prepare-abort-'))
  const controller = new AbortController()
  const events: AgentEvent[] = []
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'wait', history: [], settings: settings(server.endpoint) }
    await assert.rejects(runAgentSession(req, controller.signal, event => events.push(event), {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: [],
      beforePrompt: async () => { controller.abort() },
    }), error => error instanceof Error && error.name === 'AbortError')
    assert.equal(requests, 0)
    assert.equal(events.some(event => event.type === 'done'), false)
  } finally { await server.close() }
})

test('outcome policy steers a premature completion back into verification and then converges', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    if (turn === 0) sse(res, toolResponse(body.model, 'write', '{"path":"result.txt","content":"ok"}'))
    else if (turn === 1) sse(res, textResponse(body.model, 'done too early'))
    else if (turn === 2) {
      const lastUser = [...body.messages].reverse().find((message: any) => message.role === 'user')
      const text = Array.isArray(lastUser.content) ? lastUser.content.map((item: any) => item.text || '').join('') : lastUser.content
      assert.match(text, /verification|验证/i)
      sse(res, toolResponse(body.model, 'bash', '{"command":"test -f result.txt"}'))
    } else sse(res, textResponse(body.model, 'verified'))
    turn++
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-converge-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const events: AgentEvent[] = []
  let verificationPending = false
  let nudged = false
  const outcomePolicy: OutcomePolicy = {
    observe(event) {
      if (event.type !== 'tool_execution_end' || event.isError) return
      if (event.toolName === 'write') verificationPending = true
      if (event.toolName === 'bash') verificationPending = false
    },
    evaluate(turn) {
      if (turn.message.content.some(block => block.type === 'toolCall') || !verificationPending || nudged) return { status: 'accept' }
      nudged = true
      return { status: 'continue', feedback: 'Run verification before finishing.' }
    },
  }
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'create result.txt and verify it', history: [], settings: settings(server.endpoint, workspace) }
    await runAgentSession(req, new AbortController().signal, event => events.push(event), {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['write', 'bash'],
      outcomePolicy,
    })
    assert.equal(turn, 4)
    assert.equal(events.some(event => event.type === 'tool' && event.tool?.name === 'bash' && event.tool.state === 'done'), true)
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'done too earlyverified')
  } finally { await server.close() }
})

test('a context category with nothing in it costs nothing instead of one token', () => {
  // An empty tool list serializes to "[]", which estimates as one token — enough to make the
  // breakdown report a cost for a session that has no such category at all.
  const withoutBridge = estimateContextBreakdown(10_000, 'system prompt', [{ name: 'read', description: 'x', parameters: { type: 'object' } }])
  assert.equal(withoutBridge.mcpTokens, 0)
  const withBridge = estimateContextBreakdown(10_000, 'system prompt', [
    { name: 'read', description: 'x', parameters: { type: 'object' } },
    { name: 'mcp_list', description: 'List installed plugin capabilities.', parameters: { type: 'object' } },
  ])
  assert.ok(withBridge.mcpTokens > 0)
})


for (const failureMode of ['http', 'stream', 'memory-http', 'memory-stream'] as const) test(`configured ${failureMode} connection recovery retries generation without repeating completed tools`, async () => {
  let requests = 0, mutations = 0
  const server = await withServer((body, res) => {
    requests += 1
    if (requests === 1) return sse(res, toolResponse(body.model, 'commit_fixture', '{}'))
    if (requests <= 5) {
      const failure = { error: { message: failureMode.startsWith('memory') ? '503 Service unavailable: model working memory is temporarily full.' : '503 Service unavailable: model worker connection lost; recovery is in progress.', type: 'server_error' } }
      if (failureMode.endsWith('http')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify(failure)) }
      else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify(failure)}\n\ndata: [DONE]\n\n`) }
      return
    }
    sse(res, textResponse(body.model, 'Recovered without repeating the change.'))
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-connection-recovery-'))
  const agentDir = join(root, 'agent')
  await mkdir(agentDir, { recursive: true })
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: true, maxRetries: 6, baseDelayMs: 1, provider: { maxRetries: 0 } } }))
  const events: AgentEvent[] = []
  const tool = defineTool({ name: 'commit_fixture', label: 'Commit fixture', description: 'Apply the test change once.', parameters: Type.Object({}), execute: async () => { mutations += 1; return { content: [{ type: 'text' as const, text: 'Committed.' }], details: {} } } })
  try {
    await runAgentSession({ id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'Apply the fixture change and confirm it.', history: [], settings: settings(server.endpoint, root) }, new AbortController().signal, event => events.push(event), {
      cwd: root, agentDir, sessionDir: join(root, 'sessions'), activeTools: ['commit_fixture'], customTools: [tool],
    })
    assert.equal(requests, 6, 'the configured budget survives more than the default three failures')
    assert.equal(mutations, 1, 'model recovery must never replay a completed tool')
    assert.match(events.filter(event => event.type === 'delta').map(event => event.text).join(''), /Recovered without repeating/)
    assert.equal(events.some(event => event.type === 'error'), false)
    assert.equal(server.bodies.at(-1).messages.filter((message: any) => message.role === 'tool').length, 1)
  } finally { await server.close() }
})

test('connection recovery backoff remains cancellable before another request is sent', { timeout: 5_000 }, async () => {
  const controller = new AbortController()
  const cancellation = new Error('Recovery cancelled by the person')
  let timer: ReturnType<typeof setTimeout> | undefined
  const server = await withServer((_body, res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Service temporarily unavailable' } }))
    timer = setTimeout(() => controller.abort(cancellation), 40)
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-recovery-cancel-'))
  const agentDir = join(root, 'agent')
  await mkdir(agentDir, { recursive: true })
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: true, maxRetries: 6, baseDelayMs: 10_000, provider: { maxRetries: 0 } } }))
  try {
    await assert.rejects(runAgentSession({ id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'Reply when the connection recovers.', history: [], settings: settings(server.endpoint, root) }, controller.signal, () => {}, {
      cwd: root, agentDir, sessionDir: join(root, 'sessions'), activeTools: [],
    }), error => error === cancellation)
    assert.equal(server.bodies.length, 1)
  } finally { if (timer) clearTimeout(timer); await server.close() }
})

test('explicit context extensions project provider input while preserving tool events and session evidence', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    if (turn++ === 0) sse(res, toolResponse(body.model, 'fixture_observe', '{}'))
    else {
      const tool = body.messages.find((message: any) => message.role === 'tool')
      assert.match(JSON.stringify(tool), /projected fixture observation/)
      assert.doesNotMatch(JSON.stringify(tool), /original fixture observation/)
      sse(res, textResponse(body.model, 'complete'))
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-context-extension-'))
  const events: AgentEvent[] = []
  const fixture = defineTool({ name: 'fixture_observe', label: 'Observe fixture', description: 'Read a synthetic fixture', parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'original fixture observation' }], details: {} }) })
  const sessionDir = join(root, 'sessions')
  try {
    await runAgentSession({ id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'Read the fixture.', history: [], settings: settings(server.endpoint) }, new AbortController().signal, event => events.push(event), {
      agentDir: join(root, 'agent'), sessionDir, activeTools: ['fixture_observe'], customTools: [fixture],
      extensions: [api => { api.on('context', event => ({ messages: event.messages.map(message => message.role === 'toolResult' && message.toolName === 'fixture_observe'
        ? { ...message, content: [{ type: 'text' as const, text: 'projected fixture observation' }] } : message) })) }],
    })
    assert.equal(turn, 2)
    const observed = events.find(event => event.type === 'tool' && event.tool?.state === 'done')
    assert.equal(observed?.type === 'tool' ? observed.tool?.output : undefined, 'original fixture observation')
    const files = await readdir(sessionDir)
    const transcript = await readFile(join(sessionDir, files[0]), 'utf8')
    assert.match(transcript, /original fixture observation/)
    assert.doesNotMatch(transcript, /projected fixture observation/)
    assert.equal(events.filter(event => event.type === 'done').length, 1)
  } finally { await server.close() }
})

test('lookup delivery reaches the provider through the normal task session', async () => {
  let turn=0
  const server=await withServer((body,res)=>{
    if(turn++===0)sse(res,toolResponse(body.model,'web_search',JSON.stringify({query:'example capacity',task_depth:'fact_lookup'})))
    else sse(res,textResponse(body.model,'The documented limit is 10.'))
  })
  const root=await mkdtemp(join(tmpdir(),'shun-lookup-integration-'))
  const fixture=defineTool({name:'web_search',label:'Search fixture',description:'Read a synthetic source',parameters:Type.Object({query:Type.String(),task_depth:Type.String()}),
    execute:async()=>({content:[{type:'text' as const,text:JSON.stringify({ok:true,final_url:'https://publisher.test/limits',content:'Capacity is 10.'})}],details:{}})})
  try{
    await runAgentSession({id:crypto.randomUUID(),taskId:crypto.randomUUID(),text:'What is the capacity?',history:[],settings:settings(server.endpoint)},new AbortController().signal,()=>{},{
      agentDir:join(root,'agent'),sessionDir:join(root,'sessions'),activeTools:['web_search'],customTools:[fixture],
      extensions:[createLookupDeliveryExtension({enabled:true,resolveReasoningBudget:async()=> 'thinking_budget'})],
    })
    assert.equal(server.bodies.length,2)
    const delivery=server.bodies[1]
    assert.equal(delivery.thinking_budget,256)
    assert.equal(delivery.messages.at(-1).role,'system')
    assert.match(JSON.stringify(delivery.messages),/Free addition establishes cost/)
    assert.match(JSON.stringify(delivery.messages),/https:\/\/publisher.test\/limits/)
  }finally{await server.close()}
})

test('browser and desktop visual evidence survives repeated readings and follow-up runs without an extra compactor', async () => {
  const images = ['iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC']
  let request = 0, reading = 0
  const server = await withServer((body, res) => {
    if (request++ < 24) {
      const chunks = toolResponse(body.model, request % 2 ? 'browser_snapshot' : 'desktop_snapshot', '{}')
      ;(chunks[0] as any).choices[0].delta.tool_calls[0].id = `evidence-call-${request}`
      sse(res, chunks)
    } else sse(res, textResponse(body.model, 'Readings complete.'))
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-visual-evidence-'))
  const sessionDir = join(root, 'sessions')
  const configured = settings(server.endpoint, root)
  configured.contextWindow = 262144
  configured.providers[0].models = [{ id: configured.model, contextWindow: 262144, maxOutputTokens: 2048, toolSchemaPlacement: 'message' }]
  const fixtures = ['browser_snapshot', 'desktop_snapshot'].map(name => defineTool({ name, label: 'Read fixture', description: 'Read a synthetic interface', parameters: Type.Object({}),
    execute: async () => {
      const sequence = ++reading
      return { content: [{ type: 'text' as const, text: JSON.stringify({ session_id: 'fixture-session', observation_status: 'ready',
        accessibility: `original-observation-${sequence} `.repeat(100), visible_text: `Page ${sequence}`, url: 'https://example.test/',
        ...(name === 'desktop_snapshot' ? { capture: { target: 'window', window: { id: 7, pid: 1, title: 'Fixture' } } } : {}), console: [], page_errors: [] }) },
      { type: 'image' as const, mimeType: 'image/png', data: images[(sequence - 1) % 2] }], details: {} }
    } }))
  const imagePayloads = (messages: any[]) => messages.flatMap(message => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === 'image_url').map((part: any) => part.image_url.url) : [])
  const readings = (messages: any[]) => messages.filter(message => message.role === 'tool').map(message => JSON.parse(typeof message.content === 'string' ? message.content : message.content[0].text))
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'Inspect the synthetic interfaces.', history: [], settings: configured }
    const options = { agentDir: join(root, 'agent'), sessionDir, cwd: root, activeTools: ['browser_snapshot', 'desktop_snapshot'], customTools: fixtures }
    await runAgentSession(req, new AbortController().signal, () => {}, options)
    const body = server.bodies.at(-1)
    assert.equal(readings(body.messages).length, 24)
    for (const [index, item] of readings(body.messages).entries()) {
      assert.equal(item.accessibility, `original-observation-${index + 1} `.repeat(100))
      assert.equal(item.visible_text, `Page ${index + 1}`)
      assert.equal(item.historical_observation, undefined)
    }
    assert.deepEqual(imagePayloads(body.messages), Array.from({ length: 24 }, (_, index) => `data:image/png;base64,${images[index % 2]}`))
    const files = await readdir(sessionDir)
    const transcript = await readFile(join(sessionDir, files[0]), 'utf8')
    for (let i = 1; i <= 24; i++) assert.match(transcript, new RegExp(`original-observation-${i}`))
    assert.doesNotMatch(transcript, /historical_observation/)
    await runAgentSession({ ...req, id: crypto.randomUUID(), text: 'Compare earlier and later visual evidence.' }, new AbortController().signal, () => {}, options)
    const resumed = server.bodies.at(-1).messages
    assert.deepEqual(resumed[0], body.messages[0], 'the configured system/tool encoding stays stable')
    const priorAssistant = body.messages.filter((message: any) => message.role === 'assistant')
    assert.deepEqual(resumed.filter((message: any) => message.role === 'assistant').slice(0, priorAssistant.length), priorAssistant)
    assert.deepEqual(readings(resumed), readings(body.messages))
    assert.deepEqual(imagePayloads(resumed), imagePayloads(body.messages), 'a new run preserves older visual comparison evidence')
  } finally { await server.close() }
})


test('plugin tool discovery also finds enabled script Skills in a projectless task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-script-discovery-')), agentDir = join(root, 'agent')
  const directory = join(agentDir, 'skills', 'inventory-api')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), '---\nname: inventory-api\ndescription: Read inventory stock through the account API.\n---\nUse the package CLI.\n')
  let turn = 0
  const server = await withServer((body, res) => {
    if (turn++ === 0) {
      sse(res, toolResponse(body.model, 'plugin_tool_search', '{"query":"inventory stock"}'))
    } else {
      const result = String(body.messages.findLast((message: any) => message.role === 'tool')?.content || '')
      assert.match(result, /Installed Skill entry points/)
      assert.ok(result.includes(join(directory, 'SKILL.md')))
      assert.match(result, /Read the relevant SKILL.md/)
      sse(res, textResponse(body.model, 'found the API Skill'))
    }
  })
  try {
    await runAgentSession({ id: crypto.randomUUID(), text: 'check stock', history: [], settings: settings(server.endpoint) }, new AbortController().signal, () => {}, {
      agentDir, sessionDir: join(root, 'sessions'), activeTools: ['read'], enableSkillSearch: true, enableExtensionTools: true,
    })
    assert.equal(turn, 2)
  } finally { await server.close() }
})
