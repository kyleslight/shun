import { execFile as execFileCallback } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { PrepareNextTurnContext } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { defaultGoalContinuations, maxGoalContinuations, type TaskGoal, type TaskGoalCheck } from '../shared.ts'
import type { OutcomePolicy, OutcomeVerdict } from './outcome-policy.ts'
import { workspaceCommandEnvironment } from './shell-tool.ts'

/**
 * A goal the person declared, held to.
 *
 * A run ends when it stops calling tools, and what it says in that turn is prose — so a run
 * that concludes mid-task and a run that concludes because the work is done look identical
 * to the loop. Nothing in the transcript distinguishes them, and asking the model which one
 * it is asks the least reliable layer of the system about the one thing it must not guess at.
 *
 * What does distinguish them is a check the person wrote down before the work started: a file
 * that must exist, a file that must be gone, a command that must exit 0. Those are decided by
 * the filesystem and the exit status, on the same machine, in the same environment the run's
 * own commands ran in. So this policy reads the goal's checks when a turn concludes, and when
 * one of them is unmet it sends the run back to work with the failing check in hand — bounded
 * by the goal's continuation budget, and silent the moment the checks pass.
 *
 * It is not an agent: no conversation of its own, no model call, no tool dispatch, no
 * capability change. It cannot conclude anything the person did not write down, which is the
 * whole reason a failed check is evidence rather than an opinion.
 */

export type GoalGuidanceLanguage = 'en' | 'zh-CN'

export type GoalLimits = {
  /** Wall clock one check may take. A check that hangs must not hold the run open. */
  checkTimeoutMs: number
  /** Output kept from a command check, which is the most a failing check is worth showing. */
  evidenceCharacters: number
}

export const defaultGoalLimits: GoalLimits = {
  checkTimeoutMs: 120_000,
  evidenceCharacters: 600,
}

/** What one check found. `observed` is a fact, in the words a tool result is stated in. */
export type GoalCheckResult = {
  check: TaskGoalCheck
  passed: boolean
  observed: string
}

const execFile = promisify(execFileCallback)

function bounded(value: unknown, limit: number) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `…${text.slice(-limit)}` : text
}

async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Run one check in the task's workspace.
 *
 * A command check runs through the platform shell with the same environment the run's own
 * shell commands got — the task-root `.venv`, `node_modules/.bin`, the desktop user's
 * inherited environment — because a completion condition that resolves differently from the
 * work it judges is a second way to be wrong. Its output is bounded: a failing check is worth
 * its last few lines, not a build log.
 */
export async function runGoalCheck(cwd: string, check: TaskGoalCheck, limits: GoalLimits, signal?: AbortSignal): Promise<GoalCheckResult> {
  if (check.kind === 'file' || check.kind === 'absent') {
    const present = await exists(resolve(cwd, check.path))
    return {
      check,
      passed: check.kind === 'file' ? present : !present,
      observed: present ? 'present' : 'missing',
    }
  }
  try {
    const { stdout, stderr } = await execFile(check.command, {
      cwd,
      env: workspaceCommandEnvironment(cwd, process.env).env,
      timeout: limits.checkTimeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
      shell: true,
      windowsHide: true,
      ...(signal ? { signal } : {}),
    }) as unknown as { stdout: string; stderr: string }
    const output = bounded(`${stdout || ''}${stderr || ''}`, limits.evidenceCharacters)
    return { check, passed: true, observed: output ? `exit 0: ${output}` : 'exit 0' }
  } catch (error) {
    const failure = error as { code?: unknown; killed?: boolean; signal?: unknown; stdout?: unknown; stderr?: unknown }
    const status = failure.killed || failure.signal === 'SIGTERM'
      ? `no exit within ${Math.round(limits.checkTimeoutMs / 1000)}s`
      : typeof failure.code === 'number'
        ? `exit ${failure.code}`
        : typeof failure.code === 'string'
          ? failure.code
          : 'did not run'
    const output = bounded(`${failure.stdout || ''}${failure.stderr || ''}`, limits.evidenceCharacters)
    return { check, passed: false, observed: output ? `${status}: ${output}` : status }
  }
}

/** How a failing check is stated to the run, in the language the run is being held in. */
function checkLine(language: GoalGuidanceLanguage, result: GoalCheckResult) {
  const zh = language === 'zh-CN'
  const subject = result.check.kind === 'command' ? result.check.command : result.check.path
  const expectation = result.check.kind === 'file'
    ? (zh ? '必须存在' : 'must exist')
    : result.check.kind === 'absent'
      ? (zh ? '必须不存在' : 'must not exist')
      : (zh ? '必须以退出码 0 结束' : 'must exit 0')
  const observed = result.check.kind === 'command' && result.passed
    ? result.observed
    : zh
      ? { present: '存在', missing: '不存在' }[result.observed] || result.observed
      : result.observed
  return `- ${subject} ${expectation} — ${observed}`
}

/**
 * The message that sends a run back to work.
 *
 * It names the goal, the check that failed and what was observed, so the run does not have to
 * re-derive what is missing — a run sent back without the gap has to re-read its own
 * transcript to find it, and usually restates the plan instead.
 */
function continuationGuidance(
  language: GoalGuidanceLanguage,
  objective: string,
  failing: GoalCheckResult[],
  spent: number,
  budget: number,
) {
  const lines = failing.map(result => checkLine(language, result))
  return language === 'zh-CN'
    ? [
        '这个任务声明的完成条件还没有成立，所以现在不能结束。',
        `目标：${objective}`,
        '未通过的条件：',
        ...lines,
        `（第 ${spent}/${budget} 次回到工作上。）`,
        '不要重述计划，也不要总结进展。执行下一个能改变上述条件的动作。如果某个条件在当前环境下确实无法达成，说明真正的阻塞点是什么，而不是宣布工作已经完成。',
      ].join('\n')
    : [
        'The completion conditions declared for this task do not hold yet, so this run cannot finish here.',
        `Objective: ${objective}`,
        'Conditions that did not pass:',
        ...lines,
        `(Continuation ${spent}/${budget}.)`,
        'Do not restate the plan and do not summarize progress. Take the next action that could change the conditions above. If one of them genuinely cannot be met in this environment, say what actually blocks it instead of declaring the work finished.',
      ].join('\n')
}

export type GoalTelemetry = {
  declaredChecks: number
  /** Times the goal was read against the workspace, which is once per concluding turn. */
  evaluations: number
  continuations: number
  budget: number
  /** Checks still failing when the run last looked, in the order they were declared. */
  failingChecks: string[]
  status: 'not-checked' | 'met' | 'unmet' | 'exhausted'
  durationMs: number
  finalStopReason: string
}

export type GoalPolicyOptions = {
  goal: TaskGoal
  /** The task's workspace: where a check resolves paths and runs commands. */
  cwd: string
  language?: GoalGuidanceLanguage
  limits?: Partial<GoalLimits>
  /** The run's own signal, so a check stops when the run it belongs to does. */
  signal?: AbortSignal
  /**
   * Said out loud while a command check runs. A declared check can take as long as the command
   * it runs, and the run is silent for that long — the one thing a person reading the feed must
   * not be shown is a stall that is really work. Neither fires for path checks, which are
   * decided before anything could be drawn.
   */
  onCheckStart?: () => void
  onCheckEnd?: () => void
  onFinish?: (telemetry: GoalTelemetry) => void
}

type AssistantBlock = { type?: string }

function assistantBlocks(turn: PrepareNextTurnContext): AssistantBlock[] {
  const message = turn?.message as { content?: unknown } | undefined
  return Array.isArray(message?.content) ? message.content as AssistantBlock[] : []
}

export class GoalPolicy implements OutcomePolicy {
  private readonly goal: TaskGoal
  private readonly cwd: string
  private readonly language: GoalGuidanceLanguage
  private readonly limits: GoalLimits
  private readonly onCheckStart?: () => void
  private readonly onCheckEnd?: () => void
  private readonly onFinish?: (telemetry: GoalTelemetry) => void
  private readonly startedAt = Date.now()
  private readonly abort = new AbortController()

  private evaluations = 0
  private continuations = 0
  private failingChecks: string[] = []
  private status: GoalTelemetry['status'] = 'not-checked'
  private finalStopReason = 'unknown'
  private finished = false

  constructor(options: GoalPolicyOptions) {
    this.goal = options.goal
    this.cwd = options.cwd
    this.language = options.language || 'en'
    this.limits = { ...defaultGoalLimits, ...options.limits }
    this.onCheckStart = options.onCheckStart
    this.onCheckEnd = options.onCheckEnd
    this.onFinish = options.onFinish
    options.signal?.addEventListener('abort', () => this.abort.abort(), { once: true })
  }

  observe(event: AgentSessionEvent) {
    if (this.finished) return
    if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason) this.finalStopReason = event.message.stopReason
  }

  /**
   * The decision about a turn that produced no tool call, which is the only shape a conclusion
   * can have. A run that is still calling tools is working, and work in progress is not
   * something to interrupt.
   */
  evaluate(turn: PrepareNextTurnContext): Promise<OutcomeVerdict> | OutcomeVerdict {
    if (assistantBlocks(turn).some(block => block.type === 'toolCall')) return { status: 'accept' }
    return this.judge()
  }

  telemetry(): GoalTelemetry {
    return {
      declaredChecks: this.goal.checks.length,
      evaluations: this.evaluations,
      continuations: this.continuations,
      budget: this.budget,
      failingChecks: [...this.failingChecks],
      status: this.status,
      durationMs: Date.now() - this.startedAt,
      finalStopReason: this.finalStopReason,
    }
  }

  /** Close the run's accounting, exactly once, and stop any check still running for it. */
  finish(): GoalTelemetry {
    if (this.finished) return this.telemetry()
    this.finished = true
    this.abort.abort()
    const telemetry = this.telemetry()
    this.onFinish?.(telemetry)
    return telemetry
  }

  /** The continuations this goal may spend, from the person's number or the product default. */
  private get budget() {
    const declared = Number(this.goal.maxContinuations)
    if (!Number.isFinite(declared)) return defaultGoalContinuations
    return Math.max(1, Math.min(maxGoalContinuations, Math.trunc(declared)))
  }

  private async judge(): Promise<OutcomeVerdict> {
    // A goal with no checks enforces nothing, and inventing a signal for it here would be the
    // guessing this exists to avoid. The composer refuses such a goal when it is typed; this
    // is the belt to that pair of braces.
    if (!this.goal.checks.length) {
      this.status = 'not-checked'
      return { status: 'accept' }
    }
    this.evaluations++
    const reportState = this.goal.checks.some(check => check.kind === 'command')
    if (reportState) this.onCheckStart?.()
    let results: GoalCheckResult[]
    try {
      results = await Promise.all(this.goal.checks.map(check => runGoalCheck(this.cwd, check, this.limits, this.abort.signal)))
    } finally {
      if (reportState) this.onCheckEnd?.()
    }
    const failing = results.filter(result => !result.passed)
    if (!failing.length) {
      this.status = 'met'
      this.failingChecks = []
      return { status: 'accept' }
    }
    this.failingChecks = failing.map(result => result.check.id)
    if (this.continuations >= this.budget) {
      this.status = 'exhausted'
      return { status: 'accept' }
    }
    this.continuations++
    this.status = 'unmet'
    return { status: 'continue', feedback: continuationGuidance(this.language, this.goal.objective, failing, this.continuations, this.budget) }
  }
}
