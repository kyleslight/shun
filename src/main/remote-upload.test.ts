import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { REMOTE_UPLOAD_LIMIT, uploadRemoteFile, uploadRemoteFileData, uploadRemoteFiles } from './remote-upload.ts'

/** A peer that accepts a whole upload and answers with the attachment it stored. */
function acceptingPeer(seen: Array<{ kind: string; payload: Record<string, unknown> }>) {
  return async (kind: string, payload: Record<string, unknown>) => {
    seen.push({ kind, payload })
    if (kind === 'attachment.upload.begin') return { uploadId: 'upload-1', chunkSize: 8 }
    if (kind === 'attachment.upload.chunk') return { received: Number(payload.index) + 1 }
    if (kind === 'attachment.upload.complete') return { id: 'attachment-1', name: String(payload.name || 'file.bin'), kind: 'image', size: 4 }
    return {}
  }
}

const tempDirectories = async () => (await readdir(tmpdir())).filter(name => name.startsWith('shun-remote-attach-'))

test('a file that only exists in memory is uploaded while its temporary file is still readable', async () => {
  const before = await tempDirectories()
  const seen: Array<{ kind: string; payload: Record<string, unknown> }> = []
  // The peer is slow to accept the upload. Cleaning up around the upload instead
  // of after it deleted the bytes the upload was about to read, and every pasted
  // image came back as "ENOENT … /T/shun-remote-attach-…/image.png".
  const request = async (kind: string, payload: Record<string, unknown>) => {
    if (kind === 'attachment.upload.begin') await new Promise(resolve => setTimeout(resolve, 25))
    return acceptingPeer(seen)(kind, payload)
  }

  const uploaded = await uploadRemoteFileData({
    request,
    taskId: 'task_1',
    files: [{ name: 'image.png', data: new TextEncoder().encode('png!').buffer }],
  })

  assert.equal(uploaded.length, 1)
  assert.equal(uploaded[0].id, 'attachment-1')
  // The peer was told the person's name, not the temporary one.
  assert.equal(seen[0].payload.name, 'image.png')
  assert.equal(seen[0].payload.size, 4)
  assert.equal(Buffer.from(String(seen[1].payload.data), 'base64url').toString('utf8'), 'png!')
  // And the private folder it travelled from is gone again.
  assert.deepEqual(await tempDirectories(), before)
})

test('a pasted batch keeps every name, and none of them can leave the private folder', async () => {
  const names: string[] = []
  const uploaded = await uploadRemoteFileData({
    request: async (kind, payload) => {
      if (kind === 'attachment.upload.begin') names.push(String(payload.name))
      return acceptingPeer([])(kind, payload)
    },
    taskId: 'task_1',
    files: [
      { name: '../../escape.png', data: new TextEncoder().encode('one').buffer },
      { name: 'shot.png', data: new TextEncoder().encode('two').buffer },
      { name: 'shot.png', data: new TextEncoder().encode('three').buffer },
      { name: 'empty.png', data: Buffer.alloc(0) },
    ],
  })

  assert.equal(uploaded.length, 3)
  assert.deepEqual(names, ['-..-escape.png', 'shot.png', 'shot-2.png'])
})

test('a file on disk travels from its own path, and the batch stops at the limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-upload-'))
  try {
    const paths: string[] = []
    for (let index = 0; index < REMOTE_UPLOAD_LIMIT + 2; index += 1) {
      const path = join(directory, `file-${index}.txt`)
      await writeFile(path, `body ${index}`)
      paths.push(path)
    }
    const begun: string[] = []
    const uploaded = await uploadRemoteFiles({
      request: async (kind, payload) => {
        if (kind === 'attachment.upload.begin') begun.push(String(payload.name))
        return acceptingPeer([])(kind, payload)
      },
      taskId: 'task_1',
      paths,
    })

    assert.equal(uploaded.length, REMOTE_UPLOAD_LIMIT)
    assert.equal(begun.length, REMOTE_UPLOAD_LIMIT)
    assert.equal(begun[0], 'file-0.txt')
    // The bytes came from the file the person chose, read where it lives.
    assert.equal(await readFile(paths[0], 'utf8'), 'body 0')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a file the peer refuses is reported instead of becoming a partial attachment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-upload-'))
  try {
    const path = join(directory, 'big.bin')
    await writeFile(path, Buffer.alloc(32))
    await assert.rejects(
      uploadRemoteFile({
        request: async (kind, payload) => {
          if (kind === 'attachment.upload.begin') return { uploadId: 'upload-1', chunkSize: 8 }
          if (kind === 'attachment.upload.complete') return {}
          const aborted: string[] = []
          void aborted.push(String(payload.uploadId))
          return { received: 0 }
        },
        taskId: 'task_1',
        path,
      }),
      /did not finish the upload/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
