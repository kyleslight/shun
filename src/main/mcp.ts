import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { McpServer, Settings } from '../shared'

type Session = { id?: string; protocolVersion: string }
type FetchLike = typeof fetch

const DEFAULT_PROTOCOL = '2025-06-18'
const MAX_PAGES = 8
const MAX_TOOLS = 100
const MAX_OUTPUT = 12_000

export function enabledMcpServers(settings: Pick<Settings, 'mcpServers'>): McpServer[] {
  return (settings.mcpServers || []).filter(server => server.enabled !== false && Boolean(server.id?.trim()) && Boolean(server.url?.trim() || server.command?.trim()))
}

export function resolveMcpServer(settings: Pick<Settings, 'mcpServers'>, selector: unknown): McpServer {
  const value = String(selector || '').trim()
  const servers = enabledMcpServers(settings)
  const server = servers.find(item => item.id === value || item.name.toLowerCase() === value.toLowerCase())
  if (!server) throw Error(`Unknown or disabled MCP server: ${value || '(missing)'}. Call mcp_list without a server to see configured servers.`)
  const transport = server.transport || (server.command ? 'stdio' : 'http')
  if (transport === 'stdio') {
    if (!server.command?.trim()) throw Error(`Missing MCP command configured for ${server.name}.`)
    return { ...server, transport, command: server.command.trim(), args: server.args || [] }
  }
  let url: URL
  try { url = new URL(server.url || '') } catch { throw Error(`Invalid MCP server URL configured for ${server.name}.`) }
  if (!['http:', 'https:'].includes(url.protocol)) throw Error(`Unsupported MCP transport for ${server.name}; configure an HTTP(S) Streamable HTTP endpoint.`)
  return { ...server, transport, url: url.toString() }
}

export class McpClient {
  private sessions = new Map<string, Session>()
  private stdio = new Map<string, StdioConnection>()
  private nextId = 1
  private readonly fetcher: FetchLike
  private tokenProvider?: (server: McpServer) => Promise<string | undefined>
  constructor(fetcher: FetchLike = fetch) { this.fetcher = fetcher }

  setTokenProvider(provider: (server: McpServer) => Promise<string | undefined>) { this.tokenProvider = provider }

  clear(server: McpServer) { this.sessions.delete(this.key(server)) }

  dispose() {
    for (const connection of this.stdio.values()) connection.dispose()
    this.stdio.clear()
    this.sessions.clear()
  }

  async listConfigured(settings: Pick<Settings, 'mcpServers'>) {
    const servers = enabledMcpServers(settings)
    if (!servers.length) return 'No enabled MCP servers are configured in Settings.'
    return servers.map(server => `${server.id} — ${server.name} (${server.transport === 'stdio' || server.command ? [server.command, ...(server.args || [])].filter(Boolean).join(' ') : server.url})`).join('\n')
  }

  async listTools(settings: Pick<Settings, 'mcpServers'>, selector: unknown) {
    const server = resolveMcpServer(settings, selector)
    return this.withSessionRetry(server, async session => {
      const { tools, truncated } = await this.tools(server, session)
      const rows = tools.map(tool => {
        const schema = tool?.inputSchema && typeof tool.inputSchema === 'object' ? JSON.stringify(tool.inputSchema) : '{}'
        return `${String(tool?.name || '(unnamed)')} — ${String(tool?.description || 'No description.')}\ninputSchema: ${bounded(schema, 2_000)}`
      })
      return bounded(`MCP server: ${server.name} (${server.id})\nTools (${tools.length}${truncated ? '+' : ''}):\n${rows.join('\n\n') || '(none)'}`, MAX_OUTPUT)
    })
  }

  async toolCount(settings: Pick<Settings, 'mcpServers'>, selector: unknown) {
    const server = resolveMcpServer(settings, selector)
    return this.withSessionRetry(server, async session => (await this.tools(server, session)).tools.length)
  }

  async callTool(settings: Pick<Settings, 'mcpServers'>, selector: unknown, name: unknown, args: unknown) {
    const server = resolveMcpServer(settings, selector), toolName = String(name || '').trim()
    if (!toolName) throw Error('MCP tool name is required.')
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('MCP tool arguments must be a JSON object.')
    return this.withSessionRetry(server, async session => {
      const result = await this.request(server, session, 'tools/call', { name: toolName, arguments: args })
      const output = formatMcpResult(result)
      if (result?.isError) throw Error(`MCP tool ${server.name}/${toolName} reported an error:\n${output}`)
      return bounded(output || 'MCP tool completed with no content.', MAX_OUTPUT)
    })
  }

  private key(server: McpServer) { return `${server.id}\0${server.transport || ''}\0${server.url || ''}\0${server.command || ''}\0${(server.args || []).join('\0')}` }

  private async withSessionRetry<T>(server: McpServer, action: (session: Session) => Promise<T>): Promise<T> {
    let session = await this.session(server)
    try { return await action(session) }
    catch (error) {
      if (!isSessionFailure(error)) throw error
      this.clear(server)
      session = await this.session(server)
      return action(session)
    }
  }

  private async session(server: McpServer) {
    const key = this.key(server), existing = this.sessions.get(key)
    if (existing) return existing
    const response = await this.post(server, undefined, {
      jsonrpc: '2.0', id: this.nextId++, method: 'initialize',
      params: { protocolVersion: DEFAULT_PROTOCOL, capabilities: {}, clientInfo: { name: 'Shun', version: '0.1.0' } },
    })
    const version = String(response.json?.result?.protocolVersion || '')
    if (!version) throw Error(`MCP server ${server.name} returned an invalid initialize result.`)
    const session = { id: response.sessionId, protocolVersion: version }
    this.sessions.set(key, session)
    try { await this.post(server, session, { jsonrpc: '2.0', method: 'notifications/initialized' }) } catch {}
    return session
  }

  private async request(server: McpServer, session: Session, method: string, params: Record<string, unknown>) {
    const id = this.nextId++
    const response = await this.post(server, session, { jsonrpc: '2.0', id, method, params })
    if (response.json?.error) throw Error(`MCP ${method} failed (${response.json.error.code ?? 'error'}): ${String(response.json.error.message || 'Unknown JSON-RPC error')}`)
    if (response.json?.id !== id) throw Error(`MCP server ${server.name} returned a mismatched JSON-RPC response id.`)
    return response.json?.result
  }

  private async tools(server: McpServer, session: Session) {
    const tools: any[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES && tools.length < MAX_TOOLS; page++) {
      const result = await this.request(server, session, 'tools/list', cursor ? { cursor } : {})
      if (!Array.isArray(result?.tools)) throw Error(`MCP server ${server.name} returned an invalid tools/list result.`)
      tools.push(...result.tools.slice(0, MAX_TOOLS - tools.length))
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
      if (!cursor) break
    }
    return { tools, truncated: Boolean(cursor) }
  }

  private async post(server: McpServer, session: Session | undefined, body: Record<string, unknown>) {
    if (server.transport === 'stdio') {
      const key = this.key(server)
      let connection = this.stdio.get(key)
      if (!connection) {
        connection = new StdioConnection(server)
        this.stdio.set(key, connection)
      }
      try { return { json: await connection.send(body), sessionId: undefined } }
      catch (error) { connection.dispose(); this.stdio.delete(key); throw error }
    }
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...safeHeaders(server.headers) }
    const accessToken = await this.tokenProvider?.(server)
    if (accessToken) headers.authorization = `Bearer ${accessToken}`
    if (session?.id) headers['mcp-session-id'] = session.id
    if (session?.protocolVersion) headers['mcp-protocol-version'] = session.protocolVersion
    const response = await this.fetcher(server.url!, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    const raw = await response.text()
    if (!response.ok) throw Error(`MCP HTTP ${response.status} from ${server.name}: ${bounded(raw || response.statusText, 1_000)}`)
    if (!raw.trim()) return { json: undefined, sessionId: response.headers.get('mcp-session-id') || undefined }
    const json = parseMcpBody(raw, response.headers.get('content-type') || '')
    return { json, sessionId: response.headers.get('mcp-session-id') || undefined }
  }
}

class StdioConnection {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  #buffer = ''
  #stderr = ''
  #closed = false

  constructor(server: McpServer) {
    this.#child = spawn(server.command!, server.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...(server.env || {}) },
    })
    this.#child.stdout.setEncoding('utf8')
    this.#child.stderr.setEncoding('utf8')
    this.#child.stdout.on('data', chunk => this.#consume(String(chunk)))
    this.#child.stderr.on('data', chunk => { this.#stderr = bounded(`${this.#stderr}${String(chunk)}`, 4_000) })
    this.#child.on('error', error => this.#fail(error))
    this.#child.on('exit', (code, signal) => this.#fail(Error(`MCP process ${server.name} exited (${code ?? signal ?? 'unknown'}).${this.#stderr ? `\n${this.#stderr}` : ''}`)))
  }

  send(body: Record<string, unknown>): Promise<any> {
    if (this.#closed) return Promise.reject(Error('MCP stdio process is closed.'))
    const id = typeof body.id === 'number' ? body.id : undefined
    if (id === undefined) {
      this.#child.stdin.write(`${JSON.stringify(body)}\n`)
      return Promise.resolve(undefined)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(Error(`MCP stdio request timed out.${this.#stderr ? `\n${this.#stderr}` : ''}`))
      }, 30_000)
      timer.unref()
      this.#pending.set(id, { resolve, reject, timer })
      this.#child.stdin.write(`${JSON.stringify(body)}\n`, error => {
        if (!error) return
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error)
      })
    })
  }

  dispose() {
    if (this.#closed) return
    this.#closed = true
    this.#child.kill('SIGTERM')
    this.#fail(Error('MCP stdio process closed.'))
  }

  #consume(chunk: string) {
    this.#buffer += chunk
    for (;;) {
      const boundary = this.#buffer.indexOf('\n')
      if (boundary < 0) break
      const line = this.#buffer.slice(0, boundary).trim()
      this.#buffer = this.#buffer.slice(boundary + 1)
      if (!line) continue
      let message: any
      try { message = JSON.parse(line) } catch { this.#fail(Error(`MCP stdio returned invalid JSON: ${bounded(line, 500)}`)); return }
      if (typeof message?.id === 'number' && typeof message?.method === 'string') {
        this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Client method not supported: ${message.method}` } })}\n`)
        continue
      }
      const pending = typeof message?.id === 'number' ? this.#pending.get(message.id) : undefined
      if (!pending) continue
      clearTimeout(pending.timer)
      this.#pending.delete(message.id)
      pending.resolve(message)
    }
    if (this.#buffer.length > 2_000_000) this.#fail(Error('MCP stdio message exceeded the client boundary.'))
  }

  #fail(error: Error) {
    if (!this.#closed) this.#closed = true
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.#pending.clear()
  }
}

export const mcpClient = new McpClient()

export async function runMcpTool(name: string, args: any, settings: Pick<Settings, 'mcpServers'>, client = mcpClient) {
  if (name === 'mcp_list') return { output: args?.server ? await client.listTools(settings, args.server) : await client.listConfigured(settings) }
  if (name === 'mcp_call') return { output: await client.callTool(settings, args?.server, args?.name, args?.arguments ?? {}) }
  throw Error(`Unknown MCP harness tool: ${name}`)
}

function parseMcpBody(raw: string, contentType: string) {
  if (/text\/event-stream/i.test(contentType) || /^\s*(?:event:|data:)/m.test(raw)) {
    const values = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean)
    for (const value of values) try { return JSON.parse(value) } catch {}
    throw Error('MCP server returned an event stream without a JSON-RPC data event.')
  }
  try { return JSON.parse(raw) } catch { throw Error(`MCP server returned invalid JSON: ${bounded(raw, 500)}`) }
}

function formatMcpResult(result: any) {
  const rows: string[] = []
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type === 'text') rows.push(String(item.text || ''))
    else if (item?.type === 'resource_link') rows.push(`[resource] ${item.name || item.title || item.uri}: ${item.uri || ''}`)
    else if (item?.type === 'resource') rows.push(`[resource] ${item.resource?.uri || ''}\n${String(item.resource?.text || '[binary resource omitted]')}`)
    else if (item?.type === 'image') rows.push(`[image ${item.mimeType || 'unknown'} omitted; ${String(item.data || '').length} base64 characters]`)
    else if (item?.type === 'audio') rows.push(`[audio ${item.mimeType || 'unknown'} omitted; ${String(item.data || '').length} base64 characters]`)
    else rows.push(`[${String(item?.type || 'content')}] ${bounded(JSON.stringify(item), 1_000)}`)
  }
  if (result?.structuredContent !== undefined) rows.push(`structuredContent:\n${JSON.stringify(result.structuredContent, null, 2)}`)
  return bounded(rows.filter(Boolean).join('\n\n'), MAX_OUTPUT)
}

function bounded(value: string, limit: number) {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 42))}\n[truncated by MCP harness boundary]`
}

function isSessionFailure(error: unknown) {
  return /MCP HTTP (?:400|404|410)|session|mcp-session-id|stdio process/i.test(error instanceof Error ? error.message : String(error))
}

function safeHeaders(value: McpServer['headers']) {
  const headers: Record<string, string> = {}
  for (const [name, content] of Object.entries(value || {})) {
    if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !/[\r\n]/.test(content)) headers[name] = content
  }
  return headers
}
