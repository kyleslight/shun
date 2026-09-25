import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { remoteReconnectDelay } from './remote-reconnect.ts'
import { boundedRemoteRelayPayload } from './remote-protocol.ts'
import { environmentProxyRoute, parseProxyRoute, proxyAgent, relayConnectionError } from './remote-dial.ts'
import { RemoteRelayService } from './remote-service.ts'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

test('remote reconnect starts quickly and backs off after repeated short-lived connections', () => {
  const deterministic = () => 0.5
  assert.deepEqual(
    Array.from({ length: 8 }, (_, attempt) => remoteReconnectDelay(attempt, deterministic)),
    [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 60_000, 60_000],
  )
})

test('remote reconnect jitter stays bounded', () => {
  assert.equal(remoteReconnectDelay(0, () => 0), 800)
  assert.equal(remoteReconnectDelay(0, () => 1), 1_200)
  assert.equal(remoteReconnectDelay(99, () => 0), 48_000)
  assert.equal(remoteReconnectDelay(99, () => 1), 72_000)
})

test('oversized remote responses become a small error instead of disconnecting the shared link', () => {
  const response = {
    id: 'request-1',
    kind: 'task.snapshot',
    payload: { ok: true as const, data: 'x'.repeat(1024 * 1024) },
  }

  assert.equal(boundedRemoteRelayPayload(response, 900 * 1024), response)
  assert.deepEqual(boundedRemoteRelayPayload(response, 900 * 1024 + 1), {
    id: 'request-1',
    kind: 'task.snapshot',
    payload: {
      ok: false,
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Remote response exceeded the transport limit.' },
    },
  })
})

test('oversized pushes are skipped without sending a link-breaking frame', () => {
  assert.equal(boundedRemoteRelayPayload({ kind: 'push', event: { huge: true } }, 900 * 1024 + 1), null)
})

test('corrupt pairing state is never silently replaced with an empty link list', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-state-'))
  const stateFile = join(directory, 'remote-links.json')
  await writeFile(stateFile, 'corrupt-state')
  const service = remoteServiceForStateFile(stateFile)
  try {
    await assert.rejects(service.start(), /Remote pairing state could not be loaded/)
    assert.equal(await readFile(stateFile, 'utf8'), 'corrupt-state')
  } finally {
    service.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('pairing state falls back to its last valid backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shun-remote-state-'))
  const stateFile = join(directory, 'remote-links.json')
  await writeFile(stateFile, 'corrupt-state')
  await writeFile(`${stateFile}.backup`, JSON.stringify({ version: 2, links: [] }))
  const service = remoteServiceForStateFile(stateFile)
  try {
    await service.start()
    assert.deepEqual(service.pairedDevices(), [])
  } finally {
    service.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('pairing honors the SOCKS proxy Chromium reports for a websocket relay', () => {
  // A machine that serves HTTP and SOCKS on one local port is answered with
  // SOCKS5 for `wss://`; reading only `PROXY` connects directly instead and the
  // failure surfaces as an `AggregateError` naming no host.
  assert.deepEqual(parseProxyRoute('SOCKS5 127.0.0.1:7897'), { kind: 'socks', url: 'socks5h://127.0.0.1:7897' })
  assert.deepEqual(parseProxyRoute('PROXY 127.0.0.1:7897'), { kind: 'http', url: 'http://127.0.0.1:7897' })
  assert.deepEqual(parseProxyRoute('DIRECT'), { kind: 'direct' })
  assert.deepEqual(parseProxyRoute(undefined), { kind: 'direct' })
})

test('proxy decisions keep the scheme, the fallback entry, and an explicit configuration', () => {
  assert.deepEqual(parseProxyRoute('DIRECT; PROXY 10.0.0.1:8080'), { kind: 'direct' })
  assert.deepEqual(parseProxyRoute('QUIC 10.0.0.1:443; PROXY 10.0.0.1:8080'), { kind: 'http', url: 'http://10.0.0.1:8080' })
  assert.deepEqual(parseProxyRoute('SOCKS4 10.0.0.1:1080'), { kind: 'socks', url: 'socks4://10.0.0.1:1080' })
  assert.deepEqual(parseProxyRoute('HTTPS proxy.example:8443'), { kind: 'http', url: 'https://proxy.example:8443' })
  assert.deepEqual(environmentProxyRoute('socks5://127.0.0.1:7897'), { kind: 'socks', url: 'socks5://127.0.0.1:7897' })
  assert.deepEqual(environmentProxyRoute('http://127.0.0.1:7897'), { kind: 'http', url: 'http://127.0.0.1:7897' })
  assert.deepEqual(environmentProxyRoute('127.0.0.1:7897'), { kind: 'http', url: 'http://127.0.0.1:7897' })
  assert.equal(environmentProxyRoute(''), undefined)
  assert.equal(environmentProxyRoute('ftp://127.0.0.1:21'), undefined)
})

test('every proxy route dials through the agent that can speak it, and a direct route dials nothing', () => {
  assert.ok(proxyAgent({ kind: 'socks', url: 'socks5h://127.0.0.1:7897' }) instanceof SocksProxyAgent)
  assert.ok(proxyAgent({ kind: 'http', url: 'http://127.0.0.1:7897' }) instanceof HttpsProxyAgent)
  assert.equal(proxyAgent({ kind: 'direct' }), undefined)
})

test('a failed relay connection names the relay and the route instead of an empty AggregateError', () => {
  const aggregate = Object.assign(new AggregateError([
    Object.assign(new Error('connect ETIMEDOUT 172.67.210.89:443'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('connect EHOSTUNREACH [2606:4700:3036::6815:45a0]:443'), { code: 'EHOSTUNREACH' }),
  ]), { code: 'ETIMEDOUT' })
  const direct = relayConnectionError(aggregate, 'wss://relay.shunagent.com/v1/pair/REDACTED?role=desktop&ttl=300', { kind: 'direct' })
  assert.match(direct.message, /^Could not reach wss:\/\/relay\.shunagent\.com through a direct connection: connect ETIMEDOUT 172\.67\.210\.89:443; connect EHOSTUNREACH/)
  assert.equal(direct.message.includes('REDACTED'), false)
  assert.equal(direct.cause, aggregate)

  const proxied = relayConnectionError(Error('connect ECONNREFUSED 127.0.0.1:1'), 'wss://relay.shunagent.com/v1/pair/x', { kind: 'socks', url: 'socks5h://127.0.0.1:1' })
  assert.equal(proxied.message, 'Could not reach wss://relay.shunagent.com through the SOCKS proxy socks5h://127.0.0.1:1: connect ECONNREFUSED 127.0.0.1:1')
})

function remoteServiceForStateFile(stateFile: string) {
  return new RemoteRelayService({
    stateFile,
    protect: value => value,
    unprotect: value => value,
    request: async () => null,
  })
}
