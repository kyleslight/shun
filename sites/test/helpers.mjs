/**
 * Test doubles for the publishing service: a verified identity, the `devices`
 * table the shared identity lives in, the KV the service stores sites in, and a
 * fetch that signs requests exactly like the desktop client does.
 */
import service from '../src/index.mjs'

export const apiHost = 'sites-api.shunagent.site'

export const base64Url = bytes => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export async function sha256hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** The identity the marketplace verifies: a handle, a device, and its key. */
export async function verifiedIdentity(handle = 'kyle') {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const deviceId = `dev_${handle}`
  const publicKey = base64Url(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)))
  return {
    handle,
    deviceId,
    publicKey,
    async authorization(method, path, body = new Uint8Array()) {
      const timestamp = Date.now()
      const payload = `${method}\n${path}\n${timestamp}\n${await sha256hex(body)}`
      const signature = base64Url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keyPair.privateKey, new TextEncoder().encode(payload))))
      return `Shun-Publisher handle=${handle}, device=${deviceId}, timestamp=${timestamp}, signature=${signature}`
    },
    async status() { return { handle, deviceId } },
  }
}

/** The `devices` table the service reads the shared identity from. */
export function database(devices) {
  const rows = new Map(devices.map(device => [device.id, { id: device.id, publisher_handle: device.handle, public_key: device.publicKey, revoked_at: device.revokedAt ?? null }]))
  return { prepare: () => ({ bind: id => ({ first: async () => rows.get(id) ?? null }) }) }
}

/** The service's KV, with the reads and writes both halves use. */
export function storage() {
  const records = new Map()
  return {
    records,
    async get(key, options) {
      const found = records.get(key)
      if (!found) return null
      if (options?.type === 'json') return JSON.parse(found.value)
      return found.value
    },
    async getWithMetadata(key, options) {
      const found = records.get(key)
      if (!found) return { value: null, metadata: null }
      return {
        value: options?.type === 'arrayBuffer' ? new Uint8Array(Buffer.from(found.value, 'base64')) : found.value,
        metadata: found.metadata ?? null,
      }
    },
    async put(key, value, options = {}) {
      records.set(key, { value: typeof value === 'string' ? value : Buffer.from(value).toString('base64'), metadata: options.metadata })
    },
    async delete(key) { records.delete(key) },
  }
}

export function environment(devices) {
  return { SITES: storage(), DB: database(devices) }
}

/** A signed request straight into the service, as a client would send it. */
export async function call(env, identity, path, options = {}) {
  const method = options.method || (options.body === undefined ? 'GET' : 'POST')
  const body = options.body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(options.body))
  const headers = {}
  if (options.anonymous !== true) headers.authorization = await identity.authorization(method, path, body)
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const request = new Request(`https://${apiHost}${path}`, { method, headers, ...(options.body !== undefined ? { body } : {}) })
  return service.fetch(request, env)
}

export const json = async response => ({ status: response.status, body: await response.json() })
export const stored = (env, key) => env.SITES.records.get(key)?.value
export const storedJson = (env, key) => JSON.parse(stored(env, key))
export const storedText = (env, key) => Buffer.from(stored(env, key), 'base64').toString()
export const base64 = text => Buffer.from(text).toString('base64')
