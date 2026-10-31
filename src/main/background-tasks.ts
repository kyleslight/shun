import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BackgroundEvent, BackgroundOutputChunk, BackgroundTask } from '../shared.ts'
import { resolveWindowsShell, type WindowsShell } from './windows-shell.ts'
import { commandEnvironment } from './shell-environment.ts'
import { localEndpointStatus } from './local-endpoint.ts'

type ManagedTask = {
  public: BackgroundTask
  child?: ChildProcess
  output: BackgroundOutputChunk[]
  stdoutPath?: string
  stderrPath?: string
  stdoutOffset: number
  stderrOffset: number
  killTimer?: NodeJS.Timeout
  waiters?: Set<() => void>
  endpointCandidates?: Set<string>
  endpointProbe?: Promise<void>
  endpointCheckedAt?: number
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
    endpointCandidates?: string[]
  }>
}

type PersistedBackgroundIndex = { version: 2; tasks: string[] }

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

/**
 * The interpreter that runs a managed background command. Windows uses the same
 * resolved shell as foreground commands so a long-running process does not need
 * a different syntax; every other platform keeps the login shell contract.
 */
export function backgroundShellCommand(
  platform: string,
  env: NodeJS.ProcessEnv,
  command: string,
  resolveShell: (environment: NodeJS.ProcessEnv) => WindowsShell = resolveWindowsShell,
) {
  if (platform !== 'win32') return { file: env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'), args: ['-lc', command] }
  const shell = resolveShell(env)
  return {
    file: shell.file,
    args: [...shell.commandArgs, shell.outputEncoding ? `${shell.outputEncoding} ${command}` : command],
  }
}

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
  readonly #monitored = new Set<ManagedTask>()
  readonly #dirtyTasks = new Set<ManagedTask>()
  readonly #persistedIds = new Set<string>()
  readonly #emit: (event: BackgroundEvent) => void
  readonly #maxPerSession: number
  readonly #maxGlobal: number
  readonly #maxOutputBytes: number
  readonly #storageFile?: string
  readonly #probeIntervalMs: number
  #persistTimer?: NodeJS.Timeout
  #probeTimer?: NodeJS.Timeout
  #monitoringStopped = false
  #restoring = false

  constructor(emit: (event: BackgroundEvent) => void, limits: BackgroundTaskManagerOptions = {}) {
    this.#emit = emit
    this.#maxPerSession = limits.perSession ?? 4
    this.#maxGlobal = limits.global ?? 12
    this.#maxOutputBytes = limits.outputBytes ?? 256_000
    this.#storageFile = limits.storageFile
    this.#probeIntervalMs = Math.max(100, limits.probeIntervalMs ?? 250)
    this.#restore()
  }

  #updateMonitoring(task: ManagedTask) {
    if (activeStates.has(task.public.state)) this.#monitored.add(task)
    else this.#monitored.delete(task)
    if (!this.#monitored.size || this.#monitoringStopped) {
      if (this.#probeTimer) clearInterval(this.#probeTimer)
      this.#probeTimer = undefined
    } else if (!this.#probeTimer) {
      this.#probeTimer = setInterval(() => {
        for (const task of this.#monitored) {
          this.#readLogs(task)
          if (!task.child) this.#reconcile(task)
          if (Date.now() - (task.endpointCheckedAt || 0) >= 1_000) void this.#refreshEndpoints(task)
        }
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
    if (previewUrl && (await localEndpointStatus(previewUrl)).listening) {
      throw Error(`Preview port ${new URL(previewUrl).port || 80} is already occupied. Choose an unused port; the existing server belongs to another process.`)
    }
    const active = [...this.#tasks.values()].filter(task => activeStates.has(task.public.state))
    if (active.length >= this.#maxGlobal) throw Error(`Background task limit reached (${this.#maxGlobal} globally).`)
    if (active.filter(task => task.public.sessionId === request.sessionId).length >= this.#maxPerSession) {
      throw Error(`Background task limit reached (${this.#maxPerSession} for this task).`)
    }

    const id = crypto.randomUUID()
    const shell = backgroundShellCommand(process.platform, process.env, command)
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
    const child = spawn(shell.file, shell.args, {
      cwd: request.cwd || request.workspace || process.cwd(),
      detached: true,
      env: commandEnvironment(process.env),
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
      endpointCandidates: new Set(previewUrl ? [previewUrl] : []),
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
        endpoints: [],
        ...(previewUrl ? { previewUrl } : {}),
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
        endpoints: [],
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
    // A shell spawning is not evidence that its server bound the requested port.
    // Briefly observe startup; slower servers become available through events.
    if (previewUrl) {
      const deadline = Date.now() + 1_500
      do {
        await this.#refreshEndpoints(task)
        if (task.public.endpoints.length || !activeStates.has(task.public.state)) break
        await this.#waitForChange(task, 50)
      } while (Date.now() < deadline)
    }
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

  async ownsEndpoint(sessionId: string, url: string) {
    if (!localPreviewEndpoint(url)) return false
    const target = new URL(url)
    const origin = `${target.protocol}:${target.port || (target.protocol === 'https:' ? 443 : 80)}`
    for (const task of this.#tasks.values()) {
      if (task.public.sessionId !== sessionId || task.public.state !== 'running' || !task.public.processGroupId) continue
      if (![...(task.endpointCandidates || [])].some(value => {
        const candidate = new URL(value)
        return `${candidate.protocol}:${candidate.port || (candidate.protocol === 'https:' ? 443 : 80)}` === origin
      })) continue
      if ((await localEndpointStatus(url, task.public.processGroupId)).owned) return true
    }
    return false
  }

  output(sessionId: string, taskId: string, afterSeq = 0): BackgroundOutputChunk[] {
    const task = this.#owned(sessionId, taskId)
    return task.output.filter(chunk => chunk.seq > afterSeq).map(chunk => ({ ...chunk }))
  }

  // Bounded long-poll so a model can wait for a verification URL, a ready line,
  // or an error instead of sleeping between snapshot reads. Output arrival and
  // state transitions both wake the waiter; every wait self-expires.
  async waitForOutput(sessionId: string, taskId: string, options: { afterSeq?: number; waitMs?: number; until?: string } = {}): Promise<BackgroundOutputChunk[]> {
    const afterSeq = options.afterSeq ?? 0
    const until = String(options.until || '').trim()
    const deadline = Date.now() + Math.max(0, Math.min(30_000, Math.floor(options.waitMs || 0)))
    for (;;) {
      const task = this.#owned(sessionId, taskId)
      const chunks = task.output.filter(chunk => chunk.seq > afterSeq).map(chunk => ({ ...chunk }))
      const matched = until ? chunks.some(chunk => chunk.text.includes(until)) : chunks.length > 0
      if (matched || !activeStates.has(task.public.state) || Date.now() >= deadline) return chunks
      await this.#waitForChange(task, Math.min(deadline - Date.now(), 1_000))
    }
  }

  async observe(sessionId: string, taskId: string, options: { afterSeq?: number; waitMs?: number; until?: string; maxChars?: number } = {}) {
    const snapshot = await this.waitForOutput(sessionId, taskId, options)
    const task = this.#owned(sessionId, taskId)
    const { id, state, exitCode, startedAt, finishedAt, lastOutputAt, endpoints, previewUrl } = task.public
    let remaining = Math.max(1_024, Math.min(64_000, Math.floor(options.maxChars || 12_000)))
    const output: BackgroundOutputChunk[] = []
    let omitted = 0
    for (const chunk of [...snapshot].reverse()) {
      const text = remaining > 0 ? chunk.text.slice(-remaining) : ''
      omitted += chunk.text.length - text.length
      if (text) output.unshift({ ...chunk, text })
      remaining -= text.length
    }
    return {
      task: { id, state, exitCode: exitCode ?? null, startedAt, finishedAt: finishedAt ?? null, lastOutputAt: lastOutputAt ?? null, elapsed_ms: Math.max(0, (finishedAt ?? Date.now()) - (startedAt ?? task.public.createdAt)), endpoints, previewUrl },
      output,
      next_seq: snapshot.at(-1)?.seq ?? options.afterSeq ?? 0,
      ...(options.until ? { matched: snapshot.some(chunk => chunk.text.includes(options.until!)) } : {}),
      ...(omitted ? { truncated: true, omitted_characters: omitted, log_files: { stdout: task.stdoutPath, stderr: task.stderrPath } } : {}),
    }
  }

  async waitForExit(sessionId: string, taskId: string, signal?: AbortSignal, update?: (value: Awaited<ReturnType<BackgroundTaskManager['observe']>>) => void) {
    for (;;) {
      if (signal?.aborted) {
        await this.stopAndWait(sessionId, taskId)
        throw signal.reason ?? Error('Process wait cancelled.')
      }
      const value = await this.observe(sessionId, taskId)
      update?.(value)
      if (!activeStates.has(value.task.state)) return this.observe(sessionId, taskId)
      // Polling here is resource supervision, not an additional model run.
      await this.#waitForChange(this.#owned(sessionId, taskId), 1_000)
    }
  }

  async stop(sessionId: string, taskId: string): Promise<BackgroundTask> {
    const task = this.#owned(sessionId, taskId)
    if (!activeStates.has(task.public.state)) return this.#copy(task.public)
    task.public = { ...task.public, state: 'stopping', endpoints: [] }
    this.#state(task)
    this.#signalTree(task, 'SIGTERM')
    task.killTimer = setTimeout(() => {
      if (activeStates.has(task.public.state)) this.#signalTree(task, 'SIGKILL')
    }, 2_000)
    task.killTimer.unref()
    return this.#copy(task.public)
  }

  async stopAndWait(sessionId: string, taskId: string): Promise<BackgroundTask> {
    await this.stop(sessionId, taskId)
    const task = this.#owned(sessionId, taskId), deadline = Date.now() + 10_000
    while (activeStates.has(task.public.state)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw Error('Background process did not stop in time.')
      await this.#waitForChange(task, remaining)
    }
    return this.#copy(task.public)
  }

  discardSession(sessionId: string) {
    const owned = [...this.#tasks.values()].filter(task => task.public.sessionId === sessionId)
    if (owned.some(task => activeStates.has(task.public.state))) throw Error('Stop managed background processes before deleting this task.')
    for (const task of owned) {
      if (task.killTimer) clearTimeout(task.killTimer)
      for (const path of [task.stdoutPath, task.stderrPath]) if (path) rmSync(path, { force: true })
      this.#tasks.delete(task.public.id)
      this.#dirtyTasks.delete(task)
    }
    if (owned.length) this.#persistNow()
    return owned.length
  }

  stopAll() {
    this.#monitoringStopped = true
    if (this.#probeTimer) clearInterval(this.#probeTimer)
    for (const task of this.#tasks.values()) if (activeStates.has(task.public.state)) {
      task.public = { ...task.public, state: 'stopping' }
      this.#dirtyTasks.add(task)
      this.#signalTree(task, 'SIGKILL')
    }
    this.#persistNow()
  }

  preserveForAppExit() {
    this.#monitoringStopped = true
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
    for (const endpoint of localPreviewEndpoints(text)) {
      const candidates = (task.endpointCandidates ??= new Set())
      candidates.add(endpoint)
      if (candidates.size > 8) candidates.delete(candidates.values().next().value!)
    }
    task.public = { ...task.public, outputSeq: chunk.seq, outputBytes: bytes, lastOutputAt: chunk.at }
    void this.#refreshEndpoints(task)
    this.#emit({ type: 'output', task: this.#copy(task.public), chunk: { ...chunk } })
    this.#schedulePersist(task)
    this.#wakeWaiters(task)
  }

  #wakeWaiters(task: ManagedTask) {
    if (!task.waiters?.size) return
    const waiters = [...task.waiters]
    task.waiters.clear()
    for (const waiter of waiters) waiter()
  }

  async #refreshEndpoints(task: ManagedTask) {
    if (task.endpointProbe) return task.endpointProbe
    if (task.public.state !== 'running' || !task.public.processGroupId || !task.endpointCandidates?.size) return
    if (task.public.endpoints.length && Date.now() - (task.endpointCheckedAt || 0) < 1_000) return
    task.endpointCheckedAt = Date.now()
    task.endpointProbe = (async () => {
      const endpoints = (await Promise.all([...task.endpointCandidates!].map(async url => {
        try { return (await localEndpointStatus(url, task.public.processGroupId)).owned ? url : '' }
        catch { return '' } // Unverifiable endpoints are never advertised as this task's page.
      }))).filter(Boolean)
      if (task.public.state !== 'running') return
      if (JSON.stringify(endpoints) !== JSON.stringify(task.public.endpoints)) {
        task.public = { ...task.public, endpoints }
        this.#state(task)
      }
    })().finally(() => { task.endpointProbe = undefined })
    return task.endpointProbe
  }

  #waitForChange(task: ManagedTask, ms: number) {
    return new Promise<void>(resolve => {
      let settled = false
      const wake = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        task.waiters?.delete(wake)
        resolve()
      }
      // A pending wait is real work: background children are unref'd, so an
      // unref'd interval here would let the event loop drain out from under a
      // caller that is still awaiting this promise.
      const timer = setTimeout(wake, Math.max(1, ms))
      ;(task.waiters ??= new Set()).add(wake)
    })
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
    this.#updateMonitoring(task)
    this.#emit({ type: 'state', task: this.#copy(task.public) })
    this.#dirtyTasks.add(task)
    this.#persistNow()
    this.#wakeWaiters(task)
  }

  #restore() {
    if (!this.#storageFile) return
    this.#restoring = true
    try {
      const saved = JSON.parse(readFileSync(this.#storageFile, 'utf8')) as PersistedBackgroundTasks | PersistedBackgroundIndex
      if (!Array.isArray(saved?.tasks) || (saved.version !== 1 && saved.version !== 2)) return
      const items: PersistedBackgroundTasks['tasks'] = saved.version === 1 ? saved.tasks : saved.tasks.map(id => {
        const record = JSON.parse(readFileSync(this.#recordPath(id), 'utf8'))
        if (record?.public?.id !== id) throw Error('Background process record does not match its index.')
        return record
      })
      if (saved.version === 2) for (const id of saved.tasks) this.#persistedIds.add(id)
      for (const item of items) {
        const record = item?.public
        if (!record || typeof record.id !== 'string' || typeof record.sessionId !== 'string') continue
        const task: ManagedTask = {
          public: {
            ...record,
            endpoints: [],
          },
          output: Array.isArray(item.output)
            ? item.output.filter(chunk => chunk && typeof chunk.seq === 'number' && typeof chunk.text === 'string')
            : [],
          stdoutPath: typeof item.stdoutPath === 'string' ? item.stdoutPath : undefined,
          stderrPath: typeof item.stderrPath === 'string' ? item.stderrPath : undefined,
          stdoutOffset: Math.max(0, Number(item.stdoutOffset) || 0),
          stderrOffset: Math.max(0, Number(item.stderrOffset) || 0),
          endpointCandidates: new Set([...(item.endpointCandidates || record.endpoints || []), ...(record.previewUrl ? [record.previewUrl] : [])].map(localPreviewEndpoint).filter(Boolean).slice(-8)),
        }
        this.#tasks.set(record.id, task)
        if (saved.version === 1) this.#dirtyTasks.add(task)
        if (activeStates.has(task.public.state)) this.#readLogs(task)
        this.#reconcile(task)
        this.#updateMonitoring(task)
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') console.error('[background:restore]', error)
      return
    } finally {
      this.#restoring = false
    }
    this.#persistNow()
  }

  #reconcileRecovered() {
    for (const task of this.#monitored) if (!task.child) this.#reconcile(task)
  }

  #pollLogs() {
    for (const task of this.#monitored) this.#readLogs(task)
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
      this.#schedulePersist(task)
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
    this.#readLogs(task)
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

  #schedulePersist(task: ManagedTask) {
    if (!this.#storageFile) return
    this.#dirtyTasks.add(task)
    if (this.#persistTimer || this.#restoring) return
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = undefined
      this.#persistNow()
    }, 50)
    this.#persistTimer.unref()
  }

  #persistNow() {
    if (!this.#storageFile || this.#restoring) return
    if (this.#persistTimer) {
      clearTimeout(this.#persistTimer)
      this.#persistTimer = undefined
    }
    const ids = [...this.#tasks.keys()]
    const indexChanged = ids.length !== this.#persistedIds.size || ids.some(id => !this.#persistedIds.has(id))
    if (!this.#dirtyTasks.size && !indexChanged) return
    try {
      mkdirSync(`${this.#storageFile}.d`, { recursive: true })
      // Output changes only its owning process's record. Historical output is
      // never copied, serialized or rewritten by a running process's log tick.
      for (const task of this.#dirtyTasks) this.#writeRecord(this.#recordPath(task.public.id), {
        public: task.public,
        output: task.output,
        stdoutPath: task.stdoutPath,
        stderrPath: task.stderrPath,
        stdoutOffset: task.stdoutOffset,
        stderrOffset: task.stderrOffset,
        endpointCandidates: [...(task.endpointCandidates || [])],
      })
      if (indexChanged) {
        this.#writeRecord(this.#storageFile, { version: 2, tasks: ids } satisfies PersistedBackgroundIndex)
        for (const id of this.#persistedIds) if (!this.#tasks.has(id)) rmSync(this.#recordPath(id), { force: true })
        this.#persistedIds.clear()
        for (const id of ids) this.#persistedIds.add(id)
      }
      this.#dirtyTasks.clear()
    } catch (error) {
      console.error('[background:persist]', error)
    }
  }

  #recordPath(id: string) {
    return join(`${this.#storageFile}.d`, `${createHash('sha256').update(id).digest('hex')}.json`)
  }

  #writeRecord(path: string, record: unknown) {
    const temp = `${path}.tmp`
    writeFileSync(temp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
  }

  #copy(task: BackgroundTask): BackgroundTask {
    return { ...task, endpoints: [...task.endpoints] }
  }
}
