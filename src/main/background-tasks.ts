import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BackgroundEvent, BackgroundOutputChunk, BackgroundTask } from '../shared.ts'

type ManagedTask = {
  public: BackgroundTask
  child?: ChildProcess
  output: BackgroundOutputChunk[]
  stdoutPath?: string
  stderrPath?: string
  stdoutOffset: number
  stderrOffset: number
  killTimer?: NodeJS.Timeout
}

type PersistedBackgroundTasks = {
  version: 1
  tasks: Array<{
    public: BackgroundTask
    output: BackgroundOutputChunk[]
    stdoutPath?: string
    stderrPath?: string
    stdoutOffset?: number
    stderrOffset?: number
  }>
}

export type BackgroundStartRequest = {
  sessionId: string
  createdByRunId: string
  workspace: string
  cwd?: string
  command: string
  label?: string
  previewUrl?: string
}

export type BackgroundTaskManagerOptions = {
  perSession?: number
  global?: number
  outputBytes?: number
  storageFile?: string
  probeIntervalMs?: number
}

const activeStates = new Set<BackgroundTask['state']>(['starting', 'running', 'stopping'])

function localPreviewEndpoint(value: string) {
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]'].includes(hostname)) return ''
    if (hostname === '0.0.0.0' || hostname === '[::]') url.hostname = 'localhost'
    return url.href
  } catch {
    return ''
  }
}

function localPreviewEndpoints(text: string) {
  const found: string[] = []
  for (const match of text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s"'<>)]*)?/gi)) {
    const endpoint = localPreviewEndpoint(match[0])
    if (endpoint && !found.includes(endpoint)) found.push(endpoint)
  }
  return found
}

export class BackgroundTaskManager {
  readonly #tasks = new Map<string, ManagedTask>()
  readonly #emit: (event: BackgroundEvent) => void
  readonly #maxPerSession: number
  readonly #maxGlobal: number
  readonly #maxOutputBytes: number
  readonly #storageFile?: string
  readonly #probeIntervalMs: number
  #persistTimer?: NodeJS.Timeout
  #probeTimer?: NodeJS.Timeout

  constructor(emit: (event: BackgroundEvent) => void, limits: BackgroundTaskManagerOptions = {}) {
    this.#emit = emit
    this.#maxPerSession = limits.perSession ?? 4
    this.#maxGlobal = limits.global ?? 12
    this.#maxOutputBytes = limits.outputBytes ?? 256_000
    this.#storageFile = limits.storageFile
    this.#probeIntervalMs = Math.max(100, limits.probeIntervalMs ?? 250)
    this.#restore()
    if (this.#storageFile) {
      this.#probeTimer = setInterval(() => {
        this.#pollLogs()
        this.#reconcileRecovered()
      }, this.#probeIntervalMs)
      this.#probeTimer.unref()
    }
  }

  async start(request: BackgroundStartRequest): Promise<BackgroundTask> {
    const command = request.command.trim()
    if (!request.sessionId || !request.createdByRunId) throw Error('A background task must belong to a Shun task and agent run.')
    if (!command) throw Error('Background command cannot be empty.')
    const previewUrl = request.previewUrl?.trim() ? localPreviewEndpoint(request.previewUrl.trim()) : ''
    if (request.previewUrl?.trim() && !previewUrl) throw Error('Background preview URL must be a localhost HTTP(S) address.')
    const active = [...this.#tasks.values()].filter(task => activeStates.has(task.public.state))
    if (active.length >= this.#maxGlobal) throw Error(`Background task limit reached (${this.#maxGlobal} globally).`)
    if (active.filter(task => task.public.sessionId === request.sessionId).length >= this.#maxPerSession) {
      throw Error(`Background task limit reached (${this.#maxPerSession} for this task).`)
    }

    const id = crypto.randomUUID()
    const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/zsh'
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command]
    const logDir = this.#storageFile ? join(dirname(this.#storageFile), 'background-logs') : ''
    let stdoutPath: string | undefined,
      stderrPath: string | undefined,
      stdoutFd: number | undefined,
      stderrFd: number | undefined
    if (logDir) {
      mkdirSync(logDir, { recursive: true })
      stdoutPath = join(logDir, `${id}.stdout.log`)
      stderrPath = join(logDir, `${id}.stderr.log`)
      stdoutFd = openSync(stdoutPath, 'a')
      stderrFd = openSync(stderrPath, 'a')
    }
    const child = spawn(shell, args, {
      cwd: request.cwd || request.workspace || process.cwd(),
      detached: true,
      env: process.env,
      stdio: stdoutFd === undefined || stderrFd === undefined
        ? ['ignore', 'pipe', 'pipe']
        : ['ignore', stdoutFd, stderrFd],
    })
    if (stdoutFd !== undefined) closeSync(stdoutFd)
    if (stderrFd !== undefined) closeSync(stderrFd)
    const task: ManagedTask = {
      child,
      output: [],
      stdoutPath,
      stderrPath,
      stdoutOffset: 0,
      stderrOffset: 0,
      public: {
        id,
        sessionId: request.sessionId,
        createdByRunId: request.createdByRunId,
        workspace: request.workspace,
        command,
        label: request.label?.trim() || command.slice(0, 72),
        state: 'starting',
        createdAt: Date.now(),
        outputSeq: 0,
        outputBytes: 0,
        endpoints: previewUrl ? [previewUrl] : [],
      },
    }
    this.#tasks.set(id, task)
    this.#state(task)
    child.stdout?.on('data', data => this.#append(task, 'stdout', String(data)))
    child.stderr?.on('data', data => this.#append(task, 'stderr', String(data)))
    child.on('spawn', () => {
      task.public = { ...task.public, state: 'running', pid: child.pid, processGroupId: child.pid, startedAt: Date.now() }
      this.#state(task)
    })
    child.on('error', error => {
      task.public = { ...task.public, state: 'failed', error: error.message, finishedAt: Date.now() }
      this.#state(task)
    })
    child.on('exit', (code, signal) => {
      this.#readLogs(task)
      if (task.killTimer) clearTimeout(task.killTimer)
      const stopped = task.public.state === 'stopping'
      task.public = {
        ...task.public,
        state: stopped ? 'stopped' : code === 0 ? 'exited' : 'failed',
        finishedAt: Date.now(),
        ...(typeof code === 'number' ? { exitCode: code } : {}),
        ...(signal ? { signal } : {}),
      }
      this.#state(task)
    })
    // The process is a product resource, not an Electron lifetime child. Its
    // file-backed stdio and detached process group let it survive app restarts.
    child.unref()
    await new Promise<void>((resolve, reject) => {
      const ready = () => { cleanup(); resolve() }
      const failed = (error: Error) => { cleanup(); reject(error) }
      const cleanup = () => { child.off('spawn', ready); child.off('error', failed) }
      if (task.public.state === 'running') resolve()
      else { child.once('spawn', ready); child.once('error', failed) }
    })
    return this.#copy(task.public)
  }

  list(sessionId: string): BackgroundTask[] {
    this.#reconcileRecovered()
    return [...this.#tasks.values()]
      .filter(task => task.public.sessionId === sessionId)
      .sort((a, b) => b.public.createdAt - a.public.createdAt)
      .map(task => this.#copy(task.public))
  }

  listAll(): BackgroundTask[] {
    this.#reconcileRecovered()
    return [...this.#tasks.values()]
      .sort((a, b) => b.public.createdAt - a.public.createdAt)
      .map(task => this.#copy(task.public))
  }

  output(sessionId: string, taskId: string, afterSeq = 0): BackgroundOutputChunk[] {
    const task = this.#owned(sessionId, taskId)
    return task.output.filter(chunk => chunk.seq > afterSeq).map(chunk => ({ ...chunk }))
  }

  async stop(sessionId: string, taskId: string): Promise<BackgroundTask> {
    const task = this.#owned(sessionId, taskId)
    if (!activeStates.has(task.public.state)) return this.#copy(task.public)
    task.public = { ...task.public, state: 'stopping' }
    this.#state(task)
    this.#signalTree(task, 'SIGTERM')
    task.killTimer = setTimeout(() => {
      if (activeStates.has(task.public.state)) this.#signalTree(task, 'SIGKILL')
    }, 2_000)
    task.killTimer.unref()
    return this.#copy(task.public)
  }

  discardSession(sessionId: string) {
    const owned = [...this.#tasks.values()].filter(task => task.public.sessionId === sessionId)
    if (owned.some(task => activeStates.has(task.public.state))) throw Error('Stop managed background processes before deleting this task.')
    for (const task of owned) {
      if (task.killTimer) clearTimeout(task.killTimer)
      for (const path of [task.stdoutPath, task.stderrPath]) if (path) rmSync(path, { force: true })
      this.#tasks.delete(task.public.id)
    }
    if (owned.length) this.#persistNow()
    return owned.length
  }

  stopAll() {
    if (this.#probeTimer) clearInterval(this.#probeTimer)
    for (const task of this.#tasks.values()) if (activeStates.has(task.public.state)) {
      task.public = { ...task.public, state: 'stopping' }
      this.#signalTree(task, 'SIGKILL')
    }
    this.#persistNow()
  }

  preserveForAppExit() {
    if (this.#probeTimer) clearInterval(this.#probeTimer)
    this.#pollLogs()
    this.#persistNow()
    for (const task of this.#tasks.values()) task.child?.unref()
  }

  #owned(sessionId: string, taskId: string) {
    const task = this.#tasks.get(taskId)
    if (!task || task.public.sessionId !== sessionId) throw Error('Background task not found for this Shun task.')
    return task
  }

  #append(task: ManagedTask, stream: BackgroundOutputChunk['stream'], text: string) {
    const chunk: BackgroundOutputChunk = { seq: task.public.outputSeq + 1, stream, text, at: Date.now() }
    task.output.push(chunk)
    let bytes = task.public.outputBytes + Buffer.byteLength(text)
    while (task.output.length > 1 && bytes > this.#maxOutputBytes) bytes -= Buffer.byteLength(task.output.shift()!.text)
    const endpoints = new Set(task.public.endpoints)
    for (const endpoint of localPreviewEndpoints(text)) endpoints.add(endpoint)
    task.public = { ...task.public, outputSeq: chunk.seq, outputBytes: bytes, endpoints: [...endpoints].slice(-8) }
    this.#emit({ type: 'output', task: this.#copy(task.public), chunk: { ...chunk } })
    this.#schedulePersist()
  }

  #signalTree(task: ManagedTask, signal: NodeJS.Signals) {
    const pid = task.public.processGroupId || task.public.pid
    if (!pid) return
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { detached: false, stdio: 'ignore', windowsHide: true })
        killer.unref()
      }
      else process.kill(-pid, signal)
    } catch (error: any) {
      if (error?.code !== 'ESRCH') {
        task.public = { ...task.public, error: error?.message || String(error) }
        this.#state(task)
      }
    }
  }

  #state(task: ManagedTask) {
    this.#emit({ type: 'state', task: this.#copy(task.public) })
    this.#persistNow()
  }

  #restore() {
    if (!this.#storageFile) return
    try {
      const saved = JSON.parse(readFileSync(this.#storageFile, 'utf8')) as PersistedBackgroundTasks
      if (saved?.version !== 1 || !Array.isArray(saved.tasks)) return
      for (const item of saved.tasks) {
        const record = item?.public
        if (!record || typeof record.id !== 'string' || typeof record.sessionId !== 'string') continue
        const task: ManagedTask = {
          public: {
            ...record,
            endpoints: Array.isArray(record.endpoints) ? [...record.endpoints] : [],
          },
          output: Array.isArray(item.output)
            ? item.output.filter(chunk => chunk && typeof chunk.seq === 'number' && typeof chunk.text === 'string')
            : [],
          stdoutPath: typeof item.stdoutPath === 'string' ? item.stdoutPath : undefined,
          stderrPath: typeof item.stderrPath === 'string' ? item.stderrPath : undefined,
          stdoutOffset: Math.max(0, Number(item.stdoutOffset) || 0),
          stderrOffset: Math.max(0, Number(item.stderrOffset) || 0),
        }
        this.#tasks.set(record.id, task)
        this.#readLogs(task)
        this.#reconcile(task)
      }
      this.#persistNow()
    } catch (error: any) {
      if (error?.code !== 'ENOENT') console.error('[background:restore]', error)
    }
  }

  #reconcileRecovered() {
    for (const task of this.#tasks.values()) if (!task.child) this.#reconcile(task)
  }

  #pollLogs() {
    for (const task of this.#tasks.values()) this.#readLogs(task)
  }

  #readLogs(task: ManagedTask) {
    this.#readLog(task, 'stdout')
    this.#readLog(task, 'stderr')
  }

  #readLog(task: ManagedTask, stream: 'stdout' | 'stderr') {
    const path = stream === 'stdout' ? task.stdoutPath : task.stderrPath
    if (!path) return
    const offsetKey = stream === 'stdout' ? 'stdoutOffset' : 'stderrOffset'
    let descriptor: number | undefined
    try {
      const size = statSync(path).size
      if (size < task[offsetKey]) task[offsetKey] = 0
      if (size > task[offsetKey]) {
        descriptor = openSync(path, 'r')
        while (task[offsetKey] < size) {
          const length = Math.min(64_000, size - task[offsetKey])
          const buffer = Buffer.allocUnsafe(length)
          const read = readSync(descriptor, buffer, 0, length, task[offsetKey])
          if (!read) break
          task[offsetKey] += read
          this.#append(task, stream, buffer.subarray(0, read).toString())
        }
      }
      this.#compactLog(task, stream, size)
    } catch (error: any) {
      if (error?.code !== 'ENOENT') console.error('[background:log]', error)
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }

  #compactLog(task: ManagedTask, stream: 'stdout' | 'stderr', size: number) {
    const path = stream === 'stdout' ? task.stdoutPath : task.stderrPath
    if (!path || size <= this.#maxOutputBytes * 2) return
    const keep = Math.max(1, this.#maxOutputBytes)
    let descriptor: number | undefined
    try {
      descriptor = openSync(path, 'r')
      const length = Math.min(keep, size)
      const buffer = Buffer.allocUnsafe(length)
      const read = readSync(descriptor, buffer, 0, length, size - length)
      writeFileSync(path, buffer.subarray(0, read), { mode: 0o600 })
      if (stream === 'stdout') task.stdoutOffset = read
      else task.stderrOffset = read
      this.#schedulePersist()
    } catch (error: any) {
      if (error?.code !== 'ENOENT') console.error('[background:compact-log]', error)
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }

  #reconcile(task: ManagedTask) {
    if (!activeStates.has(task.public.state)) return
    if (this.#isAlive(task)) {
      if (task.public.state === 'starting') {
        task.public = { ...task.public, state: 'running', startedAt: task.public.startedAt || Date.now() }
        this.#state(task)
      } else if (task.public.state === 'stopping') this.#signalTree(task, 'SIGKILL')
      return
    }
    task.public = {
      ...task.public,
      state: task.public.state === 'stopping' ? 'stopped' : 'exited',
      finishedAt: task.public.finishedAt || Date.now(),
    }
    this.#state(task)
  }

  #isAlive(task: ManagedTask) {
    const pid = task.public.processGroupId || task.public.pid
    if (!pid) return false
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 0)
      return true
    } catch (error: any) {
      return error?.code === 'EPERM'
    }
  }

  #schedulePersist() {
    if (!this.#storageFile || this.#persistTimer) return
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = undefined
      this.#persistNow()
    }, 50)
    this.#persistTimer.unref()
  }

  #persistNow() {
    if (!this.#storageFile) return
    if (this.#persistTimer) {
      clearTimeout(this.#persistTimer)
      this.#persistTimer = undefined
    }
    const saved: PersistedBackgroundTasks = {
      version: 1,
      tasks: [...this.#tasks.values()].map(task => ({
        public: this.#copy(task.public),
        output: task.output.map(chunk => ({ ...chunk })),
        stdoutPath: task.stdoutPath,
        stderrPath: task.stderrPath,
        stdoutOffset: task.stdoutOffset,
        stderrOffset: task.stderrOffset,
      })),
    }
    const temp = `${this.#storageFile}.tmp`
    try {
      mkdirSync(dirname(this.#storageFile), { recursive: true })
      writeFileSync(temp, JSON.stringify(saved), { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, this.#storageFile)
    } catch (error) {
      console.error('[background:persist]', error)
    }
  }

  #copy(task: BackgroundTask): BackgroundTask {
    return { ...task, endpoints: [...task.endpoints] }
  }
}
