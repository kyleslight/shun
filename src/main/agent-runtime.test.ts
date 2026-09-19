import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { branchPastCrossModelThinkingAbort, compactAgentSession, configureManualCompaction, estimateContextBreakdown, isMcpBridgeTool, redactTaskRoot, removeAgentSessions, resolveAgentProviderConnection, runAgentSession, searchPluginTools, utilityThinkingLevel, type DeferredTool } from './agent-runtime.ts'
import { contextAfterCompaction } from '../shared.ts'
import { AgentSupervisor } from './agent-supervisor.ts'
import type { OutcomePolicy } from './outcome-policy.ts'
import { createShellTool } from './shell-tool.ts'
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

test('all Shun turns resume an exact persisted agent session transcript', async () => {
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
    assert.match(String(system), /outside.*web_search.*web_read/i)
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
      assert.equal((system.match(/<skill>/g) || []).length, 20)
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
  assert.equal(searchPluginTools(catalog, 'generic operation', 'issues', 5).length, 5)
  assert.equal(searchPluginTools(catalog, 'generic operation', 'issues', 20).length, 5)
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

test('a limitation the run never tested is challenged once, and the run continues from it', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    const lastUser = [...body.messages].reverse().find((message: any) => message.role === 'user')
    const asked = Array.isArray(lastUser?.content) ? lastUser.content.map((item: any) => item.text || '').join('') : String(lastUser?.content || '')
    if (turn === 0) sse(res, toolResponse(body.model, 'write', '{"path":"search.mjs","content":"// pipeline"}'))
    else if (turn === 1) sse(res, toolResponse(body.model, 'bash', '{"command":"node search.mjs --case 1"}'))
    else if (turn === 2) sse(res, textResponse(body.model, 'Search quality cannot be improved further without a stronger search API.'))
    else if (turn === 3) {
      // The challenge arrives as guidance inside the run, not as a new agent.
      assert.match(asked, /falsify/i)
      sse(res, toolResponse(body.model, 'bash', '{"command":"node search.mjs --case 2"}'))
    } else sse(res, textResponse(body.model, 'The query builder dropped a clause; fixed and re-measured.'))
    turn++
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-challenge-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const events: AgentEvent[] = []
  const supervisor = new AgentSupervisor()
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'improve search quality', history: [], settings: settings(server.endpoint, workspace) }
    await runAgentSession(req, new AbortController().signal, event => events.push(event), {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['write', 'bash'], cwd: workspace,
      outcomePolicy: supervisor,
    })
    assert.equal(turn, 5)
    assert.equal(events.some(event => event.type === 'done'), true)
    const telemetry = supervisor.finish()
    assert.equal(telemetry.supervisorChallenges, 1)
    assert.equal(telemetry.challengeOutcome, 'productive')
    assert.match(String(telemetry.challengeReason), /cannot be improve/)
  } finally { await server.close() }
})

test('a generation that repeats itself without changing state is interrupted once, in the run', async () => {
  let turn = 0
  const repeated = 'write it. okay. execute. '.repeat(60)
  const server = await withServer((body, res) => {
    if (turn === 0) sse(res, textResponse(body.model, repeated))
    else {
      const lastUser = [...body.messages].reverse().find((message: any) => message.role === 'user')
      const asked = Array.isArray(lastUser?.content) ? lastUser.content.map((item: any) => item.text || '').join('') : String(lastUser?.content || '')
      // Guidance reaches a run that was about to stop with nothing left to say.
      assert.match(asked, /repeating the same reasoning/)
      sse(res, textResponse(body.model, 'Re-read the failing case and changed the query builder.'))
    }
    turn++
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-agent-degeneration-'))
  const events: AgentEvent[] = []
  const supervisor = new AgentSupervisor()
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'improve search quality', history: [], settings: settings(server.endpoint) }
    await runAgentSession(req, new AbortController().signal, event => events.push(event), {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: [],
      outcomePolicy: supervisor,
    })
    assert.equal(turn, 2)
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), `${repeated}Re-read the failing case and changed the query builder.`)
    const telemetry = supervisor.finish()
    assert.equal(telemetry.degenerationSteers, 1)
    assert.equal(telemetry.degenerationDetections, 1)
    assert.equal(telemetry.recoveryOutcome, 'recovered')
    assert.equal(telemetry.totalToolCalls, 0)
  } finally { await server.close() }
})
