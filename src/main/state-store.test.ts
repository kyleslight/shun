import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SavedState, Settings, Task } from '../shared.ts'
import { isStateSaveDelta, SavedStateStore } from './state-store.ts'

const settings = { language: 'zh-CN', providers: [], providerId: '', model: '', contextWindow: 8_000, maxTokens: 1_000, workspace: '', theme: 'dark', accent: 'blue', autoCompact: true } as unknown as Settings

function task(id: string, content: string, tools = 0): Task {
  return {
    id,
    title: id,
    workspace: '/tmp/project',
    createdAt: 1,
    updatedAt: 2,
    turns: [{
      id: `${id}-turn`,
      role: 'assistant',
      content,
      timeline: [
        ...Array.from({ length: tools }, (_, index) => ({ type: 'tool' as const, tool: { id: `${index}`, name: 'read', input: '{}', output: 'x', state: 'done' as const } })),
        { type: 'text' as const, text: content },
      ],
    }],
  }
}

const state = (tasks: Task[], currentId = tasks[0]?.id || ''): SavedState => ({ settings, currentId, tasks })

async function openStore(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const file = join(root, 'state.json')
  return { root, file, store: new SavedStateStore(file, value => ({ ...value, autoCompact: true })) }
}

test('what changed is enough to keep the store exactly as the window describes it', async () => {
  const { file, store } = await openStore('shun-state-delta-')
  const first = task('a', 'one', 2), second = task('b', 'two')
  await store.save(state([first, second]))

  // One conversation moves, and one arrives: what is applied has to leave the same
  // store behind as describing all of it again would have.
  const moved = task('a', 'one two', 3), arrived = task('c', 'three')
  const described = state([moved, second, arrived], 'c')
  const outcome = await store.applyDelta({
    kind: 'delta',
    order: described.tasks.map(item => item.id),
    tasks: [moved, arrived],
    currentId: described.currentId,
  })
  assert.deepEqual(outcome, { ok: true })

  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(described)))

  // A task the window no longer lists is one the store no longer keeps: the description
  // carries identity and order, so a removal needs no separate word for itself.
  await store.applyDelta({ kind: 'delta', order: ['b'], tasks: [], currentId: 'b' })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).tasks.map((item: Task) => item.id), ['b'])
})

test('a store that never held a listed conversation asks for everything instead', async () => {
  const { file, store } = await openStore('shun-state-drift-')
  await store.save(state([task('a', 'one')]))
  // A conversation the window lists, does not carry, and the store has never held: the two
  // disagree about what exists, and only the window can say what that conversation is.
  const outcome = await store.applyDelta({
    kind: 'delta',
    order: ['a', 'never-seen'],
    tasks: [],
    currentId: 'a',
  })
  assert.deepEqual(outcome, { ok: false, needsFull: true })
  // Nothing was written: a store missing a conversation is worse than a stale one.
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).tasks.map((item: Task) => item.id), ['a'])
})

test('a store with nothing to change on disk is read once, and noticed when it is replaced', async () => {
  const { file, store } = await openStore('shun-state-read-')
  const written = state([task('a', 'one'), task('b', 'two')])
  await store.save(written)
  const first = await store.read()
  const again = await store.read()
  // The same conversation is the same object: a reader that asks twice — which the
  // window does for every conversation it opens — does not parse the store twice.
  assert.equal(first, again)

  // Another process replacing the file is what the timestamp and size are for.
  const replaced = state([task('c', 'three')])
  await writeFile(file, JSON.stringify(replaced))
  const reread = await store.read()
  assert.deepEqual(reread?.tasks.map(item => item.id), ['c'])
})

test('a change that is not the window\'s to make still lands in the store', async () => {
  const { file, store } = await openStore('shun-state-mutate-')
  await store.save(state([task('a', 'one')]))
  await store.mutate(current => {
    current.tasks[0].title = 'renamed'
  })
  assert.equal(JSON.parse(await readFile(file, 'utf8')).tasks[0].title, 'renamed')
  // The store the next reader sees is the one that was written.
  assert.equal((await store.read())?.tasks[0].title, 'renamed')
})

test('saves that arrive together are applied in the order they were made', async () => {
  const { file, store } = await openStore('shun-state-order-')
  await store.save(state([task('a', 'one'), task('b', 'two')]))
  const grown = task('a', 'one and more')
  await Promise.all([
    store.applyDelta({ kind: 'delta', order: ['a', 'b'], tasks: [grown], currentId: 'a' }),
    store.applyDelta({ kind: 'delta', order: ['a', 'b'], tasks: [task('b', 'two and more')], currentId: 'a' }),
  ])
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(onDisk.tasks.map((item: Task) => item.turns[0].content), ['one and more', 'two and more'])
})

test('a save that is not a delta is not read as one', () => {
  assert.equal(isStateSaveDelta(state([task('a', 'one')])), false)
  assert.equal(isStateSaveDelta({ kind: 'delta', order: ['a'], tasks: [], currentId: 'a' }), true)
  assert.equal(isStateSaveDelta({ kind: 'delta', order: 'a', tasks: [], currentId: 'a' }), false)
})

test('interactive snapshots do not wait behind queued history writes', async () => {
  const { store } = await openStore('shun-state-responsive-')
  await store.save(state([task('a', 'committed')]))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const internals = store as unknown as { write: (value: SavedState) => Promise<void> }
  const write = internals.write.bind(store)
  internals.write = async value => { await gate; await write(value) }
  const pending = store.applyDelta({ kind: 'delta', order: ['a'], tasks: [task('a', 'next')], currentId: 'a' })
  try {
    const snapshot = await Promise.race([store.snapshot(), new Promise<never>((_, reject) => setTimeout(() => reject(Error('snapshot waited for disk')), 1000))])
    assert.equal(snapshot?.tasks[0].turns[0].content, 'committed')
  } finally { release(); await pending }
  assert.equal((await store.snapshot())?.tasks[0].turns[0].content, 'next')
})

test('queued stream saves share one write and preserve mutations between batches', async () => {
  const { store } = await openStore('shun-state-batch-')
  await store.save(state([task('a', 'one'), task('b', 'two')]))
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const internals = store as unknown as { write: (value: SavedState) => Promise<void> }
  const write = internals.write.bind(store)
  let writes = 0
  internals.write = async value => { writes++; if (writes === 1) { entered(); await gate }; await write(value) }
  const delta = (id: string, content: string) => store.applyDelta({ kind: 'delta' as const, order: ['a', 'b'], tasks: [task(id, content)], currentId: 'a' })
  const first = delta('a', 'first'); await started
  const updates = Array.from({ length: 50 }, (_, i) => delta('a', `stream-${i}`))
  const mutation = store.mutate(value => { value.tasks[1].title = 'renamed' })
  const last = delta('a', 'last')
  release()
  await Promise.all([first, ...updates, mutation, last])
  assert.equal(writes, 4)
  const result = await store.read()
  assert.equal(result?.tasks[0].turns[0].content, 'last')
  assert.equal(result?.tasks[1].title, 'renamed')
})


test('concurrent readers share one parse when the history snapshot changes', async () => {
  const { file } = await openStore('shun-state-concurrent-read-')
  let normalizations = 0
  const store = new SavedStateStore(file, value => { normalizations++; return value })
  await writeFile(file, JSON.stringify(state([task('a', 'first')])))
  const first = await Promise.all(Array.from({ length: 30 }, () => store.snapshot()))
  assert.equal(normalizations, 1)
  assert.ok(first.every(value => value === first[0]))
  await writeFile(file, JSON.stringify(state([task('b', 'replacement snapshot')])))
  const next = await Promise.all(Array.from({ length: 30 }, () => store.snapshot()))
  assert.equal(normalizations, 2)
  assert.ok(next.every(value => value === next[0]))
  assert.equal(next[0]?.tasks[0].id, 'b')
})

test('concurrent snapshot consumers share one parsed history and retain updates', async () => {
  const { file, store } = await openStore('shun-shared-snapshot-')
  await writeFile(file, JSON.stringify(state([task('large', '正文'.repeat(500_000))])))
  const snapshots = await Promise.all(Array.from({ length: 24 }, () => store.snapshot()))
  for (const snapshot of snapshots) assert.equal(snapshot, snapshots[0])
  await store.applyDelta({ kind: 'delta', currentId: 'large', order: ['large'], tasks: [task('large', 'updated')] })
  assert.equal((await store.snapshot())?.tasks[0].turns[0].content, 'updated')
})

test('legacy backup is used only when the primary state cannot be loaded', async () => {
  const { root, file, store } = await openStore('shun-legacy-backup-')
  await writeFile(join(root, 'state.backup.json'), JSON.stringify(state([task('backup', 'old')])))
  await writeFile(file, JSON.stringify(state([task('primary', 'current')])))
  assert.equal((await store.snapshot())?.tasks[0].id, 'primary')
  await writeFile(file, '{invalid')
  assert.equal((await store.snapshot())?.tasks[0].id, 'backup')
})


test('concurrent saves back up the initial validated store once without reparsing it', async () => {
  const { file } = await openStore('shun-backup-once-')
  let reads = 0
  const store = new SavedStateStore(file, value => { reads++; return value })
  const initial = JSON.stringify(state([task('a', 'original')]))
  await writeFile(file, initial)
  await store.snapshot()
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.applyDelta({
    kind: 'delta', currentId: 'a', order: ['a'], tasks: [task('a', `update-${i}`)],
  })))
  await store.save(state([task('a', 'last')]))
  assert.equal(reads, 2) // One load and the explicit full-save settings normalization.
  assert.equal(await readFile(`${file}.backup`, 'utf8'), initial)
  assert.equal((await store.snapshot())?.tasks[0].turns[0].content, 'last')
})

test('a snapshot during file publication reuses the new committed state without parsing again', async () => {
  const { file } = await openStore('shun-publication-')
  let parses = 0
  const store = new SavedStateStore(file, value => { parses++; return value })
  await writeFile(file, JSON.stringify(state([task('a', 'before')])))
  await store.snapshot()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const internals = store as unknown as { stamp: (path?: string) => Promise<{ mtimeMs: number; size: number } | null> }
  const stamp = internals.stamp.bind(store)
  let calls = 0
  internals.stamp = async path => {
    const result = await stamp(path)
    if (++calls === 2) { entered(); await gate }
    return result
  }
  const save = store.applyDelta({ kind: 'delta', currentId: 'a', order: ['a'], tasks: [task('a', 'after')] })
  await started
  const snapshot = store.snapshot()
  await new Promise(resolve => setImmediate(resolve))
  release()
  await save
  assert.equal((await snapshot)?.tasks[0].turns[0].content, 'after')
  assert.equal(parses, 1)
})

test('large histories persist only changed tasks and recover them after restart', async () => {
  const { file, store } = await openStore('shun-durable-delta-')
  const unchanged = task('archive', 'x'.repeat(9 * 1024 * 1024))
  await store.save(state([unchanged, task('live', 'before')]))
  const base = await readFile(file, 'utf8')
  await store.applyDelta({ kind: 'delta', order: ['archive', 'live'], tasks: [task('live', 'after')], currentId: 'live' })
  assert.equal(await readFile(file, 'utf8'), base, 'stream updates do not rewrite the archive')
  assert.ok((await readFile(`${file}.delta`, 'utf8')).length < 3000)
  const restarted = new SavedStateStore(file, value => value)
  assert.equal((await restarted.snapshot())?.tasks[1].turns[0].content, 'after')
  await restarted.applyDelta({ kind: 'delta', order: ['live'], tasks: [], currentId: 'live' })
  assert.deepEqual((await new SavedStateStore(file, value => value).snapshot())?.tasks.map(task => task.id), ['live'])
  await restarted.mutate(value => { value.tasks[0].title = 'renamed' })
  assert.equal((await new SavedStateStore(file, value => value).snapshot())?.tasks[0].title, 'renamed')
  await assert.rejects(readFile(`${file}.delta`), { code: 'ENOENT' })
})
