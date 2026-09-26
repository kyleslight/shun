import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import WebSocket, { type RawData } from 'ws'
import type { RemoteDesktopConnectionEvent, RemoteDesktopEvent, RemoteDesktopEventBatch, RemoteDesktopState, RemoteTerminalFrame } from '../shared'
import { createRelayDialer, sendWebSocketMessage } from './remote-dial.ts'
import {
  MAX_REMOTE_RELAY_FRAME_BYTES, MAX_WATCHED_TASKS, decryptPairingPayload, decryptRemoteEnvelope, encryptPairingPayload, encryptRemoteEnvelope,
  isEncryptedFrame, isRemotePush, isResponseFrame, isTerminalPush, pairingKey, parsePairingCode, parseRemoteJson, unb64, x25519Keypair,
  type RemoteEnvelope, type RequestFrame,
} from './remote-protocol.ts'
import { remoteReconnectDelay } from './remote-reconnect.ts'

/**
 * What the relay said, in words the person can act on.
 *
 * A pairing channel belongs to one attempt: the other Shun opens it, waits a
 * few minutes, and lets it go. Asking for one that is gone is not a network
 * fault, and the person holding the code does not need to know which relay was
 * dialled or what status code it answered — they need to know whether to paste
 * it again or go back to the other machine for a new one.
 */
export function pairingDialError(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error)
  if (/\b409\b/.test(detail)) return Error('This pairing code is no longer waiting. Show a new one on the other Shun and paste that.')
  if (/\b410\b/.test(detail)) return Error('This pairing code has already been used. Show a new one on the other Shun.')
  if (/timed out/i.test(detail)) return Error('The other Shun did not answer. Check that both machines are online and try a new code.')
  return Error(`Could not reach the pairing service: ${detail}`)
}

/**
 * This Desktop as the controller of another Shun.
 *
 * The peer is the execution node: it owns the tasks, the workspace, and the
 * model run. What that shapes here is that every guarantee has to survive a
 * link that comes and goes — a conversation is watched for minutes, across
 * sleep, Wi-Fi changes, and the peer restarting itself:
 *
 *  - events are applied incrementally, and a sequence gap marks the task for a
 *    snapshot resync instead of rendering a hole;
 *  - a request is not a one-shot write. It keeps its id and is written again
 *    until the peer answers, which stays idempotent because the peer caches
 *    in-flight results by request id, so a dropped frame does not become a
 *    dropped instruction;
 *  - a link that is open but silent is replaced rather than written into,
 *    because an open socket is not evidence that anyone is listening;
 *  - identical reads in flight at the same moment share one response, and
 *    pushed events leave in small batches, so a streaming run does not become
 *    one message per token on the way to the view.
 */
export type RemoteClientLink = {
  id: string
  name: string
  relay: string
  channelId: string
  key: string
  pairedAt: number
  sendSequence: number
  receiveSequence: number
}

type RemoteClientState = {
  version: 1
  identity?: { publicKey: string; privateKey: string }
  links: RemoteClientLink[]
}

type PendingRequest = {
  frame: RequestFrame
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  retry?: ReturnType<typeof setTimeout>
  timeout?: ReturnType<typeof setTimeout>
  retryDelay: number
  nextConnectionRecoveryAt: number
}

type Connection = {
  link: RemoteClientLink
  socket?: WebSocket
  state: RemoteDesktopState['state']
  attempt: number
  reconnect?: ReturnType<typeof setTimeout>
  stability?: ReturnType<typeof setTimeout>
  sequence: number
  pending: Map<string, PendingRequest>
  cursors: Map<string, number>
  stale: Set<string>
  /**
   * The tasks this controller has said it is looking at, once it has said
   * anything at all. `undefined` is not an empty set: it is a controller that
   * has never declared one, and the peer keeps sending it everything.
   */
  watching?: Set<string>
  lastInboundAt: number
  generation: number
  message?: string
}

type RemoteClientOptions = {
  stateFile: string
  protect: (value: string) => string
  unprotect: (value: string) => string
  resolveProxy?: (url: string) => Promise<string>
  onEvent?: (batch: RemoteDesktopEventBatch) => void
  onState?: (event: RemoteDesktopConnectionEvent) => void
  /** Terminal frames bypass batching: they are a live stream, not a conversation. */
  onTerminal?: (frame: RemoteTerminalFrame) => void
}

/** A watched conversation is read-heavy: a stalled read should recover in under a second. */
const READ_KINDS = new Set([
  'tasks.list', 'models.list', 'task.snapshot', 'task.history', 'task.events', 'workspaces.browse',
  'repository.diff', 'repository.snapshot', 'resources.list', 'file.download.info', 'file.download.chunk',
])
const READ_RETRY_MS = 500
const WRITE_RETRY_MS = 1_500
const COMPACT_RETRY_MS = 10_000
const REQUEST_TIMEOUT_MS = 60_000
const COMPACT_TIMEOUT_MS = 135_000
const PROBE_TIMEOUT_MS = 4_000
const STALE_CONNECTION_MS = 12_000
const CONNECTION_RECOVERY_COOLDOWN_MS = 30_000
const CONNECTION_STABLE_MS = 30_000
const SEND_SEQUENCE_RESERVATION = 256
const RECEIVE_CURSOR_DEBOUNCE_MS = 150
const PAIRING_STEP_TIMEOUT_MS = 15_000
/** One batch per frame at most: a view renders far coarser than tokens arrive. */
const EVENT_BATCH_MS = 32
const MAX_EVENTS_PER_BATCH = 512
/** One IPC message leaving for the view is bounded in bytes too, not only in count. */
const MAX_BATCH_BYTES = 512 * 1024
const MAX_LINKS = 16

const remoteDebugEnabled = process.env.SHUN_REMOTE_DEBUG === '1'

function remoteDebug(message: string, details: Record<string, unknown> = {}) {
  if (remoteDebugEnabled) console.info(`[remote-client] ${message}`, details)
}

export class RemoteClientService {
  readonly #options: RemoteClientOptions
  readonly #dialer: ReturnType<typeof createRelayDialer>
  readonly #connections = new Map<string, Connection>()
  readonly #sharedReads = new Map<string, Promise<unknown>>()
  #state: RemoteClientState = { version: 1, links: [] }
  #buffer = new Map<string, { events: RemoteDesktopEvent[]; tasks: Set<string>; bytes: number }>()
  #flush?: ReturnType<typeof setTimeout>
  #cursorFlush?: ReturnType<typeof setTimeout>
  #saveQueue: Promise<void> = Promise.resolve()
  #stopped = true

  constructor(options: RemoteClientOptions) {
    this.#options = options
    this.#dialer = createRelayDialer(options.resolveProxy)
  }

  async start() {
    await this.#load()
    this.#stopped = false
    for (const link of this.#state.links) this.#connection(link)
    await Promise.allSettled([...this.#connections.values()].map(connection => this.#connect(connection)))
    this.#emitStates()
  }

  /**
   * Carry on with no pairings after the stored ones could not be read.
   *
   * A credential this machine can no longer decrypt is not an empty list of
   * pairings, and it must not be treated as one silently — but the person still
   * has to be able to pair again in this session, which a service left stopped
   * by its own failed load would not allow.
   */
  resetStoredState() {
    this.#state = { version: 1, links: [] }
    this.#connections.clear()
    this.#buffer.clear()
    this.#sharedReads.clear()
    this.#stopped = false
    this.#emitStates()
  }

  stop() {
    this.#stopped = true
    if (this.#flush) clearTimeout(this.#flush)
    if (this.#cursorFlush) clearTimeout(this.#cursorFlush)
    this.#flush = undefined
    this.#cursorFlush = undefined
    for (const connection of this.#connections.values()) {
      if (connection.reconnect) clearTimeout(connection.reconnect)
      if (connection.stability) clearTimeout(connection.stability)
      const socket = connection.socket
      connection.socket = undefined
      socket?.close()
      for (const pending of [...connection.pending.values()]) this.#fail(connection, pending, Error('Remote link closed.'))
      connection.state = 'offline'
    }
    this.#connections.clear()
    this.#sharedReads.clear()
    this.#buffer.clear()
    this.#dialer.dispose()
  }

  desktops(): RemoteDesktopState[] {
    return this.#state.links.map(link => this.#describe(this.#connection(link)))
  }

  /**
   * Re-check the links this machine may have slept through. A socket that
   * survives a suspend often looks open and answers nothing, so an open link is
   * probed and replaced when the probe goes unanswered.
   */
  async wake() {
    await Promise.allSettled([...this.#connections.values()].map(async connection => {
      if (connection.state !== 'connected') {
        if (connection.reconnect) clearTimeout(connection.reconnect)
        connection.reconnect = undefined
        connection.attempt = 0
        await this.#connect(connection)
        return
      }
      if (await this.#probe(connection)) return
      remoteDebug('link did not answer a probe', { id: connection.link.id.slice(0, 8) })
      this.#dial(connection, true)
    }))
  }

  async pair(code: string): Promise<RemoteDesktopState> {
    const parsed = parsePairingCode(code)
    const identity = await this.#identity()
    const ephemeral = x25519Keypair()
    const socket = await this.#dialer.open(`${parsed.relay}/v1/pair/${parsed.channelId}?role=mobile`).catch((error: unknown) => {
      throw pairingDialError(error)
    })
    try {
      await sendWebSocketMessage(socket, JSON.stringify({
        type: 'pairing.request',
        protocolVersion: 1,
        mobileEphemeralPublicKey: ephemeral.publicKey,
      }))
      const grantMessage = await nextRelayMessage(socket)
      if (grantMessage?.type !== 'pairing.grant' || typeof grantMessage.nonce !== 'string' || typeof grantMessage.ciphertext !== 'string') {
        throw Error('The other Shun did not answer this pairing code.')
      }
      const ephemeralKey = pairingKey(ephemeral.privateKey, parsed.desktopEphemeralPublicKey, parsed.channelId)
      const grant = decryptPairingPayload(ephemeralKey, parsed.channelId, {
        nonce: grantMessage.nonce,
        ciphertext: grantMessage.ciphertext,
      }) as { type?: string; protocolVersion?: number; desktopId?: string; desktopName?: string; desktopIdentityPublicKey?: string; linkChannelId?: string; linkKey?: string }
      if (grant?.type !== 'pairing.grant' || grant.protocolVersion !== 1 || typeof grant.desktopId !== 'string') {
        throw Error('The other Shun sent an unusable pairing grant.')
      }
      // The code names the identity that must answer it. Without this check the
      // code would only prove that whoever holds the channel can talk to us.
      if (grant.desktopIdentityPublicKey !== parsed.desktopIdentityPublicKey) throw Error('The other Shun did not prove the identity in this code.')
      if (typeof grant.linkChannelId !== 'string' || typeof grant.linkKey !== 'string' || unb64(grant.linkKey).length !== 32) {
        throw Error('The other Shun sent an unusable link.')
      }
      const ack = encryptPairingPayload(ephemeralKey, parsed.channelId, {
        type: 'pairing.ack',
        desktopId: grant.desktopId,
        mobileIdentityPublicKey: identity.publicKey,
        // The execution node lists the controllers paired to it; a list of
        // public keys is not a list of machines a person recognises.
        mobileName: hostname().replace(/\.local$/i, ''),
        receivedAt: Date.now(),
      })
      await sendWebSocketMessage(socket, JSON.stringify({ type: 'pairing.ack', ...ack }))
      const completion = await nextRelayMessage(socket)
      if (completion?.type !== 'pairing.complete') throw Error('The other Shun did not confirm the pairing.')
      const link: RemoteClientLink = {
        id: grant.desktopId,
        name: typeof grant.desktopName === 'string' && grant.desktopName.trim() ? grant.desktopName.trim().slice(0, 120) : grant.desktopId.slice(0, 8),
        relay: parsed.relay,
        channelId: grant.linkChannelId,
        key: grant.linkKey,
        pairedAt: Date.now(),
        sendSequence: 0,
        receiveSequence: 0,
      }
      // Pairing the same Shun again replaces its link rather than adding a
      // second one: the peer keeps one link per controller identity.
      this.#state.links = [...this.#state.links.filter(item => item.id !== link.id), link].slice(-MAX_LINKS)
      await this.#save()
      const previous = this.#connections.get(link.id)
      if (previous) this.#discard(previous, Error('This Shun was paired again.'))
      const connection = this.#connection(link)
      await sendWebSocketMessage(socket, JSON.stringify({ type: 'pairing.saved' }))
      await this.#connect(connection)
      return this.#describe(connection)
    } finally {
      socket.close()
    }
  }

  async unpair(id: string) {
    const link = this.#state.links.find(item => item.id === id)
    if (!link) return false
    const connection = this.#connections.get(id)
    if (connection) {
      this.#connections.delete(id)
      this.#discard(connection, Error('This Shun was disconnected.'))
    }
    this.#state.links = this.#state.links.filter(item => item.id !== id)
    await this.#save()
    return true
  }

  /**
   * Say which tasks this controller is looking at.
   *
   * The peer streams a delta frame every display tick for every task that is
   * running, and a controller showing one conversation reads none of the
   * others. What it does need from the rest is what changes a row — a start, a
   * finish, a rename — which the peer keeps sending regardless.
   *
   * A declaration is state and not a question, so it is written and forgotten
   * rather than tracked as a request, and it is written again on every
   * connection: a peer that reconnected is a peer that may no longer hold it,
   * and the link is what remembers it rather than a window that may be gone.
   */
  async watchTasks(desktopId: string, taskIds: unknown) {
    const connection = this.#connections.get(String(desktopId || ''))
    if (!connection) throw Error('This Shun is no longer paired.')
    const requested = Array.isArray(taskIds) ? taskIds : []
    if (requested.length > MAX_WATCHED_TASKS) throw Error('Too many tasks are being watched at once.')
    const watching = new Set<string>()
    for (const value of requested) {
      const taskId = String(value ?? '')
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(taskId)) throw Error('Invalid task ID.')
      watching.add(taskId)
    }
    // A task this controller has just started looking at is not a stream it has
    // been following. What it saw while the task was nobody's business is not a
    // sequence to continue from — and the view reads the task whole as it opens
    // it — so the join is fresh rather than a jump that looks like a loss.
    for (const taskId of watching) {
      connection.cursors.delete(taskId)
      connection.stale.delete(taskId)
    }
    connection.watching = watching
    // The write is awaited so a caller that has just changed what it is looking
    // at knows the peer has been told, rather than having to guess whether its
    // next frame will be judged against the old answer.
    await this.#declareWatch(connection)
    return { watching: watching.size }
  }

  /** Write the watch list this link is holding, on the link it belongs to. */
  #declareWatch(connection: Connection) {
    const watching = connection.watching
    if (!watching) return Promise.resolve()
    const frame: RequestFrame = { id: randomUUID(), kind: 'task.watch', payload: { taskIds: [...watching] } }
    return this.#writeFrame(connection, frame).catch(() => {
      // A declaration that did not land is carried by the next connection, and
      // until then the peer sends more rather than less: it costs frames, never
      // a conversation.
    })
  }

  /**
   * Send one command to a paired Desktop and wait for its answer.
   *
   * Nothing here fails fast on a link that is momentarily down: the request
   * keeps its id and is written again when the link is back, and only the
   * deadline rejects it. A conversation that reports "offline" while recovery
   * is in flight is worse than one that takes another second.
   */
  request(desktopId: string, kind: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const connection = this.#connections.get(desktopId)
    if (!connection) return Promise.reject(Error('This Shun is no longer paired.'))
    const shared = READ_KINDS.has(kind) ? `${desktopId}:${kind}:${JSON.stringify(payload)}` : undefined
    const inflight = shared ? this.#sharedReads.get(shared) : undefined
    if (inflight) return inflight
    const request = this.#send(connection, kind, payload)
    if (!shared) return request
    this.#sharedReads.set(shared, request)
    void request.then(
      () => { if (this.#sharedReads.get(shared) === request) this.#sharedReads.delete(shared) },
      () => { if (this.#sharedReads.get(shared) === request) this.#sharedReads.delete(shared) },
    )
    return request
  }

  #send(connection: Connection, kind: string, payload: Record<string, unknown>) {
    return new Promise<unknown>((resolve, reject) => {
      const compact = kind === 'task.context.compact'
      const pending: PendingRequest = {
        frame: { id: randomUUID(), kind, payload },
        resolve,
        reject,
        retryDelay: compact ? COMPACT_RETRY_MS : READ_KINDS.has(kind) ? READ_RETRY_MS : WRITE_RETRY_MS,
        nextConnectionRecoveryAt: Date.now() + STALE_CONNECTION_MS,
      }
      pending.timeout = setTimeout(
        () => this.#fail(connection, pending, Error('The other Shun did not answer in time.')),
        compact ? COMPACT_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
      )
      connection.pending.set(pending.frame.id, pending)
      this.#scheduleRetry(connection, pending)
      void this.#writeFrame(connection, pending.frame).catch(() => {})
    })
  }

  #identity() {
    return (async () => {
      if (!this.#state.identity) {
        this.#state.identity = x25519Keypair()
        await this.#save()
      }
      return this.#state.identity
    })()
  }

  #connection(link: RemoteClientLink) {
    const existing = this.#connections.get(link.id)
    if (existing && existing.link === link) return existing
    const connection: Connection = {
      link,
      state: 'connecting',
      attempt: 0,
      sequence: link.sendSequence,
      pending: new Map(),
      cursors: new Map(),
      stale: new Set(),
      lastInboundAt: Date.now(),
      generation: (existing?.generation ?? 0) + 1,
    }
    this.#connections.set(link.id, connection)
    return connection
  }

  #describe(connection: Connection): RemoteDesktopState {
    return {
      id: connection.link.id,
      name: connection.link.name,
      pairedAt: connection.link.pairedAt,
      connected: connection.state === 'connected',
      state: connection.state,
      ...(connection.attempt ? { attempt: connection.attempt } : {}),
      ...(connection.message ? { message: connection.message } : {}),
    }
  }

  #emitStates(resumed = false) {
    for (const connection of this.#connections.values()) this.#options.onState?.({ ...this.#describe(connection), ...(resumed ? { resumed } : {}) })
  }

  #setState(connection: Connection, state: Connection['state'], message?: string, resumed = false) {
    connection.state = state
    connection.message = message
    this.#options.onState?.({ ...this.#describe(connection), ...(resumed ? { resumed } : {}) })
  }

  async #connect(connection: Connection) {
    if (this.#stopped) return
    const generation = ++connection.generation
    const previous = connection.socket
    connection.socket = undefined
    previous?.close()
    connection.stale.clear()
    const resumed = connection.attempt > 0
    this.#setState(connection, 'connecting')
    try {
      const socket = await this.#dialer.open(`${connection.link.relay}/v1/link/${connection.link.channelId}?role=mobile`)
      if (this.#stopped || generation !== connection.generation) return socket.close()
      connection.socket = socket
      connection.lastInboundAt = Date.now()
      remoteDebug('connected', { id: connection.link.id.slice(0, 8), attempt: connection.attempt, resumed })
      connection.stability = setTimeout(() => { connection.stability = undefined; connection.attempt = 0 }, CONNECTION_STABLE_MS)
      socket.on('message', (data: RawData) => this.#inbound(connection, data))
      socket.on('close', () => {
        if (connection.stability) clearTimeout(connection.stability)
        connection.stability = undefined
        if (connection.socket !== socket) return
        connection.socket = undefined
        this.#scheduleReconnect(connection)
      })
      this.#setState(connection, 'connected', undefined, resumed)
      this.#resendPending(connection)
      // The peer may have restarted with no memory of this link, and what this
      // controller is looking at belongs to the link rather than to a window.
      void this.#declareWatch(connection)
    } catch (error) {
      if (generation !== connection.generation) return
      const message = error instanceof Error ? error.message : String(error)
      remoteDebug('connect failed', { id: connection.link.id.slice(0, 8), message })
      this.#scheduleReconnect(connection, message)
    }
  }

  /**
   * A drop that will be retried is not an outage: the link reports `connecting`
   * with its attempt, so a view shows progress instead of an error the person
   * cannot act on.
   */
  #scheduleReconnect(connection: Connection, message?: string) {
    if (this.#stopped) return
    if (connection.reconnect) clearTimeout(connection.reconnect)
    connection.attempt += 1
    const delay = remoteReconnectDelay(connection.attempt - 1)
    this.#setState(connection, 'connecting', message)
    connection.reconnect = setTimeout(() => {
      connection.reconnect = undefined
      void this.#connect(connection)
    }, delay)
  }

  /** Drop the current socket and dial again now, keeping pending requests. */
  #dial(connection: Connection, immediate: boolean) {
    const socket = connection.socket
    connection.socket = undefined
    socket?.close()
    if (immediate) {
      if (connection.reconnect) clearTimeout(connection.reconnect)
      connection.reconnect = undefined
      connection.generation += 1
      void this.#connect(connection)
      return
    }
    this.#scheduleReconnect(connection)
  }

  #inbound(connection: Connection, data: RawData) {
    const frame = parseRemoteJson(data)
    if (!isEncryptedFrame(frame) || frame.linkId !== connection.link.channelId) return
    // Exactly-once: a frame at or below the high-water mark was already applied.
    if (frame.sequence <= connection.link.receiveSequence) {
      remoteDebug('replayed frame', { id: connection.link.id.slice(0, 8), sequence: frame.sequence })
      return
    }
    const envelope = decryptRemoteEnvelope({ linkId: connection.link.channelId, key: connection.link.key }, 'desktop-to-mobile', frame)
    if (!envelope || envelope.type !== 'rpc') return
    connection.lastInboundAt = Date.now()
    connection.link.receiveSequence = frame.sequence
    this.#queueCursorSave()
    if (isResponseFrame(envelope.payload)) {
      const pending = connection.pending.get(envelope.payload.id)
      if (pending) this.#settle(connection, pending, envelope.payload.payload)
      return
    }
    if (!isRemotePush(envelope.payload)) return
    const event = envelope.payload.event as (RemoteDesktopEvent & { type?: string; terminalId?: string }) | undefined
    if (!event) return
    if (isTerminalPush(event)) {
      const frame = event as { type: 'terminal.data' | 'terminal.exit'; taskId?: unknown; terminalId: string; data?: unknown; exitCode?: unknown }
      const taskId = String(frame.taskId || '')
      this.#options.onTerminal?.(frame.type === 'terminal.data'
        ? { type: 'terminal.data', desktopId: connection.link.id, taskId, terminalId: frame.terminalId, data: String(frame.data ?? '') }
        : { type: 'terminal.exit', desktopId: connection.link.id, taskId, terminalId: frame.terminalId, exitCode: Number(frame.exitCode) || 0 })
      return
    }
    if (typeof event.taskId !== 'string' || typeof event.seq !== 'number') return
    const cursor = connection.cursors.get(event.taskId) ?? 0
    // A sequence that was already applied is a duplicate, not a new event: the
    // cursor is what makes a redelivery harmless.
    if (cursor && event.seq <= cursor) {
      remoteDebug('duplicate event', { id: connection.link.id.slice(0, 8), taskId: event.taskId, seq: event.seq })
      return
    }
    // A skipped sequence means the peer dropped pushes while this link was
    // down. The task is marked for a snapshot resync rather than rendered with a
    // hole. A task this controller is not looking at is the one exception: the
    // peer sends it what moves a row and not the text arriving in one, so a jump
    // there is the shape of the stream and not a push that went missing.
    if (cursor && event.seq > cursor + 1 && (!connection.watching || connection.watching.has(event.taskId))) connection.stale.add(event.taskId)
    connection.cursors.set(event.taskId, event.seq)
    const batch = this.#buffer.get(connection.link.id) ?? { events: [], tasks: new Set<string>(), bytes: 0 }
    batch.events.push(event)
    batch.bytes += JSON.stringify(event).length
    this.#buffer.set(connection.link.id, batch)
    if (batch.events.length >= MAX_EVENTS_PER_BATCH || batch.bytes >= MAX_BATCH_BYTES) return this.#flushNow()
    this.#flush ??= setTimeout(() => this.#flushNow(), EVENT_BATCH_MS)
  }

  #flushNow() {
    if (this.#flush) clearTimeout(this.#flush)
    this.#flush = undefined
    const batches = [...this.#buffer.entries()]
    this.#buffer.clear()
    for (const [desktopId, batch] of batches) {
      const connection = this.#connections.get(desktopId)
      const staleTasks = new Set(batch.tasks)
      if (connection) for (const task of connection.stale) staleTasks.add(task)
      connection?.stale.clear()
      this.#options.onEvent?.({ desktopId, events: batch.events, staleTasks: [...staleTasks] })
    }
  }

  async #writeFrame(connection: Connection, frame: RequestFrame) {
    const sequence = connection.sequence + 1
    if (sequence > connection.link.sendSequence) {
      // Persist a block ahead before using it: an ordinary conversation then
      // performs no disk I/O, while a restart always resumes above every
      // sequence that may already have reached the peer.
      connection.link.sendSequence = sequence + SEND_SEQUENCE_RESERVATION - 1
      await this.#save()
    }
    const messageId = randomUUID()
    const envelope: RemoteEnvelope = { version: 1, messageId, type: 'rpc', createdAt: Date.now(), payload: frame }
    const encoded = JSON.stringify(encryptRemoteEnvelope({ linkId: connection.link.channelId, key: connection.link.key }, 'mobile-to-desktop', envelope, messageId, sequence))
    if (Buffer.byteLength(encoded) > MAX_REMOTE_RELAY_FRAME_BYTES) throw Error('This request is too large to send.')
    const socket = connection.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) throw Error('The other Shun is not connected.')
    // A spent sequence is never reused, whether or not this write is delivered.
    connection.sequence = sequence
    await sendWebSocketMessage(socket, encoded)
  }

  #resendPending(connection: Connection) {
    for (const pending of connection.pending.values()) void this.#writeFrame(connection, pending.frame).catch(() => {})
  }

  #scheduleRetry(connection: Connection, pending: PendingRequest) {
    pending.retry = setTimeout(() => {
      if (connection.pending.get(pending.frame.id) !== pending) return
      if (connection.state === 'connected') {
        // A relay accepts a frame whether or not anyone is listening, so an open
        // socket proves nothing. Silence for longer than a round trip makes the
        // link worth replacing rather than writing into again.
        const now = Date.now()
        if (now - connection.lastInboundAt >= STALE_CONNECTION_MS && now >= pending.nextConnectionRecoveryAt) {
          pending.nextConnectionRecoveryAt = now + CONNECTION_RECOVERY_COOLDOWN_MS
          remoteDebug('replacing a silent link', { id: connection.link.id.slice(0, 8), kind: pending.frame.kind })
          this.#dial(connection, true)
        } else {
          void this.#writeFrame(connection, pending.frame).catch(() => {})
        }
      }
      this.#scheduleRetry(connection, pending)
    }, pending.retryDelay)
  }

  #settle(connection: Connection, pending: PendingRequest, payload: { ok: boolean; data?: unknown; error?: { code?: string; message?: string } }) {
    this.#clear(connection, pending)
    if (payload.ok) return pending.resolve(payload.data)
    const failure = Error(payload.error?.message || 'The other Shun refused this command.') as Error & { code?: string }
    failure.code = payload.error?.code || 'INTERNAL'
    pending.reject(failure)
  }

  #fail(connection: Connection, pending: PendingRequest, error: Error) {
    this.#clear(connection, pending)
    pending.reject(error)
  }

  #clear(connection: Connection, pending: PendingRequest) {
    if (pending.retry) clearTimeout(pending.retry)
    if (pending.timeout) clearTimeout(pending.timeout)
    pending.retry = undefined
    pending.timeout = undefined
    if (connection.pending.get(pending.frame.id) === pending) connection.pending.delete(pending.frame.id)
  }

  #discard(connection: Connection, error: Error) {
    if (connection.reconnect) clearTimeout(connection.reconnect)
    if (connection.stability) clearTimeout(connection.stability)
    connection.generation += 1
    connection.reconnect = undefined
    connection.stability = undefined
    const socket = connection.socket
    connection.socket = undefined
    socket?.close()
    for (const pending of [...connection.pending.values()]) this.#fail(connection, pending, error)
  }

  /**
   * One round trip that a live link answers in milliseconds. Any answer counts:
   * the peer accepting a command it does not implement still proves it is there,
   * and a link must not be replaced for refusing a probe.
   */
  #probe(connection: Connection) {
    if (connection.state !== 'connected') return Promise.resolve(false)
    return new Promise<boolean>(resolve => {
      const frame: RequestFrame = { id: randomUUID(), kind: 'system.ping', payload: {} }
      const pending: PendingRequest = {
        frame,
        resolve: () => finish(true),
        reject: () => finish(true),
        retryDelay: WRITE_RETRY_MS,
        nextConnectionRecoveryAt: Number.MAX_SAFE_INTEGER,
      }
      const finish = (alive: boolean) => {
        this.#clear(connection, pending)
        resolve(alive)
      }
      pending.timeout = setTimeout(() => finish(false), PROBE_TIMEOUT_MS)
      connection.pending.set(frame.id, pending)
      this.#scheduleRetry(connection, pending)
      void this.#writeFrame(connection, frame).catch(() => {})
    })
  }

  #queueCursorSave() {
    if (this.#stopped) return
    this.#cursorFlush ??= setTimeout(() => {
      this.#cursorFlush = undefined
      void this.#save().catch(() => {})
    }, RECEIVE_CURSOR_DEBOUNCE_MS)
  }

  async #load() {
    let raw: string
    try {
      raw = await readFile(this.#options.stateFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#state = { version: 1, links: [] }
        return
      }
      throw new Error('Remote client state could not be loaded.', { cause: error })
    }
    // A file that cannot be read is not an empty link list: overwriting it would
    // silently drop every pairing this machine holds.
    let parsed: RemoteClientState
    try {
      parsed = JSON.parse(this.#options.unprotect(raw)) as RemoteClientState
    } catch (error) {
      throw new Error('Remote client state could not be loaded.', { cause: error })
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.links)) throw Error('Remote client state is invalid.')
    this.#state = parsed
  }

  async #save() {
    const value = this.#options.protect(JSON.stringify(this.#state))
    const stateFile = this.#options.stateFile
    const persist = async () => {
      await mkdir(dirname(stateFile), { recursive: true })
      await writeFile(`${stateFile}.tmp`, value, { mode: 0o600 })
      await rename(`${stateFile}.tmp`, stateFile)
    }
    this.#saveQueue = this.#saveQueue.then(persist, persist)
    await this.#saveQueue
  }
}

function nextRelayMessage(socket: WebSocket): Promise<Record<string, unknown> | null> {
  return new Promise(resolve => {
    const finish = (value: Record<string, unknown> | null) => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('close', onClose)
      resolve(value)
    }
    const onMessage = (data: RawData) => finish(parseRemoteJson(data))
    const onClose = () => finish(null)
    const timer = setTimeout(() => finish(null), PAIRING_STEP_TIMEOUT_MS)
    socket.on('message', onMessage)
    socket.on('close', onClose)
  })
}
