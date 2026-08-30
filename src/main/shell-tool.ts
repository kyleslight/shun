import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { createBashToolDefinition, defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'

const DEFAULT_FOREGROUND_TIMEOUT_SECONDS = 120

export type WorkspaceCommandEnvironment = {
  env: NodeJS.ProcessEnv
  active: string[]
}

/**
 * Prefer conventional task-root environments without scanning outside the
 * workspace or consulting prompt text. Resolution happens for every command,
 * so an environment created during a run becomes active on the next call.
 */
export function workspaceCommandEnvironment(cwd: string, inherited: NodeJS.ProcessEnv): WorkspaceCommandEnvironment {
  const env = { ...inherited }
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
  const entries: string[] = []
  const active: string[] = []
  const virtualRoot = ['.venv', 'venv'].map(name => join(cwd, name)).find(hasVirtualEnvironment)
  if (virtualRoot) {
    entries.push(join(virtualRoot, process.platform === 'win32' ? 'Scripts' : 'bin'))
    env.VIRTUAL_ENV = virtualRoot
    active.push(virtualRoot === join(cwd, '.venv') ? '.venv' : 'venv')
  }
  const nodeBin = join(cwd, 'node_modules', '.bin')
  if (isDirectory(nodeBin)) {
    entries.push(nodeBin)
    active.push('node_modules/.bin')
  }
  const inheritedPath = env[pathKey] || ''
  if (entries.length) env[pathKey] = [...new Set([...entries, ...inheritedPath.split(delimiter).filter(Boolean)])].join(delimiter)
  return { env, active }
}

function hasVirtualEnvironment(root: string) {
  if (!existsSync(join(root, 'pyvenv.cfg'))) return false
  const candidates = process.platform === 'win32'
    ? [join(root, 'Scripts', 'python.exe')]
    : [join(root, 'bin', 'python'), join(root, 'bin', 'python3')]
  return candidates.some(isExecutable)
}

function isExecutable(path: string) {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch { return false }
}

function isDirectory(path: string) {
  try { return statSync(path).isDirectory() } catch { return false }
}

/**
 * Keep shell capabilities attached to the shell tool itself so every session
 * sees the same environment contract without prompt- or task-specific routing.
 */
export function createShellTool(cwd: string): ToolDefinition {
  const detectedEnvironment = workspaceCommandEnvironment(cwd, process.env).active
  const tool = createBashToolDefinition(cwd, {
    // A failed producer must not look successful merely because a later
    // consumer such as `head` exited cleanly.
    commandPrefix: process.platform === 'win32' ? undefined : 'set -o pipefail',
    exposeSessionEnvironment: false,
    spawnHook: context => ({ ...context, env: workspaceCommandEnvironment(cwd, context.env).env }),
  })
  return defineTool({
    ...tool,
    // Electron owns tool presentation; the upstream terminal renderers carry
    // narrower generic types that are irrelevant at this integration boundary.
    renderCall: undefined,
    renderResult: undefined,
    description: [
      tool.description,
      `Foreground commands default to a ${DEFAULT_FOREGROUND_TIMEOUT_SECONDS}-second timeout; use the task-owned background process tools for servers, watchers, and other intentionally long-running work.`,
      'Runs with the desktop user’s inherited non-interactive environment and may reuse existing authentication when relevant.',
      'When present, a task-root .venv or venv and node_modules/.bin are placed before the inherited executable path for every command.',
      ...(detectedEnvironment.length ? [`Detected project command environment: ${detectedEnvironment.join(', ')}.`] : []),
      'Plain commands such as python, pip, pytest, node, and package scripts resolve through that project environment automatically; do not inspect or activate it again.',
      'When a required executable does not resolve, follow explicit project configuration for a local environment or tool manager; do not scan unrelated host paths.',
      'Do not initiate an interactive login or create, replace, or modify credentials unless the user explicitly requests it.',
    ].join(' '),
    promptSnippet: 'Execute bounded foreground shell commands in the task working directory',
    promptGuidelines: [
      'Use Bash for execution, builds, and tests; use grep, find, ls, and read for ordinary repository navigation.',
      'Use plain commands with the automatically selected task-root project environment when one is reported; do not inspect, rediscover, or reactivate it.',
      'Keep foreground commands bounded. Use task-owned background process tools for servers, watchers, and intentionally long-running work.',
      'If a required executable does not resolve, follow explicit project configuration for a local environment or tool manager; do not scan unrelated host paths.',
      'Bash may reuse existing non-interactive authentication, but must not initiate login or create, replace, or modify credentials unless the user explicitly requests it.',
    ],
    execute: (id, args, signal, onUpdate, context) => tool.execute(id, {
      ...args,
      timeout: args.timeout ?? DEFAULT_FOREGROUND_TIMEOUT_SECONDS,
    }, signal, onUpdate, context),
  }) as ToolDefinition
}
