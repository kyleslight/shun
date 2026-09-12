import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import type { BashOperations } from '@earendil-works/pi-coding-agent'

/**
 * Windows execution support.
 *
 * Shun never installs developer tooling. What it owes a Windows user is (1) a
 * command interpreter that exists on every Windows installation and (2) PATH
 * that reflects what the user installed, including installs that happen while
 * Shun is running. Both are resolved from the machine's own configuration
 * rather than from prompt text or task keywords.
 */

// Windows PATH entries are ';'-separated even when this module is evaluated on
// another host, so path logic stays explicit instead of using host defaults.
const windowsPathDelimiter = ';'
const pathRefreshTtlMs = 5_000
const registryKeys = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
]

export type WindowsShellKind = 'bash' | 'pwsh' | 'powershell' | 'cmd'

export type WindowsShell = {
  kind: WindowsShellKind
  label: string
  file: string
  /** Arguments that turn the interpreter into a non-interactive command runner. */
  commandArgs: string[]
  /**
   * Statement prepended to every command so non-ASCII output survives the pipe.
   * Windows PowerShell 5.1 encodes redirected output with the console code page
   * (for example GBK), which would otherwise reach the model as mojibake.
   */
  outputEncoding?: string
  /** How the model must write commands for this interpreter; empty for POSIX bash. */
  syntax: string
}

export type PathRunner = (file: string, args: string[]) => Promise<string>
export type FileExists = (path: string) => boolean
export type WindowsSpawn = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide: boolean }) => ChildProcess

const runProgram: PathRunner = (file, args) => new Promise(resolve => {
  execFile(file, args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true }, (_error, stdout) => resolve(stdout || ''))
})

/** Read the `Path` value out of `reg query` output, including REG_EXPAND_SZ. */
export function registryPathValue(output: string) {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i)
    if (match) return match[1]
  }
  return ''
}

export function expandWindowsVariables(value: string, env: NodeJS.ProcessEnv) {
  let result = value
  for (let pass = 0; pass < 4 && result.includes('%'); pass++) {
    const next = result.replace(/%([^%]{1,64})%/g, (match, name: string) => windowsVariable(env, name) ?? match)
    if (next === result) break
    result = next
  }
  return result
}

export function windowsPathKey(env: NodeJS.ProcessEnv) {
  return Object.keys(env).find(key => key.toLowerCase() === 'path') || 'Path'
}

function windowsVariable(env: NodeJS.ProcessEnv, name: string) {
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase())
  const value = key ? env[key] : undefined
  return typeof value === 'string' ? value : undefined
}

export function splitWindowsPath(value: string) {
  return value.split(windowsPathDelimiter).map(entry => unquoteWindowsPath(entry)).filter(Boolean)
}

function unquoteWindowsPath(entry: string) {
  const trimmed = entry.trim()
  const quoted = trimmed.match(/^"(.*)"$/)
  return quoted ? quoted[1] : trimmed
}

/** Keep the first occurrence of each entry, case-insensitively as Windows does. */
export function mergeWindowsPath(primary: string[], fallback: string[]) {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const entry of [...primary, ...fallback]) {
    const value = unquoteWindowsPath(entry)
    if (!value || seen.has(value.toLowerCase())) continue
    seen.add(value.toLowerCase())
    entries.push(value)
  }
  return entries.join(windowsPathDelimiter)
}

export async function windowsRegistryPath(env: NodeJS.ProcessEnv, run: PathRunner = runProgram) {
  const values: string[] = []
  for (const key of registryKeys) {
    const output = await run('reg', ['query', key, '/v', 'Path']).catch(() => '')
    const value = registryPathValue(output)
    if (value) values.push(...splitWindowsPath(expandWindowsVariables(value, env)))
  }
  return values
}

/**
 * Well-known locations of tooling that Windows users install themselves. Each
 * candidate is only used when it exists; nothing outside this short, published
 * list is scanned.
 */
export function conventionalWindowsPaths(env: NodeJS.ProcessEnv, exists: FileExists = existsSync) {
  const programFiles = windowsVariable(env, 'ProgramFiles')
  const programFilesX86 = windowsVariable(env, 'ProgramFiles(x86)')
  const localAppData = windowsVariable(env, 'LOCALAPPDATA')
  const candidates = [
    programFiles && win32.join(programFiles, 'Git', 'cmd'),
    programFiles && win32.join(programFiles, 'Git', 'bin'),
    programFilesX86 && win32.join(programFilesX86, 'Git', 'cmd'),
    localAppData && win32.join(localAppData, 'Programs', 'Git', 'cmd'),
    programFiles && win32.join(programFiles, 'nodejs'),
    windowsVariable(env, 'NVM_SYMLINK'),
    windowsVariable(env, 'NVM_HOME'),
    localAppData && win32.join(localAppData, 'Volta', 'bin'),
    programFiles && win32.join(programFiles, 'PowerShell', '7'),
  ].filter((value): value is string => Boolean(value))
  return [...new Set(candidates)].filter(entry => {
    try { return exists(entry) } catch { return false }
  })
}

/**
 * Merge the machine's current registry PATH and conventional install locations
 * ahead of the inherited PATH, in place, so anything that spawns with
 * `process.env` sees tooling the user installed after Shun started.
 */
export async function refreshWindowsPath(
  env: NodeJS.ProcessEnv,
  options: { run?: PathRunner; exists?: FileExists } = {},
) {
  const key = windowsPathKey(env)
  const current = env[key] || ''
  const registry = await windowsRegistryPath(env, options.run).catch(() => [] as string[])
  const merged = mergeWindowsPath(
    [...registry, ...conventionalWindowsPaths(env, options.exists)],
    splitWindowsPath(current),
  )
  if (merged) env[key] = merged
  return env[key] || ''
}

let lastProcessRefreshAt = 0

export async function refreshProcessEnvironment(
  options: { env?: NodeJS.ProcessEnv; platform?: string; force?: boolean; ttlMs?: number; now?: number; run?: PathRunner; exists?: FileExists } = {},
) {
  const env = options.env || process.env
  if ((options.platform || process.platform) !== 'win32') return env[windowsPathKey(env)] || ''
  const now = options.now ?? Date.now()
  if (!options.force && now - lastProcessRefreshAt < (options.ttlMs ?? pathRefreshTtlMs)) return env[windowsPathKey(env)] || ''
  lastProcessRefreshAt = now
  return refreshWindowsPath(env, options)
}

function executableOnPath(env: NodeJS.ProcessEnv, names: string[], exists: FileExists, allow?: (path: string) => boolean) {
  for (const entry of splitWindowsPath(windowsVariable(env, 'Path') || '')) {
    for (const name of names) {
      const candidate = win32.join(entry, name)
      if (allow && !allow(candidate)) continue
      try { if (exists(candidate)) return candidate } catch {}
    }
  }
  return ''
}

function firstExisting(candidates: (string | undefined | false)[], exists: FileExists) {
  for (const candidate of candidates) {
    if (!candidate) continue
    try { if (exists(candidate)) return candidate } catch {}
  }
  return ''
}

// WSL's System32 shim is a launcher into a distribution, not a usable POSIX
// shell for task commands, so it never selects the bash interpreter.
function isLegacyWslBash(path: string) {
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i.test(path.replace(/\//g, '\\'))
}

/**
 * Resolve the command interpreter for this machine. Precedence preserves POSIX
 * behavior for users who installed Git for Windows, then falls back to the
 * interpreters that every Windows installation already has.
 */
export function resolveWindowsShell(env: NodeJS.ProcessEnv, exists: FileExists = existsSync): WindowsShell {
  const programFiles = windowsVariable(env, 'ProgramFiles')
  const programFilesX86 = windowsVariable(env, 'ProgramFiles(x86)')
  const systemRoot = windowsVariable(env, 'SystemRoot') || windowsVariable(env, 'windir') || 'C:\\Windows'
  const bash = firstExisting([
    programFiles && win32.join(programFiles, 'Git', 'bin', 'bash.exe'),
    programFilesX86 && win32.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    executableOnPath(env, ['bash.exe'], exists, path => !isLegacyWslBash(path)),
  ], exists)
  if (bash) {
    return { kind: 'bash', label: 'Git Bash', file: bash, commandArgs: ['-c'], syntax: '' }
  }
  const pwsh = firstExisting([
    executableOnPath(env, ['pwsh.exe'], exists),
    programFiles && win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
  ], exists)
  if (pwsh) {
    return {
      kind: 'pwsh',
      label: 'PowerShell 7 (pwsh.exe)',
      file: pwsh,
      commandArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
      outputEncoding: '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
      syntax: 'Commands run in PowerShell 7: separate statements with ; (&& and || also work), read environment variables as $env:NAME, and run .cmd shims such as npm by name.',
    }
  }
  const powershell = firstExisting([
    executableOnPath(env, ['powershell.exe'], exists),
    win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ], exists)
  if (powershell) {
    return {
      kind: 'powershell',
      label: 'Windows PowerShell 5.1 (powershell.exe)',
      file: powershell,
      commandArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
      outputEncoding: '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
      syntax: 'Commands run in Windows PowerShell 5.1: separate statements with ; (there is no && or || chaining), read environment variables as $env:NAME, use cmdlets such as Get-ChildItem and Select-String, and run .cmd shims such as npm by name.',
    }
  }
  const commandPrompt = firstExisting([
    executableOnPath(env, ['cmd.exe'], exists),
    win32.join(systemRoot, 'System32', 'cmd.exe'),
  ], exists) || windowsVariable(env, 'ComSpec') || win32.join(systemRoot, 'System32', 'cmd.exe')
  return {
    kind: 'cmd',
    label: 'cmd.exe',
    file: commandPrompt,
    commandArgs: ['/d', '/s', '/c'],
    syntax: 'Commands run in cmd.exe: chain with &&, read environment variables as %NAME%, and list or search with dir, type, and findstr.',
  }
}

function windowsShellTimeoutMs(timeout: unknown) {
  if (timeout === undefined) return undefined
  const seconds = Number(timeout)
  if (!Number.isFinite(seconds) || seconds <= 0) throw Error('Invalid timeout: must be a finite number of seconds')
  return seconds * 1_000
}

function stopProcessTree(child: ChildProcess) {
  const pid = child.pid
  if (pid && process.platform === 'win32') {
    // Windows has no process groups for console children, so terminate the tree
    // by PID first and always fall back to the direct handle.
    try {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).unref()
    } catch {}
  }
  try { child.kill('SIGKILL') } catch {}
}

/**
 * Execution backend for interpreters that are not bash. It mirrors the bash
 * operations contract (streamed output, seconds-based timeout, abort kills the
 * process tree, `timeout:<seconds>` errors) so the tool identity and its
 * presentation stay unchanged.
 */
export function windowsShellOperations(shell: WindowsShell, spawnProcess: WindowsSpawn = spawn as unknown as WindowsSpawn): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const timeoutMs = windowsShellTimeoutMs(timeout)
      if (signal?.aborted) throw Error('aborted')
      if (!existsSync(cwd)) throw Error(`Working directory does not exist: ${cwd}`)
      const child = spawnProcess(shell.file, [...shell.commandArgs, shell.outputEncoding ? `${shell.outputEncoding} ${command}` : command], {
        cwd,
        env: env || process.env,
        windowsHide: true,
      })
      let timedOut = false
      let timeoutHandle: NodeJS.Timeout | undefined
      const onAbort = () => stopProcessTree(child)
      try {
        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true
            stopProcessTree(child)
          }, timeoutMs)
        }
        child.stdout?.on('data', onData)
        child.stderr?.on('data', onData)
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
        const exitCode = await new Promise<number | null>(resolve => {
          child.once('close', code => resolve(typeof code === 'number' ? code : null))
          child.once('error', () => resolve(null))
        })
        if (signal?.aborted) throw Error('aborted')
        if (timedOut) throw Error(`timeout:${timeout}`)
        return { exitCode }
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
