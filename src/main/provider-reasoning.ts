import { createProvider, type Api, type AuthResult, type Model, type ProviderStreams, type StreamOptions } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

/** Preserve an explicit disabled deployment setting when the endpoint defaults to thinking. */
export function deploymentReasoningApi(api: ProviderStreams): ProviderStreams {
  function optionsFor(model: Model<Api>, options?: StreamOptions): StreamOptions | undefined {
    if (model.api !== 'openai-completions' || !model.compat || !('thinkingFormat' in model.compat) || model.compat.thinkingFormat !== 'deepseek' || model.reasoning) return options
    return {
      ...options,
      onPayload: async (payload, requestModel) => {
        const transformed = await options?.onPayload?.(payload, requestModel) ?? payload
        if (!transformed || typeof transformed !== 'object' || Array.isArray(transformed)) return transformed
        const result = { ...transformed, thinking: { type: 'disabled' } } as Record<string, unknown>
        delete result.reasoning_effort
        return result
      },
    }
  }
  return {
    ...api,
    stream: (model, context, options) => api.stream(model, context, optionsFor(model, options)),
    streamSimple: (model, context, options) => api.streamSimple(model, context, optionsFor(model, options)),
  }
}

export function deploymentReasoningProvider(model: Model<Api>, auth: AuthResult) {
  return createProvider({
    id: model.provider,
    models: [model],
    name: model.provider,
    baseUrl: model.baseUrl,
    // Retain this run's already resolved configuration, including headers and environment.
    auth: { apiKey: { name: 'Model API key', resolve: async () => auth } },
    api: deploymentReasoningApi(openAICompletionsApi()),
  })
}

/** Bound a declared fast-reading phase without changing thinking mode or its cached prefix. */
export function withReasoningBudget(payload: unknown, parameter: 'thinking_budget' | undefined, tokens: number): unknown {
  if (!parameter || !payload || typeof payload !== 'object' || Array.isArray(payload) || !Number.isFinite(tokens) || tokens < 1) return payload
  const request = payload as Record<string, unknown>
  const explicit = request[parameter]
  // The caller's tighter request remains authoritative. Zero is unbounded in this protocol.
  const budget = typeof explicit === 'number' && explicit > 0 ? Math.min(explicit, tokens) : tokens
  return { ...request, [parameter]: budget }
}
