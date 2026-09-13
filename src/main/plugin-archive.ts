import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { buildPluginArchive, pluginArchiveExtension, pluginTreeDigest, readPluginArchive, sha256Of } from '../plugin-archive-core.ts'

/**
 * Filesystem side of `.shunplugin`. The format itself — entry validation, the
 * content digest, and the deterministic packing order — lives in
 * `plugin-archive-core.ts`, which the registry also uses, so an archive written
 * here and an archive checked on a server cannot drift apart.
 */

export { pluginArchiveExtension, maxPackageFiles, maxPackageBytes } from '../plugin-archive-core.ts'
export type { PluginTreeDigest } from '../plugin-archive-core.ts'

/**
 * Development installs read a directory in place, which may hold a dependency
 * tree far larger than anything publishable, so they keep a much looser valve
 * than the packer's budget.
 */
const maxDigestFiles = 20_000
const maxDigestBytes = 512 * 1024 * 1024

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

/**
 * Read a package directory into the map the pure layer works on. Packing
 * refuses symbolic links outright — a distributed package must not silently
 * drop files — while a digest skips them, because a development checkout may
 * legitimately contain them.
 */
async function readPackageDirectory(root: string, links: 'skip' | 'reject' = 'skip') {
  const target = resolve(root)
  const files = new Map<string, Uint8Array>()
  let bytes = 0
  let ignoredLinks = 0
  const walk = async (directory: string) => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const relativePath = relative(target, path).split(sep).join('/')
      if (entry.isSymbolicLink()) {
        if (links === 'reject') throw Error(`Plugin packages cannot contain symbolic links: ${relativePath}`)
        ignoredLinks += 1
        continue
      }
      if (entry.isDirectory()) { await walk(path); continue }
      const info = await lstat(path)
      if (!info.isFile()) throw Error(`Unsupported plugin package entry: ${relativePath}`)
      bytes += info.size
      if (files.size >= maxDigestFiles || bytes > maxDigestBytes) throw Error('Plugin package is too large to install: keep it below 512 MB and 20000 files.')
      files.set(relativePath, await readFile(path))
    }
  }
  await walk(target)
  return { files, ignoredLinks }
}

/**
 * Content digest of a package directory. Symbolic links are counted and skipped
 * rather than followed: an archive cannot carry them, and a development checkout
 * may legitimately contain them.
 */
export async function pluginPackageDigest(root: string): Promise<PluginDigest> {
  const { files, ignoredLinks } = await readPackageDirectory(root)
  return { ...pluginTreeDigest(files), ignoredLinks }
}

/** Pack a package directory into archive bytes plus both digests. */
export async function createPluginArchive(root: string): Promise<PluginArchive> {
  const { files } = await readPackageDirectory(root, 'reject')
  const bytes = buildPluginArchive(files)
  return { bytes, sha256: sha256Of(bytes), ...(() => { const content = pluginTreeDigest(files); return { contentSha256: content.sha256, files: content.files, contentBytes: content.bytes } })() }
}

/**
 * Verify and extract an archive into an empty directory.
 */
export async function extractPluginArchive(bytes: Uint8Array, target: string, expected: { sha256?: string; contentSha256?: string } = {}): Promise<PluginArchive> {
  const archive = readPluginArchive(bytes, expected)
  const root = resolve(target)
  await mkdir(root, { recursive: true })
  if ((await readdir(root)).length) throw Error('Plugin archive extraction target must be empty.')
  for (const [name, data] of archive.files) {
    const path = resolve(root, ...name.split('/'))
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw Error(`Plugin archive entry escapes the package root: ${name}`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data)
  }
  return { bytes, sha256: archive.sha256, contentSha256: archive.contentSha256, files: archive.files_count, contentBytes: archive.contentBytes }
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
