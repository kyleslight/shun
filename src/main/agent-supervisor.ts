import { createHash } from 'node:crypto'
import type { PrepareNextTurnContext } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { OutcomePolicy, OutcomeVerdict } from './outcome-policy.ts'

/**
 * The supervisor is not an agent.
 *
 * It has no conversation, calls no model, plans nothing, and dispatches no tools.
 * It watches the run the model is already having, and it acts only on signals a
 * reader of the transcript could point at: output that repeats itself without
 * changing state, a tool call that fails identically again and again, and a
 * conclusion that rests on a limitation the run never tested.
 *
 * No signal, no intervention. Healthy runs — including long ones with very large
 * contexts — see nothing from this file but a bounded token window.
 */

/** Language of the guidance this supervisor sends back into the model's own run. */
export type SupervisorGuidanceLanguage = 'en' | 'zh-CN'

export type DegenerationReason = 'repetition-without-progress' | 'repeated-identical-failure'

/**
 * What the supervisor decided about a turn that produced no tool call, which is
 * the only shape a conclusion can have.
 */
export type SupervisorVerdict =
  | { action: 'accept' }
  | { action: 'challenge'; feedback: string }
  | { action: 'recover'; reason: DegenerationReason; feedback: string }

/** The smallest reaction to observable degeneration: guidance, delivered once. */
export type RecoveryDecision = { level: 'steer'; reason: DegenerationReason; feedback: string }

export type SupervisorLimits = {
  /** Tokens of streamed output and reasoning kept for the repetition profile. */
  windowTokens: number
  /** Streamed tokens required before repetition may be judged at all. */
  minTokens: number
  /** Share of the window the most repeated phrase must cover to be degenerate. */
  minRepetitionRatio: number
  /** Highest share of distinct tokens that still counts as degenerate. */
  maxUniqueRatio: number
  /** Identical failing tool calls in a row, with no progress between them. */
  repeatedFailureBurst: number
  /** Guidance messages one run may spend, at most one per episode. */
  maxSteers: number
  /** Suspicious-termination challenges one run may spend. */
  maxChallenges: number
  /** Tool calls a run must have made before a limitation claim is worth testing. */
  minToolCallsBeforeChallenge: number
}

/**
 * Deliberately conservative. A delayed detection costs a few thousand tokens; a
 * false positive interrupts a model that was doing nothing wrong. Thresholds are
 * instrumented through `LongRunTelemetry` and meant to be tuned from real sessions.
 */
export const defaultSupervisorLimits: SupervisorLimits = {
  windowTokens: 400,
  minTokens: 240,
  minRepetitionRatio: 0.5,
  maxUniqueRatio: 0.2,
  repeatedFailureBurst: 3,
  maxSteers: 3,
  maxChallenges: 1,
  minToolCallsBeforeChallenge: 2,
}

export type LongRunTelemetry = {
  /** Largest request the provider reported, in tokens: how large the context actually got. */
  peakContextTokens: number
  providerCalls: number
  compactionCount: number
  totalToolCalls: number
  toolErrors: number
  /** Times the same tool call repeated with no state change in between. */
  repeatedToolCallBursts: number
  degenerationDetections: number
  degenerationSteers: number
  /** Degeneration the steering ladder was not enough for; the level-2 signal. */
  degenerationEscalations: number
  supervisorChallenges: number
  challengeReason?: string
  /** Whether the challenged run resumed real work, or held the limitation with evidence. */
  challengeOutcome?: 'productive' | 'confirmed_limit'
  recoveryOutcome?: 'recovered' | 'persisted'
  durationMs: number
  finalStopReason: string
}

export type AgentSupervisorOptions = {
  limits?: SupervisorLimits
  language?: SupervisorGuidanceLanguage
  /** Called once, with the run's record, when the run is finished. */
  onFinish?: (telemetry: LongRunTelemetry) => void
}

/** Identical tool calls are judged by their arguments, not by their spelling. */
function toolSignature(toolName: string, args: unknown) {
  let serialized = ''
  try { serialized = JSON.stringify(args ?? null) } catch { serialized = String(args) }
  return `${toolName}:${createHash('sha1').update(serialized).digest('hex').slice(0, 16)}`
}

/** Words and CJK runs of the streamed text, which is all the repetition profile needs. */
export function streamTokens(value: string) {
  return value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

export type RepetitionProfile = { tokens: number; repetitionRatio: number; uniqueRatio: number }

/**
 * How much of a window is one repeated phrase, and how little of it is new.
 *
 * Phrase coverage is the measure rather than raw token repetition, because the
 * failure this looks for is structural: "write / okay / execute / write / okay /
 * execute" is one phrase covering the whole window, while healthy reasoning of the
 * same length shares no four-word phrase with itself and keeps inventing words.
 */
export function repetitionProfile(tokens: string[], phrase = 4): RepetitionProfile {
  const size = tokens.length
  const uniqueRatio = size ? new Set(tokens).size / size : 1
  if (size < phrase * 2) return { tokens: size, repetitionRatio: 0, uniqueRatio }
  const counts = new Map<string, number>()
  for (let index = 0; index + phrase <= size; index++) {
    const key = tokens.slice(index, index + phrase).join(' ')
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  let most = 0
  for (const count of counts.values()) if (count > most) most = count
  return { tokens: size, repetitionRatio: (most * phrase) / size, uniqueRatio }
}

const tidy = (value: string) => value.replace(/\s+/g, ' ').trim()

/**
 * Statements that stop work by blaming something outside the run. The list is
 * deliberately concrete and short: a semantic classifier would be a second model
 * call on every turn, and this only has to catch the conclusion, not judge it.
 * Every pattern is a claim the challenge then asks the run to falsify.
 */
const limitationClaims: RegExp[] = [
  /\b(?:cannot|can not|can't|could not|couldn't|unable to) (?:be )?(?:improve|improved|progress|do better|go further|make (?:it|this) better)/,
  /\bno further (?:improvement|progress|gain|gains|optimization|work|change) (?:is |are )?(?:possible|needed|available|likely|expected)/,
  /\b(?:further|additional) (?:improvement|improvements|optimization|work|progress)\b[^.]{0,40}\b(?:unlikely|not possible|of little|marginal|limited|provide little|yield little|not worth)/,
  /\b(?:near|approaching|at|hit|hitting|reached|reaching) (?:the|its|my|our) (?:limit|ceiling|capacity|maximum|max)\b/,
  /\b(?:base ?model|underlying model|the model|model) (?:limitation|limit|capability limit|constraint|is not capable)/,
  /\blimitation(?:s)? of the (?:base |underlying )?model\b/,
  /\b(?:search|retrieval|data|web) (?:provider|api|service|index) (?:limitation|constraint|does not (?:expose|provide|support|return))/,
  /\bapi (?:does not|doesn't|can not|can't|cannot) (?:expose|provide|support|return|offer)/,
  /\b(?:requires?|needs?|would need|would require) (?:a )?(?:better|stronger|more capable|different|larger) model\b/,
  /\b(?:without|requires?|needs?) (?:an? )?api[ _-]?key\b/,
  /\bnot (?:possible|feasible) (?:with|using|through) (?:the )?(?:available|current|existing|free|provided) (?:tools|tooling|sources|apis|data)\b/,
  /\bnothing (?:more|further|else) (?:can|could) be (?:done|improved|achieved|gained)\b/,
  /\b(?:beyond|out of) (?:my|our|the) control\b/,
  /\bdiminishing returns\b/,
  /\b(?:hard|fundamental|structural) (?:limit|limitation|ceiling)\b/,
  /\bremaining (?:failures|errors|issues|problems) (?:are|appear to be|must be)\b/,
  /\b(?:caused|due) (?:by|to) (?:the )?(?:search|retrieval|data|web|api|provider|model|base model|upstream|external|vendor|service)\b/,
  /\bsaturation\b/,
  /\bno (?:further|more) (?:meaningful )?(?:gain|gains|improvement|improvements)\b/,
]

/** The same claims as they are actually written in Chinese, matched without spaces. */
const limitationClaimsCompact: RegExp[] = [
  /无法(?:再|进一步)?(?:改进|提升|优化|改善|提高)/,
  /(?:不能|无法)再(?:提升|改进|优化|提高)/,
  /(?:已经|已)?(?:接近|到达|达到|触达)(?:极限|上限|瓶颈)/,
  /(?:模型|基座模型|底座模型)(?:本身)?的?限制/,
  /(?:搜索|检索|数据|网页)(?:接口|服务商|提供商|api)的?限制/,
  /api(?:限制|不提供|无法提供|不支持|没有暴露)/,
  /需要(?:更强|更好|更先进|更大)的?模型/,
  /需要(?:提供)?apikey/,
  /没有apikey(?:就)?无法/,
  /(?:现有|可用|当前)(?:的)?(?:工具|来源|数据源|接口)(?:无法|不能)/,
  /无法通过(?:现有|当前)(?:的)?(?:工具|接口|api)/,
  /(?:进一步|继续)(?:优化|改进|提升)(?:空间)?(?:有限|不大|很小|已无)/,
  /提升空间(?:有限|不大|很小)/,
  /收益(?:递减|有限)/,
  /已(?:经)?(?:做到|达到)(?:最好|极致|极限)/,
  /无能为力/,
  /(?:剩余|剩下)的?(?:问题|失败|缺陷)(?:是|由|来自).{0,12}(?:限制|局限)/,
]

/** The limitation a concluding turn leans on, or nothing when it leans on none. */
export function limitationClaim(text: string): string | undefined {
  const spaced = tidy(text.normalize('NFKC').toLowerCase())
  if (!spaced) return undefined
  const compact = spaced.replace(/\s+/g, '')
  for (const pattern of limitationClaims) {
    const match = pattern.exec(spaced)
    if (match) return match[0].slice(0, 120)
  }
  for (const pattern of limitationClaimsCompact) {
    const match = pattern.exec(compact)
    if (match) return match[0].slice(0, 120)
  }
  return undefined
}

const degenerationGuidance: Record<SupervisorGuidanceLanguage, string> = {
  en: 'You are repeating the same reasoning without changing the state of the task. Stop the current approach: re-read the latest observable state (the last tool output, the failing command, the file as it is now), name what is actually wrong with it, and take the next concrete action that could change it. Do not restate the plan.',
  'zh-CN': '你在重复同一段推理，任务状态没有变化。停止当前做法：重新查看最新的可观察状态（最后一次工具输出、失败的命令、文件当前内容），指出其中真正的问题，然后执行下一个能改变该状态的具体动作。不要重复计划和推理。',
}

const failureGuidance = (language: SupervisorGuidanceLanguage, tool: string, count: number) => language === 'zh-CN'
  ? `同一个工具调用（${tool}）已经连续失败 ${count} 次，中间没有任何状态变化。不要再原样重试：先读失败输出，说明这个失败真正要求什么，然后改变参数或做法再试。`
  : `The same tool call (${tool}) has now failed identically ${count} times with nothing else in between. Do not run it again unchanged. Read the failure output, work out what the failure actually requires, and change the input or the approach before the next attempt.`

/**
 * One bounded challenge. It does not tell the model that its conclusion is wrong:
 * it asks the model to test the conclusion, which is the step V4.1 skips.
 */
const challengeGuidance: Record<SupervisorGuidanceLanguage, string> = {
  en: 'Before stopping, verify the claim that the remaining problem is caused by an external, tool, API, or base-model limitation. Try to falsify that conclusion using the evidence and the capabilities currently available. If a controllable harness, implementation, query, retrieval, state-management, or verification problem remains, continue working on it. If the limitation survives that check, finish normally and state the concrete evidence supporting it.',
  'zh-CN': '在结束之前，先核实「剩下的问题来自外部、工具、API 或基座模型限制」这一结论。用当前已有的证据和可用能力，尝试证伪这个结论。如果仍然存在可控的框架、实现、查询、检索、状态管理或验证问题，就继续解决它。如果证伪之后这个限制依然成立，就正常结束，并给出支持它的具体证据。',
}

/** How many distinct tool signatures are remembered when judging repetition. */
const SIGNATURE_MEMORY = 64

type ToolOutcome = { ok: boolean }

type AssistantBlock = { type?: string; text?: string; thinking?: string }

/**
 * One supervisor per run. It is an `OutcomePolicy`, so the run's turn loop already
 * delivers the conclusion it has to judge and the transcript it has to observe —
 * no second loop, no second model, no extra session.
 */
export class AgentSupervisor implements OutcomePolicy {
  private readonly limits: SupervisorLimits
  private readonly language: SupervisorGuidanceLanguage
  private readonly onFinish?: (telemetry: LongRunTelemetry) => void
  private readonly startedAt = Date.now()

  /** Streamed output and reasoning, bounded to `windowTokens` for the whole run. */
  private tokens: string[] = []
  /** Streamed tokens since the last event that actually changed task state. */
  private tokensSinceProgress = 0
  private tokensAtSteer = 0
  private steeredThisEpisode = false
  private episodeEscalated = false

  /** Identical calls are judged by their arguments, and only the last outcomes matter. */
  private readonly pendingSignatures = new Map<string, string>()
  private readonly signatureOutcomes = new Map<string, ToolOutcome>()
  private lastSignature = ''
  private consecutiveSignature = 0
  private lastFailureSignature = ''
  private failureStreak = 0

  private pending?: RecoveryDecision
  private challengePending = false

  private peakContextTokens = 0
  private providerCalls = 0
  private compactionCount = 0
  private totalToolCalls = 0
  private toolErrors = 0
  private repeatedToolCallBursts = 0
  private detections = 0
  private steers = 0
  private escalations = 0
  private challenges = 0
  private challengeReason?: string
  private challengeOutcome?: LongRunTelemetry['challengeOutcome']
  private recoveryOutcome?: LongRunTelemetry['recoveryOutcome']
  private finalStopReason = 'unknown'
  private finished = false

  constructor(options: AgentSupervisorOptions = {}) {
    this.limits = { ...defaultSupervisorLimits, ...options.limits }
    this.language = options.language || 'en'
    this.onFinish = options.onFinish
  }

  observe(event: AgentSessionEvent) {
    if (this.finished) return
    switch (event.type) {
      case 'message_update': {
        const update = event.assistantMessageEvent
        // Tool arguments stream in their own events: a generated file body is the
        // answer to the request, not the model repeating itself.
        if (update.type === 'text_delta' || update.type === 'thinking_delta') this.absorb(update.delta)
        return
      }
      case 'message_end': {
        if (event.message.role !== 'assistant') return
        this.providerCalls++
        const usage = event.message.usage
        if (usage) {
          const request = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0)
          if (request > this.peakContextTokens) this.peakContextTokens = request
        }
        if (event.message.stopReason) this.finalStopReason = event.message.stopReason
        return
      }
      case 'tool_execution_start': {
        this.totalToolCalls++
        // Work resuming is the outcome a challenge was asking for.
        if (this.challengePending) {
          this.challengeOutcome = 'productive'
          this.challengePending = false
        }
        this.pendingSignatures.set(event.toolCallId, toolSignature(event.toolName, event.args))
        return
      }
      case 'tool_execution_end': {
        const signature = this.pendingSignatures.get(event.toolCallId) || toolSignature(event.toolName, undefined)
        this.pendingSignatures.delete(event.toolCallId)
        if (event.isError) this.toolErrors++
        this.noteToolOutcome(event.toolName, signature, !event.isError, event.result?.details?.changed === true)
        return
      }
      case 'compaction_end': {
        this.compactionCount++
        return
      }
      default: return
    }
  }

  /**
   * The decision about a turn that produced no tool call. A run that says it cannot
   * improve any further has exactly one turn left before it stops, so this is the
   * only place a premature conclusion can be caught.
   */
  inspectCompletion(turn: PrepareNextTurnContext): SupervisorVerdict {
    const content = assistantBlocks(turn)
    const concluding = !content.some(block => block.type === 'toolCall')
    if (this.challengePending && !concluding) {
      this.challengeOutcome = 'productive'
      this.challengePending = false
    }
    if (!concluding) return { action: 'accept' }
    if (this.challenges >= this.limits.maxChallenges) return { action: 'accept' }
    if (this.totalToolCalls < this.limits.minToolCallsBeforeChallenge) return { action: 'accept' }
    const claim = limitationClaim(content.map(block => block.text || block.thinking || '').join('\n'))
    if (!claim) return { action: 'accept' }
    this.challenges++
    this.challengePending = true
    this.challengeReason = claim
    return { action: 'challenge', feedback: challengeGuidance[this.language] }
  }

  /** The recovery the observed stream has earned, if it earned one. */
  shouldRecover(): RecoveryDecision | undefined {
    const decision = this.pending
    if (!decision) return undefined
    this.pending = undefined
    this.steeredThisEpisode = true
    this.tokensAtSteer = this.tokensSinceProgress
    this.steers++
    return decision
  }

  /** The policy seam: `interrupt` is what the runtime delivers while generation continues. */
  interrupt() {
    return this.shouldRecover()?.feedback
  }

  evaluate(turn: PrepareNextTurnContext): OutcomeVerdict {
    const verdict = this.inspectCompletion(turn)
    if (verdict.action === 'accept') return { status: 'accept' }
    return { status: 'continue', feedback: verdict.feedback }
  }

  telemetry(): LongRunTelemetry {
    return {
      peakContextTokens: this.peakContextTokens,
      providerCalls: this.providerCalls,
      compactionCount: this.compactionCount,
      totalToolCalls: this.totalToolCalls,
      toolErrors: this.toolErrors,
      repeatedToolCallBursts: this.repeatedToolCallBursts,
      degenerationDetections: this.detections,
      degenerationSteers: this.steers,
      degenerationEscalations: this.escalations,
      supervisorChallenges: this.challenges,
      ...(this.challengeReason ? { challengeReason: this.challengeReason } : {}),
      ...(this.challengeOutcome ? { challengeOutcome: this.challengeOutcome } : {}),
      ...(this.recoveryOutcome ? { recoveryOutcome: this.recoveryOutcome } : {}),
      durationMs: Date.now() - this.startedAt,
      finalStopReason: this.finalStopReason,
    }
  }

  /** Close the run's accounting and hand its record to the sink, exactly once. */
  finish(): LongRunTelemetry {
    if (this.finished) return this.telemetry()
    this.finished = true
    // A second conclusion that still leans on the limitation, or a run that ended
    // without resuming work, is a limitation the challenge did not overturn.
    if (this.challengePending) {
      this.challengeOutcome = 'confirmed_limit'
      this.challengePending = false
    }
    if (this.steers > 0) this.recoveryOutcome = (this.episodeEscalated || this.escalations > 0) ? 'persisted' : 'recovered'
    const telemetry = this.telemetry()
    this.onFinish?.(telemetry)
    return telemetry
  }

  /**
   * Streamed output joins the window. Repetition is only judged once the run has
   * written enough for the judgement to mean anything and nothing has changed task
   * state since.
   */
  private absorb(delta: string) {
    if (!delta) return
    const tokens = streamTokens(delta)
    if (!tokens.length) return
    // One delta is already in memory; the window itself never grows past its bound.
    for (const token of tokens.length > this.limits.windowTokens ? tokens.slice(-this.limits.windowTokens) : tokens) this.tokens.push(token)
    this.tokensSinceProgress += tokens.length
    if (this.tokens.length > this.limits.windowTokens) this.tokens.splice(0, this.tokens.length - this.limits.windowTokens)
    if (this.steeredThisEpisode) {
      // Guidance already went out and the stream is still repeating: this is the
      // level the ladder would have to escalate to, recorded rather than taken.
      if (!this.episodeEscalated && this.tokensSinceProgress - this.tokensAtSteer >= this.limits.windowTokens) {
        this.episodeEscalated = true
        this.escalations++
      }
      return
    }
    if (this.tokensSinceProgress < this.limits.minTokens) return
    const profile = repetitionProfile(this.tokens)
    if (profile.repetitionRatio < this.limits.minRepetitionRatio) return
    if (profile.uniqueRatio > this.limits.maxUniqueRatio) return
    this.detect('repetition-without-progress')
  }

  /**
   * A tool call is progress when it produced something the run did not already
   * have: a call it has not made before, a change to a file, or the resolution of
   * a failure. Repeating the same successful call, or the same failure, is not
   * progress, however busy it looks.
   */
  private noteToolOutcome(toolName: string, signature: string, ok: boolean, changed: boolean) {
    const previous = this.signatureOutcomes.get(signature)
    this.signatureOutcomes.delete(signature)
    this.signatureOutcomes.set(signature, { ok })
    if (this.signatureOutcomes.size > SIGNATURE_MEMORY) {
      const oldest = this.signatureOutcomes.keys().next().value
      if (oldest !== undefined) this.signatureOutcomes.delete(oldest)
    }

    if (signature === this.lastSignature) this.consecutiveSignature++
    else { this.lastSignature = signature; this.consecutiveSignature = 1 }
    if (this.consecutiveSignature === 3) this.repeatedToolCallBursts++

    if (ok && (!previous || !previous.ok || changed)) {
      this.noteProgress()
      return
    }
    if (ok) return
    if (signature === this.lastFailureSignature) this.failureStreak++
    else { this.lastFailureSignature = signature; this.failureStreak = 1 }
    if (this.failureStreak >= this.limits.repeatedFailureBurst) this.detect('repeated-identical-failure', toolName)
  }

  /** Task state moved: everything the supervisor was suspicious about is spent. */
  private noteProgress() {
    this.tokens.length = 0
    this.tokensSinceProgress = 0
    this.tokensAtSteer = 0
    this.steeredThisEpisode = false
    this.episodeEscalated = false
    this.lastSignature = ''
    this.consecutiveSignature = 0
    this.lastFailureSignature = ''
    this.failureStreak = 0
    // Guidance describes the state that produced it; that state is gone.
    this.pending = undefined
  }

  private detect(reason: DegenerationReason, tool = '') {
    if (this.pending) return
    if (this.steeredThisEpisode || this.steers >= this.limits.maxSteers) {
      if (this.episodeEscalated) return
      this.episodeEscalated = true
      this.escalations++
      return
    }
    this.detections++
    this.pending = {
      level: 'steer',
      reason,
      feedback: reason === 'repeated-identical-failure'
        ? failureGuidance(this.language, tool || 'the same tool', this.limits.repeatedFailureBurst)
        : degenerationGuidance[this.language],
    }
  }
}

function assistantBlocks(turn: PrepareNextTurnContext): AssistantBlock[] {
  const message = turn?.message as { content?: unknown } | undefined
  return Array.isArray(message?.content) ? message.content as AssistantBlock[] : []
}

/**
 * Whether a finished run's record is worth keeping. Healthy short runs leave
 * nothing behind; interventions, compaction, a large context, and long runs are
 * exactly the sessions the thresholds are supposed to be tuned from.
 */
export function noteworthySupervisorRecord(telemetry: LongRunTelemetry) {
  return telemetry.degenerationDetections > 0
    || telemetry.degenerationSteers > 0
    || telemetry.degenerationEscalations > 0
    || telemetry.supervisorChallenges > 0
    || telemetry.compactionCount > 0
    || telemetry.peakContextTokens >= 100_000
    || telemetry.durationMs >= 10 * 60_000
}
