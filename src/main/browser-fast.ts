import { createHash } from 'node:crypto'
import { Type } from 'typebox'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { BrowserSession, Settings } from '../shared.ts'
import { decisionRouteForEndpoint, decisionRouteForId } from '../shared.ts'
import { BrowserControlUnavailableError } from './chrome-browser.ts'
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
const MAX_TEXT_CHANGE_CHARS = 600
const MAX_HISTORY = 5
/**
 * Progress is measured by the page, never by the action's name. A paging task
 * clicks the same control over and over and a game presses the same key over and
 * over; both are progress when the page moves. Only actions that leave the page
 * exactly as it was count towards stopping.
 */
const IDLE_ACTIONS_BEFORE_STOP = 2
/**
 * A sustained session runs for as long as the caller's task does, so its bounds are
 * budgets rather than one decision's worth of steps. Nothing here is a hand-back:
 * the loop keeps going until the task says it is done, something is in the way, or
 * the caller's own budget runs out.
 */
const SUSTAINED_MAX_STEPS = 600
const SUSTAINED_MAX_DURATION_MS = 300_000
const SUSTAINED_WAIT_BUDGET = 60
const SUSTAINED_UNCERTAIN_RUN = 12
/** Consecutive steps that changed nothing before a sustained loop hands back. */
const SUSTAINED_STALL_STEPS = 12
const MAX_STEPS_CEILING = 1_000
const MAX_DURATION_CEILING_MS = 600_000
const MAX_WAIT_BUDGET = 200
/** Uncertain steps in a row a control goal may take before it hands back. */
const CONTROL_UNCERTAIN_RUN = 3
const WAIT_BUDGET = 2
const CONTROL_WAIT_BUDGET = 6
/** One wait is a beat, not a sleep: long enough for an animation, short enough to keep the rhythm. */
const WAIT_MS = 400
const MAX_DECLARED_KEYS = 12
/** How many times one decision may repeat its action before asking again. */
const MAX_REPEAT_PER_DECISION = 8
/** How sure the fast model must be that a step repeats before it is repeated. */
const REPEAT_CONFIDENCE = 0.7
/** Repeat lengths the fast model chooses between, in one decision. */
const REPEAT_LIMITS = [1, 2, 4, 8, 12]
const MAX_PLAN_STEPS = 12
const MAX_PLAN_CYCLES = 8
/** A sustained session cycles the caller's plan for as long as the task needs it. */
const SUSTAINED_PLAN_CYCLES = 1_000

/**
 * Finds the offered control a plan step names. A plan step is written the way a
 * person would say it — the control's own name, or a phrase inside it — so an
 * exact name wins, then a name either contains, then the description.
 */
export function matchPlanStep(candidates: ActionCandidate[], step: string): ActionCandidate | undefined {
  const wanted = String(step || '').trim().toLowerCase()
  if (!wanted) return undefined
  const usable = candidates.filter(candidate => candidate.action || candidate.waitMs !== undefined)
  const named = (candidate: ActionCandidate) => String(candidate.name || '').trim().toLowerCase()
  return usable.find(candidate => named(candidate) === wanted)
    || usable.find(candidate => named(candidate) && (named(candidate).includes(wanted) || wanted.includes(named(candidate))))
    || usable.find(candidate => candidate.description.toLowerCase().includes(wanted))
}
/** Exactly the keys the Chrome bridge can dispatch, plus one character as a keystroke. */
const NAMED_KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'])
const SINGLE_KEY = /^[A-Za-z0-9]$/
const STABILIZE_DELAYS_MS = [250, 500, 1_000]

/** Keeps a caller-declared key set to keys the bridge can actually dispatch. */
export function declaredKeys(values: unknown): string[] {
  const list = Array.isArray(values) ? values : []
  const valid = list
    .map(value => String(value ?? '').trim())
    .filter(key => NAMED_KEYS.has(key) || SINGLE_KEY.test(key))
  return [...new Set(valid)].slice(0, MAX_DECLARED_KEYS)
}

export type BrowserFastHost = {
  snapshot(taskId: string, browserSessionId?: unknown, screenshot?: boolean): Promise<{ session: BrowserSession; snapshot: ChromeSnapshot; text: string }>
  act(taskId: string, browserSessionId: unknown, action: BrowserAction): Promise<{ session: BrowserSession; snapshot: ChromeSnapshot; text: string }>
}

export type ActionCandidate = {
  id: string
  description: string
  /** The control's accessible name, when it has one. This is what a caller's plan names. */
  name?: string
  /** Absent only for the escalation candidate: the fast model selects, it never authors an action. */
  action?: BrowserAction
  /**
   * A beat that touches nothing. Counting it as a candidate is what lets the fast
   * loop keep its own rhythm instead of handing an animation back to the main model.
   */
  waitMs?: number
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

export type BrowserFastStep = {
  action: string
  description: string
  probability?: number
  url?: string
  /** Why this step was taken on thin confidence, when the caller allowed that. */
  uncertain?: string
  /** Wall-clock cost of the step, from deciding it to acting on it. */
  ms?: number
  /** How long its decision took, when a decision chose it. */
  decisionMs?: number
  /** Whether the page was different after the step than before it. */
  changed?: boolean
  /** Whether the step landed inside the caller's declared deadline. */
  onTime?: boolean
  /** Why the step could not be performed: the control was covered or no longer there. */
  blocked?: string
}

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
  waitedMs?: number
  uncertain?: string
  outcome: 'acted' | 'waited' | 'completed' | 'escalated' | 'failed'
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
  metrics: {
    jevCalls: number
    browserActions: number
    waits: number
    uncertainSteps: number
    /** Steps that could not be performed because their control was covered or gone. */
    blockedSteps: number
    elapsedMs: number
    averageDecisionMs: number
    inputTokens: number
    /** Per-step latency, which is what a deadline is actually met or missed against. */
    p50StepMs: number
    p95StepMs: number
    maxStepMs: number
    /** When the caller declared a deadline: how many steps missed it, and the hit rate. */
    deadlineMisses?: number
    deadlineHitRate?: number
  }
}

export type BrowserFastRequest = {
  taskId: string
  browserSessionId?: string
  goal: string
  input?: Record<string, string>
  /** Only when the user's request already authorizes the side effect. */
  allowMutations?: boolean
  /**
   * A sustained interaction — a game, a terminal, a canvas, a keyboard-driven app.
   * The page may legitimately not change between actions, and doing the most
   * likely thing beats handing back, so both the progress rule and the confidence
   * rule are relaxed under their own bounded budgets.
   */
  control?: boolean
  /** Keys the caller allows, from the set the Chrome bridge can dispatch. */
  keys?: string[]
  /**
   * A control session: the state advances on its own clock and every action has a
   * deadline, so the loop must not stop for the reasons a browsing task would.
   * It implies sustained-interaction semantics and is bounded only by the caller's
   * budget, a stall, or something in the way.
   */
  sustained?: boolean
  /** How long a sustained session may run. Defaults to five minutes, capped at ten. */
  maxDurationMs?: number
  /** Consecutive steps that changed nothing before the session hands back. */
  maxStallSteps?: number
  /** How many beats the loop may take. Defaults to two, sixty when sustained. */
  waitBudget?: number
  /**
   * The caller's per-step deadline. Every step reports whether it met it, and the
   * run reports the hit rate, which is what turns "real time" into a number.
   */
  deadlineMs?: number
  /**
   * How many thin-but-plausible choices sustained control may take in a row before
   * it hands back. A page that offers one control several times over — a keyboard
   * shortcut beside its on-screen button — splits the distribution so that nothing
   * ever looks certain, and a control loop would rather act on the best guess than
   * stop. The total allowance is twice the consecutive one.
   */
  maxUncertainSteps?: number
  /**
   * Steps the caller has already determined, named by the control each one should
   * act on. The harness runs them at browser speed — a snapshot and an action per
   * step, no decision in between — and re-checks that each control is still there.
   * A decision model selects; it does not compute, so the part of the work that is
   * arithmetic belongs here, outside the loop.
   */
  plan?: string[]
  /** How many times to run the plan before deciding normally again. */
  cycles?: number
  /**
   * How many times one decision may repeat its chosen action. Repetition is what
   * turns N decisions into one for paging, scrolling, stepping, and holding a
   * direction — the same work every browser task has some of.
   */
  maxRepeat?: number
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

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low))
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
export function buildActionCandidates(snapshot: Pick<ChromeSnapshot, 'nodes' | 'readyState'>, goal: string, options: { input?: Record<string, string>; keys?: string[]; waitBudget?: number; control?: boolean } = {}): ActionCandidate[] {
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
        candidate: { id: `click:${ref}`, description: `Click ${role} "${name}"`, name, action: { action: 'click', ref } },
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
            ...(name ? { name } : {}),
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
  const fixed = fixedCandidates(nodes, {
    keys: declaredKeys(options.keys),
    waitBudget: Math.max(0, options.waitBudget ?? WAIT_BUDGET),
    // A beat is offered when waiting is plausibly the right thing: the page says
    // it is still loading, it offers nothing to act on at all, or the caller has
    // declared a sustained interaction. Everywhere else it would only dilute the
    // choice between real actions.
    waiting: Boolean(options.control) || ranked.length === 0 || Boolean(snapshot.readyState && snapshot.readyState !== 'complete'),
  })
  const budget = Math.max(1, MAX_ACTION_CANDIDATES - fixed.length)
  const candidates = ranked.slice(0, budget).map(entry => entry.candidate)
  for (const candidate of fixed) if (!candidates.some(item => item.id === candidate.id)) candidates.push(candidate)
  return candidates
}

/**
 * The candidates that do not depend on a named control. A keyboard candidate is
 * offered only when the page gives a reason for it — or when the caller declared
 * it, which is the only way a canvas, a terminal, or a shortcut-driven app is
 * reachable at all. Every one of them is still judged by the same external-state
 * question as a click.
 */
function fixedCandidates(nodes: Array<Record<string, any>>, options: { keys: string[]; waitBudget: number; waiting: boolean }): ActionCandidate[] {
  const roles = new Set(nodes.map(node => cleanText(node?.role, 60).toLowerCase()))
  const hasEditable = nodes.some(node => INPUT_ROLES.has(cleanText(node?.role, 60).toLowerCase()) || node?.focused)
  const candidates: ActionCandidate[] = []
  // A declared key is the caller's decision about the interface, so it leads the
  // offered set: on the pages that need it, it is the whole interface.
  for (const key of options.keys) candidates.push({
    id: `key:${key}`,
    description: key.length === 1
      ? `Press the ${key.toUpperCase()} key as a keystroke on the focused element.`
      : `Press ${key}.`,
    action: { action: 'keypress', key },
  })
  if (hasEditable && !options.keys.includes('Enter')) candidates.push({
    id: 'keypress:Enter',
    description: 'Press Enter to confirm the value in the focused field or open the currently highlighted result.',
    action: { action: 'keypress', key: 'Enter' },
  })
  if (['dialog', 'alertdialog', 'menu', 'listbox'].some(role => roles.has(role)) && !options.keys.includes('Escape')) candidates.push({
    id: 'keypress:Escape',
    description: 'Press Escape to dismiss the open overlay without changing anything.',
    action: { action: 'keypress', key: 'Escape' },
  })
  if (options.waitBudget > 0 && options.waiting) candidates.push({
    id: 'wait',
    description: `Do nothing for ${WAIT_MS} ms and look again. Choose this while the page is still catching up, instead of returning control.`,
    waitMs: WAIT_MS,
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
  /** The page text as it stood when the previous action was taken, so this state can carry what that action changed. */
  textBeforeLastAction?: string
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
  const visibleText = cleanText(request.snapshot.text, MAX_VISIBLE_TEXT)
  const change = request.textBeforeLastAction === undefined
    ? undefined
    : visibleTextChange(cleanText(request.textBeforeLastAction, MAX_VISIBLE_TEXT), visibleText)
  return {
    description: 'Current state of a delegated browser subgoal. Choose one offered action, or report that the subgoal is already complete. A page text window the previous action changed is carried as text_change_since_last_action; text_unchanged_since_last_action means that action has shown no effect yet.',
    goal: request.goal,
    page: {
      title: cleanText(request.snapshot.tab?.title || request.session?.title, 200),
      url: cleanText(request.snapshot.tab?.url || request.session?.url, 500),
      ready_state: cleanText(request.snapshot.readyState, 40) || undefined,
      ...(request.textBeforeLastAction === undefined ? {} : change ? { text_change_since_last_action: change } : { text_unchanged_since_last_action: true }),
    },
    visible_text: visibleText,
    elements,
    supplied_inputs: supplied,
    available_actions: request.candidates.map(candidate => ({ id: candidate.id, description: candidate.description })),
    recent_actions: (request.history || []).map(item => `${item.action} → ${item.url || ''}`.trim()),
  }
}

/**
 * The window of page text an action changed, so a decision sees motion instead of
 * a single frame. A goal that has to be carried out over several steps — steering
 * something that moves on its own, stepping a list, watching a value settle — is
 * only answerable when the state carries what the last step did, and two full
 * copies of the page would buy that at the cost of the budget it competes with.
 */
function visibleTextChange(before: string, after: string, cap = MAX_TEXT_CHANGE_CHARS): { before: string; after: string } | undefined {
  if (before === after) return undefined
  const shared = Math.min(before.length, after.length)
  let start = 0
  while (start < shared && before[start] === after[start]) start += 1
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore -= 1; endAfter -= 1 }
  const from = Math.max(0, start - Math.floor(cap / 4))
  return { before: before.slice(from, from + cap), after: after.slice(from, from + cap) }
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
      instructions: 'The selected next action is the one the delegated subgoal and this state together support: applying the goal to what the state shows is enough to pick it out, and acting on it needs no user intent, credentials, or page state that this state does not carry. Reasoning the goal itself asks for — a count, a comparison, a next state worked out from material the state does provide — is not an assumption and does not make the action ambiguous. Other controls existing on the page does not by itself make this action ambiguous; what matters is whether this one is supported by the goal and the state.',
      criteria: {
        true: 'The goal applied to what this state shows is enough to pick this action out.',
        false: 'Acting needs user intent, credentials, or page state this state does not carry at all — or another offered action is supported by the goal just as directly.',
      },
    },
    repeat_action: {
      type: 'noul',
      instructions: 'The chosen action should be performed again immediately, without waiting for another decision, for as long as the page keeps responding to it and the same control stays available. Choose true for a step that is expected to repeat — paging, scrolling, stepping through, tabbing, or holding one direction — and false when the next step should be judged from a fresh decision.',
      criteria: {
        true: 'The same action should be performed again right away, repeatedly.',
        false: 'It should be performed once, and the next step decided again.',
      },
    },
    repeat_limit: {
      type: 'choice',
      instructions: `At most how many times, including the first, should that action be performed before deciding again? Choose the smallest number that is still enough. Choose ${REPEAT_LIMITS[0]} when the action does not repeat.`,
      criteria: {
        '1': 'Perform it once.',
        '2': 'At most twice.',
        '4': 'At most four times.',
        '8': 'At most eight times.',
        '12': 'At most twelve times.',
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
  /** How sure the model is that this step repeats. */
  repeatAction?: number
  /** How many times, including the first, it asked to perform the action. */
  repeatLimit?: number
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
    repeatAction: noulValue(answers.repeat_action),
    repeatLimit: readRepeatLimit(answers.repeat_limit),
  }
}

/** The repeat length the model chose, restricted to the lengths it was offered. */
function readRepeatLimit(answer: DecisionAnswer | undefined) {
  if (!answer || answer.type !== 'choice') return undefined
  const value = Number(answer.choice)
  return Number.isFinite(value) && REPEAT_LIMITS.includes(value) ? value : undefined
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
  /** `uncertain` carries why the choice was thin, when the caller let it proceed anyway. */
  | { kind: 'act'; candidate: ActionCandidate; probability: number; uncertain?: string; repeat?: number }

/**
 * The fast path is allowed to absorb only steps whose conditional error rate is
 * very low. Every uncertainty — an unreadable judgment, a thin margin, a
 * possible external side effect — escalates instead of acting.
 */
export function decideBrowserFastStep(
  verdict: BrowserFastVerdict,
  candidates: ActionCandidate[],
  config: BrowserFastConfig,
  options: { allowMutations?: boolean; uncertainBudget?: number; maxRepeat?: number } = {},
): BrowserFastDecision {
  if (verdict.goalCompleted >= config.minCompletionConfidence) return { kind: 'completed' }
  const candidate = candidates.find(item => item.id === verdict.action)
  if (!candidate) return { kind: 'escalate', reason: 'The fast decision selected an action that was not offered for this page.' }
  if (candidate.id === 'escalate') return { kind: 'escalate', reason: 'The fast decision reported that the next step needs the main model.' }
  // The external-state boundary is never a confidence question: it holds at every
  // budget and in every mode.
  if (verdict.mutation === undefined) return { kind: 'escalate', reason: 'The fast decision did not report whether the next action changes external state.' }
  if (verdict.mutation >= config.maxMutationProbability && !options.allowMutations) return { kind: 'escalate', reason: 'The selected action may change external state, which needs explicit authorization.' }
  if (!candidate.action && candidate.waitMs === undefined) return { kind: 'escalate', reason: 'The selected action had no executable form.' }

  const doubt = thinConfidence(verdict, config)
  // A doubtful choice is never multiplied: performing an uncertain action many
  // times over compounds exactly the doubt that made it uncertain.
  const repeat = doubt ? 1 : repeatFor(verdict, options.maxRepeat)
  if (!doubt) return { kind: 'act', candidate, probability: verdict.actionProbability ?? 0, ...(repeat > 1 ? { repeat } : {}) }
  // Doing the most likely thing and carrying on beats stopping to ask, once the
  // caller has said this is a sustained interaction and while the budget lasts.
  if ((options.uncertainBudget ?? 0) > 0) return { kind: 'act', candidate, probability: verdict.actionProbability ?? 0, uncertain: doubt }
  return { kind: 'escalate', reason: doubt }
}

/** How many times one decision covers, when the model said the step repeats. */
function repeatFor(verdict: BrowserFastVerdict, maxRepeat: number | undefined) {
  if (verdict.repeatAction === undefined || verdict.repeatAction < REPEAT_CONFIDENCE) return 1
  if (verdict.repeatLimit === undefined) return 1
  const cap = Math.max(1, Math.min(12, Math.floor(maxRepeat ?? MAX_REPEAT_PER_DECISION)))
  return Math.max(1, Math.min(verdict.repeatLimit, cap))
}

/** What is missing or too thin to act on, or nothing when the choice is clear. */
function thinConfidence(verdict: BrowserFastVerdict, config: BrowserFastConfig): string | undefined {
  if (verdict.actionProbability === undefined) return 'The fast decision did not report how certain it was about the next action.'
  if (verdict.actionProbability < config.minActionConfidence) return 'No offered action was certain enough to run without the main model.'
  // A page can reasonably offer several controls for the same intent, so the raw
  // probability alone would call a dominant choice uncertain. The gap to the
  // runner-up is what says whether this action was actually the one.
  if (verdict.actionMargin !== undefined && verdict.actionMargin < config.minActionMargin) return 'Two offered actions were nearly as likely, so the main model decides.'
  if (verdict.unambiguous === undefined) return 'The fast decision did not report whether the next action was unambiguous.'
  if (verdict.unambiguous < config.minAmbiguityConfidence) return 'The next action needs an assumption the page does not support, so the main model decides.'
  return undefined
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
    const sustained = Boolean(request.sustained)
    const maxSteps = clamp(Math.floor(request.maxSteps ?? (sustained ? SUSTAINED_MAX_STEPS : this.#config.maxSteps)), 1, MAX_STEPS_CEILING)
    const timeoutMs = clamp(Math.floor(request.maxDurationMs ?? (sustained ? SUSTAINED_MAX_DURATION_MS : this.#config.timeoutMs)), 1_000, MAX_DURATION_CEILING_MS)
    const deadlineMs = request.deadlineMs === undefined ? undefined : Math.max(1, Math.floor(request.deadlineMs))
    const steps: BrowserFastStep[] = []
    const history: FastStepSummary[] = []
    let jevCalls = 0
    let browserActions = 0
    let waits = 0
    let uncertainSteps = 0
    let decisionMs = 0
    let inputTokens = 0
    // What the page showed when the previous action was taken, so the next decision
    // can be told what that action changed.
    let textBeforeLastAction: string | undefined
    let ranked: Array<{ action: string; probability: number }> = []
    let sessionId = request.browserSessionId
    let snapshot: Awaited<ReturnType<BrowserFastHost['snapshot']>>

    // Progress bookkeeping. Only an action that left the page exactly as it was
    // counts against the loop: repeating one action is how a control task and a
    // paging task both make progress.
    const control = sustained || Boolean(request.control)
    // A canvas, a game, and a terminal report the same accessibility tree however
    // they are actually doing, so a sustained interaction does not require the page
    // to change. A sustained *session* still watches for a stall, because a page
    // that stopped responding entirely is worth handing back; nothing else about the
    // loop's lifetime is a hand-back.
    const idleLimit = sustained
      ? Math.max(1, Math.floor(request.maxStallSteps ?? SUSTAINED_STALL_STEPS))
      : control ? Number.POSITIVE_INFINITY : IDLE_ACTIONS_BEFORE_STOP
    const waitBudget = clamp(Math.floor(request.waitBudget ?? (sustained ? SUSTAINED_WAIT_BUDGET : control ? CONTROL_WAIT_BUDGET : WAIT_BUDGET)), 0, MAX_WAIT_BUDGET)
    let idleActions = 0
    const uncertainRunLimit = control
      ? clamp(Math.floor(request.maxUncertainSteps ?? (sustained ? SUSTAINED_UNCERTAIN_RUN : CONTROL_UNCERTAIN_RUN)), 1, 50)
      : 0
    let uncertainUsed = 0
    let uncertainRun = 0
    let actions = 0
    let blockedSteps = 0
    // A control that cannot be clicked as observed is set aside for the state it
    // failed in, so the next decision chooses among what is actually actionable
    // instead of repeating a click that cannot land.
    const setAside = new Map<string, string>()
    const setAsideIds = new Map<string, string>()
    let setAsideState = ''
    let lastObstruction = ''

    const metrics = () => {
      const latencies = steps.map(step => step.ms).filter((value): value is number => typeof value === 'number').sort((left, right) => left - right)
      const at = (fraction: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(fraction * latencies.length))] : 0
      const graded = steps.filter(step => step.onTime !== undefined)
      const misses = graded.filter(step => step.onTime === false).length
      return {
        jevCalls, browserActions, waits, uncertainSteps, blockedSteps,
        elapsedMs: now() - startedAt,
        averageDecisionMs: jevCalls ? Math.round(decisionMs / jevCalls) : 0,
        inputTokens,
        p50StepMs: at(0.5), p95StepMs: at(0.95), maxStepMs: latencies.length ? latencies[latencies.length - 1] : 0,
        ...(deadlineMs === undefined ? {} : { deadlineMisses: misses, deadlineHitRate: graded.length ? 1 - misses / graded.length : 1 }),
      }
    }
    const finish = (status: BrowserFastStatus, reason?: string): BrowserFastResult => {
      // Whatever else ended the run, the main model must be told about a control
      // that could not be clicked: otherwise it reads a hand-back with no cause.
      const obstruction = lastObstruction && !String(reason || '').includes(lastObstruction) ? lastObstruction : ''
      return {
      status,
      goal: request.goal,
      reason: [reason, obstruction].filter(Boolean).join(' ') || undefined,
      steps,
      elapsed_ms: now() - startedAt,
      ...(status === 'completed' ? { final: { title: snapshot.session.title, url: snapshot.session.url, ready_state: snapshot.snapshot.readyState, snapshot: snapshot.text } } : {}),
      ...(status === 'escalate' ? { snapshot: snapshot.text } : {}),
      ...(status === 'escalate' && ranked.length ? { candidates: ranked.slice(0, 5) } : {}),
      metrics: metrics(),
      }
    }

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

    let previousFingerprint = browserStateFingerprint(snapshot.snapshot, snapshot.session)

    /**
     * One action, with all of the bookkeeping that makes the next decision honest.
     * It carries its own trace context so a caller-determined plan step and a decided
     * step are recorded the same way.
     */
    const perform = async (candidate: ActionCandidate, options: {
      probability?: number
      uncertain?: string
      trace?: Record<string, unknown>
      stateHash?: string
      candidateCount?: number
      decisionMs?: number
      /** When this step started, so the step can report its own wall-clock cost. */
      stepStartedAt?: number
      /** A caller-determined plan step is already a decision: it is not a stall. */
      countsTowardStall?: boolean
    } = {}): Promise<string | { unavailable: string; description: string } | undefined> => {
      const { probability, uncertain } = options
      const actionStartedAt = now()
      const stepMs = () => options.stepStartedAt === undefined ? undefined : now() - options.stepStartedAt
      const grade = () => deadlineMs === undefined ? undefined : (now() - (options.stepStartedAt ?? actionStartedAt)) <= deadlineMs
      const textBeforeAction = snapshot.snapshot.text
      try {
        snapshot = await this.#host.act(request.taskId, sessionId, candidate.action!)
        sessionId = snapshot.session.id
        textBeforeLastAction = textBeforeAction
      } catch (error) {
        this.#trace({ taskId: request.taskId, runId: this.#options.runId, sessionId, goal: request.goal, step: actions, stateHash: options.stateHash || '', candidateCount: options.candidateCount || 0, decisionMs: options.decisionMs || 0, selectedCandidate: candidate.id, browserActionMs: now() - actionStartedAt, outcome: 'failed' })
        // A control that is covered or gone is a fact about the page, not a broken
        // fast path. It is recorded and answered, never guessed at.
        if (error instanceof BrowserControlUnavailableError) {
          const ms = stepMs()
          steps.push({ action: candidate.id, description: candidate.description, url: snapshot.session.url, ...(ms === undefined ? {} : { ms }), ...(deadlineMs === undefined ? {} : { onTime: grade() }), blocked: error.message })
          lastObstruction = error.message
          if (options.countsTowardStall !== false) idleActions += 1
          return { unavailable: error.message, description: candidate.description }
        }
        return error instanceof Error ? error.message : 'The browser action failed.'
      }
      browserActions += 1
      actions += 1
      const afterFingerprint = browserStateFingerprint(snapshot.snapshot, snapshot.session)
      const changed = afterFingerprint !== previousFingerprint
      if (changed) idleActions = 0
      else if (options.countsTowardStall !== false) idleActions += 1
      previousFingerprint = afterFingerprint
      // A run of thin choices is a repeated guess only while the page stays put. A
      // page that moved is a new situation, so the run starts again: otherwise a live
      // task whose every choice looks equally reasonable would end a session early.
      if (uncertain) { uncertainUsed += 1; uncertainSteps += 1; uncertainRun = changed ? 1 : uncertainRun + 1 } else if (options.trace) uncertainRun = 0
      const ms = stepMs()
      steps.push({
        action: candidate.id, description: candidate.description,
        ...(probability === undefined ? {} : { probability }),
        url: snapshot.session.url,
        ...(options.decisionMs === undefined ? {} : { decisionMs: options.decisionMs }),
        ...(ms === undefined ? {} : { ms, changed }),
        ...(deadlineMs === undefined ? {} : { onTime: grade() }),
        ...(uncertain ? { uncertain } : {}),
      })
      history.push({ action: candidate.id, description: candidate.description, ...(probability === undefined ? {} : { probability }), url: snapshot.session.url })
      if (history.length > MAX_HISTORY) history.shift()
      this.#trace({
        taskId: request.taskId, runId: this.#options.runId, sessionId, goal: request.goal, step: actions - 1,
        stateHash: options.stateHash || '', candidateCount: options.candidateCount || 0, decisionMs: options.decisionMs || 0,
        ...(options.trace || {}), selectedCandidate: candidate.id, ...(probability === undefined ? {} : { selectedProbability: probability }),
        browserActionMs: now() - actionStartedAt, ...(uncertain ? { uncertain } : {}), outcome: 'acted',
      })
      return undefined
    }

    /** Asks only whether the subgoal has been reached, which is the judgement a plan needs between cycles. */
    const reachedGoal = async (): Promise<boolean> => {
      try {
        jevCalls += 1
        const response = await this.#decisions.decide({
          model: this.#config.model,
          state: buildJevState({ goal: request.goal, input: request.input, snapshot: snapshot.snapshot, session: snapshot.session, candidates: [], history }),
          questions: {
            goal_completed: {
              type: 'noul',
              instructions: 'The current page shows that the delegated subgoal’s outcome has been reached. Judge the outcome, not the route.',
              criteria: { true: 'The outcome is visible now.', false: 'Not yet, or not visible.' },
            },
          },
        }, signal)
        inputTokens += response.usage?.inputTokens || 0
        const value = response.answers.goal_completed
        return value?.type === 'noul' && Number(value.noul) >= this.#config.minCompletionConfidence
      } catch { return false }
    }

    // A caller-determined plan runs at browser speed: one snapshot and one action
    // per step, no decision in between. This is where work that would otherwise be
    // arithmetic inside a decision model belongs, and it is what keeps a loop
    // inside a page's own clock.
    const plan = (request.plan || []).map(step => String(step || '').trim()).filter(Boolean).slice(0, MAX_PLAN_STEPS)
    if (plan.length) {
      const cycles = clamp(Math.floor(request.cycles ?? 1), 1, sustained ? SUSTAINED_PLAN_CYCLES : MAX_PLAN_CYCLES)
      // A completion judgement is a beat of its own, and a step that has to land
      // inside a deadline cannot afford one every cycle. When the caller declares a
      // deadline, the loop spends a judgement no more often than that: this is what
      // "run at this pace" means in practice.
      let lastCompletionCheckAt = 0
      for (let cycle = 0; cycle < cycles; cycle++) {
        let ran = 0
        for (const step of plan) {
          if (signal?.aborted) return finish('escalate', 'The fast browser goal was cancelled.')
          if (now() - startedAt > timeoutMs) return finish('timeout', 'The fast browser goal ran out of time.')
          if (actions >= maxSteps) break
          const offered = matchPlanStep(buildActionCandidates(snapshot.snapshot, request.goal, {
            input: request.input, keys: request.keys, control, waitBudget: Math.max(0, waitBudget - waits),
          }), step)
          if (!offered) break
          const beforePlanStep = previousFingerprint
          if (offered.waitMs !== undefined) {
            const waitedMs = offered.waitMs
            waits += 1
            await wait(waitedMs, signal)
            snapshot = await this.#host.snapshot(request.taskId, sessionId, false)
            sessionId = snapshot.session.id
            previousFingerprint = browserStateFingerprint(snapshot.snapshot, snapshot.session)
            steps.push({ action: offered.id, description: offered.description, url: snapshot.session.url })
            continue
          }
          const planned = await perform(offered, { stepStartedAt: now(), countsTowardStall: false })
          if (planned) return typeof planned === 'string' ? finish('error', planned) : finish('escalate', planned.unavailable)
          ran += 1
          if (!control && previousFingerprint === beforePlanStep) break
        }
        if (!ran) return finish('escalate', `None of the controls this plan names is offered here (${plan.join(' → ')}), so the main model decides.`)
        if (deadlineMs === undefined || now() - lastCompletionCheckAt >= deadlineMs) {
          lastCompletionCheckAt = now()
          if (await reachedGoal()) return finish('completed')
        }
      }
    }

    while (actions < maxSteps) {
      if (signal?.aborted) return finish('escalate', 'The fast browser goal was cancelled.')
      if (now() - startedAt > timeoutMs) return finish('timeout', 'The fast browser goal ran out of time.')
      if (idleActions >= idleLimit) {
        this.#trace({ taskId: request.taskId, runId: this.#options.runId, sessionId, goal: request.goal, step: actions, stateHash: previousFingerprint, candidateCount: 0, decisionMs: 0, outcome: 'escalated' })
        return finish('escalate', lastObstruction
          ? `${lastObstruction} Nothing has changed since, so the main model decides.`
          : 'The page did not change after repeated actions, so the main model decides.')
      }

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

      const stepStartedAt = now()
      if (setAsideState !== previousFingerprint) { setAside.clear(); setAsideIds.clear() }
      const candidates = buildActionCandidates(snapshot.snapshot, request.goal, {
        input: request.input,
        keys: request.keys,
        control,
        waitBudget: Math.max(0, waitBudget - waits),
      }).filter(candidate => {
        if (!setAside.has(candidate.description)) return true
        setAsideIds.set(candidate.id, setAside.get(candidate.description) || lastObstruction)
        return false
      })
      const stateHash = browserStateFingerprint(snapshot.snapshot, snapshot.session)

      const state = buildJevState({ goal: request.goal, input: request.input, snapshot: snapshot.snapshot, session: snapshot.session, candidates, history, ...(textBeforeLastAction === undefined ? {} : { textBeforeLastAction }) })
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
        this.#trace({ taskId: request.taskId, runId: this.#options.runId, sessionId, goal: request.goal, step: actions, stateHash, candidateCount: candidates.length, decisionMs: failedMs, outcome: 'failed' })
        return finish('error', error instanceof Error ? error.message : 'The fast decision request failed.')
      }
      const decisionMsStep = now() - decisionStartedAt
      decisionMs += decisionMsStep
      ranked = rankCandidates(answers.next_action)
      const verdict = readVerdict(answers)
      const traceBase = {
        taskId: request.taskId, runId: this.#options.runId, sessionId, goal: request.goal, step: actions, stateHash, candidateCount: candidates.length,
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
      // The decision asked for a control this state already showed cannot be clicked.
      // Saying so is more useful than reporting that the action was not offered.
      const knownObstruction = verdict.action ? setAsideIds.get(verdict.action) : undefined
      if (knownObstruction) {
        this.#trace({ ...traceBase, outcome: 'escalated' })
        return finish('escalate', `${knownObstruction} That control cannot be clicked until the page changes, so the main model decides.`)
      }

      // A sustained interaction may take a few thin choices in a row; past that,
      // continuing would be guessing rather than controlling.
      const uncertainBudget = control && uncertainRun < uncertainRunLimit ? Math.max(0, uncertainRunLimit * 2 - uncertainUsed) : 0
      const outcome = decideBrowserFastStep(verdict, candidates, this.#config, { allowMutations: request.allowMutations, uncertainBudget, maxRepeat: request.maxRepeat })
      if (outcome.kind === 'completed') {
        this.#trace({ ...traceBase, outcome: 'completed' })
        return finish('completed')
      }
      if (outcome.kind === 'escalate') {
        this.#trace({ ...traceBase, outcome: 'escalated' })
        return finish('escalate', outcome.reason)
      }

      // A beat touches nothing, so it is budgeted on its own and does not spend an
      // action step: waiting must never be a way to lose the goal's step budget.
      if (outcome.candidate.waitMs !== undefined) {
        const waitedMs = outcome.candidate.waitMs
        await wait(waitedMs, signal)
        waits += 1
        try {
          snapshot = await this.#host.snapshot(request.taskId, sessionId, false)
          sessionId = snapshot.session.id
        } catch (error) {
          this.#trace({ ...traceBase, waitedMs, outcome: 'failed' })
          return finish('error', error instanceof Error ? error.message : 'The browser session could not be inspected.')
        }
        previousFingerprint = browserStateFingerprint(snapshot.snapshot, snapshot.session)
        steps.push({ action: outcome.candidate.id, description: outcome.candidate.description, probability: outcome.probability, url: snapshot.session.url })
        this.#trace({ ...traceBase, waitedMs, outcome: 'waited' })
        continue
      }

      const performed = await perform(outcome.candidate, { probability: outcome.probability, uncertain: outcome.uncertain, trace: traceBase, stateHash, candidateCount: candidates.length, decisionMs: decisionMsStep, stepStartedAt })
      if (performed) {
        if (typeof performed === 'string') return finish('error', performed)
        // The control could not be clicked as observed. Set it aside for this state,
        // look again, and decide among what is actually actionable: on a live page a
        // control moves or gets covered constantly, and that is not a reason to end
        // the session. The stall rule and the caller's budget still bound the loop.
        setAside.set(performed.description, performed.unavailable)
        setAsideState = stateHash
        blockedSteps += 1
        actions += 1
        try {
          snapshot = await this.#host.snapshot(request.taskId, sessionId, false)
          sessionId = snapshot.session.id
        } catch (error) {
          return finish('error', error instanceof Error ? error.message : 'The browser session could not be inspected.')
        }
        previousFingerprint = browserStateFingerprint(snapshot.snapshot, snapshot.session)
        continue
      }

      // Repetition is one decision covering several actions. Each repeat is matched
      // by what the control is — its role and name — against a freshly rebuilt
      // candidate set, so a re-rendered control is followed to its new node rather
      // than clicked at a ref that now points somewhere else. A control that is
      // gone, or a page that stopped responding, ends the run of repeats.
      let repeated = 1
      while (repeated < (outcome.repeat ?? 1) && actions < maxSteps) {
        if (signal?.aborted) return finish('escalate', 'The fast browser goal was cancelled.')
        if (now() - startedAt > timeoutMs) return finish('timeout', 'The fast browser goal ran out of time.')
        const offered = buildActionCandidates(snapshot.snapshot, request.goal, {
          input: request.input,
          keys: request.keys,
          control,
          waitBudget: Math.max(0, waitBudget - waits),
        }).find(candidate => candidate.action && candidate.description === outcome.candidate.description)
        if (!offered) break
        const beforeFingerprint = previousFingerprint
        const repeatOutcome = await perform(offered, { probability: outcome.probability, uncertain: outcome.uncertain, trace: traceBase, stateHash, candidateCount: candidates.length, decisionMs: 0, stepStartedAt: now() })
        if (repeatOutcome) return typeof repeatOutcome === 'string' ? finish('error', repeatOutcome) : finish('escalate', repeatOutcome.unavailable)
        repeated += 1
        // Outside sustained control, a repeat that changed nothing is not progress.
        if (!control && previousFingerprint === beforeFingerprint) break
      }
    }

    return finish('max_steps', 'The fast browser goal reached its step limit.')
  }
}

/**
 * Why acceleration did or did not resolve, which is the one thing Settings cannot
 * answer for a run: the row reports what the window's configuration says, while a
 * run resolves against the settings it was actually given.
 */
export function accelerationStatus(settings: Pick<Settings, 'providers'> & { computerUseAcceleration?: Settings['computerUseAcceleration'] }): { resolved: boolean; reason: string; providers: number; routable: string[] } {
  const providers = settings.providers || []
  const routable = providers
    .filter(provider => decisionRouteForEndpoint(provider.endpoint))
    .map(provider => `${provider.id}:${provider.enabled === false ? 'disabled' : String(provider.apiKey || '').trim() ? 'keyed' : 'no-key'}`)
  const config = settings.computerUseAcceleration
  if (config?.enabled === false) return { resolved: false, reason: 'acceleration is switched off in settings', providers: providers.length, routable }
  const resolved = resolveComputerUseAcceleration(settings)
  if (resolved) return { resolved: true, reason: `using ${resolved.providerName} · ${resolved.model}`, providers: providers.length, routable }
  if (!providers.length) return { resolved: false, reason: 'the settings this run received carry no providers at all', providers: 0, routable }
  const named = String(config?.provider || config?.providerId || '').trim()
  const keyed = routable.filter(entry => entry.endsWith(':keyed'))
  if (!keyed.length) return { resolved: false, reason: 'no configured provider reaches a decision service with a credential', providers: providers.length, routable }
  return { resolved: false, reason: `the settings name ${named || 'no service'} and no provider this run received can serve it`, providers: providers.length, routable }
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
/** One entry of a parallel batch: the same knobs as a single call, plus its session. */
function goalEntrySchema() {
  return Type.Object({
    browser_session_id: Type.String({ description: 'The Browser Use session this goal drives. Each goal in a batch needs a different one.' }),
    goal: Type.String({ minLength: 1, maxLength: 2_000 }),
    input: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 20_000 }))),
    keys: Type.Optional(Type.Array(Type.String({ maxLength: 20 }), { maxItems: 12 })),
    control: Type.Optional(Type.Boolean()),
    sustained: Type.Optional(Type.Boolean()),
    max_duration_s: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
    deadline_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
    wait_budget: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })),
    max_stall_steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    plan: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 12 })),
    cycles: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
    max_repeat: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
    max_uncertain_steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
    allow_mutations: Type.Optional(Type.Boolean()),
    max_steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
  }, { additionalProperties: false })
}

/** How many subgoals one call may advance at once. */
export const BROWSER_FAST_PARALLEL_LIMIT = 3

/** Runs independent goals concurrently, keeping their results in the order given. */
export async function runGoalBatch<T, R>(items: T[], concurrency: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: workers }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await run(items[index])
    }
  }))
  return results
}

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
      description: 'Delegate one narrow browser subgoal that can usually be completed by obvious UI actions, such as navigating to an obvious page, searching, opening a menu, choosing an obvious result, or moving through a predictable sequence. A fast decision model then picks one offered action at a time from a fresh snapshot and repeats while its confidence stays high. Pass exact values that must be typed through input, and keys the interface needs through keys. The fast model never writes text, invents a URL, or creates an action of its own, and it cannot see pixels: for a canvas, a map, or a chart, read the screenshot yourself and describe the state that matters through input. It returns completed with the final page snapshot, or escalate with the current snapshot when the next step stops being obvious. Keep the goal short — one outcome, not a rule system: long multi-branch instructions measured ~4x slower per decision and less accurate. The normal Browser Use tools remain authoritative whenever this escalates or is unavailable. When the page keeps moving on its own clock, open a sustained session instead of calling again and again: each return costs a full main-model turn, which is usually more than the work itself.',
      parameters: Type.Object({
        browser_session_id: Type.Optional(Type.String({ description: 'A task-owned Browser Use session id. Absent means the most recent session for this task.' })),
        goal: Type.Optional(Type.String({
          minLength: 1,
          maxLength: 2_000,
          description: 'A narrow browser subgoal, stated as one outcome. Do not list individual clicks, and prefer a control that encapsulates the logic over a paragraph of rules. Omit it when using goals.',
        })),
        goals: Type.Optional(Type.Array(goalEntrySchema(), {
          minItems: 1,
          maxItems: 4,
          description: 'Independent subgoals to advance at the same time, each on its own Browser Use session (open the tabs first). Use this when the work does not depend on itself — several pages to read, several records to update — because the loops then overlap instead of queueing. Each goal must name a different browser_session_id.',
        })),
        input: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 20_000 }), {
          description: 'Exact values you have already determined that may be typed into UI fields, keyed by the name used in the goal. This is also how a canvas or graphical page is described: the fast model cannot see pixels, so read the state yourself from a screenshot and pass what matters here as text.',
        })),
        keys: Type.Optional(Type.Array(Type.String({ maxLength: 20 }), {
          maxItems: 12,
          description: 'Keys this interface needs, offered as actions: ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Enter, Tab, Escape, Backspace, Space, or one character. Required for a canvas, a game, a terminal, or any shortcut-driven interface, where no clickable control exists.',
        })),
        plan: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), {
          maxItems: 12,
          description: 'Steps you have already determined, in order, each naming the control it acts on. The harness runs them at browser speed with a fresh snapshot per step and no decision in between, and stops if a named control is gone. Use this for work you can specify but the fast model cannot compute — an ordered set of clicks, a wizard, a loop over the same two controls — and keep the decision model for choosing, not calculating.',
        })),
        cycles: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: 'How many times to run plan before deciding normally again. Defaults to once.' })),
        max_repeat: Type.Optional(Type.Integer({
          minimum: 1,
          maximum: 12,
          description: 'How many times one decision may repeat its chosen action before asking again. Repetition is what turns a long paging, scrolling, or stepping run into one decision.',
        })),
        sustained: Type.Optional(Type.Boolean({
          description: 'Open a control session for a task whose state advances on its own clock and whose every action has a deadline — a live dashboard, a simulator, a real-time game, a drag or hold interaction. The loop then runs until the task is done, something is in the way, or your own budget runs out, instead of returning every few steps. Use it whenever the task keeps moving while the model is not looking, because every return costs a full main-model turn.',
        })),
        max_duration_s: Type.Optional(Type.Integer({
          minimum: 1,
          maximum: 600,
          description: 'How long a sustained session may run before it returns anyway. Defaults to 300 seconds. The call blocks the model turn for as long as it runs.',
        })),
        max_stall_steps: Type.Optional(Type.Integer({
          minimum: 1,
          maximum: 200,
          description: 'With sustained: how many consecutive steps that changed nothing are allowed before the session hands back. Defaults to 12.',
        })),
        wait_budget: Type.Optional(Type.Integer({
          minimum: 0,
          maximum: 200,
          description: 'How many beats the loop may take in one call. A beat never spends a step, and it is never counted as a stall, so it is how the loop keeps its own rhythm against a page that is still catching up.',
        })),
        deadline_ms: Type.Optional(Type.Integer({
          minimum: 1,
          maximum: 600_000,
          description: 'Your per-step deadline. Every step reports whether it met it and the result reports the hit rate and the latency distribution, which is what makes a real-time requirement measurable instead of a claim.',
        })),
        max_uncertain_steps: Type.Optional(Type.Integer({
          minimum: 1,
          maximum: 12,
          description: 'With control: how many thin-but-plausible choices may run in a row before handing back. Raise it for a page that offers the same action several times over, which keeps any single option from looking certain.',
        })),
        control: Type.Optional(Type.Boolean({
          description: 'Set for a sustained interaction — a game, a canvas, a terminal, a series of identical steps — where the page may legitimately not change between actions and repeating one action is progress. It lets the fast loop carry on for thin-but-plausible choices and through unchanged pages, under bounded budgets, instead of handing back.',
        })),
        allow_mutations: Type.Optional(Type.Boolean({
          description: 'Set only when the user’s request already authorizes the external side effect, such as sending or submitting something they asked to send.',
        })),
        max_steps: Type.Optional(Type.Integer({
          minimum: 1,
          maximum: 1_000,
          description: 'How many actions this call may perform. Defaults to the configured limit, or 600 in a sustained session. A sustained session treats it as a budget, not as a hand-back.',
        })),
      }, { additionalProperties: false }),
      execute: async (_id, args, signal) => {
        // One response shape for both forms, so the parallel result and a single
        // result reach the model the same way.
        const respond = (details: BrowserFastResult | { status: 'parallel'; goals: number; concurrency: number; elapsed_ms: number; results: BrowserFastResult[] }) =>
          ({ content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }], details })
        const run = (request: BrowserFastRequest) => new BrowserFastExecutor(host, decisions, acceleration, { runId: options.runId, onTrace: options.onTrace }).execute(request, signal)
        const shared = {
          input: args.input, keys: declaredKeys(args.keys), control: args.control, sustained: args.sustained,
          maxRepeat: args.max_repeat, maxUncertainSteps: args.max_uncertain_steps, allowMutations: args.allow_mutations,
          maxSteps: args.max_steps, plan: args.plan, cycles: args.cycles,
          maxDurationMs: args.max_duration_s === undefined ? undefined : args.max_duration_s * 1_000,
          maxStallSteps: args.max_stall_steps, waitBudget: args.wait_budget, deadlineMs: args.deadline_ms,
        }
        const batch = Array.isArray(args.goals) && args.goals.length ? args.goals : undefined
        if (batch) {
          // Two loops on one tab would interleave their actions, and Chrome only
          // allows one debugger per tab anyway. Distinct explicit sessions are the
          // caller's statement that these goals are independent.
          const sessions = batch.map(entry => String(entry.browser_session_id || '').trim())
          if (sessions.some(value => !value)) throw Error('Each parallel goal needs its own browser_session_id. Open the tabs first, then name one per goal.')
          if (new Set(sessions).size !== sessions.length) throw Error('Parallel goals must each drive a different Chrome tab.')
          const startedAt = Date.now()
          const results = await runGoalBatch(batch, BROWSER_FAST_PARALLEL_LIMIT, entry => run({
            taskId,
            browserSessionId: entry.browser_session_id,
            goal: entry.goal,
            input: entry.input,
            keys: declaredKeys(entry.keys),
            control: entry.control,
            sustained: entry.sustained,
            maxDurationMs: entry.max_duration_s === undefined ? undefined : entry.max_duration_s * 1_000,
            deadlineMs: entry.deadline_ms,
            plan: entry.plan,
            cycles: entry.cycles,
            maxRepeat: entry.max_repeat,
            maxUncertainSteps: entry.max_uncertain_steps,
            maxStallSteps: entry.max_stall_steps,
            waitBudget: entry.wait_budget,
            allowMutations: entry.allow_mutations,
            maxSteps: entry.max_steps,
          }))
          return respond({ status: 'parallel', goals: batch.length, concurrency: Math.min(BROWSER_FAST_PARALLEL_LIMIT, batch.length), elapsed_ms: Date.now() - startedAt, results })
        }
        if (!args.goal) throw Error('State one browser subgoal, or pass goals to advance several at once.')
        return respond(await run({ taskId, browserSessionId: args.browser_session_id, goal: args.goal, ...shared }))
      },
    }),
  ]
}
