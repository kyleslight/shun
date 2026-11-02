import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { AssistantIdleMaintenance } from './assistant-idle-maintenance.ts'
import { AssistantTaskDeliveryQueue } from './assistant-task-continuation.ts'

test('foreground cancels maintenance and waits for disposal before touching the session', async () => {
  const service = new AssistantIdleMaintenance(1), events: string[] = []
  service.schedule(() => true, signal => new Promise<void>(resolve => {
    events.push('start')
    signal.addEventListener('abort', () => { events.push('cancel'); setTimeout(() => { events.push('disposed'); resolve() }, 5) })
  }), error => assert.fail(String(error)))
  await delay(15)
  await service.yieldToForeground()
  events.push('foreground')
  assert.deepEqual(events, ['start', 'cancel', 'disposed', 'foreground'])
})

test('pending or busy maintenance never competes with foreground', async () => {
  const service = new AssistantIdleMaintenance(1)
  service.schedule(() => false, async () => assert.fail('busy'), error => assert.fail(String(error)))
  await delay(10)
  service.schedule(() => true, async () => assert.fail('cancelled timer'), error => assert.fail(String(error)))
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
