import assert from 'node:assert/strict'
import test from 'node:test'
import { createDevStderrFilter, isIgnoredDevStderrLine } from './dev-stderr-filter.mjs'

test('development stderr only suppresses the two known macOS input diagnostics', async () => {
  assert.equal(isIgnoredDevStderrLine('Electron TSM AdjustCapsLockLEDForKeyTransitionHandling - _ISSetPhysicalKeyboardCapsLockLED Inhibit', 'darwin'), true)
  assert.equal(isIgnoredDevStderrLine('Electron error messaging the mach port for IMKCFRunLoopWakeUpReliable', 'darwin'), true)
  assert.equal(isIgnoredDevStderrLine('[BABEL] Note: large file', 'darwin'), false)
  assert.equal(isIgnoredDevStderrLine('fatal renderer crash', 'darwin'), false)
  assert.equal(isIgnoredDevStderrLine('Electron error messaging the mach port for IMKCFRunLoopWakeUpReliable', 'linux'), false)

  const filter = createDevStderrFilter('darwin')
  let output = ''
  filter.on('data', chunk => { output += chunk.toString() })
  filter.write('real warning\n2026 Electron TSM AdjustCapsLockLEDForKeyTransitionHandling - _ISSetPhysical')
  filter.write('KeyboardCapsLockLED Inhibit\nanother error\n')
  filter.end('Electron error messaging the mach port for IMKCFRunLoopWakeUpReliable')
  await new Promise(resolve => filter.on('end', resolve))

  assert.equal(output, 'real warning\nanother error\n')
})
