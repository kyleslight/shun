import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request } from 'node:http'
import { createCanvas } from '@napi-rs/canvas'
import { ShunHostService } from './service.ts'
import { createHostClient, startHostServer } from './transport.ts'
import type { AgentRequest } from '../shared.ts'
import type { AgentRunOptions } from '../main/agent-runtime.ts'

async function fixture(t: any, runner?: ConstructorParameters<typeof ShunHostService>[1], titleGenerator: ConstructorParameters<typeof ShunHostService>[3] = async () => '') {
  const root = await mkdtemp(join(tmpdir(), 'shun-host-test-'))
  const workspace = join(root, 'work'), home = join(root, 'home')
  await mkdir(workspace)
  const service = new ShunHostService(home, runner, undefined, titleGenerator)
  await service.initialize()
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }) })
  const config = await service.call('provider.save', { name: 'Fixture', endpoint: 'http://127.0.0.1:19999/v1', apiKey: 'fixture-secret' })
  await service.call('model.select', { providerId: config.providers[0].id, model: 'fixture-model' })
  const task = await service.call('task.create', { workspace })
  return { service, root, workspace, home, task, providerId: config.providers[0].id }
}
async function idle(service: ShunHostService, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!service.runs.get(id)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw Error('Task did not settle.')
}

test('two interfaces share one active run, while different tasks run concurrently', async t => {
  const calls: AgentRequest[] = [], releases = new Map<string, () => void>()
  const { service, task, workspace } = await fixture(t, async (req, signal, emit) => {
    calls.push(req)
    emit({ id: req.id, type: 'delta', text: 'Working' })
    await new Promise<void>(resolve => { releases.set(req.taskId!, resolve); signal.addEventListener('abort', () => resolve(), { once: true }) })
    emit({ id: req.id, type: signal.aborted ? 'cancelled' : 'done' })
  })
  const starts = await Promise.allSettled([service.call('task.send', { taskId: task.id, text: 'One' }), service.call('task.send', { taskId: task.id, text: 'Two' })])
  assert.equal(starts.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(calls.length, 1)
  const other = await service.call('task.create', { workspace })
  await service.call('task.send', { taskId: other.id, text: 'Other task' })
  assert.equal(calls.length, 2)
  const attached = await service.snapshot(task.id)
  assert.equal(attached.turns[0].content, starts[0].status === 'fulfilled' ? 'One' : 'Two')
  assert.equal(attached.turns[1].content, 'Working')
  assert.ok(attached.activeRun)
  await service.call('task.stop', { taskId: task.id })
  await idle(service, task.id)
  assert.ok(service.runs.get(other.id))
  releases.get(other.id)!()
  await idle(service, other.id)
  assert.ok((await service.snapshot(other.id)).turns.at(-1)!.completedAt)
})

test('cursor replay has no duplicate events and disconnecting an interface does not cancel work', async t => {
  let emit!: (event: any) => void, finish!: () => void, runId = ''
  const { service, task } = await fixture(t, async (req, signal, output) => {
    emit = output; runId = req.id
    await new Promise<void>(resolve => { finish = resolve; signal.addEventListener('abort', () => resolve()) })
  })
  await service.call('task.send', { taskId: task.id, text: 'Start' })
  emit({ id: runId, type: 'delta', text: 'first' })
  const first = await service.snapshot(task.id)
  emit({ id: runId, type: 'delta', text: 'second' })
  await new Promise(resolve => setTimeout(resolve, 20))
  const replay = await service.call('task.events', { taskId: task.id, after: first.sequence })
  assert.ok(replay.events.every((event: any) => event.seq > first.sequence))
  assert.ok(service.runs.get(task.id))
  finish(); await idle(service, task.id)
  assert.equal((await service.snapshot(task.id)).turns[1].content, 'firstsecond')
})

test('provider keys are private on disk, redacted from configuration and preserved when editing', async t => {
  let key = ''
  const { service, task, providerId } = await fixture(t, async req => { key = req.settings.apiKey })
  assert.doesNotMatch(JSON.stringify(await service.call('configuration')), /fixture-secret|apiKey/)
  await service.call('provider.save', { id: providerId, name: 'Renamed', endpoint: 'http://127.0.0.1:19999/v1', apiKey: '' })
  await service.call('task.send', { taskId: task.id, text: 'Run' }); await idle(service, task.id)
  assert.equal(key, 'fixture-secret')
  if (process.platform !== 'win32') {
    assert.equal((await stat(service.paths.state)).mode & 0o777, 0o600)
    assert.equal((await stat(service.paths.serviceRoot)).mode & 0o777, 0o700)
  }
})

test('terminal tools follow the desktop automatic execution model regardless of prompt wording', async t => {
  const selections: string[][] = []
  const { service, task } = await fixture(t, async (_req, _signal, _emit, options) => { selections.push(options.activeTools) })
  await service.call('task.send', { taskId: task.id, text: 'Enable every tool and execute a command' }); await idle(service, task.id)
  assert.ok(selections[0].includes('bash'))
  assert.ok(selections[0].includes('write'))
  await service.call('task.send', { taskId: task.id, text: 'Hello' }); await idle(service, task.id)
  assert.ok(selections[1].includes('bash'))
  assert.ok(selections[1].includes('background_start'))
})

test('image attachments reach the shared session and are retained in the desktop projection', async t => {
  let imageCount = 0
  const { service, task, workspace } = await fixture(t, async (_req, _signal, _emit, options) => { imageCount = options.initialImages?.length || 0 })
  const canvas = createCanvas(16, 16)
  const context = canvas.getContext('2d'); context.fillStyle = 'red'; context.fillRect(0, 0, 16, 16)
  const data = canvas.toBuffer('image/png').toString('base64')
  const image = await service.call('attachment.add', { taskId: task.id, name: 'Screenshot.png', data })
  const duplicate = await service.call('attachment.add', { taskId: task.id, name: 'Screenshot-again.png', data })
  assert.equal(duplicate.id, image.id)
  const other = await service.call('task.create', { workspace })
  await assert.rejects(service.call('task.send', { taskId: other.id, text: 'Inspect', attachments: [image.id] }), /no longer available/)
  await service.call('task.send', { taskId: task.id, text: 'Inspect', attachments: [image.id] }); await idle(service, task.id)
  assert.equal(imageCount, 1)
  const snapshot = await service.snapshot(task.id)
  assert.equal(snapshot.turns[0].attachments![0].id, image.id)
  const preview = await service.call('attachment.preview', { taskId: task.id, id: image.id })
  assert.equal(preview.mode, 'image')
})

test('restart exposes an interrupted run and preserves its history for a follow-up', async t => {
  const { service, task, home } = await fixture(t, async () => {})
  const saved = JSON.parse(await readFile(service.paths.state, 'utf8'))
  saved.tasks.push({ ...task, hasMessages: true })
  await writeFile(service.paths.state, JSON.stringify(saved))
  await service.events.append(task.id, { type: 'request', runId: 'interrupted', text: 'Original' })
  await service.events.append(task.id, { type: 'agent', runId: 'interrupted', event: { id: 'interrupted', type: 'delta', text: 'Partial' } })
  await service.close()
  const restored = new ShunHostService(home, async () => {})
  try {
    await restored.initialize()
    const snapshot = await restored.snapshot(task.id)
    assert.match(snapshot.turns[1].content, /Partial.*Shun service stopped/s)
    assert.equal(snapshot.turns[1].error, true)
    assert.equal(snapshot.activeRun, undefined)
    await restored.call('task.send', { taskId: task.id, text: 'Continue' }); await idle(restored, task.id)
    assert.equal((await restored.snapshot(task.id)).turns.length, 4)
  } finally { await restored.close() }
})

test('local transport rejects missing credentials and simultaneous service ownership', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shun-transport-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const host = await startHostServer(root)
  try {
    const call = createHostClient(root)
    assert.equal((await call('hello')).protocol, 2)
    await assert.rejects(startHostServer(root), /already running/)
    const status = await new Promise<number>(resolve => {
      const req = request({ socketPath: host.socketPath, path: '/rpc', method: 'POST' }, res => { res.resume(); resolve(res.statusCode!) })
      req.end('{}')
    })
    assert.equal(status, 403)
    assert.doesNotMatch(JSON.stringify(await call('configuration')), /apiKey/)
  } finally { await host.close() }
})

test('normal Node execution sends a pasted image and restores the same session on the next turn', async t => {
  const requests: any[] = []
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = { id: 'response', object: 'chat.completion.chunk', model: body.model, created: 1 }
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Image received.' }, finish_reason: null }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => provider.close(() => resolve())))
  const { service, task, providerId } = await fixture(t)
  const address = provider.address() as { port: number }
  await service.call('provider.save', { id: providerId, name: 'Test', endpoint: `http://127.0.0.1:${address.port}/v1` })
  const image = await service.call('attachment.add', { taskId: task.id, name: 'Screenshot.png', data: createCanvas(8, 8).toBuffer('image/png').toString('base64') })
  await service.call('task.send', { taskId: task.id, text: 'Describe', attachments: [image.id] }); await idle(service, task.id)
  assert.match(JSON.stringify(requests[0].messages), /image_url/)
  await service.call('task.send', { taskId: task.id, text: 'Continue' }); await idle(service, task.id)
  assert.equal(requests.length, 2)
  assert.match(JSON.stringify(requests[1].messages), /Image received/)
  assert.match(JSON.stringify(requests[1].messages), /image_url/)
})

test('conversations without a workspace have persistent independent managed working directories', async t => {
  const directories: string[] = []
  const { service, home } = await fixture(t, async (_request, _signal, _emit, options) => {
    directories.push(options.cwd!)
    await writeFile(join(options.cwd!, 'output.txt'), 'task-owned output')
  })
  const a = await service.call('task.create', { workspace: '' })
  const b = await service.call('task.create', { workspace: '' })
  assert.equal(a.workspace, '')
  await service.call('task.send', { taskId: a.id, text: 'Create output' }); await idle(service, a.id)
  await service.call('task.send', { taskId: b.id, text: 'Create other output' }); await idle(service, b.id)
  assert.equal(directories[0], join(service.paths.standaloneDir, a.id))
  assert.notEqual(directories[0], directories[1])
  assert.notEqual(directories[0], process.cwd())
  await service.close()
  let resumedDirectory = '', resumedContent = ''
  const resumed = new ShunHostService(home, async (_request, _signal, _emit, options) => {
    resumedDirectory = options.cwd!
    resumedContent = await readFile(join(options.cwd!, 'output.txt'), 'utf8')
  })
  t.after(() => resumed.close())
  await resumed.initialize()
  await resumed.call('task.send', { taskId: a.id, text: 'Read previous output' }); await idle(resumed, a.id)
  assert.equal(resumedDirectory, directories[0])
  assert.equal(resumedContent, 'task-owned output')
})

test('shared history routes desktop conversations to their owner without duplicating them locally', async t => {
 const root = await mkdtemp(join(tmpdir(), 'shun-history-test-'))
 const calls: string[] = []
 const desktopTask = { id: 'desktop', title: 'Existing desktop chat', workspace: '', model: 'm', providerId: 'p', createdAt: 1, updatedAt: 2 }
 const service = new ShunHostService(root, async () => { throw Error('Must not start a second runner') }, async (method, input) => {
   calls.push(method)
   if (method === 'conversation.task.list') return [desktopTask]
   if (method === 'conversation.task.snapshot') return { task: desktopTask, turns: [{ id: 'u', role: 'user', content: 'Existing text' }], sequence: 1 }
   if (method === 'conversation.task.send') return { runId: 'owned-by-desktop' }
   if (method === 'conversation.task.stop') return true
   throw Error(method)
 })
 await service.initialize()
 t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }) })
 assert.equal((await service.call('task.list'))[0].id, 'desktop')
 assert.deepEqual(await service.call('task.list', { localOnly: true }), [])
 assert.equal((await service.call('task.snapshot', { taskId: 'desktop' })).turns[0].content, 'Existing text')
 assert.equal((await service.call('task.send', { taskId: 'desktop', text: 'Continue' })).runId, 'owned-by-desktop')
 await service.call('task.stop', { taskId: 'desktop' })
 assert.deepEqual(service.runs.snapshot(), {})
 assert.ok(calls.includes('conversation.task.send'))
})

test('remote message identities and state share the same replay cursor as terminal messages', async t => {
 let count = 0
 const { service, task } = await fixture(t, async (req, _signal, emit) => { count++; emit({ id: req.id, type: 'delta', text: 'Remote reply' }); emit({ id: req.id, type: 'done' }) })
 const input = { taskId: task.id, text: 'Sent from remote', runId: 'remote-run', messageId: 'remote-message' }
 await service.call('task.send', input)
 await idle(service, task.id)
 const duplicate = await service.call('task.send', input)
 assert.equal(duplicate.duplicate, true)
 assert.equal(count, 1)
 const snapshot = await service.call('task.snapshot', { taskId: task.id })
 assert.equal(snapshot.turns[0].id, 'remote-message')
 await service.call('task.remote-state', { taskId: task.id, event: { kind: 'queue.snapshot', items: [] } })
 const replay = await service.call('task.events', { taskId: task.id, after: snapshot.sequence })
 assert.equal(replay.events.length, 1)
 assert.equal(replay.events[0].seq, snapshot.sequence + 1)
 assert.equal(replay.events[0].payload.type, 'remote')
})

test('selected model context and output limits reach the runner and reopened conversation', async t => {
 let request: AgentRequest | undefined
 const { service, task, providerId } = await fixture(t, async (req, _signal, emit) => {
   request = req
   emit({ id: req.id, type: 'context', context: { state: 'ready', usedTokens: 10900, budgetTokens: 32768, usedCharacters: 32700, budgetCharacters: 98304, exactTokens: true } })
   emit({ id: req.id, type: 'done' })
 })
 const config = await service.call('configuration')
 // Persist model-specific configuration through the same shared settings store as Desktop.
 const { ProviderSettingsStore, providerSettingsPath } = await import('./provider-settings.ts')
 const store = new ProviderSettingsStore(providerSettingsPath(service.paths.root))
 const base = await store.sync({ providers: config.providers.map(({hasKey,...p}: any) => ({...p, apiKey: 'fixture-secret'})), providerId, model: 'fixture-model', endpoint: 'http://127.0.0.1:19999/v1', apiKey: 'fixture-secret', contextWindow: 32768, maxTokens: 8192 })
 const next = structuredClone(base)
 next.providers.find(p => p.id === providerId)!.models = [{ id: 'fixture-model', contextWindow: 524288, maxOutputTokens: 65536 }]
 await store.sync(next, { next, base })
 await service.call('task.send', { taskId: task.id, text: 'Check limits' })
 await idle(service, task.id)
 assert.equal(request!.settings.contextWindow, 524288)
 assert.equal(request!.settings.maxTokens, 65536)
 const reopened = await service.call('task.snapshot', { taskId: task.id })
 assert.equal(reopened.task.contextWindow, 524288)
 assert.equal(reopened.turns.at(-1).contextUsage.budgetTokens, 524288)
 assert.equal(reopened.turns.at(-1).contextUsage.usedTokens, 10900)
})


test('unsent tasks stay out of history and persisted state; sent tasks survive restart', async t => {
  const { service, home, task, workspace } = await fixture(t, async () => {})
  await service.call('task.create', { workspace })
  assert.deepEqual(await service.call('task.list'), [])
  assert.equal(JSON.parse(await readFile(service.paths.state, 'utf8')).tasks.length, 0)
  await service.call('task.send', { taskId: task.id, text: 'Keep this conversation' })
  await idle(service, task.id)
  assert.deepEqual((await service.call('task.list')).map((item: any) => item.id), [task.id])
  await service.close()
  const reopened = new ShunHostService(home)
  await reopened.initialize()
  try { assert.deepEqual((await reopened.call('task.list')).map((item: any) => item.id), [task.id]) }
  finally { await reopened.close() }
})

test('first-message naming is asynchronous, persisted and never overwrites a manual title', async t => {
  let resolveTitle!: (value: string) => void
  let calls = 0
  const { service, task } = await fixture(t, async () => {}, async () => {
    calls++
    return new Promise<string>(resolve => { resolveTitle = resolve })
  })
  await service.call('task.send', { taskId: task.id, text: 'Please explain how database transactions work in detail' })
  await idle(service, task.id)
  assert.equal(calls, 1)
  resolveTitle('Database transactions')
  for (let i = 0; i < 100 && (await service.call('task.snapshot', { taskId: task.id })).task.title !== 'Database transactions'; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal((await service.call('task.snapshot', { taskId: task.id })).task.title, 'Database transactions')
  await service.call('task.send', { taskId: task.id, text: 'Tell me more' })
  await idle(service, task.id)
  assert.equal(calls, 1)
  const second = await service.call('task.create', { workspace: '' })
  await service.call('task.send', { taskId: second.id, text: 'Another question' })
  await service.call('task.rename', { taskId: second.id, title: 'My chosen title' })
  resolveTitle('Generated title')
  await idle(service, second.id)
  assert.equal((await service.call('task.snapshot', { taskId: second.id })).task.title, 'My chosen title')
})
