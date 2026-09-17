#!/usr/bin/env node

import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { nextPatchVersion } from "./release-version.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const releaseRoot = join(root, "release")
const buildOnly = process.argv.includes("--build-only")
// Retrying an interrupted publish must not pay for the build again: the artifacts are already on
// disk, and only the upload, the version commit, and the publish are still owed.
const uploadOnly = process.argv.includes("--upload-only")
const draft = process.argv.includes("--draft")
const allowUnsigned = process.argv.includes("--allow-unsigned")
const knownArguments = new Set(["--build-only", "--upload-only", "--draft", "--allow-unsigned"])

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
  prepareReleaseVersion()
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

if (uploadOnly) {
  console.log(`\nUploading the already-built Shun ${version} artifacts...\n`)
} else {
  console.log(`\nBuilding Shun ${version} for macOS, Windows, and Linux...\n`)
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

if (buildOnly) {
  console.log("\nBuild complete. Upload was skipped.")
  process.exit(0)
}

await stageDraftRelease(repository, tag, version, artifacts)
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
 * Publishing is limited by the slowest single stream on a long connection: one reset mid-body
 * aborted a whole release twice, and the serial upload paid that risk five times over 700 MB. Each
 * asset now goes on its own connection, a few at a time, with retries, skipping whatever is already
 * on the release, and the result is verified before the version is committed.
 */
async function stageDraftRelease(repo, releaseTag, releaseVersion, artifacts) {
  const release = releaseInfo(repo, releaseTag)

  if (release && !release.isDraft) fail(`Release ${releaseTag} is already published.`)
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
  const releaseId = capture("gh", ["api", `/repos/${repo}/releases?per_page=30`, "--jq", `[.[] | select(.tag_name=="${releaseTag}")][0].id`])
  const remote = new Map(releaseAssets(repo, releaseId).map(asset => [asset.name, asset]))
  const pending = []

  for (const artifact of artifacts) {
    const name = basename(artifact), size = statSync(artifact).size, existing = remote.get(name)
    if (existing && existing.size === size) {
      console.log(`  • already on the release  ${name}`)
      continue
    }
    pending.push({ artifact, name, size, replace: existing?.id })
  }

  if (!pending.length) return

  const concurrency = Math.max(1, Math.min(4, pending.length))
  console.log(`\nUploading ${pending.length} asset(s), ${concurrency} at a time...\n`)
  const failures = []
  let next = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < pending.length) {
      const item = pending[next++]
      try {
        await uploadAsset(repo, releaseId, item)
      } catch (error) {
        failures.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }))
  if (failures.length) fail(`Upload failed for ${failures.length} asset(s):\n  ${failures.join("\n  ")}`)

  verifyReleaseAssets(repo, releaseTag, artifacts)
}

/**
 * The release's assets as the REST API reports them. The GraphQL view returns node ids
 * (`RA_kwDO…`), and deleting an asset by node id is a 404, which leaves the old copy in place and
 * makes the replacement collide with it.
 */
function releaseAssets(repo, releaseId) {
  const payload = JSON.parse(capture("gh", ["api", `/repos/${repo}/releases/${releaseId}/assets?per_page=100`]))
  return Array.isArray(payload) ? payload.map(asset => ({ id: asset.id, name: String(asset.name || ""), size: Number(asset.size) || 0 })) : []
}

/** One asset, retried on its own: a reset costs one file, not the release. */
async function uploadAsset(repo, releaseId, item) {
  if (item.replace) {
    const removed = await runAsync("gh", ["api", "-X", "DELETE", `/repos/${repo}/releases/assets/${item.replace}`])
    if (removed.code !== 0) console.log(`  • could not clear the old copy of ${item.name}: ${lastLine(removed.stderr)}`)
  }
  let last = ""
  for (let attempt = 1; attempt <= 5; attempt++) {
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
    ])
    if (result.code === 0) {
      console.log(`  • uploaded ${item.name} (${(item.size / 1048576).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)}s)`)
      return
    }
    last = lastLine(result.stderr) || lastLine(result.out) || `exit code ${result.code}`
    // An upload can report failure after the asset was created, and a retry then collides with its
    // own copy. What decides success is whether the release holds the file at the right size.
    const present = releaseAssets(repo, releaseId).find(asset => asset.name === item.name)
    if (present && present.size === item.size) {
      console.log(`  • uploaded ${item.name} (${(item.size / 1048576).toFixed(1)} MB, reported ${last})`)
      return
    }
    console.log(`  • attempt ${attempt}/5 failed for ${item.name}: ${last}`)
    if (attempt < 5) await sleep(2_000 * attempt)
  }
  throw new Error(last || "upload failed")
}

function verifyReleaseAssets(repo, releaseTag, artifacts) {
  const releaseId = capture("gh", ["api", `/repos/${repo}/releases?per_page=30`, "--jq", `[.[] | select(.tag_name=="${releaseTag}")][0].id`])
  const remote = new Map(releaseAssets(repo, releaseId).map(asset => [asset.name, asset.size]))
  const missing = artifacts.filter(artifact => remote.get(basename(artifact)) !== statSync(artifact).size)
  if (missing.length) fail(`The release is missing ${missing.length} asset(s):\n  ${missing.map(artifact => basename(artifact)).join("\n  ")}`)
  console.log(`\nRelease assets verified: ${artifacts.length} files match their local size.`)
}

function runAsync(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    let out = "", err = ""
    child.stdout.on("data", (chunk) => { out += chunk })
    child.stderr.on("data", (chunk) => { err += chunk })
    child.on("error", (error) => resolve({ code: -1, out, err: error.message }))
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }))
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
  const status = capture("git", ["status", "--porcelain"])
  if (status) {
    fail("The working tree must be clean before publishing a release.")
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

function commitReleaseVersion() {
  if (!versionRollback) return capture("git", ["rev-parse", "HEAD"])
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

function collectArtifacts(directory) {
  const supportedExtensions = [".dmg", ".zip", ".exe", ".AppImage", ".deb", ".blockmap", ".zsync"]
  const files = ["macos", "windows", "linux"].flatMap((platform) => {
    const platformDirectory = join(directory, platform)
    if (!existsSync(platformDirectory)) return []
    return readdirSync(platformDirectory)
      .map((entry) => join(platformDirectory, entry))
      .filter((path) => statSync(path).isFile())
  })
  return files
    .filter((file) => supportedExtensions.some((extension) => file.endsWith(extension)) || /latest(?:-[a-z]+)?\.ya?ml$/i.test(file))
    .sort((left, right) => left.localeCompare(right))
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
