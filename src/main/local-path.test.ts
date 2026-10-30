import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { describeLocalPath, existingLocalPath } from './local-path.ts'

test('local file and folder targets accept absolute paths, file URLs, and source locations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-local-path-'))
  try {
    const folder = join(root, 'folder with spaces'), file = join(folder, 'example.ts')
    await mkdir(folder)
    await writeFile(file, 'export {}\n')
    assert.deepEqual(await existingLocalPath(folder), { path: folder, kind: 'directory' })
    assert.deepEqual(await existingLocalPath(pathToFileURL(file).href), { path: file, kind: 'file' })
    assert.deepEqual(await existingLocalPath(`${file}:12:4`), { path: file, kind: 'file' })
    await assert.rejects(() => existingLocalPath('relative/file.ts'), /absolute local paths/)
    await assert.rejects(() => existingLocalPath(join(root, 'missing')), /no longer exists/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('local path descriptions distinguish workspace files from outside files and symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-local-path-scope-'))
  try {
    const workspace = join(root, 'workspace'), nested = join(workspace, 'src'), inside = join(nested, 'inside.ts'), outside = join(root, 'outside.ts'), escaped = join(workspace, 'outside-link.ts')
    await mkdir(nested, { recursive: true })
    await writeFile(inside, 'inside\n')
    await writeFile(outside, 'outside\n')
    await symlink(outside, escaped)

    const canonicalInside = await realpath(inside), canonicalOutside = await realpath(outside)
    assert.deepEqual(await describeLocalPath(inside, workspace), { path: canonicalInside, kind: 'file', workspaceRelative: 'src/inside.ts' })
    assert.deepEqual(await describeLocalPath(outside, workspace), { path: canonicalOutside, kind: 'file' })
    assert.deepEqual(await describeLocalPath(escaped, workspace), { path: canonicalOutside, kind: 'file' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed task links recover an incorrect home without guessing filenames or crossing tasks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-managed-links-'))
  const id = Buffer.from('d17322cb-95b6-407c-b191-7ca9f4e91dfb').toString('base64url')
  const task = join(root, 'standalone', id)
  const file = join(task, 'project', '.review', 'hero image.png')
  const incorrect = `/Users/wrong/.shun/standalone/${id}/project/.review/hero image.png`
  try {
    await mkdir(join(task, 'project', '.review'), { recursive: true })
    await writeFile(file, 'image')
    const expected = { path: await realpath(file), kind: 'file' }
    assert.deepEqual(await existingLocalPath(incorrect, root), expected)
    assert.deepEqual(await existingLocalPath(pathToFileURL(incorrect).href, root), expected)
    assert.deepEqual(await existingLocalPath(`${incorrect}:12:4`, root), expected)
    await assert.rejects(existingLocalPath(incorrect.replace(id, Buffer.from('e17322cb-95b6-407c-b191-7ca9f4e91dfb').toString('base64url')), root), /no longer exists/)
    await assert.rejects(existingLocalPath(incorrect.replace('/project/.review/', '/different/'), root), /no longer exists/)
    await assert.rejects(existingLocalPath('/Users/wrong/Documents/hero image.png', root), /no longer exists/)
    const outside = join(root, 'outside.png')
    await writeFile(outside, 'outside')
    await symlink(outside, join(task, 'escape.png'))
    await assert.rejects(existingLocalPath(`/Users/wrong/.shun/standalone/${id}/escape.png`, root), /no longer exists/)
    // An existing exact target remains authoritative.
    assert.deepEqual(await existingLocalPath(outside, root), { path: outside, kind: 'file' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
