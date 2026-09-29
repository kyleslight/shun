import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fetchRemoteAttachment, remoteAttachmentInfo, saveRemoteAttachment } from './remote-attachment.ts'
import { AttachmentStore } from './attachments.ts'

/** A peer that serves one attachment's bytes in pieces, the way the other Shun does. */
function serving(payload: Buffer, name = 'shot.png', mimeType = 'image/png', chunkSize = 4) {
  const requests: string[] = []
  return {
    requests,
    request: async (kind: string, requestPayload: Record<string, unknown>) => {
      requests.push(kind)
      if (kind === 'attachment.download.info') return { attachmentId: 'a1', name, mimeType, size: payload.length, chunkSize }
      const offset = Number(requestPayload.offset)
      const piece = payload.subarray(offset, offset + Math.min(chunkSize, payload.length - offset))
      return { offset, data: piece.toString('base64'), bytes: piece.length, eof: offset + piece.length >= payload.length }
    },
  }
}

test('the two things done with a picture bring the file itself, not the fitted copy', async () => {
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6])
  const peer = serving(payload)

  // A copy is the attachment held in memory, byte for byte: what is looked at is
  // fitted to the link, and what someone copies is the file the task owns.
  const fetched = await fetchRemoteAttachment({ taskId: 'task_1', attachmentId: 'a1', request: peer.request })
  assert.deepEqual(fetched.bytes, payload)
  assert.equal(fetched.info.name, 'shot.png')
  assert.equal(fetched.info.mimeType, 'image/png')
  assert.deepEqual(peer.requests, ['attachment.download.info', 'attachment.download.chunk', 'attachment.download.chunk', 'attachment.download.chunk'])
})

test('a save writes every piece the other Shun sent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-attachment-'))
  const destination = join(directory, 'shot.png')
  const payload = Buffer.from('a picture, in pieces')
  try {
    const result = await saveRemoteAttachment({ taskId: 'task_1', attachmentId: 'a1', destination, request: serving(payload).request })
    assert.equal(result.bytes, payload.length)
    assert.equal(result.name, 'shot.png')
    assert.equal(result.destination, destination)
    assert.deepEqual(await readFile(destination), payload)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a download that stops halfway removes what it wrote instead of leaving a partial picture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-attachment-'))
  const destination = join(directory, 'shot.png')
  const payload = Buffer.from('a picture that never finishes arriving')
  try {
    await assert.rejects(saveRemoteAttachment({
      taskId: 'task_1',
      attachmentId: 'a1',
      destination,
      request: async (kind, requestPayload) => {
        if (kind === 'attachment.download.info') return { attachmentId: 'a1', name: 'shot.png', mimeType: 'image/png', size: payload.length, chunkSize: 4 }
        const offset = Number(requestPayload.offset)
        // The peer stops answering before the whole file is across.
        if (offset >= 8) return { offset, data: '', bytes: 0, eof: true }
        const piece = payload.subarray(offset, offset + 4)
        return { offset, data: piece.toString('base64'), bytes: piece.length, eof: false }
      },
    }), /stopped arriving/)
    await assert.rejects(readFile(destination), 'the partial file is not left looking whole')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an attachment larger than the store allows is refused before it is fetched', async () => {
  await assert.rejects(fetchRemoteAttachment({
    taskId: 'task_1',
    attachmentId: 'a1',
    request: async (kind) => kind === 'attachment.download.info'
      ? { attachmentId: 'a1', name: 'huge.png', mimeType: 'image/png', size: 65 * 1024 * 1024, chunkSize: 4 }
      : { offset: 0, data: '', bytes: 0, eof: true },
  }), /64 MB/)
})

test('the peer describes an attachment from its metadata and serves one byte range at a time', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-attachment-store-'))
  const store = new AttachmentStore(directory)
  try {
    const source = join(directory, 'source.png')
    await writeFile(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6, 5, 4]))
    const [attached] = await store.importPaths('task_1', [source])

    const info = remoteAttachmentInfo(await store.describe('task_1', attached.id))
    assert.equal(info.attachmentId, attached.id)
    assert.equal(info.name, 'source.png')
    assert.equal(info.size, 10)

    const first = await store.readChunk('task_1', attached.id, 0, 4)
    assert.deepEqual(first.bytes, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    assert.equal(first.eof, false)
    const rest = await store.readChunk('task_1', attached.id, 8, 4)
    assert.deepEqual(rest.bytes, Buffer.from([5, 4]))
    assert.equal(rest.eof, true)
    // An attachment belongs to the task that owns it, and to no other.
    await assert.rejects(store.readChunk('task_2', attached.id, 0, 4), /no longer available/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
