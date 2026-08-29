import process from 'node:process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import * as pty from 'node-pty'
import type { TerminalSessionEvent } from '../shared.ts'

type PtyProcess = Pick<pty.IPty, 'pid' | 'write' | 'resize' | 'kill' | 'onData' | 'onExit'>
type PtyFactory = (file: string, args: string[], options: pty.IPtyForkOptions) => PtyProcess
type Session = {
  id: string
  accessToken: string
  taskId: string
  workspace: string
  process: PtyProcess
  disposeData: () => void
  disposeExit: () => void
}

const maxWriteBytes = 64 * 1024
const maxOutputChunk = 64 * 1024

export class TerminalSessionManager {
  #sessions = new Map<string, Session>()
  private readonly spawnPty: PtyFactory

  constructor(spawnPty: PtyFactory = (file, args, options) => pty.spawn(file, args, options)) {
    this.spawnPty = spawnPty
  }

  open(input: {
    accessToken: string
    taskId: string
    workspace: string
    cols?: unknown
    rows?: unknown
    emit: (event: TerminalSessionEvent) => void
  }) {
    const existing = this.#sessions.get(input.accessToken)
    if (existing) return this.describe(existing)
    const cols = terminalDimension(input.cols, 80, 2, 500)
    const rows = terminalDimension(input.rows, 24, 1, 300)
    const shell = defaultShell()
    let child: PtyProcess
    try {
      child = this.spawnPty(shell.file, shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: input.workspace,
        env: terminalEnvironment(),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw Error(detail.includes('posix_spawnp') ? 'Terminal could not start its system shell.' : detail)
    }
    const session: Session = {
      id: randomUUID(),
      accessToken: input.accessToken,
      taskId: input.taskId,
      workspace: input.workspace,
      process: child,
      disposeData: () => {},
      disposeExit: () => {},
    }
    const data = child.onData(value => {
      for (let offset = 0; offset < value.length; offset += maxOutputChunk) {
        input.emit({ accessToken: session.accessToken, sessionId: session.id, type: 'data', data: value.slice(offset, offset + maxOutputChunk) })
      }
    })
    const exit = child.onExit(event => {
      if (this.#sessions.get(session.accessToken) !== session) return
      this.#sessions.delete(session.accessToken)
      data.dispose()
      exit.dispose()
      input.emit({ accessToken: session.accessToken, sessionId: session.id, type: 'exit', exitCode: event.exitCode, ...(event.signal === undefined ? {} : { signal: event.signal }) })
    })
    session.disposeData = () => data.dispose()
    session.disposeExit = () => exit.dispose()
    this.#sessions.set(input.accessToken, session)
    return this.describe(session)
  }

  write(accessToken: string, data: unknown) {
    const session = this.required(accessToken)
    const value = String(data ?? '')
    if (!value || Buffer.byteLength(value, 'utf8') > maxWriteBytes) throw Error('Terminal input must be between 1 byte and 64 KiB.')
    session.process.write(value)
    return true
  }

  resize(accessToken: string, cols: unknown, rows: unknown) {
    const session = this.required(accessToken)
    const width = terminalDimension(cols, 80, 2, 500)
    const height = terminalDimension(rows, 24, 1, 300)
    session.process.resize(width, height)
    return { cols: width, rows: height }
  }

  closeAccess(accessToken: string) {
    const session = this.#sessions.get(accessToken)
    if (!session) return false
    this.#sessions.delete(accessToken)
    session.disposeData()
    session.disposeExit()
    try { session.process.kill() } catch {}
    return true
  }

  closeTask(taskId: string) {
    let closed = 0
    for (const session of [...this.#sessions.values()]) if (session.taskId === taskId && this.closeAccess(session.accessToken)) closed++
    return closed
  }

  dispose() {
    for (const accessToken of [...this.#sessions.keys()]) this.closeAccess(accessToken)
  }

  private required(accessToken: string) {
    const session = this.#sessions.get(accessToken)
    if (!session) throw Error('Terminal session is not running.')
    return session
  }

  private describe(session: Session) {
    return { sessionId: session.id, pid: session.process.pid, workspace: session.workspace }
  }
}

function terminalDimension(value: unknown, fallback: number, minimum: number, maximum: number) {
  const number = Number(value)
  return Number.isInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback
}

function defaultShell() {
  if (process.platform === 'win32') return { file: process.env.ComSpec || 'cmd.exe', args: [] }
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter((value): value is string => Boolean(value))
  for (const file of [...new Set(candidates)]) try {
    accessSync(file, constants.X_OK)
    return { file, args: ['-l'] }
  } catch {}
  throw Error('No executable system shell is available.')
}

function terminalEnvironment(): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
}
