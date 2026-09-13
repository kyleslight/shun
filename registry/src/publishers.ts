import type { RegistryDatabase } from './store.ts'

/**
 * Publisher identity: a verified email address plus a device key.
 *
 * The email is only ever used to prove control of a mailbox. The registry keeps
 * a peppered hash and the domain, never the address itself, and every later
 * action is authorized by a signature from a device key rather than by a bearer
 * secret — so a leaked database yields no way to publish as somebody.
 */

export type PublisherAuth = { handle: string; deviceId: string; timestamp: number; signature: string }

export const maxCodeAttempts = 5
export const maxChallengesPerHour = 5
export const challengeTtlMs = 10 * 60 * 1000
export const signatureWindowMs = 5 * 60 * 1000

export function normalizeEmail(value: unknown) {
  const email = String(value || '').trim().toLowerCase()
  const match = /^([^\s@]{1,64})@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/.exec(email)
  if (!match) throw Error('Enter a valid email address.')
  return { email, domain: match[2], local: match[1] }
}

export function normalizeHandle(value: unknown, fallback: string) {
  const raw = String(value ?? '').trim().toLowerCase() || fallback
  const handle = raw.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  if (handle.length < 2) throw Error('A publisher handle needs at least two letters, digits, or hyphens.')
  return handle
}

/** The code itself is never stored; this is what the row keeps. */
export async function hashCode(pepper: string, challengeId: string, code: string) {
  const bytes = new TextEncoder().encode(`${pepper}\0${challengeId}\0${code}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashEmail(pepper: string, email: string) {
  const bytes = new TextEncoder().encode(`${pepper}\0email\0${email}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function randomCode() {
  const value = new Uint32Array(1)
  crypto.getRandomValues(value)
  return String(value[0] % 1_000_000).padStart(6, '0')
}

export function randomId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 22)}`
}

/**
 * `Authorization: Shun-Publisher handle=…, device=…, timestamp=…, signature=…`
 * over `<method>\n<path>\n<timestamp>\n<sha256 of the body>`.
 */
export function parsePublisherAuthorization(value: string | null): PublisherAuth | undefined {
  if (!value?.startsWith('Shun-Publisher ')) return undefined
  const fields = new Map<string, string>()
  for (const part of value.slice('Shun-Publisher '.length).split(',')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    fields.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim())
  }
  const handle = fields.get('handle')
  const deviceId = fields.get('device')
  const timestamp = Number(fields.get('timestamp'))
  const signature = fields.get('signature')
  if (!handle || !deviceId || !signature || !Number.isFinite(timestamp)) return undefined
  return { handle, deviceId, timestamp, signature }
}

export function signaturePayload(method: string, path: string, timestamp: number, bodySha256: string) {
  return `${method}\n${path}\n${timestamp}\n${bodySha256}`
}

export function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** True when the signature is fresh, from a live device, and over this request. */
export async function verifyPublisherSignature(db: RegistryDatabase, auth: PublisherAuth, request: { method: string; path: string; body: Uint8Array }) {
  if (Math.abs(Date.now() - auth.timestamp) > signatureWindowMs) return { ok: false as const, error: 'stale_signature' }
  const device = await db.prepare('SELECT id, publisher_handle, public_key, revoked_at FROM devices WHERE id = ?').bind(auth.deviceId).first<{ publisher_handle: string; public_key: string; revoked_at: string | null }>()
  if (!device || device.revoked_at) return { ok: false as const, error: 'unknown_device' }
  if (device.publisher_handle !== auth.handle) return { ok: false as const, error: 'device_mismatch' }
  const payload = signaturePayload(request.method, request.path, auth.timestamp, await sha256Hex(request.body))
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey('raw', base64UrlToBytes(device.public_key), { name: 'Ed25519' }, false, ['verify'])
  } catch {
    return { ok: false as const, error: 'unknown_device' }
  }
  const valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, base64UrlToBytes(auth.signature), new TextEncoder().encode(payload))
  return valid ? { ok: true as const, handle: auth.handle, deviceId: auth.deviceId } : { ok: false as const, error: 'invalid_signature' }
}
