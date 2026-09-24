import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDesktopCandidates, buildDesktopQuestions, readingFingerprint, runDesktopFast } from './desktop-fast.ts'
import { DesktopControlService, type DesktopCommandRunner } from './desktop-control.ts'
import type { Settings } from '../shared.ts'
import type { DecisionAnswer, DecisionQuestion } from './jev-client.ts'

const window = { id: 412, pid: 900, app: 'Settings', title: 'Preferences', layer: 0, x: 100, y: 60, width: 640, height: 480 }

function element(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ref: '0', role: 'AXButton', subrole: '', title: 'Dark Mode', description: '', value: '',
    enabled: true, focused: false, pressable: true, x: 120, y: 120, width: 200, height: 40,
    ...overrides,
  }
}

const tree = (elements: unknown[], overrides: Record<string, unknown> = {}) => ({
  window,
  geometry: { x: window.x, y: window.y, width: window.width, height: window.height },
  elements: elements as any,
  truncated: false,
  ...overrides,
}) as any

function settings(): Settings {
  return {
    endpoint: '', apiKey: '', providerId: 'p', model: 'm', workspace: '', temperature: 0, maxTokens: 0, contextWindow: 0, autoCompact: false,
    providers: [{ id: 'p', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', apiKey: 'key', enabled: true, models: [] }],
  } as unknown as Settings
}

/** A service whose driver answers with a scripted sequence of readings. */
function scriptedService(readings: any[], onAct: (args: string[]) => void = () => {}) {
  let index = 0
  const run: DesktopCommandRunner = async (_command, args) => {
    if (args[0] === 'elements') {
      const reading = readings[Math.min(index, readings.length - 1)]
      if (args[0] === 'elements' && readings.length > 1) index += 1
      return { stdout: Buffer.from(JSON.stringify(reading)), stderr: '' }
    }
    if (args[0] === 'probe') return { stdout: Buffer.from(JSON.stringify({ ok: true, accessibility: true, screen_recording: true, user_idle_ms: 60_000, capture: { supported: true, displays: 1, windows: 2 }, display: { x: 0, y: 0, width: 1920, height: 1080 }, frontmost: 'Settings' })), stderr: '' }
    if (args[0] === 'snapshot') {
      const { writeFile } = await import('node:fs/promises')
      const value = Buffer.alloc(24)
      Buffer.from('89504e470d0a1a0a', 'hex').copy(value)
      value.writeUInt32BE(640, 16); value.writeUInt32BE(480, 20)
      await writeFile(args[args.indexOf('--out') + 1], value)
      return { stdout: Buffer.from(JSON.stringify({ ok: true, target: 'window', window, display: { x: 0, y: 0, width: 1920, height: 1080 } })), stderr: '' }
    }
    onAct(args)
    if (args[0] === 'press') return { stdout: Buffer.from(JSON.stringify({ ok: true, action: 'press', performed: { ref: args[3], role: 'AXButton', title: 'Dark Mode' }, window })), stderr: '' }
    return { stdout: Buffer.from(JSON.stringify({ ok: true, action: args[0], window })), stderr: '' }
  }
  return new DesktopControlService({ driverPath: '/mock/desktop-driver', platform: 'darwin', run, ensureAccessibility: () => true })
}

/** Answers keyed by question, so a test states the judgment it wants. */
function answers(map: Record<string, DecisionAnswer>, seen: Array<Record<string, DecisionQuestion>> = []) {
  return async (questions: Record<string, DecisionQuestion>) => {
    seen.push(questions)
    const result: Record<string, DecisionAnswer> = {}
    for (const name of Object.keys(questions)) {
      const answer = map[name]
      if (answer) result[name] = answer
    }
    return result
  }
}

test('candidates are the actions the reading already offers, and escalate is always one of them', () => {
  const candidates = buildDesktopCandidates(tree([
    element(),
    element({ ref: '1', role: 'AXTextField', title: 'Email', pressable: false }),
    element({ ref: '2', title: 'Delete Account' }),
    element({ ref: '3', role: 'AXScrollArea', title: 'List', pressable: false }),
    element({ ref: '4', title: 'Disabled thing', enabled: false }),
  ]), { input: { Email: 'me@example.com' } })
  assert.deepEqual(candidates.map(candidate => candidate.id), [
    'press:0', 'type:1', 'press:2', 'scroll-down:3', 'scroll-up:3', 'escalate',
  ])
  assert.equal(candidates[0].consequential, false)
  assert.equal(candidates[2].consequential, true, 'a name that commits something is offered as consequential')
  assert.equal(candidates[1].request?.value, 'me@example.com')
  assert.deepEqual(candidates.find(candidate => candidate.id === 'press:2')?.request, { action: 'press', window: 412, ref: '2' })
})

test('a field with no supplied value is never offered, so no value can be invented', () => {
  const candidates = buildDesktopCandidates(tree([element({ ref: '1', role: 'AXTextField', title: 'Email', pressable: false })]), {})
  assert.equal(candidates.some(candidate => candidate.id.startsWith('type:')), false)
})

test('a field named like a secret, and a secure field, reach the decision redacted', () => {
  const state = { elements: [
    element({ ref: '1', role: 'AXTextField', title: 'Password', value: 'hunter2', pressable: false }),
    element({ ref: '2', role: 'AXSecureTextField', title: 'Token', value: 'sk-live-123', pressable: false }),
  ] }
  const questions = buildDesktopQuestions(buildDesktopCandidates(tree(state.elements), {}), 'sign in')
  assert.ok(questions.next_action)
  // The value never leaves through the candidates the decision is asked to choose from.
  assert.equal(JSON.stringify(questions).includes('hunter2'), false)
  assert.equal(JSON.stringify(questions).includes('sk-live-123'), false)
})

test('a completed subgoal ends the loop without another action', async () => {
  const acted: string[][] = []
  const service = scriptedService([tree([element()])], args => acted.push(args))
  const result = await runDesktopFast({
    service, settings: settings(), goal: 'turn dark mode on',
    decide: answers({ goal_completed: { type: 'noul', noul: 0.96 } }),
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.steps.at(-1)?.outcome, 'completed')
  assert.equal(acted.length, 0, 'nothing is pressed once the reading already shows the outcome')
})

test('an action the reading supports is performed, and a changed window is progress', async () => {
  const acted: string[][] = []
  const service = scriptedService([
    tree([element()]),
    tree([element({ title: 'Dark Mode', value: 'on' })]),
  ], args => acted.push(args))
  let call = 0
  const result = await runDesktopFast({
    service, settings: settings(), goal: 'turn dark mode on',
    decide: async (questions): Promise<Record<string, DecisionAnswer>> => {
      call += 1
      if (call === 1) return {
        goal_completed: { type: 'noul', noul: 0.05 },
        next_action: { type: 'choice', choice: 'press:0', confidence: 0.9, probabilities: { 'press:0': 0.9 } },
        action_is_unambiguous: { type: 'noul', noul: 0.95 },
        action_changes_external_state: { type: 'noul', noul: 0.02 },
      }
      return { goal_completed: { type: 'noul', noul: 0.97 } }
    },
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.steps[0].outcome, 'acted')
  assert.ok(acted.some(args => args[0] === 'press'))
})

test('a consequential control is refused without explicit authorization', async () => {
  const acted: string[][] = []
  const service = scriptedService([tree([element({ title: 'Delete Account' })])], args => acted.push(args))
  const result = await runDesktopFast({
    service, settings: settings(), goal: 'clean up my account',
    decide: answers({
      goal_completed: { type: 'noul', noul: 0.02 },
      next_action: { type: 'choice', choice: 'press:0', confidence: 0.99 },
      action_is_unambiguous: { type: 'noul', noul: 0.99 },
      action_changes_external_state: { type: 'noul', noul: 0.9 },
    }),
  })
  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /may change something outside this window/i)
  assert.equal(acted.some(args => args[0] === 'press'), false)
})

test('an unclear choice, or a low-confidence one, escalates instead of acting', async () => {
  const acted: string[][] = []
  const service = scriptedService([tree([element()])], args => acted.push(args))
  const ambiguous = await runDesktopFast({
    service, settings: settings(), goal: 'do the thing',
    decide: answers({
      goal_completed: { type: 'noul', noul: 0.02 },
      next_action: { type: 'choice', choice: 'press:0', confidence: 0.99 },
      action_is_unambiguous: { type: 'noul', noul: 0.2 },
      action_changes_external_state: { type: 'noul', noul: 0 },
    }),
  })
  assert.equal(ambiguous.status, 'escalate')
  assert.match(String(ambiguous.reason), /not clearly supported/i)

  const unsure = await runDesktopFast({
    service, settings: settings(), goal: 'do the thing',
    decide: answers({
      goal_completed: { type: 'noul', noul: 0.02 },
      next_action: { type: 'choice', choice: 'press:0', confidence: 0.1 },
      action_is_unambiguous: { type: 'noul', noul: 0.99 },
      action_changes_external_state: { type: 'noul', noul: 0 },
    }),
  })
  assert.equal(unsure.status, 'escalate')
  assert.match(String(unsure.reason), /not confident enough/i)
  assert.equal(acted.length, 0)
})

test('a window that stops responding ends the loop instead of repeating', async () => {
  const acted: string[][] = []
  const unchanged = tree([element()])
  const service = scriptedService([unchanged, unchanged, unchanged, unchanged], args => acted.push(args))
  const result = await runDesktopFast({
    service, settings: settings(), goal: 'toggle it',
    decide: answers({
      goal_completed: { type: 'noul', noul: 0.02 },
      next_action: { type: 'choice', choice: 'press:0', confidence: 0.9 },
      action_is_unambiguous: { type: 'noul', noul: 0.99 },
      action_changes_external_state: { type: 'noul', noul: 0 },
    }),
  })
  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /stopped responding/i)
  assert.equal(result.steps.at(-1)?.outcome, 'stalled')
})

test('the fingerprint follows the controls, not where they were listed', () => {
  const first = readingFingerprint(tree([element(), element({ ref: '1', title: 'Email' })]))
  const reordered = readingFingerprint(tree([element({ ref: '0', title: 'Email' }), element({ ref: '1' })]))
  assert.notEqual(first, reordered)
  assert.equal(first, readingFingerprint(tree([element(), element({ ref: '1', title: 'Email' })])))
})

test('without a decision service nothing about the desktop changes', async () => {
  const { desktopFastToolDefinitions } = await import('./desktop-fast.ts')
  const service = scriptedService([tree([element()])])
  const bare = { ...settings(), providers: [] } as Settings
  assert.deepEqual(desktopFastToolDefinitions({ settings: bare, service }), [])
  const withoutTree = { ...settings(), providers: [{ id: 'p', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', apiKey: 'key', enabled: true, models: [] }] } as unknown as Settings
  const windowsService = new DesktopControlService({ driverPath: '/mock/desktop-driver', platform: 'win32', run: async () => ({ stdout: Buffer.from('{}'), stderr: '' }) })
  assert.deepEqual(desktopFastToolDefinitions({ settings: withoutTree, service: windowsService }), [])
  assert.equal(desktopFastToolDefinitions({ settings: withoutTree, service }).length, 1)
})
