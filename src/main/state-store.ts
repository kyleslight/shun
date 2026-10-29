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
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname } from 'node:path'
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

export class SavedStateStore {
  private cache: { mtimeMs: number; size: number; state: SavedState } | null = null
  /** Task id → the bytes that task was last written as. */
  private readonly serialized = new Map<string, { task: Task; bytes: Buffer }>()
  private writes: Promise<unknown> = Promise.resolve()
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

  private async readStored(): Promise<SavedState | null> {
    const current = await this.stamp()
    if (current && this.cache && this.cache.mtimeMs === current.mtimeMs && this.cache.size === current.size) return this.cache.state
    for (const name of [this.file, `${this.file}.backup`]) try {
      const info = name === this.file ? current : await this.stamp(name)
      if (!info) continue
      const parsed = JSON.parse(await readFile(name, 'utf8')) as SavedState
      if (!Array.isArray(parsed.tasks) || !parsed.settings) continue
      parsed.settings = this.normalizeSettings(parsed.settings)
      if (name === this.file) this.cache = { mtimeMs: info.mtimeMs, size: info.size, state: parsed }
      return parsed
    } catch {}
    return null
  }

  /** Replace the store with what the window just described in full. */
  save(state: SavedState): Promise<void> {
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
    return this.enqueue(async () => {
      const state = await this.readStored()
      if (!state) return { ok: false as const, needsFull: true as const }
      const held = new Map(state.tasks.map(task => [task.id, task]))
      for (const task of delta.tasks) held.set(task.id, task)
      // A task the window lists that the store has neither held nor been handed means the two
      // have drifted apart — a window that restarted from an older file, a store replaced
      // under it — and the honest answer then is to ask for everything rather than to write a
      // store that is missing a conversation.
      for (const id of delta.order) if (!held.has(id)) return { ok: false as const, needsFull: true as const }
      const tasks: Task[] = []
      for (const id of delta.order) { const task = held.get(id); if (task) tasks.push(task) }
      const next: SavedState = {
        settings: delta.settings ? this.normalizeSettings(delta.settings) : state.settings,
        currentId: delta.currentId,
        tasks: mergeAssistantTasks(state.tasks, tasks),
      }
      await this.write(next)
      return { ok: true as const }
    })
  }

  /**
   * Read, change, write — for the answers that are not the window's to give, such as a
   * plugin being installed or withdrawn. The change edits the store in place, which is
   * the copy every later read returns.
   */
  mutate(change: (state: SavedState) => SavedState | void): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.readStored()
      if (!state) throw Error('Shun task state is unavailable.')
      const next = change(state) || state
      // A change edits the store in place, which is the one thing remembered bytes cannot
      // see: they were taken from these objects before they were edited.
      this.serialized.clear()
      await this.write(next)
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

  private async write(state: SavedState) {
    const temp = `${this.file}.tmp`
    await mkdir(dirname(this.file), { recursive: true })
    try {
      await writeJsonInSlices(temp, this.chunks(state))
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
    await rename(temp, this.file)
    const written = await this.stamp()
    this.cache = written ? { mtimeMs: written.mtimeMs, size: written.size, state } : null
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
  private async *chunks(state: SavedState) {
    yield Buffer.from(`{"settings":${JSON.stringify(state.settings)},"currentId":${JSON.stringify(state.currentId || '')},"tasks":[`)
    let first = true
    for (const task of state.tasks) {
      const held = this.serialized.get(task.id)
      let bytes = held && held.task === task ? held.bytes : undefined
      if (!bytes) {
        bytes = Buffer.from(JSON.stringify(task))
        this.serialized.set(task.id, { task, bytes })
      }
      yield first ? bytes : Buffer.concat([Buffer.from(','), bytes])
      first = false
    }
    yield Buffer.from(']}\n')
  }
}

async function writeJsonInSlices(file: string, chunks: AsyncIterable<string | Buffer>) {
  const stream = createWriteStream(file)
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
