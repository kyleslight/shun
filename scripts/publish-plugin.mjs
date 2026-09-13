#!/usr/bin/env node
/**
 * Publish a package to the Shun registry.
 *
 *   node --experimental-strip-types scripts/publish-plugin.mjs <package-dir> \
 *     [--changelog "…"] [--version 0.3.1] [--publisher handle] [--state review|published] \
 *     [--registry https://api.shunagent.com]
 *
 * This is the operator path: it authenticates with `SHUN_REGISTRY_OPERATOR_TOKEN`
 * (or `.env.registry`) and publishes curated entries directly. A community
 * publisher goes through the same endpoint with a device-signed authorization
 * header once the application's publisher identity is bound.
 *
 * Everything is checked locally first with the same validator and packer the
 * application uses, so an obvious mistake never reaches the network and the
 * digests the registry stores are the digests of the bytes it received.
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPluginArchive } from '../src/main/plugin-archive.ts'
import { validatePluginPackage } from '../src/plugin-manifest.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const [target, ...rest] = process.argv.slice(2)
if (!target || target.startsWith('--')) {
  console.error('usage: publish-plugin.mjs <package-dir> [--changelog "…"] [--version x.y.z] [--publisher handle] [--state review|published] [--registry url]')
  process.exit(2)
}

const flags = new Map()
for (let index = 0; index < rest.length; index += 1) {
  const flag = rest[index]
  if (!flag.startsWith('--')) continue
  flags.set(flag.slice(2), rest[index + 1]?.startsWith('--') ? 'true' : (rest[index += 1] ?? 'true'))
}

async function operatorToken() {
  if (process.env.SHUN_REGISTRY_OPERATOR_TOKEN) return process.env.SHUN_REGISTRY_OPERATOR_TOKEN
  try {
    const env = await readFile(join(root, '.env.registry'), 'utf8')
    const match = env.match(/^SHUN_REGISTRY_OPERATOR_TOKEN=(.+)$/m)
    if (match) return match[1].trim()
  } catch {}
  console.error('No operator token. Set SHUN_REGISTRY_OPERATOR_TOKEN or keep one in .env.registry.')
  process.exit(2)
}

const packageRoot = resolve(target)
const registry = (flags.get('registry') || 'https://api.shunagent.com').replace(/\/+$/, '')
const manifest = validatePluginPackage(JSON.parse(await readFile(join(packageRoot, 'manifest.json'), 'utf8')), 'installed')
if (flags.has('version')) manifest.version = flags.get('version')

const archive = await createPluginArchive(packageRoot)
console.log(`packed ${manifest.id}@${manifest.version}  ${archive.bytes.length} B archive · ${archive.files} files · ${archive.contentBytes} B unpacked`)
console.log(`  archive sha256 ${archive.sha256}`)
console.log(`  content sha256 ${archive.contentSha256}`)

const body = new FormData()
body.set('archive', new File([archive.bytes], `${manifest.id}-${manifest.version}.shunplugin`, { type: 'application/octet-stream' }))
for (const [field, value] of [['changelog', flags.get('changelog')], ['publisher', flags.get('publisher')], ['state', flags.get('state')]]) if (value) body.set(field, value)

const response = await fetch(`${registry}/v1/publish`, {
  method: 'POST',
  headers: { authorization: `Bearer ${await operatorToken()}` },
  body,
})
const text = await response.text()
let payload
try {
  payload = JSON.parse(text)
} catch {
  payload = { raw: text.slice(0, 400) }
}
if (!response.ok) {
  console.error(`publish failed (HTTP ${response.status}): ${payload.message || payload.error || text.slice(0, 200)}`)
  process.exit(1)
}
console.log(`${payload.status === 'review' ? 'queued for review' : 'published'}: ${payload.id} ${payload.version} by ${payload.publisher}`)
console.log(`  ${registry}/v1/plugins/${payload.id}`)
console.log(`  install: shun://plugin/${payload.id}`)
