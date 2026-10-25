import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHostClient, verifyHost } from '../host/transport.ts'

let window: BrowserWindow | undefined
const call = createHostClient()
const methods = new Set(['hello', 'configuration', 'provider.save', 'provider.remove', 'provider.models', 'provider.test', 'model.select', 'task.list', 'task.create', 'task.snapshot', 'task.events', 'task.trust', 'task.send', 'task.stop', 'task.rename', 'task.delete', 'attachment.add', 'attachment.preview', 'background.list', 'background.read', 'background.stop', 'skill.list', 'skill.toggle', 'skill.install'])

export function registerHostDesktop(mainWindow: () => BrowserWindow | null = () => null, readAttachment?: (taskId: string, id: string) => Promise<{ metadata: { name: string }; bytes: Buffer }>) {
  ipcMain.handle('host:call', async (event, method: string, input: unknown) => {
    const owner = [window, mainWindow()].find(candidate => candidate && !candidate.isDestroyed() && candidate.webContents === event.sender)
    if (!owner || event.senderFrame !== owner.webContents.mainFrame) throw Error('This window cannot access the local Shun service.')
    if (!methods.has(method) || !input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid Shun request.')
    if (method === 'hello') return verifyHost(call)
    const args = input as Record<string, any>
    if (method === 'task.send' && args.desktopAttachments) {
      if (owner !== mainWindow() || !readAttachment || !Array.isArray(args.desktopAttachments) || args.desktopAttachments.length > 16) throw Error('Invalid attachments.')
      const ids = []
      for (const id of args.desktopAttachments) {
        const file = await readAttachment(String(args.taskId), String(id))
        ids.push((await call('attachment.add', { taskId: args.taskId, name: file.metadata.name, data: file.bytes.toString('base64') })).id)
      }
      input = { ...args, attachments: ids, desktopAttachments: undefined }
    }
    return call(method, input as Record<string, unknown>)
  })
}

export function hostTaskLink(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'shun:' || url.hostname !== 'task' || url.search || url.hash) return null
    const id = url.pathname.replace(/^\//, '')
    return !id || /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? { taskId: id } : null
  } catch { return null }
}

export function openHostDesktop(taskId = '') {
  if (window && !window.isDestroyed()) {
    window.show(); window.focus()
    const target = window.webContents
    if (target.isLoading()) target.once('did-finish-load', () => { if (!target.isDestroyed()) target.send('host:select', taskId) })
    else target.send('host:select', taskId)
    return
  }
  window = new BrowserWindow({ title: 'Shun', width: 1180, height: 800, minWidth: 720, minHeight: 500, backgroundColor: '#17191e',
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  window.on('closed', () => { window = undefined })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  const url = new URL(process.env.ELECTRON_RENDERER_URL || pathToFileURL(join(__dirname, '../renderer/index.html')).href)
  url.searchParams.set('host', 'local')
  if (taskId) url.searchParams.set('task', taskId)
  void window.loadURL(url.href)
}
