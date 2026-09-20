const PORTS = Array.from({ length: 10 }, (_, index) => 32124 + index)
const PROTOCOL_VERSION = '1.3'
const RECONNECT_ALARM = 'shun-browser-use-reconnect'

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
  switch (method) {
    case 'tabs.list': return (await tabsQuery({})).map(tabInfo).filter(tab => tab.id && /^https?:\/\//i.test(tab.url || ''))
    case 'tabs.create': return tabInfo(await tabsCreate({ url: checkedUrl(params.url), active: Boolean(params.active) }))
    case 'tab.attach': return attach(checkedTabId(params.tabId))
    case 'tab.activate': return activate(checkedTabId(params.tabId))
    case 'tab.navigate': return navigate(checkedTabId(params.tabId), checkedUrl(params.url))
    case 'tab.snapshot': return snapshot(checkedTabId(params.tabId), Boolean(params.screenshot))
    case 'tab.act': return act(checkedTabId(params.tabId), params)
    case 'tab.release': return release(checkedTabId(params.tabId), Boolean(params.closeTab))
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

async function snapshot(tabId, includeScreenshot) {
  await attach(tabId)
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
  const described = await debuggerCommand({ tabId }, 'Runtime.callFunctionOn', {
    objectId: underId,
    functionDeclaration: 'function () { const label = (this.getAttribute && (this.getAttribute("aria-label") || this.getAttribute("title"))) || ""; const text = (this.textContent || "").trim(); return ((this.tagName || "").toLowerCase() + " " + (label || text).replace(/\\s+/g, " ").slice(0, 60)).trim(); }',
    returnByValue: true,
  }).catch(() => null)
  return { covering: String(described?.result?.value || 'another element').slice(0, 80) }
}

async function act(tabId, params) {
  await attach(tabId)
  await watchActionChanges(tabId)
  const action = String(params.action || '')
  if (action === 'click') {
    const backendNodeId = checkedRef(params.ref)
    try { await debuggerCommand({ tabId }, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }) } catch {}
    const model = await debuggerCommand({ tabId }, 'DOM.getBoxModel', { backendNodeId })
    const quad = model?.model?.content || model?.model?.border
    if (!Array.isArray(quad) || quad.length < 8) throw controlGone()
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
    const reach = await clickReachesControl(tabId, backendNodeId, x, y)
    if (reach !== true) throw reach.gone ? controlGone() : controlNotReachable(reach.covering)
    await debuggerCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await debuggerCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  } else if (action === 'type') {
    const backendNodeId = checkedRef(params.ref)
    await debuggerCommand({ tabId }, 'DOM.focus', { backendNodeId })
    if (params.clear !== false) {
      const platform = await platformInfo()
      const modifiers = platform.os === 'mac' ? 4 : 2
      await debuggerCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers })
      await debuggerCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers })
      await debuggerCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' })
      await debuggerCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' })
    }
    await debuggerCommand({ tabId }, 'Input.insertText', { text: String(params.text || '').slice(0, 20_000) })
  } else if (action === 'select') {
    const object = await debuggerCommand({ tabId }, 'DOM.resolveNode', { backendNodeId: checkedRef(params.ref) })
    await debuggerCommand({ tabId }, 'Runtime.callFunctionOn', {
      objectId: object?.object?.objectId,
      functionDeclaration: `function(value) { this.value = value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }`,
      arguments: [{ value: String(params.value || '').slice(0, 2_000) }],
    })
  } else if (action === 'upload') {
    const files = Array.isArray(params.files) ? params.files.map(value => String(value)).slice(0, 10) : []
    if (!files.length || files.some(path => !path)) throw new Error('Upload requires one or more validated absolute file paths.')
    await debuggerCommand({ tabId }, 'DOM.setFileInputFiles', { backendNodeId: checkedRef(params.ref), files })
  } else if (action === 'keypress') {
    await pressKey(tabId, String(params.key || ''))
  } else if (action === 'scroll') {
    const direction = String(params.direction || 'down'), amount = Math.max(1, Math.min(10, Number(params.amount) || 1))
    const x = 500, y = 400, distance = 620 * amount
    await debuggerCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: direction === 'left' ? -distance : direction === 'right' ? distance : 0, deltaY: direction === 'up' ? -distance : direction === 'down' ? distance : 0 })
  } else if (action === 'back') await tabsGoBack(tabId)
  else if (action === 'forward') await tabsGoForward(tabId)
  else if (action === 'reload') await tabsReload(tabId)
  else throw new Error(`Unsupported browser action: ${action}`)
  await settledAfterAction(tabId)
  return true
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

async function release(tabId, closeTab) {
  if (attachedTabs.has(tabId)) {
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
  return readSettleState(tabId, `if (!state.watching) { state.watching = true; state.mutations = 0; try { state.observer = new MutationObserver(() => { state.mutations += 1 }); state.observer.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true }) } catch {} }`).catch(() => {})
}

function releaseActionWatch(tabId) {
  void readSettleState(tabId, `state.watching = false; try { state.observer?.disconnect() } catch {}`).catch(() => {})
}

async function settledAfterAction(tabId) {
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
    if (quiet >= ACTION_SETTLE_QUIET_MS) return releaseActionWatch(tabId)
  }
  // A page that never answered is not a reason to read it early: fall back to the
  // wait this replaced.
  const remaining = ACTION_SETTLE_CEILING_MS - (Date.now() - started)
  if (remaining > 0) await delay(remaining)
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
// Only a freshly connected worker has a reason to look for an earlier bridge; the
// probe stops after a few rounds instead of ticking for the life of the worker.
setInterval(preferEarlierServer, PROBE_SPACING_MS)

// A browser or profile restart registers the alarm again and reconnects without
// waiting for the next alarm tick.
chrome.runtime.onStartup.addListener(() => connect())
chrome.runtime.onInstalled.addListener(() => connect())
