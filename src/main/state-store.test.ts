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
