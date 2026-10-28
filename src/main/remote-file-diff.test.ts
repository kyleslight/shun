import assert from 'node:assert/strict'
import test from 'node:test'
import { createTwoFilesPatch } from 'diff'
import { remoteDiff } from '../remote-projection.ts'

test('snapshot patches preserve filenames and keep each file separate', () => {
  const patches = ['__tests__/a.ts', 'ResourcesSheet.tsx'].map(path => createTwoFilesPatch('/dev/null', path, '', 'hello\n', '', 'current')).join('\n')
  const result = remoteDiff(patches)
  assert.deepEqual(result.map(entry => entry.path), ['__tests__/a.ts', 'ResourcesSheet.tsx'])
  assert.equal(result[0].hunks[0].lines.length, 1)
  assert.equal(result[1].hunks[0].lines.length, 1)
})

test('Git and newly added file patches do not share hunks', () => {
  const tracked = 'diff --git a/old.ts b/old.ts\n--- a/old.ts\n+++ b/old.ts\n@@ -1 +1 @@\n-before\n+after\n'
  const added = createTwoFilesPatch('/dev/null', 'new file.ts', '', 'new\n', '', 'current')
  const result = remoteDiff(tracked + '\n' + added)
  assert.deepEqual(result.map(entry => entry.path), ['old.ts', 'new file.ts'])
  assert.equal(result[0].hunks[0].lines.length, 2)
  assert.equal(result[1].hunks[0].lines.length, 1)
})
