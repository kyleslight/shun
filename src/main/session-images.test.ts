import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AttachmentStore } from './attachments.ts'
import { externalizeContent, externalizeSessionFile, hasInlineImage, hasStoredImage, imageCache, resolveContent } from './session-images.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const image = () => ({ type: 'image' as const, mimeType: 'image/png', data: PNG })

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'shun-session-images-'))
  return { root, store: new AttachmentStore(join(root, 'attachments')) }
}

test('an inline image becomes a reference and resolves back to the same bytes', async () => {
  const { root, store } = await workspace()
  try {
    const content = [{ type: 'text', text: 'look' }, image()]
    assert.equal(hasInlineImage(content), true)
    const externalized = await externalizeContent(content, 'task', store) as any[]
    assert.equal(hasInlineImage(externalized), false)
    assert.equal(hasStoredImage(externalized), true)
    assert.equal(externalized[1].data, '')
    assert.equal(typeof externalized[1].attachmentId, 'string')
    assert.equal(externalized[0].text, 'look')

    const resolved = await resolveContent(externalized, 'task', store, imageCache()) as any[]
    assert.deepEqual(resolved[1], { type: 'image', mimeType: 'image/png', data: PNG })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the same picture twice is stored once', async () => {
  const { root, store } = await workspace()
  try {
    const externalized = await externalizeContent([image(), image()], 'task', store) as any[]
    assert.equal(externalized[0].attachmentId, externalized[1].attachmentId)
    assert.equal((await store.list('task')).length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a missing attachment degrades to a note instead of an empty image', async () => {
  const { root, store } = await workspace()
  try {
    const resolved = await resolveContent([{ type: 'image', mimeType: 'image/png', data: '', attachmentId: 'gone' }], 'task', store, imageCache()) as any[]
    assert.deepEqual(resolved[0], { type: 'text', text: '[image unavailable: gone]' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a session file is rewritten once and left alone afterwards', async () => {
  const { root, store } = await workspace()
  try {
    const path = join(root, 'session.jsonl')
    const header = { type: 'session', version: 3, id: 'task', timestamp: new Date().toISOString(), cwd: root }
    const message = { type: 'message', id: 'a', parentId: null, timestamp: Date.now(), message: { role: 'user', content: [image()], timestamp: Date.now() } }
    await writeFile(path, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`)

    assert.equal(await externalizeSessionFile(path, 'task', store), true)
    const rewritten = await readFile(path, 'utf8')
    assert.equal(rewritten.includes(PNG), false)
    const entries = rewritten.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(entries.length, 2)
    assert.equal(entries[1].message.content[0].attachmentId, (await store.list('task'))[0].id)

    assert.equal(await externalizeSessionFile(path, 'task', store), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a resolved image is reused without reading the store again', async () => {
  const { root, store } = await workspace()
  try {
    const externalized = await externalizeContent([image()], 'task', store) as any[]
    const cache = imageCache()
    const first = await resolveContent(externalized, 'task', store, cache) as any[]
    await store.remove('task', externalized[0].attachmentId)
    const second = await resolveContent(externalized, 'task', store, cache) as any[]
    assert.deepEqual(second[0], first[0])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the cache is bounded by bytes, not by a picture count', async () => {
  const { root, store } = await workspace()
  try {
    // A context window can hold dozens of screenshots; a count bound would
    // thrash on exactly those windows.
    const pictures = Array.from({ length: 30 }, (_, index) => Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(300_000, index + 1)]))
    const stored = await store.importBuffers('task', pictures.map((bytes, index) => ({ name: `a${index}.png`, bytes })), Number.POSITIVE_INFINITY)
    const blocks = stored.map(item => ({ type: 'image' as const, mimeType: 'image/png', data: '', attachmentId: item.id }))
    const cache = imageCache()
    await resolveContent(blocks, 'task', store, cache)
    assert.ok(cache.bytes <= 24 * 1024 * 1024)
    assert.ok(cache.entries.size > 24)
  } finally { await rm(root, { recursive: true, force: true }) }
})
