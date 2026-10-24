import assert from 'node:assert/strict'
import test from 'node:test'
import { extensionPublicationReceipt, verifyExtensionPublication } from './extension-publication.mjs'

const revision = (state, version) => ({ state, distributionChannels: [{ crxVersion: version, deployPercentage: 100 }] })

test('an accepted request with warnings and an older published package proves no new submission', () => {
  assert.equal(extensionPublicationReceipt({ warningInfo: { warnings: [{ reason: 'BROAD_HOST_USAGE' }] } }, '1.2.1'), undefined)
  assert.equal(extensionPublicationReceipt({ publishedItemRevisionStatus: revision('PUBLISHED', '1.2.0') }, '1.2.1'), undefined)
})

test('only the exact requested public or submitted version supplies a receipt', () => {
  for (const state of ['PENDING_REVIEW', 'STAGED']) {
    assert.deepEqual(extensionPublicationReceipt({ submittedItemRevisionStatus: revision(state, '1.2.1') }, '1.2.1'), { state, version: '1.2.1' })
  }
  assert.deepEqual(extensionPublicationReceipt({ publishedItemRevisionStatus: revision('PUBLISHED', '1.2.1') }, '1.2.1'), { state: 'PUBLISHED', version: '1.2.1' })
  assert.equal(extensionPublicationReceipt({ submittedItemRevisionStatus: revision('PENDING_REVIEW', '1.2.0') }, '1.2.1'), undefined)
  assert.equal(extensionPublicationReceipt({ publishedItemRevisionStatus: revision('PUBLISHED_TO_TESTERS', '1.2.1') }, '1.2.1'), undefined)
})

test('settling observes a delayed submission without replaying the publishing action', async () => {
  let reads = 0, waits = 0
  const receipt = await verifyExtensionPublication(async () => ++reads === 1 ? {} : { submittedItemRevisionStatus: revision('PENDING_REVIEW', '1.2.1') }, '1.2.1', { wait: async () => { waits++ } })
  assert.equal(receipt.state, 'PENDING_REVIEW')
  assert.equal(reads, 2)
  assert.equal(waits, 1)
})

test('an unconfirmed submission fails after bounded observations rather than reporting success', async () => {
  let reads = 0
  await assert.rejects(verifyExtensionPublication(async () => { reads++; return {} }, '1.2.1', { attempts: 3, wait: async () => {} }), /not confirmed submission/)
  assert.equal(reads, 3)
})

test('rejected or cancelled exact-version submissions fail without waiting again', async () => {
  for (const state of ['REJECTED', 'CANCELLED']) {
    await assert.rejects(verifyExtensionPublication(async () => ({ submittedItemRevisionStatus: revision(state, '1.2.1') }), '1.2.1', { wait: async () => assert.fail('no additional wait') }), new RegExp(state))
  }
})

test('a failed status read is never treated as absence or permission to upload', async () => {
  await assert.rejects(verifyExtensionPublication(async () => { throw Error('unavailable') }, '1.2.1'), /unavailable/)
})
