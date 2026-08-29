import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { scaffoldPluginPackage } from './plugin-scaffold.ts'

const productRoot = resolve(import.meta.dirname, '../..')
const templateRoot = join(productRoot, 'skills', 'shun-plugin-development', 'assets', 'plugin-template')

test('plugin scaffold atomically creates a customized package inside the selected workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-plugin-scaffold-'))
  try {
    const output = await scaffoldPluginPackage({
      workspaceRoot: workspace,
      templateRoot,
      path: 'plugins/folio',
      pluginId: 'folio',
      name: 'Folio & Notes',
      description: 'A focused workspace view.',
      userOutcome: 'Review the latest generated artifact without leaving the conversation.',
      primaryFlow: 'Ask for a change in conversation, keep the previous artifact visible while updating, then show the new result.',
      iconConcept: 'An offset folio page with one folded corner and a single annotation spark.',
      publisher: 'Kyles Light',
    })
    assert.equal(output.relativePath, 'plugins/folio')
    assert.deepEqual(output.createdFiles, ['manifest.json', 'PRODUCT_BRIEF.md', 'icon.svg', 'ui/index.html', 'ui/styles.css', 'ui/shun-host.js', 'ui/app.js'])
    const manifest = JSON.parse(await readFile(join(output.root, 'manifest.json'), 'utf8'))
    assert.equal(manifest.id, 'folio')
    assert.equal(manifest.name, 'Folio & Notes')
    assert.equal(manifest.publisher, 'Kyles Light')
    assert.equal(manifest.icon, 'icon.svg')
    assert.deepEqual(manifest.runtime, { workspace: 'required' })
    assert.deepEqual(manifest.contributes.views, [{ id: 'folio.main', title: 'Folio & Notes', location: 'workspace.right', entry: 'ui/index.html', rail: 'on-demand', launch: ['user', 'assistant'] }])
    const brief = await readFile(join(output.root, 'PRODUCT_BRIEF.md'), 'utf8')
    assert.match(brief, /workspace\.right/i)
    assert.match(brief, /keep the previous artifact visible while updating/i)
    assert.match(brief, /ui\/shun-host\.js/)
    assert.match(brief, /offset folio page/i)
    assert.ok(brief.length < 1_500, 'generated brief should stay concise')
    assert.match(await readFile(join(output.root, 'icon.svg'), 'utf8'), /<svg/)
    const html = await readFile(join(output.root, 'ui', 'index.html'), 'utf8')
    assert.match(html, /Folio &amp; Notes/)
    assert.doesNotMatch(html, /Example Plugin/)
    assert.match(html, /shun-host\.js/)
    const host = await readFile(join(output.root, 'ui', 'shun-host.js'), 'utf8')
    assert.match(host, /workspace\.changed/)
    assert.match(host, /readText/)
    assert.match(host, /invokeWorker/)
    assert.match(host, /exportFile/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('plugin scaffold accepts in-workspace absolute paths and rejects traversal, invalid ids, and existing targets', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-plugin-scaffold-'))
  const base = { workspaceRoot: workspace, templateRoot, path: 'plugin', pluginId: 'example', name: 'Example', description: 'Example plugin.', userOutcome: 'Complete a bounded task.', primaryFlow: 'Open the view and complete the task.' }
  try {
    await assert.rejects(scaffoldPluginPackage({ ...base, path: '../outside' }), /inside the selected workspace/)
    const absolute = await scaffoldPluginPackage({ ...base, path: resolve(workspace, 'absolute') })
    assert.equal(absolute.relativePath, 'absolute')
    assert.match(await readFile(join(absolute.root, 'PRODUCT_BRIEF.md'), 'utf8'), /distinct symbol expressing Example/i)
    await assert.rejects(scaffoldPluginPackage({ ...base, pluginId: 'Bad ID' }), /lowercase dot or hyphen/)
    await mkdir(join(workspace, 'plugin'))
    await writeFile(join(workspace, 'plugin', 'keep.txt'), 'user data')
    await assert.rejects(scaffoldPluginPackage(base), /already exists/)
    assert.equal(await readFile(join(workspace, 'plugin', 'keep.txt'), 'utf8'), 'user data')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('plugin scaffold can initialize the selected workspace root without disturbing unrelated files', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-plugin-scaffold-'))
  try {
    await writeFile(join(workspace, 'notes.txt'), 'keep me')
    const output = await scaffoldPluginPackage({ workspaceRoot: workspace, templateRoot, path: '.', pluginId: 'root-plugin', name: 'Root Plugin', description: 'Root plugin.', userOutcome: 'Complete a bounded task.', primaryFlow: 'Open the view and complete the task.' })
    assert.equal(output.root, workspace)
    assert.equal(output.relativePath, '.')
    assert.equal(await readFile(join(workspace, 'notes.txt'), 'utf8'), 'keep me')
    assert.equal(JSON.parse(await readFile(join(workspace, 'manifest.json'), 'utf8')).id, 'root-plugin')
    assert.equal(JSON.parse(await readFile(join(workspace, 'manifest.json'), 'utf8')).contributes.views[0].location, 'workspace.right')
    await assert.rejects(scaffoldPluginPackage({ workspaceRoot: workspace, templateRoot, path: '.', pluginId: 'again', name: 'Again', description: 'Again.', userOutcome: 'Repeat a task.', primaryFlow: 'Open and repeat.' }), /already contains (?:PRODUCT_BRIEF\.md|manifest\.json)/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
