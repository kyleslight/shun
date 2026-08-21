import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BackgroundTaskManager } from './background-tasks.ts'

async function until(check: () => boolean | Promise<boolean>, timeout = 4_000) {
  const started = Date.now()
  while (!await check()) {
    if (Date.now() - started > timeout) throw Error('Timed out waiting for background process state.')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('background process is task-owned, observable, and stoppable as a process group', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-background-'))
  const events: any[] = []
  const manager = new BackgroundTaskManager(event => events.push(event), { outputBytes: 8_000 })
  const code = "console.log('http://127.0.0.1:4321/ready'); setInterval(() => console.error('tick'), 25)"
  const task = await manager.start({
    sessionId: 'session-a',
    createdByRunId: 'run-a',
    workspace,
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`,
    label: 'test server',
  })
  try {
    assert.equal(task.state, 'running')
    assert.ok(task.pid)
    assert.equal(manager.list('session-b').length, 0)
    assert.deepEqual(manager.listAll().map(item => item.id), [task.id])
    assert.throws(() => manager.output('session-b', task.id), /not found/)
    await until(() => manager.output('session-a', task.id).some(chunk => chunk.text.includes('/ready')))
    const visible = manager.list('session-a')[0]
    assert.deepEqual(visible.endpoints, ['http://127.0.0.1:4321/ready'])
    assert.ok(visible.outputSeq > 0)
    assert.ok(events.some(event => event.type === 'output'))
    assert.equal((await manager.stop('session-a', task.id)).state, 'stopping')
    await until(() => ['stopped', 'exited', 'failed'].includes(manager.list('session-a')[0].state))
    assert.equal(manager.list('session-a')[0].state, 'stopped')
  } finally {
    manager.stopAll()
  }
})

test('background limits are enforced structurally per task', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-background-limit-'))
  const manager = new BackgroundTaskManager(() => {}, { perSession: 1, global: 2 })
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(() => {}, 1000)')}`
  const first = await manager.start({ sessionId: 'session-a', createdByRunId: 'run-a', workspace, command })
  try {
    await assert.rejects(manager.start({ sessionId: 'session-a', createdByRunId: 'run-b', workspace, command }), /for this task/)
    const second = await manager.start({ sessionId: 'session-b', createdByRunId: 'run-b', workspace, command })
    await assert.rejects(manager.start({ sessionId: 'session-c', createdByRunId: 'run-c', workspace, command }), /globally/)
    await manager.stop('session-b', second.id)
  } finally {
    await manager.stop('session-a', first.id)
    manager.stopAll()
  }
})

test('background process records and bounded output persist to disk', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-background-persist-'))
  const storageFile = join(workspace, 'background-processes.json')
  const manager = new BackgroundTaskManager(() => {}, { storageFile, outputBytes: 8_000, probeIntervalMs: 100 })
  const code = "console.log('persisted output'); setInterval(() => {}, 1000)"
  const task = await manager.start({
    sessionId: 'session-persisted',
    createdByRunId: 'run-persisted',
    workspace,
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`,
  })
  try {
    await until(() => manager.output('session-persisted', task.id).some(chunk => chunk.text.includes('persisted output')))
    await until(async () => {
      const saved = JSON.parse(await readFile(storageFile, 'utf8'))
      return saved.tasks?.[0]?.output?.some((chunk: any) => chunk.text.includes('persisted output'))
    })
    const saved = JSON.parse(await readFile(storageFile, 'utf8'))
    assert.equal(saved.version, 1)
    assert.equal(saved.tasks[0].public.id, task.id)
    assert.ok(saved.tasks[0].output.some((chunk: any) => chunk.text.includes('persisted output')))
  } finally {
    manager.stopAll()
  }
})

test('a restarted manager recovers and reconciles a surviving process group', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-background-recover-'))
  const storageFile = join(workspace, 'background-processes.json')
  const managerUrl = pathToFileURL(join(process.cwd(), 'src/main/background-tasks.ts')).href
  const hostScript = `
    import { BackgroundTaskManager } from ${JSON.stringify(managerUrl)};
    const manager = new BackgroundTaskManager(() => {}, { storageFile: ${JSON.stringify(storageFile)}, probeIntervalMs: 100 });
    const task = await manager.start({
      sessionId: 'session-recovered',
      createdByRunId: 'run-recovered',
      workspace: ${JSON.stringify(workspace)},
      command: JSON.stringify(process.execPath) + ' -e ' + JSON.stringify('setInterval(() => console.log("alive"), 25)'),
      label: 'recovered process',
    });
    process.stdout.write(String(task.pid), () => {
      manager.preserveForAppExit();
      process.exit(0);
    });
  `
  const host = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', hostScript], {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  host.stdout.on('data', chunk => { stdout += chunk })
  host.stderr.on('data', chunk => { stderr += chunk })
  const [code] = await once(host, 'close')
  assert.equal(code, 0, stderr)
  const pid = Number(stdout.trim())
  assert.ok(pid > 0)
  process.kill(process.platform === 'win32' ? pid : -pid, 0)
  const manager = new BackgroundTaskManager(() => {}, { storageFile, probeIntervalMs: 100 })
  try {
    assert.equal(manager.listAll()[0].state, 'running')
    const id = manager.listAll()[0].id
    assert.equal(manager.listAll()[0].pid, pid)
    assert.equal((await manager.stop('session-recovered', id)).state, 'stopping')
    await until(() => manager.listAll()[0].state === 'stopped')
    const restarted = new BackgroundTaskManager(() => {}, { storageFile, probeIntervalMs: 100 })
    try {
      assert.equal(restarted.listAll()[0].state, 'stopped')
    } finally {
      restarted.stopAll()
    }
  } finally {
    manager.stopAll()
  }
})
