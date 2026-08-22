import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runPiAgent } from './pi-runtime.ts'
import type { OutcomePolicy } from './outcome-policy.ts'
import { toolNeedsApproval } from './permissions.ts'
import { DefaultResourceLoader, SettingsManager, defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { AgentEvent, AgentRequest, Settings } from '../shared.ts'

function settings(endpoint: string, workspace = '', model = 'test-model'): Settings {
  return {
    endpoint, apiKey: '', providerId: 'test-provider',
    providers: [{ id: 'test-provider', name: model.includes('deepseek') ? 'DeepSeek' : 'Test', kind: 'custom', endpoint, apiKey: '', contextWindow: 32_768 }],
    model, workspace, temperature: 0, maxTokens: 2048, contextWindow: 32_768,
    autoCompact: true, permission: 'workspace',
  }
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sse(res: ServerResponse, chunks: any[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.end('data: [DONE]\n\n')
}

async function withServer(handler: (body: any, res: ServerResponse) => void | Promise<void>) {
  const bodies: any[] = []
  const server = createServer(async (req, res) => {
    try {
      const body = await readJson(req)
      bodies.push(body)
      await handler(body, res)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(error instanceof Error ? error.message : String(error))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Missing test server address')
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    bodies,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

function textResponse(model: string, text: string) {
  const base = { id: crypto.randomUUID(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ]
}

function toolResponse(model: string, name: string, args: string, finishReason = 'tool_calls') {
  const base = { id: crypto.randomUUID(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name, arguments: args } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]
}

test('all Shun turns use upstream Pi and resume an exact persisted session transcript', async () => {
  let responseNumber = 0
  const server = await withServer((body, res) => sse(res, textResponse(body.model, responseNumber++ ? 'two' : 'one')))
  const root = await mkdtemp(join(tmpdir(), 'shun-pi-runtime-'))
  const taskId = crypto.randomUUID(), events: AgentEvent[] = []
  const common = { agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: [] }
  try {
    const first: AgentRequest = { id: crypto.randomUUID(), taskId, text: 'first', history: [], settings: settings(server.endpoint) }
    await runPiAgent(first, new AbortController().signal, event => events.push(event), common)
    const second: AgentRequest = { ...first, id: crypto.randomUUID(), text: 'second', history: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'one' }], settings: settings(server.endpoint, '', 'test-model-2') }
    await runPiAgent(second, new AbortController().signal, event => events.push(event), common)
    assert.equal(events.filter(event => event.type === 'done').length, 2)
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'onetwo')
    assert.equal(server.bodies.length, 2)
    assert.equal(server.bodies[1].model, 'test-model-2')
    const content = (message: any) => Array.isArray(message.content) ? message.content.map((item: any) => item.text || '').join('') : message.content
    assert.deepEqual(server.bodies[1].messages.slice(-3).map((message: any) => [message.role, content(message)]), [
      ['user', 'first'], ['assistant', 'one'], ['user', 'second'],
    ])
    const sessionFiles = await import('node:fs/promises').then(fs => fs.readdir(common.sessionDir))
    const transcript = await readFile(join(common.sessionDir, sessionFiles[0]), 'utf8')
    assert.match(transcript, /"parentId"/)
    assert.match(transcript, /"text":"second"/)
    assert.match(transcript, /"modelId":"test-model-2"/)
  } finally { await server.close() }
})

test('a current-price question is sent to Pi with stable web capabilities', async () => {
  let requests = 0
  const server = await withServer((body, res) => {
    requests++
    const names = (body.tools || []).map((tool: any) => tool.function?.name)
    assert.equal(names.includes('web_search'), true)
    assert.equal(names.includes('web_read'), true)
    const system = body.messages.find((message: any) => message.role === 'system')?.content || ''
    assert.match(String(system), /You are Shun/)
    assert.match(String(system), /test-model/)
    assert.doesNotMatch(String(system), /operating inside pi/i)
    assert.match(String(system), /outside.*web_search.*web_read/i)
    sse(res, textResponse(body.model, 'checked'))
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-pi-current-price-'))
  const customTools = ['web_search', 'web_read'].map(name => defineTool({
    name, label: name, description: name, parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
  }))
  try {
    const taskId = crypto.randomUUID()
    const options = {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), customTools, activeTools: customTools.map(tool => tool.name),
    }
    const greeting: AgentRequest = { id: crypto.randomUUID(), taskId, text: 'hi', history: [], settings: settings(server.endpoint) }
    await runPiAgent(greeting, new AbortController().signal, () => {}, options)
    const price: AgentRequest = { ...greeting, id: crypto.randomUUID(), text: '现在 DGX Spark 的国内价格是多少', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'checked' }] }
    await runPiAgent(price, new AbortController().signal, () => {}, options)
    assert.equal(requests, 2)
  } finally { await server.close() }
})

test('Pi tool execution preserves DeepSeek reasoning replay and writes through the workspace tool', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    const base = { id: crypto.randomUUID(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model }
    if (turn++ === 0) {
      sse(res, [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'inspect then write' }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'write', arguments: '{"path":"result.txt","content":"ok"}' } }] }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ])
    } else {
      const replay = body.messages.find((message: any) => message.role === 'assistant' && message.tool_calls)
      assert.equal(replay.reasoning_content, 'inspect then write')
      assert.equal(body.messages.at(-1).role, 'tool')
      sse(res, textResponse(body.model, 'completed'))
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-pi-tool-'))
  const workspace = join(root, 'workspace')
  await import('node:fs/promises').then(fs => fs.mkdir(workspace))
  const events: AgentEvent[] = []
  try {
    const req: AgentRequest = {
      id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'write result.txt', history: [],
      settings: settings(server.endpoint, workspace, 'deepseek-v4-flash'),
    }
    await runPiAgent(req, new AbortController().signal, event => events.push(event), {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['write'],
    })
    assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'ok')
    assert.equal(events.some(event => event.type === 'tool' && event.tool?.name === 'write' && event.tool.state === 'done'), true)
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'completed')
    const running = events.findIndex(event => event.type === 'tool' && event.tool?.state === 'running')
    const finished = events.findIndex(event => event.type === 'tool' && event.tool?.state === 'done')
    const answer = events.findIndex(event => event.type === 'delta' && event.text === 'completed')
    const done = events.findIndex(event => event.type === 'done')
    assert.equal(running < finished && finished < answer && answer < done, true)
  } finally { await server.close() }
})

test('full access leaves Bash arguments to Pi instead of classifying command text', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    if (turn++ === 0) sse(res, toolResponse(body.model, 'bash', '{"command":"rm -rf disposable"}'))
    else {
      assert.equal(body.messages.at(-1).role, 'tool')
      sse(res, textResponse(body.model, 'removed'))
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-pi-full-access-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'disposable'), { recursive: true })
  await writeFile(join(workspace, 'disposable', 'file.txt'), 'temporary')
  try {
    const req: AgentRequest = {
      id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'remove disposable', history: [],
      settings: settings(server.endpoint, workspace),
    }
    await runPiAgent(req, new AbortController().signal, () => {}, {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['bash'],
      beforeToolCall: async context => {
        assert.equal(toolNeedsApproval(req.settings.permission, context.toolCall.name), false)
      },
    })
    await assert.rejects(readFile(join(workspace, 'disposable', 'file.txt'), 'utf8'))
  } finally { await server.close() }
})

test('Pi rejects a length-truncated tool call and continues the loop without executing it', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    if (turn++ === 0) sse(res, toolResponse(body.model, 'write', '{"path":"truncated.txt","content":"partial"}', 'length'))
    else {
      assert.equal(body.messages.at(-1).role, 'tool')
      assert.match(String(body.messages.at(-1).content), /output token limit|truncat/i)
      sse(res, textResponse(body.model, 'recovered'))
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-pi-truncated-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const events: AgentEvent[] = []
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'write safely', history: [], settings: settings(server.endpoint, workspace) }
    await runPiAgent(req, new AbortController().signal, event => events.push(event), {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['write'],
    })
    await assert.rejects(readFile(join(workspace, 'truncated.txt'), 'utf8'))
    assert.equal(events.some(event => event.type === 'tool' && event.tool?.state === 'error'), true)
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'recovered')
  } finally { await server.close() }
})

test('Pi validates tool arguments and returns schema failures to the model', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    if (turn++ === 0) sse(res, toolResponse(body.model, 'write', '{"path":"invalid.txt"}'))
    else {
      assert.equal(body.messages.at(-1).role, 'tool')
      assert.match(String(body.messages.at(-1).content), /content|required|validation/i)
      sse(res, textResponse(body.model, 'invalid call handled'))
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-pi-validation-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'write a file', history: [], settings: settings(server.endpoint, workspace) }
    await runPiAgent(req, new AbortController().signal, () => {}, {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['write'],
    })
    await assert.rejects(readFile(join(workspace, 'invalid.txt'), 'utf8'))
  } finally { await server.close() }
})

test('product beforeToolCall hook blocks execution and returns the failure to the model', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    if (turn++ === 0) sse(res, toolResponse(body.model, 'write', '{"path":"blocked.txt","content":"no"}'))
    else {
      assert.equal(body.messages.at(-1).role, 'tool')
      assert.match(String(body.messages.at(-1).content), /policy denied/i)
      sse(res, textResponse(body.model, 'blocked as expected'))
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-pi-hook-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'try write', history: [], settings: settings(server.endpoint, workspace) }
    await runPiAgent(req, new AbortController().signal, () => {}, {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['write'],
      beforeToolCall: async () => ({ block: true, reason: 'policy denied' }),
    })
    await assert.rejects(readFile(join(workspace, 'blocked.txt'), 'utf8'))
  } finally { await server.close() }
})

test('global Pi extensions load as plugins while untrusted project extensions stay disabled', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    const names = (body.tools || []).map((tool: any) => tool.function?.name)
    if (!names.includes('global_echo')) {
      sse(res, textResponse(body.model, `missing:${JSON.stringify(names)}`))
      return
    }
    assert.equal(names.includes('project_escape'), false)
    if (turn++ === 0) sse(res, toolResponse(body.model, 'global_echo', '{"value":"ok"}'))
    else {
      assert.equal(body.messages.at(-1).role, 'tool')
      assert.match(String(body.messages.at(-1).content), /global:ok/)
      sse(res, textResponse(body.model, 'plugin completed'))
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-pi-extension-'))
  const workspace = join(root, 'workspace')
  const agentDir = join(root, 'agent')
  await mkdir(join(agentDir, 'extensions'), { recursive: true })
  await mkdir(join(workspace, '.pi', 'extensions'), { recursive: true })
  const extension = (name: string, prefix: string) => `import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
export default function (pi) { pi.registerTool(defineTool({ name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)}, description: 'test', parameters: Type.Object({ value: Type.String() }), async execute(_id, args) { return { content: [{ type: 'text', text: ${JSON.stringify(prefix)} + args.value }], details: {} } } })) }`
  await writeFile(join(agentDir, 'extensions', 'global.ts'), extension('global_echo', 'global:'))
  await writeFile(join(workspace, '.pi', 'extensions', 'project.ts'), extension('project_escape', 'project:'))
  const events: AgentEvent[] = []
  try {
    const settingsManager = SettingsManager.create(workspace, agentDir)
    const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager })
    await loader.reload({ resolveProjectTrust: async () => false })
    const loaded = loader.getExtensions()
    assert.equal(loaded.extensions.length, 1, JSON.stringify(loaded.errors))
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'use extension', history: [], settings: settings(server.endpoint, workspace) }
    await runPiAgent(req, new AbortController().signal, event => events.push(event), {
      agentDir, sessionDir: join(root, 'sessions'), activeTools: [], enableExtensionTools: true,
    })
    assert.equal(events.some(event => event.type === 'tool' && event.tool?.name === 'global_echo' && event.tool.state === 'done'), true, events.map(event => event.text).filter(Boolean).join('\n'))
  } finally { await server.close() }
})

test('abort cancels an in-flight Pi provider stream without emitting done', async () => {
  const server = await withServer((_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"id":"waiting","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n')
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-pi-abort-'))
  const controller = new AbortController()
  const events: AgentEvent[] = []
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'wait', history: [], settings: settings(server.endpoint) }
    const running = runPiAgent(req, controller.signal, event => events.push(event), {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: [],
    })
    setTimeout(() => controller.abort(), 30)
    await assert.rejects(running, error => error instanceof Error && error.name === 'AbortError')
    assert.equal(events.some(event => event.type === 'done'), false)
  } finally { await server.close() }
})

test('outcome policy steers a premature completion back into verification and then converges', async () => {
  let turn = 0
  const server = await withServer((body, res) => {
    if (turn === 0) sse(res, toolResponse(body.model, 'write', '{"path":"result.txt","content":"ok"}'))
    else if (turn === 1) sse(res, textResponse(body.model, 'done too early'))
    else if (turn === 2) {
      const lastUser = [...body.messages].reverse().find((message: any) => message.role === 'user')
      const text = Array.isArray(lastUser.content) ? lastUser.content.map((item: any) => item.text || '').join('') : lastUser.content
      assert.match(text, /verification|验证/i)
      sse(res, toolResponse(body.model, 'bash', '{"command":"test -f result.txt"}'))
    } else sse(res, textResponse(body.model, 'verified'))
    turn++
  })
  const root = await mkdtemp(join(tmpdir(), 'shun-pi-converge-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const events: AgentEvent[] = []
  let verificationPending = false
  let nudged = false
  const outcomePolicy: OutcomePolicy = {
    observe(event) {
      if (event.type !== 'tool_execution_end' || event.isError) return
      if (event.toolName === 'write') verificationPending = true
      if (event.toolName === 'bash') verificationPending = false
    },
    evaluate(turn) {
      if (turn.message.content.some(block => block.type === 'toolCall') || !verificationPending || nudged) return { status: 'accept' }
      nudged = true
      return { status: 'continue', feedback: 'Run verification before finishing.' }
    },
  }
  try {
    const req: AgentRequest = { id: crypto.randomUUID(), taskId: crypto.randomUUID(), text: 'create result.txt and verify it', history: [], settings: settings(server.endpoint, workspace) }
    await runPiAgent(req, new AbortController().signal, event => events.push(event), {
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), activeTools: ['write', 'bash'],
      outcomePolicy,
    })
    assert.equal(turn, 4)
    assert.equal(events.some(event => event.type === 'tool' && event.tool?.name === 'bash' && event.tool.state === 'done'), true)
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'done too earlyverified')
  } finally { await server.close() }
})
