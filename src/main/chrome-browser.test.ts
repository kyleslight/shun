import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import type { BrowserSession } from '../shared.ts'
import { browserNodeRef, browserUseUrl, BrowserControlBlockedError, CHROME_WEB_STORE_MESSAGE, ChromeBrowserService, formatChromeSnapshot, sameBrowserUrl, SHUN_CHROME_EXTENSION_ID, SHUN_CHROME_EXTENSION_ORIGINS, SHUN_CHROME_EXTENSION_STORE_LIVE, SHUN_CHROME_EXTENSION_STORE_URL, SHUN_CHROME_STORE_EXTENSION_ID } from './chrome-browser.ts'

test('Browser Use accepts bounded HTTP URLs and fresh numeric accessibility refs', () => {
  assert.equal(browserUseUrl('https://example.com/path?q=1'), 'https://example.com/path?q=1')
  assert.equal(browserUseUrl('http://localhost:5174/'), 'http://localhost:5174/')
  assert.equal(sameBrowserUrl('https://example.com/path', 'https://example.com/path'), true)
  assert.equal(sameBrowserUrl('https://example.com/path', 'https://example.com/path#details'), false)
  for (const value of ['chrome://settings', 'file:///tmp/a', 'https://user:pass@example.com', 'relative']) assert.throws(() => browserUseUrl(value), /HTTP\(S\)/i)
  assert.equal(browserNodeRef('421'), '421')
  for (const value of ['', '0', '-1', 'r4', '1.5']) assert.throws(() => browserNodeRef(value), /fresh numeric ref/i)
})

test('the Chrome Web Store is refused in Shun\'s words before any tab or session exists', () => {
  // Chrome answers chrome.debugger.attach with “The extensions gallery cannot be
  // scripted.”, which reads as a transient failure and invites a retry that can
  // never succeed. The boundary is stated where the URL is validated instead.
  for (const url of [
    'https://chromewebstore.google.com/detail/nlgfkakiggbllngkkfbjicnelmnnacbnb',
    'https://chrome.google.com/webstore/devconsole',
    'https://chrome.google.com/webstore',
  ]) assert.throws(() => browserUseUrl(url), new RegExp(CHROME_WEB_STORE_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  // A lookalike host, and the extension's own allowlisted origin, are untouched.
  assert.equal(browserUseUrl('https://chrome.google.com/webstore-friends'), 'https://chrome.google.com/webstore-friends')
  assert.equal(browserUseUrl('https://chromewebstore.google.com.cn/detail/x'), 'https://chromewebstore.google.com.cn/detail/x')
})

test('the bundled extension key has the allowlisted stable Chrome extension ID', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../resources/browser-use-extension/manifest.json', import.meta.url), 'utf8'))
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)
  const extensionId = [...digest].map(value => String.fromCharCode(97 + (value >> 4), 97 + (value & 15))).join('')
  assert.equal(extensionId, SHUN_CHROME_EXTENSION_ID)
  assert.equal(SHUN_CHROME_EXTENSION_ORIGINS.has(`chrome-extension://${extensionId}`), true)
})

test('the store listing URL carries the allowlisted store extension ID', () => {
  assert.equal(SHUN_CHROME_EXTENSION_STORE_URL, `https://chromewebstore.google.com/detail/${SHUN_CHROME_STORE_EXTENSION_ID}`)
  assert.equal(SHUN_CHROME_EXTENSION_ORIGINS.has(`chrome-extension://${SHUN_CHROME_STORE_EXTENSION_ID}`), true)
  // Chrome extension IDs are exactly 32 characters from a to p. A placeholder
  // that is one character off would look fine here and silently reject the real
  // extension, so the shape itself is checked.
  assert.match(SHUN_CHROME_STORE_EXTENSION_ID, /^[a-p]{32}$/)
  assert.match(SHUN_CHROME_EXTENSION_ID, /^[a-p]{32}$/)
  assert.equal(SHUN_CHROME_EXTENSION_STORE_LIVE, true)
})

test('the bridge accepts the store build and the unpacked copy, and nothing else', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-chrome-origins-'))
  const service = new ChromeBrowserService(join(root, 'sessions.json'))
  const connect = async (origin: string) => {
    const port = await service.start()
    // Plain listeners, not once(): a rejected handshake must not leave an
    // unhandled rejection behind while the racing promise settles.
    return await new Promise<'open' | 'rejected'>(resolve => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin })
      socket.on('open', () => { socket.close(); resolve('open') })
      socket.on('error', () => resolve('rejected'))
    })
  }
  try {
    assert.equal(await connect(`chrome-extension://${SHUN_CHROME_EXTENSION_ID}`), 'open')
    assert.equal(await connect(`chrome-extension://${SHUN_CHROME_STORE_EXTENSION_ID}`), 'open')
    // Any other extension, and any page origin, stays out.
    assert.equal(await connect('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'rejected')
    assert.equal(await connect('https://shunagent.com'), 'rejected')
  } finally {
    await rm(root, { recursive: true, force: true })
    await service.stop()
  }
})

test('a popup permission probe does not replace the active extension connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-chrome-probe-'))
  const service = new ChromeBrowserService(join(root, 'sessions.json'))
  let client: WebSocket | undefined
  let probe: WebSocket | undefined
  try {
    const port = await service.start()
    const options = { origin: `chrome-extension://${SHUN_CHROME_EXTENSION_ID}` }
    client = new WebSocket(`ws://127.0.0.1:${port}`, options)
    await once(client, 'open')
    client.send(JSON.stringify({ type: 'hello', version: '1.0.2' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(service.state().connected, true)

    probe = new WebSocket(`ws://127.0.0.1:${port}/permission-probe`, options)
    const closed = once(probe, 'close')
    await once(probe, 'open')
    await closed
    assert.equal(service.state().connected, true)
    assert.match(service.state().account || '', /1\.0\.2/)
  } finally {
    probe?.close()
    client?.close()
    await service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('the bridge exposes a wake address for a suspended extension worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-chrome-wake-'))
  const service = new ChromeBrowserService(join(root, 'sessions.json'))
  try {
    assert.equal(service.wakeUrl(), undefined, 'no bridge, no wake address')
    const port = await service.start()
    assert.equal(service.wakeUrl(), `http://127.0.0.1:${port}/shun-wake`)
  } finally {
    await service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('every heartbeat is answered on the socket it arrived on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-chrome-heartbeat-'))
  const service = new ChromeBrowserService(join(root, 'sessions.json'))
  let client: WebSocket | undefined
  try {
    const port = await service.start()
    client = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `chrome-extension://${SHUN_CHROME_EXTENSION_ID}` })
    await once(client, 'open')
    // The handshake tells the extension that this Shun answers heartbeats at all.
    const handshake = once(client, 'message')
    client.send(JSON.stringify({ type: 'hello', version: '1.0.3' }))
    const hello = JSON.parse((await handshake)[0].toString())
    assert.equal(hello.type, 'hello.ack')
    assert.equal(hello.heartbeat, true)
    // A bridge that quits can leave Chrome reporting the closed socket as open,
    // so the extension only trusts a link Shun has answered recently. Every
    // heartbeat is answered on the socket it arrived on, and the answer carries
    // no id so it can never be mistaken for a call result.
    const ack = once(client, 'message')
    client.send(JSON.stringify({ type: 'heartbeat', at: Date.now() }))
    const parsed = JSON.parse((await ack)[0].toString())
    assert.equal(parsed.type, 'heartbeat.ack')
    assert.equal(typeof parsed.at, 'number')
    assert.equal('id' in parsed, false)
  } finally {
    client?.close()
    await service.stop()
    await rm(root, { recursive: true, force: true })
  }
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

test('a click that would not reach its control is refused in Shun’s own words', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-chrome-blocked-'))
  const service = new ChromeBrowserService(join(root, 'sessions.json'))
  let client: WebSocket | undefined
  try {
    const port = await service.start()
    client = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `chrome-extension://${SHUN_CHROME_EXTENSION_ID}` })
    client.on('message', raw => {
      const request = JSON.parse(raw.toString())
      if (!request.id) return
      if (request.method === 'tab.act') {
        const covering = request.params?.ref === '91' ? 'div "Save changes"' : undefined
        client!.send(JSON.stringify({
          id: request.id,
          error: covering ? `The control is behind ${covering}.` : 'The control is not at the position its box reports.',
          code: 'control_not_reachable',
          ...(covering ? { detail: { covering } } : {}),
        }))
        return
      }
      const tab = { id: 42, title: 'Example', url: 'https://example.com/', active: true, windowId: 7 }
      const result = request.method === 'tabs.list' ? [tab]
        : request.method === 'tab.snapshot' ? { tab, readyState: 'complete', text: 'Current page', nodes: [{ ref: '91', role: 'button', name: 'Save' }], console: [], pageErrors: [] }
        : true
      client!.send(JSON.stringify({ id: request.id, result }))
    })
    await once(client, 'open')
    client.send(JSON.stringify({ type: 'hello', version: '1.0.0' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    const session = await service.claim('task-a', 'run-a', 42)

    // A control behind something is named, and the refusal says what it did not do.
    await assert.rejects(() => service.act('task-a', session.id, { action: 'click', ref: '91' }), (error: Error) => {
      assert.ok(error instanceof BrowserControlBlockedError)
      assert.match(error.message, /behind div "Save changes"/)
      assert.match(error.message, /did not click it/)
      assert.match(error.message, /fresh snapshot/)
      assert.doesNotMatch(error.message, /chrome|debugger|cdp|protocol/i)
      return true
    })

    // A control whose box does not match its position is refused without inventing a culprit.
    await assert.rejects(() => service.act('task-a', session.id, { action: 'click', ref: '92' }), (error: Error) => {
      assert.ok(error instanceof BrowserControlBlockedError)
      assert.match(error.message, /not where its position/)
      return true
    })
  } finally {
    client?.close()
    await service.stop().catch(() => {})
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
    const opened = await service.open('task-a', 'run-open', 'https://example.com/path', false)
    const beforeSameNavigation = methods.length
    await service.navigate('task-a', opened.id, 'https://example.com/path')
    assert.deepEqual(methods.slice(beforeSameNavigation), ['tab.snapshot', 'tab.release'])
    await service.release('task-a', opened.id)
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
