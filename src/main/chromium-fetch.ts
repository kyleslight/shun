import { Readable, Writable } from 'node:stream'
import type { ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from 'electron'

/** Chromium transport with a guarded response boundary. Native callback errors
 * must reject the request rather than escape the promise and strand its caller. */
export function createChromiumFetch(request: (options: ClientRequestConstructorOptions) => ClientRequest): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const source = new Request(input, init)
    source.signal.throwIfAborted()
    return new Promise<Response>((resolve, reject) => {
      const origin = source.headers.get('origin') || undefined
      const transport = request({ url: source.url, method: source.method, origin,
        credentials: source.credentials === 'same-origin' && !origin ? 'include' : source.credentials,
        cache: source.cache, referrerPolicy: source.referrerPolicy, redirect: source.redirect })
      let incoming: Readable | undefined
      let finalUrl = source.url
      let finished = false
      const cleanup = () => source.signal.removeEventListener('abort', abort)
      const fail = (error: unknown) => {
        if (finished) return
        finished = true
        cleanup()
        reject(error)
        incoming?.destroy(error instanceof Error ? error : Error(String(error)))
        transport.abort()
      }
      const abort = () => fail(source.signal.reason || new DOMException('The request was cancelled.', 'AbortError'))
      source.signal.addEventListener('abort', abort, { once: true })
      transport.on('error', fail)
      transport.on('redirect', (_status, _method, url) => { finalUrl = url })
      transport.on('response', (response: IncomingMessage) => {
        if (finished) return
        try {
          if (!Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode > 599)
            throw Error(`Network response has an invalid status (${response.statusCode}).`)
          const headers = new Headers()
          for (const [key, value] of Object.entries(response.headers))
            if (value !== undefined) for (const entry of Array.isArray(value) ? value : [value]) headers.append(key, entry)
          incoming = response as unknown as Readable
          incoming.on('error', fail)
          incoming.once('end', () => { finished = true; cleanup() })
          incoming.once('close', () => {
            cleanup()
            if (!finished) { finished = true; transport.abort() }
          })
          const empty = source.method === 'HEAD' || [204, 205, 304].includes(response.statusCode)
          const result = new Response(empty ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
            status: response.statusCode, statusText: response.statusMessage, headers,
          })
          Object.defineProperties(result, { url: { value: finalUrl }, redirected: { value: finalUrl !== source.url } })
          resolve(result)
          if (empty) incoming.resume()
        } catch (error) { fail(error) }
      })
      try {
        for (const [key, value] of source.headers) transport.setHeader(key, value)
        if (source.signal.aborted) { abort(); return }
        if (source.body) void source.body.pipeTo(Writable.toWeb(transport as unknown as Writable)).catch(fail)
        else transport.end()
      } catch (error) { fail(error) }
    })
  }) as typeof fetch
}
