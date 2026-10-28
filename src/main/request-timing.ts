import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

export type RequestTiming = {
  request: number
  startedAt: number
  elapsedMs: number
  firstDeltaMs?: number
  firstThinkingMs?: number
  firstTextMs?: number
  lastThinkingMs?: number
  lastTextMs?: number
  responseMs?: number
  inputCharacters: number
  sharedPrefixMessages?: number
  sharedPrefixCharacters?: number
  firstChangedRole?: string
  thinkingBudget?: number
  toolChoice?: 'auto' | 'none' | 'required'
  stopReason?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
}

/** Observe public request/stream events without recording prompts, credentials or reasoning text. */
export function createRequestTimingExtension(record: (timing: RequestTiming) => void, now = Date.now): ExtensionFactory {
  return api => {
    let sequence = 0, current: RequestTiming | undefined
    let previousMessages: string[] | undefined
    const finish = () => {
      if (!current) return
      const timing = { ...current, elapsedMs: now() - current.startedAt }
      current = undefined
      try { record(timing) } catch { /* Measurement must not interrupt a task. */ }
    }
    api.on('before_provider_request', event => {
      finish()
      const payload = event.payload as Record<string, unknown> | undefined
      const messages = Array.isArray(payload?.messages) ? payload.messages : undefined
      const serialized = messages?.map(message => JSON.stringify(message))
      let sharedPrefixMessages = 0, sharedPrefixCharacters = 0
      if (previousMessages && serialized) {
        while (sharedPrefixMessages < Math.min(previousMessages.length, serialized.length) && previousMessages[sharedPrefixMessages] === serialized[sharedPrefixMessages]) {
          sharedPrefixCharacters += serialized[sharedPrefixMessages].length
          sharedPrefixMessages++
        }
      }
      const prefix = previousMessages && serialized ? { sharedPrefixMessages, sharedPrefixCharacters, firstChangedRole: (messages?.[sharedPrefixMessages] as any)?.role } : {}
      previousMessages = serialized
      current = { ...prefix, request: ++sequence, startedAt: now(), elapsedMs: 0, inputCharacters: JSON.stringify(event.payload)?.length || 0,
        ...(typeof payload?.thinking_budget === 'number' ? { thinkingBudget: payload.thinking_budget } : {}),
        ...(['auto', 'none', 'required'].includes(String(payload?.tool_choice)) ? { toolChoice: payload!.tool_choice as 'auto' | 'none' | 'required' } : {}) }
    })
    api.on('after_provider_response', () => {
      if (current) current.responseMs = now() - current.startedAt
    })
    api.on('message_update', event => {
      if (!current) return
      const type = event.assistantMessageEvent.type
      if (type !== 'thinking_delta' && type !== 'text_delta' && type !== 'toolcall_delta') return
      const elapsed = now() - current.startedAt
      current.firstDeltaMs ??= elapsed
      if (type === 'thinking_delta') { current.firstThinkingMs ??= elapsed; current.lastThinkingMs = elapsed }
      if (type === 'text_delta') { current.firstTextMs ??= elapsed; current.lastTextMs = elapsed }
    })
    api.on('message_end', event => {
      if (!current || event.message.role !== 'assistant') return
      const message = event.message
      current.stopReason = message.stopReason
      current.inputTokens = message.usage.input
      current.outputTokens = message.usage.output
      current.cacheReadTokens = message.usage.cacheRead
      finish()
    })
    api.on('agent_end', () => { finish(); previousMessages = undefined })
  }
}
