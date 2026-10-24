// A top-frame transport for sites Chrome cannot attach its debugger to because
// another extension owns an embedded frame. Reuse the same DOM observer/guard.
const pageTransportTabs = new Set()
// Stable main-frame identities are independent of the optional input channel.
const stablePageTabs = new Set()
const usesPageObservation = tabId => pageTransportTabs.has(tabId)
function checkedPageRef(value) {
  const match = /^p:([1-9]\d{0,11})$/.exec(String(value || ''))
  if (!match) throw new Error('The page observation channel changed. Read a fresh browser_snapshot before acting; no action was performed.')
  return Number(match[1])
}
const RESTRICTED_EXTENSION_TARGET = /Cannot access a chrome-extension:\/\/ URL of different extension/i

function containsExtensionFrame(tree) {
  if (!tree) return false
  if (String(tree.frame?.url || '').startsWith('chrome-extension://')) return true
  return (tree.childFrames || []).some(containsExtensionFrame)
}

function pageCallWithin(promise, deadline, phase) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The website did not answer the ${phase} step before its deadline. No input was replayed. Inspect Chrome's native UI for a blocking account chooser, permission prompt, or modal before retrying page actions. If foreground interaction is authorized, use Computer Use only for that blocker, then return to this tab; otherwise report the blocker.`)), Math.max(0, deadline - Date.now()))
    Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

async function pageTransportCall(tabId, method, args = []) {
  // A background renderer may need time to answer its first observation.
  // Each invocation has a bounded execution deadline checked again in the page.
  // A two-second cap rejected ordinary background dispatch under real Chrome load.
  const tab = await tabsGet(tabId)
  checkedUrl(tab.url)
  const invoke = async () => {
    const deadline = Date.now() + 8_000
    const results = await pageCallWithin(chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'ISOLATED', injectImmediately: true,
      func: (method, args, deadline, revision) => {
        if (Date.now() >= deadline) throw new Error('This page operation expired before execution. No action was performed.')
        const observer = globalThis.shunFastPath
        // Absence is established before calling any action. Only this result may
        // trigger installation and a subsequent call; uncertain input is never replayed.
        if (!observer || observer.pageTransportRevision !== revision || typeof observer[method] !== 'function') return { shunObserverMissing: true }
        return observer[method](...args)
      }, args: [method, args, deadline, 'stable-fields-2'],
    }), deadline, method)
    const result = results.find(result => result.frameId === 0)
    if (!result || result.error) throw new Error('Shun could not read this website’s main frame. No action was repeated.')
    return result
  }
  let result = await invoke()
  if (result.result?.shunObserverMissing === true) {
    // Loading the read-only observer has a separate deadline from dispatching input.
    await pageCallWithin(chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', injectImmediately: true, files: ['fast-path.js'] }), Date.now() + 8_000, 'observer injection')
    result = await invoke()
    if (result.result?.shunObserverMissing === true) throw new Error('The document changed before its observer was ready. No action was performed.')
  }
  return result.result
}

async function pageTransportSnapshot(tabId, screenshot = false) {
  const fast = await pageTransportCall(tabId, 'pageObserve', [true])
  const tab = await tabsGet(tabId)
  const result = {
    tab: tabInfo(tab), readyState: fast.readyState, viewport: fast.viewport, text: fast.text,
    loading: fast.readyState === 'loading' || tab.status === 'loading' || (fast.url !== undefined && fast.url !== tab.url) || (!fast.text && fast.elements.length === 0), transport: 'page', trustedClick: attachedTabs.has(tabId), frames: fast.frames,
    nodes: fast.elements.map(element => ({ ...element, value: element.selectedLabel ?? element.value, ref: `p:${element.id}` })), console: [], pageErrors: [],
    observationNote: 'This reading covers the website’s main frame. Embedded frame contents are not included; a visible verification frame may be waiting for interaction even when the main page has no error. Other extension frames were not accessed.',
  }
  if (screenshot && tab.active) {
    try { result.screenshot = (await callbackCall(chrome.tabs, 'captureVisibleTab', tab.windowId, { format: 'png' })).split(',')[1] }
    catch { result.observationNote += ' Screenshot capture was unavailable.' }
  } else if (screenshot) result.observationNote += ' A background tab was not selected for a screenshot.'
  return result
}

async function pageTransportAct(tabId, params, fast = false) {
  const action = String(params.action || '')
  if (['click', 'type', 'select'].includes(action)) {
    await watchActionChanges(tabId)
    const expected = fast ? params.expected : { id: checkedPageRef(params.ref) }
    const trustedClick = action === 'click' && attachedTabs.has(tabId)
    const trustedType = action === 'type' && attachedTabs.has(tabId) && await tabVisibility(tabId) === 'visible'
    const actionArgs = [expected, { kind: action, text: params.text, value: params.value, clear: params.clear !== false }, !fast]
    const gate = await pageTransportCall(tabId, trustedClick ? 'pagePrepare' : trustedType ? 'pageFocus' : 'pageAct', actionArgs)
    if (!gate?.ok) {
      await releaseActionWatch(tabId)
      if (fast) return { acted: false, stale: true, reason: gate?.reason || 'gone', detail: gate?.detail }
      throw new Error(`Shun did not perform this page action: ${gate?.covering ? 'covered by ' + gate.covering : gate?.detail || gate?.reason || 'control unavailable'}. Inspect a fresh snapshot.`)
    }
    if (trustedClick) {
      // Neither event is replayed through another channel after dispatch.
      await debuggerCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: gate.x, y: gate.y, button: 'left', clickCount: 1 })
      await debuggerCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: gate.x, y: gate.y, button: 'left', clickCount: 1 })
      await settledAfterAction(tabId)
      if (fast) return { acted: true, synthetic: false, ...(await pageTransportCall(tabId, 'pageObserve', [false])) }
      return { ok: true, synthetic: false }
    }
    if (trustedType) {
      const assertFocus = async () => {
        const focus = await pageTransportCall(tabId, 'pageHasFocus', actionArgs)
        if (focus?.ok !== true) throw new Error('The intended field did not retain focus. No further text was inserted; inspect the current form before continuing.')
      }
      await assertFocus()
      if (params.clear !== false) await clearFocusedText(tabId)
      await assertFocus()
      // Once input is dispatched, a failure must not replay it synthetically.
      await debuggerCommand({ tabId }, 'Input.insertText', { text: String(params.text || '').slice(0, 20_000) })
      await settledAfterAction(tabId)
      if (fast) return { acted: true, synthetic: false, ...(await pageTransportCall(tabId, 'pageObserve', [false])) }
      return { ok: true, synthetic: false }
    }
  } else if (['back', 'forward', 'reload'].includes(action)) {
    if (action === 'back') await tabsGoBack(tabId)
    if (action === 'forward') await tabsGoForward(tabId)
    if (action === 'reload') await tabsReload(tabId)
  } else {
    throw new Error('This action needs native browser input, which is unavailable for this page. No action was performed. Use an authorized Computer Use step for the specific control, then return to this browser session.')
  }
  await settledAfterAction(tabId)
  if (fast) return { acted: true, synthetic: true, ...(await pageTransportCall(tabId, 'pageObserve', [false])) }
  return { ok: true, synthetic: true }
}
