#!/usr/bin/env node

import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

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

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const version = packageJson.version
const tag = `v${version}`
const repository = repositorySlug()

if (process.platform !== "darwin") {
  fail("The all-platform release command must run on macOS because it creates a macOS DMG.")
}

requireCommand("pnpm", ["--version"])
requireCommand("git", ["--version"])

if (!buildOnly) {
  requireCommand("gh", ["--version"])
  ensureCleanPublishedCommit()
  run("gh", ["auth", "status"])
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
const macArguments = ["--mac", "dmg", "--arm64"]
if (signingIdentity && notarizationReady) macArguments.push("--config.mac.notarize=true")
buildPlatform("macOS (Apple Silicon)", macArguments, "macos")
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

publishRelease(repository, tag, version, artifacts)
console.log(`\nPublished ${tag} to https://github.com/${repository}/releases/tag/${tag}`)

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

function publishRelease(repo, releaseTag, releaseVersion, artifacts) {
  const releaseExists = commandSucceeds("gh", ["release", "view", releaseTag, "--repo", repo])

  if (releaseExists) {
    run("gh", ["release", "upload", releaseTag, ...artifacts, "--repo", repo, "--clobber"])
    return
  }

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
  ]
  if (draft) args.push("--draft")
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
  const supportedExtensions = [".dmg", ".exe", ".AppImage", ".deb"]
  const files = ["macos", "windows", "linux"].flatMap((platform) => {
    const platformDirectory = join(directory, platform)
    if (!existsSync(platformDirectory)) return []
    return readdirSync(platformDirectory)
      .map((entry) => join(platformDirectory, entry))
      .filter((path) => statSync(path).isFile())
  })
  return files
    .filter((file) => supportedExtensions.some((extension) => file.endsWith(extension)))
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
  return line?.match(/"(.+)"/)?.[1] ?? ""
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
  console.error(`\nRelease failed: ${message}\n`)
  process.exit(1)
}
