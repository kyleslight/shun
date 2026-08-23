import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

type CheckpointNode =
  | { kind: 'file'; digest: string; size: number; mode: number }
  | { kind: 'symlink'; target: string }

type CollectedNode =
  | (Extract<CheckpointNode, { kind: 'file' }> & { data?: Buffer })
  | Extract<CheckpointNode, { kind: 'symlink' }>

export type ConversationCheckpoint = {
  version: 1
  taskId: string
  messageId: string
  workspace: string
  parentEntryId: string | null
  capturedAt: number
  complete: boolean
  skipped: string[]
  files: Record<string, CheckpointNode>
}

export type ConversationCheckpointPreview = {
  available: boolean
  complete: boolean
  changedFiles: string[]
  skipped: string[]
  capturedAt?: number
  warning?: string
}

const ignoredDirectories = new Set([
  '.git', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
  'node_modules', 'dist', 'build', 'out', 'release', 'coverage', 'target',
])
const ignoredFiles = new Set(['.DS_Store'])
const maxFiles = 5_000
const maxFileBytes = 8_000_000
const maxSnapshotBytes = 64_000_000

export class ConversationCheckpointStore {
  readonly #root: string
  readonly #writes = new Map<string, Promise<unknown>>()

  constructor(root: string) {
    this.#root = root
  }

  capture(input: { taskId: string; messageId: string; workspace: string; parentEntryId: string | null }) {
    return this.#serialize(input.taskId, async () => {
      const taskId = validId(input.taskId, 'task')
      const collected = await collectFiles(input.workspace, true)
      if (collected.complete) {
        await Promise.all(Object.values(collected.files).map(async node => {
          if (node.kind !== 'file' || !node.data) return
          const path = this.blobPath(taskId, node.digest)
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, node.data, { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error
          })
        }))
      }
      const checkpoint: ConversationCheckpoint = {
        version: 1,
        taskId,
        messageId: validId(input.messageId, 'message'),
        workspace: resolve(input.workspace),
        parentEntryId: input.parentEntryId,
        capturedAt: Date.now(),
        complete: collected.complete,
        skipped: collected.skipped,
        // Partial snapshots are diagnostic only and never retain unusable file data.
        files: collected.complete ? stripData(collected.files) : {},
      }
      const path = this.path(taskId, input.messageId)
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temporary, JSON.stringify(checkpoint), { mode: 0o600 })
      await rename(temporary, path)
      return checkpoint
    })
  }

  async get(taskId: string, messageId: string) {
    try {
      const checkpoint = JSON.parse(await readFile(this.path(taskId, messageId), 'utf8')) as ConversationCheckpoint
      if (checkpoint.version !== 1 || checkpoint.taskId !== taskId || checkpoint.messageId !== messageId) return undefined
      return checkpoint
    } catch {
      return undefined
    }
  }

  async preview(taskId: string, messageId: string, workspace: string): Promise<ConversationCheckpointPreview> {
    const checkpoint = await this.get(taskId, messageId)
    if (!checkpoint || checkpoint.workspace !== resolve(workspace)) {
      return { available: false, complete: false, changedFiles: [], skipped: [], warning: 'No restorable checkpoint is available for this message.' }
    }
    const current = await collectFiles(workspace, false)
    const changedFiles = changedPaths(checkpoint.files, current.files)
    const complete = checkpoint.complete && current.complete
    return {
      available: true,
      complete,
      changedFiles,
      skipped: [...new Set([...checkpoint.skipped, ...current.skipped])].sort(),
      capturedAt: checkpoint.capturedAt,
      ...(!complete ? { warning: 'The workspace is too large or contains files that could not be checkpointed safely.' } : {}),
    }
  }

  restore(taskId: string, messageId: string, workspace: string) {
    return this.#serialize(taskId, async () => {
      const checkpoint = await this.get(taskId, messageId)
      if (!checkpoint || checkpoint.workspace !== resolve(workspace)) throw Error('No restorable checkpoint is available for this message.')
      if (!checkpoint.complete) throw Error('This checkpoint is incomplete, so Shun will not overwrite the workspace from it.')
      const current = await collectFiles(workspace, false)
      if (!current.complete) throw Error('The current workspace cannot be scanned completely, so Shun will not overwrite it.')

      // Verify every content-addressed object before changing a workspace path.
      const restoredData = new Map<string, Buffer>()
      for (const node of Object.values(checkpoint.files)) {
        if (node.kind !== 'file' || restoredData.has(node.digest)) continue
        const data = await readFile(this.blobPath(taskId, node.digest))
        if (data.byteLength !== node.size || digest(data) !== node.digest) throw Error('A conversation checkpoint object is missing or corrupt.')
        restoredData.set(node.digest, data)
      }

      const root = resolve(workspace)
      const changedFiles = changedPaths(checkpoint.files, current.files)
      const removals = Object.keys(current.files)
        .filter(name => checkpoint.files[name] === undefined)
        .sort((a, b) => pathDepth(b) - pathDepth(a))
      for (const name of removals) await rm(safePath(root, name), { recursive: true, force: true })

      const entries = Object.entries(checkpoint.files).sort(([a], [b]) => pathDepth(a) - pathDepth(b))
      for (const [name, node] of entries) {
        const path = safePath(root, name)
        if (sameNode(node, current.files[name])) continue
        await rm(path, { recursive: true, force: true })
        await ensureDirectories(root, dirname(path))
        if (node.kind === 'symlink') await symlink(node.target, path)
        else {
          await writeFile(path, restoredData.get(node.digest)!)
          await chmod(path, node.mode).catch(() => {})
        }
      }
      return { checkpoint, changedFiles }
    })
  }

  async removeTask(taskId: string) {
    const id = validId(taskId, 'task')
    await (this.#writes.get(id) || Promise.resolve()).catch(() => {})
    await rm(join(this.#root, id), { recursive: true, force: true })
  }

  path(taskId: string, messageId: string) {
    return join(this.#root, validId(taskId, 'task'), 'messages', `${validId(messageId, 'message')}.json`)
  }

  blobPath(taskId: string, digestValue: string) {
    const value = String(digestValue || '')
    if (!/^[a-f0-9]{64}$/.test(value)) throw Error('Invalid checkpoint object ID.')
    return join(this.#root, validId(taskId, 'task'), 'objects', value.slice(0, 2), value.slice(2))
  }

  #serialize<T>(taskIdValue: string, work: () => Promise<T>): Promise<T> {
    const taskId = validId(taskIdValue, 'task')
    const prior = this.#writes.get(taskId) || Promise.resolve()
    const next = prior.catch(() => {}).then(work)
    this.#writes.set(taskId, next)
    void next.finally(() => {
      if (this.#writes.get(taskId) === next) this.#writes.delete(taskId)
    }).catch(() => {})
    return next
  }
}

async function collectFiles(workspace: string, includeData: boolean) {
  const root = resolve(workspace)
  const files: Record<string, CollectedNode> = {}
  const skipped: string[] = []
  let count = 0
  let bytes = 0
  let complete = true
  async function visit(directory: string) {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch {
      complete = false
      skipped.push(normalizePath(relative(root, directory)) || '.')
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (ignoredFiles.has(entry.name)) continue
      const path = resolve(directory, entry.name)
      const name = normalizePath(relative(root, path))
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(path)
        continue
      }
      if (count >= maxFiles) {
        complete = false
        skipped.push(name)
        continue
      }
      if (entry.isSymbolicLink()) {
        try {
          files[name] = { kind: 'symlink', target: await readlink(path) }
          count++
        } catch {
          complete = false
          skipped.push(name)
        }
        continue
      }
      if (!entry.isFile()) {
        complete = false
        skipped.push(name)
        continue
      }
      try {
        const info = await stat(path)
        if (info.size > maxFileBytes || bytes + info.size > maxSnapshotBytes) {
          complete = false
          skipped.push(name)
          continue
        }
        const data = await readFile(path)
        files[name] = { kind: 'file', digest: digest(data), size: data.byteLength, mode: info.mode & 0o777, ...(includeData ? { data } : {}) }
        count++
        bytes += info.size
      } catch {
        complete = false
        skipped.push(name)
      }
    }
  }
  await visit(root)
  return { files, skipped: skipped.slice(0, 100), complete }
}

function stripData(files: Record<string, CollectedNode>): Record<string, CheckpointNode> {
  return Object.fromEntries(Object.entries(files).map(([name, node]) => [name, node.kind === 'file'
    ? { kind: 'file', digest: node.digest, size: node.size, mode: node.mode }
    : node]))
}

function changedPaths(before: Record<string, CheckpointNode>, after: Record<string, CollectedNode>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(name => !sameNode(before[name], after[name]))
    .sort()
}

function sameNode(before: CheckpointNode | undefined, after: CollectedNode | undefined) {
  if (!before || !after || before.kind !== after.kind) return false
  return before.kind === 'symlink'
    ? before.target === (after as Extract<CollectedNode, { kind: 'symlink' }>).target
    : before.digest === (after as Extract<CollectedNode, { kind: 'file' }>).digest
      && before.mode === (after as Extract<CollectedNode, { kind: 'file' }>).mode
}

async function ensureDirectories(root: string, directory: string) {
  if (directory === root) return
  const parent = dirname(directory)
  await ensureDirectories(root, parent)
  try {
    const info = await lstat(directory)
    if (info.isDirectory() && !info.isSymbolicLink()) return
    await rm(directory, { recursive: true, force: true })
  } catch {}
  await mkdir(directory)
}

function digest(data: Buffer) {
  return createHash('sha256').update(data).digest('hex')
}

function pathDepth(path: string) {
  return path.split('/').length
}

function safePath(root: string, name: string) {
  const target = resolve(root, name)
  if (target !== root && !target.startsWith(root + sep)) throw Error('Checkpoint path escapes workspace.')
  return target
}

function normalizePath(path: string) {
  return path.split(sep).join('/')
}

function validId(value: string, label: string) {
  const id = String(value || '')
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw Error(`Invalid ${label} ID.`)
  return id
}
