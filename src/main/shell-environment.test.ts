import assert from 'node:assert/strict'
import test from 'node:test'
import { environmentFromShellOutput, hydrateProcessEnvironment, mergePaths, pathFromShellOutput } from './shell-environment.ts'

test('extracts PATH from a login shell even when startup files print text', () => {
  assert.equal(pathFromShellOutput('startup message\nHOME=/Users/example\0PATH=/Users/example/.nvm/versions/node/v20/bin:/usr/bin\0'), '/Users/example/.nvm/versions/node/v20/bin:/usr/bin')
  assert.equal(pathFromShellOutput('HOME=/Users/example\0SHELL=/bin/zsh\0'), '')
})

test('extracts the complete null-delimited login environment after startup output', () => {
  assert.deepEqual(environmentFromShellOutput('startup message\nHOME=/Users/example\0JAVA_HOME=/Users/example/.jdks/17\0SSH_AUTH_SOCK=/tmp/agent.sock\0'), {
    HOME: '/Users/example',
    JAVA_HOME: '/Users/example/.jdks/17',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
  })
})

test('merges shell PATH first without duplicating inherited entries', () => {
  assert.equal(mergePaths('/Users/example/.nvm/bin:/usr/bin', '/usr/bin:/bin', ':'), '/Users/example/.nvm/bin:/usr/bin:/bin')
})

test('hydrates missing process variables and merges PATH from the interactive login shell', async () => {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', SECRET: 'keep' }
  const calls: Array<{ shell: string; args: string[] }> = []
  const path = await hydrateProcessEnvironment(env, 'darwin', async (shell, args) => {
    calls.push({ shell, args })
    return 'SECRET=replace\0PATH=/Users/example/.nvm/versions/node/v20/bin:/usr/bin\0JAVA_HOME=/Users/example/.jdks/17\0SSH_AUTH_SOCK=/tmp/agent.sock\0PWD=/tmp/wrong\0ELECTRON_RENDERER_URL=http://localhost:5173\0SHUN_USER_DATA=/tmp/wrong-state\0'
  })
  assert.equal(path, '/Users/example/.nvm/versions/node/v20/bin:/usr/bin:/bin')
  assert.equal(env.PATH, path)
  assert.equal(env.SECRET, 'keep')
  assert.equal(env.JAVA_HOME, '/Users/example/.jdks/17')
  assert.equal(env.SSH_AUTH_SOCK, '/tmp/agent.sock')
  assert.equal(env.PWD, undefined)
  assert.equal(env.ELECTRON_RENDERER_URL, undefined)
  assert.equal(env.SHUN_USER_DATA, undefined)
  assert.deepEqual(calls, [{ shell: '/bin/zsh', args: ['-ilc', 'env -0'] }])
})

test('leaves PATH unchanged when shell discovery fails', async () => {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
  assert.equal(await hydrateProcessEnvironment(env, 'darwin', async () => { throw Error('failed') }), '/usr/bin')
})

test('hydrates Windows PATH from the machine registry instead of a login shell', async () => {
  const env: NodeJS.ProcessEnv = {
    Path: 'C:\\Windows\\system32;C:\\Windows',
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local',
  }
  const calls: Array<{ file: string; args: string[] }> = []
  const path = await hydrateProcessEnvironment(env, 'win32', async (file, args) => {
    calls.push({ file, args })
    return args[1] === 'HKCU\\Environment'
      ? 'HKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %LOCALAPPDATA%\\Programs\\nodejs;%SystemRoot%\\system32\r\n'
      : 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\Program Files\\Git\\cmd;%SystemRoot%\\system32\r\n'
  })
  assert.equal(path, 'C:\\Program Files\\Git\\cmd;C:\\Windows\\system32;C:\\Users\\example\\AppData\\Local\\Programs\\nodejs;C:\\Windows')
  assert.equal(env.Path, path)
  assert.deepEqual(calls, [
    { file: 'reg', args: ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'Path'] },
    { file: 'reg', args: ['query', 'HKCU\\Environment', '/v', 'Path'] },
  ])
})

test('keeps the inherited Windows PATH when the registry cannot be read', async () => {
  const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows\\system32' }
  assert.equal(await hydrateProcessEnvironment(env, 'win32', async () => { throw Error('no reg') }), 'C:\\Windows\\system32')
})
