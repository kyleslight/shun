import { createHash } from 'node:crypto'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { PrepareNextTurnContext } from '@earendil-works/pi-agent-core'
import type { OutcomePolicy, OutcomeVerdict } from './outcome-policy.ts'
import { defaultResearchFanoutLimits } from './research-fanout.ts'
import { canonicalUrl, transportFailureKind, webReadReceipt } from './web.ts'

/** One-line normalization for text this policy inspects but does not rewrite. */
const tidy = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim()

const webAllowanceUsed = 'The local retrieval allowance for this research window has been used. Existing evidence and non-web tools remain available; this tool status does not determine whether the task is complete.'
const webUnavailable = `No retrieval request was sent. This call was refused by a local restriction, not a network or source outage. Repeated web calls are refused in this window. ${webAllowanceUsed}`

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

// Retrieval remains available unless an explicit caller supplies a budget.
// Per-request deadlines and cancellation bound transport; bookkeeping must not
// silently revoke tools halfway through a user-requested investigation.
export const defaultWebResearchLimits: WebResearchLimits = {
  maxSearchCalls: Infinity,
  maxReadCalls: Infinity,
  maxNetworkCalls: Infinity,
  maxConsecutiveNoGain: Infinity,
  maxSearchesBeforeRead: Infinity,
  maxElapsedMs: Infinity,
  phaseIdleMs: 120_000,
}

type Progress = {
  elapsedMs: number
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
    ? 'This call did not go out and nothing was fetched: this line of inquiry has used its available retrieval calls. This says nothing about the source itself or whether the task is complete.'
    : `This call did not go out, and nothing was fetched, so this says nothing about the source itself. ${webUnavailable}`
  return phase === 'search'
    ? JSON.stringify({ query: typeof requested === 'string' ? requested : '', number_of_results: 0, results: [], blocked: true, note })
    : JSON.stringify({ ok: false, blocked: true, requested_url: canonicalUrl(requested), content: '', note })
}

/**
 * The rule a research context lives under — discovery that never opens a page is not research —
 * kept for one parallel explorer.
 *
 * The session's policy cannot hold it: a fan-out's lines arrive as calls it cannot tell apart, so
 * a count kept there belongs to whoever shares it. An explorer has nothing but its own line to
 * research, so the line is where the count belongs. It is deliberately more roomy than the
 * session's own limit, because a line's first searches may return nothing worth opening, and the
 * block buys the line one more search afterwards rather than ending its search phase.
 */
export function explorerReadGate(searchesBeforeRead = 3) {
  const ceiling = Math.max(1, searchesBeforeRead)
  let searches = 0
  let reads = 0
  const gate = async (context: { toolCall?: { name?: string } }) => {
    const name = context?.toolCall?.name
    if (name === 'web_read') {
      reads++
      return undefined
    }
    if (name !== 'web_search') return undefined
    if (reads === 0 && searches >= ceiling) {
      // Searching again with different words is not made impossible here: the line has not tried
      // yet, and a rule that leaves an explorer with nothing it may do would end the line, not
      // direct it. What it cannot do is keep searching as if the pages did not exist.
      searches = 0
      return {
        block: true,
        reason: `This search was blocked: this line has issued ${ceiling} searches and opened none of the pages they returned, and a line answered from snippets is not research. Open the strongest URL one of those searches already gave you with web_read, pass the identifying clue as query so its outbound links are ranked first, follow what that page points to, and search again only for what the pages you opened could not tell you.`,
      }
    }
    searches++
    return undefined
  }
  return Object.assign(gate, {
    observeSearch(output: string) {
      try {
        const pages = JSON.parse(output).pages
        if (Array.isArray(pages) && pages.some(page => page?.ok === true && webReadReceipt(JSON.stringify(page), page.requested_url))) reads++
      } catch { /* Discovery-only output does not establish a page read. */ }
    },
  })
}

/** Lower sorts first: an evidence-capable source that matches directly leads the read phase. */
function leadPriority(lead: { confidence: string; sourceClass: string }) {
  return (SOURCE_CLASS_RANK[lead.sourceClass] ?? 1) * 2 + (lead.confidence === 'direct' ? 0 : 1)
}

type WebPhase = 'search' | 'read'

export class WebResearchPolicy implements OutcomePolicy {
  private limits: WebResearchLimits
  private taskDepth?: 'fact_lookup' | 'deep_research'
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
  /** Leads in the order discovery ranked them, which is the order that makes a read phase productive. */
  private readonly leads: Lead[] = []
  private readonly openedUrls = new Set<string>()
  private readonly completeSourceUrls = new Set<string>()
  /** Calls in this phase that returned evidence the phase had not already seen. */
  private productiveSearches = 0
  private productiveReads = 0

  constructor(limits: WebResearchLimits = defaultWebResearchLimits) {
    this.limits = limits
  }

  /** Retrieval scope controls evidence accounting, without closing tools needed for a missing fact. */
  selectTaskDepth(depth: 'fact_lookup' | 'deep_research') {
    if (this.taskDepth || this.delegations.size) return
    this.taskDepth = depth
  }

  async search(queryValue: unknown, run: () => Promise<string>) {
    this.refreshResearchPhase()
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
      const gained = collectSearchEvidence(output, this.evidence) + this.recordSearchPages(output)
      if (gained > 0) this.productiveSearches++
      return this.finish('search', output, false, gained, delegated)
    } catch (error) {
      this.searchFailureCache.set(query, failureText(error))
      return this.failed('search', error, false, delegated)
    }
  }

  async read(input: { url: unknown; urls?: string[]; query?: unknown; maxChars?: unknown; offset?: unknown; render?: boolean; networkTimeoutMs?: number }, run: () => Promise<string>) {
    // Respect an explicit read target. Only infer one when it is absent, so reusing
    // the request does not append the task repeatedly and change its cache key.
    const reason = tidy(input.query) || this.leadQuery(String(input.url || ''))
    if (reason) input.query = reason.slice(0, 300)
    const key = readKey(input)
    const target = canonicalUrl(input.url)
    const failureTarget = input.urls && input.urls.length > 1 ? JSON.stringify(input.urls.map(url => canonicalUrl(url))) : target
    const failureKey = failureTarget ? `${failureTarget}:${input.render === true ? 'rendered' : 'http'}:${input.networkTimeoutMs || 0}` : ''
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
      this.recordCompleteSource(output, String(input.url || ''))
      this.openedUrls.add(canonicalUrl(webReadReceipt(output, String(input.url || ''))?.finalUrl || input.url))
      const learned = collectReadEvidence(output, input.url, this.evidence) + this.recordSearchPages(output)
      if (learned > 0) this.productiveReads++
      return this.finish('read', output, false, learned, delegated)
    } catch (error) {
      if (failureKey) this.readFailureCache.set(failureKey, failureText(error))
      return this.failed('read', error, false, delegated)
    }
  }

  beforeToolCall(toolName: string, _context?: { context?: { messages?: Array<{ role?: string; content?: unknown }> } }) {
    // A denied call never reaches chargeWebCall, so recovery must precede the gate.
    if (toolName === 'web_search' || toolName === 'web_read' || toolName === 'skill_catalog_search') this.refreshResearchPhase()
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
        : webUnavailable
    // A closed web tool reports its own availability, not the lifecycle of the task.
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

  private recordSearchPages(output: string) {
    let gained = 0
    try {
      const parsed = JSON.parse(output), pages = Array.isArray(parsed.pages) ? parsed.pages.slice(0, 12) : []
      for (const page of pages) {
        // Inline passages belong to the discovery batch, not additional reading batches.
        if (this.taskDepth !== 'fact_lookup') { this.networkCalls++; this.readCalls++ }
        const raw = JSON.stringify(page), receipt = webReadReceipt(raw, String(page.requested_url || ''))
        if (!receipt) continue
        this.recordCompleteSource(raw, receipt.requestedUrl)
        this.openedUrls.add(receipt.requestedUrl)
        this.openedUrls.add(receipt.finalUrl)
        const added = collectReadEvidence(raw, receipt.requestedUrl, this.evidence)
        if (added) this.productiveReads++
        gained += added
      }
    } catch {}
    return gained
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
   * Tool receipts already carry availability. Repeating that status through steering
   * creates another model turn and lets a retrieval budget control task termination.
   */
  evaluate(_turn: PrepareNextTurnContext): OutcomeVerdict {
    return { status: 'accept' }
  }

  private recordCompleteSource(raw: string, requested: string) {
    try {
      const page = JSON.parse(raw), receipt = webReadReceipt(raw, requested)
      if (receipt && page.has_more === false && page.content_offset === 0 &&
        typeof page.content_characters === 'number' && page.content_end >= page.content_characters) {
        this.completeSourceUrls.add(receipt.requestedUrl)
        this.completeSourceUrls.add(receipt.finalUrl)
      }
    } catch {}
  }

  fullyReadSourceUrls() {
    return new Set(this.completeSourceUrls)
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
  private refreshResearchPhase() {
    const now = Date.now()
    if (this.phaseStartedAt && now - this.lastWebActivityAt >= this.limits.phaseIdleMs) {
      this.phaseStartedAt = 0
      this.globalReason = ''
      this.searchReason = ''
      this.readReason = ''
      this.searchCalls = 0
      this.completeSourceUrls.clear()
      this.readCalls = 0
      this.networkCalls = 0
      this.searchConsecutiveNoGain = 0
      this.readConsecutiveNoGain = 0
      this.productiveSearches = 0
      this.productiveReads = 0
    }
  }

  private beginResearchActivity() {
    this.refreshResearchPhase()
    const now = Date.now()
    if (!this.phaseStartedAt) this.phaseStartedAt = now
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
      throw Error(`Public web read failed: ${message}.${reachability} This retrieval route failed; it does not establish that the source is unavailable. Do not retry the same URL with different query words. Use another source or an explicitly different retrieval route.`)
    }
    throw Error(`Public web search failed: ${message}. Use a materially different available source; do not repeat the same query.`)
  }

  private progress(cached: boolean, newEvidence: number, phase: WebPhase = 'search'): Progress {
    const searchExhausted = Boolean(this.globalReason || this.searchReason)
    const readExhausted = Boolean(this.globalReason || this.readReason)
    const reason = this.globalReason || (phase === 'search' ? this.searchReason : this.readReason)
    return {
      elapsedMs: this.phaseStartedAt ? Math.max(0, Date.now() - this.phaseStartedAt) : 0,
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
  }

  private stopPhase(phase: WebPhase, reason: string) {
    if (phase === 'search') this.searchReason = reason
    else this.readReason = reason
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
  const input = value as { query?: unknown; site?: unknown; exactPhrases?: unknown; source?: unknown; page?: unknown; includeContent?: unknown; coverage?: unknown; depth?: unknown; maxResults?: unknown }
  return JSON.stringify({
    query: normalizeQuery(input.query),
    depth: normalizeQuery(input.depth || 'fact_lookup'),
    maxResults: Number(input.maxResults) || 0,
    source: normalizeQuery(input.source || 'web'),
    coverage: normalizeQuery(input.coverage || 'standard'),
    includeContent: input.includeContent !== false,
    page: Number(input.page) || 1,
    site: normalizeQuery(input.site),
    exactPhrases: Array.isArray(input.exactPhrases) ? input.exactPhrases.map(normalizeQuery) : [],
  })
}

function readKey(input: { url: unknown; urls?: string[]; query?: unknown; maxChars?: unknown; offset?: unknown; render?: boolean; networkTimeoutMs?: number }) {
  return JSON.stringify({
    url: canonicalUrl(input.url),
    ...(input.urls?.length ? { urls: input.urls.map(url => canonicalUrl(url)) } : {}),
    query: normalizeQuery(input.query),
    maxChars: Number(input.maxChars) || 0,
    offset: Number(input.offset) || 0,
    render: input.render === true,
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
    elapsed_ms: progress.elapsedMs,
    cached: progress.cached,
    new_evidence: progress.newEvidence,
    total_evidence: progress.totalEvidence,
    consecutive_no_gain: progress.consecutiveNoGain,
    search_exhausted: progress.searchExhausted,
    read_exhausted: progress.readExhausted,
    exhausted: progress.exhausted,
    ...(progress.cached && progress.newEvidence === 0 ? { instruction: 'This is an exact cached repeat. This source window or search result was already returned in this run, and no new information was fetched. Use its existing evidence; if a requested fact is still missing, change the actual source or window rather than repeating these same arguments.' } : {}),
    ...(progress.exhausted || progress.searchExhausted || progress.readExhausted ? {
      instruction: progress.exhausted
        ? webAllowanceUsed
        : progress.searchExhausted
          ? 'Searching is done here. Open and verify the strongest URLs already discovered with web_read.'
          : 'Reading is done here. Use a materially different search only if it can add evidence that is not already present.',
    } : {}),
  }
  try { return JSON.stringify({ ...JSON.parse(output), research }) }
  catch { return JSON.stringify({ ok: true, content: output, research }) }
}
