import { createServer, request } from 'node:http'
import { createConnection } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hostPaths } from './paths.ts'
import { HOST_PROTOCOL, type HostCall } from './protocol.ts'
import { ShunHostService } from './service.ts'

const maxBody = 29_000_000
function socketAddress(paths: ReturnType<typeof hostPaths>, token: string) {
  // A Windows pipe name includes an unguessable component; Unix sockets live
  // inside a private directory and are checked before credentials are sent.
  return process.platform === 'win32' ? `${paths.socket}-${token.slice(0, 24)}` : paths.socket
}
async function privateSocketDirectory(path: string) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw Error('Shun service socket directory must be private to this user.')
}
export function createHostClient(home?: string, signal?: AbortSignal): HostCall {
  const paths = hostPaths(home)
  return async (method, input = {}) => {
    const token = (await readFile(paths.token, 'utf8')).trim()
    if (!/^[a-f0-9]{64}$/.test(token)) throw Object.assign(Error('Shun service is starting.'), { code: 'SHUN_STARTING' })
    if (process.platform !== 'win32') await privateSocketDirectory(paths.socketDirectory)
    const socketPath = socketAddress(paths, token)
    const body = JSON.stringify({ method, input })
    return new Promise((resolve, reject) => {
      const req = request({ signal, socketPath, path: '/rpc', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
        const chunks: Buffer[] = []; let size = 0
        response.on('data', chunk => { size += chunk.length; if (size > 64_000_000) response.destroy(Error('Shun response is too large.')); else chunks.push(chunk) })
        response.on('error', reject)
        response.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (!value.ok) reject(Object.assign(Error(value.error || 'Shun request failed.'), { code: response.statusCode === 503 ? 'SHUN_STARTING' : undefined }))
            else resolve(value.result)
          } catch (error) { reject(error) }
        })
      })
      req.setTimeout(120_000, () => req.destroy(Error('Shun service request timed out.')))
      req.on('error', reject)
      req.end(body)
    })
  }
}

async function socketIsAlive(socket: string) {
  return new Promise<boolean>((resolve, reject) => {
    const connection = createConnection(socket)
    connection.setTimeout(2000)
    connection.once('connect', () => { connection.destroy(); resolve(true) })
    connection.once('timeout', () => { connection.destroy(); reject(Error('Shun service is not responding.')) })
    connection.once('error', (error: NodeJS.ErrnoException) => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code || '')) resolve(false)
      else reject(error)
    })
  })
}

export async function startHostServer(home?: string, suppliedService?: Pick<ShunHostService, 'initialize' | 'close' | 'call' | 'runs'>) {
  const paths = hostPaths(home)
  await mkdir(paths.serviceRoot, { recursive: true, mode: 0o700 })
  await chmod(paths.serviceRoot, 0o700)
  if (process.platform !== 'win32') {
    await mkdir(paths.socketDirectory, { recursive: true, mode: 0o700 })
    await privateSocketDirectory(paths.socketDirectory)
  }
  const lock = join(paths.serviceRoot, 'owner')
  try { await mkdir(lock, { mode: 0o700 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let stale = false
    try {
      const pid = Number(await readFile(join(lock, 'pid'), 'utf8'))
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0) } catch (error) { stale = (error as NodeJS.ErrnoException).code === 'ESRCH' }
      }
    } catch { stale = Date.now() - (await stat(lock)).mtimeMs > 30_000 }
    if (!stale) throw Error('Shun service is already running or starting.')
    await rm(lock, { recursive: true, force: true })
    await mkdir(lock, { mode: 0o700 })
  }
  await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 })
  try {
  try { await writeFile(paths.token, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const token = (await readFile(paths.token, 'utf8')).trim()
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('Shun service access token is invalid.')
  const socketPath = socketAddress(paths, token)
  if (await socketIsAlive(socketPath)) throw Error('Shun service is already running.')
  if (process.platform !== 'win32') await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error })
  const service = suppliedService || new ShunHostService(home)
  let ready = false
  const server = createServer(async (req, res) => {
    const answer = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const auth = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`)
    if (req.method !== 'POST' || req.url !== '/rpc' || req.headers.origin || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      answer(403, { ok: false, error: 'Shun connection is not authorized.' }); return
    }
    if (!ready) { answer(503, { ok: false, error: 'Shun service is starting.' }); return }
    try {
      let size = 0; const chunks: Buffer[] = []
      for await (const chunk of req) {
        size += chunk.length
        if (size > maxBody) { answer(413, { ok: false, error: 'Shun request is too large.' }); return }
        chunks.push(chunk)
      }
      const { method, input } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (typeof method !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid Shun request.')
      if (method === 'service.stop') {
        if (Object.keys(service.runs.snapshot()).length) throw Error('Stop active tasks before stopping the Shun service.')
        answer(200, { ok: true, result: true })
        setImmediate(() => server.emit('shun-stop'))
        return
      }
      answer(200, { ok: true, result: await service.call(method, input) })
    } catch (error) { answer(400, { ok: false, error: error instanceof Error ? error.message : 'Shun request failed.' }) }
  })
  server.requestTimeout = 125_000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  try {
    if (process.platform !== 'win32') await chmod(socketPath, 0o600)
    await service.initialize()
    ready = true
  } catch (error) { server.close(); await service.close(); throw error }
  return {
    service, server, socketPath,
    async close() {
      ready = false
      await service.close()
      server.closeIdleConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(lock, { recursive: true, force: true })
    },
  }
  } catch (error) { await rm(lock, { recursive: true, force: true }); throw error }
}

export async function verifyHost(call: HostCall) {
  const hello = await call('hello')
  if (hello.protocol !== HOST_PROTOCOL) throw Error('Shun service and interface versions are incompatible. Finish active tasks, then restart the service.')
  return hello
}
