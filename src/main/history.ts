type HistoryTool = { name?: string; input?: string; output?: string; state?: string }
type HistoryEntry = { type?: string; text?: string; tool?: HistoryTool }
type HistoryTurn = { role?: string; content?: string; timeline?: HistoryEntry[]; tools?: HistoryTool[] }

function searchableRows(turns: HistoryTurn[]) {
  const rows: Array<{ label: string; text: string }> = []
  turns.forEach((turn, turnIndex) => {
    if (turn.content?.trim()) rows.push({ label: `${turn.role || 'message'} turn ${turnIndex + 1}`, text: turn.content.trim() })
    const entries: HistoryEntry[] = turn.timeline?.length ? turn.timeline : (turn.tools || []).map(tool => ({ type: 'tool', tool }))
    entries.forEach((entry, entryIndex) => {
      if (entry.type === 'text' && entry.text?.trim()) rows.push({ label: `assistant note ${turnIndex + 1}.${entryIndex + 1}`, text: entry.text.trim() })
      if (entry.type === 'tool' && entry.tool) {
        const tool = entry.tool, text = [tool.input, tool.output].filter(Boolean).join('\n')
        if (text.trim()) rows.push({ label: `${tool.name || 'tool'} ${turnIndex + 1}.${entryIndex + 1}${tool.state ? ` (${tool.state})` : ''}`, text })
      }
    })
  })
  return rows
}

export function searchPersistedTask(state: unknown, taskId: string | undefined, query: string, limit = 8) {
  const tasks = Array.isArray((state as any)?.tasks) ? (state as any).tasks : []
  const task = tasks.find((item: any) => item?.id === taskId)
  if (!task) return 'No persisted history is available for this task.'
  const terms = query.toLowerCase().match(/[\p{L}\p{N}_.:/-]+/gu)?.filter(term => term.length > 1) || []
  if (!terms.length) return 'Provide a specific word, filename, URL, error, or decision to search for.'
  const hits = searchableRows(Array.isArray(task.turns) ? task.turns : []).map(row => {
    const lower = row.text.toLowerCase(), matched = terms.filter(term => lower.includes(term))
    return { ...row, score: matched.length * 10 + (lower.includes(query.toLowerCase()) ? 20 : 0), first: Math.min(...matched.map(term => lower.indexOf(term)).filter(index => index >= 0)) }
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.first - b.first).slice(0, Math.min(12, Math.max(1, limit)))
  if (!hits.length) return `No persisted task history matched: ${query}`
  return hits.map(hit => {
    const start = Math.max(0, Number.isFinite(hit.first) ? hit.first - 220 : 0), excerpt = hit.text.slice(start, start + 900)
    return `### ${hit.label}\n${start ? '…' : ''}${excerpt}${start + excerpt.length < hit.text.length ? '…' : ''}`
  }).join('\n\n').slice(0, 8_000)
}

export function searchPersistedEvents(events: unknown[], query: string, limit = 8) {
  const turns: HistoryTurn[] = events.map((event: any) => event?.type === 'request' || event?.type === 'assistant'
    ? { role: event.type === 'request' ? 'user' : 'assistant', content: String(event.text || '') }
    : event?.type === 'tool' && event.tool ? { role: 'assistant', tools: [event.tool] }
      : { role: 'assistant', content: String(event?.text || '') })
  const synthetic = { tasks: [{ id: 'event-log', turns }] }
  return searchPersistedTask(synthetic, 'event-log', query, limit)
}
