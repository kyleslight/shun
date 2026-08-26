import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { HttpsProxyAgent } from 'https-proxy-agent'
import WebSocket, { type RawData } from 'ws'
import type { TaskEventEnvelope } from '../shared'
import { remoteTaskEvent } from '../remote-projection'

export const SHUN_RELAY_URL = 'wss://relay-shun.chiu.one'

type RequestFrame = { id: string; kind: string; payload: Record<string, unknown> }
type ResponseFrame = { id: string; kind: string; payload: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } } }

type RemoteLink = {
  id: string
  channelId: string
  key: string
  mobileIdentityPublicKey: string
  createdAt: number
  sendSequence: number
  receiveSequence: number
}

type RemoteState = {
  version: 2
  identity?: { publicKey: string; privateKey: string }
  links: RemoteLink[]
}

type EncryptedFrame = {
  version: 1
  linkId: string
  messageId: string
  sequence: number
  nonce: string
  ciphertext: string
}

type RemoteEnvelope = {
  version: 1
  messageId: string
  type: 'rpc'
  createdAt: number
  payload: RequestFrame | ResponseFrame | { kind: 'push'; event: unknown }
}

type PairingSession = {
  socket: WebSocket
  channelId: string
  linkChannelId: string
  linkKey: Uint8Array
  ephemeral: { publicKey: string; privateKey: string }
  mobileEphemeralPublicKey?: string
  expiresAt: number
  timer: NodeJS.Timeout
}

type RemoteServiceOptions = {
  stateFile: string
  protect: (value: string) => string
  unprotect: (value: string) => string
  request: (frame: RequestFrame) => Promise<unknown>
  resolveProxy?: (url: string) => Promise<string>
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const remoteDebugEnabled = process.env.SHUN_REMOTE_DEBUG === '1'

function remoteDebug(message: string, details: Record<string, unknown> = {}) {
  if (remoteDebugEnabled) console.info(`[remote-relay] ${message}`, details)
}

export class RemoteRelayService {
  readonly #options: RemoteServiceOptions
  #state: RemoteState = { version: 2, links: [] }
  #pairing?: PairingSession
  #sockets = new Map<string, WebSocket>()
  #reconnects = new Map<string, NodeJS.Timeout>()
  #responses = new Map<string, Promise<ResponseFrame>>()
  #saveQueue: Promise<void> = Promise.resolve()
  #stopped = false

  constructor(options: RemoteServiceOptions) {
    this.#options = options
  }

  async start() {
    await this.#load()
    this.#stopped = false
    remoteDebug('state loaded', { links: this.#state.links.length, sequences: this.#state.links.map(link => ({ id: link.id.slice(0, 8), send: link.sendSequence, receive: link.receiveSequence })) })
    await Promise.allSettled(this.#state.links.map(link => this.#connectLink(link)))
  }

  stop() {
    this.#stopped = true
    this.#closePairing()
    for (const timer of this.#reconnects.values()) clearTimeout(timer)
    this.#reconnects.clear()
    for (const socket of this.#sockets.values()) socket.close()
    this.#sockets.clear()
  }

  pairedDevices() {
    return this.#state.links.map(link => ({ id: link.id, pairedAt: link.createdAt, connected: this.#sockets.get(link.id)?.readyState === WebSocket.OPEN }))
  }

  async pushTaskEvent(event: TaskEventEnvelope) {
    await Promise.all(this.#state.links.map(link => this.#send(link, {
      kind: 'push',
      event: remoteTaskEvent(event),
    })))
  }

  async beginPairing(desktopName: string) {
    this.#closePairing()
    const identity = await this.#identity()
    const ephemeral = x25519Keypair()
    const channelId = b64(randomBytes(24))
    const linkChannelId = b64(randomBytes(24))
    const linkKey = randomBytes(32)
    const expiresAt = Date.now() + 300_000
    const socket = await this.#open(`${SHUN_RELAY_URL}/v1/pair/${channelId}?role=desktop&ttl=300`)
    const timer = setTimeout(() => this.#closePairing(), 300_000)
    this.#pairing = { socket, channelId, linkChannelId, linkKey, ephemeral, expiresAt, timer }
    socket.on('message', data => void this.#pairingMessage(data, desktopName, identity))
    socket.on('close', () => {
      if (this.#pairing?.socket === socket) this.#closePairing(false)
    })
    const qr = {
      version: 1,
      relay: SHUN_RELAY_URL,
      channelId,
      desktopEphemeralPublicKey: ephemeral.publicKey,
      desktopIdentityPublicKey: identity.publicKey,
      expiresAt,
    }
    return { qr: JSON.stringify(qr), expiresAt }
  }

  async #pairingMessage(data: RawData, desktopName: string, identity: { publicKey: string; privateKey: string }) {
    const session = this.#pairing
    if (!session || Date.now() >= session.expiresAt) return this.#closePairing()
    const message = parseJson(data)
    if (message?.type === 'pairing.saved') {
      this.#closePairing()
      return
    }
    if (message?.type === 'pairing.request' && message.protocolVersion === 1 && typeof message.mobileEphemeralPublicKey === 'string') {
      try {
        session.mobileEphemeralPublicKey = message.mobileEphemeralPublicKey
        const grant = {
          type: 'pairing.grant',
          protocolVersion: 1,
          desktopId: identity.publicKey,
          desktopName,
          desktopIdentityPublicKey: identity.publicKey,
          linkChannelId: session.linkChannelId,
          linkKey: b64(session.linkKey),
          issuedAt: Date.now(),
        }
        const encrypted = encryptPairingPayload(pairingKey(session.ephemeral.privateKey, message.mobileEphemeralPublicKey, session.channelId), session.channelId, grant)
        await sendSocket(session.socket, JSON.stringify({ type: 'pairing.grant', ...encrypted }))
      } catch {
        session.mobileEphemeralPublicKey = undefined
      }
      return
    }
    if (message?.type !== 'pairing.ack' || typeof message.nonce !== 'string' || typeof message.ciphertext !== 'string' || !session.mobileEphemeralPublicKey) return
    try {
      const ack = decryptPairingPayload(pairingKey(session.ephemeral.privateKey, session.mobileEphemeralPublicKey, session.channelId), session.channelId, { nonce: message.nonce, ciphertext: message.ciphertext }) as { type?: string; desktopId?: string; mobileIdentityPublicKey?: string }
      if (ack.type !== 'pairing.ack' || ack.desktopId !== identity.publicKey || typeof ack.mobileIdentityPublicKey !== 'string') return
      const link: RemoteLink = {
        id: randomUUID(),
        channelId: session.linkChannelId,
        key: b64(session.linkKey),
        mobileIdentityPublicKey: ack.mobileIdentityPublicKey,
        createdAt: Date.now(),
        sendSequence: 0,
        receiveSequence: 0,
      }
      this.#state.links = [...this.#state.links.filter(item => item.mobileIdentityPublicKey !== link.mobileIdentityPublicKey), link]
      await this.#save()
      await sendSocket(session.socket, JSON.stringify({ type: 'pairing.complete' }))
      await this.#connectLink(link)
    } catch {}
  }

  async #connectLink(link: RemoteLink) {
    if (this.#stopped || this.#sockets.has(link.id)) return
    remoteDebug('connecting', { id: link.id.slice(0, 8) })
    try {
      const socket = await this.#open(`${SHUN_RELAY_URL}/v1/link/${link.channelId}?role=desktop`)
      if (this.#stopped) return socket.close()
      this.#sockets.set(link.id, socket)
      remoteDebug('connected', { id: link.id.slice(0, 8) })
      socket.on('message', data => void this.#linkMessage(link, data))
      socket.on('close', (code, reason) => {
        if (this.#sockets.get(link.id) === socket) this.#sockets.delete(link.id)
        remoteDebug('closed', { id: link.id.slice(0, 8), code, reason: reason.toString() })
        this.#scheduleReconnect(link)
      })
    } catch (error) {
      remoteDebug('connect failed', { id: link.id.slice(0, 8), message: error instanceof Error ? error.message : String(error) })
      this.#scheduleReconnect(link)
    }
  }

  #scheduleReconnect(link: RemoteLink) {
    if (this.#stopped || this.#reconnects.has(link.id)) return
    const timer = setTimeout(() => {
      this.#reconnects.delete(link.id)
      void this.#connectLink(link)
    }, 5_000)
    this.#reconnects.set(link.id, timer)
  }

  async #linkMessage(link: RemoteLink, data: RawData) {
    const frame = parseJson(data) as EncryptedFrame | null
    if (!frame || frame.version !== 1 || frame.linkId !== link.channelId || !Number.isSafeInteger(frame.sequence)) {
      remoteDebug('invalid frame', { id: link.id.slice(0, 8) })
      return
    }
    if (frame.sequence <= link.receiveSequence) {
      remoteDebug('replayed frame', { id: link.id.slice(0, 8), sequence: frame.sequence, receive: link.receiveSequence })
      return
    }
    const envelope = decrypt(link, frame)
    if (!envelope || envelope.type !== 'rpc' || !isRequest(envelope.payload)) {
      remoteDebug('undecryptable frame', { id: link.id.slice(0, 8), sequence: frame.sequence })
      return
    }
    remoteDebug('request received', { id: link.id.slice(0, 8), request: envelope.payload.id, kind: envelope.payload.kind, sequence: frame.sequence })
    link.receiveSequence = frame.sequence
    await this.#save()
    await this.#send(link, await this.#response(link, envelope.payload))
  }

  #response(link: RemoteLink, request: RequestFrame) {
    const key = `${link.id}:${request.id}`
    const existing = this.#responses.get(key)
    if (existing) return existing
    const response = (async (): Promise<ResponseFrame> => {
      try {
        return { id: request.id, kind: request.kind, payload: { ok: true, data: await this.#options.request(request) } }
      } catch (error) {
        const value = error as Error & { code?: string }
        return { id: request.id, kind: request.kind, payload: { ok: false, error: { code: value.code || 'INTERNAL', message: value.message || 'Remote command failed.' } } }
      }
    })()
    this.#responses.set(key, response)
    if (this.#responses.size > 512) this.#responses.delete(this.#responses.keys().next().value!)
    return response
  }

  async #send(link: RemoteLink, payload: ResponseFrame | { kind: 'push'; event: unknown }) {
    const socket = this.#sockets.get(link.id)
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      remoteDebug('send skipped while disconnected', { id: link.id.slice(0, 8), kind: payload.kind })
      return
    }
    const messageId = randomUUID()
    const sequence = link.sendSequence + 1
    const envelope: RemoteEnvelope = { version: 1, messageId, type: 'rpc', createdAt: Date.now(), payload }
    const frame = encrypt(link, envelope, messageId, sequence)
    link.sendSequence = sequence
    await this.#save()
    socket.send(JSON.stringify(frame))
    remoteDebug('frame sent', { id: link.id.slice(0, 8), kind: payload.kind, sequence })
  }

  async #identity() {
    if (!this.#state.identity) {
      this.#state.identity = x25519Keypair()
      await this.#save()
    }
    return this.#state.identity
  }

  async #open(url: string) {
    const proxy = await this.#proxy(url)
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, proxy ? { agent: new HttpsProxyAgent(proxy) } : undefined)
      const timer = setTimeout(() => { socket.terminate(); reject(Error('Relay connection timed out.')) }, 15_000)
      socket.once('open', () => { clearTimeout(timer); resolve(socket) })
      socket.once('error', error => { clearTimeout(timer); reject(error) })
    })
  }

  async #proxy(url: string) {
    const configured = process.env.HTTPS_PROXY || process.env.https_proxy
    if (configured) return configured
    const value = await this.#options.resolveProxy?.(url)
    const match = value?.match(/PROXY\s+([^;\s]+)/i)
    return match ? `http://${match[1]}` : undefined
  }

  #closePairing(closeSocket = true) {
    if (!this.#pairing) return
    clearTimeout(this.#pairing.timer)
    if (closeSocket) this.#pairing.socket.close()
    this.#pairing = undefined
  }

  async #load() {
    try {
      const encrypted = await readFile(this.#options.stateFile, 'utf8')
      const parsed = JSON.parse(this.#options.unprotect(encrypted)) as RemoteState
      this.#state = parsed.version === 2 && Array.isArray(parsed.links) ? parsed : { version: 2, links: [] }
    } catch {
      this.#state = { version: 2, links: [] }
    }
  }

  async #save() {
    const value = this.#options.protect(JSON.stringify(this.#state))
    this.#saveQueue = this.#saveQueue.then(
      () => writeFile(this.#options.stateFile, value, { mode: 0o600 }),
      () => writeFile(this.#options.stateFile, value, { mode: 0o600 }),
    )
    await this.#saveQueue
  }
}

function b64(value: Uint8Array) {
  return Buffer.from(value).toString('base64url')
}

function unb64(value: string) {
  return Buffer.from(value, 'base64url')
}

function parseJson(data: RawData) {
  try { return JSON.parse(data.toString()) as Record<string, unknown> } catch { return null }
}

function sendSocket(socket: WebSocket, value: string) {
  return new Promise<void>((resolve, reject) => socket.send(value, error => error ? reject(error) : resolve()))
}

function isRequest(value: unknown): value is RequestFrame {
  const frame = value as RequestFrame
  return Boolean(frame && typeof frame.id === 'string' && typeof frame.kind === 'string' && frame.payload && typeof frame.payload === 'object')
}

function ad(linkId: string, messageId: string, sequence: number) {
  return textEncoder.encode(`v1|${linkId}|${messageId}|${sequence}`)
}

function encrypt(link: RemoteLink, envelope: RemoteEnvelope, messageId: string, sequence: number): EncryptedFrame {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', linkDirectionKey(link.key, 'desktop-to-mobile'), nonce)
  cipher.setAAD(ad(link.channelId, messageId, sequence))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope)), cipher.final(), cipher.getAuthTag()])
  return { version: 1, linkId: link.channelId, messageId, sequence, nonce: b64(nonce), ciphertext: b64(ciphertext) }
}

function decrypt(link: RemoteLink, frame: EncryptedFrame): RemoteEnvelope | null {
  try {
    const encrypted = unb64(frame.ciphertext)
    const decipher = createDecipheriv('aes-256-gcm', linkDirectionKey(link.key, 'mobile-to-desktop'), unb64(frame.nonce))
    decipher.setAAD(ad(link.channelId, frame.messageId, frame.sequence))
    decipher.setAuthTag(encrypted.subarray(encrypted.length - 16))
    const raw = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()])
    return JSON.parse(textDecoder.decode(raw)) as RemoteEnvelope
  } catch { return null }
}

function linkDirectionKey(key: string, direction: 'mobile-to-desktop' | 'desktop-to-mobile') {
  return Buffer.from(hkdfSync('sha256', unb64(key), Buffer.alloc(0), `shun-link-v1|${direction}`, 32))
}

function x25519Keypair() {
  const pair = generateKeyPairSync('x25519')
  return {
    publicKey: b64(pair.publicKey.export({ type: 'spki', format: 'der' })),
    privateKey: b64(pair.privateKey.export({ type: 'pkcs8', format: 'der' })),
  }
}

function pairingContext(channelId: string) {
  return textEncoder.encode(JSON.stringify({ protocol: 'shun-pair-v1', channelId }))
}

function pairingKey(privateKey: string, peerPublicKey: string, channelId: string) {
  const secret = diffieHellman({
    privateKey: createPrivateKey({ key: unb64(privateKey), type: 'pkcs8', format: 'der' }),
    publicKey: createPublicKey({ key: unb64(peerPublicKey), type: 'spki', format: 'der' }),
  })
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), pairingContext(channelId), 32))
}

function encryptPairingPayload(key: Buffer, channelId: string, value: unknown) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(pairingContext(channelId))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()])
  return { nonce: b64(nonce), ciphertext: b64(ciphertext) }
}

function decryptPairingPayload(key: Buffer, channelId: string, value: { nonce: string; ciphertext: string }) {
  const encrypted = unb64(value.ciphertext)
  const decipher = createDecipheriv('aes-256-gcm', key, unb64(value.nonce))
  decipher.setAAD(pairingContext(channelId))
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16))
  return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString('utf8')) as unknown
}
