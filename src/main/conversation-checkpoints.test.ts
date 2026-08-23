import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConversationCheckpointStore } from './conversation-checkpoints.ts'

test('conversation checkpoints preview and restore the exact workspace state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-conversation-checkpoint-'))
  const workspace = join(root, 'workspace')
  const store = new ConversationCheckpointStore(join(root, 'checkpoints'))
  try {
    await mkdir(join(workspace, 'src'), { recursive: true })
    await mkdir(join(workspace, 'node_modules', 'ignored'), { recursive: true })
    await writeFile(join(workspace, 'src', 'main.ts'), 'before\n', { mode: 0o744 })
    await writeFile(join(workspace, 'src', 'asset.bin'), Buffer.from([0, 1, 2, 255]))
    await symlink('main.ts', join(workspace, 'src', 'current'))
    await writeFile(join(workspace, 'node_modules', 'ignored', 'state.txt'), 'not checkpointed')

    const checkpoint = await store.capture({
      taskId: 'task_1',
      messageId: 'message_1',
      workspace,
      parentEntryId: 'entry_0',
    })
    assert.equal(checkpoint.complete, true)
    assert.equal(checkpoint.parentEntryId, 'entry_0')

    await writeFile(join(workspace, 'src', 'main.ts'), 'after\n', { mode: 0o600 })
    await rm(join(workspace, 'src', 'asset.bin'))
    await rm(join(workspace, 'src', 'current'))
    await symlink('../../outside', join(workspace, 'src', 'current'))
    await writeFile(join(workspace, 'new.txt'), 'created later')
    await writeFile(join(workspace, 'node_modules', 'ignored', 'state.txt'), 'still ignored')

    const preview = await store.preview('task_1', 'message_1', workspace)
    assert.equal(preview.available, true)
    assert.equal(preview.complete, true)
    assert.deepEqual(preview.changedFiles, ['new.txt', 'src/asset.bin', 'src/current', 'src/main.ts'])

    const restored = await store.restore('task_1', 'message_1', workspace)
    assert.deepEqual(restored.changedFiles, preview.changedFiles)
    assert.equal(await readFile(join(workspace, 'src', 'main.ts'), 'utf8'), 'before\n')
    assert.deepEqual(await readFile(join(workspace, 'src', 'asset.bin')), Buffer.from([0, 1, 2, 255]))
    assert.equal(await readlink(join(workspace, 'src', 'current')), 'main.ts')
    assert.equal((await stat(join(workspace, 'src', 'main.ts'))).mode & 0o777, 0o744)
    await assert.rejects(readFile(join(workspace, 'new.txt')), { code: 'ENOENT' })
    assert.equal(await readFile(join(workspace, 'node_modules', 'ignored', 'state.txt'), 'utf8'), 'still ignored')

    await store.capture({ taskId: 'task_1', messageId: 'message_3', workspace, parentEntryId: 'entry_2' })
    const objectEntries = await readdir(join(root, 'checkpoints', 'task_1', 'objects'), { recursive: true, withFileTypes: true })
    assert.equal(objectEntries.filter(entry => entry.isFile()).length, 2, 'unchanged file contents should reuse checkpoint objects')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('incomplete checkpoints never overwrite the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-conversation-checkpoint-limit-'))
  const workspace = join(root, 'workspace')
  const store = new ConversationCheckpointStore(join(root, 'checkpoints'))
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'large.bin'), Buffer.alloc(8_000_001))
    const checkpoint = await store.capture({
      taskId: 'task_2',
      messageId: 'message_2',
      workspace,
      parentEntryId: null,
    })
    assert.equal(checkpoint.complete, false)
    assert.deepEqual(checkpoint.skipped, ['large.bin'])
    await assert.rejects(
      store.restore('task_2', 'message_2', workspace),
      /checkpoint is incomplete/i,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
