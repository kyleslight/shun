import assert from 'node:assert/strict'
import test from 'node:test'
import { pluginDevelopmentWorkspaceState } from './plugin-development.ts'

test('plugin source development requires an explicit durable workspace', () => {
  assert.deepEqual(pluginDevelopmentWorkspaceState('/Users/example/plugin'), { status: 'ready', workspaceSelected: true })
  assert.deepEqual(pluginDevelopmentWorkspaceState('  '), {
    status: 'workspace_required',
    workspaceSelected: false,
    message: 'Choose or create a workspace for this task before creating, validating, or development-installing a plugin package. Standalone task storage is private scratch space and is not a durable plugin source.',
  })
})
