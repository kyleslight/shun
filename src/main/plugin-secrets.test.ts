import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EncryptedFilePluginSecretStore } from './plugin-secrets.ts'

test('plugin secrets are encrypted before atomic persistence and removable independently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-secrets-')), file = join(root, 'secrets.json')
  const store = new EncryptedFilePluginSecretStore(file, value => Buffer.from([...Buffer.from(value)].map(byte => byte ^ 0x5a)), value => Buffer.from([...value].map(byte => byte ^ 0x5a)).toString())
  await store.set('figma', 'figd_private')
  assert.equal(await store.get('figma'), 'figd_private')
  assert.doesNotMatch(await readFile(file, 'utf8'), /figd_private/)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  await store.delete('figma')
  assert.equal(await store.get('figma'), undefined)
})
