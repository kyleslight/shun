import type { AgentRequest } from '../shared.ts'

/** Keep the working set small without misrepresenting the deployment's physical
 * window: provider adapters need the latter to reserve room for a real answer.
 * The session service remains responsible for compaction and transcript storage.
 */
export function assistantContextPolicy(request: AgentRequest, purpose?: string, child = false) {
  if (purpose !== 'assistant' && !child) return { request, compactionSettings: undefined, workingSetTokens: undefined }
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

/** Keep successful answers out of foreground maintenance. Capacity recovery is
 * still owned by the session service; this hook only defers optional work. */
export function assistantForegroundContextExtension(request: AgentRequest, deferThreshold = true, signal?: AbortSignal): import('@earendil-works/pi-coding-agent').ExtensionFactory {
  return api => {
    let completedAnswer = false
    api.on('agent_end', event => {
      const last = [...event.messages].reverse().find(message => message.role === 'assistant')
      completedAnswer = last?.role === 'assistant' && last.stopReason === 'stop'
    })
    api.on('session_before_compact', event => {
      // Cancellation may arrive before post-run maintenance has started.
      if (signal?.aborted) return { cancel: true }
      if (event.reason === 'manual' || event.willRetry) return
      if (completedAnswer) return { cancel: true }
      // A queued next message must not pay for a soft working-set threshold.
      // Preserve a physical-window guard, including room for its new input.
      const reserve = Math.max(8192, request.settings.maxTokens || 0) + 8192 + request.text.length
      if (deferThreshold && event.reason === 'threshold' && event.preparation.tokensBefore < request.settings.contextWindow - reserve) return { cancel: true }
    })
  }
}
