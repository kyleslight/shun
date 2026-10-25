import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginConnectionState } from '../shared.ts'

/**
 * Computer Use drives the machine Shun is running on: the windows on screen, a
 * screenshot of one of them, and real pointer and keyboard input.
 *
 * The three surfaces that already exist do not overlap with it. `web_read` reads
 * the public web without a session, Browser Use works inside the user's Chrome,
 * and Browser Preview is a local development surface. This one is the desktop
 * itself, and it is enabled by an explicit plugin installation, never by a task.
 *
 * One driver per platform implements the same contract: Swift on macOS, and one
 * Go program on Windows and Linux. The product speaks to all three the same way,
 * and each driver reports what its own platform can honestly do.
 */

const supportedPlatforms: NodeJS.Platform[] = ['darwin', 'win32', 'linux']

export type DesktopWindow = {
  id: number
  pid: number
  app: string
  title: string
  layer: number
  /** Whether this window is on the screen the person is looking at now. */
  onScreen: boolean
  x: number
  y: number
  width: number
  height: number
}

function windowGeometry(window: DesktopWindow): DesktopGeometry {
  return { x: window.x, y: window.y, width: window.width, height: window.height }
}

/**
 One control inside a window, as the Accessibility API describes it.

 This is the desktop counterpart of a browser accessibility ref: a named control
 with an opaque window-bound handle, so it can be acted on without reading pixels.
 */
export type DesktopElement = {
  ref: string
  role: string
  subrole: string
  title: string
  description: string
  value: string
  enabled: boolean
  focused: boolean
  pressable: boolean
  context?: string
  x: number
  y: number
  width: number
  height: number
}

export type DesktopElementTree = {
  window: DesktopWindow
  geometry: DesktopGeometry
  elements: DesktopElement[]
  truncated: boolean
  depthLimited?: boolean
  depthLimit?: number
  observationScope?: 'frontmost_window'
  filter?: { query: string; matched: number; scanned: number }
  observationNote?: string
}

export type DesktopGeometry = { x: number; y: number; width: number; height: number }

export type DesktopWindowList = {
  frontmost: { app: string; pid: number; bundleId: string; windowId?: number }
  display: DesktopGeometry
  windows: DesktopWindow[]
}

function focusedNativeWindow(current: DesktopWindowList) {
  return current.frontmost.windowId === undefined
    ? current.windows.find(window => window.pid === current.frontmost.pid && window.layer === 0)
    : current.windows.find(window => window.id === current.frontmost.windowId && window.pid === current.frontmost.pid && window.layer === 0 && window.onScreen)
}

export type DesktopPermissionState = {
  accessibility: boolean
  screenRecording: boolean
  capturableDisplays: number
  frontmost: string
  frontmostBundleId?: string
  userIdleMs: number
}

export type DesktopSnapshot = {
  target: 'window' | 'screen'
  window?: DesktopWindow
  geometry: DesktopGeometry
  width: number
  height: number
  screenshot: string
}

export type DesktopActionRequest = {
  action: 'move' | 'click' | 'double_click' | 'right_click' | 'drag' | 'scroll' | 'type' | 'key' | 'focus' | 'press' | 'set_value'
  window?: string | number
  /** Bring an application forward by name or bundle id, for one that has no window here. */
  app?: string
  ref?: string
  value?: string
  x?: number
  y?: number
  toX?: number
  toY?: number
  durationMs?: number
  text?: string
  key?: string
  flags?: string
  deltaX?: number
  deltaY?: number
}

export type DesktopCommandResult = { stdout: Buffer; stderr: string }
export type DesktopCommandRunner = (command: string, args: string[], options?: { signal?: AbortSignal; maxBytes?: number; timeoutMs?: number }) => Promise<DesktopCommandResult>

type DesktopControlOptions = {
  driverPath: string
  platform?: NodeJS.Platform
  run?: DesktopCommandRunner
  ensureAccessibility?: () => boolean | Promise<boolean>
  requireObservation?: boolean
}

/**
 Which platforms read an accessibility element tree. It is a driver capability, so
 it is stated once here where tool registration can ask for it, and the drivers
 that do not implement the command fail honestly if they are ever asked.
 */
const elementTreePlatforms: NodeJS.Platform[] = ['darwin']
/** How many windows keep a tree for ref validation, and the largest tree kept. */
const observedWindowLimit = 8

/**
 * How long an action waits before its result is read. It is short on purpose: the
 * capture that follows takes longer than this, and a fixed long wait is dead time on
 * every step of a sequence.
 */
const settleMs = 120

const maximumText = 4_000
const maximumScroll = 4_000
/**
 Input this recent means the person is working on this Mac right now. Reading is
 still fine; synthesizing a click or a keystroke is not, because it would land in
 whatever they are doing. The window is short enough that the agent's own
 synthetic events — which also count as input — never trip it: an action taken by
 Shun itself is recognised by its timestamp rather than by the idle reading.
 */
const activeUserIdleMs = 700
const ownActionGraceMs = 1_500

export class DesktopControlService {
  readonly #driverPath: string
  readonly #platform: NodeJS.Platform
  readonly #run: DesktopCommandRunner
  readonly #ensureAccessibility: () => boolean | Promise<boolean>
  readonly #requireObservation: boolean
  #windowReadings = new Map<number, DesktopWindow>()
  #screenReading?: DesktopWindow
  #lastActionAt = 0
  /**
   What was last returned to the model, per window, so a press can require the
   control to still be the one that was read. The desktop equivalent of refusing
   a stale browser ref: a control that moved or was replaced is not the control
   the model saw, and pressing it anyway is how automation clicks the wrong thing.
   */
  #observed = new Map<number, Map<string, DesktopElement>>()
  #readingSequence = 0
  #referenceScope = randomUUID().replace(/-/g, '').slice(0, 12)
  #nativeRefs = new WeakMap<DesktopElement, string>()

  constructor(options: DesktopControlOptions) {
    this.#requireObservation = options.requireObservation === true
    this.#driverPath = options.driverPath
    this.#platform = options.platform || process.platform
    this.#run = options.run || runDesktopCommand
    this.#ensureAccessibility = options.ensureAccessibility || (() => true)
  }

  /** A run owns its observations; another run cannot inherit native input targets. */
  fork() {
    return new DesktopControlService({ driverPath: this.#driverPath, platform: this.#platform,
      run: this.#run, ensureAccessibility: this.#ensureAccessibility, requireObservation: true })
  }

  async state(): Promise<PluginConnectionState> {
    if (!supportedPlatforms.includes(this.#platform)) {
      return { connected: false, status: 'unavailable', message: `Computer Use drives a local desktop and is not available on ${this.#platform}.` }
    }
    try {
      const permissions = await this.permissions()
      if (this.#platform === 'darwin') {
        const missing = [
          permissions.accessibility ? '' : 'Accessibility',
          permissions.screenRecording ? '' : 'Screen Recording',
        ].filter(Boolean)
        if (missing.length) {
          // Permission is not a connection problem for this capability; it is the
          // capability being blocked, so it is reported where the person can act on it.
          return {
            connected: false,
            status: 'error',
            message: `Shun needs ${missing.join(' and ')} permission before it can look at or act on this Mac: System Settings > Privacy & Security.`,
          }
        }
      }
      if (!permissions.capturableDisplays) {
        return {
          connected: true,
          status: 'connected',
          message: 'No display is capturable right now. A locked screen or a sleeping display cannot be captured; unlock this computer and retry.',
        }
      }
      return {
        connected: true,
        status: 'connected',
        account: permissions.frontmost || undefined,
        message: this.#readyMessage(permissions),
      }
    } catch (error) {
      return { connected: false, status: 'unavailable', message: desktopError(error) }
    }
  }

  #readyMessage(permissions: DesktopPermissionState) {
    const front = permissions.frontmost || 'No application'
    if (this.#platform === 'win32') return `Drives this PC through on-screen windows and real input. ${front} is in front. An application that runs elevated cannot receive input from here.`
    if (this.#platform === 'linux') return `Drives this desktop through on-screen windows and real input over X11. ${front} is in front.`
    return `Drives this Mac through on-screen windows and real input. ${front} is in front.`
  }

  async permissions(signal?: AbortSignal): Promise<DesktopPermissionState> {
    const output = await this.#run(this.#driverPath, ['probe'], { signal, timeoutMs: 20_000 })
    const probe = JSON.parse(output.stdout.toString('utf8')) as Record<string, any>
    return {
      accessibility: probe.accessibility === true,
      screenRecording: probe.screen_recording === true,
      capturableDisplays: Number(probe.capture?.displays || 0),
      frontmost: String(probe.frontmost || ''),
      frontmostBundleId: String(probe.frontmost_bundle_id || ''),
      userIdleMs: probe.user_idle_ms === undefined ? -1 : Number(probe.user_idle_ms),
    }
  }

  /** Whether this platform's driver can read an accessibility element tree. */
  supportsElements() {
    return elementTreePlatforms.includes(this.#platform)
  }

  async windows(signal?: AbortSignal, options: { all?: boolean } = {}): Promise<DesktopWindowList> {
    await this.#available()
    // `all` includes windows on another desktop and minimized ones, each marked with whether it is
    // on screen: "there is no such window" and "that window is elsewhere" are different answers.
    const output = await this.#run(this.#driverPath, options.all ? ['windows', '--all'] : ['windows'], { signal, timeoutMs: 20_000 })
    const parsed = JSON.parse(output.stdout.toString('utf8')) as Record<string, any>
    return {
      frontmost: {
        app: String(parsed.frontmost?.app || ''),
        pid: Number(parsed.frontmost?.pid || 0),
        bundleId: String(parsed.frontmost?.bundle_id || ''),
        ...(Number.isInteger(parsed.frontmost?.window_id) && parsed.frontmost.window_id >= 0 ? { windowId: parsed.frontmost.window_id as number } : {}),
      },
      display: geometry(parsed.display),
      windows: (parsed.windows || []).flatMap((row: Record<string, unknown>): DesktopWindow[] => {
        const id = Number(row.id)
        if (!Number.isInteger(id) || id <= 0) return []
        return [{
          id,
          pid: Number(row.pid || 0),
          app: String(row.app || ''),
          title: String(row.title || ''),
          layer: Number(row.layer || 0),
          onScreen: row.on_screen !== false,
          ...geometry(row),
        }]
      }),
    }
  }

  /**
   * Run several known actions in order, with one observation at the end.
   *
   * A caller that has already determined the steps — a dialog that takes a shortcut, a
   * path, and two Returns — does not need a model turn, a settle, and a capture between
   * each of them: that is where a visible sequence turns from a second into a minute.
   * Every step is still checked, and a failing step stops the sequence.
   */
  async actSequence(requests: DesktopActionRequest[], options: { signal?: AbortSignal, capture?: 'screenshot' | 'elements' | 'none' } = {}) {
    const capture = options.capture || 'screenshot'
    // One reading of the machine's state for the whole sequence: a probe costs more than
    // a keystroke does, and nothing about the screen or the person's hands changes between
    // two steps of the same dialog.
    await this.#available()
    if (!await this.#ensureAccessibility()) throw Error('Accessibility permission is required to act on this Mac. Enable Shun in System Settings > Privacy & Security > Accessibility, then retry.')
    const permissions = await this.permissions(options.signal)
    const steps: Array<{ action: string, driver: Record<string, unknown> }> = []
    let last: DesktopActionRequest | undefined
    for (const request of requests) {
      try {
        const value = await this.act(request, options.signal, { capture: 'none', permissions })
        steps.push({ action: value.action, driver: value.driver })
        last = request
      } catch (error) {
        if (options.signal?.aborted) throw error
        return {
          action: 'sequence', steps,
          stopped: { step: steps.length + 1, action: request.action, reason: error instanceof Error ? error.message : String(error) },
          note: 'The sequence stopped at the reported step; earlier steps above already completed. Later steps were not attempted. Inspect the current target before continuing; do not replay completed steps or assume a failed driver call sent no input.',
        }
      }
    }
    const target = last ? this.#actionSelector(last) : 'frontmost'
    const observed = !last || last.action === 'key' || target === 'screen' ? (target === 'screen' ? 'screen' : 'frontmost') : target
    if (capture === 'none') return { action: 'sequence', steps }
    if (capture === 'elements') {
      const tree = await this.elements({ window: observed }, options.signal)
      return { action: 'sequence', steps, tree: { window: tree.window, geometry: tree.geometry, elements: tree.elements.slice(0, 60), truncated: tree.truncated } }
    }
    try {
      return { action: 'sequence', steps, snapshot: await this.#capture({ window: observed }, options.signal) }
    } catch (error) {
      return { action: 'sequence', steps, captureError: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   Read one window's controls. This is the observation to prefer when the target
   is a named control — it costs no pixels, survives small text, and gives a ref
   that a press can be checked against.
   */
  async elements(request: { window?: string | number, max?: number, depth?: number, query?: string } = {}, signal?: AbortSignal): Promise<DesktopElementTree> {
    await this.#available()
    if (!this.supportsElements()) {
      throw Error(`Reading an accessibility tree is not implemented for ${this.#platform} yet, so this call would return nothing useful. Use desktop_snapshot and act on coordinates instead.`)
    }
    const screenRequested = request.window === 'screen'
    const selector = this.#selector(screenRequested ? undefined : request.window)
    const max = Math.max(1, Math.min(400, Math.floor(request.max || 150)))
    const query = String(request.query || '').trim().slice(0, 200)
    const scanMax = query ? 400 : max
    const depth = Math.max(1, Math.min(20, Math.floor(request.depth || 20)))
    const output = await this.#run(this.#driverPath, ['elements', '--window', selector, '--max', String(scanMax), '--depth', String(depth)], { signal, timeoutMs: 30_000 })
    const parsed = JSON.parse(output.stdout.toString('utf8')) as Record<string, any>
    const window = windowRecord(parsed.window)
    const reading = ++this.#readingSequence
    const rows: Record<string, unknown>[] = parsed.elements || []
    const needle = query.toLowerCase()
    const matches = query ? rows.filter(row => [row.title, row.description].some(value => String(value || '').toLowerCase().includes(needle))) : rows
    const limited = matches.length > max
    const elements = matches.slice(0, max).flatMap((row: Record<string, unknown>, index: number): DesktopElement[] => {
      const nativeRef = String(row.ref ?? '')
      if (!nativeRef) return []
      const element: DesktopElement = {
        ref: `d:${window.id}:${this.#referenceScope}${reading.toString(36)}:${index + 1}`,
        role: String(row.role || ''),
        subrole: String(row.subrole || ''),
        title: String(row.title || ''),
        description: String(row.description || ''),
        value: row.subrole === 'AXSecureTextField' || row.role === 'AXSecureTextField' ? '[protected]' : String(row.value ?? ''),
        ...(row.context ? { context: String(row.context).slice(0, 360) } : {}),
        enabled: row.enabled === true,
        focused: row.focused === true,
        pressable: row.pressable === true,
        ...geometry(row),
      }
      this.#nativeRefs.set(element, nativeRef)
      return [element]
    })
    this.#windowReadings.set(window.id, window)
    this.#remember(window.id, elements)
    const notes = [
      ...(screenRequested ? ['This control reading covers only the frontmost window, not every window on the screen. Use its returned window and refs; use desktop_windows to inspect other windows.'] : []),
      ...(query ? ['This reading filters titles and descriptions by query, preserving full matching labels, context and coordinates. It does not search field values or parent context. A missing match does not establish that the control is absent; inspect without a query or use a current same-window screenshot when necessary.'] : []),
      ...(parsed.truncated === true || parsed.depth_limited === true || limited ? [`This control tree is incomplete (max=${scanMax}, depth=${depth}); a missing control is not evidence that it is absent. For an authorized interaction, use desktop_snapshot for this same window and current visible coordinates when the needed control is omitted. Resolve a visible blocking dialog first; do not target controls hidden behind it.`] : []),
    ]
    return { window, geometry: windowGeometry(window), elements, truncated: parsed.truncated === true || parsed.depth_limited === true || limited, ...(query ? { filter: { query, matched: matches.length, scanned: rows.length } } : {}), ...(parsed.depth_limited === true ? { depthLimited: true, depthLimit: depth } : {}), ...(screenRequested ? { observationScope: 'frontmost_window' as const } : {}), ...(notes.length ? { observationNote: notes.join(' ') } : {}) }
  }

  async snapshot(request: { window?: string | number } = {}, signal?: AbortSignal): Promise<DesktopSnapshot> {
    await this.#available()
    return this.#capture(request, signal)
  }

  async act(request: DesktopActionRequest, signal?: AbortSignal, options: { capture?: 'screenshot' | 'elements' | 'none', permissions?: DesktopPermissionState } = {}) {
    await this.#available()
    const byRef = request.action === 'press' || request.action === 'set_value'
    if (!await this.#ensureAccessibility()) {
      throw Error('Accessibility permission is required to act on this Mac. Enable Shun in System Settings > Privacy & Security > Accessibility, then retry.')
    }
    const permissions = options.permissions || await this.permissions(signal)
    if (!permissions.capturableDisplays) {
      // Acting without being able to see the result is not computer use, it is blind
      // input into whatever happens to be focused, so nothing is sent. This holds for
      // a ref action too: a press changes the interface, and the contract is that the
      // answer carries the interface it changed.
      throw Error('This computer’s screen cannot be captured right now, so the action was not sent. A locked screen or a sleeping display cannot be captured; unlock it and retry.')
    }
    if (permissions.userIdleMs >= 0 && permissions.userIdleMs < activeUserIdleMs && Date.now() - this.#lastActionAt > ownActionGraceMs) {
      // Human input makes every earlier target reading stale. Recovery is a
      // fresh observation after the person yields, not a permanent run latch.
      // Keep the idle check on every input; do not wait or retry here.
      this.#windowReadings.clear()
      this.#screenReading = undefined
      this.#observed.clear()
      this.#lastActionAt = 0
      throw Error(`The person using this computer is active right now (last input ${permissions.userIdleMs} ms ago), so no click or keystroke was sent. Preserve their foreground work. Prior native observations and refs are now stale. Do not poll, wait in a loop, or keep retrying input while they are active; continue independent background work. Once they have yielded, take a fresh observation of the intended window before resuming. A new model run is not required.`)
    }
    const selector = this.#actionSelector(request)
    const args = byRef ? this.#refArguments(request, selector) : actionArguments(request)
    if (this.#requireObservation && request.action !== 'focus') {
      const current = await this.windows(signal)
      const front = focusedNativeWindow(current)
      const actual = request.action === 'key' || selector === 'frontmost' || selector === 'screen'
        ? front : current.windows.find(window => window.id === Number(selector))
      const reading = selector === 'screen' ? this.#screenReading : this.#windowReadings.get(actual?.id || 0)
      if (!actual || !reading || (request.action === 'key' && selector !== 'frontmost' && selector !== 'screen' && actual.id !== Number(selector))) {
        throw Error('No current native observation belongs to this run and input target. Read desktop_snapshot or desktop_elements for the exact current window before sending input. No input was sent.')
      }
      if (actual.id !== reading.id || actual.pid !== reading.pid || actual.app !== reading.app || actual.title !== reading.title || JSON.stringify(windowGeometry(actual)) !== JSON.stringify(windowGeometry(reading))) {
        this.#windowReadings.delete(reading.id)
        this.#observed.delete(reading.id)
        this.#screenReading = undefined
        throw Error('The observed native window changed before input. A Chrome tab or window title, application, or geometry no longer matches. Read the current desktop again; no input was sent.')
      }
      if (this.#platform === 'darwin') args.push('--expect-window-id', String(reading.id), '--expect-window-pid', String(reading.pid), '--expect-window-title', reading.title, '--expect-window-frame', `${reading.x},${reading.y},${reading.width},${reading.height}`)
    }
    this.#lastActionAt = Date.now()
    const output = await this.#run(this.#driverPath, args, { signal, timeoutMs: 30_000 })
    const driver = JSON.parse(output.stdout.toString('utf8')) as Record<string, any>
    if (byRef && driver.performed && typeof driver.performed === 'object') driver.performed.ref = request.ref
    await wait(settleMs, signal)
    // The result of an action is the desktop after it, observed on the same target
    // that was acted on, so the model never reasons about a stale surface. An
    // action that was sent but could not be observed is reported as exactly that
    // rather than as a failure.
    const observedTarget = request.action === 'key' || selector === 'screen' ? (selector === 'screen' ? 'screen' : 'frontmost') : selector
    if (options.capture === 'none') return { action: request.action, driver }
    try {
      if (options.capture === 'elements') return { action: request.action, driver, tree: await this.elements({ window: observedTarget }, signal) }
      return { action: request.action, driver, snapshot: await this.#capture({ window: observedTarget }, signal) }
    } catch (error) {
      return { action: request.action, driver, captureError: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   A press carries the identity the model was given, and the driver refuses before
   acting when that is no longer what sits at the ref. The expectation comes from
   the tree this service itself returned, not from the model's memory.
   */
  #refArguments(request: DesktopActionRequest, selector: string) {
    if (!this.supportsElements()) {
      throw Error(`Acting on a control by ref needs an accessibility tree, which ${this.#platform} does not implement yet. Use desktop_snapshot and act on coordinates instead.`)
    }
    const ref = String(request.ref ?? '').trim()
    if (!ref) throw Error('ref is required to press a control; read desktop_elements first and use the ref it returned.')
    const observed = this.#observed.get(Number(selector))?.get(ref)
    if (!observed) {
      throw Error(`Ref ${ref} is not in a reading this session made of window ${selector}. Read desktop_elements for that window and use a ref from it.`)
    }
    if (!observed.enabled) throw Error('That control is not enabled in the current reading. No input was sent. Inspect the visible prerequisites instead of pressing it or switching input methods.')
    if (request.action === 'press' && !observed.pressable) throw Error('That control does not offer a press action in the current reading. No input was sent. Use a current observation to choose a supported action.')
    const expectation = ['--expect-role', observed.role, '--expect-title', observed.title, '--expect-frame', `${observed.x},${observed.y},${observed.width},${observed.height}`]
    const nativeRef = this.#nativeRefs.get(observed)
    if (!nativeRef) throw Error('That control reading is no longer available. Read desktop_elements before acting.')
    if (request.action === 'press') return ['press', '--window', selector, '--ref', nativeRef, ...expectation]
    const value = String(request.value ?? '')
    if (!value) throw Error('value is required to set a control value.')
    if (value.length > maximumText) throw Error(`value must be at most ${maximumText} characters.`)
    return ['set-value', '--window', selector, '--ref', nativeRef, '--value', value, ...expectation]
  }

  #actionSelector(request: DesktopActionRequest) {
    const boundWindow = request.action === 'press' || request.action === 'set_value'
      ? /^d:([1-9]\d*):[a-z0-9]+:[1-9]\d*$/.exec(String(request.ref || ''))?.[1]
      : undefined
    return this.#selector(request.window ?? boundWindow)
  }

  #remember(windowId: number, elements: DesktopElement[]) {
    this.#observed.delete(windowId)
    this.#observed.set(windowId, new Map(elements.map(element => [element.ref, element])))
    while (this.#observed.size > observedWindowLimit) {
      const oldest = this.#observed.keys().next().value
      if (oldest === undefined) break
      this.#observed.delete(oldest)
    }
  }

  async #capture(request: { window?: string | number }, signal?: AbortSignal): Promise<DesktopSnapshot> {
    const target = this.#selector(request.window)
    const directory = await mkdtemp(join(tmpdir(), 'shun-desktop-'))
    const capturePath = join(directory, 'capture.png')
    try {
      const args = target === 'screen' ? ['snapshot', '--window', 'screen', '--out', capturePath] : ['snapshot', '--window', target, '--out', capturePath]
      const output = await this.#run(this.#driverPath, args, { signal, timeoutMs: 30_000 })
      const meta = JSON.parse(output.stdout.toString('utf8')) as Record<string, any>
      const png = await readFile(capturePath)
      if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw Error('The desktop driver did not return a valid PNG capture.')
      const window = meta.window ? windowRecord(meta.window) : undefined
      if (window) this.#windowReadings.set(window.id, window)
      else if (target === 'screen' && this.#requireObservation) {
        const current = await this.windows(signal)
        this.#screenReading = focusedNativeWindow(current)
      }
      return {
        target: meta.target === 'window' ? 'window' : 'screen',
        ...(window ? { window } : {}),
        geometry: window ? { x: window.x, y: window.y, width: window.width, height: window.height } : geometry(meta.display),
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
        screenshot: png.toString('base64'),
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  /** An absent selector means the frontmost window; `screen` means the whole display. */
  #selector(value: string | number | undefined) {
    const text = String(value ?? '').trim()
    return text || 'frontmost'
  }

  async #available() {
    if (!supportedPlatforms.includes(this.#platform)) throw Error(`Computer Use drives a local desktop and is not available on ${this.#platform}.`)
  }
}

function actionArguments(request: DesktopActionRequest) {
  const selector = String(request.window ?? '').trim() || 'frontmost'
  // `screen` is passed through as itself: a click on a cookie wall or a modal belongs to the
  // display, and rewriting it to the frontmost window sent that click into whatever window
  // happened to be in front — which is a different action, silently.
  const target = selector
  switch (request.action) {
    case 'move':
      return ['act', '--action', 'move', '--window', target, '--x', normalized(request.x, 'x'), '--y', normalized(request.y, 'y')]
    case 'click':
    case 'double_click':
    case 'right_click':
      return ['act', '--action', request.action, '--window', target, '--x', normalized(request.x, 'x'), '--y', normalized(request.y, 'y')]
    case 'drag':
      return ['act', '--action', 'drag', '--window', target,
        '--from-x', normalized(request.x, 'x'), '--from-y', normalized(request.y, 'y'),
        '--to-x', normalized(request.toX, 'to_x'), '--to-y', normalized(request.toY, 'to_y'),
        '--duration_ms', boundedInteger(request.durationMs ?? 400, 100, 5_000, 'duration_ms')]
    case 'scroll':
      return ['act', '--action', 'scroll', '--window', target,
        '--delta_y', boundedInteger(request.deltaY ?? 0, -maximumScroll, maximumScroll, 'delta_y'),
        '--delta_x', boundedInteger(request.deltaX ?? 0, -maximumScroll, maximumScroll, 'delta_x')]
    case 'type': {
      const text = String(request.text ?? '')
      if (!text) throw Error('text is required to type into this Mac.')
      if (text.length > maximumText) throw Error(`text must be at most ${maximumText} characters.`)
      return ['act', '--action', 'type', '--text', Buffer.from(text, 'utf8').toString('base64')]
    }
    case 'key':
      return ['act', '--action', 'key', '--key', required(request.key, 'key'), ...(request.flags ? ['--flags', String(request.flags)] : [])]
    case 'focus':
      // An application whose window is on another desktop is not in the window list, so it is
      // named as an application: the driver activates it and its windows come to this desktop.
      return request.app
        ? ['focus', '--app', required(request.app, 'app')]
        : ['act', '--action', 'focus', '--window', target]
    default:
      throw Error(`Unsupported desktop action: ${String(request.action)}`)
  }
}

function windowRecord(row: Record<string, unknown>): DesktopWindow {
  return {
    id: Number(row.id || 0),
    pid: Number(row.pid || 0),
    app: String(row.app || ''),
    title: String(row.title || ''),
    layer: Number(row.layer || 0),
    onScreen: row.on_screen !== false,
    ...geometry(row),
  }
}

function geometry(value: unknown): DesktopGeometry {
  const row = (value || {}) as Record<string, unknown>
  return {
    x: Math.round(Number(row.x || 0)),
    y: Math.round(Number(row.y || 0)),
    width: Math.round(Number(row.width || 0)),
    height: Math.round(Number(row.height || 0)),
  }
}

function normalized(value: unknown, name: string) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1) throw Error(`${name} must be a normalized coordinate from 0 through 1, measured on the captured surface.`)
  return String(number)
}

function boundedInteger(value: unknown, minimum: number, maximum: number, name: string) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw Error(`${name} must be an integer from ${minimum} through ${maximum}.`)
  return String(number)
}

function required(value: unknown, name: string) {
  const text = String(value ?? '').trim()
  if (!text) throw Error(`${name} is required.`)
  return text
}

function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(done, Math.max(0, Math.min(5_000, milliseconds)))
    function done() { signal?.removeEventListener('abort', abort); resolvePromise() }
    function abort() { clearTimeout(timer); rejectPromise(Error('The desktop action was cancelled.')) }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

function desktopError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith('Computer Use could not') ? message : `Computer Use is unavailable: ${message}`
}

export async function runDesktopCommand(command: string, args: string[], options: { signal?: AbortSignal; maxBytes?: number; timeoutMs?: number } = {}): Promise<DesktopCommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const maxBytes = options.maxBytes ?? 2_000_000
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let bytes = 0, settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (error) rejectPromise(error)
      else resolvePromise({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8').trim() })
    }
    const abort = () => { child.kill('SIGTERM'); finish(Error('The desktop action was cancelled.')) }
    const timer = options.timeoutMs ? setTimeout(() => { child.kill('SIGTERM'); finish(Error(`The desktop action timed out after ${options.timeoutMs} ms.`)) }, options.timeoutMs) : undefined
    timer?.unref()
    if (options.signal?.aborted) return abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', data => {
      const chunk = Buffer.from(data); bytes += chunk.length
      if (bytes > maxBytes) { child.kill('SIGTERM'); finish(Error('The desktop driver output exceeded the safe size limit.')) } else stdout.push(chunk)
    })
    child.stderr.on('data', data => stderr.push(Buffer.from(data)))
    child.on('error', error => finish(error))
    child.on('close', code => {
      if (settled) return
      const errorText = Buffer.concat(stderr).toString('utf8').trim()
      if (code !== 0) finish(Error(errorText || `${command} exited with code ${code}.`))
      else finish()
    })
  })
}
