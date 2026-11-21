import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TimelineEntry } from '../shared.ts'

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/

/**
 * Per-turn activity logs, kept beside the conversation store.
 *
 * A turn's timeline is what the conversation shows between a message and its
 * answer — the tool calls, their arguments and output, the streamed text. It is
 * the largest thing a conversation holds: measured on a real machine, 366 MB of
 * a 407 MB store, and 80,256 tool entries of which the outputs alone were
 * 277 MB. Keeping it inside the store meant every one of those bytes was parsed
 * into the main process and re-serialized on every save, for conversations that
 * were not even open.
 *
 * It is read only when a conversation is opened, so it lives in its own file.
 */
export class TimelineStore {
  readonly root: string
  constructor(root: string) { this.root = root }

  private path(taskId: string) { return join(this.root, `${taskId}.json`) }

  async read(taskId: string): Promise<Record<string, TimelineEntry[]>> {
    if (!SAFE_ID.test(taskId)) return {}
    try {
      const parsed = JSON.parse(await readFile(this.path(taskId), 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, TimelineEntry[]> : {}
    } catch { return {} }
  }

  /**
   * Replace the turns this task describes, leaving turns it does not mention.
   *
   * A window that never opened a conversation holds its turns without their
   * timelines, and saving it must not erase what it never read.
   */
  async write(taskId: string, timelines: Record<string, TimelineEntry[]>) {
    if (!SAFE_ID.test(taskId) || !Object.keys(timelines).length) return
    await mkdir(this.root, { recursive: true })
    const path = this.path(taskId), temporary = `${path}.${process.pid}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(timelines))
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  async remove(taskId: string) {
    if (!SAFE_ID.test(taskId)) return
    await rm(this.path(taskId), { force: true })
  }
}
