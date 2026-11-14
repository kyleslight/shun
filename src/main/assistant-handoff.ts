import type { AgentRequest, Task } from '../shared.ts'

export function assistantHandoff(req: AgentRequest, parent: Task, interpretation: string, sourceMessageIds: string[] = [], includeCurrentMessage = true) {
  const selected = [...new Set(sourceMessageIds)].map(id => {
    const turn = parent.turns.find(turn => turn.id === id && turn.role === 'user')
    if (!turn) throw Error('Original user message not found in this conversation.')
    return turn
  }).sort((a, b) => parent.turns.indexOf(a) - parent.turns.indexOf(b))
  const originals = selected.filter(turn => !includeCurrentMessage || turn.id !== req.messageId).map(turn => ({ id: turn.id, text: turn.content, attachments: turn.attachments || [] }))
  if (includeCurrentMessage) originals.push({ id: req.messageId || req.id, text: req.text, attachments: req.attachments || [] })
  return {
    displayText: originals.length ? originals.map(message => message.text).join('\n\n') : interpretation,
    text: `Original user messages, in order (authoritative requirements; later corrections supersede earlier ones):\n${JSON.stringify(originals.map(({ id, text }) => ({ id, text })))}\n\nCoordinator's task brief (interpretation, not a replacement for the user's words):\n${interpretation}`,
    attachmentIds: [...new Set(originals.flatMap(message => message.attachments.map(item => item.id)))],
  }
}
