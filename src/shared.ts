export type ProviderApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai' | 'bedrock-converse-stream' | 'azure-openai-responses'
export type ProviderModel = { id: string; name?: string; family?: string; releaseDate?: string; lastUpdated?: string; contextWindow: number; maxOutputTokens: number; vision?: boolean; reasoning?: boolean; toolCall?: boolean; featured?: boolean; status?: 'alpha' | 'beta' | 'deprecated'; enabled?: boolean }
export type Provider = { id: string; name: string; kind: 'ollama' | 'lmstudio' | 'vllm' | 'llamacpp' | 'cloud' | 'custom'; catalogId?: string; api?: ProviderApi; endpoint: string; apiKey: string; contextWindow: number; models?: ProviderModel[]; enabled?: boolean }

export function normalizeProviderConnection(provider: Pick<Provider, 'api' | 'endpoint'>) {
  const api = provider.api || 'openai-completions'
  const rawEndpoint = provider.endpoint.trim().replace(/\/+$/, '')
  if (!rawEndpoint) return { api, endpoint: rawEndpoint }
  try {
    const url = new URL(rawEndpoint)
    const path = url.pathname.replace(/\/+$/, '')
    if (api === 'google-generative-ai' && url.hostname === 'generativelanguage.googleapis.com' && ['', '/', '/v1'].includes(path)) {
      url.pathname = '/v1beta'
      url.search = ''
    }
    const azureHost = url.hostname.endsWith('.openai.azure.com') || url.hostname.endsWith('.cognitiveservices.azure.com') || url.hostname.endsWith('.ai.azure.com')
    if (api === 'azure-openai-responses' && azureHost && ['', '/', '/openai', '/openai/v1/responses'].includes(path)) {
      url.pathname = '/openai/v1'
      url.search = ''
    }
    return { api, endpoint: url.toString().replace(/\/+$/, '') }
  } catch {
    return { api, endpoint: rawEndpoint }
  }
}
export type ProviderCatalogVariant = {
  id: string
  name: string
  label: string
  endpoint: string
  endpointPlaceholder?: string
  requiresEndpoint?: boolean
  credentialLabel?: string
  credentialPlaceholder?: string
  authHelpUrl: string
  authHelpLabel: string
}
export type ProviderCatalogEntry = {
  id: string
  name: string
  endpoint: string
  endpointPlaceholder?: string
  api: ProviderApi
  credentialLabel: string
  credentialPlaceholder: string
  authHelpUrl: string
  authHelpLabel: string
  requiresEndpoint?: boolean
  topLevel?: boolean
  variants?: ProviderCatalogVariant[]
  featuredModels: ProviderModel[]
  models: ProviderModel[]
}
export type ProviderCatalog = { source: 'models.dev' | 'fallback'; updatedAt: number; providers: ProviderCatalogEntry[] }

const historicalModel = /(?:legacy|deprecated)(?:$|[-_.])/i
const datedModelSnapshot = /(?:^|[-_.])(?:20\d{6}|20\d{2}[-_]\d{2}[-_]\d{2})(?:$|[-_.])/i
const recentModelWindowMs = 120 * 24 * 60 * 60 * 1_000

function modelTimestamp(model: ProviderModel) {
  return Date.parse(model.lastUpdated || model.releaseDate || '') || 0
}

function modelVersionScore(id: string) {
  const normalized = id.toLowerCase(),
    match = normalized.match(/(?:gpt|gemini|grok|glm|kimi[-_.]?k|mimo[-_.]?v|deepseek[-_.]?v|qwen|llama|claude(?:[-_.][a-z]+)*|minimax[-_.]?m|(?:^|[/_.-])o)[-_.]?(\d+)(?:[._-](\d+))?(?:[._-](\d+))?/)
  if (!match) return /(?:latest|current)(?:$|[-_.])/i.test(normalized) ? 1_000_000 : 0
  return Number(match[1]) * 10_000 + Number(match[2] || 0) * 100 + Number(match[3] || 0)
}

function providerModelMenuScore(model: ProviderModel, originalIndex: number) {
  const date = modelTimestamp(model)
  return (model.featured ? 1_000_000 : 0)
    + (date ? 100_000_000_000 + Math.floor(date / 86_400_000) * 1_000_000 : 0)
    + modelVersionScore(model.id) * 1_000
    + (model.reasoning ? 200 : 0)
    + (model.vision ? 100 : 0)
    - (model.status === 'deprecated' ? 1_000_000_000_000 : 0)
    - (historicalModel.test(model.id) ? 500_000_000_000 : 0)
    - (datedModelSnapshot.test(model.id) ? 200_000_000_000 : 0)
    - originalIndex
}

export function compactProviderModelMenu(models: ProviderModel[], selectedId: string, compact: boolean, limit = 4) {
  const unique = models.filter((model, index) => model.enabled !== false && models.findIndex(candidate => candidate.id === model.id) === index)
  if (!compact || unique.length <= limit) return { primary: unique, older: [] as ProviderModel[] }
  const ranked = unique
    .map((model, index) => ({ model, score: providerModelMenuScore(model, index) }))
    .sort((a, b) => b.score - a.score)
    .map(item => item.model),
    newestTimestamp = Math.max(0, ...ranked.map(modelTimestamp)),
    current = ranked.filter(model => {
      const timestamp = modelTimestamp(model)
      return model.status !== 'deprecated'
        && !historicalModel.test(model.id)
        && (!newestTimestamp || !timestamp || timestamp >= newestTimestamp - recentModelWindowMs)
    }),
    primary = (current.length ? current : ranked).slice(0, limit),
    selected = unique.find(model => model.id === selectedId)
  if (selected && !primary.some(model => model.id === selected.id)) primary.unshift(selected)
  const visible = new Set(primary.map(model => model.id))
  return { primary, older: ranked.filter(model => !visible.has(model.id)) }
}

export function compactCloudProviderDeployments(models: ProviderModel[], selectedId: string, threshold = 12, limit = 4) {
  if (models.length <= threshold) return { models, selectedId }
  const compacted = compactProviderModelMenu(models, '', true, limit).primary.slice(0, limit)
  return {
    models: compacted,
    selectedId: compacted.some(model => model.id === selectedId) ? selectedId : compacted[0]?.id || selectedId,
  }
}
export type McpServer = {
  id: string
  name: string
  transport?: 'http' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  enabled?: boolean
  pluginId?: string
}
export type PluginInstallation = { id: string; enabled?: boolean; skills?: Record<string, boolean> }
export type SkillInstallation = { id: string; enabled?: boolean }
export type TaskCapabilitySelection = {
  profileId?: string
  pluginIds?: string[]
  skillIds?: string[]
  extensionToolNames?: string[]
}
export type Settings = { endpoint: string; apiKey: string; providerId: string; providers: Provider[]; mcpServers?: McpServer[]; plugins?: PluginInstallation[]; skills?: SkillInstallation[]; model: string; workspace: string; temperature: number; maxTokens: number; contextWindow: number; autoCompact: boolean; language?: 'system' | 'en' | 'zh-CN'; theme?: 'system' | 'dark' | 'light'; accent?: 'blue' | 'sky' | 'teal' | 'mint' | 'amber' | 'orange' | 'rose' | 'pink' | 'violet' }
export type AttachmentKind = 'image' | 'pdf' | 'text' | 'document' | 'spreadsheet' | 'presentation' | 'archive' | 'unknown'
export type AttachmentRef = {
  id: string
  taskId: string
  name: string
  mimeType: string
  kind: AttachmentKind
  size: number
  sha256: string
  createdAt: number
  capabilities: { text?: boolean; vision?: boolean; ocr?: boolean; pages?: number; sheets?: string[]; slides?: number }
}
export type AttachmentPreview = { attachment: AttachmentRef; mode: 'image'; mimeType: string; data: string; width?: number; height?: number; page?: number; pages?: number } | { attachment: AttachmentRef; mode: 'text'; content: string; page?: number; pages?: number; warning?: string }
export type ChatMessage = { role: 'user' | 'assistant'; content: string }
export type WebSource = { requestedUrl: string; finalUrl: string; title: string; contentType: string; fetchMethod: string; pages?: number }
export type AgentRequest = { id: string; taskId?: string; messageId?: string; text: string; attachments?: AttachmentRef[]; history: ChatMessage[]; settings: Settings; capabilities?: TaskCapabilitySelection; generateTitle?: boolean; summary?: string; compactedAt?: number; source?: 'interactive' | 'scheduled'; schedule?: { id: string; occurrenceId: string; dueAt: number }; revision?: { targetMessageId: string }; web?: { discoveredUrls: string[]; openedUrls: string[]; sources?: WebSource[] }; resume?: { intent?: 'followup' | 'retry'; stage: RunStage; inspected: Array<{ path: string; output: string; offset: number; limit: number }>; changedFiles: string[]; scratchArtifacts: string[]; recentToolResults: Array<{ name: string; input: string; output: string; state: 'done' | 'error' }> } }
export type AgentRevisionPreview = { available: boolean; complete: boolean; changedFiles: string[]; skipped: string[]; capturedAt?: number; warning?: string }
export type ToolEvent = { id: string; batchId?: string; name: string; input: string; output?: string; diff?: string; source?: WebSource; attachments?: AttachmentRef[]; state: 'running' | 'done' | 'error' }
export type ContextBreakdown = {
  systemTokens: number
  toolTokens: number
  mcpTokens: number
  conversationTokens: number
  estimated: true
}
export type ContextUsage = { state: 'ready' | 'compacting' | 'compacted'; usedCharacters: number; budgetCharacters: number; beforeCharacters?: number; usedTokens?: number; budgetTokens?: number; exactTokens?: boolean; breakdown?: ContextBreakdown }
export type RunStage = 'research' | 'inspection' | 'implementation' | 'verification' | 'finalizing'
export type RunStep = { label: string; status: 'pending' | 'active' | 'complete' }
export type RunProgress = { stage: RunStage; cycle: number; checkpointCycles: number; startedAt: number; message: string; state: 'active' | 'recovering' | 'retrying' | 'complete'; steps: RunStep[] }
export type TimelineEntry = { type: 'text'; text: string } | { type: 'tool'; tool: ToolEvent } | { type: 'context'; context: ContextUsage }
export type Turn = ChatMessage & { id: string; attachments?: AttachmentRef[]; skillId?: string; tools?: ToolEvent[]; timeline?: TimelineEntry[]; phase?: string; progress?: RunProgress; error?: boolean; startedAt?: number; lastActivityAt?: number; lastProgressAt?: number; completedAt?: number; contextUsage?: ContextUsage; revisedFromId?: string }
export type Task = { id: string; title: string; workspace: string; model?: string; turns: Turn[]; capabilities?: TaskCapabilitySelection; attachments?: AttachmentRef[]; draft?: string; summary?: string; compactedAt?: number; archivedAt?: number; awaitingFirstRemoteMessage?: boolean; createdAt: number; updatedAt: number }
export type LocalScheduleTrigger =
  | { kind: 'once'; at: string }
  | { kind: 'cron'; expression: string; timezone: string }
export type LocalScheduleStatus = 'active' | 'paused' | 'completed'
export type LocalScheduleLastStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'
export type LocalSchedule = {
  id: string
  taskId: string
  name: string
  prompt: string
  trigger: LocalScheduleTrigger
  status: LocalScheduleStatus
  missedPolicy: 'run_once' | 'skip'
  nextRunAt?: number
  lastRunAt?: number
  lastStatus?: LocalScheduleLastStatus
  lastError?: string
  createdAt: number
  updatedAt: number
}
export type LocalScheduleInput = Pick<LocalSchedule, 'taskId' | 'name' | 'prompt' | 'trigger'> & { missedPolicy?: LocalSchedule['missedPolicy'] }
export type LocalSchedulePatch = Partial<Pick<LocalSchedule, 'name' | 'prompt' | 'trigger' | 'status' | 'missedPolicy'>>
export type LocalScheduleEvent = { type: 'changed'; schedule?: LocalSchedule; removedId?: string; taskId?: string }
export type RemoteWorkspaceEntry = { name: string; path: string }
export type RemoteWorkspaceDirectory = { path: string; parent?: string; entries: RemoteWorkspaceEntry[]; truncated?: boolean }
export type RemoteWorkspaceApi = { browseWorkspaces(path?: string): Promise<RemoteWorkspaceDirectory> }
export type RemoteFileInfo = { path: string; name: string; size: number; mimeType: string; chunkSize: number }
export type RemoteFileChunk = { offset: number; data: string; bytes: number; eof: boolean }
export type RemoteFileApi = { describeRemoteFile(path: string): Promise<RemoteFileInfo>; readRemoteFileChunk(path: string, offset: number, length?: number): Promise<RemoteFileChunk> }
export type SavedState = { settings: Settings; tasks: Task[]; currentId: string }
export type AgentEvent = { id: string; type: 'phase' | 'progress' | 'delta' | 'reasoning' | 'tool' | 'compacted' | 'context' | 'title' | 'done' | 'cancelled' | 'error'; text?: string; tool?: ToolEvent; context?: ContextUsage; progress?: RunProgress }
export type RemoteQueueItem = { id: string; taskId: string; text: string; attachments?: AttachmentRef[] }
export type RemoteTaskStateEvent =
  | { kind: 'queue.snapshot'; items: RemoteQueueItem[] }
  | { kind: 'confirmation.request'; id: string; title: string; description?: string; risk?: string }
  | { kind: 'confirmation.resolved'; id: string; decision: 'approve' | 'deny' }
export type TaskProductEvent =
  | { type: 'request'; runId: string; messageId?: string; text: string; attachments?: AttachmentRef[]; source?: AgentRequest['source']; schedule?: AgentRequest['schedule'] }
  | { type: 'agent'; runId: string; event: AgentEvent }
  | { type: 'remote'; event: RemoteTaskStateEvent }
export type TaskEventEnvelope = { taskId: string; seq: number; at: number; payload: TaskProductEvent }
export type SkillManifest = { id: string; name: string; description: string; pluginId?: string }
export type PluginManifest = {
  id: string
  name: string
  description: string
  version: string
  publisher: string
  icon: 'github' | 'figma' | 'gmail' | 'chrome' | 'ios' | 'godot' | 'render' | 'cloudflare' | 'plugin'
  connector: { kind: 'github-cli' | 'figma-rest' | 'gmail-rest' | 'render-rest' | 'cloudflare-rest' | 'chrome-extension' | 'ios-simulator' | 'godot-cli'; setupLabel: string; setupUrl?: string; auth: 'cli' | 'pat' | 'oauth' | 'api-key' | 'extension' | 'local' }
  bundledSkills: SkillManifest[]
}
export type PluginState = PluginManifest & { installed: boolean; enabled: boolean; connected?: boolean; detail?: string }
export type PluginConnectionState = { connected: boolean; status: 'connected' | 'disconnected' | 'unavailable' | 'error'; message?: string; account?: string }
export type SkillOrigin = 'plugin' | 'local' | 'package' | 'project' | 'external'
export type SkillState = SkillManifest & {
  installed: boolean
  enabled: boolean
  origin: SkillOrigin
  icon?: PluginManifest['icon']
  filePath?: string
  packageSource?: string
  editable?: boolean
  removable?: boolean
  diagnostics?: string[]
}
export type SkillDocument = { skill: SkillState; content: string }
export type SkillCreateRequest = { name: string; description: string; instructions: string; disableModelInvocation?: boolean }
export type SkillUpdateRequest = {
  name: string
  description?: string
  instructions?: string
  appendInstructions?: string
  instructionPatch?: { find: string; replace: string }
  disableModelInvocation?: boolean
}
export type RepositoryFileState = { path: string; index: string; worktree: string; staged: boolean; unstaged: boolean; untracked: boolean; conflicted: boolean }
export type RepositorySnapshot = { root: string; head: string; oid: string; upstream?: string; ahead: number; behind: number; detached: boolean; files: RepositoryFileState[] }
export type BackgroundTaskState = 'starting' | 'running' | 'stopping' | 'stopped' | 'exited' | 'failed'
export type BackgroundTask = { id: string; sessionId: string; createdByRunId: string; workspace: string; command: string; label: string; state: BackgroundTaskState; pid?: number; processGroupId?: number; createdAt: number; startedAt?: number; finishedAt?: number; exitCode?: number; signal?: string; outputSeq: number; outputBytes: number; endpoints: string[]; error?: string }
export type BackgroundOutputChunk = { seq: number; stream: 'stdout' | 'stderr'; text: string; at: number }
export type BackgroundEvent = { type: 'state' | 'output'; task: BackgroundTask; chunk?: BackgroundOutputChunk }
export type BrowserSessionState = 'attached' | 'suspended' | 'released' | 'closed' | 'error'
export type BrowserSession = {
  id: string
  taskId: string
  createdByRunId: string
  tabId: number
  owned: boolean
  state: BrowserSessionState
  url: string
  title: string
  createdAt: number
  updatedAt: number
  lastSnapshotAt?: number
  lastScreenshotAt?: number
  consoleEntries: number
  pageErrors: number
  error?: string
}
export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error'
export type UpdateState = { status: UpdateStatus; currentVersion: string; targetVersion?: string; percent?: number; message?: string }
export type WindowState = { fullscreen: boolean }
export type RemoteBridgeRequest = { id: string; kind: string; payload: Record<string, unknown> }
export type RemotePairingResult = { qr: string; expiresAt: number }
export type RemoteDeviceState = { id: string; pairedAt: number; connected: boolean }
export type ProviderTestResult = { ok: boolean; latencyMs: number; message: string }
export type LocalPathApi = { openLocalPath(path: string): Promise<{ path: string; kind: 'file' | 'directory' }> }
export type ShunApi = { chooseWorkspace(): Promise<string | null>; openWorkspace(path: string): Promise<string>; chooseAttachments(taskId: string): Promise<AttachmentRef[]>; importAttachments(taskId: string, paths: string[]): Promise<AttachmentRef[]>; importAttachmentData(taskId: string, files: Array<{ name: string; data: ArrayBuffer }>): Promise<AttachmentRef[]>; listAttachments(taskId: string): Promise<AttachmentRef[]>; previewAttachment(taskId: string, attachmentId: string, page?: number, purpose?: 'display' | 'model'): Promise<AttachmentPreview>; copyAttachmentImage(taskId: string, attachmentId: string): Promise<boolean>; saveAttachmentImage(taskId: string, attachmentId: string): Promise<boolean>; showAttachmentImageMenu(taskId: string, attachmentId: string): void; removeAttachment(taskId: string, attachmentId: string): Promise<boolean>; deleteTaskData(taskId: string): Promise<boolean>; pathForFile(file: File): string; models(endpoint: string, apiKey?: string, api?: ProviderApi): Promise<string[]>; providerCatalog(): Promise<ProviderCatalog>; testModel(endpoint: string, apiKey: string | undefined, model: string, api?: ProviderApi): Promise<ProviderTestResult>; load(): Promise<SavedState | null>; save(state: SavedState): Promise<void>; selectTask(id: string): void; exportTask(task: Task): Promise<boolean>; importTask(): Promise<Task | null>; diff(taskId: string, workspace: string, files?: string[], patches?: string[]): Promise<string>; repository(workspace: string): Promise<RepositorySnapshot | null>; taskEvents(taskId: string, afterSeq?: number): Promise<TaskEventEnvelope[]>; publishRemoteTaskState(taskId: string, event: RemoteTaskStateEvent): Promise<void>; schedules(taskId?: string): Promise<LocalSchedule[]>; createSchedule(input: LocalScheduleInput): Promise<LocalSchedule>; updateSchedule(id: string, patch: LocalSchedulePatch): Promise<LocalSchedule>; removeSchedule(id: string): Promise<boolean>; runSchedule(id: string): Promise<LocalSchedule>; plugins(settings: Settings): Promise<PluginState[]>; skills(settings: Settings): Promise<SkillState[]>; createSkill(request: SkillCreateRequest): Promise<SkillDocument>; importSkills(settings: Settings): Promise<SkillState[]>; readSkill(id: string, settings: Settings): Promise<SkillDocument>; updateSkill(id: string, content: string, settings: Settings): Promise<SkillDocument>; removeSkill(id: string, settings: Settings): Promise<boolean>; installSkillPackage(source: string, settings: Settings): Promise<SkillState[]>; updateSkillPackage(source: string, settings: Settings): Promise<SkillState[]>; removeSkillPackage(source: string, settings: Settings): Promise<boolean>; pluginConnection(pluginId: string): Promise<PluginConnectionState>; connectPlugin(pluginId: string, credential?: string): Promise<PluginConnectionState>; disconnectPlugin(pluginId: string): Promise<PluginConnectionState>; compact(req: AgentRequest, instructions?: string): Promise<string>; run(req: AgentRequest): void; interrupt(req: AgentRequest): Promise<boolean>; revisionPreview(taskId: string, messageId: string, workspace: string): Promise<AgentRevisionPreview>; revise(req: AgentRequest): Promise<boolean>; cancel(id: string): void; backgroundList(sessionId: string): Promise<BackgroundTask[]>; backgroundListAll(): Promise<BackgroundTask[]>; backgroundOutput(sessionId: string, taskId: string, afterSeq?: number): Promise<BackgroundOutputChunk[]>; backgroundStop(sessionId: string, taskId: string): Promise<BackgroundTask>; updateState(): Promise<UpdateState>; checkForUpdate(): Promise<UpdateState>; downloadUpdate(): Promise<UpdateState>; installUpdate(): Promise<boolean>; windowState(): Promise<WindowState>; beginRemotePairing(): Promise<RemotePairingResult>; remoteDevices(): Promise<RemoteDeviceState[]>; onRemoteRequest(fn: (request: RemoteBridgeRequest) => Promise<unknown>): () => void; onPairMobile(fn: () => void): () => void; onSettings(fn: () => void): () => void; onEvent(fn: (event: AgentEvent) => void): () => void; onTaskEvent(fn: (event: TaskEventEnvelope) => void): () => void; onScheduleEvent(fn: (event: LocalScheduleEvent) => void): () => void; onBackgroundEvent(fn: (event: BackgroundEvent) => void): () => void; onUpdate(fn: (state: UpdateState) => void): () => void; onWindowState(fn: (state: WindowState) => void): () => void }

export function nextTaskWorkspace(explicit?: string, current?: string, remembered?: string) {
  return explicit ?? current ?? remembered ?? ''
}

export function keepCurrentDraft<T extends { id: string }>(items: T[], currentId: string, hasContent: (item: T) => boolean) {
  return items.filter(item => item.id === currentId || hasContent(item))
}

export function hasTaskContent(task: Pick<Task, 'turns' | 'attachments' | 'draft' | 'awaitingFirstRemoteMessage'>) {
  return Boolean(task.awaitingFirstRemoteMessage) || Boolean(task.draft?.trim()) || Boolean(task.attachments?.length) || task.turns.some(turn => Boolean(turn.content?.trim()) || Boolean(turn.attachments?.length))
}

export function hasTaskMessages(task: Pick<Task, 'turns'>) {
  return Boolean(task.turns.length)
}

export function isTaskWorkspaceLocked(task: Pick<Task, 'turns'> | undefined) {
  return Boolean(task?.turns.length)
}

export function latestUnsentTask(tasks: Task[], workspace?: string) {
  return tasks
    .filter(task => !hasTaskMessages(task) && hasTaskContent(task) && (workspace === undefined || task.workspace === workspace))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

export function compactResumeToolOutput(output: string, limit = 8_000) {
  if (output.length <= limit) return output
  const marker = '\n\n[resume output middle omitted]\n\n'
  const head = Math.max(1, Math.floor((limit - marker.length) * 0.7))
  const tail = Math.max(1, limit - marker.length - head)
  return `${output.slice(0, head)}${marker}${output.slice(-tail)}`
}

export function hasContinuationState(turns: Array<Pick<Turn, 'progress' | 'timeline' | 'tools'>>) {
  return turns.some(turn => Boolean(turn.progress) || Boolean(turn.tools?.length) || Boolean(turn.timeline?.some(entry => entry.type === 'tool')))
}

export function latestProviderFailure(turns: Array<Pick<Turn, 'role' | 'content' | 'error'>>) {
  const latestAssistant = [...turns].reverse().find(turn => turn.role === 'assistant')
  return latestAssistant?.error && /Model stream|Provider did not begin responding/i.test(latestAssistant.content)
    ? latestAssistant.content
    : undefined
}

export function isSoftNotFoundSource(source: Pick<WebSource, 'finalUrl' | 'title'>) {
  let path = ''
  try { path = new URL(source.finalUrl).pathname } catch {}
  const title = String(source.title || '').replace(/\s+/g, ' ').trim()
  return /(?:^|\/)(?:404|page-not-found|not-found)(?:\/|$)/i.test(path) || /^(?:404(?:\s+error)?|page not found|not found|页面不存在|页面未找到|找不到页面)(?:\s*[-|:·].*)?$/i.test(title)
}
