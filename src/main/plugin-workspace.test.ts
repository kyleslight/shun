import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listPluginWorkspace, readPluginWorkspaceFile, revealPluginWorkspacePath } from './plugin-workspace.ts'

test('plugin workspace API lists bounded files and streams base64 chunks inside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-workspace-'))
  await mkdir(join(root, 'tex'))
  await writeFile(join(root, 'tex', 'main.tex'), 'hello world')
  const listing = await listPluginWorkspace(root, { path: '.', recursive: true, limit: 20 })
  assert.deepEqual(listing.entries.map(entry => entry.path), ['tex', 'tex/main.tex'])
  const first = await readPluginWorkspaceFile(root, { path: 'tex/main.tex', length: 5 })
  assert.equal(Buffer.from(first.data, 'base64').toString(), 'hello')
  assert.equal(first.nextOffset, 5)
  const second = await readPluginWorkspaceFile(root, { path: 'tex/main.tex', offset: first.nextOffset })
  assert.equal(Buffer.from(second.data, 'base64').toString(), ' world')
})

test('plugin workspace API rejects absolute paths, traversal, symlink escapes, and oversized chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-workspace-')), outside = await mkdtemp(join(tmpdir(), 'shun-plugin-outside-'))
  await writeFile(join(outside, 'secret'), 'no')
  await writeFile(join(root, 'local'), 'ok')
  await symlink(join(outside, 'secret'), join(root, 'escape'))
  await assert.rejects(readPluginWorkspaceFile(root, { path: join(outside, 'secret') }), /relative/)
  await assert.rejects(readPluginWorkspaceFile(root, { path: '../secret' }), /escapes|ENOENT/)
  await assert.rejects(readPluginWorkspaceFile(root, { path: 'escape' }), /escapes/)
  await assert.rejects(readPluginWorkspaceFile(root, { path: 'local', length: 2 * 1024 * 1024 }), /integer/)
})

test('plugin workspace reveal resolves files and falls back to the nearest existing directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-reveal-'))
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs', 'guide.md'), 'guide')
  const file = await revealPluginWorkspacePath(root, { path: 'docs/guide.md' })
  const missing = await revealPluginWorkspacePath(root, { path: 'docs/removed/image.png' })
  assert.deepEqual({ path: file.path, kind: file.kind, exact: file.exact }, { path: 'docs/guide.md', kind: 'file', exact: true })
  assert.deepEqual({ path: missing.path, kind: missing.kind, exact: missing.exact }, { path: 'docs', kind: 'directory', exact: false })
  await assert.rejects(revealPluginWorkspacePath(root, { path: '../outside' }), /escapes/)
})
