import type { ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { readSources, type ReadSource } from './web-retrieval-profile.ts'
import { withReasoningBudget } from './provider-reasoning.ts'

type LookupCall = { tool: string; input: Record<string, unknown> }
type Options = {
  /** Explicitly registered with the web tools; never selected from question wording. */
  enabled: boolean
  resolveReasoningBudget?: (context: ExtensionContext) => Promise<'thinking_budget' | undefined>
}

const instruction = 'This is product lookup guidance, not a new user request. Answer exactly the original current user question using fetched content already in this conversation. Cite a successfully read page only when its content supports the claim; search results and links inside a page are not themselves fetched evidence. Keep entities, attributes, versions, units and necessary conditions distinct. Do not add or research optional prices, features, quotas, history or advice. Once the requested answer is supported, give it now. A source that defines conditions but does not establish a numeric cap does not prove a guessed cap or unlimited usage: state the documented conditions and the specific remaining uncertainty. An old pending status does not establish current absence of an announcement: make a meaningful current publisher-channel check, then report precisely what could not be confirmed instead of seeking universal proof of absence. If a requested fact is missing or contradicted, retrieve only that fact, batching independent gaps; keep supported facts settled. A source access failure says nothing about the subject itself. Unrelated factual evidence cannot establish that a requested action is complete.'

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
      return withReasoningBudget(event.payload, parameter, 256)
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
