import type { PluginConnectionState } from '../shared.ts'
import type { PluginSecretStore } from './plugin-secrets.ts'

type FetchLike = typeof fetch

const API = 'https://api.render.com/v1'
const MAX_OUTPUT = 30_000

export class RenderRestService {
  private readonly secrets: PluginSecretStore
  private readonly fetcher: FetchLike
  constructor(secrets: PluginSecretStore, fetcher: FetchLike = fetch) { this.secrets = secrets; this.fetcher = fetcher }

  async state(): Promise<PluginConnectionState> {
    const token = await this.secrets.get('render')
    if (!token) return { connected: false, status: 'disconnected' }
    try { return connectedState(await this.request('/owners?limit=20', token)) }
    catch (error) { return { connected: false, status: 'error', message: renderError(error) } }
  }

  async connect(tokenValue: unknown): Promise<PluginConnectionState> {
    const token = String(tokenValue || '').trim()
    if (!token || token.length > 2_000 || /[\r\n]/.test(token)) return { connected: false, status: 'error', message: 'Enter a valid Render API key.' }
    try {
      const workspaces = await this.request('/owners?limit=20', token)
      await this.secrets.set('render', token)
      return connectedState(workspaces)
    } catch (error) {
      return { connected: false, status: 'error', message: renderError(error) }
    }
  }

  async disconnect(): Promise<PluginConnectionState> {
    await this.secrets.delete('render')
    return { connected: false, status: 'disconnected', message: 'Render API key removed from this device.' }
  }

  async services(options: { ownerId?: unknown; name?: unknown; type?: unknown; limit?: unknown } = {}) {
    const query = new URLSearchParams()
    optionalQuery(query, 'ownerId', options.ownerId, 160)
    optionalQuery(query, 'name', options.name, 200)
    optionalQuery(query, 'type', options.type, 80)
    query.set('limit', String(clampInteger(options.limit, 1, 100, 20)))
    return this.authorizedRequest(`/services?${query}`)
  }

  async service(serviceIdValue: unknown) {
    const serviceId = resourceId(serviceIdValue, 'service')
    return this.authorizedRequest(`/services/${encodeURIComponent(serviceId)}`)
  }

  async deploys(serviceIdValue: unknown, options: { status?: unknown; limit?: unknown } = {}) {
    const serviceId = resourceId(serviceIdValue, 'service'), query = new URLSearchParams()
    optionalQuery(query, 'status', options.status, 80)
    query.set('limit', String(clampInteger(options.limit, 1, 100, 20)))
    return this.authorizedRequest(`/services/${encodeURIComponent(serviceId)}/deploys?${query}`)
  }

  async logs(options: { ownerId?: unknown; resourceId?: unknown; startTime?: unknown; endTime?: unknown; direction?: unknown; level?: unknown; type?: unknown; text?: unknown; limit?: unknown }) {
    const ownerId = resourceId(options.ownerId, 'workspace'), serviceId = resourceId(options.resourceId, 'resource'), query = new URLSearchParams()
    query.set('ownerId', ownerId)
    query.set('resource', serviceId)
    optionalTimestamp(query, 'startTime', options.startTime)
    optionalTimestamp(query, 'endTime', options.endTime)
    optionalEnum(query, 'direction', options.direction, ['forward', 'backward'])
    optionalQuery(query, 'level', options.level, 80)
    optionalQuery(query, 'type', options.type, 80)
    optionalQuery(query, 'text', options.text, 500)
    query.set('limit', String(clampInteger(options.limit, 1, 100, 50)))
    return this.authorizedRequest(`/logs?${query}`)
  }

  async triggerDeploy(serviceIdValue: unknown, options: { clearCache?: unknown; commitId?: unknown } = {}) {
    const serviceId = resourceId(serviceIdValue, 'service'), body: Record<string, unknown> = {
      clearCache: options.clearCache === true ? 'clear' : 'do_not_clear',
    }
    const commitId = String(options.commitId || '').trim()
    if (commitId) {
      if (!/^[A-Fa-f0-9]{7,64}$/.test(commitId)) throw Error('Render commit ID must be a 7–64 character Git SHA.')
      body.commitId = commitId
    }
    return this.authorizedRequest(`/services/${encodeURIComponent(serviceId)}/deploys`, { method: 'POST', body: JSON.stringify(body) })
  }

  private async authorizedRequest(path: string, init: RequestInit = {}) {
    const token = await this.secrets.get('render')
    if (!token) throw Error('Render is not connected. Add an API key in Plugins.')
    return boundedJson(await this.request(path, token, init))
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
    if (!response.ok) {
      const retry = response.headers.get('retry-after')
      const message = typeof value === 'object' ? value?.message || value?.error : value
      throw Error(`Render API ${response.status}: ${String(message || raw || response.statusText).slice(0, 1_000)}${retry ? ` Retry after ${retry}s.` : ''}`)
    }
    return value
  }
}

function connectedState(value: any): PluginConnectionState {
  const names = (Array.isArray(value) ? value : []).map(item => String(item?.owner?.name || item?.name || '').trim()).filter(Boolean)
  const account = names.slice(0, 3).join(', ')
  return { connected: true, status: 'connected', account, message: account ? `Connected to ${account}` : 'Render connected.' }
}

function resourceId(value: unknown, label: string) {
  const id = String(value || '').trim()
  if (!id || id.length > 160 || !/^[A-Za-z0-9_-]+$/.test(id)) throw Error(`Enter a valid Render ${label} ID.`)
  return id
}

function optionalQuery(query: URLSearchParams, name: string, value: unknown, maxLength: number) {
  const text = String(value || '').trim()
  if (!text) return
  if (text.length > maxLength || /[\r\n]/.test(text)) throw Error(`Render ${name} filter is invalid.`)
  query.set(name, text)
}

function optionalTimestamp(query: URLSearchParams, name: string, value: unknown) {
  const text = String(value || '').trim()
  if (!text) return
  const timestamp = new Date(text)
  if (!Number.isFinite(timestamp.getTime())) throw Error(`Render ${name} must be an ISO 8601 timestamp.`)
  query.set(name, timestamp.toISOString())
}

function optionalEnum(query: URLSearchParams, name: string, value: unknown, allowed: string[]) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return
  if (!allowed.includes(text)) throw Error(`Unsupported Render ${name}: ${text}`)
  query.set(name, text)
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value)
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback
}

function boundedJson(value: unknown) {
  const output = JSON.stringify(value)
  return output.length <= MAX_OUTPUT ? output : `${output.slice(0, MAX_OUTPUT - 50)}\n[truncated by Render tool boundary]`
}

function renderError(error: unknown) { return error instanceof Error ? error.message : String(error) }
