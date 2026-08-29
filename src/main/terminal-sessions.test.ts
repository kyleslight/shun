import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalSessionManager } from './terminal-sessions.ts'

function fakePty() {
  let dataListener: (value: string) => void = () => {}
  let exitListener: (event: { exitCode: number; signal?: number }) => void = () => {}
  const writes: string[] = [], sizes: Array<[number, number]> = []
  let killed = false
  return {
    process: {
      pid: 42,
      write: (value: string) => writes.push(value),
      resize: (cols: number, rows: number) => sizes.push([cols, rows]),
      kill: () => { killed = true },
      onData: (listener: (value: string) => void) => { dataListener = listener; return { dispose() {} } },
      onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => { exitListener = listener; return { dispose() {} } },
    },
    writes,
    sizes,
    data: (value: string) => dataListener(value),
    exit: (exitCode: number) => exitListener({ exitCode }),
    killed: () => killed,
  }
}

test('interactive terminal streams data, accepts input, and clamps resize dimensions', () => {
  const child = fakePty(), events: any[] = []
  let spawnOptions: any
  const manager = new TerminalSessionManager((_file, _args, options) => { spawnOptions = options; return child.process as any })
  const opened = manager.open({ accessToken: 'view-a', taskId: 'task-a', workspace: '/workspace-a', cols: 90, rows: 30, emit: event => events.push(event) })
  assert.equal(opened.pid, 42)
  assert.equal(spawnOptions.env.TERM, 'xterm-256color')
  manager.write('view-a', 'printf hello\r')
  assert.deepEqual(child.writes, ['printf hello\r'])
  assert.deepEqual(manager.resize('view-a', 1, 999), { cols: 2, rows: 300 })
  assert.deepEqual(child.sizes, [[2, 300]])
  child.data('hello')
  assert.deepEqual(events[0], { accessToken: 'view-a', sessionId: opened.sessionId, type: 'data', data: 'hello' })
  child.exit(0)
  assert.deepEqual(events[1], { accessToken: 'view-a', sessionId: opened.sessionId, type: 'exit', exitCode: 0 })
  assert.throws(() => manager.write('view-a', 'x'), /not running/)
})

test('terminal sessions are task-isolated and closing a view releases its process', () => {
  const first = fakePty(), second = fakePty(), children = [first, second]
  const manager = new TerminalSessionManager(() => children.shift()!.process as any)
  manager.open({ accessToken: 'view-a', taskId: 'task-a', workspace: '/workspace-a', emit() {} })
  manager.open({ accessToken: 'view-b', taskId: 'task-b', workspace: '/workspace-b', emit() {} })
  assert.equal(manager.closeTask('task-a'), 1)
  assert.equal(first.killed(), true)
  assert.equal(second.killed(), false)
  assert.equal(manager.closeAccess('view-b'), true)
  assert.equal(second.killed(), true)
  assert.equal(manager.closeAccess('view-b'), false)
})

test('terminal rejects oversized writes before they reach the PTY', () => {
  const child = fakePty()
  const manager = new TerminalSessionManager(() => child.process as any)
  manager.open({ accessToken: 'view-a', taskId: 'task-a', workspace: '/workspace-a', emit() {} })
  assert.throws(() => manager.write('view-a', 'x'.repeat(64 * 1024 + 1)), /64 KiB/)
  assert.deepEqual(child.writes, [])
  manager.dispose()
})
