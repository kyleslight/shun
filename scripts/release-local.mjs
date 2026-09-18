#!/usr/bin/env node

import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { nextPatchVersion } from "./release-version.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const releaseRoot = join(root, "release")
// The build stamp belongs above the publishing flow with every other constant that flow reads: a
// `const` placed after it is still in its temporal dead zone when a release starts.
const buildStampPath = join(releaseRoot, ".publish-stamp.json")
/**
 * An upload that has already sent its body and is waiting for a response can wait forever. Nothing
 * closes that connection, and `gh api` has no deadline of its own, so publishing 0.1.42 stalled for
 * over four minutes on a completed 152 MB body with the asset still unfinished. A stalled attempt has
 * to become a failed attempt, because only a failure is retried; ten minutes bounds that while still
 * leaving room for the 163 MB AppImage to cross a slow link.
 */
const uploadAttemptTimeoutMs = 10 * 60 * 1000
const buildOnly = process.argv.includes("--build-only")
// Retrying an interrupted publish must not pay for the build again: the artifacts are already on
// disk, and only the upload, the version commit, and the publish are still owed.
const uploadOnly = process.argv.includes("--upload-only")
const draft = process.argv.includes("--draft")
const allowUnsigned = process.argv.includes("--allow-unsigned")
const knownArguments = new Set(["--build-only", "--upload-only", "--draft", "--allow-unsigned"])

// The release flow below runs as soon as this module is evaluated, so everything it reads has to be
// declared above it: a `const` placed after the flow is in its temporal dead zone when a release
// starts, and the failure lands in the middle of a publish.

/**
 * A manifest is what the updater trusts, and it is a couple of hundred bytes: it is always the
 * file this build wrote. Skipping one because its byte length matched shipped a feed whose sha512
 * belonged to an earlier build, which makes every update download fail its own checksum.
 */
const manifestPattern = /^(?:latest[^/]*\.ya?ml|SHA256SUMS\.txt)$/

/** GitHub stamps the upload; this machine wrote the artifact. Skew must not read as "older". */
const uploadClockToleranceMs = 5 * 60 * 1000

for (const argument of process.argv.slice(2)) {
  if (!knownArguments.has(argument)) {
    fail(`Unknown argument: ${argument}`)
  }
}

loadEnvironment(join(root, ".env.release"))

const packageJsonPath = join(root, "package.json")
let packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"))
let version = packageJson.version
let tag = `v${version}`
let versionRollback = ""
let versionCommitted = false
const repository = repositorySlug()
const officialRepository = "kyleslight/shun"

if (process.platform !== "darwin") {
  fail("The all-platform release command must run on macOS because it creates a macOS DMG.")
}

requireCommand("pnpm", ["--version"])
requireCommand("git", ["--version"])

if (!buildOnly) {
  requireCommand("gh", ["--version"])
  ensureOfficialPublisher(repository)
  ensureCleanPublishedCommit()
  run("gh", ["auth", "status"])
  // The artifacts on disk already carry the version this workspace declares, and an upload-only run
  // exists to place those exact files. Numbering them again invents a release for a build that was
  // never made from it, so the version is left exactly as it is.
  if (!uploadOnly) prepareReleaseVersion()
}

const signingIdentity = findDeveloperIdIdentity()
const notarizationReady = hasNotarizationCredentials()

if (!signingIdentity) {
  const message = "No Developer ID Application certificate was found. The macOS package will be unsigned."
  if (!buildOnly && !allowUnsigned) {
    fail(`${message} Install the certificate or rerun with --allow-unsigned.`)
  }
  warn(message)
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false"
} else {
  console.log(`Using macOS signing identity: ${signingIdentity}`)
  process.env.CSC_NAME = signingIdentity
}

if (signingIdentity && !notarizationReady) {
  const message = "macOS notarization credentials are incomplete."
  if (!buildOnly && !allowUnsigned) {
    fail(`${message} Configure .env.release or rerun with --allow-unsigned.`)
  }
  warn(message)
}

const buildStamp = readBuildStamp()
// The commit the artifacts would be built from. Nothing changes HEAD between here and the version
// commit, so a stamp that names this commit describes the files this run would produce.
const headCommit = capture("git", ["rev-parse", "HEAD"])

if (uploadOnly) {
  // The artifacts on disk carry their own version, and an interrupted publish leaves the workspace
  // declaring the previous one. The stamp decides what is being uploaded. Nothing is renumbered:
  // these bytes were built from that version, and inventing a new number would publish a release
  // for a build that was never made from it.
  if (buildStamp && buildStamp.version !== version) {
    console.log(`Uploading the ${buildStamp.version} build already on disk.`)
    version = buildStamp.version
    tag = `v${version}`
  }
  console.log(`\nUploading the already-built Shun ${version} artifacts...\n`)
} else if (reusableBuild(buildStamp, version, headCommit)) {
  console.log(`\nShun ${version} is already packaged from ${headCommit.slice(0, 7)}. Uploading that build instead of packaging it again.\n`)
} else {  console.log(`\nBuilding Shun ${version} for macOS, Windows, and Linux...\n`)
  run("pnpm", ["test"])
  run("pnpm", ["run", "typecheck"])
  run("pnpm", ["run", "build"])

  cleanReleaseDirectory()
  const macArguments = ["--mac", "dmg", "zip", "--arm64"]
  if (signingIdentity && notarizationReady) macArguments.push("--config.mac.notarize=true")
  buildPlatform("macOS (Apple Silicon)", macArguments, "macos")
  buildPlatform("Windows", ["--win", "nsis", "--x64"], "windows")
  buildPlatform("Linux", ["--linux", "AppImage", "deb", "--x64"], "linux")
}

const artifacts = collectArtifacts(releaseRoot)
if (artifacts.length === 0) {
  if (uploadOnly) fail("No artifacts found in release/. Run a full publish first.")
  fail("Packaging completed without producing release artifacts.")
}

const checksumFile = join(releaseRoot, "SHA256SUMS.txt")
writeChecksums(artifacts, checksumFile)
artifacts.push(checksumFile)

console.log("\nRelease artifacts:")
for (const artifact of artifacts) {
  console.log(`  ${relative(root, artifact)}`)
}

// Certify this exact set so an interrupted upload resumes from these bytes rather than building
// them again. Written only after packaging produced them, so a stamp always describes real files.
writeBuildStamp(artifacts, version, headCommit)

if (buildOnly) {
  console.log("\nBuild complete. Upload was skipped.")
  process.exit(0)
}

const repairedPublishedRelease = await stageDraftRelease(repository, tag, version, artifacts)
if (repairedPublishedRelease) {
  console.log(`\n${tag} was already published; its assets now match this build.`)
  process.exit(0)
}
const releaseCommit = commitReleaseVersion()
finalizeRelease(repository, tag, releaseCommit)
console.log(`\n${draft ? "Prepared draft" : "Published"} ${tag} at https://github.com/${repository}/releases/tag/${tag}`)

function buildPlatform(label, platformArguments, outputDirectory) {
  console.log(`\nPackaging ${label}...\n`)
  run("pnpm", [
    "exec",
    "electron-builder",
    ...platformArguments,
    `--config.directories.output=release/${outputDirectory}`,
    "--publish",
    "never",
  ])
}

/**
 * A draft that was created a moment ago is not always in the list yet, and one whose tag name
 * is not visible yet cannot be selected at all. Listing once right after `gh release create`
 * returned an empty id, and the asset call then went to `/releases//assets` as a 404. Wait for
 * the draft to become addressable instead of assuming the write is already readable.
 */
async function resolveReleaseId(repo, releaseTag) {
  const deadline = Date.now() + 30_000
  for (;;) {
    const id = capture("gh", ["api", `/repos/${repo}/releases?per_page=30`, "--jq", `[.[] | select(.tag_name=="${releaseTag}")][0].id`])
    if (id) return id
    if (Date.now() >= deadline) fail(`Release ${releaseTag} never appeared in the release list.`)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

/**
 * Publishing is limited by the slowest single stream on a long connection: one reset mid-body
 * aborted a whole release twice, and the serial upload paid that risk five times over 700 MB. Each
 * asset now goes on its own connection, a few at a time, with retries, skipping whatever is already
 * on the release, and the result is verified before the version is committed.
 */
async function stageDraftRelease(repo, releaseTag, releaseVersion, artifacts) {
  const release = releaseInfo(repo, releaseTag)
  // A published release is final, with one exception: the files it already serves. A manifest that
  // does not describe them breaks the updater for every user, so an upload-only run may repair it
  // in place — there is nothing left to commit or to publish in that case.
  const published = Boolean(release && !release.isDraft)
  if (published && !uploadOnly) fail(`Release ${releaseTag} is already published.`)
  if (!release) {
    run("gh", [
      "release",
      "create",
      releaseTag,
      "--repo",
      repo,
      "--target",
      "main",
      "--title",
      `Shun ${releaseVersion}`,
      "--generate-notes",
      "--draft",
    ])
  }

  // A draft is not reachable through /releases/tags/<tag>, so its numeric id comes from the list.
  const releaseId = await resolveReleaseId(repo, releaseTag)
  const remote = new Map(releaseAssets(repo, releaseId).map(asset => [asset.name, asset]))
  const pending = []

  for (const artifact of artifacts) {
    const name = basename(artifact), size = statSync(artifact).size, existing = remote.get(name)
    if (existing?.uploaded && !manifestPattern.test(name) && existing.size === size && uploadedAfter(artifact, existing)) {
      console.log(`  • already on the release  ${name}`)
      continue
    }
    pending.push({ artifact, name, size })
  }

  if (pending.length) {
    console.log(`\nUploading ${pending.length} asset(s), one at a time...\n`)
    const failures = []
    // One stream at a time. Four parallel installers through a shaped connection are cut mid-body
    // and GitHub answers "Error saving asset", which is how a release ends up with uploads nobody
    // can download; a serial retry is what actually gets the files across.
    for (const item of pending) {
      try {
        await uploadAsset(repo, releaseId, item)
      } catch (error) {
        failures.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failures.length) fail(`Upload failed for ${failures.length} asset(s):\n  ${failures.join("\n  ")}`)
  }

  verifyReleaseAssets(repo, releaseTag, artifacts)
  return published
}

/**
 * Two builds of the same source differ by a handful of bytes, so an asset from an earlier build
 * can accidentally have this one's exact length. What separates them is time: the remote copy is
 * only trusted when it was uploaded after this build wrote the file.
 */
function uploadedAfter(artifact, asset) {
  return Boolean(asset.updatedAt) && asset.updatedAt >= statSync(artifact).mtimeMs - uploadClockToleranceMs
}

/**
 * The release's assets as the REST API reports them. The GraphQL view returns node ids
 * (`RA_kwDO…`), and deleting an asset by node id is a 404, which leaves the old copy in place and
 * makes the replacement collide with it.
 */
function releaseAssets(repo, releaseId) {
  const payload = JSON.parse(capture("gh", ["api", `/repos/${repo}/releases/${releaseId}/assets?per_page=100`]))
  return Array.isArray(payload) ? payload.map(asset => ({
    id: asset.id,
    name: String(asset.name || ""),
    size: Number(asset.size) || 0,
    digest: typeof asset.digest === "string" ? asset.digest : "",
    updatedAt: Date.parse(asset.updated_at) || 0,
    // An upload GitHub never finished is recorded as `starter`, and the size it reports is the
    // length the client declared rather than the bytes it received. It is not a file anyone can
    // download, so a matching size must never be read as success.
    uploaded: asset.state === "uploaded",
  })) : []
}

/** One asset, retried on its own: a reset costs one file, not the release. */
async function uploadAsset(repo, releaseId, item) {
  let last = ""
  for (let attempt = 1; attempt <= 5; attempt++) {
    // Every attempt clears whatever carries this name. A failed attempt can leave an unfinished
    // record behind, and the next POST then collides with it instead of uploading the file.
    await clearAsset(repo, releaseId, item.name, item.size)
    const started = Date.now()
    const result = await runAsync("gh", [
      "api",
      "-X",
      "POST",
      "-H",
      "Content-Type: application/octet-stream",
      "--input",
      item.artifact,
      // The upload endpoint lives on uploads.github.com, which gh only reaches through an absolute
      // URL: the plain path is served by api.github.com and answers 404 there.
      `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(item.name)}`,
    ], uploadAttemptTimeoutMs)
    if (result.code === 0) {
      console.log(`  • uploaded ${item.name} (${(item.size / 1048576).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)}s)`)
      return
    }
    last = lastLine(result.stderr) || lastLine(result.out) || `exit code ${result.code}`
    // An upload can report failure after the asset was created, and a retry then collides with its
    // own copy. What decides success is whether the release holds a finished file at the right size.
    const present = releaseAssets(repo, releaseId).find(asset => asset.name === item.name)
    if (present?.uploaded && present.size === item.size) {
      console.log(`  • uploaded ${item.name} (${(item.size / 1048576).toFixed(1)} MB, reported ${last})`)
      return
    }
    console.log(`  • attempt ${attempt}/5 failed for ${item.name}: ${last}`)
    if (attempt < 5) await sleep(2_000 * attempt)
  }
  throw new Error(last || "upload failed")
}

/**
 * A record that is not a finished file at the right length is a leftover from an upload nobody can
 * download, and it must not stand in the way of the upload that replaces it.
 */
async function clearAsset(repo, releaseId, name, size) {
  const existing = releaseAssets(repo, releaseId).find(asset => asset.name === name)
  if (!existing || (existing.uploaded && existing.size === size)) return
  const removed = await runAsync("gh", ["api", "-X", "DELETE", `/repos/${repo}/releases/assets/${existing.id}`])
  if (removed.code !== 0) console.log(`  • could not clear the old copy of ${name}: ${lastLine(removed.stderr)}`)
}

/**
 * The feed the updater reads has to describe files that are actually on the release, and it has to
 * be the file this build wrote: electron-updater refuses a download whose size or sha512 is not the
 * one the manifest declares, so a stale manifest breaks the update for every user on every attempt.
 *
 * sha512 cannot be re-read from the release without downloading hundreds of megabytes, so the check
 * is the pair that matters: byte-identical manifest, plus an artifact at the declared length. Any
 * asset GitHub does report a digest for is compared against its local sha256 as well.
 */
function verifyReleaseAssets(repo, releaseTag, artifacts) {
  const releaseId = capture("gh", ["api", `/repos/${repo}/releases?per_page=30`, "--jq", `[.[] | select(.tag_name=="${releaseTag}")][0].id`])
  const assets = releaseAssets(repo, releaseId)
  const remote = new Map(assets.map(asset => [asset.name, asset]))
  // GitHub hides and refuses to serve an upload it never finished, so the release page and every
  // download would be missing it while the API still reports its declared size.
  const unfinished = artifacts.filter(artifact => remote.get(basename(artifact))?.uploaded === false)
  if (unfinished.length) fail(`The release holds ${unfinished.length} unfinished upload(s):\n  ${unfinished.map(artifact => basename(artifact)).join("\n  ")}`)
  const missing = artifacts.filter(artifact => remote.get(basename(artifact))?.size !== statSync(artifact).size)
  if (missing.length) fail(`The release is missing ${missing.length} asset(s):\n  ${missing.map(artifact => basename(artifact)).join("\n  ")}`)

  const mismatched = artifacts.filter(artifact => {
    const digest = remote.get(basename(artifact))?.digest
    return Boolean(digest) && digest !== `sha256:${sha256(artifact)}`
  })
  if (mismatched.length) fail(`The release holds a different file for ${mismatched.length} asset(s):\n  ${mismatched.map(artifact => basename(artifact)).join("\n  ")}`)

  const manifests = artifacts.filter(artifact => manifestPattern.test(basename(artifact)))
  const stale = manifests.filter(manifest => downloadAssetText(repo, remote.get(basename(manifest))) !== readFileSync(manifest, "utf8").trim())
  if (stale.length) fail(`The release holds an older copy of ${stale.length} manifest(s):\n  ${stale.map(manifest => basename(manifest)).join("\n  ")}`)

  const unpublished = []
  for (const manifest of manifests) {
    for (const entry of declaredFiles(readFileSync(manifest, "utf8"))) {
      const asset = remote.get(entry.url)
      if (!asset || (entry.size && asset.size !== entry.size)) unpublished.push(`${entry.url} (declared by ${basename(manifest)})`)
    }
  }
  if (unpublished.length) fail(`The update feed names files the release does not hold:\n  ${unpublished.join("\n  ")}`)

  const downloaded = assets.filter(asset => asset.uploaded).length
  console.log(`\nRelease assets verified: ${artifacts.length} files match their local size, ${downloaded} uploaded, ${manifests.length} manifest(s) match byte for byte.`)
}

/** The files a channel file promises, with the length the updater will insist on. */
function declaredFiles(text) {
  const files = []
  let current = null
  for (const line of text.split("\n")) {
    const url = /^\s*-\s*url:\s*(.+?)\s*$/.exec(line)
    if (url) { current = { url: url[1].replace(/^["']|["']$/g, ""), size: 0 }; files.push(current); continue }
    const size = /^\s*size:\s*(\d+)\s*$/.exec(line)
    if (size && current) current.size = Number(size[1])
  }
  return files
}

function downloadAssetText(repo, asset) {
  if (!asset) return ""
  return capture("gh", ["api", "-H", "Accept: application/octet-stream", `/repos/${repo}/releases/assets/${asset.id}`])
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function runAsync(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    let out = "", err = "", timedOut = false
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs) : undefined
    const settle = (event) => {
      if (timer) clearTimeout(timer)
      resolve(event)
    }
    child.stdout.on("data", (chunk) => { out += chunk })
    child.stderr.on("data", (chunk) => { err += chunk })
    child.on("error", (error) => settle({ code: -1, out, err: error.message }))
    child.on("close", (code) => settle({
      code: timedOut ? -1 : (code ?? -1),
      out,
      err: timedOut ? `${err}\nstalled: no response within ${Math.round(timeoutMs / 1000)}s` : err,
    }))
  })
}

function lastLine(value) {
  const lines = String(value || "").trim().split("\n").filter(Boolean)
  return lines[lines.length - 1] || ""
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function finalizeRelease(repo, releaseTag, target) {
  const args = ["release", "edit", releaseTag, "--repo", repo, "--target", target]
  if (!draft) args.push("--draft=false", "--latest")
  run("gh", args)
}

function ensureCleanPublishedCommit() {
  // An upload-only run exists to resume a publish whose upload failed before the version was
  // committed, and the version it has to resume is the one in package.json. Requiring a clean tree
  // therefore excluded exactly the case the mode was written for: the artifacts were on disk, the
  // version was the one uncommitted file, and the only way left to place them was to build them
  // again. That single bump is the publication in progress, and the commit still happens after the
  // upload succeeds; anything else in the tree is unrelated work and still stops the release.
  const entries = capture("git", ["status", "--porcelain"]).split("\n").filter(Boolean)
  const versionBump = (entry) => uploadOnly && /(?:^|\s)package\.json$/.test(entry)
  const unexpected = entries.filter(entry => !versionBump(entry))
  if (unexpected.length) {
    fail(`The working tree must be clean before publishing a release.\n  ${unexpected.join("\n  ")}`)
  }

  const branch = capture("git", ["branch", "--show-current"])
  if (branch !== "main") {
    fail(`Releases must be published from main, not ${branch || "a detached HEAD"}.`)
  }

  run("git", ["fetch", "origin", "main"])
  const head = capture("git", ["rev-parse", "HEAD"])
  const remoteHead = capture("git", ["rev-parse", "origin/main"])
  if (head !== remoteHead) {
    fail("Local main must exactly match origin/main before publishing a release.")
  }
}

function prepareReleaseVersion() {
  const currentTag = `v${packageJson.version}`
  const headSubject = capture("git", ["log", "-1", "--pretty=%s"])
  const currentRelease = releaseInfo(repository, currentTag)
  const retryInterruptedRelease = headSubject === `chore(release): ${currentTag}` && (!currentRelease || currentRelease.isDraft)
  if (retryInterruptedRelease) {
    console.log(`Retrying the unpublished ${currentTag} release.`)
    return
  }

  versionRollback = readFileSync(packageJsonPath, "utf8")
  const previousVersion = packageJson.version
  const releases = JSON.parse(capture("gh", ["release", "list", "--repo", repository, "--limit", "100", "--json", "tagName,isDraft"]))
  const releaseTags = releases.filter((release) => !release.isDraft).map((release) => release.tagName)
  try {
    version = nextPatchVersion(previousVersion, releaseTags)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  tag = `v${version}`
  packageJson = { ...packageJson, version }
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
  console.log(`Release version: ${previousVersion} → ${version}`)
}

/**
 * The version commit is owed whenever the repository does not yet declare the version being
 * published — not only when this run is the one that advanced it. An upload-only run places
 * artifacts it did not number, and it still owes the commit that makes HEAD agree with them.
 * Asking `versionRollback` instead answered "did this run bump the version", so upload-only runs
 * returned early and published a release pointing at a commit whose package.json named the
 * previous version.
 */
function commitReleaseVersion() {
  const committedVersion = (() => {
    try {
      return JSON.parse(captureOptional("git", ["show", "HEAD:package.json"])).version ?? ""
    } catch {
      return ""
    }
  })()
  if (committedVersion === version) return capture("git", ["rev-parse", "HEAD"])
  run("git", ["add", "package.json"])
  run("git", ["commit", "-m", `chore(release): ${tag}`])
  versionCommitted = true
  versionRollback = ""
  run("git", ["push", "origin", "main"])
  return capture("git", ["rev-parse", "HEAD"])
}

function releaseInfo(repo, releaseTag) {
  const output = captureOptional("gh", ["release", "view", releaseTag, "--repo", repo, "--json", "isDraft,tagName"])
  return output ? JSON.parse(output) : null
}

function ensureOfficialPublisher(repo) {
  if (repo.toLowerCase() !== officialRepository) {
    fail(`Publishing is restricted to ${officialRepository}.`)
  }

  const login = capture("gh", ["api", "user", "--jq", ".login"])
  if (login.toLowerCase() !== "kyleslight") {
    fail("Publishing is restricted to the repository owner.")
  }
}

function repositorySlug() {
  const remote = capture("git", ["remote", "get-url", "origin"])
  const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)
  if (!match) fail(`Could not determine a GitHub repository from origin: ${remote}`)
  return match[1]
}

function cleanReleaseDirectory() {
  const resolved = resolve(releaseRoot)
  if (resolved !== join(root, "release")) {
    fail(`Refusing to clean unexpected directory: ${resolved}`)
  }
  rmSync(resolved, { recursive: true, force: true })
}

/**
 * A packaging run leaves a stamp naming the commit it built from and the exact files it produced.
 * Re-running a publish after an interrupted upload reads that stamp and uploads the build already on
 * disk instead of paying for macOS packaging, notarization, and three platform builds a second time.
 *
 * The commit is what makes reuse safe rather than merely fast: an artifact set is reused only when
 * this workspace is still the revision that produced it, so bits from another commit can never be
 * published under this one. The recorded sizes catch a build that was interrupted half-written.
 */
function readBuildStamp() {
  if (!existsSync(buildStampPath)) return null
  try {
    const stamp = JSON.parse(readFileSync(buildStampPath, "utf8"))
    if (typeof stamp?.version !== "string" || typeof stamp?.commit !== "string" || !Array.isArray(stamp?.artifacts)) return null
    return stamp
  } catch {
    return null
  }
}

function reusableBuild(stamp, expectedVersion, commit) {
  if (!stamp || stamp.version !== expectedVersion || stamp.commit !== commit || stamp.artifacts.length === 0) return false
  return stamp.artifacts.every((entry) => {
    if (typeof entry?.path !== "string") return false
    const path = join(root, entry.path)
    return existsSync(path) && statSync(path).size === entry.size
  })
}

function writeBuildStamp(artifacts, builtVersion, commit) {
  writeFileSync(buildStampPath, `${JSON.stringify({
    version: builtVersion,
    commit,
    artifacts: artifacts.map((artifact) => ({ path: relative(root, artifact), size: statSync(artifact).size })),
  }, null, 2)}\n`)
}

function collectArtifacts(directory) {
  const supportedExtensions = [".dmg", ".zip", ".exe", ".AppImage", ".deb", ".blockmap", ".zsync"]
  // Platforms are walked in the order the release is built, so an interrupted publish is repaired in
  // the order the files were produced rather than the alphabet's.
  return ["macos", "windows", "linux"].flatMap((platform) => {
    const platformDirectory = join(directory, platform)
    if (!existsSync(platformDirectory)) return []
    return readdirSync(platformDirectory)
      .sort((left, right) => left.localeCompare(right))
      .map((entry) => join(platformDirectory, entry))
      .filter((path) => statSync(path).isFile())
      .filter((file) => supportedExtensions.some((extension) => file.endsWith(extension)) || /latest(?:-[a-z]+)?\.ya?ml$/i.test(file))
  })
}

function writeChecksums(artifacts, destination) {
  const lines = artifacts.map((artifact) => {
    const digest = createHash("sha256").update(readFileSync(artifact)).digest("hex")
    return `${digest}  ${relative(releaseRoot, artifact)}`
  })
  writeFileSync(destination, `${lines.join("\n")}\n`)
}

function findDeveloperIdIdentity() {
  if (process.platform !== "darwin") return ""
  const output = captureOptional("security", ["find-identity", "-v", "-p", "codesigning"])
  const line = output.split("\n").find((value) => value.includes("Developer ID Application:"))
  return line?.match(/"Developer ID Application:\s*(.+)"/)?.[1] ?? ""
}

function hasNotarizationCredentials() {
  const appleId = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
  const apiKey = Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)
  return appleId || apiKey
}

function loadEnvironment(path) {
  if (!existsSync(path)) return
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const separator = line.indexOf("=")
    if (separator < 1) fail(`Invalid line in .env.release: ${rawLine}`)
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

function requireCommand(command, versionArguments) {
  if (!commandSucceeds(command, versionArguments)) {
    fail(`Required command is unavailable: ${command}`)
  }
}

function commandSucceeds(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: "ignore" })
  return result.status === 0
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, encoding: "utf8" })
  if (result.error || result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed.\n${result.stderr?.trim() ?? result.error?.message ?? ""}`)
  }
  return result.stdout.trim()
}

function captureOptional(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : ""
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: "inherit" })
  if (result.error || result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`)
  }
}

function warn(message) {
  console.warn(`Warning: ${message}`)
}

function fail(message) {
  if (versionRollback && !versionCommitted) {
    writeFileSync(packageJsonPath, versionRollback)
    versionRollback = ""
  }
  console.error(`\nRelease failed: ${message}\n`)
  process.exit(1)
}
