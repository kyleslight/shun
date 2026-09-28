import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { PREVIEW_FRAME_BYTES, PREVIEW_REQUEST_BYTES } from './remote-preview.ts'
import type { RemotePreviewFrame, RemotePreviewHandle, RemotePreviewOpenInput } from '../shared'

/**
 * The controller's half of a preview tunnel.
 *
 * The machine that has the files serves them; this end has to hand a surface an
 * address it can load, and the only address a web view can load is one this
 * machine answers. So a view opens at a loopback origin of ours and every
 * request that arrives there leaves as a frame and comes back as an answer. The
 * page is the package's own file, byte for byte — which is what makes it the
 * same interface on both machines rather than a second implementation of one.
 *
 * What makes it affordable is that nothing is sent twice. The serving end
 * answers a package file with an ETag, so a copy this end already holds is
 * revalidated instead of transferred: what a second open costs is a 304 with no
 * body, and what a live call costs is the plugin's own small request. Nothing
 * here draws anything, so the cost does not grow with how long somebody looks.
 */

/** Mirror of the serving end's cap: the same link should not hold more than it will answer. */
export const PREVIEW_SESSION_LIMIT = 4
/** One answer larger than this is relayed but not kept, so a video cannot become the cache. */
export const PREVIEW_ASSET_BYTES = 4 * 1024 * 1024
/** Every copy this end holds for one view. */
export const PREVIEW_CACHE_BYTES = 16 * 1024 * 1024
/** A file that never arrives is a view that never renders, so it is answered as a failure. */
export const PREVIEW_ANSWER_TIMEOUT_MS = 20_000
/** One answer larger than this is not a file this end should be assembling. */
export const PREVIEW_ANSWER_BYTES = 32 * 1024 * 1024

type CachedAsset = { contentType: string; etag: string; body: Buffer }

type PendingAnswer = {
  status: number
  statusText: string
  headers: Record<string, string | string[] | undefined>
  chunks: Buffer[]
  bytes: number
  error?: string
}

type Pending = { answer: PendingAnswer; settled: Promise<void>; finish: () => void }

type Session = {
  /** The id the other machine knows this preview by. */
  sessionId: string
  desktopId: string
  taskId: string
  url: string
  key: string
  origin: string
  server: Server
  cache: Map<string, CachedAsset>
  cacheBytes: number
  pending: Map<number, Pending>
  nextStream: number
}

export type RemotePreviewClientOptions = {
  /** The command channel to the machine that holds the files. */
  send: (desktopId: string, kind: string, payload: Record<string, unknown>) => Promise<unknown>
}

export class RemotePreviewClient {
  readonly #send: RemotePreviewClientOptions['send']
  readonly #sessions = new Map<string, Session>()

  constructor(options: RemotePreviewClientOptions) {
    this.#send = options.send
  }

  /**
   * Open one view at an origin of this machine.
   *
   * The order matters: the listener exists before the other machine is asked to
   * serve anything, because the address this end hands it is the one it will
   * believe its client is talking to.
   */
  async open(input: RemotePreviewOpenInput): Promise<RemotePreviewHandle> {
    const desktopId = String(input.desktopId || ''), taskId = String(input.taskId || ''), url = String(input.url || '')
    const key = previewKey(input.key)
    if (!desktopId) throw Error('A preview needs the machine it belongs to.')
    if (!taskId) throw Error('A preview needs the task it belongs to.')
    if (!url) throw Error('A preview needs an address.')
    if (!key) throw Error('A preview needs a name to be opened under.')
    if ([...this.#sessions.values()].filter(session => session.desktopId === desktopId).length >= PREVIEW_SESSION_LIMIT) {
      throw Error(`At most ${PREVIEW_SESSION_LIMIT} previews may be open on one machine at once.`)
    }
    let session: Session | undefined
    const server = createServer((request, response) => {
      if (!session) return refuse(response, 503, 'This preview is not open.')
      void this.#serve(session, request, response)
    })
    const port = await listeningPort(server)
    const origin = `http://127.0.0.1:${port}/${key}`
    let opened: { sessionId?: unknown }
    try {
      opened = await this.#send(desktopId, 'preview.open', {
        taskId, url, key,
        // The authority the serving end forges when it asks for a file: a page
        // served to this address is the page this end's own surface asked for.
        authority: `127.0.0.1:${port}`,
        ...(input.viewId ? { viewId: input.viewId } : {}),
        ...(input.accessToken ? { accessToken: input.accessToken } : {}),
        ...(input.workspace ? { workspace: input.workspace } : {}),
      }) as { sessionId?: unknown }
    } catch (error) {
      await closeServer(server)
      throw error
    }
    const sessionId = String(opened?.sessionId || '')
    if (!sessionId) {
      await closeServer(server)
      throw Error('The other machine did not open this view.')
    }
    // A second open of the same name and origin is the same preview there, and
    // the id says so: what this end holds under it is replaced rather than left
    // listening on an origin nothing names any more.
    const previous = this.#sessions.get(sessionId)
    if (previous) this.#drop(previous)
    session = { sessionId, desktopId, taskId, url, key, origin, server, cache: new Map(), cacheBytes: 0, pending: new Map(), nextStream: 1 }
    this.#sessions.set(sessionId, session)
    return { sessionId, origin }
  }

  /**
   * One event from the other end.
   *
   * An answer that belongs to no request this end is waiting on is dropped: a
   * stream this end closed has been answered already, and a frame from a
   * previous link must not be handed to a request of this one.
   */
  handle(frame: RemotePreviewFrame) {
    const session = this.#sessions.get(String(frame.sessionId || ''))
    if (!session || session.desktopId !== frame.desktopId) return
    if (frame.type === 'preview.invalidate') return this.#invalidate(session, frame.paths, frame.all === true)
    const pending = session.pending.get(Number(frame.streamId))
    if (!pending) return
    if (frame.type === 'preview.response') {
      pending.answer.status = Number(frame.status) || 502
      pending.answer.statusText = String(frame.statusText || '')
      pending.answer.headers = frame.headers || {}
      if (frame.data) this.#extend(pending, frame.data)
      if (frame.end) pending.finish()
      return
    }
    if (frame.type === 'preview.data') {
      if (frame.data) this.#extend(pending, frame.data)
      if (frame.end) pending.finish()
      return
    }
    if (frame.type === 'preview.end') {
      if (frame.error) pending.answer.error = String(frame.error)
      pending.finish()
    }
  }

  async close(sessionId: string) {
    const session = this.#sessions.get(String(sessionId || ''))
    if (!session) return false
    this.#drop(session)
    await this.#send(session.desktopId, 'preview.close', { sessionId: session.sessionId }).catch(() => undefined)
    return true
  }

  /**
   * Everything one machine opened, dropped when that machine's link goes away.
   * A session is answered by the link it was opened on, and a link that is gone
   * has nothing left to answer with.
   */
  closeDesktop(desktopId: string) {
    let closed = false
    for (const session of [...this.#sessions.values()]) {
      if (session.desktopId !== desktopId) continue
      this.#drop(session)
      closed = true
    }
    return closed
  }

  dispose() {
    for (const session of [...this.#sessions.values()]) this.#drop(session)
  }

  /** Which previews this end holds, for a caller that has to tell the truth about them. */
  list() {
    return [...this.#sessions.values()].map(session => ({ sessionId: session.sessionId, desktopId: session.desktopId, taskId: session.taskId, url: session.url, origin: session.origin }))
  }

  async #serve(session: Session, request: IncomingMessage, response: ServerResponse) {
    const asset = previewAssetPath(request.url || '', session.key)
    if (!asset) return refuse(response, 403, 'This request is not part of the view that was opened on the other machine.')
    const cacheKey = revalidatingKey(asset)
    const cached = session.cache.get(cacheKey)
    const streamId = session.nextStream++
    const pending = this.#pending(session, streamId)
    try {
      const body = await previewRequestBody(request)
      const head = body.subarray(0, PREVIEW_FRAME_BYTES)
      await this.#send(session.desktopId, 'preview.send', {
        sessionId: session.sessionId,
        streamId,
        method: String(request.method || 'GET').toUpperCase(),
        url: asset,
        headers: previewRequestHeaders(request.headers, cached?.etag),
        ...(head.length ? { body: head.toString('base64url') } : {}),
        // A request body is framed like an answer, because the link counts
        // frames: one that does not fit is sent as more of the same request
        // rather than as a frame the link would have to refuse.
        more: body.length > PREVIEW_FRAME_BYTES,
      })
      for (let index = 1; index * PREVIEW_FRAME_BYTES < body.length; index++) {
        const slice = body.subarray(index * PREVIEW_FRAME_BYTES, (index + 1) * PREVIEW_FRAME_BYTES)
        await this.#send(session.desktopId, 'preview.body', {
          sessionId: session.sessionId, streamId, data: slice.toString('base64url'),
          more: (index + 1) * PREVIEW_FRAME_BYTES < body.length,
        })
      }
    } catch (error) {
      pending.finish()
      return refuse(response, 502, `The other machine could not be asked for this file: ${message(error)}`)
    }
    await pending.settled
    const { status, statusText, headers, chunks, error } = pending.answer
    const bytes = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0)
    // A file this end already holds is answered from here. That is the whole
    // saving: the other end said nothing changed, so nothing travels back.
    if (status === 304 && cached) return respondCached(response, request, cached)
    if (!status || (error && !bytes.length)) return refuse(response, 502, error || 'The other machine did not answer.')
    const contentType = headerText(headers, 'content-type'), contentEncoding = headerText(headers, 'content-encoding'), etag = headerText(headers, 'etag')
    // Only an identity copy is kept: a representation this end cannot reinterpret
    // is not one it may answer a later caller from.
    if (status === 200 && etag && !contentEncoding && bytes.length <= PREVIEW_ASSET_BYTES && bytes.length) this.#remember(session, cacheKey, { contentType, etag, body: bytes })
    return respond(response, request, status, statusText, headers, bytes)
  }

  #pending(session: Session, streamId: number): Pending {
    const answer: PendingAnswer = { status: 0, statusText: '', headers: {}, chunks: [], bytes: 0 }
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      session.pending.delete(streamId)
      settle()
    }
    const timer = setTimeout(() => {
      answer.error ??= 'The other machine did not answer in time.'
      finish()
    }, PREVIEW_ANSWER_TIMEOUT_MS)
    session.pending.set(streamId, { answer, settled, finish })
    return { answer, settled, finish }
  }

  #extend(pending: Pending, data: string) {
    let chunk: Buffer
    try { chunk = Buffer.from(data, 'base64url') } catch { return }
    if (!chunk.length) return
    if (pending.answer.bytes + chunk.length > PREVIEW_ANSWER_BYTES) {
      pending.answer.error ??= 'This file is larger than a view may be answered with.'
      pending.finish()
      return
    }
    pending.answer.chunks.push(chunk)
    pending.answer.bytes += chunk.length
  }

  /**
   * A package changed, so what this end holds stopped being what the other end
   * has. The paths are the other end's answer, and a change it could not name
   * is one this end cannot keep anything across.
   */
  #invalidate(session: Session, paths: string[] | undefined, all: boolean) {
    if (all || !paths?.length) {
      session.cache.clear()
      session.cacheBytes = 0
      return
    }
    for (const path of paths) {
      const cached = session.cache.get(path)
      if (!cached) continue
      session.cacheBytes -= cached.body.length
      session.cache.delete(path)
    }
  }

  #remember(session: Session, key: string, asset: CachedAsset) {
    const previous = session.cache.get(key)
    if (previous) session.cacheBytes -= previous.body.length
    session.cache.set(key, asset)
    session.cacheBytes += asset.body.length
    // Oldest first: a view that is being read is asking for the files it needs
    // now, and the ones it stopped asking for are the ones to let go.
    for (const [oldest] of session.cache) {
      if (session.cacheBytes <= PREVIEW_CACHE_BYTES) break
      if (oldest === key) continue
      const dropped = session.cache.get(oldest)
      if (!dropped) continue
      session.cacheBytes -= dropped.body.length
      session.cache.delete(oldest)
    }
  }

  #drop(session: Session) {
    this.#sessions.delete(session.sessionId)
    for (const pending of [...session.pending.values()]) {
      pending.answer.error ??= 'This preview was closed.'
      pending.finish()
    }
    session.cache.clear()
    session.cacheBytes = 0
    void closeServer(session.server)
  }
}

/**
 * The path this end was asked for, as the other end should be asked for it.
 *
 * This origin is one view's and nothing else's, so the root of it is that view:
 * a package may address its own files from the root, because that is how it
 * addresses them where it is installed, and a prefix it did not write must not
 * be the reason its interface loads nothing.
 */
export function previewAssetPath(value: string, key: string) {
  if (!value.startsWith('/')) return undefined
  const prefix = `/${key}`
  const rest = value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`) ? value.slice(prefix.length) : value
  const asset = rest ? (rest.startsWith('/') ? rest : `/${rest}`) : '/'
  if (asset.startsWith('//') || asset.length > 4_000) return undefined
  if (asset.split(/[?#]/)[0].split('/').includes('..')) return undefined
  return asset
}

/**
 * The name a copy is held under: the file, not the channel it was mounted on.
 * A view opened again is mounted with a new channel, and a channel is not part
 * of a file's name — holding it would be paying for the whole interface again
 * every time somebody reopens it.
 */
export function revalidatingKey(path: string) {
  const [base, query] = path.split('#')[0].split('?')
  if (!query) return base
  const params = new URLSearchParams(query)
  params.delete('channel')
  params.delete('host')
  const rest = params.toString()
  return rest ? `${base}?${rest}` : base
}

function previewKey(value: unknown) {
  const key = String(value || '').trim()
  return /^[A-Za-z0-9._-]{1,80}$/.test(key) ? key : ''
}

/**
 * What the other end is told about this request.
 *
 * Only what decides the bytes: what the caller accepts, and what it already
 * has. A copy this end holds is offered as the validator, because the answer it
 * makes possible is the one this end can serve — and a range is not forwarded,
 * because a byte range answered halfway is not a file this end can keep.
 */
export function previewRequestHeaders(headers: IncomingMessage['headers'], cachedEtag?: string) {
  const forwarded: Record<string, string> = {}
  for (const [name, limit] of [['accept', 2_000], ['accept-language', 500]] as const) {
    const value = headers[name]
    if (typeof value === 'string' && value.length <= limit) forwarded[name] = value
  }
  const validator = cachedEtag || (typeof headers['if-none-match'] === 'string' ? headers['if-none-match'] : '')
  if (validator && validator.length <= 500) forwarded['if-none-match'] = validator
  return forwarded
}

function headerText(headers: Record<string, string | string[] | undefined>, name: string) {
  const value = headers[name]
  if (Array.isArray(value)) return value.join(', ')
  return typeof value === 'string' ? value : ''
}

/** Framing belongs to each hop: what came back describes the other end's socket, not this one. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length', 'trailer', 'proxy-authenticate', 'proxy-authorization', 'te'])

function responseHeaders(headers: Record<string, string | string[] | undefined>) {
  const forwarded: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    const text = Array.isArray(value) ? value.join(', ') : String(value ?? '')
    if (text) forwarded[name] = text
  }
  return forwarded
}

function respond(response: ServerResponse, request: IncomingMessage, status: number, statusText: string, headers: Record<string, string | string[] | undefined>, body: Buffer) {
  const forwarded = responseHeaders(headers)
  response.writeHead(status, statusText || undefined, { ...forwarded, 'content-length': String(body.length) })
  if (String(request.method || 'GET').toUpperCase() === 'HEAD') return void response.end()
  response.end(body)
}

/**
 * A copy this end holds, handed over as the file it is.
 *
 * The other end said the file did not change, so this is the answer — with the
 * validator that made the question cheap, so the next question is cheap too.
 */
function respondCached(response: ServerResponse, request: IncomingMessage, asset: CachedAsset) {
  const headers: Record<string, string> = { 'content-length': String(asset.body.length), etag: asset.etag }
  if (asset.contentType) headers['content-type'] = asset.contentType
  response.writeHead(200, headers)
  if (String(request.method || 'GET').toUpperCase() === 'HEAD') return void response.end()
  response.end(asset.body)
}

function refuse(response: ServerResponse, status: number, message: string) {
  const body = Buffer.from(message, 'utf8')
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store' })
  response.end(body)
}

function previewRequestBody(request: IncomingMessage) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > PREVIEW_REQUEST_BYTES) {
        reject(Error('This request body is larger than a view may send.'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0)))
    request.on('error', reject)
  })
}

function listeningPort(server: Server) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    // Loopback only, an ephemeral port: the origin is this machine's own and
    // nothing else on the network is ever on the other end of it.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(Error('The preview origin could not be bound.'))
      resolve(address.port)
    })
  })
}

function closeServer(server: Server) {
  return new Promise<void>(resolve => {
    // A surface can be holding a connection open — a page that never finished
    // loading leaves one — and a preview that is closed must not leave the port
    // waiting for it.
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
