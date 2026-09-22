import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserSession, ComputerUseAccelerationSettings, Provider, Settings } from '../shared.ts'
import { BrowserControlBlockedError, BrowserControlGoneError, BrowserFastUnsupportedError, fastRefusalSentence, fastSnapshotAsChromeSnapshot, formatFastSnapshot } from './chrome-browser.ts'
import type { BrowserAction, ChromeSnapshot, FastBrowserAction, FastPageElement, FastPageSnapshot } from './chrome-browser.ts'
import { accelerationStatus, BrowserFastExecutor, browserFastToolDefinitions, buildActionCandidates, buildJevState, declaredKeys, matchPlanStep, type BrowserFastConfig, type BrowserFastHost, type BrowserFastResult } from './browser-fast.ts'
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

function verdict(values: { completed?: number; endShown?: number; action?: string; probabilities?: Record<string, number>; confidence?: number; unambiguous?: number; mutation?: number; repeat?: number; repeatLimit?: number }): DecisionResponse {
  return {
    model: 'jev-test',
    answers: {
      goal_completed: { type: 'noul', noul: values.completed ?? 0 },
      // The page showing the end the goal names is what corroborates an uncertain claim, and the
      // helper answers that it does unless a test says otherwise.
      goal_end_shown: { type: 'noul', noul: values.endShown ?? 1 },
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

test('a run that does not get acceleration records why', () => {
  const noProviders = accelerationStatus({ providers: [] })
  assert.equal(noProviders.resolved, false)
  assert.match(noProviders.reason, /no providers at all/)

  const keyless = accelerationStatus({ providers: [openRouterProvider({ apiKey: '' })] })
  assert.equal(keyless.resolved, false)
  assert.match(keyless.reason, /no configured provider reaches a decision service/)
  assert.deepEqual(keyless.routable, ['openrouter:no-key'])

  const switchedOff = accelerationStatus({ providers: [openRouterProvider()], computerUseAcceleration: { enabled: false } })
  assert.match(switchedOff.reason, /switched off/)

  // Naming a provider that is not here falls back to the first routable one, so the
  // recorded reason is only reached when nothing routable carries a credential.
  assert.equal(accelerationStatus({ providers: [openRouterProvider()], computerUseAcceleration: { provider: '9f0c-missing' } }).resolved, true)

  const resolved = accelerationStatus({ providers: [openRouterProvider()] })
  assert.equal(resolved.resolved, true)
  assert.equal(resolved.routable.join(), 'openrouter:keyed')
})

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

const corroborated: BrowserFastConfig = { ...config, minCompletionConfidence: 0.7, certainCompletionConfidence: 0.9 }

test('a completion claim the page does not corroborate is not an end', async () => {
  // Over a long task that repeats the same sequence the completion judgement drifts upward with
  // the number of passes made: measured on two real runs, the only steps above 0.5 were the
  // returns to the list page, climbing to 0.70 and 0.78 while the page plainly had more to do,
  // and each run ended early on one of them. A claim below certainty therefore has to be
  // corroborated by the page — the end the goal itself names — and when it is not, the session
  // keeps working and reports that the claim was made.
  const browser = fakeBrowser([
    frame([{ ref: '55', role: 'link', name: 'next' }], { url: 'https://example.com/list?page=3' }),
    frame([{ ref: '55', role: 'link', name: 'next' }], { url: 'https://example.com/list?page=4' }),
  ])
  const decisions = scriptedDecisions([
    verdict({ completed: 0.72, endShown: 0.2, action: 'click:55', probabilities: { 'click:55': 0.9 } }),
    verdict({ completed: 0.99 }),
  ])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, corroborated).execute({ taskId: 'task-1', goal: 'Work through the pages to the last one' })

  assert.equal(result.status, 'completed')
  assert.equal(browser.actions.length, 1, 'the page had more to do, so the step was taken anyway')
  assert.equal(result.steps[0].completionClaim, 0.72, 'the claim is reported instead of being dropped')
})

test('a completion claim the page corroborates is an end', async () => {
  const browser = fakeBrowser([frame([{ ref: '55', role: 'link', name: 'next' }], { url: 'https://example.com/list?page=50' })])
  const decisions = scriptedDecisions([verdict({ completed: 0.72, endShown: 0.85, action: 'click:55', probabilities: { 'click:55': 0.9 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, corroborated).execute({ taskId: 'task-1', goal: 'Work through the pages to the last one' })

  assert.equal(result.status, 'completed')
  assert.equal(browser.actions.length, 0)
})

test('certainty ends a run without the page corroborating it', async () => {
  // The certain bar comes from the corpus, where every true completion sat at 0.9 or above, so a
  // claim there is taken at its word rather than costing the caller a step it did not need.
  const browser = fakeBrowser([frame([{ ref: '55', role: 'link', name: 'next' }], { url: 'https://example.com/list?page=50' })])
  const decisions = scriptedDecisions([verdict({ completed: 0.91, endShown: 0, action: 'click:55', probabilities: { 'click:55': 0.9 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, corroborated).execute({ taskId: 'task-1', goal: 'Work through the pages to the last one' })

  assert.equal(result.status, 'completed')
  assert.equal(browser.actions.length, 0)
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
  assert.match(String(blocked.reason), /outside this page/i)
  assert.equal(unauthorized.actions.length, 0)

  const allowed = await new BrowserFastExecutor(authorized.host, scriptedDecisions([response, verdict({ completed: 0.99 })]).client, config).execute({ taskId: 'task-1', goal: 'Remove the repository', allowMutations: true })
  assert.equal(allowed.status, 'completed')
  assert.equal(authorized.actions.length, 1)

  // A control whose name says what it does is refused on that name alone, whatever the
  // decision model concluded about the intent behind it.
  const named = fakeBrowser([frame([{ ref: '18', role: 'button', name: 'Send message' }])])
  const reassuring = await new BrowserFastExecutor(named.host, scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 }, mutation: 0.01 })]).client, config).execute({ taskId: 'task-1', goal: 'Reply to the thread' })
  assert.equal(reassuring.status, 'escalate')
  assert.match(String(reassuring.reason), /Send message/)
  assert.equal(named.actions.length, 0)

  // …while the model's own answer still stops an action whose name gives nothing away.
  const quiet = fakeBrowser([frame([{ ref: '18', role: 'button', name: 'Continue' }])])
  const judged = await new BrowserFastExecutor(quiet.host, scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 }, mutation: 0.6 })]).client, config).execute({ taskId: 'task-1', goal: 'Finish the purchase' })
  assert.equal(judged.status, 'escalate')
  assert.match(String(judged.reason), /external state/i)
  assert.equal(quiet.actions.length, 0)
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

  // A step is matched by a control's own name, never by the words of a description, and a fixed
  // option never advertises itself as a route to the goal: a plan step named "More" used to
  // match the scroll whose description read "reveal more of the page", so the page scrolled
  // instead of turning — on Hacker News, the exact case.
  const paging = buildActionCandidates({ nodes: [] }, 'Open the next page of stories')
  const scroll = paging.find(candidate => candidate.id === 'scroll:down')
  assert.match(String(scroll?.description), /does not change and nothing is opened/)
  assert.doesNotMatch(String(scroll?.description), /more/i, 'a fixed option does not promise what the goal asks for')
  assert.equal(matchPlanStep(paging, 'More'), undefined, 'a name that matches no control is not a description')
})

test('a sustained session is not ended by a step count or by thin choices', async () => {
  // Every return costs the caller a full model turn, so a task that moves on its own
  // clock must be able to run for as long as it needs to.
  const frames = Array.from({ length: 700 }, (_value, index) => frame([{ ref: '18', role: 'button', name: 'Step' }], { url: `https://pace.example/${index}` }))
  const browser = fakeBrowser(frames)
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Keep the pace', sustained: true })

  assert.equal(result.metrics.browserActions, 600, 'the sustained budget is steps, not a hand-back')
  assert.equal(result.status, 'max_steps')
})

test('a sustained session still bounds a long run of thin choices on a still page', async () => {
  // Bounded autonomy is not suspended for a session: a choice that stays uncertain
  // twelve times over on a page that is not moving is a guess being repeated.
  const still = frame([{ ref: '18', role: 'button', name: 'Step' }], { url: 'https://pace.example/still', text: 'still' })
  const browser = fakeBrowser(Array.from({ length: 40 }, () => still))
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.55, 'click:19': 0.4 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Keep the pace', sustained: true, maxStallSteps: 100 })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /nearly as likely/i)
  assert.equal(result.metrics.browserActions, 12, 'a sustained run of thin choices is longer, not unlimited')
  assert.equal(result.metrics.uncertainSteps, 12)
})

test('a thin choice on a page that moved is a new situation, not a repeated guess', async () => {
  // A live task can look equally uncertain at every step while it is still moving.
  // Counting those as one long run of guessing ends a session early for no reason.
  const frames = Array.from({ length: 40 }, (_value, index) => frame([{ ref: '18', role: 'button', name: 'Step' }], { url: `https://pace.example/${index}`, text: `frame ${index}` }))
  const browser = fakeBrowser(frames)
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.55, 'click:19': 0.4 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Keep the pace', sustained: true, maxSteps: 20 })

  assert.equal(result.status, 'max_steps')
  assert.equal(result.metrics.browserActions, 20, 'the page moved twenty times, so nothing was repeated')
  assert.equal(result.metrics.uncertainSteps, 20)
})

test('a sustained session hands back only when the page stops changing', async () => {
  const same = frame([{ ref: '18', role: 'button', name: 'Step' }], { url: 'https://pace.example/still', text: 'still' })
  const browser = fakeBrowser(Array.from({ length: 20 }, () => same))
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Keep the pace', sustained: true, maxStallSteps: 5 })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /did not change after repeated actions/)
  assert.equal(result.metrics.browserActions, 5)
})

test('a sustained session can take many beats without that counting as a stall', async () => {
  // A beat changes nothing by definition, so judging "no progress" by it would end
  // every loop that is waiting for a page to catch up.
  const same = frame([{ ref: '1', role: 'paragraph', name: 'Loading…' }], { url: 'https://pace.example/waiting', text: 'waiting' })
  const browser = fakeBrowser(Array.from({ length: 20 }, () => same))
  const decisions = scriptedDecisions([verdict({ action: 'wait', probabilities: { wait: 0.9 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Wait for the page', sustained: true, maxStallSteps: 2, waitBudget: 30 })

  assert.equal(result.metrics.waits, 30, 'the stall rule never counted a beat')
  assert.equal(result.metrics.browserActions, 0)
})

test('a declared deadline paces how often completion is judged', async () => {
  // A judgement is a beat of its own. Spending one every cycle is what makes a loop
  // miss a step deadline it could otherwise keep.
  const frames = Array.from({ length: 6 }, (_value, index) => frame([{ ref: String(10 + index), role: 'button', name: 'Hold' }], { url: `https://pace.example/${index}` }))
  const decisions = scriptedDecisions([verdict({ completed: 0.1 })])

  const paced = await new BrowserFastExecutor(fakeBrowser(frames).host, decisions.client, config).execute({
    taskId: 'task-1', goal: 'Hold the line', sustained: true, plan: ['Hold'], cycles: 3, deadlineMs: 600_000,
  })
  assert.equal(paced.metrics.browserActions, 3)
  assert.equal(paced.metrics.jevCalls, 2, 'one paced judgement for three cycles, then the normal loop')

  const unpaced = await new BrowserFastExecutor(fakeBrowser(frames).host, scriptedDecisions([verdict({ completed: 0.1 })]).client, config).execute({
    taskId: 'task-1', goal: 'Hold the line', sustained: true, plan: ['Hold'], cycles: 3,
  })
  assert.equal(unpaced.metrics.jevCalls, 4, 'without a declared deadline every cycle is judged, then the normal loop')
})

test('a caller-determined plan step is not judged as a stall either', async () => {
  // The caller already decided this step. Repeating it is the instruction, not a
  // failure to make progress.
  const same = frame([{ ref: '9', role: 'button', name: 'Hold' }], { url: 'https://pace.example/hold', text: 'holding' })
  const browser = fakeBrowser(Array.from({ length: 20 }, () => same))
  const decisionsClient = scriptedDecisions([verdict({ completed: 0.1 })])

  const result = await new BrowserFastExecutor(browser.host, decisionsClient.client, config).execute({
    taskId: 'task-1', goal: 'Hold the line', sustained: true, maxStallSteps: 3, plan: ['Hold'], cycles: 10,
  })

  assert.equal(result.metrics.browserActions, 10, 'ten holds, none of them a stall')
  assert.equal(result.metrics.blockedSteps, 0)
})

test('every step reports its cost, whether it changed the page, and its deadline', async () => {
  const frames = Array.from({ length: 5 }, (_value, index) => frame([{ ref: '18', role: 'button', name: 'Step' }], { url: `https://pace.example/${index}`, text: `frame ${index}` }))
  // A step that costs real time, so a tight deadline can be missed the way a live
  // page misses it.
  let index = 0
  const host: BrowserFastHost = {
    async snapshot() { return frames[Math.min(index, frames.length - 1)] },
    async act() { await new Promise(resolve => setTimeout(resolve, 8)); index += 1; return frames[Math.min(index, frames.length - 1)] },
  }
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 } }), verdict({ completed: 0.99 })])

  const result = await new BrowserFastExecutor(host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Keep the pace', deadlineMs: 1, maxSteps: 2 })

  assert.equal(result.status, 'completed')
  assert.equal(result.steps.length, 1, 'the completing judgement is not a step')
  assert.equal(typeof result.steps[0].ms, 'number')
  assert.equal(result.steps[0].changed, true)
  assert.equal(result.steps[0].onTime, false, 'an eight-millisecond action cannot meet a one-millisecond deadline')
  assert.ok(Number(result.steps[0].ms) >= 8)
  assert.equal(result.steps[0].decisionMs !== undefined, true)
  assert.equal(result.metrics.deadlineMisses, 1)
  assert.equal(result.metrics.deadlineHitRate, 0)
  assert.ok(result.metrics.p50StepMs >= 0 && result.metrics.maxStepMs >= result.metrics.p50StepMs)
})

test('a deadline that is met reports a full hit rate', async () => {
  const frames = Array.from({ length: 3 }, (_value, index) => frame([{ ref: '18', role: 'button', name: 'Step' }], { url: `https://pace.example/${index}` }))
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 } }), verdict({ completed: 0.99 })])

  const result = await new BrowserFastExecutor(fakeBrowser(frames).host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Keep the pace', deadlineMs: 600_000, maxSteps: 1 })

  assert.equal(result.metrics.deadlineHitRate, 1)
  assert.equal(result.metrics.deadlineMisses, 0)
  assert.equal(result.steps[0].onTime, true)
})

test('a sustained session still finishes the moment the goal is done', async () => {
  const browser = fakeBrowser([frame([{ ref: '18', role: 'button', name: 'Step' }], { url: 'https://pace.example/done' })])
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 } }), verdict({ completed: 0.99 })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Keep the pace', sustained: true })

  assert.equal(result.status, 'completed')
  assert.equal(result.metrics.browserActions, 1)
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
  const still = frame([{ ref: '18', role: 'link', name: 'Advance' }], { url: 'https://game.example/still', text: 'still' })
  const frames = Array.from({ length: 8 }, () => still)
  const thin = () => verdict({ action: 'click:18', probabilities: { 'click:18': 0.55, 'click:19': 0.4 } })

  const strict = await new BrowserFastExecutor(fakeBrowser(frames).host, scriptedDecisions([thin()]).client, config).execute({ taskId: 'task-1', goal: 'Advance' })
  assert.equal(strict.status, 'escalate')
  assert.match(String(strict.reason), /nearly as likely/i)
  assert.equal(strict.metrics.browserActions, 0)

  const sustained = fakeBrowser(frames)
  const loose = await new BrowserFastExecutor(sustained.host, scriptedDecisions([thin()]).client, config).execute({ taskId: 'task-1', goal: 'Advance', control: true, maxStallSteps: 100 })
  assert.equal(loose.metrics.uncertainSteps, 3, 'a run of thin choices is bounded, then it hands back')
  assert.equal(loose.status, 'escalate')
  assert.ok(loose.steps.every(step => step.uncertain), 'each thin step records why it was taken')
  assert.equal(sustained.actions.length, 3)
})

test('sustained control never relaxes the external-state boundary', async () => {
  const browser = fakeBrowser([frame([{ ref: '18', role: 'button', name: 'Continue' }])])
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.99 }, mutation: 0.6 })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Finish the checkout', control: true })

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

test('a control that cannot be clicked is set aside and the loop carries on', async () => {
  // A live page covers and moves its controls constantly. A click that cannot land
  // is a fact about the page, so the loop records it, sets that control aside for the
  // state it failed in, and decides again among what is actually actionable.
  const veiled = frame([
    { ref: '91', role: 'button', name: 'Save' },
    { ref: '92', role: 'button', name: 'Dismiss' },
  ], { url: 'https://example.com/veiled', text: 'a dialog is open' })
  const clear = frame([{ ref: '91', role: 'button', name: 'Save' }], { url: 'https://example.com/ready', text: 'ready' })
  let index = 0
  const host: BrowserFastHost = {
    async snapshot() { return index === 0 ? veiled : clear },
    async act(_taskId, _sessionId, action) {
      if (action.ref === '91' && index === 0) throw new BrowserControlBlockedError('div "Save changes"')
      index = 1
      return clear
    },
  }
  const decisions = scriptedDecisions([
    verdict({ action: 'click:91', probabilities: { 'click:91': 0.99 } }),
    verdict({ action: 'click:92', probabilities: { 'click:92': 0.99 } }),
    verdict({ completed: 0.99 }),
  ])

  const result = await new BrowserFastExecutor(host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Save the form' })

  assert.equal(result.status, 'completed')
  assert.match(String(result.steps[0].blocked), /behind div "Save changes"/)
  assert.equal(result.steps[1].action, 'click:92', 'the next decision chose what was actually actionable')
  assert.equal(result.metrics.blockedSteps, 1)
  assert.equal(result.metrics.browserActions, 1, 'a blocked click is not a browser action')
})

test('a control that stays out of reach ends the loop with the obstruction named', async () => {
  const host: BrowserFastHost = {
    async snapshot() { return frame([{ ref: '91', role: 'button', name: 'Save' }]) },
    async act() { throw new BrowserControlBlockedError('div "Save changes"') },
  }
  const decisions = scriptedDecisions([verdict({ action: 'click:91', probabilities: { 'click:91': 0.99 } })])

  const result = await new BrowserFastExecutor(host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Save the form' })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /behind div "Save changes"/)
  assert.match(String(result.reason), /cannot be clicked until the page changes/)
  assert.ok(result.snapshot, 'the hand-back carries the page the main model needs')
})

test('a control that is gone is answered the same way as one that is covered', async () => {
  const host: BrowserFastHost = {
    async snapshot() { return frame([{ ref: '91', role: 'button', name: 'Save' }, { ref: '92', role: 'button', name: 'Retry' }]) },
    async act(_taskId, _sessionId, action) {
      if (action.ref === '91') throw new BrowserControlGoneError()
      return frame([{ ref: '92', role: 'button', name: 'Retry' }], { url: 'https://example.com/after' })
    },
  }
  const decisions = scriptedDecisions([
    verdict({ action: 'click:91', probabilities: { 'click:91': 0.99 } }),
    verdict({ action: 'click:92', probabilities: { 'click:92': 0.99 } }),
    verdict({ completed: 0.99 }),
  ])

  const result = await new BrowserFastExecutor(host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Save the form' })

  assert.equal(result.status, 'completed')
  assert.match(String(result.steps[0].blocked), /no longer where its position/)
  assert.equal(result.steps[1].action, 'click:92')
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

test('a decision is told the window the previous action changed, so a step can be judged from motion', async () => {
  const nodes = [{ ref: '5', role: 'button', name: 'Step' }]
  const browser = fakeBrowser([
    frame(nodes, { text: 'counter 1' }),
    frame(nodes, { text: 'counter 2' }),
  ])
  const decisions = scriptedDecisions([
    verdict({ action: 'click:5', probabilities: { 'click:5': 1 } }),
    verdict({ completed: 0.95 }),
  ])

  await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Step the counter' })

  const first = decisions.requests[0].state as { page: Record<string, unknown> }
  const second = decisions.requests[1].state as { page: Record<string, unknown>; visible_text: string }
  assert.equal(first.page.text_change_since_last_action, undefined, 'the first decision has no previous action to compare against')
  assert.deepEqual(second.page.text_change_since_last_action, { before: 'counter 1', after: 'counter 2' })
  assert.equal(second.visible_text, 'counter 2', 'the window is carried alongside the page, not instead of it')
})

test('a decision is told when the previous action has shown no effect yet', () => {
  const state = buildJevState({
    goal: 'Step the counter',
    snapshot: frame([{ ref: '5', role: 'button', name: 'Step' }], { text: 'counter 2' }).snapshot,
    candidates: buildActionCandidates({ nodes: [{ ref: '5', role: 'button', name: 'Step' }] }, 'Step the counter'),
    history: [],
    textBeforeLastAction: 'counter 2',
  })

  assert.equal((state.page as Record<string, unknown>).text_unchanged_since_last_action, true)
  assert.equal((state.page as Record<string, unknown>).text_change_since_last_action, undefined)
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

// The fast path observes the DOM instead of the accessibility tree, and verifies the control
// a decision named before it is used. What it must never do is act on a control the page has
// moved on from, or stop Browser Use from working when the browser does not offer it.

function fastFrame(elements: Array<Record<string, any>>, options: { url?: string; text?: string; fingerprint?: string; frames?: { total: number; crossOrigin: number } } = {}) {
  const url = options.url || 'https://github.com/x/settings'
  const title = 'Settings'
  const session: BrowserSession = {
    id: 'session-1', taskId: 'task-1', createdByRunId: 'run-1', tabId: 7, owned: false, state: 'attached',
    url, title, createdAt: 1, updatedAt: 1, consoleEntries: 0, pageErrors: 0,
  }
  const fast: FastPageSnapshot = {
    url, title, readyState: 'complete', text: options.text || 'Settings page',
    marker: '1700000000000', fingerprint: options.fingerprint || 'page-fp', elements: elements as FastPageElement[],
    ...(options.frames ? { frames: options.frames } : {}),
  }
  return { session, snapshot: fastSnapshotAsChromeSnapshot(fast, session), text: formatFastSnapshot(fast, session), fast }
}

function fastBrowser(frames: Array<ReturnType<typeof fastFrame>>, options: { stales?: number; staleCode?: string } = {}) {
  const actions: FastBrowserAction[] = []
  let index = 0
  let stales = options.stales || 0
  let general = 0
  const host: BrowserFastHost = {
    async snapshot() { general += 1; return frames[Math.min(index, frames.length - 1)] },
    async act() { general += 1; index += 1; return frames[Math.min(index, frames.length - 1)] },
    async fastSnapshot() { return frames[Math.min(index, frames.length - 1)] },
    async fastAct(_taskId, _sessionId, action) {
      if (stales > 0) {
        stales -= 1
        const code = options.staleCode || 'changed'
        return { status: 'stale', session: frames[Math.min(index, frames.length - 1)].session, code, reason: fastRefusalSentence(code, undefined, 'div Cookie banner') }
      }
      actions.push(action)
      index += 1
      return { status: 'acted', ...frames[Math.min(index, frames.length - 1)] }
    },
  }
  return { host, actions, generalCalls: () => general }
}

test('the fast path observes the DOM and names the control by the identity the page issued', async () => {
  const browser = fastBrowser([
    fastFrame([{ id: 4, role: 'link', name: 'Actions', value: '', tag: 'a', rect: { x: 10, y: 20, width: 100, height: 30 }, fingerprint: 'control-4' }]),
    fastFrame([{ id: 9, role: 'link', name: 'General', value: '', tag: 'a', rect: { x: 10, y: 60, width: 100, height: 30 }, fingerprint: 'control-9' }], { url: 'https://github.com/x/settings/actions' }),
  ])
  const decisions = scriptedDecisions([
    verdict({ action: 'click:4', probabilities: { 'click:4': 0.98 } }),
    verdict({ completed: 0.99 }),
  ])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open the Actions settings' })

  assert.equal(result.status, 'completed')
  assert.equal(result.metrics.observation, 'dom')
  assert.equal(browser.generalCalls(), 0, 'no accessibility snapshot and no unguarded action')
  assert.equal(result.metrics.staleSteps, 0)
  // The action names an integer the page handed out, together with the identity the page
  // re-checks: nothing Shun sends could be mistaken for a selector or a coordinate.
  assert.deepEqual(browser.actions, [{ action: 'click', target: { id: 4, role: 'link', name: 'Actions', fingerprint: 'control-4' } }])
  assert.equal(result.final?.url, 'https://github.com/x/settings/actions')
})

test('a control the page has moved on from is never acted on, and the loop looks again', async () => {
  const stable = fastFrame([{ id: 4, role: 'button', name: 'Continue', value: '', fingerprint: 'control-4' }])
  const browser = fastBrowser([stable, stable, stable, stable], { stales: 2 })
  const decisions = scriptedDecisions([
    verdict({ action: 'click:4', probabilities: { 'click:4': 0.98 } }),
    verdict({ action: 'click:4', probabilities: { 'click:4': 0.98 } }),
    verdict({ action: 'click:4', probabilities: { 'click:4': 0.98 } }),
    verdict({ completed: 0.99 }),
  ])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Continue' })

  assert.equal(result.status, 'completed')
  assert.equal(browser.actions.length, 1, 'only the action the page accepted was performed')
  assert.equal(result.metrics.staleSteps, 2)
  assert.equal(result.metrics.blockedSteps, 0)
  // A stale answer spends an action step and a decision, which is what bounds a page that
  // never stops moving under the loop.
  assert.equal(decisions.requests.length, 4)
})

test('a control that cannot be clicked as observed is counted the way the general path counts it', async () => {
  const stable = fastFrame([{ id: 4, role: 'button', name: 'Inspect', value: '', fingerprint: 'control-4' }])
  const browser = fastBrowser([stable, stable], { stales: 1, staleCode: 'covered' })
  const decisions = scriptedDecisions([
    verdict({ action: 'click:4', probabilities: { 'click:4': 0.98 } }),
    verdict({ completed: 0.99 }),
  ])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open the details of this record' })

  assert.equal(result.status, 'completed')
  // A covered control is a fact about the page, not an expired observation, and it is reported
  // the same way on both paths — in Shun's own words.
  assert.equal(result.metrics.blockedSteps, 1)
  assert.equal(result.metrics.staleSteps, 0)
  assert.match(String(result.reason), /behind div Cookie banner/)
})

test('a page that keeps moving under the decision hands the work back', async () => {
  const browser = fastBrowser([fastFrame([{ id: 4, role: 'button', name: 'Continue', value: '', fingerprint: 'control-4' }])], { stales: 99 })
  const decisions = scriptedDecisions([verdict({ action: 'click:4', probabilities: { 'click:4': 0.98 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Continue' })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /kept changing under the decision/i)
  assert.match(String(result.reason), /no longer the one this decision was made about/i)
  assert.equal(browser.actions.length, 0)
  assert.equal(result.metrics.staleSteps, 3)
})

test('a browser without the fast path runs the accessibility path, unchanged', async () => {
  let fastCalls = 0
  const frames = [frame([{ ref: '18', role: 'link', name: 'Settings' }]), frame([{ ref: '18', role: 'link', name: 'Settings' }], { url: 'https://example.com/next' })]
  const base = fakeBrowser(frames)
  const host: BrowserFastHost = {
    ...base.host,
    async fastSnapshot() { fastCalls += 1; throw new BrowserFastUnsupportedError('Unknown Shun Browser Use method: tab.fastSnapshot') },
    async fastAct() { fastCalls += 1; throw new BrowserFastUnsupportedError('Unknown Shun Browser Use method: tab.fastAct') },
  }
  const decisions = scriptedDecisions([verdict({ action: 'click:18', probabilities: { 'click:18': 0.98 } }), verdict({ completed: 0.99 })])

  const result = await new BrowserFastExecutor(host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open Settings' })

  assert.equal(result.status, 'completed')
  assert.equal(result.metrics.observation, 'accessibility')
  assert.equal(fastCalls, 1, 'the fast path is tried once and then left alone for the rest of the run')
  assert.equal(base.actions.length, 1, 'the action still happened, through the general path')
})

test('a page whose controls live in frames hands the work back rather than guessing a coordinate', async () => {
  const browser = fastBrowser([fastFrame([], { frames: { total: 2, crossOrigin: 2 } })])
  const decisions = scriptedDecisions([verdict({ action: 'escalate', probabilities: { escalate: 0.9 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Sign in' })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /frame/i)
  assert.equal(decisions.requests.length, 0, 'the decision is not even asked about a page it cannot see')
})

test('a field with no supplied value is asked for, never filled in', async () => {
  const browser = fastBrowser([fastFrame([{ id: 5, role: 'textbox', name: 'Repository', value: '', fingerprint: 'control-5' }])])
  const decisions = scriptedDecisions([verdict({ action: 'input:5', probabilities: { 'input:5': 0.9 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Search for the repository' })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /Repository/)
  assert.match(String(result.reason), /input/)
  assert.equal(browser.actions.length, 0, 'the fast path never writes text of its own')
})

test('a decision whose distribution contradicts its own choice is not acted on', async () => {
  const browser = fastBrowser([fastFrame([{ id: 18, role: 'link', name: 'Settings', value: '', fingerprint: 'control-18' }, { id: 19, role: 'link', name: 'Profile', value: '', fingerprint: 'control-19' }])])
  // The selection says one thing and the distribution says another, and a set of
  // probabilities that exceeds one is not a distribution at all.
  const contradictions = [
    verdict({ action: 'click:18', probabilities: { 'click:18': 0.4, 'click:19': 0.9 } }),
    verdict({ action: 'click:18', probabilities: { 'click:19': 0.9 } }),
    verdict({ action: 'click:18', probabilities: { 'click:18': 0.7, 'click:19': 0.6 } }),
  ]
  for (const response of contradictions) {
    const decisions = scriptedDecisions([response])
    const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open Settings' })
    assert.equal(result.status, 'escalate')
    assert.match(String(result.reason), /did not return a judgment/i)
    assert.equal(browser.actions.length, 0)
  }
})

test('a control below the fold is offered, and offered after the ones already on screen', () => {
  const nodes = [
    { ref: '7', role: 'link', name: 'Assets', offscreen: true },
    { ref: '8', role: 'link', name: 'Releases' },
  ]
  const offered = buildActionCandidates({ readyState: 'complete', nodes } as unknown as ChromeSnapshot, 'Continue')
  assert.deepEqual(offered.slice(0, 2).map(candidate => candidate.id), ['click:8', 'click:7'], 'what the page is showing comes first')
  // A control below the fold is reached by choosing it, so the description says that instead
  // of leaving a decision to pick between using it and scrolling to it.
  assert.match(offered[1].description, /\(below fold\)/)

  // A goal that names it is still allowed to choose it: the guard brings it into view before
  // the click, which is exactly what a person would do.
  const named = buildActionCandidates({ readyState: 'complete', nodes } as unknown as ChromeSnapshot, 'Read the Assets list')
  assert.equal(named[0].id, 'click:7')
})

test('a control that stays covered after repeated attempts says so, not that the page changed', async () => {
  const stable = fastFrame([{ id: 4, role: 'button', name: 'Inspect', value: '', fingerprint: 'control-4' }])
  const browser = fastBrowser([stable, stable, stable, stable], { stales: 99, staleCode: 'covered' })
  const decisions = scriptedDecisions([verdict({ action: 'click:4', probabilities: { 'click:4': 0.98 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Open the details of this record' })

  assert.equal(result.status, 'escalate')
  // What actually happened is a control that could not be used, and the reason has to say that
  // rather than report a page that changed.
  assert.match(String(result.reason), /could not be used after repeated attempts/i)
  assert.doesNotMatch(String(result.reason), /kept changing under the decision/i)
  assert.equal(browser.actions.length, 0)
  assert.equal(result.metrics.blockedSteps, 3)
})

test('a tab Chrome is not rendering is reported once instead of spending decisions on it', async () => {
  const stable = fastFrame([{ id: 4, role: 'button', name: 'Continue', value: '', fingerprint: 'control-4' }])
  const browser = fastBrowser([stable, stable, stable, stable], { stales: 99, staleCode: 'not-visible' })
  const decisions = scriptedDecisions([verdict({ action: 'click:4', probabilities: { 'click:4': 0.98 } })])

  const result = await new BrowserFastExecutor(browser.host, decisions.client, config).execute({ taskId: 'task-1', goal: 'Continue' })

  assert.equal(result.status, 'escalate')
  assert.match(String(result.reason), /not showing that tab/i)
  assert.match(String(result.reason), /Show that tab in Chrome/i)
  assert.equal(browser.actions.length, 0)
  assert.equal(result.metrics.blockedSteps, 1)
  assert.equal(result.metrics.staleSteps, 0)
  // Looking again cannot change a fact about the tab, so it is asked exactly once.
  assert.equal(decisions.requests.length, 1)
})

test('a link-dense page offers the control that turns it, without a shortlist', () => {
  // Hacker News is 160 links and the way forward is one of them, with none of the goal's words
  // in its name. Ranking decides the order and never whether an option exists: the documented
  // ceiling for a Choice question is 255 options, and a shortlist is what cut the control the
  // subgoal needed.
  const nodes = [
    ...Array.from({ length: 180 }, (_value, index) => ({ ref: String(index + 1), role: 'link', name: `Story ${index + 1} about browser engines` })),
    { ref: '900', role: 'link', name: 'More' },
  ]
  const offered = buildActionCandidates({ readyState: 'complete', nodes } as unknown as ChromeSnapshot, 'Open the next page of stories')
  assert.ok(offered.some(candidate => candidate.name === 'More'), 'the control that turns the page is offered')
  assert.ok(offered.some(candidate => candidate.id === 'click:120'), 'and so is a control ranked well below the old cap of 60')
  assert.ok(offered.length <= 240 + 8, 'the offered set stays inside the documented ceiling')
})

test('an offered control is described by where it sits and where it goes', () => {
  // The criteria of a choice question are there to separate the options from each other. Two
  // links called alike, or a button beside a link, are only distinguishable when the offer says
  // what each one is, where it lives, and where it leads.
  const nodes = [
    { ref: '11', role: 'link', name: 'More', target: '/news/', region: 'nav "pagination"' },
    { ref: '12', role: 'link', name: 'More floating point alternatives', target: '/comics/more-floating-point/' },
    { ref: '13', role: 'button', name: 'Search', region: 'form "Search Wikipedia"' },
    { ref: '14', role: 'searchbox', name: 'Search Wikipedia', value: 'Hypertext Transfer Protocol' },
  ]
  // A value has to be supplied for the typing option to exist at all.
  const offered = buildActionCandidates({ readyState: 'complete', nodes } as unknown as ChromeSnapshot, 'Open the next page of stories', { input: { term: 'Hypertext Transfer Protocol' } })

  const more = offered.find(candidate => candidate.id === 'click:11')
  assert.match(String(more?.description), /nav "pagination"/)
  assert.match(String(more?.description), /→ \/news\//)
  assert.match(String(offered.find(candidate => candidate.id === 'click:12')?.description || ''), /→ \/comics\/more-floating-point\//)
  assert.match(String(offered.find(candidate => candidate.id === 'click:13')?.description || ''), /form "Search Wikipedia"/)
  // A field says what it already holds, so the option to type into it is not blind.
  assert.match(String(offered.find(candidate => candidate.id.startsWith('type:14:'))?.description || ''), /currently holds "Hypertext Transfer Protocol"/)
  // And a page that offers its own submit control does not also offer a generic Enter that means
  // the same thing: one action offered twice is one action a decision splits between.
  assert.ok(!offered.some(candidate => candidate.id === 'keypress:Enter'), 'the explicit submit control replaces the generic Enter')
})

test('a list entry, a submit control, and a body link are told apart', () => {
  // Four controls sharing a name can mean four different things: a suggestion the field opened,
  // the same word as a link in the page's own text, the button that submits the form, and a link
  // that searches rather than opens. Each has to say which one it is.
  const nodes = [
    { ref: '555', role: 'combobox', name: 'Search Wikipedia', value: 'Hypertext Transfer Protocol', focused: true },
    { ref: '556', role: 'option', name: 'HTTP', region: 'listbox' },
    { ref: '564', role: 'button', name: 'Search', region: 'form "Search Wikipedia"' },
    { ref: '95', role: 'link', name: 'HTTP', target: '/wiki/HTTP' },
  ]
  const offered = buildActionCandidates({ readyState: 'complete', nodes } as unknown as ChromeSnapshot, 'Look up the term and open that article')
  const byId = new Map(offered.map(candidate => [candidate.id, candidate.description]))

  assert.match(String(byId.get('click:556')), /list entry "HTTP" in the open list/)
  assert.match(String(byId.get('click:564')), /submits the form it belongs to/)
  assert.match(String(byId.get('click:564')), /form "Search Wikipedia"/)
  assert.match(String(byId.get('click:95')), /→ \/wiki\/HTTP/)
  assert.doesNotMatch(String(byId.get('click:95') || ''), /submits the form/)
})

test('a clear winner among related options is acted on, and a split one is not', async () => {
  // Five related options put 0.4 on the winner and 0.16 on the next: the top probability is low
  // and the choice is still clear, which is what the answer's own certainty says. Gating on the
  // raw probability refused exactly this on a real page, where the winner was the suggestion the
  // search box had just opened.
  const spread = { 'click:4': 0.4, 'click:5': 0.16, 'click:6': 0.16, 'click:7': 0.13 }
  // These are page-side elements, whose identity field is `id`.
  const nodes = [
    { id: 4, role: 'option', name: 'HTTP', region: 'listbox' },
    { id: 5, role: 'link', name: 'HTTP', target: '/wiki/HTTP' },
    { id: 6, role: 'button', name: 'Search' },
    { id: 7, role: 'link', name: 'Search for pages containing it' },
  ]

  const confident = fastBrowser([fastFrame(nodes), fastFrame(nodes)])
  const acting = scriptedDecisions([
    verdict({ action: 'click:4', probabilities: spread, confidence: 0.6 }),
    verdict({ completed: 0.99 }),
  ])
  const acted = await new BrowserFastExecutor(confident.host, acting.client, config).execute({ taskId: 'task-1', goal: 'Look up the term' })
  assert.equal(acted.status, 'completed')
  assert.equal(confident.actions.length, 1, 'a clear winner among related options is used')

  const unsure = fastBrowser([fastFrame(nodes), fastFrame(nodes)])
  const refusing = scriptedDecisions([verdict({ action: 'click:4', probabilities: spread, confidence: 0.3 })])
  const refused = await new BrowserFastExecutor(unsure.host, refusing.client, config).execute({ taskId: 'task-1', goal: 'Look up the term' })
  assert.equal(refused.status, 'escalate')
  assert.match(String(refused.reason), /certain enough/i)
  assert.equal(unsure.actions.length, 0, 'and a genuinely split one is left to the main model')
})

test('a reversible action with a clear lead is taken, while a tie is not', async () => {
  // 0.45 against a 0.11 runner-up is a four-times lead, and going back undoes it: risk decides
  // the floor, so this runs. The general floor is unchanged for an action that commits.
  // Page-side elements: their identity field is `id`.
  const nodes = [{ id: 4, role: 'link', name: 'Hacker News', target: '/' }, { id: 5, role: 'link', name: 'past', target: '/past' }]
  const spread = { 'click:4': 0.45, 'click:5': 0.11, back: 0.1 }

  const browser = fastBrowser([fastFrame(nodes), fastFrame(nodes)])
  const decisions = scriptedDecisions([
    verdict({ action: 'click:4', probabilities: spread, confidence: 0.43 }),
    verdict({ completed: 0.99 }),
  ])
  const taken = await new BrowserFastExecutor(browser.host, decisions.client, { ...config, minActionConfidence: 0.5, minReversibleConfidence: 0.4 }).execute({ taskId: 'task-1', goal: 'Go back to the story list' })
  assert.equal(taken.status, 'completed')
  assert.equal(browser.actions.length, 1)

  // A genuine tie is still refused: the margin rule did not move.
  const tie = fastBrowser([fastFrame(nodes), fastFrame(nodes)])
  const tied = scriptedDecisions([verdict({ action: 'click:4', probabilities: { 'click:4': 0.45, 'click:5': 0.4 }, confidence: 0.43 })])
  const refused = await new BrowserFastExecutor(tie.host, tied.client, { ...config, minReversibleConfidence: 0.4 }).execute({ taskId: 'task-1', goal: 'Go back to the story list' })
  assert.equal(refused.status, 'escalate')
  assert.equal(tie.actions.length, 0)
})
