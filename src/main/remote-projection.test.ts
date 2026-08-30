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
  const screenshot = {
    id: 'screenshot-1',
    taskId: 'task-1',
    name: 'Chrome screenshot.png',
    mimeType: 'image/png',
    kind: 'image' as const,
    size: 1024,
    sha256: 'abc',
    createdAt: 190,
    capabilities: { vision: true },
  }
  const event = remoteTaskEvent({
    taskId: 'task-1',
    seq: 8,
    at: 200,
    payload: {
      type: 'agent',
      runId: 'run-1',
      event: { id: 'run-1', type: 'tool', tool: { id: 'tool-1', name: 'read', input: '{"path":"src/app.ts"}', state: 'done', output: 'ok', attachments: [screenshot] } },
    },
  })
  assert.equal(event.type, 'turn.entry')
  assert.equal((event.payload as any).entry.id, 'tool-1')
  const tool = (event.payload as any).entry.tool
  assert.equal(tool.presentation.semanticIcon, 'file')
  assert.equal(tool.presentation.fallbackTitle, 'Read file')
  assert.equal(tool.presentation.fallbackDetail, 'src/app.ts')
  assert.equal(tool.summary, 'src/app.ts')
  assert.deepEqual(tool.attachments, [{
    id: 'screenshot-1',
    kind: 'image',
    name: 'Chrome screenshot.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
    pageCount: undefined,
  }])
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
        tool: {
          id: 'tool-read-1',
          name: 'read',
          input: '{"path":"src/remote-projection.ts"}',
          state: 'done',
          output: 'ok',
          attachments: [{
            id: 'history-screenshot',
            taskId: 'task-1',
            name: 'History screenshot.png',
            mimeType: 'image/png',
            kind: 'image',
            size: 2048,
            sha256: 'def',
            createdAt: 1,
            capabilities: { vision: true },
          }],
        },
      }],
    }],
  })

  const tool = (snapshot.turns[0].timeline[0] as any).tool
  assert.equal(snapshot.model, 'model-task')
  assert.equal(tool.presentation.fallbackTitle, 'Read file')
  assert.equal(tool.presentation.fallbackDetail, 'src/remote-projection.ts')
  assert.equal(tool.summary, 'src/remote-projection.ts')
  assert.equal(tool.attachments[0].id, 'history-screenshot')
  assert.equal(tool.attachments[0].kind, 'image')
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

test('remote snapshots stay below the relay frame limit for huge tool history', () => {
  const hugeOutput = '输出'.repeat(300_000)
  const task = {
    id: 'task-huge',
    title: '大型任务',
    workspace: '/workspace',
    createdAt: 1,
    updatedAt: 2,
    turns: Array.from({ length: 24 }, (_, turnIndex) => ({
      id: `turn-${turnIndex + 1}`,
      role: 'assistant' as const,
      content: `Turn ${turnIndex + 1}`,
      timeline: Array.from({ length: 8 }, (_, toolIndex) => ({
        type: 'tool' as const,
        tool: {
          id: `tool-${turnIndex}-${toolIndex}`,
          name: 'bash',
          input: '{"command":"inspect"}',
          state: 'done' as const,
          output: hugeOutput,
        },
      })),
    })),
  }

  const snapshot = remoteTaskSnapshot(task)
  assert.ok(estimatedEncryptedFrameBytes({ id: 'request-1', kind: 'task.snapshot', payload: { ok: true, data: snapshot } }) < 1024 * 1024)
  assert.equal(snapshot.turns.at(-1)?.id, 'turn-24')
  assert.match(((snapshot.turns.at(-1)?.timeline.at(-1) as any).tool.output), /truncated for remote display/)
})

test('remote history byte pagination handles one turn with extreme structured output', () => {
  const task = {
    id: 'task-structured',
    title: 'Structured output',
    workspace: '/workspace',
    createdAt: 1,
    updatedAt: 2,
    turns: [{
      id: 'turn-1',
      role: 'assistant' as const,
      content: '中文'.repeat(200_000),
      timeline: Array.from({ length: 2_000 }, (_, index) => ({
        type: 'tool' as const,
        tool: {
          id: `tool-${index}`,
          name: 'read',
          input: JSON.stringify({ path: `/workspace/file-${index}.txt` }),
          state: 'done' as const,
          output: 'x'.repeat(100_000),
        },
      })),
    }],
  }

  const page = remoteTaskHistory(task, 'missing', 24)
  assert.deepEqual(page.turns, [])
  const snapshot = remoteTaskSnapshot(task)
  assert.ok(estimatedEncryptedFrameBytes({ id: 'request-2', kind: 'task.snapshot', payload: { ok: true, data: snapshot } }) < 1024 * 1024)
  assert.equal(snapshot.turns[0]?.id, 'turn-1')
})

test('remote push events bound individual tool output frames', () => {
  const event = remoteTaskEvent({
    taskId: 'task-1',
    seq: 10,
    at: 220,
    payload: {
      type: 'agent',
      runId: 'run-1',
      event: {
        id: 'run-1',
        type: 'tool',
        tool: { id: 'tool-large', name: 'bash', input: '{}', state: 'done', output: 'x'.repeat(2 * 1024 * 1024) },
      },
    },
  })

  assert.ok(estimatedEncryptedFrameBytes({ kind: 'push', event }) < 1024 * 1024)
  assert.match(((event.payload as any).entry.tool.output), /truncated for remote display/)
})

function estimatedEncryptedFrameBytes(payload: unknown) {
  const envelope = JSON.stringify({ version: 1, messageId: 'm'.repeat(36), type: 'rpc', createdAt: 1, payload })
  const ciphertextBytes = Buffer.byteLength(envelope) + 16
  const encodedCiphertextBytes = Math.ceil(ciphertextBytes / 3) * 4
  return Buffer.byteLength(JSON.stringify({
    version: 1,
    linkId: 'l'.repeat(43),
    messageId: 'm'.repeat(36),
    sequence: 1,
    nonce: 'n'.repeat(16),
    ciphertext: 'x'.repeat(encodedCiphertextBytes),
  }))
}

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
