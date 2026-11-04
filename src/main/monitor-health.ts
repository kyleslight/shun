import type { SavedState } from '../shared.ts'

export type MonitorIssue = { name: string; firstFailedAt?: number; failures?: number }
const OUTAGE_GRACE = 30 * 60_000
const NOTICE_INTERVAL = 24 * 60 * 60_000

/** Connection health belongs to monitoring status. Only a sustained interruption
 * merits a compact, grouped notice in the conversation; source events use their
 * own durable delivery path and are never suppressed by this policy. */
export function reportMonitorHealth(state: SavedState, parentId: string, issues: MonitorIssue[], now = Date.now()): string | undefined {
  const affected = issues.filter(issue => (issue.failures || 0) >= 3 && issue.firstFailedAt !== undefined && now - issue.firstFailedAt >= OUTAGE_GRACE)
  if (!affected.length) return
  const parent = state.tasks.find(task => task.id === parentId)
  if (!parent || parent.turns.some(turn => turn.id.startsWith('update-monitor-health-') && now - (turn.completedAt || turn.startedAt || 0) < NOTICE_INTERVAL)) return
  const names = affected.map(issue => issue.name).join('、')
  const content = state.settings.language === 'zh-CN'
    ? `监听暂时无法获取更新，已持续至少 30 分钟：${names}。正在自动重试；已保留上次成功的检查进度，恢复后会补查。`
    : `Monitoring has been unable to check for updates for at least 30 minutes: ${names}. Shun is retrying and will catch up from the last successful checkpoint.`
  const id = `update-monitor-health-${now}`
  parent.turns.push({ id, role: 'assistant', content, startedAt: now, completedAt: now })
  parent.updatedAt = now
  return id
}
