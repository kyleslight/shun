import type { ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { withReasoningBudget } from './provider-reasoning.ts'
import { projectWebEvidence } from './web-context.ts'

type LookupCall = { tool: string; input: Record<string, unknown> }
type Options = {
  /** Explicitly registered with the web tools; never selected from question wording. */
  enabled: boolean
  resolveReasoningBudget?: (context: ExtensionContext) => Promise<'thinking_budget' | undefined>
}

const answerScope = `For an ordinary factual lookup or brief comparison:
- When the answer depends on external facts, first retrieve evidence for the complete requested outcome. Analyze the answer after retrieval. Do not spend the initial reasoning reconstructing missing specifications or estimating from memory before the first search.
- Give the answer in at most three short sentences with supporting source links, unless the user asks for detail. Include essential conditions and uncertainty within those sentences. Answer only the question asked; omit related prices, history, specifications, recommendations, tables and recaps.
- Plan the smallest complete evidence check. Start a comparison with one focused search containing both exact names and versions together. Prefer a shared measurement over separate product descriptions. Read supplied or already discovered source URLs directly.
- Successful pages in web_search are already fetched evidence. Use them when they answer the question. Retrieve again only for a specific missing fact or contradiction that could change the answer; do not add dimensions to the comparison or reopen a source merely to validate its citation.
- Name the measurement supporting a comparison and distinguish independent tests from vendor reports or aggregations. Size, positioning and release date do not establish superiority. Close scores alone do not establish statistical equivalence; do not invent error bars or a historical first from a current ranking. If comparable evidence is absent, state what the checked sources support and what remains undecided.
- Earlier assistant summaries are not verified sources. When original web text is archived, use web_history_read to check a needed detail or condition that is absent from retained fetched evidence.
- Preserve exact entities, versions, units and conditions. Free does not mean unlimited. An unspecified cap stays unspecified. Distinguish measured conditions from general limits and recommendations. Failed access or an old pending status does not establish current absence. Report bounded uncertainty instead of searching for universal proof.
Select fact_lookup for this scope; reserve deep_research for a requested detailed investigation or comprehensive report. Keep all required evidence checks even when the final answer is short.`


/**
 * Reading is an explicitly selected web-tool phase, not a second agent loop.
 * Native context remains intact. This extension supplies source attribution and,
 * only when the endpoint supports it, a small reasoning budget for that phase.
 */
export function createLookupDeliveryExtension(options: Options): ExtensionFactory {
  return api => {
    let active = false, firstUser = true, lookupPhase = false
    let batch = new Map<string, LookupCall>()
    let budget: Promise<'thinking_budget' | undefined> | undefined

    api.on('before_agent_start', (event, context) => {
      active = options.enabled
      firstUser = true
      lookupPhase = false
      batch = new Map()
      budget = undefined
      // Static product guidance belongs to the native instruction boundary.
      // User questions and retrieved text remain in their original message roles.
      if (active) return {systemPrompt: `${event.systemPrompt}\n\n${answerScope}`}
    })
    api.on('message_start', event => {
      if (!active || event.message.role !== 'user') return
      if (firstUser) { firstUser = false; return }
      // Steering changes the task. Do not apply a delivery decision from its old goal.
      active = false
      lookupPhase = false
      batch.clear()
    })
    api.on('tool_call', (event, context) => {
      if (!active) return
      lookupPhase = false
      const call = { tool: event.toolName, input: (event.input && typeof event.input === 'object' ? event.input : {}) as Record<string, unknown> }
      batch.set(event.toolCallId, call)
      if ((call.tool === 'web_search' || call.tool === 'web_read') && call.input.task_depth === 'fact_lookup') {
        budget ??= Promise.resolve().then(() => options.resolveReasoningBudget?.(context)).catch(() => undefined)
      }
    })
    api.on('context', async (event, context) => {
      if (!active) return
      if (batch.size) {
        // A mixed batch or an explicit investigation retains its usual reasoning.
        lookupPhase = [...batch.values()].every(call =>
          (call.tool === 'web_search' || call.tool === 'web_read') && call.input.task_depth === 'fact_lookup')
        batch.clear()
      }
      const projected = projectWebEvidence(event.messages)
      const projection = projected.some((message, index) => message !== event.messages[index]) ? { messages: projected } : undefined
      if (lookupPhase) budget ??= Promise.resolve().then(() => options.resolveReasoningBudget?.(context)).catch(() => undefined)
      if (context.signal?.aborted || !active) return
      // Keep the native tool-result boundary. A custom message becomes a user
      // turn at the provider boundary, which resets reasoning replay mid-lookup.
      // Scope is already in the static system prompt and the retrieval receipt.
      return projection
    })
    api.on('before_provider_request', async (event, context) => {
      if (!active || !lookupPhase || context.model?.api !== 'openai-completions') return
      const parameter = await budget
      if (context.signal?.aborted || !active || !lookupPhase) return
      const payload = withReasoningBudget(event.payload, parameter, 768)
      return payload
    })
    api.on('agent_end', () => {
      active = false
      lookupPhase = false
      batch.clear()
      budget = undefined
    })
  }
}
