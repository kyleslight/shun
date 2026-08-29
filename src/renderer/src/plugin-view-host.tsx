import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { GitBranch, Puzzle, X } from 'lucide-preact'
import type { PluginViewContribution, Settings } from '../../shared'

export function PluginViewHost({ view, language, theme, accent, close }: {
  view: PluginViewContribution
  language: 'zh' | 'en'
  theme: Settings['theme']
  accent: Settings['accent']
  close: () => void
}) {
  const preferredWidth = () => Math.min(760, Math.max(380, Math.round(innerWidth * .38)), Math.max(380, innerWidth - 620))
  const workspace = view.boundWorkspace,
    frame = useRef<HTMLIFrameElement>(null),
    channel = useMemo(() => crypto.randomUUID(), [view.pluginId, view.viewId, view.accessToken]),
    [width, setWidth] = useState(preferredWidth),
    [resizing, setResizing] = useState(false),
    source = useMemo(() => {
      const url = new URL(view.url)
      url.searchParams.set('channel', channel)
      url.searchParams.set('host', '2')
      return url.href
    }, [view.url, channel])

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
      if (message.type === 'ready') { sendContext(); return }
      if (message.type !== 'request' || typeof message.requestId !== 'string' || typeof message.method !== 'string') return
      void window.shun.pluginViewInvoke(view.pluginId, view.viewId, view.accessToken, message.method, message.payload, workspace, view.boundTaskId).then(
        result => frame.current?.contentWindow?.postMessage({ source: 'shun-host', channel, type: 'response', requestId: message.requestId, result }, '*'),
        error => frame.current?.contentWindow?.postMessage({ source: 'shun-host', channel, type: 'response', requestId: message.requestId, error: error instanceof Error ? error.message : String(error) }, '*'),
      )
    }
    addEventListener('message', receive)
    sendContext()
    return () => removeEventListener('message', receive)
  }, [channel, workspace, language, theme, accent, view.pluginId, view.viewId, view.boundTaskId])

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

  return <aside class={`plugin-view-host${resizing ? ' is-resizing' : ''}`} style={{ width: `${width}px` }} aria-label={view.title}>
    <button class="plugin-view-resizer" aria-label="Resize plugin view" aria-orientation="vertical" title="Drag to resize · Double-click to reset" onPointerDown={beginResize} onKeyDown={resizeWithKeyboard} onDblClick={() => setWidth(preferredWidth())} />
    <header class="plugin-view-host-header"><span>{view.iconUrl ? <img class="plugin-view-custom-icon" src={view.iconUrl} alt="" /> : view.icon === 'git' ? <GitBranch /> : <Puzzle />}<b>{view.title}</b></span><button aria-label="Close plugin view" onClick={close}><X /></button></header>
    <iframe key={view.accessToken} ref={frame} title={view.title} src={source} sandbox="allow-scripts allow-same-origin" allow="clipboard-write" />
  </aside>
}
