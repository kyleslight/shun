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
export type AssistantDelivery = { parentId: string; sourceId: string; id: string; title: string; text: string }
/** Deliver completed task evidence without claiming the parent's model session. */
export function deliverAssistantResults(state: SavedState): Array<{ parentId: string; id: string }> {
  const delivered: Array<{ parentId: string; id: string }> = []
  const zh = state.settings.language === 'zh-CN'
  for (const source of state.tasks) {
    if (!source.parentTaskId) continue
    for (const report of [...(source.assistantDeliveries || [])]) {
      const item = { parentId: source.parentTaskId, sourceId: source.id, id: report.id, title: source.title, text: report.text }
      if (!report.text.trim()) continue
      const timestamp = new Date(report.queuedAt).toLocaleString(zh ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      const heading = zh ? `子任务结果 · ${source.title}` : `Task result · ${source.title}`
      const text = `**${heading}** · ${timestamp}\n\n${report.text}`
      if (completeAssistantResult(state, item, text)) delivered.push({ parentId: item.parentId, id: item.id })
    }
  }
  return delivered
}
export function completeAssistantResult(state: SavedState, item: AssistantDelivery, text: string): boolean {
  if (!text.trim()) return false
  const parent = state.tasks.find(task => task.id === item.parentId)
  const source = state.tasks.find(task => task.id === item.sourceId && task.parentTaskId === item.parentId)
  if (!parent || !source?.assistantDeliveries?.some(pending => pending.id === item.id)) return false
  if (!parent.turns.some(turn => turn.id === item.id)) {
    parent.turns.push({ id: item.id, role: 'assistant', content: source.purpose === 'background' && source.scheduleId ? text.trim() : `${text.trim()}\n\n[View task](shun://task/${source.id})`, startedAt: Date.now(), completedAt: Date.now() })
    parent.updatedAt = Date.now()
  }
  source.assistantDeliveries = source.assistantDeliveries.filter(pending => pending.id !== item.id)
  return true
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
      assistantFollowUps: held.assistantFollowUps, assistantDeliveries: held.assistantDeliveries, turns: [...task.turns, ...updates] }
  })
  const ids = new Set(next.map(task => task.id))
  return [...next, ...stored.filter(task => (task.purpose || task.parentTaskId) && !ids.has(task.id))]
}
