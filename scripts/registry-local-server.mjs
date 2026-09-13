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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleRegistryRequest } from '../registry/src/registry.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dist = join(root, 'registry', 'dist')
const port = Number(process.env.PORT || 8787)

// A local registry is a real one: the same schema, the same SQL, and a bucket
// that lives on disk, so `pnpm registry:serve` can be published to as well as
// read from.
const stateRoot = join(root, 'registry', '.local')
await mkdir(join(stateRoot, 'objects'), { recursive: true })
const database = new DatabaseSync(join(stateRoot, 'registry.sqlite'))
database.exec(await readFile(join(root, 'registry', 'schema.sql'), 'utf8'))
const adapt = (query, values = []) => ({
  bind: (...next) => adapt(query, next),
  first: async () => database.prepare(query).get(...values) ?? null,
  all: async () => ({ results: database.prepare(query).all(...values) }),
  run: async () => database.prepare(query).run(...values),
})

const env = {
  ENV: 'test',
  DB: { prepare: query => adapt(query), batch: async statements => { for (const statement of statements) await statement.run() } },
  OPERATOR_TOKEN: process.env.SHUN_REGISTRY_OPERATOR_TOKEN || (await readFile(join(root, '.env.registry'), 'utf8').catch(() => '')).match(/SHUN_REGISTRY_OPERATOR_TOKEN=(.+)/)?.[1]?.trim(),
  EMAIL_PEPPER: process.env.SHUN_REGISTRY_EMAIL_PEPPER || 'local-development-pepper',
  // Codes print to this terminal instead of going out by email.
  MAIL_TRANSPORT: 'console',
  ARCHIVES: {
    get: async key => {
      if (key.includes('..')) return null
      const roots = [join(stateRoot, 'objects'), dist]
      for (const base of roots) {
        try {
          const bytes = await readFile(join(base, key))
          return {
            text: async () => bytes.toString('utf8'),
            arrayBuffer: async () => {
              const copy = new ArrayBuffer(bytes.byteLength)
              new Uint8Array(copy).set(bytes)
              return copy
            },
          }
        } catch {}
      }
      return null
    },
    put: async (key, value) => {
      if (key.includes('..')) throw Error('Invalid object key')
      const file = join(stateRoot, 'objects', key)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, value instanceof Uint8Array ? value : new Uint8Array(value))
    },
  },
}

const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  const url = new URL(request.url || '/', `http://${request.headers.host || `127.0.0.1:${port}`}`)
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value)
  const reply = await handleRegistryRequest(new Request(url, { method: request.method, headers, ...(body.length ? { body } : {}) }), env)
  response.writeHead(reply.status, Object.fromEntries(reply.headers))
  response.end(Buffer.from(await reply.arrayBuffer()))
  console.log(`${request.method} ${url.pathname}${url.search} -> ${reply.status}`)
})

server.listen(port, '127.0.0.1', () => console.log(`Shun registry (local) on http://127.0.0.1:${port} serving ${dist}`))
