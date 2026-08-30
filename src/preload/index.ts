import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AgentEvent, AgentRequest, AgentRunState, BackgroundEvent, BrowserPreviewCommand, LocalPathApi, LocalScheduleEvent, PluginPackageEvent, PluginViewProgress, PluginWorkspaceChange, ProviderApi, RemoteBridgeRequest, RemoteFileApi, RemoteTaskStateEvent, RemoteWorkspaceApi, ShunApi, TaskEventEnvelope, TerminalSessionEvent, UpdateState, WindowState, WorkspaceLifecycleApi, WorkspaceUnavailableEvent } from '../shared'

let remoteRequestHandler: ((request: RemoteBridgeRequest) => Promise<unknown>) | undefined
const queuedRemoteRequests = new Map<string, RemoteBridgeRequest>()
let drainingRemoteRequests = false
const agentEventListeners = new Set<(event: AgentEvent) => void>()
const runStateListeners = new Set<(event: AgentRunState) => void>()
const taskEventListeners = new Set<(event: TaskEventEnvelope) => void>()
const pendingAgentEvents: AgentEvent[] = []
const pendingRunStates: AgentRunState[] = []
const pendingTaskEvents: TaskEventEnvelope[] = []

ipcRenderer.on('agent:event', (_event, event: AgentEvent) => {
  if (agentEventListeners.size && taskEventListeners.size) for (const listener of agentEventListeners) listener(event)
  else pendingAgentEvents.push(event)
  if (pendingAgentEvents.length > 1_000) pendingAgentEvents.splice(0, pendingAgentEvents.length - 1_000)
})
ipcRenderer.on('task:event', (_event, event: TaskEventEnvelope) => {
  if (taskEventListeners.size) for (const listener of taskEventListeners) listener(event)
  else pendingTaskEvents.push(event)
  if (pendingTaskEvents.length > 1_000) pendingTaskEvents.splice(0, pendingTaskEvents.length - 1_000)
})
ipcRenderer.on('agent:run-state', (_event, state: AgentRunState) => {
  if (runStateListeners.size) for (const listener of runStateListeners) listener(state)
  else pendingRunStates.push(state)
  if (pendingRunStates.length > 1_000) pendingRunStates.splice(0, pendingRunStates.length - 1_000)
})

async function dispatchRemoteRequest(request: RemoteBridgeRequest) {
  const handler = remoteRequestHandler
  if (!handler) {
    // Relay links are brought up by the main process before React has restored
    // the task store. A Mobile command received in that short window is valid;
    // keep it pending instead of reporting a false offline/loading failure.
    queuedRemoteRequests.set(request.id, request)
    return
  }
  try { ipcRenderer.send('remote:response', request.id, { ok: true, data: await handler(request) }) }
  catch (error) { ipcRenderer.send('remote:response', request.id, { ok: false, error: error instanceof Error ? error.message : String(error) }) }
}

async function drainRemoteRequests() {
  if (drainingRemoteRequests) return
  drainingRemoteRequests = true
  try {
    while (remoteRequestHandler && queuedRemoteRequests.size) {
      const next = queuedRemoteRequests.entries().next().value as [string, RemoteBridgeRequest] | undefined
      if (!next) break
      queuedRemoteRequests.delete(next[0])
      await dispatchRemoteRequest(next[1])
    }
  } finally {
    drainingRemoteRequests = false
    if (remoteRequestHandler && queuedRemoteRequests.size) void drainRemoteRequests()
  }
}

ipcRenderer.on('remote:request', (_event, request: RemoteBridgeRequest) => {
  void dispatchRemoteRequest(request)
})

const api: ShunApi & LocalPathApi & RemoteWorkspaceApi & RemoteFileApi & WorkspaceLifecycleApi = {
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  relocateWorkspace: taskIds => ipcRenderer.invoke('workspace:relocate', taskIds),
  workspaceStatus: path => ipcRenderer.invoke('workspace:status', path),
  browseWorkspaces: path => ipcRenderer.invoke('workspace:browse', path),
  describeRemoteFile: path => ipcRenderer.invoke('remote-file:describe', path),
  readRemoteFileChunk: (path, offset, length) => ipcRenderer.invoke('remote-file:chunk', path, offset, length),
  openWorkspace: path => ipcRenderer.invoke('workspace:open', path),
  openLocalPath: path => ipcRenderer.invoke('local-path:open', path),
  describeLocalPath: (path, workspace) => ipcRenderer.invoke('local-path:describe', path, workspace),
  onBrowserPreviewCommand: fn => {
    const listener = (_event: Electron.IpcRendererEvent, command: BrowserPreviewCommand) => fn(command)
    ipcRenderer.on('browser-preview:command', listener)
    return () => ipcRenderer.removeListener('browser-preview:command', listener)
  },
  chooseAttachments: taskId => ipcRenderer.invoke('attachment:choose', taskId),
  importAttachments: (taskId, paths) => ipcRenderer.invoke('attachment:import', taskId, paths),
  importAttachmentData: (taskId, files) => ipcRenderer.invoke('attachment:import-data', taskId, files),
  listAttachments: taskId => ipcRenderer.invoke('attachment:list', taskId),
  previewAttachment: (taskId, attachmentId, page, purpose) => ipcRenderer.invoke('attachment:preview', taskId, attachmentId, page, purpose),
  copyAttachmentImage: (taskId, attachmentId) => ipcRenderer.invoke('attachment:image-copy', taskId, attachmentId),
  saveAttachmentImage: (taskId, attachmentId) => ipcRenderer.invoke('attachment:image-save', taskId, attachmentId),
  showAttachmentImageMenu: (taskId, attachmentId) => ipcRenderer.send('attachment:image-menu', taskId, attachmentId),
  removeAttachment: (taskId, attachmentId) => ipcRenderer.invoke('attachment:remove', taskId, attachmentId),
  deleteTaskData: taskId => ipcRenderer.invoke('task:delete-data', taskId),
  pathForFile: file => webUtils.getPathForFile(file),
  models: (endpoint: string, apiKey?: string, providerApi?: ProviderApi) => ipcRenderer.invoke('models:list', endpoint, apiKey, providerApi),
  providerCatalog: () => ipcRenderer.invoke('models:catalog'),
  testModel: (endpoint, apiKey, model, api) => ipcRenderer.invoke('models:test', endpoint, apiKey, model, api),
  load: () => ipcRenderer.invoke('state:load'),
  save: state => ipcRenderer.invoke('state:save', state),
  selectTask: id => ipcRenderer.send('state:select', id),
  exportTask: task => ipcRenderer.invoke('task:export', task),
  importTask: () => ipcRenderer.invoke('task:import'),
  diff: (taskId, workspace, files, patches) => ipcRenderer.invoke('workspace:diff', taskId, workspace, files, patches),
  repository: workspace => ipcRenderer.invoke('workspace:repository', workspace),
  pluginViews: settings => ipcRenderer.invoke('plugins:views', settings),
  openPluginView: (settings, pluginId, viewId, workspace, taskId) => ipcRenderer.invoke('plugins:view-open', settings, pluginId, viewId, workspace, taskId),
  closePluginView: accessToken => ipcRenderer.invoke('plugins:view-close', accessToken),
  pluginViewInvoke: (pluginId, viewId, accessToken, method, payload, workspace, taskId) => ipcRenderer.invoke('plugins:view-invoke', pluginId, viewId, accessToken, method, payload, workspace, taskId),
  watchPluginWorkspace: (pluginId, viewId, accessToken, workspace, taskId) => ipcRenderer.invoke('plugins:workspace-watch', pluginId, viewId, accessToken, workspace, taskId),
  unwatchPluginWorkspace: subscriptionId => ipcRenderer.invoke('plugins:workspace-unwatch', subscriptionId),
  importPluginPackage: settings => ipcRenderer.invoke('plugins:package-import', settings),
  reloadPluginPackage: pluginId => ipcRenderer.invoke('plugins:package-reload', pluginId),
  removePluginPackage: pluginId => ipcRenderer.invoke('plugins:package-remove', pluginId),
  taskEvents: (taskId, afterSeq) => ipcRenderer.invoke('task:events', taskId, afterSeq),
  publishRemoteTaskState: (taskId: string, event: RemoteTaskStateEvent) => ipcRenderer.invoke('remote:task-state', taskId, event),
  schedules: taskId => ipcRenderer.invoke('schedule:list', taskId),
  createSchedule: input => ipcRenderer.invoke('schedule:create', input),
  updateSchedule: (id, patch) => ipcRenderer.invoke('schedule:update', id, patch),
  removeSchedule: id => ipcRenderer.invoke('schedule:remove', id),
  runSchedule: id => ipcRenderer.invoke('schedule:run', id),
  plugins: settings => ipcRenderer.invoke('plugins:list', settings),
  skills: settings => ipcRenderer.invoke('skills:list', settings),
  createSkill: request => ipcRenderer.invoke('skills:create', request),
  importSkills: settings => ipcRenderer.invoke('skills:import', settings),
  readSkill: (id, settings) => ipcRenderer.invoke('skills:read', id, settings),
  updateSkill: (id, content, settings) => ipcRenderer.invoke('skills:update', id, content, settings),
  removeSkill: (id, settings) => ipcRenderer.invoke('skills:remove', id, settings),
  installSkillPackage: (source, settings) => ipcRenderer.invoke('skills:package-install', source, settings),
  updateSkillPackage: (source, settings) => ipcRenderer.invoke('skills:package-update', source, settings),
  removeSkillPackage: (source, settings) => ipcRenderer.invoke('skills:package-remove', source, settings),
  pluginConnection: pluginId => ipcRenderer.invoke('plugins:connection-state', pluginId),
  connectPlugin: (pluginId, credential) => ipcRenderer.invoke('plugins:connect', pluginId, credential),
  disconnectPlugin: pluginId => ipcRenderer.invoke('plugins:disconnect', pluginId),
  compact: (req, instructions) => ipcRenderer.invoke('agent:compact', req, instructions),
  activeRuns: () => ipcRenderer.invoke('agent:active-runs'),
  run: (req: AgentRequest) => ipcRenderer.invoke('agent:run', req),
  interrupt: req => ipcRenderer.invoke('agent:interrupt', req),
  revisionPreview: (taskId, messageId, workspace) => ipcRenderer.invoke('agent:revision-preview', taskId, messageId, workspace),
  revise: req => ipcRenderer.invoke('agent:revise', req),
  cancel: (id: string) => ipcRenderer.send('agent:cancel', id),
  backgroundList: sessionId => ipcRenderer.invoke('background:list', sessionId),
  backgroundListAll: () => ipcRenderer.invoke('background:list-all'),
  backgroundOutput: (sessionId, taskId, afterSeq) => ipcRenderer.invoke('background:output', sessionId, taskId, afterSeq),
  backgroundStop: (sessionId, taskId) => ipcRenderer.invoke('background:stop', sessionId, taskId),
  updateState: () => ipcRenderer.invoke('updater:state'),
  checkForUpdate: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  windowState: () => ipcRenderer.invoke('window:state'),
  beginRemotePairing: () => ipcRenderer.invoke('remote:pair'),
  remoteDevices: () => ipcRenderer.invoke('remote:devices'),
  onRemoteRequest: fn => {
    remoteRequestHandler = fn
    void drainRemoteRequests()
    return () => {
      queueMicrotask(() => {
        if (remoteRequestHandler === fn) remoteRequestHandler = undefined
      })
    }
  },
  onPairMobile: fn => { const listener = () => fn(); ipcRenderer.on('ui:pair-mobile', listener); return () => ipcRenderer.removeListener('ui:pair-mobile', listener) },
  onSettings: fn => { const listener = () => fn(); ipcRenderer.on('ui:settings', listener); return () => ipcRenderer.removeListener('ui:settings', listener) },
  onPluginPackage: fn => { const listener = (_: unknown, event: PluginPackageEvent) => fn(event); ipcRenderer.on('plugin:package-changed', listener); return () => ipcRenderer.removeListener('plugin:package-changed', listener) },
  onPluginWorkspace: fn => { const listener = (_: unknown, event: PluginWorkspaceChange) => fn(event); ipcRenderer.on('plugin:workspace-changed', listener); return () => ipcRenderer.removeListener('plugin:workspace-changed', listener) },
  onWorkspaceUnavailable: fn => { const listener = (_: unknown, event: WorkspaceUnavailableEvent) => fn(event); ipcRenderer.on('workspace:unavailable', listener); return () => ipcRenderer.removeListener('workspace:unavailable', listener) },
  onPluginViewProgress: fn => { const listener = (_: unknown, event: PluginViewProgress) => fn(event); ipcRenderer.on('plugin:view-progress', listener); return () => ipcRenderer.removeListener('plugin:view-progress', listener) },
  onTerminalEvent: (fn: (event: TerminalSessionEvent) => void) => { const listener = (_: unknown, event: TerminalSessionEvent) => fn(event); ipcRenderer.on('terminal:event', listener); return () => ipcRenderer.removeListener('terminal:event', listener) },
  onEvent: fn => {
    agentEventListeners.add(fn)
    if (taskEventListeners.size) for (const event of pendingAgentEvents.splice(0)) fn(event)
    return () => agentEventListeners.delete(fn)
  },
  onRunState: fn => {
    runStateListeners.add(fn)
    for (const state of pendingRunStates.splice(0)) fn(state)
    return () => runStateListeners.delete(fn)
  },
  onTaskEvent: fn => {
    taskEventListeners.add(fn)
    for (const event of pendingTaskEvents.splice(0)) fn(event)
    if (agentEventListeners.size) for (const event of pendingAgentEvents.splice(0)) for (const listener of agentEventListeners) listener(event)
    return () => taskEventListeners.delete(fn)
  },
  onScheduleEvent: fn => { const listener = (_: unknown, event: LocalScheduleEvent) => fn(event); ipcRenderer.on('schedule:event', listener); return () => ipcRenderer.removeListener('schedule:event', listener) },
  onBackgroundEvent: fn => { const listener = (_: unknown, event: BackgroundEvent) => fn(event); ipcRenderer.on('background:event', listener); return () => ipcRenderer.removeListener('background:event', listener) },
  onUpdate: fn => { const listener = (_: unknown, state: UpdateState) => fn(state); ipcRenderer.on('updater:state', listener); return () => ipcRenderer.removeListener('updater:state', listener) },
  onWindowState: fn => { const listener = (_: unknown, state: WindowState) => fn(state); ipcRenderer.on('window:state', listener); return () => ipcRenderer.removeListener('window:state', listener) }
}
contextBridge.exposeInMainWorld('shun', api)
