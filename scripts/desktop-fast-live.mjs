#!/usr/bin/env node

/**
 * Live check of the Jev-backed fast desktop path.
 *
 * The decision service is the one the profile actually has configured, the state
 * is a real window's accessibility tree, and the proof that the chosen action
 * landed is the target process's own log — not the loop's own report.
 *
 * The decision service comes from OPENROUTER_API_KEY when it is set, which is how
 * the browser fast smoke is run, and otherwise from a Shun profile's own settings,
 * which is the configuration the product would actually use.
 *
 * Usage: OPENROUTER_API_KEY=... pnpm smoke:computer-use-fast
 *        node --experimental-strip-types scripts/desktop-fast-live.mjs [profile/state.json]
 */

import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DesktopControlService } from '../src/main/desktop-control.ts'
import { runDesktopFast } from '../src/main/desktop-fast.ts'
import { resolveComputerUseAcceleration } from '../src/main/jev-client.ts'

const profile = process.argv[2] || join(homedir(), 'Library/Application Support/Shun/state.json')
const settings = process.env.OPENROUTER_API_KEY
  ? {
      providers: [{
        id: 'smoke', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY, enabled: true, models: [],
      }],
      computerUseAcceleration: { provider: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY },
    }
  : JSON.parse(await readFile(profile, 'utf8')).settings
const acceleration = resolveComputerUseAcceleration(settings)
if (!acceleration) {
  console.error(`no decision service resolves from ${process.env.OPENROUTER_API_KEY ? 'OPENROUTER_API_KEY' : profile}`)
  process.exit(1)
}
console.log(`decision service: ${acceleration.routeLabel} · ${acceleration.model}`)

const targetApp = '/tmp/shun-desktop-loop-target'
const recordPath = '/tmp/shun-desktop-loop-target.log'
if (!existsSync(targetApp)) {
  console.error('the controlled target is missing; run pnpm smoke:computer-use once to build it')
  process.exit(1)
}

const service = new DesktopControlService({ driverPath: new URL('../build/desktop-driver', import.meta.url).pathname, ensureAccessibility: () => true })
await rm(recordPath, { force: true })
const target = spawn(targetApp, [recordPath], { detached: false, stdio: 'ignore' })

const deadline = Date.now() + 15_000
let window
while (Date.now() < deadline && !window) {
  const listed = await service.windows()
  window = listed.windows.find(item => /loop-target/.test(item.app))
  if (!window) await new Promise(resolve => setTimeout(resolve, 500))
}
if (!window) {
  target.kill('SIGTERM')
  console.error('the controlled window never appeared')
  process.exit(1)
}
await new Promise(resolve => setTimeout(resolve, 800))

try {
  const tree = await service.elements({ window: String(window.id) })
  console.log(`reading: ${tree.elements.length} controls — ${tree.elements.filter(e => e.title).map(e => `${e.ref}:"${e.title}"`).join(', ')}`)

  const result = await runDesktopFast({
    service,
    settings,
    goal: 'press the button whose label is RIGHT',
    window: String(window.id),
    maxSteps: 4,
  })
  console.log(`\nfast run: ${result.status}${result.reason ? ` — ${result.reason}` : ''}`)
  for (const step of result.steps) console.log(`  step ${step.step}: ${step.outcome} ${step.action || ''} ${step.detail || ''}`)

  await new Promise(resolve => setTimeout(resolve, 400))
  const recorded = existsSync(recordPath) ? (await readFile(recordPath, 'utf8')).split('\n').filter(Boolean) : []
  console.log(`\ntarget recorded: ${recorded.join(', ') || 'nothing'}`)
  const right = recorded.filter(line => line === 'CLICK RIGHT').length
  const left = recorded.filter(line => line === 'CLICK LEFT').length
  const ok = right >= 1 && left === 0 && ['completed', 'max_steps'].includes(result.status)
  console.log(ok
    ? `\nfast desktop path: the decision layer chose the RIGHT button and it landed (${right} press(es), no press on LEFT)`
    : `\nfast desktop path FAILED: RIGHT presses ${right}, LEFT presses ${left}, status ${result.status}`)
  process.exitCode = ok ? 0 : 1
} catch (error) {
  console.error('fast desktop run failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  target.kill('SIGTERM')
  await new Promise(resolve => setTimeout(resolve, 300))
}
