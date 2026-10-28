import { withinWebDeadline } from './web.ts'
import type { AgentRequest } from '../shared.ts'

/** Query rewriting has no answer reasoning; leave the user's actual model run untouched. */
export function queryPlanningRequest(request: AgentRequest): AgentRequest {
  return { ...request, settings: { ...request.settings, providers: request.settings.providers.map(provider =>
    provider.id !== request.settings.providerId ? provider : { ...provider, models: provider.models?.map(model =>
      model.id === request.settings.model ? { ...model, reasoning: false } : model) }) } }
}

/** One bounded query rewrite, after the model explicitly requests a factual search. */
export async function planWebQuery(queries: string[], outcome: string, complete: (input: string, signal: AbortSignal) => Promise<string>, signal?: AbortSignal, timeoutMs = 2500) {
  if (!outcome || queries.length < 2) return undefined
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    const text = await withinWebDeadline(complete(JSON.stringify({ requested_outcome: outcome, queries }), combined), {
      signal: combined, ms: timeoutMs, message: 'Query planning window ended.',
    })
    let query = text.trim()
    if (!query || query.length > 300 || /[\r\n]/.test(query) || queries.includes(query)) return undefined
    // Keep literal version/revision qualifiers even when the rewrite omits one.
    const qualifiers = [...new Set(queries.flatMap(value => value.match(/\b(?:v?\d+(?:\.\d+)+|\d{4,})\b/gi) || []))]
    for (const qualifier of qualifiers) if (!query.toLowerCase().includes(qualifier.toLowerCase().replace(/^v(?=\d)/, ''))) query += ` ${qualifier}`
    return query.length <= 300 ? query : undefined
  } catch { signal?.throwIfAborted(); return undefined }
  finally { controller.abort() }
}

