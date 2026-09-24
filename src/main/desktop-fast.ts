import { Type } from 'typebox'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Settings } from '../shared.ts'
import type { DesktopActionRequest, DesktopControlService, DesktopElement, DesktopElementTree } from './desktop-control.ts'
import { OpenRouterJevClient, resolveComputerUseAcceleration, type DecisionAnswer, type DecisionClient, type DecisionQuestion } from './jev-client.ts'

/**
 * Bounded fast desktop use.
 *
 * The main model plans, writes text, and decides what is worth doing. This layer
 * only chooses among actions the element tree already offers, one action per
 * reading, and hands control back the moment the next step stops being obvious.
 * It exists because a desktop sequence is otherwise a round trip and a screenshot
 * per step through the expensive model, and because the element tree is exactly
 * the kind of state a decision model answers questions against.
 *
 * Two things keep it from being used for its own sake: it is registered only when
 * a decision service already exists (without one, the plain desktop tools are the
 * whole product, unchanged), and it is answerable only about a subgoal whose next
 * step the reading itself supports. Everything else escalates.
 */

/** A control whose name says it commits something rather than moving around. */
const CONSEQUENTIAL_NAME = /(^|[^\p{L}])(send|submit|post|publish|delete|remove|destroy|discard|purchase|buy|pay|checkout|confirm|authorize|approve|merge|revoke|deactivate|unsubscribe|withdraw|transfer|upload|deploy|install|quit)([^\p{L}]|$)/iu
/**
 * A value, a one-time code, or a payment detail is never read into the state a
 * decision sees, and never enumerated as something to type: a password field's
 * contents must not travel through the decision layer at all.
 */
const SENSITIVE_NAME = /(password|passwd|passcode|secret|token|api[-_ ]?key|otp|one[-_ ]?time|verification[-_ ]?code|recovery[-_ ]?code|cvv|cvc|card|payment|iban|ssn|pin|seed|mnemonic|private[-_ ]?key)/i
const SECURE_ROLE = /Secure/i

/** The reading is what a decision is answerable against, so it is bounded like one. */
const maximumElements = 120
const maximumValueChars = 120
const maximumHistory = 4
/** A step that leaves the reading identical is not progress, and enough of them is a wall. */
const maximumStalledSteps = 2

export type DesktopCandidate = {
  id: string
  description: string
  /** Absent only for the escalate candidate: the decision selects, it never authors an action. */
  request?: DesktopActionRequest
  ref?: string
  consequential: boolean
  reversible: boolean
}

export type DesktopFastTraceStep = {
  step: number
  outcome: 'acted' | 'completed' | 'escalated' | 'stalled'
  action?: string
  detail?: string
}

export type DesktopFastResult = {
  status: 'completed' | 'escalate' | 'max_steps' | 'error'
  reason?: string
  steps: DesktopFastTraceStep[]
  tree?: DesktopElementTree
}

export type DesktopFastOptions = {
  service: DesktopControlService
  settings: Settings
  goal: string
  window?: string
  input?: Record<string, string>
  keys?: string[]
  maxSteps?: number
  allowMutations?: boolean
  signal?: AbortSignal
  client?: DecisionClient
  /** Injected for tests: how the loop asks for a decision. */
  decide?: (questions: Record<string, DecisionQuestion>, state: unknown, model: string) => Promise<Record<string, DecisionAnswer>>
}

/**
 What one control looks like to the decision layer. The value of a secure field or
 a field named like a secret is replaced before it ever reaches the state.
 */
function describeElement(element: DesktopElement) {
  const sensitive = SECURE_ROLE.test(element.role) || SENSITIVE_NAME.test(element.title) || SENSITIVE_NAME.test(element.description)
  return {
    ref: element.ref,
    role: element.role.replace(/^AX/, ''),
    name: (element.title || element.description || '').slice(0, maximumValueChars),
    value: sensitive ? '[redacted]' : element.value.slice(0, maximumValueChars),
    enabled: element.enabled,
    pressable: element.pressable,
    focused: element.focused,
  }
}

function fieldLabel(element: DesktopElement) {
  return (element.title || element.description || element.value || '').trim()
}

/**
 One candidate per obvious action the reading already offers. A field appears only
 when the caller supplied a value for it, because this layer never invents a value
 to type; a name that reads as a commitment is offered as consequential so the
 safety gates can stop it.
 */
export function buildDesktopCandidates(tree: DesktopElementTree, options: { input?: Record<string, string>, keys?: string[] } = {}): DesktopCandidate[] {
  const input = options.input || {}
  const supplied = Object.entries(input)
  const candidates: DesktopCandidate[] = []
  for (const element of tree.elements.slice(0, maximumElements)) {
    const label = fieldLabel(element)
    if (!element.enabled) continue
    if (element.pressable) {
      const consequential = CONSEQUENTIAL_NAME.test(label)
      candidates.push({
        id: `press:${element.ref}`,
        description: `Press ${element.role.replace(/^AX/, '')}${label ? ` "${label}"` : ''} (ref ${element.ref}).`,
        request: { action: 'press', window: tree.window.id, ref: element.ref },
        ref: element.ref,
        consequential,
        reversible: !consequential,
      })
    }
    if (/TextField|TextArea|ComboBox|SearchField/i.test(element.role)) {
      const match = supplied.find(([name]) => name && label.toLowerCase().includes(name.toLowerCase())) || (supplied.length === 1 ? supplied[0] : undefined)
      if (match) {
        const [name, value] = match
        candidates.push({
          id: `type:${element.ref}`,
          description: `Type the supplied value for "${name}" into the field${label ? ` "${label}"` : ''} (ref ${element.ref}).`,
          request: { action: 'set_value', window: tree.window.id, ref: element.ref, value },
          ref: element.ref,
          consequential: false,
          reversible: true,
        })
      }
    }
    if (/ScrollArea/i.test(element.role)) {
      candidates.push({
        id: `scroll-down:${element.ref}`,
        description: `Scroll down inside ${label ? `"${label}"` : 'the scrollable area'} (ref ${element.ref}).`,
        request: { action: 'scroll', window: tree.window.id, deltaY: -300 },
        ref: element.ref,
        consequential: false,
        reversible: true,
      })
      candidates.push({
        id: `scroll-up:${element.ref}`,
        description: `Scroll up inside ${label ? `"${label}"` : 'the scrollable area'} (ref ${element.ref}).`,
        request: { action: 'scroll', window: tree.window.id, deltaY: 300 },
        ref: element.ref,
        consequential: false,
        reversible: true,
      })
    }
  }
  for (const key of options.keys || []) {
    candidates.push({
      id: `key:${key}`,
      description: `Press the ${key} key.`,
      request: { action: 'key', window: tree.window.id, key },
      consequential: false,
      reversible: true,
    })
  }
  candidates.push({
    id: 'escalate',
    description: 'None of the other options fits this subgoal: the next step needs reasoning, the person’s intent, or something this reading does not carry. Return control to the main model.',
    consequential: false,
    reversible: true,
  })
  return candidates
}

/** One request carries every judgment, because the model evaluates them in parallel. */
export function buildDesktopQuestions(candidates: DesktopCandidate[], goal: string): Record<string, DecisionQuestion> {
  return {
    goal_completed: {
      type: 'noul',
      instructions: `The window in front of you already shows that this delegated subgoal has been reached: ${goal}\nJudge the outcome, not the route: a control that belongs to the goal being still on screen is not evidence that the goal is unfinished. Do not treat an intermediate step as the destination, and do not assume a step worked merely because it was attempted.`,
      criteria: {
        true: 'The reading already shows the outcome the subgoal asked for.',
        false: 'The outcome is not visible in this reading yet.',
      },
    },
    next_action: {
      type: 'choice',
      instructions: 'Which single offered action should happen now to make progress on the delegated subgoal? Choose exactly one offered option id. Choose "escalate" whenever the correct action needs reasoning or the person’s intent that this reading does not contain.',
      criteria: Object.fromEntries(candidates.map(candidate => [candidate.id, candidate.description])),
    },
    action_is_unambiguous: {
      type: 'noul',
      instructions: 'The selected next action is the one the delegated subgoal and this reading together support: applying the goal to what the controls show is enough to pick it out, and acting on it needs no intent, credentials, or window state that this reading does not carry. Other controls existing in the window does not by itself make this action ambiguous.',
      criteria: {
        true: 'The goal applied to what this reading shows is enough to pick this action out.',
        false: 'Acting needs intent, credentials, or window state this reading does not carry at all — or another offered action is supported by the goal just as directly.',
      },
    },
    action_changes_external_state: {
      type: 'noul',
      instructions: 'Executing the selected next action would create a consequence on the person’s behalf outside this window’s own state: sending a message or email, submitting an order or payment, deleting or publishing content, authorizing access, uploading a file, or changing account, permission, or security settings. Moving around the interface, opening or dismissing a control, scrolling, choosing an option, and typing a value into a field are preparation for the person’s own work and do not count.',
      criteria: {
        true: 'The action sends, submits, deletes, publishes, authorizes, uploads, pays, or changes account state.',
        false: 'The action moves around the interface, scrolls, opens or dismisses a control, chooses an option, or types a value.',
      },
    },
  }
}

/** What a reading looks like as a fingerprint: progress is the reading changing, never the action's name. */
export function readingFingerprint(tree: DesktopElementTree) {
  return tree.elements
    .map(element => `${element.role}|${element.title}|${element.value}|${element.focused}|${element.enabled}`)
    .join('\n')
    .slice(0, 20_000)
}

function readingState(tree: DesktopElementTree, goal: string, history: DesktopFastTraceStep[]) {
  return {
    subgoal: goal,
    window: { id: tree.window.id, app: tree.window.app, title: tree.window.title, width: tree.window.width, height: tree.window.height },
    controls: tree.elements.slice(0, maximumElements).map(describeElement),
    truncated: tree.truncated,
    recent_actions: history.slice(-maximumHistory).map(entry => `${entry.outcome}:${entry.action || ''}`),
  }
}

export async function runDesktopFast(options: DesktopFastOptions): Promise<DesktopFastResult> {
  const acceleration = resolveComputerUseAcceleration(options.settings)
  const steps: DesktopFastTraceStep[] = []
  if (!acceleration && !options.decide) {
    return { status: 'error', reason: 'No decision service is configured, so fast desktop steps cannot be offered.', steps }
  }
  const config = acceleration || { model: 'test', maxSteps: 4, minActionConfidence: 0.5, minReversibleConfidence: 0.4, maxMutationProbability: 0.5, minAmbiguityConfidence: 0.5, minCompletionConfidence: 0.5 }
  const client = options.client || new OpenRouterJevClient({ apiKey: acceleration?.apiKey || '', endpoint: acceleration?.endpoint, timeoutMs: Math.min(acceleration?.timeoutMs || 10_000, 10_000) })
  const ask = options.decide || ((questions: Record<string, DecisionQuestion>, state: unknown, model: string) =>
    client.decide({ model, state, questions }, options.signal).then(response => response.answers))
  const maxSteps = Math.max(1, Math.min(config.maxSteps || 4, options.maxSteps || config.maxSteps || 4))

  let stalled = 0
  for (let step = 1; step <= maxSteps; step += 1) {
    let tree: DesktopElementTree
    try {
      tree = await options.service.elements({ window: options.window, max: maximumElements }, options.signal)
    } catch (error) {
      return { status: 'error', reason: error instanceof Error ? error.message : String(error), steps }
    }
    const candidates = buildDesktopCandidates(tree, { input: options.input, keys: options.keys })
    const before = readingFingerprint(tree)
    let answers: Record<string, DecisionAnswer>
    try {
      answers = await ask(buildDesktopQuestions(candidates, options.goal), readingState(tree, options.goal, steps), config.model)
    } catch (error) {
      return { status: 'error', reason: `The decision service did not answer: ${error instanceof Error ? error.message : String(error)}`, steps }
    }
    const completed = answers.goal_completed
    if (completed?.type === 'noul' && completed.noul >= (config.minCompletionConfidence ?? 0.5)) {
      steps.push({ step, outcome: 'completed', detail: `goal_completed ${completed.noul}` })
      return { status: 'completed', reason: `The subgoal is satisfied at step ${step}.`, steps, tree }
    }
    const choice = answers.next_action
    if (!choice || choice.type !== 'choice') return { status: 'escalate', reason: 'The decision service returned no choice this layer can act on.', steps, tree }
    const candidate = candidates.find(item => item.id === choice.choice)
    if (!candidate) return { status: 'escalate', reason: `The decision selected ${choice.choice}, which was not offered for this window.`, steps, tree }
    if (candidate.id === 'escalate') return { status: 'escalate', reason: 'The next step needs the main model.', steps, tree }
    const unambiguous = answers.action_is_unambiguous
    if (unambiguous?.type !== 'noul' || unambiguous.noul < (config.minAmbiguityConfidence ?? 0.5)) {
      return { status: 'escalate', reason: 'The choice is not clearly supported by this reading, so the main model decides.', steps, tree }
    }
    const mutation = answers.action_changes_external_state
    if (mutation?.type !== 'noul') return { status: 'escalate', reason: 'The decision service did not say whether the action changes external state.', steps, tree }
    if ((candidate.consequential || mutation.noul >= (config.maxMutationProbability ?? 0.5)) && !options.allowMutations) {
      return { status: 'escalate', reason: `Press "${candidate.description}" may change something outside this window, which needs explicit authorization.`, steps, tree }
    }
    const floor = candidate.reversible ? (config.minReversibleConfidence ?? 0.4) : (config.minActionConfidence ?? 0.5)
    if ((choice.confidence ?? 0) < floor) {
      return { status: 'escalate', reason: `The choice was not confident enough (${(choice.confidence ?? 0).toFixed(2)} below ${floor}).`, steps, tree }
    }
    if (!candidate.request) return { status: 'escalate', reason: 'The selected action had no executable form.', steps, tree }
    try {
      await options.service.act(candidate.request, options.signal)
    } catch (error) {
      return { status: 'escalate', reason: error instanceof Error ? error.message : String(error), steps, tree }
    }
    steps.push({ step, outcome: 'acted', action: candidate.id, detail: `p=${(choice.probabilities?.[candidate.id] ?? 0).toFixed(2)} confidence=${(choice.confidence ?? 0).toFixed(2)}` })
    // Progress is the window responding, so a step that changes nothing counts
    // towards stopping rather than towards finishing.
    const after = await options.service.elements({ window: options.window, max: maximumElements }, options.signal).catch(() => undefined)
    const unchanged = after ? readingFingerprint(after) === before : false
    stalled = unchanged ? stalled + 1 : 0
    if (stalled > maximumStalledSteps) {
      steps.push({ step, outcome: 'stalled', detail: 'the window did not change' })
      return { status: 'escalate', reason: 'The window stopped responding to the actions this layer can take.', steps, tree: after }
    }
  }
  return { status: 'max_steps', reason: `Reached the ${maxSteps}-step limit without reaching the subgoal.`, steps }
}

export type DesktopFastToolOptions = {
  settings: Settings
  service: DesktopControlService
  onTrace?: (trace: { goal: string, status: string, steps: DesktopFastTraceStep[] }) => void
}

/**
 The tool is offered only where the pieces exist: a decision service already
 configured, and a driver that can read the element tree the decisions are made
 against. Without either, the plain desktop tools are the whole capability.
 */
export function desktopFastToolDefinitions(options: DesktopFastToolOptions): ToolDefinition[] {
  if (!resolveComputerUseAcceleration(options.settings)) return []
  if (!options.service.supportsElements()) return []
  return [
    defineTool({
      name: 'desktop_fast',
      label: 'Run fast desktop steps',
      description: 'Delegate one narrow desktop subgoal that can usually be completed by obvious controls — switching a setting, filling a small form with values you already have, moving through a predictable dialog. A fast decision model then chooses one offered action at a time from the window’s accessibility tree — no screenshot is involved, so this is cheap and works for text too small to read from an image — and repeats while its confidence stays high. It never authors an action of its own, never types a value you did not supply, and returns escalate as soon as the next step stops being obvious. Keep the goal short: one outcome, not a rule system. Pass values that must be typed through input, keyed by the control’s name. Use desktop_elements, desktop_snapshot and desktop_act directly for anything that needs the screen itself (a canvas, a game, a video), for a single obvious step, and for anything consequential. Those tools stay authoritative whenever this escalates or is unavailable.',
      parameters: Type.Object({
        goal: Type.String({ minLength: 1, maxLength: 800, description: 'A narrow subgoal, stated as one outcome on this window. Do not list individual clicks.' }),
        window: Type.Optional(Type.String({ maxLength: 60, description: 'An exact window id from desktop_windows, or omitted for the frontmost window.' })),
        input: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 4_000 }), { description: 'Exact values to type, keyed by the name of the control they belong to. A field with no supplied value is never filled in.' })),
        keys: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 12, description: 'Keys this interface needs, offered as actions (return, tab, escape, space, left, right, up, down, and the character keys).' })),
        max_steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'How many actions this call may take before handing back. Defaults to the configured step limit.' })),
        allow_mutations: Type.Optional(Type.Boolean({ description: 'Set only when the person already authorized the external side effect this subgoal performs.' })),
      }, { additionalProperties: false }),
      execute: async (_id, args, signal) => {
        const result = await runDesktopFast({
          service: options.service,
          settings: options.settings,
          goal: args.goal,
          window: args.window,
          input: args.input,
          keys: args.keys,
          maxSteps: args.max_steps,
          allowMutations: args.allow_mutations === true,
          signal,
        })
        options.onTrace?.({ goal: args.goal, status: result.status, steps: result.steps })
        // The tree is returned rather than a screenshot: this layer is answerable
        // about controls, and the caller can capture when it wants pixels.
        const details = { status: result.status, reason: result.reason, steps: result.steps }
        if (!result.tree) return { content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }], details }
        const { elements, ...metadata } = result.tree
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: result.status, reason: result.reason, steps: result.steps, window: metadata, controls: elements.slice(0, 40).map(describeElement) }, null, 2) }],
          details,
        }
      },
    }),
  ]
}
