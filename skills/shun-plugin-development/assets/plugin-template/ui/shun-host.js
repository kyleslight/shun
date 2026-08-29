(() => {
  const channel = new URLSearchParams(location.search).get('channel') || ''
  const pending = new Map()
  const eventListeners = new Map()
  const contextListeners = new Set()
  let requestSequence = 0
  let currentContext
  let resolveReady
  const ready = new Promise(resolve => { resolveReady = resolve })

  const emit = (listeners, value) => {
    for (const listener of listeners) {
      try { listener(value) } catch (error) { queueMicrotask(() => { throw error }) }
    }
  }

  addEventListener('message', event => {
    if (event.source !== parent) return
    const message = event.data
    if (!message || message.source !== 'shun-host' || message.channel !== channel) return
    if (message.type === 'context') {
      currentContext = Object.freeze({ ...(message.context || {}) })
      resolveReady?.(currentContext)
      resolveReady = undefined
      emit(contextListeners, currentContext)
      return
    }
    if (message.type === 'event' && typeof message.event === 'string') {
      emit(eventListeners.get(message.event) || [], message.payload)
      return
    }
    if (message.type !== 'response' || typeof message.requestId !== 'string') return
    const request = pending.get(message.requestId)
    if (!request) return
    pending.delete(message.requestId)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(String(message.error)))
    else request.resolve(message.result)
  })

  async function request(method, payload = {}, options = {}) {
    await ready
    const requestId = String(++requestSequence)
    const timeout = Number.isFinite(options.timeout) ? Math.max(100, Math.min(120_000, Number(options.timeout))) : 15_000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`${method} timed out after ${timeout} ms.`))
      }, timeout)
      pending.set(requestId, { resolve, reject, timer })
      parent.postMessage({ source: 'shun-plugin', channel, type: 'request', requestId, method, payload }, '*')
    })
  }

  function on(event, listener) {
    if (typeof listener !== 'function') throw new TypeError('Event listener must be a function.')
    const listeners = eventListeners.get(event) || new Set()
    listeners.add(listener)
    eventListeners.set(event, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) eventListeners.delete(event)
    }
  }

  function onContext(listener) {
    if (typeof listener !== 'function') throw new TypeError('Context listener must be a function.')
    contextListeners.add(listener)
    if (currentContext) queueMicrotask(() => listener(currentContext))
    return () => contextListeners.delete(listener)
  }

  async function readText(path, options = {}) {
    const maximum = Number.isFinite(options.maxBytes) ? Math.max(1, Math.min(16 * 1024 * 1024, Number(options.maxBytes))) : 4 * 1024 * 1024
    const chunks = []
    let offset = 0
    let total = 0
    while (true) {
      const chunk = await request('workspace.read', { path, offset, length: Math.min(1024 * 1024, maximum - total) }, options)
      const binary = atob(chunk.data || '')
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
      chunks.push(bytes)
      total += bytes.length
      if (chunk.nextOffset === undefined) break
      if (total >= maximum) throw new Error(`${path} exceeds the ${maximum}-byte plugin read limit.`)
      offset = chunk.nextOffset
    }
    const joined = new Uint8Array(total)
    let cursor = 0
    for (const chunk of chunks) { joined.set(chunk, cursor); cursor += chunk.length }
    return new TextDecoder(options.encoding || 'utf-8', { fatal: options.fatal === true }).decode(joined)
  }

  window.ShunPlugin = Object.freeze({
    ready,
    get context() { return currentContext },
    request,
    list: payload => request('workspace.list', payload),
    read: payload => request('workspace.read', payload),
    readText,
    reveal: path => request('workspace.reveal', { path }),
    invokeWorker: (workerId, input, options) => request('worker.invoke', { workerId, input }, options),
    exportFile: (payload, options) => request('host.export', payload, options),
    getWorkspaceState: key => request('workspace.state.get', { key }),
    setWorkspaceState: (key, value) => request('workspace.state.set', { key, value }),
    on,
    onWorkspaceChanged: listener => on('workspace.changed', listener),
    onWorkspaceStateChanged: listener => on('workspace.state.changed', listener),
    onContext,
  })

  parent.postMessage({ source: 'shun-plugin', channel, type: 'ready' }, '*')
})()
