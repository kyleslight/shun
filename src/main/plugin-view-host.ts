import { clipboard, dialog, shell, type BrowserWindow, type WebContents } from 'electron'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import type { PluginViewProgress, TerminalSessionEvent } from '../shared.ts'

/**
 * One plugin view, as the surface rendering it sees it.
 *
 * A view is rendered somewhere — this app's own window, or a controller's own
 * screen — and the two are not the same surface, because a plugin asking to
 * reveal a file, choose a folder, copy text, or open a URL is asking about the
 * screen the person is looking at, while a plugin reading a file or running a
 * worker is asking about the machine holding the workspace, which is this one
 * either way. Only the first kind belongs here. That split is what lets the
 * workspace-facing half of the plugin RPC surface stay identical on every
 * surface, instead of each surface re-deriving which calls it can serve.
 *
 * The members a surface can genuinely lack are optional rather than throwing:
 * "this surface cannot ask" is a fact the dispatcher can state honestly, and a
 * controller with no folder picker should be told that rather than handed a
 * missing-window crash.
 */
export type PluginViewHost = {
  /** The surface, for ownership: two views shown in one window share this. */
  id: string
  /** Whether the person still has this view open. */
  viewing(): boolean
  /** Run once this view is gone, for resources the surface owns. Returns a way to stop caring. */
  onClose(listener: () => void): () => void
  /**
   * Where output belonging to this view's own sessions goes.
   *
   * This is called from the read loop of whatever produced the output, so it
   * must not block on the surface answering: a link that cannot keep up is the
   * surface's problem to coalesce and bound, not back-pressure into a pty. A
   * surface that sends synchronously and a surface that queues both satisfy
   * this; one that awaits a relay does not.
   */
  emit(event: PluginViewHostEvent): void
  /** Put text where the person is. */
  copyText(text: string): void
  /** Open a URL where the person is. */
  openExternal(url: string): Promise<void>
  /** Show a path where the person is, in the manner this surface has. */
  reveal(path: string, kind: 'file' | 'directory'): Promise<void>
  /** Open a path with whatever handles it where the person is. */
  openPath(path: string): Promise<void>
  /** Ask the person for a path. A surface that cannot ask leaves this out. */
  choosePath?(choice: PluginViewHostChoice): Promise<string | undefined>
  /** Open a path with a named application. A surface with no such idea leaves this out. */
  openWith?(path: string, application: string): Promise<{ canceled?: boolean; fallback?: string }>
  /** This surface's own browser guest, for Browser Preview. A surface without one leaves this out. */
  attachBrowserGuest?(request: { taskId: string; accessToken: string; url: string; guestId: unknown }): unknown
}

export type PluginViewHostEvent =
  | { type: 'terminal'; event: TerminalSessionEvent }
  | { type: 'progress'; progress: PluginViewProgress }
  | { type: 'files'; subscriptionId: string; paths: string[]; overflow: boolean }
  | { type: 'state'; pluginId: string; workspace: string; key: string; value: unknown }

export type PluginViewHostChoice = {
  title: string
  buttonLabel: string
  /** What the person is being asked to point at. */
  kind: 'directory' | 'file'
  defaultPath?: string
  filters?: Array<{ name: string; extensions: string[] }>
}

/**
 * The surface this app renders plugin views on: a window's renderer.
 *
 * The channel names are the renderer contract and do not change here — this
 * exists so the dispatcher stops naming a WebContents, not so the preload is
 * rewritten. Only the parts that are genuinely about this platform live here:
 * which dialog asks for a folder, which shell shows a file, which application
 * a plugin's `word` means. A controller's implementation of the same interface
 * answers those questions its own way, or not at all.
 */
export function electronPluginViewHost(input: {
  contents: WebContents
  window: () => BrowserWindow | null
  /** Browser Preview's own debugger, injected so this module does not import the service. */
  attachBrowserGuest?: (contents: WebContents, request: { taskId: string; accessToken: string; url: string; guestId: unknown }) => unknown
}): PluginViewHost {
  const { contents } = input
  let closed = false
  const closeListeners: Array<() => void> = []
  contents.once('destroyed', () => {
    closed = true
    for (const listener of closeListeners.splice(0)) listener()
  })
  const live = () => !closed && !contents.isDestroyed()
  const target = () => {
    const window = input.window()
    if (!window || window.isDestroyed()) throw Error('No window is available to ask for a path.')
    return window
  }
  return {
    id: String(contents.id),
    viewing: live,
    onClose: listener => {
      if (closed) { listener(); return () => {} }
      closeListeners.push(listener)
      return () => {
        const index = closeListeners.indexOf(listener)
        if (index >= 0) closeListeners.splice(index, 1)
      }
    },
    emit: event => {
      if (!live()) return
      if (event.type === 'terminal') { contents.send('terminal:event', event.event); return }
      if (event.type === 'progress') { contents.send('plugin:view-progress', event.progress); return }
      if (event.type === 'state') { contents.send('plugin:workspace-changed', { type: 'state', pluginId: event.pluginId, workspace: event.workspace, key: event.key, value: event.value }); return }
      contents.send('plugin:workspace-changed', { subscriptionId: event.subscriptionId, paths: event.paths, overflow: event.overflow })
    },
    copyText: text => { clipboard.writeText(text) },
    openExternal: async url => { await shell.openExternal(url) },
    reveal: async (path, kind) => {
      if (kind === 'file') { shell.showItemInFolder(path); return }
      const failure = await shell.openPath(path)
      if (failure) throw Error(failure)
    },
    openPath: async path => {
      const failure = await shell.openPath(path)
      if (failure) throw Error(failure)
    },
    choosePath: async choice => {
      const selection = await dialog.showOpenDialog(target(), {
        title: choice.title,
        buttonLabel: choice.buttonLabel,
        ...(choice.defaultPath ? { defaultPath: choice.defaultPath } : {}),
        properties: choice.kind === 'directory' ? ['openDirectory', 'createDirectory'] : ['openFile'],
        ...(choice.filters ? { filters: choice.filters } : {}),
      })
      if (selection.canceled || !selection.filePaths[0]) return undefined
      return selection.filePaths[0]
    },
    openWith: async (path, application) => {
      if (application === 'choose') {
        if (process.platform === 'darwin') {
          const chosen = await dialog.showOpenDialog(target(), {
            title: 'Open With',
            buttonLabel: 'Open',
            defaultPath: '/Applications',
            properties: ['openFile'],
            filters: [{ name: 'Applications', extensions: ['app'] }],
          })
          if (chosen.canceled || !chosen.filePaths[0]) return { canceled: true }
          await new Promise<void>((resolve, reject) => {
            const child = spawn('/usr/bin/open', ['-a', chosen.filePaths[0], path], { stdio: 'ignore' })
            child.once('error', reject)
            child.once('close', code => code === 0 ? resolve() : reject(Error('The selected application could not open this file.')))
          })
          return {}
        }
        if (process.platform === 'win32') {
          await new Promise<void>((resolve, reject) => {
            const child = spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', path], { detached: true, stdio: 'ignore', windowsHide: true })
            child.once('error', reject)
            child.once('spawn', () => { child.unref(); resolve() })
          })
          return {}
        }
        shell.showItemInFolder(path)
        return { fallback: 'reveal' }
      }
      const scheme = officeScheme(application)
      if (!scheme) throw Error('Unsupported workspace application.')
      await shell.openExternal(`${scheme}:ofe|u|${pathToFileURL(path).href}`)
      return {}
    },
    ...(input.attachBrowserGuest ? {
      attachBrowserGuest: (request: { taskId: string; accessToken: string; url: string; guestId: unknown }) => input.attachBrowserGuest!(contents, request),
    } : {}),
  }
}

/** The Office protocol handlers a plugin's application name can mean on a desktop. */
function officeScheme(application: string) {
  return ({ word: 'ms-word', excel: 'ms-excel', powerpoint: 'ms-powerpoint' } as Record<string, string>)[application]
}
