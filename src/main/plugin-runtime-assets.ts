import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { gunzipSync, unzipSync } from 'fflate'
import type { PluginRuntimeAssetDescriptor, PluginRuntimeExecutableDescriptor } from './plugin-packages.ts'

export type PluginRuntimeInstallProgress = { downloadedBytes: number; totalBytes: number; done: boolean; cached: boolean }
type ExecutableInstall = {
  promise: Promise<string>
  listeners: Set<(progress: PluginRuntimeInstallProgress) => void>
  latest?: PluginRuntimeInstallProgress
}
const executableInstalls = new Map<string, ExecutableInstall>()

async function cached(asset: PluginRuntimeAssetDescriptor) {
  const info = await stat(asset.cachePath).catch(() => undefined)
  return Boolean(info?.isFile())
}

export async function ensurePluginRuntimeAsset(
  asset: PluginRuntimeAssetDescriptor,
  fetchAsset: (url: string) => Promise<Response>,
) {
  // A linked development package is the source of truth. Its runtime layer is
  // edited independently from manifest/package reloads, so the live layer is
  // always the current source of truth and never waits for an app restart.
  if (asset.developmentPath) {
    const info = await stat(asset.developmentPath).catch(() => undefined)
    if (info?.isFile()) return asset.developmentPath
  }
  if (await cached(asset)) return asset.cachePath

  let bytes: Uint8Array | undefined
  if (asset.url) {
    const response = await fetchAsset(asset.url)
    if (!response.ok) throw Error(`Plugin runtime asset ${asset.id} download failed with HTTP ${response.status}.`)
    bytes = new Uint8Array(await response.arrayBuffer())
  }
  if (!bytes) throw Error(`Plugin runtime asset ${asset.id} is not cached and has no available development source or download URL.`)

  await mkdir(dirname(asset.cachePath), { recursive: true })
  const staging = `${asset.cachePath}.${randomUUID()}.downloading`
  await writeFile(staging, bytes, { mode: 0o600 })
  try {
    await rename(staging, asset.cachePath)
  } catch (error) {
    if (!(await cached(asset))) throw error
    await rm(staging, { force: true }).catch(() => {})
  }
  return asset.cachePath
}

export async function ensurePluginRuntimeExecutable(
  executable: PluginRuntimeExecutableDescriptor,
  fetchExecutable: (url: string) => Promise<Response>,
  onProgress?: (progress: PluginRuntimeInstallProgress) => void,
) {
  const running = executableInstalls.get(executable.cachePath)
  if (running) {
    if (onProgress) {
      running.listeners.add(onProgress)
      if (running.latest) { try { onProgress(running.latest) } catch {} }
    }
    try { return await running.promise }
    finally { if (onProgress) running.listeners.delete(onProgress) }
  }
  const install = { promise: undefined as unknown as Promise<string>, listeners: new Set<(progress: PluginRuntimeInstallProgress) => void>() } as ExecutableInstall
  if (onProgress) install.listeners.add(onProgress)
  install.promise = installPluginRuntimeExecutable(executable, fetchExecutable, progress => {
    install.latest = progress
    for (const listener of install.listeners) { try { listener(progress) } catch {} }
  })
  executableInstalls.set(executable.cachePath, install)
  try { return await install.promise }
  finally {
    if (onProgress) install.listeners.delete(onProgress)
    if (executableInstalls.get(executable.cachePath) === install) executableInstalls.delete(executable.cachePath)
  }
}

async function installPluginRuntimeExecutable(
  executable: PluginRuntimeExecutableDescriptor,
  fetchExecutable: (url: string) => Promise<Response>,
  onProgress?: (progress: PluginRuntimeInstallProgress) => void,
) {
  if (executable.developmentPath && await isFile(executable.developmentPath)) {
    await makeExecutable(executable.developmentPath)
    onProgress?.({ downloadedBytes: executable.bytes, totalBytes: executable.bytes, done: true, cached: true })
    return executable.developmentPath
  }
  if (await isFile(executable.cachePath)) {
    await makeExecutable(executable.cachePath)
    onProgress?.({ downloadedBytes: executable.bytes, totalBytes: executable.bytes, done: true, cached: true })
    return executable.cachePath
  }

  const response = await fetchExecutable(executable.url)
  if (!response.ok) throw Error(`Could not prepare ${executable.id} for this computer (HTTP ${response.status}).`)
  const archive = await readDownload(response, executable.bytes, onProgress)
  const binary = extractExecutable(archive, executable.archive, executable.entry)

  await mkdir(dirname(executable.cachePath), { recursive: true })
  const staging = `${executable.cachePath}.${randomUUID()}.installing`
  await writeFile(staging, binary, { mode: 0o700 })
  try {
    await rename(staging, executable.cachePath)
  } catch (error) {
    if (!(await isFile(executable.cachePath))) throw error
    await rm(staging, { force: true }).catch(() => {})
  }
  await makeExecutable(executable.cachePath)
  onProgress?.({ downloadedBytes: archive.byteLength, totalBytes: executable.bytes, done: true, cached: false })
  return executable.cachePath
}

async function readDownload(response: Response, declaredBytes: number, onProgress?: (progress: PluginRuntimeInstallProgress) => void) {
  const maximum = 256 * 1024 * 1024
  const totalBytes = Number(response.headers.get('content-length')) || declaredBytes
  onProgress?.({ downloadedBytes: 0, totalBytes, done: false, cached: false })
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maximum) throw Error('Could not prepare the native runtime: the downloaded package is too large.')
    onProgress?.({ downloadedBytes: bytes.byteLength, totalBytes, done: false, cached: false })
    return bytes
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let downloadedBytes = 0, lastReportAt = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value?.byteLength) continue
    downloadedBytes += value.byteLength
    if (downloadedBytes > maximum) { await reader.cancel(); throw Error('Could not prepare the native runtime: the downloaded package is too large.') }
    chunks.push(value)
    const now = Date.now()
    if (now - lastReportAt >= 80) {
      lastReportAt = now
      onProgress?.({ downloadedBytes, totalBytes, done: false, cached: false })
    }
  }
  const bytes = new Uint8Array(downloadedBytes)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  onProgress?.({ downloadedBytes, totalBytes, done: false, cached: false })
  return bytes
}

function extractExecutable(archive: Uint8Array, format: PluginRuntimeExecutableDescriptor['archive'], entry: string) {
  if (format === 'raw') return archive
  if (format === 'zip') {
    const files = unzipSync(archive)
    const key = selectArchiveEntry(Object.keys(files), entry)
    if (!key) throw Error(`Could not prepare the native runtime: ${entry} is missing from its package.`)
    return files[key]
  }
  const tar = gunzipSync(archive)
  const wanted = normalizeArchivePath(entry)
  const matches: Uint8Array[] = []
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(value => value === 0)) break
    const name = tarText(header.subarray(0, 100))
    const prefix = tarText(header.subarray(345, 500))
    const path = normalizeArchivePath(prefix ? `${prefix}/${name}` : name)
    const size = Number.parseInt(tarText(header.subarray(124, 136)).trim() || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0) throw Error('Could not prepare the native runtime: its archive is malformed.')
    const contentStart = offset + 512
    const contentEnd = contentStart + size
    if (contentEnd > tar.length) throw Error('Could not prepare the native runtime: its archive is truncated.')
    const type = header[156]
    if ((type === 0 || type === 48) && (path === wanted || basename(path) === basename(wanted))) matches.push(tar.slice(contentStart, contentEnd))
    offset = contentStart + Math.ceil(size / 512) * 512
  }
  if (matches.length !== 1) throw Error(`Could not prepare the native runtime: ${entry} is missing or ambiguous in its package.`)
  return matches[0]
}

function selectArchiveEntry(paths: string[], entry: string) {
  const wanted = normalizeArchivePath(entry)
  const exact = paths.find(path => normalizeArchivePath(path) === wanted)
  if (exact) return exact
  const matches = paths.filter(path => basename(normalizeArchivePath(path)) === basename(wanted))
  return matches.length === 1 ? matches[0] : undefined
}

function normalizeArchivePath(path: string) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

function tarText(bytes: Uint8Array) {
  const end = bytes.indexOf(0)
  return new TextDecoder('utf-8').decode(end < 0 ? bytes : bytes.subarray(0, end))
}

async function isFile(path: string) {
  return Boolean(await stat(path).then(info => info.isFile(), () => false))
}

async function makeExecutable(path: string) {
  if (process.platform !== 'win32') await chmod(path, 0o700)
}
