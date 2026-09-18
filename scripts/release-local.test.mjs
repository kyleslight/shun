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

test('an interrupted publish reuses the build already on disk instead of packaging again', () => {
  // Packaging and notarization are the expensive half of a release, and a failure during upload
  // must not charge for them twice. Reuse is safe only because the stamp names the commit: a
  // mismatch between the built revision and this workspace forces a real rebuild.
  assert.match(source, /else if \(reusableBuild\(buildStamp, version, headCommit\)\)/)
  const reusable = source.slice(source.indexOf('function reusableBuild'), source.indexOf('function writeBuildStamp'))
  assert.match(reusable, /stamp\.version !== expectedVersion \|\| stamp\.commit !== commit/)
  assert.match(reusable, /statSync\(path\)\.size === entry\.size/)
  // Reuse must not clean the directory it is about to upload from. Scoped to the reuse branch
  // itself: the build branch beside it cleans the directory on purpose.
  const reuse = source.slice(source.indexOf('else if (reusableBuild(buildStamp'), source.indexOf('} else {  console.log(`\\nBuilding Shun'))
  assert.ok(reuse.length > 0, 'the reuse branch is still reachable')
  assert.doesNotMatch(reuse, /cleanReleaseDirectory/)
})

test('the build stamp certifies the commit and the exact files it describes', () => {
  const stamp = source.slice(source.indexOf('function writeBuildStamp'), source.indexOf('function collectArtifacts'))
  assert.match(stamp, /version: builtVersion/)
  assert.match(stamp, /commit,/)
  assert.match(stamp, /size: statSync\(artifact\)\.size/)
  // Certifying before packaging produced the files would describe a build that does not exist.
  const flow = source.slice(source.indexOf('const artifacts = collectArtifacts'), source.indexOf('const repairedPublishedRelease'))
  assert.match(flow, /writeBuildStamp\(artifacts, version, headCommit\)/)
})

test('an upload-only run adopts the version already on disk instead of inventing one', () => {
  assert.match(source, /if \(buildStamp && buildStamp\.version !== version\)/)
  assert.match(source, /version = buildStamp\.version/)
})

test('an upload-only resume is not blocked by the version bump it has to resume', () => {
  // The resume path needs the version the artifacts carry, and that version is the one file the
  // failure left uncommitted. A clean-tree rule that ignores the mode excluded the only case the
  // mode exists for, which is how a failed upload came to mean building everything again.
  const guard = source.slice(source.indexOf('function ensureCleanPublishedCommit'), source.indexOf('function prepareReleaseVersion'))
  assert.match(guard, /const versionBump = \(entry\) => uploadOnly &&/)
  assert.match(guard, /const unexpected = entries\.filter\(entry => !versionBump\(entry\)\)/)
  assert.match(guard, /if \(unexpected\.length\)/)
  // Every other modified file still stops the release.
  assert.match(guard, /package\\.json\$\/\.test\(entry\)/)
  assert.doesNotMatch(guard, /if \(status\) \{/)
})

test('a dropped connection is asked again instead of being read as an answer', () => {
  // Every read a publish acts on. One dropped call read as its answer is how the release decided
  // that no draft existed, that the account was still the owner, or that the assets were gone.
  assert.match(source, /const login = captureRetrying\("gh", \["api", "user", "--jq", "\.login"\]\)/)
  assert.match(source, /runRetrying\("gh", \["auth", "status"\]\)/)
  assert.match(source, /captureRetrying\("gh", \["release", "list", "--repo", repository/)
  assert.match(source, /JSON\.parse\(captureRetrying\("gh", \["api", `\/repos\/\$\{repo\}\/releases\/\$\{releaseId\}\/assets\?per_page=100`\]\)\)/)
  assert.match(source, /shouldRetry: transientFailure/)

  // A release lookup answers "not there" only when GitHub says so; a connection failure is asked
  // again rather than reported as an absence.
  const lookup = source.slice(source.indexOf('function releaseInfo'), source.indexOf('function ensureOfficialPublisher'))
  assert.match(lookup, /if \(missingRelease\(message\)\) return null/)
  assert.match(lookup, /retrySync\(/)
  assert.match(lookup, /throw new Error\(message \|\| `gh release view \$\{releaseTag\} failed`\)/)
})

test('creating a draft is resolved by looking again, never by creating a second one', () => {
  // Two drafts for one tag are worse than a failed release: the draft id is the newest match, so the
  // next attempt uploads into the empty one and the release ends up split across both.
  const create = source.slice(source.indexOf('function createDraftRelease'), source.indexOf('function resolveReleaseId'))
  assert.ok(create.indexOf('const existing = releaseInfo(repo, releaseTag)') < create.indexOf('const retried = create()'))
  assert.ok(create.indexOf('const confirmed = releaseInfo(repo, releaseTag)') > create.indexOf('const retried = create()'))
  assert.match(create, /fail\(`Could not create the \$\{releaseTag\} draft release\.`\)/)
  // Retrying a create blindly is exactly the mistake this replaces.
  assert.doesNotMatch(create, /retrySync|runRetrying/)
  assert.match(source, /if \(!release\) \{\s*\n\s*createDraftRelease\(repo, releaseTag, releaseVersion\)/)
})

test('a version commit a failed push left behind is sent instead of deadlocking the release', () => {
  // The resume path returns early once HEAD declares the version, so nothing else would ever push
  // it, and every later attempt stopped at the clean-tree check instead of publishing.
  assert.match(source, /runRetrying\("git", \["fetch", "origin", "main"\]\)/)
  const guard = source.slice(source.indexOf('function ensureCleanPublishedCommit'), source.indexOf('function prepareReleaseVersion'))
  assert.match(guard, /capture\("git", \["log", "-1", "--pretty=%s"\]\) === `chore\(release\): v\$\{packageJson\.version\}`/)
  // Only this release's own commit, and only while its release is unpublished.
  assert.match(guard, /if \(!releaseCommit \|\| \(release && !release\.isDraft\)\)/)
  assert.match(guard, /runRetrying\("git", \["push", "origin", "main"\]\)/)
  assert.match(guard, /if \(needsVersionPush\(capture\("git", \["rev-parse", "HEAD"\]\), remoteAfterPush\)\)/)

  const commit = source.slice(source.indexOf('function commitReleaseVersion'), source.indexOf('function releaseInfo'))
  assert.match(commit, /const remoteHead = captureRetrying\("git", \["ls-remote", "origin", "main"\]\)/)
  assert.match(commit, /if \(needsVersionPush\(head, remoteHead\)\)/)
  assert.match(commit, /runRetrying\("git", \["push", "origin", "main"\]\)/)
})

test('publication may be applied again, because it is a state rather than an event', () => {
  const finalize = source.slice(source.indexOf('function finalizeRelease'), source.indexOf('function ensureCleanPublishedCommit'))
  assert.match(finalize, /runRetrying\("gh", args\)/)
})

test('an early refusal reports itself instead of dying on an undeclared binding', () => {
  // `fail()` restores the version bump an interrupted publish left behind, and the first thing this
  // script does is refuse an unknown argument. With that binding declared further down, refusing an
  // argument died with "cannot access before initialization" and never printed the reason.
  const failBody = source.slice(source.indexOf('function fail(message)'))
  assert.match(failBody, /versionRollback && !versionCommitted/)
  assert.ok(source.indexOf('let versionRollback') < source.indexOf('Unknown argument'))
  assert.ok(source.indexOf('let versionCommitted') < source.indexOf('Unknown argument'))
  assert.equal(source.match(/let versionRollback/g).length, 1)
  assert.equal(source.match(/let versionCommitted/g).length, 1)
})
