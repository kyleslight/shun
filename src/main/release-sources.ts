/**
 * Release download sources.
 *
 * Shun publishes on GitHub Releases, which is slow or unreachable from parts of
 * the world where the product is used. The update feed therefore does not
 * assume github.com: every release asset is also reachable through a GitHub
 * proxy that mirrors the same paths, so the updater measures the candidates and
 * uses the fastest one instead of hoping the default works.
 */

export type ReleaseSourceKind = 'direct' | 'official' | 'mirror'
export type ReleaseSource = { id: string; label: string; kind: ReleaseSourceKind; base: string }

export const githubMirrorPrefixes = [
  'https://gh-proxy.com',
  'https://ghfast.top',
  'https://ghproxy.net',
]

export type ReleaseProbe = {
  /** Fetch small text (release metadata) and report how long it took. */
  text(url: string, timeoutMs: number, signal?: AbortSignal): Promise<{ body: string; elapsedMs: number }>
  /** Read at most `bytes` of an asset and report the measured speed. */
  throughput(url: string, bytes: number, timeoutMs: number, signal?: AbortSignal): Promise<{ bytes: number; bytesPerSecond: number; latencyMs: number }>
}

export type ReleaseCandidate = {
  source: ReleaseSource
  metadata: string
  latencyMs: number
  bytesPerSecond?: number
}

export type ReleaseSelection = ReleaseCandidate & { sources: ReleaseSource[] }

export type ReleaseSelectionOptions = {
  sources: ReleaseSource[]
  metadataFile: string
  probe: ReleaseProbe
  metadataTimeoutMs?: number
  probeBytes?: number
  probeTimeoutMs?: number
  /** A directly hosted source is kept unless a mirror is this much faster. */
  directPreferenceRatio?: number
  /** Cheap checks rank by reachability and latency; downloads confirm real speed. */
  measureThroughput?: boolean
  signal?: AbortSignal
}

function ensureBase(value: string) {
  return `${value.replace(/\/+$/, '')}/`
}

function mirrorLabel(prefix: string) {
  try { return new URL(prefix).hostname } catch { return prefix }
}

/**
 * Every GitHub release asset is also served by `<mirror>/https://github.com/...`,
 * so one base per source is enough for the metadata file and for the artifacts.
 */
export function releaseSources(options: { owner: string; repo: string; officialBase?: string; mirrors?: string[] }): ReleaseSource[] {
  const { owner, repo, officialBase, mirrors = githubMirrorPrefixes } = options
  const assetPath = `${owner}/${repo}/releases/latest/download/`
  const sources: ReleaseSource[] = []
  if (officialBase) sources.push({ id: 'official', label: mirrorLabel(officialBase), kind: 'official', base: ensureBase(officialBase) })
  sources.push({ id: 'github', label: 'github.com', kind: 'direct', base: `https://github.com/${assetPath}` })
  for (const prefix of mirrors) {
    sources.push({
      id: mirrorLabel(prefix),
      label: mirrorLabel(prefix),
      kind: 'mirror',
      base: `${prefix.replace(/\/+$/, '')}/https://github.com/${assetPath}`,
    })
  }
  return sources
}

export function updateMetadataFile(platform: string) {
  return platform === 'darwin' ? 'latest-mac.yml' : platform === 'win32' ? 'latest.yml' : 'latest-linux.yml'
}

/** Asset file names listed in an electron-updater channel file. */
export function releaseAssetNames(metadata: string) {
  const names: string[] = []
  for (const match of metadata.matchAll(/^\s*-\s*url:\s*(\S+)\s*$/gm)) {
    const name = match[1].replace(/^['"]|['"]$/g, '').split('/').pop() || ''
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/** The release tag URL for a known version, used to verify a mirrored package. */
export function releaseTagBase(source: ReleaseSource, version: string) {
  return source.base.replace('/releases/latest/download/', `/releases/download/v${version}/`)
}

export function parseChecksums(text: string) {
  const digests = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+?)\s*$/i)
    if (match) digests.set(match[2], match[1].toLowerCase())
  }
  return digests
}

/** Published checksums may carry a platform directory that the asset name does not. */
export function digestForFile(digests: Map<string, string>, name: string) {
  const exact = digests.get(name)
  if (exact) return exact
  for (const [key, digest] of digests) if (key.split('/').pop() === name) return digest
  return undefined
}

function fastest(candidates: ReleaseCandidate[]) {
  return [...candidates].sort((a, b) => (b.bytesPerSecond ?? 0) - (a.bytesPerSecond ?? 0) || a.latencyMs - b.latencyMs)[0]
}

/**
 * Kept sources win over mirrors when they are competitive: a mirror is only
 * used when the directly hosted copy is unavailable or clearly slower.
 */
function chooseCandidate(candidates: ReleaseCandidate[], ratio: number) {
  const measured = candidates.filter(candidate => (candidate.bytesPerSecond ?? 0) > 0)
  if (measured.length) {
    const mirror = fastest(measured.filter(candidate => candidate.source.kind === 'mirror'))
    const hosted = fastest(measured.filter(candidate => candidate.source.kind !== 'mirror'))
    if (hosted && (!mirror || (hosted.bytesPerSecond ?? 0) >= (mirror.bytesPerSecond ?? 0) * ratio)) return hosted
    return fastest(measured)
  }
  const hosted = [...candidates].filter(candidate => candidate.source.kind !== 'mirror').sort((a, b) => a.latencyMs - b.latencyMs)[0]
  return hosted ?? [...candidates].sort((a, b) => a.latencyMs - b.latencyMs)[0]
}

/**
 * Reach the release metadata through the candidates, then confirm the winner
 * with a bounded read of a real artifact so a slow-but-reachable source cannot
 * win on latency alone. Returns undefined when no candidate answered.
 */
export async function selectReleaseSource(options: ReleaseSelectionOptions): Promise<ReleaseSelection | undefined> {
  if (!options.sources.length) return undefined
  const metadataTimeoutMs = options.metadataTimeoutMs ?? 6_000
  const probeBytes = options.probeBytes ?? 1_048_576
  const probeTimeoutMs = options.probeTimeoutMs ?? 8_000
  const ratio = options.directPreferenceRatio ?? 0.5

  const reached = (await Promise.all(options.sources.map(async (source): Promise<ReleaseCandidate | undefined> => {
    try {
      const { body, elapsedMs } = await options.probe.text(`${source.base}${options.metadataFile}`, metadataTimeoutMs, options.signal)
      if (!body.trim()) return undefined
      return { source, metadata: body, latencyMs: elapsedMs }
    } catch { return undefined }
  }))).filter((candidate): candidate is ReleaseCandidate => Boolean(candidate))
  if (!reached.length) return undefined
  const sources = reached.map(candidate => candidate.source)
  if (reached.length === 1) return { ...reached[0], sources }

  const asset = options.measureThroughput === false ? undefined : releaseAssetNames(reached[0].metadata)[0]
  const measured = asset ? (await Promise.all(reached.map(async (candidate): Promise<ReleaseCandidate | undefined> => {
    try {
      const result = await options.probe.throughput(`${candidate.source.base}${asset}`, probeBytes, probeTimeoutMs, options.signal)
      if (!result.bytes) return undefined
      return { ...candidate, bytesPerSecond: result.bytesPerSecond, latencyMs: result.latencyMs }
    } catch { return undefined }
  }))).filter((candidate): candidate is ReleaseCandidate => Boolean(candidate)) : []

  return { ...chooseCandidate(measured.length ? measured : reached, ratio), sources }
}
