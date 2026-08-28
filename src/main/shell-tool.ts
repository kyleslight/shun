import { createBashToolDefinition, defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'

/**
 * Keep shell capabilities attached to the shell tool itself so every session
 * sees the same environment contract without prompt- or task-specific routing.
 */
export function createShellTool(cwd: string): ToolDefinition {
  const tool = createBashToolDefinition(cwd, {
    // A failed producer must not look successful merely because a later
    // consumer such as `head` exited cleanly.
    commandPrefix: process.platform === 'win32' ? undefined : 'set -o pipefail',
  })
  return defineTool({
    ...tool,
    // Electron owns tool presentation; the upstream terminal renderers carry
    // narrower generic types that are irrelevant at this integration boundary.
    renderCall: undefined,
    renderResult: undefined,
    description: [
      tool.description,
      'Runs with the desktop user’s inherited environment, including locally installed command-line tools, environment variables, SSH agents, and existing non-interactive credentials when configured.',
      'A missing conventional environment variable does not prove that a tool is absent; inspect executable resolution and locally configured tool managers when needed.',
      'You may inspect that environment and reuse existing authentication when relevant; an anonymous HTTP failure does not prove that an authenticated resource is unavailable.',
      'Do not initiate an interactive login or create, replace, or modify credentials unless the user explicitly requests it.',
    ].join(' '),
    promptSnippet: 'Execute shell commands with locally installed tools and the desktop user’s existing environment',
    promptGuidelines: [
      'Bash can inspect and use locally installed command-line tools, environment variables, SSH agents, and existing non-interactive credentials.',
      'Bash should use executable resolution and locally configured tool managers when a conventional environment variable is absent instead of assuming the tool is not installed.',
      'Bash may reuse existing authentication when relevant, but must not initiate login or create, replace, or modify credentials unless the user explicitly requests it.',
    ],
  }) as ToolDefinition
}
