import type { AgentRunState, AttachmentRef, BackgroundTask, SkillState, ToolEvent, Turn } from '../../shared'

export type ActiveRuns = Record<string, string>
export type QueuedPrompt = { id: string; taskId: string; text: string; attachments?: AttachmentRef[]; skill?: SkillState }
export type FeedScrollMode = 'follow-bottom' | 'follow-stream' | 'free'

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

export function applyAgentRunState(active: ActiveRuns, state: AgentRunState): ActiveRuns {
  if (state.active) {
    if (active[state.taskId] === state.runId) return active
    return { ...active, [state.taskId]: state.runId }
  }
  if (active[state.taskId] !== state.runId) return active
  const next = { ...active }
  delete next[state.taskId]
  return next
}

export function taskHasActiveBackground(items: BackgroundTask[]) {
  return items.some(item => item.state === 'starting' || item.state === 'running' || item.state === 'stopping')
}

export function normalizeRestoredTurn(turn: Turn): Turn {
  const obsoleteHarnessText = [
    /(?:\n\n)?Error: Stopped by user\./g,
    /(?:\n\n)?上一步失败；诊断已保留，正在选择不同的恢复动作。/g,
    /(?:\n\n)?The previous step failed; preserving its diagnostic and choosing a different recovery action\./g,
    /(?:\n\n)?Error: 模型反复提出已被阻止的检查动作[^\n]*/g,
    /(?:\n\n)?Error: 验证未通过，随后根据诊断执行的具体修复也未成功[^\n]*/g,
  ]
  const clean = (value: string) => obsoleteHarnessText.reduce((text, pattern) => text.replace(pattern, ''), value).trim()
  const content = clean(turn.content)
  const timeline = turn.timeline
    ?.map(entry => entry.type === 'text' ? { ...entry, text: clean(entry.text) } : entry)
    .filter(entry => entry.type !== 'text' || entry.text)
  const normalizeTool = (tool: ToolEvent) =>
    tool.state === 'error' && (tool.name === 'read' || tool.name === 'edit' || tool.name === 'edit_lines' || tool.name === 'replace_all')
      ? { ...tool, state: 'done' as const, output: `Recovery handled: ${tool.output || 'source state changed'}` }
      : tool
  const restoredTools = turn.tools?.map(normalizeTool)
  const restoredTimeline = timeline?.map(entry => entry.type === 'tool' ? { ...entry, tool: normalizeTool(entry.tool) } : entry)
  if (content !== turn.content) return {
    ...turn,
    content,
    tools: restoredTools,
    timeline: restoredTimeline,
    phase: '',
    progress: undefined,
    error: false,
  }
  const restored = { ...turn, tools: restoredTools, timeline: restoredTimeline }
  if (!turn.phase) return restored
  const completedAt = turn.completedAt || turn.lastActivityAt || turn.startedAt || Date.now()
  return {
    ...restored,
    phase: '',
    completedAt,
    ...(!turn.content && turn.role === 'assistant' ? { content: 'Run interrupted.', error: true } : {}),
  }
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

const skillCatalogMutationTools = new Set(['skill_create', 'skill_update', 'skill_install', 'skill_remove'])

export function toolChangesSkillCatalog(tool: Pick<ToolEvent, 'name' | 'state'> | undefined) {
  return tool?.state === 'done' && skillCatalogMutationTools.has(tool.name)
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
  {
    programmatic,
    direction,
    nearEnd,
    streaming,
  }: {
    programmatic: boolean
    direction: 'backward' | 'forward' | 'none'
    nearEnd: boolean
    streaming: boolean
  },
): FeedScrollMode {
  if (programmatic || direction === 'none') return current
  if (direction === 'backward') return 'free'
  if (nearEnd) return streaming ? 'follow-stream' : 'follow-bottom'
  return current
}

export function feedIsNearEnd({
  scrollTop,
  scrollHeight,
  clientHeight,
  threshold,
}: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  threshold: number
}) {
  return scrollHeight - clientHeight - scrollTop <= threshold
}

export function streamedFeedIsCaughtUp({
  latestBottom,
  composerTop,
  revealGap,
  threshold,
}: {
  latestBottom: number
  composerTop: number
  revealGap: number
  threshold: number
}) {
  return latestBottom + revealGap <= composerTop + threshold
}

export function streamedFeedScrollTop({
  scrollTop,
  latestBottom,
  composerTop,
  revealGap,
  maxScrollTop,
}: {
  scrollTop: number
  latestBottom: number
  composerTop: number
  revealGap: number
  maxScrollTop: number
}) {
  const obscured = latestBottom + revealGap - composerTop
  if (obscured <= 0) return scrollTop
  return Math.min(maxScrollTop, Math.max(0, scrollTop + obscured))
}

export function runningTurnAnchorId(turns: Turn[], activeRunId: string) {
  const runIndex = turns.findIndex(turn => turn.id === activeRunId)
  if (runIndex < 0) return activeRunId
  for (let index = runIndex - 1; index >= 0; index--)
    if (turns[index].role === 'user') return turns[index].id
  return activeRunId
}

export function summarizedFailureCount(failures: number, total: number) {
  return failures > 0 && failures === total ? failures : 0
}

function withoutWorkspacePrefix(value: string, workspace: string) {
  const roots = [...new Set([
    workspace.trim().replace(/[\\/]+$/, ''),
    workspace.trim().replace(/\\/g, '/').replace(/\/+$/, ''),
  ].filter(Boolean))]
  let result = value
  for (const root of roots) result = result.split(root).join('.')
  return result
}

export function compactActivityTarget(value: string, workspace: string, limit = 64) {
  try { return new URL(value).hostname.replace(/^www\./, '') } catch {}
  let compact = withoutWorkspacePrefix(value, workspace).replace(/^(?:\.\/)+/, '').replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  const pathLike = !/[;&|<>\n]/.test(compact) && /^[\w@.+~/-]+$/.test(compact)
  if (pathLike && compact.length > limit) {
    const parts = compact.split('/').filter(Boolean)
    const tail = parts.slice(-3).join('/')
    compact = tail.length < compact.length ? `…/${tail}` : compact
  }
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact
}

export function compactShellActivity(command: string, workspace: string) {
  let compact = withoutWorkspacePrefix(command, workspace)
    .replace(/\r\n/g, '\n')
    .replace(/^\s*(?:set -o pipefail\s*;?\s*)?cd\s+(?:"\."|'\.'|\.)\s*&&\s*/i, '')
    .replace(/(^|\s)(?:\.\/)?(?:\.venv|venv)\/(?:bin|Scripts)\//g, '$1')
  const segments = compact.split(/\s*(?:&&|;|\n)\s*/).map(item => item.trim()).filter(Boolean)
  const useful = segments.filter(item => !/^(?:cd|rm|echo|printf|set|export|EOF\b|PY\b)/i.test(item))
  const verification = useful.find(item => /^(?:(?:python\d*)\s+-m\s+pytest\b|pytest\b|(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|typecheck|build|lint))\b|(?:npx\s+)?tsc\b|node\s+--test\b)/i.test(item))
  const execution = [...useful].reverse().find(item => /^(?:node|python\d*|npm|pnpm|yarn|git|make|cargo|go)\b/i.test(item))
  compact = verification || execution || useful[0] || segments[0] || compact
  compact = compact
    .replace(/^python\d*\s+-m\s+pytest\b/i, 'pytest')
    .replace(/\s+(?:2>&1\s*)?\|\s*(?:tail|head)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (/^node(?:\s+--[\w-]+(?:=\S+)?)?\s+-e\b/i.test(compact)) return ''
  if (/^python\d*\s+(?:-c\b|-?\s*<<)/i.test(compact)) return ''
  return compactActivityTarget(compact, '', 76)
}

export function latestActivityDetail(targets: string[], total: number, language: 'en' | 'zh', omitLatest = false) {
  const normalized = targets.map(target => target.trim()).filter(Boolean)
  const meaningful = normalized.filter(target => target !== '.')
  const latest = (meaningful.length ? meaningful : normalized).at(-1) || ''
  const hidden = Math.max(0, total - 1)
  const more = hidden ? language === 'zh' ? `+${hidden} 项` : `+${hidden} more` : ''
  return [omitLatest ? '' : latest, more].filter(Boolean).join(' ')
}

export function verificationActivityResult(outputs: string[], language: 'en' | 'zh') {
  const text = [...outputs].reverse().find(Boolean) || ''
  const pytest = text.match(/(\d+\s+passed)(?:,\s*(\d+\s+(?:failed|skipped|xfailed|xpassed|warnings?)))?/i)
  if (pytest) return [pytest[1], pytest[2]].filter(Boolean).join(' · ')
  const specs = text.match(/(\d+\s+specs?),\s*(\d+\s+failures?)/i)
  if (specs) return `${specs[1]} · ${specs[2]}`
  const unittest = text.match(/Ran\s+(\d+)\s+tests?[\s\S]{0,240}\bOK\b/i)
  if (unittest) return language === 'zh' ? `${unittest[1]} 项测试通过` : `${unittest[1]} tests passed`
  if (/✓ built in|built in \d|build (?:completed|succeeded)/i.test(text)) return language === 'zh' ? '构建通过' : 'Build passed'
  if (/Found 0 errors|typecheck(?:ing)? (?:passed|completed)/i.test(text)) return language === 'zh' ? '类型检查通过' : 'Typecheck passed'
  return ''
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

/**
 * Reveal small streamed deltas one character at a time while allowing a large
 * provider chunk to catch up quickly enough that rendering never trails the
 * actual response by more than a brief moment.
 */
export function nextStreamingText(visible: string, target: string) {
  if (visible === target) return visible
  if (!target.startsWith(visible)) return target

  const remaining = Array.from(target.slice(visible.length))
  const count = remaining.length <= 12
    ? 1
    : remaining.length <= 48
      ? 2
      : remaining.length <= 160
        ? 4
        : Math.min(96, Math.ceil(remaining.length / 24))
  return visible + remaining.slice(0, count).join('')
}
