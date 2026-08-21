export type ActiveRuns = Record<string, string>
export type QueuedPrompt = { id: string; taskId: string; text: string }
export type FeedScrollMode = 'follow-bottom' | 'locked-turn' | 'free'

export function finishTaskRun(active: ActiveRuns, runId: string): ActiveRuns {
  const taskId = Object.entries(active).find(([, id]) => id === runId)?.[0]
  if (!taskId) return active
  const next = { ...active }
  delete next[taskId]
  return next
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
  atBottom: boolean,
  programmatic: boolean,
): FeedScrollMode {
  if (programmatic) return current
  return atBottom ? 'follow-bottom' : 'free'
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
