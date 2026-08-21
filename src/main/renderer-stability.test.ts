import assert from 'node:assert/strict'
import test from 'node:test'
import { isExternalWebUrl, isTrustedRendererNavigation, needsJitlessRenderer, shouldRecoverRenderer } from './renderer-stability.ts'

test('Electron 43 renderer uses the macOS 26 ARM64 JIT crash workaround only on the affected platform', () => {
  assert.equal(needsJitlessRenderer('darwin', 'arm64', '25.6.0', '43.4.0'), true)
  assert.equal(needsJitlessRenderer('darwin', 'x64', '25.6.0', '43.4.0'), false)
  assert.equal(needsJitlessRenderer('darwin', 'arm64', '24.6.0', '43.4.0'), false)
  assert.equal(needsJitlessRenderer('linux', 'arm64', '25.6.0', '43.4.0'), false)
  assert.equal(needsJitlessRenderer('darwin', 'arm64', '25.6.0', '44.0.0'), false)
})

test('native renderer exits recover once without entering a rapid reload loop', () => {
  assert.equal(shouldRecoverRenderer('crashed', Number.POSITIVE_INFINITY), true)
  assert.equal(shouldRecoverRenderer('oom', 30_000), true)
  assert.equal(shouldRecoverRenderer('crashed', 5_000), false)
  assert.equal(shouldRecoverRenderer('clean-exit', Number.POSITIVE_INFINITY), false)
})

test('the product window cannot be replaced by generated localhost or public web apps', () => {
  assert.equal(isTrustedRendererNavigation('http://localhost:5173/task', 'http://localhost:5173/'), true)
  assert.equal(isTrustedRendererNavigation('http://localhost:5174/', 'http://localhost:5173/'), false)
  assert.equal(isTrustedRendererNavigation('https://example.com/', 'http://localhost:5173/'), false)
  assert.equal(isTrustedRendererNavigation('file:///app/out/renderer/index.html', 'file:///app/out/renderer/index.html'), true)
  assert.equal(isTrustedRendererNavigation('file:///tmp/other.html', 'file:///app/out/renderer/index.html'), false)
  assert.equal(isExternalWebUrl('http://localhost:5174/'), true)
  assert.equal(isExternalWebUrl('javascript:alert(1)'), false)
})
