import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename } from 'node:path'
import { stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui'
import type { ContextUsage } from '../shared.ts'
const exec = promisify(execFile)
const clean = (value: string) => stripTerminalSequences(value).replace(/[\x00-\x1f\x7f]/g, '')
const tokens = (value: number) => value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value)
export function statusLine(model: string, workspace: string, git: string, context: ContextUsage | undefined, width: number) {
  const used = context && (context.usedTokens ?? Math.ceil(context.usedCharacters / 2.5))
  const budget = context && (context.budgetTokens ?? Math.floor(context.budgetCharacters / 2.5))
  const usage = used !== undefined && budget ? `${context?.exactTokens ? '' : '~'}${tokens(used)} / ${tokens(budget)} · ${Math.round(used / budget * 100)}%` : ''
  return truncateToWidth([workspace && basename(workspace), git, model || 'No model', usage].filter(Boolean).map(clean).join(' · '), Math.max(1, width))
}
export async function gitStatus(workspace: string) {
  if (!workspace) return ''
  try {
    const { stdout } = await exec('git', ['--no-optional-locks', 'status', '--porcelain=v1', '--branch', '--untracked-files=normal'], { cwd: workspace, timeout: 1500, maxBuffer: 128 * 1024 })
    const [head, ...changes] = stdout.trimEnd().split('\n')
    const branch = head.replace(/^## /, '').split('...')[0].replace(/ \[.*\]$/, '').replace(/^No commits yet on /, '').replace(/^Initial commit on /, '')
    return `${branch}${changes.length ? '*' : ''}`
  } catch { return '' }
}
