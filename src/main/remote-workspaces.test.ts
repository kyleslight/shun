import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { browseRemoteWorkspaces } from './remote-workspaces.ts'

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
