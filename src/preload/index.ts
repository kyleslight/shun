import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AgentEvent, AgentRequest, BackgroundEvent, ProviderApi, RemoteBridgeRequest, RemoteTaskStateEvent, ShunApi, TaskEventEnvelope, UpdateState, WindowState } from '../shared'

let remoteRequestHandler: ((request: RemoteBridgeRequest) => Promise<unknown>) | undefined
const queuedRemoteRequests = new Map<string, RemoteBridgeRequest>()
let drainingRemoteRequests = false

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

const api: ShunApi = {
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  openWorkspace: path => ipcRenderer.invoke('workspace:open', path),
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
  taskEvents: (taskId, afterSeq) => ipcRenderer.invoke('task:events', taskId, afterSeq),
  publishRemoteTaskState: (taskId: string, event: RemoteTaskStateEvent) => ipcRenderer.invoke('remote:task-state', taskId, event),
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
  run: (req: AgentRequest) => ipcRenderer.send('agent:run', req),
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
  onEvent: fn => { const listener = (_: unknown, event: AgentEvent) => fn(event); ipcRenderer.on('agent:event', listener); return () => ipcRenderer.removeListener('agent:event', listener) },
  onTaskEvent: fn => { const listener = (_: unknown, event: TaskEventEnvelope) => fn(event); ipcRenderer.on('task:event', listener); return () => ipcRenderer.removeListener('task:event', listener) },
  onBackgroundEvent: fn => { const listener = (_: unknown, event: BackgroundEvent) => fn(event); ipcRenderer.on('background:event', listener); return () => ipcRenderer.removeListener('background:event', listener) },
  onUpdate: fn => { const listener = (_: unknown, state: UpdateState) => fn(state); ipcRenderer.on('updater:state', listener); return () => ipcRenderer.removeListener('updater:state', listener) },
  onWindowState: fn => { const listener = (_: unknown, state: WindowState) => fn(state); ipcRenderer.on('window:state', listener); return () => ipcRenderer.removeListener('window:state', listener) }
}
contextBridge.exposeInMainWorld('shun', api)
