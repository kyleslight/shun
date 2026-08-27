import type { AttachmentRef, RemoteQueueItem, RepositorySnapshot, RunProgress, Task, TaskEventEnvelope, TimelineEntry, ToolEvent, Turn } from './shared.ts'
import { isShellTool, productToolPresentation, shellCommand } from './tool-presentation.ts'

export function remoteTaskList(tasks: Task[], runningByTask: Record<string, string>) {
  return tasks.filter(task => !task.archivedAt).map(task => ({
    id: task.id,
    workspace: task.workspace,
    ...(task.model ? { model: task.model } : {}),
    title: task.title,
    status: taskStatus(task, runningByTask[task.id]),
    activeRunId: runningByTask[task.id],
    updatedAt: task.updatedAt,
    createdAt: task.createdAt,
  }))
}

const DEFAULT_REMOTE_TURN_PAGE_SIZE = 24
const MAX_REMOTE_TURN_PAGE_SIZE = 64

type RemoteHistoryOptions = { turnLimit?: number }

export function remoteTaskSnapshot(task: Task, runningId?: string, latestSeq = 0, queue: RemoteQueueItem[] = [], approvals: Array<{ id: string; title: string; description?: string; risk?: string }> = [], options: RemoteHistoryOptions = {}) {
  const page = remoteTurnPage(task, undefined, options.turnLimit)
  return {
    taskId: task.id,
    latestSeq,
    status: taskStatus(task, runningId),
    turns: page.turns,
    progress: remoteProgress(task.turns.at(-1)),
    workspace: task.workspace,
    ...(task.model ? { model: task.model } : {}),
    title: task.title,
    queue: queue.map(remoteQueueItem),
    approvals: approvals.map(item => ({ approvalId: item.id, title: item.title, description: item.description, risk: item.risk, state: 'pending' })),
    history: page.history,
  }
}

export function remoteTaskHistory(task: Task, beforeTurnId: string, turnLimit?: number) {
  const page = remoteTurnPage(task, beforeTurnId, turnLimit)
  return {
    taskId: task.id,
    turns: page.turns,
    history: page.history,
  }
}

function remoteTurnPage(task: Task, beforeTurnId?: string, requestedLimit?: number) {
  const limit = Math.max(1, Math.min(MAX_REMOTE_TURN_PAGE_SIZE, Math.floor(requestedLimit || DEFAULT_REMOTE_TURN_PAGE_SIZE)))
  const requestedEnd = beforeTurnId ? task.turns.findIndex(turn => turn.id === beforeTurnId) : task.turns.length
  if (beforeTurnId && requestedEnd < 0) return { turns: [], history: { hasMore: false, cursor: undefined } }
  const end = requestedEnd
  const start = Math.max(0, end - limit)
  const turns = task.turns.slice(start, end).map(remoteTurn)
  return {
    turns,
    history: {
      hasMore: start > 0,
      cursor: turns[0]?.id,
    },
  }
}

export function remoteTaskEvent(envelope: TaskEventEnvelope) {
  const base = { seq: envelope.seq, taskId: envelope.taskId, timestamp: envelope.at }
  if (envelope.payload.type === 'remote') {
    const event = envelope.payload.event
    if (event.kind === 'queue.snapshot') return { ...base, type: 'queue.snapshot', payload: { items: event.items.map(remoteQueueItem) } }
    if (event.kind === 'confirmation.request') return { ...base, type: 'approval.request', payload: { approvalId: event.id, title: event.title, description: event.description, risk: event.risk } }
    return { ...base, type: 'approval.resolved', payload: { approvalId: event.id, decision: event.decision } }
  }
  if (envelope.payload.type === 'request') return {
    ...base,
    type: 'run.started',
    payload: {
      runId: envelope.payload.runId,
      messageId: envelope.payload.messageId,
      text: envelope.payload.text,
      attachments: (envelope.payload.attachments || []).map(remoteAttachment),
      startedAt: envelope.at,
    },
  }
  const { runId, event } = envelope.payload
  if (event.type === 'delta') return { ...base, type: 'turn.delta', payload: { turnId: runId, delta: event.text || '' } }
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
  if (event.type === 'title') return { ...base, type: 'task.patch', payload: { title: event.text || '' } }
  if (event.type === 'error') return {
    ...base,
    type: 'run.finished',
    payload: { runId, status: 'error', error: event.text || 'The run failed.', completedAt: envelope.at },
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
  const timeline = (turn.timeline || []).map((entry, index) => remoteEntry(entry, turn, index))
  return {
    id: turn.id,
    role: turn.error ? 'error' : turn.role,
    content: turn.content,
    attachments: (turn.attachments || []).map(remoteAttachment),
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
  if (entry.type === 'text') return { type: 'text', id: `${turn.id}-text-${index}`, text: entry.text }
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
    name: tool.name,
    state: tool.state,
    presentation: {
      key: common?.key || `tool.${tool.name}`,
      args: common?.args || {},
      fallbackTitle: common?.title || presentation?.title || tool.name,
      fallbackDetail: detail,
      semanticIcon: semanticIcon(common ? tool.name : presentation?.kind || tool.name),
    },
    summary: detail,
    output: tool.output,
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
    name: item.name,
    mimeType: item.mimeType,
    sizeBytes: item.size,
    pageCount: item.capabilities.pages,
  }
}

function remoteQueueItem(item: RemoteQueueItem) {
  return { id: item.id, text: item.text, attachments: (item.attachments || []).map(remoteAttachment) }
}

function remoteProgress(turn?: Turn) {
  if (!turn?.progress) return {}
  return remoteRunProgress(turn.progress, turn.id)
}

function remoteRunProgress(progress: RunProgress, id: string) {
  return {
    label: progress.message,
    steps: progress.steps.map((step, index) => ({ id: `${id}-step-${index}`, label: step.label, state: step.status === 'complete' ? 'done' : step.status })),
  }
}

function remotePhase(label = 'Working') {
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
