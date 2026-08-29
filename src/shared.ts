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
export type PluginInstallation = { id: string; enabled?: boolean; skills?: Record<string, boolean>; permissions?: string[]; preferences?: Record<string, string | number | boolean>; onboardingComplete?: boolean }
export type SkillInstallation = { id: string; enabled?: boolean }
export type TaskCapabilitySelection = {
  profileId?: string
  pluginIds?: string[]
  skillIds?: string[]
  extensionToolNames?: string[]
}
export type Settings = { endpoint: string; apiKey: string; providerId: string; providers: Provider[]; mcpServers?: McpServer[]; plugins?: PluginInstallation[]; pluginDefaultsVersion?: number; skills?: SkillInstallation[]; model: string; workspace: string; temperature: number; maxTokens: number; contextWindow: number; autoCompact: boolean; language?: 'system' | 'en' | 'zh-CN'; theme?: 'system' | 'dark' | 'light'; accent?: 'blue' | 'sky' | 'teal' | 'mint' | 'amber' | 'orange' | 'rose' | 'pink' | 'violet' }

export const pluginDefaultsVersion = 4
export const gitWorkbenchPermissions = ['workspace.git.read', 'workspace.git.write', 'workspace.reveal']
export const fileManagerPermissions = ['workspace.read', 'workspace.reveal']
export const terminalPermissions = ['workspace.process']

export function applyDefaultPluginInstallations<T extends Pick<Settings, 'plugins'> & Partial<Pick<Settings, 'pluginDefaultsVersion'>>>(settings: T): T & { plugins: PluginInstallation[]; pluginDefaultsVersion: number } {
  const plugins = [...(settings.plugins || [])]
  if ((settings.pluginDefaultsVersion || 0) < pluginDefaultsVersion && !plugins.some(item => item.id === 'git-workbench')) {
    plugins.push({ id: 'git-workbench', enabled: true, permissions: [...gitWorkbenchPermissions] })
  }
  if ((settings.pluginDefaultsVersion || 0) < 2 && !plugins.some(item => item.id === 'file-manager')) {
    plugins.push({ id: 'file-manager', enabled: true, permissions: [...fileManagerPermissions] })
  }
  if ((settings.pluginDefaultsVersion || 0) < 3 && !plugins.some(item => item.id === 'browser-preview')) {
    plugins.push({ id: 'browser-preview', enabled: true, permissions: [] })
  }
  if ((settings.pluginDefaultsVersion || 0) < 4 && !plugins.some(item => item.id === 'terminal')) {
    plugins.push({ id: 'terminal', enabled: true, permissions: [...terminalPermissions] })
  }
  return { ...settings, plugins, pluginDefaultsVersion }
}
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
export type PluginViewRequest = { pluginId: string; viewId: string; title?: string; pluginName?: string; icon?: PluginManifest['icon']; iconUrl?: string; disposition: 'open' | 'suggest'; resource?: { url: string } }
export type ToolEvent = { id: string; batchId?: string; name: string; input: string; output?: string; diff?: string; changed?: boolean; source?: WebSource; attachments?: AttachmentRef[]; pluginView?: PluginViewRequest; state: 'running' | 'done' | 'error' }
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
  icon: 'github' | 'figma' | 'gmail' | 'chrome' | 'ios' | 'godot' | 'render' | 'cloudflare' | 'git' | 'plugin'
  iconAsset?: string
  iconUrl?: string
  connector: { kind: 'github-cli' | 'figma-rest' | 'gmail-rest' | 'render-rest' | 'cloudflare-rest' | 'chrome-extension' | 'ios-simulator' | 'godot-cli' | 'git-cli' | 'package'; setupLabel: string; setupUrl?: string; auth: 'cli' | 'pat' | 'oauth' | 'api-key' | 'extension' | 'local' }
  bundledSkills: SkillManifest[]
  source?: 'builtin' | 'installed'
  permissions?: PluginPermission[]
  runtime?: PluginRuntimeManifest
  contributes?: PluginContributions
  onboarding?: PluginOnboarding
  experimental?: boolean
}
export type PluginState = PluginManifest & { installed: boolean; enabled: boolean; connected?: boolean; detail?: string; reloadable?: boolean; developmentSource?: string }
export type PluginPermission = { id: 'workspace.git.read' | 'workspace.git.write' | 'workspace.read' | 'workspace.reveal' | 'workspace.process' | 'conversation.context' | 'conversation.ui'; reason: string }
export type PluginWorkspaceRequirement = 'none' | 'optional' | 'required'
export type PluginRuntimeAsset = { id: string; path: string; bytes: number; url?: string; sha256?: string }
export type PluginRuntimePlatform = 'darwin' | 'win32' | 'linux'
export type PluginRuntimeArchitecture = 'arm64' | 'x64'
export type PluginRuntimeExecutableTarget = { platform: PluginRuntimePlatform; arch: PluginRuntimeArchitecture; url: string; bytes: number; archive: 'raw' | 'tar.gz' | 'zip'; entry: string; sha256?: string }
export type PluginRuntimeExecutable = { id: string; version: string; targets: PluginRuntimeExecutableTarget[] }
export type PluginRuntimeManifest = { workspace: PluginWorkspaceRequirement; assets?: PluginRuntimeAsset[]; executables?: PluginRuntimeExecutable[] }
export type PluginViewLocation = 'workspace.right' | 'workspace.bottom'
export type PluginViewRailPolicy = 'on-demand' | 'workspace' | 'transient'
export type PluginViewLaunchSource = 'user' | 'assistant' | 'tool-result' | 'conversation-action'
export type PluginViewActivation = { fileChanges?: string[]; localEndpoints?: boolean }
export type PluginViewManifest = { id: string; title: string; location: PluginViewLocation; entry: string; rail?: PluginViewRailPolicy; launch?: PluginViewLaunchSource[]; activation?: PluginViewActivation }
export type PluginConversationAction = { id: string; title: string; placement: 'message' | 'composer'; command?: string; viewId?: string }
export type PluginSkillContribution = { path: string }
export type PluginWorkerManifest = { id: string; entry: string; timeoutMs: number; runtime?: string[] }
export type PluginContributions = { views?: PluginViewManifest[]; conversationActions?: PluginConversationAction[]; skills?: PluginSkillContribution[]; workers?: PluginWorkerManifest[] }
export type PluginOnboardingStep =
  | { id: string; type: 'info' | 'permissions'; title: string; description: string }
  | { id: string; type: 'secret'; title: string; description: string; key: string; label: string }
  | { id: string; type: 'oauth'; title: string; description: string; connection: string }
  | { id: string; type: 'choice'; title: string; description: string; key: string; options: Array<{ label: string; value: string }> }
export type PluginOnboarding = { reopenable: boolean; steps: PluginOnboardingStep[] }
export type PluginViewDescriptor = { pluginId: string; viewId: string; title: string; location: PluginViewLocation; url: string; icon: PluginManifest['icon']; iconUrl?: string; permissions: string[]; workspace: PluginWorkspaceRequirement; rail: PluginViewRailPolicy; launch: PluginViewLaunchSource[]; activation?: PluginViewActivation; experimental?: boolean }
export type PluginViewContribution = PluginViewDescriptor & { accessToken: string; boundWorkspace: string; boundTaskId: string }
export type PluginPackageEvent = { manifest: PluginManifest; enabled: boolean; permissions: string[]; reason?: 'install' | 'reload' }
export type PluginViewProgress = { accessToken: string; workerId: string; phase: 'installing' | 'running'; runtimeId?: string; downloadedBytes?: number; totalBytes?: number; cached?: boolean }
export type TerminalSessionEvent =
  | { accessToken: string; sessionId: string; type: 'data'; data: string }
  | { accessToken: string; sessionId: string; type: 'exit'; exitCode: number; signal?: number }
export type PluginWorkspaceChange =
  | { type?: 'files'; subscriptionId: string; paths: string[]; overflow: boolean }
  | { type: 'state'; pluginId: string; workspace: string; key: string; value: unknown }
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
export type GitReference = { name: string; fullName: string; oid: string; kind: 'branch' | 'remote-branch' | 'tag'; current?: boolean; upstream?: string }
export type GitRemote = { name: string; fetchUrl?: string; pushUrl?: string }
export type GitCommit = { oid: string; parents: string[]; subject: string; authorName: string; authorEmail: string; authoredAt: string; refs: string[] }
export type GitChangedFile = { path: string; previousPath?: string; status: string }
export type GitWorkbenchOverview = { repository: RepositorySnapshot; refs: GitReference[]; remotes: GitRemote[]; commits: GitCommit[]; hasMore: boolean }
export type GitCommitFiles = { commit: GitCommit; files: GitChangedFile[] }
export type BackgroundTaskState = 'starting' | 'running' | 'stopping' | 'stopped' | 'exited' | 'failed'
export type BackgroundTask = { id: string; sessionId: string; createdByRunId: string; workspace: string; command: string; label: string; state: BackgroundTaskState; pid?: number; processGroupId?: number; createdAt: number; startedAt?: number; finishedAt?: number; exitCode?: number; signal?: string; outputSeq: number; outputBytes: number; endpoints: string[]; error?: string }
export type BackgroundOutputChunk = { seq: number; stream: 'stdout' | 'stderr'; text: string; at: number }
export type BackgroundEvent = { type: 'state' | 'output'; task: BackgroundTask; chunk?: BackgroundOutputChunk }
export type BrowserPreviewViewport = { width: number; height: number; label?: string }
export type BrowserPreviewCommand = { taskId: string; url: string; viewport?: BrowserPreviewViewport; action?: 'back' | 'forward' | 'refresh' }
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
export type LocalPathApi = {
  openLocalPath(path: string): Promise<{ path: string; kind: 'file' | 'directory' }>
  describeLocalPath(path: string, workspace?: string): Promise<{ path: string; kind: 'file' | 'directory'; workspaceRelative?: string }>
  onBrowserPreviewCommand(fn: (command: BrowserPreviewCommand) => void): () => void
  onTerminalEvent(fn: (event: TerminalSessionEvent) => void): () => void
}
export type ShunApi = { chooseWorkspace(): Promise<string | null>; openWorkspace(path: string): Promise<string>; chooseAttachments(taskId: string): Promise<AttachmentRef[]>; importAttachments(taskId: string, paths: string[]): Promise<AttachmentRef[]>; importAttachmentData(taskId: string, files: Array<{ name: string; data: ArrayBuffer }>): Promise<AttachmentRef[]>; listAttachments(taskId: string): Promise<AttachmentRef[]>; previewAttachment(taskId: string, attachmentId: string, page?: number, purpose?: 'display' | 'model'): Promise<AttachmentPreview>; copyAttachmentImage(taskId: string, attachmentId: string): Promise<boolean>; saveAttachmentImage(taskId: string, attachmentId: string): Promise<boolean>; showAttachmentImageMenu(taskId: string, attachmentId: string): void; removeAttachment(taskId: string, attachmentId: string): Promise<boolean>; deleteTaskData(taskId: string): Promise<boolean>; pathForFile(file: File): string; models(endpoint: string, apiKey?: string, api?: ProviderApi): Promise<string[]>; providerCatalog(): Promise<ProviderCatalog>; testModel(endpoint: string, apiKey: string | undefined, model: string, api?: ProviderApi): Promise<ProviderTestResult>; load(): Promise<SavedState | null>; save(state: SavedState): Promise<void>; selectTask(id: string): void; exportTask(task: Task): Promise<boolean>; importTask(): Promise<Task | null>; diff(taskId: string, workspace: string, files?: string[], patches?: string[]): Promise<string>; repository(workspace: string): Promise<RepositorySnapshot | null>; pluginViews(settings: Settings): Promise<PluginViewDescriptor[]>; openPluginView(settings: Settings, pluginId: string, viewId: string, workspace: string, taskId: string): Promise<PluginViewContribution>; closePluginView(accessToken: string): Promise<boolean>; pluginViewInvoke(pluginId: string, viewId: string, accessToken: string, method: string, payload: unknown, workspace: string, taskId: string): Promise<unknown>; watchPluginWorkspace(pluginId: string, viewId: string, accessToken: string, workspace: string, taskId: string): Promise<string>; unwatchPluginWorkspace(subscriptionId: string): Promise<boolean>; importPluginPackage(settings: Settings): Promise<PluginManifest | null>; reloadPluginPackage(pluginId: string): Promise<PluginManifest>; removePluginPackage(pluginId: string): Promise<boolean>; taskEvents(taskId: string, afterSeq?: number): Promise<TaskEventEnvelope[]>; publishRemoteTaskState(taskId: string, event: RemoteTaskStateEvent): Promise<void>; schedules(taskId?: string): Promise<LocalSchedule[]>; createSchedule(input: LocalScheduleInput): Promise<LocalSchedule>; updateSchedule(id: string, patch: LocalSchedulePatch): Promise<LocalSchedule>; removeSchedule(id: string): Promise<boolean>; runSchedule(id: string): Promise<LocalSchedule>; plugins(settings: Settings): Promise<PluginState[]>; skills(settings: Settings): Promise<SkillState[]>; createSkill(request: SkillCreateRequest): Promise<SkillDocument>; importSkills(settings: Settings): Promise<SkillState[]>; readSkill(id: string, settings: Settings): Promise<SkillDocument>; updateSkill(id: string, content: string, settings: Settings): Promise<SkillDocument>; removeSkill(id: string, settings: Settings): Promise<boolean>; installSkillPackage(source: string, settings: Settings): Promise<SkillState[]>; updateSkillPackage(source: string, settings: Settings): Promise<SkillState[]>; removeSkillPackage(source: string, settings: Settings): Promise<boolean>; pluginConnection(pluginId: string): Promise<PluginConnectionState>; connectPlugin(pluginId: string, credential?: string): Promise<PluginConnectionState>; disconnectPlugin(pluginId: string): Promise<PluginConnectionState>; compact(req: AgentRequest, instructions?: string): Promise<string>; run(req: AgentRequest): void; interrupt(req: AgentRequest): Promise<boolean>; revisionPreview(taskId: string, messageId: string, workspace: string): Promise<AgentRevisionPreview>; revise(req: AgentRequest): Promise<boolean>; cancel(id: string): void; backgroundList(sessionId: string): Promise<BackgroundTask[]>; backgroundListAll(): Promise<BackgroundTask[]>; backgroundOutput(sessionId: string, taskId: string, afterSeq?: number): Promise<BackgroundOutputChunk[]>; backgroundStop(sessionId: string, taskId: string): Promise<BackgroundTask>; updateState(): Promise<UpdateState>; checkForUpdate(): Promise<UpdateState>; downloadUpdate(): Promise<UpdateState>; installUpdate(): Promise<boolean>; windowState(): Promise<WindowState>; beginRemotePairing(): Promise<RemotePairingResult>; remoteDevices(): Promise<RemoteDeviceState[]>; onRemoteRequest(fn: (request: RemoteBridgeRequest) => Promise<unknown>): () => void; onPairMobile(fn: () => void): () => void; onSettings(fn: () => void): () => void; onPluginPackage(fn: (event: PluginPackageEvent) => void): () => void; onPluginWorkspace(fn: (event: PluginWorkspaceChange) => void): () => void; onPluginViewProgress(fn: (event: PluginViewProgress) => void): () => void; onEvent(fn: (event: AgentEvent) => void): () => void; onTaskEvent(fn: (event: TaskEventEnvelope) => void): () => void; onScheduleEvent(fn: (event: LocalScheduleEvent) => void): () => void; onBackgroundEvent(fn: (event: BackgroundEvent) => void): () => void; onUpdate(fn: (state: UpdateState) => void): () => void; onWindowState(fn: (state: WindowState) => void): () => void }

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
