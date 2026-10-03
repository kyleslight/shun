import type { AgentRequest, TaskGoal } from '../shared.ts'
import { normalizeTaskGoal } from '../shared.ts'
import { runUtilityPrompt } from './agent-runtime.ts'

/**
 * A goal the person stated in their own words, read out of the conversation.
 *
 * Nobody fills in a form to say what "finished" means: they say it while watching the work
 * ("没拿到奖金就别停下来", "报告写进 reports/x.md 之前不算完"). So the product reads the message and
 * writes down the structure itself — this is a model call, the same shape as the task title, not a
 * pattern over wording. A pattern cannot tell a requirement from a complaint about the work; a
 * reader can.
 *
 * What comes back is a proposal, not an authority: it is validated like any other goal
 * (`normalizeTaskGoal`), it is shown to the person, and it can be corrected or taken back. The
 * enforcement is still the filesystem and exit codes.
 */

/**
 * The instruction, and — just as important — when to say nothing.
 *
 * The trigger is deliberately narrow. An extractor that records a goal every time somebody talks
 * about the work turns ordinary conversation into a contract, so the default answer is "nothing",
 * and every exception has to be earned: a standing requirement for the task as a whole, in the
 * person's own words, with checks only where they named something a machine can decide.
 */
export function goalExtractionPrompt(message: string, current?: TaskGoal) {
  const lines = [
    'You decide one thing about the user message below: is it telling this task what "finished" means, or that the task must not stop?',
    '',
    'Record a goal ONLY when the message states a standing requirement for the task as a whole — what must be true when the work is done, or that the work must continue until something holds.',
    'Return {"goal": null} for everything else, including: a request for one next action, a question, an answer to a question, a correction, an acknowledgement, praise or complaint about how the work is going, chit-chat, a restatement of a requirement already recorded below, or anything you are not sure about. When in doubt, {"goal": null}.',
    '',
    'The objective is the person\'s own requirement in one short sentence, in the language they used. Never invent work they did not ask for, never strengthen or narrow what they said, and never treat something the assistant said as the person\'s requirement.',
    '',
    'A check must be decidable on this machine without asking anybody: a path that must exist, a path that must be gone, or a command that must exit 0.',
    'Record a check ONLY when the message itself names it. Never invent a path or a command to make a goal checkable — a goal with an objective and no check is the normal result of "do not stop until this holds", and it means exactly that.',
    'Return {"clear": true} when the person is taking a recorded requirement back, or saying that the recorded conditions no longer apply.',
    '',
    'Return strict JSON only, in one of these three shapes, with no other text:',
    '{"goal": {"objective": "...", "checks": [{"kind": "file", "path": "path"}]}}',
    '{"goal": {"objective": "...", "checks": [{"kind": "absent", "path": "path"}]}}',
    '{"goal": {"objective": "...", "checks": [{"kind": "command", "command": "cmd"}]}}',
    '{"goal": null}',
    '{"clear": true}',
    '',
    '<user_message>',
    message,
    '</user_message>',
  ]
  if (current) {
    lines.push(
      '<already_recorded>',
      JSON.stringify({
        objective: current.objective,
        checks: current.checks.map(check => ({ kind: check.kind, value: check.kind === 'command' ? check.command : check.path })),
      }),
      '</already_recorded>',
    )
  }
  return lines.join('\n')
}

export type ExtractedGoal =
  | { kind: 'goal'; goal: TaskGoal }
  | { kind: 'clear' }
  | { kind: 'none' }

function strictJson(raw: string) {
  const text = String(raw || '').trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced ? fenced[1] : text).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** What the reader said, or nothing usable. A malformed answer is not a goal. */
export function parseExtractedGoal(raw: string): ExtractedGoal {
  const parsed = strictJson(raw)
  if (!parsed) return { kind: 'none' }
  if (parsed.clear === true) return { kind: 'clear' }
  if (parsed.goal === null || parsed.goal === undefined) return { kind: 'none' }
  const goal = normalizeTaskGoal(parsed.goal)
  return goal ? { kind: 'goal', goal } : { kind: 'none' }
}

/**
 * Read the person's message for a goal. Costs one small model call, made in parallel with the run
 * so nothing waits on it: a condition written while the run is working binds that run.
 */
export async function extractTaskGoal(
  req: AgentRequest,
  signal: AbortSignal,
  agentDir: string,
  cwd?: string,
  current?: TaskGoal,
): Promise<ExtractedGoal> {
  const message = req.text.trim().slice(0, 8_000)
  if (!message) return { kind: 'none' }
  const raw = await runUtilityPrompt({
    ...req,
    settings: { ...req.settings, temperature: Math.min(req.settings.temperature, 0.2), maxTokens: Math.min(req.settings.maxTokens, 400) },
  }, goalExtractionPrompt(message, current), signal, { agentDir, cwd })
  return parseExtractedGoal(raw)
}
