import type { Task } from '../../shared'
import { applyHostEvent, type HostCall, type HostSnapshot, type HostTask } from '../../host/protocol.ts'

/** The service owns these conversations; the desktop only holds a live projection. */
export class HostConversations {
  readonly snapshots = new Map<string, HostSnapshot>()
  private call: HostCall
  constructor(call: HostCall) { this.call = call }
  async poll(): Promise<HostSnapshot[]> {
    const listed = await this.call('task.list', { localOnly: true }) as HostTask[]
    const ids = new Set(listed.map(task => task.id))
    for (const id of this.snapshots.keys()) if (!ids.has(id)) this.snapshots.delete(id)
    for (const task of listed) {
      const held = this.snapshots.get(task.id)
      if (!held) { this.snapshots.set(task.id, await this.call('task.snapshot', { taskId: task.id })); continue }
      const batch = await this.call('task.events', { taskId: task.id, after: held.sequence })
      if (!batch.events.length && held.activeRun === batch.activeRun && JSON.stringify(held.task) === JSON.stringify(batch.task)) continue
      const next = { ...held, task: batch.task, activeRun: batch.activeRun, turns: structuredClone(held.turns), trustRequired: batch.trustRequired }
      for (const event of batch.events) if (event.seq > next.sequence) { applyHostEvent(next.turns, event); next.sequence = event.seq }
      this.snapshots.set(task.id, next)
    }
    return [...this.snapshots.values()]
  }
}
export function mergeHostConversations(tasks: Task[], snapshots: HostSnapshot[]): Task[] {
  const ids = new Set(snapshots.map(item => item.task.id))
  const next = tasks.filter(task => task.conversationSource !== 'service' || ids.has(task.id))
  for (const snapshot of snapshots) {
    const index = next.findIndex(task => task.id === snapshot.task.id), previous = next[index]
    // An ID collision never silently changes the owner of a desktop conversation.
    if (previous && previous.conversationSource !== 'service') continue
    if (previous && previous.turns === snapshot.turns && previous.title === snapshot.task.title && previous.model === snapshot.task.model) continue
    const projected: Task = { ...previous, ...snapshot.task, conversationSource: 'service', turns: snapshot.turns }
    if (index < 0) next.push(projected); else next[index] = projected
  }
  return next.length === tasks.length && next.every((task, index) => task === tasks[index]) ? tasks : next
}
