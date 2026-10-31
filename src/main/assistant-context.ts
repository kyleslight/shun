import type { AgentRequest } from '../shared.ts'

/** A working set for the ongoing conversation, independent of a model's maximum capacity.
 * The session service owns compaction and retains the original transcript on disk.
 * Between compactions nothing is trimmed or re-summarized, preserving append-only prefixes.
 */
export function assistantContextPolicy(request: AgentRequest, purpose?: string) {
  if (purpose !== 'assistant') return { request, compactionSettings: undefined }
  const contextWindow = Math.min(request.settings.contextWindow, 65_536)
  return {
    request: { ...request, settings: { ...request.settings, contextWindow } },
    compactionSettings: {
      reserveTokens: Math.min(8_192, Math.floor(contextWindow / 8)),
      keepRecentTokens: Math.min(12_288, Math.floor(contextWindow / 4)),
    },
  }
}
