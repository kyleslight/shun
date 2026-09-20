import { createHash } from 'node:crypto'
import { Type } from 'typebox'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { BrowserSession, Settings } from '../shared.ts'
import type { BrowserAction, ChromeSnapshot } from './chrome-browser.ts'
import { OpenRouterJevClient, resolveComputerUseAcceleration, type DecisionAnswer, type DecisionClient, type DecisionQuestion } from './jev-client.ts'

/**
 * Bounded fast Browser Use.
 *
 * The main model plans, writes text, and decides what is worth doing. The fast
 * path only chooses among actions Shun already generated from a fresh
 * accessibility snapshot, one action per snapshot, and hands control back the
 * moment the next step stops being obvious. It accelerates Browser Use without
 * ever becoming a dependency of it.
 */

/**
 * A combobox is both clickable and typeable: clicking it opens its list, and a
 * supplied value can be typed into it. Leaving it out of the clickable roles
 * makes a dropdown impossible to open at all.
 */
const CLICKABLE_ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox', 'radio', 'option', 'switch', 'treeitem', 'combobox'])
const INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'textarea'])
const SENSITIVE_INPUT_KEY = /(password|passwd|passcode|secret|token|api[-_]?key|otp|one[-_ ]?time|verification[-_ ]?code|recovery[-_ ]?code|cvv|cvc|card|payment|iban|ssn|pin|seed|mnemonic|private[-_]?key)/i
const NUMERIC_REF = /^[1-9]\d{0,11}$/

const MAX_ACTION_CANDIDATES = 60
const MAX_STATE_ELEMENTS = 120
const MAX_VISIBLE_TEXT = 3_000
const MAX_HISTORY = 5
const MAX_REPEATED_STATE = 3
const MAX_REPEATED_ACTION = 3
const STABILIZE_DELAYS_MS = [250, 500, 1_000]

export type BrowserFastHost = {
  snapshot(taskId: string, browserSessionId?: unknown, screenshot?: boolean): Promise<{ session: BrowserSession; snapshot: ChromeSnapshot; text: string }>
  act(taskId: string, browserSessionId: unknown, action: BrowserAction): Promise<{ session: BrowserSession; snapshot: ChromeSnapshot; text: string }>
}

export type ActionCandidate = {
  id: string
  description: string
  /** Absent only for the escalation candidate: the fast model selects, it never authors an action. */
  action?: BrowserAction
}

export type BrowserFastConfig = {
  model: string
  minActionConfidence: number
  minActionMargin: number
  minCompletionConfidence: number
  minAmbiguityConfidence: number
  maxMutationProbability: number
  maxSteps: number
  timeoutMs: number
}

export type BrowserFastStatus = 'completed' | 'escalate' | 'max_steps' | 'timeout' | 'error'

export type BrowserFastStep = { action: string; description: string; probability?: number; url?: string }

export type BrowserFastTrace = {
  taskId: string
  runId?: string
  sessionId?: string
  goal: string
  step: number
  stateHash: string
  candidateCount: number
  selectedCandidate?: string
  selectedProbability?: number
  selectedMargin?: number
  completionProbability?: number
  ambiguityProbability?: number
  mutationProbability?: number
  decisionMs: number
  browserActionMs?: number
  outcome: 'acted' | 'completed' | 'escalated' | 'failed'
}

export type BrowserFastResult = {
  status: BrowserFastStatus
  goal: string
  reason?: string
  steps: BrowserFastStep[]
  elapsed_ms: number
  final?: { title: string; url: string; ready_state?: string; snapshot: string }
  snapshot?: string
  candidates?: Array<{ action: string; probability: number }>
  metrics: { jevCalls: number; browserActions: number; elapsedMs: number; averageDecisionMs: number; inputTokens: number }
}

export type BrowserFastRequest = {
  taskId: string
  browserSessionId?: string
  goal: string
  input?: Record<string, string>
  /** Only when the user's request already authorizes the side effect. */
  allowMutations?: boolean
  maxSteps?: number
  timeoutMs?: number
}

type FastStepSummary = { action: string; description: string; probability?: number; url?: string }

function cleanText(value: unknown, limit: number) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Accessible state that changes what an action would mean, in one bounded string. */
function controlState(node: Record<string, any>) {
  return [
    node?.focused ? 'focused' : '',
    node?.disabled ? 'disabled' : '',
    typeof node?.expanded === 'boolean' ? `expanded=${node.expanded}` : '',
    typeof node?.checked === 'boolean' ? `checked=${node.checked}` : '',
    typeof node?.selected === 'boolean' ? `selected=${node.selected}` : '',
  ].filter(Boolean).join(' ')
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

/**
 * Turns the accessibility nodes into a finite set of legal actions. The fast
 * model chooses from this set; it cannot produce an action of its own, and typed
 * text always comes from values the main model already supplied.
 */
export function buildActionCandidates(snapshot: Pick<ChromeSnapshot, 'nodes'>, goal: string, options: { input?: Record<string, string> } = {}): ActionCandidate[] {
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : []
  const inputs = Object.entries(options.input || {}).filter((entry): entry is [string, string] => Boolean(String(entry[0] || '').trim()) && typeof entry[1] === 'string' && entry[1].length > 0)
  const goalTokens = new Set(goal.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 2))
  const ranked: Array<{ candidate: ActionCandidate; focused: number; overlap: number; role: number; index: number }> = []

  nodes.forEach((node, index) => {
    const ref = String(node?.ref ?? '').trim()
    if (!NUMERIC_REF.test(ref) || node?.disabled) return
    const role = cleanText(node?.role, 60).toLowerCase()
    const name = cleanText(node?.name, 160)
    const overlap = name ? [...goalTokens].filter(token => name.toLowerCase().includes(token)).length : 0
    const focused = node?.focused ? 1 : 0
    if (CLICKABLE_ROLES.has(role) && name) {
      ranked.push({
        candidate: { id: `click:${ref}`, description: `Click ${role} "${name}"`, action: { action: 'click', ref } },
        focused, overlap, role: role === 'button' || role === 'link' ? 0 : 1, index,
      })
    }
    if (INPUT_ROLES.has(role)) {
      const label = name || cleanText(node?.description, 120) || 'unlabelled field'
      for (const [key, value] of inputs) {
        const sensitive = SENSITIVE_INPUT_KEY.test(key)
        ranked.push({
          candidate: {
            id: `type:${ref}:${key}`,
            // A sensitive value is named, never printed: it stays inside Shun and is resolved at execution time.
            description: `Type the supplied ${sensitive ? 'sensitive ' : ''}input "${key}" into ${role} "${label}"`,
            action: { action: 'type', ref, text: value, clear: true },
          },
          focused, overlap, role: 2, index,
        })
      }
    }
  })

  ranked.sort((left, right) => right.focused - left.focused || right.overlap - left.overlap || left.role - right.role || left.index - right.index)
  const fixed = fixedCandidates(nodes)
  const budget = Math.max(1, MAX_ACTION_CANDIDATES - fixed.length)
  const candidates = ranked.slice(0, budget).map(entry => entry.candidate)
  for (const candidate of fixed) if (!candidates.some(item => item.id === candidate.id)) candidates.push(candidate)
  return candidates
}

/**
 * The candidates that do not depend on a named control. A keyboard candidate is
 * offered only when the page gives a reason for it, and every one of them is
 * still judged by the same external-state question as a click.
 */
function fixedCandidates(nodes: Array<Record<string, any>>): ActionCandidate[] {
  const roles = new Set(nodes.map(node => cleanText(node?.role, 60).toLowerCase()))
  const hasEditable = nodes.some(node => INPUT_ROLES.has(cleanText(node?.role, 60).toLowerCase()) || node?.focused)
  const candidates: ActionCandidate[] = []
  if (hasEditable) candidates.push({
    id: 'keypress:Enter',
    description: 'Press Enter to confirm the value in the focused field or open the currently highlighted result.',
    action: { action: 'keypress', key: 'Enter' },
  })
  if (['dialog', 'alertdialog', 'menu', 'listbox'].some(role => roles.has(role))) candidates.push({
    id: 'keypress:Escape',
    description: 'Press Escape to dismiss the open overlay without changing anything.',
    action: { action: 'keypress', key: 'Escape' },
  })
  candidates.push(
    { id: 'scroll:down', description: 'Scroll down one viewport to reveal more of the page.', action: { action: 'scroll', direction: 'down', amount: 1 } },
    { id: 'scroll:up', description: 'Scroll up one viewport.', action: { action: 'scroll', direction: 'up', amount: 1 } },
    { id: 'back', description: 'Navigate back to the previous page.', action: { action: 'back' } },
    { id: 'escalate', description: 'The correct next action is unclear or needs reasoning outside this browser state. Return control to the main model.' },
  )
  return candidates
}

/**
 * The fast model receives only the local control state — the page, the offered
 * actions, and what was already supplied — never the Shun conversation.
 */
export function buildJevState(request: {
  goal: string
  input?: Record<string, string>
  snapshot: ChromeSnapshot
  session?: BrowserSession
  candidates: ActionCandidate[]
  history?: FastStepSummary[]
}) {
  const elements = (Array.isArray(request.snapshot.nodes) ? request.snapshot.nodes : [])
    .filter(node => NUMERIC_REF.test(String(node?.ref ?? '').trim()))
    .slice(0, MAX_STATE_ELEMENTS)
    .map(node => ({
      ref: String(node.ref),
      role: cleanText(node.role, 60),
      ...(node.name ? { name: cleanText(node.name, 160) } : {}),
      ...(node.value ? { value: cleanText(node.value, 120) } : {}),
      // Disclosed control state is how the completion question can tell an
      // already-expanded section from a collapsed one without acting again.
      ...(controlState(node) ? { state: controlState(node) } : {}),
    }))
  const supplied = Object.entries(request.input || {}).filter(([key]) => Boolean(String(key).trim())).map(([key, value]) => (
    SENSITIVE_INPUT_KEY.test(key)
      ? { key, available: true, sensitive: true }
      : { key, available: true, sensitive: false, value: cleanText(value, 400) }
  ))
  return {
    description: 'Current state of a delegated browser subgoal. Choose one offered action, or report that the subgoal is already complete.',
    goal: request.goal,
    page: {
      title: cleanText(request.snapshot.tab?.title || request.session?.title, 200),
      url: cleanText(request.snapshot.tab?.url || request.session?.url, 500),
      ready_state: cleanText(request.snapshot.readyState, 40) || undefined,
    },
    visible_text: cleanText(request.snapshot.text, MAX_VISIBLE_TEXT),
    elements,
    supplied_inputs: supplied,
    available_actions: request.candidates.map(candidate => ({ id: candidate.id, description: candidate.description })),
    recent_actions: (request.history || []).map(item => `${item.action} → ${item.url || ''}`.trim()),
  }
}

/** One request carries every judgment, because the model evaluates them in parallel. */
export function buildBrowserQuestions(candidates: ActionCandidate[]): Record<string, DecisionQuestion> {
  return {
    goal_completed: {
      type: 'noul',
      instructions: 'The current page shows that the delegated subgoal’s outcome has been reached. Judge the outcome, not the route: a subgoal whose purpose was to reach a page is complete once that page is shown, a subgoal whose purpose was to produce a result is complete once that result is visible, and a subgoal with several parts is complete once its last part is satisfied. A field, button, or menu that belongs to the subgoal being still on screen is not evidence that the subgoal is unfinished. Do not treat an intermediate step as the destination, and do not assume a step worked merely because it was attempted.',
      criteria: {
        true: 'The page, URL, title, or visible text already shows the subgoal’s outcome — the destination is open, or the result the subgoal asked for is on screen.',
        false: 'The outcome is not visible yet, or the page only shows the route towards it.',
      },
    },
    next_action: {
      type: 'choice',
      instructions: 'Which single offered action should happen now to make progress on the delegated subgoal? Choose exactly one offered option id. Choose "escalate" whenever the correct action needs reasoning or user intent that this browser state does not contain.',
      criteria: Object.fromEntries(candidates.map(candidate => [candidate.id, candidate.description])),
    },
    action_is_unambiguous: {
      type: 'noul',
      instructions: 'The selected next action follows directly from the delegated subgoal and what the current page shows, without assuming user intent, hidden state, or anything the page does not display. Other controls existing on the page does not by itself make this action ambiguous; what matters is whether this one is supported by the goal and the page.',
      criteria: {
        true: 'The subgoal and the visible page directly justify this action.',
        false: 'Choosing this action requires assuming intent or state the page does not show, or the page supports a different action just as directly.',
      },
    },
    action_changes_external_state: {
      type: 'noul',
      instructions: 'Executing the selected next action would create a consequence on the user’s behalf outside this page’s own state: sending a message or email, submitting an order or payment, deleting or publishing content, authorizing access, uploading a file, or changing account, permission, or security settings. Navigation, opening or dismissing a control, scrolling, typing a value into a field, choosing an option, and submitting a search query to a search engine are preparation for the user’s own browsing and do not count.',
      criteria: {
        true: 'The action sends, submits, deletes, publishes, authorizes, uploads, pays, or changes account state.',
        false: 'The action navigates, scrolls, opens or dismisses a control, types a value, chooses an option, or submits a search query.',
      },
    },
  }
}

export type BrowserFastVerdict = {
  goalCompleted: number
  action: string
  actionProbability?: number
  /** Probability of the selected action minus the next most likely one. */
  actionMargin?: number
  unambiguous?: number
  mutation?: number
}

function noulValue(answer: DecisionAnswer | undefined) {
  if (!answer || answer.type !== 'noul') return undefined
  const value = Number(answer.noul)
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined
}

export function readVerdict(answers: Record<string, DecisionAnswer>): BrowserFastVerdict | undefined {
  const goalCompleted = noulValue(answers.goal_completed)
  const choice = answers.next_action
  if (goalCompleted === undefined) return undefined
  if (!choice || choice.type !== 'choice' || !choice.choice) return undefined
  const probability = choice.probabilities?.[choice.choice] ?? choice.confidence
  const others = Object.entries(choice.probabilities || {})
    .filter(([id]) => id !== choice.choice)
    .map(([, value]) => Number(value))
    .filter(value => Number.isFinite(value))
  return {
    goalCompleted,
    action: choice.choice,
    actionProbability: Number.isFinite(probability) ? Number(probability) : undefined,
    // Only measurable when the model returned a distribution. A single confidence
    // figure says nothing about how close the runner-up was.
    actionMargin: others.length && Number.isFinite(probability) ? Number(probability) - Math.max(...others) : undefined,
    unambiguous: noulValue(answers.action_is_unambiguous),
    mutation: noulValue(answers.action_changes_external_state),
  }
}

export function rankCandidates(answer: DecisionAnswer | undefined) {
  if (!answer || answer.type !== 'choice') return []
  const probabilities = answer.probabilities || (answer.confidence !== undefined ? { [answer.choice]: answer.confidence } : {})
  return Object.entries(probabilities)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .map(([action, probability]) => ({ action, probability }))
    .sort((left, right) => right.probability - left.probability)
}

export type BrowserFastDecision =
  | { kind: 'completed' }
  | { kind: 'escalate'; reason: string }
  | { kind: 'act'; candidate: ActionCandidate; probability: number }

/**
 * The fast path is allowed to absorb only steps whose conditional error rate is
 * very low. Every uncertainty — an unreadable judgment, a thin margin, a
 * possible external side effect — escalates instead of acting.
 */
export function decideBrowserFastStep(
  verdict: BrowserFastVerdict,
  candidates: ActionCandidate[],
  config: BrowserFastConfig,
  options: { allowMutations?: boolean } = {},
): BrowserFastDecision {
  if (verdict.goalCompleted >= config.minCompletionConfidence) return { kind: 'completed' }
  const candidate = candidates.find(item => item.id === verdict.action)
  if (!candidate) return { kind: 'escalate', reason: 'The fast decision selected an action that was not offered for this page.' }
  if (candidate.id === 'escalate') return { kind: 'escalate', reason: 'The fast decision reported that the next step needs the main model.' }
  if (verdict.actionProbability === undefined) return { kind: 'escalate', reason: 'The fast decision did not report how certain it was about the next action.' }
  if (verdict.actionProbability < config.minActionConfidence) return { kind: 'escalate', reason: 'No offered action was certain enough to run without the main model.' }
  // A page can reasonably offer several controls for the same intent, so the raw
  // probability alone would call a dominant choice uncertain. The gap to the
  // runner-up is what says whether this action was actually the one.
  if (verdict.actionMargin !== undefined && verdict.actionMargin < config.minActionMargin) {
    return { kind: 'escalate', reason: 'Two offered actions were nearly as likely, so the main model decides.' }
  }
  if (verdict.unambiguous === undefined) return { kind: 'escalate', reason: 'The fast decision did not report whether the next action was unambiguous.' }
  if (verdict.unambiguous < config.minAmbiguityConfidence) return { kind: 'escalate', reason: 'The next action needs an assumption the page does not support, so the main model decides.' }
  if (verdict.mutation === undefined) return { kind: 'escalate', reason: 'The fast decision did not report whether the next action changes external state.' }
  if (verdict.mutation >= config.maxMutationProbability && !options.allowMutations) return { kind: 'escalate', reason: 'The selected action may change external state, which needs explicit authorization.' }
  if (!candidate.action) return { kind: 'escalate', reason: 'The selected action had no executable form.' }
  return { kind: 'act', candidate, probability: verdict.actionProbability }
}

export function browserStateFingerprint(snapshot: ChromeSnapshot, session?: BrowserSession) {
  const nodes = (Array.isArray(snapshot.nodes) ? snapshot.nodes : []).slice(0, MAX_STATE_ELEMENTS).map(node => `${node?.ref}|${node?.role}|${cleanText(node?.name, 60)}`)
  return createHash('sha256').update(JSON.stringify({
    url: snapshot.tab?.url || session?.url || '',
    title: snapshot.tab?.title || session?.title || '',
    readyState: snapshot.readyState || '',
    text: cleanText(snapshot.text, 400),
    nodes,
  })).digest('hex').slice(0, 32)
}

export class BrowserFastExecutor {
  readonly #host: BrowserFastHost
  readonly #decisions: DecisionClient
  readonly #config: BrowserFastConfig
  readonly #options: {
    runId?: string
    onTrace?: (trace: BrowserFastTrace) => void
    now?: () => number
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>
  }
  readonly #traces: BrowserFastTrace[] = []

  constructor(
    host: BrowserFastHost,
    decisions: DecisionClient,
    config: BrowserFastConfig,
    options: {
      runId?: string
      onTrace?: (trace: BrowserFastTrace) => void
      now?: () => number
      wait?: (ms: number, signal?: AbortSignal) => Promise<void>
    } = {},
  ) {
    this.#host = host
    this.#decisions = decisions
    this.#config = config
    this.#options = options
  }

  get traces() { return [...this.#traces] }

  #trace(entry: BrowserFastTrace) {
    this.#traces.push(entry)
    try { this.#options.onTrace?.(entry) } catch { /* observability never breaks the run */ }
  }

  async execute(request: BrowserFastRequest, signal?: AbortSignal): Promise<BrowserFastResult> {
    const now = this.#options.now || (() => Date.now())
    const wait = this.#options.wait || delay
    const startedAt = now()
    const maxSteps = Math.max(1, Math.min(30, Math.floor(request.maxSteps ?? this.#config.maxSteps)))
    const timeoutMs = Math.max(1_000, Math.floor(request.timeoutMs ?? this.#config.timeoutMs))
    const steps: BrowserFastStep[] = []
    const history: FastStepSummary[] = []
    const stateCounts = new Map<string, number>()
    const actionCounts = new Map<string, number>()
    let jevCalls = 0
    let browserActions = 0
    let decisionMs = 0
    let inputTokens = 0
    let ranked: Array<{ action: string; probability: number }> = []
    let sessionId = request.browserSessionId
    let snapshot: Awaited<ReturnType<BrowserFastHost['snapshot']>>

    const metrics = () => ({ jevCalls, browserActions, elapsedMs: now() - startedAt, averageDecisionMs: jevCalls ? Math.round(decisionMs / jevCalls) : 0, inputTokens })
    const finish = (status: BrowserFastStatus, reason?: string): BrowserFastResult => ({
      status,
      goal: request.goal,
      ...(reason ? { reason } : {}),
      steps,
      elapsed_ms: now() - startedAt,
      ...(status === 'completed' ? { final: { title: snapshot.session.title, url: snapshot.session.url, ready_state: snapshot.snapshot.readyState, snapshot: snapshot.text } } : {}),
      ...(status === 'escalate' ? { snapshot: snapshot.text } : {}),
      ...(status === 'escalate' && ranked.length ? { candidates: ranked.slice(0, 5) } : {}),
      metrics: metrics(),
    })

    try {
      snapshot = await this.#host.snapshot(request.taskId, sessionId, false)
      sessionId = snapshot.session.id
    } catch (error) {
      return {
        status: 'error',
        goal: request.goal,
        reason: error instanceof Error ? error.message : 'The browser session could not be inspected.',
        steps,
        elapsed_ms: now() - startedAt,
        metrics: metrics(),
      }
    }

    for (let step = 0; step < maxSteps; step++) {
      if (signal?.aborted) return finish('escalate', 'The fast browser goal was cancelled.')
      if (now() - startedAt > timeoutMs) return finish('timeout', 'The fast browser goal ran out of time.')

      // A transitional page is not a decision. Wait briefly for it to settle, with a
      // bounded budget, because a single-page app may never report "complete".
      for (const settle of STABILIZE_DELAYS_MS) {
        const readyState = snapshot.snapshot.readyState
        if (!readyState || readyState === 'complete') break
        await wait(settle, signal)
        if (signal?.aborted) return finish('escalate', 'The fast browser goal was cancelled.')
        try {
          snapshot = await this.#host.snapshot(request.taskId, sessionId, false)
          sessionId = snapshot.session.id
        } catch (error) {
          return finish('error', error instanceof Error ? error.message : 'The browser session could not be inspected.')
        }
      }

      const candidates = buildActionCandidates(snapshot.snapshot, request.goal, { input: request.input })
      const stateHash = browserStateFingerprint(snapshot.snapshot, snapshot.session)
      const seen = (stateCounts.get(stateHash) || 0) + 1
      stateCounts.set(stateHash, seen)
      if (seen >= MAX_REPEATED_STATE) {
        this.#trace({ taskId: request.taskId, runId: this.#options.runId, sessionId, goal: request.goal, step, stateHash, candidateCount: candidates.length, decisionMs: 0, outcome: 'escalated' })
        return finish('escalate', 'The page did not change across repeated attempts, so the main model decides.')
      }

      const state = buildJevState({ goal: request.goal, input: request.input, snapshot: snapshot.snapshot, session: snapshot.session, candidates, history })
      const decisionStartedAt = now()
      let answers: Record<string, DecisionAnswer>
      try {
        jevCalls += 1
        const response = await this.#decisions.decide({ model: this.#config.model, state, questions: buildBrowserQuestions(candidates) }, signal)
        answers = response.answers
        inputTokens += response.usage?.inputTokens || 0
      } catch (error) {
        const failedMs = now() - decisionStartedAt
        decisionMs += failedMs
        this.#trace({ taskId: request.taskId, runId: this.#options.runId, sessionId, goal: request.goal, step, stateHash, candidateCount: candidates.length, decisionMs: failedMs, outcome: 'failed' })
        return finish('error', error instanceof Error ? error.message : 'The fast decision request failed.')
      }
      const decisionMsStep = now() - decisionStartedAt
      decisionMs += decisionMsStep
      ranked = rankCandidates(answers.next_action)
      const verdict = readVerdict(answers)
      const traceBase = {
        taskId: request.taskId, runId: this.#options.runId, sessionId, goal: request.goal, step, stateHash, candidateCount: candidates.length,
        decisionMs: decisionMsStep,
        completionProbability: verdict?.goalCompleted,
        ambiguityProbability: verdict?.unambiguous,
        mutationProbability: verdict?.mutation,
        selectedCandidate: verdict?.action,
        selectedProbability: verdict?.actionProbability,
        selectedMargin: verdict?.actionMargin,
      }
      if (!verdict) {
        this.#trace({ ...traceBase, outcome: 'escalated' })
        return finish('escalate', 'The fast decision did not return a judgment Shun could read.')
      }

      const outcome = decideBrowserFastStep(verdict, candidates, this.#config, { allowMutations: request.allowMutations })
      if (outcome.kind === 'completed') {
        this.#trace({ ...traceBase, outcome: 'completed' })
        return finish('completed')
      }
      if (outcome.kind === 'escalate') {
        this.#trace({ ...traceBase, outcome: 'escalated' })
        return finish('escalate', outcome.reason)
      }

      const repeats = (actionCounts.get(outcome.candidate.id) || 0) + 1
      actionCounts.set(outcome.candidate.id, repeats)
      if (repeats >= MAX_REPEATED_ACTION) {
        this.#trace({ ...traceBase, outcome: 'escalated' })
        return finish('escalate', 'The same action was selected repeatedly without progress, so the main model decides.')
      }

      const actionStartedAt = now()
      try {
        snapshot = await this.#host.act(request.taskId, sessionId, outcome.candidate.action!)
        sessionId = snapshot.session.id
      } catch (error) {
        this.#trace({ ...traceBase, browserActionMs: now() - actionStartedAt, outcome: 'failed' })
        return finish('error', error instanceof Error ? error.message : 'The browser action failed.')
      }
      browserActions += 1
      steps.push({ action: outcome.candidate.id, description: outcome.candidate.description, probability: outcome.probability, url: snapshot.session.url })
      history.push({ action: outcome.candidate.id, description: outcome.candidate.description, probability: outcome.probability, url: snapshot.session.url })
      if (history.length > MAX_HISTORY) history.shift()
      this.#trace({ ...traceBase, browserActionMs: now() - actionStartedAt, outcome: 'acted' })
    }

    return finish('max_steps', 'The fast browser goal reached its step limit.')
  }
}

export type BrowserFastToolOptions = {
  settings: Settings
  host: BrowserFastHost
  taskId: string
  runId?: string
  client?: DecisionClient
  onTrace?: (trace: BrowserFastTrace) => void
}

/**
 * Registers the fast tool only when acceleration resolves. Without a compatible
 * credential this returns nothing at all, so Browser Use keeps working exactly
 * as it does without acceleration.
 */
export function browserFastToolDefinitions(options: BrowserFastToolOptions): ToolDefinition[] {
  const acceleration = resolveComputerUseAcceleration(options.settings)
  if (!acceleration) return []
  const decisions = options.client || new OpenRouterJevClient({ apiKey: acceleration.apiKey, endpoint: acceleration.endpoint, timeoutMs: Math.min(acceleration.timeoutMs, 10_000) })
  const host = options.host
  const taskId = options.taskId
  return [
    defineTool({
      name: 'browser_fast',
      label: 'Run fast browser steps',
      description: 'Delegate one narrow browser subgoal that can usually be completed by obvious UI actions, such as navigating to an obvious page, searching, opening a menu, choosing an obvious result, or moving through a predictable sequence. A fast decision model then picks one offered action at a time from a fresh snapshot and repeats while its confidence stays high. Pass exact values that must be typed through input; the fast model never writes text, invents a URL, or creates an action of its own. It returns completed with the final page snapshot, or escalate with the current snapshot when the next step stops being obvious. The normal Browser Use tools remain authoritative whenever this escalates or is unavailable.',
      parameters: Type.Object({
        browser_session_id: Type.Optional(Type.String({ description: 'A task-owned Browser Use session id. Absent means the most recent session for this task.' })),
        goal: Type.String({
          minLength: 1,
          maxLength: 2_000,
          description: 'A narrow browser subgoal, stated as an outcome. Do not list individual clicks.',
        }),
        input: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 20_000 }), {
          description: 'Exact values you have already determined that may be typed into UI fields, keyed by the name used in the goal.',
        })),
        allow_mutations: Type.Optional(Type.Boolean({
          description: 'Set only when the user’s request already authorizes the external side effect, such as sending or submitting something they asked to send.',
        })),
        max_steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
      }, { additionalProperties: false }),
      execute: async (_id, args, signal) => {
        const executor = new BrowserFastExecutor(host, decisions, acceleration, { runId: options.runId, onTrace: options.onTrace })
        const outcome = await executor.execute({
          taskId,
          browserSessionId: args.browser_session_id,
          goal: args.goal,
          input: args.input,
          allowMutations: args.allow_mutations,
          maxSteps: args.max_steps,
        }, signal)
        return { content: [{ type: 'text' as const, text: JSON.stringify(outcome, null, 2) }], details: outcome }
      },
    }),
  ]
}
