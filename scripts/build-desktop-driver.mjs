#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isFresh, recordStamp, sourceDigest } from './build-stamp.mjs'

/**
 * Builds one desktop driver per platform the release packages.
 *
 * macOS is Swift, because ScreenCaptureKit and the Accessibility API have no Go
 * equivalent. Windows and Linux are one Go program compiled for each target, so
 * the release machine (which is macOS) produces all three. `--host-only` builds
 * just the current platform, which is what development needs.
 *
 * A driver is rebuilt only when its sources actually changed: the sources are
 * hashed into a stamp beside the binary, so an ordinary build does not pay for a
 * Swift compile or two cross-compiles. `--force` ignores the stamps.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildDirectory = join(root, 'build')
const goSource = join(root, 'resources', 'desktop-driver')
const swiftSource = join(root, 'resources', 'desktop-driver.swift')
const scriptPath = fileURLToPath(import.meta.url)
mkdirSync(buildDirectory, { recursive: true })

const force = process.argv.includes('--force')
const hostOnly = process.argv.includes('--host-only')

const crossTargets = [
  { goos: 'windows', goarch: 'amd64', file: 'desktop-driver-win32-x64.exe', packaged: 'desktop-driver.exe' },
  { goos: 'linux', goarch: 'amd64', file: 'desktop-driver-linux-x64', packaged: 'desktop-driver' },
]

function fail(message) {
  console.error(message)
  process.exit(1)
}

function goFiles() {
  return readdirSync(goSource)
    .filter(name => name.endsWith('.go') || name === 'go.mod')
    .map(name => join(goSource, name))
}

function goAvailable() {
  const probe = spawnSync('go', ['version'], { encoding: 'utf8' })
  return !probe.error && probe.status === 0
}

function buildGo(target, digest) {
  const output = join(buildDirectory, target.file)
  if (isFresh(output, digest, force)) return `${target.goos}/${target.goarch} (cached)`
  rmSync(output, { force: true })
  const result = spawnSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', output, '.'], {
    cwd: goSource,
    encoding: 'utf8',
    env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: '0' },
  })
  if (result.error || result.status !== 0) {
    fail(result.stderr?.trim() || result.error?.message || `Could not build the ${target.goos}/${target.goarch} desktop driver.`)
  }
  recordStamp(output, digest)
  return `${target.goos}/${target.goarch}`
}

function buildSwiftDriver(digest) {
  if (!existsSync(swiftSource)) fail(`The macOS desktop driver source is missing: ${swiftSource}`)
  const output = join(buildDirectory, 'desktop-driver')
  if (isFresh(output, digest, force)) return 'macOS (Swift) (cached)'
  const result = spawnSync('/usr/bin/xcrun', [
    'swiftc', swiftSource, '-O', '-o', output,
    '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit',
  ], { cwd: root, encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    fail(result.stderr?.trim() || result.error?.message || 'Could not build the macOS desktop driver. Run this on macOS with Xcode installed.')
  }
  chmodSync(output, 0o755)
  recordStamp(output, digest)
  return 'macOS (Swift)'
}

const needsCross = ['win32', 'linux'].includes(process.platform) || (!hostOnly && process.platform === 'darwin')
if (needsCross && !goAvailable()) {
  fail('Go 1.21 or later is required to build the Windows and Linux desktop drivers. Install it, or run with --host-only on a machine that does not package those platforms.')
}

const results = []
if (process.platform === 'darwin') results.push(buildSwiftDriver(sourceDigest(root, [swiftSource, scriptPath])))
if (needsCross) {
  // The Go driver's own sources are the input; this script is too, for its flags.
  const digest = sourceDigest(root, [...goFiles(), scriptPath])
  for (const target of crossTargets) results.push(buildGo(target, digest))
}
for (const result of results) console.log(`desktop driver: ${result}`)

// The development and single-platform paths expect the canonical name.
if (['win32', 'linux'].includes(process.platform)) {
  const host = crossTargets.find(target => target.goos === process.platform)
  if (host) copyFileSync(join(buildDirectory, host.file), join(buildDirectory, host.packaged))
}
