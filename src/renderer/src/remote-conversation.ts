/**
 * The controller's view of one remote task.
 *
 * The semantics come from the wire, not from this file. Every event carries a
 * monotonic `seq` per task, so a duplicate or an out-of-order event is dropped,
 * and a jump is a gap: the view stops applying until it has the events it
 * missed, rather than rendering a conversation with a hole in it. Order is
 * never re-derived here — turns stay in the order the execution node emitted
 * them, and a turn's timeline stays in arrival order.
 */
export type RemoteTurnRole = 'user' | 'assistant' | 'error'
export type RemoteTaskStatus = 'idle' | 'running' | 'completed' | 'error'

export type RemoteAttachment = {
  id: string
  kind: 'image' | 'pdf' | 'document' | 'spreadsheet' | 'presentation' | 'text' | 'archive' | 'media' | 'unknown'
  name: string
  mimeType?: string
  sizeBytes?: number
  pageCount?: number
  width?: number
  height?: number
}

export type RemoteTool = {
  id: string
  name: string
  state: 'running' | 'done' | 'error'
  presentation: { key: string; args: Record<string, string | number>; fallbackTitle: string; fallbackDetail?: string; semanticIcon: string }
  summary?: string
  output?: string
  attachments?: RemoteAttachment[]
  error?: string
  recovered?: boolean
  startedAt?: number
  finishedAt?: number
}

export type RemoteTimelineEntry =
  | { type: 'text'; id: string; text: string }
  | { type: 'tool'; id: string; tool: RemoteTool }
  | { type: 'context'; id: string; context: { used?: number; total?: number } }

export type RemoteTurn = {
  id: string
  role: RemoteTurnRole
  content: string
  attachments?: RemoteAttachment[]
  timeline: RemoteTimelineEntry[]
  phase?: { kind: string; label: string }
  progress?: RemoteProgress
  error?: boolean
  startedAt?: number
  completedAt?: number
}

export type RemoteProgress = { percent?: number; label?: string; steps?: Array<{ id: string; label: string; state: 'pending' | 'active' | 'done' }> }
export type RemoteApproval = { approvalId: string; title: string; description?: string; risk?: string; state: 'pending' | 'approved' | 'denied' }
export type RemoteQueueItem = { id: string; taskId: string; text: string; attachments?: RemoteAttachment[] }
export type RemoteTaskSummary = {
  id: string
  title: string
  workspace: string
  status: RemoteTaskStatus
  model?: string
  activeRunId?: string
  updatedAt: number
  createdAt: number
}

export type RemoteSnapshot = {
  taskId: string
  latestSeq: number
  status: RemoteTaskStatus
  title: string
  workspace: string
  model?: string
  progress?: RemoteProgress
  turns: RemoteTurn[]
  queue?: RemoteQueueItem[]
  approvals?: RemoteApproval[]
  history?: { hasMore: boolean; cursor?: string }
}

export type RemoteEvent = { seq: number; taskId: string; timestamp?: number; type: string; payload: Record<string, unknown> }

/** What one tool call looks like when a controller asks to see it in full. */
export type RemoteToolRecord = {
  id: string
  name: string
  state: string
  changed: boolean
  input: string
  output: string
  diff: string
  attachments?: RemoteAttachment[]
}

export type RemoteChangeEntry = { path: string; kind: string }
export type RemoteDiffHunk = { header: string; lines: Array<{ text: string; type: 'context' | 'add' | 'remove' }> }
export type RemoteDiffEntry = { path: string; hunks: RemoteDiffHunk[] }
export type RemoteChangesState = { branch: string; entries: RemoteChangeEntry[]; hunks: RemoteDiffEntry[]; loading: boolean; error: string }
export type RemoteResource = { id: string; label: string; command: string; state: string; cwd: string; startedAt?: number }
export type RemoteWorkspaceEntry = { name: string; path: string }
export type RemoteWorkspaceDirectory = { path: string; parent?: string; entries: RemoteWorkspaceEntry[]; truncated?: boolean }

/** A change entry only has a diff worth opening when the peer reported one. */
export function changeDiffFor(changes: RemoteChangesState | null, path: string) {
  return changes?.hunks.find((entry) => entry.path === path)?.hunks || []
}

export function changeKindLabel(kind: string, zh: boolean) {
  if (kind === 'staged') return zh ? '已暂存' : 'Staged'
  if (kind === 'untracked') return zh ? '未跟踪' : 'Untracked'
  if (kind === 'conflicted') return zh ? '冲突' : 'Conflicted'
  return zh ? '未暂存' : 'Modified'
}

export type RemoteTaskView = {
  taskId: string
  ready: boolean
  latestSeq: number
  status: RemoteTaskStatus
  title: string
  workspace: string
  model: string
  progress?: RemoteProgress
  turns: RemoteTurn[]
  queue: RemoteQueueItem[]
  approvals: RemoteApproval[]
  hasMoreHistory: boolean
  historyCursor?: string
  needsResync: boolean
}

export function emptyRemoteTaskView(taskId: string): RemoteTaskView {
  return {
    taskId,
    ready: false,
    latestSeq: 0,
    status: 'idle',
    title: '',
    workspace: '',
    model: '',
    turns: [],
    queue: [],
    approvals: [],
    hasMoreHistory: false,
    needsResync: false,
  }
}

export function applyRemoteSnapshot(view: RemoteTaskView, snapshot: RemoteSnapshot): RemoteTaskView {
  return {
    ...view,
    ready: true,
    taskId: snapshot.taskId,
    latestSeq: snapshot.latestSeq,
    status: snapshot.status,
    title: snapshot.title,
    workspace: snapshot.workspace,
    model: snapshot.model || '',
    progress: snapshot.progress,
    turns: snapshot.turns,
    queue: snapshot.queue || [],
    approvals: snapshot.approvals || [],
    hasMoreHistory: snapshot.history?.hasMore ?? false,
    historyCursor: snapshot.history?.cursor,
    needsResync: false,
  }
}

export function applyRemoteHistory(view: RemoteTaskView, page: { turns: RemoteTurn[]; history: { hasMore: boolean; cursor?: string } }): RemoteTaskView {
  const known = new Set(view.turns.map(turn => turn.id))
  const earlier = page.turns.filter(turn => !known.has(turn.id))
  return { ...view, turns: [...earlier, ...view.turns], historyCursor: page.history.cursor, hasMoreHistory: page.history.hasMore }
}

/**
 * Apply one event, or pause on a gap.
 *
 * An event that does not follow the last one applied is never applied: it either
 * repeats what the view already has, or it skipped something. A skip marks the
 * view for resync and leaves it untouched — the sequence itself is the gate, so
 * the catch-up page (which does continue the sequence) still lands, while a
 * live event from after the hole cannot jump the queue.
 */
export function applyRemoteEvent(view: RemoteTaskView, event: RemoteEvent): RemoteTaskView {
  if (!view.ready) return view
  if (event.seq <= view.latestSeq) return view
  if (event.seq !== view.latestSeq + 1) return { ...view, needsResync: true }
  return { ...reduceEvent(view, event), latestSeq: event.seq, needsResync: false }
}

export function applyRemoteEvents(view: RemoteTaskView, events: RemoteEvent[]): RemoteTaskView {
  let next = view
  for (const event of events) next = applyRemoteEvent(next, event)
  return next
}

/**
 * Whether a catch-up page continues this view. A page that starts after the
 * next expected sequence cannot close the gap — the events it would need are no
 * longer on the execution node — so the view has to take a snapshot instead.
 * A page may start at or before the next expected event: anything already
 * applied is dropped by the sequence check.
 */
export function catchUpContinues(view: RemoteTaskView, events: RemoteEvent[]) {
  if (!events.length) return true
  return events[0].seq <= view.latestSeq + 1
}

function reduceEvent(view: RemoteTaskView, event: RemoteEvent): RemoteTaskView {
  const payload = event.payload as Record<string, unknown>
  switch (event.type) {
    case 'run.started': {
      const runId = String(payload.runId || '')
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : ''
      const text = typeof payload.text === 'string' ? payload.text : ''
      const startedAt = typeof payload.startedAt === 'number' ? payload.startedAt : event.timestamp
      const attachments = Array.isArray(payload.attachments) ? payload.attachments as RemoteAttachment[] : []
      let turns = view.turns
      if (messageId && !turns.some(turn => turn.id === messageId)) {
        turns = [...turns, { id: messageId, role: 'user', content: text, attachments, timeline: [], startedAt }]
      }
      if (runId && !turns.some(turn => turn.id === runId)) {
        turns = [...turns, { id: runId, role: 'assistant', content: '', attachments: [], timeline: [], phase: { kind: 'planning', label: 'Thinking' }, startedAt }]
      }
      return { ...view, turns, status: 'running' }
    }
    case 'turn.delta':
      return { ...view, turns: appendDelta(view.turns, String(payload.turnId || ''), String(payload.delta || '')) }
    case 'turn.entry':
      return { ...view, turns: upsertEntry(view.turns, String(payload.turnId || ''), payload.entry as RemoteTimelineEntry) }
    case 'turn.patch':
      return { ...view, turns: patchTurn(view.turns, String(payload.turnId || ''), payload.patch as Partial<RemoteTurn>) }
    case 'run.finished': {
      const runId = String(payload.runId || '')
      const error = typeof payload.error === 'string' ? payload.error : ''
      const completedAt = typeof payload.completedAt === 'number' ? payload.completedAt : event.timestamp
      const status = error ? 'error' : (typeof payload.status === 'string' ? payload.status as RemoteTaskStatus : 'completed')
      const turns = view.turns.map(turn => {
        if (turn.id !== runId) return turn
        if (!error) return { ...turn, phase: undefined, progress: undefined, completedAt }
        const text = `Error: ${error}`
        const last = turn.timeline.at(-1)
        const timeline: RemoteTimelineEntry[] = last?.type === 'text'
          ? [...turn.timeline.slice(0, -1), { ...last, text: `${last.text}\n\n${text}` }]
          : [...turn.timeline, { type: 'text', id: `${turn.id}-error`, text }]
        return {
          ...turn,
          role: 'error' as const,
          content: turn.content ? `${turn.content}\n\n${text}` : text,
          timeline,
          error: true,
          phase: undefined,
          progress: undefined,
          completedAt,
        }
      })
      return { ...view, turns, status }
    }
    case 'task.patch':
      return {
        ...view,
        ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
        ...(typeof payload.workspace === 'string' ? { workspace: payload.workspace } : {}),
        ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
      }
    case 'queue.snapshot':
      return { ...view, queue: Array.isArray(payload.items) ? payload.items as RemoteQueueItem[] : [] }
    case 'approval.request': {
      const approvalId = String(payload.approvalId || '')
      if (!approvalId) return view
      const approval: RemoteApproval = {
        approvalId,
        title: String(payload.title || ''),
        description: typeof payload.description === 'string' ? payload.description : undefined,
        risk: typeof payload.risk === 'string' ? payload.risk : undefined,
        state: 'pending',
      }
      return { ...view, approvals: [...view.approvals.filter(item => item.approvalId !== approvalId), approval] }
    }
    case 'approval.resolved': {
      const approvalId = String(payload.approvalId || '')
      return {
        ...view,
        approvals: view.approvals.map(item => item.approvalId === approvalId
          ? { ...item, state: payload.decision === 'approve' ? 'approved' as const : 'denied' as const }
          : item),
      }
    }
    default:
      return view
  }
}

function appendDelta(turns: RemoteTurn[], turnId: string, delta: string): RemoteTurn[] {
  const index = turns.findIndex(turn => turn.id === turnId)
  if (index === -1 || !delta) return turns
  const turn = turns[index]
  const timeline = [...turn.timeline]
  const last = timeline.at(-1)
  if (last?.type === 'text') timeline[timeline.length - 1] = { ...last, text: last.text + delta }
  else timeline.push({ type: 'text', id: `${turn.id}-text-${timeline.length}`, text: delta })
  const next: RemoteTurn = { ...turn, content: turn.content + delta, timeline }
  return [...turns.slice(0, index), next, ...turns.slice(index + 1)]
}

function upsertEntry(turns: RemoteTurn[], turnId: string, entry: RemoteTimelineEntry | undefined): RemoteTurn[] {
  if (!entry || typeof entry.id !== 'string') return turns
  const index = turns.findIndex(turn => turn.id === turnId)
  if (index === -1) return turns
  const turn = turns[index]
  const entryIndex = turn.timeline.findIndex(item => item.id === entry.id)
  // A tool is reported twice: once running, once settled. The id is what makes
  // that an update rather than a second row.
  const timeline = entryIndex === -1
    ? [...turn.timeline, entry]
    : turn.timeline.map((item, position) => position === entryIndex ? entry : item)
  const next: RemoteTurn = { ...turn, timeline }
  return [...turns.slice(0, index), next, ...turns.slice(index + 1)]
}

function patchTurn(turns: RemoteTurn[], turnId: string, patch: Partial<RemoteTurn>): RemoteTurn[] {
  const index = turns.findIndex(turn => turn.id === turnId)
  if (index === -1) return turns
  const next: RemoteTurn = { ...turns[index], ...patch }
  return [...turns.slice(0, index), next, ...turns.slice(index + 1)]
}

/** The title of a remote tool row, in the person's language where the key is known. */
export function remoteToolTitle(tool: RemoteTool, zh: boolean) {
  const key = tool.presentation.key
  const family = key.startsWith('tool.command') ? 'command'
    : key.startsWith('tool.inspection') ? 'inspection'
      : key.startsWith('tool.verification') ? 'verification'
        : key.startsWith('tool.read') ? 'read'
          : key.startsWith('tool.search') ? 'search'
            : key.startsWith('tool.change') ? 'change'
              : key.startsWith('tool.attachment') ? 'attachment'
                : key.startsWith('tool.web_read') ? 'webRead'
                  : key.startsWith('tool.web_search') ? 'webSearch'
                    : ''
  const labels: Record<string, { en: [string, string, string]; zh: [string, string, string] }> = {
    command: { en: ['Running command', 'Command completed', 'Command failed'], zh: ['正在执行命令', '命令已完成', '命令失败'] },
    inspection: { en: ['Reading or searching code', 'Completed read/search action', 'Read or search failed'], zh: ['正在读取或搜索代码', '读取搜索完成', '读取或搜索失败'] },
    verification: { en: ['Verifying', 'Verification completed', 'Verification failed'], zh: ['正在验证', '验证完成', '验证失败'] },
    read: { en: ['Reading file', 'Read file', 'File read failed'], zh: ['正在读取文件', '已读取文件', '读取文件失败'] },
    search: { en: ['Searching code', 'Searched code', 'Code search failed'], zh: ['正在搜索代码', '已搜索代码', '搜索代码失败'] },
    change: { en: ['Changing file', 'Changed file', 'File change failed'], zh: ['正在修改文件', '已修改文件', '修改文件失败'] },
    attachment: { en: ['Reading attachment', 'Read attachment', 'Attachment read failed'], zh: ['正在读取附件', '已读取附件', '读取附件失败'] },
    webRead: { en: ['Reading web page', 'Read web page', 'Web page read failed'], zh: ['正在读取网页', '已读取网页', '读取网页失败'] },
    webSearch: { en: ['Searching web', 'Searched web', 'Web search failed'], zh: ['正在搜索网页', '已搜索网页', '搜索网页失败'] },
  }
  const label = family ? labels[family] : undefined
  if (!label) return tool.presentation.fallbackTitle || tool.name
  return (zh ? label.zh : label.en)[tool.state === 'running' ? 0 : tool.state === 'error' ? 2 : 1]
}

export function remoteToolDetail(tool: RemoteTool) {
  return tool.summary || tool.presentation.fallbackDetail || ''
}

/** A tool row's payload is bounded by the execution node; the full output is not here. */
export function remoteToolOutput(tool: RemoteTool) {
  return (tool.output || '').trim()
}
