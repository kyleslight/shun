import { spawn, type ChildProcess } from 'node:child_process'

const maximumInputBytes = 1024 * 1024
const maximumOutputBytes = 32 * 1024 * 1024
const maximumDiagnosticBytes = 64 * 1024
const activeWorkers = new Map<string, ChildProcess>()

export type PluginWorkerRequest = {
  entry: string
  workspace: string
  input: unknown
  timeoutMs: number
  runtime?: Record<string, string>
  cacheDirectory?: string
  slotKey?: string
}

export type PluginWorkerResult = {
  value: unknown
  durationMs: number
  diagnostics?: string
}

export async function runPluginWorker(request: PluginWorkerRequest): Promise<PluginWorkerResult> {
  const input = Buffer.from(JSON.stringify(request.input ?? null))
  if (input.byteLength > maximumInputBytes) throw Error('Plugin worker input exceeds the 1 MB structured-input limit.')
  const startedAt = Date.now()
  if (request.slotKey) {
    const previous = activeWorkers.get(request.slotKey)
    if (previous) terminate(previous)
  }
  const child = spawn(process.execPath, [request.entry], {
    cwd: request.workspace,
    detached: process.platform !== 'win32',
    env: {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || '',
      LOCALAPPDATA: process.env.LOCALAPPDATA || '',
      APPDATA: process.env.APPDATA || '',
      USERPROFILE: process.env.USERPROFILE || '',
      SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || '',
      SYSTEMROOT: process.env.SYSTEMROOT || process.env.SystemRoot || '',
      TEMP: process.env.TEMP || '',
      TMP: process.env.TMP || '',
      LANG: process.env.LANG || 'C.UTF-8',
      LC_ALL: process.env.LC_ALL || '',
      TMPDIR: process.env.TMPDIR || '',
      ELECTRON_RUN_AS_NODE: '1',
      SHUN_PLUGIN_WORKER: '1',
      SHUN_PLUGIN_RUNTIME: JSON.stringify(request.runtime || {}),
      SHUN_PLUGIN_CACHE_DIR: request.cacheDirectory || '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  if (request.slotKey) {
    activeWorkers.set(request.slotKey, child)
    child.once('close', () => { if (activeWorkers.get(request.slotKey!) === child) activeWorkers.delete(request.slotKey!) })
  }
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  let stdoutBytes = 0, stderrBytes = 0, outputExceeded = false
  child.stdout.on('data', chunk => {
    const value = Buffer.from(chunk), remaining = maximumOutputBytes - stdoutBytes
    if (remaining <= 0) { outputExceeded = true; terminate(child); return }
    stdout.push(value.subarray(0, remaining)); stdoutBytes += Math.min(value.length, remaining)
    if (value.length > remaining) { outputExceeded = true; terminate(child) }
  })
  child.stderr.on('data', chunk => {
    const value = Buffer.from(chunk), remaining = maximumDiagnosticBytes - stderrBytes
    if (remaining <= 0) return
    stderr.push(value.subarray(0, remaining)); stderrBytes += Math.min(value.length, remaining)
  })
  child.stdin.end(input)
  const timeoutMs = Math.max(100, Math.min(120_000, Math.round(request.timeoutMs)))
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; terminate(child) }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut }) })
  })
  const diagnostics = Buffer.concat(stderr).toString('utf8').trim()
  if (outcome.timedOut) throw Error(`Plugin worker timed out after ${timeoutMs} ms.${diagnostics ? `\n${diagnostics}` : ''}`)
  if (outputExceeded) throw Error('Plugin worker output exceeds the 32 MB structured-output limit.')
  if (outcome.code !== 0) throw Error(`Plugin worker exited with code ${outcome.code ?? outcome.signal ?? 'unknown'}.${diagnostics ? `\n${diagnostics}` : ''}`)
  const text = Buffer.concat(stdout).toString('utf8').trim()
  if (!text) throw Error(`Plugin worker returned no structured output.${diagnostics ? `\n${diagnostics}` : ''}`)
  let value: unknown
  try { value = JSON.parse(text) }
  catch { throw Error(`Plugin worker output must be one JSON value.${diagnostics ? `\n${diagnostics}` : ''}`) }
  return { value, durationMs: Date.now() - startedAt, ...(diagnostics ? { diagnostics } : {}) }
}

function terminate(child: ChildProcess) {
  if (!child.pid || child.killed) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
    else spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
  } catch { try { child.kill('SIGKILL') } catch {} }
}
