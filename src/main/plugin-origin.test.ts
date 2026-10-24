import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { pluginOrigin, pluginOriginLabel } from '../plugin-origin.ts'
import { pluginManifests } from './plugins.ts'
import type { PluginProvenance } from '../shared.ts'

const provenance: PluginProvenance = {
  source: 'marketplace', publisher: 'community-author', version: '1.0.0',
  sha256: 'a'.repeat(64), files: 1, bytes: 100, installedAt: 1,
}

test('only the seven Shun utilities are built in; other shipped integrations are official', async () => {
  const plugins = pluginManifests('darwin')
  for (const id of ['browser-preview', 'file-manager', 'git-workbench', 'sites', 'terminal']) {
    const manifest = JSON.parse(await readFile(new URL(`../../resources/plugins/${id}/manifest.json`, import.meta.url), 'utf8'))
    plugins.push({ ...manifest, source: 'builtin' })
  }
  assert.deepEqual(plugins.filter(p => pluginOrigin(p) === 'builtin').map(p => p.id).sort(), [
    'browser-preview', 'browser-use', 'computer-use', 'file-manager', 'git-workbench', 'sites', 'terminal',
  ])
  for (const id of ['github', 'figma', 'gmail', 'ios-simulator', 'godot', 'render', 'cloudflare']) {
    const plugin = plugins.find(p => p.id === id)
    assert.ok(plugin, id)
    assert.equal(pluginOrigin(plugin), 'official', id)
  }
})

test('marketplace and local packages keep distinct origins regardless of their names or ids', () => {
  assert.equal(pluginOrigin({ id: 'figma', source: 'installed' }), 'custom')
  assert.equal(pluginOrigin({ id: 'browser-use', source: 'installed', provenance }), 'community')
  assert.equal(pluginOrigin({ id: 'example', source: 'installed', provenance: { ...provenance, publisher: 'Shun' } }), 'community')
  assert.equal(pluginOrigin({ id: 'example', source: 'installed', provenance: { ...provenance, official: true } }), 'official')
  assert.equal(pluginOrigin({ id: 'example', source: 'installed', provenance: { ...provenance, source: 'directory', official: true } }), 'custom')
  assert.deepEqual(['builtin', 'official', 'community', 'custom'].map(origin => pluginOriginLabel(origin as Parameters<typeof pluginOriginLabel>[0])), ['Built-in', 'Official', 'Community', 'Custom'])
  assert.deepEqual(['builtin', 'official', 'community', 'custom'].map(origin => pluginOriginLabel(origin as Parameters<typeof pluginOriginLabel>[0], true)), ['内置', '官方', '社区', '自建'])
})
