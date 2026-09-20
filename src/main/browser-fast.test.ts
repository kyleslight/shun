import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserSession, ComputerUseAccelerationSettings, Provider, Settings } from '../shared.ts'
import { BrowserControlBlockedError } from './chrome-browser.ts'
import type { BrowserAction, ChromeSnapshot } from './chrome-browser.ts'
import { BrowserFastExecutor, browserFastToolDefinitions, buildActionCandidates, buildJevState, declaredKeys, matchPlanStep, type BrowserFastConfig, type BrowserFastHost, type BrowserFastResult } from './browser-fast.ts'
import type { DecisionClient, DecisionRequest, DecisionResponse } from './jev-client.ts'

const config: BrowserFastConfig = {
  model: 'typesafe/jev-1.13',
  minActionConfidence: 0.5,
  minActionMargin: 0.2,
  minCompletionConfidence: 0.9,
  minAmbiguityConfidence: 0.6,
  maxMutationProbability: 0.2,
  maxSteps: 12,
  timeoutMs: 15_000,
}

type Frame = { session: BrowserSession; snapshot: ChromeSnapshot; text: string }

function frame(nodes: ChromeSnapshot['nodes'], options: { url?: string; title?: string; text?: string; readyState?: string } = {}): Frame {  const url = options.url || 'https://example.com/'
  const title = options.title || 'Example'
  const session: BrowserSession = {
    id: 'session-1', taskId: 'task-1', createdByRunId: 'run-1', tabId: 7, owned: false, state: 'attached',
    url, title, createdAt: 1, updatedAt: 1, consoleEntries: 0, pageErrors: 0,
  }
  const snapshot: ChromeSnapshot = { tab: { id: 7, url, title }, readyState: options.readyState || 'complete', text: options.text || 'Example page', nodes }
  return { session, snapshot, text: JSON.stringify({ title, url, accessibility_nodes: (nodes || []).length }) }
}

function fakeBrowser(frames: Frame[], options: { pageAdvancesByItself?: boolean } = {}) {
  const actions: BrowserAction[] = []
  let index = 0
  let snapshotCalls = 0
  const host: BrowserFastHost = {
    async snapshot() {
      snapshotCalls += 1
      const current = frames[Math.min(index, frames.length - 1)]
      // A page that finishes loading on its own advances between snapshots, which is
      // the whole reason a beat is worth taking.
      if (options.pageAdvancesByItself && index < frames.length - 1) index += 1
      return current
    },
    async act(_taskId, _sessionId, action) { actions.push(action); index += 1; return frames[Math.min(index, frames.length - 1)] },
  }
  return { host, actions, snapshots: () => snapshotCalls }
}

function scriptedDecisions(responses: Array<DecisionResponse | Error>) {
  const requests: DecisionRequest[] = []
  const client: DecisionClient = {
    async decide(request) {
      requests.push(request)
      const response = responses[Math.min(requests.length - 1, responses.length - 1)]
      if (response instanceof Error) throw response
      return response
    },
  }
  return { client, requests }
}

function verdict(values: { completed?: number; action?: string; probabilities?: Record<string, number>; confidence?: number; unambiguous?: number; mutation?: number; repeat?: number; repeatLimit?: number }): DecisionResponse {
  return {
    model: 'jev-test',
    answers: {
      goal_completed: { type: 'noul', noul: values.completed ?? 0 },
      next_action: {
        type: 'choice',
        choice: values.action || 'escalate',
        ...(values.probabilities ? { probabilities: values.probabilities } : {}),
        ...(values.confidence !== undefined ? { confidence: values.confidence } : {}),
      },
      action_is_unambiguous: { type: 'noul', noul: values.unambiguous ?? 1 },
      action_changes_external_state: { type: 'noul', noul: values.mutation ?? 0 },
      repeat_action: { type: 'noul', noul: values.repeat ?? 0 },
      ...(values.repeatLimit ? { repeat_limit: { type: 'choice' as const, choice: String(values.repeatLimit) } } : {}),
    },
  }
}

function openRouterProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'openrouter', name: 'OpenRouter', kind: 'cloud', catalogId: 'openrouter', api: 'openai-completions',
    endpoint: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test', contextWindow: 32_768, ...overrides,
  }
}

function settingsWith(providers: Provider[], acceleration?: ComputerUseAccelerationSettings): Settings {
  return {
    endpoint: '', apiKey: '', providerId: '', providers, model: 'test-model', workspace: '', temperature: 0,
    maxTokens: 0, contextWindow: 0, autoCompact: false, ...(acceleration ? { computerUseAcceleration: acceleration } : {}),
  }
}

test('Browser Use registers no fast tool without an acceleration credential', () => {
  const browser = fakeBrowser([frame([])])

  assert.deepEqual(browserFastToolDefinitions({ settings: settingsWith([]), host: browser.host, taskId: 'task-1' }), [])
  assert.deepEqual(browserFastToolDefinitions({ settings: settingsWith([openRouterProvider({ apiKey: '   ' })]), host: browser.host, taskId: 'task-1' }), [])
  assert.deepEqual(browserFastToolDefinitions({
    settings: settingsWith([openRouterProvider()], { enabled: false }),
    host: browser.host,
    taskId: 'task-1',
  }), [])

  const tools = browserFastToolDefinitions({ settings: settingsWith([openRouterProvider()]), host: browser.host, taskId: 'task-1' })
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'browser_fast')
})

test('candidate generation offers only legal actions from the snapshot', () => {
  const candidates = buildActionCandidates({
    nodes: [
      { ref: '12', role: 'link', name: 'Code' },
      { ref: '18', role: 'link', name: 'Settings' },
      { ref: '21', role: 'textbox', name: 'Search' },
      { ref: '30', role: 'button', name: 'Delete repository', disabled: true },
      { ref: '40', role: 'paragraph', name: 'Body copy' },
      { ref: '99', role: 'link', name: '' },
    ],
  }, 'Open repository settings', { input: { query: 'kyleslight/shun', password: 'hunter2' } })

  const ids = candidates.map(candidate => candidate.id)
  assert.ok(ids.includes('click:18'))
  assert.ok(ids.includes('click:12'))
  assert.ok(ids.includes('type:21:query'))
  assert.ok(ids.includes('type:21:password'))
  assert.ok(ids.includes('escalate'))
  assert.ok(!ids.includes('click:30'), 'a disabled control is not an offered action')
  assert.ok(!ids.includes('click:40'), 'a non-actionable role is not an offered action')
  assert.ok(!ids.includes('click:99'), 'an unnamed control is not an offered action')
  assert.equal(ids[ids.length - 1], 'escalate')
  assert.ok(candidates.length <= 60)

  // The goal decides what is offered first, and no typed value is ever printed
  // into a description the fast model reads.
  assert.ok(ids.indexOf('click:18') < ids.indexOf('click:12'))
  const typed = candidates.find(candidate => candidate.id === 'type:21:password')!
  assert.match(typed.description, /sensitive input "password"/)
  assert.doesNotMatch(typed.description, /hunter2/)
  assert.deepEqual(typed.action, { action: 'type', ref: '21', text: 'hunter2', clear: true })

  // Only exact refs from this snapshot, and only the actions Shun generated.
  for (const candidate of candidates) {
    if (!candidate.action) continue
    if ('ref' in candidate.action) assert.match(String(candidate.action.ref), /^[1-9]\d{0,11}$/)
    assert.ok(['click', 'type', 'keypress', 'scroll', 'back'].includes(candidate.action.action))
  }
})

test('a dropdown can be opened and then chosen from', () => {
  const closed = buildActionCandidates({ nodes: [{ ref: '8', role: 'combobox', name: 'Country' }, { ref: '10', role: 'button', name: 'Continue' }] }, 'Choose Japan in the Country dropdown')
  assert.ok(closed.some(candidate => candidate.id === 'click:8'), 'a closed dropdown offers an action that opens it')

  const open = buildActionCandidates({ nodes: [{ ref: '8', role: 'combobox', name: 'Country' }, { ref: '44', role: 'option', name: 'Japan' }] }, 'Choose Japan in the Country dropdown')
  assert.ok(open.some(candidate => candidate.id === 'click:44'))
})

test('keyboard candidates appear only when the page gives a reason for them', () => {
  const withField = buildActionCandidates({ nodes: [{ ref: '21', role: 'searchbox', name: 'Search' }] }, 'Search the repository', { input: { query: 'shun' } })
  assert.ok(withField.some(candidate => candidate.id === 'keypress:Enter'))
  assert.deepEqual(withField.find(candidate => candidate.id === 'keypress:Enter')?.action, { action: 'keypress', key: 'Enter' })
  assert.ok(!withField.some(candidate => candidate.id === 'keypress:Escape'), 'no overlay is open')

  const withOverlay = buildActionCandidates({ nodes: [{ ref: '9', role: 'dialog', name: 'Confirm' }, { ref: '11', role: 'button', name: 'Cancel' }] }, 'Dismiss the dialog')
  assert.ok(withOverlay.some(candidate => candidate.id === 'keypress:Escape'))
  assert.ok(!withOverlay.some(candidate => candidate.id === 'keypress:Enter'), 'nothing is editable and nothing is focused')

  // A page of plain links offers neither keyboard candidate.
  const linksOnly = buildActionCandidates({ nodes: [{ ref: '12', role: 'link', name: 'Code' }] }, 'Open Code')
  assert.ok(!linksOnly.some(candidate => candidate.id.startsWith('keypress:')))
})

test('a keyboard candidate still passes the external-state boundary', async () => {
  const browser = fakeBrowser([frame([{ ref: '21', role: 'searchbox', name: 'Search' }])])
  const decisions = scriptedDecisions([verdict({ action: 'keypress:Enter', probabilities: { 'keypress:Enter': 0.97 }, mutation: 0.55 })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Search', input: { query: 'shun' } })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /external state/i)
  assert.equal(browser.actions.length, 0)
})

test('a thin margin escalates without acting', async () => {
  const browser = fakeBrowser([frame([{ ref: '18', role: 'link', name: 'Settings' }, { ref: '55', role: 'link', name: 'Profile' }])])
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.51, 'click:55': 0.45 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open Settings' })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /nearly as likely/i)
  assert.equal(browser.actions.length, 0)
  assert.equal(result.metrics.browserActions, 0)
})

test('a split distribution does not make a dominant action uncertain', async () => {
  // Several controls can serve one intent — type here, press Enter, click Search.
  // The mass they split is not doubt about which action is right.
  const browser = fakeBrowser([
    frame([{ ref: '5', role: 'searchbox', name: 'Search' }, { ref: '7', role: 'button', name: 'Google Search' }], { url: 'https://example.com/next' }),
  ])
  const decisions = scriptedDecisions([
    verdict({ action: 'type:5:query', probabilities: { 'type:5:query': 0.69, 'keypress:Enter': 0.18, 'click:7': 0.13 }, unambiguous: 0.7 }),
    verdict({ completed: 0.95 }),
  ])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Search for shun', input: { query: 'shun' } })

  assert.equal(result.status, 'completed')
  assert.deepEqual(browser.actions, [{ action: 'type', ref: '5', text: 'shun', clear: true }])
})

test('a genuinely split decision escalates even when the top probability is comfortable', async () => {
  const browser = fakeBrowser([frame([
    { ref: '18', role: 'link', name: 'Personal account' },
    { ref: '19', role: 'link', name: 'Company account' },
    { ref: '20', role: 'link', name: 'Legacy company account' },
  ])])
  const decisions = scriptedDecisions([
    verdict({ action: 'click:19', probabilities: { 'click:19': 0.55, 'click:20': 0.4, 'click:18': 0.05 }, unambiguous: 0.5 }),
  ])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open the correct billing account' })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /nearly as likely|assumption/i)
  assert.equal(browser.actions.length, 0)
})

test('an ambiguous step escalates even when the top action looks likely', async () => {
  const browser = fakeBrowser([frame([{ ref: '18', role: 'link', name: 'Personal account' }])])
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.97 }, unambiguous: 0.4 })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open the correct billing account' })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /assumption/i)
  assert.equal(browser.actions.length, 0)
  assert.ok(result.snapshot, 'an escalation returns the snapshot the main model needs to resume')
})

test('a confident action runs once and the next decision sees only the fresh snapshot', async () => {
  const browser = fakeBrowser([
    frame([{ ref: '18', role: 'link', name: 'Settings' }], { url: 'https://github.com/x', title: 'Repository' }),
    frame([{ ref: '44', role: 'link', name: 'Actions' }], { url: 'https://github.com/x/settings', title: 'Settings' }),
  ])
  const decisions = scriptedDecisions([
    verdict({ action: 'click:18', probabilities: { 'click:18': 0.98, escalate: 0.02 } }),
    verdict({ completed: 0.99 }),
  ])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open Settings > Actions' })

  assert.equal(result.status, 'completed')
  assert.deepEqual(browser.actions, [{ action: 'click', ref: '18' }])
  assert.equal(result.steps.length, 1)
  assert.equal(result.final?.url, 'https://github.com/x/settings')

  const secondOptions = decisions.requests[1].questions.next_action
  assert.equal(secondOptions.type, 'choice')
  const offered = Object.keys((secondOptions as { criteria: Record<string, string> }).criteria)
  assert.ok(offered.includes('click:44'), 'candidates come from the newly returned snapshot')
  assert.ok(!offered.includes('click:18'), 'a stale ref is never reused as an action')
})

test('an action that may change external state escalates unless it is authorized', async () => {
  const nodes = [{ ref: '18', role: 'button', name: 'Delete repository' }]
  const unauthorized = fakeBrowser([frame(nodes)])
  const authorized = fakeBrowser([frame(nodes, { url: 'https://example.com/next' })])
  const response = verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 }, mutation: 0.6 })

  const blocked = await new BrowserFastExecutor(unauthorized.host, scriptedDecisions([response]).client, config).execute({ taskId: 'task-1', goal: 'Remove the repository' })
  assert.equal(blocked.status, 'escalate')
  assert.match(String(blocked.reason), /external state/i)
  assert.equal(unauthorized.actions.length, 0)

  const allowed = await new BrowserFastExecutor(authorized.host, scriptedDecisions([response, verdict({ completed: 0.99 })]).client, config).execute({ taskId: 'task-1', goal: 'Remove the repository', allowMutations: true })
  assert.equal(allowed.status, 'completed')
  assert.equal(authorized.actions.length, 1)
})

test('an action the page never offered escalates', async () => {
  const browser = fakeBrowser([frame([{ ref: '18', role: 'link', name: 'Settings' }])])
  const decisions = scriptedDecisions([verdict({ action: 'click:999', probabilities: { 'click:999': 0.99 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open Settings' })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /not offered/i)
  assert.equal(browser.actions.length, 0)
})

test('an unreadable fast decision escalates', async () => {
  const browser = fakeBrowser([frame([{ ref: '18', role: 'link', name: 'Settings' }])])
  const decisions = scriptedDecisions([{ model: 'jev-test', answers: { next_action: { type: 'choice', choice: 'click:18' } } }])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open Settings' })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /could read/i)
  assert.equal(browser.actions.length, 0)
})

test('three identical page states escalate instead of clicking forever', async () => {
  const same = frame([{ ref: '18', role: 'link', name: 'Settings' }], { text: 'unchanged page' })
  const browser = fakeBrowser([same, same, same, same])
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open Settings' })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /did not change/i)
  assert.equal(browser.actions.length, 2)
  assert.equal(decisions.requests.length, 2)
})

test('one decision repeats its action, following the control to a new node', async () => {
  // A re-rendered list gives the same button a new node id, so a repeat matches
  // the control by what it is — role and name — rather than by the ref the first
  // click used.
  const page = (ref: string) => frame([{ ref, role: 'button', name: 'Next page' }], { url: `https://example.com/page-${ref}` })
  const browser = fakeBrowser([page('18'), page('22'), page('31'), page('44'), page('44')])
  const decisions = scriptedDecisions([
    verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 }, repeat: 0.95, repeatLimit: 4 }),
    verdict({ completed: 0.99 }),
  ])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Page through to the end' })

  assert.equal(result.status, 'completed')
  assert.equal(result.metrics.browserActions, 4)
  assert.equal(result.metrics.jevCalls, 2, 'four actions cost one decision plus the completion check')
  assert.deepEqual(result.steps.map(step => step.action), ['click:18', 'click:22', 'click:31', 'click:44'])
})

test('a repeat stops when the control is gone', async () => {
  const browser = fakeBrowser([
    frame([{ ref: '18', role: 'button', name: 'Next page' }], { url: 'https://example.com/1' }),
    frame([{ ref: '7', role: 'link', name: 'Nothing to do' }], { url: 'https://example.com/2' }),
  ])
  const decisions = scriptedDecisions([
    verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 }, repeat: 0.95, repeatLimit: 8 }),
    verdict({ completed: 0.99 }),
  ])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Page through to the end' })

  assert.equal(result.metrics.browserActions, 1, 'a control that is no longer offered ends the run of repeats')
  assert.equal(result.status, 'completed')
})

test('outside sustained control a repeat that changes nothing ends the run', async () => {
  const same = frame([{ ref: '18', role: 'button', name: 'Load more' }], { url: 'https://example.com/fixed', text: 'unchanged' })
  const browser = fakeBrowser([same, same, same, same])
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 }, repeat: 0.95, repeatLimit: 8 })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Load everything' })

  assert.equal(browser.actions.length, 2, 'the first action plus one repeat, then the page said nothing changed')
  assert.equal(result.metrics.browserActions, 2)
})

test('the caller caps how far one decision reaches', async () => {
  const page = (index: number) => frame([{ ref: String(10 + index), role: 'button', name: 'Next page' }], { url: `https://example.com/${index}` })
  const browser = fakeBrowser([page(0), page(1), page(2), page(3), page(4)])
  const decisions = scriptedDecisions([
    verdict({ action: 'click:10', probabilities: { 'click:10': 0.99 }, repeat: 0.95, repeatLimit: 12 }),
    verdict({ completed: 0.99 }),
  ])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Page through', maxRepeat: 3 })

  assert.equal(result.metrics.browserActions, 3)
})

test('a repeat still respects the step limit', async () => {
  const page = (index: number) => frame([{ ref: String(10 + index), role: 'button', name: 'Next page' }], { url: `https://example.com/${index}` })
  const browser = fakeBrowser([page(0), page(1), page(2), page(3)])
  const decisions = scriptedDecisions([verdict({ action: 'click:10', probabilities: { 'click:10': 0.99 }, repeat: 0.95, repeatLimit: 8 })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Page through', maxSteps: 2 })

  assert.equal(result.metrics.browserActions, 2)
  assert.equal(result.status, 'max_steps')
})

test('a thin choice does not get repeated', async () => {
  const page = (index: number) => frame([{ ref: String(10 + index), role: 'button', name: 'Next page' }], { url: `https://example.com/${index}` })
  const browser = fakeBrowser([page(0), page(1), page(2)])
  const decisions = scriptedDecisions([
    verdict({ action: 'click:10', probabilities: { 'click:10': 0.55, 'click:11': 0.4 }, repeat: 0.99, repeatLimit: 8 }),
    verdict({ completed: 0.99 }),
  ])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Page through', control: true })

  assert.equal(result.metrics.browserActions, 1, 'a doubtful choice is never multiplied, even when control lets it run')
})

test('independent subgoals advance at the same time on their own tabs', async () => {
  const frames = (label: string) => [
    frame([{ ref: '18', role: 'link', name: label }], { url: `https://example.com/${label}` }),
    frame([{ ref: '18', role: 'link', name: label }], { url: `https://example.com/${label}-done` }),
  ]
  const hosts = new Map([['session-a', fakeBrowser(frames('alpha'))], ['session-b', fakeBrowser(frames('beta'))], ['session-c', fakeBrowser(frames('gamma'))]])
  const client: DecisionClient = { async decide() { return verdict({ completed: 0.99 }) } }
  const [tool] = browserFastToolDefinitions({
    settings: settingsWith([openRouterProvider()]),
    host: {
      snapshot: async (_taskId, sessionId) => hosts.get(String(sessionId))!.host.snapshot('task-1', sessionId, false),
      act: async (_taskId, sessionId, action) => hosts.get(String(sessionId))!.host.act('task-1', sessionId, action),
    },
    taskId: 'task-1',
    client,
  })

  const started = Date.now()
  const result = await tool.execute('call-1', {
    goals: [
      { browser_session_id: 'session-a', goal: 'Open alpha' },
      { browser_session_id: 'session-b', goal: 'Open beta' },
      { browser_session_id: 'session-c', goal: 'Open gamma' },
    ],
  }, undefined, undefined, undefined as never)
  const details = result.details as { status: string; results: BrowserFastResult[] }

  assert.equal(details.status, 'parallel')
  assert.equal(details.results.length, 3)
  assert.ok(details.results.every(item => item.status === 'completed'), JSON.stringify(details.results.map(item => item.status)))
  assert.ok(Date.now() - started < 3_000)
})

test('parallel goals must not share a tab, and each needs its own session', async () => {
  const client: DecisionClient = { async decide() { return verdict({ completed: 0.99 }) } }
  const [tool] = browserFastToolDefinitions({ settings: settingsWith([openRouterProvider()]), host: fakeBrowser([frame([])]).host, taskId: 'task-1', client })
  const run = (goals: unknown) => tool.execute('call-1', { goals } as never, undefined, undefined, undefined as never)

  await assert.rejects(() => run([{ browser_session_id: 'same', goal: 'a' }, { browser_session_id: 'same', goal: 'b' }]), /different Chrome tab/i)
  await assert.rejects(() => run([{ goal: 'a' }, { goal: 'b' }]), /own browser_session_id/i)
  await assert.rejects(() => tool.execute('call-2', {} as never, undefined, undefined, undefined as never), /State one browser subgoal/i)
})

test('a caller-determined plan runs at browser speed, one decision per cycle', async () => {
  // The steps are named, so nothing has to be computed or chosen per action: two
  // actions cost one decision, and it is only the completion check.
  const page = (index: number) => frame([
    { ref: '9', role: 'button', name: '横移到食物列' },
    { ref: '10', role: 'button', name: '纵移到食物行' },
  ], { url: `https://game.example/step-${index}` })
  const browser = fakeBrowser([page(0), page(1), page(2)])
  const decisions = scriptedDecisions([verdict({ completed: 0.99 })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({
    taskId: 'task-1', goal: '吃到食物', plan: ['横移到食物列', '纵移到食物行'], cycles: 1,
  })

  assert.equal(result.status, 'completed')
  assert.deepEqual(result.steps.map(step => step.action), ['click:9', 'click:10'])
  assert.equal(result.metrics.browserActions, 2)
  assert.equal(result.metrics.jevCalls, 1, 'the plan itself needs no decision')
})

test('a plan follows a control to its new node and cycles while the goal is open', async () => {
  const page = (index: number) => frame([{ ref: String(20 + index), role: 'button', name: 'Next' }], { url: `https://game.example/${index}` })
  const browser = fakeBrowser([page(0), page(1), page(2), page(3)])
  const decisions = scriptedDecisions([verdict({ completed: 0.1 }), verdict({ completed: 0.99 })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({
    taskId: 'task-1', goal: '走到底', plan: ['Next'], cycles: 4,
  })

  assert.equal(result.status, 'completed')
  assert.equal(result.metrics.browserActions, 2, 'the second cycle saw the goal reached')
  assert.deepEqual(result.steps.map(step => step.action), ['click:20', 'click:21'])
  assert.equal(result.metrics.jevCalls, 2)
})

test('a plan whose controls are not here hands back instead of guessing', async () => {
  const browser = fakeBrowser([frame([{ ref: '7', role: 'link', name: 'Nothing named that' }])])
  const decisions = scriptedDecisions([verdict({ completed: 0.99 })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({
    taskId: 'task-1', goal: '吃到食物', plan: ['横移到食物列', '纵移到食物行'],
  })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /plan names/i)
  assert.equal(browser.actions.length, 0)
})

test('a plan step is matched by the control it names', () => {
  const candidates = buildActionCandidates({ nodes: [
    { ref: '9', role: 'button', name: '横移到食物列' },
    { ref: '10', role: 'button', name: '纵移到食物行' },
    { ref: '13', role: 'button', name: '开始游戏' },
  ] }, '吃到食物')

  assert.equal(matchPlanStep(candidates, '横移到食物列')?.id, 'click:9', 'an exact name wins')
  assert.equal(matchPlanStep(candidates, '纵移')?.id, 'click:10', 'a phrase inside the name works')
  assert.equal(matchPlanStep(candidates, '开始游戏')?.id, 'click:13')
  assert.equal(matchPlanStep(candidates, 'elephant'), undefined)
  assert.equal(matchPlanStep(candidates, ''), undefined)
})

test('repeating one action is progress while the page keeps moving', async () => {
  // Paging, scrolling, and a game key all repeat one action while the page moves.
  // Only an action that leaves the page identical is a loop.
  const browser = fakeBrowser([1, 2, 3, 4, 5, 6].map(index => frame([{ ref: '18', role: 'button', name: 'Next page' }], { url: `https://example.com/${index}` })))
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Continue to the next page', maxSteps: 5 })

  assert.equal(result.status, 'max_steps')
  assert.equal(browser.actions.length, 5)
  assert.equal(result.metrics.browserActions, 5)
})

test('an action that leaves the page exactly as it was stops the loop', async () => {
  const same = frame([{ ref: '18', role: 'button', name: 'Reload data' }], { url: 'https://example.com/same', text: 'unchanged' })
  const browser = fakeBrowser([same, same, same, same])
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Make the page show data', maxSteps: 10 })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /did not change after repeated actions/i)
  assert.equal(browser.actions.length, 2)
})

test('sustained control keeps steering a page that cannot change', async () => {
  // A canvas reports the same accessibility tree however the game is doing, so in
  // browse mode two unchanged actions end the loop. Under sustained control the
  // caller's step limit is the bound instead, because the page changing is not
  // what progress means for this kind of interaction.
  const canvas = frame([{ ref: '1', role: 'Canvas', name: 'Canvas' }], { url: 'https://game.example/play', text: 'Canvas' })
  const browser = fakeBrowser(Array.from({ length: 12 }, () => canvas))
  const decisions = scriptedDecisions([verdict({ action: 'key:ArrowUp', probabilities: { 'key:ArrowUp': 0.98 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Steer the snake', keys: ['ArrowUp'], control: true, maxSteps: 10 })

  assert.equal(result.status, 'max_steps')
  assert.equal(browser.actions.length, 10)
  assert.equal(result.metrics.browserActions, 10)
  assert.ok(result.steps.every(step => step.action === 'key:ArrowUp'))
})

test('only keys the Chrome bridge can dispatch are offered', () => {
  assert.deepEqual(declaredKeys(['ArrowUp', 'ArrowDown', 'Home', 'Enter']), ['ArrowUp', 'ArrowDown', 'Enter'])
  assert.deepEqual(declaredKeys(['a', '7', 'ArrowLeft']), ['a', '7', 'ArrowLeft'])
  assert.deepEqual(declaredKeys(['ArrowUp', 'ArrowUp']), ['ArrowUp'])
  assert.deepEqual(declaredKeys('ArrowUp'), [])
  assert.equal(declaredKeys(Array.from({ length: 30 }, (_, index) => String.fromCharCode(97 + (index % 26)))).length, 12)

  const candidates = buildActionCandidates({ nodes: [{ ref: '1', role: 'Canvas', name: 'Canvas' }] }, 'Steer', { keys: ['ArrowUp', 'ArrowDown'] })
  assert.deepEqual(candidates.find(candidate => candidate.id === 'key:ArrowUp')?.action, { action: 'keypress', key: 'ArrowUp' })
  assert.ok(candidates.some(candidate => candidate.id === 'key:ArrowDown'))
  assert.ok(!candidates.some(candidate => candidate.id === 'key:Home'), 'an unsupported key is never offered')
})

test('a beat is offered only when waiting is plausibly right', () => {
  // A healthy page with real controls gets no beat: an extra option only dilutes
  // the choice between the actions that are actually there.
  const healthy = buildActionCandidates({ nodes: [{ ref: '18', role: 'link', name: 'Settings' }], readyState: 'complete' }, 'Open Settings')
  assert.ok(!healthy.some(candidate => candidate.id === 'wait'))

  // A page that has not rendered anything to act on yet, or says it is loading, is
  // where a beat belongs.
  const empty = buildActionCandidates({ nodes: [{ ref: '1', role: 'paragraph', name: 'Loading…' }], readyState: 'complete' }, 'Open Settings')
  assert.ok(empty.some(candidate => candidate.id === 'wait'))
  const loading = buildActionCandidates({ nodes: [{ ref: '18', role: 'link', name: 'Settings' }], readyState: 'loading' }, 'Open Settings')
  assert.ok(loading.some(candidate => candidate.id === 'wait'))
  assert.deepEqual(empty.find(candidate => candidate.id === 'wait')?.waitMs, 400)
})

test('a wait lets the fast loop keep its own rhythm instead of handing back', async () => {
  const browser = fakeBrowser([
    frame([{ ref: '1', role: 'paragraph', name: 'Loading the repository…' }], { url: 'https://example.com/loading' }),
    frame([{ ref: '18', role: 'link', name: 'Settings' }], { url: 'https://example.com/settings' }),
  ], { pageAdvancesByItself: true })
  const decisions = scriptedDecisions([
    verdict({ action: 'wait', probabilities: { wait: 0.9, escalate: 0.1 } }),
    verdict({ action: 'click:18', probabilities: { 'click:18': 0.98 } }),
    verdict({ completed: 0.99 }),
  ])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open Settings once the page finishes loading', maxSteps: 5 })

  assert.equal(result.status, 'completed')
  assert.equal(result.metrics.waits, 1)
  assert.equal(result.metrics.browserActions, 1, 'a wait is not a browser action')
  assert.equal(result.steps[0].action, 'wait')
  assert.deepEqual(browser.actions, [{ action: 'click', ref: '18' }])
})

test('waiting is bounded and never spends the action budget', async () => {
  const browser = fakeBrowser([frame([{ ref: '1', role: 'paragraph', name: 'Loading…' }])])
  const decisions = scriptedDecisions([verdict({ action: 'wait', probabilities: { wait: 0.9 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Wait for the page', maxSteps: 3 })

  assert.equal(result.metrics.waits, 2, 'the browse-mode wait budget is two')
  assert.equal(result.metrics.browserActions, 0)
  assert.equal(browser.actions.length, 0)
  assert.equal(result.status, 'escalate')
})

test('sustained control takes a thin choice instead of asking, up to its budget', async () => {
  const frames = [1, 2, 3, 4, 5, 6].map(index => frame([{ ref: '18', role: 'link', name: 'Advance' }], { url: `https://game.example/${index}` }))
  const thin = () => verdict({ action: 'click:18', probabilities: { 'click:18': 0.55, 'click:19': 0.4 } })

  const strict = await new BrowserFastExecutor(fakeBrowser(frames).host, scriptedDecisions([thin()]).client, config).execute({ taskId: 'task-1', goal: 'Advance' })
  assert.equal(strict.status, 'escalate')
  assert.match(String(strict.reason), /nearly as likely/i)
  assert.equal(strict.metrics.browserActions, 0)

  const sustained = fakeBrowser(frames)
  const loose = await new BrowserFastExecutor(sustained.host, scriptedDecisions([thin()]).client, config).execute({ taskId: 'task-1', goal: 'Advance', control: true })
  assert.equal(loose.metrics.uncertainSteps, 3, 'a run of thin choices is bounded, then it hands back')
  assert.equal(loose.status, 'escalate')
  assert.ok(loose.steps.every(step => step.uncertain), 'each thin step records why it was taken')
  assert.equal(sustained.actions.length, 3)
})

test('sustained control never relaxes the external-state boundary', async () => {
  const browser = fakeBrowser([frame([{ ref: '18', role: 'button', name: 'Delete repository' }])])
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 }, mutation: 0.6 })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Remove the repository', control: true })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /external state/i)
  assert.equal(browser.actions.length, 0)
})

test('an explicit hand-back is respected even in sustained control', async () => {
  const browser = fakeBrowser([frame([{ ref: '18', role: 'link', name: 'Account' }])])
  const decisions = scriptedDecisions([verdict({ action: 'escalate', probabilities: { escalate: 0.8, 'click:18': 0.2 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open the correct account', control: true })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /needs the main model/i)
  assert.equal(browser.actions.length, 0)
})

test('a failed fast decision leaves the run usable', async () => {
  const browser = fakeBrowser([frame([{ ref: '18', role: 'link', name: 'Settings' }])])
  const decisions = scriptedDecisions([Error('Fast browser decisions are unavailable right now (request failed with status 500). Continue with the normal Browser Use tools.')])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open Settings' })

  assert.equal(result.status, 'error')
  assert.match(String(result.reason), /unavailable/i)
  assert.equal(browser.actions.length, 0)
  assert.equal(result.metrics.jevCalls, 1)
})

test('a control something is covering hands the goal back instead of failing it', async () => {
  // A dialog in the way is a page state to resolve, not a broken fast path, so the
  // reason reaches the main model instead of the goal ending as a mechanism error.
  const host: BrowserFastHost = {
    async snapshot() { return frame([{ ref: '91', role: 'button', name: 'Save' }]) },
    async act() { throw new BrowserControlBlockedError('div "Save changes"') },
  }
  const decisions = scriptedDecisions([verdict({ action: 'click:91', probabilities: { 'click:91': 0.99 } })])

  const result = await new BrowserFastExecutor(host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Save the form' })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /behind div "Save changes"/)
  assert.equal(result.metrics.browserActions, 0)
  assert.ok(result.snapshot, 'the hand-back carries the page the main model needs')
})

test('a browser action failure is reported, not thrown', async () => {
  const host: BrowserFastHost = {
    async snapshot() { return frame([{ ref: '18', role: 'link', name: 'Settings' }]) },
    async act() { throw Error('That Chrome tab is no longer attached.') },
  }
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 } })])

  const result = await new BrowserFastExecutor(host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open Settings' })

  assert.equal(result.status, 'error')
  assert.match(String(result.reason), /no longer attached/i)
})

test('an unreachable browser session is reported, not thrown', async () => {
  const host: BrowserFastHost = {
    async snapshot() { throw Error('Chrome Browser Use is disconnected. Reconnect the extension and try again.') },
    async act() { throw Error('unreachable') },
  }
  const decisions = scriptedDecisions([verdict({ completed: 0.99 })])

  const result = await new BrowserFastExecutor(host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open Settings' })

  assert.equal(result.status, 'error')
  assert.match(String(result.reason), /disconnected/i)
  assert.equal(decisions.requests.length, 0, 'no decision is requested for a page that was never read')
})

test('a sensitive value never reaches the fast decision request', async () => {
  const browser = fakeBrowser([frame([{ ref: '21', role: 'textbox', name: 'Password' }])])
  const decisions = scriptedDecisions([verdict({ action: 'type:21:password', probabilities: { 'type:21:password': 0.99 } })])
  const executor = new BrowserFastExecutor(browser.host, decisions.client, config)

  await executor.execute({ taskId: 'task-1', goal: 'Enter the stored password', input: { password: 'hunter2' }, maxSteps: 1 })

  const serialized = JSON.stringify(decisions.requests[0])
  assert.doesNotMatch(serialized, /hunter2/)
  assert.match(serialized, /"sensitive":true/)
  assert.deepEqual(browser.actions, [{ action: 'type', ref: '21', text: 'hunter2', clear: true }])
  assert.doesNotMatch(JSON.stringify(executor.traces), /hunter2/)
})

test('the step limit bounds autonomous control', async () => {
  const browser = fakeBrowser([
    frame([{ ref: '18', role: 'link', name: 'Next' }], { url: 'https://example.com/1' }),
    frame([{ ref: '18', role: 'link', name: 'Next' }], { url: 'https://example.com/2' }),
    frame([{ ref: '18', role: 'link', name: 'Next' }], { url: 'https://example.com/3' }),
  ])
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Keep navigating', maxSteps: 2 })

  assert.equal(result.status, 'max_steps')
  assert.equal(browser.actions.length, 2)
})

test('the fast state carries no conversation and no screenshot', () => {
  const state = buildJevState({
    goal: 'Open settings',
    input: { query: 'shun', apiKey: 'sk-live' },
    snapshot: frame([{ ref: '18', role: 'link', name: 'Settings' }]).snapshot,
    candidates: buildActionCandidates({ nodes: [{ ref: '18', role: 'link', name: 'Settings' }] }, 'Open settings'),
    history: [],
  })

  assert.deepEqual(Object.keys(state).sort(), ['available_actions', 'description', 'elements', 'goal', 'page', 'recent_actions', 'supplied_inputs', 'visible_text'])
  const serialized = JSON.stringify(state)
  assert.doesNotMatch(serialized, /sk-live/)
  assert.doesNotMatch(serialized, /screenshot/i)
  assert.match(serialized, /"query","available":true,"sensitive":false,"value":"shun"/)
})

test('control state reaches the fast model so completion can be judged without acting', () => {
  const state = buildJevState({
    goal: 'Expand Guides',
    snapshot: frame([
      { ref: '20', role: 'treeitem', name: 'Guides', expanded: true },
      { ref: '24', role: 'checkbox', name: 'Enable caching', checked: false, disabled: true },
    ]).snapshot,
    candidates: buildActionCandidates({ nodes: [{ ref: '20', role: 'treeitem', name: 'Guides' }] }, 'Expand Guides'),
    history: [],
  })

  assert.deepEqual((state.elements as any[]).map(element => element.state), ['expanded=true', 'disabled checked=false'])
})
