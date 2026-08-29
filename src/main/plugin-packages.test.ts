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
  const settings = { plugins: [{ id: 'example-plugin', enabled: true, permissions: ['workspace.read'] }] }
  const descriptor = registry.views(settings)[0]
  assert.equal('accessToken' in descriptor, false)
  assert.equal(descriptor.rail, 'on-demand')
  assert.equal(descriptor.workspace, 'required')
  const view = registry.openView(settings, 'example-plugin', 'example.main', '/workspace-a', 'task-a')
  assert.match(view.url, /^shun-plugin:\/\/example-plugin\/ui\/index\.html\?instance=[0-9a-f-]+$/)
  const reopened = registry.openView(settings, 'example-plugin', 'example.main', '/workspace-a', 'task-a')
  assert.notEqual(reopened.url, view.url)
  assert.equal(view.boundTaskId, 'task-a')
  assert.equal(registry.authorizeView('example-plugin', 'example.main', view.accessToken, 'workspace.read', '/workspace-a', 'task-a').id, 'example-plugin')
  assert.equal(registry.authenticateView('example-plugin', 'example.main', view.accessToken, '/workspace-a', 'task-a').id, 'example-plugin')
  assert.throws(() => registry.authenticateView('example-plugin', 'example.main', view.accessToken, '/workspace-b', 'task-a'), /another workspace/)
  assert.throws(() => registry.authenticateView('example-plugin', 'example.main', view.accessToken, '/workspace-a', 'task-b'), /another task/)
  assert.throws(() => registry.authorizeView('example-plugin', 'example.main', 'forged', 'workspace.read', '/workspace-a', 'task-a'), /missing or expired/)
  assert.throws(() => registry.authenticateView('example-plugin', 'example.main', 'forged', '/workspace-a', 'task-a'), /missing or expired/)
  assert.equal(registry.closeView(view.accessToken), true)
  assert.throws(() => registry.authenticateView('example-plugin', 'example.main', view.accessToken, '/workspace-a', 'task-a'), /missing or expired/)
  assert.equal(registry.skillDirectories({ plugins: [{ id: 'example-plugin', enabled: true }] })[0].pluginId, 'example-plugin')
  assert.equal(registry.states({ plugins: [{ id: 'example-plugin' }] })[0].reloadable, true)

  await makePackage(source, '0.2.0')
  assert.equal((await registry.reload('example-plugin')).version, '0.2.0')
  assert.equal(JSON.parse(await readFile(join(installed, 'example-plugin', 'manifest.json'), 'utf8')).version, '0.2.0')
  assert.equal(await registry.remove('example-plugin'), true)
  assert.equal(registry.manifest('example-plugin'), undefined)
  assert.equal(await readFile(join(source, 'manifest.json'), 'utf8').then(() => true), true)
  assert.equal(await registry.remove('example-plugin'), false)
})

test('legacy primary plugin views are constrained to the right panel', () => {
  const manifest = validatePluginPackage({ schemaVersion: 1, id: 'legacy-view', name: 'Legacy', description: 'Legacy view.', version: '1.0.0', publisher: 'Test', contributes: { views: [{ id: 'legacy.main', title: 'Legacy', location: 'workspace.main', entry: 'ui/index.html' }] } })
  assert.equal(manifest.contributes?.views?.[0].location, 'workspace.right')
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

test('package validation keeps ordinary views on demand and declares workspace scope explicitly', () => {
  const base = { schemaVersion: 1, id: 'preview', name: 'Preview', description: 'Preview files.', version: '1.0.0', publisher: 'Test' }
  const manifest = validatePluginPackage({ ...base, runtime: { workspace: 'required' }, contributes: { views: [{ id: 'preview.main', title: 'Preview', location: 'workspace.right', entry: 'ui/index.html', rail: 'on-demand', launch: ['user', 'assistant', 'tool-result'] }] } })
  assert.deepEqual(manifest.runtime, { workspace: 'required' })
  assert.deepEqual(manifest.contributes?.views?.[0].launch, ['user', 'assistant', 'tool-result'])
  assert.throws(() => validatePluginPackage({ ...base, contributes: { views: [{ id: 'preview.main', title: 'Preview', location: 'workspace.right', entry: 'ui/index.html', rail: 'workspace' }] } }), /built-in workspace utilities/)
  assert.throws(() => validatePluginPackage({ ...base, runtime: { workspace: 'none' }, permissions: [{ id: 'workspace.read', reason: 'Read files.' }] }), /workspace-independent/)
  const builtin = validatePluginPackage({ ...base, contributes: { views: [{ id: 'preview.main', title: 'Preview', location: 'workspace.right', entry: 'ui/index.html', rail: 'workspace' }] } }, 'builtin')
  assert.equal(builtin.contributes?.views?.[0].rail, 'workspace')
})

test('file-change view activation is bounded, non-disruptive, and requires tool-result launch', () => {
  const base = { schemaVersion: 1, id: 'tex-preview', name: 'TeX Preview', description: 'Preview TeX files.', version: '1.0.0', publisher: 'Test' }
  const manifest = validatePluginPackage({ ...base, runtime: { workspace: 'required' }, contributes: { views: [{
    id: 'tex-preview.main', title: 'TeX Preview', location: 'workspace.right', entry: 'ui/index.html', rail: 'on-demand', launch: ['user', 'tool-result'], activation: { fileChanges: ['**/*.tex'] },
  }] } })
  assert.deepEqual(manifest.contributes?.views?.[0].activation, { fileChanges: ['**/*.tex'] })
  assert.throws(() => validatePluginPackage({ ...base, contributes: { views: [{ id: 'tex-preview.main', title: 'TeX Preview', location: 'workspace.right', entry: 'ui/index.html', launch: ['user'], activation: { fileChanges: ['**/*.tex'] } }] } }), /requires tool-result/)
  assert.throws(() => validatePluginPackage({ ...base, contributes: { views: [{ id: 'tex-preview.main', title: 'TeX Preview', location: 'workspace.right', entry: 'ui/index.html', launch: ['tool-result'], activation: { fileChanges: ['../*.tex'] } }] } }), /safe workspace-relative glob/)
})

test('conversation actions can open only declared views with an explicit launch policy', () => {
  const base = { schemaVersion: 1, id: 'preview', name: 'Preview', description: 'Preview files.', version: '1.0.0', publisher: 'Test', permissions: [{ id: 'conversation.ui', reason: 'Offer a preview action.' }] }
  const manifest = validatePluginPackage({ ...base, contributes: {
    views: [{ id: 'preview.main', title: 'Preview', location: 'workspace.right', entry: 'ui/index.html', launch: ['conversation-action'] }],
    conversationActions: [{ id: 'open-preview', title: 'Open preview', placement: 'message', viewId: 'preview.main' }],
  } })
  assert.deepEqual(manifest.contributes?.conversationActions, [{ id: 'open-preview', title: 'Open preview', placement: 'message', viewId: 'preview.main' }])
  assert.throws(() => validatePluginPackage({ ...base, contributes: {
    views: [{ id: 'preview.main', title: 'Preview', location: 'workspace.right', entry: 'ui/index.html', launch: ['user'] }],
    conversationActions: [{ id: 'open-preview', title: 'Open preview', placement: 'message', viewId: 'preview.main' }],
  } }), /must allow conversation-action/)
  assert.throws(() => validatePluginPackage({ ...base, contributes: { conversationActions: [{ id: 'open-preview', title: 'Open preview', placement: 'message', viewId: 'preview.missing' }] } }), /unknown view/)
})

test('package validation preserves a package-relative custom SVG icon', async () => {
  const manifest = validatePluginPackage({ schemaVersion: 1, id: 'visual-plugin', name: 'Visual', description: 'Visual plugin.', version: '1.0.0', publisher: 'Test', icon: 'assets/icon.svg' })
  assert.equal(manifest.icon, 'plugin')
  assert.equal(manifest.iconAsset, 'assets/icon.svg')
  assert.throws(() => validatePluginPackage({ schemaVersion: 1, id: 'visual-plugin', name: 'Visual', description: 'Visual plugin.', version: '1.0.0', publisher: 'Test', icon: '../icon.svg' }), /package-relative/)
  assert.throws(() => validatePluginPackage({ schemaVersion: 1, id: 'visual-plugin', name: 'Visual', description: 'Visual plugin.', version: '1.0.0', publisher: 'Test', icon: 'icon.png' }), /SVG/)
})

test('package validation accepts a fixed high-trust worker only with its explicit permission', async () => {
  const base = { schemaVersion: 1, id: 'native-preview', name: 'Native Preview', description: 'Runs a package worker.', version: '1.0.0', publisher: 'Test', contributes: { workers: [{ id: 'render', entry: 'worker/index.mjs', timeoutMs: 45_000 }] } }
  assert.throws(() => validatePluginPackage(base), /workspace\.process/)
  const manifest = validatePluginPackage({ ...base, permissions: [{ id: 'workspace.process', reason: 'Run the package renderer.' }] })
  assert.deepEqual(manifest.contributes?.workers, [{ id: 'render', entry: 'worker/index.mjs', timeoutMs: 45_000 }])

  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-worker-package-')), bundled = join(root, 'bundled'), installed = join(root, 'installed'), source = join(root, 'source')
  await mkdir(join(source, 'worker'), { recursive: true }); await mkdir(bundled)
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ ...base, permissions: [{ id: 'workspace.process', reason: 'Run the package renderer.' }] }))
  await writeFile(join(source, 'worker', 'index.mjs'), 'process.stdout.write("null")')
  const registry = new PluginPackageRegistry(bundled, installed)
  await registry.refresh(); await registry.installFromDirectory(source)
  assert.match(registry.worker('native-preview', 'render').entry, /worker\/index\.mjs$/)
  assert.throws(() => registry.worker('native-preview', 'missing'), /Unknown plugin worker/)
})

test('native worker runtimes select one declared executable for the current platform and architecture', async () => {
  const executable = {
    id: 'renderer', version: '1.2.3', targets: [
      { platform: 'darwin', arch: 'arm64', archive: 'tar.gz', entry: 'renderer', bytes: 10, url: 'https://example.com/renderer-darwin-arm64.tar.gz' },
      { platform: 'win32', arch: 'x64', archive: 'zip', entry: 'renderer.exe', bytes: 12, url: 'https://example.com/renderer-win32-x64.zip' },
    ],
  }
  const base = {
    schemaVersion: 1, id: 'native-renderer', name: 'Native Renderer', description: 'Runs a portable package renderer.', version: '1.0.0', publisher: 'Test',
    permissions: [{ id: 'workspace.process', reason: 'Render the selected workspace document.' }],
    runtime: { workspace: 'required', executables: [executable] },
    contributes: { workers: [{ id: 'render', entry: 'worker/index.mjs', timeoutMs: 90_000, runtime: ['renderer'] }] },
  }
  const manifest = validatePluginPackage(base)
  assert.deepEqual(manifest.runtime?.executables, [executable])
  assert.deepEqual(manifest.contributes?.workers?.[0].runtime, ['renderer'])
  assert.throws(() => validatePluginPackage({ ...base, contributes: { workers: [{ id: 'render', entry: 'worker/index.mjs', runtime: ['missing'] }] } }), /unknown runtime executable/)

  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-native-runtime-'))
  const bundled = join(root, 'bundled'), installed = join(root, 'installed'), cache = join(root, 'cache'), source = join(root, 'source')
  await mkdir(join(source, 'worker'), { recursive: true }); await mkdir(bundled)
  await writeFile(join(source, 'manifest.json'), JSON.stringify(base))
  await writeFile(join(source, 'worker', 'index.mjs'), 'process.stdout.write("null")')
  const registry = new PluginPackageRegistry(bundled, installed, cache)
  await registry.refresh(); await registry.installFromDirectory(source)
  const selected = registry.runtimeExecutable('native-renderer', 'renderer', 'win32', 'x64')
  assert.equal(selected.entry, 'renderer.exe')
  assert.match(selected.cachePath, /native-renderer[/\\]1\.0\.0[/\\]executables[/\\]renderer[/\\]win32-x64[/\\]renderer\.exe$/)
  assert.throws(() => registry.runtimeExecutable('native-renderer', 'renderer', 'linux', 'x64'), /does not support linux-x64/)
})

test('package inspection reports the one supported Shun manifest location', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-manifest-')), bundled = join(root, 'bundled'), installed = join(root, 'installed'), source = join(root, 'source')
  await mkdir(bundled)
  await mkdir(source)
  const registry = new PluginPackageRegistry(bundled, installed)
  await assert.rejects(registry.inspectDirectory(source), /package root must contain manifest\.json/i)
  await writeFile(join(source, 'manifest.json'), '{invalid')
  await assert.rejects(registry.inspectDirectory(source), /manifest\.json must contain valid JSON/i)
})

test('runtime assets install without an integrity gate while keeping bounded download metadata', async () => {
  const base = {
    schemaVersion: 1, id: 'layered-preview', name: 'Layered Preview', description: 'Uses a cached runtime layer.',
    version: '1.0.0', publisher: 'Test',
    runtime: { workspace: 'required', assets: [{ id: 'engine-data', path: 'engine/data.tar.gz', bytes: 42, url: 'https://example.com/data.tar.gz' }] },
  }
  const manifest = validatePluginPackage(base)
  assert.deepEqual(manifest.runtime?.assets, base.runtime.assets)
  assert.deepEqual(validatePluginPackage({ ...base, runtime: { ...base.runtime, assets: [{ ...base.runtime.assets[0], sha256: 'stale metadata' }] } }).runtime?.assets?.[0]?.sha256, 'stale metadata')
  assert.throws(() => validatePluginPackage({ ...base, runtime: { ...base.runtime, assets: [{ ...base.runtime.assets[0], url: 'http://example.com/data' }] } }), /credential-free HTTPS/)
})

test('runtime asset URLs resolve to a versioned cache and a sibling development layer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-layered-package-'))
  const bundled = join(root, 'bundled'), installed = join(root, 'installed'), cache = join(root, 'cache'), source = join(root, 'source')
  await mkdir(bundled)
  await mkdir(source)
  await writeFile(join(source, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, id: 'layered-preview', name: 'Layered Preview', description: 'Uses a cached runtime layer.', version: '1.0.0', publisher: 'Test',
    runtime: { workspace: 'required', assets: [{ id: 'engine-data', path: 'engine/data.tar.gz', bytes: 42 }] },
  }))
  const registry = new PluginPackageRegistry(bundled, installed, cache)
  await registry.refresh()
  await registry.installFromDirectory(source)
  const asset = registry.runtimeAsset('layered-preview', '/__runtime__/engine/data.tar.gz')
  assert.equal(asset.cachePath, join(cache, 'layered-preview', '1.0.0', 'engine/data.tar.gz'))
  assert.equal(asset.developmentPath, join(`${source}.runtime-assets`, 'engine/data.tar.gz'))
  assert.throws(() => registry.runtimeAsset('layered-preview', '/__runtime__/missing.bin'), /Unknown plugin runtime asset/)
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
