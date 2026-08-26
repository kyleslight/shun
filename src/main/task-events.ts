import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TaskEventEnvelope, TaskProductEvent } from '../shared.ts'

type Listener = (event: TaskEventEnvelope) => void

/**
 * Durable, task-scoped event tails for renderer recovery and remote clients.
 * Pi remains the transcript source of truth; this store is the product event
 * projection used to observe active work without coupling consumers to a
 * particular renderer process.
 */
export class TaskEventStore {
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
    let raw = ''
    try { raw = await readFile(this.path(taskId), 'utf8') } catch { return [] }
    const rows: TaskEventEnvelope[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const event = JSON.parse(line) as TaskEventEnvelope
        if (event.taskId === taskId && Number.isInteger(event.seq) && event.seq > afterSeq) rows.push(event)
      } catch {}
    }
    return rows.slice(0, Math.min(2_000, Math.max(1, Math.floor(limit) || 500)))
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
    await rm(this.path(taskId), { force: true })
  }

  path(taskIdValue: string) {
    return join(this.#root, `${validTaskId(taskIdValue)}.jsonl`)
  }

  async #nextSequence(taskId: string) {
    const known = this.#sequences.get(taskId)
    if (known !== undefined) return known + 1
    let last = 0
    try {
      const raw = await readFile(this.path(taskId), 'utf8')
      for (const line of raw.trim().split('\n').reverse()) {
        try {
          const event = JSON.parse(line) as TaskEventEnvelope
          if (event.taskId === taskId && Number.isInteger(event.seq)) { last = event.seq; break }
        } catch {}
      }
    } catch {}
    return last + 1
  }
}

function validTaskId(value: string) {
  const taskId = String(value || '')
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(taskId)) throw Error('Invalid task ID.')
  return taskId
}
