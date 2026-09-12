import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  conventionalWindowsPaths,
  expandWindowsVariables,
  mergeWindowsPath,
  refreshProcessEnvironment,
  refreshWindowsPath,
  registryPathValue,
  resolveWindowsShell,
  splitWindowsPath,
  windowsRegistryPath,
  windowsShellOperations,
} from './windows-shell.ts'

const machinePath = [
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  '    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;%SystemRoot%;C:\\Program Files\\nodejs',
  '',
].join('\r\n')
const userPath = [
  'HKEY_CURRENT_USER\\Environment',
  '    Path    REG_EXPAND_SZ    %LOCALAPPDATA%\\Programs\\Git\\cmd;%APPDATA%\\npm',
  '',
].join('\r\n')

const windowsEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  Path: 'C:\\Windows\\system32;C:\\Windows',
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\kyle\\AppData\\Local',
  APPDATA: 'C:\\Users\\kyle\\AppData\\Roaming',
  ...extra,
})

const windowsPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

function powerShellShell() {
  return resolveWindowsShell(windowsEnv(), value => value === windowsPowerShell)
}

function registryRunner(outputs: Record<string, string>) {
  const calls: Array<{ file: string; args: string[] }> = []
  const run = async (file: string, args: string[]) => {
    calls.push({ file, args })
    return outputs[args[1]] ?? ''
  }
  return { calls, run }
}

test('reads the machine and user Path values from reg query output', async () => {
  assert.equal(registryPathValue(machinePath), '%SystemRoot%\\system32;%SystemRoot%;C:\\Program Files\\nodejs')
  assert.equal(registryPathValue('HKEY_CURRENT_USER\\Environment\r\n    Path    REG_SZ    C:\\tools\r\n'), 'C:\\tools')
  assert.equal(registryPathValue('ERROR: The system was unable to find the specified registry key'), '')
  const { calls, run } = registryRunner({
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment': machinePath,
    'HKCU\\Environment': userPath,
  })
  assert.deepEqual(await windowsRegistryPath(windowsEnv(), run), [
    'C:\\Windows\\system32', 'C:\\Windows', 'C:\\Program Files\\nodejs',
    'C:\\Users\\kyle\\AppData\\Local\\Programs\\Git\\cmd', 'C:\\Users\\kyle\\AppData\\Roaming\\npm',
  ])
  assert.deepEqual(calls.map(call => [call.file, call.args[0], call.args[1]]), [
    ['reg', 'query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'],
    ['reg', 'query', 'HKCU\\Environment'],
  ])
})

test('expands registry variables case-insensitively and leaves unknown ones alone', () => {
  const env = windowsEnv()
  assert.equal(expandWindowsVariables('%SYSTEMROOT%\\system32;%ProgramFiles%\\Git', env), 'C:\\Windows\\system32;C:\\Program Files\\Git')
  assert.equal(expandWindowsVariables('%NOPE%\\bin', env), '%NOPE%\\bin')
  // Bounded: a self-referencing value cannot expand forever.
  assert.equal(expandWindowsVariables('%LOOP%', { ...env, LOOP: '%LOOP%' }), '%LOOP%')
})

test('merges Windows PATH entries ahead of the inherited path without duplicates', () => {
  assert.equal(
    mergeWindowsPath(['C:\\Program Files\\nodejs', 'c:\\windows\\SYSTEM32'], ['C:\\Windows\\system32', 'C:\\Windows']),
    'C:\\Program Files\\nodejs;c:\\windows\\SYSTEM32;C:\\Windows',
  )
  assert.equal(mergeWindowsPath(['"C:\\Program Files\\Git\\cmd"'], []), 'C:\\Program Files\\Git\\cmd')
  assert.equal(mergeWindowsPath([], ['C:\\Windows', '', 'C:\\Windows']), 'C:\\Windows')
  assert.deepEqual(splitWindowsPath('C:\\Windows;;C:\\Program Files\\nodejs;'), ['C:\\Windows', 'C:\\Program Files\\nodejs'])
})

test('conventional locations cover installer defaults and only existing directories', () => {
  const env = windowsEnv({ NVM_SYMLINK: 'C:\\Program Files\\nodejs', NVM_HOME: 'C:\\Users\\kyle\\AppData\\Roaming\\nvm' })
  const present = new Set([
    'C:\\Program Files\\Git\\cmd',
    'C:\\Program Files\\nodejs',
    'C:\\Users\\kyle\\AppData\\Local\\Volta\\bin',
  ])
  assert.deepEqual(conventionalWindowsPaths(env, value => present.has(value)), [
    'C:\\Program Files\\Git\\cmd',
    'C:\\Program Files\\nodejs',
    'C:\\Users\\kyle\\AppData\\Local\\Volta\\bin',
  ])
  assert.deepEqual(conventionalWindowsPaths(env, () => false), [])
})

test('refreshing PATH makes tooling installed during a session visible in place', async () => {
  const env = windowsEnv()
  const { run } = registryRunner({
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment': machinePath,
    'HKCU\\Environment': userPath,
  })
  await refreshWindowsPath(env, { run, exists: value => value === 'C:\\Users\\kyle\\AppData\\Local\\Programs\\Git\\cmd' })
  assert.deepEqual(splitWindowsPath(env.Path!).slice(0, 4), [
    'C:\\Windows\\system32',
    'C:\\Windows',
    'C:\\Program Files\\nodejs',
    'C:\\Users\\kyle\\AppData\\Local\\Programs\\Git\\cmd',
  ])
  assert.ok(splitWindowsPath(env.Path!).includes('C:\\Users\\kyle\\AppData\\Roaming\\npm'))
  assert.ok(splitWindowsPath(env.Path!).includes('C:\\Windows'))
})

test('PATH refresh keeps a non-Path key casing and survives a failed registry read', async () => {
  const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows' }
  await refreshWindowsPath(env, { run: async () => { throw Error('reg unavailable') }, exists: () => false })
  assert.equal(env.PATH, 'C:\\Windows')
  assert.equal(env.Path, undefined)
})

test('process environment refresh stays inert outside Windows and bounded by its TTL', async () => {
  const env = windowsEnv()
  assert.equal(await refreshProcessEnvironment({ env, platform: 'darwin', run: async () => machinePath }), 'C:\\Windows\\system32;C:\\Windows')
  assert.deepEqual(splitWindowsPath(env.Path!), ['C:\\Windows\\system32', 'C:\\Windows'])
  const { calls, run } = registryRunner({ 'HKCU\\Environment': userPath })
  await refreshProcessEnvironment({ env, platform: 'win32', now: 1_000_000, run, ttlMs: 5_000 })
  assert.equal(calls.length, 2)
  // Inside the TTL the machine is not queried again.
  await refreshProcessEnvironment({ env, platform: 'win32', now: 1_000_100, run, ttlMs: 5_000 })
  assert.equal(calls.length, 2)
  await refreshProcessEnvironment({ env, platform: 'win32', now: 1_020_000, run, ttlMs: 5_000 })
  assert.equal(calls.length, 4)
})

test('resolves Git Bash first, then the interpreters every Windows installation has', () => {
  const env = windowsEnv()
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
  assert.deepEqual(resolveWindowsShell(env, value => value === gitBash), {
    kind: 'bash', label: 'Git Bash', file: gitBash, commandArgs: ['-c'], syntax: '',
  })
  const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  assert.equal(resolveWindowsShell(env, value => value === pwsh).kind, 'pwsh')
  assert.equal(resolveWindowsShell(env, value => value === powershell).kind, 'powershell')
  const commandPrompt = resolveWindowsShell(env, () => false)
  assert.equal(commandPrompt.kind, 'cmd')
  assert.equal(commandPrompt.file, 'C:\\Windows\\System32\\cmd.exe')
})

test('power shell and cmd resolution accept tooling installed in user-level locations', () => {
  const env = windowsEnv({
    Path: 'C:\\Users\\kyle\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Windows',
    LOCALAPPDATA: 'C:\\Users\\kyle\\AppData\\Local',
  })
  const pwshOnPath = 'C:\\Users\\kyle\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
  assert.equal(resolveWindowsShell(env, value => value === pwshOnPath).file, pwshOnPath)
  const comSpecOnly = resolveWindowsShell({ ...windowsEnv(), ComSpec: 'D:\\Windows\\System32\\cmd.exe', SystemRoot: 'D:\\Windows' }, () => false)
  assert.equal(comSpecOnly.kind, 'cmd')
  assert.equal(comSpecOnly.file, 'D:\\Windows\\System32\\cmd.exe')
})

test('the WSL System32 shim never selects bash', () => {
  const env = windowsEnv({ Path: 'C:\\Windows\\System32;C:\\Windows' })
  const wslOnly = resolveWindowsShell(env, value => /Windows[\\/]System32[\\/]bash\.exe$/i.test(value))
  assert.equal(wslOnly.kind, 'cmd')
})

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { pid?: number; stdout: EventEmitter; stderr: EventEmitter; kill: (signal?: string) => boolean; killed: string[] }
  child.pid = 4242
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = []
  child.kill = signal => {
    child.killed.push(signal || 'SIGTERM')
    setImmediate(() => child.emit('close', null))
    return true
  }
  return child
}

test('non-bash execution streams output and reports the exit code', async () => {
  const calls: Array<{ file: string; args: string[]; cwd: string }> = []
  const child = fakeChild()
  const shell = powerShellShell()
  const operations = windowsShellOperations(shell, (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd })
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('hello\n'))
      child.stderr.emit('data', Buffer.from('warning\n'))
      child.emit('close', 0)
    })
    return child as never
  })
  const seen: string[] = []
  const result = await operations.exec('Get-ChildItem', tmpdir(), { onData: data => seen.push(data.toString()), env: windowsEnv() })
  assert.deepEqual(result, { exitCode: 0 })
  assert.deepEqual(seen, ['hello\n', 'warning\n'])
  assert.deepEqual(calls, [{ file: shell.file, args: [...shell.commandArgs, `${shell.outputEncoding} Get-ChildItem`], cwd: tmpdir() }])
  assert.match(shell.syntax, /Windows PowerShell 5\.1/)
  // Non-ASCII output survives the pipe: the console code page is not UTF-8 on
  // every Windows installation, so the encoding is set before the command runs.
  assert.match(shell.outputEncoding!, /^\[Console\]::OutputEncoding=\[System\.Text\.Encoding\]::UTF8;/)
})

test('non-bash execution keeps the timeout, abort, and working directory contract', async () => {
  const shell = powerShellShell()
  const hanging = fakeChild()
  const operations = windowsShellOperations(shell, () => hanging as never)
  await assert.rejects(
    () => operations.exec('Start-Sleep -Seconds 5', tmpdir(), { onData: () => {}, timeout: 0.01 }),
    /timeout:0\.01/,
  )
  assert.deepEqual(hanging.killed, ['SIGKILL'])

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => operations.exec('Get-ChildItem', tmpdir(), { onData: () => {}, signal: controller.signal }),
    /aborted/,
  )
  await assert.rejects(
    () => operations.exec('Get-ChildItem', join(tmpdir(), 'shun-missing-windows-dir'), { onData: () => {} }),
    /Working directory does not exist/,
  )
})

test('cmd execution uses the cmd.exe command runner arguments', async () => {
  const calls: string[][] = []
  const child = fakeChild()
  const operations = windowsShellOperations(resolveWindowsShell(windowsEnv(), () => false), (_file, args) => {
    calls.push(args)
    setImmediate(() => child.emit('close', 1))
    return child as never
  })
  assert.deepEqual(await operations.exec('dir', tmpdir(), { onData: () => {} }), { exitCode: 1 })
  assert.deepEqual(calls, [['/d', '/s', '/c', 'dir']])
})
