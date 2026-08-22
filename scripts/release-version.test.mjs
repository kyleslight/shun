import assert from 'node:assert/strict'
import test from 'node:test'
import { nextPatchVersion, stableVersion } from './release-version.mjs'

test('release builds advance exactly the patch component', () => {
  assert.equal(nextPatchVersion('0.0.1'), '0.0.2')
  assert.equal(nextPatchVersion('2.7.9'), '2.7.10')
})

test('the latest stable GitHub release prevents a duplicate or lower tag', () => {
  assert.equal(nextPatchVersion('0.1.0', ['v0.1.1', 'v0.2.0', 'v0.3.0-beta.1']), '0.2.1')
})

test('only stable semantic versions participate in release numbering', () => {
  assert.deepEqual(stableVersion('v1.2.3'), [1, 2, 3])
  assert.equal(stableVersion('1.2.3-beta.1'), null)
  assert.throws(() => nextPatchVersion('latest'), /stable semantic version/)
})
