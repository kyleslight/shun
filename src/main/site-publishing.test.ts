import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The service is deployed from this repository and bundled by wrangler, so it
// stays plain JavaScript rather than being compiled by the app.
// @ts-expect-error plain Workers module without type declarations
import service from '../../sites/src/index.mjs'
import { SitePublishingService } from './site-publishing.ts'

const apiHost = 'sites-api.shunagent.site'

const base64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function sha256hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** The identity the marketplace verifies: a handle, a device, and its key. */
async function verifiedIdentity(handle = 'kyle') {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const deviceId = `dev_${handle}`
  const publicKey = base64Url(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)))
  return {
    handle,
    deviceId,
    publicKey,
    /** `Shun-Publisher …` over this exact method, path, and body. */
    authorization: async (method: string, path: string, body: Uint8Array) => {
      const timestamp = Date.now()
      const payload = `${method}\n${path}\n${timestamp}\n${await sha256hex(body)}`
      const signature = base64Url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keyPair.privateKey, new TextEncoder().encode(payload))))
      return `Shun-Publisher handle=${handle}, device=${deviceId}, timestamp=${timestamp}, signature=${signature}`
    },
    async status() { return { handle, deviceId } },
  }
}

/** The `devices` table the shared identity lives in, as the service reads it. */
function database(devices: Array<{ id: string, handle: string, publicKey: string, revokedAt?: string | null }>) {
  const rows = new Map(devices.map(device => [device.id, { id: device.id, publisher_handle: device.handle, public_key: device.publicKey, revoked_at: device.revokedAt ?? null }]))
  return { prepare: () => ({ bind: (id: string) => ({ first: async () => rows.get(id) ?? null }) }) }
}

/** The service's KV, with the reads and writes both halves use. */
function storage() {
  const records = new Map()
  return {
    records,
    async get(key: string, options?: { type?: string }) {
      const found = records.get(key)
      if (!found) return null
      if (options?.type === 'json') return JSON.parse(found.value)
      return found.value
    },
    async getWithMetadata(key: string, options?: { type?: string }) {
      const found = records.get(key)
      if (!found) return { value: null, metadata: null }
      return {
        value: options?.type === 'arrayBuffer' ? new Uint8Array(Buffer.from(found.value, 'base64')) : found.value,
        metadata: found.metadata ?? null,
      }
    },
    async put(key: string, value: string | Uint8Array, options: { metadata?: unknown } = {}) {
      records.set(key, { value: typeof value === 'string' ? value : Buffer.from(value).toString('base64'), metadata: options.metadata })
    },
    async delete(key: string) { records.delete(key) },
  }
}

/**
 * The client under test talks to the real service code over a routed fetch, so a
 * publish here exercises both halves: what the desktop signs and sends, and what
 * the service verifies and stores. Nothing is stubbed in between.
 */
async function harness(options: { revoked?: boolean, unbound?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'shun-sites-client-'))
  const workspace = join(root, 'project')
  await mkdir(join(workspace, 'dist', 'nested'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), '{}')
  await writeFile(join(workspace, 'dist', 'index.html'), '<h1>one</h1>')
  await writeFile(join(workspace, 'dist', 'app.js'), 'console.log(1)')
  await writeFile(join(workspace, 'dist', 'nested', 'deep.txt'), 'deep')

  const publisher = await verifiedIdentity()
  const env = {
    SITES: storage(),
    DB: database([{ id: publisher.deviceId, handle: publisher.handle, publicKey: publisher.publicKey, revokedAt: options.revoked ? new Date().toISOString() : null }]),
  }
  const fetchUrl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(typeof input === 'string' ? input : input.href, init)
    return service.fetch(request, env)
  }) as typeof fetch

  const client = new SitePublishingService({
    publisher: options.unbound
      ? { status: async () => undefined, authorization: async () => { throw Error('No publisher identity is bound on this computer.') } }
      : publisher,
    fetchUrl,
    endpoint: `https://${apiHost}`,
  })
  return { client, env, publisher, workspace, root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

const stored = (env: any, key: string) => env.SITES.records.get(key)?.value
const storedJson = (env: any, key: string) => JSON.parse(stored(env, key))
const storedText = (env: any, key: string) => Buffer.from(stored(env, key), 'base64').toString()

test('publishing is authorized by the verified identity and returns a live address', async () => {
  const context = await harness()
  const published = await context.client.publish({ workspace: context.workspace, path: 'dist' })
  assert.equal(published.site.url, 'https://project.shunagent.site/')
  assert.equal(published.live, true)
  assert.equal(published.uploaded, 3)
  assert.equal(storedText(context.env, 'a:project/index.html'), '<h1>one</h1>')

  // The verified publisher owns it, and the service records who published what.
  assert.deepEqual(storedJson(context.env, 'p:kyle').sites, ['project'])
  assert.equal(storedJson(context.env, 's:project').publisher, 'kyle')

  const status = await context.client.status()
  assert.deepEqual({ available: status.available, verified: status.verified, domain: status.domain }, { available: true, verified: true, domain: 'shunagent.site' })
  assert.deepEqual(status.sites.map(site => site.name), ['project'])
  await context.cleanup()
})

test('republishing sends only what changed, and a removed file stops being served', async () => {
  const context = await harness()
  await context.client.publish({ workspace: context.workspace, path: 'dist' })

  const again = await context.client.publish({ workspace: context.workspace, path: 'dist' })
  assert.equal(again.uploaded, 0)
  assert.equal(again.unchanged, 3)
  assert.equal(again.site.revision, 2)

  await writeFile(join(context.workspace, 'dist', 'app.js'), 'console.log(2)')
  await rm(join(context.workspace, 'dist', 'nested'), { recursive: true })
  const third = await context.client.publish({ workspace: context.workspace, path: 'dist' })
  assert.equal(third.uploaded, 1)
  assert.equal(third.removed, 1)
  assert.equal(storedText(context.env, 'a:project/app.js'), 'console.log(2)')
  assert.equal(context.env.SITES.records.has('a:project/nested/deep.txt'), false)
  await context.cleanup()
})

test('an address belongs to the project that published it, and a clash moves to the next free one', async () => {
  const context = await harness()
  await context.client.publish({ workspace: context.workspace, path: 'dist' })

  const other = join(context.root, 'other', 'project')
  await mkdir(join(other, 'dist'), { recursive: true })
  await writeFile(join(other, 'package.json'), '{}')
  await writeFile(join(other, 'dist', 'index.html'), '<h1>other</h1>')
  const clashed = await context.client.publish({ workspace: other, path: 'dist' })
  assert.equal(clashed.site.url, 'https://project-2.shunagent.site/')
  assert.match(clashed.message, /project was taken, so this site has its own address/)

  // Replacing it is a deliberate act, and the project that does it keeps the address.
  const taken = await context.client.publish({ workspace: other, path: 'dist', name: 'project', takeOver: true })
  assert.equal(taken.site.name, 'project')
  assert.equal((await context.client.publish({ workspace: other, path: 'dist', name: 'project' })).site.name, 'project')
  await context.cleanup()
})

test('protection is issued once, kept as a salted hash, and cleared when the site goes public', async () => {
  const context = await harness()
  await context.client.publish({ workspace: context.workspace, path: 'dist' })

  const secured = await context.client.setAccess({ name: 'project', visibility: 'password' })
  const issued = secured.password || ''
  assert.match(issued, /^[a-z2-9]{5}(?:-[a-z2-9]{5}){3}$/)
  const record = storedJson(context.env, 's:project')
  assert.equal(record.hash, createHash('sha256').update(`${record.salt}${issued}`).digest('hex'))
  assert.equal(JSON.stringify([...context.env.SITES.records.values()]).includes(issued), false, 'the password is never stored')

  // Asking for protection again keeps the working password; going public drops it.
  assert.equal((await context.client.setAccess({ name: 'project', visibility: 'password' })).password, undefined)
  assert.equal(storedJson(context.env, 's:project').hash, record.hash)
  await context.client.setAccess({ name: 'project', visibility: 'public' })
  assert.equal(storedJson(context.env, 's:project').hash, undefined)
  await context.cleanup()
})

test('taking a site down stops the address answering and empties the list', async () => {
  const context = await harness()
  await context.client.publish({ workspace: context.workspace, path: 'dist' })
  const removed = await context.client.remove('project')
  assert.equal(removed.removed, 3)
  for (const key of context.env.SITES.records.keys()) assert.equal(key.startsWith('a:project/') || ['s:project', 'f:project', 'h:project.shunagent.site'].includes(key), false, key)
  assert.deepEqual((await context.client.status()).sites, [])
  await assert.rejects(() => context.client.urlFor('project'), /No published site is named/)
  await context.cleanup()
})

test('what cannot be published is refused with a sentence a person can act on', async () => {
  const context = await harness()
  await mkdir(join(context.workspace, 'empty'), { recursive: true })
  await assert.rejects(() => context.client.publish({ workspace: context.workspace, path: 'empty' }), /index\.html/)
  await assert.rejects(() => context.client.publish({ workspace: context.workspace, path: '../outside' }), /inside the selected workspace|unavailable/)
  await assert.rejects(() => context.client.setAccess({ name: 'project', visibility: 'nonsense' }), /Choose public, password, or off/)
  await assert.rejects(() => context.client.setAccess({ name: 'project', visibility: 'public' }), /not one of this client's sites/)
  await context.cleanup()
})

test('an unreachable service is reported as unreachable, not as a broken site', async () => {
  const publisher = await verifiedIdentity()
  const client = new SitePublishingService({ publisher, fetchUrl: (async () => { throw Error('offline') }) as typeof fetch, endpoint: `https://${apiHost}` })
  const status = await client.status()
  assert.equal(status.available, false)
  assert.deepEqual(status.sites, [])
  assert.match(status.blocker || '', /could not be reached/)
})

test('an unverified identity is asked to verify, and a revoked device cannot publish', async () => {
  const unbound = await harness({ unbound: true })
  const status = await unbound.client.status()
  assert.deepEqual({ verified: status.verified, sites: status.sites.length }, { verified: false, sites: 0 })
  assert.match(status.blocker || '', /verified email/)
  await assert.rejects(() => unbound.client.publish({ workspace: unbound.workspace, path: 'dist' }), /needs a verified email address/)
  await unbound.cleanup()

  const revoked = await harness({ revoked: true })
  await assert.rejects(() => revoked.client.publish({ workspace: revoked.workspace, path: 'dist' }), /not authorized to publish/)
  assert.deepEqual((await revoked.client.status()).sites, [])
  await revoked.cleanup()
})

test('an address is named after the project, never after the folder a build landed in', async () => {
  const context = await harness()
  // A plain folder of files with no package.json is the common case, and `dist`
  // is what a build step produced, not what the project is called.
  const plain = join(context.root, 'shun-todo')
  await mkdir(join(plain, 'dist'), { recursive: true })
  await writeFile(join(plain, 'dist', 'index.html'), '<h1>todo</h1>')
  const published = await context.client.publish({ workspace: plain, path: 'dist' })
  assert.equal(published.site.name, 'shun-todo')
  assert.equal(published.site.url, 'https://shun-todo.shunagent.site/')
  await context.cleanup()
})

test('the address is named after the project, not after its build folder', async () => {
  const context = await harness()
  const published = await context.client.publish({ workspace: context.workspace, path: 'dist' })
  assert.equal(published.site.name, 'project')
  assert.equal(await readFile(join(context.workspace, 'dist', 'index.html'), 'utf8'), '<h1>one</h1>')
  await context.cleanup()
})
