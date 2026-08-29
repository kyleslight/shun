import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { GitBranch, Puzzle, X } from 'lucide-preact'
import type { PluginViewContribution, Settings } from '../../shared'

type BrowserGuestLayout = { visible: boolean; x: number; y: number; width: number; height: number; scale: number }

export function PluginViewHost({ view, fileSelection, resourceTarget, language, theme, accent, close }: {
  view: PluginViewContribution
  fileSelection?: { path: string; requestId: string; collapseTree: boolean }
  resourceTarget?: { url: string; requestId: string; viewport?: { width: number; height: number; label?: string }; action?: 'back' | 'forward' | 'refresh' }
  language: 'zh' | 'en'
  theme: Settings['theme']
  accent: Settings['accent']
  close: () => void
}) {
  const preferredWidth = () => Math.min(760, Math.max(380, Math.round(innerWidth * .38)), Math.max(380, innerWidth - 620))
  const workspace = view.boundWorkspace,
    host = useRef<HTMLElement>(null),
    frame = useRef<HTMLIFrameElement>(null),
    browserGuest = useRef<Electron.WebviewTag | null>(null),
    pendingBrowserUrl = useRef(''),
    channel = useMemo(() => crypto.randomUUID(), [view.pluginId, view.viewId, view.accessToken]),
    [width, setWidth] = useState(preferredWidth),
    [resizing, setResizing] = useState(false),
    [browserMaximized, setBrowserMaximized] = useState(false),
    [browserLayout, setBrowserLayout] = useState<BrowserGuestLayout | null>(null),
    source = useMemo(() => {
      const url = new URL(view.url)
      url.searchParams.set('channel', channel)
      url.searchParams.set('host', '2')
      return url.href
    }, [view.url, channel])

  const sendFileSelection = () => {
    if (!fileSelection || view.pluginId !== 'file-manager') return
    frame.current?.contentWindow?.postMessage({ source: 'shun-host', channel, type: 'event', event: 'file.open', payload: fileSelection }, '*')
  }
  const sendResourceTarget = () => {
    if (!resourceTarget || !view.activation?.localEndpoints) return
    frame.current?.contentWindow?.postMessage({ source: 'shun-host', channel, type: 'event', event: 'resource.open', payload: resourceTarget }, '*')
  }
  const sendBrowserEvent = (payload: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ source: 'shun-host', channel, type: 'browser.event', payload }, '*')
  }
  const loadBrowserUrl = (value: unknown) => {
    let url: URL
    try { url = new URL(String(value || '')) } catch { return }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return
    pendingBrowserUrl.current = url.href
    const guest = browserGuest.current
    if (!guest) return
    try { void guest.loadURL(url.href).catch(error => sendBrowserEvent({ loading: false, error: error instanceof Error ? error.message : String(error) })) } catch {}
  }
  const runBrowserCommand = (command: Record<string, any>) => {
    if (command.type === 'layout') {
      const layout = command.layout
      if (!layout || typeof layout !== 'object') return
      setBrowserLayout({
        visible: layout.visible === true,
        x: Math.max(0, Number(layout.x) || 0),
        y: Math.max(0, Number(layout.y) || 0),
        width: Math.max(1, Number(layout.width) || 1),
        height: Math.max(1, Number(layout.height) || 1),
        scale: Math.max(.05, Math.min(1, Number(layout.scale) || 1)),
      })
      return
    }
    if (command.type === 'fullscreen') {
      const active = command.active === true
      setBrowserMaximized(active)
      sendBrowserEvent({ fullscreen: active })
      return
    }
    if (command.type === 'navigate') { loadBrowserUrl(command.url); return }
    const guest = browserGuest.current
    if (!guest) return
    try {
      if (command.type === 'refresh') guest.reload()
      else if (command.type === 'back' && guest.canGoBack()) guest.goBack()
      else if (command.type === 'forward' && guest.canGoForward()) guest.goForward()
    } catch {}
  }

  useEffect(() => {
    const sendContext = () => {
      const styles = getComputedStyle(document.documentElement)
      const themeTokens = Object.fromEntries([
        'accent', 'app-bg', 'sidebar-bg', 'surface-1', 'surface-2', 'surface-3', 'border-1', 'border-2',
        'text-1', 'text-2', 'text-3', 'text-4', 'hover-bg', 'sidebar-item-selected', 'code-bg',
      ].map(name => [name, styles.getPropertyValue(`--${name}`).trim()]))
      frame.current?.contentWindow?.postMessage({
        source: 'shun-host', channel, type: 'context',
        context: { workspace: workspace || null, language, theme: document.documentElement.dataset.theme || theme || 'system', accent, themeTokens, permissions: view.permissions },
      }, '*')
    }
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const message = event.data
      if (!message || message.source !== 'shun-plugin' || message.channel !== channel) return
      if (message.type === 'ready') { sendContext(); sendFileSelection(); sendResourceTarget(); return }
      if (view.pluginId === 'browser-preview' && message.type === 'browser.command' && message.command && typeof message.command === 'object') { runBrowserCommand(message.command); return }
      if (message.type !== 'request' || typeof message.requestId !== 'string' || typeof message.method !== 'string') return
      void window.shun.pluginViewInvoke(view.pluginId, view.viewId, view.accessToken, message.method, message.payload, workspace, view.boundTaskId).then(
        result => frame.current?.contentWindow?.postMessage({ source: 'shun-host', channel, type: 'response', requestId: message.requestId, result }, '*'),
        error => frame.current?.contentWindow?.postMessage({ source: 'shun-host', channel, type: 'response', requestId: message.requestId, error: error instanceof Error ? error.message : String(error) }, '*'),
      )
    }
    addEventListener('message', receive)
    sendContext()
    return () => removeEventListener('message', receive)
  }, [channel, workspace, language, theme, accent, view.pluginId, view.viewId, view.boundTaskId, fileSelection?.requestId, resourceTarget?.requestId])

  useEffect(() => { sendFileSelection() }, [channel, view.pluginId, fileSelection?.requestId])
  useEffect(() => { sendResourceTarget() }, [channel, view.pluginId, resourceTarget?.requestId])

  useEffect(() => {
    if (view.pluginId !== 'browser-preview') return
    const guest = browserGuest.current
    if (!guest) return
    const publish = (extra: Record<string, unknown> = {}) => {
      let url = '', canGoBack = false, canGoForward = false, guestId = 0
      try { url = guest.getURL(); canGoBack = guest.canGoBack(); canGoForward = guest.canGoForward(); guestId = guest.getWebContentsId() } catch {}
      sendBrowserEvent({ url, canGoBack, canGoForward, guestId, ...extra })
    }
    const attached = () => { if (pendingBrowserUrl.current) loadBrowserUrl(pendingBrowserUrl.current) }
    const started = () => publish({ loading: true })
    const stopped = () => publish({ loading: false, loaded: /^https?:\/\//i.test(guest.getURL()) })
    const navigated = (event: Event & { url?: string }) => publish({ url: event.url || guest.getURL() })
    const failed = (event: Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }) => {
      if (event.isMainFrame === false || event.errorCode === -3) return
      publish({ loading: false, error: event.errorDescription || 'The page did not load.' })
    }
    const gone = () => publish({ loading: false, error: 'The page stopped unexpectedly.' })
    guest.addEventListener('did-attach', attached)
    guest.addEventListener('did-start-loading', started)
    guest.addEventListener('did-stop-loading', stopped)
    guest.addEventListener('did-navigate', navigated)
    guest.addEventListener('did-navigate-in-page', navigated)
    guest.addEventListener('did-fail-load', failed)
    guest.addEventListener('render-process-gone', gone)
    return () => {
      guest.removeEventListener('did-attach', attached)
      guest.removeEventListener('did-start-loading', started)
      guest.removeEventListener('did-stop-loading', stopped)
      guest.removeEventListener('did-navigate', navigated)
      guest.removeEventListener('did-navigate-in-page', navigated)
      guest.removeEventListener('did-fail-load', failed)
      guest.removeEventListener('render-process-gone', gone)
    }
  }, [channel, view.pluginId, view.accessToken])

  useEffect(() => {
    if (view.pluginId !== 'browser-preview' || !browserMaximized) return
    const exit = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setBrowserMaximized(false)
      sendBrowserEvent({ fullscreen: false })
    }
    addEventListener('keydown', exit)
    return () => removeEventListener('keydown', exit)
  }, [channel, view.pluginId, browserMaximized])

  useEffect(() => window.shun.onPluginViewProgress(event => {
    if (event.accessToken !== view.accessToken) return
    const { accessToken: _accessToken, ...payload } = event
    frame.current?.contentWindow?.postMessage({ source: 'shun-host', channel, type: 'event', event: 'worker.progress', payload }, '*')
  }), [channel, view.accessToken])

  useEffect(() => {
    if (!workspace) return
    const watchFiles = view.permissions.some(permission => permission === 'workspace.read' || permission === 'workspace.git.read')
    let live = true, subscriptionId = ''
    const unsubscribe = window.shun.onPluginWorkspace(event => {
      if (!live) return
      if (event.type === 'state') {
        if (event.pluginId === view.pluginId && event.workspace === workspace) frame.current?.contentWindow?.postMessage({ source: 'shun-host', channel, type: 'event', event: 'workspace.state.changed', payload: { key: event.key, value: event.value } }, '*')
        return
      }
      if (event.subscriptionId !== subscriptionId) return
      frame.current?.contentWindow?.postMessage({ source: 'shun-host', channel, type: 'event', event: 'workspace.changed', payload: { paths: event.paths, overflow: event.overflow } }, '*')
    })
    if (watchFiles) void window.shun.watchPluginWorkspace(view.pluginId, view.viewId, view.accessToken, workspace, view.boundTaskId).then(id => {
        if (live) subscriptionId = id
        else void window.shun.unwatchPluginWorkspace(id)
      })
    return () => {
      live = false
      unsubscribe()
      if (subscriptionId) void window.shun.unwatchPluginWorkspace(subscriptionId)
    }
  }, [channel, workspace, view.pluginId, view.viewId, view.accessToken, view.boundTaskId, view.permissions])

  const beginResize = (event: PointerEvent) => {
    if (event.button) return
    const start = event.clientX, original = width, handle = event.currentTarget as HTMLElement
    event.preventDefault()
    setResizing(true)
    handle.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => setWidth(Math.min(Math.max(360, innerWidth - 420), Math.max(360, original + start - next.clientX)))
    const stop = (next: PointerEvent) => {
      move(next)
      setResizing(false)
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', stop)
      removeEventListener('pointercancel', stop)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', stop)
    addEventListener('pointercancel', stop)
  }

  const resizeWithKeyboard = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const step = event.shiftKey ? 40 : 10
    setWidth(current => Math.min(Math.max(360, innerWidth - 420), Math.max(360, current + (event.key === 'ArrowLeft' ? step : -step))))
  }

  const browserPreview = view.pluginId === 'browser-preview',
    frameSandbox = browserPreview
      ? 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads'
      : 'allow-scripts allow-same-origin',
    frameAllow = browserPreview ? 'clipboard-read; clipboard-write' : 'clipboard-write',
    macWindow = navigator.platform.includes('Mac')

  const BrowserGuest = 'webview' as any
  return <aside ref={host} class={`plugin-view-host${resizing ? ' is-resizing' : ''}${browserMaximized ? ' is-window-maximized' : ''}${macWindow ? ' is-mac-window' : ''}`} style={{ width: `${width}px` }} aria-label={view.title}>
    <button class="plugin-view-resizer" aria-label="Resize plugin view" aria-orientation="vertical" title="Drag to resize · Double-click to reset" onPointerDown={beginResize} onKeyDown={resizeWithKeyboard} onDblClick={() => setWidth(preferredWidth())} />
    <header class="plugin-view-host-header"><span>{view.iconUrl ? <img class="plugin-view-custom-icon" src={view.iconUrl} alt="" /> : view.icon === 'git' ? <GitBranch /> : <Puzzle />}<b>{view.title}</b></span><button aria-label="Close plugin view" onClick={close}><X /></button></header>
    <iframe key={view.accessToken} ref={frame} title={view.title} src={source} sandbox={frameSandbox} allow={frameAllow} />
    {browserPreview ? <BrowserGuest
      ref={(node: Electron.WebviewTag | null) => { browserGuest.current = node }}
      class="plugin-view-browser-guest"
      src="about:blank"
      partition="persist:shun-browser-preview"
      style={browserLayout ? {
        display: browserLayout.visible ? 'flex' : 'none',
        left: `${browserLayout.x}px`,
        top: `calc(var(--workspace-header-height, 48px) + ${browserLayout.y}px)`,
        width: `${browserLayout.width}px`,
        height: `${browserLayout.height}px`,
        transform: `scale(${browserLayout.scale})`,
      } : { display: 'none' }}
    /> : null}
  </aside>
}
