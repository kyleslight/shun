import { normalizeProviderConnection, type ProviderApi, type ProviderTestResult } from '../shared.ts'

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

export function formatProviderFailure(value: unknown, language: 'en' | 'zh-CN' | 'system' | undefined = 'en', apiKey = '') {
  const text = (apiKey ? String(value || 'Request failed').replaceAll(apiKey, '[redacted]') : String(value || 'Request failed')).replace(/^Error:\s*/i, '').trim()
  let parsed: any
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  if (start >= 0 && end > start) try { parsed = JSON.parse(text.slice(start, end + 1)) } catch {}
  const detail = parsed?.error ?? parsed
  let nested = detail
  if (typeof nested === 'string' && nested.trim().startsWith('{')) try { nested = JSON.parse(nested) } catch {}
  const code = Number(nested?.code ?? parsed?.code) || Number(text.match(/\b([45]\d\d)\b/)?.[1]) || 0
  const status = String(nested?.status ?? parsed?.status ?? '').trim()
  const message = String(nested?.message ?? parsed?.message ?? '').replace(/\s+/g, ' ').trim()
  if (message) return `${code || status ? `${code || status} ` : ''}${message}`.trim().slice(0, 500)
  const zh = language === 'zh-CN'
  if (code === 404 || /not found/i.test(status)) return zh ? '404 Not Found：Provider 请求路径、API 格式或模型 ID 不匹配。' : '404 Not Found: the provider path, API format, or model ID does not match.'
  if (code === 401 || code === 403) return zh ? `${code}：API key 或认证方式无效。` : `${code}: the API key or authentication method is invalid.`
  if (code === 429) return zh ? '429：额度不足或请求过于频繁。' : '429: quota exhausted or too many requests.'
  return text.replace(/\s+/g, ' ').slice(0, 500)
}

export async function testModelDeployment(
  endpoint: string,
  apiKey: string | undefined,
  model: string,
  request: typeof fetch = fetch,
  api: ProviderApi = 'openai-completions',
): Promise<ProviderTestResult> {
  const startedAt = Date.now(), secret = apiKey || '', controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const connection = normalizeProviderConnection({ endpoint, api }), base = connection.endpoint
    if (!base || !model.trim()) throw Error('Base URL and Model ID are required')
    const path = api === 'openai-responses' ? '/responses'
      : api === 'anthropic-messages' ? (base.endsWith('/v1') ? '/messages' : '/v1/messages')
        : api === 'google-generative-ai' ? `/models/${encodeURIComponent(model.trim().replace(/^models\//, ''))}:generateContent`
          : api === 'azure-openai-responses' ? '/responses'
            : api === 'bedrock-converse-stream' ? `/model/${encodeURIComponent(model.trim())}/converse`
              : '/chat/completions'
    const url = new URL(`${base}${path}`)
    if (!['http:', 'https:'].includes(url.protocol)) throw Error('Base URL must use HTTP or HTTPS')
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(Error('Connection test timed out after 15 seconds'))
      }, TEST_TIMEOUT_MS)
    })
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (secret) {
      if (api === 'anthropic-messages') Object.assign(headers, { 'x-api-key': secret, 'anthropic-version': '2023-06-01' })
      else if (api === 'google-generative-ai') headers['x-goog-api-key'] = secret
      else if (api === 'azure-openai-responses') headers['api-key'] = secret
      else headers.authorization = `Bearer ${secret}`
    }
    const requestBody = api === 'openai-responses' || api === 'azure-openai-responses'
      ? { model: model.trim(), input: 'Reply with OK.', max_output_tokens: 16 }
      : api === 'anthropic-messages'
        ? { model: model.trim(), messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1 }
        : api === 'google-generative-ai'
          ? { contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }], generationConfig: { maxOutputTokens: 1 } }
          : api === 'bedrock-converse-stream'
            ? { messages: [{ role: 'user', content: [{ text: 'Reply with OK.' }] }], inferenceConfig: { maxTokens: 1 } }
            : { model: model.trim(), messages: [{ role: 'user', content: 'Reply with OK.' }], temperature: 0, max_tokens: 1, stream: false }
    const response = await Promise.race([request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    }), deadline])
    const responseBody = await Promise.race([response.text(), deadline])
    if (!response.ok) return { ok: false, latencyMs: Date.now() - startedAt, message: `${response.status} ${responseMessage(responseBody, secret)}` }
    try {
      const json = JSON.parse(responseBody)
      const valid = api === 'openai-completions' ? Array.isArray(json?.choices)
        : api === 'anthropic-messages' ? Array.isArray(json?.content)
          : api === 'google-generative-ai' ? Array.isArray(json?.candidates)
            : api === 'bedrock-converse-stream' ? Boolean(json?.output)
              : Array.isArray(json?.output)
      if (!valid) throw Error('Provider returned no model output')
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

export async function listProviderModels(
  endpoint: string,
  apiKey: string | undefined,
  api: ProviderApi = 'openai-completions',
  request: typeof fetch = fetch,
) {
  const connection = normalizeProviderConnection({ endpoint, api }), base = connection.endpoint, secret = apiKey || ''
  if (!base) return []
  if (api === 'bedrock-converse-stream' || api === 'azure-openai-responses') return []
  const path = api === 'anthropic-messages'
    ? (base.endsWith('/v1') ? '/models' : '/v1/models')
    : '/models'
  const url = new URL(`${base}${path}`)
  if (api === 'google-generative-ai') url.searchParams.set('pageSize', '1000')
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('Base URL must use HTTP or HTTPS')
  const headers: Record<string, string> = {}
  if (secret) {
    if (api === 'anthropic-messages') Object.assign(headers, { 'x-api-key': secret, 'anthropic-version': '2023-06-01' })
    else if (api === 'google-generative-ai') headers['x-goog-api-key'] = secret
    else headers.authorization = `Bearer ${secret}`
  }
  const response = await request(url, { headers, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw Error(`${response.status} ${responseMessage(await response.text(), secret)}`)
  const json: any = await response.json()
  const values = api === 'google-generative-ai'
    ? (Array.isArray(json?.models) ? json.models : [])
      .filter((item: any) => !Array.isArray(item?.supportedGenerationMethods) || item.supportedGenerationMethods.includes('generateContent'))
      .map((item: any) => String(item?.name || '').replace(/^models\//, ''))
    : (Array.isArray(json?.data) ? json.data : []).map((item: any) => String(item?.id || ''))
  return [...new Set(values.filter(Boolean))]
}
