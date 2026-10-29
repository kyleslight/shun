import test from 'node:test'
import assert from 'node:assert/strict'
import { scheduleDisplay } from './schedule-display.ts'
import type { LocalSchedule } from '../shared.ts'
const schedule: LocalSchedule = { id: 'schedule', taskId: 'assistant', name: 'Brief', prompt: 'Report hourly', trigger: { kind: 'cron', expression: '0 * * * *', timezone: 'Asia/Shanghai' }, status: 'active', missedPolicy: 'skip', createdAt: 1, updatedAt: Date.parse('2026-10-29T11:09:07Z'), lastRunAt: 1793271602607, nextRunAt: 1793275200000 }

test('schedule evidence includes local hours, timezone, UTC and unchanged timestamps', () => {
  const display = scheduleDisplay(schedule, Date.parse('2026-10-29T11:25:00Z'))
  assert.equal(display.lastRunAt, 1793271602607)
  assert.deepEqual(display.times.lastRun, { iso: '2026-10-29T11:00:02.607Z', local: '29/10/2026, 19:00:02', timezone: 'Asia/Shanghai' })
  assert.equal(display.times.nextRun?.local, '29/10/2026, 20:00:00')
  assert.equal(display.times.now?.local, '29/10/2026, 19:25:00')
})

test('formatting follows daylight saving rather than a fixed offset and preserves missing times', () => {
  const display = scheduleDisplay({ ...schedule, trigger: { kind: 'cron', expression: '0 * * * *', timezone: 'America/New_York' }, lastRunAt: Date.parse('2026-11-01T05:00:00Z'), nextRunAt: Date.parse('2026-11-01T06:00:00Z') })
  assert.equal(display.times.lastRun?.local, display.times.nextRun?.local)
  assert.notEqual(display.times.lastRun?.iso, display.times.nextRun?.iso)
  assert.equal(scheduleDisplay({ ...schedule, lastRunAt: undefined }).times.lastRun, null)
})
