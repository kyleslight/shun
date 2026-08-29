import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { listPluginWorkspace, readPluginWorkspaceFile, revealPluginWorkspacePath, searchPluginWorkspace } from './plugin-workspace.ts'

const execFile = promisify(execFileCallback)

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

test('plugin workspace search is bounded, recursive, and skips dependency metadata trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-search-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'hidden'), { recursive: true })
  await writeFile(join(root, 'src', 'file-manager.ts'), 'export {}')
  await writeFile(join(root, 'src', 'other.ts'), 'export {}')
  await writeFile(join(root, 'node_modules', 'hidden', 'file-manager.js'), 'hidden')
  const result = await searchPluginWorkspace(root, { query: 'manager', limit: 10 })
  assert.deepEqual(result.entries.map(entry => entry.path), ['src/file-manager.ts'])
  assert.equal(result.truncated, false)
  assert.ok(result.scanned >= 3)
  await assert.rejects(searchPluginWorkspace(root, { query: 'x'.repeat(201) }), /too long/)
})

test('plugin workspace search follows Git ignore rules by default and can explicitly include ignored files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-search-git-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'build', 'archive'), { recursive: true })
  await writeFile(join(root, '.gitignore'), 'build/\n')
  await writeFile(join(root, 'src', 'HomeScreen.tsx'), 'export {}')
  await writeFile(join(root, 'build', 'archive', 'HomeScreen.tsx'), 'generated')
  await execFile('git', ['init', '--quiet'], { cwd: root })
  const normal = await searchPluginWorkspace(root, { query: 'home', limit: 10 })
  const broad = await searchPluginWorkspace(root, { query: 'home', limit: 10, includeIgnored: true })
  assert.deepEqual(normal.entries.map(entry => entry.path), ['src/HomeScreen.tsx'])
  assert.deepEqual(broad.entries.map(entry => entry.path), ['build/archive/HomeScreen.tsx', 'src/HomeScreen.tsx'])
})
