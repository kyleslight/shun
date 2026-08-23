import assert from 'node:assert/strict'
import test from 'node:test'
import { hydrateProcessPath, mergePaths, pathFromShellOutput } from './shell-environment.ts'

test('extracts PATH from a login shell even when startup files print text', () => {
  assert.equal(pathFromShellOutput('startup message\nHOME=/Users/example\0PATH=/Users/example/.nvm/versions/node/v20/bin:/usr/bin\0'), '/Users/example/.nvm/versions/node/v20/bin:/usr/bin')
  assert.equal(pathFromShellOutput('HOME=/Users/example\0SHELL=/bin/zsh\0'), '')
})

test('merges shell PATH first without duplicating inherited entries', () => {
  assert.equal(mergePaths('/Users/example/.nvm/bin:/usr/bin', '/usr/bin:/bin', ':'), '/Users/example/.nvm/bin:/usr/bin:/bin')
})

test('hydrates the process PATH from the interactive login shell only', async () => {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', SECRET: 'keep' }
  const calls: Array<{ shell: string; args: string[] }> = []
  const path = await hydrateProcessPath(env, 'darwin', async (shell, args) => {
    calls.push({ shell, args })
    return 'SECRET=replace\0PATH=/Users/example/.nvm/versions/node/v20/bin:/usr/bin\0'
  })
  assert.equal(path, '/Users/example/.nvm/versions/node/v20/bin:/usr/bin:/bin')
  assert.equal(env.PATH, path)
  assert.equal(env.SECRET, 'keep')
  assert.deepEqual(calls, [{ shell: '/bin/zsh', args: ['-ilc', 'env -0'] }])
})

test('leaves PATH unchanged when shell discovery fails or is unsupported', async () => {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
  assert.equal(await hydrateProcessPath(env, 'darwin', async () => { throw Error('failed') }), '/usr/bin')
  assert.equal(await hydrateProcessPath(env, 'win32', async () => { throw Error('must not run') }), '/usr/bin')
})
