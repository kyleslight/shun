import type { AgentMessage } from '@earendil-works/pi-agent-core'

/** Request-only projection; archived text remains exactly recoverable from the native transcript. */
export function projectWebEvidence(messages: AgentMessage[], options: { archiveCompleted?: boolean } = {}): AgentMessage[] {
  const lastUser = messages.findLastIndex(message => message.role === 'user')
  const previous = messages[lastUser - 1]
  const completed = previous?.role === 'assistant' && previous.stopReason === 'stop'
  const archiveBefore = options.archiveCompleted && completed ? lastUser : -1
  const completedWebReasoning = new Set<number>()
  if (archiveBefore > 0) {
    let start = 0
    for (let end = 0; end <= archiveBefore; end++) {
      if (end !== archiveBefore && messages[end].role !== 'user') continue
      const turn = messages.slice(start, end)
      const tools = turn.filter(message => message.role === 'toolResult')
      if (tools.length && tools.every(message => message.role === 'toolResult' && ['web_search', 'web_read', 'web_history_read'].includes(message.toolName))) {
        for (let i = start; i < end; i++) if (messages[i].role === 'assistant') completedWebReasoning.add(i)
      }
      start = end
    }
  }
  const passages = new Map<string, { tool_call_id: string; url: string }>()
  const retained = new Map<string, Array<{ tool_call_id: string; content: string; content_offset?: number }>>()
  const instructions = new Set<string>()
  return messages.map((message, index) => {
    // Completed web turns retain their visible answers and calls, not their
    // private scratch work. In-progress and mixed coding turns remain intact.
    if (message.role === 'assistant' && completedWebReasoning.has(index)) {
      const content = message.content.filter(block => block.type !== 'thinking')
      return content.length === message.content.length ? message : { ...message, content }
    }
    if (message.role !== 'toolResult' || !['web_search', 'web_read', 'web_history_read'].includes(message.toolName) || message.isError) return message
    let changed = false
    const content = message.content.map(block => {
      if (block.type !== 'text') return block
      try {
        const receipt = JSON.parse(block.text)
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return block
        if (index < archiveBefore && block.text.length > 4000) {
          const pages = Array.isArray(receipt.pages) ? receipt.pages : [receipt]
          const archived = {
            archived_web_evidence: true, tool_call_id: message.toolCallId, read_tool: 'web_history_read',
            original_characters: block.text.length, query: receipt.query, targets: receipt.targets,
            number_of_results: receipt.number_of_results,
            sources: pages.map((page: any) => ({
              url: page.final_url || page.url || page.requested_url, title: page.title,
              ok: page.ok, error: page.ok === false ? page.error : undefined,
            })).filter((page: any) => page.url),
            note: 'Earlier-turn retrieval is stored verbatim in this task’s native history. Read it for original passages, conditions, dates or search leads not present in the conversation. Source titles and earlier summaries are not substitutes for the original evidence.',
          }
          changed = true
          return { ...block, text: JSON.stringify(archived) }
        }
        // Transport diagnostics are still available in the original tool receipt.
        delete receipt.query_planning
        delete receipt.retrieval_timing
        // Ranking counters and transport timings are diagnostics, not source evidence.
        // Keep every lead, snippet, confidence label, fetched passage and source condition.
        if (Array.isArray(receipt.results)) for (const lead of receipt.results) {
          if (!lead || typeof lead !== 'object') continue
          delete lead.engine
          if (lead.match && typeof lead.match === 'object') {
            for (const key of ['exact_phrase_matches', 'title_exact_phrase_matches', 'matched_terms', 'term_coverage']) delete lead.match[key]
          }
        }
        if (Array.isArray(receipt.responses)) for (const response of receipt.responses) {
          if (!response || typeof response !== 'object') continue
          delete response.started_at
          delete response.finished_at
        }
        if (receipt.retrieval?.providers) delete receipt.retrieval.providers
        const instruction = receipt.retrieval_decision?.instruction
        if (typeof instruction === 'string') {
          if (instructions.has(instruction)) delete receipt.retrieval_decision.instruction
          else instructions.add(instruction)
        }
        const pages = Array.isArray(receipt.pages) ? receipt.pages : [receipt]
        for (const page of pages) {
          if (!page || page.ok !== true || typeof page.content !== 'string' || !page.content) continue
          const url = page.final_url || page.url || page.requested_url
          if (typeof url !== 'string' || !url) continue
          const key = JSON.stringify([url, page.content_offset, page.content])
          const previous = passages.get(key)
          // Do not make an ambiguous reference into another block of this same result.
          if (previous && previous.tool_call_id !== message.toolCallId) {
            delete page.content
            page.content_reference = { ...previous, note: 'Identical fetched text is retained in the earlier tool result. All metadata here describes this read.' }
          } else {
            // A smaller re-read can be entirely contained in an earlier larger window.
            // Compare exact text, not offsets alone: a publisher may have changed the page.
            const containing = page.content.length >= 512 ? retained.get(url)?.find(entry =>
              entry.tool_call_id !== message.toolCallId && entry.content.includes(page.content)) : undefined
            if (containing) {
              const start = containing.content.indexOf(page.content), end = start + page.content.length
              delete page.content
              page.content_reference = { tool_call_id: containing.tool_call_id, url,
                source_content_offset: containing.content_offset, text_start: start, text_end: end,
                note: 'This exact text is a substring of the earlier retained page content (zero-based, end-exclusive). All metadata here describes this read.' }
            } else {
              passages.set(key, { tool_call_id: message.toolCallId, url })
              const entries = retained.get(url) || []
              entries.push({ tool_call_id: message.toolCallId, content: page.content, content_offset: page.content_offset })
              retained.set(url, entries)
            }
          }
        }
        const text = JSON.stringify(receipt)
        if (text === block.text) return block
        changed = true
        return { ...block, text }
      } catch { return block }
    })
    return changed ? { ...message, content } : message
  })
}
