import assert from 'node:assert/strict'
import test from 'node:test'
import { isShellTool, shellCommand } from '../renderer/src/tool-presentation.ts'

test('Pi bash and legacy run tools share one shell presentation path', () => {
  assert.equal(isShellTool('bash'), true)
  assert.equal(isShellTool('run'), true)
  assert.equal(isShellTool('read'), false)
  assert.equal(shellCommand({ name: 'bash', input: '{"command":"lsof -ti :5174 | xargs kill"}' }), 'lsof -ti :5174 | xargs kill')
  assert.equal(shellCommand({ name: 'run', input: '{"command":" pnpm build "}' }), 'pnpm build')
})

test('malformed shell input produces an empty safe detail instead of a dot placeholder', () => {
  assert.equal(shellCommand({ name: 'bash', input: 'not json' }), '')
})
