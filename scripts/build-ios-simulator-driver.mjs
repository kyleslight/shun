#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') process.exit(0)

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'resources', 'ios-simulator-driver.swift')
const output = join(root, 'build', 'ios-simulator-driver')
mkdirSync(dirname(output), { recursive: true })

const result = spawnSync('/usr/bin/xcrun', [
  'swiftc', source, '-O', '-o', output,
  '-framework', 'AppKit', '-framework', 'ApplicationServices',
], { cwd: root, encoding: 'utf8' })

if (result.error || result.status !== 0) {
  console.error(result.stderr?.trim() || result.error?.message || 'Could not build the iOS Simulator driver.')
  process.exit(result.status || 1)
}
chmodSync(output, 0o755)
