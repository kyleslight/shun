import { Immer } from 'immer'
import { mergeAssistantTasks } from './assistant-tasks.ts'
/**
 * The conversation store on disk, and the two things a window needs from it.
 *
 * The store is one file holding every conversation, and on a machine with a long
 * history it is large — a hundred megabytes is ordinary. What that costs is not the
 * bytes, it is the way they were moved: a window that hands the whole store back on
 * every change made the main process re-copy, re-serialize, and re-write all of it
 * for a single appended token, over and over, and the window waited behind that.
 *
 * So the store keeps the copy the window last described, applies what changed to it,
 * and writes it out in slices the process can be interrupted between. A task that has
 * not changed is serialized once and reused as bytes, because a task object is replaced
 * when it changes and never edited in place.
 */
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname, basename, join } from 'node:path'
import type { SavedState, Settings, StateSaveDelta, StateSaveOutcome, Task } from '../shared'

/**
 * Whether a save is what changed rather than the whole store.
 *
 * A payload is one or the other, and the shape decides which: a delta says so, and a full
 * store is a state.
 */
export function isStateSaveDelta(value: unknown): value is StateSaveDelta {
  const delta = value as StateSaveDelta | null
  return Boolean(delta && typeof delta === 'object' && delta.kind === 'delta' && Array.isArray(delta.order) && Array.isArray(delta.tasks) && typeof delta.currentId === 'string')
}

const stateChanges = new Immer({ autoFreeze: false })

export class SavedStateStore {
  private checkpointAt = Date.now()
  private deltaTasks = new Map<string, Task>()
  private backupWritten = false
  private publishing: Promise<void> | null = null
  private revision = 0
  private cache: { mtimeMs: number; size: number; state: SavedState } | null = null
  /** Task id → the bytes that task was last written as. */
  private readonly serialized = new Map<string, { task: Task; bytes: Buffer }>()
  private writes: Promise<unknown> = Promise.resolve()
  private reading: Promise<SavedState | null> | null = null
  private pendingDeltas: { deltas: StateSaveDelta[]; result: Promise<StateSaveOutcome> } | null = null
  private readonly file: string
  /**
   * Whatever the store has to make of settings on the way in and out — bundled installs,
   * defaults, migrations. It runs once per stored settings object, not once per read.
   */
  private readonly normalizeSettings: (settings: Settings) => Settings

  constructor(file: string, normalizeSettings: (settings: Settings) => Settings) {
    this.file = file
    this.normalizeSettings = normalizeSettings
  }

  get path() {
    return this.file
  }

  /**
   * The store as it stands, read from disk once and then remembered.
   *
   * Readers here are answers to a window — which files a conversation carries, what a
   * plugin may open, whether a scheduled task still exists — and each of them used to
   * parse the whole store again. The file's own timestamp and size decide whether the
   * remembered copy is still the file's content, so another process touching it is
   * noticed rather than missed.
   */
  async read(): Promise<SavedState | null> {
    // A reader outside the queue waits for what has already been asked for; the queue
    // itself reads through `readStored`, which is the same reading without the wait —
    // a write that waited for the write it is part of would never finish.
    await this.writes.catch(() => {})
    return this.readStored()
  }

  /** Interactive reads use the latest committed snapshot without joining the disk queue. */
  async snapshot(): Promise<SavedState | null> {
    return this.readStored()
  }

  private readStored(): Promise<SavedState | null> {
    if (this.reading) return this.reading
    const pending = this.loadStored().finally(() => {
      if (this.reading === pending) this.reading = null
    })
    this.reading = pending
    return pending
  }

  private async loadStored(): Promise<SavedState | null> {
    if (this.publishing) await this.publishing
    const revision = this.revision
    const current = await this.stamp()
    if (this.publishing) await this.publishing
    if (revision !== this.revision) return this.loadStored()
    if (current && this.cache && this.cache.mtimeMs === current.mtimeMs && this.cache.size === current.size) return this.cache.state
    // A changed file supersedes both the parsed snapshot and serialized task
    // references; retaining either while parsing keeps two full histories alive.
    this.cache = null
    this.serialized.clear()
    this.deltaTasks.clear()
    for (const name of [this.file, `${this.file}.backup`, join(dirname(this.file), basename(this.file).replace(/\.json$/, '.backup.json'))]) try {
      const info = name === this.file ? current : await this.stamp(name)
      if (!info) continue
      const parsed = JSON.parse(await readFile(name, 'utf8')) as SavedState
      if (!Array.isArray(parsed.tasks) || !parsed.settings) continue
      if (name === this.file) {
        try {
          const journal = JSON.parse(await readFile(`${this.file}.delta`, 'utf8'))
          if (journal.base === `${info.mtimeMs}:${info.size}`) {
            if (!Array.isArray(journal.tasks) || !Array.isArray(journal.order) || !journal.settings || typeof journal.currentId !== 'string' || journal.tasks.some((task: Task) => !task || typeof task.id !== 'string' || !Array.isArray(task.turns))) throw Error('Invalid recent conversation changes.')
            const tasks = new Map<string, Task>(parsed.tasks.map(task => [task.id, task]))
            for (const task of journal.tasks) tasks.set(task.id, task)
            if (new Set(journal.order).size !== journal.order.length || !journal.order.every((id: string) => typeof id === 'string' && tasks.has(id))) throw Error('Incomplete recent conversation changes.')
            {
              parsed.tasks = journal.order.map((id: string) => tasks.get(id)!)
              parsed.settings = journal.settings
              parsed.currentId = journal.currentId
              this.deltaTasks = new Map(journal.tasks.map((task: Task) => [task.id, task]))
            }
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Object.assign(Error('Shun could not restore recent conversation changes.'), { code: 'DELTA_RECOVERY_FAILED' }) }
      }
      parsed.settings = this.normalizeSettings(parsed.settings)
      if (name === this.file) this.cache = { mtimeMs: info.mtimeMs, size: info.size, state: parsed }
      return parsed
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'DELTA_RECOVERY_FAILED') throw error }
    return null
  }

  /** Replace the store with what the window just described in full. */
  save(state: SavedState): Promise<void> {
    this.pendingDeltas = null
    return this.enqueue(async () => {
      if (!Array.isArray(state.tasks) || !state.settings) throw Error('Refusing to save invalid Shun state.')
      state.settings = this.normalizeSettings(state.settings)
      const stored = await this.readStored()
      if (stored) state.tasks = mergeAssistantTasks(stored.tasks, state.tasks)
      await this.write(state)
    })
  }

  /**
   * Apply what changed to the store the window last described.
   *
   * A task the window lists that the store has never held means the two have drifted
   * apart — a window that restarted from an older file, a store replaced under it — and
   * the honest answer then is to ask for everything rather than to write a store that is
   * missing a conversation.
   */
  applyDelta(delta: StateSaveDelta): Promise<StateSaveOutcome> {
    if (this.pendingDeltas) {
      this.pendingDeltas.deltas.push(delta)
      return this.pendingDeltas.result
    }
    const batch = { deltas: [delta], result: undefined as unknown as Promise<StateSaveOutcome> }
    this.pendingDeltas = batch
    batch.result = this.enqueue(async () => {
      if (this.pendingDeltas === batch) this.pendingDeltas = null
      let next = await this.readStored()
      if (!next) return { ok: false as const, needsFull: true as const }
      const previous = next
      // Apply every description in arrival order, but persist only the final snapshot.
      // Mutations/full saves close a batch, so they remain ordering barriers.
      for (const item of batch.deltas) {
        const held: Map<string, Task> = new Map(next.tasks.map(task => [task.id, task]))
        for (const task of item.tasks) held.set(task.id, task)
        for (const id of item.order) if (!held.has(id)) return { ok: false as const, needsFull: true as const }
        const tasks: Task[] = item.order.map(id => held.get(id)!)
        next = {
          settings: item.settings ? this.normalizeSettings(item.settings) : next.settings,
          currentId: item.currentId,
          tasks: mergeAssistantTasks(next.tasks, tasks),
        }
      }
      // Large histories retain a durable, atomic delta between checkpoints.
      // Streaming one task must not rewrite every unrelated conversation.
      if (this.cache && this.cache.size > 16 * 1024 * 1024 && Date.now() - this.checkpointAt < 60_000) await this.writeDelta(previous, next)
      else await this.write(next)
      return { ok: true as const }
    })
    return batch.result
  }

  /**
   * Read, change, write — for the answers that are not the window's to give, such as a
   * plugin being installed or withdrawn. The callback edits a temporary draft; only changed branches are published.
   * Use the returned snapshot outside the callback, never retain draft references.
   */
  mutate(change: (state: SavedState) => SavedState | void): Promise<SavedState> {
    this.pendingDeltas = null
    return this.enqueue(async () => {
      const state = await this.readStored()
      if (!state) throw Error('Shun task state is unavailable.')
      const next = stateChanges.produce(state, change)
      if (next === state) return state
      if (this.cache && this.cache.size > 16 * 1024 * 1024 && Date.now() - this.checkpointAt < 60_000) await this.writeDelta(state, next)
      else await this.write(next)
      return next
    })
  }

  /** Forget the remembered copy: the file is about to be read as somebody else left it. */
  invalidate() {
    this.cache = null
  }

  /** Settle once everything already asked for has been written. */
  idle(): Promise<void> {
    return this.writes.then(() => {}, () => {})
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const queued = this.writes.catch(() => {}).then(work)
    this.writes = queued
    return queued
  }

  private async stamp(path = this.file) {
    try {
      const info = await stat(path)
      return { mtimeMs: info.mtimeMs, size: info.size }
    } catch {
      return null
    }
  }

  private async writeDelta(previous: SavedState, next: SavedState) {
    const base = this.cache!
    if (!this.backupWritten) {
      await copyFile(this.file, `${this.file}.backup`)
      this.backupWritten = true
    }
    const held = new Map(previous.tasks.map(task => [task.id, task]))
    const pending = new Map(this.deltaTasks)
    for (const task of next.tasks) if (held.get(task.id) !== task) pending.set(task.id, task)
    const ids = new Set(next.tasks.map(task => task.id))
    for (const id of pending.keys()) if (!ids.has(id)) pending.delete(id)
    const journal = { base: `${base.mtimeMs}:${base.size}`, settings: next.settings, currentId: next.currentId, order: [...ids], tasks: [...pending.values()] }
    const file = `${this.file}.delta`, temporary = `${file}.tmp`
    const chunks = this.chunks(next, journal.tasks)
    await writeJsonInSlices(temporary, (async function* () {
      yield `{"base":${JSON.stringify(journal.base)},"order":${JSON.stringify(journal.order)},`
      let first = true
      for await (const chunk of chunks) {
        yield first ? chunk.subarray(1) : chunk
        first = false
      }
    })())
    await rename(temporary, file)
    this.deltaTasks = pending
    this.cache = { ...base, state: next }
  }

  private async write(state: SavedState) {
    // Writes already share one queue. Back up the validated primary bytes once,
    // without parsing a second copy of the entire conversation history.
    if (!this.backupWritten && this.cache) {
      await copyFile(this.file, `${this.file}.backup`)
      this.backupWritten = true
    }
    const temp = `${this.file}.tmp`
    await mkdir(dirname(this.file), { recursive: true })
    try {
      await writeJsonInSlices(temp, this.chunks(state))
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
    const publication = (async () => {
      await rename(temp, this.file)
      const written = await this.stamp()
      this.cache = written ? { mtimeMs: written.mtimeMs, size: written.size, state } : null
      this.revision++
    })()
    this.publishing = publication
    try { await publication } finally { this.publishing = null }
    this.checkpointAt = Date.now()
    this.deltaTasks.clear()
    // If the process stops before removal, the new base stamp makes the old
    // journal obsolete. Readers never replay it over a newer checkpoint.
    await rm(`${this.file}.delta`, { force: true })
    const live = new Set(state.tasks.map(task => task.id))
    for (const id of [...this.serialized.keys()]) if (!live.has(id)) this.serialized.delete(id)
  }

  /**
   * The store's bytes, one task at a time.
   *
   * A task that has not been written since the last write hands back the bytes it was written
   * as, already encoded, so a store of two hundred conversations costs one conversation's
   * serialization per save instead of all of them — and the unchanged ones are never encoded
   * a second time.
   */
  private async *chunks(state: SavedState, tasks = state.tasks): AsyncGenerator<Buffer> {
    yield Buffer.from(`{"settings":${JSON.stringify(state.settings)},"currentId":${JSON.stringify(state.currentId || '')},"tasks":[`)
    let first = true
    for (const task of tasks) {
      const held = this.serialized.get(task.id)
      let bytes = held && held.task === task ? held.bytes : undefined
      if (!bytes) {
        bytes = Buffer.from(JSON.stringify(task))
        this.serialized.set(task.id, { task, bytes })
      }
      if (!first) yield Buffer.from(',')
      yield bytes
      first = false
    }
    yield Buffer.from(']}\n')
  }
}

async function writeJsonInSlices(file: string, chunks: AsyncIterable<string | Buffer>) {
  const stream = createWriteStream(file, { mode: 0o600 })
  const failed = new Promise<never>((_, reject) => stream.once('error', reject))
  try {
    for await (const chunk of chunks) {
      if (!stream.write(chunk)) await Promise.race([once(stream, 'drain'), failed])
      // The window still has questions to ask while its store is being written; a
      // hundred-megabyte file is not a reason to stop answering them.
      await new Promise(resolve => setImmediate(resolve))
    }
    stream.end()
    await Promise.race([once(stream, 'close'), failed])
  } catch (error) {
    stream.destroy()
    throw error
  }
}
