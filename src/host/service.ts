import { generateTaskTitle, taskTitleFromMessage } from '../main/task-title.ts'
import { recentConversations } from '../conversation-list.ts'
import { modelLimits } from '../provider-settings.ts'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { hasTrustRequiringProjectResources, ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { removeAgentSessions, runAgentSession, type AgentRunOptions } from '../main/agent-runtime.ts'
import { AttachmentStore } from '../main/attachments.ts'
import { previewAttachment } from '../main/attachment-preview.ts'
import { TaskEventStore } from '../main/task-events.ts'
import { TaskRunRegistry } from '../main/task-runs.ts'
import { BackgroundTaskManager } from '../main/background-tasks.ts'
import { SkillManager } from '../main/skill-manager.ts'
import { listProviderModels, testModelDeployment, formatProviderFailure } from '../main/provider-connection.ts'
import { normalizeModelsDevCatalog } from '../main/provider-catalog.ts'
import type { AgentEvent, AgentRequest, Provider, ProviderApi, Settings, TaskEventEnvelope, TaskProductEvent, Turn } from '../shared.ts'
import { applyHostEvent, HOST_PROTOCOL, type HostCall, type HostSnapshot, type HostState, type HostTask } from './protocol.ts'
import { hostPaths } from './paths.ts'
import { capabilityHome, connectProductCapabilities } from './product-capabilities.ts'
import { createHostClient } from './transport.ts'
import { hostPackageCapabilities } from './package-capabilities.ts'
import { applyDefaultPluginInstallations } from '../shared.ts'
import { HostBrowserPreview } from './browser-preview.ts'
import { hostTools } from './tools.ts'
import { ProviderSettingsStore, desktopStatePath, providerSettings, providerSettingsPath } from './provider-settings.ts'

type Runner = (request: AgentRequest, signal: AbortSignal, emit: (event: AgentEvent) => void, options: AgentRunOptions) => Promise<unknown>
const apis = new Set<ProviderApi>(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'bedrock-converse-stream', 'azure-openai-responses'])
const defaults: Settings = { endpoint: '', apiKey: '', providerId: '', providers: [], model: '', workspace: '', temperature: .2, maxTokens: 8192, contextWindow: 32768, autoCompact: true, language: 'system' }
function text(value: unknown, label: string, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`${label} is required (maximum ${max} characters).`)
  return value.trim()
}

export class ShunHostService {
  readonly paths: ReturnType<typeof hostPaths>
  readonly events: TaskEventStore
  readonly attachments: AttachmentStore
  readonly background: BackgroundTaskManager
  readonly preview: HostBrowserPreview
  readonly runs = new TaskRunRegistry()
  private state!: HostState
  private writes: Promise<unknown> = Promise.resolve()
  private active = new Map<string, { controller: AbortController; settled: Promise<void> }>()
  private closing = false
  private titleJobs = new Set<Promise<void>>()
  private readonly providerStore: ProviderSettingsStore
  private readonly desktop?: HostCall
  private readonly titleGenerator: typeof generateTaskTitle
  private readonly runner: Runner
  private readonly tails = new Map<string, TaskEventEnvelope[]>()

  constructor(home?: string, runner: Runner = runAgentSession, desktop?: HostCall, titleGenerator = generateTaskTitle) {
    this.desktop = desktop || (!home && !process.env.SHUN_HOME ? createHostClient(capabilityHome(hostPaths().root)) : undefined)
    this.runner = runner
    this.titleGenerator = titleGenerator
    this.paths = hostPaths(home)
    this.preview = new HostBrowserPreview(this.paths.root)
    this.providerStore = new ProviderSettingsStore(providerSettingsPath(this.paths.root), home && !process.env.SHUN_USER_DATA ? undefined : desktopStatePath())
    this.events = new TaskEventStore(join(this.paths.serviceRoot, 'events'))
    this.events.subscribe(event => {
      const tail = this.tails.get(event.taskId) || []
      tail.push(event)
      if (tail.length > 2000) tail.splice(0, tail.length - 2000)
      this.tails.set(event.taskId, tail)
    })
    this.attachments = new AttachmentStore(join(this.paths.serviceRoot, 'attachments'))
    this.background = new BackgroundTaskManager(() => {}, { storageFile: join(this.paths.serviceRoot, 'processes.json') })
  }

  async initialize() {
    await mkdir(this.paths.serviceRoot, { recursive: true, mode: 0o700 })
    await chmod(this.paths.serviceRoot, 0o700)
    try {
      this.state = JSON.parse(await readFile(this.paths.state, 'utf8'))
      if (this.state.version !== 1 || !Array.isArray(this.state.tasks) || !Array.isArray(this.state.settings?.providers)) throw Error('Unsupported Shun service state.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.state = { version: 1, settings: structuredClone(defaults), tasks: [] }
      await this.persist()
    }
    // A service restart cannot continue an in-flight network request. Mark only
    // unfinished projections interrupted; the existing session remains resumable.
    for (const task of this.state.tasks) {
      const snapshot = await this.snapshot(task.id)
      task.hasMessages = snapshot.turns.some(turn => turn.role === 'user')
      const last = snapshot.turns.at(-1)
      if (last?.role === 'assistant' && !last.completedAt) await this.events.append(task.id, {
        type: 'agent', runId: last.id, event: { id: last.id, type: 'error', text: 'Shun service stopped during this run. Send a message to continue.' },
      })
    }
  }

  private persist() {
    // Opening the composer creates a draft, not a durable conversation.
    const bytes = JSON.stringify({ ...this.state, tasks: this.state.tasks.filter(task => task.hasMessages !== false) })
    const work = this.writes.then(async () => {
      const temporary = `${this.paths.state}.tmp`
      await writeFile(temporary, bytes, { mode: 0o600 })
      await rename(temporary, this.paths.state)
    })
    this.writes = work.catch(() => {})
    return work
  }

  private task(value: unknown) {
    const id = text(value, 'Task ID', 100)
    const task = this.state.tasks.find(item => item.id === id)
    if (!task) throw Error('Task not found.')
    return task
  }

  private provider(value: unknown) {
    const id = text(value, 'Provider ID', 100)
    const provider = this.state.settings.providers.find(item => item.id === id)
    if (!provider) throw Error('Provider not found.')
    return provider
  }

  private configuration() {
    return { providers: this.state.settings.providers.map(({ apiKey, ...provider }) => ({ ...provider, hasKey: Boolean(apiKey) })), providerId: this.state.settings.providerId, model: this.state.settings.model }
  }

  async snapshot(id: string): Promise<HostSnapshot> {
    const task = this.task(id), turns: Turn[] = []
    let sequence = 0
    const through = await this.events.lastSequence(id)
    while (sequence < through) {
      const page = await this.events.read(id, sequence, 2000)
      if (!page.length) break
      for (const event of page) {
        if (event.seq > through) break
        applyHostEvent(turns, event)
        sequence = event.seq
      }
    }
    const limits = modelLimits(this.state.settings, task.providerId, task.model)
    if (!this.runs.get(id)) {
      const latest = turns.findLast(turn => turn.contextUsage)
      if (latest?.contextUsage) latest.contextUsage = { ...latest.contextUsage, budgetTokens: limits.contextWindow, budgetCharacters: limits.contextWindow * 3 }
    }
    return { task: { ...task, ...limits }, turns, sequence, activeRun: this.runs.get(id), trustRequired: this.trustRequired(task) }
  }

  private trustRequired(task: HostTask) {
    const cwd = this.workingDirectory(task)
    return hasTrustRequiringProjectResources(cwd) && new ProjectTrustStore(this.paths.agentDir).get(cwd) === null
  }

  private workingDirectory(task: HostTask) { return task.workspace || join(this.paths.standaloneDir, task.id) }

  async call(method: string, input: Record<string, any> = {}): Promise<any> {
    const desktop = this.desktop
    const sharedDesktop = Boolean(desktop)
    if (sharedDesktop && method === 'task.list' && !input.localOnly) {
      const local = await this.dispatch(method, input)
      const remote = await desktop!('conversation.task.list').catch(() => [])
      return recentConversations([...local, ...remote.filter((task: HostTask) => !this.state.tasks.some(item => item.id === task.id))])
    }
    if (sharedDesktop && typeof input.taskId === 'string' && !this.state.tasks.some(task => task.id === input.taskId)) {
      return desktop!(`conversation.${method}`, input)
    }
    if (method === 'configuration' || method === 'task.snapshot' || method === 'task.events' || method.startsWith('provider.') || method === 'model.select' || method === 'task.create' || method === 'task.send') {
      const shared = await this.providerStore.sync(providerSettings(this.state.settings))
      Object.assign(this.state.settings, shared)
      const result = await this.dispatch(method, input)
      const next = providerSettings(this.state.settings)
      if (JSON.stringify(shared) !== JSON.stringify(next)) Object.assign(this.state.settings, await this.providerStore.sync(next, { next, base: shared }))
      return method === 'provider.save' || method === 'provider.remove' || method === 'model.select' ? this.configuration() : result
    }
    return this.dispatch(method, input)
  }

  private async dispatch(method: string, input: Record<string, any> = {}): Promise<any> {
    if (this.closing) throw Error('Shun service is stopping.')
    if (method === 'hello') return { protocol: HOST_PROTOCOL, pid: process.pid }
    if (method === 'configuration') return this.configuration()
    if (method === 'provider.catalog') return normalizeModelsDevCatalog({})
    if (method === 'provider.save') {
      const previous = input.id ? this.provider(input.id) : undefined
      const catalogId = input.catalogId ?? previous?.catalogId
      const preset = catalogId ? normalizeModelsDevCatalog({}).providers.find(item => item.id === catalogId) : undefined
      if (catalogId && !preset) throw Error('Unknown provider. Choose a provider from the list again.')
      const variant = input.variantId ? preset?.variants?.find(item => item.id === input.variantId) : undefined
      if (input.variantId && !variant) throw Error('Unknown provider plan.')
      if (preset && !previous) input = { ...input, name: variant?.name || preset.name, api: preset.api,
        endpoint: (variant || preset).requiresEndpoint ? input.endpoint : (variant || preset).endpoint }
      const endpoint = new URL(text(input.endpoint, 'Endpoint'))
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw Error('Use an HTTP(S) endpoint without embedded credentials.')
      const api = input.api || previous?.api || 'openai-completions'
      if (!apis.has(api)) throw Error('Unsupported provider API.')
      const contextWindow = Number(input.contextWindow ?? previous?.contextWindow ?? 32768)
      if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > 10_000_000) throw Error('Context window must be between 1024 and 10000000.')
      const provider: Provider = { id: previous?.id || randomUUID(), name: text(input.name, 'Provider name', 100), kind: 'custom', endpoint: endpoint.href.replace(/\/$/, ''), api, contextWindow,
        apiKey: input.apiKey === null ? '' : typeof input.apiKey === 'string' && input.apiKey ? input.apiKey : previous?.apiKey || '', models: previous?.models || preset?.models,
        catalogId }
      this.state.settings.providers = [...this.state.settings.providers.filter(item => item.id !== provider.id), provider]
      if (!this.state.settings.providerId) this.state.settings.providerId = provider.id
      await this.persist()
      return this.configuration()
    }
    if (method === 'provider.remove') {
      const provider = this.provider(input.id)
      if (this.state.tasks.some(task => task.providerId === provider.id && this.runs.get(task.id))) throw Error('Stop tasks using this provider first.')
      this.state.settings.providers = this.state.settings.providers.filter(item => item.id !== provider.id)
      if (this.state.settings.providerId === provider.id) { this.state.settings.providerId = ''; this.state.settings.model = '' }
      await this.persist()
      return this.configuration()
    }
    if (method === 'provider.models' || method === 'provider.test') {
      const provider = this.provider(input.id)
      if (method === 'provider.test') return testModelDeployment(provider.endpoint, provider.apiKey, text(input.model, 'Model'), fetch, provider.api)
      try {
        const models = await listProviderModels(provider.endpoint, provider.apiKey, provider.api)
        return models.length ? models : (provider.models || []).map(model => model.id)
      }
      catch (error) { if (provider.models?.length) return provider.models.map(model => model.id); throw error }
    }
    if (method === 'model.select') {
      const provider = this.provider(input.providerId), model = text(input.model, 'Model', 200)
      if (input.taskId) {
        const task = this.task(input.taskId)
        if (this.runs.get(task.id)) throw Error('Stop the task before changing its model.')
        task.providerId = provider.id; task.model = model
      } else { this.state.settings.providerId = provider.id; this.state.settings.model = model }
      await this.persist()
      return this.configuration()
    }
    if (method === 'task.list') return recentConversations(this.state.tasks.filter(task => task.hasMessages).map(task => ({ ...task, activeRun: this.runs.get(task.id) })))
    if (method === 'task.create') {
      const workspace = input.workspace === '' ? '' : resolve(text(input.workspace, 'Workspace'))
      if (workspace && !(await stat(workspace)).isDirectory()) throw Error('Workspace must be a directory.')
      const task: HostTask = { id: randomUUID(), title: 'New task', hasMessages: false, workspace, providerId: this.state.settings.providerId, model: this.state.settings.model, createdAt: Date.now(), updatedAt: Date.now() }
      if (!workspace) await mkdir(this.workingDirectory(task), { recursive: true, mode: 0o700 })
      this.state.tasks.push(task)
      await this.persist()
      return task
    }
    if (method === 'task.snapshot') return this.snapshot(this.task(input.taskId).id)
    if (method === 'task.events') {
      const task = this.task(input.taskId)
      const after = Number(input.after || 0)
      if (!Number.isSafeInteger(after) || after < 0) throw Error('Invalid event cursor.')
      const tail = this.tails.get(task.id)
      const events = tail?.length && after >= tail[0].seq - 1
        ? tail.filter(event => event.seq > after).slice(0, 500)
        : await this.events.read(task.id, after, 500)
      return { events, task: { ...task, ...modelLimits(this.state.settings, task.providerId, task.model) }, trustRequired: this.trustRequired(task), activeRun: this.runs.get(task.id) }
    }
    if (method === 'task.remote-state') {
      const task = this.task(input.taskId)
      if (!input.event || !['queue.snapshot', 'confirmation.request', 'confirmation.resolved', 'context.compaction'].includes(input.event.kind)) throw Error('Invalid remote task state.')
      return this.events.append(task.id, { type: 'remote', event: input.event })
    }
    if (method === 'task.trust') {
      const task = this.task(input.taskId)
      if (typeof input.trusted !== 'boolean') throw Error('Choose whether to trust the project.')
      new ProjectTrustStore(this.paths.agentDir).set(this.workingDirectory(task), input.trusted)
      return true
    }
    if (method === 'task.send') return this.send(input)
    if (method === 'task.stop') {
      const task = this.task(input.taskId)
      const active = this.active.get(task.id)
      active?.controller.abort()
      await active?.settled
      return true
    }
    if (method === 'task.rename') {
      const task = this.task(input.taskId)
      task.title = text(input.title, 'Title', 160)
      await this.persist(); return task
    }
    if (method === 'task.delete') {
      const task = this.task(input.taskId)
      if (this.runs.get(task.id) || this.background.list(task.id).some(item => ['starting', 'running', 'stopping'].includes(item.state))) throw Error('Stop this task and its background processes before deleting it.')
      this.state.tasks = this.state.tasks.filter(item => item.id !== task.id)
      await this.persist()
      await Promise.all([this.attachments.removeTask(task.id), this.events.remove(task.id), removeAgentSessions(task.id, this.paths.sessionDir)])
      this.tails.delete(task.id)
      this.background.discardSession(task.id)
      return true
    }
    if (method === 'attachment.add') {
      const task = this.task(input.taskId)
      if (typeof input.data !== 'string' || input.data.length > 28_000_000) throw Error('Attachment must be at most 20 MB.')
      return (await this.attachments.importBuffers(task.id, [{ name: text(input.name, 'Filename', 255), bytes: Buffer.from(input.data, 'base64') }]))[0]
    }
    if (method === 'attachment.preview') {
      const task = this.task(input.taskId)
      return previewAttachment(this.attachments, task.id, text(input.id, 'Attachment ID', 100), undefined, 'remote')
    }
    if (method === 'background.list') return this.background.listAll()
    if (method === 'background.read') return this.background.observe(this.task(input.taskId).id, text(input.id, 'Process ID'), { maxChars: 16000 })
    if (method === 'background.stop') return this.background.stop(this.task(input.taskId).id, text(input.id, 'Process ID'))
    if (method === 'skill.list') return new SkillManager(this.paths.agentDir).list(this.state.settings, input.taskId ? this.workingDirectory(this.task(input.taskId)) : '')
    if (method === 'skill.toggle') {
      const id = text(input.id, 'Skill ID', 200)
      if (!id.startsWith('skill:') || typeof input.enabled !== 'boolean') throw Error('Invalid Skill selection.')
      this.state.settings.skills = [...(this.state.settings.skills || []).filter(item => item.id !== id), { id, enabled: input.enabled }]
      await this.persist(); return true
    }
    if (method === 'skill.install') return new SkillManager(this.paths.agentDir).installSource(text(input.source, 'Skill source'), this.state.settings, '')
    throw Error('This Shun service does not support that operation. Update Shun and reconnect.')
  }

  private async send(input: Record<string, any>) {
    const task = this.task(input.taskId)
    const message = typeof input.text === 'string' ? input.text.trim() : ''
    const ids = input.attachments ?? []
    if (!Array.isArray(ids) || ids.length > 16 || ids.some(id => typeof id !== 'string')) throw Error('Choose at most 16 attachments.')
    if ((!message && !ids.length) || message.length > 200_000) throw Error('Enter a message or attach an image (maximum 200000 characters).')
    if (this.trustRequired(task)) throw Error('Choose whether to trust project configuration before starting this task.')
    const provider = this.provider(task.providerId)
    if (!task.model) throw Error('Choose a model first.')
    const runId = input.runId || randomUUID(), messageId = input.messageId || randomUUID()
    if (![runId, messageId].every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id))) throw Error('Invalid message identity.')
    if (input.runId) {
      const snapshot = await this.snapshot(task.id)
      if (snapshot.turns.some(turn => turn.id === runId) && snapshot.turns.some(turn => turn.id === messageId)) return { runId, duplicate: true }
    }
    if (this.runs.claim(task.id, runId)) throw Error('This task is already running. Stop it or wait for it to finish.')
    const controller = new AbortController()
    const settings: Settings = { ...structuredClone(this.state.settings), providerId: provider.id, endpoint: provider.endpoint, apiKey: provider.apiKey, model: task.model, ...modelLimits(this.state.settings, task.providerId, task.model), workspace: task.workspace }
    let finish!: () => void
    const settled = new Promise<void>(resolve => { finish = resolve })
    this.active.set(task.id, { controller, settled })
    let eventWrites: Promise<unknown> = Promise.resolve()
    const append = (payload: TaskProductEvent) => {
      const next = eventWrites.then(() => this.events.append(task.id, payload))
      eventWrites = next
      return next
    }
    let product: Awaited<ReturnType<typeof connectProductCapabilities>> | undefined
    let terminalEvent = false
    const emit = (event: AgentEvent) => {
      if (['done', 'error', 'cancelled'].includes(event.type)) terminalEvent = true
      void append({ type: 'agent', runId, event }).catch(() => controller.abort())
    }
    try {
      const attached = await Promise.all(ids.map(id => this.attachments.describe(task.id, id)))
      if (attached.some(item => item.kind !== 'image')) throw Error('This version accepts image attachments. Use workspace read tools for other files.')
      const images = await Promise.all(attached.map(async item => {
        const preview = await previewAttachment(this.attachments, task.id, item.id, undefined, 'model')
        if (preview.mode !== 'image') throw Error(`Cannot prepare image: ${item.name}`)
        return { type: 'image' as const, mimeType: preview.mimeType, data: preview.data }
      }))
      if (controller.signal.aborted) throw Error('Task was stopped.')
      await append({ type: 'request', runId, messageId, text: message, attachments: attached })
      task.lastActivityAt = task.updatedAt = Date.now()
      const needsTitle = !task.hasMessages && task.title === 'New task'
      task.hasMessages = true
      if (needsTitle) task.title = taskTitleFromMessage(message) || 'Image conversation'
      await this.persist()
      const cwd = this.workingDirectory(task)
      if (!process.env.SHUN_HOME || process.env.SHUN_USER_DATA) {
        try { product = await connectProductCapabilities(createHostClient(capabilityHome(this.paths.root)), { taskId: `host-${task.id}`, runId, cwd, workspace: task.workspace, model: task.model }) }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (!['ENOENT', 'ECONNREFUSED'].includes(code || '')) throw error
          emit({ id: runId, type: 'phase', text: 'Desktop capabilities are disconnected; local plugins and Browser Preview remain available.' })
        }
      }
      const packages = await hostPackageCapabilities(this.paths.root, settings, task.id, cwd, !process.env.SHUN_HOME || Boolean(process.env.SHUN_USER_DATA))
      settings.plugins = packages.configuration.plugins
      settings.skills = packages.configuration.skills
      const localTools = hostTools({ ...task, workspace: cwd }, runId, this.background)
      localTools.push(...packages.tools.filter(tool => !product?.tools.some(item => item.name === tool.name)))
      const previewEnabled = applyDefaultPluginInstallations(packages.configuration).plugins.some(item => item.id === 'browser-preview' && item.enabled !== false)
      const previewTools = previewEnabled ? this.preview.tools(task.id) : []
      if (product) { product.tools = product.tools.filter(tool => !previewTools.some(item => item.name === tool.name)); product.deferred = product.deferred.filter(item => !previewTools.some(tool => tool.name === item.tool.name)) }
      localTools.push(...previewTools)
      const tools = [...localTools, ...(product?.tools || []).filter(tool => !localTools.some(item => item.name === tool.name))]
      const deferred = (product?.deferred || []).filter(item => !localTools.some(tool => tool.name === item.tool.name))
      const deferredNames = new Set(deferred.map(item => item.tool.name))
      const activeTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', ...tools.filter(tool => !deferredNames.has(tool.name)).map(tool => tool.name)]
      const request: AgentRequest = { id: runId, taskId: task.id, text: message, history: [], settings }
      if (needsTitle) {
        const fallback = task.title
        const job = this.titleGenerator(request, controller.signal, images).then(async title => {
          if (!title || task.title !== fallback) return
          task.title = title
          await this.persist()
          await append({ type: 'agent', runId, event: { id: runId, type: 'title', text: title } })
        }).catch(() => {})
        this.titleJobs.add(job)
        void job.finally(() => this.titleJobs.delete(job))
      }
      void (async () => {
        try {
          await this.runner(request, controller.signal, emit, {
            ...this.paths, cwd, customTools: tools, activeTools: [...new Set(activeTools)], initialImages: images,
            enableSkillSearch: true, enableExtensionTools: true, deferredTools: deferred, additionalSkills: [...(product?.skills || []), ...packages.skills],
            resolveProjectTrust: async () => new ProjectTrustStore(this.paths.agentDir).get(cwd) === true,
          })
          if (!terminalEvent) emit({ id: runId, type: controller.signal.aborted ? 'cancelled' : 'done' })
        } catch (error) {
          emit({ id: runId, type: controller.signal.aborted ? 'cancelled' : 'error', text: controller.signal.aborted ? undefined : formatProviderFailure(error, settings.language, settings.apiKey) })
        } finally {
          await product?.close().catch(() => {})
          try { await eventWrites } catch { /* A disk failure stops this run and is surfaced on the next read/write. */ }
          this.runs.release(task.id, runId); this.active.delete(task.id)
          task.lastActivityAt = task.updatedAt = Date.now()
          try { await this.persist() } finally { finish() }
        }
      })().catch(() => {})
      return { runId }
    } catch (error) {
      await product?.close().catch(() => {})
      this.runs.release(task.id, runId); this.active.delete(task.id); finish()
      throw error
    }
  }

  async close() {
    this.closing = true
    const active = [...this.active.values()]
    for (const run of active) run.controller.abort()
    await Promise.all(active.map(run => run.settled))
    await Promise.all(this.titleJobs)
    await this.preview.close()
    this.background.preserveForAppExit()
    await this.writes
  }
}
