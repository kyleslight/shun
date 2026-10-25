import assert from 'node:assert/strict'
import { createHook } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import test from 'node:test'
import { localEndpointStatus } from './local-endpoint.ts'

const run = promisify(execFile)

test('port ownership queries stay independent and observe a closed listener freshly', { skip: process.platform === 'win32' }, async () => {
  const first = createServer(), second = createServer()
  const listen = (server: typeof first) => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const close = (server: typeof first) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  try {
    await Promise.all([listen(first), listen(second)])
    const address = (server: typeof first) => `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const firstUrl = address(first), secondUrl = address(second)
    const group = Number((await run('ps', ['-o', 'pgid=', '-p', String(process.pid)])).stdout.trim())
    assert.ok(group > 0)
    let queries = 0
    const hook = createHook({ init: (_id, type) => { if (type === 'PROCESSWRAP') queries++ } })
    hook.enable()
    let owned, foreign, other
    try {
      [owned, foreign, other] = await Promise.all([localEndpointStatus(firstUrl, group), localEndpointStatus(firstUrl, group + 100_000), localEndpointStatus(secondUrl, group)])
    } finally { hook.disable() }
    assert.equal(queries, 1, 'distinct ports share one in-flight OS query')
    assert.deepEqual(owned, { listening: true, owned: true })
    assert.deepEqual(foreign, { listening: true, owned: false })
    assert.deepEqual(other, { listening: true, owned: true })
    await close(first)
    const [closed, stillOpen] = await Promise.all([localEndpointStatus(firstUrl, group), localEndpointStatus(secondUrl, group)])
    assert.deepEqual(closed, { listening: false, owned: false })
    assert.deepEqual(stillOpen, { listening: true, owned: true })
  } finally {
    if (first.listening) await close(first)
    if (second.listening) await close(second)
  }
})
