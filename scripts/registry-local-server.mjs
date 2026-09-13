#!/usr/bin/env node
/**
 * Serve the generated registry catalog over plain HTTP so the application can be
 * pointed at it while the marketplace is being built:
 *
 *   node --experimental-strip-types scripts/build-registry-catalog.mjs
 *   pnpm registry:serve
 *   SHUN_REGISTRY_URL=http://127.0.0.1:8787 pnpm dev
 *
 * It runs the same `handleRegistryRequest` the Worker runs, reading the same
 * `registry/dist` tree, so a local test proves the deployed path rather than a
 * parallel implementation of it.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleRegistryRequest } from '../registry/src/registry.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dist = join(root, 'registry', 'dist')
const port = Number(process.env.PORT || 8787)

const env = {
  ENV: 'test',
  ARCHIVES: {
    get: async key => {
      if (key.includes('..')) return null
      try {
        const bytes = await readFile(join(dist, key))
        return { text: async () => bytes.toString('utf8'), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
      } catch { return null }
    },
  },
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || `127.0.0.1:${port}`}`)
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value)
  const reply = await handleRegistryRequest(new Request(url, { method: request.method, headers }), env)
  response.writeHead(reply.status, Object.fromEntries(reply.headers))
  response.end(Buffer.from(await reply.arrayBuffer()))
  console.log(`${request.method} ${url.pathname}${url.search} -> ${reply.status}`)
})

server.listen(port, '127.0.0.1', () => console.log(`Shun registry (local) on http://127.0.0.1:${port} serving ${dist}`))
