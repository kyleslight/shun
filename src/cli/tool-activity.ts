import { stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui'
import type { ToolEvent } from '../shared.ts'
import { hostToolLabel } from '../host/protocol.ts'

const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

/** Presentation only: the original tool events remain intact for inspection. */
export function toolActivity(tools: ToolEvent[], expanded = false, width = 80): string {
  if (!tools.length) return ''
  const line = (text: string) => clean(truncateToWidth(clean(text).replace(/\s+/g, ' '), Math.max(12, width - 4), '…'))
  if (expanded) {
    return tools.map(tool => {
      const output = clean(tool.output || '')
      return `  ${line(hostToolLabel(tool))} · ${tool.state}${output ? `\n${output}` : ''}`
    }).join('\n')
  }
  const rows: string[] = []
  const running = tools.filter(tool => tool.state === 'running')
  if (running.length) rows.push(`  ◌ ${line(hostToolLabel(running[running.length - 1]))}${running.length > 1 ? ` (+${running.length - 1} running)` : ''}`)
  for (const tool of tools.filter(tool => tool.state === 'error')) {
    rows.push(`  ✗ ${line(hostToolLabel(tool))}`)
    const message = clean(tool.output || '').split('\n').find(text => text.trim())
    if (message) rows.push(`    ${line(message)}`)
  }
  return rows.join('\n')
}
