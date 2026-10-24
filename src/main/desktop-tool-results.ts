import type { DesktopControlService } from './desktop-control.ts'

export function desktopSequenceResult(value: Awaited<ReturnType<DesktopControlService['actSequence']>>) {
  const { snapshot, tree, ...rest } = value
  const { screenshot, ...capture } = snapshot || {}
  const receipt = {
    ...rest,
    ...(tree ? { window: tree.window, geometry: tree.geometry, controls: tree.elements.slice(0, 40), controls_truncated: tree.truncated || tree.elements.length > 40 } : {}),
    ...(snapshot ? { capture } : {}),
  }
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: 'image/png'; data: string }> = [{ type: 'text', text: JSON.stringify(receipt, null, 2) }]
  if (screenshot) content.push({ type: 'image', mimeType: 'image/png', data: screenshot })
  return { content, details: receipt }
}
