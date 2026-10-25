import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as pty from 'node-pty'
import { ShunHostService } from '../src/host/service.ts'
import { startHostServer } from '../src/host/transport.ts'

const root = await mkdtemp(join(tmpdir(), 'shun-onboarding-'))
const home = join(root, 'home'), workspace = join(root, 'workspace')
await mkdir(workspace)
const service = new ShunHostService(home)
const original = service.call.bind(service)
// Exercise the real onboarding and persistence without external credentials or requests.
service.call = (method, input) => method === 'provider.models' ? Promise.resolve(['fixture-model']) : original(method, input)
const host = await startHostServer(home, service)
let terminal, output = ''
async function until(check) {
  const deadline = Date.now() + 10000
  while (!await check()) {
    if (Date.now() > deadline) throw Error('Onboarding did not reach the expected step.')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
try {
  for (const stage of ['provider list', 'secret input']) {
    output = ''
    terminal = pty.spawn(process.execPath, [resolve('packages/shun/bin/shun.mjs')], {
      cols: 110, rows: 35, cwd: workspace, env: { ...process.env, SHUN_HOME: home, TERM: 'xterm-256color' },
    })
    let exited = false
    terminal.onExit(() => { exited = true })
    terminal.onData(data => { output += data })
    await until(() => output.includes('Connect a provider'))
    if (stage === 'secret input') {
      terminal.write('Anthropic'); await new Promise(resolve => setTimeout(resolve, 100)); terminal.write('\r')
      await until(() => output.includes('Paste your key'))
      terminal.write('discarded-secret')
    }
    terminal.write('\x03'); await new Promise(resolve => setTimeout(resolve, 50)); terminal.write('\x03')
    await until(() => exited)
    assert.equal((await original('configuration')).providers.length, 0, 'exit must not save partial credentials')
  }
  output = ''
  terminal = pty.spawn(process.execPath, [resolve('packages/shun/bin/shun.mjs'), '.'], {
    cols: 110, rows: 35, cwd: workspace, env: { ...process.env, SHUN_HOME: home, TERM: 'xterm-256color' },
  })
  terminal.onData(data => { output += data })
  await until(() => output.includes('Connect a provider'))
  assert.equal(output.includes('Provider name'), false)
  terminal.write('Anthropic')
  await new Promise(resolve => setTimeout(resolve, 150))
  terminal.write('\r')
  await until(() => output.includes('Paste your key'))
  terminal.write('onboarding-fixture-secret')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(output.includes('onboarding-fixture-secret'), false)
  terminal.write('\r')
  await until(() => output.includes('Choose model'))
  terminal.write('\r')
  await until(async () => (await original('task.list')).length === 1)
  const config = await original('configuration')
  assert.equal(config.providers[0].name, 'Anthropic')
  assert.equal(config.model, 'fixture-model')
  assert.equal(output.includes('Context window (tokens)'), false)
  await until(() => output.includes('/help for commands'))
  const originalTask = (await original('task.list'))[0]
  terminal.write('\x04')
  await until(() => output.includes(`shun --session ${originalTask.id}`))
  await new Promise(resolve => setTimeout(resolve, 150))
  output = ''
  terminal = pty.spawn(process.execPath, [resolve('packages/shun/bin/shun.mjs')], {
    cols: 110, rows: 35, cwd: workspace, env: { ...process.env, SHUN_HOME: home, TERM: 'xterm-256color' },
  })
  terminal.onData(data => { output += data })
  await until(() => output.includes('managed working directory') && output.includes('/help for commands'))
  await new Promise(resolve => setTimeout(resolve, 100))
  let tasks = await original('task.list')
  assert.equal(tasks.filter(task => task.workspace === '').length, 1)
  terminal.write('/new\r')
  await until(async () => (await original('task.list')).filter(task => task.workspace === '').length === 2)
  terminal.write('\x04')
  await new Promise(resolve => setTimeout(resolve, 150))
  output = ''
  terminal = pty.spawn(process.execPath, [resolve('packages/shun/bin/shun.mjs'), '-c'], {
    cols: 110, rows: 35, cwd: workspace, env: { ...process.env, SHUN_HOME: home, TERM: 'xterm-256color' },
  })
  terminal.onData(data => { output += data })
  await until(() => output.includes('managed working directory') && output.includes('/help for commands'))
  tasks = await original('task.list')
  assert.equal(tasks.length, 3, 'continue must reuse a conversation instead of creating one')
  terminal.write('\x04')
  await until(() => output.includes('Resume this conversation:'))
  await new Promise(resolve => setTimeout(resolve, 100))
  output = ''
  terminal = pty.spawn(process.execPath, [resolve('packages/shun/bin/shun.mjs'), '--session', originalTask.id], {
    cols: 110, rows: 35, cwd: root, env: { ...process.env, SHUN_HOME: home, TERM: 'xterm-256color' },
  })
  terminal.onData(data => { output += data })
  await until(() => output.includes(workspace) && output.includes('/help for commands'))
  assert.equal((await original('task.list')).length, 3, 'the exit command must restore the original conversation from another directory')
  terminal.write('\x04')
  await until(() => output.includes(`shun --session ${originalTask.id}`))
  console.log('PASS: searchable first-run provider selection, masked credential, model choice and task creation')
  console.log('PASS: Ctrl+C exits provider and secret pages; standalone startup, /new and -c preserve workspace scope')
} finally {
  terminal?.kill()
  await host.close()
  await rm(root, { recursive: true, force: true })
}
