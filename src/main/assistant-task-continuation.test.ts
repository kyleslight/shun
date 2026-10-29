import test from 'node:test'
import assert from 'node:assert/strict'
import { continueAssistantTask } from './assistant-task-continuation.ts'
import type { Task } from '../shared.ts'

const child: Task = { id: 'video', parentTaskId: 'assistant', title: 'Video', workspace: '/project', turns: [{ id: 'reply', role: 'assistant', content: 'Original result' }], createdAt: 1, updatedAt: 2 }

test('feedback continues the same completed task with its workspace and history', async () => {
  const result = await continueAssistantTask([child], 'assistant', { taskId: 'video', prompt: 'Fix the voice, keep the script' }, {
    active: () => undefined,
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
    stop: async () => { events.push('stop'); await Promise.resolve(); events.push('settled') },
    run: async (task: Task) => { events.push('continue'); return { taskId: task.id, title: task.title } },
  }
  await assert.rejects(continueAssistantTask([child], 'assistant', { taskId: 'video', prompt: 'Correction' }, operations), /running/)
  assert.deepEqual(events, [])
  await continueAssistantTask([child], 'assistant', { taskId: 'video', prompt: 'Correction', interrupt: true }, operations)
  assert.deepEqual(events, ['stop', 'settled', 'continue'])
})

test('continuation cannot target another assistant or a scheduled background check', async () => {
  const operations = { active: () => undefined, stop: async () => {}, run: async () => { assert.fail('must not run') } }
  await assert.rejects(continueAssistantTask([child], 'other', { taskId: 'video', prompt: 'Change' }, operations), /existing delegated/)
  await assert.rejects(continueAssistantTask([{ ...child, purpose: 'background' }], 'assistant', { taskId: 'video', prompt: 'Change' }, operations), /existing delegated/)
})
