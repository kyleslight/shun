import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { IosSimulatorService, type IosCommandRunner } from './ios-simulator.ts'

const udid = 'E551ED2E-D48E-4AC6-976B-D1305F112A6B'
const deviceList = Buffer.from(JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid, name: 'iPhone 16 Pro', state: 'Booted', isAvailable: true, lastBootedAt: '2026-08-23T17:30:57Z' }],
    'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [{ udid: 'TV', name: 'Apple TV', state: 'Shutdown', isAvailable: true }],
  },
}))

function png(width = 1179, height = 2556) {
  const value = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(value)
  value.writeUInt32BE(width, 16)
  value.writeUInt32BE(height, 20)
  return value
}

function harness(host = 'Simulator.app') {
  const calls: Array<{ command: string; args: string[] }> = []
  const run: IosCommandRunner = async (command, args) => {
    calls.push({ command, args })
    if (command === '/usr/bin/xcode-select') return { stdout: Buffer.from('/Applications/Xcode.app/Contents/Developer\n'), stderr: '' }
    if (command === '/usr/bin/xcodebuild') return { stdout: Buffer.from('Xcode 26.6\nBuild version 17F113\n'), stderr: '' }
    if (args.join(' ') === '--find simctl') return { stdout: Buffer.from('/Applications/Xcode.app/usr/bin/simctl\n'), stderr: '' }
    if (args.join(' ') === 'simctl list devices available -j') return { stdout: deviceList, stderr: '' }
    if (args.includes('screenshot')) { await writeFile(args.at(-1)!, png()); return { stdout: Buffer.from('completed\n'), stderr: '' } }
    if (command === '/mock/ios-driver') return { stdout: Buffer.from('{"ok":true,"action":"tap","display":{"width":402,"height":874}}'), stderr: '' }
    return { stdout: Buffer.from('completed\n'), stderr: '' }
  }
  return { calls, run, service: new IosSimulatorService({ driverPath: '/mock/ios-driver', platform: 'darwin', run, ensureAccessibility: () => true, pathExists: async path => path.endsWith('/' + host) }) }
}

test('iOS Simulator plugin reports local Xcode state and only lists iOS devices', async () => {
  const { service } = harness()
  assert.deepEqual(await service.state(), {
    connected: true,
    status: 'connected',
    account: 'Xcode 26.6',
    message: 'Uses the local Xcode Simulator runtime. Touch input requires macOS Accessibility permission for Shun.',
  })
  assert.deepEqual(await service.devices(), [{
    udid,
    name: 'iPhone 16 Pro',
    runtime: 'iOS 18.0',
    state: 'Booted',
    available: true,
    lastBootedAt: '2026-08-23T17:30:57Z',
  }])
})

test('iOS visual states use structured simctl operations instead of application code changes', async () => {
  const { calls, service } = harness()
  await service.setting({ action: 'appearance', device: udid, value: 'light' })
  await service.setting({ action: 'content_size', device: udid, value: 'accessibility-large' })
  assert.ok(calls.some(call => call.args.join(' ') === `simctl ui ${udid} appearance light`))
  assert.ok(calls.some(call => call.args.join(' ') === `simctl ui ${udid} content_size accessibility-large`))
})

test('iOS interaction maps normalized input through the native driver and returns a fresh screenshot', async () => {
  const { calls, service } = harness()
  const result = await service.act({ action: 'tap', device: udid, x: 0.5, y: 0.75, waitMs: 0 })
  assert.ok(calls.some(call => call.command === '/mock/ios-driver' && call.args.join(' ') === `tap 0.5 0.75 --device-udid ${udid} --device-name iPhone 16 Pro --device-runtime iOS 18.0`))
  assert.equal(result.snapshot.width, 1179)
  assert.equal(result.snapshot.height, 2556)
  assert.equal(result.snapshot.screenshot, png().toString('base64'))
  assert.equal(calls.filter(call => call.args.join(' ') === 'simctl list devices available -j').length, 1, 'one action resolves its device once, including the resulting observation')
})

test('iOS touch input fails with an actionable Accessibility boundary', async () => {
  const { run } = harness()
  const service = new IosSimulatorService({
    driverPath: '/mock/ios-driver', platform: 'darwin',
    run,
    ensureAccessibility: () => false,
  })
  await assert.rejects(service.act({ action: 'tap', device: udid, x: 0.5, y: 0.5, waitMs: 0 }), /Accessibility permission.*System Settings/i)
})

test('iOS observation returns controls in device coordinates with the same screenshot', async () => {
  const { run } = harness()
  const controls = [{ role: 'AXButton', label: 'Close', x: 0.9, y: 0.2, width: 0.1, height: 0.05 }]
  const service = new IosSimulatorService({ driverPath: '/mock/ios-driver', platform: 'darwin',
    run: async (command, args, options) => args[0] === 'inspect'
      ? { stdout: Buffer.from(JSON.stringify({ controls })), stderr: '' } : run(command, args, options),
  })
  const result = await service.snapshot(udid)
  assert.deepEqual(result.controls, controls)
  assert.equal(result.width, 1179)
  assert.equal(result.controlsUnavailable, undefined)
})

test('control inspection failure preserves screenshots and reports the actual limitation', async () => {
  const { run } = harness()
  const service = new IosSimulatorService({ driverPath: '/mock/ios-driver', platform: 'darwin',
    run: async (command, args, options) => {
      if (args[0] === 'inspect') throw Error('Selected display unavailable')
      return run(command, args, options)
    },
  })
  const result = await service.snapshot(udid)
  assert.equal(result.screenshot, png().toString('base64'))
  assert.match(result.controlsUnavailable!, /Selected display unavailable/)
  assert.equal(result.controls, undefined)
})

for (const host of ['Simulator.app', 'DeviceHub.app']) {
  test(`iOS interaction opens the selected Xcode device host: ${host}`, async () => {
    const { service, calls } = harness(host)
    await service.act({ action: 'tap', device: udid, x: 0.5, y: 0.5, waitMs: 0 })
    assert.ok(calls.some(call => call.command === '/usr/bin/open' && call.args[1].endsWith('/' + host)))
  })
}

test('iOS input reports a missing interactive host before sending input', async () => {
  const { service, calls } = harness('Missing.app')
  await assert.rejects(service.act({ action: 'tap', device: udid, x: 0.5, y: 0.5, waitMs: 0 }), /interactive device host is missing/)
  assert.ok(!calls.some(call => call.command === '/mock/ios-driver'))
})

test('iOS boot does not claim an opened device without an interactive display', async () => {
  const { run } = harness()
  const service = new IosSimulatorService({ driverPath: '/mock/ios-driver', platform: 'darwin', pathExists: async () => true,
    run: async (command, args, options) => {
      if (command === '/mock/ios-driver') throw Error('Selected device has no interactive display. No input was sent.')
      return run(command, args, options)
    },
  })
  await assert.rejects(service.boot(udid), /no interactive display/)
})
