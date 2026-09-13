import { createHash } from 'node:crypto'
import { defaultMarketplaceUrl } from '../marketplace.ts'
import type { PluginSecretStore } from './plugin-secrets.ts'

/**
 * Publisher identity on the client: a verified email plus a device key.
 *
 * The email proves control of a mailbox exactly once. What is kept on this
 * machine is the handle, the device id, and a private key that never leaves it —
 * the key is encrypted with the same secure storage the plugin credentials use.
 * Every publish is signed over the exact request, so a stolen secret file alone
 * cannot publish as this identity.
 */

const identityKey = 'publisher-identity'

export type PublisherBinding = { email: string; handle: string; domain: string; deviceId: string; privateKeyPkcs8: string; boundAt: number }
/** What the application shows: the address it verified, and the handle it publishes under. */
export type PublisherIdentity = { email: string; handle: string; domain: string; deviceId: string; boundAt: number }
export type PublisherChallenge = { challengeId: string; domain: string; handle: string; expiresAt: string; delivered: boolean; code?: string }

export class PublisherIdentityStore {
  #secrets: PluginSecretStore
  #fetch: typeof fetch
  #baseUrl: string

  constructor(secrets: PluginSecretStore, fetchImpl: typeof fetch, baseUrl = defaultMarketplaceUrl) {
    this.#secrets = secrets
    this.#fetch = fetchImpl
    this.#baseUrl = String(baseUrl || defaultMarketplaceUrl).replace(/\/+$/, '')
  }

  get baseUrl() { return this.#baseUrl }

  async status(): Promise<PublisherIdentity | undefined> {
    const binding = await this.#binding()
    return binding ? { email: binding.email, handle: binding.handle, domain: binding.domain, deviceId: binding.deviceId, boundAt: binding.boundAt } : undefined
  }

  /**
   * The address a code was requested for. The registry never returns it, so the
   * application has to remember which mailbox it asked about, and the display
   * name it proposes is only a hint: the registry resolves the final one.
   */
  #pendingEmail: string | undefined
  #pendingChallenge: string | undefined
  pendingEmail() { return this.#pendingEmail }
  pendingChallenge() { return this.#pendingChallenge }

  /** Ask the registry to send a code to this address. */
  async requestCode(email: string, handle?: string): Promise<PublisherChallenge> {
    const address = String(email || '').trim()
    const challenge = await this.#post('/v1/publishers/challenge', { email: address, ...(handle ? { handle } : {}) }) as PublisherChallenge
    this.#pendingEmail = address
    this.#pendingChallenge = challenge.challengeId
    return challenge
  }

  /**
   * Confirm the code and bind this machine. The device key is created here, so
   * the private half has never existed anywhere else.
   */
  async verify(input: { challengeId: string; code: string; handle?: string; email?: string }): Promise<PublisherIdentity> {
    const email = String(input.email || this.#pendingEmail || '').trim()
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const publicKey = base64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
    const pkcs8 = base64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)))
    const result = await this.#post('/v1/publishers/verify', {
      challengeId: input.challengeId,
      code: String(input.code || '').trim(),
      devicePublicKey: publicKey,
      ...(input.handle ? { handle: input.handle } : {}),
    }) as { handle: string; domain: string; deviceId: string; createdAt: string }
    const binding: PublisherBinding = {
      email,
      handle: result.handle,
      domain: result.domain,
      deviceId: result.deviceId,
      privateKeyPkcs8: pkcs8,
      boundAt: Date.parse(result.createdAt) || Date.now(),
    }
    await this.#write(binding)
    this.#pendingEmail = undefined
    this.#pendingChallenge = undefined
    return { email: binding.email, handle: binding.handle, domain: binding.domain, deviceId: binding.deviceId, boundAt: binding.boundAt }
  }

  /** Forget this machine's key, and tell the registry to stop trusting it. */
  async unbind(): Promise<boolean> {
    const binding = await this.#binding()
    if (!binding) return false
    await this.authorization('POST', '/v1/publishers/revoke-device', new Uint8Array())
      .then(header => this.#fetch(`${this.#baseUrl}/v1/publishers/revoke-device`, { method: 'POST', headers: { authorization: header } }))
      .catch(() => undefined)
    await this.#secrets.delete(identityKey)
    return true
  }

  async authorize(): Promise<boolean> {
    return Boolean(await this.#binding())
  }

  /** `Shun-Publisher …` over this exact method, path, and body. */
  async authorization(method: string, path: string, body: Uint8Array) {
    const binding = await this.#binding()
    if (!binding) throw Error('No publisher identity is bound on this computer.')
    const timestamp = Date.now()
    const digest = createHash('sha256').update(body).digest('hex')
    const payload = `${method}\n${path}\n${timestamp}\n${digest}`
    const key = await crypto.subtle.importKey('pkcs8', fromBase64(binding.privateKeyPkcs8).buffer as ArrayBuffer, { name: 'Ed25519' }, false, ['sign'])
    const signature = base64Url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(payload))))
    return `Shun-Publisher handle=${binding.handle}, device=${binding.deviceId}, timestamp=${timestamp}, signature=${signature}`
  }

  async #binding(): Promise<PublisherBinding | undefined> {
    const raw = await this.#secrets.get(identityKey)
    if (!raw) return undefined
    try {
      const parsed = JSON.parse(raw) as PublisherBinding
      return parsed?.handle && parsed?.deviceId && parsed?.privateKeyPkcs8 ? parsed : undefined
    } catch {
      return undefined
    }
  }

  async #write(binding: PublisherBinding) {
    await this.#secrets.set(identityKey, JSON.stringify(binding))
  }

  async #post(path: string, body: unknown) {
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw Error(`Could not reach the plugin registry at ${this.#baseUrl}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const payload = await response.json().catch(() => ({})) as { message?: string; error?: string }
    if (!response.ok) throw Error(payload.message || payload.error || `The registry refused the request (HTTP ${response.status}).`)
    return payload
  }
}

function base64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64')
}

function base64Url(bytes: Uint8Array) {
  return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64(value: string) {
  return new Uint8Array(Buffer.from(value, 'base64'))
}
