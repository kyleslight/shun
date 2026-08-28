import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { GitBranch, Puzzle, X } from 'lucide-preact'
import type { PluginViewContribution, Settings } from '../../shared'

export function PluginViewHost({ view, workspace, language, theme, accent, close }: {
  view: PluginViewContribution
  workspace: string
  language: 'zh' | 'en'
  theme: Settings['theme']
  accent: Settings['accent']
  close: () => void
}) {
  const preferredWidth = () => Math.min(1120, Math.max(680, Math.round(innerWidth * .56)), Math.max(680, innerWidth - 640))
  const frame = useRef<HTMLIFrameElement>(null),
    channel = useMemo(() => crypto.randomUUID(), [view.pluginId, view.viewId]),
    [width, setWidth] = useState(preferredWidth),
    [resizing, setResizing] = useState(false),
    source = `${view.url}?channel=${encodeURIComponent(channel)}`

  useEffect(() => {
    const sendContext = () => {
      const styles = getComputedStyle(document.documentElement)
      const themeTokens = Object.fromEntries([
        'accent', 'app-bg', 'sidebar-bg', 'surface-1', 'surface-2', 'surface-3', 'border-1', 'border-2',
        'text-1', 'text-2', 'text-3', 'text-4', 'hover-bg', 'sidebar-item-selected', 'code-bg',
      ].map(name => [name, styles.getPropertyValue(`--${name}`).trim()]))
      frame.current?.contentWindow?.postMessage({
        source: 'shun-host', channel, type: 'context',
        context: { workspace, language, theme: document.documentElement.dataset.theme || theme || 'system', accent, themeTokens, permissions: view.permissions },
      }, '*')
    }
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const message = event.data
      if (!message || message.source !== 'shun-plugin' || message.channel !== channel) return
      if (message.type === 'ready') { sendContext(); return }
      if (message.type !== 'request' || typeof message.requestId !== 'string' || typeof message.method !== 'string') return
      void window.shun.pluginViewInvoke(view.pluginId, view.viewId, view.accessToken, message.method, message.payload, workspace).then(
        result => frame.current?.contentWindow?.postMessage({ source: 'shun-host', channel, type: 'response', requestId: message.requestId, result }, '*'),
        error => frame.current?.contentWindow?.postMessage({ source: 'shun-host', channel, type: 'response', requestId: message.requestId, error: error instanceof Error ? error.message : String(error) }, '*'),
      )
    }
    addEventListener('message', receive)
    sendContext()
    return () => removeEventListener('message', receive)
  }, [channel, workspace, language, theme, accent, view.pluginId, view.viewId])

  useEffect(() => {
    if (!workspace || !view.permissions.some(permission => permission === 'workspace.read' || permission === 'workspace.git.read')) return
    let live = true, subscriptionId = ''
    const unsubscribe = window.shun.onPluginWorkspace(event => {
      if (!live || event.subscriptionId !== subscriptionId) return
      frame.current?.contentWindow?.postMessage({ source: 'shun-host', channel, type: 'event', event: 'workspace.changed', payload: { paths: event.paths, overflow: event.overflow } }, '*')
    })
    void window.shun.watchPluginWorkspace(view.pluginId, view.viewId, view.accessToken, workspace).then(id => {
      if (live) subscriptionId = id
      else void window.shun.unwatchPluginWorkspace(id)
    })
    return () => {
      live = false
      unsubscribe()
      if (subscriptionId) void window.shun.unwatchPluginWorkspace(subscriptionId)
    }
  }, [channel, workspace, view.pluginId, view.viewId, view.accessToken, view.permissions])

  const beginResize = (event: PointerEvent) => {
    if (event.button) return
    const start = event.clientX, original = width, handle = event.currentTarget as HTMLElement
    event.preventDefault()
    setResizing(true)
    handle.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => setWidth(Math.min(Math.max(440, innerWidth - 420), Math.max(440, original + start - next.clientX)))
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
    setWidth(current => Math.min(Math.max(440, innerWidth - 420), Math.max(440, current + (event.key === 'ArrowLeft' ? step : -step))))
  }

  return <aside class={`plugin-view-host${resizing ? ' is-resizing' : ''}`} style={{ width: `${width}px` }} aria-label={view.title}>
    <button class="plugin-view-resizer" aria-label="Resize plugin view" aria-orientation="vertical" title="Drag to resize · Double-click to reset" onPointerDown={beginResize} onKeyDown={resizeWithKeyboard} onDblClick={() => setWidth(preferredWidth())} />
    <header class="plugin-view-host-header"><span>{view.icon === 'git' ? <GitBranch /> : <Puzzle />}<b>{view.title}</b></span><button aria-label="Close plugin view" onClick={close}><X /></button></header>
    <iframe ref={frame} title={view.title} src={source} sandbox="allow-scripts" allow="clipboard-write" />
  </aside>
}
