import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { createShellTool, workspaceCommandEnvironment } from './shell-tool.ts'

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
    assert.match(tool.description, /Detected project command environment: \.venv, node_modules\/\.bin/)
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

test('shell pipelines surface an earlier command failure', { skip: process.platform === 'win32' }, async () => {
  const tool = createShellTool(process.cwd())
  await assert.rejects(
    () => tool.execute('pipeline', { command: 'false | true' }, undefined, undefined, undefined as never),
    /Command exited with code 1/,
  )
})
