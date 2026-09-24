import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { DesktopControlService, type DesktopCommandRunner } from './desktop-control.ts'

const frontWindow = { id: 412, pid: 900, app: 'Notes', title: 'Untitled', layer: 0, x: 120, y: 80, width: 800, height: 600 }
const windowList = Buffer.from(JSON.stringify({
  frontmost: { app: 'Notes', pid: 900, bundle_id: 'com.apple.Notes' },
  display: { x: 0, y: 0, width: 1920, height: 1080 },
  windows: [frontWindow, { id: 118, pid: 44, app: 'Finder', title: 'Downloads', layer: 0, x: 0, y: 0, width: 700, height: 500 }],
}))
const probe = Buffer.from(JSON.stringify({
  ok: true,
  accessibility: true,
  screen_recording: true,
  user_idle_ms: 42_000,
  capture: { supported: true, displays: 1, windows: 12 },
  display: { x: 0, y: 0, width: 1920, height: 1080 },
  frontmost: 'Notes',
}))

function png(width = 1600, height = 1200) {
  const value = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(value)
  value.writeUInt32BE(width, 16)
  value.writeUInt32BE(height, 20)
  return value
}

function harness(overrides: { probe?: Record<string, unknown>; idleMs?: number; idleAfterAct?: number; snapshotError?: string } = {}) {
  const calls: Array<{ command: string; args: string[] }> = []
  let acted = false
  const run: DesktopCommandRunner = async (command, args) => {
    calls.push({ command, args })
    if (args[0] === 'probe') {
      const value = { ...JSON.parse(probe.toString('utf8')), ...(overrides.probe || {}) }
      // Real input, including Shun's own synthetic click, resets the idle clock, so
      // the mock does the same: after an action the idle reading is our own event.
      const idle = acted ? overrides.idleAfterAct ?? overrides.idleMs : overrides.idleMs
      if (idle !== undefined) value.user_idle_ms = idle
      return { stdout: Buffer.from(JSON.stringify(value)), stderr: '' }
    }
    if (args[0] === 'windows') return { stdout: windowList, stderr: '' }
    if (args[0] === 'elements') {
      return {
        stdout: Buffer.from(JSON.stringify({
          ok: true,
          window: frontWindow,
          display: { x: 0, y: 0, width: 1920, height: 1080 },
          truncated: false,
          elements: [
            { ref: '0', role: 'AXButton', subrole: '', title: 'RIGHT', description: '', value: '', enabled: true, focused: false, pressable: true, x: 300, y: 110, width: 200, height: 90 },
            { ref: '1', role: 'AXTextField', subrole: '', title: '', description: '', value: 'typed', enabled: true, focused: true, pressable: false, x: 300, y: 220, width: 200, height: 40 },
          ],
        })),
        stderr: '',
      }
    }
    if (args[0] === 'press') return { stdout: Buffer.from(JSON.stringify({ ok: true, action: 'press', performed: { ref: args[3], role: 'AXButton', title: 'RIGHT' }, window: frontWindow, display: { x: 0, y: 0, width: 1920, height: 1080 } })), stderr: '' }
    if (args[0] === 'set-value') return { stdout: Buffer.from(JSON.stringify({ ok: true, action: 'set_value', performed: { ref: args[3], role: 'AXTextField', title: '' }, window: frontWindow, display: { x: 0, y: 0, width: 1920, height: 1080 } })), stderr: '' }
    if (args[0] === 'snapshot') {
      if (overrides.snapshotError) throw Error(overrides.snapshotError)
      await writeFile(args[args.indexOf('--out') + 1], png())
      return {
        stdout: Buffer.from(JSON.stringify(args[2] === 'screen'
          ? { ok: true, target: 'screen', display: { x: 0, y: 0, width: 1920, height: 1080 } }
          : { ok: true, target: 'window', window: frontWindow, display: { x: 0, y: 0, width: 1920, height: 1080 } })),
        stderr: '',
      }
    }
    acted = true
    return { stdout: Buffer.from(JSON.stringify({ ok: true, action: args[2], target: frontWindow, bounds: frontWindow })), stderr: '' }
  }
  return { calls, run, service: new DesktopControlService({ driverPath: '/mock/desktop-driver', platform: 'darwin', run, ensureAccessibility: () => true }) }
}

test('Computer Use reports the real macOS permissions and the application in front', async () => {
  const { service } = harness()
  assert.deepEqual(await service.state(), {
    connected: true,
    status: 'connected',
    account: 'Notes',
    message: 'Drives this Mac through on-screen windows and real input. Notes is in front.',
  })
})

test('a missing macOS permission is named where the person can act on it', async () => {
  const blocked = harness({ probe: { accessibility: false, screen_recording: false } })
  assert.deepEqual(await blocked.service.state(), {
    connected: false,
    status: 'error',
    message: 'Shun needs Accessibility and Screen Recording permission before it can look at or act on this Mac: System Settings > Privacy & Security.',
  })

  const locked = harness({ probe: { capture: { supported: true, displays: 0, windows: 9 } } })
  assert.match(String((await locked.service.state()).message), /No display is capturable.*locked screen/i)

  const { run } = harness()
  const service = new DesktopControlService({ driverPath: '/mock/desktop-driver', platform: 'darwin', run, ensureAccessibility: () => false })
  await assert.rejects(service.act({ action: 'click', x: 0.5, y: 0.5 }), /Accessibility permission.*System Settings/i)
})

test('Computer Use lists held windows with exact ids and geometry', async () => {
  const { service } = harness()
  const list = await service.windows()
  assert.equal(list.frontmost.app, 'Notes')
  assert.equal(list.display.width, 1920)
  assert.deepEqual(list.windows.map(item => [item.id, item.app, item.width]), [[412, 'Notes', 800], [118, 'Finder', 700]])
})

test('acting on this Mac maps normalized coordinates through the target window and returns a fresh capture', async () => {
  const { calls, service } = harness()
  const result = await service.act({ action: 'click', window: '412', x: 0.5, y: 0.25 })
  assert.ok(calls.some(call => call.command === '/mock/desktop-driver' && call.args.join(' ') === 'act --action click --window 412 --x 0.5 --y 0.25'))
  // The screenshot after an action belongs to the window that was acted on, so a
  // model never reasons about a surface it did not touch.
  const snapshots = calls.filter(call => call.args[0] === 'snapshot')
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].args[2], '412')
  const snapshot = result.snapshot
  assert.ok(snapshot)
  assert.equal(snapshot.target, 'window')
  assert.equal(snapshot.window?.id, 412)
  assert.equal(snapshot.width, 1600)
  assert.equal(snapshot.screenshot, png().toString('base64'))
})

test('a keystroke reports the frontmost window because a key has no window of its own', async () => {
  const { calls, service } = harness()
  await service.act({ action: 'key', key: 'return', flags: 'cmd,shift' })
  assert.ok(calls.some(call => call.args.join(' ') === 'act --action key --key return --flags cmd,shift'))
  assert.ok(calls.some(call => call.args[0] === 'snapshot' && call.args[2] === 'frontmost'))
})

test('Computer Use refuses to send input while the person is using this computer', async () => {
  const busy = harness({ idleMs: 120 })
  await assert.rejects(busy.service.act({ action: 'type', text: 'hello' }), /person using this computer is active right now.*no click or keystroke was sent/i)
  assert.equal(busy.calls.some(call => call.args[0] === 'act'), false)

  // An action taken by Shun itself also counts as input, so its own recent click
  // must never be mistaken for the person working.
  const own = harness({ idleMs: 42_000, idleAfterAct: 30 })
  await own.service.act({ action: 'click', x: 0.5, y: 0.5 })
  await own.service.act({ action: 'click', x: 0.5, y: 0.5 })
  assert.equal(own.calls.filter(call => call.args[0] === 'act').length, 2)
})

test('Computer Use refuses to act when the screen cannot be captured, because blind input is not computer use', async () => {
  const locked = harness({ probe: { capture: { supported: true, displays: 0, windows: 9 } } })
  await assert.rejects(locked.service.act({ action: 'click', x: 0.5, y: 0.5 }), /screen cannot be captured right now, so the action was not sent/i)
  assert.equal(locked.calls.some(call => call.args[0] === 'act'), false)
})

test('an action that was sent but could not be observed is reported as taken and unverified', async () => {
  const { calls, service } = harness({ snapshotError: 'Screen capture failed: the display went to sleep.' })
  const value = await service.act({ action: 'click', window: '412', x: 0.5, y: 0.5 })
  assert.equal(value.action, 'click')
  assert.equal(value.snapshot, undefined)
  assert.match(String(value.captureError), /display went to sleep/i)
  assert.equal(calls.filter(call => call.args[0] === 'act').length, 1)
})

test('input arguments are validated before anything is sent to the desktop', async () => {
  const { calls, service } = harness()
  await assert.rejects(service.act({ action: 'click', x: 1.4, y: 0.5 }), /x must be a normalized coordinate/i)
  await assert.rejects(service.act({ action: 'type', text: '' }), /text is required/i)
  await assert.rejects(service.act({ action: 'key', key: ' ' }), /key is required/i)
  await assert.rejects(service.act({ action: 'drag', x: 0.1, y: 0.1, toX: 0.2, toY: 0.2, durationMs: 20_000 }), /duration_ms must be an integer from 100 through 5000/i)
  assert.equal(calls.some(call => call.args[0] === 'act'), false)
})

test('each desktop platform reports its own limit instead of a shared one', async () => {
  const { run } = harness()
  const mac = new DesktopControlService({ driverPath: '/mock/desktop-driver', platform: 'darwin', run, ensureAccessibility: () => true })
  assert.equal(String((await mac.windows()).frontmost.app), 'Notes')

  const pc = new DesktopControlService({ driverPath: '/mock/desktop-driver', platform: 'win32', run })
  const pcState = await pc.state()
  assert.equal(pcState.connected, true)
  // Windows has no permission gate, but an elevated application is a real limit.
  assert.match(String(pcState.message), /application that runs elevated cannot receive input/i)

  const x11 = new DesktopControlService({ driverPath: '/mock/desktop-driver', platform: 'linux', run })
  assert.match(String((await x11.state()).message), /over X11/i)
})

test('a Wayland session is reported as the limit it is, not as a broken capability', async () => {
  const { run } = harness()
  const wayland = new DesktopControlService({
    driverPath: '/mock/desktop-driver', platform: 'linux',
    run: async (command, args, options) => {
      if (args[0] === 'probe') throw Error('this is a Wayland session, and Shun does not capture or control Wayland desktops yet')
      return run(command, args, options)
    },
  })
  const state = await wayland.state()
  assert.equal(state.connected, false)
  assert.match(String(state.message), /Wayland session.*does not capture or control Wayland desktops yet/i)
})

test('an unknown idle reading skips the user-activity guard instead of blocking every action', async () => {
  // X11 servers that do not answer MIT-SCREEN-SAVER report -1, and a guard that
  // could not tell has no business refusing work.
  const { calls, service } = harness({ idleMs: -1 })
  await service.act({ action: 'click', x: 0.5, y: 0.5 })
  assert.equal(calls.filter(call => call.args[0] === 'act').length, 1)
})

test('a platform with no desktop driver is refused in Shun words', async () => {
  const { run } = harness()
  const service = new DesktopControlService({ driverPath: '/mock/desktop-driver', platform: 'freebsd', run })
  const state = await service.state()
  assert.equal(state.connected, false)
  assert.match(String(state.message), /not available on freebsd/i)
  await assert.rejects(service.snapshot(), /not available on freebsd/i)
})

test('a control read from the window is what a press is checked against', async () => {
  const { calls, service } = harness()
  const tree = await service.elements({ window: '412' })
  assert.equal(tree.window.id, 412)
  assert.equal(tree.truncated, false)
  assert.deepEqual(tree.elements.map(element => [element.ref, element.role, element.title, element.pressable]), [
    ['0', 'AXButton', 'RIGHT', true],
    ['1', 'AXTextField', '', false],
  ])
  // The expectation the driver checks before acting is the reading this service
  // itself returned, not anything the model remembers.
  await service.act({ action: 'press', window: '412', ref: '0' })
  assert.ok(calls.some(call => call.args.join(' ') === 'press --window 412 --ref 0 --expect-role AXButton --expect-title RIGHT --expect-frame 300,110,200,90'))
})

test('a ref from no reading, or from another window, is refused before anything is pressed', async () => {
  const { calls, service } = harness()
  await assert.rejects(service.act({ action: 'press', window: '412', ref: '0' }), /not in a reading this session made of window 412/)
  await service.elements({ window: '412' })
  await assert.rejects(service.act({ action: 'press', window: '118', ref: '0' }), /not in a reading this session made of window 118/)
  await assert.rejects(service.act({ action: 'press', window: '412', ref: '9' }), /not in a reading this session made of window 412/)
  await assert.rejects(service.act({ action: 'press', window: '412' }), /ref is required/)
  await assert.rejects(service.act({ action: 'set_value', window: '412', ref: '1' }), /value is required/)
  assert.equal(calls.some(call => call.args[0] === 'press' || call.args[0] === 'set-value'), false)
})

test('setting a value acts on the read control and carries its identity', async () => {
  const { calls, service } = harness()
  await service.elements({ window: '412' })
  const result = await service.act({ action: 'set_value', window: '412', ref: '1', value: 'hello' })
  assert.equal(result.action, 'set_value')
  assert.ok(calls.some(call => call.args.join(' ') === 'set-value --window 412 --ref 1 --value hello --expect-role AXTextField --expect-title  --expect-frame 300,220,200,40'))
  assert.ok(result.snapshot)
})

test('a platform without an element tree says so instead of returning an empty reading', async () => {
  const { run } = harness()
  const pc = new DesktopControlService({ driverPath: '/mock/desktop-driver', platform: 'win32', run })
  assert.equal(pc.supportsElements(), false)
  await assert.rejects(pc.elements({ window: '412' }), /not implemented for win32 yet/)
  await assert.rejects(pc.act({ action: 'press', window: '412', ref: '0' }), /needs an accessibility tree, which win32 does not implement yet/)
})
