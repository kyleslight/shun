import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import type { BrowserSession } from '../shared.ts'
import { browserNodeRef, browserUseUrl, ChromeBrowserService, formatChromeSnapshot, SHUN_CHROME_EXTENSION_ID } from './chrome-browser.ts'

test('Browser Use accepts bounded HTTP URLs and fresh numeric accessibility refs', () => {
  assert.equal(browserUseUrl('https://example.com/path?q=1'), 'https://example.com/path?q=1')
  assert.equal(browserUseUrl('http://localhost:5174/'), 'http://localhost:5174/')
  for (const value of ['chrome://settings', 'file:///tmp/a', 'https://user:pass@example.com', 'relative']) assert.throws(() => browserUseUrl(value), /HTTP\(S\)/i)
  assert.equal(browserNodeRef('421'), '421')
  for (const value of ['', '0', '-1', 'r4', '1.5']) assert.throws(() => browserNodeRef(value), /fresh numeric ref/i)
})

test('the bundled extension key has the allowlisted stable Chrome extension ID', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../resources/browser-use-extension/manifest.json', import.meta.url), 'utf8'))
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)
  const extensionId = [...digest].map(value => String.fromCharCode(97 + (value >> 4), 97 + (value & 15))).join('')
  assert.equal(extensionId, SHUN_CHROME_EXTENSION_ID)
})

test('Chrome snapshots are bounded, semantic, and never embed screenshot bytes in text', () => {
  const session: BrowserSession = {
    id: 'browser-1', taskId: 'task-a', createdByRunId: 'run-a', tabId: 42, owned: false, state: 'attached',
    url: 'https://example.com', title: 'Example', createdAt: 1, updatedAt: 1, consoleEntries: 0, pageErrors: 0,
  }
  const text = formatChromeSnapshot({
    tab: { id: 42, title: 'Example', url: 'https://example.com' }, readyState: 'complete', text: 'Visible page text', screenshot: 'very-secret-base64',
    nodes: [{ ref: '99', role: 'button', name: 'Continue', focused: true }], console: [{ level: 'warn', message: 'notice' }], pageErrors: [],
  }, session)
  assert.match(JSON.parse(text).accessibility, /\[99\] button "Continue" focused/)
  assert.match(text, /Visible page text/)
  assert.match(text, /"screenshot_included": true/)
  assert.doesNotMatch(text, /very-secret-base64/)
})

test('persisted Browser Use sessions resume without a failed first call after an app restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-chrome-restart-'))
  const storage = join(root, 'sessions.json')
  let service: ChromeBrowserService | undefined
  let client: WebSocket | undefined
  try {
    await writeFile(storage, JSON.stringify([{
      id: 'stale', taskId: 'task-a', createdByRunId: 'run-a', tabId: 42, owned: false, state: 'attached',
      url: 'https://example.com/', title: 'Example', createdAt: 1, updatedAt: 1, consoleEntries: 0, pageErrors: 0,
    }]))
    service = new ChromeBrowserService(storage)
    assert.equal((await service.listAll())[0].state, 'suspended')
    const port = await service.start()
    client = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `chrome-extension://${SHUN_CHROME_EXTENSION_ID}` })
    client.on('message', raw => {
      const request = JSON.parse(raw.toString())
      const tab = { id: 42, title: 'Example', url: 'https://example.com/' }
      const result = request.method === 'tab.snapshot'
        ? { tab, readyState: 'complete', text: 'Recovered page', nodes: [], console: [], pageErrors: [] }
        : true
      client!.send(JSON.stringify({ id: request.id, result }))
    })
    await once(client!, 'open')
    client!.send(JSON.stringify({ type: 'hello', version: '1.0.0' }))
    assert.match((await service.snapshot('task-a', 'stale')).text, /Recovered page/)
  } finally {
    client?.close()
    await service?.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('Chrome bridge owns claimed tabs per task, persists latest evidence, and releases without closing by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-chrome-browser-'))
  const service = new ChromeBrowserService(join(root, 'sessions.json'))
  let client: WebSocket | undefined
  const methods: string[] = []
  try {
    const port = await service.start()
    client = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `chrome-extension://${SHUN_CHROME_EXTENSION_ID}` })
    client.on('message', raw => {
      const request = JSON.parse(raw.toString())
      if (!request.id) return
      methods.push(request.method)
      const tab = { id: Number(request.params?.tabId || 42), title: 'Example', url: request.params?.url || 'https://example.com/', active: true, windowId: 7 }
      const result = request.method === 'tabs.list' ? [tab]
        : request.method === 'tab.snapshot' ? { tab, readyState: 'complete', text: 'Current page', nodes: [{ ref: '91', role: 'link', name: 'Docs' }], console: [], pageErrors: [], ...(request.params.screenshot ? { screenshot: Buffer.from('png').toString('base64') } : {}) }
        : request.method === 'tab.release' || request.method === 'tab.act' ? true
        : tab
      client!.send(JSON.stringify({ id: request.id, result }))
    })
    await once(client, 'open')
    client.send(JSON.stringify({ type: 'hello', version: '1.0.0' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(service.state().connected, true)
    assert.equal((await service.tabs())[0].id, 42)

    const session = await service.claim('task-a', 'run-a', 42)
    assert.equal(session.owned, false)
    assert.equal(session.state, 'suspended')
    assert.deepEqual(methods.slice(-2), ['tab.attach', 'tab.release'])
    await assert.rejects(() => service.claim('task-b', 'run-b', 42), /another Shun task/)
    const beforeSnapshot = methods.length
    const snapshot = await service.snapshot('task-a', session.id, true)
    assert.match(snapshot.text, /Current page/)
    assert.equal(snapshot.session.state, 'suspended')
    assert.deepEqual(methods.slice(beforeSnapshot), ['tab.snapshot', 'tab.release'])
    assert.equal((await service.list('task-a')).length, 1)
    await stat(join(root, 'browser-snapshots', `${session.id}.json`))
    await stat(join(root, 'browser-snapshots', `${session.id}.png`))
    assert.doesNotMatch(await readFile(join(root, 'browser-snapshots', `${session.id}.json`), 'utf8'), /cG5n/)

    const released = await service.release('task-a', session.id)
    assert.equal(released.state, 'released')
    assert.equal((await service.list('task-a')).length, 0)
    const runSession = await service.claim('task-a', 'run-b', 43)
    await service.releaseRun('task-a', 'run-b')
    assert.equal((await service.list('task-a')).find(item => item.id === runSession.id)?.state, 'suspended')
    const resumed = await service.snapshot('task-a', runSession.id)
    assert.equal(resumed.session.state, 'suspended')
    assert.match(resumed.text, /Current page/)
    await service.releaseRun('task-a', 'run-c')
    assert.equal((await service.list('task-a')).find(item => item.id === runSession.id)?.state, 'suspended')
    const offline = await service.claim('task-a', 'run-c', 44)
    client.close()
    await once(client, 'close')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(service.state().connected, false)
    assert.equal((await service.release('task-a', offline.id)).state, 'released')
  } finally {
    client?.close()
    await service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('a transient extension handoff is recovered inside the browser call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-chrome-reconnect-'))
  const service = new ChromeBrowserService(join(root, 'sessions.json'))
  let client: WebSocket | undefined
  let replacement: WebSocket | undefined
  try {
    const port = await service.start()
    client = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `chrome-extension://${SHUN_CHROME_EXTENSION_ID}` })
    await once(client, 'open')
    client.close()
    await once(client, 'close')

    const tabs = service.tabs()
    await new Promise(resolve => setTimeout(resolve, 150))
    replacement = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `chrome-extension://${SHUN_CHROME_EXTENSION_ID}` })
    replacement.on('message', raw => {
      const request = JSON.parse(raw.toString())
      if (request.method === 'tabs.list') replacement!.send(JSON.stringify({
        id: request.id,
        result: [{ id: 42, title: 'Recovered', url: 'https://example.com/' }],
      }))
    })
    await once(replacement, 'open')
    assert.equal((await tabs)[0].title, 'Recovered')
  } finally {
    client?.close()
    replacement?.close()
    await service.stop()
    await rm(root, { recursive: true, force: true })
  }
})
