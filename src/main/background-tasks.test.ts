import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createServer } from 'node:net'
import test from 'node:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BackgroundTaskManager, backgroundShellCommand } from './background-tasks.ts'
import type { WindowsShell } from './windows-shell.ts'

async function until(check: () => boolean | Promise<boolean>, timeout = 4_000) {
  const started = Date.now()
  while (!await check()) {
    if (Date.now() - started > timeout) throw Error('Timed out waiting for background process state.')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

test('background tests do not inherit the application build mode', { skip: process.platform === 'win32' }, async () => {
  const before = { NODE_ENV: process.env.NODE_ENV, NODE_ENV_ELECTRON_VITE: process.env.NODE_ENV_ELECTRON_VITE }
  process.env.NODE_ENV = process.env.NODE_ENV_ELECTRON_VITE = 'production'
  const manager = new BackgroundTaskManager(() => {})
  try {
    const task = await manager.start({ sessionId: 'env', createdByRunId: 'env-run', workspace: process.cwd(), command: 'printf "mode=%s" "${NODE_ENV-unset}"' })
    await until(() => manager.list('env')[0].state === 'exited')
    assert.equal(manager.list('env')[0].exitCode, 0)
    assert.match(manager.output('env', task.id).map(chunk => chunk.text).join(''), /mode=unset/)
    assert.equal(process.env.NODE_ENV, 'production')
  } finally {
    manager.stopAll()
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('background process is task-owned, observable, and stoppable as a process group', async () => {
  const port = await freePort()
  const workspace = await mkdtemp(join(tmpdir(), 'shun-background-'))
  const events: any[] = []
  const manager = new BackgroundTaskManager(event => events.push(event), { outputBytes: 8_000 })
  const code = `require('node:http').createServer((_,r)=>r.end('ok')).listen(${port}, '127.0.0.1', () => console.log('http://127.0.0.1:${port}/ready')); setInterval(() => console.error('tick'), 25)`
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
    await until(() => manager.list('session-a')[0].endpoints.length > 0)
    const visible = manager.list('session-a')[0]
    assert.deepEqual(visible.endpoints, [`http://127.0.0.1:${port}/ready`])
    assert.ok(visible.outputSeq > 0)
    assert.ok(events.some(event => event.type === 'output'))
    assert.throws(() => manager.discardSession('session-a'), /Stop managed background processes/)
    assert.equal((await manager.stop('session-a', task.id)).state, 'stopping')
    await until(() => ['stopped', 'exited', 'failed'].includes(manager.list('session-a')[0].state))
    assert.equal(manager.list('session-a')[0].state, 'stopped')
    assert.equal(manager.discardSession('session-a'), 1)
    assert.deepEqual(manager.list('session-a'), [])
  } finally {
    manager.stopAll()
  }
})

test('task cleanup waits for background process exit before discarding its records', async () => {
  const manager = new BackgroundTaskManager(() => {})
  const task = await manager.start({
    sessionId: 'cleanup', createdByRunId: 'cleanup-run', workspace: process.cwd(),
    command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
  })
  try {
    const stopped = await manager.stopAndWait('cleanup', task.id)
    assert.equal(stopped.state, 'stopped')
    assert.equal(manager.discardSession('cleanup'), 1)
    assert.deepEqual(manager.list('cleanup'), [])
  } finally { manager.stopAll() }
})

test('a standalone project runs from task-owned storage and exposes a Browser Preview endpoint', async () => {
  const port = await freePort()
  const cwd = await mkdtemp(join(tmpdir(), 'shun-background-standalone-'))
  const manager = new BackgroundTaskManager(() => {}, { outputBytes: 8_000 })
  const code = `console.log(process.cwd()); require('node:http').createServer((_,r)=>r.end('ok')).listen(${port}, '0.0.0.0', () => console.log('http://0.0.0.0:${port}/game'))`
  const task = await manager.start({
    sessionId: 'session-standalone',
    createdByRunId: 'run-standalone',
    workspace: '',
    cwd,
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`,
    previewUrl: `http://0.0.0.0:${port}/game`,
  })
  try {
    await until(() => manager.output('session-standalone', task.id).some(chunk => chunk.text.includes(cwd)))
    await until(() => manager.list('session-standalone')[0].endpoints.length === 1)
    const visible = manager.list('session-standalone')[0]
    assert.equal(visible.workspace, '')
    assert.deepEqual(visible.endpoints, [`http://localhost:${port}/game`])
  } finally {
    manager.stopAll()
  }
})

test('background preview URLs normalize wildcard bind addresses for the renderer', async () => {
  const port = await freePort()
  const workspace = await mkdtemp(join(tmpdir(), 'shun-background-preview-'))
  const manager = new BackgroundTaskManager(() => {}, { outputBytes: 8_000 })
  const code = `require('node:http').createServer((_,r)=>r.end('ok')).listen(${port}, '0.0.0.0', () => console.log('Serving HTTP on 0.0.0.0 port ${port} (http://0.0.0.0:${port}/quicksort.html)'))`
  const task = await manager.start({
    sessionId: 'session-preview',
    createdByRunId: 'run-preview',
    workspace,
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`,
    previewUrl: `http://0.0.0.0:${port}/quicksort.html`,
  })
  try {
    await until(() => manager.list('session-preview')[0].endpoints.length === 1)
    assert.equal(task.previewUrl, `http://localhost:${port}/quicksort.html`)
    await until(() => manager.output('session-preview', task.id).some(chunk => chunk.text.includes('Serving HTTP')))
    assert.deepEqual(manager.list('session-preview')[0].endpoints, [`http://localhost:${port}/quicksort.html`])
  } finally {
    await manager.stop('session-preview', task.id)
    manager.stopAll()
  }
})

test('background output discovers wildcard local server URLs without an explicit preview URL', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-background-discovery-'))
  const manager = new BackgroundTaskManager(() => {}, { outputBytes: 8_000 })
  const code = "require('node:http').createServer((_,r)=>r.end('ok')).listen(0, '0.0.0.0', function(){console.log('Listening at http://0.0.0.0:'+this.address().port+'/')})"
  const task = await manager.start({
    sessionId: 'session-discovery',
    createdByRunId: 'run-discovery',
    workspace,
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`,
  })
  try {
    await until(() => manager.list('session-discovery')[0].endpoints.length > 0)
    assert.match(manager.list('session-discovery')[0].endpoints[0], /^http:\/\/localhost:\d+\/$/)
    assert.equal(manager.list('session-discovery')[0].previewUrl, undefined)
  } finally {
    await manager.stop('session-discovery', task.id)
    manager.stopAll()
  }
})

test('a preview cannot borrow another task\'s listener or trust a printed URL', async () => {
  const manager = new BackgroundTaskManager(() => {})
  const command = (code: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`
  const first = await manager.start({ sessionId: 'port-owner', createdByRunId: 'run-a', workspace: '',
    command: command("require('node:http').createServer((_,r)=>r.end('owner')).listen(0,'127.0.0.1',function(){console.log('http://127.0.0.1:'+this.address().port+'/')})") })
  try {
    await until(() => manager.list('port-owner')[0].endpoints.length > 0)
    const url = manager.list('port-owner')[0].endpoints[0]
    assert.equal(await manager.ownsEndpoint('port-owner', url), true)
    assert.equal(await manager.ownsEndpoint('port-borrower', url), false)
    assert.equal(await manager.ownsEndpoint('port-owner', url.replace('127.0.0.1', 'example.com')), false)
    await assert.rejects(manager.start({ sessionId: 'port-borrower', createdByRunId: 'run-b', workspace: '',
      command: command("throw Error('must not start')"), previewUrl: url }), /already occupied/)
    assert.equal(manager.list('port-borrower').length, 0)
    assert.equal(await (await fetch(url)).text(), 'owner')
    const impostor = await manager.start({ sessionId: 'printed-url', createdByRunId: 'run-c', workspace: '',
      command: command(`console.log(${JSON.stringify(url)});setInterval(()=>{},1000)`) })
    await until(() => manager.output('printed-url', impostor.id).length > 0)
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.deepEqual(manager.list('printed-url')[0].endpoints, [])
    assert.equal(await manager.ownsEndpoint('printed-url', url), false)
    await manager.stop('port-owner', first.id)
    await until(() => manager.list('port-owner')[0].state === 'stopped')
    assert.deepEqual(manager.list('port-owner')[0].endpoints, [])
    assert.equal(await manager.ownsEndpoint('port-owner', url), false)
  } finally { manager.stopAll() }
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

test('background_output long-polls for new output instead of sleep-polling', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-background-wait-'))
  const manager = new BackgroundTaskManager(() => {}, { outputBytes: 8_000 })
  const code = "setTimeout(() => console.log('verify?code=1 https://accounts.example.com/verify'), 300); setInterval(() => {}, 1000)"
  const task = await manager.start({
    sessionId: 'session-wait',
    createdByRunId: 'run-wait',
    workspace,
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`,
    label: 'wait probe',
  })
  try {
    // Nothing has been printed yet: a short wait resolves empty instead of throwing.
    assert.deepEqual(await manager.waitForOutput('session-wait', task.id, { waitMs: 120 }), [])
    // until wakes as soon as the substring appears, well before the deadline.
    const started = Date.now()
    const matched = await manager.waitForOutput('session-wait', task.id, { waitMs: 10_000, until: 'verify?code=1' })
    assert.ok(matched.some(chunk => chunk.text.includes('accounts.example.com/verify')))
    assert.ok(Date.now() - started < 10_000)
    // after_seq yields only newer chunks.
    assert.deepEqual(await manager.waitForOutput('session-wait', task.id, { afterSeq: matched.at(-1)!.seq, waitMs: 120 }), [])
    // Ownership is enforced on the waiting path too.
    await assert.rejects(() => manager.waitForOutput('session-b', task.id, { waitMs: 100 }), /not found/)
    // A lifecycle transition wakes the waiter instead of waiting out the deadline,
    // returning whatever unread output the process produced before exiting.
    const pending = manager.waitForOutput('session-wait', task.id, { waitMs: 15_000, until: 'never-appears' })
    await manager.stop('session-wait', task.id)
    assert.deepEqual(await pending, matched)
  } finally {
    manager.stopAll()
  }
})

test('background commands use the resolved Windows shell and keep the login shell elsewhere', () => {
  const command = 'npm run dev'
  assert.deepEqual(backgroundShellCommand('darwin', { SHELL: '/bin/zsh' }, command), { file: '/bin/zsh', args: ['-lc', command] })
  assert.deepEqual(backgroundShellCommand('linux', {}, command), { file: '/bin/zsh', args: ['-lc', command] })
  const powerShell = (): WindowsShell => ({
    kind: 'powershell',
    label: 'Windows PowerShell 5.1 (powershell.exe)',
    file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    commandArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
    outputEncoding: '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    syntax: '',
  })
  assert.deepEqual(backgroundShellCommand('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, command, powerShell), {
    file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`],
  })
  assert.deepEqual(backgroundShellCommand('win32', { SystemRoot: 'C:\\Windows' }, command), {
    file: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', command],
  })
})

test('observations distinguish a silent running process from a silent failure', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-background-observe-'))
  const manager = new BackgroundTaskManager(() => {})
  const task = await manager.start({ sessionId: 'owner', createdByRunId: 'run', workspace,
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setTimeout(() => process.exit(7), 500)')}` })
  try {
    await assert.rejects(manager.observe('other', task.id), /not found/)
    const running = await manager.observe('owner', task.id)
    assert.equal(running.task.state, 'running')
    assert.equal(running.task.exitCode, null)
    assert.deepEqual(running.output, [])
    const finished = await manager.observe('owner', task.id, { waitMs: 4_000 })
    assert.equal(finished.task.state, 'failed')
    assert.equal(finished.task.exitCode, 7)
    assert.ok(finished.task.finishedAt)
    assert.deepEqual(finished.output, [])
  } finally {
    manager.stopAll()
  }
})

test('an observation cursor does not replay output and retains the final status', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-background-cursor-'))
  const manager = new BackgroundTaskManager(() => {})
  const task = await manager.start({ sessionId: 'owner', createdByRunId: 'run', workspace,
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('ready'); setTimeout(() => process.exit(0), 500)")}` })
  try {
    const first = await manager.observe('owner', task.id, { waitMs: 4_000 })
    assert.match(first.output.map(chunk => chunk.text).join(''), /ready/)
    assert.ok(first.next_seq > 0)
    const final = await manager.observe('owner', task.id, { afterSeq: first.next_seq, waitMs: 4_000 })
    assert.deepEqual(final.output, [])
    assert.equal(final.next_seq, first.next_seq)
    assert.equal(final.task.exitCode, 0)
    assert.equal(final.task.state, 'exited')
  } finally {
    manager.stopAll()
  }
})

test('large background observations bound the model tail while retaining full logs and failure status', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-background-large-log-'))
  const manager = new BackgroundTaskManager(() => {}, { storageFile: join(workspace, 'tasks.json') })
  const producer = "process.stdout.write('start\\n' + 'x'.repeat(100000) + '\\nlast diagnostic\\n'); process.exitCode = 7"
  try {
    const task = await manager.start({ sessionId: 'owner', createdByRunId: 'run', workspace,
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(producer)}` })
    await until(() => manager.list('owner')[0].state === 'failed')
    const read = await manager.observe('owner', task.id, { until: 'start' })
    const text = read.output.map(chunk => chunk.text).join('')
    assert.equal(text.length, 12_000)
    assert.match(text, /last diagnostic/)
    assert.equal(read.truncated, true)
    assert.equal(read.matched, true, 'a match outside the returned tail is still reported')
    assert.ok(read.omitted_characters! > 80_000)
    assert.equal(read.task.exitCode, 7)
    assert.match(await readFile(read.log_files!.stdout!, 'utf8'), /^start\n/)
    assert.equal((await manager.observe('owner', task.id, { afterSeq: read.next_seq })).output.length, 0)
    assert.equal((await manager.observe('owner', task.id, { maxChars: 24_000 })).output.reduce((n, chunk) => n + chunk.text.length, 0), 24_000)
  } finally { manager.stopAll() }
})

test('an observation cursor never skips output arriving after its returned snapshot', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-background-cursor-race-'))
  const manager = new BackgroundTaskManager(() => {})
  const release = join(workspace, 'release-output')
  const producer = "const fs = require('node:fs'); console.log('first'); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); console.error('later diagnostic'); } }, 10)"
  const task = await manager.start({ sessionId: 'owner', createdByRunId: 'run', workspace,
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(producer)} ${JSON.stringify(release)}` })
  const wait = manager.waitForOutput.bind(manager)
  try {
    // Hold the first read's snapshot while the producer advances. The cursor must
    // acknowledge delivered chunks, not the producer's newer position.
    manager.waitForOutput = async (sessionId, taskId, options) => {
      const snapshot = await wait(sessionId, taskId, options)
      await writeFile(release, '')
      await until(() => manager.output(sessionId, taskId).some(chunk => chunk.text.includes('later diagnostic')))
      return snapshot
    }
    const first = await manager.observe('owner', task.id, { waitMs: 4_000 })
    assert.match(first.output.map(chunk => chunk.text).join(''), /first/)
    assert.doesNotMatch(first.output.map(chunk => chunk.text).join(''), /later diagnostic/)
    assert.equal(first.next_seq, first.output.at(-1)!.seq)
    manager.waitForOutput = wait
    const next = await manager.observe('owner', task.id, { afterSeq: first.next_seq })
    assert.match(next.output.map(chunk => chunk.text).join(''), /later diagnostic/)
  } finally { manager.stopAll() }
})

test('finished background processes retain final logs without further filesystem polling, including after restore', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-background-idle-'))
  const storageFile = join(workspace, 'tasks.json')
  const originalStat = fs.statSync
  let logChecks = 0
  t.mock.method(fs, 'statSync', (...args: Parameters<typeof fs.statSync>) => {
    if (String(args[0]).includes('background-logs')) logChecks++
    return Reflect.apply(originalStat, fs, args)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  let manager = new BackgroundTaskManager(() => {}, { storageFile, probeIntervalMs: 100 })
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('ready'); setTimeout(() => console.error('final diagnostic'), 350)")}`
  try {
    const task = await manager.start({ sessionId: 'owner', createdByRunId: 'run', workspace, command })
    await until(() => manager.output('owner', task.id).some(chunk => chunk.text.includes('ready')))
    assert.ok(logChecks > 0, 'running processes still deliver file-backed output')
    await until(() => manager.list('owner')[0].state === 'exited')
    assert.match(manager.output('owner', task.id).map(chunk => chunk.text).join(''), /final diagnostic/)
    const finishedChecks = logChecks
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.equal(logChecks, finishedChecks, 'no log checks after exit')
    manager.preserveForAppExit()
    const saved = JSON.parse(await readFile(storageFile, 'utf8'))
    // A long history must not turn into periodic filesystem work on restart.
    saved.tasks = Array.from({ length: 200 }, (_, index) => ({
      ...saved.tasks[0], public: { ...saved.tasks[0].public, id: `history-${index}` },
    }))
    await writeFile(storageFile, JSON.stringify(saved))
    logChecks = 0
    manager = new BackgroundTaskManager(() => {}, { storageFile, probeIntervalMs: 100 })
    assert.equal(manager.listAll().length, 200)
    assert.match(manager.output('owner', 'history-0').map(chunk => chunk.text).join(''), /final diagnostic/)
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.equal(logChecks, 0, 'restored history requires no log checks')
    const next = await manager.start({ sessionId: 'next', createdByRunId: 'next-run', workspace, command })
    await until(() => manager.list('next')[0].state === 'exited')
    assert.match(manager.output('next', next.id).map(chunk => chunk.text).join(''), /final diagnostic/)
    assert.ok(logChecks > 0, 'monitoring resumes for a new process')
    const nextChecks = logChecks
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.equal(logChecks, nextChecks)
  } finally { manager.stopAll() }
})
