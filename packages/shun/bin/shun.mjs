#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 19)) {
  console.error('Shun requires Node.js 22.19 or newer. Use the standalone installer if Node.js is not installed.')
  process.exit(1)
}
await import('../dist/cli.js')
