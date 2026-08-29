import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync, zipSync } from 'fflate'
import { ensurePluginRuntimeAsset, ensurePluginRuntimeExecutable } from './plugin-runtime-assets.ts'

test('linked development runtime assets are served directly as the current source of truth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-runtime-asset-'))
  const content = Buffer.from('verified layer')
  const developmentPath = join(root, 'source', 'layer.bin')
  const cachePath = join(root, 'cache', 'layer.bin')
  await mkdir(join(root, 'source'), { recursive: true })
  await writeFile(developmentPath, content)
  const descriptor = {
    id: 'layer', path: 'layer.bin', bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    cachePath, developmentPath,
  }
  const resolved = await ensurePluginRuntimeAsset(descriptor, async () => { throw Error('network should not run') })
  assert.equal(resolved, developmentPath)
})

test('linked development runtime assets do not block reload on stale manifest digests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-runtime-asset-bad-'))
  const developmentPath = join(root, 'layer.bin')
  await writeFile(developmentPath, 'tampered')
  const resolved = await ensurePluginRuntimeAsset({
    id: 'layer', path: 'layer.bin', bytes: 8, sha256: '0'.repeat(64),
    cachePath: join(root, 'cache', 'layer.bin'), developmentPath,
  }, async () => { throw Error('network should not run') })
  assert.equal(resolved, developmentPath)
})

test('published runtime metadata is a cache hint rather than a user-facing execution gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-runtime-asset-download-'))
  const cachePath = join(root, 'cache', 'layer.bin')
  const resolved = await ensurePluginRuntimeAsset({
    id: 'layer', path: 'layer.bin', bytes: 8, sha256: '0'.repeat(64),
    cachePath, url: 'https://example.com/layer.bin',
  }, async () => new Response('usable current layer'))
  assert.equal(resolved, cachePath)
  assert.equal(await readFile(cachePath, 'utf8'), 'usable current layer')
})

test('native runtime executables unpack zip and tar.gz targets into an executable cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-runtime-executable-'))
  const cases = [
    { archive: 'zip' as const, entry: 'tool.exe', body: zipSync({ 'tool.exe': new TextEncoder().encode('windows tool') }), expected: 'windows tool' },
    { archive: 'tar.gz' as const, entry: 'tool', body: gzipSync(tarEntry('tool', new TextEncoder().encode('unix tool'))), expected: 'unix tool' },
  ]
  for (const [index, item] of cases.entries()) {
    const cachePath = join(root, String(index), item.entry)
    const progress: Array<{ downloadedBytes: number; totalBytes: number; done: boolean; cached: boolean }> = []
    const path = await ensurePluginRuntimeExecutable({
      id: 'tool', version: '1.0.0', platform: item.archive === 'zip' ? 'win32' : 'darwin', arch: 'x64',
      archive: item.archive, entry: item.entry, bytes: item.body.length, url: `https://example.com/${item.entry}`, cachePath,
    }, async () => new Response(Buffer.from(item.body), { headers: { 'content-length': String(item.body.length) } }), update => progress.push(update))
    assert.equal(path, cachePath)
    assert.equal(await readFile(path, 'utf8'), item.expected)
    assert.deepEqual(progress[0], { downloadedBytes: 0, totalBytes: item.body.length, done: false, cached: false })
    assert.deepEqual(progress.at(-1), { downloadedBytes: item.body.length, totalBytes: item.body.length, done: true, cached: false })
  }
})

test('concurrent runtime callers share one install and each receive its progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-runtime-progress-'))
  const body = new TextEncoder().encode('shared tool')
  const descriptor = {
    id: 'tool', version: '1.0.0', platform: 'darwin' as const, arch: 'arm64' as const,
    archive: 'raw' as const, entry: 'tool', bytes: body.length, url: 'https://example.com/tool', cachePath: join(root, 'tool'),
  }
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const firstProgress: Array<{ done: boolean }> = [], secondProgress: Array<{ done: boolean }> = []
  const first = ensurePluginRuntimeExecutable(descriptor, async () => {
    await gate
    return new Response(body, { headers: { 'content-length': String(body.length) } })
  }, update => firstProgress.push(update))
  const second = ensurePluginRuntimeExecutable(descriptor, async () => { throw Error('duplicate download') }, update => secondProgress.push(update))
  release()
  await Promise.all([first, second])
  assert.equal(firstProgress.at(-1)?.done, true)
  assert.equal(secondProgress.at(-1)?.done, true)
})

function tarEntry(name: string, content: Uint8Array) {
  const block = 512
  const header = new Uint8Array(block)
  header.set(new TextEncoder().encode(name), 0)
  header.set(new TextEncoder().encode(content.length.toString(8).padStart(11, '0') + '\0'), 124)
  header[156] = 48
  const out = new Uint8Array(block + Math.ceil(content.length / block) * block + block * 2)
  out.set(header, 0)
  out.set(content, block)
  return out
}
