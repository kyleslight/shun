import { net } from 'electron'
import type { ReleaseProbe } from './release-sources'

/**
 * Network access for release probing. Electron's own stack is used on purpose:
 * it follows the machine's system proxy, which is how many networks reach
 * release hosts at all.
 */
function fetchWithTimeout(url: string, timeoutMs: number, signal?: AbortSignal, headers?: Record<string, string>) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return net.fetch(url, {
    headers,
    redirect: 'follow',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
}

export const releaseProbe: ReleaseProbe = {
  async text(url, timeoutMs, signal) {
    const started = Date.now()
    const response = await fetchWithTimeout(url, timeoutMs, signal, { 'Cache-Control': 'no-store' })
    if (!response.ok) throw Error(`HTTP ${response.status}`)
    const body = await response.text()
    return { body, elapsedMs: Date.now() - started }
  },
  async throughput(url, bytes, timeoutMs, signal) {
    const started = Date.now()
    const response = await fetchWithTimeout(url, timeoutMs, signal, { Range: `bytes=0-${bytes - 1}`, 'Cache-Control': 'no-store' })
    if (!response.ok || !response.body) throw Error(`HTTP ${response.status}`)
    const reader = response.body.getReader()
    let firstByteMs = 0
    let total = 0
    while (total < bytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (!firstByteMs) firstByteMs = Date.now() - started
      total += value?.length || 0
    }
    try { await reader.cancel() } catch {}
    // Whole-transfer throughput: a buffered first chunk must not look like
    // infinite bandwidth, because a real download waits for that latency too.
    const elapsedMs = Math.max(1, Date.now() - started)
    return {
      bytes: total,
      bytesPerSecond: total / (elapsedMs / 1000),
      latencyMs: firstByteMs || elapsedMs,
    }
  },
}
