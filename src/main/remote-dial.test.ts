import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import type WebSocket from 'ws'
import { createRelayDialer, RELAY_CONNECT_TIMEOUT_MS, watchRelayConnection } from './remote-dial.ts'

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

test('an open but silent relay connection closes so its owner can reconnect', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const socket = new EventEmitter()
  let pings = 0, closed = 0
  Object.assign(socket, { ping: () => pings++, terminate: () => { closed++; socket.emit('close') } })
  watchRelayConnection(socket as unknown as WebSocket, 100)
  t.mock.timers.tick(100)
  assert.equal(pings, 1)
  socket.emit('pong')
  t.mock.timers.tick(100)
  assert.equal(closed, 0)
  t.mock.timers.tick(100)
  assert.equal(closed, 1)
  t.mock.timers.tick(1000)
  assert.equal(pings, 2)
})
