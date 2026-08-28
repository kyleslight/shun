import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PluginPackageRegistry, validatePluginPackage } from './plugin-packages.ts'

async function makePackage(root: string, version = '0.1.0') {
  await mkdir(join(root, 'ui'), { recursive: true })
  await mkdir(join(root, 'skills', 'example-skill'), { recursive: true })
  await writeFile(join(root, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'example-plugin',
    name: 'Example Plugin',
    description: 'A test package.',
    version,
    publisher: 'Test',
    permissions: [{ id: 'workspace.read', reason: 'Read selected files.' }],
    contributes: { views: [{ id: 'example.main', title: 'Example', location: 'workspace.right', entry: 'ui/index.html' }], skills: [{ path: 'skills' }] },
  }))
  await writeFile(join(root, 'ui', 'index.html'), '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'">')
  await writeFile(join(root, 'skills', 'example-skill', 'SKILL.md'), '---\nname: example-skill\ndescription: Example.\n---\n\n# Example\n')
}

test('package registry installs from a folder and gates views on enablement and grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-registry-')), bundled = join(root, 'bundled'), installed = join(root, 'installed'), source = join(root, 'source')
  await mkdir(bundled)
  await makePackage(source)
  const registry = new PluginPackageRegistry(bundled, installed)
  await registry.refresh()
  const manifest = await registry.installFromDirectory(source)
  assert.equal(manifest.id, 'example-plugin')
  assert.deepEqual(registry.views({ plugins: [{ id: 'example-plugin', enabled: true, permissions: [] }] }), [])
  const view = registry.views({ plugins: [{ id: 'example-plugin', enabled: true, permissions: ['workspace.read'] }] })[0]
  assert.equal(view.url, 'shun-plugin://example-plugin/ui/index.html')
  assert.equal(registry.authorizeView('example-plugin', 'example.main', view.accessToken, 'workspace.read').id, 'example-plugin')
  assert.throws(() => registry.authorizeView('example-plugin', 'example.main', 'forged', 'workspace.read'), /missing or expired/)
  assert.equal(registry.skillDirectories({ plugins: [{ id: 'example-plugin', enabled: true }] })[0].pluginId, 'example-plugin')
  assert.equal(registry.states({ plugins: [{ id: 'example-plugin' }] })[0].reloadable, true)

  await makePackage(source, '0.2.0')
  assert.equal((await registry.reload('example-plugin')).version, '0.2.0')
  assert.equal(JSON.parse(await readFile(join(installed, 'example-plugin', 'manifest.json'), 'utf8')).version, '0.2.0')
})

test('package validation rejects traversal, undeclared conversation UI, and unsupported permission ids', () => {
  const base = { schemaVersion: 1, id: 'example-plugin', name: 'Example', description: 'Example.', version: '1.0.0', publisher: 'Test' }
  assert.throws(() => validatePluginPackage({ ...base, contributes: { views: [{ id: 'example.main', title: 'Example', location: 'workspace.right', entry: '../index.html' }] } }), /package-relative/)
  assert.throws(() => validatePluginPackage({ ...base, contributes: { conversationActions: [{ id: 'x', title: 'X', placement: 'message', command: 'x' }] } }), /conversation\.ui/)
  assert.throws(() => validatePluginPackage({ ...base, permissions: [{ id: 'everything', reason: 'No.' }] }), /Unsupported plugin permission/)
})

test('package validation accepts the narrow Git write permission', () => {
  const manifest = validatePluginPackage({ schemaVersion: 1, id: 'git-actions', name: 'Git Actions', description: 'Structured Git actions.', version: '1.0.0', publisher: 'Test', permissions: [{ id: 'workspace.git.write', reason: 'Run selected Git actions.' }] })
  assert.deepEqual(manifest.permissions, [{ id: 'workspace.git.write', reason: 'Run selected Git actions.' }])
})

test('package validation accepts the explicit workspace reveal permission', () => {
  const manifest = validatePluginPackage({ schemaVersion: 1, id: 'file-reveal', name: 'File Reveal', description: 'Reveal selected workspace files.', version: '1.0.0', publisher: 'Test', permissions: [{ id: 'workspace.reveal', reason: 'Reveal a user-selected file.' }] })
  assert.deepEqual(manifest.permissions, [{ id: 'workspace.reveal', reason: 'Reveal a user-selected file.' }])
})

test('installed packages cannot shadow reserved bundled package ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-reserved-')), bundled = join(root, 'bundled'), installed = join(root, 'installed'), source = join(root, 'source')
  await makePackage(join(bundled, 'example-plugin'))
  await makePackage(source, '9.0.0')
  const registry = new PluginPackageRegistry(bundled, installed)
  await registry.refresh()
  await assert.rejects(registry.installFromDirectory(source), /reserved by a built-in package/)
  assert.equal(registry.manifest('example-plugin')?.version, '0.1.0')
})
