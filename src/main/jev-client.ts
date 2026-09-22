import type { Settings } from '../shared.ts'
import { decisionRouteForEndpoint, decisionRouteForId, decisionRouteOrder, decisionRoutes, defaultComputerUseAcceleration, type DecisionRoute, type DecisionRouteId } from '../shared.ts'

/**
 * A System One decision model answers typed questions against a state and returns
 * structured probabilities instead of text: a yes/no judgment (noul), a choice
 * with its full probability distribution, or a score. Shun reaches one through
 * any service that speaks that protocol — TypeSafe itself, a gateway that
 * proxies it, or a future local model.
 *
 * DecisionClient is deliberately narrower than the chat provider abstraction.
 * Shun asks it which of a finite set of offered actions to take, never what
 * prose to write, so a local reflex model can replace the remote one later
 * without any browser code changing.
 */
export const OPENROUTER_DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'
export const DEFAULT_JEV_MODEL = defaultComputerUseAcceleration.model

/** The Decisions endpoint sits beside the provider's inference endpoint. */
export function decisionsEndpointFor(providerEndpoint: string) {
  const route = decisionRouteForEndpoint(providerEndpoint)
  if (route) return route.endpoint
  try { return `${new URL(providerEndpoint).origin}/api/alpha/decisions` } catch { return OPENROUTER_DECISIONS_ENDPOINT }
}




export type DecisionNoulQuestion = {
  type: 'noul'
  instructions: unknown
  criteria?: { true: unknown; false: unknown }
}

export type DecisionChoiceQuestion = {
  type: 'choice'
  instructions: unknown
  /** Option id to the rubric describing when that option is right. */
  criteria: Record<string, string>
}

export type DecisionQuestion = DecisionNoulQuestion | DecisionChoiceQuestion

export type DecisionRequest = {
  model: string
  /** The material to evaluate: text, an object, or an array. */
  state: unknown
  /** Answers come back under the same keys. */
  questions: Record<string, DecisionQuestion>
}

export type DecisionAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence?: number; probabilities?: Record<string, number> }
  | { type: 'score'; score: number; confidence?: number; probabilities?: Record<string, number> }

export type DecisionResponse = {
  model?: string
  answers: Record<string, DecisionAnswer>
  usage?: { inputTokens?: number; outputTokens?: number }
}

export interface DecisionClient {
  decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse>
}

/**
 * A failure here is an acceleration failure, never a Browser Use failure. The
 * message stays in Shun's own words, because a person who sees it cannot act on
 * a provider name, a status code, or a routing detail.
 */
function unavailable(detail: string) {
  return Error(`Fast browser decisions are unavailable right now (${detail}). Continue with the normal Browser Use tools.`)
}

function numberOrUndefined(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function probabilityMap(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, numberOrUndefined(item)] as const)
    // A probability outside [0, 1] is not a probability: the entry is dropped rather than
    // clamped, so the answer falls back to a plain choice instead of a distribution Shun
    // would have invented by rounding.
    .filter((entry): entry is readonly [string, number] => entry[1] !== undefined && entry[1] >= 0 && entry[1] <= 1)
  return entries.length ? Object.fromEntries(entries) : undefined
}

/**
 * Keeps only answers Shun can act on. An unreadable answer is dropped rather
 * than guessed, and the caller escalates on the missing judgment.
 */
export function normalizeDecisionResponse(payload: unknown): DecisionResponse {
  const record = payload && typeof payload === 'object' ? payload as Record<string, any> : {}
  const raw = record.answers && typeof record.answers === 'object' && !Array.isArray(record.answers) ? record.answers as Record<string, any> : {}
  const answers: Record<string, DecisionAnswer> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue
    if (value.type === 'noul') {
      const noul = numberOrUndefined(value.noul)
      if (noul !== undefined) answers[key] = { type: 'noul', noul }
      continue
    }
    if (value.type === 'choice' && typeof value.choice === 'string') {
      const probabilities = probabilityMap(value.probabilities)
      const confidence = numberOrUndefined(value.confidence)
      answers[key] = { type: 'choice', choice: value.choice, ...(probabilities ? { probabilities } : {}), ...(confidence !== undefined ? { confidence } : {}) }
      continue
    }
    if (value.type === 'score') {
      const score = numberOrUndefined(value.score)
      const confidence = numberOrUndefined(value.confidence)
      if (score !== undefined) answers[key] = { type: 'score', score, ...(confidence !== undefined ? { confidence } : {}) }
    }
  }
  const usage = record.usage && typeof record.usage === 'object' ? record.usage as Record<string, unknown> : {}
  return {
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
    answers,
    usage: { inputTokens: numberOrUndefined(usage.input_tokens) ?? numberOrUndefined(usage.inputTokens) ?? 0, outputTokens: numberOrUndefined(usage.output_tokens) ?? numberOrUndefined(usage.outputTokens) ?? 0 },
  }
}

/**
 * A failure worth repeating: the service was busy, or the request never reached it. Only a
 * read-only judgment may be repeated. A browser action is a different thing entirely and is
 * never retried anywhere in Shun, because a click that may have landed twice is how a
 * message gets sent twice.
 *
 * The reason it carries is what a person is told if every attempt fails, so it says what
 * happened in Shun's words and never in a provider's.
 */
class DecisionRetryableError extends Error {
  constructor(reason: string) { super(reason); this.name = 'DecisionRetryableError' }
}

/** Statuses a decision service uses to say "busy, ask again": backpressure, not refusal. */
const RETRYABLE_STATUS = new Set([429, 503, 529])
const MAX_DECISION_RETRIES = 2
const RETRY_BASE_DELAY_MS = 250

/**
 * One HTTP client for every decision service Shun supports, because they share
 * the request and response shape. The name is historical: it began as the
 * OpenRouter client and is now the client for this protocol.
 */
export class OpenRouterJevClient implements DecisionClient {
  readonly #apiKey: string
  readonly #endpoint: string
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number
  readonly #retryDelayMs: number

  constructor(options: { apiKey: string; endpoint?: string; timeoutMs?: number; retryDelayMs?: number; fetchImpl?: typeof fetch }) {
    this.#apiKey = options.apiKey
    this.#endpoint = options.endpoint || OPENROUTER_DECISIONS_ENDPOINT
    this.#fetch = options.fetchImpl || fetch
    this.#timeoutMs = Math.max(1_000, options.timeoutMs ?? 10_000)
    this.#retryDelayMs = Math.max(0, options.retryDelayMs ?? RETRY_BASE_DELAY_MS)
  }

  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
    // The budget covers every attempt, so a retry can never turn a bounded decision into an
    // unbounded wait.
    const deadline = Date.now() + this.#timeoutMs
    for (let attempt = 0; ; attempt += 1) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw unavailable('the request took too long')
      try {
        return await this.#attempt(request, remaining, signal)
      } catch (error) {
        if (!(error instanceof DecisionRetryableError) || attempt >= MAX_DECISION_RETRIES || signal?.aborted) {
          if (error instanceof DecisionRetryableError) throw unavailable(error.message)
          throw error
        }
        await new Promise(resolve => setTimeout(resolve, this.#retryDelayMs * 2 ** attempt))
      }
    }
  }

  async #attempt(request: DecisionRequest, timeoutMs: number, signal?: AbortSignal): Promise<DecisionResponse> {
    const timer = new AbortController()
    const timeout = setTimeout(() => timer.abort(), timeoutMs)
    const onAbort = () => timer.abort()
    signal?.addEventListener('abort', onAbort)
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#apiKey}`,
          'http-referer': 'https://shunagent.com',
          'x-title': 'Shun',
        },
        body: JSON.stringify(request),
        signal: timer.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        if (RETRYABLE_STATUS.has(response.status)) throw new DecisionRetryableError('the decision service was busy')
        throw unavailable('the decision service refused the request')
      }
      let payload: unknown
      try { payload = JSON.parse(text) } catch { throw unavailable('the response could not be read') }
      return normalizeDecisionResponse(payload)
    } catch (error) {
      if (error instanceof DecisionRetryableError) throw error
      if (error instanceof Error && error.message.startsWith('Fast browser decisions are unavailable')) throw error
      if (signal?.aborted) throw unavailable('the request was cancelled')
      // A timeout is the end of the budget, not a busy service, so it is not repeated here.
      if (timer.signal.aborted) throw unavailable('the request took too long')
      // The request never produced a response, which is the one network failure that is always
      // safe to repeat: nothing was decided on the strength of it.
      throw new DecisionRetryableError('the decision service did not answer')
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

export type ResolvedComputerUseAcceleration = {
  route?: DecisionRouteId
  routeLabel: string
  providerId?: string
  providerName: string
  apiKey: string
  endpoint: string
  model: string
  minActionConfidence: number
  minReversibleConfidence: number
  minActionMargin: number
  minCompletionConfidence: number
  /** A completion claim at or above this is final on its own. */
  certainCompletionConfidence: number
  minAmbiguityConfidence: number
  maxMutationProbability: number
  maxSteps: number
  timeoutMs: number
}

/**
 * Acceleration resolves only when a compatible credential already exists.
 *
 * An absent provider, an empty key, and an explicit opt-out all produce
 * `undefined`, which means the fast tool is not registered at all — normal
 * Browser Use is the fallback and the source of truth.
 *
 * Credentials are taken in the order that costs the user least: an endpoint and
 * credential given for the decision layer itself, then the provider they named,
 * then the first configured provider that serves a decision service. A decision
 * service is not a chat provider, so naming one never adds it to the model
 * picker.
 */
export function resolveComputerUseAcceleration(
  settings: Pick<Settings, 'providers'> & { computerUseAcceleration?: Settings['computerUseAcceleration'] },
): ResolvedComputerUseAcceleration | undefined {
  const config = settings.computerUseAcceleration
  if (config?.enabled === false) return undefined

  const providers = (settings.providers || []).filter(provider => provider.enabled !== false)
  const named = String(config?.provider || config?.providerId || '').trim()
  const namedRoute = decisionRouteForId(named)
  const namedProvider = named && !namedRoute ? providers.find(provider => provider.id === named) : undefined
  const explicitEndpoint = String(config?.endpoint || '').trim()
  const explicitKey = String(config?.apiKey || '').trim()

  let route: DecisionRoute | undefined
  let endpoint = ''
  let apiKey = ''
  let providerId: string | undefined
  let providerName = ''

  if (explicitEndpoint && explicitKey) {
    // An endpoint and credential for the decision layer stand on their own; the
    // route only supplies the model id and the label.
    route = decisionRouteForEndpoint(explicitEndpoint)
    endpoint = route?.endpoint || explicitEndpoint
    apiKey = explicitKey
    providerName = route?.label || ''
  } else if (namedRoute && explicitKey) {
    route = namedRoute
    endpoint = explicitEndpoint || namedRoute.endpoint
    apiKey = explicitKey
    providerName = namedRoute.label
  } else if (namedProvider) {
    const providerRoute = decisionRouteForEndpoint(namedProvider.endpoint)
    // An unknown host is not resolved on a guess: Shun cannot know where that
    // service puts its decision endpoint unless the user says so.
    if (providerRoute || explicitEndpoint) {
      route = providerRoute
      endpoint = explicitEndpoint || providerRoute!.endpoint
      apiKey = String(namedProvider.apiKey || '').trim()
      providerId = namedProvider.id
      providerName = namedProvider.name
    }
  } else {
    const order = namedRoute ? [namedRoute.id] : decisionRouteOrder
    for (const routeId of order) {
      const candidate = decisionRoutes[routeId]
      const provider = providers.find(item => decisionRouteForEndpoint(item.endpoint)?.id === routeId && String(item.apiKey || '').trim())
      if (!provider) continue
      route = candidate
      endpoint = candidate.endpoint
      apiKey = String(provider.apiKey).trim()
      providerId = provider.id
      providerName = provider.name
      break
    }
  }

  if (!endpoint || !apiKey) return undefined
  const defaults = defaultComputerUseAcceleration
  const label = providerName || route?.label || 'Decision service'
  return {
    ...(route ? { route: route.id } : {}),
    routeLabel: label,
    ...(providerId ? { providerId } : {}),
    providerName: label,
    apiKey,
    endpoint,
    model: String(config?.model || '').trim() || route?.model || defaults.model,
    minActionConfidence: config?.minActionConfidence ?? defaults.minActionConfidence,
    minReversibleConfidence: config?.minReversibleConfidence ?? defaults.minReversibleConfidence,
    minActionMargin: config?.minActionMargin ?? defaults.minActionMargin,
    minCompletionConfidence: config?.minCompletionConfidence ?? defaults.minCompletionConfidence,
    certainCompletionConfidence: config?.certainCompletionConfidence ?? defaults.certainCompletionConfidence,
    minAmbiguityConfidence: config?.minAmbiguityConfidence ?? defaults.minAmbiguityConfidence,
    maxMutationProbability: config?.maxMutationProbability ?? defaults.maxMutationProbability,
    maxSteps: Math.max(1, Math.min(30, Math.floor(config?.maxSteps ?? defaults.maxSteps))),
    timeoutMs: Math.max(1_000, Math.min(120_000, Math.floor(config?.timeoutMs ?? defaults.timeoutMs))),
  }
}
