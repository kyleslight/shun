import type { LocalSchedule } from '../shared.ts'

export function scheduleDisplay(schedule: LocalSchedule, now = Date.now()) {
  const timezone = schedule.trigger.kind === 'cron' ? schedule.trigger.timezone : 'UTC'
  const format = (timestamp: number | undefined) => timestamp === undefined ? null : {
    iso: new Date(timestamp).toISOString(),
    local: new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(timestamp),
    timezone,
  }
  return { ...schedule, times: {
    now: format(now), nextRun: format(schedule.nextRunAt), lastRun: format(schedule.lastRunAt), updated: format(schedule.updatedAt),
  } }
}
