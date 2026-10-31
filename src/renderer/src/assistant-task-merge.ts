import type { Task } from '../../shared.ts'

/** Disk snapshots can arrive behind the renderer's live stream. Merge by turn,
 * preserving newer activity and turns the snapshot has not saved yet. */
export function mergeAssistantTask(current: Task | undefined, incoming: Task): Task {
  if (!current) return incoming
  const held = new Map(current.turns.map(turn => [turn.id, turn]))
  const ids = new Set(incoming.turns.map(turn => turn.id))
  const turns = incoming.turns.map(turn => {
    const live = held.get(turn.id)
    if (!live) return turn
    const liveAt = live.lastActivityAt || live.completedAt || live.startedAt || 0
    const savedAt = turn.lastActivityAt || turn.completedAt || turn.startedAt || 0
    return liveAt >= savedAt ? live : turn
  })
  turns.push(...current.turns.filter(turn => !ids.has(turn.id)))
  return { ...current, ...incoming, turns, updatedAt: Math.max(current.updatedAt, incoming.updatedAt), draft: current.draft, attachments: current.attachments }
}
