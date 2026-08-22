import type { UpdateState } from '../shared'

export function updateProgress(state: UpdateState, percent: number): UpdateState {
  return {
    ...state,
    status: 'downloading',
    percent: Math.min(100, Math.max(0, Math.round(Number.isFinite(percent) ? percent : 0))),
    message: undefined,
  }
}

export function updateFailure(currentVersion: string, error: unknown): UpdateState {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(/https?:\/\/[^\s]+/g, 'the update server').replace(/\s+/g, ' ').trim().slice(0, 240)
  return { status: 'error', currentVersion, message: message || 'Update failed.' }
}
