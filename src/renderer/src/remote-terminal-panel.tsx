import { useEffect, useRef, useState } from 'preact/hooks'
import { Maximize2, Minimize2, SquareTerminal, X } from 'lucide-preact'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const scrollbackLines = 10_000
/** Keystrokes are batched the way the local terminal batches them. */
const inputFlushMs = 8

/**
 * A shell on the other Shun, drawn here.
 *
 * The pty lives on the peer and its output arrives as pushes: no sequence, no
 * replay — a terminal is a live surface, and the peer coalesces output so a
 * busy command costs the link a frame every few tens of milliseconds instead of
 * one per write. Input travels the same way back, batched per keystroke burst,
 * and the session is closed with the panel: a shell nobody watches is a shell
 * that should not be running.
 */
export function RemoteTerminalPanel({ desktopId, taskId, workspace, desktopName, language, close }: {
  desktopId: string
  taskId: string
  workspace: string
  desktopName: string
  language: 'zh' | 'en'
  close: () => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const liveTerminal = useRef('')
  const [maximized, setMaximized] = useState(false)
  const [height, setHeight] = useState(() => Math.min(460, Math.max(220, Math.round(innerHeight * .34))))
  const zh = language === 'zh'

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

    const request = (kind: string, payload: Record<string, unknown>) => window.shun.requestRemoteDesktop(desktopId, kind, payload)
    const start = async () => {
      // A panel is laid out on the frame after it mounts, and a shell opened
      // before that gets a size nobody can use — which reads as an empty
      // terminal rather than as a failure.
      for (let attempt = 0; attempt < 5 && (!instance.rows || !instance.cols); attempt += 1) {
        await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))
        try { fitter.fit() } catch {}
      }
      fitter.fit()
      try {
        const result = await request('terminal.open', { taskId, cols: instance.cols, rows: instance.rows }) as { terminalId?: string }
        liveTerminal.current = String(result?.terminalId || '')
        instance.focus()
      } catch (error) {
        instance.writeln(`\r\n\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`)
      }
    }

    let input = '', inputTimer = 0, output = '', outputFrame = 0
    const flushInput = () => {
      inputTimer = 0
      const data = input
      input = ''
      if (data && liveTerminal.current) void request('terminal.write', { terminalId: liveTerminal.current, data }).catch(() => {})
    }
    const dataDisposable = instance.onData(data => {
      input += data
      if (!inputTimer) inputTimer = window.setTimeout(flushInput, inputFlushMs)
    })
    const unsubscribe = window.shun.onRemoteDesktopTerminal((frame) => {
      if (frame.desktopId !== desktopId || frame.taskId !== taskId) return
      if (liveTerminal.current && frame.terminalId !== liveTerminal.current) return
      if (frame.type === 'terminal.data') {
        output += frame.data
        if (!outputFrame) outputFrame = requestAnimationFrame(() => {
          outputFrame = 0
          const data = output
          output = ''
          instance.write(data)
        })
        return
      }
      liveTerminal.current = ''
      instance.writeln(`\r\n\x1b[90m[${zh ? '进程已退出' : 'Process exited'} ${frame.exitCode}]\x1b[0m`)
    })
    // The peer ends a terminal when the link that owns it goes away: a shell
    // nobody can watch is a shell nobody should be running. Saying so beats a
    // terminal that silently stops answering keystrokes.
    const unsubscribeConnection = window.shun.onRemoteDesktopConnection((state) => {
      if (state.id !== desktopId) return
      if (!state.connected) {
        if (!liveTerminal.current) return
        liveTerminal.current = ''
        instance.writeln(`\r\n\x1b[90m[${zh ? '链路断开，远端终端已结束' : 'Link lost — the remote terminal ended'}]\x1b[0m`)
        return
      }
      if (!state.resumed || liveTerminal.current) return
      instance.writeln(`\r\n\x1b[90m[${zh ? '链路已恢复，已开启新终端' : 'Link restored — started a new terminal'}]\x1b[0m`)
      void start()
    })
    let resizeFrame = 0
    const resize = new ResizeObserver(() => {
      if (resizeFrame) return
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0
        try { fitter.fit() } catch { return }
        if (liveTerminal.current) void request('terminal.resize', { terminalId: liveTerminal.current, cols: instance.cols, rows: instance.rows }).catch(() => {})
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
      unsubscribeConnection()
      dataDisposable.dispose()
      instance.dispose()
      const session = liveTerminal.current
      liveTerminal.current = ''
      terminal.current = null
      fit.current = null
      if (session) void request('terminal.close', { terminalId: session }).catch(() => {})
    }
  }, [desktopId, taskId])

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

  return <section class={`terminal-panel${maximized ? ' is-maximized' : ''}`} style={maximized ? undefined : { height: `${height}px` }} aria-label="Remote terminal">
    <button class="terminal-panel-resizer" aria-label={zh ? '调整终端高度' : 'Resize terminal'} onPointerDown={beginResize} />
    <header>
      <span class="terminal-panel-title">
        <SquareTerminal />
        <b>{zh ? '远端终端' : 'Remote terminal'}</b>
        <small title={workspace}>{desktopName} · {workspace}</small>
      </span>
      <span class="terminal-panel-actions">
        <button title={maximized ? (zh ? '恢复下半屏' : 'Restore half screen') : (zh ? '占据对话流' : 'Fill conversation')} aria-label={maximized ? (zh ? '恢复下半屏' : 'Restore half screen') : (zh ? '占据对话流' : 'Fill conversation')} onClick={() => setMaximized(value => !value)}>{maximized ? <Minimize2 /> : <Maximize2 />}</button>
        <button title={zh ? '关闭并终止远端终端' : 'Close and stop the remote terminal'} aria-label={zh ? '关闭并终止远端终端' : 'Close and stop the remote terminal'} onClick={close}><X /></button>
      </span>
    </header>
    <div ref={container} class="terminal-canvas" onPointerDown={() => terminal.current?.focus()} />
  </section>
}
