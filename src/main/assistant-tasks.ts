import { createHash } from 'node:crypto'
import type { SavedState, Task } from '../shared.ts'

export const ASSISTANT_TASK_ID = 'shun-personal-assistant'
export function ensureAssistant(state: SavedState): Task {
  let task = state.tasks.find(item => item.id === ASSISTANT_TASK_ID)
  if (!task) {
    task = { id: ASSISTANT_TASK_ID, purpose: 'assistant', title: 'Shun', workspace: '', turns: [], awaitingFirstRemoteMessage: true, createdAt: Date.now(), updatedAt: Date.now() }
    state.tasks.unshift(task)
  }
  task.archivedAt = undefined
  return task
}
export function queueAssistantResult(state: SavedState, taskId: string, text: string, key: string) {
  const task = state.tasks.find(item => item.id === taskId)
  if (!task?.parentTaskId) throw Error('This task is not attached to an assistant.')
  const id = 'update-' + createHash('sha256').update(`${task.parentTaskId}:${task.scheduleId || task.id}:${key}`).digest('hex').slice(0, 24)
  const parent = state.tasks.find(item => item.id === task.parentTaskId)
  if (!parent) throw Error('Assistant conversation not found.')
  if (parent.turns.some(turn => turn.id === id) || state.tasks.some(item => item.assistantDeliveries?.some(delivery => delivery.id === id))) return { queued: false, duplicate: true }
  task.assistantDeliveries = [...(task.assistantDeliveries || []), { id, text, queuedAt: Date.now() }]
  return { queued: true, duplicate: false }
}
export function deliverAssistantResults(state: SavedState, busy: (id: string) => boolean): Array<{ taskId: string; runId: string }> {
  const delivered: Array<{ taskId: string; runId: string }> = []
  for (const source of state.tasks.filter(task => task.assistantDeliveries?.length)) {
    const parent = state.tasks.find(task => task.id === source.parentTaskId)
    if (!parent || busy(parent.id) || busy(source.id)) continue
    for (const item of source.assistantDeliveries!) {
      if (parent.turns.some(turn => turn.id === item.id)) continue
      parent.turns.push({ id: item.id, role: 'assistant', content: `${item.text}\n\n[View task](shun://task/${source.id})`, startedAt: item.queuedAt, completedAt: Date.now() })
      parent.updatedAt = Date.now()
      delivered.push({ taskId: parent.id, runId: item.id })
    }
    source.assistantDeliveries = []
  }
  return delivered
}

/** Window saves cannot discard work created or delivered by the session service. */
export function mergeAssistantTasks(stored: Task[], incoming: Task[]): Task[] {
  const existing = new Map(stored.map(task => [task.id, task]))
  const next = incoming.map(task => {
    const held = existing.get(task.id)
    if (!held || (!held.purpose && !held.parentTaskId)) return task
    const ids = new Set(task.turns.map(turn => turn.id))
    const updates = held.turns.filter(turn => turn.id.startsWith('update-') && !ids.has(turn.id))
    return { ...task, purpose: held.purpose, parentTaskId: held.parentTaskId, scheduleId: held.scheduleId,
      assistantDeliveries: held.assistantDeliveries, turns: [...task.turns, ...updates] }
  })
  const ids = new Set(next.map(task => task.id))
  return [...next, ...stored.filter(task => (task.purpose || task.parentTaskId) && !ids.has(task.id))]
}
