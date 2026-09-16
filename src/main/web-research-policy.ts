import { createHash } from 'node:crypto'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { PrepareNextTurnContext } from '@earendil-works/pi-agent-core'
import type { OutcomePolicy, OutcomeVerdict } from './outcome-policy.ts'
import { canonicalUrl, transportFailureKind, webReadReceipt } from './web.ts'

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
}

export const defaultWebResearchLimits: WebResearchLimits = {
  maxSearchCalls: 6,
  maxReadCalls: 8,
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

type Lead = { url: string; confidence: string; order: number }

type WebPhase = 'search' | 'read'

const phaseResetNote = 'Web research opens a fresh bounded phase after the run spends a few minutes on work that does not use the web.'

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

  constructor(limits: WebResearchLimits = defaultWebResearchLimits) {
    this.limits = limits
  }

  async search(queryValue: unknown, run: () => Promise<string>) {
    const query = searchKey(queryValue)
    this.beginResearchActivity()
    this.searchCalls++
    const cached = this.searchCache.get(query)
    if (cached !== undefined) return this.finish('search', cached, true, 0)
    const cachedFailure = this.searchFailureCache.get(query)
    if (cachedFailure !== undefined) return this.failed('search', Error(cachedFailure), true)
    if (this.networkCeiling()) return this.finish('search', JSON.stringify({ query, number_of_results: 0, results: [] }), false, 0)
    this.networkCalls++
    try {
      const output = await run()
      this.searchCache.set(query, output)
      this.recordLeads(output)
      return this.finish('search', output, false, collectSearchEvidence(output, this.evidence))
    } catch (error) {
      this.searchFailureCache.set(query, failureText(error))
      return this.failed('search', error, false)
    }
  }

  async read(input: { url: unknown; query?: unknown; maxChars?: unknown; offset?: unknown }, run: () => Promise<string>) {
    const key = readKey(input)
    const failureKey = canonicalUrl(input.url)
    this.beginResearchActivity()
    this.readCalls++
    this.openedUrls.add(canonicalUrl(input.url))
    const cached = this.readCache.get(key)
    if (cached !== undefined) return this.finish('read', cached, true, 0)
    const cachedFailure = this.readFailureCache.get(failureKey)
    if (cachedFailure !== undefined) return this.failed('read', Error(cachedFailure), true)
    if (this.networkCeiling()) return this.finish('read', JSON.stringify({ ok: false, requested_url: canonicalUrl(input.url), content: '' }), false, 0)
    this.networkCalls++
    try {
      const output = await run()
      this.readCache.set(key, output)
      this.openedUrls.add(canonicalUrl(webReadReceipt(output, String(input.url || ''))?.finalUrl || input.url))
      return this.finish('read', output, false, collectReadEvidence(output, input.url, this.evidence))
    } catch (error) {
      if (failureKey) this.readFailureCache.set(failureKey, failureText(error))
      return this.failed('read', error, false)
    }
  }

  beforeToolCall(toolName: string) {
    // Discovery that never opens a page is not research: a model can spend the whole
    // search budget on near-identical queries and then answer from snippets. Once
    // leads exist, the next web call has to be a read.
    if (toolName === 'web_search' && !this.globalReason && !this.searchReason && this.readCalls === 0 && this.searchCalls >= this.limits.maxSearchesBeforeRead && this.leadCount() > 0) {
      return {
        block: true,
        reason: `This search was blocked: discovery already returned ${this.leadCount()} distinct URLs across ${this.searchCalls} searches and none has been opened. Open the strongest lead with web_read now${this.nextLeadHint()}, pass the identifying clue as query so its outbound links are ranked first, follow those links, and only then search again.`,
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
      ? ' Do not search again; open the strongest URLs already discovered with web_read and verify them.'
      : toolName === 'web_read' && !this.globalReason && !this.searchReason
        ? ' Do not read more pages; use the remaining search budget only if it can add materially different evidence.'
        : ' Answer from the evidence already collected, leading with the best-supported conclusion and separating verified facts, single-source claims, and unresolved points. A partial answer is required here; a bare refusal is not.'
    return {
      block: true,
      reason: `This web research phase stopped: ${reason}.${alternative} ${phaseResetNote}`,
    }
  }

  observe(_event: AgentSessionEvent) {}

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
  private recordLeads(output: string) {
    try {
      const parsed = JSON.parse(output), results = Array.isArray(parsed.results) ? parsed.results : []
      results.forEach((item: any) => {
        const url = canonicalUrl(item?.url)
        if (!url || this.leads.some(lead => lead.url === url)) return
        this.leads.push({ url, confidence: String(item?.match?.confidence || ''), order: this.leads.length + 1 })
      })
    } catch {}
  }

  private unopenedLeads() {
    // A direct match is the page the ranking says answers the query, so it is opened
    // before the leads that merely mention the subject.
    return this.leads.filter(lead => !this.openedUrls.has(lead.url))
      .slice()
      .sort((a, b) => (a.confidence === 'direct' ? 0 : 1) - (b.confidence === 'direct' ? 0 : 1) || a.order - b.order)
  }

  /** The next reads worth making, named so the agent opens a ranked lead rather than a remembered one. */
  private nextLeadHint(limit = 3) {
    const unopened = this.unopenedLeads().slice(0, limit)
    if (!unopened.length) return ''
    return `: ${unopened.map((lead, index) => `${index + 1}. ${lead.url}${lead.confidence ? ` (${lead.confidence})` : ''}`).join('; ')}`
  }

  evaluate(_turn: PrepareNextTurnContext): OutcomeVerdict {
    if (!this.feedbackPending) return { status: 'accept' }
    this.feedbackPending = false
    if (this.globalReason || (this.searchReason && this.readReason)) {
      const reason = this.globalReason || `${this.searchReason}; ${this.readReason}`
      return {
        status: 'continue',
        feedback: `Web research has reached its bounded evidence ceiling for this phase (${reason}). Stop using web tools now. Answer from the evidence already collected: lead with the best-supported conclusion, say how strongly the evidence supports it, and separate verified facts, single-source claims, and unresolved points. Do not invent a precise URL, identifier, quote, or fact that the evidence does not establish, and do not answer with a bare refusal when the evidence supports a partial answer. ${phaseResetNote}`,
      }
    }
    if (this.searchReason) {
      return {
        status: 'continue',
        feedback: `The discovery-search phase is complete (${this.searchReason}). Do not issue another web search. Use web_read on the strongest direct or lead URLs already discovered${this.nextLeadHint()}, pass the exact identifying clue as query so relevant outbound links are ranked first, follow those links when useful, and then answer from verified evidence.`,
      }
    }
    return {
      status: 'continue',
      feedback: `The page-verification phase is complete (${this.readReason}). Do not read more pages. Use materially different search evidence if discovery budget remains; otherwise answer from current evidence and state uncertainty explicitly.`,
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

  private finish(phase: WebPhase, output: string, cached: boolean, newEvidence: number) {
    if (phase === 'search') this.searchConsecutiveNoGain = newEvidence > 0 ? 0 : this.searchConsecutiveNoGain + 1
    else this.readConsecutiveNoGain = newEvidence > 0 ? 0 : this.readConsecutiveNoGain + 1
    this.updateReason(phase)
    return attachProgress(output, this.progress(cached, newEvidence, phase))
  }

  private failed(phase: WebPhase, error: unknown, cached: boolean): never {
    this.finish(phase, JSON.stringify({ ok: false, content: '' }), cached, 0)
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
    if (!this.globalReason && Date.now() - this.phaseStartedAt >= this.limits.maxElapsedMs) this.stopGlobal(`research time limit reached (${Math.round(this.limits.maxElapsedMs / 1000)}s)`)
    return Boolean(this.globalReason)
  }

  private updateReason(phase: WebPhase) {
    if (!this.globalReason && this.networkCalls >= this.limits.maxNetworkCalls) this.stopGlobal(`network-call limit reached (${this.limits.maxNetworkCalls})`)
    else if (!this.globalReason && Date.now() - this.phaseStartedAt >= this.limits.maxElapsedMs) this.stopGlobal(`research time limit reached (${Math.round(this.limits.maxElapsedMs / 1000)}s)`)
    if (this.globalReason) return
    if (phase === 'search' && !this.searchReason) {
      if (this.searchCalls >= this.limits.maxSearchCalls) this.stopPhase('search', `search-call limit reached (${this.limits.maxSearchCalls})`)
      else if (this.searchConsecutiveNoGain >= this.limits.maxConsecutiveNoGain) this.stopPhase('search', `no new evidence in ${this.searchConsecutiveNoGain} consecutive searches`)
    } else if (phase === 'read' && !this.readReason) {
      if (this.readCalls >= this.limits.maxReadCalls) this.stopPhase('read', `page-read limit reached (${this.limits.maxReadCalls})`)
      else if (this.readConsecutiveNoGain >= this.limits.maxConsecutiveNoGain) this.stopPhase('read', `no new evidence in ${this.readConsecutiveNoGain} consecutive page reads`)
    }
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

function attachProgress(output: string, progress: Progress) {
  const research = {
    cached: progress.cached,
    new_evidence: progress.newEvidence,
    total_evidence: progress.totalEvidence,
    consecutive_no_gain: progress.consecutiveNoGain,
    search_calls: progress.searchCalls,
    read_calls: progress.readCalls,
    network_calls: progress.networkCalls,
    search_exhausted: progress.searchExhausted,
    read_exhausted: progress.readExhausted,
    exhausted: progress.exhausted,
    ...(progress.reason ? {
      reason: progress.reason,
      instruction: progress.exhausted
        ? 'Stop using web tools and answer from current evidence: best-supported conclusion first, then verified facts, single-source claims, and unresolved points. A partial answer is required; a bare refusal is not.'
        : progress.searchExhausted
          ? 'Stop issuing searches. Open and verify the strongest URLs already discovered with web_read.'
          : 'Stop reading pages. Use materially different search evidence if discovery budget remains.',
    } : {}),
  }
  try { return JSON.stringify({ ...JSON.parse(output), research }, null, 2) }
  catch { return JSON.stringify({ ok: true, content: output, research }, null, 2) }
}
