#!/usr/bin/env node

/**
 * The macOS closed loop for Computer Use, on real hardware.
 *
 * It drives the product's own service — the same code the agent calls — against a
 * controlled AppKit window, and every step is checked against evidence the driver
 * did not produce:
 *
 *   1. look     the capture is a real image whose colours match the target's
 *               layout, which is what proves the geometry the click uses is the
 *               geometry the screenshot showed
 *   2. act      a click at a normalized coordinate reaches the intended button
 *   3. look     the fresh capture and the window list both show the new state,
 *               and the target process records which button it received
 *
 * Run: pnpm smoke:computer-use
 * Needs macOS with Screen Recording and Accessibility permission, and an
 * unlocked screen: a locked session has no capturable display, and a locked
 * session also keeps other applications out of the on-screen window list.
 */

import { spawn, spawnSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { DesktopControlService } from '../src/main/desktop-control.ts'

const driverPath = new URL('../build/desktop-driver', import.meta.url).pathname
const targetSource = new URL('./desktop-loop-target.swift', import.meta.url).pathname
const targetApp = '/tmp/shun-desktop-loop-target'
const recordPath = '/tmp/shun-desktop-loop-target.log'

const failures = []
const notes = []
function check(label, condition, detail = '') {
  if (condition) notes.push(`ok    ${label}${detail ? ` — ${detail}` : ''}`)
  else failures.push(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}

async function averageColor(png, x0, x1, y0, y1) {
  const { loadImage, createCanvas } = await import('@napi-rs/canvas')
  const image = await loadImage(png)
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  const left = Math.floor(image.width * x0)
  const top = Math.floor(image.height * y0)
  const width = Math.max(1, Math.floor(image.width * (x1 - x0)))
  const height = Math.max(1, Math.floor(image.height * (y1 - y0)))
  const { data } = context.getImageData(left, top, width, height)
  let red = 0, green = 0, blue = 0
  for (let index = 0; index < data.length; index += 4) {
    red += data[index]; green += data[index + 1]; blue += data[index + 2]
  }
  const pixels = data.length / 4
  return { red: red / pixels, green: green / pixels, blue: blue / pixels, width: image.width, height: image.height }
}

async function recordedClicks() {
  if (!existsSync(recordPath)) return []
  const text = await readFile(recordPath, 'utf8')
  // Whole lines: an event carries a space ("CLICK LEFT", "TYPED:hi there").
  return text.split('\n').map(line => line.trim()).filter(Boolean)
}

// The controlled target is built here rather than checked in as a binary.
if (!existsSync(targetApp)) {
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', targetSource, '-o', targetApp], { encoding: 'utf8' })
  if (built.error || built.status !== 0) {
    console.error(built.stderr?.trim() || built.error?.message || 'Could not build the controlled target window.')
    process.exit(1)
  }
}

const service = new DesktopControlService({ driverPath, ensureAccessibility: () => true })
const state = await service.state()
if (!state.connected || /cannot be captured/.test(String(state.message))) {
  const permissions = await service.permissions().catch(() => undefined)
  console.error(`Computer Use is not ready on this machine: ${state.message}`)
  if (permissions) {
    console.error(`evidence: ${permissions.capturableDisplays} capturable display(s), frontmost "${permissions.frontmost}", last input ${Math.round(permissions.userIdleMs / 1000)}s ago`)
  }
  console.error('A locked or sleeping session has no capturable surface, and it also keeps other applications out of the on-screen window list.')
  console.error('Unlock this Mac, keep it unlocked, and run this again.')
  process.exit(1)
}

await rm(recordPath, { force: true })
const target = spawn(targetApp, [recordPath], { detached: false, stdio: 'ignore' })

/**
 The window has to be up before anything can be measured, and right after a
 session unlocks (or when an application is starting) it takes a moment. Polling
 for it is the difference between a flaky smoke test and a real failure.
 */
async function waitForWindow(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let listed = { windows: [] }
  while (Date.now() < deadline) {
    listed = await service.windows()
    const window = listed.windows.find(item => /shun-desktop-loop-target|loop-target/.test(item.app))
    if (window) return { window, listed }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return { window: undefined, listed }
}

try {
  // 1. look
  const { window, listed } = await waitForWindow()
  check('the controlled window is listed with its own geometry', Boolean(window), window ? `${window.id} ${window.app} ${window.width}x${window.height} at ${window.x},${window.y}` : `saw ${listed.windows.map(item => item.app).join(', ')}`)
  if (!window) throw new Error('no target window to drive')

  const first = await service.snapshot({ window: String(window.id) })
  check('the capture is a real image, not a blank one', first.width > 100 && first.height > 100, `${first.width}x${first.height}`)
  // The sampling bands are the same normalized coordinates the clicks use, so a
  // wrong geometry shows up here as the wrong colour rather than as a misclick.
  const top = await averageColor(Buffer.from(first.screenshot, 'base64'), 0.05, 0.95, 0.12, 0.34)
  const bottom = await averageColor(Buffer.from(first.screenshot, 'base64'), 0.05, 0.95, 0.74, 0.96)
  check('the upper band of the capture is the red button', top.red > 140 && top.red > top.green + 60, `rgb(${top.red | 0},${top.green | 0},${top.blue | 0})`)
  check('the lower band of the capture is the green button', bottom.green > 100 && bottom.green > bottom.red + 40, `rgb(${bottom.red | 0},${bottom.green | 0},${bottom.blue | 0})`)

  // 2. act on the top button, then 3. look again
  const clickTop = await service.act({ action: 'click', window: String(window.id), x: 0.5, y: 0.22 })
  check('the click was sent and observed', Boolean(clickTop.snapshot), clickTop.captureError ? String(clickTop.captureError) : 'fresh capture returned')
  await new Promise(resolve => setTimeout(resolve, 400))
  check('the target process received the click on its top button', (await recordedClicks()).includes('CLICK LEFT'), `recorded: ${(await recordedClicks()).join(', ') || 'nothing'}`)
  const afterTop = await service.windows()
  const titledTop = afterTop.windows.find(item => item.id === window.id)
  check('the window list shows the new title after the click', /clicked LEFT/.test(titledTop?.title || ''), titledTop?.title)

  const clickBottom = await service.act({ action: 'click', window: String(window.id), x: 0.5, y: 0.85 })
  check('the second click was sent and observed', Boolean(clickBottom.snapshot), clickBottom.captureError ? String(clickBottom.captureError) : 'fresh capture returned')
  await new Promise(resolve => setTimeout(resolve, 400))
  const clicks = await recordedClicks()
  check('the target process received the click on its bottom button', clicks.includes('CLICK LEFT') && clicks.includes('CLICK RIGHT'), `recorded: ${clicks.join(', ') || 'nothing'}`)

  // Typing: focus the field, then send text and a key. The field reports the text
  // that arrived, which is the only proof that the keystrokes were synthesized.
  const focus = await service.act({ action: 'click', window: String(window.id), x: 0.5, y: 0.53 })
  check('the text field could be focused by a click', Boolean(focus.snapshot), focus.captureError ? String(focus.captureError) : 'fresh capture returned')
  const typing = await service.act({ action: 'type', window: String(window.id), text: 'hi there' })
  check('typing was sent and observed', Boolean(typing.snapshot), typing.captureError ? String(typing.captureError) : 'fresh capture returned')
  await new Promise(resolve => setTimeout(resolve, 400))
  const typed = (await recordedClicks()).filter(line => line.startsWith('TYPED:'))
  check('the field received the typed text', typed.at(-1) === 'TYPED:hi there', `field recorded: ${typed.at(-1) || 'nothing'}`)

  const enter = await service.act({ action: 'key', window: String(window.id), key: 'return' })
  check('a key press was sent and observed', Boolean(enter.snapshot), enter.captureError ? String(enter.captureError) : 'fresh capture returned')
  await new Promise(resolve => setTimeout(resolve, 400))
  check('the field received the Return key', (await recordedClicks()).includes('KEY return'), `recorded: ${(await recordedClicks()).join(', ')}`)

  /**
   Reading the controls instead of the pixels. Nothing below uses a coordinate or
   needs an image: the ref is the identity, and the target's own log is still what
   says whether the action landed.
   */
  if (!service.supportsElements()) {
    notes.push('skip  the element tree is not implemented on this platform')
  } else {
    const tree = await service.elements({ window: String(window.id) })
    const right = tree.elements.find(element => element.title === 'RIGHT')
    const left = tree.elements.find(element => element.title === 'LEFT')
    const field = tree.elements.find(element => element.role === 'AXTextField')
    check('the controls are read from the window without a screenshot', Boolean(right && left && field),
      `${tree.elements.length} elements: ${tree.elements.slice(0, 4).map(element => `${element.ref}:${element.role}${element.title ? ` "${element.title}"` : ''}`).join(', ')}`)
    check('a button is reported as pressable and a text field is not',
      Boolean(right?.pressable) && Boolean(field && !field.pressable),
      `RIGHT pressable=${right?.pressable}, field pressable=${field?.pressable}`)

    const before = (await recordedClicks()).filter(line => line === 'CLICK RIGHT').length
    const pressed = await service.act({ action: 'press', window: String(window.id), ref: String(right?.ref) })
    check('a press by ref is sent and observed', Boolean(pressed.snapshot), pressed.captureError ? String(pressed.captureError) : 'fresh capture returned')
    await new Promise(resolve => setTimeout(resolve, 400))
    const after = (await recordedClicks()).filter(line => line === 'CLICK RIGHT').length
    check('the target received the press by ref, with no coordinate involved', after === before + 1, `CLICK RIGHT count ${before} → ${after}`)

    const afterTree = await service.elements({ window: String(window.id) })
    const titleText = afterTree.elements.find(element => element.role === 'AXStaticText')?.value || ''
    check('a fresh reading shows the new state', /clicked RIGHT/.test(titleText), titleText)

    const set = await service.act({ action: 'set_value', window: String(window.id), ref: String(field?.ref), value: 'by ref' })
    check('a value can be set on a field by ref', Boolean(set.snapshot), set.captureError ? String(set.captureError) : 'fresh capture returned')
    await new Promise(resolve => setTimeout(resolve, 400))
    const typed = (await recordedClicks()).filter(line => line.startsWith('TYPED:')).at(-1)
    check('the field received the value set by ref', typed === 'TYPED:by ref', `field recorded: ${typed || 'nothing'}`)

    // The guard is what makes a ref safe to hand out: an identity that no longer
    // matches is refused before anything is performed.
    const guard = spawnSync(driverPath, ['press', '--window', String(window.id), '--ref', String(right?.ref), '--expect-role', 'AXButton', '--expect-title', 'NOT THE SAME CONTROL'], { encoding: 'utf8' })
    check('the guard refuses a ref whose control is no longer the one that was read',
      guard.status !== 0 && /nothing was performed/.test(guard.stderr || ''),
      (guard.stderr || '').trim().slice(0, 120))
    await new Promise(resolve => setTimeout(resolve, 300))
    const guarded = (await recordedClicks()).filter(line => line === 'CLICK RIGHT').length
    check('the refused press changed nothing', guarded === after, `CLICK RIGHT count stayed ${guarded}`)
  }

  // A stale surface is the failure mode this whole contract exists to prevent: the
  // second capture has to differ from the first, because the window changed.
  if (clickBottom.snapshot) {
    const second = Buffer.from(clickBottom.snapshot.screenshot, 'base64')
    check('the second capture differs from the first', Buffer.compare(Buffer.from(first.screenshot, 'base64'), second) !== 0)
  }
} catch (error) {
  failures.push(`FAIL  ${error instanceof Error ? error.message : String(error)}`)
} finally {
  target.kill('SIGTERM')
  await new Promise(resolve => setTimeout(resolve, 300))
}

for (const note of notes) console.log(note)
for (const failure of failures) console.log(failure)
console.log(failures.length === 0 ? `\nclosed loop: ${notes.length} checks passed on macOS` : `\nclosed loop: ${failures.length} of ${notes.length + failures.length} checks failed`)
process.exit(failures.length === 0 ? 0 : 1)
