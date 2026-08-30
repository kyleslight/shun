import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { remoteReconnectDelay } from './remote-reconnect.ts'
import { boundedRemoteRelayPayload, RemoteRelayService } from './remote-service.ts'

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

function remoteServiceForStateFile(stateFile: string) {
  return new RemoteRelayService({
    stateFile,
    protect: value => value,
    unprotect: value => value,
    request: async () => null,
  })
}
