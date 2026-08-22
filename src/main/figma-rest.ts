import type { PluginConnectionState } from '../shared.ts'
import type { PluginSecretStore } from './plugin-secrets.ts'

type FetchLike = typeof fetch
type FigmaTarget = { fileKey: string; nodeId?: string }

const API = 'https://api.figma.com/v1'
const MAX_OUTPUT = 20_000

export class FigmaRestService {
  private readonly secrets: PluginSecretStore
  private readonly fetcher: FetchLike
  constructor(secrets: PluginSecretStore, fetcher: FetchLike = fetch) { this.secrets = secrets; this.fetcher = fetcher }

  async state(): Promise<PluginConnectionState> {
    const token = await this.secrets.get('figma')
    if (!token) return { connected: false, status: 'disconnected' }
    try {
      const user = await this.request('/me', token)
      const account = String(user?.email || user?.handle || '')
      return { connected: true, status: 'connected', account, message: account ? `Connected as ${account}` : 'Figma connected.' }
    } catch (error) {
      return { connected: false, status: 'error', message: figmaError(error) }
    }
  }

  async connect(tokenValue: unknown): Promise<PluginConnectionState> {
    const token = String(tokenValue || '').trim()
    if (!token || token.length > 2_000 || /[\r\n]/.test(token)) return { connected: false, status: 'error', message: 'Enter a valid Figma Personal Access Token.' }
    try {
      const user = await this.request('/me', token)
      await this.secrets.set('figma', token)
      const account = String(user?.email || user?.handle || '')
      return { connected: true, status: 'connected', account, message: account ? `Connected as ${account}` : 'Figma connected.' }
    } catch (error) {
      return { connected: false, status: 'error', message: figmaError(error) }
    }
  }

  async disconnect(): Promise<PluginConnectionState> {
    await this.secrets.delete('figma')
    return { connected: false, status: 'disconnected', message: 'Figma token removed from this device.' }
  }

  async readDesign(url: unknown, options: { depth?: number; maxNodes?: number } = {}) {
    const target = parseFigmaUrl(url), depth = clamp(options.depth, 1, 4, 2), maxNodes = clamp(options.maxNodes, 10, 200, 120)
    const path = target.nodeId
      ? `/files/${encodeURIComponent(target.fileKey)}/nodes?ids=${encodeURIComponent(target.nodeId)}&depth=${depth}`
      : `/files/${encodeURIComponent(target.fileKey)}?depth=${depth}`
    const value = await this.authorizedRequest(path)
    const root = target.nodeId ? value?.nodes?.[target.nodeId]?.document : value?.document
    if (!root) throw Error('Figma did not return the requested file or node.')
    const budget = { remaining: maxNodes, truncated: false }
    const output = {
      source: { fileKey: target.fileKey, nodeId: target.nodeId, name: value?.name, lastModified: value?.lastModified, version: value?.version },
      node: compactNode(root, budget),
      components: compactRecord(value?.components, 80, ['name', 'description', 'key', 'componentSetId', 'documentationLinks']),
      componentSets: compactRecord(value?.componentSets, 40, ['name', 'description', 'key']),
      styles: compactRecord(value?.styles, 80, ['name', 'description', 'key', 'styleType']),
      truncated: budget.truncated,
    }
    return boundedJson(output)
  }

  async renderNode(url: unknown, options: { format?: string; scale?: number } = {}) {
    const target = requireNode(parseFigmaUrl(url)), format = enumValue(options.format, ['png', 'jpg', 'svg', 'pdf'], 'png'), scale = clamp(options.scale, 0.01, 4, 2)
    const value = await this.authorizedRequest(`/images/${encodeURIComponent(target.fileKey)}?ids=${encodeURIComponent(target.nodeId!)}&format=${format}&scale=${scale}`)
    const rendered = value?.images?.[target.nodeId!]
    if (!rendered) throw Error(value?.err || 'Figma could not render this node.')
    return boundedJson({ nodeId: target.nodeId, format, scale, url: rendered })
  }

  async imageAssets(url: unknown) {
    const target = parseFigmaUrl(url), value = await this.authorizedRequest(`/files/${encodeURIComponent(target.fileKey)}/images`)
    const images = value?.meta?.images || value?.images || {}
    return boundedJson({ fileKey: target.fileKey, images: Object.fromEntries(Object.entries(images).slice(0, 200)), truncated: Object.keys(images).length > 200 })
  }

  async variables(url: unknown) {
    const target = parseFigmaUrl(url)
    try {
      const value = await this.authorizedRequest(`/files/${encodeURIComponent(target.fileKey)}/variables/local`)
      const meta = value?.meta || {}
      return boundedJson({
        fileKey: target.fileKey,
        collections: compactRecord(meta.variableCollections, 120, ['id', 'name', 'modes', 'defaultModeId', 'remote', 'variableIds']),
        variables: compactRecord(meta.variables, 400, ['id', 'name', 'variableCollectionId', 'resolvedType', 'valuesByMode', 'remote', 'description', 'scopes', 'codeSyntax']),
      })
    } catch (error) {
      if (/403|limited by figma plan|incorrect account type/i.test(figmaError(error))) {
        return boundedJson({ fileKey: target.fileKey, available: false, message: 'Full variable definitions require the Figma Variables REST API, which is limited to eligible Enterprise organization members. Bound variable IDs may still appear in figma_read_design output.' })
      }
      throw error
    }
  }

  private async authorizedRequest(path: string) {
    const token = await this.secrets.get('figma')
    if (!token) throw Error('Figma is not connected. Add a Personal Access Token in Plugins.')
    return this.request(path, token)
  }

  private async request(path: string, token: string) {
    const response = await this.fetcher(`${API}${path}`, { headers: { 'x-figma-token': token, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    const raw = await response.text()
    let value: any
    try { value = raw ? JSON.parse(raw) : {} } catch { value = {} }
    if (!response.ok) {
      const retry = response.headers.get('retry-after')
      throw Error(`Figma REST ${response.status}: ${String(value?.message || value?.err || raw || response.statusText).slice(0, 1_000)}${retry ? ` Retry after ${retry}s.` : ''}`)
    }
    return value
  }
}

export function parseFigmaUrl(value: unknown): FigmaTarget {
  let url: URL
  try { url = new URL(String(value || '').trim()) } catch { throw Error('Enter a valid Figma file or node URL.') }
  if (!/(?:^|\.)figma\.com$/i.test(url.hostname)) throw Error('Only figma.com file URLs are supported.')
  const parts = url.pathname.split('/').filter(Boolean), type = parts[0]?.toLowerCase()
  if (!['design', 'file', 'proto', 'board', 'make', 'slides'].includes(type) || !/^[A-Za-z0-9_-]{6,}$/.test(parts[1] || '')) throw Error('The Figma URL does not contain a valid file key.')
  const rawNode = url.searchParams.get('node-id') || url.searchParams.get('node_id') || ''
  const nodeId = /^\d+-\d+$/.test(rawNode) ? rawNode.replace('-', ':') : rawNode
  if (nodeId && !/^[A-Za-z0-9:_-]{1,160}$/.test(nodeId)) throw Error('The Figma URL contains an invalid node ID.')
  return { fileKey: parts[1], nodeId: nodeId || undefined }
}

function compactNode(node: any, budget: { remaining: number; truncated: boolean }): any {
  if (!node || typeof node !== 'object') return undefined
  if (budget.remaining-- <= 0) { budget.truncated = true; return undefined }
  const output: Record<string, unknown> = {}
  const fields = ['id', 'name', 'type', 'visible', 'componentId', 'componentProperties', 'layoutMode', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'layoutSizingHorizontal', 'layoutSizingVertical', 'itemSpacing', 'counterAxisSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'cornerRadius', 'opacity', 'blendMode', 'characters', 'style', 'styles', 'boundVariables', 'absoluteBoundingBox', 'constraints', 'fills', 'strokes', 'strokeWeight', 'effects']
  for (const field of fields) if (node[field] !== undefined) output[field] = compactValue(node[field])
  if (Array.isArray(node.children)) {
    const children = node.children.map((child: any) => compactNode(child, budget)).filter(Boolean)
    if (children.length) output.children = children
    if (children.length < node.children.length) budget.truncated = true
  }
  return output
}

function compactValue(value: any): any {
  if (Array.isArray(value)) return value.slice(0, 40).map(compactValue)
  if (!value || typeof value !== 'object') return typeof value === 'string' && value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 60)) {
    if (['imageTransform', 'gradientHandlePositions'].includes(key)) continue
    output[key] = compactValue(item)
  }
  return output
}

function compactRecord(value: any, max: number, fields: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value).slice(0, max).map(([key, item]: [string, any]) => [key, Object.fromEntries(fields.filter(field => item?.[field] !== undefined).map(field => [field, compactValue(item[field])]))])
  return entries.length ? Object.fromEntries(entries) : undefined
}

function requireNode(target: FigmaTarget) {
  if (!target.nodeId) throw Error('Use a Figma node URL containing node-id for this operation.')
  return target
}
function clamp(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}
function enumValue(value: unknown, allowed: string[], fallback: string) { return allowed.includes(String(value || '').toLowerCase()) ? String(value).toLowerCase() : fallback }
function boundedJson(value: unknown) {
  const output = JSON.stringify(value)
  return output.length <= MAX_OUTPUT ? output : `${output.slice(0, MAX_OUTPUT - 50)}\n[truncated by Figma tool boundary]`
}
function figmaError(error: unknown) { return error instanceof Error ? error.message : String(error) }
