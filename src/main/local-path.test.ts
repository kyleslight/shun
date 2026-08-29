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
