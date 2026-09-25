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

/** What a context reading was taken for: a measurement, or a compaction. */
export type RemoteContextState = 'ready' | 'compacting' | 'compacted'
export type RemoteContextReading = { used?: number; total?: number; state?: RemoteContextState }

export type RemoteTimelineEntry =
  | { type: 'text'; id: string; text: string }
  | { type: 'tool'; id: string; tool: RemoteTool }
  | { type: 'context'; id: string; context: RemoteContextReading }

export type RemoteTurn = {
  id: string
  role: RemoteTurnRole
  content: string
  attachments?: RemoteAttachment[]
  timeline: RemoteTimelineEntry[]
  phase?: { kind: string; label: string }
  progress?: RemoteProgress
  /** The latest reading the execution node reported, and what it was doing. */
  context?: RemoteContextReading
  /** The execution node compacted this run's context: a notice, not an ending. */
  compacted?: boolean
  error?: boolean
  startedAt?: number
  completedAt?: number
}

/**
 * A turn as the execution node describes it. Most of it is the turn this view
 * keeps; the reading is the one field that arrives under the name the app uses
 * for it locally, so it is read into the view's own shape on the way in.
 */
export type RemoteTurnPayload = RemoteTurn & { contextUsage?: RemoteContextReading }

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
  turns: RemoteTurnPayload[]
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

/**
 * The remote conversation, expressed as the turns this app's own renderer
 * already draws.
 *
 * Remote mode is a filter over the same surface, like Archived, so the feed is
 * not a second renderer: the peer's projection is converted into the local
 * turn shape and handed to the same components. One part of that conversion is
 * inherently a reconstruction — the streamed tool row carries the peer's own
 * compacted detail (a command, a path, a query) rather than the arguments it
 * was called with, because sending every argument of every call is what the
 * bounded projection exists to avoid. The detail is put back into the one field
 * this app's presentation reads for that tool family, which is why the row ends
 * up saying the same thing it says on the machine that ran it; anything the
 * peer does not describe keeps its raw name, and the whole record — arguments,
 * output, diff — stays one click away.
 */
export function remoteToolInput(tool: RemoteTool) {
  const detail = remoteToolDetail(tool)
  if (!detail) return ''
  const key = tool.presentation.key
  const family = key.startsWith('tool.command') || key.startsWith('tool.inspection') || key.startsWith('tool.verification') ? 'command'
    : key.startsWith('tool.read') ? 'path'
      : key.startsWith('tool.search') ? 'query'
        : key.startsWith('tool.change') ? 'path'
          : key.startsWith('tool.web_read') ? 'url'
            : key.startsWith('tool.web_search') ? 'query'
              : key.startsWith('tool.attachment') ? 'name'
                : ''
  return family ? JSON.stringify({ [family]: detail }) : ''
}

export function remoteToolAsLocal(tool: RemoteTool, record?: RemoteToolRecord | null) {
  return {
    id: tool.id,
    name: tool.name,
    input: record?.input || remoteToolInput(tool),
    output: record?.output || tool.output || tool.summary || '',
    ...(record?.diff ? { diff: record.diff } : {}),
    state: tool.state,
  }
}

function remoteTurnAsLocal(turn: RemoteTurn, records: Record<string, RemoteToolRecord | null | undefined> = {}) {
  const failed = turn.role === 'error' || turn.error === true,
    // A compaction travels as a reading with what it was taken for, and an
    // older peer reports it as a bare event.
    compaction = turn.context?.state && turn.context.state !== 'ready'
      ? turn.context.state
      : turn.compacted ? 'compacted' as const : ''
  return {
    id: turn.id,
    role: failed ? 'assistant' as const : turn.role === 'user' ? 'user' as const : 'assistant' as const,
    content: turn.content,
    error: failed || undefined,
    phase: turn.phase?.label,
    // The app draws its own compaction notice from a context reading; a
    // compaction is reported here as that state rather than as the turn ending.
    ...(compaction ? { contextUsage: contextUsageAsLocal({ ...turn.context, state: compaction }) } : {}),
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    timeline: turn.timeline.flatMap<RemoteLocalTimelineEntry>((entry) => entry.type === 'tool'
      ? [{ type: 'tool', tool: remoteToolAsLocal(entry.tool, records[entry.tool.id]) }]
      // A plain measurement is a number for the meter, and the meter is in the
      // composer: it is not a step in the conversation, so it is not drawn as
      // one. Only a compaction belongs in the flow, where it happened.
      : entry.type === 'context'
        ? (entry.context.state && entry.context.state !== 'ready'
          ? [{ type: 'context', context: contextUsageAsLocal(entry.context) }]
          : [])
        : [{ type: 'text', text: entry.text }]),
  }
}

type RemoteLocalTimelineEntry =
  | { type: 'text'; text: string }
  | { type: 'tool'; tool: ReturnType<typeof remoteToolAsLocal> }
  | { type: 'context'; context: ReturnType<typeof contextUsageAsLocal> }

function contextUsageAsLocal(reading: RemoteContextReading) {
  return {
    state: reading.state || 'ready' as const,
    usedTokens: reading.used,
    budgetTokens: reading.total,
    usedCharacters: (reading.used || 0) * 3,
    budgetCharacters: (reading.total || 0) * 3,
  }
}

/**
 * The turns of a remote task, in the shape the local conversation renderer
 * takes. A tool whose full record has been fetched is drawn from it: the row
 * someone opened shows what the peer actually ran, not the bounded preview.
 */
/**
 * A message this person just sent, shown before the execution node has said
 * anything about it.
 *
 * The identity is generated here and sent with the command, so the run the peer
 * starts is the *same* turn: its `run.started` carries that id back, and the
 * reducer leaves a turn it already has alone. Nothing is duplicated, and the
 * message never waits a round trip to appear.
 */
export function appendOptimisticTurn(view: RemoteTaskView, input: { messageId: string; text: string; attachments: RemoteAttachment[] }) {
  if (!view.ready || view.turns.some((turn) => turn.id === input.messageId)) return view
  const turn: RemoteTurn = {
    id: input.messageId,
    role: 'user',
    content: input.text,
    attachments: input.attachments,
    timeline: [],
    startedAt: Date.now(),
  }
  return { ...view, turns: [...view.turns, turn] }
}

/** Take back a message the other machine refused. */
export function removeOptimisticTurn(view: RemoteTaskView, messageId: string) {
  return view.turns.some((turn) => turn.id === messageId)
    ? { ...view, turns: view.turns.filter((turn) => turn.id !== messageId) }
    : view
}

export function remoteTurnsAsLocal(view: RemoteTaskView | null, records: Record<string, RemoteToolRecord | null | undefined> = {}) {
  return view?.ready ? view.turns.map((turn) => remoteTurnAsLocal(turn, records)) : []
}

/** The turn a running remote task is writing, which is what the feed animates. */
export function remoteRunningTurnId(view: RemoteTaskView | null) {
  if (view?.status !== 'running') return ''
  // A running task writes its newest reply, so that reply is the running turn: a
  // message this person just sent is a turn of theirs, and marking it as the
  // running one would settle the reply above it while the peer was still writing
  // it — which is how the same run ended up reading differently on the two
  // machines, since every settled row folds while a running one does not.
  for (let index = view.turns.length - 1; index >= 0; index -= 1) {
    const turn = view.turns[index]
    if (turn.role !== 'user') return turn.id
  }
  return ''
}

/** A remote task as a sidebar row: the list, the grouping, and the header take the local shape. */
export function remoteTaskShim(summary: RemoteTaskSummary) {
  return {
    id: summary.id,
    title: summary.title || summary.workspace || summary.id,
    workspace: summary.workspace,
    ...(summary.model ? { model: summary.model } : {}),
    turns: [],
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  }
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

/**
 * Whether a refresh actually changes this turn.
 *
 * A conversation that only grows at its end can be read the way this app reads
 * a local one: the feed follows the newest output and the person's place stays
 * where it is. A refresh that replaces every turn with an equal copy breaks
 * that — the view looks like a different conversation to the renderer, and the
 * feed moves under the reader. So a refresh keeps the turns it already has
 * unless something about them really changed.
 */
/**
 * A refresh, merged into the turn the view already holds.
 *
 * The snapshot is bounded on purpose: it caps a turn's text and the number of
 * timeline entries it carries. So its copy of a turn can be *smaller* than the
 * one this view built from the live stream — and the live stream can be missing
 * a row the peer did run. Choosing one copy wholesale is wrong either way:
 * replacing a turn with a shorter one takes the reader's place with it, and
 * keeping a shorter one is how a row that never arrived stayed missing while the
 * run kept going, which is a reply that reads differently here than there. Each
 * half is taken from the copy that actually has it — the text from the longer
 * one, the timeline from the longer one — and the peer's newer facts (state,
 * completion, reading) come with the snapshot.
 */
function mergeRemoteTurn(prior: RemoteTurn, next: RemoteTurn): RemoteTurn {
  return {
    ...next,
    content: prior.content.length > next.content.length ? prior.content : next.content,
    timeline: next.timeline.length >= prior.timeline.length ? next.timeline : prior.timeline,
  }
}

/** The snapshot names the reading the way this app names it locally. */
function remoteTurnFromPayload(turn: RemoteTurnPayload): RemoteTurn {
  if (turn.context || !turn.contextUsage) return turn
  return { ...turn, context: turn.contextUsage }
}

function turnUnchanged(prior: RemoteTurn, next: RemoteTurn) {
  if (prior.content !== next.content || prior.role !== next.role || prior.error !== next.error) return false
  if ((prior.context?.state || '') !== (next.context?.state || '')) return false
  if ((prior.attachments?.length || 0) !== (next.attachments?.length || 0)) return false
  if (prior.timeline.length !== next.timeline.length) return false
  return prior.timeline.every((entry, index) => {
    const other = next.timeline[index]
    if (entry.type !== other.type || entry.id !== other.id) return false
    if (entry.type === 'text' && other.type === 'text') return entry.text === other.text
    if (entry.type === 'tool' && other.type === 'tool') {
      return entry.tool.state === other.tool.state
        && (entry.tool.output || '').length === (other.tool.output || '').length
        && entry.tool.presentation.fallbackTitle === other.tool.presentation.fallbackTitle
    }
    return true
  })
}

/**
 * A refresh, merged into what the view already holds.
 *
 * `latestSeq` only moves forward: a snapshot taken before events this view has
 * already applied would otherwise make those events look new again and stall the
 * ones that follow. Turns the snapshot does not mention are the older history
 * the person paged back to, and they stay where they are.
 */
export function applyRemoteSnapshot(view: RemoteTaskView, snapshot: RemoteSnapshot): RemoteTaskView {
  const existing = new Map(view.ready ? view.turns.map(turn => [turn.id, turn]) : [])
  const named = new Set<string>()
  const turns = snapshot.turns.map((turn) => {
    named.add(turn.id)
    const incoming = remoteTurnFromPayload(turn)
    const prior = existing.get(incoming.id)
    if (!prior) return incoming
    return turnUnchanged(prior, incoming) ? prior : mergeRemoteTurn(prior, incoming)
  })
  const older = view.ready ? view.turns.filter(turn => !named.has(turn.id)) : []
  return {
    ...view,
    ready: true,
    taskId: snapshot.taskId,
    latestSeq: Math.max(view.latestSeq, snapshot.latestSeq),
    status: snapshot.status,
    title: snapshot.title,
    workspace: snapshot.workspace,
    model: snapshot.model || '',
    progress: snapshot.progress,
    turns: [...older, ...turns],
    queue: snapshot.queue || [],
    approvals: snapshot.approvals || [],
    hasMoreHistory: snapshot.history?.hasMore ?? false,
    historyCursor: snapshot.history?.cursor,
    needsResync: false,
  }
}

export function applyRemoteHistory(view: RemoteTaskView, page: { turns: RemoteTurnPayload[]; history: { hasMore: boolean; cursor?: string } }): RemoteTaskView {
  const known = new Set(view.turns.map(turn => turn.id))
  const earlier = page.turns.map(remoteTurnFromPayload).filter(turn => !known.has(turn.id))
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
    case 'turn.entry': {
      const turnId = String(payload.turnId || '')
      const entry = payload.entry as RemoteTimelineEntry | undefined
      // A reading keeps the meter honest and never becomes a row of its own; a
      // compaction is a step in the flow, so it is placed where it happened.
      if (entry?.type === 'context') {
        const state = entry.context.state || 'ready'
        const turns = patchTurn(view.turns, turnId, { context: { ...entry.context, state } })
        return { ...view, turns: state === 'ready' ? turns : upsertEntry(turns, turnId, entry) }
      }
      return { ...view, turns: upsertEntry(view.turns, turnId, entry) }
    }
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
