import { spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { hostPaths } from '../host/paths.ts'
import { createHostClient, verifyHost } from '../host/transport.ts'

export async function connectHost(home?: string, signal?: AbortSignal) {
  const call = createHostClient(home, signal)
  let starting = false
  try { await verifyHost(call); return call }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code || ''
    if (!['ENOENT', 'ECONNREFUSED', 'SHUN_STARTING'].includes(code)) throw error
    starting = code === 'SHUN_STARTING'
  }
  const paths = hostPaths(home)
  await mkdir(paths.serviceRoot, { recursive: true, mode: 0o700 })
  const log = starting ? undefined : await open(paths.log, 'a', 0o600)
  try {
    if (log) {
      const child = spawn(process.execPath, [process.argv[1], '--serve'], { detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, ...(home ? { SHUN_HOME: home } : {}) }, windowsHide: true })
      child.on('error', () => {})
      child.unref()
    }
  } finally { await log?.close() }
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    try { await verifyHost(call); return call } catch { /* Another launcher may be starting the same service. */ }
  }
  throw Error(`Shun service could not start. Diagnostics: ${paths.log}`)
}
