import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

/** Read the native session branch; no separate evidence store or transcript. */
export function createWebHistoryTool() {
  return defineTool({
    name: 'web_history_read', label: 'Read earlier web evidence',
    description: 'Read exact evidence previously fetched in this task, using an archived tool_call_id. Use for an earlier source detail absent from the visible conversation. This reads the original saved result, not today’s website. Offset and max_chars paginate the original result text.',
    parameters: Type.Object({
      tool_call_id: Type.String(),
      offset_chars: Type.Optional(Type.Integer({ minimum: 0 })),
      max_chars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 24000 })),
    }, { additionalProperties: false }),
    execute: async (_id, args, signal, _update, context) => {
      signal?.throwIfAborted()
      const entry = context.sessionManager.getBranch().find(entry => entry.type === 'message'
        && entry.message.role === 'toolResult' && entry.message.toolCallId === args.tool_call_id
        && ['web_search', 'web_read', 'web_history_read'].includes(entry.message.toolName))
      if (!entry || entry.type !== 'message' || entry.message.role !== 'toolResult') throw Error('That web evidence is not in this task’s current history.')
      const message = entry.message
      const original = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const offset = args.offset_chars ?? 0, end = Math.min(original.length, offset + (args.max_chars ?? 12000))
      return { content: [{ type: 'text', text: JSON.stringify({
        tool_call_id: message.toolCallId, original_tool: message.toolName, original_timestamp: message.timestamp,
        original_error: message.isError, content_offset: offset, content_end: end,
        total_characters: original.length, has_more: end < original.length, content: original.slice(offset, end),
      }) }], details: {} }
    },
  })
}
