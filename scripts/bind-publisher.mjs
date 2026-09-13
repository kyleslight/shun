#!/usr/bin/env node
/**
 * Bind a publisher identity against the live registry and prove the community
 * publish path end to end.
 *
 *   node --experimental-strip-types scripts/bind-publisher.mjs <challengeId> <code> [handle]
 *
 * It generates a device key, verifies the code, submits a throwaway package
 * signed by that key, and reports what the registry did with it: a community
 * submission must land in review, never in the store.
 */
import { createHash, generateKeyPairSync, randomUUID, sign as signPayload } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPluginArchive } from '../src/main/plugin-archive.ts'

const [challengeId, code, handle = 'kyleslight'] = process.argv.slice(2)
if (!challengeId || !code) {
  console.error('usage: bind-publisher.mjs <challengeId> <code> [handle]')
  process.exit(2)
}

const registry = process.env.SHUN_REGISTRY_URL || 'https://api.shunagent.com'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
const base64url = (buffer) => Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const verified = await fetch(`${registry}/v1/publishers/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ challengeId, code, devicePublicKey: base64url(rawPublic), handle }),
})
const identity = await verified.json()
if (!verified.ok) {
  console.error(`verify failed (HTTP ${verified.status}): ${identity.message || identity.error}`)
  process.exit(1)
}
console.log(`verified: ${identity.handle} · ${identity.domain} · device ${identity.deviceId}`)

// A throwaway package: it must reach review, which is what a community
// submission is allowed to do, and nothing else.
const root = await mkdtemp(join(tmpdir(), 'shun-bind-probe-'))
await mkdir(join(root, 'ui'), { recursive: true })
const manifest = {
  schemaVersion: 1,
  id: `binding-probe-${randomUUID().slice(0, 6)}`,
  name: 'Binding Probe',
  description: 'A throwaway package used to prove the publisher binding path reaches review.',
  version: '0.0.1',
  publisher: identity.handle,
  icon: 'plugin',
  runtime: { workspace: 'none' },
  permissions: [],
  contributes: { views: [{ id: 'probe.main', title: 'Probe', location: 'workspace.right', entry: 'ui/index.html' }] },
}
await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
await writeFile(join(root, 'ui', 'index.html'), '<!doctype html><meta charset="utf-8">')
const archive = await createPluginArchive(root)

const boundary = `----shun-${randomUUID()}`
const encoder = new TextEncoder()
const parts = [
  encoder.encode(`--${boundary}\r\ncontent-disposition: form-data; name="changelog"\r\n\r\nProves the signed publish path reaches review.\r\n`),
  encoder.encode(`--${boundary}\r\ncontent-disposition: form-data; name="archive"; filename="${manifest.id}.shunplugin"\r\ncontent-type: application/octet-stream\r\n\r\n`),
  archive.bytes,
  encoder.encode(`\r\n--${boundary}--\r\n`),
]
const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
const body = new Uint8Array(total)
let offset = 0
for (const part of parts) { body.set(part, offset); offset += part.byteLength }

const timestamp = Date.now()
const digest = createHash('sha256').update(body).digest('hex')
const signature = signPayload(null, Buffer.from(`POST\n/v1/publish\n${timestamp}\n${digest}`), privateKey)
const published = await fetch(`${registry}/v1/publish`, {
  method: 'POST',
  headers: {
    authorization: `Shun-Publisher handle=${identity.handle}, device=${identity.deviceId}, timestamp=${timestamp}, signature=${base64url(signature)}`,
    'content-type': `multipart/form-data; boundary=${boundary}`,
  },
  body,
})
const outcome = await published.json()
console.log(`publish (HTTP ${published.status}):`, JSON.stringify(outcome))

const listed = await fetch(`${registry}/v1/plugins?q=${manifest.id}`)
const search = await listed.json()
console.log(`visible in the store before review: ${search.results.length > 0} (must be false)`)
await rm(root, { recursive: true, force: true })
