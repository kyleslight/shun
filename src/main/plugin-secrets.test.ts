import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
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

test('parallel connector updates and removals preserve every unrelated credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-concurrent-secrets-')), file = join(root, 'secrets.json')
  const store = new EncryptedFilePluginSecretStore(file, value => Buffer.from(value), value => value.toString())
  await store.set('old', 'old-value')
  await Promise.all([
    ...Array.from({ length: 30 }, (_, i) => store.set(`connector-${i}`, `credential-${i}`)),
    store.delete('old'),
  ])
  for (let i = 0; i < 30; i++) assert.equal(await store.get(`connector-${i}`), `credential-${i}`)
  assert.equal(await store.get('old'), undefined)
  const reopened = new EncryptedFilePluginSecretStore(file, value => Buffer.from(value), value => value.toString())
  assert.equal(await reopened.get('connector-29'), 'credential-29')
})

test('a failed credential write does not prevent a later connector update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-failed-secrets-')), file = join(root, 'secrets.json')
  let fail = true
  const store = new EncryptedFilePluginSecretStore(file, value => {
    if (fail) { fail = false; throw Error('encryption unavailable') }
    return Buffer.from(value)
  }, value => value.toString())
  await assert.rejects(store.set('first', 'value'), /encryption unavailable/)
  await store.set('second', 'saved')
  assert.equal(await store.get('second'), 'saved')
})

test('unreadable saved connection data is never replaced by an empty account store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-preserve-secrets-')), file = join(root, 'secrets.json')
  const original = '{"saved-account": "incomplete'
  await writeFile(file, original)
  const store = new EncryptedFilePluginSecretStore(file, value => Buffer.from(value), value => value.toString())
  await assert.rejects(store.set('new-account', 'value'), /preserved/)
  assert.equal(await readFile(file, 'utf8'), original)
})
