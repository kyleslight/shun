import assert from 'node:assert/strict'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { browseRemoteWorkspaces, createRemoteWorkspaceFolder } from './remote-workspaces.ts'

test('browseRemoteWorkspaces returns visible child folders and a parent', async () => {
  const root = join(tmpdir(), `shun-remote-workspaces-${crypto.randomUUID()}`)
  await mkdir(join(root, 'zeta'), { recursive: true })
  await mkdir(join(root, 'Alpha'), { recursive: true })
  await mkdir(join(root, '.private'), { recursive: true })
  await writeFile(join(root, 'notes.txt'), 'not a folder')

  const result = await browseRemoteWorkspaces(root)

  assert.equal(result.path, root)
  assert.equal(result.parent, tmpdir())
  assert.deepEqual(result.entries, [
    { name: 'Alpha', path: join(root, 'Alpha') },
    { name: 'zeta', path: join(root, 'zeta') },
  ])
})

test('browseRemoteWorkspaces rejects files', async () => {
  const file = join(tmpdir(), `shun-remote-workspace-${crypto.randomUUID()}.txt`)
  await writeFile(file, 'file')
  await assert.rejects(() => browseRemoteWorkspaces(file), /not a folder/i)
})

test('createRemoteWorkspaceFolder makes one folder and answers with the listing', async () => {
  const root = join(tmpdir(), `shun-remote-mkdir-${crypto.randomUUID()}`)
  await mkdir(root, { recursive: true })

  const result = await createRemoteWorkspaceFolder(root, 'fresh project')

  assert.equal(result.path, root)
  assert.deepEqual(result.entries.map(entry => entry.name), ['fresh project'])
  assert.equal((await stat(join(root, 'fresh project'))).isDirectory(), true)
})

test('a folder name is one segment, and only one that can be made', async () => {
  const root = join(tmpdir(), `shun-remote-mkdir-guard-${crypto.randomUUID()}`)
  await mkdir(root, { recursive: true })

  // A name that could carry a path would let a tap choose a directory nobody was
  // shown, and a hidden one would never be listed back.
  for (const name of ['', '   ', 'a/b', '..\\escape', '..', '.', '.hidden']) {
    await assert.rejects(() => createRemoteWorkspaceFolder(root, name), /cannot be used|required/i)
  }
  await mkdir(join(root, 'taken'), { recursive: true })
  await assert.rejects(() => createRemoteWorkspaceFolder(root, 'taken'), /already exists/i)
  await assert.rejects(() => createRemoteWorkspaceFolder(join(root, 'missing'), 'x'), /not a folder/i)
})
