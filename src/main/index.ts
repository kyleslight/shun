import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, shell } from 'electron'
import { exec as execCb } from 'node:child_process'
import { appendFile, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Type } from 'typebox'
import { defineTool, hasTrustRequiringProjectResources, ProjectTrustStore, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ImageContent } from '@earendil-works/pi-ai'
import type { AgentEvent, AgentRequest, Task } from '../shared'
import { searchPersistedEvents, searchPersistedTask } from './history'
import { enabledMcpServers, runMcpTool } from './mcp'
import { compactAgentSession, removeAgentSessions, runAgentSession } from './agent-runtime'
import { generateTaskTitle } from './task-title'
import { activeToolNames } from './capabilities'
import { isExternalWebUrl, isTrustedRendererNavigation, needsJitlessRenderer, shouldRecoverRenderer } from './renderer-stability'
import { configureWebSearchPersistence, readWeb, searchWeb, webUserAgent, type RenderPage } from './web'
import { BackgroundTaskManager } from './background-tasks'
import { TaskRunRegistry } from './task-runs'
import { AppUpdateService } from './app-updater'
import { ensureWorkspaceBaseline, patchesForFiles, removeWorkspaceBaseline, workspaceSnapshotDiff } from './workspace-review'
import { testModelDeployment } from './provider-connection'
import { readWorkspacePdf } from './pdf'
import { readAttachmentForModel } from './attachment-model-read'
import { clearAttachmentPreviewCache, previewAttachment } from './attachment-preview'
import { attachmentManifest, AttachmentStore } from './attachments'
import { createWorkspaceReadTool } from './workspace-read'
import { WebResearchPolicy } from './web-research-policy'

const exec = promisify(execCb)
const runs = new Map<string, AbortController>()
const taskRuns = new TaskRunRegistry()
const historyWrites = new Map<string, Promise<void>>()
const projectTrustPrompts = new Map<string, Promise<boolean>>()
const appUpdates = new AppUpdateService()
let win: BrowserWindow | null = null
let stateBackupWritten = false
let lastRendererRecovery = 0
if (process.env.SHUN_USER_DATA) app.setPath('userData', process.env.SHUN_USER_DATA)
configureWebSearchPersistence(join(app.getPath('userData'), 'web-search-state.json'))
const attachments = new AttachmentStore(join(app.getPath('userData'), 'attachments'))
const backgroundTasks = new BackgroundTaskManager(event => {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('background:event', event)
}, { storageFile: join(app.getPath('userData'), 'background-processes.json') })

if (needsJitlessRenderer(process.platform, process.arch, release(), process.versions.electron)) {
  // Electron 43 / V8 can crash while registering JIT pages on macOS 26 ARM64.
  // Shun's renderer is UI-bound, so stability is worth the small JS throughput cost.
  app.commandLine.appendSwitch('js-flags', '--jitless')
}

type WindowTheme = 'light' | 'dark'
type WindowThemeSource = WindowTheme | 'system'

function applyNativeWindowTheme(source: WindowThemeSource): WindowTheme {
  // Keep AppKit's titlebar edge and shadow appearance in step with Shun's UI.
  // Otherwise a light Shun window can retain macOS's dark native outline.
  nativeTheme.themeSource = source
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

async function storedWindowTheme(): Promise<WindowTheme> {
  for (const name of ['state.json', 'state.backup.json']) try {
    const state = JSON.parse(await readFile(join(app.getPath('userData'), name), 'utf8'))
    const theme = state?.settings?.theme
    if (theme === 'light' || theme === 'dark' || theme === 'system') return applyNativeWindowTheme(theme)
  } catch {}
  return applyNativeWindowTheme('system')
}

function createWindow(theme: WindowTheme) {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL || pathToFileURL(join(__dirname, '../renderer/index.html')).href
  const themedRendererUrl = new URL(rendererUrl)
  themedRendererUrl.searchParams.set('theme', theme)
  const windowUrl = themedRendererUrl.href
  const window = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 620, show: false,
    // The 12px macOS controls at y=18 are optically centered in the 48px renderer titlebar.
    backgroundColor: theme === 'light' ? '#f3f2f3' : '#141414',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 17, y: 18 },
    ...(process.platform === 'darwin' ? {
      hasShadow: true,
      vibrancy: 'under-window' as const,
      visualEffectState: 'active' as const,
    } : {}),
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  win = window
  const sendWindowState = () => {
    if (!window.isDestroyed()) window.webContents.send('window:state', { fullscreen: window.isFullScreen() })
  }
  window.on('enter-full-screen', sendWindowState)
  window.on('leave-full-screen', sendWindowState)
  window.once('ready-to-show', () => { window.show(); sendWindowState() })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererNavigation(url, windowUrl)) return
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
  void window.loadURL(windowUrl)
}

app.setName('Shun')
appUpdates.registerIpc()
app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromPath(join(app.getAppPath(), 'resources/app-icon.png')))
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Shun', submenu: [{ role: 'about' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => win?.webContents.send('ui:settings') }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]))
  createWindow(await storedWindowTheme())
  appUpdates.start()
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) void storedWindowTheme().then(createWindow)
  })
})
app.on('window-all-closed', () => process.platform === 'darwin' || app.quit())
app.on('before-quit', () => { appUpdates.stop(); backgroundTasks.preserveForAppExit() })

ipcMain.handle('workspace:choose', async () => (await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })).filePaths[0] || null)
ipcMain.handle('window:state', event => ({ fullscreen: BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false }))
ipcMain.handle('workspace:open', async (_, workspace: string) => shell.openPath(safe(workspace)))
ipcMain.handle('attachment:choose', async (_, taskId: string) => {
  const chosen = await dialog.showOpenDialog(win!, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Documents and images', extensions: ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  return chosen.canceled ? [] : attachments.importPaths(taskId, chosen.filePaths)
})
ipcMain.handle('attachment:import', (_, taskId: string, paths: string[]) => attachments.importPaths(taskId, Array.isArray(paths) ? paths : []))
ipcMain.handle('attachment:import-data', (_, taskId: string, files: Array<{ name?: unknown; data?: unknown }>) => {
  if (!Array.isArray(files)) throw Error('Attachment data must be an array.')
  return attachments.importBuffers(taskId, files.slice(0, 20).map((file, index) => {
    const value = file?.data
    const bytes = value instanceof ArrayBuffer
      ? Buffer.from(value)
      : ArrayBuffer.isView(value)
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : null
    if (!bytes) throw Error(`Attachment ${index + 1} has invalid binary data.`)
    return { name: typeof file.name === 'string' ? file.name : `pasted-image-${index + 1}.png`, bytes }
  }))
})
ipcMain.handle('attachment:preview', (_, taskId: string, attachmentId: string, page?: number, purpose?: unknown) => previewAttachment(attachments, taskId, attachmentId, page, purpose === 'model' ? 'model' : 'display'))
ipcMain.handle('attachment:remove', async (_, taskId: string, attachmentId: string) => {
  const removed = await attachments.remove(taskId, attachmentId)
  clearAttachmentPreviewCache(taskId, attachmentId)
  return removed
})
ipcMain.handle('task:delete-data', (_, taskId: string) => deleteTaskData(taskId))
ipcMain.handle('attachment:image-copy', (_, taskId: string, attachmentId: string) => copyAttachmentImage(taskId, attachmentId))
ipcMain.handle('attachment:image-save', (event, taskId: string, attachmentId: string) => saveAttachmentImage(BrowserWindow.fromWebContents(event.sender), taskId, attachmentId))
ipcMain.on('attachment:image-menu', (event, taskId: string, attachmentId: string) => {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner) return
  Menu.buildFromTemplate([
    { label: 'Copy Image', click: () => void copyAttachmentImage(taskId, attachmentId) },
    { label: 'Save Image As…', click: () => void saveAttachmentImage(owner, taskId, attachmentId) },
  ]).popup({ window: owner })
})
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
ipcMain.handle('models:test', async (_, endpoint: string, apiKey: string | undefined, model: string) =>
  testModelDeployment(endpoint, apiKey, model),
)
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
  const themeSource: WindowThemeSource = parsed.settings.theme === 'light' || parsed.settings.theme === 'dark' || parsed.settings.theme === 'system'
    ? parsed.settings.theme
    : 'system'
  const theme = applyNativeWindowTheme(themeSource)
  win?.setBackgroundColor(theme === 'light' ? '#f3f2f3' : '#141414')
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
  return { ...task, id: crypto.randomUUID(), attachments: [], turns: task.turns.map((turn: any) => ({ ...turn, attachments: undefined })), updatedAt: Date.now() }
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
ipcMain.handle('agent:compact', async (_, req: AgentRequest, instructions?: string) => {
  return compactAgentSession(req, { ...agentRuntimePaths(), cwd: await taskWorkingDirectory(req) }, instructions)
})
ipcMain.handle('background:list', (_, sessionId: string) => backgroundTasks.list(sessionId))
ipcMain.handle('background:list-all', () => backgroundTasks.listAll())
ipcMain.handle('background:output', (_, sessionId: string, taskId: string, afterSeq?: number) => backgroundTasks.output(sessionId, taskId, afterSeq))
ipcMain.handle('background:stop', (_, sessionId: string, taskId: string) => backgroundTasks.stop(sessionId, taskId))
ipcMain.on('agent:cancel', (_, id: string) => {
  runs.get(id)?.abort()
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
      // Persisted sessions and append-only task events remain authoritative if a
      // native renderer crash temporarily removes the UI event consumer.
      console.error('[agent:event]', error)
    }
  }
  void (async () => {
    const cwd = await taskWorkingDirectory(req)
    if (req.settings.workspace && !req.history.length) await ensureWorkspaceBaseline(req.settings.workspace, sessionId, workspaceBaselineDir())
    void recordTaskEvent(req.taskId, { type: 'request', runId: req.id, text: req.text })
    if (req.generateTitle) {
      try {
        const title = await generateTaskTitle(req, controller.signal, agentRuntimePaths().agentDir, cwd)
        if (title) publish({ id: req.id, type: 'title', text: title })
      } catch (error) {
        if (controller.signal.aborted) throw error
        console.warn('[task:title]', error)
      }
    }
    await runAgent(req, controller.signal, publish, cwd)
  })().catch(error => {
    if (controller.signal.aborted && !(controller.signal.reason instanceof Error && controller.signal.reason.name !== 'AbortError')) publish({ id: req.id, type: 'cancelled' })
    else publish({ id: req.id, type: 'error', text: failure(error, req, controller.signal) })
  }).finally(() => {
    runs.delete(req.id)
    taskRuns.release(sessionId, req.id)
  })
})

function agentRuntimePaths() {
  const root = join(app.getPath('userData'), 'agent-runtime')
  return { agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), standaloneDir: join(root, 'standalone') }
}

function taskPathId(req: Pick<AgentRequest, 'id' | 'taskId'>) {
  return Buffer.from(req.taskId || req.id).toString('base64url')
}

async function taskWorkingDirectory(req: AgentRequest) {
  if (req.settings.workspace) return resolve(req.settings.workspace)
  const cwd = join(agentRuntimePaths().standaloneDir, taskPathId(req))
  await mkdir(cwd, { recursive: true })
  return cwd
}

async function resolveTaskProjectTrust(cwd: string) {
  if (!hasTrustRequiringProjectResources(cwd)) return true
  const trustStore = new ProjectTrustStore(agentRuntimePaths().agentDir)
  const saved = trustStore.get(cwd)
  if (saved !== null) return saved
  const existing = projectTrustPrompts.get(cwd)
  if (existing) return existing
  const pending = dialog.showMessageBox(win!, {
    type: 'question',
    title: 'Trust project folder?',
    message: `Trust project-local configuration and extensions?\n${cwd}`,
    detail: 'Trusting allows Shun to load project-local settings, resources, packages, and extensions. This decision does not restrict or expand read, write, edit, or shell access.',
    buttons: ['Don’t trust', 'Trust'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }).then(result => {
    const trusted = result.response === 1
    trustStore.set(cwd, trusted)
    return trusted
  }).finally(() => projectTrustPrompts.delete(cwd))
  projectTrustPrompts.set(cwd, pending)
  return pending
}

function workspaceBaselineDir() {
  return join(app.getPath('userData'), 'workspace-baselines')
}

async function deleteTaskData(taskIdValue: unknown) {
  const taskId = String(taskIdValue || '')
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(taskId)) throw Error('Invalid task ID.')
  if (taskRuns.get(taskId)) throw Error('Stop the active task before deleting it.')
  backgroundTasks.discardSession(taskId)
  await (historyWrites.get(taskId) || Promise.resolve()).catch(() => {})
  historyWrites.delete(taskId)
  const paths = agentRuntimePaths()
  await Promise.all([
    attachments.removeTask(taskId),
    removeAgentSessions(taskId, paths.sessionDir),
    removeWorkspaceBaseline(taskId, workspaceBaselineDir()),
    rm(join(paths.standaloneDir, Buffer.from(taskId).toString('base64url')), { recursive: true, force: true }),
    rm(taskHistoryPath(taskId), { force: true }),
  ])
  clearAttachmentPreviewCache(taskId)
  return true
}

async function runAgent(req: AgentRequest, signal: AbortSignal, emit: (event: AgentEvent) => void, cwd: string) {
  const webResearch = new WebResearchPolicy(), productTools = createProductTools(req, webResearch, cwd), attached = req.attachments || []
  const images: ImageContent[] = []
  const inlineImageIds = new Set<string>()
  for (const item of attached.filter(item => item.kind === 'image')) {
    const preview = await previewAttachment(attachments, req.taskId || req.id, item.id)
    if (preview.mode === 'image') { images.push({ type: 'image', mimeType: preview.mimeType, data: preview.data }); inlineImageIds.add(item.id) }
  }
  const toolAttachments = attached.filter(item => !inlineImageIds.has(item.id))
  const runtimeRequest = toolAttachments.length ? { ...req, text: `${req.text}${attachmentManifest(toolAttachments)}` } : req
  const activeTools = activeToolNames(productTools.map(tool => tool.name))
  return runAgentSession(runtimeRequest, signal, emit, {
    ...agentRuntimePaths(), cwd, customTools: productTools, activeTools, enableExtensionTools: true,
    initialImages: images,
    outcomePolicy: webResearch,
    resolveProjectTrust: () => resolveTaskProjectTrust(cwd),
    beforeToolCall: async context => webResearch.beforeToolCall(context.toolCall.name),
  })
}

function createProductTools(req: AgentRequest, webResearch = new WebResearchPolicy(), cwd = req.settings.workspace || process.cwd()): ToolDefinition[] {
  const result = (output: unknown, details?: unknown) => ({ content: [{ type: 'text' as const, text: typeof output === 'string' ? output : JSON.stringify(output, null, 2) }], details })
  const sessionId = req.taskId || req.id
  const definitions: ToolDefinition[] = [
    defineTool({
      name: 'history_search', label: 'History search', description: 'Retrieve a bounded excerpt from this task’s persisted dialogue and tool history.',
      parameters: Type.Object({ query: Type.String(), max_results: Type.Optional(Type.Number()) }, { additionalProperties: false }),
      execute: async (_id, args) => result(await searchTaskHistory(req.taskId, args.query, args.max_results)),
    }),
    defineTool({
      name: 'attachment_list', label: 'List attachments', description: 'List files uploaded to this Shun task, including stable attachment IDs, detected types, sizes, and available reading capabilities.',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => result(await attachments.list(sessionId)),
    }),
    defineTool({
      name: 'attachment_read', label: 'Read attachment', description: 'Read one task-owned attachment by stable ID and return its native useful modality. Supported documents are decoded into format-appropriate semantic units behind one common read contract: a bounded file is returned directly, while a large file returns a structural overview and boundary samples. Search misses are valid empty results; use offset_chars only when raw continuation is actually required. Images return image content. PDF semantic reading is the default; set mode to ocr or visual with one explicit page only when the user requests visual PDF inspection.',
      parameters: Type.Object({
        attachment_id: Type.String(),
        mode: Type.Optional(Type.Union([Type.Literal('semantic'), Type.Literal('ocr'), Type.Literal('visual')])),
        page: Type.Optional(Type.Integer({ minimum: 1 })),
        query: Type.Optional(Type.String()),
        start_page: Type.Optional(Type.Integer({ minimum: 1 })),
        end_page: Type.Optional(Type.Integer({ minimum: 1 })),
        sheet: Type.Optional(Type.String()),
        max_chars: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 20_000 })),
        offset_chars: Type.Optional(Type.Integer({ minimum: 0 })),
      }, { additionalProperties: false }),
      execute: async (_id, args) => readAttachmentForModel(attachments, sessionId, args.attachment_id, {
        mode: args.mode,
        page: args.page,
        query: args.query,
        startPage: args.start_page,
        endPage: args.end_page,
        sheet: args.sheet,
        maxChars: args.max_chars,
        offsetChars: args.offset_chars,
      }),
    }),
    defineTool({
      name: 'web_search', label: 'Web search', description: 'Search the public web to discover relevant URLs. Use one high-information request: put the general subject in query, visible or quoted titles/publisher names in exact_phrases, and an expected host or host/path in site. Site constraints are enforced rather than treated as keywords, and results include match coverage. Do not substitute a similar result for an exact source. Calls are cached and tracked against a run-scoped evidence budget.',
      parameters: Type.Object({ query: Type.String(), site: Type.Optional(Type.String()), exact_phrases: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })), max_results: Type.Optional(Type.Number()) }, { additionalProperties: false }),
      execute: async (_id, args) => {
        const request = { query: args.query, site: args.site, exactPhrases: args.exact_phrases }
        return result(await webResearch.search(request, () => searchWeb(args.query, args.max_results, { site: args.site, exactPhrases: args.exact_phrases, renderPage: renderWebPage, fetchResource: fetchWebResource })))
      },
    }),
    defineTool({
      name: 'web_read', label: 'Web read', description: 'Open and extract a bounded readable segment from an HTTP(S) webpage or PDF. HTML reads also return deduplicated outbound_links ranked by the optional query, so a strong search lead can be opened and followed instead of issuing repeated searches. Identical reads are cached and evidence progress is tracked across this run.',
      parameters: Type.Object({ url: Type.String(), query: Type.Optional(Type.String()), max_chars: Type.Optional(Type.Number()), offset_chars: Type.Optional(Type.Number()) }, { additionalProperties: false }),
      execute: async (_id, args) => result(await webResearch.read({ url: args.url, query: args.query, maxChars: args.max_chars, offset: args.offset_chars }, () => readWeb(args.url, args.max_chars, renderWebPage, args.offset_chars, fetchWebResource, args.query))),
    }),
    defineTool({
      name: 'background_start', label: 'Start background process', description: 'Start a long-running server, watcher, or worker owned by this Shun task. Returns a stable task ID immediately; use background_output and background_stop instead of shell job control.',
      parameters: Type.Object({ command: Type.String(), label: Type.Optional(Type.String()) }, { additionalProperties: false }),
      execute: async (_id, args) => result(await backgroundTasks.start({ sessionId, createdByRunId: req.id, workspace: req.settings.workspace, cwd, command: args.command, label: args.label })),
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
  definitions.unshift(createWorkspaceReadTool(cwd), defineTool({
    name: 'read_pdf', label: 'Read PDF', description: 'Read any local PDF by a path relative to the task working directory or an absolute path, with Shun’s built-in cross-platform parser. Preserves page boundaries and basic line layout. Use query to find relevant pages, or start_page/end_page for a bounded range. No system PDF utility or package installation is needed.',
    parameters: Type.Object({
      path: Type.String(),
      query: Type.Optional(Type.String()),
      start_page: Type.Optional(Type.Integer({ minimum: 1 })),
      end_page: Type.Optional(Type.Integer({ minimum: 1 })),
      max_chars: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 20_000 })),
      offset_chars: Type.Optional(Type.Integer({ minimum: 0 })),
    }, { additionalProperties: false }),
    execute: async (_id, args) => result(await readWorkspacePdf(cwd, args.path, { query: args.query, startPage: args.start_page, endPage: args.end_page, maxChars: args.max_chars, offsetChars: args.offset_chars })),
  }))
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
  const page = new BrowserWindow({
    show: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  try {
    // Research pages are never user-facing. Muting before navigation prevents
    // autoplay audio from leaking out of an otherwise hidden Chromium window.
    page.webContents.setAudioMuted(true)
    page.webContents.on('media-started-playing', () => {
      if (!page.isDestroyed()) page.webContents.setAudioMuted(true)
    })
    page.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    page.webContents.setUserAgent(webUserAgent())
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      page.loadURL(url, { extraHeaders: 'Accept-Language: en-US,en;q=0.8\n' }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Chromium page load timed out.')), 25_000) }),
    ]).finally(() => clearTimeout(timer))
    let previous = '', stable = 0
    for (let attempt = 0; attempt < 7 && stable < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 350))
      const signature = String(await page.webContents.executeJavaScript('`${document.querySelectorAll("a[href]").length}:${document.body?.innerText?.length || 0}`'))
      stable = signature === previous ? stable + 1 : 0
      previous = signature
    }
    const snapshot = await page.webContents.executeJavaScript(`({
      html: document.documentElement.outerHTML,
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 3000).map(anchor => ({
        href: anchor.href,
        title: (anchor.getAttribute('aria-label') || anchor.getAttribute('title') || anchor.querySelector('img')?.getAttribute('alt') || anchor.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500)
      })).filter(link => link.href && link.title)
    })`)
    const manifest = JSON.stringify({ renderedLinks: snapshot.links || [] }).replace(/<\/script/gi, '<\\/script')
    return { html: `${String(snapshot.html || '').slice(0, 5_000_000)}<script type="application/json">${manifest}</script>`, finalUrl: page.webContents.getURL() }
  } finally {
    page.destroy()
  }
}

const fetchWebResource = async (url: string, maxBytes: number, timeoutMs: number) => {
  const response = await net.fetch(url, {
    redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': webUserAgent(), 'accept-language': 'en-US,en;q=0.8' },
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

async function copyAttachmentImage(taskId: string, attachmentId: string) {
  const { metadata, bytes } = await attachments.read(taskId, attachmentId)
  if (metadata.kind !== 'image') throw Error('Attachment is not an image.')
  let image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas'), source = await loadImage(bytes), canvas = createCanvas(source.width, source.height), context = canvas.getContext('2d')
    context.drawImage(source, 0, 0)
    image = nativeImage.createFromBuffer(canvas.toBuffer('image/png'))
  }
  if (image.isEmpty()) throw Error('Image could not be copied.')
  clipboard.writeImage(image)
  return true
}

async function saveAttachmentImage(owner: BrowserWindow | null, taskId: string, attachmentId: string) {
  const { metadata, bytes } = await attachments.read(taskId, attachmentId)
  if (metadata.kind !== 'image') throw Error('Attachment is not an image.')
  const result = await dialog.showSaveDialog(owner || win!, { defaultPath: metadata.name })
  if (result.canceled || !result.filePath) return false
  await writeFile(result.filePath, bytes)
  return true
}

function failure(error: unknown, req: AgentRequest, signal: AbortSignal) {
  if (signal.aborted) return signal.reason instanceof Error && signal.reason.name !== 'AbortError' ? signal.reason.message : ''
  const text = error instanceof Error ? error.message : String(error)
  if (req.attachments?.some(item => item.kind === 'image') && /(?:(?:image|vision|multimodal|image_url).{0,100}(?:not supported|unsupported|does not support|invalid)|(?:not supported|unsupported|does not support|only text).{0,100}(?:image|vision|multimodal|image_url|input)|invalid content type)/i.test(text)) {
    return req.settings.language === 'zh-CN' ? '当前模型或 Provider 不支持图片输入，请切换到支持图片的模型。' : 'The selected model or provider does not support image input.'
  }
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
