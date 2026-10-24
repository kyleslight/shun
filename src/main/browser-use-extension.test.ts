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
const pageTransportSource = await readFile(new URL('../../resources/browser-use-extension/page-transport.js', import.meta.url), 'utf8')
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

function startExtension(options: { onCommand?: (method: string, params: any) => unknown; pendingCommands?: string[]; attachError?: string; pageObservation?: () => Record<string, any>; onPageScript?: (request: Record<string, any>) => Promise<any> | undefined; tab?: Record<string, any> } = {}) {
  const state = {
    // A loopback port with a listening bridge accepts a connection even when the
    // desktop bridge is wedged, which is exactly the case that used to be opaque.
    listening: true,
    openDelay: 0,
    hanging: false,
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
    debuggerEventListeners: [] as ((source: { tabId: number }, method: string, params: any) => void)[],
    tabUpdatedListeners: [] as ((tabId: number, change: any, tab: any) => void)[],
    commands: [] as Array<{ method: string; params: any }>,
    selectedTabs: [] as number[],
    focusedWindows: [] as number[],
    navigatedTabs: [] as Array<{ tabId: number; url: string }>,
    reloadedTabs: [] as number[],
    attaches: 0,
    pageCalls: [] as Array<Record<string, any>>,
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
      if (state.listening) setTimeout(() => { if (this.readyState !== 0) return; this.readyState = FakeWebSocket.OPEN; this.onopen?.() }, state.openDelay)
      else if (!state.hanging) setTimeout(() => this.onerror?.(), 0)
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
      attach: (...args: any[]) => { state.attaches += 1; if (options.attachError) throw Error(options.attachError); callbackOf(args)?.({}) },
      detach: (target: { tabId?: number }, ...rest: any[]) => { state.detached.push(Number(target?.tabId)); callbackOf(rest)?.({}) },
      // Each expression the extension sends is answered by the test, so the fast path can be
      // driven end to end.
      sendCommand: (...args: any[]) => {
        const callback = callbackOf(args)
        const [target, method, params] = args as [any, string, any]
        state.commands.push({ method, params })
        if (options.pendingCommands?.includes(method)) return
        callback?.(options.onCommand ? options.onCommand(method, params) : {})
      },
      onEvent: { addListener: (listener: (source: { tabId: number }, method: string, params: any) => void) => state.debuggerEventListeners.push(listener) }, onDetach: { addListener: () => {} },
    },
    downloads: { download: () => {}, search: () => {}, onChanged: { addListener: () => {} } },
    scripting: { executeScript: async (request: Record<string, any>) => {
      state.pageCalls.push(request)
      const pending = options.onPageScript?.(request)
      if (pending) return pending
      const method = request.args?.[0]
      return [{ frameId: 0, result: method === 'pageAct' ? { ok: true, synthetic: true }
        : method === 'pageVerify' ? { matches: true, invalid: false, selectionRequired: false }
        : method === 'pageObserve' && options.pageObservation ? options.pageObservation()
        : { ...fastObservation, url: 'https://example.test/', elements: fastObservation.elements } }]
    } },
    tabs: {
      remove: (tabId: number) => { state.removedTabs.push(tabId) },
      get: (tabId: number, callback: (tab: unknown) => void) => callback({ id: tabId, title: 'Settings', url: 'https://example.test/', windowId: 1, ...options.tab }),
      update: (tabId: number, props: any, callback: (tab: unknown) => void) => {
        if (props.active) state.selectedTabs.push(tabId)
        if (props.url) { state.navigatedTabs.push({ tabId, url: props.url }); for (const listener of state.tabUpdatedListeners) listener(tabId, { status: 'complete' }, {}) }
        callback({ id: tabId, title: 'Settings', url: props.url || 'https://example.test/', windowId: 1 })
      },
      reload: (tabId: number, callback: () => void) => { state.reloadedTabs.push(tabId); for (const listener of state.tabUpdatedListeners) listener(tabId, { status: 'complete' }, {}); callback() },
      query: (_props: unknown, callback: (tabs: unknown[]) => void) => callback(state.queriedTabs),
      onUpdated: { addListener: (listener: any) => state.tabUpdatedListeners.push(listener), removeListener: (listener: any) => { const i=state.tabUpdatedListeners.indexOf(listener); if(i>=0)state.tabUpdatedListeners.splice(i,1) } },
      onRemoved: { addListener: () => {} },
    },
    windows: { update: (id: number) => { state.focusedWindows.push(id) } },
    runtime: {
      getManifest: () => ({ version: '1.0.3' }),
      getPlatformInfo: (callback: (info: { os: string }) => void) => callback({ os: 'mac' }),
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
    importScripts: (...files: string[]) => { for (const file of files) { if (file === 'fast-path.js') vm.runInContext(fastPathSource, context); if (file === 'page-transport.js') vm.runInContext(pageTransportSource, context) } },
    setTimeout: (fn: any, ms?: number) => globalThis.setTimeout(schedule(fn), ms),
    setInterval: (fn: any, ms?: number) => globalThis.setInterval(schedule(fn), ms),
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
    Date: globalThis.Date,
    URL: globalThis.URL,
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
      for (let attempt = 0; attempt < 500; attempt += 1) {
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

test('automatic recovery allows a delayed loopback handshake without user intervention', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension()
  settle(0)
  extension.state.openDelay = 6_200
  extension.socketAt(0).deliverClose()
  advance(8_000, 100)
  assert.equal((await extension.status()).connected, true)
})

test('an explicit reconnect cancels an in-flight scan and ignores its late callbacks', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension()
  settle(0)
  extension.state.listening = false
  extension.state.hanging = true
  extension.socketAt(0).deliverClose()
  advance(300, 100)
  const stale = extension.lastSocket()
  const lateOpen = stale.onopen
  extension.state.listening = true
  extension.popupConnect(true)
  settle(0)
  assert.equal((await extension.status()).connected, true)
  const current = extension.lastSocket()
  assert.notEqual(current, stale)
  assert.equal(stale.readyState, 3)
  lateOpen?.()
  advance(6_000, 100)
  assert.equal(extension.lastSocket(), current)
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

for (const blocking of [false, true]) test(`normal click ${blocking ? 'refuses a real pointer blocker' : 'passes through a pointer-transparent decorative layer'}`, async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ onCommand: (method, params) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: params.backendNodeId === 42 ? 'target' : 'overlay' } }
    if (method === 'DOM.getBoxModel') return { model: { content: [10, 20, 110, 20, 110, 50, 10, 50] } }
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: blocking || params.ignorePointerEventsNone ? 43 : 42 }
    if (method === 'Runtime.callFunctionOn') {
      if (params.functionDeclaration.includes('fileInputFor')) return { result: {} }
      if (params.functionDeclaration.includes('const el = this')) return { result: { value: 'div dialog' } }
      return { result: { value: false } }
    }
    if (method === 'Runtime.evaluate') return { result: { value: params.expression === 'document.visibilityState' ? 'visible' : { readyState: 'complete', mutations: 0 } } }
    return {}
  } })
  settle(0)
  const answer = await extension.request('pointer-layer', 'tab.act', { tabId: 5, action: 'click', ref: '42', pointer: 'hide' })
  const presses = extension.state.commands.filter(c => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed')
  if (blocking) {
    assert.equal(answer.code, 'control_not_reachable')
    assert.equal(presses.length, 0)
  } else {
    assert.equal(answer.error, undefined)
    assert.equal(presses.length, 1)
    assert.equal(presses[0].params.x, 60)
  }
  assert.equal(extension.state.selectedTabs.length, 0)
  assert.equal(extension.state.focusedWindows.length, 0)
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

test('background input runs once without selecting a tab or dispatching duplicate native input', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ onCommand: (method, params) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'language-field' } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
    if (method === 'Runtime.evaluate') return { result: { value: params.expression === 'document.visibilityState' ? 'hidden' : { mutations: 0, readyState: 'complete' } } }
    return {}
  } })
  settle(0)
  const result = await extension.request('background-type', 'tab.act', { tabId: 5, action: 'type', ref: '42', text: 'English' })
  assert.equal(result.result.synthetic, true)
  assert.equal(extension.state.commands.filter(c => c.method === 'Runtime.callFunctionOn').length, 1)
  assert.equal(extension.state.commands.filter(c => c.method.startsWith('Input.')).length, 0)
  assert.equal(extension.state.selectedTabs.length, 0)
  assert.equal(extension.state.focusedWindows.length, 0)
})

test('native typing refuses redirected focus before clearing or inserting anything', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ onCommand: (method, params) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'language-field' } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: false } }
    if (method === 'Runtime.evaluate') return { result: { value: params.expression === 'document.visibilityState' ? 'visible' : {} } }
    return {}
  } })
  settle(0)
  const result = await extension.request('redirected-focus', 'tab.act', { tabId: 5, action: 'type', ref: '42', text: 'English', pointer: 'hide' })
  assert.match(result.error, /did not retain focus/)
  assert.equal(extension.state.commands.filter(c => c.method.startsWith('Input.')).length, 0)
})

test('unsupported background fast action returns control without selecting the tab', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ onCommand: (method, params) => {
    if (method === 'Runtime.evaluate' && String(params.expression).includes('shunFastGuard')) return { result: { value: { ok: false, reason: 'not-visible' } } }
    return {}
  } })
  settle(0)
  const result = await extension.request('hidden-fast', 'tab.fastAct', { tabId: 5, action: 'click', expected: { id: 4, role: 'button', name: 'Continue' } })
  assert.equal(result.result.acted, false)
  assert.equal(extension.state.selectedTabs.length, 0)
  assert.equal(extension.state.focusedWindows.length, 0)
})

test('a snapshot recovers a transient document disconnect internally without navigation or focus changes', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  let reads = 0
  const extension = startExtension({ onCommand: (method, params) => {
    if (method === 'Accessibility.getFullAXTree') {
      if (++reads === 1) throw Error('Detached while handling command.')
      return { nodes: [] }
    }
    if (method === 'Runtime.evaluate' && String(params.expression).includes('hasBody')) return { result: { value: { url: 'https://example.test/', readyState: 'complete', hasBody: true, text: 'Ready' } } }
    return {}
  } })
  settle(0)
  const result = await extension.request('recover-snapshot', 'tab.snapshot', { tabId: 5 })
  assert.equal(result.error, undefined)
  assert.equal(result.result.text, 'Ready')
  assert.equal(reads, 2)
  assert.equal(extension.state.attaches, 2)
  assert.equal(extension.state.commands.filter(c => c.method === 'Page.navigate' || c.method.startsWith('Input.')).length, 0)
  assert.equal(extension.state.selectedTabs.length, 0)
})

test('a page observation survives a replaced main frame without replaying input', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  let reads = 0
  const extension = startExtension({
    attachError: 'Cannot access a chrome-extension:// URL of different extension',
    onPageScript: () => {
      if (++reads === 1) return Promise.reject(Error('Frame with ID 0 was removed.'))
      return undefined
    },
  })
  settle(0)
  const result = await extension.request('replaced-main-frame', 'tab.snapshot', { tabId: 5 })
  assert.equal(result.error, undefined)
  assert.equal(result.result.transport, 'page')
  assert.equal(extension.state.attaches, 1)
  assert.equal(extension.state.commands.filter(c => c.method === 'Page.navigate' || c.method.startsWith('Input.')).length, 0)
  assert.equal(extension.state.pageCalls.some(call => ['pageAct', 'pagePrepare'].includes(call.args?.[0])), false)
  assert.equal(extension.state.selectedTabs.length, 0)
  assert.equal(extension.state.focusedWindows.length, 0)
})

test('a new-page snapshot waits through an incomplete redirect instead of returning an empty success', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  let reads = 0
  const extension = startExtension({ onCommand: (method, params) => {
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
    if (method === 'Runtime.evaluate' && String(params.expression).includes('hasBody')) {
      reads++
      return { result: { value: reads < 3 ? { url: 'about:blank', readyState: 'complete', hasBody: false, text: '' } : { url: 'https://example.test/', readyState: 'interactive', hasBody: true, text: 'Login' } } }
    }
    return {}
  } })
  settle(0)
  const result = await extension.request('settled-snapshot', 'tab.snapshot', { tabId: 5 })
  assert.equal(result.error, undefined)
  assert.equal(result.result.text, 'Login')
  assert.equal(result.result.loading, false)
  assert.equal(reads, 3)
})

test('a new tab waits for its committed document before attaching or reading the page', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  let reads = 0
  const extension = startExtension({
    attachError: 'Cannot access a chrome-extension:// URL of different extension',
    tab: { get url() { return ++reads < 3 ? '' : 'https://example.test/' }, pendingUrl: 'https://example.test/', status: 'loading' },
  })
  settle(0)
  const answer = await extension.request('new-document', 'tab.snapshot', { tabId: 5 })
  assert.equal(answer.error, undefined)
  assert.equal(answer.result.tab.url, 'https://example.test/')
  assert.equal(answer.result.transport, 'page')
  assert.equal(extension.state.attaches, 1)
  assert.equal(extension.state.navigatedTabs.length, 0)
  assert.equal(extension.state.selectedTabs.length, 0)
})

test('a created tab with no committed document returns loading within the observation deadline', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ tab: { url: '', pendingUrl: 'https://example.test/' } })
  settle(0)
  const answer = await extension.request('pending-document', 'tab.snapshot', { tabId: 5 })
  assert.equal(answer.error, undefined)
  assert.equal(answer.result.loading, true)
  assert.equal(answer.result.nodes.length, 0)
  assert.match(answer.result.observationNote, /tab already exists/)
  assert.equal(extension.state.attaches, 0)
  assert.equal(extension.state.pageCalls.length, 0)
  assert.equal(extension.state.navigatedTabs.length, 0)
})

test('a lost response to input is never replayed by debugger recovery', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ onCommand: (method, params) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'field' } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
    if (method === 'Runtime.evaluate') return { result: { value: params.expression === 'document.visibilityState' ? 'visible' : {} } }
    if (method === 'Input.insertText') throw Error('Detached while handling command.')
    return {}
  } })
  settle(0)
  const result = await extension.request('uncertain-input', 'tab.act', { tabId: 5, action: 'type', ref: '42', text: 'English', clear: false, pointer: 'hide' })
  assert.equal(result.code, 'debugger_lost')
  assert.equal(extension.state.commands.filter(c => c.method === 'Input.insertText').length, 1)
})

test('a foreign extension frame uses top-frame page transport without retrying attach or raising Chrome', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ attachError: 'Cannot access a chrome-extension:// URL of different extension' })
  settle(0)
  const first = await extension.request('page-snapshot-1', 'tab.snapshot', { tabId: 5 })
  assert.equal(first.error, undefined)
  assert.equal(first.result.transport, 'page')
  assert.equal(first.result.nodes[0].ref, 'p:4')
  const stale = await extension.request('old-channel-ref', 'tab.act', { tabId: 5, action: 'click', ref: '4' })
  assert.match(stale.error, /channel changed/)
  assert.equal(extension.state.pageCalls.filter(call => call.args?.[0] === 'pageAct').length, 0)
  const action = await extension.request('page-click', 'tab.act', { tabId: 5, action: 'click', ref: 'p:4' })
  assert.equal(action.result.synthetic, true)
  const second = await extension.request('page-snapshot-2', 'tab.snapshot', { tabId: 5 })
  assert.equal(second.result.transport, 'page')
  assert.equal(extension.state.attaches, 1)
  assert.equal(extension.state.commands.length, 0)
  assert.equal(extension.state.selectedTabs.length, 0)
  assert.equal(extension.state.focusedWindows.length, 0)
  assert.ok(extension.state.pageCalls.every(call => call.world === 'ISOLATED' && call.target.frameIds.length === 1 && call.target.frameIds[0] === 0))
})

test('an extension frame discovered after attach selects one observation channel before input', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ onCommand: method => method === 'Page.getFrameTree'
    ? { frameTree: { frame: { url: 'https://example.test/' }, childFrames: [{ frame: { url: 'chrome-extension://other-extension/panel.html' } }] } } : {} })
  settle(0)
  const snapshot = await extension.request('mixed-frame-page', 'tab.snapshot', { tabId: 5 })
  assert.equal(snapshot.result.transport, 'page')
  assert.equal(snapshot.result.nodes[0].ref, 'p:4')
  const result = await extension.request('mixed-frame-click', 'tab.act', { tabId: 5, action: 'click', ref: 'p:4' })
  assert.equal(result.result.synthetic, true)
  assert.equal(extension.state.commands.filter(call => call.method.startsWith('Input.')).length, 0)
  assert.equal(extension.state.attaches, 1)
  assert.equal(extension.state.selectedTabs.length, 0)
})


test('an empty isolated document waits internally for content and never reports an empty app as ready', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  let reads = 0
  const observation = () => ({ ...fastObservation, url: 'https://example.test/', ...(++reads <= 3 ? { text: '', elements: [] } : {}) })
  const extension = startExtension({ attachError: 'Cannot access a chrome-extension:// URL of different extension', pageObservation: observation })
  settle(0)
  const ready = await extension.request('rendering-app', 'tab.snapshot', { tabId: 5 })
  assert.equal(ready.result.loading, false)
  assert.equal(ready.result.nodes[0].ref, 'p:4')
  assert.ok(reads >= 4)
  reads = -100
  const empty = await extension.request('empty-app', 'tab.snapshot', { tabId: 5 })
  assert.equal(empty.result.loading, true)
  assert.equal(empty.result.nodes.length, 0)
  assert.equal(extension.state.attaches, 1)
  assert.equal(extension.state.selectedTabs.length, 0)
})

test('a stalled page action expires without replay and a queued late action cannot mutate the page', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({
    attachError: 'Cannot access a chrome-extension:// URL of different extension',
    onPageScript: request => request.args?.[0] === 'pageAct' ? new Promise(() => {}) : undefined,
  })
  settle(0)
  await extension.request('initial-page', 'tab.snapshot', { tabId: 5 })
  const result = await extension.request('stalled-page', 'tab.act', { tabId: 5, action: 'click', ref: 'p:4' })
  assert.match(result.error, /pageAct step before its deadline/)
  const queued = extension.state.pageCalls.filter(call => call.args?.[0] === 'pageAct')
  assert.equal(queued.length, 1)
  let mutations = 0
  const scope = { Date: { now: () => queued[0].args[2] + 1 }, shunFastPath: { pageTransportRevision: 'stable-fields-2', pageAct: () => { mutations++ } } }
  assert.throws(() => vm.runInNewContext(`(${queued[0].func.toString()})(...args)`, { ...scope, args: queued[0].args }), /expired before execution/)
  assert.equal(mutations, 0)
  assert.equal((await extension.request('recovered-page', 'tab.snapshot', { tabId: 5 })).result.transport, 'page')
  assert.equal(extension.state.selectedTabs.length, 0)
})


test('a slow background observation completes without foreground activation while input deadlines stay separate', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  let delayed = false
  const extension = startExtension({
    attachError: 'Cannot access a chrome-extension:// URL of different extension',
    onPageScript: request => {
      if (request.args?.[0] !== 'pageObserve' || delayed) return undefined
      delayed = true
      return new Promise(resolve => setTimeout(() => resolve([{ frameId: 0, result: { ...fastObservation, url: 'https://example.test/' } }]), 5_000))
    },
  })
  settle(0)
  const answer = await extension.request('slow-background-read', 'tab.snapshot', { tabId: 5 })
  assert.equal(answer.error, undefined)
  assert.equal(answer.result.transport, 'page')
  assert.equal(answer.result.nodes[0].ref, 'p:4')
  assert.equal(extension.state.selectedTabs.length, 0)
  assert.equal(extension.state.focusedWindows.length, 0)
  assert.equal(extension.state.pageCalls.filter(call => call.args?.[0] === 'pageAct').length, 0)
})


test('a popup reports its actual opener without selecting either tab', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ tab: { openerTabId: 3 } })
  settle(0)
  const claimed = await extension.request('claim-popup', 'tab.attach', { tabId: 5 })
  assert.equal(claimed.error, undefined)
  assert.equal(claimed.result.openerTabId, 3)
  assert.equal(extension.state.selectedTabs.length, 0)
  assert.equal(extension.state.focusedWindows.length, 0)
})

test('claiming and inspecting an unloaded tab needs no renderer and never restores or focuses it implicitly', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ tab: { discarded: true, status: 'unloaded' }, attachError: 'Renderer must not be contacted' })
  settle(0)
  const claimed = await extension.request('claim-unloaded', 'tab.attach', { tabId: 5 })
  assert.equal(claimed.error, undefined)
  assert.equal(claimed.result.discarded, true)
  const observed = await extension.request('read-unloaded', 'tab.snapshot', { tabId: 5 })
  assert.equal(observed.error, undefined)
  assert.equal(observed.result.nodes.length, 0)
  assert.match(observed.result.observationNote, /No webpage content was read/)
  assert.equal(extension.state.attaches, 0)
  assert.equal(extension.state.commands.length, 0)
  assert.equal(extension.state.selectedTabs.length, 0)
  assert.equal(extension.state.focusedWindows.length, 0)
  assert.equal(extension.state.reloadedTabs.length, 0)
})

test('claim waits for a newly created tab destination without creating another tab or focusing it', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  let metadataReads = 0
  const extension = startExtension({ tab: { get url() { return ++metadataReads < 3 ? '' : 'https://example.test/' } } })
  settle(0)
  const claimed = await extension.request('claim-new-loading-tab', 'tab.attach', { tabId: 5 })
  assert.equal(claimed.error, undefined)
  assert.equal(claimed.result.url, 'https://example.test/')
  assert.equal(metadataReads, 3)
  assert.equal(extension.state.attaches, 0)
  assert.equal(extension.state.navigatedTabs.length, 0)
  assert.equal(extension.state.selectedTabs.length, 0)
  assert.equal(extension.state.focusedWindows.length, 0)
})

test('an unavailable tab destination has a bounded metadata wait and preserves the existing tab', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ tab: { url: '' } })
  settle(0)
  const claimed = await extension.request('claim-pending-destination', 'tab.attach', { tabId: 5 })
  assert.match(claimed.error, /tab 5 exists.*do not create a duplicate/)
  assert.equal(extension.state.attaches, 0)
  assert.equal(extension.state.removedTabs.length, 0)
  assert.equal(extension.state.navigatedTabs.length, 0)
  assert.equal(extension.state.focusedWindows.length, 0)
})

test('explicit navigation and reload can recover a tab without attaching to its old document', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ tab: { discarded: true }, attachError: 'Renderer must not be contacted' })
  settle(0)
  assert.equal((await extension.request('navigate-unloaded', 'tab.navigate', { tabId: 5, url: 'https://example.test/login' })).error, undefined)
  assert.equal((await extension.request('reload-unloaded', 'tab.act', { tabId: 5, action: 'reload' })).error, undefined)
  assert.equal(extension.state.navigatedTabs[0].url, 'https://example.test/login')
  assert.deepEqual(extension.state.reloadedTabs, [5])
  assert.equal(extension.state.attaches, 0)
  assert.equal(extension.state.selectedTabs.length, 0)
  assert.equal(extension.state.focusedWindows.length, 0)
})


test('an unavailable screenshot preserves the current text without waiting for the bridge timeout', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ pendingCommands: ['Page.captureScreenshot'], onCommand: method => {
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
    if (method === 'Runtime.evaluate') return { result: { value: { readyState: 'complete', text: 'Current login form', hasBody: true } } }
    return {}
  } })
  settle(0)
  const answer = await extension.request('screenshot-deadline', 'tab.snapshot', { tabId: 5, screenshot: true })
  assert.equal(answer.error, undefined)
  assert.equal(answer.result.text, 'Current login form')
  assert.equal(answer.result.screenshot, undefined)
  assert.match(answer.result.observationNote, /did not provide a screenshot/)
  assert.equal(extension.state.commands.filter(command => command.method === 'Page.captureScreenshot').length, 1)
  assert.equal(extension.state.selectedTabs.length, 0)
})


test('browser-generated diagnostics and exception details survive a current reading without replaying input', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ onCommand: (method, params) => {
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
    if (method === 'Runtime.evaluate' && String(params.expression).includes('hasBody')) return { result: { value: { url: 'https://example.test/', readyState: 'complete', hasBody: true, text: 'Sign in' } } }
    return {}
  } })
  settle(0)
  await extension.request('diagnostic-initial', 'tab.snapshot', { tabId: 5 })
  for (const listener of extension.state.debuggerEventListeners) {
    listener({ tabId: 5 }, 'Log.entryAdded', { entry: { level: 'error', text: 'A browser policy blocked this synthetic request.' } })
    listener({ tabId: 5 }, 'Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: synthetic detailed failure' } } })
  }
  const reading = await extension.request('diagnostic-read', 'tab.snapshot', { tabId: 5 })
  assert.ok(extension.state.commands.some(command => command.method === 'Log.enable'))
  assert.equal(reading.result.console[0].message, 'A browser policy blocked this synthetic request.')
  assert.equal(reading.result.pageErrors[0].message, 'Error: synthetic detailed failure')
  assert.equal(extension.state.commands.some(command => command.method.startsWith('Input.') || command.method === 'Page.navigate'), false)
})

test('AX link observations expose exact paths for unnamed controls without copying signed queries or changing names', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ onCommand: (method, params) => {
    if (method === 'Accessibility.getFullAXTree') return { nodes: [{ backendDOMNodeId: 42, role: { value: 'link' }, name: { value: '' } }] }
    if (method === 'DOM.describeNode') {
      assert.equal(params.backendNodeId, 42)
      return { node: { attributes: ['href', '/logout.php?state=private-synthetic-value#fragment', 'title', 'Exit account'] } }
    }
    if (method === 'Runtime.evaluate' && String(params.expression).includes('hasBody')) return { result: { value: { url: 'https://example.test/', readyState: 'complete', hasBody: true, text: 'Account' } } }
    return {}
  } })
  settle(0)
  const reading = await extension.request('unnamed-link', 'tab.snapshot', { tabId: 5 })
  assert.equal(reading.result.nodes[0].name, '')
  assert.equal(reading.result.nodes[0].target, '/logout.php')
  assert.equal(reading.result.nodes[0].description, 'Exit account')
  assert.equal(JSON.stringify(reading.result).includes('private-synthetic-value'), false)
  assert.equal(extension.state.commands.some(command => command.method === 'Page.navigate' || command.method.startsWith('Input.')), false)
})

test('a timed-out optional link metadata read preserves the successful AX observation', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ pendingCommands: ['DOM.describeNode'], onCommand: (method, params) => {
    if (method === 'Accessibility.getFullAXTree') return { nodes: [{ backendDOMNodeId: 42, role: { value: 'link' }, name: { value: 'Continue' } }] }
    if (method === 'Runtime.evaluate' && String(params.expression).includes('hasBody')) return { result: { value: { url: 'https://example.test/', readyState: 'complete', hasBody: true, text: 'Account' } } }
    return {}
  } })
  settle(0)
  const reading = await extension.request('partial-link', 'tab.snapshot', { tabId: 5 })
  assert.equal(reading.error, undefined)
  assert.equal(reading.result.nodes[0].name, 'Continue')
  assert.match(reading.result.observationNote, /link destinations were unavailable/)
  assert.equal(extension.state.commands.filter(command => command.method === 'DOM.describeNode').length, 1)
})

test('page focus emulation is scoped to the debugger lifetime without selecting the tab', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ onCommand: (method, params) => {
    if (method !== 'Runtime.evaluate') return {}
    if (String(params?.expression || '').includes('shunFastGuard')) return { result: { value: { ok: true, x: 60, y: 35, box: { x: 10, y: 20, width: 100, height: 30 } } } }
    return { result: { value: { mutations: 1, readyState: 'complete' } } }
  } })
  settle(0)
  await extension.request('focused-page-attach', 'tab.fastAct', { tabId: 5, action: 'click', expected: { id: 4, role: 'button', name: 'Continue', fingerprint: 'control-fingerprint' } })
  assert.ok(extension.state.commands.some(call => call.method === 'Emulation.setFocusEmulationEnabled' && call.params.enabled === true))
  assert.equal(extension.state.selectedTabs.length, 0)
  await extension.request('focused-page-release', 'tab.release', { tabId: 5 })
  assert.ok(extension.state.commands.some(call => call.method === 'Emulation.setFocusEmulationEnabled' && call.params.enabled === false))
  assert.deepEqual(extension.state.detached, [5])
  assert.equal(extension.state.selectedTabs.length, 0)
})

test('an unresponsive optional focus override does not stall a current page action or select Chrome', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ pendingCommands: ['Emulation.setFocusEmulationEnabled'], onCommand: (method, params) => {
    if (method !== 'Runtime.evaluate') return {}
    if (String(params?.expression || '').includes('shunFastGuard')) return { result: { value: { ok: true, x: 60, y: 35, box: { x: 10, y: 20, width: 100, height: 30 } } } }
    return { result: { value: { mutations: 1, readyState: 'complete' } } }
  } })
  settle(0)
  const result = await extension.request('optional-focus-timeout', 'tab.fastAct', { tabId: 5, action: 'click', expected: { id: 4, role: 'button', name: 'Continue', fingerprint: 'control-fingerprint' } })
  assert.equal(result.result.acted, true)
  assert.equal(extension.state.commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed').length, 1)
  assert.equal(extension.state.selectedTabs.length, 0)
})

test('stable main-frame field refs survive debugger loss and a later extension frame without replaying input', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  let loseDebugger = false, lost = false
  const extension = startExtension({
    pageObservation: () => ({ ...fastObservation, url: 'https://example.test/', elements: [...fastObservation.elements, { id: 7, role: 'textbox', name: 'Location', value: 'San Jose' }, { id: 8, role: 'combobox', name: 'Region', value: 'CN', selectedLabel: 'China' }] }),
    onCommand: (method, params) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { url: 'https://example.test/' }, ...(lost ? { childFrames: [{ frame: { url: 'chrome-extension://other-extension/frame.html' } }] } : {}) } }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{ role: { value: 'textbox' }, name: { value: 'Location' }, backendDOMNodeId: 44 }] }
      if (method === 'Runtime.evaluate') {
        if (loseDebugger && !lost) { lost = true; throw Error('Debugger is not attached to the tab') }
        return { result: { value: { url: 'https://example.test/', readyState: 'complete', hasBody: true, text: 'A current form' } } }
      }
      return {}
    },
    onPageScript: request => request.args?.[0] === 'pagePrepare' ? Promise.resolve([{ frameId: 0, result: { ok: true, x: 60, y: 35 } }]) : undefined,
  })
  settle(0)
  const first = await extension.request('stable-first', 'tab.snapshot', { tabId: 5, stableRefs: true })
  assert.equal(first.result.nodes.find((node: any) => node.name === 'Location').ref, 'p:7')
  assert.equal(first.result.nodes.find((node: any) => node.name === 'Region').value, 'China')
  loseDebugger = true
  const second = await extension.request('stable-after-loss', 'tab.snapshot', { tabId: 5, stableRefs: true })
  assert.equal(second.result.nodes.find((node: any) => node.name === 'Region').value, 'China')
  assert.equal(second.result.nodes.find((node: any) => node.name === 'Location').ref, 'p:7')
  assert.equal(second.result.transport, 'page')
  assert.equal(second.result.trustedClick, true)
  const click = await extension.request('trusted-main-frame-click', 'tab.act', { tabId: 5, action: 'click', ref: 'p:4' })
  assert.equal(click.result.synthetic, false)
  assert.equal(extension.state.commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed').length, 1)
  assert.equal(extension.state.pageCalls.filter(call => call.args?.[0] === 'pageAct').length, 0)
  assert.ok(extension.state.pageCalls.every(call => call.world === 'ISOLATED' && call.target.frameIds[0] === 0))
  assert.equal(extension.state.selectedTabs.length, 0)
  assert.equal(extension.state.focusedWindows.length, 0)
})

test('an uncertain trusted click never falls through into a synthetic second click', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ onCommand: (method, params) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { url: 'https://example.test/' }, childFrames: [{ frame: { url: 'chrome-extension://other-extension/frame.html' } }] } }
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') throw Error('Simulated uncertain input response')
    return {}
  }, onPageScript: request => request.args?.[0] === 'pagePrepare' ? Promise.resolve([{ frameId: 0, result: { ok: true, x: 60, y: 35 } }]) : undefined })
  settle(0)
  await extension.request('uncertain-prepare', 'tab.snapshot', { tabId: 5, stableRefs: true })
  const click = await extension.request('uncertain-trusted-click', 'tab.act', { tabId: 5, action: 'click', ref: 'p:4' })
  assert.match(click.error, /uncertain input response/)
  assert.equal(extension.state.commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed').length, 1)
  assert.equal(extension.state.pageCalls.filter(call => call.args?.[0] === 'pageAct').length, 0)
  assert.equal(extension.state.selectedTabs.length, 0)
})

test('visible stable field input uses browser events once without selecting the tab', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({
    onCommand: (method, params) => method === 'Runtime.evaluate' && params.expression === 'document.visibilityState' ? { result: { value: 'visible' } } : {},
    onPageScript: request => ['pageFocus', 'pageHasFocus'].includes(request.args?.[0]) ? Promise.resolve([{ frameId: 0, result: { ok: true } }]) : undefined,
  })
  settle(0)
  await extension.request('trusted-type-read', 'tab.snapshot', { tabId: 5, stableRefs: true })
  const typed = await extension.request('trusted-type', 'tab.act', { tabId: 5, action: 'type', ref: 'p:4', text: 'Masked input' })
  assert.equal(typed.error, undefined)
  assert.equal(typed.result.synthetic, false)
  assert.deepEqual(extension.state.commands.filter(call => call.method === 'Input.insertText').map(call => call.params.text), ['Masked input'])
  assert.equal(extension.state.pageCalls.filter(call => call.args?.[0] === 'pageHasFocus').length, 2)
  assert.equal(extension.state.pageCalls.filter(call => call.args?.[0] === 'pageAct').length, 0)
  const queued = extension.state.pageCalls.find(call => call.args?.[0] === 'pageFocus')!
  const oldObserver = { pageTransportRevision: 'stable-fields-2', pageAct: () => { throw Error('Input must not be dispatched') } }
  const missing = vm.runInNewContext(`(${queued.func.toString()})(...args)`, { Date: { now: () => queued.args[2] - 1 }, args: queued.args, shunFastPath: oldObserver })
  assert.equal(missing.shunObserverMissing, true, 'an older compatible observer is refreshed before calling a newly added method')
  assert.equal(extension.state.selectedTabs.length, 0)
  assert.equal(extension.state.focusedWindows.length, 0)
})

test('stable field typing stops if clearing redirects focus and never replays input', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  let checks = 0
  const extension = startExtension({
    onCommand: (method, params) => method === 'Runtime.evaluate' && params.expression === 'document.visibilityState' ? { result: { value: 'visible' } } : {},
    onPageScript: request => request.args?.[0] === 'pageFocus' ? Promise.resolve([{ frameId: 0, result: { ok: true } }])
      : request.args?.[0] === 'pageHasFocus' ? Promise.resolve([{ frameId: 0, result: { ok: ++checks === 1 } }]) : undefined,
  })
  settle(0)
  await extension.request('focus-redirect-read', 'tab.snapshot', { tabId: 5, stableRefs: true })
  const typed = await extension.request('focus-redirect-type', 'tab.act', { tabId: 5, action: 'type', ref: 'p:4', text: 'English' })
  assert.match(typed.error, /did not retain focus/)
  assert.equal(extension.state.commands.filter(call => call.method === 'Input.insertText').length, 0)
  assert.equal(extension.state.pageCalls.filter(call => call.args?.[0] === 'pageAct').length, 0)
  assert.equal(extension.state.selectedTabs.length, 0)
})

test('an uncertain stable field insert never falls through into synthetic typing', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({
    onCommand: (method, params) => {
      if (method === 'Runtime.evaluate' && params.expression === 'document.visibilityState') return { result: { value: 'visible' } }
      if (method === 'Input.insertText') throw Error('Uncertain text delivery')
      return {}
    },
    onPageScript: request => ['pageFocus', 'pageHasFocus'].includes(request.args?.[0]) ? Promise.resolve([{ frameId: 0, result: { ok: true } }]) : undefined,
  })
  settle(0)
  await extension.request('uncertain-type-read', 'tab.snapshot', { tabId: 5, stableRefs: true })
  const typed = await extension.request('uncertain-type', 'tab.act', { tabId: 5, action: 'type', ref: 'p:4', text: 'Once' })
  assert.match(typed.error, /Uncertain text delivery/)
  assert.equal(extension.state.commands.filter(call => call.method === 'Input.insertText').length, 1)
  assert.equal(extension.state.pageCalls.filter(call => call.args?.[0] === 'pageAct').length, 0)
})

test('hidden stable field input stays synthetic and does not steal foreground', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  const extension = startExtension({ onCommand: (method, params) => method === 'Runtime.evaluate' && params.expression === 'document.visibilityState' ? { result: { value: 'hidden' } } : {} })
  settle(0)
  await extension.request('hidden-stable-read', 'tab.snapshot', { tabId: 5, stableRefs: true })
  const typed = await extension.request('hidden-stable-type', 'tab.act', { tabId: 5, action: 'type', ref: 'p:4', text: 'Background' })
  assert.equal(typed.result.synthetic, true)
  assert.equal(extension.state.commands.filter(call => call.method.startsWith('Input.')).length, 0)
  assert.equal(extension.state.pageCalls.filter(call => call.args?.[0] === 'pageFocus').length, 0)
  assert.equal(extension.state.selectedTabs.length, 0)
  assert.equal(extension.state.focusedWindows.length, 0)
})

test('a missing observer is installed before starting the input deadline and warm calls do not reload it', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  t.after(() => mock.timers.reset())
  let missing = true, mutations = 0
  const extension = startExtension({ attachError: 'Cannot access a chrome-extension:// URL of different extension', onPageScript: request => {
    if (request.files) return new Promise(resolve => setTimeout(() => resolve([{ frameId: 0 }]), 5_000))
    if (request.args?.[0] !== 'pageAct') return undefined
    if (missing) { missing = false; return Promise.resolve([{ frameId: 0, result: { shunObserverMissing: true } }]) }
    mutations++
    return Promise.resolve([{ frameId: 0, result: { ok: true, synthetic: true } }])
  } })
  settle(0)
  await extension.request('initial-read', 'tab.snapshot', { tabId: 5 })
  const cold = await extension.request('cold-observer-action', 'tab.act', { tabId: 5, action: 'click', ref: 'p:4' })
  assert.equal(cold.error, undefined)
  assert.equal(mutations, 1)
  const calls = extension.state.pageCalls.filter(call => call.args?.[0] === 'pageAct')
  const missingResult = vm.runInNewContext(`(${calls[0].func.toString()})(...args)`, { Date: { now: () => calls[0].args[2] - 1 }, args: calls[0].args })
  assert.equal(missingResult.shunObserverMissing, true)
  assert.ok(calls[1].args[2] - calls[0].args[2] >= 5_000)
  await extension.request('warm-observer-action', 'tab.act', { tabId: 5, action: 'click', ref: 'p:4' })
  assert.equal(extension.state.pageCalls.filter(call => call.files).length, 1)
  assert.equal(mutations, 2)
  assert.equal(extension.state.selectedTabs.length, 0)
})
