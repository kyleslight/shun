import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zipSync } from 'fflate'
import { createPluginArchive, extractPluginArchive, maxPackageBytes, pluginPackageDigest, stagePluginArchive } from './plugin-archive.ts'

const manifest = {
  schemaVersion: 1,
  id: 'archived-plugin',
  name: 'Archived Plugin',
  description: 'Exercises the archive format.',
  version: '1.2.3',
  publisher: 'Test',
  permissions: [{ id: 'workspace.read', reason: 'Read workspace files.' }],
  contributes: { views: [{ id: 'archived-plugin.main', title: 'Archived', location: 'workspace.right', entry: 'ui/index.html' }] },
}

async function writePackage(root: string, files: Record<string, string> = {}) {
  await mkdir(join(root, 'ui'), { recursive: true })
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'ui', 'index.html'), '<!doctype html><meta charset="utf-8">')
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, ...path.split('/').slice(0, -1)), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

test('packing a package is deterministic and both digests describe it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-pack-'))
  const source = join(root, 'source')
  await writePackage(source, { 'ui/app.js': 'console.log("first")' })
  const first = await createPluginArchive(source)
  const second = await createPluginArchive(source)
  assert.equal(first.sha256, second.sha256)
  assert.deepEqual(Buffer.from(second.bytes), Buffer.from(first.bytes))
  assert.equal(first.sha256, createHash('sha256').update(first.bytes).digest('hex'))
  assert.equal(first.contentSha256, (await pluginPackageDigest(source)).sha256)
  assert.equal(first.files, 3)
  assert.ok(first.contentBytes > 0)

  await writeFile(join(source, 'ui', 'app.js'), 'console.log("second")')
  const changed = await createPluginArchive(source)
  assert.notEqual(changed.sha256, first.sha256)
  assert.notEqual(changed.contentSha256, first.contentSha256)
})

test('extraction round-trips the package and lands on the packed digests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-unpack-'))
  const source = join(root, 'source')
  await writePackage(source, { 'ui/app.js': 'console.log("round trip")' })
  const archive = await createPluginArchive(source)
  const target = join(root, 'extracted')
  const result = await extractPluginArchive(archive.bytes, target, { sha256: archive.sha256, contentSha256: archive.contentSha256 })
  assert.equal(result.sha256, archive.sha256)
  assert.equal(result.contentSha256, archive.contentSha256)
  assert.equal(result.files, archive.files)
  assert.equal(result.contentBytes, archive.contentBytes)
  assert.equal(await readFile(join(target, 'ui', 'app.js'), 'utf8'), 'console.log("round trip")')
  assert.equal((await pluginPackageDigest(target)).sha256, archive.contentSha256)
  assert.deepEqual((await readdir(target)).sort(), ['manifest.json', 'ui'])
})

test('a digest that does not match the published one is refused before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-digest-'))
  const source = join(root, 'source')
  await writePackage(source)
  const archive = await createPluginArchive(source)
  const rejected = join(root, 'rejected')
  await assert.rejects(extractPluginArchive(archive.bytes, rejected, { sha256: 'f'.repeat(64) }), /does not match the published digest/)
  await assert.rejects(readdir(rejected), /ENOENT/)
  await assert.rejects(
    extractPluginArchive(archive.bytes, join(root, 'wrong-content'), { contentSha256: 'a'.repeat(64) }),
    /does not match its published content digest/,
  )
  await assert.rejects(extractPluginArchive(new Uint8Array(0), join(root, 'empty')), /Plugin archive is empty/)
  await assert.rejects(extractPluginArchive(new Uint8Array(maxPackageBytes + 1), join(root, 'huge')), /must stay under 25 MB/)
})

test('hostile archive entries never reach the filesystem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-hostile-'))
  const payload = { 'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)), 'ui/index.html': new TextEncoder().encode('<!doctype html>') }
  for (const name of ['../escape.txt', '/absolute.txt', 'a/../../escape.txt', 'a\\b.txt', 'ui/./index.html', '']) {
    await assert.rejects(stagePluginArchive(zipSync({ ...payload, [name]: new TextEncoder().encode('x') })), /invalid entry name|must stay inside the package|package-relative/)
  }
  await assert.rejects(readdir(join(root, 'escape.txt')), /ENOENT/)
})

test('staging cleans up after itself and a second pass over the same bytes still works', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-stage-'))
  const source = join(root, 'source')
  await writePackage(source)
  const archive = await createPluginArchive(source)
  const staged = await stagePluginArchive(archive.bytes, { sha256: archive.sha256 })
  assert.equal(await readFile(join(staged.root, 'manifest.json'), 'utf8'), JSON.stringify(manifest))
  await staged.cleanup()
  await assert.rejects(readdir(staged.root), /ENOENT/)
  await assert.rejects(stagePluginArchive(archive.bytes, { contentSha256: 'b'.repeat(64) }), /does not match its published content digest/)
})

test('packing refuses packages that cannot be distributed honestly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-limits-'))
  const source = join(root, 'source')
  await writePackage(source)
  await symlink(join(source, 'manifest.json'), join(source, 'linked.json'))
  await assert.rejects(createPluginArchive(source), /cannot contain symbolic links: linked\.json/)
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))

  const crowded = join(root, 'crowded')
  await mkdir(crowded)
  await writeFile(join(crowded, 'manifest.json'), JSON.stringify(manifest))
  await Promise.all(Array.from({ length: 400 }, (_value, index) => writeFile(join(crowded, `file-${index}.txt`), 'x')))
  await assert.rejects(createPluginArchive(crowded), /at most 400 files/)
  await assert.rejects(createPluginArchive(join(root, 'missing')), /ENOENT|no such file/)
})
