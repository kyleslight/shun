import test from 'node:test'
import assert from 'node:assert/strict'
import { continueAssistantTask } from './assistant-task-continuation.ts'
import type { Task } from '../shared.ts'

const child: Task = { id: 'video', parentTaskId: 'assistant', title: 'Video', workspace: '/project', turns: [{ id: 'reply', role: 'assistant', content: 'Original result' }], createdAt: 1, updatedAt: 2 }

test('feedback continues the same completed task with its workspace and history', async () => {
  const result = await continueAssistantTask([child], 'assistant', { taskId: 'video', prompt: 'Fix the voice, keep the script' }, {
    active: () => undefined, enqueue: async () => {},
    stop: async () => { assert.fail('idle task must not be stopped') },
    run: async (task, prompt) => {
      assert.equal(task, child)
      assert.equal(task.turns[0].content, 'Original result')
      assert.equal(task.workspace, '/project')
      assert.equal(prompt, 'Fix the voice, keep the script')
      return { taskId: task.id, title: task.title }
    },
  })
  assert.equal(result.taskId, 'video')
})

test('a running correction waits for the old execution to settle before continuing', async () => {
  const events: string[] = []
  const operations = {
    active: () => 'run',
    enqueue: async (_task: Task, prompt: string) => { events.push(`queued:${prompt}`) },
    stop: async () => { events.push('stop'); await Promise.resolve(); events.push('settled') },
    run: async (task: Task) => { events.push('continue'); return { taskId: task.id, title: task.title } },
  }
  const queued = await continueAssistantTask([child], 'assistant', { taskId: 'video', prompt: 'Keep going', interrupt: false }, operations)
  assert.equal(queued.queued, true)
  assert.equal(queued.delivery, 'queued')
  assert.equal(queued.applied, false)
  assert.deepEqual(events, ['queued:Keep going'])
  events.length = 0
  const delivered = await continueAssistantTask([child], 'assistant', { taskId: 'video', prompt: 'Correction' }, operations)
  assert.equal(delivered.delivery, 'started')
  assert.equal(delivered.applied, false)
  assert.equal(delivered.queued, false)
  assert.deepEqual(events, ['queued:Correction', 'stop', 'settled', 'continue'])
})

test('continuation cannot target another assistant or a scheduled background check', async () => {
  const operations = { active: () => undefined, enqueue: async () => {}, stop: async () => {}, run: async () => { assert.fail('must not run') } }
  await assert.rejects(continueAssistantTask([child], 'other', { taskId: 'video', prompt: 'Change' }, operations), /existing delegated/)
  await assert.rejects(continueAssistantTask([{ ...child, purpose: 'background' }], 'assistant', { taskId: 'video', prompt: 'Change' }, operations), /existing delegated/)
})

test('failed delivery never returns a started receipt', async () => {
  await assert.rejects(continueAssistantTask([child], 'assistant', { taskId: 'video', prompt: 'Correction' }, {
    active: () => 'old', enqueue: async () => {},
    stop: async () => { throw Error('stop failed') },
    run: async () => { assert.fail('must not overlap runs') },
  }), /stop failed/)
})

 test('a correction is retained before cancellation fails and can be retried after restart', async () => {
  const inbox: string[] = []
  await assert.rejects(continueAssistantTask([child], 'assistant', { taskId: 'video', prompt: 'New direction' }, {
    active: () => 'old', enqueue: async (_task, text) => { inbox.push(text) },
    stop: async () => { assert.deepEqual(inbox, ['New direction']); throw Error('shutdown') },
    run: async () => assert.fail('cannot start while old run is unsettled'),
  }), /shutdown/)
  assert.deepEqual(inbox, ['New direction'])
})

test('a cancelled coordinator delivery cannot execute later behind another delivery', async () => {
  const { AssistantTaskDeliveryQueue } = await import('./assistant-task-continuation.ts')
  const queue = new AssistantTaskDeliveryQueue()
  let release!: () => void
  const first = queue.deliver('rss', () => new Promise<void>(resolve => { release = resolve }))
  await Promise.resolve()
  await Promise.resolve()
  const controller = new AbortController()
  const stale = queue.deliver('rss', async () => { assert.fail('cancelled message must not be delivered') }, controller.signal)
  controller.abort()
  const rejected = assert.rejects(stale, /abort/i)
  assert.equal(await queue.deliver('dimsum', async () => 'independent'), 'independent')
  release()
  await first
  await rejected
})
