import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { unzipSync, strFromU8 } from 'fflate'
import { archiveDirectory } from './remote-directory-archive.ts'
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

test('remote file chunks reject unbounded reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-remote-file-'))
  try {
    const path = join(root, 'small.txt')
    await writeFile(path, 'hello')
    await assert.rejects(() => readRemoteFileChunk(path, -1), /offset/)
    await assert.rejects(() => readRemoteFileChunk(path, 0, REMOTE_FILE_CHUNK_BYTES + 1), /length/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('folders download as stable ZIP files with nested and empty folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-source-'))
  try {
    const folder = join(root, 'project')
    await mkdir(join(folder, 'empty'), { recursive: true })
    await writeFile(join(folder, 'index.html'), '<h1>Hello</h1>')
    await symlink('index.html', join(folder, 'index-link'))
    const info = await describeRemoteFile(folder)
    assert.equal(info.sourcePath, folder)
    assert.equal(info.name, 'project.zip')
    assert.equal(info.mimeType, 'application/zip')
    assert.equal((await describeRemoteFile(info.path)).sourcePath, folder)
    const chunk = await readRemoteFileChunk(info.path, 0)
    const archive = unzipSync(Buffer.from(chunk.data, 'base64'))
    assert.equal(strFromU8(archive['project/index.html']), '<h1>Hello</h1>')
    assert.equal(strFromU8(archive['project/index-link']), 'index.html')
    assert.ok(archive['project/empty/'])
    assert.deepEqual(Buffer.from(chunk.data, 'base64'), await readFile(info.path))
    await rm(info.path)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an oversized folder fails without changing the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-archive-limit-'))
  try {
    const file = join(root, 'large.bin')
    await writeFile(file, Buffer.alloc(2048, 1))
    await assert.rejects(archiveDirectory(root, 1024), /limit/)
    assert.equal((await readFile(file)).length, 2048)
  } finally { await rm(root, { recursive: true, force: true }) }
})
