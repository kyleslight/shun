import test from 'node:test'
import assert from 'node:assert/strict'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { ProductCapabilityService, connectProductCapabilities } from './product-capabilities.ts'

test('interfaces share arbitrary package, browser and computer tools, schemas and deferred ownership', async () => {
  const called: string[] = []
  let disposed = 0
  const names = ['plugin_example_api', 'browser_tabs', 'desktop_elements', 'preview_snapshot', 'mcp_call']
  const tools = names.map(name => defineTool({ name, label: name, description: 'Fixture', parameters: Type.Object({ value: Type.String() }), execute: async (_id, args) => { called.push(name); return { content: [{ type: 'text' as const, text: args.value }], details: undefined } } }))
  const service = new ProductCapabilityService(async () => ({ tools, deferred: [{ ownerId: 'browser-use', ownerName: 'Browser Use', tool: tools[1] }], skills: [], dispose: async () => { disposed++ } }))
  const client = await connectProductCapabilities((method, input) => service.call(method, input), { taskId: 'a', runId: 'r', cwd: '/tmp', workspace: '', model: 'fixture' })
  assert.deepEqual(client.tools.map(tool => tool.name), names)
  assert.equal(client.deferred[0].tool, client.tools[1])
  for (const tool of client.tools) await tool.execute('call', { value: 'result' }, undefined, undefined, undefined as never)
  assert.deepEqual(called, names)
  await assert.rejects(client.tools[0].execute('call', { value: 3 } as any, undefined, undefined, undefined as never), /Invalid/)
  await client.close()
  assert.equal(disposed, 1)
  await assert.rejects(client.tools[0].execute('call', { value: 'late' }, undefined, undefined, undefined as never), /expired/)
})

test('each run receives a fresh catalog and cancellation stays isolated', async () => {
  const signals: AbortSignal[] = []
  let count = 0
  const service = new ProductCapabilityService(async () => ({ tools: [defineTool({ name: `action_${++count}`, label: 'Action', description: '', parameters: Type.Object({}), execute: async (_id, _args, signal) => { signals.push(signal!); return { content: [], details: undefined } } })], deferred: [], skills: [] }))
  const call = (method: string, input?: Record<string, unknown>) => service.call(method, input)
  const context = { taskId: 'a', runId: 'r', cwd: '/tmp', workspace: '', model: 'fixture' }
  const first = await connectProductCapabilities(call, context)
  const second = await connectProductCapabilities(call, { ...context, taskId: 'b' })
  await first.tools[0].execute('one', {}, undefined, undefined, undefined as never)
  await second.tools[0].execute('two', {}, undefined, undefined, undefined as never)
  await first.close()
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, false)
  assert.notEqual(first.tools[0].name, second.tools[0].name)
  await service.close()
})
