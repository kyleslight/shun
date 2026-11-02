import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecipheriv } from 'node:crypto'
import { LanDownloads } from './lan-download.ts'

test('paired capability transfers authenticated bounded chunks and supports resuming', async () => {
  let now = Date.now()
  const root = await mkdtemp(join(tmpdir(), 'shun-lan-')), server = new LanDownloads(() => now)
  try {
    const bytes = Buffer.alloc(1024 * 1024 + 123, 42), path = join(root, 'video.mp4')
    await writeFile(path, bytes)
    const offer = await server.offer(path)
    assert.ok(offer)
    const url = new URL(offer.urls[0]); url.hostname = '127.0.0.1'
    assert.equal((await fetch(new URL('/invalid', url))).status, 404)
    const result: Buffer[] = []
    for (const offset of [0, 1024 * 1024]) {
      const response = await fetch(`${url}?offset=${offset}`)
      assert.equal(response.status, 200)
      const body = await response.json() as { nonce: string; ciphertext: string }
      const encrypted = Buffer.from(body.ciphertext, 'base64')
      const cipher = createDecipheriv('aes-256-gcm', Buffer.from(offer.key, 'base64'), Buffer.from(body.nonce, 'base64'))
      cipher.setAAD(Buffer.from(`${url.pathname.slice(1)}:${offset}`)); cipher.setAuthTag(encrypted.subarray(-16))
      result.push(Buffer.concat([cipher.update(encrypted.subarray(0, -16)), cipher.final()]))
    }
    assert.deepEqual(Buffer.concat(result), bytes)
    assert.equal((await fetch(`${url}?offset=-1`)).status, 416)
    await writeFile(path, Buffer.alloc(bytes.length, 43))
    assert.equal((await fetch(`${url}?offset=0`)).status, 409)
    const fresh = await server.offer(path)
    assert.ok(fresh)
    const expired = new URL(fresh.urls[0]); expired.hostname = '127.0.0.1'
    now = fresh.expiresAt + 1
    assert.equal((await fetch(`${expired}?offset=0`)).status, 404)
    server.revoke()
    assert.equal((await fetch(`${url}?offset=0`)).status, 404)
  } finally { server.close(); await rm(root, { recursive: true, force: true }) }
})
