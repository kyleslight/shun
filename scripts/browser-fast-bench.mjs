/**
 * Fast Browser Use benchmark.
 *
 * It answers the only question the acceleration experiment has to answer: can a
 * narrow decision model safely absorb the routine browser steps that would
 * otherwise each cost the main model a full reasoning round, and at what error
 * rate?
 *
 * Each task is a deterministic page sequence with the correct next action
 * recorded beside every page, so a wrong autonomous action is a fact rather than
 * a judgement. The executor under test is the shipping one, driven by the real
 * decision model — nothing is stubbed except Chrome itself.
 *
 *   OPENROUTER_API_KEY=... node --experimental-strip-types scripts/browser-fast-bench.mjs
 *     [--concurrency 3] [--model typesafe/jev-1.13] [--sweep] [--detail]
 *
 * --sweep runs the same tasks under a ladder of confidence gates, because the
 * only useful output is the risk-at-coverage curve: what a gate buys in absorbed
 * steps and what it costs in wrong autonomous actions. The gates are the product
 * decision; the benchmark only measures them.
 *
 * Main-model rounds are derived from what actually ran rather than from a
 * counterfactual model: on the standard path every performed action is one
 * reasoning round, so the fast path saves exactly the rounds for the actions it
 * took and still pays one round for every escalation it caused. Delegation and
 * return rounds are reported separately because they are constant per subgoal.
 */
import { BrowserFastExecutor, buildActionCandidates } from '../src/main/browser-fast.ts'
import { OpenRouterJevClient, resolveComputerUseAcceleration } from '../src/main/jev-client.ts'

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const concurrency = Math.max(1, Math.min(8, Number(option('concurrency', 3)) || 3))
const model = option('model', 'typesafe/jev-1.13')
const sweep = process.argv.includes('--sweep')
const detail = process.argv.includes('--detail')

/**
 * The gate ladder. The first row is what the product ships; the rest show what
 * loosening each gate would buy, which is how a threshold gets chosen from
 * evidence instead of taste.
 */
const GATES = [
  { label: 'shipped defaults', minActionConfidence: 0.5, minActionMargin: 0.2, minCompletionConfidence: 0.9, minAmbiguityConfidence: 0.5 },
  { label: 'ambiguity gate at 0.6', minActionConfidence: 0.5, minActionMargin: 0.2, minCompletionConfidence: 0.9, minAmbiguityConfidence: 0.6 },
  { label: 'no ambiguity gate', minActionConfidence: 0.5, minActionMargin: 0.2, minCompletionConfidence: 0.85, minAmbiguityConfidence: 0 },
  { label: 'plan proposal (0.92/0.95/0.90)', minActionConfidence: 0.92, minActionMargin: 0, minCompletionConfidence: 0.95, minAmbiguityConfidence: 0.9 },
  { label: 'mutation gate only', minActionConfidence: 0.34, minActionMargin: 0, minCompletionConfidence: 0.8, minAmbiguityConfidence: 0 },
]

/** Per-decision evidence, so a threshold can be judged against what it actually saw. */
function detailLine(task, judged) {
  const offered = buildActionCandidates(task.steps[0] ? task.steps[0].page : {}, task.goal, { input: task.input }).map(candidate => candidate.id)
  console.log(`      ${judged.success ? 'PASS' : 'FAIL'} ${judged.id.padEnd(32)} ${judged.status.padEnd(9)} acted=${judged.actedActions}/${judged.expectedActions}`)
  console.log(`           expected: ${task.steps.map(step => step.expect.join('|') || '(complete)').join(' → ')}   offered: ${offered.slice(0, 12).join(', ')}${offered.length > 12 ? ` …(${offered.length})` : ''}`)
  for (const trace of judged.traces.slice(0, 5)) {
    console.log(`           step ${trace.step}: chose=${trace.selectedCandidate || '-'} p=${trace.selectedProbability?.toFixed(2) || '-'} margin=${trace.selectedMargin?.toFixed(2) || '-'} done=${trace.completionProbability?.toFixed(2) || '-'} unamb=${trace.ambiguityProbability?.toFixed(2) || '-'} mut=${trace.mutationProbability?.toFixed(2) || '-'} → ${trace.outcome}${trace.outcome === 'escalated' ? `  ${judged.reason}` : ''}`)
  }
}

const node = (ref, role, name, extra = {}) => ({ ref, role, name, ...extra })
const page = (url, title, text, nodes) => ({ url, title, text, nodes })

/** Every task ends on the page where the delegated goal is satisfied. */
const TASKS = [
  {
    id: 'github/repository-settings',
    goal: 'Open the repository Settings page.',
    steps: [{
      page: page('https://github.com/kyleslight/shun', 'kyleslight/shun', 'kyleslight/shun Public. Code Issues Pull requests Actions Projects Security Insights Settings. Find a repository…', [
        node('7', 'heading', 'kyleslight/shun'),
        node('11', 'link', 'Code'),
        node('18', 'link', 'Issues'),
        node('22', 'link', 'Pull requests'),
        node('24', 'link', 'Settings'),
        node('31', 'textbox', 'Find a repository…'),
      ]),
      expect: ['click:24'],
    }],
    final: page('https://github.com/kyleslight/shun/settings', 'Settings · kyleslight/shun', 'Repository settings. General Access Actions Webhooks Secrets and variables Pages. Danger Zone Delete this repository.', [
      node('7', 'heading', 'Settings'),
      node('30', 'link', 'Actions'),
      node('33', 'link', 'Pages'),
      node('36', 'button', 'Delete this repository'),
    ]),
  },
  {
    id: 'github/actions-settings',
    goal: 'From the repository settings, open Actions > General.',
    steps: [
      {
        page: page('https://github.com/kyleslight/shun/settings', 'Settings · kyleslight/shun', 'Repository settings. General Access Actions Webhooks Secrets and variables Pages.', [
          node('7', 'heading', 'Settings'),
          node('30', 'link', 'Actions'),
          node('33', 'link', 'Pages'),
        ]),
        expect: ['click:30'],
      },
      {
        page: page('https://github.com/kyleslight/shun/settings/actions', 'Actions · Settings', 'Actions permissions. General Runners Caches. Allow all actions and reusable workflows.', [
          node('7', 'heading', 'Actions'),
          node('41', 'tab', 'General'),
          node('43', 'tab', 'Runners'),
        ]),
        expect: ['click:41'],
      },
    ],
    final: page('https://github.com/kyleslight/shun/settings/actions', 'General · Actions · Settings', 'Actions permissions. Allow all actions and reusable workflows. Save Cancel.', [
      node('7', 'heading', 'General'),
      node('45', 'radio', 'Allow all actions and reusable workflows'),
    ]),
  },
  {
    id: 'github/search-repository',
    goal: 'Search the repository list for "kyleslight/shun" and open that repository.',
    input: { query: 'kyleslight/shun' },
    steps: [
      {
        page: page('https://github.com/kyleslight', 'kyleslight · GitHub', 'Repositories. Find a repository… Search. 12 repositories.', [
          node('7', 'heading', 'Repositories'),
          node('31', 'textbox', 'Find a repository…'),
          node('33', 'button', 'Search'),
          node('35', 'link', 'notes Scratch notes.'),
          node('37', 'link', 'godot-presets Godot export presets.'),
        ]),
        expect: ['type:31:query'],
      },
      {
        page: page('https://github.com/kyleslight', 'kyleslight · GitHub', '1 repository matches kyleslight/shun. shun The desktop agent.', [
          node('31', 'searchbox', 'Find a repository…', { value: 'kyleslight/shun' }),
          node('51', 'link', 'shun The desktop agent.'),
        ]),
        expect: ['click:51', 'keypress:Enter'],
      },
    ],
    final: page('https://github.com/kyleslight/shun', 'kyleslight/shun: The desktop agent', 'kyleslight/shun Public. Code Issues Pull requests.', [
      node('7', 'heading', 'kyleslight/shun'),
      node('11', 'link', 'Code'),
    ]),
  },
  {
    id: 'github/open-issue',
    goal: 'Open the issue titled "Flaky browser test".',
    steps: [
      {
        page: page('https://github.com/kyleslight/shun', 'kyleslight/shun', 'Code Issues Pull requests Actions', [
          node('11', 'link', 'Code'),
          node('18', 'link', 'Issues'),
        ]),
        expect: ['click:18'],
      },
      {
        page: page('https://github.com/kyleslight/shun/issues', 'Issues · kyleslight/shun', 'Open. Flaky browser test. Add Godot export preset.', [
          node('61', 'link', 'Flaky browser test'),
          node('63', 'link', 'Add Godot export preset'),
        ]),
        expect: ['click:61'],
      },
    ],
    final: page('https://github.com/kyleslight/shun/issues/412', 'Flaky browser test · Issue #412', 'Flaky browser test. Open. kyleslight opened this issue. Comments.', [
      node('7', 'heading', 'Flaky browser test #412'),
    ]),
  },
  {
    id: 'github/switch-tab',
    goal: 'Switch the repository view from Code to Issues.',
    steps: [{
      page: page('https://github.com/kyleslight/shun', 'kyleslight/shun', 'Code Issues Pull requests Actions', [
        node('12', 'tab', 'Code'),
        node('14', 'tab', 'Issues'),
        node('16', 'tab', 'Pull requests'),
      ]),
      expect: ['click:14'],
    }],
    final: page('https://github.com/kyleslight/shun/issues', 'Issues · kyleslight/shun', 'Issues. 12 Open 340 Closed.', [node('7', 'heading', 'Issues')]),
  },
  {
    id: 'google/search',
    goal: 'Search Google for "shun desktop agent".',
    input: { query: 'shun desktop agent' },
    steps: [
      {
        page: page('https://www.google.com/', 'Google', 'Search', [
          node('5', 'combobox', 'Search'),
          node('7', 'button', 'Google Search'),
        ]),
        expect: ['type:5:query'],
      },
      {
        page: page('https://www.google.com/', 'Google', 'shun desktop agent', [
          node('5', 'combobox', 'Search'),
          node('9', 'button', 'Google Search'),
        ]),
        expect: ['keypress:Enter', 'click:9'],
      },
    ],
    final: page('https://www.google.com/search?q=shun+desktop+agent', 'shun desktop agent - Google Search', 'About 1,240,000 results. Shun — the desktop agent. Shun documentation.', [
      node('20', 'link', 'Shun — the desktop agent'),
      node('30', 'link', 'Shun documentation'),
    ]),
  },
  {
    id: 'google/open-obvious-result',
    goal: 'Open the result titled "Shun documentation".',
    steps: [{
      page: page('https://www.google.com/search?q=shun', 'shun - Google Search', 'About 1,240,000 results. Shun — the desktop agent. Shun documentation. Shun release notes.', [
        node('20', 'link', 'Shun — the desktop agent'),
        node('30', 'link', 'Shun documentation'),
        node('34', 'link', 'Shun release notes'),
      ]),
      expect: ['click:30'],
    }],
    final: page('https://docs.shun.dev/', 'Shun documentation', 'Getting started. Configuration. Browser Use.', [
      node('7', 'heading', 'Shun documentation'),
      node('9', 'link', 'Getting started'),
    ]),
  },
  {
    id: 'docs/navigate-sidebar',
    goal: 'Open the Configuration page from the documentation sidebar.',
    steps: [{
      page: page('https://docs.shun.dev/introduction', 'Shun documentation', 'Getting started. Configuration. Browser Use. Plugins.', [
        node('7', 'heading', 'Shun documentation'),
        node('9', 'link', 'Getting started'),
        node('11', 'link', 'Configuration'),
        node('13', 'link', 'Browser Use'),
      ]),
      expect: ['click:11'],
    }],
    final: page('https://docs.shun.dev/configuration', 'Configuration', 'Configuration. Providers. Models. Plugins.', [node('7', 'heading', 'Configuration')]),
  },
  {
    id: 'docs/search',
    goal: 'Search the documentation for "authentication".',
    input: { query: 'authentication' },
    steps: [
      {
        page: page('https://docs.shun.dev/', 'Shun documentation', 'Search docs', [node('3', 'searchbox', 'Search docs')]),
        expect: ['type:3:query'],
      },
      {
        page: page('https://docs.shun.dev/', 'Shun documentation', 'authentication', [
          node('3', 'searchbox', 'Search docs', { value: 'authentication' }),
          node('6', 'listbox', 'Search results'),
        ]),
        expect: ['keypress:Enter'],
      },
    ],
    final: page('https://docs.shun.dev/search?q=authentication', 'Search results for authentication', 'Authentication. 8 results. Provider credentials.', [
      node('7', 'heading', 'Search results for authentication'),
    ]),
  },
  {
    id: 'docs/expand-section',
    goal: 'Expand the "Guides" section of the documentation sidebar.',
    steps: [{
      page: page('https://docs.shun.dev/', 'Shun documentation', 'Reference. Guides. Introduction.', [
        node('7', 'heading', 'Shun documentation'),
        node('18', 'treeitem', 'Reference'),
        node('20', 'treeitem', 'Guides'),
      ]),
      expect: ['click:20'],
    }],
    final: page('https://docs.shun.dev/', 'Shun documentation', 'Guides. Browser Use. Plugins.', [
      node('20', 'treeitem', 'Guides', { expanded: true }),
      node('24', 'link', 'Browser Use'),
    ]),
  },
  {
    id: 'forms/fill-search',
    goal: 'Fill the invoice search box with the supplied query.',
    input: { query: 'invoice 2024' },
    steps: [{
      page: page('https://app.example.com/invoices', 'Invoices', 'Search invoices', [
        node('15', 'textbox', 'Search invoices'),
        node('17', 'button', 'Filter'),
      ]),
      expect: ['type:15:query'],
    }],
    final: page('https://app.example.com/invoices', 'Invoices', 'invoice 2024. No results yet.', [
      node('15', 'textbox', 'Search invoices', { value: 'invoice 2024' }),
    ]),
  },
  {
    id: 'forms/choose-dropdown',
    goal: 'Choose "Japan" in the Country dropdown.',
    steps: [
      {
        page: page('https://app.example.com/checkout', 'Checkout', 'Country Select a country', [
          node('8', 'combobox', 'Country'),
          node('10', 'button', 'Continue'),
        ]),
        expect: ['click:8'],
      },
      {
        page: page('https://app.example.com/checkout', 'Checkout', 'Country. Germany, Japan, Kenya', [
          node('8', 'combobox', 'Country', { expanded: true }),
          node('40', 'option', 'Germany'),
          node('44', 'option', 'Japan'),
          node('48', 'option', 'Kenya'),
        ]),
        expect: ['click:44'],
      },
    ],
    final: page('https://app.example.com/checkout', 'Checkout', 'Country: Japan. Continue', [
      node('8', 'combobox', 'Country', { value: 'Japan' }),
    ]),
  },
  {
    id: 'forms/multistep-non-submitting',
    goal: 'Move through the shipping form to the address step without submitting anything.',
    steps: [
      {
        page: page('https://app.example.com/shipping', 'Shipping', 'Step 1 of 3. Full name. Continue. Submit', [
          node('50', 'textbox', 'Full name'),
          node('52', 'button', 'Continue'),
          node('54', 'button', 'Submit'),
        ]),
        expect: ['click:52'],
      },
      {
        page: page('https://app.example.com/shipping/plan', 'Shipping · Plan', 'Step 2 of 3. Delivery plan. Monthly. Annual. Next Back. Submit', [
          node('60', 'radio', 'Monthly'),
          node('62', 'radio', 'Annual'),
          node('64', 'button', 'Next'),
          node('66', 'button', 'Submit'),
        ]),
        expect: ['click:64'],
      },
      {
        page: page('https://app.example.com/shipping/address', 'Shipping · Address', 'Step 3 of 3. Street. City. Back. Submit', [
          node('70', 'textbox', 'Street'),
          node('72', 'textbox', 'City'),
          node('74', 'button', 'Back'),
          node('76', 'button', 'Submit'),
        ]),
        expect: [],
      },
    ],
    final: page('https://app.example.com/shipping/address', 'Shipping · Address', 'Step 3 of 3. Address. Street. City. Submit', [
      node('70', 'textbox', 'Street'),
      node('72', 'textbox', 'City'),
      node('76', 'button', 'Submit'),
    ]),
  },
]

function frameOf(entry) {
  const nodes = entry.nodes || []
  return {
    session: {
      id: 'bench-session', taskId: 'bench', createdByRunId: 'bench', tabId: 1, owned: false, state: 'attached',
      url: entry.url, title: entry.title, createdAt: 1, updatedAt: 1, consoleEntries: 0, pageErrors: 0,
    },
    snapshot: { tab: { id: 1, url: entry.url, title: entry.title }, readyState: 'complete', text: entry.text, nodes },
    text: JSON.stringify({ title: entry.title, url: entry.url, accessibility_nodes: nodes.length }),
  }
}

function hostFor(task) {
  const sequence = [...task.steps.map(step => step.page), task.final]
  let index = 0
  return {
    async snapshot() { return frameOf(sequence[Math.min(index, sequence.length - 1)]) },
    async act(_taskId, _sessionId) { index += 1; return frameOf(sequence[Math.min(index, sequence.length - 1)]) },
  }
}

async function runTask(task, client, config) {
  const started = Date.now()
  const executor = new BrowserFastExecutor(hostFor(task), client, config, { runId: `bench:${task.id}` })
  const result = await executor.execute({ taskId: 'bench', goal: task.goal, input: task.input })
  return { result, elapsedMs: Date.now() - started, traces: executor.traces }
}

function judge(task, run) {
  const expected = task.steps.map(step => step.expect)
  const acted = run.result.steps.map(step => step.action)
  const steps = task.steps.map((step, index) => ({
    expected: step.expect,
    acted: acted[index],
    probability: run.result.steps[index]?.probability,
    correct: Boolean(acted[index]) && step.expect.includes(acted[index]),
  }))
  const attempted = steps.filter(step => step.acted)
  return {
    id: task.id,
    status: run.result.status,
    reason: run.result.reason,
    steps,
    traces: run.traces,
    expectedActions: expected.filter(list => list.length).length,
    actedActions: attempted.length,
    correctActions: attempted.filter(step => step.correct).length,
    wrongActions: attempted.filter(step => !step.correct).length,
    // A task is a success only when every performed step was the right one, in
    // order, and the fast path recognised completion by itself.
    success: run.result.status === 'completed' && attempted.length > 0 && attempted.every(step => step.correct),
    jevCalls: run.result.metrics.jevCalls,
    browserActions: run.result.metrics.browserActions,
    inputTokens: run.result.metrics.inputTokens,
    decisionMs: run.result.metrics.averageDecisionMs,
    elapsedMs: run.elapsedMs,
  }
}

function summarize(results, gate) {
  const expectedActions = results.reduce((total, item) => total + item.expectedActions, 0)
  const actedActions = results.reduce((total, item) => total + item.actedActions, 0)
  const correctActions = results.reduce((total, item) => total + item.correctActions, 0)
  const wrongActions = results.reduce((total, item) => total + item.wrongActions, 0)
  const escalations = results.filter(item => item.status === 'escalate').length
  const flatSteps = results.flatMap(item => item.steps).filter(step => step.acted)
  return {
    gate: gate.label,
    tasks: results.length,
    success: results.filter(item => item.success).length,
    escalations,
    expectedActions,
    actedActions,
    correctActions,
    wrongActions,
    coverage: expectedActions ? actedActions / expectedActions : 0,
    accuracy: actedActions ? correctActions / actedActions : 1,
    // Rounds saved are exactly the actions the fast path performed; every
    // escalation still costs the main model one round to take over.
    modeARounds: expectedActions,
    modeBRounds: expectedActions - actedActions + escalations,
    jevCalls: results.reduce((total, item) => total + item.jevCalls, 0),
    inputTokens: results.reduce((total, item) => total + item.inputTokens, 0),
    decisionMs: results.reduce((total, item) => total + item.decisionMs * item.jevCalls, 0) / Math.max(1, results.reduce((total, item) => total + item.jevCalls, 0)),
    flatSteps,
  }
}

function rate(numerator, denominator) {
  return denominator ? `${((numerator / denominator) * 100).toFixed(1)}%` : 'n/a'
}

const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim()
if (!apiKey) {
  console.error('Fast Browser Use benchmark needs a decision-model credential: set OPENROUTER_API_KEY.')
  process.exit(2)
}

const resolved = resolveComputerUseAcceleration({
  providers: [{
    id: 'openrouter', name: 'OpenRouter', kind: 'cloud', catalogId: 'openrouter', api: 'openai-completions',
    endpoint: 'https://openrouter.ai/api/v1', apiKey, contextWindow: 32_768,
  }],
  ...(model === 'typesafe/jev-1.13' ? {} : { computerUseAcceleration: { model } }),
})
if (!resolved) throw Error('The decision model did not resolve from the configured provider.')
const client = new OpenRouterJevClient({ apiKey, endpoint: resolved.endpoint, timeoutMs: 20_000 })

/** Runs every task once under one gate set, with a small worker pool. */
async function runAll(gates, onTask) {
  const results = []
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, TASKS.length) }, async () => {
    while (cursor < TASKS.length) {
      const task = TASKS[cursor]
      cursor += 1
      const run = await runTask(task, client, { ...resolved, ...gates })
      const judged = judge(task, run)
      results.push(judged)
      onTask?.(task, judged)
    }
  }))
  return results.sort((left, right) => left.id.localeCompare(right.id))
}

console.log(`decision model: ${resolved.model} via ${resolved.endpoint}`)
console.log(`tasks: ${TASKS.length}   concurrency ${concurrency}${sweep ? '   sweep over the gate ladder' : ''}\n`)

if (sweep) {
  const rows = []
  for (const gates of GATES) {
    const results = await runAll(gates)
    const summary = summarize(results, gates)
    rows.push(summary)
    console.log(`--- ${gates.label}  (action ${gates.minActionConfidence} / completion ${gates.minCompletionConfidence} / ambiguity ${gates.minAmbiguityConfidence})`)
    console.log(`    success ${rate(summary.success, summary.tasks)}  coverage ${rate(summary.actedActions, summary.expectedActions)}  accuracy ${rate(summary.correctActions, summary.actedActions)}  wrong ${summary.wrongActions}  escalations ${summary.escalations}/${summary.tasks}  mean decision ${Math.round(summary.decisionMs)}ms`)
    if (detail) for (const item of results) detailLine(TASKS.find(candidate => candidate.id === item.id), item)
  }
  console.log('\n=== risk at coverage ===')
  console.log('gate                             success  coverage  accuracy  wrong  escalations  rounds A->B  reduction')
  for (const row of rows) console.log(`${row.gate.padEnd(32)} ${rate(row.success, row.tasks).padStart(6)}  ${rate(row.actedActions, row.expectedActions).padStart(8)}  ${rate(row.correctActions, row.actedActions).padStart(8)}  ${String(row.wrongActions).padStart(5)}  ${rate(row.escalations, row.tasks).padStart(11)}  ${String(row.modeARounds).padStart(3)} -> ${String(row.modeBRounds).padStart(3)}  ${rate(row.modeARounds - row.modeBRounds, row.modeARounds).padStart(9)}`)
  for (const row of rows) {
    const bands = [
      { label: '>= 0.99', test: probability => probability >= 0.99 },
      { label: '0.95-0.99', test: probability => probability >= 0.95 && probability < 0.99 },
      { label: '0.92-0.95', test: probability => probability >= 0.92 && probability < 0.95 },
      { label: '< 0.92', test: probability => probability < 0.92 },
    ]
    const acted = row.flatSteps.filter(step => typeof step.probability === 'number')
    console.log(`\n${row.gate}: risk at coverage by selected-action probability`)
    for (const band of bands) {
      const inBand = acted.filter(step => band.test(step.probability))
      if (inBand.length) console.log(`  ${band.label.padEnd(11)} ${String(inBand.length).padStart(3)} steps   error ${rate(inBand.filter(step => !step.correct).length, inBand.length)}`)
    }
  }
  console.log('\ncoverage is the share of required steps the fast path performed itself; accuracy is the share of\nperformed steps that were the recorded correct action. Rounds are main-model browser reasoning\nrounds: mode A performs one per action, mode B saves the absorbed actions and pays one per escalation.\nDelegation and return rounds (two per subgoal) are excluded from both columns.')
  process.exit(0)
}

const startedAt = Date.now()
const results = await runAll({ minActionConfidence: resolved.minActionConfidence, minActionMargin: resolved.minActionMargin, minCompletionConfidence: resolved.minCompletionConfidence, minAmbiguityConfidence: resolved.minAmbiguityConfidence }, (task, judged) => {
  console.log(`${judged.success ? 'PASS' : 'FAIL'} ${judged.id.padEnd(32)} ${judged.status.padEnd(10)} acted=${judged.actedActions}/${judged.expectedActions} wrong=${judged.wrongActions} jev=${judged.jevCalls} ${judged.elapsedMs}ms${judged.reason ? `  ${judged.reason}` : ''}`)
  if (!judged.success && detail) detailLine(task, judged)
})
const wallMs = Date.now() - startedAt
const summary = summarize(results, { label: 'shipped defaults' })

console.log('\n=== Fast Browser Use benchmark (shipped gates) ===')
console.log(`decision model:       ${resolved.model}`)
console.log(`tasks:                ${results.length}  wall-clock ${(wallMs / 1000).toFixed(1)}s  concurrency ${concurrency}`)
console.log(`task success:         ${rate(summary.success, summary.tasks)}  (${summary.success}/${summary.tasks})`)
console.log(`subgoals completed:   ${rate(results.filter(item => item.status === 'completed').length, results.length)}   escalated ${rate(summary.escalations, results.length)}  failed ${rate(results.filter(item => ['error', 'max_steps', 'timeout'].includes(item.status)).length, results.length)}`)
console.log(`action coverage:      ${rate(summary.actedActions, summary.expectedActions)}  (${summary.actedActions}/${summary.expectedActions} required steps run by the fast path)`)
console.log(`autonomous accuracy:  ${rate(summary.correctActions, summary.actedActions)}  (${summary.correctActions} right, ${summary.wrongActions} wrong)`)
console.log(`decision calls:       ${summary.jevCalls}  input tokens ${summary.inputTokens}  mean decision ${Math.round(summary.decisionMs)}ms`)
console.log(`\nmain-model browser reasoning rounds`)
console.log(`  mode A (one round per required action): ${summary.modeARounds}`)
console.log(`  mode B (absorbed actions saved, escalations paid): ${summary.modeBRounds}`)
console.log(`  reduction: ${rate(summary.modeARounds - summary.modeBRounds, summary.modeARounds)}`)
console.log(`  plus ${results.length} delegation and ${results.filter(item => item.status === 'completed').length} return rounds on mode B`)
console.log('\nRun with --sweep for the risk-at-coverage curve and --detail for per-step verdicts.')
