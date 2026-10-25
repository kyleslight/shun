import type { Task } from './shared.ts'

/** Conversation activity excludes settings, renames, and archive timestamps. */
export function conversationActivity(task: Pick<Task, 'turns' | 'createdAt'>): number {
  return task.turns.reduce((latest, turn) => Math.max(latest, turn.startedAt || 0, turn.lastActivityAt || 0, turn.completedAt || 0), task.createdAt)
}

export function recentConversations<T extends { archivedAt?: number; lastActivityAt?: number; updatedAt: number; createdAt?: number; id: string }>(tasks: T[]): T[] {
  return tasks.filter(task => !task.archivedAt).sort((a, b) =>
    (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt) || (b.createdAt || 0) - (a.createdAt || 0) || a.id.localeCompare(b.id))
}
