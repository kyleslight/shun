#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isFresh, recordStamp, sourceDigest } from './build-stamp.mjs'

// macOS only: the simulator driver is Swift and nothing else can build it.
if (process.platform !== 'darwin') process.exit(0)

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = fileURLToPath(import.meta.url)
const source = join(root, 'resources', 'ios-simulator-driver.swift')
const output = join(root, 'build', 'ios-simulator-driver')
mkdirSync(dirname(output), { recursive: true })

// Recompiled only when the driver or this script changed, so an ordinary build
// does not wait for Swift. `--force` rebuilds regardless.
const force = process.argv.includes('--force')
const digest = sourceDigest(root, [source, scriptPath])
if (isFresh(output, digest, force)) {
  console.log('simulator driver: iOS Simulator (Swift) (cached)')
  process.exit(0)
}

const result = spawnSync('/usr/bin/xcrun', [
  'swiftc', source, '-O', '-o', output,
  '-framework', 'AppKit', '-framework', 'ApplicationServices',
], { cwd: root, encoding: 'utf8' })

if (result.error || result.status !== 0) {
  console.error(result.stderr?.trim() || result.error?.message || 'Could not build the iOS Simulator driver.')
  process.exit(result.status || 1)
}
chmodSync(output, 0o755)
recordStamp(output, digest)
console.log('simulator driver: iOS Simulator (Swift)')
