import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type SearchCandidate = {
  title?: unknown
  url?: unknown
  content?: unknown
  snippet?: unknown
  engine?: unknown
}

export type SearchProvider = {
  id: string
  tier: number
  timeoutMs?: number
  search: (query: string, maxResults: number) => Promise<SearchCandidate[]>
}

type ProviderHealth = {
  failures: number
  successes: number
  consecutiveFailures: number
  emptyResponses: number
  consecutiveEmpty: number
  /** How many times this source has been benched without a success in between. */
  benches: number
  cooldownUntil: number
  cooldownReason?: string
  latencyMs: number
  lastError?: string
}

type CacheEntry = { createdAt: number; results: SearchCandidate[] }
type PersistedState = { version: 1; health: Record<string, ProviderHealth>; cache: Record<string, CacheEntry> }

export type SearchCoordinationResult = {
  results: SearchCandidate[]
  cache: 'fresh' | 'miss'
  providers: Array<{ id: string; status: 'ok' | 'empty' | 'failed' | 'blocked' | 'cooldown'; latency_ms?: number; results?: number; reason?: string; retry_in_s?: number }>
}

/**
 * A scraper channel that answers with an anti-bot interstitial is neither empty
 * nor broken: it is unavailable from this network until the block lifts. Empty
 * answers need three strikes before a source is benched, which is far too slow
 * for a channel that loudly refuses every request, so a marked block benches it
 * on the first strike with a much longer cooldown.
 */
export const sourceBlockedFlag = 'shunSourceBlocked'

export function markSourceBlocked<T extends Error>(error: T, reason: string): T {
  return Object.assign(error, { [sourceBlockedFlag]: true, blockedReason: reason })
}

export function blockedReasonOf(error: unknown): string | undefined {
  const value = error as Record<string, unknown> | null | undefined
  return value && value[sourceBlockedFlag] === true ? String(value.blockedReason || 'anti-bot interstitial') : undefined
}

export type SearchCoordinatorOptions = {
  storageFile?: string
  cacheTtlMs?: number
  maxCacheEntries?: number
  maxParallel?: number
  failureThreshold?: number
  emptyThreshold?: number
  cooldownMs?: number
  /** Ceiling for the doubled cooldown of a source that keeps failing. */
  maxCooldownMs?: number
  /** Minimum spacing between two requests to the same source. */
  minIntervalMs?: number
  /** Anti-bot blocks last far longer than a rate limit, so they bench a source for longer. */
  blockedCooldownMs?: number
  now?: () => number
}

const DEFAULT_TIMEOUT = 12_000

export class FreeSearchCoordinator {
  private readonly storageFile?: string
  private readonly cacheTtlMs: number
  private readonly maxCacheEntries: number
  private readonly maxParallel: number
  private readonly failureThreshold: number
  private readonly emptyThreshold: number
  private readonly cooldownMs: number
  private readonly maxCooldownMs: number
  private readonly minIntervalMs: number
  private readonly gates = new Map<string, Promise<void>>()
  private readonly nextAllowedAt = new Map<string, number>()
  private readonly blockedCooldownMs: number
  private readonly now: () => number
  private readonly health = new Map<string, ProviderHealth>()
  private readonly cache = new Map<string, CacheEntry>()
  private loaded?: Promise<void>
  private saveQueued = false
  private saving = Promise.resolve()

  constructor(options: SearchCoordinatorOptions = {}) {
    this.storageFile = options.storageFile
    this.cacheTtlMs = options.cacheTtlMs ?? 30 * 60 * 1_000
    this.maxCacheEntries = options.maxCacheEntries ?? 200
    this.maxParallel = Math.max(1, options.maxParallel ?? 3)
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 2)
    this.emptyThreshold = Math.max(1, options.emptyThreshold ?? 3)
    // The first bench is deliberately short: a source that answered nothing once is
    // far more likely to be briefly rate limited than to be gone, and a flat
    // multi-minute wait turns one blip into the "only the fallback index is left"
    // state a run then reports as dead search sources.
    this.cooldownMs = options.cooldownMs ?? 30 * 1_000
    this.maxCooldownMs = options.maxCooldownMs ?? 10 * 60 * 1_000
    // Free sources are shared with everyone else who uses them. Bursts are what
    // drive them into rate limits, and a rate-limited source then looks like a
    // broken one, so requests to one source are spaced instead of fired together.
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 300)
    this.blockedCooldownMs = options.blockedCooldownMs ?? 45 * 60 * 1_000
    this.now = options.now ?? Date.now
  }

  async search(query: string, maxResults: number, providers: SearchProvider[], sufficient: (results: SearchCandidate[]) => boolean): Promise<SearchCoordinationResult> {
    await this.load()
    const key = normalizeKey(query), cached = this.cache.get(key), now = this.now()
    if (cached && now - cached.createdAt <= this.cacheTtlMs && sufficient(cached.results)) {
      return { results: cached.results.slice(0, maxResults * 4), cache: 'fresh', providers: [] }
    }

    const collected: Array<{ provider: string; rank: number; candidate: SearchCandidate }> = []
    const status: SearchCoordinationResult['providers'] = []
    for (const candidate of cached?.results || []) collected.push({ provider: 'cache', rank: collected.length, candidate })
    // Order by what the sources have actually been doing, not by the tier they were
    // configured with. A static order spends every search waiting on sources that are
    // blocked or empty on this machine and reaches the one that answers last; health
    // first means a working index leads, and tier only breaks ties between sources
    // that are behaving equally well.
    const queue = providers.slice().sort((a, b) => this.providerScore(a.id) - this.providerScore(b.id) || a.tier - b.tier).filter(provider => {
      const health = this.getHealth(provider.id), cooling = health.cooldownUntil > now
      if (cooling) status.push({ id: provider.id, status: 'cooldown', retry_in_s: Math.ceil((health.cooldownUntil - now) / 1_000), ...(health.cooldownReason ? { reason: health.cooldownReason } : {}) })
      return !cooling
    })
    type Settled = Awaited<ReturnType<FreeSearchCoordinator['runProvider']>>
    const active = new Map<symbol, Promise<{ token: symbol; row: Settled }>>()
    const startNext = () => {
      const provider = queue.shift()
      if (!provider) return
      const token = Symbol(provider.id), promise = this.runProvider(provider, query, maxResults).then(row => ({ token, row }))
      active.set(token, promise)
    }
    while (active.size < this.maxParallel && queue.length) startNext()
    let completedEarly = false
    while (active.size) {
      const { token, row } = await Promise.race(active.values())
      active.delete(token)
      status.push(row.status)
      row.results.forEach((candidate, rank) => collected.push({ provider: row.id, rank, candidate }))
      if (sufficient(fuseCandidates(collected))) { completedEarly = true; break }
      startNext()
    }

    if (completedEarly && active.size) {
      const pending = [...active.values()]
      void Promise.allSettled(pending).then(rows => {
        for (const settled of rows) if (settled.status === 'fulfilled') settled.value.row.results.forEach((candidate, rank) => collected.push({ provider: settled.value.row.id, rank, candidate }))
        this.cache.set(key, { createdAt: this.now(), results: fuseCandidates(collected).slice(0, Math.max(maxResults * 4, 20)) })
        this.trimCache()
        this.queueSave()
      })
    }

    const merged = fuseCandidates(collected).slice(0, Math.max(maxResults * 4, 20))
    this.cache.set(key, { createdAt: now, results: merged })
    this.trimCache()
    this.queueSave()
    return { results: merged, cache: 'miss', providers: status }
  }

  /**
   * One request at a time per source, spaced by `minIntervalMs`.
   *
   * The wait happens outside the provider timeout, because queueing is this
   * coordinator's own cost and must not be charged to the source as latency.
   */
  private async enterProvider(providerId: string) {
    const previous = this.gates.get(providerId) || Promise.resolve()
    let release = () => {}
    const current = new Promise<void>(resolve => { release = resolve })
    this.gates.set(providerId, previous.then(() => current))
    await previous
    const wait = (this.nextAllowedAt.get(providerId) || 0) - this.now()
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    this.nextAllowedAt.set(providerId, this.now() + this.minIntervalMs)
    return release
  }

  private async runProvider(provider: SearchProvider, query: string, maxResults: number) {
    const release = await this.enterProvider(provider.id)
    const started = this.now()
    try {
      const results = await withTimeout(provider.search(query, maxResults), provider.timeoutMs ?? DEFAULT_TIMEOUT, provider.id)
      const latency = Math.max(0, this.now() - started), health = this.getHealth(provider.id)
      if (results.length) {
        health.successes++
        health.consecutiveEmpty = 0
        health.benches = 0
      } else {
        health.emptyResponses++
        health.consecutiveEmpty++
      }
      health.consecutiveFailures = 0
      health.cooldownUntil = 0
      health.cooldownReason = undefined
      health.lastError = undefined
      // Answering nothing is not evidence that a source works. A source that
      // keeps answering nothing is benched like a failing one instead of
      // holding a slot and its full timeout on every later query.
      if (health.consecutiveEmpty >= this.emptyThreshold) {
        const wait = this.bench(health, `no results in ${health.consecutiveEmpty} consecutive queries`)
        return { id: provider.id, results, status: { id: provider.id, status: 'empty', latency_ms: latency, results: 0, reason: health.cooldownReason, retry_in_s: Math.round(wait / 1_000) } as const }
      }
      health.latencyMs = health.latencyMs ? Math.round(health.latencyMs * .75 + latency * .25) : latency
      this.queueSave()
      return { id: provider.id, results, status: { id: provider.id, status: results.length ? 'ok' : 'empty', latency_ms: latency, results: results.length } as const }
    } catch (error) {
      const latency = Math.max(0, this.now() - started), health = this.getHealth(provider.id), blocked = blockedReasonOf(error)
      health.failures++
      health.consecutiveFailures++
      health.lastError = String((error as Error)?.message || error).slice(0, 240)
      health.latencyMs = health.latencyMs ? Math.round(health.latencyMs * .75 + latency * .25) : latency
      if (blocked) {
        // Not an empty answer, so it must not accumulate empty strikes either.
        health.consecutiveEmpty = 0
        health.cooldownUntil = this.now() + this.blockedCooldownMs
        health.cooldownReason = `blocked: ${blocked}`
        this.queueSave()
        return { id: provider.id, results: [], status: { id: provider.id, status: 'blocked', latency_ms: latency, reason: blocked } as const }
      }
      if (health.consecutiveFailures >= this.failureThreshold) {
        const wait = this.bench(health, `failed ${health.consecutiveFailures} consecutive queries`)
        return { id: provider.id, results: [], status: { id: provider.id, status: 'failed', latency_ms: latency, reason: health.cooldownReason, retry_in_s: Math.round(wait / 1_000) } as const }
      }
      this.queueSave()
      return { id: provider.id, results: [], status: { id: provider.id, status: 'failed', latency_ms: latency } as const }
    } finally { release() }
  }

  /**
   * A circuit breaker with exponential backoff: a source that keeps answering
   * nothing waits twice as long each time it is benched, up to the ceiling, and any
   * success resets it. A flat cooldown made every transient blip cost minutes.
   */
  private bench(health: ProviderHealth, reason: string) {
    health.benches++
    const wait = Math.min(this.cooldownMs * 2 ** (health.benches - 1), this.maxCooldownMs)
    health.cooldownUntil = this.now() + wait
    health.cooldownReason = reason
    return wait
  }

  /** How unattractive a source looks right now: failures first, then empties, then latency. */
  private providerScore(id: string) {
    const health = this.getHealth(id)
    return health.consecutiveFailures * 100_000 + health.consecutiveEmpty * 5_000 + health.latencyMs
  }

  private getHealth(id: string) {
    let value = this.health.get(id)
    if (!value) {
      value = { failures: 0, successes: 0, consecutiveFailures: 0, emptyResponses: 0, consecutiveEmpty: 0, benches: 0, cooldownUntil: 0, latencyMs: 0 }
      this.health.set(id, value)
    }
    return value
  }

  private async load() {
    if (!this.storageFile) return
    if (!this.loaded) this.loaded = this.readState()
    await this.loaded
  }

  private async readState() {
    try {
      const state = JSON.parse(await readFile(this.storageFile!, 'utf8')) as PersistedState
      if (state.version !== 1) return
      for (const [id, value] of Object.entries(state.health || {})) this.health.set(id, normalizeHealth(value))
      for (const [key, value] of Object.entries(state.cache || {})) this.cache.set(key, value)
      this.trimCache()
    } catch {}
  }

  private trimCache() {
    const now = this.now(), ordered = [...this.cache.entries()].filter(([, value]) => now - value.createdAt <= this.cacheTtlMs).sort((a, b) => b[1].createdAt - a[1].createdAt)
    this.cache.clear()
    for (const [key, value] of ordered.slice(0, this.maxCacheEntries)) this.cache.set(key, value)
  }

  private queueSave() {
    if (!this.storageFile || this.saveQueued) return
    this.saveQueued = true
    queueMicrotask(() => {
      this.saveQueued = false
      this.saving = this.saving.then(() => this.save()).catch(() => {})
    })
  }

  private async save() {
    const state: PersistedState = { version: 1, health: Object.fromEntries(this.health), cache: Object.fromEntries(this.cache) }
    await mkdir(dirname(this.storageFile!), { recursive: true })
    const temporary = `${this.storageFile}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
    await rename(temporary, this.storageFile!)
  }
}

/**
 * Persisted health from an older build may lack the counters this version
 * writes. An absent counter would make `consecutiveEmpty++` NaN, which compares
 * false forever and would silently disable the empty-source breaker.
 */
function normalizeHealth(value: Partial<ProviderHealth> | undefined): ProviderHealth {
  const count = (input: unknown) => Number.isFinite(Number(input)) ? Math.max(0, Math.floor(Number(input))) : 0
  return {
    failures: count(value?.failures),
    successes: count(value?.successes),
    consecutiveFailures: count(value?.consecutiveFailures),
    benches: count(value?.benches),
    emptyResponses: count(value?.emptyResponses),
    consecutiveEmpty: count(value?.consecutiveEmpty),
    cooldownUntil: count(value?.cooldownUntil),
    latencyMs: count(value?.latencyMs),
    ...(value?.lastError ? { lastError: String(value.lastError).slice(0, 240) } : {}),
    ...(value?.cooldownReason ? { cooldownReason: String(value.cooldownReason).slice(0, 120) } : {}),
  }
}

function normalizeKey(value: string) {
  const normalized = value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(normalized).digest('hex')
}

function candidateKey(candidate: SearchCandidate) {
  try {
    const url = new URL(String(candidate.url || ''))
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) if (/^(?:utm_.+|fbclid|gclid|ref)$/i.test(key)) url.searchParams.delete(key)
    return url.href.replace(/\/$/, '')
  } catch { return '' }
}

export function fuseCandidates(rows: Array<{ provider: string; rank: number; candidate: SearchCandidate }>) {
  const fused = new Map<string, { score: number; providers: Set<string>; candidate: SearchCandidate; first: number }>()
  rows.forEach((row, index) => {
    const key = candidateKey(row.candidate)
    if (!key) return
    const current = fused.get(key) || { score: 0, providers: new Set<string>(), candidate: row.candidate, first: index }
    current.score += 1 / (60 + row.rank + 1)
    current.providers.add(row.provider)
    if (String(row.candidate.title || '').length > String(current.candidate.title || '').length) current.candidate = row.candidate
    fused.set(key, current)
  })
  return [...fused.values()].sort((a, b) => b.providers.size - a.providers.size || b.score - a.score || a.first - b.first).map(item => ({
    ...item.candidate,
    engine: [...item.providers].filter(provider => provider !== 'cache').join(',') || String(item.candidate.engine || 'cache'),
  }))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs) }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}
