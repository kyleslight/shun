import type { Task } from '../shared.ts'

export async function continueAssistantTask(
  tasks: Task[], parentId: string, input: { taskId: string; prompt: string; interrupt?: boolean },
  operations: { active: (taskId: string) => string | undefined; stop: (taskId: string, runId: string) => Promise<void>; run: (task: Task, prompt: string) => Promise<{ taskId: string; title: string }> },
) {
  const task = tasks.find(item => item.id === input.taskId && item.parentTaskId === parentId)
  if (!task || task.purpose === 'background') throw Error('Choose an existing delegated task from this assistant.')
  const active = operations.active(task.id)
  if (active) {
    if (!input.interrupt) throw Error('This task is running. Use interrupt=true to apply a correction to the current work.')
    await operations.stop(task.id, active)
  }
  return operations.run(task, input.prompt)
}
