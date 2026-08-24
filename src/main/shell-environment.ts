import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { delimiter } from 'node:path'

type ShellEnvironment = NodeJS.ProcessEnv
type ShellPathRunner = (shell: string, args: string[]) => Promise<string>

const transientShellVariables = new Set(['_', 'OLDPWD', 'PWD', 'SHLVL'])

function isApplicationControlVariable(key: string) {
  return key.startsWith('SHUN_') || key.startsWith('ELECTRON_')
}

const runShell: ShellPathRunner = (shell, args) => new Promise(resolve => {
  execFile(shell, args, {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  }, (_error, stdout) => resolve(stdout || ''))
})

export async function hydrateProcessEnvironment(
  env: ShellEnvironment = process.env,
  platform = process.platform,
  run: ShellPathRunner = runShell,
) {
  if (platform === 'win32') return currentPath(env)
  const shell = env.SHELL || userInfo().shell || '/bin/sh'
  const output = await run(shell, ['-ilc', 'env -0']).catch(() => '')
  const shellEnvironment = environmentFromShellOutput(output)
  for (const [key, value] of Object.entries(shellEnvironment)) {
    if (transientShellVariables.has(key) || isApplicationControlVariable(key) || key in env) continue
    env[key] = value
  }
  const shellPath = shellEnvironment.PATH || ''
  if (shellPath) env[pathKey(env)] = mergePaths(shellPath, currentPath(env), ':')
  return currentPath(env)
}

export function pathFromShellOutput(output: string) {
  return environmentFromShellOutput(output).PATH || ''
}

export function environmentFromShellOutput(output: string) {
  const result: Record<string, string> = {}
  for (const record of output.split('\0')) {
    const match = record.match(/(?:^|[\r\n])([A-Za-z_][A-Za-z0-9_]*)=([^\0]*)$/)
    if (match) result[match[1]] = match[2]
  }
  return result
}

export function mergePaths(primary: string, fallback: string, separator = delimiter) {
  const seen = new Set<string>(), entries: string[] = []
  for (const entry of `${primary}${separator}${fallback}`.split(separator)) {
    const value = entry.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    entries.push(value)
  }
  return entries.join(separator)
}

function currentPath(env: ShellEnvironment) { return env[pathKey(env)] || '' }
function pathKey(env: ShellEnvironment) { return Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH' }
