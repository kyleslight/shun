// The release script is evaluated top to bottom, and its last block starts publishing as soon as it
// is reached. A constant declared below that point is in its temporal dead zone when a release
// begins, which fails inside a publish rather than at the line that reads it — that is how an
// earlier change made every upload-only run die before it touched a single asset.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./release-local.mjs', import.meta.url), 'utf8')

test('the publishing flow never reads a constant declared below it', () => {
  const lines = source.split('\n')
  const flow = lines.findIndex(line => line.includes('await stageDraftRelease(repository'))
  assert.ok(flow > 0, 'the publishing flow is still a single awaited step')
  const declaredBelow = lines.slice(flow).flatMap((line, index) => {
    const name = /^(?:const|let) ([A-Za-z_$][\w$]*)/.exec(line)?.[1]
    return name ? [`line ${flow + index + 1}: ${name}`] : []
  })
  // The flow's own two bindings are the only ones allowed to appear there.
  const misplaced = declaredBelow.filter(entry => !/repairedPublishedRelease|releaseCommit/.test(entry))
  assert.deepEqual(misplaced, [])
})

test('an upload-only publish never renumbers the artifacts it was given', () => {
  assert.match(source, /if \(!uploadOnly\) prepareReleaseVersion\(\)/)
})

test('a completed upload is the only asset state that counts', () => {
  assert.match(source, /uploaded: asset\.state === "uploaded"/)
  assert.match(source, /existing\?\.uploaded && !manifestPattern\.test\(name\)/)
  assert.match(source, /if \(present\?\.uploaded && present\.size === item\.size\)/)
  assert.match(source, /await clearAsset\(repo, releaseId, item\.name, item\.size\)/)
  assert.match(source, /const unfinished = artifacts\.filter\(artifact => remote\.get\(basename\(artifact\)\)\?\.uploaded === false\)/)
})

test('artifacts keep the order their platforms are built in', () => {
  const collect = source.slice(source.indexOf('function collectArtifacts'), source.indexOf('function writeChecksums'))
  assert.match(collect, /return \["macos", "windows", "linux"\]\.flatMap/)
  // Names are ordered inside one platform's directory, never across the whole list: sorting the
  // flat list is what put macOS behind Linux and Windows behind everything.
  assert.doesNotMatch(collect, /return files/)
  assert.match(collect, /readdirSync\(platformDirectory\)\s*\n\s*\.sort/)
})

test('a manifest is never skipped and is re-read from the release before publishing', () => {
  assert.match(source, /const manifestPattern = \/\^\(\?:latest\[\^\/\]\*\\\.ya\?ml\|SHA256SUMS\\\.txt\)\$\/\n/)
  assert.match(source, /const stale = manifests\.filter\(manifest => downloadAssetText\(repo, remote\.get\(basename\(manifest\)\)\) !== readFileSync\(manifest, "utf8"\)\.trim\(\)\)/)
  assert.match(source, /const unpublished = \[\]/)
})
