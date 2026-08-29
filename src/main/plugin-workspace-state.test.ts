import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PluginWorkspaceStateStore } from './plugin-workspace-state.ts'

test('plugin workspace state is isolated by plugin and canonical workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-state-'))
  const first = join(root, 'first'), second = join(root, 'second')
  await Promise.all([mkdir(first), mkdir(second)])
  const file = join(root, 'state.json'), store = new PluginWorkspaceStateStore(file)
  await store.set('prism-preview', first, 'mainFile', 'paper.tex')
  await store.set('prism-preview', second, 'mainFile', 'resume.tex')
  await store.set('another-plugin', first, 'mainFile', 'other.tex')
  assert.equal(await store.get('prism-preview', first, 'mainFile'), 'paper.tex')
  assert.equal(await store.get('prism-preview', second, 'mainFile'), 'resume.tex')
  assert.equal(await store.get('another-plugin', first, 'mainFile'), 'other.tex')
  assert.equal((await readFile(file, 'utf8')).includes(first), false)
})

test('plugin workspace state rejects unsafe keys and oversized values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-state-limits-'))
  const store = new PluginWorkspaceStateStore(join(root, 'state.json'))
  await assert.rejects(() => store.set('example', root, '../main', 'x'), /key/)
  await assert.rejects(() => store.set('example', root, 'mainFile', 'x'.repeat(70_000)), /64 KB/)
})
