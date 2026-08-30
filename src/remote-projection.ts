import type { AttachmentRef, RemoteQueueItem, RepositorySnapshot, RunProgress, Task, TaskEventEnvelope, TimelineEntry, ToolEvent, Turn } from './shared.ts'
import { isShellTool, productToolPresentation, shellCommand } from './tool-presentation.ts'

export function remoteTaskList(tasks: Task[], runningByTask: Record<string, string>) {
  return tasks.filter(task => !task.archivedAt).map(task => ({
    id: task.id,
    workspace: truncateRemoteText(task.workspace, 16 * 1024),
    ...(task.model ? { model: truncateRemoteText(task.model, 1024) } : {}),
    title: truncateRemoteText(task.title, 4 * 1024),
    status: taskStatus(task, runningByTask[task.id]),
    activeRunId: runningByTask[task.id],
    updatedAt: task.updatedAt,
    createdAt: task.createdAt,
  }))
}

const DEFAULT_REMOTE_TURN_PAGE_SIZE = 24
const MAX_REMOTE_TURN_PAGE_SIZE = 64
const MAX_REMOTE_PAGE_BYTES = 512 * 1024
const MAX_REMOTE_CONTENT_BYTES = 128 * 1024
const MAX_REMOTE_EVENT_TEXT_BYTES = 64 * 1024
const MAX_REMOTE_TOOL_OUTPUT_BYTES = 1024
const MAX_REMOTE_TIMELINE_ENTRIES = 128
const MAX_REMOTE_PROGRESS_STEPS = 64
const MAX_REMOTE_ATTACHMENTS = 16
const MAX_REMOTE_TOOL_ATTACHMENTS = 8
const MAX_REMOTE_QUEUE_ITEMS = 16
const MAX_REMOTE_QUEUE_ATTACHMENTS = 4
const REMOTE_TRUNCATION_MARKER = '\n\n… [truncated for remote display]'
const remoteTextEncoder = new TextEncoder()

type RemoteHistoryOptions = { turnLimit?: number }

export function remoteTaskSnapshot(task: Task, runningId?: string, latestSeq = 0, queue: RemoteQueueItem[] = [], approvals: Array<{ id: string; title: string; description?: string; risk?: string }> = [], options: RemoteHistoryOptions = {}) {
  const base = {
    taskId: task.id,
    latestSeq,
    status: taskStatus(task, runningId),
    progress: remoteProgress(task.turns.at(-1)),
    workspace: truncateRemoteText(task.workspace, 16 * 1024),
    ...(task.model ? { model: truncateRemoteText(task.model, 1024) } : {}),
    title: truncateRemoteText(task.title, 4 * 1024),
    queue: queue.slice(0, MAX_REMOTE_QUEUE_ITEMS).map(remoteQueueItem),
    approvals: approvals.slice(0, MAX_REMOTE_QUEUE_ITEMS).map(item => ({
      approvalId: item.id,
      title: truncateRemoteText(item.title, 4 * 1024),
      description: truncateRemoteText(item.description, 8 * 1024),
      risk: truncateRemoteText(item.risk, 8 * 1024),
      state: 'pending',
    })),
  }
  const page = remoteTurnPage(task, undefined, options.turnLimit, (turns, history) => ({ ...base, turns, history }))
  return { ...base, turns: page.turns, history: page.history }
}

export function remoteTaskHistory(task: Task, beforeTurnId: string, turnLimit?: number) {
  const page = remoteTurnPage(task, beforeTurnId, turnLimit)
  return {
    taskId: task.id,
    turns: page.turns,
    history: page.history,
  }
}

type ProjectedTurn = ReturnType<typeof remoteTurn>
type RemoteHistory = { hasMore: boolean; cursor: string | undefined }

function remoteTurnPage(task: Task, beforeTurnId?: string, requestedLimit?: number, container: (turns: ProjectedTurn[], history: RemoteHistory) => unknown = (turns, history) => ({ turns, history })) {
  const limit = Math.max(1, Math.min(MAX_REMOTE_TURN_PAGE_SIZE, Math.floor(requestedLimit || DEFAULT_REMOTE_TURN_PAGE_SIZE)))
  const requestedEnd = beforeTurnId ? task.turns.findIndex(turn => turn.id === beforeTurnId) : task.turns.length
  if (beforeTurnId && requestedEnd < 0) return { turns: [], history: { hasMore: false, cursor: undefined } }
  const end = requestedEnd
  let start = Math.max(0, end - limit)
  let turns = task.turns.slice(start, end).map(remoteTurn)
  const history = (): RemoteHistory => ({ hasMore: start > 0, cursor: turns[0]?.id })
  const withinBudget = () => remoteJsonBytes(container(turns, history())) <= MAX_REMOTE_PAGE_BYTES

  while (turns.length > 1 && !withinBudget()) {
    turns = turns.slice(1)
    start += 1
  }
  while (!withinBudget() && turns.some(turn => turn.timeline.length > 0)) {
    const target = turns.reduce((largest, turn, index) => turn.timeline.length > turns[largest].timeline.length ? index : largest, 0)
    const timeline = turns[target].timeline
    turns = turns.map((turn, index) => index === target ? { ...turn, timeline: timeline.slice(Math.max(1, Math.floor(timeline.length / 2))) } : turn)
  }
  if (!withinBudget()) {
    turns = turns.map(turn => ({
      ...turn,
      content: truncateRemoteText(turn.content, 8 * 1024),
      attachments: [],
      timeline: [],
      progress: {},
    }))
  }
  if (!withinBudget()) {
    turns = turns.map(turn => ({
      ...turn,
      content: truncateRemoteText(turn.content, 1024),
      attachments: [],
      timeline: [],
      progress: {},
      contextUsage: undefined,
      error: undefined,
    }))
  }
  return {
    turns,
    history: history(),
  }
}

export function remoteTaskEvent(envelope: TaskEventEnvelope) {
  const base = { seq: envelope.seq, taskId: envelope.taskId, timestamp: envelope.at }
  if (envelope.payload.type === 'remote') {
    const event = envelope.payload.event
    if (event.kind === 'queue.snapshot') return { ...base, type: 'queue.snapshot', payload: { items: event.items.slice(0, MAX_REMOTE_QUEUE_ITEMS).map(remoteQueueItem) } }
    if (event.kind === 'confirmation.request') return {
      ...base,
      type: 'approval.request',
      payload: {
        approvalId: event.id,
        title: truncateRemoteText(event.title, 4 * 1024),
        description: truncateRemoteText(event.description, 8 * 1024),
        risk: truncateRemoteText(event.risk, 8 * 1024),
      },
    }
    return { ...base, type: 'approval.resolved', payload: { approvalId: event.id, decision: event.decision } }
  }
  if (envelope.payload.type === 'request') return {
    ...base,
    type: 'run.started',
    payload: {
      runId: envelope.payload.runId,
      messageId: envelope.payload.messageId,
      text: truncateRemoteText(envelope.payload.text, MAX_REMOTE_CONTENT_BYTES),
      attachments: (envelope.payload.attachments || []).slice(0, MAX_REMOTE_ATTACHMENTS).map(remoteAttachment),
      startedAt: envelope.at,
    },
  }
  const { runId, event } = envelope.payload
  if (event.type === 'delta') return { ...base, type: 'turn.delta', payload: { turnId: runId, delta: truncateRemoteText(event.text || '', MAX_REMOTE_EVENT_TEXT_BYTES) } }
  if (event.type === 'phase') return {
    ...base,
    type: 'turn.patch',
    payload: { turnId: runId, patch: { phase: remotePhase(event.text) } },
  }
  if (event.type === 'progress' && event.progress) return {
    ...base,
    type: 'turn.patch',
    payload: {
      turnId: runId,
      patch: {
        phase: remoteProgressPhase(event.progress),
        progress: remoteRunProgress(event.progress, runId),
      },
    },
  }
  if (event.type === 'tool' && event.tool) return {
    ...base,
    type: 'turn.entry',
    payload: { turnId: runId, entry: { type: 'tool', id: event.tool.id, tool: remoteTool(event.tool) } },
  }
  if (event.type === 'context' && event.context) return {
    ...base,
    type: 'turn.entry',
    payload: {
      turnId: runId,
      entry: {
        type: 'context',
        id: `${runId}-context`,
        context: {
          used: event.context.usedTokens ?? event.context.usedCharacters,
          total: event.context.budgetTokens ?? event.context.budgetCharacters,
        },
      },
    },
  }
  if (event.type === 'title') return { ...base, type: 'task.patch', payload: { title: truncateRemoteText(event.text || '', 4 * 1024) } }
  if (event.type === 'error') return {
    ...base,
    type: 'run.finished',
    payload: { runId, status: 'error', error: truncateRemoteText(event.text || 'The run failed.', MAX_REMOTE_EVENT_TEXT_BYTES), completedAt: envelope.at },
  }
  if (event.type === 'done' || event.type === 'cancelled' || event.type === 'compacted') return {
    ...base,
    type: 'run.finished',
    payload: { runId, status: 'completed', completedAt: envelope.at },
  }
  return { ...base, type: 'invalidate', payload: {} }
}

export function remoteRepository(snapshot: RepositorySnapshot | null, workspace: string) {
  return {
    workspace,
    branch: snapshot?.head || '',
    entries: (snapshot?.files || []).map(file => ({
      path: file.path,
      kind: file.conflicted ? 'conflicted' : file.staged ? 'staged' : file.untracked ? 'untracked' : 'unstaged',
    })),
    clean: !snapshot?.files.length,
    other: null,
  }
}

export function remoteDiff(text: string) {
  const entries: Array<{ path: string; hunks: Array<{ header: string; lines: Array<{ text: string; type: 'context' | 'add' | 'remove' }> }> }> = []
  let entry: (typeof entries)[number] | undefined
  let hunk: (typeof entries)[number]['hunks'][number] | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const path = line.match(/ b\/(.+)$/)?.[1] || ''
      entry = { path, hunks: [] }
      entries.push(entry)
      hunk = undefined
    } else if (line.startsWith('+++ ') && entry && line !== '+++ /dev/null') {
      entry.path = line.slice(4).trim().replace(/^b\//, '')
    } else if (line.startsWith('@@') && entry) {
      hunk = { header: line, lines: [] }
      entry.hunks.push(hunk)
    } else if (hunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
      hunk.lines.push({ text: line.slice(1), type: line[0] === '+' ? 'add' : line[0] === '-' ? 'remove' : 'context' })
    }
  }
  return entries.filter(item => item.path)
}

function taskStatus(task: Task, runningId?: string) {
  if (runningId) return 'running'
  if (task.turns.at(-1)?.error) return 'error'
  return task.turns.length ? 'completed' : 'idle'
}

function remoteTurn(turn: Turn) {
  const sourceTimeline = turn.timeline || []
  const timelineStart = Math.max(0, sourceTimeline.length - MAX_REMOTE_TIMELINE_ENTRIES)
  const timeline = sourceTimeline.slice(timelineStart).map((entry, index) => remoteEntry(entry, turn, timelineStart + index))
  return {
    id: turn.id,
    role: turn.error ? 'error' : turn.role,
    content: truncateRemoteText(turn.content, MAX_REMOTE_CONTENT_BYTES),
    attachments: (turn.attachments || []).slice(0, MAX_REMOTE_ATTACHMENTS).map(remoteAttachment),
    timeline,
    progress: remoteProgress(turn),
    contextUsage: turn.contextUsage ? {
      used: turn.contextUsage.usedTokens ?? turn.contextUsage.usedCharacters,
      total: turn.contextUsage.budgetTokens ?? turn.contextUsage.budgetCharacters,
    } : undefined,
    error: turn.error,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    revisedFromId: turn.revisedFromId,
  }
}

function remoteEntry(entry: TimelineEntry, turn: Turn, index: number) {
  if (entry.type === 'text') return { type: 'text', id: `${turn.id}-text-${index}`, text: truncateRemoteText(entry.text, MAX_REMOTE_EVENT_TEXT_BYTES) }
  if (entry.type === 'context') return {
    type: 'context',
    id: `${turn.id}-context-${index}`,
    context: {
      used: entry.context.usedTokens ?? entry.context.usedCharacters,
      total: entry.context.budgetTokens ?? entry.context.budgetCharacters,
    },
  }
  return { type: 'tool', id: entry.tool.id, tool: remoteTool(entry.tool) }
}

function remoteTool(tool: ToolEvent) {
  const presentation = productToolPresentation(tool)
  const common = commonRemotePresentation(tool)
  const detail = common?.detail || presentation?.detail
  return {
    id: tool.id,
    name: truncateRemoteText(tool.name, 256),
    state: tool.state,
    presentation: {
      key: common?.key || `tool.${tool.name}`,
      args: common?.args || {},
      fallbackTitle: common?.title || presentation?.title || tool.name,
      fallbackDetail: detail,
      semanticIcon: semanticIcon(common ? tool.name : presentation?.kind || tool.name),
    },
    summary: detail,
    output: truncateRemoteText(tool.output, MAX_REMOTE_TOOL_OUTPUT_BYTES),
    attachments: (tool.attachments || []).slice(0, MAX_REMOTE_TOOL_ATTACHMENTS).map(remoteAttachment),
    startedAt: 0,
  }
}

function commonRemotePresentation(tool: ToolEvent) {
  const state = tool.state === 'running' ? 'running' : tool.state === 'error' ? 'error' : 'done'
  let input: Record<string, unknown> = {}
  try { input = JSON.parse(tool.input || '{}') } catch {}
  if (tool.name === 'web_read' || tool.name === 'web_search') {
    const rawTarget = String(tool.name === 'web_read' ? input.url || '' : input.query || '').trim()
    let target = rawTarget
    if (tool.name === 'web_read') {
      try { target = new URL(rawTarget).hostname.replace(/^www\./, '') } catch {}
    }
    const title = tool.name === 'web_read'
      ? state === 'running' ? 'Reading web page' : state === 'error' ? 'Web page read failed' : 'Read web page'
      : state === 'running' ? 'Searching web' : state === 'error' ? 'Web search failed' : 'Searched web'
    return { key: `tool.${tool.name}.${state}`, args: {}, title, detail: compactRemoteDetail(target) }
  }
  if (isShellTool(tool)) {
    const inspection = isShellInspection(tool)
    const verification = isVerificationRun(tool)
    const title = verification
      ? state === 'running' ? 'Verifying' : state === 'error' ? 'Verification failed' : 'Verification completed'
      : inspection
        ? state === 'running' ? 'Reading or searching code' : state === 'error' ? 'Read or search failed' : 'Completed read/search action'
        : state === 'running' ? 'Running command' : state === 'error' ? 'Command failed' : 'Command completed'
    return { key: `tool.${verification ? 'verification' : inspection ? 'inspection' : 'command'}.${state}`, args: {}, title, detail: compactRemoteDetail(shellCommand(tool)) }
  }
  if (tool.name === 'read' || tool.name === 'read_pdf') {
    const title = state === 'running' ? 'Reading file' : state === 'error' ? 'File read failed' : 'Read file'
    return { key: `tool.read.${state}`, args: {}, title, detail: compactRemoteDetail(input.path || input.file_path) }
  }
  if (tool.name === 'search') {
    const title = state === 'running' ? 'Searching code' : state === 'error' ? 'Code search failed' : 'Searched code'
    return { key: `tool.search.${state}`, args: {}, title, detail: compactRemoteDetail(input.query || input.pattern || input.path) }
  }
  if (tool.name === 'write' || tool.name === 'edit' || tool.name === 'edit_lines' || tool.name === 'replace_all') {
    const title = state === 'running' ? 'Changing file' : state === 'error' ? 'File change failed' : 'Changed file'
    return { key: `tool.change.${state}`, args: {}, title, detail: compactRemoteDetail(input.path || input.file_path) }
  }
  if (tool.name === 'attachment_read' || tool.name === 'attachment_view') {
    const title = state === 'running' ? 'Reading attachment' : state === 'error' ? 'Attachment read failed' : 'Read attachment'
    return { key: `tool.attachment.${state}`, args: {}, title, detail: compactRemoteDetail(input.name || input.attachment_id) }
  }
  return undefined
}

function isShellInspection(tool: ToolEvent) {
  return /^(?:sed\s+-n|grep\b|rg\b|cat\b|head\b|tail\b|ls\b|find\b|wc\b)/i.test(shellCommand(tool))
}

function isVerificationRun(tool: ToolEvent) {
  return /(?:^|&&|;)\s*(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|typecheck|build|lint))\b|(?:^|&&|;)\s*(?:npx\s+)?tsc\b|(?:^|&&|;)\s*node\s+--test\b|\b(?:vitest|jest|pytest)\b/i.test(shellCommand(tool))
}

function compactRemoteDetail(value: unknown) {
  const detail = String(value || '').replace(/\s+/g, ' ').trim()
  return detail.length > 320 ? `${detail.slice(0, 317)}…` : detail
}

function remoteJsonBytes(value: unknown) {
  return remoteTextEncoder.encode(JSON.stringify(value)).byteLength
}

function truncateRemoteText(value: string, maxBytes: number): string
function truncateRemoteText(value: string | undefined, maxBytes: number): string | undefined
function truncateRemoteText(value: string | undefined, maxBytes: number): string | undefined {
  if (value === undefined || remoteTextEncoder.encode(value).byteLength <= maxBytes) return value
  const markerBytes = remoteTextEncoder.encode(REMOTE_TRUNCATION_MARKER).byteLength
  return `${remoteUtf8Prefix(value, Math.max(0, maxBytes - markerBytes))}${REMOTE_TRUNCATION_MARKER}`
}

function remoteUtf8Prefix(value: string, maxBytes: number) {
  let low = 0, high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (remoteTextEncoder.encode(value.slice(0, middle)).byteLength <= maxBytes) low = middle
    else high = middle - 1
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1])) low -= 1
  return value.slice(0, low)
}

function semanticIcon(name: string) {
  if (name === 'render') return 'cloud'
  if (name === 'ios') return 'mobile'
  if (name === 'browser') return 'browser'
  if (name === 'bash' || name === 'run') return 'terminal'
  if (/web|search/.test(name)) return 'search'
  if (/edit|write|patch/.test(name)) return 'edit'
  if (/read|file/.test(name)) return 'file'
  return 'generic'
}

export function remoteAttachment(item: AttachmentRef) {
  return {
    id: item.id,
    kind: item.kind === 'unknown' ? 'media' : item.kind,
    name: truncateRemoteText(item.name, 512),
    mimeType: truncateRemoteText(item.mimeType, 256),
    sizeBytes: item.size,
    pageCount: item.capabilities.pages,
  }
}

function remoteQueueItem(item: RemoteQueueItem) {
  return { id: item.id, text: truncateRemoteText(item.text, 4 * 1024), attachments: (item.attachments || []).slice(0, MAX_REMOTE_QUEUE_ATTACHMENTS).map(remoteAttachment) }
}

function remoteProgress(turn?: Turn) {
  if (!turn?.progress) return {}
  return remoteRunProgress(turn.progress, turn.id)
}

function remoteRunProgress(progress: RunProgress, id: string) {
  return {
    label: truncateRemoteText(progress.message, 4 * 1024),
    steps: progress.steps.slice(-MAX_REMOTE_PROGRESS_STEPS).map((step, index) => ({ id: `${id}-step-${index}`, label: truncateRemoteText(step.label, 512), state: step.status === 'complete' ? 'done' : step.status })),
  }
}

function remotePhase(label = 'Working') {
  label = truncateRemoteText(label, 4 * 1024)
  const kind = /plan|think|research|inspect/i.test(label) ? 'planning' : /finish|final/i.test(label) ? 'finishing' : 'executing'
  return { kind, label }
}

function remoteProgressPhase(progress: RunProgress) {
  const kind = progress.state === 'complete'
    ? 'completed'
    : progress.stage === 'research' || progress.stage === 'inspection'
      ? 'planning'
      : progress.stage === 'finalizing'
        ? 'finishing'
        : 'executing'
  return { kind, label: progress.message }
}
