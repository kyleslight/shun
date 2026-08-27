import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { describeRemoteFile, readRemoteFileChunk, REMOTE_FILE_CHUNK_BYTES } from './remote-files.ts'

test('remote files are described and read in bounded base64 chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-remote-file-'))
  try {
    const path = join(root, 'report.pdf')
    const bytes = Buffer.alloc(REMOTE_FILE_CHUNK_BYTES + 17, 7)
    await writeFile(path, bytes)
    const info = await describeRemoteFile(path)
    assert.deepEqual(info, {
      path,
      name: 'report.pdf',
      size: bytes.length,
      mimeType: 'application/pdf',
      chunkSize: REMOTE_FILE_CHUNK_BYTES,
    })
    const first = await readRemoteFileChunk(path, 0)
    const second = await readRemoteFileChunk(path, first.bytes)
    assert.equal(first.bytes, REMOTE_FILE_CHUNK_BYTES)
    assert.equal(first.eof, false)
    assert.equal(second.bytes, 17)
    assert.equal(second.eof, true)
    assert.deepEqual(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(second.data, 'base64')]), bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('remote file chunks reject directories and unbounded reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-remote-file-'))
  try {
    await assert.rejects(() => describeRemoteFile(root), /Only files/)
    const path = join(root, 'small.txt')
    await writeFile(path, 'hello')
    await assert.rejects(() => readRemoteFileChunk(path, -1), /offset/)
    await assert.rejects(() => readRemoteFileChunk(path, 0, REMOTE_FILE_CHUNK_BYTES + 1), /length/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
