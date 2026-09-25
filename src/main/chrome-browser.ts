import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import type { BrowserSession, PluginConnectionState } from '../shared.ts'

/**
 * The bundled, unpacked copy fixes its own ID through the manifest `key` field,
 * because Chrome derives a path-based ID for unpacked extensions otherwise.
 */
export const SHUN_CHROME_EXTENSION_ID = 'gdnbifehjpmpkhngchhjiiijikgokfdh'

/**
 * The Chrome Web Store item has its own ID. A store package may not carry a
 * `key` field (the store rejects it outright), so the published build cannot be
 * made to share the development ID. Both origins are accepted below: users who
 * already loaded the unpacked copy keep working, and the store build connects as
 * soon as it is installed.
 */
export const SHUN_CHROME_STORE_EXTENSION_ID = 'nlgfkakigbblngkkfbjjcnelmnnacbnb'
export const SHUN_CHROME_BRIDGE_PORTS = Object.freeze(Array.from({ length: 10 }, (_, index) => 32124 + index))
export const SHUN_CHROME_EXTENSION_ORIGINS: ReadonlySet<string> = new Set([
  `chrome-extension://${SHUN_CHROME_EXTENSION_ID}`,
  `chrome-extension://${SHUN_CHROME_STORE_EXTENSION_ID}`,
])

/** Derived from the ID above, so the two cannot drift apart. */
export const SHUN_CHROME_EXTENSION_STORE_URL = `https://chromewebstore.google.com/detail/${SHUN_CHROME_STORE_EXTENSION_ID}`

/**
 * Chrome's own page for one extension. It is where Reload and Update live, so it
 * is the page that can update the copy the user actually runs — a store listing
 * cannot update an extension loaded from a folder.
 */
export function chromeExtensionsPageUrl(extensionId: string) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw Error('A Chrome extension page needs a Chrome extension ID.')
  return `chrome://extensions/?id=${extensionId}`
}

/** The allowlisted extension ID behind a bridge origin, or an empty string. */
export function chromeExtensionIdFromOrigin(origin: string | undefined) {
  return SHUN_CHROME_EXTENSION_ORIGINS.has(origin || '') ? String(origin).replace('chrome-extension://', '') : ''
}

// Chrome refuses to attach a debugger to the Web Store and no extension may script
// it. That is a boundary, not a transient failure: it is reported in Shun's own
// words before a tab or a session exists, instead of handing back Chrome's raw
// refusal as an unexplained tool error that a model would reasonably retry.
const CHROME_WEB_STORE_URL = /^https:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)(?:[/?#]|$)/
export const CHROME_WEB_STORE_MESSAGE = 'Chrome does not allow Shun to inspect or click the Chrome Web Store. Open that page yourself in Chrome and finish there.'

/**
 * Whether the Chrome Web Store listing is published.
 *
 * The listing went live on 2026-09-13, so the store is now the install path:
 * Shun opens the listing and the developer-mode walkthrough stays as the
 * fallback. The bridge accepts both origins either way.
 */
export const SHUN_CHROME_EXTENSION_STORE_LIVE = true
const ACTIVE_STATES = new Set<BrowserSession['state']>(['attached', 'suspended', 'error'])
const MAX_MESSAGE_BYTES = 12 * 1024 * 1024
const MAX_SNAPSHOT_NODES = 300
const CONNECTION_RECOVERY_MS = 4_000
/**
 * How much longer a call waits once Chrome has been poked: a suspended extension worker is only
 * woken by a browser event, so the tab that pokes it has to open, be seen, and reconnect. This
 * is a startup cost paid once, not a poll.
 */
const WAKE_GRACE_MS = 8_000

class ChromeConnectionInterruptedError extends Error {}

/**
 * A control that cannot be clicked as observed: something is over it, or it is no
 * longer where the snapshot said it was. Both are answers about the page, and both
 * are decidable, so the caller can act on them instead of guessing why nothing
 * happened. A live page produces this constantly; it is not a broken browser.
 */
export abstract class BrowserControlUnavailableError extends Error {}

/**
 * Something else is on top of the point the click would use — a dialog, a banner,
 * a sticky header — so the click would either do nothing or activate the wrong
 * control. Shun says what is in the way and does not click.
 */
export class BrowserControlBlockedError extends BrowserControlUnavailableError {
  readonly covering?: string

  constructor(covering?: string) {
    super(covering
      ? `That control is behind ${covering}. Shun did not click it, because the click would have landed on what is in front of it. Dismiss or move past that first, then act on a fresh snapshot.`
      : 'That control is not where its position on the page says it is, so Shun did not click it. Take a fresh snapshot and act on that.')
    this.name = 'BrowserControlBlockedError'
    if (covering) this.covering = covering
  }
}

/** The control is no longer rendered where its box reported it, so a click cannot land. */
/**
 * Chrome is not rendering the tab being driven, so injected input never reaches its page. It
 * is a property of the tab, not of the control, and it is decidable: show the tab and try
 * again. Without this the action looks like one that did nothing.
 */
export class BrowserTabHiddenError extends BrowserControlUnavailableError {
  constructor() {
    super('Chrome is not showing that tab, so it does not deliver clicks or keys to it. Shun did not act. Show that tab in Chrome (or open it in front), then act on a fresh snapshot.')
    this.name = 'BrowserTabHiddenError'
  }
}

export class BrowserControlGoneError extends BrowserControlUnavailableError {
  constructor() {
    super('That control is no longer where its position on the page says it is, so Shun did not click it. Take a fresh snapshot and act on that.')
    this.name = 'BrowserControlGoneError'
  }
}

type PendingCall = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; socket: WebSocket }
type ChromeTab = { id: number; title?: string; url?: string; active?: boolean; windowId?: number }
export type ChromeSnapshot = {
  tab: ChromeTab
  readyState?: string
  viewport?: { width: number; height: number; deviceScaleFactor?: number }
  text?: string
  nodes?: Array<Record<string, any>>
  console?: Array<Record<string, any>>
  pageErrors?: Array<Record<string, any>>
  screenshot?: string
  /** Where the page is scrolled to, when the observation reports it. */
  scroll?: { x: number; y: number; max: number }
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
  if (CHROME_WEB_STORE_URL.test(url.href)) throw Error(CHROME_WEB_STORE_MESSAGE)
  return url.href
}

export function sameBrowserUrl(left: unknown, right: unknown) {
  try { return browserUseUrl(left) === browserUseUrl(right) } catch { return false }
}

/**
 * A control as the page itself reports it. `id` is an integer the page handed out for this
 * document and resolves to a node only inside that page, so it can never be turned into a
 * selector, an XPath, or a coordinate by whoever receives it.
 */
export type FastPageElement = {
  id: number
  role: string
  name?: string
  value?: string
  tag?: string
  /** Where a link goes, as a path only — the material that tells two links apart. */
  target?: string
  /** The region of the page the control sits in, so two controls with the same name differ. */
  region?: string
  rect?: { x: number; y: number; width: number; height: number }
  /** Outside the visible part of the page; a click on it brings it into view first. */
  offscreen?: boolean
  /** Role, name, value and state together: what makes this control the one a decision meant. */
  fingerprint?: string
  disabled?: boolean
  readonly?: boolean
  focused?: boolean
  checked?: boolean
  selected?: boolean
  expanded?: boolean
}

/**
 * One DOM-first observation of a page: the whole of what a fast decision is allowed to
 * know, gathered in a single call instead of an accessibility walk plus a screenshot.
 */
export type FastPageSnapshot = {
  url: string
  title: string
  readyState?: string
  viewport?: { width: number; height: number }
  scroll?: { x: number; y: number; max: number }
  text?: string
  /** Identifies the document these identities belong to; a navigation replaces it. */
  marker?: string
  /** Changes whenever the page's controls, their state, or its position do. */
  fingerprint: string
  elements: FastPageElement[]
  /** Frames this observation could not see into, which is where the general path is needed. */
  frames?: { total: number; crossOrigin: number }
}

/**
 * A fast action names a control the page issued an identity for, never a route to one. The
 * expectation travels with it, so the page can refuse to act on a control that changed
 * between the observation and the action.
 */
export type FastBrowserAction = {
  action: 'click' | 'type' | 'select' | 'keypress' | 'scroll' | 'back' | 'forward' | 'reload'
  target?: { id: number; role?: string; name?: string; fingerprint?: string }
  text?: string
  value?: string
  clear?: boolean
  key?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  pointer?: 'hide'
}

/**
 * Said when an action had to be performed inside the page because Chrome was not rendering the
 * tab. It is not real user input, and a caller that does not know that would misread a native
 * control that stayed silent.
 */
/**
 * A click that landed on a control whose job is to upload a file. A page cannot open a file
 * picker by itself, so the click would report success and change nothing — which is exactly the
 * shape of failure that costs a run an hour. Uploading is the file input being set, and the
 * refusal names that action, the ref, and the paths it needs.
 */
export class BrowserFileInputError extends Error {
  readonly code = 'file_input'

  constructor() {
    super('That control uploads a file, and a page cannot open a file picker by itself, so Shun did not click it. Set the file instead: browser_act with action=upload, this ref, and the local paths to upload.')
  }
}

export const PAGE_PERFORMED_ACTION_NOTE = 'Chrome is not showing that tab, so Shun performed that action inside the page instead. The page’s own handlers ran; it was not real user input.'

export type FastActResult =
  | { status: 'acted'; session: BrowserSession; snapshot: ChromeSnapshot; fast?: FastPageSnapshot; text: string; synthetic?: boolean }
  /**
   * The page moved on from the control the decision named: nothing was performed. `reason` is a
   * sentence the main model can act on; `code` is the same fact in one word, for traces.
   */
  | { status: 'stale'; session: BrowserSession; reason: string; code: string; covering?: string; detail?: string }

/**
 * Why the page refused an action, in Shun's own words.
 *
 * The page answers in one-word codes because that is what a page can be trusted to compute;
 * a person and the main model read a sentence that says what happened and what was not done.
 */
export function fastRefusalSentence(code: string, detail?: string, covering?: string) {
  switch (code) {
    case 'file-input': return 'That control uploads a file, and a page cannot open a file picker by itself, so Shun did not click it. Set the file instead: browser_act with action=upload, this ref, and the local paths to upload.'
    case 'covered': return `That control is behind ${covering || 'another element'}. Shun did not click it, because the click would have landed on what is in front of it. Dismiss or move past that first, then act on a fresh observation.`
    case 'gone': return 'That control is no longer on the page, so Shun did not use it. Observe the page again and decide from what is there now.'
    case 'changed': return `That control is no longer the one this decision was made about${detail ? `: ${detail}` : ''}. Shun did not use it, and nothing was performed. Observe the page again and decide from the current control.`
    case 'unavailable': return `That control cannot be used right now${detail ? `: ${detail}` : ''}. Shun did not use it, and nothing was performed.`
    case 'offscreen': return 'That control is outside the part of the page Shun can reach with a click, so Shun did not click it. Scroll to it, then act on a fresh observation.'
    case 'no-size': return 'That control has no size on the page, so a click cannot land on it. Observe the page again and decide from what is there now.'
    case 'not-visible': return 'Chrome is not showing that tab, so it does not deliver clicks or keys to it. Nothing was performed. Show that tab in Chrome (or open it in front), then act again.'
    default: return 'The page did not confirm that control, so Shun did not use it. Nothing was performed; observe the page again and decide from what is there now.'
  }
}

/**
 * A refusal about the page rather than about the decision — the control is covered, disabled,
 * or unreachable, or the tab Chrome is rendering is not the one being driven — is the same fact
 * the general path reports as a control that could not be clicked, and it is counted the same
 * way. A refusal because the page moved on is a different fact: the observation expired.
 */
export const FAST_COVERED_REFUSALS = new Set(['covered', 'unavailable', 'no-size', 'offscreen', 'not-visible'])

/**
 * The extension build driving this Chrome does not offer the fast path. That is not a
 * Browser Use failure: it means the general path is the only one available here.
 */
export class BrowserFastUnsupportedError extends Error {
  constructor(detail: string) {
    super(`This Chrome extension build does not support fast browser observations (${detail}). Chrome Browser Use works as before.`)
    this.name = 'BrowserFastUnsupportedError'
  }
}

/** A method or action an older extension build does not know is a capability boundary, not a fault. */
function asUnsupported(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /Unknown Shun Browser Use method|Unsupported fast browser action/i.test(message) ? new BrowserFastUnsupportedError(message) : error
}

export function browserNodeRef(value: unknown) {
  const ref = String(value || '').trim()
  if (!/^[1-9]\d{0,11}$/.test(ref)) throw Error('Browser action requires a fresh numeric ref from browser_snapshot.')
  return ref
}

/**
 * The roles a decision or a click can actually act on.
 *
 * A page is mostly structure: on a large application the first few hundred nodes are
 * navigation, headers, and labels, so truncating by document order is what makes a
 * visible control unreachable — a task that has to click "Choose File" near the bottom
 * of a version page finds a snapshot that never mentioned it. Actionable controls are
 * therefore kept first and the rest fills the remainder, while the result stays in
 * document order so the page still reads the way it is laid out.
 */
const ACTIONABLE_SNAPSHOT_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'treeitem', 'listbox', 'gridcell', 'fileupload',
])

export function selectSnapshotNodes<T extends { role?: string, order?: number }>(nodes: T[], limit: number): { nodes: T[], truncated: boolean } {
  if (nodes.length <= limit) return { nodes, truncated: false }
  const actionable = nodes.filter(node => ACTIONABLE_SNAPSHOT_ROLES.has(String(node.role || '').toLowerCase()))
  const kept = new Set(actionable.slice(0, limit))
  for (const node of nodes) {
    if (kept.size >= limit) break
    if (!kept.has(node)) kept.add(node)
  }
  const selected = nodes.filter(node => kept.has(node))
  // Document order is restored when the reading carries it, so the page still reads the way
  // it is laid out even though usefulness decided what survived.
  return { nodes: nodes.every(node => typeof node.order === 'number') ? [...selected].sort((left, right) => left.order! - right.order!) : selected, truncated: true }
}

export function formatChromeSnapshot(snapshot: ChromeSnapshot, session: BrowserSession) {  const selected = selectSnapshotNodes(snapshot.nodes || [], MAX_SNAPSHOT_NODES)
  const rows = selected.nodes.map(node => {
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
    // A truncated reading says so: a model that believes it saw the whole page concludes a
    // control does not exist, when the reading simply did not reach it.
    ...(selected.truncated ? { accessibility_nodes_total: (snapshot.nodes || []).length, accessibility_note: `Showing ${rows.length} of ${(snapshot.nodes || []).length} nodes; controls that can be acted on are kept first. Scroll or narrow the page to reach the rest.` } : {}),
    accessibility: rows.join('\n'),
    visible_text: cleanText(snapshot.text, 8_000),
    console: (snapshot.console || []).slice(-30),
    page_errors: (snapshot.pageErrors || []).slice(-20),
    screenshot_included: Boolean(snapshot.screenshot),
  }
  return JSON.stringify(diagnostics, null, 2)
}

/**
 * The fast observation in the shape the rest of Shun already reads, so a decision, a
 * candidate set, and a fingerprint are built from it exactly as they are from an
 * accessibility tree. The page's identities become `ref`s, which is what makes an action
 * nameable without anybody — Shun included — writing a selector.
 */
export function fastSnapshotAsChromeSnapshot(fast: FastPageSnapshot, session: BrowserSession): ChromeSnapshot {
  return {
    tab: { id: session.tabId, url: fast.url || session.url, title: fast.title || session.title },
    ...(fast.readyState ? { readyState: fast.readyState } : {}),
    ...(fast.viewport ? { viewport: { width: fast.viewport.width, height: fast.viewport.height } } : {}),
    ...(fast.scroll ? { scroll: fast.scroll } : {}),
    ...(typeof fast.text === 'string' ? { text: fast.text } : {}),
    nodes: (fast.elements || []).map(element => ({
      ref: String(element.id),
      role: element.role,
      ...(element.name ? { name: element.name } : {}),
      ...(element.value ? { value: element.value } : {}),
      // The control's own identity, which the page re-checks before acting on it.
      ...(element.fingerprint ? { fingerprint: element.fingerprint } : {}),
      ...(element.offscreen ? { offscreen: true } : {}),
      ...(element.target ? { target: element.target } : {}),
      ...(element.region ? { region: element.region } : {}),
      ...(element.disabled ? { disabled: true } : {}),
      ...(element.readonly ? { readonly: true } : {}),
      ...(element.focused ? { focused: true } : {}),
      ...(typeof element.checked === 'boolean' ? { checked: element.checked } : {}),
      ...(typeof element.selected === 'boolean' ? { selected: element.selected } : {}),
      ...(typeof element.expanded === 'boolean' ? { expanded: element.expanded } : {}),
    })),
  }
}

/**
 * The fast observation as the model reads it. It carries the same keys as an accessibility
 * snapshot, because it answers the same question — what is on this page and what can be used
 * — and a model that learned one shape should not have to learn two.
 */
export function formatFastSnapshot(fast: FastPageSnapshot, session: BrowserSession) {
  const rows = (fast.elements || []).slice(0, MAX_SNAPSHOT_NODES).map(element => {
    const state = [
      element.focused ? 'focused' : '',
      element.disabled ? 'disabled' : '',
      element.readonly ? 'readonly' : '',
      element.checked === undefined ? '' : `checked=${element.checked}`,
      element.selected === undefined ? '' : `selected=${element.selected}`,
      element.expanded === undefined ? '' : `expanded=${element.expanded}`,
    ].filter(Boolean).join(' ')
    const name = cleanText(element.name, 220)
    const value = cleanText(element.value, 160)
    const suffix = [name && JSON.stringify(name), value && `value=${JSON.stringify(value)}`, state].filter(Boolean).join(' ')
    return `[${element.id}] ${cleanText(element.role, 60) || 'node'}${suffix ? ` ${suffix}` : ''}`
  })
  return JSON.stringify({
    session_id: session.id,
    tab_id: session.tabId,
    title: fast.title || session.title,
    url: fast.url || session.url,
    ready_state: fast.readyState,
    viewport: fast.viewport,
    scroll: fast.scroll,
    observation: 'dom',
    controls: rows.length,
    accessibility: rows.join('\n'),
    visible_text: cleanText(fast.text, 8_000),
    ...(fast.frames && fast.frames.total ? { frames: fast.frames } : {}),
  }, null, 2)
}

export class ChromeBrowserService {
  readonly #sessions = new Map<string, BrowserSession>()
  readonly #pending = new Map<string, PendingCall>()
  readonly #storageFile: string
  readonly #ready: Promise<void>
  #server?: WebSocketServer
  #socket?: WebSocket
  #extensionVersion = ''
  #extensionId = ''
  #port?: number
  #saveQueue = Promise.resolve()
  /**
   * Pokes Chrome when a call finds nothing connected. A Shun that has just restarted holds a
   * bridge nobody is connected to, and the extension's worker is asleep: without this the first
   * browser call after a restart fails with "not connected" and nothing ever wakes it.
   */
  #wake?: () => void

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
          verifyClient: ({ origin }, done) => done(
            SHUN_CHROME_EXTENSION_ORIGINS.has(origin),
            SHUN_CHROME_EXTENSION_ORIGINS.has(origin) ? 200 : 403,
            SHUN_CHROME_EXTENSION_ORIGINS.has(origin) ? 'OK' : 'Forbidden',
          ),
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
          // The origin is the allowlisted copy that connected, which is the copy
          // an update has to happen in.
          this.#accept(socket, chromeExtensionIdFromOrigin(request.headers.origin))
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

  /** Registers how to wake Chrome. The hook is rate limited by its owner, not by this. */
  onDisconnected(wake: () => void) {
    this.#wake = wake
  }

  state(): PluginConnectionState {
    return this.#socket?.readyState === WebSocket.OPEN
      ? { connected: true, status: 'connected', account: `Chrome extension${this.#extensionVersion ? ` ${this.#extensionVersion}` : ''}`, message: 'Uses your existing Chrome tabs, login state, cookies, and extensions.' }
      : { connected: false, status: 'disconnected', message: 'Open the Shun Browser Use extension in Chrome and choose “Connect to Shun”. Chrome may ask for local network access.' }
  }

  /** The extension copy holding the bridge right now, empty when nothing is connected. */
  connectedExtensionId() {
    return this.#socket?.readyState === WebSocket.OPEN ? this.#extensionId : ''
  }

  // A suspended extension service worker is only woken by a browser event, and a
  // server-initiated WebSocket message is not one (Chrome cannot wake an extension
  // that way). Opening this address is: the extension sees the tab, closes it, and
  // rebuilds the connection. Nothing is left behind in the user's browser.
  wakeUrl() {
    return this.#port ? `http://127.0.0.1:${this.#port}/shun-wake` : undefined
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

  async navigate(taskId: string, browserSessionId: unknown, urlValue: unknown) {    const session = await this.#session(taskId, browserSessionId), url = browserUseUrl(urlValue)
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
      const outcome = await this.#call('tab.act', request) as { synthetic?: boolean } | true
      await this.#update(session, { state: 'attached', updatedAt: Date.now(), error: undefined })
      const frame = await this.snapshot(taskId, session.id, false)
      // The page performed it because Chrome is not rendering the tab, and the caller is told:
      // an action that did not come from real input can be ignored by a native control.
      return typeof outcome === 'object' && outcome?.synthetic ? { ...frame, text: `${PAGE_PERFORMED_ACTION_NOTE}\n${frame.text}` } : frame
    } catch (error) {
      await this.#failed(session, error)
      await this.#releaseSessions([session], 'suspended')
      throw error
    }
  }

  /**
   * The fast path's observation: one call for the whole of what a fast decision may act on,
   * with no screenshot and no accessibility walk. It is not persisted the way an
   * accessibility snapshot is — there is one per step, and a file per step is disk churn for
   * an observation whose only reader is the next decision.
   */
  async fastSnapshot(taskId: string, browserSessionId?: unknown) {
    const session = await this.#session(taskId, browserSessionId)
    try {
      const fast = await this.#call('tab.fastSnapshot', { tabId: session.tabId }) as FastPageSnapshot
      const now = Date.now()
      await this.#update(session, {
        state: 'attached', url: String(fast.url || session.url), title: String(fast.title || session.title), updatedAt: now,
        lastSnapshotAt: now, consoleEntries: 0, pageErrors: 0, error: undefined,
      })
      await this.#releaseSessions([session], 'suspended')
      return { session: cloneSession(session), fast, snapshot: fastSnapshotAsChromeSnapshot(fast, session), text: formatFastSnapshot(fast, session) }
    } catch (error) {
      const unsupported = asUnsupported(error)
      if (unsupported instanceof BrowserFastUnsupportedError) throw unsupported
      await this.#failed(session, error)
      await this.#releaseSessions([session], 'suspended')
      throw error
    }
  }

  /**
   * One fast action, guarded and settled inside the same call: the page verifies that the
   * control is still the one the decision named before it is used, so there is no window in
   * which a caller could act on an observation that has already expired.
   *
   * A stale answer is not an error. It is the page saying the decision no longer applies,
   * and the honest response is a fresh observation — which is why nothing at all was done.
   * The action is never retried here: a click that might have landed twice is how a message
   * gets sent twice. A connection handoff below this layer can re-send the whole call, and
   * the guard is what makes that safe as well: an action that already happened has changed
   * the page, so the second attempt is refused as stale instead of being performed again.
   */
  async fastAct(taskId: string, browserSessionId: unknown, action: FastBrowserAction): Promise<FastActResult> {
    const session = await this.#session(taskId, browserSessionId)
    const request: Record<string, unknown> = { tabId: session.tabId, action: action.action }
    if (action.target) {
      request.expected = {
        id: Number(action.target.id),
        ...(action.target.role ? { role: action.target.role } : {}),
        ...(action.target.name ? { name: action.target.name } : {}),
        ...(action.target.fingerprint ? { fingerprint: action.target.fingerprint } : {}),
      }
    }
    if (action.action === 'type') {
      request.text = String(action.text ?? '').slice(0, 20_000)
      request.clear = action.clear !== false
    }
    if (action.action === 'select') request.value = String(action.value ?? '').slice(0, 2_000)
    if (action.action === 'keypress') request.key = String(action.key || '').slice(0, 80)
    if (action.action === 'scroll') {
      request.direction = action.direction || 'down'
      request.amount = Math.max(1, Math.min(10, Math.floor(Number(action.amount) || 1)))
    }
    try {
      const result = await this.#call('tab.fastAct', request) as ({ acted?: boolean; synthetic?: boolean; stale?: boolean; reason?: string; covering?: string; detail?: string } & FastPageSnapshot)
      if (!result?.acted) {
        const code = String(result?.reason || 'unknown')
        return {
          status: 'stale', session: cloneSession(session), code,
          reason: fastRefusalSentence(code, result?.detail ? String(result.detail) : undefined, result?.covering ? String(result.covering) : undefined),
          ...(result?.covering ? { covering: String(result.covering) } : {}),
          ...(result?.detail ? { detail: String(result.detail) } : {}),
        }
      }
      const now = Date.now()
      await this.#update(session, {
        state: 'attached', url: String(result.url || session.url), title: String(result.title || session.title),
        updatedAt: now, lastSnapshotAt: now, consoleEntries: 0, pageErrors: 0, error: undefined,
      })
      await this.#releaseSessions([session], 'suspended')
      const text = formatFastSnapshot(result, session)
      return {
        status: 'acted', session: cloneSession(session), fast: result,
        snapshot: fastSnapshotAsChromeSnapshot(result, session),
        text: result.synthetic ? `${PAGE_PERFORMED_ACTION_NOTE}\n${text}` : text,
        ...(result.synthetic ? { synthetic: true } : {}),
      }
    } catch (error) {
      const unsupported = asUnsupported(error)
      if (unsupported instanceof BrowserFastUnsupportedError) throw unsupported
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

  /**
   A task that is over releases its tabs instead of suspending them: the debugger
   comes off the tab, so Chrome's "…is debugging this browser" bar — which takes
   height from the page — goes with it, and the tab, which stays open, is the
   person's again. A session that is mid-step ('attached') is never touched here.
   */
  async releaseTask(taskId: string) {
    await this.#ready
    const settled = [...this.#sessions.values()].filter(item => item.taskId === taskId && (item.state === 'suspended' || item.state === 'error'))
    if (!settled.length) return 0
    await this.#releaseSessions(settled)
    return settled.length
  }

  async releaseAll() {
    await this.#ready
    const active = [...this.#sessions.values()].filter(item => ACTIVE_STATES.has(item.state))
    await this.#releaseSessions(active)
  }

  async #releaseSessions(active: BrowserSession[], nextState: 'suspended' | 'released' = 'released') {
    // Suspending detaches the debugger between two steps of the same work; the tab is still this
    // task's, so the extension must keep what it placed on the page (the tab mark, the pointer)
    // instead of returning it after every single action.
    if (this.#socket?.readyState === WebSocket.OPEN) await Promise.allSettled(active.map(item => this.#call('tab.release', { tabId: item.tabId, closeTab: false, keepMarks: nextState === 'suspended' })))
    for (const session of active) {
      session.state = nextState
      session.updatedAt = Date.now()
    }
    await this.#persist()
  }

  #accept(socket: WebSocket, extensionId = '') {
    this.#socket?.close(4001, 'A newer Chrome extension connection replaced this one.')
    this.#socket = socket
    this.#extensionId = extensionId
    socket.on('message', value => this.#message(socket, value))
    socket.on('close', () => {
      this.#rejectPendingForSocket(socket, new ChromeConnectionInterruptedError('Chrome extension connection changed.'))
      if (this.#socket !== socket) return
      this.#socket = undefined
      this.#extensionVersion = ''
      this.#extensionId = ''
      for (const session of this.#sessions.values()) if (session.state === 'attached') {
        session.state = 'suspended'
        session.updatedAt = Date.now()
      }
      void this.#persist()
    })
    socket.on('error', error => console.error('[chrome-browser-extension]', error))
  }

  #message(socket: WebSocket, value: RawData) {
    let message: any
    try { message = JSON.parse(value.toString()) } catch { return }
    if (message?.type === 'hello') {
      this.#extensionVersion = cleanText(message.version, 40)
      // The extension only trusts a socket while Shun answers it; this handshake
      // is how it learns that this Shun answers at all. An older build stays
      // silent here and keeps the previous readyState-based behaviour.
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'hello.ack', heartbeat: true }))
      return
    }
    // The extension treats silence as a dead connection, because a bridge that
    // quits can leave Chrome reporting a closed socket as open. Every heartbeat
    // is answered on the socket it arrived on.
    if (message?.type === 'heartbeat') {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'heartbeat.ack', at: Date.now() }))
      return
    }
    if (message?.type === 'event') { void this.#browserEvent(message.event, message.params); return }
    if (typeof message?.id !== 'string') return
    const call = this.#pending.get(message.id)
    if (!call) return
    clearTimeout(call.timer)
    this.#pending.delete(message.id)
    if (message.error) call.reject(message.code === 'file_input'
      ? new BrowserFileInputError()
      : message.code === 'tab_not_visible'
      ? new BrowserTabHiddenError()
      : message.code === 'control_not_reachable'
      ? new BrowserControlBlockedError(typeof message.detail?.covering === 'string' ? message.detail.covering : 'another element')
      : message.code === 'control_not_found'
        ? new BrowserControlGoneError()
        : Error(String(message.error)))
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
    let woke = false
    const deadline = Date.now() + CONNECTION_RECOVERY_MS + (this.#wake ? WAKE_GRACE_MS : 0)
    while (Date.now() < deadline) {
      const socket = this.#socket
      if (socket?.readyState === WebSocket.OPEN) return socket
      // One poke per call, on the first quiet pass, so an ordinary call after a restart heals
      // itself instead of handing the person a connection error they cannot act on.
      if (!woke && this.#wake) {
        woke = true
        try { this.#wake() } catch {}
      }
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
