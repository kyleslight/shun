import type { PluginConnectionState } from '../shared.ts'
import type { PluginSecretStore } from './plugin-secrets.ts'

type FetchLike = typeof fetch

const API = 'https://api.cloudflare.com/client/v4'
const MAX_OUTPUT = 30_000

export class CloudflareRestService {
  private readonly secrets: PluginSecretStore
  private readonly fetcher: FetchLike
  constructor(secrets: PluginSecretStore, fetcher: FetchLike = fetch) { this.secrets = secrets; this.fetcher = fetcher }

  async state(): Promise<PluginConnectionState> {
    const token = await this.secrets.get('cloudflare')
    if (!token) return { connected: false, status: 'disconnected' }
    try { return connectedState(await this.request('/user/tokens/verify', token)) }
    catch (error) { return { connected: false, status: 'error', message: cloudflareError(error) } }
  }

  async connect(tokenValue: unknown): Promise<PluginConnectionState> {
    const token = String(tokenValue || '').trim()
    if (!token || token.length > 2_000 || /[\r\n]/.test(token)) return { connected: false, status: 'error', message: 'Enter a valid Cloudflare API token.' }
    try {
      const verified = await this.request('/user/tokens/verify', token)
      const state = connectedState(verified)
      if (!state.connected) return state
      await this.secrets.set('cloudflare', token)
      return state
    } catch (error) {
      return { connected: false, status: 'error', message: cloudflareError(error) }
    }
  }

  async disconnect(): Promise<PluginConnectionState> {
    await this.secrets.delete('cloudflare')
    return { connected: false, status: 'disconnected', message: 'Cloudflare API token removed from this device.' }
  }

  async accounts(options: { name?: unknown; limit?: unknown } = {}) {
    const query = new URLSearchParams({ page: '1', per_page: String(clampInteger(options.limit, 5, 50, 20)) })
    optionalQuery(query, 'name', options.name, 100)
    return this.authorizedRequest(`/accounts?${query}`)
  }

  async zones(options: { accountId?: unknown; name?: unknown; status?: unknown; limit?: unknown } = {}) {
    const query = new URLSearchParams({ page: '1', per_page: String(clampInteger(options.limit, 5, 50, 20)) })
    if (String(options.accountId || '').trim()) query.set('account.id', cloudflareId(options.accountId, 'account'))
    optionalQuery(query, 'name', options.name, 253)
    optionalEnum(query, 'status', options.status, ['initializing', 'pending', 'active', 'moved'])
    return this.authorizedRequest(`/zones?${query}`)
  }

  async dnsRecords(zoneIdValue: unknown, options: { name?: unknown; type?: unknown; proxied?: unknown; limit?: unknown } = {}) {
    const zoneId = cloudflareId(zoneIdValue, 'zone')
    const query = new URLSearchParams({ page: '1', per_page: String(clampInteger(options.limit, 1, 100, 50)) })
    optionalQuery(query, 'name', options.name, 253)
    optionalEnum(query, 'type', options.type, ['A', 'AAAA', 'CAA', 'CERT', 'CNAME', 'DNSKEY', 'DS', 'HTTPS', 'LOC', 'MX', 'NAPTR', 'NS', 'OPENPGPKEY', 'PTR', 'SMIMEA', 'SRV', 'SSHFP', 'SVCB', 'TLSA', 'TXT', 'URI'], false)
    if (typeof options.proxied === 'boolean') query.set('proxied', String(options.proxied))
    return this.authorizedRequest(`/zones/${zoneId}/dns_records?${query}`)
  }

  async workers(accountIdValue: unknown, options: { tags?: unknown } = {}) {
    const accountId = cloudflareId(accountIdValue, 'account'), query = new URLSearchParams()
    optionalQuery(query, 'tags', options.tags, 500)
    return this.authorizedRequest(`/accounts/${accountId}/workers/scripts${query.size ? `?${query}` : ''}`)
  }

  async workerDeployments(accountIdValue: unknown, scriptNameValue: unknown) {
    const accountId = cloudflareId(accountIdValue, 'account'), scriptName = namedPathSegment(scriptNameValue, 'Worker script', 255)
    return this.authorizedRequest(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/deployments`)
  }

  async pagesProjects(accountIdValue: unknown, options: { limit?: unknown } = {}) {
    const accountId = cloudflareId(accountIdValue, 'account')
    const query = new URLSearchParams({ page: '1', per_page: String(clampInteger(options.limit, 1, 50, 20)) })
    return this.authorizedRequest(`/accounts/${accountId}/pages/projects?${query}`)
  }

  async pagesDeployments(accountIdValue: unknown, projectNameValue: unknown, options: { environment?: unknown; limit?: unknown } = {}) {
    const accountId = cloudflareId(accountIdValue, 'account'), projectName = namedPathSegment(projectNameValue, 'Pages project', 80)
    const query = new URLSearchParams({ page: '1', per_page: String(clampInteger(options.limit, 1, 50, 20)) })
    optionalEnum(query, 'env', options.environment, ['production', 'preview'])
    return this.authorizedRequest(`/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}/deployments?${query}`)
  }

  async pagesDeploymentLogs(accountIdValue: unknown, projectNameValue: unknown, deploymentIdValue: unknown) {
    const accountId = cloudflareId(accountIdValue, 'account'), projectName = namedPathSegment(projectNameValue, 'Pages project', 80), deploymentId = deploymentIdValueOf(deploymentIdValue)
    return this.authorizedRequest(`/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}/deployments/${deploymentId}/history/logs`)
  }

  async retryPagesDeployment(accountIdValue: unknown, projectNameValue: unknown, deploymentIdValue: unknown) {
    const accountId = cloudflareId(accountIdValue, 'account'), projectName = namedPathSegment(projectNameValue, 'Pages project', 80), deploymentId = deploymentIdValueOf(deploymentIdValue)
    return this.authorizedRequest(`/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}/deployments/${deploymentId}/retry`, { method: 'POST' })
  }

  async purgeCache(zoneIdValue: unknown, options: { files?: unknown; purgeEverything?: unknown }) {
    const zoneId = cloudflareId(zoneIdValue, 'zone'), files = Array.isArray(options.files) ? options.files.map(cacheUrl) : []
    const purgeEverything = options.purgeEverything === true
    if (purgeEverything === Boolean(files.length)) throw Error('Choose either purge_everything=true or one or more explicit Cloudflare cache URLs.')
    if (files.length > 30) throw Error('Cloudflare cache purge accepts at most 30 explicit URLs per call.')
    const body = purgeEverything ? { purge_everything: true } : { files }
    return this.authorizedRequest(`/zones/${zoneId}/purge_cache`, { method: 'POST', body: JSON.stringify(body) })
  }

  private async authorizedRequest(path: string, init: RequestInit = {}) {
    const token = await this.secrets.get('cloudflare')
    if (!token) throw Error('Cloudflare is not connected. Add an API token in Plugins.')
    return boundedJson(sanitize(await this.request(path, token, init)))
  }

  private async request(path: string, token: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    headers.set('accept', 'application/json')
    if (init.body) headers.set('content-type', 'application/json')
    const response = await this.fetcher(`${API}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) })
    const raw = await response.text()
    let value: any
    try { value = raw ? JSON.parse(raw) : {} } catch { value = raw }
    if (!response.ok || (value && typeof value === 'object' && value.success === false)) {
      const retry = response.headers.get('retry-after')
      const apiErrors = Array.isArray(value?.errors) ? value.errors.map((item: any) => item?.message).filter(Boolean).join('; ') : ''
      const message = apiErrors || value?.message || value?.error || raw || response.statusText
      throw Error(`Cloudflare API ${response.status}: ${String(message).slice(0, 1_000)}${retry ? ` Retry after ${retry}s.` : ''}`)
    }
    return value
  }
}

function connectedState(value: any): PluginConnectionState {
  const status = String(value?.result?.status || '').toLowerCase()
  if (value?.success !== true || status !== 'active') return { connected: false, status: 'error', message: `Cloudflare API token is ${status || 'not active'}.` }
  const expires = String(value?.result?.expires_on || '').trim()
  return { connected: true, status: 'connected', message: expires ? `Cloudflare connected. Token expires ${expires}.` : 'Cloudflare connected.' }
}

function cloudflareId(value: unknown, label: string) {
  const id = String(value || '').trim()
  if (!/^[A-Fa-f0-9]{32}$/.test(id)) throw Error(`Enter a valid 32-character Cloudflare ${label} ID.`)
  return id
}

function deploymentIdValueOf(value: unknown) {
  const id = String(value || '').trim()
  if (!/^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/.test(id)) throw Error('Enter a valid Cloudflare deployment ID.')
  return id
}

function namedPathSegment(value: unknown, label: string, maxLength: number) {
  const text = String(value || '').trim()
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f/\\]/.test(text)) throw Error(`Enter a valid Cloudflare ${label} name.`)
  return text
}

function optionalQuery(query: URLSearchParams, name: string, value: unknown, maxLength: number) {
  const text = String(value || '').trim()
  if (!text) return
  if (text.length > maxLength || /[\r\n]/.test(text)) throw Error(`Cloudflare ${name} filter is invalid.`)
  query.set(name, text)
}

function optionalEnum(query: URLSearchParams, name: string, value: unknown, allowed: string[], lower = true) {
  const raw = String(value || '').trim(), text = lower ? raw.toLowerCase() : raw.toUpperCase()
  if (!text) return
  if (!allowed.includes(text)) throw Error(`Unsupported Cloudflare ${name}: ${text}`)
  query.set(name, text)
}

function cacheUrl(value: unknown) {
  const text = String(value || '').trim()
  if (!text || text.length > 2_048 || /[\r\n]/.test(text)) throw Error('Cloudflare cache URLs must be valid HTTPS URLs.')
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw Error()
    return url.href
  } catch { throw Error('Cloudflare cache URLs must be valid HTTPS URLs.') }
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value)
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback
}

const sensitiveKeys = new Set(['env_vars', 'secrets', 'jwt', 'token', 'api_token', 'upload_token', 'web_analytics_token'])

function sanitize(value: unknown, key = ''): unknown {
  if (sensitiveKeys.has(key.toLowerCase())) return '[redacted by Cloudflare tool boundary]'
  if (Array.isArray(value)) return value.map(item => sanitize(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]))
  return value
}

function boundedJson(value: unknown) {
  const output = JSON.stringify(value)
  return output.length <= MAX_OUTPUT ? output : `${output.slice(0, MAX_OUTPUT - 54)}\n[truncated by Cloudflare tool boundary]`
}

function cloudflareError(error: unknown) { return error instanceof Error ? error.message : String(error) }
