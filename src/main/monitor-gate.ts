import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { MonitorSource, MonitorConfig } from '../shared.ts'
export type { MonitorSource, MonitorConfig } from '../shared.ts'
export type MonitorSnapshot = { cursor: string; events: string[] }
type Pending = MonitorSnapshot & { id: string }
type RecordState = { source: string; cursor?: string; pending?: Pending; checkedAt?: number; failures?: number; retryAt?: number; errorId?: string }
export type MonitorProbe = (source: MonitorSource, cursor?: string) => Promise<MonitorSnapshot>

/** Durable change detection/outbox. It never runs a model or owns an agent session. */
export class MonitorGate {
  #records: Record<string, RecordState> = {}
  #ready = false
  #write = Promise.resolve()
  #checks = new Map<string, Promise<Pending | undefined>>()
  private readonly file: string
  private readonly probe: MonitorProbe
  private readonly now: () => number
  constructor(file: string, probe: MonitorProbe, now = Date.now) { this.file = file; this.probe = probe; this.now = now }
  async init() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'))
      if (data.version !== 1 || !data.records || typeof data.records !== 'object') throw Error('Invalid monitoring state.')
      this.#records = data.records
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.#ready = true
  }
  health(id: string) { const record = this.#records[id]; return record ? { checkedAt: record.checkedAt, retryAt: record.retryAt, errorId: record.errorId } : {} }
  check(id: string, config: MonitorConfig): Promise<Pending | undefined> {
    const active = this.#checks.get(id)
    if (active) return active
    const check = this.#check(id, config).finally(() => this.#checks.delete(id))
    this.#checks.set(id, check)
    return check
  }
  async #check(id: string, config: MonitorConfig) {
    if (!this.#ready) throw Error('Monitoring checkpoints could not be loaded.')
    const source = JSON.stringify(config.source)
    const previous = this.#records[id]
    const record = previous?.source === source ? previous : { source }
    if (record.retryAt && record.retryAt > this.now()) throw Error('Monitoring is waiting to retry its connection.')
    if (record.pending) return this.#batch(record.pending)
    let snapshot: MonitorSnapshot
    try {
      snapshot = await this.probe(config.source, record.cursor)
      if (!snapshot.cursor) throw Error('Monitoring source returned no checkpoint.')
    } catch (error) {
      const failures = (record.failures || 0) + 1
      await this.#save(id, { ...record, failures, errorId: record.errorId || randomUUID(), retryAt: this.now() + Math.min(900000, 30000 * 2 ** Math.min(failures - 1, 5)) })
      throw error
    }
    // The initial snapshot is a baseline, not a new event. Never silently reset
    // an existing checkpoint after a source error or an expired history cursor.
    const next: RecordState = { ...record, checkedAt: this.now(), failures: undefined, retryAt: undefined, errorId: undefined }
    if (record.cursor !== undefined && snapshot.events.length) {
      next.pending = { ...snapshot, id: randomUUID() }
    } else next.cursor = snapshot.cursor
    await this.#save(id, next)
    return next.pending ? this.#batch(next.pending) : undefined
  }
  async fail(id: string, eventId: string) {
    const record = this.#records[id]
    if (record?.pending?.id !== eventId) return
    const failures = (record.failures || 0) + 1
    await this.#save(id, { ...record, failures, errorId: record.errorId || randomUUID(), retryAt: this.now() + Math.min(900000, 30000 * 2 ** Math.min(failures - 1, 5)) })
  }
  async complete(id: string, eventId: string) {
    const held = this.#records[id]
    if (held?.pending?.id !== eventId) return
    const current = { ...held, pending: held.pending, failures: undefined, retryAt: undefined, errorId: undefined }
    const remaining = current.pending.events.slice(this.#batch(current.pending).events.length)
    await this.#save(id, remaining.length
      ? { ...current, pending: { ...current.pending, id: randomUUID(), events: remaining } }
      : { ...current, cursor: current.pending.cursor, pending: undefined })
  }
  #batch(pending: Pending): Pending {
    const events: string[] = []
    let size = 0
    for (const event of pending.events) {
      if (events.length && size + event.length > 12000) break
      events.push(event.slice(0, 12000))
      size += event.length
    }
    return { ...pending, events }
  }
  async #save(id: string, record: RecordState) {
    const write = this.#write.catch(() => {}).then(async () => {
      const next = { ...this.#records, [id]: record }
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file + '.tmp', JSON.stringify({ version: 1, records: next }), { mode: 0o600 })
      await rename(this.file + '.tmp', this.file)
      this.#records = next
    })
    this.#write = write
    await write
  }
}

export function normalizeMonitor(value: MonitorConfig): MonitorConfig {
  if (value.delivery !== 'notify' && value.delivery !== 'evaluate') throw Error('Choose notify or evaluate for monitoring.')
  if (value.source?.kind === 'gmail') return { source: { kind: 'gmail' }, delivery: value.delivery }
  if (value.source?.kind === 'http') {
    const url = new URL(value.source.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Use an HTTP URL without embedded credentials.')
    return { source: { kind: 'http', url: url.href }, delivery: value.delivery }
  }
  throw Error('Unsupported monitoring source.')
}

/** Conditional HTTP reads are bounded; changing pages should expose a stable feed. */
export async function probeHttp(url: string, cursor: string | undefined, fetcher: typeof fetch): Promise<MonitorSnapshot> {
  const old = cursor ? JSON.parse(cursor) as { hash: string; etag?: string; modified?: string } : undefined
  const headers = new Headers()
  if (old?.etag) headers.set('if-none-match', old.etag)
  else if (old?.modified) headers.set('if-modified-since', old.modified)
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(20_000) })
  if (response.status === 304 && cursor) return { cursor, events: [] }
  if (!response.ok) throw Error(`Monitoring request failed (${response.status}).`)
  if (!response.body) throw Error('Monitoring source returned no content.')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 1_000_000) throw Error('Monitoring source exceeds the 1 MB feed limit.')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const body = Buffer.concat(chunks), hash = createHash('sha256').update(body).digest('hex')
  return { cursor: JSON.stringify({ hash, etag: response.headers.get('etag') || undefined, modified: response.headers.get('last-modified') || undefined }),
    events: old && old.hash !== hash ? [`Source changed: ${url}\n\n${body.toString('utf8').slice(0, 12000)}`] : [] }
}

export function monitorNotice(source: MonitorSource, events: string[]): string {
  if (source.kind !== 'gmail') return events.join('\n\n').slice(0, 12000)
  return events.map(event => {
    try {
      const message = JSON.parse(event)
      const headers = Object.fromEntries(Object.entries(message.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]))
      return `${headers.subject || 'New mail'}\n${headers.from || ''}\n\n${message.snippet || ''}\n\nhttps://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.threadId || message.id)}`
    } catch { return event }
  }).join('\n\n').slice(0, 12000)
}
