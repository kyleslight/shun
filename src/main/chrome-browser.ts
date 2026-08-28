import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import type { BrowserSession, PluginConnectionState } from '../shared.ts'

export const SHUN_CHROME_EXTENSION_ID = 'gdnbifehjpmpkhngchhjiiijikgokfdh'
export const SHUN_CHROME_BRIDGE_PORTS = Object.freeze(Array.from({ length: 10 }, (_, index) => 32124 + index))
const EXTENSION_ORIGIN = `chrome-extension://${SHUN_CHROME_EXTENSION_ID}`
const ACTIVE_STATES = new Set<BrowserSession['state']>(['attached', 'suspended', 'error'])
const MAX_MESSAGE_BYTES = 12 * 1024 * 1024
const MAX_SNAPSHOT_NODES = 300
const CONNECTION_RECOVERY_MS = 4_000

class ChromeConnectionInterruptedError extends Error {}

type PendingCall = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; socket: WebSocket }
type ChromeTab = { id: number; title?: string; url?: string; active?: boolean; windowId?: number }
type ChromeSnapshot = {
  tab: ChromeTab
  readyState?: string
  viewport?: { width: number; height: number; deviceScaleFactor?: number }
  text?: string
  nodes?: Array<Record<string, any>>
  console?: Array<Record<string, any>>
  pageErrors?: Array<Record<string, any>>
  screenshot?: string
}

export type BrowserAction = {
  action: 'click' | 'type' | 'select' | 'upload' | 'keypress' | 'scroll' | 'back' | 'forward' | 'reload'
  ref?: string
  text?: string
  value?: string
  key?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  clear?: boolean
  files?: string[]
}

export function browserUseUrl(value: unknown) {
  const raw = String(value || '').trim()
  if (!raw) throw Error('Browser URL is required.')
  if (raw.length > 2_048) throw Error('Browser URL is too long.')
  let url: URL
  try { url = new URL(raw) } catch { throw Error('Browser URL must be an absolute HTTP(S) URL.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Browser URL must be an HTTP(S) URL without embedded credentials.')
  return url.href
}

export function sameBrowserUrl(left: unknown, right: unknown) {
  try { return browserUseUrl(left) === browserUseUrl(right) } catch { return false }
}

export function browserNodeRef(value: unknown) {
  const ref = String(value || '').trim()
  if (!/^[1-9]\d{0,11}$/.test(ref)) throw Error('Browser action requires a fresh numeric ref from browser_snapshot.')
  return ref
}

export function formatChromeSnapshot(snapshot: ChromeSnapshot, session: BrowserSession) {
  const rows = (snapshot.nodes || []).slice(0, MAX_SNAPSHOT_NODES).map(node => {
    const state = [node.focused ? 'focused' : '', node.disabled ? 'disabled' : '', node.checked === undefined ? '' : `checked=${node.checked}`].filter(Boolean).join(' ')
    const value = cleanText(node.value, 160)
    const name = cleanText(node.name, 220)
    const description = cleanText(node.description, 160)
    const suffix = [name && JSON.stringify(name), value && `value=${JSON.stringify(value)}`, description && `description=${JSON.stringify(description)}`, state].filter(Boolean).join(' ')
    return `[${node.ref}] ${cleanText(node.role, 60) || 'node'}${suffix ? ` ${suffix}` : ''}`
  })
  const diagnostics = {
    session_id: session.id,
    tab_id: session.tabId,
    title: snapshot.tab?.title || session.title,
    url: snapshot.tab?.url || session.url,
    ready_state: snapshot.readyState,
    viewport: snapshot.viewport,
    accessibility_nodes: rows.length,
    accessibility: rows.join('\n'),
    visible_text: cleanText(snapshot.text, 8_000),
    console: (snapshot.console || []).slice(-30),
    page_errors: (snapshot.pageErrors || []).slice(-20),
    screenshot_included: Boolean(snapshot.screenshot),
  }
  return JSON.stringify(diagnostics, null, 2)
}

export class ChromeBrowserService {
  readonly #sessions = new Map<string, BrowserSession>()
  readonly #pending = new Map<string, PendingCall>()
  readonly #storageFile: string
  readonly #ready: Promise<void>
  #server?: WebSocketServer
  #socket?: WebSocket
  #extensionVersion = ''
  #port?: number
  #saveQueue = Promise.resolve()

  constructor(storageFile: string) {
    this.#storageFile = storageFile
    this.#ready = this.#load()
  }

  async start() {
    await this.#ready
    if (this.#server) return this.#port
    let lastError: unknown
    for (const port of SHUN_CHROME_BRIDGE_PORTS) {
      try {
        const server = new WebSocketServer({
          host: '127.0.0.1', port, maxPayload: MAX_MESSAGE_BYTES,
          verifyClient: ({ origin }, done) => done(origin === EXTENSION_ORIGIN, origin === EXTENSION_ORIGIN ? 200 : 403, origin === EXTENSION_ORIGIN ? 'OK' : 'Forbidden'),
        })
        await new Promise<void>((resolve, reject) => {
          const listening = () => { server.off('error', failed); resolve() }
          const failed = (error: Error) => { server.off('listening', listening); reject(error) }
          server.once('listening', listening)
          server.once('error', failed)
        })
        this.#server = server
        this.#port = port
        server.on('connection', (socket, request) => {
          if (request.url?.split('?')[0] === '/permission-probe') {
            socket.close(1000, 'Shun Browser Use bridge is available.')
            return
          }
          this.#accept(socket)
        })
        server.on('error', error => console.error('[chrome-browser-bridge]', error))
        return port
      } catch (error) { lastError = error }
    }
    throw Error(`Could not start the Chrome Browser Use bridge: ${lastError instanceof Error ? lastError.message : String(lastError || 'no loopback port is available')}`)
  }

  async stop() {
    this.#socket?.close(1001, 'Shun is closing')
    this.#socket = undefined
    for (const call of this.#pending.values()) { clearTimeout(call.timer); call.reject(Error('Chrome Browser Use bridge stopped.')) }
    this.#pending.clear()
    const server = this.#server
    this.#server = undefined
    this.#port = undefined
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  }

  state(): PluginConnectionState {
    return this.#socket?.readyState === WebSocket.OPEN
      ? { connected: true, status: 'connected', account: `Chrome extension${this.#extensionVersion ? ` ${this.#extensionVersion}` : ''}`, message: 'Uses your existing Chrome tabs, login state, cookies, and extensions.' }
      : { connected: false, status: 'disconnected', message: 'Open the Shun Browser Use extension in Chrome and choose “Connect to Shun”. Chrome may ask for local network access.' }
  }

  async tabs() {
    const tabs = await this.#call('tabs.list', {}) as ChromeTab[]
    return tabs.filter(tab => /^https?:\/\//i.test(tab.url || '')).slice(0, 300)
  }

  async list(taskId: string) {
    await this.#ready
    return [...this.#sessions.values()].filter(item => item.taskId === taskId && ACTIVE_STATES.has(item.state)).sort((a, b) => b.updatedAt - a.updatedAt).map(cloneSession)
  }

  async listAll() {
    await this.#ready
    return [...this.#sessions.values()].filter(item => ACTIVE_STATES.has(item.state)).sort((a, b) => b.updatedAt - a.updatedAt).map(cloneSession)
  }

  async open(taskId: string, runId: string, urlValue: unknown, active = false) {
    const url = browserUseUrl(urlValue)
    const tab = await this.#call('tabs.create', { url, active: Boolean(active) }) as ChromeTab
    const claimed = await this.claim(taskId, runId, tab.id, true)
    const session = this.#sessions.get(claimed.id)!
    await this.#update(session, { url: String(tab.url || url), title: String(tab.title || session.title), updatedAt: Date.now() })
    await this.#persist()
    return cloneSession(session)
  }

  async claim(taskId: string, runId: string, tabIdValue: unknown, owned = false) {
    await this.#ready
    const tabId = Number(tabIdValue)
    if (!Number.isSafeInteger(tabId) || tabId <= 0) throw Error('A valid Chrome tab ID from browser_tabs is required.')
    const occupied = [...this.#sessions.values()].find(item => item.tabId === tabId && ACTIVE_STATES.has(item.state))
    if (occupied) {
      if (occupied.taskId !== taskId) throw Error('That Chrome tab is already claimed by another Shun task.')
      return cloneSession(occupied)
    }
    const tab = await this.#call('tab.attach', { tabId }) as ChromeTab
    const now = Date.now()
    const session: BrowserSession = {
      id: randomUUID(), taskId, createdByRunId: runId, tabId, owned, state: 'attached',
      url: String(tab.url || ''), title: String(tab.title || ''), createdAt: now, updatedAt: now,
      consoleEntries: 0, pageErrors: 0,
    }
    this.#sessions.set(session.id, session)
    await this.#persist()
    await this.#releaseSessions([session], 'suspended')
    return cloneSession(session)
  }

  async snapshot(taskId: string, browserSessionId?: unknown, screenshot = false) {
    const session = await this.#session(taskId, browserSessionId)
    try {
      const snapshot = await this.#call('tab.snapshot', { tabId: session.tabId, screenshot: Boolean(screenshot) }) as ChromeSnapshot
      const now = Date.now()
      await this.#update(session, {
        state: 'attached', url: String(snapshot.tab?.url || session.url), title: String(snapshot.tab?.title || session.title), updatedAt: now,
        lastSnapshotAt: now, ...(snapshot.screenshot ? { lastScreenshotAt: now } : {}),
        consoleEntries: snapshot.console?.length || 0, pageErrors: snapshot.pageErrors?.length || 0, error: undefined,
      })
      await this.#persistSnapshot(session.id, snapshot)
      const text = formatChromeSnapshot(snapshot, session)
      await this.#releaseSessions([session], 'suspended')
      return { session: cloneSession(session), snapshot, text }
    } catch (error) {
      await this.#failed(session, error)
      await this.#releaseSessions([session], 'suspended')
      throw error
    }
  }

  async navigate(taskId: string, browserSessionId: unknown, urlValue: unknown) {
    const session = await this.#session(taskId, browserSessionId), url = browserUseUrl(urlValue)
    // A freshly opened tab is already navigating to its requested URL. Treating
    // an identical navigate as inspection avoids a duplicate request that can
    // lose page state or trip rate limits on sensitive sites.
    if (sameBrowserUrl(session.url, url)) return this.snapshot(taskId, session.id, false)
    try {
      const tab = await this.#call('tab.navigate', { tabId: session.tabId, url }) as ChromeTab
      await this.#update(session, { state: 'attached', url: String(tab.url || url), title: String(tab.title || session.title), updatedAt: Date.now(), error: undefined })
      return this.snapshot(taskId, session.id, false)
    } catch (error) {
      await this.#failed(session, error)
      await this.#releaseSessions([session], 'suspended')
      throw error
    }
  }

  async act(taskId: string, browserSessionId: unknown, action: BrowserAction) {
    const session = await this.#session(taskId, browserSessionId)
    const request: Record<string, unknown> = { tabId: session.tabId, action: action.action }
    if (['click', 'type', 'select'].includes(action.action)) request.ref = browserNodeRef(action.ref)
    if (action.action === 'type') {
      request.text = String(action.text ?? '').slice(0, 20_000)
      request.clear = action.clear !== false
    }
    if (action.action === 'select') request.value = String(action.value ?? '').slice(0, 2_000)
    if (action.action === 'upload') {
      request.ref = browserNodeRef(action.ref)
      request.files = (action.files || []).slice(0, 10)
    }
    if (action.action === 'keypress') request.key = String(action.key || '').slice(0, 80)
    if (action.action === 'scroll') {
      request.direction = action.direction || 'down'
      request.amount = Math.max(1, Math.min(10, Math.floor(Number(action.amount) || 1)))
    }
    try {
      await this.#call('tab.act', request)
      await this.#update(session, { state: 'attached', updatedAt: Date.now(), error: undefined })
      return this.snapshot(taskId, session.id, false)
    } catch (error) {
      await this.#failed(session, error)
      await this.#releaseSessions([session], 'suspended')
      throw error
    }
  }

  async waitForDownload(taskId: string, browserSessionId: unknown, timeoutMs = 30_000) {
    const session = await this.#session(taskId, browserSessionId)
    return this.#call('downloads.wait', {
      tabId: session.tabId,
      after: session.createdAt,
      timeoutMs: Math.max(1_000, Math.min(120_000, Math.floor(timeoutMs))),
    })
  }

  async download(taskId: string, browserSessionId: unknown, refValue: unknown, timeoutMs = 30_000) {
    const session = await this.#session(taskId, browserSessionId)
    const ref = browserNodeRef(refValue)
    let downloadId: number
    try {
      await this.#call('tab.attach', { tabId: session.tabId })
      downloadId = await this.#call('downloads.start', { tabId: session.tabId, ref }) as number
    } finally {
      await this.#releaseSessions([session], 'suspended')
    }
    return this.#call('downloads.wait', {
      tabId: session.tabId,
      downloadId,
      after: Date.now() - 2_000,
      timeoutMs: Math.max(1_000, Math.min(120_000, Math.floor(timeoutMs))),
    })
  }

  async show(taskId: string, browserSessionId: unknown) {
    const session = await this.#session(taskId, browserSessionId)
    const tab = await this.#call('tab.activate', { tabId: session.tabId }) as ChromeTab
    await this.#update(session, { state: 'attached', url: String(tab.url || session.url), title: String(tab.title || session.title), updatedAt: Date.now(), error: undefined })
    return cloneSession(session)
  }

  async release(taskId: string, browserSessionId: unknown, closeTab = false) {
    const session = await this.#session(taskId, browserSessionId)
    if (this.#socket?.readyState === WebSocket.OPEN) await this.#call('tab.release', { tabId: session.tabId, closeTab: Boolean(closeTab) })
    else if (closeTab) throw Error('Chrome Browser Use is disconnected, so Shun cannot close this tab. Reconnect Chrome or release it without close_tab.')
    await this.#update(session, { state: closeTab ? 'closed' : 'released', updatedAt: Date.now(), error: undefined })
    return cloneSession(session)
  }

  async removeTask(taskId: string) {
    await this.#ready
    const sessions = [...this.#sessions.values()].filter(item => item.taskId === taskId)
    if (this.#socket?.readyState === WebSocket.OPEN) await Promise.allSettled(sessions.filter(item => ACTIVE_STATES.has(item.state)).map(item => this.#call('tab.release', { tabId: item.tabId, closeTab: item.owned })))
    for (const session of sessions) {
      this.#sessions.delete(session.id)
      await Promise.all([
        rm(join(dirname(this.#storageFile), 'browser-snapshots', `${session.id}.json`), { force: true }),
        rm(join(dirname(this.#storageFile), 'browser-snapshots', `${session.id}.png`), { force: true }),
      ])
    }
    await this.#persist()
  }

  async releaseRun(taskId: string, _runId: string) {
    await this.#ready
    const active = [...this.#sessions.values()].filter(item => item.taskId === taskId && ACTIVE_STATES.has(item.state))
    await this.#releaseSessions(active, 'suspended')
  }

  async releaseAll() {
    await this.#ready
    const active = [...this.#sessions.values()].filter(item => ACTIVE_STATES.has(item.state))
    await this.#releaseSessions(active)
  }

  async #releaseSessions(active: BrowserSession[], nextState: 'suspended' | 'released' = 'released') {
    if (this.#socket?.readyState === WebSocket.OPEN) await Promise.allSettled(active.map(item => this.#call('tab.release', { tabId: item.tabId, closeTab: false })))
    for (const session of active) {
      session.state = nextState
      session.updatedAt = Date.now()
    }
    await this.#persist()
  }

  #accept(socket: WebSocket) {
    this.#socket?.close(4001, 'A newer Chrome extension connection replaced this one.')
    this.#socket = socket
    socket.on('message', value => this.#message(value))
    socket.on('close', () => {
      this.#rejectPendingForSocket(socket, new ChromeConnectionInterruptedError('Chrome extension connection changed.'))
      if (this.#socket !== socket) return
      this.#socket = undefined
      this.#extensionVersion = ''
      for (const session of this.#sessions.values()) if (session.state === 'attached') {
        session.state = 'suspended'
        session.updatedAt = Date.now()
      }
      void this.#persist()
    })
    socket.on('error', error => console.error('[chrome-browser-extension]', error))
  }

  #message(value: RawData) {
    let message: any
    try { message = JSON.parse(value.toString()) } catch { return }
    if (message?.type === 'hello') {
      this.#extensionVersion = cleanText(message.version, 40)
      return
    }
    if (message?.type === 'event') { void this.#browserEvent(message.event, message.params); return }
    if (typeof message?.id !== 'string') return
    const call = this.#pending.get(message.id)
    if (!call) return
    clearTimeout(call.timer)
    this.#pending.delete(message.id)
    if (message.error) call.reject(Error(String(message.error)))
    else call.resolve(message.result)
  }

  async #browserEvent(event: unknown, params: any) {
    const tabId = Number(params?.tabId)
    if (!Number.isSafeInteger(tabId)) return
    for (const session of this.#sessions.values()) {
      if (session.tabId !== tabId || !ACTIVE_STATES.has(session.state)) continue
      if (event === 'tab.closed') session.state = 'closed'
      else if (event === 'tab.detached') session.state = 'suspended'
      if (typeof params?.url === 'string') session.url = params.url.slice(0, 2_048)
      if (typeof params?.title === 'string') session.title = params.title.slice(0, 500)
      session.updatedAt = Date.now()
    }
    await this.#persist()
  }

  #call(method: string, params: Record<string, unknown>) {
    return this.#callRecovering(method, params)
  }

  async #callRecovering(method: string, params: Record<string, unknown>) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const socket = await this.#waitForConnection()
      try { return await this.#sendCall(socket, method, params) }
      catch (error) {
        if (!(error instanceof ChromeConnectionInterruptedError) || attempt > 0) throw error
      }
    }
    throw Error('Chrome Browser Use is not connected. Install or enable the Shun extension in Chrome.')
  }

  async #waitForConnection() {
    const deadline = Date.now() + CONNECTION_RECOVERY_MS
    while (Date.now() < deadline) {
      const socket = this.#socket
      if (socket?.readyState === WebSocket.OPEN) return socket
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw Error('Chrome Browser Use is not connected. Install or enable the Shun extension in Chrome.')
  }

  #sendCall(socket: WebSocket, method: string, params: Record<string, unknown>) {
    const id = randomUUID()
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(Error(`Chrome Browser Use timed out while calling ${method}.`))
      }, 25_000)
      timer.unref()
      this.#pending.set(id, { resolve, reject, timer, socket })
      socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new ChromeConnectionInterruptedError(error.message))
      })
    })
  }

  #rejectPendingForSocket(socket: WebSocket, error: Error) {
    for (const [id, call] of this.#pending) {
      if (call.socket !== socket) continue
      clearTimeout(call.timer)
      this.#pending.delete(id)
      call.reject(error)
    }
  }

  async #session(taskId: string, browserSessionId?: unknown) {
    await this.#ready
    const id = String(browserSessionId || '').trim()
    const session = id
      ? this.#sessions.get(id)
      : [...this.#sessions.values()].filter(item => item.taskId === taskId && ACTIVE_STATES.has(item.state)).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (!session || session.taskId !== taskId || !ACTIVE_STATES.has(session.state)) throw Error(`Unknown or released Browser Use session: ${id || '(no active session)'}.`)
    return session
  }

  async #update(session: BrowserSession, patch: Partial<BrowserSession>) {
    Object.assign(session, patch)
    await this.#persist()
  }

  async #failed(session: BrowserSession, error: unknown) {
    await this.#update(session, { state: 'error', error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() })
  }

  async #load() {
    try {
      const parsed = JSON.parse(await readFile(this.#storageFile, 'utf8'))
      if (!Array.isArray(parsed)) return
      let changed = false
      for (const value of parsed) if (validStoredSession(value)) {
        const wasActive = ACTIVE_STATES.has(value.state)
        if (wasActive && value.state !== 'suspended') changed = true
        const session = { ...value, state: wasActive ? 'suspended' : value.state } as BrowserSession
        this.#sessions.set(session.id, session)
      }
      if (changed) await this.#persist()
    } catch {}
  }

  #persist() {
    const payload = JSON.stringify([...this.#sessions.values()], null, 2)
    this.#saveQueue = this.#saveQueue.then(async () => {
      await mkdir(dirname(this.#storageFile), { recursive: true })
      await writeFile(this.#storageFile, `${payload}\n`, 'utf8')
    }).catch(error => console.error('[chrome-browser-persistence]', error))
    return this.#saveQueue
  }

  async #persistSnapshot(sessionId: string, snapshot: ChromeSnapshot) {
    const root = join(dirname(this.#storageFile), 'browser-snapshots')
    await mkdir(root, { recursive: true })
    const { screenshot, ...metadata } = snapshot
    await writeFile(join(root, `${sessionId}.json`), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
    if (screenshot) await writeFile(join(root, `${sessionId}.png`), Buffer.from(screenshot, 'base64'))
  }
}

function cleanText(value: unknown, limit: number) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function cloneSession(session: BrowserSession): BrowserSession { return { ...session } }

function validStoredSession(value: any): value is BrowserSession {
  return value && typeof value === 'object' && typeof value.id === 'string' && typeof value.taskId === 'string'
    && Number.isSafeInteger(value.tabId) && typeof value.state === 'string' && typeof value.createdAt === 'number' && typeof value.updatedAt === 'number'
}
