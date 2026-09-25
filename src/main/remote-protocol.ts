import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'

/**
 * The wire contract both ends of a Remote link implement: the Desktop that
 * executes, and the controller that drives it — the phone app, or another
 * Desktop's Remote client. The relay forwards these frames opaquely, so the
 * crypto, the framing, and the pairing handshake live here once rather than
 * once per side, where they drift apart silently and only a real pairing
 * reveals it.
 *
 * `desktop` and `mobile` are protocol constants, not deployment facts:
 * `desktop` is the execution node, `mobile` is the controller. They name relay
 * roles, HKDF inputs, and pairing message fields, so renaming one breaks every
 * link that already exists — including the ones a phone is holding.
 */
export type RequestFrame = { id: string; kind: string; payload: Record<string, unknown> }
export type ResponseFrame = {
  id: string
  kind: string
  payload: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }
}
export type RemotePush = { kind: 'push'; event: unknown }
export type RemoteEnvelope = {
  version: 1
  messageId: string
  type: 'rpc'
  createdAt: number
  payload: RequestFrame | ResponseFrame | RemotePush
}
export type EncryptedFrame = {
  version: 1
  linkId: string
  messageId: string
  sequence: number
  nonce: string
  ciphertext: string
}
export type PairingCiphertext = { nonce: string; ciphertext: string }
export type RemoteDirection = 'desktop-to-mobile' | 'mobile-to-desktop'

/** What the execution node hands the controller: no secret is ever in here. */
export type PairingCode = {
  version: 1
  relay: string
  channelId: string
  desktopEphemeralPublicKey: string
  desktopIdentityPublicKey: string
  expiresAt: number
}

export const MAX_REMOTE_RELAY_FRAME_BYTES = 900 * 1024
export const REMOTE_PAIRING_TTL_MS = 300_000

const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]{24,128}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const MAX_PAIRING_CODE_CHARS = 2048
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function b64(value: Uint8Array) {
  return Buffer.from(value).toString('base64url')
}

export function unb64(value: string) {
  return Buffer.from(value, 'base64url')
}

export function x25519Keypair() {
  const pair = generateKeyPairSync('x25519')
  return {
    publicKey: b64(pair.publicKey.export({ type: 'spki', format: 'der' })),
    privateKey: b64(pair.privateKey.export({ type: 'pkcs8', format: 'der' })),
  }
}

export function pairingCodeFor(input: { relay: string; channelId: string; ephemeralPublicKey: string; identityPublicKey: string; expiresAt: number }): PairingCode {
  return {
    version: 1,
    relay: input.relay,
    channelId: input.channelId,
    desktopEphemeralPublicKey: input.ephemeralPublicKey,
    desktopIdentityPublicKey: input.identityPublicKey,
    expiresAt: input.expiresAt,
  }
}

/**
 * A pairing code is untrusted input: it arrives pasted from another machine, so
 * every field is validated before anything is derived or dialled. Plaintext
 * `ws:` is accepted only for a loopback relay, which is how two Shun instances
 * on one machine, or the integration suite, pair without a public relay.
 */
export function parsePairingCode(text: string): PairingCode {
  if (!text || text.length > MAX_PAIRING_CODE_CHARS) throw Error('This pairing code is not valid.')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw Error('This pairing code is not valid.')
  }
  const code = value as Partial<Record<keyof PairingCode, unknown>>
  if (code.version !== 1) throw Error('This pairing code was made by a different version of Shun.')
  const relay = typeof code.relay === 'string' ? code.relay.trim().replace(/\/+$/, '') : ''
  if (!relay || relay.length > 200) throw Error('This pairing code names no usable relay.')
  let parsed: URL
  try {
    parsed = new URL(relay)
  } catch {
    throw Error('This pairing code names no usable relay.')
  }
  if (!/^wss?:$/.test(parsed.protocol)) throw Error('This pairing code names no usable relay.')
  if (parsed.protocol === 'ws:' && !isLoopbackHost(parsed.hostname)) throw Error('This pairing code asks for an unencrypted relay.')
  if (!CHANNEL_ID_PATTERN.test(String(code.channelId ?? ''))) throw Error('This pairing code is not valid.')
  if (!isPublicKey(code.desktopEphemeralPublicKey) || !isPublicKey(code.desktopIdentityPublicKey)) throw Error('This pairing code is not valid.')
  if (typeof code.expiresAt !== 'number' || !Number.isFinite(code.expiresAt)) throw Error('This pairing code is not valid.')
  if (code.expiresAt <= Date.now()) throw Error('This pairing code has expired. Show a new one on the other Shun.')
  return {
    version: 1,
    relay,
    channelId: code.channelId as string,
    desktopEphemeralPublicKey: code.desktopEphemeralPublicKey as string,
    desktopIdentityPublicKey: code.desktopIdentityPublicKey as string,
    expiresAt: code.expiresAt,
  }
}

function isLoopbackHost(host: string) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

function isPublicKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 40 && value.length <= 160 && BASE64URL_PATTERN.test(value)
}

export function pairingContext(channelId: string) {
  return textEncoder.encode(JSON.stringify({ protocol: 'shun-pair-v1', channelId }))
}

export function pairingKey(privateKey: string, peerPublicKey: string, channelId: string) {
  const secret = diffieHellman({
    privateKey: createPrivateKey({ key: unb64(privateKey), type: 'pkcs8', format: 'der' }),
    publicKey: createPublicKey({ key: unb64(peerPublicKey), type: 'spki', format: 'der' }),
  })
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), pairingContext(channelId), 32))
}

export function encryptPairingPayload(key: Buffer, channelId: string, value: unknown): PairingCiphertext {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(pairingContext(channelId))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()])
  return { nonce: b64(nonce), ciphertext: b64(ciphertext) }
}

export function decryptPairingPayload(key: Buffer, channelId: string, value: PairingCiphertext): unknown {
  const encrypted = unb64(value.ciphertext)
  const decipher = createDecipheriv('aes-256-gcm', key, unb64(value.nonce))
  decipher.setAAD(pairingContext(channelId))
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16))
  return JSON.parse(textDecoder.decode(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]))) as unknown
}

export function linkDirectionKey(key: string, direction: RemoteDirection) {
  return Buffer.from(hkdfSync('sha256', unb64(key), Buffer.alloc(0), `shun-link-v1|${direction}`, 32))
}

/** The outer frame metadata is authenticated, so it can never be rewritten in flight. */
export function frameAdditionalData(linkId: string, messageId: string, sequence: number) {
  return textEncoder.encode(`v1|${linkId}|${messageId}|${sequence}`)
}

export function encryptRemoteEnvelope(input: { linkId: string; key: string }, direction: RemoteDirection, envelope: RemoteEnvelope, messageId: string, sequence: number): EncryptedFrame {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', linkDirectionKey(input.key, direction), nonce)
  cipher.setAAD(frameAdditionalData(input.linkId, messageId, sequence))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope)), cipher.final(), cipher.getAuthTag()])
  return { version: 1, linkId: input.linkId, messageId, sequence, nonce: b64(nonce), ciphertext: b64(ciphertext) }
}

export function decryptRemoteEnvelope(input: { linkId: string; key: string }, direction: RemoteDirection, frame: EncryptedFrame): RemoteEnvelope | null {
  try {
    const encrypted = unb64(frame.ciphertext)
    const decipher = createDecipheriv('aes-256-gcm', linkDirectionKey(input.key, direction), unb64(frame.nonce))
    decipher.setAAD(frameAdditionalData(input.linkId, frame.messageId, frame.sequence))
    decipher.setAuthTag(encrypted.subarray(encrypted.length - 16))
    const raw = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()])
    return JSON.parse(textDecoder.decode(raw)) as RemoteEnvelope
  } catch {
    return null
  }
}

export function isEncryptedFrame(value: unknown): value is EncryptedFrame {
  const frame = value as EncryptedFrame
  return Boolean(frame
    && frame.version === 1
    && typeof frame.linkId === 'string'
    && typeof frame.messageId === 'string'
    && Number.isSafeInteger(frame.sequence)
    && typeof frame.nonce === 'string'
    && typeof frame.ciphertext === 'string')
}

export function isRequestFrame(value: unknown): value is RequestFrame {
  const frame = value as RequestFrame
  return Boolean(frame && typeof frame.id === 'string' && typeof frame.kind === 'string' && frame.payload && typeof frame.payload === 'object')
}

export function isResponseFrame(value: unknown): value is ResponseFrame {
  const frame = value as ResponseFrame
  const payload = frame?.payload as ResponseFrame['payload'] | undefined
  return Boolean(frame && typeof frame.id === 'string' && typeof frame.kind === 'string' && payload && typeof payload === 'object' && ('ok' in payload))
}

export function isRemotePush(value: unknown): value is RemotePush {
  const push = value as RemotePush
  return Boolean(push && push.kind === 'push' && 'event' in push)
}

/**
 * Terminal output carries no task sequence: it is a live stream, and the
 * controller renders it as it arrives rather than replaying it in order.
 */
export function isTerminalPush(value: unknown) {
  const event = value as { type?: unknown; terminalId?: unknown } | undefined
  return Boolean(event && (event.type === 'terminal.data' || event.type === 'terminal.exit') && typeof event.terminalId === 'string')
}

export function parseRemoteJson(data: unknown): Record<string, unknown> | null {
  try {
    if (typeof data === 'string') return JSON.parse(data) as Record<string, unknown>
    if (Buffer.isBuffer(data)) return JSON.parse(data.toString('utf8')) as Record<string, unknown>
    if (data instanceof ArrayBuffer) return JSON.parse(textDecoder.decode(new Uint8Array(data))) as Record<string, unknown>
    if (Array.isArray(data)) return JSON.parse(Buffer.concat(data as Buffer[]).toString('utf8')) as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

/**
 * The relay drops a frame larger than 1 MiB, which would take the link with it.
 * A response that no longer fits becomes a small error naming the reason, and a
 * push that no longer fits is skipped: the controller resyncs from a snapshot.
 */
export function boundedRemoteRelayPayload(payload: ResponseFrame | RemotePush, encodedBytes: number): ResponseFrame | RemotePush | null {
  if (encodedBytes <= MAX_REMOTE_RELAY_FRAME_BYTES) return payload
  if (!('id' in payload)) return null
  return {
    id: payload.id,
    kind: payload.kind,
    payload: { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Remote response exceeded the transport limit.' } },
  }
}
