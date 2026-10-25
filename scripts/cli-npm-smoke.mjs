import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createHostClient } from '../src/host/transport.ts'

const execute = promisify(execFile)
const installedBin = resolve(process.argv[2])
const temporary = await mkdtemp(join(tmpdir(), 'shun-standalone-smoke-'))
const home = join(temporary, 'home'), workspace = join(temporary, 'work')
const call = createHostClient(home)
let servicePid
const provider = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const base = { id: 'standalone', object: 'chat.completion.chunk', model: body.model, created: 1 }
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Standalone Shun works.' }, finish_reason: null }] })}\n\n`)
  res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
})
try {
  await mkdir(workspace)
  const executable = installedBin
  const options = { cwd: workspace, env: { ...process.env, SHUN_HOME: home }, timeout: 30000 }
  assert.match((await execute(executable, ['--version'], options)).stdout, /^Shun /)
  // Simultaneous initial clients must settle on one service owner.
  await Promise.all([execute(executable, ['tasks'], options), execute(executable, ['tasks'], options)])
  servicePid = (await call('hello')).pid
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const config = await call('provider.save', { name: 'Standalone fixture', endpoint: `http://127.0.0.1:${provider.address().port}/v1` })
  await call('model.select', { providerId: config.providers[0].id, model: 'standalone-fixture' })
  const task = await call('task.create', { workspace })
  const result = await execute(executable, ['run', 'Hello', '--task', task.id], options)
  assert.match(result.stdout, /Standalone Shun works/)
  assert.equal((await call('hello')).pid, servicePid)
  assert.equal((await call('task.snapshot', { taskId: task.id })).turns.length, 2)
  await execute(executable, ['service', 'stop'], options)
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await call('hello') } catch { servicePid = undefined; break }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(servicePid, undefined, 'service must shut down cleanly')
  console.log('Installed npm package passed: simultaneous startup, provider configuration, streamed conversation, task persistence, graceful shutdown.')
} finally {
  if (servicePid) try { process.kill(servicePid, 'SIGTERM') } catch {}
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
  await rm(temporary, { recursive: true, force: true })
}
