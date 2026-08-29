import assert from 'node:assert/strict'
import test from 'node:test'
import type { PluginViewDescriptor } from '../../shared.ts'
import { parsePluginViewRecents, pluginRailViewsForWorkspace, prunePluginViewRecents, rememberPluginView } from './plugin-view-recents.ts'

function view(pluginId: string, rail: PluginViewDescriptor['rail'] = 'on-demand'): PluginViewDescriptor {
  return { pluginId, viewId: 'main', title: pluginId, location: 'workspace.right', url: '', icon: 'plugin', permissions: [], workspace: 'required', rail, launch: ['user'] }
}

test('a successfully opened on-demand view remains in that workspace rail after closing', () => {
  const tex = view('tex-lens'), git = view('git-workbench', 'workspace')
  const remembered = rememberPluginView({}, '/paper', tex)
  assert.deepEqual(pluginRailViewsForWorkspace([tex, git], '/paper', remembered).map(item => item.pluginId), ['tex-lens', 'git-workbench'])
  assert.deepEqual(pluginRailViewsForWorkspace([tex, git], '/other', remembered).map(item => item.pluginId), ['git-workbench'])
})

test('recent rail entries are bounded, sanitized, and removed when the plugin is unavailable', () => {
  let recents = parsePluginViewRecents('{"/paper":["tex-lens:main","tex-lens:main",7],"": ["bad:main"]}')
  assert.deepEqual(recents, { '/paper': ['tex-lens:main'] })
  for (let index = 0; index < 10; index++) recents = rememberPluginView(recents, '/paper', view(`plugin-${index}`))
  assert.equal(recents['/paper'].length, 8)
  assert.deepEqual(prunePluginViewRecents(recents, [view('plugin-9')]), { '/paper': ['plugin-9:main'] })
})
