import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, session } from 'electron'
import { completeProviderResponse, providerRequestInit } from '../src/main/provider-response'
import { createNetworkFetch } from '../src/main/network-route'

// Exercise Chromium's actual connection pool. A mocked ReadableStream cannot
// establish whether cancelling a reader releases a native proxy socket.
const profile = mkdtempSync(join(tmpdir(), 'shun-network-smoke-'))
app.setPath('userData', profile)
app.dock?.hide()
void app.whenReady().then(async () => {
const endpoint = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end('data: {"content":"OK"}\n\ndata: [DONE]\n\n')
})
const proxy = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write('data: {"content":"OK"}\n\n')
  if (!request.url?.endsWith('/cancel')) response.write('data: [DONE]\n\n')
  // Deliberately omit HTTP EOF, as seen on real proxy routes.
})
await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve))
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
const endpointPort = (endpoint.address() as { port: number }).port
const proxyPort = (proxy.address() as { port: number }).port
const direct = session.fromPartition('network-smoke-direct')
const proxied = session.fromPartition('network-smoke-proxy')
await direct.setProxy({ mode: 'direct' })
await proxied.setProxy({ mode: 'fixed_servers', proxyRules: `127.0.0.1:${proxyPort}`, proxyBypassRules: '<-loopback>' })
let completed = 0
async function request(fetchUrl: typeof fetch, url: string, cancel = false) {
  const transport = new AbortController()
  const timer = setTimeout(() => transport.abort(Error('native connection did not finish')), 3_000)
  try {
    const raw = await fetchUrl(url, providerRequestInit(url, { signal: transport.signal }))
    const response = completeProviderResponse(raw, reason => transport.abort(reason))
    if (cancel) { await response.body!.cancel('test cancellation'); assert.ok(transport.signal.aborted) }
    else assert.match(await response.text(), /"content":"OK"/)
    completed++
  } catch (error) {
    throw new Error(`Native request ${completed + 1} failed (${url})`, { cause: error })
  } finally { clearTimeout(timer) }
}
try {
  const systemFetch = proxied.fetch.bind(proxied) as typeof fetch
  const localFetch = direct.fetch.bind(direct) as typeof fetch
  console.log(`Proxy route: ${await proxied.resolveProxy('http://transport.example/test')}`)
  for (const [name, fetchUrl, url] of [
    ['proxy', systemFetch, 'http://transport.example/test'],
    ['direct', localFetch, `http://127.0.0.1:${endpointPort}/test`],
  ] as const) {
    for (let i = 0; i < 24; i++) await request(fetchUrl, url)
    await Promise.all(Array.from({ length: 12 }, () => request(fetchUrl, url)))
    console.log(`${name}: 24 sequential and 12 concurrent requests completed`)
  }
  for (let i = 0; i < 12; i++) await request(systemFetch, 'http://transport.example/cancel', true)
  await request(systemFetch, 'http://transport.example/test')
  const routed = createNetworkFetch(systemFetch, async () => localFetch)
  await request(routed, `http://127.0.0.1:${endpointPort}/test`)
  console.log(`PASS: ${completed} native requests; cancellation recovery and LAN routing completed`)
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await Promise.all([direct.closeAllConnections(), proxied.closeAllConnections()])
  endpoint.closeAllConnections(); proxy.closeAllConnections()
  await Promise.all([new Promise<void>(resolve => endpoint.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))])
  await rm(profile, { recursive: true, force: true })
  app.exit(process.exitCode || 0)
}
}).catch(error => { console.error(error); app.exit(1) })
