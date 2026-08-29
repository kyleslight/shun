import assert from 'node:assert/strict'
import test from 'node:test'
import type { PluginViewDescriptor } from '../shared.ts'
import { pluginFileChangeMatches, suggestedPluginViewForFileChange, validPluginFileChangePattern, workspaceRelativeToolPath } from './plugin-view-activation.ts'

const view = (overrides: Partial<PluginViewDescriptor> = {}): PluginViewDescriptor => ({
  pluginId: 'tex-lens', viewId: 'preview', title: 'TeX Lens', location: 'workspace.right', url: 'shun-plugin://tex-lens/ui/index.html', icon: 'plugin', permissions: [], workspace: 'required', rail: 'on-demand', launch: ['user', 'tool-result'], activation: { fileChanges: ['**/*.tex'] }, ...overrides,
})

test('file-change activation supports nested TeX files without matching adjacent formats', () => {
  assert.equal(pluginFileChangeMatches('**/*.tex', 'resume.tex'), true)
  assert.equal(pluginFileChangeMatches('**/*.tex', 'papers/resume.tex'), true)
  assert.equal(pluginFileChangeMatches('**/*.tex', 'papers/resume.txt'), false)
})

test('file-change activation patterns cannot escape the package contract', () => {
  assert.equal(validPluginFileChangePattern('../*.tex'), false)
  assert.equal(validPluginFileChangePattern('/tmp/*.tex'), false)
  assert.equal(validPluginFileChangePattern('**/*.tex'), true)
})

test('the first enabled tool-result view matching the changed file is suggested', () => {
  assert.equal(suggestedPluginViewForFileChange([view()], 'docs/main.tex')?.viewId, 'preview')
  assert.equal(suggestedPluginViewForFileChange([view({ launch: ['user'] })], 'docs/main.tex'), undefined)
})

test('tool paths are normalized relative to the active workspace', () => {
  assert.equal(workspaceRelativeToolPath('/work/project', '/work/project/docs/main.tex'), 'docs/main.tex')
})
