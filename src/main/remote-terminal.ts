import { randomUUID } from 'node:crypto'
import type { TerminalSessionEvent } from '../shared.ts'
import type { TerminalSessionManager } from './terminal-sessions.ts'

/**
 * A terminal on the other Shun, driven from here.
 *
 * Output arrives from a pty as fast as the program writes it, and the relay
 * takes frames — not streams. So output is coalesced: what accumulated during
 * one short window leaves as one frame, which keeps a busy build from spending
 * the link's frame budget and keeps typing responsive at the same time.
 *
 * Nothing is buffered forever. A controller that falls too far behind loses the
 * oldest output and is told so in the stream, because a runaway program must not
 * be able to grow this process's memory on its way to nowhere.
 */
export const TERMINAL_FRAME_LIMIT_BYTES = 192 * 1024
export const TERMINAL_FLUSH_MS = 40
export const TERMINAL_QUEUE_LIMIT_BYTES = 4 * 1024 * 1024
export const TERMINAL_TRUNCATION_NOTICE = '\r\n… [output dropped: the controller fell too far behind]\r\n'

/** One frame's worth of pending output, cut on a character boundary. */
export function takeTerminalFrame(pending: string, limitBytes = TERMINAL_FRAME_LIMIT_BYTES) {
  const bytes = Buffer.from(pending, 'utf8')
  if (bytes.length <= limitBytes) return { frame: pending, rest: '' }
  let frame = bytes.subarray(0, limitBytes).toString('utf8')
  let consumed = Buffer.byteLength(frame, 'utf8')
  // A multi-byte character cut in half decodes to U+FFFD. It belongs to the
  // next frame, not to this one.
  if (frame.endsWith('\uFFFD')) {
    frame = frame.slice(0, -1)
    consumed = Buffer.byteLength(frame, 'utf8')
  }
  return { frame, rest: bytes.subarray(consumed).toString('utf8') }
}

/** Append output, keeping only the newest `limitBytes` of it when it overflows. */
export function appendTerminalOutput(queue: string, chunk: string, limitBytes = TERMINAL_QUEUE_LIMIT_BYTES) {
  const next = queue + chunk
  const bytes = Buffer.from(next, 'utf8')
  if (bytes.length <= limitBytes) return { queue: next, dropped: false }
  const tail = bytes.subarray(bytes.length - limitBytes).toString('utf8')
  return { queue: tail.startsWith('\uFFFD') ? tail.slice(1) : tail, dropped: true }
}

export class TerminalOutputStream {
  readonly #send: (data: string) => void
  readonly #flushMs: number
  #queue = ''
  #notice = false
  #timer?: ReturnType<typeof setTimeout>
  #disposed = false

  constructor(send: (data: string) => void, options: { flushMs?: number } = {}) {
    this.#send = send
    this.#flushMs = options.flushMs ?? TERMINAL_FLUSH_MS
  }

  push(data: string) {
    if (!data || this.#disposed) return
    const { queue, dropped } = appendTerminalOutput(this.#queue, data)
    // Whether output was lost is state, not queue content: a notice parked at
    // the front of the queue is the first thing the next overflow drops.
    if (dropped) this.#notice = true
    this.#queue = queue
    this.#schedule()
  }

  /** Send what is pending now, e.g. right before reporting the session ended. */
  flush() {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    const { frame, rest } = takeTerminalFrame(this.#queue)
    this.#queue = rest
    const notice = this.#notice ? TERMINAL_TRUNCATION_NOTICE : ''
    this.#notice = false
    if (frame || notice) this.#send(notice + frame)
    if (this.#queue) this.#schedule()
  }

  dispose() {
    this.#disposed = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#queue = ''
    this.#notice = false
  }

  #schedule() {
    if (this.#timer || this.#disposed) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.flush()
    }, this.#flushMs)
  }
}

type RemoteTerminal = { terminalId: string; linkId: string; taskId: string; accessToken: string; stream: TerminalOutputStream }

export type RemoteTerminalPush = { type: 'terminal.data'; taskId: string; terminalId: string; data: string }
  | { type: 'terminal.exit'; taskId: string; terminalId: string; exitCode: number }

/**
 * Terminal sessions a controller opened, keyed by the id it knows them by.
 * Sessions live as long as the link that owns them: a terminal is something
 * somebody is watching, not a resource that outlives its watcher.
 */
export class RemoteTerminals {
  readonly #manager: TerminalSessionManager
  readonly #push: (linkId: string, event: RemoteTerminalPush) => void
  readonly #terminals = new Map<string, RemoteTerminal>()

  constructor(manager: TerminalSessionManager, push: (linkId: string, event: RemoteTerminalPush) => void) {
    this.#manager = manager
    this.#push = push
  }

  open(input: { linkId: string; taskId: string; workspace: string; cols?: unknown; rows?: unknown }) {
    const terminalId = randomUUID()
    const accessToken = `remote:${input.linkId}:${terminalId}`
    const stream = new TerminalOutputStream(data => {
      this.#push(input.linkId, { type: 'terminal.data', taskId: input.taskId, terminalId, data })
    })
    this.#manager.open({
      accessToken,
      taskId: input.taskId,
      workspace: input.workspace,
      cols: input.cols,
      rows: input.rows,
      emit: event => this.#emit(terminalId, event),
    })
    this.#terminals.set(terminalId, { terminalId, linkId: input.linkId, taskId: input.taskId, accessToken, stream })
    return { terminalId }
  }

  write(terminalId: string, data: unknown) {
    this.#manager.write(this.#required(terminalId).accessToken, data)
    return { accepted: true }
  }

  resize(terminalId: string, cols: unknown, rows: unknown) {
    this.#manager.resize(this.#required(terminalId).accessToken, cols, rows)
    return { accepted: true }
  }

  close(terminalId: string) {
    const session = this.#terminals.get(terminalId)
    if (!session) return { closed: false }
    this.#close(session)
    return { closed: true }
  }

  /** Every terminal a link opened, closed when that link goes away. */
  closeLink(linkId: string) {
    for (const session of [...this.#terminals.values()]) if (session.linkId === linkId) this.#close(session)
  }

  dispose() {
    for (const session of [...this.#terminals.values()]) this.#close(session)
  }

  #emit(terminalId: string, event: TerminalSessionEvent) {
    const session = this.#terminals.get(terminalId)
    if (!session) return
    if (event.type === 'data') return session.stream.push(event.data)
    session.stream.flush()
    this.#terminals.delete(terminalId)
    session.stream.dispose()
    this.#push(session.linkId, { type: 'terminal.exit', taskId: session.taskId, terminalId, exitCode: event.exitCode })
  }

  #close(session: RemoteTerminal) {
    this.#terminals.delete(session.terminalId)
    session.stream.dispose()
    this.#manager.closeAccess(session.accessToken)
  }

  #required(terminalId: string) {
    const session = this.#terminals.get(String(terminalId || ''))
    if (!session) throw Error('This terminal is no longer running.')
    return session
  }
}
