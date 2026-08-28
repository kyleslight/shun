import assert from 'node:assert/strict'
import test from 'node:test'
import { remoteReconnectDelay } from './remote-reconnect.ts'

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
