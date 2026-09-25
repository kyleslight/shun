import assert from 'node:assert/strict'
import test from 'node:test'
import type { TerminalSessionEvent } from '../shared.ts'
import type { TerminalSessionManager } from './terminal-sessions.ts'
import {
  RemoteTerminals, TERMINAL_FRAME_LIMIT_BYTES, TERMINAL_QUEUE_LIMIT_BYTES, TERMINAL_TRUNCATION_NOTICE, TerminalOutputStream,
  appendTerminalOutput, takeTerminalFrame,
} from './remote-terminal.ts'

test('a burst of output leaves as one frame instead of one frame per write', async () => {
  const frames: string[] = []
  const stream = new TerminalOutputStream(data => frames.push(data))
  try {
    stream.push('a')
    stream.push('b')
    stream.push('c')
    assert.deepEqual(frames, [])
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.deepEqual(frames, ['abc'])
  } finally {
    stream.dispose()
  }
})

test('output that outruns the flush keeps its order and loses nothing', async () => {
  const frames: string[] = []
  const stream = new TerminalOutputStream(data => frames.push(data))
  try {
    const chunk = 'x'.repeat(TERMINAL_FRAME_LIMIT_BYTES)
    stream.push(chunk)
    stream.push(chunk)
    stream.push('tail')
    await new Promise(resolve => setTimeout(resolve, 160))
    assert.equal(frames.join(''), `${chunk}${chunk}tail`)
    assert.ok(frames.length >= 2)
    for (const frame of frames) assert.ok(Buffer.byteLength(frame, 'utf8') <= TERMINAL_FRAME_LIMIT_BYTES)
  } finally {
    stream.dispose()
  }
})

test('a frame is cut on a character boundary, so no output is corrupted', () => {
  const text = '好'.repeat(TERMINAL_FRAME_LIMIT_BYTES)
  const { frame, rest } = takeTerminalFrame(text)
  assert.ok(Buffer.byteLength(frame, 'utf8') <= TERMINAL_FRAME_LIMIT_BYTES)
  assert.equal(frame.endsWith('\uFFFD'), false)
  assert.equal(rest.startsWith('\uFFFD'), false)
  assert.equal(frame + rest, text)

  const small = takeTerminalFrame('short')
  assert.deepEqual(small, { frame: 'short', rest: '' })
})

test('a controller that falls far behind loses the oldest output and is told so', () => {
  const chunk = 'y'.repeat(TERMINAL_QUEUE_LIMIT_BYTES)
  const { queue, dropped } = appendTerminalOutput(chunk, 'newest')
  assert.equal(dropped, true)
  assert.ok(queue.endsWith('newest'))
  assert.equal(queue.startsWith('\uFFFD'), false)
  assert.ok(Buffer.byteLength(queue, 'utf8') <= TERMINAL_QUEUE_LIMIT_BYTES)

  const kept = appendTerminalOutput('keep', 'growing')
  assert.deepEqual(kept, { queue: 'keepgrowing', dropped: false })
})

test('the stream reports dropped output once, in the stream itself', async () => {
  const frames: string[] = []
  const stream = new TerminalOutputStream(data => frames.push(data), { flushMs: 1 })
  try {
    stream.push('z'.repeat(TERMINAL_QUEUE_LIMIT_BYTES + 10))
    stream.push('after')
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && !frames.join('').endsWith('after')) await new Promise(resolve => setTimeout(resolve, 5))
    const output = frames.join('')
    assert.equal(output.includes(TERMINAL_TRUNCATION_NOTICE), true)
    assert.equal(output.endsWith('after'), true)
    // The notice is delivered once, however many frames the loss spans.
    assert.equal(output.split(TERMINAL_TRUNCATION_NOTICE).length, 2)
  } finally {
    stream.dispose()
  }
})

type FakeManager = TerminalSessionManager & { opens: Array<{ accessToken: string; taskId: string; workspace: string }>; writes: string[]; resizes: Array<[unknown, unknown]>; closed: string[]; emit: (event: TerminalSessionEvent) => void }

function fakeManager(): FakeManager {
  let emit: (event: TerminalSessionEvent) => void = () => {}
  const manager = {
    opens: [] as Array<{ accessToken: string; taskId: string; workspace: string }>,
    writes: [] as string[],
    resizes: [] as Array<[unknown, unknown]>,
    closed: [] as string[],
    emit: (event: TerminalSessionEvent) => emit(event),
    open(input: { accessToken: string; taskId: string; workspace: string; emit: (event: TerminalSessionEvent) => void }) {
      manager.opens.push({ accessToken: input.accessToken, taskId: input.taskId, workspace: input.workspace })
      emit = input.emit
      return { sessionId: 'session-1' }
    },
    write(accessToken: string, data: unknown) { manager.writes.push(`${accessToken}:${String(data)}`) },
    resize(accessToken: string, cols: unknown, rows: unknown) { manager.resizes.push([cols, rows]); return { accessToken } },
    closeAccess(accessToken: string) { manager.closed.push(accessToken); return true },
  }
  return manager as unknown as FakeManager
}

test('a remote terminal belongs to the link that opened it, and answers with its output', async () => {
  const manager = fakeManager()
  const pushes: Array<{ linkId: string; event: unknown }> = []
  const terminals = new RemoteTerminals(manager, (linkId, event) => pushes.push({ linkId, event }))
  try {
    const { terminalId } = terminals.open({ linkId: 'link-a', taskId: 'task_1', workspace: '/tmp/work', cols: 120, rows: 30 })
    assert.ok(terminalId)
    assert.deepEqual(manager.opens, [{ accessToken: `remote:link-a:${terminalId}`, taskId: 'task_1', workspace: '/tmp/work' }])

    terminals.write(terminalId, 'ls\r')
    terminals.resize(terminalId, 100, 20)
    assert.deepEqual(manager.writes, [`remote:link-a:${terminalId}:ls\r`])
    assert.deepEqual(manager.resizes, [[100, 20]])

    manager.emit({ accessToken: `remote:link-a:${terminalId}`, sessionId: 'session-1', type: 'data', data: 'hello' })
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.deepEqual(pushes.map(item => item.linkId), ['link-a'])
    assert.deepEqual(pushes[0].event, { type: 'terminal.data', taskId: 'task_1', terminalId, data: 'hello' })

    manager.emit({ accessToken: `remote:link-a:${terminalId}`, sessionId: 'session-1', type: 'exit', exitCode: 2 })
    assert.deepEqual(pushes.at(-1)?.event, { type: 'terminal.exit', taskId: 'task_1', terminalId, exitCode: 2 })
    // A finished session is gone: writing to it is an error, not a silent write.
    assert.throws(() => terminals.write(terminalId, 'x'), /no longer running/)
  } finally {
    terminals.dispose()
  }
})

test('a terminal does not outlive the link that holds it', () => {
  const manager = fakeManager()
  const terminals = new RemoteTerminals(manager, () => {})
  const mine = terminals.open({ linkId: 'link-a', taskId: 'task_1', workspace: '/tmp/work' })
  const theirs = terminals.open({ linkId: 'link-b', taskId: 'task_2', workspace: '/tmp/other' })
  terminals.closeLink('link-a')
  assert.deepEqual(manager.closed, [`remote:link-a:${mine.terminalId}`])
  assert.throws(() => terminals.write(mine.terminalId, 'x'), /no longer running/)
  // The other controller's terminal is untouched.
  terminals.write(theirs.terminalId, 'pwd\r')
  assert.equal(manager.writes.length, 1)

  terminals.dispose()
  assert.deepEqual(manager.closed, [`remote:link-a:${mine.terminalId}`, `remote:link-b:${theirs.terminalId}`])
})

test('closing a terminal this peer opened is idempotent', () => {
  const manager = fakeManager()
  const terminals = new RemoteTerminals(manager, () => {})
  const { terminalId } = terminals.open({ linkId: 'link-a', taskId: 'task_1', workspace: '/tmp/work' })
  assert.deepEqual(terminals.close(terminalId), { closed: true })
  assert.deepEqual(terminals.close(terminalId), { closed: false })
  terminals.dispose()
})
