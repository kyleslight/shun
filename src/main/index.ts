import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, shell } from 'electron'
import { exec as execCb } from 'node:child_process'
import { appendFile, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Type } from 'typebox'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentEvent, AgentRequest, Task } from '../shared'
import { searchPersistedEvents, searchPersistedTask } from './history'
import { enabledMcpServers, runMcpTool } from './mcp'
import { compactPiSession, runPiAgent } from './pi-runtime'
import { generateTaskTitle } from './task-title'
import { activeToolNames } from './capabilities'
import { toolNeedsApproval } from './permissions'
import { isExternalWebUrl, isTrustedRendererNavigation, needsJitlessRenderer, shouldRecoverRenderer } from './renderer-stability'
import { readWeb, searchWeb, type RenderPage } from './web'
import { BackgroundTaskManager } from './background-tasks'
import { TaskRunRegistry } from './task-runs'
import { AppUpdateService } from './app-updater'
import { ensureWorkspaceBaseline, patchesForFiles, workspaceSnapshotDiff } from './workspace-review'

const exec = promisify(execCb)
const runs = new Map<string, AbortController>()
const taskRuns = new TaskRunRegistry()
const approvals = new Map<string, (allow: boolean) => void>()
const historyWrites = new Map<string, Promise<void>>()
const appUpdates = new AppUpdateService()
let win: BrowserWindow | null = null
let stateBackupWritten = false
let lastRendererRecovery = 0
if (process.env.SHUN_USER_DATA) app.setPath('userData', process.env.SHUN_USER_DATA)
const backgroundTasks = new BackgroundTaskManager(event => {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('background:event', event)
}, { storageFile: join(app.getPath('userData'), 'background-processes.json') })

if (needsJitlessRenderer(process.platform, process.arch, release(), process.versions.electron)) {
  // Electron 43 / V8 can crash while registering JIT pages on macOS 26 ARM64.
  // Shun's renderer is UI-bound, so stability is worth the small JS throughput cost.
  app.commandLine.appendSwitch('js-flags', '--jitless')
}

function createWindow() {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL || pathToFileURL(join(__dirname, '../renderer/index.html')).href
  const window = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 620, show: false,
    backgroundColor: '#111214', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 17, y: 18 },
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  win = window
  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererNavigation(url, rendererUrl)) return
    event.preventDefault()
    if (isExternalWebUrl(url)) void shell.openExternal(url)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer-process-gone]', details)
    const now = Date.now()
    if (!shouldRecoverRenderer(details.reason, now - lastRendererRecovery) || window.isDestroyed()) return
    lastRendererRecovery = now
    setTimeout(() => {
      if (!window.isDestroyed()) window.webContents.reload()
    }, 250)
  })
  void window.loadURL(rendererUrl)
}

app.setName('Shun')
appUpdates.registerIpc()
app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromPath(join(app.getAppPath(), 'resources/app-icon.png')))
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Shun', submenu: [{ role: 'about' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => win?.webContents.send('ui:settings') }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]))
  createWindow()
  appUpdates.start()
  app.on('activate', () => BrowserWindow.getAllWindows().length || createWindow())
})
app.on('window-all-closed', () => process.platform === 'darwin' || app.quit())
app.on('before-quit', () => { appUpdates.stop(); backgroundTasks.preserveForAppExit() })

ipcMain.handle('workspace:choose', async () => (await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })).filePaths[0] || null)
ipcMain.handle('workspace:open', async (_, workspace: string) => shell.openPath(safe(workspace)))
ipcMain.handle('models:list', async (_, endpoint: string, apiKey?: string) => {
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, '')}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw Error(`${response.status} ${await response.text()}`)
    const json: any = await response.json()
    return (json.data || []).map((model: any) => model.id).filter(Boolean)
  } catch (error) {
    console.error('[models:list]', endpoint, error)
    return []
  }
})
ipcMain.handle('state:load', async () => {
  for (const name of ['state.json', 'state.backup.json']) try {
    const state = JSON.parse(await readFile(join(app.getPath('userData'), name), 'utf8'))
    if (!Array.isArray(state.tasks) || !state.settings) continue
    try {
      const selected = (await readFile(join(app.getPath('userData'), 'selection'), 'utf8')).trim()
      if (state.tasks.some((task: Task) => task.id === selected)) state.currentId = selected
    } catch {}
    return state
  } catch {}
  return null
})
ipcMain.handle('state:save', async (_, state: unknown) => {
  const path = join(app.getPath('userData'), 'state.json')
  const backup = join(app.getPath('userData'), 'state.backup.json')
  const temp = `${path}.tmp`
  const json = JSON.stringify(state)
  const parsed = JSON.parse(json)
  if (!Array.isArray(parsed.tasks) || !parsed.settings) throw Error('Refusing to save invalid Shun state.')
  await mkdir(dirname(path), { recursive: true })
  if (!stateBackupWritten) try {
    const current = JSON.parse(await readFile(path, 'utf8'))
    if (Array.isArray(current.tasks) && current.settings) {
      await copyFile(path, backup)
      stateBackupWritten = true
    }
  } catch {}
  await writeFile(temp, json)
  await rename(temp, path)
})
ipcMain.on('state:select', (_, id: string) => {
  if (typeof id !== 'string' || id.length > 100) return
  const path = join(app.getPath('userData'), 'selection')
  void mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, id)).catch(error => console.error('[state:select]', error))
})
ipcMain.handle('task:export', async (_, task: Task) => {
  const result = await dialog.showSaveDialog(win!, { defaultPath: `${fileName(task.title)}.shun.json`, filters: [{ name: 'Shun task', extensions: ['json'] }] })
  if (result.canceled || !result.filePath) return false
  await writeFile(result.filePath, JSON.stringify({ format: 'shun-task', version: 1, task }, null, 2))
  return true
})
ipcMain.handle('task:import', async () => {
  const result = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'Shun task', extensions: ['json'] }] })
  if (result.canceled || !result.filePaths[0]) return null
  const data = JSON.parse(await readFile(result.filePaths[0], 'utf8'))
  const task = data?.format === 'shun-task' ? data.task : data
  if (!task || typeof task.title !== 'string' || !Array.isArray(task.turns)) throw Error('This is not a valid Shun task.')
  return { ...task, id: crypto.randomUUID(), updatedAt: Date.now() }
})
ipcMain.handle('workspace:diff', async (_, taskId: string, workspace: string, files: string[] = [], patches: string[] = []) => {
  const root = safe(workspace)
  try {
    const { stdout: status } = await exec('git status --short', { cwd: root, timeout: 5_000 })
    const { stdout: diff } = await exec('git diff --no-ext-diff --no-color -- .', { cwd: root, timeout: 10_000, maxBuffer: 2_000_000 })
    const untracked = status.split('\n').filter(line => line.startsWith('?? ')).map(line => line.slice(3))
    return [diff.trim(), await patchesForFiles(root, untracked)].filter(Boolean).join('\n\n') || 'No changes.'
  } catch {
    return workspaceSnapshotDiff(root, taskId, workspaceBaselineDir(), files, patches)
  }
})
ipcMain.handle('agent:compact', (_, req: AgentRequest, instructions?: string) => compactPiSession(req, piRuntimePaths(), instructions))
ipcMain.handle('background:list', (_, sessionId: string) => backgroundTasks.list(sessionId))
ipcMain.handle('background:list-all', () => backgroundTasks.listAll())
ipcMain.handle('background:output', (_, sessionId: string, taskId: string, afterSeq?: number) => backgroundTasks.output(sessionId, taskId, afterSeq))
ipcMain.handle('background:stop', (_, sessionId: string, taskId: string) => backgroundTasks.stop(sessionId, taskId))
ipcMain.on('agent:approve', (_, runId: string, callId: string, allow: boolean) => {
  const key = `${runId}:${callId}`
  approvals.get(key)?.(allow)
  approvals.delete(key)
})
ipcMain.on('agent:cancel', (_, id: string) => {
  runs.get(id)?.abort()
  for (const [key, resolve] of approvals) if (key.startsWith(`${id}:`)) {
    resolve(false)
    approvals.delete(key)
  }
})
ipcMain.on('agent:run', (event, req: AgentRequest) => {
  const sessionId = req.taskId || req.id
  const activeRun = taskRuns.claim(sessionId, req.id)
  if (activeRun) {
    event.sender.send('agent:event', { id: req.id, type: 'error', text: `This task is already running (${activeRun}). Queue or stop that run before starting another.` } satisfies AgentEvent)
    return
  }
  const controller = new AbortController()
  runs.set(req.id, controller)
  const publish = (data: AgentEvent) => {
    if (['tool', 'compacted', 'done', 'error'].includes(data.type)) void recordTaskEvent(req.taskId, data)
    try {
      if (!event.sender.isDestroyed()) event.sender.send('agent:event', data)
    } catch (error) {
      // Pi sessions and append-only task events remain authoritative if a
      // native renderer crash temporarily removes the UI event consumer.
      console.error('[agent:event]', error)
    }
  }
  void (async () => {
    if (req.settings.workspace && !req.history.length) await ensureWorkspaceBaseline(req.settings.workspace, sessionId, workspaceBaselineDir())
    void recordTaskEvent(req.taskId, { type: 'request', runId: req.id, text: req.text })
    if (req.generateTitle) {
      try {
        const title = await generateTaskTitle(req, controller.signal, piRuntimePaths().agentDir)
        if (title) publish({ id: req.id, type: 'title', text: title })
      } catch (error) {
        if (controller.signal.aborted) throw error
        console.warn('[task:title]', error)
      }
    }
    await runAgent(req, controller.signal, publish)
  })().catch(error => {
    if (controller.signal.aborted && !(controller.signal.reason instanceof Error && controller.signal.reason.name !== 'AbortError')) publish({ id: req.id, type: 'cancelled' })
    else publish({ id: req.id, type: 'error', text: failure(error, req, controller.signal) })
  }).finally(() => {
    runs.delete(req.id)
    taskRuns.release(sessionId, req.id)
  })
})

function piRuntimePaths() {
  const root = join(app.getPath('userData'), 'pi')
  return { agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions') }
}

function workspaceBaselineDir() {
  return join(app.getPath('userData'), 'workspace-baselines')
}

async function runAgent(req: AgentRequest, signal: AbortSignal, emit: (event: AgentEvent) => void) {
  const productTools = createProductTools(req)
  const activeTools = activeToolNames(req.settings.workspace, productTools.map(tool => tool.name))
  return runPiAgent(req, signal, emit, {
    ...piRuntimePaths(), customTools: productTools, activeTools, enableExtensionTools: true,
    beforeToolCall: async (context, toolSignal) => {
      const name = context.toolCall.name
      const args: any = context.args || {}
      if (toolNeedsApproval(req.settings.permission, name)) {
        emit({ id: req.id, type: 'approval', tool: { id: context.toolCall.id, name, input: JSON.stringify(args), state: 'waiting' } })
        if (!await approval(req.id, context.toolCall.id, toolSignal || signal)) return { block: true, reason: 'Declined by user.' }
      }
    },
  })
}

function createProductTools(req: AgentRequest): ToolDefinition[] {
  const result = (output: unknown, details?: unknown) => ({ content: [{ type: 'text' as const, text: typeof output === 'string' ? output : JSON.stringify(output, null, 2) }], details })
  const sessionId = req.taskId || req.id
  const definitions: ToolDefinition[] = [
    defineTool({
      name: 'history_search', label: 'History search', description: 'Retrieve a bounded excerpt from this task’s persisted dialogue and tool history.',
      parameters: Type.Object({ query: Type.String(), max_results: Type.Optional(Type.Number()) }, { additionalProperties: false }),
      execute: async (_id, args) => result(await searchTaskHistory(req.taskId, args.query, args.max_results)),
    }),
    defineTool({
      name: 'web_search', label: 'Web search', description: 'Search the public web to discover relevant URLs.',
      parameters: Type.Object({ query: Type.String(), max_results: Type.Optional(Type.Number()) }, { additionalProperties: false }),
      execute: async (_id, args) => result(await searchWeb(args.query, args.max_results)),
    }),
    defineTool({
      name: 'web_read', label: 'Web read', description: 'Open and extract a bounded readable segment from an HTTP(S) webpage or PDF.',
      parameters: Type.Object({ url: Type.String(), query: Type.Optional(Type.String()), max_chars: Type.Optional(Type.Number()), offset_chars: Type.Optional(Type.Number()) }, { additionalProperties: false }),
      execute: async (_id, args) => result(await readWeb(args.url, args.max_chars, renderWebPage, args.offset_chars, fetchWebResource, args.query)),
    }),
    defineTool({
      name: 'background_start', label: 'Start background process', description: 'Start a long-running server, watcher, or worker owned by this Shun task. Returns a stable task ID immediately; use background_output and background_stop instead of shell job control.',
      parameters: Type.Object({ command: Type.String(), label: Type.Optional(Type.String()) }, { additionalProperties: false }),
      execute: async (_id, args) => result(await backgroundTasks.start({ sessionId, createdByRunId: req.id, workspace: req.settings.workspace, command: args.command, label: args.label })),
    }),
    defineTool({
      name: 'background_list', label: 'List background processes', description: 'List background processes owned by this Shun task, including lifecycle state, PID, and discovered local endpoints.',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => result(backgroundTasks.list(sessionId)),
    }),
    defineTool({
      name: 'background_output', label: 'Read background output', description: 'Read bounded stdout/stderr chunks from a background process owned by this Shun task.',
      parameters: Type.Object({ task_id: Type.String(), after_seq: Type.Optional(Type.Number()) }, { additionalProperties: false }),
      execute: async (_id, args) => result(backgroundTasks.output(sessionId, args.task_id, args.after_seq)),
    }),
    defineTool({
      name: 'background_stop', label: 'Stop background process', description: 'Stop the complete process group of a background process owned by this Shun task.',
      parameters: Type.Object({ task_id: Type.String() }, { additionalProperties: false }),
      execute: async (_id, args) => result(await backgroundTasks.stop(sessionId, args.task_id)),
    }),
  ]
  if (enabledMcpServers(req.settings).length) definitions.push(
    defineTool({
      name: 'mcp_list', label: 'MCP tools', description: 'List configured MCP servers or discover the tools exposed by one server.',
      parameters: Type.Object({ server: Type.Optional(Type.String()) }, { additionalProperties: false }),
      execute: async (_id, args) => { const value = await runMcpTool('mcp_list', args, req.settings); return result(value.output, value) },
    }),
    defineTool({
      name: 'mcp_call', label: 'MCP call', description: 'Call a discovered tool on a configured MCP server.',
      parameters: Type.Object({ server: Type.String(), name: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }),
      execute: async (_id, args) => { const value = await runMcpTool('mcp_call', args, req.settings); return result(value.output, value) },
    }),
  )
  return definitions
}

function approval(runId: string, callId: string, signal: AbortSignal) {
  return new Promise<boolean>(resolve => {
    const key = `${runId}:${callId}`
    const done = (allow: boolean) => { signal.removeEventListener('abort', abort); approvals.delete(key); resolve(allow) }
    const abort = () => done(false)
    approvals.set(key, done)
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function searchTaskHistory(taskId: string | undefined, query: string, maxResults?: number) {
  const limit = Number(maxResults) || 8
  let stateResult = ''
  try {
    stateResult = searchPersistedTask(JSON.parse(await readFile(join(app.getPath('userData'), 'state.json'), 'utf8')), taskId, query, limit)
  } catch {}
  if (stateResult && !/^No (?:persisted|task history)/.test(stateResult)) return stateResult
  try {
    const rows = (await readFile(taskHistoryPath(taskId), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    return searchPersistedEvents(rows, query, limit)
  } catch {
    return stateResult || 'No persisted history is available for this task.'
  }
}

const renderWebPage: RenderPage = async url => {
  const page = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
  try {
    page.webContents.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36')
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      page.loadURL(url, { extraHeaders: 'Accept-Language: en-US,en;q=0.8\n' }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Chromium page load timed out.')), 25_000) }),
    ]).finally(() => clearTimeout(timer))
    await new Promise(resolve => setTimeout(resolve, 800))
    const html = await page.webContents.executeJavaScript('document.documentElement.outerHTML')
    return { html: String(html).slice(0, 5_000_000), finalUrl: page.webContents.getURL() }
  } finally {
    page.destroy()
  }
}

const fetchWebResource = async (url: string, maxBytes: number, timeoutMs: number) => {
  const response = await net.fetch(url, {
    redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36', 'accept-language': 'en-US,en;q=0.8' },
  })
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maxBytes) throw Error(`resource exceeds ${maxBytes} bytes`)
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length > maxBytes) throw Error(`resource exceeds ${maxBytes} bytes`)
  return { body, status: response.status, contentType: response.headers.get('content-type') || '', finalUrl: response.url || url }
}

function safe(root: string, path = '.') {
  const base = resolve(root)
  const target = resolve(base, path)
  if (target !== base && !target.startsWith(base + sep)) throw Error('Path escapes workspace.')
  return target
}

function failure(error: unknown, req: AgentRequest, signal: AbortSignal) {
  if (signal.aborted) return signal.reason instanceof Error && signal.reason.name !== 'AbortError' ? signal.reason.message : ''
  const text = error instanceof Error ? error.message : String(error)
  return /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(text) ? `Cannot reach ${req.settings.endpoint}. Check the provider in Settings.` : text
}

function fileName(value: string) {
  return value.trim().replace(/[^a-z0-9\u4e00-\u9fff_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'shun-task'
}

function taskHistoryPath(taskId?: string) {
  const id = String(taskId || 'unknown').replace(/[^a-z0-9_-]/gi, '_').slice(0, 100)
  return join(app.getPath('userData'), 'task-history', `${id}.jsonl`)
}

function recordTaskEvent(taskId: string | undefined, event: unknown) {
  if (!taskId) return Promise.resolve()
  const path = taskHistoryPath(taskId)
  const prior = historyWrites.get(taskId) || Promise.resolve()
  const next = prior.catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify({ at: Date.now(), ...event as any })}\n`)
  }).catch(error => console.error('[task-history]', error))
  historyWrites.set(taskId, next)
  return next
}
