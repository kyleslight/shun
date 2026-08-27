import assert from 'node:assert/strict'
import test from 'node:test'
import { remoteTaskEvent, remoteTaskHistory, remoteTaskSnapshot } from '../remote-projection.ts'

test('remote task events preserve sequence and project a run incrementally', () => {
  const started = remoteTaskEvent({
    taskId: 'task-1',
    seq: 4,
    at: 100,
    payload: { type: 'request', runId: 'run-1', messageId: 'message-1', text: 'Ship it' },
  })
  assert.deepEqual(started, {
    taskId: 'task-1',
    seq: 4,
    timestamp: 100,
    type: 'run.started',
    payload: { runId: 'run-1', messageId: 'message-1', text: 'Ship it', attachments: [], startedAt: 100 },
  })

  const delta = remoteTaskEvent({
    taskId: 'task-1',
    seq: 5,
    at: 120,
    payload: { type: 'agent', runId: 'run-1', event: { id: 'run-1', type: 'delta', text: 'Done' } },
  })
  assert.deepEqual(delta, {
    taskId: 'task-1',
    seq: 5,
    timestamp: 120,
    type: 'turn.delta',
    payload: { turnId: 'run-1', delta: 'Done' },
  })
})

test('remote tool updates keep a stable entry identity', () => {
  const event = remoteTaskEvent({
    taskId: 'task-1',
    seq: 8,
    at: 200,
    payload: {
      type: 'agent',
      runId: 'run-1',
      event: { id: 'run-1', type: 'tool', tool: { id: 'tool-1', name: 'read', input: '{"path":"src/app.ts"}', state: 'done', output: 'ok' } },
    },
  })
  assert.equal(event.type, 'turn.entry')
  assert.equal((event.payload as any).entry.id, 'tool-1')
  const tool = (event.payload as any).entry.tool
  assert.equal(tool.presentation.semanticIcon, 'file')
  assert.equal(tool.presentation.fallbackTitle, 'Read file')
  assert.equal(tool.presentation.fallbackDetail, 'src/app.ts')
  assert.equal(tool.summary, 'src/app.ts')
})

test('remote shell tools preserve the same inline command detail as Desktop', () => {
  const event = remoteTaskEvent({
    taskId: 'task-1',
    seq: 9,
    at: 202,
    payload: {
      type: 'agent',
      runId: 'run-1',
      event: {
        id: 'run-1',
        type: 'tool',
        tool: {
          id: 'tool-shell-1',
          name: 'bash',
          input: '{"command":"pnpm test && pnpm typecheck"}',
          state: 'done',
          output: 'ok',
        },
      },
    },
  })

  const tool = (event.payload as any).entry.tool
  assert.equal(tool.presentation.fallbackTitle, 'Verification completed')
  assert.equal(tool.presentation.fallbackDetail, 'pnpm test && pnpm typecheck')
  assert.equal(tool.summary, 'pnpm test && pnpm typecheck')
})

test('remote snapshots preserve inline details for existing tool history', () => {
  const snapshot = remoteTaskSnapshot({
    id: 'task-1',
    title: 'Inspect source',
    workspace: '/workspace',
    model: 'model-task',
    createdAt: 1,
    updatedAt: 2,
    turns: [{
      id: 'turn-1',
      role: 'assistant',
      content: '',
      timeline: [{
        type: 'tool',
        tool: { id: 'tool-read-1', name: 'read', input: '{"path":"src/remote-projection.ts"}', state: 'done', output: 'ok' },
      }],
    }],
  })

  const tool = (snapshot.turns[0].timeline[0] as any).tool
  assert.equal(snapshot.model, 'model-task')
  assert.equal(tool.presentation.fallbackTitle, 'Read file')
  assert.equal(tool.presentation.fallbackDetail, 'src/remote-projection.ts')
  assert.equal(tool.summary, 'src/remote-projection.ts')
})

test('remote conversation history is bottom-first and cursor paginated', () => {
  const task = {
    id: 'task-history',
    title: 'Long task',
    workspace: '/workspace',
    createdAt: 1,
    updatedAt: 2,
    turns: Array.from({ length: 7 }, (_, index) => ({
      id: `turn-${index + 1}`,
      role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `Turn ${index + 1}`,
      timeline: [],
    })),
  }

  const snapshot = remoteTaskSnapshot(task, undefined, 0, [], [], { turnLimit: 3 })
  assert.deepEqual(snapshot.turns.map(turn => turn.id), ['turn-5', 'turn-6', 'turn-7'])
  assert.deepEqual(snapshot.history, { hasMore: true, cursor: 'turn-5' })

  const previous = remoteTaskHistory(task, 'turn-5', 3)
  assert.deepEqual(previous.turns.map(turn => turn.id), ['turn-2', 'turn-3', 'turn-4'])
  assert.deepEqual(previous.history, { hasMore: true, cursor: 'turn-2' })

  const oldest = remoteTaskHistory(task, 'turn-2', 3)
  assert.deepEqual(oldest.turns.map(turn => turn.id), ['turn-1'])
  assert.deepEqual(oldest.history, { hasMore: false, cursor: 'turn-1' })
})

test('remote web tools use the same product copy as Desktop', () => {
  const event = remoteTaskEvent({
    taskId: 'task-1',
    seq: 9,
    at: 205,
    payload: {
      type: 'agent',
      runId: 'run-1',
      event: {
        id: 'run-1',
        type: 'tool',
        tool: {
          id: 'tool-web-1',
          name: 'web_read',
          input: '{"url":"https://www.example.com/article"}',
          state: 'done',
          output: 'ok',
        },
      },
    },
  })

  assert.equal(event.type, 'turn.entry')
  const presentation = (event.payload as any).entry.tool.presentation
  assert.equal(presentation.key, 'tool.web_read.done')
  assert.equal(presentation.fallbackTitle, 'Read web page')
  assert.equal(presentation.fallbackDetail, 'example.com')
  assert.equal(presentation.semanticIcon, 'search')
})

test('remote queue and confirmation state project without exposing Desktop internals', () => {
  const queued = remoteTaskEvent({
    taskId: 'task-1',
    seq: 9,
    at: 210,
    payload: { type: 'remote', event: { kind: 'queue.snapshot', items: [{ id: 'queue-1', taskId: 'task-1', text: 'Follow up' }] } },
  })
  assert.deepEqual(queued, {
    taskId: 'task-1',
    seq: 9,
    timestamp: 210,
    type: 'queue.snapshot',
    payload: { items: [{ id: 'queue-1', text: 'Follow up', attachments: [] }] },
  })

  const confirmation = remoteTaskEvent({
    taskId: 'task-1',
    seq: 10,
    at: 220,
    payload: { type: 'remote', event: { kind: 'confirmation.request', id: 'confirm-1', title: 'Restart?', risk: 'External effects remain.' } },
  })
  assert.equal(confirmation.type, 'approval.request')
  assert.deepEqual(confirmation.payload, { approvalId: 'confirm-1', title: 'Restart?', description: undefined, risk: 'External effects remain.' })
})
