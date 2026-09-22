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
const fastPathSource = await readFile(new URL('../../resources/browser-use-extension/fast-path.js', import.meta.url), 'utf8')

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

function startExtension(options: { onCommand?: (method: string, params: any) => unknown } = {}) {
  const state = {
    // A loopback port with a listening bridge accepts a connection even when the
    // desktop bridge is wedged, which is exactly the case that used to be opaque.
    listening: true,
    // Whether Shun answers heartbeats on an accepted connection.
    answering: true,
    sockets: [] as FakeSocket[],
    sent: [] as string[],
    reloads: 0,
    /** Every tab the debugger was detached from, so "the bar does not flicker" is checked. */
    detached: [] as number[],
    removedTabs: [] as number[],
    /** What a tab query answers with, so a sweep over real tabs can be checked. */
    queriedTabs: [] as Array<{ id: number; url: string }>,
    /** Every icon the extension set, so "the icon is an animation" is checked and not assumed. */
    iconCalls: [] as Array<Record<string, any>>,
    badgeCalls: [] as Array<Record<string, any>>,
    tabUpdatedListeners: [] as ((tabId: number, change: any, tab: any) => void)[],
    commands: [] as Array<{ method: string; params: any }>,
    messageListeners: [] as ((message: any, sender: unknown, respond: (value?: unknown) => void) => void)[],
    alarmListeners: [] as ((alarm: { name: string }) => void)[],
    startupListeners: [] as (() => void)[],
  }
  /** Chrome passes its callback last, and some commands do not take one at all. */
  const callbackOf = (args: any[]) => typeof args[args.length - 1] === 'function' ? args.pop() as (value?: unknown) => void : undefined
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
    action: {
      setBadgeText: (details: Record<string, any>) => { state.badgeCalls.push(details) },
      setBadgeBackgroundColor: () => {},
      setIcon: (details: Record<string, any>) => { state.iconCalls.push(details) },
    },
    alarms: { create: () => {}, get: () => {}, clear: () => {}, onAlarm: { addListener: (listener: any) => state.alarmListeners.push(listener) } },
    debugger: {
      // Chrome's command surface takes the callback last, and sometimes not at all, so the
      // fake reads the arity the way Chrome does.
      attach: (...args: any[]) => { callbackOf(args)?.({}) },
      detach: (target: { tabId?: number }, ...rest: any[]) => { state.detached.push(Number(target?.tabId)); callbackOf(rest)?.({}) },
      // Each expression the extension sends is answered by the test, so the fast path can be
      // driven end to end.
      sendCommand: (...args: any[]) => {
        const callback = callbackOf(args)
        const [target, method, params] = args as [any, string, any]
        state.commands.push({ method, params })
        callback?.(options.onCommand ? options.onCommand(method, params) : {})
      },
      onEvent: { addListener: () => {} }, onDetach: { addListener: () => {} },
    },
    downloads: { download: () => {}, search: () => {}, onChanged: { addListener: () => {} } },
    tabs: {
      remove: (tabId: number) => { state.removedTabs.push(tabId) },
      get: (tabId: number, callback: (tab: unknown) => void) => callback({ id: tabId, title: 'Settings', url: 'https://example.test/', windowId: 1 }),
      update: (tabId: number, _props: unknown, callback: (tab: unknown) => void) => callback({ id: tabId, title: 'Settings', url: 'https://example.test/', windowId: 1 }),
      query: (_props: unknown, callback: (tabs: unknown[]) => void) => callback(state.queriedTabs),
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
    // The worker loads its page-side half this way, so the test loads the same file.
    importScripts: (file: string) => { if (file === 'fast-path.js') vm.runInContext(fastPathSource, context) },
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
    /** One request from Shun, answered over the same socket the extension already holds. */
    request: async (id: string, method: string, params: Record<string, unknown>) => {
      state.sockets[state.sockets.length - 1].deliver({ id, method, params })
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve))
        const answer = state.sent.map(text => JSON.parse(text)).find(message => message.id === id)
        if (answer) return answer
        // The action itself waits for the page to settle, which is a timer: the clock this
        // test controls has to move for the extension to finish what it started.
        try { mock.timers.tick(20) } catch {}
      }
      throw Error(`The extension never answered ${method}.`)
    },
  }
}

// A timer scheduled while the clock moves has to run at its own time, the way it// would on a live machine, so time is advanced in small steps instead of one
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

/**
 * The fast path is one observation call and one guarded action call, and the guard is what
 * stands between a decision and a click. These pin the wiring: an observation is answered
 * as one evaluate, and a control the page has moved on from produces no input at all.
 */
const fastObservation = {
  url: 'https://example.test/settings', title: 'Settings', readyState: 'complete',
  viewport: { width: 1_200, height: 800 }, scroll: { x: 0, y: 0, max: 400 }, text: 'Settings',
  marker: '1700000000000', fingerprint: 'page-fingerprint', frames: { total: 0, crossOrigin: 0 },
  elements: [{ id: 4, role: 'button', name: 'Continue', value: '', tag: 'button', rect: { x: 10, y: 20, width: 100, height: 30 }, fingerprint: 'control-fingerprint' }],
}

test('the fast path observes a page in one call and answers with what it found', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({
    onCommand: (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      // The observation and the guard are different expressions, and the page answers each
      // one in its own words.
      return { result: { value: String(params?.expression || '').includes('shunFastCollect') ? fastObservation : { ok: false, reason: 'covered', covering: 'div Cookie banner' } } }
    },
  })
  settle(0)

  const observed = await extension.request('fast-1', 'tab.fastSnapshot', { tabId: 5 })
  assert.equal(observed.result.title, 'Settings')
  assert.equal(observed.result.tab.id, 5)
  assert.deepEqual(observed.result.elements, fastObservation.elements)
  assert.equal(extension.state.commands.filter(command => command.method === 'Runtime.evaluate').length, 1, 'the whole observation is one evaluate')

  const acted = await extension.request('fast-2', 'tab.fastAct', {
    tabId: 5, action: 'click', pointer: 'hide',
    expected: { id: 4, role: 'button', name: 'Continue', fingerprint: 'control-fingerprint' },
  })
  assert.equal(acted.result.acted, false, 'a stale control is never acted on')
  assert.equal(acted.result.stale, true)
  assert.equal(acted.result.reason, 'covered')
  assert.equal(acted.result.covering, 'div Cookie banner')
  assert.equal(extension.state.commands.filter(command => command.method === 'Input.dispatchMouseEvent').length, 0, 'no click was dispatched at the coordinates that used to be right')
})

test('a fast action clicks the control the guard verified, exactly once', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({
    onCommand: (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.expression || '')
      if (expression.includes('shunFastCollect')) return { result: { value: fastObservation } }
      if (expression.includes('shunFastGuard')) return { result: { value: { ok: true, x: 60, y: 35, box: { x: 10, y: 20, width: 100, height: 30 } } } }
      // The page's own change counter: one mutation, then quiet.
      return { result: { value: { mutations: 1, readyState: 'complete' } } }
    },
  })
  settle(0)
  const click = await extension.request('fast-3', 'tab.fastAct', {
    tabId: 5, action: 'click',
    expected: { id: 4, role: 'button', name: 'Continue', fingerprint: 'control-fingerprint' },
  })
  assert.equal(click.result.acted, true)
  assert.equal(click.result.fingerprint, 'page-fingerprint', 'the answer carries the observation that follows the action')
  const presses = extension.state.commands.filter(command => command.method === 'Input.dispatchMouseEvent' && command.params.type === 'mousePressed')
  assert.equal(presses.length, 1)
  assert.equal(presses[0].params.x, 60)
  assert.equal(presses[0].params.y, 35)
})

/**
 * A mark says Shun is driving this tab now. The toolbar icon is what makes that read as motion
 * rather than as a claim, and the idle window is what keeps it from being a claim that outlives
 * the work — a tab nobody is driving any more gets its own icon back, and a finished task leaves
 * nothing spinning behind it.
 */
test('a driven tab animates the toolbar icon and gets the real one back once nothing drives it', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({
    onCommand: (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.expression || '')
      if (expression.includes('shunFastGuard')) return { result: { value: { ok: true, x: 60, y: 35, box: { x: 10, y: 20, width: 100, height: 30 } } } }
      return { result: { value: { mutations: 1, readyState: 'complete' } } }
    },
  })
  settle(0)
  const drain = async () => { for (let round = 0; round < 8; round += 1) await new Promise(resolve => setImmediate(resolve)) }
  // The frames are files, because a worker has no canvas to draw them with: the mark is whatever
  // `path` was set to, and the extension's own icon is the one passed as a size dictionary.
  const frames = () => extension.state.iconCalls.filter(call => call.tabId === 5 && typeof call.path === 'string' && call.path.includes('mark-'))
  const restored = () => extension.state.iconCalls.filter(call => call.tabId === 5 && call.path && typeof call.path === 'object')

  const acted = await extension.request('mark-1', 'tab.fastAct', {
    tabId: 5, action: 'click',
    expected: { id: 4, role: 'button', name: 'Continue', fingerprint: 'control-fingerprint' },
  })
  assert.equal(acted.result.acted, true)
  await drain()
  assert.equal(frames().length, 1, 'the icon is the loading animation from the first moment the tab is driven')
  assert.equal(extension.state.badgeCalls.filter(call => call.tabId === 5 && call.text !== '').length, 0, 'a static badge is not what says the tab is busy')

  // The ring turns on its own: the frames are not the same picture set again.
  mock.timers.tick(1_000)
  await drain()
  assert.ok(frames().length > 1, 'the ring turns while the tab is driven')
  assert.ok(new Set(frames().map(call => call.path)).size > 1, 'and it is a different frame each time, not the same one repeated')

  // Nothing has asked this tab for anything for the idle window, so nothing is driving it.
  mock.timers.tick(60_000)
  await drain()
  assert.ok(
    extension.state.commands.some(command => command.method === 'Runtime.evaluate' && String(command.params.expression).includes('delete globalThis.__shunTabMarker')),
    'the page gets its own tab icon back',
  )
  assert.equal(restored().length, 1, 'the toolbar gets the extension’s own icon back')

  // And the animation stops with the marks, so a finished task leaves nothing running.
  const settled = frames().length
  mock.timers.tick(5_000)
  await drain()
  assert.equal(frames().length, settled, 'nothing keeps animating after the marks go')
})

/**
 * The mark has to come off even when nothing is left to take it off: a worker Chrome has
 * suspended, a Shun that quit, a document a back-navigation restored with the mark it was
 * carrying. Every one of those is a page with a mark and no driver, so the page holds the
 * deadline itself, and it is refreshed by every action.
 */
test('the mark carries its own deadline in the page', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({
    onCommand: (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.expression || '')
      if (expression.includes('shunFastGuard')) return { result: { value: { ok: true, x: 60, y: 35, box: { x: 10, y: 20, width: 100, height: 30 } } } }
      return { result: { value: { mutations: 1, readyState: 'complete' } } }
    },
  })
  settle(0)
  await extension.request('life-1', 'tab.fastAct', {
    tabId: 5, action: 'click',
    expected: { id: 4, role: 'button', name: 'Continue', fingerprint: 'control-fingerprint' },
  })

  const drawn = extension.state.commands
    .filter(command => command.method === 'Runtime.evaluate' && String(command.params.expression).includes('[shun] pointer'))
    .map(command => String(command.params.expression))
  assert.ok(drawn.length >= 1, 'the pointer was drawn')
  assert.match(drawn[drawn.length - 1], /state\.lifetime = setTimeout/, 'and it carries a deadline of its own')
  assert.match(drawn[drawn.length - 1], /delete globalThis\.__shunTabMarker/, 'the same deadline gives the page its own tab icon back')
})

/**
 * A worker Chrome suspended has no timers, so a mark it was holding is a mark nothing will ever
 * take off. An alarm is the one delivery that reaches a sleeping worker, and a worker that wakes
 * up has no memory of which tabs it marked — so the sweep asks the browser which tabs exist and
 * gives back the icon of every one it is not driving right now.
 */
test('an alarm sweeps the icon a sleeping worker left behind', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension()
  settle(0)
  const drain = async () => { for (let round = 0; round < 8; round += 1) await new Promise(resolve => setImmediate(resolve)) }

  extension.state.queriedTabs = [{ id: 5, url: 'https://example.test/' }]
  for (const listener of extension.state.alarmListeners) listener({ name: 'shun-browser-use-mark-sweep' })
  await drain()

  assert.ok(
    extension.state.iconCalls.some(call => call.tabId === 5 && call.path),
    'the extension’s own icon is put back on the tab the sweep was told about',
  )
})

/**
 * The bar Chrome shows while a tab is being debugged belongs to the interface the person is looking
 * at, and it takes height away from every page under it. So it must not flicker: a suspend between
 * two steps of the same work leaves the debugger exactly where it is, and only a release that is a
 * real release lets the tab go.
 */
test('suspending between steps keeps the debugger attached, and a real release lets it go', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({
    onCommand: (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.expression || '')
      if (expression.includes('shunFastGuard')) return { result: { value: { ok: true, x: 60, y: 35, box: { x: 10, y: 20, width: 100, height: 30 } } } }
      return { result: { value: { mutations: 1, readyState: 'complete' } } }
    },
  })
  settle(0)
  await extension.request('bar-1', 'tab.fastAct', {
    tabId: 5, action: 'click',
    expected: { id: 4, role: 'button', name: 'Continue', fingerprint: 'control-fingerprint' },
  })

  await extension.request('bar-2', 'tab.release', { tabId: 5, closeTab: false, keepMarks: true })
  assert.deepEqual(extension.state.detached, [], 'a suspend between steps leaves the debugger where it is')

  await extension.request('bar-3', 'tab.release', { tabId: 5, closeTab: false })
  assert.deepEqual(extension.state.detached, [5], 'and a release lets the tab go — which is only possible because it was still attached')
})
