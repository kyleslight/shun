import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import type { RemoteDesktopConnectionEvent, RemoteDesktopEventBatch, RemoteTerminalFrame, TaskEventEnvelope } from '../shared.ts'
import { RemoteClientService, pairingDialError } from './remote-client.ts'
import { parsePairingCode } from './remote-protocol.ts'
import { RemoteRelayService } from './remote-service.ts'

// A machine-wide proxy would send these dials somewhere else; a loopback test
// must talk to the loopback relay it just started.
for (const key of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) process.env[key] = ''

/**
 * The smallest relay that behaves like the deployed one where it matters: it
 * forwards frames to the opposite role, refuses a controller before its
 * execution node, and can drop one side to imitate a network that went away.
 */
function loopbackRelay() {
  const channels = new Map<string, Map<string, Set<WebSocket>>>()
  const upgraded = new WebSocketServer({ noServer: true })
  const roleSockets = (channelId: string, role: string) => channels.get(channelId)?.get(role) ?? new Set<WebSocket>()
  const server: Server = createServer((_request, response) => { response.writeHead(200); response.end('shun-relay') })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const match = /^\/v1\/(pair|link)\/([A-Za-z0-9_-]{24,128})$/.exec(url.pathname)
    const role = url.searchParams.get('role')
    if (!match || (role !== 'desktop' && role !== 'mobile')) return socket.destroy()
    const channelId = match[2]
    if (role === 'mobile' && roleSockets(channelId, 'desktop').size === 0) {
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n')
      socket.end()
      return
    }
    upgraded.handleUpgrade(request, socket, head, client => {
      const roles = channels.get(channelId) ?? new Map<string, Set<WebSocket>>()
      channels.set(channelId, roles)
      const peers = roles.get(role) ?? new Set<WebSocket>()
      roles.set(role, peers)
      peers.add(client)
      client.on('message', (data, isBinary) => {
        for (const peer of roleSockets(channelId, role === 'desktop' ? 'mobile' : 'desktop')) {
          if (peer.readyState === WebSocket.OPEN) peer.send(data, { binary: isBinary })
        }
      })
      client.on('close', () => peers.delete(client))
    })
  })
  const listening = new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve(`ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`)
  }))
  return {
    url: listening,
    /** Everything a role holds, closed at once: the link has to notice and recover. */
    drop(role: string) {
      for (const roles of channels.values()) for (const socket of roles.get(role) ?? []) socket.close()
    },
    async stop() {
      for (const roles of channels.values()) for (const sockets of roles.values()) for (const socket of sockets) socket.terminate()
      await new Promise<void>(resolve => upgraded.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

const identity = (value: string) => value

async function until<T>(check: () => T | Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw Error(`Timed out waiting for ${what}.`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function taskEvent(seq: number, text = `chunk ${seq}`): TaskEventEnvelope {
  return {
    taskId: 'task_1',
    seq,
    at: Date.now(),
    payload: { type: 'agent', runId: 'run_1', event: { id: 'run_1', type: 'delta', text } },
  }
}

type Harness = {
  host: RemoteRelayService
  client: RemoteClientService
  batches: RemoteDesktopEventBatch[]
  states: RemoteDesktopConnectionEvent[]
  terminals: RemoteTerminalFrame[]
  commands: string[]
  relay: Awaited<ReturnType<typeof loopbackRelay>>
  stop(): Promise<void>
}

async function harness(request?: (frame: { id: string; kind: string; payload: Record<string, unknown> }) => Promise<unknown>): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-client-'))
  const relay = loopbackRelay()
  const url = await relay.url
  const commands: string[] = []
  const batches: RemoteDesktopEventBatch[] = []
  const states: RemoteDesktopConnectionEvent[] = []
  const terminals: RemoteTerminalFrame[] = []
  const host = new RemoteRelayService({
    stateFile: join(directory, 'remote-links.json'),
    protect: identity,
    unprotect: identity,
    relayUrl: url,
    request: frame => {
      commands.push(frame.kind)
      return request ? request(frame) : Promise.resolve([])
    },
  })
  const client = new RemoteClientService({
    stateFile: join(directory, 'remote-client.json'),
    protect: identity,
    unprotect: identity,
    onEvent: batch => batches.push(batch),
    onState: state => states.push(state),
    onTerminal: frame => terminals.push(frame),
  })
  return {
    host,
    client,
    batches,
    states,
    terminals,
    commands,
    relay,
    async stop() {
      client.stop()
      host.stop()
      await relay.stop()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('a Desktop pairs with another Shun and drives its tasks over the relay', async () => {
  const remote = await harness(async frame => frame.kind === 'tasks.list'
    ? [{ id: 'task_1', title: 'Remote task', workspace: '/tmp/work', status: 'idle', updatedAt: 1, createdAt: 1 }]
    : [])
  await remote.host.start()
  await remote.client.start()
  try {
    const pairing = await remote.host.beginPairing('Studio Mac')
    const paired = await remote.client.pair(pairing.qr)
    assert.equal(paired.name, 'Studio Mac')
    assert.equal(paired.id, JSON.parse(pairing.qr).desktopIdentityPublicKey)

    const desktop = await until(() => remote.client.desktops().find(item => item.connected), 'the link to come up')
    const tasks = await remote.client.request(desktop.id, 'tasks.list') as Array<{ id: string }>
    assert.deepEqual(tasks.map(task => task.id), ['task_1'])
    assert.deepEqual(remote.commands, ['tasks.list'])

    await until(() => remote.host.pairedDevices()[0]?.connected, 'the execution node to hold the link')
    await remote.host.pushTaskEvent(taskEvent(1))
    const first = (await until(() => remote.batches[0], 'the first pushed event')).events[0]
    assert.equal(first.seq, 1)
    assert.equal(first.taskId, 'task_1')
    assert.equal(first.type, 'turn.delta')
  } finally {
    await remote.stop()
  }
})

test('a conversation resumes incrementally, and a skipped sequence asks for a resync', async () => {
  const remote = await harness()
  await remote.host.start()
  await remote.client.start()
  try {
    const pairing = await remote.host.beginPairing('Studio Mac')
    await remote.client.pair(pairing.qr)
    const desktop = await until(() => remote.client.desktops().find(item => item.connected), 'the link to come up')
    await until(() => remote.host.pairedDevices()[0]?.connected, 'the execution node to hold the link')

    await remote.host.pushTaskEvent(taskEvent(1))
    await remote.host.pushTaskEvent(taskEvent(2))
    await until(() => remote.batches.flatMap(batch => batch.events).length === 2, 'both deltas')
    assert.ok(remote.batches.every(batch => batch.staleTasks.length === 0))

    // Either side can lose pushes while a link is down; the gap is what says so.
    await remote.host.pushTaskEvent(taskEvent(5))
    const gap = await until(() => remote.batches.find(batch => batch.staleTasks.includes('task_1')), 'the gap to be reported')
    assert.equal(gap.events.at(-1)?.seq, 5)

    // A redelivered event is applied once: the cursor is what makes that true.
    const delivered = remote.batches.flatMap(batch => batch.events).length
    await remote.host.pushTaskEvent(taskEvent(5))
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(remote.batches.flatMap(batch => batch.events).length, delivered)

    const snapshot = await remote.client.request(desktop.id, 'task.snapshot', { taskId: 'task_1' })
    assert.ok(snapshot !== undefined)
  } finally {
    await remote.stop()
  }
})

test('a streaming run reaches the view in batches rather than one message per event', async () => {
  const remote = await harness()
  await remote.host.start()
  await remote.client.start()
  try {
    const pairing = await remote.host.beginPairing('Studio Mac')
    await remote.client.pair(pairing.qr)
    await until(() => remote.client.desktops().find(item => item.connected), 'the link to come up')
    await until(() => remote.host.pairedDevices()[0]?.connected, 'the execution node to hold the link')

    for (let seq = 1; seq <= 120; seq += 1) await remote.host.pushTaskEvent(taskEvent(seq))
    const events = await until(
      () => remote.batches.flatMap(batch => batch.events).length === 120 ? remote.batches.flatMap(batch => batch.events) : undefined,
      'every delta',
    )
    assert.deepEqual(events.map(event => event.seq), Array.from({ length: 120 }, (_, index) => index + 1))
    assert.ok(remote.batches.length < 120, `expected batching, got ${remote.batches.length} messages for 120 events`)
  } finally {
    await remote.stop()
  }
})

test('a link that drops comes back, finishes the command that was in flight, and tells the view to resync', async () => {
  let calls = 0
  const remote = await harness(async () => {
    calls += 1
    await new Promise(resolve => setTimeout(resolve, 700))
    return { accepted: true }
  })
  await remote.host.start()
  await remote.client.start()
  try {
    const pairing = await remote.host.beginPairing('Studio Mac')
    await remote.client.pair(pairing.qr)
    const desktop = await until(() => remote.client.desktops().find(item => item.connected), 'the link to come up')
    await until(() => remote.host.pairedDevices()[0]?.connected, 'the execution node to hold the link')

    const inFlight = remote.client.request(desktop.id, 'task.rename', { taskId: 'task_1', title: 'Renamed' })
    await new Promise(resolve => setTimeout(resolve, 100))
    remote.relay.drop('mobile')

    assert.deepEqual(await inFlight, { accepted: true })
    // The retransmit carries the same request id, so the peer answers from its
    // cache instead of running the command twice.
    assert.equal(calls, 1)
    const resumed = await until(() => remote.states.find(state => state.connected && state.resumed), 'the resumed link')
    assert.equal(resumed.id, desktop.id)
  } finally {
    await remote.stop()
  }
})

test('a terminal frame reaches the controller live, without entering the task stream', async () => {
  const remote = await harness()
  await remote.host.start()
  await remote.client.start()
  try {
    const pairing = await remote.host.beginPairing('Studio Mac')
    await remote.client.pair(pairing.qr)
    const desktop = await until(() => remote.client.desktops().find(item => item.connected), 'the link to come up')
    const device = await until(() => remote.host.pairedDevices()[0], 'the paired link')

    await remote.host.pushToLink(device.id, { type: 'terminal.data', taskId: 'task_1', terminalId: 'terminal_1', data: 'hello' })
    const frame = await until(() => remote.terminals[0], 'the terminal frame')
    assert.deepEqual(frame, { type: 'terminal.data', desktopId: desktop.id, taskId: 'task_1', terminalId: 'terminal_1', data: 'hello' })

    await remote.host.pushToLink(device.id, { type: 'terminal.exit', taskId: 'task_1', terminalId: 'terminal_1', exitCode: 3 })
    const exit = await until(() => remote.terminals[1], 'the exit frame')
    assert.deepEqual(exit, { type: 'terminal.exit', desktopId: desktop.id, taskId: 'task_1', terminalId: 'terminal_1', exitCode: 3 })
    // Terminal output is a live stream: it never becomes a task event, so it
    // never marks a conversation as gapped.
    assert.deepEqual(remote.batches, [])
  } finally {
    await remote.stop()
  }
})

test('a pairing code must be answered by the identity it names', async () => {
  const remote = await harness()
  await remote.host.start()
  await remote.client.start()
  try {
    const pairing = await remote.host.beginPairing('Studio Mac')
    const code = JSON.parse(pairing.qr) as Record<string, unknown>
    const forged = JSON.stringify({ ...code, desktopIdentityPublicKey: randomBytes(44).toString('base64url') })
    await assert.rejects(remote.client.pair(forged), /did not prove the identity/)
  } finally {
    await remote.stop()
  }
})

test('pairing refuses a code it cannot trust before anything is dialled', () => {
  const channelId = randomBytes(24).toString('base64url')
  const key = randomBytes(44).toString('base64url')
  const code = (overrides: Record<string, unknown>) => JSON.stringify({
    version: 1,
    relay: 'wss://relay.shunagent.com',
    channelId,
    desktopEphemeralPublicKey: key,
    desktopIdentityPublicKey: key,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  })

  assert.equal(parsePairingCode(code({})).channelId, channelId)
  assert.throws(() => parsePairingCode('not json'), /not valid/)
  assert.throws(() => parsePairingCode(code({ version: 2 })), /different version/)
  assert.throws(() => parsePairingCode(code({ expiresAt: Date.now() - 1 })), /has expired/)
  assert.throws(() => parsePairingCode(code({ relay: 'ws://relay.example.com' })), /unencrypted relay/)
  assert.throws(() => parsePairingCode(code({ channelId: 'short' })), /not valid/)
  assert.throws(() => parsePairingCode(code({ desktopIdentityPublicKey: 'x' })), /not valid/)
  assert.equal(parsePairingCode(code({ relay: 'ws://127.0.0.1:8787' })).relay, 'ws://127.0.0.1:8787')
})

test('a code nobody is waiting on is answered in words that say what to do next', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-client-'))
  const relay = loopbackRelay()
  const url = await relay.url
  const client = new RemoteClientService({
    stateFile: join(directory, 'remote-client.json'),
    protect: identity,
    unprotect: identity,
  })
  await client.start()
  try {
    const code = JSON.stringify({
      version: 1,
      relay: url,
      channelId: randomBytes(24).toString('base64url'),
      desktopEphemeralPublicKey: randomBytes(44).toString('base64url'),
      desktopIdentityPublicKey: randomBytes(44).toString('base64url'),
      expiresAt: Date.now() + 60_000,
    })
    // The relay says 409 when the other Shun has stopped waiting on that code.
    // That is not a network fault, and the person does not need to learn which
    // relay was dialled: they need to know to go and show a new code.
    const failure = await client.pair(code).then(() => undefined, (error: Error) => error)
    assert.ok(failure, 'pairing should not succeed without a Shun on the other end')
    assert.match(failure.message, /no longer waiting/)
    assert.equal(failure.message.includes('relay.shunagent.com'), false)
    assert.equal(failure.message.includes(url), false)
  } finally {
    client.stop()
    await relay.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a corrupt client state file is never replaced with an empty pairing list', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-client-'))
  const stateFile = join(directory, 'remote-client.json')
  await writeFile(stateFile, 'corrupt-state')
  const client = new RemoteClientService({ stateFile, protect: identity, unprotect: identity })
  try {
    await assert.rejects(client.start(), /Remote client state could not be loaded/)
    assert.equal(await readFile(stateFile, 'utf8'), 'corrupt-state')
  } finally {
    client.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a pairing failure is told in words that say what to do next', () => {
  assert.match(pairingDialError(new Error('Could not reach wss://relay.shunagent.com through a direct connection: Unexpected server response: 409')).message,
    /no longer waiting/)
  assert.equal(pairingDialError(new Error('Could not reach wss://relay.shunagent.com through a direct connection: Unexpected server response: 409')).message.includes('relay.shunagent.com'), false)
  assert.match(pairingDialError(new Error('Unexpected server response: 410')).message, /already been used/)
  assert.match(pairingDialError(new Error('Relay connection timed out.')).message, /did not answer/)
  assert.match(pairingDialError(new Error('connect ECONNREFUSED 127.0.0.1:1')).message, /Could not reach the pairing service: connect ECONNREFUSED/)
})

test('a pairing this machine cannot read leaves the controller able to pair again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-client-'))
  const stateFile = join(directory, 'remote-client.json')
  await writeFile(stateFile, 'unreadable-secret')
  const client = new RemoteClientService({ stateFile, protect: identity, unprotect: identity })
  try {
    await assert.rejects(client.start(), /Remote client state could not be loaded/)
    // A service left stopped by its own failed load would refuse the pairing the
    // person now has to do, which is the second half of the bug.
    client.resetStoredState()
    assert.deepEqual(client.desktops(), [])
    const code = JSON.stringify({
      version: 1,
      relay: 'ws://127.0.0.1:9',
      channelId: randomBytes(24).toString('base64url'),
      desktopEphemeralPublicKey: randomBytes(44).toString('base64url'),
      desktopIdentityPublicKey: randomBytes(44).toString('base64url'),
      expiresAt: Date.now() + 60_000,
    })
    // It tries to dial, which is what "usable again" means; the port is closed.
    await assert.rejects(client.pair(code), /Could not reach|pairing service/)
  } finally {
    client.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
