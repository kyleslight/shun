import { createReadStream } from 'node:fs'
import { appendFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

/**
 * How much history before the compaction window stays in the session file.
 *
 * Compaction bounds what the model reads, not what the session keeps: a
 * conversation that had compacted down to a few dozen entries still carried
 * every entry it had ever written, and every one of them was parsed into the
 * main process on each run. The window below is what an edit can still reach
 * back to without a restore; older entries are already summarized, so the model
 * never needs them.
 */
const RETAINED_BYTES = 8 * 1024 * 1024

type Entry = Record<string, any>

const archivePath = (path: string) => `${path}.archive.jsonl`

async function readEntries(path: string): Promise<Entry[]> {
  const entries: Entry[] = []
  const reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      if (!line.trim()) continue
      try { entries.push(JSON.parse(line)) } catch { /* a malformed line is already invisible to the loader */ }
    }
  } finally { reader.close() }
  return entries
}

/** The entries the current leaf actually descends from, newest first. */
function branchOf(entries: Entry[]): Entry[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const branch: Entry[] = []
  let current: Entry | undefined = entries[entries.length - 1]
  while (current) {
    branch.push(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return branch
}

/**
 * Drop entries the last compaction has already summarized.
 *
 * The file stays a valid session: the header, the compaction entry and
 * everything it kept are untouched, and the retained window keeps recent edits
 * working. Only the summarized past goes, which is the part that made a long
 * conversation cost more memory on every run. What goes is kept beside the
 * session, so an edit that reaches further back can still be honoured.
 */
export async function pruneSessionFile(path: string, retainedBytes = RETAINED_BYTES): Promise<boolean> {
  const entries = await readEntries(path)
  if (entries.length < 2) return false
  const compaction = [...entries].reverse().find(entry => entry.type === 'compaction')
  if (!compaction) return false
  // An edit can branch from before the last compaction, which then sits on a
  // path the leaf no longer descends from. Pruning against it would drop entries
  // the live branch still needs, so only a compaction on the current branch
  // decides what is safe to remove.
  if (!branchOf(entries).some(entry => entry.id === compaction.id)) return false
  const firstKept = entries.findIndex(entry => entry.id === compaction.firstKeptEntryId)
  if (firstKept < 1) return false
  let start = firstKept, retained = 0
  while (start > 1 && retained < retainedBytes) {
    retained += JSON.stringify(entries[start - 1]).length
    start--
  }
  if (start <= 1) return false
  const dropped = entries.slice(1, start), kept = [entries[0], ...entries.slice(start)]
  const temporary = `${path}.${process.pid}.pruning`
  try {
    // The archive is written first: a rewrite that fails leaves a duplicate
    // rather than a lost entry, and a restore skips ids it already has.
    await appendFile(archivePath(path), `${dropped.map(entry => JSON.stringify(entry)).join('\n')}\n`)
    await writeFile(temporary, `${kept.map(entry => JSON.stringify(entry)).join('\n')}\n`)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return true
}

/**
 * Put the summarized past back, for an edit that reaches before the window.
 *
 * The entries return in their original order, so the branch an edit starts from
 * still has the parents it expects.
 */
export async function restoreArchivedEntries(path: string): Promise<boolean> {
  let content: string
  try { content = await readFile(archivePath(path), 'utf8') } catch { return false }
  const archived: Entry[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try { archived.push(JSON.parse(line)) } catch { /* skip */ }
  }
  if (!archived.length) return false
  const current = await readEntries(path)
  if (!current.length) return false
  const present = new Set(current.map(entry => entry.id))
  const merged = [current[0], ...archived.filter(entry => !present.has(entry.id)), ...current.slice(1)]
  await writeFile(path, `${merged.map(entry => JSON.stringify(entry)).join('\n')}\n`)
  await rm(archivePath(path), { force: true })
  return true
}
