import { createHash } from 'node:crypto'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { PrepareNextTurnContext } from '@earendil-works/pi-agent-core'
import type { OutcomePolicy, OutcomeVerdict } from './outcome-policy.ts'
import { defaultResearchFanoutLimits } from './research-fanout.ts'
import { canonicalUrl, transportFailureKind, webReadReceipt } from './web.ts'

/** One-line normalization for text this policy inspects but does not rewrite. */
const tidy = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim()

export type WebResearchLimits = {
  maxSearchCalls: number
  maxReadCalls: number
  maxNetworkCalls: number
  maxConsecutiveNoGain: number
  /** Searches allowed before the phase must open at least one of the leads it found. */
  maxSearchesBeforeRead: number
  maxElapsedMs: number
  /** Quiet time after which the next web call opens a fresh bounded phase. */
  phaseIdleMs: number
  /** Extra calls a phase may spend while each call is still returning new evidence. */
  productiveCallBonus?: number
}

export const defaultWebResearchLimits: WebResearchLimits = {
  maxSearchCalls: 6,
  maxReadCalls: 8,
  // A phase that keeps producing evidence is worth continuing past its base budget, and one
  // that has stopped producing it is not: the ceiling is what bounds cost, and how long the
  // research actually pays is what decides when to stop.
  productiveCallBonus: 6,
  maxNetworkCalls: 12,
  maxConsecutiveNoGain: 3,
  maxSearchesBeforeRead: 2,
  // Long enough for a full burst of bounded reads, and measured from research
  // activity rather than from the start of the run.
  maxElapsedMs: 300_000,
  phaseIdleMs: 120_000,
}

type Progress = {
  cached: boolean
  newEvidence: number
  totalEvidence: number
  consecutiveNoGain: number
  searchCalls: number
  readCalls: number
  networkCalls: number
  searchExhausted: boolean
  readExhausted: boolean
  /** Ranked, still-unopened leads, most worth reading first. */
  nextLeads: string[]
  exhausted: boolean
  reason?: string
}

type Lead = { url: string; confidence: string; sourceClass: string; order: number; query: string }

const SOURCE_CLASS_RANK: Record<string, number> = { official_or_primary_candidate: 0, other_candidate: 1, community_or_reference_lead: 2 }

/**
 * What a call that was not allowed to go out returns.
 *
 * It has to say so. A blocked search used to come back as an empty result list and a blocked
 * read as an empty page, which the model then reports as a finding about the source — the
 * explorer that told its lead agent "the PDF returned nothing, the search channel is empty"
 * was describing this function, not the web.
 *
 * The two states below are different facts and must not be worded as one. A run that has stopped
 * searching altogether, and one fan-out whose own lines have finished the research they can do,
 * are not the same event: told the second as the first, an explorer reports that the research
 * channel itself is closed, and its lead agent tells the user the same thing while its own
 * reader is still working.
 */
function closedReceipt(phase: WebPhase, requested: unknown, state: 'idle' | 'spent') {
  const note = state === 'spent'
    ? 'This call did not go out and nothing was fetched: this line of inquiry has already done the research available to it here, so this says nothing about the source itself. Report what you established, the source that supports it, and what stays unestablished.'
    : 'This call did not go out, and nothing was fetched: this run is not running searches or opening pages right now, so this says nothing about the source itself. Answer from what has already been read, and say plainly which parts stay unestablished.'
  return phase === 'search'
    ? JSON.stringify({ query: typeof requested === 'string' ? requested : '', number_of_results: 0, results: [], blocked: true, note })
    : JSON.stringify({ ok: false, blocked: true, requested_url: canonicalUrl(requested), content: '', note })
}

/** Lower sorts first: an evidence-capable source that matches directly leads the read phase. */
function leadPriority(lead: { confidence: string; sourceClass: string }) {
  return (SOURCE_CLASS_RANK[lead.sourceClass] ?? 1) * 2 + (lead.confidence === 'direct' ? 0 : 1)
}

/** The first thing the user asked, which every page in the run is being read for. */
function taskQuestion(messages: Array<{ role?: string; content?: unknown }>) {
  for (const message of messages) {
    if (message?.role !== 'user') continue
    const content = message.content
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => String((part as { text?: string })?.text || '')).join(' ') : ''
    const cleaned = tidy(text)
    if (cleaned) return cleaned.slice(0, 300)
  }
  return ''
}

type WebPhase = 'search' | 'read'

export class WebResearchPolicy implements OutcomePolicy {
  private readonly limits: WebResearchLimits
  private phaseStartedAt = 0
  private lastWebActivityAt = Date.now()
  private readonly searchCache = new Map<string, string>()
  private readonly readCache = new Map<string, string>()
  private readonly searchFailureCache = new Map<string, string>()
  private readonly readFailureCache = new Map<string, string>()
  private readonly evidence = new Set<string>()
  private searchCalls = 0
  private readCalls = 0
  private networkCalls = 0
  private searchConsecutiveNoGain = 0
  private readConsecutiveNoGain = 0
  private searchReason = ''
  private readReason = ''
  private globalReason = ''
  private feedbackPending = false
  /** Leads in the order discovery ranked them, which is the order that makes a read phase productive. */
  private readonly leads: Lead[] = []
  private readonly openedUrls = new Set<string>()
  /** Calls in this phase that returned evidence the phase had not already seen. */
  private productiveSearches = 0
  private productiveReads = 0
  /** The task the run is researching, which is the reason any page is being opened. */
  private taskQuestion = ''

  constructor(limits: WebResearchLimits = defaultWebResearchLimits) {
    this.limits = limits
  }

  async search(queryValue: unknown, run: () => Promise<string>) {
    const query = searchKey(queryValue)
    const delegated = this.delegations.size > 0
    const cached = this.searchCache.get(query)
    if (cached !== undefined) return this.finish('search', cached, true, 0, delegated)
    const cachedFailure = this.searchFailureCache.get(query)
    if (cachedFailure !== undefined) return this.failed('search', Error(cachedFailure), true, delegated)
    const closed = this.chargeWebCall('search', queryValue, delegated)
    if (closed) return this.blocked('search', closed)
    try {
      const output = await run()
      this.searchCache.set(query, output)
      this.recordLeads(output, this.requestedQueryText(queryValue))
      const gained = collectSearchEvidence(output, this.evidence)
      if (gained > 0) this.productiveSearches++
      return this.finish('search', output, false, gained, delegated)
    } catch (error) {
      this.searchFailureCache.set(query, failureText(error))
      return this.failed('search', error, false, delegated)
    }
  }

  async read(input: { url: unknown; query?: unknown; maxChars?: unknown; offset?: unknown }, run: () => Promise<string>) {
    // A page found by a search is read for the reason that search made it a candidate,
    // and a reader that slices from the top of a long page answers nothing: the window
    // follows the words that led here unless the caller says what it is looking for.
    // A page is read for the task, and the caller's own query only narrows what the
    // window should look at. Both are the reason, so both rank the sections that come
    // back: a caller looking for an episode list still needs the row its clues describe.
    const reason = [tidy(input.query) || this.leadQuery(String(input.url || '')), this.taskQuestion].filter(Boolean).join(' ')
    if (reason) input.query = reason.slice(0, 300)
    const key = readKey(input)
    const failureKey = canonicalUrl(input.url)
    this.openedUrls.add(canonicalUrl(input.url))
    const delegated = this.delegations.size > 0
    const cached = this.readCache.get(key)
    if (cached !== undefined) return this.finish('read', cached, true, 0, delegated)
    const cachedFailure = this.readFailureCache.get(failureKey)
    if (cachedFailure !== undefined) return this.failed('read', Error(cachedFailure), true, delegated)
    const closed = this.chargeWebCall('read', input.url, delegated)
    if (closed) return this.blocked('read', closed)
    try {
      const output = await run()
      this.readCache.set(key, output)
      this.openedUrls.add(canonicalUrl(webReadReceipt(output, String(input.url || ''))?.finalUrl || input.url))
      const learned = collectReadEvidence(output, input.url, this.evidence)
      if (learned > 0) this.productiveReads++
      return this.finish('read', output, false, learned, delegated)
    } catch (error) {
      if (failureKey) this.readFailureCache.set(failureKey, failureText(error))
      return this.failed('read', error, false, delegated)
    }
  }

  beforeToolCall(toolName: string, context?: { context?: { messages?: Array<{ role?: string; content?: unknown }> } }) {
    if (!this.taskQuestion && context?.context) this.taskQuestion = taskQuestion(context.context.messages || [])
    // Discovery that never opens a page is not research: a model can spend the whole
    // search budget on near-identical queries and then answer from snippets. Once
    // leads exist, the next web call has to be a read.
    if (toolName === 'web_search' && !this.globalReason && !this.searchReason && this.readCalls === 0 && this.searchCalls >= this.limits.maxSearchesBeforeRead && this.leadCount() > 0) {
      return {
        block: true,
        reason: `This search was blocked: discovery has already returned ${this.leadCount()} distinct URLs and none has been opened. Open the strongest lead with web_read now${this.nextLeadHint()}, pass the identifying clue as query so its outbound links are ranked first, follow those links, and only then search again.`,
      }
    }
    const searchTool = toolName === 'web_search' || toolName === 'skill_catalog_search'
    const reason = searchTool
      ? this.globalReason || this.searchReason
      : toolName === 'web_read'
        ? this.globalReason || this.readReason
        : ''
    if (!reason) return undefined
    const alternative = searchTool && !this.globalReason && !this.readReason
      ? 'Searching is done for this answer. Open the strongest URLs already discovered with web_read and verify them.'
      : toolName === 'web_read' && !this.globalReason && !this.searchReason
        ? 'Reading is done for this answer. Use a materially different search only if it can add evidence that is not already present.'
        : 'Answer now from the evidence already collected, leading with the best-supported conclusion and separating verified facts, single-source claims, and unresolved points. Do not wait for a tool and do not retry: a partial answer is required here and a bare refusal is not.'
    // What the model is told about a closed tool is what it must do next. Naming the
    // product's own ceiling, phase, or reset here is how a quota report ends up
    // written into an answer, and how a model ends up telling the user to wait.
    return { block: true, reason: alternative }
  }

  observe(event: AgentSessionEvent) {
    const seen = event as unknown as { type?: string; toolName?: string; result?: { content?: Array<{ type?: string; text?: string }> } }
    if (seen?.type === 'tool_execution_start' && seen.toolName === 'research_fanout') {
      // A fan-out is one bounded unit of research: while it runs, the calls arriving here are
      // its explorers', and they spend the fan-out's allowance instead of the one this context
      // is saving for its own answer. Frames are keyed by call, because one turn can open
      // several fan-outs and the kernel runs them concurrently: a single flag and counter let
      // them spend each other's allowance, and the first one to land hand the other's still
      // running explorers to this context's own phase, which closed the caller's reader too.
      const id = String((seen as { toolCallId?: unknown }).toolCallId ?? 'research_fanout')
      this.delegations.set(id, { calls: 0, allowance: this.delegationAllowance((seen as { args?: unknown }).args) })
      return
    }
    if (seen?.type !== 'tool_execution_end' || seen.toolName !== 'research_fanout') return
    this.delegations.delete(String((seen as { toolCallId?: unknown }).toolCallId ?? 'research_fanout'))
  }

  /**
   * The fan-outs in flight, each with its own allowance, keyed by the tool call that opened it.
   * Explorers hold the same tool objects this context does and cannot be told apart per call, so
   * a fan-out's lines share its frame and take room from it in turn.
   */
  private readonly delegations = new Map<string, { calls: number; allowance: number }>()

  /**
   * A fan-out opens one research context per line, and each of those lines is owed what one
   * research context gets. Charging all of them to a single context's room is what left a whole
   * line holding nothing but refused calls, which it then reported as the channel being closed
   * while the caller's own reader was working. The ceiling is the fan-out's own limit on lines,
   * since the arguments arrive before the tool that would reject a larger list runs.
   */
  private delegationAllowance(args: unknown) {
    const questions = (args as { questions?: unknown })?.questions
    const lines = Array.isArray(questions) ? questions.length : 1
    return this.limits.maxNetworkCalls * Math.max(1, Math.min(lines, defaultResearchFanoutLimits.maxExplorers))
  }

  /** The running fan-out with the most room left, so one fan-out cannot starve another's lines. */
  private delegationWithRoom() {
    let chosen: { calls: number; allowance: number } | undefined
    for (const frame of this.delegations.values()) {
      if (frame.calls >= frame.allowance) continue
      if (!chosen || frame.allowance - frame.calls > chosen.allowance - chosen.calls) chosen = frame
    }
    return chosen
  }

  /**
   * A call that did not go out is not an attempt: it changes no counter, closes no phase, and
   * must not be read as a run that searched and found nothing.
   */
  private blocked(phase: WebPhase, output: string) {
    return attachProgress(output, this.progress(false, 0, phase))
  }

  /**
   * Decides whether this call may go out, and charges it to whoever is asking. A call that may
   * not go out is reported by closedReceipt rather than answered with an empty result.
   */
  private chargeWebCall(phase: WebPhase, requested: unknown, delegated: boolean): string | undefined {
    if (delegated && this.delegations.size) {
      const frame = this.delegationWithRoom()
      // Every open fan-out's lines have finished the research they can do here: the line that
      // asked is done, which is not the same fact as the run having stopped searching.
      if (!frame) return closedReceipt(phase, requested, 'spent')
      frame.calls++
      return undefined
    }
    this.beginResearchActivity()
    if (phase === 'search') this.searchCalls++
    else this.readCalls++
    if (this.networkCeiling()) return closedReceipt(phase, requested, 'idle')
    this.networkCalls++
    return undefined
  }

  /** URLs discovered by search are the leads a read phase has to consume. */
  private leadCount() {
    let count = 0
    for (const key of this.evidence) if (key.startsWith('url:')) count++
    return count
  }

  /**
   * Discovery ranks leads, and a read phase that does not know the ranking spends its
   * budget on whatever looked familiar. Keeping the ranking lets the policy name the
   * next URL to open instead of asking for "the strongest lead", which is a choice the
   * agent cannot make from a count.
   */
  private recordLeads(output: string, query = '') {
    try {
      const parsed = JSON.parse(output), results = Array.isArray(parsed.results) ? parsed.results : []
      results.forEach((item: any) => {
        const url = canonicalUrl(item?.url)
        if (!url || this.leads.some(lead => lead.url === url)) return
        this.leads.push({ url, confidence: String(item?.match?.confidence || ''), sourceClass: String(item?.source_class || ''), order: this.leads.length + 1, query: tidy(query).slice(0, 200) })
      })
    } catch {}
  }

  /** The query as the caller wrote it, which names what the search was looking for. */
  private requestedQueryText(queryValue: unknown) {
    if (typeof queryValue === 'string') return tidy(queryValue)
    const parts = [tidy((queryValue as { query?: unknown })?.query)]
    const site = tidy((queryValue as { site?: unknown })?.site)
    if (site) parts.push(`site:${site}`)
    for (const phrase of Array.isArray((queryValue as { exactPhrases?: unknown })?.exactPhrases) ? (queryValue as { exactPhrases: unknown[] }).exactPhrases : []) parts.push(tidy(phrase))
    return tidy(parts.filter(Boolean).join(' '))
  }

  /** The search that made this URL a lead, which is why opening it is worth a read. */
  private leadQuery(url: string) {
    const wanted = canonicalUrl(url)
    return this.leads.find(lead => lead.url === wanted)?.query || ''
  }

  private unopenedLeads() {
    // What a source can be decides the read order before how well it matched: a page
    // that can record the fact is read before a mention of it, and a direct match on a
    // social post is still a social post.
    return this.leads.filter(lead => !this.openedUrls.has(lead.url))
      .slice()
      .sort((a, b) => leadPriority(a) - leadPriority(b) || a.order - b.order)
  }

  /** The next reads worth making, named so the agent opens a ranked lead rather than a remembered one. */
  private nextLeadHint(limit = 3) {
    const unopened = this.unopenedLeads().slice(0, limit)
    if (!unopened.length) return ''
    return `: ${unopened.map((lead, index) => `${index + 1}. ${lead.url}${lead.confidence ? ` (${lead.confidence})` : ''}`).join('; ')}`
  }

  /**
   * A turn is accepted unless a closed phase is waiting to say what to do next. The turn
   * itself is not read: what a concluding answer names, or fails to name, is not something
   * this policy sends back.
   */
  evaluate(turn: PrepareNextTurnContext): OutcomeVerdict {
    if (!this.feedbackPending) return { status: 'accept' }
    this.feedbackPending = false
    if (this.globalReason || (this.searchReason && this.readReason)) {
      return {
        status: 'continue',
        feedback: 'Web tools are finished for this answer: do not wait for them and do not retry them. Answer now from the evidence already collected, leading with the best-supported conclusion, saying how strongly the evidence supports it, and separating verified facts, single-source claims, and unresolved points. Do not invent a precise URL, identifier, quote, or fact that the evidence does not establish, and do not answer with a bare refusal when the evidence supports a partial answer.',
      }
    }
    if (this.searchReason) {
      return {
        status: 'continue',
        feedback: `Searching is done for this answer. Use web_read on the strongest direct or lead URLs already discovered${this.nextLeadHint()}, pass the exact identifying clue as query so relevant outbound links are ranked first, follow those links when useful, and then answer from what those pages establish.`,
      }
    }
    return {
      status: 'continue',
      feedback: `Reading is done for this answer. Use a materially different search only if it can add evidence that is not already present; otherwise answer from what has been established and state the uncertainty explicitly.`,
    }
  }

  snapshot() {
    return this.progress(false, 0)
  }

  /**
   * Research budgets belong to a research phase, not to the run's wall clock.
   * A run that spends minutes on files, commands, or downloads before searching
   * would otherwise find the window already closed. Web calls separated by
   * quiet time open a fresh bounded phase; continuous research stays capped.
   */
  private beginResearchActivity() {
    const now = Date.now()
    if (!this.phaseStartedAt || now - this.lastWebActivityAt >= this.limits.phaseIdleMs) {
      this.phaseStartedAt = now
      this.globalReason = ''
      this.searchReason = ''
      this.readReason = ''
      this.searchCalls = 0
      this.readCalls = 0
      this.networkCalls = 0
      this.searchConsecutiveNoGain = 0
      this.readConsecutiveNoGain = 0
    }
    this.lastWebActivityAt = now
  }

  private finish(phase: WebPhase, output: string, cached: boolean, newEvidence: number, delegated = false) {
    // A fan-out's explorers research their own lines, so their calls leave this context's phase
    // exactly as it was. Counted here instead, three searches a line gained nothing on would
    // close its caller's searches before the caller had made one.
    if (!delegated) {
      if (phase === 'search') this.searchConsecutiveNoGain = newEvidence > 0 ? 0 : this.searchConsecutiveNoGain + 1
      else this.readConsecutiveNoGain = newEvidence > 0 ? 0 : this.readConsecutiveNoGain + 1
      this.updateReason(phase)
    }
    return attachProgress(output, this.progress(cached, newEvidence, phase))
  }

  private failed(phase: WebPhase, error: unknown, cached: boolean, delegated = false): never {
    this.finish(phase, JSON.stringify({ ok: false, content: '' }), cached, 0, delegated)
    const message = failureText(error)
    if (phase === 'read') {
      // A host that will not resolve from this machine is not a company without a
      // website. Without this the model reports a local reachability fact as a
      // finding about the subject, which is the opposite of what was observed.
      const kind = transportFailureKind(message), reachability = kind === 'unresolved'
        ? ' The host did not resolve from this network path: that is a reachability fact about this machine, not evidence that the site is offline or that the company has no website. Say so if it matters to the answer.'
        : kind === 'tls'
          ? ' The TLS handshake to this host failed from this network path: treat that as a local reachability fact, not as proof about the site itself.'
          : kind === 'timeout'
            ? ' This host timed out from this network path; it may still be reachable, so do not treat the timeout as absence.'
            : ''
      throw Error(`Public web read failed: ${message}.${reachability} This is the public web reader’s network path, not evidence that the user’s Chrome is blocked. Do not retry the same URL with a different query; use another source or inspect it once with Browser Use when Chrome UI or login state is relevant.`)
    }
    throw Error(`Public web search failed: ${message}. Use a materially different available source; do not repeat the same query.`)
  }

  private progress(cached: boolean, newEvidence: number, phase: WebPhase = 'search'): Progress {
    const searchExhausted = Boolean(this.globalReason || this.searchReason)
    const readExhausted = Boolean(this.globalReason || this.readReason)
    const reason = this.globalReason || (phase === 'search' ? this.searchReason : this.readReason)
    return {
      cached,
      newEvidence,
      totalEvidence: this.evidence.size,
      consecutiveNoGain: phase === 'search' ? this.searchConsecutiveNoGain : this.readConsecutiveNoGain,
      searchCalls: this.searchCalls,
      readCalls: this.readCalls,
      networkCalls: this.networkCalls,
      searchExhausted,
      readExhausted,
      // The ranked leads still worth opening, so a caller can see what the phase
      // intends to read next instead of inferring it from a count.
      nextLeads: this.unopenedLeads().slice(0, 3).map(lead => lead.url),
      exhausted: Boolean(this.globalReason || (this.searchReason && this.readReason)),
      ...(reason ? { reason } : {}),
    }
  }

  private networkCeiling() {
    if (!this.globalReason && this.networkCalls >= this.limits.maxNetworkCalls) this.stopGlobal(`network-call limit reached (${this.limits.maxNetworkCalls})`)
    // A phase that never started has no clock: delegated calls finish here too, and they must
    // not close a caller's phase that has not made a single call of its own.
    if (!this.globalReason && this.phaseStartedAt && Date.now() - this.phaseStartedAt >= this.limits.maxElapsedMs) this.stopGlobal(`research time limit reached (${Math.round(this.limits.maxElapsedMs / 1000)}s)`)
    return Boolean(this.globalReason)
  }

  private updateReason(phase: WebPhase) {
    if (!this.globalReason && this.networkCalls >= this.limits.maxNetworkCalls) this.stopGlobal(`network-call limit reached (${this.limits.maxNetworkCalls})`)
    else if (!this.globalReason && this.phaseStartedAt && Date.now() - this.phaseStartedAt >= this.limits.maxElapsedMs) this.stopGlobal(`research time limit reached (${Math.round(this.limits.maxElapsedMs / 1000)}s)`)
    if (this.globalReason) return
    if (phase === 'search' && !this.searchReason) {
      const ceiling = this.searchCeiling()
      if (this.searchCalls >= ceiling) this.stopPhase('search', `search-call limit reached (${ceiling})`)
      else if (this.searchConsecutiveNoGain >= this.limits.maxConsecutiveNoGain) this.stopPhase('search', `no new evidence in ${this.searchConsecutiveNoGain} consecutive searches`)
    } else if (phase === 'read' && !this.readReason) {
      const ceiling = this.readCeiling()
      if (this.readCalls >= ceiling) this.stopPhase('read', `page-read limit reached (${ceiling})`)
      else if (this.readConsecutiveNoGain >= this.limits.maxConsecutiveNoGain) this.stopPhase('read', `no new evidence in ${this.readConsecutiveNoGain} consecutive page reads`)
    }
  }

  /**
   * A phase that is still producing evidence gets to keep going: the base budget is where a
   * phase starts, and the evidence it actually gains is what decides how far past it the run
   * should go. A phase that has stopped producing evidence never sees the bonus.
   */
  private searchCeiling() {
    const bonus = Math.max(0, this.limits.productiveCallBonus ?? 0)
    return this.limits.maxSearchCalls + Math.min(bonus, this.productiveSearches)
  }

  private readCeiling() {
    const bonus = Math.max(0, this.limits.productiveCallBonus ?? 0)
    return this.limits.maxReadCalls + Math.min(bonus, this.productiveReads)
  }

  private stopGlobal(reason: string) {
    this.globalReason = reason
    this.feedbackPending = true
  }

  private stopPhase(phase: WebPhase, reason: string) {
    if (phase === 'search') this.searchReason = reason
    else this.readReason = reason
    this.feedbackPending = true
  }
}

function failureText(error: unknown) {
  return String((error as Error)?.message || error || 'unknown failure').replace(/\s+/g, ' ').trim().slice(0, 800)
}

function normalizeQuery(value: unknown) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()
}

function searchKey(value: unknown) {
  if (!value || typeof value !== 'object') return normalizeQuery(value)
  const input = value as { query?: unknown; site?: unknown; exactPhrases?: unknown }
  return JSON.stringify({
    query: normalizeQuery(input.query),
    site: normalizeQuery(input.site),
    exactPhrases: Array.isArray(input.exactPhrases) ? input.exactPhrases.map(normalizeQuery) : [],
  })
}

function readKey(input: { url: unknown; query?: unknown; maxChars?: unknown; offset?: unknown }) {
  return JSON.stringify({
    url: canonicalUrl(input.url),
    query: normalizeQuery(input.query),
    maxChars: Number(input.maxChars) || 0,
    offset: Number(input.offset) || 0,
  })
}

function collectSearchEvidence(output: string, evidence: Set<string>) {
  try {
    const parsed = JSON.parse(output), before = evidence.size
    for (const item of Array.isArray(parsed.results) ? parsed.results : []) {
      const url = canonicalUrl(item?.url)
      if (url) evidence.add(`url:${url}`)
    }
    return evidence.size - before
  } catch { return 0 }
}

function collectReadEvidence(output: string, requested: unknown, evidence: Set<string>) {
  const receipt = webReadReceipt(output, String(requested || ''))
  if (!receipt) return 0
  const hash = createHash('sha256').update(receipt.content).digest('hex').slice(0, 20)
  const key = `content:${receipt.finalUrl}:${receipt.start}:${receipt.end}:${hash}`
  if (evidence.has(key)) return 0
  evidence.add(key)
  return 1
}

/**
 * What a tool result says about its own research is a decision signal, never an account
 * of the product's bookkeeping: call counters and ceiling prose are the product's
 * business, and once written into a tool result they come back as an answer about
 * quotas — or as advice to wait for one. The counters stay on Progress, where the
 * product can read them; the model gets what to do next.
 */
function attachProgress(output: string, progress: Progress) {
  const research = {
    cached: progress.cached,
    new_evidence: progress.newEvidence,
    total_evidence: progress.totalEvidence,
    consecutive_no_gain: progress.consecutiveNoGain,
    search_exhausted: progress.searchExhausted,
    read_exhausted: progress.readExhausted,
    exhausted: progress.exhausted,
    ...(progress.exhausted || progress.searchExhausted || progress.readExhausted ? {
      instruction: progress.exhausted
        ? 'Answer now from the evidence already collected: best-supported conclusion first, then verified facts, single-source claims, and unresolved points. Do not wait and do not retry: a partial answer is required here and a bare refusal is not.'
        : progress.searchExhausted
          ? 'Searching is done here. Open and verify the strongest URLs already discovered with web_read.'
          : 'Reading is done here. Use a materially different search only if it can add evidence that is not already present.',
    } : {}),
  }
  try { return JSON.stringify({ ...JSON.parse(output), research }, null, 2) }
  catch { return JSON.stringify({ ok: true, content: output, research }, null, 2) }
}
