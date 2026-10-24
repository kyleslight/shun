import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { DesktopControlService, type DesktopCommandRunner } from './desktop-control.ts'
import { desktopSequenceResult } from './desktop-tool-results.ts'

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
  frontmost_bundle_id: 'com.apple.Notes',
}))

function png(width = 1600, height = 1200) {
  const value = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(value)
  value.writeUInt32BE(width, 16)
  value.writeUInt32BE(height, 20)
  return value
}

function harness(overrides: { probe?: Record<string, unknown>; idleMs?: number; idleAfterAct?: number; snapshotError?: string; depthLimited?: boolean; buttonEnabled?: boolean; elements?: Record<string, unknown>[] } = {}) {
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
          depth_limited: overrides.depthLimited === true,
          elements: overrides.elements ?? [
            { ref: '0', role: 'AXButton', subrole: '', title: 'RIGHT', description: '', value: '', enabled: overrides.buttonEnabled !== false, focused: false, pressable: true, x: 300, y: 110, width: 200, height: 90 },
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
  assert.equal((await service.permissions()).frontmostBundleId, 'com.apple.Notes')
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
  assert.deepEqual(tree.elements.map(element => [element.role, element.title, element.pressable]), [
    ['AXButton', 'RIGHT', true],
    ['AXTextField', '', false],
  ])
  assert.match(tree.elements[0].ref, /^d:412:[a-z0-9]+:1$/)
  // The expectation the driver checks before acting is the reading this service
  // itself returned, not anything the model remembers.
  const result = await service.act({ action: 'press', ref: tree.elements[0].ref })
  assert.equal(result.driver.performed.ref, tree.elements[0].ref)
  assert.ok(calls.some(call => call.args.join(' ') === 'press --window 412 --ref 0 --expect-role AXButton --expect-title RIGHT --expect-frame 300,110,200,90'))
})

test('a ref from no reading, or from another window, is refused before anything is pressed', async () => {
  const { calls, service } = harness()
  await assert.rejects(service.act({ action: 'press', window: '412', ref: '0' }), /not in a reading this session made of window 412/)
  const tree = await service.elements({ window: '412' })
  await assert.rejects(service.act({ action: 'press', window: '118', ref: tree.elements[0].ref }), /not in a reading this session made of window 118/)
  await assert.rejects(service.act({ action: 'press', window: '412', ref: '9' }), /not in a reading this session made of window 412/)
  await assert.rejects(service.act({ action: 'press', window: '412' }), /ref is required/)
  await assert.rejects(service.act({ action: 'set_value', ref: tree.elements[1].ref }), /value is required/)
  assert.equal(calls.some(call => call.args[0] === 'press' || call.args[0] === 'set-value'), false)
})

test('a named control query preserves the exact target and guarded native action among many unrelated controls', async () => {
  const unrelated = Array.from({ length: 190 }, (_, index) => ({ ref: String(index), role: 'AXRadioButton', title: `Unrelated tab ${index}`, context: 'Reload toolbar', value: 'Reload', enabled: true, pressable: true, x: 20, y: 20, width: 20, height: 20 }))
  const target = { ref: '191', role: 'AXButton', title: 'Reload', description: 'Reload extension', context: 'Extensions detail', value: '', enabled: true, pressable: true, x: 300, y: 110, width: 200, height: 90 }
  const { service, calls } = harness({ elements: [...unrelated, target] })
  const tree = await service.elements({ window: '412', query: 'reLOAD' })
  assert.equal(tree.elements.length, 1)
  assert.deepEqual(tree.filter, { query: 'reLOAD', matched: 1, scanned: 191 })
  assert.equal(tree.elements[0].title, target.title)
  assert.equal(tree.elements[0].context, target.context)
  assert.equal(tree.elements[0].x, target.x)
  assert.equal(tree.truncated, false)
  const read = calls.find(call => call.args[0] === 'elements')!
  assert.equal(read.args[read.args.indexOf('--max') + 1], '400')
  await service.act({ action: 'press', ref: tree.elements[0].ref }, undefined, { capture: 'none' })
  assert.ok(calls.some(call => call.args.join(' ') === 'press --window 412 --ref 191 --expect-role AXButton --expect-title Reload --expect-frame 300,110,200,90'))
})

test('query result limits disclose omitted matches and a missing query does not imply absence', async () => {
  const f = harness({ elements: Array.from({ length: 4 }, (_, index) => ({ ref: String(index), role: 'AXButton', title: 'Continue', context: `Dialog ${index}`, pressable: true })) })
  const limited = await f.service.elements({ query: 'Continue', max: 2 })
  assert.equal(limited.elements.length, 2)
  assert.equal(limited.filter?.matched, 4)
  assert.equal(limited.truncated, true)
  const missing = await f.service.elements({ query: 'Finish' })
  assert.equal(missing.elements.length, 0)
  assert.match(missing.observationNote!, /missing match does not establish/)
})

test('setting a value acts on the read control and carries its identity', async () => {
  const { calls, service } = harness()
  const tree = await service.elements({ window: '412' })
  const result = await service.act({ action: 'set_value', ref: tree.elements[1].ref, value: 'hello' })
  assert.equal(result.action, 'set_value')
  assert.ok(calls.some(call => call.args.join(' ') === 'set-value --window 412 --ref 1 --value hello --expect-role AXTextField --expect-title  --expect-frame 300,220,200,40'))
  assert.ok(result.snapshot)
})

test('a disabled native control refuses input even when it exposes a press action', async () => {
  const { calls, service } = harness({ buttonEnabled: false })
  const tree = await service.elements({ window: '412' })
  assert.equal(tree.elements[0].pressable, true)
  for (const action of ['press', 'set_value'] as const) {
    await assert.rejects(service.act({ action, ref: tree.elements[0].ref, value: 'must not enter' }), /not enabled.*No input was sent/)
  }
  assert.equal(calls.some(call => ['press', 'set-value', 'act'].includes(call.args[0])), false)
})

test('a non-pressable native field is not treated as a button', async () => {
  const { calls, service } = harness()
  const tree = await service.elements({ window: '412' })
  await assert.rejects(service.act({ action: 'press', ref: tree.elements[1].ref }), /does not offer a press action/)
  assert.equal(calls.some(call => call.args[0] === 'press'), false)
})

test('a platform without an element tree says so instead of returning an empty reading', async () => {
  const { run } = harness()
  const pc = new DesktopControlService({ driverPath: '/mock/desktop-driver', platform: 'win32', run })
  assert.equal(pc.supportsElements(), false)
  await assert.rejects(pc.elements({ window: '412' }), /not implemented for win32 yet/)
  await assert.rejects(pc.act({ action: 'press', window: '412', ref: '0' }), /needs an accessibility tree, which win32 does not implement yet/)
})

test('a known sequence runs in one call and is observed once', async () => {
  const { calls, service } = harness()
  const started = Date.now()
  const result = await service.actSequence([
    { action: 'key', key: 'g', flags: 'cmd,shift' },
    { action: 'type', text: 'a path' },
    { action: 'key', key: 'return' },
  ], { capture: 'screenshot' })
  assert.deepEqual(result.steps?.map(step => step.action), ['key', 'type', 'key'])
  // One driver call per step and exactly one capture for the whole sequence: the
  // per-step settle and capture are what made a visible sequence feel slow.
  assert.equal(calls.filter(call => call.args[0] === 'act').length, 3)
  assert.equal(calls.filter(call => call.args[0] === 'snapshot').length, 1)
  assert.ok(result.snapshot)
  const presented = desktopSequenceResult(result)
  const receipt = JSON.parse(presented.content[0].type === 'text' ? presented.content[0].text : '')
  assert.equal(receipt.capture.target, 'window')
  assert.deepEqual(receipt.capture.window, { ...frontWindow, onScreen: true })
  assert.deepEqual(receipt.capture.geometry, { x: 120, y: 80, width: 800, height: 600 })
  assert.equal(receipt.capture.screenshot, undefined, 'pixels are a separate image part')
  assert.equal(presented.content[1].type, 'image')
  assert.ok(Date.now() - started < 2_000, 'a three-step sequence should not take seconds')
})

test('a sequence can observe controls instead of pixels, or nothing at all', async () => {
  const { calls, service } = harness()
  const tree = await service.elements({ window: '412' })
  const asControls = await service.actSequence([{ action: 'press', ref: tree.elements[0].ref }], { capture: 'elements' })
  assert.equal(calls.filter(call => call.args[0] === 'snapshot').length, 0, 'controls are read without a screenshot')
  assert.equal(asControls.tree?.elements.length, 2)

  const { calls: quietCalls, service: quiet } = harness()
  const nothing = await quiet.actSequence([{ action: 'click', x: 0.5, y: 0.5 }], { capture: 'none' })
  assert.equal(quietCalls.filter(call => call.args[0] === 'snapshot').length, 0)
  assert.equal(nothing.snapshot, undefined)
  assert.equal(nothing.steps?.length, 1)
})

test('a failing step stops the sequence instead of running the rest of it', async () => {
  const { run, calls } = harness()
  const service = new DesktopControlService({ driverPath: '/mock/desktop-driver', platform: 'darwin', run, ensureAccessibility: () => true })
  const result = await service.actSequence([{ action: 'key', key: 'g' }, { action: 'press', window: '412', ref: 'not-read' }, { action: 'key', key: 'return' }])
  assert.deepEqual(result.steps.map(step => step.action), ['key'])
  assert.equal(result.stopped?.step, 2)
  assert.equal(result.stopped?.action, 'press')
  assert.match(result.stopped?.reason || '', /not in a reading this session made/)
  assert.match(result.note || '', /earlier steps above already completed/)
  assert.equal(calls.filter(call => call.args[0] === 'act').length, 1, 'the steps after the failure were not performed')
})

test('a foreground change inside a native sequence preserves completed receipts without replaying input', async () => {
  const h = harness()
  let clicked = false
  const service = new DesktopControlService({ driverPath: '/mock/desktop-driver', platform: 'darwin', requireObservation: true,
    run: async (command, args, options) => {
      const result = await h.run(command, args, options)
      if (args[0] === 'act') clicked = true
      if (clicked && args[0] === 'windows') {
        const current = JSON.parse(result.stdout.toString())
        current.frontmost = { app: 'Finder', pid: 44, bundle_id: 'com.apple.finder' }
        return { ...result, stdout: Buffer.from(JSON.stringify(current)) }
      }
      return result
    } })
  await service.snapshot({ window: '412' })
  const result = await service.actSequence([
    { action: 'click', window: '412', x: 0.5, y: 0.5 },
    { action: 'key', window: '412', key: 'a', flags: 'cmd' },
    { action: 'type', window: '412', text: 'must not reach another app' },
  ])
  assert.deepEqual(result.steps.map(step => step.action), ['click'])
  assert.equal(result.stopped?.step, 2)
  assert.match(result.stopped?.reason || '', /No current native observation/)
  assert.equal(h.calls.filter(call => call.args[0] === 'act').length, 1)
  const shown = desktopSequenceResult(result)
  const receipt = JSON.parse(shown.content[0].type === 'text' ? shown.content[0].text : '')
  assert.equal(receipt.steps[0].action, 'click')
  assert.equal(receipt.stopped.step, 2)
  assert.match(receipt.note, /do not replay completed steps/)
  assert.equal(shown.content.length, 1, 'a stopped sequence does not silently capture another foreground app')
})

/**
 * The screen is a target in its own right.
 *
 * A cookie wall or a consent modal drawn over everything is part of the display, not part of any
 * window. Rewriting `screen` to the frontmost window sent the click into that window instead —
 * a different action, silently, which is how a reachable overlay became an reported wall.
 */
test('an action may act on the display itself, and is observed there', async () => {
  const { calls, service } = harness()
  const result = await service.act({ action: 'click', window: 'screen', x: 0.5, y: 0.92 })
  assert.ok(calls.some(call => call.args.join(' ') === 'act --action click --window screen --x 0.5 --y 0.92'), calls.map(call => call.args.join(' ')).join(' | '))
  const snapshots = calls.filter(call => call.args[0] === 'snapshot')
  assert.equal(snapshots.length, 1)
  // The reading after the action is the surface that was acted on: the display.
  assert.equal(snapshots[0].args[2], 'screen')
  assert.ok(result.snapshot)
})

test('the window list can include windows that are not on this screen, and says which are', async () => {
  const { calls, service } = harness()
  const list = await service.windows(undefined, { all: true })
  assert.ok(calls.some(call => call.args.join(' ') === 'windows --all'))
  assert.equal(list.windows.every(window => typeof window.onScreen === 'boolean'), true)
})

test('an application that is not on this screen is brought here by name', async () => {
  const { calls, service } = harness()
  await service.act({ action: 'focus', app: 'Google Chrome' })
  assert.ok(calls.some(call => call.args.join(' ') === 'focus --app Google Chrome'), calls.map(call => call.args.join(' ')).join(' | '))
})


test('native control readings reach nested webpage controls by default and disclose shallow limits', async () => {
  const f = harness()
  await f.service.elements({ window: '412' })
  const args = f.calls.find(call => call.args[0] === 'elements')!.args
  assert.equal(args[args.indexOf('--depth') + 1], '20')
  const shallow = harness({ depthLimited: true })
  const tree = await shallow.service.elements({ window: '412', depth: 6 })
  assert.equal(tree.truncated, true)
  assert.equal(tree.depthLimited, true)
  assert.equal(tree.depthLimit, 6)
})

test('a new native reading never reassigns an old public handle to a different control', async () => {
  const { calls, service } = harness()
  const first = await service.elements({ window: '412' })
  const next = await service.elements({ window: '412' })
  assert.notEqual(first.elements[0].ref, next.elements[0].ref)
  await assert.rejects(service.act({ action: 'press', ref: first.elements[0].ref }), /not in a reading/)
  assert.equal(calls.some(call => call.args[0] === 'press'), false)
  await service.act({ action: 'press', ref: next.elements[0].ref })
  assert.ok(calls.some(call => call.args.join(' ').startsWith('press --window 412 --ref 0 ')))
})


test('native handles cannot bind to a new controller after restart', async () => {
  const first = harness()
  const second = harness()
  const oldTree = await first.service.elements({ window: '412' })
  const newTree = await second.service.elements({ window: '412' })
  assert.notEqual(oldTree.elements[0].ref, newTree.elements[0].ref)
  await assert.rejects(second.service.act({ action: 'press', ref: oldTree.elements[0].ref }), /not in a reading/)
  assert.equal(second.calls.some(call => call.args[0] === 'press'), false)
})

test('a screen control request discloses a frontmost-window-only observation', async () => {
  const { calls, service } = harness()
  const observed = await service.elements({ window: 'screen' })
  assert.equal(observed.window.id, 412)
  assert.equal(observed.observationScope, 'frontmost_window')
  assert.match(observed.observationNote || '', /only the frontmost window, not every window/)
  assert.ok(calls.some(call => call.args.slice(0, 3).join(' ') === 'elements --window frontmost'))
  await service.act({ action: 'press', ref: observed.elements[0].ref }, undefined, { capture: 'none' })
  assert.ok(calls.some(call => call.args.slice(0, 3).join(' ') === 'press --window 412'))
})

test('one native action can return fresh controls without capturing pixels', async () => {
  const { calls, service } = harness()
  const first = await service.elements({ window: '412' })
  const observed = await service.act({ action: 'press', ref: first.elements[0].ref }, undefined, { capture: 'elements' })
  assert.equal(calls.filter(call => call.args[0] === 'press').length, 1)
  assert.equal(calls.filter(call => call.args[0] === 'snapshot').length, 0)
  assert.equal(observed.tree?.window.id, 412)
  assert.notEqual(observed.tree?.elements[0].ref, first.elements[0].ref)
  assert.equal(observed.snapshot, undefined)
})


test('same-named native controls retain container context and bind the chosen control', async () => {
  const { service, calls } = harness({ elements: [
    { ref: '0.1', role: 'AXButton', title: 'Reload', enabled: true, pressable: true, context: 'AXToolbar', x: 50, y: 60, width: 30, height: 30 },
    { ref: '1.2', role: 'AXButton', title: 'Reload', enabled: true, pressable: true, context: 'AXWebArea Extensions > AXGroup Example', x: 500, y: 200, width: 30, height: 30 },
  ] })
  const tree = await service.elements({ window: '412' })
  const target = tree.elements.find(item => item.context?.includes('AXWebArea'))!
  assert.equal(tree.elements[0].title, target.title)
  assert.notEqual(tree.elements[0].context, target.context)
  await service.act({ action: 'press', ref: target.ref }, undefined, { capture: 'none' })
  assert.equal(calls.find(call => call.args[0] === 'press')?.args[4], '1.2')
})

test('protected native values stay masked in direct and post-action readings', async () => {
  const secret = 'synthetic-fixture-secret'
  const { service } = harness({ elements: [
    { ref: '1', role: 'AXTextField', subrole: 'AXSecureTextField', title: 'Password', value: secret, enabled: true, pressable: false, x: 300, y: 220, width: 200, height: 40 },
  ] })
  const first = await service.elements({ window: '412' })
  assert.equal(first.elements[0].value, '[protected]')
  assert.equal(JSON.stringify(first).includes(secret), false)
  const result = await service.act({ action: 'set_value', ref: first.elements[0].ref, value: 'new-fixture-secret' }, undefined, { capture: 'elements' })
  assert.equal(result.tree?.elements[0].value, '[protected]')
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(JSON.stringify(result).includes('new-fixture-secret'), false)
})

test('a run cannot type into a remembered window number without its own current observation', async () => {
  const { service, calls } = harness()
  await service.snapshot({ window: '412' })
  const run = service.fork()
  await assert.rejects(run.act({ action: 'type', window: '412', text: 'private test input' }, undefined, { capture: 'none' }), /No current native observation belongs to this run/)
  assert.equal(calls.some(({ args }) => args[0] === 'act'), false)
})

test('native control refs and observations are isolated between runs', async () => {
  const { service, calls } = harness()
  const first = service.fork(), second = service.fork()
  const tree = await first.elements({ window: '412' })
  await assert.rejects(second.act({ action: 'press', ref: tree.elements[0].ref }, undefined, { capture: 'none' }), /observed|current|ref/i)
  assert.equal(calls.some(({ args }) => args[0] === 'press'), false)
})

test('changed native window identity refuses input before any native action', async () => {
  for (const change of [{ title: 'A different Chrome tab' }, { pid: 901 }, { width: 950 }]) {
    const base = harness()
    const run = new DesktopControlService({ driverPath: '/mock/desktop-driver', platform: 'darwin', requireObservation: true,
      run: async (command, args, options) => {
        const result = await base.run(command, args, options)
        if (args[0] !== 'windows') return result
        const value = JSON.parse(result.stdout.toString())
        value.windows[0] = { ...value.windows[0], ...change }
        return { ...result, stdout: Buffer.from(JSON.stringify(value)) }
      } })
    await run.snapshot({ window: '412' })
    await assert.rejects(run.act({ action: 'type', window: '412', text: 'private test input' }, undefined, { capture: 'none' }), /observed native window changed/)
    assert.equal(base.calls.some(({ args }) => args[0] === 'act'), false)
  }
})

test('current run observation carries exact window identity to the native input boundary', async () => {
  const { service, calls } = harness()
  const run = service.fork()
  await run.snapshot({ window: '412' })
  await run.act({ action: 'type', window: '412', text: 'bounded test input' }, undefined, { capture: 'none' })
  const input = calls.find(({ args }) => args[0] === 'act')!.args
  assert.equal(input[input.indexOf('--expect-window-id') + 1], '412')
  assert.equal(input[input.indexOf('--expect-window-pid') + 1], '900')
  assert.equal(input[input.indexOf('--expect-window-title') + 1], 'Untitled')
})


test('a run stops native input after user activity conflicts without polling for another opening', async () => {
  const activity = { idleMs: 120 }
  const h = harness(activity)
  const run = h.service.fork()
  await assert.rejects(run.act({ action: 'focus', app: 'com.google.Chrome' }), /active right now/)
  const afterConflict = h.calls.length
  activity.idleMs = 42_000
  await assert.rejects(run.act({ action: 'focus', app: 'com.google.Chrome' }), /stopped for this run/)
  assert.equal(h.calls.length, afterConflict, 'a second input does not poll the driver or dispatch input')
  assert.equal(h.calls.some(call => ['act', 'focus'].includes(call.args[0])), false)
  await run.windows()
  const nextRun = h.service.fork()
  await nextRun.act({ action: 'focus', app: 'com.google.Chrome' }, undefined, { capture: 'none' })
  assert.equal(h.calls.filter(call => ['act', 'focus'].includes(call.args[0])).length, 1)
})


test('a partial native reading explains how to act on an omitted visible control without guessing it absent', async () => {
  const h = harness({ depthLimited: true })
  const reading = await h.service.elements({ window: '42', max: 150, depth: 20 })
  assert.equal(reading.truncated, true)
  assert.match(reading.observationNote || '', /incomplete.*missing control is not evidence.*absent/i)
  assert.match(reading.observationNote || '', /desktop_snapshot.*same window.*visible coordinates/i)
  assert.match(reading.observationNote || '', /visible blocking dialog first/i)
  assert.equal(h.calls.some(call => ['act', 'focus'].includes(call.args[0])), false)
})


test('keyboard admission uses verified focus instead of a floating surface first in drawing order', async () => {
  const h = harness()
  const service = new DesktopControlService({ driverPath: '/mock/desktop-driver', platform: 'darwin', requireObservation: true,
    run: async (command, args, options) => {
      const result = await h.run(command, args, options)
      if (args[0] !== 'windows') return result
      const current = JSON.parse(result.stdout.toString())
      current.frontmost.window_id = 412
      current.windows.unshift({ ...frontWindow, id: 999, title: '', width: 420, height: 150 })
      return { ...result, stdout: Buffer.from(JSON.stringify(current)) }
    } })
  await service.snapshot({ window: '412' })
  assert.equal((await service.windows()).frontmost.windowId, 412)
  await service.act({ action: 'key', window: '412', key: 'a', flags: 'cmd' }, undefined, { capture: 'none' })
  const input = h.calls.find(call => call.args[0] === 'act')!.args
  assert.equal(input[input.indexOf('--expect-window-id') + 1], '412')
})

test('an unavailable verified keyboard window cannot fall back to the first drawing surface', async () => {
  const h = harness()
  const service = new DesktopControlService({ driverPath: '/mock/desktop-driver', platform: 'darwin', requireObservation: true,
    run: async (command, args, options) => {
      const result = await h.run(command, args, options)
      if (args[0] !== 'windows') return result
      const current = JSON.parse(result.stdout.toString())
      current.frontmost.window_id = 0
      return { ...result, stdout: Buffer.from(JSON.stringify(current)) }
    } })
  await service.snapshot({ window: '412' })
  await assert.rejects(service.act({ action: 'key', window: '412', key: 'a' }), /No current native observation/)
  assert.equal(h.calls.some(call => call.args[0] === 'act'), false)
})
