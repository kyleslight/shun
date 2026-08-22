import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, AgentRequest, BackgroundEvent, ShunApi, UpdateState } from '../shared'

const api: ShunApi = {
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  openWorkspace: path => ipcRenderer.invoke('workspace:open', path),
  models: (endpoint: string, apiKey?: string) => ipcRenderer.invoke('models:list', endpoint, apiKey),
  load: () => ipcRenderer.invoke('state:load'),
  save: state => ipcRenderer.invoke('state:save', state),
  selectTask: id => ipcRenderer.send('state:select', id),
  exportTask: task => ipcRenderer.invoke('task:export', task),
  importTask: () => ipcRenderer.invoke('task:import'),
  diff: (taskId, workspace, files, patches) => ipcRenderer.invoke('workspace:diff', taskId, workspace, files, patches),
  compact: (req, instructions) => ipcRenderer.invoke('agent:compact', req, instructions),
  run: (req: AgentRequest) => ipcRenderer.send('agent:run', req),
  cancel: (id: string) => ipcRenderer.send('agent:cancel', id),
  approve: (runId, callId, allow) => ipcRenderer.send('agent:approve', runId, callId, allow),
  backgroundList: sessionId => ipcRenderer.invoke('background:list', sessionId),
  backgroundListAll: () => ipcRenderer.invoke('background:list-all'),
  backgroundOutput: (sessionId, taskId, afterSeq) => ipcRenderer.invoke('background:output', sessionId, taskId, afterSeq),
  backgroundStop: (sessionId, taskId) => ipcRenderer.invoke('background:stop', sessionId, taskId),
  updateState: () => ipcRenderer.invoke('updater:state'),
  checkForUpdate: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onSettings: fn => { const listener = () => fn(); ipcRenderer.on('ui:settings', listener); return () => ipcRenderer.removeListener('ui:settings', listener) },
  onEvent: fn => { const listener = (_: unknown, event: AgentEvent) => fn(event); ipcRenderer.on('agent:event', listener); return () => ipcRenderer.removeListener('agent:event', listener) },
  onBackgroundEvent: fn => { const listener = (_: unknown, event: BackgroundEvent) => fn(event); ipcRenderer.on('background:event', listener); return () => ipcRenderer.removeListener('background:event', listener) },
  onUpdate: fn => { const listener = (_: unknown, state: UpdateState) => fn(state); ipcRenderer.on('updater:state', listener); return () => ipcRenderer.removeListener('updater:state', listener) }
}
contextBridge.exposeInMainWorld('shun', api)
