import type { AgentRequest } from '../shared.ts'

/** Keep the working set small without misrepresenting the deployment's physical
 * window: provider adapters need the latter to reserve room for a real answer.
 * The session service remains responsible for compaction and transcript storage.
 */
export function assistantContextPolicy(request: AgentRequest, purpose?: string) {
  if (purpose !== 'assistant') return { request, compactionSettings: undefined, workingSetTokens: undefined }
  const physicalWindow = request.settings.contextWindow
  const workingSetTokens = Math.min(physicalWindow, 65_536)
  const headroom = Math.min(8_192, Math.floor(workingSetTokens / 8))
  return {
    request,
    workingSetTokens,
    compactionSettings: {
      reserveTokens: physicalWindow - workingSetTokens + headroom,
      keepRecentTokens: Math.min(12_288, Math.floor(workingSetTokens / 4)),
    },
  }
}
