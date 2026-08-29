import assert from 'node:assert/strict'
import test from 'node:test'
import { browserDebugUrl, browserDebugWait, browserPreviewUrl, isLoopbackHttpUrl } from './browser-debug.ts'

test('browser debugging is restricted to explicit loopback HTTP origins', () => {
  assert.equal(browserDebugUrl('http://localhost:5174/#hero'), 'http://localhost:5174/')
  assert.equal(browserDebugUrl('http://127.0.0.1:3000/app'), 'http://127.0.0.1:3000/app')
  assert.equal(browserDebugUrl('http://[::1]:8080/'), 'http://[::1]:8080/')
  assert.equal(isLoopbackHttpUrl('https://localhost:8443/'), true)
  for (const value of ['https://example.com', 'http://192.168.1.10:5174', 'file:///tmp/index.html', 'http://user:pass@localhost:5174']) {
    assert.throws(() => browserDebugUrl(value), /only accepts localhost/)
  }
  assert.throws(() => browserDebugUrl(`http://localhost:5174/?q=${'x'.repeat(2_100)}`), /too long/)
})

test('Browser Preview navigation accepts remote HTTP pages without embedded credentials', () => {
  assert.equal(browserPreviewUrl('https://example.com/app#section'), 'https://example.com/app#section')
  assert.equal(browserPreviewUrl('http://192.168.1.10:5174/'), 'http://192.168.1.10:5174/')
  assert.throws(() => browserPreviewUrl('file:///tmp/index.html'), /HTTP\(S\)/)
  assert.throws(() => browserPreviewUrl('https://user:pass@example.com'), /credentials/)
})

test('browser debug settling time is bounded', () => {
  assert.equal(browserDebugWait(undefined), 700)
  assert.equal(browserDebugWait(-1), 0)
  assert.equal(browserDebugWait(900.9), 900)
  assert.equal(browserDebugWait(60_000), 5_000)
})
