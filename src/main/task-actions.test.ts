import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { TaskActions } from '../renderer/src/task-actions.ts'

test('a task leaves the view immediately while its run settles before data cleanup', async () => {
  const actions = new TaskActions()
  let settle!: () => void
  const stopped = new Promise<void>(resolve => { settle = resolve })
  const events: string[] = []
  const done = actions.run('task-a', async () => {
    events.push('new-task-page')
    await stopped
    events.push('stopped')
  }, () => { events.push('data-removed') })
  assert.deepEqual(events, ['new-task-page'])
  assert.equal(actions.has('task-a'), true)
  assert.equal(await actions.run('task-a', async () => { throw Error('duplicate') }, () => {}), false)
  assert.equal(await actions.run('task-b', async () => {}, () => {}), true)
  settle()
  assert.equal(await done, true)
  assert.deepEqual(events, ['new-task-page', 'stopped', 'data-removed'])
  assert.equal(actions.has('task-a'), false)
})

test('a failed stop does not delete data and a failed cleanup releases the task action', async () => {
  const actions = new TaskActions()
  let removed = false
  await assert.rejects(actions.run('task-a', async () => { throw Error('stop failed') }, () => { removed = true }), /stop failed/)
  assert.equal(removed, false)
  assert.equal(actions.has('task-a'), false)
  await assert.rejects(actions.run('task-a', async () => {}, () => { throw Error('cleanup failed') }), /cleanup failed/)
  assert.equal(actions.has('task-a'), false)
})

test('task action wiring updates the view before stopping and blocks queued and new work', async () => {
  const source = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  const action = source.slice(source.indexOf('async function withTaskAction'), source.indexOf('function commitTaskExit'))
  assert.match(action, /setQueued[\s\S]*change\(\);\s+await window.shun.stopTask\(id\)/)
  assert.match(source, /nextRunnablePrompt\(queued.filter\(item => !taskActions.current.has\(item.taskId\)\)/)
  assert.match(source, /if \(target && taskActions.current.has\(target.id\)\) return false/)
  assert.doesNotMatch(source, /disabled=\{isRunning\((?:item|task)\)\}/)
  assert.doesNotMatch(source, /disabled=\{remote.view\?\.status === "running"\}/)
})
