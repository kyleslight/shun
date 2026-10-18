import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { createShellTool, interpreterGuidance, workspaceCommandEnvironment } from './shell-tool.ts'

test('foreground tests choose their own mode even when Shun was launched in production', { skip: process.platform === 'win32' }, async () => {
  const before = { NODE_ENV: process.env.NODE_ENV, NODE_ENV_ELECTRON_VITE: process.env.NODE_ENV_ELECTRON_VITE }
  process.env.NODE_ENV = process.env.NODE_ENV_ELECTRON_VITE = 'production'
  try {
    const tool = createShellTool(process.cwd())
    const output = async (command: string) => JSON.stringify((await tool.execute('env-mode', { command }, undefined, undefined, undefined as never)).content)
    assert.match(await output('printf "mode=%s" "${NODE_ENV-unset}"'), /mode=unset/)
    assert.match(await output("NODE_ENV=test sh -c 'printf mode=%s \"$NODE_ENV\"'"), /mode=test/)
    assert.equal(process.env.NODE_ENV, 'production')
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('the stable Bash definition keeps foreground work bounded without encouraging environment scavenging', () => {
  const tool = createShellTool('/tmp/task')
  assert.equal(tool.name, 'bash')
  assert.match(tool.description, /120-second timeout/)
  assert.match(tool.description, /background process tools/)
  assert.match(tool.description, /inherited non-interactive environment/)
  assert.match(tool.description, /task-root \.venv or venv and node_modules\/\.bin/)
  assert.match(tool.description, /python, pip, pytest, node.*resolve through that project environment automatically/)
  assert.match(tool.description, /do not inspect or activate it again/i)
  assert.match(tool.description, /follow explicit project configuration for a local environment or tool manager/)
  assert.match(tool.description, /do not scan unrelated host paths/)
  assert.match(tool.description, /Do not initiate an interactive login/)
  assert.doesNotMatch(tool.description, /anonymous HTTP failure/i)
  assert.match(tool.promptSnippet || '', /bounded foreground shell commands/)
})

test('POSIX hosts and Git Bash keep the unchanged shell contract, Windows interpreters are described explicitly', () => {
  assert.equal(interpreterGuidance(), '')
  assert.equal(interpreterGuidance({ kind: 'bash', label: 'Git Bash', file: 'C:\\Program Files\\Git\\bin\\bash.exe', commandArgs: ['-c'], syntax: '' }), '')
  const guidance = interpreterGuidance({
    kind: 'powershell',
    label: 'Windows PowerShell 5.1 (powershell.exe)',
    file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    commandArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
    syntax: 'Commands run in Windows PowerShell 5.1: separate statements with ; (there is no && or || chaining).',
  })
  assert.match(guidance, /shell tool executes commands with Windows PowerShell 5\.1 \(powershell\.exe\) instead of bash/)
  assert.match(guidance, /no && or \|\| chaining/)
  const tool = createShellTool('/tmp/task')
  assert.doesNotMatch(tool.description, /instead of bash/)
  assert.match(tool.promptGuidelines!.join(' '), /Use Bash for execution, builds, and tests/)
})

test('workspace command environment prefers conventional local runtimes without scanning elsewhere', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-shell-env-'))
  const python = join(root, '.venv', 'bin', 'python')
  const nodeBin = join(root, 'node_modules', '.bin')
  try {
    await mkdir(join(root, '.venv', 'bin'), { recursive: true })
    await mkdir(nodeBin, { recursive: true })
    await writeFile(join(root, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n')
    await writeFile(python, '#!/bin/sh\necho project-python\n')
    await chmod(python, 0o755)
    const resolved = workspaceCommandEnvironment(root, { PATH: '/usr/bin:/bin', VIRTUAL_ENV: '/other' })
    assert.equal(resolved.env.VIRTUAL_ENV, join(root, '.venv'))
    assert.deepEqual(resolved.active, ['.venv', 'node_modules/.bin'])
    assert.deepEqual(resolved.env.PATH?.split(delimiter).slice(0, 2), [join(root, '.venv', 'bin'), nodeBin])
    const tool = createShellTool(root)
    const result = await tool.execute('project-python', { command: 'python' }, undefined, undefined, undefined as never)
    assert.match(result.content.map(item => item.type === 'text' ? item.text : '').join('\n'), /project-python/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('shell definitions stay stable while commands discover newly installed project tooling', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-shell-live-env-'))
  try {
    const before = createShellTool(root)
    const bin = join(root, 'node_modules', '.bin')
    await mkdir(bin, { recursive: true })
    const command = join(bin, 'shun-env-probe')
    await writeFile(command, '#!/bin/sh\necho project-tool-ready\n')
    await chmod(command, 0o755)
    const after = createShellTool(root)
    assert.equal(after.description, before.description)
    assert.deepEqual(after.parameters, before.parameters)
    for (const tool of [before, after]) {
      const result = await tool.execute('live-project-tool', { command: 'shun-env-probe' }, undefined, undefined, undefined as never)
      assert.match(JSON.stringify(result.content), /project-tool-ready/)
    }
    await rm(join(root, 'node_modules'), { recursive: true })
    assert.equal(createShellTool(root).description, before.description)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('workspace command environment leaves the inherited path unchanged when no local runtime exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-shell-no-env-'))
  try {
    const resolved = workspaceCommandEnvironment(root, { PATH: '/usr/bin:/bin' })
    assert.equal(resolved.env.PATH, '/usr/bin:/bin')
    assert.deepEqual(resolved.active, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('shell commands receive a bounded foreground timeout by default', async () => {
  const tool = createShellTool(process.cwd())
  await assert.rejects(
    () => tool.execute('timeout', { command: 'sleep 2', timeout: .01 }, undefined, undefined, undefined as never),
    /timed out/i,
  )
})

test('bounded exploration is not reported as a failure', { skip: process.platform === 'win32' }, async () => {
  const tool = createShellTool(process.cwd())
  // The most common agent command shape: a producer large enough that `head`
  // closes the pipe before the producer finishes. That is success by design, and
  // an earlier command in the pipeline is what a failure would have to mean.
  const result = await tool.execute('pipeline', { command: 'seq 1 200000 | head -3' }, undefined, undefined, undefined as never)
  assert.match(JSON.stringify(result.content), /1\\n2\\n3/)
  // A real producer failure is still a failure.
  await assert.rejects(
    () => tool.execute('pipeline', { command: 'ls /definitely-not-a-real-path-xyz' }, undefined, undefined, undefined as never),
    /Command exited with code/,
  )
})
