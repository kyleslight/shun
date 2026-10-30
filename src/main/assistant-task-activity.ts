import type { Task, ToolEvent, Turn } from '../shared.ts'

const preview = (text: string | undefined, limit: number) => text && text.length > limit
  ? { text: text.slice(0, limit / 2) + '\n…\n' + text.slice(-limit / 2), truncated: true, characters: text.length }
  : { text: text || '', truncated: false, characters: text?.length || 0 }
const iso = (time: number | undefined) => time ? new Date(time).toISOString() : undefined

/** Offsets count backwards from the newest records; each returned page is chronological. */
export function readAssistantTaskActivity(task: Task, running: boolean, options: { offset?: number; turnId?: string; toolOffset?: number } = {}) {
  const offset = options.offset || 0
  const end = Math.max(0, task.turns.length - offset)
  const start = Math.max(0, end - 5)
  const selected = options.turnId ? task.turns.filter(turn => turn.id === options.turnId) : task.turns.slice(start, end)
  if (options.turnId && !selected.length) throw Error('Turn not found.')
  return {
    id: task.id, title: task.title, workspace: task.workspace, running,
    updatedAt: task.updatedAt, updatedAtISO: iso(task.updatedAt),
    totalTurns: task.turns.length,
    nextOffset: !options.turnId && start > 0 ? offset + selected.length : undefined,
    turns: selected.map(turn => {
      const tools = new Map<string, ToolEvent>()
      for (const entry of turn.timeline || []) if (entry.type === 'tool') tools.set(entry.tool.id, entry.tool)
      for (const tool of turn.tools || []) tools.set(tool.id, tool)
      const all = [...tools.values()]
      const toolOffset = options.toolOffset || 0
      const toolEnd = Math.max(0, all.length - toolOffset)
      const toolStart = Math.max(0, toolEnd - 10)
      return {
        id: turn.id, role: turn.role, content: preview(turn.content, 6000),
        phase: turn.phase, error: turn.error,
        startedAtISO: iso(turn.startedAt), lastActivityAtISO: iso(turn.lastActivityAt), completedAtISO: iso(turn.completedAt),
        progress: turn.progress,
        totalTools: all.length,
        toolCounts: { running: all.filter(tool => tool.state === 'running').length, done: all.filter(tool => tool.state === 'done').length, error: all.filter(tool => tool.state === 'error').length },
        nextToolOffset: toolStart > 0 ? toolOffset + toolEnd - toolStart : undefined,
        tools: all.slice(toolStart, toolEnd).map(tool => ({
          id: tool.id, name: tool.name, state: tool.state,
          input: preview(tool.input, 1500), output: preview(tool.output, 3000),
          source: tool.source, attachments: tool.attachments, fanout: tool.fanout,
        })),
      }
    }),
  }
}

/** The event projection supplies current work even when no conversation view is mounted. */
export function withLiveTaskActivity(task: Task, live?: Turn): Task {
  if (!live) return task
  const index = task.turns.findIndex(turn => turn.id === live.id)
  const turns = [...task.turns]
  if (index < 0) turns.push(live)
  else turns[index] = live
  return { ...task, turns }
}
