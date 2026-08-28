import assert from 'node:assert/strict'
import test from 'node:test'
import { createShellTool } from './shell-tool.ts'

test('the stable Bash definition exposes local tools, inherited environment, and existing authentication', () => {
  const tool = createShellTool('/tmp/task')
  assert.equal(tool.name, 'bash')
  assert.match(tool.description, /locally installed command-line tools/)
  assert.match(tool.description, /environment variables/)
  assert.match(tool.description, /SSH agents/)
  assert.match(tool.description, /existing non-interactive credentials/)
  assert.match(tool.description, /missing conventional environment variable does not prove/)
  assert.match(tool.description, /anonymous HTTP failure does not prove/)
  assert.match(tool.description, /Do not initiate an interactive login/)
  assert.match(tool.promptSnippet || '', /desktop user’s existing environment/)
})

test('shell pipelines surface an earlier command failure', { skip: process.platform === 'win32' }, async () => {
  const tool = createShellTool(process.cwd())
  await assert.rejects(
    () => tool.execute('pipeline', { command: 'false | true' }, undefined, undefined, undefined as never),
    /Command exited with code 1/,
  )
})
