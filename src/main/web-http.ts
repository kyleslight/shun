import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { createBrotliDecompress, createUnzip } from 'node:zlib'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { setTimeout as delay } from 'node:timers/promises'
import type { WebResource } from './web.ts'

type Options = {
  proxyUrl?: string
  timeoutMs: number
  maxBytes: number
  headers?: Record<string, string>
  signal?: AbortSignal
}

/** Public GETs can hedge a stalled system proxy without changing browser or OS routing. */
export function publicHttpRoutes(pool: Pick<PublicHttpPool, 'fetch'>, url: string, options: Options, hedgeMs = 350) {
  const routes = [(signal: AbortSignal) => pool.fetch(url, { ...options, signal })]
  if (options.proxyUrl) routes.push(async signal => {
    await delay(hedgeMs, undefined, { signal })
    return pool.fetch(url, { ...options, proxyUrl: undefined, signal })
  })
  return routes
}

/** Reuse public HTTP connections across tool calls, including proxy tunnels. */
export class PublicHttpPool {
  private readonly http = new HttpAgent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 })
  private readonly https = new HttpsAgent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 })
  private readonly proxies = new Map<string, HttpsProxyAgent<string>>()

  async fetch(value: string, options: Options): Promise<WebResource> {
    const timeout = AbortSignal.timeout(options.timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    let url = new URL(value)
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted()
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Invalid public HTTP target')
      const reply = await this.request(url, options, signal)
      if (!reply.location) return reply.resource!
      url = new URL(reply.location, url)
    }
    throw Error('Too many HTTP redirects')
  }

  close() {
    this.http.destroy()
    this.https.destroy()
    for (const agent of this.proxies.values()) agent.destroy()
    this.proxies.clear()
  }

  private request(url: URL, options: Options, signal: AbortSignal) {
    let agent: HttpAgent | HttpsAgent | HttpsProxyAgent<string> = url.protocol === 'https:' ? this.https : this.http
    if (options.proxyUrl) {
      let proxy = this.proxies.get(options.proxyUrl)
      if (!proxy) {
        proxy = new HttpsProxyAgent(options.proxyUrl, { keepAlive: true, maxSockets: 8, maxFreeSockets: 4 })
        this.proxies.set(options.proxyUrl, proxy)
      }
      agent = proxy
    }
    return new Promise<{ location?: string; resource?: WebResource }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        agent, signal, headers: { 'accept-encoding': 'gzip, deflate, br', ...options.headers },
      }, response => {
        const status = response.statusCode || 0
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume()
          resolve({ location: response.headers.location })
          return
        }
        const encoding = response.headers['content-encoding']
        const decoder = encoding === 'br' ? createBrotliDecompress() : /^(?:gzip|deflate)$/.test(encoding || '') ? createUnzip() : undefined
        if (decoder) response.on('error', error => decoder.destroy(error))
        const stream = decoder ? response.pipe(decoder) : response
        const onAbort = () => { stream.destroy(Error('Public HTTP request cancelled')); response.destroy() }
        signal.addEventListener('abort', onAbort, { once: true })
        void (async () => {
          try {
            const chunks: Buffer[] = []
            let size = 0
            for await (const chunk of stream) {
              size += chunk.length
              if (size > options.maxBytes) throw Error('Public HTTP response exceeds the byte limit')
              chunks.push(Buffer.from(chunk))
            }
            resolve({ resource: { body: Buffer.concat(chunks), status, contentType: response.headers['content-type'] || '', finalUrl: url.href } })
          } catch (error) {
            response.destroy()
            stream.destroy()
            reject(error)
          } finally { signal.removeEventListener('abort', onAbort) }
        })()
      })
      request.once('error', reject)
      request.end()
    })
  }
}
