import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { LocalScheduleManager, type LocalScheduleOccurrence } from './local-schedules.ts'
import type { LocalSchedule } from '../shared.ts'

async function eventually(check: () => boolean, timeout = 1_000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw Error('Timed out waiting for scheduled task state.')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('one-shot schedules persist, run through a durable occurrence, and complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-schedule-')), file = join(root, 'schedules.json')
  let now = Date.parse('2026-08-28T01:00:00.000Z')
  const delivered: Array<{ schedule: LocalSchedule; occurrence: LocalScheduleOccurrence }> = []
  const manager = new LocalScheduleManager(file, (schedule, occurrence) => { delivered.push({ schedule, occurrence }) }, () => {}, () => now)
  await manager.init()
  const schedule = await manager.create({ taskId: 'task_1', name: 'Review', prompt: 'Review the workspace', trigger: { kind: 'once', at: '2026-08-28T02:00:00.000Z' } })
  assert.equal(schedule.status, 'active')
  assert.equal(schedule.nextRunAt, Date.parse('2026-08-28T02:00:00.000Z'))
  const renamed = await manager.update(schedule.id, { name: 'Review carefully' })
  assert.equal(renamed.nextRunAt, schedule.nextRunAt)

  now = Date.parse('2026-08-28T02:00:00.000Z')
  manager.refresh()
  await eventually(() => delivered.length === 1)
  assert.equal(manager.get(schedule.id)?.status, 'completed')
  assert.equal(manager.get(schedule.id)?.lastStatus, 'queued')
  await manager.markRunning(delivered[0].occurrence.id)
  await manager.finishOccurrence(delivered[0].occurrence.id)
  assert.equal(manager.get(schedule.id)?.lastStatus, 'succeeded')
  manager.dispose()
})

test('restart coalesces a missed recurring schedule into one pending occurrence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-schedule-restart-')), file = join(root, 'schedules.json')
  await mkdir(root, { recursive: true })
  await writeFile(file, JSON.stringify({
    version: 1,
    schedules: [{
      id: 'schedule_1', taskId: 'task_1', name: 'Hourly', prompt: 'Check status', trigger: { kind: 'cron', expression: '0 * * * *', timezone: 'UTC' }, status: 'active', missedPolicy: 'run_once', nextRunAt: Date.parse('2026-08-28T01:00:00.000Z'), createdAt: 1, updatedAt: 1,
    }],
    pending: [],
  }))
  const delivered: LocalScheduleOccurrence[] = [], now = Date.parse('2026-08-28T05:23:00.000Z')
  const manager = new LocalScheduleManager(file, (_schedule, occurrence) => { delivered.push(occurrence) }, () => {}, () => now)
  await manager.init()
  await eventually(() => delivered.length === 1)
  assert.equal(delivered[0].dueAt, Date.parse('2026-08-28T01:00:00.000Z'))
  assert.equal(manager.get('schedule_1')?.nextRunAt, Date.parse('2026-08-28T06:00:00.000Z'))
  manager.refresh()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(delivered.length, 1)
  manager.dispose()
})

test('a running occurrence interrupted by restart is failed instead of duplicated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-schedule-running-')), file = join(root, 'schedules.json')
  await writeFile(file, JSON.stringify({
    version: 1,
    schedules: [{
      id: 'schedule_1', taskId: 'task_1', name: 'Once', prompt: 'Do work', trigger: { kind: 'once', at: '2026-08-28T02:00:00.000Z' }, status: 'completed', missedPolicy: 'run_once', lastStatus: 'running', createdAt: 1, updatedAt: 1,
    }],
    pending: [{ id: 'schedule_1:1', scheduleId: 'schedule_1', dueAt: 1, queuedAt: 1, state: 'running' }],
  }))
  let deliveries = 0
  const manager = new LocalScheduleManager(file, () => { deliveries += 1 })
  await manager.init()
  assert.equal(deliveries, 0)
  assert.equal(manager.get('schedule_1')?.lastStatus, 'failed')
  assert.match(manager.get('schedule_1')?.lastError || '', /interrupted/i)
  manager.dispose()
})

test('cron schedules require five fields and a valid IANA timezone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-schedule-validation-'))
  const manager = new LocalScheduleManager(join(root, 'schedules.json'), () => {})
  await manager.init()
  await assert.rejects(() => manager.create({ taskId: 'task_1', name: 'Bad', prompt: 'Check', trigger: { kind: 'cron', expression: '* * * * * *', timezone: 'UTC' } }), /five fields/i)
  await assert.rejects(() => manager.create({ taskId: 'task_1', name: 'Bad', prompt: 'Check', trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'Moon\/Base' } }), /IANA timezone/i)
  manager.dispose()
})
