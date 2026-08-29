import { useEffect, useRef, useState } from 'preact/hooks'
import { Maximize2, Minimize2, SquareTerminal, X } from 'lucide-preact'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { PluginViewContribution, TerminalSessionEvent } from '../../shared'

const scrollbackLines = 10_000

export function TerminalPanel({ view, language, close }: {
  view: PluginViewContribution
  language: 'zh' | 'en'
  close: () => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const liveSession = useRef('')
  const [maximized, setMaximized] = useState(false)
  const [height, setHeight] = useState(() => Math.min(520, Math.max(260, Math.round(innerHeight * .42))))
  const zh = language === 'zh'

  const invoke = (method: string, payload: unknown = {}) => window.shun.pluginViewInvoke(
    view.pluginId,
    view.viewId,
    view.accessToken,
    method,
    payload,
    view.boundWorkspace,
    view.boundTaskId,
  )

  const start = async () => {
    const instance = terminal.current, fitter = fit.current
    if (!instance || !fitter) return
    fitter.fit()
    try {
      const result = await invoke('terminal.open', {
        cols: instance.cols,
        rows: instance.rows,
      }) as { sessionId?: string }
      liveSession.current = String(result.sessionId || '')
      instance.focus()
    } catch (error) {
      instance.writeln(`\r\n\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`)
    }
  }

  useEffect(() => {
    const element = container.current
    if (!element) return
    const styles = getComputedStyle(document.documentElement)
    const instance = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"SFMono-Regular", "Cascadia Code", Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: scrollbackLines,
      smoothScrollDuration: 0,
      allowTransparency: true,
      theme: {
        background: 'rgba(0, 0, 0, 0)',
        foreground: styles.getPropertyValue('--text-2').trim() || '#d4d4d4',
        cursor: styles.getPropertyValue('--text-1').trim() || '#eeeeee',
        cursorAccent: styles.getPropertyValue('--code-bg').trim() || '#111111',
        selectionBackground: styles.getPropertyValue('--sidebar-item-selected').trim() || '#32435c',
      },
    })
    const fitter = new FitAddon()
    instance.loadAddon(fitter)
    instance.open(element)
    terminal.current = instance
    fit.current = fitter

    let input = '', inputTimer = 0, output = '', outputFrame = 0
    const flushInput = () => {
      inputTimer = 0
      const data = input
      input = ''
      if (data && liveSession.current) void invoke('terminal.write', { data }).catch(() => {})
    }
    const dataDisposable = instance.onData(data => {
      input += data
      if (!inputTimer) inputTimer = window.setTimeout(flushInput, 8)
    })
    const unsubscribe = (window.shun as typeof window.shun & { onTerminalEvent(fn: (event: TerminalSessionEvent) => void): () => void }).onTerminalEvent(event => {
      if (event.accessToken !== view.accessToken || (liveSession.current && event.sessionId !== liveSession.current)) return
      if (event.type === 'data') {
        output += event.data
        if (!outputFrame) outputFrame = requestAnimationFrame(() => {
          outputFrame = 0
          const data = output
          output = ''
          instance.write(data)
        })
      } else {
        liveSession.current = ''
        instance.writeln(`\r\n\x1b[90m[${zh ? '进程已退出' : 'Process exited'} ${event.exitCode}]\x1b[0m`)
      }
    })
    let resizeFrame = 0
    const resize = new ResizeObserver(() => {
      if (resizeFrame) return
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0
        try { fitter.fit() } catch { return }
        if (liveSession.current) void invoke('terminal.resize', { cols: instance.cols, rows: instance.rows }).catch(() => {})
      })
    })
    resize.observe(element)
    void start()
    return () => {
      if (inputTimer) clearTimeout(inputTimer)
      if (outputFrame) cancelAnimationFrame(outputFrame)
      if (resizeFrame) cancelAnimationFrame(resizeFrame)
      resize.disconnect()
      unsubscribe()
      dataDisposable.dispose()
      instance.dispose()
      terminal.current = null
      fit.current = null
      liveSession.current = ''
    }
  }, [view.accessToken])

  useEffect(() => {
    requestAnimationFrame(() => {
      try { fit.current?.fit() } catch {}
      terminal.current?.focus()
    })
  }, [maximized, height])

  const beginResize = (event: PointerEvent) => {
    if (event.button || maximized) return
    const start = event.clientY, original = height, handle = event.currentTarget as HTMLElement
    event.preventDefault()
    handle.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => setHeight(Math.max(180, Math.min(innerHeight - 96, original + start - next.clientY)))
    const stop = (next: PointerEvent) => {
      move(next)
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', stop)
      removeEventListener('pointercancel', stop)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', stop)
    addEventListener('pointercancel', stop)
  }

  return <section class={`terminal-panel${maximized ? ' is-maximized' : ''}`} style={maximized ? undefined : { height: `${height}px` }} aria-label="Terminal">
    <button class="terminal-panel-resizer" aria-label={zh ? '调整终端高度' : 'Resize terminal'} onPointerDown={beginResize} />
    <header>
      <span class="terminal-panel-title"><SquareTerminal /><b>Terminal</b><small title={view.boundWorkspace}>{view.boundWorkspace}</small></span>
      <span class="terminal-panel-actions">
        <button title={maximized ? (zh ? '恢复下半屏' : 'Restore half screen') : (zh ? '占据对话流' : 'Fill conversation')} aria-label={maximized ? (zh ? '恢复下半屏' : 'Restore half screen') : (zh ? '占据对话流' : 'Fill conversation')} onClick={() => setMaximized(value => !value)}>{maximized ? <Minimize2 /> : <Maximize2 />}</button>
        <button title={zh ? '关闭并终止终端' : 'Close and stop terminal'} aria-label={zh ? '关闭并终止终端' : 'Close and stop terminal'} onClick={close}><X /></button>
      </span>
    </header>
    <div ref={container} class="terminal-canvas" onPointerDown={() => terminal.current?.focus()} />
  </section>
}
