import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isBlockedProductionWindowShortcut, isExternalWebUrl, isTrustedRendererNavigation, needsJitlessRenderer, shouldRecoverRenderer } from './renderer-stability.ts'

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

test('installed product windows block reload and Chromium inspection shortcuts', () => {
  const input = (key: string, overrides: Partial<{ control: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}) => ({
    key,
    control: false,
    meta: false,
    shift: false,
    alt: false,
    ...overrides,
  })
  assert.equal(isBlockedProductionWindowShortcut(input('r', { meta: true })), true)
  assert.equal(isBlockedProductionWindowShortcut(input('R', { control: true, shift: true })), true)
  assert.equal(isBlockedProductionWindowShortcut(input('F5')), true)
  assert.equal(isBlockedProductionWindowShortcut(input('F12')), true)
  assert.equal(isBlockedProductionWindowShortcut(input('i', { control: true, shift: true })), true)
  assert.equal(isBlockedProductionWindowShortcut(input('i', { meta: true, alt: true })), true)
  assert.equal(isBlockedProductionWindowShortcut(input('r')), false)
  assert.equal(isBlockedProductionWindowShortcut(input('f', { meta: true })), false)
})

test('installed builds disable DevTools and omit the reload-capable View menu', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
  assert.match(main, /devTools: !app\.isPackaged/)
  assert.match(main, /if \(app\.isPackaged\) \{[\s\S]*before-input-event[\s\S]*isBlockedProductionWindowShortcut\(input\)[\s\S]*devtools-opened[\s\S]*closeDevTools\(\)/)
  assert.match(main, /\.\.\.\(!app\.isPackaged \? \[\{ role: 'viewMenu' as const \}\] : \[\]\)/)
  assert.doesNotMatch(main, /globalShortcut\.register/)
})
