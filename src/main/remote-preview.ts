import { createHash, randomUUID } from 'node:crypto'
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'

/**
 * A dev server on this machine, rendered by the surface on the other end.
 *
 * The page is not sent as pictures. A caller's own web view asks for the page
 * and the resources it references, and each of those is carried over the link
 * and answered here, against the server that is only reachable from here. That
 * is what makes the cost of a preview proportional to what changed rather than
 * to how long somebody looks at it, and it is why the websocket below matters:
 * a dev server's live reload is a websocket, and without it "edit and look"
 * becomes "edit and refresh".
 *
 * Two things this is deliberately not. It is not a general proxy — a session is
 * pinned to the one loopback origin it was opened for, so a controller can
 * reach the dev server this task started and nothing else on this machine. And
 * it is not a stream of frames: a request with no body is one frame, a response
 * head carries its first bytes, and body chunks are coalesced, because every
 * frame spent here is a frame the link's own budget no longer has.
 */

/** One frame's worth of body. Base64 inflates by 4/3, and the link caps a frame well above this. */
export const PREVIEW_FRAME_BYTES = 128 * 1024
/** How long bytes may wait to ride along with the next frame. */
export const PREVIEW_FLUSH_MS = 30
/** A caller that stops reading loses the oldest bytes rather than growing this process. */
export const PREVIEW_QUEUE_BYTES = 2 * 1024 * 1024
export const PREVIEW_REQUEST_BYTES = 4 * 1024 * 1024
export const PREVIEW_TRUNCATION_NOTICE = '\n\n… [output dropped: the controller fell too far behind]\n\n'
export const PREVIEW_SESSION_LIMIT = 4
/** Only the machine running the dev server is reachable, and only over a loopback address. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * An origin whose bytes do not come from an http server.
 *
 * A plugin's interface is files in a package, and a package is not a server —
 * but a web view can only load an http origin, so the tunnel serves it as one.
 * Which scheme means what is the caller's business, because only the caller
 * knows; this only knows that some origins are answered from somewhere else.
 */
export type PreviewAssetSource = {
  matches(origin: string): boolean
  read(origin: string, path: string, headers: Record<string, string>): Promise<{ contentType: string; body: Buffer } | undefined>
}

export type RemotePreviewPush = { taskId: string; sessionId: string; streamId: number } & (
  | { type: 'preview.response'; status: number; statusText: string; headers: IncomingHttpHeaders; data?: string; end?: true }
  | { type: 'preview.data'; data: string; end?: true }
  // A message from a socket that was upgraded, already unwrapped. The surface
  // is never handed a websocket frame: the dev server's wire protocol is
  // terminated at the end that understands it, so nothing above this line has
  // to know one from a page.
  | { type: 'preview.message'; data: string; binary?: true }
  | { type: 'preview.end'; error?: string }
  // What the other end may stop trusting. A preview is only affordable because
  // a resource it already holds is never transferred again, and that is only
  // safe while it is told what changed — so the change is sent, rather than the
  // resource being sent again to prove it did not.
  | { type: 'preview.invalidate'; paths?: string[]; all?: true }
)

/**
 * The text messages a websocket server sends, read off the wire.
 *
 * A live-reload socket is carried as raw bytes, because that is the only way to
 * carry it at all — but what those bytes mean is a change signal, and only an
 * end that understands the dev server's own protocol can turn them into one.
 * This end does: the messages are read here, the paths they name are sent on,
 * and the other end never has to know a websocket from a page.
 */
export type ServerMessage = { data: Buffer; binary: boolean; close?: true }

export function serverFrames() {
  let buffer = Buffer.alloc(0)
  let fragments: Buffer[] = []
  let binary = false
  return (chunk: Buffer): ServerMessage[] => {
    buffer = Buffer.concat([buffer, chunk])
    const messages: ServerMessage[] = []
    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0, opcode = buffer[0] & 0x0f
      // A server never masks. If it looks masked this is not a websocket
      // stream, and reading further would only produce nonsense.
      if ((buffer[1] & 0x80) !== 0) { buffer = Buffer.alloc(0); fragments = []; return messages }
      let length = buffer[1] & 0x7f, offset = 2
      if (length === 126) { if (buffer.length < 4) return messages; length = buffer.readUInt16BE(2); offset = 4 }
      else if (length === 127) { if (buffer.length < 10) return messages; length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
      if (buffer.length < offset + length) return messages
      const payload = buffer.subarray(offset, offset + length)
      buffer = buffer.subarray(offset + length)
      if (opcode === 0x8) { fragments = []; messages.push({ data: Buffer.alloc(0), binary: false, close: true }); return messages }
      if (opcode === 0x9 || opcode === 0xa) continue
      if (opcode === 0x1) binary = false
      if (opcode === 0x2) binary = true
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) fragments.push(Buffer.from(payload))
      if (fin) { if (fragments.length) messages.push({ data: Buffer.concat(fragments), binary }); fragments = [] }
    }
    return messages
  }
}

/** A client frame, masked as the protocol requires of a client. */
export function clientFrame(data: Buffer, binary: boolean, mask = Buffer.from([0x1f, 0x2e, 0x3d, 0x4c])) {
  const length = data.length
  const head = length < 126
    ? Buffer.from([(binary ? 0x82 : 0x81), 0x80 | length])
    : length < 65536
      ? Buffer.concat([Buffer.from([(binary ? 0x82 : 0x81), 0x80 | 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(length); return b })()])
      : Buffer.concat([Buffer.from([(binary ? 0x82 : 0x81), 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b })()])
  const masked = Buffer.from(data)
  for (let index = 0; index < masked.length; index++) masked[index] ^= mask[index % 4]
  return Buffer.concat([head, mask, masked])
}

/**
 * What a live-reload message says is no longer true, in the dev server's own
 * terms. A message this end cannot read is left alone rather than treated as a
 * change: guessing would drop a cache on a message that never named anything,
 * and the transfer that costs is exactly what this mechanism exists to avoid.
 */
export function liveReloadInvalidation(text: string): { paths?: string[]; all?: true } | undefined {
  let message: unknown
  try { message = JSON.parse(text) } catch { return undefined }
  if (!message || typeof message !== 'object') return undefined
  const value = message as { type?: unknown; updates?: unknown }
  if (value.type === 'full-reload') return { all: true }
  if (value.type !== 'update' || !Array.isArray(value.updates)) return undefined
  const paths = new Set<string>()
  for (const update of value.updates) {
    if (!update || typeof update !== 'object') continue
    for (const candidate of [(update as { path?: unknown }).path, (update as { acceptedPath?: unknown }).acceptedPath]) {
      if (typeof candidate === 'string' && candidate.startsWith('/') && candidate.length <= 4_000) paths.add(candidate)
    }
  }
  return paths.size ? { paths: [...paths] } : undefined
}

/**
 * The subprotocol a dev server's live-reload client asks for, so that only that
 * socket is read as a change stream. Any other websocket somebody's app opens
 * is carried and never interpreted.
 */
export function isLiveReloadUpgrade(headers: Record<string, string> | undefined) {
  const requested = headers && (headers['sec-websocket-protocol'] ?? headers['Sec-WebSocket-Protocol'])
  return String(requested ?? '').split(',').map(value => value.trim().toLowerCase()).includes('vite-hmr')
}

type PreviewSession = {
  sessionId: string
  linkId: string
  taskId: string
  origin: string
  /**
   * The authority the caller's own surface answers on, forged onto every
   * request. A dev server hands its client the address it was asked on, so the
   * Host this side sends is what the client will later try to open for live
   * reload — and the address that works is the caller's, not this machine's.
   */
  authority: string
  streams: Map<number, PreviewStream>
}

type PreviewStream = {
  /** Set once a websocket upgrade succeeds: from then on both directions are raw. */
  socket?: Socket
  upstream?: ClientRequest
  output: PreviewOutputStream
  open: boolean
}

/**
 * Bytes on their way to the caller, framed to cost as few frames as possible.
 *
 * A page is a frame per resource, and the link between a caller and this machine
 * is metered in frames as well as bytes, so the shape of a response is chosen
 * here rather than left to the protocol: a small page answers in one frame
 * carrying its head, its body, and the fact that it is complete, and only a
 * response too large to fit pays for more. Bytes may wait one short window to
 * ride along with the next frame, and a caller that stops reading loses the
 * oldest bytes rather than growing this process.
 */
export class PreviewOutputStream {
  readonly #send: (frame: PreviewOutputStreamFrame) => void
  readonly #flushMs: number
  #head?: { status: number; statusText: string; headers: IncomingHttpHeaders }
  #chunks: Buffer[] = []
  #bytes = 0
  #notice = false
  #ended = false
  #timer?: NodeJS.Timeout
  #disposed = false

  constructor(send: (frame: PreviewOutputStreamFrame) => void, options: { flushMs?: number } = {}) {
    this.#send = send
    this.#flushMs = options.flushMs ?? PREVIEW_FLUSH_MS
  }

  /** The response head, held until the first frame carries it. */
  head(head: { status: number; statusText: string; headers: IncomingHttpHeaders }) {
    this.#head = head
    this.#schedule()
  }

  push(chunk: Buffer) {
    if (!chunk.length || this.#disposed) return
    this.#chunks.push(chunk)
    this.#bytes += chunk.length
    if (this.#bytes > PREVIEW_QUEUE_BYTES) {
      // Keep the newest bytes: what a browser is reading now is the end of the
      // response, and the beginning it already has or cannot use.
      let excess = this.#bytes - PREVIEW_QUEUE_BYTES
      while (excess > 0 && this.#chunks.length) {
        const first = this.#chunks[0]
        if (first.length <= excess) { excess -= first.length; this.#bytes -= first.length; this.#chunks.shift() }
        else { this.#chunks[0] = first.subarray(excess); this.#bytes -= excess; excess = 0 }
      }
      this.#notice = true
    }
    this.#schedule()
  }

  /** The response is complete. The last frame carries that, whatever its size. */
  finish() {
    this.#ended = true
    this.flush()
  }

  flush() {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.#disposed) return
    const pending = Buffer.concat(this.#chunks)
    this.#chunks = []
    this.#bytes = 0
    const notice = this.#notice ? Buffer.from(PREVIEW_TRUNCATION_NOTICE) : undefined
    this.#notice = false
    const head = this.#head
    this.#head = undefined
    const body = notice ? Buffer.concat([notice, pending]) : pending
    if (!head && !body.length) {
      if (this.#ended) this.#send({ kind: 'end' })
      return
    }
    const frames = Math.max(1, Math.ceil(body.length / PREVIEW_FRAME_BYTES))
    for (let index = 0; index < frames; index++) {
      const slice = body.subarray(index * PREVIEW_FRAME_BYTES, (index + 1) * PREVIEW_FRAME_BYTES)
      const last = index === frames - 1
      // The head rides the first frame and completion rides the last, so a
      // response that fits in one frame is exactly one frame.
      if (index === 0 && head) this.#send({ kind: 'head', head, data: slice, end: last && this.#ended })
      else this.#send({ kind: 'data', data: slice, end: last && this.#ended })
    }
    if (this.#ended) this.#ended = false
  }

  dispose() {
    this.#disposed = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#chunks = []
    this.#bytes = 0
    this.#notice = false
    this.#head = undefined
  }

  #schedule() {
    if (this.#timer || this.#disposed) return
    this.#timer = setTimeout(() => { this.#timer = undefined; this.flush() }, this.#flushMs)
  }
}

/** One outgoing frame, before it is given the session and stream it belongs to. */
export type PreviewOutputStreamFrame =
  | { kind: 'head'; head: { status: number; statusText: string; headers: IncomingHttpHeaders }; data: Buffer; end: boolean }
  | { kind: 'data'; data: Buffer; end: boolean }
  | { kind: 'end' }

/**
 * Preview sessions a controller opened, keyed by the id it knows them by.
 * A session lives as long as the link that opened it, for the same reason a
 * terminal does: it answers somebody who is looking, and nobody else asked.
 */
export class RemotePreviews {
  readonly #push: (linkId: string, event: RemotePreviewPush) => void
  readonly #sources: PreviewAssetSource[]
  readonly #sessions = new Map<string, PreviewSession>()

  constructor(push: (linkId: string, event: RemotePreviewPush) => void, sources: PreviewAssetSource[] = []) {
    this.#push = push
    this.#sources = sources
  }

  /**
   * Open one origin. The url is untrusted input from the other end, so it is
   * checked here rather than trusted: a loopback address, one scheme, no
   * credentials. Everything the session may reach follows from it, because
   * every later request is resolved against this origin and no other.
   */
  open(input: { linkId: string; taskId: string; url: unknown; authority: unknown }) {
    const requested = String(input.url || '')
    const url = this.#sources.some(source => source.matches(requested)) ? requested : previewOrigin(requested)
    if (!url) throw Error('A preview must point at an http or https address on this machine.')
    const authority = previewAuthority(String(input.authority || ''))
    if (!authority) throw Error('A preview must be opened for a loopback address on the caller.')
    for (const session of [...this.#sessions.values()]) if (session.linkId === input.linkId && session.origin === url && session.authority === authority) return { sessionId: session.sessionId, url: session.origin }
    if ([...this.#sessions.values()].filter(session => session.linkId === input.linkId).length >= PREVIEW_SESSION_LIMIT) throw Error(`At most ${PREVIEW_SESSION_LIMIT} previews may be open at once.`)
    const session: PreviewSession = { sessionId: randomUUID(), linkId: input.linkId, taskId: input.taskId, origin: url, authority, streams: new Map() }
    this.#sessions.set(session.sessionId, session)
    return { sessionId: session.sessionId, url: session.origin }
  }

  /**
   * Start one request. A request with no body is one frame and is already
   * finished; anything with a body says whether more is coming.
   */
  send(input: { sessionId: unknown; streamId: unknown; method?: unknown; url: unknown; headers?: unknown; body?: unknown; more?: unknown }) {
    const session = this.#required(input.sessionId), streamId = previewStreamId(input.streamId)
    if (session.streams.has(streamId)) throw Error('This preview stream is already open.')
    const method = String(input.method || 'GET').toUpperCase()
    // A refusal here is a response, not an exception. The caller is a browser
    // waiting on an answer, and the frame this arrived on is fire-and-forget —
    // so a request refused by throwing is a request the page waits on forever.
    if (!/^[A-Z]{3,10}$/.test(method)) return this.#refuse(session, streamId, 400, 'Bad Request', 'This preview request method is invalid.')
    const path = previewPath(String(input.url || ''))
    if (!path) return this.#refuse(session, streamId, 403, 'Forbidden', 'This preview request is not a path of the origin it was opened for.')
    const headers = previewHeaders(input.headers)
    headers.host = session.authority
    if (wantsUpgrade(input.headers)) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket' }
    // The origin is the whole authorization: a caller names a path, never a host.
    const body = previewBody(input.body)
    const more = input.more === true
    const source = this.#sources.find(candidate => candidate.matches(session.origin))
    if (source) {
      const stream: PreviewStream = { output: this.#streamOutput(session, streamId), open: true }
      session.streams.set(streamId, stream)
      void source.read(session.origin, path, headers).then(
        asset => {
          if (!session.streams.has(streamId)) return
          if (!asset) {
            stream.output.head({ status: 404, statusText: 'Not Found', headers: { 'content-type': 'text/plain' } })
            stream.output.push(Buffer.from('This plugin has no such file.'))
            return
          }
          const etag = `"${createHash('sha256').update(asset.body).digest('hex').slice(0, 32)}"`
          const validator = headers['if-none-match'] || headers['If-None-Match']
          // A package's files are the same bytes until the package changes, and
          // a caller that already has them says which ones it has. Answering
          // that is the difference between reopening an interface and
          // downloading it again — over a link, where it is not free.
          if (validator && validator === etag) {
            stream.output.head({ status: 304, statusText: 'Not Modified', headers: { etag, 'cache-control': 'no-cache' } })
            return
          }
          stream.output.head({
            status: 200,
            statusText: 'OK',
            headers: {
              'content-type': asset.contentType,
              // A plugin's interface changes when the package changes, and a
              // package is data on disk that reloads in place — so what is
              // served must be asked for again, exactly as the origin serves it.
              'cache-control': 'no-cache',
              etag,
            },
          })
          stream.output.push(asset.body)
        },
        () => {
          if (!session.streams.has(streamId)) return
          stream.output.head({ status: 500, statusText: 'Internal Server Error', headers: { 'content-type': 'text/plain' } })
          stream.output.push(Buffer.from('This plugin file could not be read.'))
        },
      ).finally(() => this.#finish(session, streamId))
      return { accepted: true, streamId }
    }
    const target = new URL(session.origin)
    const stream: PreviewStream = { output: this.#streamOutput(session, streamId), open: true }
    session.streams.set(streamId, stream)
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method,
      path,
      headers,
      // The certificate belongs to a dev server on this machine, which is
      // self-signed by construction, and nothing outside this process sees it.
      ...(target.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
    })
    stream.upstream = request
    request.on('upgrade', (response, socket, head) => {
      stream.output.head({ status: 101, statusText: 'Switching Protocols', headers: response.headers })
      // `head` is what the server already sent past the handshake. It belongs
      // to the caller, like every other byte from upstream; writing it back
      // would splice the server's own bytes into its stream and corrupt frames.
      if (head?.length) stream.output.push(Buffer.from(head))
      stream.socket = socket
      // A live-reload socket is the one stream whose payload this end also has
      // to read: what it carries is the change signal the caller caches by, and
      // turning bytes into "this path moved" is the part that needs to know the
      // dev server, which is here and not there.
      const liveReload = isLiveReloadUpgrade(headers)
      const readMessages = serverFrames()
      for (const message of readMessages(Buffer.from(head || Buffer.alloc(0)))) this.#deliver(session, streamId, message, liveReload)
      socket.on('data', chunk => {
        for (const message of readMessages(Buffer.from(chunk))) this.#deliver(session, streamId, message, liveReload)
      })
      socket.on('close', () => this.#finish(session, streamId))
      socket.on('error', () => this.#finish(session, streamId))
    })
    request.on('response', response => {
      stream.output.head({ status: response.statusCode || 502, statusText: response.statusMessage || '', headers: response.headers })
      response.on('data', chunk => stream.output.push(Buffer.from(chunk)))
      response.on('end', () => this.#finish(session, streamId))
      response.on('error', () => this.#finish(session, streamId))
    })
    request.on('error', error => {
      stream.output.dispose()
      this.#push(session.linkId, { type: 'preview.end', taskId: session.taskId, sessionId: session.sessionId, streamId, error: error.message })
      stream.open = false
      session.streams.delete(streamId)
    })
    if (body?.length) request.write(body)
    if (!more) request.end()
    return { accepted: true, streamId }
  }

  /** More of a request body, and whether it is now complete. */
  body(input: { sessionId: unknown; streamId: unknown; data?: unknown; more?: unknown }) {
    const session = this.#required(input.sessionId), stream = this.#stream(session, input.streamId)
    // A socket carries messages, not a body. Writing body bytes into it would
    // splice raw octets into a framed stream, which corrupts everything after.
    if (stream.socket) throw Error('This preview stream is a socket; send a message instead.')
    const chunk = previewBody(input.data)
    if (chunk?.length) stream.upstream?.write(chunk)
    if (input.more !== true) stream.upstream?.end()
    return { accepted: true }
  }

  close(input: { sessionId: unknown }) {
    const session = this.#sessions.get(String(input.sessionId || ''))
    if (!session) return { closed: false }
    this.#drop(session)
    return { closed: true }
  }

  /** Every preview a link opened, dropped when that link goes away. */
  closeLink(linkId: string) {
    for (const session of [...this.#sessions.values()]) if (session.linkId === linkId) this.#drop(session)
  }

  dispose() {
    for (const session of [...this.#sessions.values()]) this.#drop(session)
  }

  #required(value: unknown) {
    const session = this.#sessions.get(String(value || ''))
    if (!session) throw Error('This preview is no longer open.')
    return session
  }

  #stream(session: PreviewSession, value: unknown): PreviewStream {
    const stream = session.streams.get(previewStreamId(value))
    if (!stream) throw Error('This preview stream is no longer open.')
    return stream
  }

  /** One answer, for a request this end will not carry. */
  #refuse(session: PreviewSession, streamId: number, status: number, statusText: string, message: string) {
    const stream: PreviewStream = { output: this.#streamOutput(session, streamId), open: true }
    session.streams.set(streamId, stream)
    stream.output.head({ status, statusText, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    stream.output.push(Buffer.from(message))
    this.#finish(session, streamId)
    return { accepted: false, streamId }
  }

  #finish(session: PreviewSession, streamId: number) {
    const stream = session.streams.get(streamId)
    if (!stream) return
    session.streams.delete(streamId)
    stream.output.finish()
  }

  /**
   * One message off an upgraded socket, handed on as a message.
   *
   * The caller is given what was said, not the bytes that said it, so no
   * surface has to implement somebody else's wire protocol to display a page.
   * A live-reload message is also reduced to what the caller has to stop
   * trusting, which is the half that only the dev server's own client knows
   * how to read.
   */
  #deliver(session: PreviewSession, streamId: number, message: ServerMessage, liveReload: boolean) {
    const base = { taskId: session.taskId, sessionId: session.sessionId, streamId }
    if (message.close) { this.#push(session.linkId, { ...base, type: 'preview.end' }); return }
    this.#push(session.linkId, { ...base, type: 'preview.message', data: message.data.toString('base64url'), ...(message.binary ? { binary: true as const } : {}) })
    if (!liveReload || message.binary) return
    const change = liveReloadInvalidation(message.data.toString('utf8'))
    if (change) this.#push(session.linkId, { ...base, type: 'preview.invalidate', ...change })
  }

  /** One message from the caller, framed for the socket it belongs to. */
  message(input: { sessionId: unknown; streamId: unknown; data?: unknown; binary?: unknown }) {
    const session = this.#required(input.sessionId), stream = this.#stream(session, input.streamId)
    if (!stream.socket) throw Error('This preview stream is not a socket.')
    const data = previewBody(input.data) || Buffer.alloc(0)
    stream.socket.write(clientFrame(data, input.binary === true))
    return { accepted: true }
  }

  #drop(session: PreviewSession) {
    this.#sessions.delete(session.sessionId)
    for (const stream of session.streams.values()) {
      stream.output.dispose()
      try { stream.socket?.destroy() } catch {}
      try { stream.upstream?.end() } catch {}
    }
    session.streams.clear()
  }

  /** Built per stream so a finished stream's timer cannot outlive its session. */
  #streamOutput(session: PreviewSession, streamId: number) {
    return new PreviewOutputStream(frame => {
      if (!this.#sessions.has(session.sessionId)) return
      const base = { taskId: session.taskId, sessionId: session.sessionId, streamId }
      if (frame.kind === 'head') {
        this.#push(session.linkId, {
          ...base, type: 'preview.response', status: frame.head.status, statusText: frame.head.statusText, headers: frame.head.headers,
          ...(frame.data.length ? { data: frame.data.toString('base64url') } : {}),
          ...(frame.end ? { end: true as const } : {}),
        })
        return
      }
      if (frame.kind === 'data') {
        this.#push(session.linkId, { ...base, type: 'preview.data', data: frame.data.toString('base64url'), ...(frame.end ? { end: true as const } : {}) })
        return
      }
      this.#push(session.linkId, { ...base, type: 'preview.end' })
    })
  }
}

/**
 * The one origin a session may reach: a loopback address over http or https,
 * without credentials. Returning undefined is the refusal — everything else
 * about this feature assumes a caller cannot ask for a host.
 */
/**
 * The scheme a plugin's own interface is addressed by, on every surface.
 *
 * The desktop serves it through its own protocol handler and this serves it
 * over a link; one name for one thing is what lets a session be pinned to it
 * without a translation table in between.
 */
export const PLUGIN_ASSET_SCHEME = 'shun-plugin:'


export function previewOrigin(value: string) {
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username || url.password) return undefined
  if (!LOOPBACK.has(url.hostname.toLowerCase())) return undefined
  return `${url.protocol}//${url.host}/`
}

/**
 * What two loopback origins have to agree on to be the same server.
 *
 * `localhost`, `127.0.0.1` and `[::1]` are one machine written three ways, and a
 * dev server hands out whichever spelling it printed. Comparing the strings is
 * comparing spellings, which is how a page the task is serving got refused as
 * one it never started.
 */
export function previewOriginKey(origin: string) {
  try {
    const url = new URL(origin)
    const host = LOOPBACK.has(url.hostname.toLowerCase()) ? '127.0.0.1' : url.hostname.toLowerCase()
    return `${url.protocol}//${host}:${url.port || (url.protocol === 'https:' ? '443' : '80')}/`
  } catch {
    return origin
  }
}

/** A path, never a host: the origin is fixed by the session. */
function previewPath(value: string) {
  if (!value.startsWith('/')) return undefined
  if (value.startsWith('//')) return undefined
  if (value.length > 4_000) return undefined
  // A dev server resolves paths under its own root, but forwarding a traversal
  // is asking it to decide; the caller does not get to ask.
  if (value.split(/[?#]/)[0].split('/').includes('..')) return undefined
  return value
}

/**
 * The authority to present to the dev server, which is the caller's own. It is
 * checked the same way as everything else a caller sends: a loopback address,
 * so forging it can only ever describe a view on the caller's own machine.
 */
export function previewAuthority(value: string) {
  if (!value || value.length > 300) return undefined
  let url: URL
  try { url = new URL(`http://${value}`) } catch { return undefined }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return undefined
  if (!LOOPBACK.has(url.hostname.toLowerCase())) return undefined
  return url.host
}

function previewStreamId(value: unknown) {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 0) throw Error('Preview stream id is invalid.')
  return id
}

function previewBody(value: unknown) {
  if (typeof value !== 'string' || !value) return undefined
  if (value.length > Math.ceil(PREVIEW_REQUEST_BYTES * 4 / 3) + 4) throw Error('A preview request body is too large.')
  return Buffer.from(value, 'base64url')
}

function previewHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const headers: Record<string, string> = {}
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) continue
    const text = Array.isArray(raw) ? raw.join(', ') : String(raw ?? '')
    if (text.length > 8 * 1024) continue
    // Length and framing belong to this hop, not to the one behind it — except
    // the upgrade pair, which is re-established from the caller's intent below.
    if (['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'keep-alive'].includes(name.toLowerCase())) continue
    headers[name] = text
  }
  return headers
}

/**
 * Whether the caller is asking to turn this request into a websocket, which is
 * the whole point of a dev server's live reload. It is read from the raw
 * headers, because the upgrade pair is hop-by-hop and rebuilt here.
 */
function wantsUpgrade(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const upgrade = (value as Record<string, unknown>).upgrade ?? (value as Record<string, unknown>).Upgrade
  return String(upgrade ?? '').toLowerCase() === 'websocket'
}
