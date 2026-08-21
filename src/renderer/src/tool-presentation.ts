import type { ToolEvent } from '../../shared.ts'

export function isShellTool(tool: Pick<ToolEvent, 'name'> | string) {
  const name = typeof tool === 'string' ? tool : tool.name
  return name === 'bash' || name === 'run'
}

export function shellCommand(tool: Pick<ToolEvent, 'name' | 'input'>) {
  if (!isShellTool(tool)) return ''
  try {
    const command = JSON.parse(tool.input || '{}').command
    return typeof command === 'string' ? command.trim() : ''
  } catch {
    return ''
  }
}
