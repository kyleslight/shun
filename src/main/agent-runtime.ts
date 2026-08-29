import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Skill,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { AgentMessage, BeforeToolCallContext, ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ImageContent, Model, Usage } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { normalizeProviderConnection, type AgentEvent, type AgentRequest, type AttachmentRef, type ContextBreakdown, type ContextUsage, type ToolEvent } from '../shared.ts'
import type { OutcomePolicy } from './outcome-policy.ts'
import { capabilityPrompt, productSystemPrompt } from './capabilities.ts'
import { skillEnabled } from './skill-manager.ts'

export type AgentRunOptions = {
  agentDir: string
  sessionDir: string
  cwd?: string
  customTools?: ToolDefinition[]
  deferredTools?: DeferredTool[]
  additionalSkills?: Skill[]
  enableSkillSearch?: boolean
  activeTools: string[]
  initialImages?: ImageContent[]
  materializeToolResultImages?: (result: ToolResultImages) => Promise<AttachmentRef[]>
  enableExtensionTools?: boolean
  extensionToolNames?: string[]
  resolveProjectTrust?: () => Promise<boolean>
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<{ block?: boolean; reason?: string; terminate?: boolean } | undefined>
  outcomePolicy?: OutcomePolicy
  branchFrom?: { entryId: string | null }
  beforePrompt?: (context: { parentEntryId: string | null }) => Promise<void>
}

export type DeferredTool = {
  ownerId: string
  ownerName: string
  tool: ToolDefinition
}

export type ToolResultImages = {
  toolCallId: string
  toolName: string
  images: Array<{ mimeType: string; data: string }>
}

type SearchableTool = {
  ownerId: string
  ownerName: string
  name: string
  description: string
}

const TOOL_SEARCH_NAME = 'plugin_tool_search'
const SKILL_SEARCH_NAME = 'skill_search'
const MAX_INLINE_SKILLS = 20
const builtInToolNames = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])

const zeroUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

export async function runAgentSession(
  req: AgentRequest,
  signal: AbortSignal,
  emit: (event: AgentEvent) => void,
  options: AgentRunOptions,
) {
  await mkdir(options.agentDir, { recursive: true })
  await mkdir(options.sessionDir, { recursive: true })
  const cwd = options.cwd || req.settings.workspace || process.cwd()
  const modelRuntime = await createModelRuntime(req)
  const model = modelRuntime.getModel(providerId(req), req.settings.model)
  if (!model) throw Error(`Model ${req.settings.model} is unavailable.`)
  const sessionManager = await openSessionManager(req.taskId || req.id, cwd, options.sessionDir)
  if (options.branchFrom) {
    if (options.branchFrom.entryId) sessionManager.branch(options.branchFrom.entryId)
    else sessionManager.resetLeaf()
  } else {
    branchPastCrossModelThinkingAbort(sessionManager, model)
  }
  seedLegacyHistory(sessionManager, req, model)
  await options.beforePrompt?.({ parentEntryId: sessionManager.getLeafId() })
  const thinkingLevel: ThinkingLevel = model.reasoning ? 'medium' : 'off'
  ensurePersistedRuntimeSelection(sessionManager, model, thinkingLevel)
  const settingsManager = SettingsManager.create(cwd, options.agentDir)
  let sessionRef: AgentSession | undefined
  let searchableSkills: Skill[] = []
  const deferredTools = options.deferredTools || []
  const previouslyDisclosedToolNames = new Set(sessionManager.getBranch().flatMap(entry =>
    entry.type === 'message' && entry.message.role === 'toolResult'
      ? entry.message.addedToolNames || []
      : [],
  ))
  const customToolNames = new Set(options.customTools?.map(tool => tool.name) || [])
  const searchableTools = (session: AgentSession): SearchableTool[] => {
    const product = deferredTools.map(item => ({
      ownerId: item.ownerId,
      ownerName: item.ownerName,
      name: item.tool.name,
      description: item.tool.description,
    }))
    const extensions = options.enableExtensionTools
      ? session.getAllTools()
        .filter(tool => !builtInToolNames.has(tool.name) && !customToolNames.has(tool.name) && tool.name !== TOOL_SEARCH_NAME)
        .filter(tool => !options.extensionToolNames || options.extensionToolNames.includes(tool.name))
        .map(tool => ({ ownerId: 'extension', ownerName: 'Enabled extension', name: tool.name, description: tool.description || '' }))
      : []
    return [...product, ...extensions]
  }
  const searchTool = options.enableExtensionTools || deferredTools.length
    ? createPluginToolSearch(() => {
      const session = sessionRef
      return session ? searchableTools(session) : []
    }, () => sessionRef)
    : undefined
  const skillSearchTool = options.enableSkillSearch ? createSkillSearch(() => searchableSkills) : undefined
  const sessionActiveTools = [...new Set([
    ...options.activeTools,
    ...(searchTool ? [TOOL_SEARCH_NAME] : []),
    ...(skillSearchTool ? [SKILL_SEARCH_NAME] : []),
  ])]
  const capabilityTools = [...new Set([...sessionActiveTools, ...deferredTools.map(item => item.tool.name)])]
  const customTools = [...(options.customTools || []), ...(searchTool ? [searchTool] : []), ...(skillSearchTool ? [skillSearchTool] : [])]
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: options.agentDir,
    settingsManager,
    systemPrompt: productSystemPrompt(req.settings.model),
    appendSystemPrompt: capabilityPrompt(capabilityTools),
    skillsOverride: current => {
      const selectedSkills = req.capabilities?.skillIds ? new Set(req.capabilities.skillIds.map(id => id.toLowerCase())) : undefined
      const selected = (name: string) => !selectedSkills || selectedSkills.has(name.toLowerCase()) || selectedSkills.has(`skill:${name.toLowerCase()}`)
      const skills = current.skills.filter(skill => skillEnabled(req.settings, skill.name) && selected(skill.name))
      const names = new Set(skills.map(skill => skill.name))
      for (const skill of options.additionalSkills || []) if (selected(skill.name) && !names.has(skill.name)) {
        skills.push(skill)
        names.add(skill.name)
      }
      searchableSkills = skills.filter(skill => !skill.disableModelInvocation)
      if (!options.enableSkillSearch || searchableSkills.length <= MAX_INLINE_SKILLS) return { ...current, skills }
      const inline = new Set([...searchableSkills].sort((a, b) => skillPromptPriority(b) - skillPromptPriority(a) || a.name.localeCompare(b.name)).slice(0, MAX_INLINE_SKILLS).map(skill => skill.name))
      return {
        ...current,
        skills: skills.map(skill => !skill.disableModelInvocation && !inline.has(skill.name) ? { ...skill, disableModelInvocation: true } : skill),
      }
    },
  })
  await resourceLoader.reload({ resolveProjectTrust: options.resolveProjectTrust || (async () => false) })
  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir: options.agentDir,
    modelRuntime,
    model,
    thinkingLevel,
    ...(searchTool
      ? { noTools: sessionActiveTools.some(name => ['read', 'bash', 'edit', 'write'].includes(name)) ? undefined : 'builtin' as const }
      : { tools: sessionActiveTools }),
    customTools,
    resourceLoader,
    settingsManager,
    sessionManager,
  })
  sessionRef = session
  if (extensionsResult.errors.length) {
    emit({ id: req.id, type: 'phase', text: `Extension warning: ${extensionsResult.errors.map(error => `${error.path}: ${error.error}`).join('; ')}` })
  }
  const currentlySearchableToolNames = new Set(searchableTools(session).map(tool => tool.name))
  const restoredDeferredToolNames = [...previouslyDisclosedToolNames].filter(name => currentlySearchableToolNames.has(name))
  session.setActiveToolsByName([...new Set([...sessionActiveTools, ...restoredDeferredToolNames])])
  session.setAutoCompactionEnabled(true)
  const extensionNames = new Set(session.getAllTools()
    .map(tool => tool.name)
    .filter(name => !builtInToolNames.has(name) && !customTools.some(tool => tool.name === name)))
  const allowedExtensionNames = options.extensionToolNames ? new Set(options.extensionToolNames) : undefined
  const beforeToolCall = async (context: BeforeToolCallContext, toolSignal?: AbortSignal) => {
    if (allowedExtensionNames && extensionNames.has(context.toolCall.name) && !allowedExtensionNames.has(context.toolCall.name)) {
      return { block: true, reason: `Extension tool ${context.toolCall.name} is not enabled for this task.` }
    }
    return options.beforeToolCall?.(context, toolSignal)
  }
  installProductPolicy(session, beforeToolCall, options.outcomePolicy)
  const toolInputs = new Map<string, string>()
  const pendingForwards = new Set<Promise<void>>()
  const unsubscribe = session.subscribe(event => {
    options.outcomePolicy?.observe(event)
    const pending = forwardSessionEvent(req, session, event, toolInputs, emit, options.materializeToolResultImages)
    if (pending) {
      pendingForwards.add(pending)
      void pending.finally(() => pendingForwards.delete(pending))
    }
  })
  const abort = () => { void session.abort() }
  signal.addEventListener('abort', abort, { once: true })
  emit({ id: req.id, type: 'phase', text: req.settings.language === 'zh-CN' ? '思考中' : 'Thinking' })
  try {
    await session.prompt(req.text, options.initialImages?.length ? { images: options.initialImages } : undefined)
    await session.waitForIdle()
    await Promise.all([...pendingForwards])
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

function createSkillSearch(catalog: () => Skill[]): ToolDefinition {
  return defineTool({
    name: SKILL_SEARCH_NAME,
    label: 'Find installed Skills',
    description: 'Search installed and enabled Agent Skills by capability. Returns exact Skill metadata and SKILL.md locations for progressive disclosure; it does not search remote catalogs or install anything.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 240 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    }, { additionalProperties: false }),
    execute: async (_id, args) => {
      const matches = searchSkills(catalog(), args.query, args.limit)
      return {
        content: [{
          type: 'text' as const,
          text: matches.length
            ? `Installed Skill matches:\n${matches.map(skill => `${skill.name} — ${skill.description}\nSKILL.md: ${skill.filePath}`).join('\n\n')}\nLoad the relevant SKILL.md with the canonical read tool before following it.`
            : `No enabled installed Skill matched ${JSON.stringify(args.query)}.`,
        }],
        details: { query: args.query, matches: matches.map(skill => skill.name) },
      }
    },
  })
}

export function searchSkills(catalog: Skill[], query: string, limit = 3) {
  const terms = normalizeSearchTerms(query)
  const phrase = query.trim().toLowerCase()
  return catalog
    .map(skill => {
      const name = skill.name.toLowerCase(), description = skill.description.toLowerCase()
      let score = phrase && name.includes(phrase) ? 20 : 0
      for (const term of terms) {
        if (name.includes(term)) score += 8
        if (description.includes(term)) score += 3
      }
      return { skill, score }
    })
    .filter(match => match.score >= 3)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, Math.max(1, Math.min(5, Number(limit) || 3)))
    .map(match => match.skill)
}

function skillPromptPriority(skill: Skill) {
  if (skill.sourceInfo?.scope === 'project') return 3
  if (skill.sourceInfo?.source === 'product-plugin') return 2
  return 1
}

function createPluginToolSearch(
  catalog: () => SearchableTool[],
  session: () => AgentSession | undefined,
): ToolDefinition {
  return defineTool({
    name: TOOL_SEARCH_NAME,
    label: 'Find plugin tools',
    description: 'Search tools supplied by plugins and extensions already enabled for this task, then expose a small set of matching exact tool schemas. This never installs, connects, or enables a plugin.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 240 }),
      plugin: Type.Optional(Type.String({ maxLength: 120 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    }, { additionalProperties: false }),
    execute: async (_id, args) => {
      const current = session()
      if (!current) throw Error('Plugin tool search is unavailable before the task session starts.')
      const matches = searchPluginTools(catalog(), args.query, args.plugin, args.limit)
      const active = current.getActiveToolNames()
      const added = matches.map(item => item.name).filter(name => !active.includes(name))
      if (added.length) current.setActiveToolsByName([...new Set([...active, ...added])])
      const rows = matches.map(item => `${item.name} — ${item.description || 'No description.'} [${item.ownerName}]`)
      return {
        content: [{
          type: 'text' as const,
          text: matches.length
            ? `${added.length ? `Loaded exact tools: ${added.join(', ')}` : 'Matching tools were already active.'}\n${rows.join('\n')}`
            : `No enabled plugin tool matched ${JSON.stringify(args.query)}.`,
        }],
        details: { query: args.query, matches: matches.map(item => item.name), added },
      }
    },
  })
}

export function searchPluginTools(catalog: SearchableTool[], query: string, plugin?: string, limit = 3) {
  const terms = normalizeSearchTerms(query)
  const owner = String(plugin || '').trim().toLowerCase()
  const boundedLimit = Math.max(1, Math.min(5, Number(limit) || 3))
  return catalog
    .filter(item => !owner || item.ownerId.toLowerCase() === owner || item.ownerName.toLowerCase() === owner)
    .map(item => ({ item, score: toolSearchScore(item, query, terms) }))
    .filter(match => match.score >= 3)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, boundedLimit)
    .map(match => match.item)
}

function normalizeSearchTerms(value: string) {
  return value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 1)
}

function toolSearchScore(item: SearchableTool, query: string, terms: string[]) {
  const name = item.name.toLowerCase(), description = item.description.toLowerCase()
  const owner = `${item.ownerId} ${item.ownerName}`.toLowerCase(), phrase = query.trim().toLowerCase()
  let score = phrase && name.includes(phrase) ? 20 : 0
  for (const term of terms) {
    if (name.includes(term)) score += 8
    if (description.includes(term)) score += 3
    if (owner.includes(term)) score += 2
  }
  return score
}

export async function runUtilityPrompt(
  req: AgentRequest,
  prompt: string,
  signal: AbortSignal,
  options: Pick<AgentRunOptions, 'agentDir' | 'cwd'>,
) {
  await mkdir(options.agentDir, { recursive: true })
  const cwd = options.cwd || req.settings.workspace || process.cwd()
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
    thinkingLevel: utilityThinkingLevel(model),
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

export function utilityThinkingLevel(model: Pick<Model<any>, 'reasoning'>): ThinkingLevel {
  return model.reasoning ? 'low' : 'off'
}

export function configureManualCompaction(settingsManager: SettingsManager) {
  settingsManager.applyOverrides({
    compaction: {
      ...settingsManager.getCompactionSettings(),
      enabled: true,
      keepRecentTokens: 1,
    },
  })
}

export async function compactAgentSession(req: AgentRequest, options: Pick<AgentRunOptions, 'agentDir' | 'sessionDir' | 'cwd'>, instructions?: string) {
  await mkdir(options.agentDir, { recursive: true })
  await mkdir(options.sessionDir, { recursive: true })
  const cwd = options.cwd || req.settings.workspace || process.cwd()
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
  configureManualCompaction(settingsManager)
  const { session } = await createAgentSession({ cwd, agentDir: options.agentDir, modelRuntime, model, thinkingLevel: utilityThinkingLevel(model), noTools: 'all', resourceLoader, settingsManager, sessionManager })
  try {
    const result = await session.compact(instructions)
    return result.summary
  } finally { session.dispose() }
}

async function createModelRuntime(req: AgentRequest) {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null })
  const selected = req.settings.providers.find(provider => provider.id === req.settings.providerId)
  const selectedModel = selected?.models?.find(model => model.id === req.settings.model)
  const id = providerId(req)
  const deepSeek = /deepseek/i.test([id, selected?.name, req.settings.model, req.settings.endpoint].filter(Boolean).join(' '))
  const reasoning = selectedModel?.reasoning ?? (deepSeek || /(?:reason|thinking|qwq|r1(?:\b|-)|o[134](?:\b|-))/i.test(req.settings.model))
  const { api, endpoint } = resolveAgentProviderConnection(req)
  runtime.registerProvider(id, {
    name: selected?.name || id,
    baseUrl: endpoint,
    apiKey: req.settings.apiKey || 'shun-local',
    authHeader: api === 'openai-completions' && Boolean(req.settings.apiKey),
    api,
    models: [{
      id: req.settings.model,
      name: req.settings.model,
      api,
      reasoning,
      // Tool results can introduce screenshots after a text-only prompt. Declaring
      // Image input up front lets the runtime carry those results to a vision-capable model;
      // providers that truly reject images remain the source of truth.
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: req.settings.contextWindow,
      maxTokens: req.settings.maxTokens,
      samplingParams: { temperature: req.settings.temperature },
      ...(deepSeek && api === 'openai-completions' ? { compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: 'deepseek' as const } } : {}),
    }],
  })
  return runtime
}

export function resolveAgentProviderConnection(req: AgentRequest) {
  const selected = req.settings.providers.find(provider => provider.id === req.settings.providerId)
  return normalizeProviderConnection({ api: selected?.api, endpoint: req.settings.endpoint })
}

function providerId(req: AgentRequest) {
  return req.settings.providerId || 'shun-provider'
}

async function openSessionManager(id: string, cwd: string, sessionDir: string) {
  const existing = (await SessionManager.listAll(sessionDir)).find(session => session.id === id)
  return existing ? SessionManager.open(existing.path, sessionDir, cwd) : SessionManager.create(cwd, sessionDir, { id })
}

export async function removeAgentSessions(id: string, sessionDir: string) {
  let names: string[]
  try { names = await readdir(sessionDir) } catch { return 0 }
  const suffix = `_${id}.jsonl`, matches = names.filter(name => name.endsWith(suffix))
  await Promise.all(matches.map(name => rm(join(sessionDir, name), { force: true })))
  return matches.length
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

export function branchPastCrossModelThinkingAbort(
  manager: SessionManager,
  model: Pick<Model<any>, 'provider' | 'id'>,
) {
  const leaf = manager.getLeafEntry()
  if (leaf?.type !== 'message' || leaf.message.role !== 'assistant' || leaf.message.stopReason !== 'aborted') return false
  const content = leaf.message.content
  if (!content.length || content.some(block => block.type !== 'thinking')) return false
  if (leaf.message.provider === model.provider && leaf.message.model === model.id) return false
  if (leaf.parentId) manager.branch(leaf.parentId)
  else manager.resetLeaf()
  return true
}

function installProductPolicy(session: AgentSession, before?: AgentRunOptions['beforeToolCall'], outcome?: OutcomePolicy) {
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

function forwardSessionEvent(
  req: AgentRequest,
  session: AgentSession,
  event: AgentSessionEvent,
  toolInputs: Map<string, string>,
  emit: (event: AgentEvent) => void,
  materializeToolResultImages?: AgentRunOptions['materializeToolResultImages'],
): Promise<void> | void {
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
    const base: ToolEvent = {
      id: event.toolCallId,
      name: event.toolName,
      input: toolInputs.get(event.toolCallId) || '{}',
      output: resultText(event.result.content),
      ...(typeof details?.patch === 'string' || typeof details?.diff === 'string' ? { diff: details.patch || details.diff } : {}),
      ...(typeof details?.changed === 'boolean' ? { changed: details.changed } : {}),
      ...(['plugin_view_present', 'background_start', 'browser_debug', 'browser_preview_act'].includes(event.toolName) && details?.pluginView && typeof details.pluginView === 'object' ? { pluginView: details.pluginView } : {}),
      state: event.isError ? 'error' : 'done',
    }
    toolInputs.delete(event.toolCallId)
    const images = resultImages(event.result.content)
    if (!images.length || !materializeToolResultImages) {
      emit({ id: req.id, type: 'tool', tool: base })
      emitContext(req.id, session, emit)
      return
    }
    return materializeToolResultImages({ toolCallId: event.toolCallId, toolName: event.toolName, images })
      .then(attachments => {
        emit({ id: req.id, type: 'tool', tool: attachments.length ? { ...base, attachments } : base })
        emitContext(req.id, session, emit)
      })
      .catch(error => {
        console.warn(`[tool-image:${event.toolName}]`, error)
        emit({ id: req.id, type: 'tool', tool: base })
        emitContext(req.id, session, emit)
      })
  }
  if (event.type === 'compaction_start') {
    emit({ id: req.id, type: 'context', context: contextUsage(session, 'compacting', req.settings.contextWindow) })
    return
  }
  if (event.type === 'compaction_end') {
    emit({
      id: req.id,
      type: 'context',
      context: contextUsage(session, 'compacted', req.settings.contextWindow),
    })
    emit({ id: req.id, type: 'compacted', text: event.result?.summary || '' })
  }
}

function emitContext(id: string, session: AgentSession, emit: (event: AgentEvent) => void) {
  const usage = session.getContextUsage()
  if (!usage) return
  emit({ id, type: 'context', context: contextUsage(session, 'ready', usage.contextWindow) })
}

type ContextToolInfo = {
  name: string
  description?: string
  parameters?: unknown
  promptGuidelines?: unknown
}

/**
 * Provider usage is authoritative for the total, but providers do not expose a
 * category breakdown. Estimate categories from the exact prompt and active tool
 * schemas the runtime is about to send, then assign the remainder to conversation data.
 */
export function estimateContextBreakdown(totalTokens: number, systemPrompt: string, tools: ContextToolInfo[]): ContextBreakdown {
  const active = tools.map(tool => ({
    name: tool.name,
    description: tool.description || '',
    parameters: tool.parameters || {},
    promptGuidelines: tool.promptGuidelines || [],
  }))
  const mcpTools = active.filter(tool => tool.name === 'mcp_list' || tool.name === 'mcp_call')
  const regularTools = active.filter(tool => tool.name !== 'mcp_list' && tool.name !== 'mcp_call')
  const estimates = [
    estimateTextTokens(systemPrompt),
    estimateTextTokens(safeJson(regularTools)),
    estimateTextTokens(safeJson(mcpTools)),
  ]
  const fixed = estimates.reduce((sum, value) => sum + value, 0)
  if (fixed > totalTokens && fixed > 0) {
    const scale = totalTokens / fixed
    const scaled = estimates.map(value => Math.floor(value * scale))
    scaled[0] += Math.max(0, totalTokens - scaled.reduce((sum, value) => sum + value, 0))
    return { systemTokens: scaled[0], toolTokens: scaled[1], mcpTokens: scaled[2], conversationTokens: 0, estimated: true }
  }
  return {
    systemTokens: estimates[0],
    toolTokens: estimates[1],
    mcpTokens: estimates[2],
    conversationTokens: Math.max(0, totalTokens - fixed),
    estimated: true,
  }
}

function contextUsage(session: AgentSession, state: ContextUsage['state'], fallbackWindow: number): ContextUsage {
  const usage = session.getContextUsage()
  const usedTokens = Math.max(0, usage?.tokens || 0)
  const activeNames = new Set(session.getActiveToolNames())
  return {
    state,
    usedCharacters: usedTokens * 3,
    budgetCharacters: (usage?.contextWindow || fallbackWindow) * 3,
    usedTokens,
    budgetTokens: usage?.contextWindow || fallbackWindow,
    exactTokens: usage?.tokens != null,
    breakdown: estimateContextBreakdown(
      usedTokens,
      session.systemPrompt,
      session.getAllTools().filter(tool => activeNames.has(tool.name)),
    ),
  }
}

function estimateTextTokens(value: string) {
  if (!value) return 0
  let ascii = 0
  for (const character of value) ascii += character.charCodeAt(0) <= 0x7f ? 1 : 0
  return Math.ceil(ascii / 4 + (value.length - ascii) / 1.5)
}

function safeJson(value: unknown) {
  try { return JSON.stringify(value) } catch { return '' }
}

function resultText(content: Array<{ type: string; text?: string }>) {
  return content.filter(item => item.type === 'text').map(item => item.text || '').join('\n')
}

function resultImages(content: Array<{ type: string; mimeType?: string; data?: string }>) {
  return content.flatMap(item => item.type === 'image' && typeof item.mimeType === 'string' && typeof item.data === 'string'
    ? [{ mimeType: item.mimeType, data: item.data }]
    : [])
}
