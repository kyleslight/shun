const PORTS = Array.from({ length: 10 }, (_, index) => 32124 + index)
const PROTOCOL_VERSION = '1.3'
const RECONNECT_ALARM = 'shun-browser-use-reconnect'
/** The alarm that takes the marks off a tab whose driver has gone quiet while the worker slept. */
const MARK_SWEEP_ALARM = 'shun-browser-use-mark-sweep'

// The fast path's page-side half. It is loaded here and never run here: its functions are
// stringified into expressions that the page evaluates, so one observation and one guarded
// action each cost a single call instead of an accessibility walk.
importScripts('fast-path.js')

// Liveness is proved by Shun answering a heartbeat, never by readyState: when the
// desktop bridge exits, a suspended worker can miss the close event and Chrome
// keeps reporting that socket as OPEN, which used to leave the extension dead
// until someone disabled and enabled it by hand.
//
// The cadence is deliberately not a poll. While a task is driving a tab the
// heartbeat runs every second and a missing answer is fatal after 1.2s, so a
// silent death is noticed in about two seconds. While nothing is attached it
// drops to one heartbeat every four seconds. Nothing else ticks.
const HEARTBEAT_BUSY_MS = 1_000
const HEARTBEAT_IDLE_MS = 2_000
const ANSWER_BUSY_MS = 1_200
const ANSWER_IDLE_MS = 1_500
// A delivered close event is authority: come back immediately, not after a poll.
const RECOVER_DELAY_MS = 250
// Retries while Shun is away back off, so a long-closed desktop app costs a
// handful of refused loopback connects per minute instead of a busy loop.
const RETRY_MIN_MS = 600
const RETRY_MAX_MS = 30_000
// Within this window after a working connection, reconnecting is the thing the
// user is watching for — restarting Shun — so retries stay at one per second and
// the worker is deliberately kept awake. Past it the worker is allowed to
// suspend and the 30s alarm takes over, which is the cheap state a closed app
// should leave behind.
const FAST_RETRY_MS = 1_000
const FAST_RETRY_WINDOW_MS = 10 * 60_000
// The last good port is tried alone; a full sweep every this many attempts still
// finds a bridge that moved to another port.
const SWEEP_EVERY = 10
// Freshness bound for a socket that Chrome still calls open.
const FRESH_BUSY_MS = 5_000
const FRESH_IDLE_MS = 10_000
// Opening a connection into silence this long after the last answer means the
// bridge accepts sockets but cannot talk to this worker.
const SILENT_OPEN_MS = 30_000
// Past this, a worker that is demonstrably alive and was talking to Shun is
// beyond what this script can repair from the inside, and reloads itself once.
const SELF_HEAL_MS = 60_000
const PROBE_LIMIT_MS = 5_000
const PROBE_ROUNDS = 3
const PROBE_SPACING_MS = 2_500
const attachedTabs = new Set()
const diagnostics = new Map()
let socket
let connectedPort
let reconnectTimer
let heartbeatTimer
let answerTimer
let retryDelay = 0
let lastConnectedAt = 0
let lastPort
let fastAttempts = 0
let probeRounds = 0
let preferenceProbe = false
let probeStartedAt = 0
let connectionAttempt = false
let bridgeAnswers = false
let awaitingAnswer = false
let lastAnswerAt = 0
let lastStatus
let openedAt = 0
let openedIntoSilence = false

function setStatus(connected, port) {
  // The badge is only written when it changes: this runs while Shun is away, and
  // extension API calls are what would keep a suspended worker awake for nothing.
  if (lastStatus === connected) return
  lastStatus = connected
  void chrome.action.setBadgeText({ text: connected ? '' : '!' })
  void chrome.action.setBadgeBackgroundColor({ color: '#777777' })
}

function heartbeatEvery() { return attachedTabs.size ? HEARTBEAT_BUSY_MS : HEARTBEAT_IDLE_MS }

function inFastWindow() { return Date.now() - lastConnectedAt < FAST_RETRY_WINDOW_MS }

// Retrying is not an extension API call, so a disconnected worker would be
// suspended after 30s of quiet and take its retry timer with it. One cheap call
// per retry keeps it awake for the window that matters and nowhere else.
function keepAwakeForRetry() {
  if (!inFastWindow()) return
  // Never let a bookkeeping call take the retry loop down with it.
  try { void chrome.alarms.get?.(RECONNECT_ALARM) } catch {}
}

// A single-port probe is ~10x cheaper than a sweep and covers the ordinary case
// of Shun coming back on the port it used before.
function portsToProbe() {
  if (lastPort && inFastWindow() && fastAttempts % SWEEP_EVERY !== 0) return [lastPort]
  return PORTS
}
function answerDeadline() { return attachedTabs.size ? ANSWER_BUSY_MS : ANSWER_IDLE_MS }

// Aliveness for the keep-or-drop decision. A heartbeat that is merely in flight is
// not evidence of death — the deadline in missedAnswer decides that. Counting it
// as stale made a periodic alarm tick drop a healthy connection, which showed up
// as churn exactly every 30 seconds.
function socketAlive() {
  if (socket?.readyState !== WebSocket.OPEN) return false
  return Date.now() - Math.max(lastAnswerAt, openedAt) < (attachedTabs.size ? FRESH_BUSY_MS : FRESH_IDLE_MS)
}

function forgetSocket(target) {
  if (socket !== target) return false
  socket = undefined
  connectedPort = undefined
  openedAt = 0
  awaitingAnswer = false
  clearInterval(heartbeatTimer)
  clearTimeout(answerTimer)
  heartbeatTimer = undefined
  answerTimer = undefined
  return true
}

// The heartbeat is the whole liveness story: one timer per beat, armed only while
// a socket is open, and disarmed by any answer from Shun.
function heartbeat() {
  if (socket?.readyState !== WebSocket.OPEN) return
  awaitingAnswer = true
  clearTimeout(answerTimer)
  answerTimer = setTimeout(missedAnswer, answerDeadline())
  send({ type: 'heartbeat', at: Date.now() })
}

function missedAnswer() {
  answerTimer = undefined
  awaitingAnswer = false
  if (socket?.readyState !== WebSocket.OPEN) return
  // A bridge that never answered the handshake predates this protocol: it gets
  // the readyState behaviour it was built for instead of being torn down.
  if (!bridgeAnswers) return
  // Alive, previously connected, and now opening connections Shun accepts but
  // never answers: nothing here can repair that, so reload once.
  if (openedIntoSilence && Date.now() - lastAnswerAt >= SELF_HEAL_MS) { chrome.runtime.reload(); return }
  dropSocket(socket, 1000, 'Shun stopped answering this Chrome connection.')
  retryDelay = 0
  connect()
}

function refreshHeartbeat() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(heartbeat, heartbeatEvery())
}

// Handlers are detached before closing: dropping a socket must not run the close
// path that schedules another reconnect for a socket we already replaced.
function dropSocket(target, code, reason) {
  if (!target) return
  target.onopen = null
  target.onmessage = null
  target.onerror = null
  target.onclose = null
  try { target.close(code, reason) } catch {}
  if (forgetSocket(target)) { void releaseAttachedTabs(); setStatus(false) }
}

function connect(force = false) {
  clearTimeout(reconnectTimer)
  if (connectionAttempt) return
  if (socket) {
    if (socket.readyState === WebSocket.CONNECTING) return
    // A bridge that never answered the handshake is an older Shun: it keeps the
    // behaviour it was built for instead of being torn down every minute.
    if (!force && (!bridgeAnswers || socketAlive())) return
    dropSocket(socket, 1000, force ? 'Reconnecting to Shun.' : 'Shun stopped answering this Chrome connection.')
  }
  connectionAttempt = true
  fastAttempts += 1
  const ports = portsToProbe()
  let index = 0
  const attempt = () => {
    if (index >= ports.length) {
      connectionAttempt = false
      setStatus(false)
      if (inFastWindow()) {
        retryDelay = FAST_RETRY_MS
        keepAwakeForRetry()
      } else {
        retryDelay = retryDelay ? Math.min(RETRY_MAX_MS, retryDelay * 2) : RETRY_MIN_MS
      }
      reconnectTimer = setTimeout(connect, retryDelay)
      return
    }
    const port = ports[index++]
    let candidate
    // A constructor throw (a blocked scheme, a changed CSP) must not latch the
    // loop: one bad attempt used to leave the extension unable to retry at all.
    try { candidate = new WebSocket(`ws://127.0.0.1:${port}`) } catch { setTimeout(attempt, 0); return }
    let settled = false
    const fail = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { candidate.close() } catch {}
      attempt()
    }
    const timer = setTimeout(fail, 550)
    candidate.onopen = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      connectionAttempt = false
      adoptSocket(candidate, port)
    }
    candidate.onerror = fail
    candidate.onclose = () => { if (!settled) fail() }
  }
  attempt()
}

function adoptSocket(candidate, port) {
  const previous = socket
  socket = candidate
  connectedPort = port
  openedAt = Date.now()
  // Opening a connection into a silence Shun used to answer is the signature of a
  // bridge that accepts sockets and then cannot talk to this worker; a closed
  // Shun refuses connections instead and never reaches this line.
  if (bridgeAnswers && Date.now() - lastAnswerAt >= SILENT_OPEN_MS) openedIntoSilence = true
  candidate.onmessage = event => {
    lastAnswerAt = Date.now()
    openedIntoSilence = false
    awaitingAnswer = false
    clearTimeout(answerTimer)
    answerTimer = undefined
    void handleRequest(event.data)
  }
  candidate.onerror = () => {}
  candidate.onclose = () => {
    if (socket !== candidate) return
    forgetSocket(candidate)
    void releaseAttachedTabs()
    setStatus(false)
    // A close Chrome delivered is authority; there is nothing to wait for.
    retryDelay = 0
    reconnectTimer = setTimeout(connect, RECOVER_DELAY_MS)
  }
  setStatus(true, port)
  retryDelay = 0
  fastAttempts = 0
  lastPort = port
  lastConnectedAt = Date.now()
  probeRounds = 0
  send({ type: 'hello', version: chrome.runtime.getManifest().version, browser: 'chrome' })
  refreshHeartbeat()
  heartbeat()
  if (previous && previous !== candidate) dropSocket(previous, 1000, 'Replaced by a newer Shun connection.')
}

function preferEarlierServer() {
  if (probeRounds >= PROBE_ROUNDS) return
  if (preferenceProbe && Date.now() - probeStartedAt < PROBE_LIMIT_MS) return
  preferenceProbe = false
  if (socket?.readyState !== WebSocket.OPEN) return
  const currentIndex = PORTS.indexOf(connectedPort)
  if (currentIndex <= 0) return
  probeRounds += 1
  preferenceProbe = true
  probeStartedAt = Date.now()
  let index = 0
  const attempt = () => {
    if (index >= currentIndex) { preferenceProbe = false; return }
    const port = PORTS[index++]
    let candidate
    try { candidate = new WebSocket(`ws://127.0.0.1:${port}`) } catch { preferenceProbe = false; return }
    let settled = false
    const fail = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { candidate.close() } catch {}
      attempt()
    }
    const timer = setTimeout(fail, 350)
    candidate.onopen = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      preferenceProbe = false
      adoptSocket(candidate, port)
    }
    candidate.onerror = fail
    candidate.onclose = () => { if (!settled) fail() }
  }
  attempt()
}

function send(value) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
}

async function handleRequest(raw) {
  let request
  try { request = JSON.parse(raw) } catch { return }
  if (request?.type === 'hello.ack') { bridgeAnswers = request.heartbeat === true; return }
  if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') return
  try {
    const result = await dispatch(request.method, request.params || {})
    send({ id: request.id, result })
  } catch (error) {
    send({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
      ...(error && error.code ? { code: error.code } : {}),
      ...(error && error.detail ? { detail: error.detail } : {}),
    })
  }
}

async function dispatch(method, params) {
  // Every request that names a tab is that tab being driven, which is what the marks say. A tab
  // left alone stops being driven, and stops looking like it.
  const asked = Number(params && params.tabId)
  if (Number.isSafeInteger(asked) && asked > 0) noteTabActivity(asked)
  return runRequest(method, params)
}

async function runRequest(method, params) {
  switch (method) {
    case 'tabs.list': return (await tabsQuery({})).map(tabInfo).filter(tab => tab.id && /^https?:\/\//i.test(tab.url || ''))
    case 'tabs.create': return tabInfo(await tabsCreate({ url: checkedUrl(params.url), active: Boolean(params.active) }))
    case 'tab.attach': return attach(checkedTabId(params.tabId))
    case 'tab.activate': return activate(checkedTabId(params.tabId))
    case 'tab.navigate': return navigate(checkedTabId(params.tabId), checkedUrl(params.url))
    case 'tab.snapshot': return snapshot(checkedTabId(params.tabId), Boolean(params.screenshot), params.pointer === 'hide')
    case 'tab.act': return act(checkedTabId(params.tabId), params)
    case 'tab.fastSnapshot': return fastSnapshot(checkedTabId(params.tabId))
    case 'tab.fastAct': return fastAct(checkedTabId(params.tabId), params)
    case 'tab.release': return release(checkedTabId(params.tabId), Boolean(params.closeTab), Boolean(params.keepMarks))
    case 'downloads.start': return startDownload(checkedTabId(params.tabId), checkedRef(params.ref))
    case 'downloads.wait': return waitForDownload(checkedTabId(params.tabId), Number(params.after) || 0, Number(params.timeoutMs) || 30_000, Number(params.downloadId) || 0)
    default: throw new Error(`Unknown Shun Browser Use method: ${method}`)
  }
}

async function attach(tabId) {
  if (!attachedTabs.has(tabId)) {
    await debuggerAttach({ tabId }, PROTOCOL_VERSION)
    attachedTabs.add(tabId)
    // A run is driving a tab now, so liveness matters at second scale.
    refreshHeartbeat()
    diagnostics.set(tabId, { console: [], pageErrors: [] })
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable', 'DOM.enable', 'Accessibility.enable']) {
      try { await debuggerCommand({ tabId }, method) } catch {}
    }
  }
  return tabInfo(await tabsGet(tabId))
}

async function activate(tabId) {
  const tab = await tabsGet(tabId)
  await windowsUpdate(tab.windowId, { focused: true })
  return tabInfo(await tabsUpdate(tabId, { active: true }))
}

async function navigate(tabId, url) {
  await attach(tabId)
  const settled = waitForTab(tabId, 15_000)
  await debuggerCommand({ tabId }, 'Page.navigate', { url })
  await settled
  return tabInfo(await tabsGet(tabId))
}

async function snapshot(tabId, includeScreenshot, hidePointer) {
  if (!hidePointer) return captureSnapshot(tabId, includeScreenshot)
  await setPointerVisible(tabId, false)
  try { return await captureSnapshot(tabId, includeScreenshot) } finally { await setPointerVisible(tabId, true) }
}

async function captureSnapshot(tabId, includeScreenshot) {
  await attach(tabId)
  await markTab(tabId)
  const [tree, page, tab] = await Promise.all([
    debuggerCommand({ tabId }, 'Accessibility.getFullAXTree'),
    debuggerCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(() => ({ readyState: document.readyState, text: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 12000), viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio } }))()`,
      returnByValue: true,
    }),
    tabsGet(tabId),
  ])
  const rows = []
  for (const node of tree?.nodes || []) {
    if (node.ignored || !node.backendDOMNodeId) continue
    const role = propertyValue(node.role)
    const name = propertyValue(node.name)
    const value = propertyValue(node.value)
    if (!role && !name && !value) continue
    const properties = Object.fromEntries((node.properties || []).map(item => [item.name, propertyValue(item.value)]))
    rows.push({
      ref: String(node.backendDOMNodeId), role, name, value,
      description: propertyValue(node.description), focused: properties.focused === true,
      disabled: properties.disabled === true, checked: properties.checked,
    })
    if (rows.length >= 500) break
  }
  const log = diagnostics.get(tabId) || { console: [], pageErrors: [] }
  const result = {
    tab: tabInfo(tab), readyState: page?.result?.value?.readyState,
    viewport: page?.result?.value?.viewport, text: page?.result?.value?.text,
    nodes: rows, console: log.console.slice(-30), pageErrors: log.pageErrors.slice(-20),
  }
  if (includeScreenshot) result.screenshot = (await debuggerCommand({ tabId }, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }))?.data
  return result
}

/**
 * A click is dispatched at a point, so whatever is on top of that point receives
 * it — not necessarily the control we meant. When the point belongs to something
 * else, or to nothing at all, saying so is the only honest outcome: clicking would
 * either do nothing or activate the wrong control.
 */
function controlNotReachable(covering) {
  const error = new Error(`The control is behind ${covering}.`)
  error.code = 'control_not_reachable'
  error.detail = { covering }
  return error
}

/** The control is no longer where its box said it was, so no click would land on it. */
function controlGone() {
  const error = new Error('The control is not where its position on the page says it is.')
  error.code = 'control_not_found'
  return error
}

/**
 * Whether a click at this point would reach the control. A control may wrap the
 * element under the point (an icon inside a button), and a point may land on a
 * child of the control, so containment either way is a reach. An inconclusive
 * answer — the hit test itself failing — is not a refusal.
 */
async function clickReachesControl(tabId, backendNodeId, x, y) {
  const hit = await debuggerCommand({ tabId }, 'DOM.getNodeForLocation', {
    x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: true,
  }).catch(() => null)
  if (!hit) return true
  if (hit.backendNodeId === undefined) return { gone: true }
  if (hit.backendNodeId === backendNodeId) return true
  const [target, under] = await Promise.all([
    debuggerCommand({ tabId }, 'DOM.resolveNode', { backendNodeId }),
    debuggerCommand({ tabId }, 'DOM.resolveNode', { backendNodeId: hit.backendNodeId }),
  ]).catch(() => [])
  const targetId = target?.object?.objectId, underId = under?.object?.objectId
  if (!targetId || !underId) return true
  const contained = await debuggerCommand({ tabId }, 'Runtime.callFunctionOn', {
    objectId: targetId,
    functionDeclaration: 'function (other) { return !!other && (this === other || this.contains(other) || other.contains(this)); }',
    arguments: [{ objectId: underId }],
    returnByValue: true,
  }).catch(() => null)
  if (contained?.result?.value !== false) return true
  // The pointer Shun draws is pointer-events: none and a real click passes straight through
  // it, so a hit test that lands on Shun's own overlay is describing Shun, not the page. Left
  // alone it made Shun refuse to click a control it had just pointed at.
  const own = await debuggerCommand({ tabId }, 'Runtime.callFunctionOn', {
    objectId: underId,
    functionDeclaration: `function () { return !!(this.closest && this.closest('[${OVERLAY_ATTR}],[data-shun-borrowed],[data-shun-marker]')); }`,
    returnByValue: true,
  }).catch(() => null)
  if (own?.result?.value === true) return true
  const described = await debuggerCommand({ tabId }, 'Runtime.callFunctionOn', {
    objectId: underId,
    functionDeclaration: 'function () { const label = (this.getAttribute && (this.getAttribute("aria-label") || this.getAttribute("title"))) || ""; const text = (this.textContent || "").trim(); return ((this.tagName || "").toLowerCase() + " " + (label || text).replace(/\\s+/g, " ").slice(0, 60)).trim(); }',
    returnByValue: true,
  }).catch(() => null)
  return { covering: String(described?.result?.value || 'another element').slice(0, 80) }
}

async function act(tabId, params) {
  await attach(tabId)
  await markTab(tabId)
  await watchActionChanges(tabId)
  const action = String(params.action || '')
  // "Hide the pointer for this one action" is the caller's, not a page's: the pointer is
  // set aside before the action and restored before the run continues to the next one.
  const hidePointer = params.pointer === 'hide'
  // Scrolling, clicking, typing, and key presses are input, and input only reaches a tab
  // Chrome is rendering. Navigation and downloads are browser calls and need none of this.
  let synthetic = false
  if (['click', 'type', 'select', 'keypress', 'scroll'].includes(action)) {
    const unreachable = await ensureTabReceivesInput(tabId)
    if (unreachable) {
      // Chrome is not rendering this tab, so the action is performed by the page itself and
      // reported as such rather than sent into a pipeline that drops it.
      if (!(await actInPage(tabId, params))) {
        const error = new Error('Chrome is not showing that tab, so it does not deliver clicks or keys to it.')
        error.code = 'tab_not_visible'
        throw error
      }
      synthetic = true
    }
  }
  if (hidePointer) await setPointerVisible(tabId, false)
  const pointer = (step) => hidePointer ? undefined : showPointer(tabId, step)
  const atNode = (backendNodeId) => hidePointer ? undefined : pointerAtNode(tabId, backendNodeId)
  if (action === 'click') {
    const backendNodeId = checkedRef(params.ref)
    try { await debuggerCommand({ tabId }, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }) } catch {}
    const model = await debuggerCommand({ tabId }, 'DOM.getBoxModel', { backendNodeId })
    const quad = model?.model?.content || model?.model?.border
    if (!Array.isArray(quad) || quad.length < 8) throw controlGone()
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
    const reach = await clickReachesControl(tabId, backendNodeId, x, y)
    if (reach !== true) throw reach.gone ? controlGone() : controlNotReachable(reach.covering)
    await pointer({ x, y, box: boxFromQuad(quad) })
    await debuggerCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await debuggerCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  } else if (action === 'type') {
    const backendNodeId = checkedRef(params.ref)
    await atNode(backendNodeId)
    await debuggerCommand({ tabId }, 'DOM.focus', { backendNodeId })
    if (params.clear !== false) await clearFocusedText(tabId)
    await debuggerCommand({ tabId }, 'Input.insertText', { text: String(params.text || '').slice(0, 20_000) })
  } else if (action === 'select') {
    await atNode(checkedRef(params.ref))
    const object = await debuggerCommand({ tabId }, 'DOM.resolveNode', { backendNodeId: checkedRef(params.ref) })
    await debuggerCommand({ tabId }, 'Runtime.callFunctionOn', {
      objectId: object?.object?.objectId,
      functionDeclaration: `function(value) { this.value = value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }`,
      arguments: [{ value: String(params.value || '').slice(0, 2_000) }],
    })
  } else if (action === 'upload') {
    const files = Array.isArray(params.files) ? params.files.map(value => String(value)).slice(0, 10) : []
    if (!files.length || files.some(path => !path)) throw new Error('Upload requires one or more validated absolute file paths.')
    await atNode(checkedRef(params.ref))
    await debuggerCommand({ tabId }, 'DOM.setFileInputFiles', { backendNodeId: checkedRef(params.ref), files })
  } else if (action === 'keypress') {
    const key = String(params.key || '')
    await pointer({})
    await pressKey(tabId, key)
  } else if (action === 'scroll') {
    const direction = String(params.direction || 'down'), amount = Math.max(1, Math.min(10, Number(params.amount) || 1))
    const x = 500, y = 400, distance = 620 * amount
    await pointer({ x, y })
    await debuggerCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: direction === 'left' ? -distance : direction === 'right' ? distance : 0, deltaY: direction === 'up' ? -distance : direction === 'down' ? distance : 0 })
  } else if (action === 'back') await tabsGoBack(tabId)
  else if (action === 'forward') await tabsGoForward(tabId)
  else if (action === 'reload') await tabsReload(tabId)
  else throw new Error(`Unsupported browser action: ${action}`)
  if (hidePointer) await setPointerVisible(tabId, true)
  await settledAfterAction(tabId)
  return synthetic ? { ok: true, synthetic: true } : true
}

async function fastSnapshot(tabId) {
  await attach(tabId)
  return { ...(await fastObserve(tabId)), tab: tabInfo(await tabsGet(tabId)) }
}

/** One evaluate answers the whole observation, which is the point of this path. */
async function fastObserve(tabId) {
  const fast = globalThis.shunFastPath
  if (!fast) throw new Error('The fast browser path is missing from this extension build.')
  const probe = await debuggerCommand({ tabId }, 'Runtime.evaluate', { expression: fast.observeExpression(), returnByValue: true })
  const value = probe?.result?.value
  if (!value || value.error) throw new Error(`The page did not answer a fast observation${value?.error ? `: ${String(value.error).slice(0, 200)}` : ''}.`)
  return value
}

/**
 * The guard, as one call. It verifies the control a decision named and takes the page-side
 * half of the action — focus, or a chosen option — or answers that the page has moved on.
 * Nothing here decides anything: a stale answer is returned, never worked around.
 */
async function fastPrepare(tabId, expected, action) {
  const fast = globalThis.shunFastPath
  if (!fast) throw new Error('The fast browser path is missing from this extension build.')
  const probe = await debuggerCommand({ tabId }, 'Runtime.evaluate', { expression: fast.prepareExpression(expected, action), returnByValue: true })
  const value = probe?.result?.value
  if (!value || value.error) return { ok: false, reason: 'unreadable', ...(value?.error ? { detail: String(value.error).slice(0, 200) } : {}) }
  return value
}

/**
 * The page's own answer to whether it is still changing, then one observation. A flat wait
 * charges every action its worst case; the page ends the wait as soon as it stops moving.
 * The observation comes after that, so the next decision sees what the action caused.
 */
async function settleFastAction(tabId) {
  await waitForPageToSettle(tabId)
  return fastObserve(tabId)
}

/**
 * A fast action: verify, act, settle, observe — in one call, so the caller never has a
 * window in which it could act on an observation that has already expired.
 *
 * The same at-most-once rule as the general path holds: this function either performs the
 * action it was asked for exactly once or performs nothing at all. It never retries, because
 * a click that may have been delivered twice is how a message is sent twice.
 */
async function fastAct(tabId, params) {
  await attach(tabId)
  await markTab(tabId)
  const action = String(params.action || '')
  // Change counting starts before the action, so a handler that runs with the event is a
  // change this action caused rather than something already true about the page.
  await watchActionChanges(tabId)
  const hidePointer = params.pointer === 'hide'
  if (action === 'click' || action === 'type' || action === 'select') {
    const prepared = {
      kind: action,
      ...(params.text === undefined ? {} : { text: String(params.text).slice(0, 20_000) }),
      ...(params.value === undefined ? {} : { value: String(params.value).slice(0, 2_000) }),
    }
    let gate = await fastPrepare(tabId, params.expected || {}, prepared)
    // A hidden tab has no viewport and no input pipeline: the guard performs the action inside
    // the page and says so. Showing it first is still worth one try, because real input is the
    // better action whenever it is possible.
    if (gate?.reason === 'not-visible') {
      await showTab(tabId)
      gate = await fastPrepare(tabId, params.expected || {}, prepared)
    }
    if (!gate?.ok) {
      releaseActionWatch(tabId)
      return {
        acted: false,
        stale: true,
        reason: String(gate?.reason || 'stale'),
        ...(gate?.detail ? { detail: String(gate.detail).slice(0, 200) } : {}),
        ...(gate?.covering ? { covering: String(gate.covering).slice(0, 80) } : {}),
      }
    }
    if (gate.synthetic) {
      // Nothing to dispatch: the page already performed it, and the pointer would only be a
      // mark on a tab nobody is looking at.
      const observed = await settleFastAction(tabId)
      return { acted: true, synthetic: true, ...observed }
    }
    if (!hidePointer) await showPointer(tabId, { x: gate.x, y: gate.y, ...(gate.box ? { box: gate.box } : {}) })
    if (action === 'click') {
      await debuggerCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: gate.x, y: gate.y, button: 'left', clickCount: 1 })
      await debuggerCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: gate.x, y: gate.y, button: 'left', clickCount: 1 })
    } else if (action === 'type') {
      // The guard focused the field, and the text goes in through the browser's own input so
      // the page receives what a person's keyboard would have produced.
      if (params.clear !== false) await clearFocusedText(tabId)
      await debuggerCommand({ tabId }, 'Input.insertText', { text: String(params.text || '').slice(0, 20_000) })
    }
  } else if (action === 'keypress') {
    if (!hidePointer) await showPointer(tabId, {})
    await pressKey(tabId, String(params.key || ''))
  } else if (action === 'scroll') {
    const direction = String(params.direction || 'down'), amount = Math.max(1, Math.min(10, Number(params.amount) || 1))
    const x = 500, y = 400, distance = 620 * amount
    if (!hidePointer) await showPointer(tabId, { x, y })
    await debuggerCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y,
      deltaX: direction === 'left' ? -distance : direction === 'right' ? distance : 0,
      deltaY: direction === 'up' ? -distance : direction === 'down' ? distance : 0,
    })
  } else if (action === 'back') await tabsGoBack(tabId)
  else if (action === 'forward') await tabsGoForward(tabId)
  else if (action === 'reload') await tabsReload(tabId)
  else throw new Error(`Unsupported fast browser action: ${action}`)
  return { acted: true, ...(await settleFastAction(tabId)) }
}

/**
 * Whether Chrome is rendering this tab, read from the page itself.
 *
 * A tab created in the background is born hidden, and Chrome drops every injected click and
 * keystroke sent to a hidden tab without reporting anything: the caller sees a page that
 * never changes. Showing the tab is the repair, and it is needed once — after that the tab
 * stays drivable even while another tab is selected.
 */
async function tabVisibility(tabId) {
  const probe = await debuggerCommand({ tabId }, 'Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }).catch(() => null)
  return String(probe?.result?.value || '')
}

async function showTab(tabId) {
  // Selecting the tab is enough; the window is deliberately left where the user put it.
  await tabsUpdate(tabId, { active: true }).catch(() => {})
  await delay(120)
}

/** An empty string means input can land; anything else is the sentence to say instead. */
async function ensureTabReceivesInput(tabId) {
  const before = await tabVisibility(tabId)
  if (before === '' || before === 'visible') return ''
  await showTab(tabId)
  const after = await tabVisibility(tabId)
  return after === '' || after === 'visible' ? '' : 'Chrome is not showing that tab, so it does not deliver clicks or keys to it.'
}

/**
 * Performs an action from inside the page, for a tab Chrome is not rendering.
 *
 * The events are the ones a real input would have produced, dispatched by the page instead of
 * arriving through the browser's input pipeline, which is the only route a hidden tab has. The
 * answer says it was done this way: it is not real user input, and a native control may not
 * respond to it.
 */
async function actInPage(tabId, params) {
  const action = String(params.action || '')
  const nodeId = ['click', 'type', 'select', 'upload'].includes(action) ? checkedRef(params.ref) : 0
  const objectId = nodeId ? (await debuggerCommand({ tabId }, 'DOM.resolveNode', { backendNodeId: nodeId }))?.object?.objectId : undefined
  if (nodeId && !objectId) return false
  const body = {
    click: `function () {
      this.scrollIntoView && this.scrollIntoView({ block: 'center', inline: 'center' })
      const view = this.ownerDocument ? this.ownerDocument.defaultView : null
      const fire = (type, extra) => {
        const name = type.indexOf('pointer') === 0 ? 'PointerEvent' : 'MouseEvent'
        const Ctor = view && view[name] ? view[name] : null
        const event = Ctor ? new Ctor(type, { bubbles: true, cancelable: true, view: view, button: 0, detail: 1, ...(extra || {}) })
          : new Event(type, { bubbles: true, cancelable: true })
        this.dispatchEvent(event)
      }
      fire('pointerdown', { buttons: 1 }); fire('mousedown', { buttons: 1 })
      // One click event only: firing it here and calling this.click() runs the handler twice.
      fire('pointerup', { buttons: 0 }); fire('mouseup', { buttons: 0 }); fire('click', { buttons: 0 })
      return true
    }`,
    type: `function (text, clear) {
      this.focus && this.focus()
      const view = this.ownerDocument ? this.ownerDocument.defaultView : null
      const proto = view && view.HTMLTextAreaElement && this instanceof view.HTMLTextAreaElement
        ? view.HTMLTextAreaElement.prototype : view && view.HTMLInputElement ? view.HTMLInputElement.prototype : null
      const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null
      const next = clear ? text : String(this.value || '') + text
      if (setter && setter.set) setter.set.call(this, next)
      else if (this.isContentEditable) this.textContent = next
      else this.value = next
      this.dispatchEvent(new Event('input', { bubbles: true }))
      this.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }`,
    select: `function (value) {
      this.value = value
      this.dispatchEvent(new Event('input', { bubbles: true }))
      this.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }`,
  }[action]
  if (body) {
    const result = await debuggerCommand({ tabId }, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: body,
      arguments: action === 'type'
        ? [{ value: String(params.text || '').slice(0, 20_000) }, { value: params.clear !== false }]
        : action === 'select' ? [{ value: String(params.value || '').slice(0, 2_000) }] : [],
      returnByValue: true,
    }).catch(() => null)
    return result?.result?.value === true
  }
  if (action === 'scroll') {
    const direction = String(params.direction || 'down'), amount = Math.max(1, Math.min(10, Number(params.amount) || 1))
    const dy = (direction === 'up' ? -1 : direction === 'down' ? 1 : 0) * 620 * amount
    const dx = (direction === 'left' ? -1 : direction === 'right' ? 1 : 0) * 620 * amount
    const result = await debuggerCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(() => { window.scrollBy(${dx}, ${dy}); return true })()`, returnByValue: true,
    }).catch(() => null)
    return result?.result?.value === true
  }
  if (action === 'keypress') {
    const key = String(params.key || '')
    const result = await debuggerCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(() => {
        const target = document.activeElement || document.body
        const code = ${JSON.stringify(key)}
        for (const type of ['keydown', 'keyup']) {
          try { target.dispatchEvent(new KeyboardEvent(type, { key: code, code: code, bubbles: true, cancelable: true, view: window })) } catch {}
        }
        return true
      })()`, returnByValue: true,
    }).catch(() => null)
    return result?.result?.value === true
  }
  return false
}

/** Replaces whatever the focused field held, the way selecting all and typing would. */
async function clearFocusedText(tabId) {
  const platform = await platformInfo()
  const modifiers = platform.os === 'mac' ? 4 : 2
  await debuggerCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers })
  await debuggerCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers })
  await debuggerCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' })
  await debuggerCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' })
}

async function startDownload(tabId, backendNodeId) {
  const object = await debuggerCommand({ tabId }, 'DOM.resolveNode', { backendNodeId })
  const target = await debuggerCommand({ tabId }, 'Runtime.callFunctionOn', {
    objectId: object?.object?.objectId,
    functionDeclaration: `function() { const link = this instanceof HTMLAnchorElement ? this : this.closest?.('a[href]'); return link?.href || ''; }`,
    returnByValue: true,
  })
  return downloadsDownload({ url: checkedUrl(target?.result?.value), conflictAction: 'uniquify', saveAs: false })
}

async function waitForDownload(tabId, after, timeoutMs, downloadId) {
  const timeout = Math.max(1_000, Math.min(120_000, timeoutMs))
  const find = async () => {
    const items = await downloadsSearch(downloadId ? { id: downloadId } : {})
    return items
      .filter(item => (downloadId ? item.id === downloadId : item.tabId === tabId) && Date.parse(item.startTime || '') >= after - 1_000)
      .sort((a, b) => Date.parse(b.startTime || '') - Date.parse(a.startTime || ''))[0]
  }
  const initial = await find()
  if (initial?.state === 'complete' || initial?.state === 'interrupted') return downloadInfo(initial)
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => done(new Error('Timed out waiting for a Chrome download.')), timeout)
    const changed = () => { void find().then(item => {
      if (item?.state === 'complete' || item?.state === 'interrupted') done(undefined, downloadInfo(item))
    }, error => done(error)) }
    function done(error, item) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chrome.downloads.onChanged.removeListener(changed)
      if (error) reject(error)
      else resolve(item)
    }
    chrome.downloads.onChanged.addListener(changed)
    void changed()
  })
}

function downloadInfo(item) {
  return {
    id: item.id, filename: item.filename || '', url: item.finalUrl || item.url || '',
    mime: item.mime || '', bytesReceived: item.bytesReceived || 0, totalBytes: item.totalBytes || 0,
    state: item.state, error: item.error || '', startedAt: item.startTime || '', endedAt: item.endTime || '',
  }
}

async function pressKey(tabId, input) {
  const keys = {
    Enter: ['Enter', 'Enter', 13], Return: ['Enter', 'Enter', 13], Tab: ['Tab', 'Tab', 9], Escape: ['Escape', 'Escape', 27],
    Backspace: ['Backspace', 'Backspace', 8], ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowDown: ['ArrowDown', 'ArrowDown', 40],
    ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowRight: ['ArrowRight', 'ArrowRight', 39], Space: [' ', 'Space', 32],
  }
  const key = keys[input] || (input.length === 1 ? [input, `Key${input.toUpperCase()}`, input.charCodeAt(0)] : null)
  if (!key) throw new Error(`Unsupported key: ${input}`)
  await debuggerCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', key: key[0], code: key[1], windowsVirtualKeyCode: key[2], nativeVirtualKeyCode: key[2] })
  await debuggerCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: key[0], code: key[1], windowsVirtualKeyCode: key[2], nativeVirtualKeyCode: key[2] })
}

/**
 * `keepMarks` is the app saying "detach the debugger, this run is over, but the tab is still
 * mine". Without it the tab is genuinely given back and everything Shun put on it is returned.
 * Conflating the two is what made a continuous task flicker: every step detached, every detach
 * was read as a hand-back, so the mark was torn down and rebuilt between actions.
 */
async function release(tabId, closeTab, keepMarks) {
  if (!keepMarks) await unmarkTab(tabId)
  // Suspending between two steps of the same work keeps the debugger on the tab, because detaching
  // and re-attaching is what makes Chrome's "…is debugging this browser" bar appear and disappear
  // under the person's hands — and that bar changes the height of the page, so every measurement
  // taken across one of those flips describes a layout that no longer exists. A release that is a
  // real release still lets the tab go.
  if (!keepMarks && attachedTabs.has(tabId)) {
    try { await debuggerDetach({ tabId }) } catch {}
    attachedTabs.delete(tabId)
    refreshHeartbeat()
    diagnostics.delete(tabId)
  }
  if (closeTab) try { await tabsRemove(tabId) } catch {}
  return true
}

async function releaseAttachedTabs() {
  await Promise.allSettled([...attachedTabs].map(tabId => release(tabId, false)))
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId || !attachedTabs.has(source.tabId)) return
  const state = diagnostics.get(source.tabId) || { console: [], pageErrors: [] }
  if (method === 'Runtime.consoleAPICalled') {
    state.console.push({ level: params.type || 'log', message: (params.args || []).map(arg => arg.value ?? arg.description ?? '').join(' ').slice(0, 1_000), timestamp: Date.now() })
    state.console = state.console.slice(-80)
  } else if (method === 'Runtime.exceptionThrown') {
    state.pageErrors.push({ message: String(params.exceptionDetails?.text || params.exceptionDetails?.exception?.description || 'Uncaught exception').slice(0, 1_000), timestamp: Date.now() })
    state.pageErrors = state.pageErrors.slice(-50)
  } else if (method === 'Network.loadingFailed' && params.type === 'Document') {
    state.pageErrors.push({ message: String(params.errorText || 'Document load failed').slice(0, 1_000), timestamp: Date.now() })
    state.pageErrors = state.pageErrors.slice(-50)
  }
  diagnostics.set(source.tabId, state)
})

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!source.tabId) return
  attachedTabs.delete(source.tabId)
  diagnostics.delete(source.tabId)
  send({ type: 'event', event: 'tab.detached', params: { tabId: source.tabId, reason } })
})

const WAKE_URL = /^http:\/\/127\.0\.0\.1:\d+\/shun-wake(?:\?|$)/

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  const url = String(change.url || tab.url || '')
  // Shun opens this address when its bridge comes up, because a tab event is the
  // one thing that reaches a suspended worker. Nothing should ever render: the tab
  // is closed here and the connection is rebuilt immediately.
  if (WAKE_URL.test(url)) {
    void tabsRemove(tabId).catch(() => {})
    connect(true)
    return
  }
  if (!attachedTabs.has(tabId)) return
  send({ type: 'event', event: 'tab.updated', params: { tabId, url: change.url || tab.url, title: change.title || tab.title } })
})

chrome.tabs.onRemoved.addListener(tabId => {
  attachedTabs.delete(tabId)
  diagnostics.delete(tabId)
  send({ type: 'event', event: 'tab.closed', params: { tabId } })
})

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'status') {
    respond({ connected: socket?.readyState === WebSocket.OPEN, attachedTabs: attachedTabs.size })
    return
  }
  if (message?.type === 'connect') {
    connect(message.force === true)
    respond({ started: true })
  }
})

// Manifest V3 workers may be suspended while Shun is closed. A Chrome alarm
// wakes the worker after Shun restarts, while connect() remains idempotent when
// the bridge is already healthy.
// A suspended worker is only woken by an event, and the alarm is the only one that
// arrives when nothing else is happening. Chrome rejects a period below its own
// minimum, and a silently missing alarm is a worker that never comes back, so a
// rejection falls back to Chrome's own floor instead of leaving nothing armed.
function armReconnectAlarm() {
  const periods = [0.5, 1]
  const arm = index => {
    try {
      const created = chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: periods[index] })
      if (created && typeof created.catch === 'function') created.catch(() => { if (index + 1 < periods.length) arm(index + 1) })
    } catch { if (index + 1 < periods.length) arm(index + 1) }
  }
  arm(0)
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RECONNECT_ALARM) connect()
  else if (alarm.name === MARK_SWEEP_ALARM) void sweepActionIcons()
})
armReconnectAlarm()

function waitForTab(tabId, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(done, timeoutMs)
    function updated(id, change) { if (id === tabId && change.status === 'complete') done() }
    function done() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(updated); resolve() }
    chrome.tabs.onUpdated.addListener(updated)
  })
}

function tabInfo(tab) { return { id: tab.id, title: tab.title || '', url: tab.url || '', active: Boolean(tab.active), windowId: tab.windowId } }
function propertyValue(value) { return value?.value }
function checkedTabId(value) { const tabId = Number(value); if (!Number.isSafeInteger(tabId) || tabId <= 0) throw new Error('Invalid Chrome tab ID.'); return tabId }
function checkedRef(value) { const ref = Number(value); if (!Number.isSafeInteger(ref) || ref <= 0) throw new Error('Use a fresh numeric ref from browser_snapshot.'); return ref }
function checkedUrl(value) { const url = new URL(String(value || '')); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) URLs without embedded credentials are supported.'); return url.href }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

// An action has to be given the beat it caused before the next snapshot means
// anything, but a flat wait charges every action its worst case: 350ms of dead time
// per action is half of a 700ms interaction budget spent deciding nothing, and a
// keystroke on a canvas needs one beat, not twenty. The page counts what changes and
// the wait ends when the page stops changing. The ceiling keeps the worst case the
// flat wait gave it. The poll is driven from here rather than from the page, because a
// background tab throttles its own timers and paints no frames at all.
const ACTION_SETTLE_CEILING_MS = 350
const ACTION_SETTLE_POLL_MS = 16
const ACTION_SETTLE_QUIET_MS = 32
const ACTION_SETTLE_STATE = '__shunActionSettle'

// One round trip: the shared counter, and the page's own answer to whether it is
// still loading.
function readSettleState(tabId, body = '') {
  return debuggerCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(() => { const state = globalThis.${ACTION_SETTLE_STATE} || (globalThis.${ACTION_SETTLE_STATE} = { mutations: 0, observer: null, watching: false }); ${body} return { mutations: state.mutations, readyState: document.readyState } })()`,
    returnByValue: true,
  })
}

// Watching starts before the action, so a handler that runs with the event is a change
// this action caused rather than something already true about the page.
function watchActionChanges(tabId) {
  return readSettleState(tabId, `if (!state.watching) { state.watching = true; state.mutations = 0; try { state.observer = new MutationObserver(records => { for (const record of records) { const target = record.target; if (target && target.closest && (target.closest('[${OVERLAY_ATTR}]') || target.closest('[data-shun-borrowed]') || target.closest('[data-shun-marker]'))) continue; state.mutations += 1 } }); state.observer.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true }) } catch {} }`).catch(() => {})
}

function releaseActionWatch(tabId) {
  void readSettleState(tabId, `state.watching = false; try { state.observer?.disconnect() } catch {}`).catch(() => {})
}

async function settledAfterAction(tabId) {
  await waitForPageToSettle(tabId)
}

/**
 * Waits for the page to stop changing, up to the ceiling. A page that never answers is not a
 * reason to read it early: it falls back to the wait this replaced.
 */
async function waitForPageToSettle(tabId) {
  const started = Date.now()
  let quiet = 0
  let seen = -1
  while (Date.now() - started < ACTION_SETTLE_CEILING_MS) {
    await delay(ACTION_SETTLE_POLL_MS)
    let probe
    try { probe = await readSettleState(tabId) } catch { break }
    const value = probe?.result?.value
    if (!value) break
    quiet = value.mutations === seen && value.readyState === 'complete' ? quiet + ACTION_SETTLE_POLL_MS : 0
    seen = value.mutations
    if (quiet >= ACTION_SETTLE_QUIET_MS) { releaseActionWatch(tabId); return }
  }
  // A page that never answered is not a reason to read it early: fall back to the
  // wait this replaced.
  const remaining = ACTION_SETTLE_CEILING_MS - (Date.now() - started)
  if (remaining > 0) await delay(remaining)
  releaseActionWatch(tabId)
}

/**
 * What the person watching the tab sees. A task driving Chrome through a debugger
 * otherwise looks like a page moving by itself: no pointer anywhere, and nothing that
 * says which of the open tabs is the one being used. Both belong to the interface rather
 * than to the page, so neither may reach the page's styles, its own observers, or the
 * accessibility tree Shun reads back.
 *
 * The pointer lives in a closed shadow root: page CSS cannot restyle it, a page's own
 * MutationObserver never sees it, and the "has the page stopped changing" question is
 * never answered by Shun's own animation. It is aria-hidden, has no accessible name, and
 * ignores pointer events, so snapshots, state fingerprints, and click hit-testing are
 * exactly what they were before it existed.
 */
const OVERLAY_STATE = '__shunOverlay'
const TAB_MARKER_STATE = '__shunTabMarker'
/** Reported into the page console once per attached tab, so which build is running is readable. */
const EXTENSION_VERSION = (() => { try { return chrome.runtime.getManifest().version } catch { return 'unknown' } })()
/**
 * The tab mark. Chrome's tab strip paints one frame of a favicon and never animates it, so a
 * pulsing icon has to be moved by hand: the extension walks these frames while it drives a tab.
 * A frame swap is a <head> mutation, which is exactly what the loop's "has the page stopped
 * changing" question watches, so the links Shun borrows carry a marker attribute and the observer
 * ignores changes to them — Shun's own animation never answers Shun's own question.
 */
function markerIcon(turn, ringRadius, ringOpacity) {
  return `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#4f46e5"/><g transform="rotate(' + turn + ' 16 16)"><circle cx="16" cy="16" r="' + ringRadius + '" fill="none" stroke="#c7d2fe" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="30 14" opacity="' + ringOpacity + '"/></g><circle cx="16" cy="16" r="3.4" fill="#ffffff"/></svg>')}`
}
/**
 * The frames that ring turns through. A ring that moves is what says the tab is being driven; the
 * single frame the mark used to be said only that Shun had claimed the tab, which is just as true
 * of a run that stopped an hour ago — the person is left looking at a tab that claims to be busy
 * and is not.
 */
const MARK_FRAMES = 8
const TAB_MARKER_FRAMES = Array.from({ length: MARK_FRAMES }, (_, index) => markerIcon((360 / MARK_FRAMES) * index, 7, 0.95))
const TAB_MARKER_ICON = TAB_MARKER_FRAMES[0]
/**
 * A mark means Shun is driving this tab now, and driving is measured as requests. A tab nobody has
 * touched for this long is not being driven, so its marks come off — the page gets its own icon
 * back, the badge clears, the pointer fades — and the next request puts them back. The window has
 * to cover a model thinking between two calls of the same piece of work, which is tens of seconds;
 * what it must not do is leave a finished task's pointer on somebody's page indefinitely.
 */
const MARK_IDLE_MS = 60_000
/** One frame every this long: a turn is MARK_FRAMES frames, which reads as motion. */
const MARK_FRAME_MS = 150

/**
 * What a person watching the tab sees: a solid point with a hairline ring, the control that is
 * about to be used, and the key being pressed. It is built from plain inline-styled elements
 * inside one aria-hidden host rather than a shadow root with a stylesheet, because a page's
 * Content-Security-Policy applies to that stylesheet (GitHub's does, and so does the fixture the
 * overlay was tested against): a blocked stylesheet leaves an overlay with no size and no colour —
 * invisible, with nothing in the console to say why. Every property is therefore written through
 * the CSSOM, which no CSP restricts, and the motion uses the Web Animations API for the same
 * reason. The host lives under <html>, never <body>, so the page's own innerText — which the
 * decision state and the change fingerprint are read from — is untouched.
 */
const OVERLAY_ATTR = 'data-shun-overlay'
const OVERLAY_DOT_COLOR = '#4f46e5'
const OVERLAY_TARGET_COLOR = 'rgba(99, 102, 241, .85)'
/**
 * The pointer outlives a run. Removing it at the end of each run is what made it teleport: the
 * next action built a new overlay at its new position instead of sliding the existing one, so a
 * person saw a dot appear, never a trajectory. It leaves when the page itself is replaced.
 */
const OVERLAY_BREATHE_MS = 2400
/**
 * How long the pointer takes to travel to the next control. It was 150ms, which read as a jump:
 * a move that fast is over before the eye has followed it. Half a second is a move you can watch.
 */
const OVERLAY_GLIDE_MS = 550
/** Where the pointer was on each tab, so a re-created pointer never starts from nowhere. */
const lastPointerAt = new Map()
/**
 * A takeover is per call, so withdrawing on release meant the pointer was torn down and rebuilt
 * between two actions of the same piece of work: it kept reappearing in the middle of the page.
 * It leaves when the work has actually stopped, and any new action cancels that.
 */
const OVERLAY_IDLE_WITHDRAW_MS = 8000
/**
 * The page's own lifetime for a mark, a little longer than the extension's idle window so the
 * extension normally does the tidying. The page is the backstop because it is the only place that
 * still exists when the worker has been suspended, when Shun has quit, and when a document is
 * restored from the back/forward cache carrying marks that nothing is refreshing any more.
 */
const PAGE_MARK_IDLE_MS = MARK_IDLE_MS + OVERLAY_IDLE_WITHDRAW_MS
const idleWithdrawTimers = new Map()

function styled(tag, rules) {
  const element = document.createElement(tag)
  for (const [property, value] of Object.entries(rules)) element.style[property] = value
  return element
}

/**
 * One evaluate per action: place the pointer where the action will land, ring the control it is
 * about to use, show the key it is pressing, and pulse.
 */
function pointerExpression(step) {
  const at = step.x === undefined || step.y === undefined ? 'null' : `{ x: ${Math.round(step.x)}, y: ${Math.round(step.y)} }`
  const from = step.from === undefined ? 'null' : `{ x: ${Math.round(step.from.x)}, y: ${Math.round(step.from.y)} }`
  const rect = step.box === undefined ? 'null' : `{ x: ${Math.round(step.box.x)}, y: ${Math.round(step.box.y)}, w: ${Math.round(step.box.width)}, h: ${Math.round(step.box.height)} }`
  const label = step.label || ''
  return `(() => { try {
  const build = ${styled.toString()}
  const state = globalThis.${OVERLAY_STATE} || (globalThis.${OVERLAY_STATE} = {})
  if (!state.host || !state.host.isConnected) {
    // The halo is the point of this design: it lands on the control being used, so the page
    // says what is being operated instead of a widget floating beside it.
    const host = build('div', { position: 'fixed', left: '0px', top: '0px', width: '0px', height: '0px', zIndex: '2147483647', pointerEvents: 'none' })
    host.setAttribute('${OVERLAY_ATTR}', '')
    host.setAttribute('aria-hidden', 'true')
    const halo = build('div', { position: 'fixed', left: '-9999px', top: '-9999px', width: '0px', height: '0px', borderRadius: '14px', opacity: '0', transition: 'opacity 180ms ease', background: 'rgba(99, 102, 241, .05)', boxShadow: '0 0 0 2px rgba(129, 140, 248, .9), 0 0 0 10px rgba(99, 102, 241, .10), 0 10px 30px rgba(79, 70, 229, .28)' })
    const pointer = build('div', { position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px', transition: 'transform ' + ${OVERLAY_GLIDE_MS} + 'ms cubic-bezier(.22,.85,.25,1)' })
    // Solid indigo with a white edge: a white dot is invisible on a white page, which is exactly
    // where most of a browsing session happens.
    const core = build('div', { position: 'absolute', left: '-6px', top: '-6px', width: '12px', height: '12px', borderRadius: '50%', background: '#4f46e5', boxShadow: '0 0 0 2px rgba(255, 255, 255, .95), 0 2px 10px rgba(79, 70, 229, .5)' })
    // A light that keeps breathing, so the pointer is findable between actions instead of only
    // announcing itself at the instant of a click.
    const glow = build('div', { position: 'absolute', left: '-16px', top: '-16px', width: '32px', height: '32px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(99, 102, 241, .5), rgba(99, 102, 241, .16) 45%, rgba(99, 102, 241, 0) 72%)' })
    glow.animate([{ transform: 'scale(.85)', opacity: '.55' }, { transform: 'scale(1.12)', opacity: '.95' }, { transform: 'scale(.85)', opacity: '.55' }], { duration: ${OVERLAY_BREATHE_MS}, iterations: Infinity, easing: 'ease-in-out' })
    // Two staggered rings leaving the exact point is what makes a click read as a click: the
    // first says where, the second says the press landed. Both are one-shot and cleanup-free.
    const rippleOuter = build('div', { position: 'absolute', left: '-15px', top: '-15px', width: '30px', height: '30px', borderRadius: '50%', border: '1.5px solid rgba(129, 140, 248, .9)', opacity: '0' })
    const rippleInner = build('div', { position: 'absolute', left: '-15px', top: '-15px', width: '30px', height: '30px', borderRadius: '50%', border: '1.5px solid rgba(165, 180, 252, .8)', opacity: '0' })
    pointer.appendChild(glow); pointer.appendChild(rippleOuter); pointer.appendChild(rippleInner); pointer.appendChild(core)
    host.appendChild(halo); host.appendChild(pointer)
    ;(document.documentElement || document.body).appendChild(host)
    state.host = host; state.halo = halo; state.pointer = pointer; state.core = core; state.rippleOuter = rippleOuter; state.rippleInner = rippleInner; state.glow = glow
  }
  const { pointer, halo, core, rippleOuter, rippleInner } = state
  const at = ${at}
  const from = ${from}
  const rect = ${rect}
  const place = (position) => { pointer.style.transform = 'translate(' + position.x + 'px, ' + position.y + 'px)' }
  const fallback = { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2 + 60) }
  if (at) {
    if (!state.placed) {
      // A freshly built element has no previous value to transition from, so it is put down where
      // the pointer already was and moved on the next frame: that gap is what makes it a travel.
      place(from || fallback)
      requestAnimationFrame(() => place(at))
    } else {
      place(at)
    }
    state.position = at
  } else if (!state.placed) {
    // Even a step with no target of its own resumes from the last known position.
    place(from || fallback)
  }
  state.placed = true
  if (rect) {
    halo.style.left = (rect.x - 7) + 'px'
    halo.style.top = (rect.y - 7) + 'px'
    halo.style.width = (rect.w + 14) + 'px'
    halo.style.height = (rect.h + 14) + 'px'
    halo.style.opacity = '1'
  } else {
    halo.style.opacity = '0'
  }
  const EASE_OUT = 'cubic-bezier(.16,.84,.24,1)'
  for (const element of [core, rippleOuter, rippleInner]) for (const running of element.getAnimations()) running.cancel()
  // Press, then a small overshoot on the way back: it reads as a hand, not a toggle.
  core.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(.62)', offset: .22 }, { transform: 'scale(1.18)', offset: .58 }, { transform: 'scale(1)' }],
    { duration: 440, easing: 'cubic-bezier(.22,1.1,.3,1)' },
  )
  rippleOuter.animate(
    [{ transform: 'scale(.3)', opacity: '.9' }, { transform: 'scale(2.3)', opacity: '0' }],
    { duration: 560, easing: EASE_OUT },
  )
  rippleInner.animate(
    [{ transform: 'scale(.3)', opacity: '.75' }, { transform: 'scale(1.5)', opacity: '0' }],
    { duration: 460, delay: 110, easing: EASE_OUT },
  )
  if (rect) {
    for (const running of halo.getAnimations()) running.cancel()
    // The ring grips the control it is about to use: a hair tighter, brighter, then settled.
    halo.animate([
      { transform: 'scale(1)', boxShadow: '0 0 0 2px rgba(129, 140, 248, .9), 0 0 0 10px rgba(99, 102, 241, .10), 0 10px 30px rgba(79, 70, 229, .28)' },
      { transform: 'scale(.985)', boxShadow: '0 0 0 3px rgba(165, 180, 252, 1), 0 0 0 15px rgba(99, 102, 241, .16), 0 12px 34px rgba(79, 70, 229, .34)', offset: .34 },
      { transform: 'scale(1.004)', boxShadow: '0 0 0 2px rgba(129, 140, 248, .95), 0 0 0 11px rgba(99, 102, 241, .12), 0 10px 30px rgba(79, 70, 229, .3)', offset: .68 },
      { transform: 'scale(1)', boxShadow: '0 0 0 2px rgba(129, 140, 248, .9), 0 0 0 10px rgba(99, 102, 241, .10), 0 10px 30px rgba(79, 70, 229, .28)' },
    ], { duration: 540, easing: 'cubic-bezier(.2,.9,.25,1)' })
  }
  // The mark lives in the page, so the page is what gives it back. Nothing keeps this timer
  // alive but Shun acting on this document: a suspended worker has no timers of its own, a Shun
  // that quit stops asking for anything, and a document Chrome restores from the back/forward
  // cache arrives with the mark it was carrying and nothing that would ever take it off. It is
  // refreshed by every action, and it takes off both what this page shows and what it borrowed.
  clearTimeout(state.lifetime)
  state.lifetime = setTimeout(() => { try {
    const host = state.host
    if (host && host.isConnected) {
      host.style.transition = 'opacity 400ms ease'
      host.style.opacity = '0'
      setTimeout(() => { if (globalThis.${OVERLAY_STATE} && globalThis.${OVERLAY_STATE}.host === host) { host.remove(); delete globalThis.${OVERLAY_STATE} } }, 480)
    }
    const marker = globalThis.${TAB_MARKER_STATE}
    if (marker) {
      for (const entry of marker.borrowed || []) {
        const link = entry.link
        if (!link || !link.isConnected) continue
        if (entry.href === null) link.removeAttribute('href')
        else link.setAttribute('href', entry.href)
        if (entry.type === null) link.removeAttribute('type')
        else link.setAttribute('type', entry.type)
        if (entry.sizes === null) link.removeAttribute('sizes')
        else link.setAttribute('sizes', entry.sizes)
        if (entry.tag === null) link.removeAttribute('data-shun-borrowed')
        else link.setAttribute('data-shun-borrowed', entry.tag)
      }
      if (marker.added) marker.added.remove()
      for (const link of document.querySelectorAll('link[data-shun-marker]')) link.remove()
      delete globalThis.${TAB_MARKER_STATE}
    }
  } catch {} }, ${PAGE_MARK_IDLE_MS})
  console.log('[shun] pointer ' + ${JSON.stringify(EXTENSION_VERSION)} + ' at ' + (at ? at.x + ',' + at.y : 'kept') + (rect ? ' target ' + rect.w + 'x' + rect.h : ''))
  return true
} catch (error) { try { console.error('[shun] pointer failed: ' + (error && error.message ? error.message : error)) } catch {} return false } })()`
}

/**
 * The tab strip is how a person sees which of several open tabs a task is using, and the
 * tab's own icon is the only part of that strip a page can speak to. Shun borrows it: every
 * icon the page declared keeps its href remembered and is pointed at Shun's dot instead,
 * because a second icon added on top of the page's own is what Chrome is free to ignore.
 * Giving it back restores exactly what was there, including a page that had no icon at all.
 */
function markerExpression() {
  return `(() => { try {
  const state = globalThis.${TAB_MARKER_STATE} || (globalThis.${TAB_MARKER_STATE} = { borrowed: [], added: null })
  const icon = ${JSON.stringify(TAB_MARKER_ICON)}
  if (!state.borrowed.length && !state.added) {
    for (const link of document.querySelectorAll('link[rel~="icon" i]')) {
      state.borrowed.push({ link, href: link.getAttribute('href'), type: link.getAttribute('type'), sizes: link.getAttribute('sizes'), tag: link.getAttribute('data-shun-borrowed') })
      link.setAttribute('data-shun-borrowed', '')
    }
    if (!state.borrowed.length) {
      const link = document.createElement('link')
      link.rel = 'icon'
      link.setAttribute('data-shun-marker', '')
      ;(document.head || document.documentElement).appendChild(link)
      state.added = link
    }
  }
  for (const entry of state.borrowed) {
    if (!entry.link.isConnected) continue
    entry.link.setAttribute('type', 'image/svg+xml')
    entry.link.removeAttribute('sizes')
    entry.link.setAttribute('href', icon)
  }
  if (state.added) {
    state.added.setAttribute('type', 'image/svg+xml')
    state.added.setAttribute('sizes', 'any')
    state.added.setAttribute('href', icon)
  }
  console.log('[shun] tab marked · extension ' + ${JSON.stringify(EXTENSION_VERSION)})
  return true
} catch (error) { try { console.error('[shun] tab mark failed: ' + (error && error.message ? error.message : error)) } catch {} return false } })()`
}

/** Dims the pointer and takes it off the page once it has faded. */
function withdrawOverlayExpression() {
  return `(() => {
  const state = globalThis.${OVERLAY_STATE}
  const host = state && state.host
  if (!host || !host.isConnected) return false
  host.style.transition = 'opacity 400ms ease'
  host.style.opacity = '0'
  setTimeout(() => {
    if (globalThis.${OVERLAY_STATE} && globalThis.${OVERLAY_STATE}.host === host) {
      host.remove()
      delete globalThis.${OVERLAY_STATE}
    }
  }, 480)
  return true
})()`
}

/** Gives the page its own tab icon back, exactly as declared. */
function restoreTabIconExpression() {
  return `(() => {
  const marker = globalThis.${TAB_MARKER_STATE}
  if (marker) {
    for (const entry of marker.borrowed || []) {
      const link = entry.link
      if (!link || !link.isConnected) continue
      if (entry.href === null) link.removeAttribute('href')
      else link.setAttribute('href', entry.href)
      if (entry.type === null) link.removeAttribute('type')
      else link.setAttribute('type', entry.type)
      if (entry.sizes === null) link.removeAttribute('sizes')
      else link.setAttribute('sizes', entry.sizes)
      if (entry.tag === null) link.removeAttribute('data-shun-borrowed')
      else link.setAttribute('data-shun-borrowed', entry.tag)
    }
    if (marker.added) marker.added.remove()
  }
  for (const link of document.querySelectorAll('link[data-shun-marker]')) link.remove()
  delete globalThis.${TAB_MARKER_STATE}
  return true
})()`
}

/** One evaluate takes both marks back — including the page's own tab icon, exactly as it was. */
function clearPageMarksExpression() {
  return `(() => {
  for (const element of document.querySelectorAll('[${OVERLAY_ATTR}]')) element.remove()
  delete globalThis.${OVERLAY_STATE}
  const marker = globalThis.${TAB_MARKER_STATE}
  if (marker) {
    for (const entry of marker.borrowed || []) {
      const link = entry.link
      if (!link || !link.isConnected) continue
      if (entry.href === null) link.removeAttribute('href')
      else link.setAttribute('href', entry.href)
      if (entry.type === null) link.removeAttribute('type')
      else link.setAttribute('type', entry.type)
      if (entry.sizes === null) link.removeAttribute('sizes')
      else link.setAttribute('sizes', entry.sizes)
      if (entry.tag === null) link.removeAttribute('data-shun-borrowed')
      else link.setAttribute('data-shun-borrowed', entry.tag)
    }
    if (marker.added) marker.added.remove()
  }
  for (const link of document.querySelectorAll('link[data-shun-marker]')) link.remove()
  delete globalThis.${TAB_MARKER_STATE}
  return true
})()`
}



/**
 * The same turning ring on the toolbar. `setIcon` takes an image, so the frames are files the build
 * drew. The worker cannot draw them itself: its canvas threw inside a caught block, and the first
 * run of this animation through a real worker showed the tab strip turning while the toolbar icon
 * stayed still — which is exactly what that failure looks like from the outside.
 */
const ACTION_FRAME_PATHS = Array.from({ length: MARK_FRAMES }, (_, index) => `icons/mark-${index + 1}.png`)

async function showActionFrame(tabId, index) {
  await chrome.action.setIcon({ tabId, path: ACTION_FRAME_PATHS[index % MARK_FRAMES] })
}

/** The extension's own icon, which is what the toolbar shows when nothing is being driven. */
async function restoreActionIcon(tabId) {
  await chrome.action.setIcon({ tabId, path: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' } })
}

/** The tab mark, moved by hand: one attribute write per frame, and nothing else on the page. */
function markerFrameExpression(icon) {
  return `(() => { try {
  const state = globalThis.${TAB_MARKER_STATE}
  if (!state) return false
  for (const entry of state.borrowed) {
    if (!entry.link.isConnected) continue
    entry.link.setAttribute('href', ${JSON.stringify(icon)})
  }
  if (state.added) state.added.setAttribute('href', ${JSON.stringify(icon)})
  return true
} catch { return false } })()`
}

// A tab is marked once per attachment, so the mark cannot become a per-action cost.
const markedTabs = new Set()
/** When each marked tab was last asked to do something, which is what a mark means. */
const markActivity = new Map()
let markFrame = 0
let markTimer = null

function noteTabActivity(tabId) {
  markActivity.set(tabId, Date.now())
  if (markedTabs.has(tabId)) startMarkAnimation()
}

function startMarkAnimation() {
  if (markTimer || !markedTabs.size) return
  markTimer = setInterval(() => { void stepMarks() }, MARK_FRAME_MS)
}

function stopMarkAnimation() {
  if (!markTimer) return
  clearInterval(markTimer)
  markTimer = null
  markFrame = 0
}

async function stepMarks() {
  const now = Date.now()
  for (const tabId of [...markedTabs]) {
    if (now - (markActivity.get(tabId) ?? 0) >= MARK_IDLE_MS) {
      markActivity.delete(tabId)
      await unmarkTab(tabId)
      continue
    }
    markFrame = (markFrame + 1) % MARK_FRAMES
    await Promise.allSettled([
      debuggerCommand({ tabId }, 'Runtime.evaluate', { expression: markerFrameExpression(TAB_MARKER_FRAMES[markFrame]), returnByValue: true }),
      showActionFrame(tabId, markFrame),
    ])
  }
  if (!markedTabs.size) stopMarkAnimation()
}

/**
 * The marks have to come off even when the worker is not awake to take them off. A worker Chrome
 * has suspended has no timers at all, so neither the animation nor the idle check runs and the
 * toolbar keeps the icon it was left on. An alarm is the one thing Chrome delivers to a worker that
 * is otherwise asleep, so one is armed while tabs are marked and cleared once none are.
 */
async function armMarkSweep() {
  try { await chrome.alarms.create(MARK_SWEEP_ALARM, { periodInMinutes: 1 }) } catch {}
}

async function disarmMarkSweep() {
  try { await chrome.alarms.clear(MARK_SWEEP_ALARM) } catch {}
}

/** Tabs that are still driven keep their own icon; every other tab gets the extension's back. */
async function sweepActionIcons() {
  try {
    for (const tab of await tabsQuery({})) {
      if (!tab.id || markedTabs.has(tab.id)) continue
      await restoreActionIcon(tab.id)
    }
  } catch {}
  if (!markedTabs.size) await disarmMarkSweep()
}

async function markTab(tabId) {
  if (markedTabs.has(tabId)) return
  markedTabs.add(tabId)
  markActivity.set(tabId, Date.now())
  await debuggerCommand({ tabId }, 'Runtime.evaluate', { expression: markerExpression(), returnByValue: true }).catch(() => {})
  // It is on the page before the first action, at a neutral spot, so a person sees where it is
  // and then watches it move — instead of watching a pointer appear out of nowhere.
  await showPointer(tabId, {})
  try {
    // The icon itself is the loading animation, so the old static dot badge would only be a
    // second, contradictory answer to the same question.
    await chrome.action.setBadgeText({ tabId, text: '' })
    await showActionFrame(tabId, 0)
  } catch {}
  startMarkAnimation()
  void armMarkSweep()
}

async function unmarkTab(tabId) {
  markedTabs.delete(tabId)
  markActivity.delete(tabId)
  if (!markedTabs.size) { stopMarkAnimation(); void disarmMarkSweep() }
  await debuggerCommand({ tabId }, 'Runtime.evaluate', { expression: restoreTabIconExpression(), returnByValue: true }).catch(() => {})
  // Not now: the pointer leaves once the work has been quiet for a while, so a piece of work made
  // of several calls keeps one pointer that travels, instead of rebuilding it between actions.
  const pending = idleWithdrawTimers.get(tabId)
  if (pending) clearTimeout(pending)
  idleWithdrawTimers.set(tabId, setTimeout(() => {
    idleWithdrawTimers.delete(tabId)
    void debuggerCommand({ tabId }, 'Runtime.evaluate', { expression: withdrawOverlayExpression(), returnByValue: true }).catch(() => {})
  }, OVERLAY_IDLE_WITHDRAW_MS))
  try {
    await chrome.action.setBadgeText({ tabId, text: '' })
    await restoreActionIcon(tabId)
  } catch {}
}

function showPointer(tabId, step) {
  const pending = idleWithdrawTimers.get(tabId)
  if (pending) { clearTimeout(pending); idleWithdrawTimers.delete(tabId) }
  const from = lastPointerAt.get(tabId)
  if (step.x !== undefined && step.y !== undefined) lastPointerAt.set(tabId, { x: step.x, y: step.y })
  return debuggerCommand({ tabId }, 'Runtime.evaluate', { expression: pointerExpression({ ...step, ...(from ? { from } : {}) }), returnByValue: true }).catch(() => {})
}

/**
 * A caller may set the pointer aside for exactly one operation — a screenshot that should
 * show the page as it is, an operation the pointer would obscure. The scope is that one
 * call: nothing is remembered, so a failed operation cannot leave the pointer gone.
 */
function pointerVisibleExpression(visible) {
  return `(() => {
  const state = globalThis.${OVERLAY_STATE}
  if (!state || !state.host) return false
  state.host.style.display = ${visible ? "''" : "'none'"}
  return true
})()`
}

function setPointerVisible(tabId, visible) {
  return debuggerCommand({ tabId }, 'Runtime.evaluate', { expression: pointerVisibleExpression(visible), returnByValue: true }).catch(() => {})
}

/** The viewport box of a control, so the pointer can ring what it is about to act on. */
function boxFromQuad(quad) {
  if (!Array.isArray(quad) || quad.length < 8) return undefined
  const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]]
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/** A control an action names gets the pointer put on it, not just near it. */
async function pointerAtNode(tabId, backendNodeId) {
  const model = await debuggerCommand({ tabId }, 'DOM.getBoxModel', { backendNodeId }).catch(() => null)
  const quad = model?.model?.content || model?.model?.border
  const box = boxFromQuad(quad)
  if (!box) return showPointer(tabId, {})
  return showPointer(tabId, { x: box.x + box.width / 2, y: box.y + box.height / 2, box })
}

function callbackCall(target, method, ...args) {
  return new Promise((resolve, reject) => target[method](...args, result => {
    const error = chrome.runtime.lastError
    if (error) reject(new Error(error.message))
    else resolve(result)
  }))
}

const debuggerAttach = (...args) => callbackCall(chrome.debugger, 'attach', ...args)
const debuggerDetach = (...args) => callbackCall(chrome.debugger, 'detach', ...args)
const debuggerCommand = (...args) => callbackCall(chrome.debugger, 'sendCommand', ...args)
const tabsQuery = (...args) => callbackCall(chrome.tabs, 'query', ...args)
const tabsCreate = (...args) => callbackCall(chrome.tabs, 'create', ...args)
const tabsGet = (...args) => callbackCall(chrome.tabs, 'get', ...args)
const tabsUpdate = (...args) => callbackCall(chrome.tabs, 'update', ...args)
const tabsRemove = (...args) => callbackCall(chrome.tabs, 'remove', ...args)
const tabsGoBack = (...args) => callbackCall(chrome.tabs, 'goBack', ...args)
const tabsGoForward = (...args) => callbackCall(chrome.tabs, 'goForward', ...args)
const tabsReload = (...args) => callbackCall(chrome.tabs, 'reload', ...args)
const downloadsSearch = (...args) => callbackCall(chrome.downloads, 'search', ...args)
const downloadsDownload = (...args) => callbackCall(chrome.downloads, 'download', ...args)
const windowsUpdate = (...args) => callbackCall(chrome.windows, 'update', ...args)
const platformInfo = () => callbackCall(chrome.runtime, 'getPlatformInfo')

setStatus(false)
connect()
// A worker Chrome suspended while a tab was marked comes back with no memory of that tab, so the
// toolbar would keep whatever frame it was left on. The same sweep the alarm runs does this at
// worker start, and it skips whatever is being driven right now, so a worker that woke up because
// a mark was being applied does not wipe that mark's icon.
void sweepActionIcons()
// Only a freshly connected worker has a reason to look for an earlier bridge; the
// probe stops after a few rounds instead of ticking for the life of the worker.
setInterval(preferEarlierServer, PROBE_SPACING_MS)

// A browser or profile restart registers the alarm again and reconnects without
// waiting for the next alarm tick.
chrome.runtime.onStartup.addListener(() => connect())
chrome.runtime.onInstalled.addListener(() => connect())
