import assert from 'node:assert/strict'
import test from 'node:test'
import { updateFailure, updateProgress } from './update-state.ts'

test('update download progress is rounded and clamped for the renderer', () => {
  const base = { status: 'available' as const, currentVersion: '0.0.1', targetVersion: '0.0.2' }
  assert.equal(updateProgress(base, 41.7).percent, 42)
  assert.equal(updateProgress(base, 120).percent, 100)
  assert.equal(updateProgress(base, -4).percent, 0)
})

test('update errors do not expose request URLs to the renderer', () => {
  const state = updateFailure('0.0.1', Error('GET https://github.com/example/private?token=secret failed'))
  assert.equal(state.status, 'error')
  assert.doesNotMatch(state.message || '', /token=secret/)
})
