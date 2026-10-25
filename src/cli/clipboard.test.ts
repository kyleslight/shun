import assert from 'node:assert/strict'
import test from 'node:test'
import { clipboardImage } from './clipboard.ts'

test('clipboard paste imports image bytes only on demand, and empty clipboard reports an actionable result', async () => {
  let reads = 0
  const oldConnection = process.env.SSH_CONNECTION, oldTty = process.env.SSH_TTY
  delete process.env.SSH_CONNECTION; delete process.env.SSH_TTY
  try {
    const bytes = await clipboardImage(() => ({ hasImage: () => true, getImageBinary: async () => { reads++; return [137, 80, 78, 71] } }))
    assert.equal(reads, 1)
    assert.deepEqual([...bytes], [137, 80, 78, 71])
    await assert.rejects(clipboardImage(() => ({ hasImage: () => false, getImageBinary: async () => { throw Error('must not read') } })), /No image/)
    process.env.SSH_CONNECTION = 'fixture'
    await assert.rejects(clipboardImage(() => { throw Error('must not load') }), /remote terminal/)
  } finally {
    if (oldConnection === undefined) delete process.env.SSH_CONNECTION; else process.env.SSH_CONNECTION = oldConnection
    if (oldTty === undefined) delete process.env.SSH_TTY; else process.env.SSH_TTY = oldTty
  }
})
