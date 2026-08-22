import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { McpClient, enabledMcpServers, resolveMcpServer, runMcpTool } from './mcp.ts'

async function fixture(handler?: (body: any, headers: Record<string, string | string[] | undefined>) => any) {
  const seen: Array<{ body: any; headers: Record<string, string | string[] | undefined> }> = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), headers = request.headers
    seen.push({ body, headers })
    const custom = handler?.(body, headers)
    if (custom) {
      response.writeHead(custom.status || 200, custom.headers || { 'content-type': 'application/json' })
      response.end(custom.raw ?? JSON.stringify(custom.body))
      return
    }
    if (body.method === 'initialize') {
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }))
      return
    }
    if (body.method === 'notifications/initialized') { response.writeHead(202).end(); return }
    if (body.method === 'tools/list') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'add', description: 'Add numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }] } }))
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: String(body.params.arguments.a + body.params.arguments.b) }], structuredContent: { sum: body.params.arguments.a + body.params.arguments.b } } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('fixture did not listen')
  return { url: `http://127.0.0.1:${address.port}/mcp`, seen, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

const settings = (url: string) => ({ mcpServers: [{ id: 'calc', name: 'Calculator', url, enabled: true }, { id: 'off', name: 'Off', url, enabled: false }] })

test('MCP configuration is an enabled allowlist and never accepts an arbitrary model URL', () => {
  const value = settings('http://127.0.0.1:1234/mcp')
  assert.deepEqual(enabledMcpServers(value).map(item => item.id), ['calc'])
  assert.equal(resolveMcpServer(value, 'Calculator').id, 'calc')
  assert.throws(() => resolveMcpServer(value, 'http://evil.example/mcp'), /Unknown or disabled/)
})

test('MCP initialize negotiates a session reused by tools/list and tools/call', async t => {
  const app = await fixture(); t.after(app.close)
  const client = new McpClient(), value = settings(app.url)
  const listed = await runMcpTool('mcp_list', { server: 'calc' }, value, client)
  assert.match(listed.output, /add — Add numbers/)
  const called = await runMcpTool('mcp_call', { server: 'calc', name: 'add', arguments: { a: 2, b: 5 } }, value, client)
  assert.match(called.output, /^7\n\nstructuredContent:/)
  assert.equal(app.seen.filter(row => row.body.method === 'initialize').length, 1)
  const list = app.seen.find(row => row.body.method === 'tools/list')!
  assert.equal(list.headers['mcp-session-id'], 'session-1')
  assert.equal(list.headers['mcp-protocol-version'], '2025-06-18')
})

test('MCP parses SSE JSON-RPC responses', async t => {
  const app = await fixture((body) => body.method === 'tools/list' ? {
    headers: { 'content-type': 'text/event-stream' },
    raw: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })}\n\n`,
  } : undefined)
  t.after(app.close)
  const output = await new McpClient().listTools(settings(app.url), 'calc')
  assert.match(output, /Tools \(0\):/)
})

test('MCP invalid sessions are reinitialized once', async t => {
  let expired = true
  const app = await fixture((body) => body.method === 'tools/list' && expired ? (expired = false, { status: 404, raw: 'expired session' }) : undefined)
  t.after(app.close)
  const output = await new McpClient().listTools(settings(app.url), 'calc')
  assert.match(output, /add/)
  assert.equal(app.seen.filter(row => row.body.method === 'initialize').length, 2)
})

test('MCP tool-level errors fail the harness call and preserve bounded diagnostics', async t => {
  const app = await fixture(body => body.method === 'tools/call' ? {
    body: { jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: 'bad input' }] } },
  } : undefined)
  t.after(app.close)
  await assert.rejects(() => new McpClient().callTool(settings(app.url), 'calc', 'add', {}), /reported an error:\nbad input/)
})

test('mcp_list without a selector only reveals configured enabled servers', async () => {
  const output = await runMcpTool('mcp_list', {}, settings('http://127.0.0.1:1234/mcp'), new McpClient())
  assert.match(output.output, /^calc — Calculator/)
  assert.doesNotMatch(output.output, /Off/)
})

test('MCP stdio transport owns one long-lived process and negotiates normal tool calls', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shun-mcp-stdio-')), script = join(root, 'server.mjs')
  await writeFile(script, `
    import readline from 'node:readline'
    const input = readline.createInterface({ input: process.stdin })
    input.on('line', line => {
      const body = JSON.parse(line)
      if (body.method === 'notifications/initialized') return
      const result = body.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stdio-fixture', version: '1' } }
        : body.method === 'tools/list'
          ? { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
          : { content: [{ type: 'text', text: body.params.arguments.text }] }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) + '\\n')
    })
  `)
  const value = { mcpServers: [{ id: 'stdio', name: 'Stdio', transport: 'stdio' as const, command: process.execPath, args: [script], enabled: true }] }
  const client = new McpClient(); t.after(() => client.dispose())
  assert.equal(await client.toolCount(value, 'stdio'), 1)
  assert.equal(await client.callTool(value, 'stdio', 'echo', { text: 'hello' }), 'hello')
})
