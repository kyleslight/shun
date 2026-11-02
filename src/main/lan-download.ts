import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import { randomBytes, createCipheriv } from 'node:crypto'
import { open, stat } from 'node:fs/promises'

export type LanDownload = { urls: string[]; key: string; expiresAt: number }
type Grant = { path: string; size: number; version: string; key: Buffer; expiresAt: number }

/** Capabilities travel only over the paired encrypted link. LAN responses are
 * independently authenticated and bind the requested byte offset. */
export class LanDownloads {
  private server?: Server
  private starting?: Promise<number>
  private grants = new Map<string, Grant>()
  private now: () => number
  constructor(now: () => number = Date.now) { this.now = now }
  async offer(path: string, version?: string): Promise<LanDownload | undefined> {
    const addresses = Object.values(networkInterfaces()).flat().filter(item => item && !item.internal && item.family === 'IPv4' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(item.address)).map(item => item!.address)
    if (!addresses.length) return
    const port = await (this.starting ??= this.listen().catch(error => { this.starting = undefined; throw error }))
    const metadata = await stat(path)
    if (!metadata.isFile()) throw Error('File unavailable.')
    const identity = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`
    if (version && version !== identity) throw Error('File changed.')
    const now = this.now()
    for (const [id, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(id)
    while (this.grants.size >= 32) this.grants.delete(this.grants.keys().next().value!)
    const id = randomBytes(32).toString('hex'), key = randomBytes(32), expiresAt = now + 10 * 60_000
    this.grants.set(id, { path, size: metadata.size, version: identity, key, expiresAt })
    return { urls: addresses.map(address => `http://${address}:${port}/${id}`), key: key.toString('base64'), expiresAt }
  }
  revoke() { this.grants.clear() }
  close() { this.revoke(); this.server?.close(); this.server?.closeAllConnections(); this.server = undefined; this.starting = undefined }
  private listen(): Promise<number> {
    const server = this.server = createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      try {
        const url = new URL(request.url || '/', 'http://localhost')
        const id = url.pathname.slice(1), grant = this.grants.get(id)
        if (request.method !== 'GET' || !grant || grant.expiresAt <= this.now()) { response.writeHead(404).end(); return }
        const offset = Number(url.searchParams.get('offset'))
        if (!Number.isSafeInteger(offset) || offset < 0 || offset >= grant.size) { response.writeHead(416).end(); return }
        const handle = await open(grant.path, 'r')
        let bytes: Buffer
        try {
          const metadata = await handle.stat()
          if (`${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}` !== grant.version) throw Error('File changed.')
          const buffer = Buffer.alloc(Math.min(1024 * 1024, grant.size - offset))
          const read = await handle.read(buffer, 0, buffer.length, offset)
          if (!read.bytesRead) throw Error('File unavailable.')
          bytes = buffer.subarray(0, read.bytesRead)
        } finally { await handle.close() }
        const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', grant.key, nonce)
        cipher.setAAD(Buffer.from(`${id}:${offset}`))
        const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()])
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64') }))
      } catch { if (!response.headersSent) response.writeHead(409); response.end() }
    })
    server.requestTimeout = 10_000
    server.headersTimeout = 10_000
    server.maxConnections = 8
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '0.0.0.0', () => { const address = server.address(); if (address && typeof address !== 'string') resolve(address.port); else reject(Error('Local transfer unavailable.')) })
    })
  }
}
