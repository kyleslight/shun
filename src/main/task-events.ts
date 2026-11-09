import { appendFile, mkdir, open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TaskEventEnvelope, TaskProductEvent } from '../shared.ts'

type ReadCursor = { ino: number; size: number; mtimeMs: number; offsets: Map<number, number> }
const READ_BYTES = 64 * 1024

type Listener = (event: TaskEventEnvelope) => void

/**
 * Durable, task-scoped event tails for renderer recovery and remote clients.
 * Pi remains the transcript source of truth; this store is the product event
 * projection used to observe active work without coupling consumers to a
 * particular renderer process.
 */
export class TaskEventStore {
  readonly #cursors = new Map<string, ReadCursor>()
  readonly #root: string
  readonly #allocations = new Map<string, Promise<void>>()
  readonly #writes = new Map<string, Promise<unknown>>()
  readonly #sequences = new Map<string, number>()
  readonly #listeners = new Set<Listener>()
  readonly #liveListeners = new Set<Listener>()

  constructor(root: string) {
    this.#root = root
  }

  append(taskIdValue: string, payload: TaskProductEvent): Promise<TaskEventEnvelope> {
    const taskId = validTaskId(taskIdValue)
    let event!: TaskEventEnvelope
    let write!: Promise<unknown>
    const priorAllocation = this.#allocations.get(taskId) || Promise.resolve()
    const allocation = priorAllocation.catch(() => {}).then(async () => {
      const seq = await this.#nextSequence(taskId)
      event = { taskId, seq, at: Date.now(), payload }
      this.#sequences.set(taskId, seq)
      for (const listener of this.#liveListeners) listener(event)

      const priorWrite = this.#writes.get(taskId) || Promise.resolve()
      write = priorWrite.catch(() => {}).then(async () => {
        const path = this.path(taskId)
        await mkdir(dirname(path), { recursive: true })
        await appendFile(path, `${JSON.stringify(event)}\n`)
        for (const listener of this.#listeners) listener(event)
      })
      this.#writes.set(taskId, write)
      void write.finally(() => {
        if (this.#writes.get(taskId) === write) this.#writes.delete(taskId)
      }).catch(() => {})
    })
    this.#allocations.set(taskId, allocation)
    void allocation.finally(() => {
      if (this.#allocations.get(taskId) === allocation) this.#allocations.delete(taskId)
    }).catch(() => {})
    return allocation.then(() => write.then(() => event))
  }

  async read(taskIdValue: string, afterSeq = 0, limit = 500): Promise<TaskEventEnvelope[]> {
    const taskId = validTaskId(taskIdValue)
    await (this.#allocations.get(taskId) || Promise.resolve()).catch(() => {})
    await (this.#writes.get(taskId) || Promise.resolve()).catch(() => {})
    const file = await open(this.path(taskId), 'r').catch(() => undefined)
    if (!file) return []
    try {
      const stat = await file.stat()
      const cursor = this.#cursor(taskId, stat)
      let offset = 0
      let nearest = -1
      for (const [seq, position] of cursor.offsets) {
        if (seq <= afterSeq && seq > nearest) { nearest = seq; offset = position }
      }
      const rows: TaskEventEnvelope[] = []
      const count = Math.min(2_000, Math.max(1, Math.floor(limit) || 500))
      let pending = Buffer.alloc(0)
      let lineStart = offset
      while (offset < stat.size) {
        const chunk = Buffer.allocUnsafe(Math.min(READ_BYTES, stat.size - offset))
        const { bytesRead } = await file.read(chunk, 0, chunk.length, offset)
        if (!bytesRead) break
        offset += bytesRead
        pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)])
        let start = 0
        for (let end = pending.indexOf(10); end >= 0; end = pending.indexOf(10, start)) {
          const event = parseEvent(pending.subarray(start, end), taskId)
          lineStart += end + 1 - start
          if (event) {
            this.#remember(cursor, event.seq, lineStart)
            if (event.seq > afterSeq) rows.push(event)
          }
          start = end + 1
          if (rows.length >= count) return rows
        }
        pending = pending.subarray(start)
      }
      // An unfinished final line must be reread after an append. Do not cache
      // its end, even if it currently happens to be valid JSON.
      const final = parseEvent(pending, taskId)
      if (final && final.seq > afterSeq) rows.push(final)
      return rows
    } finally { await file.close() }
  }

  #cursor(taskId: string, stat: { ino: number; size: number; mtimeMs: number }): ReadCursor {
    let cursor = this.#cursors.get(taskId)
    if (!cursor || cursor.ino !== stat.ino || stat.size < cursor.size ||
      (stat.size === cursor.size && stat.mtimeMs !== cursor.mtimeMs)) {
      cursor = { ...stat, offsets: new Map() }
    }
    cursor.size = stat.size
    cursor.mtimeMs = stat.mtimeMs
    this.#cursors.delete(taskId)
    this.#cursors.set(taskId, cursor)
    while (this.#cursors.size > 64) this.#cursors.delete(this.#cursors.keys().next().value!)
    return cursor
  }

  #remember(cursor: ReadCursor, seq: number, offset: number) {
    cursor.offsets.delete(seq)
    cursor.offsets.set(seq, offset)
    while (cursor.offsets.size > 128) cursor.offsets.delete(cursor.offsets.keys().next().value!)
  }

  /**
   * The newest sequence this task holds.
   *
   * This cannot be derived from `read`: that answers from the *oldest* events it
   * keeps, so a task with a long history reports a sequence hundreds of events
   * behind its live one. A reader that trusts that number believes everything
   * after it is missing — which is how a conversation came to replay its own
   * history instead of continuing.
   */
  async lastSequence(taskIdValue: string): Promise<number> {
    const taskId = validTaskId(taskIdValue)
    await (this.#allocations.get(taskId) || Promise.resolve()).catch(() => {})
    await (this.#writes.get(taskId) || Promise.resolve()).catch(() => {})
    return (await this.#lastWritten(taskId)) ?? 0
  }

  subscribe(listener: Listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  subscribeLive(listener: Listener) {
    this.#liveListeners.add(listener)
    return () => this.#liveListeners.delete(listener)
  }

  async remove(taskIdValue: string) {
    const taskId = validTaskId(taskIdValue)
    await (this.#allocations.get(taskId) || Promise.resolve()).catch(() => {})
    await (this.#writes.get(taskId) || Promise.resolve()).catch(() => {})
    this.#allocations.delete(taskId)
    this.#writes.delete(taskId)
    this.#sequences.delete(taskId)
    this.#cursors.delete(taskId)
    await rm(this.path(taskId), { force: true })
  }

  path(taskIdValue: string) {
    return join(this.#root, `${validTaskId(taskIdValue)}.jsonl`)
  }

  async #nextSequence(taskId: string) {
    return ((await this.#lastWritten(taskId)) ?? 0) + 1
  }

  /** The newest sequence on disk, read from the end of the log and nothing else. */
  async #lastWritten(taskId: string): Promise<number | undefined> {
    const known = this.#sequences.get(taskId)
    if (known !== undefined) return known
    const file = await open(this.path(taskId), 'r').catch(() => undefined)
    if (!file) return undefined
    try {
      const stat = await file.stat()
      const cursor = this.#cursor(taskId, stat)
      let position = stat.size
      let pending = Buffer.alloc(0)
      while (position > 0) {
        const start = Math.max(0, position - READ_BYTES)
        const chunk = Buffer.allocUnsafe(position - start)
        const { bytesRead } = await file.read(chunk, 0, chunk.length, start)
        if (bytesRead !== chunk.length) return undefined
        pending = Buffer.concat([chunk, pending])
        position = start
        let end = pending.length
        for (let newline = pending.lastIndexOf(10, end - 1); newline >= 0;) {
          const event = parseEvent(pending.subarray(newline + 1, end), taskId)
          if (event) {
            if (pending[end] === 10) this.#remember(cursor, event.seq, position + end + 1)
            return event.seq
          }
          end = newline
          newline = end > 0 ? pending.lastIndexOf(10, end - 1) : -1
        }
        if (position === 0) {
          const event = parseEvent(pending.subarray(0, end), taskId)
          if (event && pending[end] === 10) this.#remember(cursor, event.seq, end + 1)
          return event?.seq
        }
        pending = pending.subarray(0, end)
      }
      return undefined
    } finally { await file.close() }
  }
}

function parseEvent(line: Buffer, taskId: string): TaskEventEnvelope | undefined {
  if (!line.length) return undefined
  try {
    const event = JSON.parse(line.toString('utf8')) as TaskEventEnvelope
    if (event && event.taskId === taskId && Number.isInteger(event.seq)) return event
  } catch {}
  return undefined
}

function validTaskId(value: string) {
  const taskId = String(value || '')
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(taskId)) throw Error('Invalid task ID.')
  return taskId
}
