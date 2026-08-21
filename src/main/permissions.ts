import type { Settings } from '../shared'

const approvalTools = new Set(['bash', 'edit', 'write', 'mcp_call', 'background_start', 'background_stop'])

/**
 * Permission is a product setting evaluated at the real tool-call boundary.
 * Tool arguments are deliberately not accepted here: command spelling is not
 * an authorization boundary and equivalent operations must behave identically.
 */
export function toolNeedsApproval(permission: Settings['permission'], toolName: string) {
  return permission === 'ask' && approvalTools.has(toolName)
}
