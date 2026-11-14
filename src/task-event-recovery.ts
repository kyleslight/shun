import type { AgentEvent, Task, TaskEventEnvelope, Turn } from './shared.ts'

export function applyProjectedAgentEvent(turn: Turn, event: AgentEvent, now = Date.now()): Turn {
  if (event.type === 'delta') {
    const text = event.text || '', timeline = [...(turn.timeline || [])], last = timeline.at(-1)
    if (last?.type === 'text') timeline[timeline.length - 1] = { type: 'text', text: last.text + text }
    else if (text) timeline.push({ type: 'text', text })
    return { ...turn, content: turn.content + text, timeline, lastActivityAt: now }
  }
  if (event.type === 'phase') return { ...turn, phase: event.text || 'Thinking', lastActivityAt: now }
  if (event.type === 'progress' && event.progress) return { ...turn, progress: event.progress, phase: event.progress.state === 'complete' ? '' : event.progress.stage, lastActivityAt: now }
  if (event.type === 'context' && event.context) {
    const context = event.context
    // Measurements update the meter, never the conversation timeline. A ready
    // reading also withdraws a cancelled attempt without erasing real summaries.
    const timeline = (turn.timeline || []).filter(item => item.type !== 'context' || item.context.state !== 'ready')
    const index = timeline.findLastIndex(item => item.type === 'context' && item.context.state === 'compacting')
    if (context.state === 'ready') {
      return { ...turn, contextUsage: context, timeline: timeline.filter(item => item.type !== 'context' || item.context.state !== 'compacting'), lastActivityAt: now }
    }
    const entry = { type: 'context' as const, context }
    if (index < 0) timeline.push(entry); else timeline[index] = entry
    return { ...turn, contextUsage: context, timeline, lastActivityAt: now }
  }
  if (event.type === 'tool' && event.tool) {
    const tools = [...(turn.tools || []).filter(item => item.id !== event.tool!.id), event.tool]
    const timeline = [...(turn.timeline || [])], index = timeline.findIndex(item => item.type === 'tool' && item.tool.id === event.tool!.id)
    const entry = { type: 'tool' as const, tool: event.tool }
    if (index < 0) timeline.push(entry); else timeline[index] = entry
    return { ...turn, tools, timeline, lastActivityAt: now, lastProgressAt: now }
  }
  if (event.type === 'error') {
    const text = `Error: ${event.text || 'The run failed.'}`
    return { ...turn, content: turn.content ? `${turn.content}\n\n${text}` : text, timeline: [...(turn.timeline || []), { type: 'text', text }], phase: '', error: true, completedAt: now, lastActivityAt: now }
  }
  if (event.type === 'done' || event.type === 'cancelled') return { ...turn, phase: '', progress: undefined, completedAt: now, lastActivityAt: now }
  return turn
}


export function recoverTaskEvents(task: Task, events: TaskEventEnvelope[], completedOnly = true): Task {
  const turns = new Map<string, Turn>()
  let previous = 0
  for (const envelope of events) {
    if (envelope.taskId !== task.id || envelope.seq !== previous + 1) break
    previous = envelope.seq
    const payload = envelope.payload
    if (payload.type === 'request') {
      turns.set(payload.runId, { id: payload.runId, role: 'assistant', content: '', phase: '', error: false, startedAt: envelope.at })
    } else if (payload.type === 'agent') {
      const turn = turns.get(payload.runId)
      if (turn) turns.set(payload.runId, applyProjectedAgentEvent(turn, payload.event, envelope.at))
    }
  }
  return { ...task, turns: task.turns.map(turn => {
    const recovered = turns.get(turn.id)
    return recovered && (!completedOnly || recovered.completedAt) ? { ...turn, ...recovered } : turn
  }) }
}

export async function readTaskEventHistory(taskId: string, read: (taskId: string, after: number) => Promise<TaskEventEnvelope[]>) {
  const events: TaskEventEnvelope[] = []
  let after = 0
  while (true) {
    const page = await read(taskId, after)
    if (!page.length) return events
    for (const event of page) {
      if (event.taskId !== taskId || event.seq !== after + 1) throw Error('Task event history is incomplete.')
      events.push(event)
      after = event.seq
    }
  }
}

/** Incremental product-view recovery. Raw stream events are discarded per page. */
export class TaskEventRecovery {
  private entries = new Map<string, { sequence: number; turns: Map<string, Turn>; pending?: Promise<void> }>()
  private read: (taskId: string, after: number) => Promise<TaskEventEnvelope[]>
  private latest: (taskId: string) => Promise<number>
  private capacity: number
  constructor(read: (taskId: string, after: number) => Promise<TaskEventEnvelope[]>, latest: (taskId: string) => Promise<number>, capacity = 4) {
    this.read = read; this.latest = latest; this.capacity = capacity
  }

  async recover(task: Task, completedOnly = true): Promise<{ task: Task; sequence: number }> {
    let entry = this.entries.get(task.id)
    if (!entry) {
      entry = { sequence: 0, turns: new Map() }
      this.entries.set(task.id, entry)
    }
    this.entries.delete(task.id)
    this.entries.set(task.id, entry)
    // Never evict an in-flight reader: a concurrent caller must join it.
    for (const [id, held] of this.entries) {
      if (this.entries.size <= this.capacity) break
      if (id !== task.id && !held.pending) this.entries.delete(id)
    }
    const held = entry
    if (!held.pending) {
      held.pending = (async () => {
        const end = await this.latest(task.id)
        if (end < held.sequence) { held.sequence = 0; held.turns.clear() }
        while (held.sequence < end) {
          const page = await this.read(task.id, held.sequence)
          if (!page.length) throw Error('Task event history is incomplete.')
          for (const envelope of page) {
            if (envelope.seq > end) break
            if (envelope.taskId !== task.id || envelope.seq !== held.sequence + 1) throw Error('Task event history is incomplete.')
            const payload = envelope.payload
            if (payload.type === 'request') held.turns.set(payload.runId, { id: payload.runId, role: 'assistant', content: '', phase: '', error: false, startedAt: envelope.at })
            else if (payload.type === 'agent') {
              const turn = held.turns.get(payload.runId)
              if (turn) held.turns.set(payload.runId, applyProjectedAgentEvent(turn, payload.event, envelope.at))
            }
            held.sequence = envelope.seq
          }
        }
      })().finally(() => { held.pending = undefined })
    }
    await held.pending
    return { sequence: held.sequence, task: { ...task, turns: task.turns.map(turn => {
      const recovered = held.turns.get(turn.id)
      return recovered && (!completedOnly || recovered.completedAt) ? { ...turn, ...recovered } : turn
    }) } }
  }
}
