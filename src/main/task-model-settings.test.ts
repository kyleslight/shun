import test from 'node:test'
import assert from 'node:assert/strict'
import { taskModelSettings } from './task-model-settings.ts'
import type { Settings } from '../shared.ts'

test('resuming a task uses its selected model window rather than the legacy global default', () => {
  const settings = { contextWindow: 32768, maxTokens: 4096, model: 'small', providerId: 'local', providers: [{ id: 'local', endpoint: 'http://localhost', contextWindow: 131072, models: [{ id: 'large', contextWindow: 524288, maxOutputTokens: 16384 }] }] } as Settings
  const resolved = taskModelSettings(settings, { workspace: '/project', model: 'large' })
  assert.equal(resolved.contextWindow, 524288)
  assert.equal(resolved.maxTokens, 16384)
  assert.equal(resolved.workspace, '/project')
  assert.equal(settings.contextWindow, 32768)
  assert.equal(taskModelSettings(settings, { workspace: '' }).contextWindow, 131072)
})
