import type { AttachmentRef, BackgroundTask, SkillState, Turn } from '../../shared'

export type ActiveRuns = Record<string, string>
export type QueuedPrompt = { id: string; taskId: string; text: string; attachments?: AttachmentRef[]; skill?: SkillState }
export type FeedScrollMode = 'follow-bottom' | 'free'

export function finishTaskRun(active: ActiveRuns, runId: string): ActiveRuns {
  const taskId = Object.entries(active).find(([, id]) => id === runId)?.[0]
  if (!taskId) return active
  const next = { ...active }
  delete next[taskId]
  return next
}

export function taskRunIsActive(active: ActiveRuns, taskId: string) {
  return Boolean(active[taskId])
}

export function taskHasActiveBackground(items: BackgroundTask[]) {
  return items.some(item => item.state === 'starting' || item.state === 'running' || item.state === 'stopping')
}

export function turnIsCompacting(turn: Turn) {
  if (turn.contextUsage) return turn.contextUsage.state === 'compacting'
  const latest = [...(turn.timeline || [])].reverse().find(entry => entry.type === 'context')
  return latest?.type === 'context' && latest.context.state === 'compacting'
}

export function settleTurnCompaction(turn: Turn): Turn {
  if (!turnIsCompacting(turn)) return turn
  const timeline = [...(turn.timeline || [])]
  const index = timeline.findLastIndex(entry => entry.type === 'context' && entry.context.state === 'compacting')
  const current = turn.contextUsage?.state === 'compacting'
    ? turn.contextUsage
    : index >= 0 && timeline[index].type === 'context'
      ? timeline[index].context
      : undefined
  if (!current) return turn
  const context = { ...current, state: 'compacted' as const }
  if (index >= 0) timeline[index] = { type: 'context', context }
  return { ...turn, contextUsage: context, timeline }
}

/**
 * A running turn needs an explicit model status when its latest visible action
 * has settled and no new text has started yet. Looking at all accumulated turn
 * text is incorrect because one turn may alternate text -> tool -> text many
 * times.
 */
export function turnAwaitsModelOutput(turn: Turn) {
  if (turnIsCompacting(turn)) return false
  const timeline = turn.timeline || []
  const runningTool = timeline.some(entry => entry.type === 'tool' && entry.tool.state === 'running')
    || (turn.tools || []).some(tool => tool.state === 'running')
  if (runningTool) return false

  for (let index = timeline.length - 1; index >= 0; index--) {
    const entry = timeline[index]
    if (entry.type === 'context') continue
    if (entry.type === 'tool') return entry.tool.state !== 'running'
    if (entry.type === 'text') return !entry.text.trim()
  }

  if ((turn.tools || []).length) return true
  return !turn.content.trim()
}

export function nextRunnablePrompt(queue: QueuedPrompt[], active: ActiveRuns) {
  return queue.find(item => !active[item.taskId])
}

export function visibleWorkspaceChangeCount(
  workspace: string | undefined,
  reviewedCount: number | undefined,
  fallbackCount: number,
) {
  return workspace ? (reviewedCount ?? fallbackCount) : 0
}

export function feedScrollModeAfterScroll(
  current: FeedScrollMode,
  programmatic: boolean,
): FeedScrollMode {
  if (programmatic) return current
  return 'free'
}

export function summarizedFailureCount(failures: number, total: number) {
  return failures > 0 && failures === total ? failures : 0
}

export function completedMermaidBlockCount(markdown: string) {
  let open: { marker: '`' | '~'; length: number; mermaid: boolean } | undefined
  let completed = 0

  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (!open) {
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (!fence) continue
      const marker = fence[1][0] as '`' | '~'
      const language = fence[2].trim().split(/\s+/, 1)[0]?.toLowerCase()
      open = { marker, length: fence[1].length, mermaid: language === 'mermaid' }
      continue
    }

    const indentation = line.match(/^ */)?.[0].length ?? 0
    const token = line.trim()
    const closesFence = indentation <= 3
      && token.length >= open.length
      && [...token].every(character => character === open?.marker)
    if (!closesFence) continue
    if (open.mermaid) completed += 1
    open = undefined
  }

  return completed
}
