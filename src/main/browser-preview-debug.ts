import { webContents as electronWebContents } from 'electron'
import type { OnBeforeRequestListenerDetails, OnCompletedListenerDetails, OnErrorOccurredListenerDetails, Session, WebContents } from 'electron'

const maximumConsoleEntries = 120
const maximumNetworkEntries = 200

export type BrowserPreviewViewport = { width: number; height: number; label?: string }
export type BrowserPreviewInspectOptions = {
  url?: string
  include?: Array<'dom' | 'console' | 'network' | 'storage' | 'performance'>
  screenshot?: boolean
  profileMs?: number
  viewport?: BrowserPreviewViewport
  resumeAfterLogin?: boolean
}
export type BrowserPreviewAction = {
  type: 'navigate' | 'back' | 'forward' | 'refresh' | 'click' | 'fill' | 'press' | 'select' | 'scroll'
  url?: string
  ref?: string
  selector?: string
  value?: string
  key?: string
  x?: number
  y?: number
}

type ConsoleRow = { level: string; message: string; source?: string; line?: number; at: number }
type NetworkRow = {
  id: number
  url: string
  method: string
  resourceType: string
  startedAt: number
  durationMs?: number
  status?: number
  fromCache?: boolean
  error?: string
}
type PreviewSession = {
  taskId: string
  accessToken: string
  sender: WebContents
  page: WebContents
  requestedUrl: string
  console: ConsoleRow[]
  network: NetworkRow[]
  pending: Map<number, NetworkRow>
  authRequired?: { reason: string; detectedAt: number; url: string }
}

export type BrowserPreviewCommand = { taskId: string; url: string; viewport?: BrowserPreviewViewport; action?: 'back' | 'forward' | 'refresh' }

export class BrowserPreviewDebugService {
  private readonly sessions = new Map<string, PreviewSession>()
  private readonly observedContents = new WeakSet<WebContents>()
  private readonly observedSessions = new WeakSet<Session>()

  constructor(private readonly emitCommand: (command: BrowserPreviewCommand) => void) {}

  attach(sender: WebContents, taskId: string, accessToken: string, requestedUrl: string, guestId: unknown) {
    const page = findPreviewPage(sender, guestId)
    if (!page) return { attached: false, reason: 'The preview page is not ready yet.' }
    const previous = this.sessions.get(taskId)
    const session: PreviewSession = {
      taskId,
      accessToken,
      sender,
      page,
      requestedUrl,
      console: previous?.page === page ? previous.console : [],
      network: previous?.page === page ? previous.network : [],
      pending: previous?.page === page ? previous.pending : new Map(),
      authRequired: previous?.authRequired,
    }
    this.sessions.set(taskId, session)
    this.observe(page)
    return { attached: true, url: page.getURL(), authRequired: session.authRequired || null }
  }

  detach(accessToken: string) {
    for (const [taskId, session] of this.sessions) if (session.accessToken === accessToken) this.sessions.delete(taskId)
  }

  resume(taskId: string) {
    const session = this.sessions.get(taskId)
    if (!session) return { resumed: false }
    session.authRequired = undefined
    return { resumed: true }
  }

  has(taskId: string) {
    return Boolean(this.live(taskId))
  }

  async inspect(taskId: string, options: BrowserPreviewInspectOptions = {}) {
    const session = this.live(taskId)
    if (!session) return null
    if (session.authRequired && !options.resumeAfterLogin) return this.pausedResult(session)
    if (options.resumeAfterLogin) session.authRequired = undefined
    if (options.viewport) {
      const viewport = boundedViewport(options.viewport)
      this.emitCommand({ taskId, url: session.requestedUrl, viewport })
      await delay(180)
    }
    const page = session.page
    session.requestedUrl = page.getURL() || session.requestedUrl
    const include = new Set(options.include?.length ? options.include : ['dom', 'console', 'network'])
    const snapshot = await page.mainFrame.executeJavaScript(pageSnapshotScript(include.has('storage'), include.has('performance'))) as Record<string, any>
    const auth = detectAuthentication(snapshot, session.network)
    if (auth) {
      session.authRequired = { reason: auth, detectedAt: Date.now(), url: String(snapshot.url || page.getURL()) }
      return this.pausedResult(session, snapshot)
    }
    const profile = options.profileMs ? await page.mainFrame.executeJavaScript(performanceProfileScript(options.profileMs)) : undefined
    const diagnostics = {
      ok: true,
      source: 'browser-preview',
      attached: true,
      auth_required: false,
      requested_url: options.url || session.requestedUrl,
      ...(include.has('dom') ? snapshot : pick(snapshot, ['title', 'url', 'ready_state', 'viewport'])) ,
      ...(include.has('console') ? { console: session.console.slice(-60) } : {}),
      ...(include.has('network') ? { network: session.network.slice(-100) } : {}),
      ...(include.has('storage') ? { storage: snapshot.storage } : {}),
      ...(include.has('performance') ? { performance: snapshot.performance } : {}),
      ...(profile ? { performance_profile: profile } : {}),
      screenshot_included: options.screenshot === true,
    }
    const image = options.screenshot ? await capturePreview(page) : undefined
    return { diagnostics, image }
  }

  async act(taskId: string, action: BrowserPreviewAction, options: BrowserPreviewInspectOptions = {}) {
    const session = this.live(taskId)
    if (!session) return null
    if (session.authRequired) return this.pausedResult(session)
    if (action.type === 'navigate') {
      const url = httpUrl(action.url)
      session.requestedUrl = url
      this.emitCommand({ taskId, url })
      await delay(500)
    } else if (action.type === 'back' || action.type === 'forward' || action.type === 'refresh') {
      this.emitCommand({ taskId, url: session.requestedUrl, action: action.type })
      await delay(500)
    } else {
      await session.page.mainFrame.executeJavaScript(pageActionScript(action), true)
      await delay(250)
    }
    return this.inspect(taskId, options)
  }

  private pausedResult(session: PreviewSession, snapshot?: Record<string, any>) {
    return {
      diagnostics: {
        ok: false,
        source: 'browser-preview',
        attached: true,
        status: 'auth_required',
        auth_required: true,
        url: session.authRequired?.url || snapshot?.url || session.requestedUrl,
        reason: session.authRequired?.reason || 'Authentication is required before the requested page can be debugged.',
        action: 'Pause. Ask the user to sign in inside Browser Preview. Do not retry, refresh, submit credentials, or attempt a workaround. Continue only after the user confirms login, then call browser_debug once with resume_after_login=true.',
      },
    }
  }

  private live(taskId: string) {
    const session = this.sessions.get(taskId)
    if (!session) return undefined
    if (session.sender.isDestroyed() || session.page.isDestroyed()) { this.sessions.delete(taskId); return undefined }
    return session
  }

  private observe(page: WebContents) {
    if (!this.observedContents.has(page)) {
      this.observedContents.add(page)
      page.on('console-message', details => {
        for (const session of this.sessions.values()) {
          if (session.page !== page) continue
          session.console.push({
            level: details.level,
            message: String(details.message || '').slice(0, 2_000),
            source: String(details.sourceId || '').slice(0, 1_000),
            line: details.lineNumber,
            at: Date.now(),
          })
          trim(session.console, maximumConsoleEntries)
        }
      })
      page.once('destroyed', () => {
        for (const [taskId, session] of this.sessions) if (session.page === page) this.sessions.delete(taskId)
      })
    }
    const request = page.session.webRequest
    if (this.observedSessions.has(page.session)) return
    this.observedSessions.add(page.session)
    request.onBeforeRequest((details: OnBeforeRequestListenerDetails, callback) => {
      for (const session of this.sessions.values()) {
        if (details.webContentsId !== session.page.id) continue
        const row: NetworkRow = {
          id: details.id,
          url: String(details.url || '').slice(0, 2_000),
          method: details.method,
          resourceType: details.resourceType,
          startedAt: details.timestamp,
        }
        session.pending.set(details.id, row)
        session.network.push(row)
        trim(session.network, maximumNetworkEntries)
      }
      callback({})
    })
    request.onCompleted((details: OnCompletedListenerDetails) => this.finishRequest(details))
    request.onErrorOccurred((details: OnErrorOccurredListenerDetails) => this.finishRequest(details))
  }

  private finishRequest(details: OnCompletedListenerDetails | OnErrorOccurredListenerDetails) {
    for (const session of this.sessions.values()) {
      const row = session.pending.get(details.id)
      if (!row) continue
      row.durationMs = Math.max(0, Math.round((details.timestamp - row.startedAt) * 100) / 100)
      row.fromCache = details.fromCache
      if ('statusCode' in details) row.status = details.statusCode
      if ('error' in details && details.error) row.error = String(details.error).slice(0, 500)
      session.pending.delete(details.id)
    }
  }
}

function findPreviewPage(sender: WebContents, guestId: unknown) {
  const id = Number(guestId)
  if (!Number.isSafeInteger(id) || id < 1) return undefined
  const page = electronWebContents.fromId(id)
  if (!page || page.isDestroyed() || page.hostWebContents !== sender || !/^https?:/i.test(page.getURL())) return undefined
  return page
}

function detectAuthentication(snapshot: Record<string, any>, network: NetworkRow[]) {
  if (snapshot.auth?.password_input) return 'A visible password field indicates that the page is waiting for user authentication.'
  if (snapshot.auth?.login_form) return 'A visible sign-in form indicates that the page is waiting for user authentication.'
  if (snapshot.auth?.route) return 'The current page URL appears to be an authentication route.'
  const rejected = network.slice(-40).find(row => row.status === 401 || row.status === 403)
  if (rejected) return `The page received HTTP ${rejected.status} from ${rejected.url}.`
  return ''
}

function pageSnapshotScript(storage: boolean, performance: boolean) {
  return `(() => {
    const text = value => String(value || '').replace(/\\s+/g, ' ').trim()
    const visible = element => { const style = getComputedStyle(element), rect = element.getBoundingClientRect(); return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0 }
      const controls = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[role="button"]')).filter(visible).slice(0, 60).map((element, index) => ({
      ref: 'c' + (index + 1),
      tag: element.tagName.toLowerCase(), type: element.getAttribute('type') || undefined,
      label: text(element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') || element.textContent).slice(0, 160),
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
    }))
    const result = {
      title: document.title, url: location.href, ready_state: document.readyState,
      viewport: { width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      text: text(document.body?.innerText).slice(0, 10000), controls,
      auth: {
        password_input: Array.from(document.querySelectorAll('input[type="password"]')).some(visible),
        login_form: Array.from(document.querySelectorAll('form')).some(form => visible(form) && /login|log-in|sign-in|signin|oauth|auth/i.test([form.id, form.className, form.getAttribute('action'), form.textContent].join(' '))),
        route: /(^|\\/)(login|log-in|signin|sign-in|oauth|auth)(\\/|$)/i.test(location.pathname),
      },
    }
    if (${storage}) {
      const readStore = store => { const rows = []; for (let index = 0; index < Math.min(store.length, 100); index++) { const key = store.key(index); rows.push({ key, value: String(store.getItem(key) || '').slice(0, 4000) }) } return rows }
      result.storage = { local: readStore(localStorage), session: readStore(sessionStorage), cookies: document.cookie.slice(0, 8000) }
    }
    if (${performance}) {
      const navigation = performance.getEntriesByType('navigation')[0]
      const resources = performance.getEntriesByType('resource').slice(-150).map(entry => ({ name: entry.name.slice(0, 1000), type: entry.initiatorType, duration: Math.round(entry.duration * 100) / 100, transfer_size: entry.transferSize, decoded_size: entry.decodedBodySize }))
      result.performance = { navigation: navigation ? { type: navigation.type, duration: navigation.duration, dom_content_loaded: navigation.domContentLoadedEventEnd, load: navigation.loadEventEnd, transfer_size: navigation.transferSize, decoded_size: navigation.decodedBodySize } : null, resources }
    }
    return result
  })()`
}

function pageActionScript(action: BrowserPreviewAction) {
  const input = JSON.stringify({
    type: action.type,
    ref: String(action.ref || '').slice(0, 20),
    selector: String(action.selector || '').slice(0, 1_000),
    value: String(action.value || '').slice(0, 20_000),
    key: String(action.key || '').slice(0, 80),
    x: Number(action.x || 0),
    y: Number(action.y || 0),
  })
  return `(() => {
    const action = ${input}, visible = element => { const style = getComputedStyle(element), rect = element.getBoundingClientRect(); return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 }
    const controls = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[role="button"]')).filter(visible).slice(0, 60)
    const index = /^c(\\d+)$/.test(action.ref) ? Number(action.ref.slice(1)) - 1 : -1
    const element = action.selector ? document.querySelector(action.selector) : controls[index]
    if (action.type === 'scroll') { scrollBy({ left: action.x, top: action.y, behavior: 'instant' }); return { ok: true, scroll: { x: scrollX, y: scrollY } } }
    if (!(element instanceof Element)) throw Error('The requested page control is unavailable. Take a fresh browser_debug snapshot and use its current ref.')
    if (action.type === 'click') { element.click(); return { ok: true } }
    if (action.type === 'fill') {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw Error('fill requires an input or textarea.')
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
      if (setter) setter.call(element, action.value); else element.value = action.value
      element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }
    }
    if (action.type === 'select') {
      if (!(element instanceof HTMLSelectElement)) throw Error('select requires a select element.')
      element.value = action.value; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }
    }
    if (action.type === 'press') {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, bubbles: true })); element.dispatchEvent(new KeyboardEvent('keyup', { key: action.key, bubbles: true })); return { ok: true }
    }
    throw Error('Unsupported Browser Preview action.')
  })()`
}

function httpUrl(value: unknown) {
  const url = new URL(String(value || ''))
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('Browser Preview navigation requires an HTTP(S) URL.')
  if (url.username || url.password) throw Error('Browser Preview URLs cannot contain credentials.')
  return url.href
}

function performanceProfileScript(value: number) {
  const duration = Math.max(250, Math.min(5_000, Math.floor(Number(value) || 1_000)))
  return `new Promise(resolve => {
    const started = performance.now(), entries = []
    let observer
    try { observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) if (entries.length < 200) entries.push({ name: entry.name, type: entry.entryType, start: entry.startTime, duration: entry.duration, value: entry.value }) }); observer.observe({ entryTypes: ['longtask', 'layout-shift', 'largest-contentful-paint', 'measure'] }) } catch {}
    setTimeout(() => { try { observer?.disconnect() } catch {}; resolve({ duration_ms: Math.round(performance.now() - started), entries }) }, ${duration})
  })`
}

async function capturePreview(page: WebContents) {
  const image = await page.capturePage()
  return image.isEmpty() ? undefined : image.toPNG()
}

function boundedViewport(value: BrowserPreviewViewport): BrowserPreviewViewport {
  return { width: Math.max(240, Math.min(3_840, Math.round(value.width))), height: Math.max(240, Math.min(2_160, Math.round(value.height))), ...(value.label ? { label: String(value.label).slice(0, 40) } : {}) }
}

function pick(value: Record<string, any>, keys: string[]) {
  return Object.fromEntries(keys.filter(key => key in value).map(key => [key, value[key]]))
}

function trim<T>(rows: T[], limit: number) {
  if (rows.length > limit) rows.splice(0, rows.length - limit)
}

function delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)) }
