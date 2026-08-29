import type { Task } from '../../shared';

export type RunningTasks = Record<string, string>;

export function sidebarTaskRecency(task: Task, runningTasks: RunningTasks) {
  const runId = runningTasks[task.id];
  if (!runId) return task.updatedAt;
  return task.turns.find((turn) => turn.id === runId)?.startedAt ?? task.updatedAt;
}

export function sortTasksForSidebar(tasks: Task[], runningTasks: RunningTasks) {
  return [...tasks].sort((left, right) =>
    sidebarTaskRecency(right, runningTasks) - sidebarTaskRecency(left, runningTasks)
      || right.createdAt - left.createdAt
      || left.id.localeCompare(right.id));
}
