const PORTS = Array.from({ length: 10 }, (_, index) => 32124 + index)
const PROTOCOL_VERSION = '1.3'
const attachedTabs = new Set()
const diagnostics = new Map()
let socket
let connectedPort
let reconnectTimer
let heartbeatTimer
let preferenceProbe = false

function setStatus(connected, port) {
  void chrome.action.setBadgeText({ text: connected ? '' : '!' })
  void chrome.action.setBadgeBackgroundColor({ color: '#777777' })
}

function connect() {
  clearTimeout(reconnectTimer)
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  let index = 0
  const attempt = () => {
    if (index >= PORTS.length) {
      setStatus(false)
      reconnectTimer = setTimeout(connect, 1800)
      return
    }
    const port = PORTS[index++]
    const candidate = new WebSocket(`ws://127.0.0.1:${port}`)
    let settled = false
    const fail = () => {
      if (settled) return
      settled = true
      try { candidate.close() } catch {}
      attempt()
    }
    const timer = setTimeout(fail, 550)
    candidate.onopen = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      adoptSocket(candidate, port)
    }
    candidate.onerror = fail
    candidate.onclose = () => { clearTimeout(timer); if (!settled) fail() }
  }
  attempt()
}

function adoptSocket(candidate, port) {
  const previous = socket
  socket = candidate
  connectedPort = port
  candidate.onmessage = event => { void handleRequest(event.data) }
  candidate.onerror = () => {}
  candidate.onclose = () => {
    if (socket !== candidate) return
    clearInterval(heartbeatTimer)
    socket = undefined
    connectedPort = undefined
    void releaseAttachedTabs()
    setStatus(false)
    reconnectTimer = setTimeout(connect, 1200)
  }
  setStatus(true, port)
  send({ type: 'hello', version: chrome.runtime.getManifest().version, browser: 'chrome' })
  clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => send({ type: 'heartbeat', at: Date.now() }), 20_000)
  if (previous && previous !== candidate) try { previous.close() } catch {}
}

function preferEarlierServer() {
  if (preferenceProbe || socket?.readyState !== WebSocket.OPEN) return
  const currentIndex = PORTS.indexOf(connectedPort)
  if (currentIndex <= 0) return
  preferenceProbe = true
  let index = 0
  const attempt = () => {
    if (index >= currentIndex) { preferenceProbe = false; return }
    const port = PORTS[index++]
    const candidate = new WebSocket(`ws://127.0.0.1:${port}`)
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
  if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') return
  try {
    const result = await dispatch(request.method, request.params || {})
    send({ id: request.id, result })
  } catch (error) {
    send({ id: request.id, error: error instanceof Error ? error.message : String(error) })
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

async function act(tabId, params) {
  await attach(tabId)
  const action = String(params.action || '')
  if (action === 'click') {
    const backendNodeId = checkedRef(params.ref)
    try { await debuggerCommand({ tabId }, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }) } catch {}
    const model = await debuggerCommand({ tabId }, 'DOM.getBoxModel', { backendNodeId })
    const quad = model?.model?.content || model?.model?.border
    if (!Array.isArray(quad) || quad.length < 8) throw new Error(`Chrome could not locate visible ref ${backendNodeId}. Take a fresh snapshot.`)
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
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
  await delay(350)
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

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!attachedTabs.has(tabId)) return
  send({ type: 'event', event: 'tab.updated', params: { tabId, url: change.url || tab.url, title: change.title || tab.title } })
})

chrome.tabs.onRemoved.addListener(tabId => {
  attachedTabs.delete(tabId)
  diagnostics.delete(tabId)
  send({ type: 'event', event: 'tab.closed', params: { tabId } })
})

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== 'status') return
  respond({ connected: socket?.readyState === WebSocket.OPEN, attachedTabs: attachedTabs.size })
})

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
setInterval(preferEarlierServer, 2_500)
