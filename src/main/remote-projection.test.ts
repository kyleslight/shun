import assert from 'node:assert/strict'
import test from 'node:test'
import type { PluginViewRequest, ToolEvent } from '../shared.ts'
import { remoteTaskEvent, remoteTaskHistory, remoteTaskList, remoteTaskSnapshot, remoteToolRecord } from '../remote-projection.ts'

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

/**
 * A plugin's interface only exists on the machine that runs the plugin, so what
 * a controller can act on is the request to present it. Losing it on the way
 * out makes `plugin_view_present` a row that says a view opened and nothing
 * else, on every controller that is not the window it opened in.
 */
test('a request to present a plugin view reaches the controller on the settled row', () => {
  const pluginView = {
    pluginId: 'git-workbench',
    viewId: 'git-workbench.history',
    title: 'Commit history',
    pluginName: 'Git Workbench',
    icon: 'git' as const,
    iconUrl: 'shun-plugin://git-workbench/icon.png',
    disposition: 'open' as const,
  }
  const event = remoteTaskEvent({
    taskId: 'task-1',
    seq: 12, at: 260,
    payload: { type: 'agent', runId: 'run-1', event: { id: 'run-1', type: 'tool', tool: { id: 'tool-view-1', name: 'plugin_view_present', input: '{"plugin_id":"git-workbench","view_id":"git-workbench.history"}', state: 'done', output: 'presented', pluginView } } },
  })
  assert.deepEqual((event.payload as any).entry.tool.pluginView, pluginView)

  // The same row has to survive a snapshot: a controller that reconnects reads
  // its history from there, and a request it already acted on must not vanish.
  const snapshot = remoteTaskSnapshot({
    id: 'task-1', title: 'Inspect source', workspace: '/workspace', createdAt: 1, updatedAt: 2,
    turns: [{ id: 'turn-1', role: 'assistant', content: '', timeline: [{ type: 'tool', tool: { id: 'tool-view-1', name: 'plugin_view_present', input: '', state: 'done', output: 'presented', pluginView } }] }],
  })
  assert.deepEqual((snapshot.turns[0].timeline[0] as any).tool.pluginView, pluginView)
})

/**
 * `suggest` and `open` are different instructions, and a controller cannot tell
 * which it was given if the peer sends one it does not recognise. Half a request
 * is worse than none: the row still reads correctly without it.
 */
test('a plugin view request without a usable disposition is dropped whole', () => {
  const projected = (pluginView: unknown) => (remoteTaskEvent({
    taskId: 'task-1', seq: 13, at: 262,
    payload: { type: 'agent', runId: 'run-1', event: { id: 'run-1', type: 'tool', tool: { id: 'tool-view-2', name: 'plugin_view_present', input: '', state: 'done', output: 'presented', pluginView: pluginView as PluginViewRequest | undefined } } },
  }).payload as any).entry.tool

  assert.equal(projected({ pluginId: 'git-workbench', viewId: 'git-workbench.history' }).pluginView, undefined)
  assert.equal(projected({ pluginId: 'git-workbench', viewId: 'git-workbench.history', disposition: 'later' }).pluginView, undefined)
  assert.equal(projected({ viewId: 'git-workbench.history', disposition: 'open' }).pluginView, undefined)
})

/** A row with nothing to present stays the row it was, so no controller pays for the field. */
test('a tool row with no plugin view request does not carry the field', () => {
  const event = remoteTaskEvent({
    taskId: 'task-1', seq: 14, at: 264,
    payload: { type: 'agent', runId: 'run-1', event: { id: 'run-1', type: 'tool', tool: { id: 'tool-3', name: 'bash', input: '{"command":"ls"}', state: 'done', output: 'ok' } } },
  })
  assert.equal('pluginView' in (event.payload as any).entry.tool, false)
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

test('a run whose turn is already written stops being reported as running', () => {
  const finished = {
    id: 'task-run',
    title: 'Greeting from user',
    workspace: '/workspace',
    createdAt: 1,
    updatedAt: 2,
    turns: [
      { id: 'message-1', role: 'user' as const, content: 'hi', timeline: [] },
      { id: 'run-1', role: 'assistant' as const, content: 'Hi!', startedAt: 3, completedAt: 9, timeline: [] },
    ],
  }

  // The list, the snapshot, and everything a controller draws from them read one
  // run state. A run that ended while the state saying so was late left a reply
  // that was already finished reported as still being written — a sidebar row
  // spinning and a composer offering Stop on the other machine — and no re-read
  // could resolve it, because every answer was computed from the same claim.
  assert.equal(remoteTaskList([finished], { 'task-run': 'run-1' })[0].status, 'completed')
  assert.equal(remoteTaskSnapshot(finished, 'run-1').status, 'completed')
  assert.equal(remoteTaskList([finished], { 'task-run': 'run-1' })[0].activeRunId, 'run-1')

  // A run that is genuinely writing its turn is still running: the assistant
  // turn is added with the request, before the run is claimed.
  const writing = {
    ...finished,
    turns: [...finished.turns.slice(0, 1), { id: 'run-2', role: 'assistant' as const, content: '', startedAt: 10, timeline: [] }],
  }
  assert.equal(remoteTaskList([writing], { 'task-run': 'run-2' })[0].status, 'running')
  assert.equal(remoteTaskSnapshot(writing, 'run-2').status, 'running')
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

/**
 * A compaction is not a turn, so the peer has to say it is compacting.
 *
 * The gate is the peer's own, not one derived from the transcript: a compaction
 * interrupted by a restart must not leave the other machine refusing messages
 * the machine that owns the task would accept.
 */
test('a snapshot carries the peer\u2019s own compaction gate', () => {
  const task = {
    id: 'task-compact',
    title: 'Compacting',
    workspace: '/workspace',
    createdAt: 1,
    updatedAt: 2,
    turns: [{ id: 'turn-1', role: 'assistant' as const, content: 'Answer', timeline: [], contextUsage: { state: 'compacting' as const, usedCharacters: 300, budgetCharacters: 600 } }],
  }
  assert.equal(remoteTaskSnapshot(task).compacting, false)
  assert.equal(remoteTaskSnapshot(task, undefined, 0, [], [], { compacting: true }).compacting, true)

  // The list row carries it too. That list is read on a clock, so a controller
  // whose push was lost — or whose peer restarted in the middle of a compaction
  // and will never push again — finds the truth there instead of keeping a
  // composer closed over a compaction that is over.
  assert.equal(remoteTaskList([task], {}, 'task-compact')[0].compacting, true)
  assert.equal(remoteTaskList([task], {})[0].compacting, false)
  assert.equal(remoteTaskList([task], {}, 'another-task')[0].compacting, false)
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

function tool(overrides: Partial<ToolEvent> = {}): ToolEvent {
  return { id: 'tool_1', name: 'bash', input: '{"command":"npm test"}', output: 'ok', state: 'done', ...overrides }
}

test('a tool record carries what the streamed row could not, still inside the transport limit', () => {
  const small = remoteToolRecord(tool({ changed: true, diff: '@@ -1 +1 @@\n-old\n+new' }))
  assert.equal(small.input, '{"command":"npm test"}')
  assert.equal(small.output, 'ok')
  assert.equal(small.changed, true)
  assert.equal(small.diff.includes('+new'), true)

  const huge = remoteToolRecord(tool({
    input: `{"command":"${'x'.repeat(200_000)}"}`,
    output: 'y'.repeat(400_000),
    diff: 'z'.repeat(400_000),
  }))
  assert.ok(huge.input.length < 60_000, `input stayed large: ${huge.input.length}`)
  assert.ok(huge.output.length < 200_000, `output stayed large: ${huge.output.length}`)
  assert.ok(huge.diff.length < 200_000, `diff stayed large: ${huge.diff.length}`)
  assert.match(huge.input, /truncated for remote display/)
  assert.match(huge.output, /truncated for remote display/)
  assert.match(huge.diff, /truncated for remote display/)
})

test('a missing field in a tool record is empty rather than undefined', () => {
  const record = remoteToolRecord({ id: 'tool_2', name: 'edit', input: '', state: 'running' })
  assert.deepEqual({ input: record.input, output: record.output, diff: record.diff, attachments: record.attachments }, { input: '', output: '', diff: '', attachments: [] })
})

test('a fan-out reaches the controller with its lines, bounded per line', () => {
  const fanout = {
    startedAt: 1_000,
    running: true,
    done: 1,
    failed: 1,
    lines: [
      { question: 'first line', state: 'done' as const, seconds: 12, finding: 'x'.repeat(9_000) },
      { question: 'second line', state: 'running' as const },
    ],
  }
  const event = remoteTaskEvent({
    taskId: 'task-1',
    seq: 12,
    at: 300,
    payload: { type: 'agent', runId: 'run-1', event: { id: 'run-1', type: 'tool', tool: { id: 'fanout-1', name: 'research_fanout', input: '{"questions":["first line"]}', state: 'running', output: '', fanout } } },
  })
  const tool = (event.payload as any).entry.tool
  assert.equal(tool.fanout.running, true)
  assert.equal(tool.fanout.done, 1)
  assert.deepEqual(tool.fanout.lines.map((line: any) => line.state), ['done', 'running'])
  // The controller is a bounded frame: one line cannot carry a transcript's worth of finding.
  assert.match(tool.fanout.lines[0].finding, /truncated for remote display/)
  assert.ok(tool.fanout.lines[0].finding.length < 2_200, `bound held: ${tool.fanout.lines[0].finding.length}`)

  const withoutLines = remoteTaskEvent({
    taskId: 'task-1',
    seq: 13,
    at: 301,
    payload: { type: 'agent', runId: 'run-1', event: { id: 'run-1', type: 'tool', tool: { id: 'fanout-2', name: 'research_fanout', input: '{}', state: 'done', output: 'ok' } } },
  })
  assert.equal((withoutLines.payload as any).entry.tool.fanout, undefined)
})

test('a fan-out names itself on the wire instead of sending a raw tool name', () => {
  const event = remoteTaskEvent({
    taskId: 'task-1',
    seq: 14,
    at: 302,
    payload: { type: 'agent', runId: 'run-1', event: { id: 'run-1', type: 'tool', tool: { id: 'fanout-3', name: 'research_fanout', input: '{"questions":["one","two","three"]}', state: 'running', output: '' } } },
  })
  const tool = (event.payload as any).entry.tool
  assert.equal(tool.presentation.key, 'tool.research_fanout.running')
  assert.equal(tool.presentation.fallbackTitle, 'Researching several lines at once')
  assert.equal(tool.presentation.fallbackDetail, '3 lines')
  assert.notEqual(tool.presentation.fallbackTitle, 'research_fanout')

  const settled = remoteTaskEvent({
    taskId: 'task-1',
    seq: 15,
    at: 303,
    payload: { type: 'agent', runId: 'run-1', event: { id: 'run-1', type: 'tool', tool: { id: 'fanout-4', name: 'research_fanout', input: '{}', state: 'done', output: 'ok' } } },
  })
  assert.equal((settled.payload as any).entry.tool.presentation.key, 'tool.research_fanout.done')
  assert.equal((settled.payload as any).entry.tool.presentation.fallbackDetail, 'independent lines of inquiry')
})

/**
 * The conditions a task must satisfy travel to the other machine the way its title does,
 * because the menu that declares them is on both sides of a link. They are bounded like every
 * other field a peer receives: a condition the peer cannot read back is one it cannot correct.
 */
test('a declared goal travels to the other machine, bounded, and only when it has checks', () => {
  const task = {
    id: 'task-goal', title: 'Ship the importer', workspace: '/workspace', createdAt: 1, updatedAt: 2,
    goal: {
      objective: 'Ship the importer',
      checks: [
        { id: 'check-1', kind: 'file' as const, path: 'dist/report.md', description: 'file:dist/report.md' },
        { id: 'check-2', kind: 'command' as const, command: 'pnpm test', description: 'run:pnpm test' },
      ],
      maxContinuations: 3,
    },
    turns: [],
  }
  const snapshot = remoteTaskSnapshot(task) as any
  assert.deepEqual(snapshot.goal, {
    objective: 'Ship the importer',
    checks: [
      { id: 'check-1', kind: 'file', description: 'file:dist/report.md', path: 'dist/report.md' },
      { id: 'check-2', kind: 'command', description: 'run:pnpm test', command: 'pnpm test' },
    ],
    maxContinuations: 3,
  })
  assert.deepEqual((remoteTaskList([task], {})[0] as any).goal, snapshot.goal)

  // A task with no requirement carries no field.
  const plain = remoteTaskSnapshot({ id: 'task-plain', title: 'Chat', workspace: '/workspace', createdAt: 1, updatedAt: 2, turns: [] }) as any
  assert.equal('goal' in plain, false)
  // …and one whose requirement has nothing to decide is not silence either: the other machine
  // shows the objective, because that is what the run is being held to.
  const undecidable = { id: 'task-goal', title: 'Earn', workspace: '/workspace', createdAt: 1, updatedAt: 2, goal: { objective: '拿到赏金', checks: [] }, turns: [] }
  assert.deepEqual((remoteTaskSnapshot(undecidable as any) as any).goal, { objective: '拿到赏金', checks: [] })
  assert.deepEqual((remoteTaskList([undecidable as any], {})[0] as any).goal, { objective: '拿到赏金', checks: [] })

  // An objective is a sentence, not a document, and a condition travels only as far as a
  // person on the other machine could still read it back.
  const long = remoteTaskSnapshot({ ...task, goal: { objective: 'x'.repeat(9000), checks: task.goal.checks } }) as any
  assert.ok(long.goal.objective.length < 9000)
  assert.match(long.goal.objective, /truncated for remote display/)
})

/** A goal declared on the machine that owns the task reaches a watching controller too. */
test('a goal change travels to a controller as a patch on the task it belongs to', () => {
  const patched = remoteTaskEvent({
    taskId: 'task-1', seq: 16, at: 400,
    payload: { type: 'remote', event: { kind: 'task.goal', goal: { objective: 'Ship it', checks: [{ id: 'check-1', kind: 'file' as const, path: 'a.md', description: 'file:a.md' }] } } },
  })
  assert.equal(patched.type, 'task.patch')
  assert.deepEqual((patched.payload as any).goal, {
    objective: 'Ship it',
    checks: [{ id: 'check-1', kind: 'file', description: 'file:a.md', path: 'a.md' }],
  })

  // Taking the conditions back is a patch too, and it says so rather than saying nothing.
  const cleared = remoteTaskEvent({ taskId: 'task-1', seq: 17, at: 401, payload: { type: 'remote', event: { kind: 'task.goal' } } })
  assert.equal(cleared.type, 'task.patch')
  assert.equal((cleared.payload as any).goal, null)
})


/** A requirement read out of the person's message is a fact about the task, on both machines. */
test('a goal read out of the conversation reaches a controller as a patch on its task', () => {
  const patched = remoteTaskEvent({
    taskId: 'task-1', seq: 20, at: 500,
    payload: { type: 'agent', runId: 'run-1', event: { id: 'run-1', type: 'goal', goal: { objective: '没写进 reports/x.md 就别停', checks: [{ id: 'check-1', kind: 'file' as const, path: 'reports/x.md', description: 'file:reports/x.md' }] } } },
  })
  assert.equal(patched.type, 'task.patch')
  assert.deepEqual((patched.payload as any).goal, {
    objective: '没写进 reports/x.md 就别停',
    checks: [{ id: 'check-1', kind: 'file', description: 'file:reports/x.md', path: 'reports/x.md' }],
  })

  // A requirement with nothing decidable travels as an objective with no checks — not as silence.
  const undecidable = remoteTaskEvent({
    taskId: 'task-1', seq: 21, at: 501,
    payload: { type: 'agent', runId: 'run-1', event: { id: 'run-1', type: 'goal', goal: { objective: '拿到赏金', checks: [] } } },
  })
  assert.deepEqual((undecidable.payload as any).goal, { objective: '拿到赏金', checks: [] })
})
