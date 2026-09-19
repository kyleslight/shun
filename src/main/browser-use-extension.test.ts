import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test, { mock } from 'node:test'
import vm from 'node:vm'

/**
 * The bundled extension's service worker is plain Chrome code, so it is run here
 * in a context with the Chrome APIs and a WebSocket it can be driven against.
 *
 * These tests exist because the extension could not recover from a bridge that
 * quit underneath it: Chrome kept reporting the dead socket as open, connect()
 * trusted readyState, and a user had to disable and enable the extension by
 * hand. Everything below pins the recovery ladder that replaced that.
 */

const source = await readFile(new URL('../../resources/browser-use-extension/service-worker.js', import.meta.url), 'utf8')

type FakeSocket = {
  url: string
  readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  deliver(message: unknown): void
  deliverClose(): void
}

function startExtension() {
  const state = {
    // A loopback port with a listening bridge accepts a connection even when the
    // desktop bridge is wedged, which is exactly the case that used to be opaque.
    listening: true,
    // Whether Shun answers heartbeats on an accepted connection.
    answering: true,
    sockets: [] as FakeSocket[],
    sent: [] as string[],
    reloads: 0,
    removedTabs: [] as number[],
    tabUpdatedListeners: [] as ((tabId: number, change: any, tab: any) => void)[],
    messageListeners: [] as ((message: any, sender: unknown, respond: (value?: unknown) => void) => void)[],
    alarmListeners: [] as ((alarm: { name: string }) => void)[],
    startupListeners: [] as (() => void)[],
  }
  // Reloading the extension destroys the worker, so nothing it scheduled may run
  // afterwards. Modelling that keeps "one self-heal per worker" honest.
  const stopped = { value: false }

  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    url: string
    readyState = FakeWebSocket.CONNECTING
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    onclose: (() => void) | null = null

    constructor(url: string) {
      this.url = url
      state.sockets.push(this as unknown as FakeSocket)
      if (state.listening) setTimeout(() => { this.readyState = FakeWebSocket.OPEN; this.onopen?.() }, 0)
    }

    send(data: string) {
      state.sent.push(data)
      let message: any
      try { message = JSON.parse(data) } catch { return }
      if (message?.type === 'hello') {
        // A current Shun answers the handshake and then every heartbeat; an older
        // one stays silent on both, which is what the legacy test covers.
        if (state.answering) setTimeout(() => this.deliver({ type: 'hello.ack', heartbeat: true }), 0)
        return
      }
      if (message?.type !== 'heartbeat' || !state.answering) return
      setTimeout(() => this.deliver({ type: 'heartbeat.ack', at: Date.now() }), 0)
    }

    deliver(message: unknown) {
      if (this.readyState === FakeWebSocket.OPEN) this.onmessage?.({ data: JSON.stringify(message) })
    }

    // The desktop bridge disappearing without a close event is the failure this
    // extension has to survive; this only models the graceful case.
    deliverClose() {
      if (this.readyState === FakeWebSocket.CLOSED) return
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.()
    }

    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.()
    }
  }

  const chrome = {
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    alarms: { create: () => {}, get: () => {}, clear: () => {}, onAlarm: { addListener: (listener: any) => state.alarmListeners.push(listener) } },
    debugger: { attach: () => {}, detach: () => {}, sendCommand: () => {}, onEvent: { addListener: () => {} }, onDetach: { addListener: () => {} } },
    downloads: { download: () => {}, search: () => {}, onChanged: { addListener: () => {} } },
    tabs: {
      remove: (tabId: number) => { state.removedTabs.push(tabId) },
      onUpdated: { addListener: (listener: any) => state.tabUpdatedListeners.push(listener) },
      onRemoved: { addListener: () => {} },
    },
    windows: { update: () => {} },
    runtime: {
      getManifest: () => ({ version: '1.0.3' }),
      reload: () => { state.reloads += 1; stopped.value = true },
      onMessage: { addListener: (listener: any) => state.messageListeners.push(listener) },
      onStartup: { addListener: (listener: () => void) => state.startupListeners.push(listener) },
      onInstalled: { addListener: (listener: () => void) => state.startupListeners.push(listener) },
      lastError: undefined,
    },
  }

  const schedule = (fn: any) => (...args: any[]) => { if (!stopped.value) fn(...args) }
  const context = vm.createContext({
    chrome, WebSocket: FakeWebSocket, console,
    setTimeout: (fn: any, ms?: number) => globalThis.setTimeout(schedule(fn), ms),
    setInterval: (fn: any, ms?: number) => globalThis.setInterval(schedule(fn), ms),
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
    Date: globalThis.Date,
  })
  vm.runInContext(source, context)

  return {
    state,
    socketAt: (index: number) => state.sockets[index],
    lastSocket: () => state.sockets[state.sockets.length - 1],
    status: () => new Promise<{ connected?: boolean }>(resolve => {
      for (const listener of state.messageListeners) listener({ type: 'status' }, undefined, value => resolve(value as { connected?: boolean }))
    }),
    popupConnect: (force: boolean) => {
      for (const listener of state.messageListeners) listener({ type: 'connect', force }, undefined, () => {})
    },
  }
}

// A timer scheduled while the clock moves has to run at its own time, the way it
// would on a live machine, so time is advanced in small steps instead of one
// jump. Without this the harness would delay every handshake to the end of the
// window and hide exactly the timing this ladder depends on.
const settle = (ms: number) => { mock.timers.tick(ms); mock.timers.tick(0) }
const advance = (ms: number, step = 1_000) => {
  for (let elapsed = 0; elapsed < ms; elapsed += step) settle(Math.min(step, ms - elapsed))
}

test('a heartbeat is what makes a connection trusted, and silence drops it without a reload', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension()

  settle(0)
  assert.equal(extension.state.sockets.length, 1)
  assert.equal(extension.socketAt(0).readyState, 1)
  assert.equal((await extension.status()).connected, true)
  assert.match(extension.state.sent.join('\n'), /"type":"heartbeat"/)

  // Shun quits: the socket stays reported as open and never answers again, and no
  // close event ever arrives.
  extension.state.answering = false
  advance(10_000)
  assert.equal(extension.socketAt(0).readyState, 3, 'the stale socket is dropped instead of blocking every reconnect')
  assert.ok(extension.state.sockets.length >= 2, 'a replacement connection is attempted')
  assert.equal(extension.lastSocket().readyState, 1)
  assert.equal(extension.state.reloads, 0, 'dropping a stale socket is not a reason to reload the whole extension')

  // Shun is back and answering on the replacement connection.
  extension.state.answering = true
  settle(20_000)
  assert.equal((await extension.status()).connected, true)
})

test('Connect to Shun replaces a socket Chrome still reports as open', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension()

  settle(0)
  assert.equal(extension.state.sockets.length, 1)

  // The popup's button is the user's manual lever: it must never be a no-op
  // because an in-memory socket claims to be connected.
  extension.popupConnect(true)
  settle(0)
  assert.equal(extension.socketAt(0).readyState, 3)
  assert.equal(extension.state.sockets.length, 2)
  assert.equal(extension.lastSocket().readyState, 1)
  assert.equal((await extension.status()).connected, true)
})

test('a bridge that comes back after a restart is reconnected within a second', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension()

  settle(0)
  advance(3_000)
  assert.equal((await extension.status()).connected, true)

  // Shun quits: the close reaches Chrome, and the port stops accepting.
  extension.state.answering = false
  extension.state.listening = false
  extension.socketAt(0).deliverClose()
  advance(5_000)
  assert.equal((await extension.status()).connected, false)

  // Shun is back on the port it used before: the next retry is at most one
  // second away, because a restart is the moment the user is watching.
  extension.state.answering = true
  extension.state.listening = true
  advance(2_000)
  assert.equal((await extension.status()).connected, true)
})

test('the wake URL closes its tab and rebuilds the connection', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension()

  settle(0)
  advance(3_000)
  assert.equal((await extension.status()).connected, true)
  assert.equal(extension.state.removedTabs.length, 0, 'an ordinary tab is never touched')

  // Shun's bridge came up and poked the browser. A suspended worker cannot be
  // woken by a WebSocket message, so the tab event is the wake-up, and it must
  // clean up after itself.
  const socketsBefore = extension.state.sockets.length
  for (const listener of extension.state.tabUpdatedListeners) {
    listener(7, { url: 'http://127.0.0.1:32124/shun-wake' }, { url: 'http://127.0.0.1:32124/shun-wake' })
  }
  settle(0)
  assert.deepEqual(extension.state.removedTabs, [7])
  assert.ok(extension.state.sockets.length > socketsBefore, 'the wake-up forces a fresh connection')
  assert.equal((await extension.status()).connected, true)
})

test('the extension reloads itself once when Shun accepts connections but never answers', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension()

  settle(0)
  advance(5_000)
  assert.equal((await extension.status()).connected, true)

  // The bridge keeps accepting loopback connections but stopped answering, so
  // nothing inside this worker can repair the connection.
  extension.state.answering = false
  advance(120_000)
  assert.equal(extension.state.reloads, 1)
  assert.ok(extension.state.sockets.length > 1, 'it tried a fresh connection before giving up on the worker')
})

test('a Shun that never answers the handshake keeps the old readyState behaviour', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension()
  // An older desktop build accepts the connection and never answers anything.
  extension.state.answering = false

  settle(0)
  advance(300_000)
  assert.equal(extension.state.reloads, 0)
  assert.equal(extension.state.sockets.length, 1, 'a bridge that never answers is not torn down')
  assert.equal((await extension.status()).connected, true)
})

test('a closed Shun never makes the extension reload itself', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension()

  settle(0)
  advance(5_000)
  assert.equal((await extension.status()).connected, true)

  // Shun quits cleanly and then stays closed for ten minutes: the port refuses
  // connections, which is a state that only needs retries, never a reload.
  extension.state.answering = false
  extension.state.listening = false
  extension.socketAt(0).deliverClose()
  advance(600_000)
  assert.equal(extension.state.reloads, 0)
  assert.equal((await extension.status()).connected, false)
  assert.ok(extension.state.sockets.length > 1, 'the extension keeps retrying while Shun is away')
})
