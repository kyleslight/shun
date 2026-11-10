import type { Task } from '../shared.ts'

export async function continueAssistantTask(
  tasks: Task[], parentId: string, input: { taskId: string; prompt: string; interrupt?: boolean },
  operations: { active: (taskId: string) => string | undefined; enqueue: (task: Task, prompt: string) => Promise<void>; stop: (taskId: string, runId: string) => Promise<void>; run: (task: Task, prompt: string) => Promise<{ taskId: string; title: string }> },
) {
  const task = tasks.find(item => item.id === input.taskId && item.parentTaskId === parentId)
  if (!task || task.purpose === 'background') throw Error('Choose an existing delegated task from this assistant.')
  // Persist before waiting for cancellation so a restart cannot lose the correction.
  await operations.enqueue(task, input.prompt)
  const active = operations.active(task.id)
  if (active) {
    if (input.interrupt === false) {
      return { taskId: task.id, title: task.title, queued: true, delivery: 'queued' as const, applied: false }
    }
    await operations.stop(task.id, active)
  }
  return { ...await operations.run(task, input.prompt), queued: false, delivery: 'started' as const, applied: false }
}

/** Serialize delivery to one child without blocking other tasks. */
export class AssistantTaskDeliveryQueue {
  private pending = new Map<string, Promise<unknown>>()
  deliver<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(taskId) || Promise.resolve()).catch(() => {}).then(work)
    this.pending.set(taskId, next)
    void next.finally(() => { if (this.pending.get(taskId) === next) this.pending.delete(taskId) }).catch(() => {})
    return next
  }
}
