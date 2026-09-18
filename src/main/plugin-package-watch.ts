/**
 * Plugin packages are data on disk, so they must not require a restart to be
 * seen. This watches both package roots — the bundled one that ships with the
 * application and the one that holds installed packages — and reports when the
 * set of packages or any package's contents changed.
 *
 * A signature, rather than a version number, decides "changed": a developer
 * editing a package's UI or manifest in place must be reloaded exactly like a
 * published update, and a version bump is not the only way a package changes.
 */
import { watch as watchFileSystem, type FSWatcher } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

export type PluginPackageSignatures = Map<string, string>

export type PluginPackageChanges = { added: string[], changed: string[], removed: string[] }

const ignoredDirectories = new Set(['node_modules', '.git'])
const maxWalkEntries = 2_000

/** One signature per package id: the manifest bytes plus the newest file time. */
export async function pluginPackageSignatures(roots: string[]): Promise<PluginPackageSignatures> {
  const signatures: PluginPackageSignatures = new Map()
  for (const root of roots) {
    for (const directory of await childDirectories(root)) {
      const described = await describePackage(directory)
      if (described) signatures.set(described.id, described.signature)
    }
  }
  return signatures
}

export function pluginPackageChanges(previous: PluginPackageSignatures, next: PluginPackageSignatures): PluginPackageChanges {
  const added: string[] = [], changed: string[] = [], removed: string[] = []
  for (const [id, signature] of next) {
    if (!previous.has(id)) added.push(id)
    else if (previous.get(id) !== signature) changed.push(id)
  }
  for (const id of previous.keys()) if (!next.has(id)) removed.push(id)
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() }
}

/**
 * Debounced filesystem watch over the package roots. Recursive watching keeps a
 * nested edit inside one package visible on the platforms that support it; a
 * shallow watch is the honest fallback where recursion is unavailable, and it
 * still catches a package being added or removed.
 */
export class PluginPackageWatch {
  readonly #roots: string[]
  readonly #settle: () => void
  readonly #delayMs: number
  readonly #watchers: FSWatcher[] = []
  #timer?: NodeJS.Timeout

  constructor(options: { roots: string[], settle: () => void, delayMs?: number }) {
    this.#roots = options.roots
    this.#settle = options.settle
    this.#delayMs = options.delayMs ?? 400
  }

  start() {
    if (this.#watchers.length) return
    for (const root of this.#roots) {
      const watcher = this.#watch(root, true) || this.#watch(root, false)
      if (watcher) this.#watchers.push(watcher)
    }
  }

  stop() {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    for (const watcher of this.#watchers.splice(0)) watcher.close()
  }

  #watch(root: string, recursive: boolean) {
    try {
      const watcher = watchFileSystem(root, recursive ? { recursive: true } : {}, () => this.#schedule())
      // A deleted or replaced root must not become an unhandled error later.
      watcher.on('error', () => {})
      return watcher
    } catch { return undefined }
  }

  #schedule() {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#settle()
    }, this.#delayMs)
  }
}

async function describePackage(directory: string) {
  const manifest = await readFile(join(directory, 'manifest.json'), 'utf8').catch(() => '')
  if (!manifest) return undefined
  let id = ''
  try { id = String(JSON.parse(manifest).id || '') } catch { return undefined }
  if (!id) return undefined
  return { id, signature: `${createHash('sha256').update(manifest).digest('hex').slice(0, 16)}:${await newestWrite(directory, 3)}` }
}

/** The newest mtime in a package, bounded in depth and entry count. */
async function newestWrite(directory: string, depth: number): Promise<number> {
  let newest = 0, seen = 0
  async function walk(current: string, remaining: number) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (seen++ > maxWalkEntries) return
      if (entry.name.startsWith('.') || ignoredDirectories.has(entry.name)) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (remaining > 0) await walk(path, remaining - 1)
        continue
      }
      const info = await stat(path).catch(() => undefined)
      if (info?.isFile() && info.mtimeMs > newest) newest = info.mtimeMs
    }
  }
  await walk(directory, depth)
  return newest
}

async function childDirectories(root: string) {
  return (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => join(root, entry.name))
}

export function pluginPackageIdOfDirectory(directory: string) {
  return basename(directory)
}
