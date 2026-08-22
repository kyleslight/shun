export type ProviderModel = { id: string; name?: string; contextWindow: number; maxOutputTokens: number; enabled?: boolean }
export type Provider = { id: string; name: string; kind: 'ollama' | 'lmstudio' | 'vllm' | 'llamacpp' | 'custom'; endpoint: string; apiKey: string; contextWindow: number; models?: ProviderModel[]; enabled?: boolean }
export type McpServer = { id: string; name: string; url: string; enabled?: boolean }
export type Settings = { endpoint: string; apiKey: string; providerId: string; providers: Provider[]; mcpServers?: McpServer[]; model: string; workspace: string; temperature: number; maxTokens: number; contextWindow: number; autoCompact: boolean; permission: 'ask' | 'workspace'; language?: 'system' | 'en' | 'zh-CN'; theme?: 'system' | 'dark' | 'light'; accent?: 'blue' | 'sky' | 'teal' | 'mint' | 'amber' | 'orange' | 'rose' | 'pink' | 'violet' }
export type ChatMessage = { role: 'user' | 'assistant'; content: string }
export type WebSource = { requestedUrl: string; finalUrl: string; title: string; contentType: string; fetchMethod: string; pages?: number }
export type AgentRequest = { id: string; taskId?: string; text: string; history: ChatMessage[]; settings: Settings; generateTitle?: boolean; summary?: string; compactedAt?: number; web?: { discoveredUrls: string[]; openedUrls: string[]; sources?: WebSource[] }; resume?: { intent?: 'followup' | 'retry'; stage: RunStage; inspected: Array<{ path: string; output: string; offset: number; limit: number }>; changedFiles: string[]; scratchArtifacts: string[]; recentToolResults: Array<{ name: string; input: string; output: string; state: 'done' | 'error' }> } }
export type ToolEvent = { id: string; batchId?: string; name: string; input: string; output?: string; diff?: string; source?: WebSource; state: 'waiting' | 'running' | 'done' | 'error' }
export type ContextUsage = { state: 'ready' | 'compacting' | 'compacted'; usedCharacters: number; budgetCharacters: number; beforeCharacters?: number; usedTokens?: number; budgetTokens?: number; exactTokens?: boolean }
export type RunStage = 'research' | 'inspection' | 'implementation' | 'verification' | 'finalizing'
export type RunStep = { label: string; status: 'pending' | 'active' | 'complete' }
export type RunProgress = { stage: RunStage; cycle: number; checkpointCycles: number; startedAt: number; message: string; state: 'active' | 'recovering' | 'retrying' | 'complete'; steps: RunStep[] }
export type TimelineEntry = { type: 'text'; text: string } | { type: 'tool'; tool: ToolEvent } | { type: 'context'; context: ContextUsage }
export type Turn = ChatMessage & { id: string; tools?: ToolEvent[]; timeline?: TimelineEntry[]; phase?: string; progress?: RunProgress; error?: boolean; startedAt?: number; lastActivityAt?: number; lastProgressAt?: number; completedAt?: number; contextUsage?: ContextUsage }
export type Task = { id: string; title: string; workspace: string; turns: Turn[]; summary?: string; compactedAt?: number; archivedAt?: number; createdAt: number; updatedAt: number }
export type SavedState = { settings: Settings; tasks: Task[]; currentId: string }
export type AgentEvent = { id: string; type: 'phase' | 'progress' | 'delta' | 'reasoning' | 'approval' | 'tool' | 'compacted' | 'context' | 'title' | 'done' | 'cancelled' | 'error'; text?: string; tool?: ToolEvent; context?: ContextUsage; progress?: RunProgress }
export type BackgroundTaskState = 'starting' | 'running' | 'stopping' | 'stopped' | 'exited' | 'failed'
export type BackgroundTask = { id: string; sessionId: string; createdByRunId: string; workspace: string; command: string; label: string; state: BackgroundTaskState; pid?: number; processGroupId?: number; createdAt: number; startedAt?: number; finishedAt?: number; exitCode?: number; signal?: string; outputSeq: number; outputBytes: number; endpoints: string[]; error?: string }
export type BackgroundOutputChunk = { seq: number; stream: 'stdout' | 'stderr'; text: string; at: number }
export type BackgroundEvent = { type: 'state' | 'output'; task: BackgroundTask; chunk?: BackgroundOutputChunk }
export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error'
export type UpdateState = { status: UpdateStatus; currentVersion: string; targetVersion?: string; percent?: number; message?: string }
export type WindowState = { fullscreen: boolean }
export type ProviderTestResult = { ok: boolean; latencyMs: number; message: string }
export type ShunApi = { chooseWorkspace(): Promise<string | null>; openWorkspace(path: string): Promise<string>; models(endpoint: string, apiKey?: string): Promise<string[]>; testModel(endpoint: string, apiKey: string | undefined, model: string): Promise<ProviderTestResult>; load(): Promise<SavedState | null>; save(state: SavedState): Promise<void>; selectTask(id: string): void; exportTask(task: Task): Promise<boolean>; importTask(): Promise<Task | null>; diff(taskId: string, workspace: string, files?: string[], patches?: string[]): Promise<string>; compact(req: AgentRequest, instructions?: string): Promise<string>; run(req: AgentRequest): void; cancel(id: string): void; approve(runId: string, callId: string, allow: boolean): void; backgroundList(sessionId: string): Promise<BackgroundTask[]>; backgroundListAll(): Promise<BackgroundTask[]>; backgroundOutput(sessionId: string, taskId: string, afterSeq?: number): Promise<BackgroundOutputChunk[]>; backgroundStop(sessionId: string, taskId: string): Promise<BackgroundTask>; updateState(): Promise<UpdateState>; checkForUpdate(): Promise<UpdateState>; downloadUpdate(): Promise<UpdateState>; installUpdate(): Promise<boolean>; windowState(): Promise<WindowState>; onSettings(fn: () => void): () => void; onEvent(fn: (event: AgentEvent) => void): () => void; onBackgroundEvent(fn: (event: BackgroundEvent) => void): () => void; onUpdate(fn: (state: UpdateState) => void): () => void; onWindowState(fn: (state: WindowState) => void): () => void }

export function nextTaskWorkspace(explicit?: string, current?: string, remembered?: string) {
  return explicit ?? current ?? remembered ?? ''
}

export function keepCurrentDraft<T extends { id: string }>(items: T[], currentId: string, hasContent: (item: T) => boolean) {
  return items.filter(item => item.id === currentId || hasContent(item))
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
