import type { ProviderTestResult } from '../shared'

const TEST_TIMEOUT_MS = 15_000

const boundedMessage = (value: unknown, apiKey = '') => {
  const text = String(value || 'Request failed').replace(/\s+/g, ' ').trim()
  return (apiKey ? text.replaceAll(apiKey, '[redacted]') : text).slice(0, 180)
}

function responseMessage(body: string, apiKey: string) {
  try {
    const parsed = JSON.parse(body)
    return boundedMessage(parsed?.error?.message || parsed?.message || 'Request failed', apiKey)
  } catch {
    return boundedMessage(body || 'Request failed', apiKey)
  }
}

export async function testModelDeployment(
  endpoint: string,
  apiKey: string | undefined,
  model: string,
  request: typeof fetch = fetch,
): Promise<ProviderTestResult> {
  const startedAt = Date.now(), secret = apiKey || '', controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const base = endpoint.trim().replace(/\/+$/, '')
    if (!base || !model.trim()) throw Error('Base URL and Model ID are required')
    const url = new URL(`${base}/chat/completions`)
    if (!['http:', 'https:'].includes(url.protocol)) throw Error('Base URL must use HTTP or HTTPS')
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(Error('Connection test timed out after 15 seconds'))
      }, TEST_TIMEOUT_MS)
    })
    const response = await Promise.race([request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
      body: JSON.stringify({ model: model.trim(), messages: [{ role: 'user', content: 'Reply with OK.' }], temperature: 0, max_tokens: 1, stream: false }),
      signal: controller.signal,
    }), deadline])
    const body = await Promise.race([response.text(), deadline])
    if (!response.ok) return { ok: false, latencyMs: Date.now() - startedAt, message: `${response.status} ${responseMessage(body, secret)}` }
    try {
      const json = JSON.parse(body)
      if (!Array.isArray(json?.choices)) throw Error('Provider returned no completion choices')
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - startedAt, message: boundedMessage(error instanceof Error ? error.message : error, secret) }
    }
    return { ok: true, latencyMs: Date.now() - startedAt, message: 'Model responded successfully' }
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, message: boundedMessage(error instanceof Error ? error.message : error, secret) }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
