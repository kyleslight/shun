/**
 * Parallel research explorers, each with its own context window.
 *
 * One research context has to hold every page it opens, so it follows a single
 * line of inquiry and forgets the branches it abandoned. Explorers give each line
 * its own context and return only compressed findings, which is the shape the
 * strongest research systems use: the lead agent plans and synthesizes, the
 * explorers absorb the reading.
 *
 * This module owns the *boundary* only — how many run, for how long, how much comes
 * back, and what happens when one fails. The explorer itself is injected, so the
 * application supplies the same kernel session and the same web tools the main run
 * uses, instead of this file growing a second agent loop.
 */

import type { FanoutLine, FanoutProgress } from '../shared.ts'

export type ResearchExplorer = (question: string, signal: AbortSignal) => Promise<string>

export type ResearchFanoutLimits = {
  /** Independent lines of inquiry a single fan-out may open. */
  maxExplorers: number
  /** Explorers running at once. */
  maxParallel: number
  /** Characters kept from one explorer's findings. */
  maxDigestChars: number
  /** Wall clock for one explorer before it is abandoned. */
  timeoutMs: number
}

export const defaultResearchFanoutLimits: ResearchFanoutLimits = {
  maxExplorers: 6,
  maxParallel: 3,
  maxDigestChars: 4_000,
  timeoutMs: 240_000,
}

export type ResearchFindingStatus = 'ok' | 'timeout' | 'failed' | 'skipped'

export type ResearchFinding = {
  question: string
  status: ResearchFindingStatus
  digest: string
  seconds: number
}

export type ResearchFanoutResult = {
  findings: ResearchFinding[]
  started: number
  skipped: number
  reason?: string
}

/**
 * Normalizes what a caller asked for into the questions actually worth spending an
 * explorer on: empty entries dropped, duplicates merged, order preserved.
 */
export function planResearchQuestions(values: unknown, limit: number) {
  const seen = new Set<string>()
  const questions: string[] = []
  for (const value of Array.isArray(values) ? values : []) {
    const question = String(value ?? '').replace(/\s+/g, ' ').trim()
    if (!question) continue
    const key = question.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    questions.push(question)
  }
  return { questions: questions.slice(0, Math.max(0, limit)), skipped: Math.max(0, questions.length - limit) }
}

export function boundDigest(text: string, maxChars: number) {
  const digest = String(text ?? '').replace(/\s+\n/g, '\n').trim()
  if (digest.length <= maxChars) return digest
  // The marker is charged against the bound, so the result is never longer than the
  // limit the caller set.
  const marker = '\n[findings truncated at the explorer boundary]'
  if (maxChars <= marker.length) return digest.slice(0, maxChars)
  return `${digest.slice(0, maxChars - marker.length)}${marker}`
}

/**
 * What the person watching the fan-out sees: the lines that were opened, which of them have
 * landed, and what each brought back. Built from the questions that were planned rather than
 * from what has landed, because a list that only appears once a line finishes shows a person
 * nothing about the four lines still running.
 */
export function researchFanoutProgress(
  questions: string[],
  findings: ResearchFinding[],
  options: { startedAt: number; finishedAt?: number; inFlight?: readonly string[] },
): FanoutProgress {
  const landed = new Map(findings.map(finding => [finding.question, finding]))
  const inFlight = new Set(options.inFlight || [])
  const lines = questions.map(question => {
    const finding = landed.get(question)
    if (!finding) return { question, state: inFlight.has(question) ? 'running' as const : 'pending' as const }
    return finding.status === 'ok'
      ? { question, state: 'done' as const, seconds: finding.seconds, ...(finding.digest ? { finding: finding.digest } : {}) }
      : { question, state: 'failed' as const, seconds: finding.seconds }
  })
  return {
    startedAt: options.startedAt,
    ...(options.finishedAt ? { finishedAt: options.finishedAt } : {}),
    done: lines.filter(line => line.state === 'done').length,
    failed: lines.filter(line => line.state === 'failed').length,
    running: options.finishedAt === undefined,
    lines,
  }
}

/**
 * A fan-out report arriving from a tool result is validated rather than trusted: it is one
 * tool's detail crossing into the conversation the person reads, and a malformed one would
 * leave the card with a line list it cannot draw.
 */
export function readFanoutProgress(value: unknown): FanoutProgress | undefined {
  const progress = value as Partial<FanoutProgress> | undefined
  if (!progress || typeof progress !== 'object' || !Array.isArray(progress.lines) || !progress.lines.length) return undefined
  const lines = progress.lines.slice(0, defaultResearchFanoutLimits.maxExplorers).flatMap(line => {
    const question = String((line as { question?: unknown })?.question ?? '').replace(/\s+/g, ' ').trim()
    const state = (line as { state?: unknown })?.state
    if (!question || (state !== 'pending' && state !== 'running' && state !== 'done' && state !== 'failed')) return []
    const seconds = Number((line as { seconds?: unknown })?.seconds)
    const finding = typeof (line as { finding?: unknown })?.finding === 'string' ? boundDigest(String((line as { finding: string }).finding), 4_000) : ''
    return [{
      question: question.slice(0, 400),
      state: state as FanoutLine['state'],
      ...(Number.isFinite(seconds) && seconds > 0 ? { seconds: Math.round(seconds) } : {}),
      ...(finding ? { finding } : {}),
    }]
  })
  if (!lines.length) return undefined
  const startedAt = Number(progress.startedAt), finishedAt = Number(progress.finishedAt)
  return {
    startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now(),
    ...(Number.isFinite(finishedAt) && finishedAt > 0 ? { finishedAt } : {}),
    done: lines.filter(line => line.state === 'done').length,
    failed: lines.filter(line => line.state === 'failed').length,
    running: progress.running === true,
    lines,
  }
}

async function runOne(question: string, explore: ResearchExplorer, limits: ResearchFanoutLimits, parent: AbortSignal | undefined): Promise<ResearchFinding> {
  const started = Date.now()
  // One explorer's work is bounded on its own terms, and the parent's cancellation
  // reaches it: an abandoned fan-out must not keep opening pages.
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason)
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  let timer: NodeJS.Timeout | undefined
  try {
    const digest = await Promise.race([
      explore(question, controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('explorer timed out')) }, limits.timeoutMs) }),
    ])
    return { question, status: 'ok', digest: boundDigest(String(digest ?? ''), limits.maxDigestChars), seconds: Math.round((Date.now() - started) / 1_000) }
  } catch (error) {
    const timedOut = String((error as Error)?.message || error).includes('timed out')
    return { question, status: parent?.aborted ? 'failed' : timedOut ? 'timeout' : 'failed', digest: '', seconds: Math.round((Date.now() - started) / 1_000) }
  } finally {
    if (timer) clearTimeout(timer)
    parent?.removeEventListener('abort', abort)
  }
}

/**
 * Runs the planned questions, at most `maxParallel` at a time, and returns every
 * explorer's finding. A failed explorer is reported, never thrown: one dead line of
 * inquiry must not discard the work of the others.
 */
export async function runResearchFanout(
  values: unknown,
  explore: ResearchExplorer,
  limits: ResearchFanoutLimits = defaultResearchFanoutLimits,
  signal?: AbortSignal,
  /** Called as each explorer lands, so a caller can show a fan-out that is still running. */
  onFinding?: (finding: ResearchFinding, done: number, total: number) => void,
  /** Called as each explorer starts: which lines are working is what a watcher needs to see. */
  onStart?: (question: string) => void,
): Promise<ResearchFanoutResult> {
  const { questions, skipped } = planResearchQuestions(values, limits.maxExplorers)
  const findings: ResearchFinding[] = questions.map(question => ({ question, status: 'skipped' as const, digest: '', seconds: 0 }))
  if (!questions.length) return { findings, started: 0, skipped, ...(skipped ? { reason: `only ${limits.maxExplorers} explorers run at once` } : {}) }

  let next = 0
  const parallel = Math.max(1, Math.min(limits.maxParallel, questions.length))
  await Promise.all(Array.from({ length: parallel }, async () => {
    for (;;) {
      const index = next++
      if (index >= questions.length || signal?.aborted) return
      onStart?.(questions[index])
      findings[index] = await runOne(questions[index], explore, limits, signal)
      onFinding?.(findings[index], findings.filter(finding => finding.status !== 'skipped').length, questions.length)
    }
  }))
  return {
    findings: findings.filter(finding => finding.status !== 'skipped' || questions.includes(finding.question)),
    started: findings.filter(finding => finding.status !== 'skipped').length,
    skipped,
    ...(skipped ? { reason: `only ${limits.maxExplorers} explorers run at once` } : {}),
  }
}

/** One compact block the lead agent can read without the explorers' transcripts. */
export function formatResearchFindings(result: ResearchFanoutResult) {  if (!result.findings.some(finding => finding.status === 'ok')) {
    return `No explorer returned findings${result.reason ? ` (${result.reason})` : ''}. Research the question in this context instead.`
  }
  return result.findings.map(finding => {
    if (finding.status === 'ok') return `### ${finding.question}\n${finding.digest}`
    return `### ${finding.question}\n[${finding.status === 'timeout' ? 'explorer timed out' : 'explorer failed'}] ${finding.seconds}s`
  }).join('\n\n')
}
