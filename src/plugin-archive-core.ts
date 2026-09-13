import { createHash } from 'node:crypto'
import { unzipSync, zipSync, type Zippable } from 'fflate'

/**
 * The `.shunplugin` format at the byte level, with no filesystem dependency.
 *
 * The application reads and writes packages through this module, and so does the
 * registry: an upload is unpacked, checked, and digested by the same code that
 * will later run on the machine that installs it. Only the pure layer lives
 * here — writing the extracted files is the caller's business.
 *
 * Two digests travel with a package:
 *
 * - `sha256` covers the archive bytes. It is what a registry publishes and what a
 *   client checks before extracting anything.
 * - `contentSha256` covers the package tree, and is identical for a directory, an
 *   archive, and the tree extracted from that archive.
 */

export const pluginArchiveExtension = '.shunplugin'

/** Installable package budget, enforced both when packing and when extracting. */
export const maxPackageFiles = 400
export const maxPackageBytes = 25 * 1024 * 1024

/**
 * A zip may expand, but never without bound. Plugin packages are code, markup,
 * and icons; 25 MB of that cannot honestly reach 100 MB uncompressed.
 */
export const maxExpandedBytes = 100 * 1024 * 1024

/** Fixed so archive bytes are reproducible; DOS time cannot represent 1970. */
const archiveMtime = new Date(1980, 0, 1)

export type PluginTreeDigest = { sha256: string; files: number; bytes: number }

export function sha256Of(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function assertArchiveEntry(name: string) {
  const entry = String(name || '')
  if (!entry || entry.length > 200 || entry.includes('\\') || entry.includes('\0')) throw Error('Plugin archive contains an invalid entry name.')
  if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) throw Error(`Plugin archive entry must be package-relative: ${entry}`)
  const segments = entry.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw Error(`Plugin archive entry must stay inside the package: ${entry}`)
}

/**
 * Packages as a relative path to bytes map, in the walk order the rest of the
 * system uses: every directory level sorted by name, depth first. Archive bytes
 * and content digests both depend on that order, so it is reproduced here rather
 * than left to whichever map the caller happens to build.
 */
export function orderPluginEntries(files: ReadonlyMap<string, Uint8Array>) {
  const tree = new Map<string, Node>()
  type Node = { file?: Uint8Array; children: Map<string, Node> }
  for (const [path, bytes] of files) {
    const segments = String(path).split('/')
    let node = { children: tree } as { file?: Uint8Array; children: Map<string, Node> }
    for (const segment of segments.slice(0, -1)) {
      const next = node.children.get(segment) || { children: new Map<string, Node>() }
      node.children.set(segment, next)
      node = next
    }
    node.children.set(segments[segments.length - 1], { file: bytes, children: new Map() })
  }

  const ordered: { path: string; bytes: Uint8Array }[] = []
  const walk = (children: Map<string, Node>, prefix: string) => {
    for (const name of [...children.keys()].sort()) {
      const node = children.get(name)!
      const path = prefix ? `${prefix}/${name}` : name
      if (node.file) ordered.push({ path, bytes: node.file })
      else walk(node.children, path)
    }
  }
  walk(tree, '')
  return ordered
}

/** Content digest of an ordered package tree. */
export function pluginTreeDigest(files: ReadonlyMap<string, Uint8Array>): PluginTreeDigest {
  const ordered = orderPluginEntries(files)
  const hash = createHash('sha256')
  let bytes = 0
  for (const file of ordered) {
    bytes += file.bytes.byteLength
    hash.update(`file\0${file.path}\0${file.bytes.byteLength}\0`)
    hash.update(file.bytes)
  }
  hash.update(`files\0${ordered.length}\0`)
  return { sha256: hash.digest('hex'), files: ordered.length, bytes }
}

export function assertPluginPackageBudget(files: ReadonlyMap<string, Uint8Array>) {
  if (!files.size) throw Error('Plugin package directory is empty.')
  if (files.size > maxPackageFiles) throw Error(`Plugin package must contain at most ${maxPackageFiles} files.`)
  let bytes = 0
  for (const value of files.values()) bytes += value.byteLength
  if (bytes > maxPackageBytes) throw Error(`Plugin package must stay under ${Math.round(maxPackageBytes / 1024 / 1024)} MB.`)
  return bytes
}

/** Deterministic archive bytes: stable entry order, one fixed timestamp. */
export function buildPluginArchive(files: ReadonlyMap<string, Uint8Array>) {
  assertPluginPackageBudget(files)
  const zippable: Zippable = {}
  for (const file of orderPluginEntries(files)) zippable[file.path] = file.bytes
  return zipSync(zippable, { level: 6, mtime: archiveMtime })
}

/**
 * Unpack and validate an archive without touching the filesystem. Every entry is
 * checked before it is decompressed, so a hostile archive cannot write anywhere
 * even transiently, and the budget is enforced as it is read.
 */
export function readPluginArchive(bytes: Uint8Array, expected: { sha256?: string; contentSha256?: string } = {}) {
  if (!bytes.length) throw Error('Plugin archive is empty.')
  if (bytes.length > maxPackageBytes) throw Error(`Plugin archive must stay under ${Math.round(maxPackageBytes / 1024 / 1024)} MB.`)
  const sha256 = sha256Of(bytes)
  if (expected.sha256 && expected.sha256 !== sha256) throw Error('Plugin archive does not match the published digest.')

  let entries = 0
  let expanded = 0
  const unzipped = unzipSync(bytes, {
    filter: info => {
      if (String(info.name).endsWith('/')) return false
      assertArchiveEntry(info.name)
      entries += 1
      expanded += info.originalSize
      if (entries > maxPackageFiles) throw Error(`Plugin archive must contain at most ${maxPackageFiles} files.`)
      if (expanded > maxExpandedBytes) throw Error('Plugin archive expands beyond the installable size budget.')
      return true
    },
  })

  const files = new Map<string, Uint8Array>()
  for (const [name, data] of Object.entries(unzipped)) files.set(name, data)
  if (!files.size) throw Error('Plugin archive contains no files.')
  assertPluginPackageBudget(files)
  const content = pluginTreeDigest(files)
  if (expected.contentSha256 && expected.contentSha256 !== content.sha256) throw Error('Extracted plugin package does not match its published content digest.')
  return { files, sha256, contentSha256: content.sha256, files_count: content.files, contentBytes: content.bytes, archiveBytes: bytes.byteLength }
}

/** The validated `manifest.json` of a package that has already been read. */
export function pluginArchiveManifest(files: ReadonlyMap<string, Uint8Array>) {
  const entry = files.get('manifest.json')
  if (!entry) throw Error('A plugin package must contain manifest.json at its root.')
  try {
    return JSON.parse(new TextDecoder().decode(entry)) as unknown
  } catch {
    throw Error('Plugin manifest.json must contain valid JSON.')
  }
}
