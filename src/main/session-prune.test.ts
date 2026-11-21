import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pruneSessionFile, restoreArchivedEntries } from './session-prune.ts'

const header = () => ({ type: 'session', version: 3, id: 'task', timestamp: new Date().toISOString(), cwd: '/' })
const message = (id: string, parentId: string | null, text: string) => ({ type: 'message', id, parentId, timestamp: 0, message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 } })

async function session(entries: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'shun-session-prune-'))
  const path = join(root, 'session.jsonl')
  await writeFile(path, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`)
  return { root, path }
}

async function ids(path: string) {
  return (await readFile(path, 'utf8')).trim().split('\n').map(line => {
    const entry = JSON.parse(line)
    return entry.type === 'session' ? 'header' : entry.id
  })
}

test('a session with no compaction is left alone', async () => {
  const { root, path } = await session([header(), message('a', null, 'one'), message('b', 'a', 'two')])
  try {
    assert.equal(await pruneSessionFile(path), false)
    assert.deepEqual(await ids(path), ['header', 'a', 'b'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('summarized entries go and the compaction window stays', async () => {
  const entries: unknown[] = [header()]
  let parent: string | null = null
  for (let index = 0; index < 40; index++) {
    const id = `m${index}`
    entries.push(message(id, parent, 'x'.repeat(1000)))
    parent = id
  }
  entries.push({ type: 'compaction', id: 'c1', parentId: parent, timestamp: 0, summary: 'notes', firstKeptEntryId: 'm35', tokensBefore: 1 })
  entries.push(message('after', 'c1', 'next'))
  const { root, path } = await session(entries)
  try {
    assert.equal(await pruneSessionFile(path, 3000), true)
    const kept = await ids(path)
    assert.equal(kept[0], 'header')
    assert.ok(kept.includes('c1'))
    assert.ok(kept.includes('m35'))
    assert.ok(kept.includes('after'))
    assert.equal(kept.includes('m0'), false)
    // The retained window is bounded by bytes, not by a count.
    assert.ok(kept.length < 40)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('pruning twice is a no-op once the file is inside its budget', async () => {
  const entries: unknown[] = [header()]
  let parent: string | null = null
  for (let index = 0; index < 20; index++) {
    const id = `m${index}`
    entries.push(message(id, parent, 'x'.repeat(1000)))
    parent = id
  }
  entries.push({ type: 'compaction', id: 'c1', parentId: parent, timestamp: 0, summary: 'notes', firstKeptEntryId: 'm15', tokensBefore: 1 })
  const { root, path } = await session(entries)
  try {
    assert.equal(await pruneSessionFile(path, 3000), true)
    const once = await ids(path)
    assert.equal(await pruneSessionFile(path, 3000), false)
    assert.deepEqual(await ids(path), once)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an edit that reaches before the window gets the summarized past back', async () => {
  const entries: unknown[] = [header()]
  let parent: string | null = null
  for (let index = 0; index < 30; index++) {
    const id = `m${index}`
    entries.push(message(id, parent, 'x'.repeat(1000)))
    parent = id
  }
  entries.push({ type: 'compaction', id: 'c1', parentId: parent, timestamp: 0, summary: 'notes', firstKeptEntryId: 'm25', tokensBefore: 1 })
  const { root, path } = await session(entries)
  try {
    assert.equal(await pruneSessionFile(path, 3000), true)
    assert.equal((await ids(path)).includes('m0'), false)
    assert.equal(await restoreArchivedEntries(path), true)
    const restored = await ids(path)
    assert.deepEqual(restored, ['header', ...Array.from({ length: 30 }, (_, index) => `m${index}`), 'c1'])
    assert.equal(await restoreArchivedEntries(path), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a branch that starts before the compaction is left alone', async () => {
  const entries: unknown[] = [header()]
  let parent: string | null = null
  for (let index = 0; index < 30; index++) {
    const id = `m${index}`
    entries.push(message(id, parent, 'x'.repeat(1000)))
    parent = id
  }
  entries.push({ type: 'compaction', id: 'c1', parentId: parent, timestamp: 0, summary: 'notes', firstKeptEntryId: 'm25', tokensBefore: 1 })
  entries.push(message('after', 'c1', 'next'))
  // An edit branched from m10, so the leaf no longer descends from c1.
  entries.push(message('edited', 'm10', 'rewritten'))
  const { root, path } = await session(entries)
  try {
    assert.equal(await pruneSessionFile(path, 3000), false)
    assert.equal((await ids(path)).includes('m10'), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
