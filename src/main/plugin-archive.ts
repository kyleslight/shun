import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { unzipSync, zipSync, type Zippable } from 'fflate'

/**
 * `.shunplugin` packages: a deterministic zip of a plugin package directory,
 * plus the two digests that make a distributed package verifiable.
 *
 * - `sha256` covers the archive bytes. It is what a registry publishes and what
 *   a client checks before extracting anything.
 * - `contentSha256` covers the package tree, and is identical for a directory, an
 *   archive, and the tree extracted from that archive. It is what gets recorded
 *   beside an installed package.
 *
 * Packing the same directory twice yields the same archive bytes on the same
 * machine, because entries are walked in a stable order and every entry carries
 * one fixed timestamp.
 */

export const pluginArchiveExtension = '.shunplugin'

/** Installable package budget, enforced both when packing and when extracting. */
export const maxPackageFiles = 400
export const maxPackageBytes = 25 * 1024 * 1024

/**
 * A zip may expand, but never without bound. Plugin packages are code, markup,
 * and icons; 25 MB of that cannot honestly reach 100 MB uncompressed.
 */
const maxExpandedBytes = 100 * 1024 * 1024

/**
 * Development installs read a directory in place, which may hold a dependency
 * tree far larger than anything publishable, so they keep a much looser valve.
 */
const maxDigestFiles = 20_000
const maxDigestBytes = 512 * 1024 * 1024

/** Fixed so archive bytes are reproducible; DOS time cannot represent 1970. */
const archiveMtime = new Date(1980, 0, 1)

export type PluginDigest = { sha256: string; files: number; bytes: number; ignoredLinks: number }
export type PluginArchive = {
  /** The archive itself. */
  bytes: Uint8Array
  sha256: string
  contentSha256: string
  files: number
  /** Unpacked size, which is what the recorded provenance keeps. */
  contentBytes: number
}

function sha256Of(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Content digest of a package directory. Symbolic links are counted and
 * skipped rather than followed: an archive cannot carry them, and a development
 * checkout may legitimately contain them.
 */
export async function pluginPackageDigest(root: string): Promise<PluginDigest> {
  const target = resolve(root)
  const files: { path: string; bytes: number }[] = []
  let bytes = 0
  let ignoredLinks = 0
  const walk = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) { ignoredLinks += 1; continue }
      if (entry.isDirectory()) { await walk(path); continue }
      const info = await lstat(path)
      if (!info.isFile()) throw Error(`Unsupported plugin package entry: ${relative(target, path)}`)
      bytes += info.size
      if (files.length >= maxDigestFiles || bytes > maxDigestBytes) throw Error('Plugin package is too large to install: keep it below 512 MB and 20000 files.')
      files.push({ path: relative(target, path).split(sep).join('/'), bytes: info.size })
    }
  }
  await walk(target)
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(`file\0${file.path}\0${file.bytes}\0`)
    hash.update(await readFile(join(target, file.path)))
  }
  hash.update(`files\0${files.length}\0`)
  return { sha256: hash.digest('hex'), files: files.length, bytes, ignoredLinks }
}

/** Pack a package directory into archive bytes plus both digests. */
export async function createPluginArchive(root: string): Promise<PluginArchive> {
  const source = resolve(root)
  const files = await collectPackageFiles(source)
  const zippable: Zippable = {}
  for (const file of files) zippable[file.path] = file.bytes
  const bytes = zipSync(zippable, { level: 6, mtime: archiveMtime })
  const content = await pluginPackageDigest(source)
  return { bytes, sha256: sha256Of(bytes), contentSha256: content.sha256, files: content.files, contentBytes: content.bytes }
}

/**
 * Verify and extract an archive into an empty directory. Every entry is checked
 * before it is decompressed, so a hostile archive cannot write outside the
 * target even transiently.
 */
export async function extractPluginArchive(bytes: Uint8Array, target: string, expected: { sha256?: string; contentSha256?: string } = {}): Promise<PluginArchive> {
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

  const root = resolve(target)
  await mkdir(root, { recursive: true })
  if ((await readdir(root)).length) throw Error('Plugin archive extraction target must be empty.')
  for (const [name, data] of Object.entries(unzipped)) {
    const path = resolve(root, ...name.split('/'))
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw Error(`Plugin archive entry escapes the package root: ${name}`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data)
  }

  const content = await pluginPackageDigest(root)
  if (!content.files) throw Error('Plugin archive contains no files.')
  if (expected.contentSha256 && expected.contentSha256 !== content.sha256) throw Error('Extracted plugin package does not match its published content digest.')
  return { bytes, sha256, contentSha256: content.sha256, files: content.files, contentBytes: content.bytes }
}

/**
 * Verify an archive and extract it into private staging, outside the installed
 * plugin root. The caller inspects the staged package, obtains any permission
 * consent, installs it, and always calls `cleanup`.
 */
export async function stagePluginArchive(bytes: Uint8Array, expected: { sha256?: string; contentSha256?: string } = {}) {
  const stagingRoot = await mkdtemp(join(tmpdir(), 'shun-plugin-archive-'))
  const root = join(stagingRoot, 'package')
  try {
    const archive = await extractPluginArchive(bytes, root, expected)
    return { root, archive, cleanup: () => rm(stagingRoot, { recursive: true, force: true }) }
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true })
    throw error
  }
}

function assertArchiveEntry(name: string) {
  const entry = String(name || '')
  if (!entry || entry.length > 200 || entry.includes('\\') || entry.includes('\0')) throw Error('Plugin archive contains an invalid entry name.')
  if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) throw Error(`Plugin archive entry must be package-relative: ${entry}`)
  const segments = entry.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw Error(`Plugin archive entry must stay inside the package: ${entry}`)
}

async function collectPackageFiles(source: string) {
  const files: { path: string; bytes: Uint8Array }[] = []
  let bytes = 0
  const walk = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const relativePath = relative(source, path).split(sep).join('/')
      if (entry.isSymbolicLink()) throw Error(`Plugin packages cannot contain symbolic links: ${relativePath}`)
      if (entry.isDirectory()) { await walk(path); continue }
      if (!entry.isFile()) throw Error(`Unsupported plugin package entry: ${relativePath}`)
      const info = await lstat(path)
      bytes += info.size
      if (files.length >= maxPackageFiles) throw Error(`Plugin package must contain at most ${maxPackageFiles} files.`)
      if (bytes > maxPackageBytes) throw Error(`Plugin package must stay under ${Math.round(maxPackageBytes / 1024 / 1024)} MB.`)
      files.push({ path: relativePath, bytes: await readFile(path) })
    }
  }
  await walk(source)
  if (!files.length) throw Error('Plugin package directory is empty.')
  return files
}
