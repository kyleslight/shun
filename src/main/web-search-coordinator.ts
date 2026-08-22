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
  cooldownUntil: number
  latencyMs: number
  lastError?: string
}

type CacheEntry = { createdAt: number; results: SearchCandidate[] }
type PersistedState = { version: 1; health: Record<string, ProviderHealth>; cache: Record<string, CacheEntry> }

export type SearchCoordinationResult = {
  results: SearchCandidate[]
  cache: 'fresh' | 'miss'
  providers: Array<{ id: string; status: 'ok' | 'empty' | 'failed' | 'cooldown'; latency_ms?: number; results?: number }>
}

export type SearchCoordinatorOptions = {
  storageFile?: string
  cacheTtlMs?: number
  maxCacheEntries?: number
  maxParallel?: number
  failureThreshold?: number
  cooldownMs?: number
  now?: () => number
}

const DEFAULT_TIMEOUT = 12_000

export class FreeSearchCoordinator {
  private readonly storageFile?: string
  private readonly cacheTtlMs: number
  private readonly maxCacheEntries: number
  private readonly maxParallel: number
  private readonly failureThreshold: number
  private readonly cooldownMs: number
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
    this.maxParallel = Math.max(1, options.maxParallel ?? 2)
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 2)
    this.cooldownMs = options.cooldownMs ?? 5 * 60 * 1_000
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
    const queue = providers.slice().sort((a, b) => a.tier - b.tier || this.providerScore(a.id) - this.providerScore(b.id)).filter(provider => {
      const cooling = this.getHealth(provider.id).cooldownUntil > now
      if (cooling) status.push({ id: provider.id, status: 'cooldown' })
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

  private async runProvider(provider: SearchProvider, query: string, maxResults: number) {
    const started = this.now()
    try {
      const results = await withTimeout(provider.search(query, maxResults), provider.timeoutMs ?? DEFAULT_TIMEOUT, provider.id)
      const latency = Math.max(0, this.now() - started), health = this.getHealth(provider.id)
      health.successes++
      health.consecutiveFailures = 0
      health.cooldownUntil = 0
      health.lastError = undefined
      health.latencyMs = health.latencyMs ? Math.round(health.latencyMs * .75 + latency * .25) : latency
      this.queueSave()
      return { id: provider.id, results, status: { id: provider.id, status: results.length ? 'ok' : 'empty', latency_ms: latency, results: results.length } as const }
    } catch (error) {
      const latency = Math.max(0, this.now() - started), health = this.getHealth(provider.id)
      health.failures++
      health.consecutiveFailures++
      health.lastError = String((error as Error)?.message || error).slice(0, 240)
      health.latencyMs = health.latencyMs ? Math.round(health.latencyMs * .75 + latency * .25) : latency
      if (health.consecutiveFailures >= this.failureThreshold) health.cooldownUntil = this.now() + this.cooldownMs
      this.queueSave()
      return { id: provider.id, results: [], status: { id: provider.id, status: 'failed', latency_ms: latency } as const }
    }
  }

  private providerScore(id: string) {
    const health = this.getHealth(id)
    return health.consecutiveFailures * 100_000 + health.latencyMs
  }

  private getHealth(id: string) {
    let value = this.health.get(id)
    if (!value) {
      value = { failures: 0, successes: 0, consecutiveFailures: 0, cooldownUntil: 0, latencyMs: 0 }
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
      for (const [id, value] of Object.entries(state.health || {})) this.health.set(id, value)
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
