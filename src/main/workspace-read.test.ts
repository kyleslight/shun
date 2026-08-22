import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createWorkspaceReadTool, readWorkspaceFile, workspaceFilePath } from './workspace-read.ts'

function text(result: Awaited<ReturnType<typeof readWorkspaceFile>>) {
  const block = result.content[0]
  assert.equal(block.type, 'text')
  return block.text
}

test('workspace read keeps line ranges bounded and resumable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-workspace-read-'))
  try {
    const path = join(root, 'large.log')
    await writeFile(path, Array.from({ length: 5_000 }, (_, index) => `event ${index + 1}`).join('\n'))
    const result = await readWorkspaceFile(root, 'large.log', { offset: 4_999, limit: 1 })
    assert.match(text(result), /^event 4999/)
    assert.match(text(result), /offset=5000/)
    assert.equal(result.details.streaming, true)
    assert.equal(result.details.next_offset, 5_000)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('workspace search scans text beyond the captured line prefix without returning the whole line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-workspace-search-'))
  try {
    const prefix = 'x'.repeat(3 * 1024 * 1024), path = join(root, 'single-line.log')
    await writeFile(path, `${prefix}FIND_ME${'y'.repeat(1024 * 1024)}`)
    const result = await readWorkspaceFile(root, 'single-line.log', { mode: 'search', query: 'FIND_ME' })
    assert.equal(result.details.matching_lines, 1)
    assert.equal(result.details.lines_scanned, 1)
    assert.ok(Buffer.byteLength(text(result)) <= 52 * 1024)
    assert.match(text(result), /line preview truncated/)
    const overview = await readWorkspaceFile(root, 'single-line.log', { mode: 'overview' })
    assert.ok(Buffer.byteLength(text(overview)) <= 52 * 1024)
    const content = await readWorkspaceFile(root, 'single-line.log')
    assert.equal(content.details.byte_offset, 0)
    assert.equal(content.details.next_byte_offset, 50 * 1024)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('workspace search treats zero matches as a successful empty result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-workspace-empty-search-'))
  try {
    await writeFile(join(root, 'events.log'), 'alpha\nbeta\ngamma\n')
    const result = await readWorkspaceFile(root, 'events.log', { mode: 'search', query: 'delta' })
    assert.equal(result.details.matching_lines, 0)
    assert.match(text(result), /No matching lines/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('workspace overview and tail sample boundaries instead of reading all content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-workspace-overview-'))
  try {
    await writeFile(join(root, 'events.log'), Array.from({ length: 2_000 }, (_, index) => `line-${index + 1}`).join('\n'))
    const overview = await readWorkspaceFile(root, 'events.log', { mode: 'overview' })
    assert.match(text(overview), /--- head ---[\s\S]*line-1/)
    assert.match(text(overview), /--- tail ---[\s\S]*line-2000/)
    assert.doesNotMatch(text(overview), /line-1000/)
    const tail = await readWorkspaceFile(root, 'events.log', { mode: 'tail', limit: 2 })
    assert.equal(text(tail), 'line-1999\nline-2000')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('local read rejects binary content but permits user-accessible paths outside the task cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-workspace-scope-')), outside = join(tmpdir(), `shun-outside-${Date.now()}.txt`)
  try {
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    await writeFile(outside, 'outside')
    await assert.rejects(readWorkspaceFile(root, 'binary.bin'), /binary|unsupported text encoding/i)
    const canonicalOutside = await realpath(outside)
    assert.equal((await workspaceFilePath(root, outside)).target, canonicalOutside)
    assert.equal((await workspaceFilePath(root, outside)).relativePath, canonicalOutside)
    if (process.platform !== 'win32') {
      await symlink(outside, join(root, 'escape-link'))
      assert.equal((await workspaceFilePath(root, 'escape-link')).target, canonicalOutside)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { force: true })
  }
})

test('bounded local read keeps the canonical runtime identity and accepts absolute paths', () => {
  const tool = createWorkspaceReadTool('/workspace')
  assert.equal(tool.name, 'read')
  assert.match(tool.description, /multi-gigabyte|streaming/i)
  assert.match(tool.description, /absolute paths/i)
})
