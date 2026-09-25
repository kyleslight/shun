import { randomBytes, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import WebSocket, { type RawData } from 'ws'
import type { TaskEventEnvelope } from '../shared'
import { remoteTaskEvent } from '../remote-projection.ts'
import { createRelayDialer, sendWebSocketMessage } from './remote-dial.ts'
import {
  MAX_REMOTE_RELAY_FRAME_BYTES, REMOTE_PAIRING_TTL_MS, b64, boundedRemoteRelayPayload, decryptPairingPayload, decryptRemoteEnvelope,
  encryptPairingPayload, encryptRemoteEnvelope, isEncryptedFrame, isRequestFrame, pairingCodeFor, pairingKey, parseRemoteJson, unb64, x25519Keypair,
  type EncryptedFrame, type RequestFrame, type RemoteEnvelope, type ResponseFrame,
} from './remote-protocol.ts'
import { remoteReconnectDelay } from './remote-reconnect.ts'

export const SHUN_RELAY_URL = 'wss://relay.shunagent.com'

type RemoteLink = {
  id: string
  channelId: string
  key: string
  mobileIdentityPublicKey: string
  /** The controller's own name, when it sends one: a list of public keys is not a list of devices. */
  name?: string
  createdAt: number
  sendSequence: number
  receiveSequence: number
}

type RemoteState = {
  version: 2
  identity?: { publicKey: string; privateKey: string }
  links: RemoteLink[]
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
  /** The link is part of the request: a session belongs to the controller that opened it. */
  request: (frame: RequestFrame, linkId: string) => Promise<unknown>
  resolveProxy?: (url: string) => Promise<string>
  /** Only a local or test deployment changes this; production is the Shun relay. */
  relayUrl?: string
  onLinkClosed?: (linkId: string) => void
}

const remoteDebugEnabled = process.env.SHUN_REMOTE_DEBUG === '1'
const SEND_SEQUENCE_RESERVATION = 256
const REMOTE_CONNECTION_STABLE_MS = 30_000

function remoteDebug(message: string, details: Record<string, unknown> = {}) {
  if (remoteDebugEnabled) console.info(`[remote-relay] ${message}`, details)
}

export class RemoteRelayService {
  readonly #options: RemoteServiceOptions
  #state: RemoteState = { version: 2, links: [] }
  #pairing?: PairingSession
  #sockets = new Map<string, WebSocket>()
  #reconnects = new Map<string, NodeJS.Timeout>()
  #reconnectAttempts = new Map<string, number>()
  #stabilityTimers = new Map<string, NodeJS.Timeout>()
  #responses = new Map<string, Promise<ResponseFrame>>()
  #sendQueues = new Map<string, Promise<void>>()
  #sentSequences = new Map<string, number>()
  #saveQueue: Promise<void> = Promise.resolve()
  #recoveredFromBackup = false
  #stopped = false
  readonly #relayUrl: string
  readonly #dialer: ReturnType<typeof createRelayDialer>

  constructor(options: RemoteServiceOptions) {
    this.#options = options
    this.#relayUrl = options.relayUrl || SHUN_RELAY_URL
    this.#dialer = createRelayDialer(options.resolveProxy)
  }

  async start() {
    await this.#load()
    this.#stopped = false
    remoteDebug('state loaded', { links: this.#state.links.length, sequences: this.#state.links.map(link => ({ id: link.id.slice(0, 8), send: link.sendSequence, receive: link.receiveSequence })) })
    await Promise.allSettled(this.#state.links.map(link => this.#connectLink(link)))
  }

  /** Carry on with no links after the stored ones could not be read, so a new pairing still lands. */
  resetStoredState() {
    this.#state = { version: 2, links: [] }
    this.#stopped = false
  }

  stop() {
    this.#stopped = true
    this.#closePairing()
    for (const timer of this.#reconnects.values()) clearTimeout(timer)
    this.#reconnects.clear()
    this.#reconnectAttempts.clear()
    for (const timer of this.#stabilityTimers.values()) clearTimeout(timer)
    this.#stabilityTimers.clear()
    for (const socket of this.#sockets.values()) socket.close()
    this.#sockets.clear()
    this.#dialer.dispose()
    this.#sendQueues.clear()
    this.#sentSequences.clear()
  }

  pairedDevices() {
    return this.#state.links.map(link => ({
      id: link.id,
      name: link.name,
      pairedAt: link.createdAt,
      connected: this.#sockets.get(link.id)?.readyState === WebSocket.OPEN,
    }))
  }

  /**
   * Let one paired device go.
   *
   * A pairing is a door this machine leaves open, so forgetting one has to close
   * the socket that door belongs to as well — and the next frame was already
   * scheduled, so the reconnect has to be cancelled rather than left to dial a
   * channel nobody holds.
   */
  async forgetDevice(linkId: string) {
    const link = this.#state.links.find(item => item.id === linkId)
    if (!link) return false
    this.#state.links = this.#state.links.filter(item => item.id !== linkId)
    const reconnect = this.#reconnects.get(linkId)
    if (reconnect) clearTimeout(reconnect)
    this.#reconnects.delete(linkId)
    this.#reconnectAttempts.delete(linkId)
    const stability = this.#stabilityTimers.get(linkId)
    if (stability) clearTimeout(stability)
    this.#stabilityTimers.delete(linkId)
    this.#sockets.get(linkId)?.close()
    this.#sockets.delete(linkId)
    this.#sentSequences.delete(linkId)
    await this.#save()
    return true
  }

  async pushTaskEvent(event: TaskEventEnvelope) {
    await Promise.all(this.#state.links.map(link => this.#send(link, {
      kind: 'push',
      event: remoteTaskEvent(event),
    })))
  }

  /**
   * A push that belongs to one controller, such as the output of a terminal it
   * opened. It goes to that link only: another controller never asked for it,
   * and a session is not shared. A link that is down drops the frame rather
   * than queueing it — the peer resyncs what it can see and asks again.
   */
  async pushToLink(linkId: string, event: unknown) {
    const link = this.#state.links.find(item => item.id === linkId)
    if (!link) return
    await this.#send(link, { kind: 'push', event })
  }

  async beginPairing(desktopName: string) {
    this.#closePairing()
    const identity = await this.#identity()
    const ephemeral = x25519Keypair()
    const channelId = b64(randomBytes(24))
    const linkChannelId = b64(randomBytes(24))
    const linkKey = randomBytes(32)
    const expiresAt = Date.now() + REMOTE_PAIRING_TTL_MS
    const relay = this.#relayUrl
    const socket = await this.#dialer.open(`${relay}/v1/pair/${channelId}?role=desktop&ttl=300`)
    const timer = setTimeout(() => this.#closePairing(), REMOTE_PAIRING_TTL_MS)
    this.#pairing = { socket, channelId, linkChannelId, linkKey, ephemeral, expiresAt, timer }
    socket.on('message', data => void this.#pairingMessage(data, desktopName, identity))
    socket.on('close', () => {
      if (this.#pairing?.socket === socket) this.#closePairing(false)
    })
    const code = pairingCodeFor({ relay, channelId, ephemeralPublicKey: ephemeral.publicKey, identityPublicKey: identity.publicKey, expiresAt })
    return { qr: JSON.stringify(code), expiresAt }
  }

  async #pairingMessage(data: RawData, desktopName: string, identity: { publicKey: string; privateKey: string }) {
    const session = this.#pairing
    if (!session || Date.now() >= session.expiresAt) return this.#closePairing()
    const message = parseRemoteJson(data)
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
        await sendWebSocketMessage(session.socket, JSON.stringify({ type: 'pairing.grant', ...encrypted }))
      } catch {
        session.mobileEphemeralPublicKey = undefined
      }
      return
    }
    if (message?.type !== 'pairing.ack' || typeof message.nonce !== 'string' || typeof message.ciphertext !== 'string' || !session.mobileEphemeralPublicKey) return
    try {
      const ack = decryptPairingPayload(pairingKey(session.ephemeral.privateKey, session.mobileEphemeralPublicKey, session.channelId), session.channelId, { nonce: message.nonce, ciphertext: message.ciphertext }) as { type?: string; desktopId?: string; mobileIdentityPublicKey?: string; mobileName?: string }
      if (ack.type !== 'pairing.ack' || ack.desktopId !== identity.publicKey || typeof ack.mobileIdentityPublicKey !== 'string') return
      const link: RemoteLink = {
        id: randomUUID(),
        channelId: session.linkChannelId,
        key: b64(session.linkKey),
        mobileIdentityPublicKey: ack.mobileIdentityPublicKey,
        ...(typeof ack.mobileName === 'string' && ack.mobileName.trim() ? { name: ack.mobileName.trim().slice(0, 120) } : {}),
        createdAt: Date.now(),
        sendSequence: 0,
        receiveSequence: 0,
      }
      this.#state.links = [...this.#state.links.filter(item => item.mobileIdentityPublicKey !== link.mobileIdentityPublicKey), link]
      await this.#save()
      await sendWebSocketMessage(session.socket, JSON.stringify({ type: 'pairing.complete' }))
      await this.#connectLink(link)
    } catch {}
  }

  async #connectLink(link: RemoteLink) {
    if (this.#stopped || this.#sockets.has(link.id)) return
    remoteDebug('connecting', { id: link.id.slice(0, 8) })
    try {
      const socket = await this.#dialer.open(`${this.#relayUrl}/v1/link/${link.channelId}?role=desktop`)
      if (this.#stopped) return socket.close()
      this.#sockets.set(link.id, socket)
      const stabilityTimer = setTimeout(() => this.#markStable(link.id), REMOTE_CONNECTION_STABLE_MS)
      this.#stabilityTimers.set(link.id, stabilityTimer)
      remoteDebug('connected', { id: link.id.slice(0, 8) })
      socket.on('message', data => void this.#linkMessage(link, data))
      socket.on('close', (code, reason) => {
        const timer = this.#stabilityTimers.get(link.id)
        if (timer) clearTimeout(timer)
        this.#stabilityTimers.delete(link.id)
        if (this.#sockets.get(link.id) === socket) this.#sockets.delete(link.id)
        remoteDebug('closed', { id: link.id.slice(0, 8), code, reason: reason.toString() })
        // Whatever this controller owned — a terminal it opened — does not keep
        // running for a link nobody holds.
        this.#options.onLinkClosed?.(link.id)
        this.#scheduleReconnect(link)
      })
    } catch (error) {
      remoteDebug('connect failed', { id: link.id.slice(0, 8), message: error instanceof Error ? error.message : String(error) })
      this.#scheduleReconnect(link)
    }
  }

  #scheduleReconnect(link: RemoteLink) {
    if (this.#stopped || this.#reconnects.has(link.id)) return
    const attempt = this.#reconnectAttempts.get(link.id) ?? 0
    const delay = remoteReconnectDelay(attempt)
    this.#reconnectAttempts.set(link.id, attempt + 1)
    const timer = setTimeout(() => {
      this.#reconnects.delete(link.id)
      void this.#connectLink(link)
    }, delay)
    this.#reconnects.set(link.id, timer)
  }

  #markStable(linkId: string) {
    const timer = this.#stabilityTimers.get(linkId)
    if (timer) clearTimeout(timer)
    this.#stabilityTimers.delete(linkId)
    this.#reconnectAttempts.delete(linkId)
  }

  async #linkMessage(link: RemoteLink, data: RawData) {
    this.#markStable(link.id)
    const frame = parseRemoteJson(data) as EncryptedFrame | null
    if (!frame || frame.version !== 1 || frame.linkId !== link.channelId || !Number.isSafeInteger(frame.sequence)) {
      remoteDebug('invalid frame', { id: link.id.slice(0, 8) })
      return
    }
    if (frame.sequence <= link.receiveSequence) {
      remoteDebug('replayed frame', { id: link.id.slice(0, 8), sequence: frame.sequence, receive: link.receiveSequence })
      return
    }
    const envelope = decryptRemoteEnvelope({ linkId: link.channelId, key: link.key }, 'mobile-to-desktop', frame)
    if (!envelope || envelope.type !== 'rpc' || !isRequestFrame(envelope.payload)) {
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
        return { id: request.id, kind: request.kind, payload: { ok: true, data: await this.#options.request(request, link.id) } }
      } catch (error) {
        const value = error as Error & { code?: string }
        return { id: request.id, kind: request.kind, payload: { ok: false, error: { code: value.code || 'INTERNAL', message: value.message || 'Remote command failed.' } } }
      }
    })()
    this.#responses.set(key, response)
    if (this.#responses.size > 512) this.#responses.delete(this.#responses.keys().next().value!)
    return response
  }

  #send(link: RemoteLink, payload: ResponseFrame | { kind: 'push'; event: unknown }) {
    const prior = this.#sendQueues.get(link.id) || Promise.resolve()
    const operation = prior.catch(() => {}).then(() => this.#write(link, payload))
    this.#sendQueues.set(link.id, operation)
    void operation.finally(() => {
      if (this.#sendQueues.get(link.id) === operation) this.#sendQueues.delete(link.id)
    }).catch(() => {})
    return operation
  }

  async #write(link: RemoteLink, payload: ResponseFrame | { kind: 'push'; event: unknown }) {
    const socket = this.#sockets.get(link.id)
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      remoteDebug('send skipped while disconnected', { id: link.id.slice(0, 8), kind: payload.kind })
      return
    }
    const sentSequence = this.#sentSequences.get(link.id) ?? link.sendSequence
    const sequence = sentSequence + 1
    if (sequence > link.sendSequence) {
      // Persist a block ahead before using it. Normal streaming then performs
      // no disk I/O, while a restart always resumes above every sequence that
      // may already have reached the mobile client.
      link.sendSequence = sequence + SEND_SEQUENCE_RESERVATION - 1
      await this.#save()
    }
    const messageId = randomUUID()
    let outbound = payload
    let envelope: RemoteEnvelope = { version: 1, messageId, type: 'rpc', createdAt: Date.now(), payload: outbound }
    let encoded = JSON.stringify(encryptRemoteEnvelope({ linkId: link.channelId, key: link.key }, 'desktop-to-mobile', envelope, messageId, sequence))
    const bounded = boundedRemoteRelayPayload(payload, Buffer.byteLength(encoded))
    if (!bounded) {
      remoteDebug('oversized push skipped', { id: link.id.slice(0, 8), kind: payload.kind, bytes: Buffer.byteLength(encoded) })
      return
    }
    if (bounded !== payload) {
      outbound = bounded
      envelope = { version: 1, messageId, type: 'rpc', createdAt: Date.now(), payload: outbound }
      encoded = JSON.stringify(encryptRemoteEnvelope({ linkId: link.channelId, key: link.key }, 'desktop-to-mobile', envelope, messageId, sequence))
      remoteDebug('oversized response replaced', { id: link.id.slice(0, 8), kind: payload.kind })
    }
    socket.send(encoded)
    this.#sentSequences.set(link.id, sequence)
    remoteDebug('frame sent', { id: link.id.slice(0, 8), kind: payload.kind, sequence })
  }

  async #identity() {
    if (!this.#state.identity) {
      this.#state.identity = x25519Keypair()
      await this.#save()
    }
    return this.#state.identity
  }

  #closePairing(closeSocket = true) {
    if (!this.#pairing) return
    clearTimeout(this.#pairing.timer)
    if (closeSocket) this.#pairing.socket.close()
    this.#pairing = undefined
  }

  async #load() {
    let primaryError: unknown
    try {
      const state = await this.#readState(this.#options.stateFile)
      if (state) {
        this.#state = state
        return
      }
    } catch (error) {
      primaryError = error
    }

    const backupFile = `${this.#options.stateFile}.backup`
    try {
      const backup = await this.#readState(backupFile)
      if (backup) {
        this.#state = backup
        this.#recoveredFromBackup = true
        remoteDebug('state recovered from backup')
        return
      }
    } catch (backupError) {
      throw new Error('Remote pairing state and its backup could not be loaded.', { cause: backupError })
    }

    if (primaryError) throw new Error('Remote pairing state could not be loaded.', { cause: primaryError })
    this.#state = { version: 2, links: [] }
  }

  async #readState(path: string) {
    let encrypted: string
    try {
      encrypted = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const parsed = JSON.parse(this.#options.unprotect(encrypted)) as RemoteState
    if (parsed.version !== 2 || !Array.isArray(parsed.links)) throw Error('Invalid remote pairing state.')
    return parsed
  }

  async #save() {
    const value = this.#options.protect(JSON.stringify(this.#state))
    const stateFile = this.#options.stateFile
    const backupFile = `${stateFile}.backup`
    const tempFile = `${stateFile}.tmp`
    const persist = async () => {
      await mkdir(dirname(stateFile), { recursive: true })
      await writeFile(tempFile, value, { mode: 0o600 })
      if (!this.#recoveredFromBackup) {
        try {
          await copyFile(stateFile, backupFile)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      await rename(tempFile, stateFile)
      this.#recoveredFromBackup = false
    }
    this.#saveQueue = this.#saveQueue.then(persist, persist)
    await this.#saveQueue
  }
}
