import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { REMOTE_DOWNLOAD_MAX_BYTES, remoteDownloadName, saveRemoteFile } from './remote-download.ts'

test('a download writes every chunk the other Shun sends', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-download-'))
  const destination = join(directory, 'report.txt')
  const payload = 'hello remote file'
  const requests: string[] = []
  try {
    const result = await saveRemoteFile({
      taskId: 'task_1',
      path: '/tmp/work/report.txt',
      destination,
      request: async (kind, requestPayload) => {
        requests.push(kind)
        if (kind === 'file.download.info') return { path: '/tmp/work/report.txt', name: 'report.txt', size: payload.length, mimeType: 'text/plain', chunkSize: 8 }
        const offset = Number(requestPayload.offset)
        const chunk = payload.slice(offset, offset + 8)
        return { offset, data: Buffer.from(chunk).toString('base64'), bytes: chunk.length, eof: offset + chunk.length >= payload.length }
      },
    })
    assert.equal(result.bytes, payload.length)
    assert.equal(result.name, 'report.txt')
    assert.equal(await readFile(destination, 'utf8'), payload)
    assert.deepEqual(requests, ['file.download.info', 'file.download.chunk', 'file.download.chunk', 'file.download.chunk'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a download reports progress over the whole file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-download-'))
  const destination = join(directory, 'progress.bin')
  const progress: Array<[number, number]> = []
  try {
    await saveRemoteFile({
      taskId: 'task_1',
      path: '/tmp/work/progress.bin',
      destination,
      onProgress: (bytes, total) => progress.push([bytes, total]),
      request: async (kind, requestPayload) => {
        if (kind === 'file.download.info') return { path: '/tmp/work/progress.bin', name: 'progress.bin', size: 4, mimeType: 'application/octet-stream', chunkSize: 2 }
        const offset = Number(requestPayload.offset)
        const chunk = 'abcd'.slice(offset, offset + 2)
        return { offset, data: Buffer.from(chunk).toString('base64'), bytes: chunk.length, eof: offset + chunk.length >= 4 }
      },
    })
    assert.deepEqual(progress, [[2, 4], [4, 4]])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a download that stops early removes what it wrote instead of leaving a partial file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-download-'))
  const destination = join(directory, 'half.bin')
  try {
    await assert.rejects(saveRemoteFile({
      taskId: 'task_1',
      path: '/tmp/work/half.bin',
      destination,
      request: async (kind) => kind === 'file.download.info'
        ? { path: '/tmp/work/half.bin', name: 'half.bin', size: 100, mimeType: 'application/octet-stream', chunkSize: 8 }
        : { offset: 0, data: Buffer.from('12345678').toString('base64'), bytes: 8, eof: false },
    }), /stopped before the whole file arrived/)
    await assert.rejects(readFile(destination, 'utf8'), /ENOENT/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a download refuses a file beyond the limit, and reports a truncated chunk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-download-'))
  const destination = join(directory, 'big.bin')
  try {
    await assert.rejects(saveRemoteFile({
      taskId: 'task_1',
      path: '/tmp/work/big.bin',
      destination,
      request: async () => ({ path: '/tmp/work/big.bin', name: 'big.bin', size: REMOTE_DOWNLOAD_MAX_BYTES + 1, mimeType: 'application/octet-stream', chunkSize: 8 }),
    }), /larger than the 128 MB remote download limit/)
    await assert.rejects(readFile(destination, 'utf8'), /ENOENT/)

    await assert.rejects(saveRemoteFile({
      taskId: 'task_1',
      path: '/tmp/work/torn.bin',
      destination,
      request: async (kind) => kind === 'file.download.info'
        ? { path: '/tmp/work/torn.bin', name: 'torn.bin', size: 8, mimeType: 'application/octet-stream', chunkSize: 8 }
        : { offset: 0, data: Buffer.from('1234').toString('base64'), bytes: 8, eof: true },
    }), /truncated chunk/)
    await assert.rejects(readFile(destination, 'utf8'), /ENOENT/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a download raises the error the peer gave instead of an empty file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-download-'))
  const destination = join(directory, 'passwd')
  try {
    await assert.rejects(saveRemoteFile({
      taskId: 'task_1',
      path: '/etc/passwd',
      destination,
      request: async () => { throw Error('This file is not part of the task conversation or workspace.') },
    }), /not part of the task conversation or workspace/)
    await assert.rejects(readFile(destination, 'utf8'), /ENOENT/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a download name falls back to the file it came from', () => {
  assert.equal(remoteDownloadName({ path: '/tmp/work/report.txt' }), 'report.txt')
  assert.equal(remoteDownloadName({ path: '/tmp/work/other.txt', name: 'report.txt' }), 'report.txt')
})

test('an empty remote file still produces its destination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-download-'))
  const destination = join(directory, 'empty.txt')
  await writeFile(destination, 'stale')
  try {
    const result = await saveRemoteFile({
      taskId: 'task_1',
      path: '/tmp/work/empty.txt',
      destination,
      request: async () => ({ path: '/tmp/work/empty.txt', name: 'empty.txt', size: 0, mimeType: 'text/plain', chunkSize: 8 }),
    })
    assert.equal(result.bytes, 0)
    assert.equal(await readFile(destination, 'utf8'), '')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
