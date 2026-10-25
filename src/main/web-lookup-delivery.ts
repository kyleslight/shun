import type { ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { readSources, type ReadSource } from './web-retrieval-profile.ts'
import { withReasoningBudget } from './provider-reasoning.ts'

type LookupCall = { tool: string; input: Record<string, unknown> }
type Options = {
  /** Explicitly registered with the web tools; never selected from question wording. */
  enabled: boolean
  resolveReasoningBudget?: (context: ExtensionContext) => Promise<'thinking_budget' | undefined>
}

const instruction = 'Product lookup guidance: answer ONLY the original question, briefly, with supporting read-source links. Omit unrequested prices, quotas, history and advice. Preserve entities, units and necessary conditions. Free addition establishes cost, not unlimited capacity. If the publisher documents conditions but no numeric cap, report that distinction; never infer unlimited or keep hunting for an assumed number. For a current announcement, check the publisher channel directly, then state what this check confirms or leaves unconfirmed; do not seek universal proof of absence. Retrieve only an unresolved requested fact, using discovered source links rather than guessing page paths; batch independent gaps. Keep supported facts settled. Failed access is not evidence about the subject. Factual evidence does not establish an action was completed. Final source check: report unlimited only when the source explicitly states no limit for that same attribute. Otherwise say the cap is not specified; do not paraphrase that as no limit. State each answer once and stop without a recap or optional note.'

const answerScope = 'When using web tools for fact_lookup, give one concise statement per requested fact, plus necessary conditions and read-source links. Do not append facts the user did not ask for, related fees or quotas, historical background, advice, a recap, or optional notes. If the publisher states conditions but no numeric cap, report not specified and stop; do not keep searching for an assumed number or infer unlimited.'

/**
 * Reading is an explicitly selected web-tool phase, not a second agent loop.
 * Native context remains intact. This extension supplies source attribution and,
 * only when the endpoint supports it, a small reasoning budget for that phase.
 */
export function createLookupDeliveryExtension(options: Options): ExtensionFactory {
  return api => {
    let active = false, firstUser = true, question = '', lookupPhase = false
    let calls = new Map<string, LookupCall>(), batch = new Map<string, LookupCall>()
    let budget: Promise<'thinking_budget' | undefined> | undefined

    api.on('before_agent_start', event => {
      active = options.enabled
      firstUser = true
      question = event.prompt
      lookupPhase = false
      calls = new Map()
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
      calls.clear()
      batch.clear()
    })
    api.on('tool_call', event => {
      if (!active) return
      lookupPhase = false
      const call = { tool: event.toolName, input: (event.input && typeof event.input === 'object' ? event.input : {}) as Record<string, unknown> }
      batch.set(event.toolCallId, call)
      if (event.toolName === 'web_search' || event.toolName === 'web_read') calls.set(event.toolCallId, call)
    })
    api.on('context', async (event, context) => {
      if (!active) return
      if (batch.size) {
        // A mixed batch or an explicit investigation retains its usual reasoning.
        lookupPhase = [...batch.values()].every(call =>
          (call.tool === 'web_search' || call.tool === 'web_read') && call.input.task_depth === 'fact_lookup')
        batch.clear()
      }
      if (!lookupPhase) return
      const sources = new Map<string, ReadSource>(), retrievals: unknown[] = [], present = new Set<string>()
      for (const message of event.messages) {
        if (message.role !== 'toolResult') continue
        present.add(message.toolCallId)
        const call = calls.get(message.toolCallId)
        if (!call) continue
        try {
          const receipt = JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
          const read = readSources(receipt)
          for (const source of read) sources.set(source.url, source)
          retrievals.push({ ...call, read_sources: read.map(source => source.url) })
        } catch {}
      }
      // Compaction owns history. Retain only identifiers still represented in its context.
      for (const id of calls.keys()) if (!present.has(id)) calls.delete(id)
      if (!retrievals.length) return
      budget ??= Promise.resolve().then(() => options.resolveReasoningBudget?.(context)).catch(() => undefined)
      await budget
      if (context.signal?.aborted || !active) return
      const guidance = {
        ...(question.length <= 1000 ? { original_question: question } : {}),
        read_sources: [...sources.values()], retrievals, instruction,
      }
      return { messages: [...event.messages, {
        role: 'custom' as const, customType: 'shun-lookup-guidance',
        content: JSON.stringify(guidance), display: false, timestamp: Date.now(),
      }] }
    })
    api.on('before_provider_request', async (event, context) => {
      if (!active || !lookupPhase || context.model?.api !== 'openai-completions') return
      const parameter = await budget
      const payload = withReasoningBudget(event.payload, parameter, 1024)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
      const request = payload as Record<string, unknown>
      if (!Array.isArray(request.messages)) return payload
      // Reinforce the static scope at delivery. Source text and the user's
      // question retain their existing roles and are never promoted here.
      return {...request,messages:[...request.messages,{role:'system',content:answerScope}]}
    })
    api.on('agent_end', () => {
      active = false
      lookupPhase = false
      calls.clear()
      batch.clear()
      budget = undefined
    })
  }
}
