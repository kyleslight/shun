import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'

const root = new URL('../', import.meta.url)

test('the cached Linux x64 Terminal runtime is versioned, verified, and packaged without cross-rebuilding', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const manifest = JSON.parse(await readFile(new URL('scripts/native/node-pty/manifest.json', root), 'utf8'))
  const runtime = manifest.runtimes['linux-x64']
  const encoded = await readFile(new URL(`scripts/native/node-pty/${runtime.payload}`, root), 'utf8')
  const binary = gunzipSync(Buffer.from(encoded.replace(/\s+/g, ''), 'base64'))

  assert.equal(packageJson.dependencies['node-pty'], manifest.packageVersion)
  assert.equal(packageJson.build.npmRebuild, false)
  assert.equal(createHash('sha256').update(binary).digest('hex'), runtime.sha256)
  assert.equal(binary.subarray(0, 4).toString('hex'), '7f454c46')
  assert.equal(binary[4], 2, 'runtime must be a 64-bit ELF binary')
  assert.equal(binary[18], 0x3e, 'runtime must target x86-64')
})
