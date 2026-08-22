import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { AgentMessage, BeforeToolCallContext, ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Model, Usage } from '@earendil-works/pi-ai'
import type { AgentEvent, AgentRequest, ContextUsage, ToolEvent } from '../shared.ts'
import type { OutcomePolicy } from './outcome-policy.ts'
import { capabilityPrompt, productSystemPrompt } from './capabilities.ts'

export type PiRunOptions = {
  agentDir: string
  sessionDir: string
  customTools?: ToolDefinition[]
  activeTools: string[]
  enableExtensionTools?: boolean
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<{ block?: boolean; reason?: string; terminate?: boolean } | undefined>
  outcomePolicy?: OutcomePolicy
}

const zeroUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

export async function runPiAgent(
  req: AgentRequest,
  signal: AbortSignal,
  emit: (event: AgentEvent) => void,
  options: PiRunOptions,
) {
  await mkdir(options.agentDir, { recursive: true })
  await mkdir(options.sessionDir, { recursive: true })
  const cwd = req.settings.workspace || process.cwd()
  const modelRuntime = await createModelRuntime(req)
  const model = modelRuntime.getModel(providerId(req), req.settings.model)
  if (!model) throw Error(`Model ${req.settings.model} is unavailable.`)
  const sessionManager = await openSessionManager(req.taskId || req.id, cwd, options.sessionDir)
  seedLegacyHistory(sessionManager, req, model)
  const thinkingLevel: ThinkingLevel = model.reasoning ? 'medium' : 'off'
  ensurePersistedRuntimeSelection(sessionManager, model, thinkingLevel)
  const settingsManager = SettingsManager.create(cwd, options.agentDir)
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: options.agentDir,
    settingsManager,
    systemPrompt: productSystemPrompt(req.settings.model),
    appendSystemPrompt: capabilityPrompt(options.activeTools),
  })
  await resourceLoader.reload({ resolveProjectTrust: async () => false })
  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir: options.agentDir,
    modelRuntime,
    model,
    thinkingLevel,
    ...(options.enableExtensionTools
      ? { noTools: options.activeTools.some(name => ['read', 'bash', 'edit', 'write'].includes(name)) ? undefined : 'builtin' as const }
      : { tools: options.activeTools }),
    customTools: options.customTools,
    resourceLoader,
    settingsManager,
    sessionManager,
  })
  if (extensionsResult.errors.length) {
    emit({ id: req.id, type: 'phase', text: `Extension warning: ${extensionsResult.errors.map(error => `${error.path}: ${error.error}`).join('; ')}` })
  }
  const builtIns = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])
  const productTools = new Set(options.customTools?.map(tool => tool.name) || [])
  const discovered = options.enableExtensionTools
    ? session.getAllTools().map(tool => tool.name).filter(name => !builtIns.has(name) && !productTools.has(name))
    : []
  session.setActiveToolsByName([...new Set([...options.activeTools, ...discovered])])
  session.setAutoCompactionEnabled(req.settings.autoCompact)
  installProductPolicy(session, options.beforeToolCall, options.outcomePolicy)
  const toolInputs = new Map<string, string>()
  const unsubscribe = session.subscribe(event => {
    options.outcomePolicy?.observe(event)
    forwardSessionEvent(req, session, event, toolInputs, emit)
  })
  const abort = () => { void session.abort() }
  signal.addEventListener('abort', abort, { once: true })
  emit({ id: req.id, type: 'phase', text: req.settings.language === 'zh-CN' ? '思考中' : 'Thinking' })
  try {
    await session.prompt(req.text)
    await session.waitForIdle()
    if (signal.aborted) throw signal.reason
    const last = [...session.messages].reverse().find((message): message is AssistantMessage => message.role === 'assistant')
    if (!last) throw Error('Provider returned no assistant message.')
    if (last.stopReason === 'error' || last.stopReason === 'aborted') throw Error(last.errorMessage || `Model stopped: ${last.stopReason}`)
    emitContext(req.id, session, emit)
    emit({ id: req.id, type: 'done' })
  } finally {
    signal.removeEventListener('abort', abort)
    unsubscribe()
    session.dispose()
  }
}

export async function runPiUtilityPrompt(
  req: AgentRequest,
  prompt: string,
  signal: AbortSignal,
  options: Pick<PiRunOptions, 'agentDir'>,
) {
  await mkdir(options.agentDir, { recursive: true })
  const cwd = req.settings.workspace || process.cwd()
  const modelRuntime = await createModelRuntime(req)
  const model = modelRuntime.getModel(providerId(req), req.settings.model)
  if (!model) throw Error(`Model ${req.settings.model} is unavailable.`)
  const settingsManager = SettingsManager.create(cwd, options.agentDir)
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: options.agentDir,
    settingsManager,
    noExtensions: true,
    systemPrompt: productSystemPrompt(req.settings.model),
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({
    cwd,
    agentDir: options.agentDir,
    modelRuntime,
    model,
    thinkingLevel: 'off',
    noTools: 'all',
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
  })
  const abort = () => { void session.abort() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    await session.prompt(prompt)
    await session.waitForIdle()
    if (signal.aborted) throw signal.reason
    const last = [...session.messages].reverse().find((message): message is AssistantMessage => message.role === 'assistant')
    if (!last) throw Error('Provider returned no assistant message.')
    if (last.stopReason === 'error' || last.stopReason === 'aborted') throw Error(last.errorMessage || `Model stopped: ${last.stopReason}`)
    return last.content.map(block => block.type === 'text' ? block.text : '').join('').trim()
  } finally {
    signal.removeEventListener('abort', abort)
    session.dispose()
  }
}

export async function compactPiSession(req: AgentRequest, options: Pick<PiRunOptions, 'agentDir' | 'sessionDir'>, instructions?: string) {
  await mkdir(options.agentDir, { recursive: true })
  await mkdir(options.sessionDir, { recursive: true })
  const cwd = req.settings.workspace || process.cwd()
  const modelRuntime = await createModelRuntime(req)
  const model = modelRuntime.getModel(providerId(req), req.settings.model)
  if (!model) throw Error(`Model ${req.settings.model} is unavailable.`)
  const sessionManager = await openSessionManager(req.taskId || req.id, cwd, options.sessionDir)
  seedLegacyHistory(sessionManager, req, model)
  const settingsManager = SettingsManager.create(cwd, options.agentDir)
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: options.agentDir,
    settingsManager,
    noExtensions: true,
    systemPrompt: productSystemPrompt(req.settings.model),
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({ cwd, agentDir: options.agentDir, modelRuntime, model, noTools: 'all', resourceLoader, settingsManager, sessionManager })
  try {
    const result = await session.compact(instructions)
    return result.summary
  } finally { session.dispose() }
}

async function createModelRuntime(req: AgentRequest) {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null })
  const selected = req.settings.providers.find(provider => provider.id === req.settings.providerId)
  const id = providerId(req)
  const deepSeek = /deepseek/i.test([id, selected?.name, req.settings.model, req.settings.endpoint].filter(Boolean).join(' '))
  const reasoning = deepSeek || /(?:reason|thinking|qwq|r1(?:\b|-)|o[134](?:\b|-))/i.test(req.settings.model)
  runtime.registerProvider(id, {
    name: selected?.name || id,
    baseUrl: req.settings.endpoint.replace(/\/+$/, ''),
    apiKey: req.settings.apiKey || 'shun-local',
    authHeader: Boolean(req.settings.apiKey),
    api: 'openai-completions',
    models: [{
      id: req.settings.model,
      name: req.settings.model,
      api: 'openai-completions',
      reasoning,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: req.settings.contextWindow,
      maxTokens: req.settings.maxTokens,
      samplingParams: { temperature: req.settings.temperature },
      ...(deepSeek ? { compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: 'deepseek' as const } } : {}),
    }],
  })
  return runtime
}

function providerId(req: AgentRequest) {
  return req.settings.providerId || 'shun-provider'
}

async function openSessionManager(id: string, cwd: string, sessionDir: string) {
  const existing = (await SessionManager.listAll(sessionDir)).find(session => session.id === id)
  return existing ? SessionManager.open(existing.path, sessionDir, cwd) : SessionManager.create(cwd, sessionDir, { id })
}

function seedLegacyHistory(manager: SessionManager, req: AgentRequest, model: Model<any>) {
  if (manager.getEntries().length || !req.history.length) return
  for (const message of req.history) {
    if (message.role === 'user') manager.appendMessage({ role: 'user', content: message.content, timestamp: Date.now() })
    else manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: message.content }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage,
      stopReason: 'stop',
      timestamp: Date.now(),
    })
  }
}

function ensurePersistedRuntimeSelection(manager: SessionManager, model: Model<any>, thinkingLevel: ThinkingLevel) {
  const context = manager.buildSessionContext()
  if (!context.messages.length) return
  if (context.model?.provider !== model.provider || context.model?.modelId !== model.id) {
    manager.appendModelChange(model.provider, model.id)
  }
  const savedThinking = [...manager.getBranch()].reverse().find(entry => entry.type === 'thinking_level_change')
  if (!savedThinking || savedThinking.thinkingLevel !== thinkingLevel) manager.appendThinkingLevelChange(thinkingLevel)
}

function installProductPolicy(session: AgentSession, before?: PiRunOptions['beforeToolCall'], outcome?: OutcomePolicy) {
  const extensionBefore = session.agent.beforeToolCall
  if (before) {
    session.agent.beforeToolCall = async (context, signal) => {
      const extensionResult = await extensionBefore?.(context, signal)
      if (extensionResult?.block) return extensionResult
      return before(context, signal)
    }
  }
  if (outcome) {
    const extensionPrepare = session.agent.prepareNextTurnWithContext
    session.agent.prepareNextTurnWithContext = async (turn, signal) => {
      const update = await extensionPrepare?.(turn, signal)
      const verdict = await outcome.evaluate(turn)
      if (verdict.status === 'continue' && verdict.feedback) await session.steer(verdict.feedback)
      return update
    }
  }
}

function forwardSessionEvent(req: AgentRequest, session: AgentSession, event: AgentSessionEvent, toolInputs: Map<string, string>, emit: (event: AgentEvent) => void) {
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent
    if (update.type === 'text_delta') emit({ id: req.id, type: 'delta', text: update.delta })
    else if (update.type === 'thinking_delta') emit({ id: req.id, type: 'reasoning', text: update.delta })
    return
  }
  if (event.type === 'tool_execution_start') {
    const input = JSON.stringify(event.args)
    toolInputs.set(event.toolCallId, input)
    emit({ id: req.id, type: 'tool', tool: { id: event.toolCallId, name: event.toolName, input, state: 'running' } })
    return
  }
  if (event.type === 'tool_execution_update') {
    emit({ id: req.id, type: 'tool', tool: { id: event.toolCallId, name: event.toolName, input: JSON.stringify(event.args), output: resultText(event.partialResult.content), state: 'running' } })
    return
  }
  if (event.type === 'tool_execution_end') {
    const details: any = event.result.details
    const tool: ToolEvent = {
      id: event.toolCallId,
      name: event.toolName,
      input: toolInputs.get(event.toolCallId) || '{}',
      output: resultText(event.result.content),
      ...(typeof details?.patch === 'string' || typeof details?.diff === 'string' ? { diff: details.patch || details.diff } : {}),
      state: event.isError ? 'error' : 'done',
    }
    toolInputs.delete(event.toolCallId)
    emit({ id: req.id, type: 'tool', tool })
    emitContext(req.id, session, emit)
    return
  }
  if (event.type === 'compaction_start') {
    emit({ id: req.id, type: 'context', context: { state: 'compacting', usedCharacters: 0, budgetCharacters: req.settings.contextWindow * 3 } })
    return
  }
  if (event.type === 'compaction_end') {
    emit({ id: req.id, type: 'compacted', text: event.result?.summary || '' })
  }
}

function emitContext(id: string, session: AgentSession, emit: (event: AgentEvent) => void) {
  const usage = session.getContextUsage()
  if (!usage) return
  const context: ContextUsage = {
    state: 'ready',
    usedCharacters: Math.max(0, (usage.tokens || 0) * 3),
    budgetCharacters: usage.contextWindow * 3,
    usedTokens: usage.tokens || 0,
    budgetTokens: usage.contextWindow,
    exactTokens: usage.tokens !== null,
  }
  emit({ id, type: 'context', context })
}

function resultText(content: Array<{ type: string; text?: string }>) {
  return content.filter(item => item.type === 'text').map(item => item.text || '').join('\n')
}
