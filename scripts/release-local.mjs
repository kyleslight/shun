#!/usr/bin/env node

import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { nextPatchVersion } from "./release-version.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const releaseRoot = join(root, "release")
const buildOnly = process.argv.includes("--build-only")
const draft = process.argv.includes("--draft")
const allowUnsigned = process.argv.includes("--allow-unsigned")
const knownArguments = new Set(["--build-only", "--draft", "--allow-unsigned"])

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

console.log(`\nBuilding Shun ${version} for macOS, Windows, and Linux...\n`)
run("pnpm", ["test"])
run("pnpm", ["run", "typecheck"])
run("pnpm", ["run", "build"])

cleanReleaseDirectory()
const macArguments = ["--mac", "dmg", "zip", "--arm64"]
if (signingIdentity && notarizationReady) macArguments.push("--config.mac.notarize=true")
buildPlatform("macOS (Apple Silicon)", macArguments, "macos")
await smokeTestMacApp()
buildPlatform("Windows", ["--win", "nsis", "--x64"], "windows")
buildPlatform("Linux", ["--linux", "AppImage", "deb", "--x64"], "linux")

const artifacts = collectArtifacts(releaseRoot)
if (artifacts.length === 0) {
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

stageDraftRelease(repository, tag, version, artifacts)
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

async function smokeTestMacApp() {
  const executable = join(releaseRoot, "macos", "mac-arm64", "Shun.app", "Contents", "MacOS", "Shun")
  if (!existsSync(executable)) fail(`Packaged macOS executable was not found: ${executable}`)

  const userData = mkdtempSync(join(tmpdir(), "shun-release-smoke-"))
  console.log("\nSmoke-testing the packaged macOS app for 8 seconds...\n")
  const child = spawn(executable, [`--user-data-dir=${userData}`], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  const appendOutput = (chunk) => {
    output = `${output}${chunk}`.slice(-8_000)
  }
  child.stdout.on("data", appendOutput)
  child.stderr.on("data", appendOutput)

  const result = await new Promise((resolve) => {
    let survived = false
    let forceKillTimer
    const timer = setTimeout(() => {
      survived = true
      child.kill("SIGTERM")
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000)
    }, 8_000)
    child.once("error", (error) => {
      clearTimeout(timer)
      clearTimeout(forceKillTimer)
      resolve({ ok: false, error })
    })
    child.once("exit", (code, signal) => {
      clearTimeout(timer)
      clearTimeout(forceKillTimer)
      resolve(survived
        ? { ok: true }
        : { ok: false, error: Error(`exited early with code ${code ?? "none"} and signal ${signal ?? "none"}`) })
    })
  })

  try {
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    warn(`Could not remove smoke-test data at ${userData}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!result.ok) {
    fail(`Packaged macOS app smoke test failed: ${result.error.message}${output ? `\n${output.trim()}` : ""}`)
  }
  console.log("Packaged macOS app stayed running; smoke test passed.")
}

function stageDraftRelease(repo, releaseTag, releaseVersion, artifacts) {
  const release = releaseInfo(repo, releaseTag)

  if (release?.isDraft) {
    run("gh", ["release", "upload", releaseTag, ...artifacts, "--repo", repo, "--clobber"])
    return
  }
  if (release) fail(`Release ${releaseTag} is already published.`)

  const args = [
    "release",
    "create",
    releaseTag,
    ...artifacts,
    "--repo",
    repo,
    "--target",
    "main",
    "--title",
    `Shun ${releaseVersion}`,
    "--generate-notes",
    "--draft",
  ]
  run("gh", args)
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
