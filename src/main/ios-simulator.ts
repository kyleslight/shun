import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PluginConnectionState } from '../shared.ts'

export type IosSimulatorDevice = {
  udid: string
  name: string
  runtime: string
  state: string
  available: boolean
  lastBootedAt?: string
}

export type IosSimulatorAppRequest = {
  action: 'install' | 'uninstall' | 'launch' | 'terminate' | 'open_url'
  device: string
  appPath?: string
  bundleId?: string
  url?: string
  arguments?: string[]
}

export type IosSimulatorSettingRequest = {
  action: 'appearance' | 'increase_contrast' | 'content_size' | 'location' | 'permission' | 'status_bar'
  device: string
  value?: string
  enabled?: boolean
  latitude?: number
  longitude?: number
  clear?: boolean
  operation?: 'grant' | 'revoke' | 'reset'
  service?: string
  bundleId?: string
  time?: string
  dataNetwork?: string
  wifiBars?: number
  cellularBars?: number
  batteryState?: string
  batteryLevel?: number
}

export type IosSimulatorActionRequest = {
  action: 'tap' | 'swipe' | 'type' | 'button'
  device: string
  x?: number
  y?: number
  endX?: number
  endY?: number
  durationMs?: number
  text?: string
  button?: 'home' | 'lock' | 'shake' | 'app_switcher' | 'rotate_left' | 'rotate_right'
  waitMs?: number
}

export type IosSimulatorSnapshot = {
  device: IosSimulatorDevice
  width: number
  height: number
  screenshot: string
}

export type IosCommandResult = { stdout: Buffer; stderr: string }
export type IosCommandRunner = (command: string, args: string[], options?: { signal?: AbortSignal; maxBytes?: number; timeoutMs?: number }) => Promise<IosCommandResult>

type IosSimulatorServiceOptions = {
  driverPath: string
  platform?: NodeJS.Platform
  run?: IosCommandRunner
  ensureAccessibility?: () => boolean | Promise<boolean>
}

export class IosSimulatorService {
  readonly #driverPath: string
  readonly #platform: NodeJS.Platform
  readonly #run: IosCommandRunner
  readonly #ensureAccessibility: () => boolean | Promise<boolean>

  constructor(options: IosSimulatorServiceOptions) {
    this.#driverPath = options.driverPath
    this.#platform = options.platform || process.platform
    this.#run = options.run || runIosCommand
    this.#ensureAccessibility = options.ensureAccessibility || (() => true)
  }

  async state(): Promise<PluginConnectionState> {
    if (this.#platform !== 'darwin') {
      return { connected: false, status: 'unavailable', message: 'iOS Simulator is available only on macOS.' }
    }
    try {
      await this.#run('/usr/bin/xcrun', ['--find', 'simctl'], { timeoutMs: 5_000 })
      const version = await this.#run('/usr/bin/xcodebuild', ['-version'], { timeoutMs: 5_000 })
      return {
        connected: true,
        status: 'connected',
        account: version.stdout.toString('utf8').split(/\r?\n/)[0]?.trim() || 'Xcode',
        message: 'Uses the local Xcode Simulator runtime. Touch input requires macOS Accessibility permission for Shun.',
      }
    } catch (error) {
      return { connected: false, status: 'unavailable', message: simulatorError(error) }
    }
  }

  async devices(signal?: AbortSignal): Promise<IosSimulatorDevice[]> {
    await this.#available()
    const output = await this.#run('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { signal, timeoutMs: 15_000 })
    const parsed = JSON.parse(output.stdout.toString('utf8')) as { devices?: Record<string, Array<Record<string, unknown>>> }
    const devices = Object.entries(parsed.devices || {}).flatMap(([runtime, rows]) => {
      if (!runtime.includes('.SimRuntime.iOS-')) return []
      return rows.flatMap(row => {
        const udid = clean(row.udid), name = clean(row.name)
        if (!udid || !name) return []
        return [{
          udid,
          name,
          runtime: runtimeName(runtime),
          state: clean(row.state) || 'Unknown',
          available: row.isAvailable !== false,
          ...(clean(row.lastBootedAt) ? { lastBootedAt: clean(row.lastBootedAt) } : {}),
        }]
      })
    })
    return devices.sort((left, right) => Number(right.state === 'Booted') - Number(left.state === 'Booted') || right.runtime.localeCompare(left.runtime) || left.name.localeCompare(right.name))
  }

  async boot(deviceSelector: string, signal?: AbortSignal) {
    const device = await this.#device(deviceSelector, signal)
    if (device.state !== 'Booted') {
      await this.#run('/usr/bin/xcrun', ['simctl', 'boot', device.udid], { signal, timeoutMs: 30_000 })
      await this.#run('/usr/bin/xcrun', ['simctl', 'bootstatus', device.udid, '-b'], { signal, timeoutMs: 120_000 })
    }
    await this.#open(device.udid, signal)
    return { device: { ...device, state: 'Booted' }, opened: true }
  }

  async shutdown(deviceSelector: string, signal?: AbortSignal) {
    const device = await this.#device(deviceSelector, signal)
    if (device.state === 'Booted') await this.#run('/usr/bin/xcrun', ['simctl', 'shutdown', device.udid], { signal, timeoutMs: 30_000 })
    return { device: { ...device, state: 'Shutdown' } }
  }

  async app(request: IosSimulatorAppRequest, cwd: string, signal?: AbortSignal) {
    const device = await this.#bootedDevice(request.device, signal)
    let args: string[]
    switch (request.action) {
      case 'install': {
        const appPath = resolve(cwd, required(request.appPath, 'app_path'))
        const info = await stat(appPath)
        if (!info.isDirectory() && !info.isFile()) throw Error(`iOS app path is not installable: ${appPath}`)
        args = ['simctl', 'install', device.udid, appPath]
        break
      }
      case 'uninstall': args = ['simctl', 'uninstall', device.udid, required(request.bundleId, 'bundle_id')]; break
      case 'launch': args = ['simctl', 'launch', '--terminate-running-process', device.udid, required(request.bundleId, 'bundle_id'), ...(request.arguments || [])]; break
      case 'terminate': args = ['simctl', 'terminate', device.udid, required(request.bundleId, 'bundle_id')]; break
      case 'open_url': args = ['simctl', 'openurl', device.udid, validUrl(request.url)]; break
      default: throw Error(`Unsupported iOS app action: ${String(request.action)}`)
    }
    const output = await this.#run('/usr/bin/xcrun', args, { signal, timeoutMs: 60_000 })
    return { action: request.action, device, output: output.stdout.toString('utf8').trim() || 'completed' }
  }

  async setting(request: IosSimulatorSettingRequest, signal?: AbortSignal) {
    const device = await this.#bootedDevice(request.device, signal)
    const args = settingArguments(device.udid, request)
    const output = await this.#run('/usr/bin/xcrun', args, { signal, timeoutMs: 30_000 })
    return { action: request.action, device, output: output.stdout.toString('utf8').trim() || 'completed' }
  }

  async snapshot(deviceSelector: string, signal?: AbortSignal): Promise<IosSimulatorSnapshot> {
    const device = await this.#bootedDevice(deviceSelector, signal)
    const directory = await mkdtemp(join(tmpdir(), 'shun-ios-simulator-'))
    const screenshotPath = join(directory, 'screenshot.png')
    try {
      await this.#run('/usr/bin/xcrun', ['simctl', 'io', device.udid, 'screenshot', '--type=png', screenshotPath], { signal, timeoutMs: 30_000 })
      const png = await readFile(screenshotPath)
      if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw Error('Simulator did not return a valid PNG screenshot.')
      return { device, width: png.readUInt32BE(16), height: png.readUInt32BE(20), screenshot: png.toString('base64') }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  async act(request: IosSimulatorActionRequest, signal?: AbortSignal) {
    const device = await this.#bootedDevice(request.device, signal)
    if (!await this.#ensureAccessibility()) {
      throw Error('Accessibility permission is required for Simulator touch input. Enable Shun in System Settings > Privacy & Security > Accessibility, then retry.')
    }
    await this.#open(device.udid, signal)
    await wait(220, signal)
    const args = driverArguments(request)
    const output = await this.#run(this.#driverPath, args, { signal, timeoutMs: 30_000 })
    await wait(request.waitMs ?? 350, signal)
    return { action: request.action, driver: JSON.parse(output.stdout.toString('utf8')), snapshot: await this.snapshot(device.udid, signal) }
  }

  async #available() {
    const state = await this.state()
    if (!state.connected) throw Error(state.message || 'Xcode Simulator is unavailable.')
  }

  async #device(selectorValue: string, signal?: AbortSignal) {
    const selector = required(selectorValue, 'device').toLowerCase()
    const devices = await this.devices(signal)
    const matches = selector === 'booted'
      ? devices.filter(device => device.state === 'Booted')
      : devices.filter(device => device.udid.toLowerCase() === selector || device.name.toLowerCase() === selector)
    if (!matches.length) throw Error(`iOS Simulator device not found: ${selectorValue}`)
    if (matches.length > 1) throw Error(`iOS Simulator device is ambiguous: ${selectorValue}. Use the UDID from ios_simulator_devices.`)
    return matches[0]
  }

  async #bootedDevice(selector: string, signal?: AbortSignal) {
    const device = await this.#device(selector, signal)
    if (device.state !== 'Booted') throw Error(`iOS Simulator device is not booted: ${device.name} (${device.udid}). Use ios_simulator_device with action=boot first.`)
    return device
  }

  async #open(udid: string, signal?: AbortSignal) {
    await this.#run('/usr/bin/open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid], { signal, timeoutMs: 15_000 })
  }
}

function settingArguments(udid: string, request: IosSimulatorSettingRequest) {
  switch (request.action) {
    case 'appearance': return ['simctl', 'ui', udid, 'appearance', enumValue(request.value, ['light', 'dark'], 'value')]
    case 'increase_contrast': return ['simctl', 'ui', udid, 'increase_contrast', request.enabled === true ? 'enabled' : request.enabled === false ? 'disabled' : required('', 'enabled')]
    case 'content_size': return ['simctl', 'ui', udid, 'content_size', enumValue(request.value, contentSizes, 'value')]
    case 'location': {
      if (request.clear) return ['simctl', 'location', udid, 'clear']
      if (!Number.isFinite(request.latitude) || !Number.isFinite(request.longitude)) throw Error('latitude and longitude are required for an iOS location setting.')
      if (request.latitude! < -90 || request.latitude! > 90 || request.longitude! < -180 || request.longitude! > 180) throw Error('iOS location coordinates are out of range.')
      return ['simctl', 'location', udid, 'set', `${request.latitude},${request.longitude}`]
    }
    case 'permission': {
      const operation = enumValue(request.operation, ['grant', 'revoke', 'reset'], 'operation')
      const service = enumValue(request.service, privacyServices, 'service')
      if (operation !== 'reset' && !request.bundleId) throw Error('bundle_id is required to grant or revoke an iOS permission.')
      return ['simctl', 'privacy', udid, operation, service, ...(request.bundleId ? [request.bundleId] : [])]
    }
    case 'status_bar': {
      if (request.clear) return ['simctl', 'status_bar', udid, 'clear']
      const args = ['simctl', 'status_bar', udid, 'override']
      if (request.time !== undefined) args.push('--time', request.time)
      if (request.dataNetwork !== undefined) args.push('--dataNetwork', enumValue(request.dataNetwork, dataNetworks, 'data_network'))
      if (request.wifiBars !== undefined) args.push('--wifiBars', boundedInteger(request.wifiBars, 0, 3, 'wifi_bars'))
      if (request.cellularBars !== undefined) args.push('--cellularBars', boundedInteger(request.cellularBars, 0, 4, 'cellular_bars'))
      if (request.batteryState !== undefined) args.push('--batteryState', enumValue(request.batteryState, ['charging', 'charged', 'discharging'], 'battery_state'))
      if (request.batteryLevel !== undefined) args.push('--batteryLevel', boundedInteger(request.batteryLevel, 0, 100, 'battery_level'))
      if (args.length === 4) throw Error('At least one status bar override is required, or set clear=true.')
      return args
    }
    default: throw Error(`Unsupported iOS Simulator setting: ${String(request.action)}`)
  }
}

function driverArguments(request: IosSimulatorActionRequest) {
  switch (request.action) {
    case 'tap': return ['tap', normalized(request.x, 'x'), normalized(request.y, 'y')]
    case 'swipe': return ['swipe', normalized(request.x, 'x'), normalized(request.y, 'y'), normalized(request.endX, 'end_x'), normalized(request.endY, 'end_y'), boundedInteger(request.durationMs ?? 350, 100, 2_000, 'duration_ms')]
    case 'type': return ['type', Buffer.from(required(request.text, 'text'), 'utf8').toString('base64')]
    case 'button': return ['button', enumValue(request.button, ['home', 'lock', 'shake', 'app_switcher', 'rotate_left', 'rotate_right'], 'button')]
    default: throw Error(`Unsupported iOS Simulator interaction: ${String(request.action)}`)
  }
}

export async function runIosCommand(command: string, args: string[], options: { signal?: AbortSignal; maxBytes?: number; timeoutMs?: number } = {}): Promise<IosCommandResult> {
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
    const abort = () => { child.kill('SIGTERM'); finish(Error('iOS Simulator operation was cancelled.')) }
    const timer = options.timeoutMs ? setTimeout(() => { child.kill('SIGTERM'); finish(Error(`iOS Simulator operation timed out after ${options.timeoutMs} ms.`)) }, options.timeoutMs) : undefined
    timer?.unref()
    if (options.signal?.aborted) return abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', data => {
      const chunk = Buffer.from(data); bytes += chunk.length
      if (bytes > maxBytes) { child.kill('SIGTERM'); finish(Error('iOS Simulator output exceeded the safe size limit.')) } else stdout.push(chunk)
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

const contentSizes = ['extra-small', 'small', 'medium', 'large', 'extra-large', 'extra-extra-large', 'extra-extra-extra-large', 'accessibility-medium', 'accessibility-large', 'accessibility-extra-large', 'accessibility-extra-extra-large', 'accessibility-extra-extra-extra-large']
const privacyServices = ['all', 'calendar', 'contacts-limited', 'contacts', 'location', 'location-always', 'photos-add', 'photos', 'media-library', 'microphone', 'motion', 'reminders', 'siri']
const dataNetworks = ['hide', 'wifi', '3g', '4g', 'lte', 'lte-a', 'lte+', '5g', '5g+', '5g-uwb', '5g-uc']

function clean(value: unknown) { return typeof value === 'string' ? value.trim() : '' }
function required(value: unknown, name: string) { const text = clean(value); if (!text) throw Error(`${name} is required.`); return text }
function enumValue<T extends string>(value: unknown, allowed: readonly T[], name: string): T { const text = required(value, name) as T; if (!allowed.includes(text)) throw Error(`${name} must be one of: ${allowed.join(', ')}.`); return text }
function boundedInteger(value: unknown, minimum: number, maximum: number, name: string) { const number = Number(value); if (!Number.isInteger(number) || number < minimum || number > maximum) throw Error(`${name} must be an integer from ${minimum} through ${maximum}.`); return String(number) }
function normalized(value: unknown, name: string) { const number = Number(value); if (!Number.isFinite(number) || number < 0 || number > 1) throw Error(`${name} must be a normalized coordinate from 0 through 1.`); return String(number) }
function validUrl(value: unknown) { const text = required(value, 'url'); try { return new URL(text).href } catch { throw Error('url must be an absolute URL.') } }
function runtimeName(value: string) { const suffix = value.split('.SimRuntime.')[1] || value; const [platform, ...version] = suffix.split('-'); return `${platform} ${version.join('.')}`.trim() }
function simulatorError(error: unknown) { const message = error instanceof Error ? error.message : String(error); return `Xcode Simulator is unavailable: ${message}` }
function wait(milliseconds: number, signal?: AbortSignal) { return new Promise<void>((resolvePromise, rejectPromise) => { const timer = setTimeout(done, Math.max(0, Math.min(5_000, milliseconds))); function done() { signal?.removeEventListener('abort', abort); resolvePromise() } function abort() { clearTimeout(timer); rejectPromise(Error('iOS Simulator operation was cancelled.')) } if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true }) }) }
