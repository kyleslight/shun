import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { delimiter } from 'node:path'

type ShellEnvironment = NodeJS.ProcessEnv
type ShellPathRunner = (shell: string, args: string[]) => Promise<string>

const runShell: ShellPathRunner = (shell, args) => new Promise(resolve => {
  execFile(shell, args, {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  }, (_error, stdout) => resolve(stdout || ''))
})

export async function hydrateProcessPath(
  env: ShellEnvironment = process.env,
  platform = process.platform,
  run: ShellPathRunner = runShell,
) {
  if (platform === 'win32') return currentPath(env)
  const shell = env.SHELL || userInfo().shell || '/bin/sh'
  const output = await run(shell, ['-ilc', 'env -0']).catch(() => '')
  const shellPath = pathFromShellOutput(output)
  if (!shellPath) return currentPath(env)
  const merged = mergePaths(shellPath, currentPath(env), ':')
  const key = pathKey(env)
  env[key] = merged
  return merged
}

export function pathFromShellOutput(output: string) {
  return output.match(/(?:^|[\0\r\n])PATH=([^\0\r\n]*)/)?.[1] || ''
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
