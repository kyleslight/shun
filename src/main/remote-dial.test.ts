import assert from 'node:assert/strict'
import test from 'node:test'
import { createRelayDialer, RELAY_CONNECT_TIMEOUT_MS } from './remote-dial.ts'

test('proxy discovery cannot strand a remote connection attempt', async t => {
  const names = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']
  const saved = names.map(name => process.env[name])
  for (const name of names) delete process.env[name]
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const dialer = createRelayDialer(() => { calls++; return new Promise(() => {}) })
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = assert.rejects(dialer.open('wss://example.invalid'), /timed out/)
      t.mock.timers.tick(RELAY_CONNECT_TIMEOUT_MS)
      await result
    }
    assert.equal(calls, 2)
  } finally {
    dialer.dispose()
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index] })
  }
})
