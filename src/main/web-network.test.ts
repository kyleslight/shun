import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { configuredWebProxy } from './web-network.ts'

test('public routing follows deployment changes and removal without a restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'shun-web-network-'))
  try {
    assert.equal(await configuredWebProxy(home, {}), undefined)
    const file = join(home, 'web-network.json')
    await writeFile(file, JSON.stringify({ publicProxyUrl: 'http://127.0.0.1:18797' }))
    assert.equal(await configuredWebProxy(home, {}), 'http://127.0.0.1:18797/')
    assert.equal(await configuredWebProxy(home, { SHUN_WEB_PROXY: 'https://proxy.example:443' }), 'https://proxy.example/')
    await writeFile(file, JSON.stringify({ publicProxyUrl: '' }))
    assert.equal(await configuredWebProxy(home, {}), '')
    await rm(file)
    assert.equal(await configuredWebProxy(home, {}), undefined)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('invalid routing configuration falls back without treating a page URL as a proxy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'shun-web-network-'))
  try {
    for (const value of ['not a URL', 'file:///tmp/socket', 'https://proxy.example/page', 'http://proxy.example/?key=value']) {
      assert.equal(await configuredWebProxy(home, { SHUN_WEB_PROXY: value }), undefined)
    }
    await writeFile(join(home, 'web-network.json'), '{')
    assert.equal(await configuredWebProxy(home, {}), undefined)
  } finally { await rm(home, { recursive: true, force: true }) }
})
