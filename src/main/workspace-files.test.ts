import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listWorkspaceDirectory } from './workspace-files.ts'

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'shun-workspace-files-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'README.md'), '# readme')
  await writeFile(join(root, 'src', 'index.ts'), 'export {}')
  return root
}

test('a workspace listing shows folders first, then files with their sizes', async () => {
  const root = await workspace()
  try {
    const listing = await listWorkspaceDirectory(root)
    assert.equal(listing.root, listing.path)
    assert.equal(listing.parent, undefined)
    assert.deepEqual(listing.entries.map(entry => [entry.name, entry.kind]), [['src', 'directory'], ['README.md', 'file']])
    assert.equal(listing.entries[1].size, 8)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a subfolder can be opened and points back at its parent', async () => {
  const root = await workspace()
  try {
    const listing = await listWorkspaceDirectory(root, join(root, 'src'))
    assert.equal(listing.path, join(listing.root, 'src'))
    assert.equal(listing.parent, listing.root)
    assert.deepEqual(listing.entries.map(entry => entry.name), ['index.ts'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a folder outside the workspace is refused, and so is a link that leaves it', async () => {
  const root = await workspace()
  const outside = await mkdtemp(join(tmpdir(), 'shun-outside-'))
  try {
    await writeFile(join(outside, 'secret.txt'), 'not yours')
    await assert.rejects(listWorkspaceDirectory(root, outside), /outside this task workspace/)
    await assert.rejects(listWorkspaceDirectory(root, '/'), /outside this task workspace/)

    // A link inside the workspace that points out of it must not become a door.
    await symlink(outside, join(root, 'escape'))
    await assert.rejects(listWorkspaceDirectory(root, join(root, 'escape')), /outside this task workspace/)
    const listing = await listWorkspaceDirectory(root)
    assert.equal(listing.entries.some(entry => entry.name === 'escape'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('a missing folder is reported instead of listing nothing', async () => {
  const root = await workspace()
  try {
    await assert.rejects(listWorkspaceDirectory(root, join(root, 'gone')), /no longer exists/)
    await assert.rejects(listWorkspaceDirectory(join(root, 'gone')), /no longer exists/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a file cannot be opened as a folder', async () => {
  const root = await workspace()
  try {
    await assert.rejects(listWorkspaceDirectory(root, join(root, 'README.md')), /Only folders can be browsed/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
