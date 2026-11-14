import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { AssistantIdleMaintenance } from './assistant-idle-maintenance.ts'
import { AssistantTaskDeliveryQueue } from './assistant-task-continuation.ts'

test('foreground cancels maintenance and waits for disposal before touching the session', async () => {
  const service = new AssistantIdleMaintenance(1), events: string[] = []
  let ready = true
  service.schedule(() => ready, signal => new Promise<void>(resolve => {
    events.push('start')
    signal.addEventListener('abort', () => { events.push('cancel'); setTimeout(() => { events.push('disposed'); resolve() }, 5) })
  }), error => assert.fail(String(error)))
  await delay(15)
  ready = false
  await service.yieldToForeground()
  events.push('foreground')
  assert.deepEqual(events, ['start', 'cancel', 'disposed', 'foreground'])
})

test('pending or busy maintenance never competes with foreground', async () => {
  const service = new AssistantIdleMaintenance(1)
  service.schedule(() => false, async () => assert.fail('busy'), error => assert.fail(String(error)))
  await delay(10)
  service.schedule(() => false, async () => assert.fail('foreground busy'), error => assert.fail(String(error)))
  await service.yieldToForeground()
  await delay(10)
})

test('corrections to the same task retain arrival order while another task proceeds', async () => {
  const queue = new AssistantTaskDeliveryQueue(), events: string[] = []
  let release!: () => void
  const first = queue.deliver('video', async () => { events.push('first'); await new Promise<void>(resolve => { release = resolve }); events.push('first-done') })
  const second = queue.deliver('video', async () => { events.push('correction') })
  await queue.deliver('mail', async () => { events.push('mail') })
  assert.deepEqual(events, ['first', 'mail'])
  release()
  await Promise.all([first, second])
  assert.deepEqual(events, ['first', 'mail', 'first-done', 'correction'])
})


test('idle work for independent sessions is not overwritten and interrupted work resumes', async () => {
  const service = new AssistantIdleMaintenance(1), completed: string[] = []
  let ready = true, started!: () => void
  const began = new Promise<void>(resolve => { started = resolve })
  let attempts = 0
  service.schedule(() => ready, async signal => {
    if (++attempts === 1) { started(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())); return }
    completed.push('child')
  }, error => assert.fail(String(error)), 'child')
  await Promise.all([began, delay(10)])
  ready = false
  await service.yieldToForeground()
  service.schedule(() => ready, async () => { completed.push('parent') }, error => assert.fail(String(error)), 'parent')
  ready = true
  await delay(30)
  assert.deepEqual(completed.sort(), ['child', 'parent'])
  assert.equal(attempts, 2)
})


test('another task does not wait for a slow compaction cancellation', async () => {
  const service = new AssistantIdleMaintenance(1)
  let started!: () => void, finish!: () => void, ready = true, aborted = false
  const began = new Promise<void>(resolve => { started = resolve })
  service.schedule(() => ready, signal => new Promise<void>(resolve => {
    finish = resolve; started(); signal.addEventListener('abort', () => { aborted = true })
  }), error => assert.fail(String(error)), 'child')
  await Promise.all([began, delay(15)])
  ready = false
  await service.yieldToForeground('parent')
  assert.equal(aborted, true)
  let settled = false
  const sameSession = service.yieldToForeground('child').then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  finish()
  await sameSession
})
